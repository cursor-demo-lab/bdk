import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import * as podA from "./implement-pr.js";
import { sweepImplementPrWatches } from "./implement-pr-sweep.js";
import { racingStores, recordKv } from "./kv-race.fixtures.js";
import { IMPLEMENT_PR_INDEX, implementPrWatchKey } from "./kv-keys.js";
import * as legacy from "./testing/legacy/implement-pr-index.js";
import { fakeReminders } from "./testing/github.js";

// implement-pr-watch/index on a kv with no compare-and-set (K5). One module
// instance is one pod: its in-process queue orders only its own writes, so
// a second instance (`podB`) stands in for another replica.

const podB = (await import(`./implement-pr.js${"?pod=b"}`)) as typeof podA;

const T0 = new Date("2026-09-27T22:00:00.000Z");
const ENV: NodeJS.ProcessEnv = { FACTORY_JIRA_PROJECTS: "TLSSN" };
const OFF: NodeJS.ProcessEnv = { ...ENV, FACTORY_INDEX_MERGE: "off" };

/** `noReminders`: no reminders API, so the arm writes the index once and stops before the create and its confirm. */
function arm(pod: typeof podA, input: { kv: HostKvApi; issueKey: string; env?: NodeJS.ProcessEnv; noReminders?: boolean }) {
  const reminders = input.noReminders === true ? undefined : fakeReminders().api;
  return pod.armImplementPrWatch({ kv: input.kv, reminders, now: () => T0, env: input.env ?? ENV }, { issueKey: input.issueKey, title: "t" });
}

function sweep(kv: HostKvApi, env: NodeJS.ProcessEnv = ENV) {
  return sweepImplementPrWatches({ kv, env, now: () => T0 } as never);
}

/** A watch old code armed: young, with a recorded reminder that is on time. */
const liveWatch = { armedAt: T0.toISOString(), dueAt: new Date(T0.getTime() + 10 * 60_000).toISOString(), reminderId: "rem-old" };

const listed = (rows: Record<string, unknown>) => (rows[IMPLEMENT_PR_INDEX] as string[] | undefined) ?? [];

function counting(inner: HostKvApi, script: (n: number) => { value?: unknown; fail?: true } | undefined = () => undefined) {
  const index: string[] = [];
  let records = 0;
  const kv: HostKvApi = {
    get: async (key) => {
      if (key === IMPLEMENT_PR_INDEX) {
        index.push("get");
        const step = script(index.length);
        if (step?.fail) throw new Error("kv read failed");
        if (step !== undefined && "value" in step) return step.value as never;
      } else if (key.startsWith("implement-pr-watch/")) records += 1;
      return inner.get(key);
    },
    put: async (key, value) => {
      if (key === IMPLEMENT_PR_INDEX) {
        index.push("put");
        if (script(index.length)?.fail) throw new Error("kv write failed");
      }
      await inner.put(key, value);
    },
    delete: (key) => inner.delete(key),
  };
  return { kv, index, records: () => records };
}

for (const after of ["readBack", "put"] as const) {
  test(`two pods arming different tickets, no compare-and-set, "${after}" interleaving: both stay listed`, async () => {
    const rows: Record<string, unknown> = {};
    const [first, second] = racingStores(recordKv(rows), { prefix: IMPLEMENT_PR_INDEX, after });
    assert.deepEqual(await Promise.all([arm(podA, { kv: first, issueKey: "TLSSN-1" }), arm(podB, { kv: second, issueKey: "TLSSN-2" })]), ["armed", "armed"]);
    assert.deepEqual([...listed(rows)].sort(), ["TLSSN-1", "TLSSN-2"]);
  });
}

for (const role of [0, 1] as const) {
  test(`one pod's arm racing another pod's sweep prune stays listed (${role === 0 ? "arm" : "sweep"} reads the index first)`, async () => {
    const rows: Record<string, unknown> = { [IMPLEMENT_PR_INDEX]: ["TLSSN-1"] };
    const [first, second] = racingStores(recordKv(rows), { prefix: IMPLEMENT_PR_INDEX, after: "put" });
    const [armStore, sweepStore] = role === 0 ? [first, second] : [second, first];
    await Promise.all([arm(podB, { kv: armStore, issueKey: "TLSSN-9" }), sweep(sweepStore)]);
    assert.ok(listed(rows).includes("TLSSN-9"), JSON.stringify(listed(rows)));
  });
}

test("the prune re-filters the list as stored at its write: another pod's arm that finished during the pass stays", async () => {
  const rows: Record<string, unknown> = { [IMPLEMENT_PR_INDEX]: ["TLSSN-1"] };
  const inner = recordKv(rows);
  let armed = false;
  const kv: HostKvApi = {
    ...inner,
    get: async (key) => {
      if (key === implementPrWatchKey("TLSSN-1") && !armed) {
        armed = true;
        await arm(podB, { kv: inner, issueKey: "TLSSN-9" });
      }
      return inner.get(key);
    },
  };
  await sweep(kv);
  assert.deepEqual(listed(rows), ["TLSSN-9"]);
});

test("a key re-armed after the gone check, whose arm found it still listed, is put back after the prune", async () => {
  const rows: Record<string, unknown> = { [IMPLEMENT_PR_INDEX]: ["TLSSN-9"] };
  const inner = recordKv(rows);
  let reads = 0;
  // The gone check reads no record; another pod's arm then writes one and finds the key listed, so it adds nothing.
  const kv: HostKvApi = {
    ...inner,
    get: async (key) => {
      const value = await inner.get(key);
      if (key === implementPrWatchKey("TLSSN-9") && ++reads === 2) assert.equal(await arm(podB, { kv: inner, issueKey: "TLSSN-9" }), "armed");
      return value;
    },
  };
  await sweep(kv);
  assert.notEqual(rows[implementPrWatchKey("TLSSN-9")], undefined);
  assert.deepEqual(listed(rows), ["TLSSN-9"]);
});

for (const role of [0, 1] as const) {
  test(`old × new racing at the barrier (${role === 0 ? "old" : "new"} code puts first): the old entry is repaired by self-heal on its next arm`, async () => {
    const rows: Record<string, unknown> = { [implementPrWatchKey("TLSSN-1")]: liveWatch };
    const [first, second] = racingStores(recordKv(rows), { prefix: IMPLEMENT_PR_INDEX, after: "put" });
    const [oldStore, newStore] = role === 0 ? [first, second] : [second, first];
    await Promise.all([legacy.addToIndex(oldStore, "TLSSN-1"), arm(podA, { kv: newStore, issueKey: "TLSSN-2" })]);
    assert.ok(listed(rows).includes("TLSSN-2"), "the new arm is always listed");
    assert.equal(await arm(podA, { kv: recordKv(rows), issueKey: "TLSSN-1" }), "already");
    assert.deepEqual([...listed(rows)].sort(), ["TLSSN-1", "TLSSN-2"]);
  });
}

test("old × new residual: an old put after the new arm's confirm drops it until that ticket's next arm self-heals", async () => {
  const rows: Record<string, unknown> = {};
  const inner = recordKv(rows);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let read!: () => void;
  const readDone = new Promise<void>((resolve) => {
    read = resolve;
  });
  const oldStore: HostKvApi = {
    get: async (key) => {
      const value = await inner.get(key);
      read();
      return value;
    },
    put: async (key, value) => {
      await gate;
      await inner.put(key, value);
    },
    delete: (key) => inner.delete(key),
  };
  const old = legacy.addToIndex(oldStore, "TLSSN-1");
  await readDone;
  assert.equal(await arm(podA, { kv: inner, issueKey: "TLSSN-2" }), "armed");
  open();
  await old;
  assert.deepEqual(listed(rows), ["TLSSN-1"], "old code's late put overwrote the new entry");
  assert.equal(await arm(podA, { kv: inner, issueKey: "TLSSN-2" }), "already");
  assert.deepEqual(listed(rows), ["TLSSN-1", "TLSSN-2"]);
});

test("FACTORY_INDEX_MERGE=off is the plain read-then-put: two pods' single writes keep one entry, the next arm does not self-heal, and an arm is three index calls", async () => {
  for (const env of [ENV, OFF]) {
    const rows: Record<string, unknown> = {};
    const [first, second] = racingStores(recordKv(rows), { prefix: IMPLEMENT_PR_INDEX, after: "put" });
    await Promise.all([arm(podA, { kv: first, issueKey: "TLSSN-1", env, noReminders: true }), arm(podB, { kv: second, issueKey: "TLSSN-2", env, noReminders: true })]);
    assert.equal(listed(rows).length, env === OFF ? 1 : 2, "the verified add keeps both; the plain put keeps one");
  }
  const rows: Record<string, unknown> = { [implementPrWatchKey("TLSSN-1")]: liveWatch, [IMPLEMENT_PR_INDEX]: [] };
  assert.equal(await arm(podA, { kv: recordKv(rows), issueKey: "TLSSN-1", env: OFF }), "already");
  assert.deepEqual(listed(rows), [], "no self-heal with the merge off");

  const { kv, index } = counting(recordKv({}));
  await arm(podA, { kv, issueKey: "TLSSN-3", env: OFF });
  assert.deepEqual(index, ["get", "put", "get"], "the frozen arm's add, then its re-add after the create");

  // The legacy prune rewrites the list it read, without verifying the write.
  const pruneRows: Record<string, unknown> = { [IMPLEMENT_PR_INDEX]: ["TLSSN-1"] };
  const pruning = counting(recordKv(pruneRows));
  await sweep(pruning.kv, OFF);
  assert.deepEqual(pruning.index, ["get", "get", "put"]);
  assert.deepEqual(listed(pruneRows), []);
});

test("an arm costs 4 index calls to add, 2 when already listed, and never more than 9; a self-heal at most 9", async () => {
  const added = counting(recordKv({}));
  await arm(podA, { kv: added.kv, issueKey: "TLSSN-3" });
  assert.deepEqual(added.index, ["get", "put", "get", "get"]);

  const present = counting(recordKv({ [IMPLEMENT_PR_INDEX]: ["TLSSN-3"] }));
  await arm(podA, { kv: present.kv, issueKey: "TLSSN-3" });
  assert.deepEqual(present.index, ["get", "get"]);

  const worst = counting(recordKv({}), (n) => ([3, 4, 6, 7, 9].includes(n) ? { value: [`OTHER-${n}`] } : undefined));
  await arm(podA, { kv: worst.kv, issueKey: "TLSSN-3" });
  assert.equal(worst.index.length, 9);

  const heal = counting(recordKv({ [implementPrWatchKey("TLSSN-3")]: liveWatch }), (n) => (n > 1 && n % 3 !== 2 ? { value: [`OTHER-${n}`] } : undefined));
  assert.equal(await arm(podA, { kv: heal.kv, issueKey: "TLSSN-3" }), "already");
  assert.equal(heal.index.length, 9);

  const broken = counting(recordKv({}), () => ({ fail: true }));
  await arm(podA, { kv: broken.kv, issueKey: "TLSSN-3" });
  assert.ok(broken.index.length <= 9, `${broken.index.length} index calls`);
});

test("a sweep that prunes costs its index read plus 3 index calls, 9 at most, and one record read per key plus one per pruned key", async () => {
  const stale = () => ({ [IMPLEMENT_PR_INDEX]: ["TLSSN-1", "TLSSN-2", "TLSSN-3"] });
  const typical = counting(recordKv(stale()));
  await sweep(typical.kv);
  assert.deepEqual(typical.index, ["get", "get", "put", "get"]);
  assert.equal(typical.records(), 9, "N = 3 first-pass reads, D = 3 gone checks, and D = 3 re-reads after the prune");

  const worst = counting(recordKv(stale()), (n) => ([4, 5, 7, 8, 10].includes(n) ? { value: ["TLSSN-1", `OTHER-${n}`] } : undefined));
  await sweep(worst.kv);
  assert.equal(worst.index.length, 10, "1 + 9");

  // A gone key whose record is back after the prune costs up to 9 more index calls for its re-add.
  const inner = recordKv({ [IMPLEMENT_PR_INDEX]: ["TLSSN-1"] });
  let checks = 0;
  const rearmed = counting(
    {
      ...inner,
      get: async (key) => {
        const value = await inner.get(key);
        if (key === implementPrWatchKey("TLSSN-1") && ++checks === 2) await inner.put(key, liveWatch);
        return value;
      },
    },
    (n) => (n > 4 && n % 3 !== 0 ? { value: [`OTHER-${n}`] } : undefined)
  );
  await sweep(rearmed.kv);
  assert.equal(rearmed.index.length, 4 + 9, "1 read + prune 3 + re-add 9");
});

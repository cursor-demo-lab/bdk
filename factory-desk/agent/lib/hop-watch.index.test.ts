import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { armHopWatch, HOP_WATCH_INDEX, hopWatchKey, indexConfirmDelayMs, INDEX_CONFIRM_JITTER_MAX_MS, sweepHopWatches } from "./hop-watch.js";
import { racingStores, recordKv } from "./kv-race.fixtures.js";
import * as legacy from "./testing/legacy/hop-watch-index.js";

// hop-watch/index on a kv with no compare-and-set (K5): arms and the sweep's
// prune race each other, and the frozen pre-change addToIndex, and every
// entry with a live record ends up listed.

const ENV = { FACTORY_DESK_CLAIM_SETTLE_MS: "5" } as const;
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  delete process.env.FACTORY_INDEX_MERGE;
});
after(() => {
  for (const name of Object.keys(ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  delete process.env.FACTORY_INDEX_MERGE;
});

async function withIndexMerge<T>(value: string, work: () => Promise<T>): Promise<T> {
  process.env.FACTORY_INDEX_MERGE = value;
  try {
    return await work();
  } finally {
    delete process.env.FACTORY_INDEX_MERGE;
  }
}

const AT = new Date("2026-09-25T23:50:00Z");
const THREAD = { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE01" };
const bound = (...keys: string[]) => Object.fromEntries(keys.map((key) => [`ticket/${key}`, THREAD]));

const reminders = { create: async () => ({ id: "rem_1" }), cancel: async () => undefined } as never;

function arm(kv: HostKvApi, issueKey: string, options: { random?: () => number } = {}) {
  return armHopWatch({ kv, reminders, ...options } as never, { issueKey, hop: "plan", changelogId: `c-${issueKey}`, at: AT, baselineCommentId: "0" });
}

async function withSettle<T>(value: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.FACTORY_DESK_CLAIM_SETTLE_MS;
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = value;
  try {
    return await work();
  } finally {
    process.env.FACTORY_DESK_CLAIM_SETTLE_MS = before;
  }
}

/** The index calls with the time each started. */
function timedIndex(inner: HostKvApi) {
  const calls: { op: "get" | "put"; at: number }[] = [];
  const kv: HostKvApi = {
    ...inner,
    get: async (key) => {
      if (key === HOP_WATCH_INDEX) calls.push({ op: "get", at: performance.now() });
      return inner.get(key);
    },
    put: async (key, value) => {
      if (key === HOP_WATCH_INDEX) calls.push({ op: "put", at: performance.now() });
      await inner.put(key, value);
    },
  };
  return { kv, calls };
}

function sweep(kv: HostKvApi) {
  return sweepHopWatches({ host: { kv }, now: () => AT } as never);
}

const listed = (rows: Record<string, unknown>) => rows[HOP_WATCH_INDEX] as string[] | undefined;

/** Counts calls on `hop-watch/index` and on hop-watch records; `script` can replace an index read by its 1-based index. */
function counting(inner: HostKvApi, script: (n: number) => { value?: unknown; fail?: true } | undefined = () => undefined) {
  const index: string[] = [];
  let records = 0;
  const kv: HostKvApi = {
    get: async (key) => {
      if (key === HOP_WATCH_INDEX) {
        index.push("get");
        const step = script(index.length);
        if (step?.fail) throw new Error("kv read failed");
        if (step !== undefined && "value" in step) return step.value as never;
      } else if (key.startsWith("hop-watch/")) records += 1;
      return inner.get(key);
    },
    put: async (key, value) => {
      if (key === HOP_WATCH_INDEX) {
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
  test(`two concurrent arms on different tickets, no compare-and-set, "${after}" interleaving: both stay listed`, async () => {
    const rows = bound("TLSSN-1", "TLSSN-2");
    const [first, second] = racingStores(recordKv(rows), { prefix: HOP_WATCH_INDEX, after });
    await Promise.all([arm(first, "TLSSN-1"), arm(second, "TLSSN-2")]);
    assert.deepEqual([...(listed(rows) ?? [])].sort(), ["TLSSN-1", "TLSSN-2"]);
  });
}

for (const role of [0, 1] as const) {
  test(`an arm racing the sweep's prune of a stale key stays listed (${role === 0 ? "arm" : "sweep"} reads the index first)`, async () => {
    const rows: Record<string, unknown> = { ...bound("TLSSN-9"), [HOP_WATCH_INDEX]: ["TLSSN-1"] };
    const [first, second] = racingStores(recordKv(rows), { prefix: HOP_WATCH_INDEX, after: "put" });
    const [armStore, sweepStore] = role === 0 ? [first, second] : [second, first];
    await Promise.all([arm(armStore, "TLSSN-9"), sweep(sweepStore)]);
    assert.ok(listed(rows)?.includes("TLSSN-9"), JSON.stringify(listed(rows)));
  });
}

test("the prune re-filters the list as stored at its write: an arm that finished during the sweep's pass stays", async () => {
  const inner = recordKv({ ...bound("TLSSN-9"), [HOP_WATCH_INDEX]: ["TLSSN-1"] });
  let armed = false;
  const kv: HostKvApi = {
    ...inner,
    get: async (key) => {
      if (key === hopWatchKey("TLSSN-1") && !armed) {
        armed = true;
        await arm(inner, "TLSSN-9");
      }
      return inner.get(key);
    },
  };
  await sweep(kv);
  assert.deepEqual(await inner.get(HOP_WATCH_INDEX), ["TLSSN-9"]);
});

/**
 * The sweep's kv, with `hook` run once, right after the given read of
 * `issueKey`'s record returns (1 = the sweep's first pass, 2 = its gone check),
 * and every put of the index recorded.
 */
function sweepKv(inner: HostKvApi, input: { issueKey: string; read: number; hook: () => Promise<unknown> }) {
  const puts: unknown[] = [];
  let reads = 0;
  const kv: HostKvApi = {
    ...inner,
    get: async (key) => {
      const value = await inner.get(key);
      if (key === hopWatchKey(input.issueKey) && ++reads === input.read) await input.hook();
      return value;
    },
    put: async (key, value) => {
      if (key === HOP_WATCH_INDEX) puts.push(structuredClone(value));
      await inner.put(key, value);
    },
  };
  return { kv, puts, reads: () => reads };
}

test("a key re-armed after the gone check, whose arm found it still listed, is put back after the prune", async () => {
  const rows: Record<string, unknown> = { ...bound("TLSSN-9"), [HOP_WATCH_INDEX]: ["TLSSN-9"] };
  const inner = recordKv(rows);
  // The gone check reads no record; the arm then writes one and finds the key listed, so it adds nothing.
  const { kv } = sweepKv(inner, { issueKey: "TLSSN-9", read: 2, hook: () => arm(inner, "TLSSN-9") });
  await sweep(kv);
  assert.notEqual(rows[hopWatchKey("TLSSN-9")], undefined);
  assert.deepEqual(listed(rows), ["TLSSN-9"]);
});

test("another pod's arm that lands while the sweep checks which keys are gone stays in the index", async () => {
  const rows: Record<string, unknown> = { ...bound("TLSSN-9"), [HOP_WATCH_INDEX]: ["TLSSN-1"] };
  const inner = recordKv(rows);
  // Pod B arms TLSSN-9 with its own read-modify-write while this sweep checks TLSSN-1.
  const podB = async () => {
    await inner.put(hopWatchKey("TLSSN-9"), { hop: "plan", since: AT.toISOString(), dueAt: AT.toISOString(), changelogId: "c-TLSSN-9" });
    await inner.put(HOP_WATCH_INDEX, [...((await inner.get(HOP_WATCH_INDEX)) as string[]), "TLSSN-9"]);
  };
  const { kv, reads } = sweepKv(inner, { issueKey: "TLSSN-1", read: 2, hook: podB });
  await sweep(kv);
  assert.equal(reads(), 3, "the prune verified the stale key, and re-read it after the prune");
  assert.deepEqual(listed(rows), ["TLSSN-9"]);
});

for (const merge of ["on", "off"] as const) {
  test(`a snapshot key re-armed while this pass ran never leaves the stored list (merge ${merge})`, async () => {
    await withIndexMerge(merge, async () => {
      const rows: Record<string, unknown> = { ...bound("TLSSN-9"), [HOP_WATCH_INDEX]: ["TLSSN-9"] };
      const inner = recordKv(rows);
      // The first pass reads no record for TLSSN-9; the arm then writes one before the gone check.
      const { kv, puts } = sweepKv(inner, { issueKey: "TLSSN-9", read: 1, hook: () => arm(inner, "TLSSN-9") });
      await sweep(kv);
      assert.deepEqual(listed(rows), ["TLSSN-9"]);
      assert.ok(
        puts.every((put) => (put as string[]).includes("TLSSN-9")),
        `every index write kept TLSSN-9: ${JSON.stringify(puts)}`
      );
    });
  });
}

for (const role of [0, 1] as const) {
  test(`old × new racing at the barrier (${role === 0 ? "old" : "new"} code puts first): the old entry is repaired by self-heal on its next arm`, async () => {
    const rows: Record<string, unknown> = bound("TLSSN-1", "TLSSN-2");
    const [first, second] = racingStores(recordKv(rows), { prefix: HOP_WATCH_INDEX, after: "put" });
    const [oldStore, newStore] = role === 0 ? [first, second] : [second, first];
    // Old code writes its record, then its plain read-then-put.
    await recordKv(rows).put(hopWatchKey("TLSSN-1"), { hop: "plan", since: AT.toISOString(), dueAt: AT.toISOString(), changelogId: "c-TLSSN-1" });
    await Promise.all([legacy.addToIndex(oldStore, "TLSSN-1"), arm(newStore, "TLSSN-2")]);
    assert.ok(listed(rows)?.includes("TLSSN-2"), "the new arm is always listed");
    // The redelivery of TLSSN-1's entry, now on new code, puts it back if the race dropped it.
    assert.deepEqual(await arm(recordKv(rows), "TLSSN-1"), { armed: false, reason: "already_armed" });
    assert.deepEqual([...(listed(rows) ?? [])].sort(), ["TLSSN-1", "TLSSN-2"]);
  });
}

test("old × new residual: an old put after the new arm's settle confirm drops it until that ticket's next arm self-heals", async () => {
  const rows: Record<string, unknown> = bound("TLSSN-2");
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
  await arm(inner, "TLSSN-2");
  open();
  await old;
  assert.deepEqual(listed(rows), ["TLSSN-1"], "old code's late put overwrote the new entry");
  assert.deepEqual(await arm(inner, "TLSSN-2"), { armed: false, reason: "already_armed" });
  assert.deepEqual(listed(rows), ["TLSSN-1", "TLSSN-2"]);
});

test("FACTORY_INDEX_MERGE=off is the plain read-then-put: two racing arms keep one, a redelivery does not self-heal, and an arm is two index calls", async () => {
  await withIndexMerge("off", async () => {
    const rows = bound("TLSSN-1", "TLSSN-2");
    const [first, second] = racingStores(recordKv(rows), { prefix: HOP_WATCH_INDEX, after: "put" });
    await Promise.all([arm(first, "TLSSN-1"), arm(second, "TLSSN-2")]);
    assert.equal(listed(rows)?.length, 1);
    const dropped = listed(rows)?.includes("TLSSN-1") ? "TLSSN-2" : "TLSSN-1";
    await arm(recordKv(rows), dropped);
    assert.equal(listed(rows)?.includes(dropped), false, "no self-heal with the merge off");

    const { kv, index } = counting(recordKv(bound("TLSSN-3")));
    await arm(kv, "TLSSN-3");
    assert.deepEqual(index, ["get", "put"]);

    // The legacy prune reads the list again and puts it back, unverified.
    const pruneRows: Record<string, unknown> = { [HOP_WATCH_INDEX]: ["TLSSN-1"] };
    const pruning = counting(recordKv(pruneRows));
    await sweep(pruning.kv);
    assert.deepEqual(pruning.index, ["get", "get", "put"]);
    assert.deepEqual(listed(pruneRows), []);
  });
});

test("an arm costs 4 index calls to add, 2 when already listed, and never more than 9", async () => {
  const added = counting(recordKv(bound("TLSSN-3")));
  await arm(added.kv, "TLSSN-3");
  assert.deepEqual(added.index, ["get", "put", "get", "get"]);

  const present = counting(recordKv({ ...bound("TLSSN-3"), [HOP_WATCH_INDEX]: ["TLSSN-3"] }));
  await arm(present.kv, "TLSSN-3");
  assert.deepEqual(present.index, ["get", "get"]);

  // Every read after the first shows another writer's list without TLSSN-3, so both writes and the confirm run out of attempts.
  const worst = counting(recordKv(bound("TLSSN-3")), (n) => ([3, 4, 6, 7, 9].includes(n) ? { value: [`OTHER-${n}`] } : undefined));
  await arm(worst.kv, "TLSSN-3");
  assert.equal(worst.index.length, 9);

  for (const failing of [(n: number) => n > 0, (n: number) => n % 2 === 0]) {
    const broken = counting(recordKv(bound("TLSSN-3")), (n) => (failing(n) ? { fail: true } : undefined));
    await arm(broken.kv, "TLSSN-3").catch(() => undefined);
    assert.ok(broken.index.length <= 9, `${broken.index.length} index calls`);
  }
});

test("a sweep that prunes costs its index read plus 3 index calls, 9 at most, and one record read per key plus one per pruned key", async () => {
  const stale = () => ({ [HOP_WATCH_INDEX]: ["TLSSN-1", "TLSSN-2", "TLSSN-3"] });
  const typical = counting(recordKv(stale()));
  await sweep(typical.kv);
  assert.deepEqual(typical.index, ["get", "get", "put", "get"]);
  assert.equal(typical.records(), 9, "N = 3 first-pass reads, D = 3 gone checks, and D = 3 re-reads after the prune");

  // Every read after the prune's first shows another writer's list that still holds TLSSN-1.
  const worst = counting(recordKv(stale()), (n) => ([4, 5, 7, 8, 10].includes(n) ? { value: ["TLSSN-1", `OTHER-${n}`] } : undefined));
  await sweep(worst.kv);
  assert.equal(worst.index.length, 10, "1 + 9");

  // A gone key whose record is back after the prune costs up to 9 more index calls for its re-add.
  const rows: Record<string, unknown> = { [HOP_WATCH_INDEX]: ["TLSSN-1"] };
  const inner = recordKv(rows);
  let checks = 0;
  const rearmed = counting(
    {
      ...inner,
      get: async (key) => {
        const value = await inner.get(key);
        if (key === hopWatchKey("TLSSN-1") && ++checks === 2) await inner.put(key, { hop: "plan", since: AT.toISOString(), dueAt: "2099-01-01T00:00:00.000Z", changelogId: "c" });
        return value;
      },
    },
    (n) => (n > 4 && n % 3 !== 0 ? { value: [`OTHER-${n}`] } : undefined)
  );
  await sweep(rearmed.kv);
  assert.equal(rearmed.index.length, 4 + 9, "1 read + prune 3 + re-add 9");
});

test("the index confirm waits the claim settle plus up to min(500 ms, settle) of jitter", () => {
  assert.equal(INDEX_CONFIRM_JITTER_MAX_MS, 500);
  assert.equal(indexConfirmDelayMs({ settleMs: 2_000, random: () => 0 }), 2_000);
  assert.equal(indexConfirmDelayMs({ settleMs: 2_000, random: () => 0.999 }), 2_499);
  assert.equal(indexConfirmDelayMs({ settleMs: 100, random: () => 0.5 }), 150);
  assert.equal(indexConfirmDelayMs({ settleMs: 100, random: () => 0.999 }), 199);
});

test("the confirm's index read comes no earlier than the settle plus its jitter after the first add, and within the jitter bound", async () => {
  await withSettle("40", async () => {
    for (const draw of [0, 0.99]) {
      const { kv, calls } = timedIndex(recordKv(bound("TLSSN-3")));
      await arm(kv, "TLSSN-3", { random: () => draw });
      assert.deepEqual(calls.map((call) => call.op), ["get", "put", "get", "get"]);
      const gap = calls[3]!.at - calls[2]!.at;
      const expected = indexConfirmDelayMs({ settleMs: 40, random: () => draw });
      assert.ok(gap >= expected - 1, `draw ${draw}: confirm ${gap.toFixed(1)} ms after the first add, expected at least ${expected}`);
      assert.ok(gap < 40 + 40 + 250, `draw ${draw}: confirm ${gap.toFixed(1)} ms after the first add, past settle + jitter`);
    }
  });
});

test("FACTORY_DESK_CLAIM_SETTLE_MS=0 skips the wait and the confirm: exactly 3 index calls", async () => {
  await withSettle("0", async () => {
    let drew = false;
    const { kv, calls } = timedIndex(recordKv(bound("TLSSN-3")));
    await arm(kv, "TLSSN-3", { random: () => ((drew = true), 0.5) });
    assert.deepEqual(calls.map((call) => call.op), ["get", "put", "get"]);
    assert.equal(drew, false, "no jitter drawn");
  });
});

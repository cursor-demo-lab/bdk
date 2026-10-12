import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { hostedKv } from "./kv-backends.fixtures.js";
import { racingStores } from "./kv-race.fixtures.js";
import type { KvKey } from "./kv-keys.js";
import { claimPlan, startPlan, type Send, type StartPlanInput } from "./start-plan.js";
import * as legacy from "./testing/legacy/start-plan.js";
import type { ClaimRun, Sleep } from "./verified-claim.js";

// The planner's claim on a kv with no compare-and-set, raced against itself
// and against the frozen pre-change claimPlan (testing/legacy/start-plan.ts)
// that a slug still runs while it deploys.

const KEY = "plan/TLSSN-42:Triaged:10041" as KvKey;
const AT = new Date("2026-09-23T00:00:00.000Z");
const REQUEST = { issueKey: "TLSSN-42", title: "CSV export returns 500" };

/** The settle wait without the wall-clock wait: every pending in-memory kv call has landed when it resolves. */
const tick: Sleep = () => new Promise((resolve) => setImmediate(resolve));

type MemoryKv = HostKvApi & { entries: Map<string, JsonValue> };

function memoryKv(): MemoryKv {
  const entries = new Map<string, JsonValue>();
  return {
    entries,
    get: async (key) => entries.get(key),
    put: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
  };
}

function run(owner: string, overrides: Partial<ClaimRun> = {}): ClaimRun {
  return { host: "planner", mode: "verified", owner, settleMs: 2_000, sleep: tick, log: () => {}, ...overrides };
}

const delivery = (input: { owner: string; deliveryId: string; overrides?: Partial<ClaimRun> }) => {
  const { owner, deliveryId, overrides = {} } = input;
  return { now: AT, run: run(owner, overrides), deliveryId };
};

const claimedCount = (outcomes: { status: string }[]) => outcomes.filter((outcome) => outcome.status === "claimed").length;

/** Old code's claim, stopped after its read: its put waits until `land()`, which resolves with old code's outcome. */
function heldOldClaim(kv: HostKvApi): { read: Promise<void>; land: () => Promise<legacy.PlanClaimOutcome> } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let markRead!: () => void;
  const read = new Promise<void>((resolve) => {
    markRead = resolve;
  });
  const store: HostKvApi = {
    get: async (key) => {
      const value = await kv.get(key);
      markRead();
      return value;
    },
    put: async (key, value) => {
      await gate;
      await kv.put(key, value);
    },
    delete: (key) => kv.delete(key),
  };
  const outcome = legacy.claimPlan(store, KEY, AT, false, "dlv_old");
  return {
    read,
    land: () => {
      open();
      return outcome;
    },
  };
}

function sender(options: { beforeThrow?: () => Promise<void>; fail?: Error } = {}): { send: Send; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: async (message) => {
      sent.push(message);
      if (options.fail !== undefined) {
        await options.beforeThrow?.();
        throw options.fail;
      }
      return { id: `ses_${sent.length}` };
    },
  };
}

function input(kv: HostKvApi, send: Send, overrides: Partial<StartPlanInput> = {}): StartPlanInput {
  return {
    kv,
    key: KEY,
    clearFirst: false,
    request: REQUEST,
    replan: false,
    attempt: "10041",
    send,
    via: "status",
    now: () => AT,
    env: {},
    sleep: tick,
    log: () => {},
    ...overrides,
  };
}

for (const after of ["readBack", "put"] as const) {
  test(`two deliveries of one transition with different delivery ids, no compare-and-set, "${after}" interleaving: exactly one claims`, async () => {
    const [first, second] = racingStores(memoryKv(), { prefix: "plan/", after, passReads: 1 });
    const outcomes = await Promise.all([claimPlan(first, KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a" })), claimPlan(second, KEY, delivery({ owner: "owner-b", deliveryId: "dlv_b" }))]);
    assert.equal(claimedCount(outcomes), 1, JSON.stringify(outcomes));
    assert.deepEqual(outcomes.find((outcome) => outcome.status !== "claimed"), { status: "in_flight" });
  });
}

test("two concurrent startPlan deliveries of one transition send exactly one planning session", async () => {
  const shared = memoryKv();
  const [first, second] = racingStores(shared, { prefix: "plan/", after: "readBack", passReads: 1 });
  const { send, sent } = sender();
  const lines: string[] = [];
  const responses = await Promise.all([
    startPlan(input(first, send, { deliveryId: "dlv_a", log: (line) => lines.push(line) })),
    startPlan(input(second, send, { deliveryId: "dlv_b", log: (line) => lines.push(line) })),
  ]);
  const bodies = (await Promise.all(responses.map((response) => response.json()))) as Record<string, unknown>[];
  assert.equal(sent.length, 1);
  assert.deepEqual(bodies.map((body) => body["started"] === true || body["inFlight"] === true), [true, true]);
  assert.equal(bodies.filter((body) => body["started"] === true).length, 1);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)).map((line: Record<string, unknown>) => [line["host"], line["claim"], line["key"]]).sort(),
    [
      ["planner", "claimed", KEY],
      ["planner", "in_flight", KEY],
    ]
  );
});

test("the settle re-read is what leaves one claim when the second put lands after the first read-back", async () => {
  const withSettle = racingStores(memoryKv(), { prefix: "plan/", after: "readBack", passReads: 1 });
  const settled = await Promise.all([claimPlan(withSettle[0], KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a" })), claimPlan(withSettle[1], KEY, delivery({ owner: "owner-b", deliveryId: "dlv_b" }))]);
  assert.equal(claimedCount(settled), 1);

  const noSettle = racingStores(memoryKv(), { prefix: "plan/", after: "readBack", passReads: 1 });
  const unsettled = await Promise.all([
    claimPlan(noSettle[0], KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a", overrides: { settleMs: 0 } })),
    claimPlan(noSettle[1], KEY, delivery({ owner: "owner-b", deliveryId: "dlv_b", overrides: { settleMs: 0 } })),
  ]);
  assert.equal(claimedCount(unsettled), 2, "FACTORY_CLAIM_SETTLE_MS=0 gives up this race");
});

test("the claim works the same on July's hosted-shaped kv", async () => {
  const kv = hostedKv();
  assert.deepEqual(await claimPlan(kv, KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a" })), { status: "claimed", retried: false });
  assert.deepEqual(await claimPlan(kv, KEY, delivery({ owner: "owner-b", deliveryId: "dlv_b" })), { status: "in_flight" });
  assert.deepEqual(await claimPlan(kv, KEY, delivery({ owner: "owner-c", deliveryId: "dlv_a" })), { status: "claimed", retried: true }, "a replay of dlv_a");
});

test("old × new: an old put that lands after the new put, before its read-back or during its settle, leaves the new claim in flight", async () => {
  const beforeReadBack = memoryKv();
  const early = heldOldClaim(beforeReadBack);
  await early.read;
  let earlyOld: legacy.PlanClaimOutcome | undefined;
  let puts = 0;
  const hooked: HostKvApi = {
    get: (key) => beforeReadBack.get(key),
    put: async (key, value) => {
      await beforeReadBack.put(key, value);
      if ((puts += 1) === 1) earlyOld = await early.land();
    },
    delete: (key) => beforeReadBack.delete(key),
  };
  assert.deepEqual(await claimPlan(hooked, KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a" })), { status: "in_flight" });
  assert.deepEqual(earlyOld, { status: "claimed", retried: false });

  // M1: the ownerless legacy pending overwrites during the settle.
  const duringSettle = memoryKv();
  const late = heldOldClaim(duringSettle);
  await late.read;
  let lateOld: legacy.PlanClaimOutcome | undefined;
  const onSettle = run("owner-a", { sleep: async () => void (lateOld = await late.land()) });
  assert.deepEqual(await claimPlan(duringSettle, KEY, { now: AT, run: onSettle, deliveryId: "dlv_a" }), { status: "in_flight" });
  assert.deepEqual(lateOld, { status: "claimed", retried: false });
  assert.deepEqual(duringSettle.entries.get(KEY), { state: "pending", at: AT.toISOString(), deliveryId: "dlv_old" });
});

test("old × new, in sequence both ways: whichever claims first holds it and the other is in flight", async () => {
  const newFirst = memoryKv();
  assert.equal((await claimPlan(newFirst, KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a" }))).status, "claimed");
  assert.deepEqual(await legacy.claimPlan(newFirst, KEY, AT, false, "dlv_old"), { status: "in_flight" });

  const oldFirst = memoryKv();
  assert.equal((await legacy.claimPlan(oldFirst, KEY, AT, false, "dlv_old")).status, "claimed");
  assert.deepEqual(await claimPlan(oldFirst, KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a" })), { status: "in_flight" });
});

for (const [role, label] of [
  [0, "old code is the first to put"],
  [1, "new code is the first to put"],
] as const) {
  test(`old × new racing at the barrier, ${label}: never two claims`, async () => {
    const [first, second] = racingStores(memoryKv(), { prefix: "plan/", after: "put" });
    const [oldStore, newStore] = role === 0 ? [first, second] : [second, first];
    const [oldOutcome, newOutcome] = await Promise.all([legacy.claimPlan(oldStore, KEY, AT, false, "dlv_old"), claimPlan(newStore, KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a" }))]);
    assert.ok(claimedCount([oldOutcome, newOutcome]) <= 1, JSON.stringify({ oldOutcome, newOutcome }));
  });
}

test("old × new residual: an old put that lands after the new settle re-read still gives two claims", async () => {
  // Documented residual (plan §6 risk b): old code never reads back.
  const kv = memoryKv();
  const old = heldOldClaim(kv);
  await old.read;
  const fresh = await claimPlan(kv, KEY, delivery({ owner: "owner-a", deliveryId: "dlv_a" }));
  assert.deepEqual([fresh.status, (await old.land()).status], ["claimed", "claimed"]);
});

test("a claim that cannot be confirmed releases this delivery's put before the 503; a retried delivery then plans", async () => {
  const inner = memoryKv();
  let reads = 0;
  const flaky: HostKvApi = {
    ...inner,
    get: async (key) => {
      reads += 1;
      if (reads >= 3 && reads <= 5) throw new Error("kv read failed");
      return inner.get(key);
    },
  };
  const { send, sent } = sender();
  const lines: string[] = [];
  const response = await startPlan(input(flaky, send, { log: (line) => lines.push(line) }));
  assert.equal(response.status, 503);
  assert.equal(inner.entries.has(KEY), false);
  assert.equal(sent.length, 0);
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as Record<string, unknown>)["claim"]), ["unavailable", "release_released"]);

  const retried = await startPlan(input(flaky, send));
  assert.equal(retried.status, 200);
  assert.equal(sent.length, 1);
});

test("a send that throws releases only this delivery's claim: a rival's claim written meanwhile is kept", async () => {
  const kv = memoryKv();
  const rival = { state: "pending", at: AT.toISOString(), owner: "rival" };
  const failing = sender({ fail: new Error("dispatch refused"), beforeThrow: async () => void (await kv.put(KEY, rival)) });
  await assert.rejects(startPlan(input(kv, failing.send)), { message: "dispatch refused" });
  assert.deepEqual(kv.entries.get(KEY), rival);
});

const LEGACY_STEPS: Array<{ name: string; seed?: JsonValue; at: string; deliveryId?: string }> = [
  { name: "absent", at: "2026-09-23T00:00:00.000Z", deliveryId: "dlv_1" },
  { name: "young pending", seed: { state: "pending", at: "2026-09-23T00:00:00.000Z" }, at: "2026-09-23T00:10:00.000Z" },
  { name: "stale pending", seed: { state: "pending", at: "2026-09-23T00:00:00.000Z" }, at: "2026-09-23T00:10:00.001Z" },
  { name: "own delivery's started", seed: { state: "started", at: "x", sessionId: "deferred", deliveryId: "dlv_1" }, at: "2026-09-23T00:01:00.000Z", deliveryId: "dlv_1" },
  { name: "another delivery's started", seed: { state: "started", at: "x", sessionId: "ses_1" }, at: "2026-09-24T00:00:00.000Z", deliveryId: "dlv_2" },
  { name: "garbage", seed: { hello: "world" }, at: "2026-09-24T00:00:00.000Z" },
];

test("FACTORY_CLAIM_MODE=legacy is the frozen claim exactly: same outcomes, same stored values, no owner, no settle", async () => {
  for (const step of LEGACY_STEPS) {
    const live = memoryKv();
    const frozen = memoryKv();
    if (step.seed !== undefined) {
      await live.put(KEY, step.seed);
      await frozen.put(KEY, step.seed);
    }
    let waited = false;
    const legacyRun = run("owner-a", { mode: "legacy", sleep: async () => void (waited = true) });
    const now = new Date(step.at);
    const options = { now, run: legacyRun, ...(step.deliveryId === undefined ? {} : { deliveryId: step.deliveryId }) };
    assert.deepEqual(await claimPlan(live, KEY, options), await legacy.claimPlan(frozen, KEY, now, false, step.deliveryId), step.name);
    assert.deepEqual(live.entries.get(KEY), frozen.entries.get(KEY), step.name);
    assert.equal(waited, false, step.name);
  }

  const kv = memoryKv();
  await startPlan(input(kv, sender({ fail: new Error("dispatch refused") }).send, { env: { FACTORY_CLAIM_MODE: "legacy" } })).catch(() => undefined);
  assert.equal(kv.entries.has(KEY), false, "legacy releases with a plain delete");
  await kv.put(KEY, { state: "pending", at: AT.toISOString(), owner: "someone-else" });
  await startPlan(input(kv, sender({ fail: new Error("dispatch refused") }).send, { env: { FACTORY_CLAIM_MODE: "legacy" }, now: () => new Date("2026-09-23T00:10:00.001Z") })).catch(
    () => undefined
  );
  assert.equal(kv.entries.has(KEY), false, "and so deletes whatever the key holds, as the frozen code does");
});

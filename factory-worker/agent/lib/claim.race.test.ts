import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { claimImplementation, claimStatusMove, recordImplementation } from "./claim.js";
import { hostedKv } from "./kv-backends.fixtures.js";
import { racingStores } from "./kv-race.fixtures.js";
import { prStatusClaimKey } from "./kv-keys.js";
import * as legacy from "./testing/legacy/claim.js";
import { claimRunFor, memoryKv, tick } from "./testing/fakes.js";
import type { ClaimRun } from "./verified-claim.js";

// The worker's claims on a kv with no compare-and-set, raced against each
// other and against the frozen pre-change code (testing/legacy/claim.ts)
// that a slug still runs while it deploys.

const AT = new Date("2026-09-23T00:00:00.000Z");
const KEY = "implement/TLSSN-42";
const STATUS_KEY = prStatusClaimKey({ issueKey: "TLSSN-42", stage: "in_review", pr: "cursor-demo-lab/marsbank#13" });

const delivery = (input: { owner: string; deliveryId: string; overrides?: Partial<ClaimRun> }) => {
  const { owner, deliveryId, overrides = {} } = input;
  return { now: AT, run: claimRunFor({ owner, ...overrides }), deliveryId };
};

const claimedCount = (outcomes: { status: string }[]) => outcomes.filter((outcome) => outcome.status === "claimed").length;

/**
 * Old code's claim, stopped after its read: its put waits until `land()`,
 * which resolves with old code's outcome. `read` resolves once it has read.
 */
function heldOldClaim<T>(kv: HostKvApi, start: (store: HostKvApi) => Promise<T>): { read: Promise<void>; land: () => Promise<T> } {
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
  const outcome = start(store);
  return {
    read,
    land: () => {
      open();
      return outcome;
    },
  };
}

/** `kv` with a hook run just before or just after the first put. */
function aroundFirstPut(kv: HostKvApi, hooks: { before?: () => Promise<unknown>; after?: () => Promise<unknown> }): HostKvApi {
  let puts = 0;
  return {
    get: (key) => kv.get(key),
    put: async (key, value) => {
      puts += 1;
      if (puts === 1) await hooks.before?.();
      await kv.put(key, value);
      if (puts === 1) await hooks.after?.();
    },
    delete: (key) => kv.delete(key),
  };
}

for (const after of ["readBack", "put"] as const) {
  test(`two approvals of one ticket with different delivery ids, no compare-and-set, "${after}" interleaving: exactly one claims`, async () => {
    const [first, second] = racingStores(memoryKv(), { prefix: "implement/", after, passReads: 1 });
    const outcomes = await Promise.all([
      claimImplementation(first, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" })),
      claimImplementation(second, "TLSSN-42", delivery({ owner: "owner-b", deliveryId: "dlv_b" })),
    ]);
    assert.equal(claimedCount(outcomes), 1, JSON.stringify(outcomes));
    assert.deepEqual(outcomes.find((outcome) => outcome.status !== "claimed"), { status: "in_flight" });
  });

  test(`two PR events for one move, no compare-and-set, "${after}" interleaving: exactly one claims`, async () => {
    const [first, second] = racingStores(memoryKv(), { prefix: "pr-status/", after, passReads: 1 });
    const outcomes = await Promise.all([
      claimStatusMove(first, STATUS_KEY, { now: AT, run: claimRunFor({ owner: "owner-a" }) }),
      claimStatusMove(second, STATUS_KEY, { now: AT, run: claimRunFor({ owner: "owner-b" }) }),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["claimed", "in_flight"]);
  });
}

test("both deliveries read back their own claim when the second put lands after the first read-back; the settle re-read is what leaves one", async () => {
  const withSettle = racingStores(memoryKv(), { prefix: "implement/", after: "readBack", passReads: 1 });
  const settled = await Promise.all([
    claimImplementation(withSettle[0], "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" })),
    claimImplementation(withSettle[1], "TLSSN-42", delivery({ owner: "owner-b", deliveryId: "dlv_b" })),
  ]);
  assert.deepEqual(settled, [{ status: "in_flight" }, { status: "claimed", retried: false }]);

  // FACTORY_CLAIM_SETTLE_MS=0 is the kill switch for the wait, and this is its cost.
  const noSettle = racingStores(memoryKv(), { prefix: "implement/", after: "readBack", passReads: 1 });
  const unsettled = await Promise.all([
    claimImplementation(noSettle[0], "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a", overrides: { settleMs: 0 } })),
    claimImplementation(noSettle[1], "TLSSN-42", delivery({ owner: "owner-b", deliveryId: "dlv_b", overrides: { settleMs: 0 } })),
  ]);
  assert.equal(claimedCount(unsettled), 2);
});

test("the claim works the same on July's hosted-shaped kv, which hands values back with their keys reordered", async () => {
  const kv = hostedKv();
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" })), { status: "claimed", retried: false });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", delivery({ owner: "owner-b", deliveryId: "dlv_b" })), { status: "in_flight" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", delivery({ owner: "owner-c", deliveryId: "dlv_a" })), { status: "claimed", retried: true }, "a replay of dlv_a");
});

test("old × new: an old put that lands after the new put but before its read-back leaves the new claim in flight", async () => {
  const kv = memoryKv();
  const old = heldOldClaim(kv, (store) => legacy.claimImplementation(store, "TLSSN-42", AT));
  await old.read;
  let oldOutcome: legacy.ClaimOutcome | undefined;
  const store = aroundFirstPut(kv, { after: async () => (oldOutcome = await old.land()) });
  assert.deepEqual(await claimImplementation(store, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" })), { status: "in_flight" });
  assert.deepEqual(oldOutcome, { status: "claimed", retried: false });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: AT.toISOString() });
});

test("old × new: an old-code ownerless pending that overwrites during the settle leaves the new claim in flight", async () => {
  const kv = memoryKv();
  const old = heldOldClaim(kv, (store) => legacy.claimImplementation(store, "TLSSN-42", AT));
  await old.read;
  let oldOutcome: legacy.ClaimOutcome | undefined;
  const run = claimRunFor({ owner: "owner-a", sleep: async () => void (oldOutcome = await old.land()) });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", { now: AT, run, deliveryId: "dlv_a" }), { status: "in_flight" });
  assert.deepEqual(oldOutcome, { status: "claimed", retried: false });

  const move = memoryKv();
  const oldMove = heldOldClaim(move, (store) => legacy.claimStatusMove(store, STATUS_KEY, AT));
  await oldMove.read;
  const moveRun = claimRunFor({ owner: "owner-a", sleep: async () => void (await oldMove.land()) });
  assert.deepEqual(await claimStatusMove(move, STATUS_KEY, { now: AT, run: moveRun }), { status: "in_flight" });
});

test("old × new, in sequence both ways: whichever claims first holds it and the other is in flight", async () => {
  const newFirst = memoryKv();
  assert.equal((await claimImplementation(newFirst, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" }))).status, "claimed");
  assert.deepEqual(await legacy.claimImplementation(newFirst, "TLSSN-42", AT), { status: "in_flight" }, "old code reads the owner-stamped pending as a young pending");

  const oldFirst = memoryKv();
  assert.equal((await legacy.claimImplementation(oldFirst, "TLSSN-42", AT)).status, "claimed");
  assert.deepEqual(await claimImplementation(oldFirst, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" })), { status: "in_flight" }, "an ownerless pending is in flight, never done");
});

for (const [role, label] of [
  [0, "old code is the first to put"],
  [1, "new code is the first to put"],
] as const) {
  test(`old × new racing at the barrier, ${label}: never two claims`, async () => {
    const [first, second] = racingStores(memoryKv(), { prefix: "implement/", after: "put" });
    const [oldStore, newStore] = role === 0 ? [first, second] : [second, first];
    const [oldOutcome, newOutcome] = await Promise.all([
      legacy.claimImplementation(oldStore, "TLSSN-42", AT),
      claimImplementation(newStore, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" })),
    ]);
    assert.ok(claimedCount([oldOutcome, newOutcome]) <= 1, JSON.stringify({ oldOutcome, newOutcome }));
  });
}

test("old × new residual: an old put that lands after the new settle re-read, or between the new pre-read and put, still gives two claims", async () => {
  // Documented residual (plan §6 risk b): old code never reads back, so a
  // put it lands outside the window new code watches is invisible to both.
  const late = memoryKv();
  const lateOld = heldOldClaim(late, (store) => legacy.claimImplementation(store, "TLSSN-42", AT));
  await lateOld.read;
  const lateNew = await claimImplementation(late, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" }));
  assert.deepEqual([lateNew, await lateOld.land()].map((outcome) => outcome.status), ["claimed", "claimed"]);

  const early = memoryKv();
  const earlyOld = heldOldClaim(early, (store) => legacy.claimImplementation(store, "TLSSN-42", AT));
  await earlyOld.read;
  let earlyOldOutcome: legacy.ClaimOutcome | undefined;
  const store = aroundFirstPut(early, { before: async () => (earlyOldOutcome = await earlyOld.land()) });
  const earlyNew = await claimImplementation(store, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_a" }));
  assert.deepEqual([earlyNew.status, earlyOldOutcome?.status], ["claimed", "claimed"]);
});

test("a replay of the same delivery takes its own young pending claim over; another delivery is in flight; a launched claim is never retaken", async () => {
  const kv = memoryKv();
  assert.equal((await claimImplementation(kv, "TLSSN-42", delivery({ owner: "owner-a", deliveryId: "dlv_1" }))).status, "claimed");
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: AT.toISOString(), deliveryId: "dlv_1", owner: "owner-a" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", delivery({ owner: "owner-b", deliveryId: "dlv_2" })), { status: "in_flight" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", delivery({ owner: "owner-c", deliveryId: "dlv_1" })), { status: "claimed", retried: true });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: AT.toISOString(), deliveryId: "dlv_1", owner: "owner-c" });

  const launched = { state: "launched", at: AT.toISOString(), agentId: "bc-1", url: "https://cursor.com/agents/bc-1", commented: true, moved: true } as const;
  await recordImplementation(kv, "TLSSN-42", launched);
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", delivery({ owner: "owner-d", deliveryId: "dlv_1" })), { status: "launched", claim: launched });
});

// Each step runs on a fresh pair of kvs seeded the same way: one through the
// live function in legacy mode, one through the frozen copy.
const LEGACY_STEPS: Array<{ name: string; seed?: Record<string, unknown>; at: string }> = [
  { name: "absent", at: "2026-09-23T00:00:00.000Z" },
  { name: "young pending", seed: { state: "pending", at: "2026-09-23T00:00:00.000Z" }, at: "2026-09-23T00:10:00.000Z" },
  { name: "stale pending", seed: { state: "pending", at: "2026-09-23T00:00:00.000Z" }, at: "2026-09-23T00:10:00.001Z" },
  { name: "own delivery's pending", seed: { state: "pending", at: "2026-09-23T00:00:00.000Z", deliveryId: "dlv_1" }, at: "2026-09-23T00:01:00.000Z" },
  { name: "launched", seed: { state: "launched", at: "x", agentId: "bc-1", url: "https://cursor.com/agents/bc-1" }, at: "2026-09-24T00:00:00.000Z" },
  { name: "garbage", seed: { hello: "world" }, at: "2026-09-24T00:00:00.000Z" },
];

test("FACTORY_CLAIM_MODE=legacy is the frozen claim exactly: same outcomes, same stored values, no owner, no settle", async () => {
  for (const step of LEGACY_STEPS) {
    const live = memoryKv();
    const frozen = memoryKv();
    if (step.seed !== undefined) {
      await live.put(KEY, step.seed as never);
      await frozen.put(KEY, step.seed as never);
    }
    let waited = false;
    const run = claimRunFor({ mode: "legacy", sleep: async () => void (waited = true) });
    const now = new Date(step.at);
    assert.deepEqual(await claimImplementation(live, "TLSSN-42", { now, run, deliveryId: "dlv_1" }), await legacy.claimImplementation(frozen, "TLSSN-42", now), step.name);
    assert.deepEqual(live.entries.get(KEY), frozen.entries.get(KEY), step.name);
    assert.equal(waited, false, step.name);

    const liveMove = memoryKv();
    const frozenMove = memoryKv();
    if (step.seed !== undefined) {
      await liveMove.put(STATUS_KEY, step.seed as never);
      await frozenMove.put(STATUS_KEY, step.seed as never);
    }
    assert.deepEqual(await claimStatusMove(liveMove, STATUS_KEY, { now, run }), await legacy.claimStatusMove(frozenMove, STATUS_KEY, now), step.name);
    assert.deepEqual(liveMove.entries.get(STATUS_KEY), frozenMove.entries.get(STATUS_KEY), step.name);
  }

  const [first, second] = racingStores(memoryKv(), { prefix: "implement/", after: "put" });
  const run = claimRunFor({ mode: "legacy", sleep: tick });
  const raced = await Promise.all([claimImplementation(first, "TLSSN-42", { now: AT, run }), claimImplementation(second, "TLSSN-42", { now: AT, run })]);
  assert.equal(claimedCount(raced), 2, "legacy mode keeps the old race, as the frozen copy does");
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { CLOSE_LEAVES, cleanupClosedPr, closeCleanupOn } from "./close-cleanup.js";
import { affinityKey, autoDriveKey, bugbotRoundsKey, driveSessionKey, freshFailuresKey, prGenerationKey, WEBHOOK_BUFFER_KV_KEY } from "./kv-keys.js";

const PR = { owner: "cursor-demo-lab", repo: "marsbank", number: 50, url: "https://github.com/cursor-demo-lab/marsbank/pull/50", label: "cursor-demo-lab/marsbank#50" };
const OTHER = { ...PR, number: 51, url: "https://github.com/cursor-demo-lab/marsbank/pull/51", label: "cursor-demo-lab/marsbank#51" };
const FAST = { retryMs: [0, 0], retry: { pausesMs: [] } };

function plainKv(store: Map<string, unknown>): HostKvApi {
  return {
    get: async (key) => structuredClone(store.get(key)) as never,
    put: async (key, value) => { store.set(key, structuredClone(value)); },
    delete: async (key) => { store.delete(key); },
  };
}

/** A closed PR's kv as a started, bound drive leaves it, plus another PR's keys and the shared buffer. */
function drivenStore(): Map<string, unknown> {
  return new Map<string, unknown>([
    [autoDriveKey(PR), { state: "pending", owner: "tok-1", at: "2026-09-29T00:00:00.000Z", started: true, sessionId: "ses_50" }],
    [driveSessionKey("ses_50"), { pr: PR.label, token: "tok-1" }],
    [affinityKey(PR), { bcId: "bc-50", updatedAt: "2026-09-29T00:01:00.000Z" }],
    [bugbotRoundsKey(PR), { shas: ["a1", "b2"], rounds: 2, capNoted: true }],
    [freshFailuresKey({ pr: PR, headSha: "c3" }), { count: 1, exp: Date.now() + 60_000 }],
    [WEBHOOK_BUFFER_KV_KEY, { entries: {} }],
    [affinityKey(OTHER), { bcId: "bc-51", updatedAt: "2026-09-29T00:01:00.000Z" }],
    [bugbotRoundsKey(OTHER), { shas: ["z9"], rounds: 1 }],
  ]);
}

function logged(t: TestContext): () => Array<Record<string, unknown>> {
  const log = t.mock.method(console, "log", () => {});
  return () => log.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('"close_cleanup"')).map((line) => JSON.parse(line));
}

test("close deletes the claim, its session record, affinity and Bugbot rounds, bumps the generation; leaves fresh failures, the shared buffer and other PRs", async (t) => {
  const lines = logged(t);
  const store = drivenStore();
  const result = await cleanupClosedPr(plainKv(store) as never, { pr: PR, ...FAST, fields: { buffer: "discarded" } });
  assert.deepEqual(result, { claim: "deleted", driveSession: "deleted", affinity: "deleted", bugbotRounds: "deleted", generation: "bumped" });
  assert.deepEqual([...store.keys()].sort(), [
    affinityKey(OTHER),
    bugbotRoundsKey(OTHER),
    freshFailuresKey({ pr: PR, headSha: "c3" }),
    prGenerationKey(PR),
    WEBHOOK_BUFFER_KV_KEY,
  ].sort());
  assert.deepEqual(store.get(prGenerationKey(PR)), { n: 1 });
  assert.deepEqual(lines(), [{ fixer: "close_cleanup", pr: PR.label, buffer: "discarded", ...result, left: [...CLOSE_LEAVES] }]);
});

test("close is idempotent: a redelivered close, or a close after merge, finds everything gone, reports absent and throws nothing", async (t) => {
  const lines = logged(t);
  const store = drivenStore();
  const kv = plainKv(store) as never;
  await cleanupClosedPr(kv, { pr: PR, ...FAST });
  const kept = new Map(store);
  const again = await cleanupClosedPr(kv, { pr: PR, ...FAST });
  assert.deepEqual(again, { claim: "absent", driveSession: "absent", affinity: "absent", bugbotRounds: "absent", generation: "bumped" });
  kept.set(prGenerationKey(PR), { n: 2 });
  assert.deepEqual(store, kept, "only the generation moves, which skips one more session key");
  assert.equal(lines().length, 2, "one line per close");
});

test("a session record that names another PR or another claim token is kept", async (t) => {
  logged(t);
  for (const record of [{ pr: OTHER.label, token: "tok-1" }, { pr: PR.label, token: "tok-2" }]) {
    const store = drivenStore();
    store.set(driveSessionKey("ses_50"), record);
    const result = await cleanupClosedPr(plainKv(store) as never, { pr: PR, ...FAST });
    assert.equal(result.driveSession, "kept", JSON.stringify(record));
    assert.deepEqual(store.get(driveSessionKey("ses_50")), record);
    assert.equal(result.claim, "deleted");
  }
});

test("a claim with no session stamp (a start not yet answered, or a lease from before stamps) deletes no session record", async (t) => {
  logged(t);
  const store = drivenStore();
  store.set(autoDriveKey(PR), { state: "pending", owner: "tok-1", at: "2026-09-29T00:00:00.000Z" });
  const result = await cleanupClosedPr(plainKv(store) as never, { pr: PR, ...FAST });
  assert.equal(result.driveSession, "absent");
  assert.equal(store.has(driveSessionKey("ses_50")), true);
});

test("close cleanup never throws: a store that fails every call, or throws synchronously, reports unavailable and logs one line", async (t) => {
  const lines = logged(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const down: HostKvApi = {
    get: async () => { throw Object.assign(new Error("kv 503"), { status: 503 }); },
    put: async () => { throw Object.assign(new Error("kv 503"), { status: 503 }); },
    delete: async () => { throw Object.assign(new Error("kv 503"), { status: 503 }); },
  };
  const broken = { get: () => { throw new TypeError("not a store"); } } as unknown as HostKvApi;
  const unavailable = { claim: "unavailable", driveSession: "unavailable", affinity: "unavailable", bugbotRounds: "unavailable", generation: "unavailable" };
  for (const kv of [down, broken]) {
    assert.deepEqual(await cleanupClosedPr(kv as never, { pr: PR, ...FAST }), unavailable);
  }
  assert.equal(lines().length, 2);
});

test("close cleanup survives a console.log that throws", async (t) => {
  t.mock.method(console, "log", () => { throw new Error("stdout closed"); });
  const store = drivenStore();
  const result = await cleanupClosedPr(plainKv(store) as never, { pr: PR, ...FAST });
  assert.equal(result.bugbotRounds, "deleted");
});

test("the deletes run side by side after one read of the claim", { timeout: 5_000 }, async (t) => {
  logged(t);
  const order: string[] = [];
  const store = drivenStore();
  const inner = plainKv(store);
  let open = () => {};
  const release = new Promise<void>((resolve) => { open = resolve; });
  let pending = 0;
  const kv: HostKvApi = {
    ...inner,
    get: async (key) => {
      order.push(`get ${key}`);
      if (order.length === 1) return inner.get(key);
      if (++pending === 4) open();
      await release;
      return inner.get(key);
    },
  };
  await cleanupClosedPr(kv as never, { pr: PR, ...FAST });
  assert.equal(order[0], `get ${autoDriveKey(PR)}`);
  assert.deepEqual(order.slice(1, 5).sort(), [`get ${affinityKey(PR)}`, `get ${autoDriveKey(PR)}`, `get ${bugbotRoundsKey(PR)}`, `get ${prGenerationKey(PR)}`].sort());
  assert.ok(order.indexOf(`get ${driveSessionKey("ses_50")}`) > 4, "the session record waits for the claim release");
});

/** A store whose calls on `failing` keys fail with a 503 while every other key answers. */
function failingOn(store: Map<string, unknown>, failing: ReadonlySet<string>): HostKvApi {
  const inner = plainKv(store);
  const refuse = (key: string) => {
    if (failing.has(key)) throw Object.assign(new Error("kv 503"), { status: 503 });
  };
  return {
    get: async (key) => { refuse(key); return inner.get(key); },
    put: async (key, value) => { refuse(key); await inner.put(key, value); },
    delete: async (key) => { refuse(key); await inner.delete(key); },
  };
}

// Reviewer finding: a close whose claim release failed still dropped the
// session record, so the drive's turn-end release found nothing and the
// claim blocked a reopened PR for the rest of its 2 h lease.
test("a claim release that fails keeps the session record, so the drive's turn-end release still frees the claim", async (t) => {
  logged(t);
  t.mock.method(console, "error", () => {});
  const store = drivenStore();
  const claimKey = autoDriveKey(PR);
  const inner = plainKv(store);
  let claimReads = 0;
  const kv: HostKvApi = {
    get: async (key) => {
      if (key === claimKey && claimReads++ > 0) throw Object.assign(new Error("kv 503"), { status: 503 });
      return inner.get(key);
    },
    put: inner.put,
    delete: inner.delete,
  };
  const result = await cleanupClosedPr(kv as never, { pr: PR, ...FAST });
  assert.deepEqual([result.claim, result.driveSession], ["unavailable", "kept"]);
  assert.deepEqual(store.get(driveSessionKey("ses_50")), { pr: PR.label, token: "tok-1" });
  assert.equal(store.has(claimKey), true);
  assert.deepEqual([result.affinity, result.bugbotRounds], ["deleted", "deleted"]);
});

test("each step stands alone: a claim that cannot be released, or rounds that cannot be deleted, stop no other step", async (t) => {
  logged(t);
  t.mock.method(console, "error", () => {});
  const claimDown = drivenStore();
  const first = await cleanupClosedPr(failingOn(claimDown, new Set([autoDriveKey(PR)])) as never, { pr: PR, ...FAST });
  assert.deepEqual(first, { claim: "unavailable", driveSession: "unavailable", affinity: "deleted", bugbotRounds: "deleted", generation: "bumped" });

  const roundsDown = drivenStore();
  const second = await cleanupClosedPr(failingOn(roundsDown, new Set([bugbotRoundsKey(PR)])) as never, { pr: PR, ...FAST });
  assert.deepEqual(second, { claim: "deleted", driveSession: "deleted", affinity: "deleted", bugbotRounds: "unavailable", generation: "bumped" });
  assert.equal(roundsDown.has(bugbotRoundsKey(PR)), true);
});

test("FACTORY_FIXER_CLOSE_CLEANUP=off turns the cleanup off; anything else keeps it", () => {
  assert.equal(closeCleanupOn({}), true);
  assert.equal(closeCleanupOn({ FACTORY_FIXER_CLOSE_CLEANUP: "on" }), true);
  assert.equal(closeCleanupOn({ FACTORY_FIXER_CLOSE_CLEANUP: " OFF " }), false);
});

test("a merged PR's close (bumpGeneration: false) still cleans up but adds no generation: merged PRs cannot reopen", async (t) => {
  logged(t);
  const store = drivenStore();
  const result = await cleanupClosedPr(plainKv(store) as never, { pr: PR, ...FAST, bumpGeneration: false });
  assert.deepEqual(result, { claim: "deleted", driveSession: "deleted", affinity: "deleted", bugbotRounds: "deleted", generation: "skipped_merged" });
  assert.equal(store.has(prGenerationKey(PR)), false);
});

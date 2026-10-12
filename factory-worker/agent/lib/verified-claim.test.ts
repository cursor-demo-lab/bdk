import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import type { KvKey } from "./kv-keys.js";
import { claimRunFor, memoryKv, OWNER, tick } from "./testing/fakes.js";
import { CLAIM_SETTLE_MS, claimMode, claimRun, claimSettleMs, releaseClaim, takeVerifiedClaim } from "./verified-claim.js";

// The shared claim flow on its own. The sites (planner claimPlan, worker
// claimImplementation and claimStatusMove) race it against each other and
// against their frozen legacy copies in their own tests.

const KEY = "implement/TLSSN-42" as KvKey;
const AT = "2026-09-23T00:00:00.000Z";
const PENDING = { state: "pending", at: AT };

type Lost = { status: "done" } | { status: "in_flight" } | { status: "stale" };

/** A site's classify in miniature: `done` is final, a pending marked `old` is stale, anything else is in flight. */
function classify(value: unknown): Lost {
  const record = value as Record<string, unknown> | undefined;
  if (record?.["state"] === "done") return { status: "done" };
  if (record?.["state"] === "pending" && record["old"] === true) return { status: "stale" };
  return { status: "in_flight" };
}

type Op = "get" | "put" | "delete";

/** Counts every kv call; `script` may replace a call's result by its 1-based index among all calls. */
function countingKv(inner: HostKvApi, script: (n: number, op: Op) => { value?: JsonValue; fail?: true; skip?: true } | undefined = () => undefined) {
  const ops: Op[] = [];
  const kv: HostKvApi = {
    get: async (key) => {
      ops.push("get");
      const step = script(ops.length, "get");
      if (step?.fail) throw new Error("kv read failed");
      if (step !== undefined && "value" in step) return step.value;
      return inner.get(key);
    },
    put: async (key, value) => {
      ops.push("put");
      if (script(ops.length, "put")?.fail) throw new Error("kv write failed");
      await inner.put(key, value);
    },
    delete: async (key) => {
      ops.push("delete");
      if (script(ops.length, "delete")?.fail) throw new Error("kv delete failed");
      await inner.delete(key);
    },
  };
  return { kv, ops };
}

test("the settle comes from FACTORY_CLAIM_SETTLE_MS: default 2 s, 0 turns it off, anything unparseable or over 10 s keeps the default", () => {
  assert.equal(claimSettleMs({}), CLAIM_SETTLE_MS);
  assert.equal(CLAIM_SETTLE_MS, 2_000);
  assert.equal(claimSettleMs({ FACTORY_CLAIM_SETTLE_MS: "0" }), 0);
  assert.equal(claimSettleMs({ FACTORY_CLAIM_SETTLE_MS: " 750 " }), 750);
  assert.equal(claimSettleMs({ FACTORY_CLAIM_SETTLE_MS: "10000" }), 10_000);
  assert.equal(claimSettleMs({ FACTORY_CLAIM_SETTLE_MS: "10001" }), CLAIM_SETTLE_MS);
  assert.equal(claimSettleMs({ FACTORY_CLAIM_SETTLE_MS: "-5" }), CLAIM_SETTLE_MS);
  assert.equal(claimSettleMs({ FACTORY_CLAIM_SETTLE_MS: "2s" }), CLAIM_SETTLE_MS);
});

test("FACTORY_CLAIM_MODE=legacy is the only way to the legacy claim, and each run gets a fresh owner", () => {
  assert.equal(claimMode({}), "verified");
  assert.equal(claimMode({ FACTORY_CLAIM_MODE: "legacy" }), "legacy");
  assert.equal(claimMode({ FACTORY_CLAIM_MODE: " Legacy " }), "legacy");
  assert.equal(claimMode({ FACTORY_CLAIM_MODE: "off" }), "verified");
  const first = claimRun({}, { host: "worker" });
  const second = claimRun({}, { host: "worker" });
  assert.notEqual(first.owner, second.owner);
  assert.match(first.owner, /^[0-9a-f-]{36}$/);
});

test("a claim on an absent key is five kv calls: read, pre-read, put, read back, settle re-read", async () => {
  const { kv, ops } = countingKv(memoryKv());
  const waits: number[] = [];
  const run = claimRunFor({ sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(await takeVerifiedClaim(kv, KEY, { pending: PENDING, run, classify }), { status: "claimed", retried: false });
  assert.deepEqual(ops, ["get", "get", "put", "get", "get"]);
  assert.deepEqual(waits, [2_000]);
});

test("a settle of 0 skips the wait and the re-read", async () => {
  const { kv, ops } = countingKv(memoryKv());
  const waits: number[] = [];
  const run = claimRunFor({ settleMs: 0, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(await takeVerifiedClaim(kv, KEY, { pending: PENDING, run, classify }), { status: "claimed", retried: false });
  assert.deepEqual(ops, ["get", "get", "put", "get"]);
  assert.deepEqual(waits, []);
});

test("the worst claim that still settles is thirteen kv calls: three verified attempts and three settle reads", async () => {
  const inner = memoryKv();
  const rival = { state: "pending", at: AT, owner: "rival" };
  // Each read-back shows a rival that has gone again by the next attempt's
  // pre-read; the third attempt sticks. The settle read fails twice.
  const { kv, ops } = countingKv(inner, (n, op) => {
    if (op !== "get") return undefined;
    if (n === 4 || n === 7) return { value: rival };
    if (n === 5 || n === 8) return { value: undefined };
    if (n === 11 || n === 12) return { fail: true };
    return undefined;
  });
  assert.deepEqual(await takeVerifiedClaim(kv, KEY, { pending: PENDING, run: claimRunFor(), classify }), { status: "claimed", retried: false });
  assert.equal(ops.length, 13);
  assert.deepEqual(ops, ["get", "get", "put", "get", "get", "put", "get", "get", "put", "get", "get", "get", "get"]);
});

test("no claim takes more than thirteen kv calls, even when every call fails", async () => {
  for (const failing of ["get", "put", "every"] as const) {
    const { kv, ops } = countingKv(memoryKv(), (n, op) => (n > 1 && (failing === "every" || op === failing) ? { fail: true } : undefined));
    const outcome = await takeVerifiedClaim(kv, KEY, { pending: PENDING, run: claimRunFor(), classify });
    assert.equal(outcome.status, "unavailable", failing);
    assert.ok(ops.length <= 13, `${failing}: ${ops.length} calls`);
  }
});

test("a release is three kv calls, nine at most, and never throws", async () => {
  const inner = memoryKv();
  await inner.put(KEY, { ...PENDING, owner: OWNER });
  const typical = countingKv(inner);
  assert.equal(await releaseClaim(typical.kv, KEY, claimRunFor()), "released");
  assert.deepEqual(typical.ops, ["get", "delete", "get"]);

  await inner.put(KEY, { ...PENDING, owner: OWNER });
  // Every delete and every read-back fails, so each attempt reads, deletes, and reads again.
  const worst = countingKv(inner, (n, op) => (op === "delete" || (op === "get" && n % 3 === 0) ? { fail: true } : undefined));
  assert.equal(await releaseClaim(worst.kv, KEY, claimRunFor()), "unavailable");
  assert.equal(worst.ops.length, 9);
});

test("a release deletes only this owner's claim: a rival's is kept, and legacy mode is a plain delete", async () => {
  const kv = memoryKv();
  const rival = { ...PENDING, owner: "rival" };
  await kv.put(KEY, rival);
  assert.equal(await releaseClaim(kv, KEY, claimRunFor()), "not_owner");
  assert.deepEqual(kv.entries.get(KEY), rival);

  await kv.put(KEY, PENDING);
  assert.equal(await releaseClaim(kv, KEY, claimRunFor()), "not_owner", "an ownerless legacy pending is not this owner's");
  assert.deepEqual(kv.entries.get(KEY), PENDING);

  assert.equal(await releaseClaim(kv, KEY, claimRunFor({ mode: "legacy" })), "released");
  assert.equal(kv.entries.has(KEY), false);
});

test("the confirm step never retakes: a key that vanished during the settle is in flight, a stale value is in flight, and an unreadable one is unavailable", async () => {
  const vanished = memoryKv();
  const onVanish = claimRunFor({ sleep: async () => void (await vanished.delete(KEY)) });
  assert.deepEqual(await takeVerifiedClaim(vanished, KEY, { pending: PENDING, run: onVanish, classify }), { status: "in_flight" });
  assert.equal(vanished.entries.has(KEY), false);

  const staleRival = memoryKv();
  const onStale = claimRunFor({ sleep: async () => void (await staleRival.put(KEY, { state: "pending", at: AT, old: true })) });
  assert.deepEqual(await takeVerifiedClaim(staleRival, KEY, { pending: PENDING, run: onStale, classify }), { status: "in_flight" });

  const done = memoryKv();
  const onDone = claimRunFor({ sleep: async () => void (await done.put(KEY, { state: "done" })) });
  assert.deepEqual(await takeVerifiedClaim(done, KEY, { pending: PENDING, run: onDone, classify }), { status: "done" });

  const { kv: unreadable } = countingKv(memoryKv(), (n, op) => (op === "get" && n >= 5 ? { fail: true } : undefined));
  assert.deepEqual(await takeVerifiedClaim(unreadable, KEY, { pending: PENDING, run: claimRunFor(), classify }), { status: "unavailable" });
});

test("step 1 is the site's own classify: a stale value is taken over, anything else is answered without a write", async () => {
  const kv = memoryKv();
  await kv.put(KEY, { state: "done" });
  assert.deepEqual(await takeVerifiedClaim(kv, KEY, { pending: PENDING, run: claimRunFor(), classify }), { status: "done" });
  assert.deepEqual(kv.entries.get(KEY), { state: "done" });

  await kv.put(KEY, { state: "pending", at: AT, old: true });
  assert.deepEqual(await takeVerifiedClaim(kv, KEY, { pending: PENDING, run: claimRunFor(), classify }), { status: "claimed", retried: true });
  assert.deepEqual(kv.entries.get(KEY), { ...PENDING, owner: OWNER });
});

test("a put overwritten on all three attempts is unavailable, never in flight: the caller releases and answers 503", async () => {
  const inner = memoryKv();
  const rival = { state: "pending", at: AT, owner: "rival" };
  // Every read-back shows a rival; every pre-read shows the key empty again, so no attempt refuses.
  const { kv, ops } = countingKv(inner, (n, op) => {
    if (op !== "get") return undefined;
    if (n === 4 || n === 7 || n === 10) return { value: rival };
    if (n === 5 || n === 8) return { value: undefined };
    return undefined;
  });
  assert.deepEqual(await takeVerifiedClaim(kv, KEY, { pending: PENDING, run: claimRunFor(), classify }), { status: "unavailable" });
  assert.deepEqual(ops, ["get", "get", "put", "get", "get", "put", "get", "get", "put", "get"]);
  assert.equal(await releaseClaim(inner, KEY, claimRunFor()), "released", "this owner's last put is what the key holds, and it goes");
});

test("a rival value that appears between the read and the put is never overwritten", async () => {
  const inner = memoryKv();
  const rival = { state: "pending", at: AT, owner: "rival" };
  const { kv } = countingKv(inner, (n, op) => (op === "get" && n === 2 ? { value: rival } : undefined));
  assert.deepEqual(await takeVerifiedClaim(kv, KEY, { pending: PENDING, run: claimRunFor(), classify }), { status: "in_flight" });
  assert.equal(inner.entries.has(KEY), false);
});

test("every decision is one JSON line with the host, the outcome, and the key", async () => {
  const lines: string[] = [];
  const run = claimRunFor({ log: (line) => lines.push(line), sleep: tick });
  const kv = memoryKv();
  await kv.put(KEY, { ...PENDING, owner: OWNER });
  await releaseClaim(kv, KEY, run);
  await releaseClaim(kv, KEY, run);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { host: "worker", claim: "release_released", key: KEY, mode: "verified" },
      { host: "worker", claim: "release_not_owner", key: KEY, mode: "verified" },
    ]
  );
  await releaseClaim(kv, KEY, { ...run, mode: "legacy" });
  assert.equal(lines.length, 2, "legacy mode logs no claim lines, as main did");
});

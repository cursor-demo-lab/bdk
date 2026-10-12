import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { HostKvApi, HostKvCasApi, JsonValue, KvCasResult } from "@cursor/july";
import { claimPlan, parsePlanClaim, startPlan, type Send, type StartPlanInput } from "./start-plan.js";
import type { KvKey } from "./kv-keys.js";
import type { ClaimRun, Sleep } from "./verified-claim.js";
import { CHECKOUT_ENV, MANAGED_HOSTING_ENV } from "./checkout.js";
import { FactoryConfigError } from "./config.js";

const asKey = (raw: string): KvKey => raw as KvKey;

const KEY = asKey("plan/TLSSN-42:Triaged:10041");
const REQUEST = { issueKey: "TLSSN-42", title: "CSV export returns 500" };

type MemoryKv = HostKvApi & { entries: Map<string, JsonValue> };

/** In-memory kv. Like hosted `host.kv`, it has no compare-and-set unless `cas: true`. */
function memoryKv(options: { cas?: boolean } = {}): MemoryKv {
  const entries = new Map<string, JsonValue>();
  const versions = new Map<string, number>();
  let counter = 0;
  const write = (key: string, value: JsonValue): string => {
    counter += 1;
    entries.set(key, value);
    versions.set(key, counter);
    return String(counter);
  };
  const current = (key: string) => {
    const value = entries.get(key);
    return value === undefined ? undefined : { value, version: String(versions.get(key)) };
  };
  const plain: MemoryKv = {
    entries,
    get: async (key) => entries.get(key),
    put: async (key, value) => {
      write(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
      versions.delete(key);
    },
  };
  if (options.cas !== true) return plain;
  const cas: HostKvCasApi & MemoryKv = {
    ...plain,
    getWithVersion: async (key) => current(key),
    putIfAbsent: async (key, value): Promise<KvCasResult> =>
      entries.has(key) ? { ok: false, current: current(key) } : { ok: true, version: write(key, value) },
    putIfVersion: async (key, value, expected): Promise<KvCasResult> =>
      current(key)?.version === expected ? { ok: true, version: write(key, value) } : { ok: false, current: current(key) },
    listKeys: async (prefix) => [...entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
  return cas;
}

type Sent = { message: string; options: Parameters<Send>[1] };

function sender(options: { fail?: Error } = {}): { send: Send; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (message, sendOptions) => {
      sent.push({ message, options: sendOptions });
      if (options.fail !== undefined) throw options.fail;
      return { id: `ses_${sent.length}` };
    },
  };
}

/** The settle wait without the wall-clock wait: every pending kv call has landed when it resolves. */
const tick: Sleep = () => new Promise((resolve) => setImmediate(resolve));

const OWNER = "owner-1";

function run(overrides: Partial<ClaimRun> = {}): ClaimRun {
  return { host: "planner", mode: "verified", owner: OWNER, settleMs: 2_000, sleep: tick, log: () => {}, ...overrides };
}

const claimAt = (at: string, options: { deliveryId?: string; claim?: ClaimRun } = {}) => ({
  now: new Date(at),
  run: options.claim ?? run(),
  ...(options.deliveryId === undefined ? {} : { deliveryId: options.deliveryId }),
});

function input(kv: HostKvApi, send: Send, at: string, overrides: Partial<StartPlanInput> = {}): StartPlanInput {
  return {
    kv,
    key: KEY,
    clearFirst: false,
    request: REQUEST,
    replan: false,
    attempt: "10041",
    send,
    via: "status",
    now: () => new Date(at),
    env: {},
    sleep: tick,
    log: () => {},
    ...overrides,
  };
}

test("on managed hosting the send attaches the sandbox clone; off it, with or without a checkout, the send stays local", async () => {
  const sandbox = { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_SANDBOX_REF: "main" };
  const hosted = { ...sandbox, [MANAGED_HOSTING_ENV]: "3" };
  const cloud = sender();
  await startPlan(input(memoryKv(), cloud.send, "2026-09-23T00:00:00.000Z", { env: hosted }));
  assert.deepEqual(cloud.sent[0]?.options.cloud, { repos: [{ url: "https://github.com/cursor-demo-lab/marsbank", startingRef: "main" }] });

  const offHost = sender();
  await startPlan(input(memoryKv(), offHost.send, "2026-09-23T00:00:00.000Z", { env: sandbox }));
  assert.equal(offHost.sent[0]?.options.cloud, undefined);

  const local = sender();
  const checkout = mkdtempSync(join(tmpdir(), "planner-checkout-"));
  await startPlan(input(memoryKv(), local.send, "2026-09-23T00:00:00.000Z", { env: { ...sandbox, [CHECKOUT_ENV]: checkout } }));
  assert.equal(local.sent[0]?.options.cloud, undefined);
});

test("on managed hosting a set checkout fails the send by name and releases the claim", async () => {
  const kv = memoryKv();
  const { send, sent } = sender();
  const checkout = mkdtempSync(join(tmpdir(), "planner-checkout-"));
  const env = { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", [MANAGED_HOSTING_ENV]: "3", [CHECKOUT_ENV]: checkout };
  await assert.rejects(startPlan(input(kv, send, "2026-09-23T00:00:00.000Z", { env })), FactoryConfigError);
  assert.equal(sent.length, 0);
  assert.equal(await kv.get(KEY), undefined);
});

test("on managed hosting with no sandbox the send fails by name and releases the claim", async () => {
  const kv = memoryKv();
  const { send, sent } = sender();
  await assert.rejects(
    startPlan(input(kv, send, "2026-09-23T00:00:00.000Z", { env: { [MANAGED_HOSTING_ENV]: "3" } })),
    FactoryConfigError
  );
  assert.equal(sent.length, 0);
  assert.equal(await kv.get(KEY), undefined);
});

test("the first delivery claims pending, sends once, and records the started session", async () => {
  const kv = memoryKv();
  const { send, sent } = sender();
  const response = await startPlan(input(kv, send, "2026-09-23T00:00:00.000Z"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, started: true, sessionId: "ses_1", issueKey: "TLSSN-42", via: "status" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.options, { continuationToken: "issue:TLSSN-42#10041", admission: "coalesce", title: "TLSSN-42: CSV export returns 500" });
  assert.deepEqual(kv.entries.get(KEY), { state: "started", at: "2026-09-23T00:00:00.000Z", sessionId: "ses_1" });
});

test("a pending plan claim older than the stale window is taken over and sends exactly once", async () => {
  const kv = memoryKv();
  await kv.put(KEY, { state: "pending", at: "2026-09-23T00:00:00.000Z" });
  const { send, sent } = sender();
  const response = await startPlan(input(kv, send, "2026-09-23T00:10:00.001Z"));
  assert.deepEqual(await response.json(), { ok: true, started: true, sessionId: "ses_1", issueKey: "TLSSN-42", via: "status", retried: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(kv.entries.get(KEY), { state: "started", at: "2026-09-23T00:10:00.001Z", sessionId: "ses_1" });

  const again = await startPlan(input(kv, send, "2026-09-23T00:30:00.000Z"));
  assert.deepEqual(await again.json(), { ok: true, duplicate: true, issueKey: "TLSSN-42", via: "status" });
  assert.equal(sent.length, 1);
});

test("a pending plan claim inside the stale window is in flight and sends nothing", async () => {
  const kv = memoryKv();
  await kv.put(KEY, { state: "pending", at: "2026-09-23T00:00:00.000Z" });
  const { send, sent } = sender();
  const response = await startPlan(input(kv, send, "2026-09-23T00:10:00.000Z"));
  assert.deepEqual(await response.json(), { ok: true, duplicate: true, issueKey: "TLSSN-42", via: "status", inFlight: true });
  assert.equal(sent.length, 0);
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:00:00.000Z" });
});

test("a started plan claim is a duplicate at any age and sends nothing", async () => {
  const kv = memoryKv();
  await kv.put(KEY, { state: "started", at: "2026-09-23T00:00:00.000Z", sessionId: "ses_9" });
  const { send, sent } = sender();
  const response = await startPlan(input(kv, send, "2026-09-30T00:00:00.000Z"));
  assert.deepEqual(await response.json(), { ok: true, duplicate: true, issueKey: "TLSSN-42", via: "status" });
  assert.equal(sent.length, 0);
  assert.deepEqual(kv.entries.get(KEY), { state: "started", at: "2026-09-23T00:00:00.000Z", sessionId: "ses_9" });
});

test("a send that throws leaves no plan claim, so the next delivery plans", async () => {
  const kv = memoryKv();
  const failing = sender({ fail: new Error("dispatch refused") });
  await assert.rejects(startPlan(input(kv, failing.send, "2026-09-23T00:00:00.000Z")), { message: "dispatch refused" });
  assert.equal(failing.sent.length, 1);
  assert.equal(kv.entries.has(KEY), false);

  await kv.put(KEY, { state: "pending", at: "2026-09-23T00:00:00.000Z" });
  await assert.rejects(startPlan(input(kv, failing.send, "2026-09-23T00:10:00.001Z")), { message: "dispatch refused" });
  assert.equal(kv.entries.has(KEY), false);

  const { send, sent } = sender();
  const response = await startPlan(input(kv, send, "2026-09-23T00:10:00.002Z"));
  assert.deepEqual(await response.json(), { ok: true, started: true, sessionId: "ses_1", issueKey: "TLSSN-42", via: "status" });
  assert.equal(sent.length, 1);
});

test("a store that fails answers 503 and sends nothing", async () => {
  const broken: HostKvApi = {
    get: async () => {
      throw new Error("kv down");
    },
    put: async () => {
      throw new Error("kv down");
    },
    delete: async () => {
      throw new Error("kv down");
    },
  };
  const { send, sent } = sender();
  const response = await startPlan(input(broken, send, "2026-09-23T00:00:00.000Z"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, started: false, reason: "claim_unavailable", issueKey: "TLSSN-42", via: "status" });
  assert.equal(sent.length, 0);
});

test("without compare-and-set, the plan claim reads then writes and takes over only a stale pending claim", async () => {
  const kv = memoryKv();
  assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-23T00:00:00.000Z")), { status: "claimed", retried: false });
  assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-23T00:05:00.000Z")), { status: "in_flight" });
  assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-23T00:10:00.001Z")), { status: "claimed", retried: true });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:10:00.001Z", owner: OWNER });
  await kv.put(KEY, { state: "started", at: "2026-09-23T00:10:00.001Z", sessionId: "ses_1" });
  assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-24T00:00:00.000Z")), {
    status: "started",
    claim: { state: "started", at: "2026-09-23T00:10:00.001Z", sessionId: "ses_1" },
  });
});

test("the comment path's replan clears a started claim and plans again", async () => {
  const kv = memoryKv();
  const key = "plan-claimed/TLSSN-42";
  await kv.put(key, { state: "started", at: "2026-09-23T00:00:00.000Z", sessionId: "ses_9" });
  const { send, sent } = sender();
  const response = await startPlan(input(kv, send, "2026-09-23T01:00:00.000Z", { key: asKey(key), clearFirst: true, replan: true, via: "comment" }));
  assert.deepEqual(await response.json(), { ok: true, started: true, sessionId: "ses_1", issueKey: "TLSSN-42", via: "comment" });
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.message ?? "", /^replan: the ticket was sent back for a new plan\./m);
  assert.deepEqual(kv.entries.get(key), { state: "started", at: "2026-09-23T01:00:00.000Z", sessionId: "ses_1" });
});

test("a second plan of the same ticket, on a new changelog id, sends on a new continuation", async () => {
  const kv = memoryKv();
  const { send, sent } = sender();
  const first = await startPlan(input(kv, send, "2026-09-23T00:00:00.000Z", { key: asKey("plan/TLSSN-42:Triaged:32100"), attempt: "32100" }));
  const second = await startPlan(input(kv, send, "2026-09-23T01:00:00.000Z", { key: asKey("plan/TLSSN-42:Triaged:32152"), attempt: "32152", replan: true }));
  assert.equal((await first.json() as Record<string, unknown>)["started"], true);
  assert.equal((await second.json() as Record<string, unknown>)["started"], true);
  assert.deepEqual(
    sent.map((s) => s.options.continuationToken),
    ["issue:TLSSN-42#32100", "issue:TLSSN-42#32152"]
  );
  assert.doesNotMatch(sent[0]?.message ?? "", /replan/);
  assert.match(sent[1]?.message ?? "", /^replan: the ticket was sent back for a new plan\./m);
});

test("a redelivery of one changelog id reuses its continuation and is still deduped by the claim", async () => {
  const kv = memoryKv();
  const failing = sender({ fail: new Error("dispatch refused") });
  await assert.rejects(startPlan(input(kv, failing.send, "2026-09-23T00:00:00.000Z", { attempt: "32152" })), { message: "dispatch refused" });

  const { send, sent } = sender();
  await startPlan(input(kv, send, "2026-09-23T00:00:01.000Z", { attempt: "32152" }));
  const again = await startPlan(input(kv, send, "2026-09-23T00:00:02.000Z", { attempt: "32152" }));
  assert.deepEqual(await again.json(), { ok: true, duplicate: true, issueKey: "TLSSN-42", via: "status" });
  assert.equal(sent.length, 1);
  assert.equal(failing.sent[0]?.options.continuationToken, "issue:TLSSN-42#32152");
  assert.equal(sent[0]?.options.continuationToken, "issue:TLSSN-42#32152");
});

test("a deferred hosted session, whose id throws, still records the claim as started and dedupes a late redelivery", async () => {
  const kv = memoryKv();
  const tokens: string[] = [];
  const deferredSend: Send = async (_message, options) => {
    tokens.push(options.continuationToken);
    return {
      get id(): string {
        throw new Error("deferred channel session: id is not available until admission");
      },
    };
  };
  const response = await startPlan(input(kv, deferredSend, "2026-09-23T00:00:00.000Z", { attempt: "555" }));
  assert.deepEqual(await response.json(), { ok: true, started: true, issueKey: "TLSSN-42", via: "status" });
  assert.deepEqual(kv.entries.get(KEY), { state: "started", at: "2026-09-23T00:00:00.000Z", sessionId: "deferred" });

  const late = await startPlan(input(kv, deferredSend, "2026-09-23T00:30:00.000Z", { attempt: "555" }));
  assert.deepEqual(await late.json(), { ok: true, duplicate: true, issueKey: "TLSSN-42", via: "status" });
  assert.deepEqual(tokens, ["issue:TLSSN-42#555"]);
});

test("hosted admission of the same delivery again sends again; another delivery of that transition is a duplicate", async () => {
  const kv = memoryKv();
  const tokens: string[] = [];
  const deferredSend: Send = async (_message, options) => {
    tokens.push(options.continuationToken);
    return {
      get id(): string {
        throw new Error("deferred channel session: id is not available until admission");
      },
    };
  };
  const first = await startPlan(input(kv, deferredSend, "2026-09-26T08:56:44.000Z", { attempt: "555", deliveryId: "dlv_1" }));
  assert.equal((await first.json() as Record<string, unknown>)["started"], true);
  assert.deepEqual(kv.entries.get(KEY), { state: "started", at: "2026-09-26T08:56:44.000Z", sessionId: "deferred", deliveryId: "dlv_1" });

  const replayed = await startPlan(input(kv, deferredSend, "2026-09-26T08:57:10.000Z", { attempt: "555", deliveryId: "dlv_1" }));
  assert.deepEqual(await replayed.json(), { ok: true, started: true, issueKey: "TLSSN-42", via: "status", retried: true });

  const other = await startPlan(input(kv, deferredSend, "2026-09-26T08:57:20.000Z", { attempt: "555", deliveryId: "dlv_2" }));
  assert.deepEqual(await other.json(), { ok: true, duplicate: true, issueKey: "TLSSN-42", via: "status" });
  assert.deepEqual(tokens, ["issue:TLSSN-42#555", "issue:TLSSN-42#555"]);
});

test("a replayed admission takes over its own pending claim inside the stale window", async () => {
  const kv = memoryKv();
  await kv.put(KEY, { state: "pending", at: "2026-09-26T08:56:44.000Z", deliveryId: "dlv_1" });
  assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-26T08:57:00.000Z", { deliveryId: "dlv_1" })), { status: "claimed", retried: true });
  assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-26T08:57:01.000Z", { deliveryId: "dlv_2" })), { status: "in_flight" });
});

// Hosted host.kv (July 0.2.13) has no compare-and-set, so only these tests reach claimPlan's putIfAbsent branch.
describe("CAS path (ask 11)", () => {
  test("claimPlan takes an absent key with putIfAbsent, holds a young pending claim, and takes a stale one with putIfVersion", async () => {
    const kv = memoryKv({ cas: true });
    assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-23T00:00:00.000Z")), { status: "claimed", retried: false });
    assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-23T00:10:00.000Z")), { status: "in_flight" });
    assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-23T00:10:00.001Z")), { status: "claimed", retried: true });
    assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:10:00.001Z", owner: OWNER });
    await kv.put(KEY, { state: "started", at: "2026-09-23T00:10:00.001Z", sessionId: "ses_1" });
    assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-24T00:00:00.000Z")), {
      status: "started",
      claim: { state: "started", at: "2026-09-23T00:10:00.001Z", sessionId: "ses_1" },
    });
  });

  test("claimPlan takes over this delivery's own pending claim and leaves another delivery in flight", async () => {
    const kv = memoryKv({ cas: true });
    await kv.put(KEY, { state: "pending", at: "2026-09-26T08:56:44.000Z", deliveryId: "dlv_1" });
    assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-26T08:57:00.000Z", { deliveryId: "dlv_1" })), { status: "claimed", retried: true });
    assert.deepEqual(await claimPlan(kv, KEY, claimAt("2026-09-26T08:57:01.000Z", { deliveryId: "dlv_2" })), { status: "in_flight" });
  });

  test("startPlan over a started claim: this delivery's replay sends again, another delivery is a duplicate", async () => {
    const kv = memoryKv({ cas: true });
    await kv.put(KEY, { state: "started", at: "2026-09-26T08:56:44.000Z", sessionId: "deferred", deliveryId: "dlv_1" });
    const { send, sent } = sender();
    const replayed = await startPlan(input(kv, send, "2026-09-26T08:57:10.000Z", { attempt: "555", deliveryId: "dlv_1" }));
    assert.deepEqual(await replayed.json(), { ok: true, started: true, sessionId: "ses_1", issueKey: "TLSSN-42", via: "status", retried: true });
    const other = await startPlan(input(kv, send, "2026-09-26T08:57:20.000Z", { attempt: "555", deliveryId: "dlv_2" }));
    assert.deepEqual(await other.json(), { ok: true, duplicate: true, issueKey: "TLSSN-42", via: "status" });
    assert.equal(sent.length, 1);
    assert.deepEqual(kv.entries.get(KEY), { state: "started", at: "2026-09-26T08:57:10.000Z", sessionId: "ses_1", deliveryId: "dlv_1" });
  });

  test("a takeover that loses putIfVersion to another delivery does not claim", async () => {
    const kv = memoryKv({ cas: true });
    await kv.put(KEY, { state: "pending", at: "2026-09-23T00:00:00.000Z" });
    const store = kv as unknown as HostKvCasApi;
    const racing: HostKvCasApi = {
      ...store,
      getWithVersion: async (key) => {
        const seen = await store.getWithVersion(key);
        await kv.put(key, { state: "pending", at: "2026-09-23T00:10:00.000Z" });
        return seen;
      },
    };
    assert.deepEqual(await claimPlan(racing, KEY, claimAt("2026-09-23T00:10:00.001Z")), { status: "in_flight" });
    assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:10:00.000Z" });
  });
});

test("parsePlanClaim reads a pending or a started claim and nothing else", () => {
  assert.deepEqual(parsePlanClaim({ state: "started", at: "x", sessionId: "deferred", deliveryId: "dlv_1" }), {
    state: "started",
    at: "x",
    sessionId: "deferred",
    deliveryId: "dlv_1",
  });
  assert.deepEqual(parsePlanClaim({ state: "pending", at: "x" }), { state: "pending", at: "x" });
  assert.deepEqual(parsePlanClaim({ state: "started", at: "x", sessionId: "ses_1" }), { state: "started", at: "x", sessionId: "ses_1" });
  assert.equal(parsePlanClaim({ at: "x" }), undefined);
  assert.equal(parsePlanClaim({ state: "started", at: "x", sessionId: "" }), undefined);
  assert.equal(parsePlanClaim(undefined), undefined);
});

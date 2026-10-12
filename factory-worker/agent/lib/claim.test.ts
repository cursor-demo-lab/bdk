import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HostKvApi, HostKvCasApi } from "@cursor/july";
import {
  claimImplementation,
  claimStatusMove,
  HOSTED_PENDING_SEND_TTL_MS,
  LAUNCH_SENT_GRACE_MS,
  markLaunchSent,
  noteBoundAgent,
  parseBoundAgent,
  parseClaim,
  readBoundAgent,
  recordImplementation,
  recordLaunch,
  releaseImplementation,
  returnLaunchFailureNotice,
  takeLaunchFailureNotice,
} from "./claim.js";
import { prStatusClaimKey } from "./kv-keys.js";
import { LAUNCH_LATE_WAIT_MS, LAUNCH_TIMEOUT_MS } from "./launch.js";
import { claimRunFor, memoryKv, OWNER } from "./testing/fakes.js";

const KEY = "implement/TLSSN-42";
const CLAIMED_AT = new Date("2026-09-23T00:00:00.000Z");
const at = (now: Date) => ({ now, run: claimRunFor() });
const LAUNCHED = { state: "launched", at: "2026-09-23T00:00:00.000Z", agentId: "bc-1", url: "https://cursor.com/agents/bc-1", commented: true, moved: true } as const;

test("the first claim writes pending and a launched claim is reported to later deliveries", async () => {
  const kv = memoryKv();
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT)), { status: "claimed", retried: false });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:00:00.000Z", owner: OWNER });
  await recordImplementation(kv, "TLSSN-42", LAUNCHED);
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-24T00:00:00.000Z"))), { status: "launched", claim: LAUNCHED });
  assert.deepEqual([...kv.entries.keys()], [KEY]);
});

test("a pending claim is in flight up to the launch grace and taken over after it", async () => {
  const kv = memoryKv();
  await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT));
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:03:00.000Z"))), { status: "in_flight" });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:00:00.000Z", owner: OWNER });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:03:00.001Z"))), { status: "claimed", retried: true });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:03:00.001Z", owner: OWNER });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:03:00.002Z"))), { status: "in_flight" });
});

test("FACTORY_CLAIM_MODE=legacy keeps the frozen ten-minute window for a pending launch claim", async () => {
  const kv = memoryKv();
  const legacy = (now: Date) => ({ now, run: claimRunFor({ mode: "legacy" }) });
  await claimImplementation(kv, "TLSSN-42", legacy(CLAIMED_AT));
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", legacy(new Date("2026-09-23T00:10:00.000Z"))), { status: "in_flight" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", legacy(new Date("2026-09-23T00:10:00.001Z"))), { status: "claimed", retried: true });
});

test("a claim whose settle re-read finds the key empty (a lagging hosted read) is unconfirmed, not in flight, and its own put stays for the watch", async () => {
  const kv = memoryKv();
  let lagging = false;
  const lag: HostKvApi = {
    get: async (key) => (lagging ? undefined : kv.get(key)),
    put: (key, value) => kv.put(key, value),
    delete: (key) => kv.delete(key),
  };
  const run = claimRunFor({
    sleep: async () => {
      lagging = true;
    },
  });
  assert.deepEqual(await claimImplementation(lag, "TLSSN-42", { now: CLAIMED_AT, run }), { status: "unconfirmed" });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:00:00.000Z", owner: OWNER }, "the put landed; only the read lagged");
});

test("without compare-and-set, the claim reads then writes and takes over a stale pending claim", async () => {
  const kv = memoryKv();
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT)), { status: "claimed", retried: false });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:02:00.000Z"))), { status: "in_flight" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:03:00.001Z"))), { status: "claimed", retried: true });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:03:00.001Z", owner: OWNER });
  await recordImplementation(kv, "TLSSN-42", LAUNCHED);
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-24T00:00:00.000Z"))), { status: "launched", claim: LAUNCHED });
});

test("a stored value no worker version writes, or a pending with no readable time, is taken over instead of blocking the ticket for good", async () => {
  for (const seed of [{ state: "launching", at: "2026-09-23T00:00:00.000Z" }, { state: "pending" }, { state: "pending", at: "not a time" }, "implement", []]) {
    const kv = memoryKv();
    await kv.put(KEY, seed as never);
    assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT)), { status: "claimed", retried: true }, JSON.stringify(seed));
    const legacy = memoryKv();
    await legacy.put(KEY, seed as never);
    assert.deepEqual(await claimImplementation(legacy, "TLSSN-42", { now: CLAIMED_AT, run: claimRunFor({ mode: "legacy" }) }), { status: "in_flight" }, `legacy keeps the frozen reading: ${JSON.stringify(seed)}`);
  }
});

test("a released claim can be taken again, and a failing store neither claims nor throws", async () => {
  const kv = memoryKv();
  await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT));
  await releaseImplementation(kv, { issueKey: "TLSSN-42", run: claimRunFor() });
  assert.equal(kv.entries.has(KEY), false);
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:05:00.000Z"))), { status: "claimed", retried: false });

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
  assert.deepEqual(await claimImplementation(broken, "TLSSN-42", at(CLAIMED_AT)), { status: "unavailable" });
  await releaseImplementation(broken, { issueKey: "TLSSN-42", run: claimRunFor() });
});

test("a pending claim whose launch was sent as a July cloud turn waits the longer sent grace, then is taken over", async () => {
  const kv = memoryKv();
  await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT));
  const sentAt = new Date("2026-09-23T00:02:30.000Z");
  assert.equal(await markLaunchSent(kv, { issueKey: "TLSSN-42", run: claimRunFor(), sentAt }), "marked");
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:00:00.000Z", owner: OWNER, sentAt: "2026-09-23T00:02:30.000Z" });
  // Past LAUNCH_GRACE_MS from `at`, still in flight: the binding may take hosted admission's ten minutes.
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:03:00.001Z"))), { status: "in_flight" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date(sentAt.getTime() + LAUNCH_SENT_GRACE_MS))), { status: "in_flight" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date(sentAt.getTime() + LAUNCH_SENT_GRACE_MS + 1))), { status: "claimed", retried: true });
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: new Date(sentAt.getTime() + LAUNCH_SENT_GRACE_MS + 1).toISOString(), owner: OWNER }, "the takeover's claim carries no sentAt");
  // Hosted admission's ten-minute hold, then the launch's own deadline and late wait for the create inside the turn: 11.5 minutes.
  assert.equal(HOSTED_PENDING_SEND_TTL_MS, 10 * 60_000);
  assert.equal(LAUNCH_SENT_GRACE_MS, HOSTED_PENDING_SEND_TTL_MS + LAUNCH_TIMEOUT_MS + LAUNCH_LATE_WAIT_MS);
  assert.equal(LAUNCH_SENT_GRACE_MS, 11.5 * 60_000);
});

test("the bound-agent record is written and read back whole, and anything else at its key reads as none", async () => {
  const kv = memoryKv();
  assert.equal(await readBoundAgent(kv, "TLSSN-42"), undefined);
  const record = { agentId: "bc-july-1", url: "https://cursor.com/agents/bc-july-1", changelogId: "10042", at: "2026-09-23T00:00:00.000Z", boundAt: "2026-09-23T00:04:00.000Z" };
  assert.equal(await noteBoundAgent(kv, { issueKey: "TLSSN-42", record }), "noted");
  assert.deepEqual(kv.entries.get("implement-agent/TLSSN-42"), record);
  assert.deepEqual(await readBoundAgent(kv, "TLSSN-42"), record);
  assert.equal(parseBoundAgent({ ...record, url: "" }), undefined);
  assert.equal(parseBoundAgent({ agentId: "bc-july-1" }), undefined);
  assert.equal(parseBoundAgent("bc-july-1"), undefined);
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
  assert.equal(await noteBoundAgent(broken, { issueKey: "TLSSN-42", record }), "unavailable");
  assert.equal(await readBoundAgent(broken, "TLSSN-42"), undefined);
});

test("the agent.bound record lands over this run's sent claim, and not over a takeover's", async () => {
  const kv = memoryKv();
  await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT));
  await markLaunchSent(kv, { issueKey: "TLSSN-42", run: claimRunFor(), sentAt: new Date("2026-09-23T00:00:02.000Z") });
  assert.equal(await recordLaunch(kv, { issueKey: "TLSSN-42", claim: { ...LAUNCHED, commented: false, moved: false }, run: claimRunFor(), stage: "launch" }), "recorded");
  assert.deepEqual(kv.entries.get(KEY), { ...LAUNCHED, commented: false, moved: false });

  const taken = memoryKv();
  await claimImplementation(taken, "TLSSN-42", at(CLAIMED_AT));
  await markLaunchSent(taken, { issueKey: "TLSSN-42", run: claimRunFor(), sentAt: new Date("2026-09-23T00:00:02.000Z") });
  await claimImplementation(taken, "TLSSN-42", { now: new Date("2026-09-23T00:14:00.000Z"), run: claimRunFor({ owner: "owner-2" }) });
  assert.equal(await recordLaunch(taken, { issueKey: "TLSSN-42", claim: LAUNCHED, run: claimRunFor(), stage: "launch" }), "superseded");
  assert.deepEqual(taken.entries.get(KEY), { state: "pending", at: "2026-09-23T00:14:00.000Z", owner: "owner-2" });
});

test("a replay of the delivery that sent the turn meets its claim as in flight; before the send it takes it over", async () => {
  const kv = memoryKv();
  const run = claimRunFor();
  const same = { now: new Date("2026-09-23T00:00:01.000Z"), run, deliveryId: "dlv-1" };
  await claimImplementation(kv, "TLSSN-42", { now: CLAIMED_AT, run, deliveryId: "dlv-1" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", same), { status: "claimed", retried: true }, "its own claim, launch never sent: taken over");
  assert.equal(await markLaunchSent(kv, { issueKey: "TLSSN-42", run, sentAt: new Date("2026-09-23T00:00:02.000Z") }), "marked");
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", { ...same, now: new Date("2026-09-23T00:00:03.000Z") }), { status: "in_flight" }, "sent: the send is the launch");
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", { ...same, now: new Date("2026-09-23T00:00:03.000Z"), deliveryId: "dlv-2" }), { status: "in_flight" });
});

test("markLaunchSent stamps only this run's pending claim: a rival's or a launched one is lost, a failing store is unavailable", async () => {
  const kv = memoryKv();
  const sentAt = new Date("2026-09-23T00:00:02.000Z");
  assert.equal(await markLaunchSent(kv, { issueKey: "TLSSN-42", run: claimRunFor(), sentAt }), "lost", "no claim at all");
  await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT));
  assert.equal(await markLaunchSent(kv, { issueKey: "TLSSN-42", run: claimRunFor({ owner: "owner-2" }), sentAt }), "lost");
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:00:00.000Z", owner: OWNER });
  await recordImplementation(kv, "TLSSN-42", LAUNCHED);
  assert.equal(await markLaunchSent(kv, { issueKey: "TLSSN-42", run: claimRunFor(), sentAt }), "lost");
  assert.deepEqual(kv.entries.get(KEY), LAUNCHED);

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
  assert.equal(await markLaunchSent(broken, { issueKey: "TLSSN-42", run: claimRunFor(), sentAt }), "unavailable");
  assert.equal(await markLaunchSent(broken, { issueKey: "TLSSN-42", run: claimRunFor({ mode: "legacy" }), sentAt }), "unavailable");
});

test("FACTORY_CLAIM_MODE=legacy stamps whatever pending claim is there and keeps its frozen window", async () => {
  const kv = memoryKv();
  const legacy = (now: Date) => ({ now, run: claimRunFor({ mode: "legacy" }) });
  await claimImplementation(kv, "TLSSN-42", legacy(CLAIMED_AT));
  assert.equal(await markLaunchSent(kv, { issueKey: "TLSSN-42", run: claimRunFor({ mode: "legacy" }), sentAt: new Date("2026-09-23T00:00:02.000Z") }), "marked");
  assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:00:00.000Z", sentAt: "2026-09-23T00:00:02.000Z" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", legacy(new Date("2026-09-23T00:10:00.000Z"))), { status: "in_flight" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", legacy(new Date("2026-09-23T00:10:00.001Z"))), { status: "claimed", retried: true });
  await recordImplementation(kv, "TLSSN-42", LAUNCHED);
  assert.equal(await markLaunchSent(kv, { issueKey: "TLSSN-42", run: claimRunFor({ mode: "legacy" }), sentAt: new Date() }), "lost");
});

test("parseClaim reads a pending or a launched claim and nothing else", () => {
  assert.deepEqual(parseClaim({ state: "pending", at: "x" }), { state: "pending", at: "x" });
  assert.deepEqual(parseClaim({ state: "pending", at: "x", deliveryId: "dlv-1", sentAt: "y" }), { state: "pending", at: "x", deliveryId: "dlv-1", sentAt: "y" });
  assert.deepEqual(parseClaim({ state: "pending", at: "x", sentAt: "" }), { state: "pending", at: "x" });
  assert.deepEqual(parseClaim({ state: "launched", at: "x", agentId: "bc-1", url: "https://cursor.com/agents/bc-1" }), {
    state: "launched",
    at: "x",
    agentId: "bc-1",
    url: "https://cursor.com/agents/bc-1",
    commented: false,
    moved: false,
  });
  assert.deepEqual(parseClaim({ state: "launched", at: "x", agentId: "bc-1", url: "https://cursor.com/agents/bc-1", commented: true }), {
    state: "launched",
    at: "x",
    agentId: "bc-1",
    url: "https://cursor.com/agents/bc-1",
    commented: true,
    moved: false,
  });
  assert.equal(parseClaim({ at: "x", agentId: "bc-1", url: "https://cursor.com/agents/bc-1" }), undefined);
  assert.equal(parseClaim({ state: "launched", at: "x", agentId: "bc-1", url: "" }), undefined);
  assert.equal(parseClaim({ state: "pending" }), undefined);
  assert.equal(parseClaim(undefined), undefined);
});

/** A CAS kv whose `getWithVersion` lets another delivery write `rival` right after it reads. */
function losingTakeover(kv: HostKvApi, rival: Record<string, string>): HostKvCasApi {
  const store = kv as unknown as HostKvCasApi;
  return {
    ...store,
    getWithVersion: async (key) => {
      const seen = await store.getWithVersion(key);
      await kv.put(key, rival);
      return seen;
    },
  };
}

// Hosted host.kv (July 0.2.13) has no compare-and-set, so only these tests reach the putIfAbsent / putIfVersion branches in claim.ts.
describe("CAS path (ask 11)", () => {
  test("claimImplementation takes an absent key with putIfAbsent, holds a young pending claim, and takes a stale one with putIfVersion", async () => {
    const kv = memoryKv({ cas: true });
    assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(CLAIMED_AT)), { status: "claimed", retried: false });
    assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:03:00.000Z"))), { status: "in_flight" });
    assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:03:00.001Z"))), { status: "claimed", retried: true });
    assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:03:00.001Z", owner: OWNER });
    assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-23T00:03:00.002Z"))), { status: "in_flight" }, "a claim just taken over is in flight to the next delivery");
    await recordImplementation(kv, "TLSSN-42", LAUNCHED);
    assert.deepEqual(await claimImplementation(kv, "TLSSN-42", at(new Date("2026-09-24T00:00:00.000Z"))), { status: "launched", claim: LAUNCHED });
  });

  test("a claimImplementation takeover that loses putIfVersion to another delivery does not claim", async () => {
    const kv = memoryKv({ cas: true });
    await kv.put(KEY, { state: "pending", at: "2026-09-23T00:00:00.000Z" });
    const racing = losingTakeover(kv, { state: "pending", at: "2026-09-23T00:10:00.000Z" });
    assert.deepEqual(await claimImplementation(racing, "TLSSN-42", at(new Date("2026-09-23T00:10:00.001Z"))), { status: "in_flight" });
    assert.deepEqual(kv.entries.get(KEY), { state: "pending", at: "2026-09-23T00:10:00.000Z" });
  });

  test("claimStatusMove takes an absent key, reports a moved claim, and takes a stale pending one; a lost takeover is in flight", async () => {
    const key = prStatusClaimKey({ issueKey: "TLSSN-42", stage: "in_review", pr: "cursor-demo-lab/marsbank#13" });
    const kv = memoryKv({ cas: true });
    assert.deepEqual(await claimStatusMove(kv, key, at(CLAIMED_AT)), { status: "claimed" });
    assert.deepEqual(await claimStatusMove(kv, key, at(new Date("2026-09-23T00:10:00.000Z"))), { status: "in_flight" });
    assert.deepEqual(await claimStatusMove(kv, key, at(new Date("2026-09-23T00:10:00.001Z"))), { status: "claimed" });
    await kv.put(key, { state: "moved", at: "2026-09-23T00:10:00.001Z", outcome: "transitioned" });
    assert.deepEqual(await claimStatusMove(kv, key, at(new Date("2026-09-24T00:00:00.000Z"))), { status: "moved", claim: { at: "2026-09-23T00:10:00.001Z", outcome: "transitioned" } });

    await kv.put(key, { state: "pending", at: "2026-09-23T00:00:00.000Z" });
    const racing = losingTakeover(kv, { state: "pending", at: "2026-09-23T00:10:00.000Z" });
    assert.deepEqual(await claimStatusMove(racing, key, at(new Date("2026-09-23T00:10:00.001Z"))), { status: "in_flight" });
  });

  test("takeLaunchFailureNotice is true once per approval with putIfAbsent, and true again after it is returned", async () => {
    const kv = memoryKv({ cas: true });
    const notice = { issueKey: "TLSSN-42", changelogId: "10041", now: CLAIMED_AT };
    assert.equal(await takeLaunchFailureNotice(kv, notice), true);
    assert.equal(await takeLaunchFailureNotice(kv, notice), false);
    assert.equal(await takeLaunchFailureNotice(kv, { ...notice, changelogId: "10042" }), true);
    await returnLaunchFailureNotice(kv, notice);
    assert.equal(await takeLaunchFailureNotice(kv, notice), true);
  });
});

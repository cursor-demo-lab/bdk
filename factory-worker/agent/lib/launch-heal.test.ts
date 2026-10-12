import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReminderHostApi } from "@cursor/july";
import { abandonPendingClaim, LAUNCH_GRACE_MS } from "./claim.js";
import { approvedBody } from "./fixtures.js";
import { createHandler, type HandlerDeps } from "./handle.js";
import { backstopImplementPrSweep } from "./implement-pr-sweep.js";
import { healLaunch, tendLaunchWatches } from "./launch-heal.js";
import { LAUNCH_HEAL_FIRST_MS, LAUNCH_HEAL_MAX_AGE_MS, LAUNCH_HEAL_MAX_ATTEMPTS, LAUNCH_HEAL_RETRY_MS, noteLaunchAttempt, parseLaunchWatchArgs } from "./launch-watch.js";
import { findLaunchedAgent, type ListAgents } from "./launch.js";
import { createOpsFunnel } from "./ops-funnel.js";
import { backgroundWork, ENV, fakeCreateAgent, fakeTracker, memoryKv, PLAN_COMMENT, signedRequest, tick, TRIAGE_COMMENT, type FakeLauncher, type FakeTracker, type MemoryKv } from "./testing/fakes.js";
import { fakeGitHub, fakeReminders } from "./testing/github.js";

// A verified approval whose launch is lost after the claim must not wait for
// a person's `retry`. TLSSN-51 (2026-09-30): the desk moved the ticket to
// Approved, the worker took `implement/TLSSN-51` and then nothing: no agent,
// no Implementing:, no Launch failed:, and every later delivery met the
// pending claim as in flight until it was ten minutes old.

const KEY = "TLSSN-42";
const T0 = new Date("2026-09-23T00:00:00.000Z");
const MIN = 60_000;
const CLAIM = `implement/${KEY}`;
const WATCH = `implement-launch/${KEY}`;
const INDEX = "implement-launch/index";

type World = { clock: { ms: number }; kv: MemoryKv; tracker: FakeTracker; lines: string[]; deps: (launcher: FakeLauncher) => HandlerDeps };

function world(options: { tracker?: FakeTracker; kv?: MemoryKv } = {}): World {
  const clock = { ms: T0.getTime() };
  const kv = options.kv ?? memoryKv();
  const tracker = options.tracker ?? fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const lines: string[] = [];
  const deps = (launcher: FakeLauncher): HandlerDeps => ({
    kv,
    mcp: tracker.mcp,
    createAgent: launcher.createAgent,
    env: ENV,
    now: () => new Date(clock.ms),
    log: (line) => lines.push(line),
    sleep: tick,
  });
  return { clock, kv, tracker, lines, deps };
}

/** An `Agent.create` that never answers, as the stalled create or the parked pod did. */
function stalledLauncher(): FakeLauncher {
  const launcher: FakeLauncher = {
    calls: [],
    sent: [],
    closed: 0,
    createAgent: async (options) => {
      launcher.calls.push(options);
      return new Promise(() => {});
    },
  };
  return launcher;
}

/** The delivery whose launch is lost: its `waitUntil` work never finishes and the process is gone. */
async function lostDelivery(w: World, extra: Partial<HandlerDeps> = {}) {
  const handle = createHandler({ ...w.deps(stalledLauncher()), launchTimeoutMs: 24 * 60 * MIN, ...extra });
  const dropped: Promise<unknown>[] = [];
  const response = await handle(signedRequest(approvedBody()), { waitUntil: (promise) => void dropped.push(promise) });
  return { status: response.status, body: (await response.json()) as unknown };
}

function comments(tracker: FakeTracker): string[] {
  return tracker.calls.filter((call) => call.tool === "addCommentToJiraIssue").map((call) => String(call.args["commentBody"]));
}

test("TLSSN-51: a launch lost after its claim is relaunched by the watch after the grace, once, with no person's retry", async () => {
  const w = world();
  const reminders = fakeReminders();
  const lost = await lostDelivery(w, { reminders: reminders.api });
  assert.equal(lost.status, 202);
  assert.equal((w.kv.entries.get(CLAIM) as { state?: string }).state, "pending", "the claim is taken and never recorded");
  assert.deepEqual(w.kv.entries.get(WATCH), { at: T0.toISOString(), changelogId: "10042", title: "Retry CSV export on empty filter", attempts: 0, reminderId: "rem-1", dueAt: new Date(T0.getTime() + LAUNCH_HEAL_FIRST_MS).toISOString() });
  assert.deepEqual(w.kv.entries.get(INDEX), [KEY]);
  assert.deepEqual(
    reminders.created.map((each) => ({ handler: each.handler, delay: each.delay, args: each.args })),
    [{ handler: "implement_launch", delay: "4m", args: { issueKey: KEY, at: T0.toISOString() } }],
    "armed before the launch, so the lost process still has its wake"
  );
  assert.deepEqual(comments(w.tracker), [], "the lost delivery leaves no Jira trace of its own");

  const launcher = fakeCreateAgent({ agentId: "bc-healed" });
  w.clock.ms = T0.getTime() + 2 * MIN;
  assert.deepEqual(await healLaunch(w.deps(launcher), { issueKey: KEY, reminderId: "rem-1" }), { issueKey: KEY, outcome: "not_due", rescheduleMs: MIN });
  assert.equal(launcher.calls.length, 0, "inside the grace the claim may still be in flight");
  assert.equal((w.kv.entries.get(WATCH) as Record<string, unknown>)["dueAt"], new Date(T0.getTime() + 3 * MIN).toISOString(), "each reschedule records when it is next due");

  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const healed = await healLaunch({ ...w.deps(launcher), reminders: reminders.api }, { issueKey: KEY, reminderId: "rem-1" });
  assert.deepEqual(healed, { issueKey: KEY, outcome: "launched", attempt: 1 });
  assert.deepEqual(launcher.calls.map((call) => call.idempotencyKey), [CLAIM], "the same idempotency key as the lost launch");
  assert.deepEqual(comments(w.tracker), [
    "Implementing: https://cursor.com/agents/bc-healed\nRelaunched by factory-worker: the first launch for this approval recorded no agent (watch attempt 1).",
  ]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.deepEqual(w.kv.entries.get(CLAIM), { state: "launched", at: new Date(T0.getTime() + LAUNCH_HEAL_FIRST_MS).toISOString(), agentId: "bc-healed", url: "https://cursor.com/agents/bc-healed", commented: true, moved: true });
  assert.equal(w.kv.entries.has(WATCH), false, "the watch is closed");
  assert.deepEqual(reminders.cancelled, ["rem-1"]);

  assert.deepEqual(await healLaunch(w.deps(launcher), { issueKey: KEY, reminderId: "rem-1" }), { issueKey: KEY, outcome: "not_watched" });
  assert.equal(launcher.calls.length, 1, "one agent");
});

test("a person's retry after the grace takes the lost claim over too, and the watch then finds the launch done", async () => {
  const w = world();
  await lostDelivery(w);
  w.clock.ms = T0.getTime() + 3 * MIN + 1;
  const launcher = fakeCreateAgent();
  const handle = createHandler(w.deps(launcher));
  const background = backgroundWork();
  const retry = await handle(signedRequest(approvedBody({ changelogId: "10099" })), background);
  assert.deepEqual(await retry.json(), { ok: true, launching: true, issueKey: KEY, retried: true });
  await background.settle();
  assert.equal(launcher.calls.length, 1);
  assert.equal(w.kv.entries.has(WATCH), false);
  assert.deepEqual(await healLaunch(w.deps(launcher), { issueKey: KEY }), { issueKey: KEY, outcome: "not_watched" });
});

test("a retry inside the grace is in flight and says so on the ticket once, then the watch relaunches", async () => {
  const w = world();
  await lostDelivery(w);
  w.clock.ms = T0.getTime() + MIN;
  const handle = createHandler(w.deps(fakeCreateAgent()));
  const background = backgroundWork();
  for (const changelogId of ["10099", "10099"]) {
    const early = await handle(signedRequest(approvedBody({ changelogId })), background);
    assert.deepEqual(await early.json(), { ok: true, duplicate: true, issueKey: KEY, inFlight: true });
  }
  assert.deepEqual(comments(w.tracker), [
    "Launch pending: TLSSN-42: another delivery of this approval holds the launch claim. No retry timer could be set yet; factory-worker sets one the next time it handles an Approved move or a pull request. If no Implementing: comment follows within 4 minutes, move the card to Approved again.",
  ]);

  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + MIN;
  const launcher = fakeCreateAgent();
  assert.deepEqual(await healLaunch(w.deps(launcher), { issueKey: KEY }), { issueKey: KEY, outcome: "launched", attempt: 1 });
  assert.equal(launcher.calls.length, 1);
  assert.deepEqual(await tendLaunchWatches(w.deps(launcher)), []);
  assert.deepEqual(w.kv.entries.get(INDEX), [], "the tend prunes a closed watch from the index");
});

test("a claim whose settle re-read lags its put is unconfirmed: a Launch pending: line, no launch, and the watch relaunches it after the grace", async () => {
  const w = world();
  let lagging = false;
  const kv: MemoryKv = {
    ...w.kv,
    get: async (key) => (lagging && key === CLAIM ? undefined : w.kv.get(key)),
  };
  const launcher = fakeCreateAgent();
  const handle = createHandler({
    ...w.deps(launcher),
    kv,
    sleep: async () => {
      lagging = true;
    },
  });
  const background = backgroundWork();
  const response = await handle(signedRequest(approvedBody()), background);
  lagging = false;
  assert.deepEqual(await response.json(), { ok: true, duplicate: true, issueKey: KEY, unconfirmed: true });
  assert.deepEqual(await background.settle(), []);
  assert.equal(launcher.calls.length, 0, "an unconfirmed claim never launches: a rival may hold it");
  assert.equal((w.kv.entries.get(CLAIM) as { state?: string }).state, "pending", "its own put landed");
  assert.deepEqual(comments(w.tracker), [
    "Launch pending: TLSSN-42: the launch claim was written but could not be read back yet. No retry timer could be set yet; factory-worker sets one the next time it handles an Approved move or a pull request. If no Implementing: comment follows within 4 minutes, move the card to Approved again.",
  ]);

  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  assert.equal((await healLaunch(w.deps(launcher), { issueKey: KEY })).outcome, "launched");
  assert.equal(launcher.calls.length, 1);
});

test("a watch whose ticket left Approved closes without a launch", async () => {
  const w = world();
  await lostDelivery(w);
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const planned = fakeTracker({ comments: [PLAN_COMMENT], status: "Planned" });
  const launcher = fakeCreateAgent();
  const result = await healLaunch({ ...w.deps(launcher), mcp: planned.mcp }, { issueKey: KEY });
  assert.deepEqual(result, { issueKey: KEY, outcome: "not_approved", attempt: 1 });
  assert.equal(launcher.calls.length, 0);
  assert.equal(w.kv.entries.has(WATCH), false);
  assert.deepEqual(comments(planned), []);
});

test("a launched claim whose Implementing: comment was lost is repaired by the watch, never relaunched", async () => {
  const w = world({ tracker: fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT], commentFailures: 1 }) });
  const launcher = fakeCreateAgent();
  const handle = createHandler(w.deps(launcher));
  const background = backgroundWork();
  await handle(signedRequest(approvedBody()), background);
  await background.settle();
  assert.equal((w.kv.entries.get(CLAIM) as { commented?: boolean }).commented, false);
  assert.ok(w.kv.entries.has(WATCH), "a launch short of its comment and move stays watched");

  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  assert.equal((await healLaunch(w.deps(launcher), { issueKey: KEY })).outcome, "duplicate");
  assert.equal(launcher.calls.length, 1);
  assert.deepEqual(comments(w.tracker), ["Implementing: https://cursor.com/agents/bc-test-1", "Implementing: https://cursor.com/agents/bc-test-1"]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.equal(w.kv.entries.has(WATCH), false);
});

test("a launch that fails records Launch failed: and closes the watch, so the heal never retries a failure a person was told about", async () => {
  const w = world();
  const launcher = fakeCreateAgent({ fail: () => new Error("401 Unauthorized") });
  const handle = createHandler(w.deps(launcher));
  const background = backgroundWork();
  await handle(signedRequest(approvedBody()), background);
  await background.settle();
  assert.deepEqual(comments(w.tracker), ["Launch failed: unauthorized. Moving the card to Approved again retries."]);
  assert.equal(w.kv.entries.has(CLAIM), false, "released");
  assert.equal(w.kv.entries.has(WATCH), false);
});

/**
 * `Agent.create` against a fake agents API. `atServer: "before"` registers the
 * agent before the answer is held back (the POST landed, its reply stalled),
 * `"after"` only once released (the POST itself stalled). `listAgents` is
 * `Agent.list` over what the server has.
 */
function serverLauncher(input: { now: () => number; hold?: "before" | "after"; failList?: boolean; rejectHeld?: boolean }) {
  const agents: { agentId: string; name: string; createdAt: number; lastModified: number }[] = [];
  const calls: string[] = [];
  const releases: (() => void)[] = [];
  const retired: string[] = [];
  const createAgent: FakeLauncher["createAgent"] = async (options) => {
    calls.push(String(options.idempotencyKey));
    const at = input.now();
    // An agent's first run keeps it modified a little after it was created.
    const agent = { agentId: `bc-${calls.length}`, name: String(options.name), createdAt: at, lastModified: at + 1_000 };
    const held = input.hold !== undefined && calls.length === 1;
    if (!held || input.hold === "before") agents.push(agent);
    if (held) {
      await new Promise<void>((resolve) => releases.push(resolve));
      if (input.rejectHeld === true) throw Object.assign(new Error("agents API 500"), { status: 500 });
      if (input.hold === "after") agents.push(agent);
    }
    return { agentId: agent.agentId, send: async () => undefined, close: () => {} };
  };
  // GET /v1/agents documents no order; this one answers in update order, newest first, 50 a page.
  const listAgents: ListAgents = async (options) => {
    if (input.failList === true) throw Object.assign(new Error("agents API 503"), { status: 503 });
    const ordered = [...agents].sort((a, b) => b.lastModified - a.lastModified);
    const start = Number(options.cursor ?? "0");
    const items = ordered.slice(start, start + options.limit);
    return { items, ...(start + options.limit < ordered.length ? { nextCursor: String(start + options.limit) } : {}) };
  };
  const retireAgent = async (agentId: string) => {
    retired.push(agentId);
  };
  return { createAgent, listAgents, retireAgent, calls, agents, retired, release: () => releases.splice(0).forEach((resolve) => resolve()) };
}

/** The deadline's timer is unref'd, as a served process keeps its own loop alive; these tests must. */
async function keepingAlive<T>(work: () => Promise<T>): Promise<T> {
  const alive = setInterval(() => {}, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(alive);
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function recorded(w: World): { state?: string; agentId?: string; commented?: boolean; moved?: boolean } {
  return w.kv.entries.get(CLAIM) as { state?: string; agentId?: string; commented?: boolean; moved?: boolean };
}

function implementing(tracker: FakeTracker): string[] {
  return comments(tracker).filter((body) => body.startsWith("Implementing:"));
}

test("M1: a create that answers after the 30 s deadline but within the late wait is recorded by its own delivery: one agent, one Implementing:", async () => {
  const w = world();
  const server = serverLauncher({ now: () => w.clock.ms, hold: "before" });
  const handle = createHandler({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, launchTimeoutMs: 5, launchLateWaitMs: 5_000 });
  const background = backgroundWork();
  const [settled] = await keepingAlive(async () => {
    await handle(signedRequest(approvedBody()), background);
    setTimeout(() => server.release(), 30);
    return background.settle();
  });
  assert.equal((settled as { value?: { launched?: boolean } }).value?.launched, true);
  assert.deepEqual(recorded(w), { state: "launched", at: T0.toISOString(), agentId: "bc-1", url: "https://cursor.com/agents/bc-1", commented: true, moved: true });
  assert.deepEqual(implementing(w.tracker), ["Implementing: https://cursor.com/agents/bc-1"]);

  const retry = await handle(signedRequest(approvedBody({ changelogId: "10099" })), backgroundWork());
  assert.equal(((await retry.json()) as { duplicate?: boolean }).duplicate, true);
  assert.deepEqual(server.calls, [CLAIM], "one create");
  assert.ok(!comments(w.tracker).some((body) => body.startsWith("Launch failed:")), "a timeout is never announced as a failure");
});

test("M1: a create that answers after the late wait keeps the claim pending with no failure, and the late answer is still recorded once", async () => {
  const w = world();
  const server = serverLauncher({ now: () => w.clock.ms, hold: "before" });
  const handle = createHandler({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, launchTimeoutMs: 5, launchLateWaitMs: 5 });
  const background = backgroundWork();
  const [settled] = await keepingAlive(async () => {
    await handle(signedRequest(approvedBody()), background);
    return background.settle();
  });
  assert.deepEqual((settled as { value?: unknown }).value, { ok: true, launched: false, issueKey: KEY, reason: "launch_timeout" });
  assert.equal(recorded(w).state, "pending", "the claim is kept, not released");
  assert.ok(w.kv.entries.has(WATCH), "and the watch stays open");
  assert.deepEqual(comments(w.tracker), [], "no Launch failed: for a create that may still answer");

  server.release();
  await settle();
  assert.equal(recorded(w).agentId, "bc-1");
  assert.deepEqual(implementing(w.tracker), ["Implementing: https://cursor.com/agents/bc-1"]);
  const retry = await handle(signedRequest(approvedBody({ changelogId: "10099" })), backgroundWork());
  assert.equal(((await retry.json()) as { duplicate?: boolean }).duplicate, true, "a re-drag finds the recorded launch");
  assert.deepEqual(server.calls, [CLAIM], "one create");
});

test("M2: a thawed first launch versus the heal, the first create already at the server: the heal adopts that agent, and the thawed launch records and comments nothing", async () => {
  const w = world();
  const server = serverLauncher({ now: () => w.clock.ms, hold: "before" });
  const first = createHandler({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, launchTimeoutMs: 5, launchLateWaitMs: 5 });
  await keepingAlive(async () => {
    const background = backgroundWork();
    await first(signedRequest(approvedBody()), background);
    await background.settle();
  });

  // The pod is parked; four minutes on, the watch's reminder fires in another process.
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const healed = await healLaunch({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents }, { issueKey: KEY });
  assert.deepEqual(healed, { issueKey: KEY, outcome: "launched", attempt: 1 });
  assert.deepEqual(server.calls, [CLAIM], "adopted, not created again");
  assert.deepEqual(implementing(w.tracker), [
    "Implementing: https://cursor.com/agents/bc-1\nRecovered by factory-worker: an earlier launch for this approval started this agent but never recorded it, so no second agent was started.",
  ]);

  // The first launch thaws and its create answers.
  server.release();
  await settle();
  assert.deepEqual(recorded(w), { state: "launched", at: new Date(T0.getTime() + LAUNCH_HEAL_FIRST_MS).toISOString(), agentId: "bc-1", url: "https://cursor.com/agents/bc-1", commented: true, moved: true });
  assert.equal(implementing(w.tracker).length, 1, "one Implementing: comment");
  assert.equal(w.tracker.status(), "In Progress");
});

test("M2: a thawed first launch versus the heal, the first create not yet at the server: two creates are unavoidable, but one agent is recorded and one Implementing: posted", async () => {
  const w = world();
  const server = serverLauncher({ now: () => w.clock.ms, hold: "after" });
  const first = createHandler({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, launchTimeoutMs: 5, launchLateWaitMs: 5 });
  await keepingAlive(async () => {
    const background = backgroundWork();
    await first(signedRequest(approvedBody()), background);
    await background.settle();
  });
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const healed = await healLaunch({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents }, { issueKey: KEY });
  assert.equal(healed.outcome, "launched");
  assert.equal(recorded(w).agentId, "bc-2");

  server.release();
  await settle();
  assert.equal(recorded(w).agentId, "bc-2", "the thawed launch's owner-checked record is refused");
  assert.deepEqual(implementing(w.tracker), [
    "Implementing: https://cursor.com/agents/bc-2\nRelaunched by factory-worker: the first launch for this approval recorded no agent (watch attempt 1).",
  ]);
  const superseded = w.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["outcome"] === "superseded");
  assert.deepEqual(superseded.map((line) => line["agentId"]), ["bc-1"]);
});

test("M2: a takeover whose agent check cannot answer launches nothing and keeps the ticket watched", async () => {
  const w = world();
  await lostDelivery(w);
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const server = serverLauncher({ now: () => w.clock.ms, failList: true });
  const healed = await healLaunch({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents }, { issueKey: KEY });
  assert.equal(healed.outcome, "agent_unverified");
  assert.equal(healed.rescheduleMs, LAUNCH_HEAL_RETRY_MS);
  assert.deepEqual(server.calls, [], "no positive check, no create");
  assert.equal(recorded(w).state, "pending");
  assert.ok(w.kv.entries.has(WATCH));
});

test("M2: a lost launch that posted its Implementing: comment but never recorded it is adopted from the ticket, with no second comment", async () => {
  const w = world({ tracker: fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT, "Implementing: https://cursor.com/agents/bc-lost"] }) });
  await lostDelivery(w);
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const launcher = fakeCreateAgent();
  const healed = await healLaunch(w.deps(launcher), { issueKey: KEY });
  assert.equal(healed.outcome, "launched");
  assert.equal(launcher.calls.length, 0);
  assert.equal(recorded(w).agentId, "bc-lost");
  assert.deepEqual(comments(w.tracker), [], "the comment is already on the ticket");
  assert.equal(w.tracker.status(), "In Progress");
});

test("M2/L6: the backstop runs the implement PR sweep before tending launch watches", async () => {
  const w = world();
  const order: string[] = [];
  const gh = fakeGitHub();
  await w.kv.put("implement-launch/index", [KEY]);
  await w.kv.put("implement-pr-watch/index", ["TLSSN-7"]);
  const result = await backstopImplementPrSweep(
    { kv: w.kv, mcp: w.tracker.mcp, env: ENV, now: () => new Date(w.clock.ms), github: gh.github, readRun: async () => undefined, createAgent: fakeCreateAgent().createAgent },
    {
      sweep: async () => {
        order.push("pr");
        return [];
      },
      tend: async () => {
        order.push("tend");
        return [];
      },
    }
  );
  assert.deepEqual(order, ["pr", "tend"]);
  assert.deepEqual(result, { swept: true, fires: [], tended: [] });
});

test("L2: a watch that gives up on a launched agent whose move keeps failing announces no launch failure", async () => {
  const w = world({ tracker: fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT], transitionFailures: 100 }) });
  const handle = createHandler(w.deps(fakeCreateAgent()));
  const background = backgroundWork();
  await handle(signedRequest(approvedBody()), background);
  await background.settle();
  assert.equal(recorded(w).moved, false);
  for (let attempt = 0; attempt <= LAUNCH_HEAL_MAX_ATTEMPTS; attempt += 1) {
    w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + attempt * LAUNCH_HEAL_RETRY_MS;
    await healLaunch(w.deps(fakeCreateAgent()), { issueKey: KEY });
  }
  assert.equal(w.kv.entries.has(WATCH), false, "it gave up");
  assert.ok(!comments(w.tracker).some((body) => body.startsWith("Launch failed:")), "an agent runs: no Launch failed:");
});

test("L3: the reminder stops rescheduling 30 minutes after the approval, by the approval time in its own args, even when kv cannot count attempts", async () => {
  const w = world();
  const down: MemoryKv = {
    ...w.kv,
    get: async () => {
      throw Object.assign(new Error("kv down"), { status: 503 });
    },
  };
  const orphan = { changelogId: "10042", title: "t", at: T0.toISOString() };
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const early = await healLaunch({ ...w.deps(fakeCreateAgent()), kv: down }, { issueKey: KEY, approvedAt: T0.toISOString(), orphan });
  assert.equal(early.rescheduleMs, LAUNCH_HEAL_RETRY_MS);
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_MAX_AGE_MS;
  const late = await healLaunch({ ...w.deps(fakeCreateAgent()), kv: down }, { issueKey: KEY, approvedAt: T0.toISOString(), orphan });
  assert.deepEqual(late, { issueKey: KEY, outcome: "expired" });
});

test("L1: a refusal for a missing plan whose comment fails stays watched instead of ending with no trace", async () => {
  const w = world({ tracker: fakeTracker({ comments: [TRIAGE_COMMENT], commentFailures: 1 }) });
  const reminders = fakeReminders();
  const handle = createHandler({ ...w.deps(fakeCreateAgent()), reminders: reminders.api });
  const response = await handle(signedRequest(approvedBody()), backgroundWork());
  assert.deepEqual(await response.json(), { ok: true, launched: false, reason: "no_brief", watched: true });
  assert.ok(w.kv.entries.has(WATCH));
  assert.deepEqual(reminders.created.map((each) => each.handler), ["implement_launch"]);

  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  assert.equal((await healLaunch(w.deps(fakeCreateAgent()), { issueKey: KEY })).outcome, "no_brief");
  assert.deepEqual(
    w.tracker.comments.filter((body) => body.startsWith("Approved without a plan")),
    ["Approved without a plan on the ticket; nothing was launched. Move TLSSN-42 back to Triaged in Jira to plan it, then approve the new plan."],
    "the heal said it once the connector took the comment"
  );
  assert.equal(w.kv.entries.has(WATCH), false);
});

test("a watch that cannot launch gives up after its attempts with one Launch failed: naming why", async () => {
  const w = world();
  await lostDelivery(w);
  // The claim's put now always fails: every heal is claim_unavailable.
  const kv: MemoryKv = {
    ...w.kv,
    put: async (key, value) => {
      if (key === CLAIM) throw Object.assign(new Error("kv down"), { status: 503 });
      await w.kv.put(key, value);
    },
  };
  const launcher = fakeCreateAgent();
  const deps = { ...w.deps(launcher), kv };
  const outcomes: string[] = [];
  for (let attempt = 0; attempt <= LAUNCH_HEAL_MAX_ATTEMPTS; attempt += 1) {
    w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + attempt * LAUNCH_HEAL_RETRY_MS;
    const result = await healLaunch(deps, { issueKey: KEY });
    outcomes.push(result.outcome);
    if (attempt < LAUNCH_HEAL_MAX_ATTEMPTS) assert.equal(result.rescheduleMs, LAUNCH_HEAL_RETRY_MS);
  }
  assert.deepEqual(outcomes, ["claim_unavailable", "claim_unavailable", "claim_unavailable", "gave_up"]);
  assert.equal(launcher.calls.length, 0);
  assert.deepEqual(comments(w.tracker), ["Launch failed: claim_unavailable. Moving the card to Approved again retries."]);
  assert.equal(w.kv.entries.has(WATCH), false);
});

test("a fire from a reminder the watch does not name is superseded", async () => {
  const w = world();
  const reminders = fakeReminders();
  await lostDelivery(w, { reminders: reminders.api });
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const launcher = fakeCreateAgent();
  assert.deepEqual(await healLaunch(w.deps(launcher), { issueKey: KEY, reminderId: "rem-old" }), { issueKey: KEY, outcome: "superseded" });
  assert.equal(launcher.calls.length, 0);
});

test("L6: a delivery's backstop never heals: it gives a lost launch's watch a reminder, and that reminder's run heals it once", async () => {
  const w = world();
  await lostDelivery(w);
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const launcher = fakeCreateAgent();
  const reminders = fakeReminders();
  const gh = fakeGitHub();
  const deps = { kv: w.kv, mcp: w.tracker.mcp, env: ENV, now: () => new Date(w.clock.ms), github: gh.github, readRun: async () => undefined, log: () => {}, createAgent: launcher.createAgent, reminders: reminders.api };
  const result = await backstopImplementPrSweep(deps);
  assert.deepEqual(result, { swept: true, fires: [], tended: [{ issueKey: KEY, reminder: "armed" }] });
  assert.equal(launcher.calls.length, 0, "no create inside a delivery's admission");
  assert.deepEqual(reminders.created.map((each) => each.handler), ["implement_launch"]);

  // The reminder's run: its own heal, then the backstop, which tends only.
  assert.equal((await healLaunch({ ...w.deps(launcher), reminders: reminders.api }, { issueKey: KEY, reminderId: "rem-1", approvedAt: T0.toISOString() })).outcome, "launched");
  w.clock.ms += 10 * MIN;
  await backstopImplementPrSweep({ ...deps, now: () => new Date(w.clock.ms) });
  assert.equal(launcher.calls.length, 1, "one heal per reminder run");

  const idle = await backstopImplementPrSweep({ kv: memoryKv(), mcp: w.tracker.mcp, env: ENV, now: () => new Date(w.clock.ms), github: gh.github, readRun: async () => undefined, createAgent: launcher.createAgent });
  assert.deepEqual(idle, { swept: false, why: "idle" });
});

test("L6: a watch whose reminder is lost (10 minutes past due) gets a new one from the backstop, and the old one's fire is superseded", async () => {
  const w = world();
  const reminders = fakeReminders();
  await lostDelivery(w, { reminders: reminders.api });
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + 10 * MIN + 1;
  const gh = fakeGitHub();
  const tended = await backstopImplementPrSweep({ kv: w.kv, mcp: w.tracker.mcp, env: ENV, now: () => new Date(w.clock.ms), github: gh.github, readRun: async () => undefined, createAgent: fakeCreateAgent().createAgent, reminders: reminders.api });
  assert.deepEqual(tended, { swept: true, fires: [], tended: [{ issueKey: KEY, reminder: "armed" }] });
  assert.deepEqual(reminders.cancelled, ["rem-1"]);
  assert.equal((await healLaunch(w.deps(fakeCreateAgent()), { issueKey: KEY, reminderId: "rem-1" })).outcome, "superseded");
});

/** The fake tracker behind a registry whose connector lists no tools while `usable.now` is false, as a loading or needsAuth server does. */
function gatedRegistry(tracker: FakeTracker, usable: { now: boolean }): FakeTracker["mcp"] {
  return {
    names: () => tracker.mcp.names(),
    listTools: async (name) => (usable.now ? tracker.mcp.listTools(name) : []),
    callTool: async (connection, tool, args) =>
      tool === "factory-connector-probe"
        ? { content: [{ type: "text", text: 'Unknown tool "factory-connector-probe". Available: (none). Unhealthy connectors: Factory Atlassian=loading.' }], isError: true }
        : tracker.mcp.callTool(connection, tool, args),
  };
}

async function capturingWarnings<T>(work: () => Promise<T>): Promise<{ result: T; warnings: Record<string, unknown>[] }> {
  const original = console.warn;
  const warnings: Record<string, unknown>[] = [];
  console.warn = (line: unknown) => {
    try {
      warnings.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // Not a JSON line.
    }
  };
  const before = process.env.FACTORY_TRACKER_RETRY_MS;
  process.env.FACTORY_TRACKER_RETRY_MS = "0,0";
  try {
    return { result: await work(), warnings };
  } finally {
    console.warn = original;
    if (before === undefined) delete process.env.FACTORY_TRACKER_RETRY_MS;
    else process.env.FACTORY_TRACKER_RETRY_MS = before;
  }
}

test("TLSSN-51, top hypothesis: a connector with no tools at 04:46:56 answers 202 with the approval watched and an ops warning, and the watch launches once the connector is back", async () => {
  const w = world();
  const usable = { now: false };
  const reminders = fakeReminders();
  const { result: delivery, warnings } = await capturingWarnings(async () => {
    const handle = createHandler({ ...w.deps(fakeCreateAgent()), mcp: gatedRegistry(w.tracker, usable), reminders: reminders.api });
    const response = await handle(signedRequest(approvedBody()), backgroundWork());
    return { status: response.status, body: (await response.json()) as unknown };
  });
  assert.equal(delivery.status, 202, "a non-2xx is terminal on hosted: nothing would retry it");
  assert.deepEqual(delivery.body, { ok: true, launched: false, reason: "comments_unreadable", watched: true, tracker: "not_connected" });
  assert.equal(w.kv.entries.has(CLAIM), false, "no claim is taken");
  assert.ok(w.kv.entries.has(WATCH));
  assert.deepEqual(reminders.created.map((each) => each.handler), ["implement_launch"]);
  const decision = w.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line["worker"] === "decision");
  assert.deepEqual(decision?.["connector"], { reason: "empty", attempts: 3, serverState: "Factory Atlassian=loading" });
  assert.deepEqual(
    warnings.filter((line) => line["ops"] === "warn").map((line) => [line["site"], line["kind"], line["reasonCode"], line["message"]]),
    [["handle.tracker", "Jira connector", "empty", "Factory Atlassian=loading"]],
    "the connector cannot carry a Jira comment, so ops Slack hears it"
  );

  usable.now = true;
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const launcher = fakeCreateAgent();
  // The reminder fire is its own request with its own registry.
  const healed = await healLaunch({ ...w.deps(launcher), mcp: gatedRegistry(w.tracker, usable), reminders: reminders.api }, { issueKey: KEY, reminderId: "rem-1" });
  assert.deepEqual(healed, { issueKey: KEY, outcome: "launched", attempt: 1 });
  assert.equal(launcher.calls.length, 1);
  assert.equal(w.tracker.status(), "In Progress");
});

test("with kv unable to hold the watch, the reminder carries the approval (orphan) and its fire writes the watch and launches", async () => {
  const w = world();
  const reminders = fakeReminders();
  let kvDown = true;
  const kv: MemoryKv = {
    ...w.kv,
    put: async (key, value) => {
      if (kvDown && (key.startsWith("implement/") || key.startsWith("implement-launch/"))) throw Object.assign(new Error("kv down"), { status: 503 });
      await w.kv.put(key, value);
    },
  };
  const handle = createHandler({ ...w.deps(fakeCreateAgent()), kv, reminders: reminders.api });
  const response = await handle(signedRequest(approvedBody()), backgroundWork());
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, launched: false, reason: "claim_unavailable", watched: true });
  assert.deepEqual(reminders.created.map((each) => each.args), [{ issueKey: KEY, at: T0.toISOString(), orphan: { changelogId: "10042", title: "Retry CSV export on empty filter" } }]);
  assert.equal(w.kv.entries.has(WATCH), false);
  assert.deepEqual(comments(w.tracker), [
    "Launch pending: TLSSN-42: the launch claim could not be taken (kv unavailable). If no Implementing: comment follows within 4 minutes, factory-worker relaunches it on its own.",
  ]);

  kvDown = false;
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const args = parseLaunchWatchArgs(reminders.created[0]?.args);
  assert.ok(args?.orphan !== undefined);
  const launcher = fakeCreateAgent();
  const healed = await healLaunch(w.deps(launcher), { issueKey: KEY, reminderId: "rem-1", orphan: { ...args.orphan, at: args.at } });
  assert.deepEqual(healed, { issueKey: KEY, outcome: "launched", attempt: 1 });
  assert.equal(launcher.calls.length, 1);
});

test("only when neither the watch nor a reminder can be scheduled is it a 503, with a Launch failed: line the desk announces", async () => {
  const w = world();
  const kv: MemoryKv = {
    ...w.kv,
    put: async (key, value) => {
      if (key.startsWith("implement/") || key.startsWith("implement-launch/")) throw Object.assign(new Error("kv down"), { status: 503 });
      await w.kv.put(key, value);
    },
  };
  const handle = createHandler({ ...w.deps(fakeCreateAgent()), kv });
  const response = await handle(signedRequest(approvedBody()), backgroundWork());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, launched: false, reason: "claim_unavailable", watched: false });
  assert.deepEqual(comments(w.tracker), ["Launch failed: claim_unavailable. Moving the card to Approved again retries."]);
});

test("a settle re-read that shows a rival which then vanishes leaves this delivery in flight with its own pending, and the watch launches it once after the grace", async () => {
  const w = world();
  let rivalShown = false;
  let ownedReads = 0;
  const kv: MemoryKv = {
    ...w.kv,
    get: async (key) => {
      const value = await w.kv.get(key);
      // The read-back sees this delivery's put; the settle re-read after it meets a rival's young pending that never lands for good.
      if (key === CLAIM && (value as { owner?: string } | undefined)?.owner !== undefined) {
        ownedReads += 1;
        if (ownedReads === 2) {
          rivalShown = true;
          return { state: "pending", at: T0.toISOString(), owner: "rival" };
        }
      }
      return value;
    },
  };
  const launcher = fakeCreateAgent();
  const handle = createHandler({ ...w.deps(launcher), kv });
  const response = await handle(signedRequest(approvedBody()), backgroundWork());
  assert.deepEqual(await response.json(), { ok: true, duplicate: true, issueKey: KEY, inFlight: true });
  assert.ok(rivalShown);
  assert.equal(launcher.calls.length, 0);
  assert.equal((w.kv.entries.get(CLAIM) as { state?: string }).state, "pending", "this delivery's own pending stays behind");
  assert.ok(w.kv.entries.has(WATCH), "and the watch covers it");

  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  assert.equal((await healLaunch(w.deps(launcher), { issueKey: KEY })).outcome, "launched");
  assert.equal(launcher.calls.length, 1);
});

test("M4: 60 older agents modified in the last minute push the lost agent to page 2 of an update-ordered listing, and it is still found", async () => {
  const now = T0.getTime() + 10 * MIN;
  const older = Array.from({ length: 60 }, (_, i) => ({ agentId: `bc-old-${i}`, name: `factory TLSSN-${100 + i}: other`, createdAt: T0.getTime() - 60 * MIN, lastModified: now - 30_000 + i }));
  const lost = { agentId: "bc-lost", name: "factory TLSSN-42: Retry CSV export on empty filter", createdAt: now - 6 * MIN, lastModified: now - 6 * MIN + 1_000 };
  const all = [...older, lost].sort((a, b) => b.lastModified - a.lastModified);
  const pages: (string | undefined)[] = [];
  const listAgents: ListAgents = async (options) => {
    pages.push(options.cursor);
    const start = Number(options.cursor ?? "0");
    return { items: all.slice(start, start + options.limit), ...(start + options.limit < all.length ? { nextCursor: String(start + options.limit) } : {}) };
  };
  const found = await findLaunchedAgent(listAgents, { issueKey: KEY, since: new Date(now - 6 * MIN) });
  assert.deepEqual(found, { found: { agentId: "bc-lost", url: "https://cursor.com/agents/bc-lost" } });
  assert.deepEqual(pages, [undefined, "50"], "an older agent's recent update does not end the search");

  // Positive none needs an item last modified before the window, not merely created before it.
  const onlyOlder: ListAgents = async () => ({ items: older, nextCursor: "more" });
  const truncated = await findLaunchedAgent(onlyOlder, { issueKey: KEY, since: new Date(now - 6 * MIN) });
  assert.equal(truncated.found, "unknown", "three pages of recently modified older agents never prove none");
});

test("M5: a thawed launch whose record is refused while the claim names another agent cancels and archives its own agent, and ops hears both ids", async () => {
  const w = world();
  const server = serverLauncher({ now: () => w.clock.ms, hold: "after" });
  const first = createHandler({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, retireAgent: server.retireAgent, launchTimeoutMs: 5, launchLateWaitMs: 5 });
  await keepingAlive(async () => {
    const background = backgroundWork();
    await first(signedRequest(approvedBody()), background);
    await background.settle();
  });
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  assert.equal((await healLaunch({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, retireAgent: server.retireAgent }, { issueKey: KEY })).outcome, "launched");

  const { warnings } = await capturingWarnings(async () => {
    server.release();
    await settle();
  });
  assert.deepEqual(server.retired, ["bc-1"], "the thawed launch's own agent, never the one the claim names");
  assert.equal(recorded(w).agentId, "bc-2");
  assert.deepEqual(
    warnings.filter((line) => line["ops"] === "warn").map((line) => [line["site"], line["reasonCode"], line["subject"], line["message"]]),
    [["handle.orphan", "archived", "TLSSN-42 bc-1 (claim bc-2)", "TLSSN-42: bc-1 archived; the claim names bc-2"]]
  );
});

test("M5: a refused record never archives when the claim cannot be read, or names no agent yet", async () => {
  const rival = { state: "pending", at: T0.toISOString(), owner: "someone-else" };
  for (const unreadable of [true, false]) {
    const w = world();
    const server = serverLauncher({ now: () => w.clock.ms, hold: "after" });
    // Once armed, the claim reads as a rival's pending (so the record is refused), then, when unreadable, fails.
    let armed = false;
    let claimReads = 0;
    const kv: MemoryKv = {
      ...w.kv,
      get: async (key) => {
        if (!armed || key !== CLAIM) return w.kv.get(key);
        claimReads += 1;
        if (unreadable && claimReads > 1) throw Object.assign(new Error("kv down"), { status: 503 });
        return rival;
      },
    };
    const handle = createHandler({ ...w.deps(fakeCreateAgent()), kv, createAgent: server.createAgent, listAgents: server.listAgents, retireAgent: server.retireAgent, launchTimeoutMs: 5, launchLateWaitMs: 5 });
    await keepingAlive(async () => {
      const background = backgroundWork();
      await handle(signedRequest(approvedBody()), background);
      await background.settle();
    });
    armed = true;
    const { warnings } = await capturingWarnings(async () => {
      server.release();
      await settle();
    });
    const label = unreadable ? "claim unreadable" : "a takeover still deciding";
    assert.deepEqual(server.retired, [], label);
    assert.deepEqual(warnings.filter((line) => line["ops"] === "warn").map((line) => [line["reasonCode"], line["subject"]]), [[unreadable ? "claim_unread" : "kept", "TLSSN-42 bc-1"]], label);
    assert.deepEqual(implementing(w.tracker), [], `${label}: no Implementing: from a launch that lost its claim`);
  }
});

test("M5: a heal that adopted the thawed launch's own agent leaves it alone", async () => {
  const w = world();
  const server = serverLauncher({ now: () => w.clock.ms, hold: "before" });
  const first = createHandler({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, retireAgent: server.retireAgent, launchTimeoutMs: 5, launchLateWaitMs: 5 });
  await keepingAlive(async () => {
    const background = backgroundWork();
    await first(signedRequest(approvedBody()), background);
    await background.settle();
  });
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  await healLaunch({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, retireAgent: server.retireAgent }, { issueKey: KEY });
  const { warnings } = await capturingWarnings(async () => {
    server.release();
    await settle();
  });
  assert.deepEqual(server.retired, []);
  assert.deepEqual(warnings.filter((line) => line["ops"] === "warn"), []);
  assert.equal(recorded(w).agentId, "bc-1");
});

test("L7: a watch that gives up on an agent check that never answers clears the pending claim, says so, and a person's next move to Approved launches", async () => {
  const w = world();
  await lostDelivery(w);
  const server = serverLauncher({ now: () => w.clock.ms, failList: true });
  const deps = { ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents };
  // Each unverified takeover leaves this heal's own pending claim, so the next attempt waits out the grace: about every 4 minutes.
  const outcomes: string[] = [];
  const { warnings } = await capturingWarnings(async () => {
    for (let fire = 0; fire < 12 && !outcomes.includes("gave_up"); fire += 1) {
      w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + fire * LAUNCH_HEAL_RETRY_MS;
      outcomes.push((await healLaunch(deps, { issueKey: KEY, approvedAt: T0.toISOString() })).outcome);
    }
  });
  assert.deepEqual(outcomes.filter((outcome) => outcome !== "not_due"), ["agent_unverified", "agent_unverified", "agent_unverified", "gave_up"]);
  assert.ok(w.clock.ms - T0.getTime() < LAUNCH_HEAL_MAX_AGE_MS, "it gives up inside the reminder's 30-minute bound");
  assert.deepEqual(server.calls, [], "nothing launched without a positive check");
  assert.equal(w.kv.entries.has(CLAIM), false, "the pending claim is cleared");
  assert.deepEqual(comments(w.tracker).filter((body) => body.startsWith("Launch failed:")), ["Launch failed: agent_unverified. Moving the card to Approved again retries."]);
  const ops = warnings.find((line) => line["site"] === "launch-heal.unverified");
  assert.deepEqual([ops?.["reasonCode"], ops?.["subject"]], ["service_unavailable", KEY], "the agent check's error; the ticket as the subject");

  // A person moves the card to Approved again: a fresh claim, no takeover, so it launches.
  const handle = createHandler(deps);
  const background = backgroundWork();
  await handle(signedRequest(approvedBody({ changelogId: "10099" })), background);
  await background.settle();
  assert.equal(server.calls.length, 1);
  assert.equal(recorded(w).state, "launched");
});

test("L8: a create that fails after the heal took the claim over posts no Launch failed:", async () => {
  const w = world();
  const server = serverLauncher({ now: () => w.clock.ms, hold: "before", rejectHeld: true });
  const first = createHandler({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, launchTimeoutMs: 5, launchLateWaitMs: 5 });
  await keepingAlive(async () => {
    const background = backgroundWork();
    await first(signedRequest(approvedBody()), background);
    await background.settle();
  });
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  assert.equal((await healLaunch({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents }, { issueKey: KEY })).outcome, "launched");
  server.release();
  await settle();
  assert.ok(!comments(w.tracker).some((body) => body.startsWith("Launch failed:")));
  assert.equal(recorded(w).state, "launched");
  assert.ok(w.lines.some((line) => (JSON.parse(line) as Record<string, unknown>)["outcome"] === "late_failure_superseded"));
});

/** Heal deps whose agent check is refused: each attempt ends `agent_unverified` and the watch stays open, rescheduling. */
function unverifiedDeps(w: World) {
  const server = serverLauncher({ now: () => w.clock.ms, failList: true });
  return { ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents };
}

/** A watch whose healthy reminder fired every 2 minutes from 4 to 12 minutes after the approval. */
async function healthyLongWatch(w: World, reminders: ReturnType<typeof fakeReminders>) {
  await lostDelivery(w, { reminders: reminders.api });
  for (let fire = 0; fire <= 4; fire += 1) {
    w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + fire * LAUNCH_HEAL_RETRY_MS;
    await healLaunch(unverifiedDeps(w), { issueKey: KEY, reminderId: "rem-1", approvedAt: T0.toISOString() });
  }
}

test("L10: a healthy reminder that keeps rescheduling is never taken for lost, even 14+ minutes after the approval", async () => {
  const w = world();
  const reminders = fakeReminders();
  await healthyLongWatch(w, reminders);
  assert.ok(w.kv.entries.has(WATCH), "still open");
  w.clock.ms += 2.5 * MIN;
  assert.ok(w.clock.ms - T0.getTime() > 14 * MIN, "past the old rule's line");
  assert.deepEqual(await tendLaunchWatches({ ...w.deps(fakeCreateAgent()), reminders: reminders.api }), []);
  assert.deepEqual(reminders.cancelled, []);
  assert.equal(reminders.created.length, 1);
});

test("L10: a reminder more than 10 minutes past its recorded due time is replaced; one inside that is kept", async () => {
  const w = world();
  const reminders = fakeReminders();
  await lostDelivery(w, { reminders: reminders.api });
  await healLaunch(unverifiedDeps(w), { issueKey: KEY, reminderId: "rem-1", approvedAt: T0.toISOString() });
  const due = Date.parse(String((w.kv.entries.get(WATCH) as Record<string, unknown>)["dueAt"]));
  const deps = { ...w.deps(fakeCreateAgent()), reminders: reminders.api };
  w.clock.ms = due + 10 * MIN;
  assert.deepEqual(await tendLaunchWatches(deps), []);
  w.clock.ms = due + 10 * MIN + 1;
  assert.deepEqual(await tendLaunchWatches(deps), [{ issueKey: KEY, reminder: "armed" }]);
  assert.deepEqual(reminders.cancelled, ["rem-1"]);
  assert.equal((w.kv.entries.get(WATCH) as Record<string, unknown>)["reminderId"], "rem-2");
});

test("L10: an expired watch is closed, so no tend re-arms it", async () => {
  const w = world();
  const reminders = fakeReminders();
  await lostDelivery(w, { reminders: reminders.api });
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_MAX_AGE_MS;
  const expired = await healLaunch(unverifiedDeps(w), { issueKey: KEY, reminderId: "rem-1", approvedAt: T0.toISOString() });
  assert.equal(expired.outcome, "expired");
  assert.equal(w.kv.entries.has(WATCH), false);
  w.clock.ms += 20 * MIN;
  assert.deepEqual(await tendLaunchWatches({ ...w.deps(fakeCreateAgent()), reminders: reminders.api }), []);
  assert.equal(reminders.created.length, 1);
});

test("L11: a watch the heal closes while the tend replaces its reminder is not brought back, and the new reminder is cancelled", async () => {
  const w = world();
  const inner = fakeReminders();
  await lostDelivery(w, { reminders: inner.api });
  // The heal closes the watch (a commented Launch failed:) while the tend's create is in flight.
  const racing: ReminderHostApi = {
    ...inner.api,
    create: async (input) => {
      await w.kv.delete(WATCH);
      return inner.api.create(input);
    },
  };
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + 10 * MIN + 1;
  assert.deepEqual(await tendLaunchWatches({ ...w.deps(fakeCreateAgent()), reminders: racing }), [{ issueKey: KEY, reminder: "no_watch" }]);
  assert.equal(w.kv.entries.has(WATCH), false, "the closed watch stays closed");
  assert.deepEqual(inner.cancelled, ["rem-2"], "the reminder just created is cancelled; the lost one was the closer's to cancel");
});

test("L11: a watch whose reminder changed meanwhile keeps the other writer's reminder", async () => {
  const w = world();
  const inner = fakeReminders();
  await lostDelivery(w, { reminders: inner.api });
  const racing: ReminderHostApi = {
    ...inner.api,
    create: async (input) => {
      const current = w.kv.entries.get(WATCH) as Record<string, unknown>;
      await w.kv.put(WATCH, { ...current, reminderId: "rem-other" });
      return inner.api.create(input);
    },
  };
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + 10 * MIN + 1;
  assert.deepEqual(await tendLaunchWatches({ ...w.deps(fakeCreateAgent()), reminders: racing }), [{ issueKey: KEY, reminder: "no_watch" }]);
  assert.equal((w.kv.entries.get(WATCH) as Record<string, unknown>)["reminderId"], "rem-other");
  assert.deepEqual(inner.cancelled, ["rem-2"]);
});

test("L12: abandonPendingClaim deletes only the exact pending claim it read, and only past its grace", async () => {
  const kv = memoryKv();
  const read = { state: "pending", at: T0.toISOString(), owner: "heal-run" };
  const later = new Date(T0.getTime() + LAUNCH_GRACE_MS + 1);
  await kv.put(CLAIM, read);
  assert.equal(await abandonPendingClaim(kv, { issueKey: KEY, expected: read, now: new Date(T0.getTime() + MIN), mode: "verified" }), false, "inside the grace");
  assert.ok(kv.entries.has(CLAIM));

  // A fresh delivery's claim taken between the heal's read and its delete.
  const fresh = { state: "pending", at: later.toISOString(), owner: "fresh-delivery" };
  await kv.put(CLAIM, fresh);
  assert.equal(await abandonPendingClaim(kv, { issueKey: KEY, expected: read, now: later, mode: "verified" }), false);
  assert.deepEqual(kv.entries.get(CLAIM), fresh, "the fresh claim is kept");

  await kv.put(CLAIM, read);
  assert.equal(await abandonPendingClaim(kv, { issueKey: KEY, expected: read, now: later, mode: "verified" }), true);
  assert.equal(kv.entries.has(CLAIM), false);

  const launched = { state: "launched", at: T0.toISOString(), agentId: "bc-1", commented: true, moved: true };
  await kv.put(CLAIM, launched);
  assert.equal(await abandonPendingClaim(kv, { issueKey: KEY, expected: launched, now: later, mode: "verified" }), false, "a launched claim is never touched");
});

test("L13/L17: two orphans on different tickets each reach ops Slack in the same hour, under one fixed metric reason", async () => {
  const posts: string[] = [];
  const labels: unknown[] = [];
  const funnel = createOpsFunnel({
    env: () => ({ FACTORY_OPS_SLACK_BOT_TOKEN: "xoxb-ops", FACTORY_OPS_SLACK_CHANNEL: "C-OPS", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dGVzdA==" }),
    now: () => T0,
    log: () => {},
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      posts.push(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
  });
  funnel.bind({
    kv: memoryKv(),
    otel: {
      enabled: true,
      increment: (_name: string, valueOrAttrs?: number | Record<string, unknown>, attrs?: Record<string, unknown>) => {
        labels.push(typeof valueOrAttrs === "number" ? attrs : valueOrAttrs);
      },
    } as never,
  });
  for (const subject of ["TLSSN-42 bc-1", "TLSSN-43 bc-7", "TLSSN-42 bc-1"]) {
    funnel.warnOps({ site: "handle.orphan", kind: "unrecorded agent", reasonCode: "kept", subject });
    await funnel.settled();
  }
  assert.equal(posts.length, 2, "one alert per ticket and agent; a repeat of the same one is deduped");
  assert.ok(posts[0]?.includes("TLSSN-42 bc-1") && posts[1]?.includes("TLSSN-43 bc-7"), "the ids are in the Slack text");
  const counted = labels.filter((each) => typeof each === "object" && each !== null);
  assert.equal(counted.length, 4, "three warns plus bind's labeled zero baseline");
  assert.deepEqual(counted[0], { slug: "factory-worker", site: "none", reason: "none" });
  assert.ok(counted.slice(1).every((each) => JSON.stringify(each) === JSON.stringify({ slug: "factory-worker", site: "handle.orphan", reason: "kept" })), "no ids in the metric's labels");
});

test("L14: a watch that never had a reminder is closed and pruned by the tend once past 30 minutes; one changed meanwhile is kept", async () => {
  const w = world();
  await lostDelivery(w);
  assert.equal((w.kv.entries.get(WATCH) as Record<string, unknown>)["reminderId"], undefined, "no reminder API: no reminder");
  w.clock.ms = T0.getTime() + LAUNCH_HEAL_MAX_AGE_MS;
  assert.deepEqual(await tendLaunchWatches(w.deps(fakeCreateAgent())), []);
  assert.equal(w.kv.entries.has(WATCH), false, "closed");
  assert.deepEqual(w.kv.entries.get(INDEX), [], "and pruned, so no backstop re-reads it");

  // A record rewritten between the tend's read and its delete is not the one it read, so it stays.
  const v = world();
  await lostDelivery(v);
  v.clock.ms = T0.getTime() + LAUNCH_HEAL_MAX_AGE_MS;
  let reads = 0;
  const kv: MemoryKv = {
    ...v.kv,
    get: async (key) => {
      const value = await v.kv.get(key);
      if (key === WATCH && ++reads === 2) {
        const rewritten = { ...(value as Record<string, unknown>), reminderId: "rem-late" };
        await v.kv.put(WATCH, rewritten);
        return rewritten;
      }
      return value;
    },
  };
  await tendLaunchWatches({ ...v.deps(fakeCreateAgent()), kv });
  assert.equal((v.kv.entries.get(WATCH) as Record<string, unknown>)["reminderId"], "rem-late");
});

test("L15: a reminder record whose write is unavailable is cancelled only when a re-read shows the watch does not name it", async () => {
  for (const [label, mode, cancelled, named] of [
    ["the put landed", "landed", ["rem-1"], "rem-2"],
    ["the put did not land", "missing", ["rem-2"], "rem-1"],
    ["the re-read fails", "unreadable", [], "rem-1"],
  ] as const) {
    const w = world();
    const reminders = fakeReminders();
    await lostDelivery(w, { reminders: reminders.api });
    w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS + 10 * MIN + 1;
    // The reminder's record put is refused outright, so the update is unavailable: "landed" applies it first.
    let putTried = false;
    const kv: MemoryKv = {
      ...w.kv,
      get: async (key) => {
        if (putTried && mode === "unreadable" && key === WATCH) throw Object.assign(new Error("kv 503"), { status: 503 });
        return w.kv.get(key);
      },
      put: async (key, value) => {
        if (key === WATCH) {
          putTried = true;
          if (mode === "landed") await w.kv.put(key, value);
          throw Object.assign(new Error("storage refused"), { status: 403, reasonCode: "agentsdk_kv_storage_not_allowed" });
        }
        return w.kv.put(key, value);
      },
    };
    const deps = { ...w.deps(fakeCreateAgent()), kv, reminders: reminders.api };
    await tendLaunchWatches(deps);
    assert.deepEqual(reminders.cancelled, cancelled, label);
    assert.equal((w.kv.entries.get(WATCH) as Record<string, unknown>)["reminderId"], named, label);
  }
});

test("L16: noteLaunchAttempt merges onto the stored record: a reminder swapped after its put survives with the attempt, and a closed watch is not rewritten", async () => {
  const w = world();
  const reminders = fakeReminders();
  await lostDelivery(w, { reminders: reminders.api });
  let swapped = false;
  const kv: MemoryKv = {
    ...w.kv,
    put: async (key, value) => {
      await w.kv.put(key, value);
      // Another writer swaps the reminder right after this put lands.
      if (key === WATCH && !swapped) {
        swapped = true;
        await w.kv.put(WATCH, { ...(value as Record<string, unknown>), reminderId: "rem-swapped", attempts: 0 });
      }
    },
  };
  await noteLaunchAttempt(kv, { issueKey: KEY, attempts: 2, last: "agent_unverified" });
  const stored = w.kv.entries.get(WATCH) as Record<string, unknown>;
  assert.deepEqual([stored["reminderId"], stored["attempts"], stored["last"]], ["rem-swapped", 2, "agent_unverified"]);

  await w.kv.delete(WATCH);
  await noteLaunchAttempt(w.kv, { issueKey: KEY, attempts: 3 });
  assert.equal(w.kv.entries.has(WATCH), false);
});

test("Bugbot 1: a claimed launch whose watch index write fails still gets the orphan reminder that carries the approval, and that reminder heals it", async () => {
  const w = world();
  const reminders = fakeReminders();
  // The watch record lands; the index write is refused, so openLaunchWatch is unavailable.
  const kv: MemoryKv = {
    ...w.kv,
    put: async (key, value) => {
      if (key === INDEX) throw Object.assign(new Error("storage refused"), { status: 403, reasonCode: "agentsdk_kv_storage_not_allowed" });
      return w.kv.put(key, value);
    },
  };
  const lost = await lostDelivery(w, { kv, reminders: reminders.api });
  assert.equal(lost.status, 202);
  assert.ok(w.kv.entries.has(WATCH) && !w.kv.entries.has(INDEX), "record without an index entry: no backstop can find it");
  const args = parseLaunchWatchArgs(reminders.created[0]?.args);
  assert.deepEqual(args, { issueKey: KEY, at: T0.toISOString(), orphan: { changelogId: "10042", title: "Retry CSV export on empty filter" } });

  w.clock.ms = T0.getTime() + LAUNCH_HEAL_FIRST_MS;
  const launcher = fakeCreateAgent();
  const healed = await healLaunch(w.deps(launcher), { issueKey: KEY, reminderId: "rem-1", approvedAt: args!.at, orphan: { ...args!.orphan!, at: args!.at } });
  assert.equal(healed.outcome, "launched");
  assert.equal(launcher.calls.length, 1);
});

test("Bugbot 2: a give-up after agent_unverified attempts never announces a launch failure once the claim is launched", async () => {
  const w = world();
  await w.kv.put(WATCH, { at: T0.toISOString(), changelogId: "10042", title: "t", attempts: LAUNCH_HEAL_MAX_ATTEMPTS, last: "agent_unverified", detail: "service_unavailable" });
  await w.kv.put(INDEX, [KEY]);
  const launchedClaim = { state: "launched", at: T0.toISOString(), agentId: "bc-9", url: "https://cursor.com/agents/bc-9", commented: false, moved: false };
  await w.kv.put(CLAIM, launchedClaim);
  w.clock.ms = T0.getTime() + 20 * MIN;
  const { result, warnings } = await capturingWarnings(() => healLaunch(w.deps(fakeCreateAgent()), { issueKey: KEY }));
  assert.equal(result.outcome, "gave_up");
  assert.deepEqual(comments(w.tracker).filter((body) => body.startsWith("Launch failed:")), []);
  assert.deepEqual(w.kv.entries.get(CLAIM), launchedClaim, "the launched claim is kept");
  assert.deepEqual(warnings.filter((line) => line["ops"] === "warn").map((line) => line["site"]), ["launch-heal.repair"]);
});

test("Bugbot 3: a late create that lands after the give-up cleared the claim records nothing, comments nothing, and is archived", async () => {
  const w = world();
  const server = serverLauncher({ now: () => w.clock.ms, hold: "after" });
  const handle = createHandler({ ...w.deps(fakeCreateAgent()), createAgent: server.createAgent, listAgents: server.listAgents, retireAgent: server.retireAgent, launchTimeoutMs: 5, launchLateWaitMs: 5 });
  await keepingAlive(async () => {
    const background = backgroundWork();
    await handle(signedRequest(approvedBody()), background);
    await background.settle();
  });
  // The watch's agent_unverified give-up clears the lost pending claim.
  w.clock.ms = T0.getTime() + LAUNCH_GRACE_MS + MIN;
  assert.equal(await abandonPendingClaim(w.kv, { issueKey: KEY, expected: w.kv.entries.get(CLAIM), now: new Date(w.clock.ms), mode: "verified" }), true);

  const { warnings } = await capturingWarnings(async () => {
    server.release();
    await settle();
  });
  assert.equal(w.kv.entries.has(CLAIM), false, "an empty key is not recordable for a late create");
  assert.deepEqual(implementing(w.tracker), []);
  assert.deepEqual(server.retired, ["bc-1"]);
  assert.deepEqual(
    warnings.filter((line) => line["ops"] === "warn").map((line) => [line["reasonCode"], line["subject"]]),
    [["archived", "TLSSN-42 bc-1 (no claim)"]]
  );
});

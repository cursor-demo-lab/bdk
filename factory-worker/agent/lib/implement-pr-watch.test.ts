import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { JsonObject, ReminderCreateInput, ReminderHostApi, ReminderInfo } from "@cursor/july";
import { recordImplementation } from "./claim.js";
import { approvedBody } from "./fixtures.js";
import { createHandler } from "./handle.js";
import {
  armImplementPrWatch,
  ensureImplementPr,
  fireImplementPrWatch,
  IMPLEMENT_PR_FIRST_MS,
  IMPLEMENT_PR_GRACE_MS,
  IMPLEMENT_PR_INDEX,
  IMPLEMENT_PR_MAX_MS,
  IMPLEMENT_PR_POLL_MS,
  implementPrWatchKey,
  parseImplementPrArgs,
  pruneImplementPrIndex,
  readImplementPrIndex,
  type AgentRunFacts,
  type ImplementPrDeps,
} from "./implement-pr.js";
import { LAUNCH_HEAL_HANDLER } from "./launch-watch.js";
import { backstopImplementPrSweep, IMPLEMENT_PR_SWEEP_EVERY_MS, IMPLEMENT_PR_SWEEP_KEY, sweepImplementPrWatches, withImplementPrBackstop, type SweepDeps } from "./implement-pr-sweep.js";
import { backgroundWork, fakeCreateAgent, fakeTracker, memoryKv, signedRequest, type FakeTracker, type MemoryKv } from "./testing/fakes.js";
import { fakeGitHub, fakeReminders, type FakeGitHub } from "./testing/github.js";

// The implement PR watch end to end on a simulated clock: the launch arms
// it, July's runner fires it (a `skip` with a reschedule re-arms, `stop`
// ends it, `cancel` drops it), and the backstop sweep covers a reminder that
// was never created or stopped firing.

const T0 = new Date("2026-09-27T22:00:00.000Z");
const MIN = 60_000;
const KEY = "TLSSN-35";
const REPO = "cursor-demo-lab/marsbank";
const BRANCH = "TLSSN-35-activity-register-landmark-name";
const TITLE = "Activity register: show the landmark name";
const AGENT_URL = "https://cursor.com/agents/bc-tlssn-35";
const ENV: NodeJS.ProcessEnv = { JIRA_WEBHOOK_SECRET: "test-secret", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_SANDBOX_REPO: REPO, FACTORY_CLAIM_SETTLE_MS: "1" };
const PLAN = [`Plan: ${KEY} ${TITLE}`, "Problem", "The register shows the landmark id.", "", "Brief:", "Ticket: https://example.atlassian.net/browse/TLSSN-35", "", "Show the landmark name."].join("\n");
const RUNNING: AgentRunFacts = { status: "running" };
const PUSHED: AgentRunFacts = { status: "running", branch: BRANCH };
const FINISHED: AgentRunFacts = { status: "finished", branch: BRANCH, summary: "## What changed\n- The row shows the landmark name." };

type Live = { id: string; dueMs: number; args: JsonObject; state: "armed" | "done" | "cancelled" };

/** July's reminder runner, reduced to what the watch relies on. */
function julyRunner(clock: { ms: number }, options: { failCreate?: boolean } = {}) {
  const live: Live[] = [];
  const fires: { id: string; atMin: number; outcome: string }[] = [];
  // The launch watch's own reminder (launch-watch.ts) is kept apart: this runner drives the implement PR watch only.
  const launchWatches: ReminderCreateInput[] = [];
  const api: ReminderHostApi = {
    create: async (input: ReminderCreateInput) => {
      if (options.failCreate === true) throw new Error("platform timers require CURSOR_API_KEY");
      if (input.handler === LAUNCH_HEAL_HANDLER) {
        launchWatches.push(input);
        return { id: `launch-${launchWatches.length}` } as ReminderInfo;
      }
      const minutes = Number(String(input.delay).replace(/m$/, ""));
      const reminder: Live = { id: `rem-${live.length + 1}`, dueMs: clock.ms + minutes * MIN, args: input.args ?? {}, state: "armed" };
      live.push(reminder);
      return { id: reminder.id } as ReminderInfo;
    },
    list: async () => [],
    cancel: async (id) => {
      const reminder = live.find((each) => each.id === id);
      if (reminder !== undefined && reminder.state === "armed") reminder.state = "cancelled";
    },
    cancelForContinuation: async () => 0,
    rekeyContinuation: async () => 0,
    dispatch: async (id) => ({ reminderId: id, outcome: "noop" }),
  };
  /** Fires every armed reminder due by `untilMs`, in order, the way `agent/reminders/implement_pr.ts` does. */
  async function advance(untilMs: number, deps: ImplementPrDeps): Promise<void> {
    for (;;) {
      const next = live.filter((each) => each.state === "armed" && each.dueMs <= untilMs).sort((a, b) => a.dueMs - b.dueMs)[0];
      if (next === undefined) break;
      clock.ms = next.dueMs;
      const args = parseImplementPrArgs(next.args);
      assert.ok(args !== undefined, "the reminder's JSON args parse");
      const fired = await fireImplementPrWatch(deps, args, { reminderId: next.id });
      fires.push({ id: next.id, atMin: (clock.ms - T0.getTime()) / MIN, outcome: fired.result.outcome });
      if (fired.rescheduleMs === undefined) next.state = "done";
      else next.dueMs = clock.ms + fired.rescheduleMs;
    }
    clock.ms = untilMs;
  }
  return { api, live, fires, advance, launchWatches, armed: () => live.filter((each) => each.state === "armed") };
}

type World = {
  clock: { ms: number };
  kv: MemoryKv;
  gh: FakeGitHub;
  tracker: FakeTracker;
  run: { facts: AgentRunFacts | undefined; reads: number };
  deps: SweepDeps;
  at: (minutes: number) => number;
};

function world(options: { gh?: FakeGitHub; tracker?: FakeTracker; reminders?: ReminderHostApi } = {}): World {
  const clock = { ms: T0.getTime() };
  const kv = memoryKv();
  const gh = options.gh ?? fakeGitHub();
  const tracker = options.tracker ?? fakeTracker({ comments: [PLAN] });
  const run: World["run"] = { facts: RUNNING, reads: 0 };
  const deps: SweepDeps = {
    kv,
    mcp: tracker.mcp,
    env: ENV,
    now: () => new Date(clock.ms),
    github: gh.github,
    readRun: async () => {
      run.reads += 1;
      return run.facts;
    },
    log: () => {},
    readyRetryMs: [0, 0],
    sleep: async () => {},
    ...(options.reminders === undefined ? {} : { reminders: options.reminders }),
  };
  return { clock, kv, gh, tracker, run, deps, at: (minutes) => T0.getTime() + minutes * MIN };
}

/** Approved → launch → Implementing: → In Progress, through the real handler, with the watch armed on `reminders`. */
async function launch(w: World, reminders: ReminderHostApi | undefined, extra: { backstop?: () => Promise<unknown> } = {}) {
  const handle = createHandler({
    kv: w.kv,
    mcp: w.tracker.mcp,
    createAgent: fakeCreateAgent({ agentId: "bc-tlssn-35" }).createAgent,
    env: ENV,
    now: w.deps.now,
    log: () => {},
    github: w.deps.github,
    readRun: w.deps.readRun,
    ...(reminders === undefined ? {} : { reminders }),
    ...extra,
  });
  const background = backgroundWork();
  await handle(signedRequest(approvedBody({ issueKey: KEY, summary: TITLE })), background);
  const [settled] = await background.settle();
  assert.equal(w.tracker.status(), "In Progress");
  return (settled?.ok ? (settled.value as { prWatch: string }) : undefined)?.prWatch;
}

function jiraWrites(tracker: FakeTracker): string[] {
  return tracker.calls.map((call) => call.tool).filter((tool) => tool === "addCommentToJiraIssue" || tool === "transitionJiraIssue");
}

test("the agent pushes at minute 3 and finishes at 8: the first fire, 10 minutes after the launch, opens the PR once, moves the ticket to In Review, and the watch ends", async () => {
  const w = world();
  const runner = julyRunner(w.clock);
  assert.equal(await launch(w, runner.api), "armed");
  assert.equal(runner.live[0]?.dueMs, w.at(10), "first fire 10 minutes after the launch");
  const writesAtLaunch = jiraWrites(w.tracker).length;

  await runner.advance(w.at(3), w.deps);
  w.run.facts = PUSHED;
  await runner.advance(w.at(8), w.deps);
  w.run.facts = FINISHED;
  await runner.advance(w.at(10) - 1, w.deps);
  assert.deepEqual(w.gh.creates(), [], "nothing before the deadline");
  await runner.advance(w.at(10), w.deps);

  assert.equal(w.gh.creates().length, 1);
  assert.equal(w.gh.creates()[0]?.params["draft"], false);
  assert.match(String(w.gh.creates()[0]?.params["body"]), /The row shows the landmark name\./, "the finished run's final message is the description");
  assert.equal(w.tracker.status(), "In Review");
  assert.deepEqual(jiraWrites(w.tracker).slice(writesAtLaunch), ["addCommentToJiraIssue", "transitionJiraIssue"], "Pull request: <url>, then the one In Review move");
  assert.deepEqual(runner.fires, [{ id: "rem-1", atMin: 10, outcome: "opened" }]);
  assert.deepEqual(runner.armed(), [], "the reminder stopped");
  assert.equal(w.kv.entries.get(implementPrWatchKey(KEY)), undefined, "the watch record is gone");

  await runner.advance(w.at(8 * 60), w.deps);
  assert.equal(w.gh.creates().length, 1, "no second PR, ever");
  assert.equal(runner.fires.length, 1, "it fired once");
});

test("the agent pushes at minute 12: the 10-minute fire finds nothing, polls again at 15, and opens the PR within 5 minutes of the push", async () => {
  const w = world();
  const runner = julyRunner(w.clock);
  await launch(w, runner.api);

  await runner.advance(w.at(12), w.deps);
  assert.deepEqual(runner.fires, [{ id: "rem-1", atMin: 10, outcome: "agent_running" }]);
  assert.deepEqual(w.gh.calls, [], "a run with nothing pushed makes no GitHub call");
  w.run.facts = PUSHED;
  await runner.advance(w.at(60), w.deps);

  assert.deepEqual(runner.fires.map((fire) => [fire.atMin, fire.outcome]), [[10, "agent_running"], [15, "opened"]]);
  assert.equal(w.gh.creates().length, 1);
  assert.equal(w.tracker.status(), "In Review");
  assert.deepEqual(runner.armed(), []);
});

test("an agent that never pushes: the watch polls every 5 minutes, opens nothing, and gives up 8 hours after the launch", async () => {
  const w = world();
  const runner = julyRunner(w.clock);
  await launch(w, runner.api);
  await runner.advance(w.at(9 * 60), w.deps);

  const minutes = runner.fires.map((fire) => fire.atMin);
  assert.equal(minutes[0], 10);
  assert.ok(minutes.every((at, i) => i === 0 || at - minutes[i - 1]! === IMPLEMENT_PR_POLL_MS / MIN), "every 5 minutes");
  assert.equal(minutes.at(-1), IMPLEMENT_PR_MAX_MS / MIN, "the last fire is the one at 8 hours");
  assert.equal(runner.fires.length, (IMPLEMENT_PR_MAX_MS - IMPLEMENT_PR_FIRST_MS) / IMPLEMENT_PR_POLL_MS + 1);
  assert.deepEqual(w.gh.creates(), []);
  assert.deepEqual(runner.armed(), []);
  assert.equal(w.kv.entries.get(implementPrWatchKey(KEY)), undefined);
  assert.equal(w.tracker.status(), "In Progress");
});

test("the PR already exists and the ticket is already In Review: the watch's fire opens nothing, writes nothing to Jira, and stops", async () => {
  const w = world();
  const runner = julyRunner(w.clock);
  await launch(w, runner.api);
  w.run.facts = FINISHED;
  // The first open, as `retry KEY` or the reminder made it; the pull_request.opened delivery then finds it recorded.
  assert.equal((await ensureImplementPr(w.deps, { issueKey: KEY, title: TITLE })).outcome, "opened");
  const githubCalls = w.gh.calls.length;
  const trackerWrites = jiraWrites(w.tracker).length;

  await runner.advance(w.at(10), w.deps);

  assert.deepEqual(runner.fires, [{ id: "rem-1", atMin: 10, outcome: "reused" }]);
  assert.equal(w.gh.creates().length, 1);
  const since = w.gh.calls.slice(githubCalls).map((call) => call.route);
  assert.ok(since.every((route) => route.startsWith("GET ")), `reads only: ${since.join(", ")}`);
  assert.equal(jiraWrites(w.tracker).length, trackerWrites, "no second Pull request: comment, no move");
  assert.equal(w.tracker.status(), "In Review");
  assert.deepEqual(runner.armed(), []);
});

test("a PR the agent or a person opened before the first fire is reused, never duplicated", async () => {
  const w = world({ gh: fakeGitHub({ pulls: [{ number: 31, head: BRANCH, state: "open", draft: false }] }) });
  const runner = julyRunner(w.clock);
  await launch(w, runner.api);
  w.run.facts = FINISHED;
  await runner.advance(w.at(60), w.deps);

  assert.deepEqual(runner.fires.map((fire) => fire.outcome), ["reused"]);
  assert.deepEqual(w.gh.creates(), []);
  assert.equal(w.tracker.status(), "In Review", "the move the missed opened delivery would have made");
});

test("two reminders for one ticket (two arms racing): only the one the record names does the work; the other is superseded without a read", async () => {
  const w = world({ tracker: fakeTracker({ status: "In Progress", comments: [PLAN, `Implementing: ${AGENT_URL}`] }) });
  const runner = julyRunner(w.clock);
  await recordImplementation(w.kv, KEY, { state: "launched", at: T0.toISOString(), agentId: "bc-tlssn-35", url: AGENT_URL, commented: true, moved: true });
  const arms = await Promise.all([
    armImplementPrWatch({ kv: w.kv, reminders: runner.api, now: w.deps.now }, { issueKey: KEY, title: TITLE }),
    armImplementPrWatch({ kv: w.kv, reminders: runner.api, now: w.deps.now }, { issueKey: KEY, title: TITLE }),
  ]);
  assert.deepEqual(arms, ["armed", "armed"]);
  assert.equal(runner.live.length, 2);
  const recorded = (w.kv.entries.get(implementPrWatchKey(KEY)) as { reminderId: string }).reminderId;

  w.run.facts = FINISHED;
  await runner.advance(w.at(10), w.deps);

  assert.deepEqual(
    runner.fires.map((fire) => [fire.id, fire.outcome]).sort(),
    [[recorded, "opened"], [recorded === "rem-1" ? "rem-2" : "rem-1", "superseded"]].sort()
  );
  assert.equal(w.run.reads, 1, "the superseded fire read nothing");
  assert.equal(w.gh.creates().length, 1);
  assert.deepEqual(runner.armed(), []);
});

test("a re-arm that lands while a fire is reading keeps its reminder: the fire's poll update does not restore the old one", async () => {
  const w = world();
  const runner = julyRunner(w.clock);
  await launch(w, runner.api);
  const key = implementPrWatchKey(KEY);
  const readRun = w.deps.readRun!;
  const deps: SweepDeps = {
    ...w.deps,
    readRun: async (...args) => {
      await w.kv.put(key, { ...(w.kv.entries.get(key) as JsonObject), reminderId: "rem-new" });
      return readRun(...args);
    },
  };

  const fired = await fireImplementPrWatch(deps, { issueKey: KEY, armedAt: T0.toISOString(), title: TITLE }, { reminderId: "rem-1" });

  assert.equal(fired.rescheduleMs, IMPLEMENT_PR_POLL_MS);
  assert.equal((w.kv.entries.get(key) as { reminderId?: string }).reminderId, "rem-new");
});

test("reminder create fails at launch: the record is still written and indexed, and the backstop sweep opens the PR at the deadline, once", async () => {
  const w = world();
  const runner = julyRunner(w.clock, { failCreate: true });
  assert.equal(await launch(w, runner.api), "failed");
  assert.deepEqual(w.kv.entries.get(IMPLEMENT_PR_INDEX), [KEY]);
  assert.equal((w.kv.entries.get(implementPrWatchKey(KEY)) as { dueAt: string }).dueAt, new Date(w.at(10)).toISOString());
  const deps = { ...w.deps, reminders: runner.api };
  w.run.facts = FINISHED;

  w.clock.ms = w.at(9);
  assert.deepEqual(await sweepImplementPrWatches(deps), [], "not due: the sweep only tries the arm again");
  assert.deepEqual(w.gh.calls, []);

  w.clock.ms = w.at(10);
  assert.deepEqual(await sweepImplementPrWatches(deps), [{ issueKey: KEY, outcome: "opened" }]);
  assert.equal(w.gh.creates().length, 1);
  assert.equal(w.tracker.status(), "In Review");
  assert.equal(w.kv.entries.get(implementPrWatchKey(KEY)), undefined);
  assert.deepEqual(w.kv.entries.get(IMPLEMENT_PR_INDEX), [], "the finished watch leaves the index");

  w.clock.ms = w.at(30);
  assert.deepEqual(await sweepImplementPrWatches(deps), []);
  assert.equal(w.gh.creates().length, 1);
});

test("a reminder that never fires: the sweep leaves it alone through the grace, then fires the watch, cancels the lost reminder, and arms one new poller", async () => {
  const w = world();
  const runner = julyRunner(w.clock);
  await launch(w, runner.api);
  const deps = { ...w.deps, reminders: runner.api };

  w.clock.ms = w.at(10) + IMPLEMENT_PR_GRACE_MS - 1;
  assert.deepEqual(await sweepImplementPrWatches(deps), [], "a late reminder inside the grace is left to fire");
  assert.equal(w.run.reads, 0);

  w.clock.ms = w.at(10) + IMPLEMENT_PR_GRACE_MS;
  assert.deepEqual(await sweepImplementPrWatches(deps), [{ issueKey: KEY, outcome: "agent_running", rearmed: "armed" }]);
  assert.equal(runner.live[0]?.state, "cancelled");
  assert.deepEqual(runner.armed().map((each) => each.id), ["rem-2"]);
  assert.equal(runner.armed()[0]?.dueMs, w.clock.ms + IMPLEMENT_PR_POLL_MS);
  assert.equal((w.kv.entries.get(implementPrWatchKey(KEY)) as { reminderId: string }).reminderId, "rem-2");
  assert.equal((w.kv.entries.get(implementPrWatchKey(KEY)) as { armedAt: string }).armedAt, T0.toISOString(), "the 8-hour lifetime still counts from the launch");

  // The lost reminder wakes after all: it is not the one the record names.
  const late = await fireImplementPrWatch(deps, { issueKey: KEY, title: TITLE, armedAt: T0.toISOString() }, { reminderId: "rem-1" });
  assert.deepEqual(late, { result: { outcome: "superseded" } });

  w.run.facts = PUSHED;
  await runner.advance(w.at(60), deps);
  assert.deepEqual(runner.fires.map((fire) => [fire.id, fire.outcome]), [["rem-2", "opened"]]);
  assert.equal(w.gh.creates().length, 1);
});

test("`retry KEY` while the agent still works re-arms a watch whose reminder was lost, and leaves a healthy one alone", async () => {
  const w = world();
  const runner = julyRunner(w.clock);
  await launch(w, runner.api);
  const retry = async (changelogId: string) => {
    const lines: string[] = [];
    const handle = createHandler({ kv: w.kv, mcp: w.tracker.mcp, createAgent: fakeCreateAgent().createAgent, env: ENV, now: w.deps.now, log: (line) => lines.push(line), github: w.deps.github, readRun: w.deps.readRun, reminders: runner.api });
    const background = backgroundWork();
    await handle(signedRequest(approvedBody({ issueKey: KEY, summary: TITLE, fromStatus: "In Progress", changelogId })), background);
    await background.settle();
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line["worker"] === "implement_pr");
  };

  w.clock.ms = w.at(5);
  assert.equal((await retry("20040"))?.["prWatch"], "already", "the launch's reminder is still due");
  assert.equal(runner.live.length, 1);

  w.clock.ms = w.at(10) + IMPLEMENT_PR_GRACE_MS;
  assert.equal((await retry("20041"))?.["prWatch"], "armed", "the launch's reminder never fired");
  assert.deepEqual(runner.live.map((each) => each.state), ["cancelled", "armed"]);
});

test("with no reminders at all the watch is still recorded, and the sweep polls it", async () => {
  const w = world();
  assert.equal(await launch(w, undefined), "unavailable");
  assert.deepEqual(w.kv.entries.get(IMPLEMENT_PR_INDEX), [KEY]);

  w.clock.ms = w.at(10);
  assert.deepEqual(await sweepImplementPrWatches(w.deps), [{ issueKey: KEY, outcome: "agent_running" }]);
  assert.equal((w.kv.entries.get(implementPrWatchKey(KEY)) as { dueAt: string }).dueAt, new Date(w.at(15)).toISOString());
  w.run.facts = PUSHED;
  w.clock.ms = w.at(14);
  assert.deepEqual(await sweepImplementPrWatches(w.deps), [], "not due yet");
  w.clock.ms = w.at(15);
  assert.deepEqual(await sweepImplementPrWatches(w.deps), [{ issueKey: KEY, outcome: "opened" }]);
  assert.equal(w.gh.creates().length, 1);
});

test("the v2 deploy manifest declares no schedule, so deliveries and reminder fires are the backstop's only triggers", async () => {
  const cli = fileURLToPath(new URL("../../node_modules/@cursor/july/dist/bin/agent-serve.js", import.meta.url));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [cli, "manifest", "--dir", root, "--json"]);
  const manifest = JSON.parse(stdout) as { declarations: { architecture?: string; schedules?: unknown[] } };
  assert.equal(manifest.declarations.architecture, "v2");
  assert.deepEqual(manifest.declarations.schedules, []);
  const info = JSON.parse((await run(process.execPath, [cli, "info", "--dir", root, "--json"])).stdout) as { agents: Array<{ reminders: Array<{ name: string }> }> };
  assert.equal(info.agents.length, 1);
  assert.ok(info.agents[0].reminders.some((reminder) => reminder.name === "implement_pr"), JSON.stringify(info.agents[0].reminders));
});

test("the backstop is idle with no watches, runs at most once per window, and a hung sweep is cut off", async () => {
  const w = world();
  let sweeps = 0;
  const sweep = async () => {
    sweeps += 1;
    return [];
  };
  assert.deepEqual(await backstopImplementPrSweep(w.deps, { sweep }), { swept: false, why: "idle" });
  assert.equal(w.kv.entries.get(IMPLEMENT_PR_SWEEP_KEY), undefined);

  await w.kv.put(IMPLEMENT_PR_INDEX, [KEY]);
  assert.deepEqual(await backstopImplementPrSweep(w.deps, { sweep }), { swept: true, fires: [] });
  w.clock.ms += IMPLEMENT_PR_SWEEP_EVERY_MS - 1;
  assert.deepEqual(await backstopImplementPrSweep(w.deps, { sweep }), { swept: false, why: "throttled" });
  w.clock.ms += 1;
  assert.deepEqual(await backstopImplementPrSweep(w.deps, { sweep }), { swept: true, fires: [] });
  assert.equal(sweeps, 2);

  w.clock.ms += IMPLEMENT_PR_SWEEP_EVERY_MS;
  const hung = await backstopImplementPrSweep(w.deps, { timeoutMs: 5, sweep: () => new Promise(() => {}) });
  assert.deepEqual(hung, { swept: false, why: "timeout" });
  const threw = await backstopImplementPrSweep({ ...w.deps, now: () => new Date(w.clock.ms + IMPLEMENT_PR_SWEEP_EVERY_MS) }, { sweep: async () => Promise.reject(new Error("kv down")) });
  assert.deepEqual(threw, { swept: false, why: "threw" });
});

test("the Jira route runs the backstop after every verified delivery, never for an unsigned one; a pull_request task runs it even when its own work throws", async () => {
  const w = world();
  let backstops = 0;
  const handle = createHandler({ kv: w.kv, mcp: w.tracker.mcp, createAgent: fakeCreateAgent().createAgent, env: ENV, now: w.deps.now, log: () => {}, backstop: async () => (backstops += 1) });

  const unsigned = backgroundWork();
  const refused = await handle(signedRequest(approvedBody({ issueKey: KEY, summary: TITLE }), "wrong-secret"), unsigned);
  assert.equal(refused.status, 401);
  await unsigned.settle();
  assert.equal(backstops, 0);

  const ignored = backgroundWork();
  await handle(signedRequest(approvedBody({ issueKey: KEY, summary: TITLE, toStatus: "Planned" })), ignored);
  await ignored.settle();
  assert.equal(backstops, 1, "a verified delivery the worker ignores still sweeps");

  assert.equal(withImplementPrBackstop(null, async () => (backstops += 1)), null, "a skipped pull_request delivery stays skipped");
  const wrapped = withImplementPrBackstop({ task: async () => Promise.reject(new Error("left draft")) }, async () => (backstops += 1));
  await assert.rejects(wrapped!.task(), /left draft/, "the task's own retry signal survives");
  assert.equal(backstops, 2);
});

test("index writers on one pod apply one after another, so a prune cannot drop a concurrent arm", async () => {
  const inner = memoryKv();
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  let releaseFirst!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let held = false;
  // The prune's put waits until released; the arm's index write must wait behind it.
  const kv: MemoryKv = {
    ...inner,
    put: async (key, value) => {
      if (key === IMPLEMENT_PR_INDEX && !held) {
        held = true;
        firstEntered();
        await hold;
      }
      await inner.put(key, value);
    },
  };

  await inner.put(IMPLEMENT_PR_INDEX, ["TLSSN-1"]);
  const prune = pruneImplementPrIndex(kv, { gone: new Set(["TLSSN-1"]), env: ENV });
  const arm = armImplementPrWatch({ kv, reminders: undefined, now: () => T0, env: ENV }, { issueKey: KEY, title: TITLE });
  await entered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await readImplementPrIndex(inner), ["TLSSN-1"], "the arm waits for the prune's write");
  releaseFirst();
  await Promise.all([prune, arm]);
  assert.deepEqual(await readImplementPrIndex(inner), [KEY]);
});

test("a watch armed while the sweep prunes a stale key stays in the index", async () => {
  const w = world();
  const runner = julyRunner(w.clock);
  await w.kv.put(IMPLEMENT_PR_INDEX, ["TLSSN-1"]);
  const [fires, armed] = await Promise.all([
    sweepImplementPrWatches({ ...w.deps, reminders: runner.api }),
    armImplementPrWatch({ kv: w.kv, reminders: runner.api, now: w.deps.now }, { issueKey: KEY, title: TITLE }),
  ]);
  assert.deepEqual(fires, []);
  assert.equal(armed, "armed");
  assert.deepEqual(await readImplementPrIndex(w.kv), [KEY]);
  assert.notEqual(w.kv.entries.get(implementPrWatchKey(KEY)), undefined);
});

test("another pod's arm that lands while the sweep checks which keys are gone stays in the index", async () => {
  const w = world();
  await w.kv.put(IMPLEMENT_PR_INDEX, ["TLSSN-1"]);
  const staleKey = implementPrWatchKey("TLSSN-1");
  let staleReads = 0;
  const kv: MemoryKv = {
    ...w.kv,
    get: async (key) => {
      if (key === staleKey && ++staleReads === 2) {
        // Pod B arms KEY with its own read-modify-write, outside this pod's queue.
        await w.kv.put(implementPrWatchKey(KEY), { armedAt: T0.toISOString(), dueAt: new Date(w.at(10)).toISOString() });
        await w.kv.put(IMPLEMENT_PR_INDEX, [...(await readImplementPrIndex(w.kv)), KEY]);
      }
      return w.kv.get(key);
    },
  };

  await sweepImplementPrWatches({ ...w.deps, kv });

  assert.equal(staleReads, 3, "the prune verified the stale key, and re-read it after the prune");
  assert.deepEqual(await readImplementPrIndex(w.kv), [KEY]);
});

test("an index entry another pod's prune dropped comes back: the arm re-adds it even when the reminder create fails, and every pending fire re-adds it", async () => {
  const w = world();
  const dropping: ReminderHostApi = {
    ...fakeReminders().api,
    create: async () => {
      await w.kv.put(IMPLEMENT_PR_INDEX, []);
      throw new Error("platform timers unavailable");
    },
  };
  assert.equal(await armImplementPrWatch({ kv: w.kv, reminders: dropping, now: w.deps.now }, { issueKey: KEY, title: TITLE }), "failed");
  assert.deepEqual(await readImplementPrIndex(w.kv), [KEY], "the arm put the dropped key back");

  await recordImplementation(w.kv, KEY, { state: "launched", at: T0.toISOString(), agentId: "bc-tlssn-35", url: AGENT_URL, commented: true, moved: true });
  await w.kv.put(IMPLEMENT_PR_INDEX, []);
  const fired = await fireImplementPrWatch(w.deps, { issueKey: KEY, armedAt: T0.toISOString(), title: TITLE });
  assert.equal(fired.rescheduleMs, IMPLEMENT_PR_POLL_MS);
  assert.deepEqual(await readImplementPrIndex(w.kv), [KEY], "the pending fire put it back");
});

test("a pending fire's self-heal costs at most 9 index calls, however the stored list moves", async () => {
  const w = world();
  await recordImplementation(w.kv, KEY, { state: "launched", at: T0.toISOString(), agentId: "bc-tlssn-35", url: AGENT_URL, commented: true, moved: true });
  const index: string[] = [];
  // Every read of the index shows another writer's list without KEY, so each attempt reads, puts, and reads back.
  const kv: MemoryKv = {
    ...w.kv,
    get: async (key) => {
      if (key !== IMPLEMENT_PR_INDEX) return w.kv.get(key);
      index.push("get");
      return [`OTHER-${index.length}`];
    },
    put: async (key, value) => {
      if (key === IMPLEMENT_PR_INDEX) index.push("put");
      await w.kv.put(key, value);
    },
  };
  const fired = await fireImplementPrWatch({ ...w.deps, kv }, { issueKey: KEY, armedAt: T0.toISOString(), title: TITLE });
  assert.equal(fired.rescheduleMs, IMPLEMENT_PR_POLL_MS);
  assert.equal(index.length, 9);
});

test("a stale fire from a watch record older than dueAt still parses, and the sweep keeps an unreadable key in the index", async () => {
  const w = world({ reminders: fakeReminders().api });
  await recordImplementation(w.kv, KEY, { state: "launched", at: T0.toISOString(), agentId: "bc-tlssn-35", url: AGENT_URL, commented: true, moved: true });
  await w.kv.put(implementPrWatchKey(KEY), { armedAt: T0.toISOString(), reminderId: "rem-old" });
  await w.kv.put(IMPLEMENT_PR_INDEX, [KEY]);
  w.clock.ms = w.at(10) + IMPLEMENT_PR_GRACE_MS - 1;
  assert.deepEqual(await sweepImplementPrWatches(w.deps), [], "a pre-dueAt record is due at its first fire, plus the grace");
  w.clock.ms = w.at(10) + IMPLEMENT_PR_GRACE_MS;
  assert.equal((await sweepImplementPrWatches(w.deps))[0]?.outcome, "agent_running");

  const flaky = { ...w.deps, kv: { ...w.kv, get: async (key: string) => (key === implementPrWatchKey(KEY) ? Promise.reject(new Error("kv down")) : w.kv.get(key)) } };
  assert.deepEqual(await sweepImplementPrWatches(flaky), []);
  assert.deepEqual(w.kv.entries.get(IMPLEMENT_PR_INDEX), [KEY]);
});

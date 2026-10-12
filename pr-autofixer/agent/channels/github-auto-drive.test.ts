import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelHandlerArgs, HostKvApi } from "@cursor/july";
import { dispatchGitHubWebhook, getGitHubChannelOptions } from "@cursor/july/channels/github";
import driveClaimHook from "../hooks/drive-claim.js";

// Hosted v2 never forwards check_run, and Actions never emit status, so a
// red check on hosted arrives as check_suite (or workflow_run) completed.
// These run with the channel runtime bound, in their own file so the
// runtime-unset tests in github.test.ts keep their premise.

const REPO = "acme/in-scope";
process.env.FACTORY_REPOS = REPO;
process.env.FACTORY_JIRA_PROJECTS = "TLSSN";
process.env.PR_AUTOFIXER_BIND_WAIT_MS = "400";
// Every drive claim settles, for 1 ms so the file runs in seconds.
process.env.FACTORY_FIXER_CLAIM_SETTLE_MS = "1";
delete process.env.PR_AUTOFIXER_REPOS;
delete process.env.PR_AUTOFIXER_AUTO_DRIVE_PROJECTS;

const channelReady = import("./github.js");

const HEADS: Record<number, { headRefName: string; title: string; author?: string }> = {
  3: { headRefName: "TLSSN-3-fix-interest-rounding", title: "Fix interest rounding" },
  4: { headRefName: "TLSSN-4-add-audit-log", title: "Add audit log" },
  5: { headRefName: "fix-typo", title: "Fix typo in README" },
  6: { headRefName: "TLSSN-6-retry-export", title: "Retry export" },
  14: { headRefName: "TLSSN-14-fix-fees", title: "Fix fees" },
  15: { headRefName: "TLSSN-15-fix-limits", title: "Fix limits" },
  21: { headRefName: "TLSSN-21-fix-export", title: "Fix export" },
  // A person's own branch, titled with the ticket key the way people do.
  22: { headRefName: "feature/export-fix", title: "TLSSN-22: fix the export", author: "example-user" },
  // The platform's autoCreatePR: cursor[bot] opened it and only the title carries the key.
  23: { headRefName: "cursor/fix-the-export-1a2b", title: "TLSSN-23: fix the export", author: "cursor[bot]" },
  26: { headRefName: "TLSSN-26-fix-statements", title: "Fix statements" },
  27: { headRefName: "TLSSN-27-fix-transfers", title: "Fix transfers" },
  38: { headRefName: "TLSSN-38-activity-csv", title: "TLSSN-38: CSV download on Activity", author: "cursor[bot]" },
  40: { headRefName: "TLSSN-40-fees", title: "TLSSN-40: fees" },
  41: { headRefName: "TLSSN-41-limits", title: "TLSSN-41: limits" },
  39: { headRefName: "TLSSN-39-statement-dates", title: "TLSSN-39: statement dates" },
  42: { headRefName: "TLSSN-42-bind-late", title: "TLSSN-42: bind late" },
  43: { headRefName: "TLSSN-43-never-binds", title: "TLSSN-43: never binds" },
  44: { headRefName: "TLSSN-44-send-fails", title: "TLSSN-44: send fails" },
  45: { headRefName: "TLSSN-45-read-fails", title: "TLSSN-45: read fails" },
  46: { headRefName: "TLSSN-46-never-readable", title: "TLSSN-46: never readable" },
  47: { headRefName: "TLSSN-47-outage-while-waiting", title: "TLSSN-47: outage while waiting" },
  48: { headRefName: "TLSSN-48-reopened", title: "TLSSN-48: reopened" },
  49: { headRefName: "TLSSN-49-closed-kept", title: "TLSSN-49: closed, cleanup off" },
  50: { headRefName: "TLSSN-50-closed-mid-drive", title: "TLSSN-50: closed mid-drive" },
  52: { headRefName: "TLSSN-52-close-unread", title: "TLSSN-52: close while GitHub is down" },
  53: { headRefName: "TLSSN-53-stale-open", title: "TLSSN-53: GitHub still says open" },
  54: { headRefName: "TLSSN-54-closed-then-touched", title: "TLSSN-54: closed, then commented on" },
  55: { headRefName: "TLSSN-55-merged-github-down", title: "TLSSN-55: merged while GitHub is down" },
  56: { headRefName: "TLSSN-56-merged-by-github", title: "TLSSN-56: merged, event without the flag" },
};
// Reads of these PRs that github-proxy answers 502 before it answers the PR.
const PR_READ_FAILURES: Record<number, number> = { 26: Number.POSITIVE_INFINITY, 27: 1 };
// What GitHub answers for a PR's state (unlisted PRs are open; `unreachable` fails the read) and its updated_at.
const PR_STATES: Record<number, "open" | "closed" | "merged" | "unreachable"> = {};
const T0 = "2026-09-29T08:00:00Z";
const PR_UPDATED_AT: Record<number, string> = {};
// Armed merge-conflict watches, and what the channel lists and cancels.
type Watch = { id: string; purpose: string; target: Record<string, unknown> };
const armedWatches: Watch[] = [];
const reminderCalls: string[] = [];
const reminders = {
  list: async () => {
    reminderCalls.push("list");
    return armedWatches.slice();
  },
  cancel: async (id: string) => {
    reminderCalls.push(`cancel ${id}`);
    const at = armedWatches.findIndex((watch) => watch.id === id);
    if (at >= 0) armedWatches.splice(at, 1);
  },
  create: async () => ({ id: `rem_${armedWatches.length}` }),
};
// What GitHub's comment endpoint answers for author_association, by comment id.
const COMMENT_ASSOCIATIONS: Record<number, string> = { 612: "COLLABORATOR" };
const commentLookups: string[] = [];

const repository = {
  full_name: REPO,
  name: "in-scope",
  html_url: `https://github.com/${REPO}`,
  owner: { login: "acme" },
};

function checkSuitePayload(number: number, conclusion: string) {
  return {
    action: "completed",
    repository,
    check_suite: {
      id: 9000 + number,
      head_sha: String(number).repeat(40).slice(0, 40),
      status: "completed",
      conclusion,
      app: { slug: "github-actions", name: "GitHub Actions" },
      pull_requests: [{ number, url: `https://github.com/${REPO}/pull/${number}` }],
    },
    sender: { login: "github-actions[bot]", type: "Bot", id: 41898282 },
  };
}

function workflowRunPayload(number: number, conclusion: string) {
  return {
    action: "completed",
    repository,
    workflow_run: {
      id: 7000 + number,
      name: "CI",
      head_sha: String(number).repeat(40).slice(0, 40),
      status: "completed",
      conclusion,
      pull_requests: [{ number, url: `https://github.com/${REPO}/pull/${number}` }],
    },
    sender: { login: "github-actions[bot]", type: "Bot", id: 41898282 },
  };
}

const store = new Map<string, unknown>();
const kv: HostKvApi = {
  get: async (key) => store.get(key) as never,
  put: async (key, value) => { store.set(key, value); },
  delete: async (key) => { store.delete(key); },
};
type CapturedSend = { message: string; options: { continuationToken?: string; cloud?: { repos?: Array<{ prUrl?: string }> } } };
const drives: CapturedSend[] = [];
const prComments: Array<{ number: number; body: string }> = [];
// The check runs each cursor check suite holds (check_suite id 9000 + PR number).
const SUITE_RUNS: Record<number, Array<{ name: string; conclusion: string }>> = {
  9038: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9040: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9041: [{ name: "Cursor Change Monitor", conclusion: "neutral" }],
  9042: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9043: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9044: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9045: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9046: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9047: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9048: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9049: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
  9050: [{ name: "Cursor Bugbot", conclusion: "neutral" }],
};
const hostGithub = {
  getOctokit: async () => ({
    graphql: async () => {
      throw Object.assign(new Error("Missing x-cursor-github-repos header"), { status: 400 });
    },
    request: async (route: string, params: { pull_number: number; comment_id?: number; check_suite_id?: number; issue_number?: number; body?: string }) => {
      if (route.includes("/check-suites/")) {
        return { data: { check_runs: SUITE_RUNS[params.check_suite_id ?? 0] ?? [] } };
      }
      if (route.startsWith("POST ") && route.endsWith("/comments")) {
        prComments.push({ number: params.issue_number ?? 0, body: params.body ?? "" });
        return { data: {} };
      }
      if (route.includes("/comments/")) {
        commentLookups.push(route);
        const association = COMMENT_ASSOCIATIONS[params.comment_id ?? 0];
        if (association === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { author_association: association } };
      }
      const failures = PR_READ_FAILURES[params.pull_number] ?? 0;
      if (failures > 0) {
        PR_READ_FAILURES[params.pull_number] = failures - 1;
        throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      }
      const head = HEADS[params.pull_number];
      if (head === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
      const state = PR_STATES[params.pull_number] ?? "open";
      if (state === "unreachable") throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      const updatedAt = PR_UPDATED_AT[params.pull_number] ?? T0;
      return { data: { head: { ref: head.headRefName }, title: head.title, state: state === "merged" ? "closed" : state, merged: state === "merged", updated_at: updatedAt, ...(head.author === undefined ? {} : { user: { login: head.author } }) } };
    },
  }),
};
// Hosted v2 runs the task inside the admission window: the onStart-bound send
// and any tool's ctx.send throw there, and only the delivery's own send is
// captured, returning a handle whose fields throw until the session exists.
const admissionRefusal = async () => {
  throw new Error("send() reached the local engine during hosted admission.");
};
const callTool = admissionRefusal;
// A buffered wake flushes after admission, where the channel's own send runs: recorded here.
type Wake = { message: string; options: { sdkAgentId?: string; cloud?: { repos?: Array<{ prUrl?: string }> } } };
const wakes: Wake[] = [];
let laterSendFailures = 0;
const laterSend = async (message: string, options: Wake["options"] = {}) => {
  if (laterSendFailures > 0) {
    laterSendFailures -= 1;
    throw new Error("send failed");
  }
  wakes.push({ message, options });
  return { waitForCompletion: async () => undefined };
};
function wakesFor(number: number) {
  return wakes.filter((call) => call.options.cloud?.repos?.[0]?.prUrl === `https://github.com/${REPO}/pull/${number}`);
}
function inertSession() {
  const unavailable = () => { throw new Error("deferred channel session"); };
  return { get id() { return unavailable(); }, get info() { return unavailable(); } };
}
const deliverySend = async (message: string, options: CapturedSend["options"] = {}) => {
  drives.push({ message, options });
  return inertSession();
};

let started: Promise<void> | undefined;

async function ready() {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) throw new Error("github channel options were not recorded");
  started ??= Promise.resolve(
    options.onStart?.({ send: laterSend, host: { github: hostGithub, kv, reminders }, callTool } as never)
  );
  await started;
  return options;
}

async function deliver(eventName: string, payload: unknown) {
  const options = await ready();
  const background: Promise<unknown>[] = [];
  const args = {
    params: {},
    requestIp: null,
    auth: null,
    host: { github: hostGithub, kv },
    artifacts: {},
    send: deliverySend,
    getSession: async () => null,
    receive: async () => { throw new Error("receive ran"); },
    callTool,
    waitUntil(promise: Promise<unknown>) { background.push(promise); },
    sessionUrls: () => ({ playgroundUrl: "http://127.0.0.1/", traceUrl: "http://127.0.0.1/" }),
  } as unknown as ChannelHandlerArgs;
  const response = await dispatchGitHubWebhook({ options, eventName, payload, args });
  await Promise.all(background);
  return (await response.json()) as { dispatched?: boolean; skipped?: boolean; reason?: string };
}

function drivesFor(number: number) {
  return drives.filter((call) => call.options.cloud?.repos?.[0]?.prUrl === `https://github.com/${REPO}/pull/${number}`);
}

test("a failed check_suite on a factory branch drives once; a second failed check_suite does not", async () => {
  const first = await deliver("check_suite", checkSuitePayload(3, "failure"));
  assert.equal(first.dispatched, true);
  assert.equal(drivesFor(3).length, 1);
  const [drive] = drivesFor(3);
  assert.match(drive?.message ?? "", /https:\/\/github\.com\/acme\/in-scope\/pull\/3/);
  assert.equal(drive?.options.continuationToken, undefined);
  assert.equal(store.has(`auto-drive:${REPO}#3`), true);

  const second = await deliver("check_suite", checkSuitePayload(3, "timed_out"));
  assert.equal(second.skipped, true);
  assert.equal(drivesFor(3).length, 1);
});

// marsbank #38: Bugbot's "1 finding" is a neutral conclusion on the cursor app's suite, and nothing drove the PR.
test("Bugbot's neutral check_suite on a factory PR drives it with a Bugbot brief; a neutral suite from another app does not", async () => {
  const bugbot = { ...checkSuitePayload(38, "neutral") };
  bugbot.check_suite = { ...bugbot.check_suite, app: { slug: "cursor", name: "Cursor" } };
  const body = await deliver("check_suite", bugbot);
  assert.equal(body.dispatched, true);
  assert.equal(drivesFor(38).length, 1);
  assert.match(drivesFor(38)[0]?.message ?? "", /Bugbot reported findings on TLSSN-38's pull request/);

  const other = await deliver("check_suite", checkSuitePayload(39, "neutral"));
  assert.equal(other.skipped, true);
  assert.equal(drivesFor(39).length, 0);

  // A neutral cursor suite whose runs hold no Bugbot run (Change Monitor, say) is no finding.
  const monitor = checkSuitePayload(41, "neutral");
  monitor.check_suite = { ...monitor.check_suite, app: { slug: "cursor", name: "Cursor" } };
  assert.equal((await deliver("check_suite", monitor)).skipped, true);
  assert.equal(drivesFor(41).length, 0);
});

// Verifier and Bugbot: a round was spent before the claim, while a finished
// drive still held the PR, so round 2 drove nothing and round 3 posted the cap
// note after one real round. The drive's own hooks now bind its agent and free
// the claim when its turn completes; the next head wakes that agent, and a
// round is spent only when a follow-up is actually sent.
test("Bugbot rounds follow real drives: head a drives, head b wakes the bound agent, head c posts one cap note, head d is silent", async () => {
  const bugbotSuite = (sha: string) => {
    const payload = checkSuitePayload(40, "neutral");
    payload.check_suite = { ...payload.check_suite, head_sha: sha.repeat(40).slice(0, 40), app: { slug: "cursor", name: "Cursor" } };
    return payload;
  };
  const hookEvents = driveClaimHook.events as unknown as Record<string, (event: unknown, ctx: unknown) => Promise<void>>;
  const hookCtx = { channel: { id: "github", continuationToken: null }, session: { id: "ses_drive_40", title: `PR ${REPO}#40` }, host: { kv } };
  const flushed = () => new Promise((resolve) => setTimeout(resolve, 3_300));

  assert.equal((await deliver("check_suite", bugbotSuite("a"))).dispatched, true);
  assert.equal(drivesFor(40).length, 1);
  await deliver("check_suite", bugbotSuite("a"));
  assert.equal(drivesFor(40).length, 1, "findings while the drive holds the PR are buffered for it, not a second drive");
  await flushed();
  assert.equal(wakesFor(40).length, 0, "the same head is no second round");

  // What the drive's session does: its first turn starts, its cloud agent binds, the turn completes.
  await hookEvents["turn.started"]!({ data: {} }, hookCtx);
  await hookEvents["agent.bound"]!({ data: { sdkAgentId: "bc-drive40" } }, hookCtx);
  await hookEvents["turn.completed"]!({ data: {} }, hookCtx);
  assert.equal(store.has(`auto-drive:${REPO}#40`), false, "a completed drive frees the PR");

  await deliver("check_suite", bugbotSuite("b"));
  await flushed();
  assert.equal(drivesFor(40).length, 1, "no second agent");
  assert.equal(wakesFor(40).length, 1, "head b wakes the bound agent: round 2");

  await deliver("check_suite", bugbotSuite("c"));
  await flushed();
  assert.equal(wakesFor(40).length, 1, "past the cap: no third round");
  assert.deepEqual(prComments.filter((comment) => comment.number === 40).map((comment) => comment.body), [
    "Bugbot still reports findings after 2 automatic fix rounds, so the factory stopped fixing them. A person needs to review the remaining Bugbot threads.",
  ]);
  await deliver("check_suite", bugbotSuite("d"));
  await flushed();
  assert.equal(prComments.filter((comment) => comment.number === 40).length, 1, "the note is posted once");
  assert.equal(wakesFor(40).length, 1);
});

function bugbotSuiteFor(number: number, sha: string) {
  const payload = checkSuitePayload(number, "neutral");
  payload.check_suite = { ...payload.check_suite, head_sha: sha.repeat(40).slice(0, 40), app: { slug: "cursor", name: "Cursor" } };
  return payload;
}
function driveHooks(number: number) {
  const events = driveClaimHook.events as unknown as Record<string, (event: unknown, ctx: unknown) => Promise<void>>;
  const ctx = { channel: { id: "github", continuationToken: null }, session: { id: `ses_drive_${number}`, title: `PR ${REPO}#${number}` }, host: { kv } };
  return {
    started: () => events["turn.started"]!({ data: {} }, ctx),
    bound: () => events["agent.bound"]!({ data: { sdkAgentId: `bc-drive${number}` } }, ctx),
    completed: () => events["turn.completed"]!({ data: {} }, ctx),
  };
}
const BUGBOT_ROUNDS_CAP = 2;
const roundsOf = (number: number) => (store.get(`bugbot-rounds:${REPO}#${number}`) as { rounds?: number } | undefined)?.rounds ?? 0;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Verifier round 4 and Bugbot: findings buffered while a drive held the PR
// flushed after 3 s, found no affinity, and were dropped with no log.
test("Bugbot findings that arrive before the drive's agent binds wait for the bind and then reach that agent", async () => {
  const hooks = driveHooks(42);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(42, "a"))).dispatched, true);
  await hooks.started();
  await deliver("check_suite", bugbotSuiteFor(42, "b"));
  await pause(3_300);
  assert.equal(wakesFor(42).length, 0, "no agent yet: nothing sent");
  assert.equal(roundsOf(42), 1, "and no round spent while waiting");
  await hooks.bound();
  await pause(900);
  assert.equal(wakesFor(42).length, 1, "the waiting findings reach the agent once it binds");
  assert.equal(wakesFor(42)[0]!.options.sdkAgentId, "bc-drive42");
  assert.equal(roundsOf(42), 2);
  assert.equal(drivesFor(42).length, 1);
});

test("Bugbot findings waiting on a drive that ends unbound start a fresh drive, spending the round only then", async () => {
  const hooks = driveHooks(43);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(43, "a"))).dispatched, true);
  await hooks.started();
  await deliver("check_suite", bugbotSuiteFor(43, "b"));
  await pause(3_300);
  assert.equal(wakesFor(43).length, 0);
  await hooks.completed();
  assert.equal(store.has(`auto-drive:${REPO}#43`), false, "the unbound drive's claim went with its turn");
  await pause(900);
  assert.equal(wakesFor(43).length, 1, "a fresh drive started for the findings");
  assert.match(wakesFor(43)[0]!.message, /Bugbot/);
  assert.equal(roundsOf(43), 2);
});

// Verifier round 4 and Bugbot: the round was spent before runtime.send, so a
// failed send's retry was refused as a duplicate head and never sent.
test("a Bugbot follow-up whose send fails is sent again by the retry, and its round is spent once", async () => {
  const hooks = driveHooks(44);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(44, "a"))).dispatched, true);
  await hooks.started();
  await hooks.bound();
  await hooks.completed();
  laterSendFailures = 1;
  await deliver("check_suite", bugbotSuiteFor(44, "b"));
  await pause(3_300);
  assert.equal(wakesFor(44).length, 0, "the first send failed");
  assert.equal(roundsOf(44), 1, "and spent nothing");
  await pause(3_300);
  assert.equal(wakesFor(44).length, 1, "the retry sends it");
  assert.equal(roundsOf(44), 2);
});

// Verifier round 5 and Bugbot: the unbound-drive fallback claimed the PR and
// then read it; a read that failed kept the claim for START_LEASE_MS, so the
// next red check was skipped.
test("a waiting Bugbot wake whose PR read fails claims nothing, so a red check drives once GitHub recovers", async () => {
  const hooks = driveHooks(45);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(45, "a"))).dispatched, true);
  await hooks.started();
  await deliver("check_suite", bugbotSuiteFor(45, "b"));
  await pause(3_300);
  PR_READ_FAILURES[45] = Number.POSITIVE_INFINITY;
  await hooks.completed();
  await pause(2_000);
  assert.equal(store.has(`auto-drive:${REPO}#45`), false, "the failed read left no claim");
  assert.equal(drivesFor(45).length, 1);

  PR_READ_FAILURES[45] = 0;
  const red = checkSuitePayload(45, "failure");
  red.check_suite = { ...red.check_suite, id: 9145 };
  assert.equal((await deliver("check_suite", red)).dispatched, true, "the red check drives");
  assert.equal(drivesFor(45).length, 2);

  // The findings still waiting reach that drive's agent once it binds.
  await hooks.bound();
  for (let waited = 0; wakesFor(45).length === 0 && waited < 8_000; waited += 200) await pause(200);
  assert.equal(wakesFor(45).length, 1);
});

test("a waiting Bugbot wake that keeps failing is dropped with a logged reason after three flushes, then retried no more", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  t.mock.method(console, "error", () => {});
  const hooks = driveHooks(46);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(46, "a"))).dispatched, true);
  await hooks.started();
  await deliver("check_suite", bugbotSuiteFor(46, "b"));
  await pause(3_300);
  PR_READ_FAILURES[46] = 1_000;
  await hooks.completed();
  const dropped = () => logs.filter((line) => line.includes('"bugbot_wake"') && line.includes(`${REPO}#46`) && line.includes('"dropped"'));
  for (let waited = 0; dropped().length === 0 && waited < 20_000; waited += 250) await pause(250);
  assert.equal(dropped().length, 1);
  assert.match(dropped()[0]!, /failed 3 times/);
  const failuresLeft = PR_READ_FAILURES[46];
  await pause(4_000);
  assert.equal(PR_READ_FAILURES[46], failuresLeft, "no more reads: the entry is gone");
  assert.equal(store.has(`auto-drive:${REPO}#46`), false);
});

// Verifier round 6, probe 2: every waiting flush read the PR first, so about
// 10 s of GitHub 502s while the running drive still held the claim spent all
// three attempts and dropped the findings just before the agent bound.
test("GitHub 502s while a running drive holds the claim cost nothing: the findings wait, with no reads, and reach the agent once it binds", async () => {
  const hooks = driveHooks(47);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(47, "a"))).dispatched, true);
  await hooks.started();
  await deliver("check_suite", bugbotSuiteFor(47, "b"));
  PR_READ_FAILURES[47] = 1_000;
  await pause(10_000);
  assert.equal(PR_READ_FAILURES[47], 1_000, "no GitHub read while waiting for the bind");
  assert.equal(store.has(`bugbot-fresh-failures:${REPO}#47:${"b".repeat(40)}`), false, "and nothing counted");
  PR_READ_FAILURES[47] = 0;
  await hooks.bound();
  for (let waited = 0; wakesFor(47).length === 0 && waited < 3_000; waited += 100) await pause(100);
  await pause(1_000);
  assert.equal(wakesFor(47).length, 1, "delivered once");
  assert.equal(wakesFor(47)[0]!.options.sdkAgentId, "bc-drive47");
  assert.equal(roundsOf(47), 2);
});

test("a successful check_suite on a factory branch, or a failed one on a branch without a project key, does not drive", async () => {
  for (const [number, conclusion] of [[4, "success"], [5, "failure"]] as const) {
    const body = await deliver("check_suite", checkSuitePayload(number, conclusion));
    assert.equal(body.skipped, true, conclusion);
    assert.equal(drivesFor(number).length, 0);
    assert.equal(store.has(`auto-drive:${REPO}#${number}`), false);
  }
});

test("a red check on a person's PR whose title alone carries a ticket key does not drive; a cursor[bot] PR titled that way does", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const person = await deliver("check_suite", checkSuitePayload(22, "failure"));
  assert.equal(person.skipped, true);
  assert.equal(drivesFor(22).length, 0);
  assert.equal(store.has(`auto-drive:${REPO}#22`), false);
  const lines = logs.mock.calls.map((call) => String(call.arguments[0] ?? "")).filter((line) => line.includes('"fixer":"auto_drive"'));
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ fixer: "auto_drive", pr: `${REPO}#22`, outcome: "title_only_from_person", author: "example-user" }]);

  const bot = await deliver("check_suite", checkSuitePayload(23, "failure"));
  assert.equal(bot.dispatched, true);
  assert.equal(drivesFor(23).length, 1);
  assert.match(drivesFor(23)[0]?.message ?? "", /TLSSN-23/);
  assert.equal(store.has(`auto-drive:${REPO}#23`), true);
});

test("a red check on a factory PR whose repo is missing from FACTORY_REPOS fails loudly and claims nothing", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  process.env.FACTORY_REPOS = "example-org/demo-repo";
  t.after(() => { process.env.FACTORY_REPOS = REPO; });
  await assert.rejects(deliver("check_suite", checkSuitePayload(21, "failure")), /acme\/in-scope is not in PR_AUTOFIXER_REPOS or FACTORY_REPOS \(example-org\/demo-repo\)/);
  assert.equal(drivesFor(21).length, 0);
  assert.equal(store.has(`auto-drive:${REPO}#21`), false);
  assert.match(String(errors.mock.calls[0]?.arguments[0] ?? ""), /^\[pr-autofixer\] auto-drive: acme\/in-scope#21 is a factory pull request/);
});

test("a red check on a PR GitHub will not read fails the delivery loudly and claims nothing; one failed read is retried and drives", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  await assert.rejects(deliver("check_suite", checkSuitePayload(26, "failure")), /could not read acme\/in-scope#26 from GitHub after 3 tries \(Bad Gateway\)/);
  assert.equal(drivesFor(26).length, 0);
  assert.equal(store.has(`auto-drive:${REPO}#26`), false);
  assert.match(String(errors.mock.calls[0]?.arguments[0] ?? ""), /^\[pr-autofixer\] auto-drive: could not read acme\/in-scope#26 from GitHub/);

  const retried = await deliver("check_suite", checkSuitePayload(27, "failure"));
  assert.equal(retried.dispatched, true);
  assert.equal(drivesFor(27).length, 1);
  assert.equal(errors.mock.calls.length, 1, "a read that succeeds on a retry says nothing");
});

type Commenter = { login: string; type: string; association?: string };
const COLLABORATOR: Commenter = { login: "simon", type: "User", association: "COLLABORATOR" };

function driveCommentPayload(number: number, by: Commenter = COLLABORATOR) {
  return {
    action: "created",
    repository,
    issue: {
      number,
      html_url: `https://github.com/${REPO}/pull/${number}`,
      pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${number}` },
    },
    comment: {
      id: 600 + number,
      body: "factory: drive",
      html_url: `https://github.com/${REPO}/pull/${number}#issuecomment-${600 + number}`,
      user: { login: by.login, type: by.type },
      ...(by.association === undefined ? {} : { author_association: by.association }),
    },
    sender: { login: by.login, type: by.type },
  };
}

test("a person's factory: drive comment starts one drive through the delivery's send", async () => {
  const body = await deliver("issue_comment", driveCommentPayload(9));
  assert.equal(body.dispatched, true);
  assert.equal(drivesFor(9).length, 1);
  const [drive] = drivesFor(9);
  assert.match(drive?.message ?? "", /https:\/\/github\.com\/acme\/in-scope\/pull\/9/);
  assert.equal(drive?.options.continuationToken, undefined);
  assert.equal(store.has(`auto-drive:${REPO}#9`), true);
});

test("a person's factory: drive on a repo missing from FACTORY_REPOS fails loudly; a stranger's or another bot's is refused quietly", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const logs = t.mock.method(console, "log", () => {});
  process.env.FACTORY_REPOS = "example-org/demo-repo";
  t.after(() => { process.env.FACTORY_REPOS = REPO; });
  await assert.rejects(deliver("issue_comment", driveCommentPayload(24)), /acme\/in-scope#24 got a person's factory: drive, but acme\/in-scope is not in PR_AUTOFIXER_REPOS or FACTORY_REPOS \(example-org\/demo-repo\)/);
  assert.equal(drivesFor(24).length, 0);
  assert.equal(store.has(`auto-drive:${REPO}#24`), false);
  assert.match(String(errors.mock.calls[0]?.arguments[0] ?? ""), /^\[pr-autofixer\] auto-drive: acme\/in-scope#24 got a person's factory: drive/);

  const stranger = await deliver("issue_comment", driveCommentPayload(25, { login: "random-outsider", type: "User", association: "NONE" }));
  assert.equal(stranger.skipped, true);
  const bot = await deliver("issue_comment", driveCommentPayload(28, { login: "dependabot[bot]", type: "Bot", association: "MEMBER" }));
  assert.equal(bot.skipped, true);
  assert.deepEqual([drivesFor(25).length, drivesFor(28).length], [0, 0]);
  assert.deepEqual([store.has(`auto-drive:${REPO}#25`), store.has(`auto-drive:${REPO}#28`)], [false, false]);
  assert.equal(errors.mock.calls.length, 1);
  const lines = logs.mock.calls.map((call) => String(call.arguments[0] ?? "")).filter((line) => line.includes('"fixer":"factory_drive"')).map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { fixer: "factory_drive", pr: `${REPO}#24`, outcome: "out_of_scope", author: "simon" },
    { fixer: "factory_drive", pr: `${REPO}#25`, outcome: "untrusted_author", author: "random-outsider" },
    { fixer: "factory_drive", pr: `${REPO}#28`, outcome: "untrusted_author", author: "dependabot[bot]" },
  ]);
});

test("a failed workflow_run drives, and a failed check_suite for the same push does not drive again", async () => {
  const run = await deliver("workflow_run", workflowRunPayload(6, "action_required"));
  assert.equal(run.dispatched, true);
  const suite = await deliver("check_suite", checkSuitePayload(6, "failure"));
  assert.equal(suite.skipped, true);
  assert.equal(drivesFor(6).length, 1);
});

test("a body without author_association is trusted only when GitHub's comment endpoint says collaborator", async () => {
  commentLookups.length = 0;
  const known = await deliver("issue_comment", driveCommentPayload(12, { login: "simon", type: "User" }));
  assert.equal(known.dispatched, true);
  assert.equal(drivesFor(12).length, 1);
  assert.deepEqual(commentLookups, ["GET /repos/{owner}/{repo}/issues/comments/{comment_id}"]);
  const unknown = await deliver("issue_comment", driveCommentPayload(17, { login: "someone", type: "User" }));
  assert.equal(unknown.skipped, true);
  assert.equal(drivesFor(17).length, 0);
});

test("the association lookup runs only for a PR comment that nothing else refuses", async () => {
  commentLookups.length = 0;
  const onIssue = driveCommentPayload(18, { login: "someone", type: "User" });
  const { pull_request: _pr, ...issue } = onIssue.issue;
  const issueBody = await deliver("issue_comment", { ...onIssue, issue: { ...issue, html_url: `https://github.com/${REPO}/issues/18` } });
  assert.equal(issueBody.skipped, true);
  const bot = await deliver("issue_comment", driveCommentPayload(19, { login: "some-app[bot]", type: "Bot" }));
  assert.equal(bot.skipped, true);
  const collaborator = await deliver("issue_comment", driveCommentPayload(20));
  assert.equal(collaborator.dispatched, true);
  assert.deepEqual(commentLookups, []);
  assert.equal(drivesFor(20).length, 1);
});

test("factory: drive on a PR already bound to an agent starts nothing", async () => {
  store.set(`affinity/${REPO}#13`, { bcId: "bc-existing-agent", updatedAt: "2026-09-23T00:00:00.000Z" });
  const body = await deliver("issue_comment", driveCommentPayload(13));
  assert.equal(body.skipped, true);
  assert.equal(drivesFor(13).length, 0);
  assert.equal(store.has(`auto-drive:${REPO}#13`), false);
  assert.equal(drives.some((call) => call.options.cloud?.repos?.[0]?.prUrl === `https://github.com/${REPO}/pull/13`), false);
});

function ageClaim(number: number, minutes: number) {
  const key = `auto-drive:${REPO}#${number}`;
  const claim = store.get(key) as Record<string, unknown>;
  store.set(key, { ...claim, at: new Date(Date.now() - minutes * 60_000).toISOString() });
}

test("a started drive holds its PR for two hours against red checks and factory: drive, then frees it", async () => {
  const first = await deliver("check_suite", checkSuitePayload(14, "failure"));
  assert.equal(first.dispatched, true);
  assert.equal(drivesFor(14).length, 1);

  ageClaim(14, 11);
  const red = await deliver("check_suite", checkSuitePayload(14, "failure"));
  assert.equal(red.skipped, true);
  const comment = await deliver("issue_comment", driveCommentPayload(14));
  assert.equal(comment.skipped, true);
  assert.equal(drivesFor(14).length, 1);

  ageClaim(14, 121);
  const later = await deliver("check_suite", checkSuitePayload(14, "failure"));
  assert.equal(later.dispatched, true);
  assert.equal(drivesFor(14).length, 2);
});

test("closing a driven PR releases its claim, so a reopened PR can drive again", async () => {
  await deliver("check_suite", checkSuitePayload(15, "failure"));
  assert.equal(store.has(`auto-drive:${REPO}#15`), true);
  PR_STATES[15] = "closed";
  await deliver("pull_request", {
    action: "closed",
    repository,
    pull_request: {
      number: 15,
      html_url: `https://github.com/${REPO}/pull/15`,
      title: "Fix limits",
      draft: false,
      merged: false,
      head: { ref: "TLSSN-15-fix-limits", sha: "f".repeat(40) },
      base: { ref: "main", sha: "e".repeat(40) },
    },
  });
  assert.equal(store.has(`auto-drive:${REPO}#15`), false);
  PR_STATES[15] = "open";
  const again = await deliver("check_suite", checkSuitePayload(15, "failure"));
  assert.equal(again.dispatched, true);
  assert.equal(drivesFor(15).length, 2);
});

function pullRequestEvent(number: number, input: { action: string; merged?: boolean; updatedAt?: string | null }) {
  const head = HEADS[number]!;
  return {
    action: input.action,
    repository,
    pull_request: {
      number,
      html_url: `https://github.com/${REPO}/pull/${number}`,
      title: head.title,
      draft: false,
      merged: input.merged ?? false,
      ...(input.updatedAt === null ? {} : { updated_at: input.updatedAt ?? T0 }),
      head: { ref: head.headRefName, sha: "f".repeat(40) },
      base: { ref: "main", sha: "e".repeat(40) },
    },
  };
}

const cleanupLines = (logs: string[], number: number) =>
  logs.filter((line) => line.includes('"close_cleanup"') && line.includes(`${REPO}#${number}`)).map((line) => JSON.parse(line) as Record<string, unknown>);

// Owner decision on plan K8's open question 1: a reopened PR starts over.
test("closing a PR deletes its affinity and Bugbot rounds, so the reopened PR drives fresh from round 0; a redelivered close is a no-op", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  const hooks = driveHooks(48);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(48, "a"))).dispatched, true);
  await hooks.started();
  await hooks.bound();
  await hooks.completed();
  await deliver("check_suite", bugbotSuiteFor(48, "b"));
  await pause(3_300);
  assert.equal(wakesFor(48).length, 1);
  assert.equal(roundsOf(48), BUGBOT_ROUNDS_CAP, "both rounds spent before the close");
  assert.equal(store.has(`affinity/${REPO}#48`), true);

  PR_STATES[48] = "closed";
  await deliver("pull_request", pullRequestEvent(48, { action: "closed" }));
  assert.equal(store.has(`affinity/${REPO}#48`), false);
  assert.equal(store.has(`bugbot-rounds:${REPO}#48`), false);
  assert.equal(store.has(`auto-drive:${REPO}#48`), false);
  assert.deepEqual(store.get(`v1/pr-generation/acme/in-scope/48`), { n: 1 }, "the next pr: session key is a new one");
  assert.deepEqual(cleanupLines(logs, 48).map(({ affinity, bugbotRounds, claim, buffer, generation, prState }) => ({ affinity, bugbotRounds, claim, buffer, generation, prState })), [
    { affinity: "deleted", bugbotRounds: "deleted", claim: "absent", buffer: "empty", generation: "bumped", prState: "CLOSED" },
  ]);

  PR_STATES[48] = "open";
  PR_UPDATED_AT[48] = "2026-09-29T08:05:00Z";
  await deliver("pull_request", pullRequestEvent(48, { action: "reopened", updatedAt: "2026-09-29T08:05:00Z" }));
  assert.equal((await deliver("check_suite", bugbotSuiteFor(48, "c"))).dispatched, true, "past the old cap, the reopened PR's findings drive");
  assert.equal(drivesFor(48).length, 2, "a fresh drive, not a wake of the old agent");
  assert.equal(wakesFor(48).length, 1);
  assert.equal(roundsOf(48), 1, "round 1 of a fresh count");
  assert.equal(prComments.filter((comment) => comment.number === 48).length, 0, "no cap note");
  // The fresh drive's agent binds; the next head's wake goes to it on the reopened PR's own session key.
  await hooks.started();
  await hooks.bound();
  await hooks.completed();
  await deliver("check_suite", bugbotSuiteFor(48, "d"));
  await pause(3_300);
  assert.equal(wakesFor(48).length, 2);
  assert.equal((wakesFor(48)[1]!.options as { continuationToken?: string }).continuationToken, `pr:${REPO}#48@g1`);
  assert.equal((wakesFor(48)[0]!.options as { continuationToken?: string }).continuationToken, `pr:${REPO}#48`, "before the close: generation 0");
  assert.equal(roundsOf(48), 2);

  // The first close, redelivered after the reopen: GitHub says open and updated since, so the reopened PR keeps its state.
  await deliver("pull_request", pullRequestEvent(48, { action: "closed", updatedAt: T0 }));
  assert.equal(roundsOf(48), 2);
  assert.equal(store.has(`affinity/${REPO}#48`), true);
  assert.deepEqual(store.get(`v1/pr-generation/acme/in-scope/48`), { n: 1 });
  assert.deepEqual(cleanupLines(logs, 48).at(-1), { fixer: "close_cleanup", pr: `${REPO}#48`, prState: "OPEN", prUpdatedAt: "2026-09-29T08:05:00Z", eventUpdatedAt: T0, outcome: "skipped_reopened" });

  PR_STATES[48] = "merged";
  PR_UPDATED_AT[48] = "2026-09-29T08:10:00Z";
  await deliver("pull_request", pullRequestEvent(48, { action: "closed", merged: true, updatedAt: "2026-09-29T08:10:00Z" }));
  await deliver("pull_request", pullRequestEvent(48, { action: "closed", merged: true, updatedAt: "2026-09-29T08:10:00Z" }));
  assert.equal(store.has(`bugbot-rounds:${REPO}#48`), false);
  assert.equal(store.has(`auto-drive:${REPO}#48`), false);
  const [, , afterMerge, redelivered] = cleanupLines(logs, 48);
  assert.equal(afterMerge?.["prState"], "MERGED");
  assert.deepEqual([afterMerge?.["affinity"], afterMerge?.["bugbotRounds"], afterMerge?.["generation"]], ["deleted", "deleted", "skipped_merged"], "the merge's close takes the fresh drive's agent and rounds");
  assert.deepEqual(store.get(`v1/pr-generation/acme/in-scope/48`), { n: 1 }, "a merged PR cannot reopen, so merges add no generation");
  assert.equal(redelivered?.["generation"], "skipped_merged");
  assert.deepEqual(
    [redelivered?.["claim"], redelivered?.["driveSession"], redelivered?.["affinity"], redelivered?.["bugbotRounds"]],
    ["absent", "absent", "absent", "absent"],
    "the redelivered close finds nothing left"
  );
});

test("FACTORY_FIXER_CLOSE_CLEANUP=off: a close releases the claim only, and the PR keeps its affinity and Bugbot rounds", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  const hooks = driveHooks(49);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(49, "a"))).dispatched, true);
  await hooks.started();
  await hooks.bound();
  assert.equal(store.has(`auto-drive:${REPO}#49`), true);
  process.env.FACTORY_FIXER_CLOSE_CLEANUP = "off";
  t.after(() => { delete process.env.FACTORY_FIXER_CLOSE_CLEANUP; });
  await deliver("pull_request", pullRequestEvent(49, { action: "closed" }));
  assert.equal(store.has(`auto-drive:${REPO}#49`), false);
  assert.equal(store.has(`affinity/${REPO}#49`), true);
  assert.equal(roundsOf(49), 1);
  assert.deepEqual(cleanupLines(logs, 49), []);
});

test("a close cancels the PR's merge watches, discards its buffered wake, and drops the session record only after the claim is gone", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  const hooks = driveHooks(50);
  assert.equal((await deliver("check_suite", bugbotSuiteFor(50, "a"))).dispatched, true);
  await hooks.started();
  assert.equal((store.get(`auto-drive:${REPO}#50`) as { sessionId?: string }).sessionId, "ses_drive_50");
  assert.equal(store.has("drive-session/ses_drive_50"), true);
  await deliver("check_suite", bugbotSuiteFor(50, "b"));
  const target = (number: number) => ({ prOwner: "acme", prRepo: "in-scope", prNumber: number });
  armedWatches.push({ id: "w50", purpose: "merge_conflict_watch", target: target(50) }, { id: "w51", purpose: "merge_conflict_watch", target: target(51) });
  reminderCalls.length = 0;

  PR_STATES[50] = "closed";
  await deliver("pull_request", pullRequestEvent(50, { action: "closed" }));
  assert.deepEqual(reminderCalls, ["list", "cancel w50"], "listed once and cancelled only this PR's watch; nothing ran the old close path after it");
  assert.deepEqual(armedWatches.map((watch) => watch.id), ["w51"]);
  const [line] = cleanupLines(logs, 50);
  assert.deepEqual([line?.["reminders"], line?.["buffer"], line?.["claim"], line?.["driveSession"]], ["cancelled", "discarded", "deleted", "deleted"]);
  assert.equal(store.has("drive-session/ses_drive_50"), false);
  armedWatches.length = 0;
});

/** A PR's kv as a finished, bound drive leaves it. */
function seedDriven(number: number) {
  store.set(`affinity/${REPO}#${number}`, { bcId: `bc-${number}`, updatedAt: T0 });
  store.set(`bugbot-rounds:${REPO}#${number}`, { shas: ["a1"], rounds: 1 });
}

test("a close whose PR state GitHub does not answer is taken as closed: the cleanup runs", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  seedDriven(52);
  PR_STATES[52] = "unreachable";
  await deliver("pull_request", pullRequestEvent(52, { action: "closed" }));
  assert.equal(store.has(`affinity/${REPO}#52`), false);
  assert.equal(store.has(`bugbot-rounds:${REPO}#52`), false);
  assert.deepEqual(store.get(`v1/pr-generation/acme/in-scope/52`), { n: 1 });
  const [line] = cleanupLines(logs, 52);
  assert.deepEqual([line?.["prState"], line?.["affinity"], line?.["bugbotRounds"]], ["unknown", "deleted", "deleted"]);
});

// GitHub can still answer open just after a close. Only an open PR updated
// after the close event (a reopen since) skips the cleanup.
test("an open answer no newer than the close event, or a close event with no updated_at, is stale: the cleanup runs", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  PR_STATES[53] = "open";
  for (const [fetched, event] of [[T0, T0], ["2026-09-29T07:59:00Z", T0], ["2026-09-29T08:30:00Z", null]] as const) {
    seedDriven(53);
    PR_UPDATED_AT[53] = fetched;
    await deliver("pull_request", pullRequestEvent(53, { action: "closed", updatedAt: event }));
    assert.equal(store.has(`affinity/${REPO}#53`), false, `${fetched} vs ${event}`);
    assert.equal(store.has(`bugbot-rounds:${REPO}#53`), false, `${fetched} vs ${event}`);
    assert.equal(cleanupLines(logs, 53).at(-1)?.["prState"], "OPEN");
  }
  assert.equal(cleanupLines(logs, 53).filter((line) => line["outcome"] === "skipped_reopened").length, 0);
});

// A closed PR touched after its close (a bot's comment on close, say) has a
// later updated_at but is still closed: only an open PR skips the cleanup.
test("a PR GitHub says is closed but updated after the close event still gets its cleanup", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  seedDriven(54);
  store.set(`auto-drive:${REPO}#54`, { state: "pending", owner: "tok-54", at: new Date().toISOString(), started: true });
  PR_STATES[54] = "closed";
  PR_UPDATED_AT[54] = "2026-09-29T08:20:00Z";
  await deliver("pull_request", pullRequestEvent(54, { action: "closed", updatedAt: T0 }));
  assert.equal(store.has(`auto-drive:${REPO}#54`), false, "the drive claim is released");
  assert.equal(store.has(`affinity/${REPO}#54`), false);
  assert.equal(store.has(`bugbot-rounds:${REPO}#54`), false);
  const [line] = cleanupLines(logs, 54);
  assert.deepEqual([line?.["prState"], line?.["outcome"], line?.["claim"]], ["CLOSED", undefined, "deleted"]);
});

// Either merge signal alone keeps the generation: the event's flag when GitHub
// does not answer, and GitHub's MERGED when the event carries no flag.
test("a merge known from the event alone, or from GitHub alone, cleans up without bumping the generation", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  const cases = [
    { number: 55, state: "unreachable" as const, merged: true, prState: "unknown" },
    { number: 56, state: "merged" as const, merged: false, prState: "MERGED" },
  ];
  for (const { number, state, merged, prState } of cases) {
    seedDriven(number);
    PR_STATES[number] = state;
    await deliver("pull_request", pullRequestEvent(number, { action: "closed", merged }));
    assert.equal(store.has(`bugbot-rounds:${REPO}#${number}`), false, String(number));
    assert.equal(store.has(`v1/pr-generation/acme/in-scope/${number}`), false, `${number}: no generation`);
    const [line] = cleanupLines(logs, number);
    assert.deepEqual([line?.["prState"], line?.["generation"]], [prState, "skipped_merged"], String(number));
  }
});

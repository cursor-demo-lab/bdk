import assert from "node:assert/strict";
import { test } from "node:test";
import { recordImplementation } from "./claim.js";
import { approvedBody } from "./fixtures.js";
import { createHandler } from "./handle.js";
import {
  armImplementPrWatch,
  ensureImplementPr,
  fireImplementPrWatch,
  IMPLEMENT_PR_FIRST_MS,
  IMPLEMENT_PR_INDEX,
  IMPLEMENT_PR_MAX_MS,
  IMPLEMENT_PR_POLL_MS,
  implementPrBody,
  implementPrTitle,
  implementPrWatchKey,
  latestRunFacts,
  sdkRunReader,
  type AgentRunFacts,
  type ImplementPrDeps,
} from "./implement-pr.js";
import { decidePullRequest } from "./pr-decide.js";
import { withTicketLinks } from "./pr-links.js";
import { backgroundWork, fakeCreateAgent, fakeTracker, memoryKv, signedRequest, type FakeTracker, type MemoryKv } from "./testing/fakes.js";
import { fakeGitHub, fakeReminders } from "./testing/github.js";

const NOW = new Date("2026-09-26T20:00:00.000Z");
const KEY = "TLSSN-35";
const REPO = "cursor-demo-lab/marsbank";
const BRANCH = "TLSSN-35-activity-register-landmark-name";
const TITLE = "Activity register: show the landmark name";
const AGENT_URL = "https://cursor.com/agents/bc-tlssn-35";
const TICKET_URL = "https://example.atlassian.net/browse/TLSSN-35";
const SLACK_URL = "https://example-workspace.slack.com/archives/C0EXAMPLE1/p1758910000123456";
const ENV: NodeJS.ProcessEnv = { JIRA_WEBHOOK_SECRET: "test-secret", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_SANDBOX_REPO: REPO, FACTORY_CLAIM_SETTLE_MS: "1" };
const PLAN = [
  `Plan: ${KEY} ${TITLE}`,
  "Problem",
  "The activity register shows the landmark id, not its name.",
  "",
  "Brief:",
  `Ticket: ${TICKET_URL}`,
  `Slack thread: ${SLACK_URL}`,
  "",
  "Show the landmark name in the activity register row.",
].join("\n");
const SUMMARY = ["Jira: TLSSN-35", "", "## What changed", "- The activity register row shows the landmark name.", "", "## Tests", "- `npm test`: 212 passed"].join("\n");
const FINISHED: AgentRunFacts = { status: "finished", branch: BRANCH, summary: SUMMARY };

async function launchedKv(): Promise<MemoryKv> {
  const kv = memoryKv();
  await recordImplementation(kv, KEY, { state: "launched", at: "2026-09-26T18:00:00.000Z", agentId: "bc-tlssn-35", url: AGENT_URL, commented: true, moved: true });
  return kv;
}

function world(options: { run?: AgentRunFacts | undefined; github?: ReturnType<typeof fakeGitHub>; tracker?: FakeTracker; kv?: MemoryKv; env?: NodeJS.ProcessEnv; now?: () => Date } = {}) {
  const gh = options.github ?? fakeGitHub();
  const tracker = options.tracker ?? fakeTracker({ status: "In Progress", comments: [PLAN, `Implementing: ${AGENT_URL}`] });
  const runReads: string[] = [];
  const run = "run" in options ? options.run : FINISHED;
  const deps = async (): Promise<ImplementPrDeps> => ({
    kv: options.kv ?? (await launchedKv()),
    mcp: tracker.mcp,
    env: options.env ?? ENV,
    now: options.now ?? (() => NOW),
    github: gh.github,
    readRun: async ({ agentId }) => {
      runReads.push(agentId);
      return run;
    },
    log: () => {},
    readyRetryMs: [0, 0],
    sleep: async () => {},
  });
  return { gh, tracker, runReads, deps };
}

test("TLSSN-35: the agent finished with its branch pushed and no PR, so the worker opens it ready, with the Jira and Slack links, and moves the ticket to In Review", async () => {
  const w = world();
  const deps = await w.deps();
  const result = await ensureImplementPr(deps, { issueKey: KEY, title: TITLE });

  assert.deepEqual(result, {
    outcome: "opened",
    pr: `${REPO}#40`,
    url: `https://github.com/${REPO}/pull/40`,
    branch: BRANCH,
    base: "main",
    ready: "already_ready",
    move: "moved",
  });
  assert.equal(w.gh.creates().length, 1);
  const create = w.gh.creates()[0]!.params;
  assert.equal(create["draft"], false, "never a draft: Bugbot skips drafts");
  assert.equal(create["head"], BRANCH, "the agent's branch, as it named it");
  assert.equal(create["base"], "main", "the sandbox ref, marsbank's default branch");
  assert.equal(create["title"], `${KEY}: ${TITLE}`);
  const body = String(create["body"]);
  assert.equal(
    body,
    [`Jira: ${TICKET_URL}`, `Slack: ${SLACK_URL}`, "", "## What changed", "- The activity register row shows the landmark name.", "", "## Tests", "- `npm test`: 212 passed", "", `Implement agent: ${AGENT_URL}`].join("\n")
  );
  assert.equal(withTicketLinks(body, { issueKey: KEY, links: { jira: TICKET_URL, slack: SLACK_URL } }), undefined, "pr-body.ts finds the links present and writes nothing");
  assert.deepEqual(w.gh.pulls, [{ number: 40, head: BRANCH, state: "open", draft: false }]);

  assert.equal(w.tracker.status(), "In Review");
  assert.deepEqual(w.tracker.comments.slice(2), [`Pull request: https://github.com/${REPO}/pull/40`], "the desk's In Review line links the PR from this comment");
  const tools = w.tracker.calls.map((call) => call.tool);
  assert.ok(tools.indexOf("addCommentToJiraIssue") < tools.indexOf("transitionJiraIssue"));
});

test("a PR already open for the branch is reused: a second pass, or one the agent opened, never makes a duplicate", async () => {
  const w = world();
  const deps = await w.deps();
  assert.equal((await ensureImplementPr(deps, { issueKey: KEY, title: TITLE })).outcome, "opened");
  const again = await ensureImplementPr(deps, { issueKey: KEY, title: TITLE });
  assert.deepEqual(again, { outcome: "reused", pr: `${REPO}#40`, url: `https://github.com/${REPO}/pull/40`, branch: BRANCH, ready: "already_ready", move: "duplicate" });
  assert.equal(w.gh.creates().length, 1);
  assert.equal(w.gh.pulls.length, 1);

  const byAgent = world({ github: fakeGitHub({ pulls: [{ number: 31, head: BRANCH, state: "open", draft: false }] }) });
  const reused = await ensureImplementPr(await byAgent.deps(), { issueKey: KEY, title: TITLE });
  assert.equal(reused.outcome, "reused");
  assert.deepEqual(byAgent.gh.creates(), []);
  assert.equal(byAgent.tracker.status(), "In Review");
});

test("an existing draft PR for the branch is undrafted, not duplicated, before the In Review move", async () => {
  const w = world({ github: fakeGitHub({ pulls: [{ number: 29, head: BRANCH, state: "open", draft: true }] }) });
  const result = await ensureImplementPr(await w.deps(), { issueKey: KEY, title: TITLE });

  assert.deepEqual(result, { outcome: "reused", pr: `${REPO}#29`, url: `https://github.com/${REPO}/pull/29`, branch: BRANCH, ready: "marked_ready", move: "moved" });
  assert.deepEqual(w.gh.creates(), []);
  assert.equal(w.gh.pulls[0]?.draft, false);
  const graphql = w.gh.calls.find((call) => call.route === "POST /graphql");
  assert.deepEqual(graphql?.params["headers"], { "x-cursor-github-repos": REPO });
  assert.equal(w.tracker.status(), "In Review");
});

test("a PR a person closed for the branch stays closed: nothing reopened, nothing opened, no move", async () => {
  const w = world({ github: fakeGitHub({ pulls: [{ number: 27, head: BRANCH, state: "closed", draft: false }] }) });
  const result = await ensureImplementPr(await w.deps(), { issueKey: KEY, title: TITLE });
  assert.deepEqual(result, { outcome: "pr_closed", pr: `${REPO}#27`, url: `https://github.com/${REPO}/pull/27`, branch: BRANCH });
  assert.deepEqual(w.gh.creates(), []);
  assert.equal(w.tracker.status(), "In Progress");
});

test("the agent opening its own PR between the lookup and the create (422) is reused", async () => {
  const w = world({ github: fakeGitHub({ raceOnCreate: { number: 33, head: BRANCH, state: "open", draft: true } }) });
  const result = await ensureImplementPr(await w.deps(), { issueKey: KEY, title: TITLE });
  assert.equal(result.outcome, "reused");
  assert.equal("pr" in result && result.pr, `${REPO}#33`);
  assert.equal(w.gh.pulls.length, 1);
  assert.equal(w.gh.pulls[0]?.draft, false, "a PR the agent opened as a draft is undrafted");
});

test("a run still working with nothing pushed opens nothing; a finished run with no branch reported falls back to this key's branch on GitHub", async () => {
  const running = world({ run: { status: "running" } });
  assert.deepEqual(await ensureImplementPr(await running.deps(), { issueKey: KEY }), { outcome: "agent_running" });
  assert.deepEqual(running.gh.calls, []);

  const lookedUp = world({ run: { status: "finished" }, github: fakeGitHub({ branches: ["TLSSN-350-other-ticket", BRANCH] }) });
  const result = await ensureImplementPr(await lookedUp.deps(), { issueKey: KEY, title: TITLE });
  assert.equal(result.outcome, "opened");
  assert.equal(lookedUp.gh.creates()[0]?.params["head"], BRANCH, "TLSSN-350's branch is not TLSSN-35's");

  const none = world({ run: { status: "error" }, github: fakeGitHub({ branches: ["TLSSN-350-other-ticket"] }) });
  assert.deepEqual(await ensureImplementPr(await none.deps(), { issueKey: KEY }), { outcome: "no_branch", runStatus: "error", candidates: 0 });
});

test("a ticket the worker never launched gets no PR, and FACTORY_SANDBOX_REF, when set, is the base", async () => {
  const stranger = world({ kv: memoryKv() });
  assert.deepEqual(await ensureImplementPr(await stranger.deps(), { issueKey: KEY }), { outcome: "not_launched" });
  assert.deepEqual(stranger.runReads, []);

  const pinned = world({ env: { ...ENV, FACTORY_SANDBOX_REF: "release/2026-09" }, github: fakeGitHub({ defaultBranch: "main" }) });
  await ensureImplementPr(await pinned.deps(), { issueKey: KEY, title: TITLE });
  assert.equal(pinned.gh.creates()[0]?.params["base"], "release/2026-09");
});

test("the base is the ref the agent started from and the PR hooks count, so the merge still moves the ticket to Done", async () => {
  const w = world({ github: fakeGitHub({ defaultBranch: "develop" }) });
  await ensureImplementPr(await w.deps(), { issueKey: KEY, title: TITLE });
  const base = String(w.gh.creates()[0]?.params["base"]);
  assert.equal(base, "main");
  const merged = decidePullRequest(
    { action: "closed", repository: REPO, number: 40, url: "", headRef: BRANCH, baseRef: base, title: `${KEY}: ${TITLE}`, merged: true, sender: { login: "example-user", type: "User" }, autoMerge: false },
    { sandboxRepo: REPO, sandboxRef: "main", projects: ["TLSSN"] }
  );
  assert.equal(merged.move && merged.stage, "done");
});

test("a retry whose PR create fails arms the watch, so the create is tried again without another retry", async () => {
  const reminders = fakeReminders();
  const kv = await launchedKv();
  const tracker = fakeTracker({ status: "Approved", comments: [PLAN, `Implementing: ${AGENT_URL}`] });
  const gh = fakeGitHub({ createStatus: 403 });
  const lines: string[] = [];
  const handle = createHandler({ kv, mcp: tracker.mcp, createAgent: fakeCreateAgent().createAgent, env: ENV, now: () => NOW, log: (line) => lines.push(line), github: gh.github, readRun: async () => FINISHED, reminders: reminders.api });
  const background = backgroundWork();
  await handle(signedRequest(approvedBody({ issueKey: KEY, summary: TITLE, fromStatus: "In Progress", changelogId: "20037" })), background);
  await background.settle();

  const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line["worker"] === "implement_pr");
  assert.equal(logged?.["outcome"], "write_failed");
  assert.equal(logged?.["status"], 403);
  assert.equal(logged?.["prWatch"], "armed");
  assert.equal(reminders.created.length, 1);
});

test("the reminder keeps polling while the agent works, stops once the PR is open, and gives up after the watch's lifetime", async () => {
  const armedAt = NOW.toISOString();
  const running = world({ run: { status: "running" } });
  const runningDeps = await running.deps();
  await runningDeps.kv.put(implementPrWatchKey(KEY), { armedAt });
  assert.equal((await fireImplementPrWatch(runningDeps, { issueKey: KEY, armedAt })).rescheduleMs, IMPLEMENT_PR_POLL_MS);

  const late = await fireImplementPrWatch({ ...runningDeps, now: () => new Date(NOW.getTime() + IMPLEMENT_PR_MAX_MS) }, { issueKey: KEY, armedAt });
  assert.equal(late.rescheduleMs, undefined);
  assert.equal(await runningDeps.kv.get(implementPrWatchKey(KEY)), undefined, "the watch record is cleared");

  const done = world();
  const fired = await fireImplementPrWatch(await done.deps(), { issueKey: KEY, title: TITLE, armedAt });
  assert.equal(fired.result.outcome, "opened");
  assert.equal(fired.rescheduleMs, undefined);
});

test("the watch is the worker's session-stopped handler: a stopped agent that pushed nothing ends it, one still working keeps it", async () => {
  const armedAt = NOW.toISOString();
  const fire = async (status: string) => {
    const w = world({ github: fakeGitHub({ branches: ["TLSSN-350-other-ticket"] }) });
    const deps = { ...(await w.deps()), readRun: sdkRunReader(async () => ({ items: [{ status, createdAt: 1, git: { branches: [] } }] })) };
    await deps.kv.put(implementPrWatchKey(KEY), { armedAt });
    return { fired: await fireImplementPrWatch(deps, { issueKey: KEY, armedAt }), watch: await deps.kv.get(implementPrWatchKey(KEY)), creates: w.gh.creates().length };
  };

  for (const [status, runStatus] of [["finished", "finished"], ["error", "error"], ["cancelled", "cancelled"], ["expired", "error"]] as const) {
    const { fired, watch, creates } = await fire(status);
    assert.deepEqual(fired.result, { outcome: "no_branch", runStatus, candidates: 0 }, status);
    assert.equal(fired.rescheduleMs, undefined, `${status}: a stopped agent is not polled again`);
    assert.equal(watch, undefined, `${status}: the watch record is cleared`);
    assert.equal(creates, 0, `${status}: no PR without a branch`);
  }

  for (const status of ["creating", "running", "queued"]) {
    const { fired, watch } = await fire(status);
    assert.equal(fired.result.outcome, "agent_running", status);
    assert.equal(fired.rescheduleMs, IMPLEMENT_PR_POLL_MS, status);
    assert.notEqual(watch, undefined, status);
  }
});

test("a launch arms one implement PR watch: a named reminder with JSON args, never armed twice", async () => {
  const reminders = fakeReminders();
  const kv = memoryKv();
  const tracker = fakeTracker({ comments: [PLAN] });
  const handle = createHandler({ kv, mcp: tracker.mcp, createAgent: fakeCreateAgent({ agentId: "bc-tlssn-35" }).createAgent, env: ENV, now: () => NOW, log: () => {}, reminders: reminders.api });
  const background = backgroundWork();
  await handle(signedRequest(approvedBody({ issueKey: KEY, summary: TITLE })), background);
  const [settled] = await background.settle();

  assert.equal(settled?.ok && (settled.value as { prWatch: string }).prWatch, "armed");
  // The launch watch's reminder comes first, and the recorded launch cancelled it.
  assert.deepEqual(
    reminders.created.map((each) => each.handler),
    ["implement_launch", "implement_pr"]
  );
  assert.deepEqual(reminders.cancelled, ["rem-1"]);
  const armed = reminders.created[1]!;
  assert.equal(armed.handler, "implement_pr");
  assert.equal(armed.delay, "10m");
  assert.deepEqual(armed.args, { issueKey: KEY, armedAt: NOW.toISOString(), title: TITLE });
  assert.deepEqual(kv.entries.get(implementPrWatchKey(KEY)), { armedAt: NOW.toISOString(), dueAt: new Date(NOW.getTime() + IMPLEMENT_PR_FIRST_MS).toISOString(), title: TITLE, reminderId: "rem-2" });
  assert.deepEqual(kv.entries.get(IMPLEMENT_PR_INDEX), [KEY], "listed, so the backstop sweep can find it");

  assert.equal(await armImplementPrWatch({ kv, reminders: reminders.api, now: () => NOW }, { issueKey: KEY }), "already");
  assert.equal(reminders.created.length, 2);
});

test("TLSSN-35 recovery: `retry KEY` bounces the stuck ticket to Approved, and the worker opens the PR from the pushed branch with no new run", async () => {
  const kv = await launchedKv();
  const tracker = fakeTracker({ status: "Approved", comments: [PLAN, `Implementing: ${AGENT_URL}`] });
  const gh = fakeGitHub();
  const launcher = fakeCreateAgent();
  const lines: string[] = [];
  const handle = createHandler({
    kv,
    mcp: tracker.mcp,
    createAgent: launcher.createAgent,
    env: ENV,
    now: () => NOW,
    log: (line) => lines.push(line),
    github: gh.github,
    readRun: async () => FINISHED,
  });
  const background = backgroundWork();
  const response = await handle(signedRequest(approvedBody({ issueKey: KEY, summary: TITLE, fromStatus: "In Progress", changelogId: "20035" })), background);
  assert.deepEqual(await response.json(), { ok: true, duplicate: true, issueKey: KEY, reposted: false, transition: "transitioned" });
  await background.settle();

  assert.deepEqual(launcher.calls, [], "no second agent");
  assert.equal(gh.creates().length, 1);
  assert.equal(gh.creates()[0]?.params["draft"], false);
  assert.equal(gh.creates()[0]?.params["title"], `${KEY}: ${TITLE}`);
  assert.match(String(gh.creates()[0]?.params["body"]), new RegExp(`^Jira: ${TICKET_URL}\nSlack: ${SLACK_URL}\n`));
  const moves = tracker.calls.filter((call) => call.tool === "transitionJiraIssue").map((call) => (call.args["transition"] as { id: string }).id);
  assert.deepEqual(moves, ["31", "71"], "Approved → In Progress, then In Progress → In Review once the PR is open");
  assert.equal(tracker.status(), "In Review");
  const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line["worker"] === "implement_pr");
  assert.equal(logged?.["outcome"], "opened");
  assert.equal(logged?.["via"], "approved");

  const again = backgroundWork();
  await handle(signedRequest(approvedBody({ issueKey: KEY, summary: TITLE, fromStatus: "In Review", changelogId: "20036" })), again);
  await again.settle();
  assert.equal(gh.creates().length, 1, "a second retry reuses the PR");
});

test("latestRunFacts reads the newest run's status, the branch it pushed on the sandbox, and its final message", () => {
  assert.equal(latestRunFacts([], REPO), undefined);
  assert.deepEqual(
    latestRunFacts(
      [
        { status: "finished", createdAt: 1, result: "old", git: { branches: [{ repoUrl: "https://github.com/cursor-demo-lab/marsbank", branch: "old" }] } },
        { status: "finished", createdAt: 2, result: " Summary \n", git: { branches: [{ repoUrl: "https://github.com/other/repo", branch: "x" }, { repoUrl: "https://github.com/Cursor-Demo-Lab/marsbank.git", branch: BRANCH }] } },
      ],
      REPO
    ),
    { status: "finished", branch: BRANCH, summary: "Summary" }
  );
  assert.deepEqual(latestRunFacts([{ status: "creating", git: { branches: [] } }], REPO), { status: "running" });
  assert.deepEqual(latestRunFacts([{ status: "expired", git: { branches: [] } }], REPO), { status: "error" });
  assert.deepEqual(latestRunFacts([{ status: "error", git: { branches: [{ repoUrl: "github.com/cursor-demo-lab/marsbank", branch: BRANCH }] } }], REPO), { status: "error", branch: BRANCH });
});

test("the PR title starts with the key and fits GitHub; the body falls back to this site's browse URL and drops the agent's own link lines", () => {
  assert.equal(implementPrTitle({ issueKey: KEY, title: TITLE }), `${KEY}: ${TITLE}`);
  assert.equal(implementPrTitle({ issueKey: KEY, title: `${KEY}: already keyed` }), `${KEY}: already keyed`);
  assert.equal(implementPrTitle({ issueKey: KEY }), KEY);
  assert.equal(implementPrTitle({ issueKey: KEY, title: "x".repeat(400) }).length, 256);

  const body = implementPrBody({ issueKey: KEY, links: {}, summary: "**Slack:** https://example.com\n\nDid the thing.", agentUrl: AGENT_URL, env: {} });
  assert.equal(body, [`Jira: ${TICKET_URL}`, "", "Did the thing.", "", `Implement agent: ${AGENT_URL}`].join("\n"));
  assert.equal(implementPrBody({ issueKey: KEY, links: { slack: SLACK_URL }, agentUrl: AGENT_URL, env: { JIRA_CLOUD_ID: "https://acme.atlassian.net/" } }), [`Jira: https://acme.atlassian.net/browse/${KEY}`, `Slack: ${SLACK_URL}`, "", `Implement agent: ${AGENT_URL}`].join("\n"));
});

test("a PR title past GitHub's limit is cut between words, never mid-word", () => {
  const title = "the export button stays disabled after the filter changes and nothing on the page says why ".repeat(4).trim();
  const pr = implementPrTitle({ issueKey: KEY, title });
  assert.ok(pr.length <= 256 && pr.endsWith("…"));
  const whole = `${KEY}: ${title}`;
  const kept = pr.slice(0, -1);
  assert.ok(whole.startsWith(kept));
  assert.match(whole.slice(kept.length), /^\s/, `cut mid-word: …${kept.slice(-12)}|${whole.slice(kept.length, kept.length + 8)}`);
});

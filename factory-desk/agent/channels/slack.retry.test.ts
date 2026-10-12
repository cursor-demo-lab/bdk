import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import { getSlackChannelOptions, resetExternalSenderCache, type SlackApiTransport, type SlackBinding, type SlackMessage, type SlackMessageHandler } from "@cursor/july/channels/slack";
import { hopWatchKey, triagedSinceKey } from "../lib/hop-watch.js";
import { retryTarget } from "../lib/retry-command.js";
import { pullRequestRetryKey, retryBounceKey, slackApprovalKey } from "../lib/slack-approval.js";
import jira from "./jira.js";
import slack from "./slack.js";

// `retry KEY` is the recovery the hop-watch line offers. From the filer, in
// the ticket's thread, host code redelivers the hop the ticket is stuck in
// and replies; a hop still inside its deadline is never started again, and
// the worker's per-ticket claim usually keeps a redelivered approval from
// launching a second agent (hosted kv has no compare-and-set).

const ENV = { JIRA_WEBHOOK_SECRET: "test-secret", FACTORY_JIRA_PROJECTS: "TLSSN" } as const;
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
after(() => {
  for (const name of Object.keys(ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const TEAM = "T0123";
const THREAD = { channelId: "C0EXAMPLE1", threadTs: "1758510000.123456" };
const FILER = "U0ALICE01";
const KEY = "TLSSN-42";
const BOUND: Record<string, unknown> = { [`ticket/${KEY}`]: { ...THREAD, originatorUserId: FILER } };
const NOW = new Date();
const PLAN = { id: "100", body: `Plan: ${KEY}\nSummary: CSV export` };

function slackApi() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      calls.push({ method, args: args as Record<string, unknown> });
      if (method === "users.info") return { ok: true, user: { id: FILER, team_id: TEAM } };
      if (method === "chat.postMessage") return { ok: true, ts: "1758510001.000100" };
      return { ok: true, messages: [] };
    },
  };
  return { calls, transport };
}

/** A Jira whose transitions go to any status by name, and whose moves change the status it reads back. */
function tracker(input: { status: string; comments?: Array<{ id: string; body: string }>; failMoveTo?: string }) {
  const state = { status: input.status, moves: [] as string[], comments: input.comments ?? [PLAN] };
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const statuses = ["To Do", "Triaged", "Planned", "Approved", "In Progress"];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (tool === "getJiraIssue") return json({ key: KEY, fields: { summary: "CSV export", status: { name: state.status }, comment: { comments: state.comments } } });
      if (tool === "getTransitionsForJiraIssue") return json({ transitions: statuses.map((name, i) => ({ id: String(i + 1), name, to: { name } })) });
      if (tool === "transitionJiraIssue") {
        const to = statuses[Number((args["transition"] as { id: string }).id) - 1]!;
        if (to === input.failMoveTo) return { content: [{ type: "text", text: "Transition is not valid" }], isError: true };
        state.moves.push(`${state.status} → ${to}`);
        state.status = to;
      }
      return json({});
    },
  };
  return { mcp, state };
}

function binding(kv: Record<string, unknown>, mcp: unknown, posts: string[], api = slackApi()): SlackBinding {
  resetExternalSenderCache();
  const client = { apiCall: (method: string, args: Record<string, unknown>) => api.transport.call(method, args), chat: { postMessage: async () => ({ ok: true, ts: "1758510003.000100" }) } };
  return {
    slack: { ...THREAD, teamId: TEAM },
    thread: { startTyping: async () => {}, post: async (text: string) => (posts.push(text), { ts: "1758510011.000100" }) },
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      slack: { getClient: async () => client },
      mcp,
    },
  } as unknown as SlackBinding;
}

function said(text: string, user = FILER, ts = "1758510010.000100"): SlackMessage {
  return { text, body: text, markdown: text, ts, ...THREAD, teamId: TEAM, author: { userId: user, userName: "alice", isBot: false } };
}

const onChannelPost = getSlackChannelOptions(slack)?.onChannelPost as SlackMessageHandler;

async function retry(input: { status: string; kv?: Record<string, unknown>; comments?: Array<{ id: string; body: string }>; failMoveTo?: string; message?: SlackMessage }) {
  const kv = input.kv ?? structuredClone(BOUND);
  const jiraState = tracker({ status: input.status, ...(input.comments === undefined ? {} : { comments: input.comments }), ...(input.failMoveTo === undefined ? {} : { failMoveTo: input.failMoveTo }) });
  const posts: string[] = [];
  let decision: unknown = "threw";
  const log = console.log;
  console.log = () => {};
  try {
    decision = await onChannelPost(binding(kv, jiraState.mcp, posts), input.message ?? said(`<@U0FACTORY> retry ${KEY}`));
  } catch {
    // The model path needs a live Slack thread; what matters is that the message went there.
  } finally {
    console.log = log;
  }
  return { kv, moves: jiraState.state.moves, status: jiraState.state.status, posts, decision };
}

test("only a message that is just retry KEY, with Slack chrome allowed, is the command", () => {
  assert.equal(retryTarget("retry TLSSN-42"), KEY);
  assert.equal(retryTarget("<@U0FACTORY> Retry tlssn-42."), KEY);
  assert.equal(retryTarget("retry <https://example.atlassian.net/browse/TLSSN-42|TLSSN-42>\n*Sent using* <@U0EXAMPLE1|Cursor>"), KEY);
  for (const text of ["retry TLSSN-42 please", "can you retry TLSSN-42", "retry", "retry file"]) assert.equal(retryTarget(text), undefined, text);
});

test("a stuck approval is redelivered Approved → Planned → Approved, quietly, with one reply", async () => {
  const { kv, moves, status, posts, decision } = await retry({ status: "Approved" });
  assert.equal(decision, null);
  assert.deepEqual(moves, ["Approved → Planned", "Planned → Approved"]);
  assert.equal(status, "Approved");
  assert.equal(posts.length, 1);
  assert.equal(
    posts[0],
    "Sent TLSSN-42's approval to the worker again. If an agent already started, its link comes here and the ticket moves to In Progress; if none did, the worker starts one unless a launch is already under way."
  );
  assert.notEqual(kv[retryBounceKey(KEY)], undefined, "the move-back line stays quiet");
  assert.equal((kv[slackApprovalKey(KEY)] as Record<string, unknown>)["by"], FILER, "the Approved line stays quiet");

  // The same Slack message delivered again moves nothing.
  const again = await retry({ status: "Approved", kv });
  assert.deepEqual([again.moves, again.posts], [[], []]);
});

test("the retry bounce's Planned webhook posts no move-back line; the same move without a retry does", async () => {
  const { kv } = await retry({ status: "Approved" });
  assert.deepEqual(await movedBack(kv), []);
  const board = structuredClone(BOUND);
  assert.equal((await movedBack(board)).length, 1);
});

async function movedBack(kv: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const posts: Record<string, unknown>[] = [];
  const raw = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    issue: { key: KEY, fields: { summary: "CSV export", status: { name: "Planned" }, project: { key: "TLSSN" } } },
    changelog: { id: "7001", items: [{ field: "status", fromString: "Approved", toString: "Planned" }] },
  });
  const handler = (jira as unknown as { routes: Array<{ handler: (request: Request, ctx: unknown) => Promise<Response> }> }).routes[0]!.handler;
  const background: Promise<unknown>[] = [];
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.JIRA_WEBHOOK_SECRET).update(raw).digest("hex")}` } });
  await handler(request, {
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      mcp: tracker({ status: "Planned" }).mcp,
      slack: { getClient: async () => ({ chat: { postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: "1758510004.000100" }) } }) },
    },
    waitUntil: (promise: Promise<unknown>) => void background.push(promise),
    body: JSON.parse(raw),
  });
  await Promise.all(background);
  return posts;
}

test("a hop still inside its deadline is not started again", async () => {
  const kv = {
    ...structuredClone(BOUND),
    [hopWatchKey(KEY)]: { hop: "launch", since: NOW.toISOString(), dueAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(), changelogId: "6001" },
  };
  const { moves, posts, decision } = await retry({ status: "Approved", kv });
  assert.equal(decision, null);
  assert.deepEqual(moves, []);
  assert.match(posts[0]!, /^The worker still has about 5 minutes before TLSSN-42 counts as stuck, so I did not start it again\./);
});

// The plan start check's final line (hop-watch.ts) offers `retry KEY` while
// the 15-minute watch for that entry is still inside its deadline; a retry
// that line asked for must not be refused as within_deadline.
test("a manual retry after the start check's final line (or a failed automatic re-send) goes through inside the 15-minute deadline", async () => {
  for (const startCheck of ["final", "not_moved"] as const) {
    const kv = {
      ...structuredClone(BOUND),
      [hopWatchKey(KEY)]: { hop: "plan", since: new Date(NOW.getTime() - 5 * 60_000).toISOString(), dueAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(), changelogId: "5002", baselineCommentId: "1", startDueAt: new Date(NOW.getTime() - 60_000).toISOString(), startCheck },
    };
    const { moves, posts, decision } = await retry({ status: "Triaged", kv, comments: [{ id: "1", body: "Triage: feedback\nSeverity: medium" }] });
    assert.equal(decision, null, startCheck);
    assert.deepEqual(moves, ["Triaged → To Do", "To Do → Triaged"], startCheck);
    assert.match(posts[0]!, /^Started a fresh planning run for TLSSN-42\./, startCheck);
  }
  // A fresh entry the start check has not spoken for (the re-send's successor) is still waited out.
  const waiting = {
    ...structuredClone(BOUND),
    [hopWatchKey(KEY)]: { hop: "plan", since: new Date(NOW.getTime() - 5 * 60_000).toISOString(), dueAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(), changelogId: "5003" },
  };
  const refused = await retry({ status: "Triaged", kv: waiting });
  assert.deepEqual(refused.moves, []);
  assert.match(refused.posts[0]!, /^The planner still has about 10 minutes before TLSSN-42 counts as stuck/);
});

// Bugbot: a re-send marked `retried` whose request died between its two
// moves leaves the ticket in To Do; the mark is written before the move, so
// a record still at `retried` is a re-send that never landed, and the person
// it stranded must be able to retry it.
test("a manual retry after a re-send that died mid-bounce goes through; one while the re-sent run is live is still refused", async () => {
  const retried = (since: Date) => ({ hop: "plan", since: since.toISOString(), dueAt: new Date(since.getTime() + 15 * 60_000).toISOString(), changelogId: "5002", baselineCommentId: "1", startDueAt: new Date(since.getTime() + 4 * 60_000).toISOString(), startCheck: "retried" });
  const since = new Date(NOW.getTime() - 6 * 60_000);
  const stranded = await retry({ status: "To Do", kv: { ...structuredClone(BOUND), [hopWatchKey(KEY)]: retried(since) }, comments: [{ id: "1", body: "Triage: feedback\nSeverity: medium" }] });
  assert.equal(stranded.decision, null);
  assert.deepEqual(stranded.moves, ["To Do → Triaged"]);
  assert.equal(stranded.status, "Triaged");

  // The bounce landed, the Triaged webhook that arms the next entry was lost, and the re-sent run is under way: no second run.
  const live = await retry({
    status: "Triaged",
    kv: { ...structuredClone(BOUND), [hopWatchKey(KEY)]: retried(since) },
    comments: [
      { id: "1", body: "Triage: feedback\nSeverity: medium" },
      { id: "2", body: `Planning started: ${KEY}\nSession: ses_fb22df82\nStarted at: ${new Date(NOW.getTime() - 60_000).toISOString()}` },
    ],
    message: said(`<@U0FACTORY> retry ${KEY}`, FILER, "1758510040.000100"),
  });
  assert.deepEqual(live.moves, []);
  assert.match(live.posts[0]!, /^The planner is still running for TLSSN-42 \(1 min\), so I did not start a second run\./);
});

test("a ticket stuck in Triaged gets a fresh planning run; one stuck in To Do goes to the planner without a verdict", async () => {
  const triaged = await retry({ status: "Triaged", comments: [{ id: "1", body: "Triage: feedback\nSeverity: medium" }] });
  assert.deepEqual(triaged.moves, ["Triaged → To Do", "To Do → Triaged"]);
  assert.match(triaged.posts[0]!, /^Started a fresh planning run for TLSSN-42\./);

  const todo = await retry({ status: "To Do", comments: [{ id: "1", body: "Filed from Slack." }] });
  assert.deepEqual(todo.moves, ["To Do → Triaged"]);
  assert.match(todo.posts[0]!, /^Sent TLSSN-42 to the planner without a triage verdict\./);
});

// TLSSN-45: `retry` 20 minutes in started a second planner run while the first
// was still working; both spent their minutes and only one plan could land.
test("a Triaged retry while the planner's run is still live starts no second run and says how long it has been running", async () => {
  const startedAt = new Date(NOW.getTime() - 20 * 60_000).toISOString();
  const kv = {
    ...structuredClone(BOUND),
    [hopWatchKey(KEY)]: { hop: "plan", since: startedAt, dueAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), changelogId: "5001", baselineCommentId: "1" },
  };
  const comments = [
    { id: "1", body: "Triage: bug\nSeverity: high\nType: Bug" },
    { id: "2", body: `Planning started: ${KEY}\nSession: ses_8de9de41\nStarted at: ${startedAt}\n\nThe planner is reading the code.` },
  ];
  const live = await retry({ status: "Triaged", kv, comments });
  assert.equal(live.decision, null);
  assert.deepEqual(live.moves, []);
  assert.equal(live.posts.length, 1);
  assert.match(live.posts[0]!, /^The planner is still running for TLSSN-42 \(20 min\), so I did not start a second run\. A plan, a Needs info, or a Plan stopped line lands here when it finishes\. If nothing lands in about 20 minutes, say `retry TLSSN-42` again\.$/);

  const ended = await retry({ status: "Triaged", comments: [...comments, { id: "3", body: `Plan stopped: ${KEY}\nWhy: The planning run failed: boom.` }], message: said(`<@U0FACTORY> retry ${KEY}`, FILER, "1758510020.000100") });
  assert.deepEqual(ended.moves, ["Triaged → To Do", "To Do → Triaged"], "a run that ended is no reason to wait");

  const lostAt = new Date(NOW.getTime() - 50 * 60_000).toISOString();
  const lost = await retry({ status: "Triaged", comments: [comments[0]!, { id: "2", body: comments[1]!.body.replace(startedAt, lostAt) }], message: said(`<@U0FACTORY> retry ${KEY}`, FILER, "1758510030.000100") });
  assert.deepEqual(lost.moves, ["Triaged → To Do", "To Do → Triaged"], "a run past the live window is lost");
  assert.match(lost.posts[0]!, /^Started a fresh planning run for TLSSN-42\.$/);
});

// Verifier: once the hop watch fired and was deleted, retry lost the Triaged
// entry time and counted the newest marker of any age, so "it never reported
// starting, say retry" could be followed by retry answering "still running".
test("after the plan watch has fired, retry still judges the marker against this Triaged entry", async () => {
  const enteredAt = new Date(NOW.getTime() - 16 * 60_000).toISOString();
  const olderRunAt = new Date(NOW.getTime() - 30 * 60_000).toISOString();
  const kv = { ...structuredClone(BOUND), [triagedSinceKey(KEY)]: { since: enteredAt, changelogId: "5001" } };
  const comments = [
    { id: "1", body: "Triage: bug\nSeverity: high\nType: Bug" },
    { id: "2", body: `Planning started: ${KEY}\nSession: ses_older\nStarted at: ${olderRunAt}\n\nThe planner is reading the code.` },
  ];
  const result = await retry({ status: "Triaged", kv, comments });
  assert.deepEqual(result.moves, ["Triaged → To Do", "To Do → Triaged"], "an earlier entry's run is not this entry's run");
  assert.match(result.posts[0]!, /^Started a fresh planning run for TLSSN-42\.$/);
});

test("nothing moves for a gated verdict, an approval with no plan, or a ticket past the watched hops", async () => {
  const gated = await retry({ status: "Triaged", comments: [{ id: "1", body: "Triage: question\nSeverity: low" }] });
  assert.deepEqual(gated.moves, []);
  assert.match(gated.posts[0]!, /one the planner does not plan \(question\)/);

  const noPlan = await retry({ status: "Approved", comments: [{ id: "1", body: "Triage: feedback\nSeverity: medium" }] });
  assert.deepEqual(noPlan.moves, []);
  assert.match(noPlan.posts[0]!, /^TLSSN-42 has no plan on the ticket/);

  const later = await retry({ status: "In Progress" });
  assert.deepEqual(later.moves, []);
  assert.match(later.posts[0]!, /^TLSSN-42 is In Progress\. Nothing is waiting/);
});

const IMPLEMENTING = { id: "101", body: "Implementing: https://cursor.com/agents/bc-tlssn-42" };

test("TLSSN-35: an In Progress ticket the worker launched is sent back to it as In Progress → Approved, quietly, with one reply", async () => {
  const { kv, moves, status, posts, decision } = await retry({ status: "In Progress", comments: [PLAN, IMPLEMENTING] });
  assert.equal(decision, null);
  assert.deepEqual(moves, ["In Progress → Approved"]);
  assert.equal(status, "Approved");
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /^Sent TLSSN-42 back to the worker to open its pull request\. If the agent pushed its branch, the worker opens the pull request ready for review and TLSSN-42 moves to In Review here\./);
  assert.match(posts[0]!, /No second agent starts\.$/);
  assert.notEqual(kv[pullRequestRetryKey(KEY)], undefined);

  const again = await retry({ status: "Approved", kv, comments: [PLAN, IMPLEMENTING] });
  assert.deepEqual([again.moves, again.posts], [[], []], "the same Slack message delivered again moves nothing");
});

test("the pull request retry's Approved and In Progress webhooks post nothing; the same moves without a retry do", async () => {
  const { kv } = await retry({ status: "In Progress", comments: [PLAN, IMPLEMENTING] });
  assert.deepEqual(await statusWebhook(kv, { from: "In Progress", to: "Approved", changelogId: "7101" }), []);
  assert.deepEqual(await statusWebhook(kv, { from: "Approved", to: "In Progress", changelogId: "7102" }), []);

  const board = structuredClone(BOUND);
  assert.equal((await statusWebhook(board, { from: "Approved", to: "In Progress", changelogId: "7103" })).length, 1);
});

test("an In Progress retry whose move fails clears its quiet record and says nothing changed", async () => {
  const { kv, moves, posts } = await retry({ status: "In Progress", comments: [PLAN, IMPLEMENTING], failMoveTo: "Approved" });
  assert.deepEqual(moves, []);
  assert.equal(kv[pullRequestRetryKey(KEY)], undefined);
  assert.match(posts[0]!, /^I could not send TLSSN-42 back to the worker .*nothing changed\.$/);
});

async function statusWebhook(kv: Record<string, unknown>, input: { from: string; to: string; changelogId: string }): Promise<Record<string, unknown>[]> {
  const posts: Record<string, unknown>[] = [];
  const raw = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    issue: { key: KEY, fields: { summary: "CSV export", status: { name: input.to }, project: { key: "TLSSN" } } },
    changelog: { id: input.changelogId, items: [{ field: "status", fromString: input.from, toString: input.to }] },
  });
  const handler = (jira as unknown as { routes: Array<{ handler: (request: Request, ctx: unknown) => Promise<Response> }> }).routes[0]!.handler;
  const background: Promise<unknown>[] = [];
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.JIRA_WEBHOOK_SECRET).update(raw).digest("hex")}` } });
  const client = {
    chat: { postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: "1758510004.000100" }), update: async () => ({ ok: true }) },
    conversations: { replies: async () => ({ ok: true, messages: [] }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    apiCall: async () => ({ ok: true, messages: [] }),
  };
  await handler(request, {
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      mcp: tracker({ status: input.to, comments: [PLAN, IMPLEMENTING] }).mcp,
      slack: { getClient: async () => client },
    },
    waitUntil: (promise: Promise<unknown>) => void background.push(promise),
    body: JSON.parse(raw),
  });
  await Promise.all(background);
  return posts;
}

test("a failed move back clears the quiet records and says nothing changed", async () => {
  const { kv, moves, posts } = await retry({ status: "Approved", failMoveTo: "Planned" });
  assert.deepEqual(moves, []);
  assert.equal(kv[retryBounceKey(KEY)], undefined);
  assert.equal(kv[slackApprovalKey(KEY)], undefined);
  assert.match(posts[0]!, /nothing changed/);
});

test("anyone but the filer gets one host refusal, no model turn, and moves nothing", async () => {
  const other = await retry({ status: "Approved", message: said(`retry ${KEY}`, "U0BOB0001") });
  assert.deepEqual(other.moves, []);
  assert.equal(other.posts.length, 1);
  assert.match(other.posts[0]!, /^Only the person who filed TLSSN-42 can say `retry TLSSN-42`/);
  assert.equal(other.decision, null);
  assert.equal(other.kv[`retry-command/${THREAD.channelId}:1758510010.000100`], undefined);
});

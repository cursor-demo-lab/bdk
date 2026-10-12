// Adversarial checks on the Bugbot-round reaction fixes: DM filing, slow decline hold, claim release.
// driven through July 0.2.13's own reaction_added parsing and dispatch with
// Slack and Jira stubbed, like slack.reactions.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, HostMcpCallResult } from "@cursor/july";
import {
  createDefaultOnInbound,
  createEventIdDedupe,
  dispatchInboundFromEventBody,
  getSlackChannelOptions,
  resetExternalSenderCache,
  type SlackApiTransport,
  type SlackBinding,
  type SlackMessage,
  type SlackMessageHandler,
} from "@cursor/july/channels/slack";
import { approveTicketKey } from "../lib/approve-command.js";
import { recordKv } from "../lib/kv-race.fixtures.js";
import { reactionClaimKey } from "../lib/reaction-approval.js";
import { filingPromptKey, planPostKey, recordPlanPost } from "../lib/reaction-targets.js";
import { threadTicketsKey } from "../lib/thread-tickets.js";
import slack from "./slack.js";

process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";

const TEAM = "T0123";
const CHANNEL = "C0EXAMPLE1";
const ROOT = "1758510000.123456";
const THREAD = { channelId: CHANNEL, threadTs: ROOT };
const PLAN_TS = "1758510005.000200";
const REPLAN_TS = "1758510300.000400";
const PROMPT_TS = "1758510001.000300";
const FILER = "U0ALICE01";
const BOB = "U0BOB0001";
const DESK = "U0FACTORY";
const CRUMB = "TLSSN-42: starting implementation…";

function slackApi(options: { lookupFails?: string[]; apps?: string[] } = {}) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let posted = 0;
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      const body = args as Record<string, unknown>;
      calls.push({ method, args: body });
      if (method === "auth.test") return { ok: true, user_id: DESK, user: "factory" };
      if (method === "users.info") {
        const id = String(body["user"]);
        if ((options.lookupFails ?? []).includes(id)) return { ok: false, error: "user_not_found" };
        return { ok: true, user: { id, name: id.toLowerCase(), team_id: TEAM, is_bot: id === DESK, is_app_user: (options.apps ?? []).includes(id), profile: { display_name: id === FILER ? "alice" : "" } } };
      }
      if (method === "chat.postMessage") return { ok: true, ts: `1758510100.00${++posted}` };
      return { ok: true, messages: [] };
    },
  };
  const posts = () => calls.filter((call) => call.method === "chat.postMessage").map((call) => String(call.args["text"]));
  return { calls, transport, posts };
}

function jira(input: { status: string; transitionDelayMs?: number }) {
  const moves: string[] = [];
  const comments: string[] = [];
  const thread: Array<{ id: string; body: string }> = [{ id: "10000", body: "Plan: TLSSN-42\nSummary: CSV export" }];
  const state = { status: input.status, commentsUnreadable: false };
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
      { name: "addCommentToJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey", "commentBody") },
      // Present only while comment reads fail, so status reads still work.
      ...(state.commentsUnreadable ? [{ name: "getJiraIssueComments", inputSchema: schema("cloudId", "issueIdOrKey") }] : []),
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (tool === "getJiraIssueComments") return { content: [{ type: "text", text: "Jira is having a moment" }], isError: true };
      if (tool === "getJiraIssue") {
        return json({ key: "TLSSN-42", fields: { summary: "CSV export", status: { name: state.status }, comment: { comments: thread } } });
      }
      if (tool === "getTransitionsForJiraIssue") return json({ transitions: state.status === "Planned" ? [{ id: "31", name: "Approve", to: { name: "Approved" } }] : [] });
      if (tool === "transitionJiraIssue") {
        if (input.transitionDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, input.transitionDelayMs));
        moves.push(String((args["transition"] as { id: string }).id));
        state.status = "Approved";
      }
      if (tool === "addCommentToJiraIssue") {
        comments.push(String(args["commentBody"]));
        thread.push({ id: String(10000 + thread.length), body: String(args["commentBody"]) });
      }
      return json({ id: "10001" });
    },
  };
  return { mcp, moves, comments, thread, state };
}

const planned = (): Record<string, unknown> => ({
  "ticket/TLSSN-42": { ...THREAD, originatorUserId: FILER },
  [threadTicketsKey(THREAD)]: ["TLSSN-42"],
  [planPostKey({ channelId: CHANNEL, ts: PLAN_TS })]: { issueKey: "TLSSN-42", threadTs: ROOT, at: new Date().toISOString() },
});

const filing = (): Record<string, unknown> => ({
  [filingPromptKey({ channelId: CHANNEL, ts: PROMPT_TS })]: { requester: FILER, threadTs: ROOT, at: new Date().toISOString() },
});

type World = { rows: Record<string, unknown>; kv: HostKvApi; api: ReturnType<typeof slackApi>; tracker: ReturnType<typeof jira> };

function world(rows: Record<string, unknown>, options: { status?: string; api?: ReturnType<typeof slackApi>; transitionDelayMs?: number } = {}): World {
  return {
    rows,
    kv: recordKv(rows),
    api: options.api ?? slackApi(),
    tracker: jira({ status: options.status ?? "Planned", ...(options.transitionDelayMs === undefined ? {} : { transitionDelayMs: options.transitionDelayMs }) }),
  };
}

function host(w: World) {
  const client = { apiCall: (method: string, args: Record<string, unknown>) => w.api.transport.call(method, args) };
  return { kv: w.kv, slack: { getClient: async () => client }, mcp: w.tracker.mcp };
}

const options = getSlackChannelOptions(slack)!;
const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never;

function reaction(user: string, name: string, ts: string) {
  return {
    type: "event_callback",
    team_id: TEAM,
    event_id: `Ev${Math.random()}`,
    event: { type: "reaction_added", user, reaction: name, item: { type: "message", channel: CHANNEL, ts }, item_user: DESK, event_ts: `17585102${Math.floor(Math.random() * 90 + 10)}.000100` },
  };
}

async function deliver(w: World, body: unknown) {
  resetExternalSenderCache();
  const sends: Array<Record<string, unknown>> = [];
  const pending: Promise<unknown>[] = [];
  const send = (async (prompt: string, sendOptions: Record<string, unknown>) => (sends.push({ ...sendOptions, prompt }), { sessionId: "ses_test" })) as never;
  dispatchInboundFromEventBody(body, {
    send,
    waitUntil: (promise) => void pending.push(promise),
    onAppMention: options.onAppMention ?? createDefaultOnInbound(),
    onDirectMessage: options.onDirectMessage ?? createDefaultOnInbound(),
    ...(options.onReactionAdded === undefined ? {} : { onReactionAdded: options.onReactionAdded }),
    credentials: { botToken: w.api.transport },
    eventIds: createEventIdDedupe(),
    host: host(w) as never,
    artifacts: {} as never,
    log,
    mentionsEnabled: true,
    directMessagesEnabled: true,
  });
  await Promise.all(pending);
  return sends;
}

function binding(w: World): SlackBinding {
  return {
    slack: { ...THREAD, teamId: TEAM },
    thread: { startTyping: async () => {}, post: async (text: string) => (w.api.calls.push({ method: "thread.post", args: { text } }), { ts: "1758510111.000100" }) },
    host: host(w),
  } as unknown as SlackBinding;
}

const typed = (text: string, user = FILER, ts = "1758510210.000100"): SlackMessage => ({ text, body: text, markdown: text, ts, ...THREAD, teamId: TEAM, author: { userId: user, userName: user.toLowerCase(), isBot: false } });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** The ticket went back to Planned and a fresh plan sits at REPLAN_TS, written straight to kv: no hold is cleared. */
function replan(w: World) {
  w.tracker.state.status = "Planned";
  w.rows[planPostKey({ channelId: CHANNEL, ts: REPLAN_TS })] = { issueKey: "TLSSN-42", threadTs: ROOT, at: new Date().toISOString() };
}

/** The same, recorded the way announcePlan records a plan post it just posted. */
async function replanPosted(w: World) {
  w.tracker.state.status = "Planned";
  await recordPlanPost(w.kv, { channel: CHANNEL, ts: REPLAN_TS, threadTs: ROOT, issueKey: "TLSSN-42", at: new Date() });
}

const DM = "D0DM00001";
const DM_PROMPT_1 = "1758511000.000100";
const DM_PROMPT_2 = "1758512000.000100";

const age = (w: World, key: string, ms: number) => {
  w.rows[key] = { ...(w.rows[key] as Record<string, unknown>), at: ago(ms) };
};

function reactionIn(channel: string, user: string, name: string, ts: string) {
  const body = reaction(user, name, ts);
  return { ...body, event: { ...body.event, item: { ...body.event.item, channel } } };
}

// A DM is one thread (no threadTs): the first request's ticket is on the
// DM's thread-tickets list when the second request's filing prompt lands.
const dmSecondRequest = (): Record<string, unknown> => ({
  "ticket/TLSSN-41": { channelId: DM, originatorUserId: FILER },
  [threadTicketsKey({ channelId: DM })]: ["TLSSN-41"],
  [filingPromptKey({ channelId: DM, ts: DM_PROMPT_1 })]: { requester: FILER, at: ago(3_600_000) },
  [filingPromptKey({ channelId: DM, ts: DM_PROMPT_2 })]: { requester: FILER, at: new Date().toISOString() },
});

test("DM: ✅ on the second request's filing prompt files it (the first request's ticket is not this one)", async () => {
  const w = world(dmSecondRequest());
  const sends = await deliver(w, reactionIn(DM, FILER, "white_check_mark", DM_PROMPT_2));
  assert.equal(sends.length, 1, `no approve file turn; claim: ${JSON.stringify(w.rows[reactionClaimKey({ channelId: DM, ts: DM_PROMPT_2, act: "filing" })])}`);
});

test("DM: ❌ on the second request's filing prompt declines it, not 'already filed as TLSSN-41'", async () => {
  const w = world(dmSecondRequest());
  await deliver(w, reactionIn(DM, FILER, "x", DM_PROMPT_2));
  assert.deepEqual(w.api.posts(), ["Okay, I won't file this; nothing was created in Jira."]);
});

test("slow decline: a decline hold past APPROVE_TICKET_HOLD_MS (Jira hung over two minutes) is still not taken over by a ✅", async () => {
  const w = world({ ...planned(), [approveTicketKey("TLSSN-42")]: { state: "pending", owner: "decliner", act: "decline", by: "alice", at: ago(130_000) } });
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual([w.tracker.moves, w.api.posts()], [[], []]);
});

test("slow decline: a typed approve during a decline's hold does nothing and says nothing wrong", async () => {
  const w = world({ ...planned(), [approveTicketKey("TLSSN-42")]: { state: "pending", owner: "decliner", act: "decline", by: "alice", at: ago(50_000) } });
  const onAppMention = options.onAppMention as SlackMessageHandler;
  await onAppMention(binding(w), typed("approve TLSSN-42"));
  assert.deepEqual(w.tracker.moves, []);
});

test("claims: a successful ✅, then every claim and hold expired, then ✅ again on an Approved ticket: no second move and no post", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  age(w, reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "approve" }), 121_000);
  age(w, approveTicketKey("TLSSN-42"), 121_000);
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual([w.tracker.moves, w.api.posts()], [["31"], [CRUMB]]);
});

test("claims: a ✅ swallowed by an in-flight typed approve released its claim, and a ❌ that found the hold held released its claim too", async () => {
  const w = world({ ...planned(), [approveTicketKey("TLSSN-42")]: { state: "pending", owner: "typed", act: "approve", by: "alice", at: ago(1_000) } });
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  assert.equal(w.rows[reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "approve" })], undefined);
  assert.equal(w.rows[reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "decline" })], undefined);
  assert.deepEqual([w.tracker.moves, w.tracker.comments], [[], []]);
});

test("claims: a ❌ decline releases the ticket hold, so an immediate ✅ approves the declined plan", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  assert.equal(w.rows[approveTicketKey("TLSSN-42")], undefined);
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual(w.tracker.moves, ["31"]);
});

// One denial per plan, with Jira's comments as the record: the claim
// expiring, or the hold being released, must not write a second one.
test("claims: a ❌ re-added after its claim expires on a still-Planned ticket writes no second Denied comment and posts nothing", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  assert.equal(w.api.posts().length, 1);
  age(w, reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "decline" }), 121_000);
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  assert.equal(w.tracker.comments.length, 1, `comments: ${JSON.stringify(w.tracker.comments)}`);
  assert.equal(w.api.posts().length, 1, `posts: ${JSON.stringify(w.api.posts())}`);
});

test("claims: ❌ after a typed deny KEY already declined the plan writes no second Denied comment and answers once", async () => {
  const w = world(planned());
  w.tracker.thread.push({ id: "10001", body: "Denied in Slack by alice" });
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  assert.deepEqual([w.tracker.comments, w.api.posts()], [[], ["The plan for TLSSN-42 is already declined; nothing changed."]]);
  age(w, reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "decline" }), 121_000);
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  assert.equal(w.api.posts().length, 1, `posts: ${JSON.stringify(w.api.posts())}`);
});

test("claims: a replan's new Plan: comment after a decline can be declined again, with a new Denied comment", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  w.tracker.thread.push({ id: "10500", body: "Plan: TLSSN-42\nSummary: CSV export, streamed" });
  await replanPosted(w);
  await deliver(w, reaction(FILER, "x", REPLAN_TS));
  assert.equal(w.tracker.comments.length, 2, `comments: ${JSON.stringify(w.tracker.comments)}`);
  assert.match(w.api.posts()[1] ?? "", /plan declined/);
});

test("claims: a ❌ when the ticket's comments cannot be read writes nothing and says nothing changed", async () => {
  const w = world(planned());
  w.tracker.state.commentsUnreadable = true;
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  assert.deepEqual(w.tracker.comments, []);
  assert.deepEqual(w.api.posts(), ["I could not read TLSSN-42's comments in Jira just now, so nothing changed. React ❌ again in a minute, or say `deny TLSSN-42`."]);
  assert.equal(w.rows[reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "decline" })], undefined, "the ❌ can count again");
});

test("defect 2 original repro: ticket dragged back to Planned with no new post, re-✅ 46 s after the approval goes through", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  replan(w);
  age(w, approveTicketKey("TLSSN-42"), 46_000);
  await deliver(w, reaction(FILER, "white_check_mark", REPLAN_TS));
  assert.deepEqual(w.tracker.moves, ["31", "31"]);
});

test("DM keyed on its first message's ts (July's session thread): ✅ on the second request's filing prompt files it", async () => {
  const dm = { channelId: DM, threadTs: "1758510900.000100" };
  const w = world({
    "ticket/TLSSN-41": { ...dm, originatorUserId: FILER },
    [threadTicketsKey(dm)]: ["TLSSN-41"],
    [filingPromptKey({ channelId: DM, ts: DM_PROMPT_2 })]: { requester: FILER, threadTs: dm.threadTs, at: new Date().toISOString() },
  });
  assert.equal((await deliver(w, reactionIn(DM, FILER, "white_check_mark", DM_PROMPT_2))).length, 1);
});

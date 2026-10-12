// Edge probes of the filing prompt vs filedAt comparison (reaction-approval.ts filedSince, #163 9ba112f).
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
  const state = { status: input.status };
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
      { name: "addCommentToJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey", "commentBody") },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (tool === "getJiraIssue") return json({ key: "TLSSN-42", fields: { summary: "CSV export", status: { name: state.status } } });
      if (tool === "getTransitionsForJiraIssue") return json({ transitions: state.status === "Planned" ? [{ id: "31", name: "Approve", to: { name: "Approved" } }] : [] });
      if (tool === "transitionJiraIssue") {
        if (input.transitionDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, input.transitionDelayMs));
        moves.push(String((args["transition"] as { id: string }).id));
        state.status = "Approved";
      }
      if (tool === "addCommentToJiraIssue") comments.push(String(args["commentBody"]));
      return json({ id: "10001" });
    },
  };
  return { mcp, moves, comments, state };
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

const PROMPT_AT = Date.parse("2026-09-27T11:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function filedWorld(input: { filedAt?: string; promptAt?: number; thread?: { channelId: string; threadTs?: string }; promptTs?: string }): World {
  const thread = input.thread ?? THREAD;
  const promptTs = input.promptTs ?? PROMPT_TS;
  return world({
    "ticket/TLSSN-44": { ...thread, originatorUserId: FILER, ...(input.filedAt === undefined ? {} : { filedAt: input.filedAt }) },
    [threadTicketsKey(thread)]: ["TLSSN-44"],
    [filingPromptKey({ channelId: thread.channelId, ts: promptTs })]: { requester: FILER, ...(thread.threadTs === undefined ? {} : { threadTs: thread.threadTs }), at: iso(input.promptAt ?? PROMPT_AT) },
  });
}

// The prompt record's `at` is an absolute time; the harness clock is real, so keep the prompt inside its 24 h TTL.
const recent = () => Date.now() - 60_000;

test("filedAt equal to the prompt's at (same millisecond) counts as this prompt's filing", async () => {
  const at = recent();
  const w = filedWorld({ promptAt: at, filedAt: iso(at) });
  assert.deepEqual(await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS)), []);
});

test("typed approve file and ✅ both write filedAt through file_ticket: a ticket filed after the prompt stops a later ✅ either way", async () => {
  const at = recent();
  const approved = filedWorld({ promptAt: at, filedAt: iso(at + 5_000) });
  assert.deepEqual(await deliver(approved, reaction(FILER, "white_check_mark", PROMPT_TS)), []);
  const declined = filedWorld({ promptAt: at, filedAt: iso(at + 5_000) });
  await deliver(declined, reaction(FILER, "x", PROMPT_TS));
  assert.deepEqual(declined.api.posts(), ["This request is already filed as TLSSN-44, so ❌ changes nothing."]);
});

test(
  "clock skew: this prompt's own ticket stamped 1 s before the prompt record (another replica's clock) still counts as filed",
  async () => {
    const at = recent();
    const w = filedWorld({ promptAt: at, filedAt: iso(at - 1_000) });
    assert.deepEqual(await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS)), [], "a second approve file turn for a filed request");
  }
);

test(
  "channel thread: the filing prompt re-posted after the ticket was filed does not start a second filing on ✅",
  async () => {
    const filedAt = recent();
    const w = filedWorld({ filedAt: iso(filedAt), promptAt: filedAt + 30_000, promptTs: "1758513000.000100" });
    assert.deepEqual(await deliver(w, reaction(FILER, "white_check_mark", "1758513000.000100")), []);
  }
);

test("a channel thread's ticket counts as filed with or without filedAt; in a DM a ticket with no filedAt does not", async () => {
  const w = filedWorld({ promptAt: recent() });
  assert.deepEqual(await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS)), [], "a channel thread holds one request");
  const dm = filedWorld({ promptAt: recent(), thread: { channelId: DM }, promptTs: DM_PROMPT_1 });
  assert.equal((await deliver(dm, reactionIn(DM, FILER, "white_check_mark", DM_PROMPT_1))).length, 1);
});

test("an unparseable prompt at never reaches the filed check (the TTL read rejects it)", async () => {
  const w = world({
    "ticket/TLSSN-44": { ...THREAD, originatorUserId: FILER, filedAt: iso(recent()) },
    [threadTicketsKey(THREAD)]: ["TLSSN-44"],
    [filingPromptKey({ channelId: CHANNEL, ts: PROMPT_TS })]: { requester: FILER, threadTs: ROOT, at: "not a date" },
  });
  assert.deepEqual([await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS)), w.api.posts()], [[], []]);
});

test("DM: ❌ on an old, already-filed prompt names only that request's ticket, not a later request's", async () => {
  const p1 = recent() - 20_000;
  const w = world({
    "ticket/TLSSN-41": { channelId: DM, originatorUserId: FILER, filedAt: iso(p1 + 1_000) },
    "ticket/TLSSN-42": { channelId: DM, originatorUserId: FILER, filedAt: iso(p1 + 15_000) },
    [threadTicketsKey({ channelId: DM })]: ["TLSSN-41", "TLSSN-42"],
    [filingPromptKey({ channelId: DM, ts: DM_PROMPT_1 })]: { requester: FILER, at: iso(p1) },
    [filingPromptKey({ channelId: DM, ts: DM_PROMPT_2 })]: { requester: FILER, at: iso(p1 + 10_000) },
  });
  await deliver(w, reactionIn(DM, FILER, "x", DM_PROMPT_1));
  assert.deepEqual(w.api.posts(), ["This request is already filed as TLSSN-41, so ❌ changes nothing."]);
});

test("DM: ✅ on an old, never-filed prompt after a newer request's prompt starts an approve file turn (it files the DM's current triage)", async () => {
  const p1 = recent() - 20_000;
  const w = world({
    [filingPromptKey({ channelId: DM, ts: DM_PROMPT_1 })]: { requester: FILER, at: iso(p1) },
    [filingPromptKey({ channelId: DM, ts: DM_PROMPT_2 })]: { requester: FILER, at: iso(p1 + 10_000) },
  });
  const sends = await deliver(w, reactionIn(DM, FILER, "white_check_mark", DM_PROMPT_1));
  assert.equal(sends.length, 1, "documents behaviour: the old prompt's ✅ starts an approve file turn, which files the DM's current triage (request 2)");
});

test("DM: the previous request's ticket, filed inside the skew window before this prompt, is not this prompt's filing (the prompt lists it as already there)", async () => {
  const p2 = recent();
  const w = world({
    "ticket/TLSSN-41": { channelId: DM, originatorUserId: FILER, filedAt: iso(p2 - 3_000) },
    [threadTicketsKey({ channelId: DM })]: ["TLSSN-41"],
    [filingPromptKey({ channelId: DM, ts: DM_PROMPT_2 })]: { requester: FILER, at: iso(p2), before: ["TLSSN-41"] },
  });
  assert.equal((await deliver(w, reactionIn(DM, FILER, "white_check_mark", DM_PROMPT_2))).length, 1);
  const declined = world({
    "ticket/TLSSN-41": { channelId: DM, originatorUserId: FILER, filedAt: iso(p2 - 3_000) },
    [threadTicketsKey({ channelId: DM })]: ["TLSSN-41"],
    [filingPromptKey({ channelId: DM, ts: DM_PROMPT_2 })]: { requester: FILER, at: iso(p2), before: ["TLSSN-41"] },
  });
  await deliver(declined, reactionIn(DM, FILER, "x", DM_PROMPT_2));
  assert.deepEqual(declined.api.posts(), ["Okay, I won't file this; nothing was created in Jira."]);
});

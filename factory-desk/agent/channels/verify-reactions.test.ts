// Adversarial checks on ✅ / ❌ reaction approvals (reaction-approval.ts),
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

test("typed approve racing a ✅ in the same tick: one move, one crumb", async () => {
  const w = world(planned(), { transitionDelayMs: 30 });
  const onAppMention = options.onAppMention as SlackMessageHandler;
  await Promise.all([deliver(w, reaction(FILER, "white_check_mark", PLAN_TS)), onAppMention(binding(w), typed("approve TLSSN-42"))]);
  assert.deepEqual(w.tracker.moves, ["31"]);
  assert.equal(w.api.posts().filter((text) => text === CRUMB).length, 1);
});

test("a non-filer's typed approve neither approves nor blocks the filer's ✅", async () => {
  const w = world(planned());
  const onAppMention = options.onAppMention as SlackMessageHandler;
  await onAppMention(binding(w), typed("approve TLSSN-42", BOB));
  assert.deepEqual(w.tracker.moves, []);
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual(w.tracker.moves, ["31"]);
});

test("✅ added, removed, and added again (a new reaction_added each time) acts once, silently", async () => {
  const w = world(planned());
  for (let i = 0; i < 3; i++) await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual(w.tracker.moves, ["31"]);
  assert.deepEqual(w.api.posts(), [CRUMB]);
});

test("a ✅ whose Jira move failed can be retried by removing and re-adding it", async () => {
  const w = world(planned(), { status: "Planned" });
  const call = w.tracker.mcp.callTool;
  let fail = true;
  w.tracker.mcp.callTool = async (connection, tool, args) => (fail && tool === "transitionJiraIssue" ? { content: [{ type: "text", text: "boom" }], isError: true } : call(connection, tool, args));
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual(w.tracker.moves, []);
  assert.match(w.api.posts()[0] ?? "", /React ✅ again in a minute/);
  fail = false;
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual(w.tracker.moves, ["31"], "the failed attempt released both the reaction claim and the ticket hold");
});

test("a reactor whose users.info lookup fails, or an app user, is ignored", async () => {
  for (const api of [slackApi({ lookupFails: [FILER] }), slackApi({ apps: [FILER] })]) {
    const w = world({ ...planned(), ...filing() }, { api });
    const sends = [...(await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS))), ...(await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS)))];
    assert.deepEqual([sends, w.tracker.moves, w.api.posts()], [[], [], []]);
  }
});

test("❌ after ✅ on the filing prompt is silent and files nothing more", async () => {
  const w = world(filing());
  const first = await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS));
  const second = await deliver(w, reaction(FILER, "x", PROMPT_TS));
  assert.equal(first.length, 1);
  assert.deepEqual([second, w.api.posts()], [[], []]);
});

test("❌ after a completed ✅ on the plan declines nothing and leaves no Denied comment", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  assert.deepEqual(w.tracker.comments, []);
  assert.equal(w.tracker.state.status, "Approved");
  assert.ok(!w.api.posts().some((text) => /plan declined/.test(text)));
});

test(
  "❌ landing while a ✅ on the same plan is still moving the ticket: the person does not get both 'approved' and 'plan declined'",
  async () => {
    const w = world(planned(), { transitionDelayMs: 60 });
    await Promise.all([deliver(w, reaction(FILER, "white_check_mark", PLAN_TS)), new Promise((resolve) => setTimeout(resolve, 20)).then(() => deliver(w, reaction(FILER, "x", PLAN_TS)))]);
    const approved = w.tracker.moves.length === 1;
    const declined = w.tracker.comments.some((comment) => comment.startsWith("Denied in Slack"));
    assert.ok(!(approved && declined), `approved=${approved}, declined=${declined}, posts=${JSON.stringify(w.api.posts())}`);
  }
);

test("❌ then replan, then ✅ on the new plan post, approves it", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "x", PLAN_TS));
  replan(w);
  await deliver(w, reaction(FILER, "white_check_mark", REPLAN_TS));
  assert.deepEqual(w.tracker.moves, ["31"]);
});

test("re-approve after replan more than two minutes after the first approval goes through", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  (w.rows[approveTicketKey("TLSSN-42")] as Record<string, unknown>)["at"] = ago(121_000);
  replan(w);
  await deliver(w, reaction(FILER, "white_check_mark", REPLAN_TS));
  assert.deepEqual(w.tracker.moves, ["31", "31"]);
});

test(
  "re-approve after replan inside the two-minute hold is not swallowed as a duplicate",
  async () => {
    const w = world(planned());
    await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
    await replanPosted(w);
    await deliver(w, reaction(FILER, "white_check_mark", REPLAN_TS));
    assert.deepEqual(w.tracker.moves, ["31", "31"], `second approval: ${JSON.stringify(w.rows[reactionClaimKey({ channelId: CHANNEL, ts: REPLAN_TS, act: "approve" })])}`);
  }
);

test(
  "a ✅ on the new plan swallowed by a hold nothing cleared can still be retried once the hold expires",
  async () => {
    const w = world(planned());
    await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
    replan(w);
    await deliver(w, reaction(FILER, "white_check_mark", REPLAN_TS));
    (w.rows[approveTicketKey("TLSSN-42")] as Record<string, unknown>)["at"] = ago(121_000);
    await deliver(w, reaction(FILER, "white_check_mark", REPLAN_TS));
    assert.deepEqual(w.tracker.moves, ["31", "31"]);
  }
);

test("a typed approve of the new plan right after a replan approves it (the new plan post cleared approve-ticket/<KEY>)", async () => {
  const w = world(planned());
  const onAppMention = options.onAppMention as SlackMessageHandler;
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  await replanPosted(w);
  await onAppMention(binding(w), typed("approve TLSSN-42", FILER, "1758510400.000100"));
  assert.deepEqual(w.tracker.moves, ["31", "31"]);
  assert.deepEqual(w.api.calls.filter((call) => call.method === "thread.post"), []);
});

test("a typed deny KEY cannot land beside an approval in flight: the deny_ticket tool takes the same hold", async () => {
  const w = world(planned(), { transitionDelayMs: 60 });
  const approving = deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { takeTicketDecision } = await import("../lib/approve-command.js");
  assert.equal(await takeTicketDecision({ host: host(w) } as never, { issueKey: "TLSSN-42", by: "alice", now: new Date(), act: "decline" }), "duplicate");
  await approving;
  assert.deepEqual(w.tracker.moves, ["31"]);
});

test("stage emoji on the plan post, the filing prompt, and the root never act, from the filer or anyone", async () => {
  const w = world({ ...planned(), ...filing() });
  for (const name of ["eyes", "hourglass_flowing_sand", "memo", "hammer_and_wrench", "mag", "question", "warning"]) {
    for (const ts of [PLAN_TS, PROMPT_TS, ROOT]) {
      for (const user of [FILER, BOB, DESK]) {
        const sends = await deliver(w, reaction(user, name, ts));
        assert.deepEqual(sends, [], `${name} on ${ts} by ${user}`);
      }
    }
  }
  assert.deepEqual([w.tracker.moves, w.tracker.comments, w.api.posts()], [[], [], []]);
  assert.deepEqual(Object.keys(w.rows).filter((key) => key.startsWith("reaction/") || key.startsWith("approve-ticket/")), []);
});

const age = (w: World, key: string, ms: number) => {
  w.rows[key] = { ...(w.rows[key] as Record<string, unknown>), at: ago(ms) };
};

test("the same plan post can be approved again once its ticket is Planned again with no new post", async () => {
  const w = world(planned());
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  w.tracker.state.status = "Planned";
  age(w, reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "approve" }), 121_000);
  age(w, approveTicketKey("TLSSN-42"), 50_000);
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual(w.tracker.moves, ["31", "31"]);
});

test("a filing ✅ whose turn filed nothing can be added again once its claim expires", async () => {
  const w = world(filing());
  assert.equal((await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS))).length, 1);
  assert.equal((await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS))).length, 0, "a redelivery inside the claim starts no second turn");
  age(w, reactionClaimKey({ channelId: CHANNEL, ts: PROMPT_TS, act: "filing" }), 121_000);
  assert.equal((await deliver(w, reaction(FILER, "white_check_mark", PROMPT_TS))).length, 1);
});

test("❌ on a filing prompt whose thread already has its ticket says so, and never that nothing was filed", async () => {
  const w = world({ ...filing(), "ticket/TLSSN-44": { ...THREAD, originatorUserId: FILER, filedAt: new Date().toISOString() }, [threadTicketsKey(THREAD)]: ["TLSSN-44"] });
  await deliver(w, reaction(FILER, "x", PROMPT_TS));
  assert.deepEqual(w.api.posts(), ["This request is already filed as TLSSN-44, so ❌ changes nothing."]);
});

test("a slow decline's hold is not taken over by an approval, however old", async () => {
  const w = world({ ...planned(), [approveTicketKey("TLSSN-42")]: { state: "pending", owner: "decliner", act: "decline", by: "alice", at: ago(50_000) } });
  await deliver(w, reaction(FILER, "white_check_mark", PLAN_TS));
  assert.deepEqual([w.tracker.moves, w.api.posts()], [[], []]);
});

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
import { racingStores, recordKv } from "../lib/kv-race.fixtures.js";
import { oneReplyEvents } from "../lib/one-reply.js";
import { commandKey, speakerKey } from "../lib/originator.js";
import { reactionClaimKey } from "../lib/reaction-approval.js";
import { intakeSettledKey, intakeTriageKey, pendingIntake, readIntakeTriage } from "../lib/intake-triage.js";
import { asksToFile, filingPromptKey, planPostKey } from "../lib/reaction-targets.js";
import { threadTicketsKey } from "../lib/thread-tickets.js";
import slack from "./slack.js";

// July 0.2.13 delivers `reaction_added` on hosted v2. A ✅ or ❌ from the
// person the typed command would take, on the desk's filing prompt or plan
// post, decides it; every other reaction is ignored. Driven through July's
// own event parsing and dispatch, with Slack and Jira stubbed.

process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";

const TEAM = "T0123";
const CHANNEL = "C0EXAMPLE1";
const ROOT = "1758510000.123456";
const THREAD = { channelId: CHANNEL, threadTs: ROOT };
const PLAN_TS = "1758510005.000200";
const PROMPT_TS = "1758510001.000300";
const FILER = "U0ALICE01";
const BOB = "U0BOB0001";
const DESK = "U0FACTORY";
const SLACKBOT_APP = "U0OTHERBOT";

function slackApi(options: { bots?: string[]; outsiders?: string[] } = {}) {
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
        const bot = id === DESK || (options.bots ?? []).includes(id);
        return { ok: true, user: { id, name: id === FILER ? "alice" : id.toLowerCase(), team_id: (options.outsiders ?? []).includes(id) ? "T0OTHER" : TEAM, is_bot: bot, profile: { display_name: id === FILER ? "alice" : "" } } };
      }
      if (method === "chat.postMessage") return { ok: true, ts: `1758510100.00${++posted}` };
      return { ok: true, messages: [] };
    },
  };
  const posts = () => calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  return { calls, transport, posts };
}

function jira(input: { status: string; rows?: Record<string, unknown> }) {
  const moves: string[] = [];
  const comments: string[] = [];
  const labels: unknown[] = [];
  const heldAtLabel: boolean[] = [];
  let status = input.status;
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
      { name: "addCommentToJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey", "commentBody") },
      { name: "editJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, fields: { type: "object" }, update: { type: "object" } } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (tool === "getJiraIssue") return json({ key: "TLSSN-42", fields: { summary: "CSV export", status: { name: status } } });
      if (tool === "getTransitionsForJiraIssue") return json({ transitions: status === "Planned" ? [{ id: "31", name: "Approve", to: { name: "Approved" } }] : [] });
      if (tool === "transitionJiraIssue") {
        moves.push(String((args["transition"] as { id: string }).id));
        status = "Approved";
      }
      if (tool === "addCommentToJiraIssue") comments.push(String(args["commentBody"]));
      if (tool === "editJiraIssue") {
        labels.push((args["update"] as { labels?: unknown[] } | undefined)?.labels?.[0]);
        heldAtLabel.push(input.rows?.["approve-ticket/TLSSN-42"] !== undefined);
      }
      return json({ id: "10001" });
    },
  };
  return { mcp, moves, comments, labels, heldAtLabel, setStatus: (next: string) => void (status = next) };
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

function world(rows: Record<string, unknown>, options: { status?: string; api?: ReturnType<typeof slackApi> } = {}): World {
  return { rows, kv: recordKv(rows), api: options.api ?? slackApi(), tracker: jira({ status: options.status ?? "Planned", rows }) };
}

function host(w: World, kv: HostKvApi = w.kv) {
  const client = { apiCall: (method: string, args: Record<string, unknown>) => w.api.transport.call(method, args) };
  return { kv, slack: { getClient: async () => client }, mcp: w.tracker.mcp };
}

const options = getSlackChannelOptions(slack)!;
const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never;

function reactionBody(input: { user: string; reaction: string; ts: string; eventTs?: string; channel?: string }) {
  return {
    type: "event_callback",
    team_id: TEAM,
    event_id: `Ev${Math.random()}`,
    event: { type: "reaction_added", user: input.user, reaction: input.reaction, item: { type: "message", channel: input.channel ?? CHANNEL, ts: input.ts }, item_user: DESK, event_ts: input.eventTs ?? "1758510200.000100" },
  };
}

/** One Events API delivery of `body`, as hosted admission hands it over; resolves once the handler and any model send are done. */
async function deliver(w: World, body: unknown, kv: HostKvApi = w.kv) {
  resetExternalSenderCache();
  const sends: Array<Record<string, unknown>> = [];
  const pending: Promise<unknown>[] = [];
  const send = (async (prompt: string, sendOptions: Record<string, unknown>) => (sends.push({ ...sendOptions, prompt }), { sessionId: "ses_test" })) as never;
  const scheduled = dispatchInboundFromEventBody(body, {
    send,
    waitUntil: (promise) => void pending.push(promise),
    onAppMention: options.onAppMention ?? createDefaultOnInbound(),
    onDirectMessage: options.onDirectMessage ?? createDefaultOnInbound(),
    ...(options.onReactionAdded === undefined ? {} : { onReactionAdded: options.onReactionAdded }),
    credentials: { botToken: w.api.transport },
    eventIds: createEventIdDedupe(),
    host: host(w, kv) as never,
    artifacts: {} as never,
    log,
    mentionsEnabled: true,
    directMessagesEnabled: true,
  });
  await Promise.all(pending);
  return { scheduled, sends };
}

function binding(w: World, kv: HostKvApi = w.kv): SlackBinding {
  return {
    slack: { ...THREAD, teamId: TEAM },
    thread: { startTyping: async () => {}, post: async (text: string) => (w.api.calls.push({ method: "thread.post", args: { text } }), { ts: "1758510111.000100" }) },
    host: host(w, kv),
  } as unknown as SlackBinding;
}

const typed = (text: string, ts = "1758510210.000100"): SlackMessage => ({ text, body: text, markdown: text, ts, ...THREAD, teamId: TEAM, author: { userId: FILER, userName: "alice", isBot: false } });

const reactionsAdded = (w: World) => w.api.calls.filter((call) => call.method === "reactions.add");

test("the channel subscribes to reaction_added", () => {
  assert.equal(typeof options.onReactionAdded, "function");
});

test("✅ from the filer on the plan post approves it: one move to Approved, the implement crumb, no reply and no model turn", async () => {
  const w = world(planned());
  const { scheduled, sends } = await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
  assert.equal(scheduled, true);
  assert.deepEqual(sends, []);
  assert.deepEqual(w.tracker.moves, ["31"]);
  assert.deepEqual(w.api.posts().map((post) => post["text"]), ["TLSSN-42: starting implementation…"]);
  assert.equal(w.api.posts()[0]?.["thread_ts"], ROOT);
  assert.equal((w.rows["approved-in-slack/TLSSN-42"] as Record<string, unknown>)["by"], FILER);
  assert.equal((w.rows[reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "approve" })] as Record<string, unknown>)["state"], "pending", "left to expire, so the post can be approved again once Planned again");
  assert.equal((w.rows[approveTicketKey("TLSSN-42")] as Record<string, unknown>)["state"], "pending", "the hold stays up for later signals");
  assert.deepEqual(reactionsAdded(w), [], "the person's own ✅ is the ack");
});

test("❌ from the filer on the plan post records the denial and the plan-declined label, says so in one short line, and leaves the ticket Planned", async () => {
  const w = world(planned());
  const lines: string[] = [];
  const real = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  let sends: unknown[];
  try {
    ({ sends } = await deliver(w, reactionBody({ user: FILER, reaction: "x", ts: PLAN_TS })));
  } finally {
    console.log = real;
  }
  assert.deepEqual(sends, []);
  assert.deepEqual(w.tracker.moves, []);
  assert.deepEqual(w.tracker.comments, ["Denied in Slack by alice"]);
  assert.deepEqual(w.tracker.labels, [{ add: "plan-declined" }], "the decline shows on the board, not only in a comment");
  assert.deepEqual(w.tracker.heldAtLabel, [true], "the ❌ decline keeps the decision hold through the label write");
  assert.ok(
    w.api.calls.some((call) => call.method === "reactions.add" && call.args["name"] === "no_entry_sign" && call.args["timestamp"] === ROOT),
    "the thread root's stage moves from 📝 to 🚫"
  );
  assert.deepEqual(w.api.posts().map((post) => [post["thread_ts"], post["text"]]), [[ROOT, "TLSSN-42: plan declined, so nothing is built. To change it, add a comment on TLSSN-42 and say `replan TLSSN-42`."]]);
  assert.equal(w.rows["approved-in-slack/TLSSN-42"], undefined);
  const timing = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line["desk"] === "plan_decline");
  assert.deepEqual(Object.keys(timing?.["ms"] as object), ["jira_read", "comment", "post", "label"], "each phase of a ❌ is timed");
  assert.equal(typeof lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line["desk"] === "reaction" && line["outcome"] === "plan_declined")?.["ms"], "number");

  // Approving the declined plan later takes the label off again.
  await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
  assert.deepEqual(w.tracker.moves, ["31"]);
  assert.deepEqual(w.tracker.labels, [{ add: "plan-declined" }, { remove: "plan-declined" }]);
  assert.equal(w.rows["plan-declined/TLSSN-42"], undefined);
});

test("✅ from the requester on the filing prompt is approve file: one model turn on the filing thread, with the reactor recorded as its approver", async () => {
  const w = world(filing());
  const { sends } = await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PROMPT_TS, eventTs: "1758510200.000100" }));
  assert.equal(sends.length, 1);
  const turn = sends[0]!;
  assert.match(String(turn["prompt"]), /\napprove file$/);
  const auth = turn["auth"] as { attributes: Record<string, unknown> };
  assert.deepEqual([auth.attributes["channel_id"], auth.attributes["thread_ts"], auth.attributes["user_id"]], [CHANNEL, ROOT, FILER]);
  assert.match(String(turn["prompt"]), /That is `approve file`/);
  assert.deepEqual(w.rows[speakerKey(THREAD)], { userId: FILER, ts: "1758510200.000100", reaction: true });
  assert.deepEqual(w.rows[commandKey(THREAD, { verb: "approve", target: "file" })], { userId: FILER, ts: "1758510200.000100", reaction: true }, "file_ticket acks no message for a reaction");
  assert.deepEqual(w.api.posts(), [], "the Filed line is the model turn's reply");
  assert.deepEqual(w.tracker.moves, []);
});

test("the ✅ filing turn's reply posts to the thread root, not the reacted prompt: no July error, lastBotMessageTs set, prompts on the root", async () => {
  const w = world(filing());
  const { sends } = await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PROMPT_TS }));
  const state = sends[0]!["state"] as Record<string, unknown>;
  assert.equal(state["threadTs"], PROMPT_TS, "July keys the reaction turn's state on the reacted message");

  // Slack as it answered on c83562b: a post aimed at a reply is threaded
  // under the root, and a thread call aimed at the reply is invalid.
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "slack",
    call: async (method, args = {}) => {
      const body = args as Record<string, unknown>;
      calls.push({ method, args: body });
      if (body["thread_ts"] === PROMPT_TS && method !== "chat.postMessage") return { ok: false, error: "invalid_thread_ts" };
      if (method === "chat.postMessage") return { ok: true, ts: "1758510300.000100", channel: CHANNEL, message: { thread_ts: body["thread_ts"] === PROMPT_TS ? ROOT : body["thread_ts"] } };
      return { ok: true };
    },
  };
  const errors: string[] = [];
  const warnings: string[] = [];
  const sinkLog = { info: () => {}, debug: () => {}, error: (line: string) => void errors.push(line), warn: (line: string) => void warnings.push(line) };
  const events = oneReplyEvents({ credentials: { botToken: transport }, suggestedPrompts: [{ title: "File a bug", message: "File a bug: " }], getLog: () => sinkLog as never });
  const channel = { channelId: "slack", state: state as never, continuationToken: null, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_test", auth: sends[0]!["auth"] }, host: { kv: w.kv } } as never;
  const base = { sessionId: "ses_test", turnId: "turn_1" };
  const filed = "TLSSN-44 is filed: https://example.atlassian.net/browse/TLSSN-44";
  await events["turn.started"]?.({ ...base, type: "turn.started", data: {} } as never, channel, ctx);
  await events["message.completed"]?.({ ...base, type: "message.completed", data: { text: filed, finishReason: "stop" } } as never, channel, ctx);
  await events["turn.completed"]?.({ ...base, type: "turn.completed", data: { result: filed } } as never, channel, ctx);

  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.args["thread_ts"], ROOT);
  assert.deepEqual(errors, [], "no `postMessage failed: … ignored thread_ts`");
  assert.equal(state["lastBotMessageTs"], "1758510300.000100");
  assert.deepEqual(calls.filter((call) => call.args["thread_ts"] === PROMPT_TS), [], "nothing is aimed at the prompt");
  const suggested = calls.filter((call) => call.method === "assistant.threads.setSuggestedPrompts");
  assert.deepEqual(suggested.map((call) => call.args["thread_ts"]), [ROOT]);
  assert.deepEqual(warnings.filter((line) => /setSuggestedPrompts/.test(line)), []);
});

test("the one-reply sink leaves a turn's thread alone when its ts is not a filing prompt inside a thread", async () => {
  const api = slackApi();
  const events = oneReplyEvents({ credentials: { botToken: api.transport } });
  const DM = "D0DM00001";
  const OTHER = "C0OTHER001";
  const rows: Record<string, unknown> = {
    [filingPromptKey({ channelId: DM, ts: PROMPT_TS })]: { requester: FILER, at: new Date().toISOString() },
    [filingPromptKey({ channelId: OTHER, ts: PLAN_TS })]: { requester: FILER, threadTs: ROOT, at: new Date().toISOString() },
  };
  for (const [channelId, threadTs] of [[CHANNEL, ROOT], [DM, PROMPT_TS], [CHANNEL, PLAN_TS]] as const) {
    const state = { channelId, threadTs, teamId: TEAM, triggeringUserId: FILER } as never;
    const channel = { channelId: "slack", state, continuationToken: null, setContinuationToken: async () => {} };
    const ctx = { session: { id: "ses_2", auth: { attributes: { channel_id: channelId, thread_ts: threadTs } } }, host: { kv: recordKv(rows) } } as never;
    await events["turn.completed"]?.({ sessionId: "ses_2", turnId: "t1", type: "turn.completed", data: { result: "TLSSN-44 is filed." } } as never, channel, ctx);
  }
  assert.deepEqual(
    api.posts().map((post) => [post["channel"], post["thread_ts"]]),
    [[CHANNEL, ROOT], [DM, PROMPT_TS], [CHANNEL, PLAN_TS]],
    "a DM prompt with no thread root keeps its own thread, and another channel's prompt at the same ts moves nothing"
  );
});

test("❌ from the requester on the filing prompt declines it: one short reply, no model turn, nothing in Jira", async () => {
  const w = world(filing());
  const { sends } = await deliver(w, reactionBody({ user: FILER, reaction: "x", ts: PROMPT_TS }));
  assert.deepEqual(sends, []);
  assert.deepEqual(w.api.posts().map((post) => [post["thread_ts"], post["text"]]), [[ROOT, "Okay, I won't file this; nothing was created in Jira."]]);
  assert.deepEqual([w.tracker.moves, w.tracker.comments], [[], []]);
  // The prompt is decided: a later ✅ on it files nothing.
  const late = await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PROMPT_TS }));
  assert.deepEqual(late.sends, []);
  assert.equal(w.api.posts().length, 1);
});

test("✅ on the filing prompt of a thread that already has its ticket starts no second filing", async () => {
  const w = world({ ...filing(), "ticket/TLSSN-44": { ...THREAD, originatorUserId: FILER, filedAt: new Date().toISOString() }, [threadTicketsKey(THREAD)]: ["TLSSN-44"] });
  const { sends } = await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PROMPT_TS }));
  assert.deepEqual([sends, w.api.posts()], [[], []]);
  assert.equal((w.rows[reactionClaimKey({ channelId: CHANNEL, ts: PROMPT_TS, act: "filing" })] as Record<string, unknown>)["state"], "pending", "a no-op leaves the claim to expire, never done");
});

test("a ✅ on the plan and a typed approve: one move and one crumb, whichever lands first, and the second is silent", async () => {
  for (const order of ["reaction first", "typed first"] as const) {
    const w = world(planned());
    const onAppMention = options.onAppMention as SlackMessageHandler;
    if (order === "reaction first") {
      await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
      assert.equal(await onAppMention(binding(w), typed("approve TLSSN-42")), null, order);
    } else {
      assert.equal(await onAppMention(binding(w), typed("approve")), null, order);
      await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
    }
    assert.deepEqual(w.tracker.moves, ["31"], order);
    assert.deepEqual(w.api.posts().map((post) => post["text"]), ["TLSSN-42: starting implementation…"], order);
    assert.deepEqual(w.api.calls.filter((call) => call.method === "thread.post"), [], `${order}: no "already Approved" reply`);
  }
});

test("a ticket moved back to Planned after a ✅ approval can be approved again inside the hold; a twin while it is in flight cannot", async () => {
  const onAppMention = options.onAppMention as SlackMessageHandler;
  for (const [agoMs, moves] of [[60_000, ["31", "31"]], [10_000, ["31"]]] as const) {
    const w = world(planned());
    await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
    assert.deepEqual(w.tracker.moves, ["31"]);
    w.tracker.setStatus("Planned");
    const hold = w.rows[approveTicketKey("TLSSN-42")] as Record<string, unknown>;
    w.rows[approveTicketKey("TLSSN-42")] = { ...hold, at: new Date(Date.now() - agoMs).toISOString() };
    assert.equal(await onAppMention(binding(w), typed("approve TLSSN-42", "1758510300.000100")), null);
    assert.deepEqual(w.tracker.moves, moves, `hold taken ${agoMs} ms ago`);
  }
});

test("a ✅ and a typed approve racing on a kv that shows neither its rival's hold: the hold's settle re-read lets one through", async () => {
  const w = world(planned());
  const [first, second] = racingStores(w.kv, { prefix: "approve-ticket/", after: "readBack" });
  const onAppMention = options.onAppMention as SlackMessageHandler;
  await Promise.all([deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }), first), onAppMention(binding(w, second), typed("approve TLSSN-42"))]);
  assert.deepEqual(w.tracker.moves, ["31"]);
  assert.equal(w.api.posts().filter((post) => post["text"] === "TLSSN-42: starting implementation…").length, 1);
  assert.deepEqual(w.api.calls.filter((call) => call.method === "thread.post"), []);
});

test("one reaction delivered twice (a hosted redelivery, or two at once) acts once", async () => {
  const sequential = world(planned());
  await deliver(sequential, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
  await deliver(sequential, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
  assert.deepEqual(sequential.tracker.moves, ["31"]);
  assert.equal(sequential.api.posts().length, 1);

  const denied = world(planned());
  const [a, b] = racingStores(denied.kv, { prefix: "reaction/", after: "readBack" });
  const body = reactionBody({ user: FILER, reaction: "x", ts: PLAN_TS });
  await Promise.all([deliver(denied, body, a), deliver(denied, { ...body, event_id: "EvOther" }, b)]);
  assert.deepEqual(denied.tracker.comments, ["Denied in Slack by alice"]);
  assert.equal(denied.api.posts().length, 1);

  const filed = world(filing());
  const [c, d] = racingStores(filed.kv, { prefix: "reaction/", after: "readBack" });
  const fileIt = reactionBody({ user: FILER, reaction: "white_check_mark", ts: PROMPT_TS });
  const turns = await Promise.all([deliver(filed, fileIt, c), deliver(filed, { ...fileIt, event_id: "EvOther" }, d)]);
  assert.equal(turns.flatMap((turn) => turn.sends).length, 1, "one approve file turn");
});

test("a reaction from a bot, or from the desk itself, is ignored", async () => {
  for (const user of [SLACKBOT_APP, DESK]) {
    const w = world({ ...planned(), ...filing() }, { api: slackApi({ bots: [SLACKBOT_APP] }) });
    const plan = await deliver(w, reactionBody({ user, reaction: "white_check_mark", ts: PLAN_TS }));
    const prompt = await deliver(w, reactionBody({ user, reaction: "white_check_mark", ts: PROMPT_TS }));
    assert.deepEqual([plan.sends, prompt.sends, w.tracker.moves, w.api.posts()], [[], [], [], []], user);
    assert.equal(w.rows[reactionClaimKey({ channelId: CHANNEL, ts: PLAN_TS, act: "approve" })], undefined, user);
  }
});

// The desk now acks `deny` / `deny file` with ✅ as it acks `approve`. That
// reaction lands on the person's own command message; neither it nor a ✅ or
// ❌ anyone adds there is a decision, so the ack can never loop into one.
test("the desk's ✅ ack on a person's deny or approve message decides nothing, and neither does anyone's reaction there", async () => {
  const COMMAND = "1758510010.000100";
  const w = world({ ...planned(), ...filing() });
  for (const [user, reaction] of [[DESK, "white_check_mark"], [DESK, "x"], [FILER, "white_check_mark"], [FILER, "x"]] as const) {
    const { sends } = await deliver(w, reactionBody({ user, reaction, ts: COMMAND }));
    assert.deepEqual(sends, [], `${user} ${reaction}`);
  }
  assert.deepEqual([w.tracker.moves, w.tracker.comments, w.api.posts()], [[], [], []]);
});

test("a reaction from anyone but the filer or requester, or from a Slack Connect sender, is ignored without a reply", async () => {
  const cases = [
    { name: "someone else on the plan", rows: planned(), user: BOB, ts: PLAN_TS },
    { name: "someone else ❌ on the plan", rows: planned(), user: BOB, ts: PLAN_TS, reaction: "x" },
    { name: "someone else on the filing prompt", rows: filing(), user: BOB, ts: PROMPT_TS },
    { name: "a Jira-filed ticket's plan", rows: { ...planned(), "ticket/TLSSN-42": { ...THREAD, root: "jira" } }, user: FILER, ts: PLAN_TS },
    { name: "a plan post recorded under another thread", rows: { ...planned(), "ticket/TLSSN-42": { ...THREAD, threadTs: "1758519999.000100", originatorUserId: FILER } }, user: FILER, ts: PLAN_TS },
    { name: "Slack Connect", rows: planned(), user: FILER, ts: PLAN_TS, api: slackApi({ outsiders: [FILER] }) },
  ];
  for (const input of cases) {
    const w = world(input.rows, input.api === undefined ? {} : { api: input.api });
    const { sends } = await deliver(w, reactionBody({ user: input.user, reaction: input.reaction ?? "white_check_mark", ts: input.ts }));
    assert.deepEqual([sends, w.tracker.moves, w.tracker.comments, w.api.posts()], [[], [], [], []], input.name);
  }
});

test("only ✅ and ❌ on a recorded desk post count: stage reactions, other emoji, and other messages do nothing", async () => {
  const w = world({ ...planned(), ...filing() });
  for (const reaction of ["eyes", "hourglass_flowing_sand", "memo", "hammer_and_wrench", "mag", "question", "warning", "heavy_check_mark", "+1"]) {
    await deliver(w, reactionBody({ user: FILER, reaction, ts: PLAN_TS }));
  }
  // ✅ on the filer's own root message is the Done stage reaction's emoji, not a decision.
  await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: ROOT }));
  assert.deepEqual([w.tracker.moves, w.api.posts()], [[], []]);
  assert.deepEqual(w.api.calls.filter((call) => call.method === "auth.test"), [], "no identity lookup of its own for a reaction that cannot count");
});

test("a ✅ on a plan whose ticket already moved on is quiet; one that went back to Triaged gets one line", async () => {
  const approved = world(planned(), { status: "In Progress" });
  await deliver(approved, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
  assert.deepEqual([approved.tracker.moves, approved.api.posts()], [[], []]);

  const replanned = world(planned(), { status: "Triaged" });
  await deliver(replanned, reactionBody({ user: FILER, reaction: "white_check_mark", ts: PLAN_TS }));
  assert.deepEqual(replanned.api.posts().map((post) => post["text"]), ["TLSSN-42 is Triaged, not Planned, so I did not approve it. Only a Planned ticket can be approved."]);
});

test("the one-reply sink records a posted filing prompt for the person whose message started the turn", async () => {
  const rows: Record<string, unknown> = {};
  const api = slackApi();
  const events = oneReplyEvents({ credentials: { botToken: api.transport } });
  const state = { channelId: CHANNEL, threadTs: ROOT, teamId: TEAM, triggeringUserId: FILER } as never;
  const channel = { channelId: "slack", state, continuationToken: null, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_1", auth: { attributes: { channel_id: CHANNEL, thread_ts: ROOT } } }, host: { kv: recordKv(rows) } } as never;
  const prompt = "CSV export drops the header\nTriaged by Jev: Bug, low severity.\nSummary: The header row is gone.\nReact ✅ to file or ❌ to drop, or reply `approve file` / `deny file`.";
  await events["turn.completed"]?.({ sessionId: "ses_1", turnId: "t1", type: "turn.completed", data: { result: prompt } } as never, channel, ctx);
  const ts = String(api.posts()[0]?.["ts"] ?? "1758510100.001");
  const recorded = rows[filingPromptKey({ channelId: CHANNEL, ts })] as Record<string, unknown>;
  assert.deepEqual([recorded["requester"], recorded["threadTs"]], [FILER, ROOT]);

  await events["turn.completed"]?.({ sessionId: "ses_1", turnId: "t2", type: "turn.completed", data: { result: "TLSSN-44 is filed." } } as never, channel, ctx);
  assert.equal(Object.keys(rows).length, 1, "a reply that asks for nothing is not a filing prompt");
  assert.equal(asksToFile("Reply `@factory approve file` to file it"), true);
});

test("the one-reply sink records which request's triage the filing prompt shows, so ❌ on it settles that request and no other", async () => {
  const DM = "D0DM00001";
  const REQUEST = "1758510900.000100";
  const rows: Record<string, unknown> = { [intakeTriageKey({ channelId: DM, threadTs: REQUEST })]: { exp: Date.now() + 60_000, at: Date.now(), ts: REQUEST, text: "CSV export returns 500", triage: { by: "model", reason: "below_bar" } } };
  const api = slackApi();
  const events = oneReplyEvents({ credentials: { botToken: api.transport } });
  const state = { channelId: DM, threadTs: REQUEST, teamId: TEAM, triggeringUserId: FILER } as never;
  const channel = { channelId: "slack", state, continuationToken: null, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_3", auth: { attributes: { channel_id: DM, thread_ts: REQUEST } } }, host: { kv: recordKv(rows) } } as never;
  await events["turn.completed"]?.({ sessionId: "ses_3", turnId: "t1", type: "turn.completed", data: { result: "Reply `approve file` to file it." } } as never, channel, ctx);
  const ts = String(api.posts()[0]?.["ts"] ?? "1758510100.001");
  assert.equal((rows[filingPromptKey({ channelId: DM, ts })] as Record<string, unknown>)["request"], REQUEST);
});

test("in a DM the one-reply sink records the tickets already filed there, so none of them reads as this prompt's filing", async () => {
  const DM = "D0DM00001";
  const dm = { channelId: DM, threadTs: "1758510900.000100" };
  const rows: Record<string, unknown> = { "ticket/TLSSN-41": { ...dm, originatorUserId: FILER }, [threadTicketsKey(dm)]: ["TLSSN-41"] };
  const api = slackApi();
  const events = oneReplyEvents({ credentials: { botToken: api.transport } });
  const state = { channelId: DM, threadTs: dm.threadTs, teamId: TEAM, triggeringUserId: FILER } as never;
  const channel = { channelId: "slack", state, continuationToken: null, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_2", auth: { attributes: { channel_id: DM, thread_ts: dm.threadTs } } }, host: { kv: recordKv(rows) } } as never;
  await events["turn.completed"]?.({ sessionId: "ses_2", turnId: "t1", type: "turn.completed", data: { result: "Reply `approve file` to file it." } } as never, channel, ctx);
  const ts = String(api.posts()[0]?.["ts"] ?? "1758510100.001");
  assert.deepEqual((rows[filingPromptKey({ channelId: DM, ts })] as Record<string, unknown>)["before"], ["TLSSN-41"]);
});

test("in a DM, ❌ on an older filing prompt after a newer request overwrote the DM's triage settles only the older request; ✅ on the newer one files its own triage", async () => {
  const DM = "D0DM00001";
  const older = { ts: "1758510300.000100", prompt: "1758510301.000100" };
  const newer = { ts: "1758510400.000100", prompt: "1758510401.000100" };
  const at = Date.now();
  const stash = (ts: string, text: string, type: string) => ({ exp: at + 86_400_000, at, ts, text, triage: { by: "jev", type, severity: "medium", needsInfo: false, title: text, jev: {} } });
  const w = world({
    [filingPromptKey({ channelId: DM, ts: older.prompt })]: { requester: FILER, request: older.ts, at: new Date(at).toISOString() },
    [filingPromptKey({ channelId: DM, ts: newer.prompt })]: { requester: FILER, request: newer.ts, at: new Date(at).toISOString() },
    [intakeTriageKey({ channelId: DM, threadTs: older.ts })]: stash(older.ts, "CSV export returns 500", "Bug"),
    [intakeTriageKey({ channelId: DM, threadTs: newer.ts })]: stash(newer.ts, "add a running balance to the register", "Task"),
    [intakeTriageKey({ channelId: DM })]: stash(newer.ts, "add a running balance to the register", "Task"),
  });
  await deliver(w, reactionBody({ user: FILER, reaction: "x", ts: older.prompt, channel: DM }));
  assert.deepEqual(w.api.posts().map((post) => post["text"]), ["Okay, I won't file this; nothing was created in Jira."]);
  assert.notEqual(w.rows[intakeSettledKey({ channelId: DM, ts: older.ts })], undefined, "the declined request is settled");
  assert.equal(w.rows[intakeSettledKey({ channelId: DM, ts: newer.ts })], undefined, "the newer request is not");
  assert.equal((await pendingIntake(w.kv, [{ channelId: DM }], "1758510500.000100", new Date()))?.source.ts, newer.ts, "the newer request is still pending");

  const { sends } = await deliver(w, reactionBody({ user: FILER, reaction: "white_check_mark", ts: newer.prompt, channel: DM, eventTs: "1758510410.000100" }));
  assert.equal(sends.length, 1, "✅ on the newer prompt starts its approve file turn");
  const auth = (sends[0]!["auth"] as { attributes: Record<string, unknown> }).attributes;
  const thread = typeof auth["thread_ts"] === "string" && auth["thread_ts"] !== "" ? { channelId: DM, threadTs: auth["thread_ts"] } : { channelId: DM };
  assert.equal((await readIntakeTriage(w.kv, thread, new Date()))?.["type" as never], "Task", "file_ticket reads the newer request's own triage");
});

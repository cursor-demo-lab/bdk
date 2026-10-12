import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import {
  createChannelPostWatcher,
  createDefaultOnInbound,
  createEventIdDedupe,
  dispatchInboundFromEventBody,
  dispatchInboundMessage,
  getSlackChannelOptions,
  resetExternalSenderCache,
  SlackChannelAllowlist,
  type SlackApiTransport,
  type SlackBinding,
  type SlackMessage,
  type SlackMessageHandler,
} from "@cursor/july/channels/slack";
import { racingStores, recordKv } from "../lib/kv-race.fixtures.js";
import slack, { DESK_CHANNEL_POSTS } from "./slack.js";

// A thread the desk told that its ticket needs information takes any plain
// reply as the update: the reply goes onto the ticket as a Detail from
// Slack: comment and the ticket goes back to the planner, with no model turn
// and no `plan KEY`. Driven through the real slack.ts handlers, speaker
// recording and the Slack Connect check included.

const savedSettle = process.env.FACTORY_DESK_CLAIM_SETTLE_MS;
before(() => {
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
});
after(() => {
  if (savedSettle === undefined) delete process.env.FACTORY_DESK_CLAIM_SETTLE_MS;
  else process.env.FACTORY_DESK_CLAIM_SETTLE_MS = savedSettle;
});

const TEAM = "T0123";
const THREAD = { channelId: "C0EXAMPLE1", threadTs: "1758510000.123456" };
const AWAITING = `awaiting-info/${THREAD.channelId}:${THREAD.threadTs}`;
const WAITING = { issueKey: "TLSSN-42", kind: "needs_info", at: "2026-09-25T05:00:00.000Z" };

function slackApi(userTeam = TEAM) {
  const calls: string[] = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method) => {
      calls.push(method);
      if (method === "users.info") return { ok: true, user: { id: "U0BOB", team_id: userTeam } };
      if (method === "chat.postMessage") return { ok: true, ts: "1758510001.000100" };
      return { ok: true, messages: [] };
    },
  };
  return { calls, transport };
}

type JiraCall = { tool: string; args: Record<string, unknown> };

function jira(input: { status: string; commentFails?: boolean; offersToDo?: boolean }) {
  const calls: JiraCall[] = [];
  let status = input.status;
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const tools = [
    { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
    { name: "addCommentToJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey", "comment") },
    { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
    { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
  ];
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => tools,
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      calls.push({ tool, args });
      if (tool === "getJiraIssue") return json({ key: "TLSSN-42", fields: { summary: "CSV export", status: { name: status } } });
      if (tool === "addCommentToJiraIssue") return input.commentFails === true ? { content: [{ type: "text", text: "no permission" }], isError: true } : json({ id: "10950" });
      if (tool === "getTransitionsForJiraIssue") {
        const all = [
          { id: "11", name: "Start triage", to: { name: "Triaged" } },
          ...(input.offersToDo === false ? [] : [{ id: "41", name: "Back to To Do", to: { name: "To Do" } }]),
        ];
        return json({ transitions: all });
      }
      if (tool === "transitionJiraIssue") status = (args["transition"] as { id: string }).id === "41" ? "To Do" : "Triaged";
      return json({});
    },
  };
  return { mcp, calls, status: () => status };
}

function binding(kv: Record<string, unknown>, mcp: unknown, posts: string[], api = slackApi()): SlackBinding {
  resetExternalSenderCache();
  const client = { apiCall: (method: string, args: Record<string, unknown>) => api.transport.call(method, args) };
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

function reply(text: string, ts = "1758510010.000100"): SlackMessage {
  return { text, body: text, markdown: text, ts, ...THREAD, teamId: TEAM, author: { userId: "U0BOB", userName: "bob", isBot: false } };
}

const onChannelPost = getSlackChannelOptions(slack)?.onChannelPost as SlackMessageHandler;
const BOUND = { "ticket/TLSSN-42": { ...THREAD, originatorUserId: "U0ALICE01" } };

async function handle(kv: Record<string, unknown>, tracker: ReturnType<typeof jira>, message: SlackMessage, api?: ReturnType<typeof slackApi>) {
  const posts: string[] = [];
  let decision: unknown = "threw";
  try {
    decision = await onChannelPost(binding(kv, tracker.mcp, posts, api), message);
  } catch {
    // The model path needs a live Slack thread; what matters is that the reply went there.
  }
  return { posts, decision };
}

const writes = (calls: JiraCall[]) => calls.filter((call) => call.tool !== "getJiraIssue" && call.tool !== "getTransitionsForJiraIssue");

test("a plain reply in a thread awaiting information goes onto the ticket and back to the planner, with no model turn", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const tracker = jira({ status: "Triaged" });
  const { posts, decision } = await handle(kv, tracker, reply("It fails on <https://marsbank.dev/reports/export?format=csv|the export page> when the filename has a space &amp; a comma."));
  assert.equal(decision, null);
  assert.deepEqual(writes(tracker.calls), [
    {
      tool: "addCommentToJiraIssue",
      args: {
        cloudId: "https://example.atlassian.net",
        issueIdOrKey: "TLSSN-42",
        comment: [
          "Detail from Slack: TLSSN-42",
          "bob replied in the ticket's Slack thread after the planner said it needs more information:",
          "",
          "It fails on the export page (https://marsbank.dev/reports/export?format=csv) when the filename has a space & a comma.",
        ].join("\n"),
      },
    },
    { tool: "transitionJiraIssue", args: { cloudId: "https://example.atlassian.net", issueIdOrKey: "TLSSN-42", transition: { id: "41" } } },
    { tool: "transitionJiraIssue", args: { cloudId: "https://example.atlassian.net", issueIdOrKey: "TLSSN-42", transition: { id: "11" } } },
  ]);
  assert.equal(tracker.status(), "Triaged");
  assert.deepEqual(posts, ["Added your reply to TLSSN-42 and sent it back to the planner. <https://example.atlassian.net/browse/TLSSN-42|TLSSN-42 on Jira>"]);
  assert.equal(kv[AWAITING], undefined);
  assert.equal((kv["thread-detail/C0EXAMPLE1:1758510010.000100"] as Record<string, unknown>)["state"], "done");
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "replanning");
});

test("the same Slack message delivered twice adds one comment", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const tracker = jira({ status: "Triaged" });
  await handle(kv, tracker, reply("It is src/routes/export.ts"));
  kv[AWAITING] = WAITING;
  const again = await handle(kv, tracker, reply("It is src/routes/export.ts"));
  assert.equal(again.decision, null);
  assert.deepEqual(again.posts, []);
  assert.equal(tracker.calls.filter((call) => call.tool === "addCommentToJiraIssue").length, 1);
});

// A labeled mention (`<@U…|factory>`) reaches onAppMention and onChannelPost
// alike. The first delivery clears the awaiting record and bounces the
// ticket through To Do, so a later twin read "not awaiting" (or "moved on")
// and went to the model after the host had answered.
test("a later twin of a handled reply, after the thread stopped awaiting, starts no model turn and posts nothing", async () => {
  const onAppMention = getSlackChannelOptions(slack)?.onAppMention as SlackMessageHandler;
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const tracker = jira({ status: "Triaged" });
  const text = "<@U0FACTORY|factory> It is src/routes/export.ts";
  const first = await handle(kv, tracker, reply(text));
  assert.equal(first.decision, null);
  assert.equal(kv[AWAITING], undefined);

  const posts: string[] = [];
  const twin = await onAppMention(binding(kv, tracker.mcp, posts), reply(text));
  assert.equal(twin, null, "no model turn");
  assert.deepEqual(posts, []);
  assert.equal(tracker.calls.filter((call) => call.tool === "addCommentToJiraIssue").length, 1);
});

test("a twin that lands while the first delivery holds the claim mid-bounce leaves the thread awaiting and starts no model turn", async () => {
  const kv: Record<string, unknown> = {
    ...BOUND,
    [AWAITING]: WAITING,
    "thread-detail/C0EXAMPLE1:1758510010.000100": { issueKey: "TLSSN-42", state: "pending", owner: "the-first-delivery", at: new Date().toISOString() },
  };
  const tracker = jira({ status: "To Do" });
  const { posts, decision } = await handle(kv, tracker, reply("<@U0FACTORY|factory> It is src/routes/export.ts"));
  assert.equal(decision, null);
  assert.deepEqual(posts, []);
  assert.deepEqual(tracker.calls, [], "no Jira read either");
  assert.deepEqual(kv[AWAITING], WAITING, "the first delivery decides whether the thread stops awaiting");
});

// Two deliveries of one reply that both read the thread-detail claim absent
// each wrote the Detail comment and bounced the ticket: two planner wakes.
test("two concurrent deliveries of one reply that both read the claim absent add one comment and wake the planner once", async () => {
  const race = async (settle: string) => {
    process.env.FACTORY_DESK_CLAIM_SETTLE_MS = settle;
    try {
      const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
      const tracker = jira({ status: "Triaged" });
      const posts: string[] = [];
      // The first read is the pre-check for a delivery that already took the message; the race is at the claim.
      const stores = racingStores(recordKv(kv), { prefix: "thread-detail/", after: "readBack", passReads: 1 });
      const deliver = (store: (typeof stores)[number]) => {
        const bound = binding(kv, tracker.mcp, posts) as unknown as { host: Record<string, unknown> };
        return onChannelPost({ ...bound, host: { ...bound.host, kv: store } } as unknown as SlackBinding, reply("It is src/routes/export.ts"));
      };
      await Promise.all(stores.map(deliver));
      const tools = tracker.calls.map((call) => call.tool);
      return { comments: tools.filter((tool) => tool === "addCommentToJiraIssue").length, moves: tools.filter((tool) => tool === "transitionJiraIssue").length };
    } finally {
      process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
    }
  };
  assert.deepEqual(await race("0"), { comments: 2, moves: 4 }, "without the settle wait both deliveries write: the race this guards");
  assert.deepEqual(await race("20"), { comments: 1, moves: 2 });
});

const onAppMention = getSlackChannelOptions(slack)?.onAppMention as SlackMessageHandler;

test("as a mention, a desk command, a bare thanks, or a reply in a thread that is not waiting goes to the model and touches no ticket", async () => {
  for (const [text, awaiting] of [
    ["approve TLSSN-42 please", true],
    ["deny TLSSN-42", true],
    ["approve file", true],
    ["<@U0FACTORY> file a bug: the login button is grey", true],
    ["status of TLSSN-42?", true],
    ["thanks! :pray:", true],
    ["ok 👍", true],
    ["thanks! :pray: *Sent using* <@U0EXAMPLE1>", true],
    ["thanks\n*Sent using* <@U0EXAMPLE1|Cursor>", true],
    ["status of TLSSN-42? *Sent using* <@U0EXAMPLE1>", true],
    ["It is src/routes/export.ts", false],
  ] as const) {
    const kv: Record<string, unknown> = { ...BOUND, ...(awaiting ? { [AWAITING]: WAITING } : {}) };
    const tracker = jira({ status: "Triaged" });
    const posts: string[] = [];
    let decision: unknown = "threw";
    try {
      decision = await onAppMention(binding(kv, tracker.mcp, posts), reply(text));
    } catch {
      // The model path needs a live Slack thread.
    }
    assert.notEqual(decision, null, text);
    assert.deepEqual([posts, tracker.calls], [[], []], text);
    if (awaiting) assert.deepEqual(kv[AWAITING], WAITING, text);
  }
});

test("as a plain reply, a bare thanks in a waiting thread, or any reply in a thread that is neither waiting nor a ticket's, gets nothing", async () => {
  for (const [text, kv] of [
    ["thanks! :pray:", { ...BOUND, [AWAITING]: WAITING }],
    ["ok 👍", { ...BOUND, [AWAITING]: WAITING }],
    ["thanks\n*Sent using* <@U0EXAMPLE1|Cursor>", { ...BOUND, [AWAITING]: WAITING }],
    ["It is src/routes/export.ts", { ...BOUND }],
  ] as const) {
    const store: Record<string, unknown> = { ...kv };
    const tracker = jira({ status: "Triaged" });
    const { posts, decision } = await handle(store, tracker, reply(text));
    assert.equal(decision, null, text);
    assert.deepEqual([posts, tracker.calls], [[], []], text);
  }
  const tracker = jira({ status: "Triaged" });
  const { decision } = await handle({ ...BOUND, [AWAITING]: WAITING }, tracker, reply("status of TLSSN-42?"));
  assert.notEqual(decision, null, "a status question to the factory still gets a turn");
});

test("a short answer to triage's question is an answer, not an acknowledgement", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: { ...WAITING, kind: "triage_needs_info" } };
  const tracker = jira({ status: "Triaged" });
  const { decision } = await handle(kv, tracker, reply("yes"));
  assert.equal(decision, null);
  const comment = tracker.calls.find((call) => call.tool === "addCommentToJiraIssue");
  assert.match(String(comment?.args["comment"]), /^Detail from Slack: TLSSN-42\nbob replied in the ticket's Slack thread after triage asked for more information:\n\nyes$/);
});

test("a ticket that has left Triaged stops awaiting and the reply goes to the model", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const tracker = jira({ status: "Planned" });
  const { decision, posts } = await handle(kv, tracker, reply("It is src/routes/export.ts"));
  assert.notEqual(decision, null);
  assert.deepEqual(posts, []);
  assert.deepEqual(writes(tracker.calls), []);
  assert.equal(kv[AWAITING], undefined);
});

test("a comment Jira refuses changes nothing, says so, and the same reply can be sent again", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const refused = jira({ status: "Triaged", commentFails: true });
  const first = await handle(kv, refused, reply("It is src/routes/export.ts"));
  assert.deepEqual(first.posts, ["I could not add your reply to TLSSN-42 in Jira (no permission), so nothing changed. Say it again in a minute."]);
  assert.equal(refused.calls.some((call) => call.tool === "transitionJiraIssue"), false);
  assert.deepEqual(kv[AWAITING], WAITING);

  const working = jira({ status: "Triaged" });
  await handle(kv, working, reply("It is src/routes/export.ts"));
  assert.equal(working.calls.filter((call) => call.tool === "addCommentToJiraIssue").length, 1);
});

test("a reply that landed but could not reach the planner says how to send it, and keeps the thread awaiting", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const tracker = jira({ status: "Triaged", offersToDo: false });
  const { posts } = await handle(kv, tracker, reply("It is src/routes/export.ts"));
  assert.deepEqual(posts, [
    "Added your reply to TLSSN-42, but could not send it back to the planner (no_transition). Say `plan TLSSN-42` here to try again, or move it to To Do and back to Triaged in Jira. <https://example.atlassian.net/browse/TLSSN-42|TLSSN-42 on Jira>",
  ]);
  assert.deepEqual(kv[AWAITING], WAITING);
});

test("a bot post in the thread, the desk's own included, touches no ticket", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const tracker = jira({ status: "Triaged" });
  const bot: SlackMessage = { ...reply("TLSSN-42 needs more information, so it has no plan…"), author: { userId: "", isBot: true, botId: "B0FACTORY" } };
  const { posts } = await handle(kv, tracker, bot);
  assert.deepEqual([posts, tracker.calls], [[], []]);
  assert.deepEqual(kv[AWAITING], WAITING);
});

test("a Slack Connect sender's reply touches no ticket", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const tracker = jira({ status: "Triaged" });
  const { posts } = await handle(kv, tracker, reply("It is src/routes/export.ts"), slackApi("T0OTHER"));
  assert.deepEqual([posts, tracker.calls], [[], []]);
});

test("a bare reply in the intake thread takes the same path through July's channel-post dispatch", async () => {
  resetExternalSenderCache();
  const api = slackApi();
  const options = getSlackChannelOptions(slack)!;
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: WAITING };
  const tracker = jira({ status: "Triaged" });
  const host = binding(kv, tracker.mcp, [], api).host;
  const sends: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never;
  const send = (async (...args: unknown[]) => (sends.push(args), { sessionId: "ses_test" })) as never;
  const watcher = createChannelPostWatcher({
    options: { ...DESK_CHANNEL_POSTS, debounceMs: 0 },
    allowlist: new SlackChannelAllowlist(DESK_CHANNEL_POSTS.allow),
    getBotUserId: () => "U0FACTORY",
    dispatch: (message) => {
      pending.push(
        dispatchInboundMessage({
          kind: "channel_post",
          message,
          handler: options.onChannelPost ?? createDefaultOnInbound(),
          send,
          credentials: { botToken: api.transport },
          host: host as never,
          artifacts: {} as never,
          log,
          evalCommandsEnabled: true,
        })
      );
    },
    log,
  });
  const dispatched = dispatchInboundFromEventBody(
    {
      type: "event_callback",
      team_id: TEAM,
      event_id: `Ev${Math.random()}`,
      event: { type: "message", channel: THREAD.channelId, channel_type: "channel", user: "U0BOB", text: "Repro: export Q3 report.csv, last column is cut", ts: "1758510020.000100", thread_ts: THREAD.threadTs, team: TEAM },
    },
    {
      send,
      waitUntil: (promise) => void pending.push(promise),
      onAppMention: options.onAppMention ?? createDefaultOnInbound(),
      onDirectMessage: options.onDirectMessage ?? createDefaultOnInbound(),
      credentials: { botToken: api.transport },
      eventIds: createEventIdDedupe(),
      host: host as never,
      artifacts: {} as never,
      log,
      mentionsEnabled: true,
      directMessagesEnabled: true,
      channelWatch: watcher,
    }
  );
  assert.equal(dispatched, true);
  await Promise.all(pending);
  assert.deepEqual(sends, []);
  assert.equal(api.calls.filter((call) => call === "chat.postMessage").length, 2);
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "replanning");
  assert.equal(tracker.calls.filter((call) => call.tool === "addCommentToJiraIssue").length, 1);
  assert.equal(tracker.calls.filter((call) => call.tool === "transitionJiraIssue").length, 2);
});

import assert from "node:assert/strict";
import { stashIntakeTriage } from "../lib/intake-triage.js";
import { test } from "node:test";
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
import { approveTarget, approveTargetFromMessage, isPlainApprove } from "../lib/approve-command.js";
import { filingThreadKey, threadTicketsKey } from "../lib/thread-tickets.js";
import slack, { DESK_CHANNEL_POSTS } from "./slack.js";

// An exact `approve KEY` from the filer, in the ticket's thread, while the
// ticket is Planned, is approved in host code: a check-mark reaction and no
// reply, so the In Progress line with the agent link is the thread's one
// beat. Anything else goes to the model, which calls approve_ticket.

const TEAM = "T0123";
const THREAD = { channelId: "C0EXAMPLE1", threadTs: "1758510000.123456" };
const FILER = "U0ALICE01";
const BOUND = { "ticket/TLSSN-42": { ...THREAD, originatorUserId: FILER } };

function slackApi(userTeam = TEAM) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      calls.push({ method, args: args as Record<string, unknown> });
      if (method === "users.info") return { ok: true, user: { id: FILER, team_id: userTeam } };
      if (method === "chat.postMessage") return { ok: true, ts: "1758510001.000100" };
      return { ok: true, messages: [] };
    },
  };
  return { calls, transport };
}

function jira(input: { status: string; moveFails?: boolean; approvedMeanwhile?: boolean; replannedMeanwhile?: boolean }) {
  const moves: string[] = [];
  let status = input.status;
  let reads = 0;
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (tool === "getJiraIssue") {
        reads += 1;
        // Another approval lands right after this path reads Planned.
        if (input.approvedMeanwhile === true && reads > 1) status = "Approved";
        // Or a replan moves it back to Triaged in that window.
        if (input.replannedMeanwhile === true && reads > 1) status = "Triaged";
        return json({ key: "TLSSN-42", fields: { summary: "CSV export", status: { name: status } } });
      }
      if (tool === "getTransitionsForJiraIssue") {
        return json({ transitions: input.approvedMeanwhile === true ? [] : [{ id: "31", name: "Approve", to: { name: "Approved" } }] });
      }
      if (tool === "transitionJiraIssue") {
        if (input.moveFails === true) return { content: [{ type: "text", text: "Transition 31 is not valid" }], isError: true };
        moves.push(String((args["transition"] as { id: string }).id));
        status = "Approved";
      }
      return json({});
    },
  };
  return { mcp, moves };
}

function binding(kv: Record<string, unknown>, mcp: unknown, posts: string[], api = slackApi(), thread = THREAD): SlackBinding {
  resetExternalSenderCache();
  const client = { apiCall: (method: string, args: Record<string, unknown>) => api.transport.call(method, args) };
  return {
    slack: { ...thread, teamId: TEAM },
    thread: { startTyping: async () => {}, post: async (text: string) => (posts.push(text), { ts: "1758510011.000100" }) },
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      slack: { getClient: async () => client },
      mcp,
    },
  } as unknown as SlackBinding;
}

function said(text: string, user = FILER, thread = THREAD): SlackMessage {
  return { text, body: text, markdown: text, ts: "1758510010.000100", ...thread, teamId: TEAM, author: { userId: user, userName: "alice", isBot: false } };
}

// The desk's handler, as a mention reaches it. The channel watch runs a plain
// reply through the factory-thread gate first (slack.live-commands.test.ts).
const onChannelPost = getSlackChannelOptions(slack)?.onAppMention as SlackMessageHandler;

/** Collects the desk's JSON log lines on one console stream until restore(). */
function captureConsole(stream: "log" | "error") {
  const lines: string[] = [];
  const real = console[stream];
  console[stream] = (line: unknown) => {
    if (typeof line === "string" && line.startsWith('{"desk":')) lines.push(line);
  };
  return { lines, restore: () => void (console[stream] = real) };
}

async function handle(input: { kv?: Record<string, unknown>; status?: string; moveFails?: boolean; approvedMeanwhile?: boolean; replannedMeanwhile?: boolean; message: SlackMessage; api?: ReturnType<typeof slackApi>; thread?: typeof THREAD }) {
  const kv = input.kv ?? { ...BOUND };
  const tracker = jira({
    status: input.status ?? "Planned",
    ...(input.moveFails === undefined ? {} : { moveFails: input.moveFails }),
    ...(input.approvedMeanwhile === undefined ? {} : { approvedMeanwhile: input.approvedMeanwhile }),
    ...(input.replannedMeanwhile === undefined ? {} : { replannedMeanwhile: input.replannedMeanwhile }),
  });
  const api = input.api ?? slackApi();
  const posts: string[] = [];
  let decision: unknown = "threw";
  try {
    decision = await onChannelPost(binding(kv, tracker.mcp, posts, api, input.thread), input.message);
  } catch {
    // The model path needs a live Slack thread; what matters is that the message went there.
  }
  const reactions = api.calls.filter((call) => call.method === "reactions.add").map((call) => call.args);
  return { kv, moves: tracker.moves, posts, decision, reactions };
}

test("only a message that is just approve KEY, with an optional mention, is the exact command", () => {
  assert.equal(approveTarget("approve TLSSN-42"), "TLSSN-42");
  assert.equal(approveTarget("<@U0FACTORY> approve tlssn-42."), "TLSSN-42");
  assert.equal(approveTarget("  Approve TLSSN-42!  "), "TLSSN-42");
  // TLSSN-25 live: Cursor Slack-send stores the typed line plus this footer in `text`.
  assert.equal(approveTarget("approve TLSSN-25\n*Sent using* <@U0EXAMPLE1|Cursor>"), "TLSSN-25");
  assert.equal(approveTarget("approve <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-25|TLSSN-25>"), "TLSSN-25");
  assert.equal(approveTarget("approve <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-25>"), "TLSSN-25");
  for (const text of ["approve TLSSN-42 and deny TLSSN-7", "looks good, approve TLSSN-42", "approve file", "don't approve TLSSN-42", "approve TLSSN-42?", "approve TLSSN-42 and thanks\n*Sent using* <@U0EXAMPLE1|Cursor>"]) {
    assert.equal(approveTarget(text), undefined, text);
  }
});

test("an empty top-level text still reads the command from July's body or markdown", () => {
  const live = "approve TLSSN-25\n*Sent using* <@U0EXAMPLE1|Cursor>";
  assert.equal(approveTargetFromMessage({ text: "", body: live, markdown: "approve TLSSN-25\n*Sent using* @U0EXAMPLE1", ts: "1.0", threadTs: "1.0", channelId: "C0EXAMPLE1" }), "TLSSN-25");
});

test("the filer's exact approve KEY in the ticket's thread moves it to Approved, reacts, and posts nothing", async () => {
  const { kv, moves, posts, decision, reactions } = await handle({ message: said("<@U0FACTORY> approve TLSSN-42") });
  assert.equal(decision, null);
  assert.deepEqual(moves, ["31"]);
  assert.deepEqual(posts, []);
  assert.deepEqual(reactions, [{ channel: THREAD.channelId, timestamp: "1758510010.000100", name: "white_check_mark" }]);
  assert.equal((kv["approved-in-slack/TLSSN-42"] as Record<string, unknown>)["by"], FILER);
  assert.equal((kv["approve-command/C0EXAMPLE1:1758510010.000100"] as Record<string, unknown>)["state"], "done");
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "implementing");
});

test("the TLSSN-25 live Cursor send (typed approve KEY plus Sent using footer) is the host path: react, no reply", async () => {
  const { kv, moves, posts, decision, reactions } = await handle({
    message: said("approve TLSSN-42\n*Sent using* <@U0EXAMPLE1|Cursor>"),
  });
  assert.equal(decision, null);
  assert.deepEqual(moves, ["31"]);
  assert.deepEqual(posts, []);
  assert.equal(reactions.length, 1);
  assert.equal((kv["approved-in-slack/TLSSN-42"] as Record<string, unknown>)["by"], FILER);
});

test("hosted July can omit message.teamId and ctx.slack.threadTs; the binding and the message still agree", async () => {
  const api = slackApi();
  const kv: Record<string, unknown> = { ...BOUND };
  const tracker = jira({ status: "Planned" });
  const posts: string[] = [];
  const ctx = binding(kv, tracker.mcp, posts, api);
  ctx.slack = { channelId: THREAD.channelId, teamId: TEAM } as SlackBinding["slack"];
  const message = { ...said("approve TLSSN-42"), teamId: undefined };
  const decision = await onChannelPost(ctx, message);
  assert.equal(decision, null);
  assert.deepEqual(tracker.moves, ["31"]);
  assert.deepEqual(posts, []);
});

test("a reaction Slack refuses does not block the host approve: the move, the record, the claim, and no reply", async () => {
  const api = slackApi();
  const call = api.transport.call;
  api.transport.call = async (method, args) => {
    if (method === "reactions.add") {
      await call(method, args);
      throw Object.assign(new Error("An API error occurred: not_in_channel"), { data: { ok: false, error: "not_in_channel" } });
    }
    return call(method, args);
  };
  const errors = captureConsole("error");
  const { kv, moves, posts, decision, reactions } = await handle({ message: said("approve TLSSN-42"), api }).finally(errors.restore);
  assert.equal(decision, null);
  assert.deepEqual([moves, posts], [["31"], []]);
  assert.equal(reactions.length, 1, "not_in_channel is not retried");
  assert.equal((kv["approved-in-slack/TLSSN-42"] as Record<string, unknown>)["by"], FILER);
  assert.equal((kv["approve-command/C0EXAMPLE1:1758510010.000100"] as Record<string, unknown>)["state"], "done");
  assert.deepEqual(errors.lines.map((line) => JSON.parse(line)), [
    { desk: "command_ack", command: "approve KEY", outcome: "failed", issueKey: "TLSSN-42", channel: THREAD.channelId, ts: "1758510010.000100", error: "not_in_channel" },
  ]);
});

test("an exact approve KEY the host path declines logs which gate declined it", async () => {
  const logs = captureConsole("log");
  try {
    await handle({ message: said("approve TLSSN-42", "U0BOB") });
    await handle({ message: said("approve TLSSN-42"), api: slackApi("T0OTHER") });
    await handle({ message: said("approve TLSSN-42"), kv: {} });
    await handle({ message: said("approve TLSSN-42"), status: "Triaged" });
  } finally {
    logs.restore();
  }
  const decisions = logs.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["desk"] === "approve_command");
  assert.deepEqual(
    decisions.map((line) => [line["outcome"], line["why"] ?? line["status"]]),
    [
      ["not_eligible", "not_filer"],
      ["not_eligible", "external"],
      ["not_eligible", "unbound"],
      ["not_planned", "Triaged"],
    ]
  );
});

test("a bare deny file reply in the thread gets ✅ on that message and still goes to the model", async () => {
  const text = "deny file\n*Sent using* <@U0EXAMPLE1|Cursor>";
  const { decision, reactions, moves } = await handle({ message: said(text) });
  assert.notEqual(decision, null);
  assert.deepEqual(moves, []);
  assert.deepEqual(reactions, [{ channel: THREAD.channelId, timestamp: "1758510010.000100", name: "white_check_mark" }]);

  const mentioned = await handle({ message: said("<@U0FACTORY> deny file.") });
  assert.equal(mentioned.reactions.length, 1);
});

test("deny file gets no ✅ when it is more words, top-level, or from a Slack Connect sender", async () => {
  const topLevel = { ...THREAD, threadTs: "1758510010.000100" };
  for (const input of [
    { name: "more words", message: said("deny file, I'll raise it in Jira") },
    { name: "top-level", message: said("deny file", FILER, topLevel), thread: topLevel },
    { name: "Slack Connect", message: said("deny file"), api: slackApi("T0OTHER") },
  ]) {
    const { reactions } = await handle(input);
    assert.deepEqual(reactions, [], input.name);
  }
});

// TLSSN-46 e2e: `approve file` got ✅ and `deny file` got nothing. In a DM
// every message is top-level, so the reply-in-a-thread rule never held there.
test("deny file in a DM gets ✅ when it drops the request a filing prompt waits on, and none when nothing was pending", async () => {
  const dm = { channelId: "D0DM00001", threadTs: "1758510010.000100" };
  const kv: Record<string, unknown> = {};
  const now = new Date();
  await stashIntakeTriage(recordKv(kv), [{ channelId: dm.channelId }], { by: "model", reason: "unavailable" }, now, { ts: "1758510005.000100", text: "the CSV export returns 500" });
  const message = said("deny file", FILER, dm);
  const dropped = await handle({ kv, message, thread: dm });
  assert.deepEqual(dropped.reactions, [{ channel: dm.channelId, timestamp: "1758510010.000100", name: "white_check_mark" }]);
  const nothing = await handle({ kv: {}, message, thread: dm });
  assert.deepEqual(nothing.reactions, [], "no pending request: nothing was dropped, so no ✅");
});

test("the same approve message delivered twice moves the ticket once", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  await handle({ kv, message: said("approve TLSSN-42") });
  const again = await handle({ kv, status: "Approved", message: said("approve TLSSN-42") });
  assert.equal(again.decision, null);
  assert.deepEqual([again.moves, again.posts, again.reactions], [[], [], []]);
});

test("a longer message goes to the model; someone else, another thread, or a Jira-filed ticket gets one host refusal; a Slack Connect sender gets nothing; none moves", async () => {
  const cases = [
    { name: "not the filer", message: said("approve TLSSN-42", "U0BOB"), reply: /^Only the person who filed TLSSN-42/ },
    { name: "another thread", message: said("approve TLSSN-42", FILER, { ...THREAD, threadTs: "1758519999.000100" }), thread: { ...THREAD, threadTs: "1758519999.000100" }, reply: /works only in TLSSN-42's own thread/ },
    { name: "longer message", message: said("looks good, approve TLSSN-42"), model: true },
    { name: "Slack Connect", message: said("approve TLSSN-42"), api: slackApi("T0OTHER") },
    { name: "Jira-filed ticket", message: said("approve TLSSN-42"), kv: { "ticket/TLSSN-42": { ...THREAD, root: "jira" } }, reply: /was not filed from Slack/ },
  ];
  for (const input of cases) {
    const { kv, moves, posts, decision, reactions } = await handle(input);
    if (input.model === true) assert.notEqual(decision, null, input.name);
    else assert.equal(decision, null, input.name);
    assert.deepEqual([moves, reactions], [[], []], input.name);
    if (input.reply === undefined) assert.deepEqual(posts, [], input.name);
    else {
      assert.equal(posts.length, 1, input.name);
      assert.match(posts[0]!, input.reply, input.name);
    }
    assert.equal(kv["approved-in-slack/TLSSN-42"], undefined, input.name);
  }
});

test("a ticket that is not Planned, or a move Jira refuses, gets one host reply and no model turn", async () => {
  for (const [status, reply] of [["Approved", /already Approved/], ["In Progress", /is In Progress, not Planned/], ["Triaged", /is Triaged, not Planned/]] as const) {
    const { kv, moves, decision, posts } = await handle({ status, message: said("approve TLSSN-42") });
    assert.equal(decision, null, status);
    assert.deepEqual(moves, [], status);
    assert.equal(posts.length, 1, status);
    assert.match(posts[0]!, reply, status);
    assert.equal(kv["approved-in-slack/TLSSN-42"], undefined, status);
  }
  const refused = await handle({ moveFails: true, message: said("approve TLSSN-42") });
  assert.equal(refused.decision, null);
  assert.equal(refused.posts.length, 1);
  assert.equal(refused.kv["approved-in-slack/TLSSN-42"], undefined);
  assert.equal(refused.kv["approve-command/C0EXAMPLE1:1758510010.000100"], undefined);
});

test("an approval that lands between the read and the move is still one beat: the record stays, a reaction, no model turn", async () => {
  const { kv, moves, posts, decision, reactions } = await handle({ approvedMeanwhile: true, message: said("approve TLSSN-42") });
  assert.equal(decision, null);
  assert.deepEqual([moves, posts], [[], []]);
  assert.equal(reactions.length, 1);
  assert.equal((kv["approved-in-slack/TLSSN-42"] as Record<string, unknown>)["by"], FILER);
});

// Round-2 finding 5: the move after the Planned read was unguarded, so a
// replan landing in that window went Triaged → Approved on the old brief.
test("a replan that lands between the read and the move is not approved from Triaged: no move, the record cleared, one host reply", async () => {
  const { kv, moves, posts, decision, reactions } = await handle({ replannedMeanwhile: true, message: said("approve TLSSN-42") });
  assert.equal(decision, null);
  assert.deepEqual([moves, reactions], [[], []]);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /not Planned, so I did not approve it/);
  assert.equal(kv["approved-in-slack/TLSSN-42"], undefined);
  assert.equal(kv["approve-command/C0EXAMPLE1:1758510010.000100"], undefined);
});

test("a bare approve KEY in the intake thread takes the same path through July's channel-post dispatch, with no model turn and one implement crumb", async () => {
  resetExternalSenderCache();
  const api = slackApi();
  const options = getSlackChannelOptions(slack)!;
  const tracker = jira({ status: "Planned" });
  const kv: Record<string, unknown> = { ...BOUND };
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
      event: { type: "message", channel: THREAD.channelId, channel_type: "channel", user: FILER, text: "approve TLSSN-42\n*Sent using* <@U0EXAMPLE1|Cursor>", ts: "1758510030.000100", thread_ts: THREAD.threadTs, team: TEAM },
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
  assert.deepEqual(tracker.moves, ["31"]);
  assert.equal(api.calls.filter((call) => call.method === "chat.postMessage").length, 1);
  assert.equal(api.calls.find((call) => call.method === "chat.postMessage")?.args["text"], "TLSSN-42: starting implementation…");
  assert.equal(api.calls.filter((call) => call.method === "reactions.add").length, 1);
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "implementing");
});

// A plain `approve` is `approve KEY` for the one ticket its thread maps to.
const MAPPED = { ...BOUND, [threadTicketsKey(THREAD)]: ["TLSSN-42"] };

test("a message that is only approve, with the approve KEY chrome allowed, is a plain approve", () => {
  for (const text of ["approve", "Approve!", "<@U0FACTORY> approve.", "<@U0FACTORY|factory> *approve*", "approve\n*Sent using* <@U0EXAMPLE1|Cursor>", "approve *Sent using* <@U0EXAMPLE1>"]) {
    assert.equal(isPlainApprove(said(text)), true, text);
  }
  for (const text of ["approve file", "approve TLSSN-42", "approve it", "don't approve", "approve?", "looks good, approve"]) {
    assert.equal(isPlainApprove(said(text)), false, text);
  }
});

test("a plain approve in a thread mapped to one Planned ticket approves it with ✅ only and no model turn", async () => {
  const { kv, moves, posts, decision, reactions } = await handle({ kv: { ...MAPPED }, message: said("<@U0FACTORY> approve") });
  assert.equal(decision, null);
  assert.deepEqual(moves, ["31"]);
  assert.deepEqual(posts, []);
  assert.deepEqual(reactions, [{ channel: THREAD.channelId, timestamp: "1758510010.000100", name: "white_check_mark" }]);
  assert.equal((kv["approved-in-slack/TLSSN-42"] as Record<string, unknown>)["by"], FILER);
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "implementing");
});

test("a plain approve with the inline Sent using footer is the same host approve", async () => {
  const { moves, posts, decision, reactions } = await handle({ kv: { ...MAPPED }, message: said("approve *Sent using* <@U0EXAMPLE1>") });
  assert.equal(decision, null);
  assert.deepEqual([moves, posts], [["31"], []]);
  assert.equal(reactions.length, 1);
});

test("a plain approve gets the replies approve KEY gives: someone else, or a ticket not in Planned; nothing moves and no model turn", async () => {
  const cases = [
    { name: "not the filer", message: said("approve", "U0BOB"), reply: /^Only the person who filed TLSSN-42 can say `approve TLSSN-42`/ },
    { name: "Triaged", status: "Triaged", message: said("approve"), reply: /^TLSSN-42 is Triaged, not Planned, so I did not approve it\./ },
    { name: "already Approved", status: "Approved", message: said("approve"), reply: /^TLSSN-42 is already Approved/ },
  ];
  for (const input of cases) {
    const { moves, posts, decision, reactions } = await handle({ kv: { ...MAPPED }, ...input });
    assert.equal(decision, null, input.name);
    assert.deepEqual([moves, reactions], [[], []], input.name);
    assert.equal(posts.length, 1, input.name);
    assert.match(posts[0]!, input.reply, input.name);
  }
});

test("a plain approve in a thread mapped to no ticket, or to more than one, gets one host line asking for approve KEY and no model turn", async () => {
  const unmapped = await handle({ kv: { ...BOUND }, message: said("approve") });
  assert.equal(unmapped.decision, null);
  assert.deepEqual([unmapped.moves, unmapped.reactions], [[], []]);
  assert.deepEqual(unmapped.posts, ["I can't tell which ticket to approve in this thread, so nothing moved. Say `approve KEY` with the ticket's key."]);

  const two = { ...MAPPED, "ticket/TLSSN-43": { ...THREAD, originatorUserId: FILER }, [threadTicketsKey(THREAD)]: ["TLSSN-42", "TLSSN-43"] };
  const ambiguous = await handle({ kv: two, message: said("approve") });
  assert.equal(ambiguous.decision, null);
  assert.deepEqual([ambiguous.moves, ambiguous.reactions], [[], []]);
  assert.deepEqual(ambiguous.posts, ["This thread has more than one ticket (TLSSN-42, TLSSN-43), so nothing moved. Say `approve KEY` with the one you mean."]);

  // The index is a hint: a key whose binding moved to another thread does not count.
  const moved = await handle({ kv: { [threadTicketsKey(THREAD)]: ["TLSSN-42"], "ticket/TLSSN-42": { ...THREAD, threadTs: "1758519999.000100", originatorUserId: FILER } }, message: said("approve") });
  assert.deepEqual([moved.decision, moved.moves], [null, []]);
  assert.match(moved.posts[0] ?? "", /^I can't tell which ticket/);

  const outside = await handle({ kv: { ...BOUND }, message: said("approve"), api: slackApi("T0OTHER") });
  assert.deepEqual([outside.decision, outside.posts, outside.moves], [null, [], []], "a Slack Connect sender hears nothing");
});

test("a plain approve in an unfiled filing thread takes the route approve file takes, not the ask for a key; once filed it approves the ticket", async () => {
  const root = { ...THREAD, threadTs: "1758510000.000001" };
  const kv: Record<string, unknown> = {};
  const request = { ...said("<@U0FACTORY> file a bug: the CSV export drops the header row", FILER, root), ts: root.threadTs };
  await handle({ kv, message: request, thread: root });
  assert.ok(kv[filingThreadKey(root)] !== undefined, "the filing request marks its thread");

  const fileIt = await handle({ kv, message: said("approve file", FILER, root), thread: root });
  const plain = await handle({ kv, message: said("approve", FILER, root), thread: root });
  const footed = await handle({ kv, message: said("approve *Sent using* <@U0EXAMPLE1>", FILER, root), thread: root });
  for (const [name, outcome] of [["approve file", fileIt], ["plain approve", plain], ["plain approve with footer", footed]] as const) {
    assert.notEqual(outcome.decision, null, name);
    assert.deepEqual([outcome.posts, outcome.moves, outcome.reactions], [[], [], []], name);
  }

  // file_ticket binds the thread and records it, so the next plain approve is that ticket's.
  Object.assign(kv, { "ticket/TLSSN-44": { ...root, originatorUserId: FILER }, [threadTicketsKey(root)]: ["TLSSN-44"] });
  const filed = await handle({ kv, status: "To Do", message: { ...said("approve", FILER, root), ts: "1758510020.000100" }, thread: root });
  assert.equal(filed.decision, null);
  assert.deepEqual(filed.moves, []);
  assert.equal(filed.posts.length, 1);
  assert.match(filed.posts[0]!, /^TLSSN-44 is To Do, not Planned/);
});

function recordKv(rows: Record<string, unknown>) {
  return { get: async (key: string) => rows[key] as never, put: async (key: string, value: unknown) => void (rows[key] = value), delete: async (key: string) => void delete rows[key] };
}

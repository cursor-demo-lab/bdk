import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchInboundMessage, getSlackChannelOptions, resetExternalSenderCache, type SlackApiTransport, type SlackMessage, type SlackMessageHandler } from "@cursor/july/channels/slack";
import slack from "../channels/slack.js";
import { opensAgentSession, withAgentSession } from "./agent-session.js";

const CHANNEL = "C0EXAMPLE1";
const ROOT = "1790416144.037009";
const FILER = "U0EXAMPLE3";
const TEAM = "T0EXAMPLE1";

function message(over: Partial<SlackMessage> = {}): SlackMessage {
  return {
    text: "<@U0BOT> Transfers page 500s on submit\nsteps below",
    body: "<@U0BOT> Transfers page 500s on submit\nsteps below",
    markdown: "Transfers page 500s on submit\nsteps below",
    ts: ROOT,
    threadTs: ROOT,
    channelId: CHANNEL,
    teamId: TEAM,
    author: { userId: FILER, userName: "filer", isBot: false },
    ...over,
  };
}

type Call = { method: string; args: Record<string, unknown> };

// Slack's agent-sessions bridge as it answers the legacy methods: a status
// write creates the thread's session once it completes, and a title write
// renames a session that already exists, else `no_permission`. Every call
// takes a network round trip, so two calls sent together race.
function slackModel() {
  const calls: Call[] = [];
  const sessions = new Map<string, string>();
  const key = (args: Record<string, unknown>) => `${String(args["channel_id"])}:${String(args["thread_ts"])}`;
  const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 5));
  const call = async (method: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    calls.push({ method, args });
    if (method === "assistant.threads.setTitle") {
      const open = sessions.has(key(args));
      await roundTrip();
      if (!open) return { ok: false, error: "no_permission" };
      sessions.set(key(args), String(args["title"]));
      return { ok: true };
    }
    await roundTrip();
    if (method === "assistant.threads.setStatus" || method === "agents.sessions.setStatus") {
      if (!sessions.has(key(args))) sessions.set(key(args), String(args["title"] ?? ""));
      return { ok: true };
    }
    if (method === "users.info") return { ok: true, user: { id: FILER, team_id: TEAM } };
    return { ok: true };
  };
  const transport: SlackApiTransport = { kind: "api-transport", label: "test", call };
  const client = { apiCall: (method: string, args: Record<string, unknown>) => call(method, args) };
  return { calls, sessions, transport, client };
}

function ctxFor(client: unknown, channelId = CHANNEL, threadTs = ROOT) {
  return { slack: { channelId, threadTs, teamId: TEAM }, host: { slack: { getClient: async () => client } } } as never;
}

const TURN = { auth: null, message: "model turn" };

test("only a root message outside a DM opens a session, which is where July titles a thread", () => {
  assert.equal(opensAgentSession(message()), true);
  assert.equal(opensAgentSession(message({ channelId: "G0PRIVATE1" })), true);
  assert.equal(opensAgentSession(message({ ts: "1790416150.000100" })), false);
  assert.equal(opensAgentSession(message({ channelId: "D0DIRECT01" })), false);
  assert.equal(opensAgentSession(message({ channelId: "" })), false);
});

test("an accepted channel root opens its agent session with July's title and the filer as initiator", async () => {
  const model = slackModel();
  const decision = await withAgentSession(() => TURN)(ctxFor(model.client), message());
  assert.equal(decision, TURN);
  assert.deepEqual(model.calls, [
    {
      method: "agents.sessions.setStatus",
      args: { channel_id: CHANNEL, thread_ts: ROOT, status: "active", title: "Transfers page 500s on submit", initiator_user_id: FILER },
    },
  ]);
});

test("a skipped message, a reply and a DM open no session", async () => {
  const model = slackModel();
  assert.equal(await withAgentSession(() => null)(ctxFor(model.client), message()), null);
  await withAgentSession(() => TURN)(ctxFor(model.client), message({ ts: "1790416150.000100" }));
  await withAgentSession(() => TURN)(ctxFor(model.client, "D0DIRECT01", ROOT), message({ channelId: "D0DIRECT01" }));
  assert.deepEqual(model.calls, []);
});

test("a bot-authored root opens the session without an initiator", async () => {
  const model = slackModel();
  await withAgentSession(() => TURN)(ctxFor(model.client), message({ author: { userId: "U0OTHERBOT", isBot: true } }));
  assert.equal(model.calls.length, 1);
  assert.equal("initiator_user_id" in model.calls[0]!.args, false);
});

test("a refused, failing, missing or slow Slack leaves the decision alone, throws nothing and logs nothing", async () => {
  const printed: unknown[] = [];
  const quiet = [console.log, console.warn, console.error] as const;
  console.log = console.warn = console.error = (...args: unknown[]) => void printed.push(args);
  try {
    const refused = { apiCall: async () => ({ ok: false, error: "no_permission" }) };
    const failing = { apiCall: async () => Promise.reject(new Error("socket hang up")) };
    const slow = { apiCall: () => new Promise(() => {}) };
    for (const client of [refused, failing, slow]) {
      assert.equal(await withAgentSession(() => TURN, 20)(ctxFor(client), message()), TURN);
    }
    const noSlack = { slack: { channelId: CHANNEL, threadTs: ROOT }, host: {} } as never;
    assert.equal(await withAgentSession(() => TURN, 20)(noSlack, message()), TURN);
  } finally {
    [console.log, console.warn, console.error] = quiet;
  }
  assert.deepEqual(printed, []);
});

async function dispatchRoot(handler: SlackMessageHandler) {
  const model = slackModel();
  const warnings: string[] = [];
  const log = { info: () => {}, debug: () => {}, error: () => {}, warn: (line: string) => void warnings.push(line) } as never;
  await dispatchInboundMessage({
    kind: "app_mention",
    message: message(),
    handler,
    send: (async () => ({ id: "ses_test", isNew: true })) as never,
    credentials: { botToken: model.transport },
    host: { slack: { getClient: async () => model.client } } as never,
    artifacts: {} as never,
    log,
    evalCommandsEnabled: false,
    ack: "eyes",
  });
  // July's setTitle is fire-and-forget; let its round trip settle.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { model, warnings };
}

test("through July's dispatch, a bare handler's root title races the session and is refused (the logged no_permission)", async () => {
  const { model, warnings } = await dispatchRoot(() => TURN);
  const methods = model.calls.map((call) => call.method);
  assert.ok(methods.includes("assistant.threads.setStatus"));
  assert.ok(methods.includes("assistant.threads.setTitle"));
  assert.deepEqual(warnings, ["setTitle not-ok"]);
});

test("through July's dispatch, the desk's session opens first, so July's title lands and nothing is logged", async () => {
  const { model, warnings } = await dispatchRoot(withAgentSession(() => TURN));
  const methods = model.calls.map((call) => call.method);
  assert.equal(methods[0], "agents.sessions.setStatus");
  assert.ok(methods.indexOf("assistant.threads.setTitle") > 0);
  assert.deepEqual(warnings, []);
  assert.equal(model.sessions.get(`${CHANNEL}:${ROOT}`), "Transfers page 500s on submit");
});

test("the desk's mention handler opens the session for a plain root request", async () => {
  resetExternalSenderCache();
  const model = slackModel();
  const kv = new Map<string, unknown>();
  const ctx = {
    slack: { channelId: CHANNEL, threadTs: ROOT, teamId: TEAM },
    thread: { post: async () => ({ ts: "1790416151.000100" }), startTyping: async () => {}, setTitle: async () => {}, setSuggestedPrompts: async () => {} },
    host: {
      slack: { getClient: async () => model.client },
      kv: { get: async (key: string) => kv.get(key), put: async (key: string, value: unknown) => void kv.set(key, value), delete: async (key: string) => void kv.delete(key) },
    },
    artifacts: {},
  } as never;
  const decision = await getSlackChannelOptions(slack)!.onAppMention!(ctx, message());
  assert.notEqual(decision, null);
  assert.equal(model.calls.filter((call) => call.method === "agents.sessions.setStatus").length, 1);
});

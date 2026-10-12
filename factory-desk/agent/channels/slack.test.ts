import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
  type SlackChannelMessageEvent,
  type SlackMessage,
  type SlackMessageHandler,
} from "@cursor/july/channels/slack";
import { setDeskSelfIdentity } from "../lib/config.js";
import { commandKey, speakerKey } from "../lib/originator.js";
import slack, { DESK_CHANNEL_POSTS } from "./slack.js";

// Drives the authored channel through July's own inbound dispatch, the path
// Socket Mode and hosted admission both take. A missing binding falls back to
// July's stock handler, exactly as slackChannel() does, so deleting or
// replacing a binding in slack.ts changes what this test sees.
const PR = "https://github.com/acme/widgets/pull/12";
const TEAM = "T0123";
const SELF = "U0FACTORY";

// A fix request's reply is claimed once per message (handled-message.ts);
// the claim's settle wait is not the latency these tests measure.
// The desk learns its own identity once per process (self-identity.ts, pinned
// in self-identity.test.ts); it is known here so these counts are July's and
// the handler's alone, whatever order the tests run in.
const savedSettle = process.env.FACTORY_DESK_CLAIM_SETTLE_MS;
before(() => {
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
  setDeskSelfIdentity({ userId: SELF, name: "factory" });
});
after(() => {
  if (savedSettle === undefined) delete process.env.FACTORY_DESK_CLAIM_SETTLE_MS;
  else process.env.FACTORY_DESK_CLAIM_SETTLE_MS = savedSettle;
  setDeskSelfIdentity(undefined);
});

function slackApi(userTeam = TEAM, usersInfoDelayMs = 0) {
  const calls: string[] = [];
  const lookedUp: string[] = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      calls.push(method);
      if (method === "auth.test") return { ok: true, user_id: SELF, user: "factory" };
      if (method === "users.info") {
        const user = String((args as Record<string, unknown>)["user"]);
        lookedUp.push(user);
        if (user === SELF) return { ok: true, user: { id: SELF, name: "factory", team_id: TEAM, is_bot: true, profile: { display_name: "", real_name: "factory" } } };
        await new Promise((resolve) => setTimeout(resolve, usersInfoDelayMs));
        return { ok: true, user: { id: "U0ALICE", team_id: userTeam } };
      }
      if (method === "chat.postMessage") return { ok: true, ts: "1758510001.000100" };
      return { ok: true, messages: [] };
    },
  };
  return { calls, lookedUp, transport };
}

function hostOver(api: ReturnType<typeof slackApi>, kv: Record<string, unknown> = {}) {
  const client = { apiCall: (method: string, args: Record<string, unknown>) => api.transport.call(method, args) };
  return {
    kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
    slack: { getClient: async () => client },
  };
}

async function deliver(event: Record<string, unknown>, api = slackApi()) {
  resetExternalSenderCache();
  const options = getSlackChannelOptions(slack);
  assert.ok(options !== undefined, "agent/channels/slack.ts must default-export slackChannel(...)");
  const sends: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const dispatched = dispatchInboundFromEventBody(
    { type: "event_callback", team_id: TEAM, event_id: `Ev${Math.random()}`, event: { team: TEAM, ...event } },
    {
      send: (async (...args: unknown[]) => {
        sends.push(args);
        return { sessionId: "ses_test" };
      }) as never,
      waitUntil: (promise) => void pending.push(promise),
      onAppMention: options.onAppMention ?? createDefaultOnInbound(),
      onDirectMessage: options.onDirectMessage ?? createDefaultOnInbound(),
      credentials: { botToken: api.transport },
      eventIds: createEventIdDedupe(),
      host: hostOver(api) as never,
      artifacts: {} as never,
      log: { info: () => {}, error: () => {}, warn: () => {} } as never,
      mentionsEnabled: options.engagement?.mentions !== false,
      directMessagesEnabled: options.engagement?.directMessages !== false,
    }
  );
  assert.equal(dispatched, true, "the event was not dispatched");
  await Promise.all(pending);
  return { sends, calls: api.calls, lookedUp: api.lookedUp };
}

const mentionEvent = (text: string) => ({
  type: "app_mention",
  user: "U0ALICE",
  text,
  ts: "1758510000.200000",
  thread_ts: "1758510000.123456",
  channel: "C0123ABCD",
});

const directEvent = (text: string) => ({
  type: "message",
  channel_type: "im",
  user: "U0ALICE",
  text,
  ts: "1758510000.300000",
  channel: "D0123ABCD",
});

// July starts one users.info of the sender before calling the handler, and
// the originator gate (recordingSpeakers) makes its own, so every first
// message costs two. The desk's sender check reads the cache those leave and
// adds none.
const SENDER_LOOKUPS = 2;
const senderLookups = (lookedUp: string[]) => lookedUp.filter((user) => user !== SELF).length;
// July 0.2.13 names the bot in a turn's <slack_context> from its own
// users.info profile after auth.test, once per token, whenever a message
// reaches its stock turn path (even one its external policy then refuses); a
// message the handler answers itself makes no such lookup.
const TURN_SELF_LOOKUPS = 1;
const selfLookups = (lookedUp: string[]) => lookedUp.filter((user) => user === SELF).length;

test("a mention or direct message asking to fix a PR gets one thread post, no users.info of its own, and no model turn", async () => {
  for (const event of [mentionEvent(`<@U0FACTORY> fix <${PR}>`), directEvent(`drive <${PR}>?`)]) {
    const { sends, calls, lookedUp } = await deliver(event);
    assert.deepEqual(sends, [], String(event.text));
    assert.equal(calls.filter((call) => call === "chat.postMessage").length, 1, String(event.text));
    assert.equal(senderLookups(lookedUp), SENDER_LOOKUPS, String(event.text));
    assert.equal(selfLookups(lookedUp), 0, String(event.text));
  }
});

test("any other mention or direct message starts a model turn, posts nothing itself, and costs the same sender lookups plus July's own", async () => {
  for (const event of [mentionEvent("<@U0FACTORY> approve TLSSN-42 please"), directEvent(`fix <${PR}> and log this`)]) {
    const { sends, calls, lookedUp } = await deliver(event);
    assert.equal(sends.length, 1, String(event.text));
    assert.equal(calls.filter((call) => call === "chat.postMessage").length, 0, String(event.text));
    assert.equal(senderLookups(lookedUp), SENDER_LOOKUPS, String(event.text));
    assert.equal(selfLookups(lookedUp), TURN_SELF_LOOKUPS, String(event.text));
    assert.match(String((sends[0] as unknown[])[0]), /self_user_id: U0FACTORY\nself_name: factory\n/, String(event.text));
  }
});

test("a Slack Connect sender asking to fix a PR, by mention or DM, gets no post and no model turn", async () => {
  for (const event of [mentionEvent(`<@U0FACTORY> fix <${PR}>`), directEvent(`fix acme/widgets#12`)]) {
    const { sends, calls, lookedUp } = await deliver(event, slackApi("T0OTHER"));
    assert.deepEqual(sends, [], String(event.text));
    assert.equal(calls.filter((call) => call === "chat.postMessage").length, 0, String(event.text));
    assert.equal(senderLookups(lookedUp), SENDER_LOOKUPS, String(event.text));
    assert.equal(selfLookups(lookedUp), TURN_SELF_LOOKUPS, String(event.text));
  }
});

test("a top-level filing request gets 👀 before the model turn; a reply in a thread and a Slack Connect sender do not", async () => {
  const reacted = (api: ReturnType<typeof slackApi>) => {
    const seen: Array<Record<string, unknown>> = [];
    const call = api.transport.call;
    api.transport.call = async (method, args) => {
      if (method === "reactions.add") seen.push(args as Record<string, unknown>);
      return call(method, args);
    };
    return seen;
  };
  const top = { ...mentionEvent("<@U0FACTORY> file a bug: CSV export 500 on an empty filter"), ts: "1758510000.123456" };
  const api = slackApi();
  const seen = reacted(api);
  const { sends } = await deliver(top, api);
  assert.equal(sends.length, 1, "the model still drafts the filing reply");
  assert.deepEqual(seen, [{ channel: "C0123ABCD", timestamp: "1758510000.123456", name: "eyes" }]);

  for (const [event, source] of [
    [mentionEvent("<@U0FACTORY> file a bug: CSV export 500"), slackApi()],
    [top, slackApi("T0OTHER")],
  ] as const) {
    const none = reacted(source);
    await deliver(event, source);
    assert.deepEqual(none, [], String(event.ts));
  }
});

test("a slow users.info answer still gets the post, soon after it lands, with no extra lookup", { timeout: 3000 }, async () => {
  const started = Date.now();
  const { sends, calls, lookedUp } = await deliver(mentionEvent(`<@U0FACTORY> fix <${PR}>`), slackApi(TEAM, 150));
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.deepEqual(sends, []);
  assert.equal(calls.filter((call) => call === "chat.postMessage").length, 1);
  assert.equal(senderLookups(lookedUp), SENDER_LOOKUPS);
});

// The originator gate depends on this channel recording who spoke. These
// are the handlers July dispatches mentions, DMs, and allowlisted channel
// posts to (channels/slack/slack-channel.js), read back from the real
// channel definition.
test("the Slack channel keeps toolApprovals off; hosted v2 has no card ingress", () => {
  assert.equal(getSlackChannelOptions(slack)?.toolApprovals, false);
});

test("the Slack channel watches intake posts:all so a plain reply in a factory thread wakes the desk; the watch is gated, mentions and DMs are not", () => {
  const options = getSlackChannelOptions(slack);
  assert.deepEqual(options?.engagement, {
    mentions: true,
    directMessages: true,
    channelPosts: DESK_CHANNEL_POSTS,
  });
  assert.deepEqual(DESK_CHANNEL_POSTS, {
    allow: ["C0EXAMPLE1", "#mars-eng-intake"],
    posts: "all",
  });
  assert.notEqual(options?.onChannelPost, options?.onAppMention, "plain posts pass the factory-thread gate first (lib/plain-reply.ts)");
  assert.equal(options?.onAppMention, options?.onDirectMessage);
});

test("approve KEY with more words in the intake ticket thread: as a mention it starts the tagged model turn; as a plain reply it is chatter and gets nothing", async () => {
  const deliver = async (type: "app_mention" | "message", text: string, ts: string) => {
    resetExternalSenderCache();
    const api = slackApi();
    const options = getSlackChannelOptions(slack)!;
    const sends: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const kv = { "ticket/TLSSN-19": { channelId: "C0EXAMPLE1", threadTs: "1758510000.123456", originatorUserId: "U0ALICE" }, "thread-tickets/C0EXAMPLE1:1758510000.123456": ["TLSSN-19"] };
    const host = hostOver(api, kv);
    const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never;
    const send = (async (...args: unknown[]) => {
      sends.push(args);
      return { sessionId: "ses_test" };
    }) as never;
    const watcher = createChannelPostWatcher({
      options: { ...DESK_CHANNEL_POSTS, debounceMs: 0 },
      allowlist: new SlackChannelAllowlist(DESK_CHANNEL_POSTS.allow),
      getBotUserId: () => "U0FACTORY",
      dispatch: (message) => {
        pending.push(dispatchInboundMessage({ kind: "channel_post", message, handler: options.onChannelPost!, send, credentials: { botToken: api.transport }, host: host as never, artifacts: {} as never, log, evalCommandsEnabled: true }));
      },
      log,
    });
    const deps = {
      send,
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      onAppMention: options.onAppMention!,
      onDirectMessage: options.onDirectMessage!,
      credentials: { botToken: api.transport },
      host: host as never,
      artifacts: {} as never,
      log,
      mentionsEnabled: true,
      directMessagesEnabled: true,
      channelWatch: watcher,
    };
    const event = { channel: "C0EXAMPLE1", channel_type: "channel", user: "U0ALICE", text, ts, thread_ts: "1758510000.123456", team: TEAM };
    const body = (kind: string) => ({ type: "event_callback", team_id: TEAM, event_id: `Ev${Math.random()}`, authorizations: [{ user_id: "U0FACTORY" }], event: { ...event, type: kind } });
    if (type === "app_mention") dispatchInboundFromEventBody(body("app_mention"), { ...deps, eventIds: createEventIdDedupe() });
    dispatchInboundFromEventBody(body("message"), { ...deps, eventIds: createEventIdDedupe() });
    await Promise.all(pending);
    return { sends, posts: api.calls.filter((call) => call === "chat.postMessage").length };
  };

  const mentioned = await deliver("app_mention", "<@U0FACTORY> approve TLSSN-19 please", "1758510000.200000");
  assert.equal(mentioned.sends.length, 1);
  assert.equal(mentioned.posts, 0);
  const prompt = String((mentioned.sends[0] as unknown[])[0]);
  assert.match(prompt, /<desk_command>/);
  assert.match(prompt, /approve_ticket/);
  assert.match(prompt, /TLSSN-19/);

  assert.deepEqual(await deliver("message", "approve TLSSN-19 please", "1758510000.200001"), { sends: [], posts: 0 });
});

// Hosted Slack edges also deliver `message.bot` in a continued thread from
// July 0.2.18 (internal/continuation-identity.js). The desk sets no
// includeBotPosts, so July's channel watch drops a bot's reply before
// factoryThreadReplies, even an exact command in a factory thread.
test("a bot's reply in a factory thread never reaches the gate or a turn, an exact command included; a person's reply does", async () => {
  const thread = "1758510000.123456";
  const deliver = async (event: Record<string, unknown>) => {
    resetExternalSenderCache();
    const api = slackApi();
    const options = getSlackChannelOptions(slack)!;
    const sends: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const reached: string[] = [];
    const kv = { "ticket/TLSSN-19": { channelId: "C0EXAMPLE1", threadTs: thread, originatorUserId: "U0ALICE" }, [`thread-tickets/C0EXAMPLE1:${thread}`]: ["TLSSN-19"] };
    const host = hostOver(api, kv);
    const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never;
    const send = (async (...args: unknown[]) => {
      sends.push(args);
      return { sessionId: "ses_test" };
    }) as never;
    const watcher = createChannelPostWatcher({
      options: { ...DESK_CHANNEL_POSTS, debounceMs: 0 },
      allowlist: new SlackChannelAllowlist(DESK_CHANNEL_POSTS.allow),
      getBotUserId: () => SELF,
      getBotId: () => "B0FACTORY",
      dispatch: (message) => {
        reached.push(message.ts);
        pending.push(dispatchInboundMessage({ kind: "channel_post", message, handler: options.onChannelPost!, send, credentials: { botToken: api.transport }, host: host as never, artifacts: {} as never, log, evalCommandsEnabled: true }));
      },
      log,
    });
    dispatchInboundFromEventBody(
      { type: "event_callback", team_id: TEAM, event_id: `Ev${Math.random()}`, authorizations: [{ user_id: SELF }], event: { type: "message", channel: "C0EXAMPLE1", channel_type: "channel", thread_ts: thread, team: TEAM, ...event } },
      { send, waitUntil: (promise: Promise<unknown>) => void pending.push(promise), onAppMention: options.onAppMention!, onDirectMessage: options.onDirectMessage!, credentials: { botToken: api.transport }, host: host as never, artifacts: {} as never, log, mentionsEnabled: true, directMessagesEnabled: true, channelWatch: watcher, eventIds: createEventIdDedupe() }
    );
    await Promise.all(pending);
    return { reached, sends: sends.length, posts: api.calls.filter((call) => call === "chat.postMessage").length };
  };

  const none = { reached: [], sends: 0, posts: 0 };
  assert.deepEqual(await deliver({ subtype: "bot_message", bot_id: "B0OTHERAPP", username: "ci-bot", text: "approve TLSSN-19", ts: "1758510000.200100" }), none, "another app's bot");
  assert.deepEqual(await deliver({ bot_id: "B0FACTORY", user: SELF, text: "approve TLSSN-19", ts: "1758510000.200200" }), none, "the desk's own post");
  assert.deepEqual(await deliver({ user: "U0ALICE", text: "thanks all", ts: "1758510000.200300" }), { reached: ["1758510000.200300"], sends: 0, posts: 0 }, "a person's chatter reaches the gate, which drops it");
});

test("channelPosts:all dispatches a bare intake-thread reply and a top-level intake post, not another channel", () => {
  const seen: string[] = [];
  const watcher = createChannelPostWatcher({
    options: DESK_CHANNEL_POSTS,
    allowlist: new SlackChannelAllowlist(DESK_CHANNEL_POSTS.allow),
    getBotUserId: () => "U0FACTORY",
    dispatch: (message) => seen.push(`${message.channelId}:${message.ts}:${message.threadTs}`),
    log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never,
  });
  const post = (channelId: string, ts: string, threadTs: string): SlackChannelMessageEvent => ({
    kind: "post",
    message: {
      text: "approve file",
      body: "approve file",
      markdown: "approve file",
      ts,
      threadTs,
      channelId,
      teamId: TEAM,
      author: { userId: "U0ALICE", userName: "alice", isBot: false },
    },
  });
  assert.equal(watcher.handle(post("C0EXAMPLE1", "1758510000.200000", "1758510000.123456")), true);
  assert.deepEqual(seen, ["C0EXAMPLE1:1758510000.200000:1758510000.123456"]);
  seen.length = 0;
  assert.equal(watcher.handle(post("C0EXAMPLE1", "1758510001.000000", "1758510001.000000")), true);
  assert.deepEqual(seen, ["C0EXAMPLE1:1758510001.000000:1758510001.000000"]);
  seen.length = 0;
  watcher.handle(post("C0OTHER001", "1758510000.200000", "1758510000.123456"));
  assert.deepEqual(seen, []);
});

const THREAD = { channelId: "C0123ABCD", threadTs: "1758510000.123456" };

function binding(kv: Record<string, unknown>, posts: string[] = []): SlackBinding {
  resetExternalSenderCache();
  const api = slackApi();
  return {
    slack: { ...THREAD, teamId: TEAM },
    thread: { startTyping: async () => {}, post: async (text: string) => (posts.push(text), { ts: "1758510011.000100" }) },
    host: hostOver(api, kv),
  } as unknown as SlackBinding;
}

function spoken(text: string): SlackMessage {
  return { text, body: text, markdown: text, ts: "1758510010.000100", ...THREAD, teamId: TEAM, author: { userId: "U0ALICE01", userName: "alice", isBot: false } };
}

// onAppMention, onDirectMessage, and onChannelPost are one handler (asserted
// above), so these drive it once.
test("the Slack inbound handler records the speaker and their command before the turn", async () => {
  const handler = getSlackChannelOptions(slack)?.onAppMention as SlackMessageHandler | undefined;
  assert.ok(handler !== undefined);
  const kv: Record<string, unknown> = {};
  try {
    await handler(binding(kv), spoken("<@U0DESK> approve TLSSN-42"));
  } catch {
    // The default reply path needs a live Slack thread; the record comes first.
  }
  assert.deepEqual(kv[speakerKey(THREAD)], { userId: "U0ALICE01", ts: "1758510010.000100" });
  assert.deepEqual(kv[commandKey(THREAD, { verb: "approve", target: "TLSSN-42" })], { userId: "U0ALICE01", ts: "1758510010.000100" });
});

test("the Slack inbound handler records a fix request's speaker and answers it with the canned post", async () => {
  const handler = getSlackChannelOptions(slack)?.onAppMention as SlackMessageHandler | undefined;
  assert.ok(handler !== undefined);
  const kv: Record<string, unknown> = {};
  const posts: string[] = [];
  assert.equal(await handler(binding(kv, posts), spoken(`<@U0DESK> fix <${PR}>`)), null);
  assert.deepEqual(kv[speakerKey(THREAD)], { userId: "U0ALICE01", ts: "1758510010.000100" });
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /`factory: drive`/);
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import { getSlackChannelOptions, resetExternalSenderCache, type SlackApiTransport, type SlackBinding, type SlackMessage, type SlackMessageHandler } from "@cursor/july/channels/slack";
import { hopWatchKey } from "../lib/hop-watch.js";
import { ensureLoader, loaderKey } from "../lib/loader.js";
import { planCommandTarget } from "../lib/plan-command.js";
import { retryTarget } from "../lib/retry-command.js";
import slack from "./slack.js";

// TLSSN-32: `@factory replan KEY` / `@factory plan KEY` left the thread with
// only ⏳ for a seven-minute planning run, and `@factory retry KEY` was
// answered by the model. A Slack mention can arrive labeled (`<@U…|factory>`),
// which the host parsers did not strip. The host command path takes these,
// moves the ticket, and puts the planner crumb up itself.

const ENV = { FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_DESK_CLAIM_SETTLE_MS: "1" } as const;
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
const CRUMB = `${KEY}: planner is checking the code…`;
const VERDICT = { id: "1", body: "Triage: feedback\nSeverity: medium" };

function tracker(status: string, comments = [VERDICT]) {
  const state = { status, moves: [] as string[] };
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
      if (tool === "getJiraIssue") return json({ key: KEY, fields: { summary: "CSV export", status: { name: state.status }, comment: { comments } } });
      if (tool === "getTransitionsForJiraIssue") return json({ transitions: statuses.map((name, i) => ({ id: String(i + 1), name, to: { name } })) });
      if (tool === "transitionJiraIssue") {
        const to = statuses[Number((args["transition"] as { id: string }).id) - 1]!;
        state.moves.push(`${state.status} → ${to}`);
        state.status = to;
      }
      return json({});
    },
  };
  return { mcp, state };
}

function slackClient() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      calls.push({ method, args: args as Record<string, unknown> });
      if (method === "users.info") return { ok: true, user: { id: FILER, team_id: TEAM } };
      if (method === "chat.postMessage") return { ok: true, ts: "1758510003.000100" };
      return { ok: true, messages: [] };
    },
  };
  const client = { apiCall: (method: string, args: Record<string, unknown>) => transport.call(method, args) };
  return { calls, client };
}

function said(text: string, user = FILER, ts = "1758510010.000100"): SlackMessage {
  return { text, body: text, markdown: text, ts, ...THREAD, teamId: TEAM, author: { userId: user, userName: "alice", isBot: false } };
}

const onAppMention = getSlackChannelOptions(slack)?.onAppMention as SlackMessageHandler;
const onChannelPost = getSlackChannelOptions(slack)?.onChannelPost as SlackMessageHandler;

/** One inbound delivery. `model` is true when the message reached the model path. */
async function deliver(input: { text: string; status: string; kv?: Record<string, unknown>; user?: string; comments?: Array<{ id: string; body: string }>; handlers?: SlackMessageHandler[] }) {
  const kv = input.kv ?? structuredClone(BOUND);
  const jira = tracker(input.status, input.comments);
  const slackApi = slackClient();
  const posts: string[] = [];
  resetExternalSenderCache();
  const binding = {
    slack: { ...THREAD, teamId: TEAM },
    thread: { startTyping: async () => {}, post: async (text: string) => (posts.push(text), { ts: "1758510011.000100" }) },
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      slack: { getClient: async () => slackApi.client },
      mcp: jira.mcp,
    },
  } as unknown as SlackBinding;
  const log = console.log;
  console.log = () => {};
  const message = said(input.text, input.user);
  // Concurrent, like Slack's app_mention and message deliveries of one post.
  const turns = await Promise.all(
    (input.handlers ?? [onAppMention]).map(async (handler) => {
      try {
        return (await handler(binding, message)) !== null;
      } catch {
        // The stock model path needs a live Slack thread; reaching it is what counts.
        return true;
      }
    })
  ).finally(() => {
    console.log = log;
  });
  const model = turns.some(Boolean);
  const crumbs = slackApi.calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args["text"]);
  const reactions = slackApi.calls.filter((call) => call.method === "reactions.add").map((call) => call.args["name"]);
  return { kv, model, moves: jira.state.moves, posts, crumbs, reactions };
}

test("plan and replan, bare or after a mention in any Slack form, are the host command", () => {
  for (const text of [`plan ${KEY}`, `<@U0FACTORY> plan ${KEY}`, `<@U0FACTORY|factory> plan ${KEY}.`, `@factory: plan ${KEY}`]) assert.deepEqual(planCommandTarget(text), { verb: "plan", issueKey: KEY }, text);
  assert.deepEqual(planCommandTarget(`<@U0FACTORY|factory> Replan tlssn-42\n*Sent using* <@U0EXAMPLE1|Cursor>`), { verb: "replan", issueKey: KEY });
  for (const text of [`plan ${KEY} please`, `don't plan ${KEY}`, "plan file", `approve ${KEY}`]) assert.equal(planCommandTarget(text), undefined, text);
});

test("a labeled mention in front of retry is still the retry command", () => {
  assert.equal(retryTarget(`<@U0FACTORY|factory> retry ${KEY}`), KEY);
});

test("@factory replan KEY on a Triaged ticket bounces it to the planner in host code and posts the planner crumb", async () => {
  const { kv, model, moves, posts, crumbs, reactions } = await deliver({ text: `<@U0FACTORY|factory> replan ${KEY}`, status: "Triaged" });
  assert.equal(model, false, "no model turn");
  assert.deepEqual(moves, ["Triaged → To Do", "To Do → Triaged"]);
  assert.deepEqual(crumbs, [CRUMB]);
  assert.deepEqual(posts, [], "the crumb is the one desk message");
  assert.ok(reactions.includes("white_check_mark"), "the command is acked");
  assert.equal((kv[loaderKey(KEY)] as Record<string, unknown>)["phase"], "planning");

  const again = await deliver({ text: `<@U0FACTORY|factory> replan ${KEY}`, status: "Triaged", kv });
  assert.deepEqual([again.model, again.moves, again.posts, again.crumbs], [false, [], [], []], "a redelivery moves and posts nothing");
});

test("@factory plan KEY on a Planned ticket sends it back to the planner with the crumb", async () => {
  const { model, moves, crumbs } = await deliver({ text: `<@U0FACTORY> plan ${KEY}`, status: "Planned" });
  assert.equal(model, false);
  assert.deepEqual(moves, ["Planned → Triaged"]);
  assert.deepEqual(crumbs, [CRUMB]);
});

test("a plan command from someone other than the filer gets one host refusal, no model turn, and moves nothing", async () => {
  const { model, moves, crumbs, posts } = await deliver({ text: `<@U0FACTORY|factory> plan ${KEY}`, status: "Triaged", user: "U0BOB0001" });
  assert.equal(model, false);
  assert.deepEqual([moves, crumbs], [[], []]);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /^Only the person who filed TLSSN-42 can say `plan TLSSN-42`/);
});

// TLSSN-33: a labeled mention (`<@U…|factory>`) is not skipped by July's
// channel watcher, so Slack's app_mention and message deliveries of the same
// post both reach the desk. Everysphere's contract
// (anybot/incident-bot/handled-message-gate.ts) is one handling per message.
for (const [text, status, reply] of [
  [`<@U0FACTORY|factory> retry ${KEY}`, "Triaged", /^Started a fresh planning run for TLSSN-42\./],
  [`<@U0FACTORY|factory> retry ${KEY}`, "In Progress", /nothing to retry/],
  [`<@U0FACTORY|factory> plan ${KEY}`, "In Review", /past planning/],
] as const) {
  test(`${text} on a ${status} ticket delivered as app_mention and message gets one host reply and no model turn`, async () => {
    const { model, posts } = await deliver({ text, status, handlers: [onAppMention, onChannelPost] });
    assert.equal(model, false, "no model turn on either delivery");
    assert.equal(posts.length, 1, posts.join("\n---\n"));
    assert.match(posts[0]!, reply);
  });
}

test("a fix request with a labeled mention delivered as app_mention and message gets its fixed reply once", async () => {
  const { model, posts } = await deliver({ text: "<@U0FACTORY|factory> fix acme/widgets#12", status: "Triaged", handlers: [onAppMention, onChannelPost] });
  assert.equal(model, false, "no model turn on either delivery");
  assert.equal(posts.length, 1, posts.join("\n---\n"));
  assert.match(posts[0]!, /^I can't drive acme\/widgets#12\./);
});

test("a refused retry delivered twice is refused once, by host code", async () => {
  const { model, posts } = await deliver({ text: `<@U0FACTORY|factory> retry ${KEY}`, status: "Triaged", user: "U0BOB0001", handlers: [onAppMention, onChannelPost] });
  assert.equal(model, false);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /^Only the person who filed TLSSN-42/);
});

test("a gated verdict or a ticket past planning gets one host reply and no move", async () => {
  const gated = await deliver({ text: `<@U0FACTORY> plan ${KEY}`, status: "Triaged", comments: [{ id: "1", body: "Triage: question\nSeverity: low" }] });
  assert.deepEqual([gated.model, gated.moves, gated.posts.length], [false, [], 1]);
  const past = await deliver({ text: `<@U0FACTORY> plan ${KEY}`, status: "In Progress" });
  assert.deepEqual([past.model, past.moves], [false, []]);
  assert.match(past.posts[0]!, /is In Progress, past planning/);
});

test("@factory retry KEY with a labeled mention takes the host path and posts the planner crumb", async () => {
  const { model, moves, posts, crumbs } = await deliver({ text: `<@U0FACTORY|factory> retry ${KEY}`, status: "Triaged" });
  assert.equal(model, false, "no model turn");
  assert.deepEqual(moves, ["Triaged → To Do", "To Do → Triaged"]);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /^Started a fresh planning run for TLSSN-42\./);
  assert.deepEqual(crumbs, [CRUMB]);
});

test("@factory retry KEY inside the plan hop's deadline says so once and makes sure the crumb is showing", async () => {
  const now = Date.now();
  const kv = { ...structuredClone(BOUND), [hopWatchKey(KEY)]: { hop: "plan", since: new Date(now).toISOString(), dueAt: new Date(now + 10 * 60_000).toISOString(), changelogId: "6001" } };
  const { model, moves, posts, crumbs } = await deliver({ text: `<@U0FACTORY|factory> retry ${KEY}`, status: "Triaged", kv });
  assert.equal(model, false);
  assert.deepEqual(moves, []);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /^The planner still has about 10 minutes/);
  assert.deepEqual(crumbs, [CRUMB]);
});

test("ensureLoader keeps a planner crumb but replaces another phase's leftover one", async () => {
  const kv: Record<string, unknown> = { ...structuredClone(BOUND), [loaderKey(KEY)]: { channel: THREAD.channelId, ts: "1758510002.000100", phase: "replanning" } };
  const store = { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] };
  const updates: unknown[] = [];
  const client = { apiCall: async (method: string, args: Record<string, unknown>) => (updates.push({ method, text: args["text"] }), { ok: true, ts: "1758510005.000100" }) };
  assert.equal(await ensureLoader({ kv: store as never, client, issueKey: KEY, phase: "planning" }), "unchanged");
  kv[loaderKey(KEY)] = { channel: THREAD.channelId, ts: "1758510002.000100", phase: "implementing" };
  assert.equal(await ensureLoader({ kv: store as never, client, issueKey: KEY, phase: "planning" }), "posted");
  assert.deepEqual(updates, [{ method: "chat.update", text: CRUMB }]);
});

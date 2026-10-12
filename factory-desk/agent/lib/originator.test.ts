import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, HostMcpToolInfo } from "@cursor/july";
import { resetExternalSenderCache, type SlackBinding, type SlackMessage } from "@cursor/july/channels/slack";
import approveTicket from "../tools/approve_ticket.js";
import denyTicket from "../tools/deny_ticket.js";
import fileTicket from "../tools/file_ticket.js";
import requestPlan from "../tools/request_plan.js";
import { announceApproved, announcePlan, announceProgress } from "./announce.js";
import { KV_BACKENDS, removeKvRoots } from "./kv-backends.fixtures.js";
import { VERIFY_ATTEMPTS } from "./kv-verified.js";
import { DIGEST_COMMENT } from "./plan-comment.fixtures.js";
import { ANNOUNCE_LEASE_MS, BINDING_RETRY_MS, ROOT_LEASE_MS } from "./ticket-thread.js";
import { checkOriginator, commandKey, compareSlackTs, gateCommand, MAX_RECORDED_COMMANDS, parseCommands, recordingSpeakers, speakerKey } from "./originator.js";

const ENV = ["FACTORY_DESK_JIRA_PROJECT", "FACTORY_JIRA_PROJECTS", "FACTORY_DESK_INTAKE_CHANNEL", "JIRA_CLOUD_ID", "FACTORY_DESK_CLAIM_SETTLE_MS"] as const;
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.FACTORY_DESK_JIRA_PROJECT = "TLSSN";
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
});

after(async () => {
  await removeKvRoots();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const ALICE = "U0ALICE01";
const BOB = "U0BOB0001";
const THREAD = { channelId: "C0123ABCD", threadTs: "1758510000.123456" };
const OTHER_THREAD = { channelId: "C0123ABCD", threadTs: "1758519999.000001" };
const INTAKE_ROOT_TS = "1758510001.000100";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Another opener's intake-root claim, written `ageMs` ago by the wall clock. */
function rootLease(owner: string, ageMs: number): Record<string, unknown> {
  return { channelId: "C0INTAKE01", root: "jira", state: "pending", owner, at: new Date(Date.now() - ageMs).toISOString() };
}

const TOOLS: HostMcpToolInfo[] = [
  { name: "createJiraIssue", inputSchema: { type: "object", properties: { projectKey: {}, summary: {}, description: {}, issueTypeName: {} } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { cloudId: {}, issueIdOrKey: {} } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: {}, issueIdOrKey: {}, transition: {} } } },
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { cloudId: {}, issueIdOrKey: {} } } },
  { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { cloudId: {}, issueIdOrKey: {}, comment: {} } } },
  { name: "getJiraIssueComments", inputSchema: { type: "object", properties: { issueIdOrKey: {} } } },
];

function json(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

type Desk = {
  kv: Record<string, unknown>;
  store: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
  posts: Record<string, unknown>[];
  sentTs: string[];
  updates: Record<string, unknown>[];
  deleted: Record<string, unknown>[];
  jira: string[];
  tags: Record<string, unknown>[];
  as: (input: { thread?: { channelId: string; threadTs: string }; starter?: string }) => never;
};

// One desk: shared kv, Slack posts, and Jira calls across tool contexts.
type DeskOptions = {
  status?: string;
  deleteThrows?: boolean;
  putThrows?: (key: string, value: unknown) => boolean;
  /** The put is applied, then the call still throws, as when the response is lost. */
  putAppliesThenThrows?: (key: string, value: unknown) => boolean;
  getThrows?: (key: string) => boolean;
  onRootPost?: (kv: Record<string, unknown>) => void;
  rootPostThrows?: boolean;
  onUpdate?: (kv: Record<string, unknown>, args: Record<string, unknown>) => void;
  onChatDelete?: (kv: Record<string, unknown>) => void;
};

function desk(kv: Record<string, unknown> = {}, options: DeskOptions = {}): Desk {
  const posts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const deleted: Record<string, unknown>[] = [];
  const sentTs: string[] = [];
  const jira: string[] = [];
  const tags: Record<string, unknown>[] = [];
  const store = {
    get: async (key: string) => {
      if (options.getThrows?.(key) === true) throw new Error("kv get refused");
      return kv[key];
    },
    put: async (key: string, value: unknown) => {
      if (options.putThrows?.(key, value) === true) throw new Error("kv put refused");
      kv[key] = value;
      if (options.putAppliesThenThrows?.(key, value) === true) throw new Error("kv put response lost");
    },
    delete: async (key: string) => {
      if (options.deleteThrows === true) throw new Error("kv delete refused");
      delete kv[key];
    },
  };
  const host = {
    kv: store,
    otel: { setAttributes: (attributes: Record<string, unknown>) => void tags.push(attributes) },
    slack: {
      getClient: async () => ({
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            posts.push(args);
            const root = posts.length === 1 && args["thread_ts"] === undefined;
            if (root) options.onRootPost?.(kv);
            if (root && options.rootPostThrows === true) throw new Error("slack down");
            const ts = root ? INTAKE_ROOT_TS : `1758510002.00010${posts.length}`;
            sentTs.push(ts);
            return { ok: true, ts };
          },
          update: async (args: Record<string, unknown>) => {
            updates.push(args);
            options.onUpdate?.(kv, args);
            return { ok: true };
          },
          delete: async (args: Record<string, unknown>) => {
            deleted.push(args);
            options.onChatDelete?.(kv);
            return { ok: true };
          },
        },
      }),
    },
    mcp: {
      names: () => ["tracker"],
      listTools: async () => TOOLS,
      callTool: async (_c: string, tool: string): Promise<HostMcpCallResult> => {
        jira.push(tool);
        switch (tool) {
          case "createJiraIssue":
            return json({ key: "TLSSN-42", self: "https://x.atlassian.net/browse/TLSSN-42" });
          case "getTransitionsForJiraIssue":
            return json({ transitions: [{ id: "11", name: "Start triage", to: { name: "Triaged" } }, { id: "31", name: "Approve", to: { name: "Approved" } }] });
          case "getJiraIssue":
            return json({ key: "TLSSN-42", fields: { status: { name: options.status ?? "Planned" } } });
          case "getJiraIssueComments":
            return json({ comments: [{ id: "10077", body: DIGEST_COMMENT }, { id: "10078", body: "Implementing: https://cursor.com/agents/bc-1234" }] });
          default:
            return json({});
        }
      },
    },
  };
  const as: Desk["as"] = ({ thread, starter }) => {
    const attributes: Record<string, string> = {};
    if (thread !== undefined) Object.assign(attributes, { channel_id: thread.channelId, thread_ts: thread.threadTs });
    if (starter !== undefined) attributes["user_id"] = starter;
    const auth = thread === undefined ? null : { authenticator: "slack", principalId: "slack:T:thread", principalType: "user", attributes };
    return { session: { id: "ses_1", channelId: "slack", mode: "chat", purpose: "live", auth, continuationKey: null }, now: () => new Date("2026-09-23T00:00:00.000Z"), host } as never;
  };
  return { kv, store, posts, sentTs, updates, deleted, jira, tags, as };
}

const NOW_S = Date.parse("2026-09-23T00:00:00.000Z") / 1000;

function ago(seconds: number): string {
  return `${NOW_S - seconds}.000100`;
}

function said(thread: { channelId: string; threadTs: string }, userId: string, command?: string, secondsAgo = 50): Record<string, unknown> {
  const spoken = { userId, ts: ago(secondsAgo) };
  const [verb, target] = command?.split(" ") ?? [];
  return {
    [speakerKey(thread)]: spoken,
    ...(verb === undefined || target === undefined ? {} : { [commandKey(thread, { verb: verb as never, target })]: spoken }),
  };
}

const SLACK_TICKET = { "ticket/TLSSN-42": { ...THREAD, originatorUserId: ALICE } };
const JIRA_TICKET = { "ticket/TLSSN-42": { channelId: "C0INTAKE01", threadTs: INTAKE_ROOT_TS, root: "jira" } };
const PLANNED_ROOT_BINDING = {
  channelId: "C0INTAKE01",
  threadTs: INTAKE_ROOT_TS,
  root: "jira",
  boundAt: "2026-09-23T00:00:00.000Z",
  rootStatus: { status: "Planned", rank: 1, changelogId: "1" },
};

const TEAM = "T0DESK0001";

/**
 * The binding a Slack inbound handler gets: this thread, this workspace,
 * and a users.info that places each user in TEAM unless listed as external.
 */
function slackBinding(kv: unknown, options: { external?: string[]; usersInfo?: string[] } = {}): SlackBinding {
  resetExternalSenderCache();
  const client = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      options.usersInfo?.push(String(args["user"]));
      if (method !== "users.info") throw new Error(`unexpected ${method}`);
      const user = String(args["user"]);
      return { ok: true, user: { id: user, team_id: options.external?.includes(user) === true ? "T0CONNECT1" : TEAM } };
    },
  };
  return { slack: { channelId: THREAD.channelId, threadTs: THREAD.threadTs, teamId: TEAM }, host: { kv, slack: { getClient: async () => client } } } as unknown as SlackBinding;
}

function slackMessage(ts: string, text: string, author: SlackMessage["author"]): SlackMessage {
  return { text, body: text, markdown: text, ts, threadTs: THREAD.threadTs, channelId: THREAD.channelId, teamId: TEAM, ...(author === undefined ? {} : { author }) };
}

test("commands parse from a raw mention in any case, one per verb and target", () => {
  assert.deepEqual(parseCommands("<@U0DESK> Approve tlssn-42 please, then approve file. deny TLSSN-7 replan TLSSN-7 plan TLSSN-8 approve TLSSN-42"), [
    { verb: "approve", target: "TLSSN-42" },
    { verb: "approve", target: "file" },
    { verb: "deny", target: "TLSSN-7" },
    { verb: "replan", target: "TLSSN-7" },
    { verb: "plan", target: "TLSSN-8" },
  ]);
  assert.deepEqual(parseCommands("build it, approved, disapprove"), []);
  assert.deepEqual(parseCommands("approve TLSSN-19"), [{ verb: "approve", target: "TLSSN-19" }]);
});

test("a negated command is not a command", () => {
  assert.deepEqual(parseCommands("<@U0DESK> do NOT approve TLSSN-42 until Bob has reviewed"), []);
  assert.deepEqual(parseCommands("please don't deny TLSSN-7. never replan TLSSN-8"), []);
  assert.deepEqual(parseCommands("not sure yet. approve TLSSN-42"), [{ verb: "approve", target: "TLSSN-42" }]);
});

test("the inbound handler records each human author and command before the turn, and skips bots", async () => {
  const kv: Record<string, unknown> = {};
  const host = { kv: { get: async (k: string) => kv[k], put: async (k: string, v: unknown) => void (kv[k] = v), delete: async (k: string) => void delete kv[k] } };
  const decisions: string[] = [];
  const handler = recordingSpeakers(async (_ctx, message) => {
    decisions.push(message.ts);
    return { auth: null };
  });
  const binding = slackBinding(host.kv);
  const message = slackMessage;

  await handler(binding, message("1758510010.000100", "<@U0DESK> approve TLSSN-42", { userId: ALICE, userName: "alice", isBot: false }));
  await handler(binding, message("1758510011.000100", "nice", { userId: BOB, userName: "bob", isBot: false }));
  await handler(binding, message("1758510012.000100", "approve TLSSN-99", { userId: "B0BOT0001", userName: "bot", isBot: true }));
  assert.deepEqual(kv, {
    [speakerKey(THREAD)]: { userId: BOB, ts: "1758510011.000100" },
    [commandKey(THREAD, { verb: "approve", target: "TLSSN-42" })]: { userId: ALICE, ts: "1758510010.000100" },
  });
  assert.deepEqual(decisions, ["1758510010.000100", "1758510011.000100", "1758510012.000100"]);

  const broken = recordingSpeakers(async () => ({ auth: null }));
  const down = slackBinding({ put: async () => Promise.reject(new Error("kv down")) });
  assert.deepEqual(await broken(down, message("1758510013.000100", "approve TLSSN-42", { userId: ALICE, userName: "alice", isBot: false })), { auth: null });
});

test("checkOriginator: the filer in the ticket thread passes; anyone else, any other thread, or a Jira ticket is refused", () => {
  const ticket = { ...THREAD, originatorUserId: ALICE };
  assert.deepEqual(checkOriginator({ ticket, thread: THREAD, callerUserId: ALICE }), { status: "ok", originatorUserId: ALICE });
  assert.deepEqual(checkOriginator({ ticket, thread: THREAD, callerUserId: BOB }), { status: "not_originator", originatorUserId: ALICE, callerUserId: BOB });
  assert.deepEqual(checkOriginator({ ticket, thread: THREAD }), { status: "not_originator", originatorUserId: ALICE });
  assert.deepEqual(checkOriginator({ ticket, thread: OTHER_THREAD, callerUserId: ALICE }), { status: "wrong_thread", originatorUserId: ALICE, ticketThread: THREAD });
  assert.deepEqual(checkOriginator({ ticket, callerUserId: ALICE }), { status: "wrong_thread", originatorUserId: ALICE, ticketThread: THREAD });
  assert.deepEqual(checkOriginator({ ticket: { channelId: "C0INTAKE01", threadTs: INTAKE_ROOT_TS }, thread: THREAD, callerUserId: ALICE }), { status: "jira_only" });
  assert.deepEqual(checkOriginator({ thread: THREAD, callerUserId: ALICE }), { status: "jira_only" });
});

test("approve_ticket: the originator in the ticket thread moves the card", async () => {
  const d = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42") });
  const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(result["approved"], true);
  assert.deepEqual(d.jira, ["getJiraIssue", "getTransitionsForJiraIssue", "getJiraIssue", "transitionJiraIssue"]);
  assert.deepEqual(d.kv[commandKey(THREAD, { verb: "approve", target: "TLSSN-42" })], { ts: ago(50), consumedAt: "2026-09-23T00:00:00.000Z" });
  assert.deepEqual(d.tags, [{ "factory.ticket.key": "TLSSN-42" }], "approve_ticket tags the turn with its ticket on entry (hooks/ticket-key.ts)");
});

test("approve_ticket: another user in the ticket thread is refused without touching Jira, whoever opened the session", async () => {
  const d = desk({ ...SLACK_TICKET, ...said(THREAD, BOB, "approve TLSSN-42") });
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE })), {
    approved: false,
    issueKey: "TLSSN-42",
    transition: "skipped",
    status: "not_originator",
    reason: "not_originator",
    originatorUserId: ALICE,
  });
  assert.deepEqual(d.jira, []);
});

test("approve_ticket: the originator's command is used once", async () => {
  const d = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42") });
  const first = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(first["approved"], true);
  const second = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(second["status"], "not_originator");
  assert.deepEqual(d.jira, ["getJiraIssue", "getTransitionsForJiraIssue", "getJiraIssue", "transitionJiraIssue"]);
});

test("approve_ticket: an earlier 'do NOT approve' from the originator does not approve a later turn from someone else", async () => {
  const d = desk({ ...SLACK_TICKET });
  const handler = recordingSpeakers(async () => ({ auth: null }));
  const binding = slackBinding(d.store);
  const message = (ts: string, text: string, userId: string): SlackMessage => slackMessage(ts, text, { userId, userName: userId, isBot: false });
  await handler(binding, message(ago(300), "<@U0DESK> do NOT approve TLSSN-42 until Bob has reviewed", ALICE));
  await handler(binding, message(ago(60), "<@U0DESK> looks good to me, go ahead and approve it", BOB));
  const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(result["approved"], false);
  assert.equal(result["status"], "not_originator");
  assert.deepEqual(d.jira, []);
});

test("approve_ticket: an old command from the originator is stale, whoever speaks next", async () => {
  const bobNext = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42", 20 * 60), ...said(THREAD, BOB, undefined, 30) });
  const aliceOnly = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42", 20 * 60) });
  for (const d of [bobNext, aliceOnly]) {
    const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
    assert.equal(result["status"], "not_originator");
    assert.deepEqual(d.jira, []);
  }
});

test("approve_ticket: someone else speaking after the originator's command voids it", async () => {
  const d = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42", 90), ...said(THREAD, BOB, undefined, 30) });
  const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(result["status"], "not_originator");
  assert.deepEqual(d.jira, []);
});

test("approve_ticket: the originator in another thread is refused without naming the ticket's thread or filer", async () => {
  const d = desk({ ...SLACK_TICKET, ...said(OTHER_THREAD, ALICE, "approve TLSSN-42") });
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: OTHER_THREAD, starter: ALICE })), {
    approved: false,
    issueKey: "TLSSN-42",
    transition: "skipped",
    status: "wrong_thread",
    reason: "wrong_thread",
  });
  assert.deepEqual(d.jira, []);
});

test("a ticket filed in Jira is refused in Slack for approve, deny, and replan, even in its own thread", async () => {
  const root = { channelId: "C0INTAKE01", threadTs: INTAKE_ROOT_TS };
  const d = desk({ ...JIRA_TICKET, ...said(root, ALICE, "approve TLSSN-42") });
  const ctx = d.as({ thread: root, starter: ALICE });
  const approved = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, ctx)) as Record<string, unknown>;
  const denied = (await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice" } as never, ctx)) as Record<string, unknown>;
  const replanned = (await requestPlan.execute!({ issueKey: "TLSSN-42", replan: true } as never, ctx)) as Record<string, unknown>;
  for (const result of [approved, denied, replanned]) assert.equal(result["status"], "jira_only");
  assert.deepEqual(d.tags, Array(3).fill({ "factory.ticket.key": "TLSSN-42" }), "approve, deny and replan each tag the turn with their ticket before the gate, refused or not");
  assert.match(String(approved["howToApprove"]), /Approved in Jira/);
  assert.equal(replanned["howToApprove"], undefined);
  assert.match(String(replanned["howToPlan"]), /plan/i);
  assert.deepEqual(d.jira, []);

  const unbound = desk();
  assert.equal(((await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, unbound.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>)["status"], "jira_only");
  assert.deepEqual(unbound.jira, []);
});

test("deny_ticket and request_plan follow the same gate; a first plan KEY on an unbound ticket stays open", async () => {
  const bob = desk({ ...SLACK_TICKET, ...said(THREAD, BOB, "deny TLSSN-42") });
  assert.equal(((await denyTicket.execute!({ issueKey: "TLSSN-42" } as never, bob.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>)["status"], "not_originator");
  const replan = desk({ ...SLACK_TICKET, ...said(THREAD, BOB, "plan TLSSN-42") });
  assert.equal(((await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, replan.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>)["status"], "not_originator");
  assert.deepEqual([...bob.jira, ...replan.jira], []);

  const alice = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "deny TLSSN-42") });
  assert.equal(((await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice" } as never, alice.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>)["denied"], true);

  const open = desk({}, { status: "To Do" });
  const planned = (await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, open.as({ thread: THREAD, starter: BOB }))) as Record<string, unknown>;
  assert.equal(planned["requested"], true);
});

test("request_plan on an unbound ticket past To Do is refused, so nobody can bounce its plan from Slack", async () => {
  for (const status of ["Planned", "Approved", "In Progress"]) {
    const d = desk(said(THREAD, BOB, "plan TLSSN-42"), { status });
    const result = (await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: BOB }))) as Record<string, unknown>;
    assert.equal(result["requested"], false, status);
    assert.equal(result["status"], "jira_only", status);
    assert.equal(result["howToApprove"], undefined, status);
    assert.match(String(result["howToPlan"]), /plan/i, status);
    assert.equal(d.jira.includes("transitionJiraIssue"), false, status);
  }
});

test("a Slack-filed ticket binds the thread and the approve-file speaker, and every announce replies in that thread", async () => {
  const d = desk(said(THREAD, BOB, "approve file"));
  const filed = (await fileTicket.execute!({ title: "CSV export 500", description: "Asked by Bob.", kind: "bug" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(filed["originatorUserId"], BOB);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], { ...THREAD, originatorUserId: BOB, filedAt: "2026-09-23T00:00:00.000Z" });

  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  try {
    await announcePlan({ issueKey: "TLSSN-42", title: "CSV export 500", changelogId: "1", tracker: "transitioned" } as never, d.as({}));
    await announcePlan({ issueKey: "TLSSN-42", title: "CSV export 500", changelogId: "2", tracker: "transitioned" } as never, d.as({}));
    await announceApproved({ issueKey: "TLSSN-42", changelogId: "4" } as never, d.as({}));
    await announceProgress({ issueKey: "TLSSN-42", changelogId: "3" } as never, d.as({}));
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
  }
  assert.deepEqual(d.posts.map((post) => [post["channel"], post["thread_ts"]]), [
    [THREAD.channelId, THREAD.threadTs],
    [THREAD.channelId, THREAD.threadTs],
    [THREAD.channelId, THREAD.threadTs],
  ]);
  assert.match(String(d.posts[0]?.["text"]), new RegExp(`^<@${BOB}> TLSSN-42 is planned`));
  assert.deepEqual(d.updates, []);

});

test("file_ticket binds no originator without a fresh approve file record, not the thread opener", async () => {
  for (const kv of [{}, said(THREAD, BOB, "approve file", 20 * 60), { ...said(THREAD, BOB, "approve file", 90), ...said(THREAD, ALICE, undefined, 30) }]) {
    const d = desk(kv);
    const filed = (await fileTicket.execute!({ title: "x", description: "y", kind: "bug" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
    assert.equal(filed["created"], true);
    assert.equal(filed["originatorUserId"], undefined);
    const approve = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, desk({ "ticket/TLSSN-42": d.kv["ticket/TLSSN-42"], ...said(THREAD, ALICE, "approve TLSSN-42") }).as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
    assert.equal(approve["status"], "jira_only");
  }
});

test("a Slack filing that binds while the intake root is being posted leaves no orphan root, and the plan goes to the Slack thread", async () => {
  const d = desk({}, { onRootPost: (kv) => void (kv["ticket/TLSSN-42"] = { ...THREAD, originatorUserId: ALICE, filedAt: "2026-09-23T00:00:00.000Z" }) });
  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  try {
    await announcePlan({ issueKey: "TLSSN-42", title: "Retry CSV export", changelogId: "1", tracker: "transitioned" } as never, d.as({}));
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
  }
  assert.deepEqual(standingRoots(d), []);
  assert.equal(d.posts.at(-1)?.["thread_ts"], THREAD.threadTs);
  assert.equal(d.posts.at(-1)?.["channel"], THREAD.channelId);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], { ...THREAD, originatorUserId: ALICE, filedAt: "2026-09-23T00:00:00.000Z" });
});

test("while another update is opening the intake root, a second update posts no root of its own and replies under the first", async () => {
  const d = desk();
  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  try {
    const first = announcePlan({ issueKey: "TLSSN-42", title: "Retry CSV export", changelogId: "1", tracker: "transitioned" } as never, d.as({}));
    const second = announceApproved({ issueKey: "TLSSN-42", changelogId: "2", title: "Retry CSV export" } as never, d.as({}));
    await Promise.all([first, second]);
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
  }
  const roots = standingRoots(d);
  assert.equal(roots.length, 1);
  assert.deepEqual(
    d.posts.filter((post) => post["thread_ts"] !== undefined).map((post) => post["thread_ts"]),
    [roots[0], roots[0]]
  );
});

function standingRoots(d: Desk): string[] {
  const deleted = new Set(d.deleted.map((entry) => entry["ts"]));
  return d.posts.flatMap((post, index) => (post["thread_ts"] === undefined && !deleted.has(d.sentTs[index]) ? [d.sentTs[index]!] : []));
}

test("a Jira-filed ticket opens a short root in the intake channel; the full plan is its first reply, and later updates reuse it", async () => {
  const d = desk();
  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  process.env.JIRA_CLOUD_ID = "https://x.atlassian.net";
  let plan: Record<string, unknown> = {};
  try {
    plan = (await announcePlan({ issueKey: "TLSSN-42", title: "Retry CSV export", changelogId: "1", tracker: "transitioned" } as never, d.as({}))) as Record<string, unknown>;
    await announceApproved({ issueKey: "TLSSN-42", changelogId: "2", title: "Retry CSV export" } as never, d.as({}));
    await announceProgress({ issueKey: "TLSSN-42", changelogId: "3", title: "Retry CSV export" } as never, d.as({}));
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
    delete process.env.JIRA_CLOUD_ID;
  }
  assert.deepEqual(d.posts.map((post) => [post["channel"], post["thread_ts"]]), [
    ["C0INTAKE01", undefined],
    ["C0INTAKE01", INTAKE_ROOT_TS],
    ["C0INTAKE01", INTAKE_ROOT_TS],
    ["C0INTAKE01", INTAKE_ROOT_TS],
  ]);
  assert.equal(plan["rootTs"], INTAKE_ROOT_TS);
  assert.equal(
    d.posts[0]?.["text"],
    "TLSSN-42: Retry CSV export\nStatus: *Planned*  \u00b7  <https://x.atlassian.net/browse/TLSSN-42|TLSSN-42 on Jira>\nFiled in Jira, not from Slack. Approve, replan, or retry it on the Jira board."
  );
  assert.doesNotMatch(JSON.stringify(d.posts[0]), /Brief|Approach|approve TLSSN-42/);
  const fullPlan = String(d.posts[1]?.["text"]);
  assert.match(fullPlan, /^TLSSN-42 is planned: Retry CSV export\./);
  assert.match(fullPlan, /\nApproach: RowSource reports an explicit empty outcome/);
  assert.doesNotMatch(fullPlan, /Implement Jira TLSSN-42/, "the worker brief stays on the Plan comment");
  assert.match(fullPlan, /was filed in Jira: to start the build, move the card to Approved in Jira\./);
  assert.doesNotMatch(fullPlan, /`approve TLSSN-42`/);
  assert.equal(d.posts[2]?.["text"], "TLSSN-42 is Approved.");
  assert.equal(d.posts[3]?.["text"], `TLSSN-42 is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: https://cursor.com/agents/bc-1234`);
  assert.deepEqual(
    d.updates.map((update) => [update["channel"], update["ts"], /Status: \*([^*]+)\*/.exec(String(update["text"]))?.[1]]),
    [
      ["C0INTAKE01", INTAKE_ROOT_TS, "Approved"],
      ["C0INTAKE01", INTAKE_ROOT_TS, "In Progress"],
    ]
  );
  assert.deepEqual(d.kv["ticket/TLSSN-42"], {
    channelId: "C0INTAKE01",
    threadTs: INTAKE_ROOT_TS,
    root: "jira",
    boundAt: "2026-09-23T00:00:00.000Z",
    rootStatus: { status: "In Progress", rank: 3, changelogId: "3" },
  });

  const approve = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: { channelId: "C0INTAKE01", threadTs: INTAKE_ROOT_TS }, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(approve["status"], "jira_only");
});

async function inbound(d: Desk, lines: [secondsAgo: number, userId: string, text: string][]): Promise<void> {
  const handler = recordingSpeakers(async () => ({ auth: null }));
  const binding = slackBinding(d.store);
  for (const [secondsAgo, userId, text] of lines) {
    await handler(binding, slackMessage(ago(secondsAgo), text, { userId, userName: userId, isBot: false }));
  }
}

async function announceIntakePlan(d: Desk): Promise<Record<string, unknown>> {
  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  try {
    return (await announcePlan({ issueKey: "TLSSN-42", title: "Retry CSV export", changelogId: "1", tracker: "transitioned" } as never, d.as({}))) as Record<string, unknown>;
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
  }
}

test("approve_ticket: the filer's earlier command-shaped question does not vouch once she says something else", async () => {
  const d = desk({ ...SLACK_TICKET });
  await inbound(d, [
    [300, ALICE, "<@U0DESK> how do I approve TLSSN-42?"],
    [200, BOB, "<@U0DESK> go ahead and approve it"],
    [30, ALICE, "<@U0DESK> thanks"],
  ]);
  const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(result["status"], "not_originator");
  assert.deepEqual(d.jira, []);
});

const APPROVE_KEY = commandKey(THREAD, { verb: "approve", target: "TLSSN-42" });

/** After the gate's first read of the command record, run `land` once before anything else reads it. */
function afterCommandRead(d: Desk, land: () => Promise<void>): void {
  const read = d.store.get;
  let landed = false;
  d.store.get = async (key: string) => {
    const value = await read(key);
    if (key === APPROVE_KEY && !landed) {
      landed = true;
      await land();
    }
    return value;
  };
}

test("approve_ticket: a newer command that lands between the gate's read and its consume survives, and vouches on the next turn", async () => {
  const d = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42", 50) });
  afterCommandRead(d, () => inbound(d, [[20, ALICE, "<@U0DESK> approve TLSSN-42"]]));
  const first = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(first["status"], "not_originator");
  assert.deepEqual(d.jira, []);
  assert.deepEqual(d.kv[APPROVE_KEY], { userId: ALICE, ts: ago(20) });
  const next = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(next["approved"], true);
  assert.deepEqual(d.kv[APPROVE_KEY], { ts: ago(20), consumedAt: "2026-09-23T00:00:00.000Z" });
});

test("concurrent openers: of two turns that resolved one command, the one that consumes second is refused and moves nothing", async () => {
  const d = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42") });
  let other: Record<string, unknown> = {};
  afterCommandRead(d, async () => {
    other = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  });
  const second = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(other["approved"], true);
  assert.equal(second["status"], "not_originator");
  assert.equal(d.jira.filter((call) => call === "transitionJiraIssue").length, 1);
});

test("approve_ticket: a tombstone that cannot be written refuses the turn and deletes only the record it resolved, never a newer one; one that can be neither tombstoned nor deleted does not vouch", async () => {
  let down = true;
  const newer = { userId: ALICE, ts: ago(20) };
  const raced = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42", 50) }, { putThrows: (key) => down && key.startsWith("command/") });
  afterCommandRead(raced, async () => {
    raced.kv[APPROVE_KEY] = newer;
    raced.kv[speakerKey(THREAD)] = newer;
  });
  const first = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, raced.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(first["status"], "not_originator");
  assert.deepEqual(raced.kv[APPROVE_KEY], newer);
  down = false;
  const next = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, raced.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(next["approved"], true);

  const otherAuthor = { userId: BOB, ts: ago(50) };
  const sameTs = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42", 50) });
  afterCommandRead(sameTs, async () => void (sameTs.kv[APPROVE_KEY] = otherAuthor));
  await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, sameTs.as({ thread: THREAD, starter: ALICE }));
  assert.deepEqual(sameTs.kv[APPROVE_KEY], otherAuthor, "the resolved record is matched by author as well as ts");

  const alone = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42") }, { putThrows: (key) => key.startsWith("command/") });
  const refused = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, alone.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(refused["status"], "not_originator");
  assert.equal(alone.kv[APPROVE_KEY], undefined);
  assert.deepEqual(alone.jira, []);

  const stuck = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42") }, { deleteThrows: true, putThrows: (key) => key.startsWith("command/") });
  const neither = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, stuck.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(neither["status"], "not_originator");
  assert.deepEqual(stuck.jira, []);
});

test("an abandoned pre-lease intake-root placeholder older than a minute is reclaimed, and the update opens the root", async () => {
  const d = desk({ "ticket/TLSSN-42": { channelId: "C0INTAKE01", root: "jira", pendingRoot: "crashed-pod", boundAt: "2026-09-22T23:58:00.000Z" } });
  await announceIntakePlan(d);
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.equal(d.posts.at(-1)?.["thread_ts"], INTAKE_ROOT_TS);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], PLANNED_ROOT_BINDING);
});

test("a root claim that never resolves does not drop the update: once its lease expires, the update opens the root", async () => {
  const d = desk({ "ticket/TLSSN-42": rootLease("slow-pod", ROOT_LEASE_MS - 1500) });
  const announcing = announceIntakePlan(d);
  await sleep(500);
  assert.deepEqual(d.posts, []);
  await announcing;
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.equal(d.posts.at(-1)?.["thread_ts"], INTAKE_ROOT_TS);
  assert.equal((d.kv["ticket/TLSSN-42"] as Record<string, unknown>)["threadTs"], INTAKE_ROOT_TS);
});

test("a Slack-filed ticket with no recorded filer is not described as filed in Jira", async () => {
  const d = desk();
  await fileTicket.execute!({ title: "CSV export 500", description: "y", kind: "bug" } as never, d.as({ thread: THREAD, starter: ALICE }));
  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  try {
    await announcePlan({ issueKey: "TLSSN-42", title: "CSV export 500", changelogId: "1", tracker: "transitioned" } as never, d.as({}));
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
  }
  const plan = JSON.stringify(d.posts[0]);
  assert.doesNotMatch(plan, /filed in Jira/);
  assert.match(plan, /no Slack approver/);
  const refused = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, desk({ "ticket/TLSSN-42": d.kv["ticket/TLSSN-42"], ...said(THREAD, ALICE, "approve TLSSN-42") }).as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(refused["status"], "jira_only");
  assert.doesNotMatch(String(refused["howToApprove"]), /filed in Jira/);
});

function failingReads(key: string, count: number): (k: string) => boolean {
  let left = count;
  return (k) => {
    if (k !== key || left === 0) return false;
    left -= 1;
    return true;
  };
}

const ALICE_BINDING = { ...THREAD, originatorUserId: ALICE, filedAt: "2026-09-22T12:00:00.000Z" };

test("a kv read error on a Slack-filed ticket's binding fails the update: no root, no rebinding, no announce claim left", async () => {
  const d = desk({ "ticket/TLSSN-42": ALICE_BINDING }, { getThrows: failingReads("ticket/TLSSN-42", 2) });
  await assert.rejects(announceIntakePlan(d));
  assert.deepEqual(d.posts, []);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], ALICE_BINDING);
  assert.deepEqual(Object.keys(d.kv).filter((key) => key.startsWith("announced/")), []);
  const approve = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, desk({ ...d.kv, ...said(THREAD, ALICE, "approve TLSSN-42") }).as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(approve["approved"], true);
});

test("a kv read error on the ticket binding refuses approve, deny, and plan as unavailable, without touching Jira", async () => {
  const always = (key: string) => key === "ticket/TLSSN-42";
  const alice = desk({ "ticket/TLSSN-42": ALICE_BINDING, ...said(THREAD, ALICE, "approve TLSSN-42") }, { getThrows: always, status: "To Do" });
  const bob = desk({ "ticket/TLSSN-42": ALICE_BINDING, ...said(OTHER_THREAD, BOB, "plan TLSSN-42") }, { getThrows: always, status: "To Do" });
  const results = [
    (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, alice.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>,
    (await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice" } as never, alice.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>,
    (await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, bob.as({ thread: OTHER_THREAD, starter: BOB }))) as Record<string, unknown>,
  ];
  for (const result of results) assert.equal(result["status"], "unavailable");
  assert.deepEqual([...alice.jira, ...bob.jira], []);
});

test("a binding write that keeps failing deletes the new root and fails the update, leaving nothing behind", async () => {
  const d = desk({}, { putThrows: (key, value) => key === "ticket/TLSSN-42" && (value as Record<string, unknown>)["threadTs"] !== undefined });
  await assert.rejects(announceIntakePlan(d));
  assert.deepEqual(standingRoots(d), []);
  assert.equal(d.kv["ticket/TLSSN-42"], undefined);
  assert.deepEqual(Object.keys(d.kv).filter((key) => key.startsWith("announced/")), []);
});

test("a binding write that keeps failing pauses only BINDING_RETRY_MS (3.85 s), not kv-verified's own pauses as well", async () => {
  const d = desk({}, { putThrows: (key, value) => key === "ticket/TLSSN-42" && (value as Record<string, unknown>)["threadTs"] !== undefined });
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const savedPauses = process.env.FACTORY_KV_RETRY_PAUSES_MS;
  delete process.env.FACTORY_KV_RETRY_PAUSES_MS;
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "0";
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    setImmediate(handler);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    await assert.rejects(announceIntakePlan(d));
  } finally {
    globalThis.setTimeout = realSetTimeout;
    process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
    if (savedPauses !== undefined) process.env.FACTORY_KV_RETRY_PAUSES_MS = savedPauses;
  }
  const paused = delays.filter((ms) => ms > 0);
  assert.deepEqual(paused, [...BINDING_RETRY_MS]);
  let total = 0;
  for (const ms of paused) total += ms;
  assert.equal(total, 3850);
});

test("a binding write retried after a kv error does not overwrite a Slack filing that landed meanwhile", async () => {
  const opts: DeskOptions = {};
  const d = desk({}, opts);
  opts.onRootPost = (kv) => {
    kv["ticket/TLSSN-42"] = ALICE_BINDING;
    opts.getThrows = failingReads("ticket/TLSSN-42", 1);
  };
  await announceIntakePlan(d);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], ALICE_BINDING);
  assert.deepEqual(standingRoots(d), []);
  assert.equal(d.posts.at(-1)?.["thread_ts"], THREAD.threadTs);
});

test("a live root claim is not taken over just because its announce started over a minute before this one", async () => {
  const d = desk({ "ticket/TLSSN-42": rootLease("live-pod", 0) });
  setTimeout(() => {
    d.kv["ticket/TLSSN-42"] = { channelId: "C0INTAKE01", threadTs: "1758510009.000100", root: "jira", boundAt: "2026-09-22T23:58:59.000Z" };
  }, 50);
  await announceIntakePlan(d);
  assert.deepEqual(standingRoots(d), []);
  assert.equal(d.posts.at(-1)?.["thread_ts"], "1758510009.000100");
});

test("a binding put that lands but reports an error keeps the root it bound, and threads the plan under it", async () => {
  let lost = false;
  const d = desk({}, {
    putAppliesThenThrows: (key, value) => {
      if (lost || key !== "ticket/TLSSN-42" || (value as Record<string, unknown>)["threadTs"] === undefined) return false;
      lost = true;
      return true;
    },
  });
  await announceIntakePlan(d);
  assert.deepEqual(d.deleted, []);
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.equal(d.posts.at(-1)?.["thread_ts"], INTAKE_ROOT_TS);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], PLANNED_ROOT_BINDING);
});

test("a binding put that lands but reports an error, then a read outage, keeps the root the binding points at", async () => {
  let landed = false;
  const d = desk({}, {
    putAppliesThenThrows: (key, value) => {
      if (landed || key !== "ticket/TLSSN-42" || (value as Record<string, unknown>)["threadTs"] === undefined) return false;
      landed = true;
      return true;
    },
    getThrows: (key) => landed && key === "ticket/TLSSN-42",
  });
  await assert.rejects(announceIntakePlan(d), /cannot be read; the root is kept/);
  assert.deepEqual(d.deleted, []);
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], PLANNED_ROOT_BINDING);
});

test("an update that waits for another opener's intake root still rewrites that root's status line", async () => {
  const d = desk({ "ticket/TLSSN-42": rootLease("live-pod", 0) });
  setTimeout(() => {
    d.kv["ticket/TLSSN-42"] = { channelId: "C0INTAKE01", threadTs: "1758510009.000100", root: "jira", boundAt: "2026-09-23T00:00:00.000Z" };
  }, 50);
  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  try {
    await announceApproved({ issueKey: "TLSSN-42", changelogId: "2", title: "Retry CSV export" } as never, d.as({}));
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
  }
  assert.deepEqual(standingRoots(d), []);
  assert.deepEqual(
    d.updates.map((update) => [update["ts"], /Status: \*([^*]+)\*/.exec(String(update["text"]))?.[1]]),
    [["1758510009.000100", "Approved"]]
  );
});

test("a plan that lands in a Slack filer's thread after a raced root says how the filer approves, not 'filed in Jira'", async () => {
  const d = desk({}, { onRootPost: (kv) => void (kv["ticket/TLSSN-42"] = ALICE_BINDING) });
  await announceIntakePlan(d);
  const plan = d.posts.at(-1)!;
  assert.equal(plan["thread_ts"], THREAD.threadTs);
  assert.doesNotMatch(JSON.stringify(plan), /filed in Jira/);
  assert.match(String(plan["text"]), new RegExp(`^<@${ALICE}> `));
  assert.match(JSON.stringify(plan), /react ✅ to start the build or ❌ to stop\.(?! or reply)/);
});

async function withIntake<T>(run: () => Promise<T>): Promise<T> {
  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  try {
    return await run();
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
  }
}

function rootShows(d: Desk): string | undefined {
  const last = d.updates.at(-1) ?? d.posts.find((post) => post["thread_ts"] === undefined);
  return /Status: \*([^*]+)\*/.exec(String(last?.["text"]))?.[1];
}

const plan = async (d: Desk, changelogId: string) =>
  announcePlan({ issueKey: "TLSSN-42", title: "Retry CSV export", changelogId, tracker: "transitioned" } as never, d.as({}));
const approved = async (d: Desk, changelogId: string) => announceApproved({ issueKey: "TLSSN-42", changelogId, title: "Retry CSV export" } as never, d.as({}));
const progress = async (d: Desk, changelogId: string) => announceProgress({ issueKey: "TLSSN-42", changelogId, title: "Retry CSV export" } as never, d.as({}));

test("the intake root ends at Approved whether the plan or the approval finishes last", async () => {
  const planFirst = desk();
  await withIntake(async () => {
    await plan(planFirst, "1");
    await approved(planFirst, "2");
  });
  assert.equal(rootShows(planFirst), "Approved");

  const approvedFirst = desk();
  await withIntake(() => Promise.all([approved(approvedFirst, "2"), plan(approvedFirst, "1")]));
  assert.equal(standingRoots(approvedFirst).length, 1);
  assert.equal(rootShows(approvedFirst), "Approved");

  // Jira says Approved by the time the late Planned delivery lands; the desk reads that, not the root.
  const slowPlan = desk({ ...JIRA_TICKET }, { status: "Approved" });
  await withIntake(async () => {
    await approved(slowPlan, "2");
    const late = (await plan(slowPlan, "1")) as Record<string, unknown>;
    assert.deepEqual(late, { posted: false, reason: "past_planned", issueKey: "TLSSN-42" });
  });
  assert.equal(rootShows(slowPlan), "Approved");
  assert.doesNotMatch(String(slowPlan.posts.at(-1)?.["text"]), /is planned/);
});

test("a late or newer Planned wake after In Progress neither dumps the plan again nor moves the root back", async () => {
  for (const changelogId of ["1", "4"]) {
    const d = desk({}, { status: "In Progress" });
    const late = await withIntake(async () => {
      await approved(d, "2");
      await progress(d, "3");
      return (await plan(d, changelogId)) as Record<string, unknown>;
    });
    assert.deepEqual(late, { posted: false, reason: "past_planned", issueKey: "TLSSN-42" }, changelogId);
    assert.equal(rootShows(d), "In Progress", changelogId);
    assert.deepEqual((d.kv["ticket/TLSSN-42"] as Record<string, unknown>)["rootStatus"], { status: "In Progress", rank: 3, changelogId: "3" }, changelogId);
  }
});

async function rootUpdate(d: Desk, status: string, changelogId: string) {
  const { postTicketUpdate } = await import("./ticket-thread.js");
  const client = await (d.as({}) as unknown as { host: { slack: { getClient(): Promise<unknown> } } }).host.slack.getClient();
  return postTicketUpdate({ kv: d.store as never, client: client as never, update: { issueKey: "TLSSN-42", title: "Retry CSV export", status, changelogId, text: `${status}.` } as never, at: "2026-09-23T00:00:00.000Z", env: {} });
}

test("a Done root stays Done for an older event, and a reopen with a newer changelog renders", async () => {
  const done = { ...JIRA_TICKET["ticket/TLSSN-42"], rootStatus: { status: "Done", rank: 5, changelogId: "9" } };
  const d = desk({ "ticket/TLSSN-42": done });
  const stale = await rootUpdate(d, "In Progress", "8");
  assert.equal(stale.posted, true);
  assert.deepEqual(d.updates, []);
  assert.equal(d.posts.at(-1)?.["thread_ts"], INTAKE_ROOT_TS);
  await rootUpdate(d, "In Progress", "10");
  assert.equal(rootShows(d), "In Progress");
});

test("without comparable changelog ids the lifecycle rank decides, and an off-ladder status never overrides a ranked one", async () => {
  const review = { ...JIRA_TICKET["ticket/TLSSN-42"], rootStatus: { status: "In Review", rank: 4, changelogId: "x" } };
  const d = desk({ "ticket/TLSSN-42": review });
  await rootUpdate(d, "Approved", "y");
  await rootUpdate(d, "Launch failed", "z");
  assert.deepEqual(d.updates, []);
  await rootUpdate(d, "Done", "w");
  assert.equal(rootShows(d), "Done");
  assert.deepEqual((d.kv["ticket/TLSSN-42"] as Record<string, unknown>)["rootStatus"], { status: "Done", rank: 5, changelogId: "w" });
});

test("an update that loses the root to a newer one while it renders puts the newer status back", async () => {
  let raced = false;
  const d = desk(
    { "ticket/TLSSN-42": { ...JIRA_TICKET["ticket/TLSSN-42"], rootStatus: { status: "Planned", rank: 1, changelogId: "1" } } },
    {
      onUpdate: (kv) => {
        if (raced) return;
        raced = true;
        kv["ticket/TLSSN-42"] = { ...JIRA_TICKET["ticket/TLSSN-42"], rootStatus: { status: "In Progress", rank: 3, changelogId: "3" } };
      },
    }
  );
  await withIntake(() => approved(d, "2"));
  assert.equal(rootShows(d), "In Progress");
});

/** Run `land` once, right after the `nth` read of the ticket binding returns. */
function afterTicketRead(d: Desk, nth: number, land: () => void): void {
  const read = d.store.get;
  let reads = 0;
  d.store.get = async (key: string) => {
    const value = await read(key);
    if (key === "ticket/TLSSN-42" && ++reads === nth) land();
    return value;
  };
}

test("concurrent openers: the opener binding its root after this update saw its placeholder as abandoned keeps its root; the takeover yields", async () => {
  const opener = { channelId: "C0INTAKE01", threadTs: "1758510009.000100", root: "jira", boundAt: "2026-09-22T23:58:00.000Z" };
  const d = desk({ "ticket/TLSSN-42": { channelId: "C0INTAKE01", root: "jira", pendingRoot: "slow-pod", boundAt: "2026-09-22T23:58:00.000Z" } });
  // Reads: the announce's target, the update's target, then the root claim's read, which refuses a pre-lease placeholder.
  afterTicketRead(d, 3, () => void (d.kv["ticket/TLSSN-42"] = opener));
  await announceIntakePlan(d);
  assert.deepEqual(standingRoots(d), []);
  assert.equal(d.posts.at(-1)?.["thread_ts"], opener.threadTs);
  assert.equal((d.kv["ticket/TLSSN-42"] as Record<string, unknown>)["threadTs"], opener.threadTs);
});

test("concurrent openers: a Slack filing that lands after a failed bind read the placeholder back is not deleted with it", async () => {
  const d = desk({}, {
    putThrows: (key, value) => key === "ticket/TLSSN-42" && (value as Record<string, unknown>)["threadTs"] === INTAKE_ROOT_TS,
    onChatDelete: (kv) => void (kv["ticket/TLSSN-42"] = ALICE_BINDING),
  });
  await assert.rejects(announceIntakePlan(d), /could not be bound/);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], ALICE_BINDING);
  assert.deepEqual(standingRoots(d), []);
});

test("concurrent openers: a Slack filing that lands while the intake root post fails is not deleted with this update's placeholder", async () => {
  const d = desk({}, { rootPostThrows: true, onRootPost: (kv) => void (kv["ticket/TLSSN-42"] = ALICE_BINDING) });
  await assert.rejects(announceIntakePlan(d), /slack down/);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], ALICE_BINDING);
});

test("concurrent openers: a newer root status that lands after the repair pass read the binding is not overwritten by the repair", async () => {
  const at = (status: string, rank: number, changelogId: string) => ({ ...JIRA_TICKET["ticket/TLSSN-42"], rootStatus: { status, rank, changelogId } });
  const d = desk({ "ticket/TLSSN-42": at("Planned", 1, "1") }, {
    onUpdate: (kv) => {
      kv["ticket/TLSSN-42"] = at("Planned", 1, "1");
      afterTicketRead(d, 1, () => void (d.kv["ticket/TLSSN-42"] = at("In Progress", 3, "3")));
    },
  });
  await withIntake(() => approved(d, "2"));
  assert.deepEqual((d.kv["ticket/TLSSN-42"] as Record<string, unknown>)["rootStatus"], { status: "In Progress", rank: 3, changelogId: "3" });
});

test("a Slack message delivered late does not replace a newer speaker, so a voided command stays void", async () => {
  const d = desk({ ...SLACK_TICKET });
  await inbound(d, [
    [30, BOB, "<@U0DESK> hold on"],
    [90, ALICE, "<@U0DESK> approve TLSSN-42"],
  ]);
  const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(result["status"], "not_originator");
  assert.deepEqual(d.jira, []);
});

test("a Slack retry of a consumed command does not vouch again", async () => {
  const d = desk({ ...SLACK_TICKET });
  await inbound(d, [[50, ALICE, "<@U0DESK> approve TLSSN-42"]]);
  const first = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(first["approved"], true);
  await inbound(d, [[50, ALICE, "<@U0DESK> approve TLSSN-42"]]);
  const retried = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, d.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
  assert.equal(retried["status"], "not_originator");
  assert.equal(d.jira.filter((call) => call === "transitionJiraIssue").length, 1);
});

test("an approve or replan that runs after the ticket moved past Planned does not drag it back", async () => {
  for (const status of ["In Progress", "In Review", "Done"]) {
    const approve = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "approve TLSSN-42") }, { status });
    const approveResult = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, approve.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
    assert.equal(approveResult["approved"], false, status);
    assert.equal(approveResult["reason"], "moved_on", status);
    assert.equal(approve.jira.includes("transitionJiraIssue"), false, status);

    const replan = desk({ ...SLACK_TICKET, ...said(THREAD, ALICE, "replan TLSSN-42") }, { status });
    const replanResult = (await requestPlan.execute!({ issueKey: "TLSSN-42", replan: true } as never, replan.as({ thread: THREAD, starter: ALICE }))) as Record<string, unknown>;
    assert.equal(replanResult["requested"], false, status);
    assert.equal(replanResult["reason"], "moved_on", status);
    assert.equal(replan.jira.includes("transitionJiraIssue"), false, status);
  }
});

test("Slack timestamps compare as seconds then fraction, past double precision", () => {
  assert.equal(compareSlackTs("1758510000.123457", "1758510000.123456"), 1);
  assert.equal(compareSlackTs("1758510000.123456", "1758510000.123456"), 0);
  assert.equal(compareSlackTs("1758509999.999999", "1758510000.000001"), -1);
});

test("a binding retry after a put that landed keeps the newer root status an update recorded meanwhile", async () => {
  let lost = false;
  const kv: Record<string, unknown> = {};
  const d = desk(kv, {
    putAppliesThenThrows: (key, value) => {
      if (lost || key !== "ticket/TLSSN-42" || (value as Record<string, unknown>)["threadTs"] === undefined) return false;
      lost = true;
      kv[key] = { ...(value as Record<string, unknown>), rootStatus: { status: "Approved", rank: 2, changelogId: "2" } };
      return true;
    },
  });
  await announceIntakePlan(d);
  assert.deepEqual((d.kv["ticket/TLSSN-42"] as Record<string, unknown>)["rootStatus"], { status: "Approved", rank: 2, changelogId: "2" });
  assert.equal(d.posts.at(-1)?.["thread_ts"], INTAKE_ROOT_TS);
});

test("a binding put that lands, gains a newer root status, then meets a read outage still threads the plan under its root", async () => {
  let landed = false;
  let readsAfter = 0;
  const kv: Record<string, unknown> = {};
  const d = desk(kv, {
    putAppliesThenThrows: (key, value) => {
      if (landed || key !== "ticket/TLSSN-42" || (value as Record<string, unknown>)["threadTs"] === undefined) return false;
      landed = true;
      kv[key] = { ...(value as Record<string, unknown>), rootStatus: { status: "Approved", rank: 2, changelogId: "2" } };
      return true;
    },
    getThrows: (key) => landed && key === "ticket/TLSSN-42" && ++readsAfter > 2,
  });
  await announceIntakePlan(d);
  assert.deepEqual(d.deleted, []);
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.equal(d.posts.at(-1)?.["thread_ts"], INTAKE_ROOT_TS);
});

test("a placeholder that cannot be written fails the update at once: no root, no waiting on a claim nobody holds", async () => {
  let placeholderPuts = 0;
  const d = desk({}, {
    putThrows: (key, value) => key === "ticket/TLSSN-42" && (value as Record<string, unknown>)["state"] === "pending" && ++placeholderPuts > 0,
  });
  await assert.rejects(announceIntakePlan(d), /could not be claimed/);
  assert.deepEqual(d.posts, []);
  assert.ok(placeholderPuts <= VERIFY_ATTEMPTS, `${placeholderPuts} placeholder puts`);
});

test("no claim can block forever: an announce claim that landed unverified expires, and the update posts exactly once more", async () => {
  const key = "announced/TLSSN-42:Planned:plan-10077";
  let down = false;
  let landed = false;
  const d = desk({ ...SLACK_TICKET }, {
    getThrows: (k) => down && k === key,
    putAppliesThenThrows: (k) => {
      if (k === key && !landed) landed = down = true;
      return false;
    },
  });
  const start = Date.parse("2026-09-23T00:00:00.000Z");
  const deliver = async (laterMs: number) =>
    (await announcePlan({ issueKey: "TLSSN-42", title: "Retry CSV export", changelogId: "1", tracker: "transitioned" } as never, { ...(d.as({}) as object), now: () => new Date(start + laterMs) } as never)) as Record<string, unknown>;
  assert.equal((await deliver(0))["reason"], "failed");
  assert.notEqual(d.kv[key], undefined);
  down = false;
  assert.equal((await deliver(ANNOUNCE_LEASE_MS - 1))["posted"], false);
  assert.equal(d.posts.length, 0);
  assert.equal((await deliver(ANNOUNCE_LEASE_MS))["posted"], true);
  assert.equal(d.posts.length, 1);
  assert.equal((await deliver(10 * ANNOUNCE_LEASE_MS))["reason"], "already_announced");
  assert.equal(d.posts.length, 1);
});

test("no claim can block forever: an intake root claim that landed unverified expires, and the root is opened exactly once", async () => {
  const key = "ticket/TLSSN-42";
  let down = false;
  let landed = false;
  const d = desk({}, {
    getThrows: (k) => down && k === key,
    putAppliesThenThrows: (k, value) => {
      if (k === key && !landed && (value as Record<string, unknown>)["threadTs"] === undefined) landed = down = true;
      return false;
    },
  });
  await assert.rejects(announceIntakePlan(d), /could not be claimed/);
  assert.notEqual(d.kv[key], undefined);
  assert.deepEqual(d.posts, []);
  down = false;
  const redelivered = announceIntakePlan(d);
  await sleep(600);
  assert.deepEqual(d.posts, []);
  (d.kv[key] as Record<string, unknown>)["at"] = new Date(Date.now() - ROOT_LEASE_MS).toISOString();
  await redelivered;
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.equal(d.posts.at(-1)?.["thread_ts"], INTAKE_ROOT_TS);
  await withIntake(() => approved(d, "2"));
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.equal(d.posts.filter((post) => post["thread_ts"] === undefined).length, 1);
});

test("an announce claim that landed unverified is released once the kv reads again, so the next delivery posts at once", async () => {
  const key = "announced/TLSSN-42:Planned:plan-10077";
  let failReads = 0;
  let landed = false;
  const d = desk({ ...SLACK_TICKET }, {
    getThrows: (k) => k === key && failReads > 0 && failReads-- > 0,
    putAppliesThenThrows: (k) => {
      if (k === key && !landed) {
        landed = true;
        failReads = VERIFY_ATTEMPTS;
      }
      return false;
    },
  });
  const deliver = async () => (await announcePlan({ issueKey: "TLSSN-42", title: "Retry CSV export", changelogId: "1", tracker: "transitioned" } as never, d.as({}))) as Record<string, unknown>;
  assert.equal((await deliver())["reason"], "failed");
  assert.equal(d.kv[key], undefined);
  assert.equal((await deliver())["posted"], true);
  assert.equal(d.posts.length, 1);
});

test("an intake root claim that landed unverified is released once the kv reads again, so the next update opens the root at once", async () => {
  const key = "ticket/TLSSN-42";
  let failReads = 0;
  let landed = false;
  const d = desk({}, {
    getThrows: (k) => k === key && failReads > 0 && failReads-- > 0,
    putAppliesThenThrows: (k, value) => {
      if (k === key && !landed && (value as Record<string, unknown>)["threadTs"] === undefined) {
        landed = true;
        failReads = VERIFY_ATTEMPTS;
      }
      return false;
    },
  });
  await assert.rejects(announceIntakePlan(d), /could not be claimed/);
  assert.equal(d.kv[key], undefined);
  const started = Date.now();
  await announceIntakePlan(d);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
});

test("a root claim past its lease is taken over, and the update opens the root at once", async () => {
  const d = desk({ "ticket/TLSSN-42": rootLease("crashed-pod", ROOT_LEASE_MS) });
  const started = Date.now();
  await announceIntakePlan(d);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], PLANNED_ROOT_BINDING);
});

test("a binding write that fails for under a second waits out the outage, keeps the root, and threads the plan under it", async () => {
  let until = 0;
  const d = desk({}, {
    putThrows: (key, value) => {
      if (key !== "ticket/TLSSN-42" || (value as Record<string, unknown>)["threadTs"] === undefined) return false;
      if (until === 0) until = Date.now() + 400;
      return Date.now() < until;
    },
  });
  await announceIntakePlan(d);
  assert.deepEqual(d.deleted, []);
  assert.deepEqual(standingRoots(d), [INTAKE_ROOT_TS]);
  assert.equal(d.posts.at(-1)?.["thread_ts"], INTAKE_ROOT_TS);
  assert.deepEqual(d.kv["ticket/TLSSN-42"], PLANNED_ROOT_BINDING);
});

test("an intake root post that throws drops this update's placeholder, so the next update opens the root without waiting", async () => {
  const d = desk({}, { rootPostThrows: true });
  await assert.rejects(announceIntakePlan(d), /slack down/);
  assert.equal(d.kv["ticket/TLSSN-42"], undefined);
  assert.deepEqual(Object.keys(d.kv).filter((key) => key.startsWith("announced/")), []);
});

for (const [name, make] of KV_BACKENDS) {
  test(`${name}: the first message in a thread records its speaker and command`, async () => {
    const kv = await make();
    const handler = recordingSpeakers(async () => ({ auth: null }));
    await handler(slackBinding(kv), slackMessage("1758510010.000100", "<@U0DESK> approve TLSSN-42", { userId: ALICE, userName: "alice", isBot: false }));
    assert.deepEqual(await kv.get(speakerKey(THREAD)), { userId: ALICE, ts: "1758510010.000100" });
    assert.deepEqual(await kv.get(commandKey(THREAD, { verb: "approve", target: "TLSSN-42" })), { userId: ALICE, ts: "1758510010.000100" });
    if ("casCalls" in kv) assert.deepEqual(kv.casCalls, []);
  });
}

test("one long message records at most MAX_RECORDED_COMMANDS commands, however many it names", async () => {
  const kv: Record<string, unknown> = {};
  const puts: string[] = [];
  const store = { get: async (k: string) => kv[k], put: async (k: string, v: unknown) => void (puts.push(k), (kv[k] = v)), delete: async (k: string) => void delete kv[k] };
  const text = Array.from({ length: 2000 }, (_, i) => `approve TLSSN-${i + 1}`).join(" ");
  await recordingSpeakers(async () => ({ auth: null }))(slackBinding(store), slackMessage("1758510010.000100", text, { userId: ALICE, userName: "alice", isBot: false }));
  assert.equal(MAX_RECORDED_COMMANDS, 5);
  assert.deepEqual(
    Object.keys(kv).filter((key) => key.startsWith("command/")),
    [1, 2, 3, 4, 5].map((n) => commandKey(THREAD, { verb: "approve", target: `TLSSN-${n}` }))
  );
  assert.equal(puts.length, 1 + MAX_RECORDED_COMMANDS);
});

test("a Slack Connect sender, or one whose membership cannot be checked, is not recorded, and the turn still runs", async () => {
  const kv: Record<string, unknown> = {};
  const store = { get: async (k: string) => kv[k], put: async (k: string, v: unknown) => void (kv[k] = v), delete: async (k: string) => void delete kv[k] };
  const seen: string[] = [];
  const handler = recordingSpeakers(async (_ctx, message) => {
    seen.push(message.ts);
    return { auth: null };
  });
  const usersInfo: string[] = [];
  const outsider = "U0CONNECT1";
  await handler(slackBinding(store, { external: [outsider], usersInfo }), slackMessage("1758510010.000100", "<@U0DESK> approve TLSSN-42", { userId: outsider, userName: "eve", isBot: false }));
  assert.deepEqual(usersInfo, [outsider]);
  assert.deepEqual(kv, {});

  const down = slackBinding(store);
  (down.host.slack as unknown as { getClient: () => Promise<unknown> }).getClient = async () => ({ apiCall: async () => Promise.reject(new Error("slack down")) });
  await handler(down, slackMessage("1758510011.000100", "<@U0DESK> approve TLSSN-42", { userId: ALICE, userName: "alice", isBot: false }));
  const noTeam = { ...slackMessage("1758510012.000100", "approve TLSSN-42", { userId: ALICE, userName: "alice", isBot: false }), teamId: undefined };
  const teamless = slackBinding(store);
  (teamless.slack as { teamId?: string }).teamId = undefined;
  await handler(teamless, noTeam as SlackMessage);
  assert.deepEqual(kv, {});
  assert.deepEqual(seen, ["1758510010.000100", "1758510011.000100", "1758510012.000100"]);

  await handler(slackBinding(store), slackMessage("1758510013.000100", "<@U0DESK> approve TLSSN-42", { userId: ALICE, userName: "alice", isBot: false }));
  assert.deepEqual(kv[speakerKey(THREAD)], { userId: ALICE, ts: "1758510013.000100" });
});

test("a plain `deny` from the filer is recorded as `deny KEY` for the thread's one ticket, so deny_ticket's gate finds the caller (TLSSN-46)", async () => {
  const kv: Record<string, unknown> = {
    [`thread-tickets/${THREAD.channelId}:${THREAD.threadTs}`]: ["TLSSN-46"],
    [`ticket/TLSSN-46`]: { ...THREAD, originatorUserId: ALICE },
  };
  const host = { kv: { get: async (k: string) => kv[k], put: async (k: string, v: unknown) => void (kv[k] = v), delete: async (k: string) => void delete kv[k] } };
  const handler = recordingSpeakers(async () => ({ auth: null }));
  await handler(slackBinding(host.kv), slackMessage("1758510020.000100", "deny\nSent using @Cursor", { userId: ALICE, userName: "alice", isBot: false }));
  assert.deepEqual(kv[commandKey(THREAD, { verb: "deny", target: "TLSSN-46" })], { userId: ALICE, ts: "1758510020.000100" });

  await handler(slackBinding(host.kv), slackMessage("1758510021.000100", "I deny that it's broken\nSent using @Cursor", { userId: ALICE, userName: "alice", isBot: false }));
  assert.deepEqual(kv[commandKey(THREAD, { verb: "deny", target: "TLSSN-46" })], { userId: ALICE, ts: "1758510020.000100" });
});

function tlssn46Desk() {
  const kv: Record<string, unknown> = {
    [`thread-tickets/${THREAD.channelId}:${THREAD.threadTs}`]: ["TLSSN-46"],
    [`ticket/TLSSN-46`]: { ...THREAD, originatorUserId: ALICE },
  };
  const api = { get: async (k: string) => kv[k], put: async (k: string, v: unknown) => void (kv[k] = v), delete: async (k: string) => void delete kv[k] };
  const gate = (ts: string) =>
    gateCommand(
      {
        session: { id: "ses_1", channelId: "slack", mode: "chat", purpose: "live", auth: { authenticator: "slack", principalId: "slack:T:thread", principalType: "user", attributes: { channel_id: THREAD.channelId, thread_ts: THREAD.threadTs } }, continuationKey: null } as never,
        host: { kv: api as never },
        now: () => new Date(Number(ts) * 1000 + 5000),
      },
      { issueKey: "TLSSN-46", verbs: ["deny"] }
    );
  return { kv, api, gate };
}

test("hosted July without ctx.slack.threadTs: a plain `deny` is recorded under message.threadTs and passes deny_ticket's gate", async () => {
  const { kv, api, gate } = tlssn46Desk();
  const noThread = slackBinding(api);
  (noThread.slack as { threadTs?: string }).threadTs = undefined;
  const ts = "1758510030.000100";
  await recordingSpeakers(async () => ({ auth: null }))(noThread, slackMessage(ts, "deny\nSent using @Cursor", { userId: ALICE, userName: "alice", isBot: false }));
  assert.deepEqual(kv[commandKey(THREAD, { verb: "deny", target: "TLSSN-46" })], { userId: ALICE, ts });
  assert.deepEqual(await gate(ts), { status: "ok", originatorUserId: ALICE, commandTs: ts });
});

test("hosted July without ctx.slack.threadTs: a keyed `deny TLSSN-46` is recorded under the same thread and passes the gate", async () => {
  const { kv, api, gate } = tlssn46Desk();
  const noThread = slackBinding(api);
  (noThread.slack as { threadTs?: string }).threadTs = undefined;
  const ts = "1758510031.000100";
  await recordingSpeakers(async () => ({ auth: null }))(noThread, slackMessage(ts, "deny TLSSN-46", { userId: ALICE, userName: "alice", isBot: false }));
  assert.deepEqual(kv[commandKey(THREAD, { verb: "deny", target: "TLSSN-46" })], { userId: ALICE, ts });
  assert.equal((await gate(ts)).status, "ok");
});

test("a plain `deny` from a non-filer in the TLSSN-46 thread is recorded as theirs and refused as not_originator", async () => {
  const { kv, api, gate } = tlssn46Desk();
  const ts = "1758510032.000100";
  await recordingSpeakers(async () => ({ auth: null }))(slackBinding(api), slackMessage(ts, "deny\nSent using @Cursor", { userId: BOB, userName: "bob", isBot: false }));
  assert.deepEqual(kv[commandKey(THREAD, { verb: "deny", target: "TLSSN-46" })], { userId: BOB, ts });
  assert.deepEqual(await gate(ts), { status: "not_originator", originatorUserId: ALICE, callerUserId: BOB });
});

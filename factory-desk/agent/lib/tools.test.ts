import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, HostMcpToolInfo } from "@cursor/july";
import fileTicket from "../tools/file_ticket.js";
import { announcePlan, announceProgress, announceTriaged, triagedAnnounceKey, triagedEntryKey, triagedVerdictFingerprint } from "./announce.js";
import { loaderKey, loaderMessage } from "./loader.js";
import { createIssue, issueTypeFor, jiraProject } from "./jira.js";
import { DIGEST_COMMENT } from "./plan-comment.fixtures.js";
import { announceTicketUpdate } from "./ticket-thread.js";
import { DESK_TRIAGED_LINE } from "./desk-triaged.js";

const savedScope = {
  desk: process.env.FACTORY_DESK_JIRA_PROJECT,
  shared: process.env.FACTORY_JIRA_PROJECTS,
  settle: process.env.FACTORY_DESK_CLAIM_SETTLE_MS,
};

before(() => {
  process.env.FACTORY_DESK_JIRA_PROJECT = "TLSSN";
  delete process.env.FACTORY_JIRA_PROJECTS;
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
});

after(() => {
  if (savedScope.desk === undefined) delete process.env.FACTORY_DESK_JIRA_PROJECT;
  else process.env.FACTORY_DESK_JIRA_PROJECT = savedScope.desk;
  if (savedScope.shared === undefined) delete process.env.FACTORY_JIRA_PROJECTS;
  else process.env.FACTORY_JIRA_PROJECTS = savedScope.shared;
  if (savedScope.settle === undefined) delete process.env.FACTORY_DESK_CLAIM_SETTLE_MS;
  else process.env.FACTORY_DESK_CLAIM_SETTLE_MS = savedScope.settle;
});

const createTool: HostMcpToolInfo = {
  name: "createJiraIssue",
  inputSchema: { type: "object", properties: { projectKey: { type: "string" }, summary: { type: "string" }, description: { type: "string" }, issueTypeName: { type: "string" } } },
};

const listCommentsTool: HostMcpToolInfo = {
  name: "getJiraIssueComments",
  inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } },
};

type SlackAuth = { authenticator: string; principalId: string; principalType: "user"; attributes: Record<string, string> };

function slackAuth(channelId: string, threadTs?: string): SlackAuth {
  return {
    authenticator: "slack",
    principalId: "slack:T:thread",
    principalType: "user",
    attributes: threadTs === undefined ? { channel_id: channelId } : { channel_id: channelId, thread_ts: threadTs },
  };
}

function ctx(options: {
  purpose?: string;
  continuationKey?: string | null;
  auth?: SlackAuth | null;
  kv?: Record<string, unknown>;
  connected?: boolean;
  posts?: Record<string, unknown>[];
  mcpCalls?: Record<string, unknown>[];
  order?: string[];
  announcedGetThrows?: boolean;
  putThrows?: boolean;
  postThrows?: boolean;
  /** Runs inside postMessage, before it returns or throws. */
  onPost?: (kv: Record<string, unknown>) => void;
  /** The put is applied, then the call still throws, as when the response is lost. */
  putLandsThenThrows?: boolean;
  comments?: Array<string | { id: string; body: string }>;
  commentsThrow?: boolean;
  /** When set, listTools includes getJiraIssue and announcePlan can skip past Planned. */
  jiraStatus?: string;
  /** Override the createJiraIssue reply body. Default includes a browse `self`. */
  createReply?: unknown;
} = {}) {
  const kv: Record<string, unknown> = options.kv ?? {};
  const posts = options.posts ?? [];
  const mcpCalls = options.mcpCalls ?? [];
  const order = options.order;
  const note = (step: string) => {
    order?.push(step);
  };
  const store = {
    get: async (key: string) => {
      note(`get:${key}`);
      if (options.announcedGetThrows === true && key.startsWith("announced/")) throw new Error("kv down");
      return kv[key];
    },
    put: async (key: string, value: unknown) => {
      note(`put:${key}`);
      if (options.putThrows === true) throw new Error("kv down");
      kv[key] = value;
      if (options.putLandsThenThrows === true) throw new Error("kv put response lost");
    },
    delete: async (key: string) => {
      note(`delete:${key}`);
      delete kv[key];
    },
  };
  return {
    kv,
    posts,
    mcpCalls,
    context: {
      session: {
        id: "ses_1",
        channelId: "slack",
        mode: "chat",
        purpose: options.purpose ?? "live",
        auth: options.auth === undefined ? null : options.auth,
        continuationKey: options.continuationKey === undefined ? "issue:TLSSN-42" : options.continuationKey,
      },
      now: () => new Date("2026-09-22T00:00:00.000Z"),
      host: {
        kv: store,
        slack: {
          getClient: async () => ({
            chat: {
              postMessage: async (args: Record<string, unknown>) => {
                note("post");
                posts.push(args);
                options.onPost?.(kv);
                if (options.postThrows === true) throw new Error("slack down");
                return { ok: true, ts: "1758510001.000100" };
              },
              delete: async () => ({ ok: true }),
              update: async () => ({ ok: true }),
            },
          }),
        },
        mcp: {
          names: () => (options.connected === false ? [] : ["tracker"]),
          listTools: async () => [
            createTool,
            listCommentsTool,
            ...(options.jiraStatus === undefined
              ? []
              : [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } } satisfies HostMcpToolInfo]),
          ],
          callTool: async (_c: string, tool: string, args?: Record<string, unknown>): Promise<HostMcpCallResult> => {
            mcpCalls.push({ tool, ...args });
            if (tool === "getJiraIssue") {
              return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields: { status: { name: options.jiraStatus } } }) }] };
            }
            if (tool === listCommentsTool.name) {
              if (options.commentsThrow === true) throw new Error("jira down");
              const comments = (options.comments ?? []).map((comment) => (typeof comment === "string" ? { body: comment } : comment));
              return { content: [{ type: "text", text: JSON.stringify({ comments }) }] };
            }
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(options.createReply ?? { key: "TLSSN-42", self: "https://x.atlassian.net/browse/TLSSN-42" }),
                },
              ],
            };
          },
        },
      },
    },
  };
}

test("project comes from the override, then FACTORY_JIRA_PROJECTS", () => {
  assert.equal(jiraProject({}), undefined);
  assert.equal(jiraProject({ FACTORY_JIRA_PROJECTS: "tlssn, demo" }), "TLSSN");
  assert.equal(jiraProject({ FACTORY_DESK_JIRA_PROJECT: "demo", FACTORY_JIRA_PROJECTS: "tlssn" }), "DEMO");
  assert.equal(issueTypeFor("bug"), "Bug");
  assert.equal(issueTypeFor("feedback"), "Task");
});

test("createIssue uses the connector's argument names and reads the key back", async () => {
  const env = { FACTORY_DESK_JIRA_PROJECT: "TLSSN" };
  const c = ctx();
  const outcome = await createIssue(c.context.host.mcp as never, { title: "CSV export returns 500", description: "Since this morning. Asked by Alice.", kind: "bug" }, env);
  assert.deepEqual(outcome, { status: "created", issueKey: "TLSSN-42", project: "TLSSN", url: "https://x.atlassian.net/browse/TLSSN-42" });
  assert.deepEqual(c.mcpCalls[0], { tool: "createJiraIssue", projectKey: "TLSSN", summary: "CSV export returns 500", description: "Since this morning. Asked by Alice.", issueTypeName: "Bug" });
  assert.deepEqual(await createIssue(ctx({ connected: false }).context.host.mcp as never, { title: "x", description: "y", kind: "bug" }, env), { status: "not_connected", project: "TLSSN" });
});

test("createIssue builds a browse URL when the connector only returns a REST self", async () => {
  const restSelf = { key: "TLSSN-42", self: "https://api.atlassian.com/ex/jira/5f1c/rest/api/3/issue/10442" };
  const fromSite = await createIssue(
    ctx({ createReply: restSelf }).context.host.mcp as never,
    { title: "x", description: "y", kind: "bug" },
    { FACTORY_DESK_JIRA_PROJECT: "TLSSN" }
  );
  assert.deepEqual(fromSite, {
    status: "created",
    issueKey: "TLSSN-42",
    project: "TLSSN",
    url: "https://example.atlassian.net/browse/TLSSN-42",
  });

  const fromSelf = await createIssue(
    ctx({ createReply: { key: "TLSSN-42", self: "https://acme.atlassian.net/rest/api/3/issue/10442" } }).context.host.mcp as never,
    { title: "x", description: "y", kind: "bug" },
    { FACTORY_DESK_JIRA_PROJECT: "TLSSN", JIRA_CLOUD_ID: "0f6a3e2c-1111-4222-8333-944455556666" }
  );
  assert.deepEqual(fromSelf, {
    status: "created",
    issueKey: "TLSSN-42",
    project: "TLSSN",
    url: "https://acme.atlassian.net/browse/TLSSN-42",
  });

  const noSite = await createIssue(
    ctx({ createReply: restSelf }).context.host.mcp as never,
    { title: "x", description: "y", kind: "bug" },
    { FACTORY_DESK_JIRA_PROJECT: "TLSSN", JIRA_CLOUD_ID: "0f6a3e2c-1111-4222-8333-944455556666" }
  );
  assert.deepEqual(noSite, { status: "created", issueKey: "TLSSN-42", project: "TLSSN" });
});

test("file_ticket creates the issue and binds the Slack thread from session auth", async () => {
  const c = ctx({ continuationKey: "C999WRONG:1.1", auth: slackAuth("C0123ABCD", "1758510000.123456") });
  const result = (await fileTicket.execute!({ title: "CSV export returns 500", description: "Since this morning.", kind: "bug" } as never, c.context as never)) as Record<string, unknown>;
  assert.equal(result["created"], true);
  assert.equal(result["issueKey"], "TLSSN-42");
  assert.equal(result["url"], "https://x.atlassian.net/browse/TLSSN-42");
  assert.equal(result["link"], "[TLSSN-42](https://x.atlassian.net/browse/TLSSN-42)", "the model copies this, so Slack shows the key");
  assert.equal(result["threadBound"], true);
  assert.deepEqual(c.kv["ticket/TLSSN-42"], { channelId: "C0123ABCD", threadTs: "1758510000.123456", filedAt: "2026-09-22T00:00:00.000Z" });

  const ignoredKey = ctx({ continuationKey: "C0123ABCD:1758510000.123456" });
  const unbound = (await fileTicket.execute!({ title: "CSV export returns 500", description: "Since this morning.", kind: "bug" } as never, ignoredKey.context as never)) as Record<string, unknown>;
  assert.equal(unbound["threadBound"], false);
  assert.equal(ignoredKey.kv["ticket/TLSSN-42"], undefined);

  const inEval = (await fileTicket.execute!({ title: "x", description: "y", kind: "bug", severity: "medium", summary: "Export fails." } as never, ctx({ purpose: "eval" }).context as never)) as Record<string, unknown>;
  assert.deepEqual(inEval, {
    created: true,
    reason: "created",
    issueKey: "EVALX-1",
    project: "EVALX",
    url: "https://example.atlassian.net/browse/EVALX-1",
    link: "[EVALX-1](https://example.atlassian.net/browse/EVALX-1)",
    reply: [
      "[EVALX-1](https://example.atlassian.net/browse/EVALX-1) is filed. Triaged by Grok 4.6 Fast (Jev wasn't asked): Bug, medium severity.",
    ].join("\n"),
    threadBound: false,
    triage: { by: "model", issueType: "Bug", kind: "bug", severity: "medium", summary: "Export fails.", fallback: "no_intake", status: "eval" },
  });
});

test("file_ticket puts the Slack thread permalink in the Jira description and marks the filer's message 👀", async () => {
  const c = ctx({ auth: slackAuth("C0123ABCD", "1758510000.123456") });
  const calls: Array<[string, Record<string, unknown>]> = [];
  const permalink = "https://example-workspace.slack.com/archives/C0123ABCD/p1758510000123456";
  (c.context.host as Record<string, unknown>)["slack"] = {
    getClient: async () => ({
      apiCall: async (method: string, args: Record<string, unknown>) => {
        calls.push([method, args]);
        return method === "chat.getPermalink" ? { ok: true, permalink } : { ok: true };
      },
    }),
  };
  const result = (await fileTicket.execute!({ title: "CSV export returns 500", description: "Since this morning. Asked by Alice.", kind: "bug" } as never, c.context as never)) as Record<string, unknown>;
  assert.equal(result["slackThread"], permalink);
  assert.equal(c.mcpCalls[0]?.["description"], `Since this morning. Asked by Alice.\n\nSlack thread: ${permalink}\n\n${DESK_TRIAGED_LINE}`);
  assert.deepEqual(calls, [
    ["chat.getPermalink", { channel: "C0123ABCD", message_ts: "1758510000.123456" }],
    ["reactions.add", { channel: "C0123ABCD", timestamp: "1758510000.123456", name: "eyes" }],
  ]);
  assert.deepEqual(c.kv["reaction/TLSSN-42"], { channel: "C0123ABCD", ts: "1758510000.123456", name: "eyes" });
});

test("file_ticket files without a Slack line when there is no channel thread or the permalink is not a Slack archive URL", async () => {
  const withAnswer = (answer: unknown, auth: SlackAuth) => {
    const c = ctx({ auth });
    const reply = () => (typeof answer === "function" ? (answer as () => unknown)() : answer);
    (c.context.host as Record<string, unknown>)["slack"] = { getClient: async () => ({ apiCall: async (method: string) => (method === "chat.getPermalink" ? reply() : { ok: true }) }) };
    return c;
  };
  for (const [answer, auth] of [
    [{ ok: true, permalink: "https://evil.example/archives/C0123ABCD/p1758510000123456" }, slackAuth("C0123ABCD", "1758510000.123456")],
    [() => Promise.reject(Object.assign(new Error("channel_not_found"), { data: { error: "channel_not_found" } })), slackAuth("C0123ABCD", "1758510000.123456")],
    [{ ok: true, permalink: "https://x.slack.com/archives/D0123ABCD/p1758510000123456" }, slackAuth("D0123ABCD")],
  ] as const) {
    const c = withAnswer(answer, auth);
    const result = (await fileTicket.execute!({ title: "x", description: "Since this morning.", kind: "bug" } as never, c.context as never)) as Record<string, unknown>;
    assert.equal(result["created"], true);
    assert.equal(result["slackThread"], undefined);
    assert.equal(c.mcpCalls[0]?.["description"], `Since this morning.\n\n${DESK_TRIAGED_LINE}`);
  }
});

// The issue exists once Jira answers. A thread binding that fails must not
// turn that into a failed card, or the retry files the ticket twice.
test("file_ticket keeps the created issue when the thread binding cannot be written", async () => {
  const c = ctx({ auth: slackAuth("C0123ABCD", "1758510000.123456"), putThrows: true });
  const result = (await fileTicket.execute!({ title: "CSV export returns 500", description: "Since this morning.", kind: "bug" } as never, c.context as never)) as Record<string, unknown>;
  assert.equal(result["created"], true);
  assert.equal(result["issueKey"], "TLSSN-42");
  assert.equal(result["threadBound"], false);
  assert.equal(result["threadBindingError"], "the thread binding could not be written and verified");
  assert.equal(c.kv["ticket/TLSSN-42"], undefined);
});

test("file_ticket passes through createIssue's refusal when no Jira project is configured", async () => {
  const desk = process.env.FACTORY_DESK_JIRA_PROJECT;
  const shared = process.env.FACTORY_JIRA_PROJECTS;
  delete process.env.FACTORY_DESK_JIRA_PROJECT;
  delete process.env.FACTORY_JIRA_PROJECTS;
  try {
    const result = (await fileTicket.execute!({ title: "x", description: "y", kind: "bug" } as never, ctx().context as never)) as Record<string, unknown>;
    assert.equal(result["created"], false);
    assert.equal(result["reason"], "failed");
    assert.equal(result["project"], "");
    assert.match(String(result["message"]), /FACTORY_DESK_JIRA_PROJECT/);
    assert.match(String(result["message"]), /FACTORY_JIRA_PROJECTS/);
  } finally {
    if (desk === undefined) delete process.env.FACTORY_DESK_JIRA_PROJECT;
    else process.env.FACTORY_DESK_JIRA_PROJECT = desk;
    if (shared === undefined) delete process.env.FACTORY_JIRA_PROJECTS;
    else process.env.FACTORY_JIRA_PROJECTS = shared;
  }
});

const BOUND = { "ticket/TLSSN-42": { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE01" } };
const PLANNED_KEY = "announced/TLSSN-42:Planned";
const PROGRESS_KEY = "announced/TLSSN-42:In Progress:10043";

// Each delivery's claim carries its own owner; a release or a final write only touches that one.
function withoutOwner(record: unknown): Record<string, unknown> {
  const { owner, ...rest } = record as Record<string, unknown>;
  assert.match(String(owner), /^[0-9a-f-]{36}$/);
  return rest;
}

function planned(overrides: Record<string, unknown> = {}) {
  return { issueKey: "TLSSN-42", title: "Retry CSV export", changelogId: "10042", tracker: "transitioned", ...overrides } as never;
}

test("announcePlan posts into the bound thread once per transition, or the intake channel, or not at all", async () => {
  const order: string[] = [];
  const bound = ctx({ kv: { ...BOUND }, order });
  const first = (await announcePlan(planned({ url: "https://x.atlassian.net/browse/TLSSN-42" }), bound.context as never)) as Record<string, unknown>;
  assert.deepEqual(first, { posted: true, reason: "posted_in_thread", issueKey: "TLSSN-42", channel: "C0123ABCD", inThread: true, plan: "no_plan_comment" });
  assert.equal(bound.posts.length, 1);
  assert.equal(bound.posts[0]?.["channel"], "C0123ABCD");
  assert.equal(bound.posts[0]?.["thread_ts"], "1758510000.123456");
  assert.equal(
    bound.posts[0]?.["text"],
    [
      "<@U0ALICE01> TLSSN-42 is planned: Retry CSV export.",
      "The plan is on the ticket: https://example.atlassian.net/browse/TLSSN-42",
      "React ✅ to start the build or ❌ to stop.",
    ].join("\n")
  );
  assert.deepEqual(
    (bound.posts[0]?.["blocks"] as { type: string }[]).map((block) => block.type),
    ["header", "context", "divider", "section", "context"]
  );
  const postAt = order.indexOf("post");
  const claimAt = order.indexOf(`put:${PLANNED_KEY}`);
  assert.ok(claimAt !== -1 && postAt !== -1 && claimAt < postAt);
  assert.deepEqual(withoutOwner(bound.kv[PLANNED_KEY]), { title: "Retry CSV export", channel: "C0123ABCD", ts: "1758510001.000100", at: "2026-09-22T00:00:00.000Z", state: "done" });
  // The plan's thread now maps to this ticket, so a plain `approve` there is `approve TLSSN-42`.
  assert.deepEqual(bound.kv["thread-tickets/C0123ABCD:1758510000.123456"], ["TLSSN-42"]);

  const redelivered = (await announcePlan(planned({ title: "A later title" }), bound.context as never)) as Record<string, unknown>;
  assert.deepEqual(redelivered, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  assert.equal(bound.posts.length, 1);

  const replanned = (await announcePlan(planned({ changelogId: "10077" }), bound.context as never)) as Record<string, unknown>;
  assert.deepEqual(replanned, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  assert.equal(bound.posts.length, 1);
  assert.equal(bound.kv["announced/TLSSN-42:Planned:10077"], undefined);

  process.env["FACTORY_DESK_INTAKE_CHANNEL"] = "C0INTAKE01";
  const unbound = ctx();
  const fallback = (await announcePlan(planned({ issueKey: "TLSSN-7", title: "x" }), unbound.context as never)) as Record<string, unknown>;
  assert.equal(fallback["reason"], "opened_intake_thread");
  assert.equal(fallback["rootTs"], "1758510001.000100");
  assert.deepEqual(unbound.posts.map((post) => [post["channel"], post["thread_ts"]]), [
    ["C0INTAKE01", undefined],
    ["C0INTAKE01", "1758510001.000100"],
  ]);
  assert.deepEqual(unbound.kv["ticket/TLSSN-7"], {
    channelId: "C0INTAKE01",
    threadTs: "1758510001.000100",
    root: "jira",
    boundAt: "2026-09-22T00:00:00.000Z",
    rootStatus: { status: "Planned", rank: 1, changelogId: "10042" },
  });
  delete process.env["FACTORY_DESK_INTAKE_CHANNEL"];

  const nowhere = (await announcePlan(planned({ issueKey: "TLSSN-8" }), ctx().context as never)) as Record<string, unknown>;
  assert.deepEqual(nowhere, { posted: false, reason: "no_thread_and_no_intake_channel", issueKey: "TLSSN-8" });

});

// The claim names the Plan: comment the post carries. A redelivery or a bounce
// finds the same comment and posts nothing; a replan's new comment posts.
test("announcePlan posts a replan's new Plan: comment, and the same plan only once", async () => {
  const planA = { id: "10301", body: "Plan: TLSSN-42 Retry CSV export\nSummary: first plan\nBrief:\nDo A." };
  const planB = { id: "10355", body: "Plan: TLSSN-42 Retry CSV export\nSummary: second plan\nBrief:\nDo B." };
  const first = ctx({ kv: { ...BOUND }, jiraStatus: "Planned", comments: ["Triage: bug\nSeverity: high", planA] });
  const posted = (await announcePlan(planned(), first.context as never)) as Record<string, unknown>;
  assert.equal(posted["posted"], true);
  assert.equal(posted["plan"], "digest");
  assert.equal(first.posts.length, 1);
  assert.match(String(first.posts[0]?.["text"]), /TLSSN-42 is planned/);
  assert.match(String(first.posts[0]?.["text"]), /focusedCommentId=10301/);
  assert.equal(withoutOwner(first.kv["announced/TLSSN-42:Planned:plan-10301"])["state"], "done");
  assert.equal(withoutOwner(first.kv["announced/TLSSN-42:Planned:plan-10301"])["planCommentId"], "10301");
  assert.equal(first.kv[PLANNED_KEY], undefined);

  const redelivered = (await announcePlan(planned(), first.context as never)) as Record<string, unknown>;
  assert.deepEqual(redelivered, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  const bounced = (await announcePlan(planned({ changelogId: "10061" }), first.context as never)) as Record<string, unknown>;
  assert.deepEqual(bounced, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  assert.equal(first.posts.length, 1);

  const replanned = ctx({ kv: first.kv, posts: first.posts, jiraStatus: "Planned", comments: ["Triage: bug\nSeverity: high", planA, planB] });
  const again = (await announcePlan(planned({ changelogId: "10077" }), replanned.context as never)) as Record<string, unknown>;
  assert.equal(again["posted"], true);
  assert.equal(replanned.posts.length, 2);
  assert.match(String(replanned.posts[1]?.["text"]), /TLSSN-42 is planned/);
  assert.match(String(replanned.posts[1]?.["text"]), /focusedCommentId=10355/);
  assert.equal(withoutOwner(replanned.kv["announced/TLSSN-42:Planned:plan-10355"])["state"], "done");

  const same = (await announcePlan(planned({ changelogId: "10078" }), replanned.context as never)) as Record<string, unknown>;
  assert.deepEqual(same, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  assert.equal(replanned.posts.length, 2);
});

// The intake root's status line never moves back, so after Approved → Planned
// it still shows Approved. The live status decides; the root only stands in
// when Jira cannot be read.
test("announcePlan posts a replan on a Jira-filed ticket whose root still shows Approved, when Jira says it is Planned", async () => {
  const root = { "ticket/TLSSN-42": { channelId: "C0INTAKE01", threadTs: "1758510000.123456", root: "jira", rootStatus: { status: "Approved", rank: 2, changelogId: "TLSSN-42:Approved:2026-09-25T02:06:00.000+1000" } } };
  const live = ctx({ kv: { ...root }, jiraStatus: "Planned", comments: [{ id: "10355", body: "Plan: TLSSN-42 Retry CSV export\nSummary: second plan\nBrief:\nDo B." }] });
  const posted = (await announcePlan(planned({ changelogId: "TLSSN-42:Planned:2026-09-25T02:20:00.000+1000" }), live.context as never)) as Record<string, unknown>;
  assert.equal(posted["posted"], true);
  assert.deepEqual(live.posts.map((post) => [post["channel"], post["thread_ts"]]), [["C0INTAKE01", "1758510000.123456"]]);

  const unreadable = ctx({ kv: { ...root } });
  const skipped = (await announcePlan(planned(), unreadable.context as never)) as Record<string, unknown>;
  assert.deepEqual(skipped, { posted: false, reason: "past_planned", issueKey: "TLSSN-42" });
  assert.equal(unreadable.posts.length, 0);
});

test("announcePlan skips once the ticket is past Planned, even on a new changelog", async () => {
  for (const status of ["Approved", "In Progress", "Implementing", "Done"]) {
    const c = ctx({ kv: { ...BOUND }, jiraStatus: status });
    const result = (await announcePlan(planned({ changelogId: "10099" }), c.context as never)) as Record<string, unknown>;
    assert.deepEqual(result, { posted: false, reason: "past_planned", issueKey: "TLSSN-42" }, status);
    assert.equal(c.posts.length, 0, status);
    assert.equal(c.kv[PLANNED_KEY], undefined, status);
  }

  const fromRoot = ctx({
    kv: {
      "ticket/TLSSN-42": {
        ...BOUND["ticket/TLSSN-42"],
        root: "jira",
        rootStatus: { status: "Approved", rank: 2, changelogId: "2" },
      },
    },
  });
  const skipped = (await announcePlan(planned(), fromRoot.context as never)) as Record<string, unknown>;
  assert.deepEqual(skipped, { posted: false, reason: "past_planned", issueKey: "TLSSN-42" });
  assert.equal(fromRoot.posts.length, 0);
});

test("a plan in the watched intake channel asks for the decision with bare replies; the brief is not posted", async () => {
  const intake = ctx({ kv: { "ticket/TLSSN-42": { channelId: "C0EXAMPLE1", threadTs: "1790366941.085899", originatorUserId: "U0EXAMPLE3" } }, comments: [{ id: "10077", body: DIGEST_COMMENT }] });
  await announcePlan(planned(), intake.context as never);
  const post = intake.posts[0]!;
  const blocks = post["blocks"] as { type: string; text?: { text: string } }[];
  const decision = blocks.find((block) => block.text?.text.startsWith("<@U0EXAMPLE3>, react"))?.text?.text;
  assert.equal(decision, "<@U0EXAMPLE3>, react ✅ to start the build or ❌ to stop, or reply `approve` / `deny`.");
  assert.doesNotMatch(JSON.stringify(post), /Implement Jira TLSSN-42|```/);
});

test("announcePlan reads the latest Plan: comment and links it by comment id", async () => {
  const c = ctx({ kv: { ...BOUND }, comments: [{ id: "10001", body: "Triage: bug" }, { id: "10077", body: DIGEST_COMMENT }] });
  const result = (await announcePlan(planned({ title: "Retry CSV export on empty filter" }), c.context as never)) as Record<string, unknown>;
  assert.equal(result["plan"], "digest");
  assert.deepEqual(c.mcpCalls, [{ tool: "getJiraIssueComments", issueIdOrKey: "TLSSN-42" }]);
  const post = c.posts[0]!;
  const blocks = post["blocks"] as { type: string; text?: { text: string }; elements?: { text: string }[] }[];
  assert.equal(blocks[0]?.text?.text, "TLSSN-42 is planned: Retry CSV export on empty filter");
  assert.ok(blocks.some((block) => block.text?.text === "*Files or areas*\n\u2022 src/export/csv.ts\n\u2022 src/export/csv.test.ts"));
  assert.match(
    blocks.at(-1)?.elements?.[0]?.text ?? "",
    /<https:\/\/[^|>]+\/browse\/TLSSN-42\?focusedCommentId=10077\|Full plan and worker brief>/
  );
  assert.match(String(post["text"]), /\nRisk: Medium\./);

  const offline = ctx({ kv: { ...BOUND }, connected: false });
  const bare = (await announcePlan(planned(), offline.context as never)) as Record<string, unknown>;
  assert.equal(bare["posted"], true);
  assert.equal(bare["plan"], "not_connected");
  assert.doesNotMatch(String(offline.posts[0]?.["text"]), /Problem:/);

  const broken = ctx({ kv: { ...BOUND }, commentsThrow: true });
  const failed = (await announcePlan(planned(), broken.context as never)) as Record<string, unknown>;
  assert.equal(failed["posted"], true);
  assert.equal(failed["plan"], "failed");
});

test("an unreadable announced claim fails closed, and a failed claim write does not post", async () => {
  const unread = ctx({ kv: { ...BOUND }, announcedGetThrows: true });
  const posted = (await announcePlan(planned(), unread.context as never)) as Record<string, unknown>;
  assert.deepEqual(posted, { posted: false, reason: "failed", issueKey: "TLSSN-42" });
  assert.equal(unread.posts.length, 0);

  const held = { title: "Retry CSV export", channel: "C0123ABCD", ts: "1758510001.000100", at: "2026-09-21T00:00:00.000Z", state: "done", owner: "an-earlier-delivery" };
  const unreadHeld = ctx({ kv: { ...BOUND, [PLANNED_KEY]: held }, announcedGetThrows: true });
  assert.deepEqual(await announcePlan(planned(), unreadHeld.context as never), { posted: false, reason: "failed", issueKey: "TLSSN-42" });
  assert.equal(unreadHeld.posts.length, 0);
  assert.deepEqual(unreadHeld.kv[PLANNED_KEY], held);

  const progress = ctx({ kv: { ...BOUND, [PROGRESS_KEY]: held }, comments: IMPLEMENTING, announcedGetThrows: true });
  const skipped = (await announceProgress({ issueKey: "TLSSN-42", changelogId: "10043" } as never, progress.context as never)) as Record<string, unknown>;
  assert.equal(skipped["posted"], false);
  assert.equal(skipped["reason"], "failed");
  assert.equal(progress.posts.length, 0);

  const refused = ctx({ kv: { ...BOUND }, putThrows: true });
  const failed = (await announcePlan(planned(), refused.context as never)) as Record<string, unknown>;
  assert.deepEqual(failed, { posted: false, reason: "failed", issueKey: "TLSSN-42" });
  assert.equal(refused.posts.length, 0);
});

test("a post that throws does not drop a claim another delivery now holds", async () => {
  const theirs = { title: "Retry CSV export", channel: "C0123ABCD", state: "pending", owner: "another-delivery", at: "2026-09-22T00:00:01.000Z" };
  const c = ctx({ kv: { ...BOUND }, postThrows: true, onPost: (kv) => void (kv[PLANNED_KEY] = theirs) });
  await assert.rejects(announcePlan(planned(), c.context as never), /slack down/);
  assert.deepEqual(c.kv[PLANNED_KEY], theirs);
});

test("a posted update does not write its ts over a claim another delivery now holds", async () => {
  const theirs = { title: "Retry CSV export", channel: "C0123ABCD", state: "pending", owner: "another-delivery", at: "2026-09-22T00:00:01.000Z" };
  const c = ctx({ kv: { ...BOUND }, onPost: (kv) => void (kv[PLANNED_KEY] = theirs) });
  const result = (await announcePlan(planned(), c.context as never)) as Record<string, unknown>;
  assert.equal(result["posted"], true);
  assert.deepEqual(c.kv[PLANNED_KEY], theirs);
});

test("an update whose thread vanished before the post releases only its own claim, so a delivery after the rebind posts", async () => {
  const update = { issueKey: "TLSSN-42", title: "Retry CSV export", status: "Planned", text: "planned" };
  const theirs = { title: "Retry CSV export", channel: "C0123ABCD", state: "pending", owner: "another-delivery", at: "2026-09-22T00:00:01.000Z" };
  const raced = ctx({ kv: { ...BOUND } });
  const takenOver = async () => {
    delete raced.kv["ticket/TLSSN-42"];
    raced.kv[PLANNED_KEY] = theirs;
    return {};
  };
  const lost = await announceTicketUpdate(raced.context as never, { changelogId: "10042", update, record: { title: "Retry CSV export" }, prepare: takenOver });
  assert.deepEqual(lost, { posted: false, reason: "no_thread_and_no_intake_channel", issueKey: "TLSSN-42" });
  assert.equal(raced.posts.length, 0);
  assert.deepEqual(raced.kv[PLANNED_KEY], theirs);

  const c = ctx({ kv: { ...BOUND } });
  const vanish = async () => {
    delete c.kv["ticket/TLSSN-42"];
    return {};
  };
  const result = await announceTicketUpdate(c.context as never, { changelogId: "10042", update, record: { title: "Retry CSV export" }, prepare: vanish });
  assert.deepEqual(result, { posted: false, reason: "no_thread_and_no_intake_channel", issueKey: "TLSSN-42" });
  assert.equal(c.kv[PLANNED_KEY], undefined);
  c.kv["ticket/TLSSN-42"] = BOUND["ticket/TLSSN-42"];
  const again = await announceTicketUpdate(c.context as never, { changelogId: "10042", update, record: { title: "Retry CSV export" } });
  assert.equal(again["posted"], true);
  assert.equal(c.posts.length, 1);
});

test("file_ticket: a binding put that lands but reports an error is verified and reported bound", async () => {
  const c = ctx({ auth: slackAuth("C0123ABCD", "1758510000.123456"), putLandsThenThrows: true });
  const result = (await fileTicket.execute!({ title: "CSV export returns 500", description: "Since this morning.", kind: "bug" } as never, c.context as never)) as Record<string, unknown>;
  assert.equal(result["threadBound"], true);
  assert.equal(result["threadBindingError"], undefined);
  assert.deepEqual(c.kv["ticket/TLSSN-42"], { channelId: "C0123ABCD", threadTs: "1758510000.123456", filedAt: "2026-09-22T00:00:00.000Z" });
});

test("the claim is read then written before the post, and a held claim does not post", async () => {
  const order: string[] = [];
  const fresh = ctx({ order, kv: { ...BOUND } });
  const posted = (await announcePlan(planned(), fresh.context as never)) as Record<string, unknown>;
  assert.equal(posted["posted"], true);
  const postAt = order.indexOf("post");
  const readAt = order.indexOf(`get:${PLANNED_KEY}`);
  const claimAt = order.indexOf(`put:${PLANNED_KEY}`);
  assert.ok(readAt !== -1 && readAt < claimAt && claimAt < postAt);
  assert.equal((fresh.kv[PLANNED_KEY] as Record<string, unknown>)["ts"], "1758510001.000100");

  const held = ctx({
    kv: { ...BOUND, [PLANNED_KEY]: { title: "Older title", channel: "C0123ABCD", ts: "1.2", at: "2026-09-21T00:00:00.000Z" } },
  });
  const again = (await announcePlan(planned({ title: "A different title" }), held.context as never)) as Record<string, unknown>;
  assert.equal(again["reason"], "already_announced");
  assert.equal(held.posts.length, 0);
});

const IMPLEMENTING = ["Triage: bug", "Plan: TLSSN-42 Retry CSV export", "Implementing: https://cursor.com/agents/bc-1234"];

test("announceProgress posts the agent URL from the Implementing: comment once per transition", async () => {
  const order: string[] = [];
  const c = ctx({ order, kv: { ...BOUND }, comments: IMPLEMENTING });
  const first = (await announceProgress({ issueKey: "TLSSN-42", changelogId: "10043" } as never, c.context as never)) as Record<string, unknown>;
  assert.deepEqual(first, {
    posted: true,
    reason: "posted_in_thread",
    issueKey: "TLSSN-42",
    url: "https://cursor.com/agents/bc-1234",
    channel: "C0123ABCD",
    inThread: true,
  });
  assert.deepEqual(c.posts, [
    { channel: "C0123ABCD", thread_ts: "1758510000.123456", text: `TLSSN-42 is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: https://cursor.com/agents/bc-1234` },
  ]);
  assert.deepEqual(c.mcpCalls, [{ tool: "getJiraIssueComments", issueIdOrKey: "TLSSN-42" }]);
  const progressClaimAt = order.indexOf(`put:${PROGRESS_KEY}`);
  assert.ok(progressClaimAt !== -1 && progressClaimAt < order.indexOf("post"));
  assert.deepEqual(withoutOwner(c.kv[PROGRESS_KEY]), { url: "https://cursor.com/agents/bc-1234", channel: "C0123ABCD", ts: "1758510001.000100", at: "2026-09-22T00:00:00.000Z", state: "done" });

  const redelivered = (await announceProgress({ issueKey: "TLSSN-42", changelogId: "10043" } as never, c.context as never)) as Record<string, unknown>;
  assert.deepEqual(redelivered, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  assert.equal(c.posts.length, 1);
});

test("announceProgress without an Implementing: comment posts nothing and claims nothing", async () => {
  const c = ctx({ kv: { ...BOUND }, comments: ["Triage: bug", "Plan: TLSSN-42 Retry"] });
  const result = (await announceProgress({ issueKey: "TLSSN-42", changelogId: "10043" } as never, c.context as never)) as Record<string, unknown>;
  assert.deepEqual(result, { posted: false, reason: "no_implementing_comment", issueKey: "TLSSN-42" });
  assert.equal(c.posts.length, 0);
  assert.equal(c.kv[PROGRESS_KEY], undefined);
});

test("announceProgress uses the intake channel and reports a missing connector", async () => {
  process.env["FACTORY_DESK_INTAKE_CHANNEL"] = "C0INTAKE01";
  try {
    const unbound = ctx({ comments: IMPLEMENTING });
    const result = (await announceProgress({ issueKey: "TLSSN-42", changelogId: "10043" } as never, unbound.context as never)) as Record<string, unknown>;
    assert.equal(result["reason"], "opened_intake_thread");
    assert.deepEqual(unbound.posts.map((post) => [post["channel"], post["thread_ts"], post["text"]]), [
      ["C0INTAKE01", undefined, "TLSSN-42: TLSSN-42\nStatus: *In Progress*  \u00b7  <https://example.atlassian.net/browse/TLSSN-42|TLSSN-42 on Jira>\nFiled in Jira, not from Slack. Approve, replan, or retry it on the Jira board."],
      ["C0INTAKE01", "1758510001.000100", `TLSSN-42 is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: https://cursor.com/agents/bc-1234`],
    ]);
    assert.deepEqual(unbound.kv["ticket/TLSSN-42"], {
      channelId: "C0INTAKE01",
      threadTs: "1758510001.000100",
      root: "jira",
      boundAt: "2026-09-22T00:00:00.000Z",
      rootStatus: { status: "In Progress", rank: 3, changelogId: "10043" },
    });
  } finally {
    delete process.env["FACTORY_DESK_INTAKE_CHANNEL"];
  }

  const offline = ctx({ kv: { ...BOUND }, connected: false });
  assert.deepEqual(await announceProgress({ issueKey: "TLSSN-42", changelogId: "10043" } as never, offline.context as never), {
    posted: false,
    reason: "not_connected",
    issueKey: "TLSSN-42",
  });
});

test("a plan or progress post that throws drops the claim", async () => {
  const plan = ctx({ kv: { ...BOUND }, postThrows: true });
  await assert.rejects(announcePlan(planned(), plan.context as never), /slack down/);
  assert.equal(plan.posts.length, 1);
  assert.equal(plan.kv[PLANNED_KEY], undefined);

  const progress = ctx({ kv: { ...BOUND }, comments: IMPLEMENTING, postThrows: true });
  await assert.rejects(announceProgress({ issueKey: "TLSSN-42", changelogId: "10043" } as never, progress.context as never), /slack down/);
  assert.equal(progress.kv[PROGRESS_KEY], undefined);
});

const JEV_TRIAGE =
  "Triage: bug\nType: Bug\nSeverity: medium\nSummary: x\nJudge: Jev type Bug 1.00 (set in Jira; agreed); severity medium 0.76 (agreed)";

test("triaged claims are per verdict, not per changelog", () => {
  const fingerprint = triagedVerdictFingerprint({
    verdict: { kind: "bug", severity: "medium", issueType: "Bug", jev: { type: { choice: "Bug", probability: "1.00", outcome: "set" }, severity: { choice: "medium", probability: "0.76", outcome: "agreed" } } },
  });
  assert.equal(fingerprint, "bug.medium.plan.bug.medium.first");
  assert.equal(triagedAnnounceKey({ issueKey: "TLSSN-29", status: "Triaged", fingerprint }), "announced/TLSSN-29:Triaged:verdict-bug.medium.plan.bug.medium.first");
  assert.notEqual(
    fingerprint,
    triagedVerdictFingerprint({
      verdict: { kind: "bug", severity: "low", issueType: "Story", jev: { type: { choice: "Story", probability: "0.97", outcome: "already" }, severity: { choice: "low", probability: "0.9", outcome: "agreed" } } },
    })
  );
});

test("announceTriaged posts once per unchanged Jev; a Needs-info bounce does not repeat it", async () => {
  const first = ctx({ kv: { ...BOUND }, comments: [JEV_TRIAGE] });
  const posted = (await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10030" } as never, first.context as never)) as Record<string, unknown>;
  assert.equal(posted["posted"], true);
  assert.match(String(first.posts[0]?.["text"]), /^TLSSN-42 is Triaged: Bug, medium severity\./);
  assert.equal(first.posts[1]?.["text"], "TLSSN-42: planner is checking the code…");
  assert.equal(withoutOwner(first.kv["announced/TLSSN-42:Triaged:verdict-bug.medium.plan.bug.medium.first"])["state"], "done");

  const bounce = ctx({
    kv: first.kv,
    posts: first.posts,
    comments: [JEV_TRIAGE, "Detail from Slack: TLSSN-42\nAlice replied.\n\nIt is /export", "Needs info: TLSSN-42\nClaimed failure is not on main."],
  });
  const again = (await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10045" } as never, bounce.context as never)) as Record<string, unknown>;
  assert.deepEqual(again, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  assert.equal(bounce.posts.filter((post) => String(post["text"]).startsWith("TLSSN-42 is Triaged:")).length, 1);

  const changed = ctx({
    kv: first.kv,
    posts: first.posts,
    comments: ["Triage: bug\nType: Story\nSeverity: low\nJudge: Jev type Story 0.97 (already Story in Jira; agreed); severity low 0.9 (agreed)"],
  });
  const fresh = (await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10046" } as never, changed.context as never)) as Record<string, unknown>;
  assert.equal(fresh["posted"], true);
  assert.match(String(changed.posts.at(-1)?.["text"] ?? changed.posts.at(-2)?.["text"]), /is Triaged: Story, low severity/);
});

const PLAN_ON_TICKET = "Plan: TLSSN-42 Retry CSV export\nSummary: first plan\nBrief:\nDo A.";
const triagedLines = (posts: Record<string, unknown>[]) => posts.filter((post) => /^TLSSN-42 is Triaged/.test(String(post["text"])));

test("a plan KEY bounce after a Plan: comment does not repost the unchanged Triaged line; the planner crumb comes back", async () => {
  const first = ctx({ kv: { ...BOUND }, comments: [JEV_TRIAGE] });
  await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10030" } as never, first.context as never);
  delete first.kv[loaderKey("TLSSN-42")];

  const bounce = ctx({ kv: first.kv, posts: first.posts, comments: [JEV_TRIAGE, PLAN_ON_TICKET] });
  const again = (await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10060" } as never, bounce.context as never)) as Record<string, unknown>;
  assert.deepEqual(again, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  assert.equal(triagedLines(bounce.posts).length, 1);
  assert.equal(bounce.posts.at(-1)?.["text"], loaderMessage("TLSSN-42", "replanning"));
});

test("a clarification that answers triage's needs-info verdict does not post a second Triaged block; the re-planning crumb shows", async () => {
  const gated = "Triage: bug\nType: Bug\nSeverity: medium\nNext step: Name the export URL.\nNeeds info: Name the export URL.";
  const first = ctx({ kv: { ...BOUND }, comments: [gated] });
  const posted = (await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10030" } as never, first.context as never)) as Record<string, unknown>;
  assert.equal(posted["posted"], true);
  assert.equal(triagedLines(first.posts).length, 1);

  const answered = ctx({ kv: first.kv, posts: first.posts, comments: [gated, "Detail from Slack: TLSSN-42\nAlice replied.\n\nIt is /export"] });
  const again = (await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10045" } as never, answered.context as never)) as Record<string, unknown>;
  assert.deepEqual(again, { posted: false, reason: "already_announced", issueKey: "TLSSN-42" });
  assert.equal(triagedLines(answered.posts).length, 1);
  assert.equal(answered.posts.at(-1)?.["text"], loaderMessage("TLSSN-42", "replanning"));
});

test("every Triaged entry is recorded for the Needs info claim, newest changelog wins", async () => {
  const c = ctx({ kv: { ...BOUND }, comments: [JEV_TRIAGE] });
  await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10045" } as never, c.context as never);
  await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10030" } as never, c.context as never);
  assert.equal(c.kv[triagedEntryKey("TLSSN-42")], "10045");
  await announceTriaged({ issueKey: "TLSSN-42", changelogId: "10060" } as never, c.context as never);
  assert.equal(c.kv[triagedEntryKey("TLSSN-42")], "10060");
});

import assert from "node:assert/strict";
import { loaderKey } from "../lib/loader.js";
import { PLANNER_SENT_MS, moveToPlanner, plannerSentKey, sentToPlannerRecently } from "../lib/plan-move.js";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import { BACKLINK_RETRY_MS } from "../lib/intake-backlink.js";
import { backlinkComment } from "../lib/slack-link.js";
import {
  INTAKE_CHANNEL,
  JIRA_FILED_DESCRIPTION,
  JIRA_FILED_KEY,
  JIRA_FILED_TITLE,
  PLAN_COMMENT,
  PLANNED,
  SLACK_FILED_DESCRIPTION,
  TRIAGE_COMMENT,
  TRIAGED,
} from "../lib/jira-originated.fixtures.js";
import { racingStores, recordKv } from "../lib/kv-race.fixtures.js";
import { markFiledTriage } from "../lib/announce.js";
import { planFiling, settleFiling } from "../lib/intake-triage.js";
import channel from "./jira.js";

// The lifecycle announcements are reachable only through this signed
// webhook: no model tool posts them.

const ENV = { JIRA_WEBHOOK_SECRET: "test-secret", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_DESK_CLAIM_SETTLE_MS: "5" } as const;
const saved: Record<string, string | undefined> = {};

const retryPauses = [...BACKLINK_RETRY_MS];

before(() => {
  BACKLINK_RETRY_MS.splice(0, BACKLINK_RETRY_MS.length, 0, 0, 0);
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

after(() => {
  BACKLINK_RETRY_MS.splice(0, BACKLINK_RETRY_MS.length, ...retryPauses);
  for (const name of Object.keys(ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

type Handler = (request: Request, ctx: unknown) => Promise<Response>;
const handler = (channel as unknown as { routes: Array<{ handler: Handler }> }).routes[0]!.handler;

function approvedEvent() {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { key: "TLSSN-42", fields: { summary: "CSV export 500", status: { name: "Approved" }, project: { key: "TLSSN" } } },
    changelog: { id: "10050", items: [{ field: "status", fromString: "Planned", toString: "Approved" }] },
  };
}

function host(kv: Record<string, unknown>, posts: Record<string, unknown>[], comments?: unknown[], extras: { deletes?: Record<string, unknown>[]; updates?: Record<string, unknown>[] } = {}) {
  let n = 0;
  return {
    kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
    slack: {
      getClient: async () => ({
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            posts.push(args);
            n += 1;
            return { ok: true, ts: `1758510002.${String(n).padStart(6, "0")}` };
          },
          update: async (args: Record<string, unknown>) => {
            extras.updates?.push(args);
            return { ok: true };
          },
          delete: async (args: Record<string, unknown>) => {
            extras.deletes?.push(args);
            return { ok: true };
          },
        },
      }),
    },
    mcp: comments === undefined ? { names: () => [], listTools: async () => [], callTool: async (): Promise<HostMcpCallResult> => ({ content: [] }) } : jiraWithComments(comments),
  };
}

function jiraWithComments(comments: unknown[]) {
  return {
    names: () => ["tracker"],
    listTools: async () => [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } }],
    callTool: async (): Promise<HostMcpCallResult> => ({
      content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields: { comment: { comments: comments.map((body, i) => ({ id: String(i + 1), body })) } } }) }],
    }),
  };
}

async function deliver(
  body: unknown,
  signature: (raw: string) => string | undefined,
  kv: Record<string, unknown>,
  posts: Record<string, unknown>[],
  comments?: unknown[],
  extras: { deletes?: Record<string, unknown>[]; updates?: Record<string, unknown>[] } = {}
) {
  const raw = JSON.stringify(body);
  const sig = signature(raw);
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: sig === undefined ? {} : { "x-hub-signature-256": sig } });
  const background: Promise<unknown>[] = [];
  const response = await handler(request, { host: host(kv, posts, comments, extras), waitUntil: (promise: Promise<unknown>) => void background.push(promise), body });
  await Promise.all(background);
  return response;
}

function moved(from: string, to: string, id: string) {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { key: "TLSSN-42", fields: { summary: "CSV export 500", status: { name: to }, project: { key: "TLSSN" } } },
    changelog: { id, items: [{ field: "status", fromString: from, toString: to }] },
  };
}

const sign = (raw: string) => `sha256=${createHmac("sha256", ENV.JIRA_WEBHOOK_SECRET).update(raw).digest("hex")}`;
const BOUND = { "ticket/TLSSN-42": { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE01" } };

test("a signed Jira move into Approved posts the Approved line into the ticket's thread from host code", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const response = await deliver(approvedEvent(), sign, kv, posts);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, kind: "approved", issueKey: "TLSSN-42" });
  assert.deepEqual(
    posts.map((post) => [post["channel"], post["thread_ts"]]),
    [["C0123ABCD", "1758510000.123456"]]
  );
  assert.match(String(posts[0]?.["text"]), /TLSSN-42 is Approved/);
  const claim = kv["announced/TLSSN-42:Approved:10050"] as Record<string, unknown>;
  assert.equal(claim["state"], "done");
  assert.equal(typeof claim["owner"], "string");
});

test("a Jira move authenticated with X-Factory-Webhook-Secret posts the Approved line", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const raw = JSON.stringify(approvedEvent());
  const request = new Request("http://desk/v1/channels/jira", {
    method: "POST",
    body: raw,
    headers: { "x-factory-webhook-secret": ENV.JIRA_WEBHOOK_SECRET },
  });
  const background: Promise<unknown>[] = [];
  const response = await handler(request, {
    host: host(kv, posts),
    waitUntil: (promise: Promise<unknown>) => void background.push(promise),
    body: approvedEvent(),
  });
  await Promise.all(background);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, kind: "approved", issueKey: "TLSSN-42" });
  assert.match(String(posts[0]?.["text"]), /TLSSN-42 is Approved/);
});

test("a signed Jira move into In Review, then Done, posts each line into the ticket's thread and never offers a merge", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const moved = (from: string, to: string, id: string) => ({
    webhookEvent: "jira:issue_updated",
    issue: { key: "TLSSN-42", fields: { summary: "CSV export 500", status: { name: to }, project: { key: "TLSSN" } } },
    changelog: { id, items: [{ field: "status", fromString: from, toString: to }] },
  });
  const deletes: Record<string, unknown>[] = [];
  const review = await deliver(moved("In Progress", "In Review", "10060"), sign, kv, posts, undefined, { deletes });
  assert.deepEqual(await review.json(), { ok: true, kind: "in_review", issueKey: "TLSSN-42" });
  assert.equal(posts[1]?.["text"], "TLSSN-42: checks running…", "the wait for Bugbot, security, and CI gets one crumb");
  const crumbTs = (kv["loader/TLSSN-42"] as Record<string, unknown>)["ts"];
  posts.splice(1, 1);
  const done = await deliver(moved("In Review", "Done", "10070"), sign, kv, posts, undefined, { deletes });
  assert.deepEqual(await done.json(), { ok: true, kind: "done", issueKey: "TLSSN-42" });
  assert.deepEqual(deletes, [{ channel: "C0123ABCD", ts: crumbTs }], "Done deletes the reviewing crumb");
  assert.equal(kv["loader/TLSSN-42"], undefined);
  const redelivered = await deliver(moved("In Review", "Done", "10070"), sign, kv, posts);
  assert.equal(redelivered.status, 200);

  assert.deepEqual(
    posts.map((post) => [post["channel"], post["thread_ts"]]),
    [
      ["C0123ABCD", "1758510000.123456"],
      ["C0123ABCD", "1758510000.123456"],
    ]
  );
  assert.equal(
    posts[0]?.["text"],
    `TLSSN-42 is In Review. No pull request link is on the ticket; the factory's pull request title starts with "TLSSN-42: ".`
  );
  assert.doesNotMatch(String(posts[0]?.["text"]), /\bis open\b/);
  assert.equal(posts[1]?.["text"], "TLSSN-42 is Done. No pull request link is on the ticket.");
  assert.equal((kv["announced/TLSSN-42:In Review:10060"] as Record<string, unknown>)["state"], "done");
  assert.equal((kv["announced/TLSSN-42:Done:10070"] as Record<string, unknown>)["state"], "done");
});

test("Done names the human merger when the worker left Merged by: <login>", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const comments = [
    "Implementing: https://cursor.com/agents/bc-23",
    "Pull request: https://github.com/cursor-demo-lab/marsbank/pull/20",
    "Merged by: example-user",
  ];
  await deliver(moved("In Progress", "In Review", "10081"), sign, kv, posts, comments);
  await deliver(moved("In Review", "Done", "10082"), sign, kv, posts, comments);
  assert.deepEqual(posts.map((post) => post["text"]), [
    "TLSSN-42 is In Review: <https://github.com/cursor-demo-lab/marsbank/pull/20|cursor-demo-lab/marsbank#20> is open.",
    "TLSSN-42: checks running…",
    "TLSSN-42 is Done: <https://github.com/cursor-demo-lab/marsbank/pull/20|cursor-demo-lab/marsbank#20> was merged by example-user.",
  ]);
});

test("Done without Merged by: keeps was merged, and a hand-drag without a PR stays unlinked", async () => {
  const linked: Record<string, unknown> = { ...BOUND };
  const linkedPosts: Record<string, unknown>[] = [];
  await deliver(
    moved("In Review", "Done", "10083"),
    sign,
    linked,
    linkedPosts,
    ["Pull request: https://github.com/cursor-demo-lab/marsbank/pull/20"]
  );
  assert.equal(
    linkedPosts[0]?.["text"],
    "TLSSN-42 is Done: <https://github.com/cursor-demo-lab/marsbank/pull/20|cursor-demo-lab/marsbank#20> was merged."
  );

  const dragged: Record<string, unknown> = { ...BOUND };
  const draggedPosts: Record<string, unknown>[] = [];
  await deliver(moved("In Review", "Done", "10084"), sign, dragged, draggedPosts, ["Implementing: https://cursor.com/agents/bc-23"]);
  assert.equal(draggedPosts[0]?.["text"], "TLSSN-42 is Done. No pull request link is on the ticket.");
});

test("In Review links the implement PR when Jira hands the Pull request: comment back as a smart link card or a markdown link", async () => {
  const url = "https://github.com/cursor-demo-lab/marsbank/pull/19";
  const card = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Pull request: " }, { type: "inlineCard", attrs: { url } }] }] };
  for (const [id, comment] of [["10063", card], ["10064", `Pull request: [${url}](${url})`]] as const) {
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    await deliver(moved("In Progress", "In Review", id), sign, kv, posts, [comment]);
    assert.match(String(posts[0]?.["text"]), /^TLSSN-42 is In Review: <https:\/\/github\.com\/cursor-demo-lab\/marsbank\/pull\/19\|cursor-demo-lab\/marsbank#19> is open\.$/, id);
  }
});

test("a card moved to In Review by hand, with no Pull request: comment, keeps the plain line", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  await deliver(moved("In Progress", "In Review", "10062"), sign, kv, posts, ["Implementing: https://cursor.com/agents/bc-23", "see Pull request: https://github.com/a/b/pull/1"]);
  assert.match(String(posts[0]?.["text"]), /^TLSSN-42 is In Review\. No pull request link is on the ticket; /);
});

test("an unsigned or wrongly signed Jira event posts nothing and claims nothing", async () => {
  for (const signature of [() => undefined, () => "sha256=00"]) {
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    const response = await deliver(approvedEvent(), signature, kv, posts);
    assert.equal(response.status, 401);
    assert.deepEqual(posts, []);
    assert.deepEqual(kv, BOUND);
  }
});

test("a signed move into Triaged posts the triage verdict and names both endings, a plan or a Needs info line", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const triage = "Triage: bug\nSeverity: high\nSummary: CSV export 500 on an empty filter.\nNext step: Fix the empty filter.";
  const response = await deliver(moved("To Do", "Triaged", "10030"), sign, kv, posts, ["Filed from Slack.", triage]);
  assert.deepEqual(await response.json(), { ok: true, kind: "triaged", issueKey: "TLSSN-42" });
  assert.deepEqual(
    posts.map((post) => [post["channel"], post["thread_ts"], post["text"]]),
    [
      ["C0123ABCD", "1758510000.123456", "TLSSN-42 is Triaged: bug, high severity."],
      ["C0123ABCD", "1758510000.123456", "TLSSN-42: planner is checking the code…"],
    ]
  );
  assert.equal((kv["announced/TLSSN-42:Triaged:verdict-bug.high.plan.-.-.first"] as Record<string, unknown>)["state"], "done");
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "planning");
});

test("a Triaged verdict the planner skips says so and promises no plan", async () => {
  const cases: Array<[string, RegExp]> = [
    ["Triage: bug\nSeverity: low\nSummary: x\nNext step: Name the <export> URL.\nNeeds info: Name the export URL.", /^TLSSN-42 is Triaged, but triage needs more information: Name the &lt;export&gt; URL\.\nNext: reply here with it\.$/],
    ["Triage: question\nSeverity: low\nSummary: x\nNext step: Answer in the thread.", /^TLSSN-42 is Triaged as a question, so the planner skips it\.$/],
    ["Triage: bug\nSeverity: medium\nSummary: x\nNext step: Close it.\nDuplicate of: TLSSN-19", /^TLSSN-42 is Triaged as a duplicate of TLSSN-19, so the planner skips it\.$/],
  ];
  for (const [triage, line] of cases) {
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    await deliver(moved("To Do", "Triaged", "10031"), sign, kv, posts, [triage]);
    assert.equal(posts.length, 1, triage);
    assert.match(String(posts[0]?.["text"]), line);
    assert.doesNotMatch(String(posts[0]?.["text"]), /planner checks it/);
    assert.equal(kv["loader/TLSSN-42"], undefined, triage);
  }
});

test("a Jira-filed ticket's Triaged line says the verdict and who triaged it in plain words, with no scores", async () => {
  const cases: Array<[string, string]> = [
    [
      // TLSSN-27's live Triage: comment (2026-09-25), written before the Triaged by: line.
      "Triage: bug\nType: Bug\nSeverity: medium\nSummary: x\nNext step: Inspect 9f2c.\nJudge: Jev type Bug 1.00 (set in Jira; agreed); severity medium 0.66 (agreed)",
      `TLSSN-42 is Triaged: Bug, medium severity.`,
    ],
    [
      "Triage: bug\nType: Bug\nSeverity: medium\nSummary: x\nNext step: Inspect 9f2c.\nTriaged by: model (Jev was not above 0.52 on every answer)\nJudge: Jev type Bug 0.93 (set in Jira; model said question); severity medium 0.84 (model said low)",
      `TLSSN-42 is Triaged by Grok 4.6 Fast (Jev didn't settle it): Bug, medium severity.`,
    ],
    [
      "Triage: bug\nType: Bug\nSeverity: high\nSummary: x\nTriaged by: Grok 4.6 Fast (Jev was only 50% confident; not above 0.52 on every answer)\nJudge: Jev type Bug 0.93 (set in Jira; agreed); severity high 0.50 (kept the model's high, below 0.52)",
      `TLSSN-42 is Triaged by Grok 4.6 Fast (Jev was only 50% confident): Bug, high severity.`,
    ],
    [
      "Triage: question\nType: Task\nSeverity: low\nSummary: x\nNext step: Answer in the thread.\nJudge: Jev type Task 0.91 (set in Jira; model said bug); severity low 0.88 (agreed)",
      "TLSSN-42 is Triaged as a question (Jira type Task), so the planner skips it.",
    ],
    [
      "Triage: feedback\nType: Story\nSeverity: low\nSummary: x\nJudge: Jev type Story 0.97 (already Story in Jira; agreed); severity low 0.9 (agreed)",
      `TLSSN-42 is Triaged: Story, low severity.`,
    ],
    [
      "Triage: bug\nType: Task\nSeverity: low\nSummary: x\nJudge: Jev type Bug 0.50 (below 0.52, kept the model's bug); severity high 0.50 (kept the model's low, below 0.52)",
      `TLSSN-42 is Triaged: Task, low severity.`,
    ],
    [
      "Triage: bug\nType: Bug\nSeverity: medium\nSummary: x\nNext step: Inspect 9f2c.\nTriaged by: Jev (84% confidence; type, severity, and gate all above 0.52)\nJudge: Jev type Bug 0.93 (set in Jira; Jev only); severity medium 0.84 (Jev only)",
      `TLSSN-42 is Triaged by Jev: Bug, medium severity (84% confidence).`,
    ],
    [
      "Triage: bug\nType: Bug\nSeverity: medium\nSummary: x\nNext step: Inspect 9f2c.\nJudge: Jev type Bug 0.93 (set in Jira; Jev only); severity medium 0.84 (Jev only)",
      `TLSSN-42 is Triaged by Jev: Bug, medium severity.`,
    ],
  ];
  for (const [triage, text] of cases) {
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    await deliver(moved("To Do", "Triaged", "10034"), sign, kv, posts, [triage]);
    assert.equal(posts[0]?.["text"], text);
    if (!/planner skips it/.test(text)) assert.equal(posts[1]?.["text"], "TLSSN-42: planner is checking the code…");
    else assert.equal(posts.length, 1);
  }
});

test("a Triaged move after a plan is a new plan, and a ticket with no Triage: comment still gets its line", async () => {
  const replan = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  await deliver(moved("To Do", "Triaged", "10032"), sign, replan.kv, replan.posts, ["Triage: bug\nSeverity: high", "Plan: TLSSN-42 CSV export 500\nSummary: x"]);
  assert.match(String(replan.posts[0]?.["text"]), /^TLSSN-42 is Triaged for a new plan: bug, high severity\.$/);
  assert.equal(replan.posts[1]?.["text"], "TLSSN-42: planner is checking the code…");

  const bare = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  await deliver(moved("To Do", "Triaged", "10033"), sign, bare.kv, bare.posts, []);
  assert.equal(bare.posts[0]?.["text"], "TLSSN-42 is Triaged.");
  assert.equal(bare.posts[1]?.["text"], "TLSSN-42: planner is checking the code…");
});

// A ticket filed straight in Jira has no Slack thread until the desk opens
// its intake root. It opens on the first status the desk hears (Triaged), so
// the Triaged line, the planner crumb, the plan, and the status reactions
// follow the same thread a Slack filing gets, and the root's permalink goes
// on the ticket for the planner's brief and the implement PR.
function jiraFiledWorld(input: { description?: string; commentFails?: boolean; commentFailures?: number; intake?: string | null } = {}) {
  const kv: Record<string, unknown> = {};
  const posts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const written: string[] = [];
  const state = { status: "To Do", comments: [] as Array<{ id: string; body: string }> };
  let n = 0;
  let refusals = 0;
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        n += 1;
        return { ok: true, ts: `1758510002.${String(n).padStart(6, "0")}` };
      },
      update: async (args: Record<string, unknown>) => (updates.push(args), { ok: true }),
      delete: async () => ({ ok: true }),
    },
    apiCall: async (method: string, args: Record<string, unknown>) => {
      if (method === "chat.getPermalink") {
        return { ok: true, permalink: `https://<SLACK_WORKSPACE>.slack.com/archives/${String(args["channel"])}/p${String(args["message_ts"]).replace(".", "")}` };
      }
      if (method.startsWith("reactions.")) reactions.push(`${method.replace("reactions.", "")} ${String(args["name"])} ${String(args["channel"])}:${String(args["timestamp"])}`);
      return { ok: true };
    },
  };
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, fields: { type: "array" } } } },
      { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, commentBody: { type: "string" } } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown>): Promise<HostMcpCallResult> => {
      if (tool === "addCommentToJiraIssue") {
        refusals += 1;
        if (input.commentFails === true || refusals <= (input.commentFailures ?? 0)) return { content: [{ type: "text", text: "comment refused" }], isError: true };
        const body = String(args["commentBody"]);
        written.push(body);
        state.comments.push({ id: String(20900 + written.length), body });
        return { content: [{ type: "text", text: "{}" }] };
      }
      const fields = { summary: JIRA_FILED_TITLE, status: { name: state.status }, description: input.description ?? JIRA_FILED_DESCRIPTION, comment: { comments: state.comments } };
      return { content: [{ type: "text", text: JSON.stringify({ key: JIRA_FILED_KEY, fields }) }] };
    },
  };
  const send = async (body: unknown) => {
    const raw = JSON.stringify(body);
    const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
    const background: Promise<unknown>[] = [];
    const base = host(kv, posts);
    const previous = process.env.FACTORY_DESK_INTAKE_CHANNEL;
    if (input.intake === null) delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
    else process.env.FACTORY_DESK_INTAKE_CHANNEL = input.intake ?? INTAKE_CHANNEL;
    try {
      const response = await handler(request, { host: { ...base, slack: { getClient: async () => client }, mcp }, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body });
      await Promise.all(background);
      return response;
    } finally {
      if (previous === undefined) delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
      else process.env.FACTORY_DESK_INTAKE_CHANNEL = previous;
    }
  };
  return { kv, posts, updates, reactions, written, state, send };
}

test("a Jira-filed ticket opens its intake root at Triaged, links it on the ticket, and walks the root's reaction through the plan", async () => {
  const world = jiraFiledWorld();
  world.state.status = "Triaged";
  world.state.comments.push(TRIAGE_COMMENT);
  const triaged = await world.send(TRIAGED);
  assert.deepEqual(await triaged.json(), { ok: true, kind: "triaged", issueKey: JIRA_FILED_KEY });

  const root = world.posts[0]!;
  const rootTs = "1758510002.000001";
  assert.equal(root["channel"], INTAKE_CHANNEL);
  assert.equal(root["thread_ts"], undefined, "the root is top-level in the intake channel");
  assert.match(String(root["text"]), /^TLSSN-51: Statement PDF shows the wrong closing balance\nStatus: \*Triaged\*/);
  assert.deepEqual(
    world.posts.slice(1).map((post) => [post["channel"], post["thread_ts"], String(post["text"]).split("\n")[0]]),
    [
      [INTAKE_CHANNEL, rootTs, "TLSSN-51 is Triaged: bug, high severity."],
      [INTAKE_CHANNEL, rootTs, "TLSSN-51: planner is checking the code…"],
    ]
  );
  assert.deepEqual(world.kv[`ticket/${JIRA_FILED_KEY}`], {
    channelId: INTAKE_CHANNEL,
    threadTs: rootTs,
    root: "jira",
    boundAt: (world.kv[`ticket/${JIRA_FILED_KEY}`] as Record<string, unknown>)["boundAt"],
    rootStatus: { status: "Triaged", changelogId: "20030" },
  });
  assert.equal((world.kv[`ticket/${JIRA_FILED_KEY}`] as Record<string, unknown>)["originatorUserId"], undefined, "no Slack approver for a Jira filing");
  assert.deepEqual(world.reactions, [`add hourglass_flowing_sand ${INTAKE_CHANNEL}:${rootTs}`]);
  const permalink = "https://<SLACK_WORKSPACE>.slack.com/archives/C0INTAKE01/p1758510002000001";
  assert.deepEqual(world.written, [backlinkComment(permalink)]);
  assert.match(world.written[0]!, /^Slack thread: https:\/\/cursor-demo-lab\.slack\.com\/archives\/C0INTAKE01\/p1758510002000001\n/);
  assert.equal((world.kv[`backlink/${JIRA_FILED_KEY}`] as Record<string, unknown>)["permalink"], permalink);
  assert.deepEqual(
    [(world.kv[`hop-watch/${JIRA_FILED_KEY}`] as Record<string, unknown>)["hop"], (world.kv[`hop-watch/${JIRA_FILED_KEY}`] as Record<string, unknown>)["changelogId"]],
    ["plan", "20030"],
    "the plan hop watch is armed once the root is bound"
  );

  await world.send(TRIAGED);
  assert.equal(world.posts.length, 3, "a redelivered Triaged move opens no second root");
  assert.equal(world.written.length, 1, "and writes no second backlink");

  world.state.status = "Planned";
  world.state.comments.push(PLAN_COMMENT);
  const planned = await world.send(PLANNED);
  assert.deepEqual(await planned.json(), { ok: true, kind: "planned", issueKey: JIRA_FILED_KEY });
  const plan = world.posts[3]!;
  assert.deepEqual([plan["channel"], plan["thread_ts"]], [INTAKE_CHANNEL, rootTs], "the plan replies under the root");
  assert.match(String(plan["text"]), /TLSSN-51 is planned/);
  assert.match(String(plan["text"]), /was filed in Jira: to start the build, move the card to Approved in Jira\./);
  assert.equal(world.posts.length, 4, "the planner crumb is deleted, not reposted");
  assert.deepEqual(world.updates.map((update) => [update["channel"], update["ts"], String(update["text"]).split("\n")[1]]), [[INTAKE_CHANNEL, rootTs, "Status: *Planned*  ·  <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-51|TLSSN-51 on Jira>"]]);
  assert.deepEqual(world.reactions.slice(1), [`add memo ${INTAKE_CHANNEL}:${rootTs}`, `remove hourglass_flowing_sand ${INTAKE_CHANNEL}:${rootTs}`]);
  assert.equal(world.written.length, 1, "the backlink is written once");
  assert.equal(world.kv[`hop-watch/${JIRA_FILED_KEY}`], undefined);
});

test("a transient backlink failure is retried inside the Triaged announcement, so the comment is on the ticket before the planner records its plan", async () => {
  const world = jiraFiledWorld({ commentFailures: 2 });
  world.state.status = "Triaged";
  world.state.comments.push(TRIAGE_COMMENT);
  await world.send(TRIAGED);
  assert.equal(world.posts.length, 3);
  assert.deepEqual(world.written, [backlinkComment("https://<SLACK_WORKSPACE>.slack.com/archives/C0INTAKE01/p1758510002000001")]);
  assert.equal(world.state.comments.filter((comment) => comment.body.startsWith("Slack thread:")).length, 1);
  assert.equal((world.kv[`backlink/${JIRA_FILED_KEY}`] as Record<string, unknown>)["threadTs"], "1758510002.000001");
});

test("a backlink write Jira keeps refusing is retried on the next announcement, and one already on the ticket is never written twice", async () => {
  const failing = jiraFiledWorld({ commentFails: true });
  failing.state.status = "Triaged";
  failing.state.comments.push(TRIAGE_COMMENT);
  await failing.send(TRIAGED);
  assert.equal(failing.posts.length, 3, "the thread opens and hears Triaged whatever Jira says to the comment");
  assert.equal(failing.kv[`backlink/${JIRA_FILED_KEY}`], undefined);

  const retry = jiraFiledWorld();
  Object.assign(retry.kv, { [`ticket/${JIRA_FILED_KEY}`]: failing.kv[`ticket/${JIRA_FILED_KEY}`] });
  retry.state.status = "Planned";
  retry.state.comments.push(TRIAGE_COMMENT, PLAN_COMMENT);
  await retry.send(PLANNED);
  assert.equal(retry.written.length, 1, "the next announcement writes it");

  const present = jiraFiledWorld();
  Object.assign(present.kv, { [`ticket/${JIRA_FILED_KEY}`]: failing.kv[`ticket/${JIRA_FILED_KEY}`] });
  present.state.status = "Planned";
  present.state.comments.push(TRIAGE_COMMENT, { id: "20901", body: backlinkComment("https://<SLACK_WORKSPACE>.slack.com/archives/C0INTAKE01/p1758510002000001") }, PLAN_COMMENT);
  await present.send(PLANNED);
  assert.deepEqual(present.written, [], "a comment already naming the root counts as written");
  assert.equal((present.kv[`backlink/${JIRA_FILED_KEY}`] as Record<string, unknown>)["threadTs"], "1758510002.000001");
});

test("an unbound ticket filed from Slack opens no second thread in the intake channel", async () => {
  const world = jiraFiledWorld({ description: SLACK_FILED_DESCRIPTION });
  world.state.status = "Triaged";
  world.state.comments.push(TRIAGE_COMMENT);
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => void logged.push(String(line));
  try {
    await world.send(TRIAGED);
    world.state.status = "Planned";
    world.state.comments.push(PLAN_COMMENT);
    await world.send(PLANNED);
  } finally {
    console.error = original;
  }
  assert.deepEqual([world.posts, world.written, world.reactions], [[], [], []]);
  assert.equal(world.kv[`ticket/${JIRA_FILED_KEY}`], undefined);
  assert.ok(logged.some((line) => line.includes('"why":"filed_in_slack_unbound"')), logged.join("\n"));
});

test("with no intake channel a Jira-filed ticket gets no thread and no backlink", async () => {
  const world = jiraFiledWorld({ intake: null });
  world.state.status = "Triaged";
  world.state.comments.push(TRIAGE_COMMENT);
  await world.send(TRIAGED);
  assert.deepEqual([world.posts, world.written, world.reactions], [[], [], []]);
  assert.deepEqual(Object.keys(world.kv).filter((key) => !key.startsWith("triaged-entry/")), []);
});

test("a Slack-filed ticket's thread never gets the intake backlink: its description already links the filing thread", async () => {
  const world = jiraFiledWorld({ description: SLACK_FILED_DESCRIPTION });
  world.kv[`ticket/${JIRA_FILED_KEY}`] = { channelId: "C0EXAMPLE1", threadTs: "1790366941.085899", originatorUserId: "U0ALICE01" };
  world.state.status = "Triaged";
  world.state.comments.push(TRIAGE_COMMENT);
  await world.send(TRIAGED);
  assert.equal(world.posts[0]?.["thread_ts"], "1790366941.085899");
  assert.deepEqual(world.written, []);
  assert.deepEqual(world.reactions, ["add hourglass_flowing_sand C0EXAMPLE1:1790366941.085899"]);
});

test("a move back to Planned from In Progress is announced as a move back, never as a fresh plan", async () => {
  const kv: Record<string, unknown> = { ...BOUND, "announced/TLSSN-42:Planned": { state: "done", owner: "o", at: "2026-09-25T02:05:34.000Z" } };
  const posts: Record<string, unknown>[] = [];
  const response = await deliver(moved("In Progress", "Planned", "10080"), sign, kv, posts);
  assert.deepEqual(await response.json(), { ok: true, kind: "planned", issueKey: "TLSSN-42" });
  assert.deepEqual(
    posts.map((post) => [post["channel"], post["thread_ts"], post["text"]]),
    [["C0123ABCD", "1758510000.123456", "TLSSN-42 moved back to Planned from In Progress. The implementation that already started is not stopped, and the factory does not launch it again."]]
  );
  assert.equal((kv["announced/TLSSN-42:Planned:10080"] as Record<string, unknown>)["state"], "done");
  const again = await deliver(moved("In Progress", "Planned", "10080"), sign, kv, posts);
  assert.equal(again.status, 200);
  assert.equal(posts.length, 1);
});

// `replan KEY` sends the ticket Planned → Triaged → Planned with a new Plan:
// comment. The Triaged line promises the new plan lands in the thread, so the
// second Planned move must post it; a redelivery or a Planned → Planned
// bounce on the same plan must not.
test("a replan's new plan is posted when the ticket reaches Planned again; the same plan is never posted twice", async () => {
  const triage = { id: "10201", body: "Triage: bug\nSeverity: high" };
  const planA = { id: "10301", body: "Plan: TLSSN-42 CSV export 500\nSummary: first plan\nBrief:\nDo A." };
  const planB = { id: "10355", body: "Plan: TLSSN-42 CSV export 500\nSummary: second plan\nBrief:\nDo B." };
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const deletes: Record<string, unknown>[] = [];

  const firstPlan = await deliverComment(moved("Triaged", "Planned", "10040"), kv, posts, ticket({ status: "Planned", comments: [triage, planA] }).mcp, undefined, { deletes });
  assert.deepEqual(await firstPlan.json(), { ok: true, kind: "planned", issueKey: "TLSSN-42" });
  assert.equal(posts.length, 1);
  assert.match(String(posts[0]?.["text"]), /TLSSN-42 is planned/);
  assert.match(String(posts[0]?.["text"]), /focusedCommentId=10301/);
  await deliverComment(moved("Triaged", "Planned", "10040"), kv, posts, ticket({ status: "Planned", comments: [triage, planA] }).mcp, undefined, { deletes });
  assert.equal(posts.length, 1, "a redelivery posts nothing");

  await deliverComment(moved("Planned", "Triaged", "10050"), kv, posts, ticket({ status: "Triaged", comments: [triage, planA] }).mcp, undefined, { deletes });
  assert.equal(posts.length, 3);
  assert.match(String(posts[1]?.["text"]), /^TLSSN-42 is Triaged for a new plan/);
  assert.equal(posts[2]?.["text"], "TLSSN-42: planner is checking the code…");
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "planning");

  const secondPlan = await deliverComment(moved("Triaged", "Planned", "10060"), kv, posts, ticket({ status: "Planned", comments: [triage, planA, planB] }).mcp, undefined, { deletes });
  assert.deepEqual(await secondPlan.json(), { ok: true, kind: "planned", issueKey: "TLSSN-42" });
  assert.equal(posts.length, 4, "the replan's plan is posted");
  assert.match(String(posts[3]?.["text"]), /TLSSN-42 is planned/);
  assert.match(String(posts[3]?.["text"]), /focusedCommentId=10355/);
  assert.equal(deletes.length, 1, "the planner crumb is gone when Planned posts");
  assert.equal(kv["loader/TLSSN-42"], undefined);
  assert.deepEqual(posts.map((post) => [post["channel"], post["thread_ts"]]), Array(4).fill(["C0123ABCD", "1758510000.123456"]));

  await deliverComment(moved("Planned", "Planned", "10061"), kv, posts, ticket({ status: "Planned", comments: [triage, planA, planB] }).mcp, undefined, { deletes });
  assert.equal(posts.length, 4, "a Planned bounce on the same plan posts nothing");
});

test("a plan posted in #mars-eng-intake, where a plain reply reaches the desk, writes every command without @factory", async () => {
  const kv: Record<string, unknown> = { "ticket/TLSSN-42": { channelId: "C0EXAMPLE1", threadTs: "1790510637.708999", originatorUserId: "U0ALICE01" } };
  const posts: Record<string, unknown>[] = [];
  const comments = [{ id: "10201", body: "Triage: bug\nSeverity: medium" }, { id: "10301", body: "Plan: TLSSN-42 Transfer reference counter\nSummary: show a live count\nBrief:\nDo A." }];
  await deliverComment(moved("Triaged", "Planned", "10040"), kv, posts, ticket({ status: "Planned", comments }).mcp);
  assert.equal(posts.length, 1);
  const post = JSON.stringify(posts[0]);
  assert.match(post, /React ✅ to start the build or ❌ to stop, or reply `approve` \/ `deny`\./);
  assert.doesNotMatch(post, /@factory|no mention needed/);
});

// The planner's Needs info: and Plan stopped: comments leave the ticket in
// Triaged, so no status webhook fires. The desk's comment rule delivers them.

const NEEDS_INFO = [
  "Needs info: TLSSN-42",
  "Claimed failure is not on cursor-demo-lab/marsbank@main (checked 2026-09-25 03:41 UTC).",
  "",
  "Ticket claimed: CSV export truncates the last column when the download filename contains spaces.",
  "On main: No CSV export or Content-Disposition code on main.",
  "Searched:",
  "- csv export",
  "- Content-Disposition",
  "",
  "Do not implement and do not open a pull request. Update the ticket with a path that fails on this ref, or close it.",
].join("\n");

const PLAN_STOPPED = [
  "Plan stopped: TLSSN-42",
  "The planning run stopped at 2026-09-25 03:41 UTC without a plan.",
  "Why: The planning run failed: resource_exhausted.",
  "",
  "Nothing was planned and nothing will be built. Send the ticket back to Triaged for a new planning run.",
].join("\n");

function commented(body: string, input: { id?: string; status?: string } = {}) {
  return {
    webhookEvent: "comment_created",
    issue: { key: "TLSSN-42", fields: { summary: "CSV export truncates", status: { name: input.status ?? "Triaged" }, project: { key: "TLSSN" } } },
    comment: { ...(input.id === "" ? {} : { id: input.id ?? "10301" }), body },
  };
}

function ticket(input: { comments: Array<{ id: string; body: string }>; status?: string; fail?: boolean }) {
  const calls: string[] = [];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } }],
    callTool: async (_connection: string, tool: string): Promise<HostMcpCallResult> => {
      calls.push(tool);
      if (input.fail === true) throw new Error("Jira is down");
      const fields = { ...(input.status === undefined ? {} : { status: { name: input.status } }), comment: { comments: input.comments } };
      return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields }) }] };
    },
  };
  return { mcp, calls };
}

async function deliverComment(
  body: unknown,
  kv: Record<string, unknown>,
  posts: Record<string, unknown>[],
  mcp: unknown,
  headers: Record<string, string> | undefined = undefined,
  extras: { deletes?: Record<string, unknown>[]; updates?: Record<string, unknown>[] } = {}
) {
  const raw = JSON.stringify(body);
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: headers ?? { "x-hub-signature-256": sign(raw) } });
  const background: Promise<unknown>[] = [];
  const response = await handler(request, { host: { ...host(kv, posts, undefined, extras), mcp }, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body });
  await Promise.all(background);
  return response;
}

test("the planner's Needs info comment tells the thread what it checked, why there is no plan, and what to do next", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ status: "Triaged", comments: [{ id: "10290", body: "Triage: bug\nSeverity: high" }, { id: "10301", body: NEEDS_INFO }] });
  const response = await deliverComment(commented(NEEDS_INFO), kv, posts, jira.mcp);
  assert.deepEqual(await response.json(), { ok: true, kind: "needs_info", issueKey: "TLSSN-42" });
  assert.deepEqual(
    posts.map((post) => [post["channel"], post["thread_ts"]]),
    [["C0123ABCD", "1758510000.123456"]]
  );
  assert.equal(
    posts[0]?.["text"],
    [
      "<@U0ALICE01> TLSSN-42 needs more information, so it has no plan. The planner checked cursor-demo-lab/marsbank@main and did not find the problem the ticket describes.",
      "\u2022 Ticket claimed: CSV export truncates the last column when the download filename contains spaces.",
      "\u2022 On main: No CSV export or Content-Disposition code on main.",
      "\u2022 Searched: csv export; Content-Disposition",
      "Next: reply here with a file path, error message, or steps that fail on main. If you edit the ticket in Jira instead, say `@factory plan TLSSN-42` here. If it no longer applies, close the ticket. <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42?focusedCommentId=10301|Needs info comment>",
    ].join("\n")
  );
  assert.equal((kv["announced/TLSSN-42:Needs info:10301"] as Record<string, unknown>)["state"], "done");

  const redelivered = await deliverComment(commented(NEEDS_INFO), kv, posts, jira.mcp);
  assert.equal(redelivered.status, 200);
  assert.equal(posts.length, 1);
});

test("a Plan stopped comment tells the thread the planner's reason and how to run it again", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ status: "Triaged", comments: [{ id: "10302", body: PLAN_STOPPED }] });
  const response = await deliverComment(commented(PLAN_STOPPED, { id: "10302" }), kv, posts, jira.mcp);
  assert.deepEqual(await response.json(), { ok: true, kind: "plan_stopped", issueKey: "TLSSN-42" });
  assert.equal(
    posts[0]?.["text"],
    [
      "<@U0ALICE01> TLSSN-42 has no plan: the planner stopped before it recorded one.",
      "Why: The planning run failed: resource_exhausted.",
      "Next: say `@factory plan TLSSN-42` here to run the planner again. <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42?focusedCommentId=10302|Plan stopped comment>",
    ].join("\n")
  );
  assert.equal((kv["announced/TLSSN-42:Plan stopped:10302"] as Record<string, unknown>)["state"], "done");
});

// The planner writes Plan stopped: on every Triaged entry its verdict gate
// skips (planner/agent/lib/plan-outcome.ts reportSkippedPlan), first entry
// and bounce alike. The desk relays it unless the thread already heard the gate.
const SKIPPED = [
  "Plan stopped: TLSSN-42",
  "The planner did not start a planning run for this move to Triaged at 2026-09-27 00:09 UTC.",
  "Why: The triage verdict (the latest Triage: comment) is a question, and the planner does not plan questions.",
  "",
  "Nothing was planned and nothing will be built. Answer the Needs info in the ticket's Slack thread, or change the triage verdict in Jira, then send the ticket back to Triaged.",
].join("\n");

test("a verdict skip the thread already heard (no planner crumb, no recent send) posts nothing; after a desk send, or with the crumb up, it posts", async () => {
  const now = Date.now();
  const skipped = (id: string) => ticket({ status: "Triaged", comments: [{ id, body: SKIPPED }] });

  const quiet: Record<string, unknown> = { ...BOUND };
  const quietPosts: Record<string, unknown>[] = [];
  const response = await deliverComment(commented(SKIPPED, { id: "10401" }), quiet, quietPosts, skipped("10401").mcp);
  assert.equal(response.status, 200);
  assert.deepEqual(quietPosts, [], "triage's own move: the Triaged line already said the planner will not plan a question");

  const stale: Record<string, unknown> = { ...BOUND, [plannerSentKey("TLSSN-42")]: { at: new Date(now - PLANNER_SENT_MS - 60_000).toISOString() } };
  const stalePosts: Record<string, unknown>[] = [];
  await deliverComment(commented(SKIPPED, { id: "10402" }), stale, stalePosts, skipped("10402").mcp);
  assert.deepEqual(stalePosts, [], "a send long before is not this skip's cause");

  for (const [why, extra] of [
    ["plan KEY sent it", { [plannerSentKey("TLSSN-42")]: { at: new Date(now - 60_000).toISOString() } }],
    ["the planner crumb is up", { [loaderKey("TLSSN-42")]: { channel: "C0123ABCD", ts: "1758510099.000100", phase: "planning" } }],
  ] as const) {
    const kv: Record<string, unknown> = { ...BOUND, ...extra };
    const posts: Record<string, unknown>[] = [];
    await deliverComment(commented(SKIPPED, { id: "10403" }), kv, posts, skipped("10403").mcp);
    assert.equal(posts.length, 1, why);
    assert.match(String(posts[0]?.["text"]), /^<@U0ALICE01> TLSSN-42 has no plan: .*\nWhy: The triage verdict \(the latest Triage: comment\) is a question/, why);
  }
});

test("moveToPlanner records the send before it moves the ticket", async () => {
  const kv = new Map<string, unknown>();
  const store = { get: async (key: string) => kv.get(key) as never, put: async (key: string, value: unknown) => void kv.set(key, value), delete: async (key: string) => void kv.delete(key) };
  const unconnected = { names: () => [], listTools: async () => [], callTool: async () => ({ content: [] }) };
  const at = new Date("2026-09-27T00:00:00Z");
  await moveToPlanner(unconnected as never, { issueKey: "TLSSN-42", statuses: { todo: "To Do", triaged: "Triaged" } as never, kv: store as never, now: at });
  assert.deepEqual(kv.get(plannerSentKey("TLSSN-42")), { at: at.toISOString() });
  assert.equal(await sentToPlannerRecently(store as never, "TLSSN-42", new Date(at.getTime() + PLANNER_SENT_MS - 1)), true);
  assert.equal(await sentToPlannerRecently(store as never, "TLSSN-42", new Date(at.getTime() + PLANNER_SENT_MS)), false);
});

test("a later Needs info on the same ticket (a replan that still found nothing) is a new comment and posts again", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const later = NEEDS_INFO.replace("03:41", "04:12");
  const jira = ticket({ status: "Triaged", comments: [{ id: "10301", body: NEEDS_INFO }, { id: "10340", body: later }] });
  await deliverComment(commented(NEEDS_INFO), kv, posts, jira.mcp);
  await deliverComment(commented(later, { id: "10340" }), kv, posts, jira.mcp);
  assert.equal(posts.length, 2);
  assert.match(String(posts[1]?.["text"]), /focusedCommentId=10340\|Needs info comment>$/);
});

// TLSSN-30: the first Triaged entry and a `plan KEY` bounce each started a
// planner session before either finished, and both wrote Needs info.
test("two Needs info comments from sessions of the same Triaged entry post once; a new entry posts again", async () => {
  const kv: Record<string, unknown> = { ...BOUND, "triaged-entry/TLSSN-42": "10045" };
  const posts: Record<string, unknown>[] = [];
  const second = NEEDS_INFO.replace("03:41", "03:42");
  const jira = ticket({ status: "Triaged", comments: [{ id: "15335", body: NEEDS_INFO }, { id: "15336", body: second }] });
  await deliverComment(commented(NEEDS_INFO, { id: "15335" }), kv, posts, jira.mcp);
  const quiet = await deliverComment(commented(second, { id: "15336" }), kv, posts, jira.mcp);
  assert.equal(quiet.status, 200);
  assert.equal(posts.length, 1);
  assert.equal((kv["announced/TLSSN-42:Needs info:triaged-10045"] as Record<string, unknown>)["state"], "done");

  kv["triaged-entry/TLSSN-42"] = "10052";
  const third = NEEDS_INFO.replace("03:41", "04:30");
  const after = ticket({ status: "Triaged", comments: [{ id: "15340", body: third }] });
  await deliverComment(commented(third, { id: "15340" }), kv, posts, after.mcp);
  assert.equal(posts.length, 2);
  assert.match(String(posts[1]?.["text"]), /focusedCommentId=15340\|Needs info comment>$/);
});

test("a thread with no Slack approver on record is told to plan again from the board", async () => {
  const kv: Record<string, unknown> = { "ticket/TLSSN-42": { channelId: "C0INTAKE01", threadTs: "1758510000.123456", root: "jira" } };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ status: "Triaged", comments: [{ id: "10301", body: NEEDS_INFO }] });
  await deliverComment(commented(NEEDS_INFO), kv, posts, jira.mcp);
  const text = String(posts[0]?.["text"]);
  assert.match(text, /^TLSSN-42 needs more information/);
  assert.match(text, /\nNext: reply here with a file path, error message, or steps that fail on main\. If it no longer applies/);
  assert.doesNotMatch(text, /@factory plan/);
});

test("a comment no agent wrote, one that only looks like an outcome line, or one on a ticket that left Triaged, posts nothing", async () => {
  const lookalikes = [
    "Launch failed: I think the agent crashed, can someone look?",
    "Launch failed: service_unavailable.",
    "Approved without a plan on the ticket; nothing was launched. Move TLSSN-7 back to Triaged in Jira to plan it, then approve the new plan.",
    "In Progress not set from cursor-demo-lab/marsbank#13: moved by hand.",
    "Triage stopped: TLSSN-7",
    "triage stopped: TLSSN-42",
  ];
  const ignored: Array<[unknown, string]> = [
    [commented("Looks like the export module moved."), "not_outcome"],
    [commented("Triage: bug\nSeverity: low\nNeeds info: which export?"), "not_outcome"],
    [commented(NEEDS_INFO.replace("Needs info: TLSSN-42", "Needs info: TLSSN-7")), "not_outcome"],
    ...lookalikes.map((body): [unknown, string] => [commented(body, { status: "Approved" }), "not_outcome"]),
    [commented(NEEDS_INFO, { status: "Planned" }), "moved_on"],
  ];
  for (const [body, reason] of ignored) {
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    const jira = ticket({ status: "Triaged", comments: [] });
    const response = await deliverComment(body, kv, posts, jira.mcp);
    assert.deepEqual(await response.json(), { ok: true, ignored: true, reason }, JSON.stringify(body));
    assert.deepEqual(posts, []);
    assert.deepEqual(jira.calls, [], reason);
  }

  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const planned = ticket({ status: "Planned", comments: [{ id: "10301", body: NEEDS_INFO }] });
  await deliverComment(commented(NEEDS_INFO), kv, posts, planned.mcp);
  assert.deepEqual(posts, []);
  assert.deepEqual(kv, BOUND);
});

test("when Jira cannot be read back, the signed comment still tells the thread", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ comments: [], fail: true });
  await deliverComment(commented(NEEDS_INFO), kv, posts, jira.mcp);
  const text = String(posts[0]?.["text"]);
  assert.match(text, /\u2022 Ticket claimed: CSV export truncates the last column/);
  assert.match(text, /focusedCommentId=10301\|Needs info comment>$/);

  const bare = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  await deliverComment(commented("Needs info: TLSSN-42", { id: "" }), bare.kv, bare.posts, jira.mcp);
  assert.equal(
    bare.posts[0]?.["text"],
    "<@U0ALICE01> TLSSN-42 needs more information, so it has no plan. The planner checked the sandbox and did not find the problem the ticket describes.\nNext: reply here with a file path, error message, or steps that fail on the sandbox. If you edit the ticket in Jira instead, say `@factory plan TLSSN-42` here. If it no longer applies, close the ticket. <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42|TLSSN-42 on Jira>"
  );
  assert.ok(Object.keys(bare.kv).some((key) => /^announced\/TLSSN-42:Needs info:body-[0-9a-f]{16}$/.test(key)));
});

test("an unsigned comment event posts nothing and claims nothing", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ status: "Triaged", comments: [{ id: "10301", body: NEEDS_INFO }] });
  const response = await deliverComment(commented(NEEDS_INFO), kv, posts, jira.mcp, {});
  assert.equal(response.status, 401);
  assert.deepEqual(posts, []);
  assert.deepEqual(kv, BOUND);
  assert.deepEqual(jira.calls, []);
});

test("the replay script's signed comment body wakes the desk the way the comment rule does", async () => {
  const scriptUrl = new URL("../../../scripts/replay-jira-comment.mjs", import.meta.url).href;
  const payload = (await import(new URL("../../../scripts/jira-payload.mjs", import.meta.url).href)) as {
    signedRequest(body: unknown, secret: string): { rawBody: string; headers: Record<string, string> };
  };
  const replay = (await import(scriptUrl)) as {
    commentBody(input: { issueKey: string; commentId: string; body: string; timestamp: number; summary: string; status?: string }): unknown;
  };
  const body = replay.commentBody({ issueKey: "TLSSN-42", commentId: "10301", body: "Needs info: TLSSN-42", timestamp: 1_790_000_000_000, summary: "CSV export truncates" });
  const { headers } = payload.signedRequest(body, ENV.JIRA_WEBHOOK_SECRET);
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ status: "Triaged", comments: [{ id: "10301", body: NEEDS_INFO }] });
  const response = await deliverComment(body, kv, posts, jira.mcp, { "x-hub-signature-256": headers["x-hub-signature-256"]! });
  assert.deepEqual(await response.json(), { ok: true, kind: "needs_info", issueKey: "TLSSN-42" });
  assert.match(String(posts[0]?.["text"]), /\u2022 Searched: csv export; Content-Disposition/);
});

// Triage's and the worker's comments that stand in for a move they did not
// make. Each one follows a line that promised the next step (the filing
// reply's Triaged line, the Approved line's agent link), so the thread hears
// why it is not coming.

const TRIAGE_STOPPED = [
  "Triage stopped: TLSSN-42",
  "The triage run stopped at 2026-09-25 04:41 UTC before the ticket reached Triaged.",
  "Why: The triage run failed: resource_exhausted.",
  "",
  "The planner has not started. Move the ticket to Triaged to send it to the planner.",
].join("\n");
const LAUNCH_FAILED = "Launch failed: service_unavailable. Moving the card to Approved again retries.";
const NO_PLAN = "Approved without a plan on the ticket; nothing was launched. Move TLSSN-42 back to Triaged in Jira to plan it, then approve the new plan.";
const NO_PLAN_BEFORE = "Approved without a plan on the ticket; nothing was launched. Reply `plan TLSSN-42` in Slack or move the ticket back to Triaged.";
const MOVE_SKIPPED = "In Review not set from cursor-demo-lab/marsbank#13: TLSSN-42 is Planned, not In Progress, so the worker left it there. Move the card by hand if this pull request is the implementation.";
const JIRA_ROOT = { "ticket/TLSSN-42": { channelId: "C0INTAKE01", threadTs: "1758510000.123456", root: "jira", rootStatus: { status: "Approved", rank: 2, changelogId: "10050" } } };

test("Triage stopped tells the thread the ticket is still in To Do, triage's reason, and how to send it to the planner", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ status: "To Do", comments: [{ id: "10401", body: TRIAGE_STOPPED }] });
  const response = await deliverComment(commented(TRIAGE_STOPPED, { id: "10401", status: "To Do" }), kv, posts, jira.mcp);
  assert.deepEqual(await response.json(), { ok: true, kind: "triage_stopped", issueKey: "TLSSN-42" });
  assert.deepEqual(
    posts.map((post) => [post["channel"], post["thread_ts"], post["text"]]),
    [
      [
        "C0123ABCD",
        "1758510000.123456",
        [
          "<@U0ALICE01> TLSSN-42 is still in To Do: triage stopped before it moved the ticket to Triaged, so the planner has not started.",
          "Why: The triage run failed: resource_exhausted.",
          "Next: say `@factory plan TLSSN-42` here to send it to the planner. <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42?focusedCommentId=10401|Triage stopped comment>",
        ].join("\n"),
      ],
    ]
  );
  assert.equal((kv["announced/TLSSN-42:Triage stopped:10401"] as Record<string, unknown>)["state"], "done");
  await deliverComment(commented(TRIAGE_STOPPED, { id: "10401", status: "To Do" }), kv, posts, jira.mcp);
  assert.equal(posts.length, 1);
});

test("Triage stopped on a Jira-only thread is told to move the card, and one that left To Do posts nothing", async () => {
  const jiraOnly = { kv: { ...JIRA_ROOT } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  const todo = ticket({ status: "To Do", comments: [{ id: "10401", body: TRIAGE_STOPPED }] });
  await deliverComment(commented(TRIAGE_STOPPED, { id: "10401", status: "To Do" }), jiraOnly.kv, jiraOnly.posts, todo.mcp);
  assert.match(String(jiraOnly.posts[0]?.["text"]), /^TLSSN-42 is still in To Do: .*\nWhy: .*\nNext: move TLSSN-42 to Triaged in Jira to send it to the planner\. </);

  const payloadMoved = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  const response = await deliverComment(commented(TRIAGE_STOPPED, { id: "10401", status: "Triaged" }), payloadMoved.kv, payloadMoved.posts, todo.mcp);
  assert.deepEqual(await response.json(), { ok: true, ignored: true, reason: "moved_on" });

  const liveMoved = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  const triaged = ticket({ status: "Triaged", comments: [{ id: "10401", body: TRIAGE_STOPPED }] });
  await deliverComment(commented(TRIAGE_STOPPED, { id: "10401", status: "To Do" }), liveMoved.kv, liveMoved.posts, triaged.mcp);
  assert.deepEqual([payloadMoved.posts, liveMoved.posts], [[], []]);
  assert.deepEqual(liveMoved.kv, BOUND);
});

test("Launch failed tells the thread nothing is being built, the reason, and how to launch again", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ status: "Approved", comments: [{ id: "10501", body: LAUNCH_FAILED }] });
  const response = await deliverComment(commented(LAUNCH_FAILED, { id: "10501", status: "Approved" }), kv, posts, jira.mcp);
  assert.deepEqual(await response.json(), { ok: true, kind: "launch_failed", issueKey: "TLSSN-42" });
  assert.equal(
    posts[0]?.["text"],
    [
      "<@U0ALICE01> TLSSN-42 is Approved, but nothing is being built: the cloud agent launch failed (service_unavailable).",
      "Next: move TLSSN-42 to Planned in Jira, then say `@factory approve TLSSN-42` here to launch it again. <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42?focusedCommentId=10501|Launch failed comment>",
    ].join("\n")
  );
  assert.equal(posts[0]?.["thread_ts"], "1758510000.123456");
  assert.equal((kv["announced/TLSSN-42:Launch failed:10501"] as Record<string, unknown>)["state"], "done");

  const moved = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  const planned = ticket({ status: "Planned", comments: [{ id: "10501", body: LAUNCH_FAILED }] });
  await deliverComment(commented(LAUNCH_FAILED, { id: "10501", status: "Approved" }), moved.kv, moved.posts, planned.mcp);
  assert.deepEqual(moved.posts, []);
});

test("a worker line in a Jira-filed thread names the board, and never rewrites the intake root's status line", async () => {
  const kv: Record<string, unknown> = { ...JIRA_ROOT };
  const posts: Record<string, unknown>[] = [];
  const updates: unknown[] = [];
  const jira = ticket({ status: "Approved", comments: [{ id: "10501", body: LAUNCH_FAILED }] });
  const raw = JSON.stringify(commented(LAUNCH_FAILED, { id: "10501", status: "Approved" }));
  const base = host(kv, posts);
  const slack = {
    getClient: async () => ({
      chat: {
        postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: "1758510002.000100" }),
        update: async (args: unknown) => (updates.push(args), { ok: true }),
      },
    }),
  };
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
  const background: Promise<unknown>[] = [];
  await handler(request, { host: { ...base, slack, mcp: jira.mcp }, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body: JSON.parse(raw) });
  await Promise.all(background);
  assert.match(String(posts[0]?.["text"]), /^TLSSN-42 is Approved, but nothing is being built: .*\nNext: move TLSSN-42 to Planned and back to Approved in Jira to launch it again\. </);
  assert.deepEqual(updates, []);
  assert.deepEqual((kv["ticket/TLSSN-42"] as Record<string, unknown>)["rootStatus"], JIRA_ROOT["ticket/TLSSN-42"].rootStatus);
});

test("Approved without a plan, in the worker's current and earlier wording, says nothing was launched and to plan it from the board", async () => {
  for (const body of [NO_PLAN, NO_PLAN_BEFORE]) {
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    const jira = ticket({ status: "Approved", comments: [{ id: "10502", body }] });
    const response = await deliverComment(commented(body, { id: "10502", status: "Approved" }), kv, posts, jira.mcp);
    assert.deepEqual(await response.json(), { ok: true, kind: "approved_without_plan", issueKey: "TLSSN-42" }, body);
    assert.equal(
      posts[0]?.["text"],
      [
        "<@U0ALICE01> TLSSN-42 is Approved, but nothing is being built: the ticket has no plan, so the worker launched nothing.",
        "Next: move TLSSN-42 back to Triaged in Jira to run the planner. <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42?focusedCommentId=10502|Approved without a plan comment>",
      ].join("\n"),
      body
    );
    assert.equal((kv["announced/TLSSN-42:Approved without a plan:10502"] as Record<string, unknown>)["state"], "done");
  }
});

test("the worker's note that its pull request did not move the ticket is relayed whatever the status, mentioning nobody", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const jira = ticket({ status: "Planned", comments: [{ id: "10601", body: MOVE_SKIPPED }] });
  const response = await deliverComment(commented(MOVE_SKIPPED, { id: "10601", status: "Planned" }), kv, posts, jira.mcp);
  assert.deepEqual(await response.json(), { ok: true, kind: "move_skipped", issueKey: "TLSSN-42" });
  assert.equal(
    posts[0]?.["text"],
    "The factory did not move TLSSN-42 to In Review for cursor-demo-lab/marsbank#13: TLSSN-42 is Planned, not In Progress, so the worker left it there. Move the card by hand if this pull request is the implementation. <https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42?focusedCommentId=10601|Move skipped comment>"
  );
  assert.deepEqual(jira.calls, ["getJiraIssue"]);
});

test("an early stop on a ticket with no thread opens its intake root, so a Jira filing hears it; a move-skipped note does not", async () => {
  process.env.FACTORY_DESK_INTAKE_CHANNEL = "C0INTAKE01";
  try {
    const lines = [
      [TRIAGE_STOPPED, "To Do", "triage_stopped", /^TLSSN-42 is still in To Do: triage stopped/],
      [NEEDS_INFO, "Triaged", "needs_info", /^TLSSN-42 needs more information/],
      [LAUNCH_FAILED, "Approved", "launch_failed", /^TLSSN-42 is Approved, but nothing is being built/],
    ] as const;
    for (const [body, status, kind, line] of lines) {
      const kv: Record<string, unknown> = {};
      const posts: Record<string, unknown>[] = [];
      const jira = ticket({ status, comments: [{ id: "10701", body }] });
      const response = await deliverComment(commented(body, { id: "10701", status }), kv, posts, jira.mcp);
      assert.deepEqual(await response.json(), { ok: true, kind, issueKey: "TLSSN-42" }, body);
      assert.equal(posts.length, 2, body);
      assert.deepEqual([posts[0]?.["channel"], posts[0]?.["thread_ts"]], ["C0INTAKE01", undefined], body);
      assert.match(String(posts[0]?.["text"]), new RegExp(`\\nStatus: \\*${status}\\*`), body);
      assert.deepEqual([posts[1]?.["channel"], posts[1]?.["thread_ts"]], ["C0INTAKE01", "1758510002.000001"], body);
      assert.match(String(posts[1]?.["text"]), line, body);
      assert.doesNotMatch(String(posts[1]?.["text"]), /<@/, "no Slack approver to mention");
      assert.equal((kv["ticket/TLSSN-42"] as Record<string, unknown>)["root"], "jira", body);
      if (kind === "needs_info") assert.equal((kv["awaiting-info/C0INTAKE01:1758510002.000001"] as Record<string, unknown>)["kind"], "needs_info");
    }

    const kv: Record<string, unknown> = {};
    const posts: Record<string, unknown>[] = [];
    const jira = ticket({ status: "In Progress", comments: [{ id: "10701", body: MOVE_SKIPPED }] });
    const response = await deliverComment(commented(MOVE_SKIPPED, { id: "10701", status: "In Progress" }), kv, posts, jira.mcp);
    assert.deepEqual(await response.json(), { ok: true, kind: "move_skipped", issueKey: "TLSSN-42" });
    assert.deepEqual([posts, kv], [[], {}]);
  } finally {
    delete process.env.FACTORY_DESK_INTAKE_CHANNEL;
  }
});

test("every kind the replay script sends wakes the desk as that outcome, in the status it leaves the ticket in", async () => {
  const replay = (await import(new URL("../../../scripts/replay-jira-comment.mjs", import.meta.url).href)) as {
    KINDS: Record<string, { status: string; line(issueKey: string): string }>;
    commentBody(input: { issueKey: string; commentId: string; body: string; timestamp: number; summary: string; status?: string }): unknown;
  };
  const expected: Record<string, string> = {
    "needs-info": "needs_info",
    "plan-stopped": "plan_stopped",
    "triage-stopped": "triage_stopped",
    "launch-failed": "launch_failed",
    "approved-without-plan": "approved_without_plan",
  };
  assert.deepEqual(Object.keys(replay.KINDS).sort(), Object.keys(expected).sort());
  for (const [name, kind] of Object.entries(replay.KINDS)) {
    const body = replay.commentBody({ issueKey: "TLSSN-42", commentId: "10801", body: kind.line("TLSSN-42"), timestamp: 1_790_000_000_000, summary: "CSV export", status: kind.status });
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    const jira = ticket({ status: kind.status, comments: [] });
    const response = await deliverComment(body, kv, posts, jira.mcp);
    assert.deepEqual(await response.json(), { ok: true, kind: expected[name], issueKey: "TLSSN-42" }, name);
    assert.equal(posts.length, 1, name);
  }
});

// A thread that has been told the ticket needs information takes a plain
// reply as the update (lib/thread-detail.ts). These lines are what mark it.
const AWAITING = "awaiting-info/C0123ABCD:1758510000.123456";

test("a Needs info line, or a Triaged line whose verdict needs information, marks the thread as awaiting a reply", async () => {
  const planner = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  const jira = ticket({ status: "Triaged", comments: [{ id: "10301", body: NEEDS_INFO }] });
  await deliverComment(commented(NEEDS_INFO), planner.kv, planner.posts, jira.mcp);
  assert.deepEqual({ ...(planner.kv[AWAITING] as Record<string, unknown>), at: "" }, { issueKey: "TLSSN-42", kind: "needs_info", at: "" });

  const triage = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  await deliver(moved("To Do", "Triaged", "10035"), sign, triage.kv, triage.posts, ["Triage: bug\nSeverity: low\nSummary: x\nNext step: Name the export URL.\nNeeds info: Name the export URL."]);
  assert.equal((triage.kv[AWAITING] as Record<string, unknown>)["kind"], "triage_needs_info");

  const stopped = { kv: { ...BOUND } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  await deliverComment(commented(PLAN_STOPPED, { id: "10302" }), stopped.kv, stopped.posts, ticket({ status: "Triaged", comments: [{ id: "10302", body: PLAN_STOPPED }] }).mcp);
  assert.equal(stopped.kv[AWAITING], undefined);
});

test("once someone answered in Slack, the next Triaged line says the planner checks it, and the thread stops awaiting", async () => {
  const kv: Record<string, unknown> = { ...BOUND, [AWAITING]: { issueKey: "TLSSN-42", kind: "triage_needs_info", at: "2026-09-25T05:00:00.000Z" } };
  const posts: Record<string, unknown>[] = [];
  const comments = [
    "Triage: bug\nSeverity: low\nSummary: x\nNext step: Name the export URL.\nNeeds info: Name the export URL.",
    "Detail from Slack: TLSSN-42\nAlice replied in the ticket's Slack thread after triage asked for more information:\n\nIt is /reports/export?format=csv",
  ];
  await deliver(moved("To Do", "Triaged", "10036"), sign, kv, posts, comments);
  assert.equal(posts[0]?.["text"], "TLSSN-42 is Triaged: bug, low severity.");
  assert.equal(kv[AWAITING], undefined);
});

// TLSSN-29: first Triaged announced Bug/medium + Jev, planner asked for info,
// a human replied, the desk bounced the ticket back to the planner, and the
// factory posted the same Triaged+Jev line again. Announce once per verdict;
// the wait is a planner crumb, cleared when Planned or Needs info lands.
const TLSSN29_TRIAGE =
  "Triage: bug\nType: Bug\nSeverity: medium\nSummary: x\nNext step: Inspect 9f2c.\nJudge: Jev type Bug 1.00 (set in Jira; agreed); severity medium 0.76 (agreed)";
const TLSSN29_LINE =
  "TLSSN-42 is Triaged: Bug, medium severity.";

test("a Needs-info bounce with the same Jev does not re-announce Triaged; the planner crumb stays until Planned", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const deletes: Record<string, unknown>[] = [];
  const triage = { id: "10290", body: TLSSN29_TRIAGE };
  const detail = {
    id: "10950",
    body: "Detail from Slack: TLSSN-42\nSimon replied in the ticket's Slack thread after the planner said it needs more information:\n\nIt fails on /reports/export?format=csv",
  };

  await deliver(moved("To Do", "Triaged", "10030"), sign, kv, posts, [TLSSN29_TRIAGE], { deletes });
  assert.equal(posts[0]?.["text"], TLSSN29_LINE);
  assert.equal(posts[1]?.["text"], "TLSSN-42: planner is checking the code…");
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "planning");

  await deliverComment(commented(NEEDS_INFO), kv, posts, ticket({ status: "Triaged", comments: [triage, { id: "10301", body: NEEDS_INFO }] }).mcp, undefined, { deletes });
  assert.match(String(posts[2]?.["text"]), /needs more information/);
  assert.equal(kv["loader/TLSSN-42"], undefined, "Needs info clears the planner crumb");
  assert.equal(deletes.length, 1);

  const bouncePosts = posts.length;
  await deliver(moved("To Do", "Triaged", "10045"), sign, kv, posts, [TLSSN29_TRIAGE, detail.body, NEEDS_INFO], { deletes });
  assert.equal(
    posts.filter((post) => String(post["text"]).startsWith("TLSSN-42 is Triaged:")).length,
    1,
    "the identical Triaged+Jev line is not posted again"
  );
  assert.equal(posts[bouncePosts]?.["text"], "TLSSN-42: planner is checking the code…");
  assert.equal((kv["loader/TLSSN-42"] as { phase?: string } | undefined)?.phase, "planning");

  const changed =
    "Triage: bug\nType: Story\nSeverity: low\nSummary: x\nJudge: Jev type Story 0.97 (already Story in Jira; agreed); severity low 0.9 (agreed)";
  await deliver(moved("To Do", "Triaged", "10046"), sign, kv, posts, [changed], { deletes });
  assert.match(String(posts.at(-1)?.["text"]), /^TLSSN-42 is Triaged: Story, low severity\./);
});

test("the first Triaged line and its Jev still announce when the ticket has never been Triaged in this thread", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  await deliver(moved("To Do", "Triaged", "10030"), sign, kv, posts, [TLSSN29_TRIAGE]);
  assert.equal(posts[0]?.["text"], TLSSN29_LINE);
  assert.equal((kv["announced/TLSSN-42:Triaged:verdict-bug.medium.plan.bug.medium.first"] as Record<string, unknown>)["state"], "done");
});

test("an Approved move the desk just made from Slack posts the implement crumb, then In Progress replaces the wait", async () => {
  const kv: Record<string, unknown> = { ...BOUND, "approved-in-slack/TLSSN-42": { at: new Date(Date.now() - 20_000).toISOString(), by: "U0ALICE01" } };
  const posts: Record<string, unknown>[] = [];
  const deletes: Record<string, unknown>[] = [];
  const response = await deliver(approvedEvent(), sign, kv, posts, undefined, { deletes });
  assert.deepEqual(await response.json(), { ok: true, kind: "approved", issueKey: "TLSSN-42" });
  assert.deepEqual(posts.map((post) => post["text"]), ["TLSSN-42: starting implementation…"]);
  assert.equal(kv["announced/TLSSN-42:Approved:10050"], undefined);
  assert.equal((kv["loader/TLSSN-42"] as Record<string, unknown>)["phase"], "implementing");

  await deliver(moved("Approved", "In Progress", "10051"), sign, kv, posts, ["Implementing: https://cursor.com/agents/bc-42"], { deletes });
  assert.deepEqual(posts.map((post) => post["text"]), [
    "TLSSN-42: starting implementation…",
    `TLSSN-42 is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: https://cursor.com/agents/bc-42`,
  ]);
  assert.equal(kv["loader/TLSSN-42"], undefined);
  assert.equal(deletes.length, 1);
});

test("a board approval, or one long after a Slack approval, still gets the Approved line", async () => {
  const stale = { kv: { ...BOUND, "approved-in-slack/TLSSN-42": { at: new Date(Date.now() - 11 * 60_000).toISOString() } } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  await deliver(approvedEvent(), sign, stale.kv, stale.posts);
  assert.match(String(stale.posts[0]?.["text"]), /^TLSSN-42 is Approved\./);
  const unreadable = { kv: { ...BOUND, "approved-in-slack/TLSSN-42": { at: "yesterday" } } as Record<string, unknown>, posts: [] as Record<string, unknown>[] };
  await deliver(approvedEvent(), sign, unreadable.kv, unreadable.posts);
  assert.equal(unreadable.posts.length, 1);
});

test("a move back to Planned from Approved says approving again retries a failed launch", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  await deliver(moved("Approved", "Planned", "10090"), sign, kv, posts);
  assert.equal(
    posts[0]?.["text"],
    "TLSSN-42 moved back to Planned from Approved. Approving it again retries a launch that failed; an implementation that already started is not stopped or launched twice."
  );
});

test("each announce also moves the filer's message to one status reaction; a late delivery never moves it back", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const send = async (body: unknown, comments: unknown[]) => {
    const raw = JSON.stringify(body);
    const base = host(kv, posts, comments);
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: "1758510002.000100" }),
        delete: async () => ({ ok: true }),
        update: async () => ({ ok: true }),
      },
      apiCall: async (method: string, args: Record<string, unknown>) => {
        if (!method.startsWith("reactions.")) return { ok: true };
        assert.deepEqual([args["channel"], args["timestamp"]], ["C0123ABCD", "1758510000.123456"], "only the filer's message");
        reactions.push(`${method.replace("reactions.", "")} ${String(args["name"])}`);
        return { ok: true };
      },
    };
    const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
    const background: Promise<unknown>[] = [];
    await handler(request, { host: { ...base, slack: { getClient: async () => client } }, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body });
    await Promise.all(background);
  };
  await send(moved("To Do", "Triaged", "10030"), ["Triage: bug\nSeverity: high"]);
  await send(moved("Approved", "In Progress", "10051"), ["Implementing: https://cursor.com/agents/bc-42"]);
  await send(moved("In Progress", "In Review", "10060"), ["Pull request: https://github.com/cursor-demo-lab/marsbank/pull/21"]);
  // A redelivered, older Triaged move with its own changelog id.
  await send(moved("To Do", "Triaged", "10029"), ["Triage: bug\nSeverity: high"]);
  await send(moved("In Review", "Done", "10070"), ["Pull request: https://github.com/cursor-demo-lab/marsbank/pull/21", "Merged by: example-user"]);
  assert.deepEqual(reactions, ["add hourglass_flowing_sand", "add hammer_and_wrench", "remove hourglass_flowing_sand", "add mag", "remove hammer_and_wrench", "add white_check_mark", "remove mag"]);
  assert.deepEqual(kv["reaction/TLSSN-42"], { channel: "C0123ABCD", ts: "1758510000.123456", name: "white_check_mark", changelogId: "10070" });
});

test("TLSSN-36/37: a desk-filed ticket's Triaged move posts no Triaged line (its Filed post carried the verdict), only the planner crumb, and walks the root to ⏳; a Jira-filed one keeps its Triaged line", async () => {
  const intake = { by: "model" as const, reason: "below_bar" as const };
  const model = { title: "Card export CSV drops the last row", kind: "bug" as const, severity: "low" as const, summary: "The CSV export drops the last row." };
  const comment = settleFiling(planFiling(intake, model), "TLSSN-42", { status: "not_written" }).comment;
  assert.match(comment, /^Triaged by: Grok 4\.6 Fast \(Jev did not settle it: /m);
  const run = async (kv: Record<string, unknown>, changelogId: string) => {
    const posts: Record<string, unknown>[] = [];
    const reactions: string[] = [];
    const raw = JSON.stringify(moved("To Do", "Triaged", changelogId));
    const base = host(kv, posts, [comment]);
    const client = {
      chat: { postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: "1758510002.000100" }), update: async () => ({ ok: true }), delete: async () => ({ ok: true }) },
      apiCall: async (method: string, args: Record<string, unknown>) => (method.startsWith("reactions.") ? reactions.push(`${method.replace("reactions.", "")} ${String(args["name"])}`) : 0, { ok: true }),
    };
    const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
    const background: Promise<unknown>[] = [];
    await handler(request, { host: { ...base, slack: { getClient: async () => client } }, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body: JSON.parse(raw) });
    await Promise.all(background);
    return { posts, reactions };
  };

  const filed: Record<string, unknown> = { ...BOUND };
  await markFiledTriage(recordKv(filed), { issueKey: "TLSSN-42", comment, at: new Date("2026-09-27T01:00:00Z") });
  const first = await run(filed, "10030");
  assert.deepEqual(first.posts.map((post) => post["text"]), ["TLSSN-42: planner is checking the code…"], "no Triaged line after the Filed post; the planner crumb shows the wait");
  assert.deepEqual(first.reactions, ["add hourglass_flowing_sand"]);
  assert.equal((filed["loader/TLSSN-42"] as Record<string, unknown> | undefined)?.["phase"], "planning");
  assert.equal((filed[`hop-watch/TLSSN-42`] as Record<string, unknown> | undefined)?.["hop"], "plan", "the plan hop is still watched");
  assert.deepEqual((await run(filed, "10030")).posts, [], "a redelivery of that entry posts no second crumb");
  const bounce = await run(filed, "10045");
  assert.equal(bounce.posts.filter((post) => /is Triaged/.test(String(post["text"]))).length, 0, "a later bounce on the same verdict posts no Triaged line either");

  const jira: Record<string, unknown> = { ...BOUND };
  const direct = await run(jira, "10030");
  assert.equal(direct.posts[0]?.["text"], "TLSSN-42 is Triaged by Grok 4.6 Fast (Jev didn't settle it): Bug, low severity.");
});

test("a desk-filed needs-info verdict: no Triaged line, a question on the root, and the thread waits on the reporter's reply", async () => {
  const comment = ["Triage: bug", "Type: Bug", "Severity: low", 'Summary: Bug reported as "x", low severity.', "Next step: Reporter: add what you saw.", "Needs info: Reporter: add what you saw.", "Triaged by: Jev (type, severity, and gate all above 0.52)"].join("\n");
  const kv: Record<string, unknown> = { ...BOUND };
  await markFiledTriage(recordKv(kv), { issueKey: "TLSSN-42", comment, at: new Date("2026-09-27T01:00:00Z") });
  const posts: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const raw = JSON.stringify(moved("To Do", "Triaged", "10031"));
  const base = host(kv, posts, [comment]);
  const client = {
    chat: { postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: "1758510002.000100" }), update: async () => ({ ok: true }) },
    apiCall: async (method: string, args: Record<string, unknown>) => (method.startsWith("reactions.") ? reactions.push(`${method.replace("reactions.", "")} ${String(args["name"])}`) : 0, { ok: true }),
  };
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
  const background: Promise<unknown>[] = [];
  await handler(request, { host: { ...base, slack: { getClient: async () => client } }, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body: JSON.parse(raw) });
  await Promise.all(background);
  assert.deepEqual(posts, []);
  assert.deepEqual(reactions, ["add question"]);
  assert.equal((kv["awaiting-info/C0123ABCD:1758510000.123456"] as Record<string, unknown> | undefined)?.["kind"], "triage_needs_info");
});

test("a needs-info verdict marks the thread root with a question, the filer's message or a Jira-filed intake root alike", async () => {
  const reactionsFor = async (kv: Record<string, unknown>) => {
    const posts: Record<string, unknown>[] = [];
    const names: string[] = [];
    const raw = JSON.stringify(moved("To Do", "Triaged", "10031"));
    const base = host(kv, posts, ["Triage: bug\nSeverity: low\nNext step: Ask for steps.\nNeeds info: Ask for steps."]);
    const client = {
      chat: { postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: "1758510002.000100" }), update: async () => ({ ok: true }) },
      apiCall: async (method: string, args: Record<string, unknown>) => (names.push(`${method} ${String(args["name"])} ${String(args["channel"])}:${String(args["timestamp"])}`), { ok: true }),
    };
    const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
    const background: Promise<unknown>[] = [];
    await handler(request, { host: { ...base, slack: { getClient: async () => client } }, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body: JSON.parse(raw) });
    await Promise.all(background);
    assert.equal(posts.length, 1);
    return names.filter((name) => name.startsWith("reactions."));
  };
  assert.deepEqual(await reactionsFor({ ...BOUND }), ["reactions.add question C0123ABCD:1758510000.123456"]);
  assert.deepEqual(await reactionsFor({ "ticket/TLSSN-42": { channelId: "C0INTAKE01", threadTs: "1758510001.000100", root: "jira" } }), ["reactions.add question C0INTAKE01:1758510001.000100"]);
});

test("In Progress rewrites the desk's own 'KEY is approved' line in place, so the thread gets one beat, not two", async () => {
  const now = Math.floor(Date.now() / 1000);
  const approvedReply = { ts: `${now - 35}.026879`, bot_id: "B0EXAMPLE1", text: "TLSSN-42 is approved; the agent link follows in this thread." };
  const run = async (messages: unknown[], options: { updateThrows?: boolean } = {}) => {
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const raw = JSON.stringify(moved("Approved", "In Progress", "10051"));
    const base = host(kv, posts, ["Implementing: https://cursor.com/agents/bc-42"]);
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: "1758510002.000100" }),
        update: async (args: Record<string, unknown>) => {
          if (options.updateThrows === true) throw Object.assign(new Error("cant_update_message"), { data: { error: "cant_update_message" } });
          updates.push(args);
          return { ok: true };
        },
      },
      apiCall: async (method: string, args: Record<string, unknown>) => {
        if (method === "conversations.replies") {
          assert.deepEqual([args["channel"], args["ts"]], ["C0123ABCD", "1758510000.123456"]);
          return { ok: true, messages: [{ ts: "1758510000.123456", user: "U0ALICE01", text: "file a bug: …" }, ...messages] };
        }
        return { ok: true };
      },
    };
    const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
    const background: Promise<unknown>[] = [];
    await handler(request, { host: { ...base, slack: { getClient: async () => client } }, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body: JSON.parse(raw) });
    await Promise.all(background);
    return { posts, updates, kv };
  };
  const progress = `TLSSN-42 is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: https://cursor.com/agents/bc-42`;

  const collapsed = await run([{ ts: `${now - 60}.725609`, user: "U0ALICE01", text: "approve TLSSN-42" }, approvedReply]);
  assert.deepEqual(collapsed.posts, []);
  assert.deepEqual(collapsed.updates, [{ channel: "C0123ABCD", ts: approvedReply.ts, text: progress }]);
  assert.equal((collapsed.kv["announced/TLSSN-42:In Progress:10051"] as Record<string, unknown>)["ts"], approvedReply.ts);

  const boardLine = { ...approvedReply, text: "TLSSN-42 is Approved." };
  assert.equal((await run([boardLine])).updates.length, 1, "the board-drag Approved line is replaced too");

  const starting = { ...approvedReply, text: "TLSSN-42: starting implementation…" };
  assert.equal((await run([starting])).updates.length, 1, "the approve-gap loader is replaced too");

  for (const [messages, why] of [
    [[approvedReply, { ts: `${now - 10}.000001`, user: "U0ALICE01", text: "thanks" }], "a person spoke after it"],
    [[{ ...approvedReply, ts: `${now - 20 * 60}.000001` }], "older than fifteen minutes"],
    [[{ ...approvedReply, text: `${approvedReply.text} To hand a PR to the fixer, type factory: drive on it yourself; a comment posted by a bot does not wake it, and a factory PR needs nothing.` }], "a longer reply carries more than the approval"],
    [[{ ...approvedReply, bot_id: undefined, user: "U0ALICE01" }], "a person's own words"],
    [[{ ...approvedReply, text: "TLSSN-43 is approved; the agent link follows in this thread." }], "another ticket"],
  ] as const) {
    const posted = await run([...messages]);
    assert.deepEqual([posted.updates.length, posted.posts.length], [0, 1], why);
    assert.equal(posted.posts[0]?.["text"], progress, why);
  }
  const refused = await run([approvedReply], { updateThrows: true });
  assert.deepEqual([refused.updates.length, refused.posts.length], [0, 1], "a refused edit posts instead");
});

test("In Review names the gates a review wake already saw pending, and posts no crumb once they all settled", async () => {
  const waiting: Record<string, unknown> = { ...BOUND, "review-gates/TLSSN-42": { pending: ["security"] } };
  const waitingPosts: Record<string, unknown>[] = [];
  await deliver(moved("In Progress", "In Review", "10090"), sign, waiting, waitingPosts);
  assert.equal(waitingPosts[1]?.["text"], "TLSSN-42: waiting on security…");
  assert.deepEqual(waiting["review-gates/TLSSN-42"], { pending: ["security"], inReview: true });

  const settled: Record<string, unknown> = { ...BOUND, "review-gates/TLSSN-42": { pending: [] } };
  const settledPosts: Record<string, unknown>[] = [];
  await deliver(moved("In Progress", "In Review", "10091"), sign, settled, settledPosts);
  assert.equal(settledPosts.length, 1, "only the In Review line");
  assert.equal(settled["loader/TLSSN-42"], undefined);
});

async function deliverWith(body: unknown, withHost: unknown) {
  const raw = JSON.stringify(body);
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
  const background: Promise<unknown>[] = [];
  await handler(request, { host: withHost, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body });
  await Promise.all(background);
}

async function withSettle<T>(ms: string, run: () => Promise<T>): Promise<T> {
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = ms;
  try {
    return await run();
  } finally {
    process.env.FACTORY_DESK_CLAIM_SETTLE_MS = ENV.FACTORY_DESK_CLAIM_SETTLE_MS;
  }
}

const TRIAGED_LINE = (post: Record<string, unknown>) => String(post["text"]).startsWith("TLSSN-42 is Triaged:");

// Two deliveries of one Triaged transition (a Jira retry, or the HMAC webhook
// and the Automation rule both firing) that both read the verdict claim
// absent: each verified its own write, and each posted the Triaged line and a
// planner crumb.
test("two concurrent deliveries of one Triaged transition that both read the verdict claim absent post one Triaged line and one crumb", async () => {
  const race = (settle: string) =>
    withSettle(settle, async () => {
      const kv: Record<string, unknown> = { ...BOUND };
      const posts: Record<string, unknown>[] = [];
      const [first, second] = racingStores(recordKv(kv), { prefix: "announced/TLSSN-42:Triaged:", after: "readBack", passReads: 1 });
      await Promise.all([
        deliverWith(moved("To Do", "Triaged", "10045"), { ...host(kv, posts, [TLSSN29_TRIAGE]), kv: first }),
        deliverWith(moved("To Do", "Triaged", "10045"), { ...host(kv, posts, [TLSSN29_TRIAGE]), kv: second }),
      ]);
      return { kv, lines: posts.filter(TRIAGED_LINE).length, crumbs: posts.filter((post) => post["text"] === "TLSSN-42: planner is checking the code…").length };
    });

  assert.equal((await race("0")).lines, 2, "without the settle wait both deliveries post: the race this guards");

  const settled = await race("20");
  assert.deepEqual([settled.lines, settled.crumbs], [1, 1]);
  const claim = settled.kv["announced/TLSSN-42:Triaged:verdict-bug.medium.plan.bug.medium.first"] as Record<string, unknown>;
  assert.deepEqual([claim["state"], claim["changelogId"]], ["done", "10045"]);
});

test("a bounce whose Triaged delivery races the first entry's on the same verdict posts one Triaged line; a changed verdict still posts", async () => {
  await withSettle("20", async () => {
    const kv: Record<string, unknown> = { ...BOUND };
    const posts: Record<string, unknown>[] = [];
    const [first, second] = racingStores(recordKv(kv), { prefix: "announced/TLSSN-42:Triaged:", after: "readBack", passReads: 1 });
    await Promise.all([
      deliverWith(moved("To Do", "Triaged", "10045"), { ...host(kv, posts, [TLSSN29_TRIAGE]), kv: first }),
      deliverWith(moved("To Do", "Triaged", "10046"), { ...host(kv, posts, [TLSSN29_TRIAGE]), kv: second }),
    ]);
    assert.equal(posts.filter(TRIAGED_LINE).length, 1);
    assert.equal((kv["announced/TLSSN-42:Triaged:verdict-bug.medium.plan.bug.medium.first"] as Record<string, unknown>)["changelogId"], "10046", "the last writer holds the claim and posts");

    const changed = "Triage: bug\nType: Story\nSeverity: low\nSummary: x\nJudge: Jev type Story 0.97 (already Story in Jira; agreed); severity low 0.9 (agreed)";
    await deliver(moved("To Do", "Triaged", "10050"), sign, kv, posts, [changed]);
    assert.equal(posts.filter(TRIAGED_LINE).length, 2);
    assert.match(String(posts.filter(TRIAGED_LINE).at(-1)?.["text"]), /^TLSSN-42 is Triaged: Story, low severity\./);
  });
});

// TLSSN-30, concurrent: two planner sessions of one Triaged entry wrote Needs
// info seconds apart, and both deliveries read the entry's claim absent.
test("two concurrent Needs info comments of one Triaged entry that both read the claim absent post once", async () => {
  const second = NEEDS_INFO.replace("03:41", "03:42");
  const race = (settle: string) =>
    withSettle(settle, async () => {
      const kv: Record<string, unknown> = { ...BOUND, "triaged-entry/TLSSN-42": "10045" };
      const posts: Record<string, unknown>[] = [];
      const jira = ticket({ status: "Triaged", comments: [{ id: "15335", body: NEEDS_INFO }, { id: "15336", body: second }] });
      const [a, b] = racingStores(recordKv(kv), { prefix: "announced/TLSSN-42:Needs info:", after: "readBack" });
      await Promise.all([
        deliverWith(commented(NEEDS_INFO, { id: "15335" }), { ...host(kv, posts), mcp: jira.mcp, kv: a }),
        deliverWith(commented(second, { id: "15336" }), { ...host(kv, posts), mcp: jira.mcp, kv: b }),
      ]);
      return { kv, posts };
    });

  assert.equal((await race("0")).posts.length, 2, "without the settle wait both deliveries post: the race this guards");
  const settled = await race("20");
  assert.equal(settled.posts.length, 1);
  assert.match(String(settled.posts[0]?.["text"]), /^<@U0ALICE01> TLSSN-42 needs more information/);
  assert.equal((settled.kv["announced/TLSSN-42:Needs info:triaged-10045"] as Record<string, unknown>)["state"], "done");
});

test("two Triaged entries recorded at once, with the older put landing last, leave the newer entry for Needs info to claim", async () => {
  const race = (settle: string) =>
    withSettle(settle, async () => {
      const kv: Record<string, unknown> = { ...BOUND };
      const [newer, older] = racingStores(recordKv(kv), { prefix: "triaged-entry/", after: "put" });
      await Promise.all([
        deliverWith(moved("To Do", "Triaged", "10046"), { ...host(kv, [], [TLSSN29_TRIAGE]), kv: newer }),
        deliverWith(moved("To Do", "Triaged", "10045"), { ...host(kv, [], [TLSSN29_TRIAGE]), kv: older }),
      ]);
      return kv["triaged-entry/TLSSN-42"];
    });

  assert.equal(await race("0"), "10045", "without the settle wait the older entry's late put wins: the race this guards");
  assert.equal(await race("20"), "10046");
});

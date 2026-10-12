import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { DESK_TRIAGED_LINE } from "../lib/desk-triaged.js";
import { planFromStatus } from "../lib/jira-event.js";
import channel from "./webhook.js";

// Verifier edge cases for PR #166: which Triage: comment governs a
// desk-filed ticket, and the one Plan stopped: each skipped entry writes.

const SECRET = "edge-secret";
const ENV = { JIRA_WEBHOOK_SECRET: SECRET, FACTORY_PLANNER_JIRA_PROJECTS: "TLSSN" } as const;
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

const KEY = "TLSSN-40";
const entry = (id: string, from = "To Do") => ({
  webhookEvent: "jira:issue_updated",
  issue: { key: KEY, fields: { summary: "Freeze card lacks aria-describedby", status: { name: "Triaged" }, project: { key: "TLSSN" } } },
  changelog: { id, items: [{ field: "status", fromString: from, toString: "Triaged" }] },
});

const adf = (text: string) => ({ type: "doc", version: 1, content: text.split("\n\n").map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) });
const DESK_DESCRIPTION = adf(`Freeze card lacks aria-describedby.\n\nSlack thread: https://acme.slack.com/archives/C0123ABCD/p1758510000123456\n\n${DESK_TRIAGED_LINE}`);

const DESK_BUG = `Triage: bug\nType: Bug\nSeverity: medium\nSummary: Freeze card lacks aria-describedby.\nNext step: Add it.\nTriaged by: Jev (type, severity, and gate all above 0.52)\n\n${DESK_TRIAGED_LINE}`;
const DESK_QUESTION = `Triage: question\nType: Task\nSeverity: low\nSummary: Asks how freeze works.\nNext step: Answer it.\nTriaged by: Jev (type, severity, and gate all above 0.52)\n\n${DESK_TRIAGED_LINE}`;
const JIRA_QUESTION = "Triage: question\nType: Task\nSeverity: low\nSummary: Asks about freeze.\nNext step: Answer it.\nTriaged by: model (Jev was not above 0.52 on every answer)";
const PERSON_DUPLICATE = "Triage: duplicate\nDuplicate of: TLSSN-38\nSeverity: medium";

const str = { type: "string" };
const TOOLS = [
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, commentBody: str } } },
];

function tracker(fields: Record<string, unknown>) {
  const comments: string[] = [];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => TOOLS,
    callTool: async (_c: string, tool: string, args?: Record<string, unknown>) => {
      if (tool === "addCommentToJiraIssue") {
        comments.push(String(args?.["commentBody"]));
        return { content: [{ type: "text", text: "ok" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ key: KEY, fields: { summary: "Freeze card", status: { name: "Triaged" }, ...fields } }) }] };
    },
  };
  return { mcp, comments };
}

function memoryKv(): HostKvApi & { entries: Map<string, JsonValue> } {
  const entries = new Map<string, JsonValue>();
  return { entries, get: async (k) => entries.get(k), put: async (k, v) => void entries.set(k, v), delete: async (k) => void entries.delete(k) };
}

type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };
const route = (channel as unknown as { routes: Route[] }).routes[0]!;

async function deliver(kv: HostKvApi, mcp: unknown, body: unknown, headers: Record<string, string> = { "x-factory-webhook-secret": SECRET }) {
  const sent: string[] = [];
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    const response = await route.handler(
      new Request("http://planner/v1/channels/webhook/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
      { body, host: { kv, mcp }, send: async (message: string) => (sent.push(message), { id: "ses_1" }) }
    );
    return { status: response.status, response: (await response.json()) as Record<string, unknown>, sent, logs: logs.filter((l) => l.startsWith("[planner] webhook ")) };
  } finally {
    console.log = log;
  }
}

const deps = (comments: string[], description?: string) => ({
  triagedStatus: "Triaged",
  plannedStatus: "Planned",
  projects: ["TLSSN"],
  readComments: async () => comments,
  readDescription: async () => description,
});

test("(d) planFromStatus: desk verdict bug + later triage-jira Triage: question (Triaged by: line) plans on the desk's verdict", async () => {
  const decision = await planFromStatus(entry("c1"), deps([DESK_BUG, JIRA_QUESTION], `Freeze.\n\n${DESK_TRIAGED_LINE}`));
  assert.equal(decision.plan, true, JSON.stringify(decision));
  assert.equal(decision.plan && decision.request.verdict?.kind, "bug");
});

// The desk's comments carried a Triaged by: line (triageRecordLines) before
// they carried the marker, so the first machine-written comment is the desk's.
test("(d) planFromStatus: desk bug comment filed before the desk marked its comment (unmarked), desk-filed description, later triage-jira question: plans", async () => {
  const unmarked = "Triage: bug\nType: Bug\nSeverity: medium\nSummary: Freeze card.\nNext step: Add it.\nTriaged by: Jev (type, severity, and gate all above 0.52)";
  const decision = await planFromStatus(entry("c1"), deps([unmarked, JIRA_QUESTION], `Freeze.Slack thread: https://acme.slack.com/archives/C1/p1${DESK_TRIAGED_LINE}`));
  assert.equal(decision.plan, true, JSON.stringify(decision));
});

test("(d) planFromStatus: desk bug + triage-jira question + later person-written Triage: duplicate (no Triaged by:) skips as duplicate, verdict from latest", async () => {
  const decision = await planFromStatus(entry("c1"), deps([DESK_BUG, JIRA_QUESTION, PERSON_DUPLICATE], `Freeze.\n\n${DESK_TRIAGED_LINE}`));
  assert.equal(decision.plan, false);
  assert.equal(!decision.plan && "from" in decision && decision.from, "latest");
  assert.equal(!decision.plan && decision.reason, "duplicate");
  assert.equal(!decision.plan && "duplicateOf" in decision && decision.duplicateOf, "TLSSN-38");
});

// The gate reads comments only (governingTriage, shared with the desk), so a
// second machine-written triage is ignored on any ticket, and a person's
// later Triage: comment is the newest verdict on any ticket.
test("(d) planFromStatus: a Jira-direct ticket reads its triage, a person's later Triage: comment over it, and never a second machine triage", async () => {
  const bug = "Triage: bug\nSeverity: medium\nTriaged by: model";
  assert.equal((await planFromStatus(entry("c1"), deps([JIRA_QUESTION], "Ordinary description."))).plan, false);
  assert.equal((await planFromStatus(entry("c1"), deps([bug, JIRA_QUESTION], "Ordinary description."))).plan, true);
  const corrected = await planFromStatus(entry("c1"), deps([bug, "Triage: question\nSeverity: low"], "Ordinary description."));
  assert.equal(!corrected.plan && corrected.reason, "question");
});

test("(d) webhook: desk-filed bug + later triage-jira question plans (one send, no comment, one log line)", async () => {
  const { mcp, comments } = tracker({ description: DESK_DESCRIPTION, comment: { comments: [{ body: adf(DESK_BUG) }, { body: JIRA_QUESTION }] } });
  const got = await deliver(memoryKv(), mcp, entry("TLSSN-40:Triaged:1"));
  assert.equal(got.response["started"], true, JSON.stringify(got.response));
  assert.equal(got.sent.length, 1);
  assert.deepEqual(comments, []);
  assert.equal(got.logs.length, 1, got.logs.join("\n"));
  assert.match(got.logs[0]!, /^\[planner\] webhook status TLSSN-40 planned \(changelog TLSSN-40:Triaged:1, verdict bug\)$/);
});

// The planner writes Plan stopped: on every skip; the desk drops the ones the
// thread already heard (factory-desk/agent/lib/announce.ts redundantSkip).
test("(d) webhook: + a later person-written Triage: duplicate skips and writes one Plan stopped:", async () => {
  const kv = memoryKv();
  const { mcp, comments } = tracker({ description: DESK_DESCRIPTION, comment: { comments: [{ body: adf(DESK_BUG) }, { body: JIRA_QUESTION }, { body: PERSON_DUPLICATE }] } });
  const got = await deliver(kv, mcp, entry("TLSSN-40:Triaged:1"));
  assert.deepEqual(got.sent, []);
  assert.equal(got.response["reason"], "duplicate");
  assert.equal(got.response["planStopped"], "commented");
  assert.equal(comments.length, 1);
  assert.deepEqual(got.logs, ["[planner] webhook status TLSSN-40 ignored (duplicate, verdict from latest); Plan stopped: commented"]);
});

test("(d) webhook: desk question verdict — first entry and plan KEY bounce each write exactly one Plan stopped:; redelivery writes none; replan bounce writes one more", async () => {
  const kv = memoryKv();
  const { mcp, comments } = tracker({ description: DESK_DESCRIPTION, comment: { comments: [{ body: adf(DESK_QUESTION) }] } });

  const first = await deliver(kv, mcp, entry("TLSSN-40:Triaged:1"));
  assert.equal(first.response["planStopped"], "commented");
  assert.equal(comments.length, 1);
  assert.equal((await deliver(kv, mcp, entry("TLSSN-40:Triaged:1"))).response["planStopped"], "duplicate");
  assert.equal(comments.length, 1, "redelivering the first entry writes nothing more");

  const bounce = await deliver(kv, mcp, entry("TLSSN-40:Triaged:2"));
  assert.deepEqual(bounce.sent, []);
  assert.equal(bounce.response["planStopped"], "commented");
  assert.equal(comments.length, 2);
  const [head, lead, why] = String(comments[1]).split("\n");
  assert.equal(head, "Plan stopped: TLSSN-40");
  assert.match(lead!, /^The planner did not start a planning run for this move to Triaged at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/);
  assert.equal(why, "Why: The triage verdict (factory-desk's triage from filing) is a question, and the planner does not plan questions.");
  assert.equal(bounce.logs.length, 1);

  for (let i = 0; i < 3; i++) {
    const again = await deliver(kv, mcp, entry("TLSSN-40:Triaged:2"));
    assert.equal(again.response["planStopped"], "duplicate");
    assert.equal(again.logs.length, 1);
  }
  assert.equal(comments.length, 2, "the same changelog id never writes twice");

  const replan = await deliver(kv, mcp, entry("TLSSN-40:Triaged:3", "Planned"));
  assert.equal(replan.response["planStopped"], "commented");
  assert.equal(comments.length, 3, "a new move into Triaged is a new report");
});

test("(d) webhook: a Plan stopped comment that fails to land releases its claim so the redelivery retries once", async () => {
  const kv = memoryKv();
  let fail = true;
  const comments: string[] = [];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => TOOLS,
    callTool: async (_c: string, tool: string, args?: Record<string, unknown>) => {
      if (tool === "addCommentToJiraIssue") {
        if (fail) return { isError: true, content: [{ type: "text", text: "boom" }] };
        comments.push(String(args?.["commentBody"]));
        return { content: [{ type: "text", text: "ok" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ key: KEY, fields: { status: { name: "Triaged" }, description: DESK_DESCRIPTION, comment: { comments: [{ body: adf(DESK_QUESTION) }] } } }) }] };
    },
  };
  await deliver(kv, mcp, entry("TLSSN-40:Triaged:1"));
  const failed = await deliver(kv, mcp, entry("TLSSN-40:Triaged:2"));
  assert.notEqual(failed.response["planStopped"], "commented");
  fail = false;
  await deliver(kv, mcp, entry("TLSSN-40:Triaged:2"));
  await deliver(kv, mcp, entry("TLSSN-40:Triaged:2"));
  assert.equal(comments.length, 1);
});

test("(d) webhook: the planner's own Plan stopped: comment_created delivery is ignored (no send, no comment, one log line)", async () => {
  const kv = memoryKv();
  const { mcp, comments } = tracker({ description: DESK_DESCRIPTION, comment: { comments: [{ body: adf(DESK_QUESTION) }] } });
  await deliver(kv, mcp, entry("TLSSN-40:Triaged:1"));
  await deliver(kv, mcp, entry("TLSSN-40:Triaged:2"));
  assert.equal(comments.length, 2);
  for (const webhookEvent of ["comment_created", "jira:comment_created"]) {
    for (const body of [comments[0]!, adf(comments[0]!)]) {
      const event = { webhookEvent, issue: { key: KEY, fields: { summary: "Freeze card", status: { name: "Triaged" }, project: { key: "TLSSN" } } }, comment: { id: "10600", body } };
      const got = await deliver(kv, mcp, event);
      assert.deepEqual(got.sent, []);
      assert.equal(got.response["ignored"], true);
      assert.equal(got.response["via"], "comment");
      assert.deepEqual(got.logs, ["[planner] webhook comment TLSSN-40 ignored (ignored)"]);
    }
  }
  assert.equal(comments.length, 2, "no loop: the comment writes nothing further");
});

test("(d) every delivery logs exactly one [planner] webhook line, including rejected, non-status, and malformed bodies", async () => {
  const kv = memoryKv();
  const { mcp } = tracker({ description: DESK_DESCRIPTION, comment: { comments: [{ body: adf(DESK_BUG) }] } });
  const bodies: unknown[] = [
    entry("TLSSN-40:Triaged:1"),
    entry("TLSSN-40:Triaged:1"),
    { ...entry("x"), changelog: { id: "x", items: [{ field: "status", fromString: "Triaged", toString: "Planned" }] } },
    { ...entry("x"), changelog: { id: "x", items: [{ field: "summary" }] } },
    { webhookEvent: "jira:issue_updated", issue: { key: "OTHER-1", fields: { status: { name: "Triaged" } } }, changelog: { id: "y", items: [{ field: "status", toString: "Triaged" }] } },
    { webhookEvent: "comment_created", issue: { key: KEY }, comment: { body: "hello" } },
    { hello: "world" },
    null,
  ];
  for (const body of bodies) {
    const got = await deliver(kv, mcp, body);
    assert.equal(got.logs.length, 1, `${JSON.stringify(body)} → ${got.logs.join(" | ")}`);
  }
  const rejected = await deliver(kv, mcp, entry("TLSSN-40:Triaged:9"), { "x-factory-webhook-secret": "wrong" });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.logs.length, 1);
  assert.match(rejected.logs[0]!, /^\[planner\] webhook rejected TLSSN-40 \(401/);
});

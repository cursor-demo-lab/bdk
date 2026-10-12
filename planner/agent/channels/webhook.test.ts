import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import channel from "./webhook.js";

// The Triaged route as hosted admission replays it: the control plane catches
// Jira's request, then replays it into this handler with
// `x-agent-sdk-delivery-id`. `send` is only captured there; the session exists
// after the delivery is acknowledged. A second admission of the same delivery
// (the pod that held the capture was replaced) must send again, or the
// planning run is lost with nothing on the ticket (TLSSN-32 after its replan).

const SECRET = "test-secret";
// A 1 ms claim settle keeps the re-read on the path without the 2 s wait.
const ENV = { JIRA_WEBHOOK_SECRET: SECRET, FACTORY_PLANNER_JIRA_PROJECTS: "TLSSN", FACTORY_CLAIM_SETTLE_MS: "1" } as const;
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

const TRIAGED = {
  webhookEvent: "jira:issue_updated",
  issue: { key: "TLSSN-32", fields: { summary: "Activity search misses amounts", status: { name: "Triaged" }, project: { key: "TLSSN" } } },
  changelog: { id: "TLSSN-32:Triaged:2026-09-26T18:56:44.1+1000", items: [{ field: "status", fromString: "To Do", toString: "Triaged" }] },
};

type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };
const route = (channel as unknown as { routes: Route[] }).routes[0]!;

function memoryKv(): HostKvApi & { entries: Map<string, JsonValue> } {
  const entries = new Map<string, JsonValue>();
  return {
    entries,
    get: async (key) => entries.get(key),
    put: async (key, value) => void entries.set(key, value),
    delete: async (key) => void entries.delete(key),
  };
}

function deferred(): { readonly id: string } {
  return {
    get id(): string {
      throw new Error("ChannelSession.id is not available on a send() captured during hosted admission");
    },
  };
}

async function admit(kv: HostKvApi, deliveryId: string | undefined): Promise<{ response: Record<string, unknown>; sent: string[] }> {
  const raw = JSON.stringify(TRIAGED);
  const headers: Record<string, string> = { "content-type": "application/json", "x-factory-webhook-secret": SECRET };
  if (deliveryId !== undefined) headers["x-agent-sdk-delivery-id"] = deliveryId;
  const sent: string[] = [];
  const response = await route.handler(new Request("http://agent-sdk.hosted/v1/channels/webhook/", { method: "POST", headers, body: raw }), {
    body: TRIAGED,
    host: { kv, mcp: { names: () => [], listTools: async () => [], callTool: async () => ({ content: [] }) } },
    send: async (message: string) => {
      sent.push(message);
      return deferred();
    },
  });
  return { response: (await response.json()) as Record<string, unknown>, sent };
}

test("a replayed admission of the same delivery sends again instead of meeting its own claim", async () => {
  const kv = memoryKv();
  const first = await admit(kv, "dlv_1");
  assert.equal(first.sent.length, 1);
  assert.equal(first.response["started"], true);

  const replay = await admit(kv, "dlv_1");
  assert.equal(replay.sent.length, 1, JSON.stringify(replay.response));
  assert.equal(replay.response["started"], true);
  assert.match(replay.sent[0] ?? "", /^Plan TLSSN-32: Activity search misses amounts/);
});

test("another delivery of the same transition is still a duplicate and sends nothing", async () => {
  const kv = memoryKv();
  await admit(kv, "dlv_1");
  const other = await admit(kv, "dlv_2");
  assert.deepEqual(other.sent, []);
  assert.equal(other.response["duplicate"], true);

  const local = await admit(kv, undefined);
  assert.deepEqual(local.sent, []);
  assert.equal(local.response["duplicate"], true);
});

// A move into Triaged the verdict gate skips used to answer JSON only: no
// session, nothing in the hosted log, nothing on the ticket, and the desk's
// `plan TLSSN-40` got "planner is checking the code…" then silence.

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
    callTool: async (_connection: string, tool: string, args?: Record<string, unknown>) => {
      if (tool === "addCommentToJiraIssue") {
        comments.push(String(args?.["commentBody"]));
        return { content: [{ type: "text", text: "ok" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-32", fields }) }] };
    },
  };
  return { mcp, comments };
}

async function deliver(kv: HostKvApi, mcp: unknown, body: unknown = TRIAGED): Promise<{ response: Record<string, unknown>; sent: string[]; logs: string[] }> {
  const sent: string[] = [];
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    const response = await route.handler(
      new Request("http://agent-sdk.hosted/v1/channels/webhook/", { method: "POST", headers: { "content-type": "application/json", "x-factory-webhook-secret": SECRET }, body: JSON.stringify(body) }),
      { body, host: { kv, mcp }, send: async (message: string) => (sent.push(message), { id: "ses_1" }) }
    );
    return { response: (await response.json()) as Record<string, unknown>, sent, logs };
  } finally {
    console.log = log;
  }
}

const questionComment = { body: "Triage: question\nSeverity: low\nSummary: Asks how exports work.\nNext step: Answer it." };

test("every Triaged entry the verdict gate skips writes one Plan stopped: with a Why: line, once per changelog id, first entry and bounce alike", async () => {
  const kv = memoryKv();
  const { mcp, comments } = tracker({ summary: "Activity search", status: { name: "Triaged" }, comment: { comments: [questionComment] } });
  const first = await deliver(kv, mcp);
  assert.deepEqual(first.sent, []);
  assert.equal(first.response["reason"], "question");
  assert.equal(first.response["planStopped"], "commented");
  assert.equal(comments.length, 1);
  const [head, lead, why] = String(comments[0]).split("\n");
  assert.equal(head, "Plan stopped: TLSSN-32");
  assert.match(lead!, /^The planner did not start a planning run for this move to Triaged at /);
  assert.equal(why, "Why: The triage verdict (the latest Triage: comment) is a question, and the planner does not plan questions.");
  assert.ok(first.logs.includes("[planner] webhook status TLSSN-32 ignored (question, verdict from latest); Plan stopped: commented"), first.logs.join("\n"));

  const redelivered = await deliver(kv, mcp);
  assert.equal(comments.length, 1, "a redelivery of the same move writes nothing");
  assert.equal(redelivered.response["planStopped"], "duplicate");

  // A plan KEY bounce the planner never saw the first entry of (a missed wake, an empty kv after a deploy) is still heard.
  const bounce = await deliver(memoryKv(), mcp, { ...TRIAGED, changelog: { ...TRIAGED.changelog, id: "TLSSN-32:Triaged:2026-09-27T00:09:00.0+1000" } });
  assert.equal(comments.length, 2, "a new move into Triaged is heard again");
  assert.equal(bounce.response["planStopped"], "commented");
});

test("a desk-filed ticket plans on the desk's verdict even after a second triage wrote a duplicate verdict, and the log says so", async () => {
  const kv = memoryKv();
  const description = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Freeze card lacks aria-describedby." }] }, { type: "paragraph", content: [{ type: "text", text: "Triaged in Slack by factory-desk before filing." }] }] };
  const desk = { body: "Triage: bug\nType: Bug\nSeverity: medium\nSummary: Freeze card lacks aria-describedby.\nNext step: Add it.\nTriaged by: Jev (type, severity, and gate all above 0.52)" };
  const second = { body: "Triage: bug\nSeverity: medium\nDuplicate of: TLSSN-38\nTriaged by: model (Jev was not above 0.52 on every answer)" };
  const { mcp, comments } = tracker({ summary: "Freeze card", status: { name: "Triaged" }, description, comment: { comments: [desk, second] } });
  const { response, sent, logs } = await deliver(kv, mcp);
  assert.equal(response["started"], true, JSON.stringify(response));
  assert.equal(sent.length, 1);
  assert.deepEqual(comments, []);
  assert.ok(logs.some((line) => line.startsWith("[planner] webhook status TLSSN-32 planned (changelog ")), logs.join("\n"));
});

test("every other decision is logged with its reason, and an unverified delivery is logged as rejected", async () => {
  const kv = memoryKv();
  const { mcp } = tracker({});
  const other = await deliver(kv, mcp, { ...TRIAGED, changelog: { ...TRIAGED.changelog, items: [{ field: "status", fromString: "Triaged", toString: "Planned" }] } });
  assert.equal(other.response["reason"], "other_status");
  assert.ok(other.logs.includes("[planner] webhook status TLSSN-32 ignored (other_status)"), other.logs.join("\n"));

  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    const response = await route.handler(new Request("http://x/", { method: "POST", headers: { "x-factory-webhook-secret": "wrong" }, body: JSON.stringify(TRIAGED) }), { body: TRIAGED, host: { kv, mcp }, send: async () => ({ id: "x" }) });
    assert.equal(response.status, 401);
  } finally {
    console.log = log;
  }
  assert.ok(logs.some((line) => line.startsWith("[planner] webhook rejected TLSSN-32 (401")), logs.join("\n"));
});

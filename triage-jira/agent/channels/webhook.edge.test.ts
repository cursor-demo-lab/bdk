import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import { DESK_TRIAGED_LINE } from "../lib/desk-triaged.js";
import { INPROCESS_PEERS_ENV } from "../lib/peers.js";
import channel from "./webhook.js";

// Verifier edge cases for PR #166: the Automation "Issue created" webhook
// through the real route handler, with Jev's fetch and the tracker MCP
// stubbed. A desk-filed ticket gets no Jev call and no model turn; a
// Jira-direct ticket is triaged exactly as before (Jev, then the turn).

const SECRET = "edge-secret";
const saved = {
  key: process.env.TYPESAFE_API_KEY,
  peers: process.env[INPROCESS_PEERS_ENV],
  secret: process.env.JIRA_WEBHOOK_SECRET,
  fetch: globalThis.fetch,
};
let jevCalls = 0;

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env[INPROCESS_PEERS_ENV] = "1";
  process.env.JIRA_WEBHOOK_SECRET = SECRET;
  jevCalls = 0;
  // Below the bar on severity, so a triaged ticket always reaches the model turn.
  globalThis.fetch = (async () => {
    jevCalls += 1;
    const answer = (choice: string, p: number) => ({ choice, probabilities: { [choice]: p } });
    return new Response(JSON.stringify({ answers: { issueType: answer("Bug", 0.9), severity: answer("medium", 0.4), gate: answer("proceed", 0.9) } }), { status: 200 });
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  for (const [name, value] of [["TYPESAFE_API_KEY", saved.key], [INPROCESS_PEERS_ENV, saved.peers], ["JIRA_WEBHOOK_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const str = { type: "string" };
const obj = { type: "object" };
const TOOLS = [
  { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, commentBody: str } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, transition: obj } } },
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "getJiraProjectIssueTypesMetadata", inputSchema: { type: "object", properties: { projectIdOrKey: str } } },
  { name: "editJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, fields: obj } } },
];
const TYPES = { issueTypes: [{ id: "10170", name: "Task" }, { id: "10171", name: "Story" }, { id: "10172", name: "Bug" }] };

type GetIssue = () => HostMcpCallResult | Promise<HostMcpCallResult>;

function jiraIssue(fields: Record<string, unknown>): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-40", fields: { status: { name: "To Do" }, ...fields } }) }] };
}

function tracker(getIssue: GetIssue | "not_connected" = () => jiraIssue({ description: "Ordinary." })) {
  const calls: string[] = [];
  const kvStore = new Map<string, unknown>();
  const kv = {
    get: async (key: string) => kvStore.get(key) as never,
    put: async (key: string, value: unknown) => void kvStore.set(key, value),
    delete: async (key: string) => void kvStore.delete(key),
  };
  const mcp = {
    names: () => (getIssue === "not_connected" ? ["planner"] : ["tracker", "planner"]),
    listTools: async () => TOOLS,
    callTool: async (_connection: string, tool: string): Promise<HostMcpCallResult> => {
      calls.push(tool);
      if (tool === "getJiraIssue" && getIssue !== "not_connected") return getIssue();
      if (tool === "getJiraProjectIssueTypesMetadata") return { content: [{ type: "text", text: JSON.stringify(TYPES) }] };
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return { mcp, kv, calls };
}

type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };
const route = (channel as unknown as { routes: Route[] }).routes[0]!;

async function deliver(description: string, t: ReturnType<typeof tracker>, fields: Record<string, unknown> = {}) {
  const body = {
    webhookEvent: "jira:issue_created",
    issue: {
      key: "TLSSN-40",
      self: "https://<JIRA_SITE>.atlassian.net/rest/api/3/issue/10400",
      fields: { summary: "Login fails on Safari 17", description, status: { name: "To Do" }, issuetype: { name: "Task" }, reporter: { displayName: "Sam" }, ...fields },
    },
  };
  const sent: string[] = [];
  const background: Promise<unknown>[] = [];
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    const response = await route.handler(
      new Request("http://triage/v1/channels/webhook/", { method: "POST", headers: { "content-type": "application/json", "x-factory-webhook-secret": SECRET }, body: JSON.stringify(body) }),
      { body, host: { kv: t.kv, mcp: t.mcp }, waitUntil: (p: Promise<unknown>) => void background.push(p), send: async (message: string) => (sent.push(message), { id: "ses_1" }) }
    );
    assert.equal(response.status, 200);
    await Promise.all(background);
  } finally {
    console.log = log;
  }
  const writes = t.calls.filter((tool) => /addComment|transition|editJiraIssue/i.test(tool));
  return { sent, logs, writes };
}

const PERMALINK = "https://acme.slack.com/archives/C0123ABCD/p1758510000123456";
const PARAS = ["Login fails on Safari 17 with a blank page.", "Steps: open /login in Safari 17 and submit.", `Slack thread: ${PERMALINK}`, DESK_TRIAGED_LINE];
const DM_PARAS = ["Login fails on Safari 17 with a blank page.", "Steps: open /login in Safari 17 and submit.", DESK_TRIAGED_LINE];

const RENDERINGS: Array<[string, string]> = [
  ["paragraphs glued with no newline", PARAS.join("")],
  ["paragraphs joined with single spaces", PARAS.join(" ")],
  ["paragraphs joined with \\n", PARAS.join("\n")],
  ["paragraphs joined with \\n\\n (as stored)", PARAS.join("\n\n")],
  ["Slack thread URL immediately before the sentinel", `${PARAS.slice(0, 2).join("\n")}\nSlack thread: ${PERMALINK}${DESK_TRIAGED_LINE}`],
  ["trailing whitespace and nbsp", `${PARAS.join("\n\n")} \u00a0\t\u00a0\n `],
  ["\\r\\n line endings", PARAS.join("\r\n\r\n")],
  ["\\r\\n glued to the URL with nbsp tail", `${PARAS.slice(0, 2).join("\r\n")}\r\nSlack thread: ${PERMALINK}\r\n${DESK_TRIAGED_LINE}\u00a0\r\n`],
  ["DM filing (no Slack thread) glued", DM_PARAS.join("")],
  ["DM filing (no Slack thread) joined with single spaces", DM_PARAS.join(" ")],
  ["nbsp between words of the sentinel", PARAS.slice(0, 3).join(" ") + " " + DESK_TRIAGED_LINE.replace(/ /g, "\u00a0")],
];

for (const [name, description] of RENDERINGS) {
  test(`(a) desk-filed plainText, ${name}: no Jev call, no model turn, no Jira write`, async () => {
    // The tracker is not connected, so only the delivered description can decide.
    const t = tracker("not_connected");
    const { sent, writes, logs } = await deliver(description, t);
    assert.equal(jevCalls, 0, logs.join("\n"));
    assert.deepEqual(sent, []);
    assert.deepEqual(writes, []);
    assert.ok(logs.some((line) => line.includes("was triaged by factory-desk before filing")), logs.join("\n"));
  });
}

// The desk's description with a last paragraph that does not end in
// punctuation, filed from a DM (no Slack thread line), and rendered with
// single spaces. Only the tracker re-read can catch it.
const UNPUNCTUATED = ["Login fails on Safari 17", "Expected: the dashboard loads", DESK_TRIAGED_LINE];

test("(a) DM filing whose last paragraph has no end punctuation, joined with single spaces: the delivered text alone does not catch it, the stored ADF does", async () => {
  const stored = { type: "doc", version: 1, content: UNPUNCTUATED.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) };
  const t = tracker(() => jiraIssue({ description: stored }));
  const { sent, writes } = await deliver(UNPUNCTUATED.join(" "), t);
  assert.equal(jevCalls, 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(writes, []);
});

test("(b) description misses; the tracker re-read returns the stored ADF description with the sentinel: skip", async () => {
  const stored = { type: "doc", version: 1, content: PARAS.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) };
  const t = tracker(() => jiraIssue({ description: stored }));
  const { sent, writes, logs } = await deliver("Login fails on Safari 17 with a blank page.", t);
  assert.equal(jevCalls, 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(writes, []);
  assert.ok(logs.some((line) => line.includes("(tracker_description")), logs.join("\n"));
});

test("(b) description misses; the tracker re-read returns the stored description as a plain string: skip", async () => {
  const t = tracker(() => jiraIssue({ description: PARAS.join("\n\n") }));
  const { sent } = await deliver("", t);
  assert.equal(jevCalls, 0);
  assert.deepEqual(sent, []);
});

test("(b) description misses; the tracker re-read shows the desk's Triage: comment (ADF): skip", async () => {
  const deskComment = ["Triage: bug", "Type: Bug", "Severity: medium", "Summary: Safari login blank page.", "Next step: Fix the Safari login.", "Triaged by: Jev (type, severity, and gate all above 0.52)", "", DESK_TRIAGED_LINE].join("\n");
  const body = { type: "doc", version: 1, content: deskComment.split("\n\n").map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) };
  const t = tracker(() => jiraIssue({ description: "Login fails.", comment: { comments: [{ id: "10501", body }] } }));
  const { sent, writes, logs } = await deliver("Login fails.", t);
  assert.equal(jevCalls, 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(writes, []);
  assert.ok(logs.some((line) => line.includes("(desk_triage_comment")), logs.join("\n"));
});

test("(b) the tracker re-read throws: normal triage (Jev, then the model turn)", async () => {
  const t = tracker(() => Promise.reject(new Error("socket hang up")));
  const { sent } = await deliver("Login fails on Safari 17 with a blank page.", t);
  assert.equal(jevCalls, 1);
  assert.equal(sent.length, 1);
});

test("(b) the tracker re-read answers isError: normal triage", async () => {
  const t = tracker(() => ({ isError: true, content: [{ type: "text", text: "rate limited" }] }));
  const { sent } = await deliver("Login fails on Safari 17 with a blank page.", t);
  assert.equal(jevCalls, 1);
  assert.equal(sent.length, 1);
});

test("(b) the tracker re-read never answers: cut off at 8 s, then normal triage", { timeout: 20_000 }, async () => {
  const t = tracker(() => new Promise<HostMcpCallResult>(() => {}));
  const started = Date.now();
  const { sent, logs } = await deliver("Login fails on Safari 17 with a blank page.", t);
  assert.ok(Date.now() - started < 12_000);
  assert.equal(jevCalls, 1);
  assert.equal(sent.length, 1);
  assert.ok(logs.some((line) => line.includes("tracker unread: no answer within 8000 ms")), logs.join("\n"));
});

const JIRA_DIRECT: Array<[string, string]> = [
  ["ordinary prose", "Login fails on Safari 17 with a blank page. Steps: open /login and submit."],
  ["ordinary prose, \\r\\n and trailing nbsp", "Login fails on Safari 17.\r\n\r\nSteps: open /login.\u00a0 "],
  ["sentinel quoted mid-prose", `Our desk writes "${DESK_TRIAGED_LINE}" on its tickets, but this one came from Jira. Login fails on Safari.`],
  ["sentinel quoted at the end of a sentence after other words", `The desk appends ${DESK_TRIAGED_LINE}`],
  ["sentinel in double quotes at the end", `Login fails. The desk tickets say "${DESK_TRIAGED_LINE}"`],
  ["sentinel in inline code at the end", `Login fails. The marker is \`${DESK_TRIAGED_LINE}\``],
  ["sentinel in inline code on its own line", `Login fails.\n\`${DESK_TRIAGED_LINE}\``],
  ["sentinel in a code fence at the end", `Login fails. The desk's line:\n\`\`\`\n${DESK_TRIAGED_LINE}\n\`\`\``],
  ["sentinel in a code fence mid-description", `\`\`\`\n${DESK_TRIAGED_LINE}\n\`\`\`\nLogin fails on Safari 17.`],
];

for (const [name, description] of JIRA_DIRECT) {
  test(`(c) Jira-direct ticket, ${name}: triaged as before (Jev once, one model turn)`, async () => {
    const t = tracker(() => jiraIssue({ description }));
    const { sent, logs } = await deliver(description, t);
    assert.equal(jevCalls, 1, logs.join("\n"));
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /^Triage this existing issue\.\n\nidentifier: TLSSN-40/);
  });
}

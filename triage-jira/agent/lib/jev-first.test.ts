import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import recordTriage from "../tools/record_triage.js";
import { inboundKey, jevAnswersKey, stashInbound } from "./inbound.js";
import { deskFiledOnTracker, TRACKER_READ_TIMEOUT_MS } from "./desk-filed.js";
import { triageWake } from "./jev-first.js";
import { NEEDS_INFO_ASK } from "./jev-triage.js";
import { DESK_TRIAGED_LINE, withDeskTriaged } from "./desk-triaged.js";
import { triageComment } from "./triage-verdict.js";
import { INPROCESS_PEERS_ENV } from "./peers.js";
import type { QueueIssue } from "./types.js";

// Jev first on the wake: above 0.52 on type, severity, and the gate, the
// ticket is triaged with no model turn; at or under the bar, or with Jev
// down, the model turn runs and its record_triage reuses Jev's answers.

const saved = { key: process.env.TYPESAFE_API_KEY, peers: process.env[INPROCESS_PEERS_ENV], fetch: globalThis.fetch };
let jevCalls = 0;

beforeEach(() => {
  process.env[INPROCESS_PEERS_ENV] = "1";
  process.env.TYPESAFE_API_KEY = "test-key";
  jevCalls = 0;
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  for (const [name, value] of [["TYPESAFE_API_KEY", saved.key], [INPROCESS_PEERS_ENV, saved.peers]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Pair = [string, number];
function jev(issueType: Pair, severity: Pair, gate: Pair = ["proceed", 0.9]) {
  globalThis.fetch = (async () => {
    jevCalls += 1;
    const answer = ([choice, probability]: Pair) => ({ choice, probabilities: { [choice]: probability } });
    return new Response(JSON.stringify({ answers: { issueType: answer(issueType), severity: answer(severity), gate: answer(gate) } }), { status: 200 });
  }) as typeof globalThis.fetch;
}
function jevDown() {
  globalThis.fetch = (async () => {
    jevCalls += 1;
    throw new Error("TypeSafe unreachable");
  }) as typeof globalThis.fetch;
}

const str = { type: "string" };
const obj = { type: "object" };
const tools = [
  { name: "addComment", inputSchema: { type: "object", properties: { issueId: str, body: str } } },
  { name: "getComments", inputSchema: { type: "object", properties: { issueId: str } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, transition: obj } } },
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "getJiraProjectIssueTypesMetadata", inputSchema: { type: "object", properties: { projectIdOrKey: str } } },
  { name: "editJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, fields: obj } } },
];
const TYPES = { issueTypes: [{ id: "10170", name: "Task" }, { id: "10171", name: "Story" }, { id: "10172", name: "Bug" }] };

function host(getIssue: () => HostMcpCallResult | Promise<HostMcpCallResult> = () => ({ content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields: { status: { name: "To Do" } } }) }] })) {
  const calls: { connection: string; tool: string; args: Record<string, unknown> | undefined }[] = [];
  const store = new Map<string, unknown>();
  const kv = {
    get: async (key: string) => store.get(key) as never,
    put: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
  const mcp = {
    names: () => ["tracker", "planner"],
    listTools: async () => tools,
    callTool: async (connection: string, tool: string, args?: Record<string, unknown>): Promise<HostMcpCallResult> => {
      calls.push({ connection, tool, args });
      if (tool === "getJiraProjectIssueTypesMetadata") return { content: [{ type: "text", text: JSON.stringify(TYPES) }] };
      if (tool === "getJiraIssue") return getIssue();
      if (tool === "getComments") return { content: [{ type: "text", text: "[]" }], structuredContent: { comments: [] } };
      if (tool === "getTransitionsForJiraIssue") return { content: [{ type: "text", text: "ok" }], structuredContent: { transitions: [{ id: "41", name: "Triaged", to: { name: "Triaged" } }] } };
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  const comment = () => calls.find((call) => call.tool === "addComment")?.args?.["body"] as string | undefined;
  const planned = () => calls.find((call) => call.connection === "planner")?.args?.["input"] as Record<string, any> | undefined;
  return { calls, store, kv, mcp, comment, planned };
}

const issue: QueueIssue = {
  identifier: "TLSSN-42",
  url: "",
  title: "CSV export returns 500",
  description: "Export failed at 14:02 yesterday with a 500. Request id 9f2c.",
  reporter: "Sam",
  issueType: "Task",
};

async function wake(h: ReturnType<typeof host>, delivered: QueueIssue = issue) {
  let sent = 0;
  await stashInbound(h.kv as never, delivered);
  const woke = await triageWake({ issue: delivered, mcp: h.mcp as never, kv: h.kv as never, send: async () => void (sent += 1) });
  return { woke, sent };
}

const question: QueueIssue = { ...issue, title: "How long are CSV exports kept?", description: "A customer asked how long a downloaded export link stays valid." };

async function modelTurn(h: ReturnType<typeof host>, verdict: Record<string, unknown>) {
  const ctx = { session: { id: "ses_1", purpose: "live", continuationKey: "TLSSN-42" }, host: { kv: h.kv, mcp: h.mcp } };
  return (await recordTriage.execute!(verdict as never, ctx as never)) as Record<string, any>;
}

test("above 0.52 on all three: Jira type, Triage: comment, Triaged, and the plan, with no model turn", async () => {
  jev(["Bug", 0.56], ["medium", 0.84]);
  const h = host();
  const { woke, sent } = await wake(h);
  assert.deepEqual(woke, { fast: true });
  assert.equal(sent, 0, "no model turn");
  assert.equal(jevCalls, 1);
  const order = h.calls.map((call) => call.tool);
  assert.ok(order.indexOf("editJiraIssue") < order.indexOf("addComment") && order.indexOf("addComment") < order.indexOf("transitionJiraIssue"));
  const lines = h.comment()!.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["Triage: bug", "Type: Bug", "Severity: medium"]);
  assert.equal(lines[3], 'Summary: Bug reported as "CSV export returns 500", medium severity.');
  assert.match(h.comment()!, /^Judge: Jev type Bug 0\.56 \(set in Jira; Jev only\); severity medium 0\.84 \(Jev only\)$/m);
  assert.doesNotMatch(h.comment()!, /agreed|model said/);
  assert.equal(h.planned()?.verdict?.kind, "bug");
  assert.equal(h.store.has(inboundKey("TLSSN-42")), false);
  assert.equal(h.store.has(jevAnswersKey("TLSSN-42")), false);
});

test("needs info above the bar: a templated ask on the ticket, Triaged, and no plan", async () => {
  jev(["Bug", 0.9], ["low", 0.8], ["needsInfo", 0.75]);
  const h = host();
  const { woke, sent } = await wake(h);
  assert.deepEqual(woke, { fast: true });
  assert.equal(sent, 0);
  assert.match(h.comment()!, new RegExp(`^Needs info: ${NEEDS_INFO_ASK.replace(/[.,]/g, "\\$&")}$`, "m"));
  assert.ok(h.calls.some((call) => call.tool === "transitionJiraIssue"));
  assert.equal(h.planned(), undefined);
});

test("a Task above the bar is a question: Triaged, the planner is not called", async () => {
  jev(["Task", 0.9], ["low", 0.9]);
  const h = host();
  const { woke } = await wake(h, question);
  assert.deepEqual(woke, { fast: true });
  assert.match(h.comment()!, /^Triage: question$/m);
  assert.match(h.comment()!, /^Judge: Jev type Task 0\.90 \(already Task in Jira; Jev only\)/m);
  assert.equal(h.calls.some((call) => call.tool === "editJiraIssue"), false);
  assert.equal(h.planned(), undefined);
});

test("type guard: a confident Story over a report of a failure goes to the model turn, which does not write Jev's type", async () => {
  jev(["Story", 0.95], ["medium", 0.9]);
  const h = host();
  const { woke, sent } = await wake(h);
  assert.equal(woke.fast, false);
  assert.equal(sent, 1, "the model turn runs");
  assert.equal(h.comment(), undefined, "nothing written before the model");
  const output = await modelTurn(h, { identifier: "TLSSN-42", kind: "bug", severity: "medium", title: "CSV export returns 500", summary: "Export failed with a 500.", nextStep: "Find request 9f2c." });
  assert.equal(jevCalls, 1, "no second TypeSafe call");
  assert.equal(output.verdict.kind, "bug");
  assert.equal(h.calls.some((call) => call.tool === "editJiraIssue"), false);
  assert.match(h.comment()!, /^Judge: Jev type Story 0\.95 \(held back: the report says something is broken now; kept the model's bug\)/m);
});

test("type guard: when the inbound stash is lost but Jev's answers are kept, record_triage still does not write the held Story (verifier)", async () => {
  jev(["Story", 0.95], ["medium", 0.9]);
  const h = host();
  const { woke, sent } = await wake(h);
  assert.equal(woke.fast, false);
  assert.equal(sent, 1);
  assert.equal((h.store.get(jevAnswersKey("TLSSN-42")) as Record<string, unknown>)["typeHeld"], true, "the wake stashes the hold with the answers");
  h.store.delete(inboundKey("TLSSN-42"));
  // The model's restatement has no defect words, so only the stashed hold stops the Story.
  const output = await modelTurn(h, { identifier: "TLSSN-42", kind: "bug", severity: "medium", title: "CSV export changes", summary: "Asks for changes to the CSV export.", nextStep: "Look at request 9f2c." });
  assert.equal(jevCalls, 1, "no second TypeSafe call");
  assert.equal(output.verdict.kind, "bug");
  assert.equal(h.calls.some((call) => call.tool === "editJiraIssue"), false, "no issuetype edit to Story");
  assert.match(h.comment()!, /^Judge: Jev type Story 0\.95 \(held back: /m);
});

test("no hold is stashed when the wake's guard did not fire: a request's Story is still written by the model turn", async () => {
  jev(["Story", 0.95], ["low", 0.51]);
  const h = host();
  const request: QueueIssue = { ...issue, title: "Add a PDF export", description: "Could the reports page offer a PDF export alongside CSV?" };
  const { sent } = await wake(h, request);
  assert.equal(sent, 1);
  assert.equal((h.store.get(jevAnswersKey("TLSSN-42")) as Record<string, unknown>)["typeHeld"], undefined);
  h.store.delete(inboundKey("TLSSN-42"));
  await modelTurn(h, { identifier: "TLSSN-42", kind: "feedback", severity: "low", title: "PDF export", summary: "Asks for a PDF export.", nextStep: "Scope it." });
  assert.ok(h.calls.some((call) => call.tool === "editJiraIssue"), "Jev's confident Story is written");
});

test("0.58 on all three, under the old 0.60 bar, now settles the ticket with no model turn", async () => {
  jev(["Bug", 0.58], ["medium", 0.58], ["proceed", 0.58]);
  const h = host();
  const { woke, sent } = await wake(h);
  assert.deepEqual(woke, { fast: true });
  assert.equal(sent, 0);
  assert.match(h.comment()!, /^Judge: Jev type Bug 0\.58 \(set in Jira; Jev only\); severity medium 0\.58 \(Jev only\)$/m);
});

test("one answer at 0.52 is not above the bar: the model turn runs and its record_triage reuses Jev's answers", async () => {
  jev(["Bug", 0.93], ["medium", 0.52]);
  const h = host();
  const { woke, sent } = await wake(h);
  assert.equal(woke.fast, false);
  assert.equal(sent, 1);
  assert.equal(h.comment(), undefined, "nothing written before the model");
  const output = await modelTurn(h, { identifier: "TLSSN-42", kind: "question", severity: "low", title: "Export", summary: "Asks about an export.", nextStep: "Look up 9f2c." });
  assert.equal(jevCalls, 1, "no second TypeSafe call");
  assert.equal(output.verdict.kind, "bug");
  assert.match(h.comment()!, /^Triaged by: Grok 4\.6 Fast \(Jev was only 52% confident; not above 0\.52 on every answer\)\nJudge: Jev type Bug 0\.93 \(set in Jira; model said question\); severity medium 0\.52 \(kept the model's low, below 0\.52\)$/m);
});

test("Jev down on the wake: the model turn runs, and record_triage does not ask again", async () => {
  jevDown();
  const h = host();
  const { woke, sent } = await wake(h);
  assert.equal(woke.fast, false);
  assert.equal(sent, 1);
  const output = await modelTurn(h, { identifier: "TLSSN-42", kind: "bug", severity: "high", title: "Export", summary: "Export 500.", nextStep: "Inspect 9f2c." });
  assert.equal(jevCalls, 1);
  assert.equal(output.judge.status, "unavailable");
  assert.match(h.comment()!, /^Triage: bug$/m);
  assert.doesNotMatch(h.comment()!, /^Judge:/m);
});

test("no TYPESAFE_API_KEY: straight to the model turn, no Jev call", async () => {
  delete process.env.TYPESAFE_API_KEY;
  jevDown();
  const h = host();
  const { woke, sent } = await wake(h);
  assert.equal(woke.fast, false);
  assert.equal(sent, 1);
  assert.equal(jevCalls, 0);
});

test("a ticket factory-desk filed already triaged: no Jev call, no model turn, nothing written", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const h = host();
  let sent = 0;
  const filed = { ...issue, description: withDeskTriaged(`${issue.description}\n\nSlack thread: https://x.slack.com/archives/C1/p1`) };
  await stashInbound(h.kv as never, filed);
  const woke = await triageWake({ issue: filed, mcp: h.mcp as never, kv: h.kv as never, send: async () => void (sent += 1) });
  assert.deepEqual(woke, { fast: false, skipped: "desk_triaged" });
  assert.equal(sent, 0, "no model turn");
  assert.equal(jevCalls, 0, "no Jev call");
  assert.deepEqual(h.calls, [], "no Jira read or write");
  assert.equal(h.store.has(inboundKey("TLSSN-42")), false);
});

test("a Jira-direct ticket that only mentions the desk line inside other text is triaged", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const h = host();
  const quoted = { ...issue, description: `Someone wrote "${DESK_TRIAGED_LINE}" in a comment once.` };
  await stashInbound(h.kv as never, quoted);
  const woke = await triageWake({ issue: quoted, mcp: h.mcp as never, kv: h.kv as never, send: async () => 1 });
  assert.deepEqual(woke, { fast: true });
  assert.equal(jevCalls, 1);
});

// The Automation "Issue created" body carries `{{issue.description.plainText}}`,
// which ran the desk's paragraphs together on TLSSN-33, -35, and -40: the
// line-of-its-own check missed them and each ticket was triaged twice.
test("a desk-filed description as Automation's plainText glues it: still no Jev call, no turn, no Jira call", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const h = host();
  let sent = 0;
  const glued = { ...issue, description: `Freeze card has no aria-describedby.Slack thread: https://x.slack.com/archives/C1/p1${DESK_TRIAGED_LINE}` };
  const woke = await triageWake({ issue: glued, mcp: h.mcp as never, kv: h.kv as never, send: async () => void (sent += 1) });
  assert.deepEqual(woke, { fast: false, skipped: "desk_triaged" });
  assert.equal(sent + jevCalls, 0);
  assert.deepEqual(h.calls, []);
});

function jiraIssue(fields: Record<string, unknown>): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields }) }] };
}

const adf = (text: string) => ({ type: "doc", version: 1, content: text.split("\n\n").map((para) => ({ type: "paragraph", content: [{ type: "text", text: para }] })) });

async function wakeWith(h: ReturnType<typeof host>, description: string, extra: Partial<QueueIssue> = {}) {
  let sent = 0;
  const delivered = { ...issue, ...extra, description };
  await stashInbound(h.kv as never, delivered);
  const woke = await triageWake({ issue: delivered, mcp: h.mcp as never, kv: h.kv as never, send: async () => void (sent += 1) });
  return { woke, sent, writes: h.calls.filter((call) => call.tool !== "getJiraIssue") };
}

test("a delivered description without the line: the ticket read back from Jira carries it, so nothing is judged or written; a failed read blocks nothing", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const h = host(() => jiraIssue({ status: { name: "To Do" }, description: adf(withDeskTriaged("Freeze card.\n\nSlack thread: https://x.slack.com/archives/C1/p1")), comment: { comments: [] } }));
  const { woke, sent, writes } = await wakeWith(h, "");
  assert.deepEqual(woke, { fast: false, skipped: "desk_triaged", via: "tracker_description" });
  assert.equal(sent + jevCalls, 0);
  assert.deepEqual(writes, []);
  assert.equal(h.store.has(inboundKey("TLSSN-42")), false);

  // A read that fails or throws does not block an ordinary ticket's triage.
  for (const getIssue of [() => ({ isError: true, content: [{ type: "text" as const, text: "rate limited" }] }), () => Promise.reject(new Error("socket hang up"))]) {
    jevCalls = 0;
    const failing = await wakeWith(host(getIssue), "Export failed at 14:02 yesterday with a 500.");
    assert.equal("skipped" in failing.woke, false, "triaged, by Jev or the turn");
    assert.equal(jevCalls, 1);
  }
});

test("a stored description that ends in a code block quoting the desk's line is not the desk's: the ticket is triaged", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const code = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "The footer we saw:" }] }, { type: "codeBlock", content: [{ type: "text", text: DESK_TRIAGED_LINE }] }] };
  const { woke } = await wakeWith(host(() => jiraIssue({ status: { name: "To Do" }, description: code, comment: { comments: [] } })), "The footer we saw:");
  assert.equal("skipped" in woke, false);
  assert.equal(jevCalls, 1);
});

test("the desk's own Triage: comment on the ticket stops the wake, even while the ticket is still To Do", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const verdict = { identifier: "TLSSN-42", kind: "bug" as const, severity: "medium" as const, title: "x", summary: "x", nextStep: "y" };
  const deskComment = withDeskTriaged(triageComment(verdict, undefined, "Triaged by: Jev (type, severity, and gate all above 0.52)", "Bug"));
  const h = host(() => jiraIssue({ status: { name: "To Do" }, description: "Freeze card.", comment: { comments: [{ body: adf(deskComment) }] } }));
  const { woke, sent, writes } = await wakeWith(h, "Freeze card.");
  assert.deepEqual(woke, { fast: false, skipped: "desk_triaged", via: "desk_triage_comment" });
  assert.equal(sent + jevCalls, 0);
  assert.deepEqual(writes, []);

  // triage-jira's own Triage: comment is not the desk's: a redelivery goes on to record_triage's own dedupe.
  const own = host(() => jiraIssue({ status: { name: "To Do" }, description: "Freeze card.", comment: { comments: [{ body: "Triage: bug\nSeverity: medium" }] } }));
  const again = await wakeWith(own, "Freeze card.");
  assert.equal("skipped" in again.woke, false);
  assert.equal(jevCalls, 1);
});

test("a ticket already past To Do was triaged already: no Jev call, no turn", async () => {
  for (const status of ["Triaged", "Planned", "In Progress", "Done"]) {
    jev(["Bug", 0.93], ["medium", 0.84]);
    jevCalls = 0;
    const h = host(() => jiraIssue({ status: { name: status }, description: "Freeze card." }));
    const { woke, sent, writes } = await wakeWith(h, "Freeze card.");
    assert.deepEqual(woke, { fast: false, skipped: "desk_triaged", via: "past_todo" }, status);
    assert.equal(sent + jevCalls, 0);
    assert.deepEqual(writes, []);
  }
});

test("past To Do counts only for a ticket created in To Do: one a person created straight into a later status is triaged as before", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const inTodo = await wakeWith(host(() => jiraIssue({ status: { name: "Triaged" }, description: "Freeze card." })), "Freeze card.", { status: "To Do" });
  assert.deepEqual(inTodo.woke, { fast: false, skipped: "desk_triaged", via: "past_todo" });
  assert.equal(jevCalls, 0);

  for (const status of ["In Progress", "Triaged"]) {
    jevCalls = 0;
    const direct = await wakeWith(host(() => jiraIssue({ status: { name: status }, description: "Freeze card." })), "Freeze card.", { status });
    assert.equal("skipped" in direct.woke, false, status);
    assert.equal(jevCalls, 1, `${status}: Jev is asked first, as for any Jira-filed ticket`);
  }
});

test("FACTORY_STATUS_* overrides decide what is past To Do", async () => {
  const saved = { todo: process.env.FACTORY_STATUS_TODO, progress: process.env.FACTORY_STATUS_IN_PROGRESS };
  process.env.FACTORY_STATUS_TODO = "Open";
  process.env.FACTORY_STATUS_IN_PROGRESS = "Building";
  try {
    jev(["Bug", 0.93], ["medium", 0.84]);
    const building = await wakeWith(host(() => jiraIssue({ status: { name: "Building" }, description: "Freeze card." })), "Freeze card.", { status: "Open" });
    assert.deepEqual(building.woke, { fast: false, skipped: "desk_triaged", via: "past_todo" });
    jevCalls = 0;
    const open = await wakeWith(host(() => jiraIssue({ status: { name: "Open" }, description: "Freeze card." })), "Freeze card.", { status: "Open" });
    assert.equal("skipped" in open.woke, false);
    assert.equal(jevCalls, 1);
  } finally {
    for (const [name, value] of [["FACTORY_STATUS_TODO", saved.todo], ["FACTORY_STATUS_IN_PROGRESS", saved.progress]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a tracker read that never answers is cut off and reads as unread, so nothing is skipped", async () => {
  const h = host(() => new Promise<HostMcpCallResult>(() => {}));
  const look = await deskFiledOnTracker(h.mcp as never, "TLSSN-42", { env: {}, timeoutMs: 10 });
  assert.deepEqual(look, { skip: false, read: "unread", detail: "no answer within 10 ms" });
  assert.equal(TRACKER_READ_TIMEOUT_MS, 8_000);
});

test("a ticket triage-jira does triage logs the delivered description's length and tail", async () => {
  jevDown();
  const h = host();
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await wakeWith(h, `Line one.\n${"x".repeat(100)}"end"`);
  } finally {
    console.log = log;
  }
  const diagnostic = lines.find((line) => line.includes("triaging:"));
  assert.equal(diagnostic, `[triage] TLSSN-42 triaging: description length 115, ends ${JSON.stringify(`${"x".repeat(75)}"end"`)}; tracker read, status To Do`);
});

test("the fallback triage turn runs on the root model, grok-4.6 fast, not Auto", async () => {
  const saved = process.env.FACTORY_AGENT_MODEL;
  delete process.env.FACTORY_AGENT_MODEL;
  try {
    const { default: agent } = await import(`../agent.js?root=${Date.now()}`);
    assert.deepEqual(agent.model, { id: "grok-4.6", params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] });
  } finally {
    if (saved !== undefined) process.env.FACTORY_AGENT_MODEL = saved;
  }
});

// Live 2026-09-27: a confirmation-step request filed at urgent.
const LOG_OUT = 'The "Log out" button logs you out straight away even when the transfer form has something typed in. Could it ask to confirm first when the form has input?';
const logOut = { title: "Log out asks no confirmation" };

test("Jev above the bar at urgent on a confirmation-step ask: the ticket is triaged medium, and the Judge: line agrees", async () => {
  jev(["Bug", 0.93], ["urgent", 0.84]);
  const h = host();
  assert.deepEqual((await wakeWith(h, LOG_OUT, logOut)).woke, { fast: true });
  assert.match(h.comment()!, /^Severity: medium$/m);
  assert.match(h.comment()!, /severity medium 0\.84 \(Jev only\)$/m);
  assert.match(h.comment()!, /^Triaged by: Jev \(84% confidence; Jev said urgent; type, severity, and gate all above 0\.52\)$/m, "triage-jira's own Jev-only comment says it too");
});

test("Jev above the bar at urgent on an outage stays urgent", async () => {
  jev(["Bug", 0.93], ["urgent", 0.84]);
  const h = host();
  await wakeWith(h, "Customers can't log in on web or mobile since 9am.", { title: "Login outage" });
  assert.match(h.comment()!, /^Severity: urgent$/m);
});

test("the model turn's urgent on a confirmation-step ask is recorded medium, even with Jev's urgent above the bar", async () => {
  jev(["Bug", 0.93], ["urgent", 0.84], ["proceed", 0.5]);
  const h = host();
  await wakeWith(h, LOG_OUT, logOut);
  const output = await modelTurn(h, { identifier: "TLSSN-42", kind: "bug", severity: "urgent", title: "Log out confirm", summary: "Log out ignores typed input.", nextStep: "Add a confirm." });
  assert.equal(output.verdict.severity, "medium");
  assert.match(h.comment()!, /^Severity: medium$/m);
});

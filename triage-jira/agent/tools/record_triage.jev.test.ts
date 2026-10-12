import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import { inboundKey } from "../lib/inbound.js";
import { JEV_THRESHOLD } from "../lib/jev-triage.js";
import { INPROCESS_PEERS_ENV } from "../lib/peers.js";
import recordTriage from "./record_triage.js";

// The judgment contract end to end: a ticket as the webhook stashed it, the
// model's verdict, the project's Jira issue types, and a stubbed TypeSafe
// answer go in; the issuetype edit, the Triage: comment, the Triaged move,
// and the planner handoff come out, in that order.

const saved = { key: process.env.TYPESAFE_API_KEY, peers: process.env[INPROCESS_PEERS_ENV], fetch: globalThis.fetch };
let jevRequests: { state: Record<string, unknown>; questions: Record<string, { criteria?: Record<string, string> }> }[] = [];

beforeEach(() => {
  process.env[INPROCESS_PEERS_ENV] = "1";
  jevRequests = [];
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  restore("TYPESAFE_API_KEY", saved.key);
  restore(INPROCESS_PEERS_ENV, saved.peers);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jevAnswers(issueType: [string, number], severity: [string, number]) {
  process.env.TYPESAFE_API_KEY = "test-key";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    jevRequests.push(JSON.parse(String(init?.body)));
    const answer = ([choice, probability]: [string, number]) => ({ choice, probabilities: { [choice]: probability } });
    return new Response(JSON.stringify({ answers: { issueType: answer(issueType), severity: answer(severity), gate: answer(["proceed", 0.9]) } }), { status: 200 });
  }) as typeof globalThis.fetch;
}

type Call = { connection: string; tool: string; args: Record<string, unknown> | undefined };

const obj = { type: "object" };
const str = { type: "string" };
const tools = [
  { name: "addComment", inputSchema: { type: "object", properties: { issueId: str, body: str } } },
  { name: "getComments", inputSchema: { type: "object", properties: { issueId: str } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, transition: obj } } },
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "getJiraProjectIssueTypesMetadata", inputSchema: { type: "object", properties: { projectIdOrKey: str } } },
  { name: "editJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, fields: obj } } },
];

const TLSSN_TYPES = {
  issueTypes: [
    { id: "10170", name: "Task", subtask: false, hierarchyLevel: 0 },
    { id: "10171", name: "Story", subtask: false, hierarchyLevel: 0 },
    { id: "10172", name: "Bug", subtask: false, hierarchyLevel: 0 },
    { id: "10173", name: "Epic", subtask: false, hierarchyLevel: 1 },
    { id: "10174", name: "Subtask", subtask: true, hierarchyLevel: -1 },
  ],
};

async function run(input: { verdict: Record<string, unknown>; stash?: Record<string, unknown>; purpose?: string; editFails?: boolean }) {
  const calls: Call[] = [];
  const store = new Map<string, unknown>();
  if (input.stash !== undefined) store.set(inboundKey("TLSSN-42"), input.stash);
  const ctx = {
    session: { id: "ses_1", channelId: "webhook", mode: "chat", purpose: input.purpose ?? "live", auth: null, continuationKey: "TLSSN-42" },
    host: {
      kv: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (key: string) => void store.delete(key),
      },
      mcp: {
        names: () => ["tracker", "planner"],
        listTools: async () => tools,
        callTool: async (connection: string, tool: string, args?: Record<string, unknown>): Promise<HostMcpCallResult> => {
          calls.push({ connection, tool, args });
          if (tool === "getJiraProjectIssueTypesMetadata") return { content: [{ type: "text", text: JSON.stringify(TLSSN_TYPES) }] };
          if (tool === "editJiraIssue" && input.editFails === true) return { content: [{ type: "text", text: "Issue type cannot be changed." }], isError: true };
          if (tool === "getJiraIssue") return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields: { status: { name: "To Do" } } }) }] };
          if (tool === "getComments") return { content: [{ type: "text", text: "[]" }], structuredContent: { comments: [] } };
          if (tool === "getTransitionsForJiraIssue") return { content: [{ type: "text", text: "ok" }], structuredContent: { transitions: [{ id: "41", name: "Triaged", to: { name: "Triaged" } }] } };
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    },
  };
  const output = (await recordTriage.execute!(input.verdict as never, ctx as never)) as Record<string, any>;
  const comment = calls.find((call) => call.tool === "addComment")?.args?.["body"] as string | undefined;
  const order = calls.map((call) => call.tool);
  return { output, calls, comment, store, order };
}

const exportFailed = {
  identifier: "TLSSN-42",
  title: "Why did my export fail yesterday?",
  description: "My CSV export failed at 14:02 yesterday with a 500. Request id 9f2c.",
  reporter: "Sam",
  issueType: "Task",
};

const modelQuestion = {
  identifier: "TLSSN-42",
  kind: "question",
  severity: "low",
  title: "Why did the export fail",
  summary: "Asks about a failed export.",
  nextStep: "Look up request 9f2c.",
};

test("a question about a failure that happened: Jev picks Bug, Jira gets Bug before the comment, the planner plans a bug", async () => {
  jevAnswers(["Bug", 0.93], ["medium", 0.84]);
  const { output, calls, comment, store, order } = await run({ verdict: modelQuestion, stash: exportFailed });

  assert.deepEqual(Object.keys(jevRequests[0]!.questions.issueType!.criteria!), ["Task", "Story", "Bug"]);
  assert.deepEqual(jevRequests[0]!.state, { source: "webhook", title: exportFailed.title, description: exportFailed.description, reporter: "Sam" });
  const edit = calls.find((call) => call.tool === "editJiraIssue");
  assert.deepEqual(edit?.args, { issueIdOrKey: "TLSSN-42", fields: { issuetype: { id: "10172" } } });
  assert.ok(order.indexOf("editJiraIssue") < order.indexOf("addComment"), "type before comment");
  assert.ok(order.indexOf("addComment") < order.indexOf("transitionJiraIssue"), "comment before Triaged");
  assert.equal(output.verdict.kind, "bug");
  assert.equal(output.verdict.summary, modelQuestion.summary);
  assert.equal(output.judge.type.jira, "set");
  assert.deepEqual(comment!.split("\n").slice(0, 3), ["Triage: bug", "Type: Bug", "Severity: medium"]);
  assert.match(comment!, /^Judge: Jev type Bug 0\.93 \(set in Jira; model said question\); severity medium 0\.84 \(model said low\)$/m);
  assert.equal((calls.find((call) => call.connection === "planner")?.args?.["input"] as any)?.verdict?.kind, "bug");
  assert.equal(output.chained, true);
  assert.equal(store.has(inboundKey("TLSSN-42")), false, "the stash is consumed");
  assert.ok(store.has("triage-issue-types/TLSSN"), "the project's types are cached");
});

test("the Jira edit is refused: the model's kind stands, the Judge line says so, and the ticket still moves to Triaged", async () => {
  jevAnswers(["Bug", 0.93], ["medium", 0.84]);
  const { output, comment, order } = await run({ verdict: modelQuestion, stash: exportFailed, editFails: true });
  assert.equal(output.verdict.kind, "question");
  assert.equal(output.judge.type.jira, "failed");
  assert.equal(output.judge.type.message, "Issue type cannot be changed.");
  assert.deepEqual(comment!.split("\n").slice(0, 3), ["Triage: question", "Type: Task", "Severity: medium"]);
  assert.match(comment!, /^Judge: Jev type Bug 0\.93 \(Jira edit failed, kept the model's question\); severity medium 0\.84 \(model said low\)$/m);
  assert.ok(order.includes("transitionJiraIssue"));
  assert.equal(output.reason, "question");
});

test("a feature idea phrased as a question: Jev picks Story over the model's bug, and the planner plans it as feedback", async () => {
  jevAnswers(["Story", 0.88], ["low", 0.9]);
  const { output, comment } = await run({
    verdict: { ...modelQuestion, kind: "bug", severity: "medium", title: "Dark mode?" },
    stash: { identifier: "TLSSN-42", title: "Could we have dark mode?", description: "Would be nice at night.", issueType: "Task" },
  });
  assert.equal(output.verdict.kind, "feedback");
  assert.deepEqual(comment!.split("\n").slice(0, 2), ["Triage: feedback", "Type: Story"]);
  assert.equal(output.chained, true);
});

test("a how-to question filed as a Bug: Jev picks Task, the model's question stands and the planner skips it", async () => {
  jevAnswers(["Task", 0.91], ["low", 0.9]);
  const asked = await run({
    verdict: { ...modelQuestion, kind: "question" },
    stash: { identifier: "TLSSN-42", title: "Rotate staging API keys", description: "How do I rotate the API keys for staging?", issueType: "Bug" },
  });
  assert.equal(asked.output.verdict.kind, "question");
  assert.equal(asked.output.reason, "question");
  assert.equal(asked.calls.some((call) => call.connection === "planner"), false);
  assert.equal(asked.comment!.split("\n")[1], "Type: Task");
});

const retentionQuestion = {
  identifier: "TLSSN-42",
  title: "How long are CSV exports kept?",
  description: "A customer asked how long a downloaded CSV export link stays valid.",
  reporter: "Sam",
  issueType: "Task",
};

test("the type Jev picked is already on the ticket: no edit, the line says so", async () => {
  jevAnswers(["Task", JEV_THRESHOLD + 0.01], ["low", 0.9]);
  const { calls, comment } = await run({ verdict: modelQuestion, stash: retentionQuestion });
  assert.equal(calls.some((call) => call.tool === "editJiraIssue"), false);
  assert.match(comment!, /^Judge: Jev type Task 0\.53 \(already Task in Jira; agreed\); severity low 0\.90 \(agreed\)$/m);
});

test("type guard: a confident Task over a report of a failure (a 500) is held back, not written, and the line says why", async () => {
  jevAnswers(["Task", 0.9], ["low", 0.9]);
  const { output, calls, comment } = await run({ verdict: { ...modelQuestion, kind: "bug" }, stash: exportFailed });
  assert.equal(calls.some((call) => call.tool === "editJiraIssue"), false);
  assert.equal(output.verdict.kind, "bug", "the model's kind stands");
  assert.match(comment!, /^Judge: Jev type Task 0\.90 \(held back: the report says something is broken now; kept the model's bug\)/m);
});

test("exactly at the bar is not above it: no edit", async () => {
  jevAnswers(["Bug", JEV_THRESHOLD], ["low", 0.9]);
  const { calls, comment } = await run({ verdict: modelQuestion, stash: exportFailed });
  assert.equal(JEV_THRESHOLD, 0.52);
  assert.equal(calls.some((call) => call.tool === "editJiraIssue"), false);
  assert.match(comment!, /^Judge: Jev type Bug 0\.52 \(below 0\.52, kept the model's question\)/m);
});

test("below the bar: no edit, the ticket keeps its type and the model's verdict", async () => {
  jevAnswers(["Bug", JEV_THRESHOLD - 0.01], ["low", 0.9]);
  const { output, calls, comment } = await run({ verdict: modelQuestion, stash: exportFailed });
  assert.equal(calls.some((call) => call.tool === "editJiraIssue"), false);
  assert.equal(output.verdict.kind, "question");
  assert.equal(comment!.split("\n")[1], "Type: Task");
  assert.match(comment!, /^Judge: Jev type Bug 0\.51 \(below 0\.52, kept the model's question\); severity low 0\.90 \(agreed\)$/m);
});

test("no TYPESAFE_API_KEY: no Jev call, no edit, and the comment is the model's verdict", async () => {
  delete process.env.TYPESAFE_API_KEY;
  globalThis.fetch = (async () => {
    throw new Error("fetch must not run without a key");
  }) as typeof globalThis.fetch;
  const { output, calls, comment } = await run({ verdict: modelQuestion, stash: { ...exportFailed, issueType: undefined } });
  assert.deepEqual(output.judge, { status: "skipped", reason: "no_key" });
  assert.equal(calls.some((call) => call.tool === "editJiraIssue"), false);
  assert.equal(comment, ["Triage: question", "Severity: low", "Summary: Asks about a failed export.", "Next step: Look up request 9f2c.", "Triaged by: Grok 4.6 Fast (Jev is not configured)"].join("\n"));
});

test("TypeSafe down: triage still comments and moves with the model's verdict", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof globalThis.fetch;
  const { output, calls, comment } = await run({ verdict: modelQuestion, stash: exportFailed });
  assert.equal(output.judge.status, "unavailable");
  assert.equal(calls.some((call) => call.tool === "editJiraIssue"), false);
  assert.equal(comment!.split("\n")[0], "Triage: question");
  assert.doesNotMatch(comment!, /^Judge:/m);
  assert.match(comment!, /^Triaged by: Grok 4\.6 Fast \(Jev did not settle it: /m, "who triaged it, and why Jev did not");
  assert.ok(calls.some((call) => call.tool === "transitionJiraIssue"));
});

test("eval sessions judge over the model's words with the default types and write nothing", async () => {
  jevAnswers(["Bug", 0.93], ["medium", 0.84]);
  const { output, calls, store } = await run({ verdict: modelQuestion, stash: exportFailed, purpose: "eval" });
  assert.equal(jevRequests[0]!.state["source"], "model");
  assert.deepEqual(Object.keys(jevRequests[0]!.questions.issueType!.criteria!), ["Bug", "Story", "Task"]);
  assert.equal(output.verdict.kind, "bug");
  assert.equal(output.judge.type.jira, "eval");
  assert.deepEqual(output.tracker, { status: "skipped", reason: "eval" });
  assert.equal(calls.length, 0);
  assert.equal(store.has(inboundKey("TLSSN-42")), true, "eval leaves the live stash alone");
});

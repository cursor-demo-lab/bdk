import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import recordTriage from "../tools/record_triage.js";
import { INPROCESS_PEERS_ENV } from "./peers.js";

// The peer hop is the local serve --dir . path. Hosted, the ticket entering
// Triaged wakes the planner instead (reason "event_bus").
const savedPeers = process.env[INPROCESS_PEERS_ENV];
before(() => {
  process.env[INPROCESS_PEERS_ENV] = "1";
});
after(() => {
  if (savedPeers === undefined) delete process.env[INPROCESS_PEERS_ENV];
  else process.env[INPROCESS_PEERS_ENV] = savedPeers;
});

type Call = { connection: string; tool: string; args: Record<string, unknown> | undefined };

const commentTool = {
  name: "addComment",
  inputSchema: { type: "object", properties: { issueId: { type: "string" }, body: { type: "string" } } },
};

const bug = {
  identifier: "TLSSN-42",
  kind: "bug" as const,
  severity: "medium" as const,
  title: "CSV export returns 500",
  summary: "Since this morning.",
  nextStep: "Inspect 41ac.",
};

const listCommentsTool = {
  name: "getComments",
  inputSchema: { type: "object", properties: { issueId: { type: "string" } } },
};

const listTransitionsTool = {
  name: "getTransitionsForJiraIssue",
  inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } },
};

const transitionTool = {
  name: "transitionJiraIssue",
  inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, transition: { type: "object" } } },
};

const getIssueTool = {
  name: "getJiraIssue",
  inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } },
};

/** `currentStatus` adds a getJiraIssue tool that reports that status. */
function run(input: {
  verdict?: Record<string, unknown>;
  purpose?: string;
  connected?: boolean;
  plannerThrows?: boolean;
  commentFails?: boolean;
  existingComments?: string[];
  currentStatus?: string;
}) {
  const tools = [
    commentTool,
    ...(input.existingComments === undefined ? [] : [listCommentsTool]),
    ...(input.currentStatus === undefined ? [] : [getIssueTool]),
    listTransitionsTool,
    transitionTool,
  ];
  const calls: Call[] = [];
  const ctx = {
    session: {
      id: "ses_1",
      channelId: "webhook",
      mode: "chat",
      purpose: input.purpose ?? "live",
      auth: null,
      continuationKey: "TLSSN-42",
    },
    host: {
      kv: {
        get: async () => undefined,
        put: async () => {},
        delete: async () => {},
      },
      mcp: {
        names: () => (input.connected === false ? [] : ["tracker", "planner"]),
        listTools: async () => tools,
        callTool: async (connection: string, tool: string, args?: Record<string, unknown>): Promise<HostMcpCallResult> => {
          if (connection === "planner" && input.plannerThrows === true) throw new Error("planner down");
          calls.push({ connection, tool, args });
          if (connection === "tracker" && tool === getIssueTool.name) {
            return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields: { status: { name: input.currentStatus } } }) }] };
          }
          if (connection === "tracker" && tool === listCommentsTool.name) {
            return { content: [{ type: "text", text: JSON.stringify(input.existingComments ?? []) }], structuredContent: { comments: input.existingComments ?? [] } };
          }
          if (connection === "tracker" && tool === listTransitionsTool.name) {
            return { content: [{ type: "text", text: "ok" }], structuredContent: { transitions: [{ id: "11", name: "Triage", to: { name: "Triaged" } }] } };
          }
          if (connection === "tracker" && input.commentFails === true) {
            return { content: [{ type: "text", text: "no" }], isError: true };
          }
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    },
  };
  return { calls, done: recordTriage.execute!((input.verdict ?? bug) as never, ctx as never) };
}

function plannerCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.connection === "planner");
}

function transitionCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.connection === "tracker" && call.tool === transitionTool.name);
}

test("a commented bug hands the ticket to the planner's plan_issue over call_tool", async () => {
  const { calls, done } = run({ currentStatus: "To Do" });
  const result = (await done) as Record<string, unknown>;
  assert.equal(result["chained"], true);
  assert.equal(calls.some((call) => call.connection === "tracker" && call.tool === "addComment"), true);
  assert.deepEqual(transitionCalls(calls), [
    { connection: "tracker", tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "11" } } },
  ]);
  assert.deepEqual(result["transition"], { status: "transitioned" });
  const planned = plannerCalls(calls);
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.tool, "call_tool");
  assert.deepEqual(planned[0]?.args, {
    toolName: "plan_issue",
    input: {
      issueKey: "TLSSN-42",
      title: "CSV export returns 500",
      summary: "Since this morning.",
      verdict: { kind: "bug", severity: "medium", nextStep: "Inspect 41ac." },
    },
  });
  assert.equal(calls.at(-1)?.connection, "planner");
});

test("eval sessions, failed writes, questions, needs-info, duplicates, and a missing planner edge make no call", async () => {
  const variants = [
    run({ purpose: "eval" }),
    run({ commentFails: true }),
    run({ verdict: { ...bug, kind: "question" } }),
    run({ verdict: { ...bug, needsInfo: true } }),
    run({ verdict: { ...bug, duplicateOf: "TLSSN-7" } }),
    run({ connected: false }),
  ];
  for (const variant of variants) {
    const result = (await variant.done) as Record<string, unknown>;
    assert.equal(plannerCalls(variant.calls).length, 0);
    assert.notEqual(result["chained"], true);
  }
  for (const variant of [variants[0]!, variants[1]!, variants[5]!]) {
    assert.deepEqual(transitionCalls(variant.calls), []);
  }
});

test("a question is still commented and moved to Triaged; the planner reads the verdict and skips it", async () => {
  const { calls, done } = run({ verdict: { ...bug, kind: "question" }, currentStatus: "To Do" });
  const result = (await done) as Record<string, unknown>;
  assert.equal(transitionCalls(calls).length, 1);
  assert.deepEqual(result["transition"], { status: "transitioned" });
});

test("a redelivered webhook that finds its Triage: comment on the ticket writes nothing and does not plan again", async () => {
  const { calls, done } = run({ existingComments: ["Triage: bug, high. CSV export returns 500."] });
  const result = (await done) as Record<string, unknown>;
  assert.equal(calls.some((call) => call.connection === "tracker" && call.tool === "addComment"), false);
  assert.deepEqual(plannerCalls(calls), []);
  assert.deepEqual(transitionCalls(calls), []);
  assert.deepEqual(result["transition"], { status: "skipped_status" });
  assert.deepEqual({ chained: result["chained"], reason: result["reason"] }, { chained: false, reason: "already_commented" });

  const fresh = run({ existingComments: ["Someone else: looks like the filter."], currentStatus: "To Do" });
  await fresh.done;
  assert.equal(fresh.calls.some((call) => call.connection === "tracker" && call.tool === "addComment"), true);
  assert.equal(transitionCalls(fresh.calls).length, 1);
  assert.equal(plannerCalls(fresh.calls).length, 1);
});

test("a redelivery that finds its Triage: comment moves a ticket still in To Do to Triaged once and leaves a Planned one where it is", async () => {
  const { calls, done } = run({ existingComments: ["Triage: bug, high. CSV export returns 500."], currentStatus: "To Do" });
  const result = (await done) as Record<string, unknown>;
  assert.equal(calls.some((call) => call.connection === "tracker" && call.tool === "addComment"), false);
  assert.deepEqual(transitionCalls(calls), [
    { connection: "tracker", tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "11" } } },
  ]);
  assert.deepEqual(result["transition"], { status: "transitioned" });
  assert.deepEqual(plannerCalls(calls), []);

  const planned = run({ existingComments: ["Triage: bug, high. CSV export returns 500."], currentStatus: "Planned" });
  const left = (await planned.done) as Record<string, unknown>;
  assert.deepEqual(transitionCalls(planned.calls), []);
  assert.deepEqual(left["transition"], { status: "skipped_status", current: "Planned" });
  assert.deepEqual(plannerCalls(planned.calls), []);
});

test("a fresh Triage: comment on a ticket that already left To Do never drags it back to Triaged", async () => {
  for (const status of [undefined, "Triaged", "Planned", "Approved", "In Progress", "In Review", "Done"]) {
    const { calls, done } = run({ currentStatus: status });
    const result = (await done) as Record<string, unknown>;
    assert.equal(calls.some((call) => call.connection === "tracker" && call.tool === "addComment"), true, status);
    assert.deepEqual(transitionCalls(calls), [], status);
    assert.deepEqual(result["transition"], status === undefined ? { status: "skipped_status" } : { status: "skipped_status", current: status }, status);
  }
});

test("without in-process peers the comment is written, the ticket moves to Triaged, and the planner is left to Jira", async () => {
  delete process.env[INPROCESS_PEERS_ENV];
  try {
    const { calls, done } = run({ currentStatus: "To Do" });
    const result = (await done) as Record<string, unknown>;
    assert.deepEqual({ chained: result["chained"], reason: result["reason"] }, { chained: false, reason: "event_bus" });
    assert.equal(calls.some((call) => call.connection === "tracker" && call.tool === "addComment"), true);
    assert.deepEqual(transitionCalls(calls), [
      { connection: "tracker", tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "11" } } },
    ]);
    assert.deepEqual(result["transition"], { status: "transitioned" });
    assert.deepEqual(plannerCalls(calls), []);
  } finally {
    process.env[INPROCESS_PEERS_ENV] = "1";
  }
});

test("a failed planner call does not fail the tool", async () => {
  const { calls, done } = run({ plannerThrows: true });
  const result = (await done) as Record<string, unknown>;
  assert.deepEqual({ chained: result["chained"], reason: result["reason"] }, { chained: false, reason: "planner down" });
  assert.equal(plannerCalls(calls).length, 0);
  assert.equal(calls.some((call) => call.connection === "tracker"), true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { transitionIssue } from "./transition.js";

type Call = { tool: string; args: Record<string, unknown> };

const atlassianTools: HostMcpToolInfo[] = [
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
];

const transitions = {
  transitions: [
    { id: "11", name: "Start triage", to: { name: "Triaged" } },
    { id: "21", name: "Plan", to: { name: "Planned" } },
  ],
};

function text(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function registry(options: { connected?: boolean; tools?: HostMcpToolInfo[]; listed?: unknown; current?: string; calls: Call[] }): HostMcpRegistry {
  return {
    names: () => (options.connected === false ? [] : ["tracker"]),
    listTools: async () => options.tools ?? atlassianTools,
    callTool: async (_connection, tool, args) => {
      options.calls.push({ tool, args: args ?? {} });
      if (tool === "getTransitionsForJiraIssue" || tool === "get_transitions") return text(options.listed ?? transitions);
      if (tool === "getJiraIssue") return text({ key: "TLSSN-42", fields: { status: { name: options.current ?? "To Do" } } });
      return text({});
    },
  };
}

test("transitionIssue picks the transition into the status and names arguments from the schema", async () => {
  const calls: Call[] = [];
  const outcome = await transitionIssue(registry({ calls }), { issueKey: "TLSSN-42", toStatus: "triaged" });
  assert.deepEqual(outcome, { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "getTransitionsForJiraIssue", args: { issueIdOrKey: "TLSSN-42", cloudId: "https://<JIRA_SITE>.atlassian.net" } },
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "11" }, cloudId: "https://<JIRA_SITE>.atlassian.net" } },
  ]);
});

test("transitionIssue passes a bare id under transition_id for snake_case tools", async () => {
  const calls: Call[] = [];
  const tools: HostMcpToolInfo[] = [
    { name: "get_transitions", inputSchema: { type: "object", properties: { issue_key: { type: "string" } } } },
    { name: "transition_issue", inputSchema: { type: "object", properties: { issue_key: { type: "string" }, transition_id: { type: "string" } } } },
  ];
  const listed = { items: [{ id: 31, name: "Triaged" }] };
  const outcome = await transitionIssue(registry({ calls, tools, listed }), { issueKey: "TLSSN-42", toStatus: "Triaged" });
  assert.deepEqual(outcome, { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "get_transitions", args: { issue_key: "TLSSN-42" } },
    { tool: "transition_issue", args: { issue_key: "TLSSN-42", transition_id: "31" } },
  ]);
});

test("transitionIssue reports already when the ticket sits in the status", async () => {
  const calls: Call[] = [];
  const outcome = await transitionIssue(registry({ calls, listed: { transitions: [] }, current: "Triaged" }), { issueKey: "TLSSN-42", toStatus: "Triaged" });
  assert.deepEqual(outcome, { status: "already" });
  assert.equal(calls.some((call) => call.tool === "transitionJiraIssue"), false);
});

test("transitionIssue reports no_transition with the reachable statuses", async () => {
  const calls: Call[] = [];
  const outcome = await transitionIssue(registry({ calls }), { issueKey: "TLSSN-42", toStatus: "Approved" });
  assert.deepEqual(outcome, { status: "no_transition", available: ["Triaged", "Planned"] });
  assert.equal(calls.some((call) => call.tool === "transitionJiraIssue"), false);
});

test("transitionIssue without a list tool moves by status name", async () => {
  const calls: Call[] = [];
  const tools: HostMcpToolInfo[] = [
    { name: "transition_issue", inputSchema: { type: "object", properties: { issueKey: { type: "string" }, status: { type: "string" } } } },
  ];
  const outcome = await transitionIssue(registry({ calls, tools }), { issueKey: "TLSSN-42", toStatus: "Triaged" });
  assert.deepEqual(outcome, { status: "transitioned" });
  assert.deepEqual(calls, [{ tool: "transition_issue", args: { issueKey: "TLSSN-42", status: "Triaged" } }]);
});

test("transitionIssue reports not_connected without the tracker", async () => {
  const calls: Call[] = [];
  const outcome = await transitionIssue(registry({ calls, connected: false }), { issueKey: "TLSSN-42", toStatus: "Triaged" });
  assert.deepEqual(outcome, { status: "not_connected" });
  assert.deepEqual(calls, []);
});

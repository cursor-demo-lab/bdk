import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { PROJECTS_ENV, allowedProjects, collectCommentBodies, commentOnTicket, issueStatus, pickProperty, projectOf, readTicket, richTextValue, transitionFrom, transitionIssue } from "./jira.js";

const tools: HostMcpToolInfo[] = [
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } },
  { name: "getJiraIssueComments", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } },
  { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, commentBody: { type: "string" }, body: { type: "string" } } } },
];

function text(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function registry(options: { connected?: boolean; comments?: string[]; calls?: { tool: string; args: Record<string, unknown> }[] }): HostMcpRegistry {
  const connected = options.connected ?? true;
  const calls = options.calls ?? [];
  return {
    names: () => (connected ? ["tracker"] : []),
    listTools: async () => tools,
    callTool: async (_connection, tool, args) => {
      calls.push({ tool, args: args ?? {} });
      if (tool === "getJiraIssue") {
        return text({
          key: "TLSSN-42",
          fields: {
            summary: "Retry CSV export on empty filter",
            description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Export returns 500 on empty filter." }] }] },
          },
        });
      }
      if (tool === "getJiraIssueComments") {
        return text({ comments: (options.comments ?? []).map((body) => ({ body })) });
      }
      return text({ id: "10001" });
    },
  };
}

test("projects come from the override, then FACTORY_JIRA_PROJECTS", () => {
  assert.deepEqual(allowedProjects({}), []);
  assert.deepEqual(allowedProjects({ FACTORY_JIRA_PROJECTS: "tlssn" }), ["TLSSN"]);
  assert.deepEqual(allowedProjects({ [PROJECTS_ENV]: " tlssn, DEMO ,, " }), ["TLSSN", "DEMO"]);
  assert.deepEqual(allowedProjects({ [PROJECTS_ENV]: "", FACTORY_JIRA_PROJECTS: "TLSSN" }), []);
  assert.equal(projectOf("TLSSN-42"), "TLSSN");
});

test("argument names come from the tool's own schema, with the first alias as fallback", () => {
  assert.equal(pickProperty(tools[0]!, ["issueKey", "issueIdOrKey", "id"]), "issueIdOrKey");
  assert.equal(pickProperty({ name: "x" }, ["issueKey", "id"]), "issueKey");
});

test("rich text and comment wrappers flatten to strings", () => {
  assert.equal(richTextValue({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }), "a\nb");
  assert.deepEqual(collectCommentBodies({ comments: [{ body: "Triage: bug" }, { body: { content: [{ text: "second" }] } }] }), ["Triage: bug", "second"]);
});

test("readTicket returns title, description, and comments for the key", async () => {
  const read = await readTicket(registry({ comments: ["Triage: bug\nSeverity: high"] }), "TLSSN-42");
  assert.equal(read.status, "read");
  if (read.status !== "read") return;
  assert.equal(read.title, "Retry CSV export on empty filter");
  assert.equal(read.description, "Export returns 500 on empty filter.");
  assert.deepEqual(read.comments, ["Triage: bug\nSeverity: high"]);
});

test("readTicket reports not_connected without the tracker", async () => {
  const read = await readTicket(registry({ connected: false }), "TLSSN-42");
  assert.deepEqual(read, { status: "not_connected", issueKey: "TLSSN-42" });
});

test("commentOnTicket posts once, with the schema's argument names, and only to allowed projects", async () => {
  const allowed = { [PROJECTS_ENV]: "TLSSN" };
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const outcome = await commentOnTicket(registry({ calls }), { issueKey: "TLSSN-42", body: "Plan: TLSSN-42 Retry\nProblem\n..." }, allowed);
  assert.deepEqual(outcome, { status: "commented", issueKey: "TLSSN-42" });
  const added = calls.find((call) => call.tool === "addCommentToJiraIssue");
  assert.deepEqual(added?.args, { issueIdOrKey: "TLSSN-42", commentBody: "Plan: TLSSN-42 Retry\nProblem\n..." });

  const refused = await commentOnTicket(registry({}), { issueKey: "OPS-1", body: "Plan: OPS-1 x" }, allowed);
  assert.equal(refused.status, "project_not_allowed");

  const unset = await commentOnTicket(registry({}), { issueKey: "TLSSN-42", body: "Plan: TLSSN-42 x" }, {});
  assert.equal(unset.status, "projects_unset");
  if (unset.status === "projects_unset") {
    assert.match(unset.message, /FACTORY_PLANNER_JIRA_PROJECTS/);
    assert.match(unset.message, /FACTORY_JIRA_PROJECTS/);
  }

  const repeat = await commentOnTicket(registry({ comments: ["Plan: TLSSN-42 Retry\nProblem\n..."] }), { issueKey: "TLSSN-42", body: "Plan: TLSSN-42 Retry\nProblem\n..." }, allowed);
  assert.equal(repeat.status, "already_commented");

  const offline = await commentOnTicket(registry({ connected: false }), { issueKey: "TLSSN-42", body: "Plan: TLSSN-42 Retry" }, allowed);
  assert.equal(offline.status, "not_connected");
});

const transitionTools: HostMcpToolInfo[] = [
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
];

const transitionList = {
  transitions: [
    { id: "21", name: "Plan", to: { name: "Planned" } },
    { id: "31", name: "Approve", to: { name: "Approved" } },
  ],
};

function transitionRegistry(options: { connected?: boolean; tools?: HostMcpToolInfo[]; listed?: unknown; current?: string; calls: { tool: string; args: Record<string, unknown> }[] }): HostMcpRegistry {
  return {
    names: () => (options.connected === false ? [] : ["tracker"]),
    listTools: async () => options.tools ?? transitionTools,
    callTool: async (_connection, tool, args) => {
      options.calls.push({ tool, args: args ?? {} });
      if (tool === "getTransitionsForJiraIssue" || tool === "get_transitions") return text(options.listed ?? transitionList);
      if (tool === "getJiraIssue") return text({ key: "TLSSN-42", fields: { status: { name: options.current ?? "Triaged" } } });
      return text({});
    },
  };
}

test("transitionIssue passes a bare id under transition_id for snake_case tools", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const tools: HostMcpToolInfo[] = [
    { name: "get_transitions", inputSchema: { type: "object", properties: { issue_key: { type: "string" } } } },
    { name: "transition_issue", inputSchema: { type: "object", properties: { issue_key: { type: "string" }, transition_id: { type: "string" } } } },
  ];
  const outcome = await transitionIssue(transitionRegistry({ calls, tools, listed: { items: [{ id: 41, name: "Planned" }] } }), { issueKey: "TLSSN-42", toStatus: "Planned" });
  assert.deepEqual(outcome, { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "get_transitions", args: { issue_key: "TLSSN-42" } },
    { tool: "transition_issue", args: { issue_key: "TLSSN-42", transition_id: "41" } },
  ]);
});

test("transitionIssue reports already when the ticket sits in the status", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const outcome = await transitionIssue(transitionRegistry({ calls, listed: { transitions: [] }, current: "Planned" }), { issueKey: "TLSSN-42", toStatus: "Planned" });
  assert.deepEqual(outcome, { status: "already" });
  assert.equal(calls.some((call) => call.tool === "transitionJiraIssue"), false);
});

test("transitionIssue reports no_transition with the reachable statuses", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const outcome = await transitionIssue(transitionRegistry({ calls }), { issueKey: "TLSSN-42", toStatus: "Done" });
  assert.deepEqual(outcome, { status: "no_transition", available: ["Planned", "Approved"] });
  assert.equal(calls.some((call) => call.tool === "transitionJiraIssue"), false);
});

test("transitionIssue without a list tool moves by status name", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const tools: HostMcpToolInfo[] = [
    { name: "transition_issue", inputSchema: { type: "object", properties: { issueKey: { type: "string" }, status: { type: "string" } } } },
  ];
  const outcome = await transitionIssue(transitionRegistry({ calls, tools }), { issueKey: "TLSSN-42", toStatus: "Planned" });
  assert.deepEqual(outcome, { status: "transitioned" });
  assert.deepEqual(calls, [{ tool: "transition_issue", args: { issueKey: "TLSSN-42", status: "Planned" } }]);
});

test("transitionIssue reports not_connected without the tracker", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const outcome = await transitionIssue(transitionRegistry({ calls, connected: false }), { issueKey: "TLSSN-42", toStatus: "Planned" });
  assert.deepEqual(outcome, { status: "not_connected" });
  assert.deepEqual(calls, []);
});

// Rovo's getJiraIssue as the Cursor backend relays it: an `issues.nodes`
// envelope as structuredContent beside the REST issue as text.
function rovoRegistry(input: { status: string; text?: string; envelope?: Record<string, unknown>; calls: { tool: string; args: Record<string, unknown> }[] }): HostMcpRegistry {
  const getIssue: HostMcpToolInfo = {
    name: "Factory_Atlassian-getJiraIssue",
    inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, fields: { type: "array" } } },
  };
  const node = { key: "TLSSN-42", fields: { summary: "Retry", status: { name: input.status } } };
  return {
    names: () => ["tracker"],
    listTools: async () => [getIssue],
    callTool: async (_connection, tool, args) => {
      input.calls.push({ tool, args: args ?? {} });
      return {
        content: [{ type: "text", text: input.text ?? JSON.stringify(node) }],
        structuredContent: { ...(input.envelope ?? {}), issues: { nodes: [node] } },
      };
    },
  };
}

test("issueStatus asks for the status alone and reads Rovo's issues.nodes envelope when the text is not JSON", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  assert.equal(await issueStatus(rovoRegistry({ status: "In Progress", text: "TLSSN-42 Retry is In Progress.", calls }), "TLSSN-42"), "In Progress");
  assert.deepEqual(calls, [
    { tool: "Factory_Atlassian-getJiraIssue", args: { issueIdOrKey: "TLSSN-42", fields: ["status"], cloudId: "https://<JIRA_SITE>.atlassian.net" } },
  ]);
});

test("issueStatus never reads a reply envelope's own status string as the Jira status", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  assert.equal(await issueStatus(rovoRegistry({ status: "Approved", text: "{", envelope: { status: "ok" }, calls }), "TLSSN-42"), "Approved");
});

test("transitionFrom leaves an In Progress ticket where it is when asked to move from Triaged", async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const outcome = await transitionFrom(transitionRegistry({ calls, current: "In Progress" }), { issueKey: "TLSSN-42", from: "Triaged", toStatus: "Planned" });
  assert.deepEqual(outcome, { status: "skipped_status", current: "In Progress" });
  assert.deepEqual(calls.map((call) => call.tool), ["getJiraIssue"]);
});

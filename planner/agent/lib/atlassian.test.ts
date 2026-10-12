import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { commentOnTicket, readTicket, transitionIssue } from "./jira.js";

const SITE = "https://example.atlassian.net";
let savedCloudId: string | undefined;

before(() => {
  savedCloudId = process.env.JIRA_CLOUD_ID;
  delete process.env.JIRA_CLOUD_ID;
});

after(() => {
  if (savedCloudId === undefined) delete process.env.JIRA_CLOUD_ID;
  else process.env.JIRA_CLOUD_ID = savedCloudId;
});

type Call = { tool: string; args: Record<string, unknown> };

const S = { type: "string" };
const ALLOWED = { FACTORY_PLANNER_JIRA_PROJECTS: "TLSSN" };

function tool(name: string, properties: Record<string, unknown>): HostMcpToolInfo {
  return { name, inputSchema: { type: "object", properties } as HostMcpToolInfo["inputSchema"] };
}

// The Atlassian Rovo MCP names, one of each, as the server's docs and skills give them.
const ATLASSIAN_TOOLS: HostMcpToolInfo[] = [
  tool("getAccessibleAtlassianResources", {}),
  tool("getJiraIssue", { cloudId: S, issueIdOrKey: S, fields: { type: "array", items: S } }),
  tool("addCommentToJiraIssue", { cloudId: S, issueIdOrKey: S, commentBody: S }),
  tool("addOrEditJiraIssueComment", { cloudId: S, issueIdOrKey: S, commentBody: S, commentId: S }),
  tool("getTransitionsForJiraIssue", { cloudId: S, issueIdOrKey: S }),
  tool("transitionJiraIssue", { cloudId: S, issueIdOrKey: S, transition: { type: "object" } }),
  tool("createJiraIssue", { cloudId: S, projectKey: S, issueType: S, summary: S }),
  tool("searchJiraIssuesUsingJql", { cloudId: S, jql: S, fields: { type: "array" } }),
  tool("editJiraIssue", { cloudId: S, issueIdOrKey: S, fields: { type: "object" } }),
];

const V2_PRIMARY: HostMcpToolInfo[] = [
  ...ATLASSIAN_TOOLS.filter((t) => !["getTransitionsForJiraIssue", "addCommentToJiraIssue"].includes(t.name)),
  tool("discover", { query: S }),
  tool("executeRead", { name: S, cloudId: S, inputs: { type: "object" } }),
];

function json(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function registry(tools: HostMcpToolInfo[], reply: (tool: string, args: Record<string, unknown>) => HostMcpCallResult) {
  const calls: Call[] = [];
  const mcp: HostMcpRegistry = {
    names: () => ["tracker"],
    listTools: async () => tools,
    callTool: async (_connection, name, args = {}) => {
      calls.push({ tool: name, args });
      return reply(name, args);
    },
  };
  return { mcp, calls };
}

function adf(...paragraphs: string[]) {
  return { type: "doc", version: 1, content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) };
}

// The Jira REST v3 issue shape (GET /rest/api/3/issue/{key}?fields=...,comment).
const GET_JIRA_ISSUE = {
  id: "10442",
  key: "TLSSN-42",
  fields: {
    summary: "Retry CSV export on empty filter",
    status: { name: "Triaged", id: "12221" },
    project: { key: "TLSSN" },
    description: adf("Export returns 500 on empty filter."),
    comment: {
      comments: [{ id: "10901", author: { displayName: "Factory Triage" }, body: adf("Triage: bug", "Severity: high") }],
      maxResults: 1,
      total: 1,
      startAt: 0,
    },
  },
};

test("with the Atlassian names, read, comment, transitions list, and transition pick their Atlassian tools with cloudId", async () => {
  const { mcp, calls } = registry(ATLASSIAN_TOOLS, (name) => {
    if (name === "getJiraIssue") return json(GET_JIRA_ISSUE);
    if (name === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "61", name: "Approve", to: { name: "Approved" } }, { id: "51", name: "Plan", to: { name: "Planned" } }] });
    return json({ id: "10903" });
  });

  assert.deepEqual(await readTicket(mcp, "TLSSN-42"), {
    status: "read",
    issueKey: "TLSSN-42",
    title: "Retry CSV export on empty filter",
    description: "Export returns 500 on empty filter.",
    comments: ["Triage: bug\nSeverity: high"],
  });
  assert.deepEqual(calls, [
    {
      tool: "getJiraIssue",
      args: { issueIdOrKey: "TLSSN-42", fields: ["summary", "status", "comment", "description", "project"], cloudId: SITE },
    },
  ]);

  assert.deepEqual(await commentOnTicket(mcp, { issueKey: "TLSSN-42", body: "Plan: TLSSN-42 Retry" }, ALLOWED), {
    status: "commented",
    issueKey: "TLSSN-42",
  });
  assert.deepEqual(calls.at(-1), {
    tool: "addOrEditJiraIssueComment",
    args: { issueIdOrKey: "TLSSN-42", commentBody: "Plan: TLSSN-42 Retry", cloudId: SITE },
  });

  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "planned" }), { status: "transitioned" });
  assert.deepEqual(calls.slice(-2), [
    { tool: "getTransitionsForJiraIssue", args: { issueIdOrKey: "TLSSN-42", cloudId: SITE } },
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "51" }, cloudId: SITE } },
  ]);
  assert.equal(calls.some((call) => ["searchJiraIssuesUsingJql", "editJiraIssue", "createJiraIssue", "getAccessibleAtlassianResources"].includes(call.tool)), false);
});

test("a plan already on the ticket, read from getJiraIssue's comments, is not posted again", async () => {
  const { mcp, calls } = registry(ATLASSIAN_TOOLS, () => json(GET_JIRA_ISSUE));
  const outcome = await commentOnTicket(mcp, { issueKey: "TLSSN-42", body: "Triage: bug\nSeverity: high" }, ALLOWED);
  assert.deepEqual(outcome, { status: "already_commented", issueKey: "TLSSN-42" });
  assert.deepEqual(calls.map((call) => call.tool), ["getJiraIssue"]);
});

test("without a get-issue tool, readTicket searches with JQL through searchJiraIssuesUsingJql", async () => {
  const tools = ATLASSIAN_TOOLS.filter((t) => t.name !== "getJiraIssue");
  const { mcp, calls } = registry(tools, () => json({ issues: [GET_JIRA_ISSUE] }));
  const read = await readTicket(mcp, "TLSSN-42");
  assert.equal(read.status, "read");
  if (read.status === "read") assert.deepEqual(read.comments, ["Triage: bug\nSeverity: high"]);
  assert.deepEqual(calls[0], { tool: "searchJiraIssuesUsingJql", args: { jql: "key = TLSSN-42", cloudId: SITE } });
});

test("on v2's primary list, transitions and comments are listed through executeRead with cloudId beside the name", async () => {
  const { mcp, calls } = registry(V2_PRIMARY, (name, args) => {
    if (name === "executeRead" && args["name"] === "listJiraIssueTransitions") {
      return json({ transitions: [{ id: "51", name: "Plan", to: { name: "Planned" } }] });
    }
    if (name === "executeRead" && args["name"] === "listJiraIssueComments") {
      return json({ comments: [{ id: "1", body: adf("Plan: TLSSN-42 Retry") }], total: 1 });
    }
    return json({ key: "TLSSN-42", fields: { summary: "Retry", status: { name: "Triaged" } } });
  });
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "Planned" }), { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "executeRead", args: { name: "listJiraIssueTransitions", inputs: { issueIdOrKey: "TLSSN-42" }, cloudId: SITE } },
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "51" }, cloudId: SITE } },
  ]);

  const read = await readTicket(mcp, "TLSSN-42");
  assert.equal(read.status, "read");
  if (read.status === "read") assert.deepEqual(read.comments, ["Plan: TLSSN-42 Retry"]);
  assert.deepEqual(calls.at(-1), {
    tool: "executeRead",
    args: { name: "listJiraIssueComments", inputs: { issueIdOrKey: "TLSSN-42" }, cloudId: SITE },
  });

  const again = await commentOnTicket(mcp, { issueKey: "TLSSN-42", body: "Plan: TLSSN-42 Retry" }, ALLOWED);
  assert.deepEqual(again, { status: "already_commented", issueKey: "TLSSN-42" });
});

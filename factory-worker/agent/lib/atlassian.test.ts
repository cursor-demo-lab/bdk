import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { jiraCommentBodies, withCloudId } from "./atlassian.js";
import { addComment, readComments, transitionFrom, transitionIssue } from "./jira.js";

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
  tool("searchJiraIssuesUsingJql", { cloudId: S, jql: S }),
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
    summary: "CSV export returns 500",
    status: { name: "Approved", id: "12223" },
    project: { key: "TLSSN" },
    description: adf("Since this morning."),
    comment: {
      comments: [
        { id: "10901", author: { displayName: "Factory Triage" }, body: adf("Triage: bug") },
        { id: "10902", author: { displayName: "Factory Planner" }, body: adf("Plan: TLSSN-42 Retry", "Brief:", "Retry the export.") },
      ],
      maxResults: 2,
      total: 2,
      startAt: 0,
    },
  },
};

test("with the Atlassian names, read, comment, transitions list, and transition pick their Atlassian tools with cloudId", async () => {
  const { mcp, calls } = registry(ATLASSIAN_TOOLS, (name) => {
    if (name === "getJiraIssue") return json(GET_JIRA_ISSUE);
    if (name === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "31", name: "Start work", to: { name: "In Progress" } }] });
    return json({});
  });

  assert.deepEqual(await readComments(mcp, "TLSSN-42"), {
    status: "read",
    issueKey: "TLSSN-42",
    comments: ["Triage: bug", "Plan: TLSSN-42 Retry\nBrief:\nRetry the export."],
  });
  assert.deepEqual(calls.at(-1), {
    tool: "getJiraIssue",
    args: { issueIdOrKey: "TLSSN-42", fields: ["summary", "status", "comment", "description", "project"], cloudId: SITE },
  });

  await addComment(mcp, { issueKey: "TLSSN-42", body: "Implementing: x" });
  assert.deepEqual(calls.at(-1), { tool: "addOrEditJiraIssueComment", args: { issueIdOrKey: "TLSSN-42", commentBody: "Implementing: x", cloudId: SITE } });

  assert.deepEqual(await transitionFrom(mcp, { issueKey: "TLSSN-42", from: "Approved", toStatus: "In Progress" }), { status: "transitioned" });
  assert.deepEqual(calls.slice(-3), [
    { tool: "getJiraIssue", args: { issueIdOrKey: "TLSSN-42", fields: ["status"], cloudId: SITE } },
    { tool: "getTransitionsForJiraIssue", args: { issueIdOrKey: "TLSSN-42", cloudId: SITE } },
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "31" }, cloudId: SITE } },
  ]);
  assert.equal(calls.some((call) => ["searchJiraIssuesUsingJql", "editJiraIssue", "createJiraIssue", "getAccessibleAtlassianResources"].includes(call.tool)), false);
});

test("addCommentToJiraIssue is used when it is the only comment tool", async () => {
  const { mcp, calls } = registry(ATLASSIAN_TOOLS.filter((t) => t.name !== "addOrEditJiraIssueComment"), () => json({ id: "3" }));
  assert.deepEqual(await addComment(mcp, { issueKey: "TLSSN-42", body: "x" }), { status: "commented", issueKey: "TLSSN-42" });
  assert.deepEqual(calls, [{ tool: "addCommentToJiraIssue", args: { issueIdOrKey: "TLSSN-42", commentBody: "x", cloudId: SITE } }]);
});

test("on v2's primary list, transitions and comments are listed through executeRead with cloudId beside the name", async () => {
  const { mcp, calls } = registry(V2_PRIMARY, (name, args) => {
    if (name === "executeRead" && args["name"] === "listJiraIssueTransitions") {
      return json({ transitions: [{ id: "31", name: "Start work", to: { name: "In Progress" } }] });
    }
    if (name === "executeRead" && args["name"] === "listJiraIssueComments") {
      return json({ comments: [{ id: "1", body: adf("Plan: TLSSN-42 Retry") }], total: 1 });
    }
    return json({});
  });
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "In Progress" }), { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "executeRead", args: { name: "listJiraIssueTransitions", inputs: { issueIdOrKey: "TLSSN-42" }, cloudId: SITE } },
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "31" }, cloudId: SITE } },
  ]);
  assert.deepEqual(await readComments(mcp, "TLSSN-42"), { status: "read", issueKey: "TLSSN-42", comments: ["Plan: TLSSN-42 Retry"] });
});

test("generic snake_case tools get no cloudId", async () => {
  const tools = [tool("get_transitions", { issue_key: S }), tool("transition_issue", { issue_key: S, transition_id: S })];
  const { mcp, calls } = registry(tools, (name) => (name === "get_transitions" ? json([{ id: 31, name: "In Progress" }]) : json({})));
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "In Progress" }), { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "get_transitions", args: { issue_key: "TLSSN-42" } },
    { tool: "transition_issue", args: { issue_key: "TLSSN-42", transition_id: "31" } },
  ]);
  assert.deepEqual(withCloudId(tool("x", { cloud_id: S }), {}, { JIRA_CLOUD_ID: "5f1c-uuid" }), { cloud_id: "5f1c-uuid" });
});

test("jiraCommentBodies reads fields.comment.comments and plain comment pages", () => {
  assert.deepEqual(jiraCommentBodies(GET_JIRA_ISSUE), ["Triage: bug", "Plan: TLSSN-42 Retry\nBrief:\nRetry the export."]);
  assert.deepEqual(jiraCommentBodies({ comments: [{ body: "plain" }, { body: "" }] }), ["plain"]);
  assert.deepEqual(jiraCommentBodies({ key: "TLSSN-42", fields: { status: { name: "To Do" } } }), []);
});

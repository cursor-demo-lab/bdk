import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { adfText, jiraCloudId, withCloudId } from "./atlassian.js";
import { addComment, createIssue, issueStatus, readCommentRecords, readComments, transitionIssue } from "./jira.js";

const SITE = "https://<JIRA_SITE>.atlassian.net";
const ENV = ["JIRA_CLOUD_ID", "FACTORY_DESK_JIRA_PROJECT", "FACTORY_JIRA_PROJECTS"] as const;
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

after(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

type Call = { tool: string; args: Record<string, unknown> };

function tool(name: string, properties: Record<string, unknown>): HostMcpToolInfo {
  return { name, inputSchema: { type: "object", properties } as HostMcpToolInfo["inputSchema"] };
}

const S = { type: "string" };

// The Atlassian Rovo MCP names, one of each, as the server's docs and skills give them.
const ATLASSIAN_TOOLS: HostMcpToolInfo[] = [
  tool("getAccessibleAtlassianResources", {}),
  tool("getJiraIssue", { cloudId: S, issueIdOrKey: S, fields: { type: "array", items: S }, expand: S }),
  tool("addCommentToJiraIssue", { cloudId: S, issueIdOrKey: S, commentBody: S }),
  tool("addOrEditJiraIssueComment", { cloudId: S, issueIdOrKey: S, commentBody: S, commentId: S }),
  tool("getTransitionsForJiraIssue", { cloudId: S, issueIdOrKey: S }),
  tool("transitionJiraIssue", { cloudId: S, issueIdOrKey: S, transition: { type: "object" } }),
  tool("createJiraIssue", { cloudId: S, projectKey: S, issueType: S, summary: S, description: S }),
  tool("searchJiraIssuesUsingJql", { cloudId: S, jql: S, fields: { type: "array" } }),
  tool("editJiraIssue", { cloudId: S, issueIdOrKey: S, fields: { type: "object" } }),
];

// What v2 lists by default: primary tools plus the execute meta-tools.
const V2_PRIMARY: HostMcpToolInfo[] = [
  ...ATLASSIAN_TOOLS.filter((t) => !["getTransitionsForJiraIssue", "addCommentToJiraIssue"].includes(t.name)),
  tool("discover", { query: S }),
  tool("executeRead", { name: S, cloudId: S, inputs: { type: "object" } }),
  tool("executeWrite", { name: S, cloudId: S, inputs: { type: "object" } }),
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
  expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
  id: "10442",
  self: "https://api.atlassian.com/ex/jira/5f1c/rest/api/3/issue/10442",
  key: "TLSSN-42",
  fields: {
    summary: "CSV export returns 500",
    status: { name: "Planned", id: "12222", statusCategory: { key: "new" } },
    project: { key: "TLSSN", name: "Tiles" },
    description: adf("Since this morning."),
    comment: {
      comments: [
        {
          id: "10901",
          author: { accountId: "712020:aa", displayName: "Factory Triage" },
          body: adf("Triage: bug", "Severity: high"),
          created: "2026-09-23T10:02:11.000+1000",
        },
        {
          id: "10902",
          author: { accountId: "712020:bb", displayName: "Factory Planner" },
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Plan: " }, { type: "text", text: "retry", marks: [{ type: "strong" }] }] }],
          },
          created: "2026-09-23T10:05:40.000+1000",
        },
      ],
      maxResults: 2,
      total: 2,
      startAt: 0,
    },
  },
};

test("with the Atlassian names, each verb picks its Atlassian tool and passes the site as cloudId", async () => {
  process.env.FACTORY_DESK_JIRA_PROJECT = "TLSSN";
  try {
    const { mcp, calls } = registry(ATLASSIAN_TOOLS, (name) => {
      if (name === "getJiraIssue") return json(GET_JIRA_ISSUE);
      if (name === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "61", name: "Approve", to: { name: "Approved" } }] });
      if (name === "createJiraIssue") return json({ key: "TLSSN-43", self: "https://x/rest/api/3/issue/10443" });
      return json({});
    });

    assert.deepEqual(await readComments(mcp, "TLSSN-42"), {
      status: "read",
      issueKey: "TLSSN-42",
      comments: ["Triage: bug\nSeverity: high", "Plan: retry"],
    });
    assert.deepEqual(calls.at(-1), {
      tool: "getJiraIssue",
      args: { issueIdOrKey: "TLSSN-42", fields: ["summary", "status", "comment", "description", "project"], cloudId: SITE },
    });

    assert.deepEqual(await issueStatus(mcp, "TLSSN-42"), { status: "read", name: "Planned" });
    assert.deepEqual(calls.at(-1), { tool: "getJiraIssue", args: { issueIdOrKey: "TLSSN-42", fields: ["status"], cloudId: SITE } });

    assert.deepEqual(await addComment(mcp, { issueKey: "TLSSN-42", body: "Denied" }), { status: "commented", issueKey: "TLSSN-42" });
    assert.deepEqual(calls.at(-1), { tool: "addOrEditJiraIssueComment", args: { issueIdOrKey: "TLSSN-42", commentBody: "Denied", cloudId: SITE } });

    assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "Approved" }), { status: "transitioned" });
    assert.deepEqual(calls.slice(-2), [
      { tool: "getTransitionsForJiraIssue", args: { issueIdOrKey: "TLSSN-42", cloudId: SITE } },
      { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "61" }, cloudId: SITE } },
    ]);

    const created = await createIssue(mcp, { title: "Retry", description: "d", kind: "bug" }, process.env);
    assert.deepEqual(created, {
      status: "created",
      issueKey: "TLSSN-43",
      project: "TLSSN",
      url: "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-43",
    });
    assert.deepEqual(calls.at(-1), {
      tool: "createJiraIssue",
      args: { projectKey: "TLSSN", summary: "Retry", description: "d", issueType: "Bug", cloudId: SITE },
    });
    assert.equal(calls.some((call) => ["searchJiraIssuesUsingJql", "editJiraIssue", "getAccessibleAtlassianResources"].includes(call.tool)), false);
  } finally {
    delete process.env.FACTORY_DESK_JIRA_PROJECT;
  }
});

test("addCommentToJiraIssue is used when it is the only comment tool", async () => {
  const tools = ATLASSIAN_TOOLS.filter((t) => t.name !== "addOrEditJiraIssueComment");
  const { mcp, calls } = registry(tools, () => json({}));
  await addComment(mcp, { issueKey: "TLSSN-42", body: "x" });
  assert.deepEqual(calls, [{ tool: "addCommentToJiraIssue", args: { issueIdOrKey: "TLSSN-42", commentBody: "x", cloudId: SITE } }]);
});

test("on v2's primary list, transitions and comments are listed through executeRead", async () => {
  const { mcp, calls } = registry(V2_PRIMARY, (name, args) => {
    if (name === "executeRead" && args["name"] === "listJiraIssueTransitions") {
      return json({ transitions: [{ id: "21", name: "Start", to: { name: "In Progress" } }] });
    }
    if (name === "executeRead" && args["name"] === "listJiraIssueComments") {
      return json({ comments: [{ id: "1", body: adf("Plan: retry") }], total: 1 });
    }
    return json({});
  });
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "In Progress" }), { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "executeRead", args: { name: "listJiraIssueTransitions", inputs: { issueIdOrKey: "TLSSN-42" }, cloudId: SITE } },
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "21" }, cloudId: SITE } },
  ]);
  assert.deepEqual(await readComments(mcp, "TLSSN-42"), { status: "read", issueKey: "TLSSN-42", comments: ["Plan: retry"] });
  assert.deepEqual(calls.at(-1), {
    tool: "executeRead",
    args: { name: "listJiraIssueComments", inputs: { issueIdOrKey: "TLSSN-42" }, cloudId: SITE },
  });
});

test("a failed executeRead comment list falls back to getJiraIssue", async () => {
  const { mcp, calls } = registry(V2_PRIMARY, (name) =>
    name === "executeRead" ? { content: [{ type: "text", text: "unknown operation" }], isError: true } : json(GET_JIRA_ISSUE)
  );
  const read = await readComments(mcp, "TLSSN-42");
  assert.equal(read.status, "read");
  assert.deepEqual(calls.map((call) => call.tool), ["executeRead", "getJiraIssue"]);
});

test("the getJiraIssue comment fallback reads the REST issue in the text when structuredContent is Rovo's issues.nodes envelope", async () => {
  const { mcp } = registry(V2_PRIMARY, (name) =>
    name === "executeRead"
      ? { content: [{ type: "text", text: "unknown operation" }], isError: true }
      : {
          content: [{ type: "text", text: JSON.stringify(GET_JIRA_ISSUE) }],
          structuredContent: { issues: { nodes: [{ key: "TLSSN-42", webUrl: `${SITE}/browse/TLSSN-42` }] } },
        }
  );
  assert.deepEqual(await readCommentRecords(mcp, "TLSSN-42"), {
    status: "read",
    issueKey: "TLSSN-42",
    comments: [
      { id: "10901", body: "Triage: bug\nSeverity: high" },
      { id: "10902", body: "Plan: retry" },
    ],
  });
});

test("cloudId is added exactly when the schema declares it, under the declared name, from JIRA_CLOUD_ID", () => {
  assert.deepEqual(withCloudId(tool("get_issue", { issue_key: S }), { issue_key: "A-1" }), { issue_key: "A-1" });
  assert.deepEqual(withCloudId(tool("get_issue", { cloud_id: S }), {}), { cloud_id: SITE });
  assert.deepEqual(withCloudId(tool("getJiraIssue", { cloudId: S }), { cloudId: "keep" }), { cloudId: "keep" });
  assert.deepEqual(withCloudId(tool("getJiraIssue", { cloudId: S }), {}, { JIRA_CLOUD_ID: "5f1c-uuid" }), { cloudId: "5f1c-uuid" });
  assert.equal(jiraCloudId({ JIRA_CLOUD_ID: "  " }), SITE);
});

test("a get-issue tool with a string fields property gets a comma list", async () => {
  const tools = [tool("getJiraIssue", { cloudId: S, issueIdOrKey: S, fields: S })];
  const { mcp, calls } = registry(tools, () => json(GET_JIRA_ISSUE));
  await readComments(mcp, "TLSSN-42");
  assert.equal(calls[0]?.args["fields"], "summary,status,comment,description,project");
});

test("adfText keeps inline runs together and puts blocks on their own lines", () => {
  assert.equal(adfText(adf("one", "two")), "one\ntwo");
  assert.equal(adfText({ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(adfText("plain"), "plain");
});

test("adfText renders a Jira smart link card as its URL", () => {
  const url = "https://github.com/cursor-demo-lab/marsbank/pull/19";
  assert.equal(adfText({ type: "paragraph", content: [{ type: "text", text: "Pull request: " }, { type: "inlineCard", attrs: { url } }] }), `Pull request: ${url}`);
  assert.equal(adfText({ type: "doc", content: [{ type: "blockCard", attrs: { url } }] }), url);
  assert.equal(adfText({ type: "inlineCard", attrs: { data: {} } }), "");
});

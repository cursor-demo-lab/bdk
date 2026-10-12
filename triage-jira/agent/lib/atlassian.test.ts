import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { actuate } from "./actuate.js";
import { transitionFrom } from "./transition.js";

const SITE = "https://<JIRA_SITE>.atlassian.net";
const TRACKER = { kind: "jira", connectionName: "tracker" } as const;
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
  tool("searchJiraIssuesUsingJql", { cloudId: S, jql: S, fields: { type: "array", items: S }, maxResults: { type: "number" } }),
  tool("editJiraIssue", { cloudId: S, issueIdOrKey: S, fields: { type: "object" } }),
];

const V2_PRIMARY: HostMcpToolInfo[] = [
  ...ATLASSIAN_TOOLS.filter((t) => !["getTransitionsForJiraIssue", "addCommentToJiraIssue"].includes(t.name)),
  tool("discover", { query: S }),
  tool("executeRead", { name: S, cloudId: S, inputs: { type: "object" } }),
];

const VERDICT = {
  identifier: "TLSSN-42",
  kind: "bug" as const,
  severity: "high" as const,
  title: "CSV export returns 500",
  summary: "Since this morning.",
  nextStep: "Inspect 41ac.",
};

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

function issue(key: string, summary: string, comments: string[] = []) {
  return {
    id: "1",
    key,
    fields: {
      summary,
      status: { name: "To Do" },
      comment: { comments: comments.map((body, i) => ({ id: String(i + 1), body: adf(...body.split("\n")) })), total: comments.length },
    },
  };
}

// searchJiraIssuesUsingJql answers in the Jira REST v3 search shape.
function search(args: Record<string, unknown>, issues: ReturnType<typeof issue>[]): HostMcpCallResult {
  const jql = String(args["jql"]);
  const key = /^key = (\S+)$/.exec(jql)?.[1];
  return json({ issues: key === undefined ? issues : issues.filter((i) => i.key === key), isLast: true });
}

test("with the Atlassian names, triage searches with JQL and comments through the Atlassian tools with cloudId", async () => {
  const issues = [issue("TLSSN-42", "CSV export returns 500"), issue("TLSSN-7", "CSV export returns 500")];
  const { mcp, calls } = registry(ATLASSIAN_TOOLS, (name, args) => (name === "searchJiraIssuesUsingJql" ? search(args, issues) : json({ id: "10903" })));
  const result = await actuate({ verdict: VERDICT, mcp, tracker: TRACKER, issueKey: "TLSSN-42", now: () => "2026-09-23T00:00:00.000Z" });

  assert.deepEqual(result.tracker, {
    status: "acted",
    issue: { identifier: "TLSSN-42", url: "" },
    actions: [{ op: "commented" }, { op: "duplicate_of", of: "TLSSN-7" }],
  });
  const fields = ["summary", "status", "comment", "description", "project"];
  assert.deepEqual(calls.slice(0, 2), [
    { tool: "searchJiraIssuesUsingJql", args: { jql: "key = TLSSN-42", fields, cloudId: SITE } },
    { tool: "searchJiraIssuesUsingJql", args: { jql: 'project = TLSSN AND summary ~ "CSV export returns 500"', fields, cloudId: SITE } },
  ]);
  const comments = calls.filter((call) => call.tool === "addOrEditJiraIssueComment");
  assert.deepEqual(
    comments.map((call) => [call.args["issueIdOrKey"], call.args["cloudId"], String(call.args["commentBody"]).split("\n")[0]]),
    [
      ["TLSSN-42", SITE, "Triage: bug"],
      ["TLSSN-7", SITE, "Triage: duplicate inbound TLSSN-42"],
    ]
  );
  assert.equal(calls.some((call) => ["addCommentToJiraIssue", "editJiraIssue", "createJiraIssue"].includes(call.tool)), false);
});

test("a Triage: comment already in the search result's comments is not posted again", async () => {
  const issues = [issue("TLSSN-42", "CSV export returns 500", ["Triage: bug\nSeverity: high"])];
  const { mcp, calls } = registry(ATLASSIAN_TOOLS, (name, args) => (name === "searchJiraIssuesUsingJql" ? search(args, issues) : json({})));
  const result = await actuate({ verdict: VERDICT, mcp, tracker: TRACKER, issueKey: "TLSSN-42" });
  assert.equal(result.tracker.status, "acted");
  if (result.tracker.status === "acted") assert.deepEqual(result.tracker.actions, [{ op: "already_commented" }]);
  assert.equal(calls.some((call) => call.tool === "addOrEditJiraIssueComment"), false);
});

test("a title with JQL-reserved characters is searched as plain words", async () => {
  const { mcp, calls } = registry(ATLASSIAN_TOOLS, (name, args) =>
    name === "searchJiraIssuesUsingJql" ? search(args, [issue("TLSSN-42", 'Export "CSV" (v2): fails?')]) : json({})
  );
  await actuate({ verdict: VERDICT, mcp, tracker: TRACKER, issueKey: "TLSSN-42" });
  assert.equal(calls[1]?.args["jql"], 'project = TLSSN AND summary ~ "Export CSV v2 fails"');
});

test("addCommentToJiraIssue is used when it is the only comment tool", async () => {
  const tools = ATLASSIAN_TOOLS.filter((t) => t.name !== "addOrEditJiraIssueComment");
  const { mcp, calls } = registry(tools, (name, args) => (name === "searchJiraIssuesUsingJql" ? search(args, []) : json({})));
  await actuate({ verdict: VERDICT, mcp, tracker: TRACKER, issueKey: "TLSSN-42", issueTitle: "CSV export returns 500" });
  const comment = calls.find((call) => call.tool === "addCommentToJiraIssue");
  assert.equal(comment?.args["issueIdOrKey"], "TLSSN-42");
  assert.equal(comment?.args["cloudId"], SITE);
  assert.match(String(comment?.args["commentBody"]), /^Triage: bug/);
});

test("on v2's primary list, comments are listed and transitions found through executeRead", async () => {
  const { mcp, calls } = registry(V2_PRIMARY, (name, args) => {
    if (name === "searchJiraIssuesUsingJql") return search(args, [issue("TLSSN-42", "CSV export returns 500")]);
    if (name === "executeRead" && args["name"] === "listJiraIssueComments") {
      return json({ comments: [{ id: "1", body: adf("Triage: bug") }], total: 1 });
    }
    if (name === "executeRead" && args["name"] === "listJiraIssueTransitions") {
      return json({ transitions: [{ id: "41", name: "Triage", to: { name: "Triaged" } }] });
    }
    if (name === "getJiraIssue") return json(issue("TLSSN-42", "CSV export returns 500"));
    return json({});
  });
  const result = await actuate({ verdict: VERDICT, mcp, tracker: TRACKER, issueKey: "TLSSN-42" });
  assert.equal(result.tracker.status, "acted");
  if (result.tracker.status === "acted") assert.deepEqual(result.tracker.actions, [{ op: "already_commented" }]);
  assert.ok(
    calls.some(
      (call) =>
        call.tool === "executeRead" &&
        JSON.stringify(call.args) === JSON.stringify({ name: "listJiraIssueComments", inputs: { issueIdOrKey: "TLSSN-42" }, cloudId: SITE })
    )
  );

  calls.length = 0;
  assert.deepEqual(await transitionFrom(mcp, { issueKey: "TLSSN-42", from: "To Do", toStatus: "Triaged" }), { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "getJiraIssue", args: { issueIdOrKey: "TLSSN-42", fields: ["status"], cloudId: SITE } },
    { tool: "executeRead", args: { name: "listJiraIssueTransitions", inputs: { issueIdOrKey: "TLSSN-42" }, cloudId: SITE } },
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "41" }, cloudId: SITE } },
  ]);
});

test("with the Atlassian names, the transition hop reads getJiraIssue and lists getTransitionsForJiraIssue", async () => {
  const { mcp, calls } = registry(ATLASSIAN_TOOLS, (name) => {
    if (name === "getJiraIssue") return json(issue("TLSSN-42", "x"));
    if (name === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "41", name: "Triage", to: { name: "Triaged" } }] });
    return json({});
  });
  assert.deepEqual(await transitionFrom(mcp, { issueKey: "TLSSN-42", from: "To Do", toStatus: "Triaged" }), { status: "transitioned" });
  assert.deepEqual(
    calls.map((call) => call.tool),
    ["getJiraIssue", "getTransitionsForJiraIssue", "transitionJiraIssue"]
  );
  assert.equal(calls.every((call) => call.args["cloudId"] === SITE), true);
});

test("when executeRead cannot list comments, triage reads them from getJiraIssue and still comments", async () => {
  const { mcp, calls } = registry(V2_PRIMARY, (name, args) => {
    if (name === "searchJiraIssuesUsingJql") return search(args, [issue("TLSSN-42", "CSV export returns 500")]);
    if (name === "executeRead") return { content: [{ type: "text", text: "upstream error" }], isError: true };
    if (name === "getJiraIssue") return json(issue("TLSSN-42", "CSV export returns 500", ["Someone: looks like the filter."]));
    return json({ id: "10903" });
  });
  const result = await actuate({ verdict: VERDICT, mcp, tracker: TRACKER, issueKey: "TLSSN-42" });
  assert.equal(result.tracker.status, "acted");
  if (result.tracker.status === "acted") assert.deepEqual(result.tracker.actions, [{ op: "commented" }]);
  assert.ok(calls.some((call) => call.tool === "getJiraIssue"));
  assert.equal(calls.filter((call) => call.tool === "addOrEditJiraIssueComment").length, 1);
});

test("when neither executeRead nor getJiraIssue can read comments, triage fails so a redelivery retries", async () => {
  const { mcp, calls } = registry(V2_PRIMARY, (name, args) => {
    if (name === "searchJiraIssuesUsingJql") return search(args, [issue("TLSSN-42", "CSV export returns 500")]);
    if (name === "executeRead" || name === "getJiraIssue") return { content: [{ type: "text", text: "upstream error" }], isError: true };
    return json({ id: "10903" });
  });
  const result = await actuate({ verdict: VERDICT, mcp, tracker: TRACKER, issueKey: "TLSSN-42" });
  assert.deepEqual(result.tracker, { status: "failed", message: "could not read the ticket's comments; retry the delivery" });
  assert.equal(calls.some((call) => call.tool === "addOrEditJiraIssueComment"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
// The filter host.mcp lists and calls through (dist/internal/mcp-host.js:70-77,123-125).
import { connectionAllowsTool } from "../../node_modules/@cursor/july/dist/types.js";
import tracker from "../host-connections/tracker.js";
import { CONNECTION_NAME, PROJECTS_ENV, commentOnTicket, readTicket, transitionIssue } from "./jira.js";

// Regression for ../../../docs/deployment-issues.md issue 25: the hosted
// Cursor-account bridge lists "Factory Atlassian" under
// `Factory_Atlassian-<tool>`, and host.mcp filters that listing by exact name
// against the tracker connection's `tools`. With bare names alone every
// hosted tool was filtered out, `listTools` answered `[]`, and lib/jira.ts
// answered `not_connected` on every planner Jira call.
//
// The registry below is what the real McpHost does around a connector,
// minus the network: the connector's own listing (the live v2 names, with
// the write tools the planner must never reach), July's own
// `connectionAllowsTool` over the real tracker connection on list and on
// call, and canned Jira replies.

const PREFIX = "Factory_Atlassian-";
type Properties = NonNullable<HostMcpToolInfo["inputSchema"]>;
const string: Properties = { type: "string" };
const schema = (properties: Record<string, Properties>): Properties => ({ type: "object", properties });

// Atlassian v2 as the hosted bridge lists it (the tools Tempo's `tools/call`
// spans name, plus the ones the planner must not see).
const LIVE_LISTING: HostMcpToolInfo[] = [
  { name: `${PREFIX}getJiraIssue`, inputSchema: schema({ cloudId: string, issueIdOrKey: string, fields: { type: "array" } }) },
  { name: `${PREFIX}searchJiraIssuesUsingJql`, inputSchema: schema({ cloudId: string, jql: string }) },
  { name: `${PREFIX}addOrEditJiraIssueComment`, inputSchema: schema({ cloudId: string, issueIdOrKey: string, commentBody: string }) },
  { name: `${PREFIX}transitionJiraIssue`, inputSchema: schema({ cloudId: string, issueIdOrKey: string, transition: { type: "object" } }) },
  { name: `${PREFIX}executeRead`, inputSchema: schema({ cloudId: string, name: string, inputs: { type: "object" } }) },
  { name: `${PREFIX}createJiraIssue`, inputSchema: schema({ cloudId: string, projectKey: string, summary: string }) },
  { name: `${PREFIX}editJiraIssue`, inputSchema: schema({ cloudId: string, issueIdOrKey: string, fields: { type: "object" } }) },
  { name: `${PREFIX}executeWrite`, inputSchema: schema({ cloudId: string, name: string, inputs: { type: "object" } }) },
  { name: `${PREFIX}executeDestructive`, inputSchema: schema({ cloudId: string, name: string, inputs: { type: "object" } }) },
];

const TRIAGE = "Triage: TLSSN-42 bug\nSeverity: high\nTriaged by: triage-jira";

function text(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

type Call = { tool: string; args: Record<string, unknown> };

/** host.mcp over the live listing: lists and calls through the tracker connection's own `tools` filter. */
function bridgedRegistry(options: { calls: Call[]; status?: string; comments?: string[] }): HostMcpRegistry {
  const filter = tracker as unknown as { tools?: readonly string[] };
  const allows = (name: string) => connectionAllowsTool(filter, name);
  return {
    names: () => [CONNECTION_NAME],
    listTools: async (connection) => {
      assert.equal(connection, CONNECTION_NAME);
      return LIVE_LISTING.filter((tool) => allows(tool.name));
    },
    callTool: async (connection, tool, args) => {
      assert.equal(connection, CONNECTION_NAME);
      // mcp-host.js assertConnectionAllowsTool: a name outside `tools` never reaches the connector.
      if (!allows(tool)) throw new Error(`MCP connection "${connection}" does not allow tool "${tool}"`);
      options.calls.push({ tool, args: args ?? {} });
      if (tool === `${PREFIX}getJiraIssue`) {
        return text({
          key: "TLSSN-42",
          fields: {
            summary: "Retry CSV export on empty filter",
            status: { name: options.status ?? "Triaged" },
            description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Export returns 500 on empty filter." }] }] },
            comment: { comments: (options.comments ?? [TRIAGE]).map((body) => ({ body })) },
          },
        });
      }
      if (tool === `${PREFIX}executeRead`) {
        const operation = args?.["name"];
        if (operation === "listJiraIssueComments") return text({ comments: (options.comments ?? [TRIAGE]).map((body) => ({ body })) });
        if (operation === "listJiraIssueTransitions") return text({ transitions: [{ id: "21", name: "Plan", to: { name: "Planned" } }] });
        return { isError: true, content: [{ type: "text", text: `unknown operation ${String(operation)}` }] };
      }
      if (tool === `${PREFIX}addOrEditJiraIssueComment`) return text({ id: "10001" });
      if (tool === `${PREFIX}transitionJiraIssue`) return text({});
      return { isError: true, content: [{ type: "text", text: `unexpected tool ${tool}` }] };
    },
  };
}

test("the bridged listing keeps the planner's verbs and drops the connector's write tools", async () => {
  const names = (await bridgedRegistry({ calls: [] }).listTools(CONNECTION_NAME)).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    `${PREFIX}addOrEditJiraIssueComment`,
    `${PREFIX}executeRead`,
    `${PREFIX}getJiraIssue`,
    `${PREFIX}searchJiraIssuesUsingJql`,
    `${PREFIX}transitionJiraIssue`,
  ]);
});

test("readTicket over the hosted bridge reads the ticket and its Triage: comment, not not_connected", async () => {
  const calls: Call[] = [];
  const read = await readTicket(bridgedRegistry({ calls }), "TLSSN-42");
  assert.equal(read.status, "read", JSON.stringify(read));
  if (read.status !== "read") return;
  assert.equal(read.title, "Retry CSV export on empty filter");
  assert.equal(read.description, "Export returns 500 on empty filter.");
  assert.deepEqual(read.comments, [TRIAGE]);
  assert.deepEqual(
    calls.map((call) => call.tool),
    [`${PREFIX}getJiraIssue`]
  );
});

test("commentOnTicket over the hosted bridge posts the comment through addOrEditJiraIssueComment", async () => {
  const calls: Call[] = [];
  const body = "Planning started: TLSSN-42\nSession: ses_1";
  const outcome = await commentOnTicket(bridgedRegistry({ calls }), { issueKey: "TLSSN-42", body }, { [PROJECTS_ENV]: "TLSSN" });
  assert.deepEqual(outcome, { status: "commented", issueKey: "TLSSN-42" });
  const added = calls.find((call) => call.tool === `${PREFIX}addOrEditJiraIssueComment`);
  assert.deepEqual(added?.args, { issueIdOrKey: "TLSSN-42", commentBody: body, cloudId: "https://<JIRA_SITE>.atlassian.net" });
  // The dedupe read went through v2's executeRead, which the allowlist keeps.
  assert.ok(calls.some((call) => call.tool === `${PREFIX}executeRead` && call.args["name"] === "listJiraIssueComments"));
});

test("transitionIssue over the hosted bridge lists transitions through executeRead and moves the ticket", async () => {
  const calls: Call[] = [];
  const outcome = await transitionIssue(bridgedRegistry({ calls }), { issueKey: "TLSSN-42", toStatus: "Planned" });
  assert.deepEqual(outcome, { status: "transitioned" });
  assert.deepEqual(
    calls.map((call) => call.tool),
    [`${PREFIX}executeRead`, `${PREFIX}transitionJiraIssue`]
  );
  assert.deepEqual(calls[1]?.args, { issueIdOrKey: "TLSSN-42", transition: { id: "21" }, cloudId: "https://<JIRA_SITE>.atlassian.net" });
});

test("a hosted write tool outside the allowlist is refused on call as on list", async () => {
  const registry = bridgedRegistry({ calls: [] });
  for (const forbidden of ["createJiraIssue", "editJiraIssue", "executeWrite", "executeDestructive"]) {
    await assert.rejects(registry.callTool(CONNECTION_NAME, `${PREFIX}${forbidden}`, {}), /does not allow tool/);
  }
});

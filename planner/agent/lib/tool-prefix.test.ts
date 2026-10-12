import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { transitionIssue } from "./jira.js";

// Hosted v2 lists connector tools as "<serverIdentifier>-<tool>", sanitized: the
// live prefix for "Factory Atlassian" is `Factory_Atlassian-` (host-connections/tracker.ts).
const PREFIX = "Factory_Atlassian-";
const NAMES = {
  get: PREFIX + "get" + "Jira" + "Issue",
  list: PREFIX + "get" + "Transitions" + "For" + "Jira" + "Issue",
  move: PREFIX + "transition" + "Jira" + "Issue",
};

function objectSchema(names: string[]): HostMcpToolInfo["inputSchema"] {
  return { type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: name === "transition" ? "object" : "string" }])) };
}

function text(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

test("transitionIssue finds server-prefixed connector tools", async () => {
  const calls: string[] = [];
  const tools: HostMcpToolInfo[] = [
    { name: NAMES.get, inputSchema: objectSchema(["cloudId", "issueIdOrKey"]) },
    { name: NAMES.list, inputSchema: objectSchema(["cloudId", "issueIdOrKey"]) },
    { name: NAMES.move, inputSchema: objectSchema(["cloudId", "issueIdOrKey", "transition"]) },
  ];
  const mcp: HostMcpRegistry = {
    names: () => ["tracker"],
    listTools: async () => tools,
    callTool: async (_connection, tool) => {
      calls.push(tool);
      if (tool === NAMES.list) return text({ transitions: [{ id: "41", name: "Approve", to: { name: "Approved" } }] });
      if (tool === NAMES.get) return text({ key: "TLSSN-42", fields: { status: { name: "Planned" } } });
      return text({});
    },
  };
  const outcome = await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "Approved" });
  assert.equal(outcome.status, "transitioned");
  assert.ok(calls.includes(NAMES.move));
});

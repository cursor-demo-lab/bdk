import assert from "node:assert/strict";
import { test } from "node:test";
// July's own filter, the one host.mcp lists and calls through
// (dist/internal/mcp-host.js:70-77,123-125). Not a package export.
import { connectionAllowsTool } from "../../node_modules/@cursor/july/dist/types.js";
import { sanitizeMcpToolName as julySanitize } from "../../node_modules/@cursor/july/dist/internal/sanitize-mcp-tool-name.js";
import tracker, { TRACKER_SERVERS, TRACKER_TOOLS, TRACKER_TOOL_BASES, hostedToolName, sanitizeMcpToolName } from "../host-connections/tracker.js";

type Connection = { cursorAccount?: unknown; servers?: unknown; tools?: readonly string[] };

// The names Tempo's `tools/call` spans (connection `tracker`) show the
// Cursor-account bridge serving for "Factory Atlassian" on the hosted slugs.
const LIVE_HOSTED = [
  "Factory_Atlassian-getJiraIssue",
  "Factory_Atlassian-executeRead",
  "Factory_Atlassian-addOrEditJiraIssueComment",
  "Factory_Atlassian-transitionJiraIssue",
];
const FORBIDDEN_BASES = ["createJiraIssue", "editJiraIssue", "executeWrite", "executeDestructive"];

function filter(): { tools?: readonly string[] } {
  const connection = tracker as unknown as Connection;
  return { tools: connection.tools };
}

test("the tracker connection targets the factory's own team Atlassian MCP server", () => {
  const connection = tracker as unknown as Connection;
  assert.equal(connection.cursorAccount, true);
  assert.deepEqual(connection.servers, ["Factory Atlassian"]);
});

// On a cloud turn the connection is bridged to the VM over the tool MCP
// endpoint, and `host.mcp` lists and calls through this same list, so it is
// the whole of what a hosted turn can ask Jira for.
test("the tracker connection serves exactly TRACKER_TOOLS, and no Jira create, edit, or generic write tool", () => {
  const connection = tracker as unknown as Connection;
  assert.deepEqual(connection.tools, TRACKER_TOOLS);
  assert.ok(TRACKER_TOOLS.length > 0);
  assert.equal(new Set(TRACKER_TOOLS).size, TRACKER_TOOLS.length, "no duplicate names");
  for (const forbidden of FORBIDDEN_BASES) {
    assert.equal(TRACKER_TOOL_BASES.includes(forbidden), false, forbidden);
    assert.equal(TRACKER_TOOLS.some((name) => name === forbidden || name.endsWith(`-${forbidden}`)), false, forbidden);
  }
  // The generic Atlassian read: lib/jira.ts needs it for v2's comment and
  // transition lists, and a hosted turn can read anything it serves.
  assert.ok(TRACKER_TOOL_BASES.includes("executeRead"));
});

test("the local sanitize rule is July's (sanitize-mcp-tool-name.js)", () => {
  for (const name of ["Factory Atlassian-getJiraIssue", "team.Factory Atlassian-x", "a/b c", "", "x".repeat(200), "Factory_Atlassian-get_issue"]) {
    assert.equal(sanitizeMcpToolName(name), julySanitize(name), JSON.stringify(name));
  }
  assert.equal(hostedToolName("Factory Atlassian", "getJiraIssue"), "Factory_Atlassian-getJiraIssue");
});

test("every live hosted tracker name passes July's connectionAllowsTool with the tracker filter", () => {
  for (const name of LIVE_HOSTED) {
    assert.equal(connectionAllowsTool(filter(), name), true, name);
  }
  // And every base, hosted under each configured server, not only the four seen live.
  for (const server of TRACKER_SERVERS) {
    for (const base of TRACKER_TOOL_BASES) {
      assert.equal(connectionAllowsTool(filter(), hostedToolName(server, base)), true, `${server} / ${base}`);
    }
  }
});

test("bare connector names still pass the tracker filter", () => {
  for (const base of TRACKER_TOOL_BASES) {
    assert.equal(connectionAllowsTool(filter(), base), true, base);
  }
});

test("hosted create, edit, and generic write names do not pass the tracker filter", () => {
  for (const base of FORBIDDEN_BASES) {
    assert.equal(connectionAllowsTool(filter(), base), false, base);
    assert.equal(connectionAllowsTool(filter(), `Factory_Atlassian-${base}`), false, base);
  }
  // A different server's prefix, or the unsanitized display name, is not this connection's name.
  assert.equal(connectionAllowsTool(filter(), "Other_Server-getJiraIssue"), false);
  assert.equal(connectionAllowsTool(filter(), "Factory Atlassian-getJiraIssue"), false);
});

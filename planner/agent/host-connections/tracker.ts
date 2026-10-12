import { defineConnection } from "@cursor/july/connections";

// The signed-in account's Jira connector, host-only: host code reaches it
// through `ctx.host.mcp`, and the model never sees a Jira tool. The agent's
// AGENTS.md says what it does through it.
// Hosted slugs resolve cursorAccount connectors as their deployment service
// account, which sees team MCP servers only. The team plugin's Atlassian MCP
// is exposed per user, so the factory uses its own team server.
export const TRACKER_SERVERS = ["Factory Atlassian"];

// The tools `host.mcp` serves from this connection, by base name: lib/jira.ts's
// three verbs (read an issue with its comments or status, add a comment, move
// it to a status) under the names in ../../../docs/deployment-issues.md issue 11
// step 6, Atlassian v2 and v1 and the generic snake_case set. On a cloud turn
// the connection is served at the tool MCP endpoint's host bridge while that
// turn is active (July 0.2.18 dist/internal/session-engine.js:2311-2335,
// mcp-endpoint.js:121-126,186-196), but not mounted on the turn: July skips
// host connections when it builds the turn's MCP config
// (session-engine.js:2371,2380,2388,2428), which holds only agentsdk-tools.
// A VM reaches the bridge only if it can read that config's Authorization
// header and URL (unknown; README "Checkout"). If it can, the bridge lists
// and calls through this same filter (mcp-host.js:70-77,123-125), so it
// reaches these names and no others: no createJiraIssue, editJiraIssue,
// executeWrite, or executeDestructive. The list bounds names, not scope:
// executeRead is Atlassian's generic read (lib/jira.ts needs it for v2's
// comment and transition lists), so a VM can read whatever it serves,
// Confluence included, and a comment, a comment edit
// (addOrEditJiraIssueComment), or a transition sent this way skips
// lib/jira.ts's FACTORY_JIRA_PROJECTS allowlist and its dedupe, so it can
// land on any issue the connected account can see.
export const TRACKER_TOOL_BASES = [
  "getJiraIssue",
  "searchJiraIssuesUsingJql",
  "listJiraIssueComments",
  "addOrEditJiraIssueComment",
  "addCommentToJiraIssue",
  "listJiraIssueTransitions",
  "getTransitionsForJiraIssue",
  "transitionJiraIssue",
  "executeRead",
  "get_issue",
  "search_issues",
  "list_comments",
  "add_comment",
  "get_transitions",
  "transition_issue",
];

// July's MCP tool-name rule (dist/internal/sanitize-mcp-tool-name.js:
// `[^a-zA-Z0-9_-]` -> `_`, 128 characters, empty -> `tool`), copied rather
// than imported: dist/internal is not a package export.
const MAX_MCP_TOOL_NAME_LENGTH = 128;
export function sanitizeMcpToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_MCP_TOOL_NAME_LENGTH);
  return cleaned === "" ? "tool" : cleaned;
}

/** The name July's Cursor-account bridge gives `base` on `server`: `<server>-<base>`, sanitized. */
export function hostedToolName(server: string, base: string): string {
  return sanitizeMcpToolName(`${server}-${base}`);
}

// `tools` is matched by exact name (July 0.2.18 dist/types.js:109-114
// `connectionAllowsTool`: `filter.tools.includes(toolName)`), both when
// `host.mcp` lists (mcp-host.js:70-77) and when it calls (mcp-host.js:123-125).
// The Cursor-account bridge does not list the connector's bare names: the
// Cursor backend's ListSandMcpTools returns `<serverIdentifier>-<tool>`
// (dist/internal/cursor/backend-client.js:204-226, "backend-prefixed tool
// definitions"), and July only sanitizes that and suffixes collisions
// (dist/internal/cursor/account-mcp.js `buildCatalog`,
// sanitize-mcp-tool-name.js). The prefix rule below is pinned to the live
// names (Tempo `mcp.tool.name`: `Factory_Atlassian-getJiraIssue`, never
// `getJiraIssue`), not to July code: if the backend changes how it derives
// the prefix, this list filters everything out again and fails closed. A list of bare
// names alone filtered every hosted tool out, `listTools` answered `[]`,
// and lib/jira.ts read that as `not_connected` on every planner Jira call
// (../../../docs/deployment-issues.md issue 25). So each base is allowed twice:
// bare, for a connector that lists plain names (local or offline shapes),
// and hosted, once per TRACKER_SERVERS entry. Nothing under any prefix
// creates or edits an issue or runs executeWrite / executeDestructive.
export const TRACKER_TOOLS = [
  ...TRACKER_TOOL_BASES,
  ...TRACKER_SERVERS.flatMap((server) => TRACKER_TOOL_BASES.map((base) => hostedToolName(server, base))),
];

export default defineConnection({
  cursorAccount: true,
  servers: TRACKER_SERVERS,
  tools: TRACKER_TOOLS,
});

import { defineConnection } from "@cursor/july/connections";

// The signed-in account's Jira connector, host-only: host code reaches it
// through `ctx.host.mcp`, and the model never sees a Jira tool. The agent's
// AGENTS.md says what it does through it.
// Hosted slugs resolve cursorAccount connectors as their deployment service
// account, which sees team MCP servers only. The team plugin's Atlassian MCP
// is exposed per user, so the factory uses its own team server.
export const TRACKER_SERVERS = ["Factory Atlassian"];

export default defineConnection({
  cursorAccount: true,
  servers: TRACKER_SERVERS,
});

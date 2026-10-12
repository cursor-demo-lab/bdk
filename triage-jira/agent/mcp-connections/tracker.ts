import { defineConnection } from "@cursor/july/connections";

// Hosted slugs resolve cursorAccount connectors as their deployment service
// account, which sees team MCP servers only. The team plugin's Atlassian MCP
// is exposed per user, so the factory uses its own team server.
// Keep it unadvertised: July retries advertised read-only tools on any error
// text with a bare 429/502/503/504 (a Jira key such as MARS-503), and
// host.mcp does not.
export const TRACKER_SERVERS = ["Factory Atlassian"];

export default defineConnection({
  cursorAccount: true,
  servers: TRACKER_SERVERS,
});

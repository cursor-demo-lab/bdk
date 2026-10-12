import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { classifyToolFailure, McpToolError, retryReadOnlyToolCall } from "../../node_modules/@cursor/july/dist/internal/tool-call-retry.js";
import tracker from "../mcp-connections/tracker.js";

const MISSING_ISSUE = "Issue does not exist or you do not have permission to see it: MARS-503";

test("the tracker connection targets the factory's own team Atlassian MCP server", () => {
  const connection = tracker as unknown as { cursorAccount?: unknown; servers?: unknown };
  assert.equal(connection.cursorAccount, true);
  assert.deepEqual(connection.servers, ["Factory Atlassian"]);
});

// July 0.2.12+ retries a read-effect tool call up to 3 times when its error
// text holds a bare 429/502/503/504, so a Jira key alone reads as transient.
test("July's read-tool retry treats an error that only names a Jira key like MARS-503 as transient", () => {
  const vendor = new McpToolError({ connection: "tracker", toolName: "getJiraIssue", vendorMessage: MISSING_ISSUE });
  assert.deepEqual(classifyToolFailure(vendor), { transient: true, reason: "http_503", retryAfterMs: undefined });
  assert.equal(classifyToolFailure(new Error("No transition to Triaged for MARS-429")).transient, true);
});

test("July runs a write-effect tool call once even when its error names a Jira key like MARS-503", async () => {
  let calls = 0;
  const failing = retryReadOnlyToolCall({
    toolName: "record_triage",
    effect: "write",
    execute: () => {
      calls += 1;
      throw new McpToolError({ connection: "tracker", toolName: "getJiraIssue", vendorMessage: MISSING_ISSUE });
    },
  });
  await assert.rejects(failing, { message: MISSING_ISSUE });
  assert.equal(calls, 1);
});

// An authored tool with no effect resolves to "write" (tool-policy.js
// `resolveEffect`); a function could resolve to "read", so it is refused too.
test("no Jira call runs as a retried read tool: the tracker is unadvertised, and every authored tool is a write", async () => {
  const connection = tracker as unknown as { advertiseTools?: unknown; effects?: unknown };
  assert.equal(connection.advertiseTools, undefined);
  assert.equal(connection.effects, undefined);
  const files = readdirSync(new URL("../tools/", import.meta.url)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const tool = (await import(`../tools/${file}`)).default as { effect?: unknown };
    assert.ok(tool.effect === undefined || tool.effect === "write", `${file} must declare effect "write" (or none): July retries a read's Jira errors`);
  }
});

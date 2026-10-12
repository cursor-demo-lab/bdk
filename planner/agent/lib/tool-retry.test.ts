// Deep-imports July internals (dist/internal/discovery, tool-call-retry, tool-policy); recheck these tests on every July bump.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DiscoveredTool } from "@cursor/july";
import { loadTools } from "../../node_modules/@cursor/july/dist/internal/discovery/tools.js";
import {
  classifyToolFailure,
  retryReadOnlyToolCall,
  setToolRetrySleepForTests,
} from "../../node_modules/@cursor/july/dist/internal/tool-call-retry.js";
import { directCallEffect } from "../../node_modules/@cursor/july/dist/internal/tool-policy.js";

// July 0.2.12+ reruns a tool call up to 3 times when directCallEffect says
// "read" and the error looks transient; a bare 429/502/503/504 anywhere in the
// message counts, so a Jira key like MARS-503 does. Both the model turn and a
// peer's call_tool (triage-jira's record_triage calling plan_issue) go through
// the same runExecutedTool, so the declared effect alone decides. A tool that
// moves to "read" must be safe to run twice; this table makes that a review.

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");
let tools: DiscoveredTool[] = [];

before(async () => {
  tools = await loadTools({ rootDir: join(toolsDir, "..", ".."), diagnostics: [], importModule: (path) => import(path) }, toolsDir);
  setToolRetrySleepForTests(async () => undefined);
});

after(() => {
  setToolRetrySleepForTests(undefined);
});

function discovered(name: string): DiscoveredTool {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `July discovered no ${name} tool`);
  return tool;
}

test("July classifies each planner tool's effect as declared: only idempotent reads can be retried", () => {
  const effects = Object.fromEntries(tools.filter((tool) => tool.definition.execute !== undefined).map((tool) => [tool.name, directCallEffect(tool, {})]));
  assert.deepEqual(effects, {
    get_plan: "read",
    git_history: "read",
    plan_issue: "write",
    read_ticket: "read",
    record_needs_info: "write",
    record_plan: "write",
    search_sandbox: "read",
  });
});

test("plan_issue over call_tool runs once when its send fails with an error July calls transient (MARS-503)", async () => {
  const planIssue = discovered("plan_issue");
  const failure = new Error("send failed for MARS-503");
  assert.equal(classifyToolFailure(failure).transient, true);
  let sends = 0;
  const context = {
    session: { id: "ses_triage", channelId: "http", mode: "chat", purpose: "live", auth: null, continuationKey: null },
    send: async () => {
      sends += 1;
      throw failure;
    },
  };
  const input = { issueKey: "MARS-503", title: "Retry CSV export on empty filter", verdict: { kind: "bug", severity: "high" } };
  const run = () => retryReadOnlyToolCall({
    toolName: planIssue.name,
    effect: directCallEffect(planIssue, input),
    execute: async () => planIssue.definition.execute!(input as never, context as never),
  });
  await assert.rejects(run(), (error) => error === failure);
  assert.equal(sends, 1);

  sends = 0;
  await assert.rejects(
    retryReadOnlyToolCall({ toolName: planIssue.name, effect: "read", execute: async () => planIssue.definition.execute!(input as never, context as never) }),
    /^Error: failed after 3 attempts: send failed for MARS-503$/
  );
  assert.equal(sends, 3, "the same call declared a read would open up to three planning sessions");
});

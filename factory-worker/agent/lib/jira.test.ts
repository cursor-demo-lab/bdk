import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { addComment, issueStatus, pickProperty, readComments, TRACKER_PROBE_TOOL, TRACKER_RETRY_MS, trackerRetryMs, trackerUnusable, transitionIssue } from "./jira.js";

const CLOUD = { cloudId: "https://example.atlassian.net" };

type Call = { tool: string; args: Record<string, unknown> };

function schema(...names: string[]): HostMcpToolInfo["inputSchema"] {
  return { type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) };
}

function json(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function registry(
  tools: HostMcpToolInfo[],
  reply: (tool: string, args: Record<string, unknown>) => HostMcpCallResult,
  options: { connected?: boolean } = {}
): { mcp: HostMcpRegistry; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    mcp: {
      names: () => (options.connected === false ? [] : ["tracker"]),
      listTools: async () => tools,
      callTool: async (_connection, tool, args = {}) => {
        calls.push({ tool, args });
        return reply(tool, args);
      },
    },
  };
}

const ATLASSIAN: HostMcpToolInfo[] = [
  { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
  { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
  { name: "addCommentToJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey", "commentBody") },
];

const TRANSITIONS = {
  transitions: [
    { id: "21", name: "Withdraw", to: { id: "10001", name: "Planned" } },
    { id: "31", name: "Start work", to: { id: "3", name: "In Progress" } },
  ],
};

test("transitionIssue picks the transition that leads to the status and names arguments from the schema", async () => {
  const { mcp, calls } = registry(ATLASSIAN, (tool) => (tool === "getTransitionsForJiraIssue" ? json(TRANSITIONS) : json({})));
  const outcome = await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "in progress" });
  assert.deepEqual(outcome, { status: "transitioned" });
  assert.deepEqual(calls, [
    { tool: "getTransitionsForJiraIssue", args: { ...CLOUD, issueIdOrKey: "TLSSN-42" } },
    { tool: "transitionJiraIssue", args: { ...CLOUD, issueIdOrKey: "TLSSN-42", transition: { id: "31" } } },
  ]);
});

test("transitionIssue names the status when the connector has no transitions list", async () => {
  const tools: HostMcpToolInfo[] = [{ name: "transition_issue", inputSchema: schema("issueKey", "status") }];
  const { mcp, calls } = registry(tools, () => json({}));
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "In Progress" }), { status: "transitioned" });
  assert.deepEqual(calls, [{ tool: "transition_issue", args: { issueKey: "TLSSN-42", status: "In Progress" } }]);
});

test("transitionIssue reports already when the ticket is in the status and no transition leads there", async () => {
  const { mcp, calls } = registry(ATLASSIAN, (tool) => {
    if (tool === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "41", name: "Review", to: { name: "In Review" } }] });
    if (tool === "getJiraIssue") return json({ key: "TLSSN-42", fields: { status: { name: "In Progress" } } });
    return json({});
  });
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "In Progress" }), { status: "already" });
  assert.equal(calls.some((call) => call.tool === "transitionJiraIssue"), false);
});

test("transitionIssue lists the reachable statuses when none is the target", async () => {
  const { mcp, calls } = registry(ATLASSIAN, (tool) => {
    if (tool === "getTransitionsForJiraIssue") return json({ transitions: [TRANSITIONS.transitions[0], { id: "51", name: "Close" }] });
    if (tool === "getJiraIssue") return json({ key: "TLSSN-42", fields: { status: { name: "Approved" } } });
    return json({});
  });
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "In Progress" }), {
    status: "no_transition",
    available: ["Planned", "Close"],
  });
  assert.equal(calls.some((call) => call.tool === "transitionJiraIssue"), false);
});

test("transitionIssue reports not_connected without the tracker connection", async () => {
  const { mcp, calls } = registry(ATLASSIAN, () => json({}), { connected: false });
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "In Progress" }), { status: "not_connected" });
  assert.deepEqual(calls, []);
});

test("transitionIssue surfaces a refused transition as failed", async () => {
  const { mcp } = registry(ATLASSIAN, (tool) =>
    tool === "getTransitionsForJiraIssue" ? json(TRANSITIONS) : { content: [{ type: "text", text: "Transition is not valid" }], isError: true }
  );
  assert.deepEqual(await transitionIssue(mcp, { issueKey: "TLSSN-42", toStatus: "In Progress" }), {
    status: "failed",
    message: "Transition is not valid",
  });
});

test("readComments reads comments nested in the issue, including Atlassian document format", async () => {
  const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plan: TLSSN-42 Retry" }] }, { type: "paragraph", content: [{ type: "text", text: "Brief:" }] }] };
  const { mcp, calls } = registry(ATLASSIAN, () =>
    json({ key: "TLSSN-42", fields: { summary: "Retry", comment: { comments: [{ id: "1", body: "Triage: bug" }, { id: "2", body: adf }] } } })
  );
  assert.deepEqual(await readComments(mcp, "TLSSN-42"), { status: "read", issueKey: "TLSSN-42", comments: ["Triage: bug", "Plan: TLSSN-42 Retry\nBrief:"] });
  assert.deepEqual(calls, [{ tool: "getJiraIssue", args: { ...CLOUD, issueIdOrKey: "TLSSN-42" } }]);
});

test("pickProperty skips a name already taken by another argument", () => {
  const tool: HostMcpToolInfo = { name: "transition_issue", inputSchema: schema("key", "id") };
  assert.equal(pickProperty(tool, ["issueKey", "key", "id"]), "key");
  assert.equal(pickProperty(tool, ["transitionId", "transition", "id"], ["key"]), "id");
  assert.equal(pickProperty({ name: "x" }, ["transitionId", "id"]), "transitionId");
});

// Connector discovery (TLSSN-51's top hypothesis): the release's first Jira call after ~80 idle
// minutes met a Factory Atlassian server that was loading or needed auth.

/**
 * July 0.2.13's `McpHost.callTool` (dist/internal/mcp-host.js
 * `throwIfCallNeedsAuth`): an error reply whose text mentions `needsAuth`
 * or "needs authorization" is thrown as `McpNeedsAuthError`, text dropped.
 */
function julyCallResult(connection: string, result: HostMcpCallResult): HostMcpCallResult {
  const text = result.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
  if (result.isError === true && (text.includes("needsAuth") || text.includes("needs authorization"))) {
    throw Object.assign(new Error(`MCP connection "${connection}" needs authorization. Run \`agent-sdk mcp oauth ${connection}\`.`), { name: "McpNeedsAuthError", connection });
  }
  return result;
}

/** A registry whose `listTools` answers from `listings` in turn (an Error throws), then keeps the last; calls go through July's needsAuth rule. */
function flakyRegistry(listings: (HostMcpToolInfo[] | Error)[], probe: string = "Unknown tool \"factory-connector-probe\". Available: (none).") {
  const calls: Call[] = [];
  let lists = 0;
  const mcp: HostMcpRegistry = {
    names: () => ["tracker"],
    listTools: async () => {
      const listing = listings[Math.min(lists, listings.length - 1)]!;
      lists += 1;
      if (listing instanceof Error) throw listing;
      return listing;
    },
    callTool: async (connection, tool, args = {}) => {
      calls.push({ tool, args });
      if (tool === "factory-connector-probe") return julyCallResult(connection, { content: [{ type: "text", text: probe }], isError: true });
      return julyCallResult(connection, json({ key: "TLSSN-42", fields: { comment: { comments: [{ id: "1", body: "Plan: TLSSN-42" }] } } }));
    },
  };
  return { mcp, calls, lists: () => lists };
}

async function withRetryPauses<T>(pauses: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.FACTORY_TRACKER_RETRY_MS;
  process.env.FACTORY_TRACKER_RETRY_MS = pauses;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.FACTORY_TRACKER_RETRY_MS;
    else process.env.FACTORY_TRACKER_RETRY_MS = before;
  }
}

test("a connector listing that throws, then answers, is retried inside the call and reads the ticket", async () => {
  const flaky = flakyRegistry([new Error("backend 503"), new Error("backend 503"), ATLASSIAN]);
  const read = await withRetryPauses("0,0", () => readComments(flaky.mcp, "TLSSN-42"));
  assert.equal(read.status, "read");
  assert.equal(flaky.lists(), 3);
  assert.equal(await trackerUnusable(flaky.mcp), undefined);
});

test("an empty listing is probed with an unknown tool, which makes the bridge re-list past its 60 s cache, and the refreshed listing is used", async () => {
  const flaky = flakyRegistry([[], ATLASSIAN]);
  const read = await withRetryPauses("0,0", () => readComments(flaky.mcp, "TLSSN-42"));
  assert.equal(read.status, "read");
  assert.deepEqual(flaky.calls[0], { tool: TRACKER_PROBE_TOOL, args: {} }, "the probe comes before the next listing");
});

test("a connector that stays empty or keeps throwing gives up after the retries, keeping why: empty with the server's state, or the error", async () => {
  const loading = flakyRegistry([[]], 'Unknown tool "factory-connector-probe". Available: (none). Unhealthy connectors: Factory Atlassian=loading.');
  assert.equal((await withRetryPauses("0,0", () => readComments(loading.mcp, "TLSSN-42"))).status, "not_connected");
  assert.deepEqual(await trackerUnusable(loading.mcp), { reason: "empty", attempts: 3, serverState: "Factory Atlassian=loading" });

  // The bridge's reply names needsAuth, so July throws McpNeedsAuthError instead of returning it.
  const needsAuth = flakyRegistry([[]], 'Unknown tool "factory-connector-probe". Available: (none). Unhealthy connectors: Factory Atlassian=needsAuth.');
  assert.equal((await withRetryPauses("0,0", () => readComments(needsAuth.mcp, "TLSSN-42"))).status, "not_connected");
  assert.deepEqual(await trackerUnusable(needsAuth.mcp), { reason: "empty", attempts: 3, serverState: "needsAuth" });

  const down = flakyRegistry([new Error("fetch failed")]);
  assert.equal((await withRetryPauses("0,0", () => readComments(down.mcp, "TLSSN-42"))).status, "not_connected");
  assert.deepEqual(await trackerUnusable(down.mcp), { reason: "threw", attempts: 3, message: "fetch failed" });

  const { mcp } = registry(ATLASSIAN, () => json({}), { connected: false });
  await readComments(mcp, "TLSSN-42");
  assert.deepEqual(await trackerUnusable(mcp), { reason: "not_attached", attempts: 0 });
});

test("one delivery's later Jira calls reuse a failed discovery instead of waiting out the retries again", async () => {
  const empty = flakyRegistry([[]]);
  await withRetryPauses("0,0", async () => {
    await readComments(empty.mcp, "TLSSN-42");
    await addComment(empty.mcp, { issueKey: "TLSSN-42", body: "x" });
    await issueStatus(empty.mcp, "TLSSN-42");
  });
  assert.equal(empty.lists(), 3, "one discovery of three listings, reused");
});

test("the retry pauses default to 2.5 s then 3 s and follow FACTORY_TRACKER_RETRY_MS within a 10 s budget", () => {
  assert.deepEqual(TRACKER_RETRY_MS, [2_500, 3_000]);
  assert.deepEqual(trackerRetryMs({}), [2_500, 3_000]);
  assert.deepEqual(trackerRetryMs({ FACTORY_TRACKER_RETRY_MS: "off" }), []);
  assert.deepEqual(trackerRetryMs({ FACTORY_TRACKER_RETRY_MS: "1000,2000" }), [1_000, 2_000]);
  assert.deepEqual(trackerRetryMs({ FACTORY_TRACKER_RETRY_MS: "9000,9000" }), [2_500, 3_000], "over budget keeps the default");
  assert.deepEqual(trackerRetryMs({ FACTORY_TRACKER_RETRY_MS: "soon" }), [2_500, 3_000]);
});

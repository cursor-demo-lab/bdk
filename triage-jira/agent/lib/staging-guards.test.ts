import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import hook from "../hooks/triage-outcome.js";
import { actuate } from "./actuate.js";
import { handOffToPlanner } from "./record-verdict.js";

// One test per staging guard layer, each observing a side effect only that
// layer prevents, so removing any one guard fails its own test while the
// others still pass: the triage-outcome hook (no kv read), actuate (no
// connector call at all), the planner handoff (no plan_issue call), and the
// duplicate match in actuate (no comment on another project's ticket).

const NAMES = ["FACTORY_ENV", "FACTORY_JIRA_PROJECTS", "JIRA_CLOUD_ID"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function staging(): void {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, { FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.log = log;
    console.error = error;
  }
}

function counting() {
  const calls: string[] = [];
  const mcp = {
    names: () => (calls.push("names"), ["tracker", "planner"]),
    listTools: async () => (calls.push("listTools"), [] as HostMcpToolInfo[]),
    callTool: async (connection, tool) => (calls.push(`${connection}.${tool}`), { content: [] }),
  } satisfies HostMcpRegistry;
  const kvCalls: string[] = [];
  const kv = {
    get: async (key: string) => void kvCalls.push(`get ${key}`),
    put: async (key: string) => void kvCalls.push(`put ${key}`),
    delete: async (key: string) => void kvCalls.push(`delete ${key}`),
  };
  return { mcp, calls, kv, kvCalls };
}

test("hook guard: a staging turn pinned to a production key reports nothing and never reads its outcome record", async () => {
  staging();
  const t = counting();
  const handler = (hook as unknown as { events: Record<string, (event: unknown, ctx: unknown) => Promise<void>> }).events["turn.completed"]!;
  await quietly(() =>
    handler({ data: {} }, { session: { id: "ses_1", purpose: "live", dryRun: false, continuationKey: "cont:TLSSN-47" }, channel: { continuationToken: null }, host: { kv: t.kv, mcp: t.mcp } })
  );
  assert.deepEqual(t.kvCalls, [], "the outcome record is left alone");
  assert.deepEqual(t.calls, []);
});

test("actuate guard: a refused identifier is skipped before any connector call, even the connection list", async () => {
  staging();
  for (const identifier of ["TLSSN-47", "10047"]) {
    const t = counting();
    const result = await quietly(() =>
      actuate({ verdict: { identifier, kind: "bug", severity: "high", title: "x", summary: "y", nextStep: "z" }, mcp: t.mcp, tracker: { kind: "jira", connectionName: "tracker" }, issueKey: null, purpose: "live" })
    );
    assert.deepEqual(result.tracker, { status: "skipped", reason: "staging_refuses_production" }, identifier);
    assert.deepEqual(t.calls, [], identifier);
  }
});

test("planner handoff guard: plan_issue is never called for a refused key", async () => {
  staging();
  for (const issueKey of ["TLSSN-47", "10047"]) {
    const t = counting();
    const result = await quietly(() => handOffToPlanner(t.mcp, { issueKey, title: "x" }));
    assert.deepEqual(result, { chained: false, reason: "staging_refuses_production" }, issueKey);
    assert.equal(t.calls.filter((call) => call.startsWith("planner.")).length, 0, issueKey);
  }
  const allowed = counting();
  assert.deepEqual(await handOffToPlanner(allowed.mcp, { issueKey: "TLSTG-1", title: "x" }), { chained: true });
});

const S = { type: "string" };
const SEARCH_TOOLS: HostMcpToolInfo[] = [
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { cloudId: S, issueIdOrKey: S } } },
  { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { cloudId: S, issueIdOrKey: S, commentBody: S } } },
  { name: "searchJiraIssuesUsingJql", inputSchema: { type: "object", properties: { cloudId: S, jql: S, fields: { type: "array", items: S } } } },
];

function jiraIssue(input: { key: string; summary: string }) {
  return { id: "1", key: input.key, fields: { summary: input.summary, status: { name: "To Do" }, comment: { comments: [], total: 0 } } };
}

test("duplicate guard: on staging a title match in another project is no duplicate and gets no comment", async () => {
  staging();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  // A search that ignores the project clause, as a query search tool can.
  const issues = [jiraIssue({ key: "TLSTG-1", summary: "CSV export returns 500" }), jiraIssue({ key: "TLSSN-7", summary: "CSV export returns 500" })];
  const mcp: HostMcpRegistry = {
    names: () => ["tracker"],
    listTools: async () => SEARCH_TOOLS,
    callTool: async (_connection, name, args = {}) => {
      calls.push({ tool: name, args });
      const reply = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      if (name === "searchJiraIssuesUsingJql") {
        const key = /^key = (\S+)$/.exec(String(args["jql"]))?.[1];
        return reply({ issues: key === undefined ? issues : issues.filter((issue) => issue.key === key), isLast: true });
      }
      return reply({ id: "10903" });
    },
  };
  const result = await quietly(() =>
    actuate({ verdict: { identifier: "TLSTG-1", kind: "question", severity: "low", title: "CSV export returns 500", summary: "y", nextStep: "z" }, mcp, tracker: { kind: "jira", connectionName: "tracker" }, issueKey: "TLSTG-1", purpose: "live" })
  );
  assert.deepEqual(result.tracker, { status: "acted", issue: { identifier: "TLSTG-1", url: "" }, actions: [{ op: "commented" }] });
  const commented = calls.filter((call) => call.tool === "addCommentToJiraIssue").map((call) => call.args["issueIdOrKey"]);
  assert.deepEqual(commented, ["TLSTG-1"], "no comment on TLSSN-7");
});

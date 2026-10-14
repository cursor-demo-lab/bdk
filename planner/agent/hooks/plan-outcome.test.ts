import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { format } from "node:util";
import type { HostKvApi, HostMcpCallResult } from "@cursor/july";
import hook from "./plan-outcome.js";

// The hook as the host dispatches it: one event, a stub context with the
// session, kv, and the Jira connector.

const ENV = { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_PLANNER_JIRA_PROJECTS: "TLSSN" } as const;
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

after(() => {
  for (const name of Object.keys(ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

type Handler = (event: { turnId?: string; data: Record<string, unknown> }, ctx: unknown) => Promise<void>;
const events = hook.events as unknown as Record<string, Handler>;

type Call = { tool: string; args?: Record<string, unknown> };

function jira(status: string | undefined) {
  const calls: Call[] = [];
  const tools = [
    ...(status === undefined ? [] : [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } }]),
    { name: "getJiraIssueComments", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } },
    { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, body: { type: "string" } } } },
  ];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => tools,
    callTool: async (_connection: string, tool: string, args?: Record<string, unknown>): Promise<HostMcpCallResult> => {
      calls.push({ tool, ...(args === undefined ? {} : { args }) });
      if (tool === "getJiraIssue") return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-22", fields: { status: { name: status } } }) }] };
      if (tool === "getJiraIssueComments") return { content: [{ type: "text", text: JSON.stringify({ comments: [] }) }] };
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
  return { mcp, calls };
}

function context(input: { status?: string; outcome?: unknown; continuationKey?: string | null; purpose?: string; dryRun?: boolean }) {
  const store = new Map<string, unknown>(input.outcome === undefined ? [] : [["plan-outcome/ses_plan", input.outcome]]);
  const kv: HostKvApi = {
    get: async (key) => store.get(key) as never,
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
  const { mcp, calls } = jira(input.status);
  const continuationKey = input.continuationKey === undefined ? "cont:issue:TLSSN-22#TLSSN-22:Triaged:2026-09-25T13:17:00.000+1000" : input.continuationKey;
  const ctx = {
    session: { id: "ses_plan", channelId: "webhook", mode: "chat", purpose: input.purpose ?? "live", auth: null, continuationKey, ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) },
    channel: { id: "webhook", continuationToken: continuationKey },
    host: { kv, mcp },
  };
  return { ctx, calls, store };
}

const comments = (calls: Call[]) => calls.filter((call) => call.tool === "addCommentToJiraIssue").map((call) => String(call.args?.["body"]));

test("a planning turn that fails with the ticket still Triaged leaves a Plan stopped: comment with the reason", async () => {
  const { ctx, calls } = context({ status: "Triaged" });
  await events["turn.failed"]!({ data: { status: "error", message: "resource_exhausted" } }, ctx);
  const [body, ...rest] = comments(calls);
  assert.deepEqual(rest, []);
  assert.match(String(body), /^Plan stopped: TLSSN-22\nThe planning run stopped at \d{4}-\d\d-\d\d \d\d:\d\d UTC without a plan\.\nWhy: The planning run failed: resource_exhausted\.\n/);
});

test("a turn that ends after a plan the verifier refused explains the refusal", async () => {
  const { ctx, calls } = context({ status: "Triaged", outcome: { tool: "record_plan", reason: "paths_missing", tracker: "skipped", missing: ["lib/csv.ts"] } });
  await events["turn.completed"]!({ data: {} }, ctx);
  assert.match(comments(calls)[0] ?? "", /\nWhy: The plan cited paths that are not on cursor-demo-lab\/marsbank@main \(lib\/csv\.ts\), so it was not recorded\.\n/);
});

test("a turn that ended with no outcome at all says so", async () => {
  const { ctx, calls } = context({ status: "triaged" });
  await events["turn.completed"]!({ data: {} }, ctx);
  assert.match(comments(calls)[0] ?? "", /\nWhy: The planning run ended without recording a plan or saying what information it needs\.\n/);
});

test("a Needs info verdict or a plan moved to Planned is already the outcome: no status read, no comment", async () => {
  for (const outcome of [
    { tool: "record_needs_info", reason: "commented", tracker: "commented" },
    { tool: "record_plan", reason: "recorded", tracker: "commented", transition: "transitioned" },
    { tool: "record_plan", reason: "not_triaged", tracker: "skipped", transition: "skipped_status" },
  ]) {
    const { ctx, calls } = context({ status: "Triaged", outcome });
    await events["turn.completed"]!({ data: {} }, ctx);
    assert.deepEqual(calls, [], JSON.stringify(outcome));
  }
});

test("a ticket that left Triaged, or whose status cannot be read, gets no Plan stopped: comment", async () => {
  for (const status of ["Planned", "Approved", "In Progress", undefined]) {
    const { ctx, calls } = context({ ...(status === undefined ? {} : { status }) });
    await events["turn.failed"]!({ data: { status: "error", message: "boom" } }, ctx);
    assert.deepEqual(comments(calls), [], String(status));
  }
});

test("a turn the runner cancelled, not a stop or a follow-up, still leaves a Plan stopped: comment", async () => {
  const { ctx, calls } = context({ status: "Triaged" });
  await events["turn.failed"]!({ data: { status: "cancelled", message: "turn cancelled" } }, ctx);
  assert.match(comments(calls)[0] ?? "", /\nWhy: The planning run failed: turn cancelled\.\n/);
});

test("an interrupted turn, an unpinned session, an eval, and a dry run write nothing", async () => {
  const cancelled = context({ status: "Triaged" });
  await events["turn.failed"]!({ data: { status: "cancelled", message: "turn interrupted" } }, cancelled.ctx);
  await events["turn.failed"]!({ data: { message: "turn interrupted" } }, cancelled.ctx);
  assert.deepEqual(cancelled.calls, []);
  for (const input of [{ continuationKey: null }, { continuationKey: "slack:C0123:1758510000.123456" }, { purpose: "eval" }, { dryRun: true }]) {
    const { ctx, calls } = context({ status: "Triaged", ...input });
    await events["turn.completed"]!({ data: {} }, ctx);
    assert.deepEqual(calls, [], JSON.stringify(input));
  }
});

test("a pinned turn that starts leaves one Planning started: comment with its session and start time", async () => {
  const { ctx, calls, store } = context({ status: "Triaged" });
  store.set("search-budget/ses_plan", { count: 80, queries: ["csv"] });
  store.set("plan-digest-refused/ses_plan", { at: "2026-09-28T00:00:00.000Z" });
  await events["turn.started"]!({ turnId: "turn_1", data: {} }, ctx);
  const [body, ...rest] = comments(calls);
  assert.deepEqual(rest, []);
  assert.match(String(body), /^Planning started: TLSSN-22\nSession: ses_plan\nStarted at: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n/);
  assert.equal(store.get("search-budget/ses_plan"), undefined, "each turn starts with a full search budget");
  assert.equal(store.get("plan-digest-refused/ses_plan"), undefined, "and its own one digest refusal");
  await events["turn.started"]!({ turnId: "turn_1", data: {} }, ctx);
  assert.equal(comments(calls).length, 1, "a redelivery of the same turn writes nothing");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await events["turn.started"]!({ turnId: "turn_2", data: {} }, ctx);
  assert.equal(comments(calls).length, 2, "a turn that resumes the session is a fresh start with its own time");
});

test("an unpinned session, an eval, and a dry run leave no Planning started: comment", async () => {
  for (const input of [{ continuationKey: null }, { purpose: "eval" }, { dryRun: true }]) {
    const { ctx, calls } = context({ status: "Triaged", ...input });
    await events["turn.started"]!({ data: {} }, ctx);
    assert.deepEqual(calls, [], JSON.stringify(input));
  }
});

test("a finished turn whose cost has landed logs cost.model, its cost, and its tokens", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    const { ctx } = context({ status: "Triaged", outcome: { tool: "record_plan", reason: "recorded", tracker: "commented", transition: "transitioned" } });
    await events["turn.completed"]!({ data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: { model: "auto-smart", totalUsd: 0.5, source: "usage", inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0 } } }, ctx);
  } finally {
    console.log = original;
  }
  const line = lines.map((text) => JSON.parse(text) as Record<string, unknown>).find((entry) => entry["planner"] === "turn_model");
  assert.equal(line?.["model"], "auto-smart");
  assert.equal(line?.["costUsd"], 0.5);
  assert.equal(line?.["pricedFrom"], "usage");
  assert.equal(line?.["issueKey"], "TLSSN-22");
  assert.equal(line?.["sessionId"], "ses_plan");
  assert.equal(line?.["outputTokens"], 2);
  const body = format(JSON.stringify(line));
  assert.equal(body, JSON.stringify(line));
  assert.match(body, /"model":"auto-smart"/);
  assert.match(body, /"costUsd":0.5/);
  assert.match(body, /"pricedFrom":"usage"/);
  assert.match(body, /"inputTokens":10/);
});

// July 0.2.24 never stamps `cost` on live turn.completed; a test that omits
// it matches production.
test("a finished planning turn whose cost has not landed logs its usage with model unknown and no cost", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    const { ctx } = context({ status: "Triaged", outcome: { tool: "record_plan", reason: "recorded", tracker: "commented", transition: "transitioned" } });
    await events["turn.completed"]!({ data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } } }, ctx);
  } finally {
    console.log = original;
  }
  const line = lines.map((text) => JSON.parse(text) as Record<string, unknown>).find((entry) => entry["planner"] === "turn_model");
  assert.equal(line?.["model"], "unknown");
  assert.equal(line?.["outputTokens"], 2);
  assert.equal("costUsd" in (line ?? {}), false);
  assert.equal("pricedFrom" in (line ?? {}), false);
});

test("a cost that lands on the event while the hook is reporting is the one the turn_model line logs", async () => {
  const cost = { model: "auto-smart", totalUsd: 0.25, source: "catalog", inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0 };
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const land = {
    replaced: (event: { data: Record<string, unknown> }) => void (event.data = { ...event.data, cost }),
    mutated: (event: { data: Record<string, unknown> }) => void (event.data["cost"] = cost),
  };
  for (const [how, stamp] of Object.entries(land)) {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => void lines.push(String(line));
    try {
      const { ctx } = context({ status: "Triaged", outcome: { tool: "record_plan", reason: "recorded", tracker: "commented", transition: "transitioned" } });
      const event: { data: Record<string, unknown> } = { data: { usage } };
      const get = ctx.host.kv.get;
      ctx.host.kv.get = async (key) => {
        stamp(event);
        return get(key);
      };
      await events["turn.completed"]!(event, ctx);
    } finally {
      console.log = original;
    }
    const line = lines.map((text) => JSON.parse(text) as Record<string, unknown>).find((entry) => entry["planner"] === "turn_model");
    assert.equal(line?.["model"], "auto-smart", how);
    assert.equal(line?.["costUsd"], 0.25, how);
    assert.equal(line?.["pricedFrom"], "catalog", how);
  }
});

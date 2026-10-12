import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, HostMcpCallResult } from "@cursor/july";
import recordTriage from "../tools/record_triage.js";
import hook from "./triage-outcome.js";

// The hook as the host dispatches it, after record_triage (the real tool) has
// run in the same turn, or not at all. One fake Jira serves both.

type Handler = (event: { data: Record<string, unknown> }, ctx: unknown) => Promise<void>;
const events = hook.events as unknown as Record<string, Handler>;

type Call = { tool: string; args?: Record<string, unknown> };
const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });

const bug = { identifier: "TLSSN-42", kind: "bug", severity: "high", title: "CSV export returns 500", summary: "Since this morning.", nextStep: "Inspect the export." };

function jira(input: { status?: string; offersTriaged?: boolean; commentFails?: boolean }) {
  const calls: Call[] = [];
  const comments: string[] = [];
  let status = input.status;
  const tools = [
    { name: "getJiraIssue", inputSchema: schema("issueIdOrKey") },
    { name: "getJiraIssueComments", inputSchema: schema("issueIdOrKey") },
    { name: "addCommentToJiraIssue", inputSchema: schema("issueIdOrKey", "commentBody") },
    { name: "getTransitionsForJiraIssue", inputSchema: schema("issueIdOrKey") },
    { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
  ];
  const text = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => tools,
    callTool: async (_connection: string, tool: string, args?: Record<string, unknown>): Promise<HostMcpCallResult> => {
      calls.push({ tool, ...(args === undefined ? {} : { args }) });
      if (tool === "getJiraIssue") {
        if (status === undefined) return { content: [{ type: "text", text: "unavailable" }], isError: true };
        return text({ key: "TLSSN-42", fields: { status: { name: status } } });
      }
      if (tool === "getJiraIssueComments") return text({ comments: comments.map((body, i) => ({ id: String(i + 1), body })) });
      if (tool === "addCommentToJiraIssue") {
        const body = String(args?.["commentBody"]);
        if (input.commentFails === true && body.startsWith("Triage:")) return { content: [{ type: "text", text: "no permission" }], isError: true };
        comments.push(body);
        return text({ id: String(comments.length) });
      }
      if (tool === "getTransitionsForJiraIssue") {
        return text({ transitions: input.offersTriaged === false ? [{ id: "31", name: "Done", to: { name: "Done" } }] : [{ id: "11", name: "Triage", to: { name: "Triaged" } }] });
      }
      if (tool === "transitionJiraIssue") status = "Triaged";
      return text({});
    },
  };
  return { mcp, calls, comments };
}

function session(input: { status?: string; offersTriaged?: boolean; commentFails?: boolean; continuationKey?: string | null; purpose?: string; dryRun?: boolean }) {
  const store = new Map<string, unknown>();
  const kv: HostKvApi = {
    get: async (key) => store.get(key) as never,
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
  const tracker = jira(input);
  const continuationKey = input.continuationKey === undefined ? "cont:TLSSN-42" : input.continuationKey;
  const info = { id: "ses_triage", channelId: "webhook", mode: "chat", purpose: input.purpose ?? "live", auth: null, continuationKey, ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) };
  const ctx = { session: info, channel: { id: "webhook", continuationToken: "TLSSN-42" }, host: { kv, mcp: tracker.mcp } };
  return { ...tracker, ctx, store, triage: () => recordTriage.execute!(bug as never, ctx as never) };
}

const stopped = (comments: string[]) => comments.filter((body) => body.startsWith("Triage stopped: "));

test("a triage turn that fails before it records a verdict leaves Triage stopped: with the failure", async () => {
  const run = session({ status: "To Do" });
  await events["turn.failed"]!({ data: { status: "error", message: "resource_exhausted: model capacity" } }, run.ctx);
  assert.equal(run.comments.length, 1);
  assert.match(
    run.comments[0]!,
    /^Triage stopped: TLSSN-42\nThe triage run stopped at \d{4}-\d\d-\d\d \d\d:\d\d UTC before the ticket reached Triaged\.\nWhy: The triage run failed: resource_exhausted: model capacity\.\n\nThe planner has not started\. Move the ticket to Triaged to send it to the planner\.$/
  );
});

test("a turn that ends without calling record_triage says so", async () => {
  const run = session({ status: "To Do" });
  await events["turn.completed"]!({ data: {} }, run.ctx);
  assert.match(stopped(run.comments)[0] ?? "", /\nWhy: The triage run ended without recording a verdict\.\n/);
});

test("a verdict that could not be written says why", async () => {
  const run = session({ status: "To Do", commentFails: true });
  await run.triage();
  await events["turn.completed"]!({ data: {} }, run.ctx);
  assert.deepEqual(stopped(run.comments).map((body) => body.split("\n")[2]), [
    "Why: Triage could not write its verdict to the ticket (could not comment on TLSSN-42: no permission).",
  ]);
});

test("a turn that moved the ticket to Triaged writes nothing and reads nothing more", async () => {
  const run = session({ status: "To Do" });
  await run.triage();
  const before = run.calls.length;
  await events["turn.completed"]!({ data: {} }, run.ctx);
  assert.deepEqual(stopped(run.comments), []);
  assert.equal(run.calls.length, before);
  assert.deepEqual([...run.store.keys()], []);
});

test("the record is this turn's only: a redelivered turn that records nothing gives its own reason", async () => {
  const run = session({ status: "To Do", offersTriaged: false });
  await run.triage();
  await events["turn.completed"]!({ data: {} }, run.ctx);
  await events["turn.failed"]!({ data: { status: "error", message: "boom" } }, run.ctx);
  assert.equal(run.comments[0]?.startsWith("Triage: bug"), true);
  assert.deepEqual(stopped(run.comments).map((body) => body.split("\n")[2]), [
    "Why: Triage recorded its verdict on the ticket, but Jira offers no move from To Do to Triaged (available: Done).",
    "Why: The triage run failed: boom.",
  ]);
});

test("a ticket that left To Do, or whose status cannot be read, gets no Triage stopped: comment", async () => {
  for (const status of ["Triaged", "Planned", "Approved", undefined]) {
    const run = session({ ...(status === undefined ? {} : { status }) });
    await events["turn.failed"]!({ data: { status: "error", message: "boom" } }, run.ctx);
    assert.deepEqual(run.comments, [], String(status));
  }
});

test("a cancelled turn, an unpinned session, an eval, and a dry run write nothing", async () => {
  const cancelled = session({ status: "To Do" });
  await events["turn.failed"]!({ data: { status: "cancelled", message: "turn interrupted" } }, cancelled.ctx);
  await events["turn.failed"]!({ data: { message: "turn interrupted" } }, cancelled.ctx);
  assert.deepEqual(cancelled.calls, []);
  for (const input of [{ continuationKey: "slack:C0123:1758510000.123456" }, { purpose: "eval" }, { dryRun: true }]) {
    const run = session({ status: "To Do", ...input });
    run.ctx.channel.continuationToken = input.continuationKey ?? "TLSSN-42";
    await events["turn.completed"]!({ data: {} }, run.ctx);
    assert.deepEqual(run.calls, [], JSON.stringify(input));
  }
});

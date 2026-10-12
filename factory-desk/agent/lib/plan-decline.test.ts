import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import { clearPlanDeclined, markPlanDeclined, planDeclinedKey, planDeclinedLabel } from "./plan-decline.js";

// The ❌ decline and `deny KEY` put `plan-declined` on the ticket so the board
// shows it; a new plan or an approval takes it off.

function tracker(input: { update: boolean; labels?: string[]; failEdit?: boolean }) {
  const edits: Array<Record<string, unknown>> = [];
  let labels = [...(input.labels ?? [])];
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, fields: { type: "array" } } } },
      { name: "editJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, fields: { type: "object" }, ...(input.update ? { update: { type: "object" } } : {}) } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (tool === "getJiraIssue") return json({ key: "TLSSN-46", fields: { labels } });
      if (input.failEdit === true) return { content: [{ type: "text", text: "Field 'labels' cannot be set" }], isError: true };
      edits.push(args);
      const fields = args["fields"] as { labels?: string[] } | undefined;
      if (fields?.labels !== undefined) labels = fields.labels;
      return json({});
    },
  };
  return { mcp, edits, labels: () => labels };
}

test("planDeclinedLabel adds and removes through update.labels when the edit tool takes update", async () => {
  const t = tracker({ update: true });
  assert.equal(await planDeclinedLabel(t.mcp, { issueKey: "TLSSN-46", on: true }), "set");
  assert.equal(await planDeclinedLabel(t.mcp, { issueKey: "TLSSN-46", on: false }), "cleared");
  assert.deepEqual(
    t.edits.map((edit) => edit["update"]),
    [{ labels: [{ add: "plan-declined" }] }, { labels: [{ remove: "plan-declined" }] }]
  );
});

test("planDeclinedLabel keeps the ticket's other labels when the edit tool takes only fields", async () => {
  const t = tracker({ update: false, labels: ["frontend"] });
  assert.equal(await planDeclinedLabel(t.mcp, { issueKey: "TLSSN-46", on: true }), "set");
  assert.deepEqual(t.labels(), ["frontend", "plan-declined"]);
  assert.equal(await planDeclinedLabel(t.mcp, { issueKey: "TLSSN-46", on: true }), "unchanged", "already on: no second write");
  assert.equal(await planDeclinedLabel(t.mcp, { issueKey: "TLSSN-46", on: false }), "cleared");
  assert.deepEqual(t.labels(), ["frontend"]);
  assert.equal(t.edits.length, 2);
});

test("markPlanDeclined records the label so clearPlanDeclined touches Jira only when the desk put it on; a refused edit never throws", async () => {
  const rows: Record<string, unknown> = {};
  const kv = { get: async (key: string) => rows[key] as never, put: async (key: string, value: unknown) => void (rows[key] = value), delete: async (key: string) => void delete rows[key] };
  const t = tracker({ update: true });
  assert.equal(await clearPlanDeclined({ kv, mcp: t.mcp }, "TLSSN-46"), "none");
  assert.equal(t.edits.length, 0);
  assert.equal(await markPlanDeclined({ kv, mcp: t.mcp }, "TLSSN-46"), "set");
  assert.notEqual(rows[planDeclinedKey("TLSSN-46")], undefined);
  assert.equal(await clearPlanDeclined({ kv, mcp: t.mcp }, "TLSSN-46"), "cleared");
  assert.equal(rows[planDeclinedKey("TLSSN-46")], undefined);

  const refused = tracker({ update: true, failEdit: true });
  assert.equal(await markPlanDeclined({ kv, mcp: refused.mcp }, "TLSSN-46"), "failed");
  assert.equal(rows[planDeclinedKey("TLSSN-46")], undefined);
});

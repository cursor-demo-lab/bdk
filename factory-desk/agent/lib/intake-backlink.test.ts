import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, HostMcpCallResult, HostMcpRegistry, JsonValue } from "@cursor/july";
import { backlinkKey, ensureIntakeBacklink } from "./intake-backlink.js";
import { filedFromSlack } from "./jira.js";
import { JIRA_FILED_DESCRIPTION, SLACK_FILED_DESCRIPTION } from "./jira-originated.fixtures.js";
import { backlinkComment } from "./slack-link.js";

const ROOT = { channelId: "C0INTAKE01", threadTs: "1758510002.000001", root: "jira" };
const PERMALINK = "https://<SLACK_WORKSPACE>.slack.com/archives/C0INTAKE01/p1758510002000001";

function jira(input: { description?: unknown; comments?: string[]; fail?: boolean } = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, fields: { type: "array" } } } },
      { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, commentBody: { type: "string" } } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown>): Promise<HostMcpCallResult> => {
      calls.push({ tool, args });
      if (input.fail === true) throw new Error("Jira is down");
      if (tool === "addCommentToJiraIssue") return { content: [{ type: "text", text: "{}" }] };
      const fields = { description: input.description ?? null, comment: { comments: (input.comments ?? []).map((body, i) => ({ id: String(i + 1), body })) } };
      return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-51", fields }) }] };
    },
  };
  return { mcp: mcp as unknown as HostMcpRegistry, calls };
}

function memoryKv(initial: Record<string, unknown> = {}, fail: { get?: string[]; put?: string[] } = {}) {
  const store: Record<string, unknown> = { ...initial };
  const kv: HostKvApi = {
    get: async (key: string) => {
      if (fail.get?.includes(key)) throw new Error("kv down");
      return store[key] as JsonValue | undefined;
    },
    put: async (key: string, value: JsonValue) => {
      if (fail.put?.includes(key)) throw new Error("kv down");
      store[key] = value;
    },
    delete: async (key: string) => void delete store[key],
  };
  return { store, kv };
}

const slack = {
  apiCall: async (method: string, args: Record<string, unknown>) =>
    method === "chat.getPermalink" ? { ok: true, permalink: `https://<SLACK_WORKSPACE>.slack.com/archives/${String(args["channel"])}/p${String(args["message_ts"]).replace(".", "")}` } : { ok: true },
};

test("filedFromSlack finds file_ticket's line in a plain or ADF description, and asks Jira for the description alone", async () => {
  const plain = jira({ description: SLACK_FILED_DESCRIPTION });
  assert.deepEqual(await filedFromSlack(plain.mcp, "TLSSN-51"), { status: "slack" });
  assert.deepEqual(plain.calls[0]?.args, { issueIdOrKey: "TLSSN-51", fields: ["description"] });

  const adf = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: JIRA_FILED_DESCRIPTION }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Slack thread: " },
          { type: "inlineCard", attrs: { url: "https://<SLACK_WORKSPACE>.slack.com/archives/C0EXAMPLE1/p1790366941085899" } },
        ],
      },
    ],
  };
  assert.deepEqual(await filedFromSlack(jira({ description: adf }).mcp, "TLSSN-51"), { status: "slack" });

  assert.deepEqual(await filedFromSlack(jira({ description: JIRA_FILED_DESCRIPTION }).mcp, "TLSSN-51"), { status: "not_slack" });
  assert.deepEqual(await filedFromSlack(jira({ description: `${JIRA_FILED_DESCRIPTION}\nsee https://<SLACK_WORKSPACE>.slack.com/archives/C0EXAMPLE1/p1790366941085899` }).mcp, "TLSSN-51"), { status: "not_slack" }, "an unlabelled Slack link is not the filing line");
  assert.deepEqual(await filedFromSlack(jira({ comments: [backlinkComment(PERMALINK)] }).mcp, "TLSSN-51"), { status: "not_slack" }, "the desk's own backlink comment is not a Slack filing");
  assert.equal((await filedFromSlack(jira({ fail: true }).mcp, "TLSSN-51")).status, "unread");
  assert.deepEqual(await filedFromSlack({ names: () => [] } as unknown as HostMcpRegistry, "TLSSN-51"), { status: "not_connected" });
});

test("only an intake root the desk opened gets the backlink; a Slack filing's thread or a DM does not", async () => {
  for (const binding of [{ channelId: "C0EXAMPLE1", threadTs: "1790366941.085899", originatorUserId: "U0ALICE01" }, { channelId: "D0ALICE01" }, undefined]) {
    const { kv } = memoryKv(binding === undefined ? {} : { "ticket/TLSSN-51": binding });
    const { mcp, calls } = jira();
    assert.equal(await ensureIntakeBacklink({ kv, mcp, client: slack, issueKey: "TLSSN-51", now: new Date() }), "not_intake_root");
    assert.deepEqual(calls, []);
  }
});

test("the backlink needs a permalink and a readable ticket before it writes, and survives a kv write that fails", async () => {
  const { kv } = memoryKv({ "ticket/TLSSN-51": ROOT });
  assert.equal(await ensureIntakeBacklink({ kv, mcp: jira().mcp, client: { chat: {} }, issueKey: "TLSSN-51", now: new Date() }), "no_permalink");

  const down = jira({ fail: true });
  assert.equal(await ensureIntakeBacklink({ kv, mcp: down.mcp, client: slack, issueKey: "TLSSN-51", now: new Date(), retryMs: [0, 0, 0] }), "unavailable");
  assert.deepEqual(down.calls.map((call) => call.tool), ["getJiraIssue", "getJiraIssue", "getJiraIssue", "getJiraIssue"], "an unreadable ticket is re-read, never commented blind");

  const flaky = memoryKv({ "ticket/TLSSN-51": ROOT }, { get: [backlinkKey("TLSSN-51")], put: [backlinkKey("TLSSN-51")] });
  const first = jira();
  assert.equal(await ensureIntakeBacklink({ kv: flaky.kv, mcp: first.mcp, client: slack, issueKey: "TLSSN-51", now: new Date() }), "written");
  assert.deepEqual(first.calls.at(-1), { tool: "addCommentToJiraIssue", args: { issueIdOrKey: "TLSSN-51", commentBody: backlinkComment(PERMALINK) } });
  const again = jira({ comments: [backlinkComment(PERMALINK)] });
  assert.equal(await ensureIntakeBacklink({ kv: flaky.kv, mcp: again.mcp, client: slack, issueKey: "TLSSN-51", now: new Date() }), "present");
  assert.deepEqual(again.calls.map((call) => call.tool), ["getJiraIssue"]);
});

test("a backlink recorded for an older root is written again for the root the ticket is bound to now", async () => {
  const { kv, store } = memoryKv({ "ticket/TLSSN-51": ROOT, [backlinkKey("TLSSN-51")]: { channelId: "C0INTAKE01", threadTs: "1758500000.000001", permalink: "x", at: "t" } });
  const { mcp } = jira();
  assert.equal(await ensureIntakeBacklink({ kv, mcp, client: slack, issueKey: "TLSSN-51", now: new Date("2026-09-26T04:00:00Z") }), "written");
  assert.deepEqual(store[backlinkKey("TLSSN-51")], { channelId: "C0INTAKE01", threadTs: "1758510002.000001", permalink: PERMALINK, at: "2026-09-26T04:00:00.000Z" });
});

test("a write that reported an error but landed is found on the retry's re-read and never written twice", async () => {
  const { kv } = memoryKv({ "ticket/TLSSN-51": ROOT });
  const comments: string[] = [];
  const tools: string[] = [];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } },
      { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, commentBody: { type: "string" } } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown>): Promise<HostMcpCallResult> => {
      tools.push(tool);
      if (tool === "addCommentToJiraIssue") {
        comments.push(String(args["commentBody"]));
        return { content: [{ type: "text", text: "gateway timeout" }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-51", fields: { comment: { comments: comments.map((body, i) => ({ id: String(i + 1), body })) } } }) }] };
    },
  } as unknown as HostMcpRegistry;
  assert.equal(await ensureIntakeBacklink({ kv, mcp, client: slack, issueKey: "TLSSN-51", now: new Date(), retryMs: [0, 0, 0] }), "present");
  assert.deepEqual(tools, ["getJiraIssue", "addCommentToJiraIssue", "getJiraIssue"]);
  assert.equal(comments.length, 1);
});

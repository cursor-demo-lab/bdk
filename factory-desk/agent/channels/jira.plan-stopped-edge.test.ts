import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import channel from "./jira.js";

// Verifier edge case for PR #166: the Plan stopped: comment the planner
// writes when its verdict gate skips a Triaged entry after a desk send (planner/agent/lib/
// needs-info.ts planStoppedComment with skipped: true) is relayed to the
// ticket's Slack thread once; redeliveries of that comment post nothing.

const ENV = { JIRA_WEBHOOK_SECRET: "edge-secret", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_DESK_CLAIM_SETTLE_MS: "5" } as const;
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

// Byte-for-byte what planner/agent/lib/needs-info.ts planStoppedComment writes
// for a skipped entry; ../scripts (root) pins the writer to the desk parser.
const SKIPPED = [
  "Plan stopped: TLSSN-40",
  "The planner did not start a planning run for this move to Triaged at 2026-09-27 05:10 UTC.",
  "Why: The triage verdict (factory-desk's triage from filing) is a question, and the planner does not plan questions.",
  "",
  "Nothing was planned and nothing will be built. Answer the Needs info in the ticket's Slack thread, or change the triage verdict in Jira, then send the ticket back to Triaged.",
].join("\n");

type Handler = (request: Request, ctx: unknown) => Promise<Response>;
const handler = (channel as unknown as { routes: Array<{ handler: Handler }> }).routes[0]!.handler;
const sign = (raw: string) => `sha256=${createHmac("sha256", ENV.JIRA_WEBHOOK_SECRET).update(raw).digest("hex")}`;

function host(kv: Record<string, unknown>, posts: Record<string, unknown>[], comments: Array<{ id: string; body: unknown }>) {
  let n = 0;
  return {
    kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
    slack: {
      getClient: async () => ({
        chat: {
          postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: `1758510002.${String(++n).padStart(6, "0")}` }),
          update: async () => ({ ok: true }),
          delete: async () => ({ ok: true }),
        },
        reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      }),
    },
    mcp: {
      names: () => ["tracker"],
      listTools: async () => [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } }],
      callTool: async (): Promise<HostMcpCallResult> => ({ content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-40", fields: { status: { name: "Triaged" }, comment: { comments } } }) }] }),
    },
  };
}

async function deliver(body: unknown, kv: Record<string, unknown>, posts: Record<string, unknown>[], comments: Array<{ id: string; body: unknown }>) {
  const raw = JSON.stringify(body);
  const background: Promise<unknown>[] = [];
  const response = await handler(new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } }), {
    host: host(kv, posts, comments),
    waitUntil: (p: Promise<unknown>) => void background.push(p),
    body,
  });
  await Promise.all(background);
  return response;
}

const commented = (body: unknown, id: string) => ({
  webhookEvent: "comment_created",
  issue: { key: "TLSSN-40", fields: { summary: "Freeze card", status: { name: "Triaged" }, project: { key: "TLSSN" } } },
  comment: { id, body },
});

// A plan KEY bounce: the desk recorded its send before the move, so the skip is relayed (announce.ts redundantSkip).
const BOUND = { "ticket/TLSSN-40": { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE01" }, "planner-sent/TLSSN-40": { at: new Date().toISOString() } };
const adf = (text: string) => ({ type: "doc", version: 1, content: text.split("\n").map((line) => ({ type: "paragraph", content: line === "" ? [] : [{ type: "text", text: line }] })) });

test("(e) the planner's skipped-entry Plan stopped: is relayed to the thread once; redeliveries post nothing", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const comments = [{ id: "10610", body: SKIPPED }];
  const response = await deliver(commented(SKIPPED, "10610"), kv, posts, comments);
  assert.deepEqual(await response.json(), { ok: true, kind: "plan_stopped", issueKey: "TLSSN-40" });
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0]?.["channel"], posts[0]?.["thread_ts"]], ["C0123ABCD", "1758510000.123456"]);
  const text = String(posts[0]?.["text"]);
  assert.match(text, /TLSSN-40 has no plan/);
  assert.match(text, /\nWhy: The triage verdict \(factory-desk's triage from filing\) is a question, and the planner does not plan questions\.\n/);
  assert.match(text, /focusedCommentId=10610\|Plan stopped comment>$/);

  for (let i = 0; i < 3; i++) await deliver(commented(SKIPPED, "10610"), kv, posts, comments);
  await deliver(commented(adf(SKIPPED), "10610"), kv, posts, comments);
  assert.equal(posts.length, 1, "the same comment is relayed once");
});

test("(e) a second skipped entry's Plan stopped: (new comment id) is relayed once more, not twice", async () => {
  const kv: Record<string, unknown> = { ...BOUND };
  const posts: Record<string, unknown>[] = [];
  const second = SKIPPED.replace("05:10", "05:22");
  const comments = [{ id: "10610", body: SKIPPED }, { id: "10620", body: second }];
  await deliver(commented(SKIPPED, "10610"), kv, posts, comments);
  await deliver(commented(second, "10620"), kv, posts, comments);
  await deliver(commented(second, "10620"), kv, posts, comments);
  assert.equal(posts.length, 2);
  assert.match(String(posts[1]?.["text"]), /focusedCommentId=10620\|Plan stopped comment>$/);
});

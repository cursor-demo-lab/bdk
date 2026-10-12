import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelHandlerArgs, HostMcpCallResult } from "@cursor/july";
import { deriveGitHubWebhookEvents, dispatchGitHubWebhook, getGitHubChannelOptions } from "@cursor/july/channels/github";

const SANDBOX = "cursor-demo-lab/marsbank";
const HEAD = "9f0ba2e".padEnd(40, "0");
const THREAD = { channelId: "C0EXAMPLE1", threadTs: "1790301410.693199", originatorUserId: "U0ALICE01" };

// github.ts reads FACTORY_REPOS while this module loads.
process.env.FACTORY_REPOS = SANDBOX;
process.env.FACTORY_JIRA_PROJECTS = "TLSSN";
// Review gate claims settle before they post (review-announce.ts); not the latency under test.
process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";

const channelReady = import("./github.js");

async function options() {
  const { default: channel } = await channelReady;
  const found = getGitHubChannelOptions(channel);
  if (found === undefined) throw new Error("github channel options were not recorded");
  return found;
}

const repository = { full_name: SANDBOX, name: "marsbank", html_url: `https://github.com/${SANDBOX}`, owner: { login: "cursor-demo-lab" } };

/** GitHub's REST API for marsbank PR 19 at HEAD. Every other path is a 404; any write fails the test. */
function stubGitHub(input: { checkRuns: unknown[]; reviews: unknown[] }) {
  const requests: string[] = [];
  const api = {
    apiBaseUrl: "https://github.test",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url instanceof Request ? url.url : url)).pathname;
      const method = (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();
      requests.push(`${method} ${path}`);
      if (method !== "GET") throw new Error(`the desk wrote to GitHub: ${method} ${path}`);
      if (path === `/repos/${SANDBOX}/pulls/19`) {
        return Response.json({ number: 19, state: "open", merged: false, title: "TLSSN-28: CSV export", user: { login: "cursor[bot]", type: "Bot" }, head: { ref: "TLSSN-28-csv-export", sha: HEAD } });
      }
      if (path === `/repos/${SANDBOX}/commits/${HEAD}/check-runs`) return Response.json({ total_count: input.checkRuns.length, check_runs: input.checkRuns });
      if (path === `/repos/${SANDBOX}/pulls/19/reviews`) return Response.json(input.reviews);
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  };
  return { api, requests };
}

function harness(kv: Record<string, unknown>) {
  const posts: Record<string, unknown>[] = [];
  const background: Promise<unknown>[] = [];
  const args = {
    params: {},
    requestIp: null,
    auth: null,
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      mcp: { names: () => [], listTools: async () => [], callTool: async (): Promise<HostMcpCallResult> => ({ content: [] }) },
      slack: {
        getClient: async () => ({
          chat: {
            postMessage: async (post: Record<string, unknown>) => {
              posts.push(post);
              return { ok: true, ts: "1790301500.000100" };
            },
          },
        }),
      },
    },
    artifacts: {},
    send: async () => {
      throw new Error("send ran");
    },
    getSession: async () => null,
    receive: async () => {
      throw new Error("receive ran");
    },
    callTool: async () => {
      throw new Error("callTool ran");
    },
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
    sessionUrls: () => ({ playgroundUrl: "http://127.0.0.1/", traceUrl: "http://127.0.0.1/" }),
  } as unknown as ChannelHandlerArgs;
  return { args, posts, settle: () => Promise.all(background.splice(0)) };
}

function checkSuitePayload(app: string, conclusion: string) {
  return {
    action: "completed",
    repository,
    check_suite: { id: 98015731297, head_sha: HEAD, status: "completed", conclusion, app: { slug: app, name: app }, pull_requests: [{ number: 19, url: `https://api.github.com/repos/${SANDBOX}/pulls/19` }] },
    sender: { login: "cursor[bot]", type: "Bot" },
  };
}

const BUGBOT_RUN = {
  id: 108260890710,
  name: "Cursor Bugbot",
  app: { slug: "cursor" },
  status: "completed",
  conclusion: "neutral",
  html_url: `https://github.com/${SANDBOX}/runs/108260890710`,
  output: { title: "Bugbot Review", summary: "**Final Result:** Bugbot completed review and found 2 potential issues." },
};
const SECURITY_REVIEW = {
  id: 5322604914,
  user: { login: "cursor[bot]", type: "Bot" },
  state: "COMMENTED",
  commit_id: HEAD,
  html_url: `https://github.com/${SANDBOX}/pull/19#pullrequestreview-5322604914`,
  body: "## Security review\n\n**Verdict:** CLEAN\nSecurity only, on head `9f0ba2e`; Bugbot covers correctness. A new push gets a new review.",
};

test("declares a read-only cursorAccount on FACTORY_REPOS, the four events hosted can forward, no replies, no reactions", async () => {
  const declared = await options();
  assert.deepEqual(deriveGitHubWebhookEvents(declared), ["pull_request", "check_suite", "workflow_run", "pull_request_review"]);
  assert.equal(declared.deliverReplies, false);
  assert.equal(declared.progress?.reactions, false);
  const account = declared.cursorAccount;
  if (typeof account !== "object") throw new Error("cursorAccount repos are not declared");
  assert.deepEqual([...account.repos], [SANDBOX]);
  assert.equal(account.permissions, "read");
});

test("Bugbot's check suite completing posts one review update, with the security review that already landed, into the ticket's thread", async () => {
  const kv: Record<string, unknown> = { "ticket/TLSSN-28": THREAD };
  const h = harness(kv);
  const github = stubGitHub({ checkRuns: [BUGBOT_RUN], reviews: [SECURITY_REVIEW] });
  const declared = { ...(await options()), cursorAccount: undefined, credentials: { token: "test-token" }, api: github.api };
  const response = await dispatchGitHubWebhook({ options: declared, eventName: "check_suite", payload: checkSuitePayload("cursor", "neutral"), args: h.args });
  assert.equal(response.status, 202);
  assert.equal(((await response.json()) as { mode?: string }).mode, "task");
  await h.settle();
  assert.deepEqual(
    h.posts.map((post) => [post["channel"], post["thread_ts"], post["text"]]),
    [
      [
        THREAD.channelId,
        THREAD.threadTs,
        [
          "TLSSN-28 review update on `9f0ba2e`:",
          `• 🐛⚠️ Bugbot — 2 findings · <https://github.com/${SANDBOX}/runs/108260890710|Bugbot run>`,
          `• 🔒✅ Security review — clean · <https://github.com/${SANDBOX}/pull/19#pullrequestreview-5322604914|review>`,
        ].join("\n"),
      ],
    ]
  );
  assert.ok(github.requests.every((request) => request.startsWith("GET ")), github.requests.join("\n"));

  const again = harness(kv);
  await dispatchGitHubWebhook({ options: declared, eventName: "check_suite", payload: checkSuitePayload("cursor", "neutral"), args: again.args });
  await again.settle();
  assert.deepEqual(again.posts, [], "the redelivery posts nothing");
});

test("a PR comment, a closed PR, or a repository outside FACTORY_REPOS never runs a task", async () => {
  const declared = await options();
  const h = harness({ "ticket/TLSSN-28": THREAD });
  const comment = await dispatchGitHubWebhook({
    options: declared,
    eventName: "issue_comment",
    payload: {
      action: "created",
      repository,
      issue: { number: 19, html_url: `https://github.com/${SANDBOX}/pull/19`, pull_request: { url: `https://api.github.com/repos/${SANDBOX}/pulls/19` } },
      comment: {
        id: 1,
        body: "@factory-desk post an update",
        html_url: `https://github.com/${SANDBOX}/pull/19#issuecomment-1`,
        url: `https://api.github.com/repos/${SANDBOX}/issues/comments/1`,
        user: { login: "example-user", type: "User" },
      },
      sender: { login: "example-user", type: "User" },
    },
    args: h.args,
  });
  assert.equal(((await comment.json()) as { skipped?: boolean }).skipped, true);

  const closed = await dispatchGitHubWebhook({
    options: declared,
    eventName: "pull_request",
    payload: {
      action: "closed",
      repository,
      pull_request: { number: 19, html_url: `https://github.com/${SANDBOX}/pull/19`, title: "TLSSN-28: x", merged: true, user: { login: "cursor[bot]" }, head: { ref: "TLSSN-28-x", sha: HEAD }, base: { ref: "main" } },
      sender: { login: "example-user", type: "User" },
    },
    args: h.args,
  });
  assert.equal(((await closed.json()) as { reason?: string }).reason, "not_dispatched");

  const elsewhere = { ...checkSuitePayload("cursor", "success"), repository: { ...repository, full_name: "someone/else", name: "else", owner: { login: "someone" } } };
  const outside = await dispatchGitHubWebhook({ options: declared, eventName: "check_suite", payload: elsewhere, args: h.args });
  assert.equal(((await outside.json()) as { reason?: string }).reason, "not_dispatched");
  await h.settle();
  assert.deepEqual(h.posts, []);
});

test("TLSSN-38: one Actions run's check_suite and workflow_run, dispatched together with no shared claim between them, post the CI line once, from the check_suite", async () => {
  const ci = { id: 7, name: "test", app: { slug: "github-actions" }, status: "completed", conclusion: "success", check_suite: { id: 98015731297 }, completed_at: new Date().toISOString(), html_url: `https://github.com/${SANDBOX}/runs/7` };
  const github = stubGitHub({ checkRuns: [ci], reviews: [] });
  const declared = { ...(await options()), cursorAccount: undefined, credentials: { token: "test-token" }, api: github.api };
  const workflowRun = {
    action: "completed",
    repository,
    workflow_run: { id: 555, name: "CI", head_sha: HEAD, status: "completed", conclusion: "success", html_url: `https://github.com/${SANDBOX}/actions/runs/555`, check_suite_id: 98015731297, pull_requests: [{ number: 19, url: `https://api.github.com/repos/${SANDBOX}/pulls/19` }] },
    sender: { login: "github-actions[bot]", type: "Bot" },
  };
  const suite = harness({ "ticket/TLSSN-28": THREAD });
  const workflow = harness({ "ticket/TLSSN-28": THREAD });
  const logs: string[] = [];
  const log = console.log;
  console.log = (line: string) => void logs.push(line);
  try {
    await Promise.all([
      dispatchGitHubWebhook({ options: declared, eventName: "check_suite", payload: checkSuitePayload("github-actions", "success"), args: suite.args }),
      dispatchGitHubWebhook({ options: declared, eventName: "workflow_run", payload: workflowRun, args: workflow.args }),
    ]);
    await Promise.all([suite.settle(), workflow.settle()]);
  } finally {
    console.log = log;
  }
  assert.deepEqual(suite.posts.map((post) => post["text"]), [`TLSSN-28 review update on \`9f0ba2e\`:\n• 🏗️✅ CI — passing · <https://github.com/${SANDBOX}/pull/19/checks|checks>`]);
  assert.deepEqual(workflow.posts, []);
  const deferred = logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line["wake"] === "workflow_run");
  assert.equal(deferred?.["reason"], "deferred");
});

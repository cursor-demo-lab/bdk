import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadAgentProject } from "@cursor/july";
import type { ChannelHandlerArgs } from "@cursor/july";
import { deriveGitHubWebhookEvents, dispatchGitHubWebhook, getGitHubChannelOptions } from "@cursor/july/channels/github";
import { recordImplementation } from "../lib/claim.js";
import { fakeTracker, memoryKv, type FakeTracker, type MemoryKv } from "../lib/testing/fakes.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SANDBOX = "cursor-demo-lab/marsbank";

// github.ts reads sandboxReposAtBoot() while this module loads.
process.env.FACTORY_SANDBOX_REPO = SANDBOX;
process.env.FACTORY_JIRA_PROJECTS = "TLSSN";
// A 1 ms claim settle keeps the re-read on the path without the 2 s wait.
process.env.FACTORY_CLAIM_SETTLE_MS = "1";
delete process.env.FACTORY_REPOS;

const channelReady = import("./github.js");

async function options() {
  const { default: channel } = await channelReady;
  const found = getGitHubChannelOptions(channel);
  if (found === undefined) throw new Error("github channel options were not recorded");
  return found;
}

function pullRequestPayload(input: { action: string; merged?: boolean; sender: { login: string; type: string }; mergedBy?: { login: string; type: string } }) {
  return {
    action: input.action,
    repository: { full_name: SANDBOX, name: "marsbank", html_url: `https://github.com/${SANDBOX}`, owner: { login: "cursor-demo-lab" } },
    pull_request: {
      number: 13,
      html_url: `https://github.com/${SANDBOX}/pull/13`,
      title: "TLSSN-9: CSV export returns headers on an empty filter",
      draft: true,
      merged: input.merged ?? false,
      auto_merge: null,
      ...(input.mergedBy === undefined ? {} : { merged_by: input.mergedBy }),
      user: { login: "cursor[bot]", type: "Bot" },
      head: { ref: "TLSSN-9-csv-export-zero-rows", sha: "9f0ba2e".padEnd(40, "0") },
      base: { ref: "main", sha: "b".repeat(40) },
    },
    sender: input.sender,
  };
}

function harness(tracker: FakeTracker, kv: MemoryKv) {
  const sends: string[] = [];
  const background: Promise<unknown>[] = [];
  const args = {
    params: {},
    requestIp: null,
    auth: null,
    host: { kv, mcp: tracker.mcp },
    artifacts: {},
    send: async (message: string) => {
      sends.push(message);
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
  return { args, sends, settle: () => Promise.all(background.splice(0)) };
}

async function launchedKv(): Promise<MemoryKv> {
  const kv = memoryKv();
  const url = "https://cursor.com/agents/bc-example-1";
  await recordImplementation(kv, "TLSSN-9", { state: "launched", at: "2026-09-24T18:59:24.000Z", agentId: "bc-example-1", url, commented: true, moved: true });
  return kv;
}

test("declares pr-write cursorAccount on the sandbox (for the description's link lines), pull_request events only, no replies, no reactions", async () => {
  const declared = await options();
  assert.deepEqual(deriveGitHubWebhookEvents(declared), ["pull_request"]);
  assert.equal(declared.deliverReplies, false);
  assert.equal(declared.progress?.reactions, false);
  const account = declared.cursorAccount;
  if (typeof account !== "object") throw new Error("cursorAccount repos are not declared");
  assert.deepEqual([...account.repos], [SANDBOX]);
  assert.equal(account.permissions, "pr-write");
});

const JIRA = "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-9";
const SLACK = "https://example-workspace.slack.com/archives/C0EXAMPLE1/p1790370261284789";
const PLAN = ["Plan: TLSSN-9 CSV export", "Brief:", "Implement Jira TLSSN-9 on cursor-demo-lab/marsbank from main: CSV export", `Ticket: ${JIRA}`, `Slack thread: ${SLACK}`, "", "Problem: x"].join("\n");

/** GitHub's pulls API for PR 13, a draft holding the description the agent wrote, and GraphQL's markPullRequestReadyForReview. Every other path is a 404. */
function stubPullRequest(initial: string) {
  const state = { body: initial, draft: true, readyFor: [] as unknown[], requests: [] as string[] };
  const api = {
    apiBaseUrl: "https://github.test",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url instanceof Request ? url.url : url)).pathname;
      const method = (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();
      state.requests.push(`${method} ${path}`);
      if (method === "POST" && path === "/graphql") {
        const request = JSON.parse(String(init?.body)) as { query: string; variables: { id: string } };
        if (!request.query.includes("markPullRequestReadyForReview")) return Response.json({ errors: [{ message: "unexpected query" }] });
        state.readyFor.push(request.variables.id);
        state.draft = false;
        return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
      if (path !== `/repos/${SANDBOX}/pulls/13`) return Response.json({ message: "Not Found" }, { status: 404 });
      if (method === "PATCH") state.body = String((JSON.parse(String(init?.body)) as { body: string }).body);
      return Response.json({ number: 13, node_id: "PR_kwDO13", draft: state.draft, body: state.body });
    },
  };
  return { api, state };
}

test("the implement PR opens as a draft and is marked ready for review (Bugbot skips drafts), and its description leads with Jira: then Slack:; the worker's own edit writes nothing", async () => {
  const tracker = fakeTracker({ status: "In Progress", comments: [PLAN] });
  const kv = await launchedKv();
  const github = stubPullRequest(`Jira: ${JIRA}\n\n## What changed\n- CSV export returns headers`);
  const declared = { ...(await options()), cursorAccount: undefined, credentials: { token: "test-token" }, api: github.api };
  for (const action of ["opened", "edited"]) {
    const h = harness(tracker, kv);
    const response = await dispatchGitHubWebhook({
      options: declared,
      eventName: "pull_request",
      payload: pullRequestPayload({ action, sender: { login: "cursor[bot]", type: "Bot" } }),
      args: h.args,
    });
    assert.equal(response.status, 202, action);
    await h.settle();
    assert.deepEqual(h.sends, []);
  }
  assert.equal(github.state.body, `Jira: ${JIRA}\nSlack: ${SLACK}\n\n## What changed\n- CSV export returns headers`);
  const pulls = `/repos/${SANDBOX}/pulls/13`;
  assert.equal(github.state.draft, false);
  assert.deepEqual(github.state.readyFor, ["PR_kwDO13"]);
  // The edit's body still says draft, so the worker reads the PR again; it is ready, so nothing is written.
  assert.deepEqual(github.state.requests, [`GET ${pulls}`, "POST /graphql", `GET ${pulls}`, `PATCH ${pulls}`, `GET ${pulls}`, `GET ${pulls}`]);
  assert.equal(tracker.status(), "In Review");
});

// July's github-proxy wiring (`serve --cursor-scm-proxy`), which the package
// does not export. Same module instance the channel binds against.
const cursorAccountModule = new URL("../../node_modules/@cursor/july/dist/channels/github/cursor-account.js", import.meta.url).href;
type ProxyRuntime = { credentials: { bind(getToken: () => Promise<string>): void; bindProxyTransport(transport: { apiBaseUrl: string; headers: Record<string, string> }): void } };

/**
 * The channel as a hosted v2 slot boots it: FACTORY_SANDBOX_REPO is a
 * deployment secret bound after the freeze, so `cursorAccount` is `true` and
 * the host binds github-proxy with no static repo scope. The proxy then
 * takes the repo from each request's `/repos/<owner>/<repo>` URL.
 */
async function hostedBootChannel() {
  const saved = process.env.FACTORY_SANDBOX_REPO;
  delete process.env.FACTORY_SANDBOX_REPO;
  const freshModule = "./github.js?hosted-boot";
  const { default: channel } = (await import(freshModule)) as typeof import("./github.js");
  process.env.FACTORY_SANDBOX_REPO = saved;
  const { getGithubCursorAccountRuntime } = (await import(cursorAccountModule)) as { getGithubCursorAccountRuntime(definition: unknown): ProxyRuntime | undefined };
  const runtime = getGithubCursorAccountRuntime(channel);
  if (runtime === undefined) throw new Error("hosted-boot channel has no cursorAccount runtime");
  runtime.credentials.bind(async () => "cursor-api-key");
  runtime.credentials.bindProxyTransport({ apiBaseUrl: "https://api.cursor.test/v0/github-proxy", headers: { "x-cursor-github-permissions": "pr-write" } });
  const found = getGitHubChannelOptions(channel);
  if (found === undefined) throw new Error("hosted-boot channel options were not recorded");
  return found;
}

/** github-proxy in front of the draft PR: a request with no repo scope is a 400, as marsbank#28 got. */
function stubGithubProxy() {
  const state = { draft: true, readyFor: [] as unknown[], requests: [] as string[] };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const request = url instanceof Request ? url : new Request(String(url), init);
    const path = new URL(request.url).pathname.replace(/^\/v0\/github-proxy/, "");
    const repos = request.headers.get("x-cursor-github-repos") ?? "";
    state.requests.push(`${request.method} ${path} [${repos}]`);
    if (request.headers.get("authorization") !== "Bearer cursor-api-key") return Response.json({ message: "Unauthorized" }, { status: 401 });
    if (repos.trim() === "") return Response.json({ message: "Missing x-cursor-github-repos header" }, { status: 400 });
    if (!repos.split(",").includes(SANDBOX)) return Response.json({ message: "Repository not in scope" }, { status: 403 });
    if (request.method === "POST" && path === "/graphql") {
      const body = (await request.json()) as { query: string; variables: { id: string } };
      if (!body.query.includes("markPullRequestReadyForReview")) return Response.json({ errors: [{ message: "unexpected query" }] });
      state.readyFor.push(body.variables.id);
      state.draft = false;
      return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    if (path !== `/repos/${SANDBOX}/pulls/13`) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ number: 13, node_id: "PR_kwDO13", draft: state.draft, body: `Jira: ${JIRA}\nSlack: ${SLACK}\n\nbody` });
  };
  return { api: { fetch }, state };
}

test("marsbank#28: on a hosted boot (github-proxy scoped per request) the opened draft is still marked ready, because the GraphQL call names its repo", async () => {
  const tracker = fakeTracker({ status: "In Progress", comments: [PLAN] });
  const kv = await launchedKv();
  const proxy = stubGithubProxy();
  const declared = { ...(await hostedBootChannel()), api: proxy.api };
  assert.equal(declared.cursorAccount, true);
  const h = harness(tracker, kv);
  const response = await dispatchGitHubWebhook({
    options: declared,
    eventName: "pull_request",
    payload: pullRequestPayload({ action: "opened", sender: { login: "cursor[bot]", type: "Bot" } }),
    args: h.args,
  });
  assert.equal(response.status, 202);
  await h.settle();
  const pulls = `/repos/${SANDBOX}/pulls/13`;
  assert.deepEqual(proxy.state.requests.slice(0, 2), [`GET ${pulls} [${SANDBOX}]`, `POST /graphql [${SANDBOX}]`]);
  assert.deepEqual(proxy.state.readyFor, ["PR_kwDO13"]);
  assert.equal(proxy.state.draft, false);
  assert.equal(tracker.status(), "In Review");
});

test("the implement PR opening runs a host task that moves the ticket to In Review, with no model turn", async () => {
  const tracker = fakeTracker({ status: "In Progress" });
  const h = harness(tracker, await launchedKv());
  const github = stubPullRequest(`Jira: ${JIRA}`);
  const response = await dispatchGitHubWebhook({
    options: { ...(await options()), cursorAccount: undefined, credentials: { token: "test-token" }, api: github.api },
    eventName: "pull_request",
    payload: pullRequestPayload({ action: "opened", sender: { login: "cursor[bot]", type: "Bot" } }),
    args: h.args,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(((await response.json()) as { mode?: string }).mode, "task");
  await h.settle();
  assert.equal(tracker.status(), "In Review");
  assert.deepEqual(h.sends, []);
});

test("a person merging it moves the ticket to Done; a bot merging it moves nothing", async () => {
  const kv = await launchedKv();
  const bot = fakeTracker({ status: "In Review" });
  const botRun = harness(bot, kv);
  const skipped = await dispatchGitHubWebhook({
    options: await options(),
    eventName: "pull_request",
    payload: pullRequestPayload({ action: "closed", merged: true, sender: { login: "cursor[bot]", type: "Bot" }, mergedBy: { login: "cursor[bot]", type: "Bot" } }),
    args: botRun.args,
  });
  assert.equal(((await skipped.json()) as { reason?: string }).reason, "not_dispatched");
  await botRun.settle();
  assert.equal(bot.status(), "In Review");
  assert.equal(bot.calls.length, 0);

  const person = fakeTracker({ status: "In Review" });
  const personRun = harness(person, kv);
  const merged = await dispatchGitHubWebhook({
    options: await options(),
    eventName: "pull_request",
    payload: pullRequestPayload({ action: "closed", merged: true, sender: { login: "example-user", type: "User" }, mergedBy: { login: "example-user", type: "User" } }),
    args: personRun.args,
  });
  assert.equal(merged.status, 202);
  await personRun.settle();
  assert.equal(person.status(), "Done");
  assert.ok(person.comments.includes("Merged by: example-user"), person.comments.join("\n"));
  assert.deepEqual(personRun.sends, []);
});

test("a comment mentioning the bot never starts a turn", async () => {
  const tracker = fakeTracker({ status: "In Progress" });
  const h = harness(tracker, await launchedKv());
  const response = await dispatchGitHubWebhook({
    options: await options(),
    eventName: "issue_comment",
    payload: {
      action: "created",
      repository: { full_name: SANDBOX, name: "marsbank", html_url: `https://github.com/${SANDBOX}`, owner: { login: "cursor-demo-lab" } },
      issue: { number: 13, html_url: `https://github.com/${SANDBOX}/pull/13`, pull_request: { url: `https://api.github.com/repos/${SANDBOX}/pulls/13` } },
      comment: { id: 1, body: "@factory-worker merge this", html_url: `https://github.com/${SANDBOX}/pull/13#issuecomment-1`, url: `https://api.github.com/repos/${SANDBOX}/issues/comments/1`, user: { login: "example-user", type: "User" } },
      sender: { login: "example-user", type: "User" },
    },
    args: h.args,
  });
  const body = (await response.json()) as { skipped?: boolean };
  assert.equal(body.skipped, true);
  assert.deepEqual(h.sends, []);
  assert.equal(tracker.calls.length, 0);
});

test("the project mounts the jira and github channels and declares the new status secrets", async () => {
  const project = await loadAgentProject(ROOT);
  const secretNames = project.agent.hosting?.secretNames ?? [];
  for (const name of ["FACTORY_STATUS_IN_REVIEW", "FACTORY_STATUS_DONE", "FACTORY_SANDBOX_REPO", "FACTORY_JIRA_PROJECTS"]) {
    assert.ok(secretNames.includes(name), name);
  }
  assert.equal(secretNames.includes("FACTORY_GITHUB_TOKEN"), false);
  const channels = project.channels.map((channel) => channel.id).sort();
  assert.deepEqual(channels, ["github", "jira"]);
});

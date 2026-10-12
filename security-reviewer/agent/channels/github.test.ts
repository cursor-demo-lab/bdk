import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChannelHandlerArgs, HostKvApi } from "@cursor/july";
import {
  deriveGitHubWebhookEvents,
  dispatchGitHubWebhook,
  getGitHubChannelOptions,
} from "@cursor/july/channels/github";

const IN_SCOPE = "acme/in-scope";
const SECOND_IN_SCOPE = "acme/second";
const OUT_OF_SCOPE = "other/out-of-scope";

// github.ts reads githubReposAtBoot() while the module loads. An unset
// list is an empty allowlist so a hosted freeze can start; the tests
// still set the variables so the channel declares the fixture repos.
process.env.FACTORY_REPOS = `${IN_SCOPE},${SECOND_IN_SCOPE}`;
process.env.PR_AUTOFIXER_REPOS = IN_SCOPE;
process.env.SECURITY_REVIEWER_REPOS = `${IN_SCOPE},${SECOND_IN_SCOPE}`;
process.env.FACTORY_JIRA_PROJECTS = "TLSSN";

const channelReady = import("./github.js");

function pullRequestPayload(fullName: string, action: string) {
  const slash = fullName.indexOf("/");
  const owner = fullName.slice(0, slash);
  const repo = fullName.slice(slash + 1);
  return {
    action,
    repository: {
      full_name: fullName,
      name: repo,
      html_url: `https://github.com/${fullName}`,
      owner: { login: owner },
    },
    pull_request: {
      number: 7,
      html_url: `https://github.com/${fullName}/pull/7`,
      title: "Outside the factory",
      draft: false,
      merged: false,
      user: { login: "cursor[bot]" },
      head: { ref: "topic", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    },
  };
}

function trackingArgs(host: object = {}): { args: ChannelHandlerArgs; sends: string[] } {
  const sends: string[] = [];
  const args = {
    params: {},
    requestIp: null,
    auth: null,
    host,
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
    waitUntil() {},
    sessionUrls: () => ({
      playgroundUrl: "http://127.0.0.1/",
      traceUrl: "http://127.0.0.1/",
    }),
  } as unknown as ChannelHandlerArgs;
  return { args, sends };
}

test("declares the default pr-write tier, no reply delivery, and comment plus pull request events", async () => {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) {
    throw new Error("github channel options were not recorded");
  }
  assert.equal(options.deliverReplies, false);
  const account = options.cursorAccount;
  if (typeof account !== "object") {
    throw new Error("cursorAccount repos are not declared");
  }
  assert.deepEqual([...account.repos], [IN_SCOPE, SECOND_IN_SCOPE]);
  // Unset permissions is the framework default, pr-write.
  assert.equal(account.permissions ?? "pr-write", "pr-write");
  assert.equal(options.webhookEvents, undefined);
  assert.deepEqual(deriveGitHubWebhookEvents(options), [
    "pull_request",
    "issue_comment",
    "pull_request_review_comment",
  ]);
});

type DeliveryLine = {
  factoryDebug?: string;
  deliveryId?: string;
  event?: string;
  action?: string;
  repo?: string;
  number?: number;
  sender?: string;
  isBot?: boolean;
  decision?: string;
  watches?: boolean;
  draft?: boolean;
  dispatched?: boolean;
  factoryKey?: string;
  error?: string;
};

// Runs fn with console.log captured and returns its delivery log lines.
async function deliveryLines<T>(fn: () => Promise<T>): Promise<{ result: T; lines: DeliveryLine[] }> {
  const raw: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { raw.push(String(line)); };
  try {
    const result = await fn();
    const lines = raw.map((line) => JSON.parse(line) as DeliveryLine).filter((line) => line.factoryDebug === "github-event");
    return { result, lines };
  } finally {
    console.log = log;
  }
}

function memoryKv(): HostKvApi {
  const store = new Map<string, unknown>();
  return {
    get: async (key) => store.get(key) as never,
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
  };
}

// Each delivery logs what onPullRequest decided. None of these start a
// turn, so send never runs.
test("each pull request delivery logs one line with the hook's decision", async () => {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) {
    throw new Error("github channel options were not recorded");
  }
  const draft = pullRequestPayload(IN_SCOPE, "opened");
  draft.pull_request.draft = true;
  const deliveries = [
    { payload: pullRequestPayload(OUT_OF_SCOPE, "opened"), deliveryId: "d-out" },
    { payload: draft, deliveryId: "d-draft" },
    { payload: pullRequestPayload(IN_SCOPE, "closed"), deliveryId: "d-closed" },
  ];
  const events: DeliveryLine[] = [];
  for (const delivery of deliveries) {
    const { args, sends } = trackingArgs({ kv: memoryKv() });
    const { result: response, lines } = await deliveryLines(() =>
      dispatchGitHubWebhook({ options, eventName: "pull_request", payload: { ...delivery.payload, sender: { login: "example-user", type: "User", id: 1 } }, deliveryId: delivery.deliveryId, args })
    );
    const body = (await response.json()) as { skipped?: boolean; reason?: string };
    assert.deepEqual([body.skipped, body.reason], [true, "not_dispatched"], delivery.deliveryId);
    assert.deepEqual(sends, []);
    events.push(...lines);
  }
  assert.deepEqual(
    events.map(({ deliveryId, event, action, repo, number, sender, isBot, decision, watches, draft: isDraft, dispatched }) => ({ deliveryId, event, action, repo, number, sender, isBot, decision, watches, draft: isDraft, dispatched })),
    [
      { deliveryId: "d-out", event: "pull_request", action: "opened", repo: OUT_OF_SCOPE, number: 7, sender: "example-user", isBot: false, decision: "not_watched", watches: false, draft: false, dispatched: false },
      { deliveryId: "d-draft", event: "pull_request", action: "opened", repo: IN_SCOPE, number: 7, sender: "example-user", isBot: false, decision: "draft_not_factory", watches: true, draft: true, dispatched: false },
      { deliveryId: "d-closed", event: "pull_request", action: "closed", repo: IN_SCOPE, number: 7, sender: "example-user", isBot: false, decision: "action_skipped", watches: true, draft: false, dispatched: false },
    ]
  );
});

test("a pull request comment logs one line and is still ignored", async () => {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) {
    throw new Error("github channel options were not recorded");
  }
  const { repository } = pullRequestPayload(IN_SCOPE, "created");
  const { args, sends } = trackingArgs({ kv: memoryKv() });
  const { result: response, lines } = await deliveryLines(() => dispatchGitHubWebhook({
    options,
    eventName: "issue_comment",
    deliveryId: "d-comment",
    payload: {
      action: "created",
      repository,
      issue: {
        number: 7,
        html_url: `https://github.com/${IN_SCOPE}/pull/7`,
        pull_request: { url: `https://api.github.com/repos/${IN_SCOPE}/pulls/7` },
      },
      comment: { id: 501, body: "factory: drive", html_url: `https://github.com/${IN_SCOPE}/pull/7#issuecomment-501`, user: { login: "cursor[bot]", type: "Bot" } },
      sender: { login: "cursor[bot]", type: "Bot", id: 2 },
    },
    args,
  }));
  assert.equal(((await response.json()) as { reason?: string }).reason, "not_dispatched");
  assert.deepEqual(sends, []);
  assert.equal(lines.length, 1);
  const [event] = lines;
  assert.equal(event?.event, "issue_comment");
  assert.equal(event?.decision, "ignored_comment");
  assert.equal(event?.sender, "cursor[bot]");
  assert.equal(event?.isBot, true);
  assert.equal(event?.deliveryId, "d-comment");
});

// Factory PRs can arrive as cursor[bot] drafts for the moment before
// factory-worker marks them ready. A draft whose head branch or
// title starts with a FACTORY_JIRA_PROJECTS key is reviewed; any other draft
// is skipped. The stub GitHub is a live PR: its metadata and its unpinned
// diff answer for whatever head the PR has now (they can disagree while a
// push lands). Compare names its base and head in the diff: a sha answers
// for exactly that sha, a branch name for the PR's current head.
// compareBody replaces the compare response: a string is sent as the diff
// text, anything else as JSON.
type LivePr = { metaHead: string; pullDiffHead: string; compareFails?: boolean; compareBody?: unknown };

const BASE_SHA = "b".repeat(40);

function stubGitHub(live: LivePr = { metaHead: "a".repeat(40), pullDiffHead: "a".repeat(40) }) {
  return {
    apiBaseUrl: "https://github.test",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = decodeURIComponent(new URL(String(url)).pathname);
      const accept = new Headers(init?.headers).get("accept") ?? "";
      const text = (body: string) => new Response(`${body}\n`, { status: 200, headers: { "content-type": "text/plain" } });
      const compare = path.match(/^\/repos\/acme\/[^/]+\/compare\/(.+)\.\.\.(.+)$/);
      if (compare !== null && accept.includes("diff")) {
        if (live.compareFails === true) return Response.json({ message: "Server Error" }, { status: 502 });
        if (typeof live.compareBody === "string") return new Response(live.compareBody, { status: 200, headers: { "content-type": "text/plain" } });
        if (live.compareBody !== undefined) return Response.json(live.compareBody);
        const head = /^[0-9a-f]{40}$/.test(compare[2]!) ? compare[2]! : live.metaHead;
        return text(`diff --git a/${compare[1]} b/${head}`);
      }
      if (/^\/repos\/acme\/[^/]+\/pulls\/\d+$/.test(path)) {
        return accept.includes("diff") ? text(`diff pulls@${live.pullDiffHead}`) : Response.json({ head: { sha: live.metaHead } });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  };
}

function evidence(base: string, head: string): Record<string, string> {
  const patch = `diff --git a/${base} b/${head}\n`;
  return {
    "pr/diff.patch": patch,
    "pr/head.sha": head,
    "pr/diff.json": JSON.stringify({ base, headSha: head, totalChars: patch.length, shownChars: patch.length, patchChars: patch.length, truncated: false, cutFiles: [] }),
  };
}

type Sent = {
  message: string;
  options: {
    auth?: { principalId?: string; principalType?: string } | null;
    continuationToken?: string;
    workspaceFiles?: Record<string, string>;
  };
};

async function deliver(input: {
  action: string;
  draft: boolean;
  headRef: string;
  title: string;
  sender?: string;
  author?: string;
  headSha?: string;
  baseSha?: string;
  baseRef?: string;
  changes?: unknown;
  repo?: string;
  number?: number;
  kv?: HostKvApi;
  live?: LivePr;
  withoutBaseSha?: boolean;
}): Promise<{
  body: { skipped?: boolean; reason?: string };
  sends: Sent[];
  decision: string | undefined;
  factoryKey: string | undefined;
  logs: { decision?: string; dispatched?: boolean; error?: string }[];
}> {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) {
    throw new Error("github channel options were not recorded");
  }
  const kv = input.kv ?? memoryKv();
  const payload = pullRequestPayload(input.repo ?? IN_SCOPE, input.action);
  if (input.number !== undefined) payload.pull_request.number = input.number;
  payload.pull_request.draft = input.draft;
  payload.pull_request.title = input.title;
  payload.pull_request.head.ref = input.headRef;
  payload.pull_request.user.login = input.author ?? "cursor[bot]";
  if (input.headSha !== undefined) payload.pull_request.head.sha = input.headSha;
  if (input.baseSha !== undefined) payload.pull_request.base.sha = input.baseSha;
  if (input.baseRef !== undefined) payload.pull_request.base.ref = input.baseRef;
  if (input.withoutBaseSha === true) delete (payload.pull_request.base as { sha?: string }).sha;
  const sender = input.sender ?? "cursor[bot]";
  const sends: Sent[] = [];
  const pending: Promise<unknown>[] = [];
  const { args } = trackingArgs({ kv });
  const tracked = {
    ...args,
    send: async (message: string, sendOptions: Sent["options"]) => {
      sends.push({ message, options: sendOptions });
      return { sessionId: "ses_test" };
    },
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  } as unknown as ChannelHandlerArgs;
  const { result: response, lines } = await deliveryLines(async () => {
    const answered = await dispatchGitHubWebhook({
      options: { ...options, credentials: { token: "test-token" }, api: stubGitHub(input.live) },
      eventName: "pull_request",
      payload: { ...payload, ...(input.changes === undefined ? {} : { changes: input.changes }), sender: { login: sender, type: sender.endsWith("[bot]") ? "Bot" : "User", id: 3 } },
      deliveryId: `d-${input.action}`,
      args: tracked,
    });
    await Promise.all(pending);
    return answered;
  });
  const last = lines.at(-1);
  const logs = lines.map(({ decision, dispatched, error }) => ({ decision, dispatched, ...(error === undefined ? {} : { error }) }));
  return { body: (await response.json()) as { skipped?: boolean; reason?: string }, sends, decision: last?.decision, factoryKey: last?.factoryKey, logs };
}

const PR_KEY = `github-pr:${IN_SCOPE}#7`;

test("a factory draft is reviewed on opened and on a later synchronize, in one session owned by the PR", async () => {
  const kv = memoryKv();
  const opened = await deliver({ action: "opened", draft: true, headRef: "TLSSN-8-csv-export-zero-rows", title: "TLSSN-8: CSV export returns 500", kv });
  assert.notEqual(opened.body.skipped, true);
  assert.equal(opened.decision, "review_factory_draft");
  assert.equal(opened.factoryKey, "TLSSN-8");
  assert.equal(opened.sends.length, 1);
  const pushed = await deliver({ action: "synchronize", draft: true, headRef: "TLSSN-8-csv-export-zero-rows", title: "TLSSN-8: CSV export returns 500", sender: "example-user", kv });
  assert.notEqual(pushed.body.skipped, true);
  assert.equal(pushed.decision, "review_factory_draft");
  assert.equal(pushed.sends.length, 1);
  for (const sent of [opened.sends[0], pushed.sends[0]]) {
    assert.equal(sent?.options.auth?.principalId, PR_KEY);
    assert.equal(sent?.options.auth?.principalType, "service");
    assert.equal(sent?.options.continuationToken, PR_KEY);
    assert.match(sent?.message ?? "", /Read pr\/diff\.patch\./);
  }
});

test("a draft is a factory draft by its branch key, or by its title key when the Cursor bot opened it; any other draft is skipped", async () => {
  const cases = [
    { label: "branch key alone", reviewed: true, factoryKey: "TLSSN-8", input: { action: "opened", headRef: "TLSSN-8-csv-export-zero-rows", title: "CSV export returns 500 on zero rows" } },
    { label: "a person's branch key", reviewed: true, input: { action: "opened", headRef: "TLSSN-8-csv-export-zero-rows", title: "Work in progress", author: "example-user", sender: "example-user" } },
    { label: "the Cursor bot's title key", reviewed: true, factoryKey: "TLSSN-8", input: { action: "opened", headRef: "csv-export-fix", title: "TLSSN-8: CSV export returns 500", author: "cursor[bot]", sender: "example-user" } },
    { label: "a person's title key", reviewed: false, input: { action: "opened", headRef: "csv-export-fix", title: "TLSSN-8: CSV export returns 500", author: "example-user", sender: "example-user" } },
    { label: "a human draft, opened", reviewed: false, factoryKey: undefined, input: { action: "opened", headRef: "topic", title: "Work in progress", sender: "example-user" } },
    { label: "a human draft, synchronize", reviewed: false, factoryKey: undefined, input: { action: "synchronize", headRef: "topic", title: "Work in progress", sender: "example-user" } },
    { label: "a key outside FACTORY_JIRA_PROJECTS", reviewed: false, input: { action: "opened", headRef: "OTHER-3-thing", title: "OTHER-3: thing" } },
  ];
  for (const row of cases) {
    const result = await deliver({ ...row.input, draft: true });
    if ("factoryKey" in row) assert.equal(result.factoryKey, row.factoryKey, row.label);
    if (row.reviewed) {
      assert.equal(result.decision, "review_factory_draft", row.label);
      assert.equal(result.sends.length, 1, row.label);
    } else {
      assert.equal(result.body.reason, "not_dispatched", row.label);
      assert.equal(result.decision, "draft_not_factory", row.label);
      assert.deepEqual(result.sends, [], row.label);
    }
  }
});

test("with FACTORY_JIRA_PROJECTS unset every draft is skipped", async () => {
  const saved = process.env.FACTORY_JIRA_PROJECTS;
  delete process.env.FACTORY_JIRA_PROJECTS;
  try {
    const result = await deliver({ action: "opened", draft: true, headRef: "TLSSN-8-csv-export-zero-rows", title: "TLSSN-8: CSV export returns 500" });
    assert.equal(result.decision, "draft_not_factory");
    assert.deepEqual(result.sends, []);
  } finally {
    process.env.FACTORY_JIRA_PROJECTS = saved;
  }
});

test("non-draft pull requests are reviewed as before, factory or not, including on ready_for_review", async () => {
  const cases = [
    { action: "opened", headRef: "topic", title: "Outside the factory", sender: "example-user" },
    { action: "synchronize", headRef: "TLSSN-8-csv-export-zero-rows", title: "TLSSN-8: CSV export returns 500", factoryKey: "TLSSN-8" },
    { action: "ready_for_review", headRef: "topic", title: "Outside the factory", sender: "example-user" },
    { action: "ready_for_review", headRef: "TLSSN-8-csv-export-zero-rows", title: "TLSSN-8: CSV export", sender: "example-user", factoryKey: "TLSSN-8" },
  ];
  for (const { factoryKey, ...input } of cases) {
    const result = await deliver({ ...input, draft: false });
    assert.equal(result.decision, "review", input.action);
    assert.equal(result.factoryKey, factoryKey, input.action);
    assert.equal(result.sends.length, 1, input.action);
    assert.equal(result.sends[0]?.options.auth?.principalId, PR_KEY, input.action);
  }
});

// A posted review records its head in host.kv; a later delivery on that head
// is skipped. The review is posted through the real post_findings, run in a
// workspace holding exactly the files the delivery sent.
type ExecuteTool = { execute: (input: { findings: [] }, ctx: never) => Promise<unknown> };
type Posted = { commitId: string; body: string; verdict?: string; recorded?: boolean };

async function postFindings(kv: HostKvApi, sent: Sent | undefined): Promise<Posted> {
  const { default: tool } = await import("../tools/post_findings.js");
  const workspaceDir = await mkdtemp(join(tmpdir(), "reviewer-"));
  await mkdir(join(workspaceDir, "pr"));
  for (const [name, content] of Object.entries(sent?.options.workspaceFiles ?? {})) {
    await writeFile(join(workspaceDir, name), content);
  }
  const posted: { commit_id?: string; body?: string }[] = [];
  const octokit = {
    rest: {
      pulls: {
        createReview: async (params: { commit_id?: string; body?: string }) => {
          posted.push(params);
          return { data: { html_url: "https://github.com/review" } };
        },
      },
    },
  };
  const result = await (tool as unknown as ExecuteTool).execute({ findings: [] }, {
    session: { purpose: "run", continuationKey: `cont:${PR_KEY}` },
    workspaceDir,
    host: { kv, github: { getOctokit: async () => octokit } },
  } as never);
  const { posted: ok, verdict, recorded } = result as { posted?: boolean; verdict?: string; recorded?: boolean };
  assert.equal(ok, true);
  assert.equal(posted.length, 1);
  return { commitId: posted[0]?.commit_id ?? "", body: posted[0]?.body ?? "", verdict, recorded };
}

test("one head is reviewed once across synchronize, ready_for_review, and reopened; a new head is reviewed again", async () => {
  const kv = memoryKv();
  const base = { draft: true, headRef: "TLSSN-8-csv-export-zero-rows", title: "TLSSN-8: CSV export", kv };
  const first = "1".repeat(40);
  const second = "2".repeat(40);
  const turns: string[] = [];
  const pushed = await deliver({ ...base, action: "synchronize", headSha: first });
  assert.equal(pushed.decision, "review_factory_draft");
  turns.push(...pushed.sends.map(() => "synchronize"));
  await postFindings(kv, pushed.sends[0]);
  for (const action of ["ready_for_review", "reopened"]) {
    const repeat = await deliver({ ...base, action, draft: action !== "ready_for_review", headSha: first, sender: "example-user" });
    assert.equal(repeat.body.reason, "not_dispatched");
    assert.equal(repeat.decision, "already_reviewed");
    turns.push(...repeat.sends.map(() => action));
  }
  const next = await deliver({ ...base, action: "synchronize", draft: false, headSha: second });
  assert.equal(next.decision, "review");
  turns.push(...next.sends.map(() => "synchronize"));
  assert.deepEqual(turns, ["synchronize", "synchronize"]);
});

test("a head that moves while the evidence is fetched is not recorded as reviewed with the older diff", async () => {
  const kv = memoryKv();
  const headA = "a1".repeat(20);
  const headB = "b2".repeat(20);
  const base = { draft: true, headRef: "TLSSN-8-csv-export-zero-rows", title: "TLSSN-8: CSV export", kv };
  // Event for A; head B lands mid-fetch: the PR's metadata already says B,
  // its unpinned diff still shows A.
  const eventA = await deliver({ ...base, action: "synchronize", headSha: headA, live: { metaHead: headB, pullDiffHead: headA } });
  assert.equal(eventA.sends.length, 1);
  assert.deepEqual(eventA.sends[0]?.options.workspaceFiles, evidence(BASE_SHA, headA));
  const review = await postFindings(kv, eventA.sends[0]);
  assert.equal(review.commitId, headA);
  const eventB = await deliver({ ...base, action: "synchronize", headSha: headB, live: { metaHead: headB, pullDiffHead: headB } });
  assert.equal(eventB.decision, "review_factory_draft");
  assert.equal(eventB.sends.length, 1);
  assert.deepEqual(eventB.sends[0]?.options.workspaceFiles, evidence(BASE_SHA, headB));
});

const FACTORY = { draft: true, headRef: "TLSSN-8-csv-export-zero-rows", title: "TLSSN-8: CSV export" };

test("a compare failure records fetch_failed, starts no turn, and the next delivery of that head reviews", async () => {
  const kv = memoryKv();
  const head = "d6".repeat(20);
  const failed = await deliver({ ...FACTORY, action: "synchronize", headSha: head, kv, live: { metaHead: head, pullDiffHead: head, compareFails: true } });
  assert.deepEqual(failed.sends, []);
  assert.deepEqual(failed.logs, [
    { decision: "review_factory_draft", dispatched: true },
    { decision: "fetch_failed", dispatched: false, error: "HttpError" },
  ]);
  const retried = await deliver({ ...FACTORY, action: "synchronize", headSha: head, kv });
  assert.deepEqual(retried.logs, [{ decision: "review_factory_draft", dispatched: true }]);
  assert.equal(retried.sends.length, 1);
});

test("a kv read outage reviews instead of suppressing", async () => {
  const store = memoryKv();
  const head = "e7".repeat(20);
  await postFindings(store, (await deliver({ ...FACTORY, action: "synchronize", headSha: head, kv: store })).sends[0]);
  const outage: HostKvApi = {
    ...store,
    get: async (key) => {
      if (key.startsWith("reviewed/")) throw new Error("kv unavailable");
      return store.get(key);
    },
  };
  const again = await deliver({ ...FACTORY, action: "ready_for_review", draft: false, headSha: head, kv: outage });
  assert.equal(again.decision, "review");
  assert.equal(again.sends.length, 1);
});

test("an ambiguous kv write after a post still returns posted and suppresses that head", async () => {
  const store = memoryKv();
  const ambiguous: HostKvApi = {
    ...store,
    put: async (key, value) => {
      await store.put(key, value);
      if (key.startsWith("reviewed/")) throw new Error("timeout after commit");
    },
  };
  const head = "f8".repeat(20);
  const first = await deliver({ ...FACTORY, action: "synchronize", headSha: head, kv: ambiguous });
  await postFindings(ambiguous, first.sends[0]);
  const again = await deliver({ ...FACTORY, action: "ready_for_review", draft: false, headSha: head, kv: ambiguous });
  assert.equal(again.decision, "already_reviewed");
  assert.deepEqual(again.sends, []);
});

test("a replayed older head is reviewed and never suppresses the newer head", async () => {
  const kv = memoryKv();
  const older = "a9".repeat(20);
  const newer = "ba".repeat(20);
  const b = await deliver({ ...FACTORY, action: "synchronize", headSha: newer, kv, live: { metaHead: newer, pullDiffHead: newer } });
  assert.equal((await postFindings(kv, b.sends[0])).commitId, newer);
  const replayed = await deliver({ ...FACTORY, action: "opened", headSha: older, kv, live: { metaHead: newer, pullDiffHead: newer } });
  assert.deepEqual(replayed.sends[0]?.options.workspaceFiles, evidence(BASE_SHA, older));
  assert.equal((await postFindings(kv, replayed.sends[0])).commitId, older);
  const newerAgain = await deliver({ ...FACTORY, action: "synchronize", headSha: newer, kv, live: { metaHead: newer, pullDiffHead: newer } });
  assert.equal(newerAgain.decision, "review_factory_draft");
  assert.equal(newerAgain.sends.length, 1);
});

test("concurrent posts for two heads leave a record naming one of the heads actually reviewed", async () => {
  const kv = memoryKv();
  const headA = "cb".repeat(20);
  const headB = "dc".repeat(20);
  const a = await deliver({ ...FACTORY, action: "synchronize", headSha: headA, kv, live: { metaHead: headA, pullDiffHead: headA } });
  const b = await deliver({ ...FACTORY, action: "synchronize", headSha: headB, kv, live: { metaHead: headB, pullDiffHead: headB } });
  const posted = await Promise.all([postFindings(kv, a.sends[0]), postFindings(kv, b.sends[0])]);
  assert.deepEqual(posted.map((p) => p.commitId), [headA, headB]);
  const decisions: Record<string, string | undefined> = {};
  for (const head of [headA, headB]) {
    decisions[head] = (await deliver({ ...FACTORY, action: "reopened", headSha: head, kv })).decision;
  }
  assert.deepEqual(Object.values(decisions).sort(), ["already_reviewed", "review_factory_draft"]);
});

function section(path: string, chars: number): string {
  const header = `diff --git a/${path} b/${path}\n`;
  return header + "+".repeat(chars - header.length - 1) + "\n";
}

test("a diff over the cap is cut at 150000 chars with a marker, lockfiles first, and the review is INCOMPLETE and not repeated for that base and head", async () => {
  const kv = memoryKv();
  const head = "1b".repeat(20);
  const lock = section("package-lock.json", 100_000);
  const source = section("src/app.ts", 100_000);
  const live = { metaHead: head, pullDiffHead: head, compareBody: lock + source };
  const result = await deliver({ ...FACTORY, action: "synchronize", headSha: head, kv, live });
  const files = result.sends[0]?.options.workspaceFiles ?? {};
  const patch = files["pr/diff.patch"] ?? "";
  assert.equal(patch, `${(source + lock).slice(0, 150_000)}\n…[truncated at 150000 of 200000 chars]\n`);
  assert.deepEqual(JSON.parse(files["pr/diff.json"] ?? "{}"), {
    base: BASE_SHA,
    headSha: head,
    totalChars: 200_000,
    shownChars: 150_000,
    patchChars: patch.length,
    truncated: true,
    cutFiles: ["package-lock.json"],
  });
  const review = await postFindings(kv, result.sends[0]);
  assert.equal(review.verdict, "INCOMPLETE");
  assert.equal(review.recorded, true);
  assert.equal(
    review.body,
    `## Security review\n\n**Verdict:** INCOMPLETE\nSecurity only, on head \`${head.slice(0, 7).toLowerCase()}\`; Bugbot covers correctness. A new push gets a new review.\n\nPartial review: diff truncated at 150000 of 200000 chars.\nNot fully reviewed: \`package-lock.json\``
  );
  const again = await deliver({ ...FACTORY, action: "reopened", headSha: head, kv, live });
  assert.equal(again.decision, "already_reviewed_incomplete");
  assert.deepEqual(again.sends, []);
  const otherBase = await deliver({ ...FACTORY, action: "reopened", headSha: head, baseSha: OTHER_BASE, kv, live });
  assert.equal(otherBase.decision, "review_factory_draft");
  assert.equal(otherBase.sends.length, 1);
});

test("a small source fix with lockfile churn over the cap posts one INCOMPLETE review per head; the next head reviews", async () => {
  const kv = memoryKv();
  const fix = "diff --git a/app/api/export/route.ts b/app/api/export/route.ts\n-  if (!rows) throw new Error();\n+  if (!rows) return empty();\n+  audit(rows);\n";
  const churn = section("package-lock.json", 305_000 - fix.length);
  const first = "5f".repeat(20);
  const live = { metaHead: first, pullDiffHead: first, compareBody: churn + fix };
  const opened = await deliver({ ...FACTORY, action: "opened", headSha: first, kv, live });
  const files = opened.sends[0]?.options.workspaceFiles ?? {};
  assert.equal(files["pr/diff.patch"]?.startsWith(fix), true);
  assert.deepEqual((JSON.parse(files["pr/diff.json"] ?? "{}") as { cutFiles?: string[] }).cutFiles, ["package-lock.json"]);
  const review = await postFindings(kv, opened.sends[0]);
  assert.equal(review.verdict, "INCOMPLETE");
  const turns = opened.sends.length;
  let repeats = 0;
  for (const action of ["ready_for_review", "reopened", "synchronize"]) {
    const repeat = await deliver({ ...FACTORY, action, draft: action !== "ready_for_review", headSha: first, kv, live, sender: "example-user" });
    assert.equal(repeat.decision, "already_reviewed_incomplete");
    repeats += repeat.sends.length;
  }
  assert.deepEqual([turns, repeats], [1, 0]);
  const second = "6a".repeat(20);
  const next = await deliver({ ...FACTORY, action: "synchronize", headSha: second, kv, live: { metaHead: second, pullDiffHead: second, compareBody: fix } });
  assert.equal(next.decision, "review_factory_draft");
  assert.equal(next.sends.length, 1);
  assert.equal((await postFindings(kv, next.sends[0])).verdict, "CLEAN");
});

test("a compare that answers 200 with something other than a unified diff is fetch_failed and starts no turn", async () => {
  const head = "2c".repeat(20);
  for (const compareBody of [{ files: [], commits: [] }, "<html>rate limited</html>", "diff pulls@x\n"]) {
    const result = await deliver({ ...FACTORY, action: "synchronize", headSha: head, live: { metaHead: head, pullDiffHead: head, compareBody } });
    assert.deepEqual(result.sends, []);
    assert.deepEqual(result.logs, [
      { decision: "review_factory_draft", dispatched: true },
      { decision: "fetch_failed", dispatched: false, error: "NotADiff" },
    ]);
  }
});

test("a compare of zero files is an empty, verified diff that posts CLEAN and records the head", async () => {
  const kv = memoryKv();
  const head = "3d".repeat(20);
  const live = { metaHead: head, pullDiffHead: head, compareBody: "" };
  const result = await deliver({ ...FACTORY, action: "synchronize", headSha: head, kv, live });
  const files = result.sends[0]?.options.workspaceFiles ?? {};
  assert.equal(files["pr/diff.patch"], "");
  const review = await postFindings(kv, result.sends[0]);
  assert.equal(review.verdict, "CLEAN");
  assert.equal(review.recorded, true);
  assert.equal((await deliver({ ...FACTORY, action: "reopened", headSha: head, kv, live })).decision, "already_reviewed");
});

test("every decision, including fetch_failed and a skipped draft, is a log line", async () => {
  const head = "4e".repeat(20);
  const failed = await deliver({ ...FACTORY, action: "synchronize", headSha: head, live: { metaHead: head, pullDiffHead: head, compareFails: true } });
  assert.deepEqual(failed.logs, [
    { decision: "review_factory_draft", dispatched: true },
    { decision: "fetch_failed", dispatched: false, error: "HttpError" },
  ]);
  const skipped = await deliver({ action: "opened", draft: true, headRef: "topic", title: "Work in progress", author: "example-user" });
  assert.deepEqual(skipped.logs, [{ decision: "draft_not_factory", dispatched: false }]);
});

// The evidence is compare/{base}...{head}, so the identity a review is
// recorded under is base plus head (repo and PR are the key).
const OTHER_BASE = "c7".repeat(20);

test("a fixed head against a changed base is reviewed again against the new base, then suppressed for that pair", async () => {
  const kv = memoryKv();
  const head = "7a".repeat(20);
  const first = await deliver({ ...FACTORY, action: "opened", headSha: head, baseSha: BASE_SHA, kv });
  await postFindings(kv, first.sends[0]);
  const retargeted = await deliver({ ...FACTORY, action: "reopened", headSha: head, baseSha: OTHER_BASE, kv });
  assert.equal(retargeted.decision, "review_factory_draft");
  assert.deepEqual(first.sends[0]?.options.workspaceFiles, evidence(BASE_SHA, head));
  assert.deepEqual(retargeted.sends[0]?.options.workspaceFiles, evidence(OTHER_BASE, head));
  await postFindings(kv, retargeted.sends[0]);
  const repeat = await deliver({ ...FACTORY, action: "reopened", headSha: head, baseSha: OTHER_BASE, kv });
  assert.equal(repeat.decision, "already_reviewed");
  assert.deepEqual(repeat.sends, []);
  const back = await deliver({ ...FACTORY, action: "reopened", headSha: head, baseSha: BASE_SHA, kv });
  assert.equal(back.decision, "review_factory_draft");
  assert.equal(back.sends.length, 1);
});

test("a delivery without base.sha is reviewed against the base branch and never suppressed, since a branch moves", async () => {
  const kv = memoryKv();
  const head = "ad".repeat(20);
  const first = await deliver({ ...FACTORY, action: "synchronize", headSha: head, withoutBaseSha: true, kv });
  assert.equal((await postFindings(kv, first.sends[0])).recorded, true);
  const again = await deliver({ ...FACTORY, action: "reopened", headSha: head, withoutBaseSha: true, kv });
  assert.equal(again.decision, "review_factory_draft");
  assert.equal(again.sends.length, 1);
  assert.deepEqual(first.sends[0]?.options.workspaceFiles, evidence("main", head));
});

test("an edited delivery that retargets the base reviews; an edit of the title or body does not", async () => {
  const kv = memoryKv();
  const head = "be".repeat(20);
  await postFindings(kv, (await deliver({ ...FACTORY, action: "opened", headSha: head, kv })).sends[0]);
  const retitled = await deliver({ ...FACTORY, action: "edited", headSha: head, baseSha: OTHER_BASE, kv, changes: { title: { from: "old" } } });
  assert.equal(retitled.decision, "action_skipped");
  assert.deepEqual(retitled.sends, []);
  const retarget = await deliver({ ...FACTORY, action: "edited", headSha: head, baseSha: OTHER_BASE, baseRef: "release", kv, changes: { base: { ref: { from: "main" } } } });
  assert.equal(retarget.decision, "review_factory_draft");
  assert.deepEqual(retarget.sends[0]?.options.workspaceFiles, evidence(OTHER_BASE, head));
  assert.equal(retarget.sends[0]?.options.auth?.principalId, PR_KEY);
  await postFindings(kv, retarget.sends[0]);
  const again = await deliver({ ...FACTORY, action: "edited", headSha: head, baseSha: OTHER_BASE, baseRef: "release", kv, changes: { base: { ref: { from: "main" } } } });
  assert.equal(again.decision, "already_reviewed");
  const humanDraft = await deliver({ action: "edited", draft: true, headRef: "topic", title: "Work in progress", author: "example-user", sender: "example-user", changes: { base: { ref: { from: "main" } } } });
  assert.equal(humanDraft.decision, "draft_not_factory");
  assert.deepEqual(humanDraft.sends, []);
});

test("concurrent posts for one head against two bases leave a record naming one pair; the other pair reviews again", async () => {
  const kv = memoryKv();
  const head = "cf".repeat(20);
  const a = await deliver({ ...FACTORY, action: "synchronize", headSha: head, baseSha: BASE_SHA, kv });
  const b = await deliver({ ...FACTORY, action: "reopened", headSha: head, baseSha: OTHER_BASE, kv });
  await Promise.all([postFindings(kv, a.sends[0]), postFindings(kv, b.sends[0])]);
  const decisions = [];
  for (const baseSha of [BASE_SHA, OTHER_BASE]) {
    decisions.push((await deliver({ ...FACTORY, action: "reopened", headSha: head, baseSha, kv })).decision);
  }
  assert.deepEqual(decisions.sort(), ["already_reviewed", "review_factory_draft"]);
});

test("a review of one PR does not suppress another PR number or the same number in another watched repo", async () => {
  const kv = memoryKv();
  const head = "d8".repeat(20);
  const first = await deliver({ ...FACTORY, action: "opened", headSha: head, baseSha: BASE_SHA, kv });
  await postFindings(kv, first.sends[0]);
  const otherNumber = await deliver({ ...FACTORY, action: "reopened", number: 8, headSha: head, baseSha: BASE_SHA, kv });
  assert.equal(otherNumber.decision, "review_factory_draft");
  assert.equal(otherNumber.sends.length, 1);
  const otherRepo = await deliver({ ...FACTORY, action: "reopened", repo: SECOND_IN_SCOPE, headSha: head, baseSha: BASE_SHA, kv });
  assert.equal(otherRepo.decision, "review_factory_draft");
  assert.equal(otherRepo.sends.length, 1);
  const same = await deliver({ ...FACTORY, action: "reopened", headSha: head, baseSha: BASE_SHA, kv });
  assert.equal(same.decision, "already_reviewed");
  assert.deepEqual(same.sends, []);
});

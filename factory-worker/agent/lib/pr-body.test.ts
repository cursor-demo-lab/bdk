import assert from "node:assert/strict";
import { test } from "node:test";
import { recordImplementation } from "./claim.js";
import { linkablePullRequest, linkTicketInBody, type PullRequestApi } from "./pr-body.js";
import type { PrDelivery } from "./pr-decide.js";
import { fakeTracker, memoryKv, type MemoryKv } from "./testing/fakes.js";

const JIRA = "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-28";
const SLACK = "https://example-workspace.slack.com/archives/C0EXAMPLE1/p1790370261284789?thread_ts=1790370261.284789&cid=C0EXAMPLE1";
const TARGET = { issueKey: "TLSSN-28", repository: "cursor-demo-lab/marsbank", number: 25 };
const PATH = "/repos/cursor-demo-lab/marsbank/pulls/25";

function planComment(options: { slack?: boolean } = {}): string {
  return [
    "Plan: TLSSN-28 Transfers page shows stale balance",
    "",
    "Brief:",
    "Implement Jira TLSSN-28 on cursor-demo-lab/marsbank from main: Transfers page shows stale balance",
    `Ticket: ${JIRA}`,
    ...(options.slack === false ? [] : [`Slack thread: ${SLACK}`]),
    'The branch name starts with TLSSN-28- and the pull request title with "TLSSN-28: ".',
    "",
    "Problem: The balance does not refresh after a transfer.",
  ].join("\n");
}

type Request = { method: string; path: string; body?: Record<string, unknown> };

function fakeGitHub(options: { body?: string | null; readStatus?: number; writeStatus?: number; throws?: boolean } = {}) {
  const requests: Request[] = [];
  let body = options.body ?? null;
  const github: PullRequestApi = {
    request: async <T>(input: Request) => {
      requests.push(input);
      if (options.throws === true) throw new Error("socket hang up");
      if (input.method === "GET") {
        const status = options.readStatus ?? 200;
        return { ok: status < 300, status, body: { number: 25, body } as T };
      }
      const status = options.writeStatus ?? 200;
      if (status < 300) body = String(input.body?.["body"]);
      return { ok: status < 300, status, body: {} as T };
    },
  };
  return { github, requests, body: () => body };
}

async function launchedKv(): Promise<MemoryKv> {
  const kv = memoryKv();
  await recordImplementation(kv, "TLSSN-28", { state: "launched", at: "2026-09-25T20:04:21.000Z", agentId: "bc-28", url: "https://cursor.com/agents/bc-28", commented: true, moved: true });
  return kv;
}

test("TLSSN-28: the implement PR's description gets Slack: under Jira: from the launched brief, once", async () => {
  const tracker = fakeTracker({ comments: [planComment()], status: "In Progress" });
  const gh = fakeGitHub({ body: `Jira: ${JIRA}\n\n## What changed\n- Refetch the balance` });
  const deps = { kv: await launchedKv(), mcp: tracker.mcp, github: gh.github };

  assert.equal(await linkTicketInBody(deps, TARGET), "written");
  assert.deepEqual(gh.requests.map((request) => `${request.method} ${request.path}`), [`GET ${PATH}`, `PATCH ${PATH}`]);
  assert.equal(gh.body(), `Jira: ${JIRA}\nSlack: ${SLACK}\n\n## What changed\n- Refetch the balance`);

  assert.equal(await linkTicketInBody(deps, TARGET), "present", "the edited delivery for the worker's own write");
  assert.equal(gh.requests.filter((request) => request.method === "PATCH").length, 1);
  assert.equal(tracker.calls.some((call) => call.tool !== "getJiraIssue"), false, "Jira is only read");
});

test("nothing is written without a launch, a brief, or a Slack thread on the brief", async () => {
  const cases = [
    ["not_launched", memoryKv(), [planComment()]],
    ["no_brief", await launchedKv(), ["Triage: bug. Severity: high"]],
    ["no_slack_thread", await launchedKv(), [planComment({ slack: false })]],
  ] as const;
  for (const [outcome, kv, comments] of cases) {
    const gh = fakeGitHub({ body: `Jira: ${JIRA}` });
    assert.equal(await linkTicketInBody({ kv, mcp: fakeTracker({ comments: [...comments] }).mcp, github: gh.github }, TARGET), outcome);
    assert.deepEqual(gh.requests, [], outcome);
  }
  const offline = fakeGitHub();
  assert.equal(await linkTicketInBody({ kv: await launchedKv(), mcp: fakeTracker({ connected: false }).mcp, github: offline.github }, TARGET), "unavailable");
  assert.deepEqual(offline.requests, []);
});

test("a GitHub read or write that fails is an outcome, never a throw", async () => {
  const mcp = fakeTracker({ comments: [planComment()] }).mcp;
  assert.equal(await linkTicketInBody({ kv: await launchedKv(), mcp, github: fakeGitHub({ readStatus: 404 }).github }, TARGET), "read_failed");
  assert.equal(await linkTicketInBody({ kv: await launchedKv(), mcp, github: fakeGitHub({ writeStatus: 403 }).github }, TARGET), "write_failed");
  assert.equal(await linkTicketInBody({ kv: await launchedKv(), mcp, github: fakeGitHub({ throws: true }).github }, TARGET), "failed");
});

test("linkablePullRequest: open and edit actions on the sandbox's implement PRs only", () => {
  const opts = { sandboxRepo: "cursor-demo-lab/marsbank", sandboxRef: "main", projects: ["TLSSN"] };
  const pr: PrDelivery = {
    action: "opened",
    repository: "cursor-demo-lab/marsbank",
    number: 25,
    url: "https://github.com/cursor-demo-lab/marsbank/pull/25",
    headRef: "TLSSN-28-refresh-balance",
    baseRef: "main",
    title: "TLSSN-28: Refresh the balance after a transfer",
    authorLogin: "cursor[bot]",
    merged: false,
    autoMerge: false,
  };
  for (const action of ["opened", "reopened", "ready_for_review", "edited"]) {
    assert.deepEqual(linkablePullRequest({ ...pr, action }, opts), TARGET, action);
  }
  assert.equal(linkablePullRequest({ ...pr, action: "synchronize" }, opts), undefined);
  assert.equal(linkablePullRequest({ ...pr, action: "closed", merged: true }, opts), undefined);
  assert.equal(linkablePullRequest({ ...pr, repository: "cursor-demo-lab/other" }, opts), undefined);
  assert.equal(linkablePullRequest({ ...pr, baseRef: "release" }, opts), undefined);
  assert.equal(linkablePullRequest({ ...pr, headRef: "fix-typo", authorLogin: "example-user" }, opts), undefined, "a person's PR titled with a key");
});

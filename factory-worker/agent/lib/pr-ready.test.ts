import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recordImplementation } from "./claim.js";
import type { PrDelivery } from "./pr-decide.js";
import { markReadyForReview, noteNotReady, prReadyNote, readyablePullRequest, readyRecordKey, type ReadyApi, type ReadyTarget } from "./pr-ready.js";
import { fakeTracker, memoryKv, type MemoryKv } from "./testing/fakes.js";

const TARGET: ReadyTarget = { issueKey: "TLSSN-9", repository: "cursor-demo-lab/marsbank", number: 13, mode: "open" };
const OPTS = { sandboxRepo: "cursor-demo-lab/marsbank", sandboxRef: "main", projects: ["TLSSN"] };
const NO_PAUSE = { retryMs: [0, 0], sleep: async () => {} };

type Call = { route: string; params: Record<string, unknown> };

/** Octokit as July's `ctx.github.getOctokit()` returns it: a non-2xx is a thrown error carrying `status`, never `ok: false`. */
function fakeGitHub(options: { draft?: boolean; readStatus?: number; writeStatus?: number | readonly number[]; errors?: unknown[]; throws?: boolean; requireRepoHeader?: boolean } = {}) {
  const calls: Call[] = [];
  let draft = options.draft ?? true;
  let writes = 0;
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
  const github: ReadyApi = {
    getOctokit: async () => ({
      request: async (route: string, params: Record<string, unknown> = {}) => {
        calls.push({ route, params });
        if (options.throws === true) throw new Error("socket hang up");
        if (route.startsWith("GET ")) {
          const status = options.readStatus ?? 200;
          if (status >= 300) throw fail(status, "Not Found");
          return { status, data: { number: 13, draft, node_id: "PR_kwDO13" } };
        }
        const statuses = options.writeStatus;
        const status = (Array.isArray(statuses) ? statuses[writes] : statuses) ?? 200;
        writes += 1;
        const headers = (params["headers"] ?? {}) as Record<string, string>;
        if (options.requireRepoHeader === true && (headers["x-cursor-github-repos"] ?? "") === "") throw fail(400, "Missing x-cursor-github-repos header");
        if (status >= 300) throw fail(status, "Forbidden");
        if (options.errors !== undefined) return { status, data: { errors: options.errors } };
        draft = false;
        return { status, data: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } };
      },
    }),
  };
  return { github, calls, draft: () => draft };
}

async function launchedKv(): Promise<MemoryKv> {
  const kv = memoryKv();
  await recordImplementation(kv, "TLSSN-9", { state: "launched", at: "2026-09-25T00:00:00.000Z", agentId: "bc-9", url: "https://cursor.com/agents/bc-9", commented: true, moved: true });
  return kv;
}

test("Bugbot skips drafts: the worker's draft implement PR is marked ready through GraphQL, once", async () => {
  const gh = fakeGitHub();
  const kv = await launchedKv();
  const deps = { kv, github: gh.github, ...NO_PAUSE };

  assert.deepEqual(await markReadyForReview(deps, TARGET), { outcome: "marked_ready", attempts: 1 });
  assert.equal(gh.draft(), false);
  assert.deepEqual(gh.calls.map((call) => call.route), ["GET /repos/{owner}/{repo}/pulls/{pull_number}", "POST /graphql"]);
  assert.deepEqual(gh.calls[0]?.params, { owner: "cursor-demo-lab", repo: "marsbank", pull_number: 13 });
  assert.match(String(gh.calls[1]?.params["query"]), /markPullRequestReadyForReview/);
  assert.deepEqual(gh.calls[1]?.params["variables"], { id: "PR_kwDO13" });
  assert.equal(kv.entries.has(readyRecordKey(TARGET)), true, "recorded ready");

  assert.equal((await markReadyForReview(deps, TARGET)).outcome, "already_ready", "a redelivery reads the PR and writes nothing");
  assert.equal(gh.calls.filter((call) => call.route === "POST /graphql").length, 1);
});

test("marsbank#28: the GraphQL call carries its repo scope, since hosted github-proxy refuses an unscoped /graphql with 400", async () => {
  const gh = fakeGitHub({ requireRepoHeader: true });
  assert.equal((await markReadyForReview({ kv: await launchedKv(), github: gh.github, ...NO_PAUSE }, { ...TARGET, repository: "Cursor-Demo-Lab/Marsbank" })).outcome, "marked_ready");
  assert.deepEqual(gh.calls[1]?.params["headers"], { "x-cursor-github-repos": "cursor-demo-lab/marsbank" });
});

test("a PR already ready, or one the worker never launched, is not written", async () => {
  const ready = fakeGitHub({ draft: false });
  assert.equal((await markReadyForReview({ kv: await launchedKv(), github: ready.github, ...NO_PAUSE }, TARGET)).outcome, "already_ready");
  assert.deepEqual(ready.calls.map((call) => call.route.split(" ")[0]), ["GET"]);

  const stranger = fakeGitHub();
  assert.deepEqual(await markReadyForReview({ kv: memoryKv(), github: stranger.github, ...NO_PAUSE }, TARGET), { outcome: "not_launched" });
  assert.deepEqual(stranger.calls, []);
});

test("a GitHub read or write that fails is an outcome with its HTTP status, after every in-task try, never a throw", async () => {
  const kv = await launchedKv();
  assert.deepEqual(await markReadyForReview({ kv, github: fakeGitHub({ readStatus: 404 }).github, ...NO_PAUSE }, TARGET), { outcome: "read_failed", attempts: 3, status: 404 });
  assert.deepEqual(await markReadyForReview({ kv, github: fakeGitHub({ writeStatus: 403 }).github, ...NO_PAUSE }, TARGET), { outcome: "write_failed", attempts: 3, status: 403 });
  assert.deepEqual(await markReadyForReview({ kv, github: fakeGitHub({ errors: [{ message: "Resource not accessible by integration" }] }).github, ...NO_PAUSE }, TARGET), { outcome: "write_failed", attempts: 3, status: 200 });
  assert.deepEqual(await markReadyForReview({ kv, github: fakeGitHub({ throws: true }).github, ...NO_PAUSE }, TARGET), { outcome: "read_failed", attempts: 3 });
  assert.equal(kv.entries.has(readyRecordKey(TARGET)), false, "nothing recorded, so the next delivery tries again");
});

test("a write that fails once is retried in the task and lands", async () => {
  const gh = fakeGitHub({ writeStatus: [502, 200] });
  const pauses: number[] = [];
  const result = await markReadyForReview({ kv: await launchedKv(), github: gh.github, retryMs: [7, 9], sleep: async (ms) => void pauses.push(ms) }, TARGET);
  assert.deepEqual(result, { outcome: "marked_ready", attempts: 2 });
  assert.deepEqual(pauses, [7]);
  assert.equal(gh.draft(), false);
});

test("a later push retries a PR the worker never saw ready, and leaves alone one it did or a person drafted", async () => {
  const kv = await launchedKv();
  const retry: ReadyTarget = { ...TARGET, mode: "retry" };
  const first = fakeGitHub();
  assert.equal((await markReadyForReview({ kv, github: first.github, ...NO_PAUSE }, retry)).outcome, "marked_ready", "the opened delivery's write failed; the push lands it");

  const drafted = fakeGitHub();
  assert.equal((await markReadyForReview({ kv, github: drafted.github, ...NO_PAUSE }, retry)).outcome, "recorded");
  assert.deepEqual(drafted.calls, [], "recorded ready: a person who drafts it again keeps it draft");

  const byPerson = await launchedKv();
  assert.equal((await markReadyForReview({ kv: byPerson, github: fakeGitHub().github, ...NO_PAUSE }, { ...TARGET, mode: "person_drafted" })).outcome, "recorded");
  const after = fakeGitHub();
  assert.equal((await markReadyForReview({ kv: byPerson, github: after.github, ...NO_PAUSE }, retry)).outcome, "recorded");
  assert.deepEqual(after.calls, []);
});

test("readyablePullRequest: open actions check, pushes and edits retry, ready_for_review and a person's draft record", () => {
  const pr: PrDelivery = {
    action: "opened",
    repository: "cursor-demo-lab/marsbank",
    number: 13,
    url: "https://github.com/cursor-demo-lab/marsbank/pull/13",
    headRef: "TLSSN-9-csv-export-zero-rows",
    baseRef: "main",
    title: "TLSSN-9: CSV export",
    authorLogin: "cursor[bot]",
    merged: false,
    autoMerge: false,
  };
  const at = (mode: ReadyTarget["mode"]) => ({ ...TARGET, mode });
  assert.deepEqual(readyablePullRequest(pr, OPTS), at("open"));
  assert.deepEqual(readyablePullRequest({ ...pr, action: "reopened", draft: true }, OPTS), { ...at("open"), draft: true });
  assert.equal(readyablePullRequest({ ...pr, draft: false }, OPTS), undefined, "the body says it is already ready");
  assert.deepEqual(readyablePullRequest({ ...pr, action: "synchronize" }, OPTS), at("retry"));
  assert.deepEqual(readyablePullRequest({ ...pr, action: "edited", draft: true }, OPTS), { ...at("retry"), draft: true });
  assert.equal(readyablePullRequest({ ...pr, action: "synchronize", draft: false }, OPTS), undefined);
  assert.deepEqual(readyablePullRequest({ ...pr, action: "ready_for_review" }, OPTS), at("seen_ready"));
  assert.deepEqual(readyablePullRequest({ ...pr, action: "converted_to_draft", sender: { login: "example-user", type: "User" } }, OPTS), at("person_drafted"));
  assert.deepEqual(readyablePullRequest({ ...pr, action: "converted_to_draft", sender: { login: "cursor[bot]", type: "Bot" } }, OPTS), at("open"), "a bot's draft is undrafted again");
  for (const action of ["closed", "labeled", "review_requested"]) assert.equal(readyablePullRequest({ ...pr, action }, OPTS), undefined, action);
  assert.equal(readyablePullRequest({ ...pr, merged: true, action: "closed" }, OPTS), undefined);
  assert.equal(readyablePullRequest({ ...pr, repository: "cursor-demo-lab/other" }, OPTS), undefined);
  assert.equal(readyablePullRequest({ ...pr, baseRef: "release" }, OPTS), undefined);
  assert.equal(readyablePullRequest({ ...pr, headRef: "topic", authorLogin: "example-user" }, OPTS), undefined);
});

test("marsbank#29: an implement PR drafted again after the worker recorded it ready is undrafted again; a person's draft is not", async () => {
  const kv = await launchedKv();
  await kv.put(readyRecordKey(TARGET), { at: "2026-09-26T00:00:00.000Z", state: "ready" });

  const byBot = fakeGitHub();
  const drafted = readyablePullRequest(
    { action: "converted_to_draft", repository: TARGET.repository, number: 13, url: "", headRef: "TLSSN-9-csv", baseRef: "main", title: "TLSSN-9: CSV", authorLogin: "cursor[bot]", merged: false, autoMerge: false, sender: { login: "cursor[bot]", type: "Bot" } },
    OPTS
  )!;
  assert.equal((await markReadyForReview({ kv, github: byBot.github, ...NO_PAUSE }, drafted)).outcome, "marked_ready");
  assert.equal(byBot.draft(), false);

  const pushed = fakeGitHub();
  assert.equal((await markReadyForReview({ kv, github: pushed.github, ...NO_PAUSE }, { ...TARGET, mode: "retry", draft: true })).outcome, "marked_ready", "a push that says draft checks again");
  const quiet = fakeGitHub();
  assert.equal((await markReadyForReview({ kv, github: quiet.github, ...NO_PAUSE }, { ...TARGET, mode: "retry" })).outcome, "recorded");
  assert.deepEqual(quiet.calls, []);

  await kv.put(readyRecordKey(TARGET), { at: "2026-09-26T00:00:00.000Z", state: "person_drafted" });
  const kept = fakeGitHub();
  assert.equal((await markReadyForReview({ kv, github: kept.github, ...NO_PAUSE }, { ...TARGET, mode: "retry", draft: true })).outcome, "recorded");
  assert.deepEqual(kept.calls, []);
});

test("prReadyNote names the PR, the outcome, and the HTTP status, with no raw error text", () => {
  assert.equal(
    prReadyNote({ pr: "cursor-demo-lab/marsbank#28", result: { outcome: "write_failed", attempts: 3, status: 400 } }),
    "Ready for review not marked on cursor-demo-lab/marsbank#28: the worker could not undraft it (write_failed, HTTP 400), so Bugbot has not reviewed it. The pull request's next push retries; if it stays a draft, mark it ready on GitHub."
  );
  assert.doesNotMatch(prReadyNote({ pr: "o/r#1", result: { outcome: "failed" } }), /HTTP/);
});

// Hosted host.kv (July 0.2.13) has no compare-and-set, so only this test reaches noteNotReady's putIfAbsent branch.
describe("CAS path (ask 11)", () => {
  test("noteNotReady claims its note with putIfAbsent: one note per pull request", async () => {
    const tracker = fakeTracker({ status: "In Review" });
    const deps = { kv: memoryKv({ cas: true }), mcp: tracker.mcp, now: () => new Date("2026-09-25T00:00:00.000Z") };
    const input = { issueKey: "TLSSN-9", pr: "cursor-demo-lab/marsbank#13", target: TARGET, result: { outcome: "write_failed" as const, attempts: 3, status: 400 } };
    assert.equal(await noteNotReady(deps, input), "written");
    assert.equal(await noteNotReady(deps, input), "duplicate");
    assert.deepEqual(tracker.comments, [prReadyNote(input)]);
  });
});

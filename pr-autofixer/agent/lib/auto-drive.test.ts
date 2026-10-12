import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { HostKvApi } from "@cursor/july";
import {
  autoDriveBrief,
  ADMISSION_PAUSE_CAP_MS,
  AUTO_DRIVE_PROJECTS_ENV,
  CLAIM_RETRY_MS,
  CLAIM_SETTLE_MS,
  DRIVE_LEASE_MS,
  SETTLE_RETRY_MS,
  START_LEASE_MS,
  START_RETRY_MS,
  TASK_PAUSE_BUDGET_MS,
  claimSettleMs,
  recordBugbotRound,
  autoDriveDecision,
  autoDriveKey,
  autoDriveProjects,
  claimAutoDrive,
  fetchPrHead,
  releaseAutoDrive,
  releaseAutoDriveForSession,
  stampAutoDriveSession,
  startAutoDrive,
} from "./auto-drive.js";
import { CURSOR_BOT } from "./factory-pr-key.js";

// Every claim below settles, for 1 ms so the file runs in seconds. The 2 s
// default, its pause totals and the kill switch pass their own env.
process.env.FACTORY_FIXER_CLAIM_SETTLE_MS = "1";

// host.kv has only get, put and delete on every backend, so every store here
// is plain. The shared helpers' own contracts are in factory-desk's
// kv-verified.test.ts and claim-lease.test.ts.
function plainKv(store: Map<string, unknown>): HostKvApi {
  return {
    get: async (key) => structuredClone(store.get(key)) as never,
    put: async (key, value) => { store.set(key, structuredClone(value)); },
    delete: async (key) => { store.delete(key); },
  };
}

type Hooks = {
  beforeGet?: (n: number) => Promise<void> | void;
  afterGet?: (n: number) => Promise<void> | void;
  beforePut?: (n: number) => Promise<void> | void;
  afterPut?: (n: number) => Promise<void> | void;
  beforeDelete?: (n: number) => Promise<void> | void;
  afterDelete?: (n: number) => Promise<void> | void;
};

/** The same store seen through a caller whose operations can fail or let another writer in. */
function through(kv: HostKvApi, hooks: Hooks): HostKvApi {
  const count = { get: 0, put: 0, delete: 0 };
  return {
    get: async (key) => {
      const n = count.get++;
      await hooks.beforeGet?.(n);
      const value = await kv.get(key);
      await hooks.afterGet?.(n);
      return value;
    },
    put: async (key, value) => {
      const n = count.put++;
      await hooks.beforePut?.(n);
      await kv.put(key, value);
      await hooks.afterPut?.(n);
    },
    delete: async (key) => {
      const n = count.delete++;
      await hooks.beforeDelete?.(n);
      await kv.delete(key);
      await hooks.afterDelete?.(n);
    },
  };
}

/** A store whose next `n` reads fail, as often as the test re-arms it. */
function outage(store: Map<string, unknown>) {
  let failing = 0;
  let always = false;
  const kv = through(plainKv(store), { beforeGet: () => { if (always || failing > 0) { failing -= 1; throw new Error("kv unavailable"); } } });
  return { kv, fail: (n: number) => { failing = n; }, down: (on: boolean) => { always = on; } };
}

/** Enough failed reads to defeat one pass of a verified helper (VERIFY_ATTEMPTS). */
const ONE_PASS = 3;
const FAST = [0, 0] as const;
const FAST_START = { start: FAST, settle: FAST };

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait: () => opened };
}

function started() {
  return { ok: true, pr: "example/sandbox#8", sessionId: null, continuationToken: null, bcId: null, agentUrl: null, status: "started", result: null, mergeConflictReminderId: null } as const;
}

const PR30 = { owner: "example", repo: "sandbox", number: 30, url: "https://github.com/example/sandbox/pull/30", label: "example/sandbox#30" } as never;
const KEY30 = autoDriveKey(PR30);

const held = (claim: unknown): claim is string => typeof claim === "string" && claim.length > 0;
const claimAt = (store: Map<string, unknown>, pr: unknown) => store.get(autoDriveKey(pr as never)) as Record<string, unknown> | undefined;
const lease = (owner: string, at: string) => ({ state: "pending", owner, at });
const silence = (t: TestContext) => t.mock.method(console, "error", () => {});
const loudLines = (mock: ReturnType<typeof silence>) => mock.mock.calls.map((call) => String(call.arguments[0]));

// The channel hands this promise back to the host as the delivery's task, so
// the delivery window stays open until the start has answered. A floating
// promise would let a hosted pod recycle mid-start and leave the claim with no
// drive for START_LEASE_MS.
test("the automatic start resolves only after the start answers, and marks the lease started", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const pr = { owner: "example", repo: "sandbox", number: 8, url: "https://github.com/example/sandbox/pull/8", label: "example/sandbox#8" };
  const claim = await claimAutoDrive(kv, pr as never, "2026-09-22T00:00:00.000Z");
  assert.ok(held(claim));
  let answer: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { answer = resolve; });
  let calls = 0;
  let settled = false;
  const run = startAutoDrive({
    start: async () => { calls += 1; await pending; return started(); },
    kv,
    pr: pr as never,
    claim,
  }).then(() => { settled = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  answer?.();
  await run;
  assert.equal(settled, true);
  assert.equal(calls, 1);
  assert.deepEqual([claimAt(store, pr)?.["state"], claimAt(store, pr)?.["owner"], claimAt(store, pr)?.["started"]], ["pending", claim, true]);
});

test("a start that is refused releases the lease, so the next red check takes it at once", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const pr = { owner: "example", repo: "sandbox", number: 9, url: "https://github.com/example/sandbox/pull/9", label: "example/sandbox#9" };
  const at = "2026-09-22T00:00:00.000Z";
  const refusals = [
    async () => ({ ok: false, code: "out_of_scope", error: "no" }) as const,
    async () => ({ ...started(), status: "finished" }) as const,
  ];
  for (const start of refusals) {
    const claim = await claimAutoDrive(kv, pr as never, at);
    assert.ok(held(claim));
    let calls = 0;
    await startAutoDrive({ start: () => { calls += 1; return start(); }, kv, pr: pr as never, claim, retryMs: FAST_START });
    assert.equal(calls, 1, "a refusal is an answer, not a transient failure");
    assert.equal(claimAt(store, pr), undefined);
  }
  assert.equal(await stampAutoDriveSession(kv, pr as never, "ses_late"), "lost");
  assert.equal(claimAt(store, pr), undefined);
  assert.equal(store.has("drive-session/ses_late"), false);
  assert.ok(held(await claimAutoDrive(kv, pr as never, at)));
});

test("the claim is taken once per pull request; a lease past its time, or a value that is no lease, is retaken", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const pr = { owner: "example-org", repo: "demo-repo", number: 12, url: "https://github.com/example-org/demo-repo/pull/12", label: "example-org/demo-repo#12" };
  const key = autoDriveKey(pr as never);
  const first = await claimAutoDrive(kv, pr as never, "2026-09-22T00:00:00.000Z");
  assert.ok(held(first));
  assert.equal(await claimAutoDrive(kv, pr as never, "2026-09-22T00:00:01.000Z"), undefined);
  assert.deepEqual(claimAt(store, pr), lease(first, "2026-09-22T00:00:00.000Z"));

  const later = new Date(Date.parse("2026-09-22T00:00:00.000Z") + START_LEASE_MS + 1).toISOString();
  const retaken = await claimAutoDrive(kv, pr as never, later);
  assert.ok(held(retaken));
  assert.notEqual(retaken, first);
  assert.deepEqual(claimAt(store, pr), lease(retaken, later));
  await releaseAutoDrive(kv, pr as never);
  assert.equal(store.has(key), false);
  assert.ok(held(await claimAutoDrive(kv, pr as never, later)));

  // A lease whose time cannot be read is expired, not a lock that holds the PR red forever.
  store.set(key, { state: "pending", owner: "someone", at: "not a date" });
  assert.ok(held(await claimAutoDrive(kv, pr as never, later)));
  // A claim written before leases, however fresh, and garbage are no lease: retaken at once.
  for (const legacy of [{ at: later, token: "pre-lease" }, { at: later, token: "pre-lease", started: true, sessionId: "ses_old" }, { at: "1970-01-01T00:00:00.000Z", released: true, token: "pre-lease" }, "garbage", { state: "done", owner: "x", at: later }]) {
    store.set(key, legacy);
    const taken = await claimAutoDrive(kv, pr as never, later);
    assert.ok(held(taken), JSON.stringify(legacy));
    assert.deepEqual(claimAt(store, pr), lease(taken, later));
  }
});

test("the lease and retry constants: ten minutes to start, two hours to drive, retries inside the windows they must fit", () => {
  assert.equal(START_LEASE_MS, 10 * 60 * 1000);
  assert.equal(DRIVE_LEASE_MS, 2 * 60 * 60 * 1000);
  assert.deepEqual(CLAIM_RETRY_MS, [250, 1000]);
  assert.deepEqual(START_RETRY_MS, [1000, 4000]);
  assert.deepEqual(SETTLE_RETRY_MS, [500, 2000, 5000]);
  const total = (pauses: readonly number[]) => pauses.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total(CLAIM_RETRY_MS) < 10_000, "the claim's pauses stay well inside hosted admission's undocumented time budget");
  assert.ok(total(START_RETRY_MS) + 2 * total(SETTLE_RETRY_MS) < START_LEASE_MS / 10);
});

test("an unmarked claim holds for the start window; a started lease holds past it and is retaken after two hours", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const pr = { owner: "example", repo: "sandbox", number: 21, url: "https://github.com/example/sandbox/pull/21", label: "example/sandbox#21" };
  const claim = await claimAutoDrive(kv, pr as never, new Date(Date.now() - START_LEASE_MS * 2).toISOString());
  assert.ok(held(claim));
  await startAutoDrive({ start: async () => started(), kv, pr: pr as never, claim });
  const startedAt = Date.parse(claimAt(store, pr)?.["at"] as string);
  assert.ok(Math.abs(startedAt - Date.now()) < 60_000, "the mark restarts the lease from the start");
  const after = (ms: number) => new Date(startedAt + ms).toISOString();
  assert.equal(await claimAutoDrive(kv, pr as never, after(START_LEASE_MS + 60_000)), undefined);
  assert.equal(await claimAutoDrive(kv, pr as never, after(DRIVE_LEASE_MS - 60_000)), undefined);
  const retaken = await claimAutoDrive(kv, pr as never, after(DRIVE_LEASE_MS));
  assert.ok(held(retaken));
  assert.deepEqual(claimAt(store, pr), lease(retaken, after(DRIVE_LEASE_MS)));

  const unstarted = { ...pr, number: 22, url: "https://github.com/example/sandbox/pull/22", label: "example/sandbox#22" };
  assert.ok(held(await claimAutoDrive(kv, unstarted as never, "2026-09-22T00:00:00.000Z")));
  assert.equal(await claimAutoDrive(kv, unstarted as never, new Date(Date.parse("2026-09-22T00:00:00.000Z") + START_LEASE_MS - 1000).toISOString()), undefined);
  assert.ok(held(await claimAutoDrive(kv, unstarted as never, new Date(Date.parse("2026-09-22T00:00:00.000Z") + START_LEASE_MS).toISOString())));
});

test("the first turn stamps an unstamped lease, never one another session owns, and a late start keeps the stamp", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const pr = { owner: "example", repo: "sandbox", number: 23, url: "https://github.com/example/sandbox/pull/23", label: "example/sandbox#23" };
  const claim = await claimAutoDrive(kv, pr as never, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  assert.equal(await stampAutoDriveSession(kv, pr as never, "ses_first"), "written");
  assert.equal(await stampAutoDriveSession(kv, pr as never, "ses_second"), "lost");
  const stamped = claimAt(store, pr);
  assert.deepEqual({ ...stamped, at: undefined }, { state: "pending", owner: claim, at: undefined, started: true, sessionId: "ses_first" });
  assert.notEqual(stamped?.["at"], "2026-09-23T00:00:00.000Z", "the first turn restarts the lease as a started drive");
  assert.deepEqual(store.get("drive-session/ses_first"), { pr: "example/sandbox#23", token: claim });
  assert.equal(store.has("drive-session/ses_second"), false);

  await startAutoDrive({ start: async () => started(), kv, pr: pr as never, claim });
  assert.deepEqual([claimAt(store, pr)?.["started"], claimAt(store, pr)?.["sessionId"]], [true, "ses_first"]);

  assert.equal(await releaseAutoDriveForSession(kv, "ses_second"), "lost");
  assert.equal(await claimAutoDrive(kv, pr as never, new Date().toISOString()), undefined);
  assert.equal(await releaseAutoDriveForSession(kv, "ses_first"), "written");
  assert.equal(claimAt(store, pr), undefined);
  assert.equal(store.has("drive-session/ses_first"), false);
  assert.ok(held(await claimAutoDrive(kv, pr as never, "2026-09-23T00:00:01.000Z")));
});

test("a session whose record names another session's lease cannot release it", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  assert.equal(await stampAutoDriveSession(kv, PR30, "ses_owner"), "written");
  store.set("drive-session/ses_other", { pr: "example/sandbox#30", token: claim });
  assert.equal(await releaseAutoDriveForSession(kv, "ses_other"), "lost");
  assert.equal(claimAt(store, PR30)?.["sessionId"], "ses_owner");
  store.set("drive-session/ses_tokenless", { pr: "example/sandbox#30" });
  assert.equal(await releaseAutoDriveForSession(kv, "ses_tokenless"), "lost");
  assert.equal(claimAt(store, PR30)?.["sessionId"], "ses_owner");
});

test("projects come from the override, then FACTORY_JIRA_PROJECTS; an empty list disables the automatic drive", () => {
  assert.deepEqual(autoDriveProjects({}), []);
  assert.deepEqual(autoDriveProjects({ FACTORY_JIRA_PROJECTS: "tlssn" }), ["TLSSN"]);
  assert.deepEqual(autoDriveProjects({ [AUTO_DRIVE_PROJECTS_ENV]: "tlssn, demo", FACTORY_JIRA_PROJECTS: "other" }), ["TLSSN", "DEMO"]);
  assert.deepEqual(autoDriveProjects({ [AUTO_DRIVE_PROJECTS_ENV]: "", FACTORY_JIRA_PROJECTS: "TLSSN" }), []);
});

test("a red check on a factory branch, or on a cursor[bot] PR with a factory title, drives; anything else does not", () => {
  const projects = ["TLSSN"];
  assert.deepEqual(autoDriveDecision({ eventName: "check_run", headRefName: "TLSSN-42-retry-csv-export", title: "Retry export", projects }), { drive: true, issueKey: "TLSSN-42", trigger: "red_check" });
  assert.deepEqual(autoDriveDecision({ eventName: "status", headRefName: "cursor/fix-x", title: "TLSSN-7: fix", authorLogin: CURSOR_BOT, projects }), { drive: true, issueKey: "TLSSN-7", trigger: "red_check" });
  // The same rule as factory-worker's implementPrKey: a person's keyed title
  // moves no ticket there and hands the fixer no push access here.
  assert.deepEqual(autoDriveDecision({ eventName: "status", headRefName: "feature/x", title: "TLSSN-7: fix", authorLogin: "example-user", projects }), { drive: false, reason: "title_only_from_person" });
  assert.deepEqual(autoDriveDecision({ eventName: "status", headRefName: "feature/x", title: "TLSSN-7: fix", projects }), { drive: false, reason: "title_only_from_person" });
  assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion: "failure", headRefName: "feature/x", title: "TLSSN-7: fix", authorLogin: "Cursor[bot]", projects }), { drive: false, reason: "title_only_from_person" });
  // A person's branch that starts with the key still counts, as it does for the worker.
  assert.deepEqual(autoDriveDecision({ eventName: "check_run", headRefName: "TLSSN-42-hand-named", title: "Hand named", authorLogin: "example-user", projects }), { drive: true, issueKey: "TLSSN-42", trigger: "red_check" });
  assert.deepEqual(autoDriveDecision({ eventName: "check_run", headRefName: "fix-typo", title: "Fix typo", projects }), { drive: false, reason: "not_a_factory_pr" });
  assert.deepEqual(autoDriveDecision({ eventName: "check_run", headRefName: "OPS-1-thing", title: "OPS-1", projects }), { drive: false, reason: "not_a_factory_pr" });
  assert.deepEqual(autoDriveDecision({ eventName: "pull_request", headRefName: "TLSSN-42-x", title: "x", projects }), { drive: false, reason: "not_a_failure_event" });
  assert.deepEqual(autoDriveDecision({ eventName: "check_suite", headRefName: "TLSSN-42-x", title: "x", projects }), { drive: false, reason: "not_a_failure_event" });
  for (const conclusion of ["failure", "timed_out", "action_required", "startup_failure"]) {
    assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion, headRefName: "TLSSN-3-x", title: "x", projects }), { drive: true, issueKey: "TLSSN-3", trigger: "red_check" });
    assert.deepEqual(autoDriveDecision({ eventName: "workflow_run", conclusion, headRefName: "TLSSN-3-x", title: "x", projects }), { drive: true, issueKey: "TLSSN-3", trigger: "red_check" });
  }
  for (const conclusion of ["success", "neutral", "cancelled", "skipped"]) {
    assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion, headRefName: "TLSSN-3-x", title: "x", projects }), { drive: false, reason: "not_a_failure_event" });
    assert.deepEqual(autoDriveDecision({ eventName: "workflow_run", conclusion, headRefName: "TLSSN-3-x", title: "x", projects }), { drive: false, reason: "not_a_failure_event" });
  }
  assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion: "failure", headRefName: "fix-typo", title: "Fix typo", projects }), { drive: false, reason: "not_a_factory_pr" });
  assert.deepEqual(autoDriveDecision({ eventName: "check_run", headRefName: "TLSSN-42-x", title: "x", projects: [] }), { drive: false, reason: "disabled" });
  assert.deepEqual(autoDriveDecision({ eventName: "check_run", headRefName: undefined, title: undefined, projects }), { drive: false, reason: "not_a_factory_pr" });
});

// Hosted github-proxy takes the repo scope from the request URL; POST /graphql
// has none and is refused with 400, so the factory-PR test must read over REST.
test("fetchPrHead reads branch, title, and author through a proxy that refuses unscoped GraphQL", async () => {
  let author: { login: string } | undefined = { login: "example-user" };
  const octokit = {
    graphql: async () => { throw Object.assign(new Error("Missing x-cursor-github-repos header"), { status: 400 }); },
    request: async (route: string, params: Record<string, unknown>) => {
      assert.equal(route, "GET /repos/{owner}/{repo}/pulls/{pull_number}");
      assert.deepEqual(params, { owner: "cursor-demo-lab", repo: "marsbank", pull_number: 8 });
      return { data: { head: { ref: "factory-verify-fixer-20260923" }, title: "TLSSN-3: factory verify fixer, subtractTokens red check", user: author } };
    },
  };
  const github = { getOctokit: async () => octokit } as never;
  const pr = { owner: "cursor-demo-lab", repo: "marsbank", number: 8, url: "https://github.com/cursor-demo-lab/marsbank/pull/8", label: "cursor-demo-lab/marsbank#8" };
  // marsbank #8 was opened by a person with the key only in its title: a
  // hand-made verification PR, which now needs `factory: drive` like any other.
  const byPerson = await fetchPrHead({ github, pr });
  assert.deepEqual(byPerson, { headRefName: "factory-verify-fixer-20260923", title: "TLSSN-3: factory verify fixer, subtractTokens red check", authorLogin: "example-user" });
  assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion: "failure", ...byPerson, projects: ["TLSSN"] }), { drive: false, reason: "title_only_from_person" });
  author = { login: CURSOR_BOT };
  const byBot = await fetchPrHead({ github, pr });
  assert.equal(byBot.authorLogin, CURSOR_BOT);
  assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion: "failure", ...byBot, projects: ["TLSSN"] }), { drive: true, issueKey: "TLSSN-3", trigger: "red_check" });
  // A body without a user (a proxy that trims it) reads as no author, never as the bot.
  author = undefined;
  assert.deepEqual(await fetchPrHead({ github, pr }), { headRefName: "factory-verify-fixer-20260923", title: "TLSSN-3: factory verify fixer, subtractTokens red check" });
});

// Round-2 finding 3: the read used to answer {} on any error, which
// autoDriveDecision reads as not_a_factory_pr, so a proxy hiccup on a real
// factory PR's red check skipped its drive with no log and no redelivery.
function flakyGithub(failures: number) {
  let calls = 0;
  const octokit = {
    request: async () => {
      calls += 1;
      if (calls <= failures) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      return { data: { head: { ref: "TLSSN-3-fix-rounding" }, title: "Fix rounding", user: { login: CURSOR_BOT } } };
    },
  };
  return { github: { getOctokit: async () => octokit } as never, calls: () => calls };
}

test("fetchPrHead retries a read that fails, and returns the head once GitHub answers", async (t) => {
  const errors = silence(t);
  const flaky = flakyGithub(2);
  assert.deepEqual(await fetchPrHead({ github: flaky.github, pr: PR30, retryMs: FAST }), { headRefName: "TLSSN-3-fix-rounding", title: "Fix rounding", authorLogin: CURSOR_BOT });
  assert.equal(flaky.calls(), 3);
  assert.equal(errors.mock.callCount(), 0);
});

test("fetchPrHead fails loudly when every read fails, instead of passing for a PR that is not the factory's", async (t) => {
  const errors = silence(t);
  const down = flakyGithub(Number.POSITIVE_INFINITY);
  await assert.rejects(
    fetchPrHead({ github: down.github, pr: PR30, retryMs: FAST }),
    /could not read example\/sandbox#30 from GitHub after 3 tries \(Bad Gateway\); its red check was not judged, so no drive started/,
  );
  assert.equal(down.calls(), 3);
  assert.deepEqual(loudLines(errors), ["[pr-autofixer] auto-drive: could not read example/sandbox#30 from GitHub after 3 tries (Bad Gateway); its red check was not judged, so no drive started"]);
  const unreachable = { getOctokit: async () => { throw new Error("github client unavailable"); } } as never;
  await assert.rejects(fetchPrHead({ github: unreachable, pr: PR30, retryMs: FAST }), /\(github client unavailable\)/);
  assert.deepEqual(CLAIM_RETRY_MS, [250, 1000], "the read runs before the handler answers, inside the claim's pauses");
});

test("a human PR whose branch or title merely mentions a ticket key is not auto-driven", () => {
  const projects = ["TLSSN"];
  for (const [headRefName, title] of [
    ["fix-typo", "Fix after TLSSN-12 regression"],
    ["feature/TLSSN-12", "Retry export"],
    ["revert-TLSSN-12-export", "Revert \"TLSSN-12: export\""],
    ["OPS-TLSSN-3", "[WIP] TLSSN-3 follow-up"],
  ] as const) {
    for (const eventName of ["check_run", "status"]) {
      assert.deepEqual(autoDriveDecision({ eventName, headRefName, title, projects }), { drive: false, reason: "not_a_factory_pr" }, `${headRefName} / ${title}`);
    }
    assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion: "failure", headRefName, title, projects }), { drive: false, reason: "not_a_factory_pr" });
  }
});

// Fault-matrix cells for the claim. Each names the column it covers.

test("concurrent openers: a red check_suite and workflow_run that both read the claim empty yield one drive", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const bRead = gate();
  const aPut = gate();
  const bPut = gate();
  // Each claim reads once before its lease write (get 0), then takeLease reads (get 1) and reads back (get 2).
  const a = through(kv, { beforePut: () => bRead.wait(), afterPut: (n) => { if (n === 0) aPut.open(); }, beforeGet: async (n) => { if (n === 2) await bPut.wait(); } });
  const b = through(kv, { beforePut: async (n) => { bRead.open(); if (n === 0) await aPut.wait(); }, afterPut: (n) => { if (n === 0) bPut.open(); } });
  const at = "2026-09-23T00:00:00.000Z";
  const claims = await Promise.all([claimAutoDrive(a, PR30, at), claimAutoDrive(b, PR30, at)]);
  assert.equal(claims.filter(held).length, 1);
  assert.equal((store.get(KEY30) as { owner?: unknown }).owner, claims.find(held));
});

test("ambiguous write: a claim write that lands but reports an error still holds the claim and drives", async () => {
  const store = new Map<string, unknown>();
  let flaky = true;
  const kv = through(plainKv(store), { afterPut: () => { if (flaky) { flaky = false; throw new Error("kv timeout after write"); } } });
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  assert.deepEqual(store.get(KEY30), lease(claim, "2026-09-23T00:00:00.000Z"));
  assert.equal(await claimAutoDrive(kv, PR30, "2026-09-23T00:09:00.000Z"), undefined);
});

test("read outage: an unreadable claim fails the delivery loudly; a mark or release during the outage changes nothing until reads return", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const { kv, down } = outage(store);
  down(true);
  await assert.rejects(claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z", FAST), /unavailable/);
  assert.equal(store.has(KEY30), false);
  assert.match(loudLines(errors).join("\n"), /unavailable claiming example\/sandbox#30/);
  assert.equal(errors.mock.callCount(), 1);

  down(false);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  down(true);
  await startAutoDrive({ start: async () => started(), kv, pr: PR30, claim, retryMs: FAST_START });
  assert.deepEqual(store.get(KEY30), lease(claim, "2026-09-23T00:00:00.000Z"));
  assert.match(loudLines(errors).join("\n"), /marking example\/sandbox#30 started/);

  down(false);
  await stampAutoDriveSession(kv, PR30, "ses_outage");
  down(true);
  assert.equal(await releaseAutoDriveForSession(kv, "ses_outage", FAST), "unavailable");
  assert.equal((store.get(KEY30) as { sessionId?: string }).sessionId, "ses_outage");
  assert.equal(store.has("drive-session/ses_outage"), true);
  down(false);
  assert.equal(await releaseAutoDriveForSession(kv, "ses_outage"), "written");
  assert.equal(store.has(KEY30), false);
});

test("read outage: a release that reads its session record but not the claim keeps the record for a retry", async (t) => {
  silence(t);
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  await stampAutoDriveSession(kv, PR30, "ses_half");
  const claimDown = through(kv, { beforeGet: (n) => { if (n >= 1) throw new Error("kv unavailable"); } });
  assert.equal(await releaseAutoDriveForSession(claimDown, "ses_half", FAST), "unavailable");
  assert.equal(store.has("drive-session/ses_half"), true);
  assert.equal((store.get(KEY30) as { sessionId?: string }).sessionId, "ses_half");
  assert.equal(await releaseAutoDriveForSession(kv, "ses_half"), "written");
  assert.equal(store.has(KEY30), false);
});

test("reordered: a start that answers after its claim was retaken leaves the retaken claim as it was", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  const retakeAt = new Date(Date.parse("2026-09-23T00:00:00.000Z") + START_LEASE_MS).toISOString();
  let retaken: string | undefined;
  await startAutoDrive({ start: async () => { retaken = await claimAutoDrive(kv, PR30, retakeAt); return started(); }, kv, pr: PR30, claim });
  assert.ok(held(retaken));
  assert.deepEqual(store.get(KEY30), lease(retaken, retakeAt));
});

test("reordered: a stamp overwritten by the start's mark before the mark's read-back is merged back", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  const racing = through(kv, { afterPut: async (n) => { if (n === 0) await stampAutoDriveSession(kv, PR30, "ses_local"); } });
  await startAutoDrive({ start: async () => started(), kv: racing, pr: PR30, claim });
  assert.deepEqual([(store.get(KEY30) as { started?: boolean }).started, (store.get(KEY30) as { sessionId?: string }).sessionId], [true, "ses_local"]);
});

test("reordered: a refused start leaves a claim retaken while it was in flight", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  const retakeAt = new Date(Date.parse("2026-09-23T00:00:00.000Z") + START_LEASE_MS).toISOString();
  let retaken: string | undefined;
  await startAutoDrive({
    start: async () => { retaken = await claimAutoDrive(kv, PR30, retakeAt); return { ok: false, code: "out_of_scope", error: "slow refusal" }; },
    kv,
    pr: PR30,
    claim,
  });
  assert.ok(held(retaken));
  assert.deepEqual(store.get(KEY30), lease(retaken, retakeAt));
});

test("reordered: a stamp that loses to a retake leaves the retaken claim unstamped", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  const retakeAt = new Date(Date.parse("2026-09-23T00:00:00.000Z") + START_LEASE_MS).toISOString();
  let retaken: string | undefined;
  const racing = through(kv, { afterGet: async (n) => { if (n === 0) retaken = await claimAutoDrive(kv, PR30, retakeAt); } });
  assert.equal(await stampAutoDriveSession(racing, PR30, "ses_stale"), "lost");
  assert.deepEqual(store.get(KEY30), lease(retaken as string, retakeAt));
});

// The release finds the PR through drive-session/<sid>, so a stamped claim
// without that record could never be released by its session's failure.
test("ambiguous write: a stamp whose session record cannot be written leaves the claim unstamped, loudly", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  const recordDown: HostKvApi = { ...kv, put: async (key, value) => { if (key.startsWith("drive-session/")) throw new Error("kv refused"); await kv.put(key, value); } };
  assert.equal(await stampAutoDriveSession(recordDown, PR30, "ses_norecord", FAST), "unavailable");
  assert.equal(store.has("drive-session/ses_norecord"), false);
  assert.deepEqual(store.get(KEY30), lease(claim, "2026-09-23T00:00:00.000Z"));
  assert.match(loudLines(errors).join("\n"), /recording ses_norecord/);
});

test("reordered: a drive that fails, or a PR that closes, before its start answers stays released", async () => {
  const releases = [
    ["a failed drive", async (kv: HostKvApi) => {
      await stampAutoDriveSession(kv, PR30, "ses_fast");
      await releaseAutoDriveForSession(kv, "ses_fast");
    }],
    ["a close", async (kv: HostKvApi) => {
      await releaseAutoDrive(kv, PR30);
    }],
  ] as const;
  for (const [label, release] of releases) {
    const store = new Map<string, unknown>();
    const kv = plainKv(store);
    const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
    assert.ok(held(claim));
    await startAutoDrive({ start: async () => { await release(kv); return started(); }, kv, pr: PR30, claim });
    assert.equal(store.has(KEY30), false, label);
    assert.ok(held(await claimAutoDrive(kv, PR30, "2026-09-23T00:00:01.000Z")), label);
  }
});

test("concurrent openers: a retake whose write lands after the release's delete keeps its claim", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  await stampAutoDriveSession(kv, PR30, "ses_old");
  let retaken: string | undefined;
  const racing = through(kv, { afterDelete: async (n) => { if (n === 0) retaken = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:01.000Z"); } });
  assert.equal(await releaseAutoDriveForSession(racing, "ses_old"), "written");
  assert.ok(held(retaken));
  assert.deepEqual(store.get(KEY30), lease(retaken, "2026-09-23T00:00:01.000Z"));
  assert.equal(store.has("drive-session/ses_old"), false);
});

// Residual window: a stamp that lands and reads itself back between the
// mark's read and its put is overwritten, since neither read-back sees the
// other. The session record still names the lease's owner, so that session's
// failure still releases it.
test("concurrent openers (residual window): a stamp landing between the mark's read and put is overwritten, and its release still lands", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  const racing = through(kv, { beforePut: async (n) => { if (n === 0) assert.equal(await stampAutoDriveSession(kv, PR30, "ses_between"), "written"); } });
  await startAutoDrive({ start: async () => started(), kv: racing, pr: PR30, claim });
  assert.deepEqual([claimAt(store, PR30)?.["started"], claimAt(store, PR30)?.["sessionId"]], [true, undefined]);
  assert.equal(await releaseAutoDriveForSession(kv, "ses_between"), "written");
  assert.equal(store.has(KEY30), false);
  assert.ok(held(await claimAutoDrive(kv, PR30, "2026-09-23T00:00:01.000Z")));
});

// Residual window, pinned so a change to it is visible: host.kv has no
// conditional write, so a retake landing between the release's read and its
// delete is removed with the old lease.
test("concurrent openers (residual window): a retake landing between the release's read and delete is removed", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  await stampAutoDriveSession(kv, PR30, "ses_old");
  const retakeAt = new Date(Date.now() + DRIVE_LEASE_MS + 60_000).toISOString();
  let retaken: string | undefined;
  const racing = through(kv, { afterGet: async (n) => { if (n === 1) retaken = await claimAutoDrive(kv, PR30, retakeAt); } });
  assert.equal(await releaseAutoDriveForSession(racing, "ses_old"), "written");
  assert.ok(held(retaken));
  assert.equal(store.has(KEY30), false);
});

test("replayed: a release replayed after the release, or after a retake, changes nothing", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  await stampAutoDriveSession(kv, PR30, "ses_a");
  assert.equal(await releaseAutoDriveForSession(kv, "ses_a"), "written");
  assert.equal(await releaseAutoDriveForSession(kv, "ses_a"), "lost");
  assert.equal(store.has(KEY30), false);
  assert.equal(await stampAutoDriveSession(kv, PR30, "ses_late"), "lost");
  assert.equal(store.has(KEY30), false);

  const retaken = await claimAutoDrive(kv, PR30, "2026-09-23T00:05:00.000Z");
  assert.ok(held(retaken));
  store.set("drive-session/ses_a", { pr: "example/sandbox#30", token: claim });
  assert.equal(await releaseAutoDriveForSession(kv, "ses_a"), "lost");
  assert.deepEqual(store.get(KEY30), lease(retaken, "2026-09-23T00:05:00.000Z"));
});

test("key absent: a stamp, a session release and a close on a PR with no claim write nothing", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  assert.equal(await stampAutoDriveSession(kv, PR30, "ses_none"), "lost");
  assert.equal(await releaseAutoDriveForSession(kv, "ses_none"), "lost");
  await releaseAutoDrive(kv, PR30);
  assert.deepEqual([...store.keys()], []);
});

// No claim can block forever: land the claim, fail the verify read,
// redeliver. Nothing before the lease runs out, exactly one more drive
// after, and none once that drive has started.
async function redeliveries(store: Map<string, unknown>, since: string, leaseMs: number) {
  const kv = plainKv(store);
  let drives = 0;
  const deliver = async (at: string) => {
    const claim = await claimAutoDrive(kv, PR30, at);
    if (claim === undefined) return;
    await startAutoDrive({ start: async () => { drives += 1; return started(); }, kv, pr: PR30, claim });
  };
  const from = Date.parse(since);
  await deliver(new Date(from + leaseMs - 1000).toISOString());
  assert.equal(drives, 0, "redelivered inside the lease");
  await deliver(new Date(from + leaseMs).toISOString());
  assert.equal(drives, 1, "redelivered after the lease");
  await deliver(new Date(Date.now() + 1000).toISOString());
  assert.equal(drives, 1, "redelivered after the drive started");
}

test("no claim blocks forever: the claim lands, its read-back fails, and a redelivery after the start lease drives once", async (t) => {
  silence(t);
  const store = new Map<string, unknown>();
  let putDone = false;
  const kv = through(plainKv(store), { afterPut: () => { putDone = true; }, beforeGet: () => { if (putDone) throw new Error("kv unavailable"); } });
  const at = "2026-09-23T00:00:00.000Z";
  await assert.rejects(claimAutoDrive(kv, PR30, at, FAST), /unavailable/);
  assert.equal(pendingOwner(store), true, "the claim landed");
  await redeliveries(store, at, START_LEASE_MS);
});

test("no claim blocks forever: a start whose mark cannot be verified is loud once, lapses after the start lease, then drives once", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const { kv, down } = outage(store);
  const at = "2026-09-23T00:00:00.000Z";
  const claim = await claimAutoDrive(kv, PR30, at);
  assert.ok(held(claim));
  await startAutoDrive({ start: async () => { down(true); return started(); }, kv, pr: PR30, claim, retryMs: FAST_START });
  assert.equal(errors.mock.callCount(), 1);
  assert.match(loudLines(errors)[0] ?? "", /marking example\/sandbox#30 started/);
  down(false);
  assert.equal(claimAt(store, PR30)?.["started"], undefined);
  await redeliveries(store, at, START_LEASE_MS);
});

test("no claim blocks forever: a refused start whose release cannot be verified lapses after the start lease, then drives once", async (t) => {
  silence(t);
  const store = new Map<string, unknown>();
  const { kv, down } = outage(store);
  const at = "2026-09-23T00:00:00.000Z";
  const claim = await claimAutoDrive(kv, PR30, at);
  assert.ok(held(claim));
  await assert.rejects(startAutoDrive({ start: async () => { down(true); return { ok: false, code: "out_of_scope", error: "no" }; }, kv, pr: PR30, claim, retryMs: FAST_START }), /releasing/);
  down(false);
  assert.equal(pendingOwner(store), true);
  await redeliveries(store, at, START_LEASE_MS);
});

test("no claim blocks forever: a failed drive whose release cannot be verified lapses after the drive lease, then drives once", async (t) => {
  silence(t);
  const store = new Map<string, unknown>();
  const { kv, down } = outage(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  await startAutoDrive({ start: async () => started(), kv, pr: PR30, claim });
  assert.equal(await stampAutoDriveSession(kv, PR30, "ses_failed"), "written");
  down(true);
  assert.equal(await releaseAutoDriveForSession(kv, "ses_failed", FAST), "unavailable");
  down(false);
  await redeliveries(store, claimAt(store, PR30)?.["at"] as string, DRIVE_LEASE_MS);
});

test("no claim blocks forever: a first turn whose stamp cannot be written lapses after the drive lease, then drives once", async (t) => {
  silence(t);
  const store = new Map<string, unknown>();
  const { kv, down } = outage(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  await startAutoDrive({ start: async () => started(), kv, pr: PR30, claim });
  down(true);
  assert.equal(await stampAutoDriveSession(kv, PR30, "ses_unstamped", FAST), "unavailable");
  down(false);
  assert.equal(await releaseAutoDriveForSession(kv, "ses_unstamped"), "lost");
  await redeliveries(store, claimAt(store, PR30)?.["at"] as string, DRIVE_LEASE_MS);
});

function pendingOwner(store: Map<string, unknown>): boolean {
  const value = store.get(KEY30) as { state?: string; owner?: unknown } | undefined;
  return value?.state === "pending" && typeof value.owner === "string";
}

// No redelivery: nothing retries a delivery the fixer failed, so each site
// retries in the handler. A transient failure still ends in exactly one
// drive (or one release); a failure that outlasts every retry is loud.
test("no redelivery: a claim whose reads fail for one pass is still taken, and drives once", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const { kv, fail } = outage(store);
  fail(ONE_PASS);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z", FAST);
  assert.ok(held(claim));
  let drives = 0;
  await startAutoDrive({ start: async () => { drives += 1; return started(); }, kv, pr: PR30, claim });
  assert.equal(drives, 1);
  assert.equal(claimAt(store, PR30)?.["started"], true);
  assert.equal(errors.mock.callCount(), 0);
});

test("no redelivery: a start that throws once is retried in the handler and drives once", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  let calls = 0;
  let drives = 0;
  await startAutoDrive({
    start: async () => { calls += 1; if (calls === 1) throw new Error("transient"); drives += 1; return started(); },
    kv,
    pr: PR30,
    claim,
    retryMs: FAST_START,
  });
  assert.deepEqual([calls, drives], [2, 1]);
  assert.equal(claimAt(store, PR30)?.["started"], true);
  assert.equal(errors.mock.callCount(), 0);
});

test("no redelivery: a start that throws on every try releases the lease, then fails loudly", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  let calls = 0;
  await assert.rejects(
    startAutoDrive({ start: async () => { calls += 1; throw new Error("send() reached the local engine during hosted admission."); }, kv, pr: PR30, claim, retryMs: FAST_START }),
    /failed 3 times \(send\(\) reached the local engine/,
  );
  assert.equal(calls, 3);
  assert.equal(store.has(KEY30), false);
  assert.equal(errors.mock.callCount(), 1);
});

test("no redelivery: a mark or a release that fails for one pass is retried and lands", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const { kv, fail } = outage(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  await startAutoDrive({ start: async () => { fail(ONE_PASS); return started(); }, kv, pr: PR30, claim, retryMs: FAST_START });
  assert.equal(claimAt(store, PR30)?.["started"], true);

  const pr31 = { ...(PR30 as object), number: 31, url: "https://github.com/example/sandbox/pull/31", label: "example/sandbox#31" } as never;
  const refused = await claimAutoDrive(kv, pr31, "2026-09-23T00:00:00.000Z");
  assert.ok(held(refused));
  await startAutoDrive({ start: async () => { fail(ONE_PASS); return { ok: false, code: "out_of_scope", error: "no" }; }, kv, pr: pr31, claim: refused, retryMs: FAST_START });
  assert.equal(store.has(autoDriveKey(pr31)), false);
  assert.equal(errors.mock.callCount(), 0);
});

test("no redelivery: a stamp, a session release and a close that fail for one pass are retried and land", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const { kv, fail } = outage(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  fail(ONE_PASS);
  assert.equal(await stampAutoDriveSession(kv, PR30, "ses_retry", FAST), "written");
  fail(ONE_PASS);
  assert.equal(await releaseAutoDriveForSession(kv, "ses_retry", FAST), "written");
  assert.deepEqual([...store.keys()], []);

  assert.ok(held(await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z")));
  fail(ONE_PASS);
  await releaseAutoDrive(kv, PR30, FAST);
  assert.equal(store.has(KEY30), false);
  assert.equal(errors.mock.callCount(), 0);
});

test("no redelivery: a stamp, a session release and a close that fail on every retry are loud", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const { kv, down } = outage(store);
  const claim = await claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z");
  assert.ok(held(claim));
  assert.equal(await stampAutoDriveSession(kv, PR30, "ses_down"), "written");
  down(true);
  assert.equal(await stampAutoDriveSession(kv, PR30, "ses_other", FAST), "unavailable");
  assert.equal(await releaseAutoDriveForSession(kv, "ses_down", FAST), "unavailable");
  await assert.rejects(releaseAutoDrive(kv, PR30, FAST), /closed example\/sandbox#30/);
  assert.equal(errors.mock.callCount(), 3);
  down(false);
  assert.equal(claimAt(store, PR30)?.["sessionId"], "ses_down");
});

test("concurrent openers: a lease written between the claim's read of a pre-lease value and its clear is kept", async () => {
  const store = new Map<string, unknown>();
  const kv = plainKv(store);
  const rival = lease("rival", "2026-09-23T00:00:00.000Z");
  store.set(KEY30, { at: "2026-09-23T00:00:00.000Z", token: "pre-lease" });
  const racing = through(kv, { afterGet: (n) => { if (n === 0) store.set(KEY30, rival); } });
  assert.equal(await claimAutoDrive(racing, PR30, "2026-09-23T00:00:01.000Z"), undefined);
  assert.deepEqual(store.get(KEY30), rival);
});

/** Reads fail from the first put on, for `n` reads. */
function failAfterPut(store: Map<string, unknown>, n: number) {
  let put = false;
  let failing = n;
  return through(plainKv(store), { afterPut: () => { put = true; }, beforeGet: () => { if (put && failing > 0) { failing -= 1; throw new Error("kv unavailable"); } } });
}

test("no claim blocks forever: a take whose read-back never verifies is released when the store answers again, so the next delivery drives at once", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  // takeLease with FAST pauses reads back three times per pass, three passes.
  const kv = failAfterPut(store, 9);
  await assert.rejects(claimAutoDrive(kv, PR30, "2026-09-23T00:00:00.000Z", FAST), /unavailable claiming/);
  assert.equal(store.has(KEY30), false);
  assert.doesNotMatch(loudLines(errors).join("\n"), /left pending/);
  assert.ok(held(await claimAutoDrive(plainKv(store), PR30, "2026-09-23T00:00:01.000Z")));
});

test("no redelivery: a take whose read-back fails for one pass is retried and holds the claim", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const claim = await claimAutoDrive(failAfterPut(store, ONE_PASS), PR30, "2026-09-23T00:00:00.000Z", FAST);
  assert.ok(held(claim));
  assert.deepEqual(store.get(KEY30), lease(claim, "2026-09-23T00:00:00.000Z"));
  assert.equal(errors.mock.callCount(), 0);
});


// marsbank #38: "Bugbot — 1 finding" and the factory never acted on it. Bugbot
// reports findings as a neutral conclusion, which is no failure.
test("Bugbot's neutral check (findings) on a factory PR drives it with a Bugbot brief; a clean or someone else's neutral does not", async () => {
  const projects = ["TLSSN"];
  const branch = { headRefName: "TLSSN-46-activity-csv", title: "TLSSN-46: CSV download on Activity" };
  assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion: "neutral", checkName: "Cursor Bugbot", ...branch, projects }), { drive: true, issueKey: "TLSSN-46", trigger: "bugbot" });
  assert.deepEqual(autoDriveDecision({ eventName: "check_run", conclusion: "neutral", checkName: "Cursor Bugbot", ...branch, projects }), { drive: true, issueKey: "TLSSN-46", trigger: "bugbot" });
  for (const input of [
    { eventName: "check_suite", conclusion: "success", checkName: "Cursor Bugbot" },
    { eventName: "check_suite", conclusion: "neutral", app: "cursor" },
    { eventName: "check_suite", conclusion: "neutral", checkName: "Cursor Change Monitor" },
    { eventName: "workflow_run", conclusion: "neutral" },
  ]) {
    assert.deepEqual(autoDriveDecision({ ...input, ...branch, projects }), { drive: false, reason: "not_a_failure_event" }, JSON.stringify(input));
  }
  assert.deepEqual(autoDriveDecision({ eventName: "check_suite", conclusion: "neutral", checkName: "Cursor Bugbot", headRefName: "fix-typo", title: "Fix typo", projects }), { drive: false, reason: "not_a_factory_pr" });
  assert.match(autoDriveBrief({ issueKey: "TLSSN-46", trigger: "bugbot" }), /Bugbot reported findings on TLSSN-46's pull request.*unresolved review threads/);
  assert.match(autoDriveBrief({ issueKey: "TLSSN-46", trigger: "red_check" }), /A check went red/);
});

/** Every setTimeout delay asked for while `run` runs; each timer fires on the next turn instead of waiting. */
async function timerDelays(run: () => Promise<unknown>): Promise<number[]> {
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const savedPauses = process.env.FACTORY_KV_RETRY_PAUSES_MS;
  delete process.env.FACTORY_KV_RETRY_PAUSES_MS;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    setImmediate(handler);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    await run();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    if (savedPauses !== undefined) process.env.FACTORY_KV_RETRY_PAUSES_MS = savedPauses;
  }
  return delays.filter((ms) => ms > 0);
}

const unavailable503 = () => Object.assign(new Error("kv 503"), { status: 503 });
const sum = (values: readonly number[]) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

// The claim's loops (readUntilAvailable, takeLease's pausesMs, the release's
// untilAvailable) own the pauses; kv-verified's default pauses must not stack
// under them. A store that is down for good pauses only CLAIM_RETRY_MS.
test("a claim during a full kv outage pauses only CLAIM_RETRY_MS (1.25 s)", async (t) => {
  silence(t);
  const kv = through(plainKv(new Map()), { beforeGet: () => { throw unavailable503(); } });
  const delays = await timerDelays(() => assert.rejects(claimAutoDrive(kv, PR30, "2026-09-22T00:00:00.000Z")));
  assert.deepEqual(delays, [...CLAIM_RETRY_MS]);
  assert.equal(sum(delays), 1250);
});

// Worst case of a claim that fails: the first read succeeds on its last try,
// the clear of a value that is no lease succeeds on its last try, then the
// store goes down for the take and the release. Each of the four phases
// pauses CLAIM_RETRY_MS once, and a take that fails never settles.
test("a claim that fails pauses at most 5.0 s: four CLAIM_RETRY_MS loops, no settle", async (t) => {
  silence(t);
  const store = new Map<string, unknown>([[KEY30, { at: "2026-09-21T00:00:00.000Z", token: "old" }]]);
  const answered = new Set([8, 13, 14]);
  const kv = through(plainKv(store), {
    beforeGet: (n) => { if (!answered.has(n)) throw unavailable503(); },
    beforePut: () => { throw unavailable503(); },
  });
  const delays = await timerDelays(() => assert.rejects(claimAutoDrive(kv, PR30, "2026-09-22T00:00:00.000Z")));
  assert.equal(store.has(KEY30), false, "the non-lease value was cleared before the store went down");
  assert.deepEqual(delays, [...CLAIM_RETRY_MS, ...CLAIM_RETRY_MS, ...CLAIM_RETRY_MS, ...CLAIM_RETRY_MS]);
  assert.ok(sum(delays) <= 5000, `paused ${sum(delays)} ms`);
});

// A start that keeps throwing, then a release in a full outage: the start
// loop and the release loop own the pauses, so kv-verified adds none inside
// the delivery window. They share TASK_PAUSE_BUDGET_MS, so the release gets
// what the start left: 2.5 s of SETTLE_RETRY_MS, where it had 7.5 s (12.5 s
// in all) before K8.
test("a start that keeps throwing, then a release during a full kv outage, pauses START_RETRY_MS then 2.5 s of SETTLE_RETRY_MS (7.5 s)", async (t) => {
  silence(t);
  const kv = through(plainKv(new Map()), { beforeGet: () => { throw unavailable503(); } });
  const start = async (): Promise<never> => { throw new Error("start refused by the network"); };
  const delays = await timerDelays(() => assert.rejects(startAutoDrive({ start, kv, pr: PR30, claim: "owner-1" })));
  assert.deepEqual(delays, [...START_RETRY_MS, 500, 2000]);
  assert.equal(sum(delays), TASK_PAUSE_BUDGET_MS);
});

test("a start that answers at once keeps all of SETTLE_RETRY_MS for its release; one that paused 1 s keeps the rest of the budget", async (t) => {
  silence(t);
  const down = () => through(plainKv(new Map()), { beforeGet: () => { throw unavailable503(); } });
  const refused = async () => ({ ok: false, code: "out_of_scope", error: "refused" }) as never;
  assert.deepEqual(await timerDelays(() => assert.rejects(startAutoDrive({ start: refused, kv: down(), pr: PR30, claim: "owner-1" }))), [...SETTLE_RETRY_MS]);
  let tries = 0;
  const throwsOnce = async () => {
    tries += 1;
    if (tries === 1) throw new Error("once");
    return { ok: false, code: "out_of_scope", error: "refused" } as never;
  };
  assert.deepEqual(await timerDelays(() => assert.rejects(startAutoDrive({ start: throwsOnce, kv: down(), pr: PR30, claim: "owner-1" }))), [1000, 500, 2000, 4000]);
});

test("the drive claim's settle: 2 s by default; FACTORY_FIXER_CLAIM_SETTLE_MS shortens it, 0 turns it off, and nothing can lengthen it", () => {
  assert.equal(CLAIM_SETTLE_MS, 2000);
  assert.equal(claimSettleMs({}), CLAIM_SETTLE_MS);
  for (const [raw, ms] of [["0", 0], ["250", 250], [" 1500 ", 1500], ["2000", 2000], ["2001", 2000], ["10000", 2000], ["-1", 2000], ["1.5", 2000], ["", 2000], ["off", 2000]] as const) {
    assert.equal(claimSettleMs({ FACTORY_FIXER_CLAIM_SETTLE_MS: raw }), ms, JSON.stringify(raw));
  }
});

/** Counts each kind of kv call made through the returned store. */
function counted(kv: HostKvApi) {
  const calls = { get: 0, put: 0, delete: 0 };
  const view = through(kv, { beforeGet: () => { calls.get += 1; }, beforePut: () => { calls.put += 1; }, beforeDelete: () => { calls.delete += 1; } });
  return { kv: view, calls };
}

test("the settle path: a claim waits CLAIM_SETTLE_MS after its read-back, re-reads once, and holds; FACTORY_FIXER_CLAIM_SETTLE_MS=0 skips both", async () => {
  const on = counted(plainKv(new Map()));
  let claim: string | undefined;
  const delays = await timerDelays(async () => { claim = await claimAutoDrive(on.kv, PR30, "2026-09-29T00:00:00.000Z", CLAIM_RETRY_MS, { env: {} }); });
  assert.ok(held(claim));
  assert.deepEqual(delays, [CLAIM_SETTLE_MS]);
  assert.deepEqual(on.calls, { get: 4, put: 1, delete: 0 }, "read, verified write (read, put, read back), settle re-read");

  const off = counted(plainKv(new Map()));
  const offDelays = await timerDelays(async () => { claim = await claimAutoDrive(off.kv, PR30, "2026-09-29T00:00:00.000Z", CLAIM_RETRY_MS, { env: { FACTORY_FIXER_CLAIM_SETTLE_MS: "0" } }); });
  assert.ok(held(claim));
  assert.deepEqual(offDelays, []);
  assert.deepEqual(off.calls, { get: 3, put: 1, delete: 0 }, "the claim as before K8: no settle re-read");
});

// The read-back alone misses a rival whose put lands after it: both openers
// verify their own write. The settle re-read catches it, and only the last
// writer drives. With the settle off, both drive (the pre-K8 window).
test("concurrent openers: a rival put that lands after the read-back but inside the settle leaves one drive; with the settle off, two", async () => {
  for (const settle of ["1", "0"]) {
    const kv = plainKv(new Map());
    const bothRead = gate();
    const aReadBack = gate();
    const bPut = gate();
    let reads = 0;
    const firstReads = (n: number) => { if (n === 1 && ++reads === 2) bothRead.open(); };
    const a = through(kv, {
      afterGet: (n) => { firstReads(n); if (n === 2) aReadBack.open(); },
      beforePut: () => bothRead.wait(),
      beforeGet: async (n) => { if (n === 3) await bPut.wait(); },
    });
    const b = through(kv, {
      afterGet: (n) => firstReads(n),
      beforePut: async () => { await bothRead.wait(); await aReadBack.wait(); },
      afterPut: () => bPut.open(),
    });
    const env = { FACTORY_FIXER_CLAIM_SETTLE_MS: settle };
    const [claimA, claimB] = await Promise.all([claimAutoDrive(a, PR30, "2026-09-29T00:00:00.000Z", FAST, { env }), claimAutoDrive(b, PR30, "2026-09-29T00:00:00.000Z", FAST, { env })]);
    if (settle === "1") {
      assert.equal(claimA, undefined, "the first writer's settle re-read sees the rival's lease and yields");
      assert.ok(held(claimB));
    } else {
      assert.ok(held(claimA) && held(claimB), "no settle: both verified their own write");
    }
  }
});

// Worst case of a claim that holds: its first read, the clear of a value
// that is no lease, and its take each succeed only on the last try of
// their CLAIM_RETRY_MS loop, then it settles.
test("a claim that holds pauses at most 5.75 s: three CLAIM_RETRY_MS loops and the settle", async (t) => {
  silence(t);
  const store = new Map<string, unknown>([[KEY30, { at: "2026-09-21T00:00:00.000Z", token: "old" }]]);
  const answered = new Set([6, 11, 12, 19, 20, 21]);
  const kv = through(plainKv(store), { beforeGet: (n) => { if (!answered.has(n)) throw unavailable503(); } });
  let claim: string | undefined;
  const delays = await timerDelays(async () => { claim = await claimAutoDrive(kv, PR30, "2026-09-29T00:00:00.000Z", CLAIM_RETRY_MS, { env: {} }); });
  assert.ok(held(claim));
  assert.deepEqual(delays, [...CLAIM_RETRY_MS, ...CLAIM_RETRY_MS, ...CLAIM_RETRY_MS, CLAIM_SETTLE_MS]);
  assert.equal(sum(delays), 5750);
});

// Reviewer finding: three immediate failed settle re-reads released a claim
// this delivery had verified and dropped the drive, with nothing to
// redeliver the event. The re-read fails open: the read-back already
// verified the claim. Worst case as above, then every settle re-read fails:
// still 5.75 s, and the claim holds.
test("a settle re-read that fails every try holds the verified claim, logs once, and adds no pause", async (t) => {
  silence(t);
  const warned = t.mock.method(console, "warn", () => {});
  const store = new Map<string, unknown>([[KEY30, { at: "2026-09-21T00:00:00.000Z", token: "old" }]]);
  const answered = new Set([6, 11, 12, 19, 20]);
  const kv = through(plainKv(store), { beforeGet: (n) => { if (!answered.has(n)) throw unavailable503(); } });
  let claim: string | undefined;
  const delays = await timerDelays(async () => { claim = await claimAutoDrive(kv, PR30, "2026-09-29T00:00:00.000Z", CLAIM_RETRY_MS, { env: {} }); });
  assert.ok(held(claim));
  assert.equal(claimAt(store, PR30)?.["owner"], claim, "the claim stays in the store");
  assert.deepEqual(delays, [...CLAIM_RETRY_MS, ...CLAIM_RETRY_MS, ...CLAIM_RETRY_MS, CLAIM_SETTLE_MS]);
  assert.equal(sum(delays), 5750);
  const fixerLines = warned.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('"fixer"'));
  assert.deepEqual(fixerLines.map((line) => JSON.parse(line)), [{ fixer: "auto_drive_claim", pr: "example/sandbox#30", outcome: "settle_unread_held" }], "one settle line; K7's kv warnings are its own");
});

test("a claim the settle re-read finds gone (taken and released meanwhile) fails the delivery loudly", async (t) => {
  const errors = silence(t);
  const store = new Map<string, unknown>();
  const kv = through(plainKv(store), { beforeGet: (n) => { if (n === 3) store.delete(KEY30); } });
  const delays = await timerDelays(() => assert.rejects(claimAutoDrive(kv, PR30, "2026-09-29T00:00:00.000Z", CLAIM_RETRY_MS, { env: {} }), /was gone after its settle/));
  assert.deepEqual(delays, [CLAIM_SETTLE_MS]);
  assert.equal(loudLines(errors).length, 1);
});

// Worst case of the start task: the start throws twice and then starts, its
// Bugbot round is recorded inside the start loop (no pauses of its own, as
// the channel passes), and its mark gets what is left of the budget, all in
// a full kv outage.
test("a start task pauses at most 7.5 s: TASK_PAUSE_BUDGET_MS, with a Bugbot round's record inside it adding none", async (t) => {
  silence(t);
  t.mock.method(console, "warn", () => {});
  const kv = through(plainKv(new Map()), { beforeGet: () => { throw unavailable503(); } });
  let tries = 0;
  const start = async () => {
    tries += 1;
    if (tries < 3) throw new Error("start refused by the network");
    await recordBugbotRound(kv, { pr: PR30, headSha: "a1", retry: { pausesMs: [] } });
    return started();
  };
  const delays = await timerDelays(() => startAutoDrive({ start, kv, pr: PR30, claim: "owner-1" }));
  assert.deepEqual(delays, [...START_RETRY_MS, 500, 2000]);
  assert.equal(sum(delays), TASK_PAUSE_BUDGET_MS);
});

test("one delivery's pauses stay within ADMISSION_PAUSE_CAP_MS: 14.5 s, reachable and summing each phase's worst", () => {
  const prRead = sum(CLAIM_RETRY_MS);
  const claimFails = 4 * sum(CLAIM_RETRY_MS);
  const claimHolds = 3 * sum(CLAIM_RETRY_MS) + CLAIM_SETTLE_MS;
  const task = TASK_PAUSE_BUDGET_MS;
  assert.deepEqual([prRead, claimFails, claimHolds, task], [1250, 5000, 5750, 7500]);
  assert.equal(prRead + claimHolds + task, 14_500, "a claim that fails never starts, so the claim that holds is the worst path");
  assert.equal(prRead + Math.max(claimFails, claimHolds) + task, 14_500);
  assert.ok(prRead + claimHolds + task <= ADMISSION_PAUSE_CAP_MS);
  assert.equal(TASK_PAUSE_BUDGET_MS, sum(SETTLE_RETRY_MS), "a start that answers at once keeps every settle pause");
  assert.ok(sum(START_RETRY_MS) < TASK_PAUSE_BUDGET_MS, "a start that paused all its retries still leaves its mark or release a pause");
});

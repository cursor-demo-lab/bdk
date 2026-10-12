import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, HostMcpCallResult, HostMcpRegistry } from "@cursor/july";
import { announceReviewUpdate, announceReviewUpdateWithRecheck, type PullFacts, type ReviewDeps, type ReviewReader } from "./review-announce.js";
import { TLSSN_37_COMMENT_URL, TLSSN_37_DRAFTING, TLSSN_37_ESCALATION_PROSE, TLSSN_37_FACTORY_DESK, TLSSN_37_PUBLISHED, stickyComment } from "./change-monitor.fixtures.js";
import { racingStores, recordKv } from "./kv-race.fixtures.js";
import { securityReviewResult, type CheckRunFacts, type CommentFacts, type ReviewFacts } from "./review-update.js";

const REPO = "cursor-demo-lab/marsbank";
const HEAD = "9f0ba2e".padEnd(40, "0");
const NEXT = "5e6f7a8".padEnd(40, "0");
const THREAD = { channelId: "C0EXAMPLE1", threadTs: "1790301410.693199", originatorUserId: "U0ALICE01" };
const ENV = { FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_DESK_CLAIM_SETTLE_MS: "5" };

type World = {
  kv: Record<string, unknown>;
  posts: Record<string, unknown>[];
  pull: PullFacts;
  runs: Record<string, CheckRunFacts[] | undefined>;
  reviews: ReviewFacts[];
  comments?: string[];
  /** PR conversation comments (change-monitor's sticky plan comment). */
  prComments?: CommentFacts[];
  failPost?: boolean;
  updates?: Record<string, unknown>[];
  deletes?: Record<string, unknown>[];
};

function world(overrides: Partial<World> = {}): World {
  return {
    kv: { "ticket/TLSSN-28": THREAD },
    posts: [],
    pull: { number: 19, state: "open", merged: false, headSha: HEAD, headRef: "TLSSN-28-csv-export", title: "TLSSN-28: CSV export", authorLogin: "cursor[bot]" },
    runs: { [HEAD]: [] },
    reviews: [],
    ...overrides,
  };
}

function kvOf(store: Record<string, unknown>): HostKvApi {
  return {
    get: async (key: string) => store[key],
    put: async (key: string, value: unknown) => void (store[key] = value),
    delete: async (key: string) => void delete store[key],
  } as HostKvApi;
}

function jira(comments: string[] | undefined): HostMcpRegistry {
  if (comments === undefined) return { names: () => [], listTools: async () => [], callTool: async (): Promise<HostMcpCallResult> => ({ content: [] }) } as unknown as HostMcpRegistry;
  return {
    names: () => ["tracker"],
    listTools: async () => [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } }],
    callTool: async (): Promise<HostMcpCallResult> => ({
      content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-28", fields: { comment: { comments: comments.map((body, i) => ({ id: String(i + 1), body })) } } }) }],
    }),
  } as unknown as HostMcpRegistry;
}

function deps(w: World): ReviewDeps {
  const github: ReviewReader = {
    pull: async () => w.pull,
    checkRuns: async (sha) => w.runs[sha],
    reviews: async () => w.reviews,
    comments: async () => w.prComments ?? [],
  };
  return {
    kv: kvOf(w.kv),
    slack: {
      getClient: async () => ({
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            if (w.failPost === true) throw new Error("slack down");
            w.posts.push(args);
            return { ok: true, ts: `1790301500.00010${w.posts.length}` };
          },
          update: async (args: Record<string, unknown>) => void (w.updates ??= []).push(args),
          delete: async (args: Record<string, unknown>) => void (w.deletes ??= []).push(args),
        },
      }),
    },
    mcp: jira(w.comments),
    github,
    env: ENV,
    now: () => new Date("2026-09-25T10:00:00.000Z"),
  };
}

const bugbotClean: CheckRunFacts = { id: 1, name: "Cursor Bugbot", app: "cursor", status: "completed", conclusion: "success", summary: "**Final Result:** Bugbot completed review - no issues found! ✅", htmlUrl: `https://github.com/${REPO}/runs/1` };
const bugbotRunning: CheckRunFacts = { ...bugbotClean, status: "in_progress", conclusion: null };
const ciGreen: CheckRunFacts = { name: "test", app: "github-actions", status: "completed", conclusion: "success" };
const ciRed: CheckRunFacts = { name: "test", app: "github-actions", status: "completed", conclusion: "failure", htmlUrl: "https://github.com/x/job/1" };
const securityClean: ReviewFacts = { authorLogin: "cursor[bot]", authorType: "Bot", body: "## Security review\n\n**Verdict:** CLEAN\nSecurity only, on head `9f0ba2e`.", commitId: HEAD, htmlUrl: `https://github.com/${REPO}/pull/19#pullrequestreview-9` };
const suiteWake = { kind: "check_suite" as const, suite: { app: "cursor", headSha: HEAD, conclusion: "success" } };
const input = { repository: REPO, number: 19, wake: suiteWake };

test("gates that settle together land as one reply in the ticket's thread, claimed per gate", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean, ciGreen] }, reviews: [securityClean] });
  const result = await announceReviewUpdate(input, deps(w));
  assert.deepEqual(result, { posted: true, reason: "posted_in_thread", pr: `${REPO}#19`, issueKey: "TLSSN-28", headSha: HEAD, pending: [], components: ["bugbot", "security", "ci"] });
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0]?.["channel"], THREAD.channelId);
  assert.equal(w.posts[0]?.["thread_ts"], THREAD.threadTs);
  assert.match(String(w.posts[0]?.["text"]), /^TLSSN-28 review update on `9f0ba2e`:\n• 🐛✅ Bugbot — clean · .*\n• 🔒✅ Security review — clean · .*\n• 🏗️✅ CI — passing · <[^|]+\/pull\/19\/checks\|checks>$/);
  const security = securityReviewResult([securityClean], HEAD)!.fingerprint;
  for (const key of [`${HEAD}/bugbot`, `security/${security}/after/none`, `${HEAD}/ci`]) {
    const claim = w.kv[`review/${REPO}#19/${key}`] as Record<string, unknown>;
    assert.equal(claim["state"], "done", key);
    assert.equal(claim["ts"], "1790301500.000101");
  }
  assert.deepEqual(w.kv[`review-security/${REPO}#19`], { fingerprint: security, headSha: HEAD, at: "2026-09-25T10:00:00.000Z" });
});

function securityOn(sha: string, verdict: string, lines: string[] = [], id = 9): ReviewFacts {
  return {
    authorLogin: "cursor[bot]",
    authorType: "Bot",
    body: ["## Security review", "", `**Verdict:** ${verdict}`, `Security only, on head \`${sha.slice(0, 7)}\`; Bugbot covers correctness. A new push gets a new review.`, ...lines].join("\n"),
    commitId: sha,
    htmlUrl: `https://github.com/${REPO}/pull/19#pullrequestreview-${id}`,
  };
}

function pushTo(w: World, sha: string, review: ReviewFacts | undefined): void {
  w.pull = { ...w.pull, headSha: sha };
  w.runs[sha] = [ciGreen];
  if (review !== undefined) w.reviews = [...w.reviews, review];
}

const onHead = (sha: string) => ({ ...input, wake: { kind: "check_suite" as const, suite: { app: "cursor", headSha: sha, conclusion: "success" } } });
const THIRD = "c0ffee1".padEnd(40, "0");

test("TLSSN-31: an unchanged CLEAN on a new head, or a second settle of it, is not announced again; the head's other gates still are", async () => {
  const w = world({ reviews: [securityOn(HEAD, "CLEAN")] });
  assert.deepEqual((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).components, ["security"]);
  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "already_announced", "a duplicate settle on the same head");

  pushTo(w, NEXT, securityOn(NEXT, "CLEAN", [], 10));
  const next = await announceReviewUpdate(onHead(NEXT), deps(w));
  assert.deepEqual(next.components, ["ci"], "the push's CI is news, its CLEAN is not");
  assert.deepEqual(next.pending, ["bugbot"], "a suppressed review still counts as settled");
  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "already_announced");
  assert.equal(w.posts.length, 2);
  assert.doesNotMatch(String(w.posts[1]?.["text"]), /Security review/);
  assert.equal((w.kv[`review-security/${REPO}#19`] as Record<string, unknown>)["headSha"], HEAD, "the last announced verdict is still the first head's");
});

test("a changed verdict announces with the new head's review link, and so does a change back", async () => {
  const w = world({ reviews: [securityOn(HEAD, "CLEAN")] });
  await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w));

  pushTo(w, NEXT, securityOn(NEXT, "FINDINGS", ["- **high** `api/export.ts:40` — Missing auth check", "  Anyone can fetch it."], 10));
  assert.deepEqual((await announceReviewUpdate(onHead(NEXT), deps(w))).components, ["security", "ci"]);
  assert.match(String(w.posts[1]?.["text"]), /^TLSSN-28 review update on `5e6f7a8`:\n• 🔒⚠️ Security review — findings: 1 high \(top: Missing auth check\) · <https:\/\/github\.com\/cursor-demo-lab\/marsbank\/pull\/19#pullrequestreview-10\|review>/);

  pushTo(w, THIRD, securityOn(THIRD, "CLEAN", [], 11));
  assert.deepEqual((await announceReviewUpdate(onHead(THIRD), deps(w))).components, ["security", "ci"], "FINDINGS → CLEAN is news even though CLEAN was heard before");
  assert.match(String(w.posts[2]?.["text"]), /🔒✅ Security review — clean · <[^|]+#pullrequestreview-11\|review>/);
  assert.equal(w.posts.length, 3);
});

test("a new finding, or a different unreviewed scope, under the same verdict announces", async () => {
  const auth = ["- **high** `api/export.ts:40` — Missing auth check", "  Anyone can fetch it."];
  const w = world({ reviews: [securityOn(HEAD, "FINDINGS", auth)] });
  await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w));

  pushTo(w, NEXT, securityOn(NEXT, "FINDINGS", ["- **high** `api/export.ts:52` — Missing auth check", "  Moved by the push."], 10));
  assert.deepEqual((await announceReviewUpdate(onHead(NEXT), deps(w))).components, ["ci"], "the same finding on moved lines");

  pushTo(w, THIRD, securityOn(THIRD, "FINDINGS", [...auth, "- **medium** `lib/report.ts:12` — CSV injection", "  Formula cells."], 11));
  assert.deepEqual((await announceReviewUpdate(onHead(THIRD), deps(w))).components, ["security", "ci"]);
  assert.match(String(w.posts.at(-1)?.["text"]), /findings: 1 high, 1 medium/);

  const cut = (files: string[]) => ["", "Partial review: diff truncated at 150000 of 180000 chars.", `Not fully reviewed: ${files.map((f) => `\`${f}\``).join(", ")}`];
  const partial = world({ reviews: [securityOn(HEAD, "INCOMPLETE", cut(["a.ts"]))] });
  await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(partial));
  pushTo(partial, NEXT, securityOn(NEXT, "INCOMPLETE", cut(["a.ts"]), 10));
  assert.deepEqual((await announceReviewUpdate(onHead(NEXT), deps(partial))).components, ["ci"]);
  pushTo(partial, THIRD, securityOn(THIRD, "INCOMPLETE", cut(["a.ts", "api/auth.ts"]), 11));
  assert.deepEqual((await announceReviewUpdate(onHead(THIRD), deps(partial))).components, ["security", "ci"]);
});

test("wakes racing on one verdict change post it once", async () => {
  const w = world({ reviews: [securityOn(HEAD, "CLEAN")] });
  const results = await Promise.all([1, 2, 3].map(() => announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))));
  assert.equal(results.filter((r) => r.posted).length, 1);
  assert.equal(w.posts.length, 1);
});

test("TLSSN-36: CI's check_suite and workflow_run wakes, both past the read-back, post the CI line once", async () => {
  const workflowWake = { kind: "workflow_run" as const, workflow: { headSha: HEAD, conclusion: "success", name: "test" } };
  const race = async (settle: string) => {
    const w = world({ runs: { [HEAD]: [ciGreen] } });
    // Each wake reads the gate once (already posted?) before it takes the claim.
    const [first, second] = racingStores(recordKv(w.kv), { prefix: `review/${REPO}#19/${HEAD}/ci`, after: "readBack", passReads: 1 });
    const env = { ...ENV, FACTORY_DESK_CLAIM_SETTLE_MS: settle };
    const results = await Promise.all([
      announceReviewUpdate(input, { ...deps(w), kv: first, env }),
      announceReviewUpdate({ ...input, wake: workflowWake }, { ...deps(w), kv: second, env }),
    ]);
    return { w, results };
  };
  const unsettled = await race("0");
  assert.equal(unsettled.w.posts.length, 2, "without the settle re-read both wakes take the claim (the live double post)");

  const { w, results } = await race("20");
  assert.equal(results.filter((r) => r.posted).length, 1);
  assert.equal(w.posts.length, 1);
  assert.match(String(w.posts[0]?.["text"]), /^TLSSN-28 review update on `9f0ba2e`:\n• 🏗️✅ CI — passing · <[^|]+\|checks>$/);
  assert.equal((w.kv[`review/${REPO}#19/${HEAD}/ci`] as Record<string, unknown>)["state"], "done");
});

// Drafting has no plan marker; `published` carries change-monitor's cursor:plan marker.
const sticky = (status: string, published = false): CommentFacts => ({
  authorLogin: "cursor[bot]",
  authorType: "Bot",
  body: `<!-- cursor:sticky:change-monitor-plan -->\nRollout plan. Status: ${status}\n${published ? "<!-- cursor:plan:e30= -->\n" : ""}<!-- /cursor:sticky:change-monitor-plan -->`,
  htmlUrl: `https://github.com/${REPO}/pull/19#issuecomment-31`,
});
const RUNNING = `• 📡❔ Change review — running · <https://github.com/${REPO}/pull/19#issuecomment-31|change-monitor plan>`;
const PLAN_READY = `• 📡✅ Change review — plan ready · <https://github.com/${REPO}/pull/19#issuecomment-31|change-monitor plan>`;

test("marsbank#31: change-monitor's running line rides in the update, and its result edits that line in place", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean] }, prComments: [sticky("Pending")] });
  const first = await announceReviewUpdate(input, deps(w));
  assert.deepEqual(first.components, ["bugbot", "changeMonitor"]);
  assert.equal(w.posts.length, 1);
  assert.equal(String(w.posts[0]?.["text"]).split("\n").at(-1), RUNNING);

  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "already_announced", "still running: nothing new");

  w.prComments = [sticky("Published", true)];
  const result = await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w));
  assert.equal(result.reason, "updated_in_thread");
  assert.deepEqual(result.components, ["changeMonitor"]);
  assert.equal(w.posts.length, 1, "the result is an edit, not a post");
  assert.equal(w.updates?.length, 1);
  assert.equal(w.updates?.[0]?.["ts"], "1790301500.000101");
  assert.equal(
    w.updates?.[0]?.["text"],
    ["TLSSN-28 review update on `9f0ba2e`:", `• 🐛✅ Bugbot — clean · <https://github.com/${REPO}/runs/1|Bugbot run>`, PLAN_READY].join("\n")
  );
  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "already_announced");
  assert.equal(w.updates?.length, 1);
});

test("a running line that is the only news joins the head's latest update; racing wakes add it once", async () => {
  const w = world({ runs: { [HEAD]: [ciGreen] } });
  await announceReviewUpdate(input, deps(w));
  assert.equal(w.posts.length, 1);

  w.prComments = [sticky("Monitoring")];
  const results = await Promise.all([1, 2].map(() => announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))));
  assert.deepEqual(results.map((r) => r.reason).sort(), ["already_announced", "updated_in_thread"]);
  assert.equal(w.posts.length, 1);
  assert.equal(w.updates?.length, 1);
  assert.deepEqual(String(w.updates?.[0]?.["text"]).split("\n").slice(1), [`• 🏗️✅ CI — passing · <https://github.com/${REPO}/pull/19/checks|checks>`, RUNNING]);

  w.prComments = [sticky("Published", true)];
  await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w));
  assert.equal(w.posts.length, 1);
  assert.deepEqual(String(w.updates?.at(-1)?.["text"]).split("\n").slice(1), [`• 🏗️✅ CI — passing · <https://github.com/${REPO}/pull/19/checks|checks>`, PLAN_READY]);
});

test("no change-monitor comment or check: no 📡 line; a result seen first posts like any gate", async () => {
  const none = world({ runs: { [HEAD]: [bugbotClean, ciGreen] } });
  await announceReviewUpdate(input, deps(none));
  assert.doesNotMatch(String(none.posts[0]?.["text"]), /📡|Change review/);

  const direct = world({ runs: { [HEAD]: [bugbotClean] }, prComments: [sticky("Published", true)] });
  await announceReviewUpdate(input, deps(direct));
  assert.equal(String(direct.posts[0]?.["text"]).split("\n").at(-1), PLAN_READY);
  assert.equal(direct.updates, undefined);
});

test("a head announced under the old per-head security claim is not announced again", async () => {
  const w = world({ kv: { "ticket/TLSSN-28": THREAD, [`review/${REPO}#19/${HEAD}/security`]: { state: "done", ts: "1790301500.000001" } }, reviews: [securityOn(HEAD, "CLEAN")] });
  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "already_announced");
  assert.deepEqual(w.posts, []);
});

test("a failed post leaves the last announced verdict alone, so the next wake posts the change", async () => {
  const w = world({ reviews: [securityOn(HEAD, "CLEAN")], failPost: true });
  await assert.rejects(announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w)), /slack down/);
  assert.equal(w.kv[`review-security/${REPO}#19`], undefined);
  w.failPost = false;
  assert.deepEqual((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).components, ["security"]);
});

test("dedupe: a redelivery, a second wake, or a re-run of a gate on the same head posts nothing; only a newly settled gate posts", async () => {
  const w = world({ runs: { [HEAD]: [bugbotRunning, ciGreen] } });
  assert.deepEqual((await announceReviewUpdate(input, deps(w))).components, ["ci"]);
  assert.equal((await announceReviewUpdate(input, deps(w))).reason, "already_announced");
  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "already_announced");
  w.runs[HEAD] = [bugbotClean, ciGreen];
  assert.deepEqual((await announceReviewUpdate(input, deps(w))).components, ["bugbot"]);
  w.runs[HEAD] = [{ ...bugbotClean, id: 2, conclusion: "neutral", summary: "found 3 potential issues" }, ciGreen];
  assert.equal((await announceReviewUpdate(input, deps(w))).reason, "already_announced", "a Bugbot re-run on the same head is not news");
  assert.equal(w.posts.length, 2);
  assert.match(String(w.posts[0]?.["text"]), /^TLSSN-28 review update on `9f0ba2e`:\n• 🏗️✅ CI — passing · <[^|]+\|checks>$/);
  assert.match(String(w.posts[1]?.["text"]), /🐛✅ Bugbot — clean/);
});

test("a new head posts its own results again", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean] } });
  await announceReviewUpdate(input, deps(w));
  w.pull = { ...w.pull, headSha: NEXT };
  w.runs[NEXT] = [{ ...bugbotClean, id: 5 }];
  const result = await announceReviewUpdate({ ...input, wake: { kind: "check_suite", suite: { app: "cursor", headSha: NEXT, conclusion: "success" } } }, deps(w));
  assert.deepEqual(result.components, ["bugbot"]);
  assert.match(String(w.posts[1]?.["text"]), /^TLSSN-28 review update on `5e6f7a8`:\n• 🐛✅ Bugbot — clean/);
});

test("in-progress gates say nothing", async () => {
  const w = world({ runs: { [HEAD]: [bugbotRunning, { ...ciGreen, status: "queued", conclusion: null }] } });
  const result = await announceReviewUpdate(input, deps(w));
  assert.equal(result.reason, "nothing_settled");
  assert.deepEqual(result.pending, ["bugbot", "security", "ci"]);
  assert.deepEqual(w.posts, []);
});

test("nothing posts for a closed PR, a PR that is not the factory's, a ticket with no thread, or a PR the ticket does not link", async () => {
  const closed = world({ runs: { [HEAD]: [bugbotClean] } });
  closed.pull = { ...closed.pull, state: "closed", merged: true };
  assert.equal((await announceReviewUpdate(input, deps(closed))).reason, "pr_not_open");

  const personal = world({ runs: { [HEAD]: [bugbotClean] } });
  personal.pull = { ...personal.pull, headRef: "example-user/fix", authorLogin: "example-user" };
  assert.equal((await announceReviewUpdate(input, deps(personal))).reason, "not_factory_pr");

  const unbound = world({ kv: {}, runs: { [HEAD]: [bugbotClean] } });
  assert.equal((await announceReviewUpdate(input, deps(unbound))).reason, "no_thread");
  assert.deepEqual(unbound.kv, {}, "never opens an intake root");

  const other = world({ runs: { [HEAD]: [bugbotClean] }, comments: [`Pull request: https://github.com/${REPO}/pull/7`] });
  assert.equal((await announceReviewUpdate(input, deps(other))).reason, "other_pull_request");

  const linked = world({ runs: { [HEAD]: [bugbotClean] }, comments: [`Pull request: https://github.com/${REPO}/pull/19`] });
  assert.equal((await announceReviewUpdate(input, deps(linked))).reason, "posted_in_thread");
  for (const w of [closed, personal, unbound, other]) assert.deepEqual(w.posts, []);
});

test("a failed Slack post releases the claims so the next wake posts", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean] }, failPost: true });
  await assert.rejects(announceReviewUpdate(input, deps(w)), /slack down/);
  assert.equal(w.kv[`review/${REPO}#19/${HEAD}/bugbot`], undefined);
  w.failPost = false;
  assert.equal((await announceReviewUpdate(input, deps(w))).reason, "posted_in_thread");
});

test("a bot push after red CI is an autofix line on the new head; a person's push is not", async () => {
  const w = world({ runs: { [HEAD]: [ciRed], [NEXT]: [] } });
  w.pull = { ...w.pull, headSha: NEXT };
  const push = { kind: "pull_request" as const, action: "synchronize", before: HEAD, sender: { login: "cursor[bot]", type: "Bot" } };
  const result = await announceReviewUpdate({ ...input, wake: push }, deps(w));
  assert.deepEqual(result.components, ["autofix"]);
  assert.equal(
    w.posts[0]?.["text"],
    `TLSSN-28 review update on \`5e6f7a8\`:\n• 🔧 Autofix — pr-autofixer pushed after CI failed on \`9f0ba2e\` (test); checks are running on the new head · <https://github.com/${REPO}/pull/19/commits/${NEXT}|5e6f7a8>`
  );
  assert.equal((await announceReviewUpdate({ ...input, wake: push }, deps(w))).reason, "already_announced");

  const person = world({ runs: { [HEAD]: [ciRed], [NEXT]: [] } });
  person.pull = { ...person.pull, headSha: NEXT };
  const byPerson = await announceReviewUpdate({ ...input, wake: { ...push, sender: { login: "example-user", type: "User" } } }, deps(person));
  assert.equal(byPerson.reason, "nothing_settled");
});

test("after Bugbot and CI settle with the security review missing, the desk looks again, and stops once it lands", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean, ciGreen] } });
  const slept: number[] = [];
  const results = await announceReviewUpdateWithRecheck(input, {
    ...deps(w),
    recheckMs: [10, 20, 30],
    sleep: async (ms) => {
      slept.push(ms);
      if (slept.length === 2) w.reviews = [securityClean];
    },
  });
  assert.deepEqual(slept, [10, 20]);
  assert.deepEqual(results.map((r) => r.reason), ["posted_in_thread", "already_announced", "posted_in_thread"]);
  assert.deepEqual(results.at(-1)?.components, ["security"]);
  assert.equal(w.posts.length, 2);

  const push = world({ runs: { [HEAD]: [bugbotClean, ciGreen] } });
  const once = await announceReviewUpdateWithRecheck({ ...input, wake: { kind: "pull_request", action: "opened" } }, { ...deps(push), recheckMs: [10], sleep: async () => assert.fail("a PR event does not wait") });
  assert.equal(once.length, 1);
});

test("TLSSN-37: the running 📡 line becomes plan ready in the same message once change-monitor publishes, found by the re-check since no comment wake comes", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean, ciGreen] }, reviews: [securityClean], prComments: [stickyComment(TLSSN_37_DRAFTING)] });
  const slept: number[] = [];
  const results = await announceReviewUpdateWithRecheck(input, {
    ...deps(w),
    recheckMs: [10, 20, 30],
    sleep: async (ms) => {
      slept.push(ms);
      // 00:00:35Z: change-monitor edits its sticky comment into the published plan.
      if (slept.length === 2) w.prComments = [stickyComment(TLSSN_37_PUBLISHED)];
    },
  });
  assert.equal(w.posts.length, 1, "one review update, edited in place");
  assert.equal(String(w.posts[0]?.["text"]).split("\n").at(-1), `• 📡❔ Change review — running · <${TLSSN_37_COMMENT_URL}|change-monitor plan>`);
  assert.deepEqual(slept, [10, 20], "the re-check stops once the plan is out");
  assert.deepEqual(results.map((r) => r.reason), ["posted_in_thread", "already_announced", "updated_in_thread"]);
  assert.equal(w.updates?.length, 1);
  assert.equal(w.updates?.[0]?.["ts"], "1790301500.000101", "the same Slack message");
  assert.deepEqual(String(w.updates?.[0]?.["text"]).split("\n").slice(-2), [
    `• 🏗️✅ CI — passing · <https://github.com/${REPO}/pull/19/checks|checks>`,
    `• 📡✅ Change review — plan ready (services: marsbank-web) · <${TLSSN_37_COMMENT_URL}|change-monitor plan>`,
  ]);

  // #32's plan says "users may think restore failed", and prose that sounds like an escalation: still plan ready, nothing edited.
  w.prComments = [stickyComment(TLSSN_37_ESCALATION_PROSE)];
  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "already_announced");
  assert.equal(w.updates?.length, 1);

  // A structured attention (a change-monitor check run that failed) edits the same line again; a redelivery changes nothing.
  w.runs[HEAD] = [bugbotClean, ciGreen, { id: 9, name: "change-monitor", status: "completed", conclusion: "failure", htmlUrl: "https://github.com/x/runs/9" }];
  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "updated_in_thread");
  assert.equal((await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w))).reason, "already_announced");
  assert.equal(w.posts.length, 1);
  assert.equal(w.updates?.length, 2);
  assert.equal(w.updates?.[1]?.["ts"], "1790301500.000101");
  assert.equal(String(w.updates?.[1]?.["text"]).split("\n").at(-1), `• 📡⚠️ Change review — needs attention (services: marsbank-web) · <${TLSSN_37_COMMENT_URL}|change-monitor plan>`);
  assert.equal(String(w.updates?.[1]?.["text"]).match(/Change review/g)?.length, 1, "one 📡 line, replaced each time");
});

test("marsbank: change-monitor's `Services: factory-desk` never reaches the thread; the 📡 line leaves services out", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean, ciGreen] }, reviews: [securityClean], prComments: [stickyComment(TLSSN_37_FACTORY_DESK)] });
  assert.equal((await announceReviewUpdate(input, deps(w))).reason, "posted_in_thread");
  const text = String(w.posts[0]?.["text"]);
  assert.equal(text.split("\n").at(-1), `• 📡✅ Change review — plan ready · <${TLSSN_37_COMMENT_URL}|change-monitor plan>`);
  assert.doesNotMatch(text, /factory-desk|services/i);
});

test("any wake that leaves change-monitor running re-checks on a bounded schedule, one loop per head", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean, ciGreen] }, reviews: [securityClean], prComments: [stickyComment(TLSSN_37_DRAFTING)] });
  let sleeps = 0;
  const loop = (kind: "review" | "pull_request") =>
    announceReviewUpdateWithRecheck(
      { ...input, wake: kind === "review" ? { kind } : { kind, action: "synchronize" } },
      { ...deps(w), recheckMs: [5, 5, 5], sleep: async () => void (sleeps += 1) }
    );
  const [first, second] = await Promise.all([loop("review"), loop("pull_request")]);
  assert.equal(first.length + second.length, 5, "one loop of three re-reads; the other wake does not start a second");
  assert.equal(sleeps, 3, "the schedule bounds it while the plan never lands");
  assert.equal(w.posts.length, 1);
  assert.equal(w.updates, undefined, "still running: nothing to edit");
});

test("reviewing crumb: rewritten to name the gates still pending, left alone when unchanged, dropped once none are left", async () => {
  const crumb = { channel: THREAD.channelId, ts: "1790301499.000001", phase: "reviewing" };
  const w = world({ kv: { "ticket/TLSSN-28": THREAD, "loader/TLSSN-28": crumb, "review-gates/TLSSN-28": { inReview: true } }, runs: { [HEAD]: [bugbotRunning] } });
  assert.equal((await announceReviewUpdate(input, deps(w))).reason, "nothing_settled");
  assert.deepEqual(w.updates, [{ channel: THREAD.channelId, ts: crumb.ts, text: "TLSSN-28: waiting on Bugbot, security, CI…" }]);
  assert.equal(w.posts.length, 0, "a wait posts no new message");

  w.runs[HEAD] = [bugbotRunning, ciGreen];
  await announceReviewUpdate(input, deps(w));
  assert.equal(w.updates?.at(-1)?.["text"], "TLSSN-28: waiting on Bugbot, security…", "a settled gate drops off the line");
  await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps(w));
  assert.equal(w.updates?.length, 2, "the same pending set leaves the crumb alone");

  w.runs[HEAD] = [bugbotClean, ciGreen];
  w.reviews = [securityClean];
  await announceReviewUpdate(input, deps(w));
  assert.deepEqual(w.deletes, [{ channel: THREAD.channelId, ts: crumb.ts }]);
  assert.equal(w.kv["loader/TLSSN-28"], undefined);
  assert.deepEqual(w.kv["review-gates/TLSSN-28"], { pending: [], inReview: true });
});

test("reviewing crumb: a new push after every gate settled puts one back; none before In Review; an earlier phase's crumb is left alone", async () => {
  const before = world({ runs: { [HEAD]: [bugbotRunning] } });
  await announceReviewUpdate(input, deps(before));
  assert.equal(before.posts.length, 0, "no crumb before the In Review line");
  assert.deepEqual(before.kv["review-gates/TLSSN-28"], { pending: ["bugbot", "security", "ci"] });

  const implementing = { channel: THREAD.channelId, ts: "1790301499.000001", phase: "implementing" };
  const early = world({ kv: { "ticket/TLSSN-28": THREAD, "loader/TLSSN-28": implementing, "review-gates/TLSSN-28": { inReview: true } }, runs: { [HEAD]: [bugbotRunning] } });
  await announceReviewUpdate(input, deps(early));
  assert.deepEqual(early.kv["loader/TLSSN-28"], implementing);
  assert.equal(early.updates, undefined);

  const pushed = world({ kv: { "ticket/TLSSN-28": THREAD, "review-gates/TLSSN-28": { pending: [], inReview: true } }, runs: { [HEAD]: [ciGreen] } });
  await announceReviewUpdate(input, deps(pushed));
  assert.equal(pushed.posts.at(-1)?.["text"], "TLSSN-28: waiting on Bugbot, security…");
  assert.equal((pushed.kv["loader/TLSSN-28"] as Record<string, unknown>)["phase"], "reviewing");
});

test("reviewing crumb: a merged or closed PR drops it", async () => {
  const crumb = { channel: THREAD.channelId, ts: "1790301499.000001", phase: "reviewing", pending: ["security"] };
  const w = world({ kv: { "ticket/TLSSN-28": THREAD, "loader/TLSSN-28": crumb, "review-gates/TLSSN-28": { pending: ["security"], inReview: true } } });
  w.pull = { ...w.pull, state: "closed", merged: true };
  assert.equal((await announceReviewUpdate(input, deps(w))).reason, "pr_not_open");
  assert.deepEqual(w.deletes, [{ channel: THREAD.channelId, ts: crumb.ts }]);
  assert.deepEqual(w.kv["review-gates/TLSSN-28"], { pending: [] });
});

// TLSSN-38 (marsbank#33): one Actions completion woke the desk twice at once
// (check_suite and workflow_run), each wake read back its own claim from
// hosted kv, and the CI line was posted twice, 0.24 s apart. These wakes each
// get their own copy of the store, so neither ever sees the other's claim.
type ThreadMessage = { ts: string; text: string; bot_id: string };

/** `raceReads`: that many first thread reads all return before any of them does, so each sees the thread before the others post. */
function slackThread(options: { raceReads?: number } = {}) {
  const messages: ThreadMessage[] = [];
  const deleted: string[] = [];
  let seq = 0;
  let reads = 0;
  let release!: () => void;
  const raced = new Promise<void>((resolve) => (release = resolve));
  const client = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        const ts = `1790302000.${String((seq += 1)).padStart(6, "0")}`;
        messages.push({ ts, text: String(args["text"]), bot_id: "B0FACTORY" });
        return { ok: true, ts };
      },
      update: async (args: Record<string, unknown>) => {
        const message = messages.find((m) => m.ts === args["ts"]);
        if (message !== undefined) message.text = String(args["text"]);
      },
      delete: async (args: Record<string, unknown>) => {
        deleted.push(String(args["ts"]));
        messages.splice(messages.findIndex((m) => m.ts === args["ts"]), 1);
      },
    },
    apiCall: async (method: string) => {
      assert.equal(method, "conversations.replies");
      const snapshot = [{ ts: THREAD.threadTs, text: "TLSSN-28 root" }, ...messages.map((m) => ({ ...m }))];
      if (options.raceReads !== undefined && reads < options.raceReads) {
        reads += 1;
        if (reads === options.raceReads) release();
        await raced;
        return { ok: true, messages: snapshot };
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { ok: true, messages: [{ ts: THREAD.threadTs, text: "TLSSN-28 root" }, ...messages.map((m) => ({ ...m }))] };
    },
  };
  const lines = (gate: RegExp) => messages.flatMap((m) => m.text.split("\n")).filter((line) => gate.test(line));
  return { messages, deleted, client, lines };
}

/** A wake with its own view of kv (seeded from `seed`), posting into the shared thread. */
function isolatedDeps(w: World, thread: ReturnType<typeof slackThread>, at = "2026-09-25T10:00:00.000Z"): ReviewDeps {
  const own = structuredClone(w.kv);
  return { ...deps(w), kv: kvOf(own), slack: { getClient: async () => thread.client }, now: () => new Date(at) };
}

const SUITE = 501;
const ciDone = (completedAt: string, suiteId = SUITE, id = 7): CheckRunFacts => ({ ...ciGreen, id, suiteId, completedAt });
const actionsSuite = (id = SUITE) => ({ kind: "check_suite" as const, suite: { id, app: "github-actions", headSha: HEAD, conclusion: "success" } });
const workflowWake = { kind: "workflow_run" as const, workflow: { name: "CI", headSha: HEAD, conclusion: "success", htmlUrl: "https://github.com/x/actions/runs/1" } };

test("TLSSN-38: check_suite and workflow_run for one Actions run, concurrent, each seeing only its own claim, post the CI line once: the check_suite wake owns it", async () => {
  const w = world({ runs: { [HEAD]: [ciDone("2026-09-25T09:59:59.000Z")] } });
  const thread = slackThread();
  const [suite, workflow] = await Promise.all([
    announceReviewUpdate({ ...input, wake: actionsSuite() }, isolatedDeps(w, thread)),
    announceReviewUpdate({ ...input, wake: workflowWake }, isolatedDeps(w, thread)),
  ]);
  assert.equal(suite.reason, "posted_in_thread");
  assert.deepEqual(suite.components, ["ci"]);
  assert.equal(workflow.reason, "deferred");
  assert.equal(workflow.ciDeferred, true);
  assert.equal(thread.lines(/CI — passing/).length, 1);
  assert.equal(thread.messages.length, 1);
});

test("two concurrent owners of the same CI line (a redelivered check_suite), each seeing only its own claim: the later post takes itself back", async () => {
  const w = world({ runs: { [HEAD]: [ciDone("2026-09-25T09:59:59.000Z")] } });
  const thread = slackThread({ raceReads: 2 });
  const logs: string[] = [];
  const log = console.log;
  console.log = (line: string) => void logs.push(line);
  let results;
  try {
    results = await Promise.all([1, 2].map(() => announceReviewUpdate({ ...input, wake: actionsSuite() }, isolatedDeps(w, thread))));
  } finally {
    console.log = log;
  }
  assert.equal(thread.lines(/CI — passing/).length, 1, thread.messages.map((m) => m.text).join("\n---\n"));
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.deleted.length, 1, "the later of the two posts is deleted");
  assert.ok(Number(thread.deleted[0]) > Number(thread.messages[0]!.ts), "the earliest post stands");
  assert.deepEqual(results.map((r) => r.reason).sort(), ["already_announced", "posted_in_thread"]);
  assert.ok(logs.some((line) => line.includes('"outcome":"yielded_post"')));
});

test("every gate has the same guard: concurrent wakes that both settle Bugbot, security, and change review post each line once", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean] }, reviews: [securityClean], prComments: [stickyComment(TLSSN_37_PUBLISHED)] });
  const thread = slackThread({ raceReads: 2 });
  await Promise.all([1, 2].map(() => announceReviewUpdate({ ...input, wake: { kind: "review" } }, isolatedDeps(w, thread))));
  for (const gate of [/Bugbot — clean/, /Security review — clean/, /Change review — plan ready/]) assert.equal(thread.lines(gate).length, 1, String(gate));
  assert.equal(thread.messages.length, 1);
});

test("a wake that settles more gates than a concurrent one keeps only its own lines: each gate appears once across the thread", async () => {
  const only = world({ runs: { [HEAD]: [ciDone("2026-09-25T09:59:59.000Z")] } });
  const more = world({ runs: { [HEAD]: [bugbotClean, ciDone("2026-09-25T09:59:59.000Z")] } });
  const thread = slackThread({ raceReads: 2 });
  await Promise.all([
    announceReviewUpdate({ ...input, wake: actionsSuite() }, isolatedDeps(only, thread)),
    announceReviewUpdate({ ...input, wake: actionsSuite() }, isolatedDeps(more, thread)),
  ]);
  assert.equal(thread.lines(/CI — passing/).length, 1, thread.messages.map((m) => m.text).join("\n---\n"));
  assert.equal(thread.lines(/Bugbot — clean/).length, 1);
});

test("a line the thread already shows for this head is not posted again, whatever kv says; Slack's :shortcode: emoji still match", async () => {
  const w = world({ runs: { [HEAD]: [bugbotClean, ciDone("2026-09-25T09:59:59.000Z")] } });
  const thread = slackThread();
  thread.messages.push({ ts: "1790301999.000100", bot_id: "B0FACTORY", text: `TLSSN-28 review update on \`9f0ba2e\`:\n• :building_construction::white_check_mark: CI — passing · <https://github.com/${REPO}/pull/19/checks|checks>` });
  const store = structuredClone(w.kv);
  const result = await announceReviewUpdate({ ...input, wake: actionsSuite() }, { ...deps(w), kv: kvOf(store), slack: { getClient: async () => thread.client } });
  assert.deepEqual(result.components, ["bugbot"]);
  assert.equal(thread.lines(/CI — passing/).length, 1);
  assert.equal((store[`review/${REPO}#19/${HEAD}/ci`] as Record<string, unknown>)["ts"], "1790301999.000100", "the CI claim finishes on the post that carries it");

  const other = world({ runs: { [HEAD]: [ciDone("2026-09-25T09:59:59.000Z")] } });
  const elsewhere = slackThread();
  elsewhere.messages.push({ ts: "1790301999.000100", bot_id: "B0FACTORY", text: `TLSSN-28 review update on \`5e6f7a8\`:\n• 🏗️✅ CI — passing · <https://github.com/${REPO}/pull/19/checks|checks>` });
  elsewhere.messages.push({ ts: "1790301999.000200", bot_id: "B0FACTORY", text: `TLSSN-28 review update on \`9f0ba2e\`:\n• 🏗️❌ CI — failing: test · <https://github.com/x/job/1|test>` });
  await announceReviewUpdate({ ...input, wake: actionsSuite() }, { ...deps(other), slack: { getClient: async () => elsewhere.client } });
  assert.equal(elsewhere.lines(/CI — passing/).length, 2, "another head's line, or another status on this head, is not this line");
});

test("CI settled in a wake that does not own it (Bugbot's suite) waits out the quiet period in the re-check loop, then posts once if the owner never did; a workflow_run does not wait", async () => {
  const w = world({ runs: { [HEAD]: [ciDone("2026-09-25T09:59:59.000Z")] } });
  const idle = await announceReviewUpdateWithRecheck({ ...input, wake: workflowWake }, { ...deps(w), recheckMs: [60_000], sleep: async () => assert.fail("a workflow_run's check_suite owns its CI line") });
  assert.deepEqual(idle.map((r) => r.reason), ["deferred"]);

  const thread = slackThread();
  let clock = Date.parse("2026-09-25T10:00:00.000Z");
  const sleeps: number[] = [];
  const results = await announceReviewUpdateWithRecheck(
    { ...input, wake: suiteWake },
    { ...deps(w), slack: { getClient: async () => thread.client }, now: () => new Date(clock), recheckMs: [60_000, 120_000], sleep: async (ms) => void (sleeps.push(ms), (clock += ms)) }
  );
  assert.deepEqual(results.map((r) => r.reason), ["deferred", "posted_in_thread"]);
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(thread.lines(/CI — passing/).length, 1);
});

test("K4: a check_suite and a workflow_run wake left waiting on the security review both take the head's re-check lease and loop", async () => {
  const wakes = [suiteWake, { kind: "workflow_run" as const, workflow: { name: "CI", headSha: HEAD, conclusion: "success" } }];
  for (const wake of wakes) {
    const w = world({ runs: { [HEAD]: [bugbotClean, ciGreen] } });
    let sleeps = 0;
    const results = await announceReviewUpdateWithRecheck({ ...input, wake }, { ...deps(w), recheckMs: [5, 5], sleep: async () => void (sleeps += 1) });
    assert.equal(sleeps, 2, wake.kind);
    assert.equal(results.length, 3, wake.kind);
    const lease = w.kv[`review-recheck/${REPO}#19/${HEAD}`] as Record<string, unknown>;
    assert.equal(lease["state"], "pending", wake.kind);
    assert.equal(lease["until"], "2026-09-25T10:01:00.010Z", wake.kind);
  }
});

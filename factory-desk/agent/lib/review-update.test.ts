import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TLSSN_37_COMMENT_URL, TLSSN_37_DRAFTING, TLSSN_37_ESCALATION_PROSE, TLSSN_37_FACTORY_DESK, TLSSN_37_PUBLISHED, stickyComment } from "./change-monitor.fixtures.js";
import {
  CI_QUIET_MS,
  FACTORY_HOST_SERVICES,
  ownsCiAnnouncement,
  changeMonitorServices,
  changeMonitorClaimKey,
  changeMonitorResult,
  bugbotResult,
  ciResult,
  failedCiRuns,
  reviewClaimKey,
  reviewPrKey,
  reviewUpdateMessage,
  securityAnnouncedKey,
  securityClaimKey,
  securityReviewResult,
  settledComponents,
  type CheckRunFacts,
  type ReviewEvidence,
  type ReviewFacts,
} from "./review-update.js";

const REPO = "cursor-demo-lab/marsbank";
const HEAD = "9f0ba2e".padEnd(40, "0");
const OLD = "1a2b3c4".padEnd(40, "0");

// Output copied from Cursor Bugbot check runs on example-org/demo-repo (#118, #116).
const BUGBOT_CLEAN =
  "Bugbot Analysis Progress (4m 14s elapsed)\n\n✅ Gathered PR context (4s)\n✅ Completed bug detection (4m 9s)\n✅ Posted analysis results (0s)\n\n**Final Result:** Bugbot completed review - no issues found! ✅\n\nRequest ID: serverGenReqId_cc60cda0";
const BUGBOT_TWO =
  "Bugbot Analysis Progress (5m 59s elapsed)\n\n✅ Gathered PR context (3s)\n✅ Completed bug detection (5m 53s)\n✅ Posted analysis results (3s)\n\n**Final Result:** Bugbot completed review and found 2 potential issues.\n\nRequest ID: serverGenReqId_2d2b0268";
const BUGBOT_RUNNING = "Bugbot Analysis Progress (6s elapsed)\n\n✅ Gathered PR context (2s)\n\nRequest ID: serverGenReqId_edb254a3";

function bugbot(input: Partial<CheckRunFacts>): CheckRunFacts {
  return { id: 10, name: "Cursor Bugbot", app: "cursor", status: "completed", conclusion: "success", summary: BUGBOT_CLEAN, htmlUrl: `https://github.com/${REPO}/runs/10`, ...input };
}

function actions(name: string, conclusion: string | null, status = "completed"): CheckRunFacts {
  return { name, app: "github-actions", status, conclusion, htmlUrl: `https://github.com/${REPO}/actions/runs/1/job/${name}` };
}

// The body security-reviewer/agent/tools/post_findings.ts writes.
function securityReview(verdict: string, findings: string[] = [], extra: Partial<ReviewFacts> = {}): ReviewFacts {
  const body = ["## Security review", "", `**Verdict:** ${verdict}`, "Security only, on head `9f0ba2e`; Bugbot covers correctness. A new push gets a new review.", ...findings].join("\n");
  return { id: 7, authorLogin: "cursor[bot]", authorType: "Bot", body, commitId: HEAD, htmlUrl: `https://github.com/${REPO}/pull/19#pullrequestreview-7`, ...extra };
}

function evidence(input: Partial<ReviewEvidence>): ReviewEvidence {
  return { repository: REPO, number: 19, headSha: HEAD, checkRuns: [], reviews: [], ...input };
}

test("Bugbot is settled only once its check run completes: success is CLEAN, neutral carries the count", () => {
  assert.equal(bugbotResult(evidence({ checkRuns: [bugbot({ status: "in_progress", conclusion: null, summary: BUGBOT_RUNNING })] })), undefined);
  assert.deepEqual(bugbotResult(evidence({ checkRuns: [bugbot({})] })), { component: "bugbot", verdict: "clean", url: `https://github.com/${REPO}/runs/10` });
  assert.deepEqual(bugbotResult(evidence({ checkRuns: [bugbot({ conclusion: "neutral", summary: BUGBOT_TWO })] })), {
    component: "bugbot",
    verdict: "findings",
    findings: 2,
    url: `https://github.com/${REPO}/runs/10`,
  });
  assert.equal(bugbotResult(evidence({ checkRuns: [bugbot({ conclusion: "cancelled" })] })), undefined, "a run a newer push cancelled says nothing");
  assert.equal(bugbotResult(evidence({ checkRuns: [actions("test", "success")] })), undefined, "no Bugbot run, nothing to report");
});

test("a re-run of Bugbot on the same head: the latest run decides", () => {
  const runs = [bugbot({ id: 20, status: "queued", conclusion: null }), bugbot({ id: 10, conclusion: "neutral", summary: BUGBOT_TWO })];
  assert.equal(bugbotResult(evidence({ checkRuns: runs })), undefined);
});

test("without check-run access, the cursor suite's completion stands in, with the count from Bugbot's own review", () => {
  const review: ReviewFacts = {
    authorLogin: "cursor[bot]",
    authorType: "Bot",
    body: "<!-- BUGBOT_REVIEW -->\nCursor Bugbot has reviewed your changes using high effort and found 1 potential issue.\n",
    commitId: HEAD,
  };
  const suite = { app: "cursor", headSha: HEAD, conclusion: "neutral" };
  assert.deepEqual(bugbotResult({ repository: REPO, number: 19, headSha: HEAD, reviews: [review], suite }), {
    component: "bugbot",
    verdict: "findings",
    findings: 1,
    url: `https://github.com/${REPO}/pull/19/checks`,
  });
  assert.equal(bugbotResult({ repository: REPO, number: 19, headSha: HEAD, reviews: [], suite: { ...suite, app: "github-actions" } }), undefined);
  assert.equal(bugbotResult({ repository: REPO, number: 19, headSha: HEAD, reviews: [], suite: { ...suite, headSha: OLD } }), undefined);
});

test("the security review counts only the reviewer bot's review on this head, and reads the verdict and findings", () => {
  const findings = ["- **medium** `lib/report.ts:12` — CSV injection in export header", "  A cell starting with = runs as a formula.", "- **high** `api/export.ts:40` — Missing auth check on export route", "  Anyone can fetch another user's export."];
  assert.deepEqual(securityReviewResult([securityReview("FINDINGS", findings)], HEAD), {
    component: "security",
    verdict: "FINDINGS",
    bySeverity: { high: 1, medium: 1, low: 0 },
    top: "Missing auth check on export route",
    url: `https://github.com/${REPO}/pull/19#pullrequestreview-7`,
    fingerprint: securityReviewResult([securityReview("FINDINGS", findings)], HEAD)!.fingerprint,
  });
  assert.equal(securityReviewResult([securityReview("CLEAN", [], { commitId: OLD })], HEAD), undefined, "an older head's review is not this head's");
  assert.equal(securityReviewResult([securityReview("CLEAN", [], { authorLogin: "mallory", authorType: "User" })], HEAD), undefined, "a person cannot post the verdict");
  const crlf = securityReview("CLEAN");
  assert.equal(securityReviewResult([{ ...crlf, body: crlf.body.replace(/\n/g, "\r\n") }], HEAD)?.verdict, "CLEAN");
});

test("CI settles once every Actions run on the head completed, and names what failed", () => {
  assert.equal(ciResult(evidence({ checkRuns: [actions("lint", "success"), actions("test", null, "in_progress")] })), undefined);
  assert.equal(ciResult(evidence({ checkRuns: [bugbot({})] })), undefined, "no Actions runs yet");
  assert.deepEqual(ciResult(evidence({ checkRuns: [actions("lint", "success"), actions("test", "skipped")] })), { component: "ci", passing: true, failed: [] });
  assert.deepEqual(ciResult(evidence({ checkRuns: [actions("lint", "success"), actions("test", "failure")] })), {
    component: "ci",
    passing: false,
    failed: ["test"],
    url: `https://github.com/${REPO}/actions/runs/1/job/test`,
  });
  const workflow = { name: "CI", headSha: HEAD, conclusion: "failure", htmlUrl: "https://github.com/w/1" };
  assert.deepEqual(ciResult({ repository: REPO, number: 19, headSha: HEAD, reviews: [], workflow }), { component: "ci", passing: false, failed: ["CI"], url: "https://github.com/w/1" });
  assert.deepEqual(failedCiRuns([actions("lint", "failure"), actions("test", "success"), bugbot({ conclusion: "neutral" })]), ["lint"]);
});

test("one gate or several: the header, then one bullet per gate, `<emoji> <Gate> — <status> · <link>`, in a fixed order", () => {
  const base = { issueKey: "TLSSN-28", repository: REPO, number: 19, headSha: HEAD };
  const checks = `<https://github.com/${REPO}/pull/19/checks|checks>`;
  assert.equal(
    reviewUpdateMessage({ ...base, settled: settledComponents(evidence({ checkRuns: [bugbot({})] })) }),
    ["TLSSN-28 review update on `9f0ba2e`:", `• 🐛✅ Bugbot — clean · <https://github.com/${REPO}/runs/10|Bugbot run>`].join("\n")
  );
  assert.equal(
    reviewUpdateMessage({ ...base, settled: [{ component: "ci", passing: true, failed: [] }] }),
    ["TLSSN-28 review update on `9f0ba2e`:", `• 🏗️✅ CI — passing · ${checks}`].join("\n"),
    "a lone CI line is a bullet like any other gate"
  );
  const settled = settledComponents(
    evidence({
      checkRuns: [bugbot({ conclusion: "neutral", summary: BUGBOT_TWO }), actions("lint", "success"), actions("test", "failure")],
      reviews: [securityReview("FINDINGS", ["- **low** `a.ts:1` — Verbose <error> & stack"])],
      autofix: { before: OLD, failed: ["test"] },
    })
  );
  assert.equal(
    reviewUpdateMessage({ ...base, settled: [...settled].reverse() }),
    [
      "TLSSN-28 review update on `9f0ba2e`:",
      `• 🔧 Autofix — pr-autofixer pushed after CI failed on \`1a2b3c4\` (test); checks are running on the new head · <https://github.com/${REPO}/pull/19/commits/${HEAD}|9f0ba2e>`,
      `• 🐛⚠️ Bugbot — 2 findings · <https://github.com/${REPO}/runs/10|Bugbot run>`,
      `• 🔒⚠️ Security review — findings: 1 low (top: Verbose &lt;error&gt; &amp; stack) · <https://github.com/${REPO}/pull/19#pullrequestreview-7|review>`,
      `• 🏗️❌ CI — failing: test · <https://github.com/${REPO}/actions/runs/1/job/test|failed run>`,
    ].join("\n")
  );
  const line = (item: Parameters<typeof reviewUpdateMessage>[0]["settled"][number]) => reviewUpdateMessage({ ...base, settled: [item] }).split("\n")[1];
  assert.equal(line(settledComponents(evidence({ reviews: [securityReview("CLEAN")] }))[0]!), `• 🔒✅ Security review — clean · <https://github.com/${REPO}/pull/19#pullrequestreview-7|review>`);
  assert.equal(line({ component: "security", verdict: "INCOMPLETE", bySeverity: { high: 0, medium: 0, low: 0 }, fingerprint: "incomplete-x" }), "• 🔒❔ Security review — incomplete (the diff was too large to review in full)");
  assert.equal(line({ component: "bugbot", verdict: "findings", url: "https://x" }), "• 🐛⚠️ Bugbot — found issues · <https://x|Bugbot run>");
  assert.equal(line({ component: "bugbot", verdict: "unfinished", conclusion: "failure", url: "https://x" }), "• 🐛❔ Bugbot — did not finish (failure) · <https://x|Bugbot run>");
  assert.equal(line({ component: "ci", passing: false, failed: ["test"] }), `• 🏗️❌ CI — failing: test · ${checks}`);
});

test("change-monitor: a line as soon as its sticky comment (or a check) is on the PR, running until the result; nothing without one", () => {
  const sticky = (text: string, login = "cursor[bot]") => ({ authorLogin: login, authorType: login.endsWith("[bot]") ? "Bot" : "User", body: `<!-- cursor:sticky:change-monitor-plan -->\n${text}\n<!-- /cursor:sticky:change-monitor-plan -->`, htmlUrl: "https://github.com/c/1" });
  assert.deepEqual(changeMonitorResult([sticky("Rollout plan. Status: Pending. Mention @change-monitor")]), { component: "changeMonitor", verdict: "pending", url: "https://github.com/c/1" });
  assert.equal(changeMonitorResult([sticky("Status: Monitoring production")])?.verdict, "pending");
  assert.equal(changeMonitorResult([sticky("Status: Verified", "someone")]), undefined);
  assert.equal(changeMonitorResult([{ authorLogin: "cursor[bot]", body: "Status: Verified" }]), undefined);
  assert.equal(changeMonitorResult([]), undefined);
  for (const prose of ["Status: Verified in production", "Status: Attention — error rate up", "Watch stopped"]) assert.equal(changeMonitorResult([sticky(prose)])?.verdict, "pending", `prose is not a state: ${prose}`);
  const run = (status: string, conclusion: string | null) => ({ id: 7, name: "change-monitor", status, conclusion, htmlUrl: "https://github.com/r/7" });
  assert.deepEqual(changeMonitorResult([], [run("in_progress", null)]), { component: "changeMonitor", verdict: "pending", url: "https://github.com/r/7" });
  assert.equal(changeMonitorResult([], [run("completed", "success")])?.verdict, "verified");
  assert.equal(changeMonitorResult([], [run("completed", "failure")])?.verdict, "attention");
  assert.equal(changeMonitorResult([sticky("Status: Pending")], [run("completed", "failure")])?.verdict, "attention", "a check's result stands while the sticky comment still says Pending");
  assert.equal(changeMonitorResult([], [bugbot({}), actions("test", "success")]), undefined);

  const base = { issueKey: "TLSSN-28", repository: REPO, number: 19, headSha: HEAD };
  assert.equal(
    reviewUpdateMessage({ ...base, settled: settledComponents(evidence({ checkRuns: [bugbot({})], comments: [sticky("Status: Pending")] })) }),
    ["TLSSN-28 review update on `9f0ba2e`:", `• 🐛✅ Bugbot — clean · <https://github.com/${REPO}/runs/10|Bugbot run>`, "• 📡❔ Change review — running · <https://github.com/c/1|change-monitor plan>"].join("\n")
  );
  const line = (verdict: "verified" | "attention" | "incomplete") => reviewUpdateMessage({ ...base, settled: [{ component: "changeMonitor", verdict, url: "https://github.com/c/1" }] }).split("\n")[1];
  assert.equal(line("verified"), "• 📡✅ Change review — verified · <https://github.com/c/1|change-monitor plan>");
  assert.equal(line("attention"), "• 📡⚠️ Change review — needs attention · <https://github.com/c/1|change-monitor plan>");
  assert.equal(line("incomplete"), "• 📡⚠️ Change review — stopped without a verdict · <https://github.com/c/1|change-monitor plan>");
  assert.equal(settledComponents(evidence({ checkRuns: [bugbot({})] })).some((item) => item.component === "changeMonitor"), false, "no sticky comment and no check: no change-monitor line");
});

test("TLSSN-37 / marsbank#32: change-monitor's state comes from the comment's structure: running while it drafts, plan ready with the cursor:plan marker, whatever its prose says", () => {
  assert.deepEqual(changeMonitorResult([stickyComment(TLSSN_37_DRAFTING)]), { component: "changeMonitor", verdict: "pending", url: TLSSN_37_COMMENT_URL });
  assert.match(TLSSN_37_PUBLISHED, /users may think restore failed/, "#32's own risk line");
  assert.deepEqual(changeMonitorResult([stickyComment(TLSSN_37_PUBLISHED)]), { component: "changeMonitor", verdict: "planned", url: TLSSN_37_COMMENT_URL, services: ["marsbank-web"] }, "\"restore failed\" in the plan is not a result");
  assert.equal(changeMonitorResult([stickyComment(TLSSN_37_ESCALATION_PROSE)])?.verdict, "planned", "no documented attention marker: prose never flips it to ⚠️");
  assert.equal(changeMonitorResult([stickyComment(TLSSN_37_DRAFTING.replace("Reading this", "Verified. Attention: stopped; failed. Reading this"))])?.verdict, "pending");

  const run = (conclusion: string) => ({ id: 3, name: "change-monitor", status: "completed", conclusion, htmlUrl: "https://github.com/r/3" });
  assert.equal(changeMonitorResult([stickyComment(TLSSN_37_PUBLISHED)], [run("failure")])?.verdict, "attention", "a check run's conclusion is structured and wins");
  assert.equal(changeMonitorResult([stickyComment(TLSSN_37_PUBLISHED)], [run("success")])?.verdict, "verified");

  const base = { issueKey: "TLSSN-37", repository: REPO, number: 32, headSha: "fc478b1".padEnd(40, "0") };
  assert.equal(
    reviewUpdateMessage({ ...base, settled: [changeMonitorResult([stickyComment(TLSSN_37_PUBLISHED)])!] }),
    ["TLSSN-37 review update on `fc478b1`:", `• 📡✅ Change review — plan ready (services: marsbank-web) · <${TLSSN_37_COMMENT_URL}|change-monitor plan>`].join("\n")
  );
});

test("marsbank change reviews: Rollouts' `Services: factory-desk` is the factory's own host, so the 📡 line leaves services out", () => {
  const result = changeMonitorResult([stickyComment(TLSSN_37_FACTORY_DESK)]);
  assert.deepEqual(result, { component: "changeMonitor", verdict: "planned", url: TLSSN_37_COMMENT_URL });
  const base = { issueKey: "TLSSN-37", repository: REPO, number: 32, headSha: "fc478b1".padEnd(40, "0") };
  const line = reviewUpdateMessage({ ...base, settled: [result!] }).split("\n")[1];
  assert.equal(line, `• 📡✅ Change review — plan ready · <${TLSSN_37_COMMENT_URL}|change-monitor plan>`);
  assert.doesNotMatch(line ?? "", /factory-desk|services/i);

  const run = { id: 3, name: "change-monitor", status: "completed", conclusion: "success", htmlUrl: "https://github.com/r/3" };
  assert.equal(changeMonitorResult([stickyComment(TLSSN_37_FACTORY_DESK)], [run])?.services, undefined, "a verified run keeps the desk out too");
  assert.deepEqual(changeMonitorResult([stickyComment(TLSSN_37_PUBLISHED)], [run])?.services, ["marsbank-web"], "a verified run keeps real services from the published plan");
});

test("FACTORY_HOST_SERVICES is every --slug the deploy guide ships", () => {
  const guide = readFileSync(new URL("../../../docs/factory-deployment.md", import.meta.url), "utf8");
  const slugs = [...new Set([...guide.matchAll(/--slug (factory-[a-z-]+)/g)].map((match) => match[1]))];
  assert.deepEqual([...FACTORY_HOST_SERVICES].sort(), slugs.sort());
});

test("change-monitor services: the plan marker first, else the Services: line, minus every factory host, empty when unknown", () => {
  const marker = (plan: unknown) => `<!-- cursor:plan:${Buffer.from(JSON.stringify(plan)).toString("base64")} -->`;
  const body = (...lines: string[]) => ["<!-- cursor:sticky:change-monitor-plan -->", "### Change monitor", ...lines].join("\n");

  assert.deepEqual(changeMonitorServices(body("Services: factory-desk", marker({ services: ["marsbank-web", "marsbank-api"] }))), ["marsbank-web", "marsbank-api"], "the structured marker wins over the line");
  assert.deepEqual(changeMonitorServices(body("Services: marsbank-web", marker({ services: [{ slug: "marsbank-api" }, { name: "marsbank-web" }] }))), ["marsbank-api", "marsbank-web"], "service objects by slug or name");
  assert.deepEqual(changeMonitorServices(body("Services: `marsbank-web`, [marsbank-api](https://x), factory-desk", marker({ signals: [] }))), ["marsbank-web", "marsbank-api"], "no list in the marker: the line, with markup dropped");
  assert.deepEqual(changeMonitorServices(body("Services: marsbank-web", marker({ services: [] }))), [], "an explicit empty list means none, not the line");
  assert.deepEqual(changeMonitorServices(body("Services: marsbank-web", marker({ services: [" ", {}] }))), [], "a list of blanks is still the marker's answer");
  assert.deepEqual(changeMonitorServices(body("Services: marsbank-web", "<!-- cursor:plan:%%% -->")), ["marsbank-web"], "an unreadable marker falls back to the line");
  assert.deepEqual(changeMonitorServices(body("services: Factory-Desk, factory-planner, FACTORY-WORKER", marker({ services: [] }))), [], "only factory hosts: none");
  assert.deepEqual(changeMonitorServices(body("Services: marsbank-web, Marsbank-Web")), ["marsbank-web"], "deduped case-insensitively");
  assert.deepEqual(changeMonitorServices(body("Plan text", "<details>", "Services: marsbank-web", "</details>")), [], "a Services: line inside the Plan block is not the header's");
  assert.deepEqual(changeMonitorServices(body("No services named.")), []);
  for (const slug of FACTORY_HOST_SERVICES) assert.deepEqual(changeMonitorServices(body(`Services: ${slug}`)), [], slug);

  const base = { issueKey: "TLSSN-37", repository: REPO, number: 32, headSha: HEAD };
  const line = (services: string[]) => reviewUpdateMessage({ ...base, settled: [{ component: "changeMonitor", verdict: "planned", url: "https://github.com/c/1", services }] }).split("\n")[1];
  assert.equal(line(["a", "b", "c", "d", "e"]), "• 📡✅ Change review — plan ready (services: a, b, c and 2 more) · <https://github.com/c/1|change-monitor plan>");
  assert.equal(line(["<x&y>"]), "• 📡✅ Change review — plan ready (services: &lt;x&amp;y&gt;) · <https://github.com/c/1|change-monitor plan>");
});

test("each change-monitor state on a head has its own claim; verified, attention, and a stopped watch keep the per-head key", () => {
  const head = { repository: REPO, number: 32, headSha: HEAD };
  assert.equal(changeMonitorClaimKey({ ...head, verdict: "pending" }), `review/${REPO}#32/${HEAD}/changeMonitor-pending`);
  assert.equal(changeMonitorClaimKey({ ...head, verdict: "planned" }), `review/${REPO}#32/${HEAD}/changeMonitor-planned`);
  for (const verdict of ["verified", "attention", "incomplete"] as const) assert.equal(changeMonitorClaimKey({ ...head, verdict }), `review/${REPO}#32/${HEAD}/changeMonitor`);
});

test("the claim is per PR, head, and gate", () => {
  assert.equal(reviewClaimKey({ repository: "Cursor-Demo-Lab/Marsbank", number: 19, headSha: HEAD.toUpperCase(), component: "bugbot" }), `review/cursor-demo-lab/marsbank#19/${HEAD}/bugbot`);
  assert.notEqual(reviewClaimKey({ repository: REPO, number: 19, headSha: HEAD, component: "bugbot" }), reviewClaimKey({ repository: REPO, number: 19, headSha: OLD, component: "bugbot" }));
});

test("the security fingerprint is the verdict, the findings, and the unreviewed files, never the head or a line number", () => {
  const fp = (verdict: string, lines: string[] = [], extra: Partial<ReviewFacts> = {}) => securityReviewResult([securityReview(verdict, lines, extra)], extra.commitId ?? HEAD)!.fingerprint;
  const onOld = securityReview("CLEAN", [], { commitId: OLD });
  const clean = fp("CLEAN");
  assert.match(clean, /^clean-[0-9a-f]{16}$/);
  assert.equal(fp("CLEAN", [], { commitId: OLD, body: onOld.body.replace("`9f0ba2e`", "`1a2b3c4`") }), clean, "another head, same verdict");

  const auth = ["- **high** `api/export.ts:40` — Missing auth check", "  Anyone can fetch it."];
  const csv = ["- **low** `lib/report.ts:12` — CSV injection", "  Formula cells."];
  assert.notEqual(fp("FINDINGS", auth), clean, "a changed verdict");
  assert.equal(fp("FINDINGS", ["- **high** `api/export.ts:57` — Missing  auth check", "  Moved down."]), fp("FINDINGS", auth), "a finding that only moved lines");
  assert.equal(fp("FINDINGS", [...csv, ...auth]), fp("FINDINGS", [...auth, ...csv]), "finding order");
  assert.notEqual(fp("FINDINGS", [...auth, ...csv]), fp("FINDINGS", auth), "a new finding");
  assert.notEqual(fp("FINDINGS", ["- **high** `api/admin.ts:40` — Missing auth check", "  Now here."]), fp("FINDINGS", auth), "the same finding in another file");
  assert.notEqual(fp("FINDINGS", ["- **medium** `api/export.ts:40` — Missing auth check", "  Lowered."]), fp("FINDINGS", auth), "a severity change");

  const cut = (files: string[]) => ["", "Partial review: diff truncated at 150000 of 180000 chars.", `Not fully reviewed: ${files.map((f) => `\`${f}\``).join(", ")}`];
  assert.equal(fp("INCOMPLETE", cut(["b.ts", "a.ts"])), fp("INCOMPLETE", cut(["a.ts", "b.ts"])));
  assert.notEqual(fp("INCOMPLETE", cut(["a.ts", "b.ts"])), fp("INCOMPLETE", cut(["a.ts"])), "a different unreviewed scope");
});

test("the security claim is per PR, fingerprint, and the head of the verdict it follows", () => {
  assert.equal(securityClaimKey({ repository: "Cursor-Demo-Lab/Marsbank", number: 19, fingerprint: "clean-abc" }), "review/cursor-demo-lab/marsbank#19/security/clean-abc/after/none");
  assert.equal(securityClaimKey({ repository: REPO, number: 19, fingerprint: "clean-abc", after: OLD.toUpperCase() }), `review/${REPO}#19/security/clean-abc/after/${OLD}`);
  assert.equal(securityAnnouncedKey({ repository: "Cursor-Demo-Lab/Marsbank", number: 19 }), "review-security/cursor-demo-lab/marsbank#19");
});

test("a PR belongs to a ticket by its branch, or by its title only when the Cursor bot opened it", () => {
  const projects = ["TLSSN"];
  assert.equal(reviewPrKey({ headRef: "TLSSN-28-csv-export", title: "anything", authorLogin: "example-user", projects }), "TLSSN-28");
  assert.equal(reviewPrKey({ headRef: "cursor/fix", title: "TLSSN-28: CSV export", authorLogin: "cursor[bot]", projects }), "TLSSN-28");
  assert.equal(reviewPrKey({ headRef: "cursor/fix", title: "TLSSN-28: CSV export", authorLogin: "example-user", projects }), undefined);
  assert.equal(reviewPrKey({ headRef: "TLSSN-28-x", projects: [] }), undefined);
});

test("ownsCiAnnouncement: the github-actions suite holding the last CI run to finish owns the CI line; workflow_run never does; any other wake only after the quiet period", () => {
  const now = new Date("2026-09-25T10:00:00.000Z");
  const run = (id: number, suiteId: number, completedAt: string) => ({ id, name: `job-${id}`, app: "github-actions", status: "completed", conclusion: "success", suiteId, completedAt });
  const runs = [run(1, 501, "2026-09-25T09:59:50.000Z"), run(2, 502, "2026-09-25T09:59:58.000Z")];
  const suite = (id: number | undefined, app = "github-actions") => ({ ...(id === undefined ? {} : { id }), app, headSha: "a".repeat(40), conclusion: "success" });
  assert.equal(ownsCiAnnouncement({ checkRuns: runs, suite: suite(502) }, now), true, "the suite that finished last");
  assert.equal(ownsCiAnnouncement({ checkRuns: runs, suite: suite(501) }, now), false, "an earlier workflow's suite finishing at nearly the same time");
  assert.equal(ownsCiAnnouncement({ checkRuns: runs, suite: suite(undefined) }, now), true, "a suite id July did not give");
  assert.equal(ownsCiAnnouncement({ checkRuns: runs }, now), false, "workflow_run, a review, or Bugbot's suite right after CI finished");
  assert.equal(ownsCiAnnouncement({ checkRuns: runs, suite: suite(9, "cursor") }, now), false);
  assert.equal(ownsCiAnnouncement({ checkRuns: runs }, new Date(Date.parse("2026-09-25T09:59:58.000Z") + CI_QUIET_MS)), true, "once the owner has had its turn");
  assert.equal(ownsCiAnnouncement({ checkRuns: [{ name: "t", app: "github-actions", status: "completed", conclusion: "success" }] }, now), true, "no finish time known: no bar");
  assert.equal(ownsCiAnnouncement({ suite: suite(502) }, now), true, "check runs unreadable: the Actions suite wake still owns it");
  assert.equal(ownsCiAnnouncement({}, now), false, "check runs unreadable: workflow_run never announces");
});

// A review update is its gates: each bullet already says the gate, its state,
// and the link. A `Summary:` line would only restate those bullets, so there
// is none; the ticket's Summary was in the filing prompt and the plan post.
test("a review update carries no Summary line: the header and one bullet per settled gate", () => {
  const text = reviewUpdateMessage({
    issueKey: "TLSSN-46",
    repository: "cursor-demo-lab/marsbank",
    number: 38,
    headSha: "abc1234def",
    settled: [
      { component: "bugbot", verdict: "findings", findings: 1, url: "https://github.com/cursor-demo-lab/marsbank/pull/38/checks" },
      { component: "ci", passing: true, failed: [] },
    ],
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "TLSSN-46 review update on `abc1234`:");
  assert.equal(lines.length, 3);
  assert.ok(lines.slice(1).every((line) => line.startsWith("\u2022 ")));
  assert.doesNotMatch(text, /Summary:/);
});

// The one ungated production change in K16: FACTORY_HOST_SERVICES gained the
// six -staging slugs. A plan that names no staging slug must render the same
// services as main's six-slug list did.
const MAIN_HOST_SERVICES = ["factory-triage-jira", "factory-planner", "factory-worker", "factory-desk", "factory-pr-autofixer", "factory-security-reviewer"];

test("production parity: with no -staging slug named, change-monitor services match main's six-slug filter", () => {
  const body = (...lines: string[]) => ["<!-- cursor:sticky:change-monitor-plan -->", "### Change monitor", ...lines].join("\n");
  const marker = (plan: unknown) => `<!-- cursor:plan:${Buffer.from(JSON.stringify(plan)).toString("base64")} -->`;
  const mainFilter = (names: string[]) => [...new Set(names.map((name) => name.trim()).filter((name) => name !== "" && !MAIN_HOST_SERVICES.includes(name.toLowerCase())))];
  const cases: string[][] = [
    ["marsbank-web"],
    ["marsbank-web", "factory-desk"],
    ["factory-planner", "factory-worker"],
    ["marsbank-api", "Factory-Desk", "marsbank-web"],
    ["factory-desk-v2", "marsbank-web"],
    [],
  ];
  for (const names of cases) {
    assert.ok(names.every((name) => !name.toLowerCase().endsWith("-staging")));
    assert.deepEqual(changeMonitorServices(body(marker({ services: names }))), mainFilter(names), JSON.stringify(names));
    if (names.length > 0) assert.deepEqual(changeMonitorServices(body(`Services: ${names.join(", ")}`)), mainFilter(names), `line ${JSON.stringify(names)}`);
  }
  assert.deepEqual([...FACTORY_HOST_SERVICES].filter((name) => !name.endsWith("-staging")), MAIN_HOST_SERVICES);
});

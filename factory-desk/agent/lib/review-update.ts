// Pure: what the PR's quality gates settled on its current head, and the
// "review update" line the ticket's Slack thread hears. review-announce.ts
// owns the GitHub reads, the claims, and the post. Only terminal results
// count: a gate still running, or one a newer push cancelled, says nothing.

import { createHash } from "node:crypto";
import { factoryPrKey } from "./factory-pr-key.js";
import { escapeMrkdwn, fitPlain, link } from "./plan-post.js";
import { changeMonitorClaimKey, changeMonitorMessageKey, changeMonitorPendingKey, reviewClaimKey, reviewMessageKey, securityAnnouncedKey, securityClaimKey } from "./kv-keys.js";

export { changeMonitorClaimKey, changeMonitorMessageKey, changeMonitorPendingKey, reviewClaimKey, reviewMessageKey, securityAnnouncedKey, securityClaimKey };

export type ReviewComponent = "autofix" | "bugbot" | "security" | "ci" | "changeMonitor";

/** The order components are listed in one update. */
export const COMPONENT_ORDER: readonly ReviewComponent[] = ["autofix", "bugbot", "security", "ci", "changeMonitor"];

/** The prefix each settled gate's line starts with, by component and verdict. */
export const REVIEW_EMOJI = {
  bugbot: { clean: "🐛✅", findings: "🐛⚠️", unfinished: "🐛❔" },
  security: { CLEAN: "🔒✅", FINDINGS: "🔒⚠️", INCOMPLETE: "🔒❔" },
  ci: { passing: "🏗️✅", failing: "🏗️❌" },
  changeMonitor: { pending: "📡❔", planned: "📡✅", verified: "📡✅", attention: "📡⚠️", incomplete: "📡⚠️" },
  autofix: "🔧",
} as const;

export function componentEmoji(item: Settled): string {
  switch (item.component) {
    case "bugbot":
      return REVIEW_EMOJI.bugbot[item.verdict];
    case "security":
      return REVIEW_EMOJI.security[item.verdict];
    case "ci":
      return item.passing ? REVIEW_EMOJI.ci.passing : REVIEW_EMOJI.ci.failing;
    case "autofix":
      return REVIEW_EMOJI.autofix;
    case "changeMonitor":
      return REVIEW_EMOJI.changeMonitor[item.verdict];
  }
}

export type CheckRunFacts = {
  id?: number;
  name: string;
  app?: string;
  status: string;
  conclusion?: string | null;
  summary?: string | null;
  htmlUrl?: string;
  /** The check suite the run belongs to (one per Actions workflow run). */
  suiteId?: number;
  completedAt?: string;
};

export type ReviewFacts = {
  id?: number;
  authorLogin?: string;
  authorType?: string;
  body: string;
  commitId?: string;
  htmlUrl?: string;
};

export type CommentFacts = { authorLogin?: string; authorType?: string; body: string; htmlUrl?: string };

/** A `check_suite completed` wake; its conclusion stands in when the check runs cannot be read. */
export type SuiteFacts = { id?: number; app?: string; headSha: string; conclusion?: string | null };

/** A `workflow_run completed` wake, used when the check runs cannot be read. */
export type WorkflowFacts = { name?: string; headSha: string; conclusion?: string | null; htmlUrl?: string };

export type ReviewEvidence = {
  repository: string;
  number: number;
  headSha: string;
  /** Every check run on the head, or undefined when the token cannot read them. */
  checkRuns?: readonly CheckRunFacts[];
  reviews: readonly ReviewFacts[];
  suite?: SuiteFacts;
  workflow?: WorkflowFacts;
  /** PR conversation comments; change-monitor's sticky plan comment is one. */
  comments?: readonly CommentFacts[];
  /** A bot push onto a head whose CI had failed: the push, and what failed before it. */
  autofix?: { before: string; failed: readonly string[] };
};

export type Settled =
  | { component: "bugbot"; verdict: "clean" | "findings" | "unfinished"; findings?: number; conclusion?: string; url: string }
  | { component: "security"; verdict: "CLEAN" | "FINDINGS" | "INCOMPLETE"; bySeverity: Record<Severity, number>; top?: string; url?: string; fingerprint: string }
  | { component: "ci"; passing: boolean; failed: readonly string[]; url?: string }
  | { component: "autofix"; before: string; failed: readonly string[] }
  | { component: "changeMonitor"; verdict: "pending" | "planned" | "verified" | "attention" | "incomplete"; url?: string; services?: readonly string[] };

type Severity = "high" | "medium" | "low";

const PASSING = new Set(["success", "neutral", "skipped"]);
// A newer push cancels the older head's runs; that head is not reported.
const SUPERSEDED = new Set(["cancelled", "stale"]);

/** Every gate the evidence shows settled on the head, in listing order. */
export function settledComponents(evidence: ReviewEvidence): Settled[] {
  const found: Settled[] = [];
  if (evidence.autofix !== undefined) found.push({ component: "autofix", ...evidence.autofix });
  const bugbot = bugbotResult(evidence);
  if (bugbot !== undefined) found.push(bugbot);
  const security = securityReviewResult(evidence.reviews, evidence.headSha);
  if (security !== undefined) found.push(security);
  const ci = ciResult(evidence);
  if (ci !== undefined) found.push(ci);
  const changeMonitor = changeMonitorResult(evidence.comments ?? [], evidence.checkRuns ?? []);
  if (changeMonitor !== undefined) found.push(changeMonitor);
  return found;
}

export function isBugbotRun(run: CheckRunFacts): boolean {
  return /^cursor bugbot\b/i.test(run.name.trim());
}

const BUGBOT_COUNT = /found (\d{1,4}) (?:new )?potential issues?/i;
const BUGBOT_REVIEW = "<!-- BUGBOT_REVIEW -->";

/**
 * Bugbot is one `Cursor Bugbot` check run in the `cursor` app's suite:
 * `success` with "no issues found", `neutral` with "found N potential
 * issues" (it also leaves a `<!-- BUGBOT_REVIEW -->` PR review saying the
 * same). When the check runs cannot be read, the cursor suite's own
 * completion stands in, with the count from that review.
 */
export function bugbotResult(evidence: ReviewEvidence): Extract<Settled, { component: "bugbot" }> | undefined {
  const checks = `https://github.com/${evidence.repository}/pull/${evidence.number}/checks`;
  const fromReview = bugbotReviewCount(evidence.reviews, evidence.headSha);
  if (evidence.checkRuns !== undefined) {
    const run = evidence.checkRuns.filter(isBugbotRun).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).at(-1);
    if (run === undefined || run.status !== "completed") return undefined;
    return bugbotVerdict(run.conclusion ?? undefined, countIn(run.summary) ?? fromReview, run.htmlUrl ?? checks);
  }
  const suite = evidence.suite;
  if (suite === undefined || suite.app !== "cursor" || suite.headSha.toLowerCase() !== evidence.headSha.toLowerCase()) return undefined;
  return bugbotVerdict(suite.conclusion ?? undefined, fromReview, checks);
}

function bugbotVerdict(conclusion: string | undefined, findings: number | undefined, url: string): Extract<Settled, { component: "bugbot" }> | undefined {
  if (conclusion === undefined || SUPERSEDED.has(conclusion) || conclusion === "skipped") return undefined;
  if (conclusion === "success") return { component: "bugbot", verdict: "clean", url };
  if (conclusion === "neutral") return { component: "bugbot", verdict: "findings", ...(findings === undefined ? {} : { findings }), url };
  return { component: "bugbot", verdict: "unfinished", conclusion, url };
}

function countIn(text: string | null | undefined): number | undefined {
  const match = text?.match(BUGBOT_COUNT);
  return match === null || match === undefined ? undefined : Number(match[1]);
}

function bugbotReviewCount(reviews: readonly ReviewFacts[], headSha: string): number | undefined {
  const review = reviews.filter((item) => isBot(item) && item.body.includes(BUGBOT_REVIEW) && sameSha(item.commitId, headSha)).at(-1);
  return countIn(review?.body);
}

const SECURITY_HEAD = /^## Security review\s*\n\s*\n\*\*Verdict:\*\* (CLEAN|FINDINGS|INCOMPLETE)\b/;
const SECURITY_FINDING = /^- \*\*(high|medium|low)\*\* `([^`\n]*)` — (.+)$/gm;
const SECURITY_UNREVIEWED = /^Not fully reviewed: (.+)$/m;

/**
 * factory-security-reviewer posts one `COMMENT` review per head as the Cursor
 * bot, opening with `## Security review` and `**Verdict:**`
 * (security-reviewer/agent/tools/post_findings.ts `reviewBody`). The latest
 * one on this head counts; a person's review with the same text does not.
 * `fingerprint` is what the review concluded, not where: see
 * `securityFingerprint`.
 */
export function securityReviewResult(reviews: readonly ReviewFacts[], headSha: string): Extract<Settled, { component: "security" }> | undefined {
  const review = reviews
    .filter((item) => isBot(item) && sameSha(item.commitId, headSha) && SECURITY_HEAD.test(normalize(item.body)))
    .at(-1);
  if (review === undefined) return undefined;
  const body = normalize(review.body);
  const verdict = SECURITY_HEAD.exec(body)![1] as "CLEAN" | "FINDINGS" | "INCOMPLETE";
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  let top: { rank: number; title: string } | undefined;
  const findings: SecurityFinding[] = [];
  for (const match of body.matchAll(SECURITY_FINDING)) {
    const severity = match[1] as Severity;
    bySeverity[severity] += 1;
    const rank = ["high", "medium", "low"].indexOf(severity);
    const title = match[3]!.trim();
    if (top === undefined || rank < top.rank) top = { rank, title };
    findings.push({ severity, file: match[2]!.replace(/:\d+$/, ""), title });
  }
  const unreviewed = [...(SECURITY_UNREVIEWED.exec(body)?.[1] ?? "").matchAll(/`([^`\n]*)`/g)].map((match) => match[1]!);
  return {
    component: "security",
    verdict,
    bySeverity,
    ...(top === undefined ? {} : { top: top.title }),
    ...(review.htmlUrl === undefined ? {} : { url: review.htmlUrl }),
    fingerprint: securityFingerprint({ verdict, findings, unreviewed }),
  };
}

export type SecurityFinding = { severity: Severity; file: string; title: string };

/**
 * The part of a security review that is news to the ticket's thread: the
 * verdict, each finding by severity, file, and title, and the files the
 * review could not read in full. The head, the scope line, and finding line
 * numbers are left out, so a push that only moves code keeps the
 * fingerprint; a new, dropped, or moved finding, or a different cut, does not.
 */
export function securityFingerprint(input: { verdict: string; findings: readonly SecurityFinding[]; unreviewed: readonly string[] }): string {
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  const canonical = JSON.stringify({
    verdict: input.verdict,
    findings: input.findings.map((item) => [item.severity, squash(item.file), squash(item.title).toLowerCase()].join("\u0000")).sort(),
    unreviewed: input.unreviewed.map(squash).sort(),
  });
  return `${input.verdict.toLowerCase()}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/**
 * CI is every GitHub Actions check run on the head, settled once there is at
 * least one and all of them completed. When the check runs cannot be read,
 * the completed workflow run that woke the desk stands in.
 */
export function ciResult(evidence: ReviewEvidence): Extract<Settled, { component: "ci" }> | undefined {
  if (evidence.checkRuns !== undefined) {
    const runs = evidence.checkRuns.filter((run) => run.app === "github-actions");
    if (runs.length === 0 || runs.some((run) => run.status !== "completed")) return undefined;
    if (runs.some((run) => SUPERSEDED.has(run.conclusion ?? ""))) return undefined;
    const failing = runs.filter((run) => !PASSING.has(run.conclusion ?? ""));
    const url = failing[0]?.htmlUrl;
    return { component: "ci", passing: failing.length === 0, failed: failing.map((run) => run.name), ...(url === undefined ? {} : { url }) };
  }
  const suite = evidence.suite;
  if (suite?.app === "github-actions" && sameSha(suite.headSha, evidence.headSha)) {
    const conclusion = suite.conclusion ?? "";
    if (conclusion === "" || SUPERSEDED.has(conclusion)) return undefined;
    const passing = PASSING.has(conclusion);
    return { component: "ci", passing, failed: passing ? [] : ["workflow"] };
  }
  const workflow = evidence.workflow;
  if (workflow === undefined || !sameSha(workflow.headSha, evidence.headSha)) return undefined;
  const conclusion = workflow.conclusion ?? "";
  if (conclusion === "" || SUPERSEDED.has(conclusion)) return undefined;
  const passing = PASSING.has(conclusion);
  return {
    component: "ci",
    passing,
    failed: passing ? [] : [workflow.name ?? "workflow"],
    ...(passing || workflow.htmlUrl === undefined ? {} : { url: workflow.htmlUrl }),
  };
}

// Past this long after the last Actions run finished, the owning wake's claim
// is readable by any later wake, so a later one may announce CI too.
export const CI_QUIET_MS = 45_000;

/**
 * Whether this wake may announce the CI line. One Actions completion wakes
 * the desk twice at once, `check_suite` and `workflow_run` (TLSSN-36 and
 * TLSSN-38 posted the CI line twice, 0.24 s apart), and hosted kv gives
 * those two concurrent sessions neither compare-and-set nor each other's
 * fresh writes, so a shared claim cannot pick one of them. The owner is
 * decided from the data instead: the `github-actions` check_suite wake whose
 * suite holds the Actions run that finished last (one suite per workflow
 * run, so of several workflows finishing together only the last one's wake
 * owns it). `workflow_run` never announces CI. Any other wake (Bugbot's
 * suite, a review, a re-check) announces it only once the last run has been
 * finished for `CI_QUIET_MS`, in case the owning wake never came. A run
 * whose finish time is unknown puts no bar on it.
 */
export function ownsCiAnnouncement(evidence: Pick<ReviewEvidence, "checkRuns" | "suite">, now: Date): boolean {
  const runs = (evidence.checkRuns ?? []).filter((run) => run.app === "github-actions" && run.status === "completed");
  const last = runs
    .filter((run) => run.completedAt !== undefined && Number.isFinite(Date.parse(run.completedAt)))
    .sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!) || (a.id ?? 0) - (b.id ?? 0))
    .at(-1);
  const suite = evidence.suite;
  if (suite?.app === "github-actions") return suite.id === undefined || last?.suiteId === undefined || suite.id === last.suiteId;
  if (evidence.checkRuns === undefined) return false;
  if (last === undefined) return runs.length > 0;
  return now.getTime() - Date.parse(last.completedAt!) >= CI_QUIET_MS;
}

const CHANGE_MONITOR_MARKER = "cursor:sticky:change-monitor-plan";
// Change-monitor's published plan carries its machine-readable copy in this marker.
const CHANGE_MONITOR_PLAN = "<!-- cursor:plan:";
const CHANGE_MONITOR_RUN = /\bchange[- ]?monitor\b/i;

type ChangeMonitorVerdict = Extract<Settled, { component: "changeMonitor" }>["verdict"];

/**
 * Change-monitor (Rollouts) keeps one sticky `cursor[bot]` issue comment per
 * PR, marked `cursor:sticky:change-monitor-plan`, and edits it as it goes.
 * The state is read from its structure only, never its prose: a plan's
 * summary says things like "Users may think restore failed" (marsbank#32),
 * which is not a result. Without the `<!-- cursor:plan:… -->` marker it is
 * still drafting (`pending`: the thread hears it is running, with the link);
 * with it the plan is published (`planned`). Its documented output has no
 * attention or escalation marker, so a comment never reads as one. A check
 * run named for change-monitor, where a repository has one, is structured
 * too: its conclusion (verified, attention, a stopped watch) wins over the
 * comment. The comment is per PR, not per head, so the claim key's head
 * scopes it: a new push can report the same state again.
 */
export function changeMonitorResult(comments: readonly CommentFacts[], checkRuns: readonly CheckRunFacts[] = []): Extract<Settled, { component: "changeMonitor" }> | undefined {
  const comment = comments
    .filter((item) => isBotPush({ ...(item.authorLogin === undefined ? {} : { login: item.authorLogin }), ...(item.authorType === undefined ? {} : { type: item.authorType }) }) && item.body.includes(CHANGE_MONITOR_MARKER))
    .at(-1);
  const run = checkRuns.filter((item) => CHANGE_MONITOR_RUN.test(item.name) || CHANGE_MONITOR_RUN.test(item.app ?? "")).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).at(-1);
  if (comment === undefined && run === undefined) return undefined;
  const fromRun = run === undefined ? undefined : runVerdict(run);
  const fromComment = comment?.body.includes(CHANGE_MONITOR_PLAN) === true ? "planned" : undefined;
  const verdict = fromRun ?? fromComment ?? "pending";
  const url = comment?.htmlUrl ?? run?.htmlUrl;
  const services = fromComment === undefined ? [] : changeMonitorServices(comment!.body);
  return { component: "changeMonitor", verdict, ...(url === undefined ? {} : { url }), ...(services.length === 0 ? {} : { services }) };
}

/**
 * The factory's own hosts, as `agent-sdk deploy --slug` names them
 * (docs/factory-deployment.md). The deploy pipeline makes each slug a Factory
 * catalog service, deployed from apj-gtm, so none of them is ever a service a
 * `FACTORY_REPOS` pull request changes. Rollouts linked `factory-desk` to
 * marsbank changes and wrote `Services: factory-desk` into its comment.
 */
export const FACTORY_HOST_SERVICES: readonly string[] = [
  "factory-triage-jira",
  "factory-planner",
  "factory-worker",
  "factory-desk",
  "factory-pr-autofixer",
  "factory-security-reviewer",
  "factory-triage-jira-staging",
  "factory-planner-staging",
  "factory-worker-staging",
  "factory-desk-staging",
  "factory-pr-autofixer-staging",
  "factory-security-reviewer-staging",
];

const SERVICES_SHOWN = 3;
const PLAN_MARKER = /<!-- cursor:plan:([A-Za-z0-9+/=_-]+) -->/;
const SERVICES_LINE = /^services:[ \t]*(.+)$/im;

/**
 * The services a published change-monitor plan names, minus the factory's own
 * hosts; empty when it names none or only those. The `cursor:plan` marker's
 * `services` wins over the comment's `Services:` line, even when it is empty;
 * the line is read only when the marker has no readable list.
 */
export function changeMonitorServices(body: string): string[] {
  const text = normalize(body);
  const named = planMarkerServices(text) ?? servicesLine(text);
  const own = new Set(FACTORY_HOST_SERVICES);
  const seen = new Set<string>();
  const services: string[] = [];
  for (const raw of named) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name === "" || own.has(key) || seen.has(key)) continue;
    seen.add(key);
    services.push(name);
  }
  return services;
}

function planMarkerServices(text: string): string[] | undefined {
  const encoded = PLAN_MARKER.exec(text)?.[1];
  if (encoded === undefined) return undefined;
  let plan: unknown;
  try {
    plan = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  const list = typeof plan === "object" && plan !== null ? (plan as { services?: unknown }).services : undefined;
  if (!Array.isArray(list)) return undefined;
  const names = list.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item !== "object" || item === null) return "";
    const { slug, name } = item as { slug?: unknown; name?: unknown };
    return typeof slug === "string" ? slug : typeof name === "string" ? name : "";
  });
  return names;
}

function servicesLine(text: string): string[] {
  const line = SERVICES_LINE.exec(text.split(/^<details>/m)[0] ?? "")?.[1];
  if (line === undefined) return [];
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .split(",");
}

function servicesNote(services: readonly string[] | undefined): string {
  if (services === undefined || services.length === 0) return "";
  const shown = services.slice(0, SERVICES_SHOWN).map((name) => escapeMrkdwn(fitPlain(name, 60)));
  const more = services.length > SERVICES_SHOWN ? ` and ${services.length - SERVICES_SHOWN} more` : "";
  return ` (services: ${shown.join(", ")}${more})`;
}

function runVerdict(run: CheckRunFacts): Exclude<ChangeMonitorVerdict, "pending"> | undefined {
  if (run.status !== "completed") return undefined;
  const conclusion = run.conclusion ?? "";
  if (PASSING.has(conclusion)) return "verified";
  if (SUPERSEDED.has(conclusion) || conclusion === "timed_out") return "incomplete";
  return "attention";
}

/** GitHub Actions check runs that did not pass: what an autofix push answers. */
export function failedCiRuns(runs: readonly CheckRunFacts[]): string[] {
  return runs.filter((run) => run.app === "github-actions" && run.status === "completed" && !PASSING.has(run.conclusion ?? "") && !SUPERSEDED.has(run.conclusion ?? "")).map((run) => run.name);
}

/**
 * A push to the PR by a bot onto a head whose CI had failed. The desk cannot
 * read pr-autofixer's claim, so this is inferred: on a factory PR the fixer is
 * what answers red CI with a push.
 */
export function isBotPush(sender: { login?: string; type?: string } | undefined): boolean {
  const login = sender?.login?.trim().toLowerCase() ?? "";
  return login !== "" && (sender?.type === "Bot" || login.endsWith("[bot]"));
}

function isBot(review: ReviewFacts): boolean {
  return isBotPush({ ...(review.authorLogin === undefined ? {} : { login: review.authorLogin }), ...(review.authorType === undefined ? {} : { type: review.authorType }) });
}

function sameSha(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

function normalize(body: string): string {
  return body.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * The ticket a factory PR belongs to (factory-pr-key.ts): the head branch
 * starts with a key, or the title does and the Cursor bot opened it.
 */
export const reviewPrKey = factoryPrKey;

const TITLE_MAX = 120;

/**
 * One reply for every gate that settled since the thread last heard about
 * this head. One shape whatever the count: the header, then one bullet per
 * gate, each `<gate emoji><status emoji> <Gate> — <status> · <link>`:
 *
 *   TLSSN-28 review update on `abc1234`:
 *   • 🐛✅ Bugbot — clean · <run|Bugbot run>
 *   • 🏗️✅ CI — passing · <checks|checks>
 */
export function reviewUpdateMessage(input: { issueKey: string; repository: string; number: number; headSha: string; settled: readonly Settled[] }): string {
  return renderReviewUpdate({ ...input, lines: reviewUpdateLines(input) });
}

/** Each settled gate's line, in listing order. */
export function reviewUpdateLines(input: { repository: string; number: number; headSha: string; settled: readonly Settled[] }): string[] {
  const sorted = [...input.settled].sort((a, b) => COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component));
  return sorted.map((item) => gateLine(item, input));
}

/** A review update from its lines; an edited update is rendered again from its stored lines. */
export function renderReviewUpdate(input: { issueKey: string; headSha: string; lines: readonly string[] }): string {
  return [`${input.issueKey} review update on \`${shortSha(input.headSha)}\`:`, ...input.lines.map((line) => `\u2022 ${line}`)].join("\n");
}

function gateLine(item: Settled, pr: { repository: string; number: number; headSha: string }): string {
  const { gate, status, url, label } = gateParts(item, pr);
  return `${componentEmoji(item)} ${gate} \u2014 ${status}${url === undefined ? "" : ` \u00b7 ${link({ url, label })}`}`;
}

function gateParts(item: Settled, pr: { repository: string; number: number; headSha: string }): { gate: string; status: string; url?: string; label: string } {
  const checks = `https://github.com/${pr.repository}/pull/${pr.number}/checks`;
  switch (item.component) {
    case "bugbot": {
      const status =
        item.verdict === "clean"
          ? "clean"
          : item.verdict === "findings"
            ? item.findings === undefined
              ? "found issues"
              : `${item.findings} ${item.findings === 1 ? "finding" : "findings"}`
            : `did not finish (${escapeMrkdwn(item.conclusion ?? "unknown")})`;
      return { gate: "Bugbot", status, url: item.url, label: "Bugbot run" };
    }
    case "security": {
      const counts = (["high", "medium", "low"] as const).filter((level) => item.bySeverity[level] > 0).map((level) => `${item.bySeverity[level]} ${level}`);
      const top = item.top === undefined ? "" : ` (top: ${escapeMrkdwn(fitPlain(item.top.replace(/\s+/g, " "), TITLE_MAX))})`;
      const status =
        item.verdict === "CLEAN"
          ? "clean"
          : item.verdict === "INCOMPLETE"
            ? `incomplete (the diff was too large to review in full)${counts.length === 0 ? "" : `: ${counts.join(", ")}${top}`}`
            : `findings${counts.length === 0 ? "" : `: ${counts.join(", ")}${top}`}`;
      return { gate: "Security review", status, ...(item.url === undefined ? {} : { url: item.url }), label: "review" };
    }
    case "ci": {
      if (item.passing) return { gate: "CI", status: "passing", url: checks, label: "checks" };
      const names = item.failed.slice(0, 3).map((name) => escapeMrkdwn(fitPlain(name, 60)));
      const more = item.failed.length > 3 ? ` and ${item.failed.length - 3} more` : "";
      return { gate: "CI", status: `failing: ${names.join(", ")}${more}`, url: item.url ?? checks, label: item.url === undefined ? "checks" : "failed run" };
    }
    case "autofix": {
      const failed = item.failed.length === 0 ? "" : ` (${item.failed.slice(0, 3).map((name) => escapeMrkdwn(fitPlain(name, 60))).join(", ")})`;
      return {
        gate: "Autofix",
        status: `pr-autofixer pushed after CI failed on \`${shortSha(item.before)}\`${failed}; checks are running on the new head`,
        url: `https://github.com/${pr.repository}/pull/${pr.number}/commits/${pr.headSha.toLowerCase()}`,
        label: shortSha(pr.headSha),
      };
    }
    case "changeMonitor": {
      const status =
        item.verdict === "pending"
          ? "running"
          : item.verdict === "planned"
            ? "plan ready"
            : item.verdict === "verified"
              ? "verified"
              : item.verdict === "attention"
                ? "needs attention"
                : "stopped without a verdict";
      return { gate: "Change review", status: `${status}${servicesNote(item.services)}`, ...(item.url === undefined ? {} : { url: item.url }), label: "change-monitor plan" };
    }
  }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7).toLowerCase();
}

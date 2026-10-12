// Pure: read one Jira webhook body and decide whether it is a move into the
// approved status. The handler owns HMAC / shared-header auth, the Jira
// reads and writes, the claim, and the launch.

import { inProjectScope } from "./factory-env.js";
import { factoryStage } from "./factory-stage.js";

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const UPDATED_EVENTS = new Set(["jira:issue_updated", "issue_updated"]);

export type ApprovedDecision =
  | { launch: true; issueKey: string; changelogId: string; title: string }
  | { launch: false; reason: "stale_status"; issueKey: string; changelogId: string; title: string; current: string }
  | {
      launch: false;
      reason: "ignored" | "not_status_change" | "other_status" | "project_not_allowed" | "no_issue_key";
    };

export function decideApproved(
  body: unknown,
  opts: { approvedStatus: string; projects: readonly string[]; env?: NodeJS.ProcessEnv }
): ApprovedDecision {
  if (!isRecord(body)) return { launch: false, reason: "ignored" };
  if (!UPDATED_EVENTS.has(stringValue(body["webhookEvent"]))) return { launch: false, reason: "ignored" };
  const issue = recordAt(body, "issue");
  const issueKey = stringValue(issue["key"]);
  if (!ISSUE_KEY.test(issueKey)) return { launch: false, reason: "no_issue_key" };
  // An empty allowlist refuses every project, so an unset variable cannot launch on any board.
  if (!opts.projects.includes(issueKey.slice(0, issueKey.indexOf("-")))) {
    return { launch: false, reason: "project_not_allowed" };
  }
  // Staging also refuses a body whose project.key is out of scope, so the key
  // and the project it claims must both be the slug's (factory-stage.ts).
  const env = opts.env ?? process.env;
  const claimed = stringValue(recordAt(recordAt(issue, "fields"), "project")["key"]);
  if (factoryStage(env) === "staging" && claimed !== "" && !inProjectScope(env, { projects: opts.projects, project: claimed })) {
    return { launch: false, reason: "project_not_allowed" };
  }
  const changelog = recordAt(body, "changelog");
  const items = Array.isArray(changelog["items"]) ? changelog["items"].filter(isRecord) : [];
  const statusItems = items.filter((item) => sameName(stringValue(item["field"]), "status"));
  if (statusItems.length === 0) return { launch: false, reason: "not_status_change" };
  if (!statusItems.some((item) => sameName(stringValue(item["toString"]), opts.approvedStatus))) {
    return { launch: false, reason: "other_status" };
  }
  // The ticket moved again before this delivery landed. The later delivery carries the truth.
  const fields = recordAt(issue, "fields");
  const status = recordAt(fields, "status");
  const id = changelog["id"];
  const changelogId = typeof id === "string" || typeof id === "number" ? String(id) : "";
  const current = stringValue(status["name"]);
  const title = stringValue(fields["summary"]) || issueKey;
  // The body's status is a snapshot the Automation rule rendered; the handler confirms it against Jira before it drops the approval.
  if (!sameName(current, opts.approvedStatus)) return { launch: false, reason: "stale_status", issueKey, changelogId, title, current: current.trim() };
  return { launch: true, issueKey, changelogId, title };
}

export function implementingComment(url: string): string {
  return `Implementing: ${url}`;
}

/** The Implementing: line, plus why, when the launch watch relaunched a launch that was lost (launch-heal.ts). */
export function relaunchedComment(input: { url: string; attempt: number }): string {
  return `${implementingComment(input.url)}\nRelaunched by factory-worker: the first launch for this approval recorded no agent (watch attempt ${input.attempt}).`;
}

/** The Implementing: line, plus why, when a takeover found an agent a lost launch had started and adopted it. */
export function adoptedComment(url: string): string {
  return `${implementingComment(url)}\nRecovered by factory-worker: an earlier launch for this approval started this agent but never recorded it, so no second agent was started.`;
}

export function launchFailedComment(reason: string): string {
  return `Launch failed: ${reason.slice(0, 40)}. Moving the card to Approved again retries.`;
}

// Trace lines for a verified approval that launched nothing and failed nothing.
// The desk's worker-outcome.ts matches neither first line, so neither is
// announced in Slack; they are the record hosted v2's unreadable host logs are not.

export type LaunchPending = "in_flight" | "unconfirmed" | "claim_unavailable" | "comments_unreadable" | "status_unreadable" | "agent_unverified";

const PENDING_WHY: Record<LaunchPending, string> = {
  in_flight: "another delivery of this approval holds the launch claim",
  unconfirmed: "the launch claim was written but could not be read back yet",
  claim_unavailable: "the launch claim could not be taken (kv unavailable)",
  comments_unreadable: "the ticket's comments could not be read",
  status_unreadable: "this approval's delivery named another status and Jira's could not be read to confirm it",
  agent_unverified: "an earlier launch for this approval may have started an agent, and the worker could not confirm whether it did",
};

/**
 * `timer`: a reminder is armed to retry. Without one the retry waits for the
 * worker's next wake (another delivery's backstop), so the line promises no
 * relaunch and names the person's way instead.
 */
export function launchPendingComment(input: { issueKey: string; kind: LaunchPending; graceMinutes: number; timer: boolean }): string {
  const { issueKey, graceMinutes } = input;
  const why = `Launch pending: ${issueKey}: ${PENDING_WHY[input.kind]}.`;
  return input.timer
    ? `${why} If no Implementing: comment follows within ${graceMinutes} minutes, factory-worker relaunches it on its own.`
    : `${why} No retry timer could be set yet; factory-worker sets one the next time it handles an Approved move or a pull request. If no Implementing: comment follows within ${graceMinutes} minutes, move the card to Approved again.`;
}

export function launchSkippedComment(input: { issueKey: string; url: string }): string {
  return `Launch skipped: ${input.issueKey} already has its implement agent, ${input.url}. No second agent was started.`;
}

export function staleApprovalComment(input: { issueKey: string; current: string }): string {
  return `Launch skipped: ${input.issueKey} was no longer Approved (now ${input.current || "unknown"}) when this approval's delivery arrived, so it launched nothing.`;
}

// The desk's `plan KEY` does not move an Approved ticket, so the way back is the board.
// factory-desk/agent/lib/worker-outcome.ts matches this line and the launch failure's.
export function noBriefComment(issueKey: string): string {
  return `Approved without a plan on the ticket; nothing was launched. Move ${issueKey} back to Triaged in Jira to plan it, then approve the new plan.`;
}

/** Latest Plan: comment wins. Extraction is a scan for a Brief: heading. */
export function extractBrief(comment: string): string | undefined {
  const lines = comment.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "Brief:") start = i + 1;
  }
  if (start === -1) return undefined;
  const brief = lines.slice(start).join("\n").trim();
  return brief === "" ? undefined : brief;
}

export function latestPlanComment(comments: readonly string[], issueKey: string): string | undefined {
  const prefix = `Plan: ${issueKey}`;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const text = comments[i] ?? "";
    if (firstLine(text).startsWith(prefix)) return text;
  }
  return undefined;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== "";
}

function firstLine(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

// Typed so an inherited `toString` function on a changelog item never reads as a status name.
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

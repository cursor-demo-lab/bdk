import { issueInProjectScope } from "./factory-env.js";

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const UPDATE_EVENTS = new Set(["jira:issue_updated", "issue_updated"]);
const IMPLEMENTING = /^Implementing:\s*(https?:\/\/[^\s<>]+)/;

export type StatusEvent =
  | {
      kind: "triaged" | "planned" | "approved" | "in_progress" | "in_review" | "done";
      issueKey: string;
      title: string;
      changelogId: string;
      /** On a move into Planned from Approved or later: the status it came back from, as Jira named it. */
      movedBackFrom?: string;
    }
  | { kind: "ignored"; reason: "ignored" | "not_status_change" | "other_status" | "stale_status" | "project_not_allowed" };

export type StatusEventOptions = {
  statuses: { triaged: string; planned: string; approved: string; inProgress: string; inReview: string; done: string };
  projects: readonly string[];
  /** Read for the stage: an empty `projects` allows every project on production only (factory-env.ts inProjectScope). */
  env?: NodeJS.ProcessEnv;
};

// The desk wakes on six statuses, Triaged through Done. A delivery whose
// status item names the target but whose issue has since moved on is stale:
// the later delivery carries the truth.
export function decideStatusEvent(body: unknown, options: StatusEventOptions): StatusEvent {
  if (!isRecord(body)) return ignored("ignored");
  if (!UPDATE_EVENTS.has(stringValue(body["webhookEvent"]))) return ignored("ignored");
  const issue = isRecord(body["issue"]) ? body["issue"] : {};
  const issueKey = stringValue(issue["key"]);
  if (!ISSUE_KEY.test(issueKey)) return ignored("ignored");
  const fields = isRecord(issue["fields"]) ? issue["fields"] : {};
  const project = isRecord(fields["project"]) ? stringValue(fields["project"]["key"]) : "";
  const projectKey = project === "" ? issueKey.slice(0, issueKey.lastIndexOf("-")) : project;
  if (!issueInProjectScope(options.env ?? process.env, { projects: options.projects, project: projectKey, issueKey })) {
    return ignored("project_not_allowed");
  }
  const changelog = isRecord(body["changelog"]) ? body["changelog"] : {};
  const items = Array.isArray(changelog["items"]) ? changelog["items"] : [];
  const item = items.find((entry) => isRecord(entry) && entry["field"] === "status");
  const changelogId = changelog["id"];
  if (!isRecord(item) || (typeof changelogId !== "string" && typeof changelogId !== "number")) {
    return ignored("not_status_change");
  }
  const entered = stringValue(item["toString"]).toLowerCase();
  const watched = [
    ["triaged", options.statuses.triaged],
    ["planned", options.statuses.planned],
    ["approved", options.statuses.approved],
    ["in_progress", options.statuses.inProgress],
    ["in_review", options.statuses.inReview],
    ["done", options.statuses.done],
  ] as const;
  const kind = watched.find(([, name]) => entered === name.toLowerCase())?.[0];
  if (kind === undefined) return ignored("other_status");
  const current = isRecord(fields["status"]) ? stringValue(fields["status"]["name"]).toLowerCase() : "";
  if (current !== entered) return ignored("stale_status");
  const summary = stringValue(fields["summary"]).trim();
  const event = { kind, issueKey, title: summary === "" ? issueKey : summary, changelogId: String(changelogId) };
  const from = stringValue(item["fromString"]).trim();
  const later = [options.statuses.approved, options.statuses.inProgress, options.statuses.inReview, options.statuses.done];
  if (kind === "planned" && later.some((name) => name.toLowerCase() === from.toLowerCase())) return { ...event, movedBackFrom: from };
  return event;
}

/**
 * The ticket a status move takes out of Planned, whatever status it enters:
 * one the desk otherwise ignores (To Do, a custom status) still ends a
 * declined plan. A delivery whose ticket is Planned again is stale (a late
 * redelivery after a replan) and counts for nothing, so it cannot clear a
 * newer decline.
 */
export function leftPlannedKey(body: unknown, options: StatusEventOptions): string | undefined {
  if (!isRecord(body) || !UPDATE_EVENTS.has(stringValue(body["webhookEvent"]))) return undefined;
  const issue = isRecord(body["issue"]) ? body["issue"] : {};
  const issueKey = stringValue(issue["key"]);
  if (!ISSUE_KEY.test(issueKey)) return undefined;
  const fields = isRecord(issue["fields"]) ? issue["fields"] : {};
  const project = isRecord(fields["project"]) ? stringValue(fields["project"]["key"]) : "";
  const projectKey = project === "" ? issueKey.slice(0, issueKey.lastIndexOf("-")) : project;
  if (!issueInProjectScope(options.env ?? process.env, { projects: options.projects, project: projectKey, issueKey })) return undefined;
  const changelog = isRecord(body["changelog"]) ? body["changelog"] : {};
  const items = Array.isArray(changelog["items"]) ? changelog["items"] : [];
  const item = items.find((entry) => isRecord(entry) && entry["field"] === "status");
  if (!isRecord(item)) return undefined;
  const planned = options.statuses.planned.trim().toLowerCase();
  const from = stringValue(item["fromString"]).trim().toLowerCase();
  const to = stringValue(item["toString"]).trim().toLowerCase();
  const current = isRecord(fields["status"]) ? stringValue(fields["status"]["name"]).trim().toLowerCase() : "";
  if (current === planned) return undefined;
  return from === planned && to !== planned ? issueKey : undefined;
}

const PULL_REQUEST = /^Pull request:.*?(https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d{1,9}))(?!\d)/;
const MERGED_BY = /^Merged by:\s*([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\s*$/;

/**
 * The implement PR from the latest comment whose first line is `Pull request:
 * <url>`, which factory-worker leaves before it moves the ticket to In Review
 * or Done (factory-worker/agent/lib/pr-decide.ts `pullRequestComment`). Jira
 * can hand the URL back as a card or a markdown link, so the first GitHub pull
 * request URL on that line counts.
 */
export function latestPullRequestComment(comments: readonly string[]): { url: string; label: string } | undefined {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const match = firstLine(comments[i] ?? "").match(PULL_REQUEST);
    if (match !== null) return { url: match[1]!, label: `${match[2]}/${match[3]}#${match[4]}` };
  }
  return undefined;
}

/**
 * The GitHub login from the latest comment whose first line is `Merged by:
 * <login>`, which factory-worker leaves before it moves the ticket to Done
 * (factory-worker/agent/lib/pr-decide.ts `mergedByComment`). Missing on a
 * hand-drag or when that write failed; the Done line then stays "was merged".
 */
export function latestMergedByComment(comments: readonly string[]): string | undefined {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const login = firstLine(comments[i] ?? "").match(MERGED_BY)?.[1];
    if (login !== undefined) return login;
  }
  return undefined;
}

/** The agent URL from the latest comment whose first line is `Implementing: <url>`. */
export function latestImplementingComment(comments: readonly string[]): string | undefined {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const url = firstLine(comments[i] ?? "").match(IMPLEMENTING)?.[1];
    if (url !== undefined) return url.replace(/[.,;)]+$/, "");
  }
  return undefined;
}

function ignored(reason: Extract<StatusEvent, { kind: "ignored" }>["reason"]): StatusEvent {
  return { kind: "ignored", reason };
}

function firstLine(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

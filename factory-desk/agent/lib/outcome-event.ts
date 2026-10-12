import { createHash } from "node:crypto";
import type { StatusNames } from "./config.js";
import { issueInProjectScope } from "./factory-env.js";
import { outcomeKind, outcomeLeaves, type OutcomeKind } from "./outcomes.js";

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const COMMENT_EVENTS = new Set(["comment_created", "jira:comment_created"]);

export type CommentEvent =
  | { kind: OutcomeKind; issueKey: string; title: string; claimId: string; commentId?: string; body: string }
  | { kind: "ignored"; reason: "ignored" | "project_not_allowed" | "not_outcome" | "moved_on" };

export function isCommentEvent(body: unknown): boolean {
  return isRecord(body) && COMMENT_EVENTS.has(stringValue(body["webhookEvent"]));
}

// A comment added to a ticket, from the desk's TLSSN comment rule or a
// native comment_created webhook. Only a factory outcome for that ticket
// wakes the desk (outcomes.ts): triage's `Triage stopped: <KEY>`, the
// planner's `Needs info: <KEY>` or `Plan stopped: <KEY>`, and the worker's
// `Launch failed:`, `Approved without a plan …`, and `<status> not set from
// <repo>#<n>:`. Every other comment, triage's own `Needs info:` line
// included, is ignored before any Jira read. A ticket the payload shows
// outside the status its outcome leaves it in has moved on. The claim id is
// the comment id, or a hash of the body when the payload carries none, so a
// redelivery posts once.
export function decideCommentEvent(body: unknown, options: { statuses: StatusNames; projects: readonly string[]; env?: NodeJS.ProcessEnv }): CommentEvent {
  if (!isCommentEvent(body) || !isRecord(body)) return ignored("ignored");
  const issue = isRecord(body["issue"]) ? body["issue"] : {};
  const issueKey = stringValue(issue["key"]);
  if (!ISSUE_KEY.test(issueKey)) return ignored("ignored");
  const fields = isRecord(issue["fields"]) ? issue["fields"] : {};
  const project = isRecord(fields["project"]) ? stringValue(fields["project"]["key"]) : "";
  const projectKey = project === "" ? issueKey.slice(0, issueKey.lastIndexOf("-")) : project;
  if (!issueInProjectScope(options.env ?? process.env, { projects: options.projects, project: projectKey, issueKey })) return ignored("project_not_allowed");
  const comment = isRecord(body["comment"]) ? body["comment"] : {};
  const text = flatten(comment["body"]);
  const kind = outcomeKind(text, issueKey, options.statuses);
  if (kind === undefined) return ignored("not_outcome");
  const status = isRecord(fields["status"]) ? stringValue(fields["status"]["name"]).trim() : "";
  const leaves = outcomeLeaves(kind, options.statuses);
  if (leaves !== undefined && status !== "" && status.toLowerCase() !== leaves.trim().toLowerCase()) return ignored("moved_on");
  const id = idValue(comment["id"]);
  const summary = stringValue(fields["summary"]).trim();
  return {
    kind,
    issueKey,
    title: summary === "" ? issueKey : summary,
    claimId: id === "" ? `body-${createHash("sha256").update(text).digest("hex").slice(0, 16)}` : id,
    ...(id === "" ? {} : { commentId: id }),
    body: text,
  };
}

/** A comment body as plain text: a string, or Atlassian document format flattened to its text nodes. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).filter((part) => part !== "").join("\n");
  if (!isRecord(value)) return "";
  if (typeof value["text"] === "string") return value["text"];
  return flatten(value["content"]);
}

function ignored(reason: Extract<CommentEvent, { kind: "ignored" }>["reason"]): CommentEvent {
  return { kind: "ignored", reason };
}

function idValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

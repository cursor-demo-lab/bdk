import { decide, type PlanRequest } from "./chain.js";
import { governingTriage } from "./desk-triaged.js";
import { issueInProjectScope } from "./factory-env.js";
import { issueKeySchema, planSentinel } from "./plan.js";
import { commentClaimKey, planClaimKey } from "./kv-keys.js";

export { commentClaimKey, planClaimKey };

// Jira is the bus. The planner wakes when a ticket enters the Triaged status
// (issue_updated). A Triage: or Plan requested: comment (comment_created) is
// a legacy local path; the hosted webhook does not register comment events.
// Pure apart from the injected comment reader: parse the payload, decide,
// build the plan prompt. The webhook owns HMAC / shared-header auth, the
// claim, and send.

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const COMMENT_EVENTS = new Set(["comment_created", "jira:comment_created"]);
const STATUS_EVENTS = new Set(["jira:issue_updated", "issue_updated"]);

/** The comment event's id, or "" when the payload carries none. */
export function commentEventId(body: unknown): string {
  const comment = isRecord(body) && isRecord(body["comment"]) ? body["comment"] : undefined;
  return comment === undefined ? "" : idValue(comment["id"]);
}

export function isStatusEvent(body: unknown): boolean {
  return isRecord(body) && STATUS_EVENTS.has(stringValue(body["webhookEvent"]));
}

export type VerdictSkip = {
  plan: false;
  reason: "question" | "needs_info" | "duplicate";
  issueKey: string;
  changelogId: string;
  /** `desk`: factory-desk's marked comment from filing; `triage`: the first comment a triage run wrote; `latest`: a person's, or the newest. */
  from: "desk" | "triage" | "latest";
  duplicateOf?: string;
};

export type StatusDecision =
  | { plan: true; request: PlanRequest; changelogId: string; replan: boolean }
  | { plan: false; reason: "ignored" | "not_status_change" | "other_status" | "stale_status" | "project_not_allowed" }
  | VerdictSkip;

export type StatusOptions = {
  triagedStatus: string;
  plannedStatus: string;
  /** Allowed Jira project keys. Empty allows every project on production and none on staging (factory-env.ts inProjectScope). */
  projects: readonly string[];
  /** Read for the stage; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Decides from the status payload alone. The triage verdict is not in it, so
 * a `plan: true` here still has to pass `planFromStatus`.
 */
export function decideStatusEvent(body: unknown, opts: StatusOptions): StatusDecision {
  if (!isRecord(body) || !STATUS_EVENTS.has(stringValue(body["webhookEvent"]))) return { plan: false, reason: "ignored" };
  const issue = isRecord(body["issue"]) ? body["issue"] : undefined;
  const issueKey = issue === undefined ? "" : stringValue(issue["key"]);
  if (!ISSUE_KEY.test(issueKey)) return { plan: false, reason: "ignored" };
  const fields = issue !== undefined && isRecord(issue["fields"]) ? issue["fields"] : {};
  const project = isRecord(fields["project"]) ? stringValue(fields["project"]["key"]) : "";
  const projectKey = (project || issueKey.slice(0, issueKey.indexOf("-"))).toUpperCase();
  if (!issueInProjectScope(opts.env ?? process.env, { projects: opts.projects, project: projectKey, issueKey })) return { plan: false, reason: "project_not_allowed" };
  const changelog = isRecord(body["changelog"]) ? body["changelog"] : undefined;
  const items = changelog !== undefined && Array.isArray(changelog["items"]) ? changelog["items"] : [];
  const item = items.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry["field"] === "status");
  const changelogId = changelog === undefined ? "" : idValue(changelog["id"]);
  if (item === undefined || changelogId === "") return { plan: false, reason: "not_status_change" };
  const triaged = normalize(opts.triagedStatus);
  if (normalize(stringValue(item["toString"])) !== triaged) return { plan: false, reason: "other_status" };
  const status = isRecord(fields["status"]) ? stringValue(fields["status"]["name"]) : "";
  if (normalize(status) !== triaged) return { plan: false, reason: "stale_status" };
  return {
    plan: true,
    request: { issueKey, title: stringValue(fields["summary"]) || issueKey },
    changelogId,
    replan: normalize(stringValue(item["fromString"])) === normalize(opts.plannedStatus),
  };
}

/**
 * The status decision, then the verdict gate from the governing `Triage:`
 * comment on the ticket (`governingTriage`). No `Triage:` comment, or
 * comments that could not be read, plan without a verdict, the same as a
 * manual request. A `Plan:` comment already on the ticket makes the re-entry
 * a replan.
 *
 * The desk's `plan KEY` bounce (To Do → Triaged) is a person asking for a
 * plan, and it passes this same gate: the desk refuses to bounce a ticket
 * whose governing verdict is a question, a duplicate, or an unanswered
 * needs-info (factory-desk/agent/lib/triage-comment.ts reads it the same
 * way), and a `Detail from Slack:` reply is how a person answers a needs-info.
 * So a bounce the desk sends plans, and a skip here is a disagreement the
 * webhook reports on the ticket as `Plan stopped:` (plan-outcome.ts
 * `reportSkippedPlan`) rather than dropping.
 */
export async function planFromStatus(
  body: unknown,
  deps: StatusOptions & { readComments: (issueKey: string) => Promise<string[] | undefined> }
): Promise<StatusDecision> {
  const decision = decideStatusEvent(body, deps);
  if (!decision.plan) return decision;
  const issueKey = decision.request.issueKey;
  const comments = (await deps.readComments(issueKey)) ?? [];
  const replan = decision.replan || hasPlan({ comments, issueKey });
  const triage = gateTriage(comments);
  const answer = latestAnswer(comments);
  const answered = answer === undefined ? decision.request : { ...decision.request, answer };
  if (triage === undefined) return { ...decision, replan, request: answered };
  const verdict = decide(triage.verdict);
  if (!verdict.plan) {
    const duplicateOf = triage.verdict.duplicateOf;
    return {
      plan: false,
      reason: verdict.reason,
      issueKey,
      changelogId: decision.changelogId,
      from: triage.from,
      ...(duplicateOf === undefined || duplicateOf === "unknown" ? {} : { duplicateOf }),
    };
  }
  return {
    ...decision,
    replan,
    request: {
      ...answered,
      verdict: triage.verdict,
      ...(triage.summary === "" ? {} : { summary: triage.summary }),
    },
  };
}

// The desk's `replan KEY` on a ticket already in Triaged bounces it through
// To Do, so the move's fromString is not Planned. The earlier plan's comment
// is what still marks it as a replan.
function hasPlan(input: { comments: readonly string[]; issueKey: string }): boolean {
  const sentinel = planSentinel(input.issueKey);
  return input.comments.some((text) => {
    const first = firstLine(text);
    return first === sentinel || first.startsWith(`${sentinel} `);
  });
}

/**
 * The first line of the comment factory-desk writes when a reply in the
 * ticket's Slack thread answers a Needs info (factory-desk/agent/lib/
 * thread-detail.ts). One after a needs-info `Triage:` verdict is the
 * information triage asked for, so that verdict no longer skips the plan;
 * the desk's triage-comment.ts reads it the same way.
 */
export const DETAIL_SENTINEL = "Detail from Slack:";

const ANSWER_MAX = 4000;
const ANSWERED = ["Needs info:", "Plan stopped:", "Plan:", "Triage:"];

/**
 * The newest `Detail from Slack:` reply that no planner verdict, plan, or
 * triage comment has come after: the answer this planning run must use. Its
 * two header lines (sentinel, who replied) are dropped; the rest is the
 * person's words.
 */
function latestAnswer(comments: readonly string[]): string | undefined {
  for (let index = comments.length - 1; index >= 0; index--) {
    const text = (comments[index] ?? "").replace(/\r\n/g, "\n").trim();
    const first = firstLine(text);
    if (first.startsWith(DETAIL_SENTINEL)) {
      const words = text.split("\n").slice(2).join("\n").trim();
      if (words === "") return undefined;
      return words.length <= ANSWER_MAX ? words : `${words.slice(0, ANSWER_MAX - 1)}…`;
    }
    if (ANSWERED.some((sentinel) => first.startsWith(sentinel))) return undefined;
  }
  return undefined;
}

/** The `Triage:` comment the gate reads (desk-triaged.ts `governingTriage`, the desk's rule too), with its needs-info answered by a later `Detail from Slack:`. */
function gateTriage(comments: readonly string[]): { verdict: NonNullable<PlanRequest["verdict"]>; summary: string; from: VerdictSkip["from"] } | undefined {
  const governing = governingTriage(comments);
  if (governing === undefined) return undefined;
  const text = comments[governing.index] ?? "";
  const answered = comments.slice(governing.index + 1).some((comment) => firstLine(comment).startsWith(DETAIL_SENTINEL));
  const parsed = parseTriage({ first: firstLine(text), text });
  if (answered && parsed.needsInfo === true) {
    const { needsInfo: _answered, ...rest } = parsed;
    return { verdict: rest, summary: summaryOf(text), from: governing.from };
  }
  return { verdict: parsed, summary: summaryOf(text), from: governing.from };
}

/**
 * Every Jira project a comment delivery would have the planner act on: the
 * delivered issue's (its `project.key`, else its key's prefix) and, for
 * `Plan requested: KEY`, the requested key's, which comes from the comment's
 * text and can name another project. Empty when the body is no comment on a
 * readable key; decideComment ignores those anyway.
 */
export function commentProjects(body: unknown): string[] {
  if (!isRecord(body) || !COMMENT_EVENTS.has(stringValue(body["webhookEvent"]))) return [];
  const issue = isRecord(body["issue"]) ? body["issue"] : undefined;
  const issueKey = issue === undefined ? "" : stringValue(issue["key"]);
  if (!ISSUE_KEY.test(issueKey)) return [];
  const fields = issue !== undefined && isRecord(issue["fields"]) ? issue["fields"] : {};
  const project = isRecord(fields["project"]) ? stringValue(fields["project"]["key"]) : "";
  const projects = [(project || issueKey.slice(0, issueKey.indexOf("-"))).toUpperCase()];
  const requested = parseCommentEvent(body)?.request.issueKey;
  if (requested !== undefined) projects.push(requested.slice(0, requested.indexOf("-")).toUpperCase());
  return [...new Set(projects)];
}

export type CommentDecision =
  | { plan: true; request: PlanRequest; replan: boolean }
  | { plan: false; reason: "ignored" | "question" | "needs_info" | "duplicate" | "no_issue_key" };

export function decideComment(body: unknown): CommentDecision {
  const event = parseCommentEvent(body);
  if (event === undefined) return { plan: false, reason: "ignored" };
  if (event.kind === "requested") {
    return { plan: true, request: event.request, replan: event.replan };
  }
  const verdict = decide(event.verdict);
  if (!verdict.plan) return { plan: false, reason: verdict.reason };
  return { plan: true, request: event.request, replan: false };
}

type ParsedComment =
  | { kind: "triage"; request: PlanRequest; verdict: PlanRequest["verdict"] }
  | { kind: "requested"; request: PlanRequest; replan: boolean };

export function parseCommentEvent(body: unknown): ParsedComment | undefined {
  if (!isRecord(body)) return undefined;
  const eventName = stringValue(body["webhookEvent"]);
  if (!COMMENT_EVENTS.has(eventName)) return undefined;
  const issue = isRecord(body["issue"]) ? body["issue"] : undefined;
  const issueKey = issue === undefined ? "" : stringValue(issue["key"]);
  if (!ISSUE_KEY.test(issueKey)) return undefined;
  const fields = issue !== undefined && isRecord(issue["fields"]) ? issue["fields"] : {};
  const title = stringValue(fields["summary"]) || issueKey;
  const comment = isRecord(body["comment"]) ? body["comment"] : undefined;
  const text = flattenComment(comment === undefined ? "" : comment["body"]);
  const first = firstLine(text);
  if (first.startsWith("Plan requested:")) {
    const rest = first.slice("Plan requested:".length).trim();
    const parts = rest.split(/\s+/);
    const key = parts[0] ?? "";
    const parsed = issueKeySchema.safeParse(key);
    if (!parsed.success) return undefined;
    const replan = parts.some((part) => part.toLowerCase() === "replan");
    return {
      kind: "requested",
      replan,
      request: { issueKey: parsed.data, title },
    };
  }
  if (!first.startsWith("Triage:")) return undefined;
  const verdict = parseTriage({ first, text });
  return {
    kind: "triage",
    verdict,
    request: {
      issueKey,
      title,
      ...(verdict === undefined ? {} : { verdict }),
      ...(summaryOf(text) === "" ? {} : { summary: summaryOf(text) }),
    },
  };
}

function parseTriage({ first, text }: { first: string; text: string }): NonNullable<PlanRequest["verdict"]> {
  const after = first.slice("Triage:".length).trim();
  const head = after.split(/[.,\s]/, 1)[0]?.toLowerCase() ?? "";
  if (head === "duplicate" || /duplicate of:/i.test(text) || /duplicate inbound/i.test(first)) {
    const named = text.match(/Duplicate of:\s*([A-Z][A-Z0-9]+-\d+)/i)?.[1];
    return {
      kind: "bug",
      severity: severityOf(text),
      duplicateOf: named ?? "unknown",
    };
  }
  const kind = head === "feedback" || head === "question" || head === "bug" ? head : "bug";
  const needsInfo = /^Needs info:/im.test(text);
  const nextStep = text.match(/^Next step:\s*(.+)$/im)?.[1]?.trim();
  return {
    kind,
    severity: severityOf(text),
    ...(needsInfo ? { needsInfo: true } : {}),
    ...(nextStep === undefined || nextStep === "" ? {} : { nextStep }),
  };
}

function severityOf(text: string): NonNullable<PlanRequest["verdict"]>["severity"] {
  const raw = text.match(/^Severity:\s*(\w+)/im)?.[1]?.toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "urgent") return raw;
  return "medium";
}

function summaryOf(text: string): string {
  return text.match(/^Summary:\s*(.+)$/im)?.[1]?.trim() ?? "";
}

function firstLine(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

function flattenComment(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenComment).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  if (typeof value["text"] === "string") return value["text"];
  return flattenComment(value["content"] ?? value["body"]);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function idValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

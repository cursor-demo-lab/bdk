import type { StatusNames } from "./config.js";
import type { CommentRecord } from "./jira.js";
import { outcomeKind } from "./outcomes.js";
import { isPlanComment } from "./plan-comment.js";

// Whether a planning run is still going, from the ticket alone. The planner
// writes `Planning started: <KEY>` when a pinned turn starts
// (planner/agent/lib/planning-started.ts; `../scripts/outcome-sentinels.test.mjs`
// holds the two in step), and a `Plan:`, `Needs info:`, or `Plan stopped:`
// comment when it ends. A marker with no end after it is a live run until
// PLANNING_LIVE_MS: a pod replaced mid-turn leaves a marker and never an end,
// so past that age the run counts as lost and `retry KEY` may start another.
// TLSSN-45 took 23 minutes before the search budget; with it, a run that is
// still going at 40 is not coming back.

export const PLANNING_STARTED_SENTINEL = "Planning started:";
export const PLANNING_LIVE_MS = 40 * 60_000;

export type PlanningStarted = { commentId?: string; sessionId?: string; startedAt: string };

export type PlanningRun =
  | { state: "live"; run: PlanningStarted; minutes: number; liveForMinutes: number }
  | { state: "not_started" }
  | { state: "finished"; run: PlanningStarted }
  | { state: "lost"; run: PlanningStarted; minutes: number };

export function parsePlanningStarted(comment: { body: string; issueKey: string }): Omit<PlanningStarted, "commentId"> | undefined {
  const { body, issueKey } = comment;
  const lines = body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim().split("\n").map((line) => line.trim());
  const sentinel = `${PLANNING_STARTED_SENTINEL} ${issueKey}`;
  if (lines[0] !== sentinel && !lines[0]?.startsWith(`${sentinel} `)) return undefined;
  const startedAt = lines.find((line) => line.startsWith("Started at:"))?.slice("Started at:".length).trim();
  if (startedAt === undefined || Number.isNaN(Date.parse(startedAt))) return undefined;
  const sessionId = lines.find((line) => line.startsWith("Session:"))?.slice("Session:".length).trim();
  return { startedAt, ...(sessionId === undefined || sessionId === "" ? {} : { sessionId }) };
}

/** Clock skew allowed between the desk's entry time and the planner's `Started at:`. */
export const START_SKEW_MS = 2 * 60_000;

/**
 * The newest planning run on the ticket. `since` is when the ticket entered
 * Triaged: a marker that started more than START_SKEW_MS before it belongs
 * to an earlier entry and is not this run's. Start times, not comment ids:
 * the desk arms its watch after the Triaged announce settles, and a marker
 * can land on the ticket before that.
 */
export function planningRun(input: { comments: readonly CommentRecord[]; issueKey: string; statuses: StatusNames; now: Date; since?: Date }): PlanningRun {
  const { comments, issueKey } = input;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]!;
    const parsed = parsePlanningStarted({ body: comment.body, issueKey });
    if (parsed === undefined) continue;
    if (input.since !== undefined && Date.parse(parsed.startedAt) < input.since.getTime() - START_SKEW_MS) return { state: "not_started" };
    const run: PlanningStarted = { ...parsed, ...(comment.id === undefined ? {} : { commentId: comment.id }) };
    const ended = comments.slice(i + 1).some((later) => isPlanComment(later.body, issueKey) || endsPlanning(outcomeKind(later.body, issueKey, input.statuses)));
    if (ended) return { state: "finished", run };
    const age = input.now.getTime() - Date.parse(parsed.startedAt);
    const minutes = Math.max(0, Math.floor(age / 60_000));
    if (age >= PLANNING_LIVE_MS) return { state: "lost", run, minutes };
    return { state: "live", run, minutes, liveForMinutes: Math.max(1, Math.ceil((PLANNING_LIVE_MS - age) / 60_000)) };
  }
  return { state: "not_started" };
}

function endsPlanning(kind: ReturnType<typeof outcomeKind>): boolean {
  return kind === "needs_info" || kind === "plan_stopped";
}

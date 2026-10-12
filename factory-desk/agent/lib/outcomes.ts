import type { StatusNames } from "./config.js";
import type { CommentRecord } from "./jira.js";
import { parsePlannerOutcome, plannerOutcomeKind, type PlannerOutcome, type PlannerOutcomeKind } from "./planner-outcome.js";
import { parseTriageOutcome, triageOutcomeKind, type TriageOutcomeKind, type TriageStopped } from "./triage-outcome.js";
import { parseWorkerOutcome, workerOutcomeKind, type WorkerOutcome, type WorkerOutcomeKind } from "./worker-outcome.js";

// Every comment an agent leaves when a ticket did not get what its thread was
// told comes next, and the ticket did not move. The desk's comment rule
// delivers each one; the desk tells the ticket's thread why and what to do.
// A kind that `leaves` a status is announced only while the ticket is still
// in it: once the ticket has moved on, the thread already heard the move.

export type OutcomeKind = TriageOutcomeKind | PlannerOutcomeKind | WorkerOutcomeKind;
export type Outcome = TriageStopped | PlannerOutcome | WorkerOutcome;

type OutcomeSpec = {
  /** Names the claim (`announced/<KEY>:<label>:<comment>`) and the comment link. */
  label: string;
  /** The status the ticket is left in, while the outcome still stands. */
  leaves?: (statuses: StatusNames) => string;
};

export const OUTCOMES: Record<OutcomeKind, OutcomeSpec> = {
  triage_stopped: { label: "Triage stopped", leaves: (statuses) => statuses.todo },
  needs_info: { label: "Needs info", leaves: (statuses) => statuses.triaged },
  plan_stopped: { label: "Plan stopped", leaves: (statuses) => statuses.triaged },
  launch_failed: { label: "Launch failed", leaves: (statuses) => statuses.approved },
  approved_without_plan: { label: "Approved without a plan", leaves: (statuses) => statuses.approved },
  move_skipped: { label: "Move skipped" },
};

export function outcomeKind(text: string, issueKey: string, statuses: StatusNames): OutcomeKind | undefined {
  return triageOutcomeKind(text, issueKey) ?? plannerOutcomeKind(text, issueKey) ?? workerOutcomeKind(text, issueKey, statuses);
}

export function parseOutcome(text: string, issueKey: string, statuses: StatusNames): Outcome | undefined {
  return parseTriageOutcome(text, issueKey) ?? parsePlannerOutcome(text, issueKey) ?? parseWorkerOutcome(text, issueKey, statuses);
}

/** The status an outcome of this kind leaves the ticket in, or undefined when any status still needs the line. */
export function outcomeLeaves(kind: OutcomeKind, statuses: StatusNames): string | undefined {
  return OUTCOMES[kind].leaves?.(statuses);
}

/**
 * The comment the event named, by id when the connector returns ids, else
 * the newest one of that kind.
 */
export function outcomeComment(
  records: readonly CommentRecord[],
  issueKey: string,
  want: { kind: OutcomeKind; commentId?: string },
  statuses: StatusNames
): CommentRecord | undefined {
  const matches = records.filter((record) => outcomeKind(record.body, issueKey, statuses) === want.kind);
  if (want.commentId !== undefined) {
    const named = matches.find((record) => record.id === want.commentId);
    if (named !== undefined) return named;
  }
  return matches.at(-1);
}

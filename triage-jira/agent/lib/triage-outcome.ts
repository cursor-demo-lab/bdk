import type { HostMcpRegistry } from "@cursor/july";
import { commentOnIssue, type IssueComment } from "./actuate.js";
import { statusNames } from "./config.js";
import { issueStatus, type GuardedTransition } from "./transition.js";
import { triageStoppedComment } from "./triage-stopped.js";
import type { RecordTriageResult } from "./types.js";
import { type KeyedKv, outcomeKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { outcomeKey };

// A triage run must move its ticket from To Do to Triaged: that move wakes the
// planner and the desk's Triaged line, which the desk's filing reply promised.
// record_triage leaves what it did under the session; when the turn ends,
// reportStoppedTriage reads it and, for a ticket still in To Do, writes a
// Triage stopped: comment (triage-stopped.ts) with the reason. The desk wakes
// on that comment and tells the ticket's Slack thread why. The ticket stays
// in To Do: no status is added or bounced.

export type TriageOutcome = {
  tracker: RecordTriageResult["tracker"]["status"];
  message?: string;
  transition?: GuardedTransition["status"];
  current?: string;
  available?: string[];
  transitionMessage?: string;
};

export type StopReport =
  | { status: "settled" | "status_unknown" }
  | { status: "moved_on"; current: string }
  | { status: "reported"; why: string; tracker: IssueComment["status"]; message?: string };

const WHY_MAX = 300;

export function triageOutcome(result: RecordTriageResult, transition: GuardedTransition | undefined): TriageOutcome {
  const tracker = result.tracker;
  return {
    tracker: tracker.status,
    ...(tracker.status === "failed" ? { message: tracker.message } : {}),
    ...(transition === undefined ? {} : { transition: transition.status }),
    ...(transition?.status === "skipped_status" && transition.current !== undefined ? { current: transition.current } : {}),
    ...(transition?.status === "no_transition" ? { available: transition.available } : {}),
    ...(transition?.status === "failed" ? { transitionMessage: transition.message } : {}),
  };
}

/** Best effort: a lost record only costs a less specific Why: line. */
export async function rememberOutcome(kv: KeyedKv, sessionId: string, outcome: TriageOutcome): Promise<void> {
  try {
    await kv.put(outcomeKey(sessionId), outcome);
  } catch (error) {
    warnKv("triage-outcome.rememberOutcome", error);
    // The turn's result still carries the outcome.
  }
}

/**
 * The record for this turn, removed as it is read. A triage session is keyed
 * by the issue, so a redelivery runs its next turn in the same session and
 * must not find this turn's record.
 */
export async function takeOutcome(kv: KeyedKv, sessionId: string): Promise<TriageOutcome | undefined> {
  let value: unknown;
  try {
    value = await kv.get(outcomeKey(sessionId));
  } catch (error) {
    warnKv("triage-outcome.takeOutcome.get", error);
    return undefined;
  }
  if (value === undefined || value === null) return undefined;
  try {
    await kv.delete(outcomeKey(sessionId));
  } catch (error) {
    warnKv("triage-outcome.takeOutcome.delete", error);
    // A record left behind is read by the next turn only if that turn records nothing.
  }
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tracker = record["tracker"];
  if (tracker !== "acted" && tracker !== "failed" && tracker !== "not_connected" && tracker !== "skipped") return undefined;
  const transition = record["transition"];
  const known = ["transitioned", "already", "no_transition", "not_connected", "failed", "skipped_status"] as const;
  const available = Array.isArray(record["available"]) ? record["available"].filter((name): name is string => typeof name === "string") : undefined;
  return {
    tracker,
    ...(typeof record["message"] === "string" ? { message: record["message"] } : {}),
    ...(known.includes(transition as (typeof known)[number]) ? { transition: transition as (typeof known)[number] } : {}),
    ...(typeof record["current"] === "string" ? { current: record["current"] } : {}),
    ...(available === undefined ? {} : { available }),
    ...(typeof record["transitionMessage"] === "string" ? { transitionMessage: record["transitionMessage"] } : {}),
  };
}

/** True when the turn moved the ticket to Triaged, or found it already moved on. */
export function settled(outcome: TriageOutcome | undefined, todo: string): boolean {
  if (outcome?.transition === "transitioned" || outcome?.transition === "already") return true;
  return outcome?.transition === "skipped_status" && outcome.current !== undefined && !sameName(outcome.current, todo);
}

/** One sentence on why the ticket is still in To Do, for the ticket and the thread. */
export function stopReason(input: { outcome?: TriageOutcome; failed?: string; statuses: { todo: string; triaged: string } }): string {
  const { outcome } = input;
  const { todo, triaged } = input.statuses;
  if (outcome?.tracker === "failed") return `Triage could not write its verdict to the ticket (${cut(outcome.message ?? "the tracker call failed")}).`;
  if (outcome?.tracker === "not_connected") return "Triage could not reach Jira: its tracker connection is not connected.";
  if (outcome?.tracker === "acted") {
    const recorded = "Triage recorded its verdict on the ticket, but";
    if (outcome.transition === "no_transition") {
      return `${recorded} Jira offers no move from ${todo} to ${triaged} (available: ${outcome.available?.join(", ") || "none"}).`;
    }
    if (outcome.transition === "failed") return `${recorded} the move to ${triaged} failed (${cut(outcome.transitionMessage ?? "no detail")}).`;
    if (outcome.transition === "not_connected") return `${recorded} could not reach Jira to move it to ${triaged}.`;
    if (outcome.transition === "skipped_status") return `${recorded} could not read its status, so it did not move it to ${triaged}.`;
  }
  if (input.failed !== undefined) return `The triage run failed: ${cut(input.failed)}.`;
  return "The triage run ended without recording a verdict.";
}

/**
 * At the end of a pinned triage turn: nothing when the turn moved the ticket
 * or it already left To Do, else a Triage stopped: comment. A status that
 * cannot be read writes nothing, so a flaky read never contradicts a move
 * that did land.
 */
export async function reportStoppedTriage(input: {
  issueKey: string;
  sessionId: string;
  failed?: string;
  kv: KeyedKv;
  mcp: HostMcpRegistry;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<StopReport> {
  const statuses = statusNames(input.env);
  const outcome = await takeOutcome(input.kv, input.sessionId);
  if (settled(outcome, statuses.todo)) return { status: "settled" };
  const current = await issueStatus(input.mcp, input.issueKey);
  if (current === undefined) return { status: "status_unknown" };
  if (!sameName(current, statuses.todo)) return { status: "moved_on", current };
  const why = stopReason({
    ...(outcome === undefined ? {} : { outcome }),
    ...(input.failed === undefined ? {} : { failed: input.failed }),
    statuses,
  });
  const written = await commentOnIssue(input.mcp, {
    issueKey: input.issueKey,
    body: triageStoppedComment({ issueKey: input.issueKey, why, at: input.now, triaged: statuses.triaged }),
  });
  return { status: "reported", why, tracker: written.status, ...(written.status === "failed" ? { message: written.message } : {}) };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string): string {
  const line = oneLine(text).replace(/[.!?]+$/, "");
  return line.length <= WHY_MAX ? line : `${line.slice(0, WHY_MAX - 1)}…`;
}

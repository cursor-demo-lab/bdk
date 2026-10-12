import { supportsKvCas, type HostMcpRegistry } from "@cursor/july";
import { sandboxRef, sandboxRepo, statusNames } from "./config.js";
import type { VerdictSkip } from "./jira-event.js";
import { commentOnTicket, issueStatus, type CommentOutcome } from "./jira.js";
import { planStoppedComment } from "./needs-info.js";
import { type KeyedKv, outcomeKey, skipClaimKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { outcomeKey, skipClaimKey };

// A pinned planning run must leave one outcome the desk can announce in the
// ticket's Slack thread: the Plan: comment and the move to Planned, or a
// Needs info: comment. record_plan and record_needs_info leave what they did
// under the session; when the turn ends, reportStoppedPlan reads it and, for a
// ticket still in Triaged with neither, writes a Plan stopped: comment with
// the reason. The desk wakes on that comment the way it wakes on Needs info.

export type PlanOutcome = {
  tool: "record_plan" | "record_needs_info";
  reason: string;
  tracker: string;
  transition?: string;
  missing?: string[];
  message?: string;
};

export type StopReport =
  | { status: "announced" | "moved_on" | "status_unknown"; current?: string }
  | { status: "reported"; why: string; tracker: CommentOutcome["status"]; message?: string };

const ON_TICKET = new Set(["commented", "already_commented"]);
const PLANNED = new Set(["transitioned", "already"]);
const WHY_MAX = 300;

/** Best effort: a lost record only costs a Plan stopped: comment its turn did not need. */
export async function rememberOutcome(kv: KeyedKv, sessionId: string, outcome: PlanOutcome): Promise<void> {
  try {
    await kv.put(outcomeKey(sessionId), outcome);
  } catch (error) {
    warnKv("plan-outcome.rememberOutcome", error);
    // Nothing to do; the turn's result still carries the outcome.
  }
}

export async function readOutcome(kv: KeyedKv, sessionId: string): Promise<PlanOutcome | undefined> {
  let value: unknown;
  try {
    value = await kv.get(outcomeKey(sessionId));
  } catch (error) {
    warnKv("plan-outcome.readOutcome", error);
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tool = record["tool"];
  if ((tool !== "record_plan" && tool !== "record_needs_info") || typeof record["reason"] !== "string" || typeof record["tracker"] !== "string") return undefined;
  const missing = Array.isArray(record["missing"]) ? record["missing"].filter((path): path is string => typeof path === "string") : [];
  return {
    tool,
    reason: record["reason"],
    tracker: record["tracker"],
    ...(typeof record["transition"] === "string" ? { transition: record["transition"] } : {}),
    ...(missing.length === 0 ? {} : { missing }),
    ...(typeof record["message"] === "string" ? { message: record["message"] } : {}),
  };
}

/**
 * True when the run already left what the desk announces: a Needs info:
 * comment, a plan on the ticket that moved to Planned, or a plan that found
 * the ticket already moved on (another run planned it).
 */
export function settled(outcome: PlanOutcome | undefined): boolean {
  if (outcome === undefined) return false;
  if (outcome.tool === "record_needs_info") return ON_TICKET.has(outcome.tracker) || outcome.reason === "not_triaged";
  if (outcome.reason === "not_triaged") return true;
  return outcome.reason === "recorded" && ON_TICKET.has(outcome.tracker) && outcome.transition !== undefined && PLANNED.has(outcome.transition);
}

/** One sentence on why the run ended without a plan, for the ticket and the thread. */
export function stopReason(input: { outcome?: PlanOutcome; failed?: string; repo: string; ref: string }): string {
  const { outcome, repo, ref } = input;
  const detail = (status: string, message?: string) => (message === undefined ? status : `${status}: ${cut(message)}`);
  if (outcome?.tool === "record_plan") {
    if (outcome.reason === "paths_missing") {
      const paths = outcome.missing === undefined ? "" : ` (${outcome.missing.join(", ")})`;
      return `The plan cited paths that are not on ${repo}@${ref}${paths}, so it was not recorded.`;
    }
    if (outcome.reason === "unverified") return `The plan did not cite code the planner opened on ${repo}@${ref}, so it was not recorded.`;
    if (outcome.reason === "recorded" && !ON_TICKET.has(outcome.tracker)) {
      return `The plan could not be written to the ticket (${detail(outcome.tracker, outcome.message)}).`;
    }
    if (outcome.reason === "recorded") {
      return `The plan is on the ticket, but it was not moved to Planned (${outcome.transition ?? "no move"}). Move the card to Planned in Jira to post the plan in the thread.`;
    }
  }
  if (outcome?.tool === "record_needs_info" && !ON_TICKET.has(outcome.tracker)) {
    return `The planner did not find the failure on ${repo}@${ref}, but its Needs info comment did not land (${detail(outcome.tracker, outcome.message)}).`;
  }
  if (input.failed !== undefined) return `The planning run failed: ${cut(input.failed)}.`;
  return "The planning run ended without recording a plan or saying what information it needs.";
}

/**
 * At the end of a pinned planning turn: nothing when the run already left
 * its outcome or the ticket left Triaged, else a Plan stopped: comment. A
 * status that cannot be read writes nothing, so a flaky read never contradicts
 * a plan that did land.
 */
export async function reportStoppedPlan(input: {
  issueKey: string;
  sessionId: string;
  failed?: string;
  kv: KeyedKv;
  mcp: HostMcpRegistry;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<StopReport> {
  const { issueKey, mcp, env } = input;
  const outcome = await readOutcome(input.kv, input.sessionId);
  if (settled(outcome)) return { status: "announced" };
  const current = await issueStatus(mcp, issueKey);
  if (current === undefined) return { status: "status_unknown" };
  if (current.trim().toLowerCase() !== statusNames(env).triaged.trim().toLowerCase()) return { status: "moved_on", current };
  const why = stopReason({
    ...(outcome === undefined ? {} : { outcome }),
    ...(input.failed === undefined ? {} : { failed: input.failed }),
    repo: sandboxRepo(env),
    ref: sandboxRef(env),
  });
  const tracker = await commentOnTicket(mcp, { issueKey, body: planStoppedComment({ issueKey, why, at: input.now }) }, env);
  return { status: "reported", why, tracker: tracker.status, ...("message" in tracker ? { message: tracker.message } : {}) };
}

function cut(text: string): string {
  const line = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return line.length <= WHY_MAX ? line : `${line.slice(0, WHY_MAX - 1)}…`;
}

/** Why the planner did not start a run for a Triaged entry, for the ticket and the thread. */
export function skipReason(skip: VerdictSkip): string {
  const whose = skip.from === "desk" ? "factory-desk's triage from filing" : skip.from === "triage" ? "the Triage: comment triage wrote" : "the latest Triage: comment";
  if (skip.reason === "duplicate") return `The triage verdict (${whose}) marks it a duplicate of ${skip.duplicateOf ?? "another ticket"}, and the planner does not plan duplicates.`;
  if (skip.reason === "needs_info") return `The triage verdict (${whose}) asks for more information, and no reply in the ticket's Slack thread has answered it yet.`;
  return `The triage verdict (${whose}) is a question, and the planner does not plan questions.`;
}

export type SkipReport =
  | { status: "reported"; why: string; tracker: CommentOutcome["status"]; message?: string }
  | { status: "duplicate" | "claim_unavailable"; why: string };

/**
 * Every move into Triaged that the verdict gate skipped leaves
 * `Plan stopped: <KEY>` with one `Why:` line, claimed per changelog id so a
 * redelivery writes nothing. The planner cannot tell a first entry from a
 * `plan KEY` bounce, and guessing wrong leaves the thread on the desk's
 * "planner is checking the code…" crumb (TLSSN-40), so it always writes it;
 * the desk decides whether the thread needs to hear it again
 * (factory-desk/agent/lib/announce.ts `redundantSkip`). The comment moves
 * nothing, and its first line is neither `Triage:` nor `Plan requested:`, the
 * only comments the legacy comment route reads, so it cannot wake the
 * planner. A comment that did not land releases the claim for a redelivery to
 * retry.
 */
export async function reportSkippedPlan(input: {
  skip: VerdictSkip;
  kv: KeyedKv;
  mcp: HostMcpRegistry;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<SkipReport> {
  const { skip, kv } = input;
  const why = skipReason(skip);
  const key = skipClaimKey(skip);
  const claim = { at: input.now.toISOString(), reason: skip.reason };
  // Plain read then put, with no owner and no settle (accepted, KV Phase 1
  // K3): two deliveries can both pass, and commentOnTicket's already_commented
  // is what keeps the second Plan stopped: off the ticket.
  try {
    if (supportsKvCas(kv)) {
      if (!(await kv.putIfAbsent(key, claim)).ok) return { status: "duplicate", why };
    } else {
      if ((await kv.get(key)) !== undefined) return { status: "duplicate", why };
      await kv.put(key, claim);
    }
  } catch (error) {
    warnKv("plan-outcome.reportSkippedPlan.putIfAbsent", error);
    return { status: "claim_unavailable", why };
  }
  const tracker = await commentOnTicket(input.mcp, { issueKey: skip.issueKey, body: planStoppedComment({ issueKey: skip.issueKey, why, at: input.now, skipped: true }) }, input.env);
  if (tracker.status !== "commented" && tracker.status !== "already_commented") await kv.delete(key).catch((error: unknown) => warnKv("plan-outcome.reportSkippedPlan.delete", error));
  return { status: "reported", why, tracker: tracker.status, ...("message" in tracker ? { message: tracker.message } : {}) };
}

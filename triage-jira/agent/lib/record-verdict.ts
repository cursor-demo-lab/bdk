import type { HostMcpRegistry } from "@cursor/july";
import { actuate } from "./actuate.js";
import { statusNames } from "./config.js";
import { sameTypeName, setIssueType, type IssueTypeRef } from "./issue-type.js";
import { settleJudgment, triageRecordLines, type TriageJudgment } from "./jev-triage.js";
import { inProcessPeers } from "./peers.js";
import { PLANNER_CONNECTION, PLAN_TOOL, chainDecision } from "./plan-chain.js";
import tracker from "./tracker.js";
import { transitionFrom, type GuardedTransition } from "./transition.js";
import { rememberOutcome, triageOutcome } from "./triage-outcome.js";
import { STAGING_REFUSED, stagingRefusalFor } from "./staging-issue.js";
import type { QueueAction, TriageVerdict } from "./types.js";
import type { KeyedKv } from "./kv-keys.js";

// Everything a verdict does to the ticket, from record_triage (the model's
// verdict) or jev-first.ts (Jev's, with no model turn): the issue type, the
// Triage: comment, the Triaged move, and the planner handoff.

export type RecordInput = {
  verdict: TriageVerdict;
  judged: TriageJudgment;
  /** The ticket's Jira type as the webhook delivered it. */
  currentType?: string;
  mcp: HostMcpRegistry;
  kv: KeyedKv;
  purpose?: "live" | "eval";
  continuationKey: string | null | undefined;
  /** The turn's session; the triage-outcome hook reads what this call left under it. */
  sessionId?: string;
};

export async function recordVerdict(input: RecordInput) {
  const live = input.purpose !== "eval";
  const write = await writeType(input.mcp, input.continuationKey ?? input.verdict.identifier, input.judged, live, input.currentType);
  const { verdict, judgment } = settleJudgment(input.verdict, input.judged, write);
  const line = triageRecordLines(judgment);
  const issueType = judgment.status === "judged" && judgment.type.applied ? judgment.type.choice : input.currentType;
  const result = await actuate({
    verdict,
    mcp: input.mcp,
    tracker,
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    issueKey: input.continuationKey ?? null,
    ...(line === undefined ? {} : { judgeLine: line }),
    ...(issueType === undefined ? {} : { issueType }),
  });
  const acted = result.tracker.status === "acted" && live ? result.tracker : undefined;
  const transition = acted === undefined ? undefined : await moveToTriaged(input.mcp, acted.issue.identifier, acted.actions);
  if (live && input.sessionId !== undefined) await rememberOutcome(input.kv, input.sessionId, triageOutcome(result, transition));
  const output = {
    ...result,
    verdict: { ...result.verdict },
    judge: judgment,
    tracker:
      result.tracker.status === "acted"
        ? {
            ...result.tracker,
            issue: { ...result.tracker.issue },
            actions: result.tracker.actions.map((action) => ({ ...action })),
          }
        : { ...result.tracker },
    ...(transition === undefined ? {} : { transition: { ...transition } }),
  };
  // The handoff has to finish inside this call. A hook on action.result
  // does not run before the process can exit, so the planner would never
  // see the only recording of the verdict.
  const decision = chainDecision({
    toolName: "record_triage",
    isError: false,
    stubbed: false,
    output,
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    continuationKey: input.continuationKey ?? null,
  });
  if (!decision.chain) {
    return { ...output, chained: false, reason: decision.reason };
  }
  if (!inProcessPeers()) {
    return { ...output, chained: false, reason: "event_bus" };
  }
  return { ...output, ...(await handOffToPlanner(input.mcp, decision.request)) };
}

/**
 * The peer call to the planner's plan_issue. The key is the one actuate acted
 * on, so actuate's own staging check normally refuses first; this one holds
 * for any caller, since plan_issue opens a planning session on the key.
 */
export async function handOffToPlanner(mcp: HostMcpRegistry, request: { issueKey: string } & Record<string, unknown>): Promise<{ chained: true } | { chained: false; reason: string }> {
  if (!mcp.names().includes(PLANNER_CONNECTION)) return { chained: false, reason: "no_planner_connection" };
  if (stagingRefusalFor(request.issueKey) !== undefined) return { chained: false, reason: STAGING_REFUSED };
  try {
    await mcp.callTool(PLANNER_CONNECTION, "call_tool", { toolName: PLAN_TOOL, input: request });
    return { chained: true };
  } catch (error) {
    return { chained: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export type RecordedVerdict = Awaited<ReturnType<typeof recordVerdict>>;

// Only a confident type is written, before the Triage: comment, so the
// comment and the board agree. A failed edit is reported, never retried
// here: triage goes on with the kind it had.
async function writeType(mcp: HostMcpRegistry, issueKey: string, judgment: TriageJudgment, live: boolean, current: string | undefined) {
  if (judgment.status !== "judged" || !judgment.type.confident) return { status: "not_written" as const };
  if (!live) return { status: "eval" as const };
  if (sameTypeName(current, judgment.type.choice)) return { status: "already" as const };
  const type: IssueTypeRef = { name: judgment.type.choice, ...(judgment.type.id === undefined ? {} : { id: judgment.type.id }) };
  return setIssueType(mcp, issueKey, type);
}

// The ticket entering Triaged is what wakes the planner. It moves only from
// the initial status, whether this call wrote the Triage: comment or found
// one an earlier call wrote before it died: from any later status the move
// would drag a planned, approved, or launched ticket back and wake the
// planner on it again.
async function moveToTriaged(mcp: HostMcpRegistry, issueKey: string, actions: readonly QueueAction[]): Promise<GuardedTransition | undefined> {
  if (!actions.some((action) => action.op === "commented" || action.op === "already_commented")) return undefined;
  const statuses = statusNames(process.env);
  return transitionFrom(mcp, { issueKey, from: statuses.todo, toStatus: statuses.triaged });
}

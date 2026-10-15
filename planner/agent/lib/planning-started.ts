import { supportsKvCas, type HostMcpRegistry } from "@cursor/july";
import { commentOnTicket, type CommentOutcome } from "./jira.js";
import { type KeyedKv, startedClaimKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { startedClaimKey };

// The desk's plan hop watch could not tell a planner still working from one
// that never started (TLSSN-45: a 23-minute run read as stalled at 15, and a
// `retry` started a second, concurrent run). When a pinned planning turn
// starts, the planner writes one `Planning started: <KEY>` comment with the
// session and the start time. factory-desk/agent/lib/planner-liveness.ts
// reads it; `../scripts/outcome-sentinels.test.mjs` holds the two in step.
// The first line is neither `Triage:` nor `Plan requested:`, so it cannot
// wake the planner's legacy comment route, and it is no outcome the desk
// announces.

export const PLANNING_STARTED_SENTINEL = "Planning started:";

export function planningStartedComment(input: { issueKey: string; sessionId: string; at: Date }): string {
  return [
    `${PLANNING_STARTED_SENTINEL} ${input.issueKey}`,
    `Session: ${input.sessionId}`,
    `Started at: ${input.at.toISOString()}`,
    "",
    "The planner is reading the code. A Plan, a Needs info, or a Plan stopped comment follows when this run ends.",
  ].join("\n");
}

export type StartedMark = { status: "duplicate" | "claim_unavailable" } | { status: "marked"; tracker: CommentOutcome["status"] };

/**
 * Once per turn: a redelivery of the same turn's event writes nothing, and a
 * later turn on the same session (a resumed run) gets a fresh start time. A
 * comment that did not land releases the claim so a redelivery tries again.
 */
export async function markPlanningStarted(input: {
  issueKey: string;
  sessionId: string;
  turnId?: string;
  kv: KeyedKv;
  mcp: HostMcpRegistry;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<StartedMark> {
  const { kv, sessionId } = input;
  const key = startedClaimKey({ sessionId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }) });
  const claim = { issueKey: input.issueKey, at: input.now.toISOString() };
  // Plain read then put, with no owner and no settle (accepted, KV Phase 1
  // K3): two hooks can both pass, and commentOnTicket's already_commented is
  // what keeps a second Planning started: off the ticket.
  try {
    if (supportsKvCas(kv)) {
      if (!(await kv.putIfAbsent(key, claim)).ok) return { status: "duplicate" };
    } else {
      if ((await kv.get(key)) !== undefined) return { status: "duplicate" };
      await kv.put(key, claim);
    }
  } catch (error) {
    warnKv("planning-started.markPlanningStarted.putIfAbsent", error);
    return { status: "claim_unavailable" };
  }
  const tracker = await commentOnTicket(input.mcp, { issueKey: input.issueKey, body: planningStartedComment({ issueKey: input.issueKey, sessionId, at: input.now }) }, input.env);
  if (tracker.status !== "commented" && tracker.status !== "already_commented") await kv.delete(key).catch((error: unknown) => warnKv("planning-started.markPlanningStarted.delete", error));
  return { status: "marked", tracker: tracker.status };
}

/** One log line per finished planning turn: its tokens when the turn reported usage (a failed turn passes none), plus `cost.model` and the cost when a test injects `data.cost` (else `model: "unknown"`). July 0.2.25 never stamps cost on live `turn.completed`. */
export function turnModelLine(input: {
  issueKey: string | undefined;
  sessionId: string;
  outcome: "completed" | "failed";
  data: { usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens?: number }; cost?: { model: string; totalUsd: number; source: string } };
}): Record<string, unknown> {
  const { usage, cost } = input.data;
  return {
    planner: "turn_model",
    outcome: input.outcome,
    sessionId: input.sessionId,
    ...(input.issueKey === undefined ? {} : { issueKey: input.issueKey }),
    model: cost?.model ?? "unknown",
    ...(cost === undefined ? {} : { costUsd: cost.totalUsd, pricedFrom: cost.source }),
    ...(usage === undefined ? {} : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }) }),
  };
}

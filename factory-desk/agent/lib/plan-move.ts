import type { HostMcpRegistry } from "@cursor/july";
import type { StatusNames } from "./config.js";
import { transitionFrom, transitionIssue, type GuardedTransition, type TransitionOutcome } from "./jira.js";
import { type KeyedKv, plannerSentKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { plannerSentKey };

export type PlanMove =
  | { requested: true; reason: "transitioned" | "bounced"; toStatus: string }
  | {
      requested: false;
      reason: Exclude<TransitionOutcome["status"], "transitioned"> | "moved_on" | "status_unknown";
      toStatus: string;
      available?: string[];
      message?: string;
      current?: string;
      detail?: string;
    };

/**
 * Planning is a move to Triaged: the planner wakes on that status change. A
 * ticket already in Triaged is bounced to To Do and back, because a Triaged
 * to Triaged move writes no status change and would wake nothing. The caller
 * has read `current` and decided the ticket may move; a failed move to To Do
 * is reported and the second move is not tried. Each move is made only from
 * the status the one before it left (`transitionFrom`), so an approve that
 * lands after the caller's read is not pulled back to Triaged from Approved.
 * With `kv`, the send is recorded first (`plannerSentKey`), before the move
 * wakes the planner, so a `Plan stopped:` it answers with is always relayed.
 */
export async function moveToPlanner(mcp: HostMcpRegistry, input: { issueKey: string; current?: string; statuses: StatusNames; kv?: KeyedKv; now?: Date }): Promise<PlanMove> {
  const { issueKey, statuses } = input;
  if (input.kv !== undefined) await input.kv.put(plannerSentKey(issueKey), { at: (input.now ?? new Date()).toISOString() }).catch((error: unknown) => warnKv("plan-move.moveToPlanner", error));
  const toStatus = statuses.triaged;
  if (input.current?.toLowerCase() !== toStatus.toLowerCase()) {
    const outcome = input.current === undefined ? await transitionIssue(mcp, { issueKey, toStatus }) : await transitionFrom(mcp, { issueKey, from: input.current, toStatus });
    if (outcome.status === "transitioned") return { requested: true, reason: "transitioned", toStatus };
    if (outcome.status !== "already") return notMoved(toStatus, outcome);
  }
  const back = await transitionFrom(mcp, { issueKey, from: toStatus, toStatus: statuses.todo });
  if (back.status !== "transitioned" && back.status !== "already") return notMoved(statuses.todo, back);
  const forward = await transitionFrom(mcp, { issueKey, from: statuses.todo, toStatus });
  if (forward.status !== "transitioned") return { current: statuses.todo, ...notMoved(toStatus, forward) };
  return { requested: true, reason: "bounced", toStatus };
}

function notMoved(toStatus: string, outcome: Exclude<GuardedTransition, { status: "transitioned" }>): Extract<PlanMove, { requested: false }> {
  if (outcome.status === "skipped_status") {
    return outcome.current === undefined
      ? { requested: false, reason: "status_unknown", toStatus, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) }
      : { requested: false, reason: "moved_on", toStatus, current: outcome.current };
  }
  return {
    requested: false,
    reason: outcome.status,
    toStatus,
    ...(outcome.status === "no_transition" ? { available: outcome.available } : {}),
    ...(outcome.status === "failed" ? { message: outcome.message } : {}),
  };
}

/** How long after the desk sends a ticket to the planner a verdict skip is still that send's answer. */
export const PLANNER_SENT_MS = 30 * 60_000;

/** True when the desk sent the ticket to the planner (`plan`, `retry`, `request_plan`, a Needs-info reply) in the last PLANNER_SENT_MS. */
export async function sentToPlannerRecently(kv: KeyedKv, issueKey: string, now: Date): Promise<boolean> {
  try {
    const stored = await kv.get(plannerSentKey(issueKey));
    const at = stored !== null && typeof stored === "object" && !Array.isArray(stored) ? stored["at"] : undefined;
    const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
    return Number.isFinite(ms) && now.getTime() - ms < PLANNER_SENT_MS;
  } catch (error) {
    warnKv("plan-move.sentToPlannerRecently", error);
    return true;
  }
}

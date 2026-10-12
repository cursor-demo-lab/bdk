import type { HostMcpRegistry } from "@cursor/july";
import type { StatusNames } from "./config.js";
import type { KeyedKv } from "./kv-keys.js";
import { moveToPlanner, type PlanMove } from "./plan-move.js";
import { showPlannerWait } from "./planner-wait.js";
import { clearAwaitingFor } from "./thread-detail.js";

// The redelivery a To Do or Triaged ticket gets from `retry KEY`
// (retry-command.ts) and, once, from the plan start check (hop-watch.ts):
// the planner's move (`moveToPlanner`, which records `planner-sent/<KEY>`
// before it moves), then, only once the move landed, the thread stops
// waiting on a needs-info answer and the planner crumb goes up. The caller
// has read the status and applied its gates (the triage gate, a live
// planner run, and for a person's retry the filer gate and the deadline).

export type RedeliverInput = {
  mcp: HostMcpRegistry;
  kv: KeyedKv;
  getClient: () => Promise<unknown>;
  issueKey: string;
  /** The status the caller read; the move is made only from it. */
  current: string;
  statuses: StatusNames;
  now?: Date;
  /** Runs after the move landed and before the crumb, so a reply lands above it. */
  said?: () => Promise<unknown>;
};

export async function redeliverToPlanner(input: RedeliverInput): Promise<PlanMove> {
  const { kv, issueKey } = input;
  const moved = await moveToPlanner(input.mcp, { issueKey, current: input.current, statuses: input.statuses, kv, ...(input.now === undefined ? {} : { now: input.now }) });
  if (!moved.requested) return moved;
  await clearAwaitingFor(kv, issueKey);
  await input.said?.();
  await showPlannerWait({ kv, getClient: input.getClient, issueKey, phase: "planning" });
  return moved;
}

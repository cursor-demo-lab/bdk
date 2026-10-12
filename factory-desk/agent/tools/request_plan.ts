import type { HostMcpRegistry } from "@cursor/july";
import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { statusNames } from "../lib/config.js";
import { issueStatus, readComments, unreadDetail } from "../lib/jira.js";
import { gateCommand, refusal } from "../lib/originator.js";
import { moveToPlanner } from "../lib/plan-move.js";
import { showPlannerWait } from "../lib/planner-wait.js";
import { clearAwaitingFor } from "../lib/thread-detail.js";
import { latestTriageVerdict, type TriageGate } from "../lib/triage-comment.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { tagSessionTicket } from "../lib/factory-otel.js";

// Planning is a move to Triaged: from To Do for a first plan, from Planned
// for a replan (plan-move.ts, which bounces a ticket already in Triaged).
// The status is read first because a global transition into Triaged is
// offered from Triaged too. A ticket bound to a Slack thread is gated like approve_ticket,
// because a move out of Planned replaces the plan whatever `replan` says.
// Only a first plan KEY, on a ticket the desk has never bound that is still
// in To Do, is open to anyone. A bound ticket is moved only from To Do,
// Triaged, or Planned: a replan that runs after the ticket was approved
// would pull it out from under the worker. The move re-reads the status as
// its last call (plan-move.ts), so an approve that lands after this read
// is not undone either.
export default defineTool({
  description:
    "Ask the planner to plan a Jira ticket by moving it to Triaged (a ticket already in Triaged goes to To Do and back). Jira wakes the planner. Use for plan KEY or replan KEY. Host code refuses (not_originator, wrong_thread, jira_only) a ticket that has a Slack thread unless the person who filed it asks from that thread, and moves nothing (triage_gate) when the latest Triage: verdict is one the planner skips. Never to approve or launch.",
  inputSchema: z.object({
    issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
    replan: z.boolean().optional().describe("True when the person asked to replace the recorded plan."),
  }),
  effect: "write",
  dryRunResult: (input) => ({ requested: false, reason: "dry_run", issueKey: input.issueKey }),
  async execute(input, ctx) {
    bindOpsFunnel(ctx.host);
    const { issueKey } = input;
    // The turn's usage is this ticket's (hooks/ticket-key.ts); never throws.
    tagSessionTicket(ctx.host, issueKey);
    if (ctx.session.purpose === "eval") {
      // Shaped like a live move, as file_ticket's eval result is, so the reply
      // follows instructions.md's `transitioned` branch; nothing is written to Jira.
      const toStatus = statusNames(process.env).triaged;
      return { ok: true, requested: true, reason: "transitioned", issueKey, replan: input.replan === true, toStatus, eval: true, message: `Moved ${issueKey} to ${toStatus} (eval mode: Jira write simulated).` };
    }
    // Only the reply uses this. The planner reads replan off the ticket: a move from Planned or a Plan: comment already there.
    const replan = input.replan === true;
    const gate = await gateCommand(ctx, { issueKey, verbs: replan ? ["replan", "plan"] : ["plan", "replan"], unbound: replan ? "refuse" : "allow" });
    if (gate.status !== "ok" && gate.status !== "unbound") {
      return { requested: false, issueKey, replan, ...refusal(gate, { for: "plan" }) };
    }
    const statuses = statusNames(process.env);
    const toStatus = statuses.triaged;
    const read = await issueStatus(ctx.host.mcp, issueKey);
    const current = read.status === "read" ? read.name : undefined;
    if (gate.status === "unbound" && current?.toLowerCase() !== statuses.todo.toLowerCase()) {
      return { requested: false, issueKey, replan, ...refusal({ status: "jira_only" }, { for: "plan" }), ...(current === undefined ? {} : { current }) };
    }
    if (current !== undefined && ![statuses.todo, statuses.triaged, statuses.planned].some((name) => name.toLowerCase() === current.toLowerCase())) {
      return { requested: false, reason: "moved_on", issueKey, replan, toStatus, current };
    }
    if (read.status === "unread") {
      return { requested: false, reason: "status_unknown", issueKey, replan, toStatus, ...unreadDetail(read.detail) };
    }
    const gated = await triageGate(ctx.host.mcp, issueKey);
    if (gated !== undefined) {
      return { requested: false, reason: "triage_gate", issueKey, replan, toStatus, ...gated, ...(current === undefined ? {} : { current }) };
    }
    const moved = await moveToPlanner(ctx.host.mcp, { issueKey, ...(current === undefined ? {} : { current }), statuses, kv: ctx.host.kv });
    if (moved.requested) {
      await clearAwaitingFor(ctx.host.kv, issueKey);
      await showPlannerWait({ kv: ctx.host.kv, getClient: () => ctx.host.slack.getClient(), issueKey, phase: "planning" });
    }
    return { ...moved, issueKey, replan };
  },
});

// The planner skips a Triaged wake whose latest Triage: verdict is a
// question, needs information, or is a duplicate, so a move would wake
// nothing and the reply would promise a plan that never comes. Comments that
// cannot be read gate nothing: the planner plans without a verdict then too.
async function triageGate(mcp: HostMcpRegistry, issueKey: string): Promise<{ gate: TriageGate; duplicateOf?: string; nextStep?: string } | undefined> {
  const read = await readComments(mcp, issueKey);
  if (read.status !== "read") return undefined;
  const verdict = latestTriageVerdict(read.comments);
  if (verdict?.gate === undefined) return undefined;
  return {
    gate: verdict.gate,
    ...(verdict.duplicateOf === undefined ? {} : { duplicateOf: verdict.duplicateOf }),
    ...(verdict.nextStep === undefined ? {} : { nextStep: verdict.nextStep }),
  };
}

import { defineHook, type HookContext } from "@cursor/july/hooks";
import { pinnedIssueKey } from "../lib/chain.js";
import { factoryModel } from "../lib/config.js";
import { reportStoppedPlan } from "../lib/plan-outcome.js";
import { markPlanningStarted, turnModelLine } from "../lib/planning-started.js";
import { resetSearchBudget } from "../lib/search-budget.js";
import { digestRefusedKey } from "../lib/kv-keys.js";
import { bindOpsFunnel, warnKv } from "../lib/ops-funnel.js";

// A pinned planning run (`issue:<KEY>#<attempt>`, from the Triaged webhook or
// plan_issue) that ends with neither a plan nor a Needs info verdict leaves a
// Plan stopped: comment, so the desk can tell the ticket's thread why. A turn
// interrupted by a stop or a preempting follow-up reports nothing; July names
// that one `turn interrupted`. A turn the runner cancelled on its own is a lost
// run like a failed one and reports.
// When the turn starts, the run leaves `Planning started:` so the desk can
// tell a slow run from one that never started (planning-started.ts).
// Eval and dry-run sessions write nothing. The hook runs in the serving pod,
// as pr-autofixer's drive-claim hook does; a one-shot `agent-sdk run` can
// exit before it dispatches.
export default defineHook({
  events: {
    "turn.started": async (event, ctx) => {
      await started(ctx, event.turnId);
    },
    "turn.completed": async (event, ctx) => {
      await report(ctx);
      // July 0.2.20 dropped per-turn cost: `turn.completed` never carries
      // `event.data.cost`. Live lines stay `model: "unknown"` with no
      // `costUsd`. Tokens still land on the event. Unit tests that inject a
      // `cost` object still pass. Durable cost is GET /v1/session/:id/cost.
      console.log(JSON.stringify(turnModelLine({ issueKey: issueKeyOf(ctx), sessionId: ctx.session.id, outcome: "completed", data: event.data })));
    },
    "turn.failed": async (event, ctx) => {
      console.log(JSON.stringify({ ...turnModelLine({ issueKey: issueKeyOf(ctx), sessionId: ctx.session.id, outcome: "failed", data: {} }), message: event.data.message }));
      if (event.data.message === "turn interrupted") return;
      await report(ctx, event.data.message);
    },
  },
});

function issueKeyOf(ctx: HookContext): string | undefined {
  return pinnedIssueKey(ctx.session.continuationKey ?? ctx.channel.continuationToken);
}

function live(ctx: HookContext): boolean {
  return ctx.session.purpose !== "eval" && ctx.session.dryRun !== true;
}

async function started(ctx: HookContext, turnId: string | undefined): Promise<void> {
  bindOpsFunnel(ctx.host);
  const issueKey = issueKeyOf(ctx);
  await resetSearchBudget(ctx.host.kv, ctx.session.id);
  await ctx.host.kv.delete(digestRefusedKey(ctx.session.id)).catch((error: unknown) => warnKv("hook.plan-outcome.started", error));
  console.log(JSON.stringify({ planner: "turn_started", sessionId: ctx.session.id, ...(issueKey === undefined ? {} : { issueKey }), requested: factoryModel(process.env) }));
  if (!live(ctx) || issueKey === undefined) return;
  try {
    const mark = await markPlanningStarted({ issueKey, sessionId: ctx.session.id, ...(turnId === undefined ? {} : { turnId }), kv: ctx.host.kv, mcp: ctx.host.mcp, env: process.env, now: new Date() });
    if (mark.status === "marked" && mark.tracker !== "commented" && mark.tracker !== "already_commented") {
      console.error(`[planner] ${issueKey} planning-started marker did not land (${mark.tracker})`);
    }
  } catch (error) {
    console.error(`[planner] could not mark planning started for ${issueKey}:`, error);
  }
}

async function report(ctx: HookContext, failed?: string): Promise<void> {
  if (!live(ctx)) return;
  const issueKey = issueKeyOf(ctx);
  if (issueKey === undefined) return;
  try {
    const report = await reportStoppedPlan({
      issueKey,
      sessionId: ctx.session.id,
      ...(failed === undefined ? {} : { failed }),
      kv: ctx.host.kv,
      mcp: ctx.host.mcp,
      env: process.env,
      now: new Date(),
    });
    if (report.status === "reported") {
      console.log(`[planner] ${issueKey} stopped without a plan (${report.tracker}): ${report.why}`);
    }
  } catch (error) {
    console.error(`[planner] could not report the stopped plan for ${issueKey}:`, error);
  }
}

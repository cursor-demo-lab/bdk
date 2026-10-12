import { defineHook, type HookContext } from "@cursor/july/hooks";
import { pinIssueIdentifier } from "../lib/parse-queue-event.js";
import { stagingRefusesIssue } from "../lib/staging-issue.js";
import { reportStoppedTriage } from "../lib/triage-outcome.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

// A triage run pinned to a ticket (the issue-created webhook or the queue
// route) that ends with the ticket still in To Do leaves a Triage stopped:
// comment, so the desk can tell the ticket's thread why no Triaged line came.
// A cancelled turn (a stop, or a follow-up interrupting it) reports nothing.
// Eval and dry-run sessions write nothing. The hook runs in the serving pod,
// as the planner's plan-outcome hook does; a one-shot `agent-sdk run` can
// exit before it dispatches. The planner handoff stays in record_triage.
export default defineHook({
  events: {
    "turn.completed": async (_event, ctx) => {
      await report(ctx);
    },
    "turn.failed": async (event, ctx) => {
      if (event.data.status === "cancelled" || event.data.message === "turn interrupted") return;
      await report(ctx, event.data.message);
    },
  },
});

async function report(ctx: HookContext, failed?: string): Promise<void> {
  bindOpsFunnel(ctx.host);
  if (ctx.session.purpose === "eval" || ctx.session.dryRun === true) return;
  const issueKey = pinIssueIdentifier(ctx.session.continuationKey ?? ctx.channel.continuationToken, "");
  if (issueKey === "" || stagingRefusesIssue(process.env, issueKey)) return;
  try {
    const report = await reportStoppedTriage({
      issueKey,
      sessionId: ctx.session.id,
      ...(failed === undefined ? {} : { failed }),
      kv: ctx.host.kv,
      mcp: ctx.host.mcp,
      env: process.env,
      now: new Date(),
    });
    if (report.status === "reported") {
      console.log(`[triage] ${issueKey} stopped before Triaged (${report.tracker}): ${report.why}`);
    }
  } catch (error) {
    console.error(`[triage] could not report the stopped triage for ${issueKey}:`, error);
  }
}

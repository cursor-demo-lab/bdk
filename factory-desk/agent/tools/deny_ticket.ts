import { defineTool, type ToolContext } from "@cursor/july/tools";
import { z } from "zod";
import { takeTicketDecision } from "../lib/approve-command.js";
import { ackCommand } from "../lib/command-ack.js";
import type { HostMcpRegistry } from "@cursor/july";
import { addComment, type CommentWrite } from "../lib/jira.js";
import { gateCommand, refusal } from "../lib/originator.js";
import { threadFromSession } from "../lib/threads.js";
import { alreadyDeclinedLine, declineGate, declinedLine, deniedComment, notPlannedLine, recordDecline, type DeclineGate } from "../lib/plan-decline.js";
import { replyPrefix } from "../lib/desk-channels.js";
import { tagSessionTicket } from "../lib/factory-otel.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

// One denial per plan, and only on a Planned ticket: the same declineGate the
// ❌ path runs. A plan already declined in Jira (a ❌, or an earlier deny) gets
// no second comment, and anything unreadable writes nothing.
async function denyOnce(mcp: HostMcpRegistry, { issueKey, by }: { issueKey: string; by: string }): Promise<CommentWrite | Exclude<DeclineGate, { state: "open" }>> {
  const decided = await declineGate(mcp, issueKey);
  if (decided.state !== "open") return decided;
  return addComment(mcp, { issueKey, body: deniedComment(by) });
}

// A denial is a record on the ticket, not a transition. The ticket stays
// Planned so a later approve KEY or a drag to Approved still works. Gated
// like approve_ticket: the filer, in the ticket's thread.
export default defineTool({
  description:
    "Record on a planned Jira ticket that a person replied deny KEY in this thread. Posts one comment and the plan-declined label; never moves the ticket. On denied, reply with the result's reply field exactly. Host code refuses (not_originator, wrong_thread, jira_only) unless that person filed the ticket from this thread. Use once per deny.",
  inputSchema: z.object({
    issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
    by: z.string().trim().min(1).max(120).optional().describe("Slack display name of the person who denied."),
  }),
  effect: "write",
  dryRunResult: (input) => ({ denied: false, reason: "dry_run", issueKey: input.issueKey }),
  async execute(input, ctx) {
    bindOpsFunnel(ctx.host);
    // The turn's usage is this ticket's (hooks/ticket-key.ts); never throws.
    tagSessionTicket(ctx.host, input.issueKey);
    // An eval touches no ticket, but answers like a live denial so the reply reports it done.
    if (ctx.session.purpose === "eval") {
      return { ok: true, denied: true, reason: "commented", issueKey: input.issueKey, eval: true, reply: declinedLine({ issueKey: input.issueKey, prefix: replyPrefix(threadFromSession(ctx.session)?.channelId) }), message: `Denied ${input.issueKey} (eval mode: Jira write simulated).` };
    }
    const gate = await gateCommand(ctx, { issueKey: input.issueKey, verbs: ["deny"] });
    if (gate.status !== "ok" && gate.status !== "unbound") {
      return { denied: false, issueKey: input.issueKey, ...refusal(gate) };
    }
    const by = input.by ?? "a person in the Slack thread";
    // The ticket's decision hold (approve-command.ts): never beside an approval in flight.
    const hold = await takeTicketDecision(ctx, { issueKey: input.issueKey, by, now: ctx.now(), act: "decline" });
    if (hold === "duplicate" || hold === "unavailable") {
      return { denied: false, reason: hold === "duplicate" ? "decision_in_flight" : "claim_unavailable", issueKey: input.issueKey };
    }
    // The hold covers the whole decline (comment, label, stage reaction), as on the ❌ path, so an
    // approve cannot land between the comment and the label and leave plan-declined on approved work.
    try {
      return await recordDenial(ctx, { issueKey: input.issueKey, by, commandTs: gate.status === "ok" ? gate.commandTs : undefined, filer: gate.status === "ok" });
    } finally {
      await hold.release();
    }
  },
});

/** Everything a deny records, under the ticket's decision hold. */
async function recordDenial(ctx: ToolContext, input: { issueKey: string; by: string; commandTs: string | undefined; filer: boolean }) {
  const { issueKey, by } = input;
  const outcome = await denyOnce(ctx.host.mcp, { issueKey, by });
  if ("state" in outcome) {
    switch (outcome.state) {
      case "not_planned":
        return { denied: false, reason: "not_planned", issueKey, current: outcome.status, message: notPlannedLine({ issueKey, status: outcome.status }) };
      case "declined":
        return { denied: false, reason: "already_declined", issueKey, message: alreadyDeclinedLine(issueKey) };
      case "status_unread":
        return { denied: false, reason: "status_unknown", issueKey, message: `I could not read ${issueKey} in Jira, so nothing changed.` };
      case "comments_unread":
        return { denied: false, reason: "comments_unread", issueKey, message: `I could not read ${issueKey}'s comments in Jira, so nothing changed.` };
    }
  }
  if (outcome.status !== "commented") {
    return {
      denied: false,
      reason: outcome.status,
      issueKey,
      ...(outcome.status === "failed" ? { message: outcome.message } : {}),
    };
  }
  // ✅ on the person's `deny KEY` (or plain `deny`) once the decline is on the ticket, as approve_ticket acks an approval.
  if (input.filer) {
    await ackCommand({ getClient: () => ctx.host.slack.getClient(), target: { channel: threadFromSession(ctx.session)?.channelId, ts: input.commandTs }, command: "deny KEY", issueKey });
  }
  await recordDecline(ctx.host, issueKey);
  const thread = threadFromSession(ctx.session);
  return { denied: true, reason: "commented", issueKey, reply: declinedLine({ issueKey, prefix: replyPrefix(thread?.channelId) }) };
}

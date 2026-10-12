import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { ackCommand } from "../lib/command-ack.js";
import { clearPlanDeclined } from "../lib/plan-decline.js";
import { tagSessionTicket } from "../lib/factory-otel.js";
import { statusNames } from "../lib/config.js";
import { issueStatus, transitionFrom, unreadDetail } from "../lib/jira.js";
import { gateCommand, refusal } from "../lib/originator.js";
import { clearSlackApproval, recordSlackApproval } from "../lib/slack-approval.js";
import { threadFromSession } from "../lib/threads.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

// The approve moment is a Jira transition. factory-worker wakes on Approved
// and launches; the desk launches nothing. No claim: a ticket already in
// Approved returns already. The move is made only from Planned, because
// Jira offers global transitions: an approve that runs after the ticket
// moved on (In Progress, In Review, Done) would drag it back and launch it
// again, and one that runs after a replan (Triaged) would launch the old
// brief. The status is read first for the answer, then the move itself is
// guarded (`transitionFrom`, which reads it again as its last call). Only
// the person who filed the ticket, in its own thread, can approve from
// Slack; anyone Jira lets move the card can approve there. An approval
// gets the same ✅ on the person's `approve KEY` message as the host path.
export default defineTool({
  description:
    "Move a planned Jira ticket to Approved after a person replies approve KEY in this thread. Host code refuses (not_originator, wrong_thread, jira_only) unless that person filed the ticket from this thread; Jira is untouched then. The factory worker starts implementation from Approved. Use once per approve. Never to launch, plan, or comment.",
  inputSchema: z.object({
    issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
  }),
  effect: "write",
  dryRunResult: (input) => ({ approved: false, reason: "dry_run", issueKey: input.issueKey, transition: "skipped" }),
  async execute(input, ctx) {
    bindOpsFunnel(ctx.host);
    // The turn's usage is this ticket's (hooks/ticket-key.ts); never throws.
    tagSessionTicket(ctx.host, input.issueKey);
    // An eval touches no ticket, but answers like a live move so the reply reports it done.
    if (ctx.session.purpose === "eval") {
      const toStatus = statusNames(process.env).approved;
      return { ok: true, approved: true, reason: "transitioned", issueKey: input.issueKey, transition: "transitioned", toStatus, eval: true, message: `Approved ${input.issueKey} (eval mode: Jira write simulated).` };
    }
    const gate = await gateCommand(ctx, { issueKey: input.issueKey, verbs: ["approve"] });
    if (gate.status !== "ok" && gate.status !== "unbound") {
      return { approved: false, issueKey: input.issueKey, transition: "skipped", ...refusal(gate) };
    }
    const approved = async () => {
      await clearPlanDeclined(ctx.host, input.issueKey);
      if (gate.status !== "ok") return;
      await ackCommand({
        getClient: () => ctx.host.slack.getClient(),
        target: { channel: threadFromSession(ctx.session)?.channelId, ts: gate.commandTs },
        command: "approve KEY",
        issueKey: input.issueKey,
      });
    };
    const statuses = statusNames(process.env);
    const toStatus = statuses.approved;
    const read = await issueStatus(ctx.host.mcp, input.issueKey);
    const current = read.status === "read" ? read.name : undefined;
    if (current?.toLowerCase() === toStatus.toLowerCase()) {
      await approved();
      return { approved: true, reason: "already_approved", issueKey: input.issueKey, transition: "already", toStatus };
    }
    if (current !== undefined && current.toLowerCase() !== statuses.planned.toLowerCase()) {
      return { approved: false, reason: "moved_on", issueKey: input.issueKey, transition: "skipped", toStatus, current };
    }
    if (read.status === "unread") {
      return { approved: false, reason: "status_unknown", issueKey: input.issueKey, transition: "skipped", toStatus, ...unreadDetail(read.detail) };
    }
    await recordSlackApproval(ctx.host.kv, { issueKey: input.issueKey, at: ctx.now(), by: gate.status === "ok" ? gate.originatorUserId : undefined });
    const outcome = await transitionFrom(ctx.host.mcp, { issueKey: input.issueKey, from: statuses.planned, toStatus });
    if (outcome.status !== "transitioned" && outcome.status !== "already") await clearSlackApproval(ctx.host.kv, input.issueKey);
    switch (outcome.status) {
      case "transitioned":
        await approved();
        return { approved: true, reason: "transitioned", issueKey: input.issueKey, transition: outcome.status, toStatus };
      case "already":
        await approved();
        return { approved: true, reason: "already_approved", issueKey: input.issueKey, transition: outcome.status, toStatus };
      case "skipped_status":
        return outcome.current === undefined
          ? { approved: false, reason: "status_unknown", issueKey: input.issueKey, transition: "skipped", toStatus, ...unreadDetail(outcome.detail) }
          : { approved: false, reason: "moved_on", issueKey: input.issueKey, transition: "skipped", toStatus, current: outcome.current };
      case "no_transition":
        return { approved: false, reason: "no_transition", issueKey: input.issueKey, transition: outcome.status, toStatus, available: outcome.available };
      case "not_connected":
        return { approved: false, reason: "not_connected", issueKey: input.issueKey, transition: outcome.status, toStatus };
      case "failed":
        return { approved: false, reason: "failed", issueKey: input.issueKey, transition: outcome.status, toStatus, message: outcome.message };
    }
  },
});

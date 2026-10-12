import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { pinnedIssueKey } from "../lib/chain.js";
import { sandboxRef, sandboxRepo, statusNames } from "../lib/config.js";
import { commentOnTicket, issueStatus, type CommentOutcome } from "../lib/jira.js";
import { needsInfoComment } from "../lib/needs-info.js";
import { readOutcome, rememberOutcome } from "../lib/plan-outcome.js";
import { issueKeySchema } from "../lib/plan.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

const line = z.string().trim().min(1).max(300);
const paragraph = z.string().trim().min(1).max(1200);

type Tracker = CommentOutcome | { status: "skipped"; reason: "eval" | "dry_run" | "not_triaged"; issueKey: string };

type Recorded = {
  recorded: boolean;
  reason: "commented" | "already_commented" | "eval" | "dry_run" | "not_triaged" | CommentOutcome["status"];
  issueKey: string;
  repo: string;
  ref: string;
  tracker: Tracker;
  hint?: string;
};

export default defineTool({
  description:
    "Record that the sandbox does not contain the claimed failure. Writes a Needs info: comment on the ticket, which the desk posts into the ticket's Slack thread, and does not move it to Planned, does not store a plan, and does not produce an implementation brief. Call it instead of record_plan when search_sandbox finds no matching path or available is false.",
  inputSchema: z.object({
    issueKey: issueKeySchema,
    claimed: paragraph.describe("What the ticket says is broken or missing, in one paragraph."),
    mismatch: paragraph.describe("What the sandbox search showed instead: no path, empty tree, or the files that do exist."),
    searched: z.array(line).min(1).max(8).describe("Queries or paths you searched."),
  }),
  effect: "write",
  dryRunResult: (input) =>
    result(input.issueKey, { recorded: false, reason: "dry_run" }, { status: "skipped", reason: "dry_run", issueKey: input.issueKey }),
  async execute(raw, ctx) {
    bindOpsFunnel(ctx.host);
    const pinned = pinnedIssueKey(ctx.session.continuationKey);
    const issueKey = pinned ?? raw.issueKey;
    if (ctx.session.purpose === "eval") {
      return result(issueKey, { recorded: false, reason: "eval" }, { status: "skipped", reason: "eval", issueKey });
    }
    // One Needs info per planning run. A later run (a replan) writes its own,
    // so the thread hears that run's verdict too.
    const earlier = await readOutcome(ctx.host.kv, ctx.session.id);
    if (earlier?.tool === "record_needs_info" && (earlier.tracker === "commented" || earlier.tracker === "already_commented")) {
      return result(issueKey, { recorded: false, reason: "already_commented" }, { status: "already_commented", issueKey });
    }
    // Like record_plan: a pinned run that finds the ticket out of Triaged
    // (another run planned it, or it moved on) writes nothing.
    if (pinned !== undefined) {
      const triaged = statusNames(process.env).triaged;
      const current = await issueStatus(ctx.host.mcp, issueKey);
      if (current !== undefined && current.trim().toLowerCase() !== triaged.trim().toLowerCase()) {
        await rememberOutcome(ctx.host.kv, ctx.session.id, { tool: "record_needs_info", reason: "not_triaged", tracker: "skipped" });
        return {
          ...result(issueKey, { recorded: false, reason: "not_triaged" }, { status: "skipped", reason: "not_triaged", issueKey }),
          hint: `${issueKey} is ${current}, not ${triaged}: another plan already landed or the ticket moved on. Nothing was written. Reply that no verdict was recorded.`,
        };
      }
    }
    const body = needsInfoComment({
      issueKey,
      repo: sandboxRepo(process.env),
      ref: sandboxRef(process.env),
      claimed: raw.claimed,
      mismatch: raw.mismatch,
      searched: raw.searched,
      at: new Date(),
    });
    const tracker = await commentOnTicket(ctx.host.mcp, { issueKey, body }, process.env);
    await rememberOutcome(ctx.host.kv, ctx.session.id, {
      tool: "record_needs_info",
      reason: tracker.status,
      tracker: tracker.status,
      ...("message" in tracker ? { message: tracker.message } : {}),
    });
    return result(issueKey, { recorded: tracker.status === "commented", reason: tracker.status }, tracker);
  },
});

function result(issueKey: string, outcome: { recorded: boolean; reason: Recorded["reason"] }, tracker: Tracker): Recorded {
  return {
    recorded: outcome.recorded,
    reason: outcome.reason,
    issueKey,
    repo: sandboxRepo(process.env),
    ref: sandboxRef(process.env),
    tracker,
  };
}

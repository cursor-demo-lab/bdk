import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { takeInbound, takeJevStash } from "../lib/inbound.js";
import { projectIssueTypes, projectOf } from "../lib/issue-type.js";
import { DEFAULT_ISSUE_TYPES, calibrateJudgment, calibrateSeverity, guardJudgmentType, holdJudgmentType, issueText, judgeTriage } from "../lib/jev-triage.js";
import { pinIssueIdentifier } from "../lib/parse-queue-event.js";
import { recordVerdict } from "../lib/record-verdict.js";
import { STAGING_REFUSED, stagingRefusalFor } from "../lib/staging-issue.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

export default defineTool({
  description:
    "Record the verdict for the current tracker issue and enrich it in place with a comment, priority, or duplicate link. Call exactly once per issue. Never create a ticket.",
  inputSchema: z.object({
    identifier: z
      .string()
      .describe("Identifier of the existing tracker issue."),
    kind: z.enum(["bug", "question", "feedback"]),
    severity: z.enum(["low", "medium", "high", "urgent"]),
    title: z
      .string()
      .max(80)
      .describe("Short title for the issue."),
    summary: z
      .string()
      .describe("What the issue says, in two sentences or less."),
    nextStep: z.string().describe("The single next action for the team."),
    reporter: z.string().optional().describe("Who reported it, when known."),
    duplicateOf: z
      .string()
      .optional()
      .describe("Identifier of a matching existing issue."),
    needsInfo: z
      .boolean()
      .optional()
      .describe("Whether the issue needs more information."),
  }),
  // The comment, the transition, and the planner call are writes, so a dry-run session gets
  // the same skipped shape an eval session gets, and the host never runs
  // execute. The structural test in writes.test.ts holds every write to this.
  effect: "write",
  dryRunResult: (verdict) => ({
    verdict: { ...verdict },
    evaluatedAt: new Date().toISOString(),
    tracker: { status: "skipped", reason: "dry_run" },
  }),
  async execute(input, ctx) {
    bindOpsFunnel(ctx.host);
    // The host judge owns the Jira issue type and severity when it is
    // confident; the model's title, summary, and next step stay as written.
    // Jev already answered on the wake (jev-first.ts); those answers are
    // reused here, never asked again.
    const identifier = pinIssueIdentifier(ctx.session.continuationKey, input.identifier);
    // A staging slug refuses a production key before reading anything, whether
    // it came from the session or the model's input (staging-issue.ts).
    if (stagingRefusalFor(identifier) !== undefined || stagingRefusalFor(input.identifier) !== undefined) {
      return { verdict: { ...input, identifier }, evaluatedAt: new Date().toISOString(), tracker: { status: "skipped", reason: STAGING_REFUSED } };
    }
    const live = ctx.session.purpose !== "eval";
    const inbound = live ? await takeInbound(ctx.host.kv, identifier) : undefined;
    const { asked, typeHeld } = live ? await takeJevStash(ctx.host.kv, identifier) : { asked: undefined, typeHeld: false };
    const listed = live ? await projectIssueTypes(ctx.host.mcp, ctx.host.kv, projectOf(identifier)) : undefined;
    const types = listed === undefined ? { source: "default" as const, types: DEFAULT_ISSUE_TYPES } : { source: "project" as const, types: listed };
    // The reporter's words when the webhook kept them, else the model's own restatement.
    const text = inbound === undefined ? issueText({ title: input.title, description: input.summary }) : issueText(inbound);
    const verdict = { ...input, severity: calibrateSeverity({ text, type: input.kind, severity: input.severity }) };
    const guarded = guardJudgmentType(await judgeTriage({ verdict, inbound, types, env: process.env, ...(asked === undefined ? {} : { asked }) }), text);
    // The wake's guard read the delivered text; it still holds when the inbound stash was lost. Held before
    // calibrating, so a held type never caps the severity.
    const judged = calibrateJudgment(typeHeld ? holdJudgmentType(guarded) : guarded, text);
    return recordVerdict({
      verdict,
      judged,
      ...(inbound?.issueType === undefined ? {} : { currentType: inbound.issueType }),
      mcp: ctx.host.mcp,
      kv: ctx.host.kv,
      ...(ctx.session.purpose === undefined ? {} : { purpose: ctx.session.purpose }),
      continuationKey: ctx.session.continuationKey,
      sessionId: ctx.session.id,
    });
  },
});

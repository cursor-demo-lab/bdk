import { randomUUID } from "node:crypto";
import { z } from "zod";
import { issueKeySchema } from "./plan.js";

// The ticket → triage → plan chain, planner side. triage-jira's record_triage
// calls `plan_issue` over the peer edge with the triage verdict, inline at the
// end of its own execute; the tool decides
// whether the verdict is worth a plan and, if so, opens a planning session
// on the `plan` channel keyed to the issue. `record_plan` later pins the
// plan to that key, so a chained plan can never land on another ticket.

export const CONTINUATION_PREFIX = "issue:";

export const attemptSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/)
  .describe("Identifies this planning attempt. The same attempt reuses its session; omit it for a fresh one.");

/** The attempt a caller named, or a fresh one. */
export function attemptOf(request: { attempt?: string | undefined }): string {
  return request.attempt ?? randomUUID();
}

/** A webhook's changelog or comment id as the attempt when it fits `attemptSchema`, else a fresh one. */
export function attemptFromEventId(id: string): string {
  return attemptSchema.safeParse(id).success ? id : randomUUID();
}

export const verdictSchema = z
  .object({
    kind: z.enum(["bug", "question", "feedback"]),
    severity: z.enum(["low", "medium", "high", "urgent"]),
    needsInfo: z.boolean().optional(),
    duplicateOf: z.string().optional(),
    nextStep: z.string().optional(),
  })
  .describe("The triage verdict as record_triage returned it.");

export const planRequestSchema = z.object({
  issueKey: issueKeySchema,
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2000).optional().describe("The ticket in two sentences, from triage or the request."),
  verdict: verdictSchema.optional(),
  answer: z.string().trim().min(1).max(4000).optional().describe("What a person replied in the ticket's Slack thread after the last Needs info."),
  attempt: attemptSchema.optional(),
});

export type PlanRequest = z.infer<typeof planRequestSchema>;

export type ChainDecision =
  | { plan: true }
  | { plan: false; reason: "question" | "needs_info" | "duplicate" };

/** Which triage verdicts get a plan. No verdict at all (a manual request) does. */
export function decide(verdict: PlanRequest["verdict"]): ChainDecision {
  if (verdict === undefined) return { plan: true };
  if (verdict.duplicateOf !== undefined && verdict.duplicateOf.trim() !== "") return { plan: false, reason: "duplicate" };
  if (verdict.needsInfo === true) return { plan: false, reason: "needs_info" };
  if (verdict.kind === "question") return { plan: false, reason: "question" };
  return { plan: true };
}

const ATTEMPT_SEPARATOR = "#";

/**
 * One continuation per planning attempt, `issue:<KEY>#<attempt>`. Hosted v2
 * binds a continuation to the first session that used it and refuses it from
 * any later event session, so a shared `issue:<KEY>` can plan a ticket once.
 */
export function continuationFor(input: { issueKey: string; attempt: string }): string {
  return `${CONTINUATION_PREFIX}${input.issueKey}${ATTEMPT_SEPARATOR}${input.attempt}`;
}

/** The issue key a session is pinned to, or `undefined` for an unpinned (peer `ask`) session. */
export function pinnedIssueKey(continuationKey: string | null | undefined): string | undefined {
  if (typeof continuationKey !== "string") return undefined;
  // Hosted v2 stores continuation keys as `cont:<key>`; local serve and evals use the bare key.
  const bare = continuationKey.startsWith("cont:") ? continuationKey.slice("cont:".length) : continuationKey;
  if (!bare.startsWith(CONTINUATION_PREFIX)) return undefined;
  const pinned = bare.slice(CONTINUATION_PREFIX.length);
  const cut = pinned.indexOf(ATTEMPT_SEPARATOR);
  const key = cut === -1 ? pinned : pinned.slice(0, cut);
  return issueKeySchema.safeParse(key).success ? key : undefined;
}

/**
 * The first user message of a chained planning session. A replan says so,
 * because the instructions answer a recorded plan with that plan otherwise.
 */
export function planPrompt(request: PlanRequest, opts: { replan?: boolean } = {}): string {
  const lines = [`Plan ${request.issueKey}: ${request.title}`];
  if (opts.replan === true) lines.push("", "replan: the ticket was sent back for a new plan. Replace the recorded plan.");
  if (request.summary !== undefined && request.summary !== "") lines.push("", request.summary);
  if (request.verdict !== undefined) {
    lines.push(
      "",
      `Triage: ${request.verdict.kind}, severity ${request.verdict.severity}.${
        request.verdict.nextStep === undefined ? "" : ` Next step from triage: ${request.verdict.nextStep}`
      }`
    );
  }
  if (request.answer !== undefined && request.answer !== "") {
    lines.push(
      "",
      "A person answered the last Needs info in the ticket's Slack thread (the newest Detail from Slack: comment). Their reply is part of the request:",
      ...request.answer.split("\n").map((line) => `> ${line}`),
      "If it asks to add something the sandbox does not have yet, plan that addition. Record Needs info again only if the reply still leaves nothing to plan."
    );
  }
  lines.push("", "This session is pinned to the ticket above. Read it with read_ticket, then plan.", "", CONSTRAINT_RULE);
  return lines.join("\n");
}

/** TLSSN-42's reporter said "Keep the 60 limit" and the plan raised it to 280. */
export const CONSTRAINT_RULE =
  "Constraints: the reporter's request (quoted verbatim in the description when filed from Slack) is binding. Every explicit constraint in it (keep or don't change X, a limit, exact copy, a placeholder, \"no other changes\") must hold in the approach and steps; list each in why.preserve (merge related ones into one line past 10). A later reporter reply that explicitly changes a constraint replaces it. Never propose changing what they said to keep. If a constraint makes the request impossible or unsafe, plan within it and say so in risk and openQuestions; never override it.";

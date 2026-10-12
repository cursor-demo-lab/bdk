import { randomUUID } from "node:crypto";
import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { releaseLease, takeLease } from "../lib/claim-lease.js";
import { ackCommand } from "../lib/command-ack.js";
import { claimSettleMs, statusNames } from "../lib/config.js";
import { armHopWatch } from "../lib/hop-watch.js";
import { dropIntakeTriage, filingCredit, intakeSourceText, intakeSourceTs, planFiling, readIntakeTriage, reporterRequest, settleFiling, withReporterRequest, type FilingPlan } from "../lib/intake-triage.js";
import { addComment, createIssue, issueTypeFor, transitionFrom, type CreateOutcome, type GuardedTransition } from "../lib/jira.js";
import { updateVerifiedDesk } from "../lib/kv-verified-desk.js";
import { resolveCommand } from "../lib/originator.js";
import { threadPermalink, withSlackThread } from "../lib/slack-link.js";
import { setStatusReaction } from "../lib/status-reaction.js";
import { filingHoldKey, recordThreadTicket } from "../lib/thread-tickets.js";
import { markFiledTriage } from "../lib/announce.js";
import { filedMessage, threadFromSession, ticketKey, type ThreadRef } from "../lib/threads.js";
import { withDeskTriaged } from "../lib/desk-triaged.js";
import type { TriageVerdict } from "../lib/triage-verdict.js";
import type { KeyedKv, KvKey } from "../lib/kv-keys.js";
import { bindOpsFunnel, warnKv } from "../lib/ops-funnel.js";
import { tagSessionTicket } from "../lib/factory-otel.js";

// The way in from Slack. A person says "file a bug: …" then
// `approve file` in the same thread (a plain reply on the intake channel
// watch, or with the mention anywhere else). Hosted v2 has no
// Slack card ingress, so this tool does not park. The thread and the
// person who said `approve file` are
// bound to the new key in host.kv, so the lifecycle announcements come back
// here and only that person can approve from Slack. With no fresh record of who said
// it, no originator is bound and the ticket is approved in Jira only; the
// session's user_id is the thread opener, not the speaker.
//
// The ticket is filed already triaged. Jev judged the request before the
// filing prompt (intake-triage.ts): when it was confident, its type,
// severity, and summary are filed and the model's fields are only a copy;
// otherwise the model's own triage is filed, with a type Jev was confident
// about. This tool writes the Triage: comment triage-jira would have written
// and moves the ticket To Do → Triaged, the move the planner wakes on and the
// desk announces once; the description's last line tells triage-jira to leave
// it alone. That person's `approve file` message gets a ✅ once the issue
// exists (command-ack.ts).
export default defineTool({
  description:
    "Create one Jira issue in the factory's project from a person's request in this thread, after they say approve file, filed with the triage from the filing prompt. Use only on that approve. Never on the first filing request, and never to comment on, read, or change a ticket.",
  inputSchema: z.object({
    title: z.string().trim().min(1).max(80).describe("The title from your filing prompt's first line: a short title in your own words, under 80 characters, saying what is broken or wanted and where. Never the reporter's sentence or question copied."),
    description: z.string().trim().min(1).max(4000).describe("What the person wrote, plus who asked, in plain prose. Keep every constraint they stated (what to keep, limits, exact copy). Do not invent detail. Host code quotes their original message after it."),
    kind: z.enum(["bug", "feedback", "question"]).describe("The triage kind from the filing prompt: bug for a defect, feedback for a request or a change, question for something to look up."),
    severity: z.enum(["low", "medium", "high", "urgent"]).describe("The severity from the filing prompt."),
    summary: z.string().trim().min(1).max(400).describe("The one-sentence triage summary from the filing prompt."),
    nextStep: z.string().trim().max(400).optional().describe("Optional: the next step for the team, one sentence."),
    needsInfo: z.boolean().optional().describe("True when the request is too thin to plan without more detail from the reporter."),
  }),
  effect: "write",
  dryRunResult: (input) => ({ created: false, reason: "dry_run", title: input.title }),
  async execute(input, ctx) {
    bindOpsFunnel(ctx.host);
    const thread = threadFromSession(ctx.session);
    const intake = thread === undefined ? undefined : await readIntakeTriage(ctx.host.kv, thread, ctx.now());
    const request = thread === undefined ? undefined : await intakeSourceTs(ctx.host.kv, thread);
    const requestText = thread === undefined ? undefined : await intakeSourceText(ctx.host.kv, thread, ctx.now());
    const plan = planFiling(intake, {
      title: input.title,
      kind: input.kind,
      severity: input.severity,
      summary: input.summary,
      ...(input.nextStep === undefined ? {} : { nextStep: input.nextStep }),
      ...(input.needsInfo === undefined ? {} : { needsInfo: input.needsInfo }),
    }, {
      text: requestText === undefined ? input.description : reporterRequest(requestText),
      ...(requestText === undefined ? {} : { request: requestText }),
    });
    if (ctx.session.purpose === "eval") {
      // Shaped like a live create so evals can gate the browse URL in the reply.
      // Nothing is written to Jira.
      tagSessionTicket(ctx.host, "EVALX-1");
      return {
        created: true,
        reason: "created",
        issueKey: "EVALX-1",
        project: "EVALX",
        url: "https://example.atlassian.net/browse/EVALX-1",
        link: "[EVALX-1](https://example.atlassian.net/browse/EVALX-1)",
        reply: filedMessage({
          issueKey: "EVALX-1",
          url: "https://example.atlassian.net/browse/EVALX-1",
          issueType: plan.createType?.name ?? issueTypeFor(plan.verdict.kind),
          severity: plan.verdict.severity,
          ...(plan.summaryFromTemplate === true ? {} : { summary: plan.verdict.summary }),
          credit: filingCredit(plan),
          triaged: true,
          kind: plan.verdict.kind,
          nextStep: plan.verdict.nextStep,
          ...(plan.verdict.needsInfo === true ? { needsInfo: true } : {}),
        }),
        threadBound: false,
        triage: triageSummary(plan, plan.createType?.name ?? issueTypeFor(plan.verdict.kind), "eval"),
      };
    }
    const hold = thread === undefined ? undefined : await holdFiling(ctx.host.kv, thread, ctx.now());
    if (hold === "duplicate") {
      return { created: false, reason: "already_filing", title: input.title, detail: "This thread's request is already being filed; its Filed line follows here." };
    }
    let permalink: string | undefined;
    try {
      permalink = await threadPermalink(await ctx.host.slack.getClient(), thread);
    } catch {
      permalink = undefined;
    }
    const description = withDeskTriaged(withSlackThread(withReporterRequest(input.description, requestText), permalink));
    const created = await createTriaged(ctx.host.mcp, plan, { title: input.title, description });
    const { outcome, write } = created;
    if (outcome.status !== "created") {
      if (hold !== undefined) await releaseLease(ctx.host.kv, hold.key, hold.owner);
      return { created: false, reason: outcome.status, title: input.title, project: outcome.project, ...(outcome.status === "failed" ? { message: outcome.message } : {}) };
    }
    // The issue exists from here on: the filing turn's usage is its ticket's
    // from this moment (hooks/ticket-key.ts; never throws). A binding that
    // cannot be written is reported, not thrown, or a retry of the card files
    // the ticket twice.
    tagSessionTicket(ctx.host, outcome.issueKey);
    let threadBindingError: string | undefined;
    let originatorUserId: string | undefined;
    let commandTs: string | undefined;
    if (thread !== undefined) {
      try {
        const caller = await resolveCommand(ctx.host.kv, thread, [{ verb: "approve", target: "file" }], ctx.now());
        originatorUserId = caller?.userId;
        commandTs = caller?.reaction === true ? undefined : caller?.ts;
        const binding = {
          channelId: thread.channelId,
          ...(thread.threadTs === undefined ? {} : { threadTs: thread.threadTs }),
          ...(originatorUserId === undefined ? {} : { originatorUserId }),
          filedAt: ctx.now().toISOString(),
        };
        // kv-decide-blind: createIssue minted this key just above; the only other writer is an intake-root placeholder, which is meant to lose to the filing.
        const written = await updateVerifiedDesk(ctx.host.kv, ticketKey(outcome.issueKey), () => binding);
        if (written.status !== "written") threadBindingError = "the thread binding could not be written and verified";
        else await recordThreadTicket(ctx.host.kv, thread, outcome.issueKey);
      } catch (error) {
        warnKv("file_ticket.execute", error);
        threadBindingError = error instanceof Error ? error.message : String(error);
      }
      if (threadBindingError === undefined) {
        try {
          await setStatusReaction({ kv: ctx.host.kv, client: await ctx.host.slack.getClient(), issueKey: outcome.issueKey, ticket: thread, stage: "received" });
        } catch {
          // The 👀 is only a progress mark; the filed reply follows either way.
        }
      }
    }
    // After the binding, so the Triaged entry this move sets off finds the thread.
    const recorded = await recordTriage(ctx.host.mcp, plan, outcome.issueKey, write, (comment) =>
      markFiledTriage(ctx.host.kv, { issueKey: outcome.issueKey, comment, at: ctx.now(), ...(thread === undefined ? {} : { channel: thread.channelId }) })
    );
    if (thread !== undefined) {
      if (threadBindingError === undefined && !recorded.triaged) {
        try {
          // Not in Triaged, so no Triaged announce and no plan hop: watch the triage hop, whose stuck line offers `retry KEY`.
          await armHopWatch(ctx.host, { issueKey: outcome.issueKey, hop: "triage", changelogId: "filed", at: ctx.now(), baselineCommentId: "0" });
        } catch (error) {
          console.error(`[factory-desk] hop-watch for ${outcome.issueKey} (triage) failed:`, error);
        }
      }
      await dropIntakeTriage(ctx.host.kv, thread, request, ctx.now());
      if (commandTs !== undefined) {
        await ackCommand({ getClient: () => ctx.host.slack.getClient(), target: { channel: thread.channelId, ts: commandTs }, command: "approve file", issueKey: outcome.issueKey });
      }
    }
    return {
      created: true,
      reason: "created",
      issueKey: outcome.issueKey,
      project: outcome.project,
      reply: filedMessage({
        issueKey: outcome.issueKey,
        ...(outcome.url === undefined ? {} : { url: outcome.url }),
        issueType: recorded.issueType,
        severity: recorded.verdict.severity,
        ...(plan.summaryFromTemplate === true ? {} : { summary: recorded.verdict.summary }),
        credit: filingCredit(plan),
        triaged: recorded.triaged,
        kind: recorded.verdict.kind,
        nextStep: recorded.verdict.nextStep,
        ...(recorded.verdict.needsInfo === true ? { needsInfo: true } : {}),
      }),
      ...(outcome.url === undefined ? {} : { url: outcome.url, link: `[${outcome.issueKey}](${outcome.url})` }),
      ...(permalink === undefined ? {} : { slackThread: permalink }),
      threadBound: thread !== undefined && threadBindingError === undefined,
      ...(threadBindingError === undefined && originatorUserId !== undefined ? { originatorUserId } : {}),
      ...(threadBindingError === undefined ? {} : { threadBindingError }),
      triage: triageSummary(plan, recorded.issueType, recorded.status),
    };
  },
});

// Longer than one filing takes; a thread (a DM) can file its next request after it.
const FILING_HOLD_MS = 120_000;

/**
 * The thread's filing hold, taken with a settle re-read before the issue is
 * created and left pending once it is, so a ✅ on the filing prompt and a
 * typed `approve file` (or a retried turn) inside FILING_HOLD_MS create one
 * issue. A hold that cannot be taken is released and the filing goes ahead.
 */
async function holdFiling(kv: KeyedKv, thread: ThreadRef, now: Date): Promise<{ key: KvKey; owner: string } | "duplicate" | undefined> {
  const key = filingHoldKey(thread);
  const owner = randomUUID();
  const taken = await takeLease(kv, key, { owner, leaseMs: FILING_HOLD_MS, now, settleMs: claimSettleMs() });
  if (taken.status === "held" || taken.status === "done") return "duplicate";
  if (taken.status === "taken") return { key, owner };
  await releaseLease(kv, key, owner);
  return undefined;
}

type TypeWrite = { status: "set" } | { status: "failed"; message: string } | { status: "not_written" };

/**
 * Creates the issue with Jev's type when Jev chose one. A project that
 * refuses that type gets the kind's own type instead (Bug, else Task), so a
 * wrong type never stops the filing; the Judge: line then says the Jira edit failed.
 */
async function createTriaged(mcp: Parameters<typeof createIssue>[0], plan: FilingPlan, input: { title: string; description: string }): Promise<{ outcome: CreateOutcome; write: TypeWrite }> {
  const kind = plan.verdict.kind;
  const outcome = await createIssue(mcp, { ...input, kind, ...(plan.createType === undefined ? {} : { issueType: plan.createType }) }, process.env);
  if (plan.createType === undefined) return { outcome, write: { status: "not_written" } };
  if (outcome.status === "created") return { outcome, write: { status: "set" } };
  if (outcome.status !== "failed" || outcome.project === "" || plan.createType.name === issueTypeFor(kind)) return { outcome, write: { status: "not_written" } };
  const retried = await createIssue(mcp, { ...input, kind }, process.env);
  return { outcome: retried, write: { status: "failed", message: outcome.message } };
}

type Recorded = { status: "triaged" | GuardedTransition["status"] | "comment_failed" | "not_connected"; triaged: boolean; issueType: string; verdict: TriageVerdict; message?: string };

/**
 * The Triage: comment, then To Do → Triaged. The move is tried only once the
 * verdict is on the ticket, so the planner and the desk read it, and only
 * after `beforeMove` marked that verdict as heard in this thread, so the
 * Triaged entry does not post it again.
 */
async function recordTriage(mcp: Parameters<typeof createIssue>[0], plan: FilingPlan, issueKey: string, write: TypeWrite, beforeMove: (comment: string) => Promise<void>): Promise<Recorded> {
  const settled = settleFiling(plan, issueKey, write);
  const base = { issueType: settled.issueType, verdict: settled.verdict };
  const commented = await addComment(mcp, { issueKey, body: settled.comment });
  if (commented.status === "not_connected") return { status: "not_connected", triaged: false, ...base };
  if (commented.status !== "commented") {
    console.error(`[factory-desk] ${issueKey} was filed but its Triage: comment failed: ${commented.message}`);
    return { status: "comment_failed", triaged: false, ...base, message: commented.message };
  }
  await beforeMove(settled.comment);
  const statuses = statusNames(process.env);
  const moved = await transitionFrom(mcp, { issueKey, from: statuses.todo, toStatus: statuses.triaged });
  const triaged = moved.status === "transitioned" || moved.status === "already";
  if (!triaged) console.error(`[factory-desk] ${issueKey} has its Triage: comment but did not move to ${statuses.triaged}: ${JSON.stringify(moved)}`);
  return { status: triaged ? "triaged" : moved.status, triaged, ...base, ...("message" in moved ? { message: moved.message } : {}) };
}

function triageSummary(plan: FilingPlan, issueType: string, status: Recorded["status"] | "eval") {
  return {
    by: plan.by,
    issueType,
    kind: plan.verdict.kind,
    severity: plan.verdict.severity,
    summary: plan.verdict.summary,
    ...(plan.verdict.needsInfo === true ? { needsInfo: true } : {}),
    ...(plan.reason === undefined ? {} : { fallback: plan.reason }),
    status,
  };
}

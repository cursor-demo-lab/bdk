import type { HostMcpRegistry } from "@cursor/july";
import { claimSettleMs, statusNames } from "./config.js";
import { bareReplyReaches, replyPrefix } from "./desk-channels.js";
import { ensureIntakeBacklink, type BacklinkOutcome } from "./intake-backlink.js";
import { filedFromSlack, issueStatus, readCommentRecords, readComments } from "./jira.js";
import { latestPlanComment, parsePlanComment, type PlanDigest } from "./plan-comment.js";
import { OUTCOMES, outcomeComment, outcomeLeaves, parseOutcome, type Outcome, type OutcomeKind } from "./outcomes.js";
import { jiraSiteUrl, planCommentUrl, planPost, ticketUrl } from "./plan-post.js";
import { recordPlanPost } from "./reaction-targets.js";
import { clearPlanDeclined } from "./plan-decline.js";
import { approvedInSlack, pullRequestRetryActive, retryBounceActive } from "./slack-approval.js";
import { setStatusReaction, type ReactionOutcome, type StatusStage } from "./status-reaction.js";
import { clearLoader, ensureLoader, loaderKey, parseLoader, postLoader, readReviewGates, writeReviewGates } from "./loader.js";
import { sentToPlannerRecently } from "./plan-move.js";
import { latestImplementingComment, latestMergedByComment, latestPullRequestComment } from "./status-event.js";
import { clearAwaitingFor, markAwaiting } from "./thread-detail.js";
import type { TriageVerdict } from "./triage-comment.js";
import {
  announcedKey,
  approvedMessage,
  approvedWithoutPlanMessage,
  doneMessage,
  inReviewMessage,
  launchFailedMessage,
  movedBackMessage,
  moveSkippedMessage,
  needsInfoMessage,
  pastPlanned,
  planStoppedMessage,
  progressMessage,
  triagedMessage,
  triageStoppedMessage,
  type OutcomeMessageInput,
  type TicketThread,
} from "./threads.js";
import { latestTriageVerdict } from "./triage-comment.js";
import { type KvKey, planAnnounceKey, triagedAnnounceKey, triagedEntryKey } from "./kv-keys.js";
import { announceTicketUpdate, ticketPost, type AnnounceContext } from "./ticket-thread.js";
import { warnKv } from "./ops-funnel.js";

export { planAnnounceKey, triagedAnnounceKey, triagedEntryKey };

// The lifecycle announcements. Only the Jira channel calls these, with its
// own host, after it has verified the webhook signature: they are not tools,
// so no model turn can see or call them, and every input comes from the
// signed Jira event. Links are built from JIRA_CLOUD_ID, never from input.

export type AnnounceHost = AnnounceContext & { host: AnnounceContext["host"] & { mcp: HostMcpRegistry } };

type AnnounceInput = Parameters<typeof announceTicketUpdate>[1];

/**
 * Every lifecycle announcement goes through here. A ticket with no thread
 * gets an intake root on its first announcement (Triaged for a ticket filed
 * in Jira), unless its description carries file_ticket's `Slack thread:`
 * line: that ticket was filed from Slack and lost its binding, and a second
 * thread in the intake channel would split its updates, so it stays quiet
 * and logs why. An announcement that lands under an intake root leaves the
 * root's permalink on the ticket once (intake-backlink.ts).
 */
async function announceInThread(ctx: AnnounceHost, input: AnnounceInput) {
  const issueKey = input.update.issueKey;
  const { target } = await ticketPost(ctx.host.kv, issueKey);
  if (target?.root === true && (input.update.threadOnly !== true || input.update.opensRoot === true)) {
    const filing = await filedFromSlack(ctx.host.mcp, issueKey);
    if (filing.status === "slack") {
      console.error(JSON.stringify({ desk: "intake_root", issueKey, outcome: "skipped", why: "filed_in_slack_unbound" }));
      return { posted: false as const, reason: "filed_in_slack_unbound", issueKey };
    }
  }
  const result = await announceTicketUpdate(ctx, input);
  if (!result.posted) return result;
  let backlink: BacklinkOutcome;
  try {
    backlink = await ensureIntakeBacklink({ kv: ctx.host.kv, mcp: ctx.host.mcp, client: await ctx.host.slack.getClient(), issueKey, now: ctx.now() });
  } catch {
    backlink = "failed";
  }
  if (backlink === "not_intake_root" || backlink === "present") return result;
  if (backlink !== "written") console.error(JSON.stringify({ desk: "intake_backlink", issueKey, outcome: backlink }));
  return { ...result, backlink };
}

type PlanRead = { digest?: PlanDigest; commentId?: string; plan: "digest" | "legacy" | "no_plan_comment" | "not_connected" | "failed" };

/**
 * A ticket entering Planned: the full plan as a reply in the ticket's
 * thread, the one that filed it or, for a ticket filed in Jira, a thread
 * opened by a short root in FACTORY_DESK_INTAKE_CHANNEL.
 *
 * The claim is per plan, not per transition and not per ticket: it names
 * the `Plan:` comment the post carries (`planAnnounceKey`). A redelivery, a
 * Planned → Planned bounce, or a late planner session that wrote nothing
 * finds the same comment and posts nothing; a replan writes a new `Plan:`
 * comment, so its Planned move posts the new plan, as the plan post's own
 * `replan KEY` line and the Triaged line promise. The comment is read
 * before the claim so its id can name the claim; a comment that cannot be
 * read falls back to the per-ticket key, which posts once and never again.
 */
export async function announcePlan(input: { issueKey: string; title: string; changelogId: string; tracker: string }, ctx: AnnounceHost) {
  const skip = await skipPlanAnnounce(ctx, input.issueKey);
  if (skip !== undefined) return skip;
  const planned = statusNames(process.env).planned;
  const read = await readPlan(ctx.host.mcp, input.issueKey);
  const result = await announceInThread(ctx, {
    changelogId: input.changelogId,
    claimKey: planAnnounceKey({ issueKey: input.issueKey, status: planned, ...(read.commentId === undefined ? {} : { commentId: read.commentId }) }),
    update: { issueKey: input.issueKey, title: input.title, status: planned, text: "" },
    record: { title: input.title, ...(read.commentId === undefined ? {} : { planCommentId: read.commentId }) },
    reaction: "planned",
    prepare: async () => {
      const link = ticketUrl({ issueKey: input.issueKey, site: jiraSiteUrl(process.env) });
      const render = (bound: TicketThread | undefined) =>
        planPost({
          issueKey: input.issueKey,
          title: input.title,
          tracker: input.tracker,
          ...(read.digest === undefined ? {} : { digest: read.digest }),
          ...(link === undefined ? {} : { ticketUrl: link }),
          ...(link === undefined ? {} : { planUrl: planCommentUrl({ ticketUrl: link, commentId: read.commentId }) }),
          ...(bound?.originatorUserId === undefined ? {} : { originatorUserId: bound.originatorUserId }),
          ...(bound !== undefined && bound.originatorUserId === undefined && bound.root !== "jira" ? { filedInSlack: true } : {}),
          ...(bound !== undefined && !bareReplyReaches(bound.channelId) ? { bareReply: false } : {}),
        });
      return { update: { render }, result: { plan: read.plan } };
    },
    posted: (post) => recordPlanPost(ctx.host.kv, { ...post, issueKey: input.issueKey, at: ctx.now() }),
  });
  if (result.posted) {
    await dropLoader(ctx, input.issueKey);
    await clearPlanDeclined(ctx.host, input.issueKey);
  }
  return result;
}

/**
 * A ticket entering Triaged. A ticket filed in Jira has no thread yet, so
 * this is where its intake root opens (the desk sees no issue_created), and
 * the Triaged line, the planner crumb, and the plan hop watch all land under it
 * as they do for a Slack filing. The verdict comes from the latest `Triage:`
 * comment, so the thread hears whether the planner will plan it or skip it.
 * No Triage: comment (a triage that never ran, or a hand move) plans
 * without a verdict.
 *
 * The claim is per verdict as triage wrote it (type, severity, Jev, gate),
 * not per changelog. A `plan KEY` bounce, a Needs-info clarification (whose
 * `Detail from Slack:` lifts the needs-info gate but is not a new verdict),
 * or a replan after a `Plan:` comment posts nothing (TLSSN-29, TLSSN-30);
 * a first Triaged line, or one whose type/severity/Jev/gate changed, still
 * posts. After a first announce the thread gets a one-shot planner crumb so
 * the wait is visible; a skipped bounce only posts that crumb when none is
 * showing.
 *
 * Deliveries that race on one verdict (a Jira retry, or a bounce landing
 * while the first entry is still announcing) share the claim, which settles
 * (claim-lease.ts `settleMs`) so only one of them posts. The claim records
 * the changelog id of the transition that won it.
 */
export async function announceTriaged(input: { issueKey: string; changelogId: string; title?: string }, ctx: AnnounceHost) {
  const { target } = await ticketPost(ctx.host.kv, input.issueKey);
  if (target === undefined) return { posted: false, reason: "no_thread", issueKey: input.issueKey };
  const settleMs = claimSettleMs();
  const entry = recordTriagedEntry(ctx.host.kv, { issueKey: input.issueKey, changelogId: input.changelogId, settleMs });
  try {
    return await announceTriagedLine(input, ctx, settleMs);
  } finally {
    await entry;
  }
}

async function announceTriagedLine(input: { issueKey: string; changelogId: string; title?: string }, ctx: AnnounceHost, settleMs: number) {
  const read = await readTriageComments(ctx.host.mcp, input.issueKey);
  const comments = read.status === "read" ? read.comments : [];
  const bodies = comments.map((comment) => comment.body);
  const verdict = latestTriageVerdict(bodies);
  const written = latestTriageVerdict(bodies, { asWritten: true });
  const replan = latestPlanComment(comments, input.issueKey) !== undefined;
  const triaged = statusNames(process.env).triaged;
  const claimKey = triagedAnnounceKey({ issueKey: input.issueKey, status: triaged, fingerprint: triagedVerdictFingerprint(written === undefined ? {} : { verdict: written }) });
  const filed = await takeFiledTriage(ctx.host.kv, claimKey, input.changelogId);
  if (filed) return quietFiledTriage(input, ctx, verdict);
  const result = await announceInThread(ctx, {
    changelogId: input.changelogId,
    claimKey,
    settleMs,
    update: { issueKey: input.issueKey, title: input.title ?? input.issueKey, status: triaged, text: "" },
    record: { changelogId: input.changelogId },
    prepare: async () => ({
      update: { text: triagedMessage({ issueKey: input.issueKey, ...(verdict === undefined ? {} : { verdict }), replan }) },
      result: { comments: read.status, verdict: verdict === undefined ? "none" : (verdict.gate ?? "plan") },
      reaction: verdict?.gate === undefined ? "planning" : "needs_person",
    }),
  });
  if (result.posted && "verdict" in result) {
    const ticket = await boundThread(ctx, input.issueKey);
    if (result.verdict === "needs_info" && ticket !== undefined) await markAwaiting(ctx.host.kv, ticket, { issueKey: input.issueKey, kind: "triage_needs_info", at: ctx.now().toISOString() });
    else await clearAwaitingFor(ctx.host.kv, input.issueKey);
  }
  const waiting = verdict?.gate === undefined;
  if (result.posted && waiting) await showLoader(ctx, input.issueKey, "planning");
  else if (result.posted) await dropLoader(ctx, input.issueKey);
  else if (result.reason === "already_announced" && waiting) {
    await clearAwaitingFor(ctx.host.kv, input.issueKey);
    await showLoader(ctx, input.issueKey, verdict?.gate !== written?.gate || replan ? "replanning" : "planning", { ensure: true });
  }
  return result;
}

/**
 * A desk-filed ticket's thread already heard its verdict and next step in the
 * one Filed post (threads.ts `filedMessage`), so file_ticket marks the
 * Triaged claim for the verdict it filed as done before its move to Triaged
 * (`markFiledTriage`). That move's Triaged entry posts no Triaged line, but
 * still does what the line would have: the stage reaction, the planner crumb
 * while the planner runs (TLSSN-37 had none after #155 dropped it here), and
 * the thread waits on the reporter's reply for a needs-info verdict. Later
 * entries (a bounce, a replan) go the usual way.
 */
export async function markFiledTriage(kv: AnnounceHost["host"]["kv"], input: { issueKey: string; comment: string; at: Date; channel?: string }): Promise<void> {
  const verdict = latestTriageVerdict([input.comment], { asWritten: true });
  const key = triagedAnnounceKey({ issueKey: input.issueKey, status: statusNames(process.env).triaged, fingerprint: triagedVerdictFingerprint(verdict === undefined ? {} : { verdict }) });
  try {
    await kv.put(key, { state: "done", filed: true, at: input.at.toISOString(), ...(input.channel === undefined ? {} : { channel: input.channel }) });
  } catch (error) {
    warnKv("announce.markFiledTriage", error);
    // Unmarked, the Triaged line posts as for a Jira-filed ticket.
  }
}

/** True once for the Triaged entry that follows a desk filing: the claim file_ticket marked, not yet heard. */
async function takeFiledTriage(kv: AnnounceHost["host"]["kv"], key: KvKey, changelogId: string): Promise<boolean> {
  let stored: unknown;
  try {
    stored = await kv.get(key);
  } catch (error) {
    warnKv("announce.takeFiledTriage.get", error);
    return false;
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return false;
  const record = stored as Record<string, unknown>;
  if (record["filed"] !== true) return false;
  if (typeof record["heard"] === "string") return record["heard"] === changelogId;
  try {
    await kv.put(key, { ...record, heard: changelogId } as never);
  } catch (error) {
    warnKv("announce.takeFiledTriage.put", error);
    // A redelivery of this entry is quiet again; a later entry takes the usual path.
  }
  return true;
}

async function quietFiledTriage(input: { issueKey: string; changelogId: string }, ctx: AnnounceHost, verdict: TriageVerdict | undefined) {
  const ticket = await boundThread(ctx, input.issueKey);
  if (verdict?.gate === "needs_info" && ticket !== undefined) await markAwaiting(ctx.host.kv, ticket, { issueKey: input.issueKey, kind: "triage_needs_info", at: ctx.now().toISOString() });
  else await clearAwaitingFor(ctx.host.kv, input.issueKey);
  let reaction: ReactionOutcome | "failed" = "failed";
  try {
    reaction = await setStatusReaction({ kv: ctx.host.kv, client: await ctx.host.slack.getClient(), issueKey: input.issueKey, ticket, stage: verdict?.gate === undefined ? "planning" : "needs_person", changelogId: input.changelogId });
  } catch {
    // The Filed post already said what comes next.
  }
  if (verdict?.gate === undefined) await showLoader(ctx, input.issueKey, "planning", { ensure: true });
  return { posted: false as const, reason: "filed_with_triage" as const, issueKey: input.issueKey, verdict: verdict === undefined ? "none" : (verdict.gate ?? "plan"), reaction };
}

/**
 * An agent left a comment saying why the ticket did not get what its thread
 * was told comes next (outcomes.ts): triage stopped before Triaged, the
 * planner found nothing or stopped, the worker's launch failed or found no
 * plan, or its pull request did not move the ticket. None of these moves the
 * ticket, so no status webhook fires; the desk's comment rule delivers the
 * comment, and the thread hears why and what to do next. Posted only into a
 * thread the ticket already has, like the Triaged line, and never touches an
 * intake root's status line. A ticket that has left the status the outcome
 * leaves it in gets nothing: the thread heard that move instead. The body is
 * read back from Jira; when that read fails the signed event's body stands
 * in, so the thread still hears it. Claimed once per comment, and a Needs
 * info once per Triaged entry; the claim settles, so concurrent deliveries
 * post once.
 */
export async function announceOutcome(
  input: { issueKey: string; title: string; kind: OutcomeKind; claimId: string; commentId?: string; body: string },
  ctx: AnnounceHost
) {
  const { issueKey, kind } = input;
  const { ticket, target } = await ticketPost(ctx.host.kv, issueKey);
  const statuses = statusNames(process.env);
  const leaves = outcomeLeaves(kind, statuses);
  // A stop that leaves the ticket in a status opens a Jira-filed ticket's
  // intake root, so an early failure is heard; a move-skipped note only
  // ever replies in a thread the ticket already has.
  if (target === undefined || (ticket === undefined && leaves === undefined)) return { posted: false, reason: "no_thread", issueKey };
  if (leaves !== undefined) {
    const live = await issueStatus(ctx.host.mcp, issueKey);
    if (live.status === "read" && live.name.trim().toLowerCase() !== leaves.trim().toLowerCase()) {
      return { posted: false, reason: "moved_on", issueKey, current: live.name };
    }
  }
  if (kind === "plan_stopped" && (await redundantSkip(ctx, { issueKey, body: input.body, statuses }))) {
    return { posted: false, reason: "gate_already_heard", issueKey };
  }
  // Two planner sessions started by Triaged entries before either finished
  // (TLSSN-30: the first entry, then a `plan KEY` bounce) each write Needs
  // info. The thread hears one per Triaged entry, so the second is quiet and
  // a clarification or `plan KEY` after it (a new entry) is heard again.
  const entry = kind === "needs_info" ? await triagedEntry(ctx.host.kv, issueKey) : undefined;
  const result = await announceInThread(ctx, {
    changelogId: `comment-${input.claimId}`,
    claimKey: announcedKey({ issueKey, status: OUTCOMES[kind].label, changelogId: entry === undefined ? input.claimId : `triaged-${entry}` }),
    settleMs: claimSettleMs(),
    update: { issueKey, title: input.title, status: leaves ?? OUTCOMES[kind].label, text: "", threadOnly: true, ...(leaves === undefined ? {} : { opensRoot: true as const }) },
    record: { kind },
    ...(OUTCOME_REACTION[kind] === undefined ? {} : { reaction: OUTCOME_REACTION[kind] }),
    prepare: async () => {
      let read: Awaited<ReturnType<typeof readCommentRecords>> | undefined;
      try {
        read = await readCommentRecords(ctx.host.mcp, issueKey);
      } catch {
        read = undefined;
      }
      const want = { kind, ...(input.commentId === undefined ? {} : { commentId: input.commentId }) };
      const found = read?.status === "read" ? outcomeComment(read.comments, issueKey, want, statuses) : undefined;
      const parsed = parseOutcome(found?.body ?? input.body, issueKey, statuses);
      const outcome = parsed?.kind === kind ? parsed : undefined;
      const link = outcomeLink({ issueKey, kind, commentId: found?.id ?? input.commentId });
      const render = (bound: TicketThread | undefined) => ({
        text: outcomeMessage(outcome, kind, {
          issueKey,
          prefix: replyPrefix(bound?.channelId),
          ...(bound?.originatorUserId === undefined ? {} : { originatorUserId: bound.originatorUserId }),
          ...(link === undefined ? {} : { link }),
        }),
      });
      return { update: { render }, result: { comments: read?.status ?? "failed", source: found === undefined ? "event" : "jira" } };
    },
  });
  if (result.posted && kind === "needs_info") {
    const bound = ticket ?? (await boundThread(ctx, issueKey));
    if (bound !== undefined) await markAwaiting(ctx.host.kv, bound, { issueKey, kind: "needs_info", at: ctx.now().toISOString() });
  }
  if (result.posted) await dropLoader(ctx, issueKey);
  return result;
}

/**
 * The planner writes `Plan stopped:` on every move into Triaged its verdict
 * gate skipped, because it cannot tell triage's own move from a bounce. The
 * thread needs it unless it already heard that gate: no planner crumb is up
 * (the Triaged line and the Filed post put one up only for a verdict the
 * planner plans, and say so for one it does not) and the desk has not sent
 * the ticket to the planner in the last PLANNER_SENT_MS (every `plan`,
 * `retry`, `request_plan`, and Needs-info send records it before the move).
 * A skip after any send is always relayed, so a `plan KEY` never ends on the
 * crumb (TLSSN-40). A run that stopped is always relayed.
 */
async function redundantSkip(ctx: AnnounceHost, input: { issueKey: string; body: string; statuses: ReturnType<typeof statusNames> }): Promise<boolean> {
  const { issueKey, body, statuses } = input;
  const parsed = parseOutcome(body, issueKey, statuses);
  if (parsed?.kind !== "plan_stopped" || parsed.skipped !== true) return false;
  let crumb: ReturnType<typeof parseLoader>;
  try {
    crumb = parseLoader(await ctx.host.kv.get(loaderKey(issueKey)));
  } catch (error) {
    warnKv("announce.redundantSkip", error);
    return false;
  }
  if (crumb?.phase === "planning" || crumb?.phase === "replanning") return false;
  return !(await sentToPlannerRecently(ctx.host.kv, issueKey, ctx.now()));
}

// A move-skipped note retries on its own and changes nothing a person does.
const OUTCOME_REACTION: Record<OutcomeKind, StatusStage | undefined> = {
  triage_stopped: "stopped",
  needs_info: "needs_person",
  plan_stopped: "stopped",
  launch_failed: "stopped",
  approved_without_plan: "stopped",
  move_skipped: undefined,
};

function outcomeMessage(outcome: Outcome | undefined, kind: OutcomeKind, base: OutcomeMessageInput): string {
  switch (kind) {
    case "triage_stopped":
      return triageStoppedMessage({ ...base, ...(outcome?.kind === "triage_stopped" ? { outcome } : {}) });
    case "needs_info":
      return needsInfoMessage({ ...base, ...(outcome?.kind === "needs_info" ? { outcome } : {}) });
    case "plan_stopped":
      return planStoppedMessage({ ...base, ...(outcome?.kind === "plan_stopped" ? { outcome } : {}) });
    case "launch_failed":
      return launchFailedMessage({ ...base, ...(outcome?.kind === "launch_failed" ? { outcome } : {}) });
    case "approved_without_plan":
      return approvedWithoutPlanMessage(base);
    case "move_skipped":
      return moveSkippedMessage({ ...base, ...(outcome?.kind === "move_skipped" ? { outcome } : {}) });
  }
}

function outcomeLink(input: { issueKey: string; kind: OutcomeKind; commentId?: string }): { url: string; label: string } | undefined {
  const ticket = ticketUrl({ issueKey: input.issueKey, site: jiraSiteUrl(process.env) });
  if (ticket === undefined) return undefined;
  const url = planCommentUrl({ ticketUrl: ticket, commentId: input.commentId }) ?? ticket;
  if (url === ticket) return { url, label: `${input.issueKey} on Jira` };
  return { url, label: `${OUTCOMES[input.kind].label} comment` };
}

/** A ticket dragged back into Planned from Approved or later. The plan itself is not posted again. */
export async function announceMovedBack(input: { issueKey: string; changelogId: string; title?: string; from: string }, ctx: AnnounceHost) {
  if (await retryBounceActive(ctx.host.kv, input.issueKey, ctx.now())) {
    return { posted: false, reason: "retry_bounce", issueKey: input.issueKey };
  }
  const statuses = statusNames(process.env);
  const result = await announceInThread(ctx, {
    changelogId: input.changelogId,
    update: { issueKey: input.issueKey, title: input.title ?? input.issueKey, status: statuses.planned, text: movedBackMessage({ issueKey: input.issueKey, from: input.from, approved: statuses.approved }) },
    record: { from: input.from },
    reaction: "planned",
  });
  if (result.posted) await dropLoader(ctx, input.issueKey);
  return result;
}

/**
 * A ticket entering Approved. The desk launches nothing. A card moved in
 * Jira gets the Approved line. An approval the desk just made from Slack
 * gets nothing here: the person who typed `approve KEY` already has their
 * answer, and the In Progress line with the agent link is the next beat.
 */
export async function announceApproved(input: { issueKey: string; changelogId: string; title?: string }, ctx: AnnounceHost) {
  if (await pullRequestRetryActive(ctx.host.kv, input.issueKey, ctx.now())) {
    return { posted: false, reason: "pull_request_retry", issueKey: input.issueKey };
  }
  if (await approvedInSlack(ctx.host.kv, input.issueKey, ctx.now())) {
    await showLoader(ctx, input.issueKey, "implementing", { ensure: true });
    return { posted: false, reason: "approved_in_slack", issueKey: input.issueKey };
  }
  const result = await announceInThread(ctx, {
    changelogId: input.changelogId,
    update: { issueKey: input.issueKey, title: input.title ?? input.issueKey, status: statusNames(process.env).approved, text: approvedMessage({ issueKey: input.issueKey }) },
    record: {},
    reaction: "building",
  });
  if (result.posted) await dropLoader(ctx, input.issueKey);
  return result;
}

/**
 * A ticket entering In Progress. The worker leaves `Implementing: <agent
 * URL>` on the ticket before it moves it, so the URL is read from the
 * ticket, never from the event.
 */
export async function announceProgress(input: { issueKey: string; changelogId: string; title?: string }, ctx: AnnounceHost) {
  if (await pullRequestRetryActive(ctx.host.kv, input.issueKey, ctx.now())) {
    return { posted: false, reason: "pull_request_retry", issueKey: input.issueKey };
  }
  const read = await readComments(ctx.host.mcp, input.issueKey);
  if (read.status !== "read") {
    return { posted: false, reason: read.status, issueKey: input.issueKey, ...(read.status === "failed" ? { message: read.message } : {}) };
  }
  const url = latestImplementingComment(read.comments);
  if (url === undefined) {
    return { posted: false, reason: "no_implementing_comment", issueKey: input.issueKey };
  }
  const result = await announceInThread(ctx, {
    changelogId: input.changelogId,
    // The approve reply ("KEY is approved; the agent link follows") or a board
    // drag's Approved line promised this link; the link replaces that line.
    update: {
      issueKey: input.issueKey,
      title: input.title ?? input.issueKey,
      status: statusNames(process.env).inProgress,
      text: progressMessage({ issueKey: input.issueKey, url }),
      replaces: new RegExp(`^${input.issueKey.replace(/[^A-Za-z0-9-]/g, "")}(?: is approved\\b|: starting implementation…)`, "i"),
    },
    record: { url },
    reaction: "building",
  });
  if (result.posted) await dropLoader(ctx, input.issueKey, { keepMessage: result.reason === "replaced_reply_in_thread" });
  return result.posted ? { ...result, url } : result;
}

/**
 * A ticket entering In Review or Done. `factory-worker` makes both moves
 * from its implement PR (Done only on a person's merge), or a person drags
 * the card. The desk only reports the status.
 */
export async function announceClosing(input: { issueKey: string; changelogId: string; title?: string; stage: "in_review" | "done" }, ctx: AnnounceHost) {
  const names = statusNames(process.env);
  const status = input.stage === "in_review" ? names.inReview : names.done;
  const result = await announceInThread(ctx, {
    changelogId: input.changelogId,
    update: { issueKey: input.issueKey, title: input.title ?? input.issueKey, status, text: "" },
    record: {},
    reaction: input.stage === "in_review" ? "in_review" : "done",
    // The worker's `Pull request:` comment names the PR; on Done, `Merged by:`
    // names the human merger. An unreadable ticket posts the line without
    // them; they never block the line. In Review never mentions a merger.
    prepare: async () => {
      let pr: { url: string; label: string } | undefined;
      let mergedBy: string | undefined;
      try {
        const read = await readComments(ctx.host.mcp, input.issueKey);
        if (read.status === "read") {
          pr = latestPullRequestComment(read.comments);
          if (input.stage === "done") mergedBy = latestMergedByComment(read.comments);
        }
      } catch {
        pr = undefined;
        mergedBy = undefined;
      }
      const withPr = { issueKey: input.issueKey, ...(pr === undefined ? {} : { pr }) };
      return {
        update: {
          text: input.stage === "in_review" ? inReviewMessage(withPr) : doneMessage({ ...withPr, ...(mergedBy === undefined ? {} : { mergedBy }) }),
        },
        result: { pr: pr?.label ?? "none", ...(input.stage === "done" ? { mergedBy: mergedBy ?? "none" } : {}) },
      };
    },
  });
  if (result.posted) {
    await dropLoader(ctx, input.issueKey);
    if (input.stage === "in_review") await showReviewLoader(ctx, input.issueKey);
  }
  return result;
}

/**
 * A Planned webhook after the ticket has already left Planned must not dump
 * "KEY is planned:" again: the per-plan claim covers a redelivery, this
 * check covers a late Planned delivery after Approved. The ticket's live
 * status decides. The intake root's status line stands in only when Jira
 * cannot be read: that line never moves back (threads.ts `supersedes`), so
 * after a move back from Approved it still shows Approved while the ticket
 * is Planned again, and a replan's new plan must still post.
 */
async function skipPlanAnnounce(
  ctx: AnnounceHost,
  issueKey: string
): Promise<{ posted: false; reason: "past_planned"; issueKey: string } | undefined> {
  const read = await issueStatus(ctx.host.mcp, issueKey);
  if (read.status === "read") {
    return pastPlanned(read.name) ? { posted: false, reason: "past_planned", issueKey } : undefined;
  }
  const { ticket } = await ticketPost(ctx.host.kv, issueKey);
  if (pastPlanned(ticket?.rootStatus?.status)) {
    return { posted: false, reason: "past_planned", issueKey };
  }
  return undefined;
}

/**
 * Stable id for one Triaged line, from the verdict as triage wrote it. Jev
 * confidence and next-step prose are left out: only type, severity, Jev
 * choices, and the planner gate count as a change. The trailing `first`
 * keeps the keys #121 already wrote valid, so a deploy does not repost
 * every ticket's Triaged line.
 */
export function triagedVerdictFingerprint(input: { verdict?: TriageVerdict }): string {
  const verdict = input.verdict;
  if (verdict === undefined) return "none.first";
  return [token(verdict.issueType ?? verdict.kind), verdict.severity, verdict.gate ?? "plan", token(verdict.jev?.type?.choice), token(verdict.jev?.severity?.choice), "first"].join(".");
}

// Two entries recorded at once can both read the older id, and the older put
// can land last. Each writer reads again after the settle wait and writes its
// id back while the stored one is older, so the key ends on the newest entry.
async function recordTriagedEntry(kv: AnnounceHost["host"]["kv"], input: { issueKey: string; changelogId: string; settleMs: number }) {
  const { issueKey, changelogId, settleMs } = input;
  const key = triagedEntryKey(issueKey);
  try {
    for (let pass = 0; pass < (settleMs > 0 ? 2 : 1); pass += 1) {
      if (pass > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
      if (!newerEntry(changelogId, await kv.get(key))) return;
      await kv.put(key, changelogId);
    }
  } catch (error) {
    warnKv("announce.recordTriagedEntry", error);
    // Without it the next Needs info claims per comment, as before.
  }
}

function newerEntry(changelogId: string, current: unknown): boolean {
  if (typeof current !== "string" || current === "") return true;
  if (current === changelogId) return false;
  return !(/^\d+$/.test(current) && /^\d+$/.test(changelogId)) || BigInt(current) < BigInt(changelogId);
}

async function triagedEntry(kv: AnnounceHost["host"]["kv"], issueKey: string): Promise<string | undefined> {
  try {
    const value = await kv.get(triagedEntryKey(issueKey));
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch (error) {
    warnKv("announce.triagedEntry", error);
    return undefined;
  }
}

// The binding as it stands after a post, which may have just opened the intake root.
async function boundThread(ctx: AnnounceHost, issueKey: string): Promise<TicketThread | undefined> {
  try {
    return (await ticketPost(ctx.host.kv, issueKey)).ticket;
  } catch (error) {
    warnKv("announce.boundThread", error);
    return undefined;
  }
}

function token(value: string | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized === "" ? "-" : normalized;
}

async function readTriageComments(mcp: HostMcpRegistry, issueKey: string) {
  try {
    return await readCommentRecords(mcp, issueKey);
  } catch {
    return { status: "failed" as const, issueKey, message: "the comment read threw", comments: [] };
  }
}

async function showLoader(ctx: AnnounceHost, issueKey: string, phase: "planning" | "replanning" | "implementing", options: { ensure?: boolean } = {}) {
  try {
    const client = await ctx.host.slack.getClient();
    const input = { kv: ctx.host.kv, client, issueKey, phase };
    if (options.ensure === true) await ensureLoader(input);
    else await postLoader(input);
  } catch {
    // The status line still landed; the crumb is best effort.
  }
}

// Bugbot, security, and CI run for minutes after the In Review line; the crumb
// fills that silence and review-announce.ts rewrites or clears it per wake.
// When a wake already saw every gate settle, there is nothing to wait on.
async function showReviewLoader(ctx: AnnounceHost, issueKey: string) {
  try {
    const { pending } = await readReviewGates(ctx.host.kv, issueKey);
    await writeReviewGates(ctx.host.kv, issueKey, { inReview: true });
    if (pending !== undefined && pending.length === 0) return;
    const client = await ctx.host.slack.getClient();
    await postLoader({ kv: ctx.host.kv, client, issueKey, phase: "reviewing", ...(pending === undefined ? {} : { pending }) });
  } catch {
    // The In Review line landed; the crumb is best effort.
  }
}

async function dropLoader(ctx: AnnounceHost, issueKey: string, options: { keepMessage?: boolean } = {}) {
  try {
    const client = await ctx.host.slack.getClient();
    await clearLoader({ kv: ctx.host.kv, client, issueKey, ...(options.keepMessage === true ? { keepMessage: true } : {}) });
  } catch {
    // The real status is in the thread; a leftover crumb is cleaned on the next one.
  }
}

// The post goes out whatever the read says: a missing or unreadable comment
// shrinks it to the title and the approve line, it never blocks it.
async function readPlan(mcp: HostMcpRegistry, issueKey: string): Promise<PlanRead> {
  let read: Awaited<ReturnType<typeof readCommentRecords>>;
  try {
    read = await readCommentRecords(mcp, issueKey);
  } catch {
    return { plan: "failed" };
  }
  if (read.status !== "read") return { plan: read.status };
  const comment = latestPlanComment(read.comments, issueKey);
  if (comment === undefined) return { plan: "no_plan_comment" };
  const digest = parsePlanComment(comment.body, issueKey);
  return { digest, plan: digest.format, ...(comment.id === undefined ? {} : { commentId: comment.id }) };
}

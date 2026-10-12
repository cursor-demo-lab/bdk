// `retry KEY`, exactly, from the person who filed KEY, in KEY's thread, is
// the recovery the hop-watch line offers (hop-watch.ts). Host code reads the
// ticket and redelivers the hop it is stuck in, with no model turn:
//
// - To Do (triage never ran) and Triaged (the planner never answered): the
//   same move `plan KEY` makes (plan-move.ts), after the same triage gate.
// - Approved (the worker never launched, or its move did not land):
//   Approved → Planned → Approved, so the worker gets a fresh Approved
//   delivery. The worker claims `implement/<KEY>` once per ticket and
//   launches with that claim as its idempotency key. A redelivery that finds
//   the claim `launched` re-links that agent instead of starting a second.
// - In Progress with the worker's `Implementing:` comment (its agent may have
//   pushed a branch that never got a pull request, TLSSN-35): In Progress →
//   Approved. The worker finds its launched claim, moves the ticket back to
//   In Progress, and opens the pull request from the agent's branch, or
//   watches for it while the agent still works. No second agent starts.
//
// A hop still inside its deadline is not retried, and neither is a Triaged
// ticket whose planner run is still live past it (`Planning started:` with no
// outcome yet, planner-liveness.ts), so a slow run is never doubled
// (TLSSN-45: a retry at 20 minutes ran a second planner for 12 minutes). The
// one exception is a plan entry the 4-minute start check already declared
// not started (hop-watch.ts `startCheckFreesRetry`: its final line, or an
// automatic re-send that failed), whose line offered this retry. The planner
// send itself is shared with that check (planner-redeliver.ts). A refusal
// from the filer gate is answered here too (host-refusal.ts), so the command
// never also starts a model turn.

import { randomUUID } from "node:crypto";
import { defaultSlackAuth, type SlackBinding, type SlackMessage } from "@cursor/july/channels/slack";
import { approveCommandText } from "./approve-command.js";
import { finishLease, releaseLease, takeLease } from "./claim-lease.js";
import { binding, commandThread } from "./command-thread.js";
import { statusNames } from "./config.js";
import { replyPrefix } from "./desk-channels.js";
import { HOPS, readHopWatch, readTriagedSince, startCheckFreesRetry } from "./hop-watch.js";
import { issueStatus, readCommentRecords, transitionFrom } from "./jira.js";
import { latestPlanComment } from "./plan-comment.js";
import { planningRun } from "./planner-liveness.js";
import { redeliverToPlanner } from "./planner-redeliver.js";
import { showPlannerWait } from "./planner-wait.js";
import { clearPullRequestRetry, clearRetryBounce, clearSlackApproval, recordPullRequestRetry, recordRetryBounce, recordSlackApproval } from "./slack-approval.js";
import { answerRefusal, type FilerGateWhy } from "./host-refusal.js";
import { latestImplementingComment } from "./status-event.js";
import { sameThread } from "./threads.js";
import { latestTriageVerdict } from "./triage-comment.js";
import { retryCommandKey } from "./kv-keys.js";

const EXACT_RETRY = /^retry\s+([A-Za-z][A-Za-z0-9]+-\d+)[.!]*$/i;
const RETRY_LEASE_MS = 60_000;

export type RetryCommandDeps = { isExternal: (message: SlackMessage) => Promise<boolean>; now?: () => Date };

type Why = FilerGateWhy;
type Outcome =
  | "not_retry"
  | "not_eligible"
  | "duplicate"
  | "claim_unavailable"
  | "within_deadline"
  | "still_running"
  | "status_unread"
  | "triage_gate"
  | "sent_to_planner"
  | "not_moved"
  | "no_plan"
  | "redelivered"
  | "nothing_to_retry";
type Decision = { outcome: Outcome; why?: Why; issueKey?: string; status?: string; detail?: string };

/** The key of a message that is only `retry KEY`, with the same chrome allowed as `approve KEY`. */
export function retryTarget(text: string): string | undefined {
  const match = EXACT_RETRY.exec(approveCommandText(text));
  return match === null ? undefined : match[1]!.toUpperCase();
}

function retryTargetFromMessage(message: SlackMessage): string | undefined {
  for (const text of [message.text, message.body, message.markdown]) {
    if (typeof text !== "string") continue;
    const key = retryTarget(text);
    if (key !== undefined) return key;
  }
  return undefined;
}

export type { FilerGateWhy };

/** The gates every host ticket command shares: a person from this workspace who filed KEY, speaking in KEY's thread. */
export async function filerGate(ctx: SlackBinding, message: SlackMessage, deps: { isExternal: (message: SlackMessage) => Promise<boolean> }, issueKey: string): Promise<{ why: FilerGateWhy; author?: undefined } | { why?: undefined; author: string }> {
  const author = message.author?.userId;
  if (author === undefined || author === "" || message.author?.isBot === true) return { why: "bot_or_no_author" };
  const classified = message.teamId ? message : { ...message, ...(ctx.slack.teamId === undefined || ctx.slack.teamId === "" ? {} : { teamId: ctx.slack.teamId }) };
  if (defaultSlackAuth(message, ctx) === null) return { why: "no_auth" };
  if (await deps.isExternal(classified)) return { why: "external" };
  const ticket = await binding(ctx.host.kv, issueKey);
  if (ticket?.originatorUserId === undefined) return { why: "unbound" };
  if (ticket.originatorUserId !== author) return { why: "not_filer" };
  if (!sameThread(ticket, commandThread(ctx, message))) return { why: "wrong_thread" };
  return { author };
}

/** Returns true when host code answered the message and it needs no model turn. */
export async function takeRetryCommand(ctx: SlackBinding, message: SlackMessage, deps: RetryCommandDeps): Promise<boolean> {
  const decision = await retry(ctx, message, deps);
  if (decision.outcome !== "not_retry") console.log(JSON.stringify({ desk: "retry_command", ...decision, channel: ctx.slack.channelId, ts: message.ts }));
  if (decision.outcome === "not_eligible") return answerRefusal(ctx, decision.why!, "retry", decision.issueKey!);
  return decision.outcome !== "not_retry";
}

async function retry(ctx: SlackBinding, message: SlackMessage, deps: RetryCommandDeps): Promise<Decision> {
  const issueKey = retryTargetFromMessage(message);
  if (issueKey === undefined) return { outcome: "not_retry" };
  const gate = await filerGate(ctx, message, deps, issueKey);
  if (gate.why !== undefined) return { outcome: "not_eligible", why: gate.why, issueKey };
  const { author } = gate;
  const kv = ctx.host.kv;

  const claimKey = retryCommandKey({ channelId: ctx.slack.channelId, ts: message.ts });
  const owner = randomUUID();
  const now = deps.now?.() ?? new Date();
  const claim = await takeLease(kv, claimKey, { owner, leaseMs: RETRY_LEASE_MS, now, fields: { issueKey } });
  if (claim.status === "done" || claim.status === "held") return { outcome: "duplicate", issueKey };
  const say = (text: string) => ctx.thread.post(text);
  if (claim.status === "unavailable") {
    await releaseLease(kv, claimKey, owner);
    await say(`I could not record your retry for ${issueKey} just now, so nothing moved. Say it again in a minute.`);
    return { outcome: "claim_unavailable", issueKey };
  }
  const decision = await redeliver({ ctx, issueKey, author, now, say });
  if (decision.outcome === "status_unread") await releaseLease(kv, claimKey, owner);
  else await finishLease(kv, claimKey, owner, { fields: { outcome: decision.outcome } });
  return decision;
}

async function redeliver(input: { ctx: SlackBinding; issueKey: string; author: string; now: Date; say: (text: string) => Promise<unknown> }): Promise<Decision> {
  const { ctx, issueKey, author, now, say } = input;
  const kv = ctx.host.kv;
  const handle = replyPrefix(ctx.slack.channelId);
  const statuses = statusNames(process.env);

  const watch = await readHopWatch(kv, issueKey);
  // A plan entry the 4-minute start check already declared not started (its
  // final line, or an automatic re-send that failed) is not waited out again.
  if (watch !== undefined && now.getTime() < Date.parse(watch.dueAt) && !startCheckFreesRetry(watch)) {
    const left = Math.max(1, Math.ceil((Date.parse(watch.dueAt) - now.getTime()) / 60_000));
    await say(`${HOPS[watch.hop].agent[0]!.toUpperCase()}${HOPS[watch.hop].agent.slice(1)} still has about ${left} minutes before ${issueKey} counts as stuck, so I did not start it again.`);
    if (watch.hop === "plan") await showPlannerWait({ kv, getClient: () => ctx.host.slack.getClient(), issueKey, phase: "planning", ensure: true });
    return { outcome: "within_deadline", issueKey, detail: watch.hop };
  }

  const live = await issueStatus(ctx.host.mcp, issueKey);
  if (live.status !== "read") {
    await say(`I could not read ${issueKey} in Jira just now, so nothing moved. Say \`${handle}retry ${issueKey}\` again in a minute.`);
    return { outcome: "status_unread", issueKey };
  }
  const current = live.name;
  const is = (name: string) => current.trim().toLowerCase() === name.trim().toLowerCase();

  if (is(statuses.todo) || is(statuses.triaged)) {
    const read = await readCommentRecords(ctx.host.mcp, issueKey).catch(() => undefined);
    const verdict = read?.status === "read" ? latestTriageVerdict(read.comments.map((comment) => comment.body)) : undefined;
    if (verdict?.gate !== undefined) {
      await say(`${issueKey}'s triage verdict is one the planner does not plan (${verdict.gate}), so a retry would wake nothing. ${verdict.gate === "needs_info" ? "Reply here with the missing detail and it goes onto the ticket and back to the planner." : "Change the ticket in Jira first."}`);
      return { outcome: "triage_gate", issueKey, status: current, detail: verdict.gate };
    }
    // The live watch's entry time, or once it has fired and gone, the per-ticket record of it.
    const since = watch?.hop === "plan" ? new Date(watch.since) : await readTriagedSince(kv, issueKey);
    const run =
      is(statuses.triaged) && read?.status === "read"
        ? planningRun({ comments: read.comments, issueKey, statuses, now, ...(since === undefined ? {} : { since }) })
        : undefined;
    if (run?.state === "live") {
      await say(
        `The planner is still running for ${issueKey} (${run.minutes} min), so I did not start a second run. A plan, a Needs info, or a Plan stopped line lands here when it finishes. If nothing lands in about ${run.liveForMinutes} minutes, say \`${handle}retry ${issueKey}\` again.`
      );
      await showPlannerWait({ kv, getClient: () => ctx.host.slack.getClient(), issueKey, phase: "planning", ensure: true });
      return { outcome: "still_running", issueKey, status: current, detail: run.run.sessionId ?? "" };
    }
    const unsure = is(statuses.triaged) && read?.status !== "read";
    const moved = await redeliverToPlanner({
      mcp: ctx.host.mcp,
      kv,
      getClient: () => ctx.host.slack.getClient(),
      issueKey,
      current,
      statuses,
      now,
      said: () =>
        say(
          is(statuses.todo)
            ? `Sent ${issueKey} to the planner without a triage verdict.`
            : unsure
              ? `Started a fresh planning run for ${issueKey}. I could not read the ticket's comments, so an earlier run may still be active; the first plan to land is the one posted here.`
              : `Started a fresh planning run for ${issueKey}.`
        ),
    });
    if (!moved.requested) {
      await say(`I could not send ${issueKey} to the planner (${moved.reason}${moved.current === undefined ? "" : `, it is ${moved.current}`}), so nothing changed.`);
      return { outcome: "not_moved", issueKey, status: current, detail: moved.reason };
    }
    return { outcome: "sent_to_planner", issueKey, status: current };
  }

  if (is(statuses.approved)) {
    const read = await readCommentRecords(ctx.host.mcp, issueKey).catch(() => undefined);
    if (read?.status === "read" && latestPlanComment(read.comments, issueKey) === undefined) {
      await say(`${issueKey} has no plan on the ticket, so the worker has nothing to build and a retry would stop the same way. Move it to To Do in Jira, then say \`${handle}plan ${issueKey}\`.`);
      return { outcome: "no_plan", issueKey, status: current };
    }
    await recordRetryBounce(kv, { issueKey, at: now });
    await recordSlackApproval(kv, { issueKey, at: now, by: author });
    const back = await transitionFrom(ctx.host.mcp, { issueKey, from: statuses.approved, toStatus: statuses.planned });
    if (back.status !== "transitioned") {
      await clearRetryBounce(kv, issueKey);
      await clearSlackApproval(kv, issueKey);
      await say(`I could not send ${issueKey}'s approval to the worker again (${back.status === "skipped_status" ? `it is ${back.current ?? "unreadable"} now` : back.status}), so nothing changed.`);
      return { outcome: "not_moved", issueKey, status: current, detail: back.status };
    }
    const forward = await transitionFrom(ctx.host.mcp, { issueKey, from: statuses.planned, toStatus: statuses.approved });
    if (forward.status !== "transitioned" && forward.status !== "already") {
      await clearSlackApproval(kv, issueKey);
      await say(`${issueKey} went back to Planned, but the move to Approved again did not land (${forward.status}). Say \`${handle}approve ${issueKey}\` to send it to the worker.`);
      return { outcome: "not_moved", issueKey, status: statuses.planned, detail: forward.status };
    }
    await say(`Sent ${issueKey}'s approval to the worker again. If an agent already started, its link comes here and the ticket moves to In Progress; if none did, the worker starts one unless a launch is already under way.`);
    return { outcome: "redelivered", issueKey, status: current };
  }

  if (is(statuses.inProgress)) {
    const read = await readCommentRecords(ctx.host.mcp, issueKey).catch(() => undefined);
    if (read?.status !== "read") {
      await say(`I could not read ${issueKey}'s comments in Jira just now, so nothing moved. Say \`${handle}retry ${issueKey}\` again in a minute.`);
      return { outcome: "status_unread", issueKey, status: current };
    }
    if (latestImplementingComment(read.comments.map((comment) => comment.body)) !== undefined) {
      await recordPullRequestRetry(kv, { issueKey, at: now });
      const back = await transitionFrom(ctx.host.mcp, { issueKey, from: statuses.inProgress, toStatus: statuses.approved });
      if (back.status !== "transitioned") {
        await clearPullRequestRetry(kv, issueKey);
        await say(`I could not send ${issueKey} back to the worker (${back.status === "skipped_status" ? `it is ${back.current ?? "unreadable"} now` : back.status}), so nothing changed.`);
        return { outcome: "not_moved", issueKey, status: current, detail: back.status };
      }
      await say(
        `Sent ${issueKey} back to the worker to open its pull request. If the agent pushed its branch, the worker opens the pull request ready for review and ${issueKey} moves to In Review here. If the agent is still working, ${issueKey} goes back to In Progress and the pull request opens when it finishes. No second agent starts.`
      );
      return { outcome: "redelivered", issueKey, status: current, detail: "pull_request" };
    }
  }

  await say(`${issueKey} is ${current}. Nothing is waiting on triage, the planner, or the worker's launch, so there is nothing to retry.`);
  return { outcome: "nothing_to_retry", issueKey, status: current };
}

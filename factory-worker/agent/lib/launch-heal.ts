import { abandonPendingClaim, LAUNCH_GRACE_MS, parseClaim, pendingLost } from "./claim.js";
import { createLaunchPipeline, type ApprovalReply, type HandlerDeps } from "./handle.js";
import { implementClaimKey } from "./kv-keys.js";
import { deleteVerified } from "./kv-verified.js";
import {
  closeLaunchWatch,
  LAUNCH_HEAL_FIRST_MS,
  LAUNCH_HEAL_MAX_AGE_MS,
  LAUNCH_HEAL_MAX_ATTEMPTS,
  LAUNCH_HEAL_RETRY_MS,
  launchWatchKey,
  noteLaunchAttempt,
  noteReminderDue,
  openLaunchWatch,
  parseLaunchWatch,
  pruneLaunchIndex,
  readLaunchIndex,
  readLaunchWatch,
  replaceLaunchReminder,
  type LaunchArm,
} from "./launch-watch.js";
import { warnKv, warnOps } from "./ops-funnel.js";
import { claimMode } from "./verified-claim.js";

// The launch watch's heal (launch-watch.ts): a watch past LAUNCH_GRACE_MS
// whose claim is not a recorded, commented, moved launch is replayed through
// the Jira route's own pipeline (handle.ts `createLaunchPipeline`) as `heal`:
// the ticket must still be Approved, the brief is read again, the claim is
// retaken (a pending claim past the grace is lost), and the launch uses the
// same `idempotencyKey`, so the heal and a person's `retry` start one agent.
// A launched claim whose comment or move is missing is repaired, never
// relaunched. After LAUNCH_HEAL_MAX_ATTEMPTS the watch gives up with one
// `Launch failed:` comment, which the desk announces. Never throws.

/**
 * `not_watched`, `superseded`, `not_due`, `done`, `gave_up`, and `threw` are
 * the heal's own; anything else is what the replayed approval did
 * (`launched`, `launch_failed`, `not_approved`, `comments_unreadable`, …).
 */
export type HealResult = { issueKey: string; outcome: string; attempt?: number; rescheduleMs?: number };

/**
 * One ticket's heal, from its reminder (`reminderId`, `approvedAt` and any
 * `orphan` from its args) or the sweep (none). Past LAUNCH_HEAL_MAX_AGE_MS
 * from the approval it stops rescheduling whatever kv says, since that
 * bound rides in the reminder's own args.
 */
export async function healLaunch(
  deps: HandlerDeps,
  input: { issueKey: string; reminderId?: string; approvedAt?: string; orphan?: { changelogId: string; title: string; at: string } }
): Promise<HealResult> {
  const result = await healOnce(deps, input);
  // The reminder reschedules itself by this result; the watch records when, so the tend can tell a lost reminder from a live one.
  if (input.reminderId !== undefined && result.rescheduleMs !== undefined) {
    await noteReminderDue(deps.kv, { issueKey: input.issueKey, reminderId: input.reminderId, dueAt: new Date(deps.now().getTime() + result.rescheduleMs) });
  }
  return result;
}

async function healOnce(
  deps: HandlerDeps,
  input: { issueKey: string; reminderId?: string; approvedAt?: string; orphan?: { changelogId: string; title: string; at: string } }
): Promise<HealResult> {
  const { issueKey, orphan } = input;
  const approvedAt = input.approvedAt ?? orphan?.at;
  const again = async (result: HealResult, watchAt?: string): Promise<HealResult> => {
    const from = Date.parse(approvedAt ?? watchAt ?? "");
    if (!Number.isFinite(from) || deps.now().getTime() - from < LAUNCH_HEAL_MAX_AGE_MS) return { ...result, rescheduleMs: LAUNCH_HEAL_RETRY_MS };
    // Closed without cancelling: this reminder is the one running, and it stops. A closed watch is never re-armed.
    await closeLaunchWatch({ kv: deps.kv }, issueKey);
    warnOps({ site: "launch-heal.expired", kind: "launch watch", reasonCode: result.outcome });
    log(deps, { issueKey, outcome: "expired", last: result.outcome });
    return { issueKey, outcome: "expired", ...(result.attempt === undefined ? {} : { attempt: result.attempt }) };
  };
  try {
    // An orphan reminder was armed while kv could not hold the record: its first fire writes it.
    if (orphan !== undefined && (await readLaunchWatch(deps.kv, issueKey)) === undefined) {
      const opened = await openLaunchWatch(deps.kv, { issueKey, changelogId: orphan.changelogId, title: orphan.title, now: new Date(orphan.at), env: deps.env });
      if (opened === "unavailable") return again({ issueKey, outcome: "unavailable" });
    }
    const watch = await readLaunchWatch(deps.kv, issueKey);
    if (watch === undefined) return { issueKey, outcome: "not_watched" };
    if (input.reminderId !== undefined && watch.reminderId !== undefined && watch.reminderId !== input.reminderId) return { issueKey, outcome: "superseded" };
    const now = deps.now().getTime();
    const watchDue = Date.parse(watch.at) + LAUNCH_GRACE_MS;
    if (now < watchDue) return { issueKey, outcome: "not_due", rescheduleMs: Math.max(watchDue - now, 60_000) };
    const claimValue = await deps.kv.get(implementClaimKey(issueKey));
    const claim = parseClaim(claimValue);
    // A launch still inside its grace is in flight; its own delivery records it or loses it.
    if (claim?.state === "pending" && !pendingLost({ claim, now: new Date(now), mode: claimMode(deps.env) })) {
      return again({ issueKey, outcome: "not_due" }, watch.at);
    }
    if (claim?.state === "launched" && claim.commented && claim.moved) {
      await closeLaunchWatch(deps, issueKey);
      return { issueKey, outcome: "done" };
    }
    const pipeline = createLaunchPipeline(deps);
    if (watch.attempts >= LAUNCH_HEAL_MAX_ATTEMPTS) {
      await closeLaunchWatch(deps, issueKey);
      if (claim?.state === "launched") {
        // An agent runs; only its comment or move keeps failing. That is no launch failure to announce, whatever the last attempt said.
        warnOps({ site: "launch-heal.repair", kind: "launch repair", reasonCode: watch.last ?? "unrepaired" });
        log(deps, { issueKey, outcome: "gave_up", attempts: watch.attempts, last: watch.last, launched: true });
        return { issueKey, outcome: "gave_up" };
      }
      if (watch.last === "agent_unverified") {
        // The agent check never answered, so nothing may launch on the watch's say-so. Clear the pending claim
        // it leaves, so a person's next move to Approved takes a fresh claim and launches: a human asked.
        const cleared = await abandonPendingClaim(deps.kv, { issueKey, expected: claimValue, now: new Date(now), mode: claimMode(deps.env) });
        warnOps({
          site: "launch-heal.unverified",
          kind: "agent check",
          reasonCode: watch.detail ?? "unknown",
          subject: issueKey,
          message: `${issueKey}: Agent.list could not confirm whether a lost launch started an agent; claim ${cleared ? "cleared" : "not cleared"}, a move to Approved launches`,
        });
        const trace = await pipeline.reportLaunchFailure({ issueKey, changelogId: watch.changelogId, reason: "agent_unverified" });
        log(deps, { issueKey, outcome: "gave_up", attempts: watch.attempts, last: watch.last, detail: watch.detail, cleared, trace });
        return { issueKey, outcome: "gave_up" };
      }
      const trace = await pipeline.reportLaunchFailure({ issueKey, changelogId: watch.changelogId, reason: watch.last ?? "launch_lost" });
      log(deps, { issueKey, outcome: "gave_up", attempts: watch.attempts, last: watch.last, trace });
      return { issueKey, outcome: "gave_up" };
    }
    const attempt = watch.attempts + 1;
    await noteLaunchAttempt(deps.kv, { issueKey, attempts: attempt });
    const work: Promise<unknown>[] = [];
    const reply = await pipeline.approve({ issueKey, changelogId: watch.changelogId, title: watch.title || issueKey, via: "heal", attempt }, (promise) => work.push(promise));
    const settled = await Promise.allSettled(work);
    const { outcome, detail } = healOutcome({ reply, settled });
    const still = await readLaunchWatch(deps.kv, issueKey);
    if (still === undefined) return { issueKey, outcome, attempt };
    await noteLaunchAttempt(deps.kv, { issueKey, attempts: attempt, last: outcome, ...(detail === undefined ? {} : { detail }) });
    return again({ issueKey, outcome, attempt }, watch.at);
  } catch (error) {
    warnKv("launch-heal.healLaunch", error);
    return again({ issueKey, outcome: "threw" });
  }
}

/** What the replayed approval did, as one word for the log and the watch's `last`. */
function healOutcome(input: { reply: ApprovalReply; settled: PromiseSettledResult<unknown>[] }): { outcome: string; detail?: string } {
  for (const each of input.settled) {
    if (each.status === "rejected") return { outcome: "threw" };
    const value = each.value;
    if (value === null || typeof value !== "object" || !("launched" in value)) continue;
    const record = value as Record<string, unknown>;
    if (record["launched"] === true) return { outcome: "launched" };
    const detail = typeof record["detail"] === "string" ? { detail: record["detail"] } : {};
    return { outcome: typeof record["reason"] === "string" ? record["reason"] : "launch_failed", ...detail };
  }
  const { body } = input.reply;
  if (typeof body["reason"] === "string") return { outcome: body["reason"] };
  if (body["duplicate"] === true) return { outcome: body["inFlight"] === true ? "in_flight" : body["unconfirmed"] === true ? "unconfirmed" : "duplicate" };
  return { outcome: input.reply.status >= 500 ? "unavailable" : "unknown" };
}

/** A reminder this late past its recorded `dueAt` is lost; its watch gets a new one. A healthy one reschedules every 2 minutes. */
export const LAUNCH_REMINDER_LOST_MS = 10 * 60_000;
/** Reminders `tendLaunchWatches` creates per run, each capped at LAUNCH_REMINDER_TIMEOUT_MS. */
export const LAUNCH_ARMS_PER_TEND = 3;

export type TendResult = { issueKey: string; reminder: LaunchArm };

/**
 * The backstop's part in the launch watch, run from any worker delivery:
 * it heals nothing itself (a heal can take a launch deadline and its late
 * wait, and a delivery's admission is not the heal's to spend), but gives a
 * watch with no reminder, or one whose reminder is LAUNCH_REMINDER_LOST_MS
 * past due, a new reminder, and prunes the keys whose record is gone. A
 * watch past LAUNCH_HEAL_MAX_AGE_MS is closed (only while the record is the
 * one read) and its reminder cancelled: nothing may heal it any more, and a
 * watch that never had a reminder has no run of its own to close it. The
 * reminder's own run heals. At most LAUNCH_ARMS_PER_TEND creates per run.
 */
export async function tendLaunchWatches(deps: HandlerDeps): Promise<TendResult[]> {
  const index = await readLaunchIndex(deps.kv);
  const results: TendResult[] = [];
  const gone = new Set<string>();
  for (const issueKey of index) {
    const watch = await readLaunchWatch(deps.kv, issueKey);
    if (watch === undefined) {
      gone.add(issueKey);
      continue;
    }
    const now = deps.now().getTime();
    if (now - Date.parse(watch.at) >= LAUNCH_HEAL_MAX_AGE_MS) {
      const closed = await deleteVerified(deps.kv, launchWatchKey(issueKey), (current) => {
        const latest = parseLaunchWatch(current);
        return latest?.at === watch.at && latest.reminderId === watch.reminderId;
      });
      if (closed.status !== "written") continue;
      if (watch.reminderId !== undefined) await deps.reminders?.cancel(watch.reminderId, "expired").catch(() => undefined);
      gone.add(issueKey);
      log(deps, { issueKey, outcome: "expired_closed", reminderId: watch.reminderId ?? null });
      continue;
    }
    if (results.length >= LAUNCH_ARMS_PER_TEND || deps.reminders === undefined) continue;
    if (watch.reminderId !== undefined) {
      const due = Date.parse(watch.dueAt ?? "") || Date.parse(watch.at) + LAUNCH_HEAL_FIRST_MS;
      if (now <= due + LAUNCH_REMINDER_LOST_MS) continue;
    }
    results.push({ issueKey, reminder: await replaceLaunchReminder({ kv: deps.kv, reminders: deps.reminders, now: deps.now }, { issueKey, watch }) });
  }
  if (gone.size > 0) await pruneLaunchIndex(deps.kv, { gone, env: deps.env });
  return results;
}

function log(deps: HandlerDeps, fields: Record<string, unknown>): void {
  (deps.log ?? ((line: string) => console.log(line)))(JSON.stringify({ worker: "launch_heal", ...fields }));
}

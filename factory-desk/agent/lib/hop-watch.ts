import { randomUUID } from "node:crypto";
import type { HostMcpRegistry, JsonObject, JsonValue, ReminderHostApi } from "@cursor/july";
import { announceOutcome, type AnnounceHost } from "./announce.js";
import { finishLease, leaseExpired, pendingLease, releaseLease, takeLease } from "./claim-lease.js";
import { claimSettleMs, statusNames, type StatusNames } from "./config.js";
import { replyPrefix } from "./desk-channels.js";
import { issueStatus, readCommentRecords, type CommentRecord } from "./jira.js";
import { addIndexEntry, indexList, indexMergeOn, pruneIndexEntries, type IndexAdd } from "./kv-index.js";
import { BACKSTOP_SWEEP_KEY, HOP_WATCH_INDEX, hopWatchClaimKey, hopWatchKey, type KeyedKv, type KvKey, planStartClaimKey, planStartRetryKey, triagedSinceKey } from "./kv-keys.js";
import { deleteVerified, sameJson, updateVerified } from "./kv-verified.js";
import { clearLoader } from "./loader.js";
import { outcomeKind, type OutcomeKind } from "./outcomes.js";
import { latestPlanComment } from "./plan-comment.js";
import { planningRun, START_SKEW_MS, type PlanningRun } from "./planner-liveness.js";
import { redeliverToPlanner } from "./planner-redeliver.js";
import { latestImplementingComment } from "./status-event.js";
import type { StatusStage } from "./status-reaction.js";
import { announceTicketUpdate } from "./ticket-thread.js";
import { parseThreadRef, ticketKey } from "./threads.js";
import { latestTriageVerdict, type TriageVerdict } from "./triage-comment.js";
import { warnKv } from "./ops-funnel.js";

export { BACKSTOP_SWEEP_KEY, HOP_WATCH_INDEX, hopWatchClaimKey, hopWatchKey, planStartClaimKey, planStartRetryKey, triagedSinceKey };

// A hop is the wait between one agent's wake and the Jira artifact it
// leaves: triage (To Do until Triaged or `Triage stopped:`), plan (Triaged
// until Planned, `Needs info:`, or `Plan stopped:`), and launch (Approved
// until `Implementing:` and In Progress, `Launch failed:`, or "Approved
// without a plan"). A pod replaced mid-turn, a Jira rule that is off, or a
// write that never lands leaves the ticket in the hop's status with nothing
// said. Each entry arms one record per ticket and one reminder due at the
// hop's deadline. The fire re-reads Jira: a ticket that left the status, or
// whose outcome comment landed, gets nothing (or the outcome the comment
// rule never delivered); one still waiting gets one line naming the hop and
// the `retry KEY` that redelivers it. The deadline watch never retries on
// its own.
//
// The plan hop also has a start check at PLAN_START_DEADLINE_MS (4 min): a
// hosted planner delivery can be handed a reused session by the control
// plane, and July 0.2.18 then throws before the turn starts and logs nothing
// (docs/deployment-issues.md, issue 28; TLSSN-60 went silent for 54 min).
// A healthy run writes `Planning started: <KEY>` within seconds of the
// Triaged move (planner-liveness.ts), so a Triaged ticket with no marker,
// plan, or outcome for this entry at 4 minutes is a wake that was lost. The
// check then posts one short line and re-sends the ticket to the planner
// ONCE per stuck episode, the way `retry KEY` does (planner-redeliver.ts),
// recording the re-send at `plan-start-retry/<KEY>` before it moves. When the
// retried entry does not start either, the check posts a final line (the
// next step is a planner redeploy) and never retries again while that record
// stands. The 15-minute deadline fire for that entry stays quiet unless the
// planner did start late.
//
// Anonymous reminder `run` is rejected on hosted v2, so the deadline is a
// named handler (`agent/reminders/hop_watch.ts`) with JSON args, created
// inside the request that armed it, while the pod's CURSOR_API_KEY is bound.
// The sweep covers a record whose reminder could not be armed or never
// fired. The hop-watch schedule runs it every five minutes: self-hosted
// serve on its own clock, and hosted v2 because July 0.2.13 `deploy`
// declares it in the release manifest as a 5-minute `run` schedule that the
// guest runs. `backstopSweep` also runs it from desk admissions at most every
// five minutes. Sweeps can overlap; each hop line is claimed at
// `announced/<KEY>:hop-<hop>:<changelog>`, so it posts once. A record names
// the entry that armed it; a fire for any other entry is stale and stops.

export type Hop = "triage" | "plan" | "launch";

type HopSpec = {
  /** The status the ticket sits in while this hop's agent works. */
  waits: (statuses: StatusNames) => string;
  /** Outcome comments that end the hop without a move (outcomes.ts). */
  outcomes: readonly OutcomeKind[];
  deadlineMs: number;
  /** Who is silent, for the unreadable-status line. */
  agent: string;
};

export const HOPS: Record<Hop, HopSpec> = {
  triage: { waits: (statuses) => statuses.todo, outcomes: ["triage_stopped"], deadlineMs: 15 * 60_000, agent: "triage" },
  plan: { waits: (statuses) => statuses.triaged, outcomes: ["needs_info", "plan_stopped"], deadlineMs: 15 * 60_000, agent: "the planner" },
  // Past the worker's own relaunch with a minute to spare: a launch lost after its claim is retaken after 3 minutes,
  // its watch fires at 4, and the create gets 30 s plus a 60 s late wait (factory-worker launch-watch.ts, handle.ts).
  // scripts/launch-timing.test.mjs holds them apart.
  launch: { waits: (statuses) => statuses.approved, outcomes: ["launch_failed", "approved_without_plan"], deadlineMs: 7 * 60_000, agent: "the worker" },
};

export const HOP_WATCH_HANDLER = "hop_watch";
export const HOP_WATCH_PURPOSE = "hop_watch";
/** The reminder binds to the Jira channel; the handler never opens a session there. */
export const HOP_WATCH_CHANNEL = "jira";
export const UNREAD_RETRY_MS = 5 * 60_000;
/** Status reads that fail in a row before the thread hears that the desk cannot tell. */
export const MAX_UNREAD = 3;
/** The sweep leaves a record with an armed reminder alone for this long past its deadline. */
export const SWEEP_GRACE_MS = 10 * 60_000;

// The plan start check (see the top of this file). A healthy hosted turn
// starts about a second after the guest is up and the marker lands within
// seconds of the Triaged move; 4 minutes covers a cold pod and the
// START_SKEW_MS (2 min) allowance planner-liveness.ts gives the marker.
export const PLAN_START_DEADLINE_MS = 4 * 60_000;
export const PLAN_START_HANDLER = "plan_start";
export const PLAN_START_PURPOSE = "plan_start";
/** The sweep leaves a start check with an armed reminder alone for this long past its due time. */
export const PLAN_START_SWEEP_GRACE_MS = 60_000;
/** A start check that could not read Jira looks again this much later, MAX_UNREAD times, then gives up without retrying blind. */
export const PLAN_START_UNREAD_RETRY_MS = 60_000;
/** How long one automatic re-send stands against another on the same ticket. Longer than any stuck episode (two 4-minute checks and the 15-minute watch), shorter than a next-day replan. */
export const PLAN_START_RETRY_TTL_MS = 2 * 60 * 60_000;
/** The re-send's pending claim: the move takes seconds; a check that dies mid-move lets the next one through after this. */
export const PLAN_START_RETRY_LEASE_MS = 2 * 60_000;

/** How a plan entry's start check ended; set once on the record, so no reminder or sweep runs it twice. */
export type StartCheck = "started" | "retried" | "not_moved" | "final" | "moved_on" | "gated" | "unread" | "duplicate";

export type HopWatch = {
  hop: Hop;
  since: string;
  dueAt: string;
  /** The transition (or filing) that armed it. */
  changelogId: string;
  /** Newest numeric Jira comment id at arm time; an outcome above it is this entry's. */
  baselineCommentId?: string;
  reminderId?: string;
  unread?: number;
  /** Plan hop: when the start check is due (`since` + PLAN_START_DEADLINE_MS; pushed back on an unread Jira). */
  startDueAt?: string;
  startReminderId?: string;
  startUnread?: number;
  startCheck?: StartCheck;
};

/**
 * A manual `retry KEY` inside the deadline goes through once the start check
 * declared this entry not started: its final line, a re-send that failed, or
 * a re-send marked `retried` that is still the record (a bounce that landed
 * arms a new entry over this one within seconds, so one still here died
 * between its mark and its moves; the live-run guard still refuses a run that
 * did start). A fresh successor entry, with no `startCheck` yet, is waited out.
 */
export function startCheckFreesRetry(watch: HopWatch): boolean {
  return watch.hop === "plan" && (watch.startCheck === "final" || watch.startCheck === "not_moved" || watch.startCheck === "retried");
}

/** The re-send died between its mark and its second move: the ticket sits in To Do with the `retried` record still standing. The deadline fire treats it as still waiting. */
function strandedResend(watch: HopWatch, status: string, statuses: StatusNames): boolean {
  return watch.hop === "plan" && watch.startCheck === "retried" && sameStatus(status, statuses.todo);
}

export type HopArgs = { issueKey: string; hop: Hop; changelogId: string };

/** `random` (0 ≤ x < 1) draws the index confirm's jitter; Math.random when unset. */
type HopHost = { kv: KeyedKv; mcp?: HostMcpRegistry; reminders?: ReminderHostApi; random?: () => number };

/** The most jitter added to the index confirm's settle wait. */
export const INDEX_CONFIRM_JITTER_MAX_MS = 500;

/**
 * The index confirm's wait: the claim settle plus up to
 * min(INDEX_CONFIRM_JITTER_MAX_MS, settleMs) of jitter, so two arms that
 * raced on their first add do not confirm at the same instant.
 */
export function indexConfirmDelayMs(input: { settleMs: number; random: () => number }): number {
  return input.settleMs + Math.floor(input.random() * Math.min(INDEX_CONFIRM_JITTER_MAX_MS, input.settleMs));
}

export async function readTriagedSince(kv: KeyedKv, issueKey: string): Promise<Date | undefined> {
  const value = await kv.get(triagedSinceKey(issueKey)).catch((error: unknown) => warnKv("hop-watch.readTriagedSince", error));
  const since = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)["since"] : undefined;
  const at = typeof since === "string" ? new Date(since) : undefined;
  return at === undefined || Number.isNaN(at.getTime()) ? undefined : at;
}

export function hopForOutcome(kind: OutcomeKind): Hop | undefined {
  return (Object.keys(HOPS) as Hop[]).find((hop) => HOPS[hop].outcomes.includes(kind));
}

export type ArmResult =
  | { armed: false; reason: "no_thread" | "already_armed" }
  | { armed: true; reminder: "armed" | "unavailable" | "failed" };

/**
 * Arm the hop a ticket just entered. Only a ticket with a Slack thread has
 * anyone to tell. A redelivery of the same entry is a no-op; a new entry
 * replaces whatever the ticket was waiting on before.
 */
export async function armHopWatch(host: HopHost, input: HopArgs & { at: Date; baselineCommentId?: string }): Promise<ArmResult> {
  const { kv } = host;
  const { issueKey } = input;
  if (parseThreadRef(await kv.get(ticketKey(issueKey))) === undefined) return { armed: false, reason: "no_thread" };
  const previous = parseHopWatch(await kv.get(hopWatchKey(issueKey)));
  if (previous !== undefined && previous.hop === input.hop && previous.changelogId === input.changelogId) {
    // Self-heal: an index entry another writer dropped comes back on the redelivery.
    if (indexMergeOn(process.env)) await addToIndex(host, issueKey);
    return { armed: false, reason: "already_armed" };
  }
  const baseline = input.baselineCommentId ?? (host.mcp === undefined ? undefined : await baselineComment(host.mcp, issueKey));
  const spec = HOPS[input.hop];
  const record: HopWatch = {
    hop: input.hop,
    since: input.at.toISOString(),
    dueAt: new Date(input.at.getTime() + spec.deadlineMs).toISOString(),
    changelogId: input.changelogId,
    ...(baseline === undefined ? {} : { baselineCommentId: baseline }),
    ...(input.hop === "plan" ? { startDueAt: new Date(input.at.getTime() + PLAN_START_DEADLINE_MS).toISOString() } : {}),
  };
  await kv.put(hopWatchKey(issueKey), record);
  if (input.hop === "plan") {
    await kv.put(triagedSinceKey(issueKey), { since: record.since, changelogId: input.changelogId });
    await adoptPlanStartSuccessor(kv, issueKey, input.changelogId);
  }
  // The ticket left the plan path (Triaged → Approved by a drag): the one re-send is spent on nothing.
  if (previous?.hop === "plan" && input.hop !== "plan") await clearPlanStartRetry(kv, issueKey);
  await addToIndex(host, issueKey);
  if (previous?.reminderId !== undefined) await cancelReminder(host.reminders, previous.reminderId, "superseded");
  if (previous?.startReminderId !== undefined) await cancelReminder(host.reminders, previous.startReminderId, "superseded");
  const reminder = await armReminder(host, issueKey, record, spec.deadlineMs, "arm");
  if (input.hop === "plan") await armStartReminder(host, issueKey, record, PLAN_START_DEADLINE_MS, "arm");
  return { armed: true, reminder };
}

type ReminderKind = "deadline" | "start";

/**
 * One named reminder for a record, due in `delayMs`. Logs one
 * `{"desk":"hop_watch","armed":…}` line per outcome, so a hosted deploy
 * shows from its logs whether reminders land.
 */
async function armReminder(host: HopHost, issueKey: string, record: HopWatch, delayMs: number, via: "arm" | "sweep"): Promise<"armed" | "unavailable" | "failed"> {
  return armNamedReminder(host, issueKey, record, delayMs, via, "deadline");
}

/** The plan start check's reminder. Logs `{"desk":"plan_start_watch","via":…,"result":"armed"|…}`. */
async function armStartReminder(host: HopHost, issueKey: string, record: HopWatch, delayMs: number, via: "arm" | "sweep"): Promise<"armed" | "unavailable" | "failed"> {
  return armNamedReminder(host, issueKey, record, delayMs, via, "start");
}

async function armNamedReminder(host: HopHost, issueKey: string, record: HopWatch, delayMs: number, via: "arm" | "sweep", kind: ReminderKind): Promise<"armed" | "unavailable" | "failed"> {
  const line =
    kind === "deadline"
      ? { desk: "hop_watch", via, issueKey, hop: record.hop, changelogId: record.changelogId }
      : { desk: "plan_start_watch", via, issueKey, changelogId: record.changelogId };
  const field = kind === "deadline" ? "reminderId" : "startReminderId";
  const result = (armed: "armed" | "unavailable" | "failed", extra: Record<string, string> = {}) => (kind === "deadline" ? { ...line, armed, ...extra } : { ...line, result: armed, ...extra });
  if (host.reminders === undefined) {
    console.log(JSON.stringify(result("unavailable")));
    return "unavailable";
  }
  try {
    const reminder = await host.reminders.create({
      purpose: kind === "deadline" ? HOP_WATCH_PURPOSE : PLAN_START_PURPOSE,
      channelId: HOP_WATCH_CHANNEL,
      continuationToken: `hop-watch:${issueKey}`,
      target: { issueKey, hop: record.hop },
      delay: `${Math.max(1, Math.round(delayMs / 60_000))}m`,
      handler: kind === "deadline" ? HOP_WATCH_HANDLER : PLAN_START_HANDLER,
      args: { issueKey, hop: record.hop, changelogId: record.changelogId },
    });
    const current = parseHopWatch(await host.kv.get(hopWatchKey(issueKey)));
    if (current !== undefined && current.hop === record.hop && current.changelogId === record.changelogId) {
      await host.kv.put(hopWatchKey(issueKey), { ...current, [field]: reminder.id });
    }
    console.log(JSON.stringify(result("armed", { reminderId: reminder.id })));
    return "armed";
  } catch (error) {
    console.error(JSON.stringify(result("failed", { error: error instanceof Error ? error.message : String(error) })));
    return "failed";
  }
}

/**
 * The hop ended where Jira shows it: the expected move, another move, or an
 * outcome comment. `hop` limits the clear to that hop, so an outcome from
 * an earlier hop never drops the one the ticket is in now. The fire checks
 * Jira again whatever happens here, so a lost clear costs one read. A move
 * past Triaged (no `hop`) or a plan outcome proves the planner ran, or that
 * the ticket left the plan path, so the start check's one re-send is given
 * back whether or not a record is still there. A move into To Do never
 * reaches here (status-event.ts ignores it), which the re-send relies on:
 * its own Triaged → To Do → Triaged bounce must not give the re-send back.
 */
export async function clearHopWatch(host: HopHost, issueKey: string, options: { hop?: Hop } = {}): Promise<boolean> {
  if (options.hop === undefined || options.hop === "plan") await clearPlanStartRetry(host.kv, issueKey);
  const current = parseHopWatch(await host.kv.get(hopWatchKey(issueKey)));
  if (current === undefined) return false;
  if (options.hop !== undefined && current.hop !== options.hop) return false;
  await host.kv.delete(hopWatchKey(issueKey));
  if (current.reminderId !== undefined) await cancelReminder(host.reminders, current.reminderId, "cleared");
  if (current.startReminderId !== undefined) await cancelReminder(host.reminders, current.startReminderId, "cleared");
  return true;
}

export async function readHopWatch(kv: KeyedKv, issueKey: string): Promise<HopWatch | undefined> {
  return parseHopWatch(await kv.get(hopWatchKey(issueKey)));
}

export type HopFireResult = "superseded" | "moved_on" | "gated" | "outcome" | "posted" | "not_posted" | "unread" | "suppressed";

export type HopFire = { issueKey: string; hop: Hop; result: HopFireResult; rescheduleMs?: number };

/**
 * One deadline for one entry: the reminder's fire, or the sweep's. Reads
 * the ticket, decides, and posts at most one line, claimed per entry so the
 * reminder and the sweep never both post it.
 */
export async function fireHopWatch(ctx: AnnounceHost, args: HopArgs): Promise<HopFire> {
  const { issueKey, hop } = args;
  const kv = ctx.host.kv;
  const done = (result: HopFireResult): HopFire => ({ issueKey, hop, result });
  const watch = parseHopWatch(await kv.get(hopWatchKey(issueKey)));
  if (watch === undefined || watch.hop !== hop || watch.changelogId !== args.changelogId) return done("superseded");
  const now = ctx.now();
  const statuses = statusNames(process.env);
  const waits = HOPS[hop].waits(statuses);
  const status = await issueStatus(ctx.host.mcp, issueKey);
  if (status.status !== "read") {
    const unread = (watch.unread ?? 0) + 1;
    if (unread < MAX_UNREAD) {
      await kv.put(hopWatchKey(issueKey), { ...watch, unread, dueAt: new Date(now.getTime() + UNREAD_RETRY_MS).toISOString() });
      return { ...done("unread"), rescheduleMs: UNREAD_RETRY_MS };
    }
    const minutes = minutesSince(watch, now);
    const posted = await postHopLine(ctx, args, (filer) => unreadMessage({ issueKey, hop, minutes, ...filer }));
    await finish(ctx.host, issueKey, watch);
    return done(posted ? "posted" : "not_posted");
  }
  if (!sameStatus(status.name, waits) && !strandedResend(watch, status.name, statuses)) {
    await finish(ctx.host, issueKey, watch);
    return done("moved_on");
  }
  const read = await readCommentRecords(ctx.host.mcp, issueKey).catch(() => undefined);
  const comments = read?.status === "read" ? read.comments : undefined;
  if (hop === "plan" && comments !== undefined && latestTriageVerdict(comments.map((comment) => comment.body))?.gate !== undefined) {
    await finish(ctx.host, issueKey, watch);
    return done("gated");
  }
  const outcome = comments === undefined ? undefined : entryOutcome(comments, issueKey, hop, watch.baselineCommentId, statuses);
  if (outcome !== undefined) {
    // The comment rule never delivered it (or it did, and its claim keeps this quiet).
    await announceOutcome({ issueKey, title: issueKey, kind: outcome.kind, claimId: outcome.id, commentId: outcome.id, body: outcome.body }, ctx);
    await finish(ctx.host, issueKey, watch);
    return done("outcome");
  }
  const minutes = minutesSince(watch, now);
  const implementing = hop === "launch" && comments !== undefined ? latestImplementingComment(comments.map((comment) => comment.body)) : undefined;
  const planning = hop === "plan" ? planHopDetail({ comments, issueKey, statuses, now, since: new Date(watch.since) }) : {};
  // The start check's final line, or its failed re-send, already said this
  // entry never started and offered the retry; a run that started late (live
  // or lost) is still news.
  if ((watch.startCheck === "final" || watch.startCheck === "not_moved") && planning.run?.state === "not_started") {
    await finish(ctx.host, issueKey, watch);
    return done("suppressed");
  }
  const posted = await postHopLine(ctx, args, (filer) =>
    implementing !== undefined ? launchedNotMovedMessage({ issueKey, minutes, url: implementing, ...filer }) : stalledMessage({ issueKey, hop, minutes, ...planning, ...filer })
  );
  await finish(ctx.host, issueKey, watch);
  return done(posted ? "posted" : "not_posted");
}

export type StartCheckResult = StartCheck | "superseded" | "already_checked" | "early" | "kv_unavailable";

export type StartCheckFire = { issueKey: string; changelogId: string; result: StartCheckResult; rescheduleMs?: number; posted?: boolean };

type StartCheckHost = AnnounceHost & { host: AnnounceHost["host"] & { reminders?: ReminderHostApi } };

/**
 * The plan start check for one Triaged entry, PLAN_START_DEADLINE_MS after
 * it: the reminder's fire, or the sweep's. Reads the ticket, and when the
 * planner left no sign of running for this entry (no `Planning started:`
 * since the entry, no plan, no outcome above the baseline, still Triaged,
 * no triage gate), re-sends it to the planner once per stuck episode and
 * says so in one line; the retried entry that does not start either gets
 * the final line and no further move. The outcome is written on the record
 * (`startCheck`), so the reminder and the sweep never run it twice for one
 * entry; the re-send is a lease at `plan-start-retry/<KEY>`, so two pods
 * that both reach it move once; each line is claimed per entry
 * (`announced/<KEY>:plan-start-<step>:<changelog>`), so it posts once. An
 * unreadable Jira is never retried blind: the check looks again a minute
 * later, up to MAX_UNREAD times, then gives up for this entry.
 */
export async function firePlanStartCheck(ctx: StartCheckHost, args: HopArgs): Promise<StartCheckFire> {
  const { issueKey } = args;
  const kv = ctx.host.kv;
  const done = (result: StartCheckResult, extra: { rescheduleMs?: number; posted?: boolean } = {}): StartCheckFire => ({ issueKey, changelogId: args.changelogId, result, ...extra });
  const watch = parseHopWatch(await kv.get(hopWatchKey(issueKey)));
  if (watch === undefined || watch.hop !== "plan" || watch.changelogId !== args.changelogId) return done("superseded");
  if (watch.startCheck !== undefined) return done("already_checked");
  const now = ctx.now();
  // A reminder the sweep armed rounds its delay to whole minutes, so it can fire early; wait out the rest.
  if (watch.startDueAt !== undefined && now.getTime() < Date.parse(watch.startDueAt)) return done("early", { rescheduleMs: Date.parse(watch.startDueAt) - now.getTime() });
  const statuses = statusNames(process.env);
  const mark = (result: StartCheck, from?: StartCheck) => markStartCheck(kv, issueKey, watch, result, from);

  const status = await issueStatus(ctx.host.mcp, issueKey);
  const read = status.status === "read" ? await readCommentRecords(ctx.host.mcp, issueKey).catch(() => undefined) : undefined;
  if (status.status !== "read" || read?.status !== "read") {
    const unread = (watch.startUnread ?? 0) + 1;
    if (unread < MAX_UNREAD) {
      await kv.put(hopWatchKey(issueKey), { ...watch, startUnread: unread, startDueAt: new Date(now.getTime() + PLAN_START_UNREAD_RETRY_MS).toISOString() });
      return done("unread", { rescheduleMs: PLAN_START_UNREAD_RETRY_MS });
    }
    await mark("unread");
    return done("unread");
  }
  if (!sameStatus(status.name, statuses.triaged)) {
    // To Do is the re-send's own intermediate state (Triaged → To Do → Triaged
    // takes seconds): a check that reads it mid-bounce must leave the re-send
    // record, or the bounced entry would be re-sent again. Only a status past
    // the plan path gives the one re-send back.
    if (!sameStatus(status.name, statuses.todo)) await clearPlanStartRetry(kv, issueKey);
    await mark("moved_on");
    return done("moved_on");
  }
  const comments = read.comments;
  if (latestTriageVerdict(comments.map((comment) => comment.body))?.gate !== undefined) {
    await clearPlanStartRetry(kv, issueKey);
    await mark("gated");
    return done("gated");
  }
  if (plannerRanFor({ comments, issueKey, statuses, now, watch })) {
    await clearPlanStartRetry(kv, issueKey);
    await mark("started");
    return done("started");
  }

  // Not started. One re-send per stuck episode: a standing record from
  // another entry means this one is the retried entry (or a later one inside
  // the TTL) and gets the final line; one from this very entry is this
  // check's own re-send seen again (a second fire inside its window), never a
  // final line for the entry that was just re-sent.
  const retryKey = planStartRetryKey(issueKey);
  const standing = await readPlanStartRetry(kv, retryKey, now, args.changelogId);
  if (standing?.state === "pending") return done("duplicate");
  if (standing?.state === "done") {
    if (standing.changelogId === args.changelogId) return done("duplicate");
    // The entry the re-send produced: named on the record when it was armed,
    // or, when that write was lost, the entry whose Triaged time is within
    // the clock skew of the move (a person's retry comes minutes later).
    const direct = standing.successor === args.changelogId || (standing.successor === undefined && standing.movedAt !== undefined && Math.abs(Date.parse(watch.since) - Date.parse(standing.movedAt)) <= START_SKEW_MS);
    const posted = await postStartLine(ctx, args, "final", (filer) => planStartFinalMessage({ issueKey, afterAutoRetry: direct, ...filer }), { reaction: "stopped", clearCrumb: true });
    await mark("final");
    return done("final", { posted });
  }
  const owner = randomUUID();
  const taken = await takeLease(kv, retryKey, { owner, leaseMs: PLAN_START_RETRY_LEASE_MS, now, fields: { changelogId: args.changelogId, since: watch.since }, settleMs: claimSettleMs() });
  if (taken.status === "held") return done("duplicate");
  if (taken.status === "done") {
    // Landed between the read and the take: another pod's re-send.
    await mark("duplicate");
    return done("duplicate");
  }
  if (taken.status === "unavailable") {
    await releaseLease(kv, retryKey, owner);
    return done("kv_unavailable");
  }
  // The record is marked before the move, so a concurrent fire for this entry stops at already_checked.
  await mark("retried");
  const minutes = minutesSince(watch, now);
  let posted = false;
  const moved = await redeliverToPlanner({
    mcp: ctx.host.mcp,
    kv,
    getClient: () => ctx.host.slack.getClient(),
    issueKey,
    current: status.name,
    statuses,
    now,
    said: async () => {
      // The claim goes done before the line, so a check that dies here never moves twice.
      const finished = await finishLease(kv, retryKey, owner, { fields: { outcome: "retried", movedAt: ctx.now().toISOString() } });
      if (finished.status !== "finished") warnKv("hop-watch.firePlanStartCheck.finishLease", new Error(`the re-send claim for ${issueKey} was not marked done: ${finished.status}`));
      posted = await postStartLine(ctx, args, "alert", (filer) => planStartRetriedMessage({ issueKey, minutes, ...filer }), { reaction: "planning", clearCrumb: false });
    },
  });
  if (!moved.requested) {
    // A failed re-send blocks nothing: the next Triaged entry gets its own.
    await releaseLease(kv, retryKey, owner);
    const reason = `${moved.reason}${moved.current === undefined ? "" : `, it is ${moved.current}`}`;
    posted = await postStartLine(ctx, args, "alert", (filer) => planStartNotMovedMessage({ issueKey, minutes, reason, ...filer }), { reaction: "stopped", clearCrumb: true });
    await mark("not_moved", "retried");
    return done("not_moved", { posted });
  }
  return done("retried", { posted });
}

/** The planner ran for this entry: its marker since the entry, a plan, or a plan outcome above the arm-time baseline. */
function plannerRanFor(input: { comments: readonly CommentRecord[]; issueKey: string; statuses: StatusNames; now: Date; watch: HopWatch }): boolean {
  const { comments, issueKey, statuses, watch } = input;
  if (planningRun({ comments, issueKey, statuses, now: input.now, since: new Date(watch.since) }).state !== "not_started") return true;
  if (entryOutcome(comments, issueKey, "plan", watch.baselineCommentId, statuses) !== undefined) return true;
  const plan = latestPlanComment(comments, issueKey);
  return plan?.id !== undefined && watch.baselineCommentId !== undefined && newerThan(plan.id, watch.baselineCommentId);
}

/** Writes `result` on this entry's record while its `startCheck` is `from` (unset by default), so a check's outcome is set once and only replaced by the check that set it. */
async function markStartCheck(kv: KeyedKv, issueKey: string, watch: HopWatch, result: StartCheck, from?: StartCheck): Promise<void> {
  const current = parseHopWatch(await kv.get(hopWatchKey(issueKey)));
  if (current !== undefined && current.hop === watch.hop && current.changelogId === watch.changelogId && current.startCheck === from) {
    await kv.put(hopWatchKey(issueKey), { ...current, startCheck: result });
  }
}

type PlanStartRetry = { state: "pending" } | { state: "done"; at: string; changelogId?: string; successor?: string; movedAt?: string };

/**
 * The standing re-send record for `changelogId`'s check: a live pending
 * claim, a done record inside PLAN_START_RETRY_TTL_MS, or nothing. A record
 * past the TTL is an old episode's and is dropped (verified, only that
 * value), so it cannot suppress a re-send days later. An expired pending
 * claim from another entry counts as done: a newer entry proves that move
 * landed even though its finish write did not, so the entry is not re-sent
 * again. One from this entry is left for takeLease to take over.
 */
async function readPlanStartRetry(kv: KeyedKv, key: KvKey, now: Date, changelogId: string): Promise<PlanStartRetry | undefined> {
  let value: JsonValue | undefined;
  try {
    value = await kv.get(key);
  } catch (error) {
    warnKv("hop-watch.readPlanStartRetry", error);
    return undefined;
  }
  if (value === undefined) return undefined;
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const recorded = typeof record["changelogId"] === "string" ? record["changelogId"] : undefined;
  const pending = pendingLease(value);
  if (pending !== undefined && !leaseExpired(pending, PLAN_START_RETRY_LEASE_MS, now)) return { state: "pending" };
  if (pending !== undefined && (recorded === undefined || recorded === changelogId)) return undefined;
  const at = typeof record["at"] === "string" ? record["at"] : undefined;
  const age = at === undefined ? Number.NaN : now.getTime() - Date.parse(at);
  if (!Number.isFinite(age) || age >= PLAN_START_RETRY_TTL_MS) {
    await deleteVerified(kv, key, (current) => sameJson(current, value)).catch((error: unknown) => warnKv("hop-watch.readPlanStartRetry.expire", error));
    return undefined;
  }
  return {
    state: "done",
    at: at!,
    ...(recorded === undefined ? {} : { changelogId: recorded }),
    ...(typeof record["successor"] === "string" ? { successor: record["successor"] } : {}),
    ...(typeof record["movedAt"] === "string" ? { movedAt: record["movedAt"] } : {}),
  };
}

/**
 * The first plan entry armed after a re-send is the entry that re-send
 * produced (the bounce's Triaged webhook). It is named on the record once, so
 * its final line can say "after one automatic retry", and a later entry's
 * (a person's `retry`, a drag) cannot.
 */
async function adoptPlanStartSuccessor(kv: KeyedKv, issueKey: string, changelogId: string): Promise<void> {
  // Only a done record: a claim still pending is finished by its owner's
  // read-modify-write, and a blind write beside it could undo that.
  const result = await updateVerified(kv, planStartRetryKey(issueKey), (current) => {
    if (current === null || typeof current !== "object" || Array.isArray(current) || pendingLease(current) !== undefined) return undefined;
    if (current["changelogId"] === changelogId || current["successor"] !== undefined) return undefined;
    return { ...current, successor: changelogId };
  });
  if (result.status === "unavailable") warnKv("hop-watch.adoptPlanStartSuccessor", new Error(`the re-send record for ${issueKey} could not name its successor`));
}

async function clearPlanStartRetry(kv: KeyedKv, issueKey: string): Promise<void> {
  await kv.delete(planStartRetryKey(issueKey)).catch((error: unknown) => warnKv("hop-watch.clearPlanStartRetry", error));
}

/** The sweep's share of the start check: a due check whose reminder is missing or late fires; one not yet due with no reminder gets one. */
async function sweepStartCheck(ctx: StartCheckHost, issueKey: string, watch: HopWatch, now: Date): Promise<StartCheckResult | undefined> {
  if (watch.hop !== "plan" || watch.startDueAt === undefined || watch.startCheck !== undefined) return undefined;
  const due = Date.parse(watch.startDueAt) + (watch.startReminderId === undefined ? 0 : PLAN_START_SWEEP_GRACE_MS);
  if (now.getTime() < due) {
    if (watch.startReminderId === undefined && ctx.host.reminders !== undefined) await armStartReminder(ctx.host, issueKey, watch, due - now.getTime(), "sweep");
    return undefined;
  }
  const fired = await firePlanStartCheck(ctx, { issueKey, hop: "plan", changelogId: watch.changelogId });
  console.log(JSON.stringify({ desk: "plan_start_watch", via: "sweep", ...fired }));
  return fired.result;
}

type SweepHost = StartCheckHost;

/**
 * Filled in by a sweep as it goes, so a sweep that throws part-way still
 * reports what it did: `due` counts records past their deadline (plus
 * `SWEEP_GRACE_MS` when a reminder was armed) before each fire (a fire that
 * throws still counts), `fired` the fires that returned.
 */
export type SweepTally = { due: number; fired: number };

/**
 * The backstop: every record past its deadline whose reminder is missing or
 * late fires; one still inside its deadline with no reminder (its arm
 * failed) gets one armed for the time left.
 */
export async function sweepHopWatches(ctx: SweepHost, tally: SweepTally = { due: 0, fired: 0 }): Promise<HopFire[]> {
  const kv = ctx.host.kv;
  const now = ctx.now();
  const index = await readIndex(kv);
  const fires: HopFire[] = [];
  const keep: string[] = [];
  for (const issueKey of index) {
    try {
      const watch = parseHopWatch(await kv.get(hopWatchKey(issueKey)));
      if (watch === undefined) continue;
      if ((await sweepStartCheck(ctx, issueKey, watch, now)) === "retried") {
        // Both overdue in one pass (no timer ran for 11 minutes): the re-send's
        // Triaged entry supersedes this record in seconds; its deadline line
        // would only repeat the alert.
        keep.push(issueKey);
        continue;
      }
      const due = Date.parse(watch.dueAt) + (watch.reminderId === undefined ? 0 : SWEEP_GRACE_MS);
      if (now.getTime() < due) {
        keep.push(issueKey);
        if (watch.reminderId === undefined && ctx.host.reminders !== undefined) {
          await armReminder(ctx.host, issueKey, watch, due - now.getTime(), "sweep");
        }
        continue;
      }
      tally.due += 1;
      const fire = await fireHopWatch(ctx, { issueKey, hop: watch.hop, changelogId: watch.changelogId });
      tally.fired += 1;
      fires.push(fire);
      if (fire.rescheduleMs !== undefined) keep.push(issueKey);
    } catch (error) {
      keep.push(issueKey);
      console.error(`[factory-desk] hop-watch sweep for ${issueKey} failed:`, error);
    }
  }
  if (keep.length !== index.length) {
    if (indexMergeOn(process.env)) {
      // Only keys whose record is verified gone leave, and they leave the list
      // as stored at the write. A key re-armed after its check found the list
      // still holding it, so the arm wrote nothing; an arm writes its record
      // before it adds, so re-reading the record after the prune finds it.
      const gone = new Set<string>();
      for (const key of index) {
        if (!keep.includes(key) && (await kv.get(hopWatchKey(key))) === undefined) gone.add(key);
      }
      if (gone.size > 0) {
        await pruneIndexEntries(kv, HOP_WATCH_INDEX, { gone });
        for (const key of gone) {
          if ((await kv.get(hopWatchKey(key))) !== undefined) await addIndexEntry(kv, HOP_WATCH_INDEX, { entry: key, attempts: 3 });
        }
      }
    } else {
      // A ticket armed while this pass ran has a record again and stays.
      const next: string[] = [];
      for (const key of await readIndex(kv)) {
        if (keep.includes(key) || !index.includes(key) || (await kv.get(hopWatchKey(key))) !== undefined) next.push(key);
      }
      await kv.put(HOP_WATCH_INDEX, next);
    }
  }
  return fires;
}

export type ScheduleRunLine = { desk: "hop_watch"; via: "schedule"; due: number; fired: number; fires?: HopFire[]; error?: string };

/**
 * One hop-watch schedule run: the sweep, then exactly one log line even when
 * nothing is due, so deploy logs show whether the schedule fires at all.
 * `due` counts records past their deadline (plus `SWEEP_GRACE_MS` when a
 * reminder was armed), `fired` the fires that ran to a
 * result (`fires` lists them, left out when there are none). A sweep that
 * throws still logs its line, with `error` and the fires that ran before it
 * threw (the index prune runs after every fire), then rethrows.
 */
export async function runHopWatchSchedule(
  ctx: SweepHost,
  options: { sweep?: (ctx: SweepHost, tally: SweepTally) => Promise<HopFire[]>; log?: (line: string) => void } = {}
): Promise<ScheduleRunLine> {
  const tally: SweepTally = { due: 0, fired: 0 };
  const log = options.log ?? ((line: string) => console.log(line));
  try {
    const fires = await (options.sweep ?? sweepHopWatches)(ctx, tally);
    const line: ScheduleRunLine = { desk: "hop_watch", via: "schedule", due: tally.due, fired: tally.fired, ...(fires.length > 0 ? { fires } : {}) };
    log(JSON.stringify(line));
    return line;
  } catch (error) {
    const line: ScheduleRunLine = { desk: "hop_watch", via: "schedule", due: tally.due, fired: tally.fired, error: error instanceof Error ? error.message : String(error) };
    log(JSON.stringify(line));
    throw error;
  }
}

export const BACKSTOP_SWEEP_EVERY_MS = 5 * 60_000;
export const BACKSTOP_SWEEP_TIMEOUT_MS = 20_000;
const BACKSTOP_SWEEP_HOLD_SLACK_MS = 10_000;

export type BackstopResult = { swept: false; why: "idle" | "throttled" | "unavailable" | "timeout" | "threw" } | { swept: true; fires: HopFire[] };

/**
 * The sweep, run from inside a request the desk already handles (a Jira
 * webhook, a Slack message or reaction), beside the hop-watch schedule (a
 * 5-minute `run` schedule on hosted v2 since July 0.2.13): a record whose
 * reminder never armed or never fired gets its line from whichever sweep
 * reaches it first, once, under its claim.
 * About once per `BACKSTOP_SWEEP_EVERY_MS` per deployment: the lease on
 * `hop-watch/last-sweep` holds for the cap plus slack while a sweep
 * runs, and is marked `finished` (holding the full window from its start)
 * when the sweep ends or the cap is hit. The cap (`timeoutMs`) covers the
 * whole backstop, index read and lease take included, so a sweep frozen mid-way locks the
 * next admission out for seconds, not minutes. Hosted kv has no
 * compare-and-set, so two pods can both take the lease; that costs a
 * second sweep, not a second line, since each fire posts under its own
 * `announced/…:hop-…` claim. Never throws. The Jira route passes it to
 * `waitUntil`; Slack's handler context has none, so there a sweep still
 * running when the handler returns may be frozen mid-way, which leaves at
 * most a pending claim to expire and the rest for the next sweep.
 */
export async function backstopSweep(
  ctx: SweepHost,
  options: { owner?: string; everyMs?: number; timeoutMs?: number; sweep?: (ctx: SweepHost) => Promise<HopFire[]> } = {}
): Promise<BackstopResult> {
  const lease: BackstopLease = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? BACKSTOP_SWEEP_TIMEOUT_MS);
  });
  const run = runBackstop(ctx, options, lease).catch((error: unknown): BackstopResult => {
    console.error(JSON.stringify({ desk: "hop_watch", via: "backstop", swept: false, why: "threw", error: error instanceof Error ? error.message : String(error) }));
    return { swept: false, why: "threw" };
  });
  const result = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
  if (result === "timeout") {
    // The cap covers every kv and Jira call. A lease this run took is marked
    // finished without waiting, so a hung Jira read is not retried at once.
    if (lease.taken !== undefined) void finishBackstop(ctx.host.kv, lease.taken);
    console.error(JSON.stringify({ desk: "hop_watch", via: "backstop", swept: false, why: "timeout" }));
    return { swept: false, why: "timeout" };
  }
  if (result.swept && result.fires.length > 0) console.log(JSON.stringify({ desk: "hop_watch", via: "backstop", fires: result.fires }));
  return result;
}

type BackstopLease = { taken?: { owner: string; at: string } };

// Only while the lease is still this sweep's: a capped sweep that ends late
// must not overwrite a newer sweep's lease.
async function finishBackstop(kv: KeyedKv, taken: { owner: string; at: string }): Promise<void> {
  await finishLease(kv, BACKSTOP_SWEEP_KEY, taken.owner, { value: { state: "pending", ...taken, finished: true } }).catch((error: unknown) => warnKv("hop-watch.finishBackstop", error));
}

async function runBackstop(
  ctx: SweepHost,
  options: { owner?: string; everyMs?: number; timeoutMs?: number; sweep?: (ctx: SweepHost) => Promise<HopFire[]> },
  lease: BackstopLease
): Promise<BackstopResult> {
  const kv = ctx.host.kv;
  if ((await readIndex(kv)).length === 0) return { swept: false, why: "idle" };
  // A sweep that finished (or timed out) holds the window; one frozen
  // mid-way, as a Slack admission's can be, holds only past its own cap.
  const last = (await kv.get(BACKSTOP_SWEEP_KEY)) as Record<string, unknown> | undefined;
  const holdMs = (options.timeoutMs ?? BACKSTOP_SWEEP_TIMEOUT_MS) + BACKSTOP_SWEEP_HOLD_SLACK_MS;
  const lastHoldMs = typeof last?.["holdMs"] === "number" ? last["holdMs"] : holdMs;
  const owner = options.owner ?? randomUUID();
  const started = ctx.now();
  const taken = await takeLease(kv, BACKSTOP_SWEEP_KEY, {
    owner,
    leaseMs: last?.["finished"] === true ? (options.everyMs ?? BACKSTOP_SWEEP_EVERY_MS) : lastHoldMs,
    now: started,
    fields: { holdMs },
  });
  if (taken.status === "unavailable") return { swept: false, why: "unavailable" };
  if (taken.status !== "taken") return { swept: false, why: "throttled" };
  lease.taken = { owner, at: started.toISOString() };
  const fires = await (options.sweep ?? sweepHopWatches)(ctx);
  await finishBackstop(kv, lease.taken);
  return { swept: true, fires };
}

export function parseHopArgs(value: JsonObject | Record<string, unknown>): HopArgs | undefined {
  const issueKey = value["issueKey"];
  const hop = value["hop"];
  const changelogId = value["changelogId"];
  if (typeof issueKey !== "string" || !/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) return undefined;
  if (typeof hop !== "string" || !(hop in HOPS) || typeof changelogId !== "string" || changelogId === "") return undefined;
  return { issueKey, hop: hop as Hop, changelogId };
}

/**
 * `originatorUserId` is the Slack filer; without one (a ticket filed in Jira) the desk refuses `retry KEY`, so the line names the board move instead.
 * `run` and `work` are the plan hop's: the planner's liveness marker (unread comments leave `run` out) and the ticket's type.
 */
type StalledInput = { issueKey: string; hop: Hop; minutes: number; prefix: string; originatorUserId?: string; run?: PlanningRun; work?: PlanningWork };

export type PlanningWork = "bug" | "feature" | "task";

/** What the planner is doing for this ticket, from the governing verdict's Jira type, else its kind. */
export function planningWork(verdict: TriageVerdict | undefined): PlanningWork | undefined {
  if (verdict === undefined) return undefined;
  const type = verdict.issueType?.trim().toLowerCase();
  if (type === "bug") return "bug";
  if (type === "story" || type === "feature" || type === "improvement" || type === "new feature") return "feature";
  if (type === "task" || type === "sub-task" || type === "subtask") return "task";
  if (verdict.kind === "bug") return "bug";
  if (verdict.kind === "feedback") return "feature";
  return undefined;
}

function planHopDetail(input: { comments: readonly CommentRecord[] | undefined; issueKey: string; statuses: StatusNames; now: Date; since: Date }): { run?: PlanningRun; work?: PlanningWork } {
  if (input.comments === undefined) return {};
  const work = planningWork(latestTriageVerdict(input.comments.map((comment) => comment.body)));
  const run = planningRun({ comments: input.comments, issueKey: input.issueKey, statuses: input.statuses, now: input.now, since: input.since });
  return { run, ...(work === undefined ? {} : { work }) };
}

function workSentence(work: PlanningWork | undefined): string {
  switch (work) {
    case "bug":
      return "Confirming a bug in the code and planning its fix can take a while.";
    case "feature":
      return "Planning a new feature against the code it joins can take a while.";
    case "task":
      return "Planning a change against the code it touches can take a while.";
    default:
      return "Planning against the code can take a while.";
  }
}

function planStalledMessage(input: StalledInput, step: string): string {
  const { issueKey, minutes, run } = input;
  const head = `${issueKey} still has no plan ${minutes} minutes after it went to the planner`;
  switch (run?.state) {
    case "live":
      return [
        `${head}, but the planner is still running (${run.minutes} min).`,
        `${workSentence(input.work)} A plan, a Needs info, or a Plan stopped line lands here when it finishes. If nothing lands in about ${run.liveForMinutes} minutes, ${step} to start a fresh run.`,
      ].join("\n");
    case "not_started":
      return [`${head}.`, `The planner never reported starting a run for it: the wake may have been lost. ${sentence(step)} to start one.`].join("\n");
    case "lost":
      return [`${head}.`, `The planner started a run ${run.minutes} minutes ago that never finished, so it was probably lost. ${sentence(step)} to start a fresh run.`].join("\n");
    default:
      return [
        `${head}.`,
        `The desk cannot tell whether the planner is still working. A plan, a Needs info, or a Plan stopped line lands here when it finishes. If nothing comes, ${step} to start a fresh run.`,
      ].join("\n");
  }
}

/**
 * How this thread redelivers the hop: the filer's `retry KEY`, or the Jira
 * move that retry makes (retry-command.ts) where no one filed it from Slack.
 */
export function redeliverStep(input: { issueKey: string; hop: Hop; prefix: string; originatorUserId?: string }): string {
  const { issueKey } = input;
  if (input.originatorUserId !== undefined) return `say \`${input.prefix}retry ${issueKey}\` here`;
  switch (input.hop) {
    case "triage":
      return `move ${issueKey} to Triaged in Jira`;
    case "plan":
      return `move ${issueKey} to To Do and back to Triaged in Jira`;
    case "launch":
      return `move ${issueKey} to Planned and back to Approved in Jira`;
  }
}

function sentence(step: string): string {
  return `${step.charAt(0).toUpperCase()}${step.slice(1)}`;
}

export function stalledMessage(input: StalledInput): string {
  const { issueKey, minutes } = input;
  const step = redeliverStep(input);
  switch (input.hop) {
    case "triage":
      return [
        `${issueKey} has not been triaged ${minutes} minutes after it was filed.`,
        `Triage never left a verdict or a Triage stopped line: its Jira rule may be off, or its run was lost. ${sentence(step)} to send it to the planner without a triage verdict.`,
      ].join("\n");
    case "plan":
      return planStalledMessage(input, step);
    case "launch":
      return [
        `${issueKey} was approved ${minutes} minutes ago, but no implementation has started.`,
        `The worker recorded no launch and no failure, and its own relaunch has not landed: its Jira rule may be off, the approval never reached it, or its connector or store is still down. ${sentence(step)} to send the approval to the worker again. The worker usually reuses an agent that already started, but cannot guarantee it.`,
      ].join("\n");
  }
}

export function launchedNotMovedMessage(input: Omit<StalledInput, "hop"> & { url: string }): string {
  return [
    `${input.issueKey} is still Approved ${input.minutes} minutes after the approval, though implementation started: ${input.url}`,
    `The worker's move to In Progress did not land. ${sentence(redeliverStep({ ...input, hop: "launch" }))} to send the approval again; the worker moves the ticket and links the agent it already started.`,
  ].join("\n");
}

export function unreadMessage(input: StalledInput): string {
  return [
    `The desk could not read ${input.issueKey} from Jira for ${input.minutes} minutes, so it cannot tell whether ${HOPS[input.hop].agent} finished.`,
    `Check the ticket in Jira. If it has not moved, ${redeliverStep(input)}.`,
  ].join("\n");
}

// The plan start check's lines (two short lines each; the current step only,
// no session or platform detail). `retry KEY` where a filer can say it, the
// board move in a Jira-filed ticket's thread (`redeliverStep`).
type StartLineInput = { issueKey: string; prefix: string; originatorUserId?: string };

export function planStartRetriedMessage(input: StartLineInput & { minutes: number }): string {
  return [`${input.issueKey}'s planning hasn't started ${input.minutes} minutes after it went to the planner, so I've sent it to the planner again.`, "If this run doesn't start either, I'll say so here."].join("\n");
}

export function planStartNotMovedMessage(input: StartLineInput & { minutes: number; reason: string }): string {
  const step = redeliverStep({ ...input, hop: "plan" });
  return [
    `${input.issueKey}'s planning hasn't started ${input.minutes} minutes after it went to the planner, and I could not send it to the planner again (${input.reason}).`,
    `${sentence(step)} to try again.`,
  ].join("\n");
}

/** `afterAutoRetry`: this entry is the one the desk's re-send produced; a later entry (a person's retry, a drag) names no retry it did not get. */
export function planStartFinalMessage(input: StartLineInput & { afterAutoRetry: boolean }): string {
  const step = redeliverStep({ ...input, hop: "plan" });
  const head = input.afterAutoRetry ? `${input.issueKey}'s planning still hasn't started after one automatic retry, so planning couldn't start.` : `${input.issueKey}'s planning still hasn't started, so planning couldn't start.`;
  return [head, `The next step is a planner redeploy or asking ops; ${step} to try again.`].join("\n");
}

/**
 * The line is built from the binding it lands under, so a Jira-filed thread
 * (no Slack filer) hears the board move. The root takes ⚠️: the crumb comes
 * down here, and the stage reaction left on the root (👀, ⏳, 🛠️) would
 * still say the hop is running while the thread says it went quiet.
 */
async function postHopLine(ctx: AnnounceHost, args: HopArgs, text: (filer: { originatorUserId?: string; prefix: string }) => string): Promise<boolean> {
  return postClaimedLine(ctx, { claimKey: hopWatchClaimKey(args), changelogId: args.changelogId, issueKey: args.issueKey, status: HOPS[args.hop].waits(statusNames(process.env)), record: { hop: args.hop }, reaction: "stopped", clearCrumb: true }, text);
}

/** A start-check line, claimed per entry and step. The re-sent alert keeps ⏳ and the crumb up: planning is running again. */
async function postStartLine(
  ctx: AnnounceHost,
  args: HopArgs,
  step: "alert" | "final",
  text: (filer: { originatorUserId?: string; prefix: string }) => string,
  options: { reaction: StatusStage; clearCrumb: boolean }
): Promise<boolean> {
  return postClaimedLine(
    ctx,
    { claimKey: planStartClaimKey({ issueKey: args.issueKey, step, changelogId: args.changelogId }), changelogId: args.changelogId, issueKey: args.issueKey, status: HOPS.plan.waits(statusNames(process.env)), record: { hop: "plan", step }, ...options },
    text
  );
}

async function postClaimedLine(
  ctx: AnnounceHost,
  input: { claimKey: KvKey; changelogId: string; issueKey: string; status: string; record: Record<string, string>; reaction: StatusStage; clearCrumb: boolean },
  text: (filer: { originatorUserId?: string; prefix: string }) => string
): Promise<boolean> {
  const posted = await announceTicketUpdate(ctx, {
    changelogId: input.changelogId,
    claimKey: input.claimKey,
    update: {
      issueKey: input.issueKey,
      title: input.issueKey,
      status: input.status,
      text: "",
      render: (bound) => ({ text: text({ ...(bound?.originatorUserId === undefined ? {} : { originatorUserId: bound.originatorUserId }), prefix: replyPrefix(bound?.channelId) }) }),
      threadOnly: true,
    },
    record: input.record,
    reaction: input.reaction,
  });
  if (posted.posted && input.clearCrumb) {
    try {
      await clearLoader({ kv: ctx.host.kv, client: await ctx.host.slack.getClient(), issueKey: input.issueKey });
    } catch {
      // The line landed; a leftover crumb is cleared by the next announce.
    }
  }
  return posted.posted;
}

/** The newest outcome comment of this hop's kinds above the arm-time baseline. No baseline, no outcome: an old one must not be replayed. */
function entryOutcome(
  comments: readonly CommentRecord[],
  issueKey: string,
  hop: Hop,
  baseline: string | undefined,
  statuses: StatusNames
): { kind: OutcomeKind; id: string; body: string } | undefined {
  if (baseline === undefined) return undefined;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]!;
    const kind = outcomeKind(comment.body, issueKey, statuses);
    if (kind === undefined || !HOPS[hop].outcomes.includes(kind)) continue;
    if (comment.id === undefined || !newerThan(comment.id, baseline)) return undefined;
    return { kind, id: comment.id, body: comment.body };
  }
  return undefined;
}

async function baselineComment(mcp: HostMcpRegistry, issueKey: string): Promise<string | undefined> {
  try {
    const read = await readCommentRecords(mcp, issueKey);
    if (read.status !== "read") return undefined;
    let max = 0n;
    for (const comment of read.comments) {
      if (comment.id === undefined) {
        // Without ids no later comment can be told apart from this one.
        return undefined;
      }
      if (/^\d+$/.test(comment.id) && BigInt(comment.id) > max) max = BigInt(comment.id);
    }
    return max.toString();
  } catch {
    return undefined;
  }
}

function newerThan(id: string, baseline: string): boolean {
  return /^\d+$/.test(id) && /^\d+$/.test(baseline) && BigInt(id) > BigInt(baseline);
}

async function finish(host: HopHost, issueKey: string, watch: HopWatch): Promise<void> {
  const current = parseHopWatch(await host.kv.get(hopWatchKey(issueKey)));
  if (current !== undefined && current.hop === watch.hop && current.changelogId === watch.changelogId) await host.kv.delete(hopWatchKey(issueKey));
}

async function cancelReminder(reminders: ReminderHostApi | undefined, id: string, reason: string): Promise<void> {
  if (reminders === undefined) return;
  try {
    await reminders.cancel(id, reason);
  } catch {
    // A live reminder for a replaced record finds it stale and stops.
  }
}

function minutesSince(watch: HopWatch, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(watch.since)) / 60_000));
}

function sameStatus(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * List `issueKey` in `hop-watch/index`: a verified union (kv-index.ts), then
 * after the claim settle plus jitter one confirm that re-adds it if a
 * concurrent writer dropped it. A settle of 0 skips the wait and the
 * confirm. `FACTORY_INDEX_MERGE=off` is the plain read-then-put.
 */
async function addToIndex(host: HopHost, issueKey: string): Promise<IndexAdd | undefined> {
  const { kv } = host;
  if (!indexMergeOn(process.env)) {
    const index = await readIndex(kv);
    if (!index.includes(issueKey)) await kv.put(HOP_WATCH_INDEX, [...index, issueKey]);
    return undefined;
  }
  const first = await addIndexEntry(kv, HOP_WATCH_INDEX, { entry: issueKey, attempts: 2 });
  const settleMs = claimSettleMs();
  if (settleMs <= 0) return first;
  const delayMs = indexConfirmDelayMs({ settleMs, random: host.random ?? Math.random });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const confirmed = await addIndexEntry(kv, HOP_WATCH_INDEX, { entry: issueKey, attempts: 1 });
  return confirmed === "unavailable" ? first : confirmed;
}

async function readIndex(kv: KeyedKv): Promise<string[]> {
  return indexList(await kv.get(HOP_WATCH_INDEX));
}

function parseHopWatch(value: unknown): HopWatch | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { hop, since, dueAt, changelogId, baselineCommentId, reminderId, unread, startDueAt, startReminderId, startUnread, startCheck } = record;
  if (typeof hop !== "string" || !(hop in HOPS)) return undefined;
  if (typeof since !== "string" || Number.isNaN(Date.parse(since)) || typeof dueAt !== "string" || Number.isNaN(Date.parse(dueAt))) return undefined;
  if (typeof changelogId !== "string") return undefined;
  return {
    hop: hop as Hop,
    since,
    dueAt,
    changelogId,
    ...(typeof baselineCommentId === "string" ? { baselineCommentId } : {}),
    ...(typeof reminderId === "string" ? { reminderId } : {}),
    ...(typeof unread === "number" && Number.isFinite(unread) ? { unread } : {}),
    ...(typeof startDueAt === "string" && !Number.isNaN(Date.parse(startDueAt)) ? { startDueAt } : {}),
    ...(typeof startReminderId === "string" ? { startReminderId } : {}),
    ...(typeof startUnread === "number" && Number.isFinite(startUnread) ? { startUnread } : {}),
    ...(typeof startCheck === "string" && START_CHECKS.has(startCheck) ? { startCheck: startCheck as StartCheck } : {}),
  };
}

const START_CHECKS: ReadonlySet<string> = new Set<StartCheck>(["started", "retried", "not_moved", "final", "moved_on", "gated", "unread", "duplicate"]);

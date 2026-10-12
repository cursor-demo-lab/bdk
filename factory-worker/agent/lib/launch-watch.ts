import type { ReminderHostApi } from "@cursor/july";
import { LAUNCH_GRACE_MS } from "./claim.js";
import { updateVerified } from "./kv-verified.js";
import { addIndexEntry, indexList, indexMergeOn, pruneIndexEntries } from "./kv-index.js";
import { LAUNCH_WATCH_INDEX, launchWatchKey, type KeyedKv } from "./kv-keys.js";
import { warnKv, warnStep } from "./ops-funnel.js";

export { LAUNCH_WATCH_INDEX, launchWatchKey };

// The launch watch: an approval the worker owes a recorded launch for. The
// Jira route opens it before it claims `implement/<KEY>` (and when it cannot
// read the ticket's comments), and closes it once the launch is recorded
// with its Implementing: comment and move, or a failure, a missing plan, or a
// ticket that left Approved is. A watch still open after LAUNCH_GRACE_MS is
// a launch that was lost after the claim (TLSSN-51: a pod parked or a stalled
// create left a pending claim and no record), or one that never got a claim.
// launch-heal.ts then replays the approval through the same pipeline.
//
// Two wakes find it: a reminder armed by the delivery (first fire
// LAUNCH_HEAL_FIRST_MS after the approval, then every LAUNCH_HEAL_RETRY_MS),
// and the backstop sweep (implement-pr-sweep.ts), which walks
// `implement-launch/index` from the worker's other deliveries and reminder
// fires. Index writes are kv-index.ts's verified merge, as for the implement
// PR watch; a key whose record is gone is pruned by the sweep.

export const LAUNCH_HEAL_HANDLER = "implement_launch";
/** The reminder's first fire: past the claim's grace, so a pending claim still there by then is lost. */
export const LAUNCH_HEAL_FIRST_MS = LAUNCH_GRACE_MS + 60_000;
export const LAUNCH_HEAL_RETRY_MS = 2 * 60_000;
/** Relaunch attempts before the watch gives up with a `Launch failed:` comment. */
export const LAUNCH_HEAL_MAX_ATTEMPTS = 3;
/** The heal stops rescheduling this long after the approval, counted from the reminder's own args, even when kv cannot hold its attempts. */
export const LAUNCH_HEAL_MAX_AGE_MS = 30 * 60_000;
/** `host.reminders.create` is a network call made before the launch; it must not hold the launch up. */
export const LAUNCH_REMINDER_TIMEOUT_MS = 5_000;

/**
 * `last` and `detail`: the latest heal's outcome and its reason code (for
 * `agent_unverified`, why the agent check failed). `dueAt`: when the
 * reminder `reminderId` is next due, recorded on each create and reschedule;
 * a reminder well past it is lost (launch-heal.ts `tendLaunchWatches`).
 */
export type LaunchWatch = { at: string; changelogId: string; title: string; attempts: number; reminderId?: string; dueAt?: string; last?: string; detail?: string };

export function parseLaunchWatch(value: unknown): LaunchWatch | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const at = record["at"];
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return undefined;
  const changelogId = typeof record["changelogId"] === "string" ? record["changelogId"] : "";
  const title = typeof record["title"] === "string" ? record["title"] : "";
  const attempts = typeof record["attempts"] === "number" && Number.isInteger(record["attempts"]) && record["attempts"] >= 0 ? record["attempts"] : 0;
  const reminderId = record["reminderId"];
  const dueAt = record["dueAt"];
  const last = record["last"];
  const detail = record["detail"];
  return {
    at,
    changelogId,
    title,
    attempts,
    ...(typeof reminderId === "string" && reminderId !== "" ? { reminderId } : {}),
    ...(typeof dueAt === "string" && Number.isFinite(Date.parse(dueAt)) ? { dueAt } : {}),
    ...(typeof last === "string" && last !== "" ? { last } : {}),
    ...(typeof detail === "string" && detail !== "" ? { detail } : {}),
  };
}

export async function readLaunchWatch(kv: KeyedKv, issueKey: string): Promise<LaunchWatch | undefined> {
  return parseLaunchWatch(await kv.get(launchWatchKey(issueKey)));
}

export async function readLaunchIndex(kv: KeyedKv): Promise<string[]> {
  return indexList(await kv.get(LAUNCH_WATCH_INDEX));
}

export type WatchOpen = "opened" | "kept" | "unavailable";

/**
 * Record the approval and list the ticket. A replay of the same approval
 * (same changelog id) keeps the record, so its grace and attempts carry on;
 * a new approval starts a fresh one. Never throws.
 */
export async function openLaunchWatch(
  kv: KeyedKv,
  input: { issueKey: string; changelogId: string; title: string; now: Date; env: NodeJS.ProcessEnv }
): Promise<WatchOpen> {
  const { issueKey } = input;
  try {
    const current = await readLaunchWatch(kv, issueKey);
    const kept = current !== undefined && current.changelogId === input.changelogId;
    if (!kept) {
      const watch: LaunchWatch = { at: input.now.toISOString(), changelogId: input.changelogId, title: input.title, attempts: 0 };
      await kv.put(launchWatchKey(issueKey), watch);
    }
    if (indexMergeOn(input.env)) {
      if ((await addIndexEntry(kv, LAUNCH_WATCH_INDEX, { entry: issueKey, attempts: 2 })) === "unavailable") return "unavailable";
    } else {
      const listed = await readLaunchIndex(kv);
      if (!listed.includes(issueKey)) await kv.put(LAUNCH_WATCH_INDEX, [...listed, issueKey]);
    }
    return kept ? "kept" : "opened";
  } catch (error) {
    warnKv("launch-watch.openLaunchWatch", error);
    return "unavailable";
  }
}

/**
 * The launch is recorded, or the approval ended another way: delete the
 * record and cancel its reminder, so a healthy launch costs no later wake.
 * The sweep prunes the index entry. Never throws.
 */
export async function closeLaunchWatch(deps: { kv: KeyedKv; reminders?: ReminderHostApi | undefined }, issueKey: string): Promise<boolean> {
  try {
    const watch = await readLaunchWatch(deps.kv, issueKey);
    if (watch === undefined) return true;
    await deps.kv.delete(launchWatchKey(issueKey));
    if (watch.reminderId !== undefined) await deps.reminders?.cancel(watch.reminderId, "launch recorded").catch((error: unknown) => warnStep("launch-watch.closeLaunchWatch.cancel", error));
    return true;
  } catch (error) {
    warnKv("launch-watch.closeLaunchWatch", error);
    return false;
  }
}

/** Store the attempt count and last outcome on the record, if it is still there. Never throws. */
export async function noteLaunchAttempt(kv: KeyedKv, input: { issueKey: string; attempts: number; last?: string; detail?: string }): Promise<void> {
  // Merged onto the stored record by a verified conditional update: a closed watch stays closed, a swapped reminder stays swapped.
  await updateVerified(kv, launchWatchKey(input.issueKey), (current) => {
    const latest = parseLaunchWatch(current);
    if (latest === undefined) return undefined;
    const { detail: _previous, ...rest } = latest;
    return {
      ...rest,
      attempts: input.attempts,
      ...(input.last === undefined ? {} : { last: input.last }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
  }).catch((error: unknown) => warnKv("launch-watch.noteLaunchAttempt", error));
}

/** Remove the keys whose record the caller verified gone, from the index as stored now. */
export async function pruneLaunchIndex(kv: KeyedKv, input: { gone: ReadonlySet<string>; env: NodeJS.ProcessEnv }): Promise<void> {
  if (indexMergeOn(input.env)) {
    await pruneIndexEntries(kv, LAUNCH_WATCH_INDEX, { gone: input.gone });
    return;
  }
  const listed = await readLaunchIndex(kv);
  await kv.put(LAUNCH_WATCH_INDEX, listed.filter((key) => !input.gone.has(key)));
}

/**
 * The reminder's args. `orphan` marks one armed while kv could not hold the
 * record: it carries the approval, and its first fire writes the record.
 */
export type LaunchWatchArgs = { issueKey: string; at: string; orphan?: { changelogId: string; title: string } };

export function parseLaunchWatchArgs(args: unknown): LaunchWatchArgs | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const issueKey = record["issueKey"];
  const at = record["at"];
  if (typeof issueKey !== "string" || !/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey) || typeof at !== "string" || !Number.isFinite(Date.parse(at))) return undefined;
  const orphan = record["orphan"];
  if (orphan === null || typeof orphan !== "object" || Array.isArray(orphan)) return { issueKey, at };
  const changelogId = (orphan as Record<string, unknown>)["changelogId"];
  const title = (orphan as Record<string, unknown>)["title"];
  return typeof changelogId === "string" && typeof title === "string" ? { issueKey, at, orphan: { changelogId, title } } : { issueKey, at };
}

export type LaunchArm = "armed" | "already" | "unavailable" | "no_watch" | "failed";

type ReminderDeps = { reminders: ReminderHostApi; now: () => Date; timeoutMs?: number };

/** Create the heal's reminder, due LAUNCH_HEAL_FIRST_MS after `args.at`, capped at LAUNCH_REMINDER_TIMEOUT_MS. Never throws. */
async function createLaunchReminder(deps: ReminderDeps, args: LaunchWatchArgs): Promise<{ id: string; dueAt: string } | undefined> {
  const dueMs = Math.max(Date.parse(args.at) + LAUNCH_HEAL_FIRST_MS - deps.now().getTime(), 60_000);
  const dueAt = new Date(deps.now().getTime() + Math.ceil(dueMs / 60_000) * 60_000).toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.timeoutMs ?? LAUNCH_REMINDER_TIMEOUT_MS);
  });
  const created = deps.reminders.create({
    purpose: LAUNCH_HEAL_HANDLER,
    channelId: "jira",
    continuationToken: `implement-launch:${args.issueKey}`,
    target: { issueKey: args.issueKey },
    delay: `${Math.ceil(dueMs / 60_000)}m`,
    handler: LAUNCH_HEAL_HANDLER,
    args,
  });
  created.catch(() => undefined);
  try {
    const reminder = await Promise.race([created, expired]);
    if (reminder !== "timeout") return { id: reminder.id, dueAt };
    warnStep("launch-watch.createLaunchReminder", new Error("reminder create timed out"));
    return undefined;
  } catch (error) {
    warnStep("launch-watch.createLaunchReminder", error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One reminder per open watch, first due LAUNCH_HEAL_FIRST_MS after the
 * approval. A create that lands after its cap fires into the heal like any
 * other. Never throws.
 */
export async function armLaunchWatch(
  deps: { kv: KeyedKv; reminders: ReminderHostApi | undefined; now: () => Date; timeoutMs?: number },
  input: { issueKey: string }
): Promise<LaunchArm> {
  const { issueKey } = input;
  if (deps.reminders === undefined) return "unavailable";
  let watch: LaunchWatch | undefined;
  try {
    watch = await readLaunchWatch(deps.kv, issueKey);
  } catch (error) {
    warnKv("launch-watch.armLaunchWatch", error);
    return "failed";
  }
  if (watch === undefined) return "no_watch";
  if (watch.reminderId !== undefined) return "already";
  return replaceLaunchReminder({ kv: deps.kv, reminders: deps.reminders, now: deps.now, ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }) }, { issueKey, watch });
}

/**
 * Create a reminder for `watch` and record it only while the stored watch
 * is still that one (same `at`) naming the same reminder as `watch` (none,
 * or the lost one being replaced), with a verified conditional update.
 * When the watch closed or changed meanwhile, nothing is written and the
 * reminder just created is cancelled, so a closed watch never comes back.
 * On success a replaced reminder is cancelled. Never throws.
 */
export async function replaceLaunchReminder(
  deps: { kv: KeyedKv; reminders: ReminderHostApi; now: () => Date; timeoutMs?: number },
  input: { issueKey: string; watch: LaunchWatch }
): Promise<LaunchArm> {
  const { issueKey, watch } = input;
  const reminder = await createLaunchReminder({ reminders: deps.reminders, now: deps.now, ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }) }, { issueKey, at: watch.at });
  if (reminder === undefined) return "failed";
  const recorded = await updateVerified(deps.kv, launchWatchKey(issueKey), (current) => {
    const latest = parseLaunchWatch(current);
    if (latest?.at !== watch.at || latest.reminderId !== watch.reminderId) return undefined;
    return { ...latest, reminderId: reminder.id, dueAt: reminder.dueAt };
  }).catch((error: unknown) => {
    warnKv("launch-watch.replaceLaunchReminder", error);
    return { status: "unavailable" as const };
  });
  if (recorded.status === "unavailable") {
    // The put may have landed. Cancel only a reminder the watch is seen not to name; unseen, keep it: unrecorded, its fire is superseded or heals once.
    let names: boolean | undefined;
    try {
      names = (await readLaunchWatch(deps.kv, issueKey))?.reminderId === reminder.id;
    } catch (error) {
      warnKv("launch-watch.replaceLaunchReminder.reread", error);
    }
    if (names === undefined) return "failed";
    if (!names) {
      await deps.reminders.cancel(reminder.id, "watch changed").catch((error: unknown) => warnStep("launch-watch.replaceLaunchReminder.cancel", error));
      return "failed";
    }
  } else if (recorded.status !== "written") {
    await deps.reminders.cancel(reminder.id, "watch changed").catch((error: unknown) => warnStep("launch-watch.replaceLaunchReminder.cancel", error));
    return "no_watch";
  }
  if (watch.reminderId !== undefined) await deps.reminders.cancel(watch.reminderId, "lost").catch((error: unknown) => warnStep("launch-watch.replaceLaunchReminder.cancelLost", error));
  return "armed";
}

/**
 * Record when the watch's reminder `reminderId` is next due, only while the
 * watch still names that reminder (verified conditional update). Never throws.
 */
export async function noteReminderDue(kv: KeyedKv, input: { issueKey: string; reminderId: string; dueAt: Date }): Promise<void> {
  await updateVerified(kv, launchWatchKey(input.issueKey), (current) => {
    const latest = parseLaunchWatch(current);
    if (latest === undefined || latest.reminderId !== input.reminderId) return undefined;
    return { ...latest, dueAt: input.dueAt.toISOString() };
  }).catch((error: unknown) => warnKv("launch-watch.noteReminderDue", error));
}

/**
 * The durable retry when kv could not take the watch: a reminder that
 * carries the approval itself. Its first fire writes the record
 * (launch-heal.ts). Never throws.
 */
export async function armOrphanLaunchWatch(
  deps: { reminders: ReminderHostApi | undefined; now: () => Date; timeoutMs?: number },
  input: { issueKey: string; changelogId: string; title: string; at: Date }
): Promise<LaunchArm> {
  if (deps.reminders === undefined) return "unavailable";
  const { issueKey, changelogId, title } = input;
  const reminder = await createLaunchReminder(
    { reminders: deps.reminders, now: deps.now, ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }) },
    { issueKey, at: input.at.toISOString(), orphan: { changelogId, title } }
  );
  return reminder === undefined ? "failed" : "armed";
}

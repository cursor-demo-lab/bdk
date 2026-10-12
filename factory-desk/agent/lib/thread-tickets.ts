// A plain `approve` names no key, so the desk reads the ticket from the
// thread it arrived in. `ticket/<KEY>` maps a ticket to its thread; this is
// the reverse index, written wherever the desk binds a ticket to a thread or
// posts into one. It is only a hint: every key it lists counts only while
// that ticket's own binding still names this thread. A filing thread (a
// filing request or `approve file` / `deny file` was said there) is marked
// too, so a plain `approve` before anything is filed is left to the filing
// route instead of being read as a ticket approval.

import type { JsonValue } from "@cursor/july";
import { binding } from "./command-thread.js";
import { leaseExpired, pendingLease } from "./claim-lease.js";
import { deleteVerified } from "./kv-verified.js";
import { updateVerifiedDesk } from "./kv-verified-desk.js";
import { sameThread, type ThreadRef } from "./threads.js";
import { filingHoldKey, filingThreadKey, type KeyedKv, threadTicketsKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { filingHoldKey, filingThreadKey, threadTicketsKey };

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const MAX_KEYS = 10;

// Longer than a filing takes: a hold younger than this may be a create in
// flight, whose twin it still has to stop.
export const FILING_IN_FLIGHT_MS = 60_000;

/**
 * A new filing request in this thread ends the hold file_ticket left pending
 * after its last create, once that hold is past FILING_IN_FLIGHT_MS: a DM is
 * one thread, so its next request would otherwise read as that filing's
 * twin. Best effort.
 */
export async function endFilingHold(kv: KeyedKv, thread: ThreadRef, now: Date = new Date()): Promise<void> {
  await deleteVerified(kv, filingHoldKey(thread), (current) => {
    const hold = pendingLease(current);
    return hold !== undefined && leaseExpired(hold, FILING_IN_FLIGHT_MS, now);
  }).catch((error: unknown) => warnKv("thread-tickets.endFilingHold", error));
}

function parseKeys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && ISSUE_KEY.test(key)) : [];
}

/** Best effort: a missing entry only means a plain `approve` asks for the key. */
export async function recordThreadTicket(kv: KeyedKv, thread: ThreadRef, issueKey: string): Promise<void> {
  try {
    await updateVerifiedDesk(kv, threadTicketsKey(thread), (current) => {
      const keys = parseKeys(current);
      return keys.includes(issueKey) ? undefined : ([...keys, issueKey].slice(-MAX_KEYS) as JsonValue);
    });
  } catch (error) {
    warnKv("thread-tickets.recordThreadTicket", error);
    // Unrecorded; `approve KEY` still works.
  }
}

/** The tickets whose binding is this thread. An unreadable index or binding counts as none. */
export async function threadTickets(kv: KeyedKv, thread: ThreadRef): Promise<string[]> {
  let listed: string[];
  try {
    listed = parseKeys(await kv.get(threadTicketsKey(thread)));
  } catch (error) {
    warnKv("thread-tickets.threadTickets", error);
    return [];
  }
  const bound: string[] = [];
  for (const issueKey of listed) {
    const ticket = await binding(kv, issueKey);
    if (ticket !== undefined && sameThread(ticket, thread) && !bound.includes(issueKey)) bound.push(issueKey);
  }
  return bound;
}

export async function markFilingThread(kv: KeyedKv, threads: readonly ThreadRef[], at: Date): Promise<void> {
  for (const thread of threads) {
    try {
      await kv.put(filingThreadKey(thread), { at: at.toISOString() });
    } catch (error) {
      warnKv("thread-tickets.markFilingThread", error);
      // Unmarked, a plain `approve` here asks for the key instead of reaching the filing route.
    }
  }
}

export async function isFilingThread(kv: KeyedKv, thread: ThreadRef): Promise<boolean> {
  try {
    const value = await kv.get(filingThreadKey(thread));
    return value !== undefined && value !== null;
  } catch (error) {
    warnKv("thread-tickets.isFilingThread", error);
    return false;
  }
}

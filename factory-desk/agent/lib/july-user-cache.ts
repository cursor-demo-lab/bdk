// July 0.2.13 keeps every Slack users.info record, the externality verdict
// derived from it, and every bots.info name in module maps with no TTL and
// no size cap (channels/slack/user-info.js, external-policy.js,
// sender-name.js). A long-lived desk process therefore grows with each new
// sender and keeps a verdict after Slack changes it: a member later made a
// guest, or moved out of the workspace, is still "internal" until restart.
// Upstream write-up: docs/july-users-info-cache.md.
//
// July only exposes whole-cache resets, so the desk clears them once they are
// older than maxAgeMs or once maxUsers distinct senders have been seen since
// the last clear. A clear waits until no desk Slack handler is running: the
// handlers read July's verdict for their own message (fix-request.ts
// julyClassifiedSender), and clearing under them would make that sender look
// unclassified. A clear that lands between July's own lookup and the handler
// start costs that one message the wait in julyClassifiedSender, after which
// the sender counts as external, which refuses rather than approves.

import { resetExternalSenderCache, resetSlackSenderNameCache, type SlackMessageHandler } from "@cursor/july/channels/slack";

export const JULY_USER_CACHE_MAX_AGE_MS = 30 * 60_000;
export const JULY_USER_CACHE_MAX_USERS = 1_000;
const TICK_MS = 60_000;

export type JulyUserCacheOptions = {
  maxAgeMs?: number;
  maxUsers?: number;
  now?: () => number;
  reset?: () => void;
  /** Runs `tick` periodically. The returned function stops it. */
  every?: (ms: number, tick: () => void) => () => void;
};

export type JulyUserCacheGuard = {
  wrap(handler: SlackMessageHandler): SlackMessageHandler;
  /** Clears July's caches if due and idle; true when it cleared. */
  sweep(): boolean;
  stats(): { users: number; inFlight: number; ageMs: number; sweeps: number };
  stop(): void;
};

function resetJulyUserCaches(): void {
  resetExternalSenderCache();
  resetSlackSenderNameCache();
}

function unrefInterval(ms: number, tick: () => void): () => void {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export function julyUserCacheGuard(options: JulyUserCacheOptions = {}): JulyUserCacheGuard {
  const maxAgeMs = options.maxAgeMs ?? JULY_USER_CACHE_MAX_AGE_MS;
  const maxUsers = options.maxUsers ?? JULY_USER_CACHE_MAX_USERS;
  const now = options.now ?? Date.now;
  const reset = options.reset ?? resetJulyUserCaches;
  const every = options.every ?? unrefInterval;
  const users = new Set<string>();
  let clearedAt = now();
  let inFlight = 0;
  let sweeps = 0;
  let stopTimer: (() => void) | undefined;

  const due = () => users.size >= maxUsers || now() - clearedAt >= maxAgeMs;

  const sweep = (): boolean => {
    if (inFlight > 0 || !due()) return false;
    // A throwing reset still restarts the window, so a broken July reset is
    // retried once per window rather than on every message.
    try {
      reset();
      console.log(JSON.stringify({ desk: "july_user_cache", outcome: "cleared", users: users.size, ageMs: now() - clearedAt }));
    } catch (error) {
      console.error(JSON.stringify({ desk: "july_user_cache", outcome: "reset_threw", error: error instanceof Error ? error.message : String(error) }));
    }
    users.clear();
    clearedAt = now();
    sweeps += 1;
    return true;
  };

  const note = (userId: string | undefined) => {
    if (userId === undefined || userId === "" || users.has(userId)) return;
    if (users.size < maxUsers) users.add(userId);
  };

  return {
    wrap(handler) {
      return async (ctx, message) => {
        // The timer covers a quiet desk: July's stale entry would otherwise
        // be read by the next message's pre-handler lookup.
        stopTimer ??= every(Math.min(maxAgeMs, TICK_MS), () => void sweep());
        note(message.author?.userId);
        inFlight += 1;
        try {
          return await handler(ctx, message);
        } finally {
          inFlight -= 1;
          sweep();
        }
      };
    },
    sweep,
    stats: () => ({ users: users.size, inFlight, ageMs: now() - clearedAt, sweeps }),
    stop() {
      stopTimer?.();
      stopTimer = undefined;
    },
  };
}

/** One guard per process: July's caches are module-level, shared by every handler. */
export const julyUserCache = julyUserCacheGuard();

// Slack delivers one physical mention twice when the app subscribes to both
// `app_mention` and `message`: July's channel watcher skips a post that
// mentions the bot only when the text contains `<@BOT>` exactly, so a labeled
// mention (`<@BOT|factory>`, what Cursor's Slack send writes) reaches
// onAppMention and onChannelPost alike (TLSSN-33). Everysphere gates the same
// way, once per message (anybot/incident-bot/handled-message-gate.ts): the
// first delivery of a host ticket command (or a fix request, which gets a
// fixed host reply) claims the message ts, and every other delivery is
// skipped, so one command gets one reply and no model turn.

import { randomUUID } from "node:crypto";
import type { SlackBinding, SlackMessage } from "@cursor/july/channels/slack";
import { approveTarget } from "./approve-command.js";
import { takeLease } from "./claim-lease.js";
import { claimSettleMs } from "./config.js";
import { planCommandTarget } from "./plan-command.js";
import { retryTarget } from "./retry-command.js";
import { handledMessageKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { handledMessageKey };

const HANDLED_LEASE_MS = 10 * 60_000;

export function isHostTicketCommand(message: SlackMessage): boolean {
  return [message.text, message.body, message.markdown].some(
    (text) => typeof text === "string" && (retryTarget(text) !== undefined || planCommandTarget(text) !== undefined || approveTarget(text) !== undefined)
  );
}

/**
 * False when another delivery of this message already took it. Fails open: an
 * unreadable store lets the delivery through. `hostReply` gates a message the
 * caller answers in host code that is not a ticket command (a fix request).
 */
export async function firstDelivery(ctx: SlackBinding, message: SlackMessage, options: { hostReply?: boolean } = {}): Promise<boolean> {
  if (options.hostReply !== true && !isHostTicketCommand(message)) return true;
  const channelId = ctx.slack.channelId || message.channelId;
  const key = handledMessageKey({ channelId, ts: message.ts });
  try {
    const claim = await takeLease(ctx.host.kv, key, { owner: randomUUID(), leaseMs: HANDLED_LEASE_MS, now: new Date(), settleMs: claimSettleMs() });
    if (claim.status === "held" || claim.status === "done") {
      console.log(JSON.stringify({ desk: "handled_message", outcome: "duplicate_delivery", channel: channelId, ts: message.ts }));
      return false;
    }
  } catch (error) {
    warnKv("handled-message.firstDelivery", error);
    // Fail open; each command's own per-ts claim still dedupes its side effect.
  }
  return true;
}

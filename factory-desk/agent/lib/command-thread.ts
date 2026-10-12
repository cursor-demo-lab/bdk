// The two reads the host `approve KEY` and `retry KEY` paths share before
// their own gates: the ticket's stored thread, and the thread the command
// arrived in. Each command counts only in its ticket's own thread.

import type { SlackBinding, SlackMessage } from "@cursor/july/channels/slack";
import { isSlackTs, parseThreadRef, ticketKey, type ThreadRef } from "./threads.js";
import type { KeyedKv } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export async function binding(kv: KeyedKv, issueKey: string) {
  try {
    return parseThreadRef(await kv.get(ticketKey(issueKey)));
  } catch (error) {
    warnKv("command-thread.binding", error);
    return undefined;
  }
}

/** Hosted July may omit `message.teamId` / `ctx.slack.threadTs` while still setting the other. */
export function commandThread(ctx: SlackBinding, message: SlackMessage): ThreadRef {
  const channelId = ctx.slack.channelId || message.channelId;
  const threadTs = isSlackTs(ctx.slack.threadTs) ? ctx.slack.threadTs : isSlackTs(message.threadTs) ? message.threadTs : undefined;
  return threadTs === undefined ? { channelId } : { channelId, threadTs };
}

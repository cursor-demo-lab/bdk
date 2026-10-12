// The filing thread's permalink goes on the Jira ticket, so the ticket, the
// plan's brief (planner/agent/lib/plan.ts `slackThreadUrl` reads this line),
// and the implement pull request all link back to the conversation.
// `chat.getPermalink` needs no scope beyond the bot token.

import type { ThreadRef } from "./threads.js";

export const SLACK_THREAD_LABEL = "Slack thread:";

const PERMALINK = /^https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/[CG][A-Z0-9]+\/p\d{16}(?:\?[\w.=&%-]*)?$/;

type PermalinkClient = { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };

/** The thread root's permalink, or undefined for a DM, a failed call, or an answer that is not a Slack archive URL. */
export async function threadPermalink(client: unknown, thread: ThreadRef | undefined): Promise<string | undefined> {
  if (thread?.threadTs === undefined || !/^[CG]/.test(thread.channelId)) return undefined;
  const call = (client as { apiCall?: unknown } | null | undefined)?.apiCall;
  if (typeof call !== "function") return undefined;
  try {
    const answer = (await (client as PermalinkClient).apiCall("chat.getPermalink", { channel: thread.channelId, message_ts: thread.threadTs })) as { permalink?: unknown };
    return typeof answer?.permalink === "string" && PERMALINK.test(answer.permalink) ? answer.permalink : undefined;
  } catch {
    return undefined;
  }
}

export function withSlackThread(description: string, permalink: string | undefined): string {
  return permalink === undefined ? description : `${description}\n\n${SLACK_THREAD_LABEL} ${permalink}`;
}

/** The comment a Jira-filed ticket gets once the desk opens its intake root (intake-backlink.ts). */
export function backlinkComment(permalink: string): string {
  return `${SLACK_THREAD_LABEL} ${permalink}\nFiled in Jira; the factory desk opened this Slack thread for it. Triage, the plan, and every status update land there.`;
}

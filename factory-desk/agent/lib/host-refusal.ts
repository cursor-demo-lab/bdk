// One host reply to a recognized ticket command (`retry`, `plan`, `replan`,
// `approve`) that host code will not carry out, so the handler can return
// null and July never starts a model turn for it (TLSSN-33: a refusal that fell
// through came back as a second, `Auto routed to …` reply).

import type { SlackBinding } from "@cursor/july/channels/slack";
import { replyPrefix } from "./desk-channels.js";

export type FilerGateWhy = "bot_or_no_author" | "no_auth" | "external" | "unbound" | "not_filer" | "wrong_thread";

/**
 * The host's one reply to a ticket command the filer gate refused. Undefined
 * means no reply: a bot and a Slack Connect sender get none.
 */
export function filerGateRefusal(why: FilerGateWhy, command: string, issueKey: string, channelId?: string): string | undefined {
  const prefix = replyPrefix(channelId);
  switch (why) {
    case "bot_or_no_author":
    case "external":
      return undefined;
    case "not_filer":
      return `Only the person who filed ${issueKey} can say \`${command} ${issueKey}\`, so nothing moved.`;
    case "wrong_thread":
      return `\`${command} ${issueKey}\` works only in ${issueKey}'s own thread, so nothing moved. Say it there.`;
    case "unbound":
      return `${issueKey} was not filed from Slack, so there is no filer to take \`${command} ${issueKey}\` from and nothing moved. Move it in Jira instead.`;
    case "no_auth":
      return `I could not tell who sent \`${command} ${issueKey}\`, so nothing moved. Say \`${prefix}${command} ${issueKey}\` again.`;
  }
}

/**
 * Posts the refusal, if any. Always true: a recognized ticket command never
 * falls through to the model, so the handler returns null and July starts no
 * turn (`{}` would start one).
 */
export async function answerRefusal(ctx: SlackBinding, why: FilerGateWhy, command: string, issueKey: string): Promise<true> {
  const text = filerGateRefusal(why, command, issueKey, ctx.slack.channelId);
  if (text !== undefined) await ctx.thread.post(text);
  return true;
}


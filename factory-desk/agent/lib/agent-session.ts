import { firstLineTitle, type SlackBinding, type SlackMessage, type SlackMessageHandler } from "@cursor/july/channels/slack";

// July 0.2.13 dispatch (channels/slack/dispatch.js:396) fires
// `assistant.threads.setTitle` un-awaited for every accepted root message
// outside a DM, next to the `assistant.threads.setStatus` of its first paint.
// Slack now serves both legacy methods through its agent-sessions bridge:
// setStatus creates the thread's session, setTitle only renames an existing
// one, so a title that lands first is refused with `no_permission` and July
// logs `setTitle not-ok`. The handler runs before that paint, so the desk
// opens the session here, with the title July would set, and July's setTitle
// then renames a session that exists. The session opens `active`: the cap
// abandons the wait, not the request, so a `processing` that lands after
// July's turn end would leave the thread loading for up to an hour. July's
// own paint and clear still drive the spinner.

export const SESSION_OPEN_WAIT_MS = 1_500;

type SlackApi = { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };

export function opensAgentSession(message: SlackMessage): boolean {
  return message.ts === message.threadTs && message.channelId !== "" && !message.channelId.startsWith("D");
}

export async function openAgentSession(ctx: SlackBinding, message: SlackMessage, waitMs = SESSION_OPEN_WAIT_MS): Promise<boolean> {
  const userId = message.author?.isBot === true ? undefined : message.author?.userId;
  const open = (async () => {
    const client = (await ctx.host.slack.getClient()) as SlackApi;
    const response = (await client.apiCall("agents.sessions.setStatus", {
      channel_id: message.channelId,
      thread_ts: message.threadTs,
      status: "active",
      title: firstLineTitle(message.markdown),
      ...(userId === undefined ? {} : { initiator_user_id: userId }),
    })) as { ok?: unknown } | undefined;
    return response?.ok === true;
  })().catch(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), waitMs)));
  try {
    return await Promise.race([open, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens the thread's agent session for a root channel message the inner
 * handler accepted. A refusal or a slow Slack only leaves July's own title
 * call to fare as it did before; it never changes the decision.
 */
export function withAgentSession(inner: SlackMessageHandler, waitMs = SESSION_OPEN_WAIT_MS): SlackMessageHandler {
  return async (ctx, message) => {
    const decision = await inner(ctx, message);
    if (decision !== null && decision !== undefined && opensAgentSession(message)) await openAgentSession(ctx, message, waitMs);
    return decision;
  };
}

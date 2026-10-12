import type { ChannelEventHandler, ChannelEventHandlers } from "@cursor/july/channels";
import { buildDefaultEvents, type BuildDefaultEventsOptions, type SlackChannelState } from "@cursor/july/channels/slack";
import { intakeSourceTs } from "./intake-triage.js";
import { asksToFile, filingPromptKey, recordFilingPrompt } from "./reaction-targets.js";
import { threadTickets } from "./thread-tickets.js";
import { isSlackTs, isSlackUserId } from "./threads.js";
import { warnKv } from "./ops-funnel.js";

// One Slack reply per model turn (TLSSN-35, TLSSN-36). July's post-mode
// sinks post twice when a turn has more than one assistant step with no tool
// call between them: `message.completed` carries every text delta since the
// last tool call (narration included), then `turn.completed` carries the
// SDK's result, which is only the last assistant step, and posts it too
// because it differs from the first post. Here `message.completed` holds its
// text and `turn.completed` posts the SDK's result once, or the held text
// when the result is empty.
//
// A reply that asks for `approve file` is a filing prompt: once it has
// landed, its ts is recorded so a ✅ or ❌ on it counts (reaction-approval.ts),
// from the person whose message started the turn.
//
// A ✅ on that prompt starts a turn whose channel state July keys on the
// reacted message, so `threadTs` is the prompt, a reply. Slack threads a post
// there under the real root, and July's postMessage then throws "ignored
// thread_ts" after the post landed: no `lastBotMessageTs`, an error logged,
// and `invalid_thread_ts` from setSuggestedPrompts. Every sink here first
// points `threadTs` at the root the prompt's record names.

type State = SlackChannelState & { deskHeldReply?: string | null; deskReplyThread?: { from: string; to: string | null } };
type SessionContext = Parameters<ChannelEventHandler>[2];
type AnyHandler = ChannelEventHandler<SlackChannelState, never>;

export function oneReplyEvents(options: BuildDefaultEventsOptions): ChannelEventHandlers<SlackChannelState> {
  const defaults = buildDefaultEvents({ ...options, reply: { mode: "post" } });
  const messageCompleted = defaults["message.completed"];
  const turnCompleted = defaults["turn.completed"];
  const turnStarted = defaults["turn.started"];
  const rooted = Object.fromEntries(
    Object.entries(defaults).map(([type, handler]) => [
      type,
      async (event: never, channel: Parameters<AnyHandler>[1], ctx: SessionContext) => {
        await replyInRoot(channel.state as State, ctx);
        await (handler as AnyHandler)(event, channel, ctx);
      },
    ])
  ) as ChannelEventHandlers<SlackChannelState>;
  return {
    ...rooted,
    async "turn.started"(event, channel, ctx) {
      (channel.state as State).deskHeldReply = null;
      await replyInRoot(channel.state as State, ctx);
      await turnStarted?.(event, channel, ctx);
    },
    async "message.completed"(event, channel, ctx) {
      const { text, finishReason, parentCallId } = event.data;
      if (parentCallId === undefined && finishReason !== "tool_call" && text !== "") {
        (channel.state as State).deskHeldReply = text;
        return;
      }
      await replyInRoot(channel.state as State, ctx);
      await messageCompleted?.(event, channel, ctx);
    },
    async "turn.completed"(event, channel, ctx) {
      const state = channel.state as State;
      await replyInRoot(state, ctx);
      const held = state.deskHeldReply ?? null;
      state.deskHeldReply = null;
      const result = typeof event.data.result === "string" && event.data.result.trim() !== "" ? event.data.result : held;
      const before = state.lastBotMessageTs ?? null;
      await turnCompleted?.(result === null ? event : { ...event, data: { ...event.data, result } }, channel, ctx);
      if (result !== null && asksToFile(result)) await rememberFilingPrompt(state, ctx, before);
    },
  };
}

/**
 * When `threadTs` is a recorded filing prompt inside a thread, the thread's
 * root. Looked up once per ts; a hosted wake that resets `threadTs` to the
 * prompt is pointed back without another read.
 */
async function replyInRoot(state: State, ctx: SessionContext | undefined): Promise<void> {
  const ts = state.threadTs;
  if (state.channelId === null || !isSlackTs(ts)) return;
  const known = state.deskReplyThread;
  if (known?.from === ts) {
    if (known.to !== null) state.threadTs = known.to;
    return;
  }
  if (known?.to === ts) return;
  const kv = ctx?.host?.kv;
  if (kv === undefined) return;
  let root: string | null = null;
  try {
    const stored = (await kv.get(filingPromptKey({ channelId: state.channelId, ts }))) as { threadTs?: unknown } | null | undefined;
    const threadTs = stored?.threadTs;
    if (isSlackTs(threadTs) && threadTs !== ts) root = threadTs;
  } catch (error) {
    warnKv("one-reply.replyInRoot", error);
    // Unread, the reply goes where July put it: Slack still threads it under the root.
    return;
  }
  state.deskReplyThread = { from: ts, to: root };
  if (root !== null) state.threadTs = root;
}

async function rememberFilingPrompt(state: State, ctx: SessionContext, before: string | null): Promise<void> {
  const ts = state.lastBotMessageTs ?? null;
  const requester = state.triggeringUserId;
  if (ts === before || !isSlackTs(ts) || !isSlackUserId(requester) || state.channelId === null) return;
  // The thread the prompt was just posted in (`replyInRoot` already moved a
  // reaction turn's to its root), not the session's auth: July keys a DM's
  // session on the channel and keeps the first message's auth, so a second
  // request's prompt would be recorded under the first request's thread.
  const threadTs = state.threadTs ?? undefined;
  try {
    const thread = isSlackTs(threadTs) ? { channelId: state.channelId, threadTs } : { channelId: state.channelId };
    const before = state.channelId.startsWith("D") ? await threadTickets(ctx.host.kv, thread) : undefined;
    const request = await intakeSourceTs(ctx.host.kv, thread);
    await recordFilingPrompt(ctx.host.kv, { channel: state.channelId, ts, ...(isSlackTs(threadTs) ? { threadTs } : {}), requester, at: new Date(), ...(before === undefined ? {} : { before }), ...(request === undefined ? {} : { request }) });
  } catch {
    // Unrecorded, a reaction on this prompt does nothing; `approve file` still files.
  }
}

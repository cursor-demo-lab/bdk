import { createDefaultOnInbound, credentialsFromEnv, slackChannel, type SlackMessageHandler } from "@cursor/july/channels/slack";
import { withAgentSession } from "../lib/agent-session.js";
import { backstopSweep } from "../lib/hop-watch.js";
import { WATCHED_CHANNELS } from "../lib/desk-channels.js";
import { refusesProductionTarget } from "../lib/factory-stage.js";
import { stagingRefusesSlackApp, type SlackAppHost } from "../lib/slack-app-guard.js";
import { deskInbound } from "../lib/fix-request.js";
import { julyUserCache } from "../lib/july-user-cache.js";
import { oneReplyEvents } from "../lib/one-reply.js";
import { factoryThreadReplies } from "../lib/plain-reply.js";
import { recordingSpeakers } from "../lib/originator.js";
import { deskReactions } from "../lib/reaction-approval.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { traced, type FactoryWork } from "../lib/factory-otel.js";

// Every human message's sender is recorded in host.kv first. Approvals check
// that record, not session auth, which names only the person who opened the
// thread. A fix request is recorded too, so it is the thread's latest
// speaker and an earlier approve line cannot vouch for a later turn.
// julyUserCache bounds July's users.info cache and clears it only between
// handlers, so every handler that reads July's verdict sits inside it.
// withAgentSession opens an accepted channel root's Slack agent session
// before July titles it (lib/agent-session.ts).
const onInbound = withBackstopSweep(julyUserCache.wrap(withAgentSession(recordingSpeakers(deskInbound({ fallback: createDefaultOnInbound() })))));

const SWEEP_WAIT_MS = 1_000;

// Beside the hop-watch schedule (a 5-minute `run` schedule on hosted v2
// since July 0.2.13), each admission may run the throttled sweep
// (lib/hop-watch.ts backstopSweep) beside the handler. The
// handler's decision never waits more than SWEEP_WAIT_MS on it, and
// SlackBinding has no waitUntil, so the rest of a slow sweep is untracked.
export function withBackstopSweep(handler: SlackMessageHandler): SlackMessageHandler {
  return async (ctx, message) => {
    const sweep = backstopSweep({ host: ctx.host, now: () => new Date() });
    const decision = await handler(ctx, message);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([sweep, new Promise((resolve) => (timer = setTimeout(resolve, SWEEP_WAIT_MS)))]);
    clearTimeout(timer);
    return decision;
  };
}

// Mentions and DMs everywhere the bot is in. channelPosts watches the
// intake channels so a plain reply in a factory thread (`approve file`,
// `approve`, `retry TLSSN-N`) wakes the desk the same way a mention does;
// factoryThreadReplies (lib/plain-reply.ts) ignores every other post there.
// posts: "all" is required for in-thread replies; the default
// "top-level" never dispatches ts !== threadTs. A lone "*" is replies
// only and is rejected by hosted v2 (control plane needs C…/G… ids), so
// in any other channel only a mention reaches the desk.
// toolApprovals stays off: the decisions are ✅ / ❌ reactions on the
// filing prompt and the plan post (lib/reaction-approval.ts, July 0.2.13
// delivers `reaction_added` on hosted v2) and the typed commands, never a
// card, since parked needsApproval calls die on replace.
export const DESK_CHANNEL_POSTS = {
  allow: [...WATCHED_CHANNELS],
  posts: "all" as const,
};

// The manifest is the same on every stage. Hosted v2 reads it from the engine
// at provision, before any deployment secret reaches process.env (secrets are
// bound per request, internal/cursor/hosted-bound-secrets.js), so FACTORY_ENV
// cannot shape it. A staging slug keeps it and refuses production channels
// per request instead (stagingChannelGuard).

/**
 * On a staging slug, a message, mention, DM, or reaction in a production
 * channel reaches no desk handler, and neither does anything at all while the
 * bot token is a production app's (factory-stage.ts, slack-app-guard.ts).
 * Read per request, when the bound secrets are in process.env. Production
 * passes everything and asks Slack nothing.
 */
export function stagingChannelGuard(handler: SlackMessageHandler): SlackMessageHandler {
  return async (ctx, message) => {
    bindOpsFunnel(ctx.host);
    if (refusesProductionTarget(process.env, { kind: "slackChannels", value: message.channelId })) {
      console.log(JSON.stringify({ desk: "staging_refused", channel: message.channelId }));
      return null;
    }
    if (await stagingRefusesSlackApp(ctx.host as SlackAppHost)) return null;
    return handler(ctx, message);
  };
}

/** One `factory.delivery` span per Slack event; `dispatched` starts or continues a turn, `skipped` does not. */
function slackWork(kind: string): FactoryWork<unknown> {
  return { span: "factory.delivery", kind: `slack.${kind}`, describe: (decision) => ({ outcome: decision === null || decision === undefined ? "skipped" : "dispatched" }) };
}

// Mentions and DMs share one handler object (slack.test.ts), so one kind.
const guardedInbound = traced(slackWork("inbound"), stagingChannelGuard(onInbound));

const ENV_PREFIX = "FACTORY_DESK";
const SUGGESTED_PROMPTS = [
  { title: "File a bug", message: "File a bug: " },
  { title: "Approve a plan", message: "approve KEY" },
  { title: "Ask status", message: "What happened to KEY?" },
];

export default slackChannel({
  envPrefix: ENV_PREFIX,
  toolApprovals: false,
  reply: { mode: "post" },
  // The turn's reply posts once, at turn end (lib/one-reply.ts).
  events: oneReplyEvents({ credentials: credentialsFromEnv(ENV_PREFIX), suggestedPrompts: SUGGESTED_PROMPTS }),
  engagement: {
    mentions: true,
    directMessages: true,
    channelPosts: DESK_CHANNEL_POSTS,
  },
  onAppMention: guardedInbound,
  onDirectMessage: guardedInbound,
  onChannelPost: traced(slackWork("channel_post"), stagingChannelGuard(factoryThreadReplies(onInbound))),
  // Not behind recordingSpeakers: a reaction is not a message, and its
  // synthetic text must not become the thread's latest speaker.
  onReactionAdded: traced(slackWork("reaction_added"), stagingChannelGuard(withBackstopSweep(julyUserCache.wrap(deskReactions())))),
  suggestedPrompts: SUGGESTED_PROMPTS,
});

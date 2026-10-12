// ✅ and ❌ reactions on the desk's two decision posts, as July 0.2.13
// delivers `reaction_added` on hosted v2 (onReactionAdded):
//
// - the filing prompt: ✅ is `approve file` (a model turn, since file_ticket
//   takes the triage the prompt carries), ❌ declines with one host line and
//   files nothing;
// - the plan post: ✅ is `approve KEY` (approvePlanned, the typed path's own
//   move, hold, and crumb), ❌ records the denial on the ticket as
//   `deny KEY` does and asks what should change; the ticket stays Planned.
//
// July hands the handler a synthetic message whose `threadTs` is the reacted
// message and whose author is always marked human, so the desk decides the
// rest itself. Only a message the desk recorded as one of those posts counts
// (`filing-prompt/…`, `plan-post/…`, written when it was posted), which also
// leaves out the stage reactions the desk puts on a thread root. A bot, the
// desk itself, and a Slack Connect sender are ignored, and only the person
// the typed command would take counts: the requester for a filing prompt,
// the ticket's filer in its own thread for a plan. Everyone else is ignored
// without a reply. Each reaction is claimed (`reaction/<channel>:<ts>/<act>`,
// settle re-read) before it acts, so a redelivery does nothing.

import { randomUUID } from "node:crypto";
import { buildSlackAuthContext, type SlackBinding, type SlackMessage, type SlackMessageHandler } from "@cursor/july/channels/slack";
import { approvePlanned, takeTicketDecision } from "./approve-command.js";
import { finishLease, releaseLease, takeLease } from "./claim-lease.js";
import { binding } from "./command-thread.js";
import { claimSettleMs, statusNames } from "./config.js";
import { replyPrefix } from "./desk-channels.js";
import { slackConnectSender, type ExternalSenderCheck } from "./fix-request.js";
import { dropIntakeTriage } from "./intake-triage.js";
import { addComment, issueStatus } from "./jira.js";
import { recordSpeaker } from "./originator.js";
import { alreadyDeclinedLine, declineGate, declinedLine, deniedComment, notPlannedLine, recordDecline } from "./plan-decline.js";
import { learnDeskSelfIdentity } from "./self-identity.js";
import { declineAnsweredKey, filingPromptKey, type KeyedKv, planPostKey, reactionClaimKey } from "./kv-keys.js";
import { threadTickets } from "./thread-tickets.js";
import { isSlackTs, isSlackUserId, pastPlanned, sameThread, ticketKey, type ThreadRef } from "./threads.js";
import { warnKv } from "./ops-funnel.js";

export { reactionClaimKey };

export const APPROVE_REACTION = "white_check_mark";
export const DECLINE_REACTION = "x";
// A filing prompt answers one request; its triage record is kept for a day too.
const FILING_PROMPT_TTL_MS = 24 * 60 * 60_000;
const REACTION_LEASE_MS = 120_000;

type Target = { kind: "plan"; issueKey: string; thread: ThreadRef } | { kind: "filing"; requester: string; thread: ThreadRef; at: number; before: string[]; request?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function threadOf(channelId: string, stored: Record<string, unknown>): ThreadRef {
  return isSlackTs(stored["threadTs"]) ? { channelId, threadTs: stored["threadTs"] } : { channelId };
}

// The record was written when the post landed, well before a person reacts,
// but how soon a hosted kv put is visible to another run is unverified: a
// miss is read once more after the settle wait before the reaction counts as
// not on a desk post.
async function readTarget(kv: KeyedKv, item: { channelId: string; ts: string }, now: Date): Promise<Target | undefined> {
  const { channelId, ts } = item;
  const read = async (): Promise<Target | undefined> => {
    const [plan, filing] = await Promise.all([kv.get(planPostKey({ channelId, ts })), kv.get(filingPromptKey({ channelId, ts }))]);
    const planned = record(plan);
    if (planned !== undefined && typeof planned["issueKey"] === "string") return { kind: "plan", issueKey: planned["issueKey"], thread: threadOf(channelId, planned) };
    const asked = record(filing);
    if (asked === undefined || !isSlackUserId(asked["requester"])) return undefined;
    const age = now.getTime() - Date.parse(String(asked["at"]));
    if (!(age < FILING_PROMPT_TTL_MS)) return undefined;
    const before = Array.isArray(asked["before"]) ? asked["before"].filter((key): key is string => typeof key === "string") : [];
    return { kind: "filing", requester: asked["requester"], thread: threadOf(channelId, asked), at: Date.parse(String(asked["at"])), before, ...(typeof asked["request"] === "string" ? { request: asked["request"] } : {}) };
  };
  try {
    const first = await read();
    if (first !== undefined) return first;
    const settleMs = claimSettleMs();
    if (settleMs <= 0) return undefined;
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    return await read();
  } catch {
    return undefined;
  }
}

type SlackApi = { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };

type Reactor = { bot: boolean; name?: string };

// A reactor that cannot be looked up counts as a bot: an unknown identity
// never approves. The desk's own id is the process's cached `auth.test`
// answer (self-identity.ts); without it nothing can be told apart from it.
async function lookUpReactor(ctx: SlackBinding, client: SlackApi, userId: string): Promise<Reactor> {
  try {
    const self = await learnDeskSelfIdentity(ctx.host);
    if (self === undefined || self.userId === userId) return { bot: true };
    const info = record(await client.apiCall("users.info", { user: userId }));
    const user = record(info?.["user"]);
    if (info?.["ok"] !== true || user === undefined) return { bot: true };
    const profile = record(user["profile"]);
    const name = [profile?.["display_name"], user["real_name"], user["name"]].find((value): value is string => typeof value === "string" && value.trim() !== "");
    return { bot: user["is_bot"] === true || user["is_app_user"] === true || userId === "USLACKBOT", ...(name === undefined ? {} : { name }) };
  } catch {
    return { bot: true };
  }
}

async function postInThread(client: SlackApi, thread: ThreadRef, text: string): Promise<void> {
  await client.apiCall("chat.postMessage", { channel: thread.channelId, text, ...(thread.threadTs === undefined ? {} : { thread_ts: thread.threadTs }) });
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ desk: "reaction", ...fields }));
}

export type ReactionDeps = { isExternal?: ExternalSenderCheck; now?: () => Date };

export function deskReactions(deps: ReactionDeps = {}): SlackMessageHandler {
  const isExternal = deps.isExternal ?? slackConnectSender;
  return async (ctx, message) => {
    const started = Date.now();
    const name = message.reaction?.name;
    const verb = name === APPROVE_REACTION ? "approve" : name === DECLINE_REACTION ? "decline" : undefined;
    if (verb === undefined) return null;
    const channelId = ctx.slack.channelId || message.channelId;
    const itemTs = isSlackTs(message.threadTs) ? message.threadTs : ctx.slack.threadTs;
    const userId = message.author?.userId;
    if (!isSlackTs(itemTs) || !isSlackUserId(userId)) return null;
    const now = deps.now?.() ?? new Date();
    const target = await readTarget(ctx.host.kv, { channelId, ts: itemTs }, now);
    if (target === undefined) return null;
    const base = { verb, target: target.kind, channel: channelId, ts: itemTs, user: userId, ...(target.kind === "plan" ? { issueKey: target.issueKey } : {}) };

    const client = (await ctx.host.slack.getClient()) as SlackApi;
    const reactor = await lookUpReactor(ctx, client, userId);
    if (reactor.bot) return log({ ...base, outcome: "ignored", why: "bot" }), null;
    const classified = message.teamId || !ctx.slack.teamId ? message : { ...message, teamId: ctx.slack.teamId };
    if (await isExternal(classified)) return log({ ...base, outcome: "ignored", why: "external" }), null;
    if (target.kind === "filing" && target.requester !== userId) return log({ ...base, outcome: "ignored", why: "not_requester" }), null;
    if (target.kind === "plan") {
      const ticket = await binding(ctx.host.kv, target.issueKey);
      if (ticket?.originatorUserId === undefined) return log({ ...base, outcome: "ignored", why: "unbound" }), null;
      if (ticket.originatorUserId !== userId) return log({ ...base, outcome: "ignored", why: "not_filer" }), null;
      if (!sameThread(ticket, target.thread)) return log({ ...base, outcome: "ignored", why: "wrong_thread" }), null;
    }

    const act = target.kind === "filing" ? "filing" : verb;
    const claimKey = reactionClaimKey({ channelId, ts: itemTs, act });
    const owner = randomUUID();
    const claim = await takeLease(ctx.host.kv, claimKey, { owner, leaseMs: REACTION_LEASE_MS, now, settleMs: claimSettleMs(), fields: { verb, user: userId } });
    if (claim.status === "held" || claim.status === "done") return log({ ...base, outcome: "duplicate" }), null;
    if (claim.status === "unavailable") {
      await releaseLease(ctx.host.kv, claimKey, owner);
      return log({ ...base, outcome: "ignored", why: "claim_unavailable" }), null;
    }
    // `done` is final: the post is decided. `expire` leaves the claim pending
    // for REACTION_LEASE_MS, long enough to swallow a redelivery, after which
    // the same reaction added again counts: the decision hold, the thread's
    // tickets, and the live status guard a repeat. `release` drops it.
    const settle = async (claimed: "done" | "expire" | "release", outcome: string) => {
      if (claimed === "done") await finishLease(ctx.host.kv, claimKey, owner, { fields: { outcome } });
      else if (claimed === "release") await releaseLease(ctx.host.kv, claimKey, owner);
      log({ ...base, outcome, ms: Date.now() - started });
    };

    try {
      if (target.kind === "filing") {
        const filed = await promptFiling(ctx.host.kv, target);
        if (filed.length > 0) {
          if (verb === "decline") await postInThread(client, target.thread, `This request is already filed as ${filed.join(", ")}, so ❌ changes nothing.`);
          await settle("expire", "already_filed");
          return null;
        }
        if (verb === "decline") {
          await dropIntakeTriage(ctx.host.kv, target.thread, target.request, now);
          await postInThread(client, target.thread, "Okay, I won't file this; nothing was created in Jira.");
          await settle("done", "filing_declined");
          return null;
        }
        // The turn files later; if it fails, this ✅ can count again once the claim expires.
        const decision = await fileFromReaction(ctx, message, { userId, thread: target.thread, ...(reactor.name === undefined ? {} : { name: reactor.name }) });
        await settle("expire", "filing_approved");
        return decision;
      }
      const kept = verb === "approve" ? await approvePlan(ctx, client, target, userId, now) : await declinePlan(ctx, client, target, reactor.name ?? `<@${userId}>`, now);
      // A plan post stays open to a later ✅ / ❌ once the ticket is Planned again.
      await settle(kept.keep ? "expire" : "release", kept.outcome);
      return null;
    } catch (error) {
      await releaseLease(ctx.host.kv, claimKey, owner);
      console.error(JSON.stringify({ desk: "reaction", ...base, outcome: "threw", error: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  };
}

/**
 * ✅ on the filing prompt starts the `approve file` turn. July keys a reaction's
 * session on the reacted message, so the auth names the filing thread's root
 * instead: file_ticket reads the thread's triage and binds the ticket from it.
 * The reactor is recorded there as the thread's latest speaker with an
 * `approve file` command, which is how file_ticket learns who approved.
 */
async function fileFromReaction(ctx: SlackBinding, message: SlackMessage, input: { userId: string; name?: string; thread: ThreadRef }) {
  await recordSpeaker(ctx.host.kv, { thread: input.thread, userId: input.userId, ts: message.ts, text: "approve file", reaction: true });
  const prefix = replyPrefix(input.thread.channelId);
  return {
    auth: buildSlackAuthContext({
      channelId: input.thread.channelId,
      threadTs: input.thread.threadTs ?? "",
      ...(message.teamId || ctx.slack.teamId ? { teamId: message.teamId || ctx.slack.teamId } : {}),
      userId: input.userId,
      ...(input.name === undefined ? {} : { userName: input.name }),
    }),
    message: "approve file",
    context: [
      [
        "<desk_command>",
        `<@${input.userId}> reacted :white_check_mark: to your filing prompt in this thread. That is \`approve file\`: file the request now with the triage the prompt shows, exactly as for a typed \`approve file\`.`,
        `This reply is for humans in Slack. Never name a tool. A command you ask for is written ${prefix === "" ? "without a mention" : `with ${prefix.trim()}`}.`,
        "</desk_command>",
      ].join("\n"),
    ],
  };
}

// Two replicas' wall clocks stamp the prompt record and `filedAt`.
const FILED_SKEW_MS = 5_000;

/**
 * The ticket this filing prompt was filed as. A channel thread holds one
 * request, so any ticket bound there is its filing, even for a desk reply
 * that repeats the ask later. A DM is one thread holding every request's
 * ticket, so there it is the first ticket file_ticket bound (`filedAt`) after
 * the prompt landed, allowing FILED_SKEW_MS of clock skew, and never one the
 * prompt's record lists as already there (`before`), which the skew would
 * otherwise let an earlier request's ticket match.
 */
async function promptFiling(kv: KeyedKv, target: { thread: ThreadRef; at: number; before: string[] }): Promise<string[]> {
  const { thread, at: promptAt } = target;
  const tickets = await threadTickets(kv, thread);
  if (!thread.channelId.startsWith("D")) return tickets;
  let first: { issueKey: string; at: number } | undefined;
  for (const issueKey of tickets) {
    if (target.before.includes(issueKey)) continue;
    const bound = record(await kv.get(ticketKey(issueKey)).catch((error: unknown) => warnKv("reaction-approval.promptFiling", error)));
    const at = Date.parse(String(bound?.["filedAt"]));
    if (at >= promptAt - FILED_SKEW_MS && (first === undefined || at < first.at)) first = { issueKey, at };
  }
  return first === undefined ? [] : [first.issueKey];
}

type Settled = { keep: boolean; outcome: string };

async function approvePlan(ctx: SlackBinding, client: SlackApi, target: Extract<Target, { kind: "plan" }>, userId: string, now: Date): Promise<Settled> {
  const { issueKey, thread } = target;
  const prefix = replyPrefix(thread.channelId);
  const approval = await approvePlanned(ctx, { issueKey, author: userId, now });
  switch (approval.outcome) {
    case "approved":
      return { keep: true, outcome: approval.outcome };
    // Another decision on this ticket holds it (a typed approve, a ❌, or an
    // approval of an earlier plan). This ✅ did nothing, so it may count later.
    case "duplicate":
      return { keep: false, outcome: approval.outcome };
    case "claim_unavailable":
      await postInThread(client, thread, `I could not record your approval of ${issueKey} just now, so nothing moved. React ✅ again in a minute, or say \`${prefix}approve ${issueKey}\`.`);
      return { keep: false, outcome: "claim_unavailable" };
    case "not_moved":
      await postInThread(client, thread, `I could not move ${issueKey} to Approved in Jira, so nothing changed. React ✅ again in a minute, or say \`${prefix}approve ${issueKey}\`.`);
      return { keep: false, outcome: "not_moved" };
    case "not_planned": {
      if (approval.why === "status_unread") {
        await postInThread(client, thread, `I could not read ${issueKey} in Jira just now, so nothing moved. React ✅ again in a minute, or say \`${prefix}approve ${issueKey}\`.`);
        return { keep: false, outcome: "status_unread" };
      }
      // Already Approved or past it: the approval this ✅ asks for has happened.
      if (approval.status !== undefined && pastPlanned(approval.status)) return { keep: true, outcome: "already_approved" };
      await postInThread(client, thread, `${issueKey} is ${approval.status ?? "no longer Planned"}, not Planned, so I did not approve it. Only a Planned ticket can be approved.`);
      return { keep: true, outcome: "not_planned" };
    }
  }
}

/**
 * ❌ on the plan: `deny KEY`'s comment, then one line asking what should
 * change. The ticket stays Planned. It runs under the ticket's decision hold,
 * so it never lands beside an approval; the hold is released after, since a
 * declined plan can still be approved.
 */
async function declinePlan(ctx: SlackBinding, client: SlackApi, target: Extract<Target, { kind: "plan" }>, by: string, now: Date): Promise<Settled> {
  const hold = await takeTicketDecision(ctx, { issueKey: target.issueKey, by, now, act: "decline" });
  if (hold === "duplicate") return { keep: false, outcome: "duplicate" };
  if (hold === "unavailable") {
    await postInThread(client, target.thread, `I could not record that on ${target.issueKey} just now, so nothing changed. React ❌ again in a minute, or say \`${replyPrefix(target.thread.channelId)}deny ${target.issueKey}\`.`);
    return { keep: false, outcome: "claim_unavailable" };
  }
  try {
    return await decline(ctx, client, target, by);
  } finally {
    await hold.release();
  }
}

/**
 * The status and the comments are read together (they are independent Jira
 * reads), the one reply goes out as soon as the decline comment lands, and
 * the `plan-declined` label follows it. One `{"desk":"plan_decline"}` line
 * carries each phase's milliseconds, so a slow ❌ shows where it waited.
 */
async function decline(ctx: SlackBinding, client: SlackApi, target: Extract<Target, { kind: "plan" }>, by: string): Promise<Settled> {
  const { issueKey, thread } = target;
  const prefix = replyPrefix(thread.channelId);
  const timer = phaseTimer();
  const decided = await declineGate(ctx.host.mcp, issueKey);
  timer.mark("jira_read");
  if (decided.state === "status_unread") {
    await postInThread(client, thread, `I could not read ${issueKey} in Jira just now, so nothing changed. React ❌ again in a minute, or say \`${prefix}deny ${issueKey}\`.`);
    return { keep: false, outcome: "status_unread" };
  }
  if (decided.state === "not_planned") {
    await postInThread(client, thread, notPlannedLine({ issueKey, status: decided.status }));
    return { keep: true, outcome: "not_planned" };
  }
  if (decided.state === "comments_unread") {
    await postInThread(client, thread, `I could not read ${issueKey}'s comments in Jira just now, so nothing changed. React ❌ again in a minute, or say \`${prefix}deny ${issueKey}\`.`);
    return { keep: false, outcome: "comments_unread" };
  }
  const answered = declineAnsweredKey({ thread, issueKey });
  const plan = decided.planId ?? "none";
  if (decided.state === "declined") {
    // Silent only when this thread already heard a ❌ decline of this plan;
    // a plan declined by `deny KEY` elsewhere gets one short line here.
    const said = record(await ctx.host.kv.get(answered).catch((error: unknown) => warnKv("reaction-approval.decline.get", error)));
    if (said?.["plan"] === plan) return { keep: true, outcome: "already_declined" };
    await postInThread(client, thread, alreadyDeclinedLine(issueKey));
    await ctx.host.kv.put(answered, { plan }).catch((error: unknown) => warnKv("reaction-approval.decline.put.1", error));
    return { keep: true, outcome: "already_declined" };
  }
  const denied = await addComment(ctx.host.mcp, { issueKey, body: deniedComment(by) });
  timer.mark("comment");
  if (denied.status !== "commented") {
    await postInThread(client, thread, `I could not record that on ${issueKey} in Jira, so nothing changed. React ❌ again in a minute, or say \`${prefix}deny ${issueKey}\`.`);
    return { keep: false, outcome: "comment_failed" };
  }
  await postInThread(client, thread, declinedLine({ issueKey, prefix }));
  timer.mark("post");
  await ctx.host.kv.put(answered, { plan }).catch((error: unknown) => warnKv("reaction-approval.decline.put.2", error));
  const recorded = await recordDecline(ctx.host, issueKey);
  timer.mark("label");
  console.log(JSON.stringify({ desk: "plan_decline", issueKey, ...recorded, ms: timer.phases() }));
  return { keep: true, outcome: "plan_declined" };
}

function phaseTimer(): { mark: (phase: string) => void; phases: () => Record<string, number> } {
  const phases: Record<string, number> = {};
  let last = Date.now();
  return {
    mark: (phase) => {
      const now = Date.now();
      phases[phase] = now - last;
      last = now;
    },
    phases: () => phases,
  };
}


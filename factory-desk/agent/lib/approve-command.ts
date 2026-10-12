// A message that is exactly `approve KEY`, from the person who filed KEY, in
// KEY's own thread, while KEY is Planned, is approved in host code with no
// model turn. Cursor Slack-send chrome (`*Sent using* …`) and a Slack
// autolink around the key are still that command; extra words from the
// person are not. The desk moves the ticket to Approved, records the Slack
// approval (slack-approval.ts), and reacts to the message instead of
// replying, so the thread's one beat is the In Progress line with the agent
// link. Every other case, a refusal, a ticket not in Planned, or a move that
// fails, gets one fixed host reply saying why, and the handler still returns
// null, so no model turn follows (TLSSN-33). The
// gates are approve_ticket's: the filer, their thread, from Planned only,
// with the move itself guarded (`transitionFrom`), so a replan that lands
// after the first read is not dragged from Triaged to Approved.
//
// A plain `approve` (same chrome and mention allowed) is `approve KEY` for
// the one ticket its thread maps to (thread-tickets.ts). A thread that maps
// to none or to several gets one host line asking for `approve KEY`, except
// an unfiled filing thread, where it takes the route `approve file` takes.
//
// A ✅ reaction on the plan post (reaction-approval.ts) is the same approval.
// Both paths go through approvePlanned, whose per-ticket hold claim makes a
// reaction plus a typed approve, or a redelivery of either, one approval.

import { randomUUID } from "node:crypto";
import type { HostMcpRegistry } from "@cursor/july";
import { defaultSlackAuth, type SlackBinding, type SlackMessage } from "@cursor/july/channels/slack";
import { finishLease, leaseExpired, pendingLease, releaseLease, takeLease } from "./claim-lease.js";
import { ackCommand, type AckTarget } from "./command-ack.js";
import { clearPlanDeclined } from "./plan-decline.js";
import { binding, commandThread } from "./command-thread.js";
import { claimSettleMs, statusNames } from "./config.js";
import { replyPrefix } from "./desk-channels.js";
import { answerRefusal, type FilerGateWhy } from "./host-refusal.js";
import { issueStatus, transitionFrom } from "./jira.js";
import { postLoader } from "./loader.js";
import { approveTicketKey } from "./reaction-targets.js";
import { clearSlackApproval, recordSlackApproval } from "./slack-approval.js";
import { filingThreadKey, isFilingThread, threadTickets } from "./thread-tickets.js";
import { sameThread } from "./threads.js";
import { approveCommandKey, type KeyedKv } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

// Slack stores a mention as `<@U…>`, or `<@U…|name>` when the sender's client labels it.
const LEADING_MENTION = /^(?:<@[A-Z0-9]+(?:\|[^<>]*)?>|@[\w.-]+)[,:]?\s*/;
const EXACT_APPROVE = /^approve\s+([A-Za-z][A-Za-z0-9]+-\d+)[.!]*$/i;
const PLAIN_APPROVE = /^approve[.!]*$/i;
// Cursor Slack sends append this after the typed line. Slack stores it in
// `text` (and July's `body` when it is an attachment). It is not extra
// words from the person. TLSSN-25's live approve was this shape, so the
// host path treated it as `not_approve` and the model posted the short line.
// Any markup around "Sent using" (`*…*`, `_…_`, none) is the same footer. On
// its own line it runs to the end of the message. The hosted runtime can
// collapse that newline to a space (TLSSN-33: `plan TLSSN-33 *Sent using*
// <@U0EXAMPLE1>`), so an inline footer is chrome too, but only when it ends
// the message with one sender: a mention or a one-word app name.
const SENT_USING_LINE = /(?:\n[ \t]*)+[*_~]*[ \t]*sent using(?![A-Za-z0-9])[\s\S]*$/i;
const SENT_USING_INLINE = /\s+[*_~]*sent using[*_~]*\s+(?:<@[UW][A-Z0-9]+(?:\|[^<>]*)?>|@[\w.-]+|[*_~]*[A-Za-z][\w.-]*[*_~]*)$/i;
const EXACT_DENY_FILE = /^deny\s+file[.!]*$/i;
const PLAIN_DENY = /^deny[.!]*$/i;
const APPROVE_LEASE_MS = 60_000;
// Longer than one approval takes, so a second signal for it (a ✅ and a typed
// approve, or a redelivery) lands inside the hold; short enough that a ticket
// moved back to Planned can be approved again a few minutes later.
export const APPROVE_TICKET_HOLD_MS = 120_000;
// Longer than one approval takes. A hold older than this on a ticket that is
// Planned again is an approval that landed and was undone (moved back to
// Planned), so a new approval takes it over instead of reading as a twin.
export const APPROVE_IN_FLIGHT_MS = 45_000;
// How long a decline in flight keeps the ticket's decision hold; past this a
// decline that never released it (the process died) no longer blocks approvals.
export const DECLINE_HOLD_MS = 5 * 60_000;

export { approveTicketKey };

/**
 * Slack chrome around the person's words: invisible format characters and a
 * Cursor "Sent using" footer, on its own line or inline at the end. Mentions
 * and links stay as sent. Every host parser of a person's words reads this.
 */
export function stripSlackFooter(text: string): string {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/[\u00a0\u2000-\u200d\u202f\u205f\u3000\ufeff]/g, " ")
    .replace(/\p{Cf}/gu, "")
    .trim()
    .replace(SENT_USING_LINE, "")
    .trim()
    .replace(SENT_USING_INLINE, "")
    .trim();
}

/**
 * The command a person typed, without Slack chrome (stripSlackFooter), a
 * leading mention, `<url|KEY>` / `<url>` autolinks, or bold, italic, and code
 * marks, and with a typographic dash in a key read as `-`.
 */
export function approveCommandText(text: string): string {
  return stripSlackFooter(text)
    .replace(LEADING_MENTION, "")
    .replace(/<https?:\/\/[^|>]*\/([A-Za-z][A-Za-z0-9]+-\d+)(?:[/?#][^|>]*)?>/g, "$1")
    .replace(/<(?:[^|>]+)\|([^>]+)>/g, "$1")
    .replace(/[*`~]+/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/\b([A-Za-z][A-Za-z0-9]+)[\u2010-\u2015\u2212](\d+)\b/g, "$1-$2")
    .trim();
}

/** The key of a message that is only `approve KEY`, with an optional leading mention. */
export function approveTarget(text: string): string | undefined {
  const match = EXACT_APPROVE.exec(approveCommandText(text));
  return match === null ? undefined : match[1]!.toUpperCase();
}

/** Prefer top-level `text`; July's `body` / `markdown` hold attachments and unwrapped links. */
export function approveTargetFromMessage(message: SlackMessage): string | undefined {
  for (const text of [message.text, message.body, message.markdown]) {
    if (typeof text !== "string") continue;
    const key = approveTarget(text);
    if (key !== undefined) return key;
  }
  return undefined;
}

/** A message that is only `approve`, with the same chrome allowed as `approve KEY`. */
export function isPlainApprove(message: SlackMessage): boolean {
  if (approveTargetFromMessage(message) !== undefined) return false;
  return isWholeCommand(message, PLAIN_APPROVE);
}

/**
 * Where a plain `approve` goes: the one ticket its thread maps to, `filing`
 * for an unmapped filing thread (left to the route `approve file` takes),
 * or `ask` with the thread's keys (none, or more than one).
 */
export type PlainApprove = { issueKey: string } | { ask: string[] } | "filing";

export async function plainApproveRoute(ctx: SlackBinding, message: SlackMessage): Promise<PlainApprove | undefined> {
  if (!isPlainApprove(message)) return undefined;
  const thread = commandThread(ctx, message);
  const keys = await threadTickets(ctx.host.kv, thread);
  if (keys.length === 1) return { issueKey: keys[0]! };
  if (keys.length === 0 && (await isFilingThread(ctx.host.kv, thread))) return "filing";
  return { ask: keys };
}

/** A message that is only `deny`, with the same chrome allowed as `approve KEY`. */
export function isPlainDeny(message: SlackMessage): boolean {
  return isWholeCommand(message, PLAIN_DENY);
}

/**
 * Where a plain `deny` goes: the one ticket its thread maps to, or `ask`
 * when the thread maps to none or several. Undefined when it is not a plain
 * `deny`, or in an unmapped filing thread (left to the filing turn, as `deny file`).
 */
export type PlainDeny = { issueKey: string } | "ask";

export async function plainDenyKey(ctx: SlackBinding, message: SlackMessage): Promise<PlainDeny | undefined> {
  if (!isPlainDeny(message)) return undefined;
  const thread = commandThread(ctx, message);
  const keys = await threadTickets(ctx.host.kv, thread);
  if (keys.length === 1) return { issueKey: keys[0]! };
  if (keys.length > 1) return "ask";
  try {
    const filing = await ctx.host.kv.get(filingThreadKey(thread));
    return filing === undefined || filing === null ? "ask" : undefined;
  } catch (error) {
    warnKv("approve-command.plainDenyKey", error);
    // Unreadable, it may be a filing thread: left to the filing turn, as `deny file`.
    return undefined;
  }
}

/** A message that is only `deny file`, with the same chrome allowed as `approve KEY`. */
export function isDenyFile(message: SlackMessage): boolean {
  return isWholeCommand(message, EXACT_DENY_FILE);
}

/** Whether any of the message's text forms (`text`, or July's attachment `body` / `markdown`) is only `command`, read through approveCommandText. */
export function isWholeCommand(message: SlackMessage, command: RegExp): boolean {
  return [message.text, message.body, message.markdown].some((text) => typeof text === "string" && command.test(approveCommandText(text)));
}

export type ApproveCommandDeps = { isExternal: (message: SlackMessage) => Promise<boolean>; now?: () => Date };

type Outcome = "not_approve" | "not_eligible" | "not_planned" | "not_moved" | "duplicate" | "approved";
// Which gate refused an exact `approve KEY`, logged so a live refusal
// names its gate (TLSSN-27's could not).
type Why = "bot_or_no_author" | "no_auth" | "external" | "unbound" | "not_filer" | "wrong_thread" | "claim_unavailable" | "status_unread";
type Decision = { outcome: Outcome; why?: Why; issueKey?: string; status?: string };

/**
 * Returns true for every exact `approve KEY`, and for a plain `approve` whose
 * route is `plain`: host code approved it or posted the one reply saying why
 * not, so the handler returns null and no model turn runs (TLSSN-33).
 */
export async function takeApproveCommand(ctx: SlackBinding, message: SlackMessage, deps: ApproveCommandDeps, plain?: Exclude<PlainApprove, "filing">): Promise<boolean> {
  if (plain !== undefined && "ask" in plain) return askForKey(ctx, message, deps, plain.ask);
  const decision = await approve(ctx, message, deps, plain?.issueKey);
  if (decision.outcome === "not_approve") return false;
  console.log(JSON.stringify({ desk: "approve_command", ...decision, ...(plain === undefined ? {} : { plain: true }), channel: ctx.slack.channelId, ts: message.ts }));
  const issueKey = decision.issueKey!;
  const handle = replyPrefix(ctx.slack.channelId);
  const say = (text: string) => ctx.thread.post(text);
  switch (decision.outcome) {
    case "approved":
    case "duplicate":
      return true;
    case "not_eligible":
      if (decision.why === "claim_unavailable") await say(`I could not record your approval of ${issueKey} just now, so nothing moved. Say \`${handle}approve ${issueKey}\` again in a minute.`);
      else await answerRefusal(ctx, decision.why as FilerGateWhy, "approve", issueKey);
      return true;
    case "not_planned":
      if (decision.why === "status_unread") await say(`I could not read ${issueKey} in Jira just now, so nothing moved. Say \`${handle}approve ${issueKey}\` again in a minute.`);
      else if (decision.status !== undefined && decision.status.trim().toLowerCase() === statusNames(process.env).approved.trim().toLowerCase()) await say(`${issueKey} is already Approved, so there is nothing to approve.`);
      else await say(`${issueKey} is ${decision.status ?? "no longer Planned"}, not Planned, so I did not approve it.${decision.status === undefined ? "" : ` Only a Planned ticket can be approved.`}`);
      return true;
    case "not_moved":
      await say(`I could not move ${issueKey} to Approved in Jira, so nothing changed. Say \`${handle}approve ${issueKey}\` again in a minute.`);
      return true;
  }
  return true;
}

/** A plain `approve` in a thread that maps to no ticket, or to several: one line asking for the key. */
async function askForKey(ctx: SlackBinding, message: SlackMessage, deps: ApproveCommandDeps, keys: string[]): Promise<true> {
  const author = message.author?.userId;
  const quiet = author === undefined || author === "" || message.author?.isBot === true || (await deps.isExternal(classifiedSender(ctx, message)));
  console.log(JSON.stringify({ desk: "approve_command", outcome: "no_ticket", plain: true, keys, ...(quiet ? { why: "quiet" } : {}), channel: ctx.slack.channelId, ts: message.ts }));
  if (quiet) return true;
  const say = `\`${replyPrefix(ctx.slack.channelId)}approve KEY\``;
  await ctx.thread.post(
    keys.length === 0
      ? `I can't tell which ticket to approve in this thread, so nothing moved. Say ${say} with the ticket's key.`
      : `This thread has more than one ticket (${keys.join(", ")}), so nothing moved. Say ${say} with the one you mean.`
  );
  return true;
}

function classifiedSender(ctx: SlackBinding, message: SlackMessage): SlackMessage {
  return message.teamId ? message : { ...message, ...(ctx.slack.teamId === undefined || ctx.slack.teamId === "" ? {} : { teamId: ctx.slack.teamId }) };
}

async function approve(ctx: SlackBinding, message: SlackMessage, deps: ApproveCommandDeps, threadKey?: string): Promise<Decision> {
  const issueKey = approveTargetFromMessage(message) ?? threadKey;
  if (issueKey === undefined) return { outcome: "not_approve" };
  const refuse = (why: Why): Decision => ({ outcome: "not_eligible", why, issueKey });
  const author = message.author?.userId;
  if (author === undefined || author === "" || message.author?.isBot === true) return refuse("bot_or_no_author");
  if (defaultSlackAuth(message, ctx) === null) return refuse("no_auth");
  if (await deps.isExternal(classifiedSender(ctx, message))) return refuse("external");
  const kv = ctx.host.kv;
  const ticket = await binding(kv, issueKey);
  const thread = commandThread(ctx, message);
  if (ticket?.originatorUserId === undefined) return refuse("unbound");
  if (ticket.originatorUserId !== author) return refuse("not_filer");
  if (!sameThread(ticket, thread)) return refuse("wrong_thread");

  const claimKey = approveCommandKey({ channelId: ctx.slack.channelId, ts: message.ts });
  const owner = randomUUID();
  const now = deps.now?.() ?? new Date();
  const claim = await takeLease(kv, claimKey, { owner, leaseMs: APPROVE_LEASE_MS, now, fields: { issueKey } });
  if (claim.status === "done" || claim.status === "held") return { outcome: "duplicate", issueKey };
  if (claim.status === "unavailable") {
    await releaseLease(kv, claimKey, owner);
    return refuse("claim_unavailable");
  }

  const approval = await approvePlanned(ctx, { issueKey, author, now, ack: { channel: thread.channelId, ts: message.ts } });
  if (approval.outcome === "approved" || approval.outcome === "duplicate") {
    await finishLease(kv, claimKey, owner, { fields: { outcome: approval.outcome } });
    return { outcome: approval.outcome, issueKey };
  }
  await releaseLease(kv, claimKey, owner);
  switch (approval.outcome) {
    case "claim_unavailable":
      return refuse("claim_unavailable");
    case "not_planned":
      return { outcome: "not_planned", issueKey, ...(approval.status === undefined ? {} : { status: approval.status }), ...(approval.why === undefined ? {} : { why: approval.why }) };
    case "not_moved":
      return { outcome: "not_moved", issueKey };
  }
}

export type ApprovalOutcome =
  | { outcome: "approved" | "duplicate" | "claim_unavailable" | "not_moved" }
  | { outcome: "not_planned"; status?: string; why?: "status_unread" };

/**
 * Planned → Approved for a ticket whose filer's approval has already passed
 * the gates, from a typed approve or a ✅ on the plan post. The hold at
 * `approve-ticket/<KEY>` is taken with a settle re-read before anything is
 * read or moved, and it is left pending on success, so every other signal
 * for this approval inside APPROVE_TICKET_HOLD_MS is a `duplicate` that
 * reads, moves, and posts nothing, unless the hold is older than
 * APPROVE_IN_FLIGHT_MS and the ticket is Planned again (moved back after
 * that approval): then this approval takes it over. Hosted kv can still let two concurrent
 * takers through; then `transitionFrom` is the last guard: the later one
 * finds the ticket `already` Approved and posts no second crumb. `ack` is
 * the person's command message; a reaction has none.
 */
export async function approvePlanned(ctx: SlackBinding, input: { issueKey: string; author: string; now: Date; ack?: AckTarget }): Promise<ApprovalOutcome> {
  const { issueKey, author, now } = input;
  const kv = ctx.host.kv;
  const hold = await takeTicketDecision(ctx, { issueKey, by: author, now, act: "approve" });
  if (hold === "duplicate") return { outcome: "duplicate" };
  if (hold === "unavailable") return { outcome: "claim_unavailable" };
  const yieldHold = async <T extends ApprovalOutcome>(outcome: T): Promise<T> => {
    await hold.release();
    return outcome;
  };

  const statuses = statusNames(process.env);
  const live = await issueStatus(ctx.host.mcp, issueKey);
  if (live.status !== "read" || live.name.trim().toLowerCase() !== statuses.planned.trim().toLowerCase()) {
    return yieldHold(live.status === "read" ? { outcome: "not_planned", status: live.name } : { outcome: "not_planned", why: "status_unread" });
  }
  await recordSlackApproval(kv, { issueKey, at: now, by: author });
  const moved = await transitionFrom(ctx.host.mcp, { issueKey, from: statuses.planned, toStatus: statuses.approved });
  // `already`: an approval that landed between the read and the move (the same
  // person's earlier approve still in flight). The ticket is Approved; keep the
  // record so its webhook stays quiet, and answer this message the same way.
  // `skipped_status`: it left Planned since the read (a replan moved it to
  // Triaged), or its status could not be read again. Nothing moved, so the
  // worker never launches the old brief; the model says why.
  if (moved.status !== "transitioned" && moved.status !== "already") {
    await clearSlackApproval(kv, issueKey);
    return yieldHold({ outcome: moved.status === "skipped_status" ? "not_planned" : "not_moved" });
  }
  if (input.ack !== undefined) await ackCommand({ getClient: () => ctx.host.slack.getClient(), target: input.ack, command: "approve KEY", issueKey });
  if (moved.status === "transitioned") await showImplementingWait(ctx, issueKey);
  await clearPlanDeclined(ctx.host, issueKey);
  return { outcome: "approved" };
}

/**
 * The per-ticket decision hold at `approve-ticket/<KEY>`, shared by every
 * approval and by ❌ on the plan, so an approve and a decline of one ticket
 * never both run. Taken with a settle re-read. A hold older than
 * APPROVE_IN_FLIGHT_MS on a ticket that is Planned again is taken over (the
 * decision it guarded landed and was undone); a new plan post clears it
 * (reaction-targets.ts `recordPlanPost`). `release` drops it; an approval
 * that landed keeps it for APPROVE_TICKET_HOLD_MS instead.
 */
export async function takeTicketDecision(
  ctx: { host: { kv: KeyedKv; mcp: HostMcpRegistry } },
  input: { issueKey: string; by: string; now: Date; act: "approve" | "decline" }
): Promise<{ release: () => Promise<void> } | "duplicate" | "unavailable"> {
  const kv = ctx.host.kv;
  const key = approveTicketKey(input.issueKey);
  const owner = randomUUID();
  const take = (leaseMs: number) => takeLease(kv, key, { owner, leaseMs, now: input.now, settleMs: claimSettleMs(), fields: { by: input.by, act: input.act } });
  // A decline releases its hold when its Jira calls return, however long they
  // hang, so its hold is honoured past the approval lease, up to DECLINE_HOLD_MS.
  const current = await kv.get(key).catch((error: unknown) => warnKv("approve-command.takeTicketDecision", error));
  const declining = pendingLease(current) !== undefined && heldAct(current) === "decline";
  if (declining && !leaseExpired(pendingLease(current)!, DECLINE_HOLD_MS, input.now)) return "duplicate";
  let hold = await take(APPROVE_TICKET_HOLD_MS);
  // Only an approval's hold on a Planned ticket means its decision was undone;
  // a decline never leaves Planned, so a slow one keeps its hold.
  if (hold.status === "held" && !declining && leaseExpired(hold, APPROVE_IN_FLIGHT_MS, input.now) && (await isPlanned(ctx, input.issueKey))) {
    hold = await take(APPROVE_IN_FLIGHT_MS);
  }
  if (hold.status === "held" || hold.status === "done") return "duplicate";
  const release = async () => void (await releaseLease(kv, key, owner));
  if (hold.status === "unavailable") {
    await release();
    return "unavailable";
  }
  return { release };
}

function heldAct(current: unknown): unknown {
  return current !== null && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>)["act"] : undefined;
}

async function isPlanned(ctx: { host: { mcp: HostMcpRegistry } }, issueKey: string): Promise<boolean> {
  const live = await issueStatus(ctx.host.mcp, issueKey);
  return live.status === "read" && live.name.trim().toLowerCase() === statusNames(process.env).planned.trim().toLowerCase();
}

/** Host approve replies nothing; this crumb covers the gap until In Progress. */
async function showImplementingWait(ctx: SlackBinding, issueKey: string): Promise<void> {
  try {
    const client = await ctx.host.slack.getClient();
    await postLoader({ kv: ctx.host.kv, client, issueKey, phase: "implementing" });
  } catch {
    // The ✅ reaction is the ack; In Progress still follows.
  }
}

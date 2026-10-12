// A ticket that needs information is updated by replying in its Slack
// thread. When the desk tells a thread that the planner (Needs info) or
// triage (a needs-info verdict) is waiting for information, it records the
// thread as awaiting. A later human reply there that is not a desk command
// is the update: host code adds it to the ticket as a `Detail from Slack:`
// comment and sends the ticket back to the planner, with no model turn and
// no `plan KEY`. The planner and the desk's triage gate read that comment as
// the answer to a needs-info verdict (triage-comment.ts). `@factory plan KEY`
// still works, and clears the record.
//
// Anyone in the workspace may answer in the thread: the ticket is in
// Triaged with no plan to replace, and approving stays with the filer. A
// Slack Connect sender, a bot (the desk's own posts included), a desk
// command (`approve`/`deny`/`plan`/`replan` KEY or file, a filing request,
// a status question), and a bare acknowledgement go down the normal path
// instead.

import { randomUUID } from "node:crypto";
import { defaultSlackAuth, type SlackBinding, type SlackMessage } from "@cursor/july/channels/slack";
import { stripSlackFooter } from "./approve-command.js";
import { finishLease, leaseExpired, pendingLease, releaseLease, takeLease } from "./claim-lease.js";
import { claimSettleMs, statusNames } from "./config.js";
import { replyPrefix } from "./desk-channels.js";
import { DESK_COMMAND_PHRASES } from "./desk-commands.js";
import { addComment, issueStatus } from "./jira.js";
import { showPlannerWait } from "./planner-wait.js";
import { parseCommands } from "./originator.js";
import { moveToPlanner } from "./plan-move.js";
import { jiraSiteUrl, link, ticketUrl } from "./plan-post.js";
import { isSlackTs, parseThreadRef, ticketKey, type ThreadRef } from "./threads.js";
import { DETAIL_SENTINEL } from "./triage-comment.js";
import { awaitingKey, type KeyedKv, type KvKey, threadDetailKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { awaitingKey };

export type AwaitingKind = "needs_info" | "triage_needs_info";
export type Awaiting = { issueKey: string; kind: AwaitingKind; at: string };

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const DETAIL_MAX = 4000;
// Slack redelivers within seconds; the claim covers the Jira comment, two moves, and the reply.
const DETAIL_LEASE_MS = 120_000;
const LEADING_MENTION = /^(?:<@[A-Z0-9]+(?:\|[^<>]*)?>|@[\w.-]+)[,:]?\s*/;
// Only replies made of these words or emoji. `yes` and `no` are left out: they can answer triage's question.
const ACKNOWLEDGEMENT = /^(?:(?:ok(?:ay)?|k|thanks?|thank you|thx|ty|cheers|great|cool|nice|got it|will do|on it|:[a-z0-9_+'-]+:|\p{Extended_Pictographic})[\s,.!]*)+$/iu;

/** Best effort: without the record, a reply goes to the model, which points at `plan KEY`. */
export async function markAwaiting(kv: KeyedKv, thread: ThreadRef, awaiting: Awaiting): Promise<void> {
  try {
    await kv.put(awaitingKey(thread), awaiting);
  } catch (error) {
    warnKv("thread-detail.markAwaiting", error);
    // The Needs info line still names `plan KEY` for a filer.
  }
}

export async function readAwaiting(kv: KeyedKv, thread: ThreadRef): Promise<Awaiting | undefined> {
  let value: unknown;
  try {
    value = await kv.get(awaitingKey(thread));
  } catch (error) {
    warnKv("thread-detail.readAwaiting", error);
    return undefined;
  }
  return parseAwaiting(value);
}

function parseAwaiting(value: unknown): Awaiting | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const issueKey = record["issueKey"];
  const kind = record["kind"];
  if (typeof issueKey !== "string" || !ISSUE_KEY.test(issueKey) || (kind !== "needs_info" && kind !== "triage_needs_info")) return undefined;
  return { issueKey, kind, at: typeof record["at"] === "string" ? record["at"] : "" };
}

async function clearAwaiting(kv: KeyedKv, thread: ThreadRef): Promise<void> {
  try {
    await kv.delete(awaitingKey(thread));
  } catch (error) {
    warnKv("thread-detail.clearAwaiting", error);
    // A stale record only reaches a ticket whose status is read again first.
  }
}

/** The ticket went back to the planner some other way (`plan KEY`): its thread stops awaiting. */
export async function clearAwaitingFor(kv: KeyedKv, issueKey: string): Promise<void> {
  let bound: unknown;
  try {
    bound = await kv.get(ticketKey(issueKey));
  } catch (error) {
    warnKv("thread-detail.clearAwaitingFor", error);
    return;
  }
  const thread = parseThreadRef(bound);
  if (thread !== undefined) await clearAwaiting(kv, thread);
}

/** Slack mrkdwn as plain text for Jira: links keep their URL, user mentions keep their id. */
export function slackPlainText(raw: string): string {
  return raw
    .replace(LEADING_MENTION, "")
    .replace(/<(https?:\/\/[^|<>\s]+)\|([^<>]*)>/g, (_all, url: string, label: string) => (label === "" || label === url ? url : `${label} (${url})`))
    .replace(/<(https?:\/\/[^|<>\s]+)>/g, "$1")
    .replace(/<mailto:([^|<>]+)(?:\|[^<>]*)?>/g, "$1")
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>/g, "@$1")
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^<>]*))?>/g, (_all, id: string, name?: string) => `#${name ?? id}`)
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function isAcknowledgement(text: string): boolean {
  return ACKNOWLEDGEMENT.test(text.trim());
}

/**
 * A new filing request, or a status question, is a routing-table line for
 * the model, not the missing detail. Only the start of the reply counts:
 * "Status code 500 on /export" is detail, "status of TLSSN-42?" is not.
 */
export function isDeskRequest(text: string): boolean {
  const lower = text.trim().toLowerCase();
  const startsWith = (phrase: string) => lower === phrase || new RegExp(`^${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower);
  if (DESK_COMMAND_PHRASES.filing.some(startsWith)) return true;
  if (/^(?:@\S+\s+)?retry\s+[a-z][a-z0-9]+-\d+\b/.test(lower)) return true;
  return lower.endsWith("?") && DESK_COMMAND_PHRASES.status.some(startsWith);
}

export function detailComment(input: { issueKey: string; author: string; kind: AwaitingKind; text: string }): string {
  const asked = input.kind === "triage_needs_info" ? "triage asked for more information" : "the planner said it needs more information";
  const text = input.text.length <= DETAIL_MAX ? input.text : `${input.text.slice(0, DETAIL_MAX - 1)}…`;
  return [`${DETAIL_SENTINEL} ${input.issueKey}`, `${input.author} replied in the ticket's Slack thread after ${asked}:`, "", text].join("\n");
}

const PASSED_ON = new Set(["not_awaiting", "command", "acknowledgement", "empty", "external", "moved_on"]);

type Handled =
  | "not_awaiting"
  | "command"
  | "acknowledgement"
  | "empty"
  | "external"
  | "moved_on"
  | "no_auth"
  | "duplicate"
  | "claim_unavailable"
  | "status_unknown"
  | "comment_failed"
  | "planned"
  | "not_moved";

export type ThreadDetailDeps = { isExternal: (message: SlackMessage) => Promise<boolean>; now?: () => Date };

/**
 * Take a reply as the missing information, or leave it for the normal path.
 * Returns true when this handler answered the message (no model turn).
 */
export async function takeThreadDetail(ctx: SlackBinding, message: SlackMessage, deps: ThreadDetailDeps): Promise<boolean> {
  const outcome = await threadDetail(ctx, message, deps);
  if (outcome !== "not_awaiting") console.log(JSON.stringify({ desk: "thread_detail", outcome, channel: ctx.slack.channelId, ts: message.ts }));
  return !PASSED_ON.has(outcome);
}

/** The thread's awaiting record. A DM has one conversation, so a DM binding has no thread ts. */
async function awaitingFor(kv: KeyedKv, slack: SlackBinding["slack"]): Promise<{ thread: ThreadRef; awaiting: Awaiting } | undefined> {
  const candidates: ThreadRef[] = isSlackTs(slack.threadTs) ? [{ channelId: slack.channelId, threadTs: slack.threadTs }] : [];
  if (candidates.length === 0 || slack.channelId.startsWith("D")) candidates.push({ channelId: slack.channelId });
  for (const thread of candidates) {
    const awaiting = await readAwaiting(kv, thread);
    if (awaiting !== undefined) return { thread, awaiting };
  }
  return undefined;
}

/**
 * Another delivery of this message (Slack's `app_mention` and `message`
 * twins of a labeled mention) already took it. Read before the awaiting
 * record and the status: the delivery that took it clears the record and
 * bounces the ticket through To Do, so a later twin would read "not
 * awaiting" or "moved on" and go to the model after the host answered.
 */
async function alreadyTaken(kv: KeyedKv, claimKey: KvKey, now: Date): Promise<boolean> {
  let current: unknown;
  try {
    current = await kv.get(claimKey);
  } catch (error) {
    warnKv("thread-detail.alreadyTaken", error);
    return false;
  }
  if (current === undefined || current === null) return false;
  const lease = pendingLease(current);
  return lease === undefined || !leaseExpired(lease, DETAIL_LEASE_MS, now);
}

async function threadDetail(ctx: SlackBinding, message: SlackMessage, deps: ThreadDetailDeps): Promise<Handled> {
  const kv = ctx.host.kv;
  const claimKey = threadDetailKey({ channelId: ctx.slack.channelId, ts: message.ts });
  if (await alreadyTaken(kv, claimKey, deps.now?.() ?? new Date())) return "duplicate";
  const found = await awaitingFor(kv, ctx.slack);
  if (found === undefined) return "not_awaiting";
  const { thread, awaiting } = found;
  const raw = message.text.trim() === "" ? message.body : message.text;
  if (parseCommands(`${raw}\n${message.markdown}`).length > 0) return "command";
  const text = slackPlainText(raw);
  const words = slackPlainText(stripSlackFooter(raw));
  if (words === "") return "empty";
  if (isAcknowledgement(words)) return "acknowledgement";
  if (isDeskRequest(words)) return "command";
  if (defaultSlackAuth(message, ctx) === null) return "no_auth";
  if (await deps.isExternal(message)) return "external";

  const { issueKey } = awaiting;
  const statuses = statusNames(process.env);
  const live = await issueStatus(ctx.host.mcp, issueKey);
  if (live.status === "read" && live.name.trim().toLowerCase() !== statuses.triaged.trim().toLowerCase()) {
    await clearAwaiting(kv, thread);
    return "moved_on";
  }

  const owner = randomUUID();
  const now = deps.now?.() ?? new Date();
  // Two deliveries of one reply that both took the claim would each bounce the ticket and wake the planner twice.
  const claim = await takeLease(kv, claimKey, { owner, leaseMs: DETAIL_LEASE_MS, now, fields: { issueKey }, settleMs: claimSettleMs() });
  if (claim.status === "done" || claim.status === "held") return "duplicate";
  if (claim.status === "unavailable") {
    await releaseLease(kv, claimKey, owner);
    await ctx.thread.post(`I could not record your reply for ${issueKey} just now, so it is not on the ticket yet. Say it again in a minute.`);
    return "claim_unavailable";
  }

  const handle = replyPrefix(ctx.slack.channelId);
  if (live.status !== "read") {
    await releaseLease(kv, claimKey, owner);
    await ctx.thread.post(`I could not read ${issueKey} in Jira just now, so your reply is not on the ticket yet. Say it again in a minute.`);
    return "status_unknown";
  }
  const author = message.author?.userName?.trim() || (message.author?.userId ? `Slack user ${message.author.userId}` : "Someone");
  const comment = await addComment(ctx.host.mcp, { issueKey, body: detailComment({ issueKey, author, kind: awaiting.kind, text }) });
  if (comment.status !== "commented") {
    await releaseLease(kv, claimKey, owner);
    const why = comment.status === "failed" ? comment.message.replace(/\s+/g, " ").slice(0, 200) : "Jira is not connected";
    await ctx.thread.post(`I could not add your reply to ${issueKey} in Jira (${why}), so nothing changed. Say it again in a minute.`);
    return "comment_failed";
  }

  const moved = await moveToPlanner(ctx.host.mcp, { issueKey, current: live.name, statuses, kv: ctx.host.kv });
  const ticket = ticketUrl({ issueKey, site: jiraSiteUrl(process.env) });
  const onJira = ticket === undefined ? "" : ` ${link({ url: ticket, label: `${issueKey} on Jira` })}`;
  if (moved.requested) {
    await clearAwaiting(kv, thread);
    await ctx.thread.post(`Added your reply to ${issueKey} and sent it back to the planner.${onJira}`);
    await showReplanWait(ctx, issueKey);
  } else {
    await ctx.thread.post(
      `Added your reply to ${issueKey}, but could not send it back to the planner (${moved.reason}). Say \`${handle}plan ${issueKey}\` here to try again, or move it to To Do and back to Triaged in Jira.${onJira}`
    );
  }
  await finishLease(kv, claimKey, owner, { fields: { outcome: moved.requested ? moved.reason : `not_moved:${moved.reason}` } });
  return moved.requested ? "planned" : "not_moved";
}

/** The Triaged line is not repeated; this crumb is the wait until a plan or another Needs info. */
async function showReplanWait(ctx: SlackBinding, issueKey: string): Promise<void> {
  await showPlannerWait({ kv: ctx.host.kv, getClient: () => ctx.host.slack.getClient(), issueKey, phase: "replanning" });
}

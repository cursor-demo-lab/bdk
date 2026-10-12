// One Slack thread carries one ticket. The desk binds the two in host.kv
// when it files the ticket (with the person who filed it), or when it posts
// the first update for a ticket filed in Jira (that post is the root, and
// there is no originator). Every later post for the ticket replies under it.
// Pure helpers; the tools own the side effects.

import type { SessionInfo } from "@cursor/july";
import { statusNames } from "./config.js";
import { escapeMrkdwn, fitPlain, link } from "./plan-post.js";
import type { NeedsInfo, PlanStopped } from "./planner-outcome.js";
import type { TriageVerdict } from "./triage-comment.js";
import { triageLine, type TriageCredit } from "./triage-credit.js";
import type { TriageStopped } from "./triage-outcome.js";
import type { LaunchFailed, MoveSkipped } from "./worker-outcome.js";

export type ThreadRef = { channelId: string; threadTs?: string };

/**
 * A ticket's stored binding. No originatorUserId means Slack cannot approve
 * it. `root: "jira"` marks a thread the desk opened in the intake channel,
 * whose top-level status line it keeps current; `rootStatus` is what that
 * line last showed.
 */
export type TicketThread = ThreadRef & { originatorUserId?: string; root?: "jira"; rootStatus?: RootStatus };

/** A root status line: the Jira status, its place in the lifecycle, and the transition's changelog id. */
export type RootStatus = { status: string; rank?: number; changelogId?: string };

/**
 * Planned 1, Approved 2, In Progress 3, In Review (PR open) 4, Done 5. Any
 * other status (a denial is a comment, not a status; a failed launch leaves
 * the ticket where it was or someone moves it) has no rank.
 */
export function rootStatus(input: { status: string; changelogId?: string }, env: NodeJS.ProcessEnv = process.env): RootStatus {
  const names = statusNames(env);
  const ladder = [names.planned, names.approved, names.inProgress, names.inReview, names.done].map((name) => name.toLowerCase());
  const index = ladder.indexOf(input.status.toLowerCase());
  return { status: input.status, ...(index === -1 ? {} : { rank: index + 1 }), ...(input.changelogId === undefined ? {} : { changelogId: input.changelogId }) };
}

const CHANGELOG_ID = /^\d{1,18}$/;

/**
 * Whether `next` may replace what the root shows. Jira numbers changelogs in
 * order, so with two numeric ids the later transition wins, even one that
 * moves the ticket back (a replan, a card dragged back after a failed
 * launch), and a late or replayed delivery never does. Otherwise the rank
 * decides, ties included, and an unranked status never replaces a ranked one.
 */
export function supersedes(next: RootStatus, shown: RootStatus | undefined): boolean {
  if (shown === undefined) return true;
  if (next.changelogId !== undefined && shown.changelogId !== undefined && CHANGELOG_ID.test(next.changelogId) && CHANGELOG_ID.test(shown.changelogId)) {
    return BigInt(next.changelogId) >= BigInt(shown.changelogId);
  }
  if (shown.rank === undefined) return true;
  return next.rank !== undefined && next.rank >= shown.rank;
}

export function sameRootStatus(a: RootStatus | undefined, b: RootStatus | undefined): boolean {
  return a?.status === b?.status && a?.rank === b?.rank && a?.changelogId === b?.changelogId;
}

function parseRootStatus(value: unknown): RootStatus | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["status"] !== "string") return undefined;
  const rank = record["rank"];
  const changelogId = record["changelogId"];
  return {
    status: record["status"],
    ...(typeof rank === "number" && Number.isInteger(rank) ? { rank } : {}),
    ...(typeof changelogId === "string" ? { changelogId } : {}),
  };
}

const CHANNEL_ID = /^[CDG][A-Z0-9]{5,}$/;
const THREAD_TS = /^\d+\.\d+$/;
const USER_ID = /^[UW][A-Z0-9]{2,}$/;

/**
 * A Slack session carries the channel on its principal. The Slack channel
 * stamps `channel_id` and `thread_ts` onto `auth.attributes` while the
 * session is opened. The continuation key is not read: newer sessions do
 * not encode the thread in that string.
 */
export function threadFromSession(session: SessionInfo): ThreadRef | undefined {
  const attributes = session.auth?.attributes;
  if (attributes === undefined) return undefined;
  const channelId = attributes["channel_id"];
  if (typeof channelId !== "string" || !CHANNEL_ID.test(channelId)) return undefined;
  const threadTs = attributes["thread_ts"];
  if (typeof threadTs !== "string" || threadTs === "") {
    return channelId.startsWith("D") ? { channelId } : undefined;
  }
  if (!THREAD_TS.test(threadTs)) return undefined;
  return { channelId, threadTs };
}

export function isSlackUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID.test(value);
}

export function isSlackTs(value: unknown): value is string {
  return typeof value === "string" && THREAD_TS.test(value);
}

/** A stored thread binding. Anything that is not that shape is ignored. */
export function parseThreadRef(value: unknown): TicketThread | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["pendingRoot"] !== undefined || record["state"] === "pending") return undefined;
  const channelId = record["channelId"];
  if (typeof channelId !== "string" || !CHANNEL_ID.test(channelId)) return undefined;
  const originator = isSlackUserId(record["originatorUserId"]) ? { originatorUserId: record["originatorUserId"] } : {};
  if (record["threadTs"] === undefined) return channelId.startsWith("D") ? { channelId, ...originator } : undefined;
  const threadTs = record["threadTs"];
  if (!isSlackTs(threadTs)) return undefined;
  if (record["root"] !== "jira") return { channelId, threadTs, ...originator };
  const shown = parseRootStatus(record["rootStatus"]);
  return { channelId, threadTs, ...originator, root: "jira", ...(shown === undefined ? {} : { rootStatus: shown }) };
}

export function sameThread(a: ThreadRef, b: ThreadRef): boolean {
  return a.channelId === b.channelId && (a.threadTs ?? "") === (b.threadTs ?? "");
}

export type PostTarget = { channel: string; threadTs?: string; root: boolean };

/**
 * Where a ticket's next post goes. A bound ticket always replies in its
 * thread, and a failed reply never falls back to a top-level post. An
 * unbound ticket posts one root into the intake channel, which the caller
 * then binds as the ticket's thread.
 */
export function postTarget(ticket: ThreadRef | undefined, intakeChannel: string | undefined): PostTarget | undefined {
  if (ticket !== undefined) {
    return { channel: ticket.channelId, ...(ticket.threadTs === undefined ? {} : { threadTs: ticket.threadTs }), root: false };
  }
  const channel = (intakeChannel ?? "").trim();
  return channel === "" ? undefined : { channel, root: true };
}

export { announcedKey, ticketKey } from "./kv-keys.js";

/** True once the ticket has left Planned (Approved and every later column). */
export function pastPlanned(status: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const names = statusNames(env);
  const later = [names.approved, names.inProgress, names.inReview, names.done, "Implementing"].map((name) => name.toLowerCase());
  const normalized = status?.trim().toLowerCase();
  return normalized !== undefined && normalized !== "" && later.includes(normalized);
}

// The URL ends the post so Slack's autolink never swallows trailing punctuation.
export function progressMessage(input: { issueKey: string; url: string }): string {
  return `${input.issueKey} is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: ${input.url}`;
}

/**
 * The one post a desk-filed ticket gets at filing time (TLSSN-36): the key
 * as a link, the triage it was filed with and who made it, and, only when
 * it holds, what is true now (it did not reach Triaged, it is a question
 * the planner skips) or the action the reader takes now (the missing
 * detail). No Summary: the filing prompt just showed it. Nothing about later steps. It stands in for the Triaged line, which a desk-filed ticket does
 * not get for this verdict (announce.ts `markFiledTriage`). The filing tool
 * returns it and the turn relays it as its reply.
 */
export function filedMessage(input: {
  issueKey: string;
  url?: string;
  issueType: string;
  severity: string;
  summary?: string;
  credit: TriageCredit;
  triaged: boolean;
  needsInfo?: boolean;
  kind: "bug" | "feedback" | "question";
  nextStep?: string;
}): string {
  const key = input.url === undefined ? input.issueKey : `[${input.issueKey}](${input.url})`;
  const now = !input.triaged
    ? "It did not reach Triaged, so the planner has not started."
    : input.needsInfo === true
      ? "Next: reply here with what you saw, where it happens, and what you expected."
      : input.kind === "question"
        ? "It is a question, so the planner skips it."
        : undefined;
  return [`${key} is filed. ${triageLine(input.credit, { type: input.issueType, severity: input.severity })}.`, ...(now === undefined ? [] : [now])].join("\n");
}

const TRIAGE_STEP_MAX = 300;
const TRIAGE_TYPE_MAX = 40;

/**
 * What the thread hears when a ticket enters Triaged (a ticket filed in Jira,
 * or a later Triaged entry with a new verdict; a desk-filed ticket's first
 * verdict was in its Filed post): the verdict in plain words, who triaged it
 * (`Triaged by Jev: Bug, low severity (78% confidence)`). Scores stay on the Triage:
 * comment. A verdict with a gate says the planner skips it; a needs-info one
 * asks for the detail now. Nothing about later steps: the planner crumb
 * (loader.ts) shows the run. Every field is triage's text from Jira, so each
 * is escaped and cut.
 */
export function triagedMessage(input: { issueKey: string; verdict?: TriageVerdict; replan: boolean }): string {
  const { issueKey, verdict } = input;
  const bare = verdict?.nextStep?.trim().replace(/[.!?]+$/, "");
  const step = bare === undefined || bare === "" ? undefined : escapeMrkdwn(fitPlain(bare, TRIAGE_STEP_MAX));
  const type = verdict?.issueType === undefined ? undefined : escapeMrkdwn(fitPlain(verdict.issueType, TRIAGE_TYPE_MAX));
  const lines = (head: string, next: string | undefined) => [head, ...(next === undefined ? [] : [`Next: ${next}`])].join("\n");
  if (verdict?.gate === "needs_info") {
    return lines(
      `${issueKey} is Triaged, but triage needs more information${step === undefined ? "" : `: ${step}`}.`,
      "reply here with it."
    );
  }
  if (verdict?.gate === "question") {
    return lines(`${issueKey} is Triaged as a question${type === undefined ? "" : ` (Jira type ${type})`}, so the planner skips it.`, undefined);
  }
  if (verdict?.gate === "duplicate") {
    return lines(`${issueKey} is Triaged as a duplicate of ${verdict.duplicateOf ?? "an existing ticket"}, so the planner skips it.`, undefined);
  }
  if (verdict === undefined) return lines(input.replan ? `${issueKey} is Triaged for a new plan.` : `${issueKey} is Triaged.`, undefined);
  const credit = verdictCredit(verdict);
  const words = { type: type ?? verdict.kind, severity: verdict.severity };
  if (credit === undefined) {
    const plain = `${words.type}, ${words.severity} severity`;
    return lines(input.replan ? `${issueKey} is Triaged for a new plan: ${plain}.` : `${issueKey} is Triaged: ${plain}.`, undefined);
  }
  const line = triageLine(credit, words);
  return lines(input.replan ? `${issueKey} is Triaged for a new plan. ${line}.` : `${issueKey} is ${line}.`, undefined);
}

/**
 * Who triaged a verdict read from its Triage: comment, with the model's name
 * and Jev's percent from its `Triaged by:` line. A comment with no such line
 * (a person's verdict, or one written before the line existed) credits no one.
 */
export function verdictCredit(verdict: TriageVerdict): TriageCredit | undefined {
  const by = verdict.triagedBy;
  if (by === undefined) return undefined;
  const model = verdict.triageModel === undefined ? undefined : escapeMrkdwn(fitPlain(verdict.triageModel, TRIAGE_TYPE_MAX));
  return {
    by,
    ...(model === undefined ? {} : { model }),
    ...(verdict.confidence === undefined ? {} : { percent: verdict.confidence }),
    ...(by === "model" && verdict.fallback !== undefined ? { reason: verdict.fallback } : {}),
  };
}

const OUTCOME_FIELD_MAX = 300;

/** `prefix` goes before a command in copy: "" where a plain reply reaches the desk (desk-channels.ts `replyPrefix`). */
export type OutcomeMessageInput = { issueKey: string; originatorUserId?: string; link?: { url: string; label: string }; prefix: string };

/**
 * The planner found no sign of the claimed failure on the sandbox and left
 * `Needs info:` on the ticket, which stays Triaged. Every field is the
 * planner's text from Jira, so each is escaped and cut.
 */
export function needsInfoMessage(input: OutcomeMessageInput & { outcome?: NeedsInfo }): string {
  const { issueKey, outcome } = input;
  const ref = outcome?.ref === undefined ? undefined : safe(outcome.ref);
  const where = outcome?.repo === undefined || ref === undefined ? "the sandbox" : `${safe(outcome.repo)}@${ref}`;
  const lines = [`${mention(input)}${issueKey} needs more information, so it has no plan. The planner checked ${where} and did not find the problem the ticket describes.`];
  if (outcome?.claimed !== undefined) lines.push(`\u2022 Ticket claimed: ${safe(outcome.claimed)}`);
  if (outcome?.mismatch !== undefined && ref !== undefined) lines.push(`\u2022 On ${ref}: ${safe(outcome.mismatch)}`);
  if (outcome !== undefined && outcome.searched.length > 0) lines.push(`\u2022 Searched: ${safe(outcome.searched.join("; "))}`);
  const orCommand = input.originatorUserId === undefined ? "" : ` If you edit the ticket in Jira instead, say \`${input.prefix}plan ${issueKey}\` here.`;
  lines.push(
    `Next: reply here with a file path, error message, or steps that fail on ${ref ?? "the sandbox"}.${orCommand} If it no longer applies, close the ticket.${linkSuffix(input)}`
  );
  return lines.join("\n");
}

/** A planning run that ended with neither a plan nor Needs info left `Plan stopped:` with the reason. */
export function planStoppedMessage(input: OutcomeMessageInput & { outcome?: PlanStopped }): string {
  const why = input.outcome?.why === undefined ? "The reason is on the ticket." : safe(input.outcome.why);
  return [
    `${mention(input)}${input.issueKey} has no plan: the planner stopped before it recorded one.`,
    `Why: ${why}`,
    `Next: ${planAgain(input)}.${linkSuffix(input)}`,
  ].join("\n");
}

/**
 * Triage left `Triage stopped:`: its run ended before the ticket reached
 * Triaged, so the ticket is still in To Do and the planner never woke. The
 * reason is triage's text from Jira, so it is escaped and cut.
 */
export function triageStoppedMessage(input: OutcomeMessageInput & { outcome?: TriageStopped }): string {
  const why = input.outcome?.why === undefined ? "The reason is on the ticket." : safe(input.outcome.why);
  const next =
    input.originatorUserId === undefined
      ? `move ${input.issueKey} to Triaged in Jira to send it to the planner`
      : `say \`${input.prefix}plan ${input.issueKey}\` here to send it to the planner`;
  return [
    `${mention(input)}${input.issueKey} is still in To Do: triage stopped before it moved the ticket to Triaged, so the planner has not started.`,
    `Why: ${why}`,
    `Next: ${next}.${linkSuffix(input)}`,
  ].join("\n");
}

/**
 * The worker's launch threw after the Approved line promised an agent link.
 * The ticket stays Approved and the worker released its claim, so a new move
 * into Approved launches again. `approve KEY` moves only from Planned.
 */
export function launchFailedMessage(input: OutcomeMessageInput & { outcome?: LaunchFailed }): string {
  const reason = input.outcome?.reason === undefined ? "" : ` (${safe(input.outcome.reason)})`;
  const next =
    input.originatorUserId === undefined
      ? `move ${input.issueKey} to Planned and back to Approved in Jira to launch it again`
      : `move ${input.issueKey} to Planned in Jira, then say \`${input.prefix}approve ${input.issueKey}\` here to launch it again`;
  return [
    `${mention(input)}${input.issueKey} is Approved, but nothing is being built: the cloud agent launch failed${reason}.`,
    `Next: ${next}.${linkSuffix(input)}`,
  ].join("\n");
}

/**
 * The ticket reached Approved with no `Plan:` comment carrying a brief, so
 * the worker launched nothing. `plan KEY` does not move an Approved ticket,
 * so the next step is the board.
 */
export function approvedWithoutPlanMessage(input: OutcomeMessageInput): string {
  return [
    `${mention(input)}${input.issueKey} is Approved, but nothing is being built: the ticket has no plan, so the worker launched nothing.`,
    `Next: move ${input.issueKey} back to Triaged in Jira to run the planner.${linkSuffix(input)}`,
  ].join("\n");
}

/**
 * The worker's implement PR opened or merged, but it did not move the ticket
 * (another status, no transition, a failed move). The detail is the worker's
 * text from Jira. Nobody is mentioned: a failed move retries on its own.
 */
export function moveSkippedMessage(input: OutcomeMessageInput & { outcome?: MoveSkipped }): string {
  const outcome = input.outcome;
  const head =
    outcome === undefined
      ? `The factory did not move ${input.issueKey} for its pull request.`
      : `The factory did not move ${input.issueKey} to ${safe(outcome.target)} for ${safe(outcome.pr)}${outcome.detail === undefined ? "." : `: ${safe(outcome.detail)}`}`;
  return `${head}${linkSuffix(input)}`;
}

// Only the filer can ask for a plan from Slack; a thread with no approver on
// record plans again from the board.
function planAgain(input: OutcomeMessageInput): string {
  return input.originatorUserId === undefined
    ? `move ${input.issueKey} to To Do and back to Triaged in Jira to run the planner again`
    : `say \`${input.prefix}plan ${input.issueKey}\` here to run the planner again`;
}

function mention(input: OutcomeMessageInput): string {
  return input.originatorUserId === undefined ? "" : `<@${input.originatorUserId}> `;
}

function linkSuffix(input: OutcomeMessageInput): string {
  return input.link === undefined ? "" : ` ${link(input.link)}`;
}

function safe(text: string): string {
  return escapeMrkdwn(fitPlain(text.replace(/\s+/g, " ").trim(), OUTCOME_FIELD_MAX));
}

/**
 * A move back into Planned from a later column: someone, or something, rolled
 * the ticket back. From Approved it is also the retry path after a failed
 * launch, whose claim the worker released, so approving again launches.
 */
export function movedBackMessage(input: { issueKey: string; from: string; approved?: string }): string {
  const head = `${input.issueKey} moved back to Planned from ${escapeMrkdwn(input.from)}.`;
  if (input.approved !== undefined && input.from.trim().toLowerCase() === input.approved.trim().toLowerCase()) {
    return `${head} Approving it again retries a launch that failed; an implementation that already started is not stopped or launched twice.`;
  }
  return `${head} The implementation that already started is not stopped, and the factory does not launch it again.`;
}

type PullRequestLink = { url: string; label: string };

/**
 * The PR comes from the worker's `Pull request:` comment; a card moved by
 * hand, or a comment that could not be written or read, has none, and the
 * line says so rather than claim a pull request it cannot name.
 */
export function inReviewMessage(input: { issueKey: string; pr?: PullRequestLink }): string {
  if (input.pr === undefined) {
    return `${input.issueKey} is In Review. No pull request link is on the ticket; the factory's pull request title starts with "${input.issueKey}: ".`;
  }
  return `${input.issueKey} is In Review: ${link(input.pr)} is open.`;
}

export function doneMessage(input: { issueKey: string; pr?: PullRequestLink; mergedBy?: string }): string {
  if (input.pr === undefined) return `${input.issueKey} is Done. No pull request link is on the ticket.`;
  const by = input.mergedBy === undefined || input.mergedBy.trim() === "" ? "" : ` by ${input.mergedBy.trim()}`;
  return `${input.issueKey} is Done: ${link(input.pr)} was merged${by}.`;
}

export function approvedMessage(input: { issueKey: string }): string {
  return `${input.issueKey} is Approved.`;
}

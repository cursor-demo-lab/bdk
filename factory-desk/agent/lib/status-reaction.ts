// Outbound status reactions on the message that filed a ticket, so
// #mars-eng-intake shows where each request is without opening its thread.
// These are one-way progress marks on the thread root. The only reactions
// the desk reads are a person's ✅ / ❌ on its filing prompt or plan post
// (reaction-approval.ts), never these, which are its own. The desk keeps one
// status reaction on the filer's message: each new stage adds its emoji,
// then removes the one it recorded before. Best effort throughout: a failed
// reaction never blocks or fails the announcement it follows.

import { isIntakeCandidate, type IntakeCandidateMessage } from "./intake-candidate.js";
import { isSlackTs, type TicketThread } from "./threads.js";
import { type KeyedKv, reactionKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { reactionKey };

export const STATUS_REACTIONS = {
  /** A filing request reached the desk, or the ticket was filed and triage runs. */
  received: "eyes",
  triaged: "eyes",
  /** The planner is checking the ticket (after Triaged, before Planned / Needs info). */
  planning: "hourglass_flowing_sand",
  /** A plan is in the thread and waits for `approve KEY`. */
  planned: "memo",
  /** The plan was declined (❌ or `deny`); a new plan or an approval replaces it. */
  declined: "no_entry_sign",
  /** Approved or In Progress: a cloud agent is building it. */
  building: "hammer_and_wrench",
  /** The implement pull request is open for a person to review. */
  in_review: "mag",
  done: "white_check_mark",
  /** A person has to answer: triage or the planner needs information, or triage will not plan it. */
  needs_person: "question",
  /** Triage or the planner stopped, a launch failed, it was approved without a plan, or a hop watch found the hop quiet past its deadline. */
  stopped: "warning",
} as const;

export type StatusStage = keyof typeof STATUS_REACTIONS;

type ReactionRecord = { channel: string; ts: string; name: string; changelogId?: string };
type SlackApi = { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };

/**
 * The ticket's thread root in a channel: the filer's message for a Slack
 * filing, or the intake root the desk opened for a Jira-filed ticket, so the
 * channel shows every ticket's stage the same way. A DM has no parent
 * message and gets none.
 */
export function reactionTarget(ticket: TicketThread | undefined): { channel: string; ts: string } | undefined {
  if (ticket === undefined || ticket.threadTs === undefined) return undefined;
  if (!/^[CG]/.test(ticket.channelId)) return undefined;
  return { channel: ticket.channelId, ts: ticket.threadTs };
}

function slackApi(client: unknown): SlackApi | undefined {
  const call = (client as { apiCall?: unknown } | null | undefined)?.apiCall;
  return typeof call === "function" ? (client as SlackApi) : undefined;
}

function parseRecord(value: unknown): ReactionRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { channel, ts, name, changelogId } = record;
  if (typeof channel !== "string" || typeof ts !== "string" || typeof name !== "string") return undefined;
  return { channel, ts, name, ...(typeof changelogId === "string" ? { changelogId } : {}) };
}

const NUMERIC = /^\d{1,18}$/;

// Jira numbers changelogs in order, so a transition older than the one the
// reaction shows is a late delivery. Outcome comments carry no changelog id
// and are already gated on the ticket's live status by announceOutcome.
function stale(changelogId: string | undefined, shown: ReactionRecord | undefined): boolean {
  if (changelogId === undefined || shown?.changelogId === undefined) return false;
  if (!NUMERIC.test(changelogId) || !NUMERIC.test(shown.changelogId)) return false;
  return BigInt(changelogId) < BigInt(shown.changelogId);
}

async function call(api: SlackApi, method: string, args: Record<string, unknown>): Promise<"ok" | "already" | "failed"> {
  try {
    await api.apiCall(method, args);
    return "ok";
  } catch (error) {
    const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
    return code === "already_reacted" || code === "no_reaction" ? "already" : "failed";
  }
}

export type ReactionOutcome = "set" | "unchanged" | "stale" | "no_target" | "no_client" | "failed";

/**
 * Show `stage` on the ticket's filer message: add its emoji, then remove the
 * emoji recorded for the previous stage, then record this one. A kv read
 * that fails adds the emoji and removes nothing, since the previous stage is
 * unknown. A transition older than the one shown changes nothing.
 */
export async function setStatusReaction(input: {
  kv: KeyedKv;
  client: unknown;
  issueKey: string;
  ticket: TicketThread | undefined;
  stage: StatusStage;
  changelogId?: string;
}): Promise<ReactionOutcome> {
  const target = reactionTarget(input.ticket);
  if (target === undefined) return "no_target";
  const api = slackApi(input.client);
  if (api === undefined) return "no_client";
  const key = reactionKey(input.issueKey);
  const name = STATUS_REACTIONS[input.stage];
  let shown: ReactionRecord | undefined;
  let readable = true;
  try {
    const current = parseRecord(await input.kv.get(key));
    shown = current !== undefined && current.channel === target.channel && current.ts === target.ts ? current : undefined;
  } catch (error) {
    warnKv("status-reaction.setStatusReaction.get", error);
    readable = false;
  }
  if (stale(input.changelogId, shown)) return "stale";
  if (shown?.name === name && (input.changelogId === undefined || !NUMERIC.test(input.changelogId))) return "unchanged";
  if ((await call(api, "reactions.add", { channel: target.channel, timestamp: target.ts, name })) === "failed") return "failed";
  if (shown !== undefined && shown.name !== name) await call(api, "reactions.remove", { channel: target.channel, timestamp: target.ts, name: shown.name });
  if (!readable) return "set";
  const changelogId = input.changelogId !== undefined && NUMERIC.test(input.changelogId) ? input.changelogId : shown?.changelogId;
  try {
    await input.kv.put(key, { ...target, name, ...(changelogId === undefined ? {} : { changelogId }) });
  } catch (error) {
    warnKv("status-reaction.setStatusReaction.put", error);
    // The emoji is on the message; the next stage just cannot remove it.
  }
  return "set";
}

type IntakeMessage = IntakeCandidateMessage;

/** A top-level channel message that is a new request (`isIntakeCandidate`). */
export function isIntakeRequest(message: IntakeMessage): boolean {
  if (!/^[CG]/.test(message.channelId) || !isSlackTs(message.ts)) return false;
  if (message.threadTs !== undefined && message.threadTs !== "" && message.threadTs !== message.ts) return false;
  return isIntakeCandidate(message);
}

/**
 * 👀 on a filing request as soon as it reaches the desk, before the model's
 * draft reply. Nothing is recorded: `file_ticket` records the same emoji
 * when the ticket is filed, so the next stage replaces it.
 */
export async function ackIntake(client: unknown, message: IntakeMessage): Promise<boolean> {
  if (!isIntakeRequest(message)) return false;
  const api = slackApi(client);
  if (api === undefined) return false;
  return (await call(api, "reactions.add", { channel: message.channelId, timestamp: message.ts, name: STATUS_REACTIONS.received })) !== "failed";
}

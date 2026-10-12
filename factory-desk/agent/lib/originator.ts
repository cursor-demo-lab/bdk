// Slack approvals are honoured only for the person who filed the ticket,
// and only in the ticket's own thread. The session cannot say who is
// speaking: July freezes session.auth when a thread's session opens, so
// every later message carries the starter's user_id. The Slack inbound
// handler therefore records each message's author in host.kv, and the gated
// tools read that record. A missing record refuses; it never approves.

import type { SessionInfo } from "@cursor/july";
import { isExternalSlackSender, type SlackApiTransport, type SlackBinding, type SlackMessage, type SlackMessageHandler } from "@cursor/july/channels/slack";
import { plainDenyKey } from "./approve-command.js";
import { commandThread } from "./command-thread.js";
import { stagingWriteRefusal } from "./jira.js";
import { deleteVerified } from "./kv-verified.js";
import { updateVerifiedDesk } from "./kv-verified-desk.js";
import { isSlackTs, isSlackUserId, parseThreadRef, sameThread, threadFromSession, ticketKey, type ThreadRef } from "./threads.js";
import { commandKey, type KeyedKv, type KvKey, speakerKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { commandKey, speakerKey };

export type CommandVerb = "approve" | "deny" | "plan" | "replan";

/** `target` is `file` or an upper-case issue key. */
export type Command = { verb: CommandVerb; target: string };

const COMMAND = /\b(approve|deny|replan|plan)\s+(file|[A-Za-z][A-Za-z0-9]+-\d+)\b/gi;
const NEGATED = /(?:\bnot|\bnever|n't|\bdont)\b(?:\W+\w+){0,3}\W*$/i;

export function parseCommands(text: string): Command[] {
  const seen = new Set<string>();
  const commands: Command[] = [];
  for (const match of text.matchAll(COMMAND)) {
    const clause = text.slice(0, match.index).split(/[.!?\n]/).at(-1) ?? "";
    if (NEGATED.test(clause)) continue;
    const verb = match[1]!.toLowerCase() as CommandVerb;
    const raw = match[2]!;
    const target = raw.toLowerCase() === "file" ? "file" : raw.toUpperCase();
    const id = `${verb}:${target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    commands.push({ verb, target });
  }
  return commands;
}

/** `reaction`: a ✅ on the filing prompt stood in for the command, so `ts` is the reaction's event, not a message to ack. */
export type Spoken = { userId: string; ts: string; reaction?: true };

function parseSpoken(value: unknown): Spoken | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isSlackUserId(record["userId"]) || !isSlackTs(record["ts"])) return undefined;
  return { userId: record["userId"], ts: record["ts"], ...(record["reaction"] === true ? { reaction: true as const } : {}) };
}

/** Slack message order: seconds, then the fraction. Too many digits for a double. */
export function compareSlackTs(a: string, b: string): number {
  const [aSeconds = "0", aFraction = ""] = a.split(".");
  const [bSeconds = "0", bFraction = ""] = b.split(".");
  const order = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
  return order(BigInt(aSeconds), BigInt(bSeconds)) || order(BigInt(aFraction.padEnd(9, "0")), BigInt(bFraction.padEnd(9, "0")));
}

function storedTs(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ts = (value as Record<string, unknown>)["ts"];
  return isSlackTs(ts) ? ts : undefined;
}

/** A real approval names one or two commands; the rest of a long message is not recorded. */
export const MAX_RECORDED_COMMANDS = 5;

/**
 * The latest author in the thread, plus one record per command they typed,
 * up to MAX_RECORDED_COMMANDS. The first message in a thread creates both.
 * Slack can deliver a message late or twice, so neither record moves back:
 * an older message never replaces a newer speaker, and a command record or
 * its tombstone is replaced only by a newer message. Each write is verified
 * after it lands; one that cannot be verified leaves a command unvouched.
 */
export async function recordSpeaker(kv: KeyedKv, input: { thread: ThreadRef; userId: string; ts: string; text: string; reaction?: true; commands?: readonly Command[] }): Promise<void> {
  const spoken: Spoken = { userId: input.userId, ts: input.ts, ...(input.reaction === true ? { reaction: true as const } : {}) };
  const olderThan = (strictly: boolean) => (current: unknown) => {
    const ts = storedTs(current);
    const order = ts === undefined ? 1 : compareSlackTs(input.ts, ts);
    return order > 0 || (!strictly && order === 0) ? spoken : undefined;
  };
  await updateVerifiedDesk(kv, speakerKey(input.thread), olderThan(false));
  const typed = parseCommands(input.text);
  const extra = (input.commands ?? []).filter((command) => !typed.some((seen) => seen.verb === command.verb && seen.target === command.target));
  for (const command of [...typed, ...extra].slice(0, MAX_RECORDED_COMMANDS)) {
    await updateVerifiedDesk(kv, commandKey(input.thread, command), olderThan(true));
  }
}

/**
 * Wraps an inbound handler so every human message from this workspace is
 * recorded before the turn starts. July drops an external (Slack Connect)
 * sender only after the handler runs (channels/slack/dispatch.js:306,404),
 * so the handler checks membership itself with July's own classifier and
 * cache; a failed lookup counts as external and records nothing.
 */
export function recordingSpeakers(inner: SlackMessageHandler): SlackMessageHandler {
  return async (ctx, message) => {
    const author = message.author;
    if (author !== undefined && author.isBot !== true && isSlackUserId(author.userId) && isSlackTs(message.ts) && !(await fromOutside(ctx, message, author.userId))) {
      // The same thread plainDenyKey reads, and the session's thread_ts that gateCommand looks up.
      const thread = commandThread(ctx, message);
      try {
        // A plain `deny` names no key; the gate on deny_ticket needs `deny KEY` for the thread's one ticket.
        const deny = await plainDenyKey(ctx, message).catch(() => undefined);
        const commands: Command[] = typeof deny === "object" ? [{ verb: "deny", target: deny.issueKey }] : [];
        await recordSpeaker(ctx.host.kv, { thread, userId: author.userId, ts: message.ts, text: `${message.text}\n${message.markdown}`, commands });
      } catch {
        // Unrecorded, a gated command in this message is refused, not approved.
      }
    }
    return inner(ctx, message);
  };
}

type HostSlack = SlackBinding["host"]["slack"];

// July keys its users.info cache by the token object and never drops a key,
// and a key here closes over the host client. One transport per host Slack
// binding (one per agent process) keeps that to one entry; a transport per
// message kept every such message's transport and its cached user record.
const hostTransports = new WeakMap<HostSlack, SlackApiTransport>();

export function hostSlackTransport(slack: HostSlack): SlackApiTransport {
  let transport = hostTransports.get(slack);
  if (transport === undefined) {
    transport = {
      kind: "api-transport",
      label: "factory-desk host slack",
      call: async (method, args) => (await (await slack.getClient()).apiCall(method, args)) as unknown as Record<string, unknown>,
    };
    hostTransports.set(slack, transport);
  }
  return transport;
}

async function fromOutside(ctx: SlackBinding, message: SlackMessage, userId: string): Promise<boolean> {
  const teamId = message.teamId ?? ctx.slack.teamId;
  if (teamId === undefined || teamId === "") return true;
  return isExternalSlackSender({ botToken: hostSlackTransport(ctx.host.slack), slackTeamId: teamId, userId });
}

export const COMMAND_TTL_SECONDS = 600;

/**
 * Who typed the command. Only a command record vouches, and only when it is
 * at most COMMAND_TTL_SECONDS old and came from the latest human message in
 * the thread: an earlier command-shaped line from the filer must not approve
 * a turn that a later message started. Every matching record is consumed,
 * fresh or not, and one whose tombstone cannot be verified does not vouch,
 * so it can never vouch twice. The tombstone keeps the message ts, so a
 * redelivery of that message cannot write the command back.
 */
export async function resolveCaller(kv: KeyedKv, thread: ThreadRef, commands: readonly Command[], now: Date): Promise<string | undefined> {
  return (await resolveCommand(kv, thread, commands, now))?.userId;
}

/** resolveCaller, plus the ts of the message that typed the command, which the desk acks. */
export async function resolveCommand(kv: KeyedKv, thread: ThreadRef, commands: readonly Command[], now: Date): Promise<Spoken | undefined> {
  const latest = parseSpoken(await readKv(kv, speakerKey(thread)));
  let caller: Spoken | undefined;
  for (const command of commands) {
    const key = commandKey(thread, command);
    const spoken = parseSpoken(await readKv(kv, key));
    if (spoken === undefined) continue;
    const consumed = await consume(kv, key, spoken, now);
    const age = now.getTime() / 1000 - Number(spoken.ts);
    const current = latest?.userId === spoken.userId && latest.ts === spoken.ts;
    if (caller === undefined && consumed && current && age >= -60 && age <= COMMAND_TTL_SECONDS) caller = spoken;
  }
  return caller;
}

async function readKv(kv: KeyedKv, key: KvKey): Promise<unknown> {
  try {
    return await kv.get(key);
  } catch (error) {
    warnKv("originator.readKv", error);
    // An unreadable record vouches for nobody.
    return undefined;
  }
}

/**
 * Only the record that was resolved is consumed: a newer command written
 * since the read is left in place, and this turn is refused. A tombstone
 * that cannot be written refuses too; the record is then deleted only while
 * it is still the one that was resolved.
 */
async function consume(kv: KeyedKv, key: KvKey, spoken: Spoken, now: Date): Promise<boolean> {
  const resolved = (current: unknown) => {
    const stored = parseSpoken(current);
    return stored?.ts === spoken.ts && stored.userId === spoken.userId;
  };
  const tombstone = await updateVerifiedDesk(kv, key, (current) => (resolved(current) ? { ts: spoken.ts, consumedAt: now.toISOString() } : undefined));
  if (tombstone.status === "written") return true;
  if (tombstone.status === "unavailable") await deleteVerified(kv, key, resolved);
  return false;
}

export type Gate =
  | { status: "ok"; originatorUserId: string; commandTs?: string }
  | { status: "jira_only"; filedIn?: "slack" }
  | { status: "unavailable" }
  | { status: "wrong_thread"; originatorUserId: string; ticketThread: ThreadRef }
  | { status: "not_originator"; originatorUserId: string; callerUserId?: string }
  | { status: "staging_refused"; message: string };

export function checkOriginator(input: { ticket?: ThreadRef & { originatorUserId?: string }; thread?: ThreadRef; callerUserId?: string }): Gate {
  const { ticket, thread, callerUserId } = input;
  if (ticket?.originatorUserId === undefined) return { status: "jira_only" };
  const originatorUserId = ticket.originatorUserId;
  const ticketThread: ThreadRef = { channelId: ticket.channelId, ...(ticket.threadTs === undefined ? {} : { threadTs: ticket.threadTs }) };
  if (thread === undefined || !sameThread(thread, ticketThread)) return { status: "wrong_thread", originatorUserId, ticketThread };
  if (callerUserId !== originatorUserId) {
    return { status: "not_originator", originatorUserId, ...(callerUserId === undefined ? {} : { callerUserId }) };
  }
  return { status: "ok", originatorUserId };
}

export type GateContext = { session: SessionInfo; host: { kv: KeyedKv }; now(): Date };

/**
 * Gate a Slack command on a ticket. `unbound: "allow"` lets a ticket with no
 * binding at all through (a first `plan KEY` on a ticket filed in Jira).
 * A binding that cannot be read is `unavailable`, never unbound.
 */
export async function gateCommand(
  ctx: GateContext,
  input: { issueKey: string; verbs: readonly CommandVerb[]; unbound?: "allow" | "refuse" }
): Promise<Gate | { status: "unbound" }> {
  // A staging slug takes no command on a key outside its projects, bound or
  // not, before reading anything about it (jira.ts stagingWriteRefusal).
  const refused = stagingWriteRefusal(input.issueKey);
  if (refused !== undefined) return { status: "staging_refused", message: refused };
  let stored: unknown;
  try {
    stored = await ctx.host.kv.get(ticketKey(input.issueKey));
  } catch (error) {
    warnKv("originator.gateCommand", error);
    return { status: "unavailable" };
  }
  if (stored === undefined && input.unbound === "allow") return { status: "unbound" };
  const ticket = parseThreadRef(stored);
  if (ticket?.originatorUserId === undefined) return ticket !== undefined && ticket.root !== "jira" ? { status: "jira_only", filedIn: "slack" } : { status: "jira_only" };
  const thread = threadFromSession(ctx.session);
  if (thread === undefined || !sameThread(thread, ticket)) return checkOriginator({ ticket, ...(thread === undefined ? {} : { thread }) });
  const caller = await resolveCommand(ctx.host.kv, thread, input.verbs.map((verb) => ({ verb, target: input.issueKey })), ctx.now());
  const gate = checkOriginator({ ticket, thread, ...(caller === undefined ? {} : { callerUserId: caller.userId }) });
  return gate.status === "ok" && caller !== undefined ? { ...gate, commandTs: caller.ts } : gate;
}

/**
 * The fields a refused tool call returns, beside its own `issueKey` and
 * outcome flag. `for: "plan"` words a `jira_only` refusal for request_plan.
 */
export function refusal(gate: Exclude<Gate, { status: "ok" }>, options: { for?: "plan" } = {}): Record<string, string> {
  switch (gate.status) {
    case "jira_only":
      if (options.for === "plan") {
        return { status: "jira_only", reason: "jira_only", howToPlan: "Move the card in Jira to plan or re-plan it. From Slack, anyone can ask for a first plan only while an unthreaded ticket is in To Do, and only the filer can re-plan a ticket filed in Slack." };
      }
      return {
        status: "jira_only",
        reason: "jira_only",
        howToApprove:
          gate.filedIn === "slack"
            ? "Move the card to Approved in Jira. This ticket has no Slack approver on record, so Slack cannot approve it."
            : "Move the card to Approved in Jira. This ticket was filed in Jira, so Slack cannot approve it.",
      };
    case "unavailable":
      return { status: "unavailable", reason: "unavailable", retry: "The desk could not read this ticket's record just now. Nothing changed; say it again in a minute." };
    case "wrong_thread":
      return { status: "wrong_thread", reason: "wrong_thread" };
    case "not_originator":
      return { status: "not_originator", reason: "not_originator", originatorUserId: gate.originatorUserId };
    case "staging_refused":
      return { status: "staging_refused", reason: "staging_refused", message: gate.message };
  }
}

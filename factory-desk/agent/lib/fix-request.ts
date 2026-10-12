// A request to fix a pull request is answered in the thread without a model
// turn. The desk never writes to GitHub; the opt-in is a `factory: drive`
// comment a person types on the PR, because hosted GitHub ingress drops
// comments by bots before the fixer sees them.
//
// The short circuit is narrow on purpose. After trimming and removing the
// bot's mention, the whitespace-separated tokens must be exactly a fix verb
// from the routing table, optionally `on` or `for`, one PR reference, and
// nothing after it but `.`, `!` or `?`. The reference is one token, so a
// command word inside a repo name is never read as a command. An exact
// `approve KEY` from the filer in the ticket's thread is approved in host
// code (approve-command.ts), and a reply in a thread that is waiting for
// information is the ticket update (thread-detail.ts). Anything else goes to the model, which the
// instructions tell to give the same answer and to handle every other line,
// so no part of a message is swallowed.

import {
  createDefaultOnInbound,
  defaultSlackAuth,
  isExternalSlackSender,
  type SlackApiTransport,
  type SlackBinding,
  type SlackMessage,
  type SlackMessageHandler,
} from "@cursor/july/channels/slack";
import { deskSlackHandle } from "./config.js";
import { bareReplyReaches } from "./desk-channels.js";
import { learnDeskSelfIdentity } from "./self-identity.js";
import { ackIntake, isIntakeRequest } from "./status-reaction.js";
import { DESK_COMMAND_PHRASES } from "./desk-commands.js";
import { hasFilingPhrase, isIntakeCandidate } from "./intake-candidate.js";
import { parseCommands, type Command } from "./originator.js";
import { isDenyFile, plainApproveRoute, plainDenyKey, stripSlackFooter, takeApproveCommand, type PlainApprove, type PlainDeny } from "./approve-command.js";
import { ackCommand } from "./command-ack.js";
import { commandThread } from "./command-thread.js";
import { takePlanCommand } from "./plan-command.js";
import { takeRetryCommand } from "./retry-command.js";
import { firstDelivery, isHostTicketCommand } from "./handled-message.js";
import { dropIntakeTriage, intakeTriageContext, pendingIntake, stashIntakeTriage, triageIntake } from "./intake-triage.js";
import { takeThreadDetail } from "./thread-detail.js";
import { markFilingThread } from "./thread-tickets.js";
import { isSlackTs, type ThreadRef } from "./threads.js";

export type PullRequestRef = { owner: string; repo: string; number: number; url: string; label: string };

// At most one: the bot's own mention. July keeps it in `markdown` as `@U…`.
const LEADING_MENTION = /^(?:<@[A-Z0-9]+(?:\|[^<>]*)?>|@[\w.-]+)[,:]?(?=\s|$)/;
const FIX_VERBS = DESK_COMMAND_PHRASES.fix.map((phrase) => phrase.toLowerCase().split(" "));
const CONNECTORS = new Set(["on", "for"]);
const END_PUNCTUATION = /[.!?]+$/;
const SLACK_LINK = /^<([^|<>\s]+)(?:\|([^<>]*))?>$/;
const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d{1,9})(?:[/?#]\S*)?$/i;
// How Slack labels the link it makes from a typed `github.com/o/r/pull/N`.
const PR_URL_LABEL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d{1,9})(?:[/?#]\S*)?$/i;
const PR_SHORT = /^([^/\s#]+)\/([^/\s#]+)#(\d{1,9})$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function pullRequest(owner: string, repo: string, digits: string): PullRequestRef | undefined {
  const number = Number(digits);
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === ".." || number < 1) return undefined;
  const url = `https://github.com/${owner}/${repo}/pull/${number}`;
  return { owner, repo, number, url, label: `${owner}/${repo}#${number}` };
}

function samePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}

/**
 * One token as a PR: a GitHub PR URL, `owner/repo#n`, or a Slack link to a PR
 * URL whose label is absent or that same PR's URL, with or without the scheme
 * (`<url>`, `<url|url>`, and Slack's autolink of a typed
 * `github.com/o/r/pull/N`, `<url|github.com/o/r/pull/N>`). Any other label is
 * refused: Slack shows only the label.
 */
export function pullRequestToken(token: string): PullRequestRef | undefined {
  const link = SLACK_LINK.exec(token);
  if (link === null) {
    const match = PR_URL.exec(token) ?? PR_SHORT.exec(token);
    return match === null ? undefined : pullRequest(match[1]!, match[2]!, match[3]!);
  }
  const url = PR_URL.exec(link[1]!);
  const target = url === null ? undefined : pullRequest(url[1]!, url[2]!, url[3]!);
  if (target === undefined || link[2] === undefined || link[2] === link[1]) return target;
  const shown = PR_URL_LABEL.exec(link[2]);
  const named = shown === null ? undefined : pullRequest(shown[1]!, shown[2]!, shown[3]!);
  return named !== undefined && samePullRequest(named, target) ? target : undefined;
}

/** The PR a message asks to fix, or undefined when the message is anything else. */
export function fixTarget(text: string): PullRequestRef | undefined {
  const tokens = stripSlackFooter(text).replace(LEADING_MENTION, "").split(/\s+/).filter((token) => token !== "");
  while (tokens.length > 0 && /^[.!?]+$/.test(tokens[tokens.length - 1]!)) tokens.pop();
  const lower = tokens.map((token) => token.toLowerCase());
  const verb = FIX_VERBS.find((words) => words.every((word, index) => lower[index] === word));
  if (verb === undefined) return undefined;
  let at = verb.length;
  if (CONNECTORS.has(lower[at] ?? "")) at += 1;
  if (tokens.length !== at + 1) return undefined;
  return pullRequestToken(tokens[at]!.replace(END_PUNCTUATION, ""));
}

export function fixReply(text: string): string | undefined {
  const pr = fixTarget(text);
  if (pr === undefined) return undefined;
  return [
    `I can't drive ${pr.label}. To hand it to the fixer, type \`factory: drive\` as a comment on ${pr.url} yourself; a comment posted by a bot does not wake it.`,
    "A pull request the factory opened needs nothing: the fixer drives it on its own the first time a check goes red.",
  ].join("\n");
}

export type ExternalSenderCheck = (message: SlackMessage) => Promise<boolean>;

// Slack Connect senders are dropped by July only after a handler returns a
// decision, so a post from the handler would bypass that policy. July starts
// its own users.info lookup for the sender before calling the handler and
// caches the answer in the module this imports, so the desk reads that cache
// through a transport that never reaches Slack, instead of a second lookup.
// A sender July has not classified within the wait counts as external, which
// sends the message down the stock path where July applies its own answer.
//
// One probe for the process: July keeps a users.info map per token object
// and never drops one, so a probe per poll leaked a map every step.
let probeMissed = false;
export const JULY_CACHE_PROBE: SlackApiTransport = {
  kind: "api-transport",
  label: "factory-desk cache probe",
  call: async () => {
    probeMissed = true;
    throw new Error("not classified yet");
  },
};

type ClassifySender = typeof isExternalSlackSender;

// Probe reads run one at a time. A shared probe also shares July's in-flight
// lookup, so a second read of the same sender would get the first read's
// failure without calling the probe and take it for July's answer.
let probeTurn: Promise<unknown> = Promise.resolve();

function readJulyCache(message: SlackMessage, classify: ClassifySender): Promise<{ external: boolean; missed: boolean }> {
  const read = probeTurn.then(async () => {
    probeMissed = false;
    const external = await classify({ botToken: JULY_CACHE_PROBE, slackTeamId: message.teamId ?? "", userId: message.author?.userId ?? "" });
    return { external, missed: probeMissed };
  });
  probeTurn = read.catch(() => undefined);
  return read;
}

export function julyClassifiedSender(
  options: { waitMs?: number; stepMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; classify?: ClassifySender } = {}
): ExternalSenderCheck {
  const waitMs = options.waitMs ?? 5000;
  const stepMs = options.stepMs ?? 25;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const classify = options.classify ?? isExternalSlackSender;
  return async (message) => {
    const deadline = now() + waitMs;
    for (;;) {
      const { external, missed } = await readJulyCache(message, classify);
      // On a miss the probe throws, and July answers a failed lookup with external.
      if (!missed || now() >= deadline) return external;
      await sleep(stepMs);
    }
  };
}

export const slackConnectSender: ExternalSenderCheck = julyClassifiedSender();

export function deskInbound(
  options: { fallback?: SlackMessageHandler; isExternal?: ExternalSenderCheck } = {}
): SlackMessageHandler {
  const fallback = options.fallback ?? createDefaultOnInbound();
  const isExternal = options.isExternal ?? slackConnectSender;
  return async (ctx, message) => {
    void learnDeskSelfIdentity(ctx.host);
    if (message.author?.isBot === true) return fallback(ctx, message);
    await acknowledgeIntake(ctx, message, isExternal);
    await markFiling(ctx, message);
    // Raw Slack text: `markdown` keeps only a link's label, which can name a
    // different PR than the link.
    const reply = fixReply(message.text);
    if (reply === undefined) {
      const plain = await plainApproveRoute(ctx, message);
      if (isHostTicketCommand(message) || (plain !== undefined && plain !== "filing")) {
        logInbound(ctx, message, "host_command");
        return takeHostCommand(ctx, message, isExternal, plain === "filing" ? undefined : plain);
      }
      if (await takeThreadDetail(ctx, message, { isExternal })) {
        logInbound(ctx, message, "thread_detail");
        return null;
      }
      const dropped = await forgetDeniedIntake(ctx, message, isExternal);
      await acknowledgeDenyFile(ctx, message, { isExternal, dropped });
      logInbound(ctx, message, "model");
      const intake = await triageFilingRequest(ctx, message, isExternal);
      const deny = await plainDenyKey(ctx, message);
      return withDeskCommand(await fallback(ctx, message), message, { ...(intake === undefined ? {} : { intake }), ...(deny === undefined ? {} : { deny }) });
    }
    if (defaultSlackAuth(message, ctx) === null) return null;
    if (await isExternal(message)) return withDeskCommand(await fallback(ctx, message), message);
    logInbound(ctx, message, "fix_reply");
    if (!(await firstDelivery(ctx, message, { hostReply: true }))) return null;
    await ctx.thread.post(reply);
    return null;
  };
}

/**
 * An exact `approve`/`retry`/`plan`/`replan` KEY, or a plain `approve`
 * outside an unfiled filing thread, never starts a model turn:
 * July starts one for any decision the handler returns, and it would be a
 * second, `Auto routed to …` reply (TLSSN-33). Each command posts its own
 * one reply, or none for a bot or Slack Connect sender. A command that
 * throws gets one host line here instead of a hosted retry.
 */
async function takeHostCommand(ctx: SlackBinding, message: SlackMessage, isExternal: ExternalSenderCheck, plain?: Exclude<PlainApprove, "filing">): Promise<null> {
  try {
    if (!(await firstDelivery(ctx, message, plain === undefined ? {} : { hostReply: true }))) return null;
    if (await takeApproveCommand(ctx, message, { isExternal }, plain)) return null;
    if (await takeRetryCommand(ctx, message, { isExternal })) return null;
    if (await takePlanCommand(ctx, message, { isExternal })) return null;
    console.log(JSON.stringify({ desk: "host_command", outcome: "untaken", channel: ctx.slack.channelId, ts: message.ts }));
  } catch (error) {
    console.error(JSON.stringify({ desk: "host_command", outcome: "threw", channel: ctx.slack.channelId, ts: message.ts, error: error instanceof Error ? error.message : String(error) }));
    try {
      if (!(await isExternal(message))) {
        await ctx.thread.post("Something failed while I handled that command, so it may not have finished. Check the ticket in Jira, then say it again if nothing moved.");
      }
    } catch {
      // Nothing more to say; still no model turn.
    }
  }
  return null;
}

const LOOSE_RETRY = /\bretry\s+[A-Za-z][A-Za-z0-9]+[-\u2010-\u2015\u2212]\d+/i;
const PREVIEW_CHARS = 200;

/** Escapes everything outside printable ASCII, so a log line shows what Slack sent. */
function preview(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  return [...text.slice(0, PREVIEW_CHARS)].map((char) => (/^[\x20-\x7e]$/.test(char) ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`)).join("");
}

/**
 * One line per human message naming the route it took and the hosted
 * generation that took it. A message that looks like a desk command but
 * went to the model also carries its raw fields, which is how a live
 * miss shows whether the text or the deploy was the difference.
 */
function logInbound(ctx: SlackBinding, message: SlackMessage, route: "host_command" | "thread_detail" | "fix_reply" | "model"): void {
  const all = `${message.text}\n${message.body}\n${message.markdown}`;
  const nearMiss = route === "model" && (parseCommands(all).some((command) => command.target !== "file") || LOOSE_RETRY.test(all));
  console.log(
    JSON.stringify({
      desk: "inbound",
      route,
      channel: ctx.slack.channelId || message.channelId,
      ts: message.ts,
      generation: process.env["AGENT_SERVE_GENERATION"] ?? null,
      ...(nearMiss ? { nearMiss: true, text: preview(message.text), body: preview(message.body), markdown: preview(message.markdown) } : {}),
    })
  );
}

// 👀 on a person's filing request before the model drafts its reply. Slack
// Connect senders get nothing: July drops them after the handler returns.
async function acknowledgeIntake(ctx: SlackBinding, message: SlackMessage, isExternal: ExternalSenderCheck): Promise<void> {
  if (!isIntakeRequest(message)) return;
  try {
    if (defaultSlackAuth(message, ctx) === null) return;
    const classified = message.teamId || !ctx.slack.teamId ? message : { ...message, teamId: ctx.slack.teamId };
    if (await isExternal(classified)) return;
    await ackIntake(await ctx.host.slack.getClient(), message);
  } catch {
    // Only an acknowledgement; the reply still follows.
  }
}

// A new request (`isIntakeCandidate`), `approve file`, or `deny file` marks
// its thread as a filing thread, so a plain `approve` there before a ticket
// is filed takes the model route `approve file` takes instead of the host
// ask for a key. A top-level message marks the thread its replies will carry too.
async function markFiling(ctx: SlackBinding, message: SlackMessage): Promise<void> {
  if (!isIntakeCandidate(message) && !parseCommands(`${message.text}\n${message.markdown}`).some((command) => command.target === "file")) return;
  await markFilingThread(ctx.host.kv, filingThreads(ctx, message), new Date());
}

/**
 * Jev on a new request (`isIntakeCandidate`), before the model drafts the
 * filing prompt (intake-triage.ts). The answer is kept for the thread the
 * request's replies land in, so `approve file` files with it, and the turn
 * gets a context block saying whose triage the prompt carries. Bot, Slack
 * Connect, and unauthenticated senders get no Jev call.
 *
 * While another message's filing prompt is still unfiled in the same thread
 * (`pendingIntake`), a candidate is a follow-up to it: no Jev call, and that
 * triage is kept and shown again instead of overwritten, so ✅ on either
 * prompt files what it says. A DM is one conversation holding every request,
 * so a filing phrase there starts a new one.
 */
async function triageFilingRequest(ctx: SlackBinding, message: SlackMessage, isExternal: ExternalSenderCheck): Promise<string | undefined> {
  if (!isIntakeCandidate(message)) return undefined;
  const explicit = hasFilingPhrase(message);
  const channel = ctx.slack.channelId || message.channelId;
  const bareReply = !channel || bareReplyReaches(channel);
  const text = message.text || message.markdown;
  try {
    if (defaultSlackAuth(message, ctx) === null) return undefined;
    const classified = message.teamId || !ctx.slack.teamId ? message : { ...message, teamId: ctx.slack.teamId };
    if (await isExternal(classified)) return undefined;
    const kv = ctx.host.kv;
    const threads = filingThreads(ctx, message);
    const now = new Date();
    const dm = (ctx.slack.channelId || message.channelId).startsWith("D");
    const pending = explicit && dm ? undefined : await pendingIntake(kv, threads, message.ts, now);
    if (pending !== undefined) {
      await stashIntakeTriage(kv, threads, pending.triage, now, pending.source);
      console.log(JSON.stringify({ desk: "intake_triage", by: pending.triage.by, followUp: pending.source.ts, channel: ctx.slack.channelId || message.channelId, ts: message.ts }));
      return intakeTriageContext(pending.triage, { text: pending.source.text, explicit, bareReply });
    }
    const triage = await triageIntake({ text, mcp: ctx.host.mcp, kv, env: process.env });
    await stashIntakeTriage(kv, threads, triage, now, { ts: message.ts, text });
    console.log(JSON.stringify({ desk: "intake_triage", by: triage.by, ...(triage.by === "model" ? { reason: triage.reason } : {}), channel: ctx.slack.channelId || message.channelId, ts: message.ts }));
    return intakeTriageContext(triage, { text, explicit, bareReply });
  } catch (error) {
    console.error(JSON.stringify({ desk: "intake_triage", outcome: "threw", ts: message.ts, error: error instanceof Error ? error.message : String(error) }));
    return intakeTriageContext({ by: "model", reason: "unavailable" }, { text, explicit, bareReply });
  }
}

// `deny file` drops the request its thread's prompt is waiting on (the one a
// follow-up would be shown), so that request no longer makes the next
// message there (every later message, in a DM) a follow-up. True when it
// dropped one.
async function forgetDeniedIntake(ctx: SlackBinding, message: SlackMessage, isExternal: ExternalSenderCheck): Promise<boolean> {
  if (!isDenyFile(message)) return false;
  try {
    if (defaultSlackAuth(message, ctx) === null) return false;
    const classified = message.teamId || !ctx.slack.teamId ? message : { ...message, teamId: ctx.slack.teamId };
    if (await isExternal(classified)) return false;
    const threads = filingThreads(ctx, message);
    const now = new Date();
    const pending = await pendingIntake(ctx.host.kv, threads, message.ts, now);
    if (pending === undefined) return false;
    for (const thread of threads) await dropIntakeTriage(ctx.host.kv, thread, pending.source.ts, now);
    return true;
  } catch {
    // Kept, the triage expires on its own.
    return false;
  }
}

/** The thread a message is in, the thread a top-level message's replies will carry, and a DM's channel (file_ticket's DM thread). */
function filingThreads(ctx: SlackBinding, message: SlackMessage): ThreadRef[] {
  const here = commandThread(ctx, message);
  const threads: ThreadRef[] = [here];
  if (isSlackTs(message.ts) && (!isSlackTs(message.threadTs) || message.threadTs === message.ts) && here.threadTs !== message.ts) {
    threads.push({ channelId: here.channelId, threadTs: message.ts });
  }
  if (here.channelId.startsWith("D") && here.threadTs !== undefined) threads.push({ channelId: here.channelId });
  return threads;
}

// `deny file` files nothing, so no tool runs and nothing else can ack it.
// The ✅ goes on before the model's one-line reply, from the same senders
// the intake 👀 is for: on a reply in a channel thread, or in a DM (one
// top-level conversation, where `approve file` is acked too) when it dropped
// the request a filing prompt was waiting on.
async function acknowledgeDenyFile(ctx: SlackBinding, message: SlackMessage, options: { isExternal: ExternalSenderCheck; dropped: boolean }): Promise<void> {
  if (!isDenyFile(message)) return;
  const channel = ctx.slack.channelId || message.channelId;
  const reply = isSlackTs(message.threadTs) && message.threadTs !== message.ts;
  if (!reply && !(channel.startsWith("D") && options.dropped)) return;
  const { isExternal } = options;
  try {
    if (defaultSlackAuth(message, ctx) === null) return;
    const classified = message.teamId || !ctx.slack.teamId ? message : { ...message, teamId: ctx.slack.teamId };
    if (await isExternal(classified)) return;
  } catch {
    return;
  }
  await ackCommand({ getClient: () => ctx.host.slack.getClient(), target: { channel: ctx.slack.channelId || message.channelId, ts: message.ts }, command: "deny file" });
}

const COMMAND_TOOL: Record<Command["verb"], string> = {
  approve: "approve_ticket",
  deny: "deny_ticket",
  plan: "request_plan",
  replan: "request_plan",
};

/**
 * A bare or mentioned `approve KEY` (and deny/plan/replan) is the same
 * command. Tag the model turn so a noisy Planned thread cannot treat
 * `approve TLSSN-19` as another plan dump. `approve file` stays untagged:
 * filing is still a model routing decision.
 */
const DENY_WHICH = [
  "<desk_command>",
  "This Slack message is a plain `deny`, but this thread is not tied to exactly one ticket.",
  "Do not guess and call no tool: ask which ticket to deny, and say they can reply `deny KEY`.",
  "</desk_command>",
].join("\n");

function deskCommandContext(text: string, deny?: PlainDeny): string | undefined {
  if (deny === "ask") return DENY_WHICH;
  const commands = deny === undefined ? parseCommands(text).filter((command) => command.target !== "file") : [{ verb: "deny" as const, target: deny.issueKey }];
  if (commands.length === 0) return undefined;
  const lines = commands.map((command) => {
    const extra = command.verb === "replan" ? " with replan: true" : "";
    return `Call ${COMMAND_TOOL[command.verb]} once with issueKey ${command.target}${extra}.`;
  });
  return [
    "<desk_command>",
    `This Slack message is ${commands.map((command) => `\`${command.verb} ${command.target}\``).join(" and ")}.`,
    ...lines,
    "Do not announce a plan; host code posts lifecycle announcements.",
    "</desk_command>",
  ].join("\n");
}

/**
 * Human Slack replies: no tool narration, and commands written plain, with
 * no mention (never @factory-desk), wherever the reply is.
 */
function slackReplyHint(channelId: string | undefined): string {
  const handle = deskSlackHandle();
  const bare = !channelId || bareReplyReaches(channelId);
  return [
    "<slack_reply>",
    "This reply is for humans in Slack. Never name a tool, never write \"I used …\", and never say you used a tool or used none.",
    `Your Slack handle is ${handle}.`,
    bare
      ? `A command you ask for is written without a mention: \`approve file\`, \`deny file\`, \`approve\`. Never write ${handle} or @factory-desk in front of it.`
      : `A plain reply in this thread does not reach you, so ask for a ✅ or ❌ reaction, never a typed command. Never write ${handle} or @factory-desk.`,
    "</slack_reply>",
  ].join("\n");
}

function withDeskCommand<T extends { context?: string[] } | null | undefined>(decision: T, message: SlackMessage, options: { intake?: string; deny?: PlainDeny } = {}): T {
  const { intake, deny } = options;
  if (decision == null) return decision;
  const hints = [slackReplyHint(message.channelId)];
  if (intake !== undefined) hints.push(intake);
  const command = deskCommandContext(`${message.text}\n${message.markdown}`, deny);
  if (command !== undefined) hints.push(command);
  return { ...decision, context: [...(decision.context ?? []), ...hints] };
}

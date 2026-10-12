// A post without the bot's mention reaches the desk only through the channel
// watch (slack.ts `channelPosts`), and it counts only as a reply in a thread
// the factory owns. Everything else there is people talking to each other.
//
// A thread is the factory's when it is tied to a ticket (`thread-tickets/…`,
// or the ticket a key command names is bound to it), when a filing request
// reached the desk there (`filing-thread/…`: the intake root the desk
// replied to), or when it is waiting on a needs-info answer. A top-level
// post, and a reply in any other thread, is ignored: starting a request
// still takes the mention, which July delivers on `app_mention`.
//
// In a factory thread a plain reply is taken when it is:
// - a command, the whole reply and nothing else: `approve`, `approve file`,
//   `approve KEY`, `deny`, `deny file`, `deny KEY`, `plan`, `plan KEY`, `replan KEY`,
//   `retry`, `retry KEY`, `fix`, or `fix <PR>`;
// - the answer a needs-info thread is waiting on (thread-detail.ts), unless
//   it is only an acknowledgement ("thanks", "ok");
// - a clear question to the factory: it ends with `?`, mentions nobody,
//   and starts with the factory's name, a status phrase ("status", "where
//   is", "what happened to"), names this thread's ticket, or asks about the
//   factory, the plan, the PR, the ticket, or the build.
// Anything else (chatter, a thank-you, a question to a teammate) gets no
// model turn and no reply.
//
// The dual delivery of a labeled mention (`<@BOT|factory>` reaches both
// `app_mention` and this watch, TLSSN-33) needs nothing extra: a twin this
// gate passes is deduped by the host command's claim (handled-message.ts)
// or by July's own ask claim on `channel:ts` before a model turn, and a twin
// it drops still runs once through the mention.

import type { SlackBinding, SlackMessage, SlackMessageHandler } from "@cursor/july/channels/slack";
import { approveCommandText, stripSlackFooter } from "./approve-command.js";
import { binding, commandThread } from "./command-thread.js";
import { deskSlackHandle } from "./config.js";
import { DESK_COMMAND_PHRASES } from "./desk-commands.js";
import { fixTarget } from "./fix-request.js";
import { isAcknowledgement, readAwaiting, slackPlainText } from "./thread-detail.js";
import { isFilingThread, threadTickets } from "./thread-tickets.js";
import { isSlackTs, sameThread, type ThreadRef } from "./threads.js";
import type { KeyedKv } from "./kv-keys.js";

const KEY = "[a-z][a-z0-9]+-\\d+";
const EXACT_COMMAND = new RegExp(
  `^(?:approve(?:\\s+(?:file|${KEY}))?|deny(?:\\s+(?:file|${KEY}))?|plan(?:\\s+${KEY})?|replan\\s+${KEY}|retry(?:\\s+${KEY})?|fix)[.!]*$`,
  "i"
);
const COMMAND_KEY = new RegExp(`^(?:approve|deny|plan|replan|retry)\\s+(${KEY})[.!]*$`, "i");
const MENTION = /<[@!][^>]*>/;
const ABOUT_FACTORY = /\b(?:factory|the (?:plan|pr|pull request|ticket|build))\b/i;

export type PlainReply = "command" | "question" | "chatter";

function variants(message: SlackMessage): string[] {
  return [message.text, message.body, message.markdown].filter((text): text is string => typeof text === "string" && text.trim() !== "");
}

/** The ticket key an exact key command names. */
export function commandKey(message: SlackMessage): string | undefined {
  for (const text of variants(message)) {
    const match = COMMAND_KEY.exec(approveCommandText(text));
    if (match !== null) return match[1]!.toUpperCase();
  }
  return undefined;
}

/** What a plain reply is, from its words alone. `keys` are the thread's tickets. */
export function plainReplyKind(message: SlackMessage, keys: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): PlainReply {
  const texts = variants(message);
  if (fixTarget(message.text) !== undefined || texts.some((text) => EXACT_COMMAND.test(approveCommandText(text)))) return "command";
  const raw = message.text.trim() === "" ? message.body : message.text;
  // Any mention, the bot's included: a question to the bot arrives on `app_mention` too.
  if (MENTION.test(stripSlackFooter(raw))) return "chatter";
  const words = approveCommandText(raw);
  if (!words.endsWith("?")) return "chatter";
  const lower = words.toLowerCase().replace(/[?!.]+$/, "");
  const name = deskSlackHandle(env).replace(/^@/, "").toLowerCase();
  const startsWith = (phrase: string) => lower === phrase || lower.startsWith(`${phrase} `) || lower.startsWith(`${phrase},`) || lower.startsWith(`${phrase}:`);
  if (startsWith(name) || DESK_COMMAND_PHRASES.status.some(startsWith)) return "question";
  if (keys.some((key) => new RegExp(`\\b${key}\\b`, "i").test(words))) return "question";
  return ABOUT_FACTORY.test(words) ? "question" : "chatter";
}

export type PlainReplyRoute = { take: true; kind: PlainReply | "detail" } | { take: false; why: "top_level" | "not_factory_thread" | "chatter" | "acknowledgement" };

/** Whether a watched-channel post without a mention is for the desk. */
export async function plainReplyRoute(ctx: SlackBinding, message: SlackMessage, env: NodeJS.ProcessEnv = process.env): Promise<PlainReplyRoute> {
  if (!isSlackTs(message.threadTs) || message.threadTs === message.ts) return { take: false, why: "top_level" };
  const kv = ctx.host.kv;
  const thread = commandThread(ctx, message);
  const keys = await threadTickets(kv, thread);
  const awaiting = await readAwaiting(kv, thread).catch(() => undefined);
  const owned = keys.length > 0 || awaiting !== undefined || (await isFilingThread(kv, thread)) || (await boundHere(kv, commandKey(message), thread));
  if (!owned) return { take: false, why: "not_factory_thread" };
  const kind = plainReplyKind(message, awaiting === undefined ? keys : [...keys, awaiting.issueKey], env);
  if (kind !== "chatter") return { take: true, kind };
  if (awaiting === undefined) return { take: false, why: "chatter" };
  const raw = message.text.trim() === "" ? message.body : message.text;
  return isAcknowledgement(slackPlainText(stripSlackFooter(raw))) ? { take: false, why: "acknowledgement" } : { take: true, kind: "detail" };
}

async function boundHere(kv: KeyedKv, issueKey: string | undefined, thread: ThreadRef): Promise<boolean> {
  if (issueKey === undefined) return false;
  try {
    const ticket = await binding(kv, issueKey);
    return ticket !== undefined && sameThread(ticket, thread);
  } catch {
    return false;
  }
}

/** A bot post July's watcher may still deliver: `author.isBot`/`botId`, a raw `bot_id`, or `subtype=bot_message`. */
export function isBotThreadReply(message: SlackMessage): boolean {
  if (message.author?.isBot === true) return true;
  if (typeof message.author?.botId === "string" && message.author.botId !== "") return true;
  const raw = message as SlackMessage & { bot_id?: unknown; subtype?: unknown };
  if (typeof raw.bot_id === "string" && raw.bot_id !== "") return true;
  return raw.subtype === "bot_message";
}

/** The channel watch's handler: a plain reply in a factory thread goes on to `handler`; bots and anything else are ignored. */
export function factoryThreadReplies(handler: SlackMessageHandler): SlackMessageHandler {
  return async (ctx, message) => {
    if (isBotThreadReply(message)) {
      console.log(JSON.stringify({ desk: "plain_reply", ignored: "bot", channel: ctx.slack.channelId || message.channelId, ts: message.ts }));
      return null;
    }
    const route = await plainReplyRoute(ctx, message);
    console.log(JSON.stringify({ desk: "plain_reply", ...(route.take ? { kind: route.kind } : { ignored: route.why }), channel: ctx.slack.channelId || message.channelId, ts: message.ts }));
    return route.take ? handler(ctx, message) : null;
  };
}

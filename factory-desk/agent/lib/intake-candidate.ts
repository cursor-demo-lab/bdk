// Which human Slack messages are new requests for the desk: the one rule
// behind the intake 👀 (status-reaction.ts), the filing-thread mark, and the
// Jev call before the filing turn (fix-request.ts), so the three never
// disagree. A filing phrase counts anywhere, as before. Without one, a
// top-level message (thread root or DM) counts when, after the leading
// mention and Slack chrome, it has enough words to name a problem and is
// not a desk command. Most reports never say "file a bug".

import { approveCommandText } from "./approve-command.js";
import { jiraProjects } from "./config.js";
import { factoryStage } from "./factory-stage.js";
import { PROJECT_ENV } from "./jira.js";
import { DESK_COMMAND_PHRASES } from "./desk-commands.js";
import { parseCommands } from "./originator.js";
import { isSlackTs } from "./threads.js";

export type IntakeCandidateMessage = { text: string; markdown?: string; ts: string; threadTs?: string; channelId: string; author?: { isBot?: boolean } };

/** Words, keys not counted, a problem report needs: "CSV export returns 500". */
export const MIN_PROBLEM_WORDS = 4;

/**
 * A Jira key of a configured project (`TLSSN-39`, any case), else any
 * upper-case key on production. Never `e2e-158` or, with a project
 * configured, `ISO-8601`: a report that names one is still a report. A
 * staging slug with no project left counts no key at all, so a production
 * key never reads as one of its own (factory-stage.ts).
 */
function issueKeys(env: NodeJS.ProcessEnv = process.env): RegExp {
  const projects = [...new Set([...jiraProjects(env, PROJECT_ENV), ...jiraProjects(env)])];
  if (projects.length > 0) return new RegExp(`\\b(?:${projects.join("|")})-\\d+\\b`, "gi");
  return factoryStage(env) === "production" ? /\b[A-Z][A-Z0-9]+-\d+\b/g : /(?!)/g;
}

function hasKey(words: string): boolean {
  return issueKeys().test(words);
}

const RETRY = /\bretry\s+[A-Za-z][A-Za-z0-9]+[-\u2010-\u2015\u2212]\d+/i;
const PULL_REQUEST = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+|\b[\w.-]+\/[\w.-]+#\d+\b/i;
// "Status code 500 on /export" is a report; "status of the export ticket" is not.
const STATUS_ASK = /^status\b(?:\s+(?:of|on|for|update|check|please)\b|\s*\?|$)/;

function phrasePattern(phrase: string, anchored: boolean): RegExp {
  return new RegExp(`${anchored ? "^" : "\\b"}${phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}

function startsWithPhrase(lower: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => phrasePattern(phrase, true).test(lower));
}

function hasPhrase(lower: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => phrasePattern(phrase, false).test(lower));
}

/** A routing-table command, fix request, or status question, which the desk answers without filing anything. */
export function isDeskCommand(text: string): boolean {
  const words = approveCommandText(text);
  const lower = words.toLowerCase();
  if (parseCommands(words).length > 0 || RETRY.test(words)) return true;
  if (hasPhrase(lower, DESK_COMMAND_PHRASES.fix) && PULL_REQUEST.test(text)) return true;
  const question = lower.endsWith("?");
  if (STATUS_ASK.test(lower) || startsWithPhrase(lower, DESK_COMMAND_PHRASES.status.filter((phrase) => phrase !== "status"))) return true;
  if (startsWithPhrase(lower, ["status"]) && (question || hasKey(words))) return true;
  return hasKey(words) && (question || startsWithPhrase(lower, DESK_COMMAND_PHRASES.planWithKey));
}

/** A filing phrase (`file a bug`, …) as whole words, not `approve file` / `deny file`. */
export function hasFilingPhrase(message: Pick<IntakeCandidateMessage, "text" | "markdown">): boolean {
  const text = `${message.text}\n${message.markdown ?? ""}`;
  return hasPhrase(text.toLowerCase(), DESK_COMMAND_PHRASES.filing) && !parseCommands(text).some((command) => command.target === "file");
}

function problemWords(text: string): number {
  return approveCommandText(text)
    .replace(issueKeys(), " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export function isTopLevel(message: Pick<IntakeCandidateMessage, "ts" | "threadTs" | "channelId">): boolean {
  return String(message.channelId ?? "").startsWith("D") || !isSlackTs(message.threadTs) || message.threadTs === message.ts;
}

/**
 * A person's new request: a filing phrase (not `approve file` / `deny file`),
 * or a top-level problem report or change request that is not a desk command.
 */
export function isIntakeCandidate(message: IntakeCandidateMessage): boolean {
  if (message.author?.isBot === true) return false;
  if (hasFilingPhrase(message)) return true;
  if (!isTopLevel(message)) return false;
  const text = message.text || message.markdown || "";
  return !isDeskCommand(text) && problemWords(text) >= MIN_PROBLEM_WORDS;
}

// Triage before filing. A Slack filing request is asked of Jev (the shared
// jev-triage.ts judge triage-jira uses) before the model drafts the filing
// prompt. Every answer above JEV_THRESHOLD: the ticket is filed with Jev's
// type and severity. Jev answers no summary, so it is the request's own first
// sentence after the title, or, for a request that is only its title, one the
// filing turn writes (TLSSN-37 showed the title template instead). Anything
// else (no key, Jev down or slow, an off-label answer, one answer at or under
// the bar): the desk's own turn triages the request as it drafts the prompt,
// and a type Jev was confident about still goes on the ticket, as
// triage-jira's record_triage does. Either way file_ticket writes the
// Triage: comment and moves the ticket to Triaged itself, so triage-jira
// leaves it alone (desk-triaged.ts DESK_TRIAGED_LINE, which ends both the
// description and that comment).
//
// The answer is kept per thread at `intake-triage/<channel>:<threadTs>` for a
// day: `approve file` comes in a later turn.

import type { HostMcpRegistry, JsonValue } from "@cursor/july";
import { DESK_COMMAND_PHRASES } from "./desk-commands.js";
import type { IssueTypeRef, IssueTypeWrite } from "./issue-type.js";
import { issueTypeFor, jiraProject } from "./jira.js";
import {
  JEV_THRESHOLD,
  TEMPLATE_NEXT_STEP,
  aboveBar,
  allAboveBar,
  answersConfidence,
  askTriageJev,
  calibrateJudgment,
  calibrateSeverity,
  guardJudgmentType,
  holdJudgmentType,
  issueText,
  judgmentConfidence,
  probabilityOf,
  readAnswers,
  settleJudgment,
  severityCeiling,
  templateVerdict,
  triageRecordLines,
  typeContradicted,
  type JevAnswers,
  type JudgeState,
  type TriageJudgment,
} from "./jev-triage.js";
import { TRIAGE_RUBRIC } from "./triage-rubric.js";
import { triagedByPhrase } from "./triage-credit.js";
import { withDeskTriaged } from "./desk-triaged.js";
import { triageComment, type TriageKind, type TriageSeverity, type TriageVerdict } from "./triage-verdict.js";
import { endFilingHold } from "./thread-tickets.js";
import type { ThreadRef } from "./threads.js";
import { wordCount, wordPrefix } from "./word-cut.js";
import { intakeSettledKey, intakeTriageKey, type KeyedKv } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { intakeSettledKey, intakeTriageKey };

/** Asked when the project's types cannot be read: the two types the desk has always filed on TLSSN. */
export const DESK_ISSUE_TYPES: readonly IssueTypeRef[] = [{ name: "Bug" }, { name: "Task" }];

const TTL_MS = 24 * 60 * 60 * 1000;
// Jev reads a title, not a paragraph; the filing prompt shows the whole title
// and cuts only a wall of text (Slack itself takes 40k characters).
const JEV_TITLE_MAX = 160;
const TITLE_MAX = 400;
const TITLE_MIN_WORDS = 2;
const DESCRIPTION_MAX = 4_000;

type JevPart = { answers: JevAnswers; source: JudgeState["source"]; types: { source: "project" | "default"; types: IssueTypeRef[] } };

export type FallbackReason = "no_key" | "no_text" | "types" | "no_project" | "unavailable" | "labels" | "below_bar" | "type_guard" | "no_intake";

export type IntakeTriage =
  | {
      by: "jev";
      jev: JevPart;
      type: string;
      severity: TriageSeverity;
      needsInfo: boolean;
      /** Only in threads stashed before the filing turn wrote every summary; a lift of the request's own words is dropped (`copiesRequest`). Jev answers no summary. */
      summary?: string;
      /** The filing prompt's title (`fitTitle`), so a summary that only repeats it can be told apart. */
      title?: string;
    }
  | { by: "model"; reason: FallbackReason; jev?: JevPart };

/**
 * The request: the leading mention and filing phrase dropped, Slack markup as
 * plain text (`plainSlackText`), and its title uncut (`requestTitle`). Jev
 * gets it through `fitAtWord` at JEV_TITLE_MAX, the filing prompt through
 * `fitTitle`.
 */
export function intakeText(raw: string): { title: string; description: string } {
  let text = plainSlackText(raw.replace(LEADING_MENTION, "")).replace(INLINE_FOOTER, "").trim();
  const lower = text.toLowerCase();
  const phrase = DESK_COMMAND_PHRASES.filing.find((candidate) => lower.startsWith(candidate));
  if (phrase !== undefined) text = text.slice(phrase.length).replace(/^\s*[:\-–—]\s*/, "").trim();
  return { title: capitalizedTitle(requestTitle(text)), description: text.slice(0, DESCRIPTION_MAX) };
}

const LEADING_MENTION = /^\s*(?:<@[A-Z0-9]+(?:\|[^<>]*)?>|@[\w.-]+)[,:]?\s*/;
// Hosted delivery can collapse the footer's newline (approve-command.ts `stripSlackFooter`).
const INLINE_FOOTER = /\s+[*_]+sent using[*_]+\s+@[\w.-]+\s*$/i;

export const REPORTER_REQUEST_LABEL = "Reporter's request, verbatim from Slack:";
// Closes the quote with a sentence end, so the desk line after it still
// reads as the desk's (desk-triaged.ts) when Automation's plainText runs the
// paragraphs together and the reporter's last line ends in `"` or a word.
export const REPORTER_REQUEST_END = "End of the reporter's request.";
const REPORTER_REQUEST_MAX = DESCRIPTION_MAX;
// The planner (`slackThreadUrl`) and the desk (`filedFromSlack`) read the
// host's `Slack thread: <permalink>` trailer; a pasted one in the quote must
// not be read as it, and ADF drops the `> ` marks on the way back. Markup
// and a backslash-escaped colon count: the MCP undoes markdown on the way in,
// and `_Slack thread_:` reads back from ADF as `Slack thread:`. So do a label
// glued to the word before it (no reader has a word boundary) and entity
// spellings of the space and colon (`Slack&#32;thread&#58;`).
const QUOTED_TRAILER = /Slack(?:[\s*_~`\\]|&(?:#0*32|#x0*20|nbsp);)+thread(?=(?:[\s*_~`\\]|&(?:#0*32|#x0*20|nbsp);)*(?::|&(?:#0*58|#x0*3a|colon);))/giu;
// Cursor's footer on its own last line: a decoded mention (`*Sent using*
// @Cursor`) or the bare app name. A reporter's own line ("Sent using the
// Android app, …", "Sent using Firefox") is theirs and stays in the quote.
const FOOTER_LINE = /(?:^|\n)[^\S\n]*[*_~]*sent using[*_~]*[^\S\n]+[*_~]*(?:@[A-Za-z][\w.-]*|Cursor)[*_~]*[^\S\n]*$/i;

/**
 * The reporter's own words as plain text: Slack markup and entities decoded
 * (`plainSlackText`, without its invisible word joiners), the leading bot
 * mention and Cursor's `Sent using` footer dropped. The filing phrase and
 * everything else stay as typed.
 */
export function reporterRequest(raw: string): string {
  return plainSlackText(raw.replace(/\r\n?/g, "\n").replace(LEADING_MENTION, ""))
    .replaceAll(WORD_JOINER, "")
    .trimEnd()
    .replace(INLINE_FOOTER, "")
    .replace(FOOTER_LINE, "")
    .trim();
}

/**
 * The model's description with the reporter's request quoted after it, so
 * the planner reads their explicit constraints ("keep the 60 limit") as they
 * wrote them rather than as the filing turn paraphrased them (TLSSN-42).
 * Skipped when the description already carries the request word for word
 * (letters and digits, so quote marks and spacing do not count). A
 * `Slack thread:` label in the model's prose or the quote is written
 * `Slack thread (quoted):` on every path: only the host's trailer, appended
 * after this, is the filing thread. `raw` is the stash's text, itself cut at
 * DESCRIPTION_MAX.
 */
export function withReporterRequest(description: string, raw: string | undefined): string {
  const prose = neutralTrailers(description);
  if (raw === undefined) return prose;
  const request = reporterRequest(raw);
  // Without its colon, so the cut label (`… from Slack (cut; …):`) counts too.
  if (request === "" || description.includes(REPORTER_REQUEST_LABEL.slice(0, -1)) || comparable(prose).includes(comparable(neutralTrailers(request)))) return prose;
  const cut = raw.length >= DESCRIPTION_MAX || request.length > REPORTER_REQUEST_MAX;
  const quoted = neutralTrailers(cut ? fitAtWord(request, REPORTER_REQUEST_MAX - 1).replace(/…$/, "") + "…" : request)
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
  const label = cut ? `${REPORTER_REQUEST_LABEL.slice(0, -1)} (cut; the Slack thread has all of it):` : REPORTER_REQUEST_LABEL;
  return `${prose.trimEnd()}\n\n${label}\n${quoted}\n\n${REPORTER_REQUEST_END}`;
}

function neutralTrailers(text: string): string {
  return text.replace(QUOTED_TRAILER, "$& (quoted)");
}

/**
 * The first line with more than openers (`withoutOpeners`), without them.
 * When that line is the last (a one-paragraph request, Slack's `Sent using`
 * footer aside), it is titled by its first sentence (`firstSentence`)
 * instead, so its next sentence is the summary, unless that sentence is
 * under TITLE_MIN_WORDS words (`Broken.`). A request of nothing but openers
 * keeps its first line whole.
 */
function requestTitle(text: string): string {
  const lines = proseLines(text);
  for (let at = 0; at < lines.length; at++) {
    const line = withoutOpeners(lines[at]!);
    if (line === "") continue;
    if (at < lines.length - 1) return line;
    const sentence = firstSentence(line, true);
    return wordCount(sentence) >= TITLE_MIN_WORDS ? sentence : line;
  }
  return lines[0] ?? "";
}

const OPENER_SENTENCES_MAX = 8;

/** `line` without the openers (`isOpener`) it starts with, sentence by sentence or up to a `: `; empty when it is only openers (`Hi team! Quick one. Good morning all.`). */
function withoutOpeners(line: string): string {
  for (let i = 0; i < OPENER_SENTENCES_MAX && line !== ""; i++) {
    const sentence = firstSentence(line, true);
    const colon = line.indexOf(": ");
    const opening = colon !== -1 && colon < sentence.length ? line.slice(0, colon + 1) : sentence;
    if (!isOpener(opening)) break;
    line = line.slice(opening.length).trim();
  }
  return line;
}

// Words a request opens with before it says anything: `Hi team!`, `Hey all,`, `Quick one:`.
const GREETING_WORDS = new Set(
  "hi hey heya hiya hello howdy yo morning afternoon evening good gday g'day team all folks everyone everybody y'all yall guys there quick one small q question fyi heads up".split(" ")
);

/** A greeting (at most four greeting words, mentions and emoji aside) or a bare line label such as `*Repro:*`. */
function isOpener(text: string): boolean {
  if (text.replace(LINE_LABEL, "") === "") return true;
  const words = text.toLowerCase().replace(/@\S+|:[\w+-]+:/g, " ").match(/[\p{L}\p{N}']+/gu) ?? [];
  return words.length <= 4 && words.every((word) => GREETING_WORDS.has(word));
}

/** The request's lines as prose: fenced blocks (a log, a stack; one left open runs to the end), `>` quote marks, blank lines, and Slack's `Sent using` footer dropped. */
function proseLines(text: string): string[] {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/^>\s?/, "").trim())
    .filter((line) => line !== "" && !FOOTER.test(line));
}

// Slack's raw `text` holds its own markup in real `<…>` and escapes what the
// reporter typed as `&lt;` `&gt;` `&amp;`. Markup goes first, while the two
// still differ: a link reads as its label or URL, a mention or broadcast as
// an inert `@name` (echoed into the filing prompt, `<!here>` would ping the
// channel again, and a `<url|label>` puts July's post on mrkdwn `text`, where
// a decoded `<button>` is markup). Then the entities (`&quot;` and `&#39;`
// too, which some Slack clients send), `&amp;` last, so
// `&amp;lt;` stays `&lt;`. A `<!here>`, `<@U…>`, `<#C…>`, or `<https:…>` the
// reporter typed as text comes out of that decode looking like markup, so a
// word joiner (U+2060, invisible) after its `<` keeps Slack from reading it.
function plainSlackText(text: string): string {
  return text
    .replace(/<([^<>|\s]+)(?:\|([^<>]*))?>/g, (_match, target: string, label: string | undefined) => inSentence(slackMarkupText(target, label?.trim() || undefined)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#0*39|#x0*27|apos);/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/<(?=[!@#]|[a-z][a-z0-9+.-]*:)/gi, `<${WORD_JOINER}`);
}

const WORD_JOINER = "\u2060";

// A link label or display name is one phrase of the sentence around it: a
// word joiner after its own `.`, `!`, or `?` (`J. Smith`, `Read me. Now`)
// keeps `requestSummary` from ending the sentence there.
function inSentence(phrase: string): string {
  return phrase.replace(/([.!?])(?=\s)/g, `$1${WORD_JOINER}`);
}

function slackMarkupText(target: string, label: string | undefined): string {
  if (target.startsWith("@")) return label === undefined ? target : `@${label.replace(/^@/, "")}`;
  if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
  if (target.startsWith("!")) {
    const name = target.slice(1).split("^")[0]!;
    return ["here", "channel", "everyone"].includes(name) ? `@${name}` : (label ?? `@${name}`);
  }
  return label ?? target;
}

/** Jev on a filing request. Never throws. */
export async function triageIntake(input: {
  text: string;
  mcp: HostMcpRegistry;
  kv: KeyedKv;
  env: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<IntakeTriage> {
  const project = jiraProject(input.env as NodeJS.ProcessEnv);
  if (project === undefined) return { by: "model", reason: "no_project" };
  const request = intakeText(input.text);
  const { description } = request;
  const title = fitTitle(request.title);
  const asked = await askTriageJev({
    inbound: { identifier: `${project}-intake`, title: fitAtWord(oneLine(request.title), JEV_TITLE_MAX, true), description },
    project,
    mcp: input.mcp,
    kv: input.kv,
    env: input.env,
    defaultTypes: DESK_ISSUE_TYPES,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  if (asked.status === "skipped") return { by: "model", reason: asked.reason };
  if (asked.status === "unavailable") return { by: "model", reason: "unavailable" };
  const jev: JevPart = { answers: asked.answers, source: asked.state.source, types: asked.types };
  const verdict = templateVerdict({ identifier: "", title, description }, asked.answers);
  if (verdict === undefined || readAnswers(verdict, jev.source, jev.types.source, jev.types.types, jev.answers).status !== "judged") return { by: "model", reason: "labels" };
  // A Story or Task over words that say something is broken now: the model types it (jev-triage.ts typeContradicted).
  // Checked before the bar whenever the type itself is above it: planFiling can only re-run the guard over the model's restatement.
  const typeSure = aboveBar(probabilityOf(asked.answers.issueType));
  if (typeSure && typeContradicted({ text: issueText(request), type: asked.answers.issueType.choice })) return { by: "model", reason: "type_guard", jev };
  if (!allAboveBar(asked.answers)) return { by: "model", reason: "below_bar", jev };
  return { by: "jev", jev, type: asked.answers.issueType.choice, severity: verdict.severity, needsInfo: verdict.needsInfo === true, title };
}

/** The request a stash answers: its Slack ts and text, so a follow-up can be told apart and shown the same prompt. */
export type IntakeSource = { ts: string; text: string };

export async function stashIntakeTriage(kv: KeyedKv, threads: readonly ThreadRef[], triage: IntakeTriage, now: Date, source?: IntakeSource): Promise<void> {
  const value = { exp: now.getTime() + TTL_MS, at: now.getTime(), triage, ...(source === undefined ? {} : { ts: source.ts, text: source.text.slice(0, DESCRIPTION_MAX) }) } as unknown as JsonValue;
  for (const thread of threads) {
    await endFilingHold(kv, thread, now);
    try {
      await kv.put(intakeTriageKey(thread), value);
    } catch (error) {
      warnKv("intake-triage.stashIntakeTriage", error);
      // Unstashed, file_ticket files on the model's triage.
    }
  }
}

export async function readIntakeTriage(kv: KeyedKv, thread: ThreadRef, now: Date): Promise<IntakeTriage | undefined> {
  let value: unknown;
  try {
    value = await kv.get(intakeTriageKey(thread));
  } catch (error) {
    warnKv("intake-triage.readIntakeTriage", error);
    return undefined;
  }
  return liveTriage(value, now);
}

function liveTriage(value: unknown, now: Date): IntakeTriage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as { exp?: unknown; triage?: unknown };
  if (typeof record.exp !== "number" || record.exp <= now.getTime()) return undefined;
  const triage = record.triage as IntakeTriage | undefined;
  return triage?.by === "jev" || triage?.by === "model" ? triage : undefined;
}

/** The ts of the request whose triage is kept at this thread, when the stash names one. */
export async function intakeSourceTs(kv: KeyedKv, thread: ThreadRef): Promise<string | undefined> {
  const value = (await kv.get(intakeTriageKey(thread)).catch((error: unknown) => warnKv("intake-triage.intakeSourceTs", error))) as { ts?: unknown } | null | undefined;
  return typeof value?.ts === "string" ? value.ts : undefined;
}

/** The raw Slack text of the request whose live triage is kept at this thread, when the stash names one. */
export async function intakeSourceText(kv: KeyedKv, thread: ThreadRef, now: Date): Promise<string | undefined> {
  const value = await kv.get(intakeTriageKey(thread)).catch((error: unknown) => warnKv("intake-triage.intakeSourceText", error));
  if (liveTriage(value, now) === undefined) return undefined;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

/**
 * The request `request` (its source ts, from the prompt or filing turn that
 * decided it) is filed or declined: it is settled, so no copy of its triage
 * counts as pending, and the copies here that are its own are deleted. In a
 * DM the channel's copy goes too, only while it is still this request's: a
 * later request overwrites it, and never takes this one's decision.
 */
export async function dropIntakeTriage(kv: KeyedKv, thread: ThreadRef, request: string | undefined, now: Date = new Date()): Promise<void> {
  if (request !== undefined) await kv.put(intakeSettledKey({ channelId: thread.channelId, ts: request }), { exp: now.getTime() + TTL_MS }).catch((error: unknown) => warnKv("intake-triage.dropIntakeTriage", error));
  const drop = async (at: ThreadRef) => {
    if ((await intakeSourceTs(kv, at)) === request) await kv.delete(intakeTriageKey(at)).catch((error: unknown) => warnKv("intake-triage.drop", error));
  };
  await drop(thread);
  if (thread.channelId.startsWith("D") && thread.threadTs !== undefined) await drop({ channelId: thread.channelId });
}

async function isSettled(kv: KeyedKv, request: { channelId: string; ts: string }, now: Date): Promise<boolean> {
  const marker = (await kv.get(intakeSettledKey(request)).catch((error: unknown) => warnKv("intake-triage.isSettled", error))) as { exp?: unknown } | null | undefined;
  return typeof marker?.exp === "number" && marker.exp > now.getTime();
}

// A DM holds every request, so a prompt left unanswered this long no longer
// makes the next plain message a follow-up. A channel thread holds one request.
export const DM_FOLLOW_UP_MS = 30 * 60_000;

/**
 * The unfiled triage another message left in these threads: the filing
 * prompt a follow-up (`also on Safari`, `yes please file it`) is about. Its
 * source is not this message (`ts`), so a redelivery is asked again.
 */
export async function pendingIntake(kv: KeyedKv, threads: readonly ThreadRef[], ts: string, now: Date): Promise<{ triage: IntakeTriage; source: IntakeSource } | undefined> {
  for (const thread of threads) {
    const value = await kv.get(intakeTriageKey(thread)).catch((error: unknown) => warnKv("intake-triage.pendingIntake", error));
    const triage = liveTriage(value, now);
    if (triage === undefined) continue;
    const record = value as { at?: unknown; ts?: unknown; text?: unknown };
    if (typeof record.ts !== "string" || typeof record.text !== "string" || record.ts === ts) continue;
    if (thread.channelId.startsWith("D") && !(typeof record.at === "number" && now.getTime() - record.at < DM_FOLLOW_UP_MS)) continue;
    if (await isSettled(kv, { channelId: thread.channelId, ts: record.ts }, now)) continue;
    return { triage, source: { ts: record.ts, text: record.text } };
  }
  return undefined;
}

const REASONS: Record<FallbackReason, string> = {
  no_key: "Jev is not configured",
  no_text: "the request has no words to judge",
  types: "the project has too few issue types to choose among",
  no_project: "no Jira project is configured",
  unavailable: "Jev did not answer",
  labels: "Jev answered outside the triage labels",
  below_bar: `Jev was not confident: an answer at or under ${JEV_THRESHOLD.toFixed(2)}`,
  type_guard: "Jev chose a Story or Task, but the request says something that exists is broken now",
  no_intake: "no Jev answer was kept for this thread",
};

export function triagedByLead(triage: Pick<IntakeTriage, "by"> & { reason?: FallbackReason; jev?: JevPart }): string {
  const percent = triage.jev === undefined ? undefined : answersConfidence(triage.jev.answers);
  return triagedByPhrase({ by: triage.by, ...(triage.reason === undefined ? {} : { reason: triage.reason }), ...(percent === undefined || triage.by === "jev" ? {} : { percent }) });
}

/** Who made a filing plan's triage, with Jev's confidence, for the Filed post. */
export function filingCredit(plan: Pick<FilingPlan, "by" | "judged" | "reason">): { by: "jev" | "model"; percent?: number; reason?: FallbackReason } {
  const percent = judgmentConfidence(plan.judged);
  return { by: plan.by, ...(percent === undefined ? {} : { percent }), ...(plan.reason === undefined ? {} : { reason: plan.reason }) };
}

/** `78% confidence`, and `; Jev said urgent` when calibrateSeverity lowered Jev's own choice; no number when a probability is missing. */
function jevNote(jev: JevPart, severity: TriageSeverity): string | undefined {
  const own = jev.answers.severity.choice;
  const percent = answersConfidence(jev.answers);
  const notes = [percent === undefined ? undefined : `${percent}% confidence`, own !== severity ? `Jev said ${own}` : undefined].filter((note) => note !== undefined);
  return notes.length === 0 ? undefined : notes.join("; ");
}

/**
 * The line that ends every filing prompt: the decision on this prompt and
 * nothing after it. No mention: a ✅ / ❌ needs none, and a mentioned
 * command is the same command (reaction-targets.ts and one-reply.ts find a
 * filing prompt by its `approve file`).
 */
export const FILING_ASK = "React ✅ to file or ❌ to drop, or reply `approve file` / `deny file`.";

/** The ask where a plain reply never reaches the desk (desk-channels.ts): reactions only, since a hint never carries a mention. */
export const FILING_ASK_REACTIONS = "React ✅ to file or ❌ to drop.";

/** The line a filing prompt adds after the summary when the request is too thin to plan. */
export const NEEDS_INFO_LINE = "The request is too thin to plan: it does not say what was seen, where, or what was expected.";

// Slots the model fills when it triages; everything else in the prompt is host text.
export const SLOT = { title: "<a short title in your own words>", type: "<Type>", severity: "<severity>", summary: "<one short sentence in your own words>" } as const;

/**
 * The whole filing prompt, one line per field: the title, who triaged it
 * and the verdict in plain words, `Summary:`, the needs-info line when the
 * request is too thin, and the closing ask. No scores. Jev's triage fills
 * every field; the model's fills the `SLOT` placeholders it is given.
 */
export function filingPrompt(fields: { title: string; lead: string; type: string; severity: string; note?: string; summary: string; needsInfo?: boolean; ask: string }): string {
  return [fields.title, `${fields.lead}: ${fields.type}, ${fields.severity} severity${fields.note === undefined ? "" : ` (${fields.note})`}.`, `Summary: ${fields.summary}`, ...(fields.needsInfo === true ? [NEEDS_INFO_LINE] : []), fields.ask].join("\n");
}

/**
 * The prompt for a request that reached the desk without an intake block
 * (evals, or a Slack request the intake rule missed): the model triages it
 * and fills every slot. It offers ✅/❌ too: in Slack any reply asking for
 * `approve file` is recorded for reactions (one-reply.ts).
 * instructions.md quotes it verbatim (desk-commands.test.ts).
 */
export function unaskedFilingPrompt(): string {
  return filingPrompt({ title: SLOT.title, lead: triagedByLead({ by: "model", reason: "no_intake" }), type: SLOT.type, severity: SLOT.severity, summary: SLOT.summary, ask: FILING_ASK });
}

// A top-level message reaches this block without a filing phrase, so one the
// intake rule over-matched (thanks, a question about the desk) must still get
// its normal answer. A message that says `file a bug` gets no way out.
const NOT_A_FILING = "If this message names no problem and asks for no change (thanks, a greeting, a question about the desk itself), ignore this block and answer it by its own rule. Any problem report or change request gets the filing prompt below.";

/**
 * The context block the filing turn gets: the filing prompt host code
 * assembled, verbatim for Jev's triage, with slots for the model's. The
 * title is always a slot the turn writes (`TITLE_RULE`): TLSSN-46's title was
 * the reporter's first line, two sentences and a question. The request's own
 * first line (`intakeText`, `fitTitle`) is still what a summary is checked
 * against. `explicit`: the message carried a filing phrase, so it is a filing
 * request whatever else it says.
 */
export function intakeTriageContext(triage: IntakeTriage, options: { text: string; explicit?: boolean; bareReply?: boolean }): string {
  const request = intakeText(options.text);
  const title = fitTitle(request.title);
  const ask = options.bareReply === false ? FILING_ASK_REACTIONS : FILING_ASK;
  const lead = triagedByLead(triage);
  const escape = options.explicit === true ? [] : [NOT_A_FILING];
  if (triage.by === "jev") {
    const lifted = usableSummary(triage.summary, [title, triage.title]);
    const summary = lifted !== undefined && copiesRequest({ summary: lifted, request: options.text }) ? undefined : lifted;
    const severity = calibrateSeverity({ text: issueText(request), type: triage.type, severity: triage.severity });
    return [
      "<intake_triage by=\"jev\">",
      ...escape,
      summary === undefined
        ? `Host code triaged this request with Jev before filing (every answer above ${JEV_THRESHOLD.toFixed(2)}); do not re-judge it. Jev gives no title or summary, so you write only those. Your whole reply is the filing prompt below with the title and summary slots filled and every other character kept: nothing before or after it, no narration, no scores.`
        : `Host code triaged this request with Jev before filing (every answer above ${JEV_THRESHOLD.toFixed(2)}); do not re-judge it. Jev gives no title, so you write only that. Your whole reply is the filing prompt below with the title slot filled and every other character kept: nothing before or after it, no narration, no scores.`,
      "<filing_prompt>",
      filingPrompt({ title: SLOT.title, lead, type: triage.type, severity, note: jevNote(triage.jev, severity), summary: summary ?? SLOT.summary, needsInfo: triage.needsInfo, ask }),
      "</filing_prompt>",
      TITLE_RULE,
      ...(summary === undefined ? [SUMMARY_RULE] : []),
      "On approve file, the ticket is filed with this triage; pass the same title, severity, and summary to the filing tool.",
      "</intake_triage>",
    ].join("\n");
  }
  const confidentType = triage.jev === undefined || triage.reason === "type_guard" ? undefined : confidentJevType(triage.jev, issueText(request));
  return [
    "<intake_triage by=\"model\">",
    ...escape,
    `Jev did not settle this request (${REASONS[triage.reason]}), so you triage it in this turn with the rubric below. Your whole reply is the filing prompt below with each <…> slot filled and every other character kept: nothing before or after it, no narration, no search for a skill or file, no scores.`,
    "<filing_prompt>",
    filingPrompt({ title: SLOT.title, lead, type: confidentType ?? SLOT.type, severity: SLOT.severity, summary: SLOT.summary, ask }),
    "</filing_prompt>",
    TITLE_RULE,
    ...(confidentType === undefined ? [`${SLOT.type}: Bug for a bug, Task for feedback or a question.`] : [`${confidentType} is fixed: Jev was sure of the Jira type, so the ticket is filed as ${confidentType}.`]),
    severityRule({ text: issueText({ title: request.title, description: request.description }), type: confidentType }),
    SUMMARY_RULE,
    `When the request is too thin to plan, add this line after the summary, exactly: ${NEEDS_INFO_LINE}`,
    "On approve file, pass the same title, kind (bug, feedback, or question), severity, and summary to the filing tool.",
    "<triage_rubric>",
    TRIAGE_RUBRIC.trim(),
    "</triage_rubric>",
    "</intake_triage>",
  ].join("\n");
}

// The fallback turn fills <severity> itself, so it is told the ceiling
// calibrateSeverity will hold file_ticket to, over the same words. With no
// confident type it is read as a Bug: the guard caps a Bug only on evidence,
// and a type the model picks is capped by file_ticket in any case.
function severityRule({ text, type }: { text: string; type: string | undefined }): string {
  const ceiling = severityCeiling({ text, type: type ?? "Bug" });
  if (ceiling === "urgent") return `${SLOT.severity}: low, medium, high, or urgent. High and urgent only for what the rubric says.`;
  if (ceiling === "low") return `${SLOT.severity}: low. A question is low unless it names data loss, a security exposure, or an outage.`;
  return type === undefined || type.trim().toLowerCase() === "bug"
    ? `${SLOT.severity}: low or medium. The request is about typed input, how the UI looks, or a change the reporter wants, and names no data loss, security exposure, or outage, so it is never high or urgent.`
    : `${SLOT.severity}: low or medium. A ${type.trim()} is a request or a chore, and this one names no data loss, security exposure, or outage, so it is never high or urgent.`;
}

const TITLE_RULE = `${SLOT.title}: a short title in your own words, under 80 characters, on the first line: what is broken or wanted and where, stated plainly (for example \`CSV download missing on the Activity page\`). Not a question, not a request, one phrase only; never copy the reporter's sentence and never add their reasons.`;

const SUMMARY_RULE = `${SLOT.summary}: one short sentence, after \`Summary: \`, in your own words: what is wrong, where it shows, and the likely cause or area when the request makes it evident. Add something the title does not say. Never copy a sentence from the request, never the title line again, and never the type or severity.`;

const SUMMARY_MAX = 200;
const FOOTER = /^[*_]*sent using\b/i;
// `_On main:_`, `*Repro:*`, `*Expected*:` opening a line: the reporter's layout, not their words.
const LINE_LABEL = /^[*_]{1,2}\p{L}[\p{L}\p{N} ]{0,30}(?::[*_]{1,2}|[*_]{1,2}:)\s*/u;
// A run marker opening a line, such as `[reaction-e2e A2 20260927-2206]`: a hyphenated slug, then anything to the bracket.
const RUN_TAG = /^\[[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\s[^\]\n]*)?\]\s*/i;

/**
 * The summary a request carries itself: its first sentence after the title
 * (`intakeText`'s, uncut: the first line, or a one-paragraph request's first
 * sentence), without Slack's `Sent using` footer, line labels (`_On main:_`),
 * or run tags. Undefined when the request is only its title, so no summary
 * ever just repeats the line above it.
 */
export function requestSummary(title: string, description: string): string | undefined {
  const raw = proseLines(description);
  const head = title.trim();
  // The title may follow an opener (`Hi team!`) the title left out; what comes before it is not the summary either.
  // `capitalizedTitle` may have raised the first letter the reporter typed lowercase.
  const typed = (line: string) => [head, `${head.charAt(0).toLowerCase()}${head.slice(1)}`].map((form) => line.indexOf(form)).find((index) => index !== -1) ?? -1;
  const at = head === "" ? -1 : raw.findIndex((line) => typed(line) !== -1);
  const after = at === -1 ? raw : [raw[at]!.slice(typed(raw[at]!) + head.length), ...raw.slice(at + 1)];
  const lines = after.map((line) => line.replace(RUN_TAG, "").trim().replace(LINE_LABEL, "").trim());
  const rest = lines.join(" ").replace(/\s+/g, " ").trim();
  if (rest === "") return undefined;
  return usableSummary(capitalized(fitSummary(firstSentence(rest))), [head]);
}

const ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "approx.", "incl.", "mr.", "mrs.", "ms.", "dr.", "cf."]);
// Dotted initials such as `U.S.`, `a.m.`, `p.m.`.
const INITIALISM = /^(?:\p{L}\.){2,}$/u;
const CLOSERS = new Set(['"', "'", "”", "’", ")", "）", "」", "』", "】", "》"]);
// Full-width sentence ends, which CJK text follows with no space.
const WIDE_ENDS = new Set(["。", "！", "？", "．", "｡"]);
const ENDS = new Set([".", "!", "?", ...WIDE_ENDS]);

/**
 * Backticks pair in order, first with second, third with fourth; each pair
 * is a code span, both backticks included. An odd last backtick is literal.
 */
function codeSpans(text: string): { spans: Array<[number, number]>; literal?: number } {
  const ticks = [...text.matchAll(/`/g)].map((match) => match.index);
  const spans: Array<[number, number]> = [];
  for (let i = 0; i + 1 < ticks.length; i += 2) spans.push([ticks[i]!, ticks[i + 1]!]);
  return ticks.length % 2 === 1 ? { spans, literal: ticks[ticks.length - 1]! } : { spans };
}

/**
 * Up to the first run of `.`, `!`, or `?` (`?!`, `...`, and any closing
 * quote) before a space or the end, or of full-width `。！？．` (`！！`) with
 * no space after it, outside a code span (`codeSpans`), and not ending an
 * abbreviation, dotted initials, or a lone capital initial (`J. Smith`). A
 * `．` by a digit (`１．５`, `手順１．`) ends nothing, nor does a full-width
 * end inside a closing bracket the sentence goes on after (`「保存しました。」と`).
 * `inTitle`: a lowercase word after a quote or `...` continues the sentence
 * (`"Saved." toast is silent`, `hangs... then fails`); after a bare `.` it
 * does not, since Slack requests are often typed without capitals.
 */
function firstSentence(text: string, inTitle = false): string {
  const { spans } = codeSpans(text);
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!ENDS.has(char)) continue;
    if (spans.some(([start, end]) => start < i && i < end)) continue;
    // `１．５` is a number and `手順１．` a list marker.
    if (char === "．" && (/\p{N}/u.test(text[i - 1] ?? "") || /\p{N}/u.test(text[i + 1] ?? ""))) continue;
    let stop = i + 1;
    while (stop < text.length && (ENDS.has(text[stop]!) || text[stop] === "…")) stop++;
    const run = text.slice(i, stop);
    let end = stop;
    while (end < text.length && CLOSERS.has(text[end]!)) end++;
    const quoted = end > stop;
    const start = i;
    i = stop - 1;
    if ([...run].some((mark) => WIDE_ENDS.has(mark))) {
      // `「保存しました。」というトースト`: the quote ended there, not the sentence.
      if (quoted && end < text.length && !/\s/.test(text[end]!)) {
        i = end - 1;
        continue;
      }
      return text.slice(0, end);
    }
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    if (inTitle && (quoted || run.startsWith("..")) && /^\s+\p{Ll}/u.test(text.slice(end))) continue;
    const word = text.slice(0, start + 1).split(/[\s(]/).pop()!;
    if (run === "." && (ABBREVIATIONS.has(word.toLowerCase()) || INITIALISM.test(word) || /^\p{Lu}\.$/u.test(word))) continue;
    return text.slice(0, end);
  }
  return text;
}

function fitSummary(sentence: string): string {
  return fitAtWord(sentence, SUMMARY_MAX);
}

/**
 * At most `max` characters: cut between words (`wordPrefix`), ending with
 * `…`. A code span the cut would split is dropped whole, and a literal
 * backtick in what is left is removed, so the cut never shows an open span.
 * `keepWords`, for a title: when that leaves no letter or digit (the text
 * opens with one long code span), the words are kept and the backticks go.
 */
function fitAtWord(text: string, max: number, keepWords = false): string {
  if (text.length <= max) return text;
  const prefix = wordPrefix(text, max - 1);
  let cut = prefix;
  const { spans, literal } = codeSpans(text);
  const split = spans.find(([start, end]) => start < cut.length && end >= cut.length);
  if (split !== undefined) cut = cut.slice(0, split[0]);
  if (literal !== undefined && literal < cut.length) cut = `${cut.slice(0, literal)}${cut.slice(literal + 1)}`;
  if (keepWords && comparable(cut) === "") cut = prefix.replaceAll("`", "");
  return `${cut.replace(/[\s,;:(\-–—]+$/, "")}…`;
}

/**
 * A title with its first letter raised (a dropped `Quick question:` can leave
 * `the transfer box …`), unless it opens with code or an identifier: a
 * camelCase or inner-capital word (`iOS`), snake_case, kebab-case with a
 * digit, a path (`a/b.ts`), a URL, or a file name with an extension. A
 * backtick, `./`, `/`, `~/`, `--flag`, `@handle`, or `#channel` is not a
 * letter, so it stays as typed anyway.
 */
export function capitalizedTitle(title: string): string {
  const word = title.match(/^\S*/)![0].replace(/[.,;:!?)\]}'"”’…]+$/u, "");
  if (!/^\p{Ll}/u.test(word) || isIdentifier(word)) return title;
  return title.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

function isIdentifier(word: string): boolean {
  return (
    /\p{Lu}/u.test(word.slice(1)) ||
    word.includes("_") ||
    /[/\\]/.test(word) ||
    /^[a-z][a-z0-9+.-]*:\S/i.test(word) ||
    (word.includes("-") && /\p{N}/u.test(word)) ||
    /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z][a-z0-9]{0,7}$/iu.test(word)
  );
}

/** A lowercase first letter raised, unless the first word (before any hyphen) is a name or identifier that is spelled that way (`iOS`, `npm2`, `foo_bar`, `exportCsv()`). */
function capitalized(text: string): string {
  const word = text.match(/^[^\s-]*/)![0];
  if (/[\p{Lu}\p{N}_./\\()[\]{}<>=:@#$]/u.test(word.slice(1))) return text;
  return text.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

// A summary that is empty, only the title again, or #155's templated
// `<Type> reported as "<title>", <severity> severity.` (still in threads
// stashed before this) says nothing the title does not.
const TEMPLATED_SUMMARY = /^\S+ reported as ".*", (?:low|medium|high|urgent) severity\.$/;

function usableSummary(summary: string | undefined, titles: readonly (string | undefined)[]): string | undefined {
  const text = summary?.replace(/\s+/g, " ").trim();
  if (text === undefined || text === "" || TEMPLATED_SUMMARY.test(text)) return undefined;
  const key = comparable(text);
  // Nothing but punctuation, such as the bare `…` of a request that opens with one long code span.
  if (key === "") return undefined;
  return titles.some((title) => title !== undefined && comparable(title) !== "" && comparable(title) === key) ? undefined : text;
}

const COPY_MIN = 24;

/**
 * True when a summary is the request's own words lifted whole (the first
 * sentence after its title, or any run of the request as long as the
 * summary): it restates what the reporter wrote instead of adding to it.
 */
export function copiesRequest({ summary, request }: { summary: string; request: string }): boolean {
  const key = comparable(summary.replace(/…$/, ""));
  if (key.length < COPY_MIN) return false;
  const parts = intakeText(request);
  const first = requestSummary(parts.title, parts.description);
  if (first !== undefined && comparable(first.replace(/…$/, "")) === key) return true;
  return comparable(request).includes(key);
}

function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The title the filing prompt shows: whole up to TITLE_MAX, else cut between words (`fitAtWord`). */
/**
 * The request's own first line, cleaned and fitted (`intakeText`, `fitTitle`):
 * what Jev reads as the title and what a summary must not repeat. The filing
 * prompt's title is the turn's own (`TITLE_RULE`), never this line.
 */
export function fittedRequestTitle(text: string): string {
  return fitTitle(intakeText(text).title);
}

function fitTitle(title: string): string {
  return fitAtWord(oneLine(title), TITLE_MAX, true);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function confidentJevType(jev: JevPart, text: string): string | undefined {
  const placeholder: TriageVerdict = { identifier: "", kind: "question", severity: "low", title: "", summary: "", nextStep: "" };
  const judged = guardJudgmentType(readAnswers(placeholder, jev.source, jev.types.source, jev.types.types, jev.answers), text);
  return judged.status === "judged" && judged.type.confident ? judged.type.choice : undefined;
}

/** The Severity: line names the verdict's severity, keeping Jev's own choice as `cappedFrom` when the verdict is lower. */
function agreeSeverity(judged: TriageJudgment, severity: TriageSeverity): TriageJudgment {
  if (judged.status !== "judged" || judged.severity.choice === severity) return judged;
  const lower = SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(judged.severity.choice);
  const cappedFrom = judged.severity.cappedFrom ?? (lower ? judged.severity.choice : undefined);
  return { ...judged, severity: { ...judged.severity, choice: severity, applied: severity !== judged.severity.model, ...(cappedFrom === undefined ? {} : { cappedFrom }) } };
}

const SEVERITY_ORDER: readonly TriageSeverity[] = ["low", "medium", "high", "urgent"];

export type ModelTriage = { title: string; kind: TriageKind; severity: TriageSeverity; summary: string; nextStep?: string; needsInfo?: boolean };

/** What file_ticket files: the verdict, Jev's judgment of it, and the Jira type to create with when Jev chose one. */
export type FilingPlan = {
  by: "jev" | "model";
  /** `identifier` is filled in once Jira names the key. */
  verdict: TriageVerdict;
  judged: TriageJudgment;
  createType?: IssueTypeRef;
  reason?: FallbackReason;
  /** The summary is Jev's title template, kept for the Triage: comment only: the Filed post leaves it out. */
  summaryFromTemplate?: true;
};

/**
 * `text` is the reporter's words (file_ticket's description; defaults to the
 * model's title and summary); severity from
 * Jev or the model goes through `calibrateSeverity` over it, so a stash from
 * before the guard, or a model that ignored the prompt's ceiling, is capped
 * here too. `request` is the reporter's own message: a summary lifted
 * from it whole is dropped (`copiesRequest`).
 */
export function planFiling(triage: IntakeTriage | undefined, model: ModelTriage, options: { text?: string; request?: string } = {}): FilingPlan {
  const text = options.text ?? issueText({ title: model.title, description: model.summary });
  const { request } = options;
  if (triage?.by === "jev") {
    // Calibrated over the reporter's text before the template sees it, so the model's title can only lower it further, never lift a cap.
    const severity = calibrateSeverity({ text, type: triage.jev.answers.issueType.choice, severity: triage.severity });
    const answers = { ...triage.jev.answers, severity: { ...triage.jev.answers.severity, choice: severity } };
    const templated = templateVerdict({ identifier: "", title: model.title, description: text }, answers);
    if (templated !== undefined) {
      const titles = [triage.title, model.title];
      const own = (candidate: string | undefined) => {
        const usable = usableSummary(candidate, titles);
        return usable !== undefined && request !== undefined && copiesRequest({ summary: usable, request }) ? undefined : usable;
      };
      const summary = own(triage.summary) ?? own(model.summary);
      const verdict = { ...templated, summary: summary ?? templated.summary };
      const judged = agreeSeverity(calibrateJudgment(readAnswers(verdict, triage.jev.source, triage.jev.types.source, triage.jev.types.types, triage.jev.answers), text), verdict.severity);
      if (judged.status === "judged") return { by: "jev", verdict, judged: { ...judged, jevOnly: true }, createType: typeRef(judged), ...(summary === undefined ? { summaryFromTemplate: true as const } : {}) };
    }
  }
  const severity = calibrateSeverity({ text, type: model.kind, severity: model.severity });
  const lifted = request !== undefined && copiesRequest({ summary: model.summary, request });
  const template = lifted ? { summaryFromTemplate: true as const } : {};
  const verdict: TriageVerdict = {
    identifier: "",
    kind: model.kind,
    severity,
    title: model.title,
    summary: lifted ? `${issueTypeFor(model.kind)} reported as "${fitAtWord(oneLine(model.title), 160, true)}", ${severity} severity.` : model.summary,
    nextStep: model.nextStep?.trim() || TEMPLATE_NEXT_STEP[model.kind],
    ...(model.needsInfo === true ? { needsInfo: true } : {}),
  };
  const reason: FallbackReason = triage?.by === "model" ? triage.reason : "no_intake";
  if (triage?.by === "model" && triage.jev !== undefined) {
    const answered = readAnswers(verdict, triage.jev.source, triage.jev.types.source, triage.jev.types.types, triage.jev.answers);
    // The intake ran the type guard over the reporter's own words; `text` here may be the model's restatement.
    // Held before calibrating, so a held type never caps the severity.
    const judged = calibrateJudgment(triage.reason === "type_guard" ? holdJudgmentType(answered) : guardJudgmentType(answered, text), text);
    if (judged.status === "judged") {
      const createType = judged.type.confident ? typeRef(judged) : undefined;
      return { by: "model", verdict, judged, reason, ...template, ...(createType === undefined ? {} : { createType }) };
    }
  }
  const judged: TriageJudgment = reason === "no_key" ? { status: "skipped", reason: "no_key" } : { status: "unavailable", message: REASONS[reason] };
  return { by: "model", verdict, judged, reason, ...template };
}

function typeRef(judged: Extract<TriageJudgment, { status: "judged" }>): IssueTypeRef {
  return { name: judged.type.choice, ...(judged.type.id === undefined ? {} : { id: judged.type.id }) };
}

/**
 * The Triage: comment for the filed ticket, once Jira says which type it was
 * created with. It ends with DESK_TRIAGED_LINE, so triage-jira and the
 * planner can tell the desk's verdict from any later one.
 */
export function settleFiling(plan: FilingPlan, issueKey: string, write: IssueTypeWrite | { status: "not_written" }) {
  const { verdict, judgment } = settleJudgment({ ...plan.verdict, identifier: issueKey }, plan.judged, write);
  const issueType = write.status === "set" && plan.createType !== undefined ? plan.createType.name : issueTypeFor(plan.verdict.kind);
  return { verdict, judgment, issueType, comment: withDeskTriaged(triageComment(verdict, undefined, triageRecordLines(judgment), issueType)) };
}

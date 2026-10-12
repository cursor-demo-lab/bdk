// The Slack post for a ticket whose plan has landed: Block Kit for the
// approver, plus a plain `text` fallback for notifications and clients that
// do not render blocks. Pure; announcePlan (agent/lib/announce.ts) owns the post.

import { jiraCloudId } from "./atlassian.js";
import type { PlanDigest } from "./plan-comment.js";
import { wordPrefix } from "./word-cut.js";

export const SLACK_LIMITS = {
  blocks: 50,
  sectionText: 3000,
  fields: 10,
  fieldText: 2000,
  headerText: 150,
  contextElements: 10,
  messageText: 40000,
} as const;

// Headroom under Slack's ~40k message text cap: Slack counts after its own
// entity handling, which this code does not model exactly.
const FALLBACK_TEXT_MAX = 39000;
// A phone shows about a screen of this post; the rest is one tap away on the ticket.
const LIST_ITEMS_MAX = 6;
const ELLIPSIS = "\u2026";

export type Block = { type: string } & Record<string, unknown>;

export type PlanPostInput = {
  issueKey: string;
  title: string;
  tracker: string;
  digest?: PlanDigest;
  /** Problem text the caller already had, shown when the comment carries none. */
  problem?: string;
  ticketUrl?: string;
  planUrl?: string;
  /** The Slack user who filed the ticket. Absent: approved only in Jira. */
  originatorUserId?: string;
  /** Filed from Slack with no recorded filer, so it has no Slack approver. */
  filedInSlack?: boolean;
  /** False where a plain reply never reaches the desk (desk-channels.ts): the post then offers reactions only. */
  bareReply?: boolean;
};

const ON_TICKET = new Set(["transitioned", "commented", "already_commented"]);

/** Jira site origin, when the configured cloud id is the site URL (the Rovo server accepts either). */
export function jiraSiteUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = jiraCloudId(env);
  try {
    const url = new URL(id);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function ticketUrl(input: { issueKey: string; url?: string; site?: string }): string | undefined {
  if (input.url !== undefined && input.url !== "") return input.url;
  return input.site === undefined ? undefined : `${input.site}/browse/${input.issueKey}`;
}

/** The ticket URL focused on the plan comment, or the ticket URL when the comment id is unknown. */
export function planCommentUrl(input: { ticketUrl?: string; commentId?: string }): string | undefined {
  const { ticketUrl: base, commentId } = input;
  if (base === undefined) return undefined;
  if (commentId === undefined || !/^\d+$/.test(commentId)) return base;
  try {
    const url = new URL(base);
    url.searchParams.set("focusedCommentId", commentId);
    return url.toString();
  } catch {
    return base;
  }
}

export function planPost(input: PlanPostInput): { text: string; blocks: Block[] } {
  return { text: fallbackText(input), blocks: planBlocks(input) };
}

export function planBlocks(input: PlanPostInput): Block[] {
  const { issueKey, digest } = input;
  const more = moreLink(input);
  const summary = digest?.summary ?? nonEmpty(input.problem);
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: fitPlain(`${issueKey} is planned: ${oneLine(input.title)}`, SLACK_LIMITS.headerText) } },
  ];
  if (summary !== undefined) blocks.push(section(labelled("Problem", summary, more)));
  if (digest?.approach !== undefined) blocks.push(section(labelled("Approach", digest.approach, more)));

  const fields = gradeFields(digest);
  if (fields.length > 0) blocks.push({ type: "section", fields: fields.slice(0, SLACK_LIMITS.fields) });
  if (digest !== undefined && digest.areas.length > 0) blocks.push(section(bulleted("Files or areas", digest.areas, more)));
  if (digest !== undefined && digest.testPlan.length > 0) blocks.push(section(bulleted("Test plan", digest.testPlan, more)));
  if (digest === undefined || digest.format === "legacy") {
    blocks.push(context([digest === undefined ? "The full plan is on the ticket." : "Written before the plan digest existed; the full plan is on the ticket."]));
  }

  const tail: Block[] = [{ type: "divider" }, section(approvalLine(input)), context(linkLine(input))];
  return [...blocks.slice(0, SLACK_LIMITS.blocks - tail.length), ...tail];
}

export type RootPostInput = { issueKey: string; title: string; status: string; ticketUrl?: string };

/**
 * The top-level post that opens a Jira-filed ticket's thread in the intake
 * channel: headline, key, status, and the Jira link. The plan and every
 * update are replies under it; the status line is rewritten in place. No
 * one filed it from Slack, so the desk takes no `approve`, `replan`, or
 * `retry` here (host-refusal.ts `unbound`); the note says so before anyone
 * tries.
 */
export function rootPost(input: RootPostInput): { text: string; blocks: Block[] } {
  const headline = fitMrkdwn(`${input.issueKey}: ${oneLine(input.title)}`, 300);
  const jira = input.ticketUrl === undefined ? input.issueKey : link({ url: input.ticketUrl, label: `${input.issueKey} on Jira` });
  const status = `Status: *${escapeMrkdwn(input.status)}*  \u00b7  ${jira}`;
  const note =
    "Filed in Jira, not from Slack. Approve, replan, or retry it on the Jira board.";
  return {
    text: `${headline}\n${status}\n${note}`,
    blocks: [section(`*${headline}*\n${status}`), context([note])],
  };
}

function fallbackText(input: PlanPostInput): string {
  const { issueKey, digest } = input;
  const summary = digest?.summary ?? nonEmpty(input.problem);
  const grades = [
    digest?.risk === undefined ? undefined : `Risk: ${gradeText(digest.risk.level, digest.risk.reason)}`,
    digest?.size === undefined ? undefined : `Size: ${gradeText(digest.size.estimate, digest.size.reason)}`,
  ].filter((part) => part !== undefined);
  const plan = input.planUrl ?? input.ticketUrl;
  const lines = [
    `${issueKey} is planned: ${oneLine(input.title)}.`,
    summary === undefined ? undefined : `Problem: ${oneLine(summary)}`,
    digest?.approach === undefined ? undefined : `Approach: ${oneLine(digest.approach)}`,
    grades.length === 0 ? undefined : grades.join(" | "),
    digest === undefined || digest.areas.length === 0 ? undefined : `Files or areas: ${shortList(digest.areas, ", ")}`,
    digest === undefined || digest.testPlan.length === 0 ? undefined : `Test plan: ${shortList(digest.testPlan, "; ")}`,
    whereLine(input.tracker, plan),
    approvalText(input),
  ].filter((line) => line !== undefined);
  const suffix = plan === undefined ? "" : ` Full plan: ${plan}`;
  const prefix = input.originatorUserId === undefined ? "" : `<@${input.originatorUserId}> `;
  return fitMrkdwn(lines.join("\n"), FALLBACK_TEXT_MAX, { suffix, prefix });
}

function shortList(items: readonly string[], separator: string): string {
  const hidden = items.length - LIST_ITEMS_MAX;
  return `${items.slice(0, LIST_ITEMS_MAX).join(separator)}${hidden > 0 ? `${separator}and ${hidden} more` : ""}`;
}

function whereLine(tracker: string, url: string | undefined): string {
  if (!ON_TICKET.has(tracker)) return `The plan is recorded in the factory (the ticket comment did not land: ${tracker}).`;
  return url === undefined ? "The plan is on the ticket." : `The plan is on the ticket: ${url}`;
}

// The decision on this plan and nothing after it. No mention: a reaction
// needs none, and bare `approve` / `deny` are the replies the desk takes in a
// plan thread (approve-command.ts, plain-reply.ts); the keyed forms still work.
// Where a plain reply never arrives, only the reactions are offered.
function decision(input: PlanPostInput): string {
  if (input.bareReply === false) return "react ✅ to start the build or ❌ to stop.";
  return `react ✅ to start the build or ❌ to stop, or reply \`approve\` / \`deny\`.`;
}

function approvalText(input: PlanPostInput): string {
  if (input.originatorUserId === undefined) return jiraOnlyText(input);
  const line = decision(input);
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

function approvalLine(input: PlanPostInput): string {
  if (input.originatorUserId === undefined) return jiraOnlyText(input);
  return `<@${input.originatorUserId}>, ${decision(input)}`;
}

function jiraOnlyText(input: PlanPostInput): string {
  const why = input.filedInSlack === true ? "has no Slack approver on record" : "was filed in Jira";
  return `${input.issueKey} ${why}: to start the build, move the card to Approved in Jira.`;
}

function linkLine(input: PlanPostInput): string[] {
  const parts: string[] = [];
  if (input.ticketUrl !== undefined) parts.push(link({ url: input.ticketUrl, label: `${input.issueKey} on Jira` }));
  if (input.planUrl !== undefined && input.planUrl !== input.ticketUrl) parts.push(link({ url: input.planUrl, label: "Full plan and worker brief" }));
  if (input.digest?.evidence !== undefined) parts.push(`Evidence: ${fitMrkdwn(compactEvidence(firstSentence(input.digest.evidence)), 300)}`);
  if (!ON_TICKET.has(input.tracker)) parts.push(`The ticket comment did not land (${escapeMrkdwn(input.tracker)}); the plan is recorded in the factory.`);
  if (parts.length === 0) parts.push(`${input.issueKey}: the plan is on the ticket.`);
  return [parts.join("  \u00b7  ")];
}

function gradeFields(digest: PlanDigest | undefined): { type: "mrkdwn"; text: string }[] {
  if (digest === undefined) return [];
  const fields: { type: "mrkdwn"; text: string }[] = [];
  if (digest.risk !== undefined) fields.push(mrkdwn(fitMrkdwn(gradeText(digest.risk.level, digest.risk.reason), SLACK_LIMITS.fieldText, { prefix: "*Risk*\n" })));
  if (digest.size !== undefined) fields.push(mrkdwn(fitMrkdwn(gradeText(digest.size.estimate, digest.size.reason), SLACK_LIMITS.fieldText, { prefix: "*Size*\n" })));
  return fields;
}

function gradeText(grade: string | undefined, reason: string | undefined): string {
  const head = grade === undefined ? "" : grade.charAt(0).toUpperCase() + grade.slice(1);
  if (reason === undefined) return head === "" ? "unstated" : head;
  return head === "" ? reason : `${head}. ${reason}`;
}

function labelled(label: string, text: string, more: string): string {
  return fitMrkdwn(oneLine(text), SLACK_LIMITS.sectionText, { suffix: ` ${more}`, prefix: `*${label}*\n` });
}

function bulleted(label: string, items: readonly string[], more: string): string {
  const shown = items.slice(0, LIST_ITEMS_MAX);
  const hidden = items.length - shown.length;
  const body = [...shown.map((item) => `\u2022 ${oneLine(item)}`), ...(hidden > 0 ? [`and ${hidden} more`] : [])].join("\n");
  return fitMrkdwn(body, SLACK_LIMITS.sectionText, { suffix: ` ${more}`, prefix: `*${label}*\n` });
}

function moreLink(input: PlanPostInput): string {
  const url = input.planUrl ?? input.ticketUrl;
  return url === undefined ? "(full plan on the ticket)" : link({ url, label: "full plan on the ticket" });
}

function section(text: string): Block {
  return { type: "section", text: mrkdwn(text) };
}

function mrkdwn(text: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text };
}

function context(texts: readonly string[]): Block {
  return { type: "context", elements: texts.slice(0, SLACK_LIMITS.contextElements).map((text) => mrkdwn(fitMrkdwn(text, SLACK_LIMITS.sectionText, { escape: false }))) };
}

/** A mrkdwn link. The label is escaped; characters that end the link syntax are percent-encoded in the URL. */
export function link({ url, label }: { url: string; label: string }): string {
  const safe = url.replace(/[<>|\s]/g, (char) => encodeURIComponent(char));
  return `<${safe}|${escapeMrkdwn(label)}>`;
}

/** Slack's three control characters in mrkdwn text. */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * `prefix` + escaped `raw`, at most `max` characters. When it does not fit,
 * the text is cut between words before escaping (between graphemes when
 * that would drop more than half the room, as in `wordPrefix`), so no word,
 * entity, surrogate pair, or emoji sequence is split, and it ends in an
 * ellipsis plus `suffix`. `prefix` and `suffix` are already mrkdwn.
 */
export function fitMrkdwn(
  raw: string,
  max: number,
  { suffix = "", prefix = "", escape = true }: { suffix?: string; prefix?: string; escape?: boolean } = {}
): string {
  const encode = escape ? escapeMrkdwn : (text: string) => text;
  const whole = `${prefix}${encode(raw)}`;
  if (whole.length <= max) return whole;
  const room = max - prefix.length - ELLIPSIS.length - suffix.length;
  return `${prefix}${encode(wordPrefix(raw, room, (part) => encode(part).length))}${ELLIPSIS}${suffix}`;
}

/** Plain text (no escaping) cut between words (`wordPrefix`) with an ellipsis. */
export function fitPlain(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${wordPrefix(text, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** `read the repo checkout (a, b, c)` names every file the planner read; the count is enough here. */
function compactEvidence(text: string): string {
  return text.replace(/\(([^()]*,[^()]*)\)$/, (_, list: string) => `(${list.split(",").length} files)`);
}

function firstSentence(text: string): string {
  const end = text.search(/\.(?:\s|$)/);
  return end === -1 ? text : text.slice(0, end);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function nonEmpty(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

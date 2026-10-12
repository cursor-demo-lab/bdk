import type { HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { isRecord, withCloudId } from "./atlassian.js";
import { setStatusReaction } from "./status-reaction.js";
import { parseThreadRef, ticketKey } from "./threads.js";
import { issueStatus, readCommentRecords, stagingWriteRefusal, type CommentRecord } from "./jira.js";
import { statusNames } from "./config.js";
import { isPlanComment } from "./plan-comment.js";
import { type KeyedKv, planDeclinedKey } from "./kv-keys.js";
import { warnKv, warnStep } from "./ops-funnel.js";

export { planDeclinedKey };

export const DENIED_PREFIX = "Denied in Slack by ";

const FALLBACK_NAME = "a person in the Slack thread";

/** The denial line, with `by` cut to the shape `isDeniedComment` accepts, so every line the desk writes is one it recognises. */
export function deniedComment(by: string): string {
  const words = by
    .replace(/[^\p{L}\p{M}\p{N}.'_-]+/gu, " ")
    .split(" ")
    .filter((word) => /^[\p{L}\p{M}\p{N}]/u.test(word))
    .slice(0, 6);
  return `${DENIED_PREFIX}${words.length === 0 ? FALLBACK_NAME : words.join(" ")}`;
}

export type PlanDecline = { state: "declined" | "open"; planId?: string } | { state: "unread" };

/**
 * Whether the ticket's current plan is already declined: a `Denied in
 * Slack` comment after its latest `Plan:` comment. Jira is the record, not
 * a claim, since a ❌ re-added after its claim expired or a `deny KEY`
 * after a ❌ must not write a second denial, and a replan's new `Plan:`
 * comment opens the next one. Unreadable comments are `unread`; callers
 * write nothing then. `planId` names the latest `Plan:` comment when Jira
 * gave its id.
 */
export async function planDecline(mcp: HostMcpRegistry, issueKey: string): Promise<PlanDecline> {
  const read = await readCommentRecords(mcp, issueKey).catch(() => undefined);
  if (read?.status !== "read") return { state: "unread" };
  let plan: CommentRecord | undefined;
  let planAt = -1;
  let deniedAt = -1;
  commentOrder(read.comments).forEach((comment, at) => {
    if (isPlanComment(comment.body, issueKey)) {
      plan = comment;
      planAt = at;
    } else if (isDeniedComment(comment.body)) deniedAt = at;
  });
  const state = deniedAt > planAt ? "declined" : "open";
  const planId = (plan as CommentRecord | undefined)?.id;
  return planId === undefined ? { state } : { state, planId };
}

// Only the line `deniedComment` writes: one line, a Slack name after the
// prefix (letters, digits, spaces, `.'_-`, at most six words). A person's
// `Denied in Slack by mistake? …` is not it. Comment records carry no
// author; `deniedComment` cuts every name to this shape.
const DENIED_LINE = /^Denied in Slack by [\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}.'_-]*(?: [\p{L}\p{M}\p{N}.'_-]+){0,5}$/u;

export function isDeniedComment(body: string): boolean {
  return DENIED_LINE.test(body.trim());
}

// Jira comment ids are numeric strings that grow with creation, so "10"
// sorts after "9" only numerically. Without an id on every comment the
// connector's order (oldest first) stands.
function commentOrder(comments: readonly CommentRecord[]): readonly CommentRecord[] {
  if (!comments.every((comment) => comment.id !== undefined && /^\d+$/.test(comment.id))) return comments;
  return [...comments].sort((a, b) => {
    const x = BigInt(a.id!);
    const y = BigInt(b.id!);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

export const PLAN_DECLINED_LABEL = "plan-declined";
const EDIT_ISSUE_TOOL = /(?:^|-)edit(?:[_-]?jira)?[_-]?issue$/i;
const GET_ISSUE_TOOL = /(?:^|-)get(?:[_-]?jira)?[_-]?issue$/i;

export type LabelWrite = "set" | "cleared" | "unchanged" | "not_connected" | "failed";

/**
 * The `plan-declined` label, so a declined plan shows on the board and not
 * only in a comment. `on` adds it (a ❌ or `deny KEY` recorded the decline);
 * off removes it (a new plan, or an approval). Jira's `update.labels`
 * add/remove when the edit tool takes `update`, else the labels read and
 * written whole. Best effort: the decline comment is the record.
 */
export async function planDeclinedLabel(mcp: HostMcpRegistry, input: { issueKey: string; on: boolean }): Promise<LabelWrite> {
  const { issueKey, on } = input;
  if (stagingWriteRefusal(issueKey) !== undefined) return "failed";
  if (!mcp.names().includes("tracker")) return "not_connected";
  try {
    const tools = await mcp.listTools("tracker");
    const edit = tools.find((tool) => EDIT_ISSUE_TOOL.test(tool.name));
    if (edit === undefined) return "failed";
    const properties = edit.inputSchema?.["properties"];
    const takesUpdate = isRecord(properties) && "update" in properties;
    let args: Record<string, unknown>;
    if (takesUpdate) {
      args = { issueIdOrKey: issueKey, update: { labels: [on ? { add: PLAN_DECLINED_LABEL } : { remove: PLAN_DECLINED_LABEL }] } };
    } else {
      const labels = await readLabels(mcp, { tools, issueKey });
      if (labels === undefined) return "failed";
      const has = labels.includes(PLAN_DECLINED_LABEL);
      if (has === on) return "unchanged";
      args = { issueIdOrKey: issueKey, fields: { labels: on ? [...labels, PLAN_DECLINED_LABEL] : labels.filter((label) => label !== PLAN_DECLINED_LABEL) } };
    }
    const reply = await mcp.callTool("tracker", edit.name, withCloudId(edit, args));
    if (reply.isError === true) return "failed";
    return on ? "set" : "cleared";
  } catch {
    return "failed";
  }
}

async function readLabels(mcp: HostMcpRegistry, input: { tools: readonly HostMcpToolInfo[]; issueKey: string }): Promise<string[] | undefined> {
  const get = input.tools.find((tool) => GET_ISSUE_TOOL.test(tool.name));
  if (get === undefined) return undefined;
  const properties = get.inputSchema?.["properties"];
  const fieldsType = isRecord(properties) && isRecord(properties["fields"]) ? properties["fields"]["type"] : undefined;
  const fields = fieldsType === "array" || (Array.isArray(fieldsType) && fieldsType.includes("array")) ? ["labels"] : "labels";
  const reply = await mcp.callTool("tracker", get.name, withCloudId(get, { issueIdOrKey: input.issueKey, ...(isRecord(properties) && "fields" in properties ? { fields } : {}) }));
  if (reply.isError === true) return undefined;
  for (const candidate of [reply.structuredContent, parseJson(reply.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join(""))]) {
    const labels = labelsIn(candidate);
    if (labels !== undefined) return labels;
  }
  return undefined;
}

function labelsIn(value: unknown): string[] | undefined {
  if (!isRecord(value)) return undefined;
  const fields = isRecord(value["fields"]) ? value["fields"] : undefined;
  const labels = fields?.["labels"] ?? value["labels"];
  if (Array.isArray(labels)) return labels.filter((label): label is string => typeof label === "string");
  if (fields !== undefined) return [];
  for (const nested of Object.values(value)) {
    const found = typeof nested === "object" && nested !== null ? labelsIn(Array.isArray(nested) ? nested[0] : nested) : undefined;
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

type LabelHost = { kv: KeyedKv; mcp: HostMcpRegistry };

/** The label on, and a kv record of it, so the next plan or approval knows to take it off without reading Jira. */
export async function markPlanDeclined(host: LabelHost, issueKey: string): Promise<LabelWrite> {
  const label = await planDeclinedLabel(host.mcp, { issueKey, on: true });
  if (label === "set" || label === "unchanged") await host.kv.put(planDeclinedKey(issueKey), { at: new Date().toISOString() }).catch((error: unknown) => warnKv("plan-decline.markPlanDeclined", error));
  return label;
}

/** Host clock against Jira's: how far apart the decline time and a move's time may be and still read as simultaneous. */
export const DECLINE_CLOCK_SKEW_MS = 2 * 60_000;

/** A new plan or an approval: the label comes off when the desk put it on. Never throws. */
export async function clearPlanDeclined(host: LabelHost, issueKey: string, options: { movedAt?: Date } = {}): Promise<LabelWrite | "none"> {
  let record: Awaited<ReturnType<LabelHost["kv"]["get"]>>;
  try {
    record = await host.kv.get(planDeclinedKey(issueKey));
  } catch (error) {
    warnKv("plan-decline.clearPlanDeclined", error);
    return "failed";
  }
  if (record === undefined) return "none";
  // A move from before the decline (a late or replayed delivery) does not undo a later decline.
  // `at` is the host clock and movedAt Jira's, so only a move clearly older than the skew counts.
  const at = typeof record === "object" && record !== null && !Array.isArray(record) ? Date.parse(String((record as Record<string, unknown>)["at"])) : Number.NaN;
  if (options.movedAt !== undefined && !Number.isNaN(at) && options.movedAt.getTime() < at - DECLINE_CLOCK_SKEW_MS) return "none";
  let label: LabelWrite;
  try {
    label = await planDeclinedLabel(host.mcp, { issueKey, on: false });
  } catch (error) {
    warnStep("plan-decline.clearPlanDeclined.label", error);
    return "failed";
  }
  if (label === "cleared" || label === "unchanged") {
    try {
      await host.kv.delete(planDeclinedKey(issueKey));
    } catch (error) {
      warnKv("plan-decline.clearPlanDeclined.delete", error);
      return "failed";
    }
  }
  return label;
}

/** The one line either decline gets (❌ on the plan post, or a typed `deny`): this step, and the one thing to do now. */
export function declinedLine(input: { issueKey: string; prefix: string }): string {
  return `${input.issueKey}: plan declined, so nothing is built. To change it, add a comment on ${input.issueKey} and say \`${input.prefix}replan ${input.issueKey}\`.`;
}

/**
 * Everything a decline records past its `Denied in Slack by` comment, the
 * same for ❌ and a typed `deny`: the `plan-declined` label, and the thread
 * root's stage reaction moved from 📝 (planned) to 🚫 (declined). Never throws.
 */
export async function recordDecline(host: LabelHost & { slack: { getClient(): Promise<unknown> } }, issueKey: string): Promise<{ label: LabelWrite; stage: string }> {
  const label = await markPlanDeclined(host, issueKey).catch((): LabelWrite => "failed");
  // The stage mark is best effort; the decline is on the ticket.
  let ticket: ReturnType<typeof parseThreadRef>;
  try {
    ticket = parseThreadRef(await host.kv.get(ticketKey(issueKey)));
  } catch (error) {
    warnKv("plan-decline.recordDecline", error);
    return { label, stage: "failed" };
  }
  let stage = "failed";
  try {
    stage = await setStatusReaction({ kv: host.kv, client: await host.slack.getClient(), issueKey, ticket, stage: "declined" });
  } catch (error) {
    warnStep("plan-decline.recordDecline.reaction", error);
  }
  return { label, stage };
}

export type DeclineGate =
  | { state: "open"; planId?: string }
  | { state: "declined"; planId?: string }
  | { state: "not_planned"; status: string }
  | { state: "status_unread" }
  | { state: "comments_unread" };

/**
 * The one check both declines make (❌ on the plan post, and `deny` /
 * `deny KEY` through deny_ticket) before they record anything: the ticket
 * must be Planned, then its latest plan open or already declined. A ticket
 * In Progress, In Review, or Done has no plan to decline, and recording one
 * there would say "nothing is built" about work already under way.
 */
export async function declineGate(mcp: HostMcpRegistry, issueKey: string): Promise<DeclineGate> {
  const planned = statusNames(process.env).planned.trim().toLowerCase();
  const [live, decided] = await Promise.all([issueStatus(mcp, issueKey), planDecline(mcp, issueKey)]);
  if (live.status !== "read") return { state: "status_unread" };
  if (live.name.trim().toLowerCase() !== planned) return { state: "not_planned", status: live.name };
  if (decided.state === "unread") return { state: "comments_unread" };
  const planId = decided.planId === undefined ? {} : { planId: decided.planId };
  return decided.state === "declined" ? { state: "declined", ...planId } : { state: "open", ...planId };
}

/** Both declines' answer for a ticket that is not Planned. */
export function notPlannedLine(input: { issueKey: string; status: string }): string {
  return `${input.issueKey} is ${input.status}, not Planned, so there is no plan to decline.`;
}

/** Both declines' answer for a plan Jira already shows declined. */
export function alreadyDeclinedLine(issueKey: string): string {
  return `The plan for ${issueKey} is already declined; nothing changed.`;
}

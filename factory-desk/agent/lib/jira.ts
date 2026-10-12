import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import {
  LIST_COMMENTS_OPERATION,
  adfText,
  LIST_TRANSITIONS_OPERATION,
  executeArgs,
  executeReadTool,
  findTool,
  isRecord,
  issueReadArgs,
  withCloudId,
} from "./atlassian.js";
import { jiraProjects } from "./config.js";
import { inProjectScope } from "./factory-env.js";
import { factoryStage } from "./factory-stage.js";
import type { IssueTypeRef } from "./issue-type.js";
import { jiraSiteUrl, ticketUrl } from "./plan-post.js";
import type { TriageKind } from "./triage-verdict.js";

// Jira through the signed-in account's connector. Tool discovery by name
// shape and argument names from the tool's own schema, as triage-jira and
// the planner do, because the connector's tool names are not fixed. The
// Atlassian names (getJiraIssue, createJiraIssue, addOrEditJiraIssueComment,
// addCommentToJiraIssue, getTransitionsForJiraIssue, listJiraIssueTransitions,
// transitionJiraIssue) and generic snake_case names both match.

export const CONNECTION_NAME = "tracker";
export const PROJECT_ENV = "FACTORY_DESK_JIRA_PROJECT";
const ISSUE_ID = /\b[A-Z][A-Z0-9]{0,9}-\d+\b/;
const JIRA_URL = /https:\/\/\S+\/browse\/[A-Z][A-Z0-9]{0,9}-\d+/i;

const CREATE_ISSUE_TOOL = /(?:^|-)(?:create|add|new|open)(?:[_-]?jira)?[_-]?issue$/i;
const LIST_COMMENT_TOOL = /(?:^|-)(?:list|get|read)(?:[_-]?jira)?(?:[_-]?issue)?[_-]?comments?$/i;
const ADD_COMMENT_TOOL =
  /(?:^|-)(?:add|create|save|post)(?:[_-]?or[_-]?(?:edit|update))?(?:[_-]?jira)?(?:[_-]?issue)?[_-]?comment(?:[_-]?to)?(?:[_-]?jira)?(?:[_-]?issue)?$/i;
const GET_ISSUE_TOOL = /(?:^|-)(?:get|read|fetch|view|show)(?:[_-]?jira)?[_-]?issue$/i;
const LIST_TRANSITIONS_TOOL = /(?:^|-)(?:get|list)(?:[_-]?jira)?(?:[_-]?issue)?[_-]?transitions?(?:[_-]?for[_-]?(?:jira[_-]?)?issue)?$/i;
const TRANSITION_TOOL = /(?:^|-)(?:do[_-]?|perform[_-]?)?transition(?:[_-]?jira)?(?:[_-]?issue)?$/i;

const TRANSITION_ALIASES = ["transitionId", "transition_id", "transition", "id"] as const;
const TRANSITION_NAME_ALIASES = ["transitionName", "status", "toStatus", "name"] as const;
const TRANSITION_WRAP_KEYS = ["transitions", "items", "data", "nodes"] as const;
const STATUS_WRAP_KEYS = ["issue", "issues", "nodes", "data", "result", "content"] as const;
const DETAIL_MAX = 240;

const ALIASES = {
  project: ["projectKey", "project_key", "project", "projectId", "project_id"],
  summary: ["summary", "title", "name"],
  description: ["description", "body", "text"],
  type: ["issueTypeName", "issue_type_name", "issueType", "issue_type", "issuetype", "type"],
  issue: ["issueKey", "issue_key", "issueIdOrKey", "issueId", "issue_id", "key", "identifier", "id"],
  comment: ["comment", "body", "text", "message"],
  // Atlassian's comment tools take `commentBody`; reads never carry that key.
  commentArg: ["commentBody", "comment", "body", "text", "message"],
} as const;

const COMMENT_WRAP_KEYS = ["comments", "comment", "nodes", "items", "results", "data", "content", "replies"] as const;

export type CommentRead =
  | { status: "read"; issueKey: string; comments: string[] }
  | { status: "not_connected"; issueKey: string }
  | { status: "failed"; issueKey: string; message: string };

export type CommentRecord = { id?: string; body: string };

export type CommentRecordsRead =
  | { status: "read"; issueKey: string; comments: CommentRecord[] }
  | { status: "not_connected"; issueKey: string }
  | { status: "failed"; issueKey: string; message: string };

export type CommentWrite =
  | { status: "commented"; issueKey: string }
  | { status: "not_connected"; issueKey: string }
  | { status: "failed"; issueKey: string; message: string };

export type CreateOutcome =
  | { status: "created"; issueKey: string; url?: string; project: string }
  | { status: "not_connected"; project: string }
  | { status: "failed"; project: string; message: string };

export type TransitionOutcome =
  | { status: "transitioned" }
  | { status: "already" }
  | { status: "no_transition"; available: string[] }
  | { status: "not_connected" }
  | { status: "failed"; message: string };

/** Status name as Jira reports it, or why the get-issue read could not yield one. */
export type IssueStatusRead =
  | { status: "read"; name: string }
  | { status: "unread"; detail?: string }
  | { status: "not_connected" };

type Transition = { id: string; name: string; to?: string };

export function jiraProject(env: NodeJS.ProcessEnv): string | undefined {
  return jiraProjects(env, PROJECT_ENV)[0];
}

/**
 * Why a staging slug must not write to `issueKey`, or undefined when it may:
 * on staging the key's project has to be one of the desk's configured
 * projects, and an empty list refuses every key (factory-env.ts
 * inProjectScope). Production is unchanged. Every Jira write here checks it
 * before any connector call, so no tool or host path can move, comment on,
 * or label a production ticket from a staging slug.
 */
export function stagingWriteRefusal(issueKey: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (factoryStage(env) === "production") return undefined;
  const projects = [...new Set([...jiraProjects(env, PROJECT_ENV), ...jiraProjects(env)])];
  const dash = issueKey.lastIndexOf("-");
  const project = (dash <= 0 ? issueKey : issueKey.slice(0, dash)).trim().toUpperCase();
  if (inProjectScope(env, { projects, project })) return undefined;
  console.log(JSON.stringify({ desk: "staging_refused", issueKey, projects }));
  return `FACTORY_ENV is staging and ${project} is not one of this slug's Jira projects (${projects.join(", ") || "none"}), so nothing was written to ${issueKey}.`;
}

/** The Jira issue type the desk files for a kind when Jev chose none: Bug for a defect, else Task. */
export function issueTypeFor(kind: TriageKind): string {
  return kind === "bug" ? "Bug" : "Task";
}

/** `issueType` (Jev's choice among the project's own type names) wins over the kind's own type. */
export async function createIssue(
  mcp: HostMcpRegistry,
  input: { title: string; description: string; kind: TriageKind; issueType?: IssueTypeRef },
  env: NodeJS.ProcessEnv
): Promise<CreateOutcome> {
  const project = jiraProject(env);
  if (project === undefined) {
    // file_ticket forwards message only when status is failed, so the model
    // can read which variable to set. Nothing is called; this is a refusal.
    return {
      status: "failed",
      project: "",
      message: "Set FACTORY_DESK_JIRA_PROJECT or FACTORY_JIRA_PROJECTS to a Jira project key.",
    };
  }
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected", project };
  let tools: HostMcpToolInfo[];
  try {
    tools = await mcp.listTools(CONNECTION_NAME);
  } catch {
    return { status: "not_connected", project };
  }
  const tool = tools.find((candidate) => CREATE_ISSUE_TOOL.test(candidate.name));
  if (tool === undefined) return { status: "failed", project, message: "the tracker connector exposes no create-issue tool" };
  const args: Record<string, unknown> = {
    [pickProperty(tool, ALIASES.project)]: project,
    [pickProperty(tool, ALIASES.summary)]: input.title,
    [pickProperty(tool, ALIASES.description)]: input.description,
    [pickProperty(tool, ALIASES.type)]: input.issueType?.name ?? issueTypeFor(input.kind),
  };
  const created = await call(mcp, tool, args);
  if (!created.ok) return { status: "failed", project, message: created.message };
  const result = created.result;
  const key = issueKeyIn(result, project);
  if (key === undefined) return { status: "failed", project, message: `created, but no ${project}- key in the connector's reply` };
  // createJiraIssue returns REST `self` (api.atlassian.com or /rest/api/3/issue/…),
  // not a browse URL. Scraping /browse/ from the reply only works when the
  // connector already inlined one; otherwise build it from `self` or the site.
  const url = createdIssueUrl(result, key, env);
  return { status: "created", issueKey: key, project, ...(url === undefined ? {} : { url }) };
}

export async function readComments(mcp: HostMcpRegistry, issueKey: string): Promise<CommentRead> {
  const read = await readCommentRecords(mcp, issueKey);
  return read.status === "read" ? { status: "read", issueKey, comments: read.comments.map((comment) => comment.body) } : read;
}

/** Comments with their Jira ids where the connector returns them, oldest first as Jira lists them. */
export async function readCommentRecords(mcp: HostMcpRegistry, issueKey: string): Promise<CommentRecordsRead> {
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected", issueKey };
  let tools: HostMcpToolInfo[];
  try {
    tools = await mcp.listTools(CONNECTION_NAME);
  } catch {
    return { status: "not_connected", issueKey };
  }
  const listTool = tools.find((tool) => LIST_COMMENT_TOOL.test(tool.name));
  if (listTool !== undefined) {
    const listed = await call(mcp, listTool, { [pickProperty(listTool, ALIASES.issue)]: issueKey });
    if (!listed.ok) return { status: "failed", issueKey, message: listed.message };
    return { status: "read", issueKey, comments: commentRecordsFrom(listed.result) };
  }
  const execute = executeReadTool(tools);
  const getTool = tools.find((tool) => GET_ISSUE_TOOL.test(tool.name));
  if (execute !== undefined) {
    const listed = await call(mcp, execute, executeArgs(LIST_COMMENTS_OPERATION, { issueIdOrKey: issueKey }));
    if (listed.ok) return { status: "read", issueKey, comments: commentRecordsFrom(listed.result) };
    if (getTool === undefined) return { status: "failed", issueKey, message: listed.message };
  }
  if (getTool === undefined) return { status: "failed", issueKey, message: "the tracker connector exposes no comment read tool" };
  const read = await call(mcp, getTool, { [pickProperty(getTool, ALIASES.issue)]: issueKey, ...issueReadArgs(getTool) });
  if (!read.ok) return { status: "failed", issueKey, message: read.message };
  return { status: "read", issueKey, comments: commentRecordsFrom(read.result) };
}

export async function addComment(
  mcp: HostMcpRegistry,
  input: { issueKey: string; body: string }
): Promise<CommentWrite> {
  const { issueKey, body } = input;
  const refused = stagingWriteRefusal(issueKey);
  if (refused !== undefined) return { status: "failed", issueKey, message: refused };
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected", issueKey };
  let tools: HostMcpToolInfo[];
  try {
    tools = await mcp.listTools(CONNECTION_NAME);
  } catch {
    return { status: "not_connected", issueKey };
  }
  const addTool = findTool(tools, ADD_COMMENT_TOOL);
  if (addTool === undefined) return { status: "failed", issueKey, message: "the tracker connector exposes no comment tool" };
  const added = await call(mcp, addTool, {
    [pickProperty(addTool, ALIASES.issue)]: issueKey,
    [pickProperty(addTool, ALIASES.commentArg)]: body,
  });
  if (!added.ok) return { status: "failed", issueKey, message: added.message };
  return { status: "commented", issueKey };
}

export async function transitionIssue(
  mcp: HostMcpRegistry,
  input: { issueKey: string; toStatus: string }
): Promise<TransitionOutcome> {
  return move<never>(mcp, input, async () => undefined);
}

export type GuardedTransition = TransitionOutcome | { status: "skipped_status"; current?: string; detail?: string };

/**
 * Moves the ticket to `toStatus` only while it is in `from`, as the worker,
 * planner, and triage move. Jira has no conditional transition, so the
 * status is read after the transitions list, as the last call before the
 * move: a move someone else makes can still land between that read and this
 * one, but not across the list call or anything the caller did before it. A
 * ticket already in `toStatus` is `already`. One in another status, or whose
 * status cannot be read, is `skipped_status` and nothing moves.
 */
export async function transitionFrom(
  mcp: HostMcpRegistry,
  input: { issueKey: string; from: string; toStatus: string }
): Promise<GuardedTransition> {
  return move(mcp, input, async (tools) => {
    const read = await statusOf(mcp, tools, input.issueKey);
    if (read.status !== "read") return { status: "skipped_status", ...(read.status === "unread" ? unreadDetail(read.detail) : {}) };
    if (sameStatus(read.name, input.toStatus)) return { status: "already" };
    if (!sameStatus(read.name, input.from)) return { status: "skipped_status", current: read.name };
    return undefined;
  });
}

/** Runs just before the transition call; a value it returns is the answer and nothing moves. */
type MoveGuard<Skip> = (tools: readonly HostMcpToolInfo[]) => Promise<Skip | undefined>;

async function move<Skip>(mcp: HostMcpRegistry, input: { issueKey: string; toStatus: string }, guard: MoveGuard<Skip>): Promise<TransitionOutcome | Skip> {
  const { issueKey, toStatus } = input;
  const refused = stagingWriteRefusal(issueKey);
  if (refused !== undefined) return { status: "failed", message: refused };
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected" };
  let tools: HostMcpToolInfo[];
  try {
    tools = await mcp.listTools(CONNECTION_NAME);
  } catch {
    return { status: "not_connected" };
  }
  const transitionTool = tools.find((tool) => TRANSITION_TOOL.test(tool.name));
  if (transitionTool === undefined) return { status: "failed", message: "the tracker connector exposes no transition tool" };
  const listTool = tools.find((tool) => LIST_TRANSITIONS_TOOL.test(tool.name));
  const execute = listTool === undefined ? executeReadTool(tools) : undefined;
  const issueArg = (tool: HostMcpToolInfo) => ({ [pickProperty(tool, ALIASES.issue)]: issueKey });

  if (listTool === undefined && execute === undefined) {
    const skipped = await guard(tools);
    if (skipped !== undefined) return skipped;
    const nameProperty = pickProperty(transitionTool, TRANSITION_NAME_ALIASES);
    const byName = await call(mcp, transitionTool, { ...issueArg(transitionTool), [nameProperty]: toStatus });
    if (byName.ok) return { status: "transitioned" };
    if (await currentStatusIs(mcp, tools, { issueKey, status: toStatus })) return { status: "already" };
    return { status: "failed", message: byName.message };
  }

  const listed =
    listTool !== undefined
      ? await call(mcp, listTool, issueArg(listTool))
      : await call(mcp, execute!, executeArgs(LIST_TRANSITIONS_OPERATION, { issueIdOrKey: issueKey }));
  if (!listed.ok) return { status: "failed", message: listed.message };
  const transitions = transitionsIn(listed.result);
  const wanted = toStatus.toLowerCase();
  const chosen = transitions.find((t) => t.to?.toLowerCase() === wanted || t.name.toLowerCase() === wanted);
  const skipped = await guard(tools);
  if (skipped !== undefined) return skipped;
  if (chosen === undefined) {
    if (await currentStatusIs(mcp, tools, { issueKey, status: toStatus })) return { status: "already" };
    return { status: "no_transition", available: transitions.map((t) => t.to ?? t.name) };
  }
  const transitionProperty = pickProperty(transitionTool, TRANSITION_ALIASES);
  const done = await call(mcp, transitionTool, {
    ...issueArg(transitionTool),
    [transitionProperty]: transitionProperty === "transition" ? { id: chosen.id } : chosen.id,
  });
  if (!done.ok) return { status: "failed", message: done.message };
  return { status: "transitioned" };
}

type CallOutcome = { ok: true; result: HostMcpCallResult } | { ok: false; message: string };

async function call(mcp: HostMcpRegistry, tool: HostMcpToolInfo, args: Record<string, unknown>): Promise<CallOutcome> {
  let result: HostMcpCallResult;
  try {
    result = await mcp.callTool(CONNECTION_NAME, tool.name, withCloudId(tool, args));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (result.isError === true) return { ok: false, message: resultText(result) };
  return { ok: true, result };
}

/** The issue's status as Jira reports it, or why the get-issue read could not yield one. */
export async function issueStatus(mcp: HostMcpRegistry, issueKey: string): Promise<IssueStatusRead> {
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected" };
  try {
    return await statusOf(mcp, await mcp.listTools(CONNECTION_NAME), issueKey);
  } catch (error) {
    return unread(error);
  }
}

async function currentStatusIs(
  mcp: HostMcpRegistry,
  tools: readonly HostMcpToolInfo[],
  input: { issueKey: string; status: string }
): Promise<boolean> {
  const current = await statusOf(mcp, tools, input.issueKey);
  return current.status === "read" && current.name.toLowerCase() === input.status.toLowerCase();
}

async function statusOf(mcp: HostMcpRegistry, tools: readonly HostMcpToolInfo[], issueKey: string): Promise<IssueStatusRead> {
  const getTool = tools.find((tool) => GET_ISSUE_TOOL.test(tool.name));
  if (getTool === undefined) return unread("the tracker connector exposes no get-issue tool");
  const read = await call(mcp, getTool, { [pickProperty(getTool, ALIASES.issue)]: issueKey, ...statusReadArgs(getTool) });
  if (!read.ok) return unread(read.message);
  for (const value of replyValues(read.result)) {
    const name = statusNameIn(value);
    if (name !== undefined) return { status: "read", name };
  }
  return unread(`${getTool.name} replied without a status. ${replyChannels(read.result)}`);
}

/** `fields` asking for the status alone, shaped to the schema; a full issue read also pulls every comment. */
function statusReadArgs(tool: HostMcpToolInfo): Record<string, unknown> {
  return fieldReadArgs(tool, "status");
}

function fieldReadArgs(tool: HostMcpToolInfo, field: string): Record<string, unknown> {
  const properties = tool.inputSchema?.["properties"];
  const fields = isRecord(properties) ? properties["fields"] : undefined;
  if (fields === undefined) return {};
  const type = isRecord(fields) ? fields["type"] : undefined;
  return { fields: type === "array" || (Array.isArray(type) && type.includes("array")) ? [field] : field };
}

export type FilingRead = { status: "slack" } | { status: "not_slack" } | { status: "unread"; detail?: string } | { status: "not_connected" };

// file_ticket's `Slack thread: <permalink>` line (slack-link.ts), as plain
// text or split across ADF text nodes on the way back.
const FILED_IN_SLACK = /Slack thread:[\s\S]{0,400}?https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/[CG][A-Z0-9]+\/p\d{16}/;

/**
 * Whether the ticket's description carries the Slack filing line, i.e. a
 * person filed it from a Slack thread through `file_ticket`. Only the
 * description counts: the backlink comment the desk leaves on a Jira-filed
 * ticket's intake root is a comment.
 */
export async function filedFromSlack(mcp: HostMcpRegistry, issueKey: string): Promise<FilingRead> {
  try {
    if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected" };
    const tools = await mcp.listTools(CONNECTION_NAME);
    const getTool = tools.find((tool) => GET_ISSUE_TOOL.test(tool.name));
    if (getTool === undefined) return unread("the tracker connector exposes no get-issue tool");
    const read = await call(mcp, getTool, { [pickProperty(getTool, ALIASES.issue)]: issueKey, ...fieldReadArgs(getTool, "description") });
    if (!read.ok) return unread(read.message);
    const values = replyValues(read.result);
    if (values.length === 0) return unread(`${getTool.name} replied with nothing readable`);
    for (const value of values) {
      const description = descriptionIn(value);
      if (description !== undefined && FILED_IN_SLACK.test(typeof description === "string" ? description : JSON.stringify(description))) return { status: "slack" };
    }
    return { status: "not_slack" };
  } catch (error) {
    return unread(error);
  }
}

function descriptionIn(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = descriptionIn(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const fields = isRecord(value["fields"]) ? value["fields"] : undefined;
  if (fields?.["description"] !== undefined && fields["description"] !== null) return fields["description"];
  for (const key of STATUS_WRAP_KEYS) {
    if (value[key] === undefined) continue;
    const found = descriptionIn(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The reply's JSON, structured channel first, then the text. Atlassian's Rovo
 * MCP gives clients it recognises (Cursor among them) an `issues.nodes`
 * envelope as structuredContent and the REST body as text, so neither channel
 * alone is reliably the Jira shape.
 */
function replyValues(result: HostMcpCallResult): unknown[] {
  return [result.structuredContent, tryParseJson(resultText(result))].filter((value) => value !== undefined);
}

function replyChannels(result: HostMcpCallResult): string {
  const structured = result.structuredContent === undefined ? "no structuredContent" : `structuredContent keys: ${Object.keys(result.structuredContent).join(", ") || "none"}`;
  const text = resultText(result);
  return `${structured}. text: ${text === "" ? "empty" : text}`;
}

function sameStatus(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function unread(value: unknown): { status: "unread"; detail?: string } {
  const detail = shortDetail(value);
  return detail === undefined ? { status: "unread" } : { status: "unread", detail };
}

/** Spread onto a `status_unknown` tool result when the get-issue read left a reason. */
export function unreadDetail(detail: string | undefined): { detail?: string } {
  return detail === undefined ? {} : { detail };
}

function shortDetail(value: unknown): string | undefined {
  const text = (value instanceof Error ? value.message : typeof value === "string" ? value : String(value)).replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  return text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX - 1)}…`;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function statusNameIn(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = statusNameIn(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const fromFields = statusName(isRecord(value["fields"]) ? value["fields"]["status"] : undefined);
  if (fromFields !== undefined) return fromFields;
  // Top-level `status` as a string is often an envelope (`ok` / `success`); only `status.name` is a Jira name.
  const fromTop = isRecord(value["status"]) ? statusName(value["status"]) : undefined;
  if (fromTop !== undefined) return fromTop;
  for (const key of STATUS_WRAP_KEYS) {
    if (value[key] === undefined) continue;
    const found = statusNameIn(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function statusName(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (isRecord(value) && typeof value["name"] === "string" && value["name"].trim() !== "") return value["name"];
  return undefined;
}

function transitionsIn(result: HostMcpCallResult): Transition[] {
  for (const value of replyValues(result)) {
    const found = collectTransitions(value);
    if (found.length > 0) return found;
  }
  return [];
}

function collectTransitions(value: unknown, found: Transition[] = []): Transition[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const transition = asTransition(entry);
      if (transition !== undefined) found.push(transition);
    }
    return found;
  }
  if (!isRecord(value)) return found;
  for (const key of TRANSITION_WRAP_KEYS) {
    if (value[key] !== undefined) collectTransitions(value[key], found);
  }
  return found;
}

function asTransition(value: unknown): Transition | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const name = value["name"];
  if ((typeof id !== "string" && typeof id !== "number") || typeof name !== "string") return undefined;
  const to = isRecord(value["to"]) && typeof value["to"]["name"] === "string" ? value["to"]["name"] : undefined;
  return { id: String(id), name, ...(to === undefined ? {} : { to }) };
}

function commentRecordsFrom(result: HostMcpCallResult): CommentRecord[] {
  for (const value of replyValues(result)) {
    const withIds = jiraCommentRecords(value);
    if (withIds.length > 0) return withIds;
  }
  return commentBodiesFrom(result).map((body) => ({ body }));
}

// The same walk as jiraCommentBodies, keeping each comment's id.
function jiraCommentRecords(value: unknown): CommentRecord[] {
  if (Array.isArray(value)) return value.flatMap(jiraCommentRecords);
  if (!isRecord(value)) return [];
  const fields = isRecord(value["fields"]) ? value["fields"] : undefined;
  const page = fields !== undefined && isRecord(fields["comment"]) ? fields["comment"] : value;
  const comments = page["comments"];
  if (Array.isArray(comments)) {
    return comments.flatMap((comment): CommentRecord[] => {
      const body = adfText(isRecord(comment) ? comment["body"] : comment);
      if (body.trim() === "") return [];
      const id = isRecord(comment) ? comment["id"] : undefined;
      return typeof id === "string" || typeof id === "number" ? [{ id: String(id), body }] : [{ body }];
    });
  }
  if (Array.isArray(value["issues"])) return value["issues"].flatMap(jiraCommentRecords);
  return [];
}

function commentBodiesFrom(result: HostMcpCallResult): string[] {
  for (const value of replyValues(result)) {
    const collected = collectCommentBodies(value);
    if (collected.length > 0) return collected;
  }
  const text = resultText(result);
  return text === "" ? [] : [text];
}

function collectCommentBodies(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim() !== "") found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectCommentBodies(entry, found);
    return found;
  }
  if (!isRecord(value)) return found;
  for (const key of ALIASES.comment) {
    const nested = value[key];
    if (typeof nested === "string" && nested.trim() !== "") {
      found.push(nested);
      return found;
    }
  }
  for (const key of COMMENT_WRAP_KEYS) {
    if (value[key] !== undefined) collectCommentBodies(value[key], found);
  }
  return found;
}

export function pickProperty(tool: HostMcpToolInfo, aliases: readonly string[]): string {
  const properties = tool.inputSchema?.["properties"];
  const known = new Set(isRecord(properties) ? Object.keys(properties) : []);
  return aliases.find((alias) => known.has(alias)) ?? aliases[0]!;
}

function issueKeyIn(result: HostMcpCallResult, project: string): string | undefined {
  const inProject = new RegExp(`\\b${project}-\\d+\\b`);
  const candidates = [JSON.stringify(result.structuredContent ?? null), resultText(result)];
  for (const text of candidates) {
    const match = text.match(inProject) ?? text.match(ISSUE_ID);
    if (match !== null) return match[0];
  }
  return undefined;
}

/** Browse URL for a newly created issue: scraped /browse/, else site from `self`, else JIRA_CLOUD_ID. */
function createdIssueUrl(result: HostMcpCallResult, issueKey: string, env: NodeJS.ProcessEnv): string | undefined {
  const scraped = resultText(result).match(JIRA_URL)?.[0];
  const fromSelf = browseUrlFromSelf(selfHref(result), issueKey);
  return ticketUrl({
    issueKey,
    ...(scraped !== undefined ? { url: scraped } : fromSelf !== undefined ? { url: fromSelf } : {}),
    site: jiraSiteUrl(env),
  });
}

function selfHref(result: HostMcpCallResult): string | undefined {
  const structured = result.structuredContent;
  if (isRecord(structured) && typeof structured["self"] === "string") return structured["self"];
  try {
    const parsed: unknown = JSON.parse(resultText(result));
    if (isRecord(parsed) && typeof parsed["self"] === "string") return parsed["self"];
  } catch {
    // The connector answered in prose.
  }
  return undefined;
}

function browseUrlFromSelf(self: string | undefined, issueKey: string): string | undefined {
  if (self === undefined) return undefined;
  try {
    const url = new URL(self);
    if (url.protocol !== "https:") return undefined;
    if (JIRA_URL.test(self)) return self.match(JIRA_URL)?.[0];
    if (url.hostname.endsWith(".atlassian.net")) return `${url.origin}/browse/${issueKey}`;
  } catch {
    return undefined;
  }
  return undefined;
}

function resultText(result: HostMcpCallResult): string {
  return result.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .filter((part) => part !== "")
    .join("\n")
    .trim();
}

import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import {
  LIST_COMMENTS_OPERATION,
  LIST_TRANSITIONS_OPERATION,
  executeArgs,
  executeReadTool,
  findTool,
  issueReadArgs,
  isRecord,
  issueStatusName,
  jiraCommentBodies,
  statusReadArgs,
  withCloudId,
} from "./atlassian.js";
import { jiraProjects } from "./config.js";
import { inProjectScope } from "./factory-env.js";
import { factoryStage } from "./factory-stage.js";

// Host-side Jira over the Cursor account connector, same discovery rules as
// triage-jira's actuate.ts: find tools by name shape, pick argument names
// from the tool's own schema, parse whatever the connector returns. Three
// verbs only: read one issue with its comments or its status, add one
// comment, and move the issue to a named status.

export const CONNECTION_NAME = "tracker";
export const PROJECTS_ENV = "FACTORY_PLANNER_JIRA_PROJECTS";

// Two connector naming styles are seen: `get_issue` / `add_comment` and
// Atlassian's `getJiraIssue` / `addOrEditJiraIssueComment` (v2) or
// `addCommentToJiraIssue` (v1) / `searchJiraIssuesUsingJql`.
const GET_ISSUE_TOOL = /(?:^|-)(?:get|read|fetch|view|show)(?:[_-]?jira)?[_-]?issue$/i;
const SEARCH_ISSUE_TOOL = /(?:search|list|find)(?:[_-]?jira)?[_-]?issues?(?:[_-]?(?:using|with|by)[_-]?jql)?$/i;
const LIST_COMMENT_TOOL = /(?:^|-)(?:list|get|read)(?:[_-]?jira)?(?:[_-]?issue)?[_-]?comments?$/i;
const ADD_COMMENT_TOOL =
  /(?:^|-)(?:add|create|save|post)(?:[_-]?or[_-]?(?:edit|update))?(?:[_-]?jira)?(?:[_-]?issue)?[_-]?comment(?:[_-]?to)?(?:[_-]?jira)?(?:[_-]?issue)?$/i;
// `getTransitionsForJiraIssue` (v1), `listJiraIssueTransitions` (v2), and `get_transitions`.
const LIST_TRANSITIONS_TOOL = /(?:^|-)(?:get|list)(?:[_-]?jira)?(?:[_-]?issue)?[_-]?transitions?(?:[_-]?for[_-]?(?:jira[_-]?)?issue)?$/i;
// `transitionJiraIssue` and `transition_issue`.
const TRANSITION_TOOL = /(?:^|-)(?:do[_-]?|perform[_-]?)?transition(?:[_-]?jira)?(?:[_-]?issue)?$/i;

const ALIASES = {
  issue: ["issueKey", "issue_key", "issueIdOrKey", "issueId", "issue_id", "key", "identifier", "id"],
  query: ["query", "q", "jql", "search", "term", "text"],
  comment: ["comment", "body", "text", "message"],
  // Atlassian's comment tools take `commentBody`; reads never carry that key.
  commentArg: ["commentBody", "comment", "body", "text", "message"],
  title: ["summary", "title", "name", "issueTitle"],
  description: ["description", "body", "text"],
  transition: ["transitionId", "transition_id", "transition", "id"],
  statusName: ["transitionName", "status", "toStatus", "name"],
} as const;

const TRANSITION_WRAP_KEYS = ["transitions", "items", "data"] as const;

const COMMENT_WRAP_KEYS = ["comments", "comment", "nodes", "items", "results", "data", "content", "replies", "issues", "fields"] as const;

export type TicketRead =
  | { status: "read"; issueKey: string; title: string; description: string; comments: string[] }
  | { status: "not_connected"; issueKey: string }
  | { status: "failed"; issueKey: string; message: string };

export type CommentOutcome =
  | { status: "commented"; issueKey: string }
  | { status: "already_commented"; issueKey: string }
  | { status: "not_connected"; issueKey: string }
  | { status: "project_not_allowed"; issueKey: string; allowed: string[] }
  | { status: "projects_unset"; issueKey: string; message: string }
  | { status: "failed"; issueKey: string; message: string };

export type TransitionOutcome =
  | { status: "transitioned" }
  | { status: "already" }
  | { status: "no_transition"; available: string[] }
  | { status: "not_connected" }
  | { status: "failed"; message: string };

type Transition = { id: string; name: string; to: string };

/** Projects the planner may write to. The override, then FACTORY_JIRA_PROJECTS. Empty when neither is set. */
export function allowedProjects(env: NodeJS.ProcessEnv): string[] {
  return jiraProjects(env, PROJECTS_ENV);
}

export function projectOf(issueKey: string): string {
  return issueKey.slice(0, issueKey.indexOf("-"));
}

/**
 * On a staging slug, true when `project` is not one the planner may act on:
 * outside allowedProjects, and every project when that list is empty
 * (factory-env.ts inProjectScope). Always false on production, whose paths
 * are unchanged. Every route and tool that takes a key from a request body,
 * a comment's text, or the model checks it before reading or planning.
 */
export function stagingRefusesProject(env: NodeJS.ProcessEnv, project: string): boolean {
  if (factoryStage(env) === "production") return false;
  return !inProjectScope(env, { projects: allowedProjects(env), project });
}

/** The refusal a staging read or plan of `issueKey` reports. */
export function stagingRefusal(issueKey: string): string {
  return `FACTORY_ENV is staging and ${projectOf(issueKey)} is not one of this planner's Jira projects, so ${issueKey} was not read or planned.`;
}

export async function readTicket(mcp: HostMcpRegistry, issueKey: string): Promise<TicketRead> {
  if (stagingRefusesProject(process.env, projectOf(issueKey))) return { status: "failed", issueKey, message: stagingRefusal(issueKey) };
  const tools = await connectedTools(mcp);
  if (tools === undefined) return { status: "not_connected", issueKey };
  const getTool = tools.find((tool) => GET_ISSUE_TOOL.test(tool.name));
  const searchTool = tools.find((tool) => SEARCH_ISSUE_TOOL.test(tool.name));
  const tool = getTool ?? searchTool;
  if (tool === undefined) return { status: "failed", issueKey, message: "the tracker connector exposes no issue read tool" };
  const args = tool === getTool ? { [pickProperty(tool, ALIASES.issue)]: issueKey, ...issueReadArgs(tool) } : searchArgs(tool, issueKey);
  const issue = await call(mcp, tool, args);
  if (!issue.ok) return { status: "failed", issueKey, message: issue.message };
  const record = firstRecordMentioning(issue.result, issueKey);
  const comments = jiraBodiesIn(issue.result);
  if (comments.length === 0) comments.push(...collectCommentBodies(record?.["comments"] ?? record?.["comment"]));
  if (comments.length === 0) {
    const listed = await listComments(mcp, tools, issueKey, { viaIssue: false });
    if (listed !== undefined) comments.push(...listed);
  }
  return {
    status: "read",
    issueKey,
    title: record === undefined ? "" : firstString(record, ALIASES.title),
    description: record === undefined ? resultText(issue.result) : richTextValue(firstValue(record, ALIASES.description)),
    comments,
  };
}

/**
 * Adds the plan as a comment. An identical body already on the issue is not
 * posted twice; a changed plan is a new comment, so the ticket keeps the
 * history of plans rather than one silently rewritten record.
 */
export async function commentOnTicket(
  mcp: HostMcpRegistry,
  comment: { issueKey: string; body: string },
  env: NodeJS.ProcessEnv
): Promise<CommentOutcome> {
  const { issueKey, body } = comment;
  const allowed = allowedProjects(env);
  if (allowed.length === 0) {
    return {
      status: "projects_unset",
      issueKey,
      message: "Set FACTORY_PLANNER_JIRA_PROJECTS or FACTORY_JIRA_PROJECTS to a comma-separated list of Jira project keys.",
    };
  }
  if (!allowed.includes(projectOf(issueKey))) return { status: "project_not_allowed", issueKey, allowed };
  const tools = await connectedTools(mcp);
  if (tools === undefined) return { status: "not_connected", issueKey };
  const addTool = findTool(tools, ADD_COMMENT_TOOL);
  if (addTool === undefined) return { status: "failed", issueKey, message: "the tracker connector exposes no comment tool" };
  const existing = await listComments(mcp, tools, issueKey, { viaIssue: true });
  if (existing?.some((comment) => comment.trim() === body.trim()) === true) return { status: "already_commented", issueKey };
  const added = await call(mcp, addTool, {
    [pickProperty(addTool, ALIASES.issue)]: issueKey,
    [pickProperty(addTool, ALIASES.commentArg)]: body,
  });
  if (!added.ok) return { status: "failed", issueKey, message: `could not comment on ${issueKey}: ${added.message}` };
  return { status: "commented", issueKey };
}

/**
 * The issue's comment bodies from a comment-list tool, else v2's
 * listJiraIssueComments through executeRead, else (with `viaIssue`) the
 * issue itself. Undefined when none of them answers.
 */
async function listComments(
  mcp: HostMcpRegistry,
  tools: HostMcpToolInfo[],
  issueKey: string,
  options: { viaIssue: boolean }
): Promise<string[] | undefined> {
  const listTool = tools.find((tool) => LIST_COMMENT_TOOL.test(tool.name));
  if (listTool !== undefined) {
    const listed = await call(mcp, listTool, { [pickProperty(listTool, ALIASES.issue)]: issueKey });
    return listed.ok ? commentBodiesFrom(listed.result) : undefined;
  }
  const execute = executeReadTool(tools);
  if (execute !== undefined) {
    const listed = await call(mcp, execute, executeArgs(LIST_COMMENTS_OPERATION, { issueIdOrKey: issueKey }));
    if (listed.ok) return commentBodiesFrom(listed.result);
  }
  const getTool = options.viaIssue ? tools.find((tool) => GET_ISSUE_TOOL.test(tool.name)) : undefined;
  if (getTool === undefined) return undefined;
  const read = await call(mcp, getTool, { [pickProperty(getTool, ALIASES.issue)]: issueKey, ...issueReadArgs(getTool) });
  return read.ok ? commentBodiesFrom(read.result) : undefined;
}

/** A search tool's arguments for one issue key: JQL when the tool takes JQL. */
function searchArgs(tool: HostMcpToolInfo, issueKey: string): Record<string, unknown> {
  const property = pickProperty(tool, ALIASES.query);
  return { [property]: property === "jql" ? `key = ${issueKey}` : issueKey };
}

/**
 * Moves the issue to `toStatus`. The status a ticket enters is the event the
 * next stage wakes on, so this is the hop. Same contract as triage-jira's
 * `transitionIssue`.
 */
export async function transitionIssue(
  mcp: HostMcpRegistry,
  input: { issueKey: string; toStatus: string }
): Promise<TransitionOutcome> {
  const { issueKey, toStatus } = input;
  if (stagingRefusesProject(process.env, projectOf(issueKey))) return { status: "failed", message: stagingRefusal(issueKey) };
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected" };
  let tools: HostMcpToolInfo[];
  try {
    tools = await mcp.listTools(CONNECTION_NAME);
  } catch (error) {
    return { status: "failed", message: errorText(error) };
  }
  if (tools.length === 0) return { status: "not_connected" };
  const transitionTool = tools.find((tool) => TRANSITION_TOOL.test(tool.name));
  if (transitionTool === undefined) return { status: "failed", message: "the tracker connector exposes no transition tool" };
  const issueProperty = pickProperty(transitionTool, ALIASES.issue);
  const listTool = tools.find((tool) => LIST_TRANSITIONS_TOOL.test(tool.name));
  const execute = listTool === undefined ? executeReadTool(tools) : undefined;

  if (listTool === undefined && execute === undefined) {
    const byName = await call(mcp, transitionTool, {
      [issueProperty]: issueKey,
      [pickProperty(transitionTool, ALIASES.statusName, issueProperty)]: toStatus,
    });
    if (byName.ok) return { status: "transitioned" };
    if ((await currentStatus(mcp, tools, issueKey)) === normalize(toStatus)) return { status: "already" };
    return { status: "failed", message: byName.message };
  }

  const listed =
    listTool !== undefined
      ? await call(mcp, listTool, { [pickProperty(listTool, ALIASES.issue)]: issueKey })
      : await call(mcp, execute!, executeArgs(LIST_TRANSITIONS_OPERATION, { issueIdOrKey: issueKey }));
  if (!listed.ok) return { status: "failed", message: listed.message };
  const transitions = transitionsFrom(listed.result);
  const wanted = normalize(toStatus);
  const chosen =
    transitions.find((transition) => normalize(transition.to) === wanted) ??
    transitions.find((transition) => normalize(transition.name) === wanted);
  if (chosen === undefined) {
    if ((await currentStatus(mcp, tools, issueKey)) === wanted) return { status: "already" };
    return { status: "no_transition", available: transitions.map((transition) => transition.to || transition.name) };
  }
  const transitionProperty = pickProperty(transitionTool, ALIASES.transition, issueProperty);
  const moved = await call(mcp, transitionTool, {
    [issueProperty]: issueKey,
    [transitionProperty]: transitionProperty === "transition" ? { id: chosen.id } : chosen.id,
  });
  if (!moved.ok) return { status: "failed", message: `could not move ${issueKey} to ${toStatus}: ${moved.message}` };
  return { status: "transitioned" };
}

export type GuardedTransition = TransitionOutcome | { status: "skipped_status"; current?: string };

/** The issue's status name as Jira reports it, or undefined when it cannot be read. */
export async function issueStatus(mcp: HostMcpRegistry, issueKey: string): Promise<string | undefined> {
  if (stagingRefusesProject(process.env, projectOf(issueKey))) return undefined;
  const tools = await connectedTools(mcp);
  return tools === undefined ? undefined : statusOf(mcp, tools, issueKey);
}

/**
 * Moves the issue to `toStatus` only while it is in `from`. A status that
 * cannot be read is not `from`, so nothing moves.
 */
export async function transitionFrom(
  mcp: HostMcpRegistry,
  input: { issueKey: string; from: string; toStatus: string }
): Promise<GuardedTransition> {
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected" };
  const current = await issueStatus(mcp, input.issueKey);
  if (current === undefined) return { status: "skipped_status" };
  if (normalize(current) !== normalize(input.from)) return { status: "skipped_status", current };
  return transitionIssue(mcp, input);
}

async function currentStatus(mcp: HostMcpRegistry, tools: HostMcpToolInfo[], issueKey: string): Promise<string | undefined> {
  const name = await statusOf(mcp, tools, issueKey);
  return name === undefined ? undefined : normalize(name);
}

async function statusOf(mcp: HostMcpRegistry, tools: HostMcpToolInfo[], issueKey: string): Promise<string | undefined> {
  const getTool = tools.find((tool) => GET_ISSUE_TOOL.test(tool.name));
  if (getTool === undefined) return undefined;
  const read = await call(mcp, getTool, { [pickProperty(getTool, ALIASES.issue)]: issueKey, ...statusReadArgs(getTool) });
  if (!read.ok) return undefined;
  return issueStatusName(read.result);
}

function transitionsFrom(result: HostMcpCallResult): Transition[] {
  const fromStructured = collectTransitions(result.structuredContent);
  if (fromStructured.length > 0) return fromStructured;
  return collectTransitions(tryParseJson(resultText(result)));
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
  const id = typeof value["id"] === "number" ? String(value["id"]) : value["id"];
  if (typeof id !== "string" || id === "") return undefined;
  const name = typeof value["name"] === "string" ? value["name"] : "";
  const to = isRecord(value["to"]) && typeof value["to"]["name"] === "string" ? value["to"]["name"] : "";
  return { id, name, to };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

async function connectedTools(mcp: HostMcpRegistry): Promise<HostMcpToolInfo[] | undefined> {
  if (!mcp.names().includes(CONNECTION_NAME)) return undefined;
  try {
    const tools = await mcp.listTools(CONNECTION_NAME);
    return tools.length === 0 ? undefined : tools;
  } catch {
    return undefined;
  }
}

async function call(
  mcp: HostMcpRegistry,
  tool: HostMcpToolInfo,
  args: Record<string, unknown>
): Promise<{ ok: true; result: HostMcpCallResult } | { ok: false; message: string }> {
  try {
    const result = await mcp.callTool(CONNECTION_NAME, tool.name, withCloudId(tool, args));
    if (result.isError === true) return { ok: false, message: resultText(result) };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
}

export function pickProperty(tool: HostMcpToolInfo, aliases: readonly string[], taken?: string): string {
  const properties = tool.inputSchema?.["properties"];
  const known = new Set(isRecord(properties) ? Object.keys(properties) : []);
  const free = aliases.filter((alias) => alias !== taken);
  return free.find((alias) => known.has(alias)) ?? free[0]!;
}

function firstRecordMentioning(result: HostMcpCallResult, issueKey: string): Record<string, unknown> | undefined {
  const candidates = [result.structuredContent, tryParseJson(resultText(result))];
  for (const candidate of candidates) {
    const found = findRecord(candidate, issueKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findRecord(value: unknown, issueKey: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRecord(entry, issueKey);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const own = ALIASES.issue.some((key) => value[key] === issueKey);
  if (own) return value["fields"] !== undefined && isRecord(value["fields"]) ? { ...value["fields"], ...value } : value;
  for (const key of COMMENT_WRAP_KEYS) {
    const found = findRecord(value[key], issueKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

function jiraBodiesIn(result: HostMcpCallResult): string[] {
  for (const candidate of [result.structuredContent, tryParseJson(resultText(result))]) {
    const bodies = jiraCommentBodies(candidate);
    if (bodies.length > 0) return bodies;
  }
  return [];
}

export function commentBodiesFrom(result: HostMcpCallResult): string[] {
  const fromJira = jiraBodiesIn(result);
  if (fromJira.length > 0) return fromJira;
  const fromStructured = collectCommentBodies(result.structuredContent);
  if (fromStructured.length > 0) return fromStructured;
  const text = resultText(result);
  const fromJson = collectCommentBodies(tryParseJson(text));
  if (fromJson.length > 0) return fromJson;
  return text === "" ? [] : [text];
}

export function collectCommentBodies(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim() !== "") found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectCommentBodies(entry, found);
    return found;
  }
  if (!isRecord(value)) return found;
  const body = firstString(value, ALIASES.comment);
  if (body !== "") {
    found.push(body);
    return found;
  }
  for (const key of ALIASES.comment) {
    const nested = value[key];
    if (nested === undefined || typeof nested === "string") continue;
    const flattened = richTextValue(nested);
    if (flattened !== "") {
      found.push(flattened);
      return found;
    }
  }
  for (const key of COMMENT_WRAP_KEYS) {
    if (value[key] !== undefined) collectCommentBodies(value[key], found);
  }
  return found;
}

/** Atlassian document format and similar rich text flattened to its text nodes. */
export function richTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextValue).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  if (typeof value["text"] === "string") return value["text"];
  // Jira may store a pasted link as an ADF smart link with no text node.
  const attrs = value["attrs"];
  if ((value["type"] === "inlineCard" || value["type"] === "blockCard") && isRecord(attrs) && typeof attrs["url"] === "string") return attrs["url"];
  return richTextValue(value["content"]);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function firstValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
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

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

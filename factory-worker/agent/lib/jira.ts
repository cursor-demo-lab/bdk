import { jiraProjects } from "./config.js";
import { inProjectScope } from "./factory-env.js";
import { factoryStage } from "./factory-stage.js";
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

// Host-side Jira over the Cursor account connector, same discovery rules as
// the desk and the planner: find tools by name shape, pick argument names
// from the tool's own schema, parse whatever the connector returns. Three
// verbs: read the comments, add one comment, move the ticket (optionally
// only from a named status).

export const CONNECTION_NAME = "tracker";

const LIST_COMMENT_TOOL = /(?:^|-)(?:list|get|read)(?:[_-]?jira)?(?:[_-]?issue)?[_-]?comments?$/i;
// `addOrEditJiraIssueComment` (Atlassian v2), `addCommentToJiraIssue` (v1), and `add_comment`.
const ADD_COMMENT_TOOL =
  /(?:^|-)(?:add|create|save|post)(?:[_-]?or[_-]?(?:edit|update))?(?:[_-]?jira)?(?:[_-]?issue)?[_-]?comment(?:[_-]?to)?(?:[_-]?jira)?(?:[_-]?issue)?$/i;
const GET_ISSUE_TOOL = /(?:^|-)(?:get|read|fetch|view|show)(?:[_-]?jira)?[_-]?issue$/i;
// Atlassian names these `getTransitionsForJiraIssue` (v1) or
// `listJiraIssueTransitions` (v2) and `transitionJiraIssue`; generic servers
// use `get_transitions` and `transition_issue`.
const LIST_TRANSITIONS_TOOL = /(?:^|-)(?:get|list)(?:[_-]?jira)?(?:[_-]?issue)?[_-]?transitions?(?:[_-]?for[_-]?(?:jira[_-]?)?issue)?$/i;
const TRANSITION_TOOL = /(?:^|-)(?:do[_-]?|perform[_-]?)?transition(?:[_-]?jira)?(?:[_-]?issue)?$/i;

const ALIASES = {
  issue: ["issueKey", "issue_key", "issueIdOrKey", "issueId", "issue_id", "key", "identifier", "id"],
  comment: ["comment", "body", "text", "message"],
  // Atlassian's comment tools take `commentBody`; reads never carry that key.
  commentArg: ["commentBody", "comment", "body", "text", "message"],
  transitionId: ["transitionId", "transition_id", "transition", "id"],
  transitionName: ["transitionName", "status", "toStatus", "name"],
} as const;

const COMMENT_WRAP_KEYS = ["comments", "comment", "nodes", "items", "results", "data", "content", "replies", "issues", "fields"] as const;
const TRANSITION_WRAP_KEYS = ["transitions", "items", "data"] as const;

export type CommentRead =
  | { status: "read"; issueKey: string; comments: string[] }
  | { status: "not_connected"; issueKey: string }
  | { status: "failed"; issueKey: string; message: string };

export type CommentWrite =
  | { status: "commented"; issueKey: string }
  | { status: "not_connected"; issueKey: string }
  | { status: "failed"; issueKey: string; message: string };

export type TransitionOutcome =
  | { status: "transitioned" }
  | { status: "already" }
  | { status: "no_transition"; available: string[] }
  | { status: "not_connected" }
  | { status: "failed"; message: string };

type Transition = { id: string; name: string; to: string };

/**
 * Why a staging worker must not read or write `issueKey`, or undefined when it
 * may: on staging the key's project has to be one of FACTORY_JIRA_PROJECTS,
 * and an empty list refuses every key (factory-env.ts inProjectScope).
 * Production is unchanged. Every Jira helper here checks it before any call.
 */
export function stagingRefusal(issueKey: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (factoryStage(env) === "production") return undefined;
  const dash = issueKey.lastIndexOf("-");
  const project = dash <= 0 ? issueKey : issueKey.slice(0, dash);
  if (inProjectScope(env, { projects: jiraProjects(env), project })) return undefined;
  return `staging_refuses_production: FACTORY_ENV is staging and ${project} is not one of this worker's Jira projects, so ${issueKey} was not read or written.`;
}

export async function readComments(mcp: HostMcpRegistry, issueKey: string): Promise<CommentRead> {
  const refused = stagingRefusal(issueKey);
  if (refused !== undefined) return { status: "failed", issueKey, message: refused };
  const tools = await connectedTools(mcp);
  if (tools === undefined) return { status: "not_connected", issueKey };
  const listTool = tools.find((tool) => LIST_COMMENT_TOOL.test(tool.name));
  if (listTool !== undefined) {
    const listed = await call(mcp, listTool, { [pickProperty(listTool, ALIASES.issue)]: issueKey });
    if (!listed.ok) return { status: "failed", issueKey, message: listed.message };
    return { status: "read", issueKey, comments: commentBodiesFrom(listed.result) };
  }
  const execute = executeReadTool(tools);
  const getTool = tools.find((tool) => GET_ISSUE_TOOL.test(tool.name));
  if (execute !== undefined) {
    const listed = await call(mcp, execute, executeArgs(LIST_COMMENTS_OPERATION, { issueIdOrKey: issueKey }));
    if (listed.ok) return { status: "read", issueKey, comments: commentBodiesFrom(listed.result) };
    if (getTool === undefined) return { status: "failed", issueKey, message: listed.message };
  }
  if (getTool === undefined) return { status: "failed", issueKey, message: "the tracker connector exposes no comment read tool" };
  const read = await call(mcp, getTool, { [pickProperty(getTool, ALIASES.issue)]: issueKey, ...issueReadArgs(getTool) });
  if (!read.ok) return { status: "failed", issueKey, message: read.message };
  return { status: "read", issueKey, comments: commentBodiesFrom(read.result) };
}

export async function addComment(
  mcp: HostMcpRegistry,
  input: { issueKey: string; body: string }
): Promise<CommentWrite> {
  const { issueKey, body } = input;
  const refused = stagingRefusal(issueKey);
  if (refused !== undefined) return { status: "failed", issueKey, message: refused };
  const tools = await connectedTools(mcp);
  if (tools === undefined) return { status: "not_connected", issueKey };
  const addTool = findTool(tools, ADD_COMMENT_TOOL);
  if (addTool === undefined) return { status: "failed", issueKey, message: "the tracker connector exposes no comment tool" };
  const added = await call(mcp, addTool, {
    [pickProperty(addTool, ALIASES.issue)]: issueKey,
    [pickProperty(addTool, ALIASES.commentArg)]: body,
  });
  if (!added.ok) return { status: "failed", issueKey, message: added.message };
  return { status: "commented", issueKey };
}

/**
 * Moves the ticket to `toStatus` through whichever transition leads there.
 * Jira names transitions freely ("Start work"), so the target status of each
 * listed transition is matched first and the transition name second.
 */
export async function transitionIssue(
  mcp: HostMcpRegistry,
  input: { issueKey: string; toStatus: string }
): Promise<TransitionOutcome> {
  const { issueKey, toStatus } = input;
  const refused = stagingRefusal(issueKey);
  if (refused !== undefined) return { status: "failed", message: refused };
  const tools = await connectedTools(mcp);
  if (tools === undefined) return { status: "not_connected" };
  const moveTool = tools.find((tool) => TRANSITION_TOOL.test(tool.name));
  if (moveTool === undefined) return { status: "failed", message: "the tracker connector exposes no transition tool" };
  const issueArg = pickProperty(moveTool, ALIASES.issue);
  const listTool = tools.find((tool) => LIST_TRANSITIONS_TOOL.test(tool.name));
  const execute = listTool === undefined ? executeReadTool(tools) : undefined;

  if (listTool === undefined && execute === undefined) {
    const nameArg = pickProperty(moveTool, ALIASES.transitionName, [issueArg]);
    const moved = await call(mcp, moveTool, { [issueArg]: issueKey, [nameArg]: toStatus });
    if (moved.ok) return { status: "transitioned" };
    if (sameName(await currentStatus(mcp, tools, issueKey), toStatus)) return { status: "already" };
    return { status: "failed", message: moved.message };
  }

  const listed =
    listTool !== undefined
      ? await call(mcp, listTool, { [pickProperty(listTool, ALIASES.issue)]: issueKey })
      : await call(mcp, execute!, executeArgs(LIST_TRANSITIONS_OPERATION, { issueIdOrKey: issueKey }));
  if (!listed.ok) return { status: "failed", message: listed.message };
  const transitions = transitionsFrom(listed.result);
  const chosen =
    transitions.find((transition) => sameName(transition.to, toStatus)) ??
    transitions.find((transition) => sameName(transition.name, toStatus));
  if (chosen === undefined) {
    if (sameName(await currentStatus(mcp, tools, issueKey), toStatus)) return { status: "already" };
    return { status: "no_transition", available: transitions.map((transition) => transition.to || transition.name) };
  }
  const idArg = pickProperty(moveTool, ALIASES.transitionId, [issueArg]);
  const moved = await call(mcp, moveTool, {
    [issueArg]: issueKey,
    [idArg]: idArg === "transition" ? { id: chosen.id } : chosen.id,
  });
  if (!moved.ok) return { status: "failed", message: moved.message };
  return { status: "transitioned" };
}

export type GuardedTransition = TransitionOutcome | { status: "skipped_status"; current?: string };

export type StatusRead = { status: "read"; name: string } | { status: "unread" } | { status: "not_connected" };

/** The ticket's status name as Jira reports it. */
export async function issueStatus(mcp: HostMcpRegistry, issueKey: string): Promise<StatusRead> {
  if (stagingRefusal(issueKey) !== undefined) return { status: "unread" };
  const tools = await connectedTools(mcp);
  if (tools === undefined) return { status: "not_connected" };
  const name = await currentStatus(mcp, tools, issueKey);
  return name === "" ? { status: "unread" } : { status: "read", name };
}

/**
 * Moves the ticket to `toStatus` only while it is in `from`. A status that
 * cannot be read is not `from`, so nothing moves.
 */
export async function transitionFrom(
  mcp: HostMcpRegistry,
  input: { issueKey: string; from: string; toStatus: string }
): Promise<GuardedTransition> {
  const refused = stagingRefusal(input.issueKey);
  if (refused !== undefined) return { status: "failed", message: refused };
  const tools = await connectedTools(mcp);
  if (tools === undefined) return { status: "not_connected" };
  const current = await currentStatus(mcp, tools, input.issueKey);
  if (current === "") return { status: "skipped_status" };
  if (!sameName(current, input.from)) return { status: "skipped_status", current };
  return transitionIssue(mcp, input);
}

async function currentStatus(mcp: HostMcpRegistry, tools: HostMcpToolInfo[], issueKey: string): Promise<string> {
  const getTool = tools.find((tool) => GET_ISSUE_TOOL.test(tool.name));
  if (getTool === undefined) return "";
  const read = await call(mcp, getTool, { [pickProperty(getTool, ALIASES.issue)]: issueKey, ...statusReadArgs(getTool) });
  if (!read.ok) return "";
  return issueStatusName(read.result) ?? "";
}

function transitionsFrom(result: HostMcpCallResult): Transition[] {
  for (const candidate of [result.structuredContent, tryParseJson(resultText(result))]) {
    const found = transitionList(candidate, 0);
    if (found.length > 0) return found;
  }
  return [];
}

function transitionList(value: unknown, depth: number): Transition[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const transition = asTransition(entry);
      return transition === undefined ? [] : [transition];
    });
  }
  if (!isRecord(value) || depth > 2) return [];
  for (const key of TRANSITION_WRAP_KEYS) {
    const found = transitionList(value[key], depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function asTransition(value: unknown): Transition | undefined {
  if (!isRecord(value)) return undefined;
  const rawId = value["id"];
  const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
  if (id === "") return undefined;
  const to = isRecord(value["to"]) ? stringValue(value["to"]["name"]) : "";
  return { id, name: stringValue(value["name"]), to };
}

// Connector discovery. TLSSN-51's first delivery was the release's first
// Jira call after ~80 idle minutes, when the team's Atlassian server can
// still be loading or need auth. July's account bridge
// (dist/internal/cursor/account-mcp.js) never caches a failed listing, but
// caches an empty one as a success for 60 s, and re-lists early only on an
// unknown tool name (at most every 5 s), whose error text names each
// unhealthy server. So discovery retries a throw or an empty listing after
// TRACKER_RETRY_MS, probes with an unknown name when the listing is empty
// (the probe forces the re-list and reports the server's state), and keeps
// why it gave up for `trackerUnusable`. A failed discovery on one registry
// is reused for DISCOVERY_REUSE_MS, so the several Jira calls of one
// delivery do not each wait out the retries.

export type TrackerUnusable = { reason: "not_attached" | "threw" | "empty"; attempts: number; message?: string; serverState?: string };

type Discovery = { ok: true; tools: HostMcpToolInfo[] } | { ok: false; unusable: TrackerUnusable };

/** Pauses before the second and third listing; `FACTORY_TRACKER_RETRY_MS` (comma list, at most 10 s in all; empty or `off`: none) overrides. */
export const TRACKER_RETRY_MS: readonly number[] = [2_500, 3_000];
const TRACKER_RETRY_BUDGET_MS = 10_000;
const DISCOVERY_REUSE_MS = 15_000;
/** A tool name no connector exposes. */
export const TRACKER_PROBE_TOOL = "factory-connector-probe";

const discoveries = new WeakMap<HostMcpRegistry, { at: number; result: Promise<Discovery> }>();

export function trackerRetryMs(env: NodeJS.ProcessEnv): readonly number[] {
  const raw = env.FACTORY_TRACKER_RETRY_MS?.trim();
  if (raw === undefined) return TRACKER_RETRY_MS;
  if (raw === "" || raw.toLowerCase() === "off") return [];
  const parts = raw.split(",").map((part) => part.trim());
  if (!parts.every((part) => /^\d+$/.test(part))) return TRACKER_RETRY_MS;
  const pauses = parts.map(Number);
  return pauses.reduce((sum, ms) => sum + ms, 0) <= TRACKER_RETRY_BUDGET_MS ? pauses : TRACKER_RETRY_MS;
}

/** Why the last discovery on this registry found no usable tracker, or undefined when it did (or none ran). */
export async function trackerUnusable(mcp: HostMcpRegistry): Promise<TrackerUnusable | undefined> {
  const recent = discoveries.get(mcp);
  if (recent === undefined) return undefined;
  const result = await recent.result;
  return result.ok ? undefined : result.unusable;
}

async function connectedTools(mcp: HostMcpRegistry): Promise<HostMcpToolInfo[] | undefined> {
  // Only a failed discovery is reused: a healthy one is a cheap re-list, and each call still meets the registry as it is.
  const recent = discoveries.get(mcp);
  const reusable = recent !== undefined && Date.now() - recent.at < DISCOVERY_REUSE_MS && !(await recent.result).ok;
  const result = reusable ? recent.result : discoverTracker(mcp);
  if (!reusable) discoveries.set(mcp, { at: Date.now(), result });
  const found = await result;
  return found.ok ? found.tools : undefined;
}

async function discoverTracker(mcp: HostMcpRegistry): Promise<Discovery> {
  if (!mcp.names().includes(CONNECTION_NAME)) return { ok: false, unusable: { reason: "not_attached", attempts: 0 } };
  const pauses = trackerRetryMs(process.env);
  let unusable: TrackerUnusable = { reason: "empty", attempts: 0 };
  for (let attempt = 0; attempt <= pauses.length; attempt += 1) {
    const pause = attempt === 0 ? 0 : (pauses[attempt - 1] ?? 0);
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    try {
      const tools = await mcp.listTools(CONNECTION_NAME);
      if (tools.length > 0) return { ok: true, tools };
      const serverState = await probeServerState(mcp);
      unusable = { reason: "empty", attempts: attempt + 1, ...(serverState === undefined ? {} : { serverState }) };
    } catch (error) {
      unusable = { reason: "threw", attempts: attempt + 1, message: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
    }
  }
  return { ok: false, unusable };
}

/**
 * Calls an unknown tool: the bridge re-lists past its cache and names each
 * unhealthy server (`Factory Atlassian=loading`). July 0.2.13's
 * `McpHost.callTool` turns an error reply mentioning `needsAuth` into a
 * thrown `McpNeedsAuthError` (dist/internal/mcp-host.js
 * `throwIfCallNeedsAuth`) and drops the text, so that error is the state.
 */
async function probeServerState(mcp: HostMcpRegistry): Promise<string | undefined> {
  try {
    const answer = resultText(await mcp.callTool(CONNECTION_NAME, TRACKER_PROBE_TOOL, {}));
    return /Unhealthy connectors: ([^\n]+?)\.?$/m.exec(answer)?.[1]?.slice(0, 200);
  } catch (error) {
    // Matched by name: the class is internal to July, not part of its public exports.
    if (error instanceof Error && error.name === "McpNeedsAuthError") return "needsAuth";
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
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The first alias the tool's schema declares, skipping names already used for another argument. */
export function pickProperty(tool: HostMcpToolInfo, aliases: readonly string[], taken: readonly string[] = []): string {
  const properties = tool.inputSchema?.["properties"];
  const known = new Set(isRecord(properties) ? Object.keys(properties) : []);
  const free = aliases.filter((alias) => !taken.includes(alias));
  return free.find((alias) => known.has(alias)) ?? free[0] ?? aliases[0]!;
}

export function commentBodiesFrom(result: HostMcpCallResult): string[] {
  const text = resultText(result);
  for (const candidate of [result.structuredContent, tryParseJson(text)]) {
    const fromJira = jiraCommentBodies(candidate);
    if (fromJira.length > 0) return fromJira;
  }
  const fromStructured = collectCommentBodies(result.structuredContent);
  if (fromStructured.length > 0) return fromStructured;
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
  return richTextValue(value["content"]);
}

function sameName(a: string, b: string): boolean {
  return a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
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

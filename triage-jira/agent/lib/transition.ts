import { stagingRefusalFor } from "./staging-issue.js";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { LIST_TRANSITIONS_OPERATION, executeArgs, executeReadTool, isRecord, issueStatusName, statusReadArgs, withCloudId } from "./atlassian.js";

// Moves one Jira issue to a named status over the tracker connector. Same
// discovery rules as actuate.ts: tools by name shape, argument names from the
// tool's own schema. The status a ticket enters is the event the next stage
// wakes on, so this is the hop, not a nicety.

const CONNECTION_NAME = "tracker";

// `getTransitionsForJiraIssue` (Atlassian v1), `listJiraIssueTransitions`
// (v2, usually through executeRead), and `get_transitions`.
const LIST_TRANSITIONS_TOOL = /(?:^|-)(?:get|list)(?:[_-]?jira)?(?:[_-]?issue)?[_-]?transitions?(?:[_-]?for[_-]?(?:jira[_-]?)?issue)?$/i;
// `transitionJiraIssue` and `transition_issue`.
const TRANSITION_TOOL = /(?:^|-)(?:do[_-]?|perform[_-]?)?transition(?:[_-]?jira)?(?:[_-]?issue)?$/i;
const GET_ISSUE_TOOL = /(?:^|-)(?:get|read|fetch|view|show)(?:[_-]?jira)?[_-]?issue$/i;

const ALIASES = {
  issue: ["issueKey", "issue_key", "issueIdOrKey", "issueId", "issue_id", "key", "identifier", "id"],
  transition: ["transitionId", "transition_id", "transition", "id"],
  statusName: ["transitionName", "status", "toStatus", "name"],
} as const;

const TRANSITION_WRAP_KEYS = ["transitions", "items", "data"] as const;

export type TransitionOutcome =
  | { status: "transitioned" }
  | { status: "already" }
  | { status: "no_transition"; available: string[] }
  | { status: "not_connected" }
  | { status: "failed"; message: string };

type Transition = { id: string; name: string; to: string };

export async function transitionIssue(
  mcp: HostMcpRegistry,
  input: { issueKey: string; toStatus: string }
): Promise<TransitionOutcome> {
  const { issueKey, toStatus } = input;
  const refused = stagingRefusalFor(issueKey);
  if (refused !== undefined) return { status: "failed", message: refused };
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
  if (stagingRefusalFor(issueKey) !== undefined) return undefined;
  if (!mcp.names().includes(CONNECTION_NAME)) return undefined;
  try {
    return await statusOf(mcp, await mcp.listTools(CONNECTION_NAME), issueKey);
  } catch {
    return undefined;
  }
}

/**
 * Moves the issue to `toStatus` only while it is in `from`. A status that
 * cannot be read is not `from`, so nothing moves.
 */
export async function transitionFrom(
  mcp: HostMcpRegistry,
  input: { issueKey: string; from: string; toStatus: string }
): Promise<GuardedTransition> {
  const refused = stagingRefusalFor(input.issueKey);
  if (refused !== undefined) return { status: "failed", message: refused };
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

function pickProperty(tool: HostMcpToolInfo, aliases: readonly string[], taken?: string): string {
  const properties = tool.inputSchema?.["properties"];
  const known = new Set(isRecord(properties) ? Object.keys(properties) : []);
  const free = aliases.filter((alias) => alias !== taken);
  return free.find((alias) => known.has(alias)) ?? free[0]!;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
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

import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { executeArgs, executeReadTool, isRecord, withCloudId } from "./atlassian.js";
import { factoryStage, refusesProductionTarget } from "./factory-stage.js";
import { issueTypesCacheKey, type KeyedKv } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

// The project's Jira issue types, read through the tracker connection, and
// the one edit that sets a ticket's type. Rovo v1 lists
// getJiraProjectIssueTypesMetadata as a tool; v2 runs it through executeRead.

export const ISSUE_TYPES_OPERATION = "getJiraProjectIssueTypesMetadata";
const CONNECTION_NAME = "tracker";
const LIST_TYPES_TOOL = /issue[_-]?types?(?:[_-]?metadata)?$/i;
const EDIT_ISSUE_TOOL = /(?:^|-)edit(?:[_-]?jira)?[_-]?issue$/i;
const CACHE_MS = 6 * 60 * 60 * 1000;

/** A Jira issue type as the project lists it. `id` is absent only for the offline defaults. */
export type IssueTypeRef = { name: string; id?: string };

export type IssueTypeWrite =
  | { status: "set" }
  | { status: "already" }
  | { status: "not_connected" }
  | { status: "failed"; message: string };

export function projectOf(issueKey: string): string {
  const dash = issueKey.indexOf("-");
  return dash === -1 ? issueKey : issueKey.slice(0, dash);
}

const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d+$/;

/**
 * On a staging slug, the production project is neither read nor edited here,
 * and neither is anything that is not a well-formed project or issue key (a
 * numeric issue id names no project, so it cannot be checked). Each host's
 * own allowlist runs before this (factory-stage.ts).
 */
function stagingRefuses(target: { project: string; shape: RegExp; value: string }): boolean {
  if (factoryStage(process.env) === "production") return false;
  return !target.shape.test(target.value) || refusesProductionTarget(process.env, { kind: "jiraProjects", value: target.project });
}

/**
 * The project's standard issue types (no sub-tasks, no Epic level), from a
 * kv cache or the tracker. `undefined` when the tracker cannot list them.
 */
export async function projectIssueTypes(mcp: HostMcpRegistry, kv: KeyedKv, project: string, now: () => number = Date.now): Promise<IssueTypeRef[] | undefined> {
  if (stagingRefuses({ project, shape: PROJECT_KEY, value: project })) return undefined;
  const cached = await readCache(kv, project, now());
  if (cached !== undefined) return cached;
  if (!mcp.names().includes(CONNECTION_NAME)) return undefined;
  let tools: HostMcpToolInfo[];
  try {
    tools = await mcp.listTools(CONNECTION_NAME);
  } catch {
    return undefined;
  }
  const direct = tools.find((tool) => LIST_TYPES_TOOL.test(tool.name));
  const execute = direct === undefined ? executeReadTool(tools) : undefined;
  const tool = direct ?? execute;
  if (tool === undefined) return undefined;
  const args = direct !== undefined ? { projectIdOrKey: project } : executeArgs(ISSUE_TYPES_OPERATION, { projectIdOrKey: project });
  let reply: HostMcpCallResult;
  try {
    reply = await mcp.callTool(CONNECTION_NAME, tool.name, withCloudId(tool, args));
  } catch {
    return undefined;
  }
  if (reply.isError === true) return undefined;
  const types = standardTypes(reply);
  if (types.length === 0) return undefined;
  try {
    await kv.put(issueTypesCacheKey(project), { exp: now() + CACHE_MS, types });
  } catch (error) {
    warnKv("issue-type.projectIssueTypes", error);
    // An uncached list is read again on the next ticket.
  }
  return types;
}

/** Sets `fields.issuetype` on the ticket, by id when the project gave one. */
export async function setIssueType(mcp: HostMcpRegistry, issueKey: string, type: IssueTypeRef): Promise<IssueTypeWrite> {
  if (stagingRefuses({ project: projectOf(issueKey), shape: ISSUE_KEY, value: issueKey })) return { status: "failed", message: `staging_refuses_production: FACTORY_ENV is staging, so ${issueKey}'s type was not changed.` };
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected" };
  let tools: HostMcpToolInfo[];
  try {
    tools = await mcp.listTools(CONNECTION_NAME);
  } catch (error) {
    return { status: "failed", message: errorText(error) };
  }
  const tool = tools.find((candidate) => EDIT_ISSUE_TOOL.test(candidate.name));
  if (tool === undefined) return { status: "failed", message: "the tracker connector exposes no edit-issue tool" };
  const issuetype = type.id === undefined ? { name: type.name } : { id: type.id };
  try {
    const reply = await mcp.callTool(CONNECTION_NAME, tool.name, withCloudId(tool, { issueIdOrKey: issueKey, fields: { issuetype } }));
    if (reply.isError === true) return { status: "failed", message: replyText(reply).slice(0, 240) || "the edit was refused" };
    return { status: "set" };
  } catch (error) {
    return { status: "failed", message: errorText(error) };
  }
}

export function sameTypeName(a: string | undefined, b: string): boolean {
  return a !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function standardTypes(reply: HostMcpCallResult): IssueTypeRef[] {
  for (const candidate of [reply.structuredContent, parseJson(replyText(reply))]) {
    const found = collectTypes(candidate);
    if (found.length > 0) return dedupe(found);
  }
  return [];
}

// createmeta returns `issueTypes` or `values`; project metadata may nest them
// under `projects[]`. Entries carry `name`, `id`, `subtask`, `hierarchyLevel`.
function collectTypes(value: unknown, found: IssueTypeRef[] = []): IssueTypeRef[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectTypes(entry, found);
    return found;
  }
  if (!isRecord(value)) return found;
  const name = typeof value["name"] === "string" ? value["name"].trim() : "";
  const looksLikeType = name !== "" && ("subtask" in value || "hierarchyLevel" in value || "iconUrl" in value);
  if (looksLikeType) {
    const subtask = value["subtask"] === true;
    const level = typeof value["hierarchyLevel"] === "number" ? value["hierarchyLevel"] : 0;
    if (!subtask && level === 0) {
      const id = typeof value["id"] === "string" || typeof value["id"] === "number" ? String(value["id"]) : undefined;
      found.push({ name, ...(id === undefined ? {} : { id }) });
    }
    return found;
  }
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) collectTypes(nested, found);
  }
  return found;
}

function dedupe(types: IssueTypeRef[]): IssueTypeRef[] {
  const seen = new Set<string>();
  return types.filter((type) => {
    const key = type.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readCache(kv: KeyedKv, project: string, now: number): Promise<IssueTypeRef[] | undefined> {
  let value: unknown;
  try {
    value = await kv.get(issueTypesCacheKey(project));
  } catch (error) {
    warnKv("issue-type.readCache.get", error);
    return undefined;
  }
  if (!isRecord(value) || typeof value["exp"] !== "number" || !Array.isArray(value["types"])) return undefined;
  if (value["exp"] <= now) {
    try {
      await kv.delete(issueTypesCacheKey(project));
    } catch (error) {
      warnKv("issue-type.readCache.delete", error);
      // Expired either way.
    }
    return undefined;
  }
  const types = value["types"].filter((entry): entry is IssueTypeRef => isRecord(entry) && typeof entry["name"] === "string");
  return types.length === 0 ? undefined : types;
}

function replyText(reply: HostMcpCallResult): string {
  return reply.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

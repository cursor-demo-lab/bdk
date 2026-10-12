import { stagingRefusalFor } from "./staging-issue.js";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { adfText, isRecord, issueReadArgs, issueStatusName, jiraCommentBodies, withCloudId } from "./atlassian.js";
import { pastTodoStatuses, statusNames } from "./config.js";
import { deskTriaged, isDeskTriageComment } from "./desk-triaged.js";

// The second look before triage-jira triages a ticket whose delivered
// description did not carry the desk's line: the ticket as Jira has it now.
// Automation's plainText rendering can mangle or drop that line, but the
// connector reads the stored description, and by then the desk may already
// have written its Triage: comment or moved the ticket on. Any read failure,
// or a read slower than TRACKER_READ_TIMEOUT_MS, answers `unread`, so an
// ordinary ticket is still triaged. A status past To Do counts only for a
// ticket that was created in To Do (or whose delivered status is unknown):
// one a person created straight into a later status is triaged as before.

export const TRACKER_READ_TIMEOUT_MS = 8_000;

const CONNECTION_NAME = "tracker";
const GET_ISSUE_TOOL = /(?:^|-)(?:get|read|fetch|view|show)(?:[_-]?jira)?[_-]?issue$/i;
const ISSUE_ARGS = ["issueIdOrKey", "issueKey", "issue_key", "issueId", "issue_id", "key", "identifier", "id"] as const;

export type TrackerLook =
  | { skip: true; why: "description" | "desk_triage_comment" | "past_todo"; status?: string }
  | { skip: false; read: "read"; status?: string }
  | { skip: false; read: "unread"; detail: string };

export async function deskFiledOnTracker(
  mcp: HostMcpRegistry,
  issueKey: string,
  options: { env: NodeJS.ProcessEnv; deliveredStatus?: string; timeoutMs?: number }
): Promise<TrackerLook> {
  const refused = stagingRefusalFor(issueKey, options.env);
  if (refused !== undefined) return { skip: false, read: "unread", detail: refused };
  if (!mcp.names().includes(CONNECTION_NAME)) return { skip: false, read: "unread", detail: "not_connected" };
  const timeoutMs = options.timeoutMs ?? TRACKER_READ_TIMEOUT_MS;
  let reply: HostMcpCallResult | "timeout";
  try {
    reply = await within(timeoutMs, async () => {
      const tools = await mcp.listTools(CONNECTION_NAME);
      const tool = tools.find((candidate) => GET_ISSUE_TOOL.test(candidate.name));
      if (tool === undefined) throw new Error("no issue read tool");
      return mcp.callTool(CONNECTION_NAME, tool.name, withCloudId(tool, { [issueArg(tool)]: issueKey, ...issueReadArgs(tool) }));
    });
  } catch (error) {
    return { skip: false, read: "unread", detail: error instanceof Error ? error.message : String(error) };
  }
  if (reply === "timeout") return { skip: false, read: "unread", detail: `no answer within ${timeoutMs} ms` };
  if (reply.isError === true) return { skip: false, read: "unread", detail: "the issue read failed" };
  const issue = issueRecord(reply, issueKey);
  const status = issueStatusName(reply);
  const known = status === undefined ? {} : { status };
  const fields = issue !== undefined && isRecord(issue["fields"]) ? issue["fields"] : undefined;
  const rendered = issue !== undefined && isRecord(issue["renderedFields"]) ? issue["renderedFields"]["description"] : undefined;
  if ([fields?.["description"], rendered].some((value) => !endsInCodeBlock(value) && deskTriaged(adfText(value)))) return { skip: true, why: "description", ...known };
  if (issue !== undefined && jiraCommentBodies(issue).some(isDeskTriageComment)) return { skip: true, why: "desk_triage_comment", ...known };
  const createdInTodo = options.deliveredStatus === undefined || same(options.deliveredStatus, statusNames(options.env).todo);
  if (createdInTodo && status !== undefined && pastTodoStatuses(options.env).some((name) => same(name, status))) return { skip: true, why: "past_todo", status };
  return { skip: false, read: "read", ...known };
}

function issueArg(tool: HostMcpToolInfo): string {
  const properties = tool.inputSchema?.["properties"];
  const known = isRecord(properties) ? properties : {};
  return ISSUE_ARGS.find((name) => known[name] !== undefined) ?? ISSUE_ARGS[0];
}

// Rovo hands the REST issue back as text and an `issues.nodes` envelope as
// structuredContent, so either may hold it.
function issueRecord(reply: HostMcpCallResult, issueKey: string): Record<string, unknown> | undefined {
  const text = reply.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n").trim();
  for (const candidate of [reply.structuredContent, parseJson(text)]) {
    const found = findIssue(candidate, issueKey, 0);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findIssue(value: unknown, issueKey: string, depth: number): Record<string, unknown> | undefined {
  if (depth > 5) return undefined;
  if (Array.isArray(value)) {
    const found = value.map((entry) => findIssue(entry, issueKey, depth + 1)).filter((entry) => entry !== undefined);
    return found.find((entry) => entry["key"] === issueKey) ?? found[0];
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value["fields"]) && (value["key"] === undefined || value["key"] === issueKey)) return value;
  for (const nested of Object.values(value)) {
    const found = findIssue(nested, issueKey, depth + 1);
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

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function within<T>(ms: number, work: () => Promise<T>): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([work(), late]);
  } finally {
    clearTimeout(timer);
  }
}

// ADF text drops a code block's fences, so a ticket whose last block quotes
// the desk's line in code would read as the desk's; the desk never ends a
// description with code.
function endsInCodeBlock(value: unknown): boolean {
  const content = isRecord(value) && Array.isArray(value["content"]) ? value["content"] : undefined;
  const last = content?.at(-1);
  return isRecord(last) && last["type"] === "codeBlock";
}

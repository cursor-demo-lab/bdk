import type { HostMcpCallResult, HostMcpToolInfo } from "@cursor/july";

// Conventions of the Atlassian Rovo MCP server (https://mcp.atlassian.com/v2/mcp).
// Every tool takes a cloudId, and the site URL is accepted as one. v2 lists
// only its primary tools (getJiraIssue, createJiraIssue, editJiraIssue,
// transitionJiraIssue, addOrEditJiraIssueComment, searchJiraIssuesUsingJql);
// catalog operations such as listJiraIssueTransitions and
// listJiraIssueComments run through executeRead, with cloudId beside the
// operation name and the operation's own inputs flat. The same file is in
// every project that talks to Jira.

export const CLOUD_ID_ENV = "JIRA_CLOUD_ID";
export const DEFAULT_CLOUD_ID = "https://<JIRA_SITE>.atlassian.net";

export const LIST_TRANSITIONS_OPERATION = "listJiraIssueTransitions";
export const LIST_COMMENTS_OPERATION = "listJiraIssueComments";

const CLOUD_ID_KEYS = ["cloudId", "cloud_id"] as const;
const EXECUTE_READ_TOOL = /(?:^|-)execute(?:[_-]?read)?$/i;
const ISSUE_READ_FIELDS = ["summary", "status", "comment", "description", "project"];
const STATUS_WRAP_KEYS = ["issue", "issues", "nodes", "data", "result", "content"] as const;
const ADF_INLINE = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status"]);
const ADF_CARD = new Set(["inlineCard", "blockCard", "embedCard"]);

export function jiraCloudId(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[CLOUD_ID_ENV]?.trim();
  return value === undefined || value === "" ? DEFAULT_CLOUD_ID : value;
}

/** `args` plus the cloudId, under the name the tool's schema declares; unchanged when it declares none. */
export function withCloudId(
  tool: HostMcpToolInfo,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const key = CLOUD_ID_KEYS.find((candidate) => properties[candidate] !== undefined);
  if (key === undefined || args[key] !== undefined) return args;
  return { ...args, [key]: jiraCloudId(env) };
}

/** The first tool matching `pattern`, preferring v2's `addOrEdit...` over the v1 name it replaced. */
export function findTool(tools: readonly HostMcpToolInfo[], pattern: RegExp): HostMcpToolInfo | undefined {
  const matching = tools.filter((tool) => pattern.test(tool.name));
  return matching.find((tool) => /or[_-]?edit/i.test(tool.name)) ?? matching[0];
}

/** The meta-tool that runs a read-only catalog operation by name. `executeRead` wins over a single `execute`. */
export function executeReadTool(tools: readonly HostMcpToolInfo[]): HostMcpToolInfo | undefined {
  const matching = tools.filter((tool) => EXECUTE_READ_TOOL.test(tool.name));
  return matching.find((tool) => /read/i.test(tool.name)) ?? matching[0];
}

export function executeArgs(operation: string, inputs: Record<string, unknown>): Record<string, unknown> {
  return { name: operation, inputs };
}

/**
 * Extra arguments that make a get-issue tool return comments with the
 * status and description, shaped to the schema's `fields` or `expand` type.
 */
export function issueReadArgs(tool: HostMcpToolInfo): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const fields = properties["fields"];
  if (fields !== undefined) return { fields: isArraySchema(fields) ? [...ISSUE_READ_FIELDS] : ISSUE_READ_FIELDS.join(",") };
  const expand = properties["expand"];
  if (expand !== undefined) return { expand: isArraySchema(expand) ? ["renderedFields"] : "renderedFields" };
  return {};
}

/** `fields` asking a get-issue tool for the status alone, shaped to the schema. A full read also pulls every comment. */
export function statusReadArgs(tool: HostMcpToolInfo): Record<string, unknown> {
  const fields = schemaProperties(tool)["fields"];
  if (fields === undefined) return {};
  return { fields: isArraySchema(fields) ? ["status"] : "status" };
}

/**
 * The Jira status name in a get-issue reply, from structuredContent and then
 * from the text as JSON. Rovo gives Cursor an `issues.nodes` envelope as
 * structuredContent and the REST issue as text, so neither channel alone is
 * reliably the Jira shape. Only `fields.status` or a `status` object's name
 * counts: a top-level string `status` is a reply envelope (`ok`, `success`).
 */
export function issueStatusName(reply: HostMcpCallResult): string | undefined {
  const text = reply.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
  return statusNameIn(reply.structuredContent) ?? statusNameIn(parseJson(text));
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Comment bodies from a Jira issue (`fields.comment.comments[].body`), a
 * comment page (`comments[].body`), or a search page (`issues[]`). Bodies in
 * the Atlassian document format are flattened to text.
 */
export function jiraCommentBodies(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jiraCommentBodies);
  if (!isRecord(value)) return [];
  const fields = isRecord(value["fields"]) ? value["fields"] : undefined;
  const page = fields !== undefined && isRecord(fields["comment"]) ? fields["comment"] : value;
  const comments = page["comments"];
  if (Array.isArray(comments)) {
    return comments.flatMap((comment) => {
      const body = adfText(isRecord(comment) ? comment["body"] : comment);
      return body.trim() === "" ? [] : [body];
    });
  }
  if (Array.isArray(value["issues"])) return value["issues"].flatMap(jiraCommentBodies);
  return [];
}

/** Atlassian document format as plain text: inline nodes run together, blocks one per line. */
export function adfText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfText).join("\n");
  if (!isRecord(node)) return "";
  if (typeof node["text"] === "string") return node["text"];
  if (node["type"] === "hardBreak") return "\n";
  if (ADF_CARD.has(String(node["type"])) && isRecord(node["attrs"]) && typeof node["attrs"]["url"] === "string") {
    return node["attrs"]["url"];
  }
  const children = Array.isArray(node["content"]) ? node["content"] : [];
  const inline = children.every((child) => isRecord(child) && ADF_INLINE.has(String(child["type"])));
  return children.map(adfText).join(inline ? "" : "\n");
}

function schemaProperties(tool: HostMcpToolInfo): Record<string, unknown> {
  const properties = tool.inputSchema?.["properties"];
  return isRecord(properties) ? properties : {};
}

function isArraySchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const type = schema["type"];
  return type === "array" || (Array.isArray(type) && type.includes("array"));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

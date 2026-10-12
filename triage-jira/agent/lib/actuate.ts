import { stagingRefusalFor } from "./staging-issue.js";
import type {
  HostMcpCallResult,
  HostMcpRegistry,
  HostMcpToolInfo,
} from "@cursor/july";
import {
  ISSUE_ID,
  JIRA_URL,
  LINEAR_URL,
  pinIssueIdentifier,
  richTextValue,
} from "./parse-queue-event.js";
import {
  LIST_COMMENTS_OPERATION,
  executeArgs,
  executeReadTool,
  findTool,
  isRecord,
  issueReadArgs,
  jiraCommentBodies,
  withCloudId,
} from "./atlassian.js";
import { triageComment } from "./triage-verdict.js";
import type {
  QueueAction,
  RecordTriageResult,
  TrackerConfig,
  TrackerIssue,
  TrackerResult,
  TriageSeverity,
  TriageVerdict,
} from "./types.js";

const CONNECTION_NAME = "tracker";

// Linear's `list_issues` / `create_comment` / `list_comments` and Atlassian's
// `searchJiraIssuesUsingJql` / `addOrEditJiraIssueComment` (v2) or
// `addCommentToJiraIssue` (v1) / `listJiraIssueComments`.
const GET_ISSUE_TOOL = /(?:^|-)(?:get|read|fetch|view|show)(?:[_-]?jira)?[_-]?issue$/i;
const SEARCH_ISSUE_TOOL = /(?:search|list|find)(?:[_-]?jira)?[_-]?issues?(?:[_-]?(?:using|with|by)[_-]?jql)?$/i;
const COMMENT_TOOL =
  /(?:add|create|save|post)(?:[_-]?or[_-]?(?:edit|update))?(?:[_-]?jira)?(?:[_-]?issue)?[_-]?comment(?:[_-]?to[_-]?(?:jira[_-]?)?issue)?$/i;
const LIST_COMMENT_TOOL = /(?:list|get|read)(?:[_-]?jira)?(?:[_-]?issue)?[_-]?comments?$/i;
// Characters JQL's text search (`~`) reserves; a title is matched exactly afterwards.
const JQL_TEXT_RESERVED = /[+\-&|!(){}[\]^~*?\\:"'/]/g;
const SAVE_OR_UPDATE_ISSUE_TOOL = /(?:save|update)[_-]?issue$/i;
const UPDATE_ISSUE_TOOL = /update[_-]?issue$/i;

const FIELD_ALIASES = {
  title: ["title", "name", "issueTitle", "summary"],
  query: ["query", "q", "search", "term", "jql", "text"],
  comment: ["comment", "body", "text", "message"],
  // Atlassian's comment tools take `commentBody`; reads never carry that key.
  commentArg: ["commentBody", "comment", "body", "text", "message"],
  issue: ["id", "issueId", "issue_id", "issueKey", "issue_key", "identifier"],
  commentIssue: [
    "issueId",
    "issue_id",
    "issueIdOrKey",
    "issueKey",
    "issue_key",
    "identifier",
  ],
  priority: ["priority", "priorityId", "priority_id"],
} as const;

const PRIORITY_BY_SEVERITY: Record<TriageSeverity, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

export interface ActuateInput {
  verdict: TriageVerdict;
  mcp: HostMcpRegistry;
  tracker: TrackerConfig;
  purpose?: "live" | "eval";
  now?: () => string;
  issueKey?: string | null;
  /**
   * Host-trusted inbound title. Live `record_triage` omits this and looks
   * up the pinned issue. `session.title` is the harness display title and
   * is overwritten by the turn summary.
   */
  issueTitle?: string | null;
  /** The host judge's `Judge:` line (jev-triage.ts `judgeLine`), appended to a new Triage: comment. */
  judgeLine?: string;
  /** The ticket's Jira issue type after triage, for the comment's `Type:` line. */
  issueType?: string;
}

export async function actuate(input: ActuateInput): Promise<RecordTriageResult> {
  const evaluatedAt = (input.now ?? (() => new Date().toISOString()))();
  const verdict: TriageVerdict = {
    ...input.verdict,
    identifier: pinIssueIdentifier(input.issueKey, input.verdict.identifier),
  };
  const tracker = await resolveTracker({ ...input, verdict });
  return { verdict, evaluatedAt, tracker };
}

async function resolveTracker(input: ActuateInput): Promise<TrackerResult> {
  if (input.purpose === "eval") {
    return { status: "skipped", reason: "eval" };
  }
  if (stagingRefusalFor(input.verdict.identifier) !== undefined) {
    return { status: "skipped", reason: "staging_refuses_production" };
  }
  if (input.tracker.kind === "none") {
    return { status: "not_connected" };
  }

  const connectionName = input.tracker.connectionName || CONNECTION_NAME;
  if (!input.mcp.names().includes(connectionName)) {
    return { status: "not_connected" };
  }

  let tools: HostMcpToolInfo[];
  try {
    tools = await input.mcp.listTools(connectionName);
  } catch (error) {
    return { status: "failed", message: errorText(error) };
  }
  if (tools.length === 0) {
    return { status: "not_connected" };
  }

  const issue: TrackerIssue = {
    identifier: input.verdict.identifier,
    url: "",
  };
  const searchTool = tools.find((tool) => SEARCH_ISSUE_TOOL.test(tool.name));
  let search: SearchResult = {
    candidates: [],
  };
  if (searchTool !== undefined) {
    const hostTitle = await resolveHostTitle({
      mcp: input.mcp,
      connectionName,
      tool: searchTool,
      identifier: issue.identifier,
      issueTitle: input.issueTitle,
    });
    if (hostTitle !== "") {
      search = await searchExisting({
        mcp: input.mcp,
        connectionName,
        tool: searchTool,
        query: hostTitle,
        matchTitle: hostTitle,
        excludeIdentifier: issue.identifier,
      });
    }
  }

  const duplicate = search.duplicate;
  const commentTool = findTool(tools, COMMENT_TOOL);
  if (commentTool === undefined) {
    return {
      status: "failed",
      message: "the tracker connector exposes no comment tool",
    };
  }

  const listed = await loadComments({
    mcp: input.mcp,
    connectionName,
    tools,
    identifier: issue.identifier,
  });

  // Without the comment list a redelivery cannot tell whether triage already
  // commented, so writing now could double-post. Fail and let the next delivery retry.
  if (listed.status === "failed") {
    return { status: "failed", message: "could not read the ticket's comments; retry the delivery" };
  }
  const actions: QueueAction[] = [];
  {
    // A redelivered webhook finds its own comment. The action says so, and
    // the planner handoff keys on a comment that was written this call.
    if (alreadyCommented(listed, search.candidates, issue.identifier, "Triage:")) {
      actions.push({ op: "already_commented" });
    } else {
      const comment = await commentOn({
        mcp: input.mcp,
        connectionName,
        tool: commentTool,
        issue,
        body: triageComment(input.verdict, duplicate, input.judgeLine, input.issueType),
      });
      if (!comment.ok) {
        return { status: "failed", message: comment.message };
      }
      actions.push({ op: "commented" });
    }
  }
  if (input.verdict.needsInfo === true) {
    actions.push({ op: "needs_info" });
  }

  if (duplicate !== undefined) {
    const duplicateComment = `Triage: duplicate inbound ${issue.identifier}`;
    const duplicateListed = await loadComments({
      mcp: input.mcp,
      connectionName,
      tools,
      identifier: duplicate.identifier,
    });
    if (duplicateListed.status !== "failed") {
      if (
        !alreadyCommented(
          duplicateListed,
          search.candidates,
          duplicate.identifier,
          duplicateComment
        )
      ) {
        const comment = await commentOn({
          mcp: input.mcp,
          connectionName,
          tool: commentTool,
          issue: duplicate,
          body: duplicateComment,
        });
        if (!comment.ok) {
          return { status: "failed", message: comment.message };
        }
      }
      actions.push({ op: "duplicate_of", of: duplicate.identifier });
    }
  }

  if (input.verdict.kind === "bug") {
    let updateTool: HostMcpToolInfo | undefined;
    let updateArgs: Record<string, unknown> | undefined;
    for (const tool of tools) {
      if (!SAVE_OR_UPDATE_ISSUE_TOOL.test(tool.name)) {
        continue;
      }
      const args = buildPriorityArgs(
        input.verdict,
        tool,
        input.tracker.kind
      );
      if (args !== undefined) {
        updateTool = tool;
        updateArgs = args;
        break;
      }
    }
    if (updateTool !== undefined && updateArgs !== undefined) {
      const update = await callTool({
        mcp: input.mcp,
        connectionName,
        tool: updateTool.name,
        args: withCloudId(updateTool, updateArgs),
      });
      if (!update.ok) {
        return { status: "failed", message: update.message };
      }
      actions.push({
        op: "prioritized",
        severity: input.verdict.severity,
      });
    }
  }

  return { status: "acted", issue, actions };
}

export type IssueComment = { status: "commented" } | { status: "not_connected" } | { status: "failed"; message: string };

/** One comment on an existing issue outside a verdict, with the same tool discovery the verdict uses. */
export async function commentOnIssue(mcp: HostMcpRegistry, input: { issueKey: string; body: string }): Promise<IssueComment> {
  const refused = stagingRefusalFor(input.issueKey);
  if (refused !== undefined) return { status: "failed", message: refused };
  if (!mcp.names().includes(CONNECTION_NAME)) return { status: "not_connected" };
  let tools: HostMcpToolInfo[];
  try {
    tools = await mcp.listTools(CONNECTION_NAME);
  } catch (error) {
    return { status: "failed", message: errorText(error) };
  }
  if (tools.length === 0) return { status: "not_connected" };
  const tool = findTool(tools, COMMENT_TOOL);
  if (tool === undefined) return { status: "failed", message: "the tracker connector exposes no comment tool" };
  const written = await commentOn({ mcp, connectionName: CONNECTION_NAME, tool, issue: { identifier: input.issueKey, url: "" }, body: input.body });
  return written.ok ? { status: "commented" } : { status: "failed", message: written.message };
}

type SearchResult = {
  candidates: CandidateIssue[];
  duplicate?: TrackerIssue;
};

async function resolveHostTitle(input: {
  mcp: HostMcpRegistry;
  connectionName: string;
  tool: HostMcpToolInfo;
  identifier: string;
  issueTitle?: string | null;
}): Promise<string> {
  if (typeof input.issueTitle === "string") {
    const title = input.issueTitle.trim();
    if (title !== "") {
      return title;
    }
  }
  const listed = await searchIssues({
    mcp: input.mcp,
    connectionName: input.connectionName,
    tool: input.tool,
    query: input.identifier,
    jql: `key = ${input.identifier}`,
  });
  const self = listed.find(
    (candidate) => issueIdentifier(candidate) === input.identifier
  );
  return self?.title.trim() ?? "";
}

async function searchExisting(input: {
  mcp: HostMcpRegistry;
  connectionName: string;
  tool: HostMcpToolInfo;
  query: string;
  matchTitle: string;
  excludeIdentifier: string;
}): Promise<SearchResult> {
  const found = await searchIssues({
    mcp: input.mcp,
    connectionName: input.connectionName,
    tool: input.tool,
    query: input.query,
    jql: titleJql({ title: input.query, inProjectOf: input.excludeIdentifier }),
  });
  // The duplicate gets a comment of its own, so on staging a match outside the
  // slug's projects (a query search is not limited to one project) is no
  // candidate at all: nothing is written to it or claimed from it.
  const candidates = found.filter((candidate) => stagingRefusalFor(candidate.identifier) === undefined);
  return {
    candidates,
    duplicate: matchingIssue(
      candidates,
      input.matchTitle,
      input.excludeIdentifier
    ),
  };
}

async function searchIssues(input: {
  mcp: HostMcpRegistry;
  connectionName: string;
  tool: HostMcpToolInfo;
  query: string;
  jql: string;
}): Promise<CandidateIssue[]> {
  try {
    const result = await input.mcp.callTool(
      input.connectionName,
      input.tool.name,
      withCloudId(input.tool, buildSearchArgs(input, input.tool))
    );
    if (result.isError === true) {
      return [];
    }
    return issuesFromSearch(result);
  } catch {
    return [];
  }
}

type ListedComments =
  | { status: "listed"; bodies: string[] }
  | { status: "unavailable" }
  | { status: "failed" };

async function loadComments(input: {
  mcp: HostMcpRegistry;
  connectionName: string;
  tools: HostMcpToolInfo[];
  identifier: string;
}): Promise<ListedComments> {
  const listTool = input.tools.find((candidate) =>
    LIST_COMMENT_TOOL.test(candidate.name)
  );
  const tool = listTool ?? executeReadTool(input.tools);
  const primary = tool === undefined ? { status: "unavailable" as const } : await listWith({ ...input, tool, listTool });
  if (primary.status === "listed") return primary;
  const issueTool = input.tools.find((candidate) => GET_ISSUE_TOOL.test(candidate.name));
  if (issueTool === undefined) return primary;
  return await listWith({ ...input, tool: issueTool, listTool: undefined, readIssue: true });
}

async function listWith(input: {
  mcp: HostMcpRegistry;
  connectionName: string;
  tool: HostMcpToolInfo;
  listTool: HostMcpToolInfo | undefined;
  identifier: string;
  readIssue?: boolean;
}): Promise<ListedComments> {
  const { tool, listTool } = input;
  const args =
    input.readIssue === true
      ? { [pickProperty(tool, FIELD_ALIASES.commentIssue)]: input.identifier, ...issueReadArgs(tool) }
      : tool === listTool
        ? { [pickProperty(tool, FIELD_ALIASES.commentIssue)]: input.identifier }
        : executeArgs(LIST_COMMENTS_OPERATION, { issueIdOrKey: input.identifier });
  try {
    const result = await input.mcp.callTool(
      input.connectionName,
      tool.name,
      withCloudId(tool, args)
    );
    if (result.isError === true) {
      return { status: "failed" };
    }
    return { status: "listed", bodies: commentBodiesFrom(result) };
  } catch {
    return { status: "failed" };
  }
}

function commentBodiesFrom(result: HostMcpCallResult): string[] {
  for (const candidate of [result.structuredContent, tryParseJson(resultText(result))]) {
    const fromJira = jiraCommentBodies(candidate);
    if (fromJira.length > 0) {
      return fromJira;
    }
  }
  const fromStructured = collectCommentBodies(result.structuredContent);
  if (fromStructured.length > 0) {
    return fromStructured;
  }
  const text = resultText(result);
  const fromJson = collectCommentBodies(tryParseJson(text));
  if (fromJson.length > 0) {
    return fromJson;
  }
  return text === "" ? [] : [text];
}

function alreadyCommented(
  listed: ListedComments,
  candidates: CandidateIssue[],
  identifier: string,
  prefix: string
): boolean {
  if (listed.status === "listed" && listed.bodies.some((comment) => hasSentinel(comment, prefix))) {
    return true;
  }
  return hasCommentStarting(candidates, identifier, prefix);
}

async function commentOn(input: {
  mcp: HostMcpRegistry;
  connectionName: string;
  tool: HostMcpToolInfo;
  issue: TrackerIssue;
  body: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await callTool({
    mcp: input.mcp,
    connectionName: input.connectionName,
    tool: input.tool.name,
    args: withCloudId(input.tool, buildCommentArgs(input.issue, input.body, input.tool)),
  });
  if (!result.ok) {
    return {
      ok: false,
      message: `could not comment on ${input.issue.identifier}: ${result.message}`,
    };
  }
  return result;
}

async function callTool(input: {
  mcp: HostMcpRegistry;
  connectionName: string;
  tool: string;
  args: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const result = await input.mcp.callTool(
      input.connectionName,
      input.tool,
      input.args
    );
    if (result.isError === true) {
      return { ok: false, message: resultText(result) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
}

/** Free text for a query tool; JQL, and the fields that carry title and comments, for a JQL tool. */
function buildSearchArgs(
  search: { query: string; jql: string },
  tool: HostMcpToolInfo
): Record<string, unknown> {
  const property = pickProperty(tool, FIELD_ALIASES.query);
  if (property !== "jql") {
    return { [property]: search.query };
  }
  return { jql: search.jql, ...issueReadArgs(tool) };
}

function titleJql({ title, inProjectOf }: { title: string; inProjectOf: string }): string {
  const text = title.replace(JQL_TEXT_RESERVED, " ").replace(/\s+/g, " ").trim();
  const project = inProjectOf.includes("-") ? inProjectOf.slice(0, inProjectOf.indexOf("-")) : "";
  const clause = `summary ~ "${text}"`;
  return project === "" ? clause : `project = ${project} AND ${clause}`;
}

function buildCommentArgs(
  issue: TrackerIssue,
  body: string,
  tool: HostMcpToolInfo
): Record<string, unknown> {
  return {
    [pickProperty(tool, FIELD_ALIASES.commentIssue)]: issue.identifier,
    [pickProperty(tool, FIELD_ALIASES.commentArg)]: body,
  };
}

function buildPriorityArgs(
  verdict: TriageVerdict,
  tool: HostMcpToolInfo,
  kind: TrackerConfig["kind"]
): Record<string, unknown> | undefined {
  if (kind !== "linear") {
    return undefined;
  }
  const known = propertyNames(tool);
  const issueProperty =
    FIELD_ALIASES.issue.find((alias) => known.has(alias)) ??
    (UPDATE_ISSUE_TOOL.test(tool.name) ? "id" : undefined);
  if (issueProperty === undefined) {
    return undefined;
  }
  const priorityProperty = FIELD_ALIASES.priority.find((alias) =>
    known.has(alias)
  );
  if (priorityProperty === undefined) {
    return undefined;
  }
  return {
    [issueProperty]: verdict.identifier,
    [priorityProperty]: PRIORITY_BY_SEVERITY[verdict.severity],
  };
}

function pickProperty(
  tool: HostMcpToolInfo,
  aliases: readonly string[]
): string {
  const known = propertyNames(tool);
  return aliases.find((alias) => known.has(alias)) ?? aliases[0]!;
}

function propertyNames(tool: HostMcpToolInfo): Set<string> {
  const properties = tool.inputSchema?.["properties"];
  if (!isRecord(properties)) {
    return new Set();
  }
  return new Set(Object.keys(properties));
}

interface CandidateIssue {
  identifier: string;
  url: string;
  title: string;
  comments: string[];
}

function matchingIssue(
  candidates: CandidateIssue[],
  title: string,
  excludeIdentifier: string
): TrackerIssue | undefined {
  const match = candidates.find(
    (candidate) =>
      issueIdentifier(candidate) !== excludeIdentifier &&
      titlesMatch(candidate.title, title)
  );
  if (match === undefined) {
    return undefined;
  }
  const identifier = issueIdentifier(match);
  if (identifier === "") {
    return undefined;
  }
  return { identifier, url: match.url };
}

function issuesFromSearch(result: HostMcpCallResult): CandidateIssue[] {
  const fromStructured = collectIssues(result.structuredContent);
  if (fromStructured.length > 0) {
    return fromStructured;
  }
  const text = resultText(result);
  const fromJson = collectIssues(tryParseJson(text));
  return fromJson.length > 0 ? fromJson : issuesFromLines(text);
}

function collectIssues(
  value: unknown,
  found: CandidateIssue[] = []
): CandidateIssue[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectIssues(entry, found);
    }
    return found;
  }
  if (!isRecord(value)) {
    return found;
  }
  const url = firstIssueUrl(value);
  const identifier = firstIssueId(value) || issueKeyIn(url);
  const fields = isRecord(value["fields"]) ? value["fields"] : {};
  const title =
    firstString(value, FIELD_ALIASES.title) ||
    firstString(fields, FIELD_ALIASES.title);
  if (identifier !== "" || url !== "") {
    const jiraComments = jiraCommentBodies(value);
    found.push({
      identifier,
      url,
      title,
      comments:
        jiraComments.length > 0
          ? jiraComments
          : [
              ...collectCommentBodies(value["comments"]),
              ...collectCommentBodies(value["comment"]),
            ],
    });
    return found;
  }
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) {
      collectIssues(nested, found);
    }
  }
  return found;
}

function issuesFromLines(text: string): CandidateIssue[] {
  return text.split(/\n/).flatMap((line) => {
    const identifier = line.match(ISSUE_ID)?.[0] ?? "";
    const url = line.match(LINEAR_URL)?.[0] ?? line.match(JIRA_URL)?.[0] ?? "";
    if (identifier === "" && url === "") {
      return [];
    }
    const title = line
      .replace(LINEAR_URL, "")
      .replace(JIRA_URL, "")
      .replace(ISSUE_ID, "")
      .replace(/\s+/g, " ")
      .trim();
    const triage = line.indexOf("Triage:");
    return [
      {
        identifier,
        url,
        title,
        comments: triage === -1 ? [] : [line.slice(triage)],
      },
    ];
  });
}

function hasCommentStarting(
  candidates: CandidateIssue[],
  identifier: string,
  prefix: string
): boolean {
  return candidates.some(
    (candidate) =>
      issueIdentifier(candidate) === identifier &&
      candidate.comments.some((comment) => hasSentinel(comment, prefix))
  );
}

function hasSentinel(text: string, prefix: string): boolean {
  return text.split(/\n/).some((line) => {
    const trimmed = line
      .trimStart()
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+\.\s+/, "");
    return trimmed.startsWith(prefix);
  });
}

const COMMENT_WRAP_KEYS = [
  "comments",
  "comment",
  "nodes",
  "items",
  "results",
  "data",
  "content",
  "replies",
] as const;

function collectCommentBodies(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim() !== "") {
      found.push(value);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCommentBodies(entry, found);
    }
    return found;
  }
  if (!isRecord(value)) {
    return found;
  }
  const body = firstString(value, FIELD_ALIASES.comment);
  if (body !== "") {
    found.push(body);
    collectCommentBodies(value["comments"], found);
    collectCommentBodies(value["replies"], found);
    return found;
  }
  for (const key of FIELD_ALIASES.comment) {
    const nested = value[key];
    if (nested === undefined || typeof nested === "string") {
      continue;
    }
    const flattened = richTextValue(nested);
    if (flattened !== "") {
      found.push(flattened);
      collectCommentBodies(value["comments"], found);
      collectCommentBodies(value["replies"], found);
      return found;
    }
  }
  for (const key of COMMENT_WRAP_KEYS) {
    if (value[key] !== undefined) {
      collectCommentBodies(value[key], found);
    }
  }
  return found;
}

function issueIdentifier(issue: CandidateIssue): string {
  return issue.identifier || issueKeyIn(issue.url);
}

function issueKeyIn(value: string): string {
  return value.match(ISSUE_ID)?.[0] ?? "";
}

function firstIssueId(record: Record<string, unknown>): string {
  for (const key of ["identifier", "issueKey", "issue_key", "key", "id"]) {
    const value = record[key];
    if (typeof value === "string") {
      const match = value.match(ISSUE_ID);
      if (match !== null) {
        return match[0];
      }
    }
  }
  return "";
}

function firstIssueUrl(record: Record<string, unknown>): string {
  for (const key of ["url", "htmlUrl", "issueUrl", "link"]) {
    const value = record[key];
    if (typeof value === "string") {
      const url =
        value.match(LINEAR_URL)?.[0] ?? value.match(JIRA_URL)?.[0] ?? "";
      if (url !== "") {
        return url;
      }
    }
  }
  return "";
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[]
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return "";
}

function titlesMatch(candidate: string, title: string): boolean {
  const hay = normalizeTitle(candidate);
  const needle = normalizeTitle(title);
  return hay !== "" && hay === needle;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function resultText(result: HostMcpCallResult): string {
  return result.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .filter((part) => part !== "")
    .join("\n")
    .trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

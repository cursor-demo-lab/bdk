import type { QueueIssue } from "./types.js";

export const ISSUE_ID: RegExp = /\b[A-Z][A-Z0-9]{0,9}-\d+\b/;
export const LINEAR_URL: RegExp =
  /https:\/\/linear\.app\/(?:[^/\s"'<>]+\/)?issue\/[A-Z][A-Z0-9]{0,9}-\d+[^\s"'<>]*/i;
export const JIRA_URL: RegExp =
  /https:\/\/\S+\/(?:browse\/[A-Z][A-Z0-9]{0,9}-\d+|jira\/software\/[^\s"'<>]*selectedIssue=[A-Z][A-Z0-9]{0,9}-\d+)/i;

export type ParseResult =
  | { ok: true; issue: QueueIssue }
  | { ok: false; ignored: true }
  | { ok: false; error: string };

export function isIssueId(value: string): boolean {
  const match = value.match(ISSUE_ID);
  return match !== null && match[0] === value;
}

export function pinIssueIdentifier(
  continuationKey: string | null | undefined,
  fallback: string
): string {
  if (typeof continuationKey !== "string") return fallback;
  // Hosted v2 stores continuation keys as `cont:<key>`; local serve and evals use the bare key.
  const bare = continuationKey.startsWith("cont:") ? continuationKey.slice("cont:".length) : continuationKey;
  return isIssueId(bare) ? bare : fallback;
}

export function isTrackerWebhook(body: unknown): boolean {
  return (
    isRecord(body) &&
    (typeof body["type"] === "string" || typeof body["webhookEvent"] === "string")
  );
}

export function parseQueueEvent(body: unknown): ParseResult {
  if (!isRecord(body)) {
    return { ok: false, error: "unsupported queue event" };
  }

  if (typeof body["webhookEvent"] === "string") {
    if (body["webhookEvent"] !== "jira:issue_created") {
      return { ok: false, ignored: true };
    }
    return parseJiraIssue(body);
  }

  if (typeof body["type"] === "string") {
    if (body["type"] !== "Issue" || body["action"] !== "create") {
      return { ok: false, ignored: true };
    }
    return parseLinearIssue(body);
  }

  if (typeof body["identifier"] === "string") {
    return queueIssue({
      identifier: body["identifier"],
      title: stringValue(body["title"]),
      description: descriptionValue(body["description"]),
      url: stringValue(body["url"]),
      reporter: reporterValue(body["reporter"]),
    });
  }

  return { ok: false, error: "identifier is required" };
}

export function formatQueuePrompt(issue: QueueIssue): string {
  return [
    "Triage this existing issue.",
    "",
    `identifier: ${issue.identifier}`,
    `title: ${issue.title}`,
    `description: ${issue.description}`,
    `url: ${issue.url}`,
    `reporter: ${issue.reporter ?? ""}`,
  ].join("\n");
}

function parseLinearIssue(body: Record<string, unknown>): ParseResult {
  const data = body["data"];
  if (!isRecord(data)) {
    return { ok: false, ignored: true };
  }
  const identifier =
    stringValue(data["identifier"]) || stringValue(data["key"]);
  if (identifier.match(ISSUE_ID)?.[0] === undefined) {
    return { ok: false, ignored: true };
  }
  return queueIssue({
    identifier,
    title: stringValue(data["title"]),
    description: descriptionValue(data["description"]),
    url: stringValue(data["url"]),
    reporter: reporterValue(data["creator"]),
    ...statusValue(data["state"]),
  });
}

function parseJiraIssue(body: Record<string, unknown>): ParseResult {
  const issue = body["issue"];
  if (!isRecord(issue)) {
    return { ok: false, ignored: true };
  }
  const fields = isRecord(issue["fields"]) ? issue["fields"] : {};
  const identifier = stringValue(issue["key"]);
  if (identifier.match(ISSUE_ID)?.[0] === undefined) {
    return { ok: false, ignored: true };
  }
  return queueIssue({
    identifier,
    title: stringValue(fields["summary"]),
    description: descriptionValue(fields["description"]),
    url: stringValue(issue["self"]),
    reporter: reporterValue(fields["reporter"]),
    ...issueTypeValue(fields["issuetype"]),
    ...statusValue(fields["status"]),
  });
}

function issueTypeValue(value: unknown): { issueType?: string } {
  const name = isRecord(value) ? stringValue(value["name"]).trim() : "";
  return name === "" ? {} : { issueType: name };
}

function statusValue(value: unknown): { status?: string } {
  const name = isRecord(value) ? stringValue(value["name"]).trim() : "";
  return name === "" ? {} : { status: name };
}

function queueIssue(input: QueueIssue): ParseResult {
  const identifier = input.identifier.match(ISSUE_ID)?.[0];
  if (identifier === undefined) {
    return { ok: false, error: "identifier is required" };
  }
  return { ok: true, issue: { ...input, identifier } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function richTextValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(richTextValue).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value["text"] === "string") {
    return value["text"];
  }
  return richTextValue(value["content"]);
}

function descriptionValue(value: unknown): string {
  return richTextValue(value);
}

function reporterValue(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["displayName", "name", "email", "emailAddress"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }
  return undefined;
}

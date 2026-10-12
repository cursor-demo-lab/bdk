// Reads the planner's `Plan: <KEY>` comment back into the fields the Slack
// plan post shows. The planner (planner/agent/lib/plan.ts, `jiraComment`)
// writes an approval digest first (`Summary:`, `Approach:`, `Areas:`,
// `Test plan:`, `Risk:`, `Size:`), then the long body, then `Brief:` last.
// Comments written before the digest existed are read from the body's own
// headings instead, and anything missing stays missing.

import type { CommentRecord } from "./jira.js";

export type PlanDigest = {
  format: "digest" | "legacy";
  title?: string;
  evidence?: string;
  summary?: string;
  approach?: string;
  areas: string[];
  testPlan: string[];
  risk?: { level?: string; reason?: string };
  size?: { estimate?: string; reason?: string };
  brief?: string;
};

type Section = { inline: string; lines: string[] };

// Every heading jiraComment writes. Only these end the section before them,
// so a content line that happens to contain a colon stays content.
const COLON_HEADINGS = new Set([
  "evidence",
  "summary",
  "approach",
  "areas",
  "test plan",
  "risk",
  "size",
  "key concepts",
  "flow",
  "where things live",
  "gotchas",
  "preserve",
  "change",
  "avoid",
  "sources consulted",
  "usage",
  "shape",
  "candidates",
  "synthesis decision",
  "tradeoffs accepted",
  "alternatives considered",
  "tests",
  "open questions",
  "next step",
  "brief",
]);
const BARE_HEADINGS = new Set(["problem", "how it works today", "why it is this way", "design", "steps"]);
const COLON_HEADING = /^([A-Za-z][A-Za-z ]*?):(?:\s+(.*))?$/;
const LIST_MARKER = /^(?:[-*\u2022]|\d+[.)])\s+/;
const RISK_GRADE = /^(low|medium|high)\b[.:,;]?\s*(.*)$/i;
const SIZE_GRADE = /^(small|medium|large)\b[.:,;]?\s*(.*)$/i;

export function isPlanComment(body: string, issueKey: string): boolean {
  const first = firstLine(body);
  const sentinel = `Plan: ${issueKey}`;
  return first === sentinel || first.startsWith(`${sentinel} `);
}

/** The newest `Plan: <KEY>` comment. Jira lists comments oldest first. */
export function latestPlanComment(comments: readonly CommentRecord[], issueKey: string): CommentRecord | undefined {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]!;
    if (isPlanComment(comment.body, issueKey)) return comment;
  }
  return undefined;
}

export function parsePlanComment(body: string, issueKey: string): PlanDigest {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  const sections = collectSections(lines.slice(firstIndex + 1));
  const brief = briefOf(lines);
  const title = titleOf(lines[firstIndex] ?? "", issueKey);
  const evidence = inlineOf(sections.get("evidence"));

  if (sections.has("summary") || sections.has("approach")) {
    return compact({
      format: "digest",
      title,
      evidence,
      summary: textOf(sections.get("summary")),
      approach: textOf(sections.get("approach")),
      areas: itemsOf(sections.get("areas")),
      testPlan: itemsOf(sections.get("test plan")),
      risk: rename(graded(textOf(sections.get("risk")), RISK_GRADE), "level"),
      size: rename(graded(textOf(sections.get("size")), SIZE_GRADE), "estimate"),
      brief,
    });
  }

  const shape = inlineOf(sections.get("shape"));
  const decision = inlineOf(sections.get("synthesis decision"));
  const risks = itemsOf(sections.get("risk"));
  return compact({
    format: "legacy",
    title,
    evidence,
    summary: textOf(sections.get("problem")),
    approach: shape ?? decision,
    areas: itemsOf(sections.get("where things live")),
    testPlan: itemsOf(sections.get("tests")),
    risk: risks.length === 0 ? undefined : { reason: risks.join("; ") },
    brief,
  });
}

// The first occurrence of each heading wins: the digest's `Risk:` comes
// before the body's `Risk:` list. Parsing stops at the first `Brief:`, which
// is host text the post shows whole.
function collectSections(lines: readonly string[]): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: Section | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = headingOf(line);
    if (heading !== undefined) {
      if (heading.name === "brief") break;
      current = { inline: heading.inline, lines: [] };
      if (!sections.has(heading.name)) sections.set(heading.name, current);
      continue;
    }
    if (line !== "") current?.lines.push(line);
  }
  return sections;
}

function headingOf(line: string): { name: string; inline: string } | undefined {
  const lower = line.toLowerCase();
  if (BARE_HEADINGS.has(lower)) return { name: lower, inline: "" };
  const match = COLON_HEADING.exec(line);
  if (match === null) return undefined;
  const name = match[1]!.toLowerCase();
  return COLON_HEADINGS.has(name) ? { name, inline: (match[2] ?? "").trim() } : undefined;
}

function briefOf(lines: readonly string[]): string | undefined {
  let start = -1;
  lines.forEach((line, index) => {
    if (line.trim() === "Brief:") start = index + 1;
  });
  if (start === -1) return undefined;
  const brief = lines.slice(start).join("\n").trim();
  return brief === "" ? undefined : brief;
}

function titleOf(first: string, issueKey: string): string | undefined {
  const rest = first.trim().slice(`Plan: ${issueKey}`.length).trim();
  const title = rest.replace(/\s+Evidence:.*$/, "").trim();
  return title === "" ? undefined : title;
}

function inlineOf(section: Section | undefined): string | undefined {
  return section === undefined || section.inline === "" ? undefined : section.inline;
}

function textOf(section: Section | undefined): string | undefined {
  if (section === undefined) return undefined;
  const text = [section.inline, ...section.lines].filter((part) => part !== "").join(" ").trim();
  return text === "" ? undefined : text;
}

function itemsOf(section: Section | undefined): string[] {
  if (section === undefined) return [];
  return [section.inline, ...section.lines].map((line) => line.replace(LIST_MARKER, "").trim()).filter((line) => line !== "");
}

function graded(text: string | undefined, grades: RegExp): { grade?: string; reason?: string } | undefined {
  if (text === undefined) return undefined;
  const match = grades.exec(text);
  if (match === null) return { reason: text };
  const reason = match[2]!.trim();
  return { grade: match[1]!.toLowerCase(), ...(reason === "" ? {} : { reason }) };
}

function rename<K extends string>(value: { grade?: string; reason?: string } | undefined, key: K): Partial<Record<K | "reason", string>> | undefined {
  if (value === undefined) return undefined;
  const { grade, reason } = value;
  return { ...(grade === undefined ? {} : { [key]: grade }), ...(reason === undefined ? {} : { reason }) } as Partial<Record<K | "reason", string>>;
}

function firstLine(body: string): string {
  return (body.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim();
}

function compact(digest: PlanDigest): PlanDigest {
  return Object.fromEntries(Object.entries(digest).filter(([, value]) => value !== undefined)) as PlanDigest;
}

// Pure: the implement PR description's leading link lines. The worker reads
// `Ticket:` and `Slack thread:` back from the brief it launched with and makes
// the description open with them (lib/pr-body.ts writes it). No imports, so
// scripts/outcome-sentinels.test.mjs can hold this parser to the planner's
// brief writer.

// Same shapes as planner/agent/lib/plan.ts `SLACK_THREAD`: only a Slack
// archive permalink, so ticket text cannot put another link on the PR.
const SLACK_URL = /^https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/[CG][A-Z0-9]+\/p\d{16}(?:\?[\w.=&%-]*)?$/;
const BRIEF_LINK = /^(Ticket|Slack thread):\s*(?:\[[^\]]*\]\()?<?(https:\/\/[^\s>|)\]]+)/;
const LINK_LINE = /^\s*(?:\*\*)?(Jira|Slack(?: thread)?)(?:\*\*)?:/i;

export type TicketLinks = { jira?: string; slack?: string };

/**
 * `Ticket:` and `Slack thread:` from the brief's opening block (the lines
 * before its first blank line), as the planner writes them. A Slack link that
 * is not an archive permalink, or a ticket link that is not this key's
 * browse URL, is dropped.
 */
export function briefLinks(brief: string, issueKey: string): TicketLinks {
  const links: TicketLinks = {};
  for (const line of brief.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "") break;
    const found = BRIEF_LINK.exec(line.trim());
    if (found === null) continue;
    const label = found[1];
    const url = found[2]!;
    if (label === "Slack thread" && links.slack === undefined && SLACK_URL.test(url)) links.slack = url;
    if (label === "Ticket" && links.jira === undefined && isBrowseUrl(url, issueKey)) links.jira = url;
  }
  return links;
}

/**
 * The description with `Jira:` then `Slack:` as its first two lines, or
 * undefined when it already opens that way. An existing leading `Jira:` line
 * is kept as written; leading `Slack:` or `Slack thread:` lines are replaced
 * by the ticket's permalink. Without a Slack permalink there is nothing to add.
 */
export function withTicketLinks(body: string | null | undefined, input: { issueKey: string; links: TicketLinks }): string | undefined {
  const { slack, jira } = input.links;
  if (slack === undefined) return undefined;
  const lines = (body ?? "").replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  let end = start;
  while (end < lines.length && LINK_LINE.test(lines[end]!)) end += 1;
  const header = lines.slice(start, end).map((line) => line.trim());
  const jiraLine = header.find((line) => /^(?:\*\*)?Jira(?:\*\*)?:/i.test(line));
  const wanted = [jiraLine ?? `Jira: ${jira ?? input.issueKey}`, `Slack: ${slack}`];
  if (header.length === wanted.length && header.every((line, i) => line === wanted[i])) return undefined;
  const rest = lines.slice(end);
  while (rest.length > 0 && rest[rest.length - 1]!.trim() === "") rest.pop();
  if (rest.length === 0) return wanted.join("\n");
  return [...wanted, ...(rest[0]!.trim() === "" ? [] : [""]), ...rest].join("\n");
}

function isBrowseUrl(url: string, issueKey: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.pathname === `/browse/${issueKey}`;
  } catch {
    return false;
  }
}

// The two comments a planning run leaves when it records no plan. The ticket
// stays Triaged: no Plan, no Brief, no Planned move. The first line is the
// sentinel the desk wakes on (its TLSSN comment rule) and parses to tell the
// ticket's Slack thread why no plan came; factory-desk/agent/lib/
// planner-outcome.ts reads both shapes, so change them together. Each body
// carries the minute it was written, so a later planning run that reaches
// the same verdict still adds a comment instead of matching the earlier one.

export function needsInfoSentinel(issueKey: string): string {
  return `Needs info: ${issueKey}`;
}

export function planStoppedSentinel(issueKey: string): string {
  return `Plan stopped: ${issueKey}`;
}

export function firstLine(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

export function needsInfoComment(input: {
  issueKey: string;
  repo: string;
  ref: string;
  claimed: string;
  mismatch: string;
  searched: readonly string[];
  at: Date;
}): string {
  return [
    needsInfoSentinel(input.issueKey),
    `Claimed failure is not on ${input.repo}@${input.ref} (checked ${minute(input.at)}).`,
    "",
    `Ticket claimed: ${oneLine(input.claimed)}`,
    `On ${input.ref}: ${oneLine(input.mismatch)}`,
    "Searched:",
    ...input.searched.map((entry) => `- ${oneLine(entry)}`),
    "",
    "Do not implement and do not open a pull request. Update the ticket with a path that fails on this ref, or close it.",
  ].join("\n");
}

/** `skipped` is a Triaged entry the planner did not start a run for, because of the triage verdict. */
export function planStoppedComment(input: { issueKey: string; why: string; at: Date; skipped?: boolean }): string {
  return [
    planStoppedSentinel(input.issueKey),
    input.skipped === true
      ? `The planner did not start a planning run for this move to Triaged at ${minute(input.at)}.`
      : `The planning run stopped at ${minute(input.at)} without a plan.`,
    `Why: ${oneLine(input.why)}`,
    "",
    input.skipped === true
      ? "Nothing was planned and nothing will be built. Answer the Needs info in the ticket's Slack thread, or change the triage verdict in Jira, then send the ticket back to Triaged."
      : "Nothing was planned and nothing will be built. Send the ticket back to Triaged for a new planning run.",
  ].join("\n");
}

function minute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

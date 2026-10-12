// The comment a triage run leaves when it ends with the ticket still in To Do.
// The first line is the sentinel the desk wakes on (its TLSSN comment rule)
// and factory-desk/agent/lib/triage-outcome.ts parses the `Why:` line, so
// change the two together. Each body carries the minute it was written, so a
// later run that stops the same way still adds a comment the desk announces.

export function triageStoppedSentinel(issueKey: string): string {
  return `Triage stopped: ${issueKey}`;
}

export function triageStoppedComment(input: { issueKey: string; why: string; at: Date; triaged: string }): string {
  return [
    triageStoppedSentinel(input.issueKey),
    `The triage run stopped at ${minute(input.at)} before the ticket reached ${input.triaged}.`,
    `Why: ${oneLine(input.why)}`,
    "",
    `The planner has not started. Move the ticket to ${input.triaged} to send it to the planner.`,
  ].join("\n");
}

function minute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

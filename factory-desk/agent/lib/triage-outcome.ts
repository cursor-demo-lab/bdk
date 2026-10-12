// The comment triage-jira leaves when a triage run ends before the ticket
// reaches Triaged (triage-jira/agent/lib/triage-outcome.ts
// `triageStoppedComment`). The ticket stays in To Do, so neither the planner
// nor the desk's status rule wakes; the desk wakes on the comment and tells
// the ticket's thread why. triage-outcome.test.ts parses the triage body
// verbatim, so change the two together.

export type TriageStopped = { kind: "triage_stopped"; why?: string };
export type TriageOutcomeKind = TriageStopped["kind"];

const SENTINEL = "Triage stopped:";

export function triageOutcomeKind(text: string, issueKey: string): TriageOutcomeKind | undefined {
  const first = normalize(text).split("\n", 1)[0]!.trim();
  const sentinel = `${SENTINEL} ${issueKey}`;
  return first === sentinel || first.startsWith(`${sentinel} `) ? "triage_stopped" : undefined;
}

export function parseTriageOutcome(text: string, issueKey: string): TriageStopped | undefined {
  if (triageOutcomeKind(text, issueKey) === undefined) return undefined;
  const line = normalize(text)
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("Why:"));
  const why = line?.slice("Why:".length).trim();
  return { kind: "triage_stopped", ...(why === undefined || why === "" ? {} : { why }) };
}

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

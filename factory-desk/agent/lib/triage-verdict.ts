// A triage verdict and the Triage: comment it becomes. Shared verbatim by
// triage-jira and factory-desk (scripts/copies-parity.test.mjs), so both
// write the same comment; the desk's marker is agent/lib/desk-triaged.ts.
// The comment's readers are factory-desk/agent/lib/triage-comment.ts and
// planner/agent/lib/jira-event.ts; ../../scripts/jev-judge-line.test.mjs
// pins the desk side. No runtime imports, so root tests can load it.

export type TriageKind = "bug" | "question" | "feedback";

export type TriageSeverity = "low" | "medium" | "high" | "urgent";

export type TriageVerdict = {
  identifier: string;
  kind: TriageKind;
  severity: TriageSeverity;
  title: string;
  summary: string;
  nextStep: string;
  reporter?: string;
  duplicateOf?: string;
  needsInfo?: boolean;
};

export function triageComment(verdict: TriageVerdict, duplicate: { identifier: string } | undefined, judge?: string, issueType?: string): string {
  const lines = [
    `Triage: ${verdict.kind}`,
    ...(issueType === undefined || issueType.trim() === "" ? [] : [`Type: ${issueType.trim()}`]),
    `Severity: ${verdict.severity}`,
    `Summary: ${verdict.summary}`,
    `Next step: ${verdict.nextStep}`,
  ];
  if (duplicate !== undefined) {
    lines.push(`Duplicate of: ${duplicate.identifier}`);
  }
  if (verdict.needsInfo === true) {
    lines.push(`Needs info: ${verdict.nextStep}`);
  }
  if (verdict.reporter !== undefined && verdict.reporter !== "") {
    lines.push(`Reported by: ${verdict.reporter}`);
  }
  if (judge !== undefined && judge !== "") {
    lines.push(judge);
  }
  return lines.join("\n");
}

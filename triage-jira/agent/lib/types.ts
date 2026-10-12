import type { TriageSeverity, TriageVerdict } from "./triage-verdict.js";

export type { TriageKind, TriageSeverity, TriageVerdict } from "./triage-verdict.js";

export interface QueueIssue {
  identifier: string;
  url: string;
  title: string;
  description: string;
  reporter?: string;
  /** Jira `fields.issuetype.name` as the webhook delivered it. */
  issueType?: string;
  /** The status the issue was created in, as the webhook delivered it. */
  status?: string;
}

export interface TrackerIssue {
  identifier: string;
  url: string;
}

export type QueueAction =
  | { op: "commented" }
  | { op: "already_commented" }
  | { op: "prioritized"; severity: TriageSeverity }
  | { op: "duplicate_of"; of: string }
  | { op: "needs_info" };

export type TrackerResult =
  | { status: "not_connected" }
  | { status: "skipped"; reason: "eval" | "staging_refuses_production" }
  | { status: "acted"; issue: TrackerIssue; actions: QueueAction[] }
  | { status: "failed"; message: string };

export interface RecordTriageResult {
  verdict: TriageVerdict;
  evaluatedAt: string;
  tracker: TrackerResult;
}

export type TrackerConfig =
  | { kind: "none" }
  | { kind: "linear" | "jira"; connectionName: string };

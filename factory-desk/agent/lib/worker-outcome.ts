// The three comments factory-worker leaves when it did not do what the
// thread was told comes next (factory-worker/agent/lib/decide.ts
// `launchFailedComment`, `noBriefComment`; pr-status.ts `noteSkip`). None of
// them moves the ticket, so no status webhook fires; the desk wakes on the
// comment and tells the ticket's thread why. worker-outcome.test.ts parses the
// worker's bodies verbatim, so change the two together.

export type LaunchFailed = { kind: "launch_failed"; reason?: string };
export type ApprovedWithoutPlan = { kind: "approved_without_plan" };
export type MoveSkipped = { kind: "move_skipped"; target: string; pr: string; detail?: string };
export type WorkerOutcome = LaunchFailed | ApprovedWithoutPlan | MoveSkipped;
export type WorkerOutcomeKind = WorkerOutcome["kind"];

/** The worker's status names for the two moves its pull request path makes. */
export type WorkerStatuses = { inReview: string; done: string };

// The worker writes "Approved" literally in this line whatever the status is named.
const LAUNCH_FAILED = /^Launch failed: (.{1,40})\. Moving the card to Approved again retries\.$/;
const NO_PLAN = "Approved without a plan on the ticket; nothing was launched.";
const MOVE_SKIPPED = /^(.+?) not set from ([\w.-]+\/[\w.-]+#\d+): (.+)$/;

/** Which worker outcome a comment is, when its first line is one the worker writes for this ticket. */
export function workerOutcomeKind(text: string, issueKey: string, statuses: WorkerStatuses): WorkerOutcomeKind | undefined {
  return parseWorkerOutcome(text, issueKey, statuses)?.kind;
}

export function parseWorkerOutcome(text: string, issueKey: string, statuses: WorkerStatuses): WorkerOutcome | undefined {
  const first = firstLine(text);
  const failed = first.match(LAUNCH_FAILED);
  if (failed !== null) {
    const reason = failed[1]!.trim();
    return { kind: "launch_failed", ...(reason === "" ? {} : { reason }) };
  }
  if (first.startsWith(NO_PLAN) && mentions(first, issueKey)) return { kind: "approved_without_plan" };
  const skipped = first.match(MOVE_SKIPPED);
  if (skipped !== null && [statuses.inReview, statuses.done].some((name) => sameName(name, skipped[1]!))) {
    const detail = skipped[3]!.trim();
    return { kind: "move_skipped", target: skipped[1]!.trim(), pr: skipped[2]!, ...(detail === "" ? {} : { detail }) };
  }
  return undefined;
}

function mentions(text: string, issueKey: string): boolean {
  return new RegExp(`(^|[^A-Z0-9-])${issueKey}([^0-9]|$)`).test(text);
}

function sameName(a: string, b: string): boolean {
  return a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function firstLine(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

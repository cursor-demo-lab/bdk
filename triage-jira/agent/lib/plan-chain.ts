// Ticket → triage → plan, triage side. Pure: turns a record_triage result
// into the request the planner's plan_issue tool takes, or nothing.
// record_triage owns the side effect.

export const PLANNER_CONNECTION = "planner";
export const PLAN_TOOL = "plan_issue";

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export type PlanRequest = {
  issueKey: string;
  title: string;
  summary?: string;
  verdict: {
    kind: "bug" | "question" | "feedback";
    severity: "low" | "medium" | "high" | "urgent";
    needsInfo?: boolean;
    duplicateOf?: string;
    nextStep?: string;
  };
};

export type ChainVerdict =
  | { chain: true; request: PlanRequest }
  | { chain: false; reason: "not_record_triage" | "tool_error" | "stubbed" | "eval" | "not_acted" | "already_commented" | "not_commented" | "no_issue_key" | "question" | "needs_info" | "duplicate" };

/**
 * Decide from one `action.result` event. The planner applies the same
 * question / needs-info / duplicate rule again on its side; deciding here too
 * saves the peer call, and `reason` makes the skip visible in a test.
 */
export function chainDecision(input: {
  toolName: string;
  isError: boolean;
  stubbed?: boolean;
  output: unknown;
  purpose?: string;
  continuationKey?: string | null;
}): ChainVerdict {
  if (input.toolName !== "record_triage") return { chain: false, reason: "not_record_triage" };
  if (input.isError) return { chain: false, reason: "tool_error" };
  if (input.stubbed === true) return { chain: false, reason: "stubbed" };
  if (input.purpose === "eval") return { chain: false, reason: "eval" };
  const output = isRecord(input.output) ? input.output : undefined;
  const tracker = output !== undefined && isRecord(output["tracker"]) ? output["tracker"] : undefined;
  if (tracker === undefined || tracker["status"] !== "acted") return { chain: false, reason: "not_acted" };
  // Only a Triage: comment written in this call starts a plan. A redelivered
  // webhook finds its comment already there and must not plan the ticket twice.
  const actions = Array.isArray(tracker["actions"]) ? tracker["actions"] : [];
  const op = (name: string) => actions.some((action) => isRecord(action) && action["op"] === name);
  if (!op("commented")) return { chain: false, reason: op("already_commented") ? "already_commented" : "not_commented" };
  const verdict = output !== undefined && isRecord(output["verdict"]) ? output["verdict"] : undefined;
  const pinned = typeof input.continuationKey === "string" && ISSUE_KEY.test(input.continuationKey) ? input.continuationKey : undefined;
  const fromVerdict = verdict !== undefined && typeof verdict["identifier"] === "string" && ISSUE_KEY.test(verdict["identifier"]) ? verdict["identifier"] : undefined;
  const issueKey = pinned ?? fromVerdict;
  if (issueKey === undefined || verdict === undefined) return { chain: false, reason: "no_issue_key" };
  // The model's verdict names a duplicate, or actuate's host-side title match
  // recorded one as a tracker action without touching the verdict. Either stops the chain.
  const duplicateOf = typeof verdict["duplicateOf"] === "string" ? verdict["duplicateOf"].trim() : "";
  if (duplicateOf !== "" || op("duplicate_of")) return { chain: false, reason: "duplicate" };
  if (verdict["needsInfo"] === true) return { chain: false, reason: "needs_info" };
  const kind = verdict["kind"];
  if (kind !== "bug" && kind !== "feedback") return { chain: false, reason: "question" };
  const severity = verdict["severity"];
  return {
    chain: true,
    request: {
      issueKey,
      title: str(verdict["title"]) || issueKey,
      ...(str(verdict["summary"]) === "" ? {} : { summary: str(verdict["summary"]) }),
      verdict: {
        kind,
        severity: severity === "low" || severity === "medium" || severity === "high" || severity === "urgent" ? severity : "medium",
        ...(str(verdict["nextStep"]) === "" ? {} : { nextStep: str(verdict["nextStep"]) }),
      },
    },
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

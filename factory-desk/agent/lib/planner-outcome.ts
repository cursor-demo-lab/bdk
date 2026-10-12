// The two comments the planner leaves on a ticket it did not plan
// (planner/agent/lib/needs-info.ts `needsInfoComment`, `planStoppedComment`).
// The first line is the sentinel; the ticket stays Triaged. The desk wakes
// on the comment and tells the ticket's thread why no plan came. Keep the two
// in step: planner-outcome.test.ts parses the planner's bodies verbatim.
// Atlassian may hand the body back as rendered rich text, so list items can
// lose their `- ` and every field is optional.

export type NeedsInfo = { kind: "needs_info"; repo?: string; ref?: string; claimed?: string; mismatch?: string; searched: string[] };
/** `skipped`: the planner started no run for that move to Triaged, because of the triage verdict. */
export type PlanStopped = { kind: "plan_stopped"; why?: string; skipped?: true };
export type PlannerOutcome = NeedsInfo | PlanStopped;
export type PlannerOutcomeKind = PlannerOutcome["kind"];

const SENTINELS: Record<PlannerOutcomeKind, string> = { needs_info: "Needs info:", plan_stopped: "Plan stopped:" };
const CHECKED = /^Claimed failure is not on ([^\s@]+)@(\S+?)(?:\s+\(checked[^)]*\))?\.?\s*$/m;

/** Which planner outcome a comment is, when its first line is that sentinel for this ticket. */
export function plannerOutcomeKind(text: string, issueKey: string): PlannerOutcomeKind | undefined {
  const first = firstLine(text);
  for (const kind of ["needs_info", "plan_stopped"] as const) {
    const sentinel = `${SENTINELS[kind]} ${issueKey}`;
    if (first === sentinel || first.startsWith(`${sentinel} `)) return kind;
  }
  return undefined;
}

export function parsePlannerOutcome(text: string, issueKey: string): PlannerOutcome | undefined {
  const kind = plannerOutcomeKind(text, issueKey);
  if (kind === undefined) return undefined;
  const lines = normalize(text).split("\n").map((line) => line.trim());
  if (kind === "plan_stopped") {
    const why = field(lines, "Why:");
    const skipped = lines.some((line) => line.startsWith("The planner did not start a planning run"));
    return { kind, ...(why === undefined ? {} : { why }), ...(skipped ? { skipped: true as const } : {}) };
  }
  const checked = normalize(text).match(CHECKED);
  const ref = checked?.[2];
  const claimed = field(lines, "Ticket claimed:");
  const mismatch = ref === undefined ? undefined : field(lines, `On ${ref}:`);
  return {
    kind,
    ...(checked?.[1] === undefined ? {} : { repo: checked[1] }),
    ...(ref === undefined ? {} : { ref }),
    ...(claimed === undefined ? {} : { claimed }),
    ...(mismatch === undefined ? {} : { mismatch }),
    searched: searched(lines),
  };
}

function field(lines: readonly string[], label: string): string | undefined {
  const line = lines.find((entry) => entry.startsWith(label));
  const value = line?.slice(label.length).trim();
  return value === undefined || value === "" ? undefined : value;
}

function searched(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => line === "Searched:");
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "" || line.startsWith("Do not implement")) break;
    const item = line.replace(/^[-*\u2022]\s*/, "").trim();
    if (item !== "") out.push(item);
  }
  return out;
}

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

function firstLine(text: string): string {
  const trimmed = normalize(text);
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

import { governingTriage } from "./desk-triaged.js";

// The governing `Triage:` verdict on a ticket, read the way the planner's
// status gate reads it (planner/agent/lib/jira-event.ts `governingTriage` and
// `parseTriage`, planner/agent/lib/chain.ts `decide`). A verdict with a gate
// is one the planner skips on its Triaged wake, so the desk must not say a
// plan is coming. Keep the two in step: `triage-comment.test.ts` pins the
// planner's cases.

export type TriageGate = "duplicate" | "needs_info" | "question";

export type TriageVerdict = {
  kind: "bug" | "question" | "feedback";
  severity: "low" | "medium" | "high" | "urgent";
  gate?: TriageGate;
  duplicateOf?: string;
  nextStep?: string;
  /** The ticket's Jira issue type, from the comment's `Type:` line. */
  issueType?: string;
  /** The triage model's kind when triage-jira's host Jev judge set the Jira type and the kind changed with it (the `Judge:` line). */
  judgedOver?: "bug" | "question" | "feedback";
  /** What triage-jira's host Jev judge chose, from the `Judge:` line. Absent when Jev did not answer. */
  jev?: JevJudgment;
  /** Who triaged: the `Triaged by:` line, else `Jev only` on the Judge: line; the model otherwise. */
  triagedBy?: "jev" | "model";
  /** The backup model's name on the `Triaged by:` line (`Grok 4.6 Fast`); absent on older comments that say `model`. */
  triageModel?: string;
  /** Jev's confidence as a whole percent, from the `Triaged by:` line. */
  confidence?: number;
  /** `no_key` when the `Triaged by:` line says Jev is not configured. */
  fallback?: "no_key";
};

/**
 * One `Judge:` line, as jev-triage.ts `judgeLine` writes it. `type.outcome`:
 * `set` / `already` (the type is on the ticket), `below` (under the bar, or
 * held back by the type guard: the ticket keeps its type), `failed` (the Jira edit failed). `severity.outcome`:
 * `agreed` with triage, `applied` over triage's `model`, or `kept` triage's
 * `model` because Jev was under the bar, or `only`. `only` is set when
 * triage recorded Jev's answers with no model turn (`Jev only`), so there is
 * no triage verdict to agree with.
 */
export type JevJudgment = {
  type?: { choice: string; probability: string; outcome: "set" | "already" | "below" | "failed"; model?: string };
  severity?: { choice: string; probability: string; outcome: "agreed" | "applied" | "kept" | "only"; model?: string };
  only?: true;
};

/** The first line of the comment the desk writes when a thread reply answers a Needs info (thread-detail.ts). */
export const DETAIL_SENTINEL = "Detail from Slack:";

/**
 * The verdict the planner gates on, or undefined when the ticket has no
 * `Triage:` comment: the one `governingTriage` (desk-triaged.ts, shared
 * with the planner) picks. A `Detail from Slack:` comment after a needs-info
 * verdict is the information triage asked for, so that verdict no longer
 * gates the planner. `asWritten` ignores that answer and returns the verdict
 * triage wrote.
 */
export function latestTriageVerdict(comments: readonly string[], options: { asWritten?: boolean } = {}): TriageVerdict | undefined {
  const at = governingTriage(comments)?.index;
  if (at === undefined) return undefined;
  const text = comments[at] ?? "";
  const verdict = parseTriage({ first: firstLine(text), text });
  const answered = options.asWritten !== true && comments.slice(at + 1).some((comment) => firstLine(comment).startsWith(DETAIL_SENTINEL));
  if (!answered || verdict.gate !== "needs_info") return verdict;
  const { gate: _answered, ...rest } = verdict;
  return rest;
}

function parseTriage({ first, text }: { first: string; text: string }): TriageVerdict {
  const head = first.slice("Triage:".length).trim().split(/[.,\s]/, 1)[0]?.toLowerCase() ?? "";
  const severity = severityOf(text);
  const nextStep = text.match(/^Next step:\s*(.+)$/im)?.[1]?.trim();
  const jev = jevJudgment(text);
  const credit = triagedByCredit(text);
  const by = credit.by ?? (jev?.only === true ? "jev" : undefined);
  const { by: _by, ...creditRest } = credit;
  const withStep = { ...(nextStep === undefined || nextStep === "" ? {} : { nextStep }), ...(jev === undefined ? {} : { jev }), ...(by === undefined ? {} : { triagedBy: by }), ...creditRest };
  if (head === "duplicate" || /duplicate of:/i.test(text)) {
    const named = text.match(/Duplicate of:\s*([A-Z][A-Z0-9]+-\d+)/i)?.[1];
    return { kind: "bug", severity, gate: "duplicate", ...(named === undefined ? {} : { duplicateOf: named.toUpperCase() }), ...withStep };
  }
  const kind = head === "feedback" || head === "question" || head === "bug" ? head : "bug";
  if (/^Needs info:/im.test(text)) return { kind, severity, gate: "needs_info", ...withStep };
  const typed = typeAndJudge(text);
  if (kind === "question") return { kind, severity, gate: "question", ...withStep, ...typed };
  return { kind, severity, ...withStep, ...typed };
}

// triage-jira/agent/lib/triage-comment.ts writes `Type: <Jira type>`;
// jev-triage.ts `judgeLine` writes `Judge: Jev type <T> <p> (set in Jira; model said <kind>); ...`
// or `(already <T> in Jira; model said <kind>)`. A line for another type than `Type:` is ignored.
function typeAndJudge(text: string): { issueType?: string; judgedOver?: TriageVerdict["kind"] } {
  const issueType = text.match(/^Type:\s*(.+?)\s*$/im)?.[1];
  if (issueType === undefined || issueType === "") return {};
  const judge = text.match(/^Judge:\s*Jev\s+type\s+(.+?)\s+[\d.]+\s+\((?:set in Jira|already .+? in Jira); model said (bug|question|feedback)\)/im);
  if (judge === null || judge[1]!.toLowerCase() !== issueType.toLowerCase()) return { issueType };
  return { issueType, judgedOver: judge[2]!.toLowerCase() as TriageVerdict["kind"] };
}

const PROBABILITY = String.raw`(0(?:\.\d+)?|1(?:\.0+)?)`;
const JUDGE_TYPE = new RegExp(String.raw`^type\s+(.+?)\s+${PROBABILITY}\s+\((.+)\)$`, "i");
const JUDGE_SEVERITY = new RegExp(String.raw`^severity\s+(low|medium|high|urgent)\s+${PROBABILITY}\s+\((.+)\)$`, "i");

// A `set` or `already` type that is not the comment's `Type:` line is not
// believed, the same rule `typeAndJudge` keeps; under the bar or after a
// failed edit, Jev's choice differs from the ticket's type by design.
function jevJudgment(text: string): JevJudgment | undefined {
  const body = text.match(/^Judge:\s*Jev\s+(.+?)\s*$/im)?.[1];
  if (body === undefined) return undefined;
  const issueType = text.match(/^Type:\s*(.+?)\s*$/im)?.[1];
  const [typeText, severityText] = body.split(/;\s*(?=severity\s)/i);
  const judged: JevJudgment = {};
  const type = JUDGE_TYPE.exec(typeText?.trim() ?? "");
  if (type !== null) {
    const [, choice, probability, note] = type as unknown as [string, string, string, string];
    const model = note.match(/(?:model said|kept the model's) (bug|question|feedback)/i)?.[1]?.toLowerCase();
    const outcome = /^set in Jira/i.test(note) ? "set" : /^already .+ in Jira/i.test(note) ? "already" : /^(?:below |held back)/i.test(note) ? "below" : /edit failed/i.test(note) ? "failed" : undefined;
    const onTicket = outcome === "set" || outcome === "already";
    if (outcome !== undefined && (!onTicket || issueType?.toLowerCase() === choice.toLowerCase())) {
      judged.type = { choice, probability, outcome, ...(model === undefined ? {} : { model }) };
    }
  }
  const sev = JUDGE_SEVERITY.exec(severityText?.trim() ?? "");
  if (sev !== null) {
    const [, choice, probability, note] = sev as unknown as [string, string, string, string];
    const model = note.match(/(?:model said|kept the model's) (low|medium|high|urgent)/i)?.[1]?.toLowerCase();
    const outcome = /^agreed/i.test(note) ? "agreed" : /^model said/i.test(note) ? "applied" : /^kept/i.test(note) ? "kept" : /^Jev only/i.test(note) ? "only" : undefined;
    if (outcome !== undefined) judged.severity = { choice: choice.toLowerCase(), probability, outcome, ...(model === undefined ? {} : { model }) };
  }
  if (judged.type === undefined && judged.severity === undefined) return undefined;
  if (/\(([^)]*;\s*)?Jev only\)/i.test(body)) judged.only = true;
  return judged;
}

// jev-triage.ts `triagedByLine`: `Triaged by: Jev (78% confidence; …)`, or
// `Triaged by: Grok 4.6 Fast (Jev was only 50% confident; …)`. Older comments
// say `Triaged by: model (…; Jev's 50% confidence)`.
function triagedByCredit(text: string): Pick<TriageVerdict, "triageModel" | "confidence" | "fallback"> & { by?: "jev" | "model" } {
  const line = text.match(/^Triaged by:\s*(.+?)\s*$/im)?.[1];
  if (line === undefined) return {};
  const name = line.split(" (", 1)[0]!.trim();
  if (name === "") return {};
  const percent = line.match(/\b(\d{1,3})% confiden/i)?.[1];
  const confidence = percent === undefined ? undefined : Number(percent);
  const usable = confidence !== undefined && confidence > 0 && confidence <= 100 ? { confidence } : {};
  if (/^jev$/i.test(name)) return { by: "jev", ...usable };
  const notConfigured = /\(Jev is not configured\)/i.test(line);
  return { by: "model", ...(/^model$/i.test(name) ? {} : { triageModel: name }), ...usable, ...(notConfigured ? { fallback: "no_key" as const } : {}) };
}

function severityOf(text: string): TriageVerdict["severity"] {
  const raw = text.match(/^Severity:\s*(\w+)/im)?.[1]?.toLowerCase();
  return raw === "low" || raw === "medium" || raw === "high" || raw === "urgent" ? raw : "medium";
}

function firstLine(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

import { fallbackTriageModel } from "./jev-triage.js";
import type { FallbackReason } from "./intake-triage.js";

// Who triaged, in the words Slack shows (the filing prompt, the Filed post,
// the Triaged line): `Triaged by Jev`, or the backup model by name with why
// Jev did not settle it. Per-answer scores stay on the Triage: comment's
// Judge: line; Slack shows only Jev's confidence, the lowest of its three
// answers (answersConfidence), as a whole percent.
export type TriageCredit = { by: "jev" | "model"; model?: string; percent?: number; reason?: FallbackReason };

const JEV_DID_NOT_SETTLE: Record<FallbackReason, string> = {
  below_bar: "Jev wasn't sure",
  type_guard: "Jev's type didn't fit a report of something broken",
  unavailable: "Jev didn't answer",
  labels: "Jev's answer didn't fit the triage labels",
  no_key: "Jev wasn't asked",
  no_text: "Jev wasn't asked",
  types: "Jev wasn't asked",
  no_project: "Jev wasn't asked",
  no_intake: "Jev wasn't asked",
};

/** `Triaged by Jev`, or `Triaged by Grok 4.6 Fast (Jev was only 50% confident)`. */
export function triagedByPhrase(credit: TriageCredit): string {
  if (credit.by === "jev") return "Triaged by Jev";
  const model = credit.model ?? fallbackTriageModel(process.env);
  // Jev's below-bar answers are Jev's, not the model's, so the number says whose it is.
  const why =
    credit.percent !== undefined && (credit.reason === undefined || credit.reason === "below_bar")
      ? `Jev was only ${credit.percent}% confident`
      : credit.reason === undefined
        ? "Jev didn't settle it"
        : JEV_DID_NOT_SETTLE[credit.reason];
  return `Triaged by ${model} (${why})`;
}

/** The whole triage line: `Triaged by Jev: Bug, medium severity (78% confidence)` or `Triaged by Grok 4.6 Fast (Jev was only 50% confident): Bug, high severity`. */
export function triageLine(credit: TriageCredit, verdict: { type: string; severity: string; note?: string }): string {
  const note = verdict.note ?? (credit.by === "jev" && credit.percent !== undefined ? `${credit.percent}% confidence` : undefined);
  return `${triagedByPhrase(credit)}: ${verdict.type}, ${verdict.severity} severity${note === undefined ? "" : ` (${note})`}`;
}


// LLM judge for the Jev triage eval, live only (`npm run eval:jev-triage -- --judge`).
// Never runs in CI: the unit tests cover the prompts, parsing, and scoring
// with a stubbed call.
//
// Two passes, both on Claude Opus 5.5 at low effort through the Cursor SDK
// (`@cursor/sdk`, a local agent with no tools, so the model only answers in
// text; inference is Cursor-hosted, billed to CURSOR_API_KEY):
//
// 1. Label check: the judge labels every selected case (type and severity,
//    with a rationale) from the reporter's words and a neutral policy, blind
//    to our labels. Disagreements with the hand labels are flagged; a person
//    decides whether a label is wrong.
// 2. Jev critique: for every tune case Jev missed, or answered at or under the
//    0.52 bar on any answer, the judge says why and proposes a concrete wording
//    change to the type or severity question, marked as general or
//    case-specific. Holdout cases are never critiqued: the holdout is frozen
//    and never tuned against.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_THRESHOLD, triageQuestions } from "../../agent/lib/jev-triage.js";
import type { TriageSeverity } from "../../agent/lib/triage-verdict.js";
import type { JevTriageCase, JiraType } from "./cases.js";
import { severityOk, typeOk, type Observation } from "./replay.js";

export const JUDGE_MODEL = { id: "claude-opus-5-5", params: [{ id: "effort", value: "low" }] } as const;

/** One prompt in, the model's final text out. */
export type JudgeCall = (prompt: string) => Promise<string>;

const TYPES: readonly JiraType[] = ["Bug", "Story", "Task"];
const SEVERITIES: readonly TriageSeverity[] = ["low", "medium", "high", "urgent"];

// Written independently of Jev's question and our tie-breakers, so the label
// check is not the tuned wording grading itself.
export const JUDGE_POLICY = `Jira issue types (choose exactly one):
- Bug: something that exists in the product today is broken, erroring, missing, or wrong against what a reasonable user expects. How politely it is asked does not matter.
- Story: the product works as built and the reporter wants a new capability or a change to intended behaviour.
- Task: neither a defect nor a product change, such as a question to look up, a dependency upgrade, a clean-up, docs, or an operational chore.

Severity (choose exactly one):
- urgent: data loss (stored data deleted or corrupted, money sent twice or to the wrong account), a security exposure, or an outage (the service down, people cannot log in, many users blocked).
- high: a core flow broken or wrong for some users with no reasonable workaround.
- medium: broken or wrong with a workaround, a sharp edge that costs time, or a request to change how something behaves.
- low: cosmetic, minor friction, questions, copy or UX suggestions, and most feedback.
Losing text typed into an unsaved form is not data loss.`;

export type JudgeLabel = {
  id: string;
  type: JiraType;
  severity: TriageSeverity;
  /** Other answers the judge considers defensible. */
  alsoType: JiraType[];
  alsoSeverity: TriageSeverity[];
  rationale: string;
};

export type LabelDisagreement = {
  id: string;
  field: "type" | "severity";
  ours: string;
  oursAccepted: string[];
  judge: string;
  judgeAlso: string[];
  /** Hard: the judge's answer is outside our accepted set and ours is outside its defensible set. */
  hard: boolean;
  rationale: string;
};

export type LabelAgreement = {
  cases: number;
  labelled: number;
  type: { strict: number; lenient: number };
  severity: { strict: number; lenient: number };
  disagreements: LabelDisagreement[];
  missing: string[];
};

export type JevCritique = {
  id: string;
  verdict: "jev_wrong" | "label_wrong" | "ambiguous";
  weakAnswer: "type" | "severity" | "gate";
  why: string;
  target: string;
  change: string;
  generalises: boolean;
  generalisesWhy: string;
};

export type JudgeResult = {
  model: typeof JUDGE_MODEL;
  labels?: { labels: JudgeLabel[]; agreement: LabelAgreement };
  critiques?: { items: JevCritique[]; asked: string[]; failed: string[]; synthesis: string };
};

// Case ids name the expected answer (`needs-info-…`, `add-csv-export-…`), so the
// label prompt numbers the cases instead and the answers are mapped back.
export function labelPrompt(cases: readonly Pick<JevTriageCase, "id" | "text">[]): string {
  const body = cases.map((item, index) => `<case id="c${index + 1}">\n${item.text}\n</case>`).join("\n\n");
  return `You are labelling bug-tracker intake messages for a banking app. Each case is a message a user or teammate sent to a triage desk. Label each case by the policy below, from the message alone.

${JUDGE_POLICY}

${body}

Answer with only a JSON array, one object per case, in the same order, no prose and no code fence:
[{"id": "<case id>", "type": "Bug|Story|Task", "severity": "low|medium|high|urgent", "alsoType": [other types a careful triager could defend, often empty], "alsoSeverity": [other defensible severities, often empty], "rationale": "<one sentence>"}]`;
}

export function critiquePrompt(items: readonly CritiqueInput[]): string {
  const questions = triageQuestions([{ name: "Task" }, { name: "Story" }, { name: "Bug" }]);
  const question = (q: { instructions: string; criteria: Record<string, string> }) =>
    [`instructions: ${q.instructions}`, ...Object.entries(q.criteria).map(([label, text]) => `- ${label}: ${text}`)].join("\n");
  const body = items
    .map((item) =>
      [
        `<case id="${item.id}">`,
        item.text,
        `</case>`,
        `Expected: type ${[item.type, ...(item.acceptType ?? [])].join(" or ")}, severity ${[item.severity, ...(item.acceptSeverity ?? [])].join(" or ")}. Why: ${item.rationale}`,
        `Jev's answers per run: ${item.runs.map((run) => `type ${run.type} ${run.typeProbability.toFixed(2)}, severity ${run.severity} ${run.severityProbability.toFixed(2)}, gate ${run.gate} ${run.gateProbability.toFixed(2)}`).join(" | ")}`,
        `Flagged for: ${item.flags.join(", ")}`,
      ].join("\n")
    )
    .join("\n\n");
  return `Jev is a classifier that answers three multiple-choice questions about each triage message and returns a probability for its choice. The team accepts an answer only above ${JEV_THRESHOLD}. Below are the exact questions Jev is asked, then cases where Jev picked a wrong answer or was unsure (an answer at or under ${JEV_THRESHOLD}).

Issue type question:
${question(questions.issueType)}

Severity question:
${question(questions.severity)}

Needs-info gate question:
${question(questions.gate)}

${body}

For each case: say briefly why Jev was wrong or unsure, which answer was weakest, and propose ONE concrete wording change to the question text above (name the target: "type.instructions", "type.Bug", "type.Story", "type.Task", "severity.instructions", "severity.low|medium|high|urgent", "gate.instructions", "gate.<label>", or "none"). Give the exact words to add or replace. Say whether the change generalises to other messages of the same shape or only fixes this case (naming the product feature or the case's own wording does not generalise). If the expected label itself looks wrong, say so with verdict "label_wrong".

Answer with only a JSON array, same order, no prose and no code fence:
[{"id": "<case id>", "verdict": "jev_wrong|label_wrong|ambiguous", "weakAnswer": "type|severity|gate", "why": "<one or two sentences>", "target": "<target>", "change": "<exact wording change>", "generalises": true|false, "generalisesWhy": "<one sentence>"}]`;
}

export function synthesisPrompt(critiques: readonly JevCritique[]): string {
  const general = critiques.filter((item) => item.generalises && item.target !== "none");
  return `These are proposed wording changes to a classifier's questions, each from one case. Merge the ones that generalise into at most three edits, each worded to help many messages rather than one: name the target, the exact replacement or added words, and the cases it addresses. Drop anything that only names one case's feature or wording, and anything that contradicts another edit. Plain text, a numbered list.

${general.map((item) => `- [${item.id}] ${item.target}: ${item.change} (${item.why})`).join("\n") || "(none)"}`;
}

export type CritiqueInput = {
  id: string;
  text: string;
  type: JiraType;
  severity: TriageSeverity;
  acceptType?: readonly JiraType[];
  acceptSeverity?: readonly TriageSeverity[];
  rationale: string;
  runs: NonNullable<Observation["jev"]>[];
  flags: string[];
};

/** Tune cases Jev missed (strict, any run) or answered at or under the bar on any answer. Holdout cases are never selected. */
export function critiqueInputs(cases: readonly JevTriageCase[], observations: readonly Observation[]): CritiqueInput[] {
  return cases.flatMap((item) => {
    if (item.holdout === true) return [];
    const runs = observations.filter((observation) => observation.caseId === item.id).flatMap((observation) => (observation.jev === undefined ? [] : [observation.jev]));
    const filed = observations.filter((observation) => observation.caseId === item.id).map((observation) => observation.severity);
    // A miss is outside the case's accepted answers, as the report scores it; a strict-only mismatch is not flagged.
    const flags = [
      ...(runs.some((run) => !typeOk(item, run.type)) ? ["type miss"] : []),
      ...(filed.some((severity) => severity !== undefined && !severityOk(item, severity)) ? ["severity miss"] : []),
      ...(runs.some((run) => run.typeProbability <= JEV_THRESHOLD) ? ["type unsure"] : []),
      ...(runs.some((run) => run.severityProbability <= JEV_THRESHOLD) ? ["severity unsure"] : []),
      ...(runs.some((run) => run.gateProbability <= JEV_THRESHOLD) ? ["gate unsure"] : []),
    ];
    if (flags.length === 0 || runs.length === 0) return [];
    return [
      {
        id: item.id,
        text: item.text,
        type: item.type,
        severity: item.severity,
        ...(item.accept?.type === undefined ? {} : { acceptType: item.accept.type }),
        ...(item.accept?.severity === undefined ? {} : { acceptSeverity: item.accept.severity }),
        rationale: item.rationale,
        runs,
        flags,
      },
    ];
  });
}

/** The first JSON array in the model's text (tolerates a code fence or a stray sentence). */
export function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`no JSON array in the judge's answer: ${text.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("the judge's answer is not an array");
  return parsed;
}

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((item) => item.toLowerCase() === asString(value).toLowerCase());
const listOf = <T extends string>(values: readonly T[], value: unknown): T[] => (Array.isArray(value) ? value.flatMap((item) => oneOf(values, item) ?? []) : []);

export function readLabels(raw: readonly unknown[]): JudgeLabel[] {
  return raw.flatMap((entry) => {
    const row = asRecord(entry);
    const type = oneOf(TYPES, row.type);
    const severity = oneOf(SEVERITIES, row.severity);
    const id = asString(row.id);
    if (id === "" || type === undefined || severity === undefined) return [];
    return [{ id, type, severity, alsoType: listOf(TYPES, row.alsoType).filter((item) => item !== type), alsoSeverity: listOf(SEVERITIES, row.alsoSeverity).filter((item) => item !== severity), rationale: asString(row.rationale) }];
  });
}

export function readCritiques(raw: readonly unknown[]): JevCritique[] {
  return raw.flatMap((entry) => {
    const row = asRecord(entry);
    const id = asString(row.id);
    if (id === "") return [];
    return [
      {
        id,
        verdict: oneOf(["jev_wrong", "label_wrong", "ambiguous"] as const, row.verdict) ?? "ambiguous",
        weakAnswer: oneOf(["type", "severity", "gate"] as const, row.weakAnswer) ?? "type",
        why: asString(row.why),
        target: asString(row.target) || "none",
        change: asString(row.change),
        generalises: row.generalises === true,
        generalisesWhy: asString(row.generalisesWhy),
      },
    ];
  });
}

export function labelAgreement(cases: readonly JevTriageCase[], labels: readonly JudgeLabel[]): LabelAgreement {
  const byId = new Map(labels.map((label) => [label.id, label]));
  const disagreements: LabelDisagreement[] = [];
  const missing: string[] = [];
  let typeStrict = 0;
  let typeLenient = 0;
  let severityStrict = 0;
  let severityLenient = 0;
  for (const item of cases) {
    const label = byId.get(item.id);
    if (label === undefined) {
      missing.push(item.id);
      continue;
    }
    const fields = [
      { field: "type" as const, ours: item.type as string, accepted: [item.type, ...(item.accept?.type ?? [])] as string[], judge: label.type as string, also: label.alsoType as string[] },
      { field: "severity" as const, ours: item.severity as string, accepted: [item.severity, ...(item.accept?.severity ?? [])] as string[], judge: label.severity as string, also: label.alsoSeverity as string[] },
    ];
    for (const { field, ours, accepted, judge, also } of fields) {
      const strict = judge === ours;
      const lenient = accepted.includes(judge) || also.includes(ours);
      if (field === "type") {
        typeStrict += strict ? 1 : 0;
        typeLenient += lenient ? 1 : 0;
      } else {
        severityStrict += strict ? 1 : 0;
        severityLenient += lenient ? 1 : 0;
      }
      if (!strict) disagreements.push({ id: item.id, field, ours, oursAccepted: accepted, judge, judgeAlso: also, hard: !lenient, rationale: label.rationale });
    }
  }
  const labelled = cases.length - missing.length;
  const ratio = (value: number) => (labelled === 0 ? 0 : value / labelled);
  return {
    cases: cases.length,
    labelled,
    type: { strict: ratio(typeStrict), lenient: ratio(typeLenient) },
    severity: { strict: ratio(severityStrict), lenient: ratio(severityLenient) },
    disagreements,
    missing,
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function inParallel<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await task(items[index]!);
      }
    })
  );
  return out;
}

/** Asks, parses, and retries once; a batch that still fails is reported, not thrown, so one bad answer does not lose the run. */
async function askArray(call: JudgeCall, prompt: string): Promise<unknown[] | undefined> {
  for (const attempt of [prompt, `${prompt}\n\nReturn only the JSON array.`]) {
    try {
      return parseJsonArray(await call(attempt));
    } catch (error) {
      process.stderr.write(`judge batch failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return undefined;
}

export async function judgeLabels(cases: readonly JevTriageCase[], call: JudgeCall, options: { batch?: number; concurrency?: number } = {}): Promise<{ labels: JudgeLabel[]; agreement: LabelAgreement }> {
  const batches = chunks(cases, options.batch ?? 8);
  const answers = await inParallel(batches, options.concurrency ?? 4, async (batch) => {
    const byNumber = new Map(batch.map((item, index) => [`c${index + 1}`, item.id]));
    return readLabels((await askArray(call, labelPrompt(batch))) ?? []).flatMap((label) => {
      const id = byNumber.get(label.id);
      return id === undefined ? [] : [{ ...label, id }];
    });
  });
  const labels = answers.flat();
  return { labels, agreement: labelAgreement(cases, labels) };
}

export async function judgeJev(cases: readonly JevTriageCase[], observations: readonly Observation[], call: JudgeCall, options: { batch?: number; concurrency?: number } = {}): Promise<NonNullable<JudgeResult["critiques"]>> {
  const inputs = critiqueInputs(cases, observations);
  const batches = chunks(inputs, options.batch ?? 6);
  const answers = await inParallel(batches, options.concurrency ?? 4, async (batch) => readCritiques((await askArray(call, critiquePrompt(batch))) ?? []));
  const items = answers.flat();
  const answered = new Set(items.map((item) => item.id));
  let synthesis = "";
  if (items.some((item) => item.generalises)) {
    try {
      synthesis = (await call(synthesisPrompt(items))).trim();
    } catch (error) {
      process.stderr.write(`judge synthesis failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return { items, asked: inputs.map((input) => input.id), failed: inputs.map((input) => input.id).filter((id) => !answered.has(id)), synthesis };
}

/** The live call: a Cursor SDK local agent with no tools, on Claude Opus 5.5 at low effort. */
export function cursorJudge(apiKey: string, model: { id: string; params?: ReadonlyArray<{ id: string; value: string }> } = JUDGE_MODEL): JudgeCall {
  const cwd = mkdtempSync(join(tmpdir(), "jev-judge-"));
  return async (prompt) => {
    const { Agent } = await import("@cursor/sdk");
    const result = await Agent.prompt(prompt, { apiKey, model: { id: model.id, params: [...(model.params ?? [])] }, local: { cwd }, tools: [] });
    if (result.status !== "finished") throw new Error(`judge run ${result.status}: ${result.error?.message ?? "no result"}`);
    return result.result ?? "";
  };
}

export function renderJudge(result: JudgeResult): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [`## Judge (${result.model.id}, effort ${result.model.params[0].value}, via @cursor/sdk)`, ""];
  if (result.labels !== undefined) {
    const { agreement } = result.labels;
    lines.push(
      `Label check, blind to our labels: ${agreement.labelled} of ${agreement.cases} cases labelled.`,
      "",
      "| Agreement with the hand labels | Strict | Lenient (either side's accepted alternates) |",
      "| --- | ---: | ---: |",
      `| Type | ${pct(agreement.type.strict)} | ${pct(agreement.type.lenient)} |`,
      `| Severity | ${pct(agreement.severity.strict)} | ${pct(agreement.severity.lenient)} |`,
      ""
    );
    const hard = agreement.disagreements.filter((item) => item.hard);
    lines.push(hard.length === 0 ? "No hard disagreements." : "Hard disagreements (the judge's answer is outside our accepted set, and ours outside its defensible set):", "");
    for (const item of hard) lines.push(`- \`${item.id}\` ${item.field}: ours ${item.oursAccepted.join("/")}, judge ${[item.judge, ...item.judgeAlso].join("/")}. ${item.rationale}`);
    const soft = agreement.disagreements.filter((item) => !item.hard);
    if (soft.length > 0) lines.push("", `Soft disagreements (inside an accepted alternate): ${soft.map((item) => `\`${item.id}\` ${item.field} ${item.ours}→${item.judge}`).join(", ")}.`);
    if (agreement.missing.length > 0) lines.push("", `Not labelled: ${agreement.missing.join(", ")}.`);
    lines.push("");
  }
  if (result.critiques !== undefined) {
    const { items, asked, failed, synthesis } = result.critiques;
    lines.push(`Jev critique: ${asked.length} tune cases with a miss or an answer at or under ${JEV_THRESHOLD} (holdout never critiqued).`, "");
    for (const item of items) lines.push(`- \`${item.id}\` (${item.verdict}, weakest: ${item.weakAnswer}${item.generalises ? ", general" : ", case-specific"}): ${item.why} → ${item.target}: ${item.change}`);
    if (failed.length > 0) lines.push("", `No critique returned: ${failed.join(", ")}.`);
    if (synthesis !== "") lines.push("", "Merged general suggestions:", "", synthesis);
    lines.push("");
  }
  return lines.join("\n");
}

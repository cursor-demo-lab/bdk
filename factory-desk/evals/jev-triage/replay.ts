import type { HostKvApi, HostMcpRegistry, JsonValue } from "@cursor/july";
import { intakeText, triageIntake, type FallbackReason, type IntakeTriage } from "../../agent/lib/intake-triage.js";
import { aboveBar, calibrateSeverity, issueText, probabilityOf, typeContradicted, type JevAnswers } from "../../agent/lib/jev-triage.js";
import type { TriageSeverity } from "../../agent/lib/triage-verdict.js";
import { EVAL_ISSUE_TYPES, EVAL_PROJECT, type JevTriageCase } from "./cases.js";

// Replays eval cases through the desk's real triageIntake: the same request
// parsing, the same one Jev call (jev-triage.ts askTriageJev), the same
// fast-exit bar and severity guard. Only the host surfaces are stubbed: kv
// holds the project's issue-type list (as the tracker would have cached it)
// and the MCP registry lists no connection. `fetch` reaches TypeSafe live in
// run.ts and is a stub in the unit tests.

/** The desk's Slack user as a filing request's leading mention. */
export const DESK_MENTION = "<@U0EXAMPLE2>";

const SEVERITIES: readonly TriageSeverity[] = ["low", "medium", "high", "urgent"];

export type Observation = {
  caseId: string;
  run: number;
  /** `jev`: Jev's answers cleared the bar and triage was Jev's alone; `model`: the fallback turn triages. */
  by: IntakeTriage["by"];
  reason?: FallbackReason;
  /** Jev's own answers, whether or not they cleared the bar. Absent when Jev did not answer. */
  jev?: {
    type: string;
    typeProbability: number;
    /** Jev's severity before the host guard. */
    severity: string;
    severityProbability: number;
    gate: string;
    gateProbability: number;
    /** The lowest of the three: what the desk shows as "% confidence". */
    confidence: number;
  };
  /** Jev's severity through calibrateSeverity: what the desk files when Jev's triage stands. */
  severity?: TriageSeverity;
  /** The Jira type the ticket is created with whatever the fallback says: Jev's, when its type answer cleared the bar. */
  ticketType?: string;
  ms: number;
};

export function memoryKv(seed: Record<string, JsonValue> = {}): HostKvApi {
  const rows = new Map<string, JsonValue>(Object.entries(seed));
  return {
    get: async (key) => rows.get(key),
    put: async (key, value) => void rows.set(key, value),
    delete: async (key) => void rows.delete(key),
  };
}

/** A kv already holding the eval project's issue types, as projectIssueTypes caches them. */
export function projectTypesKv(types: ReadonlyArray<{ name: string; id?: string }> = EVAL_ISSUE_TYPES): HostKvApi {
  return memoryKv({ [`triage-issue-types/${EVAL_PROJECT}`]: { exp: Date.now() + 24 * 60 * 60 * 1000, types: types.map((type) => ({ ...type })) } });
}

export const NO_CONNECTIONS = {
  names: () => [],
  listTools: async () => [],
  callTool: async () => {
    throw new Error("the eval registry has no connections");
  },
} as unknown as HostMcpRegistry;

export function slackText(item: Pick<JevTriageCase, "text">): string {
  return `${DESK_MENTION} ${item.text}`;
}

/** One case through triageIntake, once. Never throws: triageIntake does not. */
export async function replayCase(item: JevTriageCase, options: { apiKey: string; run?: number; fetch?: typeof globalThis.fetch; timeoutMs?: number; types?: ReadonlyArray<{ name: string; id?: string }> }): Promise<Observation> {
  const started = Date.now();
  const text = slackText(item);
  const triage = await triageIntake({
    text,
    mcp: NO_CONNECTIONS,
    kv: projectTypesKv(options.types),
    env: { TYPESAFE_API_KEY: options.apiKey, FACTORY_DESK_JIRA_PROJECT: EVAL_PROJECT },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return observe(item, triage, text, { run: options.run ?? 1, ms: Date.now() - started });
}

export function observe(item: Pick<JevTriageCase, "id">, triage: IntakeTriage, text: string, { run, ms }: { run: number; ms: number }): Observation {
  const base = { caseId: item.id, run, by: triage.by, ms, ...(triage.by === "model" ? { reason: triage.reason } : {}) };
  const answers: JevAnswers | undefined = triage.jev?.answers;
  if (answers === undefined) return base;
  const typeProbability = probabilityOf(answers.issueType);
  const severityProbability = probabilityOf(answers.severity);
  const gateProbability = probabilityOf(answers.gate);
  const jev = {
    type: answers.issueType.choice,
    typeProbability,
    severity: answers.severity.choice,
    severityProbability,
    gate: answers.gate.choice,
    gateProbability,
    confidence: Math.min(typeProbability, severityProbability, gateProbability),
  };
  const raw = answers.severity.choice as TriageSeverity;
  const words = issueText(intakeText(text));
  const severity = triage.by === "jev" ? triage.severity : SEVERITIES.includes(raw) ? calibrateSeverity({ text: words, type: jev.type, severity: raw }) : undefined;
  // What file_ticket creates the ticket as before the model has a say: Jev's type when it cleared the bar and the type guard let it stand.
  const ticketType = triage.by === "jev" || (aboveBar(typeProbability) && !typeContradicted({ text: words, type: jev.type })) ? jev.type : undefined;
  return { ...base, jev, ...(severity === undefined ? {} : { severity }), ...(ticketType === undefined ? {} : { ticketType }) };
}

/** Runs `task` over `items` with at most `limit` in flight, keeping order. */
export async function pool<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// ---- Scoring (pure) ----

export type Confusion = Record<string, Record<string, number>>;

export type Miss = { caseId: string; expected: string; got: Record<string, number>; runs: number; rationale: string };

export type EvalReport = {
  cases: number;
  runs: number;
  observations: number;
  answered: number;
  fallback: { count: number; rate: number; reasons: Record<string, number> };
  type: { accuracy: number; strict: number; confusion: Confusion; misses: Miss[] };
  severity: { accuracy: number; strict: number; raw: number; confusion: Confusion; misses: Miss[] };
  clearBug: { observations: number; asStory: number; asTask: number; accuracy: number };
  /** Accuracy of what lands on the ticket without the fallback model: the fast-exit triage and a confident Jev type. */
  fastExit: { observations: number; typeAccuracy: number; severityAccuracy: number };
  confidence: { buckets: Record<string, number>; median: number; p10: number; typeMedian: number; severityMedian: number; gateMedian: number };
  variance: { typeFlips: string[]; severityFlips: string[] };
  latencyMs: { median: number; p90: number };
};

export const CONFIDENCE_BUCKETS: ReadonlyArray<{ label: string; max: number }> = [
  { label: "≤0.52 (fallback)", max: 0.52 },
  { label: "0.52–0.60", max: 0.6 },
  { label: "0.60–0.70", max: 0.7 },
  { label: "0.70–0.80", max: 0.8 },
  { label: "0.80–0.90", max: 0.9 },
  { label: "0.90–1.00", max: 1.0001 },
];

export function typeOk(item: JevTriageCase, got: string | undefined): boolean {
  return got !== undefined && (got === item.type || (item.accept?.type ?? []).some((type) => type === got));
}

export function severityOk(item: JevTriageCase, got: string | undefined): boolean {
  return got !== undefined && (got === item.severity || (item.accept?.severity ?? []).some((severity) => severity === got));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]!;
}

function bump(table: Confusion, row: string, column: string): void {
  (table[row] ??= {})[column] = (table[row]![column] ?? 0) + 1;
}

export function scoreRuns(cases: readonly JevTriageCase[], observations: readonly Observation[]): EvalReport {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const answered = observations.filter((observation) => observation.jev !== undefined);
  const typeConfusion: Confusion = {};
  const severityConfusion: Confusion = {};
  let typeRight = 0;
  let typeStrict = 0;
  let severityRight = 0;
  let severityStrict = 0;
  let severityRaw = 0;
  let clearBug = 0;
  let clearBugRight = 0;
  let asStory = 0;
  let asTask = 0;
  let fast = 0;
  let fastType = 0;
  let fastSeverity = 0;
  const reasons: Record<string, number> = {};
  for (const observation of observations) {
    if (observation.by === "model") reasons[observation.reason ?? "unknown"] = (reasons[observation.reason ?? "unknown"] ?? 0) + 1;
  }
  for (const observation of answered) {
    const item = byId.get(observation.caseId);
    if (item === undefined) continue;
    const jev = observation.jev!;
    bump(typeConfusion, item.type, jev.type);
    bump(severityConfusion, item.severity, observation.severity ?? "none");
    if (typeOk(item, jev.type)) typeRight++;
    if (jev.type === item.type) typeStrict++;
    if (severityOk(item, observation.severity)) severityRight++;
    if (observation.severity === item.severity) severityStrict++;
    if (severityOk(item, jev.severity)) severityRaw++;
    if (item.clearBug === true) {
      clearBug++;
      if (jev.type === "Bug") clearBugRight++;
      if (jev.type === "Story") asStory++;
      if (jev.type === "Task") asTask++;
    }
    if (observation.ticketType !== undefined) {
      fast++;
      if (typeOk(item, observation.ticketType)) fastType++;
      if (observation.by === "jev" && severityOk(item, observation.severity)) fastSeverity++;
    }
  }
  const fastSeverityTotal = answered.filter((observation) => observation.by === "jev").length;
  const buckets: Record<string, number> = Object.fromEntries(CONFIDENCE_BUCKETS.map((bucket) => [bucket.label, 0]));
  for (const observation of answered) {
    const bucket = CONFIDENCE_BUCKETS.find((candidate) => observation.jev!.confidence <= candidate.max) ?? CONFIDENCE_BUCKETS.at(-1)!;
    buckets[bucket.label]!++;
  }
  const grouped = new Map<string, Observation[]>();
  for (const observation of answered) grouped.set(observation.caseId, [...(grouped.get(observation.caseId) ?? []), observation]);
  const typeFlips: string[] = [];
  const severityFlips: string[] = [];
  const typeMisses: Miss[] = [];
  const severityMisses: Miss[] = [];
  for (const item of cases) {
    const runs = grouped.get(item.id) ?? [];
    if (new Set(runs.map((observation) => observation.jev!.type)).size > 1) typeFlips.push(item.id);
    if (new Set(runs.map((observation) => observation.severity)).size > 1) severityFlips.push(item.id);
    const types = tally(runs.map((observation) => observation.jev!.type));
    const severities = tally(runs.map((observation) => observation.severity ?? "none"));
    if (runs.some((observation) => !typeOk(item, observation.jev!.type))) typeMisses.push({ caseId: item.id, expected: expected(item.type, item.accept?.type), got: types, runs: runs.length, rationale: item.rationale });
    if (runs.some((observation) => !severityOk(item, observation.severity))) severityMisses.push({ caseId: item.id, expected: expected(item.severity, item.accept?.severity), got: severities, runs: runs.length, rationale: item.rationale });
  }
  const confidences = answered.map((observation) => observation.jev!.confidence);
  const runs = Math.max(0, ...observations.map((observation) => observation.run));
  return {
    cases: cases.length,
    runs,
    observations: observations.length,
    answered: answered.length,
    fallback: { count: observations.filter((observation) => observation.by === "model").length, rate: ratio(observations.filter((observation) => observation.by === "model").length, observations.length), reasons },
    type: { accuracy: ratio(typeRight, answered.length), strict: ratio(typeStrict, answered.length), confusion: typeConfusion, misses: typeMisses },
    severity: { accuracy: ratio(severityRight, answered.length), strict: ratio(severityStrict, answered.length), raw: ratio(severityRaw, answered.length), confusion: severityConfusion, misses: severityMisses },
    clearBug: { observations: clearBug, asStory, asTask, accuracy: ratio(clearBugRight, clearBug) },
    fastExit: { observations: fast, typeAccuracy: ratio(fastType, fast), severityAccuracy: ratio(fastSeverity, fastSeverityTotal) },
    confidence: {
      buckets,
      median: quantile(confidences, 0.5),
      p10: quantile(confidences, 0.1),
      typeMedian: quantile(answered.map((observation) => observation.jev!.typeProbability), 0.5),
      severityMedian: quantile(answered.map((observation) => observation.jev!.severityProbability), 0.5),
      gateMedian: quantile(answered.map((observation) => observation.jev!.gateProbability), 0.5),
    },
    variance: { typeFlips, severityFlips },
    latencyMs: { median: quantile(observations.map((observation) => observation.ms), 0.5), p90: quantile(observations.map((observation) => observation.ms), 0.9) },
  };
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function expected(label: string, accept: readonly string[] | undefined): string {
  return accept === undefined || accept.length === 0 ? label : `${label} (or ${accept.join(", ")})`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function matrix(table: Confusion, rows: readonly string[], title: string): string[] {
  const columns = [...new Set([...rows, ...Object.values(table).flatMap((row) => Object.keys(row))])];
  return [
    `| ${title} | ${columns.join(" | ")} |`,
    `| --- | ${columns.map(() => "---:").join(" | ")} |`,
    ...rows.filter((row) => table[row] !== undefined).map((row) => `| **${row}** | ${columns.map((column) => String(table[row]?.[column] ?? 0)).join(" | ")} |`),
  ];
}

function gotText(got: Record<string, number>): string {
  return Object.entries(got)
    .map(([label, count]) => `${label}×${count}`)
    .join(", ");
}

/** The report as Markdown: headline numbers, both confusion matrices, confidence, variance, and every miss. */
export function renderReport(report: EvalReport, meta: { label: string; ref?: string; when: string; holdout?: EvalReport }): string {
  const { holdout } = meta;
  return [
    `# Jev triage eval: ${meta.label}`,
    "",
    `${meta.when}${meta.ref === undefined ? "" : ` · ${meta.ref}`} · ${report.cases} cases × ${report.runs} runs = ${report.observations} triageIntake calls (${report.answered} answered by Jev)`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Type accuracy (accepts ambiguous alternates) | ${percent(report.type.accuracy)} |`,
    `| Type accuracy, strict | ${percent(report.type.strict)} |`,
    `| Severity accuracy (after the host guard) | ${percent(report.severity.accuracy)} |`,
    `| Severity accuracy, strict | ${percent(report.severity.strict)} |`,
    `| Severity accuracy, Jev's raw answer | ${percent(report.severity.raw)} |`,
    `| Clear bugs typed Bug | ${percent(report.clearBug.accuracy)} (${report.clearBug.observations} runs; Story ${report.clearBug.asStory}, Task ${report.clearBug.asTask}) |`,
    `| Fallback to the model | ${percent(report.fallback.rate)} (${report.fallback.count}; ${Object.entries(report.fallback.reasons).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"}) |`,
    `| Ticket type set without the model (fast exit or confident type) | ${report.fastExit.observations} runs, ${percent(report.fastExit.typeAccuracy)} right |`,
    `| Fast-exit severity accuracy | ${percent(report.fastExit.severityAccuracy)} |`,
    `| Confidence (lowest answer) median / p10 | ${report.confidence.median.toFixed(2)} / ${report.confidence.p10.toFixed(2)} |`,
    `| Answer medians: type / severity / gate | ${report.confidence.typeMedian.toFixed(2)} / ${report.confidence.severityMedian.toFixed(2)} / ${report.confidence.gateMedian.toFixed(2)} |`,
    `| Latency median / p90 | ${report.latencyMs.median} ms / ${report.latencyMs.p90} ms |`,
    ...(holdout === undefined
      ? []
      : [`| Holdout (${holdout.cases} cases never tuned against): type / strict / severity | ${percent(holdout.type.accuracy)} / ${percent(holdout.type.strict)} / ${percent(holdout.severity.accuracy)} |`]),
    "",
    "## Type confusion (rows expected, columns Jev)",
    "",
    ...matrix(report.type.confusion, ["Bug", "Story", "Task"], "expected \\ Jev"),
    "",
    "## Severity confusion (rows expected, columns filed after the guard)",
    "",
    ...matrix(report.severity.confusion, SEVERITIES, "expected \\ filed"),
    "",
    "## Confidence distribution (lowest of type, severity, gate)",
    "",
    "| Bucket | Runs |",
    "| --- | ---: |",
    ...Object.entries(report.confidence.buckets).map(([label, count]) => `| ${label} | ${count} |`),
    "",
    "## Variance across runs",
    "",
    `- Type changed between runs: ${report.variance.typeFlips.length === 0 ? "none" : report.variance.typeFlips.join(", ")}`,
    `- Severity changed between runs: ${report.variance.severityFlips.length === 0 ? "none" : report.variance.severityFlips.join(", ")}`,
    "",
    "## Type misses",
    "",
    ...(report.type.misses.length === 0 ? ["None."] : report.type.misses.map((miss) => `- \`${miss.caseId}\`: expected ${miss.expected}, got ${gotText(miss.got)}. ${miss.rationale}`)),
    "",
    "## Severity misses",
    "",
    ...(report.severity.misses.length === 0 ? ["None."] : report.severity.misses.map((miss) => `- \`${miss.caseId}\`: expected ${miss.expected}, got ${gotText(miss.got)}.`)),
    "",
  ].join("\n");
}

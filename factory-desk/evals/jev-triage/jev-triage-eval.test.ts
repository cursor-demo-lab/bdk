import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { intakeText } from "../../agent/lib/intake-triage.js";
import { ISSUE_TYPE_CRITERIA, issueText, typeContradicted } from "../../agent/lib/jev-triage.js";
import { JEV_TRIAGE_CASES, TUNE_CASES, type JevTriageCase } from "./cases.js";
import { HOLDOUT_CASES } from "./holdout.js";
import { observe, pool, renderReport, replayCase, scoreRuns, severityOk, typeOk, type Observation } from "./replay.js";

// CI-safe layer of the Jev triage eval: no TypeSafe key, no network. The
// live numbers come from `npm run eval:jev-triage` (run.ts).

const TYPES = ["Bug", "Story", "Task"];
const SEVERITIES = ["low", "medium", "high", "urgent"];

// Changing holdout.ts means writing a new holdout, not tuning this one:
// update the hash only with a fresh, never-run set.
const HOLDOUT_SHA256 = "64fab86854faee657a637f5cbbcaf1f57b0743fe199154304ecf345f6637e6b7";

type Sent = { url: string; body: { state: unknown; questions: Record<string, { instructions: string; criteria: Record<string, string> }> } };

function jevStub(answer: { type: string; typeP?: number; severity?: string; severityP?: number; gate?: string; gateP?: number }, sent: Sent[] = []): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const choice = (value: string, p: number) => ({ choice: value, probabilities: { [value]: p } });
    return new Response(
      JSON.stringify({
        answers: {
          issueType: choice(answer.type, answer.typeP ?? 0.9),
          severity: choice(answer.severity ?? "medium", answer.severityP ?? 0.9),
          gate: choice(answer.gate ?? "proceed", answer.gateP ?? 0.9),
        },
      }),
      { status: 200 }
    );
  }) as typeof globalThis.fetch;
}

const item = (id: string): JevTriageCase => JEV_TRIAGE_CASES.find((candidate) => candidate.id === id)!;

test("the eval set: at least 40 tune and 15 holdout cases, unique ids, only Bug, Story, or Task, a rationale each", () => {
  assert.ok(TUNE_CASES.length >= 40, `${TUNE_CASES.length} tune cases`);
  assert.ok(HOLDOUT_CASES.length >= 15, `${HOLDOUT_CASES.length} holdout cases`);
  assert.equal(new Set(JEV_TRIAGE_CASES.map((c) => c.id)).size, JEV_TRIAGE_CASES.length);
  for (const c of JEV_TRIAGE_CASES) {
    assert.ok(TYPES.includes(c.type), `${c.id} type ${c.type}`);
    assert.ok(SEVERITIES.includes(c.severity), `${c.id} severity`);
    for (const type of c.accept?.type ?? []) assert.ok(TYPES.includes(type) && type !== c.type, `${c.id} accept type ${type}`);
    for (const severity of c.accept?.severity ?? []) assert.ok(SEVERITIES.includes(severity) && severity !== c.severity, `${c.id} accept severity ${severity}`);
    assert.ok(c.rationale.trim().length >= 8, `${c.id} rationale`);
    assert.ok(c.text.trim().length > 0, `${c.id} text`);
    if (c.clearBug === true) assert.equal(c.type, "Bug", `${c.id} is a clear bug`);
    if (c.clearBug === true) assert.equal(c.accept?.type, undefined, `${c.id}: a clear bug accepts no other type`);
  }
});

test("the eval set carries the real runs: TLSSN-42, TLSSN-43, and both Test B requests", () => {
  assert.equal(item("tlssn-43-tokens-dispatched-note").type, "Bug");
  assert.equal(item("tlssn-43-tokens-dispatched-note").clearBug, true);
  assert.equal(item("tlssn-42-transfer-reference-60").type, "Bug");
  assert.equal(item("test-b-logout-half-filled-transfer").type, "Story");
  assert.ok(!["high", "urgent"].includes(item("test-b-logout-half-filled-transfer").severity), "a half-filled form is not data loss");
  assert.equal(item("test-b-card-expiry-month").type, "Story");
});

test("the eval set spreads over types, severities, and categories", () => {
  for (const type of TYPES) assert.ok(JEV_TRIAGE_CASES.filter((c) => c.type === type).length >= 8, type);
  for (const severity of SEVERITIES) assert.ok(JEV_TRIAGE_CASES.some((c) => c.severity === severity), severity);
  for (const category of ["bug", "story", "task", "question", "ambiguous", "incident", "form-input"]) assert.ok(JEV_TRIAGE_CASES.some((c) => c.category === category), category);
  assert.ok(JEV_TRIAGE_CASES.filter((c) => c.clearBug === true).length >= 30);
});

test("the holdout is frozen: flagged in holdout.ts only, and holdout.ts matches its pinned hash", () => {
  assert.ok(HOLDOUT_CASES.every((c) => c.holdout === true));
  assert.ok(TUNE_CASES.every((c) => c.holdout !== true));
  const text = readFileSync(new URL("./holdout.ts", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"), HOLDOUT_SHA256);
});

test("replay goes through triageIntake: one TypeSafe call offering exactly Bug, Story, and Task with the sharpened criteria", async () => {
  const sent: Sent[] = [];
  const observation = await replayCase(item("tlssn-43-tokens-dispatched-note"), {
    apiKey: "test-key",
    fetch: jevStub({ type: "Bug", severity: "medium" }, sent),
    types: [{ name: "Epic" }, { name: "Subtask" }, { name: "Task" }, { name: "Story" }, { name: "Bug" }],
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.url, /\/systemone$/);
  const question = sent[0]!.body.questions.issueType!;
  assert.deepEqual(Object.keys(question.criteria).sort(), ["Bug", "Story", "Task"]);
  assert.equal(question.criteria.Bug, ISSUE_TYPE_CRITERIA.Bug);
  assert.match(question.instructions, /what exists today/);
  assert.match(question.criteria.Bug!, /could it show X\?/);
  assert.match(question.criteria.Story!, /Not a Story when something that exists today is broken/);
  assert.deepEqual(
    { by: observation.by, type: observation.jev?.type, severity: observation.severity, ticket: observation.ticketType },
    { by: "jev", type: "Bug", severity: "medium", ticket: "Bug" }
  );
});

test("with no Story type, Task's criterion takes new capabilities", async () => {
  const sent: Sent[] = [];
  await replayCase(item("payee-nicknames"), { apiKey: "k", fetch: jevStub({ type: "Task" }, sent), types: [{ name: "Bug" }, { name: "Task" }] });
  const criteria = sent[0]!.body.questions.issueType!.criteria;
  assert.deepEqual(Object.keys(criteria).sort(), ["Bug", "Task"]);
  assert.match(criteria.Task!, /new capability/);
});

test("replay records the fallback: below the bar, the type guard, and a TypeSafe failure", async () => {
  const below = await replayCase(item("payee-nicknames"), { apiKey: "k", fetch: jevStub({ type: "Story", severityP: 0.5 }) });
  assert.deepEqual({ by: below.by, reason: below.reason, ticket: below.ticketType }, { by: "model", reason: "below_bar", ticket: "Story" });

  // TLSSN-43 read as a Story: the words say something the user typed is not shown, so Jev's type is held back.
  const guarded = await replayCase(item("tlssn-43-tokens-dispatched-note"), { apiKey: "k", fetch: jevStub({ type: "Story", typeP: 0.95 }) });
  assert.deepEqual({ by: guarded.by, reason: guarded.reason, ticket: guarded.ticketType }, { by: "model", reason: "type_guard", ticket: undefined });

  const down = await replayCase(item("payee-nicknames"), {
    apiKey: "k",
    fetch: (async () => {
      throw new Error("TypeSafe down");
    }) as typeof globalThis.fetch,
  });
  assert.deepEqual({ by: down.by, reason: down.reason, jev: down.jev }, { by: "model", reason: "unavailable", jev: undefined });
});

test("replay files the severity the host guard leaves: a half-filled transfer is never urgent", async () => {
  const observation = await replayCase(item("test-b-logout-half-filled-transfer"), { apiKey: "k", fetch: jevStub({ type: "Story", severity: "urgent" }) });
  assert.equal(observation.jev?.severity, "urgent");
  assert.equal(observation.severity, "medium");
});

test("replay keeps Jev's severity on a Bug the guard has no evidence on", async () => {
  const observation = await replayCase(item("statement-pdf-blank"), { apiKey: "k", fetch: jevStub({ type: "Bug", severity: "urgent" }) });
  assert.equal(observation.by, "jev");
  assert.equal(observation.severity, "urgent");
});

test("the type guard holds back no Story or Task in the eval set, and catches TLSSN-43", () => {
  for (const c of JEV_TRIAGE_CASES.filter((candidate) => candidate.type !== "Bug" && !(candidate.accept?.type ?? []).includes("Bug"))) {
    assert.equal(typeContradicted({ text: issueText(intakeText(c.text)), type: c.type }), false, c.id);
  }
  assert.equal(typeContradicted({ text: issueText(intakeText(item("tlssn-43-tokens-dispatched-note").text)), type: "Story" }), true);
  assert.equal(typeContradicted({ text: issueText(intakeText(item("tlssn-43-tokens-dispatched-note").text)), type: "Bug" }), false);
});

function obs(caseId: string, run: number, type: string, severity: string, by: "jev" | "model" = "jev", confidence = 0.8): Observation {
  return {
    caseId,
    run,
    by,
    ...(by === "model" ? { reason: "below_bar" as const } : {}),
    jev: { type, typeProbability: 0.9, severity, severityProbability: confidence, gate: "proceed", gateProbability: 0.9, confidence },
    severity: severity as Observation["severity"] & string,
    ...(by === "jev" ? { ticketType: type } : {}),
    ms: 100,
  };
}

test("scoring: accuracy with and without accepted alternates, confusion, clear bugs typed Story, fallback, and flips", () => {
  const cases = [item("tlssn-43-tokens-dispatched-note"), item("tlssn-42-transfer-reference-60"), item("payee-nicknames")];
  const observations = [
    obs("tlssn-43-tokens-dispatched-note", 1, "Story", "medium"),
    obs("tlssn-43-tokens-dispatched-note", 2, "Bug", "medium"),
    obs("tlssn-42-transfer-reference-60", 1, "Story", "medium"),
    obs("tlssn-42-transfer-reference-60", 2, "Story", "medium"),
    obs("payee-nicknames", 1, "Story", "high", "model", 0.5),
    obs("payee-nicknames", 2, "Story", "low"),
  ];
  const report = scoreRuns(cases, observations);
  assert.equal(report.observations, 6);
  assert.equal(report.runs, 2);
  assert.equal(report.type.accuracy, 5 / 6);
  assert.equal(report.type.strict, 3 / 6);
  assert.deepEqual(report.type.confusion, { Bug: { Story: 3, Bug: 1 }, Story: { Story: 2 } });
  assert.equal(report.severity.accuracy, 5 / 6);
  assert.deepEqual(report.clearBug, { observations: 2, asStory: 1, asTask: 0, accuracy: 0.5 });
  assert.deepEqual(report.fallback, { count: 1, rate: 1 / 6, reasons: { below_bar: 1 } });
  assert.deepEqual(report.variance.typeFlips, ["tlssn-43-tokens-dispatched-note"]);
  assert.deepEqual(report.variance.severityFlips, ["payee-nicknames"]);
  assert.deepEqual(report.type.misses.map((miss) => miss.caseId), ["tlssn-43-tokens-dispatched-note"]);
  assert.equal(report.confidence.buckets["≤0.52 (fallback)"], 1);
  const markdown = renderReport(report, { label: "unit", when: "now" });
  for (const heading of ["## Type confusion", "## Severity confusion", "## Confidence distribution", "## Variance across runs", "## Type misses", "## Severity misses"]) assert.ok(markdown.includes(heading), heading);
});

test("typeOk and severityOk count accepted alternates, never a missing answer", () => {
  const c = item("tlssn-42-transfer-reference-60");
  assert.equal(typeOk(c, "Story"), true);
  assert.equal(typeOk(c, "Task"), false);
  assert.equal(typeOk(c, undefined), false);
  assert.equal(severityOk(c, "low"), true);
  assert.equal(severityOk(c, "urgent"), false);
});

test("observe without Jev's answers records only who triaged", () => {
  assert.deepEqual(observe({ id: "x" }, { by: "model", reason: "no_key" }, "text", { run: 1, ms: 5 }), { caseId: "x", run: 1, by: "model", ms: 5, reason: "no_key" });
});

test("pool keeps order and caps concurrency", async () => {
  let live = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 5));
    live--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2);
});

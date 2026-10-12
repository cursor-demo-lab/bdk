// The LLM judge's prompts, parsing, and scoring, with a stubbed call: no key,
// no network. The live judge runs only under `npm run eval:jev-triage -- --judge`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLDOUT_CASES } from "./holdout.js";
import { JEV_TRIAGE_CASES, type JevTriageCase } from "./cases.js";
import { critiqueInputs, critiquePrompt, JUDGE_MODEL, judgeJev, judgeLabels, labelAgreement, labelPrompt, parseJsonArray, readCritiques, readLabels, renderJudge, type JudgeCall } from "./judge.js";
import type { Observation } from "./replay.js";

const bug: JevTriageCase = { id: "b1", text: "Export returns 500 on an empty filter.", type: "Bug", severity: "medium", category: "bug", rationale: "a 500" };
const story: JevTriageCase = { id: "s1", text: "Could each card show its expiry?", type: "Story", severity: "low", accept: { severity: ["medium"] }, category: "story", rationale: "new" };
const jev = (type: string, p: number, severity = "medium", sp = 0.9, gp = 0.9) => ({ type, typeProbability: p, severity, severityProbability: sp, gate: "proceed", gateProbability: gp, confidence: Math.min(p, sp, gp) });
const seen = (caseId: string, answer: ReturnType<typeof jev>, severity = answer.severity): Observation => ({ caseId, run: 1, by: "jev", ms: 1, jev: answer, severity: severity as Observation["severity"] });

test("the judge runs on Claude Opus 5.5 at low effort", () => {
  assert.deepEqual(JUDGE_MODEL, { id: "claude-opus-5-5", params: [{ id: "effort", value: "low" }] });
});

test("the label prompt is blind: the reporter's words and the policy, never our labels or rationale", () => {
  const prompt = labelPrompt([bug, story]);
  assert.match(prompt, /<case id="c1">\nExport returns 500 on an empty filter\.\n<\/case>/);
  assert.doesNotMatch(prompt, /b1|s1/, "case ids name the expected answer, so they stay out");
  for (const item of JEV_TRIAGE_CASES) assert.ok(!labelPrompt([item]).includes(item.id), item.id);
  assert.match(prompt, /Bug: something that exists in the product today is broken/);
  assert.doesNotMatch(prompt, /a 500"|rationale": "a 500|"new"|Expected/);
  for (const item of JEV_TRIAGE_CASES) assert.doesNotMatch(labelPrompt([item]), new RegExp(item.rationale.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), item.id);
});

test("parseJsonArray takes the array out of a fenced or chatty answer and rejects prose", () => {
  assert.deepEqual(parseJsonArray('Here you go:\n```json\n[{"id":"b1"}]\n```'), [{ id: "b1" }]);
  assert.throws(() => parseJsonArray("I cannot label these."), /no JSON array/);
});

test("readLabels keeps only well-formed rows, normalises case, and drops its own answer from the alternates", () => {
  assert.deepEqual(readLabels([{ id: "b1", type: "bug", severity: "Medium", alsoType: ["Bug", "Story", "Epic"], alsoSeverity: [], rationale: " r " }, { id: "x", type: "Epic", severity: "low" }, "junk"]), [
    { id: "b1", type: "Bug", severity: "medium", alsoType: ["Story"], alsoSeverity: [], rationale: "r" },
  ]);
});

test("labelAgreement: strict, lenient through either side's alternates, hard disagreements, and missing cases", () => {
  const agreement = labelAgreement([bug, story], [
    { id: "b1", type: "Story", severity: "medium", alsoType: [], alsoSeverity: [], rationale: "judge thinks new" },
    // not s1
  ]);
  assert.equal(agreement.labelled, 1);
  assert.deepEqual(agreement.missing, ["s1"]);
  assert.equal(agreement.type.strict, 0);
  assert.equal(agreement.severity.strict, 1);
  assert.deepEqual(agreement.disagreements.map((item) => [item.id, item.field, item.hard]), [["b1", "type", true]]);
  const soft = labelAgreement([story], [{ id: "s1", type: "Story", severity: "medium", alsoType: [], alsoSeverity: [], rationale: "" }]);
  assert.equal(soft.severity.strict, 0);
  assert.equal(soft.severity.lenient, 1, "medium is in our accepted severities");
  assert.equal(soft.disagreements[0]!.hard, false);
});

test("critique inputs: tune misses and answers at or under the bar; never a holdout case, never a clean case", () => {
  const holdout = HOLDOUT_CASES[0]!;
  const inputs = critiqueInputs([bug, story, holdout], [
    seen("b1", jev("Story", 0.9)),
    seen("s1", jev("Story", 0.99, "low", 0.95)),
    seen(holdout.id, jev(holdout.type === "Bug" ? "Story" : "Bug", 0.4)),
  ]);
  assert.deepEqual(inputs.map((input) => [input.id, input.flags]), [["b1", ["type miss"]]]);
  const unsure = critiqueInputs([story], [seen("s1", jev("Story", 0.99, "low", 0.5))]);
  assert.deepEqual(unsure[0]!.flags, ["severity unsure"]);
  const prompt = critiquePrompt(inputs);
  assert.match(prompt, /Decide by what exists today/, "shows Jev's current type question");
  assert.match(prompt, /Expected: type Bug, severity medium/);
  assert.match(prompt, /type Story 0\.90/);
});

test("readCritiques defaults unknown verdicts and targets, and only an explicit true generalises", () => {
  assert.deepEqual(readCritiques([{ id: "b1", verdict: "??", weakAnswer: "severity", why: "w", target: "", change: "c", generalises: "yes" }]), [
    { id: "b1", verdict: "ambiguous", weakAnswer: "severity", why: "w", target: "none", change: "c", generalises: false, generalisesWhy: "" },
  ]);
});

test("judgeLabels and judgeJev batch the calls, retry once on a non-JSON answer, and synthesise only general suggestions", async () => {
  const prompts: string[] = [];
  let flaky = true;
  const call: JudgeCall = async (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith("You are labelling")) {
      if (flaky) {
        flaky = false;
        return "sorry";
      }
      const ids = [...prompt.matchAll(/<case id="([^"]+)">/g)].map((match) => match[1]);
      return JSON.stringify(ids.map((id) => ({ id, type: "Bug", severity: "medium", rationale: "x" })));
    }
    if (prompt.startsWith("Jev is a classifier")) return JSON.stringify([{ id: "b1", verdict: "jev_wrong", weakAnswer: "type", why: "soft wording", target: "type.Bug", change: "add X", generalises: true }]);
    return "1. type.Bug: add X";
  };
  const labels = await judgeLabels([bug, story], call, { batch: 1, concurrency: 1 });
  assert.equal(labels.labels.length, 2);
  assert.equal(prompts.filter((prompt) => prompt.startsWith("You are labelling")).length, 3, "two batches, one retried");
  assert.equal(labels.agreement.type.strict, 0.5);
  const critiques = await judgeJev([bug, story], [seen("b1", jev("Story", 0.9)), seen("s1", jev("Story", 0.99, "low"))], call);
  assert.deepEqual(critiques.asked, ["b1"]);
  assert.equal(critiques.synthesis, "1. type.Bug: add X");
  const markdown = renderJudge({ model: JUDGE_MODEL, labels, critiques });
  assert.match(markdown, /## Judge \(claude-opus-5-5, effort low, via @cursor\/sdk\)/);
  assert.match(markdown, /\| Type \| 50\.0% \|/);
  assert.match(markdown, /`s1` type: ours Story, judge Bug/);
  assert.match(markdown, /`b1` \(jev_wrong, weakest: type, general\): soft wording → type\.Bug: add X/);
});

test("a batch that fails twice, or throws, is reported as missing rather than aborting the run", async () => {
  const call: JudgeCall = async (prompt) => {
    if (prompt.includes("Export returns 500")) throw new Error("network down");
    if (prompt.startsWith("Jev is a classifier")) return "no json";
    const ids = [...prompt.matchAll(/<case id="([^"]+)">/g)].map((match) => match[1]);
    return JSON.stringify(ids.map((id) => ({ id, type: "Story", severity: "low", rationale: "x" })));
  };
  const labels = await judgeLabels([bug, story], call, { batch: 1 });
  assert.deepEqual(labels.agreement.missing, ["b1"]);
  assert.deepEqual(labels.labels.map((label) => label.id), ["s1"]);
  const critiques = await judgeJev([bug], [seen("b1", jev("Story", 0.9))], call);
  assert.deepEqual(critiques.failed, ["b1"]);
  assert.match(renderJudge({ model: JUDGE_MODEL, critiques }), /No critique returned: b1\./);
});

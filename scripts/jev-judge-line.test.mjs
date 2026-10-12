import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register("./ts-resolve.mjs", import.meta.url);

const { latestTriageVerdict } = await import("../factory-desk/agent/lib/triage-comment.ts");
const { JEV_THRESHOLD, judgeLine } = await import("../triage-jira/agent/lib/jev-triage.ts");
const { triageComment } = await import("../triage-jira/agent/lib/triage-verdict.ts");

// triage-jira's host Jev judge sets the Jira issue type and appends a Judge:
// line to the Triage: comment, after a Type: line. The desk reads both to
// tell the Slack thread the type and who set it. The planner's side is
// planner/agent/lib/jira-event.test.ts.

const verdict = { identifier: "TLSSN-42", kind: "bug", severity: "medium", title: "Export failed", summary: "Export 500 yesterday.", nextStep: "Inspect 9f2c." };
const judged = {
  status: "judged",
  source: "webhook",
  types: "project",
  type: { choice: "Bug", id: "10172", probability: 0.93, model: "question", confident: true, jira: "set", applied: true },
  severity: { choice: "medium", probability: 0.84, model: "low", applied: true },
  gate: { choice: "proceed", probability: 0.9, model: "proceed" },
};

test("the desk reads triage's Type: and Judge: lines when the judge set the Jira type", () => {
  assert.deepEqual(latestTriageVerdict([triageComment(verdict, undefined, judgeLine(judged), "Bug")]), {
    kind: "bug",
    severity: "medium",
    nextStep: "Inspect 9f2c.",
    issueType: "Bug",
    judgedOver: "question",
    jev: {
      type: { choice: "Bug", probability: "0.93", outcome: "set", model: "question" },
      severity: { choice: "medium", probability: "0.84", outcome: "applied", model: "low" },
    },
  });
});

test("every judgeLine shape triage writes reaches the desk's Triaged line as Jev's type and severity", () => {
  const cases = [
    [{ ...judged.type, model: "bug" }, "Bug", { choice: "Bug", probability: "0.93", outcome: "set" }],
    [{ ...judged.type, jira: "already", model: "bug" }, "Bug", { choice: "Bug", probability: "0.93", outcome: "already" }],
    [{ ...judged.type, jira: "failed", applied: false }, "Task", { choice: "Bug", probability: "0.93", outcome: "failed", model: "question" }],
    [{ ...judged.type, confident: false, jira: "not_written", applied: false, probability: 0.52 }, "Task", { choice: "Bug", probability: "0.52", outcome: "below", model: "question" }],
  ];
  for (const [type, issueType, expected] of cases) {
    const jev = latestTriageVerdict([triageComment(verdict, undefined, judgeLine({ ...judged, type }), issueType)])?.jev;
    assert.deepEqual(jev?.type, expected, JSON.stringify(type));
    assert.deepEqual(jev?.severity, { choice: "medium", probability: "0.84", outcome: "applied", model: "low" });
  }
  const kept = judgeLine({ ...judged, severity: { choice: "high", probability: 0.7, model: "low", applied: false } });
  assert.deepEqual(latestTriageVerdict([triageComment(verdict, undefined, kept, "Bug")])?.jev?.severity, { choice: "high", probability: "0.70", outcome: "kept", model: "low" });
});

test("agreement, a type already on the ticket, a failed edit, or no judge name no override", () => {
  const cases = [
    { type: { ...judged.type, model: "bug" }, issueType: "Bug" },
    { type: { ...judged.type, jira: "already", model: "bug" }, issueType: "Bug" },
    { type: { ...judged.type, jira: "failed", applied: false }, issueType: "Task" },
    { type: { ...judged.type, confident: false, jira: "not_written", applied: false, probability: 0.52 }, issueType: "Task" },
  ];
  for (const { type, issueType } of cases) {
    const read = latestTriageVerdict([triageComment(verdict, undefined, judgeLine({ ...judged, type }), issueType)]);
    assert.equal(read?.judgedOver, undefined, JSON.stringify(type));
    assert.equal(read?.issueType, issueType);
  }
  const plain = latestTriageVerdict([triageComment(verdict, undefined, judgeLine({ status: "skipped", reason: "no_key" }))]);
  assert.deepEqual(plain, { kind: "bug", severity: "medium", nextStep: "Inspect 9f2c." });
});

test("a Task the judge set over a model question is the desk's question gate", () => {
  const line = judgeLine({ ...judged, type: { ...judged.type, choice: "Task", id: "10170", model: "question" } });
  const read = latestTriageVerdict([triageComment({ ...verdict, kind: "question" }, undefined, line, "Task")]);
  assert.equal(read?.gate, "question");
  assert.equal(read?.issueType, "Task");
  assert.equal(read?.judgedOver, undefined, "Task keeps the model's question, so the kind did not change");
});

test("a Jev-only Judge: line (no model turn) reaches the desk as Jev's choice, never as agreement with triage", () => {
  const only = { ...judged, type: { ...judged.type, model: "bug" }, severity: { ...judged.severity, model: "medium", applied: false }, jevOnly: true };
  const line = judgeLine(only);
  assert.equal(line, "Judge: Jev type Bug 0.93 (set in Jira; Jev only); severity medium 0.84 (Jev only)");
  assert.deepEqual(latestTriageVerdict([triageComment(verdict, undefined, line, "Bug")])?.jev, {
    only: true,
    type: { choice: "Bug", probability: "0.93", outcome: "set" },
    severity: { choice: "medium", probability: "0.84", outcome: "only" },
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { withDeskTriaged } from "./desk-triaged.js";
import { latestTriageVerdict } from "./triage-comment.js";

// The cases the planner's status gate decides on (planner/agent/lib/jira-event.ts
// parseTriage, chain.ts decide). A gate here must be a skip there.

test("a bug or feedback verdict carries no gate, with its severity and next step", () => {
  assert.deepEqual(latestTriageVerdict(["Triage: bug\nSeverity: high\nSummary: CSV export 500.\nNext step: Fix the empty filter."]), {
    kind: "bug",
    severity: "high",
    nextStep: "Fix the empty filter.",
  });
  assert.deepEqual(latestTriageVerdict(["Triage: feedback, low. Wants a dark mode."]), { kind: "feedback", severity: "medium" });
  assert.deepEqual(latestTriageVerdict(["Triage: whatever\nSeverity: bogus"]), { kind: "bug", severity: "medium" });
});

test("needs info, a question, and a duplicate are the planner's three skips, in its order", () => {
  assert.equal(latestTriageVerdict(["Triage: bug\nNeeds info: which export?"])?.gate, "needs_info");
  assert.equal(latestTriageVerdict(["Triage: question\nSeverity: low"])?.gate, "question");
  assert.equal(latestTriageVerdict(["Triage: question\nNeeds info: which report?"])?.gate, "needs_info");
  assert.deepEqual(latestTriageVerdict(["Triage: bug\nSeverity: urgent\nDuplicate of: tlssn-19\nNeeds info: x"]), {
    kind: "bug",
    severity: "urgent",
    gate: "duplicate",
    duplicateOf: "TLSSN-19",
  });
  assert.deepEqual(latestTriageVerdict(["Triage: duplicate"]), { kind: "bug", severity: "medium", gate: "duplicate" });
  assert.equal(latestTriageVerdict(["Triage: bug\nNext step: close it, duplicate of: TLSSN-7"])?.gate, "duplicate");
});

test("the newest Triage: comment wins, and a duplicate-inbound note on the original is not its verdict", () => {
  assert.equal(latestTriageVerdict(["Triage: bug\nNeeds info: x", "Plan: TLSSN-42 Retry", "Triage: bug\nSeverity: low"])?.gate, undefined);
  assert.equal(latestTriageVerdict(["Triage: bug\nSeverity: low", "Triage: duplicate inbound TLSSN-43"])?.gate, undefined);
  assert.equal(latestTriageVerdict(["\uFEFF  Triage: question\r\nSeverity: low"])?.gate, "question");
});

test("a Detail from Slack: comment after a needs-info verdict answers it; it never lifts a question or a duplicate", () => {
  const detail = "Detail from Slack: TLSSN-42\nbob replied in the ticket's Slack thread after triage asked for more information:\n\nThe /reports/export page.";
  assert.deepEqual(latestTriageVerdict(["Triage: bug\nSeverity: low\nNext step: Name the page.\nNeeds info: Name the page.", detail]), {
    kind: "bug",
    severity: "low",
    nextStep: "Name the page.",
  });
  assert.equal(latestTriageVerdict([detail, "Triage: bug\nNeeds info: which page?"])?.gate, "needs_info");
  assert.equal(latestTriageVerdict(["Triage: question\nSeverity: low", detail])?.gate, "question");
  assert.equal(latestTriageVerdict(["Triage: bug\nDuplicate of: TLSSN-7", detail])?.gate, "duplicate");
  assert.equal(latestTriageVerdict(["Triage: bug\nNeeds info: which page?", "Someone: Detail from Slack: nope"])?.gate, "needs_info");
});

test("a ticket with no Triage: comment has no verdict", () => {
  assert.equal(latestTriageVerdict([]), undefined);
  assert.equal(latestTriageVerdict(["Plan: TLSSN-42 Retry", "see Triage: bug"]), undefined);
});

test("a Type: line names the Jira type; a Judge: line that set it names the triage model's kind", () => {
  const read = (lines: string) => latestTriageVerdict([`Triage: question\nType: Task\nSeverity: low\nNext step: Answer it.\n${lines}`]);
  assert.deepEqual(read("Judge: Jev type Task 0.91 (set in Jira; model said bug); severity low 0.88 (agreed)"), {
    kind: "question",
    severity: "low",
    gate: "question",
    nextStep: "Answer it.",
    issueType: "Task",
    judgedOver: "bug",
    jev: { type: { choice: "Task", probability: "0.91", outcome: "set", model: "bug" }, severity: { choice: "low", probability: "0.88", outcome: "agreed" } },
  });
  assert.equal(read("Judge: Jev type Task 0.95 (already Task in Jira; model said feedback); severity low 0.9 (agreed)")?.judgedOver, "feedback");
  assert.equal(read("Judge: Jev type Task 0.95 (set in Jira; agreed); severity low 0.9 (agreed)")?.judgedOver, undefined);
  assert.equal(read("Judge: Jev type Bug 0.93 (Jira edit failed, kept the model's question); severity low 0.9 (agreed)")?.judgedOver, undefined);
  assert.equal(read("Judge: Jev type Bug 0.6 (below 0.80, kept the model's question); severity low 0.9 (agreed)")?.issueType, "Task");
  // A Judge: line for another type than the ticket's Type: line is not believed.
  assert.equal(read("Judge: Jev type Bug 0.93 (set in Jira; model said question)")?.judgedOver, undefined);
  assert.equal(latestTriageVerdict(["Triage: bug\nSeverity: medium"])?.issueType, undefined);
  // A needs-info verdict's reason is the missing detail, not the type.
  assert.deepEqual(latestTriageVerdict(["Triage: bug\nType: Bug\nNeeds info: which page?"]), { kind: "bug", severity: "medium", gate: "needs_info" });
});

test("a Jev-only Judge: line reads as Jev's choice with no triage model to agree with", () => {
  const read = latestTriageVerdict(["Triage: bug\nType: Bug\nSeverity: medium\nSummary: x\nJudge: Jev type Bug 0.93 (set in Jira; Jev only); severity medium 0.84 (Jev only)"]);
  assert.deepEqual(read?.jev, { only: true, type: { choice: "Bug", probability: "0.93", outcome: "set" }, severity: { choice: "medium", probability: "0.84", outcome: "only" } });
  assert.equal(read?.judgedOver, undefined);
});

test("every Judge: line shape triage writes becomes Jev's type and severity, whatever the verdict", () => {
  const jev = (type: string, judge: string, rest = "") => latestTriageVerdict([`Triage: bug\nType: ${type}\nSeverity: medium\n${rest}${judge}`])?.jev;
  assert.deepEqual(jev("Bug", "Judge: Jev type Bug 1.00 (set in Jira; agreed); severity medium 0.66 (agreed)"), {
    type: { choice: "Bug", probability: "1.00", outcome: "set" },
    severity: { choice: "medium", probability: "0.66", outcome: "agreed" },
  });
  assert.deepEqual(jev("Bug", "Judge: Jev type Bug 0.95 (already Bug in Jira; model said question); severity high 0.84 (model said low)"), {
    type: { choice: "Bug", probability: "0.95", outcome: "already", model: "question" },
    severity: { choice: "high", probability: "0.84", outcome: "applied", model: "low" },
  });
  assert.deepEqual(jev("Task", "Judge: Jev type Bug 0.79 (below 0.80, kept the model's question); severity high 0.70 (kept the model's low, below 0.80)"), {
    type: { choice: "Bug", probability: "0.79", outcome: "below", model: "question" },
    severity: { choice: "high", probability: "0.70", outcome: "kept", model: "low" },
  });
  assert.deepEqual(jev("Task", "Judge: Jev type Bug 0.93 (Jira edit failed, kept the model's question); severity medium 0.9 (agreed)")?.type, {
    choice: "Bug",
    probability: "0.93",
    outcome: "failed",
    model: "question",
  });
  // The type guard held Jev's Story back: the ticket keeps the model's type.
  assert.deepEqual(jev("Bug", "Judge: Jev type Story 0.95 (held back: the report says something is broken now; kept the model's bug); severity medium 0.90 (agreed)")?.type, {
    choice: "Story",
    probability: "0.95",
    outcome: "below",
    model: "bug",
  });
  // A needs-info verdict still carries it: Jev's type is known before the planner.
  assert.equal(jev("Bug", "Judge: Jev type Bug 0.90 (set in Jira; agreed); severity medium 0.80 (agreed)", "Needs info: which page?\n")?.type?.outcome, "set");
  // A type Jev says it put on the ticket, but the ticket's Type: line disagrees, is not believed.
  assert.deepEqual(jev("Task", "Judge: Jev type Bug 0.93 (set in Jira; agreed); severity medium 0.9 (agreed)"), { severity: { choice: "medium", probability: "0.9", outcome: "agreed" } });
  assert.equal(jev("Bug", "Judge: Jev garbled"), undefined);
  assert.equal(latestTriageVerdict(["Triage: bug\nSeverity: medium"])?.jev, undefined);
});

test("on a ticket the desk triaged before filing, the desk's Triage: comment governs; a later second triage does not override it", () => {
  const desk = withDeskTriaged("Triage: bug\nType: Bug\nSeverity: medium\nSummary: Freeze card lacks aria-describedby.\nNext step: Add it.\nTriaged by: Jev (type, severity, and gate all above 0.52)");
  const second = "Triage: bug\nSeverity: medium\nDuplicate of: TLSSN-38\nTriaged by: model (Jev was not above 0.52 on every answer)";
  assert.deepEqual(latestTriageVerdict([desk, second]), latestTriageVerdict([desk]));
  assert.equal(latestTriageVerdict([desk, second])?.gate, undefined);
  assert.equal(latestTriageVerdict([desk, "Triage: question\nSeverity: low\nTriaged by: model (Jev was not above 0.52 on every answer)"])?.gate, undefined);
  assert.equal(latestTriageVerdict([desk, second, "Triage: question\nSeverity: low"])?.gate, "question", "a person's Triage: comment (no Triaged by: line) corrects the desk's verdict");
  assert.equal(latestTriageVerdict([second])?.gate, "duplicate", "without the desk's comment the newest still governs");

  const deskNeedsInfo = withDeskTriaged("Triage: bug\nSeverity: low\nNext step: Name the page.\nNeeds info: Name the page.");
  const detail = "Detail from Slack: TLSSN-42\nbob replied in the ticket's Slack thread after triage asked for more information:\n\nThe /reports/export page.";
  assert.equal(latestTriageVerdict([deskNeedsInfo, "Triage: bug\nNeeds info: x\nTriaged by: model (Jev was not above 0.52 on every answer)", detail])?.gate, undefined, "a Detail after the desk's needs-info answers it");
  assert.equal(latestTriageVerdict([detail, deskNeedsInfo])?.gate, "needs_info");
});

test("the Triaged by: line names the backup model and Jev's whole-percent confidence, and older lines still read", () => {
  const grok = latestTriageVerdict(["Triage: bug\nSeverity: high\nTriaged by: Grok 4.6 Fast (Jev was only 50% confident; not above 0.52 on every answer)"]);
  assert.equal(grok?.triagedBy, "model");
  assert.equal(grok?.triageModel, "Grok 4.6 Fast");
  assert.equal(grok?.confidence, 50);
  const jev = latestTriageVerdict(["Triage: bug\nSeverity: medium\nTriaged by: Jev (78% confidence; type, severity, and gate all above 0.52)"]);
  assert.deepEqual([jev?.triagedBy, jev?.triageModel, jev?.confidence], ["jev", undefined, 78]);
  const legacy = latestTriageVerdict(["Triage: bug\nSeverity: low\nTriaged by: model (Jev was not above 0.52 on every answer; Jev's 41% confidence)"]);
  assert.deepEqual([legacy?.triagedBy, legacy?.triageModel, legacy?.confidence], ["model", undefined, 41]);
  const unconfigured = latestTriageVerdict(["Triage: bug\nSeverity: low\nTriaged by: Grok 4.6 Fast (Jev is not configured)"]);
  assert.deepEqual([unconfigured?.triageModel, unconfigured?.confidence, unconfigured?.fallback], ["Grok 4.6 Fast", undefined, "no_key"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { CONSTRAINT_RULE, attemptFromEventId, attemptOf, continuationFor, decide, pinnedIssueKey, planPrompt, planRequestSchema } from "./chain.js";

test("a manual request or an actionable verdict is planned; question, needs-info, duplicate are not", () => {
  assert.deepEqual(decide(undefined), { plan: true });
  assert.deepEqual(decide({ kind: "bug", severity: "high" }), { plan: true });
  assert.deepEqual(decide({ kind: "feedback", severity: "low" }), { plan: true });
  assert.deepEqual(decide({ kind: "question", severity: "low" }), { plan: false, reason: "question" });
  assert.deepEqual(decide({ kind: "bug", severity: "high", needsInfo: true }), { plan: false, reason: "needs_info" });
  assert.deepEqual(decide({ kind: "bug", severity: "high", duplicateOf: "TLSSN-7" }), { plan: false, reason: "duplicate" });
  assert.deepEqual(decide({ kind: "bug", severity: "high", duplicateOf: "  " }), { plan: true });
});

test("the continuation key carries the attempt and pins back to the bare issue key", () => {
  assert.equal(continuationFor({ issueKey: "TLSSN-42", attempt: "32152" }), "issue:TLSSN-42#32152");
  assert.equal(pinnedIssueKey(continuationFor({ issueKey: "TLSSN-42", attempt: "32152" })), "TLSSN-42");
  assert.equal(pinnedIssueKey("cont:issue:TLSSN-42#32152"), "TLSSN-42");
  assert.equal(pinnedIssueKey("cont:issue:TLSSN-42#6f1c2b7a-0d3e-4c1a-9e2f-3a4b5c6d7e8f"), "TLSSN-42");
  assert.equal(pinnedIssueKey("issue:TLSSN-42#"), "TLSSN-42");
  assert.equal(pinnedIssueKey("issue:TLSSN-42#a#b"), "TLSSN-42");
  assert.equal(pinnedIssueKey("issue:#TLSSN-42"), undefined);
  assert.equal(pinnedIssueKey("issue:not-a-key#32152"), undefined);
  assert.equal(pinnedIssueKey("cont:TLSSN-42#32152"), undefined);
  assert.equal(pinnedIssueKey("issue:TLSSN-42"), "TLSSN-42");
  assert.equal(pinnedIssueKey("cont:issue:TLSSN-42"), "TLSSN-42");
  assert.equal(pinnedIssueKey("cont:TLSSN-42"), undefined);
  assert.equal(pinnedIssueKey("issue:not-a-key"), undefined);
  assert.equal(pinnedIssueKey("TLSSN-42"), undefined);
  assert.equal(pinnedIssueKey(null), undefined);
  assert.equal(pinnedIssueKey(undefined), undefined);
});

test("a named attempt is kept, a missing one is a fresh uuid, and the request schema refuses unsafe attempts", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.equal(attemptOf({ attempt: "req-1" }), "req-1");
  assert.match(attemptOf({}), uuid);
  assert.equal(attemptFromEventId("32152"), "32152");
  assert.equal(continuationFor({ issueKey: "TLSSN-42", attempt: attemptFromEventId("32152") }), "issue:TLSSN-42#32152");
  for (const id of ["a#b c", "weird#id with spaces", "", "x".repeat(65), "caf\u00e9"]) {
    assert.match(attemptFromEventId(id), uuid, JSON.stringify(id));
  }
  assert.equal(planRequestSchema.safeParse({ issueKey: "TLSSN-7", title: "x", attempt: "has spaces" }).success, false);
  assert.equal(planRequestSchema.safeParse({ issueKey: "TLSSN-7", title: "x", attempt: "slack:1790162034.086" }).success, true);
});

test("the first message names the ticket, the triage verdict, and the pin", () => {
  const request = planRequestSchema.parse({
    issueKey: "TLSSN-42",
    title: "CSV export returns 500",
    summary: "Export has failed since this morning.",
    verdict: { kind: "bug", severity: "high", nextStep: "Inspect request id 41ac." },
  });
  const prompt = planPrompt(request);
  assert.match(prompt, /^Plan TLSSN-42: CSV export returns 500\n/);
  assert.match(prompt, /Export has failed since this morning\./);
  assert.match(prompt, /Triage: bug, severity high\. Next step from triage: Inspect request id 41ac\./);
  assert.match(prompt, /pinned to the ticket above/);
  assert.doesNotMatch(prompt, /replan/);
  assert.equal(planRequestSchema.safeParse({ issueKey: "tlssn-42", title: "x" }).success, false);
});

test("a replan says so on the line after the title", () => {
  const prompt = planPrompt({ issueKey: "TLSSN-42", title: "CSV export returns 500" }, { replan: true });
  assert.equal(
    prompt,
    [
      "Plan TLSSN-42: CSV export returns 500",
      "",
      "replan: the ticket was sent back for a new plan. Replace the recorded plan.",
      "",
      "This session is pinned to the ticket above. Read it with read_ticket, then plan.",
      "",
      CONSTRAINT_RULE,
    ].join("\n")
  );
});

test("TLSSN-42: every plan prompt says the reporter's explicit constraints are binding", () => {
  for (const prompt of [planPrompt({ issueKey: "TLSSN-42", title: "Transfer reference counter" }), planPrompt({ issueKey: "TLSSN-42", title: "x" }, { replan: true })]) {
    assert.ok(prompt.endsWith(`\n\n${CONSTRAINT_RULE}`));
  }
  assert.match(CONSTRAINT_RULE, /verbatim/);
  assert.match(CONSTRAINT_RULE, /binding/);
  assert.match(CONSTRAINT_RULE, /Never propose changing what they said to keep/);
  assert.match(CONSTRAINT_RULE, /why\.preserve \(merge related ones into one line past 10\)/);
  assert.match(CONSTRAINT_RULE, /A later reporter reply that explicitly changes a constraint replaces it/);
  assert.match(CONSTRAINT_RULE, /plan within it and say so in risk and openQuestions; never override it/);
  assert.doesNotMatch(CONSTRAINT_RULE, /record_needs_info/, "Needs info is the sandbox-mismatch comment, not a constraint dispute");
});

test("the instructions carry the same rule, so a desk-requested plan (no plan prompt) is held to it too", () => {
  const instructions = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");
  assert.match(instructions, /## Reporter constraints/);
  assert.match(instructions, /Reporter's request, verbatim\s+from Slack:/);
  assert.match(instructions, /Never propose changing something they said\s+to keep/);
  assert.match(instructions, /A later reporter reply that explicitly changes a constraint replaces it/);
  assert.match(instructions, /merge related constraints into one line rather than\s+drop any/);
  assert.match(instructions, /why\.preserve/);
});

test("a reply to a Needs info is quoted in the prompt as part of the request", () => {
  const prompt = planPrompt({ issueKey: "TLSSN-29", title: "Payees", answer: "Add payees if missing.\nUse the transfers page." });
  assert.match(prompt, /answered the last Needs info/);
  assert.match(prompt, /^> Add payees if missing\.$/m);
  assert.match(prompt, /^> Use the transfers page\.$/m);
  assert.match(prompt, /plan that addition/);
  assert.doesNotMatch(planPrompt({ issueKey: "TLSSN-29", title: "Payees" }), /Needs info/);
});

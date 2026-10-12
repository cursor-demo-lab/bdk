import assert from "node:assert/strict";
import { test } from "node:test";
import { chainDecision } from "./plan-chain.js";

const acted = {
  verdict: {
    identifier: "TLSSN-42",
    kind: "bug",
    severity: "high",
    title: "CSV export returns 500",
    summary: "Export has failed since this morning.",
    nextStep: "Inspect request id 41ac.",
  },
  evaluatedAt: "2026-09-22T00:00:00.000Z",
  tracker: { status: "acted", issue: { identifier: "TLSSN-42", url: "" }, actions: [{ op: "commented" }] },
};

const base = { toolName: "record_triage", isError: false, output: acted, purpose: "live", continuationKey: "TLSSN-42" };

test("the session key wins over the identifier the model wrote", () => {
  const decision = chainDecision({ ...base, output: { ...acted, verdict: { ...acted.verdict, identifier: "TLSSN-99" } } });
  assert.equal(decision.chain && decision.request.issueKey, "TLSSN-42");
});

test("feedback chains, a question does not", () => {
  assert.equal(chainDecision({ ...base, output: { ...acted, verdict: { ...acted.verdict, kind: "feedback" } } }).chain, true);
  const question = chainDecision({ ...base, output: { ...acted, verdict: { ...acted.verdict, kind: "question" } } });
  assert.deepEqual(question, { chain: false, reason: "question" });
});

test("needs-info and duplicate verdicts stop the chain", () => {
  assert.deepEqual(chainDecision({ ...base, output: { ...acted, verdict: { ...acted.verdict, needsInfo: true } } }), { chain: false, reason: "needs_info" });
  assert.deepEqual(chainDecision({ ...base, output: { ...acted, verdict: { ...acted.verdict, duplicateOf: "TLSSN-7" } } }), { chain: false, reason: "duplicate" });
  const hostLinked = { ...acted, tracker: { ...acted.tracker, actions: [{ op: "commented" }, { op: "duplicate_of", of: "TLSSN-7" }] } };
  assert.deepEqual(chainDecision({ ...base, output: hostLinked }), { chain: false, reason: "duplicate" });
});

test("nothing chains unless record_triage really commented", () => {
  assert.deepEqual(chainDecision({ ...base, toolName: "other_tool" }), { chain: false, reason: "not_record_triage" });
  assert.deepEqual(chainDecision({ ...base, isError: true }), { chain: false, reason: "tool_error" });
  assert.deepEqual(chainDecision({ ...base, stubbed: true }), { chain: false, reason: "stubbed" });
  assert.deepEqual(chainDecision({ ...base, purpose: "eval" }), { chain: false, reason: "eval" });
  assert.deepEqual(chainDecision({ ...base, output: { ...acted, tracker: { status: "skipped", reason: "eval" } } }), { chain: false, reason: "not_acted" });
  assert.deepEqual(chainDecision({ ...base, output: { ...acted, tracker: { status: "not_connected" } } }), { chain: false, reason: "not_acted" });
  // A redelivered webhook finds the Triage: comment already on the ticket. The tracker
  // still reports acted, but no new comment was written, so the planner is not called again.
  assert.deepEqual(chainDecision({ ...base, output: { ...acted, tracker: { ...acted.tracker, actions: [{ op: "already_commented" }] } } }), { chain: false, reason: "already_commented" });
  // Listing comments failed, so the comment step was skipped and nothing was written.
  assert.deepEqual(chainDecision({ ...base, output: { ...acted, tracker: { ...acted.tracker, actions: [] } } }), { chain: false, reason: "not_commented" });
});

test("no usable key means no chain", () => {
  const decision = chainDecision({ ...base, continuationKey: null, output: { ...acted, verdict: { ...acted.verdict, identifier: "not-a-key" } } });
  assert.deepEqual(decision, { chain: false, reason: "no_issue_key" });
});

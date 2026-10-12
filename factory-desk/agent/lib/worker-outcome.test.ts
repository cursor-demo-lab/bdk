import assert from "node:assert/strict";
import { test } from "node:test";
import { statusNames } from "./config.js";
import { decideCommentEvent } from "./outcome-event.js";
import { outcomeComment } from "./outcomes.js";
import { parseTriageOutcome } from "./triage-outcome.js";
import { parseWorkerOutcome } from "./worker-outcome.js";

// scripts/outcome-sentinels.test.mjs pins these parsers to the real writers in
// factory-worker and triage-jira. These cover what Jira does to the text on
// the way back, and which status each kind is announced in.

const STATUSES = statusNames({});
const LAUNCH_FAILED = "Launch failed: service_unavailable. Moving the card to Approved again retries.";
const NO_PLAN = "Approved without a plan on the ticket; nothing was launched. Move TLSSN-42 back to Triaged in Jira to plan it, then approve the new plan.";
const MOVE_SKIPPED = "Done not set from cursor-demo-lab/marsbank#13: the move failed; the next delivery for this pull request retries it.";
const TRIAGE_STOPPED = "Triage stopped: TLSSN-42\nThe triage run stopped at 2026-09-25 04:41 UTC before the ticket reached Triaged.\nWhy: Triage could not write its verdict to the ticket (could not read the ticket's comments; retry the delivery).";

function event(body: unknown, status: string | undefined) {
  return {
    webhookEvent: "comment_created",
    issue: { key: "TLSSN-42", fields: { summary: "CSV export", ...(status === undefined ? {} : { status: { name: status } }), project: { key: "TLSSN" } } },
    comment: { id: "10501", body },
  };
}

test("a comment Jira hands back with a BOM, CRLF, or as rich text still parses", () => {
  assert.deepEqual(parseWorkerOutcome(`\uFEFF${LAUNCH_FAILED}\r\n`, "TLSSN-42", STATUSES), { kind: "launch_failed", reason: "service_unavailable" });
  assert.deepEqual(parseTriageOutcome(TRIAGE_STOPPED.replace(/\n/g, "\r\n"), "TLSSN-42"), {
    kind: "triage_stopped",
    why: "Triage could not write its verdict to the ticket (could not read the ticket's comments; retry the delivery).",
  });
  assert.deepEqual(parseTriageOutcome("Triage stopped: TLSSN-42", "TLSSN-42"), { kind: "triage_stopped" });
  const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: NO_PLAN }] }] };
  assert.equal(decideCommentEvent(event(adf, "Approved"), { statuses: STATUSES, projects: ["TLSSN"] }).kind, "approved_without_plan");
});

test("the worker's move note follows the configured In Review and Done names", () => {
  const renamed = statusNames({ FACTORY_STATUS_DONE: "Shipped" });
  assert.equal(parseWorkerOutcome(MOVE_SKIPPED, "TLSSN-42", renamed), undefined);
  assert.deepEqual(parseWorkerOutcome(MOVE_SKIPPED.replace("Done", "Shipped"), "TLSSN-42", renamed), {
    kind: "move_skipped",
    target: "Shipped",
    pr: "cursor-demo-lab/marsbank#13",
    detail: "the move failed; the next delivery for this pull request retries it.",
  });
});

test("each kind is announced only while the ticket is in the status it leaves it in; a move note in any status", () => {
  const options = { statuses: STATUSES, projects: ["TLSSN"] };
  const cases: Array<[string, string, string, string]> = [
    [TRIAGE_STOPPED, "triage_stopped", "To Do", "Triaged"],
    [LAUNCH_FAILED, "launch_failed", "Approved", "In Progress"],
    [NO_PLAN, "approved_without_plan", "Approved", "Triaged"],
  ];
  for (const [body, kind, stays, movedTo] of cases) {
    assert.equal(decideCommentEvent(event(body, stays), options).kind, kind, body);
    assert.equal(decideCommentEvent(event(body, undefined), options).kind, kind, body);
    assert.deepEqual(decideCommentEvent(event(body, movedTo), options), { kind: "ignored", reason: "moved_on" }, body);
  }
  for (const status of ["In Progress", "In Review", "Planned", "Done"]) {
    assert.equal(decideCommentEvent(event(MOVE_SKIPPED, status), options).kind, "move_skipped", status);
  }
});

test("the worker comment the event named wins, else the newest of that kind", () => {
  const records = [
    { id: "1", body: LAUNCH_FAILED },
    { id: "2", body: NO_PLAN },
    { id: "3", body: LAUNCH_FAILED.replace("service_unavailable", "rate_limited") },
  ];
  assert.equal(outcomeComment(records, "TLSSN-42", { kind: "launch_failed", commentId: "1" }, STATUSES)?.id, "1");
  assert.equal(outcomeComment(records, "TLSSN-42", { kind: "launch_failed" }, STATUSES)?.id, "3");
  assert.equal(outcomeComment(records, "TLSSN-42", { kind: "approved_without_plan", commentId: "3" }, STATUSES)?.id, "2");
});

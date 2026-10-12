import assert from "node:assert/strict";
import { test } from "node:test";
import { firstLine, needsInfoComment, needsInfoSentinel, planStoppedComment, planStoppedSentinel } from "./needs-info.js";

const AT = new Date("2026-09-25T03:41:27.000Z");

test("the sentinels are the first line the desk wakes on", () => {
  assert.equal(needsInfoSentinel("TLSSN-18"), "Needs info: TLSSN-18");
  assert.equal(planStoppedSentinel("TLSSN-18"), "Plan stopped: TLSSN-18");
  assert.equal(firstLine("Needs info: TLSSN-18\nClaimed failure is not on main."), "Needs info: TLSSN-18");
});

// factory-desk/agent/lib/planner-outcome.test.ts parses these two bodies
// verbatim. A change here is a change there.
test("the Needs info comment is the shape the desk parses", () => {
  const comment = needsInfoComment({
    issueKey: "TLSSN-22",
    repo: "cursor-demo-lab/marsbank",
    ref: "main",
    claimed: "CSV export truncates the last column when the\n download filename contains spaces.",
    mismatch: "No CSV export or Content-Disposition code on main.",
    searched: ["csv export", "Content-Disposition"],
    at: AT,
  });
  assert.equal(
    comment,
    [
      "Needs info: TLSSN-22",
      "Claimed failure is not on cursor-demo-lab/marsbank@main (checked 2026-09-25 03:41 UTC).",
      "",
      "Ticket claimed: CSV export truncates the last column when the download filename contains spaces.",
      "On main: No CSV export or Content-Disposition code on main.",
      "Searched:",
      "- csv export",
      "- Content-Disposition",
      "",
      "Do not implement and do not open a pull request. Update the ticket with a path that fails on this ref, or close it.",
    ].join("\n")
  );
});

test("the Plan stopped comment carries one Why: line", () => {
  assert.equal(
    planStoppedComment({ issueKey: "TLSSN-22", why: "The planning run failed:\n resource_exhausted.", at: AT }),
    [
      "Plan stopped: TLSSN-22",
      "The planning run stopped at 2026-09-25 03:41 UTC without a plan.",
      "Why: The planning run failed: resource_exhausted.",
      "",
      "Nothing was planned and nothing will be built. Send the ticket back to Triaged for a new planning run.",
    ].join("\n")
  );
});

test("the Plan stopped comment for a skipped Triaged entry says no run started and how to get one", () => {
  assert.equal(
    planStoppedComment({ issueKey: "TLSSN-40", why: "The triage verdict (factory-desk's triage from filing) is a question, and the planner does not plan questions.", at: AT, skipped: true }),
    [
      "Plan stopped: TLSSN-40",
      "The planner did not start a planning run for this move to Triaged at 2026-09-25 03:41 UTC.",
      "Why: The triage verdict (factory-desk's triage from filing) is a question, and the planner does not plan questions.",
      "",
      "Nothing was planned and nothing will be built. Answer the Needs info in the ticket's Slack thread, or change the triage verdict in Jira, then send the ticket back to Triaged.",
    ].join("\n")
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { statusNames } from "./config.js";
import { decideCommentEvent } from "./outcome-event.js";
import { outcomeComment } from "./outcomes.js";
import { parsePlannerOutcome, plannerOutcomeKind } from "./planner-outcome.js";

const STATUSES = statusNames({});

// Verbatim from planner/agent/lib/needs-info.test.ts, which pins what the
// planner writes. A change there is a change here.
const NEEDS_INFO = [
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
].join("\n");

const PLAN_STOPPED = [
  "Plan stopped: TLSSN-22",
  "The planning run stopped at 2026-09-25 03:41 UTC without a plan.",
  "Why: The planning run failed: resource_exhausted.",
  "",
  "Nothing was planned and nothing will be built. Send the ticket back to Triaged for a new planning run.",
].join("\n");

test("the planner's Needs info body parses to what it checked, what the ticket claimed, and what it searched", () => {
  assert.deepEqual(parsePlannerOutcome(NEEDS_INFO, "TLSSN-22"), {
    kind: "needs_info",
    repo: "cursor-demo-lab/marsbank",
    ref: "main",
    claimed: "CSV export truncates the last column when the download filename contains spaces.",
    mismatch: "No CSV export or Content-Disposition code on main.",
    searched: ["csv export", "Content-Disposition"],
  });
});

test("the planner's Plan stopped body parses to its reason", () => {
  assert.deepEqual(parsePlannerOutcome(PLAN_STOPPED, "TLSSN-22"), { kind: "plan_stopped", why: "The planning run failed: resource_exhausted." });
  assert.deepEqual(parsePlannerOutcome("Plan stopped: TLSSN-22", "TLSSN-22"), { kind: "plan_stopped" });
});

test("a body Jira hands back as rendered rich text still parses: list items without dashes, CRLF, a BOM, a ref with slashes", () => {
  const rendered = `\uFEFF${NEEDS_INFO.replace("@main", "@release/1.2").replace("On main:", "On release/1.2:").replace(/\n- /g, "\n").replace(/\n/g, "\r\n")}`;
  assert.deepEqual(parsePlannerOutcome(rendered, "TLSSN-22"), {
    kind: "needs_info",
    repo: "cursor-demo-lab/marsbank",
    ref: "release/1.2",
    claimed: "CSV export truncates the last column when the download filename contains spaces.",
    mismatch: "No CSV export or Content-Disposition code on main.",
    searched: ["csv export", "Content-Disposition"],
  });
  assert.equal(parsePlannerOutcome(NEEDS_INFO.replace(" (checked 2026-09-25 03:41 UTC)", ""), "TLSSN-22")?.kind, "needs_info");
  assert.equal((parsePlannerOutcome(NEEDS_INFO.replace(" (checked 2026-09-25 03:41 UTC)", ""), "TLSSN-22") as { ref?: string }).ref, "main");
});

test("only the planner's sentinel for this ticket is a planner outcome", () => {
  assert.equal(plannerOutcomeKind(NEEDS_INFO, "TLSSN-22"), "needs_info");
  assert.equal(plannerOutcomeKind(PLAN_STOPPED, "TLSSN-22"), "plan_stopped");
  assert.equal(plannerOutcomeKind(NEEDS_INFO, "TLSSN-2"), undefined);
  assert.equal(plannerOutcomeKind("Triage: bug\nNeeds info: which export?", "TLSSN-22"), undefined);
  assert.equal(plannerOutcomeKind("Plan: TLSSN-22 Fix CSV export", "TLSSN-22"), undefined);
  assert.equal(plannerOutcomeKind("see Needs info: TLSSN-22", "TLSSN-22"), undefined);
});

test("the comment the event named wins, else the newest of that kind", () => {
  const records = [
    { id: "1", body: NEEDS_INFO },
    { id: "2", body: PLAN_STOPPED },
    { id: "3", body: NEEDS_INFO.replace("03:41", "04:12") },
  ];
  assert.equal(outcomeComment(records, "TLSSN-22", { kind: "needs_info", commentId: "1" }, STATUSES)?.id, "1");
  assert.equal(outcomeComment(records, "TLSSN-22", { kind: "needs_info", commentId: "99" }, STATUSES)?.id, "3");
  assert.equal(outcomeComment(records, "TLSSN-22", { kind: "needs_info" }, STATUSES)?.id, "3");
  assert.equal(outcomeComment(records, "TLSSN-22", { kind: "plan_stopped", commentId: "1" }, STATUSES)?.id, "2");
  assert.equal(outcomeComment([], "TLSSN-22", { kind: "plan_stopped" }, STATUSES), undefined);
});

test("a comment event is a planner outcome only for an allowed project, while the payload shows Triaged", () => {
  const event = (body: unknown, fields: Record<string, unknown> = {}) => ({
    webhookEvent: "jira:comment_created",
    issue: { key: "TLSSN-22", fields: { summary: " CSV export ", status: { name: "Triaged" }, project: { key: "TLSSN" }, ...fields } },
    comment: { id: 10301, body },
  });
  const options = { statuses: STATUSES, projects: ["TLSSN"] };
  assert.deepEqual(decideCommentEvent(event(NEEDS_INFO), options), {
    kind: "needs_info",
    issueKey: "TLSSN-22",
    title: "CSV export",
    claimId: "10301",
    commentId: "10301",
    body: NEEDS_INFO,
  });
  const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Plan stopped: TLSSN-22" }] }, { type: "paragraph", content: [{ type: "text", text: "Why: boom." }] }] };
  const fromAdf = decideCommentEvent(event(adf), options);
  assert.equal(fromAdf.kind, "plan_stopped");
  assert.equal((fromAdf as { body: string }).body, "Plan stopped: TLSSN-22\nWhy: boom.");
  assert.deepEqual(decideCommentEvent(event(NEEDS_INFO, { project: { key: "OTHER" } }), options), { kind: "ignored", reason: "project_not_allowed" });
  assert.deepEqual(decideCommentEvent(event(NEEDS_INFO, { status: { name: "Approved" } }), options), { kind: "ignored", reason: "moved_on" });
  assert.equal(decideCommentEvent(event(NEEDS_INFO, { status: undefined }), options).kind, "needs_info");
  assert.deepEqual(decideCommentEvent({ ...event(NEEDS_INFO), webhookEvent: "jira:issue_updated" }, options), { kind: "ignored", reason: "ignored" });
  assert.deepEqual(decideCommentEvent({ ...event(NEEDS_INFO), issue: { key: "not-a-key" } }, options), { kind: "ignored", reason: "ignored" });
});

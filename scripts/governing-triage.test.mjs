import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register("./ts-resolve.mjs", import.meta.url);

// The desk refuses a `plan KEY` bounce, and words its Triaged line, from the
// same Triage: comment the planner's status gate reads. Both go through the
// shared desk-triaged.ts `governingTriage`; this holds the two readers to the
// same gate over the same comments, so a bounce the desk sends is one the
// planner plans (Bugbot on #166: they diverged on tickets filed before the
// desk marked its comment).

const { latestTriageVerdict } = await import("../factory-desk/agent/lib/triage-comment.ts");
const { planFromStatus } = await import("../planner/agent/lib/jira-event.ts");
const { withDeskTriaged } = await import("../factory-desk/agent/lib/desk-triaged.ts");

const BY = "\nTriaged by: model (Jev was not above 0.52 on every answer)";
const DESK_BUG = withDeskTriaged(`Triage: bug\nType: Bug\nSeverity: medium\nSummary: Freeze card.\nNext step: Add it.${BY}`);
const LEGACY_DESK_BUG = `Triage: bug\nType: Bug\nSeverity: medium\nSummary: Freeze card.\nNext step: Add it.${BY}`;
const DESK_QUESTION = withDeskTriaged(`Triage: question\nSeverity: low${BY}`);
const SECOND_DUPLICATE = `Triage: bug\nSeverity: medium\nDuplicate of: TLSSN-38${BY}`;
const SECOND_QUESTION = `Triage: question\nSeverity: low${BY}`;
const PERSON_QUESTION = "Triage: question\nSeverity: low";
const PERSON_BUG = "Triage: bug\nSeverity: high";
const NEEDS_INFO = `Triage: bug\nSeverity: low\nNeeds info: which page?${BY}`;
const DETAIL = "Detail from Slack: TLSSN-42\nbob replied in the ticket's Slack thread:\n\nThe /reports page.";

const FIXTURES = [
  ["desk bug, then a machine second triage marked duplicate", [DESK_BUG, SECOND_DUPLICATE], undefined],
  ["unmarked desk bug (filed before the marker), then a machine second triage", [LEGACY_DESK_BUG, SECOND_QUESTION], undefined],
  ["unmarked desk bug, a machine duplicate, then a person's question", [LEGACY_DESK_BUG, SECOND_DUPLICATE, PERSON_QUESTION], "question"],
  ["desk question, then a machine bug", [DESK_QUESTION, `Triage: bug\nSeverity: high${BY}`], "question"],
  ["desk question, then a person's bug", [DESK_QUESTION, PERSON_BUG], undefined],
  ["one machine question", [SECOND_QUESTION], "question"],
  ["two person comments, the newest governs", [PERSON_BUG, PERSON_QUESTION], "question"],
  ["a needs-info verdict", [NEEDS_INFO], "needs_info"],
  ["a needs-info verdict answered from Slack", [NEEDS_INFO, DETAIL], undefined],
  ["a Detail before the needs-info does not answer it", [DETAIL, NEEDS_INFO], "needs_info"],
  ["no Triage: comment", ["Plan: TLSSN-42 Something"], undefined],
];

const status = {
  webhookEvent: "jira:issue_updated",
  issue: { key: "TLSSN-42", fields: { summary: "Freeze card", status: { name: "Triaged" }, project: { key: "TLSSN" } } },
  changelog: { id: "10041", items: [{ field: "status", fromString: "To Do", toString: "Triaged" }] },
};
const opts = { triagedStatus: "Triaged", plannedStatus: "Planned", projects: ["TLSSN"] };

for (const [name, comments, gate] of FIXTURES) {
  test(`desk and planner agree: ${name}`, async () => {
    assert.equal(latestTriageVerdict(comments)?.gate, gate, "desk");
    const decision = await planFromStatus(status, { ...opts, readComments: async () => comments });
    assert.equal(decision.plan ? undefined : decision.reason, gate, "planner");
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { decideApproved, extractBrief, implementingComment, latestPlanComment, noBriefComment } from "./decide.js";
import { implementClaimKey } from "./kv-keys.js";
import { approvedBody } from "./fixtures.js";

const OPTS = { approvedStatus: "Approved", projects: ["TLSSN"] };

test("a move into Approved launches with the key, the changelog id, and the summary", () => {
  assert.deepEqual(decideApproved(approvedBody(), OPTS), {
    launch: true,
    issueKey: "TLSSN-42",
    changelogId: "10042",
    title: "Retry CSV export on empty filter",
  });
});

test("status names match case-insensitively and the bare issue_updated event is accepted", () => {
  assert.equal(decideApproved(approvedBody({ webhookEvent: "issue_updated" }), OPTS).launch, true);
  assert.equal(decideApproved(approvedBody({ toStatus: "APPROVED", currentStatus: "approved" }), OPTS).launch, true);
  assert.equal(decideApproved(approvedBody({ toStatus: "Ready to build" }), { ...OPTS, approvedStatus: "ready to build" }).launch, true);
});

test("a missing summary falls back to the key", () => {
  const body = approvedBody();
  body.issue.fields.summary = "";
  assert.deepEqual(decideApproved(body, OPTS), { launch: true, issueKey: "TLSSN-42", changelogId: "10042", title: "TLSSN-42" });
});

test("anything but a move into Approved, on an allowed ticket that is still Approved, is refused with its reason", () => {
  const withoutIssue = approvedBody() as { issue?: unknown };
  delete withoutIssue.issue;
  const summaryEdit = approvedBody();
  summaryEdit.changelog.items = [
    { field: "summary", fieldtype: "jira", fieldId: "summary", from: "", fromString: "Old", to: "", toString: "Retry CSV export on empty filter" },
  ];
  const withoutChangelog = approvedBody() as { changelog?: unknown };
  delete withoutChangelog.changelog;
  const cases: [string, unknown, typeof OPTS, string][] = [
    ["an issue_created event", approvedBody({ webhookEvent: "jira:issue_created" }), OPTS, "ignored"],
    ["a comment_created event", approvedBody({ webhookEvent: "comment_created" }), OPTS, "ignored"],
    ["no body", undefined, OPTS, "ignored"],
    ["an array", [approvedBody()], OPTS, "ignored"],
    ["a lowercase key", approvedBody({ issueKey: "tlssn-42" }), OPTS, "no_issue_key"],
    ["no issue", withoutIssue, OPTS, "no_issue_key"],
    ["another project", approvedBody({ issueKey: "OPS-7" }), OPTS, "project_not_allowed"],
    ["an empty allowlist", approvedBody(), { ...OPTS, projects: [] }, "project_not_allowed"],
    ["a summary edit", summaryEdit, OPTS, "not_status_change"],
    ["no changelog", withoutChangelog, OPTS, "not_status_change"],
    ["a move into Planned", approvedBody({ fromStatus: "Triaged", toStatus: "Planned" }), OPTS, "other_status"],
  ];
  for (const [label, body, opts, reason] of cases) assert.deepEqual(decideApproved(body, opts), { launch: false, reason }, label);
});

test("a move into Approved on a ticket that has since left it is refused with the ticket, the approval, and where it went", () => {
  assert.deepEqual(decideApproved(approvedBody({ currentStatus: "Planned" }), OPTS), {
    launch: false,
    reason: "stale_status",
    issueKey: "TLSSN-42",
    changelogId: "10042",
    title: "Retry CSV export on empty filter",
    current: "Planned",
  });
});

test("the documented Automation issue_updated body launches", () => {
  assert.deepEqual(
    decideApproved(
      {
        webhookEvent: "jira:issue_updated",
        issue: {
          key: "TLSSN-42",
          fields: {
            summary: "Retry CSV export on empty filter",
            status: { name: "Approved" },
            project: { key: "TLSSN" },
          },
        },
        changelog: {
          id: "TLSSN-42:Approved:2026-09-24T00:00:00.000+0000",
          items: [{ field: "status", fromString: "Planned", toString: "Approved" }],
        },
      },
      OPTS
    ),
    {
      launch: true,
      issueKey: "TLSSN-42",
      changelogId: "TLSSN-42:Approved:2026-09-24T00:00:00.000+0000",
      title: "Retry CSV export on empty filter",
    }
  );
});

test("the claim key, the Implementing: line, and the refusal name the ticket", () => {
  assert.equal(implementClaimKey("TLSSN-42"), "implement/TLSSN-42");
  assert.equal(implementingComment("https://cursor.com/agents/bc-1"), "Implementing: https://cursor.com/agents/bc-1");
  assert.equal(
    noBriefComment("TLSSN-42"),
    "Approved without a plan on the ticket; nothing was launched. Move TLSSN-42 back to Triaged in Jira to plan it, then approve the new plan."
  );
});

test("the latest Plan: comment for the key wins and its brief is the text after the last Brief: heading", () => {
  const older = "Plan: TLSSN-42 First try\nBrief:\nOld brief.";
  const newer = "Plan: TLSSN-42 Second try\nProblem\nx\n\nBrief:\nNotes\nBrief:\nNew brief.\nSecond line.";
  const comments = ["Triage: bug", older, "Plan: TLSSN-7 Other ticket\nBrief:\nNot this one.", newer, "Looks good"];
  assert.equal(latestPlanComment(comments, "TLSSN-42"), newer);
  assert.equal(extractBrief(newer), "New brief.\nSecond line.");
  assert.equal(latestPlanComment(["Triage: bug"], "TLSSN-42"), undefined);
  assert.equal(extractBrief("Plan: TLSSN-42 x\nNo brief here"), undefined);
  assert.equal(extractBrief("Plan: TLSSN-42 x\nBrief:\n   "), undefined);
});

test("staging: decideApproved refuses when the issue key or the claimed project.key is out of scope; production is unchanged", () => {
  const staging = { FACTORY_ENV: "staging" };
  const claiming = (claim: { issueKey: string; projectKey: string }) => {
    const body = approvedBody({ issueKey: claim.issueKey });
    return { ...body, issue: { ...body.issue, fields: { ...body.issue.fields, project: { id: "10000", key: claim.projectKey } } } };
  };
  assert.deepEqual(decideApproved(claiming({ issueKey: "TLSTG-1", projectKey: "TLSSN" }), { ...OPTS, projects: ["TLSTG"], env: staging }), { launch: false, reason: "project_not_allowed" });
  assert.deepEqual(decideApproved(claiming({ issueKey: "TLSSN-47", projectKey: "TLSTG" }), { ...OPTS, projects: ["TLSTG"], env: staging }), { launch: false, reason: "project_not_allowed" });
  assert.equal(decideApproved(claiming({ issueKey: "TLSTG-1", projectKey: "TLSTG" }), { ...OPTS, projects: ["TLSTG"], env: staging }).launch, true);
  assert.equal(decideApproved(claiming({ issueKey: "TLSTG-1", projectKey: "TLSSN" }), { ...OPTS, projects: ["TLSTG"], env: {} }).launch, true, "production reads only the key, as on main");
});

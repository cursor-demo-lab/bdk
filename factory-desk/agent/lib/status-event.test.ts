import assert from "node:assert/strict";
import { test } from "node:test";
import { decideStatusEvent, latestImplementingComment, latestMergedByComment, latestPullRequestComment } from "./status-event.js";

const OPTIONS = { statuses: { triaged: "Triaged", planned: "Planned", approved: "Approved", inProgress: "In Progress", inReview: "In Review", done: "Done" }, projects: ["TLSSN"] };

function issueUpdated(input: {
  key?: string;
  project?: string;
  status: string;
  from: string;
  to: string;
  webhookEvent?: string;
  items?: Record<string, unknown>[];
}) {
  return {
    timestamp: 1758510000123,
    webhookEvent: input.webhookEvent ?? "jira:issue_updated",
    issue_event_type_name: "issue_generic",
    user: { accountId: "5b10a2844c20165700ede21g", displayName: "Alice" },
    issue: {
      id: "10200",
      key: input.key ?? "TLSSN-42",
      fields: {
        summary: "CSV export returns 500 on empty filter",
        status: { name: input.status },
        project: { key: input.project ?? "TLSSN" },
      },
    },
    changelog: {
      id: "10042",
      items: input.items ?? [
        { field: "status", fieldtype: "jira", fieldId: "status", from: "10001", fromString: input.from, to: "10002", toString: input.to },
      ],
    },
  };
}

test("the documented Automation issue_updated body announces Planned", () => {
  assert.deepEqual(
    decideStatusEvent(
      {
        webhookEvent: "jira:issue_updated",
        issue: {
          key: "TLSSN-42",
          fields: {
            summary: "CSV export returns 500 on empty filter",
            status: { name: "Planned" },
            project: { key: "TLSSN" },
          },
        },
        changelog: {
          id: "TLSSN-42:Planned:2026-09-24T00:00:00.000+0000",
          items: [{ field: "status", fromString: "Triaged", toString: "Planned" }],
        },
      },
      OPTIONS
    ),
    {
      kind: "planned",
      issueKey: "TLSSN-42",
      title: "CSV export returns 500 on empty filter",
      changelogId: "TLSSN-42:Planned:2026-09-24T00:00:00.000+0000",
    }
  );
});

test("a transition into each watched status announces it, case-insensitively and under either event name", () => {
  const cases: [Parameters<typeof issueUpdated>[0], string][] = [
    [{ status: "Triaged", from: "To Do", to: "Triaged" }, "triaged"],
    [{ status: "Planned", from: "Triaged", to: "Planned" }, "planned"],
    [{ webhookEvent: "issue_updated", status: "Planned", from: "Triaged", to: "Planned" }, "planned"],
    [{ status: "Approved", from: "Planned", to: "Approved" }, "approved"],
    [{ status: "In Progress", from: "Approved", to: "in progress" }, "in_progress"],
    [{ status: "In Review", from: "In Progress", to: "In Review" }, "in_review"],
    [{ status: "Done", from: "In Progress", to: "Done" }, "done"],
  ];
  for (const [input, kind] of cases) {
    assert.deepEqual(
      decideStatusEvent(issueUpdated(input), OPTIONS),
      { kind, issueKey: "TLSSN-42", title: "CSV export returns 500 on empty filter", changelogId: "10042" },
      JSON.stringify(input)
    );
  }
});

test("configured status names replace the defaults", () => {
  const custom = { statuses: { triaged: "Sorted", planned: "Plan ready", approved: "Go", inProgress: "Building", inReview: "PR open", done: "Merged" }, projects: [] };
  assert.equal(decideStatusEvent(issueUpdated({ status: "Merged", from: "PR open", to: "Merged" }), custom).kind, "done");
  assert.deepEqual(decideStatusEvent(issueUpdated({ status: "Plan ready", from: "Triaged", to: "Plan ready" }), custom), {
    kind: "planned",
    issueKey: "TLSSN-42",
    title: "CSV export returns 500 on empty filter",
    changelogId: "10042",
  });
  assert.deepEqual(decideStatusEvent(issueUpdated({ status: "Planned", from: "Triaged", to: "Planned" }), custom), {
    kind: "ignored",
    reason: "other_status",
  });
});

test("another event, a bad key, or a non-object body is ignored", () => {
  assert.deepEqual(decideStatusEvent(issueUpdated({ webhookEvent: "jira:issue_created", status: "Planned", from: "Triaged", to: "Planned" }), OPTIONS), {
    kind: "ignored",
    reason: "ignored",
  });
  assert.deepEqual(decideStatusEvent(issueUpdated({ key: "tlssn-42", status: "Planned", from: "Triaged", to: "Planned" }), OPTIONS), {
    kind: "ignored",
    reason: "ignored",
  });
  assert.deepEqual(decideStatusEvent(null, OPTIONS), { kind: "ignored", reason: "ignored" });
  assert.deepEqual(decideStatusEvent("jira:issue_updated", OPTIONS), { kind: "ignored", reason: "ignored" });
});

test("a project outside FACTORY_JIRA_PROJECTS is not allowed; an empty list allows any", () => {
  const other = issueUpdated({ key: "PROD-7", project: "PROD", status: "Planned", from: "Triaged", to: "Planned" });
  assert.deepEqual(decideStatusEvent(other, OPTIONS), { kind: "ignored", reason: "project_not_allowed" });
  assert.deepEqual(decideStatusEvent(other, { ...OPTIONS, projects: [] }), {
    kind: "planned",
    issueKey: "PROD-7",
    title: "CSV export returns 500 on empty filter",
    changelogId: "10042",
  });
});

test("an update with no status item is not a status change", () => {
  const assignee = issueUpdated({
    status: "Planned",
    from: "",
    to: "",
    items: [{ field: "assignee", fieldtype: "jira", fromString: null, toString: "Alice" }],
  });
  assert.deepEqual(decideStatusEvent(assignee, OPTIONS), { kind: "ignored", reason: "not_status_change" });
  const noChangelog = { ...issueUpdated({ status: "Planned", from: "Triaged", to: "Planned" }), changelog: undefined };
  assert.deepEqual(decideStatusEvent(noChangelog, OPTIONS), { kind: "ignored", reason: "not_status_change" });
});

test("a transition into a status the desk does not watch is other_status", () => {
  assert.deepEqual(decideStatusEvent(issueUpdated({ status: "To Do", from: "Triaged", to: "To Do" }), OPTIONS), {
    kind: "ignored",
    reason: "other_status",
  });
});

test("a ticket that moved on before the webhook landed is stale", () => {
  assert.deepEqual(decideStatusEvent(issueUpdated({ status: "Approved", from: "Triaged", to: "Planned" }), OPTIONS), {
    kind: "ignored",
    reason: "stale_status",
  });
});

test("latestMergedByComment is the GitHub login from the latest Merged by: comment", () => {
  assert.equal(latestMergedByComment([]), undefined);
  assert.equal(latestMergedByComment(["Pull request: https://github.com/a/b/pull/1"]), undefined);
  assert.equal(latestMergedByComment(["see Merged by: example-user"]), undefined);
  assert.equal(latestMergedByComment(["Merged by:"]), undefined);
  assert.equal(latestMergedByComment(["Merged by: not a login!"]), undefined);
  assert.equal(
    latestMergedByComment(["Merged by: alice", "Looks good", "Merged by: example-user\nvia the GitHub UI"]),
    "example-user"
  );
  assert.equal(latestMergedByComment(["Merged by: some-user"]), "some-user");
});

test("latestPullRequestComment is the implement PR from the latest Pull request: comment", () => {
  const url = "https://github.com/cursor-demo-lab/marsbank/pull/20";
  assert.deepEqual(latestPullRequestComment([`Pull request: ${url}`]), { url, label: "cursor-demo-lab/marsbank#20" });
  assert.equal(latestPullRequestComment(["see Pull request: https://github.com/a/b/pull/1"]), undefined);
});

test("latestImplementingComment is the URL from the latest Implementing: comment", () => {
  assert.equal(latestImplementingComment([]), undefined);
  assert.equal(latestImplementingComment(["Triage: bug", "Plan: TLSSN-42 Retry"]), undefined);
  assert.equal(latestImplementingComment(["Implementing: nothing yet"]), undefined);
  assert.equal(latestImplementingComment(["see Implementing: https://cursor.com/agents/bc-1"]), undefined);
  assert.equal(
    latestImplementingComment([
      "Implementing: https://cursor.com/agents/bc-old",
      "Plan: TLSSN-42 Retry",
      "Implementing: https://cursor.com/agents/bc-new.\n\nBranch TLSSN-42-retry.",
      "Looks good",
    ]),
    "https://cursor.com/agents/bc-new"
  );
});

test("a move back into Planned from Approved or later names the status it came back from", () => {
  for (const from of ["Approved", "In Progress", "in review", "Done"]) {
    assert.deepEqual(decideStatusEvent(issueUpdated({ status: "Planned", from, to: "Planned" }), OPTIONS), {
      kind: "planned",
      issueKey: "TLSSN-42",
      title: "CSV export returns 500 on empty filter",
      changelogId: "10042",
      movedBackFrom: from,
    }, from);
  }
  for (const from of ["Triaged", "Planned", "To Do", ""]) {
    assert.equal(decideStatusEvent(issueUpdated({ status: "Planned", from, to: "Planned" }), OPTIONS).kind, "planned", from);
    assert.equal("movedBackFrom" in decideStatusEvent(issueUpdated({ status: "Planned", from, to: "Planned" }), OPTIONS), false, from);
  }
});

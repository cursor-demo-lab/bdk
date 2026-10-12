import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQueueEvent, pinIssueIdentifier } from "./parse-queue-event.js";

test("pinIssueIdentifier accepts bare and hosted cont: keys", () => {
  assert.equal(pinIssueIdentifier("TLSSN-42", "X-1"), "TLSSN-42");
  assert.equal(pinIssueIdentifier("cont:TLSSN-42", "X-1"), "TLSSN-42");
  assert.equal(pinIssueIdentifier("cont:issue:TLSSN-42", "X-1"), "X-1");
  assert.equal(pinIssueIdentifier(null, "X-1"), "X-1");
});

test("the documented Automation issue_created body queues the ticket", () => {
  assert.deepEqual(
    parseQueueEvent({
      webhookEvent: "jira:issue_created",
      issue: {
        key: "TLSSN-42",
        self: "https://example.atlassian.net/browse/TLSSN-42",
        fields: {
          summary: "CSV export returns 500",
          description: "Empty filter 500s.",
          status: { name: "To Do" },
          project: { key: "TLSSN" },
          reporter: { displayName: "Alice Example" },
        },
      },
    }),
    {
      ok: true,
      issue: {
        identifier: "TLSSN-42",
        title: "CSV export returns 500",
        description: "Empty filter 500s.",
        url: "https://example.atlassian.net/browse/TLSSN-42",
        reporter: "Alice Example",
        status: "To Do",
      },
    }
  );
});

test("a Jira issue_created body carries the delivered issue type for the host judge", () => {
  const parsed = parseQueueEvent({
    webhookEvent: "jira:issue_created",
    issue: { key: "TLSSN-43", self: "x", fields: { summary: "Dark mode", description: "", issuetype: { id: "10170", name: "Task" } } },
  });
  assert.equal(parsed.ok && parsed.issue.issueType, "Task");
  const untyped = parseQueueEvent({ webhookEvent: "jira:issue_created", issue: { key: "TLSSN-44", fields: { summary: "x" } } });
  assert.equal(untyped.ok && "issueType" in untyped.issue, false);
});

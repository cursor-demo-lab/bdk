// A ticket filed straight in Jira (TLSSN-51: no file_ticket, no Slack
// binding) as the desk's Jira route sees it: the status webhooks the TLSSN
// Automation rule sends, and what the ticket reads back as at each step.
// jira.test.ts drives these through Triaged and Planned.

export const JIRA_FILED_KEY = "TLSSN-51";
export const JIRA_FILED_TITLE = "Statement PDF shows the wrong closing balance";
export const INTAKE_CHANNEL = "C0INTAKE01";

// Written in Jira by a person: no `Slack thread:` line.
export const JIRA_FILED_DESCRIPTION = "The March statement PDF shows the opening balance where the closing balance should be. Seen on two accounts.";

// file_ticket's description for a Slack filing (slack-link.ts `withSlackThread`).
export const SLACK_FILED_DESCRIPTION = `${JIRA_FILED_DESCRIPTION}\n\nSlack thread: https://example-workspace.slack.com/archives/C0EXAMPLE1/p1790366941085899`;

export const TRIAGE_COMMENT = { id: "20101", body: "Triage: bug\nSeverity: high\nNext step: Confirm the balance field on the statement template." };
export const PLAN_COMMENT = {
  id: "20301",
  body: [
    `Plan: ${JIRA_FILED_KEY} ${JIRA_FILED_TITLE}`,
    "Summary: The statement template reads openingBalance for the closing line.",
    "Approach: Read closingBalance in the template and pin it with a snapshot test.",
    "Brief:",
    "Fix the closing balance line.",
  ].join("\n"),
};

export function statusWebhook(input: { from: string; to: string; changelogId: string }) {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { key: JIRA_FILED_KEY, fields: { summary: JIRA_FILED_TITLE, status: { name: input.to }, project: { key: "TLSSN" } } },
    changelog: { id: input.changelogId, items: [{ field: "status", fromString: input.from, toString: input.to }] },
  };
}

export const TRIAGED = statusWebhook({ from: "To Do", to: "Triaged", changelogId: "20030" });
export const PLANNED = statusWebhook({ from: "Triaged", to: "Planned", changelogId: "20040" });

// The canonical Jira Cloud `jira:issue_updated` body for a status move.
// `scripts/replay-jira-transition.mjs` builds the same literal and a test
// holds the two equal, so a replay exercises exactly what the tests do.

export type ApprovedBodyOverrides = {
  issueKey?: string;
  summary?: string;
  fromStatus?: string;
  toStatus?: string;
  currentStatus?: string;
  changelogId?: string;
  webhookEvent?: string;
  timestamp?: number;
};

export type JiraIssueUpdatedBody = {
  timestamp: number;
  webhookEvent: string;
  issue_event_type_name: string;
  user: { accountId: string; displayName: string; active: boolean; accountType: string };
  issue: {
    id: string;
    key: string;
    fields: {
      summary: string;
      status: { id: string; name: string };
      project: { id: string; key: string };
    };
  };
  changelog: {
    id: string;
    items: {
      field: string;
      fieldtype: string;
      fieldId: string;
      from: string;
      fromString: string;
      to: string;
      toString: string;
    }[];
  };
};

export function approvedBody(overrides: ApprovedBodyOverrides = {}): JiraIssueUpdatedBody {
  const issueKey = overrides.issueKey ?? "TLSSN-42";
  const toStatus = overrides.toStatus ?? "Approved";
  return {
    timestamp: overrides.timestamp ?? 1_790_000_000_000,
    webhookEvent: overrides.webhookEvent ?? "jira:issue_updated",
    issue_event_type_name: "issue_generic",
    user: {
      accountId: "712020:5f1c2b7a-0d3e-4c1a-9e2f-3a4b5c6d7e8f",
      displayName: "Alice Example",
      active: true,
      accountType: "atlassian",
    },
    issue: {
      id: "10142",
      key: issueKey,
      fields: {
        summary: overrides.summary ?? "Retry CSV export on empty filter",
        status: { id: "10002", name: overrides.currentStatus ?? toStatus },
        project: { id: "10000", key: issueKey.slice(0, issueKey.indexOf("-")) },
      },
    },
    changelog: {
      id: overrides.changelogId ?? "10042",
      items: [
        {
          field: "status",
          fieldtype: "jira",
          fieldId: "status",
          from: "10001",
          fromString: overrides.fromStatus ?? "Planned",
          to: "10002",
          toString: toStatus,
        },
      ],
    },
  };
}

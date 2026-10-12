// Signed Jira Cloud webhook bodies for the factory routes. Used by
// replay-jira-transition.mjs, replay-jira-comment.mjs, and e2e-drive.mjs.
//
// transitionBody with only its original fields is the literal in
// factory-worker/agent/lib/fixtures.ts (`approvedBody`);
// factory-worker/agent/lib/replay.test.ts holds them equal, so optional
// fields must default to the values that literal carries.

import { createHmac } from "node:crypto";

const ALICE = {
  accountId: "712020:5f1c2b7a-0d3e-4c1a-9e2f-3a4b5c6d7e8f",
  displayName: "Alice Example",
  active: true,
  accountType: "atlassian",
};

function projectOf(issueKey) {
  return issueKey.slice(0, issueKey.indexOf("-"));
}

/**
 * `jira:issue_updated` with one status changelog item. `currentStatus` is
 * `issue.fields.status.name`; it defaults to `toStatus`. A handler that sees
 * the two differ treats the delivery as stale.
 */
export function transitionBody({ issueKey, toStatus, fromStatus, changelogId, timestamp, summary, currentStatus, issueId }) {
  return {
    timestamp,
    webhookEvent: "jira:issue_updated",
    issue_event_type_name: "issue_generic",
    user: { ...ALICE },
    issue: {
      id: issueId ?? "10142",
      key: issueKey,
      fields: {
        summary,
        status: { id: "10002", name: currentStatus ?? toStatus },
        project: { id: "10000", key: projectOf(issueKey) },
      },
    },
    changelog: {
      id: changelogId,
      items: [
        {
          field: "status",
          fieldtype: "jira",
          fieldId: "status",
          from: "10001",
          fromString: fromStatus,
          to: "10002",
          toString: toStatus,
        },
      ],
    },
  };
}

/** `jira:issue_created`, the event the triage route wakes on. */
export function createdBody({ issueKey, summary, description, timestamp, issueId, site, status }) {
  const id = issueId ?? "10142";
  return {
    timestamp,
    webhookEvent: "jira:issue_created",
    issue_event_type_name: "issue_created",
    user: { ...ALICE },
    issue: {
      id,
      key: issueKey,
      self: `https://${site ?? "<JIRA_SITE>.atlassian.net"}/rest/api/2/issue/${id}`,
      fields: {
        summary,
        description,
        issuetype: { name: "Bug" },
        status: { id: "10001", name: status ?? "To Do" },
        project: { id: "10000", key: projectOf(issueKey) },
        reporter: { ...ALICE },
      },
    },
  };
}

/**
 * `comment_created`, the event the desk's comment rule sends. The desk reads
 * the comment back from Jira by `commentId`, so `body` needs only the
 * outcome's first line (`Needs info: <KEY>`, `Triage stopped: <KEY>`,
 * `Launch failed: …`; replay-jira-comment.mjs `KINDS`).
 */
export function commentBody({ issueKey, commentId, body, timestamp, summary, status, issueId }) {
  return {
    timestamp,
    webhookEvent: "comment_created",
    user: { ...ALICE },
    issue: {
      id: issueId ?? "10142",
      key: issueKey,
      fields: {
        summary,
        status: { id: "10002", name: status ?? "Triaged" },
        project: { id: "10000", key: projectOf(issueKey) },
      },
    },
    comment: { id: commentId, body, author: { ...ALICE } },
  };
}

export function signature(rawBody, secret) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** The raw body and headers to POST. The signature covers exactly `rawBody`. */
export function signedRequest(body, secret) {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    headers: { "content-type": "application/json", "x-hub-signature-256": signature(rawBody, secret) },
  };
}

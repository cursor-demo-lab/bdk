#!/usr/bin/env node
// Replay a factory outcome comment against the desk.
//
//   node scripts/replay-jira-comment.mjs <url> <ISSUE-KEY> --comment-id <id> \
//     [--kind needs-info|plan-stopped|triage-stopped|launch-failed|approved-without-plan] \
//     [--first-line <text>] [--status <name>] [--summary <text>] \
//     [--secret-env JIRA_WEBHOOK_SECRET] [--print]
//
// Builds a signed `comment_created` body the way the desk's TLSSN comment
// rule sends it and POSTs it to <url>, for example the desk's engine alias
// plus /v1/channels/jira/. The desk reads the real comment back from Jira by
// `--comment-id` (the id in the comment's permalink, `focusedCommentId=`), so
// the body carries only the comment's first line, which is what wakes the
// desk. `--kind` picks that line and the status the ticket is left in (the
// desk ignores a ticket the body shows elsewhere); `--first-line` sends any
// other line verbatim, such as the worker's `In Review not set from …` note,
// and `--status` overrides the status. Use it to post a comment that landed
// before the comment rule existed, or to prove the route before the rule is
// added. The same comment id twice is a redelivery and posts once.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { commentBody, signedRequest } from "./jira-payload.mjs";

export { commentBody };

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

// First lines as each agent writes them (scripts/outcome-sentinels.test.mjs pins the writers to the desk).
export const KINDS = {
  "needs-info": { status: "Triaged", line: (key) => `Needs info: ${key}` },
  "plan-stopped": { status: "Triaged", line: (key) => `Plan stopped: ${key}` },
  "triage-stopped": { status: "To Do", line: (key) => `Triage stopped: ${key}` },
  "launch-failed": { status: "Approved", line: () => "Launch failed: unknown_error. Moving the card to Approved again retries." },
  "approved-without-plan": {
    status: "Approved",
    line: (key) => `Approved without a plan on the ticket; nothing was launched. Move ${key} back to Triaged in Jira to plan it, then approve the new plan.`,
  },
};

const USAGE = `usage: node scripts/replay-jira-comment.mjs <url> <ISSUE-KEY> --comment-id <id> [--kind ${Object.keys(KINDS).join("|")}] [--first-line <text>] [--status <name>] [--summary <text>] [--secret-env JIRA_WEBHOOK_SECRET] [--print]`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        "comment-id": { type: "string" },
        kind: { type: "string", default: "needs-info" },
        "first-line": { type: "string" },
        status: { type: "string" },
        summary: { type: "string", default: "" },
        "secret-env": { type: "string", default: "JIRA_WEBHOOK_SECRET" },
        print: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  const [url, issueKey] = positionals;
  if (url === undefined || issueKey === undefined || positionals.length > 2) {
    console.error(USAGE);
    process.exit(2);
  }
  if (!ISSUE_KEY.test(issueKey)) {
    console.error(`"${issueKey}" is not a Jira issue key such as TLSSN-42.\n${USAGE}`);
    process.exit(2);
  }
  const kind = KINDS[values.kind];
  if (kind === undefined) {
    console.error(`--kind must be one of ${Object.keys(KINDS).join(", ")}.\n${USAGE}`);
    process.exit(2);
  }
  const firstLine = values["first-line"]?.trim();
  if (firstLine === "" || firstLine?.includes("\n")) {
    console.error(`--first-line must be one non-empty line.\n${USAGE}`);
    process.exit(2);
  }
  const commentId = values["comment-id"] ?? "";
  if (!/^\d+$/.test(commentId)) {
    console.error(`--comment-id must be the numeric Jira comment id (focusedCommentId= in the comment's link).\n${USAGE}`);
    process.exit(2);
  }
  const secretEnv = values["secret-env"];
  const secret = process.env[secretEnv] ?? "";
  if (secret === "") {
    console.error(`Set ${secretEnv} to the slug's webhook secret, or name another variable with --secret-env.`);
    process.exit(2);
  }

  const body = commentBody({
    issueKey,
    commentId,
    body: firstLine ?? kind.line(issueKey),
    timestamp: Date.now(),
    summary: values.summary === "" ? issueKey : values.summary,
    status: values.status ?? kind.status,
  });
  const { rawBody, headers } = signedRequest(body, secret);

  if (values.print) {
    console.log(`POST ${url}`);
    for (const [name, value] of Object.entries(headers)) console.log(`${name}: ${value}`);
    console.log("");
    console.log(rawBody);
    return;
  }

  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: rawBody });
  } catch (error) {
    console.error(`POST ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
  if (!response.ok) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

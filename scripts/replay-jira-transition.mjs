#!/usr/bin/env node
// Replay one Jira status transition against a factory slug.
//
//   node scripts/replay-jira-transition.mjs <url> <ISSUE-KEY> <toStatus> \
//     [--from <status>] [--summary <text>] [--secret-env JIRA_WEBHOOK_SECRET] \
//     [--changelog-id <id>] [--print]
//
// Builds a signed `jira:issue_updated` body the way Jira Cloud sends it and
// POSTs it to <url>, for example
// http://127.0.0.1:3000/factory-worker/v1/channels/jira/. The secret comes
// from the named environment variable; export it first. `--print` shows the
// signed request and sends nothing. A fresh changelog id is a new transition;
// pass the same `--changelog-id` twice to replay a redelivery.
//
// The body builder lives in jira-payload.mjs and is re-exported here, because
// factory-worker/agent/lib/replay.test.ts imports it from this script.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { signature, transitionBody } from "./jira-payload.mjs";

export { signature, transitionBody };

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const USAGE =
  "usage: node scripts/replay-jira-transition.mjs <url> <ISSUE-KEY> <toStatus> [--from <status>] [--summary <text>] [--secret-env JIRA_WEBHOOK_SECRET] [--changelog-id <id>] [--print]";

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        from: { type: "string", default: "Planned" },
        summary: { type: "string", default: "Retry CSV export on empty filter" },
        "secret-env": { type: "string", default: "JIRA_WEBHOOK_SECRET" },
        "changelog-id": { type: "string" },
        print: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  const [url, issueKey, toStatus] = positionals;
  if (url === undefined || issueKey === undefined || toStatus === undefined || positionals.length > 3) {
    console.error(USAGE);
    process.exit(2);
  }
  if (!ISSUE_KEY.test(issueKey)) {
    console.error(`"${issueKey}" is not a Jira issue key such as TLSSN-42.\n${USAGE}`);
    process.exit(2);
  }
  const secretEnv = values["secret-env"];
  const secret = process.env[secretEnv] ?? "";
  if (secret === "") {
    console.error(`Set ${secretEnv} to the slug's webhook secret, or name another variable with --secret-env.`);
    process.exit(2);
  }

  const now = Date.now();
  const body = transitionBody({
    issueKey,
    toStatus,
    fromStatus: values.from,
    changelogId: values["changelog-id"] ?? String(now),
    timestamp: now,
    summary: values.summary,
  });
  const rawBody = JSON.stringify(body);
  const headers = { "content-type": "application/json", "x-hub-signature-256": signature(rawBody, secret) };

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

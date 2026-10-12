import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decideApproved } from "./decide.js";
import { approvedBody } from "./fixtures.js";
import { verifyTrackerWebhook } from "./verify-webhook.js";

const scriptUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/replay-jira-transition.mjs")).href;

type ReplayModule = {
  transitionBody(input: { issueKey: string; toStatus: string; fromStatus: string; changelogId: string; timestamp: number; summary: string }): unknown;
  signature(rawBody: string, secret: string): string;
};

test("the replay script builds the fixture body and signs it the way the worker verifies", async () => {
  const replay = (await import(scriptUrl)) as ReplayModule;
  const body = replay.transitionBody({
    issueKey: "TLSSN-42",
    toStatus: "Approved",
    fromStatus: "Planned",
    changelogId: "10042",
    timestamp: 1_790_000_000_000,
    summary: "Retry CSV export on empty filter",
  });
  assert.deepEqual(body, approvedBody());
  assert.deepEqual(decideApproved(body, { approvedStatus: "Approved", projects: ["TLSSN"] }), {
    launch: true,
    issueKey: "TLSSN-42",
    changelogId: "10042",
    title: "Retry CSV export on empty filter",
  });

  const rawBody = JSON.stringify(body);
  const verify = (hubSignature: string) =>
    verifyTrackerWebhook({ rawBody, linearSignature: null, hubSignature, linearSecret: undefined, jiraSecret: "x", nowMs: 0 });
  assert.deepEqual(verify(replay.signature(rawBody, "x")), { ok: true });
  assert.deepEqual(verify(replay.signature(rawBody, "y")), { ok: false, status: 401 });
});

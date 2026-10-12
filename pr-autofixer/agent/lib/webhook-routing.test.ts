import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitHubCheckSuiteEvent, GitHubEventContext } from "@cursor/july/channels/github";
import { parsePrRef } from "./drive.js";
import { bufferedEventFromCheckSuite, isBugbotCandidate, isBugbotFindings } from "./webhook-routing.js";

test("a red check_suite naming its PR by API URL yields a PR URL drive_pr accepts", async () => {
  const ctx = {
    eventName: "check_suite",
    repository: { owner: "cursor-demo-lab", name: "marsbank", url: "https://github.com/cursor-demo-lab/marsbank" },
    conversation: { kind: "pull_request", number: 8, url: "https://api.github.com/repos/cursor-demo-lab/marsbank/pulls/8" },
  } as unknown as GitHubEventContext;
  const suite = { action: "completed", headSha: "e18392f", conclusion: "failure" } as unknown as GitHubCheckSuiteEvent;
  const event = await bufferedEventFromCheckSuite({ ctx, suite });
  assert.equal(event?.prUrl, "https://github.com/cursor-demo-lab/marsbank/pull/8");
  assert.equal(parsePrRef(event.prUrl)?.label, "cursor-demo-lab/marsbank#8");
});

test("a neutral cursor check_suite is kept as a Bugbot candidate with its app and suite id; anyone else's neutral suite is not", async () => {
  const ctx = {
    eventName: "check_suite",
    repository: { owner: "cursor-demo-lab", name: "marsbank", url: "https://github.com/cursor-demo-lab/marsbank" },
    conversation: { kind: "pull_request", number: 38, url: "https://api.github.com/repos/cursor-demo-lab/marsbank/pulls/38" },
  } as unknown as GitHubEventContext;
  const bugbot = await bufferedEventFromCheckSuite({ ctx, suite: { action: "completed", headSha: "abc1234", conclusion: "neutral", app: { slug: "cursor" }, checkSuiteId: 77 } as unknown as GitHubCheckSuiteEvent });
  assert.equal(bugbot?.checkSuiteId, 77);
  assert.equal(bugbot?.conclusion, "neutral");
  assert.equal(bugbot?.app, "cursor");
  assert.equal(isBugbotCandidate(bugbot!), true, "a candidate until its runs name the Bugbot check");
  assert.equal(isBugbotFindings(bugbot!), false);
  assert.equal(isBugbotFindings({ ...bugbot!, checkName: "Cursor Bugbot" }), true);
  const other = await bufferedEventFromCheckSuite({ ctx, suite: { action: "completed", headSha: "abc1234", conclusion: "neutral", app: { slug: "github-actions" } } as unknown as GitHubCheckSuiteEvent });
  assert.equal(other, null);
});

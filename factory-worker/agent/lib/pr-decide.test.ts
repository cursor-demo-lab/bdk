import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePullRequest, humanMerger, implementPrKey, isHuman, isMergedByComment, mergedByComment, prStatusClaimKey, rawPullRequestFacts, type PrDelivery } from "./pr-decide.js";

const OPTS = { sandboxRepo: "cursor-demo-lab/marsbank", sandboxRef: "main", projects: ["TLSSN"] };

function delivery(overrides: Partial<PrDelivery> = {}): PrDelivery {
  return {
    action: "opened",
    repository: "cursor-demo-lab/marsbank",
    number: 13,
    url: "https://github.com/cursor-demo-lab/marsbank/pull/13",
    headRef: "TLSSN-9-csv-export-zero-rows",
    baseRef: "main",
    title: "TLSSN-9: CSV export returns headers on an empty filter",
    authorLogin: "cursor[bot]",
    merged: false,
    sender: { login: "cursor[bot]", type: "Bot" },
    autoMerge: false,
    ...overrides,
  };
}

const MERGED = { action: "closed", merged: true, sender: { login: "example-user", type: "User" }, mergedBy: { login: "example-user", type: "User" } } as const;

test("an implement PR opening, reopening, going ready, or taking a push is In Review", () => {
  for (const action of ["opened", "reopened", "ready_for_review", "synchronize"]) {
    assert.deepEqual(decidePullRequest(delivery({ action }), OPTS), {
      move: true,
      stage: "in_review",
      issueKey: "TLSSN-9",
      pr: "cursor-demo-lab/marsbank#13",
      url: "https://github.com/cursor-demo-lab/marsbank/pull/13",
    });
  }
});

test("a person merging the implement PR is Done", () => {
  assert.deepEqual(decidePullRequest(delivery(MERGED), OPTS), {
    move: true,
    stage: "done",
    issueKey: "TLSSN-9",
    pr: "cursor-demo-lab/marsbank#13",
    url: "https://github.com/cursor-demo-lab/marsbank/pull/13",
    mergedBy: "example-user",
  });
  // A relay body without merged_by still has the sender, who is the merger.
  const senderOnly = decidePullRequest(delivery({ ...MERGED, mergedBy: undefined }), OPTS);
  assert.equal(senderOnly.move, true);
  assert.equal(senderOnly.move && senderOnly.mergedBy, "example-user");
});

test("the Done decision names merged_by when that actor is a person, else the sender", () => {
  assert.equal(humanMerger({ sender: { login: "example-user", type: "User" }, mergedBy: { login: "alice", type: "User" } }), "alice");
  assert.equal(humanMerger({ sender: { login: "example-user", type: "User" } }), "example-user");
  assert.equal(humanMerger({ sender: { login: "example-user", type: "User" }, mergedBy: { login: "cursor[bot]", type: "Bot" } }), "example-user");
  assert.equal(humanMerger({ sender: { login: "cursor[bot]", type: "Bot" } }), undefined);
  assert.equal(mergedByComment("example-user"), "Merged by: example-user");
  assert.equal(isMergedByComment("Merged by: example-user", "example-user"), true);
  assert.equal(isMergedByComment("Merged by: alice", "example-user"), false);
  assert.equal(isMergedByComment("see Merged by: example-user"), false);
  assert.equal(isMergedByComment("Merged by:"), false);
});

test("a merge by a bot, an app, or GitHub auto-merge never moves the ticket to Done", () => {
  const cases: [Partial<PrDelivery>, string][] = [
    [{ ...MERGED, sender: { login: "cursor[bot]", type: "Bot" }, mergedBy: { login: "cursor[bot]", type: "Bot" } }, "not_human_merge"],
    [{ ...MERGED, sender: { login: "github-actions[bot]", type: "User" } }, "not_human_merge"],
    [{ ...MERGED, mergedBy: { login: "cursor[bot]", type: "Bot" } }, "not_human_merge"],
    [{ ...MERGED, sender: { login: "example-user" } }, "not_human_merge"],
    [{ ...MERGED, autoMerge: true }, "auto_merge"],
    [{ ...MERGED, sender: undefined }, "merger_unknown"],
  ];
  for (const [overrides, reason] of cases) {
    assert.deepEqual(decidePullRequest(delivery(overrides), OPTS), { move: false, reason, issueKey: "TLSSN-9" }, reason);
  }
});

test("a closed PR that was not merged, and actions that are not open or merge, move nothing", () => {
  assert.deepEqual(decidePullRequest(delivery({ action: "closed", sender: { login: "example-user", type: "User" } }), OPTS), {
    move: false,
    reason: "closed_unmerged",
    issueKey: "TLSSN-9",
  });
  for (const action of ["edited", "labeled", "converted_to_draft", "review_requested"]) {
    assert.deepEqual(decidePullRequest(delivery({ action }), OPTS), { move: false, reason: "ignored_action", issueKey: "TLSSN-9" }, action);
  }
});

test("only implement PRs on the sandbox into the sandbox ref count", () => {
  assert.deepEqual(decidePullRequest(delivery({ repository: "example-org/demo-repo" }), OPTS), { move: false, reason: "out_of_scope" });
  assert.equal(decidePullRequest(delivery({ repository: "Cursor-Demo-Lab/Marsbank" }), OPTS).move, true);
  assert.deepEqual(decidePullRequest(delivery({ baseRef: "release" }), OPTS), { move: false, reason: "wrong_base", issueKey: "TLSSN-9" });
  assert.deepEqual(decidePullRequest(delivery({ headRef: "topic", title: "Refactor" }), OPTS), { move: false, reason: "not_factory_pr" });
  assert.deepEqual(decidePullRequest(delivery(), { ...OPTS, projects: [] }), { move: false, reason: "not_factory_pr" });
  assert.deepEqual(decidePullRequest(delivery({ headRef: "DEMO-1-x", title: "DEMO-1: x" }), OPTS), { move: false, reason: "not_factory_pr" });
});

test("the key comes from the head branch; a title alone counts only when cursor[bot] opened the PR", () => {
  assert.equal(implementPrKey({ headRef: "TLSSN-12-fix", title: "unrelated", authorLogin: "example-user", projects: ["TLSSN"] }), "TLSSN-12");
  assert.equal(implementPrKey({ headRef: "cursor/fix-csv", title: "TLSSN-12: fix", authorLogin: "cursor[bot]", projects: ["TLSSN"] }), "TLSSN-12");
  assert.equal(implementPrKey({ headRef: "cursor/fix-csv", title: "TLSSN-12: fix", authorLogin: "example-user", projects: ["TLSSN"] }), undefined);
  assert.equal(implementPrKey({ headRef: "fix/TLSSN-12", title: undefined, authorLogin: "cursor[bot]", projects: ["TLSSN"] }), undefined);
  assert.equal(implementPrKey({ headRef: "tlssn-12-fix", title: undefined, authorLogin: undefined, projects: ["TLSSN"] }), undefined);
});

test("isHuman needs type User and no [bot] suffix", () => {
  assert.equal(isHuman({ login: "example-user", type: "User" }), true);
  assert.equal(isHuman({ login: "cursor[bot]", type: "Bot" }), false);
  assert.equal(isHuman({ login: "renovate[bot]", type: "User" }), false);
  assert.equal(isHuman({ login: "example-user", type: "Bot" }), false);
  assert.equal(isHuman({ login: "", type: "User" }), false);
  assert.equal(isHuman({ type: "User" }), false);
});

test("rawPullRequestFacts reads merged_by and auto_merge from the webhook body", () => {
  assert.deepEqual(rawPullRequestFacts({ pull_request: { merged_by: { login: "example-user", type: "User" }, auto_merge: null } }), {
    mergedBy: { login: "example-user", type: "User" },
    autoMerge: false,
  });
  assert.deepEqual(rawPullRequestFacts({ pull_request: { auto_merge: { merge_method: "squash" } } }), { autoMerge: true });
  assert.deepEqual(rawPullRequestFacts(undefined), { autoMerge: false });
  assert.deepEqual(rawPullRequestFacts({ pull_request: [] }), { autoMerge: false });
});

test("the claim key names the ticket, the stage, and the pull request", () => {
  assert.equal(prStatusClaimKey({ issueKey: "TLSSN-9", stage: "done", pr: "cursor-demo-lab/marsbank#13" }), "pr-status/TLSSN-9/done/cursor-demo-lab/marsbank#13");
});

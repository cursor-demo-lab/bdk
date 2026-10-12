import assert from "node:assert/strict";
import { test } from "node:test";
import { factoryDraftKey, factoryIssueKey } from "./factory-pr.js";

const projects = ["TLSSN", "DEMO"];

test("the key comes from the head branch, then the title", () => {
  assert.equal(factoryIssueKey({ headRef: "TLSSN-8-csv-export", title: "DEMO-2: other", projects }), "TLSSN-8");
  assert.equal(factoryIssueKey({ headRef: "topic", title: " DEMO-12: fix ", projects }), "DEMO-12");
});

test("the key must lead, carry digits, and belong to a listed project", () => {
  assert.equal(factoryIssueKey({ headRef: "fix-TLSSN-8", title: "Fix TLSSN-8", projects }), undefined);
  assert.equal(factoryIssueKey({ headRef: "TLSSN-x", title: "TLSSN: nothing", projects }), undefined);
  assert.equal(factoryIssueKey({ headRef: "OTHER-3-thing", title: "OTHER-3: thing", projects }), undefined);
  assert.equal(factoryIssueKey({ headRef: "tlssn-8-lower", title: undefined, projects }), undefined);
});

test("no projects means no factory PR", () => {
  assert.equal(factoryIssueKey({ headRef: "TLSSN-8-csv-export", title: "TLSSN-8: x", projects: [] }), undefined);
});

// The branch and title cases of pr-autofixer/agent/lib/auto-drive.test.ts
// "autoDriveDecision", with the fixer's expected key or its not_a_factory_pr.
test("the key rule gives the fixer's answer on the fixer's cases", () => {
  const fixer = ["TLSSN"];
  const cases: [string | undefined, string | undefined, string | undefined][] = [
    ["TLSSN-42-retry-csv-export", "Retry export", "TLSSN-42"],
    ["feature/x", "TLSSN-7: fix", "TLSSN-7"],
    ["fix-typo", "Fix typo", undefined],
    ["OPS-1-thing", "OPS-1", undefined],
    ["TLSSN-3-x", "x", "TLSSN-3"],
    [undefined, undefined, undefined],
  ];
  for (const [headRef, title, key] of cases) {
    assert.equal(factoryIssueKey({ headRef, title, projects: fixer }), key, `${headRef} / ${title}`);
  }
});

test("where the reviewer and the fixer differ: a person's title-only key is the fixer's, not an early review", () => {
  const human = { headRef: "feature/x", title: "TLSSN-7: fix", projects };
  assert.equal(factoryIssueKey(human), "TLSSN-7");
  assert.equal(factoryDraftKey({ ...human, authorLogin: "example-user" }), undefined);
  assert.equal(factoryDraftKey({ ...human, authorLogin: "cursor[bot]" }), "TLSSN-7");
});

test("a draft's branch key counts from anyone; a title-only key counts only from the Cursor bot", () => {
  const draft = (headRef: string, title: string, authorLogin: string | undefined) => factoryDraftKey({ headRef, title, authorLogin, projects });
  assert.equal(draft("TLSSN-8-csv", "Work in progress", "example-user"), "TLSSN-8");
  assert.equal(draft("wip", "TLSSN-8: CSV export", "cursor[bot]"), "TLSSN-8");
  assert.equal(draft("wip", "TLSSN-8: CSV export", "example-user"), undefined);
  assert.equal(draft("wip", "TLSSN-8: CSV export", undefined), undefined);
  assert.equal(draft("wip", "TLSSN-8: CSV export", "Cursor[bot]"), undefined);
});

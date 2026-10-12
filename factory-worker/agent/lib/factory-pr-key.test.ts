import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_BOT, factoryPrKey, issueKeyAtStart } from "./factory-pr-key.js";

const projects = ["TLSSN", "DEMO"];

test("issueKeyAtStart takes the key a trimmed text starts with, from a listed project only", () => {
  assert.equal(issueKeyAtStart("TLSSN-8-csv-export", projects), "TLSSN-8");
  assert.equal(issueKeyAtStart("  DEMO-12: fix  ", projects), "DEMO-12");
  assert.equal(issueKeyAtStart("TLSSN-42", ["TL", "TLSSN"]), "TLSSN-42");
  assert.equal(issueKeyAtStart("fix/TLSSN-8", projects), undefined);
  assert.equal(issueKeyAtStart("Fix TLSSN-8", projects), undefined);
  assert.equal(issueKeyAtStart("TLSSN-x", projects), undefined);
  assert.equal(issueKeyAtStart("tlssn-8-lower", projects), undefined);
  assert.equal(issueKeyAtStart("OTHER-3-thing", projects), undefined);
  assert.equal(issueKeyAtStart(undefined, projects), undefined);
  assert.equal(issueKeyAtStart("TLSSN-8", []), undefined);
});

test("issueKeyAtStart matches a project name literally", () => {
  assert.equal(issueKeyAtStart("A.B-1", ["A.B"]), "A.B-1");
  assert.equal(issueKeyAtStart("AXB-1", ["A.B"]), undefined);
});

test("factoryPrKey: a keyed branch counts whoever opened the PR", () => {
  for (const authorLogin of [CURSOR_BOT, "example-user", undefined]) {
    assert.equal(factoryPrKey({ headRef: "TLSSN-12-fix", title: "unrelated", authorLogin, projects }), "TLSSN-12");
  }
  assert.equal(factoryPrKey({ headRef: "TLSSN-12-fix", title: "DEMO-3: other", authorLogin: CURSOR_BOT, projects }), "TLSSN-12");
});

test("factoryPrKey: a keyed title alone counts only when cursor[bot], exactly, opened the PR", () => {
  assert.equal(CURSOR_BOT, "cursor[bot]");
  assert.equal(factoryPrKey({ headRef: "cursor/fix-csv", title: "TLSSN-12: fix", authorLogin: "cursor[bot]", projects }), "TLSSN-12");
  for (const authorLogin of ["example-user", "Cursor[bot]", "cursor", " cursor[bot]", undefined]) {
    assert.equal(factoryPrKey({ headRef: "cursor/fix-csv", title: "TLSSN-12: fix", authorLogin, projects }), undefined, String(authorLogin));
  }
  assert.equal(factoryPrKey({ title: "TLSSN-12: fix", authorLogin: CURSOR_BOT, projects }), "TLSSN-12");
});

test("factoryPrKey finds nothing without a listed project", () => {
  assert.equal(factoryPrKey({ headRef: "TLSSN-12-fix", title: "TLSSN-12: fix", authorLogin: CURSOR_BOT, projects: [] }), undefined);
  assert.equal(factoryPrKey({ headRef: "fix/TLSSN-12", title: "Fix TLSSN-12", authorLogin: CURSOR_BOT, projects }), undefined);
});

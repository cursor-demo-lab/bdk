import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudOptionsFor, continuationTokenFor, githubPrRef, prRefFromContinuationToken } from "./drive.js";

const PR = githubPrRef({ owner: "acme-org", repo: "billing", number: 5, url: "https://github.com/acme-org/billing/pull/5" });

test("the cloud agent checks out the PR's own repository and attaches to that PR", () => {
  assert.deepEqual(cloudOptionsFor(PR), { repos: [{ url: "https://github.com/acme-org/billing", prUrl: "https://github.com/acme-org/billing/pull/5" }] });
});

test("the drive token names owner, repo and number, so same-named repos under two owners never share a session", () => {
  const fork = githubPrRef({ owner: "someone-else", repo: "billing", number: 5, url: "https://github.com/someone-else/billing/pull/5" });
  assert.equal(continuationTokenFor(PR), "pr:acme-org/billing#5");
  assert.notEqual(continuationTokenFor(fork), continuationTokenFor(PR));
  assert.equal(prRefFromContinuationToken(continuationTokenFor(PR))?.label, "acme-org/billing#5");
});

test("only a pr: token names a PR; an evt: delivery or other key does not", () => {
  for (const token of ["evt:acme-org/billing#5", "issue:acme-org/billing#5", "acme-org/billing#5", null, undefined]) {
    assert.equal(prRefFromContinuationToken(token), undefined, String(token));
  }
});

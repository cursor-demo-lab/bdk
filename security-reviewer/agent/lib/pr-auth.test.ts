import assert from "node:assert/strict";
import { test } from "node:test";
import { prReviewAuth } from "./pr-auth.js";

test("the review session principal is the PR, whoever sent the event", () => {
  const opener = { authenticator: "github-webhook", principalId: "github:111", principalType: "user", attributes: { repository: "o/r" } } as const;
  const pusher = { ...opener, principalId: "github:222" } as const;
  const a = prReviewAuth(opener as never, "o/r", 9);
  const b = prReviewAuth(pusher as never, "o/r", 9);
  assert.ok(a !== null && b !== null);
  assert.equal(a.principalId, "github-pr:o/r#9");
  assert.equal(a.principalId, b.principalId);
  assert.equal(a.principalType, "service");
  assert.deepEqual(a.attributes, opener.attributes);
});

test("no auth stays no auth", () => {
  assert.equal(prReviewAuth(null, "o/r", 9), null);
});

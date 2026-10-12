import assert from "node:assert/strict";
import { test } from "node:test";
import { prSessionKey } from "./session-key.js";

test("prSessionKey strips the hosted cont: prefix and keeps bare keys", () => {
  assert.equal(prSessionKey("cont:github-pr:cursor-demo-lab/marsbank#9"), "github-pr:cursor-demo-lab/marsbank#9");
  assert.equal(prSessionKey("github-pr:cursor-demo-lab/marsbank#9"), "github-pr:cursor-demo-lab/marsbank#9");
  assert.equal(prSessionKey(null), "");
  assert.equal(prSessionKey(undefined), "");
});

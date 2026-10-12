import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { history, parseLog, repoPath } from "./git.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "planner-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  git("init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "Add export job (#88)");
  writeFileSync(join(dir, "src", "a.ts"), "b");
  git("commit", "-q", "-am", "Guard empty rows");
  return dir;
}

test("parseLog reads the fixed format and lifts the PR number", () => {
  const commits = parseLog("abc\u001f2026-09-01\u001fAda\u001fAdd export job (#88)\n");
  assert.deepEqual(commits, [{ sha: "abc", date: "2026-09-01", author: "Ada", subject: "Add export job (#88)", pr: 88 }]);
  assert.equal(parseLog("")[0], undefined);
});

test("repoPath keeps the model inside the checkout", () => {
  const dir = repo();
  assert.equal(repoPath(dir, undefined), ".");
  assert.equal(repoPath(dir, "src/a.ts"), join("src", "a.ts"));
  assert.equal(repoPath(dir, "../outside"), undefined);
  assert.equal(repoPath(dir, "/etc/passwd"), undefined);
  assert.equal(repoPath(dir, "src/missing.ts"), undefined);
});

test("history answers no_checkout without a checkout and lists commits with one", async () => {
  assert.deepEqual(await history(undefined, {}), { available: false, reason: "no_checkout" });
  const dir = repo();
  const all = await history(dir, { limit: 10 });
  assert.equal(all.available, true);
  if (!all.available) return;
  assert.equal(all.commits.length, 2);
  assert.equal(all.commits[0]?.subject, "Guard empty rows");
  assert.equal(all.commits[1]?.pr, 88);
  const escaped = await history(dir, { path: "../x" });
  assert.equal(escaped.available, false);
  const missing = await history(dir, { path: "src/nope.ts" });
  assert.deepEqual(missing, { available: false, reason: "path_missing" });
});

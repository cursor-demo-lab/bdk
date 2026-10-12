import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CHECKOUT_ENV } from "../lib/checkout.js";
import gitHistory from "./git_history.js";

// git_history dispatches on the checkout at execute time: without one it must
// read the GitHub commits of the sandbox ref (the only path a hosted planner
// host takes), with one it must read the local clone. Both layers below the
// tool are unit-tested (lib/sandbox.test.ts, lib/git.test.ts); these cases
// hold the tool's dispatch itself, so dropping the GitHub fallback cannot
// survive the suite. The tool reads process.env, so the env is set for real
// and restored after each case, as plan_issue.test.ts does.
const ENV_NAMES = [CHECKOUT_ENV, "FACTORY_ENV", "FACTORY_SANDBOX_REPO", "FACTORY_SANDBOX_REF", "FACTORY_REPOS", "FACTORY_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>): void {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_SANDBOX_REF: "main", ...values });
}

const COMMITS = [
  { sha: "abc1234def5678", commit: { message: "Add CSV export (#42)\n\nBody", author: { name: "Ada", date: "2026-09-30T12:00:00Z" } } },
];

test("without a checkout the tool reads the GitHub commits of the sandbox ref through ctx.host.github", async () => {
  setEnv({});
  const seen: Record<string, unknown>[] = [];
  const github = {
    getOctokit: async () => ({
      request: async (route: string, params: Record<string, unknown>) => {
        assert.equal(route, "GET /repos/{owner}/{repo}/commits");
        seen.push(params);
        return { data: COMMITS };
      },
    }),
  };
  const result = (await gitHistory.execute!({ path: "lib", limit: 3 } as never, { host: { github } } as never)) as Record<string, unknown>;
  assert.deepEqual(seen, [{ owner: "cursor-demo-lab", repo: "marsbank", sha: "main", per_page: 3, path: "lib" }]);
  assert.equal(result["available"], true);
  assert.equal(result["source"], "github");
  assert.deepEqual(result["commits"], [{ sha: "abc1234", date: "2026-09-30", author: "Ada", subject: "Add CSV export (#42)", pr: 42 }]);
});

test("with a checkout the tool reads the local clone and never calls GitHub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-git-history-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  git("init", "-q");
  writeFileSync(join(dir, "a.ts"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "Add export job (#88)");
  const sha = execFileSync("git", ["log", "-n1", "--format=%h"], { cwd: dir }).toString().trim();
  setEnv({ [CHECKOUT_ENV]: dir });
  const result = (await gitHistory.execute!({ limit: 5 } as never, { host: {} } as never)) as Record<string, unknown>;
  assert.equal(result["available"], true);
  assert.equal(result["source"], undefined);
  assert.deepEqual(result["commits"], [{ sha, date: new Date().toISOString().slice(0, 10), author: "t", subject: "Add export job (#88)", pr: 88 }]);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const OVERRIDE = "PR_AUTOFIXER_REPOS";

function run(code: string, scope: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["FACTORY_REPOS", "SECURITY_REVIEWER_REPOS", "PR_AUTOFIXER_REPOS", "FACTORY_SANDBOX_REPO"]) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
  });
}

test("reads the override, then FACTORY_REPOS", () => {
  const override = run(
    [
      'import { githubRepos } from "./agent/lib/repos.ts";',
      "const repos = githubRepos();",
      'if (JSON.stringify(repos) !== JSON.stringify(["acme/one","acme/two"])) throw new Error(JSON.stringify(repos));',
    ].join("\n"),
    { [OVERRIDE]: " acme/one, acme/two " }
  );
  assert.equal(override.status, 0, override.stderr);

  const shared = run(
    [
      'import { githubRepos } from "./agent/lib/repos.ts";',
      "const repos = githubRepos();",
      'if (JSON.stringify(repos) !== JSON.stringify(["acme/shared"])) throw new Error(JSON.stringify(repos));',
    ].join("\n"),
    { FACTORY_REPOS: "acme/shared" }
  );
  assert.equal(shared.status, 0, shared.stderr);
});

test("import succeeds when both repository variables are unset; githubRepos throws when called", () => {
  const loaded = run('import "./agent/lib/repos.ts";', {});
  assert.equal(loaded.status, 0, loaded.stderr);

  const called = run(
    [
      'import { githubRepos } from "./agent/lib/repos.ts";',
      "githubRepos();",
    ].join("\n"),
    {}
  );
  assert.notEqual(called.status, 0);
  const output = `${called.stderr}\n${called.stdout}`;
  assert.match(output, /FactoryConfigError/);
  assert.match(output, /PR_AUTOFIXER_REPOS/);
  assert.match(output, /FACTORY_REPOS/);
});


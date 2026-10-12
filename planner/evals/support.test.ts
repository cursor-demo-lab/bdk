import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { searchSandbox } from "../agent/lib/sandbox.js";
import { EVAL_ENV, applyEvalEnv, sandboxUnavailable, searchedWorkspaceWithout } from "./support.js";

const ENV = { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_SANDBOX_REF: "main" };

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planner-eval-"));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return root;
}

test("eval defaults fill unset or blank settings and never replace a set one", () => {
  const env: NodeJS.ProcessEnv = { FACTORY_SANDBOX_REPO: "someone/elsewhere", FACTORY_SANDBOX_REF: "  " };
  applyEvalEnv(env);
  assert.equal(env.FACTORY_SANDBOX_REPO, "someone/elsewhere");
  assert.equal(env.FACTORY_SANDBOX_REF, "main");
  assert.equal(env.FACTORY_REPOS, EVAL_ENV.FACTORY_REPOS);
  assert.equal(env.FACTORY_JIRA_PROJECTS, "TLSSN");
});

test("a CSV search over a seeded tree without CSV code is checked evidence", async () => {
  const root = await workspace({
    "src/transfers/transfer.ts": "export const TRANSFER_REFERENCE_MAX = 60;\n",
    "src/transfers/move-tokens-form.tsx": "export function MoveTokensForm() { return null; }\n",
  });
  try {
    for (const query of ["csv export 500", "export"]) {
      const result = await searchSandbox({ query, workspaceDir: root, env: ENV });
      assert.equal(searchedWorkspaceWithout(/csv/i)(result), true, query);
      assert.equal(searchedWorkspaceWithout(/csv/i)(JSON.stringify(result)), true, `${query} as JSON text`);
      assert.equal(sandboxUnavailable(result), false, query);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tree that has CSV code does not pass as absent", async () => {
  const root = await workspace({ "src/export/csv.ts": "export function runExport() {}\n" });
  try {
    const result = await searchSandbox({ query: "csv export 500", workspaceDir: root, env: ENV });
    assert.equal(searchedWorkspaceWithout(/csv/i)(result), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable GitHub tree is not evidence the code is absent", async () => {
  const forbidden = async () => ({ ok: false, status: 403, text: async () => "" });
  const result = await searchSandbox({ query: "csv export 500", env: { ...ENV, FACTORY_GITHUB_TOKEN: "t" }, fetch: forbidden });
  assert.equal(result.available, false);
  assert.equal(sandboxUnavailable(result), true);
  assert.equal(searchedWorkspaceWithout(/csv/i)(result), false);
});

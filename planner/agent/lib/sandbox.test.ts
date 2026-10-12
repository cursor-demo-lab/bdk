import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { existingSandboxPaths, githubToken, queryTokens, sandboxHistory, searchSandbox, type GitHubTreeClient } from "./sandbox.js";

const env = { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_SANDBOX_REF: "main" };

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "planner-tree-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "accounts.ts"), "export function listAccounts() { return []; }\n");
  writeFileSync(join(root, "README.md"), "# marsbank\n");
  return root;
}

test("queryTokens keeps path-shaped words and drops export-as-keyword", () => {
  assert.deepEqual(queryTokens("CSV export 500"), ["csv", "500"]);
  assert.deepEqual(queryTokens("src/export/csv.ts"), ["src/export/csv.ts"]);
});

test("githubToken prefers FACTORY_GITHUB_TOKEN", () => {
  assert.equal(githubToken({}), undefined);
  assert.equal(githubToken({ GITHUB_TOKEN: "g", FACTORY_GITHUB_TOKEN: "f" }), "f");
  assert.equal(githubToken({ GH_TOKEN: "h" }), "h");
});

test("searchSandbox reads the workspace and skips an empty tree", async () => {
  const workspaceDir = fixture();
  const hit = await searchSandbox({ query: "accounts", workspaceDir, env });
  assert.equal(hit.available, true);
  assert.equal(hit.source, "workspace");
  assert.deepEqual(hit.paths, ["lib/accounts.ts"]);
  assert.match(hit.matches[0]?.snippet ?? "", /listAccounts/);

  const miss = await searchSandbox({ query: "csv export", workspaceDir, env });
  assert.equal(miss.available, true);
  assert.deepEqual(miss.paths, []);
  assert.ok(miss.treeSample.includes("lib/accounts.ts"));

  const empty = mkdtempSync(join(tmpdir(), "planner-empty-"));
  const unread = await searchSandbox({ query: "accounts", workspaceDir: empty, env });
  assert.equal(unread.available, false);
  assert.equal(unread.reason, "github_unavailable");
});

test("existingSandboxPaths accepts files on the workspace and rejects a missing cite", async () => {
  const workspaceDir = fixture();
  const check = await existingSandboxPaths({
    paths: ["lib/accounts.ts", "lib/transactions-csv.ts", "../secret"],
    workspaceDir,
    env,
  });
  assert.deepEqual(check.found, ["lib/accounts.ts"]);
  assert.deepEqual(check.missing, ["lib/transactions-csv.ts"]);
});

function treeClient(): GitHubTreeClient {
  const bodies: Record<string, string> = {
    "lib/accounts.ts": "export function listAccounts() { return []; }\n",
    "README.md": "# marsbank\n",
  };
  return {
    getOctokit: async () => ({
      request: async (route: string, params: Record<string, unknown>) => {
        assert.equal(params["owner"], "cursor-demo-lab");
        assert.equal(params["repo"], "marsbank");
        if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
          assert.equal(params["tree_sha"], "main");
          return {
            data: {
              tree: [
                { path: "lib/accounts.ts", type: "blob" },
                { path: "app", type: "tree" },
                { path: "README.md", type: "blob" },
              ],
            },
          };
        }
        if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
          const path = String(params["path"] ?? "");
          const body = bodies[path];
          assert.ok(body !== undefined, `unexpected contents path ${path}`);
          assert.equal(params["ref"], "main");
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(body).toString("base64"),
              size: body.length,
            },
          };
        }
        assert.fail(`unexpected route ${route}`);
      },
    }),
  };
}

test("searchSandbox reads the GitHub tree through host.github without a token", async () => {
  const github = treeClient();
  const found = await searchSandbox({ query: "accounts", env, github });
  assert.equal(found.available, true);
  assert.equal(found.source, "github");
  assert.deepEqual(found.paths, ["lib/accounts.ts"]);
  assert.match(found.matches[0]?.snippet ?? "", /listAccounts/);

  const csv = await searchSandbox({ query: "csv export", env, github });
  assert.equal(csv.available, true);
  assert.deepEqual(csv.paths, []);

  const paths = await existingSandboxPaths({
    paths: ["lib/accounts.ts", "lib/transactions-csv.ts"],
    env,
    github,
  });
  assert.deepEqual(paths.found, ["lib/accounts.ts"]);
  assert.deepEqual(paths.missing, ["lib/transactions-csv.ts"]);
});

test("searchSandbox falls back to an optional token when host.github is missing", async () => {
  const fetch = async (url: string) => {
    if (/git\/trees\/main/.test(url)) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            tree: [
              { path: "lib/accounts.ts", type: "blob" },
              { path: "app", type: "tree" },
              { path: "README.md", type: "blob" },
            ],
          }),
      };
    }
    assert.match(url, /contents\/lib\/accounts\.ts/);
    const body = "export function listAccounts() { return []; }\n";
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from(body).toString("base64"),
          size: body.length,
        }),
    };
  };
  const found = await searchSandbox({
    query: "accounts",
    env: { ...env, FACTORY_GITHUB_TOKEN: "tok" },
    fetch,
  });
  assert.equal(found.available, true);
  assert.equal(found.source, "github");
  assert.deepEqual(found.paths, ["lib/accounts.ts"]);
  assert.match(found.matches[0]?.snippet ?? "", /listAccounts/);
});

const COMMITS = [
  { sha: "abc1234def5678", commit: { message: "Add CSV export (#42)\n\nBody", author: { name: "Ada", date: "2026-09-30T12:00:00Z" } } },
  { sha: "0123456789abcd", commit: { message: "Initial commit", author: { name: "Lin", date: "2026-09-01T08:00:00Z" } } },
];

test("without a checkout git history comes from the GitHub commits of the sandbox ref", async () => {
  const seen: Record<string, unknown>[] = [];
  const github: GitHubTreeClient = {
    getOctokit: async () => ({
      request: async (route: string, params: Record<string, unknown>) => {
        assert.equal(route, "GET /repos/{owner}/{repo}/commits");
        seen.push(params);
        return { data: COMMITS };
      },
    }),
  };
  const result = await sandboxHistory({ path: "./lib/accounts.ts", limit: 5, env, github });
  assert.deepEqual(seen, [{ owner: "cursor-demo-lab", repo: "marsbank", sha: "main", per_page: 5, path: "lib/accounts.ts" }]);
  assert.deepEqual(result, {
    available: true,
    source: "github",
    repo: "cursor-demo-lab/marsbank",
    ref: "main",
    path: "lib/accounts.ts",
    commits: [
      { sha: "abc1234", date: "2026-09-30", author: "Ada", subject: "Add CSV export (#42)", pr: 42 },
      { sha: "0123456", date: "2026-09-01", author: "Lin", subject: "Initial commit" },
    ],
  });
});

test("GitHub history falls back to the token and names an unreadable repository", async () => {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(COMMITS) };
  };
  const ok = await sandboxHistory({ env: { ...env, FACTORY_GITHUB_TOKEN: "t" }, fetch });
  assert.equal(ok.available, true);
  assert.deepEqual(urls, ["https://api.github.com/repos/cursor-demo-lab/marsbank/commits?sha=main&per_page=20"]);

  const denied = await sandboxHistory({
    env: { ...env, FACTORY_GITHUB_TOKEN: "t" },
    fetch: async () => ({ ok: false, status: 404, text: async () => "" }),
  });
  assert.deepEqual(denied, { available: false, reason: "github_unavailable" });
  assert.deepEqual(await sandboxHistory({ env }), { available: false, reason: "github_unavailable" });
  assert.deepEqual(await sandboxHistory({ path: "../etc", env }), { available: false, reason: "path_outside_checkout" });
});

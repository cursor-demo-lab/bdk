import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { sandboxRef, sandboxRepo } from "./config.js";
import { commitFields, historyLimit, repoPath, type Commit, type HistoryResult } from "./git.js";

// Read-only view of the factory sandbox. The hosted planner has no local
// clone (`FACTORY_PLANNER_CHECKOUT` unset by design), so this walks the
// session workspace first and, when that is empty, the GitHub tree for
// FACTORY_SANDBOX_REPO via `ctx.host.github` (cursorAccount pass-through).
// Path checks use the same sources so record_plan cannot cite a file that
// is not on that ref. FACTORY_GITHUB_TOKEN is an optional local override.

const SKIP_DIR = new Set([".git", "node_modules", ".cursor", "dist"]);
const TOKEN = /[a-z0-9./_-]{2,}/g;
// Words that appear in almost every module. A ticket like "CSV export 500"
// must not treat `export function` as evidence the feature exists.
const STOP = new Set([
  "export",
  "import",
  "function",
  "return",
  "error",
  "file",
  "empty",
  "filter",
  "from",
  "into",
  "with",
  "that",
  "this",
  "when",
  "then",
  "rows",
  "row",
  "the",
  "and",
  "for",
  "on",
  "to",
  "of",
]);
const TREE_SAMPLE = 40;
const MATCH_CAP = 20;
const SNIPPET = 200;
const FILE_BYTES = 64 * 1024;

const TOKEN_ENVS = ["FACTORY_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const;

/** Narrow Octokit surface used to read the sandbox tree. Hosted tools pass `ctx.host.github`. */
export type GitHubTreeClient = {
  getOctokit(): Promise<{
    request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
  }>;
};

export type SandboxMatch = { path: string; snippet: string };

export type SandboxSearch = {
  available: boolean;
  source: "workspace" | "github" | "none";
  repo: string;
  ref: string;
  query: string;
  paths: string[];
  matches: SandboxMatch[];
  treeSample: string[];
  reason?: "empty_workspace" | "github_unavailable" | "github_failed";
};

export type PathCheck = {
  available: boolean;
  source: "workspace" | "github" | "none";
  repo: string;
  ref: string;
  found: string[];
  missing: string[];
};

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export function githubToken(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of TOKEN_ENVS) {
    const value = env[name]?.trim() ?? "";
    if (value !== "") return value;
  }
  return undefined;
}

export function queryTokens(query: string): string[] {
  const all = [...query.toLowerCase().matchAll(TOKEN)].map((match) => match[0]);
  const distinctive = all.filter((token) => !STOP.has(token) || token.includes("/") || token.includes("."));
  return distinctive.length > 0 ? distinctive : all;
}

export async function searchSandbox(input: {
  query: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  github?: GitHubTreeClient;
  fetch?: FetchLike;
}): Promise<SandboxSearch> {
  const repo = sandboxRepo(input.env);
  const ref = sandboxRef(input.env);
  const query = input.query.trim();
  const tokens = queryTokens(query);
  const workspace = await workspaceFiles(input.workspaceDir);
  if (workspace !== undefined) {
    const matches = matchFiles(workspace, tokens).slice(0, MATCH_CAP);
    return {
      available: true,
      source: "workspace",
      repo,
      ref,
      query,
      paths: matches.map((match) => match.path),
      matches,
      treeSample: workspace.paths.slice(0, TREE_SAMPLE),
    };
  }
  const tree = await githubTree({ repo, ref, env: input.env, github: input.github, fetch: input.fetch });
  if (!tree.ok) {
    return {
      available: false,
      source: "none",
      repo,
      ref,
      query,
      paths: [],
      matches: [],
      treeSample: [],
      reason: tree.reason,
    };
  }
  const pathHits = matchPaths(tree.paths, tokens).slice(0, MATCH_CAP);
  const matches = await hydrateGithubMatches({
    matches: pathHits,
    tokens,
    repo,
    ref,
    env: input.env,
    github: input.github,
    fetch: input.fetch,
  });
  return {
    available: true,
    source: "github",
    repo,
    ref,
    query,
    paths: matches.map((match) => match.path),
    matches,
    treeSample: tree.paths.slice(0, TREE_SAMPLE),
  };
}

export async function existingSandboxPaths(input: {
  paths: readonly string[];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  github?: GitHubTreeClient;
  fetch?: FetchLike;
}): Promise<PathCheck> {
  const repo = sandboxRepo(input.env);
  const ref = sandboxRef(input.env);
  const wanted = uniquePaths(input.paths);
  const found: string[] = [];
  const unknown: string[] = [];
  for (const path of wanted) {
    if (input.workspaceDir !== undefined && repoPath(input.workspaceDir, path) !== undefined) found.push(path);
    else unknown.push(path);
  }
  if (unknown.length === 0) {
    return { available: true, source: "workspace", repo, ref, found, missing: [] };
  }
  const tree = await githubTree({ repo, ref, env: input.env, github: input.github, fetch: input.fetch });
  if (!tree.ok) {
    return {
      available: found.length > 0,
      source: found.length > 0 ? "workspace" : "none",
      repo,
      ref,
      found,
      missing: unknown,
    };
  }
  const have = new Set(tree.paths);
  const fromGithub: string[] = [];
  const missing: string[] = [];
  for (const path of unknown) {
    if (have.has(path)) fromGithub.push(path);
    else missing.push(path);
  }
  return {
    available: true,
    source: found.length > 0 ? "workspace" : "github",
    repo,
    ref,
    found: [...found, ...fromGithub],
    missing,
  };
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/^\.\//, "");
    if (path === "" || path.startsWith("..") || path.startsWith(sep) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

type Workspace = { paths: string[]; contents: Map<string, string> };

async function workspaceFiles(root: string | undefined): Promise<Workspace | undefined> {
  if (root === undefined || !existsSync(root)) return undefined;
  const contents = new Map<string, string>();
  await walk(root, root, contents);
  if (contents.size === 0) return undefined;
  return { paths: [...contents.keys()].sort(), contents };
}

async function walk(root: string, dir: string, out: Map<string, string>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let rel: string;
    try {
      rel = relative(root, full);
    } catch {
      continue;
    }
    if (rel.startsWith("..") || rel.startsWith(sep)) continue;
    if (await isDir(full)) {
      await walk(root, full, out);
      continue;
    }
    try {
      out.set(rel, (await readFile(full, { encoding: "utf8" })).slice(0, FILE_BYTES));
    } catch {
      // Skip unreadable files; the tree still lists what we could open.
    }
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function matchFiles(workspace: Workspace, tokens: string[]): SandboxMatch[] {
  if (tokens.length === 0) return workspace.paths.map((path) => ({ path, snippet: "" }));
  const scored: Array<SandboxMatch & { hits: number }> = [];
  for (const path of workspace.paths) {
    const text = workspace.contents.get(path) ?? "";
    const haystack = `${path}\n${text}`.toLowerCase();
    const hits = tokens.filter((token) => haystack.includes(token));
    if (hits.length === 0) continue;
    scored.push({ path, snippet: snippetAround(text, hits[0]!), hits: hits.length });
  }
  const all = scored.filter((match) => match.hits === tokens.length);
  return (all.length > 0 ? all : scored).map(({ path, snippet }) => ({ path, snippet }));
}

function matchPaths(paths: readonly string[], tokens: string[]): SandboxMatch[] {
  if (tokens.length === 0) return paths.map((path) => ({ path, snippet: "" }));
  const scored = paths
    .map((path) => ({ path, snippet: "", hits: tokens.filter((token) => path.toLowerCase().includes(token)).length }))
    .filter((entry) => entry.hits > 0);
  const all = scored.filter((entry) => entry.hits === tokens.length);
  return (all.length > 0 ? all : scored).map(({ path, snippet }) => ({ path, snippet }));
}

function snippetAround(text: string, token: string): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(token);
  if (at < 0) return text.slice(0, SNIPPET).trim();
  const start = Math.max(0, at - 40);
  return text.slice(start, start + SNIPPET).replace(/\s+/g, " ").trim();
}

const BLOB_CAP = 8;
const BLOB_BYTES = FILE_BYTES;

/**
 * Hosted GitHub search only matched paths, so snippets were always empty and
 * the model could not open the claimed failure (Read has no checkout). Fetch
 * the top path hits' blobs and fill snippets the way the workspace path does.
 */
async function hydrateGithubMatches(input: {
  matches: SandboxMatch[];
  tokens: string[];
  repo: string;
  ref: string;
  env: NodeJS.ProcessEnv;
  github?: GitHubTreeClient;
  fetch?: FetchLike;
}): Promise<SandboxMatch[]> {
  if (input.matches.length === 0) return input.matches;
  const out: SandboxMatch[] = [];
  for (const match of input.matches.slice(0, BLOB_CAP)) {
    const body = await githubBlob({
      repo: input.repo,
      ref: input.ref,
      path: match.path,
      env: input.env,
      github: input.github,
      fetch: input.fetch,
    });
    if (body === undefined) {
      out.push(match);
      continue;
    }
    const token = input.tokens.find((t) => body.toLowerCase().includes(t)) ?? input.tokens[0];
    out.push({ path: match.path, snippet: token === undefined ? body.slice(0, SNIPPET).trim() : snippetAround(body, token) });
  }
  for (const match of input.matches.slice(BLOB_CAP)) out.push(match);
  return out;
}

async function githubBlob(input: {
  repo: string;
  ref: string;
  path: string;
  env: NodeJS.ProcessEnv;
  github?: GitHubTreeClient;
  fetch?: FetchLike;
}): Promise<string | undefined> {
  if (input.github !== undefined) {
    const viaClient = await githubBlobViaClient({ ...input, github: input.github });
    if (viaClient !== undefined || githubToken(input.env) === undefined) return viaClient;
  }
  return githubBlobViaToken(input);
}

async function githubBlobViaClient(input: {
  repo: string;
  ref: string;
  path: string;
  github: GitHubTreeClient;
}): Promise<string | undefined> {
  const slash = input.repo.indexOf("/");
  const owner = input.repo.slice(0, slash);
  const name = input.repo.slice(slash + 1);
  try {
    const octokit = await input.github.getOctokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo: name,
      path: input.path,
      ref: input.ref,
    });
    return decodeContents(data);
  } catch {
    return undefined;
  }
}

async function githubBlobViaToken(input: {
  repo: string;
  ref: string;
  path: string;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}): Promise<string | undefined> {
  const token = githubToken(input.env);
  if (token === undefined) return undefined;
  const fetchFn = input.fetch ?? fetch;
  const url = `https://api.github.com/repos/${input.repo}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(input.ref)}`;
  try {
    const response = await fetchFn(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "factory-planner",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) return undefined;
    return decodeContents(JSON.parse(await response.text()));
  } catch {
    return undefined;
  }
}

function decodeContents(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const body = parsed as { type?: unknown; encoding?: unknown; content?: unknown; size?: unknown };
  if (body.type !== "file" || typeof body.content !== "string") return undefined;
  if (typeof body.size === "number" && body.size > BLOB_BYTES * 4) {
    // Skip huge files; path evidence alone is enough for the caller to cite.
    return undefined;
  }
  if (body.encoding === "base64") {
    try {
      return Buffer.from(body.content.replace(/\s+/g, ""), "base64").toString("utf8").slice(0, BLOB_BYTES);
    } catch {
      return undefined;
    }
  }
  return body.content.slice(0, BLOB_BYTES);
}

type TreeResult = { ok: true; paths: string[] } | { ok: false; reason: "github_unavailable" | "github_failed" };

async function githubTree(input: {
  repo: string;
  ref: string;
  env: NodeJS.ProcessEnv;
  github?: GitHubTreeClient;
  fetch?: FetchLike;
}): Promise<TreeResult> {
  if (input.github !== undefined) {
    const viaClient = await githubTreeViaClient({ repo: input.repo, ref: input.ref, github: input.github });
    if (viaClient.ok || githubToken(input.env) === undefined) return viaClient;
  }
  return githubTreeViaToken(input);
}

async function githubTreeViaClient(input: {
  repo: string;
  ref: string;
  github: GitHubTreeClient;
}): Promise<TreeResult> {
  const slash = input.repo.indexOf("/");
  const owner = input.repo.slice(0, slash);
  const name = input.repo.slice(slash + 1);
  try {
    const octokit = await input.github.getOctokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo: name,
      tree_sha: input.ref,
      recursive: "1",
    });
    return parseTree(data);
  } catch (error) {
    const status = responseStatus(error);
    if (status === 401 || status === 403 || status === 404) return { ok: false, reason: "github_unavailable" };
    return { ok: false, reason: "github_failed" };
  }
}

async function githubTreeViaToken(input: {
  repo: string;
  ref: string;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}): Promise<TreeResult> {
  const token = githubToken(input.env);
  if (token === undefined) return { ok: false, reason: "github_unavailable" };
  const fetchFn = input.fetch ?? fetch;
  const url = `https://api.github.com/repos/${input.repo}/git/trees/${encodeURIComponent(input.ref)}?recursive=1`;
  try {
    const response = await fetchFn(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "factory-planner",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { ok: false, reason: "github_unavailable" };
    }
    if (!response.ok) return { ok: false, reason: "github_failed" };
    return parseTree(JSON.parse(await response.text()));
  } catch {
    return { ok: false, reason: "github_failed" };
  }
}

/**
 * git_history without a checkout: the commits GitHub lists for
 * FACTORY_SANDBOX_REPO at FACTORY_SANDBOX_REF, optionally under one path, in
 * the shape `git log` gives a local checkout. The planning turn's VM has the
 * clone, but server tools run on the planner host, which does not.
 */
export async function sandboxHistory(input: {
  path?: string;
  limit?: number;
  env: NodeJS.ProcessEnv;
  github?: GitHubTreeClient;
  fetch?: FetchLike;
}): Promise<HistoryResult> {
  const repo = sandboxRepo(input.env);
  const ref = sandboxRef(input.env);
  const path = (input.path ?? "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (path.split("/").some((part) => part === "..") || path.startsWith("/")) {
    return { available: false, reason: "path_outside_checkout" };
  }
  const params = { sha: ref, per_page: historyLimit(input.limit), ...(path === "" || path === "." ? {} : { path }) };
  const listed = await githubCommits({ repo, params, env: input.env, github: input.github, fetch: input.fetch });
  if (!listed.ok) return { available: false, reason: listed.reason };
  return { available: true, source: "github", repo, ref, path: path === "" ? "." : path, commits: listed.commits };
}

type CommitsResult = { ok: true; commits: Commit[] } | { ok: false; reason: "github_unavailable" | "github_failed" };

async function githubCommits(input: {
  repo: string;
  params: { sha: string; per_page: number; path?: string };
  env: NodeJS.ProcessEnv;
  github?: GitHubTreeClient;
  fetch?: FetchLike;
}): Promise<CommitsResult> {
  if (input.github !== undefined) {
    const slash = input.repo.indexOf("/");
    try {
      const octokit = await input.github.getOctokit();
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits", {
        owner: input.repo.slice(0, slash),
        repo: input.repo.slice(slash + 1),
        ...input.params,
      });
      return parseCommits(data);
    } catch (error) {
      const status = responseStatus(error);
      const reason = status === 401 || status === 403 || status === 404 ? "github_unavailable" : "github_failed";
      if (githubToken(input.env) === undefined) return { ok: false, reason };
    }
  }
  const token = githubToken(input.env);
  if (token === undefined) return { ok: false, reason: "github_unavailable" };
  const query = new URLSearchParams({ sha: input.params.sha, per_page: String(input.params.per_page) });
  if (input.params.path !== undefined) query.set("path", input.params.path);
  try {
    const response = await (input.fetch ?? fetch)(`https://api.github.com/repos/${input.repo}/commits?${query}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "factory-planner",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { ok: false, reason: "github_unavailable" };
    }
    if (!response.ok) return { ok: false, reason: "github_failed" };
    return parseCommits(JSON.parse(await response.text()));
  } catch {
    return { ok: false, reason: "github_failed" };
  }
}

function parseCommits(parsed: unknown): CommitsResult {
  if (!Array.isArray(parsed)) return { ok: false, reason: "github_failed" };
  const commits = parsed.flatMap((entry: { sha?: unknown; commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } } }) => {
    if (typeof entry?.sha !== "string") return [];
    const message = typeof entry.commit?.message === "string" ? entry.commit.message : "";
    const author = entry.commit?.author;
    return [
      {
        sha: entry.sha.slice(0, 7),
        date: typeof author?.date === "string" ? author.date.slice(0, 10) : "",
        author: typeof author?.name === "string" ? author.name : "",
        ...commitFields(message.split("\n")[0]!.trim()),
      },
    ];
  });
  return { ok: true, commits };
}

function parseTree(parsed: unknown): TreeResult {
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { tree?: unknown }).tree)) {
    return { ok: false, reason: "github_failed" };
  }
  const paths = (parsed as { tree: Array<{ path?: unknown; type?: unknown }> }).tree
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && entry.path !== "")
    .map((entry) => entry.path as string);
  return { ok: true, paths };
}

function responseStatus(error: unknown): number | undefined {
  if (error !== null && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return undefined;
}

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

// Read-only git over the checkout, for the `why` step's code anchor. The
// model never gets a shell; it gets this: a fixed `git log` with a path it
// may only point inside the checkout, parsed into commits with the pull
// request number pstack's `why` looks for in the subject.

const run = promisify(execFile);
const PR_NUMBER = /\(#(\d+)\)\s*$/;
const FIELD = "\u001f";

export type Commit = { sha: string; date: string; author: string; subject: string; pr?: number };

export type HistoryResult =
  | { available: true; path: string; commits: Commit[]; source?: "github"; repo?: string; ref?: string }
  | {
      available: false;
      reason: "no_checkout" | "path_outside_checkout" | "path_missing" | "git_failed" | "github_unavailable" | "github_failed";
      message?: string;
    };

export function commitFields(subject: string): Pick<Commit, "subject" | "pr"> {
  const pr = subject.match(PR_NUMBER)?.[1];
  return { subject, ...(pr === undefined ? {} : { pr: Number(pr) }) };
}

/** `path` relative to the checkout, or `undefined` when it escapes or is missing. */
export function repoPath(checkout: string, path: string | undefined): string | undefined {
  const target = resolve(checkout, path === undefined || path.trim() === "" ? "." : path.trim());
  const rel = relative(checkout, target);
  if (rel.startsWith("..") || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) return undefined;
  if (!existsSync(target)) return undefined;
  return rel === "" ? "." : rel;
}

export function historyLimit(limit: number | undefined): number {
  return Math.min(50, Math.max(1, Math.trunc(limit ?? 20)));
}

export function parseLog(stdout: string): Commit[] {
  return stdout
    .split("\n")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => {
      const [sha = "", date = "", author = "", ...rest] = entry.split(FIELD);
      return { sha, date, author, ...commitFields(rest.join(FIELD).trim()) };
    });
}

export async function history(
  checkout: string | undefined,
  input: { path?: string; limit?: number }
): Promise<HistoryResult> {
  if (checkout === undefined) return { available: false, reason: "no_checkout" };
  const target = resolve(checkout, input.path === undefined || input.path.trim() === "" ? "." : input.path.trim());
  if (!existsSync(target)) {
    const rel = relative(checkout, target);
    return { available: false, reason: rel.startsWith("..") ? "path_outside_checkout" : "path_missing" };
  }
  const path = repoPath(checkout, input.path);
  if (path === undefined) return { available: false, reason: "path_outside_checkout" };
  const limit = historyLimit(input.limit);
  try {
    const { stdout } = await run(
      "git",
      ["log", `-n${limit}`, "--date=short", `--format=%h${FIELD}%ad${FIELD}%an${FIELD}%s`, "--", path],
      { cwd: checkout, timeout: 10_000, maxBuffer: 1024 * 1024 }
    );
    return { available: true, path, commits: parseLog(stdout) };
  } catch (error) {
    return { available: false, reason: "git_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

import type { HostGitHubClient } from "@cursor/july";
import type { GithubPrRef } from "./drive.js";

// REST, not GraphQL: on hosted, github-proxy scopes each call by the repo in
// its URL, and POST /graphql carries none, so the proxy answers 400.
export async function fetchPrState(input: {
  github: HostGitHubClient;
  pr: GithubPrRef;
}): Promise<string | undefined> {
  return (await fetchPrStatus(input))?.state;
}

/** The PR's state and its `updated_at`, or undefined when GitHub does not answer. */
export async function fetchPrStatus(input: {
  github: HostGitHubClient;
  pr: GithubPrRef;
}): Promise<{ state: "OPEN" | "CLOSED" | "MERGED"; updatedAt?: string } | undefined> {
  try {
    const octokit = await input.github.getOctokit();
    const { data: pull } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: input.pr.owner,
      repo: input.pr.repo,
      pull_number: input.pr.number,
    });
    const updatedAt = typeof pull.updated_at === "string" ? { updatedAt: pull.updated_at } : {};
    if (pull.merged === true || pull.merged_at != null) return { state: "MERGED", ...updatedAt };
    return { state: pull.state === "closed" ? "CLOSED" : "OPEN", ...updatedAt };
  } catch {
    return undefined;
  }
}

export function isTerminalPrState(
  state: string | undefined
): state is "CLOSED" | "MERGED" {
  return state === "CLOSED" || state === "MERGED";
}

export async function shouldRequeueBusyWake(input: {
  github: HostGitHubClient;
  pr: GithubPrRef;
}): Promise<boolean> {
  return !isTerminalPrState(await fetchPrState(input));
}

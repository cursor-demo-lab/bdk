// Pure: read one GitHub `pull_request` delivery and decide whether it moves
// the ticket its implement PR belongs to. An open PR moves the ticket from
// In Progress to In Review; a PR a person merged moves it from In Review to
// Done. The handler owns the Jira reads and writes, the claim, and the
// status guard.

import { factoryPrKey } from "./factory-pr-key.js";
import { prStatusClaimKey } from "./kv-keys.js";

export { prStatusClaimKey };

const OPEN_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);

export type PrStage = "in_review" | "done";

export type PrActor = { login?: string; type?: string };

export type PrDelivery = {
  action: string;
  repository: string;
  number: number;
  url: string;
  headRef: string;
  baseRef: string;
  title: string;
  authorLogin?: string;
  merged: boolean;
  /** Who triggered the delivery. On a merge, the person or app that merged. */
  sender?: PrActor;
  /** `pull_request.merged_by` from the raw body, when the body carries it. */
  mergedBy?: PrActor;
  /** `pull_request.auto_merge` was set: GitHub merged it, not a person pressing merge. */
  autoMerge: boolean;
};

export type PrDecision =
  | { move: true; stage: PrStage; issueKey: string; pr: string; url: string; mergedBy?: string }
  | {
      move: false;
      reason:
        | "out_of_scope"
        | "wrong_base"
        | "not_factory_pr"
        | "ignored_action"
        | "closed_unmerged"
        | "auto_merge"
        | "merger_unknown"
        | "not_human_merge";
      issueKey?: string;
    };

export function decidePullRequest(
  input: PrDelivery,
  opts: { sandboxRepo: string; sandboxRef: string; projects: readonly string[] }
): PrDecision {
  // Host admission already scopes deliveries to the channel's repos; the dev route admits any.
  if (input.repository.toLowerCase() !== opts.sandboxRepo.toLowerCase()) return { move: false, reason: "out_of_scope" };
  const issueKey = implementPrKey({ headRef: input.headRef, title: input.title, authorLogin: input.authorLogin, projects: opts.projects });
  if (issueKey === undefined) return { move: false, reason: "not_factory_pr" };
  // The worker's agent starts from FACTORY_SANDBOX_REF and opens its PR back into it.
  if (input.baseRef !== opts.sandboxRef) return { move: false, reason: "wrong_base", issueKey };
  const pr = `${input.repository}#${input.number}`;
  // Built from the repository and number: the delivery's `url` may be the API URL.
  const url = `https://github.com/${input.repository}/pull/${input.number}`;
  if (OPEN_ACTIONS.has(input.action) && !input.merged) return { move: true, stage: "in_review", issueKey, pr, url };
  if (input.action !== "closed") return { move: false, reason: "ignored_action", issueKey };
  if (!input.merged) return { move: false, reason: "closed_unmerged", issueKey };
  if (input.autoMerge) return { move: false, reason: "auto_merge", issueKey };
  if (input.sender?.login === undefined) return { move: false, reason: "merger_unknown", issueKey };
  if (!isHuman(input.sender) || (input.mergedBy !== undefined && !isHuman(input.mergedBy))) {
    return { move: false, reason: "not_human_merge", issueKey };
  }
  const mergedBy = humanMerger(input);
  return { move: true, stage: "done", issueKey, pr, url, ...(mergedBy === undefined ? {} : { mergedBy }) };
}

/**
 * Left on the ticket before the worker moves it for its implement PR, the way
 * `Implementing: <url>` comes before In Progress: the desk reads the latest
 * one when it announces In Review and Done, and links the pull request.
 * factory-desk/agent/lib/status-event.ts `latestPullRequestComment` reads it.
 */
export function pullRequestComment(url: string): string {
  return `Pull request: ${url}`;
}

/**
 * Left on the ticket before the worker moves it to Done, so the desk can
 * name the GitHub login in "KEY is Done: owner/repo#N was merged by <login>."
 * factory-desk/agent/lib/status-event.ts `latestMergedByComment` reads it.
 */
export function mergedByComment(login: string): string {
  return `Merged by: ${login.trim()}`;
}

/**
 * The GitHub login the Done move treats as the human merger: `merged_by`
 * when that actor is a person, otherwise the delivery `sender`.
 */
export function humanMerger(input: Pick<PrDelivery, "sender" | "mergedBy">): string | undefined {
  if (input.mergedBy !== undefined && isHuman(input.mergedBy)) return input.mergedBy.login!.trim();
  if (input.sender !== undefined && isHuman(input.sender)) return input.sender.login!.trim();
  return undefined;
}

/**
 * True when a ticket comment is already a `Merged by:` line. When `login` is
 * given, only that login counts, the way `isPullRequestComment` keys on url.
 */
export function isMergedByComment(comment: string, login?: string): boolean {
  const first = comment.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!first.startsWith("Merged by:")) return false;
  const got = first.slice("Merged by:".length).trim();
  if (got === "") return false;
  return login === undefined || got === login.trim();
}

/**
 * True when a ticket comment is already the `Pull request:` line for `url`.
 * Jira can hand the URL back as a card or a markdown link, so any mention of
 * `url` on that first line counts, but not a longer URL that starts with it.
 */
export function isPullRequestComment(comment: string, url: string): boolean {
  const first = comment.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!first.startsWith("Pull request:")) return false;
  let at = first.indexOf(url);
  while (at !== -1) {
    if (!/^[\w/]/.test(first.slice(at + url.length))) return true;
    at = first.indexOf(url, at + 1);
  }
  return false;
}

/**
 * A person's GitHub account: type `User` and no `[bot]` suffix. A GitHub App
 * (`cursor[bot]`, Bugbot, Actions) is type `Bot`. An agent that merges with a
 * person's own token cannot be told apart from that person.
 */
export function isHuman(actor: PrActor): boolean {
  const login = actor.login?.trim() ?? "";
  return login !== "" && actor.type === "User" && !login.toLowerCase().endsWith("[bot]");
}

/**
 * The ticket an implement PR belongs to (factory-pr-key.ts): the branch alone
 * counts; a title alone counts only when the Cursor bot opened the PR, so a
 * person titling a PR "TLSSN-1: ..." cannot move TLSSN-1.
 */
export const implementPrKey = factoryPrKey;

export type SkippedMove = { status: "skipped_status"; current?: string } | { status: "no_transition"; available: string[] } | { status: "failed" };

/**
 * The Jira comment for a move the implement PR should have made and did not.
 * No raw error text. factory-desk/agent/lib/worker-outcome.ts matches the
 * first line and relays the rest into the ticket's Slack thread.
 */
export function prStatusNote(input: { issueKey: string; pr: string; target: string; expected: string; skipped: SkippedMove }): string {
  const { issueKey, target, skipped } = input;
  const head = `${target} not set from ${input.pr}:`;
  if (skipped.status === "skipped_status") {
    return skipped.current === undefined
      ? `${head} ${issueKey}'s status could not be read, so the worker moved nothing.`
      : `${head} ${issueKey} is ${skipped.current}, not ${input.expected}, so the worker left it there. Move the card by hand if this pull request is the implementation.`;
  }
  if (skipped.status === "no_transition") return `${head} Jira offers no transition to ${target} (available: ${skipped.available.join(", ") || "none"}).`;
  return `${head} the move failed; the next delivery for this pull request retries it.`;
}

/** The fields of a raw `pull_request` body the normalized event drops. */
export function rawPullRequestFacts(payload: unknown): { mergedBy?: PrActor; autoMerge: boolean } {
  const pullRequest = recordAt(payload, "pull_request");
  const mergedBy = recordAt(pullRequest, "merged_by");
  const login = typeof mergedBy["login"] === "string" ? mergedBy["login"] : undefined;
  const type = typeof mergedBy["type"] === "string" ? mergedBy["type"] : undefined;
  const autoMerge = pullRequest["auto_merge"];
  return {
    ...(login === undefined ? {} : { mergedBy: { login, ...(type === undefined ? {} : { type }) } }),
    autoMerge: autoMerge !== null && typeof autoMerge === "object",
  };
}

function recordAt(parent: unknown, key: string): Record<string, unknown> {
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) return {};
  const value = (parent as Record<string, unknown>)[key];
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

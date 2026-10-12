import type { HostGitHubClient } from "@cursor/july";
import { issueKeyAtStart } from "./factory-pr-key.js";

// The ticket a pull-request turn belongs to, for the `factory.ticket.key`
// label on its token usage (factory-otel.ts, "Ticket on token usage"). A
// GitHub channel session carries July's durable channel state
// (GitHubChannelState: owner, repo, pullRequestNumber, headRef, ...), and a
// factory PR's head branch starts with the key (factory-pr-key.ts), so the
// usual answer needs no read. A PR whose branch does not name the key (one
// `cursor[bot]` opened from the platform's autoCreatePR, titled with the key;
// a person's PR titled with the key that `factory: drive` sent the fixer)
// takes one REST read of the PR for its branch and title. The key is read
// from the branch, else the title, whoever opened the PR: this names the
// ticket a turn's cost belongs to, it grants nothing, so the author rule
// factoryPrKey applies to moves, drives and early reviews does not narrow
// it. No PR, no key, or a failed read is undefined, which the label writes
// as `none`.
//
// The hook runs in July's serialized dispatch chain on every `turn.started`,
// and a drive is many turns on one session, so the read is made once per
// session per process (`sessions`, keyed by session id; whatever it
// answered, a failed read included, is the session's answer until the pod
// is replaced) and waits at most PR_READ_BUDGET_MS: a GitHub that is slow
// answers `none` for that session rather than holding the turn's events.
//
// Shared verbatim by pr-autofixer and security-reviewer
// (scripts/copies-parity.test.mjs); its test is pr-autofixer's
// pr-ticket.test.ts.

/** How long one PR read may take before the session's ticket is `none` (undefined). */
export const PR_READ_BUDGET_MS = 2_000;

/** Each session's answer, the first time it needed a read. */
const sessions = new Map<string, string | undefined>();

export type PrLocator = { owner: string; repo: string; number: number };

export type ChannelPr = { pr?: PrLocator; headRef?: string };

/** The PR and head branch a GitHub channel session's state names; `{}` for any other state. */
export function prFromChannelState(state: unknown): ChannelPr {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return {};
  const record = state as Record<string, unknown>;
  const owner = record["owner"];
  const repo = record["repo"];
  const number = record["pullRequestNumber"];
  const headRef = record["headRef"];
  const pr =
    typeof owner === "string" && owner !== "" && typeof repo === "string" && repo !== "" && typeof number === "number" && Number.isInteger(number) && number > 0
      ? { owner, repo, number }
      : undefined;
  return {
    ...(pr === undefined ? {} : { pr }),
    ...(typeof headRef === "string" && headRef !== "" ? { headRef } : {}),
  };
}

/**
 * The ticket key of the turn's pull request: the head branch in the channel
 * state when it starts with a key from `projects`; else, with a PR to read
 * (`input.pr`, or the one the state names) and a GitHub client, one REST read
 * for the branch, then the title, made once per `sessionId` and within
 * `budgetMs` (PR_READ_BUDGET_MS). Never throws.
 */
export async function prTicketKey(input: {
  state: unknown;
  pr?: PrLocator | undefined;
  github: HostGitHubClient | undefined;
  projects: readonly string[];
  sessionId?: string | undefined;
  budgetMs?: number | undefined;
}): Promise<string | undefined> {
  if (input.projects.length === 0) return undefined;
  const fromState = prFromChannelState(input.state);
  const fromBranch = issueKeyAtStart(fromState.headRef, input.projects);
  if (fromBranch !== undefined) return fromBranch;
  const pr = input.pr ?? fromState.pr;
  if (pr === undefined || input.github === undefined) return undefined;
  if (input.sessionId !== undefined && sessions.has(input.sessionId)) return sessions.get(input.sessionId);
  const key = await withinBudget(readPrKey(input.github, pr, input.projects), input.budgetMs ?? PR_READ_BUDGET_MS);
  if (input.sessionId !== undefined) sessions.set(input.sessionId, key);
  return key;
}

async function readPrKey(github: HostGitHubClient, pr: PrLocator, projects: readonly string[]): Promise<string | undefined> {
  try {
    const octokit = await github.getOctokit();
    const { data: pull } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: pr.owner, repo: pr.repo, pull_number: pr.number });
    return issueKeyAtStart(pull.head.ref, projects) ?? issueKeyAtStart(pull.title, projects);
  } catch {
    return undefined;
  }
}

/** `read`'s answer, or undefined once `budgetMs` has passed; the read goes on in the background and its late answer is dropped. */
function withinBudget(read: Promise<string | undefined>, budgetMs: number): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
    timer.unref?.();
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** Forgets every session's answer; tests call it between cases. */
export function forgetPrTickets(): void {
  sessions.clear();
}

import type { HostMcpRegistry } from "@cursor/july";
import { hasLaunched } from "./claim.js";
import { extractBrief, latestPlanComment } from "./decide.js";
import { readComments } from "./jira.js";
import { implementPrKey, type PrDelivery } from "./pr-decide.js";
import { briefLinks, withTicketLinks } from "./pr-links.js";
import type { KeyedKv } from "./kv-keys.js";

// The implement PR's description opens with the ticket and the Slack thread
// that filed it:
//
//   Jira: https://…/browse/KEY
//   Slack: https://…slack.com/archives/C…/p…
//
// The planner's brief asks the cloud agent for both lines
// (planner/agent/lib/plan.ts `pullRequestContract`), but the agent writes the
// description, and on TLSSN-28 (cursor-demo-lab/marsbank#25) it kept the Jira
// line and dropped the Slack one. So the worker, which launched that agent,
// reads the two links back from the brief it launched with and rewrites the
// description's leading link lines when they are missing or wrong. Nothing
// else in the description is touched.

/** The PR actions whose description the worker checks. `edited` catches an agent that rewrites the body after opening. */
const BODY_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "edited"]);

/** The implement PR whose description the worker keeps linked, or undefined for any other delivery. */
export function linkablePullRequest(
  input: PrDelivery,
  opts: { sandboxRepo: string; sandboxRef: string; projects: readonly string[] }
): { issueKey: string; repository: string; number: number } | undefined {
  if (!BODY_ACTIONS.has(input.action) || input.merged) return undefined;
  if (input.repository.toLowerCase() !== opts.sandboxRepo.toLowerCase()) return undefined;
  if (input.baseRef !== opts.sandboxRef) return undefined;
  const issueKey = implementPrKey({ headRef: input.headRef, title: input.title, authorLogin: input.authorLogin, projects: opts.projects });
  return issueKey === undefined ? undefined : { issueKey, repository: input.repository, number: input.number };
}

/** The slice of July's `ctx.github` this path uses. */
export type PullRequestApi = {
  request<T = unknown>(input: { method: "GET" | "PATCH"; path: string; body?: Record<string, unknown> }): Promise<{ ok: boolean; status: number; body: T }>;
};

export type PrBodyDeps = { kv: KeyedKv; mcp: HostMcpRegistry; github: PullRequestApi };

export type PrBodyOutcome = "written" | "present" | "no_slack_thread" | "no_brief" | "not_launched" | "unavailable" | "read_failed" | "write_failed" | "failed";

/**
 * Reads the PR from GitHub (the Cursor event stream carries no body), and
 * writes the description back only when {@link withTicketLinks} changes it.
 * The worker's own edit comes back as `edited` and finds the lines present,
 * so it writes once. Never throws: the description is best effort and never
 * holds back the ticket's status move.
 */
export async function linkTicketInBody(deps: PrBodyDeps, target: { issueKey: string; repository: string; number: number }): Promise<PrBodyOutcome> {
  try {
    const launched = await hasLaunched(deps.kv, target.issueKey);
    if (launched === "unavailable") return "unavailable";
    if (!launched) return "not_launched";
    const read = await readComments(deps.mcp, target.issueKey);
    if (read.status !== "read") return "unavailable";
    const plan = latestPlanComment(read.comments, target.issueKey);
    const brief = plan === undefined ? undefined : extractBrief(plan);
    if (brief === undefined) return "no_brief";
    const links = briefLinks(brief, target.issueKey);
    if (links.slack === undefined) return "no_slack_thread";
    const path = pullPath(target);
    const current = await deps.github.request<{ body?: string | null }>({ method: "GET", path });
    if (!current.ok) return "read_failed";
    const next = withTicketLinks(current.body?.body, { issueKey: target.issueKey, links });
    if (next === undefined) return "present";
    const written = await deps.github.request({ method: "PATCH", path, body: { body: next } });
    return written.ok ? "written" : "write_failed";
  } catch {
    return "failed";
  }
}

function pullPath(target: { repository: string; number: number }): string {
  const [owner = "", repo = ""] = target.repository.split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${target.number}`;
}

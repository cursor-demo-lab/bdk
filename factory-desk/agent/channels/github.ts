import { stagingRefusesSlackApp, type SlackAppHost } from "../lib/slack-app-guard.js";
import { githubChannel, type GitHubEventContext, type GitHubTaskDispatch } from "@cursor/july/channels/github";
import { reviewRepos } from "../lib/config.js";
import { announceReviewUpdateWithRecheck, type PullFacts, type ReviewReader, type ReviewWake } from "../lib/review-announce.js";
import type { CheckRunFacts, CommentFacts, ReviewFacts } from "../lib/review-update.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { tracedGithubHook } from "../lib/factory-otel.js";

const repos = reviewRepos(process.env);

// Read-only, host-only, like the jira channel: it hears a factory PR's quality
// gates settle and posts one review update into the ticket's Slack thread
// (lib/review-announce.ts). It never comments, reviews, pushes, or merges,
// and comments return null so the default @mention gate can never start a
// model turn. Hosted v2 forwards pull_request, check_suite completed, and
// workflow_run completed, but not check_run (docs/deployment-issues.md issue
// 12); pull_request_review is subscribed too, unverified hosted. Empty list
// cannot be `{ repos: [] }` (July throws). `true` still starts the hosted
// event stream; the next task with FACTORY_REPOS set reloads this module as
// `{ repos, permissions: "read" }`. Every hook returns a host task or null,
// never a session, so no delivery needs a continuation.
export default githubChannel({
  continuation: "github.none/v2",
  cursorAccount: repos.length === 0 ? true : { repos, permissions: "read" },
  deliverReplies: false,
  progress: { reactions: false },
  webhookEvents: ["pull_request", "check_suite", "workflow_run", "pull_request_review"],
  onComment: () => null,
  onPullRequest: tracedGithubHook("github.pull_request", (ctx, pr) => {
    if (!["opened", "reopened", "ready_for_review", "synchronize"].includes(pr.action)) return null;
    const payload = record(ctx.payload);
    const before = typeof payload["before"] === "string" ? payload["before"] : undefined;
    return reviewTask(ctx, [pr.number], {
      kind: "pull_request",
      action: pr.action,
      ...(before === undefined ? {} : { before }),
      ...(ctx.sender === undefined ? {} : { sender: { login: ctx.sender.login, ...(ctx.sender.type === undefined ? {} : { type: ctx.sender.type }) } }),
    });
  }),
  onCheckSuite: tracedGithubHook("github.check_suite", (ctx, suite) => {
    if (suite.action !== "completed") return null;
    return reviewTask(ctx, suite.pullRequests.map((pr) => pr.number), {
      kind: "check_suite",
      suite: { id: suite.checkSuiteId, headSha: suite.headSha, conclusion: suite.conclusion ?? null, ...(suite.app.slug === undefined ? {} : { app: suite.app.slug }) },
    });
  }),
  onWorkflowRun: tracedGithubHook("github.workflow_run", (ctx, run) => {
    if (run.action !== "completed") return null;
    return reviewTask(ctx, run.pullRequests.map((pr) => pr.number), {
      kind: "workflow_run",
      workflow: { headSha: run.headSha, conclusion: run.conclusion ?? null, ...(run.name === undefined ? {} : { name: run.name }), ...(run.htmlUrl === undefined ? {} : { htmlUrl: run.htmlUrl }) },
    });
  }),
  onEvent: tracedGithubHook("github.event", (ctx, event) => {
    if (event.eventName !== "pull_request_review" || event.action !== "submitted") return null;
    const number = record(record(event.payload)["pull_request"])["number"];
    return typeof number === "number" ? reviewTask(ctx, [number], { kind: "review" }) : null;
  }),
});

// At most this many PRs per wake: a check suite on a shared commit lists every PR on it.
const MAX_PRS = 5;

export function reviewTask(ctx: GitHubEventContext, numbers: readonly number[], wake: ReviewWake): GitHubTaskDispatch | null {
  const repository = ctx.repository.fullName;
  const scope = reviewRepos(process.env);
  if (!scope.some((repo) => repo.toLowerCase() === repository.toLowerCase())) {
    console.log(JSON.stringify({ desk: "review_update", pr: repository, outcome: scope.length === 0 ? "no_factory_repos" : "not_watched" }));
    return null;
  }
  const targets = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_PRS);
  const sha = "suite" in wake ? wake.suite.headSha : "workflow" in wake ? wake.workflow.headSha : undefined;
  if (targets.length === 0 && sha === undefined) return null;
  const github = reader(ctx);
  return {
    task: async () => {
      bindOpsFunnel(ctx.host);
      if (await stagingRefusesSlackApp(ctx.host as SlackAppHost)) return;
      const prs = targets.length > 0 ? targets : await github.pullsForCommit(sha!);
      await Promise.all(
        prs.slice(0, MAX_PRS).map(async (number) => {
          try {
            const results = await announceReviewUpdateWithRecheck(
              { repository, number, wake },
              { kv: ctx.host.kv, slack: ctx.host.slack, mcp: ctx.host.mcp, github, env: process.env, now: () => new Date() }
            );
            for (const result of results) console.log(JSON.stringify({ desk: "review_update", wake: wake.kind, ...result }));
          } catch (error) {
            console.error(`[factory-desk] review update for ${repository}#${number} failed:`, error);
          }
        })
      );
    },
  };
}

function reader(ctx: GitHubEventContext): ReviewReader & { pullsForCommit(sha: string): Promise<number[]> } {
  const where = { owner: ctx.repository.owner, repo: ctx.repository.name };
  const octokit = () => ctx.github.getOctokit();
  return {
    async pull(number): Promise<PullFacts> {
      const { data } = await (await octokit()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...where, pull_number: number });
      const pr = record(data);
      const head = record(pr["head"]);
      const user = record(pr["user"]);
      return {
        number,
        state: text(pr["state"]),
        merged: pr["merged"] === true,
        headSha: text(head["sha"]),
        headRef: text(head["ref"]),
        title: text(pr["title"]),
        ...(typeof user["login"] === "string" ? { authorLogin: user["login"] } : {}),
      };
    },
    async checkRuns(sha): Promise<CheckRunFacts[] | undefined> {
      try {
        const { data } = await (await octokit()).request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...where, ref: sha, per_page: 100 });
        const runs = record(data)["check_runs"];
        return (Array.isArray(runs) ? runs : []).map((run) => {
          const item = record(run);
          const output = record(item["output"]);
          return {
            ...(typeof item["id"] === "number" ? { id: item["id"] } : {}),
            name: text(item["name"]),
            ...(typeof record(item["app"])["slug"] === "string" ? { app: record(item["app"])["slug"] as string } : {}),
            status: text(item["status"]),
            conclusion: typeof item["conclusion"] === "string" ? item["conclusion"] : null,
            summary: typeof output["summary"] === "string" ? output["summary"] : null,
            ...(typeof item["html_url"] === "string" ? { htmlUrl: item["html_url"] } : {}),
            ...(typeof record(item["check_suite"])["id"] === "number" ? { suiteId: record(item["check_suite"])["id"] as number } : {}),
            ...(typeof item["completed_at"] === "string" ? { completedAt: item["completed_at"] } : {}),
          };
        });
      } catch {
        return undefined;
      }
    },
    async reviews(number): Promise<ReviewFacts[]> {
      const { data } = await (await octokit()).request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { ...where, pull_number: number, per_page: 100 });
      return (Array.isArray(data) ? data : []).map((review) => {
        const item = record(review);
        const user = record(item["user"]);
        return {
          ...(typeof item["id"] === "number" ? { id: item["id"] } : {}),
          ...(typeof user["login"] === "string" ? { authorLogin: user["login"] } : {}),
          ...(typeof user["type"] === "string" ? { authorType: user["type"] } : {}),
          body: text(item["body"]),
          ...(typeof item["commit_id"] === "string" ? { commitId: item["commit_id"] } : {}),
          ...(typeof item["html_url"] === "string" ? { htmlUrl: item["html_url"] } : {}),
        };
      });
    },
    async comments(number): Promise<CommentFacts[] | undefined> {
      try {
        const { data } = await (await octokit()).request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...where, issue_number: number, per_page: 100 });
        return (Array.isArray(data) ? data : []).map((comment) => {
          const item = record(comment);
          const user = record(item["user"]);
          return {
            ...(typeof user["login"] === "string" ? { authorLogin: user["login"] } : {}),
            ...(typeof user["type"] === "string" ? { authorType: user["type"] } : {}),
            body: text(item["body"]),
            ...(typeof item["html_url"] === "string" ? { htmlUrl: item["html_url"] } : {}),
          };
        });
      } catch {
        return undefined;
      }
    },
    async pullsForCommit(sha): Promise<number[]> {
      const { data } = await (await octokit()).request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", { ...where, commit_sha: sha });
      return (Array.isArray(data) ? data : [])
        .filter((pr) => record(pr)["state"] === "open")
        .map((pr) => record(pr)["number"])
        .filter((n): n is number => typeof n === "number");
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

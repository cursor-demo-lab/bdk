import {
  defaultGitHubAuth,
  defaultGitHubPullRequestDispatch,
  githubChannel,
} from "@cursor/july/channels/github";
import { jiraProjects } from "../lib/config.js";
import { debugEvent, logDebugEvent } from "../lib/debug-events.js";
import { NotADiffError, isUnifiedDiff, prepareDiff } from "../lib/diff-evidence.js";
import { factoryDraftKey, factoryIssueKey } from "../lib/factory-pr.js";
import { prReviewAuth } from "../lib/pr-auth.js";
import { priorReview } from "../lib/reviewed-head.js";
import { githubReposAtBoot, watches } from "../lib/repos.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { tracedGithubHook } from "../lib/factory-otel.js";

const repos = githubReposAtBoot();

// The delivery log lines sit at the top of the typed hooks. July never
// routes pull_request or comment deliveries to onEvent, and declaring
// onEvent would subscribe review events and change the continuation.
export default githubChannel({
  // Empty list cannot be `{ repos: [] }` (July throws). `true` still
  // starts the hosted event stream; the next task with FACTORY_REPOS set
  // reloads this module as `{ repos }`.
  cursorAccount: repos.length === 0 ? true : { repos },
  deliverReplies: false,
  onStart: () => {
    console.log(
      JSON.stringify({
        factoryDebug: "boot",
        factoryReposSet: (process.env.FACTORY_REPOS ?? "") !== "",
        overrideSet: process.env.SECURITY_REVIEWER_REPOS !== undefined,
        reposAtBoot: repos.length,
      })
    );
  },
  onComment: tracedGithubHook("github.comment", (ctx) => {
    logDebugEvent(debugEvent({ ctx, action: "created", decision: "ignored_comment" }));
    return null;
  }),
  onPullRequest: tracedGithubHook("github.pull_request", async (ctx, pr) => {
    bindOpsFunnel(ctx.host);
    let watched: boolean;
    try {
      watched = watches(ctx.repository.fullName);
    } catch (error) {
      logDebugEvent(
        debugEvent({
          ctx,
          action: pr.action,
          decision: "error",
          facts: { draft: pr.draft, error: error instanceof Error ? error.name : "unknown" },
        })
      );
      throw error;
    }
    // Factory PRs open as cursor[bot] drafts; any other draft waits for
    // ready_for_review.
    const projects = jiraProjects(process.env);
    const factoryKey = factoryIssueKey({ headRef: pr.headRef, title: pr.title, projects });
    const factoryDraft =
      pr.draft && factoryDraftKey({ headRef: pr.headRef, title: pr.title, authorLogin: pr.authorLogin, projects }) !== undefined;
    // A retarget changes the compare, so it reviews like a push. Hosted v2
    // and the --cursor-events relay pass the webhook body, so changes.base
    // arrives. Only the relay's metadata fallback (an oversize envelope) lacks
    // it; that retarget is reviewed on the PR's next synchronize, reopened,
    // or ready_for_review, which compares against the new base.
    const retarget = pr.action === "edited" && pr.baseRefChangedFrom !== undefined;
    const eligible =
      watched && (!pr.draft || factoryDraft)
        ? retarget
          ? { auth: defaultGitHubAuth(ctx) }
          : defaultGitHubPullRequestDispatch(ctx, pr)
        : null;
    const base = pr.baseSha ?? pr.baseRef;
    const prior =
      eligible === null
        ? undefined
        : await priorReview({
          kv: ctx.host?.kv,
          identity: { fullName: ctx.repository.fullName, number: pr.number, base, headSha: pr.headSha },
        });
    const dispatch = prior === undefined ? eligible : null;
    logDebugEvent(
      debugEvent({
        ctx,
        action: pr.action,
        decision: !watched
          ? "not_watched"
          : pr.draft && !factoryDraft
            ? "draft_not_factory"
            : eligible === null
              ? "action_skipped"
              : prior !== undefined
                ? prior.complete
                  ? "already_reviewed"
                  : "already_reviewed_incomplete"
                : factoryDraft
                  ? "review_factory_draft"
                  : "review",
        facts: {
          watches: watched,
          draft: pr.draft,
          dispatched: dispatch !== null,
          ...(factoryKey === undefined ? {} : { factoryKey }),
        },
      })
    );
    if (dispatch === null) {
      return null;
    }
    return {
      auth: prReviewAuth(dispatch.auth, ctx.repository.fullName, pr.number),
      context: ["Read pr/diff.patch."],
      // The diff, pr/head.sha, and the base in pr/diff.json all come from the
      // event, never from the PR's current state: post_findings posts at
      // pr/head.sha and records that base and head as reviewed, so a head or
      // base that moved during the fetch must not be paired with the older
      // diff.
      // A failure here, including a 200 that is not a diff, ends the delivery
      // after the ack with no turn, so the review line above is followed by a
      // fetch_failed line.
      async workspaceFiles() {
        let text: string;
        try {
          const octokit = await ctx.github.getOctokit();
          const diff = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
            owner: ctx.repository.owner,
            repo: ctx.repository.name,
            basehead: `${base}...${pr.headSha}`,
            mediaType: { format: "diff" },
          });
          if (!isUnifiedDiff(diff.data)) throw new NotADiffError();
          text = diff.data;
        } catch (error) {
          logDebugEvent(
            debugEvent({
              ctx,
              action: pr.action,
              decision: "fetch_failed",
              facts: {
                watches: watched,
                draft: pr.draft,
                dispatched: false,
                ...(factoryKey === undefined ? {} : { factoryKey }),
                error: error instanceof Error ? error.name : "unknown",
              },
            })
          );
          throw error;
        }
        const { patch, meta } = prepareDiff({ diff: text, base, headSha: pr.headSha });
        return {
          "pr/diff.patch": patch,
          "pr/head.sha": pr.headSha,
          "pr/diff.json": JSON.stringify(meta),
        };
      },
    };
  }),
});

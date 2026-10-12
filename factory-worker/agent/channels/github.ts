import { githubChannel } from "@cursor/july/channels/github";
import { sandboxReposAtBoot } from "../lib/config.js";
import { backstopImplementPrSweep, hostImplementPrDeps, withImplementPrBackstop } from "../lib/implement-pr-sweep.js";
import { prStatusDispatch } from "../lib/pr-status.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { tracedGithubHook } from "../lib/factory-otel.js";

const repos = sandboxReposAtBoot();

// Host-only, like the jira channel. The implement PR opening moves its
// ticket to In Review, and a person merging it moves the ticket to Done
// (lib/pr-status.ts). PR write scope for three writes only: opening the
// implement PR from the agent's branch (lib/implement-pr.ts, through
// `host.github`, which serve wires to this channel's credential), marking it
// ready for review, since Bugbot skips drafts (lib/pr-ready.ts; its GraphQL
// call names the repo, because the hosted boot below is unscoped), and the
// description's leading `Jira:` and `Slack:` lines (lib/pr-body.ts). The worker never
// comments, reviews, pushes, or merges. Only pull_request is subscribed, and
// comments return null so the default @mention gate can never start a model
// turn. Empty list cannot be `{ repos: [] }` (July throws). `true` still
// starts the hosted event stream; the next task with FACTORY_SANDBOX_REPO set
// reloads this module as `{ repos }`.
export default githubChannel({
  cursorAccount: repos.length === 0 ? true : { repos, permissions: "pr-write" },
  deliverReplies: false,
  progress: { reactions: false },
  webhookEvents: ["pull_request"],
  onComment: () => null,
  onPullRequest: tracedGithubHook("github.pull_request", (ctx, pr) => {
    bindOpsFunnel(ctx.host);
    return withImplementPrBackstop(
      prStatusDispatch({
        ctx,
        pr,
        deps: { kv: ctx.host.kv, mcp: ctx.host.mcp, env: process.env, now: () => new Date(), github: ctx.github },
      }),
      () => backstopImplementPrSweep(hostImplementPrDeps({ host: ctx.host, mcp: ctx.host.mcp }))
    );
  }),
});

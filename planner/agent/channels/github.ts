import { githubChannel } from "@cursor/july/channels/github";
import { sandboxReposAtBoot } from "../lib/config.js";

const repos = sandboxReposAtBoot();

// Credential only. Hosted `search_sandbox` / `record_plan` call
// `ctx.host.github.getOctokit()`; github-proxy mints the team's GitHub
// App lease and never needs FACTORY_GITHUB_TOKEN. Hooks return null so a
// PR event never starts a planning turn. Empty list cannot be `{ repos: [] }`
// (July throws). `true` still starts the hosted pass-through; the next
// task with FACTORY_SANDBOX_REPO set reloads this module as `{ repos }`.
export default githubChannel({
  cursorAccount: repos.length === 0 ? true : { repos, permissions: "read" },
  deliverReplies: false,
  webhookEvents: [],
  onPullRequest: () => null,
  onComment: () => null,
});

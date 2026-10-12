import { defineTool } from "@cursor/july/tools";
import type { ToolExecuteResult } from "@cursor/july/tools";
import { driveStartBodySchema } from "../lib/drive-schemas.js";
import { githubRepos } from "../lib/repos.js";
import { startDrive } from "../lib/start-drive.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

export default defineTool({
  description:
    "Start PR autofixer on a GitHub pull request. Attaches the PR to a Cursor cloud agent and returns as soon as the session exists. bcId / agentUrl are included when already bound; otherwise they fill in from agent.bound. Triage continues asynchronously. Call whenever the user wants to drive, triage, or unblock a PR. Do not review the PR yourself from chat; there is no checkout here.",
  inputSchema: driveStartBodySchema,
  effect: "write",
  dryRunResult: ({ pr }) => ({ ok: false, code: "dry_run", error: "Dry run: nothing was started.", pr }),
  async execute({ pr, hint }, ctx): Promise<ToolExecuteResult> {
    bindOpsFunnel(ctx.host);
    if (ctx.session.purpose === "eval") {
      return { ok: false, code: "eval", error: "Eval session: nothing was started.", pr };
    }
    const result = await startDrive({
      pr,
      hint,
      repos: githubRepos(),
      send: (message, options) => ctx.send("drive", message, options),
      host: ctx.host,
    });
    if (!result.ok) {
      return { ok: false, error: result.error, code: result.code };
    }
    return { ...result };
  },
});

import { defineHook } from "@cursor/july/hooks";
import { recordPrAgentWhileOpen } from "../lib/affinity.js";
import { releaseAutoDriveForSession, stampAutoDriveSession } from "../lib/auto-drive.js";
import { prRefFromSessionTitle } from "../lib/drive.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

// A drive the GitHub channel started is an `evt:` session, so until its agent
// binds, its claim is the only record that the PR is driven. The first turn
// stamps the claim with the session while the title still names the PR;
// the harness may replace the title with its summary before the turn ends.
// When that session fails, its claim goes so the next red check or
// factory: drive starts again instead of waiting out DRIVE_LEASE_MS. A
// cancelled turn (a stop, or a follow-up interrupting it) keeps the claim.
// session.failed is only emitted for task-mode sessions; drives are chat.
// Once its cloud agent is bound, the drive records affinity for the PR (the
// title names it), so later red checks and Bugbot findings wake that agent
// through the buffer instead of finding a held claim and nothing to wake. A
// turn that completes ends the drive: its claim goes, so it no longer holds
// the PR for DRIVE_LEASE_MS after the work is done.
export default defineHook({
  events: {
    "agent.bound": async (event, ctx) => {
      bindOpsFunnel(ctx.host);
      if (ctx.channel.id !== "github" || !event.data.sdkAgentId.startsWith("bc-")) {
        return;
      }
      const pr = prRefFromSessionTitle(ctx.session.title);
      if (pr !== undefined) {
        await recordPrAgentWhileOpen({ pr, bcId: event.data.sdkAgentId, kv: ctx.host.kv, github: ctx.host.github, continuationToken: ctx.channel.continuationToken });
      }
    },
    "turn.completed": async (_event, ctx) => {
      bindOpsFunnel(ctx.host);
      if (ctx.channel.id === "github") {
        await releaseAutoDriveForSession(ctx.host.kv, ctx.session.id);
      }
    },
    "turn.started": async (_event, ctx) => {
      bindOpsFunnel(ctx.host);
      if (ctx.channel.id !== "github") {
        return;
      }
      const pr = prRefFromSessionTitle(ctx.session.title);
      if (pr !== undefined) {
        await stampAutoDriveSession(ctx.host.kv, pr, ctx.session.id);
      }
    },
    "turn.failed": async (event, ctx) => {
      bindOpsFunnel(ctx.host);
      if (ctx.channel.id === "github" && event.data.status !== "cancelled") {
        await releaseAutoDriveForSession(ctx.host.kv, ctx.session.id);
      }
    },
    "session.failed": async (_event, ctx) => {
      bindOpsFunnel(ctx.host);
      if (ctx.channel.id === "github") {
        await releaseAutoDriveForSession(ctx.host.kv, ctx.session.id);
      }
    },
  },
});

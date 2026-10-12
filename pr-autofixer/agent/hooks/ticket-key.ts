import { defineHook, type HookContext } from "@cursor/july/hooks";
import { jiraProjects } from "../lib/config.js";
import { prRefFromContinuationToken, prRefFromSessionTitle } from "../lib/drive.js";
import { tagSessionTicket } from "../lib/factory-otel.js";
import { prTicketKey } from "../lib/pr-ticket.js";

// Puts `factory.ticket.key` on the token and turn samples July records
// for a drive turn, and on the turn's July spans, so Grafana can price each
// ticket on its own (factory-otel.ts, "Ticket on token usage": the one
// approved addition to July's spans; `cursor.tool.calls` and the factory's
// other metrics drop the label). A drive is bound to its PR by the session
// title startDrive gives it (`PR owner/repo#n`), by the `drive` channel's
// continuation token (`pr:owner/repo#n[@g<k>]`), or, for a drive a GitHub
// delivery started, by July's channel state, whose head branch names the
// ticket on a factory PR without a read; any other PR is read once per
// session, within a budget (lib/pr-ticket.ts). A PR with no key in branch
// or title, no PR at all (a playground chat, an eval), or a read that is
// slow or fails is `none`. Hooks run before July's collector sees the
// event, so the tag is in place when `turn.completed` records the usage.
export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      await tag(ctx);
    },
  },
});

async function tag(ctx: HookContext): Promise<void> {
  const pr = prRefFromSessionTitle(ctx.session.title) ?? prRefFromContinuationToken(ctx.channel.continuationToken);
  const key = await prTicketKey({
    state: ctx.channelState,
    ...(pr === undefined ? {} : { pr: { owner: pr.owner, repo: pr.repo, number: pr.number } }),
    github: ctx.host.github,
    projects: jiraProjects(process.env),
    sessionId: ctx.session.id,
  });
  tagSessionTicket(ctx.host, key);
}

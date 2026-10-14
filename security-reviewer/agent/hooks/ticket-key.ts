import { defineHook, type HookContext } from "@cursor/july/hooks";
import { jiraProjects } from "../lib/config.js";
import { tagSessionTicket } from "../lib/factory-otel.js";
import { prTicketKey } from "../lib/pr-ticket.js";

// Puts `factory.ticket.key` on the token and turn samples July records for a
// review turn, and on the turn's July spans, so Grafana can price each ticket on
// its own (factory-otel.ts, "Ticket on token usage": the one approved addition
// to July's spans; the label is on all of July's metrics and spans for the
// session, `cursor.tool.calls` included: July's `join` stamps the whole tag bag
// on every sample (dist/internal/otel/collector.js:619-626) and the factory has
// no metric View). A review is a GitHub channel session, and July's channel
// state names its PR and head branch; a factory PR's branch starts with the key,
// so no read is needed. A PR whose branch does not name the key takes one PR
// read for the branch and title, once per session and within a budget
// (lib/pr-ticket.ts). A PR with no key in either, no PR at all (a playground
// chat, an eval), or a read that is slow or fails is `none`. Hooks run before
// July's collector sees the event, so the tag is in place when `turn.completed`
// records the usage.
export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      await tag(ctx);
    },
  },
});

async function tag(ctx: HookContext): Promise<void> {
  const key = await prTicketKey({ state: ctx.channelState, github: ctx.host.github, projects: jiraProjects(process.env), sessionId: ctx.session.id });
  tagSessionTicket(ctx.host, key);
}

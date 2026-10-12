import { defineHook, type HookContext } from "@cursor/july/hooks";
import { pinnedIssueKey } from "../lib/chain.js";
import { tagSessionTicket } from "../lib/factory-otel.js";

// Puts `factory.ticket.key` on the token and turn samples July records
// for a planning turn, and on the turn's July spans, so Grafana can price
// each ticket on its own (factory-otel.ts, "Ticket on token usage": the one
// approved addition to July's spans; `cursor.tool.calls` and the factory's
// other metrics drop the label). A planning run is pinned to
// its ticket by its continuation key, `issue:<KEY>#<attempt>` (chain.ts
// pinnedIssueKey; the Triaged webhook and plan_issue both pin). A session
// with no pin (a playground chat, an eval) is `none`. Hooks run before
// July's collector sees the event, so the tag is in place when
// `turn.completed` records the usage; a follow-up turn on the same session
// tags again, which is harmless.
export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      tag(ctx);
    },
  },
});

function tag(ctx: HookContext): void {
  tagSessionTicket(ctx.host, pinnedIssueKey(ctx.session.continuationKey ?? ctx.channel.continuationToken));
}

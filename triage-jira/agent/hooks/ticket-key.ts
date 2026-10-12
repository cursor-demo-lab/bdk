import { defineHook, type HookContext } from "@cursor/july/hooks";
import { tagSessionTicket } from "../lib/factory-otel.js";
import { pinIssueIdentifier } from "../lib/parse-queue-event.js";

// Puts `factory.ticket.key` on the token and turn samples July records
// for a triage turn, and on the turn's July spans, so Grafana can price each
// ticket on its own (factory-otel.ts, "Ticket on token usage": the one
// approved addition to July's spans; `cursor.tool.calls` and the factory's
// other metrics drop the label). A triage run is pinned to its
// ticket by its continuation token, the issue key itself (the issue-created
// webhook and the queue route both pin it; parse-queue-event.ts
// pinIssueIdentifier). A session with no pin (a playground chat, an eval) is
// `none`. Hooks run before July's collector sees the event, so the tag is in
// place when `turn.completed` records the usage.
export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      tag(ctx);
    },
  },
});

function tag(ctx: HookContext): void {
  tagSessionTicket(ctx.host, pinIssueIdentifier(ctx.session.continuationKey ?? ctx.channel.continuationToken, ""));
}

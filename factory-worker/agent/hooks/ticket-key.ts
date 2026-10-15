import { defineHook, type HookContext } from "@cursor/july/hooks";
import { tagSessionTicket } from "../lib/factory-otel.js";
import { implementIssueKey } from "../lib/implement-turn.js";

// Puts `factory.ticket.key` on the token and turn samples July records for an
// implement turn, and on the turn's July spans, so Grafana can price each ticket
// on its own (factory-otel.ts, "Ticket on token usage": the one approved
// addition to July's spans; the label is on all of July's metrics and spans for
// the session, `cursor.tool.calls` included: July's `join` stamps the whole tag
// bag on every sample (dist/internal/otel/collector.js:621-628) and the factory
// has no metric View). An implement session is pinned to its ticket by the
// `jira` channel's continuation token (`implement:<KEY>#<changelogId>`,
// lib/implement-turn.ts), so the key needs no read. Any other session (a
// person's direct chat, an eval) is `none`. Hooks run before July's collector
// sees the event, so the tag is in place when `turn.completed` records the
// usage; a cloud turn's usage is read from the SDK run when it ends
// (dist/internal/sdk-runner.js) and recorded by the collector on that same event
// (dist/internal/otel/collector.js), so one tag at `turn.started` covers the
// whole implement run.
export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      tag(ctx);
    },
  },
});

function tag(ctx: HookContext): void {
  tagSessionTicket(ctx.host, implementIssueKey(ctx.channel.continuationToken));
}

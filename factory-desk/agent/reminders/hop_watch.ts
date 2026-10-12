import { defineReminder } from "@cursor/july/reminders";
import { fireHopWatch, parseHopArgs } from "../lib/hop-watch.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { noteFactory, traced } from "../lib/factory-otel.js";

// The deadline of one hop (lib/hop-watch.ts). A named handler with JSON
// args, because hosted v2 fires those and rejects anonymous reminder `run`.
// It never calls `followup`: the line goes to the ticket's Slack thread
// from host code, and no model turn starts.
export default defineReminder({
  run: traced({ span: "factory.reminder", kind: "reminder.hop_watch" }, async ({ args, host, mcp }) => {
    bindOpsFunnel(host);
    const parsed = parseHopArgs(args);
    if (parsed === undefined) {
      noteFactory({ outcome: "bad_args" });
      return { action: "stop" };
    }
    const fired = await fireHopWatch({ host: { kv: host.kv, slack: host.slack, mcp }, now: () => new Date() }, parsed);
    console.log(JSON.stringify({ desk: "hop_watch", via: "reminder", ...fired }));
    noteFactory({ ticketKey: fired.issueKey, outcome: `${fired.hop}:${fired.result}` });
    return fired.rescheduleMs === undefined ? { action: "stop" } : { action: "skip", reschedule: { delay: fired.rescheduleMs } };
  }),
});

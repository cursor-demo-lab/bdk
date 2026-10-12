import { defineReminder } from "@cursor/july/reminders";
import { firePlanStartCheck, parseHopArgs } from "../lib/hop-watch.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { noteFactory, traced } from "../lib/factory-otel.js";

// The plan hop's start check, 4 minutes after a Triaged entry
// (lib/hop-watch.ts firePlanStartCheck): a planner that left no sign of
// running gets the ticket re-sent once, and the thread one line. A named
// handler with JSON args, like hop_watch, because hosted v2 fires those and
// rejects anonymous reminder `run`. It never calls `followup`: the line goes
// to the ticket's Slack thread from host code, and no model turn starts.
export default defineReminder({
  run: traced({ span: "factory.reminder", kind: "reminder.plan_start" }, async ({ args, host, mcp }) => {
    bindOpsFunnel(host);
    const parsed = parseHopArgs(args);
    if (parsed === undefined || parsed.hop !== "plan") {
      noteFactory({ outcome: "bad_args" });
      return { action: "stop" };
    }
    const fired = await firePlanStartCheck({ host: { kv: host.kv, slack: host.slack, mcp, reminders: host.reminders }, now: () => new Date() }, parsed);
    console.log(JSON.stringify({ desk: "plan_start_watch", via: "reminder", ...fired }));
    noteFactory({ ticketKey: fired.issueKey, outcome: `plan_start:${fired.result}` });
    return fired.rescheduleMs === undefined ? { action: "stop" } : { action: "skip", reschedule: { delay: fired.rescheduleMs } };
  }),
});

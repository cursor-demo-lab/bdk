import { defineReminder } from "@cursor/july/reminders";
import { fireImplementPrWatch, parseImplementPrArgs } from "../lib/implement-pr.js";
import { backstopImplementPrSweep, hostImplementPrDeps } from "../lib/implement-pr-sweep.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { noteFactory, traced } from "../lib/factory-otel.js";

// Armed at launch (lib/implement-pr.ts). Opens the implement PR once the
// agent has pushed its branch, then moves the ticket to In Review. Host code
// only: it never calls `followup`, so no model turn starts. After its own
// fire it runs the throttled backstop sweep for the other tickets' watches.
export default defineReminder({
  run: traced({ span: "factory.reminder", kind: "reminder.implement_pr" }, async ({ id, args, host, mcp }) => {
    bindOpsFunnel(host);
    const parsed = parseImplementPrArgs(args);
    if (parsed === undefined) {
      noteFactory({ outcome: "bad_args" });
      return { action: "stop" };
    }
    noteFactory({ ticketKey: parsed.issueKey });
    const deps = hostImplementPrDeps({ host, mcp });
    const fired = await fireImplementPrWatch(deps, parsed, { reminderId: id });
    console.log(JSON.stringify({ worker: "implement_pr", via: "reminder", issueKey: parsed.issueKey, ...fired.result, ...(fired.rescheduleMs === undefined ? {} : { rescheduleMs: fired.rescheduleMs }) }));
    noteFactory({ outcome: fired.result.outcome });
    await backstopImplementPrSweep(deps);
    return fired.rescheduleMs === undefined ? { action: "stop" } : { action: "skip", reschedule: { delay: fired.rescheduleMs } };
  }),
});

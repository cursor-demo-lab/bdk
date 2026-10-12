import { defineReminder } from "@cursor/july/reminders";
import { backstopImplementPrSweep, hostImplementPrDeps } from "../lib/implement-pr-sweep.js";
import { healLaunch } from "../lib/launch-heal.js";
import { parseLaunchWatchArgs } from "../lib/launch-watch.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { noteFactory, traced } from "../lib/factory-otel.js";

// Armed by the Jira route when it opens a launch watch (lib/launch-watch.ts),
// before the launch. Fires after the claim's grace; a ticket whose launch is
// still not recorded is replayed through the route's pipeline (lib/launch-heal.ts)
// without waiting for a person's `retry`. Host code only: it never calls
// `followup`, so no model turn starts. Then the throttled backstop sweep.
export default defineReminder({
  run: traced({ span: "factory.reminder", kind: "reminder.implement_launch" }, async ({ id, args, host, mcp }) => {
    bindOpsFunnel(host);
    const parsed = parseLaunchWatchArgs(args);
    if (parsed === undefined) {
      noteFactory({ outcome: "bad_args" });
      return { action: "stop" };
    }
    noteFactory({ ticketKey: parsed.issueKey });
    const deps = hostImplementPrDeps({ host, mcp });
    const orphan = parsed.orphan === undefined ? {} : { orphan: { ...parsed.orphan, at: parsed.at } };
    const healed = await healLaunch(deps, { issueKey: parsed.issueKey, reminderId: id, approvedAt: parsed.at, ...orphan });
    console.log(JSON.stringify({ worker: "launch_heal", via: "reminder", ...healed }));
    noteFactory({ outcome: healed.outcome });
    await backstopImplementPrSweep(deps);
    return healed.rescheduleMs === undefined ? { action: "stop" } : { action: "skip", reschedule: { delay: healed.rescheduleMs } };
  }),
});

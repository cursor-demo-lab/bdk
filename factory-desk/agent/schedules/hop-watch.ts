import { defineSchedule } from "@cursor/july/schedules";
import { runHopWatchSchedule } from "../lib/hop-watch.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { noteFactory, traced } from "../lib/factory-otel.js";

// Backstop for hop deadlines whose reminder could not be armed or is late
// (lib/hop-watch.ts), every five minutes. Self-hosted serve fires it on its
// own clock. On hosted v2, July 0.2.13 `deploy` declares it in the release
// manifest as a `run` schedule (`{ id: "hop-watch", cron: "*/5 * * * *",
// kind: "run" }`; the file name is the id, so it must stay a valid schedule
// id), the control plane fires it through the reserved schedule admission,
// and the guest runs this handler and waits for it to finish; the guest no
// longer upserts a platform timer at boot. The reminder stays the primary
// path. `backstopSweep` still runs from Jira and Slack admissions; a line
// both would post is claimed once (`announced/<KEY>:hop-…`). Every run logs one
// `{"desk":"hop_watch","via":"schedule",…}` line, idle or not, so the deploy
// logs show that it fires. Serve --dev never fires it; POST
// /v1/dev/schedules/hop-watch does.
export default defineSchedule({
  cron: "*/5 * * * *",
  run: traced({ span: "factory.schedule", kind: "schedule.hop-watch" }, async ({ host }) => {
    bindOpsFunnel(host);
    const line = await runHopWatchSchedule({ host, now: () => new Date() });
    noteFactory({ outcome: line.fired > 0 ? "fired" : line.due > 0 ? "due" : "idle" });
  }),
});

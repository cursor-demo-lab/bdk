// Every path that sends a ticket to the planner (`plan KEY`, `replan KEY`,
// `retry KEY`, a Needs-info reply, the request_plan tool) puts the planner
// crumb up itself. The Triaged webhook also shows one, but a bounce with the
// same verdict posts no Triaged line, and a planning run can take minutes
// (TLSSN-32: 7 min), so waiting on the webhook left the thread with only ⏳.

import { ensureLoader, postLoader } from "./loader.js";
import { setStatusReaction } from "./status-reaction.js";
import { parseThreadRef, ticketKey } from "./threads.js";
import type { KeyedKv } from "./kv-keys.js";
import { warnKv, warnStep } from "./ops-funnel.js";

/** `ensure` keeps a planner crumb already showing (a `re-planning…` line stays). */
export async function showPlannerWait(input: { kv: KeyedKv; getClient: () => Promise<unknown>; issueKey: string; phase: "planning" | "replanning"; ensure?: boolean }): Promise<void> {
  // The move landed; the crumb and the stage mark are best effort, and each
  // failure ends the rest as before.
  let client: unknown;
  try {
    client = await input.getClient();
    const loader = { kv: input.kv, client, issueKey: input.issueKey, phase: input.phase };
    if (input.ensure === true) await ensureLoader(loader);
    else await postLoader(loader);
  } catch (error) {
    warnStep("planner-wait.showPlannerWait.crumb", error);
    return;
  }
  let ticket: ReturnType<typeof parseThreadRef>;
  try {
    ticket = parseThreadRef(await input.kv.get(ticketKey(input.issueKey)));
  } catch (error) {
    warnKv("planner-wait.showPlannerWait", error);
    return;
  }
  try {
    await setStatusReaction({ kv: input.kv, client, issueKey: input.issueKey, ticket, stage: "planning" });
  } catch (error) {
    warnStep("planner-wait.showPlannerWait.reaction", error);
  }
}

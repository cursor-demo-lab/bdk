import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { issueKeySchema, planKey } from "../lib/plan.js";

// The recorded plan for a ticket, from the plan artifact. The desk asks for
// it when a person approves in a thread that does not carry the Brief:, and
// the planner calls it first on any request so an existing plan is returned
// rather than written twice.
//
// A record whose Plan: comment never landed on the ticket (record_plan's
// tracker is anything but commented / already_commented: not_connected,
// failed, projects_unset, project_not_allowed) is not a recorded plan here:
// nobody has read it, the ticket never moved to Planned, and the desk cannot
// signal replan without a Plan: comment. Returning found: true for it stops
// every retry at step 2 of the instructions (deployment-issues.md issue 26).
export default defineTool({
  description:
    "Return the recorded plan for a Jira issue, if one exists: title, when it was recorded, whether the ticket comment landed, and the implementation brief. Call it before planning; if a plan exists and nobody asked to replan, return its brief instead of planning again. A plan whose ticket comment never landed is reported as found: false with an unpublished field: nobody has read it, so plan on a Plan <KEY> message and, on Get plan or approve, say no plan is recorded.",
  inputSchema: z.object({ issueKey: issueKeySchema }),
  effect: "read",
  async execute(input, ctx) {
    const records = await ctx.artifacts.list({ kind: "plan" });
    const record = records.find((entry) => entry.key === planKey(input.issueKey));
    if (record === undefined) {
      return { found: false, issueKey: input.issueKey };
    }
    const data = record.data as Record<string, unknown>;
    const tracker = typeof data["tracker"] === "string" ? data["tracker"] : "";
    if (!commentLanded(tracker)) {
      return { found: false, issueKey: input.issueKey, unpublished: { artifactId: record.id, recordedAt: record.updatedAt, tracker } };
    }
    return {
      found: true,
      issueKey: input.issueKey,
      artifactId: record.id,
      recordedAt: record.updatedAt,
      title: typeof data["title"] === "string" ? data["title"] : "",
      evidence: typeof data["evidence"] === "string" ? data["evidence"] : "",
      tracker,
      brief: typeof data["brief"] === "string" ? data["brief"] : "",
    };
  },
});

// The Plan: comment is on the ticket, so someone can have read it. The same
// test gates the move to Planned in record_plan (moveToPlanned).
function commentLanded(tracker: string): boolean {
  return tracker === "commented" || tracker === "already_commented";
}

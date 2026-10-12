import { defineTool } from "@cursor/july/tools";
import { attemptOf, continuationFor, decide, planPrompt, planRequestSchema } from "../lib/chain.js";
import { projectOf, stagingRefusesProject } from "../lib/jira.js";
import { sessionIdOf } from "../lib/start-plan.js";
import { planSessionCloud } from "../lib/checkout.js";

// Host-to-host entry to the planning stage. triage-jira's record_triage
// calls it over the peer edge (`call_tool`, no planner model turn) at the
// end of its own execute, once the comment has landed. It opens the planning
// session on the `plan` channel keyed to the issue and returns at once; the
// plan itself is the session's model turn.
export default defineTool({
  description:
    "Start the planning stage for a triaged Jira issue. Opens one planning session per attempt, keyed to the issue (a repeated attempt reuses its session), unless triage says the ticket is a question, needs information, or is a duplicate. Host code calls this after triage; a person asks the desk instead.",
  inputSchema: planRequestSchema,
  effect: "write",
  dryRunResult: (input) => ({ started: false, reason: "dry_run", issueKey: input.issueKey }),
  async execute(input, ctx) {
    if (stagingRefusesProject(process.env, projectOf(input.issueKey))) {
      return { started: false, reason: "project_not_allowed", issueKey: input.issueKey };
    }
    const decision = decide(input.verdict);
    if (!decision.plan) {
      return { started: false, reason: decision.reason, issueKey: input.issueKey };
    }
    if (ctx.session.purpose === "eval") {
      return { started: false, reason: "eval", issueKey: input.issueKey };
    }
    const continuationToken = continuationFor({ issueKey: input.issueKey, attempt: attemptOf(input) });
    const session = await ctx.send("plan", planPrompt(input), {
      continuationToken,
      admission: "coalesce",
      title: `${input.issueKey}: ${input.title}`,
      ...planSessionCloud(process.env),
    });
    const sessionId = sessionIdOf(session);
    return { started: true, reason: "started", issueKey: input.issueKey, ...(sessionId === undefined ? {} : { sessionId }), continuationToken };
  },
});

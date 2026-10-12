import { defineChannel, POST, type ChannelHandlerArgsWithBody } from "@cursor/july/channels";
import { attemptOf, continuationFor, decide, planPrompt, planRequestSchema, type PlanRequest } from "../lib/chain.js";
import { projectOf, stagingRefusesProject } from "../lib/jira.js";
import { sessionIdOf } from "../lib/start-plan.js";
import { planSessionCloud } from "../lib/checkout.js";
import { describeResponse, traced } from "../lib/factory-otel.js";

// One route, `POST /planner/v1/channels/plan/issue`, and the channel
// `plan_issue` sends to. A session per planning attempt, keyed
// `issue:<KEY>#<attempt>`; a request that repeats its `attempt` coalesces
// into that session, and one without an `attempt` plans afresh. Loopback
// only under `--dev`, like triage-jira's queue route.
export default defineChannel({
  routes: [
    POST("/issue", {
      description: "Plan an existing Jira issue. Body: { issueKey, title, summary?, verdict? }",
      bodySchema: planRequestSchema,
      handler: traced({ span: "factory.delivery", kind: "plan.issue", describe: describeResponse }, async (_req: Request, { send, body }: ChannelHandlerArgsWithBody<PlanRequest>) => {
        if (stagingRefusesProject(process.env, projectOf(body.issueKey))) {
          return Response.json({ ok: true, started: false, reason: "project_not_allowed", issueKey: body.issueKey });
        }
        const decision = decide(body.verdict);
        if (!decision.plan) {
          return Response.json({ ok: true, started: false, reason: decision.reason, issueKey: body.issueKey });
        }
        const continuationToken = continuationFor({ issueKey: body.issueKey, attempt: attemptOf(body) });
        const session = await send(planPrompt(body), {
          continuationToken,
          admission: "coalesce",
          title: `${body.issueKey}: ${body.title}`,
          ...planSessionCloud(process.env),
        });
        const sessionId = sessionIdOf(session);
        return Response.json({ ok: true, started: true, ...(sessionId === undefined ? {} : { sessionId }), issueKey: body.issueKey, continuationToken });
      }),
    }),
  ],
});

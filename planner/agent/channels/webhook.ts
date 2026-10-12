import { defineChannel, POST, publicEndpoint, type ChannelHandlerArgsWithBody } from "@cursor/july/channels";
import { z } from "zod";
import { attemptFromEventId } from "../lib/chain.js";
import { statusNames } from "../lib/config.js";
import { allowedProjects, readTicket, stagingRefusesProject } from "../lib/jira.js";
import { commentClaimKey, commentEventId, commentProjects, decideComment, isStatusEvent, planClaimKey, planFromStatus } from "../lib/jira-event.js";
import { reportSkippedPlan } from "../lib/plan-outcome.js";
import { DELIVERY_ID_HEADER, startPlan } from "../lib/start-plan.js";
import { verifyTrackerWebhook } from "../lib/verify-webhook.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { describeResponse, traced } from "../lib/factory-otel.js";

export default defineChannel({
  auth: [publicEndpoint()],
  routes: [
    POST("/", {
      description:
        "Jira webhook (HMAC or Automation header secret). issue_updated into the Triaged status starts a plan; comment_created with Triage: or Plan requested: is a legacy local path, not registered on the hosted webhook.",
      bodySchema: z.unknown(),
      handler: traced({ span: "factory.delivery", kind: "jira.webhook", describe: describeResponse }, async (request: Request, { send, host, body }: ChannelHandlerArgsWithBody<unknown>) => {
        bindOpsFunnel(host);
        const rawBody = await request.text();
        const verified = verifyTrackerWebhook({
          rawBody,
          linearSignature: request.headers.get("linear-signature"),
          hubSignature:
            request.headers.get("x-hub-signature-256") ??
            request.headers.get("x-hub-signature"),
          factoryWebhookSecret: request.headers.get("x-factory-webhook-secret"),
          authorization: request.headers.get("authorization"),
          linearSecret: process.env.LINEAR_WEBHOOK_SECRET,
          jiraSecret: process.env.JIRA_WEBHOOK_SECRET,
          nowMs: Date.now(),
        });
        if (!verified.ok) {
          log(`rejected ${issueKeyOf(body)} (${verified.status}: signature or shared secret did not verify)`);
          return Response.json({ ok: false }, { status: verified.status });
        }
        const now = () => new Date();
        const deliveryId = request.headers.get(DELIVERY_ID_HEADER) ?? undefined;

        if (isStatusEvent(body)) {
          const statuses = statusNames(process.env);
          const decision = await planFromStatus(body, {
            triagedStatus: statuses.triaged,
            plannedStatus: statuses.planned,
            projects: allowedProjects(process.env),
            readComments: async (issueKey) => {
              const ticket = await readTicket(host.mcp, issueKey);
              return ticket.status === "read" ? ticket.comments : undefined;
            },
          });
          if (!decision.plan) {
            if ("changelogId" in decision) {
              const report = await reportSkippedPlan({ skip: decision, kv: host.kv, mcp: host.mcp, env: process.env, now: now() });
              log(`status ${decision.issueKey} ignored (${decision.reason}, verdict from ${decision.from}); Plan stopped: ${report.status === "reported" ? report.tracker : report.status}`);
              return Response.json({ ok: true, ignored: true, reason: decision.reason, via: "status", planStopped: report.status === "reported" ? report.tracker : report.status });
            }
            log(`status ${issueKeyOf(body)} ignored (${decision.reason})`);
            return Response.json({ ok: true, ignored: true, reason: decision.reason, via: "status" });
          }
          log(`status ${decision.request.issueKey} planned (changelog ${decision.changelogId}${decision.replan ? ", replan" : ""}${decision.request.verdict === undefined ? ", no verdict" : `, verdict ${decision.request.verdict.kind}`})`);
          // A redelivery carries the same changelog id and loses the claim. A
          // replan is a new transition with a new id, so it claims afresh.
          const key = planClaimKey({ issueKey: decision.request.issueKey, status: statuses.triaged, changelogId: decision.changelogId });
          return startPlan({
            kv: host.kv,
            key,
            clearFirst: false,
            request: decision.request,
            replan: decision.replan,
            attempt: attemptFromEventId(decision.changelogId),
            send,
            via: "status",
            now,
            env: process.env,
            ...(deliveryId === undefined ? {} : { deliveryId }),
          });
        }

        const outside = commentProjects(body).find((project) => stagingRefusesProject(process.env, project));
        if (outside !== undefined) {
          log(`comment ${issueKeyOf(body)} ignored (project_not_allowed: ${outside})`);
          return Response.json({ ok: true, ignored: true, reason: "project_not_allowed", via: "comment" });
        }
        const decision = decideComment(body);
        if (!decision.plan) {
          log(`comment ${issueKeyOf(body)} ignored (${decision.reason})`);
          return Response.json({ ok: true, ignored: true, reason: decision.reason, via: "comment" });
        }
        log(`comment ${decision.request.issueKey} planned${decision.replan ? " (replan)" : ""}`);
        const key = commentClaimKey(decision.request.issueKey);
        const attempt = attemptFromEventId(commentEventId(body));
        return startPlan({
          kv: host.kv,
          key,
          clearFirst: decision.replan,
          request: decision.request,
          replan: decision.replan,
          attempt,
          send,
          via: "comment",
          now,
          env: process.env,
          ...(deliveryId === undefined ? {} : { deliveryId }),
        });
      }),
    }),
  ],
});

// One line per delivery, so hosted logs show why a move into Triaged did or
// did not start a planning run even when no session exists.
function log(line: string): void {
  console.log(`[planner] webhook ${line}`);
}

function issueKeyOf(body: unknown): string {
  const issue = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["issue"] : undefined;
  const key = issue !== null && typeof issue === "object" ? (issue as Record<string, unknown>)["key"] : undefined;
  return typeof key === "string" && key !== "" ? key : "-";
}

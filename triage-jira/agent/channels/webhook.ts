import { defineChannel, POST, publicEndpoint, type ChannelHandlerArgsWithBody } from "@cursor/july/channels";
import { z } from "zod";
import {
  formatQueuePrompt,
  parseQueueEvent,
} from "../lib/parse-queue-event.js";
import { stashInbound } from "../lib/inbound.js";
import { describeWake, triageWake } from "../lib/jev-first.js";
import { stagingRefusesIssue } from "../lib/staging-issue.js";
import { verifyTrackerWebhook } from "../lib/verify-webhook.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { describeResponse, traceFactory, traced } from "../lib/factory-otel.js";

export default defineChannel({
  auth: [publicEndpoint()],
  routes: [
    POST("/", {
      description:
        "Linear or Jira issue-created webhook. HMAC hub signature, or Jira Automation X-Factory-Webhook-Secret / Bearer, against the matching secret.",
      bodySchema: z.unknown(),
      handler: traced({ span: "factory.delivery", kind: "jira.webhook", describe: describeResponse }, async (request: Request, { send, waitUntil, body, host }: ChannelHandlerArgsWithBody<unknown>) => {
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
          return Response.json({ ok: false }, { status: verified.status });
        }
        const parsed = parseQueueEvent(body);
        if (!parsed.ok) {
          return Response.json({ ok: true, ignored: true });
        }
        const issue = parsed.issue;
        if (stagingRefusesIssue(process.env, issue.identifier)) {
          return Response.json({ ok: true, ignored: true, reason: "staging_refuses_production" });
        }
        waitUntil(
          traceFactory({ span: "factory.background", kind: "jira.triage_wake", ticketKey: issue.identifier, describe: describeWake }, () => stashInbound(host.kv, issue).then(() =>
            triageWake({
              issue,
              mcp: host.mcp,
              kv: host.kv,
              send: () =>
                send(formatQueuePrompt(issue), {
                  continuationToken: issue.identifier,
                  admission: "coalesce",
                  title: issue.title === "" ? undefined : issue.title,
                }),
            })
          ))
        );
        return Response.json({
          ok: true,
          identifier: parsed.issue.identifier,
        });
      }),
    }),
  ],
});

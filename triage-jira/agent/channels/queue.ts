import { defineChannel, POST, type ChannelHandlerArgsWithBody } from "@cursor/july/channels";
import { z } from "zod";
import {
  formatQueuePrompt,
  isTrackerWebhook,
  parseQueueEvent,
} from "../lib/parse-queue-event.js";
import { stashInbound } from "../lib/inbound.js";
import { describeWake, triageWake } from "../lib/jev-first.js";
import { stagingRefusesIssue } from "../lib/staging-issue.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { describeResponse, traceFactory, traced } from "../lib/factory-otel.js";

export default defineChannel({
  routes: [
    POST("/issue", {
      description: "Triage an existing tracker issue",
      bodySchema: z.unknown(),
      handler: traced({ span: "factory.delivery", kind: "queue.issue", describe: describeResponse }, async (_req: Request, { send, waitUntil, body, host }: ChannelHandlerArgsWithBody<unknown>) => {
        bindOpsFunnel(host);
        const parsed = parseQueueEvent(body);
        if (!parsed.ok) {
          if ("ignored" in parsed) {
            return Response.json({ ok: true, ignored: true });
          }
          return Response.json(
            { ok: false, error: parsed.error },
            { status: 400 }
          );
        }
        if (stagingRefusesIssue(process.env, parsed.issue.identifier)) {
          return Response.json({ ok: true, ignored: true, reason: "staging_refuses_production" });
        }
        const options = {
          continuationToken: parsed.issue.identifier,
          admission: "coalesce" as const,
          title: parsed.issue.title === "" ? undefined : parsed.issue.title,
        };
        const prompt = formatQueuePrompt(parsed.issue);
        const issue = parsed.issue;
        const wake = () =>
          traceFactory({ span: "factory.background", kind: "jira.triage_wake", ticketKey: issue.identifier, describe: describeWake }, () =>
            stashInbound(host.kv, issue).then(() => triageWake({ issue, mcp: host.mcp, kv: host.kv, send: () => send(prompt, options) }))
          );
        if (isTrackerWebhook(body)) {
          waitUntil(wake());
          return Response.json({
            ok: true,
            identifier: parsed.issue.identifier,
          });
        }
        const woke = await wake();
        if (woke.fast) {
          return Response.json({ ok: true, jevOnly: true, identifier: parsed.issue.identifier });
        }
        if ("skipped" in woke) {
          return Response.json({ ok: true, skipped: woke.skipped, identifier: parsed.issue.identifier });
        }
        return Response.json({
          ok: true,
          sessionId: woke.sent.id,
          identifier: parsed.issue.identifier,
        });
      }),
    }),
  ],
});


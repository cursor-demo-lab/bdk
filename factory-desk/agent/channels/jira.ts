import { stagingRefusesSlackApp, type SlackAppHost } from "../lib/slack-app-guard.js";
import { defineChannel, POST, publicEndpoint, type ChannelHandlerArgsWithBody } from "@cursor/july/channels";
import { z } from "zod";
import {
  announceApproved,
  announceClosing,
  announceMovedBack,
  announceOutcome,
  announcePlan,
  announceProgress,
  announceTriaged,
  type AnnounceHost,
} from "../lib/announce.js";
import { jiraProjects, statusNames } from "../lib/config.js";
import { decideCommentEvent, isCommentEvent } from "../lib/outcome-event.js";
import { armHopWatch, backstopSweep, clearHopWatch, hopForOutcome } from "../lib/hop-watch.js";
import { clearPlanDeclined } from "../lib/plan-decline.js";
import { learnDeskSelfIdentity } from "../lib/self-identity.js";
import { decideStatusEvent, leftPlannedKey } from "../lib/status-event.js";
import { verifyTrackerWebhook } from "../lib/verify-webhook.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { describeResponse, traceFactory, traced, type FactoryNote } from "../lib/factory-otel.js";

export default defineChannel({
  auth: [publicEndpoint()],
  routes: [
    POST("/", {
      description:
        "Jira webhook (HMAC or Automation header secret). issue_updated into Triaged, Planned, Approved, In Progress, In Review, or Done posts that lifecycle announcement into the ticket's Slack thread; a move back to Planned from a later status is announced as a move back. comment_created whose first line is a factory outcome (triage's Triage stopped:, the planner's Needs info: or Plan stopped:, the worker's Launch failed:, Approved without a plan, or <status> not set from <repo>#<n>:) posts why the ticket did not move on and what to do next. Each entry into Triaged or Approved arms a hop watch whose reminder tells the thread when no move or outcome arrives in time.",
      bodySchema: z.unknown(),
      handler: traced({ span: "factory.delivery", kind: "jira.webhook", describe: describeResponse }, async (request: Request, { host, waitUntil, body }: ChannelHandlerArgsWithBody<unknown>) => {
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
        if (await stagingRefusesSlackApp(host as SlackAppHost)) {
          return Response.json({ ok: true, ignored: true, reason: "staging_refuses_production" });
        }
        void learnDeskSelfIdentity(host);
        const statuses = statusNames(process.env);
        const projects = jiraProjects(process.env);
        const ctx: AnnounceHost = { host, now: () => new Date() };
        waitUntil(traceFactory({ span: "factory.background", kind: "hop_watch.backstop_sweep", describe: (swept) => ({ outcome: swept.swept ? "swept" : swept.why }) }, () => backstopSweep(ctx)));

        if (isCommentEvent(body)) {
          const outcome = decideCommentEvent(body, { statuses, projects });
          if (outcome.kind === "ignored") {
            return Response.json({ ok: true, ignored: true, reason: outcome.reason });
          }
          const { kind, ...event } = outcome;
          const hop = hopForOutcome(kind);
          waitUntil(
            traceFactory({ span: "factory.background", kind: `jira.announce.${kind}`, ticketKey: event.issueKey, describe: describeAnnounce }, () =>
              (hop === undefined ? Promise.resolve(false) : clearHopWatch(host, event.issueKey, { hop }))
                .catch((error: unknown) => console.error(`[factory-desk] hop-watch clear for ${event.issueKey} failed:`, error))
                .then(() => announceOutcome({ kind, ...event }, ctx))
            ).catch((error: unknown) => {
              console.error(`[factory-desk] ${kind} announcement for ${event.issueKey} failed:`, error);
            })
          );
          return Response.json({ ok: true, kind, issueKey: event.issueKey });
        }

        const decision = decideStatusEvent(body, { statuses, projects });
        // The entry time, taken before the announce: the watch is armed only
        // after it settles, and a planner marker written meanwhile is this entry's.
        const enteredAt = entryTime({ body, received: ctx.now() });
        if (decision.kind === "ignored") {
          const leftPlanned = leftPlannedKey(body, { statuses, projects });
          if (leftPlanned !== undefined) waitUntil(clearPlanDeclined(host, leftPlanned, { movedAt: enteredAt }).catch(() => undefined));
          return Response.json({ ok: true, ignored: true, reason: decision.reason });
        }
        const event = { issueKey: decision.issueKey, title: decision.title, changelogId: decision.changelogId };
        // A ticket that left Planned (a drag, a replan, an approval) no longer carries a declined plan.
        if (decision.kind !== "planned") {
          waitUntil(clearPlanDeclined(host, decision.issueKey, { movedAt: enteredAt }).catch(() => undefined));
        }
        const announced = traceFactory({ span: "factory.background", kind: `jira.announce.${decision.kind}`, ticketKey: decision.issueKey, describe: describeAnnounce }, () =>
          decision.kind === "triaged"
            ? announceTriaged(event, ctx)
            : decision.kind === "planned" && decision.movedBackFrom !== undefined
            ? announceMovedBack({ ...event, from: decision.movedBackFrom }, ctx)
            : decision.kind === "planned"
            ? announcePlan({ ...event, tracker: "transitioned" }, ctx)
            : decision.kind === "approved"
              ? announceApproved(event, ctx)
              : decision.kind === "in_progress"
                ? announceProgress(event, ctx)
                : announceClosing({ ...event, stage: decision.kind }, ctx)
        );
        // A Jira-filed ticket's intake root opens with its Triaged line, so a
        // watch is armed once that announcement settled and the thread is bound.
        const hop = decision.kind === "triaged" ? "plan" : decision.kind === "approved" ? "launch" : undefined;
        const watch = traceFactory({ span: "factory.background", kind: hop === undefined ? "jira.hop_watch.clear" : `jira.hop_watch.arm_${hop}`, ticketKey: decision.issueKey, describe: describeWatch }, () =>
          hop === undefined
            ? clearHopWatch(host, decision.issueKey)
            : announced
                .catch(() => undefined)
                .then(() => armHopWatch(host, { issueKey: decision.issueKey, hop, changelogId: decision.changelogId, at: enteredAt }))
        );
        waitUntil(
          watch.catch((error: unknown) => {
            console.error(`[factory-desk] hop-watch for ${decision.issueKey} failed:`, error);
          })
        );
        waitUntil(
          announced.catch((error: unknown) => {
            console.error(`[factory-desk] ${decision.kind} announcement for ${decision.issueKey} failed:`, error);
          })
        );
        return Response.json({ ok: true, kind: decision.kind, issueKey: decision.issueKey });
      }),
    }),
  ],
});

/** An announce's `posted`, or why not, for its `factory.background` span (the delivery's span ends at the reply). */
function describeAnnounce(result: unknown): FactoryNote {
  const fields = result !== null && typeof result === "object" ? (result as { posted?: unknown; reason?: unknown }) : {};
  if (fields.posted === true) return { outcome: "posted" };
  return { outcome: "not_posted", ...(typeof fields.reason === "string" ? { reason: fields.reason } : {}) };
}

/** A hop watch's arm result, or whether a clear removed one. */
function describeWatch(result: boolean | { armed: boolean; reason?: string; reminder?: string }): FactoryNote {
  if (typeof result === "boolean") return { outcome: result ? "cleared" : "none" };
  return result.armed ? { outcome: "armed", ...(result.reminder === undefined ? {} : { reason: result.reminder }) } : { outcome: "not_armed", ...(result.reason === undefined ? {} : { reason: result.reason }) };
}

/**
 * When the ticket entered its status: Jira's own `timestamp` when the delivery
 * carries one, else the `{{issue.updated}}` the hosted Automation body puts at
 * the end of `changelog.id` (docs/jira-automation.md), else receipt. A time
 * later than receipt (clock skew) is receipt.
 */
export function entryTime(input: { body: unknown; received: Date }): Date {
  const body = input.body as { timestamp?: unknown; changelog?: { id?: unknown } } | null;
  const stamp = typeof body?.timestamp === "number" && Number.isFinite(body.timestamp) && body.timestamp > 0 ? body.timestamp : undefined;
  const at = stamp ?? updatedFromChangelogId(body?.changelog?.id);
  return at !== undefined && at < input.received.getTime() ? new Date(at) : input.received;
}

const JIRA_TIME = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/;

/** `TLSSN-45:Triaged:2026-09-28T10:11:00.000+0000` → that instant; a native numeric id has none. */
function updatedFromChangelogId(id: unknown): number | undefined {
  if (typeof id !== "string") return undefined;
  const match = id.match(JIRA_TIME);
  if (match === null) return undefined;
  const zone = match[2] === undefined || match[2] === "Z" ? "Z" : `${match[2].slice(0, 3)}:${match[2].slice(-2)}`;
  const at = Date.parse(`${match[1]}${zone}`);
  return Number.isNaN(at) ? undefined : at;
}

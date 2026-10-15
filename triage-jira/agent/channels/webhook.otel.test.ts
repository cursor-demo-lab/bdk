import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { context, metrics, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { DESK_TRIAGED_LINE } from "../lib/desk-triaged.js";
import { DELIVERY_METRIC } from "../lib/factory-otel.js";
import channel from "./webhook.js";

// The Jira webhook's factory spans, on the global tracer provider July registers, through the real route handler, with the
// tracker MCP unconnected so a desk-filed ticket stops at the sentinel (no
// Jev call, no model turn). Cursor's backend does not sample about 96% of
// inbound requests, and July's own span, a child of an unsampled parent, is
// then not recorded: the delivery's factory span must still be, as a root
// linked to the span July opened, and it must have ended before the response
// returns, because the hosted reply is what flushes it. The wake started with
// waitUntil is its child, in the same trace.

const SECRET = "otel-secret";
const INBOUND = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" };

const exporter = new InMemorySpanExporter();
const factoryProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
/** July's sampler: a child of an unsampled parent is never recorded. */
const julyProvider = new BasicTracerProvider({ sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(1) }) });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const saved = { secret: process.env.JIRA_WEBHOOK_SECRET, log: console.log };
beforeEach(() => {
  process.env.JIRA_WEBHOOK_SECRET = SECRET;
  trace.setGlobalTracerProvider(factoryProvider);
  exporter.reset();
  console.log = () => undefined;
});
afterEach(() => {
  console.log = saved.log;
  trace.disable();
  if (saved.secret === undefined) delete process.env.JIRA_WEBHOOK_SECRET;
  else process.env.JIRA_WEBHOOK_SECRET = saved.secret;
});

type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };
const route = (channel as unknown as { routes: Route[] }).routes[0]!;

const store = new Map<string, unknown>();
let hold: Promise<void> | undefined;
const kv = {
  get: async (key: string) => store.get(key) as never,
  put: async (key: string, value: unknown) => {
    await hold;
    store.set(key, value);
  },
  delete: async (key: string) => void store.delete(key),
};
const mcp = { names: () => ["planner"], listTools: async () => [], callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) };

const DESK_FILED = ["Login fails on Safari 17 with a blank page.", "Steps: open /login in Safari 17 and submit.", DESK_TRIAGED_LINE].join("\n\n");

function issueEvent(description: string): unknown {
  return {
    webhookEvent: "jira:issue_created",
    issue: {
      key: "TLSSN-40",
      self: "https://example.atlassian.net/rest/api/3/issue/10400",
      fields: { summary: "Login fails on Safari 17", description, status: { name: "To Do" }, issuetype: { name: "Task" }, reporter: { displayName: "Sam" } },
    },
  };
}

/** Drives the route inside a July-style `agent_sdk.http` span under an inbound request that was not sampled. */
async function deliver(input: { body: unknown; secret?: string }) {
  const background: Promise<unknown>[] = [];
  const remote = trace.setSpanContext(context.active(), { ...INBOUND, traceFlags: TraceFlags.NONE, isRemote: true });
  let http = { traceId: "", spanId: "" };
  const response = await context.with(remote, () =>
    julyProvider.getTracer("agent_sdk").startActiveSpan("agent_sdk.http", async (span) => {
      http = { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId };
      try {
        assert.equal(span.isRecording(), false, "July's span is not recorded under an unsampled parent");
        return await route.handler(
          new Request("http://triage/v1/channels/webhook/", {
            method: "POST",
            headers: { "content-type": "application/json", "x-factory-webhook-secret": input.secret ?? SECRET },
            body: JSON.stringify(input.body),
          }),
          { body: input.body, host: { kv, mcp }, waitUntil: (p: Promise<unknown>) => void background.push(p), send: async () => ({ id: "ses_1" }) }
        );
      } finally {
        span.end();
      }
    })
  );
  const endedAtReturn = exporter.getFinishedSpans().map((span) => span.name);
  return { response, background, http, endedAtReturn };
}

function named(name: string): ReadableSpan {
  const found = exporter.getFinishedSpans().filter((span) => span.name === name);
  assert.equal(found.length, 1, `${name} spans: ${found.length}`);
  return found[0]!;
}

test("an unsampled inbound request: factory.delivery is a root in a trace of its own, linked to July's span, and ended before the response returned", async () => {
  const { response, background, http, endedAtReturn } = await deliver({ body: issueEvent(DESK_FILED) });
  assert.equal(response.status, 200);
  assert.ok(endedAtReturn.includes("factory.delivery"), "the delivery span is out before the hosted reply");

  const delivery = named("factory.delivery");
  assert.equal(delivery.parentSpanContext, undefined, "a root");
  assert.notEqual(delivery.spanContext().traceId, INBOUND.traceId, "a trace of its own");
  assert.equal(delivery.spanContext().traceFlags & TraceFlags.SAMPLED, TraceFlags.SAMPLED);
  assert.equal(delivery.links.length, 1);
  assert.equal(delivery.links[0]!.context.traceId, http.traceId);
  assert.equal(delivery.links[0]!.context.spanId, http.spanId);
  assert.equal(delivery.attributes["factory.delivery.kind"], "jira.webhook");
  assert.equal(delivery.attributes["factory.outcome"], "accepted");

  await Promise.all(background);
  const wake = named("factory.background");
  assert.equal(wake.spanContext().traceId, delivery.spanContext().traceId, "the wake joins the delivery's trace");
  assert.equal(wake.parentSpanContext?.spanId, delivery.spanContext().spanId, "as its child");
  assert.equal(wake.attributes["factory.ticket.key"], "TLSSN-40");
  assert.equal(wake.attributes["factory.delivery.kind"], "jira.triage_wake");
  assert.equal(wake.attributes["factory.outcome"], "skipped");
});

test("a bad secret: factory.delivery is still a root and records the rejection, and no wake starts", async () => {
  const { response, background, endedAtReturn } = await deliver({ body: issueEvent(DESK_FILED), secret: "wrong" });
  assert.equal(response.status, 401);
  assert.deepEqual(endedAtReturn, ["factory.delivery"]);
  assert.equal(background.length, 0);
  const delivery = named("factory.delivery");
  assert.equal(delivery.parentSpanContext, undefined);
  assert.equal(delivery.attributes["factory.outcome"], "http_401");
});

test("an event the route ignores is a delivery span with outcome `ignored`", async () => {
  const { response, endedAtReturn } = await deliver({ body: { webhookEvent: "jira:issue_updated" } });
  assert.equal(response.status, 200);
  assert.deepEqual(endedAtReturn, ["factory.delivery"]);
  assert.equal(named("factory.delivery").attributes["factory.outcome"], "ignored");
});

test("the jira.triage_wake background counter is recorded when the waitUntil promise settles, not before", async () => {
  const meterExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: meterExporter, exportIntervalMillis: 3_600_000, exportTimeoutMillis: 2_000 })] });
  metrics.disable();
  metrics.setGlobalMeterProvider(meterProvider);
  try {
    const counted = async () => {
      meterExporter.reset();
      await meterProvider.forceFlush();
      return meterExporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === DELIVERY_METRIC)
        .flatMap((metric) => metric.dataPoints.map((point) => [point.attributes["factory.span"], point.attributes["factory.delivery.kind"], point.attributes["factory.outcome"], point.value]))
        .sort();
    };

    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const { response, background } = await deliver({ body: issueEvent(DESK_FILED) });
    assert.equal(response.status, 200);
    assert.equal(background.length, 1, "the already-triaged ticket runs no turn: the wake is the only background work");
    assert.deepEqual(await counted(), [["factory.delivery", "jira.webhook", "accepted", 1]], "the wake is still running when the handler returns, so only the delivery is counted");

    release();
    await Promise.all(background);
    assert.deepEqual(await counted(), [
      ["factory.background", "jira.triage_wake", "skipped", 1],
      ["factory.delivery", "jira.webhook", "accepted", 1],
    ]);
  } finally {
    hold = undefined;
    metrics.disable();
    await meterProvider.shutdown();
  }
});

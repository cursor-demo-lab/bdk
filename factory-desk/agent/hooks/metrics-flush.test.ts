import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import type { Meter } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { FLUSH_TIMEOUT_MS, flushFactoryMetrics } from "../lib/factory-metrics.js";
import hook from "./metrics-flush.js";

// The turn-end flush (hooks/metrics-flush.ts) in July's real order: the hooks
// of an event run first, then July's real collector records it
// (session-engine.js:3724-3750 dispatchEvent). The factory's provider has a
// periodic interval far longer than any test, so only the flush can export.

const internal = (file: string) => new URL(`../../node_modules/@cursor/july/dist/internal/${file}`, import.meta.url).href;
const { createOtelCollector } = (await import(internal("otel/collector.js"))) as {
  createOtelCollector: (
    runtime: { tracer: unknown; meter: Meter; config: { enabled: true; logs: false } },
    agentName: string,
    log: (line: string) => void,
  ) => { onEvent(event: Record<string, unknown>, session: Record<string, unknown>): void; close(): void };
};

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
const events = hook.events as unknown as Record<string, Handler | undefined>;

const PROVIDER = Symbol.for("apj_factory.otel.provider");
const holder = globalThis as { [PROVIDER]?: MeterProvider };
const PERIODIC_MS = 3_600_000;

const providers: MeterProvider[] = [];
function install(exporter: PushMetricExporter, exportTimeoutMillis = 2_000): Meter {
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: PERIODIC_MS, exportTimeoutMillis })] });
  providers.push(provider);
  holder[PROVIDER] = provider;
  return provider.getMeter("agent_sdk");
}

afterEach(() => {
  delete holder[PROVIDER];
  mock.restoreAll();
});
after(async () => {
  await Promise.allSettled(providers.map((provider) => provider.shutdown()));
});

const exported = (exporter: InMemoryMetricExporter) =>
  exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .flatMap((metric) => metric.dataPoints.map((point) => ({ name: metric.descriptor.name, attributes: { ...point.attributes }, value: point.value as number })));

function session(id: string, mode: "chat" | "task") {
  return { id, channelId: "http", mode, purpose: "live", auth: null };
}

/** One event the way July dispatches it: every hook handler first, then the collector. */
async function dispatch(collector: { onEvent(event: Record<string, unknown>, session: Record<string, unknown>): void }, info: Record<string, unknown>, event: Record<string, unknown>): Promise<void> {
  await events[event["type"] as string]?.(event, { session: info });
  collector.onEvent({ sessionId: info["id"], at: new Date().toISOString(), ...event }, info);
}

const warnings = () => (console.warn as unknown as ReturnType<typeof mock.fn>).mock.calls.map((call) => String(call.arguments[0]));

test("the hook flushes on session.waiting, session.completed and session.failed, and never on turn.completed, which July's collector has not recorded yet", () => {
  assert.deepEqual(Object.keys(events).sort(), ["session.completed", "session.failed", "session.waiting"]);
});

test("a chat turn: the token usage and turn count July records at turn.completed are exported before the session.waiting hook resolves, with the periodic interval not elapsed", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meter = install(exporter);
  const collector = createOtelCollector({ tracer: new BasicTracerProvider().getTracer("agent_sdk"), meter, config: { enabled: true, logs: false } }, "factory-desk", () => {});
  const info = session("ses_chat", "chat");
  const usage = { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0, reasoningTokens: 20, totalTokens: 1_050 };

  await dispatch(collector, info, { index: 0, type: "session.started", data: { channelId: "http" } });
  await dispatch(collector, info, { index: 1, turnId: "trn_1", type: "turn.started", data: {} });
  await dispatch(collector, info, { index: 2, turnId: "trn_1", type: "turn.completed", data: { result: "ok", usage } });
  assert.deepEqual(exported(exporter), [], "nothing has left yet: the periodic interval is an hour and a turn.completed hook would flush before the usage exists");

  await dispatch(collector, info, { index: 3, turnId: "trn_1", type: "session.waiting", data: {} });
  const points = exported(exporter);
  const tokens = points.filter((point) => point.name === "cursor.token.usage").map((point) => [point.attributes["cursor.token.type"], point.value]);
  assert.deepEqual(tokens.sort(), [["cache_read", 600], ["input", 1_000], ["output", 50], ["reasoning", 20]]);
  assert.deepEqual(points.filter((point) => point.name === "agent_sdk.turn.count").map((point) => point.value), [1]);
  assert.deepEqual(points.filter((point) => point.name === "agent_sdk.session.count").map((point) => point.value), [1], "July records the session at session.started");
  collector.close();
});

test("a short task session: a counter increment is exported by the session.completed hook with no periodic tick", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meter = install(exporter);
  const collector = createOtelCollector({ tracer: new BasicTracerProvider().getTracer("agent_sdk"), meter, config: { enabled: true, logs: false } }, "triage-jira", () => {});
  const info = session("ses_short", "task");

  await dispatch(collector, info, { index: 0, type: "session.started", data: { channelId: "http" } });
  meter.createCounter("apj_factory.short").add(1, { "agent_sdk.session_id": "ses_short" });
  assert.deepEqual(exported(exporter), []);
  await dispatch(collector, info, { index: 1, turnId: "trn_1", type: "session.completed", data: {} });
  assert.deepEqual(
    exported(exporter).filter((point) => point.name === "apj_factory.short").map((point) => point.value),
    [1],
  );
  collector.close();
});

test("session.failed flushes too", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meter = install(exporter);
  meter.createCounter("apj_factory.failed").add(2);
  await events["session.failed"]!({ type: "session.failed", data: { message: "task failed" } }, {});
  assert.deepEqual(exported(exporter).map((point) => [point.name, point.value]), [["apj_factory.failed", 2]]);
});

function stubExporter(exportImpl: (batch: ResourceMetrics, done: (result: ExportResult) => void) => void, forceFlush: () => Promise<void> = async () => {}): PushMetricExporter {
  return { export: exportImpl, forceFlush, shutdown: async () => {}, selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE };
}

test("an exporter that hangs: flushFactoryMetrics resolves within its bound with one [factory:otel] line", async () => {
  const meter = install(
    stubExporter(() => {}),
    300,
  );
  meter.createCounter("apj_factory.hang").add(1);
  mock.method(console, "warn", () => {});
  const started = Date.now();
  await flushFactoryMetrics(50);
  assert.ok(Date.now() - started < 250, `resolved at the bound, not at the exporter's own timeout (${Date.now() - started} ms)`);
  assert.deepEqual(warnings(), ["[factory:otel] metrics flush exceeded 50ms; continuing"]);
});

test("an exporter whose forceFlush rejects: flushFactoryMetrics resolves with one [factory:otel] line, and the hook handler does not throw", async () => {
  const meter = install(
    stubExporter(
      (_batch, done) => done({ code: ExportResultCode.SUCCESS }),
      async () => {
        throw new Error("collector unreachable");
      },
    ),
  );
  meter.createCounter("apj_factory.reject").add(1);
  mock.method(console, "warn", () => {});
  await flushFactoryMetrics();
  await events["session.waiting"]!({ type: "session.waiting", data: {} }, {});
  const lines = warnings();
  assert.equal(lines.length, 2, "one line per flush");
  for (const line of lines) assert.equal(line, "[factory:otel] metrics flush failed: collector unreachable");
});

test("a forceFlush that hangs past the bound and then rejects: the flush resolves at the bound with one line, and the late rejection is not unhandled", async () => {
  const meter = install(
    stubExporter(
      (_batch, done) => done({ code: ExportResultCode.SUCCESS }),
      () => new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("late failure")), 150)),
    ),
    1_000,
  );
  meter.createCounter("apj_factory.late").add(1);
  mock.method(console, "warn", () => {});
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const started = Date.now();
    await flushFactoryMetrics(50);
    assert.ok(Date.now() - started < 140, `resolved at the bound, before the late rejection (${Date.now() - started} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(warnings(), ["[factory:otel] metrics flush exceeded 50ms; continuing"], "one line: the late rejection is not logged again");
});

test("an export that fails or throws: the SDK hands it to its global error handler, so the flush resolves and never throws", async () => {
  const failing = install(stubExporter((_batch, done) => done({ code: ExportResultCode.FAILED, error: new Error("collector returned 400") })));
  failing.createCounter("apj_factory.fail").add(1);
  await flushFactoryMetrics();
  const throwing = install(
    stubExporter(() => {
      throw new Error("boom");
    }),
  );
  throwing.createCounter("apj_factory.throw").add(1);
  await flushFactoryMetrics();
  await events["session.failed"]!({ type: "session.failed", data: {} }, {});
});

test("a flush that completes leaves no timer behind", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  install(exporter).createCounter("apj_factory.timer").add(1);
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const before = timers();
  await flushFactoryMetrics(FLUSH_TIMEOUT_MS);
  assert.equal(timers(), before);
});

test("with no provider registered the flush does nothing and says nothing", async () => {
  mock.method(console, "warn", () => {});
  await flushFactoryMetrics();
  await events["session.waiting"]!({ type: "session.waiting", data: {} }, {});
  assert.deepEqual(warnings(), []);
});

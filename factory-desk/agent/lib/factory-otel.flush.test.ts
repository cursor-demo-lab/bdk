import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { DELIVERY_DURATION_METRIC, DELIVERY_METRIC, registerFactoryFlush, traced, tracedGithubHook, traceFactory } from "./factory-otel.js";
import { FLUSH_TIMEOUT_MS, flushFactoryMetrics, installFactoryMeter } from "./factory-metrics.js";

// The flush at the end of factory work (traceFactory's last open span of a
// delivery, lib/factory-otel.ts), on a real meter provider whose periodic
// interval is an hour: only a flush can export. The tracer is a real SDK
// provider so span order and status can be read back.

const PROVIDER = Symbol.for("apj_factory.otel.provider");
const INSTALLED = Symbol.for("apj_factory.otel.meter");
const holder = globalThis as { [PROVIDER]?: MeterProvider; [INSTALLED]?: true };
const PERIODIC_MS = 3_600_000;

const spanExporter = new InMemorySpanExporter();
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const providers: MeterProvider[] = [];
let flushes: ReturnType<typeof mock.method>;
let realFlush: () => Promise<void>;

function install(exporter: PushMetricExporter, exportTimeoutMillis = 2_000): MeterProvider {
  metrics.disable();
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: PERIODIC_MS, exportTimeoutMillis })] });
  providers.push(provider);
  metrics.setGlobalMeterProvider(provider);
  holder[PROVIDER] = provider;
  registerFactoryFlush(() => flushFactoryMetrics());
  realFlush = provider.forceFlush.bind(provider);
  flushes = mock.method(provider, "forceFlush");
  return provider;
}

beforeEach(() => {
  trace.disable();
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }));
  spanExporter.reset();
});
afterEach(() => {
  delete holder[PROVIDER];
  delete holder[INSTALLED];
  registerFactoryFlush(async () => {});
  metrics.disable();
  mock.restoreAll();
});
after(async () => {
  await Promise.allSettled(providers.map((provider) => provider.shutdown()));
});

type Point = { name: string; attributes: Record<string, unknown>; value: number };

/** Every data point in the exporter's batches; a histogram is its sample count. */
function exported(exporter: InMemoryMetricExporter): Point[] {
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .flatMap((metric) =>
      metric.dataPoints.map((point) => ({
        name: metric.descriptor.name,
        attributes: { ...point.attributes },
        value: typeof point.value === "number" ? point.value : (point.value as { count: number }).count,
      }))
    );
}

const deliveries = (exporter: InMemoryMetricExporter) =>
  exported(exporter)
    .filter((point) => point.name === DELIVERY_METRIC)
    .map((point) => [point.attributes["factory.span"], point.attributes["factory.delivery.kind"], point.attributes["factory.outcome"], point.value])
    .sort();

const cumulative = () => new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

test("a root factory.background span: its delivery count and duration are exported before traceFactory resolves, with the periodic interval not elapsed", async () => {
  const exporter = cumulative();
  install(exporter);
  const result = await traceFactory({ span: "factory.background", kind: "jira.triage_wake" }, async () => {
    assert.deepEqual(exported(exporter), []);
    return { woke: true };
  });
  assert.deepEqual(result, { woke: true });
  assert.deepEqual(deliveries(exporter), [["factory.background", "jira.triage_wake", "ok", 1]]);
  assert.deepEqual(
    exported(exporter).filter((point) => point.name === DELIVERY_DURATION_METRIC).map((point) => point.value),
    [1],
  );
  assert.equal(flushes.mock.callCount(), 1);
});

test("the span ends as before and the flush comes after it: the finished span is out, with its status and outcome, when the flush runs", async () => {
  install(cumulative());
  const seen: string[][] = [];
  flushes.mock.mockImplementation(async () => {
    seen.push(spanExporter.getFinishedSpans().map((span) => span.name));
    await realFlush();
  });
  await traceFactory({ span: "factory.reminder", kind: "reminder.x", describe: () => ({ outcome: "noted" }) }, () => 1);
  assert.deepEqual(seen, [["factory.reminder"]]);
  const [span] = spanExporter.getFinishedSpans();
  assert.equal(span!.status.code, 1);
  assert.equal(span!.attributes["factory.outcome"], "noted");
});

test("a traced handler that hands a factory.background wake to waitUntil: the delivery's span ends with the wake open, and the wake's end exports both counters", async () => {
  const exporter = cumulative();
  install(exporter);
  const background: Promise<unknown>[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const handler = traced({ span: "factory.delivery", kind: "jira.webhook" }, async (_request: Request, args: { waitUntil: (promise: Promise<unknown>) => void }) => {
    args.waitUntil(traceFactory({ span: "factory.background", kind: "jira.triage_wake" }, () => gate.then(() => "woke")));
    return Response.json({ ok: true });
  });
  const response = await handler(new Request("http://x/"), { waitUntil: (promise: Promise<unknown>) => void background.push(promise) });
  assert.equal(response.status, 200);
  assert.deepEqual(spanExporter.getFinishedSpans().map((span) => span.name), ["factory.delivery"], "the delivery span is out when the handler returns");
  assert.equal(flushes.mock.callCount(), 0, "the wake is still open, so nothing flushed yet");
  assert.deepEqual(exported(exporter), []);

  release();
  await Promise.all(background);
  assert.deepEqual(deliveries(exporter), [
    ["factory.background", "jira.triage_wake", "ok", 1],
    ["factory.delivery", "jira.webhook", "ok", 1],
  ]);
  assert.equal(flushes.mock.callCount(), 1);
});

test("a handler that schedules no background work flushes once, when its span ends", async () => {
  const exporter = cumulative();
  install(exporter);
  await traced({ span: "factory.delivery", kind: "slack.message" }, async () => Response.json({ ok: true }))();
  assert.deepEqual(deliveries(exporter), [["factory.delivery", "slack.message", "ok", 1]]);
  assert.equal(flushes.mock.callCount(), 1);
});

test("a GitHub hook returning a task: the hook's span flushes, and so does the task July runs after it in its own span", async () => {
  const exporter = cumulative();
  install(exporter);
  const hook = tracedGithubHook("github.pull_request", async () => ({ task: async () => undefined }));
  const dispatch = (await (hook as unknown as () => Promise<{ task: () => Promise<void> }>)()) as { task: () => Promise<void> };
  assert.equal(flushes.mock.callCount(), 1);
  assert.deepEqual(deliveries(exporter), [["factory.delivery", "github.pull_request", "task", 1]]);
  await dispatch.task();
  assert.equal(flushes.mock.callCount(), 2);
  assert.deepEqual(deliveries(exporter).at(-1), ["factory.github.task", "github.pull_request", "ok", 1]);
});

test("nested factory spans do not each flush: only the span that closes the delivery does", async () => {
  const exporter = cumulative();
  install(exporter);
  await traceFactory({ span: "factory.delivery", kind: "outer" }, async () => {
    await traceFactory({ span: "factory.background", kind: "inner.a" }, async () => {
      await traceFactory({ span: "factory.cloud_agent.launch", kind: "inner.deep" }, () => 1);
      assert.equal(flushes.mock.callCount(), 0);
    });
    await traceFactory({ span: "factory.background", kind: "inner.b" }, () => 2);
    assert.equal(flushes.mock.callCount(), 0);
  });
  assert.equal(flushes.mock.callCount(), 1, "the root's flush, and no other");
  assert.deepEqual(
    deliveries(exporter).map((row) => row[1]),
    ["inner.a", "inner.b", "inner.deep", "outer"],
  );
});

test("unrelated deliveries are separate: each root flushes on its own, and one still open does not hold another back", async () => {
  const exporter = cumulative();
  install(exporter);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = traceFactory({ span: "factory.delivery", kind: "slow" }, () => gate);
  await traceFactory({ span: "factory.delivery", kind: "fast" }, () => 1);
  assert.equal(flushes.mock.callCount(), 1);
  assert.deepEqual(deliveries(exporter).map((row) => row[1]), ["fast"]);
  release();
  await slow;
  assert.equal(flushes.mock.callCount(), 2);
});

test("work that throws is recorded, flushed, and rethrown unchanged, with the span's error status as before", async () => {
  const exporter = cumulative();
  install(exporter);
  const failure = new TypeError("jira said no");
  const outcome = await traceFactory({ span: "factory.background", kind: "jira.triage_wake" }, () => Promise.reject(failure)).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(outcome, failure, "the same error object");
  assert.deepEqual(deliveries(exporter), [["factory.background", "jira.triage_wake", "error", 1]]);
  assert.equal(flushes.mock.callCount(), 1);
  const [span] = spanExporter.getFinishedSpans();
  assert.equal(span!.status.code, 2);
  assert.equal(span!.status.message, "jira said no");
  assert.equal(span!.attributes["error.type"], "TypeError");
  assert.equal(span!.attributes["factory.outcome"], "error");
});

test("a flush that throws changes nothing: the result and a rethrown error pass through", async () => {
  install(cumulative());
  registerFactoryFlush(async () => {
    throw new Error("flush exploded");
  });
  assert.equal(await traceFactory({ span: "factory.delivery", kind: "x" }, () => 5), 5);
  await assert.rejects(
    traceFactory({ span: "factory.delivery", kind: "x" }, () => Promise.reject(new RangeError("work failed"))),
    RangeError,
  );
});

test("an exporter that hangs: traceFactory resolves within the flush bound, with one [factory:otel] line", async () => {
  const hanging: PushMetricExporter = {
    export: (_batch: ResourceMetrics, _done: (result: ExportResult) => void) => {},
    forceFlush: async () => {},
    shutdown: async () => {},
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
  };
  install(hanging, FLUSH_TIMEOUT_MS + 1_500);
  const warn = mock.method(console, "warn", () => {});
  const started = Date.now();
  assert.equal(await traceFactory({ span: "factory.background", kind: "jira.triage_wake" }, () => "done"), "done");
  const took = Date.now() - started;
  assert.ok(took >= FLUSH_TIMEOUT_MS - 100 && took < FLUSH_TIMEOUT_MS + 300, `resolved at the ${FLUSH_TIMEOUT_MS} ms bound (${took} ms)`);
  assert.deepEqual(
    warn.mock.calls.map((call) => String(call.arguments[0])),
    [`[factory:otel] metrics flush exceeded ${FLUSH_TIMEOUT_MS}ms; continuing`],
  );
});

test("an exporter whose export fails does not fail the work", async () => {
  install({
    export: (_batch, done) => done({ code: ExportResultCode.FAILED, error: new Error("collector returned 400") }),
    forceFlush: async () => {},
    shutdown: async () => {},
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
  });
  assert.equal(await traceFactory({ span: "factory.delivery", kind: "x" }, () => "ok"), "ok");
});

test("with no meter provider registered traceFactory neither flushes nor says anything", async () => {
  const warn = mock.method(console, "warn", () => {});
  metrics.disable();
  delete holder[PROVIDER];
  registerFactoryFlush(() => flushFactoryMetrics());
  assert.equal(await traceFactory({ span: "factory.delivery", kind: "x" }, () => 3), 3);
  assert.equal(warn.mock.callCount(), 0);
});

test("installFactoryMeter wires the flush: a root span's end forceFlushes the provider it registered", async () => {
  registerFactoryFlush(async () => {});
  metrics.disable();
  installFactoryMeter();
  const provider = holder[PROVIDER]!;
  providers.push(provider);
  const forceFlush = mock.method(provider, "forceFlush");
  await traceFactory({ span: "factory.delivery", kind: "x" }, () => 1);
  assert.equal(forceFlush.mock.callCount(), 1);
});

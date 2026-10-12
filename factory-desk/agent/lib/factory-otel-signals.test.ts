import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { context, type Attributes } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor, type ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, DataPointType, InMemoryMetricExporter, type MetricData } from "@opentelemetry/sdk-metrics";
import { RandomIdGenerator, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { wakeHex, type WakeSources } from "./factory-otel.js";
import {
  exportGatedSampler,
  factoryIdGenerator,
  factoryLogExporter,
  factoryMeterProvider,
  factorySpanExporter,
  factoryTracerProvider,
  METRIC_ATTRIBUTE_KEYS,
  METRIC_CARDINALITY_LIMIT,
  METRIC_REMINDER_PURPOSES,
  METRIC_REMINDER_REASONS,
  METRIC_VALUES,
  exportedLogRecord,
  metricAttributes,
  spanWithResource,
  TRACE_DELAY_MS,
} from "./factory-otel-signals.js";

// The export wiring's pieces that need no collector: the id generator, the
// tracer provider and its batching, and the metric View. The wiring as July
// drives it, against a collector, is july-otel.test.ts.

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const HEADER = "Authorization=Basic x";
const HOST_DIR = fileURLToPath(new URL("../../", import.meta.url));

beforeEach(() => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = HEADER;
});
afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  mock.restoreAll();
});

function cloned(): WakeSources {
  return { kernel: (length) => Buffer.alloc(length, 7), ambient: () => "frozen", skew: () => 0 };
}

test("wakeHex: the length asked for, clamped to 1..32 bytes, in lowercase hex", () => {
  assert.match(wakeHex({ bytes: 16 }), /^[0-9a-f]{32}$/);
  assert.match(wakeHex({ bytes: 8 }), /^[0-9a-f]{16}$/);
  assert.equal(wakeHex({ bytes: 0 }).length, 2);
  assert.equal(wakeHex({ bytes: 500 }).length, 64);
});

test("wakeHex mixes every source: the same inputs give the same bytes, and changing the kernel pool, the ambient values, or the salt changes them", () => {
  const base = cloned();
  const same = wakeHex({ bytes: 16, sources: base, salt: "s" });
  assert.equal(wakeHex({ bytes: 16, sources: base, salt: "s" }), same);
  assert.notEqual(wakeHex({ bytes: 16, sources: { ...base, kernel: (length) => Buffer.alloc(length, 8) }, salt: "s" }), same, "a different kernel pool");
  assert.notEqual(wakeHex({ bytes: 16, sources: { ...base, ambient: () => "later" }, salt: "s" }), same, "a different clock");
  assert.notEqual(wakeHex({ bytes: 16, sources: base, salt: "t" }), same, "a different request");
  assert.notEqual(wakeHex({ bytes: 16, sources: base }), same, "no request at all");
});

test("wakeHex never draws on Math.random, so a cloned PRNG state cannot repeat an id", () => {
  const random = mock.method(Math, "random", () => {
    throw new Error("Math.random was used");
  });
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) ids.add(factoryIdGenerator.generateSpanId()).add(factoryIdGenerator.generateTraceId()).add(wakeHex({ bytes: 16 }));
  assert.equal(ids.size, 600, "every draw is different");
  assert.equal(random.mock.callCount(), 0);
});

test("factoryIdGenerator: a 32-hex trace id and a 16-hex span id, never all zeros, 5,000 draws without a repeat", () => {
  const traces = new Set<string>();
  const spans = new Set<string>();
  for (let i = 0; i < 5_000; i++) {
    const traceId = factoryIdGenerator.generateTraceId();
    const spanId = factoryIdGenerator.generateSpanId();
    assert.match(traceId, /^[0-9a-f]{32}$/);
    assert.match(spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(traceId, "0".repeat(32));
    assert.notEqual(spanId, "0".repeat(16));
    traces.add(traceId);
    spans.add(spanId);
  }
  assert.equal(traces.size, 5_000);
  assert.equal(spans.size, 5_000);
});

test("with the header unset an id is plain randomBytes: no clock read, no Math.random, still well-formed; with it set the id is drawn with wakeHex", () => {
  const clock = mock.method(process.hrtime, "bigint");
  const random = mock.method(Math, "random", () => {
    throw new Error("Math.random was used");
  });
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const cheap = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const traceId = factoryIdGenerator.generateTraceId();
    const spanId = factoryIdGenerator.generateSpanId();
    assert.match(traceId, /^[0-9a-f]{32}$/);
    assert.match(spanId, /^[0-9a-f]{16}$/);
    cheap.add(traceId).add(spanId);
  }
  assert.equal(cheap.size, 1_000, "no repeat");
  assert.equal(clock.mock.callCount(), 0, "no wakeHex: no clock read");
  assert.equal(random.mock.callCount(), 0);

  process.env.OTEL_EXPORTER_OTLP_HEADERS = HEADER;
  factoryIdGenerator.generateSpanId();
  assert.ok(clock.mock.callCount() > 0, "with the header set the id comes from wakeHex, which reads the clock");
  assert.equal(random.mock.callCount(), 0);
});

test("two processes with the same Math.random state (a snapshot restored twice) get the same OTel default span id, and different factory ids", { timeout: 60_000 }, () => {
  const code = `
    import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
    import { factoryIdGenerator } from "./agent/lib/factory-otel-signals.ts";
    const otel = new RandomIdGenerator();
    console.log(JSON.stringify({
      otel: [otel.generateTraceId(), otel.generateSpanId(), otel.generateSpanId()],
      factory: [factoryIdGenerator.generateTraceId(), factoryIdGenerator.generateSpanId(), factoryIdGenerator.generateSpanId()],
    }));
  `;
  const run = () =>
    JSON.parse(
      execFileSync(process.execPath, ["--random-seed=42", "--import", "tsx", "--input-type=module", "-e", code], { cwd: HOST_DIR, encoding: "utf8", env: { ...process.env, OTEL_EXPORTER_OTLP_HEADERS: "" } }).trim().split("\n").at(-1)!
    ) as { otel: string[]; factory: string[] };
  const first = run();
  const second = run();
  assert.deepEqual(first.otel, second.otel, "the premise: OTel's default generator repeats under a cloned seed");
  for (let i = 0; i < 3; i++) assert.notEqual(first.factory[i], second.factory[i], `factory id ${i} differs between the two processes`);
  assert.equal(new Set([...first.factory, ...second.factory]).size, 6);
  assert.equal(new RandomIdGenerator().generateSpanId().length, 16);
});

test("a span's ids come from the factory generator: the same request's spans differ, and a span id is drawn when the span starts", () => {
  const exported: ReadableSpan[] = [];
  const provider = factoryTracerProvider({ export: (spans, done) => (exported.push(...spans), done({ code: ExportResultCode.SUCCESS })), shutdown: async () => undefined });
  const tracer = provider.getTracer("t");
  const random = mock.method(Math, "random", () => {
    throw new Error("Math.random was used");
  });
  const a = tracer.startSpan("a", { root: true });
  const b = tracer.startSpan("b", { root: true });
  assert.notEqual(a.spanContext().spanId, b.spanContext().spanId);
  assert.notEqual(a.spanContext().traceId, b.spanContext().traceId);
  assert.equal(random.mock.callCount(), 0);
  a.end();
  b.end();
});

/** A span exporter that records its batches and can be told to be slow. */
function recorder(input: { delayMs?: number } = {}): SpanExporter & { batches: string[][] } {
  const batches: string[][] = [];
  return {
    batches,
    export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
      batches.push(spans.map((span) => span.name));
      setTimeout(() => done({ code: ExportResultCode.SUCCESS }), input.delayMs ?? 0);
    },
    shutdown: async () => undefined,
  };
}

test("with the header unset the factory's tracer provider records nothing and exports nothing", async () => {
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const exporter = recorder();
  const provider = factoryTracerProvider(exporter);
  const span = provider.getTracer("t").startSpan("quiet", { root: true });
  assert.equal(span.isRecording(), false);
  span.end();
  await provider.forceFlush();
  assert.deepEqual(exporter.batches, []);
  assert.equal(exportGatedSampler.shouldSample(context.active(), "0".repeat(32), "n", 0, {}, []).decision, 0);
});

test("with the header set a finished span leaves on its own within TRACE_DELAY_MS, with no flush asked for", async () => {
  const exporter = recorder();
  const provider = factoryTracerProvider(exporter);
  const span = provider.getTracer("t").startSpan("on_a_timer", { root: true });
  assert.equal(span.isRecording(), true);
  span.end();
  assert.deepEqual(exporter.batches, [], "queued, not sent yet");
  await new Promise((resolve) => setTimeout(resolve, TRACE_DELAY_MS + 250));
  assert.deepEqual(exporter.batches, [["on_a_timer"]]);
  await provider.shutdown();
});

test("OTEL_BSP_SCHEDULE_DELAY changes nothing: the factory's processor is given TRACE_DELAY_MS, and July's hosted path has no batch processor to read it", async () => {
  process.env.OTEL_BSP_SCHEDULE_DELAY = "60000";
  try {
    const exporter = recorder();
    const provider = factoryTracerProvider(exporter);
    provider.getTracer("t").startSpan("explicit_delay", { root: true }).end();
    await new Promise((resolve) => setTimeout(resolve, TRACE_DELAY_MS + 250));
    assert.deepEqual(exporter.batches, [["explicit_delay"]]);
    await provider.shutdown();
  } finally {
    delete process.env.OTEL_BSP_SCHEDULE_DELAY;
  }
});

test("a span that ends while an export is running is exported by the next flush: none lost, none sent twice", async () => {
  const exporter = recorder({ delayMs: 150 });
  const provider = factoryTracerProvider(exporter);
  const tracer = provider.getTracer("t");
  tracer.startSpan("first", { root: true }).end();
  const running = provider.forceFlush();
  await new Promise((resolve) => setTimeout(resolve, 30));
  tracer.startSpan("during_export", { root: true }).end();
  await running;
  await provider.forceFlush();
  assert.deepEqual(exporter.batches, [["first"], ["during_export"]]);
  await provider.forceFlush();
  assert.equal(exporter.batches.length, 2, "nothing is sent twice");
  await provider.shutdown();
});

// ---- retry after a failed export ----

type Seen = { path: string; body: string };

/** A local OTLP collector that holds the first `hang` requests open (the client times them out), then answers 200. */
async function collector(input: { hang: number }): Promise<{ seen: Seen[]; close(): void }> {
  const seen: Seen[] = [];
  const held: ServerResponse[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("latin1") });
      if (held.length < input.hang) {
        held.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    seen,
    close() {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}

async function endedSpans(names: string[]): Promise<ReadableSpan[]> {
  const captured: ReadableSpan[] = [];
  const provider = factoryTracerProvider({ export: (spans, done) => (captured.push(...spans), done({ code: ExportResultCode.SUCCESS })), shutdown: async () => undefined });
  for (const name of names) provider.getTracer("t").startSpan(name, { root: true }).end();
  await provider.forceFlush();
  return captured;
}

async function emittedRecords(marks: string[]): Promise<ReadableLogRecord[]> {
  const captured: ReadableLogRecord[] = [];
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ export: (records, done) => (captured.push(...records), done({ code: ExportResultCode.SUCCESS })), shutdown: async () => undefined })],
  });
  for (const mark of marks) provider.getLogger("t").emit({ body: "turn.completed", attributes: { "agent_sdk.event": mark } });
  await provider.forceFlush();
  return captured;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const occurrences = (input: { body: string; word: string }) => input.body.split(input.word).length - 1;

test("two span exports in flight that both time out leave both batches for the next one, and a success clears them", { timeout: 20_000 }, async () => {
  const server = await collector({ hang: 2 });
  try {
    const [a, b, c, d] = (await endedSpans(["span_a", "span_b", "span_c", "span_d"])).map((span) => [span]);
    const sendSpans = (spans: ReadableSpan[]) => new Promise<ExportResult>((resolve) => factorySpanExporter.export(spans, resolve));
    const overlapping = Promise.all([sendSpans(a!), sendSpans(b!)]);
    await sleep(300);
    assert.equal(server.seen.length, 2, "both requests are in flight at once");
    for (const result of await overlapping) assert.equal(result.code, ExportResultCode.FAILED, "the collector never answered");

    assert.equal((await sendSpans(c!)).code, ExportResultCode.SUCCESS);
    const third = server.seen.at(-1)!.body;
    for (const name of ["span_a", "span_b", "span_c"]) assert.equal(occurrences({ body: third, word: name }), 1, `${name} rides the third export, once`);

    assert.equal((await sendSpans(d!)).code, ExportResultCode.SUCCESS);
    const fourth = server.seen.at(-1)!.body;
    assert.equal(occurrences({ body: fourth, word: "span_d" }), 1);
    for (const name of ["span_a", "span_b", "span_c"]) assert.equal(occurrences({ body: fourth, word: name }), 0, `${name} is not sent again after an accepted export`);
  } finally {
    server.close();
  }
});

test("two log exports in flight that both time out leave both batches for the next one, and a success clears them", { timeout: 20_000 }, async () => {
  const server = await collector({ hang: 2 });
  try {
    const [a, b, c, d] = (await emittedRecords(["mark_a", "mark_b", "mark_c", "mark_d"])).map((record) => [record]);
    const sendLogs = (records: ReadableLogRecord[]) => new Promise<ExportResult>((resolve) => factoryLogExporter.export(records, resolve));
    const overlapping = Promise.all([sendLogs(a!), sendLogs(b!)]);
    await sleep(300);
    assert.equal(server.seen.length, 2, "both requests are in flight at once");
    for (const result of await overlapping) assert.equal(result.code, ExportResultCode.FAILED, "the collector never answered");

    assert.equal((await sendLogs(c!)).code, ExportResultCode.SUCCESS);
    const third = server.seen.at(-1)!.body;
    for (const mark of ["mark_a", "mark_b", "mark_c"]) assert.equal(occurrences({ body: third, word: mark }), 1, `${mark} rides the third export, once`);

    assert.equal((await sendLogs(d!)).code, ExportResultCode.SUCCESS);
    const fourth = server.seen.at(-1)!.body;
    assert.equal(occurrences({ body: fourth, word: "mark_d" }), 1);
    for (const mark of ["mark_a", "mark_b", "mark_c"]) assert.equal(occurrences({ body: fourth, word: mark }), 0, `${mark} is not sent again after an accepted export`);
  } finally {
    server.close();
  }
});

test("a timed-out export may have been accepted, so its batch can arrive twice: delivery is at least once", { timeout: 20_000 }, async () => {
  const server = await collector({ hang: 1 });
  try {
    const [first, second] = (await endedSpans(["span_once", "span_next"])).map((span) => [span]);
    const sendSpans = (spans: ReadableSpan[]) => new Promise<ExportResult>((resolve) => factorySpanExporter.export(spans, resolve));
    assert.equal((await sendSpans(first!)).code, ExportResultCode.FAILED);
    assert.equal(occurrences({ body: server.seen[0]!.body, word: "span_once" }), 1, "the collector had the whole request, and could have stored it");
    assert.equal((await sendSpans(second!)).code, ExportResultCode.SUCCESS);
    assert.equal(occurrences({ body: server.seen[1]!.body, word: "span_once" }), 1, "and the retry sends it again");
  } finally {
    server.close();
  }
});

type Installation = { ours: boolean; carried: boolean; managerKept: boolean | null; diagErrors: string[]; stderr: string };

/** installFactorySignals, twice, in a fresh process (the API's globals are per process) after `before`. */
function installRun(before = ""): Installation {
  const code = `
    import { context, createContextKey, diag, DiagLogLevel, ROOT_CONTEXT, trace } from "@opentelemetry/api";
    import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
    import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
    const diagErrors = [];
    diag.setLogger({ error: (message) => diagErrors.push(String(message)), warn() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.ERROR);
    let manager = null;
    ${before}
    const { installFactorySignals } = await import("./agent/lib/factory-otel-signals.ts");
    installFactorySignals();
    installFactorySignals();
    const state = globalThis[Symbol.for("apj_factory.otel.signals")];
    const key = createContextKey("probe");
    const carried = await context.with(ROOT_CONTEXT.setValue(key, true), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return context.active().getValue(key) === true;
    });
    const result = {
      ours: trace.getTracerProvider().getDelegate() === state.tracerProvider,
      carried,
      managerKept: manager === null ? null : context._getContextManager() === manager,
      diagErrors,
    };
    process.stdout.write("\\n@@" + JSON.stringify(result));
  `;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: HOST_DIR,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", OTEL_EXPORTER_OTLP_HEADERS: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  return { ...(JSON.parse(run.stdout.slice(run.stdout.lastIndexOf("\n@@") + 3)) as Omit<Installation, "stderr">), stderr: run.stderr };
}

test("installFactorySignals makes the factory's tracer provider the global one (July then adopts it, Bug 6b) and registers a context manager that carries the active context across an await, once", { timeout: 60_000 }, () => {
  const run = installRun();
  assert.equal(run.ours, true, "the global tracer provider's delegate is the factory's");
  assert.equal(run.carried, true, "an AsyncLocalStorage context manager is registered: a span's parent survives an await");
  assert.deepEqual(run.diagErrors, [], "the second call registers nothing again: no duplicate-registration error");
  assert.doesNotMatch(run.stderr, /global_provider_taken/);
});

test("installFactorySignals keeps a context manager already registered, and adds none", { timeout: 60_000 }, () => {
  const run = installRun(`
    manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
  `);
  assert.equal(run.managerKept, true);
  assert.equal(run.carried, true);
  assert.deepEqual(run.diagErrors, [], "no second context manager was offered to the API");
  assert.equal(run.ours, true);
});

test("when another tracer provider holds the global slot, installFactorySignals warns global_provider_taken with tracer false and does not claim the tracer", { timeout: 60_000 }, () => {
  const run = installRun(`trace.setGlobalTracerProvider(new BasicTracerProvider());`);
  assert.equal(run.ours, false, "the earlier provider keeps the slot");
  assert.match(run.stderr, /\{"otel":"global_provider_taken","tracer":false,"meter":true,"logger":true\}/);
  assert.equal(run.stderr.split("global_provider_taken").length - 1, 1, "warned once, not again on the second call");
});

test("spanWithResource swaps the resource and leaves the rest of the span alone", () => {
  const exporter = recorder();
  const provider = factoryTracerProvider(exporter);
  const span = provider.getTracer("t").startSpan("res", { root: true, attributes: { "factory.outcome": "ok" } });
  span.end();
  const original = span as unknown as ReadableSpan;
  const resource = resourceFromAttributes({ "service.name": "factory-desk", "service.instance.id": "i-1" });
  const swapped = spanWithResource({ span: original, resource });
  assert.equal(swapped.resource.attributes["service.instance.id"], "i-1");
  assert.equal(swapped.name, "res");
  assert.equal(swapped.attributes["factory.outcome"], "ok");
  assert.equal(swapped.spanContext().spanId, original.spanContext().spanId);
});

test("exportedLogRecord swaps the resource and leaves the body and every attribute alone", () => {
  const resource = resourceFromAttributes({ "service.name": "factory-desk", "service.instance.id": "i-1" });
  const record = {
    body: "turn.completed",
    attributes: { "cursor.model.name": "claude-4.6-sonnet", "agent_sdk.cost_usd": 0.5, "agent_sdk.user_prompt": "USER_PROMPT_MARK" },
  } as unknown as ReadableLogRecord;
  const exported = exportedLogRecord({ record, resource });
  assert.equal(exported.body, "turn.completed");
  assert.deepEqual(exported.attributes, record.attributes);
  assert.equal(exported.resource.attributes["service.instance.id"], "i-1");
});

// ---- metric attributes ----

function points(input: { metrics: ReturnType<InMemoryMetricExporter["getMetrics"]>; name: string }): MetricData["dataPoints"] {
  const all = input.metrics.flatMap((batch) => batch.scopeMetrics.flatMap((scope) => scope.metrics)).filter((metric) => metric.descriptor.name === input.name);
  return all.at(-1)?.dataPoints ?? [];
}

test("metricAttributes keeps hosted-execution phase, channel_kind, delivery_surface, outcome, and the reminder kind and purpose, and still drops ids and tags", () => {
  assert.deepEqual(
    metricAttributes({
      phase: "to_first_visible",
      channel_kind: "slack",
      delivery_surface: "slack",
      outcome: "final_post",
      kind: "delivered",
      purpose: "hop_watch",
      reason: "session_joined",
      "agent_sdk.agent": "factory-desk",
      "cursor.conversation.id": "ses_abc",
      "agent_sdk.session_id": "ses_abc",
      "agent_sdk.sdk_agent_id": "bc-1",
      "support.ticket_id": "INC-1",
    }),
    { phase: "to_first_visible", channel_kind: "slack", delivery_surface: "slack", outcome: "final_post", kind: "delivered", purpose: "hop_watch", reason: "session_joined", "agent_sdk.agent": "factory-desk" }
  );
  for (const key of ["phase", "channel_kind", "delivery_surface", "outcome", "kind", "purpose", "reason"]) assert.ok(METRIC_ATTRIBUTE_KEYS.includes(key), `${key} is allowed`);
});

test("channel_kind holds every channel kind July 0.2.18 mounts, so none of its latency series collapses to `other`", () => {
  const source = readFileSync(new URL("../../node_modules/@cursor/july/dist/internal/continuation-channel.js", import.meta.url), "utf8");
  const mounted = [...source.matchAll(/^\s{8}kind: "([a-z_]+)",$/gm)].map((match) => match[1]!);
  assert.ok(mounted.length >= 8, `read ${mounted.length} channel kinds from July's continuation packs`);
  assert.deepEqual(
    mounted.filter((kind) => !METRIC_VALUES.channel_kind.has(kind)),
    [],
    "a channel kind July mounts that METRIC_VALUES.channel_kind does not list"
  );
  for (const kind of ["issues", "runs", "change_monitors"]) assert.equal(metricAttributes({ channel_kind: kind }).channel_kind, kind);
});

test("every enum-like key keeps exactly the values July 0.2.18 sets for it, and any other value, a well-shaped one included, is `other`", () => {
  for (const [key, values] of Object.entries(METRIC_VALUES)) {
    for (const value of values) assert.equal(metricAttributes({ [key]: value })[key], value, `${key}=${value} is kept`);
    for (const stranger of ["made_up_value", "slack_extra", "", "TLSSN-123", "approve this ticket now", "x".repeat(60), "7up", 42, true, { a: 1 }]) {
      assert.equal(metricAttributes({ [key]: stranger as never })[key], "other", `${key}=${JSON.stringify(stranger)}`);
    }
  }
  assert.equal(metricAttributes({ phase: "slack" }).phase, "other", "a value of another key is not one of this key's");
  assert.equal(metricAttributes({ channel_kind: "total" }).channel_kind, "other");
  assert.equal(metricAttributes({ outcome: "delivered" }).outcome, "other", "`delivered` is a reminder kind, not a first-visible outcome");
  assert.equal(metricAttributes({ kind: "final_post" }).kind, "other");
  assert.deepEqual(metricAttributes({ phase: undefined }), {}, "an absent attribute stays absent");
});

test("the reminder reason is one of July's, and a reason a caller of cancel chose is `other`", () => {
  for (const reason of METRIC_REMINDER_REASONS) assert.equal(metricAttributes({ kind: "stop", reason }).reason, reason, reason);
  for (const reason of ["custom_cancel_reason", "TLSSN-123", "user said stop please", "", "x".repeat(60), 42, true, { a: 1 }]) {
    assert.equal(metricAttributes({ kind: "stop", reason: reason as never }).reason, "other", JSON.stringify(reason));
  }
  assert.equal(metricAttributes({ kind: "stop", reason: "agentsdk_kv_key_invalid" }).reason, "other", "a reminder metric carries no ops reason code");
});

test("the factory's own reason codes are kept when they are code-shaped, and anything else is `other`", () => {
  for (const reason of ["agentsdk_kv_key_invalid", "http_503", "none", "timeout"]) {
    assert.equal(metricAttributes({ slug: "factory-desk", site: "claim", reason }).reason, reason, reason);
  }
  for (const reason of ["connection reset by 10.0.0.1: token=abc", "", "x".repeat(80), "ghp_" + "a1".repeat(20), 503, { a: 1 }, true]) {
    assert.equal(metricAttributes({ slug: "factory-desk", site: "claim", reason: reason as never }).reason, "other", JSON.stringify(reason));
  }
  assert.equal(metricAttributes({ slug: "factory-desk", site: "claim", reason: "U012ABCDEF3" }).reason, "U012ABCDEF3", "codeLike bounds cardinality only");
  assert.deepEqual(metricAttributes({ slug: "factory-desk", site: "claim", reason: "http_503" }), { slug: "factory-desk", site: "claim", reason: "http_503" });
  assert.deepEqual(metricAttributes({ slug: "factory-desk", site: "none", reason: "none" }), { slug: "factory-desk", site: "none", reason: "none" }, "bind baseline labels stay as set");
});

test("a reminder purpose the factory does not use is `other`", () => {
  assert.equal(metricAttributes({ purpose: "check_TLSSN-123_status" }).purpose, "other");
  assert.equal(metricAttributes({ purpose: "follow_up" }).purpose, "follow_up");
  for (const purpose of ["hop_watch", "implement_pr", "implement_launch", "merge_conflict_watch"]) assert.ok(METRIC_REMINDER_PURPOSES.has(purpose));
});

test("agent_sdk.hosted_execution.duration_ms keeps its five phases apart, and July's session labels still do not make series", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  const histogram = provider.getMeter("agent_sdk").createHistogram("agent_sdk.hosted_execution.duration_ms", { unit: "ms" });
  const phases = ["to_first_visible", "first_visible_to_completion", "durability_drain", "post_drain", "total"];
  for (let session = 0; session < 50; session++) {
    for (const [index, phase] of phases.entries()) {
      histogram.record(100 * (index + 1), { channel_kind: "slack", outcome: "final_post", delivery_surface: "slack", phase, "cursor.conversation.id": `ses_${session}`, "agent_sdk.session_id": `ses_${session}` });
    }
  }
  await provider.forceFlush();
  const found = points({ metrics: exporter.getMetrics(), name: "agent_sdk.hosted_execution.duration_ms" });
  assert.equal(found.length, 5, "one series per phase, however many sessions");
  assert.deepEqual(found.map((point) => point.attributes.phase).sort(), [...phases].sort());
  for (const point of found) {
    assert.equal(point.attributes.channel_kind, "slack");
    assert.equal(point.attributes.outcome, "final_post");
    assert.equal(point.attributes.delivery_surface, "slack");
    assert.equal(Object.keys(point.attributes).length, 4);
    assert.equal((point.value as { count: number }).count, 50);
  }
  const totals = found.map((point) => [point.attributes.phase, (point.value as { sum: number }).sum]);
  assert.deepEqual(Object.fromEntries(totals), { to_first_visible: 5_000, first_visible_to_completion: 10_000, durability_drain: 15_000, post_drain: 20_000, total: 25_000 });
  await provider.shutdown();
});

test("the reminder fire outcome keeps kind, reason, and a bounded purpose", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  const counter = provider.getMeter("agent_sdk").createCounter("agent_sdk.reminder.fire_outcome");
  counter.add(1, { kind: "delivered", reason: "run_delivered", purpose: "hop_watch" });
  counter.add(1, { kind: "stop", reason: "session_gone", purpose: "follow_up" });
  counter.add(1, { kind: "stop", reason: "session_gone", purpose: "a model-chosen purpose" });
  counter.add(1, { kind: "stop", reason: "session_gone", purpose: "another model-chosen purpose" });
  counter.add(1, { kind: "stop", reason: "a caller's own disarm reason", purpose: "follow_up" });
  counter.add(1, { kind: "stop", reason: "another disarm reason", purpose: "follow_up" });
  await provider.forceFlush();
  const found = points({ metrics: exporter.getMetrics(), name: "agent_sdk.reminder.fire_outcome" });
  const byKey = Object.fromEntries(found.map((point) => [`${point.attributes.kind}/${point.attributes.reason}/${point.attributes.purpose}`, point.value]));
  assert.deepEqual(byKey, { "delivered/run_delivered/hop_watch": 1, "stop/session_gone/follow_up": 1, "stop/session_gone/other": 2, "stop/other/follow_up": 2 });
  await provider.shutdown();
});

test("the factory's kv failure counter keeps its reason code apart from the reminder metric's", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  const counter = provider.getMeter("agent_sdk").createCounter("apj_factory.kv.failure");
  counter.add(1, { slug: "factory-desk", site: "claim", reason: "agentsdk_kv_key_invalid" });
  counter.add(1, { slug: "factory-desk", site: "claim", reason: "http_503" });
  counter.add(1, { slug: "factory-desk", site: "claim", reason: "http_503" });
  await provider.forceFlush();
  const found = points({ metrics: exporter.getMetrics(), name: "apj_factory.kv.failure" });
  assert.deepEqual(Object.fromEntries(found.map((point) => [point.attributes.reason, point.value])), { agentsdk_kv_key_invalid: 1, http_503: 2 });
  await provider.shutdown();
});

test("a metric still has at most METRIC_CARDINALITY_LIMIT series, whatever the value of a free-form key", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  const counter = provider.getMeter("agent_sdk").createCounter("agent_sdk.tool.retry");
  for (let i = 0; i < METRIC_CARDINALITY_LIMIT + 300; i++) counter.add(1, { "cursor.tool.name": `tool_${i}`, outcome: `outcome_${i}` } satisfies Attributes);
  await provider.forceFlush();
  const found = points({ metrics: exporter.getMetrics(), name: "agent_sdk.tool.retry" });
  assert.ok(found.length <= METRIC_CARDINALITY_LIMIT, `${found.length} series`);
  assert.ok(found.length >= METRIC_CARDINALITY_LIMIT - 1, "the limit, not far below it");
  const total = found.reduce((sum, point) => sum + (point.value as number), 0);
  assert.equal(total, METRIC_CARDINALITY_LIMIT + 300, "overflow is counted in an overflow series, not lost");
  await provider.shutdown();
});

test("a value outside the allowlists adds no series: a thousand made-up phases, kinds, outcomes, and reasons are one", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  const counter = provider.getMeter("agent_sdk").createCounter("agent_sdk.hosted_execution.visible_reply");
  for (let i = 0; i < 1_000; i++) {
    counter.add(1, { channel_kind: `kind_${i}`, outcome: `outcome_${i}`, phase: `phase_${i}`, delivery_surface: `surface_${i}`, kind: `k_${i}`, reason: `reason_${i}` } satisfies Attributes);
  }
  await provider.forceFlush();
  const found = points({ metrics: exporter.getMetrics(), name: "agent_sdk.hosted_execution.visible_reply" });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.value, 1_000);
  assert.equal(found[0]?.attributes.phase, "other");
  await provider.shutdown();
});

// factory-otel-rebase.ts rebases sums and explicit-bucket histograms only.
// This pins the assumption it rests on: nothing the factory exports is an
// exponential histogram. The View sets no aggregation, the SDK's default for a
// histogram is explicit buckets, and no source here or in July's code names
// an exponential aggregation. If one does, rebase it (count, sum, zeroCount,
// bucket counts, scale and offset) before relaxing this test.
const EXPONENTIAL_AGGREGATION = /\b(?:ExponentialHistogram\w*|\w*EXPONENTIAL_HISTOGRAM|AggregationType\.EXPONENTIAL\w*|exponentialHistogram\w*|base2Exponential\w*)\b/;

test("the exponential-histogram tripwire matches the SDK's identifiers and nothing in prose", () => {
  for (const identifier of ["new ExponentialHistogramAggregation()", "DataPointType.EXPONENTIAL_HISTOGRAM", "AggregationType.EXPONENTIAL_HISTOGRAM", "{ type: AggregationType.EXPONENTIAL_HISTOGRAM }", "exponentialHistogram: true"]) {
    assert.match(identifier, EXPONENTIAL_AGGREGATION, identifier);
  }
  for (const prose of ["backoff grows exponentially", "an exponential backoff of 2 s", "Exponential histograms are not rebased"]) {
    assert.doesNotMatch(prose, EXPONENTIAL_AGGREGATION, prose);
  }
});

test("no exported metric is an exponential histogram", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  const meter = provider.getMeter("agent_sdk");
  meter.createHistogram("plain").record(3);
  meter.createHistogram("advised", { advice: { explicitBucketBoundaries: [1, 10] } }).record(3);
  meter.createCounter("counted").add(1);
  await provider.forceFlush();
  const kinds = new Set(exporter.getMetrics().flatMap((batch) => batch.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.dataPointType))));
  assert.deepEqual([...kinds].sort(), [DataPointType.HISTOGRAM, DataPointType.SUM].sort());
  await provider.shutdown();

  const hosts = ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"];
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const roots: string[] = [];
  for (const host of hosts) {
    assert.ok(existsSync(join(repo, host, "agent")), `${host}/agent exists`);
    roots.push(join(repo, host, "agent"));
    if (existsSync(join(repo, host, "node_modules/@cursor/july/dist"))) roots.push(join(repo, host, "node_modules/@cursor/july/dist"));
  }
  assert.ok(roots.length >= hosts.length + 1, "July's dist is installed");
  const hits: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "docs" && entry.name !== "node_modules") scan(path);
      } else if (/\.(js|mjs|cjs|ts)$/.test(entry.name) && !path.endsWith(".test.ts") && EXPONENTIAL_AGGREGATION.test(readFileSync(path, "utf8"))) {
        hits.push(path);
      }
    }
  };
  for (const root of roots) scan(root);
  assert.deepEqual(hits, [], "a source names an exponential histogram aggregation; rebase it in factory-otel-rebase.ts");
});

// ---- console bridge: Node process warnings ----

type BridgedRecord = { severityNumber: number; severityText: string; body: string; attributes: Record<string, unknown> };

/**
 * Runs `scenario` in a child Node process with the real console bridge over a
 * capturing logger, and returns what the bridge exported next to what Node
 * and the console wrote to stderr. A child, because the bridge patches the
 * global console and Node's warning handler for the life of the process.
 * `before` is user code that runs ahead of `bridgeConsole`, as a module that
 * registers a listener early would.
 */
function bridgedRun(input: { scenario: string; before?: string; nodeArgs?: string[]; bridge?: boolean }): { records: BridgedRecord[]; probes: unknown[]; stderr: string } {
  const code = `
    import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
    import { bridgeConsole } from "./agent/lib/factory-otel-signals.ts";
    const captured = [];
    const probes = [];
    ${input.before ?? ""}
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({
        export: (records, done) => {
          for (const r of records) captured.push({ severityNumber: r.severityNumber, severityText: r.severityText, body: r.body, attributes: { ...r.attributes } });
          done({ code: 0 });
        },
        shutdown: async () => undefined,
      })],
    });
    ${input.bridge === false ? "" : 'bridgeConsole(provider.getLogger("t"));'}
    ${input.scenario}
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.stdout.write("\\n@@" + JSON.stringify(captured) + "\\n##" + JSON.stringify(probes));
  `;
  const run = spawnSync(process.execPath, [...(input.nodeArgs ?? []), "--import", "tsx", "--input-type=module", "-e", code], {
    cwd: HOST_DIR,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", OTEL_EXPORTER_OTLP_HEADERS: HEADER },
  });
  assert.equal(run.status, 0, run.stderr);
  const tail = run.stdout.slice(run.stdout.lastIndexOf("\n@@") + 3);
  const [recordsJson, probesJson] = tail.split("\n##");
  return { records: JSON.parse(recordsJson!) as BridgedRecord[], probes: JSON.parse(probesJson!) as unknown[], stderr: run.stderr };
}

const SQLITE_WARNING = "SQLite is an experimental feature and might change at any time";
const WARN = 13;
const ERROR = 17;

test("console bridge: an ExperimentalWarning is one WARN record (13, WARN) whose body is exactly what Node printed, and no ERROR record", { timeout: 60_000 }, () => {
  const { records, stderr } = bridgedRun({ scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");` });
  assert.equal(records.length, 1, "one record, not one at WARN and another at ERROR");
  const [record] = records;
  assert.equal(record!.severityNumber, WARN);
  assert.equal(record!.severityText, "WARN");
  assert.match(record!.body, /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time/);
  assert.equal(record!.body, stderr.replace(/\n$/, ""), "the body is the text Node wrote to stderr, byte for byte");
  assert.deepEqual(record!.attributes, {}, "no attribute is derived from the warning");
});

test("console bridge: ordinary console lines keep their level, an error line that looks like a warning included", { timeout: 60_000 }, () => {
  const lookalike = `(node:1) ExperimentalWarning: ${SQLITE_WARNING}`;
  const { records } = bridgedRun({
    scenario: `
      console.error("plain failure");
      console.error("[factory-desk] hop-watch failed:", new Error("boom"));
      console.error(${JSON.stringify(lookalike)});
      console.warn("careful");
      console.info("fyi");
      console.log("hello");
      console.debug("detail");
    `,
  });
  assert.deepEqual(
    records.map((r) => [r.severityNumber, r.severityText]),
    [[ERROR, "ERROR"], [ERROR, "ERROR"], [ERROR, "ERROR"], [WARN, "WARN"], [9, "INFO"], [9, "INFO"], [5, "DEBUG"]]
  );
  assert.equal(records[2]!.body, lookalike, "text alone does not make a console.error a warning");
});

test("console bridge: a console.error right after a warning is an error again, and each warning is its own record", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    scenario: `
      process.emitWarning("first", "ExperimentalWarning");
      await new Promise((resolve) => setImmediate(resolve));
      console.error("after the warning");
      process.emitWarning("second", { type: "DeprecationWarning", code: "DEP_TEST", detail: "some detail" });
      await new Promise((resolve) => setImmediate(resolve));
      console.error("after the second");
    `,
  });
  assert.deepEqual(
    records.map((r) => r.severityNumber),
    [WARN, ERROR, WARN, ERROR]
  );
  assert.match(records[0]!.body, /ExperimentalWarning: first/);
  assert.equal(records[1]!.body, "after the warning");
  assert.match(records[2]!.body, /^\(node:\d+\) \[DEP_TEST\] DeprecationWarning: second\nsome detail/, "the code and detail Node printed are in the body");
  assert.equal(records[3]!.body, "after the second");
});

test("console bridge: nothing is deduplicated beyond Node: the same warning emitted twice is two WARN records", { timeout: 60_000 }, () => {
  const { records, stderr } = bridgedRun({
    scenario: `
      process.emitWarning("again", "CustomWarning");
      await new Promise((resolve) => setImmediate(resolve));
      process.emitWarning("again", "CustomWarning");
    `,
  });
  assert.deepEqual(
    records.map((r) => r.severityNumber),
    [WARN, WARN]
  );
  assert.equal(stderr.split("CustomWarning: again").length - 1, 2, "Node printed it twice, so there are two records");
});

test("console bridge: a warning listener's own console.error is an error, only Node's print is a warning", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    scenario: `
      process.on("warning", (warning) => console.error("listener saw " + warning.name));
      process.emitWarning("seen", "CustomWarning");
    `,
  });
  assert.deepEqual(
    records.map((r) => [r.severityNumber, r.body.startsWith("(node:") ? "node" : r.body]),
    [[WARN, "node"], [ERROR, "listener saw CustomWarning"]]
  );
});

test("console bridge: a warning Node does not print is not exported, and does not relabel a later console.error, even one in Node's own shape", { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-redirect-"));
  try {
    for (const nodeArgs of [["--disable-warning=ExperimentalWarning"], ["--no-warnings"], [`--redirect-warnings=${join(dir, "warnings.log")}`]]) {
      const { records, stderr } = bridgedRun({
        nodeArgs,
        scenario: `
          process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");
          await new Promise((resolve) => setImmediate(resolve));
          console.error("(" + process.release.name + ":" + process.pid + ") ExperimentalWarning: " + ${JSON.stringify(SQLITE_WARNING)});
        `,
      });
      assert.deepEqual(
        records.map((r) => r.severityNumber),
        [ERROR],
        nodeArgs.join(" ")
      );
      assert.equal(stderr.split("ExperimentalWarning").length - 1, 1, `${nodeArgs.join(" ")}: only the console.error line was written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("console bridge: when --redirect-warnings cannot be opened, Node's fallback print is made inside its listener, so it is the one WARN", { timeout: 60_000 }, () => {
  const { records, stderr } = bridgedRun({
    nodeArgs: [`--redirect-warnings=${join(tmpdir(), "no-such-dir-for-bridge-test", "warnings.log")}`],
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.equal(records.length, 1, "Node's fallback print is exported once, not dropped");
  assert.equal(records[0]!.severityNumber, WARN);
  assert.match(records[0]!.body, /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/);
  assert.equal(records[0]!.body, stderr.replace(/\n$/, ""));
});

test("console bridge: when a --redirect-warnings write fails later, Node's fallback print comes after the window and is exported as ERROR, not dropped", { timeout: 60_000, skip: !existsSync("/dev/full") }, () => {
  const { records, stderr } = bridgedRun({
    nodeArgs: ["--redirect-warnings=/dev/full"],
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.equal(records.length, 1, "Node's fallback print is exported once, not dropped");
  assert.equal(records[0]!.severityNumber, ERROR);
  assert.match(records[0]!.body, /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/);
  assert.equal(records[0]!.body, stderr.replace(/\n$/, ""));
});

test("console bridge: a listener registered before the bridge that logs a string, or String(warning), is an error, under default flags and --no-warnings", { timeout: 60_000 }, () => {
  const before = `
    process.on("warning", (warning) => {
      console.error("my handler: " + String(warning));
      console.error(String(warning));
      console.error("an arbitrary line");
    });
  `;
  const scenario = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const summary = (records: BridgedRecord[]) => records.map((r) => [r.severityNumber, r.body.startsWith("(node:") ? "node" : r.body]);
  const listenerLines = [
    [ERROR, `my handler: ExperimentalWarning: ${SQLITE_WARNING}`],
    [ERROR, `ExperimentalWarning: ${SQLITE_WARNING}`],
    [ERROR, "an arbitrary line"],
  ];

  const printed = bridgedRun({ before, scenario });
  assert.deepEqual(summary(printed.records), [[WARN, "node"], ...listenerLines], "default flags: only Node's own print is WARN");

  const silent = bridgedRun({ before, scenario, nodeArgs: ["--no-warnings"] });
  assert.deepEqual(summary(silent.records), listenerLines, "--no-warnings: Node prints nothing, so nothing is WARN");
});

test("console bridge: the limit: a listener registered before the bridge that writes Node's exact shape through console.error takes the WARN only when Node prints nothing; under default flags Node's print matches first and the listener's line is ERROR", { timeout: 60_000 }, () => {
  const before = `
    process.on("warning", (warning) => {
      const line = "(" + process.release.name + ":" + process.pid + ") " + String(warning);
      console.log(line);
      console.error(line);
      console.warn(line);
    });
  `;
  const scenario = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const printed = bridgedRun({ before, scenario });
  assert.deepEqual(
    printed.records.map((r) => r.severityNumber),
    [WARN, 9, ERROR, WARN],
    "Node prints: its print takes the WARN and closes the window before the listener runs"
  );
  const silent = bridgedRun({ before, scenario, nodeArgs: ["--no-warnings"] });
  assert.deepEqual(
    silent.records.map((r) => r.severityNumber),
    [9, WARN, WARN],
    "Node prints nothing: nothing closes the window before the listener, so its console.error takes the WARN"
  );
});

test("console bridge: a warning whose toString throws on its first call crashes Node's own listener exactly as without the bridge: nothing is printed and nothing is exported", { timeout: 60_000 }, () => {
  const before = `process.on("uncaughtException", (e) => probes.push(e.message));`;
  const scenario = `
    const warning = new Error("odd");
    warning.name = "CustomWarning";
    let calls = 0;
    warning.toString = () => {
      if (calls++ === 0) throw new Error("toString failed");
      return "CustomWarning: odd";
    };
    process.emitWarning(warning);
  `;
  for (const bridge of [false, true]) {
    const { records, probes, stderr } = bridgedRun({ before, scenario, bridge });
    assert.deepEqual(probes, ["toString failed"], `bridge ${bridge}: the first toString call is Node's, and its throw reaches the handler`);
    assert.equal(stderr, "", `bridge ${bridge}: nothing printed`);
    assert.deepEqual(records, [], `bridge ${bridge}: nothing exported, no WARN`);
  }
});

test("console bridge: the bridge never runs the warning's own code: a counting toString, or a name or message getter, prints what Node prints without the bridge, and stays ERROR", { timeout: 120_000 }, () => {
  const cases: Record<string, string> = {
    "counting toString": `warning.toString = () => "CustomWarning: odd " + n++;`,
    "name getter": `Object.defineProperty(warning, "name", { get: () => "CustomWarning " + n++ });`,
    "message getter": `Object.defineProperty(warning, "message", { get: () => "odd " + n++ });`,
  };
  const normalize = (text: string) => text.replace(/\(node:\d+\)/g, "(node:N)");
  for (const [name, setup] of Object.entries(cases)) {
    const scenario = `
      let n = 0;
      const warning = new Error("odd");
      warning.name = "CustomWarning";
      ${setup}
      process.emitWarning(warning);
    `;
    const plain = bridgedRun({ scenario, bridge: false });
    const bridged = bridgedRun({ scenario });
    if (name === "counting toString") assert.match(plain.stderr, /CustomWarning: odd 0\n/, "Node's own first call sees the count at 0");
    assert.equal(normalize(bridged.stderr), normalize(plain.stderr), `${name}: same text with and without the bridge`);
    assert.deepEqual(bridged.records.map((r) => r.severityNumber), [ERROR], name);
    assert.equal(bridged.records[0]!.body, bridged.stderr.replace(/\n$/, ""), name);
  }
});

test("console bridge: a listener ahead of Node's that changes name or message leaves Node's print ERROR (the text is read once), and a later on-listener's original-shape line then takes the WARN", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    before: `
      process.prependListener("warning", (warning) => { warning.name = "ChangedWarning"; });
      process.on("warning", () => console.error("(" + process.release.name + ":" + process.pid + ") ExperimentalWarning: ${SQLITE_WARNING}"));
    `,
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.deepEqual(
    records.map((r) => [r.severityText, r.body.replace(/^\(node:\d+\) /, "").split(":")[0]]),
    [["ERROR", "ChangedWarning"], ["WARN", "ExperimentalWarning"]]
  );
});

test("console bridge: matcher: inside the window and ahead of Node's print, console.log and console.info keep their level, a console.error with an extra argument or other text stays ERROR, and Node's print is the WARN", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    before: `
      process.prependListener("warning", (warning) => {
        const line = "(" + process.release.name + ":" + process.pid + ") " + String(warning);
        console.log(line);
        console.info(line);
        console.error(line, "extra");
        console.error("(" + process.release.name + ":" + process.pid + ") something else");
      });
    `,
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.deepEqual(
    records.map((r) => r.severityNumber),
    [9, 9, ERROR, ERROR, WARN],
    "console.log and console.info keep their level; a Node-shaped console.error with a second argument, or with other text, is an error; Node's own print is the WARN"
  );
});

test("console bridge: every warning listener runs inside the window, so a Node-shaped console.error takes the WARN only while no line in the dispatch has matched yet", { timeout: 120_000 }, () => {
  const line = `const L = () => "(" + process.release.name + ":" + process.pid + ") ExperimentalWarning: ${SQLITE_WARNING}";`;
  const emit = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const positions: Record<string, { before: string; scenario: string }> = {
    "prepended before the bridge": { before: `${line} process.prependListener("warning", () => console.error(L()));`, scenario: emit },
    "on before the bridge": { before: `${line} process.on("warning", () => console.error(L()));`, scenario: emit },
    "prepended after the bridge": { before: line, scenario: `process.prependListener("warning", () => console.error(L())); ${emit}` },
    "on after the bridge": { before: line, scenario: `process.on("warning", () => console.error(L())); ${emit}` },
  };
  const seen = (records: BridgedRecord[]) => records.map((r) => `${r.body.includes("\n(Use ") ? "node" : "listener"} ${r.severityText}`);
  const expected: Record<string, { printed: string[]; silent: string[] }> = {
    "prepended before the bridge": { printed: ["listener WARN", "node ERROR"], silent: ["listener WARN"] },
    "on before the bridge": { printed: ["node WARN", "listener ERROR"], silent: ["listener WARN"] },
    "prepended after the bridge": { printed: ["listener WARN", "node ERROR"], silent: ["listener WARN"] },
    "on after the bridge": { printed: ["node WARN", "listener ERROR"], silent: ["listener WARN"] },
  };
  for (const [name, { before, scenario }] of Object.entries(positions)) {
    assert.deepEqual(seen(bridgedRun({ before, scenario }).records), expected[name]!.printed, `${name}, default flags`);
    assert.deepEqual(seen(bridgedRun({ before, scenario, nodeArgs: ["--no-warnings"] }).records), expected[name]!.silent, `${name}, --no-warnings`);
  }
});

test("console bridge: --trace-warnings and --trace-deprecation print warning.stack: a stack header equal to toString() is still the WARN, a header that differs stays ERROR", { timeout: 60_000 }, () => {
  const traced = bridgedRun({
    nodeArgs: ["--trace-warnings"],
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.deepEqual(traced.records.map((r) => r.severityNumber), [WARN]);
  assert.match(traced.records[0]!.body, /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n {4}at /, "the stack, not toString(), is what Node printed");

  const deprecation = bridgedRun({
    nodeArgs: ["--trace-deprecation"],
    scenario: `process.emitWarning("old api", "DeprecationWarning", "DEP_TEST");`,
  });
  assert.deepEqual(deprecation.records.map((r) => r.severityNumber), [WARN]);
  assert.match(deprecation.records[0]!.body, /^\(node:\d+\) \[DEP_TEST\] DeprecationWarning: old api\n {4}at /);

  // V8 formats the stack header when .stack is first read, so a header differs
  // from toString() only if something read it before name or message changed, or
  // if toString is custom.
  const differing: Record<string, { code: string; header: RegExp }> = {
    "name changed after .stack was read": { code: `void warning.stack; warning.name = "CustomWarning";`, header: /^\(node:\d+\) Error: odd\n {4}at / },
    "message changed after .stack was read": { code: `void warning.stack; warning.message = "changed";`, header: /^\(node:\d+\) Error: odd\n {4}at / },
    "custom toString": { code: `warning.toString = () => "Custom: not the stack header";`, header: /^\(node:\d+\) Error: odd\n {4}at / },
  };
  for (const [name, { code, header }] of Object.entries(differing)) {
    const differs = bridgedRun({
      nodeArgs: ["--trace-warnings"],
      scenario: `
        const warning = new Error("odd");
        ${code}
        process.emitWarning(warning);
      `,
    });
    assert.deepEqual(differs.records.map((r) => r.severityNumber), [ERROR], name);
    assert.match(differs.records[0]!.body, header, `${name}: Node printed the stack, whose header toString() no longer matches`);
  }

  const mutatedBeforeRead = bridgedRun({
    nodeArgs: ["--trace-warnings"],
    scenario: `
      const warning = new Error("odd");
      warning.name = "CustomWarning";
      process.emitWarning(warning);
    `,
  });
  assert.deepEqual(mutatedBeforeRead.records.map((r) => r.severityNumber), [WARN], "a name set before .stack is first read is in the header");

  const untraced = bridgedRun({
    scenario: `
      const warning = new Error("odd");
      warning.name = "CustomWarning";
      process.emitWarning(warning);
    `,
  });
  assert.deepEqual(untraced.records.map((r) => r.severityNumber), [WARN], "without a trace flag Node prints toString(), so the same warning is the WARN");
});

test("console bridge: a toString() that returns a non-string stays ERROR, and Node's print is still exported", { timeout: 60_000 }, () => {
  const { records, stderr } = bridgedRun({
    scenario: `
      const warning = new Error("odd");
      warning.name = "CustomWarning";
      warning.toString = () => 42;
      process.emitWarning(warning);
    `,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.severityNumber, ERROR);
  assert.match(records[0]!.body, /^\(node:\d+\) 42/);
  assert.equal(records[0]!.body, stderr.replace(/\n$/, ""));
});

test("console bridge: when Node's print did not match (--trace-warnings and a name changed after .stack was read), the window stays open, so an on-before-the-bridge listener's Node-shaped console.error takes the WARN", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    nodeArgs: ["--trace-warnings"],
    before: `
      process.on("warning", (warning) => {
        console.error("(" + process.release.name + ":" + process.pid + ") " + Error.prototype.toString.call(warning));
      });
    `,
    scenario: `
      const warning = new Error("odd");
      warning.stack;
      warning.name = "CustomWarning";
      process.emitWarning(warning);
    `,
  });
  assert.deepEqual(
    records.map((r) => [r.severityText, r.body.split("\n")[0]!.replace(/\(node:\d+\)/, "(node:N)")]),
    [["ERROR", "(node:N) Error: odd"], ["WARN", "(node:N) CustomWarning: odd"]],
    "Node's unmatched stack print is ERROR; the window is still open for the later listener"
  );
});

test("console bridge: the window is exactly the synchronous dispatch: after a listener throws, an uncaughtException handler, an already-queued nextTick, a microtask queued by an earlier listener, and a later timer all stay ERROR", { timeout: 60_000 }, () => {
  const nodeShaped = `"(" + process.release.name + ":" + process.pid + ") ExperimentalWarning: " + ${JSON.stringify(SQLITE_WARNING)}`;
  const emit = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const cases: Record<string, { before: string; scenario: string }> = {
    "20 ms later": {
      before: `process.on("uncaughtException", () => {}); process.prependListener("warning", () => { throw new Error("listener failed"); });`,
      scenario: `${emit} await new Promise((resolve) => setTimeout(resolve, 20)); console.error(${nodeShaped});`,
    },
    "the uncaughtException handler": {
      before: `process.on("uncaughtException", () => console.error(${nodeShaped})); process.prependListener("warning", () => { throw new Error("listener failed"); });`,
      scenario: emit,
    },
    "a nextTick queued after emitWarning": {
      before: `process.on("uncaughtException", () => {}); process.prependListener("warning", () => { throw new Error("listener failed"); });`,
      scenario: `${emit} process.nextTick(() => console.error(${nodeShaped}));`,
    },
    "a nextTick queued by the throwing listener": {
      before: `process.on("uncaughtException", () => {}); process.prependListener("warning", () => { process.nextTick(() => console.error(${nodeShaped})); throw new Error("listener failed"); });`,
      scenario: emit,
    },
    "a microtask queued by a listener prepended after the bridge": {
      before: `process.on("uncaughtException", () => {}); process.prependListener("warning", () => { throw new Error("listener failed"); });`,
      scenario: `process.prependListener("warning", () => queueMicrotask(() => console.error(${nodeShaped}))); ${emit}`,
    },
  };
  for (const [name, { before, scenario }] of Object.entries(cases)) {
    const { records, stderr } = bridgedRun({ before, scenario });
    assert.deepEqual(
      records.map((r) => r.severityNumber),
      [ERROR],
      name
    );
    assert.equal(stderr.split("ExperimentalWarning").length - 1, 1, `${name}: only the scenario's own line was written; Node's print never ran`);
  }
});

test("console bridge: a listener that re-emits warning synchronously with process.emit gets its own window for the inner warning, and Node's outer print stays the WARN", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    before: `
      let inner = false;
      process.prependListener("warning", () => {
        if (inner) return;
        inner = true;
        const second = new Error("inner");
        second.name = "CustomWarning";
        process.emit("warning", second);
      });
    `,
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.deepEqual(
    records.map((r) => [r.severityText, r.body.split("\n")[0]!.replace(/\(node:\d+\)/, "(node:N)")]),
    [["WARN", "(node:N) CustomWarning: inner"], ["WARN", `(node:N) ExperimentalWarning: ${SQLITE_WARNING}`]],
    "each warning's own print is the WARN; the inner re-emit does not take the outer one"
  );
});

test("console bridge: the process.emit wrapper passes every event through: arguments, this, return value and throws are emit's own", { timeout: 60_000 }, () => {
  const { records, probes } = bridgedRun({
    scenario: `
      const boom = new Error("boom");
      let seen;
      process.on("custom", function (a, b) { seen = [this === process, a, b]; });
      probes.push(["custom returns", process.emit("custom", 1, "two")]);
      probes.push(["custom seen", seen]);
      probes.push(["nobody returns", process.emit("nobody")]);
      let thrown;
      const thrower = () => { throw boom; };
      process.on("custom2", thrower);
      try { process.emit("custom2"); } catch (e) { thrown = e; }
      probes.push(["custom throw propagates", thrown === boom]);
      let warningThis;
      process.on("warning", function () { warningThis = this === process; });
      const w = new Error("w");
      w.name = "CustomWarning";
      probes.push(["warning returns", process.emit("warning", w)]);
      probes.push(["warning this", warningThis]);
      probes.push(["non-error warning returns", typeof process.emit("warning", "not an error")]);
      process.removeAllListeners("warning");
      process.on("warning", thrower);
      thrown = undefined;
      try { process.emit("warning", w); } catch (e) { thrown = e; }
      probes.push(["warning throw propagates", thrown === boom]);
    `,
  });
  assert.deepEqual(probes, [
    ["custom returns", true],
    ["custom seen", [true, 1, "two"]],
    ["nobody returns", false],
    ["custom throw propagates", true],
    ["warning returns", true],
    ["warning this", true],
    ["non-error warning returns", "boolean"],
    ["warning throw propagates", true],
  ]);
  assert.deepEqual(records.map((r) => r.severityNumber), [WARN], "the one real warning dispatch printed once, as the WARN");
});

test("console bridge: July's proper-lockfile (signal-exit@3 wraps process.emit at load) chains with the bridge in either load order: Node's print is one WARN", { timeout: 120_000 }, () => {
  const emit = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const load = `await import("proper-lockfile");`;
  for (const [order, input] of [
    ["before the bridge", { before: load, scenario: emit }],
    ["after the bridge", { scenario: `${load} ${emit}` }],
  ] as const) {
    const { records } = bridgedRun(input);
    assert.deepEqual(records.map((r) => r.severityNumber), [WARN], `proper-lockfile loaded ${order}`);
  }
});

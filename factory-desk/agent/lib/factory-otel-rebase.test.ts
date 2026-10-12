import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { context, trace, TraceFlags, type HrTime } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { AggregationTemporality, DataPointType, MeterProvider as SdkMeterProvider, PeriodicExportingMetricReader, type HistogramMetricData, type MeterProvider, type PushMetricExporter, type ResourceMetrics, type SumMetricData } from "@opentelemetry/sdk-metrics";
import { createLifeRebaser, type LifeRebaser } from "./factory-otel-rebase.js";
import { RESTORE_SKEW_MS, wakeInstanceId } from "./factory-otel.js";
import { factoryMeterProvider, factoryMetricExporter } from "./factory-otel-signals.js";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// A real MeterProvider with the factory's View and a cumulative reader, so the
// batches are the SDK's own. `export(life)` is one export tick: it collects
// and hands the batch to the rebaser as factoryMetricExporter does, with the
// life (service.instance.id) the test says is current.

type Rig = {
  provider: MeterProvider;
  export(life: string | undefined, options?: { fail?: boolean }): Promise<ResourceMetrics>;
  raw(): ResourceMetrics;
};

/** One export tick that succeeded, as factoryMetricExporter reports it. */
function deliver(rebaser: LifeRebaser, input: { batch: ResourceMetrics; life: string | undefined }): ResourceMetrics {
  const out = rebaser.rebase(input);
  rebaser.delivered(out);
  return out;
}

function rig(): Rig {
  const rebaser = createLifeRebaser();
  let life: string | undefined;
  let out: ResourceMetrics | undefined;
  let failing = false;
  let raw: ResourceMetrics | undefined;
  const exporter: PushMetricExporter = {
    export(batch: ResourceMetrics, done: (result: ExportResult) => void) {
      raw = batch;
      out = rebaser.rebase({ batch, life });
      if (failing) {
        rebaser.failed(out);
        done({ code: ExportResultCode.FAILED });
        return;
      }
      rebaser.delivered(out);
      done({ code: ExportResultCode.SUCCESS });
    },
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };
  const provider = factoryMeterProvider(exporter);
  return {
    provider,
    raw: () => raw!,
    async export(next, options) {
      life = next;
      failing = options?.fail === true;
      await provider.forceFlush();
      assert.ok(out, "an export ran");
      return out;
    },
  };
}

type SumPoint = { attributes: Record<string, unknown>; value: number; startTime: number; start: HrTime; end: HrTime };

function sums(batch: ResourceMetrics, name: string): SumPoint[] {
  const found: SumPoint[] = [];
  for (const scope of batch.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== name || metric.dataPointType !== DataPointType.SUM) continue;
      for (const point of (metric as SumMetricData).dataPoints) found.push({ attributes: point.attributes, value: point.value, startTime: point.startTime[0] * 1000 + point.startTime[1] / 1e6, start: point.startTime, end: point.endTime });
    }
  }
  return found;
}

function histograms(batch: ResourceMetrics, name: string) {
  const found: { count: number; sum: number | undefined; min: number | undefined; max: number | undefined; counts: number[] }[] = [];
  for (const scope of batch.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== name || metric.dataPointType !== DataPointType.HISTOGRAM) continue;
      for (const point of (metric as HistogramMetricData).dataPoints) found.push({ count: point.value.count, sum: point.value.sum, min: point.value.min, max: point.value.max, counts: point.value.buckets.counts });
    }
  }
  return found;
}

const TURNS = "agent_sdk.turn.count";

test("a rotated instance id starts its counters at zero: an approve-only process exports 0 turns, not the 2 it carried over", async () => {
  const { provider, export: tick } = rig();
  const turns = provider.getMeter("agent_sdk").createCounter(TURNS);
  turns.add(1, { "agent_sdk.turn_status": "completed" });
  turns.add(1, { "agent_sdk.turn_status": "completed" });
  assert.equal(sums(await tick("life-a"), TURNS)[0]?.value, 2, "the first life exports its own two turns");

  // A resume with a stepped clock: wakeInstanceId draws life-b, the counter keeps 2, and the process handles only `approve KEY`.
  const rotated = sums(await tick("life-b"), TURNS);
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0]!.value, 0, "the carried-over 2 is not this life's");

  assert.equal(sums(await tick("life-b"), TURNS)[0]?.value, 0, "still 0 on the next tick of the same life");
});

test("one turn is one increment after a rotation: the new life counts only what it did", async () => {
  const { provider, export: tick } = rig();
  const turns = provider.getMeter("agent_sdk").createCounter(TURNS);
  const attrs = { "agent_sdk.turn_status": "completed" };
  turns.add(1, attrs);
  turns.add(1, attrs);
  await tick("life-a");
  turns.add(1, attrs);
  assert.equal(sums(await tick("life-b"), TURNS)[0]?.value, 1);
  turns.add(1, attrs);
  turns.add(1, attrs);
  assert.equal(sums(await tick("life-b"), TURNS)[0]?.value, 3);
  assert.equal(sums(await tick("life-a"), TURNS)[0]?.value, 0, "an id seen again is a rotation again: the baseline is the previous tick's raw total (5)");
});

test("lives sum to the process's real total: the arithmetic the dashboards do", async () => {
  const { provider, export: tick } = rig();
  const turns = provider.getMeter("agent_sdk").createCounter(TURNS);
  const attrs = { "agent_sdk.turn_status": "completed" };
  const lastValue: Record<string, number> = {};
  const record = async (life: string) => {
    lastValue[life] = sums(await tick(life), TURNS)[0]!.value;
  };
  turns.add(2, attrs);
  await record("life-a");
  await record("life-b");
  turns.add(1, attrs);
  await record("life-b");
  await record("life-c");
  turns.add(2, attrs);
  await record("life-c");
  const total = Object.values(lastValue).reduce((a, b) => a + b, 0);
  assert.deepEqual(lastValue, { "life-a": 2, "life-b": 1, "life-c": 2 });
  assert.equal(total, 5, "five turns happened, five are counted (carried over, the last values would have been 2 + 2 + 5)");
});

test("each attribute set is its own stream with its own baseline; a stream born after the rotation is untouched", async () => {
  const { provider, export: tick } = rig();
  const tools = provider.getMeter("agent_sdk").createCounter("cursor.tool.calls");
  tools.add(3, { "cursor.tool.name": "Read" });
  tools.add(1, { "cursor.tool.name": "Grep" });
  await tick("life-a");
  tools.add(2, { "cursor.tool.name": "Read" });
  tools.add(4, { "cursor.tool.name": "Edit" });
  const byTool = Object.fromEntries(sums(await tick("life-b"), "cursor.tool.calls").map((point) => [String(point.attributes["cursor.tool.name"]), point.value]));
  assert.deepEqual(byTool, { Read: 2, Grep: 0, Edit: 4 });
});

test("histograms are rebased too: count, sum, and every bucket", async () => {
  const { provider, export: tick } = rig();
  const http = provider.getMeter("agent_sdk").createHistogram("agent_sdk.http.duration", { advice: { explicitBucketBoundaries: [1, 10] } });
  http.record(0.5, { "http.response.status_code": 405 });
  http.record(5, { "http.response.status_code": 405 });
  const first = histograms(await tick("life-a"), "agent_sdk.http.duration")[0]!;
  assert.deepEqual({ count: first.count, counts: first.counts }, { count: 2, counts: [1, 1, 0] });
  assert.deepEqual({ min: first.min, max: first.max }, { min: 0.5, max: 5 }, "a life's first export keeps the SDK's min and max");

  http.record(50, { "http.response.status_code": 405 });
  const second = histograms(await tick("life-b"), "agent_sdk.http.duration")[0]!;
  assert.deepEqual({ count: second.count, sum: second.sum, counts: second.counts }, { count: 1, sum: 50, counts: [0, 0, 1] });
  assert.deepEqual({ min: second.min, max: second.max }, { min: undefined, max: undefined }, "a rebased point must not carry the process-lifetime min and max");

  const third = histograms(await tick("life-c"), "agent_sdk.http.duration")[0]!;
  assert.deepEqual({ count: third.count, sum: third.sum, counts: third.counts, min: third.min, max: third.max }, { count: 0, sum: 0, counts: [0, 0, 0], min: undefined, max: undefined }, "a life that recorded nothing exports count 0 and no min or max");
});

test("gauges and non-monotonic sums pass through unchanged", async () => {
  const { provider, export: tick } = rig();
  const meter = provider.getMeter("agent_sdk");
  const open = meter.createUpDownCounter("sessions.open");
  open.add(4);
  const gauge = meter.createGauge("queue.depth");
  gauge.record(7);
  await tick("life-a");
  const batch = await tick("life-b");
  assert.equal(sums(batch, "sessions.open")[0]?.value, 4);
  const depth = batch.scopeMetrics.flatMap((scope) => scope.metrics).find((metric) => metric.descriptor.name === "queue.depth");
  assert.equal(depth?.dataPoints[0]?.value, 7);
});

test("ticks with nothing exported (no header) still note the totals, so a restore's first export rebases against them", async () => {
  const { provider, export: tick } = rig();
  const turns = provider.getMeter("agent_sdk").createCounter(TURNS);
  turns.add(2);
  await tick(undefined);
  turns.add(1);
  assert.equal(sums(await tick("life-a"), TURNS)[0]?.value, 1, "the snapshot's 2 is not the first life's");
});

test("the first export of a process that never ticked before is exported as it is", async () => {
  const { provider, export: tick } = rig();
  provider.getMeter("agent_sdk").createCounter(TURNS).add(3);
  assert.equal(sums(await tick("life-a"), TURNS)[0]?.value, 3);
});

test("a counter that fell (reset) is exported as it is, never negative", async () => {
  const rebaser = createLifeRebaser();
  const batchOf = (value: number): ResourceMetrics =>
    ({
      resource: undefined as never,
      scopeMetrics: [
        {
          scope: { name: "s" },
          metrics: [
            {
              descriptor: { name: "c", description: "", unit: "", valueType: 1 },
              aggregationTemporality: AggregationTemporality.CUMULATIVE,
              dataPointType: DataPointType.SUM,
              isMonotonic: true,
              dataPoints: [{ startTime: [1, 0], endTime: [2, 0], attributes: {}, value }],
            },
          ],
        },
      ],
    }) as ResourceMetrics;
  deliver(rebaser, { batch: batchOf(9), life: "a" });
  const out = deliver(rebaser, { batch: batchOf(2), life: "b" });
  assert.equal(sums(out, "c")[0]?.value, 2);
});

test("factoryMetricExporter: a service.instance.id change in the resource rebases the batch it hands to the OTLP exporter", async (t) => {
  const sent: { life: unknown; value: number | undefined }[] = [];
  t.mock.method(OTLPMetricExporter.prototype, "export", (batch: ResourceMetrics, done: (result: ExportResult) => void) => {
    sent.push({ life: batch.resource.attributes["service.instance.id"], value: sums(batch, TURNS)[0]?.value });
    done({ code: ExportResultCode.SUCCESS });
  });
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic x";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1/otlp";
  const provider = factoryMeterProvider(factoryMetricExporter);
  try {
    provider.getMeter("agent_sdk").createCounter(TURNS).add(2);
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.instance.id=life-a";
    await provider.forceFlush();
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.instance.id=life-b";
    await provider.forceFlush();
    assert.deepEqual(sent, [
      { life: "life-a", value: 2 },
      { life: "life-b", value: 0 },
    ]);
  } finally {
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await provider.shutdown();
  }
});

test("a rebased point starts at the previous tick's end, stays there for the life, and a stream born after the rotation keeps the SDK's start", async () => {
  const { provider, export: tick, raw } = rig();
  const meter = provider.getMeter("agent_sdk");
  const turns = meter.createCounter(TURNS);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 3));
  turns.add(2);
  const opening = sums(await tick("life-a"), TURNS)[0]!;
  await pause();
  turns.add(1);
  const first = sums(await tick("life-a"), TURNS)[0]!;
  assert.notDeepEqual(first.end, opening.end, "the baseline tick is later than the first one");
  await pause();
  turns.add(1);

  const second = sums(await tick("life-b"), TURNS)[0]!;
  assert.equal(second.value, 1);
  assert.deepEqual(second.start, first.end, "the rotated start is the previous tick's end");
  assert.notDeepEqual(second.start, sums(raw(), TURNS)[0]!.start, "not the process's own start");
  assert.ok(second.start[0] < second.end[0] || (second.start[0] === second.end[0] && second.start[1] <= second.end[1]), "start is not after the point's end");

  await pause();
  const born = meter.createCounter("born.after");
  born.add(1);
  const third = await tick("life-b");
  assert.deepEqual(sums(third, TURNS)[0]!.start, first.end, "constant across the life's next tick");
  assert.deepEqual(sums(third, "born.after")[0]!.start, sums(raw(), "born.after")[0]!.start, "a stream born after the rotation keeps its SDK start time");
  assert.notDeepEqual(sums(third, "born.after")[0]!.start, first.end);
});

test("scopes that differ only in version or schema URL are different streams", async () => {
  const { provider, export: tick } = rig();
  const v1 = provider.getMeter("s", "1").createCounter("c");
  const v2 = provider.getMeter("s", "2").createCounter("c");
  const schema = provider.getMeter("s", "2", { schemaUrl: "https://example.test/schema" }).createCounter("c");
  v1.add(2);
  v2.add(5);
  schema.add(7);
  await tick("life-a");
  v1.add(1);
  v2.add(1);
  schema.add(1);
  const batch = await tick("life-b");
  const byScope = Object.fromEntries(
    batch.scopeMetrics.map((scope) => [`${scope.scope.version}|${scope.scope.schemaUrl ?? ""}`, scope.metrics.flatMap((metric) => (metric.dataPoints as { value: number }[]).map((point) => point.value))]),
  );
  assert.deepEqual(byScope, { "1|": [1], "2|": [1], "2|https://example.test/schema": [1] });
});

test("a counter and a histogram of one name are different streams: both are rebased", async () => {
  const { provider, export: tick } = rig();
  const meter = provider.getMeter("s");
  const counter = meter.createCounter("same.name");
  const histogram = meter.createHistogram("same.name", { advice: { explicitBucketBoundaries: [1, 10] } });
  counter.add(4);
  histogram.record(0.5);
  histogram.record(5);
  await tick("life-a");
  counter.add(1);
  histogram.record(50);
  const batch = await tick("life-b");
  assert.equal(sums(batch, "same.name")[0]?.value, 1);
  const rebased = histograms(batch, "same.name")[0]!;
  assert.deepEqual({ count: rebased.count, counts: rebased.counts }, { count: 1, counts: [0, 0, 1] });
});

type HistogramShape = { count: number; sum?: number; min?: number; max?: number; buckets: { boundaries: number[]; counts: number[] } };

function syntheticBatch(input: { value: HistogramShape; end: HrTime }): ResourceMetrics {
  return {
    resource: undefined as never,
    scopeMetrics: [
      {
        scope: { name: "s" },
        metrics: [
          {
            descriptor: { name: "h", description: "", unit: "", valueType: 1 },
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.HISTOGRAM,
            dataPoints: [{ startTime: [1, 0], endTime: input.end, attributes: {}, value: input.value }],
          },
        ],
      },
    ],
  } as ResourceMetrics;
}

function histogramValue(batch: ResourceMetrics): HistogramShape {
  return (batch.scopeMetrics[0]!.metrics[0] as HistogramMetricData).dataPoints[0]!.value as HistogramShape;
}

test("a histogram that is not comparable with its baseline passes through unchanged, like a fallen counter", () => {
  const base: HistogramShape = { count: 4, sum: 40, min: 1, max: 20, buckets: { boundaries: [1, 10], counts: [1, 2, 1] } };
  const cases: Record<string, HistogramShape> = {
    "other boundaries": { count: 5, sum: 50, min: 1, max: 20, buckets: { boundaries: [1, 5], counts: [1, 2, 2] } },
    "other bucket count": { count: 5, sum: 50, min: 1, max: 20, buckets: { boundaries: [1, 10, 100], counts: [1, 2, 1, 1] } },
    "a bucket fell, the total rose": { count: 6, sum: 60, min: 1, max: 20, buckets: { boundaries: [1, 10], counts: [0, 2, 4] } },
    "the sum fell": { count: 5, sum: 30, min: 1, max: 20, buckets: { boundaries: [1, 10], counts: [1, 2, 2] } },
    "the count fell": { count: 3, sum: 40, min: 1, max: 20, buckets: { boundaries: [1, 10], counts: [1, 1, 1] } },
  };
  for (const [name, value] of Object.entries(cases)) {
    const rebaser = createLifeRebaser();
    deliver(rebaser, { batch: syntheticBatch({ value: base, end: [2, 0] }), life: "a" });
    const out = deliver(rebaser, { batch: syntheticBatch({ value, end: [3, 0] }), life: "b" });
    assert.deepEqual(histogramValue(out), value, name);
    assert.deepEqual((out.scopeMetrics[0]!.metrics[0] as HistogramMetricData).dataPoints[0]!.startTime, [1, 0], `${name}: the start time is the SDK's`);
  }

  const rebaser = createLifeRebaser();
  deliver(rebaser, { batch: syntheticBatch({ value: base, end: [2, 0] }), life: "a" });
  const rebased = deliver(rebaser, { batch: syntheticBatch({ value: { count: 6, sum: 70, min: 1, max: 30, buckets: { boundaries: [1, 10], counts: [1, 3, 2] } }, end: [3, 0] }), life: "b" });
  const out = histogramValue(rebased);
  const rebasedHistogramStart = (rebased.scopeMetrics[0]!.metrics[0] as HistogramMetricData).dataPoints[0]!.startTime;
  assert.deepEqual({ count: out.count, sum: out.sum, counts: out.buckets.counts, min: out.min, max: out.max }, { count: 2, sum: 30, counts: [0, 1, 1], min: undefined, max: undefined });
  assert.deepEqual(rebasedHistogramStart, [2, 0], "a rebased histogram starts at the baseline tick's end");
  assert.equal(out.buckets.counts.reduce((a, b) => a + b, 0), out.count, "the buckets add up to the count");
});

function sumBatch(input: { value: number; end: HrTime; scope?: string }): ResourceMetrics {
  return {
    resource: undefined as never,
    scopeMetrics: [
      {
        scope: { name: input.scope ?? "s" },
        metrics: [
          {
            descriptor: { name: "c", description: "", unit: "", valueType: 1 },
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.SUM,
            isMonotonic: true,
            dataPoints: [{ startTime: [1, 0], endTime: input.end, attributes: {}, value: input.value }],
          },
        ],
      },
    ],
  } as ResourceMetrics;
}

test("a start time after the batch's end (clock stepped back, stale previous end) is clamped to that end once, and holds for the life", () => {
  const rebaser = createLifeRebaser();
  deliver(rebaser, { batch: sumBatch({ value: 5, end: [100, 500] }), life: "a" });
  const stepped = sums(deliver(rebaser, { batch: sumBatch({ value: 7, end: [50, 0] }), life: "b" }), "c")[0]!;
  assert.equal(stepped.value, 2);
  assert.deepEqual(stepped.start, [50, 0], "clamped to the export's end");
  const later = sums(deliver(rebaser, { batch: sumBatch({ value: 8, end: [200, 0] }), life: "b" }), "c")[0]!;
  assert.deepEqual(later.start, [50, 0], "fixed for the life: not the baseline's end, which the clock has since passed");
  const next = sums(deliver(rebaser, { batch: sumBatch({ value: 9, end: [30, 0] }), life: "b" }), "c")[0]!;
  assert.deepEqual(next.start, [50, 0], "a later backward step does not move it either");
});

test("the clamp compares nanoseconds: a start 300 ns after the end is clamped, one 300 ns before it is not", () => {
  const back = createLifeRebaser();
  deliver(back, { batch: sumBatch({ value: 5, end: [100, 500] }), life: "a" });
  assert.deepEqual(sums(deliver(back, { batch: sumBatch({ value: 6, end: [100, 200] }), life: "b" }), "c")[0]!.start, [100, 200], "same second, earlier nanoseconds");

  const forward = createLifeRebaser();
  deliver(forward, { batch: sumBatch({ value: 5, end: [100, 200] }), life: "a" });
  assert.deepEqual(sums(deliver(forward, { batch: sumBatch({ value: 6, end: [100, 500] }), life: "b" }), "c")[0]!.start, [100, 200], "same second, later nanoseconds: unchanged");

  const earlierSecond = createLifeRebaser();
  deliver(earlierSecond, { batch: sumBatch({ value: 5, end: [100, 900] }), life: "a" });
  assert.deepEqual(sums(deliver(earlierSecond, { batch: sumBatch({ value: 6, end: [101, 100] }), life: "b" }), "c")[0]!.start, [100, 900], "a later second with fewer nanoseconds is still later");
});

test("scopes that differ only in name are different streams", () => {
  const rebaser = createLifeRebaser();
  const two = (a: number, b: number): ResourceMetrics => {
    const left = sumBatch({ value: a, end: [10, 0], scope: "left" });
    const right = sumBatch({ value: b, end: [10, 0], scope: "right" });
    return { ...left, scopeMetrics: [...left.scopeMetrics, ...right.scopeMetrics] };
  };
  deliver(rebaser, { batch: two(2, 5), life: "a" });
  const out = deliver(rebaser, { batch: two(3, 9), life: "b" });
  assert.deepEqual(out.scopeMetrics.map((scope) => [scope.scope.name, sums({ ...out, scopeMetrics: [scope] }, "c")[0]!.value]), [["left", 1], ["right", 4]]);
});

test("a batch with nothing to rebase is returned as the same object: a no-header tick, a first life, and the ticks of a life that never rotated", async () => {
  const rebaser = createLifeRebaser();
  const batches: ResourceMetrics[] = [];
  const exporter: PushMetricExporter = {
    export(batch, done) {
      batches.push(batch);
      done({ code: ExportResultCode.SUCCESS });
    },
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };
  const own = factoryMeterProvider(exporter);
  own.getMeter("s").createCounter("c").add(1);
  for (const life of ["life-a", "life-a", undefined, "life-a"]) {
    batches.length = 0;
    await own.forceFlush();
    const batch = batches[0]!;
    assert.equal(deliver(rebaser, { batch, life }), batch, `life ${String(life)} returns the batch itself`);
  }
  await own.shutdown();
});

test("end to end through factoryMetricExporter: a skew_step draw and a salted_after_unsalted draw of the real wakeInstanceId each start the counters at zero", async (t) => {
  const lifeKey = Symbol.for("apj_factory.otel.life");
  const holder = globalThis as { [lifeKey]?: unknown };
  const frozenLife = holder[lifeKey];
  const sent: { life: unknown; values: Record<string, number> }[] = [];
  t.mock.method(OTLPMetricExporter.prototype, "export", (batch: ResourceMetrics, done: (result: ExportResult) => void) => {
    const values: Record<string, number> = {};
    for (const name of ["e2e.skew", "e2e.stale"]) {
      const value = sums(batch, name)[0]?.value;
      if (value !== undefined) values[name] = value;
    }
    sent.push({ life: batch.resource.attributes["service.instance.id"], values });
    done({ code: ExportResultCode.SUCCESS });
  });
  const reasons: string[] = [];
  t.mock.method(console, "info", (line: unknown) => {
    try {
      const parsed = JSON.parse(String(line)) as { otel?: string; reason?: string };
      if (parsed.otel === "instance_id" && parsed.reason !== undefined) reasons.push(parsed.reason);
    } catch {
      // Not an instance_id line.
    }
  });
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, "now", () => realNow() + offset);
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic x";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1/otlp";
  delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  delete holder[lifeKey];
  const request = (spanId: string) => trace.setSpanContext(context.active(), { traceId: "0af7651916cd43dd8448eb211c80319c", spanId, traceFlags: TraceFlags.NONE, isRemote: true });
  const provider = factoryMeterProvider(factoryMetricExporter);
  try {
    const meter = provider.getMeter("agent_sdk");
    const skew = meter.createCounter("e2e.skew");
    const stale = meter.createCounter("e2e.stale");

    // First draw in a request, then a wall-clock step seen by the next request: skew_step.
    const idA = context.with(request("b7ad6b7169203331"), () => wakeInstanceId());
    skew.add(2);
    await provider.forceFlush();
    offset += RESTORE_SKEW_MS + 60_000;
    const idB = context.with(request("b7ad6b7169203332"), () => wakeInstanceId());
    await provider.forceFlush();
    skew.add(1);
    await provider.forceFlush();

    // First draw by a timer's export (no request): stale; the next request draws again.
    delete holder[lifeKey];
    stale.add(3);
    await provider.forceFlush();
    const idC = (holder[lifeKey] as { id: string }).id;
    const idD = context.with(request("b7ad6b7169203333"), () => wakeInstanceId());
    await provider.forceFlush();
    stale.add(1);
    await provider.forceFlush();

    assert.equal(new Set([idA, idB, idC, idD]).size, 4, "four distinct lives");
    assert.deepEqual(reasons, ["first", "skew_step", "first_unsalted", "salted_after_unsalted"]);
    assert.deepEqual(
      sent.map((entry) => ({ life: entry.life, skew: entry.values["e2e.skew"], stale: entry.values["e2e.stale"] })),
      [
        { life: idA, skew: 2, stale: undefined },
        { life: idB, skew: 0, stale: undefined },
        { life: idB, skew: 1, stale: undefined },
        { life: idC, skew: 0, stale: 3 },
        { life: idD, skew: 0, stale: 0 },
        { life: idD, skew: 0, stale: 1 },
      ],
    );
  } finally {
    holder[lifeKey] = frozenLife;
    if (frozenLife === undefined) delete holder[lifeKey];
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await provider.shutdown();
  }
});

test("a life's last export fails and the next export carries a new id: the lost increments go to the new life, and the lives sum to the real total", async () => {
  const { provider, export: tick } = rig();
  const turns = provider.getMeter("agent_sdk").createCounter(TURNS);
  const series: Record<string, number> = {};
  const note = (life: string, batch: ResourceMetrics) => {
    series[life] = sums(batch, TURNS)[0]!.value;
  };
  turns.add(3);
  note("A", await tick("A"));
  turns.add(2);
  await tick("A", { fail: true });
  turns.add(1);
  note("B", await tick("B"));
  assert.deepEqual(series, { A: 3, B: 3 }, "B carries the 2 that A never delivered, and its own 1");
  assert.equal(Object.values(series).reduce((a, b) => a + b, 0), 6);
});

test("a failed export on the same life is carried by the next cumulative sample, and a later rotation subtracts what was delivered", async () => {
  const { provider, export: tick } = rig();
  const turns = provider.getMeter("agent_sdk").createCounter(TURNS);
  turns.add(3);
  assert.equal(sums(await tick("A"), TURNS)[0]!.value, 3);
  turns.add(2);
  await tick("A", { fail: true });
  turns.add(1);
  assert.equal(sums(await tick("A"), TURNS)[0]!.value, 6, "the failed batch's 2 are in the next sample of the same life");
  turns.add(1);
  assert.equal(sums(await tick("B"), TURNS)[0]!.value, 1, "the delivered 6 are the baseline");
});

test("a failed export on the first tick of a new life leaves the baseline in place for the life's next tick", async () => {
  const { provider, export: tick } = rig();
  const turns = provider.getMeter("agent_sdk").createCounter(TURNS);
  turns.add(4);
  await tick("A");
  turns.add(1);
  await tick("B", { fail: true });
  turns.add(1);
  assert.equal(sums(await tick("B"), TURNS)[0]!.value, 2, "B's failed first export is carried by its next sample, the baseline unchanged");
});

test("a success reported late never overwrites a newer one", () => {
  const rebaser = createLifeRebaser();
  const first = rebaser.rebase({ batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  const second = rebaser.rebase({ batch: sumBatch({ value: 5, end: [20, 0] }), life: "A" });
  rebaser.delivered(second);
  rebaser.delivered(first);
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 7, end: [30, 0] }), life: "B" }), "c")[0]!.value, 2, "the baseline is the newer tick's 5, not the older tick's 3");
  assert.deepEqual(sums(rebaser.rebase({ batch: sumBatch({ value: 7, end: [40, 0] }), life: "B" }), "c")[0]!.start, [20, 0]);
});

test("a batch the rebaser did not return, or one reported twice, changes nothing", () => {
  const rebaser = createLifeRebaser();
  const out = rebaser.rebase({ batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  rebaser.delivered(sumBatch({ value: 99, end: [99, 0] }));
  rebaser.delivered(out);
  rebaser.delivered(out);
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 4, end: [20, 0] }), life: "B" }), "c")[0]!.value, 1);
});

test("factoryMetricExporter does not remember a batch the OTLP exporter failed on: 3, then 2 on a failed export, a new id, then 1 sum to 6", async (t) => {
  const outcomes: ExportResult["code"][] = [];
  const sent: { life: unknown; value: number | undefined; ok: boolean }[] = [];
  t.mock.method(OTLPMetricExporter.prototype, "export", (batch: ResourceMetrics, done: (result: ExportResult) => void) => {
    const code = outcomes.shift() ?? ExportResultCode.SUCCESS;
    sent.push({ life: batch.resource.attributes["service.instance.id"], value: sums(batch, "e2e.failed")[0]?.value, ok: code === ExportResultCode.SUCCESS });
    done({ code });
  });
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic x";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1/otlp";
  const provider = factoryMeterProvider(factoryMetricExporter);
  try {
    const counter = provider.getMeter("agent_sdk").createCounter("e2e.failed");
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.instance.id=fail-a";
    counter.add(3);
    await provider.forceFlush();
    counter.add(2);
    outcomes.push(ExportResultCode.FAILED);
    await provider.forceFlush();
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.instance.id=fail-b";
    counter.add(1);
    await provider.forceFlush();
    assert.deepEqual(sent, [
      { life: "fail-a", value: 3, ok: true },
      { life: "fail-a", value: 5, ok: false },
      { life: "fail-b", value: 3, ok: true },
    ]);
    const delivered = new Map(sent.filter((entry) => entry.ok).map((entry) => [entry.life, entry.value!]));
    assert.deepEqual([...delivered], [["fail-a", 3], ["fail-b", 3]]);
    assert.equal([...delivered.values()].reduce((a, b) => a + b, 0), 6, "what the collector holds sums to the real total");
  } finally {
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await provider.shutdown();
  }
});

test("an export still pending when a new life starts is taken as accepted: a late SUCCESS does not count twice, and does not move the new life's baseline", () => {
  const rebaser = createLifeRebaser();
  deliver(rebaser, { batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  const slow = rebaser.rebase({ batch: sumBatch({ value: 5, end: [20, 0] }), life: "A" });
  const first = sums(deliver(rebaser, { batch: sumBatch({ value: 6, end: [30, 0] }), life: "B" }), "c")[0]!;
  assert.equal(first.value, 1, "B subtracts the pending tick's 5: the collector will hold A:5");
  assert.deepEqual(first.start, [20, 0]);
  rebaser.delivered(slow);
  const second = sums(deliver(rebaser, { batch: sumBatch({ value: 8, end: [40, 0] }), life: "B" }), "c")[0]!;
  assert.equal(second.value, 3, "the late result left B's baseline at 5");
  assert.deepEqual(second.start, [20, 0]);
});

test("a pending export that then reports FAILED is the bounded lost tail: its increments are in no sample, and the new life's baseline is unchanged", () => {
  const rebaser = createLifeRebaser();
  deliver(rebaser, { batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  const slow = rebaser.rebase({ batch: sumBatch({ value: 5, end: [20, 0] }), life: "A" });
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 6, end: [30, 0] }), life: "B" }), "c")[0]!.value, 1);
  rebaser.failed(slow);
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 8, end: [40, 0] }), life: "B" }), "c")[0]!.value, 3, "A:3 and B:3 sum to 6 of 8 counted: the 2 of the failed tick are lost");
  const third = createLifeRebaser();
  deliver(third, { batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  third.failed(third.rebase({ batch: sumBatch({ value: 5, end: [20, 0] }), life: "A" }));
  assert.equal(sums(deliver(third, { batch: sumBatch({ value: 6, end: [30, 0] }), life: "B" }), "c")[0]!.value, 3, "a failure reported before the new life starts is carried by it");
});

test("a tick with no header notes totals that were never exported: a new id drawn before the header returns loses the increments in between", () => {
  const rebaser = createLifeRebaser();
  deliver(rebaser, { batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  deliver(rebaser, { batch: sumBatch({ value: 5, end: [20, 0] }), life: undefined });
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 6, end: [30, 0] }), life: "B" }), "c")[0]!.value, 1, "the 2 counted while the header was unset are in no sample");
});

test("ORDERING X: an older export is pending, a newer one FAILS, a new life starts, the older one then answers SUCCESS: the pending export is the baseline, nothing is counted twice", () => {
  const rebaser = createLifeRebaser();
  const stored = new Map<string, number>();
  const store = (life: string, batch: ResourceMetrics) => stored.set(life, Math.max(stored.get(life) ?? 0, sums(batch, "c")[0]!.value));
  store("A", deliver(rebaser, { batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" }));
  const slow = rebaser.rebase({ batch: sumBatch({ value: 5, end: [20, 0] }), life: "A" });
  rebaser.failed(rebaser.rebase({ batch: sumBatch({ value: 6, end: [30, 0] }), life: "A" }));
  const first = deliver(rebaser, { batch: sumBatch({ value: 7, end: [40, 0] }), life: "B" });
  assert.equal(sums(first, "c")[0]!.value, 2, "B subtracts the pending 5, not the delivered 3");
  assert.deepEqual(sums(first, "c")[0]!.start, [20, 0]);
  store("B", first);
  rebaser.delivered(slow);
  store("A", slow);
  assert.deepEqual(Object.fromEntries(stored), { A: 5, B: 2 });
  assert.equal([...stored.values()].reduce((a, b) => a + b, 0), 7, "seven increments, counted once");
});

test("ORDERING X': the first export ever is pending, a newer one FAILS, a new life starts: the pending export is the baseline, so the life is rebased", () => {
  const rebaser = createLifeRebaser();
  const stored = new Map<string, number>();
  const store = (life: string, batch: ResourceMetrics) => stored.set(life, Math.max(stored.get(life) ?? 0, sums(batch, "c")[0]!.value));
  const slow = rebaser.rebase({ batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  rebaser.failed(rebaser.rebase({ batch: sumBatch({ value: 4, end: [20, 0] }), life: "A" }));
  const first = deliver(rebaser, { batch: sumBatch({ value: 5, end: [30, 0] }), life: "B" });
  assert.equal(sums(first, "c")[0]!.value, 2, "B subtracts the pending 3 instead of exporting the whole process total");
  store("B", first);
  rebaser.delivered(slow);
  store("A", slow);
  store("B", deliver(rebaser, { batch: sumBatch({ value: 9, end: [40, 0] }), life: "B" }));
  assert.deepEqual(Object.fromEntries(stored), { A: 3, B: 6 });
  assert.equal([...stored.values()].reduce((a, b) => a + b, 0), 9, "nine increments, counted once");
});

test("the newest pending export is the baseline, whichever order the older ones resolve in; a newer failure is skipped, an older failure changes nothing", () => {
  const rebaser = createLifeRebaser();
  const t1 = rebaser.rebase({ batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  const t2 = rebaser.rebase({ batch: sumBatch({ value: 5, end: [20, 0] }), life: "A" });
  const t3 = rebaser.rebase({ batch: sumBatch({ value: 6, end: [30, 0] }), life: "A" });
  rebaser.failed(t3);
  rebaser.delivered(t1);
  rebaser.failed(t2);
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 8, end: [40, 0] }), life: "B" }), "c")[0]!.value, 5, "t3 and t2 failed: the baseline is the delivered t1 (3)");
  const u1 = rebaser.rebase({ batch: sumBatch({ value: 9, end: [50, 0] }), life: "B" });
  const u2 = rebaser.rebase({ batch: sumBatch({ value: 10, end: [60, 0] }), life: "B" });
  rebaser.delivered(u2);
  rebaser.failed(u1);
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 12, end: [70, 0] }), life: "C" }), "c")[0]!.value, 2, "u2 was delivered: the baseline is 10");
});

test("a header-less tick or a delivery newer than a pending export retires it: a pending export older than the committed one is never the baseline", () => {
  const rebaser = createLifeRebaser();
  rebaser.rebase({ batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  deliver(rebaser, { batch: sumBatch({ value: 5, end: [20, 0] }), life: "A" });
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 6, end: [30, 0] }), life: "B" }), "c")[0]!.value, 1, "the delivered 5 is newer than the pending 3");
  const quiet = createLifeRebaser();
  quiet.rebase({ batch: sumBatch({ value: 3, end: [10, 0] }), life: "A" });
  quiet.rebase({ batch: sumBatch({ value: 5, end: [20, 0] }), life: undefined });
  assert.equal(sums(deliver(quiet, { batch: sumBatch({ value: 6, end: [30, 0] }), life: "B" }), "c")[0]!.value, 1, "the header-less tick's 5 is newer than the pending 3");
});

test("at most 64 exports are kept pending: a forgotten one is not the baseline when every newer one fails, and its late SUCCESS leaves the started life as it is; exactly 64 are all kept", () => {
  const rebaser = createLifeRebaser();
  deliver(rebaser, { batch: sumBatch({ value: 10, end: [1, 0] }), life: "A" });
  const held = Array.from({ length: 70 }, (_, i) => rebaser.rebase({ batch: sumBatch({ value: 11 + i, end: [2 + i, 0] }), life: "A" }));
  for (const batch of held.slice(6)) rebaser.failed(batch);
  const first = sums(deliver(rebaser, { batch: sumBatch({ value: 85, end: [100, 0] }), life: "B" }), "c")[0]!;
  assert.equal(first.value, 75, "the 6 oldest were forgotten and the rest failed: the baseline is the delivered 10, not the forgotten 16");
  assert.deepEqual(first.start, [1, 0]);
  rebaser.delivered(held[5]!);
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 86, end: [110, 0] }), life: "B" }), "c")[0]!.value, 76, "the late SUCCESS does not move the started life's baseline");
  const exact = createLifeRebaser();
  deliver(exact, { batch: sumBatch({ value: 10, end: [1, 0] }), life: "A" });
  const sixtyFour = Array.from({ length: 64 }, (_, i) => exact.rebase({ batch: sumBatch({ value: 11 + i, end: [2 + i, 0] }), life: "A" }));
  for (const batch of sixtyFour.slice(1)) exact.failed(batch);
  assert.equal(sums(deliver(exact, { batch: sumBatch({ value: 85, end: [100, 0] }), life: "B" }), "c")[0]!.value, 74, "exactly 64 pending keeps the oldest: it is the baseline (11), not the delivered 10");
});

test("many exports pending at once: the newest is the baseline", () => {
  const rebaser = createLifeRebaser();
  for (let i = 1; i <= 500; i += 1) rebaser.rebase({ batch: sumBatch({ value: i, end: [i, 0] }), life: "A" });
  assert.equal(sums(deliver(rebaser, { batch: sumBatch({ value: 503, end: [600, 0] }), life: "B" }), "c")[0]!.value, 3);
});

// The reader stops waiting for an export after exportTimeoutMillis and starts
// the next collection while the exporter's callback is still outstanding. The
// OTLP export is mocked and answers when the test says so: the callback of a
// "hold" export is not called until `release`, which waits for it, so no
// assertion depends on wall-clock margins (only the reader's own 100 ms
// timeout elapses, and it does so whenever the callback is held). The reader
// and factoryMetricExporter are the real ones.
type Step = "ok" | "fail" | "hold";
type Sent = { life: unknown; value: number | undefined; code?: ExportResult["code"] };
type ReaderRig = {
  counter: { add(value: number): void };
  life(id: string): void;
  flush(step: Step): Promise<void>;
  release(index: number, code: ExportResult["code"]): Promise<void>;
  sent: Sent[];
};

async function throughRealReader(t: TestContext, name: string, run: (rig: ReaderRig) => Promise<void>): Promise<Map<unknown, number>> {
  const sent: Sent[] = [];
  const answers = new Map<number, (code: ExportResult["code"]) => Promise<void>>();
  let step: Step = "ok";
  t.mock.method(OTLPMetricExporter.prototype, "export", (batch: ResourceMetrics, done: (result: ExportResult) => void) => {
    const entry: Sent = { life: batch.resource.attributes["service.instance.id"], value: sums(batch, name)[0]?.value };
    const index = sent.push(entry) - 1;
    const answer = async (code: ExportResult["code"]) => {
      entry.code = code;
      done({ code });
    };
    if (step === "hold") answers.set(index, answer);
    else void answer(step === "ok" ? ExportResultCode.SUCCESS : ExportResultCode.FAILED);
  });
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic x";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1/otlp";
  const provider = new SdkMeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: factoryMetricExporter, exportIntervalMillis: 3_600_000, exportTimeoutMillis: 100 })] });
  try {
    await run({
      counter: provider.getMeter("agent_sdk").createCounter(name),
      life(id) {
        process.env.OTEL_RESOURCE_ATTRIBUTES = `service.instance.id=${id}`;
      },
      async flush(next) {
        step = next;
        await provider.forceFlush();
      },
      async release(index, code) {
        const answer = answers.get(index);
        assert.ok(answer, `export ${index} was held`);
        answers.delete(index);
        await answer(code);
      },
      sent,
    });
  } finally {
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await provider.shutdown();
  }
  const stored = new Map<unknown, number>();
  for (const entry of sent) if (entry.code === ExportResultCode.SUCCESS) stored.set(entry.life, Math.max(stored.get(entry.life) ?? 0, entry.value!));
  return stored;
}

const sumOf = (stored: Map<unknown, number>) => [...stored.values()].reduce((a, b) => a + b, 0);

for (const late of [ExportResultCode.SUCCESS, ExportResultCode.FAILED] as const) {
  test(`through the real reader: an export that answers ${late === ExportResultCode.SUCCESS ? "SUCCESS" : "FAILED"} after the reader stopped waiting, then a new life`, async (t) => {
    const name = `e2e.late.${late}`;
    const stored = await throughRealReader(t, name, async (r) => {
      r.life(`late-a-${late}`);
      r.counter.add(3);
      await r.flush("ok");
      r.counter.add(2);
      await r.flush("hold");
      r.life(`late-b-${late}`);
      r.counter.add(1);
      await r.flush("ok");
      assert.equal(r.sent[1]!.code, undefined, "the held export had not answered when life B's first export was handed over");
      assert.equal(r.sent[2]!.value, 1, "B's first sample subtracts the pending export");
      await r.release(1, late);
      r.counter.add(1);
      await r.flush("ok");
    });
    assert.equal(stored.get(`late-b-${late}`), 2);
    if (late === ExportResultCode.SUCCESS) assert.equal(sumOf(stored), 7, "A:5 and B:2: seven increments counted once");
    else assert.equal(sumOf(stored), 5, "A:3 and B:2: the failed export's 2 are the documented lost tail, never a double count");
  });
}

test("through the real reader, ORDERING X: an older export is held, a newer one fails, a new life starts, the older one answers SUCCESS: A:5 and B:2", async (t) => {
  const stored = await throughRealReader(t, "e2e.x", async (r) => {
    r.life("x-a");
    r.counter.add(3);
    await r.flush("ok");
    r.counter.add(2);
    await r.flush("hold");
    r.counter.add(1);
    await r.flush("fail");
    r.life("x-b");
    r.counter.add(1);
    await r.flush("ok");
    assert.equal(r.sent[3]!.value, 2, "B subtracts the held export's 5, not the delivered 3");
    await r.release(1, ExportResultCode.SUCCESS);
  });
  assert.deepEqual(Object.fromEntries(stored), { "x-a": 5, "x-b": 2 });
  assert.equal(sumOf(stored), 7, "seven increments counted once");
});

test("through the real reader, ORDERING X': the first export is held, a newer one fails, a new life starts, the first answers SUCCESS: the life is rebased", async (t) => {
  const stored = await throughRealReader(t, "e2e.xp", async (r) => {
    r.life("xp-a");
    r.counter.add(3);
    await r.flush("hold");
    r.counter.add(1);
    await r.flush("fail");
    r.life("xp-b");
    r.counter.add(1);
    await r.flush("ok");
    assert.equal(r.sent[2]!.value, 2, "B subtracts the held first export's 3 instead of exporting the whole process total");
    await r.release(0, ExportResultCode.SUCCESS);
    r.counter.add(4);
    await r.flush("ok");
  });
  assert.deepEqual(Object.fromEntries(stored), { "xp-a": 3, "xp-b": 6 });
  assert.equal(sumOf(stored), 9);
});

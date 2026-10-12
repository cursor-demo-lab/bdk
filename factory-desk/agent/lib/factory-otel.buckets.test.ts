import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, DataPointType, InMemoryMetricExporter, type HistogramMetricData, type MetricData } from "@opentelemetry/sdk-metrics";
import {
  DELIVERY_DURATION_BUCKETS_MS,
  DELIVERY_DURATION_METRIC,
  HOSTED_EXECUTION_DURATION_BUCKETS_MS,
  HOSTED_EXECUTION_DURATION_METRIC,
  traceFactory,
} from "./factory-otel.js";
import { factoryMeterProvider } from "./factory-otel-signals.js";

// Its own file: it registers the global meter provider, which the other
// factory-otel tests leave unset.

const OTEL_DEFAULT_HISTOGRAM_BOUNDARIES = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1_000, 2_500, 5_000, 7_500, 10_000];

function metricsNamed(exporter: InMemoryMetricExporter, name: string): MetricData[] {
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name);
}

/** Inclusive upper-bound index; past the last bound is +Inf (counts.length - 1). */
function bucketIndex(boundaries: readonly number[], value: number): number {
  const found = boundaries.findIndex((bound) => value <= bound);
  return found === -1 ? boundaries.length : found;
}

test("apj_factory.delivery.duration uses the factory's buckets through the allowlist View", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  metrics.setGlobalMeterProvider(provider);
  try {
    await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, async () => "done");
    await provider.forceFlush();
    const histogram = metricsNamed(exporter, DELIVERY_DURATION_METRIC)[0] as HistogramMetricData | undefined;
    assert.ok(histogram, "the duration histogram was exported");
    assert.equal(histogram.dataPointType, DataPointType.HISTOGRAM);
    assert.deepEqual(histogram.dataPoints[0]?.value.buckets.boundaries, [...DELIVERY_DURATION_BUCKETS_MS]);
    assert.deepEqual(Object.keys(histogram.dataPoints[0]?.attributes ?? {}).sort(), ["factory.delivery.kind", "factory.outcome", "factory.span"]);
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
});

test("agent_sdk.hosted_execution.duration_ms uses advice buckets, one stream, count 1, allowlist intact", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  try {
    const histogram = provider.getMeter("agent_sdk").createHistogram(HOSTED_EXECUTION_DURATION_METRIC, { unit: "ms" });
    const samples = [
      { ms: 17_500, channel_kind: "slack", delivery_surface: "slack", outcome: "final_post", extra: { "agent_sdk.session_id": "ses_desk" } },
      { ms: 27_000, channel_kind: "github", delivery_surface: "none", outcome: "none", extra: { "cursor.conversation.id": "ses_review" } },
      { ms: 536_000, channel_kind: "custom", delivery_surface: "none", outcome: "none", extra: {} },
      { ms: 600_000, channel_kind: "http", delivery_surface: "none", outcome: "none", extra: {} },
      { ms: 1_800_001, channel_kind: "gitlab", delivery_surface: "none", outcome: "none", extra: {} },
    ] as const;
    for (const sample of samples) {
      histogram.record(sample.ms, { phase: "total", channel_kind: sample.channel_kind, delivery_surface: sample.delivery_surface, outcome: sample.outcome, ...sample.extra });
    }
    await provider.forceFlush();
    const found = metricsNamed(exporter, HOSTED_EXECUTION_DURATION_METRIC);
    assert.equal(found.length, 1, "one stream: advice on the instrument plus the `*` View, not a second View");
    const data = found[0] as HistogramMetricData;
    assert.equal(data.dataPointType, DataPointType.HISTOGRAM);
    assert.deepEqual(data.dataPoints[0]?.value.buckets.boundaries, [...HOSTED_EXECUTION_DURATION_BUCKETS_MS]);
    const byKind = new Map(data.dataPoints.filter((point) => point.attributes.phase === "total").map((point) => [point.attributes.channel_kind, point]));
    assert.equal(byKind.size, samples.length);
    for (const sample of samples) {
      const point = byKind.get(sample.channel_kind);
      assert.ok(point, sample.channel_kind);
      assert.equal(point.attributes["agent_sdk.session_id"], undefined);
      assert.equal(point.attributes["cursor.conversation.id"], undefined);
      assert.equal(point.value.count, 1, `${sample.channel_kind} must be recorded once, not twice into one stream`);
      assert.equal(point.value.sum, sample.ms);
      const index = bucketIndex(HOSTED_EXECUTION_DURATION_BUCKETS_MS, sample.ms);
      assert.equal(point.value.buckets.counts[index], 1);
    }
    const desk = byKind.get("slack");
    const reviewer = byKind.get("github");
    const planner = byKind.get("custom");
    const edge = byKind.get("http");
    const overflow = byKind.get("gitlab");
    assert.ok(desk && reviewer && planner && edge && overflow);
    assert.equal(bucketIndex(HOSTED_EXECUTION_DURATION_BUCKETS_MS, 17_500), HOSTED_EXECUTION_DURATION_BUCKETS_MS.indexOf(20_000));
    assert.equal(desk.value.buckets.counts[HOSTED_EXECUTION_DURATION_BUCKETS_MS.indexOf(20_000)], 1, "desk 17.5 s sits in the 20 s bucket");
    assert.equal(reviewer.value.buckets.counts[HOSTED_EXECUTION_DURATION_BUCKETS_MS.indexOf(30_000)], 1, "reviewer 27 s sits in the 30 s bucket");
    assert.equal(planner.value.buckets.counts[HOSTED_EXECUTION_DURATION_BUCKETS_MS.indexOf(600_000)], 1, "planner ~536 s sits in the 10 min bucket");
    assert.equal(edge.value.buckets.counts[HOSTED_EXECUTION_DURATION_BUCKETS_MS.indexOf(600_000)], 1, "exactly 600000 lands in its own bucket");
    assert.equal(overflow.value.buckets.counts.at(-1), 1, "1 800 001 lands in +Inf");
    assert.equal(overflow.value.buckets.counts.slice(0, -1).every((count) => count === 0), true);
  } finally {
    await provider.shutdown();
  }
});

test("createHistogram keeps caller advice on hosted-execution duration", async () => {
  const custom = [1, 2, 3];
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  try {
    provider.getMeter("agent_sdk").createHistogram(HOSTED_EXECUTION_DURATION_METRIC, { unit: "ms", advice: { explicitBucketBoundaries: custom } }).record(2);
    await provider.forceFlush();
    const data = metricsNamed(exporter, HOSTED_EXECUTION_DURATION_METRIC)[0] as HistogramMetricData | undefined;
    assert.ok(data);
    assert.deepEqual(data.dataPoints[0]?.value.buckets.boundaries, custom);
    assert.equal(data.dataPoints[0]?.value.count, 1);
    assert.equal(data.dataPoints[0]?.value.sum, 2);
  } finally {
    await provider.shutdown();
  }
});

test("factoryMeterProvider getMeter returns the same wrapper for the same name", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  try {
    assert.equal(provider.getMeter("a"), provider.getMeter("a"));
  } finally {
    await provider.shutdown();
  }
});

test("a histogram the factory does not name still uses the OTel default buckets", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  try {
    provider.getMeter("agent_sdk").createHistogram("agent_sdk.http.duration", { unit: "ms" }).record(12);
    await provider.forceFlush();
    const data = metricsNamed(exporter, "agent_sdk.http.duration")[0] as HistogramMetricData | undefined;
    assert.ok(data);
    assert.deepEqual(data.dataPoints[0]?.value.buckets.boundaries, OTEL_DEFAULT_HISTOGRAM_BOUNDARIES);
    assert.equal(data.dataPoints[0]?.value.count, 1);
    assert.equal(data.dataPoints[0]?.value.sum, 12);
  } finally {
    await provider.shutdown();
  }
});

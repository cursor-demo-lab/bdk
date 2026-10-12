import type { HrTime } from "@opentelemetry/api";
import type { InstrumentationScope } from "@opentelemetry/core";
import { DataPointType, type HistogramMetricData, type MetricData, type ResourceMetrics, type SumMetricData } from "@opentelemetry/sdk-metrics";

// Per-life counters. Cumulative counters live in the process, and a hosted
// VM's process outlives the `service.instance.id` it exports under:
// wakeInstanceId (factory-otel.ts) draws a new id when a restore or resume is
// seen, but the instruments, bound to the meter provider built before the
// freeze, keep their totals. Left alone, the new id's first sample is the
// whole history of the process, and a dashboard that adds the last value of
// every series counts that history again (a desk process that only handled
// `approve KEY` exported agent_sdk.turn.count = 2 from its first sample).
//
// The rebaser makes a new life's series start from zero (apart from the up to
// METRIC_INTERVAL_MS window before the draw, and what a failed last export
// left; see below), the form
// observability/grafana/generate.py `inc()` assumes. It remembers the raw
// totals of each export tick that was delivered (the exporter reported
// SUCCESS) or is still pending, and of each tick that exports nothing (no
// header), which has nothing to fail. When an export carries a life it has not
// seen, it takes the newest such totals (see below) as that life's baseline
// and subtracts them from every monotonic sum
// and histogram stream, with a start time at the tick it took them from. What
// the process counted between that tick and the draw (at most one
// METRIC_INTERVAL_MS when that tick was the last before the draw; a failed
// last export adds its increments, see below) belongs to the new life. Gauges and non-monotonic sums
// pass through. A rebased histogram point drops min and max: the SDK keeps
// them for the process's lifetime, and a life with count 0 must not export
// one. A histogram is rebased only when its bucket boundaries match the
// baseline's and no count, bucket, or sum fell below it; otherwise it passes
// through as it is, like a counter that fell. Exponential histograms are not
// rebased: nothing in the factory or in July 0.2.18 creates one (the `*` View
// sets no aggregation), and factory-otel-signals.test.ts fails if that
// changes. A rebased point's start time is the end of the tick the baseline
// was taken from, clamped to this export's end when the clock stepped back,
// and fixed for the life. It assumes the reader exports one batch per
// collection (see factoryMeterProvider). Spans and logs are not touched.
//
// What a new life subtracts is the totals of the old life's newest export
// the exporter has not reported FAILED: the newest pending one that is newer
// than the last delivered or header-less tick, else that tick, on the
// assumption that the collector took it.
// Every header'd export is pending, in sequence order, until the exporter
// reports a result; a result removes it. A reported FAILED is not remembered,
// and metrics have no retry: on the same life the next cumulative sample
// carries what it held, and if the next export carries a new life the new
// life's first sample does. The reader gives no guarantee that an export has
// settled: sdk-metrics 2.11's PeriodicExportingMetricReader wraps each export
// in callWithTimeout and, on a TimeoutError (exportTimeoutMillis, 2250 ms
// here), stops waiting and clears `_ongoingExportPromise` while the exporter's
// callback is still outstanding, and the OTLP exporter can answer after that (a
// 2000 ms socket-idle timer is not a total bound, and a retried 429 or 503
// waits and resends). So the next collection can start, and a new life can
// begin, while several older exports are in flight and answer in any order.
// The newest one still pending when the new life starts is the baseline even
// if a newer one has already FAILED, because the older one may still be
// stored. A tick reported late never moves the baseline of a life that already
// started (it was copied at the draw) and is ordered by a sequence number, so
// an older result never replaces a newer one. The pending list holds at most
// MAX_PENDING ticks (an OTLPMetricExporter instance fails its 31st
// concurrent export synchronously, so at most 30 are pending per instance;
// cachedExporter builds a new instance when the header or endpoint changes,
// and the old one's in-flight exports still report here; exceeding 64 would
// take at least two such changes, with the full 30 still in flight on each of
// the first two instances and five more on the third, so it is not expected
// in practice); the oldest is dropped first. A forgotten tick can only have
// been the baseline if every newer one had failed (a newer delivery commits
// and retires it anyway), and then its late SUCCESS is counted twice: the
// lives sum high by its increments.
//
// What this leaves, all bounded by the increments of the ticks since the last
// delivered one (normally one interval's; except a partialSuccess, whose loss
// is the increments since the last export the collector kept in full for that
// series, and an unset header, whose loss is everything counted from the last
// delivered tick until the header is set again). The list is not exhaustive:
// the exporter reports a transport outcome, and the collector's own handling
// of the data is not visible to it.
//  - the pending export taken as accepted then reports FAILED: its increments
//    are in no sample (the new life subtracted them). The same loss happens
//    when a life's last export fails and the VM is never resumed.
//  - a batch the collector stored but the exporter reported as FAILED (the
//    idle timer destroys the socket after the body was sent): the next life
//    carries it again, so the lives sum high by that much. The client cannot
//    tell the two apart.
//  - a 2xx with a partialSuccess that rejected data points is SUCCESS to the
//    exporter: the baseline includes increments the collector did not keep, so
//    they are in no sample.
//  - a tick with no header notes totals that were never exported (it is how a
//    snapshot's totals are kept out of the first life after a restore). If the
//    header is unset (`secrets unset`, the kill switch) and set again, and the
//    first export after that carries a new id (the clock stepped while it was
//    unset), the increments between the last delivered tick and the last
//    header-less tick are in no sample.
//
// What it cannot do: it sees totals only at export ticks, so a restored
// snapshot whose totals moved after its last tick starts its life at that
// movement, and a process that had counted with no export header set before
// its first export drops those counts. Series already stored keep the
// carried-over values they were exported with until they age out of the
// dashboards' look-back; the rebase only fixes lives exported after it ships.
// The baseline is taken at the first new id drawn after a restore, so a
// restore that draws no new id (a shared id, two lives never told apart) has
// nothing taken off and is not repaired; see docs/factory-deployment.md.

type Raw = number | { count: number; sum: number | undefined; boundaries: number[]; counts: number[] };
type Rebasable = SumMetricData | HistogramMetricData;

/** Negative, zero, or positive as `a` is before, equal to, or after `b`. */
function hrTimeCompare(a: HrTime, b: HrTime): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/**
 * One stream: scope (name, version, schema URL), metric name, data point
 * type, and attributes. Two scopes that differ only in version, or a counter
 * and a histogram of one name, are different streams.
 */
function seriesKey(input: { scope: InstrumentationScope; metric: string; type: DataPointType; attributes: Record<string, unknown> }): string {
  const { scope } = input;
  const attributes = Object.entries(input.attributes)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",");
  return `${JSON.stringify([scope.name, scope.version ?? null, scope.schemaUrl ?? null, input.type, input.metric])}\n${attributes}`;
}

function rebasable(metric: MetricData): metric is Rebasable {
  return (metric.dataPointType === DataPointType.SUM && metric.isMonotonic) || metric.dataPointType === DataPointType.HISTOGRAM;
}

function endOf(batch: ResourceMetrics): HrTime | undefined {
  for (const scope of batch.scopeMetrics) for (const metric of scope.metrics) for (const point of metric.dataPoints) return point.endTime;
  return undefined;
}

/** The raw totals of every rebasable stream in a batch. */
function rawTotals(batch: ResourceMetrics): Map<string, Raw> {
  const totals = new Map<string, Raw>();
  for (const scope of batch.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (!rebasable(metric)) continue;
      for (const point of metric.dataPoints) {
        const key = seriesKey({ scope: scope.scope, metric: metric.descriptor.name, type: metric.dataPointType, attributes: point.attributes });
        if (metric.dataPointType === DataPointType.SUM) totals.set(key, point.value as number);
        else {
          const histogram = point.value as { count: number; sum?: number; buckets: { boundaries: number[]; counts: number[] } };
          totals.set(key, { count: histogram.count, sum: histogram.sum, boundaries: [...histogram.buckets.boundaries], counts: [...histogram.buckets.counts] });
        }
      }
    }
  }
  return totals;
}

/**
 * The histogram less a baseline, or the histogram itself when it is not
 * comparable (same policy as a fallen counter): other bucket boundaries, or
 * any count, bucket, or sum below the baseline's.
 */
function subtractedHistogram(input: { value: { count: number; sum?: number; min?: number; max?: number; buckets: { boundaries: number[]; counts: number[] } }; base: Extract<Raw, object> }) {
  const { value, base } = input;
  const { boundaries, counts } = value.buckets;
  const comparable =
    base.count <= value.count &&
    (value.sum === undefined || value.sum >= (base.sum ?? 0)) &&
    base.boundaries.length === boundaries.length &&
    base.boundaries.every((boundary, index) => boundary === boundaries[index]) &&
    base.counts.length === counts.length &&
    counts.every((count, index) => count >= base.counts[index]!);
  if (!comparable) return value;
  return {
    ...value,
    min: undefined,
    max: undefined,
    count: value.count - base.count,
    ...(value.sum === undefined ? {} : { sum: value.sum - (base.sum ?? 0) }),
    buckets: { boundaries, counts: counts.map((count, index) => count - base.counts[index]!) },
  };
}

function rebasedMetric(input: { scope: InstrumentationScope; metric: Rebasable; baseline: Map<string, Raw>; since: HrTime }): MetricData {
  const { scope, metric, baseline, since } = input;
  const dataPoints = metric.dataPoints.map((point) => {
    const base = baseline.get(seriesKey({ scope, metric: metric.descriptor.name, type: metric.dataPointType, attributes: point.attributes }));
    if (base === undefined) return point;
    if (metric.dataPointType === DataPointType.SUM) {
      return typeof base === "number" && base <= (point.value as number) ? { ...point, startTime: since, value: (point.value as number) - base } : point;
    }
    if (typeof base === "number") return point;
    const value = subtractedHistogram({ value: point.value as Parameters<typeof subtractedHistogram>[0]["value"], base });
    return value === point.value ? point : { ...point, startTime: since, value };
  });
  return { ...metric, dataPoints } as MetricData;
}

export type LifeRebaser = {
  /**
   * The batch as one life should export it, for the caller to hand to the
   * exporter. `life` is undefined on a tick that exports nothing (no header):
   * the totals are noted at once and nothing is rebased. On any other tick the
   * totals are pending until `delivered` or `failed` is called with the
   * returned batch; a new life that starts meanwhile takes the totals of the
   * newest still-pending tick that is newer than the last committed one, else
   * the last committed totals as its baseline.
   */
  rebase(input: { batch: ResourceMetrics; life: string | undefined }): ResourceMetrics;
  /**
   * The exporter reported ExportResultCode.SUCCESS for the batch `rebase`
   * returned. It stops being pending. Its totals are now what a later life
   * subtracts, unless a newer tick is still pending, was delivered, or had no
   * header. It never changes a life that has begun.
   */
  delivered(batch: ResourceMetrics): void;
  /**
   * The exporter reported a failure for the batch `rebase` returned. Its
   * totals are not remembered, it stops being pending, and a new life that has
   * not started yet no longer takes it as accepted (an older tick that is still
   * pending is).
   */
  failed(batch: ResourceMetrics): void;
};

const MAX_PENDING = 64;

type Tick = { seq: number; totals: Map<string, Raw>; end: HrTime | undefined; status: "pending" | "ok" | "failed" };

export function createLifeRebaser(): LifeRebaser {
  let life: string | undefined;
  let previous = new Map<string, Raw>();
  let previousEnd: HrTime | undefined;
  let committed = 0;
  let sequence = 0;
  let baseline = new Map<string, Raw>();
  let since: HrTime | undefined;
  let unresolved: Tick[] = [];
  const pending = new WeakMap<ResourceMetrics, Tick>();
  const commit = (tick: Tick): void => {
    if (tick.seq <= committed) return;
    committed = tick.seq;
    previous = tick.totals;
    previousEnd = tick.end ?? previousEnd;
    unresolved = unresolved.filter((other) => other.seq > committed);
  };
  const resolve = (tick: Tick): void => {
    unresolved = unresolved.filter((other) => other !== tick);
  };
  return {
    rebase({ batch, life: next }) {
      const tick: Tick = { seq: (sequence += 1), totals: rawTotals(batch), end: endOf(batch), status: "pending" };
      let out = batch;
      if (next !== undefined) {
        if (next !== life) {
          life = next;
          // The newest export still pending is taken as accepted; see the header comment.
          const taken = unresolved.at(-1);
          const from = taken?.end ?? previousEnd;
          baseline = taken?.totals ?? previous;
          // A wall clock that stepped back, or a stale snapshot's previous end, can put it after this export's end; clamped once, so it holds for the whole life.
          since = from !== undefined && tick.end !== undefined && hrTimeCompare(from, tick.end) > 0 ? tick.end : from;
        }
        if (baseline.size > 0 && since !== undefined) {
          const start = since;
          out = {
            ...batch,
            scopeMetrics: batch.scopeMetrics.map((scope) => ({
              ...scope,
              metrics: scope.metrics.map((metric) => (rebasable(metric) ? rebasedMetric({ scope: scope.scope, metric, baseline, since: start }) : metric)),
            })),
          };
        }
      }
      if (next === undefined) {
        tick.status = "ok";
        commit(tick);
      } else {
        unresolved.push(tick);
        if (unresolved.length > MAX_PENDING) unresolved.shift();
        pending.set(out, tick);
      }
      return out;
    },
    delivered(batch) {
      const tick = pending.get(batch);
      if (tick === undefined) return;
      pending.delete(batch);
      tick.status = "ok";
      resolve(tick);
      commit(tick);
    },
    failed(batch) {
      const tick = pending.get(batch);
      if (tick === undefined) return;
      pending.delete(batch);
      tick.status = "failed";
      resolve(tick);
    },
  };
}

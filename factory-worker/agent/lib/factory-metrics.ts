import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { metrics } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { AggregationTemporality, AggregationType, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { exportConfigured, factoryOtelConfig, HOSTED_EXECUTION_DURATION_BUCKETS_MS, HOSTED_EXECUTION_DURATION_METRIC, otlpEndpoint, registerFactoryFlush } from "./factory-otel.js";

// The factory's one meter provider: cumulative metrics. July's own metric
// exporters are DELTA (node_modules/@cursor/july/dist/internal/otel/runtime.js:181,
// no knob) and Grafana Cloud's OTLP endpoint answers a DELTA sum with HTTP 400
// `invalid temporality and type combination` (measured 2026-10-14; a CUMULATIVE
// sum on the same endpoint with the same header was stored). With a metrics
// exporter in no `defineOtel` config July builds no meter provider and takes the
// global one (runtime.js:155-158), so `cursor.*`, `agent_sdk.*` and
// `apj_factory.*` all leave through this provider. agent/otel.ts installs it
// before July's startServer; traces and logs stay on July's providers.
//
// Three parts, each there for a reason:
// - The exporter reads OTEL_EXPORTER_OTLP_HEADERS on every export. A hosted pod
//   starts before its secrets bind and gets them per request. With the header
//   unset it sends nothing.
// - `service.instance.id`, one per process life. Cumulative counters from
//   several VMs of one slug that share a series overwrite each other. The id is
//   drawn at the first export with the header set: a deploy snapshot is taken
//   before any secret binds, so no id is in it and every restored VM draws its
//   own. It hashes a fresh read of the kernel pool with the clocks and pid;
//   crypto.randomUUID() would repeat across clones for the 128 UUIDs Node
//   batches. No rebase: nothing records a value before the first request (no
//   instrument is touched at startup; ops-funnel's bind adds 0), so a new
//   life's series starts at its own increments.
// - One View for July's hosted-execution histogram, which July creates with no
//   bucket advice (HOSTED_EXECUTION_DURATION_BUCKETS_MS). No attribute
//   allowlist: July's collector (otel/collector.js:619-626) and the session-bound
//   `host.otel` (host-otel.js:83-95) stamp `agent_sdk.session_id`,
//   `cursor.conversation.id` and the session's tag bag on the samples of a
//   session (`cursor.*`, `agent_sdk.turn.count`, `agent_sdk.session.count`, the
//   factory's `host.otel` counters); the hosted-execution and http histograms
//   carry none of them. Under a cumulative reader that is a series per session
//   for the life of the process, bounded by the SDK's default limit of 2000
//   per instrument; a hosted process serves few sessions, and the panels sum
//   over those labels.
//
// A pod frozen or replaced before the next 10 s export loses that interval:
// July's forceFlush, which hosted delivery runs before every reply
// (hosted-delivery.js afterHostedWork, wired at server.js:657), covers only the
// providers July built (runtime.js:44), and this one is not among them. Hosted
// v2 can park the VM as soon as the reply lands, so two triggers call
// flushFactoryMetrics, each bounded, errors logged and never thrown:
// hooks/metrics-flush.ts when a session turn ends, and traceFactory
// (lib/factory-otel.ts) when the last open factory span of a delivery ends,
// which covers work that runs no turn (a webhook or Slack handler, a
// `waitUntil` wake, a GitHub hook or task, a reminder). That file imports this
// one's constants, so installFactoryMeter hands it the flush through
// registerFactoryFlush instead of the reverse import. Not covered, still on
// the 10 s export: the execution request's own
// `agent_sdk.hosted_execution.duration_ms` and `agent_sdk.http.duration`, which
// July records after the work, just before the reply, and any metric recorded
// outside a factory span. The clean fix is July's flushOtel also flushing the
// global meter provider, which covers all of these, or CUMULATIVE support in
// July's exporters, which would retire this file (docs/july-otel-upstream.md).
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs); its test
// is factory-desk's factory-metrics.test.ts.

export const METRIC_INTERVAL_MS = 10_000;
export const EXPORT_TIMEOUT_MS = 2_000;

const LIFE = Symbol.for("apj_factory.otel.life");
const INSTALLED = Symbol.for("apj_factory.otel.meter");
const PROVIDER = Symbol.for("apj_factory.otel.provider");
export const FLUSH_TIMEOUT_MS = 1_000;

/** OTEL_EXPORTER_OTLP_HEADERS as July reads it: `k=v` pairs split on `,` at the first `=`, each value URL-decoded (a stray `%` is sent as written). */
export function otlpHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (env["OTEL_EXPORTER_OTLP_HEADERS"] ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const raw = part.slice(at + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

/** 16 bytes read straight from the kernel pool; randomBytes only where it cannot be opened. */
function kernelBytes(): Buffer {
  try {
    const fd = openSync("/dev/urandom", "r");
    try {
      const out = Buffer.alloc(16);
      if (readSync(fd, out, 0, 16, null) === 16) return out;
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not Linux: fall through.
  }
  return randomBytes(16);
}

/** This process life's `service.instance.id`, drawn on first use. */
export function lifeId(): string {
  const holder = globalThis as { [LIFE]?: string };
  holder[LIFE] ??= createHash("sha256").update(kernelBytes()).update(`${process.hrtime.bigint()}.${Date.now()}.${process.pid}`).digest("hex").slice(0, 32);
  return holder[LIFE];
}

/** The resource of one export: the config's service and namespace, and this life's id. */
export function exportResource(env: NodeJS.ProcessEnv): Resource {
  const config = factoryOtelConfig(env);
  return resourceFromAttributes({ "service.name": config.serviceName ?? "software-factory", ...config.resourceAttributes, "service.instance.id": lifeId() });
}

/**
 * Cumulative OTLP metrics, with the header read on every export. With the header unset it succeeds without sending and
 * draws no id. The OTLP exporter is built at the first export that sends, so the endpoint is read then.
 */
export function factoryMetricExporter(): PushMetricExporter {
  let inner: OTLPMetricExporter | undefined;
  const sender = (): OTLPMetricExporter =>
    (inner ??= new OTLPMetricExporter({
      url: `${otlpEndpoint(process.env)}/v1/metrics`,
      headers: async () => otlpHeaders(process.env),
      timeoutMillis: EXPORT_TIMEOUT_MS,
      temporalityPreference: AggregationTemporality.CUMULATIVE,
    }));
  return {
    export(batch: ResourceMetrics, done: (result: ExportResult) => void): void {
      if (!exportConfigured(process.env)) return done({ code: ExportResultCode.SUCCESS });
      sender().export({ ...batch, resource: exportResource(process.env) }, done);
    },
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    forceFlush: async () => void (await inner?.forceFlush()),
    shutdown: async () => void (await inner?.shutdown()),
  };
}

/** Registers the meter provider globally, once per process. Another global provider means the factory's metrics are not exported, and one console line says so. */
export function installFactoryMeter(): void {
  const holder = globalThis as { [INSTALLED]?: true };
  if (holder[INSTALLED] === true) return;
  holder[INSTALLED] = true;
  const provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter: factoryMetricExporter(), exportIntervalMillis: METRIC_INTERVAL_MS, exportTimeoutMillis: EXPORT_TIMEOUT_MS })],
    views: [{ instrumentName: HOSTED_EXECUTION_DURATION_METRIC, aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [...HOSTED_EXECUTION_DURATION_BUCKETS_MS] } } }],
  });
  if (metrics.setGlobalMeterProvider(provider)) {
    (globalThis as { [PROVIDER]?: MeterProvider })[PROVIDER] = provider;
    registerFactoryFlush(() => flushFactoryMetrics());
  } else {
    console.warn("[factory:otel] MeterProvider already registered; factory metrics are not exported");
  }
}

/**
 * Exports the factory's meter provider now. Waits at most `timeoutMs`. A timeout or a forceFlush rejection is one
 * console line; a failed export goes to the OTel global error handler, as for the periodic export, and the flush
 * resolves. Never throws. No-op when this process registered no provider.
 */
export async function flushFactoryMetrics(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
  const provider = (globalThis as { [PROVIDER]?: MeterProvider })[PROVIDER];
  if (provider === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    const flush = provider.forceFlush().then(() => "done" as const);
    // Promise.race already handles a late rejection; this makes it explicit.
    flush.catch(() => undefined);
    const outcome = await Promise.race([
      flush,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (outcome === "timeout") console.warn(`[factory:otel] metrics flush exceeded ${timeoutMs}ms; continuing`);
  } catch (error) {
    console.warn(`[factory:otel] metrics flush failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

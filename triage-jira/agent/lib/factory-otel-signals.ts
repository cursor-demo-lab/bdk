import { randomBytes } from "node:crypto";
import { format } from "node:util";
import {
  context,
  createContextKey,
  diag,
  metrics,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  trace,
  type Attributes,
  type Context,
  type DiagLogger,
  type Meter,
  type MetricOptions,
  type TracerProvider,
} from "@opentelemetry/api";
import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter, type ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
  type IAttributesProcessor,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  SamplingDecision,
  type IdGenerator,
  type ReadableSpan,
  type Sampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { OtelConfig, OtelSignal } from "@cursor/july/otel";
import {
  capExportTimeouts,
  codeLike,
  currentFactoryConfig,
  EXPORT_TIMEOUT_MS,
  exportConfigured,
  FACTORY_OTEL_SCOPE,
  factoryMounts,
  factoryOtelConfig,
  gateOutboundTraceContext,
  HOSTED_EXECUTION_DURATION_BUCKETS_MS,
  HOSTED_EXECUTION_DURATION_METRIC,
  otlpEndpoint,
  parseOtelHeaders,
  registerFactoryTracerProvider,
  registerSignalFlush,
  requestSalt,
  isTicketLabelled,
  SIGNALS_BUDGET_MS,
  TICKET_KEY_ATTRIBUTE,
  TICKET_LABELLED_METRICS,
  ticketLabel,
  ticketLabelledContext,
  wakeHex,
} from "./factory-otel.js";
import { createLifeRebaser } from "./factory-otel-rebase.js";
import { factorySlug } from "./kv-keys.js";

// The export wiring agent/otel.ts installs: spans (July's own included),
// metrics, and logs through providers this file owns and registers
// globally. All use the endpoint in factory-otel.ts and the
// OTEL_EXPORTER_OTLP_HEADERS secret, read when each export runs.
//
// Why the factory owns its exporters (July 0.2.22). A hosted v2 pod starts
// before its secrets bind and gets them in process.env per request
// (dist/internal/cursor/hosted-bound-secrets.js). July builds its OTel
// runtime once, at startServer (dist/internal/server.js), and its OTLP
// exporters then and only then: runtime.js `startOtelSdk` passes each
// exporter a header object that config.js `withEnvHeaders` spread from
// OTEL_EXPORTER_OTLP_HEADERS at that moment, and the OTLP exporters read
// env headers only when constructed
// (otlp-exporter-base convert-legacy-node-http-options.js). A header bound
// later never reaches them. 0.2.22 still snapshots that object once.
// From 0.2.21, a traces/metrics/logs exporter makes July keep a *local*
// provider even when a global one is registered ("BDK … export on a local
// provider") and bind the collector to those local instruments. Factory
// session flush never sees BDK-local queues, so that split would drop
// turn spans and send July logs with frozen (often empty) headers.
// - Spans: July's own (agent_sdk.http, turns, tools, host MCP calls) and the
//   factory's (factory.delivery and the rest). One tracer provider of the
//   factory's, registered as the global one (an approved exception to
//   "July's spans leave as July emits them", Bug 6b), with a
//   BatchSpanProcessor into one cached exporter, so a span waits in a queue
//   the factory flushes (below), a span that ends during an export stays
//   queued, and a flush reuses the connection. The resolver hands July a
//   dummy exporter whose `includes` matches no signal (`defineOtel` rejects
//   `signals: []`), so 0.2.22 builds no local tracer (exportersForSignal is
//   empty for traces, metrics, and logs) and uses `trace.getTracer()` —
//   the factory's. Without a global tracer and with no traces exporter,
//   July records its spans in memory (a SimpleSpanProcessor into a buffer
//   capped at 2,048, runtime.js, "otel recording service") that
//   `flushDeferred` exports after each hosted delivery and empties with
//   `reset()` on success, and two flushes that overlap dropped a turn span
//   that ended during the first one's export (docs/july-otel-upstream.md
//   sections 4 and 12). July's forceFlush flushes only providers July built,
//   so it never flushes this one: a session turn's spans leave on the
//   factory flush agent/hooks/zz-otel-turn-flush.ts awaits from session.*
//   before the hosted reply (Bug 6a), which this change depends on; the
//   rest leave on the next factory flush or the TRACE_DELAY_MS timer.
//   NodeTracerProvider.register(), which July calls only for a provider of
//   its own, is what registered an AsyncLocalStorage context manager, so
//   installFactorySignals registers one; without it the active context, and
//   with it a span's parent, is lost at the first await.
//   Every span, July's included, gets the factory's sampler and ids. Ids
//   come from wakeHex (factory-otel.ts), drawn when the span starts, not
//   from OTel's default generator, which draws on Math.random: hosted v2
//   restores VMs from a snapshot that repeats Math.random's state, and one
//   July span id was seen under 34 traces and 13 instances. Spans are not
//   recorded at all while the header is unset (exportGatedSampler), and
//   their ids, which OTel draws before it samples, are then plain
//   randomBytes. The sampler is parent-based, as July's is, so
//   agent_sdk.http under an unsampled inbound request is still not recorded
//   (docs/july-otel-upstream.md section 9). July's spans leave with the
//   export's resource (exportResource), which carries the `cursor.surface`
//   and `cursor.entrypoint` July's own resource added (section 4).
//   Names, attributes, and events stay as July set them. If another
//   provider holds the global slot first, installFactorySignals warns
//   (`global_provider_taken`, `tracer: false`), July's spans go to that
//   provider, and the factory's still go through this one.
// - Metrics and logs: this file registers both when agent/otel.ts loads,
//   before startServer. Their exporters are built for the current endpoint
//   and header and reused until either changes (one connection, not one per
//   export). The dummy exporter still has `exporters.length > 0`, so July
//   turns metrics and logs on, but `exportersForSignal` is empty for every
//   signal, so 0.2.22 builds no local MeterProvider or LoggerProvider and
//   `createOtelRuntime` falls back to these globals. Do not name a logs-only
//   or traces exporter: 0.2.22 would keep a local provider and export
//   through frozen headers.
//
// Metrics are cumulative: this file's MeterProvider is the one July reuses,
// so July's own delta preference never applies. They keep only
// METRIC_ATTRIBUTE_KEYS: July labels each metric with the session and
// conversation id, the bound agent id, and any session tags (collector.js
// `join`), and a cumulative reader would keep one series per session for
// the life of the pod. The values of the enum-like keys (METRIC_VALUES) are
// held to the ones July 0.2.18 sets, `reason` and `purpose` to July's reminder
// reasons and the factory's own purposes, and anything else is `other`
// (metricAttributes), so no value mints a series. `factory.ticket.key`, the
// one session tag that is kept, bounded to a Jira key, `none` or `other`
// (hooks/ticket-key.ts tagSessionTicket), is kept only on a sample of
// TICKET_LABELLED_METRICS: factoryMeter's counter for those names records
// under ticketLabelledContext, and on any other sample the key is dropped
// like every session tag, so `cursor.tool.calls` and the factory's own
// metrics never carry it. factoryMeterProvider
// subclasses MeterProvider and, on createHistogram for
// agent_sdk.hosted_execution.duration_ms, injects
// advice.explicitBucketBoundaries (100 ms to 30 min) when the caller set
// none. July creates that histogram with no advice, and the OTel default
// stops at 10 s. The `*` View keeps the allowlist and cardinality cap;
// its default aggregation honours the advice. A second matching View
// would not export a second stream: it would record each sample twice
// into one stream. The
// resource carries a `service.instance.id` for the VM's life after its
// restore (factory-otel.ts wakeInstanceId), so VMs restored from one
// snapshot, each holding the snapshot's counter values, are separate series
// and do not overwrite each other. It cannot see every restore; see there.
// The counters themselves keep running across an id change, so
// factoryMetricExporter hands each batch to factory-otel-rebase.ts, which
// subtracts the totals of the old life's newest export (the newest pending one
// newer than the last delivered or header-less tick, else that tick) from a
// new life's series, so it starts near zero. Failed exports and late results
// leave the loss and overcount cases in docs/factory-deployment.md; what was
// counted in the up to 10 s before the draw goes to the new life.
//
// Log records and spans leave as July or the factory emitted them: original
// body, only the attributes the emitter set, no redaction, no allowlist, no
// filtering (the factory loses a record only by an export failure or the
// diag-logger exception, both below, a full batch-processor queue (2,048,
// newest dropped), or a pod that stops before the next export, or an export
// that runs while the header is unset, which discards the batch
// (factoryLogExporter, factorySpanExporter); July's spans take the same
// path, not July's in-memory buffer), and no parse of the body to mint
// attributes. The resolver turns July's
// `logs.userPrompts` and `logs.toolContent` on. July 0.2.18 `collector.js`
// then emits this content (Grafana access is the only control; July
// truncates every content field except `agent_sdk.sdk_agent_url` at
// CONTENT_MAX 2048 + "…", :13, :677-682):
// - `agent_sdk.user_prompt` on `message.received` logs only (:91-95), when
//   `userPrompts` is on.
// - `agent_sdk.error_message` on `turn.failed` / `session.failed` logs only
//   (:373-377, :404-408), gated by `toolContent` (`gatedContent` :625-629).
// - `agent_sdk.tool_args` / `agent_sdk.tool_output` on `agent_sdk.tool`
//   spans (`actions.requested` / `action.result`).
// - `agent_sdk.subagent_description` on `agent_sdk.subagent` spans
//   (:259-261).
// - `agent_sdk.sdk_agent_url` on open turn / tool / subagent spans
//   (`agent.bound`, :77-88).
// - Turn span status text + `recordException` only for non-expected
//   failures (:352-366); `session.failed` also sets open turn-span status
//   (:398-403).
// - The `action.result` log never carries output (:227-232).
// The console bridge sends `util.format` of every argument as the body,
// with no derived attributes, no trim, and no type gate, so a later Error
// stays in the formatted body. Dashboards parse raw bodies in LogQL.
// One exception, by source not by body: messages the OpenTelemetry SDK
// itself writes through its diag logger (at July's ERROR level: export
// failures and other SDK-internal errors, including those routed via
// OTel's global error handler) still print to stdout but are not
// re-exported through the console bridge. App, factory, and July console
// lines are unaffected. July hooks that logger to `console.log`
// (`runtime.js` :93-99, `server.js` :117); re-exporting it would loop
// (~1 POST + 1 stack line per second on 401 or 503). The factory wraps
// the diag logger, sets a flag while it runs, and the bridge skips
// `logger.emit` for that call only. A log batch or span batch the
// collector did not take for a transient reason (no answer, 429, 5xx)
// is retried with the next one, up to LOG_RETRY_LIMIT /
// SPAN_RETRY_LIMIT records (the newest); a 4xx batch is dropped. Exports
// can overlap, and each failure adds to what an earlier one left. A
// request that timed out on the client may have been accepted by the
// collector, so the retry can send a record twice: delivery is at least
// once, not exactly once.
//
// Timeouts. One OTLP request is bounded by EXPORT_TIMEOUT_MS (2 s: about
// twice the 0.9 s a VM's first, cold-TLS request takes to the AU gateway),
// and the processors and the metric reader by SIGNALS_BUDGET_MS, a little
// above it, so a timed-out export reports back and keeps its batch before
// the processor gives up on it. Each delivery waits at most
// SIGNALS_BUDGET_MS for all three signals together.
//
// Flushing. Each delivery's outermost factory span waits for
// flushFactorySignals within the delivery's SIGNALS_BUDGET_MS
// (factory-otel.ts traceFactory), spans, metrics, and logs in parallel; the
// span has ended by then. A flush asked for while one runs joins the next
// one, which starts as soon as the running one ends, so no record is left
// to the timers. agent/lib/otel-turn-flush.ts asks for one right after July
// records a session turn's end (joining a running flush as above),
// unawaited, and awaits one from the session.* event July dispatches after
// it, before the hosted reply: the one flush the reply waits for that
// carries a session turn's spans, since no factory span wraps the turn and
// July's forceFlush skips the adopted tracer. The resolver starts one,
// unawaited, only when July runs it at a flush, which it does only on its
// memory path (the tracer was not ours: `global_provider_taken`). The span
// processor exports every TRACE_DELAY_MS, the metric reader every
// METRIC_INTERVAL_MS, and the log processor every LOG_DELAY_MS while the
// pod runs.
//
// With the header unset no exporter is built and nothing is sent.
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs);
// factory-desk's july-otel.test.ts drives it through July's runtime.

export const METRIC_INTERVAL_MS = 10_000;
export const LOG_DELAY_MS = 1_000;
/** How long a finished span waits for the next batch when no flush asks for it. */
export const TRACE_DELAY_MS = 300;
export const LOG_RETRY_LIMIT = 1_000;
/** July's own in-memory span cap (runtime.js OTEL_IN_MEMORY_SPAN_LIMIT). */
export const SPAN_RETRY_LIMIT = 2_048;
export const METRIC_CARDINALITY_LIMIT = 500;

/**
 * The values July 0.2.18 gives each enum-like metric attribute. Anything
 * else is kept as `other`, so a bug upstream, or a value July takes from
 * somewhere free, cannot mint a series and push real ones into overflow.
 *
 * - `phase`, `channel_kind`, `delivery_surface`, and `outcome` of
 *   agent_sdk.hosted_execution.* (hosted-execution-latency.js: five phases;
 *   every channel kind July 0.2.18 mounts, sanitized, so `agent-sdk:reminder`
 *   is `agent_sdk_reminder`: the SCM, issues, runs, and change_monitors channels
 *   as well as the ones the factory mounts; the delivery surfaces; the
 *   first-visible outcomes).
 * - `outcome` of agent_sdk.tool.retry (tool-call-retry.js).
 * - `kind` of agent_sdk.reminder.fire_outcome (reminder-runner.js).
 */
export const METRIC_VALUES = {
  phase: new Set(["to_first_visible", "first_visible_to_completion", "durability_drain", "post_drain", "total"]),
  channel_kind: new Set(["slack", "github", "gitlab", "bitbucket", "origin", "issues", "runs", "change_monitors", "deployments", "custom", "http", "agent_sdk_reminder", "agent_sdk_schedule"]),
  delivery_surface: new Set(["slack", "none"]),
  outcome: new Set(["progress_update", "final_post", "error", "none", "not_eligible", "recovered", "exhausted"]),
  kind: new Set(["error", "skipped", "delivered", "stop"]),
} as const satisfies Record<string, ReadonlySet<string>>;

export const METRIC_ENUM_KEYS: readonly string[] = Object.keys(METRIC_VALUES);

/**
 * The `reason` values of agent_sdk.reminder.fire_outcome that July's
 * reminder runner sets on the path that counts it (executeFire: runFire,
 * deliverPromptFire, promptDelivery). A reason a later July release adds, or
 * a free-form one such as a reminder's `disarmReason`, is `other` until it
 * is listed here.
 */
export const METRIC_REMINDER_REASONS: ReadonlySet<string> = new Set([
  "fire_threw",
  "handler_missing",
  "handler_lost_on_restart",
  "missing_handler",
  "until_fn",
  "busy",
  "run_stop",
  "run_skip",
  "run_delivered",
  "session_joined",
  "session_restored",
  "session_opened",
  "session_gone",
  "followup_failed",
]);

/**
 * The `purpose` values of agent_sdk.reminder.fire_outcome: July's default
 * and the factory's own reminders. A reminder's purpose is a slug the model
 * may choose (1 to 64 characters), so any other value is `other`. Add a
 * purpose here when a new factory reminder gets one.
 */
export const METRIC_REMINDER_PURPOSES: ReadonlySet<string> = new Set(["follow_up", "hop_watch", "implement_pr", "implement_launch", "merge_conflict_watch"]);

/**
 * Every metric attribute that is kept; the rest (session, conversation, and
 * agent ids, session tags) are dropped by a View. `factory.ticket.key` is not
 * here: metricAttributes keeps it only on TICKET_LABELLED_METRICS.
 */
export const METRIC_ATTRIBUTE_KEYS: readonly string[] = [
  "agent_sdk.agent",
  "agent_sdk.channel",
  "agent_sdk.subagent_name",
  "agent_sdk.turn_status",
  "cursor.token.type",
  "cursor.model.name",
  "cursor.tool.name",
  "cursor.tool.kind",
  "cursor.tool.status",
  "http.request.method",
  "http.response.status_code",
  "url.path",
  "factory.span",
  "factory.delivery.kind",
  "factory.outcome",
  "slug",
  "site",
  "reason",
  ...METRIC_ENUM_KEYS,
  "purpose",
];

/**
 * `reason` is shared. July's reminder outcome (the one metric that also has a
 * `kind`) takes one of METRIC_REMINDER_REASONS. The factory's own
 * apj_factory.kv.failure carries a hosted reason code such as
 * `agentsdk_kv_key_invalid` or `http_503`, kept when it is code-shaped.
 */
function reasonOf(incoming: Attributes): string {
  const value = incoming["reason"];
  if (typeof value !== "string") return "other";
  if (incoming["kind"] !== undefined) return METRIC_REMINDER_REASONS.has(value) ? value : "other";
  return codeLike(value) ?? "other";
}

/**
 * The attributes a metric keeps: METRIC_ATTRIBUTE_KEYS only, the enum-like
 * ones from their value sets (else `other`), and, on a sample recorded in
 * the ticket-labelled context (factory-otel.ts ticketLabelledContext, which
 * factoryMeter's counters for TICKET_LABELLED_METRICS record under),
 * `factory.ticket.key` bounded by ticketLabel. The SDK passes each record's
 * context to the View (sdk-metrics SyncMetricStorage `record`); a sample
 * from any other instrument, July's `cursor.tool.calls` and the factory's
 * kv.failure among them, drops the key however it arrived (a caller's
 * attributes, a session's tag bag merged by host.otel).
 */
export function metricAttributes(incoming: Attributes, recordContext?: Context): Attributes {
  const out: Attributes = {};
  for (const key of METRIC_ATTRIBUTE_KEYS) {
    const value = incoming[key];
    if (value === undefined) continue;
    if (key === "purpose") out[key] = typeof value === "string" && METRIC_REMINDER_PURPOSES.has(value) ? value : "other";
    else if (key === "reason") out[key] = reasonOf(incoming);
    else if (Object.hasOwn(METRIC_VALUES, key)) out[key] = typeof value === "string" && METRIC_VALUES[key as keyof typeof METRIC_VALUES].has(value) ? value : "other";
    else out[key] = value;
  }
  if (isTicketLabelled(recordContext)) out[TICKET_KEY_ATTRIBUTE] = ticketLabel(incoming[TICKET_KEY_ATTRIBUTE]);
  return out;
}

const metricAttributesProcessor: IAttributesProcessor = { process: (incoming, recordContext) => metricAttributes(incoming, recordContext) };

const INSTALLED = Symbol.for("apj_factory.otel.signals");
const CONSOLE_METHODS = { debug: SeverityNumber.DEBUG, log: SeverityNumber.INFO, info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR } as const;
const SEVERITY_TEXT: Record<number, string> = { [SeverityNumber.DEBUG]: "DEBUG", [SeverityNumber.INFO]: "INFO", [SeverityNumber.WARN]: "WARN", [SeverityNumber.ERROR]: "ERROR" };

type Installed = {
  tracerProvider: BasicTracerProvider;
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider;
  logger: Logger;
  inFlight?: Promise<void>;
  queued?: Promise<void>;
};
type Target = { key: string; base: string; headers: Record<string, string> };
type Cached<E> = { key: string; exporter: E };

function installed(): Installed | undefined {
  return (globalThis as { [INSTALLED]?: Installed })[INSTALLED];
}

function exportTarget(env: NodeJS.ProcessEnv): Target | undefined {
  if (!exportConfigured(env)) return undefined;
  const base = otlpEndpoint(env);
  const raw = env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
  return { key: `${base}\n${raw}`, base, headers: parseOtelHeaders(raw) };
}

/**
 * The exporter for `target`, reused while the endpoint and header stay the
 * same; a changed or unset header shuts the old one down.
 */
function cachedExporter<E extends { shutdown(): Promise<void> }>(input: { slot: { current?: Cached<E> }; target: Target | undefined; build: (target: Target) => E }): E | undefined {
  const { slot, target } = input;
  if (slot.current !== undefined && slot.current.key !== target?.key) {
    void slot.current.exporter.shutdown().catch(() => undefined);
    slot.current = undefined;
  }
  if (target === undefined) return undefined;
  slot.current ??= { key: target.key, exporter: input.build(target) };
  return slot.current.exporter;
}

/**
 * The resource for a span, metric, or log export, built when it runs: the
 * stage and the slug count are known only then. `cursor.surface` and
 * `cursor.entrypoint` are the values July's `buildResource` (runtime.js) gave
 * its own spans, which the collector joins on; July builds no resource for
 * the tracer it adopts.
 */
export function exportResource(env: NodeJS.ProcessEnv): Resource {
  const config = currentFactoryConfig(env);
  return resourceFromAttributes({
    "service.name": config.serviceName ?? FACTORY_OTEL_SCOPE,
    "telemetry.sdk.language": "nodejs",
    "cursor.surface": "unspecified",
    "cursor.entrypoint": "sdk_ts",
    "agent_sdk.framework": "@cursor/bdk",
    ...config.resourceAttributes,
  });
}

const traceSlot: { current?: Cached<OTLPTraceExporter> } = {};
const metricSlot: { current?: Cached<OTLPMetricExporter> } = {};
const logSlot: { current?: Cached<OTLPLogExporter> } = {};

const lifeRebaser = createLifeRebaser();

/** Cumulative OTLP metrics to the current endpoint with the current header, each new life's counters rebased to start near zero (factory-otel-rebase.ts). */
export const factoryMetricExporter: PushMetricExporter = {
  export(batch: ResourceMetrics, done: (result: ExportResult) => void): void {
    const exporter = cachedExporter({
      slot: metricSlot,
      target: exportTarget(process.env),
      build: (target) =>
        new OTLPMetricExporter({ url: `${target.base}/v1/metrics`, headers: target.headers, timeoutMillis: EXPORT_TIMEOUT_MS, temporalityPreference: AggregationTemporality.CUMULATIVE }),
    });
    if (exporter === undefined) {
      lifeRebaser.rebase({ batch, life: undefined });
      done({ code: ExportResultCode.SUCCESS });
      return;
    }
    const resource = exportResource(process.env);
    const life = resource.attributes["service.instance.id"];
    const rebased = lifeRebaser.rebase({ batch, life: typeof life === "string" ? life : undefined });
    exporter.export({ ...rebased, resource }, (result) => {
      // The result can arrive after the reader's exportTimeoutMillis, when it has stopped waiting and the next collection has begun; the rebaser accounts for that (factory-otel-rebase.ts).
      if (result.code === ExportResultCode.SUCCESS) lifeRebaser.delivered(rebased);
      else lifeRebaser.failed(rebased);
      done(result);
    });
  },
  selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
  forceFlush: async () => undefined,
  shutdown: async () => undefined,
};

/** A log record as it may leave the process: original body and attributes, this export's resource. */
export function exportedLogRecord(input: { record: ReadableLogRecord; resource: Resource }): ReadableLogRecord {
  const { record, resource } = input;
  return new Proxy(record, {
    get(target, prop) {
      return prop === "resource" ? resource : Reflect.get(target, prop);
    },
  });
}

/** True for an export failure worth retrying: no answer, a network error, 429, or 5xx. */
function transient(result: ExportResult): boolean {
  const status = (result.error as { code?: unknown } | undefined)?.code;
  return typeof status !== "number" || status === 429 || status >= 500;
}

/**
 * What a transiently failed export leaves for the next one: the records it
 * took, kept after those already held, newest `limit` only. Exports can
 * overlap (a delivery's flush runs beside the timer's), so each failure adds
 * to what an earlier one left instead of replacing it.
 */
function keptForRetry<T>(input: { held: readonly T[]; failed: readonly T[]; limit: number }): T[] {
  return [...input.held, ...input.failed].slice(-input.limit);
}

let logRetry: ReadableLogRecord[] = [];

/** OTLP logs through exportedLogRecord to the current endpoint with the current header; a transiently failed batch rides the next one. */
export const factoryLogExporter: LogRecordExporter = {
  export(records: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    const exporter = cachedExporter({
      slot: logSlot,
      target: exportTarget(process.env),
      build: (target) => new OTLPLogExporter({ url: `${target.base}/v1/logs`, headers: target.headers, timeoutMillis: EXPORT_TIMEOUT_MS }),
    });
    if (exporter === undefined) {
      logRetry = [];
      done({ code: ExportResultCode.SUCCESS });
      return;
    }
    const resource = exportResource(process.env);
    const batch = [...logRetry, ...records.map((record) => exportedLogRecord({ record, resource }))];
    logRetry = [];
    exporter.export(batch, (result) => {
      if (result.code !== ExportResultCode.SUCCESS && transient(result)) logRetry = keptForRetry({ held: logRetry, failed: batch, limit: LOG_RETRY_LIMIT });
      done(result);
    });
  },
  shutdown: async () => undefined,
};

/** A span as it may leave the process: this export's resource in place of the one it was created with. */
export function spanWithResource(input: { span: ReadableSpan; resource: Resource }): ReadableSpan {
  const { span, resource } = input;
  return new Proxy(span, {
    get(target, prop) {
      return prop === "resource" ? resource : Reflect.get(target, prop);
    },
  });
}

let spanRetry: ReadableSpan[] = [];

/** OTLP spans with this export's resource to the current endpoint with the current header; a transiently failed batch rides the next one. */
export const factorySpanExporter: SpanExporter = {
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    const exporter = cachedExporter({
      slot: traceSlot,
      target: exportTarget(process.env),
      build: (target) => new OTLPTraceExporter({ url: `${target.base}/v1/traces`, headers: target.headers, timeoutMillis: EXPORT_TIMEOUT_MS }),
    });
    if (exporter === undefined) {
      spanRetry = [];
      done({ code: ExportResultCode.SUCCESS });
      return;
    }
    const resource = exportResource(process.env);
    const batch = [...spanRetry, ...spans.map((span) => spanWithResource({ span, resource }))];
    spanRetry = [];
    exporter.export(batch, (result) => {
      if (result.code !== ExportResultCode.SUCCESS && transient(result)) spanRetry = keptForRetry({ held: spanRetry, failed: batch, limit: SPAN_RETRY_LIMIT });
      done(result);
    });
  },
  forceFlush: async () => undefined,
  shutdown: async () => undefined,
};

/**
 * One console call as a log record: `util.format` of every argument as the
 * body and no derived attributes. The factory does not parse JSON or `[tag]
 * key=value` text; dashboards read those fields from the raw body. There is
 * no trim and no type gate: a later argument (an Error) stays in the body.
 */
export function consoleRecord(...args: unknown[]): { body: string; attributes: Attributes } {
  return { body: format(...args), attributes: {} };
}

let otelDiagLogging = false;
let diagSetLoggerWrapped = false;

function wrapDiagLogger(inner: DiagLogger): DiagLogger {
  const run =
    (method: keyof DiagLogger): DiagLogger[keyof DiagLogger] =>
    (message: string, ...args: unknown[]) => {
      const prev = otelDiagLogging;
      otelDiagLogging = true;
      try {
        inner[method](message, ...args);
      } finally {
        otelDiagLogging = prev;
      }
    };
  return { error: run("error"), warn: run("warn"), info: run("info"), debug: run("debug"), verbose: run("verbose") };
}

/**
 * Wrap whatever logger July (or a test) installs on `diag.setLogger`.
 * Messages the OpenTelemetry SDK itself writes through its diag logger
 * (at July's ERROR level: export failures and other SDK-internal errors,
 * including those routed via OTel's global error handler) still print to
 * stdout but are not re-exported through the console bridge. App, factory,
 * and July console lines are unaffected. A nested diag call restores the
 * outer call's flag, so the rest of the outer diag call stays unexported.
 */
function installDiagBridgeGuard(): void {
  if (diagSetLoggerWrapped) return;
  diagSetLoggerWrapped = true;
  const original = diag.setLogger.bind(diag);
  diag.setLogger = ((logger: DiagLogger, options?: Parameters<typeof diag.setLogger>[1]) => original(wrapDiagLogger(logger), options)) as typeof diag.setLogger;
}

/**
 * What Node's own print of a process warning looks like: one string that
 * starts `(node:<pid>) ` and holds the warning's `Name: message` (after an
 * optional `[code] `). Anything else a listener logs stays an error; the one
 * exception, a listener that writes exactly this shape inside the window, is
 * described on `bridgeConsole`. Node's own print also stays an error when it
 * cannot be matched: a custom `toString()`, or a `name` or `message` that is a
 * getter or not a string (the bridge never calls user code, so it does not
 * try to predict those); a listener that changes `name` or `message` during
 * the dispatch (the text is read once, when it starts); and, with
 * `--trace-warnings` or `--trace-deprecation` (Node then prints
 * `warning.stack`), a stack header that differs from that text (a `name` or
 * `message` changed after `.stack` was first read). With a trace flag and an
 * ordinary warning the header is the same text, so the print is still the
 * WARN.
 */
type WarningPrint = { prefix: string; text: string };

/** An own or inherited data property's value; undefined for a getter or a missing property, so no user code runs. */
function dataValue(target: object, key: string): unknown {
  for (let object: object | null = target; object !== null; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined;
  }
  return undefined;
}

/**
 * The print Node will make for `warning`, worked out when the dispatch starts
 * so the console-time match is a plain string compare. For a plain warning
 * Node's text is `Error.prototype.toString` of its `name` and `message`, which
 * is computed here from their data values: the bridge never calls the
 * warning's own methods or getters, because that is user code that could
 * count its calls or throw, and Node must be the only one to run it. Anything
 * else has no match and the print stays on the normal ERROR path.
 */
function expectedWarningPrint(warning: Error): WarningPrint | undefined {
  if (dataValue(warning, "toString") !== Error.prototype.toString) return undefined;
  const name = dataValue(warning, "name");
  const message = dataValue(warning, "message");
  if (typeof name !== "string" || typeof message !== "string") return undefined;
  return { prefix: `(${process.release.name}:${process.pid}) `, text: Error.prototype.toString.call({ name, message }) };
}

function isNodeWarningPrint(expected: WarningPrint, args: unknown[]): boolean {
  return args.length === 1 && typeof args[0] === "string" && args[0].startsWith(expected.prefix) && args[0].includes(expected.text);
}

/**
 * Patches the console methods so each call is also a log record whose level
 * is the method's, with one exception: Node writes a process warning (an
 * ExperimentalWarning, a DeprecationWarning) through `console.error`, and
 * that one print is exported at WARN. Body and attributes are what every
 * other call gets: `util.format` of what Node printed, none derived.
 *
 * Node prints from its own `warning` listener, inside one synchronous
 * `process.emit("warning", warning)`. The bridge wraps `process.emit` for that
 * event, so the window is exactly that call: it records the print Node will
 * make, and puts back what it found when `emit` returns or throws. The first
 * `console.error` inside it that has Node's shape (see WarningPrint) is the
 * print, and takes the WARN. That print is one record, at WARN, not a second
 * one at ERROR. The warning is not dropped or deduplicated here; Node's own
 * once-per-process rule for experimental warnings still applies. Nothing
 * outside the call is in the window: not an `uncaughtException` handler after
 * a listener throws, not a `nextTick` or microtask that is already queued, not
 * a later timer. A listener that re-emits `warning` synchronously with
 * `process.emit` has its own window for the inner warning, and the outer one is
 * back when it returns.
 *
 * Every `warning` listener runs inside the window, in listener order: those
 * prepended after the bridge or before it, Node's own, then those added with
 * `on`. The limit: a listener that writes a line in exactly Node's shape
 * through `console.error` takes the WARN if no line in the dispatch has
 * matched yet. Ahead of Node's print (a prepended listener) that leaves Node's
 * own print at ERROR, one WARN still; once any line has matched, a later
 * listener's line is ERROR. When Node prints nothing (`--no-warnings`,
 * `--disable-warning`, `--redirect-warnings`, `NODE_NO_WARNINGS=1`) or prints
 * something that did not match the text the bridge expected, the window stays
 * open until the first match, so a Node-shaped line from any listener takes the
 * WARN. When the bridge had no text to expect (a custom `toString()`, a getter)
 * there is no window and nothing is relabelled. With
 * `--redirect-warnings`, Node prints nothing to the console, but falls back to
 * `console.error` when it cannot open the file (inside its listener, so that
 * print is the WARN) or when a write fails (after the dispatch, so that print
 * is exported at ERROR); it is never dropped.
 *
 * Node reads `console.error` once, at the process's first warning print, and
 * keeps it. The bridge must be installed before any warning is printed: a
 * warning printed earlier makes every later print bypass the bridge.
 *
 * The bridge keeps the `process.emit` it found and calls it, so another
 * wrapper installed before or after chains with it. July's proper-lockfile
 * pulls signal-exit@3, which captures and installs its own wrapper at module
 * load and never unloads, so warnings pass through the bridge in either order.
 * A library that captures `process.emit` before the bridge installs and
 * installs its wrapper afterwards, or that later restores a captured
 * `process.emit`, routes the dispatch around the bridge; Node's print then
 * goes to ERROR as it does today, and nothing is dropped.
 */
export function bridgeConsole(logger: Logger): void {
  let dispatching: WarningPrint | undefined;
  const emit = process.emit;
  process.emit = function bridgedEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]) {
    if (event !== "warning") return Reflect.apply(emit, this, [event, ...args]);
    const outer = dispatching;
    dispatching = args[0] instanceof Error ? expectedWarningPrint(args[0]) : undefined;
    try {
      return Reflect.apply(emit, this, [event, ...args]);
    } finally {
      dispatching = outer;
    }
  } as typeof process.emit;
  for (const [method, base] of Object.entries(CONSOLE_METHODS) as [keyof typeof CONSOLE_METHODS, SeverityNumber][]) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      try {
        let severity = base;
        if (method === "error" && dispatching !== undefined && isNodeWarningPrint(dispatching, args)) {
          severity = SeverityNumber.WARN;
          dispatching = undefined;
        }
        if (otelDiagLogging || !exportConfigured(process.env)) return;
        const record = consoleRecord(...args);
        logger.emit({ body: record.body, severityNumber: severity, severityText: SEVERITY_TEXT[severity], attributes: record.attributes, context: context.active() });
      } catch {
        // Logging never breaks the caller.
      }
    };
  }
}

const rootSampler = new ParentBasedSampler({ root: new AlwaysOnSampler() });

/**
 * Records every factory root, and so every child of one, while the export
 * header is set; records nothing while it is unset. Read at each span
 * start: hosted secrets bind per request, after the process starts.
 */
export const exportGatedSampler: Sampler = {
  shouldSample: (...args) => (exportConfigured(process.env) ? rootSampler.shouldSample(...args) : { decision: SamplingDecision.NOT_RECORD }),
  toString: () => "ExportGatedSampler",
};

/**
 * Trace and span ids from wakeHex, salted with the inbound span of the
 * request being served. Not OTel's default generator: that draws from
 * Math.random, whose state a restored VM snapshot repeats, so the first span
 * after every restore got the same id.
 *
 * With the export header unset the span is never recorded and its ids never
 * leave the process, but OTel draws them before it samples; they come from
 * randomBytes then, not from a kernel read and a SHA-256 per id.
 */
export const factoryIdGenerator: IdGenerator = {
  generateTraceId: () => idHex(16),
  generateSpanId: () => idHex(8),
};

function idHex(bytes: number): string {
  if (!exportConfigured(process.env)) return randomBytes(bytes).toString("hex");
  const salt = requestSalt();
  return wakeHex({ bytes, ...(salt === undefined ? {} : { salt }) });
}

/** A tracer provider that exports in batches of TRACE_DELAY_MS through `exporter`; installFactorySignals registers it globally. */
export function factoryTracerProvider(exporter: SpanExporter): BasicTracerProvider {
  return new BasicTracerProvider({
    sampler: exportGatedSampler,
    idGenerator: factoryIdGenerator,
    spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: TRACE_DELAY_MS, exportTimeoutMillis: SIGNALS_BUDGET_MS })],
  });
}

/**
 * The `*` View: label allowlist and cardinality cap on every instrument.
 * Buckets for HOSTED_EXECUTION_DURATION_METRIC come from advice on
 * createHistogram (FactoryMeterProvider), not a second View. A second
 * matching View would record each sample twice into one stream. Logs and
 * traces are not selected.
 */
function factoryWildcardView(): { instrumentName: "*"; attributesProcessors: IAttributesProcessor[]; aggregationCardinalityLimit: number } {
  return { instrumentName: "*", attributesProcessors: [metricAttributesProcessor], aggregationCardinalityLimit: METRIC_CARDINALITY_LIMIT };
}

const factoryMeters = new WeakMap<Meter, Meter>();

/**
 * Delegates every Meter method; injects hosted-execution bucket advice when
 * the caller set none, and gives the counters named in
 * TICKET_LABELLED_METRICS the context the View keeps `factory.ticket.key`
 * under. Cached per underlying meter so getMeter identity matches the SDK.
 */
function factoryMeter(meter: Meter): Meter {
  const cached = factoryMeters.get(meter);
  if (cached !== undefined) return cached;
  const wrapper: Meter = {
    createGauge: meter.createGauge.bind(meter),
    createHistogram(name: string, options?: MetricOptions) {
      if (name !== HOSTED_EXECUTION_DURATION_METRIC) return meter.createHistogram(name, options);
      return meter.createHistogram(name, {
        ...options,
        advice: { ...options?.advice, explicitBucketBoundaries: options?.advice?.explicitBucketBoundaries ?? [...HOSTED_EXECUTION_DURATION_BUCKETS_MS] },
      });
    },
    createCounter(name: string, options?: MetricOptions) {
      const counter = meter.createCounter(name, options);
      if (!TICKET_LABELLED_METRICS.has(name)) return counter;
      return {
        add: (value: number, attributes?: Attributes, ctx?: Context) => counter.add(value, attributes, ticketLabelledContext(ctx)),
      };
    },
    createUpDownCounter: meter.createUpDownCounter.bind(meter),
    createObservableGauge: meter.createObservableGauge.bind(meter),
    createObservableCounter: meter.createObservableCounter.bind(meter),
    createObservableUpDownCounter: meter.createObservableUpDownCounter.bind(meter),
    addBatchObservableCallback: meter.addBatchObservableCallback.bind(meter),
    removeBatchObservableCallback: meter.removeBatchObservableCallback.bind(meter),
  };
  factoryMeters.set(meter, wrapper);
  return wrapper;
}

/**
 * Honours July's createHistogram for HOSTED_EXECUTION_DURATION_METRIC
 * (no advice) by injecting HOSTED_EXECUTION_DURATION_BUCKETS_MS (a
 * caller that already set explicitBucketBoundaries keeps them), and July's
 * createCounter for the token and turn counters by recording them
 * under the ticket-labelled context (factoryMeter). Wrappers are cached on
 * the SDK meter from super.getMeter.
 */
class FactoryMeterProvider extends MeterProvider {
  override getMeter(...args: Parameters<MeterProvider["getMeter"]>): Meter {
    return factoryMeter(super.getMeter(...args));
  }
}

/** A meter provider whose `*` View applies metricAttributes, keeps at most METRIC_CARDINALITY_LIMIT series per metric, and whose getMeter gives HOSTED_EXECUTION_DURATION_METRIC buckets to 30 min and TICKET_LABELLED_METRICS their ticket label. */
export function factoryMeterProvider(exporter: PushMetricExporter): MeterProvider {
  return new FactoryMeterProvider({
    views: [factoryWildcardView()],
    // maxExportBatchSize must stay unset: factory-otel-rebase.ts assumes one
    // batch per collection, and a split batch would be rebased against totals
    // from a different slice.
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: METRIC_INTERVAL_MS, exportTimeoutMillis: SIGNALS_BUDGET_MS })],
  });
}

const CONTEXT_PROBE = createContextKey("apj_factory.otel.context_probe");

/** True when the registered context manager carries a context into its callback; the API's default (no manager) carries none. */
function contextManagerRegistered(): boolean {
  return context.with(ROOT_CONTEXT.setValue(CONTEXT_PROBE, true), () => context.active().getValue(CONTEXT_PROBE) === true);
}

/** True when `provider` is the delegate of the API's global tracer provider, so July's `hasRealTracerProvider` sees it and skips its memory path. */
function globalTracerIs(provider: TracerProvider): boolean {
  const global = trace.getTracerProvider();
  return global instanceof ProxyTracerProvider && global.getDelegate() === provider;
}

/**
 * Registers the factory's tracer, meter, and logger providers globally (the
 * tracer under the Bug 6b exception: 0.2.22 is given no signal exporter, so
 * it builds no local provider and uses these globals; it records no span in
 * memory), an
 * AsyncLocalStorage context manager unless one is registered, the console
 * bridge, and traceFactory's flush, once per process. Must run before July's
 * startServer, which is when agent/otel.ts loads. The context manager
 * registers first: July's spans and the factory's nest through the active
 * context, and NodeTracerProvider.register(), which used to install it, is
 * July's and no longer runs. Tracer and logger register before the meter so
 * a later factoryMeterProvider throw cannot leave logs and traces
 * uninstalled. July's forceFlush never flushes the factory's tracer, so a
 * session turn's spans rely on the session.* flush that
 * agent/hooks/zz-otel-turn-flush.ts awaits (Bug 6a).
 */
export function installFactorySignals(): void {
  const holder = globalThis as { [INSTALLED]?: Installed };
  const existing = holder[INSTALLED];
  if (existing !== undefined) {
    registerFactoryTracerProvider(existing.tracerProvider);
    registerSignalFlush(flushFactorySignals);
    return;
  }
  installDiagBridgeGuard();
  if (!contextManagerRegistered()) {
    const manager = new AsyncLocalStorageContextManager().enable();
    if (!context.setGlobalContextManager(manager)) manager.disable();
  }
  const tracerProvider = factoryTracerProvider(factorySpanExporter);
  const loggerProvider = new LoggerProvider({
    processors: [new BatchLogRecordProcessor(factoryLogExporter, { scheduledDelayMillis: LOG_DELAY_MS, exportTimeoutMillis: SIGNALS_BUDGET_MS })],
  });
  registerFactoryTracerProvider(tracerProvider);
  trace.setGlobalTracerProvider(tracerProvider);
  const ownsTracer = globalTracerIs(tracerProvider);
  const ownsLogger = logs.setGlobalLoggerProvider(loggerProvider) === loggerProvider;
  const logger = loggerProvider.getLogger(FACTORY_OTEL_SCOPE);
  if (ownsLogger) bridgeConsole(logger);
  const meterProvider = factoryMeterProvider(factoryMetricExporter);
  const ownsMeter = metrics.setGlobalMeterProvider(meterProvider);
  holder[INSTALLED] = { tracerProvider, meterProvider, loggerProvider, logger };
  registerSignalFlush(flushFactorySignals);
  if (!ownsTracer || !ownsMeter || !ownsLogger) console.warn(JSON.stringify({ otel: "global_provider_taken", tracer: ownsTracer, meter: ownsMeter, logger: ownsLogger }));
}

function startFlush(state: Installed): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SIGNALS_BUDGET_MS + 100);
    timer.unref?.();
  });
  const work = Promise.allSettled([state.tracerProvider.forceFlush(), state.meterProvider.forceFlush(), state.loggerProvider.forceFlush()]).then(() => undefined);
  const running = Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
    if (state.inFlight === running) state.inFlight = undefined;
  });
  state.inFlight = running;
  return running;
}

/**
 * Exports pending spans, metrics, and logs, in parallel under one deadline. While a
 * flush runs, callers join the next one (started when it ends), so a record
 * written meanwhile still goes out now. Resolves within `maxWaitMs` (the
 * flush itself carries on); never rejects. With the header unset it does
 * nothing.
 */
export function flushFactorySignals(maxWaitMs: number = SIGNALS_BUDGET_MS): Promise<void> {
  const state = installed();
  if (state === undefined || !exportConfigured(process.env)) return Promise.resolve();
  let target: Promise<void>;
  if (state.inFlight === undefined) target = startFlush(state);
  else {
    state.queued ??= state.inFlight.then(() => {
      state.queued = undefined;
      return startFlush(state);
    });
    target = state.queued;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, maxWaitMs));
    timer.unref?.();
  });
  return Promise.race([target, wait]).finally(() => clearTimeout(timer));
}

/** The flushes in progress (the running one and the one queued after it), or a settled promise. */
export function factorySignalsSettled(): Promise<void> {
  const state = installed();
  return Promise.allSettled([state?.inFlight, state?.queued]).then(() => undefined);
}

/**
 * July 0.2.22 `defineOtel` rejects `exporters[].signals` that are empty
 * (`otel.js` `assertSignals`). `exportersForSignal` is
 * `signals === undefined || signals.includes(signal)`. A one-element list
 * whose `includes` is always false keeps `exporters.length > 0` so metrics
 * and logs stay on, without attaching a traces, metrics, or logs exporter.
 * 0.2.22 then builds no local provider.
 */
function noJulyExportSignals(): OtelSignal[] {
  const signals: OtelSignal[] = ["traces"];
  signals.includes = () => false;
  return signals;
}

/** The config July resolves: a dummy exporter so July opts metrics and logs on (`exporters.length > 0`) without attaching a traces, metrics, or logs exporter. 0.2.22 would otherwise keep a local provider and export through headers frozen at startServer. */
function exportConfig(input: { env: NodeJS.ProcessEnv; base: OtelConfig }): OtelConfig {
  const endpoint = otlpEndpoint(input.env);
  return {
    ...input.base,
    logs: { userPrompts: true, toolContent: true },
    exporters: [{ url: endpoint, signals: noJulyExportSignals() }],
  };
}

/**
 * The resolver agent/otel.ts passes to defineOtel. July throws when two
 * mounts in one process (local `serve --dir .`) author different OTel
 * configs, and it compares the snapshot defineOtel takes with its first call
 * of this resolver. That call returns the process-wide config, identical in
 * every agent; later calls name the slug only while this is the process's
 * one factory agent, which every hosted slug is. After startup July calls
 * it only from `flushDeferred` (runtime.js), which runs only on its memory
 * path, that is when the factory's tracer did not take the global slot
 * (`global_provider_taken`); with it, July's spans leave through
 * factorySpanExporter with exportResource and only startup calls it. On the
 * memory path July rebuilds the resource of its own spans from each flush's
 * config (`buildResource(exportConfig)`), so they still carry the slug, and
 * every later call caps the export timeouts (July builds its deferred trace
 * exporter right after) and starts a flush of the span, metric, and log
 * providers.
 */
export function factoryOtelResolver(): () => OtelConfig {
  factoryMounts().add(factorySlug);
  gateOutboundTraceContext();
  installFactorySignals();
  let snapshotTaken = false;
  return () => {
    capExportTimeouts(process.env);
    if (!snapshotTaken) {
      snapshotTaken = true;
      return exportConfig({ env: process.env, base: factoryOtelConfig({ env: process.env }) });
    }
    void flushFactorySignals();
    return exportConfig({ env: process.env, base: currentFactoryConfig(process.env) });
  };
}

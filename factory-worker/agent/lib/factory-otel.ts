import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { context, createContextKey, metrics, SpanStatusCode, trace, type Attributes, type Context, type Meter, type Span, type SpanOptions, type Tracer, type TracerProvider } from "@opentelemetry/api";
import type { HostOtelApi } from "@cursor/july";
import { instrumentedFetch, type OtelConfig } from "@cursor/july/otel";
import { factoryStage } from "./factory-stage.js";
import { factorySlug } from "./kv-keys.js";

// OpenTelemetry for the factory: the shared helpers, the resource config,
// and small spans around the work that starts no session (Jira, Slack and
// GitHub deliveries, reminders, schedules, cloud-agent launches). The export
// wiring (the resolver agent/otel.ts hands July, the trace, metric, and log
// providers, the console bridge) is lib/factory-otel-signals.ts.
//
// The switch is OTEL_EXPORTER_OTLP_HEADERS, the only secret: the endpoint is
// not secret and lives here (OTEL_EXPORTER_OTLP_ENDPOINT overrides it for a
// local collector). With the header unset nothing leaves the process and
// outbound fetch carries no trace context.
//
// Spans. July's ctx.host.otel tags session spans and records metrics but
// creates no span, and a delivery that starts no session has none to tag.
// Every span here is a NEW ROOT with a link to the inbound span July opened
// (`agent_sdk.http`), not a child of it: Cursor's backend samples few of its
// requests, the tracer's sampler is ParentBased, and a child of an unsampled
// parent is never recorded. A root is sampled on its own. The link carries
// the backend's trace and span ids, so a factory span can be joined by id to
// the backend's logs and traces; the linked `agent_sdk.http` span itself is
// in Tempo only when the backend sampled the request. A factory span started
// inside another factory span is that span's child, in the same trace, and
// so is every log written inside one (the console bridge emits in the
// active context). The spans start on the factory's tracer provider (see
// factory-otel-signals.ts), which is also the global one July's spans use
// (Bug 6b), so both are exported on a schedule the factory controls, not
// through July's in-memory buffer. Factory span notes leave as set. An
// error records its class name and its message. Metric labels stay bounded
// (`codeLike`) for cardinality only; nothing is scrubbed. With no provider
// registered every call is a no-op. July's spans (agent_sdk.*, including
// the host MCP span) keep the names, attributes, and events July gives
// them; they take the factory's sampler, ids, and export resource. The resolver turns `logs.userPrompts` and
// `logs.toolContent` on. July 0.2.18 `collector.js` then emits:
// `agent_sdk.user_prompt` on `message.received` logs only (:91-95);
// `agent_sdk.error_message` on `turn.failed` / `session.failed` logs
// only (:373-377, :404-408), gated by `toolContent` (`gatedContent`
// :625-629); `agent_sdk.tool_args` / `tool_output` on `agent_sdk.tool`
// spans; `agent_sdk.subagent_description` on `agent_sdk.subagent` spans
// (:259-261); `agent_sdk.sdk_agent_url` on open turn / tool / subagent
// spans (`agent.bound`, :77-88); turn span status text +
// `recordException` only for non-expected failures (:352-366);
// `session.failed` also sets open turn-span status (:398-403); the
// `action.result` log never carries output (:227-232). July truncates
// every content field except `agent_sdk.sdk_agent_url` at CONTENT_MAX
// 2048 + "…" (:13, :677-682). Grafana access is the only control.
//
// Randomness. Hosted v2 restores VMs from a snapshot, so a VM starts with
// whatever state its process had when the snapshot was taken. V8's
// Math.random state is part of it, and it is what OTel's default id
// generator draws from: the same span id (1101ba25...) was seen under 34
// traces and all 13 desk instances, and 77 of 571 span ids in Tempo sat
// under more than one trace. Every id the factory creates (its spans and
// `service.instance.id`) therefore comes from wakeHex: a fresh read of the
// kernel's random pool, hashed with the clocks, the pid, a counter, and a
// value that arrived with the request, at the moment of the draw, with no
// generator state kept between draws. July's own spans (agent_sdk.http,
// session turns) still use OTel's default generator; July offers no hook
// for another (docs/july-otel-upstream.md).
//
// Ticket on token usage. July's collector records `cursor.token.usage`,
// `agent_sdk.turn.count` and `cursor.tool.calls` on a
// turn's events with the session's tag bag merged in (0.2.22 `collector.js`
// `join`, `recordTokens`; 0.2.20 dropped `cursor.cost.usage`), and `ctx.host.otel.setAttributes` writes that bag
// (`host-otel.js` `setAttributes` -> `collector.setSessionAttributes`), which
// also paints the bag onto the session's open `agent_sdk.turn`, tool and
// subagent spans (`paintOpenSpans`; not phase spans) and `join` stamps it on
// every span the session starts afterwards. July dispatches an event to the
// channel's handlers and the hooks before its own collector sees it
// (`session-engine.js` `dispatchEvent`), so a `turn.started` hook that sets
// `factory.ticket.key` lands it on every metric sample of that turn, on the
// `agent_sdk.turn` span, and on every `agent_sdk.tool` span (opened at the
// tool call: on `actions.requested`, or in `runInCall` when July executes the
// tool itself) and `agent_sdk.subagent` span (opened on `subagent.called`),
// both later than the hook. The dispatch is queued
// (`queueDispatch`), and July opens the turn's first `agent_sdk.turn.<phase>`
// span synchronously after emitting `turn.started`, so that one always
// predates the hook; the later early phases (workspace, nudges,
// build_request, first_update) each open after an await and may or may not,
// depending on the hook's latency (a session pin is instant, a kv or PR
// read is not). A phase span opened before the hook settled has no key on
// a first turn and the previous turn's key on a re-tagged session; read
// those by their turn parent. Each host that
// runs model turns (desk, planner, triage, fixer, reviewer) has a
// hooks/ticket-key.ts that does that with the key its turn can know; the
// worker runs none and only counts `apj_factory.ticket.merged`.
// `tagSessionTicket` is the one way they write it, and `ticketLabel` bounds
// the value to a Jira key, `none` (no ticket yet: a desk chat before
// filing, a PR with no key in branch or title; or a kv or PR read that
// failed) or `other` (a pin that is not a Jira key). Adding this one
// attribute to July's spans and metrics through July's public API is an
// approved exception to the rule that July's spans leave as July makes
// them (docs/july-otel-upstream.md section 6, docs/factory-deployment.md);
// nothing else on July's spans or logs changes. On metrics the label is
// kept only where pricing needs it, TICKET_LABELLED_METRICS (July's token
// and turn counters and the factory's merged counter): the factory's
// meter wrapper records those instruments under `ticketLabelledContext`,
// and the View (factory-otel-signals.ts metricAttributes) drops
// `factory.ticket.key` from any sample recorded outside it, so
// `cursor.tool.calls` (40 to 60 series per ticket: the 500-per-interval cap
// at some 10 to 12 distinct tickets in one 10 s interval) and the factory's
// own `apj_factory.kv.failure`
// (whose bound host can carry any session's bag) never carry it. Cloud
// agents the worker launches run in Cursor's cloud; their usage never
// reaches a host's collector and is not here.
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs); its
// test is factory-desk's factory-otel.test.ts. Each agent's kv-keys.ts
// supplies factorySlug.

export const FACTORY_OTEL_SCOPE = "apj_factory";
export const FACTORY_SERVICE_NAMESPACE = "software-factory";
export const DELIVERY_METRIC = "apj_factory.delivery";
export const DELIVERY_DURATION_METRIC = "apj_factory.delivery.duration";
/** One per ticket the worker moved to Done on a merged PR, labelled with `factory.ticket.key`: the denominator of cost per merged ticket. */
export const TICKET_MERGED_METRIC = "apj_factory.ticket.merged";
/** The ticket label: on factory spans, on the session's July spans once a hook tagged it, and on the metrics TICKET_LABELLED_METRICS names. */
export const TICKET_KEY_ATTRIBUTE = "factory.ticket.key";
/**
 * The metrics that keep `factory.ticket.key`: July's token and turn
 * counters the cost-per-ticket estimate reads, and the factory's merged
 * counter. July 0.2.20 dropped `cursor.cost.usage`; Grafana prices from
 * tokens × $price_*. Every other instrument drops it
 * (factory-otel-signals.ts metricAttributes), whatever its sample or the
 * session's tag bag carried.
 */
export const TICKET_LABELLED_METRICS: ReadonlySet<string> = new Set(["cursor.token.usage", "agent_sdk.turn.count", TICKET_MERGED_METRIC]);
/** The label value of a turn that has no ticket yet (desk chat before filing, a PR with no key in branch or title). */
export const NO_TICKET = "none";
/** The label value of a pin that is not a Jira key; nothing else mints a series. */
export const OTHER_TICKET = "other";
/** A Jira issue key: a project key (a letter, then up to nine letters or digits), a dash, the issue number. */
export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/;
/** July 0.2.18 `hosted-execution-latency.js` `HOSTED_EXECUTION_DURATION_METRIC`. */
export const HOSTED_EXECUTION_DURATION_METRIC = "agent_sdk.hosted_execution.duration_ms";

/**
 * Bucket bounds (ms) for DELIVERY_DURATION_METRIC. The OTel default stops at
 * 10 s, so every cloud-agent launch and most background work fell in its
 * last bucket, and a dashboard p95 read as that bucket's edge.
 */
export const DELIVERY_DURATION_BUCKETS_MS: readonly number[] = [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000];

/**
 * Bucket bounds (ms) for HOSTED_EXECUTION_DURATION_METRIC. July creates the
 * histogram with no `advice.explicitBucketBoundaries`
 * (`hosted-execution-latency.js` `durationInstrument`), so the factory's
 * MeterProvider would otherwise use the OTel SDK default
 * (`HistogramAggregation.DEFAULT_INSTANCE`: 0 … 10 000 ms, 16 buckets).
 * Desk ~17.5 s, security-reviewer ~27 s, and planner ~536 s all sat in +Inf.
 * 100 ms to 30 min; denser around 10–30 s (desk / reviewer) and 5–10 min
 * (planner). The factory MeterProvider injects this advice on
 * createHistogram; the `*` View still applies the label allowlist and
 * cardinality cap. Logs and traces are not selected.
 */
export const HOSTED_EXECUTION_DURATION_BUCKETS_MS: readonly number[] = [
  100, 250, 500, 1_000, 2_500, 5_000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 180_000, 300_000, 450_000, 600_000, 900_000, 1_800_000,
];

/** The Grafana Cloud stack's OTLP gateway (<GRAFANA_STACK>, <GRAFANA_REGION>). Not a secret. */
export const GRAFANA_OTLP_ENDPOINT = "https://otlp.example.com/otlp";

/**
 * Upper bound on one OTLP request, for every signal. A pod's first request
 * opens a TLS connection to the AU gateway (about 0.9 s cold, measured on a
 * hosted VM), so the bound is about twice a cold request; later requests
 * reuse the connection and take a round trip. July's own trace export after
 * a hosted delivery is capped at this too (capExportTimeouts).
 */
export const EXPORT_TIMEOUT_MS = 2_000;

/**
 * What one delivery waits, at most, for its spans, metrics, and logs to
 * export (all three in parallel, one deadline): a little over
 * EXPORT_TIMEOUT_MS, so an export that times out reports back (and its log
 * or span batch is kept for the next one) before the wait gives up on it.
 * With July's own trace flush after it, a hosted reply waits about
 * SIGNALS_BUDGET_MS + EXPORT_TIMEOUT_MS at worst, when the collector does
 * not answer and July holds a span of its own: a session turn always
 * (`agent_sdk.turn` is a root), a sampled request, and a host MCP call made
 * inside a factory span (the Jira reads and writes of a webhook handler);
 * July keeps a span it could not send and tries again at every later flush,
 * so it pays its 2 s each time while the collector is down. A healthy
 * collector adds one round trip, or about a second on a VM's first delivery.
 *
 * Whose deadline that is. The reply is the pod's answer to the hosted
 * control plane. Slack is acked at the control plane's edge (see
 * docs/everysphere-slack-patterns.md), so on Slack the cost is the delay
 * before the model turn starts, not Slack's 3 s ack. Who answers a Jira
 * Automation webhook, and its timeout, are not established in this repo:
 * unverified. The worst case is accepted (about 4.25 s); the cap is not
 * lowered to fit a deadline nobody has measured.
 */
export const SIGNALS_BUDGET_MS = EXPORT_TIMEOUT_MS + 250;

/** `factory.background` is work a handler hands to `waitUntil` after its reply. */
export type FactorySpanName = "factory.delivery" | "factory.reminder" | "factory.schedule" | "factory.github.task" | "factory.cloud_agent.launch" | "factory.background";

/** What a span learned. Values leave as set; nothing is scrubbed. */
export type FactoryNote = { ticketKey?: string; outcome?: string; reason?: string; pr?: string; agentId?: string };

export type FactoryWork<R> = {
  span: FactorySpanName;
  /** The delivery's source and type, e.g. `jira.webhook`, `slack.app_mention`, `reminder.hop_watch`. */
  kind: string;
  ticketKey?: string;
  /** Reads the outcome off the result. Notes taken inside the work win over it. */
  describe?: (result: R) => FactoryNote | undefined | Promise<FactoryNote | undefined>;
};

const ATTRIBUTE: Record<keyof FactoryNote, string> = {
  ticketKey: TICKET_KEY_ATTRIBUTE,
  outcome: "factory.outcome",
  reason: "factory.reason",
  pr: "factory.pr",
  agentId: "factory.cloud_agent.id",
};

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,63}$/;
const FLUSH_BUDGET = createContextKey("apj_factory.otel.flushBudget");
const JULY_OUTBOUND_FETCH = Symbol.for("anysphere.july.otel.outboundFetch");
const FACTORY_OUTBOUND_FETCH = Symbol.for("apj_factory.otel.outboundFetch");
const SIGNALS = ["TRACES", "METRICS", "LOGS"] as const;
const MOUNTS = Symbol.for("apj_factory.otel.mounts");

const notes = new WeakMap<Span, FactoryNote>();
const factorySpans = new WeakSet<Span>();
const instruments = new WeakMap<Meter, { count: ReturnType<Meter["createCounter"]>; duration: ReturnType<Meter["createHistogram"]>; merged: ReturnType<Meter["createCounter"]> }>();

export function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const value: unknown = env[name];
  return typeof value === "string" ? value.trim() : "";
}

/** `OTEL_RESOURCE_ATTRIBUTES` (`k=v,k2=v2`, values percent-encoded); July 0.2.18 does not read it. */
export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "") continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The config July resolves on every flush. `slug` set: this process serves
 * one factory agent, so `service.name` is its hosted slug (`-staging` on a
 * staging slug). Unset: the process-wide config, the same for every agent.
 * OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES override when set.
 */
export function factoryOtelConfig(input: { env: NodeJS.ProcessEnv; slug?: string }): OtelConfig {
  const { env } = input;
  const stage = factoryStage(env);
  const slug = input.slug === undefined ? undefined : stage === "staging" ? `${input.slug}-staging` : input.slug;
  return {
    serviceName: envValue(env, "OTEL_SERVICE_NAME") || slug || FACTORY_SERVICE_NAMESPACE,
    resourceAttributes: {
      "service.namespace": FACTORY_SERVICE_NAMESPACE,
      "deployment.environment": stage,
      "deployment.environment.name": stage,
      ...(slug === undefined ? {} : { "factory.slug": slug }),
      ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
    },
  };
}

/** True when the OTLP auth header is set: the one switch for every signal. */
export function exportConfigured(env: NodeJS.ProcessEnv): boolean {
  return envValue(env, "OTEL_EXPORTER_OTLP_HEADERS") !== "";
}

/** The OTLP base URL: OTEL_EXPORTER_OTLP_ENDPOINT when set, else the Grafana gateway; a trailing `/v1/<signal>` is dropped. */
export function otlpEndpoint(env: NodeJS.ProcessEnv): string {
  return (envValue(env, "OTEL_EXPORTER_OTLP_ENDPOINT") || GRAFANA_OTLP_ENDPOINT).replace(/\/v1\/(traces|metrics|logs)\/?$/i, "").replace(/\/$/, "");
}

/** OTEL_EXPORTER_OTLP_HEADERS as July and the OTel SDK read it: `k=v` pairs split on `,`, each at its first `=`, values not decoded. */
export function parseOtelHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    if (key !== "") out[key] = part.slice(at + 1).trim();
  }
  return out;
}

/** Sets each OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT to EXPORT_TIMEOUT_MS unless a smaller positive value is already in force. */
export function capExportTimeouts(env: NodeJS.ProcessEnv): void {
  for (const signal of SIGNALS) {
    const name = `OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`;
    const current = Number(envValue(env, name) || envValue(env, "OTEL_EXPORTER_OTLP_TIMEOUT") || Number.NaN);
    if (!(Number.isFinite(current) && current > 0 && current <= EXPORT_TIMEOUT_MS)) env[name] = String(EXPORT_TIMEOUT_MS);
  }
}

/**
 * Takes July's place as the global fetch wrapper (once per process): its
 * `instrumentedFetch` while an endpoint is set, the plain fetch otherwise.
 * A no-op when July already wrapped fetch.
 */
export function gateOutboundTraceContext(): void {
  const slots = globalThis as Record<symbol, unknown>;
  if (slots[FACTORY_OUTBOUND_FETCH] === true || slots[JULY_OUTBOUND_FETCH] === true) return;
  slots[FACTORY_OUTBOUND_FETCH] = true;
  slots[JULY_OUTBOUND_FETCH] = true;
  const base = globalThis.fetch;
  const withContext = instrumentedFetch(base);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    exportConfigured(process.env) ? withContext(input, init) : base(input, init)) as typeof fetch;
}

/** The factory agents loaded in this process (one per hosted pod; several under a local `serve --dir .`). */
export function factoryMounts(): Set<string> {
  const holder = globalThis as { [MOUNTS]?: Set<string> };
  holder[MOUNTS] ??= new Set<string>();
  return holder[MOUNTS];
}

/**
 * Where a draw's randomness comes from. `kernel` is `length` bytes of the OS
 * pool; `ambient` is whatever else tells two VMs apart (clocks, pid, a
 * counter); `skew` is the wall clock minus the monotonic clock, in ms, which
 * steps when a paused VM resumes with its wall clock set. Tests replace all
 * three.
 */
export type WakeSources = { kernel: (length: number) => Buffer; ambient: () => string; skew: () => number };

const KERNEL_POOL = "/dev/urandom";
let wakeDraws = 0;

/** `length` bytes read straight from the kernel pool at the call, not from a generator the process seeded earlier; randomBytes only where the pool cannot be opened. */
function kernelBytes(length: number): Buffer {
  try {
    const fd = openSync(KERNEL_POOL, "r");
    try {
      const out = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, out, read, length - read, null);
        if (n <= 0) break;
        read += n;
      }
      if (read === length) return out;
    } finally {
      closeSync(fd);
    }
  } catch {
    // No readable pool (not Linux): fall through.
  }
  return randomBytes(length);
}

const LIVE_SOURCES: WakeSources = {
  kernel: kernelBytes,
  ambient: () => {
    wakeDraws += 1;
    return `${process.hrtime.bigint()}.${Date.now()}.${process.pid}.${wakeDraws}`;
  },
  skew: () => Date.now() - Number(process.hrtime.bigint() / 1_000_000n),
};

/**
 * `bytes` (1 to 32) of hex that two VMs restored from one snapshot do not
 * share: a SHA-256 over a fresh read of the kernel pool, the monotonic and
 * wall clocks, the pid, a draw counter, and `salt`. Whether a restore
 * repeats the kernel pool or a clock depends on the hypervisor, so no one of
 * them is relied on; `salt`, a value that arrived with this request, is the
 * last line when the draw is in a request. A timer's draw (a metric, log, or
 * span export) has none, which is why wakeInstanceId holds its draw for a
 * call that does. Not for secrets.
 */
export function wakeHex(input: { bytes: number; salt?: string; sources?: WakeSources }): string {
  const sources = input.sources ?? LIVE_SOURCES;
  const hash = createHash("sha256");
  hash.update("apj_factory.wake\0");
  hash.update(sources.kernel(32));
  hash.update(`\0${sources.ambient()}\0${input.salt ?? ""}`);
  return hash.digest("hex").slice(0, 2 * Math.min(32, Math.max(1, Math.trunc(input.bytes))));
}

/** The active inbound span's ids as a salt: Cursor's backend made them for this request, so no two requests share them. */
export function requestSalt(): string | undefined {
  const inbound = trace.getSpanContext(context.active());
  return inbound !== undefined && trace.isSpanContextValid(inbound) ? `${inbound.traceId}.${inbound.spanId}` : undefined;
}

/** A version-4 shaped UUID from 16 bytes of hex. */
function uuidOf(hex: string): string {
  const bytes = Buffer.from(hex, "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const text = bytes.toString("hex");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/**
 * A step in wall minus monotonic clock, between two looks at it, that counts
 * as a pause and resume of the VM. A slewing clock moves far less than this
 * in the hour between two deliveries.
 */
export const RESTORE_SKEW_MS = 5_000;

type Life = { id: string; skew: number; stale: boolean };
const LIFE = Symbol.for("apj_factory.otel.life");

function noteInstanceId(reason: string): void {
  try {
    console.info(JSON.stringify({ otel: "instance_id", reason }));
  } catch {
    // Telemetry never changes a delivery.
  }
}

/**
 * `service.instance.id`: one id per life of the process after a restore,
 * the same on every signal. A VM's cumulative counters then are a series of
 * its own, which no other VM overwrites.
 *
 * Drawn lazily, on the first call with the export header set, with wakeHex.
 * Hosting binds the header per request, after the restore, and a snapshot
 * never has one, so the first draw is after the restore: an id drawn at
 * import would be in the snapshot, and every VM would share it.
 *
 * Drawn again when the wall clock steps against the monotonic one by more
 * than RESTORE_SKEW_MS since the last look: a VM paused with its id already
 * drawn (a snapshot taken after a delivery) and resumed with its wall clock
 * set. The first call after a resume is often a timer's export, which has no
 * request to take a salt from, and two clones that resumed alike could draw
 * alike; so the id is then marked stale and kept until the next call that
 * has a salt (a delivery's inbound span ids), which draws the new one. The
 * same goes for a first draw that had no salt. Until then the exports of a
 * clone carry the id it woke with.
 *
 * This is a best-effort check. A restore that sets no clock, or a pause
 * shorter than RESTORE_SKEW_MS, is not seen, and the clones share the id and
 * overwrite each other's counters (docs/factory-deployment.md, section 11).
 * And whether a hosted VM resumes in place, with its wall clock set, or is
 * restored into a new process has not been measured: if it resumes in place,
 * every pause over RESTORE_SKEW_MS starts a new series. Each draw writes one
 * `{"otel":"instance_id","reason":…}` line, so a week of logs shows which.
 * The counters keep running across an id change, so factoryMetricExporter
 * rebases each new life's counters to start near zero (factory-otel-rebase.ts;
 * the cases it leaves are in docs/factory-deployment.md, section 11).
 */
export function wakeInstanceId(input: { sources?: WakeSources } = {}): string {
  const sources = input.sources ?? LIVE_SOURCES;
  const holder = globalThis as { [LIFE]?: Life };
  const skew = sources.skew();
  const salt = requestSalt();
  const life = holder[LIFE];
  const draw = (reason: string): string => {
    const id = uuidOf(wakeHex({ bytes: 16, sources, ...(salt === undefined ? {} : { salt }) }));
    holder[LIFE] = { id, skew, stale: salt === undefined };
    noteInstanceId(reason);
    return id;
  };
  if (life === undefined) return draw(salt === undefined ? "first_unsalted" : "first");
  const stepped = Math.abs(skew - life.skew) > RESTORE_SKEW_MS;
  if (salt === undefined) {
    if (stepped && !life.stale) noteInstanceId("skew_pending");
    life.skew = skew;
    life.stale ||= stepped;
    return life.id;
  }
  if (stepped) return draw("skew_step");
  if (life.stale) return draw("salted_after_unsalted");
  life.skew = skew;
  return life.id;
}

/** The instance id if one has been drawn, without drawing one. */
export function drawnInstanceId(): string | undefined {
  return (globalThis as { [LIFE]?: Life })[LIFE]?.id;
}

/**
 * factoryOtelConfig naming this agent's slug while it is the process's only
 * factory agent: the resource every signal is exported with. With the
 * export header set (an export is about to run) it also carries
 * `service.instance.id`, drawn on first use (wakeInstanceId); an id in
 * OTEL_RESOURCE_ATTRIBUTES wins, and then none is drawn.
 */
export function currentFactoryConfig(env: NodeJS.ProcessEnv): OtelConfig {
  const config = factoryOtelConfig({ env, ...(factoryMounts().size === 1 ? { slug: factorySlug } : {}) });
  if (!exportConfigured(env) || config.resourceAttributes?.["service.instance.id"] !== undefined) return config;
  return { ...config, resourceAttributes: { ...config.resourceAttributes, "service.instance.id": wakeInstanceId() } };
}

/** A cardinality bound for metric labels: charset, length, and randomish.
 * Span notes do not use this; nothing is scrubbed. */
export function codeLike(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || !CODE.test(value)) return undefined;
  // A long or digit-bearing random-looking run would mint a series per token.
  const randomish = value.split(/[_.:/#-]/).some((part) => part.length >= 24 || (part.length >= 16 && /\d/.test(part)));
  return randomish ? undefined : value;
}

export function isJiraIssueKey(value: unknown): value is string {
  return typeof value === "string" && JIRA_ISSUE_KEY.test(value);
}

/**
 * The `factory.ticket.key` metric label for a turn: the Jira key itself,
 * NO_TICKET when the turn has none (undefined, empty, or `none`), and
 * OTHER_TICKET for any other string. One series per Jira key, two fixed
 * values, nothing per request.
 */
export function ticketLabel(key: unknown): string {
  if (key === undefined || key === null || key === "" || key === NO_TICKET) return NO_TICKET;
  return isJiraIssueKey(key) ? key : OTHER_TICKET;
}

const TICKET_LABELLED = createContextKey("apj_factory.otel.ticketLabelled");

/**
 * The context a sample of one of TICKET_LABELLED_METRICS is recorded under
 * (factory-otel-signals.ts, the meter wrapper's counter for those names).
 * The metric View keeps `factory.ticket.key` only on a sample recorded in
 * it, so the label can reach no other instrument, whatever attributes a
 * caller or a session's tag bag carries.
 */
export function ticketLabelledContext(base: Context = context.active()): Context {
  return base.setValue(TICKET_LABELLED, true);
}

export function isTicketLabelled(ctx: Context | undefined): boolean {
  return ctx?.getValue(TICKET_LABELLED) === true;
}

/**
 * Tags the session so July's collector puts `factory.ticket.key` on the
 * metric samples it records for it (kept on TICKET_LABELLED_METRICS; the
 * View drops it elsewhere) and paints it on the session's open July spans.
 * Call it from a `turn.started` hook, before the collector sees the turn's
 * events; a later call (a desk turn that files the ticket mid-turn)
 * overwrites the value for the samples recorded after it. Never throws; the
 * tag is written through `ctx.host.otel`, which July binds to the session.
 */
export function tagSessionTicket(host: { otel: Pick<HostOtelApi, "setAttributes"> }, key: unknown): string {
  const label = ticketLabel(key);
  try {
    host.otel.setAttributes({ [TICKET_KEY_ATTRIBUTE]: label });
  } catch {
    // Telemetry never changes a turn.
  }
  return label;
}

/** Counts one merged ticket under its key; a key that is not a Jira key counts as OTHER_TICKET. Never throws. */
export function countTicketMerged(ticketKey: string): void {
  try {
    factoryInstruments().merged.add(1, { [TICKET_KEY_ATTRIBUTE]: ticketLabel(ticketKey) });
  } catch {
    // A metric is optional.
  }
}

function attributesOf(note: FactoryNote): Attributes {
  const out: Attributes = {};
  for (const [field, value] of Object.entries(note) as [keyof FactoryNote, string | undefined][]) {
    if (value !== undefined) out[ATTRIBUTE[field]] = value;
  }
  return out;
}

/** Tags the active span (a factory span when inside one). Never throws; a no-op with no provider. */
export function noteFactory(note: FactoryNote): void {
  try {
    const span = trace.getActiveSpan();
    if (span === undefined || !span.isRecording()) return;
    span.setAttributes(attributesOf(note));
    const held = notes.get(span);
    if (held !== undefined) Object.assign(held, note);
  } catch {
    // Telemetry never changes a delivery.
  }
}

function errorNote(error: unknown): { type: string; reason?: string; message?: string } {
  const named = typeof error === "object" && error !== null ? (error as { name?: unknown; reason?: unknown; message?: unknown; constructor?: { name?: unknown } }) : undefined;
  const type =
    (typeof named?.name === "string" && named.name !== "" ? named.name : undefined) ??
    (typeof named?.constructor?.name === "string" && named.constructor.name !== "" ? named.constructor.name : undefined) ??
    typeof error;
  const reason = typeof named?.reason === "string" ? named.reason : undefined;
  const message = typeof named?.message === "string" ? named.message : typeof error === "string" ? error : undefined;
  return { type, ...(reason === undefined ? {} : { reason }), ...(message === undefined ? {} : { message }) };
}

function factoryInstruments(): NonNullable<ReturnType<typeof instruments.get>> {
  const meter = metrics.getMeter(FACTORY_OTEL_SCOPE);
  let held = instruments.get(meter);
  if (held === undefined) {
    held = {
      count: meter.createCounter(DELIVERY_METRIC, { description: "Factory deliveries, reminders, schedules and launches by kind and outcome" }),
      duration: meter.createHistogram(DELIVERY_DURATION_METRIC, {
        description: "Factory work duration",
        unit: "ms",
        advice: { explicitBucketBoundaries: [...DELIVERY_DURATION_BUCKETS_MS] },
      }),
      merged: meter.createCounter(TICKET_MERGED_METRIC, { description: "Tickets moved to Done on a merged pull request, by ticket key" }),
    };
    instruments.set(meter, held);
  }
  return held;
}

function recordMetrics(input: { work: { span: FactorySpanName; kind: string }; outcome: string; ms: number }): void {
  try {
    const held = factoryInstruments();
    const labels = { "factory.span": input.work.span, "factory.delivery.kind": input.work.kind, "factory.outcome": input.outcome };
    held.count.add(1, labels);
    held.duration.record(input.ms, labels);
  } catch {
    // A metric is optional.
  }
}

/** Exports pending spans, metrics, and logs; resolves within `maxWaitMs` and never rejects. */
type SignalFlush = (maxWaitMs: number) => Promise<void>;
type FlushBudget = { deadline?: number };
let signalFlush: SignalFlush | undefined;

/** lib/factory-otel-signals.ts hands traceFactory its span, metric, and log flush. */
export function registerSignalFlush(flush: SignalFlush): void {
  signalFlush = flush;
}

let tracerProvider: TracerProvider | undefined;

/** lib/factory-otel-signals.ts hands the factory its own tracer provider; with none registered, spans start on the global one. */
export function registerFactoryTracerProvider(provider: TracerProvider | undefined): void {
  tracerProvider = provider;
}

function factoryTracer(): Tracer {
  return (tracerProvider ?? trace.getTracerProvider()).getTracer(FACTORY_OTEL_SCOPE);
}

/**
 * A factory span inside another factory span is that span's child, in its
 * trace. Any other starts a new root, linked to the span active now (July's
 * `agent_sdk.http`, the inbound request) when that has a valid context.
 */
function startOptions(attributes: Attributes): SpanOptions {
  const active = trace.getActiveSpan();
  if (active !== undefined && factorySpans.has(active)) return { attributes };
  const inbound = trace.getSpanContext(context.active());
  return { attributes, root: true, ...(inbound !== undefined && trace.isSpanContextValid(inbound) ? { links: [{ context: inbound }] } : {}) };
}

/** Waits for the span, metric, and log flush within this delivery's budget, which starts at the delivery's first wait. */
async function flushWithinBudget(budget: FlushBudget): Promise<void> {
  if (signalFlush === undefined) return;
  budget.deadline ??= Date.now() + SIGNALS_BUDGET_MS;
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) return;
  try {
    await signalFlush(remaining);
  } catch {
    // Telemetry never changes a delivery.
  }
}

/**
 * Runs `run` inside one factory span and returns its result unchanged; a
 * throw is recorded and rethrown. A factory span whose parent factory span
 * has ended (a handler, a reminder, a schedule, or work a handler handed to
 * `waitUntil` that ends after it) then waits for the span, metric, and log
 * flush, all of them in one delivery sharing one SIGNALS_BUDGET_MS budget,
 * carried in the OTel context. The span has ended by then, so the flush
 * carries it.
 */
export async function traceFactory<R>(work: FactoryWork<R>, run: () => R | Promise<R>): Promise<R> {
  try {
    // The wake's first delivery draws the instance id here, salted with this request's inbound span.
    currentFactoryConfig(process.env);
  } catch {
    // Telemetry never changes a delivery.
  }
  const parent = trace.getActiveSpan();
  const active = context.active();
  const budget = (active.getValue(FLUSH_BUDGET) as FlushBudget | undefined) ?? {};
  try {
    return await context.with(active.setValue(FLUSH_BUDGET, budget), () => spanned(work, run));
  } finally {
    // A parent factory span still open flushes when it ends; work that outlives its parent flushes now.
    if (parent === undefined || !notes.has(parent)) await flushWithinBudget(budget);
  }
}

async function spanned<R>(work: FactoryWork<R>, run: () => R | Promise<R>): Promise<R> {
  const kind = typeof work.kind === "string" && work.kind !== "" ? work.kind : "unknown";
  const metricKind = codeLike(work.kind) ?? "unknown";
  const ticket = typeof work.ticketKey === "string" ? work.ticketKey : undefined;
  const attributes = { "factory.delivery.kind": kind, ...(ticket === undefined ? {} : { [ATTRIBUTE.ticketKey]: ticket }) };
  return factoryTracer().startActiveSpan(work.span, startOptions(attributes), async (span) => {
    factorySpans.add(span);
    const started = Date.now();
    const held: FactoryNote = ticket === undefined ? {} : { ticketKey: ticket };
    if (span.isRecording()) notes.set(span, held);
    try {
      const result = await run();
      let outcome = held.outcome;
      if (span.isRecording()) {
        let described: FactoryNote = {};
        try {
          described = (await work.describe?.(result)) ?? {};
        } catch {
          described = {};
        }
        const merged = { ...described, ...held };
        outcome = merged.outcome ?? "ok";
        span.setAttributes(attributesOf({ ...merged, outcome }));
        span.setStatus({ code: SpanStatusCode.OK });
      }
      recordMetrics({ work: { span: work.span, kind: metricKind }, outcome: codeLike(outcome ?? "ok") ?? "other", ms: Date.now() - started });
      return result;
    } catch (error) {
      const failed = errorNote(error);
      const outcome = held.outcome ?? "error";
      if (span.isRecording()) {
        span.setAttributes({
          ...attributesOf({ ...held, outcome, ...(held.reason === undefined && failed.reason !== undefined ? { reason: failed.reason } : {}) }),
          "error.type": failed.type,
          ...(failed.message === undefined ? {} : { "error.message": failed.message }),
        });
        span.setStatus({ code: SpanStatusCode.ERROR, ...(failed.message === undefined ? {} : { message: failed.message }) });
      }
      recordMetrics({ work: { span: work.span, kind: metricKind }, outcome: codeLike(outcome) ?? "other", ms: Date.now() - started });
      throw error;
    } finally {
      notes.delete(span);
      span.end();
    }
  });
}

type Handler = (...args: never[]) => unknown;

/**
 * `handler` wrapped in traceFactory; arguments and result pass through. It
 * keeps the handler's type, and the wrapper always returns a promise. A
 * channel route handler annotates its parameters: July infers the body type
 * from `bodySchema` in the same call, so none reach an inline wrapped arrow.
 */
export function traced<H extends Handler>(work: FactoryWork<Awaited<ReturnType<H>>>, handler: H): H {
  const run = handler as unknown as (...args: unknown[]) => Awaited<ReturnType<H>> | Promise<Awaited<ReturnType<H>>>;
  return ((...args: unknown[]) => traceFactory(work, () => run(...args))) as unknown as H;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The outcome of a channel route's JSON reply: the ticket (`issueKey` or
 * `identifier`), `reason`, `bcId`, and one outcome word. Only these fields
 * are read; a reply's `message` is not copied onto the span.
 */
export async function describeResponse(response: Response): Promise<FactoryNote> {
  const status = response.status;
  let body: Record<string, unknown> = {};
  if ((response.headers.get("content-type") ?? "").includes("json")) {
    try {
      body = record(await response.clone().json());
    } catch {
      body = {};
    }
  }
  const kind = typeof body["kind"] === "string" && body["kind"] !== "" ? body["kind"] : undefined;
  const outcome =
    status >= 400
      ? `http_${status}`
      : body["ignored"] === true
        ? "ignored"
        : body["duplicate"] === true
          ? "duplicate"
          : body["launching"] === true
            ? "launching"
            : body["launched"] === false
              ? "not_launched"
              : body["started"] === false
                ? "not_started"
                : body["jevOnly"] === true
                  ? "jev_only"
                  : typeof body["skipped"] === "string" || body["skipped"] === true
                    ? "skipped"
                    : (kind ?? (body["started"] === true ? "started" : "accepted"));
  const ticketKey = typeof body["issueKey"] === "string" ? body["issueKey"] : typeof body["identifier"] === "string" ? body["identifier"] : undefined;
  const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
  const agentId = typeof body["bcId"] === "string" ? body["bcId"] : undefined;
  return {
    outcome,
    ...(ticketKey === undefined ? {} : { ticketKey }),
    ...(reason === undefined ? {} : { reason }),
    ...(agentId === undefined ? {} : { agentId }),
  };
}

/** A GitHub hook's decision: `skipped` (null), `task` (host work), or `turn` (a session). */
export function describeDispatch(dispatch: unknown): FactoryNote {
  if (dispatch === null || dispatch === undefined) return { outcome: "skipped" };
  const fields = record(dispatch);
  if (typeof fields["task"] === "function") return { outcome: "task" };
  return { outcome: "auth" in fields ? "turn" : "dispatched" };
}

function prOf(args: readonly unknown[]): string | undefined {
  const ctx = record(args[0]);
  const repo = record(ctx["repository"])["fullName"];
  const payload = record(args[1]);
  const number = typeof payload["number"] === "number" ? payload["number"] : record(ctx["conversation"])["number"];
  if (typeof repo !== "string") return undefined;
  return typeof number === "number" && number > 0 ? `${repo}#${number}` : repo;
}

/**
 * A githubChannel hook in a `factory.delivery` span tagged with the PR, and
 * a returned `{ task }` in its own `factory.github.task` span, since July
 * runs the task after the hook returns.
 */
export function tracedGithubHook<H extends Handler>(kind: string, hook: H): H {
  const call = hook as unknown as (...args: unknown[]) => unknown;
  return ((...args: unknown[]) => {
    const pr = prOf(args);
    return traceFactory({ span: "factory.delivery", kind, describe: describeDispatch }, async () => {
      if (pr !== undefined) noteFactory({ pr });
      const delivery: Context = context.active();
      const dispatch = await call(...args);
      const task = record(dispatch)["task"];
      if (typeof task !== "function") return dispatch;
      const run = task as (...taskArgs: unknown[]) => unknown;
      return {
        ...(dispatch as object),
        // In the hook's context: the task's span joins the delivery's trace and its flush budget.
        task: (...taskArgs: unknown[]) =>
          context.with(delivery, () =>
            traceFactory({ span: "factory.github.task", kind }, async () => {
              if (pr !== undefined) noteFactory({ pr });
              await run(...taskArgs);
            })
          ),
      };
    });
  }) as unknown as H;
}

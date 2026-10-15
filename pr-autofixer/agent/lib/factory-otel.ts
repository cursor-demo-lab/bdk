import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { context, metrics, SpanStatusCode, trace, type Attributes, type Context, type Meter, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api";
import type { HostOtelApi } from "@cursor/july";
import type { OtelConfig } from "@cursor/july/otel";
import { factoryStage } from "./factory-stage.js";
import { factorySlug } from "./kv-keys.js";

// OpenTelemetry for the factory, on July's own setup for all three signals.
// July builds the tracer, meter, and logger providers and their OTLP exporters
// from the config agent/otel.ts hands it (factoryOtelConfig), registers them
// globally, and flushes them after each hosted delivery. This file holds no
// provider: the config, the helpers, and small spans and counters around work
// that starts no session (Jira, Slack and GitHub deliveries, reminders,
// schedules, cloud-agent launches), all through the global @opentelemetry/api.
//
// The switch is OTEL_EXPORTER_OTLP_HEADERS, the only secret: the endpoint is
// not secret and lives here (OTEL_EXPORTER_OTLP_ENDPOINT overrides it for a
// local collector). With the header unset the config has no exporter, July
// builds no provider, and nothing leaves the process. A hosted pod binds the
// secret per request; July re-reads the config after its secrets load.
//
// Spans. July's ctx.host.otel tags session spans and records metrics but
// creates no span, and a delivery that starts no session has none to tag.
// Every span here is a NEW ROOT with a link to the inbound span July opened
// (`agent_sdk.http`), not a child of it: Cursor's backend samples few of its
// requests, July's sampler is parent-based, and a child of an unsampled
// parent is never recorded. A root is sampled on its own, and the link
// carries the backend's ids so a factory span can be joined to the backend's
// logs and traces. A factory span started inside another is that span's
// child, and so is every log written inside one (the console bridge emits in
// the active context). Span notes leave as set; an error records its class
// name and message. Metric labels are bounded (`codeLike`) for cardinality
// only; nothing is scrubbed. Before July builds its providers (a hosted pod's
// first request) every call here is a no-op.
//
// Ticket on token usage. July's collector records `cursor.token.usage`,
// `agent_sdk.turn.count`, and `cursor.tool.calls` with the session's tag bag
// merged in (collector.js `join`). `ctx.host.otel.setAttributes` writes that
// bag, paints it onto the session's open `agent_sdk.turn`, tool, and subagent
// spans (`paintOpenSpans`), and `join` stamps it on every span and metric
// sample the session records afterwards. July runs hooks before its own
// collector sees an event (session-engine.js `dispatchEvent`), so a
// `turn.started` hook that calls tagSessionTicket puts `factory.ticket.key`
// on the turn's metric samples and on its turn, tool, and subagent spans. A
// phase span (`agent_sdk.turn.<phase>`) that opened before the hook settled
// has no key on a first turn; read those by their turn parent.
// `ticketLabel` bounds the value to a Jira key, `none` (no ticket yet) or
// `other` (a pin that is not a Jira key). tagSessionTicket is the one place
// the key is attached; the dashboards read the attribute, not the call.
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
/** The ticket label: on factory spans, and on the session's July spans and metric samples once a hook tagged it. */
export const TICKET_KEY_ATTRIBUTE = "factory.ticket.key";
/** The label value of a turn that has no ticket yet (desk chat before filing, a PR with no key in branch or title). */
export const NO_TICKET = "none";
/** The label value of a pin that is not a Jira key; nothing else mints a series. */
export const OTHER_TICKET = "other";
/** A Jira issue key: a project key (a letter, then up to nine letters or digits), a dash, the issue number. */
export const JIRA_ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/;

/** Bucket bounds (ms) for DELIVERY_DURATION_METRIC. The OTel default stops at 10 s, which would put every cloud-agent launch and most background work in its last bucket. */
export const DELIVERY_DURATION_BUCKETS_MS: readonly number[] = [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000];

/** The Grafana Cloud stack's OTLP gateway (<GRAFANA_STACK>, <GRAFANA_REGION>). Not a secret. */
export const GRAFANA_OTLP_ENDPOINT = "https://otlp.example.com/otlp";

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

const notes = new WeakMap<Span, FactoryNote>();
const factorySpans = new WeakSet<Span>();
const LIFE = Symbol.for("apj_factory.otel.life");
const instruments = new WeakMap<Meter, { count: ReturnType<Meter["createCounter"]>; duration: ReturnType<Meter["createHistogram"]>; merged: ReturnType<Meter["createCounter"]> }>();

export function envValue(env: NodeJS.ProcessEnv, name: string): string {
  const value: unknown = env[name];
  return typeof value === "string" ? value.trim() : "";
}

/** True when the OTLP auth header is set: the one switch for every signal. */
export function exportConfigured(env: NodeJS.ProcessEnv): boolean {
  return envValue(env, "OTEL_EXPORTER_OTLP_HEADERS") !== "";
}

/** The OTLP base URL: OTEL_EXPORTER_OTLP_ENDPOINT when set, else the Grafana gateway; a trailing `/v1/<signal>` is dropped. */
export function otlpEndpoint(env: NodeJS.ProcessEnv): string {
  return (envValue(env, "OTEL_EXPORTER_OTLP_ENDPOINT") || GRAFANA_OTLP_ENDPOINT).replace(/\/v1\/(traces|metrics|logs)\/?$/i, "").replace(/\/$/, "");
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

/**
 * This process life's `service.instance.id`, drawn on first use. Hosted v2
 * restores each VM of a slug from one snapshot, so anything the process holds
 * at the freeze is shared by every clone: the id is drawn from a fresh read of
 * the kernel pool hashed with the clocks and pid (crypto.randomUUID() would
 * repeat across clones for the 128 UUIDs Node batches), and only once the
 * header binds, which is after the snapshot.
 */
export function lifeId(): string {
  const holder = globalThis as { [LIFE]?: string };
  holder[LIFE] ??= createHash("sha256").update(kernelBytes()).update(`${process.hrtime.bigint()}.${Date.now()}.${process.pid}`).digest("hex").slice(0, 32);
  return holder[LIFE];
}

/**
 * The OTel config July resolves (agent/otel.ts), at startup and again after
 * each hosted secrets load. One exporter for traces, metrics, and logs,
 * present only while the auth header is set; July reads the header from the
 * env itself. Its metric exporters are cumulative, as Grafana Cloud needs,
 * through the temporality env var agent/otel.ts defaults.
 * `service.name` is this agent's hosted slug (`-staging` on a staging
 * stage), so the six services stay apart; a local `serve --dir .` mounts all
 * six in one process, which July only allows with one config, so off managed
 * hosting (AGENT_SERVE_GENERATION unset) every agent says `software-factory`.
 * OTEL_SERVICE_NAME overrides. July builds its resource from this config only
 * and never reads OTEL_RESOURCE_ATTRIBUTES (otel/runtime.js:269-284), so the
 * namespace and the stage are set here.
 * `service.instance.id` is in the config only while the header is set, and is
 * one per process life: July's resource has none, and cumulative series of
 * several VMs of one slug that share one overwrite each other. It reaches the
 * traces and logs resource too. July builds its providers from the first
 * config with an exporter, so the id is stable from then on.
 * `logs` turns July's logs on (off by default, otel/config.js:219-226) with its
 * prompt and tool content in log records and tool spans (truncated at 2048
 * characters); Grafana access is the only control.
 */
export function factoryOtelConfig(env: NodeJS.ProcessEnv): OtelConfig {
  const hosted = envValue(env, "AGENT_SERVE_GENERATION") !== "";
  const stage = factoryStage(env);
  const slug = stage === "staging" ? `${factorySlug}-staging` : factorySlug;
  const exporting = exportConfigured(env);
  return {
    serviceName: envValue(env, "OTEL_SERVICE_NAME") || (hosted ? slug : FACTORY_SERVICE_NAMESPACE),
    resourceAttributes: {
      "service.namespace": FACTORY_SERVICE_NAMESPACE,
      "deployment.environment": stage,
      "deployment.environment.name": stage,
      ...(hosted ? { "factory.slug": slug } : {}),
      ...(exporting ? { "service.instance.id": lifeId() } : {}),
    },
    exporters: exporting ? [{ url: otlpEndpoint(env) }] : [],
    logs: { userPrompts: true, toolContent: true },
  };
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
 * The `factory.ticket.key` value for a turn: the Jira key itself, NO_TICKET
 * when the turn has none (undefined, empty, or `none`), and OTHER_TICKET for
 * any other string. One value per Jira key, two fixed values, nothing per
 * request.
 */
export function ticketLabel(key: unknown): string {
  if (key === undefined || key === null || key === "" || key === NO_TICKET) return NO_TICKET;
  return isJiraIssueKey(key) ? key : OTHER_TICKET;
}

/**
 * Tags the session so July puts `factory.ticket.key` on the metric samples and
 * spans it records for it. Call it from a `turn.started` hook, before the
 * collector sees the turn's events; a later call (a desk turn that files the
 * ticket mid-turn) overwrites the value for what is recorded after it. Never
 * throws; the tag is written through `ctx.host.otel`, which July binds to the
 * session.
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

/** Looked up per call: the global meter is a no-op until July builds its provider, and instruments made on it stay no-ops, so they are cached per meter. */
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

function factoryTracer(): Tracer {
  return trace.getTracer(FACTORY_OTEL_SCOPE);
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

/** Runs `run` inside one factory span and returns its result unchanged; a throw is recorded and rethrown. */
export async function traceFactory<R>(work: FactoryWork<R>, run: () => R | Promise<R>): Promise<R> {
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
        // In the hook's context: the task's span joins the delivery's trace.
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

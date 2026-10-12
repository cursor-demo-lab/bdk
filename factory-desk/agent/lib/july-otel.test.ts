import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { format } from "node:util";
import type { HostOtelApi } from "@cursor/july";
import { context, diag, DiagLogLevel, trace, TraceFlags, type Meter } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import { AggregationTemporality, InstrumentType, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { drawnInstanceId, EXPORT_TIMEOUT_MS, SIGNALS_BUDGET_MS, tagSessionTicket, TICKET_KEY_ATTRIBUTE, traceFactory } from "./factory-otel.js";
import { factoryMetricExporter, factorySignalsSettled, flushFactorySignals } from "./factory-otel-signals.js";
import { createOpsFunnel } from "./ops-funnel.js";

// Characterizes the @cursor/july 0.2.22 OTel internals agent/otel.ts depends
// on (docs/factory-deployment.md section 11), through July's real runtime and
// this agent's real agent/otel.ts, against a local collector given as the
// endpoint at startup, as the code's Grafana endpoint is on a hosted pod:
// - with no OTLP header at startup (a hosted pod before its secrets bind)
//   July turns traces, metrics, and logs on and takes the factory's global
//   tracer, meter, and logger instead of its own, so it records no span in
//   memory (Bug 6b);
// - with the header never set, a flush contacts nothing;
// - with the header set after startup, a delivery's factory spans, metrics,
//   and logs are sent before the delivery returns, that is before the hosted
//   reply, and July's own spans go through the factory's exporter: those that
//   end inside the delivery's factory span in the same POST, those that end
//   after it (agent_sdk.http) at the next factory flush; July's forceFlush
//   sends none. Every POST carries the header, service.name=factory-desk, and this
//   process's service.instance.id. Logs keep the original body and every
//   attribute (no factory redaction). Traces and metrics still do not carry
//   a later console Error argument (that mark is on logs only), derived
//   log fields, or the collector auth string;
// - under an inbound request the backend did not sample (96% of them)
//   agent_sdk.http is not recorded, and the factory's span is: a new root, in
//   a trace of its own, linked to the inbound span, that outbound fetches and
//   the logs written inside it carry;
// - July's host MCP spans (runMcpClientSpan) follow the active span: under
//   that unsampled request, outside a factory span, they are not recorded;
//   inside one they are, as children of the factory span, and leave with it.
//   Session turns (agent_sdk.turn) start from the root context and are
//   always recorded (july-otel.turn-end.test.ts drives them);
// - work started inside a delivery that ends after it (waitUntil) is
//   exported by its own flush, joined to the delivery's trace;
// - July labels metrics with session ids; the factory's View drops them, so
//   the series count stays flat across sessions, and keeps the phases of
//   agent_sdk.hosted_execution.duration_ms apart;
// - the exporters keep one connection until the header changes;
// - a span (July's included) or log batch is dropped after a 401 and
//   retried after a timeout;
// - with a collector that never answers, the factory's wait is at most
//   SIGNALS_BUDGET_MS and July's flush adds nothing, a July span to send or
//   not;
// - outbound fetch carries `traceparent` only while the header is set.
// July's runtime is internal (no package export), so it is loaded by path.
// When an upgrade fails one of these, July changed that behaviour: recheck
// agent/otel.ts, lib/factory-otel-signals.ts, and the runbook before
// changing the test.

for (const name of Object.keys(process.env)) if (name.startsWith("OTEL_")) delete process.env[name];

type Hit = { path: string; authorization: string | undefined; rotated: string | undefined; traceparent: string | undefined; body: Buffer };
type Mode = "ok" | "unauthorized" | "unavailable" | "hang";

const hits: Hit[] = [];
const hung: ServerResponse[] = [];
let connections = 0;
let mode: Mode = "ok";
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined);
    hits.push({ path: req.url ?? "", authorization: header("authorization"), rotated: header("x-rotated"), traceparent: header("traceparent"), body: Buffer.concat(chunks) });
    if (req.url?.startsWith("/otlp/") === true && mode === "hang") {
      hung.push(res);
      return;
    }
    const otlp = req.url?.startsWith("/otlp/") === true;
    res.writeHead(otlp && mode === "unauthorized" ? 401 : otlp && mode === "unavailable" ? 503 : 200, { "content-type": "application/x-protobuf" });
    res.end();
  });
});
server.on("connection", () => void (connections += 1));
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const AUTH = `Basic ${Buffer.from("123456:glc_FAKE_CHARACTERIZATION").toString("base64")}`;
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${base}/otlp`;

type JulyConfig = { enabled: boolean; exporters: { signals?: string[] }[]; traces: unknown; metrics: unknown; logs: unknown };
type JulyRuntime = { forceFlush(): Promise<void>; meter?: Meter; logger?: Logger };
const july = (file: string) => new URL(`../../node_modules/@cursor/july/dist/internal/otel/${file}`, import.meta.url).href;
const { resolveOtelConfig, exportersForSignal } = (await import(july("config.js"))) as {
  resolveOtelConfig: (input: { authored: unknown }) => JulyConfig;
  exportersForSignal: (exporters: JulyConfig["exporters"], signal: "traces" | "metrics" | "logs") => unknown[];
};
const { createOtelRuntime } = (await import(july("runtime.js"))) as {
  createOtelRuntime: (config: unknown, log: (line: string) => void, options: { resolveExport: () => unknown }) => JulyRuntime | undefined;
};
const { runMcpClientSpan } = (await import(july("mcp.js"))) as {
  runMcpClientSpan: (args: { method: string; toolName?: string; connection?: string }, fn: () => Promise<unknown>) => Promise<unknown>;
};
const { createOtelCollector } = (await import(july("collector.js"))) as {
  createOtelCollector: (
    runtime: JulyRuntime,
    agentName: string,
    log: (line: string) => void,
  ) => { onEvent(event: Record<string, unknown>, session: Record<string, unknown>): void; close(): void };
};
const hostOtel = new URL("../../node_modules/@cursor/july/dist/internal/host-otel.js", import.meta.url).href;
const { createHostOtelApi } = (await import(hostOtel)) as {
  createHostOtelApi: (options: { agentName: string; meter?: Meter; collector?: unknown; sessionId?: string }) => Pick<HostOtelApi, "enabled" | "increment" | "setAttributes">;
};
const { default: authored } = (await import("../otel.js")) as { default: unknown };

/** July's `startOtelSdk` (`runtime.js` :93-99): OTel diag goes to `console.log`. */
function julyDiagToConsole(): void {
  diag.setLogger(
    {
      verbose: (message) => console.log(`[bdk:otel] ${message}`),
      debug: (message) => console.log(`[bdk:otel] ${message}`),
      info: (message) => console.log(`[bdk:otel] ${message}`),
      warn: (message) => console.log(`[bdk:otel] warn: ${message}`),
      error: (message) => console.log(`[bdk:otel] error: ${message}`),
    },
    DiagLogLevel.ERROR,
  );
}

const julyLog: string[] = [];
const resolveExport = () => resolveOtelConfig({ authored });
const bake = resolveExport();
const runtime = createOtelRuntime(bake, (line) => julyLog.push(line), { resolveExport });

function otlpPosts(path?: string): Hit[] {
  return hits.filter((hit) => hit.path.startsWith(path ?? "/otlp/"));
}

function latest(path: string): string {
  const posts = otlpPosts(path);
  assert.ok(posts.length > 0, `no POST to ${path}`);
  return posts[posts.length - 1]!.body.toString("latin1");
}

/** The trace POSTs whose body names a span `name`. */
function tracePosts(name: string): Hit[] {
  return otlpPosts("/otlp/v1/traces").filter((hit) => hit.body.includes(name));
}

function carries(input: { post: Hit; hex: string }): boolean {
  return input.post.body.includes(Buffer.from(input.hex, "hex"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function kvFailurePoints(batch: ResourceMetrics): Array<{ attributes: Record<string, unknown>; value: number }> {
  const points: Array<{ attributes: Record<string, unknown>; value: number }> = [];
  for (const scope of batch.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== "apj_factory.kv.failure") continue;
      for (const point of metric.dataPoints) {
        points.push({ attributes: { ...point.attributes }, value: point.value as number });
      }
    }
  }
  return points;
}

/**
 * What a hosted reply waits for: the factory flush (a factory span's, or the
 * session.* hook's in agent/hooks/zz-otel-turn-flush.ts), then July's
 * forceFlush, which flushes no provider it adopted.
 */
async function flush(): Promise<void> {
  await flushFactorySignals();
  await runtime!.forceFlush();
  await factorySignalsSettled();
}

const INBOUND = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" };

type Delivered = { probe: Hit; traceId: string; spanId: string; http: { traceId: string; spanId: string } };

/** A host MCP call as July makes it (`host.mcp`): its CLIENT span, around a call that returns at once. */
function mcpCall(): Promise<unknown> {
  return runMcpClientSpan({ method: "tools/call", toolName: "jira_search_MCPTOOL", connection: "jira" }, async () => undefined);
}

/**
 * One hosted-shaped delivery: July's `agent_sdk.http` span under an inbound
 * request from Cursor's backend, sampled or not (about 96% are not), and
 * under it a factory span that fetches, logs, counts, and hands one piece of
 * work to `after`, as a handler does. `mcp` adds a host MCP call, inside the
 * factory span or beside it (in July's span, outside the factory's).
 */
async function delivery(input: { sampled: boolean; after?: () => void; mcp?: "inside" | "outside" }): Promise<Delivered> {
  const before = hits.length;
  const remote = trace.setSpanContext(context.active(), { ...INBOUND, traceFlags: input.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE, isRemote: true });
  let ids = { traceId: "", spanId: "" };
  let http = { traceId: "", spanId: "" };
  await context.with(remote, () =>
    trace.getTracer("agent_sdk").startActiveSpan("agent_sdk.http", async (span) => {
      http = { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId };
      await traceFactory({ span: "factory.delivery", kind: "jira.webhook", ticketKey: "TLSSN-1" }, async () => {
        const mine = trace.getActiveSpan()!.spanContext();
        ids = { traceId: mine.traceId, spanId: mine.spanId };
        await fetch(`${base}/probe`);
        console.log(JSON.stringify({ desk: "inbound", route: "model", issueKey: "TLSSN-1", text: "please approve SLACK_TEXT_MARK", error: "ERROR_TEXT_MARK", note: "xoxb-1234-5678-TOKENMARK" }));
        console.error("[factory-desk] hop-watch for TLSSN-1 failed:", new Error("ERROR_ARG_MARK"));
        runtime!.meter?.createCounter("agent_sdk.session.count").add(1, { "agent_sdk.agent": "factory-desk", "cursor.conversation.id": "ses_char1abcd", "agent_sdk.session_id": "ses_char1abcd" });
        input.after?.();
        if (input.mcp === "inside") await mcpCall();
      });
      if (input.mcp === "outside") await mcpCall();
      span.end();
    })
  );
  const probe = hits.slice(before).find((hit) => hit.path === "/probe");
  assert.ok(probe !== undefined);
  return { probe, ...ids, http };
}

test("July 0.2.22 with the endpoint and no header at startup: all three signals on, no local BDK provider, no span recorded in memory", () => {
  assert.equal(bake.enabled, true);
  assert.equal(bake.exporters.length, 1, "dummy exporter keeps exporters.length > 0 so metrics/logs stay on");
  assert.deepEqual(
    (["traces", "metrics", "logs"] as const).map((signal) => exportersForSignal(bake.exporters, signal).length),
    [0, 0, 0],
    "dummy exporter: no traces, metrics, or logs attached to July (`defineOtel` rejects signals: [])",
  );
  assert.notEqual(bake.traces, false);
  assert.notEqual(bake.metrics, false);
  assert.deepEqual(bake.logs, { userPrompts: true, toolContent: true }, "July exports prompts and tool content");
  assert.ok(runtime?.meter !== undefined && runtime.logger !== undefined);
  assert.equal(julyLog.some((line) => line.includes("export on a local provider")), false, "July attached no local tracer/meter/logger (0.2.22 would otherwise keep them with frozen headers)");
  assert.equal(julyLog.some((line) => line.includes("otel recording")), false, "July records no span in memory");
  assert.ok(julyLog.some((line) => line.startsWith("[bdk] otel enabled")), "and logs its non-memory startup line");
});

test("metrics are cumulative", () => {
  for (const kind of [InstrumentType.COUNTER, InstrumentType.HISTOGRAM, InstrumentType.UP_DOWN_COUNTER]) {
    assert.equal(factoryMetricExporter.selectAggregationTemporality?.(kind), AggregationTemporality.CUMULATIVE);
  }
});

test("with the header unset a delivery and a flush contact nothing, and outbound fetch carries no traceparent", { timeout: 20_000 }, async () => {
  const { probe } = await delivery({ sampled: false });
  assert.equal(probe.traceparent, undefined);
  await flush();
  assert.deepEqual(otlpPosts(), []);
});

test("importing agent/otel.ts, July's startup, and a delivery with the header unset draw no service.instance.id (a hosted snapshot would freeze it)", () => {
  assert.equal(drawnInstanceId(), undefined);
});

test("header set after startup, inbound request not sampled: July's span is dropped, the factory's is a linked root in a trace of its own, and its spans, metrics, and logs leave before the delivery returns", { timeout: 20_000 }, async () => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  const { probe, traceId, spanId, http } = await delivery({ sampled: false });

  assert.equal(otlpPosts("/otlp/v1/traces").length, 1, "the factory's spans went out before the delivery returned (before the hosted reply)");
  assert.equal(otlpPosts("/otlp/v1/logs").length, 1, "logs too");
  assert.ok(otlpPosts("/otlp/v1/metrics").length >= 1, "and metrics");
  const spans = otlpPosts("/otlp/v1/traces")[0]!;
  assert.ok(spans.body.includes("factory.delivery"));
  assert.equal(spans.body.includes("agent_sdk.http"), false, "July's span under an unsampled parent is not recorded");
  assert.ok(carries({ post: spans, hex: traceId }) && carries({ post: spans, hex: spanId }), "the factory span's own ids");
  assert.equal(http.traceId, INBOUND.traceId, "July's span is in the backend's trace");
  assert.ok(carries({ post: spans, hex: http.traceId }) && carries({ post: spans, hex: http.spanId }), "linked to the span July opened for the inbound request");
  assert.notEqual(traceId, INBOUND.traceId, "a trace of its own");

  assert.match(probe.traceparent ?? "", new RegExp(`^00-${traceId}-${spanId}-01$`), "outbound fetch carries the factory span, sampled");
  assert.ok(carries({ post: otlpPosts("/otlp/v1/logs")[0]!, hex: traceId }) && carries({ post: otlpPosts("/otlp/v1/logs")[0]!, hex: spanId }), "logs written inside carry the new trace and span ids");

  await flush();
  assert.equal(otlpPosts("/otlp/v1/traces").length, 1, "July had no span to flush");
  assert.equal(otlpPosts("/otlp/v1/logs").length, 1, "no log left for a second batch");

  const instanceId = drawnInstanceId();
  assert.match(instanceId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "the first request with the header drew one id");
  assert.ok(instanceId !== undefined);
  for (const signal of ["traces", "metrics", "logs"]) {
    for (const post of otlpPosts(`/otlp/v1/${signal}`)) {
      assert.equal(post.authorization, AUTH, `${signal} auth`);
      const body = post.body.toString("latin1");
      assert.ok(body.includes("service.name") && body.includes("factory-desk"), `${signal} resource names the slug`);
      assert.ok(body.includes("service.instance.id") && body.includes(instanceId), `${signal} carries the one instance id`);
      assert.ok(body.includes("cursor.surface") && body.includes("unspecified"), `${signal} carries July's cursor.surface`);
      assert.ok(body.includes("cursor.entrypoint") && body.includes("sdk_ts"), `${signal} carries July's cursor.entrypoint`);
      assert.equal(body.includes("glc_FAKE_CHARACTERIZATION"), false, `${signal} carries the collector auth string`);
      if (signal !== "logs") {
        for (const mark of ["SLACK_TEXT_MARK", "ERROR_TEXT_MARK", "TOKENMARK", "hop-watch", "ERROR_ARG_MARK"]) {
          assert.equal(body.includes(mark), false, `${signal} carries ${mark}`);
        }
      }
    }
  }
  const metricBody = latest("/otlp/v1/metrics");
  assert.ok(metricBody.includes("apj_factory.delivery"), "the factory's metric");
  assert.ok(metricBody.includes("agent_sdk.session.count"), "July's own meter is the factory's");
  assert.equal(metricBody.includes("ses_"), false, "no session id on a metric");
  const logBody = latest("/otlp/v1/logs");
  assert.ok(logBody.includes('"desk":"inbound"') && logBody.includes("TLSSN-1") && logBody.includes("route"), "the console JSON line, original body");
  assert.ok(logBody.includes("SLACK_TEXT_MARK") && logBody.includes("ERROR_TEXT_MARK") && logBody.includes("TOKENMARK"), "JSON fields that used to be stripped");
  assert.ok(logBody.includes("[factory-desk]") && logBody.includes("hop-watch") && logBody.includes("ERROR_ARG_MARK"), "the tagged console.error line, every argument, including the Error");
});

test("July 0.2.18 collector: user_prompt, tool_args, tool_output, and error_message reach the exported OTLP under the factory's resolved config", { timeout: 20_000 }, async () => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  hits.length = 0;
  const collector = createOtelCollector(runtime!, "factory-desk", (line) => julyLog.push(line));
  const at = new Date().toISOString();
  const sessionId = "ses_content1";
  const turnId = "trn_content1";
  const session = { id: sessionId, channelId: "http", mode: "task", purpose: "live", auth: null };
  const events: Record<string, unknown>[] = [
    { index: 0, sessionId, at, type: "session.started", data: { channelId: "http" } },
    { index: 1, sessionId, at, type: "message.received", data: { text: "USER_PROMPT_MARK please file TLSSN-1" } },
    { index: 2, sessionId, at, turnId, type: "turn.started", data: {} },
    { index: 3, sessionId, at, turnId, type: "actions.requested", data: { calls: [{ callId: "call_1", toolName: "search", args: { query: "TOOL_ARGS_MARK" } }] } },
    { index: 4, sessionId, at, turnId, type: "action.result", data: { callId: "call_1", toolName: "search", output: { text: "TOOL_OUTPUT_MARK" }, isError: false } },
    { index: 5, sessionId, at, turnId, type: "turn.failed", data: { message: "ERROR_MESSAGE_MARK connector refused" } },
  ];
  for (const event of events) collector.onEvent(event, session);
  collector.close();
  await flush();
  const logs = latest("/otlp/v1/logs");
  assert.ok(logs.includes("agent_sdk.user_prompt") && logs.includes("USER_PROMPT_MARK"), "user_prompt on message.received");
  assert.ok(logs.includes("agent_sdk.error_message") && logs.includes("ERROR_MESSAGE_MARK"), "error_message on turn.failed");
  assert.ok(logs.includes("message.received") && logs.includes("turn.failed"));
  assert.equal(logs.includes("TOOL_OUTPUT_MARK"), false, "action.result log never carries output");
  const traces = latest("/otlp/v1/traces");
  assert.ok(traces.includes("agent_sdk.tool_args") && traces.includes("TOOL_ARGS_MARK"), "tool_args on agent_sdk.tool");
  assert.ok(traces.includes("agent_sdk.tool_output") && traces.includes("TOOL_OUTPUT_MARK"), "tool_output on agent_sdk.tool");
});

test("console bridge: a 401 does not re-export SDK diag lines (at most two log POSTs over ~5 s)", { timeout: 20_000 }, async (t) => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  t.after(() => {
    mode = "ok";
  });
  hits.length = 0;
  mode = "unauthorized";
  julyDiagToConsole();
  console.log("CONSOLE_BRIDGE_401_MARK");
  await sleep(5_000);
  const failing = otlpPosts("/otlp/v1/logs");
  assert.ok(failing.length <= 2, `expected at most 2 log POSTs over 5 s, got ${failing.length}`);
  assert.ok(
    failing.some((post) => post.body.toString("latin1").includes("CONSOLE_BRIDGE_401_MARK")),
    "the one console line still leaves",
  );
  for (const post of failing) {
    assert.equal(post.body.toString("latin1").includes("[bdk:otel]"), false, "SDK diag is not re-exported");
  }
  console.log("APP_LINE_AFTER_FAIL");
  mode = "ok";
  await flushFactorySignals();
  await factorySignalsSettled();
  assert.ok(
    otlpPosts("/otlp/v1/logs").some((post) => post.body.toString("latin1").includes("APP_LINE_AFTER_FAIL")),
    "an app console line after a failed export is still exported",
  );
});

test("console bridge: a 503 does not re-export SDK diag lines either", { timeout: 20_000 }, async (t) => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  t.after(async () => {
    mode = "ok";
    await flush();
  });
  hits.length = 0;
  mode = "unavailable";
  julyDiagToConsole();
  console.log("CONSOLE_BRIDGE_503_MARK");
  await sleep(2_000);
  const logs = otlpPosts("/otlp/v1/logs");
  assert.ok(logs.length >= 1, "at least one log POST arrived");
  assert.ok(
    logs.some((post) => post.body.toString("latin1").includes("CONSOLE_BRIDGE_503_MARK")),
    "the console line is in a log POST",
  );
  for (const post of logs) {
    assert.equal(post.body.toString("latin1").includes("[bdk:otel]"), false, "SDK diag is not re-exported");
  }
});

test("July startOtelSdk logger (server.js:117) prints diag to stdout and the bridge does not re-export it", { timeout: 20_000 }, async (t) => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  const printed: string[] = [];
  const previous = console.log;
  console.log = (...args: unknown[]) => {
    printed.push(format(...args));
    previous(...args);
  };
  t.after(() => {
    console.log = previous;
    mode = "ok";
  });
  hits.length = 0;
  mode = "unauthorized";
  createOtelRuntime(resolveExport(), (line) => console.log(line), { resolveExport });
  console.log("JULY_RUNTIME_MARK");
  await sleep(2_000);
  assert.ok(
    printed.some((line) => line.includes("[bdk:otel] error:")),
    "the SDK diag line reaches stdout",
  );
  const logs = otlpPosts("/otlp/v1/logs");
  assert.ok(logs.length >= 1, "at least one log POST arrived");
  assert.ok(
    logs.some((post) => post.body.toString("latin1").includes("JULY_RUNTIME_MARK")),
    "the console line is in a log POST",
  );
  for (const post of logs) {
    const body = post.body.toString("latin1");
    assert.equal(body.includes("[bdk:otel] error:"), false, "SDK diag error is not re-exported");
    assert.equal(body.includes("OTLPExporterError"), false, "export-failure payload is not re-exported");
  }
});

test("console bridge: a nested diag call leaves the outer call's later console.log unexported", { timeout: 20_000 }, async (t) => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  t.after(() => {
    julyDiagToConsole();
    mode = "ok";
  });
  hits.length = 0;
  mode = "ok";
  let nested = false;
  diag.setLogger(
    {
      verbose: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => {
        if (nested) return;
        nested = true;
        diag.error("inner");
        console.log("[bdk:otel] OUTER_AFTER_NESTED");
      },
    },
    DiagLogLevel.ERROR,
  );
  diag.error("outer");
  console.log("NESTED_FLAG_APP_MARK");
  await flushFactorySignals();
  await factorySignalsSettled();
  const logs = otlpPosts("/otlp/v1/logs");
  assert.ok(logs.length >= 1, "at least one log POST arrived");
  assert.ok(
    logs.some((post) => post.body.toString("latin1").includes("NESTED_FLAG_APP_MARK")),
    "an app line after the outer diag call still leaves",
  );
  for (const post of logs) {
    assert.equal(post.body.toString("latin1").includes("OUTER_AFTER_NESTED"), false, "the rest of the outer diag call stays unexported");
  }
});

test("bind baseline: factoryMetricExporter sees apj_factory.kv.failure value 0 with exact labels", { timeout: 20_000 }, async (t) => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  const captured: ResourceMetrics[] = [];
  const originalExport = factoryMetricExporter.export.bind(factoryMetricExporter);
  factoryMetricExporter.export = (batch, done) => {
    captured.push(batch);
    originalExport(batch, done);
  };
  t.after(() => {
    factoryMetricExporter.export = originalExport;
  });
  const funnel = createOpsFunnel();
  funnel.bind({ otel: createHostOtelApi({ agentName: "factory-desk", meter: runtime!.meter }) });
  await flushFactorySignals();
  await factorySignalsSettled();
  const points = captured.flatMap(kvFailurePoints);
  const baseline = points.find(
    (point) => point.attributes["slug"] === "factory-desk" && point.attributes["site"] === "none" && point.attributes["reason"] === "none",
  );
  assert.ok(baseline !== undefined, "apj_factory.kv.failure baseline point");
  assert.deepEqual(baseline.attributes, {
    "agent_sdk.agent": "factory-desk",
    slug: "factory-desk",
    site: "none",
    reason: "none",
  });
  assert.equal(baseline.value, 0);
});

test("inbound request sampled: the factory's spans still leave first, and July's agent_sdk.http, which ends after them, leaves at the next factory flush through the factory's exporter, not at July's flush, with the same resource", { timeout: 20_000 }, async () => {
  hits.length = 0;
  const { traceId } = await delivery({ sampled: true });
  assert.equal(tracePosts("factory.delivery").length, 1);
  assert.equal(tracePosts("agent_sdk.http").length, 0, "July's span ended after the delivery's flush");
  await runtime!.forceFlush();
  assert.equal(tracePosts("agent_sdk.http").length, 0, "July's forceFlush does not flush the tracer it adopted");
  await flush();
  const julys = tracePosts("agent_sdk.http");
  assert.equal(julys.length, 1);
  assert.equal(tracePosts("factory.delivery").length, 1, "the factory's span is not sent again");
  const instanceId = drawnInstanceId()!;
  for (const post of [...tracePosts("factory.delivery"), ...julys]) {
    assert.equal(post.authorization, AUTH);
    const body = post.body.toString("latin1");
    assert.ok(body.includes("factory-desk") && body.includes(instanceId));
    assert.ok(body.includes("cursor.surface") && body.includes("unspecified") && body.includes("cursor.entrypoint") && body.includes("sdk_ts"), "the cursor.surface and cursor.entrypoint July's own resource set");
  }
  assert.equal(carries({ post: julys[0]!, hex: traceId }), false, "July's span is in the inbound trace, not the factory's");
  assert.ok(carries({ post: julys[0]!, hex: INBOUND.traceId }));
});

test("inbound request not sampled, a host MCP call: outside a factory span July records nothing; inside one it records the call as a child of the factory span, which carries it out before the delivery returns", { timeout: 20_000 }, async () => {
  hits.length = 0;
  await delivery({ sampled: false, mcp: "outside" });
  await flush();
  assert.equal(tracePosts("tools/call").length, 0, "an MCP span under an unsampled parent is not recorded");
  assert.equal(tracePosts("agent_sdk.http").length, 0);

  hits.length = 0;
  const { traceId, spanId } = await delivery({ sampled: false, mcp: "inside" });
  assert.equal(tracePosts("factory.delivery").length, 1, "the factory's span left before the delivery returned");
  const julys = tracePosts("tools/call");
  assert.equal(julys.length, 1, "July's MCP span, ended inside the factory span, left in the same flush although the request was not sampled");
  assert.equal(julys[0], tracePosts("factory.delivery")[0], "in the same POST as the factory span");
  await flush();
  assert.equal(tracePosts("agent_sdk.http").length, 0, "and still not agent_sdk.http");
  assert.equal(tracePosts("factory.delivery").length, 1, "the factory's span is not sent again");
  assert.ok(carries({ post: julys[0]!, hex: traceId }) && carries({ post: julys[0]!, hex: spanId }), "in the factory's trace, a child of the factory span");
  assert.equal(julys[0]!.authorization, AUTH);
  const body = julys[0]!.body.toString("latin1");
  assert.ok(body.includes("factory-desk") && body.includes(drawnInstanceId()!), "with the factory's resource");
  assert.ok(body.includes("jira_search_MCPTOOL"), "July's span carries the tool name; the factory does not filter July's own spans");
  await runtime!.forceFlush();
  assert.equal(tracePosts("tools/call").length, 1, "accepted once, then nothing is left");
});

test("work a handler hands to waitUntil, ending after the delivery returned, is exported by its own flush and joins the delivery's trace", { timeout: 20_000 }, async () => {
  hits.length = 0;
  let background: Promise<void> | undefined;
  const { traceId, spanId } = await delivery({
    sampled: false,
    after: () => {
      background = traceFactory({ span: "factory.background", kind: "jira.triage_wake" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    },
  });
  assert.equal(tracePosts("factory.background").length, 0, "still running when the delivery returned");
  await background;
  const posts = tracePosts("factory.background");
  assert.equal(posts.length, 1, "exported when it finished, with no flush asked for by the test or by July");
  assert.ok(carries({ post: posts[0]!, hex: traceId }), "in the delivery's trace");
  assert.ok(carries({ post: posts[0]!, hex: spanId }), "a child of the delivery span");
});

test("metric series stay flat across sessions: session, conversation, and agent ids and session tags never reach a metric", { timeout: 20_000 }, async () => {
  const counter = runtime!.meter!.createCounter("agent_sdk.turn.count");
  const sessions = (input: { from: number; count: number }) => {
    for (let i = input.from; i < input.from + input.count; i++) {
      const id = `ses_${String(i).padStart(12, "0")}`;
      counter.add(1, { "agent_sdk.agent": "factory-desk", "agent_sdk.turn_status": "completed", "cursor.conversation.id": id, "agent_sdk.session_id": id, "agent_sdk.sdk_agent_id": `bc-session-${i}`, "support.ticket_id": `INC-${i}` });
    }
  };
  sessions({ from: 0, count: 10 });
  await flushFactorySignals();
  await factorySignalsSettled();
  const small = latest("/otlp/v1/metrics");
  sessions({ from: 10, count: 1_000 });
  await flushFactorySignals();
  await factorySignalsSettled();
  const large = latest("/otlp/v1/metrics");
  for (const body of [small, large]) {
    assert.equal(body.includes("ses_0"), false);
    assert.equal(body.includes("bc-session-"), false);
    assert.equal(body.includes("INC-"), false);
  }
  assert.ok(Math.abs(large.length - small.length) < 64, `payload grew from ${small.length} to ${large.length} bytes over 1000 sessions`);
});

test("a turn.started hook's tagSessionTicket reaches July's collector: cursor.token.usage and agent_sdk.turn.count leave with factory.ticket.key, per ticket, with the session ids dropped, the tag set mid-turn re-labelling the turn, a session's second turn re-tagged to another ticket landing there only, and cursor.tool.calls without the label", { timeout: 20_000 }, async (t) => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  const captured: ResourceMetrics[] = [];
  const originalExport = factoryMetricExporter.export.bind(factoryMetricExporter);
  factoryMetricExporter.export = (batch, done) => {
    captured.push(batch);
    originalExport(batch, done);
  };
  t.after(() => {
    factoryMetricExporter.export = originalExport;
  });
  // July's wiring (session-engine.js): one collector per process, and the hook's ctx.host.otel is the host API bound to the session.
  const collector = createOtelCollector(runtime!, "factory-desk", (line) => julyLog.push(line));
  const at = new Date().toISOString();
  const usage = { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0, reasoningTokens: 20, totalTokens: 1_050 };
  type TagHost = { otel: Pick<HostOtelApi, "setAttributes"> };
  const turn = (input: { sessionId: string; turnId: string; tag?: (host: TagHost) => void; midTurn?: (host: TagHost) => void; followUp?: boolean }) => {
    const session = { id: input.sessionId, channelId: "slack", mode: "chat", purpose: "live", auth: null };
    const host: TagHost = { otel: createHostOtelApi({ agentName: "factory-desk", meter: runtime!.meter, collector, sessionId: input.sessionId }) };
    const events: Record<string, unknown>[] = [
      ...(input.followUp === true ? [] : [{ index: 0, sessionId: input.sessionId, at, type: "session.started", data: { channelId: "slack" } }]),
      { index: 1, sessionId: input.sessionId, at, turnId: input.turnId, type: "turn.started", data: {} },
    ];
    for (const event of events) collector.onEvent(event, session);
    // The hook runs on turn.started, before the collector records anything for the turn.
    input.tag?.(host);
    collector.onEvent({ index: 2, sessionId: input.sessionId, at, turnId: input.turnId, type: "action.result", data: { callId: "call_1", toolName: "file_ticket", output: { issueKey: "TLSSN-41" }, isError: false } }, session);
    input.midTurn?.(host);
    collector.onEvent({ index: 3, sessionId: input.sessionId, at, turnId: input.turnId, type: "turn.completed", data: { status: "completed", usage, cost: { model: "grok-4.6-fast", totalUsd: 0.0123, source: "estimate" } } }, session);
  };
  turn({ sessionId: "ses_ticket_a", turnId: "trn_a", tag: (host) => tagSessionTicket(host, "TLSSN-41") });
  turn({ sessionId: "ses_ticket_b", turnId: "trn_b", tag: (host) => tagSessionTicket(host, "TLSSN-41") });
  turn({ sessionId: "ses_ticket_c", turnId: "trn_c", tag: (host) => tagSessionTicket(host, "TLSSN-42") });
  turn({ sessionId: "ses_ticket_d", turnId: "trn_d", tag: (host) => tagSessionTicket(host, undefined) });
  // The desk's filing turn: `none` at turn.started, the new key from file_ticket's result before turn.completed.
  turn({ sessionId: "ses_ticket_e", turnId: "trn_e", tag: (host) => tagSessionTicket(host, undefined), midTurn: (host) => tagSessionTicket(host, "TLSSN-43") });
  // One session, two turns, two tickets (a drive re-pointed, a thread whose latest ticket changed): the hook re-tags on each turn.started, and the second turn's usage lands on the second key only.
  turn({ sessionId: "ses_ticket_f", turnId: "trn_f1", tag: (host) => tagSessionTicket(host, "TLSSN-44") });
  turn({ sessionId: "ses_ticket_f", turnId: "trn_f2", followUp: true, tag: (host) => tagSessionTicket(host, "TLSSN-45") });
  collector.close();
  await flush();
  const all = captured
    .flatMap((batch) => batch.scopeMetrics.flatMap((scope) => scope.metrics))
    .flatMap((metric) => metric.dataPoints.map((point) => ({ name: metric.descriptor.name, attributes: { ...point.attributes }, value: point.value as number })));
  const points = all.filter((point) => point.name === "cursor.token.usage");
  assert.equal(all.some((point) => point.name === "cursor.cost.usage"), false, "0.2.22 collector no longer increments cursor.cost.usage");
  const tokens = (input: { ticket: string; type: string }) =>
    points.find((point) => point.name === "cursor.token.usage" && point.attributes[TICKET_KEY_ATTRIBUTE] === input.ticket && point.attributes["cursor.token.type"] === input.type);
  assert.equal(tokens({ ticket: "TLSSN-41", type: "input" })?.value, 2_000, "two sessions' input under one ticket series");
  assert.equal(tokens({ ticket: "TLSSN-41", type: "cache_read" })?.value, 1_200, "cache reads under the same ticket, as their own type");
  assert.equal(tokens({ ticket: "TLSSN-41", type: "output" })?.value, 100);
  assert.equal(tokens({ ticket: "TLSSN-41", type: "reasoning" })?.value, 40);
  assert.equal(tokens({ ticket: "TLSSN-42", type: "input" })?.value, 1_000);
  assert.equal(tokens({ ticket: "none", type: "input" })?.value, 1_000, "the untagged turn is `none`, a fixed value, not a missing label");
  assert.equal(tokens({ ticket: "TLSSN-43", type: "input" })?.value, 1_000, "the filing turn's whole usage lands on the key filed mid-turn");
  assert.equal(tokens({ ticket: "TLSSN-41", type: "cache_creation" }), undefined, "July skips a zero (addTokens)");
  assert.equal(tokens({ ticket: "TLSSN-44", type: "input" })?.value, 1_000, "the session's first turn on its first ticket");
  assert.equal(tokens({ ticket: "TLSSN-45", type: "input" })?.value, 1_000, "its second turn on the second ticket only: the re-tag overwrites the bag, nothing is counted twice");
  for (const point of points) {
    assert.deepEqual(
      Object.keys(point.attributes).sort(),
      ["agent_sdk.agent", "cursor.token.type", TICKET_KEY_ATTRIBUTE].sort(),
      `${point.name} ${JSON.stringify(point.attributes)}`,
    );
  }
  // The exporter is cumulative and the runtime shared with the tests above, whose turns are `none`; this test's tickets are its own.
  const turns = all.filter((point) => point.name === "agent_sdk.turn.count");
  assert.deepEqual(
    turns
      .filter((point) => String(point.attributes[TICKET_KEY_ATTRIBUTE]).startsWith("TLSSN-4"))
      .map((point) => [point.attributes[TICKET_KEY_ATTRIBUTE], point.attributes["agent_sdk.turn_status"], point.value])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["TLSSN-41", "completed", 2],
      ["TLSSN-42", "completed", 1],
      ["TLSSN-43", "completed", 1],
      ["TLSSN-44", "completed", 1],
      ["TLSSN-45", "completed", 1],
    ],
    "agent_sdk.turn.count carries the label: the per-ticket turn count of the README",
  );
  assert.ok(turns.some((point) => point.attributes[TICKET_KEY_ATTRIBUTE] === "none" && point.attributes["agent_sdk.turn_status"] === "completed"), "an untagged turn's count is `none`");
  for (const point of turns) assert.deepEqual(Object.keys(point.attributes).sort(), ["agent_sdk.agent", "agent_sdk.turn_status", TICKET_KEY_ATTRIBUTE].sort());
  const toolCalls = all.filter((point) => point.name === "cursor.tool.calls");
  const fileTicket = toolCalls.filter((point) => point.attributes["cursor.tool.name"] === "file_ticket");
  assert.equal(fileTicket.length, 1, "one series for the tool, kind and status, as on main: six tickets' calls in it");
  assert.ok(fileTicket[0]!.value >= 7, "every turn's call in it");
  for (const point of toolCalls) {
    assert.equal(TICKET_KEY_ATTRIBUTE in point.attributes, false, `cursor.tool.calls keeps no ticket label (one series per tool per ticket would overflow the cap): ${JSON.stringify(point.attributes)}`);
  }
  const body = latest("/otlp/v1/metrics");
  assert.ok(body.includes(TICKET_KEY_ATTRIBUTE) && body.includes("TLSSN-41"), "the label is in the exported OTLP");
  assert.equal(body.includes("ses_ticket_"), false, "no session id reaches a metric");
});

test("July's hosted-execution latency histogram leaves with its phase, channel kind, outcome, and delivery surface, and its reminder outcome with kind and purpose", { timeout: 20_000 }, async () => {
  const histogram = runtime!.meter!.createHistogram("agent_sdk.hosted_execution.duration_ms", { unit: "ms" });
  for (const phase of ["to_first_visible", "first_visible_to_completion", "durability_drain", "post_drain", "total"]) {
    histogram.record(250, { channel_kind: "slack", outcome: "final_post", delivery_surface: "slack", phase });
  }
  const reminders = runtime!.meter!.createCounter("agent_sdk.reminder.fire_outcome");
  reminders.add(1, { kind: "delivered", reason: "run_delivered", purpose: "hop_watch" });
  reminders.add(1, { kind: "stop", reason: "session_gone", purpose: "check TLSSN-9 later PURPOSE_MARK" });
  reminders.add(1, { kind: "stop", reason: "REASON_MARK a caller said so", purpose: "follow_up" });
  await flushFactorySignals();
  await factorySignalsSettled();
  const body = latest("/otlp/v1/metrics");
  for (const word of ["to_first_visible", "first_visible_to_completion", "durability_drain", "post_drain", "total", "channel_kind", "delivery_surface", "final_post", "hop_watch", "run_delivered", "session_gone"]) {
    assert.ok(body.includes(word), `${word} is on a metric`);
  }
  assert.equal(body.includes("PURPOSE_MARK") || body.includes("TLSSN-9"), false, "a model-chosen purpose is not a label");
  assert.equal(body.includes("REASON_MARK"), false, "nor is a reason a caller of cancel chose");
});

test("exporters keep their connection until the header changes, the trace exporter included", { timeout: 20_000 }, async (t) => {
  t.after(() => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
    for (const res of hung.splice(0)) res.destroy();
  });
  const count = () => connections;
  runtime!.meter!.createCounter("agent_sdk.session.count").add(1, { "agent_sdk.agent": "factory-desk" });
  console.log(JSON.stringify({ worker: "decision", outcome: "ignored" }));
  await traceFactory({ span: "factory.schedule", kind: "schedule.warm" }, () => undefined);
  const afterFirst = count();
  for (let i = 0; i < 3; i++) {
    console.log(JSON.stringify({ worker: "decision", outcome: "ignored" }));
    await traceFactory({ span: "factory.schedule", kind: "schedule.again" }, () => undefined);
  }
  assert.equal(count(), afterFirst, "three more span, metric, and log exports opened no connection");
  await factorySignalsSettled();
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH},x-rotated=1`;
  console.log(JSON.stringify({ worker: "decision", outcome: "ignored" }));
  const rotated = await Promise.race([
    traceFactory({ span: "factory.schedule", kind: "schedule.rotated" }, () => undefined).then(() => "flushed" as const),
    new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), SIGNALS_BUDGET_MS + 500);
      timer.unref?.();
    }),
  ]);
  assert.equal(rotated, "flushed", "header rotation must finish within the signals budget");
  assert.ok(count() > afterFirst, "a changed header builds new exporters");
  assert.ok(otlpPosts("/otlp/v1/logs").at(-1)?.body.toString("latin1").includes('"worker":"decision"'), "the log exporter was rebuilt and sent the original console body");
  assert.equal(otlpPosts("/otlp/v1/traces").at(-1)?.rotated, "1", "the trace exporter was rebuilt with the new header too");
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
});

test("a 401: span batches, July's included, and log batches are dropped, not re-posted; they are retried after a timeout instead", { timeout: 40_000 }, async () => {
  hits.length = 0;
  mode = "unauthorized";
  await delivery({ sampled: true });
  await flush();
  await flush();
  assert.equal(tracePosts("agent_sdk.http").length, 1, "July's span went through the factory's exporter, and its 401 batch is dropped like the factory's");
  assert.equal(tracePosts("factory.delivery").length, 1, "a 401 span batch of the factory's is dropped");
  assert.equal(otlpPosts("/otlp/v1/logs").length, 1, "a 401 log batch is dropped");
  mode = "ok";
  await flush();
  await runtime!.forceFlush();
  assert.equal(tracePosts("agent_sdk.http").length, 1, "nothing was kept to send again");

  hits.length = 0;
  mode = "hang";
  await delivery({ sampled: false });
  await factorySignalsSettled();
  mode = "ok";
  await delivery({ sampled: false });
  await factorySignalsSettled();
  const resent = tracePosts("factory.delivery").at(-1)!;
  assert.equal(resent.body.toString("latin1").split("jira.webhook").length - 1, 2, "the timed-out span batch rides the next one");
  const logs = latest("/otlp/v1/logs");
  assert.ok(logs.includes('"desk":"inbound"'), "and so do the logs");
});

/** Gives the collector back, and sends what the factory kept with one new span (a kept span batch rides the next batch). */
async function recoverCollector(): Promise<void> {
  for (const res of hung.splice(0)) res.destroy();
  mode = "ok";
  await factorySignalsSettled();
  await runtime!.forceFlush();
  await traceFactory({ span: "factory.schedule", kind: "schedule.recover" }, () => undefined);
  await factorySignalsSettled();
}

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = Date.now();
  const value = await work();
  return { ms: Date.now() - started, value };
}

// The three cases below share one hanging collector. The first records no
// July span, the second a July MCP span, which the factory keeps when its
// export times out, and the third's batch carries it again.
test("a collector that never answers, no span for July to send: the delivery waits SIGNALS_BUDGET_MS for the factory's signals and July's flush adds nothing", { timeout: 30_000 }, async (t) => {
  hits.length = 0;
  await recoverCollector();
  mode = "hang";
  const sent = await timed(() => delivery({ sampled: false }));
  const flushed = await timed(() => runtime!.forceFlush());
  t.diagnostic(`hanging collector, nothing for July: delivery ${sent.ms} ms, July's flush ${flushed.ms} ms`);
  assert.equal(tracePosts("agent_sdk.http").length + tracePosts("tools/call").length, 0, "July had nothing to send");
  assert.ok(sent.ms >= EXPORT_TIMEOUT_MS - 50 && sent.ms < SIGNALS_BUDGET_MS + 300, `the delivery waited ${sent.ms} ms for spans, metrics, and logs`);
  assert.ok(flushed.ms < 300, `July's flush took ${flushed.ms} ms with nothing to send`);
  await recoverCollector();
});

test("a collector that never answers, a host MCP call inside a factory span under an unsampled request: the MCP span is in the factory's batch, so the delivery still waits only SIGNALS_BUDGET_MS and July's flush adds nothing", { timeout: 30_000 }, async (t) => {
  hits.length = 0;
  mode = "hang";
  const sent = await timed(() => delivery({ sampled: false, mcp: "inside" }));
  const flushed = await timed(() => runtime!.forceFlush());
  const totalMs = sent.ms + flushed.ms;
  t.diagnostic(`hanging collector, MCP call under an unsampled request: delivery ${sent.ms} ms, July's flush ${flushed.ms} ms, together ${totalMs} ms`);
  assert.ok(tracePosts("tools/call").length >= 1, "the factory tried to send July's MCP span, in the delivery's flush, although the request was not sampled");
  assert.ok(sent.ms >= EXPORT_TIMEOUT_MS - 50 && sent.ms < SIGNALS_BUDGET_MS + 300, `the delivery waited ${sent.ms} ms for spans, metrics, and logs`);
  assert.ok(flushed.ms < 300, `July's flush took ${flushed.ms} ms: it has no span buffer of its own to export`);
  assert.ok(totalMs < SIGNALS_BUDGET_MS + 300, `delivery plus July's flush took ${totalMs} ms`);
});

test("a collector that never answers: a later delivery that adds no July span pays nothing at July's flush, its batch carries the kept MCP span again, and the factory sends it once the collector answers", { timeout: 30_000 }, async (t) => {
  hits.length = 0;
  assert.equal(mode, "hang", "the collector is still down from the case before");
  const sent = await timed(() => delivery({ sampled: false }));
  const flushed = await timed(() => runtime!.forceFlush());
  t.diagnostic(`hanging collector, span kept from the case before: delivery ${sent.ms} ms, July's flush ${flushed.ms} ms`);
  assert.ok(tracePosts("tools/call").length >= 1, "the timed-out batch with July's span rode this delivery's batch");
  assert.ok(sent.ms < SIGNALS_BUDGET_MS + 300, `the delivery waited ${sent.ms} ms`);
  assert.ok(flushed.ms < 300, `July's flush took ${flushed.ms} ms`);
  await recoverCollector();
  assert.ok(tracePosts("tools/call").length >= 2, "and sends it again once the collector answers");
});

// Runs whether or not a test failed, so a hung exporter never holds the run open.
after(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  for (const res of hung) res.destroy();
  server.closeAllConnections();
  server.close();
});

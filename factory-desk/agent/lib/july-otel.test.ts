import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { context, trace, TraceFlags, type Meter } from "@opentelemetry/api";
import { countTicketMerged, TICKET_MERGED_METRIC, traceFactory } from "./factory-otel.js";

// This agent's real agent/otel.ts through July 0.2.25's real runtime, against
// a local collector given as the endpoint (docs/factory-deployment.md section
// 10). July builds the tracer, meter, and logger providers from
// factoryOtelConfig and registers them globally; the factory's spans,
// counters, and console lines go through the global API, and July's own
// hosted-delivery flush (runtime.forceFlush) exports all three. The collector
// is sent OTLP/JSON so a request body can be read for its temporality and
// resource; the encoding changes neither. July's runtime is internal (no
// package export), so it is loaded by path; when an upgrade fails one of
// these, July changed that behaviour: recheck agent/otel.ts and the
// dashboards before changing the test.

for (const name of Object.keys(process.env)) if (name.startsWith("OTEL_")) delete process.env[name];

type Hit = { path: string; authorization: string | undefined; body: Buffer };

const hits: Hit[] = [];
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const authorization = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : undefined;
    hits.push({ path: req.url ?? "", authorization, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end();
  });
});
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
after(() => server.close());
const AUTH = `Basic ${Buffer.from("123456:glc_FAKE_CHARACTERIZATION").toString("base64")}`;
const ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/otlp`;
process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
process.env.AGENT_SERVE_GENERATION = "7";

const july = (file: string) => new URL(`../../node_modules/@cursor/july/dist/internal/otel/${file}`, import.meta.url).href;
const { resolveOtelConfig, exportersForSignal } = (await import(july("config.js"))) as {
  resolveOtelConfig: (input: { authored: unknown }) => { exporters: { signals?: string[] }[]; enabled: boolean; metrics: false | { temporality: string } };
  exportersForSignal: (exporters: { signals?: string[] }[], signal: string) => unknown[];
};
const { createOtelRuntime } = (await import(july("runtime.js"))) as {
  createOtelRuntime: (resolve: () => unknown, log: (line: string) => void, options: object) => { runtime: { forceFlush(): Promise<void>; shutdown(): Promise<void>; meter?: Meter }; reload(): void };
};
const { default: authored } = (await import("../otel.js")) as { default: unknown };

const julyLog: string[] = [];
const { runtime, reload } = createOtelRuntime(() => resolveOtelConfig({ authored }), (line) => julyLog.push(line), {});

const posts = (path: string): Hit[] => hits.filter((hit) => hit.path === `/otlp/v1/${path}`);
const mentions = (hit: Hit, text: string): boolean => hit.body.includes(text);
const LOG_MARK = "LOG_MARK_" + Date.now();

test("a hosted pod before its secrets bind: July resolves no exporter and builds no provider, so nothing is sent", async () => {
  reload();
  assert.equal(resolveOtelConfig({ authored }).exporters.length, 0);
  await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, async () => {
    assert.notEqual(trace.getActiveSpan()?.isRecording(), true);
  });
  countTicketMerged("TLSSN-1");
  console.log(`{"desk":"before_secrets","mark":"${LOG_MARK}"}`);
  await runtime.forceFlush();
  assert.equal(hits.length, 0);
  assert.equal(julyLog.some((line) => line.startsWith("[bdk] otel enabled")), false);
});

test("the header binds and July reloads: one exporter for all three signals, built once, cumulative metrics, and the factory's spans, counters, and console lines leave through July's providers under this slug", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH.replace(" ", "%20")}`;
  reload();
  assert.ok(julyLog.some((line) => /^\[bdk\] otel enabled service=factory-desk exporters=1 traces=true metrics=true logs=true$/.test(line)), julyLog.join("\n"));
  assert.equal(julyLog.some((line) => line.includes("already registered") || line.includes("not cumulative")), false, julyLog.join("\n"));
  const resolved = resolveOtelConfig({ authored });
  assert.equal(resolved.metrics === false ? undefined : resolved.metrics.temporality, "cumulative", "agent/otel.ts defaults July's temporality: Grafana Cloud rejects delta sums");
  for (const signal of ["traces", "metrics", "logs"]) assert.equal(exportersForSignal(resolved.exporters, signal).length, 1, signal);

  const inbound = trace.setSpanContext(context.active(), { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: TraceFlags.NONE, isRemote: true });
  await context.with(inbound, () =>
    traceFactory({ span: "factory.delivery", kind: "jira.webhook", ticketKey: "TLSSN-1" }, async () => {
      assert.equal(trace.getActiveSpan()?.isRecording(), true, "a factory root is recorded even under an unsampled inbound parent");
      console.log(`{"desk":"inbound","mark":"${LOG_MARK}"}`);
    })
  );
  countTicketMerged("TLSSN-1");
  runtime.meter!.createCounter("agent_sdk.session.count").add(1, { "agent_sdk.agent": "factory-desk" });
  runtime.meter!.createHistogram("agent_sdk.hosted_execution.duration_ms", { unit: "ms" }).record(1234, { phase: "total" });
  assert.equal(posts("metrics").length, 0, "no metric has left: the periodic export is 10 s away");
  await runtime.forceFlush();

  for (const signal of ["traces", "metrics", "logs"]) {
    assert.ok(posts(signal).length >= 1, `no ${signal} POST: July's own flush must cover ${signal}`);
    for (const hit of posts(signal)) {
      assert.equal(hit.authorization, AUTH, `${signal} carries the header, decoded once`);
      assert.ok(mentions(hit, "factory-desk"), `${signal} is under this slug`);
      assert.match(hit.body.toString("utf8"), /"service\.instance\.id"[^}]*"stringValue":"[0-9a-f]{32}"/, `${signal} carries the life's instance id`);
    }
  }
  const sent = posts("metrics").map((hit) => hit.body.toString("utf8")).join("\n");
  for (const name of ["apj_factory.delivery", TICKET_MERGED_METRIC, "agent_sdk.session.count", "agent_sdk.hosted_execution.duration_ms"]) assert.ok(sent.includes(name), `${name} left with July's flush`);
  assert.equal(sent.includes('"aggregationTemporality":1'), false, "no DELTA point");
  assert.ok(sent.includes('"aggregationTemporality":2'), "CUMULATIVE points");
  assert.ok(posts("traces").some((hit) => mentions(hit, "factory.delivery") && mentions(hit, "software-factory")));
  assert.ok(posts("logs").some((hit) => mentions(hit, LOG_MARK)), "the console line is a log record with the original body");
  assert.equal(posts("logs").some((hit) => mentions(hit, "before_secrets")), false, "lines printed before July's providers exist are not exported");
});

test("a later reload with the same header changes no setting: July logs no redeploy warning", () => {
  const before = julyLog.length;
  reload();
  reload();
  assert.deepEqual(julyLog.slice(before), []);
});

test("an operator's temporality wins over the default", () => {
  process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = "lowmemory";
  try {
    const resolved = resolveOtelConfig({ authored });
    assert.equal(resolved.metrics === false ? undefined : resolved.metrics.temporality, "lowmemory");
  } finally {
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = "cumulative";
  }
});

after(async () => {
  await runtime.shutdown();
});

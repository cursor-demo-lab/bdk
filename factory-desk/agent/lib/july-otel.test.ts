import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { context, metrics, trace, TraceFlags, type Meter } from "@opentelemetry/api";
import { countTicketMerged, TICKET_MERGED_METRIC, traceFactory } from "./factory-otel.js";

// This agent's real agent/otel.ts through July 0.2.24's real runtime, against
// a local collector given as the endpoint (docs/factory-deployment.md section
// 10). July builds the tracer and logger providers from factoryOtelConfig and
// registers them globally; metrics leave through the one cumulative meter
// provider agent/otel.ts registers (lib/factory-metrics.ts), which July adopts
// because the config names no metrics exporter. The factory's spans, counters,
// and console lines go through the global API. July's runtime is
// internal (no package export), so it is loaded by path; when an upgrade
// fails one of these, July changed that behaviour: recheck agent/otel.ts and
// the dashboards before changing the test.

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
process.env.AGENT_SERVE_GENERATION = "7";

const july = (file: string) => new URL(`../../node_modules/@cursor/july/dist/internal/otel/${file}`, import.meta.url).href;
const { resolveOtelConfig, exportersForSignal } = (await import(july("config.js"))) as {
  resolveOtelConfig: (input: { authored: unknown }) => { exporters: { signals?: string[] }[]; enabled: boolean };
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

test("the header binds and July reloads: one exporter for all three signals, built once, and the factory's spans, counters, and console lines leave through July's providers under this slug", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH.replace(" ", "%20")}`;
  reload();
  assert.ok(julyLog.some((line) => /^\[bdk\] otel enabled service=factory-desk exporters=1 traces=true metrics=true logs=true$/.test(line)), julyLog.join("\n"));
  assert.equal(julyLog.some((line) => line.includes("on a local provider")), false, "July's providers are the global ones");

  const inbound = trace.setSpanContext(context.active(), { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: TraceFlags.NONE, isRemote: true });
  await context.with(inbound, () =>
    traceFactory({ span: "factory.delivery", kind: "jira.webhook", ticketKey: "TLSSN-1" }, async () => {
      assert.equal(trace.getActiveSpan()?.isRecording(), true, "a factory root is recorded even under an unsampled inbound parent");
      console.log(`{"desk":"inbound","mark":"${LOG_MARK}"}`);
    })
  );
  assert.ok(
    posts("metrics").some((hit) => mentions(hit, "apj_factory.delivery") && mentions(hit, "jira.webhook")),
    "the delivery's own counter left when its factory span ended, with no July flush and no timer",
  );
  countTicketMerged("TLSSN-1");
  assert.equal(exportersForSignal(resolveOtelConfig({ authored }).exporters, "metrics").length, 0, "no metrics exporter in the config: July builds no DELTA one");
  assert.equal(exportersForSignal(resolveOtelConfig({ authored }).exporters, "traces").length, 1);
  assert.equal(exportersForSignal(resolveOtelConfig({ authored }).exporters, "logs").length, 1);
  assert.equal(runtime.meter, metrics.getMeter("agent_sdk"), "July's meter is the global one, the factory's cumulative provider's");
  runtime.meter!.createCounter("agent_sdk.session.count").add(1, { "agent_sdk.agent": "factory-desk" });
  const sent = posts("metrics").length;
  await runtime.forceFlush();
  assert.equal(posts("metrics").length, sent, "July's flush covers the providers July built: traces and logs");
  await (metrics.getMeterProvider() as unknown as { forceFlush(): Promise<void> }).forceFlush();

  for (const signal of ["traces", "metrics", "logs"]) {
    assert.ok(posts(signal).length >= 1, `no ${signal} POST`);
    for (const hit of posts(signal)) assert.equal(hit.authorization, AUTH, `${signal} carries the header, decoded once`);
  }
  assert.ok(posts("traces").some((hit) => mentions(hit, "factory.delivery") && mentions(hit, "factory-desk") && mentions(hit, "software-factory")));
  assert.ok(posts("metrics").some((hit) => mentions(hit, "apj_factory.delivery") && mentions(hit, TICKET_MERGED_METRIC) && mentions(hit, "agent_sdk.session.count") && mentions(hit, "factory-desk") && mentions(hit, "service.instance.id")));
  assert.ok(posts("logs").some((hit) => mentions(hit, LOG_MARK) && mentions(hit, "factory-desk")), "the console line is a log record with the original body");
  assert.equal(posts("logs").some((hit) => mentions(hit, "before_secrets")), false, "lines printed before July's providers exist are not exported");
});

test("a later reload with the same header changes no setting: July logs no redeploy warning", () => {
  const before = julyLog.length;
  reload();
  reload();
  assert.deepEqual(julyLog.slice(before), []);
});

test("July's metric exporters are DELTA and have no knob: why the factory registers a cumulative meter provider (Grafana Cloud answers a DELTA sum with HTTP 400)", () => {
  const source = readFileSync(new URL("../../node_modules/@cursor/july/dist/internal/otel/runtime.js", import.meta.url), "utf8");
  assert.match(source, /temporalityPreference: AggregationTemporality\.DELTA/);
  assert.equal(source.includes("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"), false, "July has no temporality knob");
});

after(async () => {
  await runtime.shutdown();
});

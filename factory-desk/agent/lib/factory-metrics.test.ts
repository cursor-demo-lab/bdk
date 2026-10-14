import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { metrics } from "@opentelemetry/api";
import { countTicketMerged, DELIVERY_DURATION_BUCKETS_MS, DELIVERY_DURATION_METRIC, HOSTED_EXECUTION_DURATION_BUCKETS_MS, HOSTED_EXECUTION_DURATION_METRIC, TICKET_MERGED_METRIC, traceFactory } from "./factory-otel.js";
import { lifeId, otlpHeaders } from "./factory-metrics.js";

// The factory's cumulative meter provider (factory-metrics.ts), loaded the way
// July loads it: through agent/otel.ts, against a local collector whose OTLP
// bodies are decoded with the proto definitions the exporter itself ships.

for (const name of Object.keys(process.env)) if (name.startsWith("OTEL_")) delete process.env[name];
process.env.AGENT_SERVE_GENERATION = "7";

type Decoded = { resource: Record<string, unknown>; metrics: Record<string, { type: string; temporality: number | undefined; monotonic: boolean | undefined; points: Array<{ attributes: Record<string, unknown>; value?: number; bounds?: number[]; counts?: number[] }> }> };
type Hit = { path: string; authorization: string | undefined; body: Buffer };

const require = createRequire(import.meta.url);
const root = require("@opentelemetry/otlp-transformer/build/src/generated/root.js") as { opentelemetry: { proto: { collector: { metrics: { v1: { ExportMetricsServiceRequest: { decode(bytes: Uint8Array): { toJSON(): unknown } } } } } } } };

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
const ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/otlp`;

await import("../otel.js");
const provider = metrics.getMeterProvider() as unknown as { forceFlush(): Promise<void> };

function attributesOf(list: Array<{ key: string; value: Record<string, unknown> }> | undefined): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map((entry) => [entry.key, Object.values(entry.value)[0]]));
}

function decode(hit: Hit): Decoded {
  const request = root.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest.decode(hit.body).toJSON() as {
    resourceMetrics: Array<{ resource: { attributes: never }; scopeMetrics: Array<{ metrics: Array<Record<string, any>> }> }>;
  };
  const out: Decoded = { resource: attributesOf(request.resourceMetrics[0]!.resource.attributes), metrics: {} };
  for (const metric of request.resourceMetrics.flatMap((r) => r.scopeMetrics).flatMap((s) => s.metrics)) {
    const kind = metric["sum"] !== undefined ? "sum" : metric["histogram"] !== undefined ? "histogram" : "gauge";
    const body = metric[kind] as { aggregationTemporality?: number | string; isMonotonic?: boolean; dataPoints: Array<Record<string, any>> };
    const temporality = body.aggregationTemporality === "AGGREGATION_TEMPORALITY_CUMULATIVE" ? 2 : body.aggregationTemporality === "AGGREGATION_TEMPORALITY_DELTA" ? 1 : (body.aggregationTemporality as number | undefined);
    out.metrics[metric["name"]] = {
      type: kind,
      temporality,
      monotonic: body.isMonotonic,
      points: body.dataPoints.map((point) => ({
        attributes: attributesOf(point["attributes"]),
        ...(kind === "sum" ? { value: Number(point["asInt"] ?? point["asDouble"] ?? 0) } : {}),
        ...(kind === "histogram" ? { bounds: point["explicitBounds"], counts: (point["bucketCounts"] ?? []).map(Number) } : {}),
      })),
    };
  }
  return out;
}

const metricPosts = () => hits.filter((hit) => hit.path === "/otlp/v1/metrics");
const AUTH = `Basic ${Buffer.from("123456:glc_FAKE").toString("base64")}`;
const LIFE = Symbol.for("apj_factory.otel.life");

test("otlpHeaders splits at the first = and decodes each value as July does", () => {
  assert.deepEqual(otlpHeaders({ OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20MTIz,x-scope=a=b" }), { Authorization: "Basic MTIz", "x-scope": "a=b" });
  assert.deepEqual(otlpHeaders({ OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic MTIzOmdsY19h==,bad,=x,y=%E0%A4%A" }), { Authorization: "Basic MTIzOmdsY19h==", y: "%E0%A4%A" });
  assert.deepEqual(otlpHeaders({}), {});
});

test("nothing records a value at startup, so a flush with the header set sends nothing and draws no id", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH}`;
  await provider.forceFlush();
  assert.equal(metricPosts().length, 0, "no instrument is touched at startup: a new life has no snapshot totals to carry, which is why there is no rebase");
  assert.equal((globalThis as { [LIFE]?: string })[LIFE], undefined);
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
});

test("with the header unset a recorded counter is not sent and draws no id", async () => {
  countTicketMerged("TLSSN-1");
  await provider.forceFlush();
  assert.equal(metricPosts().length, 0);
  assert.equal((globalThis as { [LIFE]?: string })[LIFE], undefined);
});

test("with the header set an export is CUMULATIVE under the slug, the namespace, the stage, and this life's instance id, with the header decoded", async () => {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${AUTH.replace(" ", "%20")}`;
  countTicketMerged("TLSSN-1");
  await provider.forceFlush();
  const [post] = metricPosts();
  assert.ok(post, "an export was sent");
  assert.equal(post.authorization, AUTH);
  const first = decode(post);
  assert.equal(first.resource["service.name"], "factory-desk");
  assert.equal(first.resource["service.namespace"], "software-factory");
  assert.match(String(first.resource["service.instance.id"]), /^[0-9a-f]{32}$/);
  assert.equal(first.resource["deployment.environment"], "production");
  assert.equal(first.resource["factory.slug"], "factory-desk");
  assert.deepEqual(Object.keys(first.resource).sort(), ["deployment.environment", "deployment.environment.name", "factory.slug", "service.instance.id", "service.name", "service.namespace"]);
  const merged = first.metrics[TICKET_MERGED_METRIC]!;
  assert.equal(merged.type, "sum");
  assert.equal(merged.monotonic, true);
  assert.equal(merged.temporality, 2, "CUMULATIVE: Grafana Cloud answers 400 to DELTA (invalid temporality and type combination)");
  assert.deepEqual(merged.points.map((point) => [point.attributes["factory.ticket.key"], point.value]), [["TLSSN-1", 2]], "the total since the process began, the unsent count included");

  countTicketMerged("TLSSN-1");
  await provider.forceFlush();
  const second = decode(metricPosts()[1]!);
  assert.equal(second.resource["service.instance.id"], first.resource["service.instance.id"], "one id per process life");
  assert.deepEqual(second.metrics[TICKET_MERGED_METRIC]!.points.map((point) => point.value), [3], "cumulative: the next export carries the running total");
});

test("the header is read on every export: a rotated value is on the next request", async () => {
  const rotated = `Basic ${Buffer.from("123456:glc_ROTATED").toString("base64")}`;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${rotated}`;
  countTicketMerged("TLSSN-2");
  await provider.forceFlush();
  assert.equal(metricPosts().at(-1)!.authorization, rotated);
});

test("the factory's delivery histogram has its own buckets by advice, and July's hosted-execution histogram gets its buckets from the one View", async () => {
  await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, async () => "done");
  const meter = metrics.getMeter("agent_sdk");
  meter.createHistogram(HOSTED_EXECUTION_DURATION_METRIC, { unit: "ms" }).record(900_000, { phase: "total" });
  meter.createHistogram("agent_sdk.http.duration", { unit: "ms" }).record(5);
  await provider.forceFlush();
  const sent = decode(metricPosts().at(-1)!);
  assert.deepEqual(sent.metrics[DELIVERY_DURATION_METRIC]!.points[0]!.bounds, [...DELIVERY_DURATION_BUCKETS_MS]);
  const exec = sent.metrics[HOSTED_EXECUTION_DURATION_METRIC]!;
  assert.deepEqual(exec.points[0]!.bounds, [...HOSTED_EXECUTION_DURATION_BUCKETS_MS]);
  assert.equal(exec.points[0]!.counts?.at(-1), 0, "a 15 min run is inside the buckets, not in +Inf");
  assert.equal(exec.temporality, 2);
  assert.equal(sent.metrics["agent_sdk.http.duration"]!.points[0]!.bounds?.at(-1), 10_000, "every other instrument keeps the OTel default");
});

test("July's labels are not dropped: no View means the session ids reach the series, within the SDK's cardinality limit", async () => {
  const counter = metrics.getMeter("agent_sdk").createCounter("cursor.token.usage");
  counter.add(5, { "cursor.token.type": "input", "agent_sdk.session_id": "ses_a", "cursor.conversation.id": "ses_a", "factory.ticket.key": "TLSSN-1" });
  await provider.forceFlush();
  const point = decode(metricPosts().at(-1)!).metrics["cursor.token.usage"]!.points[0]!;
  assert.equal(point.attributes["agent_sdk.session_id"], "ses_a");
  assert.equal(point.attributes["factory.ticket.key"], "TLSSN-1");
});

test("two process lives draw different ids (a fresh kernel read, the clocks, and the pid, not a generator a snapshot could clone)", () => {
  const dir = fileURLToPath(new URL("../../", import.meta.url));
  const draw = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import { lifeId } from "./agent/lib/factory-metrics.ts"; process.stdout.write(lifeId() + lifeId());'], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  const [a, b] = [draw(), draw()];
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^([0-9a-f]{32})\1$/, "one id per life, the same on every call");
  assert.notEqual(a.stdout, b.stdout);
  assert.match(lifeId(), /^[0-9a-f]{32}$/);
});

test("when another meter provider already holds the global slot, installFactoryMeter says so in one console line and leaves that provider alone; with a free slot it is silent", () => {
  const dir = fileURLToPath(new URL("../../", import.meta.url));
  const run = (before: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { metrics } from "@opentelemetry/api";
         import { MeterProvider } from "@opentelemetry/sdk-metrics";
         import { installFactoryMeter } from "./agent/lib/factory-metrics.ts";
         ${before}
         installFactoryMeter();
         installFactoryMeter();
         process.stdout.write(String(metrics.getMeterProvider() === (globalThis.__other ?? metrics.getMeterProvider())));`,
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
    );
  const taken = run("globalThis.__other = new MeterProvider(); metrics.setGlobalMeterProvider(globalThis.__other);");
  assert.equal(taken.status, 0, taken.stderr);
  assert.equal(taken.stdout, "true", "the other provider is still the global one");
  assert.equal(taken.stderr.trim(), "[factory:otel] MeterProvider already registered; factory metrics are not exported", "one line, not one per call");
  const free = run("");
  assert.equal(free.status, 0, free.stderr);
  assert.equal(free.stderr, "");
});

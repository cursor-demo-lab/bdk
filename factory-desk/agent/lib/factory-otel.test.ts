import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { beforeEach, mock, test } from "node:test";
import { context, trace, TraceFlags, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  capExportTimeouts,
  currentFactoryConfig,
  describeDispatch,
  describeResponse,
  drawnInstanceId,
  EXPORT_TIMEOUT_MS,
  exportConfigured,
  factoryOtelConfig,
  GRAFANA_OTLP_ENDPOINT,
  noteFactory,
  otlpEndpoint,
  parseOtelHeaders,
  parseResourceAttributes,
  registerFactoryTracerProvider,
  RESTORE_SKEW_MS,
  SIGNALS_BUDGET_MS,
  traced,
  tracedGithubHook,
  traceFactory,
  wakeInstanceId,
  type WakeSources,
} from "./factory-otel.js";
import { consoleRecord, factoryOtelResolver } from "./factory-otel-signals.js";
import { factorySlug } from "./kv-keys.js";

/** A token-shaped fixture, built from parts so no secret scanner mistakes the source for a real credential. */
function fake(...parts: string[]): string {
  return parts.join("");
}

// The shared factory OTel helpers (every agent carries a byte-identical copy,
// scripts/copies-parity.test.mjs). Spans are checked through a real SDK
// provider with an in-memory exporter, handed to the factory the way
// lib/factory-otel-signals.ts hands it its own; July's provider is stood in
// for by one with July's sampler (ParentBased) and no exporter.

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
/** July's sampler: a child of an unsampled parent is never recorded. */
const julyProvider = new BasicTracerProvider({ sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(1) }) });

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// The resolver test installs the factory's real provider; every test starts on the in-memory one.
beforeEach(() => registerFactoryTracerProvider(provider));

test("with no tracer provider registered every helper is a silent pass-through", async () => {
  registerFactoryTracerProvider(undefined);
  assert.equal(await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => 7), 7);
  noteFactory({ ticketKey: "TLSSN-1", outcome: "ok" });
  await assert.rejects(traceFactory({ span: "factory.reminder", kind: "reminder.x" }, () => Promise.reject(new Error("boom"))), /boom/);
});

function spans(): ReadableSpan[] {
  const finished = exporter.getFinishedSpans();
  exporter.reset();
  return finished;
}

function only(): ReadableSpan {
  const finished = spans();
  assert.equal(finished.length, 1);
  return finished[0]!;
}

const LIFE = Symbol.for("apj_factory.otel.life");
const HEADER = { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic x" };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fresh process life: no id drawn yet, as in a VM that has not served a request since its restore. */
function newLife(): void {
  delete (globalThis as { [LIFE]?: unknown })[LIFE];
}

/** Wake sources whose kernel pool, clocks, and counter are exactly the same on every call: a VM restored with everything cloned. */
function clonedSources(skew: { ms: number } = { ms: 0 }): WakeSources {
  return { kernel: (length) => Buffer.alloc(length, 7), ambient: () => "frozen", skew: () => skew.ms };
}

test("no service.instance.id is drawn, or exported, while the header is unset", () => {
  newLife();
  assert.equal(currentFactoryConfig({}).resourceAttributes?.["service.instance.id"], undefined);
  assert.equal(drawnInstanceId(), undefined, "nothing a snapshot could freeze");
});

test("with the header set every call carries the same version-4 service.instance.id, drawn once", () => {
  newLife();
  const first = currentFactoryConfig(HEADER).resourceAttributes?.["service.instance.id"];
  assert.match(String(first), UUID_V4);
  assert.equal(currentFactoryConfig(HEADER).resourceAttributes?.["service.instance.id"], first);
  assert.equal(drawnInstanceId(), first);
});

test("an OTEL_RESOURCE_ATTRIBUTES service.instance.id is honoured, and none is drawn", () => {
  newLife();
  const config = currentFactoryConfig({ ...HEADER, OTEL_RESOURCE_ATTRIBUTES: "service.instance.id=pod-a,team=apj" });
  assert.equal(config.resourceAttributes?.["service.instance.id"], "pod-a");
  assert.equal(config.resourceAttributes?.team, "apj");
  assert.equal(drawnInstanceId(), undefined);
});

test("two lives restored from one snapshot draw different instance ids even when the kernel pool, clocks, and counter are cloned: the request's inbound span tells them apart", async () => {
  const sources = clonedSources();
  const draw = (input: { traceId: string; spanId: string }) => {
    newLife();
    const inbound = trace.setSpanContext(context.active(), { ...input, traceFlags: TraceFlags.NONE, isRemote: true });
    return context.with(inbound, () => wakeInstanceId({ sources }));
  };
  const a = draw({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" });
  const b = draw({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" });
  assert.match(a, UUID_V4);
  assert.notEqual(a, b);
  newLife();
  assert.equal(wakeInstanceId({ sources }), wakeInstanceId({ sources }), "within one life the id does not change");
});

/** The `{"otel":"instance_id"}` lines written while `run` executes. */
function instanceIdLog<R>(run: () => R): { result: R; reasons: string[] } {
  const info = mock.method(console, "info", () => undefined);
  try {
    const result = run();
    const reasons = info.mock.calls.flatMap((call) => {
      const line = JSON.parse(String(call.arguments[0])) as { otel?: string; reason?: string };
      return line.otel === "instance_id" && line.reason !== undefined ? [line.reason] : [];
    });
    return { result, reasons };
  } finally {
    info.mock.restore();
  }
}

/** Runs `run` as one request: Cursor's backend gave it these inbound span ids. */
function inRequest<R>(input: { spanId: string; run: () => R }): R {
  const inbound = trace.setSpanContext(context.active(), { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: input.spanId, traceFlags: TraceFlags.NONE, isRemote: true });
  return context.with(inbound, input.run);
}

function randomSources(skew: { ms: number }): WakeSources {
  return { kernel: (length) => randomBytes(length), ambient: () => String(Math.random()), skew: () => skew.ms };
}

test("a step in wall minus monotonic clock beyond RESTORE_SKEW_MS seen in a request (a paused VM resumed with its clock set) draws a new instance id; drift below it does not", () => {
  newLife();
  const skew = { ms: 1_000 };
  const sources = randomSources(skew);
  const first = inRequest({ spanId: "b7ad6b7169203331", run: () => wakeInstanceId({ sources }) });
  for (const step of [100, 900, 2_000, 4_000]) {
    skew.ms += step;
    assert.equal(inRequest({ spanId: "b7ad6b7169203332", run: () => wakeInstanceId({ sources }) }), first, `a ${step} ms drift is the same life`);
  }
  skew.ms += RESTORE_SKEW_MS + 1;
  const second = inRequest({ spanId: "b7ad6b7169203333", run: () => wakeInstanceId({ sources }) });
  assert.notEqual(second, first, "a step over the threshold is a new life");
  assert.equal(inRequest({ spanId: "b7ad6b7169203334", run: () => wakeInstanceId({ sources }) }), second);
  skew.ms -= RESTORE_SKEW_MS + 1;
  assert.notEqual(inRequest({ spanId: "b7ad6b7169203335", run: () => wakeInstanceId({ sources }) }), second, "a step back is a new life too");
});

test("a clock step seen outside a request (a timer's export) keeps the id and marks it stale; the next call that has a salt draws the new one, once", () => {
  newLife();
  const skew = { ms: 1_000 };
  const sources = randomSources(skew);
  const { result: first } = instanceIdLog(() => inRequest({ spanId: "b7ad6b7169203331", run: () => wakeInstanceId({ sources }) }));
  skew.ms += RESTORE_SKEW_MS + 1;
  const timer = instanceIdLog(() => [wakeInstanceId({ sources }), wakeInstanceId({ sources }), wakeInstanceId({ sources })]);
  assert.deepEqual(timer.result, [first, first, first], "no salt: no new draw, so no clone draws alike from a cloned state");
  assert.deepEqual(timer.reasons, ["skew_pending"], "one line for the step, not one per call");
  const request = instanceIdLog(() => inRequest({ spanId: "00f067aa0ba902b7", run: () => wakeInstanceId({ sources }) }));
  assert.notEqual(request.result, first, "the first salted call after the step draws");
  assert.deepEqual(request.reasons, ["salted_after_unsalted"]);
  const later = instanceIdLog(() => [wakeInstanceId({ sources }), inRequest({ spanId: "00f067aa0ba902b8", run: () => wakeInstanceId({ sources }) })]);
  assert.deepEqual(later.result, [request.result, request.result], "and then it holds");
  assert.deepEqual(later.reasons, []);
});

test("two VMs resumed from one frozen life with cloned kernel pool, clocks, and counter: timer exports keep the shared id, and each draws its own at its first request", () => {
  const skew = { ms: 1_000 };
  const sources = clonedSources(skew);
  newLife();
  const frozenId = instanceIdLog(() => inRequest({ spanId: "b7ad6b7169203331", run: () => wakeInstanceId({ sources }) })).result;
  const frozen = { ...(globalThis as { [LIFE]?: object })[LIFE] };
  const resume = (spanId: string) => {
    (globalThis as { [LIFE]?: object })[LIFE] = { ...frozen };
    skew.ms = 1_000 + RESTORE_SKEW_MS + 1;
    assert.equal(instanceIdLog(() => wakeInstanceId({ sources })).result, frozenId, "a timer's export still carries the id the snapshot held");
    return instanceIdLog(() => inRequest({ spanId, run: () => wakeInstanceId({ sources }) })).result;
  };
  const a = resume("b7ad6b7169203340");
  const b = resume("00f067aa0ba90240");
  assert.match(a, UUID_V4);
  assert.notEqual(a, frozenId);
  assert.notEqual(a, b);
});

test("a first draw with no salt (a timer's export first after a restore) is replaced by the next call that has one", () => {
  newLife();
  const sources = randomSources({ ms: 0 });
  const first = instanceIdLog(() => [wakeInstanceId({ sources }), wakeInstanceId({ sources })]);
  assert.equal(first.result[0], first.result[1]);
  assert.deepEqual(first.reasons, ["first_unsalted"]);
  const request = instanceIdLog(() => inRequest({ spanId: "b7ad6b7169203331", run: () => wakeInstanceId({ sources }) }));
  assert.notEqual(request.result, first.result[0]);
  assert.deepEqual(request.reasons, ["salted_after_unsalted"]);
  assert.equal(wakeInstanceId({ sources }), request.result);
});

test("a first draw in a request is final, and every draw writes one `otel` log line", () => {
  newLife();
  const sources = randomSources({ ms: 0 });
  const drawn = instanceIdLog(() => [inRequest({ spanId: "b7ad6b7169203331", run: () => wakeInstanceId({ sources }) }), wakeInstanceId({ sources })]);
  assert.equal(drawn.result[0], drawn.result[1]);
  assert.deepEqual(drawn.reasons, ["first"]);
  const line = JSON.stringify({ otel: "instance_id", reason: "first" });
  const record = consoleRecord(line);
  assert.deepEqual(record, { body: line, attributes: {} }, "the JSON stays in the body; nothing is parsed out");
});

test("factoryOtelConfig names the slug's service and stage, and env overrides win", () => {
  assert.deepEqual(factoryOtelConfig({ env: {}, slug: "factory-worker" }), {
    serviceName: "factory-worker",
    resourceAttributes: {
      "service.namespace": "software-factory",
      "deployment.environment": "production",
      "deployment.environment.name": "production",
      "factory.slug": "factory-worker",
    },
  });
  const staging = factoryOtelConfig({ env: { FACTORY_ENV: "staging" }, slug: "factory-worker" });
  assert.equal(staging.serviceName, "factory-worker-staging");
  assert.equal(staging.resourceAttributes?.["deployment.environment"], "staging");
  const overridden = factoryOtelConfig({ env: { OTEL_SERVICE_NAME: "custom", OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod-au,team=apj%20fe" }, slug: "factory-desk" });
  assert.equal(overridden.serviceName, "custom");
  assert.equal(overridden.resourceAttributes?.["deployment.environment"], "prod-au");
  assert.equal(overridden.resourceAttributes?.["team"], "apj fe");
  assert.equal(factoryOtelConfig({ env: {} }).serviceName, "software-factory");
  assert.equal(factoryOtelConfig({ env: {} }).resourceAttributes?.["factory.slug"], undefined);
});

test("the config carries no exporter, endpoint, or header: those stay in OTEL_* env", () => {
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com/otlp", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic c2VjcmV0" };
  const text = JSON.stringify(factoryOtelConfig({ env, slug: "factory-desk" }));
  assert.equal(text.includes("grafana"), false);
  assert.equal(text.includes("c2VjcmV0"), false);
  assert.equal("exporters" in factoryOtelConfig({ env, slug: "factory-desk" }), false);
});

test("the resolver's first call (defineOtel's snapshot) is slug-free; later calls name this slug while it is the only mount", () => {
  const resolve = factoryOtelResolver();
  const first = resolve();
  assert.equal(first.serviceName, "software-factory");
  assert.deepEqual(first.logs, { userPrompts: true, toolContent: true }, "July exports prompts and tool content");
  assert.equal(resolve().serviceName, factorySlug);
  assert.deepEqual(resolve().logs, { userPrompts: true, toolContent: true });
  const holder = globalThis as { [key: symbol]: Set<string> | undefined };
  holder[Symbol.for("apj_factory.otel.mounts")]?.add("factory-planner");
  assert.equal(resolve().serviceName, "software-factory");
  holder[Symbol.for("apj_factory.otel.mounts")]?.delete("factory-planner");
});

test("the resolver installs the factory's tracer provider: nothing is recorded while the header is unset", async () => {
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  factoryOtelResolver();
  let recorded: boolean | undefined;
  await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => {
    recorded = trace.getActiveSpan()?.isRecording();
  });
  assert.equal(recorded, false);
  assert.equal(spans().length, 0, "the in-memory provider was not used");
});

test("parseResourceAttributes skips malformed pairs", () => {
  assert.deepEqual(parseResourceAttributes("a=1,,=x,b, c = 2 ,d=%E0%A4%A"), { a: "1", c: "2", d: "%E0%A4%A" });
  assert.deepEqual(parseResourceAttributes(undefined), {});
});

test("traceFactory records kind, ticket, and the note taken inside, over describe", async () => {
  const result = await traceFactory(
    { span: "factory.reminder", kind: "reminder.implement_pr", ticketKey: "TLSSN-7", describe: () => ({ outcome: "skip", reason: "described" }) },
    async () => {
      noteFactory({ outcome: "opened", agentId: "bc-123" });
      return { action: "stop" };
    }
  );
  assert.deepEqual(result, { action: "stop" });
  const span = only();
  assert.equal(span.name, "factory.reminder");
  assert.equal(span.attributes["factory.delivery.kind"], "reminder.implement_pr");
  assert.equal(span.attributes["factory.ticket.key"], "TLSSN-7");
  assert.equal(span.attributes["factory.outcome"], "opened");
  assert.equal(span.attributes["factory.reason"], "described");
  assert.equal(span.attributes["factory.cloud_agent.id"], "bc-123");
  assert.equal(span.status.code, 1);
});

test("a throw records error.type, reason, and the error message, and rethrows", async () => {
  const message = "token ghp_abcdef123 rejected by https://api.example.com";
  class LaunchNotStartedError extends Error {
    readonly reason = "rate_limited";
    constructor() {
      super(message);
      this.name = "LaunchNotStartedError";
    }
  }
  await assert.rejects(traceFactory({ span: "factory.cloud_agent.launch", kind: "cloud_agent.launch", ticketKey: "TLSSN-9" }, () => Promise.reject(new LaunchNotStartedError())), LaunchNotStartedError);
  const span = only();
  assert.equal(span.status.code, 2);
  assert.equal(span.status.message, message);
  assert.equal(span.attributes["error.type"], "LaunchNotStartedError");
  assert.equal(span.attributes["error.message"], message);
  assert.equal(span.attributes["factory.outcome"], "error");
  assert.equal(span.attributes["factory.reason"], "rate_limited");
  assert.ok(JSON.stringify(span.attributes).includes("ghp_"));
});

test("span notes pass through as emitted, including free text and malformed ticket keys", async () => {
  await traceFactory({ span: "factory.delivery", kind: "slack message with spaces", ticketKey: "not a key" }, () => {
    noteFactory({ outcome: "has spaces in it", reason: "Bearer xoxb-123 secret", ticketKey: "tlssn-1", pr: "cursor-demo-lab/marsbank#12" });
  });
  const span = only();
  assert.equal(span.attributes["factory.delivery.kind"], "slack message with spaces");
  assert.equal(span.attributes["factory.ticket.key"], "tlssn-1");
  assert.equal(span.attributes["factory.reason"], "Bearer xoxb-123 secret");
  assert.equal(span.attributes["factory.outcome"], "has spaces in it");
  assert.equal(span.attributes["factory.pr"], "cursor-demo-lab/marsbank#12");
});

test("token-shaped values, Slack ids, emails, URLs, and long runs pass through on span notes", async () => {
  const passed = [
    "xoxb-1234-5678-abcdef",
    "xoxp-1-2-3",
    "xapp-1-A0-123",
    fake("gh", "p_", "abcdefghijklmnop"),
    "gho_abc123",
    fake("github", "_pat_", "11ABCDEF"),
    "glc_eyJvIjoiMTIzIn0",
    fake("gl", "sa_", "AbCdEfGh1234567890IjKlMnOpQrSt", "_9f8e7d6c"),
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    "sk-abcdef123456",
    fake("sk", "_live_", "51HxYzAbCdEf1234567890"),
    fake("rk", "_test_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2"),
    fake("np", "m_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
    fake("AK", "IAABCDEFGHIJKL"),
    fake("0123456789abcdef", "0123456789abcdef", "01234567"),
    "token:ghp_abcdef",
    "U0123ABCDE9",
    "W0123ABCDE9",
    "C0EXAMPLE1",
    "<OPERATOR_EMAIL>",
    "https://grafana.example/x",
    "otlp://collector:4318",
    "a".repeat(65),
    "a".repeat(24),
  ];
  for (const value of passed) {
    await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => noteFactory({ outcome: value, reason: value, pr: value, agentId: value }));
    const span = only();
    for (const key of ["factory.outcome", "factory.reason", "factory.pr", "factory.cloud_agent.id"]) {
      assert.equal(span.attributes[key], value, `${key} dropped ${value}`);
    }
  }
  for (const value of ["task-assessment", "launch_timeout", "plan:posted", "cursor-demo-lab/marsbank#152", "bc-e2e-0001", "jira:issue_updated"]) {
    await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => noteFactory({ reason: value }));
    assert.equal(only().attributes["factory.reason"], value);
  }
});

test("an export may take twice a cold TLS handshake (about 0.9 s to the AU gateway), and a delivery waits a little longer than one export", () => {
  assert.ok(EXPORT_TIMEOUT_MS >= 1_800, `${EXPORT_TIMEOUT_MS} ms is under two cold handshakes`);
  assert.ok(SIGNALS_BUDGET_MS > EXPORT_TIMEOUT_MS, "a timed-out export reports back before the wait gives up");
  assert.ok(SIGNALS_BUDGET_MS <= EXPORT_TIMEOUT_MS + 500, "and the wait stays bounded");
});

test("capExportTimeouts caps each signal's export timeout at EXPORT_TIMEOUT_MS and keeps a smaller one", () => {
  const env: NodeJS.ProcessEnv = { OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "800", OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: "30000" };
  capExportTimeouts(env);
  assert.equal(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT, String(EXPORT_TIMEOUT_MS));
  assert.equal(env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT, String(EXPORT_TIMEOUT_MS));
  assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT, "800");
  const shared: NodeJS.ProcessEnv = { OTEL_EXPORTER_OTLP_TIMEOUT: "900" };
  capExportTimeouts(shared);
  assert.equal(shared.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT, undefined);
});

test("the header is the only switch, and the endpoint defaults to the Grafana gateway", () => {
  assert.equal(exportConfigured({}), false);
  assert.equal(exportConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://x/otlp" }), false, "an endpoint alone sends nothing");
  assert.equal(exportConfigured({ OTEL_EXPORTER_OTLP_HEADERS: "  " }), false);
  assert.equal(exportConfigured({ OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic MTpn" }), true);
  assert.equal(otlpEndpoint({}), GRAFANA_OTLP_ENDPOINT);
  assert.equal(GRAFANA_OTLP_ENDPOINT, "https://otlp.example.com/otlp");
  assert.equal(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/otlp/v1/traces" }), "http://127.0.0.1:4318/otlp");
  assert.equal(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/otlp/" }), "http://127.0.0.1:4318/otlp");
});

test("parseOtelHeaders splits at the first = and decodes nothing, as July does", () => {
  assert.deepEqual(parseOtelHeaders("Authorization=Basic MTIzOmdsY19h==,x-scope=a"), { Authorization: "Basic MTIzOmdsY19h==", "x-scope": "a" });
  assert.deepEqual(parseOtelHeaders("Authorization=Basic%20MTIz"), { Authorization: "Basic%20MTIz" }, "Grafana's Python snippet stays encoded, and Grafana answers 401");
});

test("traced passes arguments and the Response through, and describeResponse reads only whitelisted fields", async () => {
  const handler = traced({ span: "factory.delivery", kind: "jira.webhook", describe: describeResponse }, async (input: { status: number }) =>
    Response.json({ ok: true, launching: true, issueKey: "TLSSN-51", message: "secret text" }, { status: input.status })
  );
  const response = await handler({ status: 202 });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, launching: true, issueKey: "TLSSN-51", message: "secret text" });
  const span = only();
  assert.equal(span.attributes["factory.outcome"], "launching");
  assert.equal(span.attributes["factory.ticket.key"], "TLSSN-51");
  assert.equal(JSON.stringify(span.attributes).includes("secret"), false);
});

test("describeResponse outcomes", async () => {
  assert.deepEqual(await describeResponse(Response.json({ ok: false }, { status: 401 })), { outcome: "http_401" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, ignored: true, reason: "not_approved" })), { outcome: "ignored", reason: "not_approved" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, kind: "approved", issueKey: "TLSSN-2" })), { outcome: "approved", ticketKey: "TLSSN-2" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, identifier: "TLSSN-3" })), { outcome: "accepted", ticketKey: "TLSSN-3" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, started: false, reason: "question" })), { outcome: "not_started", reason: "question" });
  assert.deepEqual(await describeResponse(Response.json({ ok: true, duplicate: true, issueKey: "TLSSN-4" })), { outcome: "duplicate", ticketKey: "TLSSN-4" });
  assert.deepEqual(await describeResponse(Response.json({ pr: "x", bcId: "bc-9", status: "running" })), { outcome: "accepted", agentId: "bc-9" });
  assert.deepEqual(await describeResponse(new Response("plain")), { outcome: "accepted" });
});

test("describeDispatch", () => {
  assert.deepEqual(describeDispatch(null), { outcome: "skipped" });
  assert.deepEqual(describeDispatch({ task: () => undefined }), { outcome: "task" });
  assert.deepEqual(describeDispatch({ auth: null }), { outcome: "turn" });
});

test("tracedGithubHook tags the PR and runs a returned task in its own span", async () => {
  let ran = 0;
  const hook = tracedGithubHook("github.pull_request", (_ctx: { repository: { fullName: string } }, _pr: { number: number }) => ({
    task: async () => {
      ran += 1;
      noteFactory({ ticketKey: "TLSSN-12", outcome: "announced" });
    },
  }));
  const dispatch = await hook({ repository: { fullName: "cursor-demo-lab/marsbank" } }, { number: 42 });
  const delivery = only();
  assert.equal(delivery.name, "factory.delivery");
  assert.equal(delivery.attributes["factory.outcome"], "task");
  assert.equal(delivery.attributes["factory.pr"], "cursor-demo-lab/marsbank#42");
  await dispatch.task();
  assert.equal(ran, 1);
  const task = only();
  assert.equal(task.name, "factory.github.task");
  assert.equal(task.attributes["factory.pr"], "cursor-demo-lab/marsbank#42");
  assert.equal(task.attributes["factory.ticket.key"], "TLSSN-12");
  assert.equal(task.attributes["factory.outcome"], "announced");

  const skipped = tracedGithubHook("github.check_suite", () => null);
  assert.equal(await skipped(), null);
  assert.equal(only().attributes["factory.outcome"], "skipped");
});

const INBOUND = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" };

/**
 * `work` inside a July-shaped `agent_sdk.http` span whose parent is an
 * inbound request the caller did not sample (Cursor's backend, 96% of the
 * time) or did. July's own span is then not recording, as in production.
 */
async function insideHttpSpan<R>(input: { sampled: boolean; work: (http: Span) => Promise<R> }): Promise<R> {
  const remote = trace.setSpanContext(context.active(), { ...INBOUND, traceFlags: input.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE, isRemote: true });
  return context.with(remote, () =>
    julyProvider.getTracer("agent_sdk").startActiveSpan("agent_sdk.http", async (http) => {
      try {
        return await input.work(http);
      } finally {
        http.end();
      }
    })
  );
}

test("under an unsampled inbound parent July's own span is not recording, and a factory span is: a new root linked to it", async () => {
  await insideHttpSpan({
    sampled: false,
    work: async (http) => {
      assert.equal(http.isRecording(), false, "the premise: a child of an unsampled parent is dropped");
      await traceFactory({ span: "factory.delivery", kind: "jira.webhook", ticketKey: "TLSSN-3" }, () => {
        assert.equal(trace.getActiveSpan()?.isRecording(), true);
      });
      const span = only();
      assert.equal(span.name, "factory.delivery");
      assert.equal(span.parentSpanContext, undefined, "a root, not a child of agent_sdk.http");
      assert.notEqual(span.spanContext().traceId, INBOUND.traceId, "its own trace");
      assert.equal(span.spanContext().traceFlags & TraceFlags.SAMPLED, TraceFlags.SAMPLED);
      assert.equal(span.links.length, 1);
      assert.deepEqual(
        { traceId: span.links[0]?.context.traceId, spanId: span.links[0]?.context.spanId },
        { traceId: http.spanContext().traceId, spanId: http.spanContext().spanId },
        "the link is the inbound span July opened"
      );
      assert.equal(span.attributes["factory.ticket.key"], "TLSSN-3");
    },
  });
});

test("every kind of factory span is a linked root under a sampled inbound parent too", async () => {
  await insideHttpSpan({
    sampled: true,
    work: async (http) => {
      for (const name of ["factory.delivery", "factory.background", "factory.github.task", "factory.schedule", "factory.reminder", "factory.cloud_agent.launch"] as const) {
        await traceFactory({ span: name, kind: "test.kind" }, () => undefined);
        const span = only();
        assert.equal(span.name, name);
        assert.equal(span.parentSpanContext, undefined, `${name} is a root`);
        assert.equal(span.links[0]?.context.spanId, http.spanContext().spanId, `${name} links to the inbound span`);
      }
    },
  });
});

test("children of a factory span share its trace and nest under it; only the root carries the link", async () => {
  await insideHttpSpan({
    sampled: false,
    work: async () => {
      await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, async () => {
        await traceFactory({ span: "factory.cloud_agent.launch", kind: "cloud_agent.launch" }, async () => {
          await traceFactory({ span: "factory.background", kind: "deep" }, () => undefined);
        });
        await traceFactory({ span: "factory.github.task", kind: "second.child" }, () => undefined);
      });
    },
  });
  const finished = spans();
  assert.deepEqual(finished.map((span) => span.name), ["factory.background", "factory.cloud_agent.launch", "factory.github.task", "factory.delivery"]);
  const [deep, launch, task, root] = finished as [ReadableSpan, ReadableSpan, ReadableSpan, ReadableSpan];
  const traceId = root.spanContext().traceId;
  for (const span of finished) assert.equal(span.spanContext().traceId, traceId, `${span.name} shares the root's trace id`);
  assert.equal(root.parentSpanContext, undefined);
  assert.equal(root.links.length, 1);
  assert.equal(launch.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(task.parentSpanContext?.spanId, root.spanContext().spanId);
  assert.equal(deep.parentSpanContext?.spanId, launch.spanContext().spanId);
  for (const child of [deep, launch, task]) assert.equal(child.links.length, 0, `${child.name} is a plain child`);
});

test("with no inbound span a factory span is a root with no link", async () => {
  await traceFactory({ span: "factory.schedule", kind: "schedule.hop-watch" }, () => undefined);
  const span = only();
  assert.equal(span.parentSpanContext, undefined);
  assert.deepEqual(span.links, []);
});

test("an invalid inbound span context is not linked", async () => {
  const invalid = trace.setSpanContext(context.active(), { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: TraceFlags.NONE });
  await context.with(invalid, () => traceFactory({ span: "factory.reminder", kind: "reminder.x" }, () => undefined));
  assert.deepEqual(only().links, []);
});

test("work a handler hands to waitUntil, started inside the delivery and ending after it, joins the delivery's trace", async () => {
  let background: Promise<void> | undefined;
  await traceFactory({ span: "factory.delivery", kind: "jira.webhook" }, () => {
    background = traceFactory({ span: "factory.background", kind: "jira.triage_wake" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });
  const delivery = only();
  await background;
  const wake = only();
  assert.equal(wake.name, "factory.background");
  assert.equal(wake.spanContext().traceId, delivery.spanContext().traceId);
  assert.equal(wake.parentSpanContext?.spanId, delivery.spanContext().spanId);
});

test("tracedGithubHook: the delivery is a linked root and the task, run later in the delivery's context, is its child", async () => {
  const hook = tracedGithubHook("github.check_suite", (_ctx: { repository: { fullName: string } }, _suite: { number: number }) => ({ task: async () => undefined }));
  const dispatch = await insideHttpSpan({ sampled: false, work: async () => hook({ repository: { fullName: "cursor-demo-lab/marsbank" } }, { number: 7 }) });
  await dispatch.task();
  const [delivery, task] = spans() as [ReadableSpan, ReadableSpan];
  assert.equal(delivery.name, "factory.delivery");
  assert.equal(delivery.links.length, 1);
  assert.equal(task.name, "factory.github.task");
  assert.equal(task.spanContext().traceId, delivery.spanContext().traceId);
  assert.equal(task.parentSpanContext?.spanId, delivery.spanContext().spanId);
});

test("consoleRecord: original body only; no JSON or key=value parse; util.format of every argument, no trim", () => {
  const worker = JSON.stringify({ worker: "decision", outcome: "ignored", reason: "not_approved", text: "hello there", issueKey: "TLSSN-4" });
  assert.deepEqual(consoleRecord(worker), { body: worker, attributes: {} });
  const tagged = "[bdk] hosted admission received deliveryId=dlv_1 channelId=jira eventType=jira:issue_updated";
  assert.deepEqual(consoleRecord(tagged), { body: tagged, attributes: {} }, "deliveryId and eventType stay in the body");
  const planner = "[planner] webhook status TLSSN-1 planned (changelog 7)";
  assert.deepEqual(consoleRecord(planner), { body: planner, attributes: {} });
  const desk = "[factory-desk] please approve this now";
  assert.deepEqual(consoleRecord(desk), { body: desk, attributes: {} });
  const otel = "[bdk:otel] error: export failed";
  assert.deepEqual(consoleRecord(otel), { body: otel, attributes: {} });
  assert.deepEqual(consoleRecord("[slack-text] hello"), { body: "[slack-text] hello", attributes: {} });
  assert.deepEqual(consoleRecord("free text with no tag"), { body: "free text with no tag", attributes: {} });
  assert.deepEqual(consoleRecord("{not json"), { body: "{not json", attributes: {} });
  assert.equal(consoleRecord("  padded  ").body, "  padded  ");
  const err = new Error("ERROR_ARG_MARK");
  const record = consoleRecord("[factory-desk] hop-watch failed:", err);
  assert.ok(record.body.includes("[factory-desk] hop-watch failed:"));
  assert.ok(record.body.includes("ERROR_ARG_MARK"), "a later Error reaches the body");
  assert.deepEqual(record.attributes, {});
});

test("consoleRecord: planner turn_model fields reach Grafana in the original body, not as extracted attributes", () => {
  const line = JSON.stringify({
    planner: "turn_model",
    outcome: "completed",
    sessionId: "ses_plan",
    issueKey: "TLSSN-22",
    model: "claude-4.6-sonnet",
    costUsd: 0.5,
    pricedFrom: "usage",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
  });
  const record = consoleRecord(line);
  assert.equal(record.body, line);
  assert.deepEqual(record.attributes, {});
  assert.match(record.body, /"model":"claude-4.6-sonnet"/);
  assert.match(record.body, /"costUsd":0.5/);
  assert.match(record.body, /"pricedFrom":"usage"/);
  assert.match(record.body, /"inputTokens":10/);
});

test("consoleRecord: fields that used to be scrubbed stay in the original body", () => {
  const token = fake("xoxb-", "1234-5678-abcdef");
  const glsa = fake("gl", "sa_", "AbCdEfGh1234567890IjKlMnOpQrSt", "_9f8e7d6c");
  const line = JSON.stringify({ desk: "inbound", slackText: "approve TLSSN-1 please", reactor: "U0123ABCDE9", reason: glsa, note: token });
  const record = consoleRecord(line);
  assert.equal(record.body, line);
  assert.deepEqual(record.attributes, {});
  assert.ok(record.body.includes(token) && record.body.includes(glsa) && record.body.includes("approve TLSSN-1 please"));
});

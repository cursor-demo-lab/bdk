import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { metrics, ProxyTracerProvider, trace, type Meter, type TracerProvider } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import hook from "../hooks/zz-otel-turn-flush.js";
import { factorySignalsSettled, factorySpanExporter, flushFactorySignals } from "./factory-otel-signals.js";

// Characterizes how @cursor/july 0.2.22 ends a session turn on the wire, for
// the two telemetry gaps found in the 2026-10-03 live audit (finding N3), and
// pins the July internals they come from (docs/july-otel-upstream.md
// sections 3, 4, 11, and 12); like july-otel.test.ts, this test fails first
// when a July upgrade changes them.
//
// - A tool span with no `cursor.tool.status` (factory-security-reviewer, tool
//   GetDynamicTools): July opens an `agent_sdk.tool` span on
//   `actions.requested` and sets the status attribute only on `action.result`.
//   A call that never gets a result is ended by `turn.completed`'s
//   `endOpenChildren` (collector.js) with neither the attribute nor a span
//   status.
// - Missing turn spans and turn counts (the planner turn that ended 17:38:44
//   UTC): July ends the turn span and adds to `agent_sdk.turn.count` on
//   `turn.completed`, and nothing July awaits before the hosted reply exports
//   either. Before Bug 6b July recorded its spans in memory, and two flushes
//   that overlapped dropped a turn span that ended during the first one's
//   export (`reset()`, section 4). Under the 6b exception the factory's
//   tracer provider is the global one, and the resolver gives July no
//   signal exporter, so 0.2.22 builds no local provider and no memory
//   buffer, and its spans wait in the factory's
//   span queue. July's `forceFlush` flushes only providers July built, so it
//   exports neither the turn span nor the count: the factory's flushes do
//   (agent/hooks/zz-otel-turn-flush.ts, section 12): the setImmediate flush
//   scheduled from `turn.completed`, and the flush awaited from
//   `session.waiting`, which July dispatches after the turn's end and the
//   hosted reply waits for (Bug 6a). The overlap that lost spans on July's
//   memory path is replayed below against the factory's queue, where it
//   loses none.
//
// If a July-pinning assertion fails after a July upgrade, check whether July
// changed how it adopts a global tracer or fixed the gap
// (docs/july-otel-upstream.md sections 4/11/12). If so, flip the assertion to
// pin the new behaviour and update the doc section; if not, re-derive the
// dist line references. UPGRADE below is appended to each such assertion's
// message.
//
// The turn counter is cumulative, and each case that looks for a count counts
// its turn under its own agent name. July's runtime is internal (no package
// export), so it is loaded by path. The collector stands in for Grafana: it
// answers after a set delay per path.

for (const name of Object.keys(process.env)) if (name.startsWith("OTEL_")) delete process.env[name];

type Hit = { path: string; body: string };

const hits: Hit[] = [];
let traceDelayMs = 0;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    hits.push({ path: req.url ?? "", body: Buffer.concat(chunks).toString("latin1") });
    const reply = () => {
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    };
    if (req.url === "/otlp/v1/traces" && traceDelayMs > 0) setTimeout(reply, traceDelayMs).unref();
    else reply();
  });
});
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/otlp`;

type JulyRuntime = { forceFlush(): Promise<void>; meter?: Meter; logger?: Logger };
type SessionEvent = Record<string, unknown>;
type Collector = { onEvent(event: SessionEvent, session: Record<string, unknown>): void; close(): void };
const july = (file: string) => new URL(`../../node_modules/@cursor/july/dist/internal/otel/${file}`, import.meta.url).href;
const { resolveOtelConfig } = (await import(july("config.js"))) as { resolveOtelConfig: (input: { authored: unknown }) => unknown };
const { createOtelRuntime } = (await import(july("runtime.js"))) as {
  createOtelRuntime: (config: unknown, log: (line: string) => void, options: { resolveExport: () => unknown }) => JulyRuntime | undefined;
};
const { createOtelCollector } = (await import(july("collector.js"))) as {
  createOtelCollector: (runtime: JulyRuntime, agentName: string, log: (line: string) => void) => Collector;
};
const { default: authored } = (await import("../otel.js")) as { default: unknown };

const UPGRADE =
  "If this fails after a July upgrade, check whether July changed how it adopts a global tracer or fixed the gap (docs/july-otel-upstream.md sections 4/11/12). If so, flip the assertion to pin the new behaviour and update the doc section; if not, re-derive the dist line references.";
const pin = (what: string): string => `${what}. ${UPGRADE}`;

// Every span the factory's exporter is handed, by name, whatever the collector answers.
const exported: string[] = [];
const exportSpans = factorySpanExporter.export.bind(factorySpanExporter);
factorySpanExporter.export = (spans: ReadableSpan[], done) => {
  exported.push(...spans.map((span) => span.name));
  exportSpans(spans, done);
};

const julyLog: string[] = [];
const resolveExport = () => resolveOtelConfig({ authored });
const runtime = createOtelRuntime(resolveExport(), (line) => julyLog.push(line), { resolveExport })!;
const collector = createOtelCollector(runtime, "factory-desk", (line) => julyLog.push(line));

// A hosted pod's secrets bind after startup, per request.
process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic RkFLRTpGQUtF";

let sequence = 0;
const session = { id: "ses_turnend", channelId: "http", mode: "task", purpose: "live", auth: null };
const emitter = (target: Collector, sessionId: string) => (turnId: string, type: string, data: Record<string, unknown>): void => {
  target.onEvent({ index: (sequence += 1), sessionId, at: new Date().toISOString(), turnId, type, data }, { ...session, id: sessionId });
};
const emit = emitter(collector, session.id);
const call = (callId: string, toolName: string) => ({ callId, toolName, args: {} });
const usage = (tokens: number) => ({ usage: { inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0 } });
const TURN_SPAN = "agent_sdk.usage.input_tokens";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function posts(path: string): string[] {
  return hits.filter((hit) => hit.path === `/otlp/v1/${path}`).map((hit) => hit.body);
}

function occurrences(input: { path: string; word: string }): number {
  return posts(input.path).reduce((sum, body) => sum + body.split(input.word).length - 1, 0);
}

type HookHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

/** July's order at a turn's end (session-engine.js): `turn.completed`'s hooks are awaited, then the collector counts the turn and ends its span. */
async function turnCompletedHook(turnId: string): Promise<void> {
  await (hook.events["turn.completed"] as unknown as HookHandler)({ type: "turn.completed", turnId, data: {} }, {});
}

/** What the hosted reply waits for after the turn's end: July's dispatch chain awaits `session.waiting`'s hooks, then waitForCompletion returns. */
async function sessionWaitingHook(turnId: string): Promise<void> {
  await (hook.events["session.waiting"] as unknown as HookHandler)({ type: "session.waiting", turnId, data: {} }, {});
}

function factoryTracerProvider(): TracerProvider {
  return (globalThis as { [key: symbol]: { tracerProvider: TracerProvider } | undefined })[Symbol.for("apj_factory.otel.signals")]!.tracerProvider;
}

test("July 0.2.22 uses the factory's global tracer: no local BDK provider, no span recorded in memory, and July's own flush at the reply exports neither the turn span nor the turn count; the session.waiting flush does, through the factory's exporter, before the reply", { timeout: 20_000 }, async () => {
  const global = trace.getTracerProvider();
  assert.ok(global instanceof ProxyTracerProvider && global.getDelegate() === factoryTracerProvider(), "the global tracer provider is the factory's");
  assert.equal(julyLog.some((line) => line.includes("export on a local provider")), false, pin("July attached no local tracer (0.2.22 would otherwise keep one with frozen headers)"));
  assert.equal(julyLog.some((line) => line.includes("otel recording")), false, pin("July built no in-memory span buffer"));

  hits.length = 0;
  exported.length = 0;
  const counted = createOtelCollector(runtime, "adopted-agent", (line) => julyLog.push(line));
  try {
    const turn = emitter(counted, "ses_adopted");
    turn("turn_c", "turn.started", {});
    turn("turn_c", "actions.requested", { calls: [call("call_c1", "SearchC")] });
    turn("turn_c", "action.result", { callId: "call_c1", toolName: "SearchC", output: { text: "ok" }, isError: false });
    turn("turn_c", "turn.completed", usage(9));

    // What a hosted execution awaits before its reply (hosted-delivery.js `afterHostedWork`).
    await runtime.forceFlush();
    assert.equal(posts("traces").length, 0, pin("July's forceFlush sends no span: it flushes only providers July built"));
    assert.equal(occurrences({ path: "metrics", word: "adopted-agent" }), 0, pin("nor the turn count: it skips the adopted meter provider"));

    await sessionWaitingHook("turn_c");
    assert.equal(occurrences({ path: "traces", word: TURN_SPAN }), 1, "the awaited session flush exported the turn span, once, before the reply");
    assert.ok(occurrences({ path: "traces", word: "SearchC" }) >= 1, "and its tool span");
    assert.ok(exported.includes("agent_sdk.turn") && exported.includes("agent_sdk.tool"), "through the factory's span exporter");
    assert.ok(occurrences({ path: "metrics", word: "adopted-agent" }) >= 1, "and the turn count (agent_sdk.turn.count under the turn's agent)");
  } finally {
    counted.close();
    await factorySignalsSettled();
  }
});

test("a factory flush in flight when the turn ends, the overlap that dropped a turn span on July's memory path, loses nothing: the session.waiting flush joins the next flush and exports the turn span once", { timeout: 30_000 }, async () => {
  await factorySignalsSettled();
  hits.length = 0;
  traceDelayMs = 400;
  try {
    emit("turn_b", "turn.started", {});
    emit("turn_b", "actions.requested", { calls: [call("call_b1", "SearchB")] });
    emit("turn_b", "action.result", { callId: "call_b1", toolName: "SearchB", output: { text: "ok" }, isError: false });

    // Another hosted delivery's flush takes the finished tool span and is
    // still exporting it when the turn ends.
    const overlapping = flushFactorySignals();
    await sleep(100);
    emit("turn_b", "turn.completed", usage(7));
    assert.equal(occurrences({ path: "traces", word: TURN_SPAN }), 0, "the running export took only what had ended");

    await sessionWaitingHook("turn_b");
    assert.equal(occurrences({ path: "traces", word: TURN_SPAN }), 1, "the turn span that ended during the running export left on the next one, before the reply");
    await overlapping;
    await factorySignalsSettled();
    await sleep(400);
    assert.equal(occurrences({ path: "traces", word: TURN_SPAN }), 1, "and was sent once");
    assert.equal(occurrences({ path: "traces", word: "SearchB" }), 1, "as was the tool span the running export carried");
  } finally {
    traceDelayMs = 0;
  }
});

test("factory mitigation: the turn.completed hook's deferred flush exports the turn count and the turn span in the overlapping-flush scenario, with no session flush at all", { timeout: 30_000 }, async () => {
  await factorySignalsSettled();
  hits.length = 0;
  traceDelayMs = 400;
  const mitigated = createOtelCollector(runtime, "mitigated-agent", (line) => julyLog.push(line));
  const mitigatedEmit = emitter(mitigated, "ses_mitigated");
  const sent = (): boolean => posts("metrics").some((body) => body.includes("mitigated-agent"));
  try {
    mitigatedEmit("turn_m", "turn.started", {});
    // A finished tool span from the other collector fills the span queue, so the overlapping flush has something to send.
    emit("turn_m_tools", "turn.started", {});
    emit("turn_m_tools", "actions.requested", { calls: [call("call_m1", "SearchM")] });
    emit("turn_m_tools", "action.result", { callId: "call_m1", toolName: "SearchM", output: { text: "ok" }, isError: false });

    // This case proves the export in the overlap (a flush joining the running
    // one would also pass if the hook flushed synchronously); the next case
    // proves the ordering. Another delivery's flush is exporting, and it
    // collected the meter before the turn is counted.
    const overlapping = flushFactorySignals();
    await sleep(100);

    await turnCompletedHook("turn_m");
    assert.equal(sent(), false, "nothing about the turn has been exported yet");
    mitigatedEmit("turn_m", "turn.completed", usage(11));

    // Not a session flush: only the immediate the hook scheduled, which has
    // not run yet when the collector has already counted the turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await overlapping;
    traceDelayMs = 0;
    await factorySignalsSettled();
    assert.ok(sent(), "the hook's flush exported the turn count (agent_sdk.turn.count under the turn's agent)");
    assert.ok(posts("metrics").some((body) => body.includes("agent_sdk.turn.count")), "and it is the turn counter");
    assert.equal(occurrences({ path: "traces", word: TURN_SPAN }), 1, "and the turn span: no reset() race in the factory's queue");
  } finally {
    traceDelayMs = 0;
    mitigated.close();
  }
});

test("factory mitigation: with no flush running, the meter is collected only after July's collector has counted the turn, and the export carries it", { timeout: 20_000 }, async () => {
  await factorySignalsSettled();
  hits.length = 0;
  const ordered = createOtelCollector(runtime, "ordered-agent", (line) => julyLog.push(line));
  const orderedEmit = emitter(ordered, "ses_ordered");
  // This pins the behaviour (the meter is collected after the collector counts
  // the turn), not the macrotask mechanism: a microtask-deferred flush also
  // passes under sdk-metrics 2.11. otel-turn-flush.test.ts pins setImmediate.
  // An observable gauge's callback runs when the factory's meter is collected,
  // so it timestamps (in sequence) when a flush reads the counters.
  const order: string[] = [];
  const gauge = metrics.getMeter("turn-end-test").createObservableGauge("apj_factory.test.collection");
  const onCollect = (): void => {
    order.push("collected");
  };
  gauge.addCallback(onCollect);
  try {
    orderedEmit("turn_o", "turn.started", {});
    await turnCompletedHook("turn_o");
    order.push("hook returned");
    orderedEmit("turn_o", "turn.completed", {});
    order.push("counted");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await factorySignalsSettled();
    assert.deepEqual(order.slice(0, 3), ["hook returned", "counted", "collected"], "the hook must not collect the meter before July's collector has counted the turn (a synchronous flush from the hook collects first)");
    assert.ok(
      posts("metrics").some((body) => body.includes("ordered-agent")),
      "the turn counted after the hook returned is in the flush the hook scheduled",
    );
  } finally {
    gauge.removeCallback(onCollect);
    ordered.close();
  }
});

test("factory mitigation (Bug 6a): the session.waiting hook's awaited flush has exported the turn count and the turn span when it returns, before the reply, in the overlapping-flush scenario", { timeout: 30_000 }, async () => {
  await factorySignalsSettled();
  hits.length = 0;
  traceDelayMs = 400;
  const sessionCollector = createOtelCollector(runtime, "session-end-agent", (line) => julyLog.push(line));
  const sessionEmit = emitter(sessionCollector, "ses_session_end");
  const sent = (): boolean => posts("metrics").some((body) => body.includes("session-end-agent"));
  try {
    sessionEmit("turn_s", "turn.started", {});
    emit("turn_s_tools", "turn.started", {});
    emit("turn_s_tools", "actions.requested", { calls: [call("call_s1", "SearchS")] });
    emit("turn_s_tools", "action.result", { callId: "call_s1", toolName: "SearchS", output: { text: "ok" }, isError: false });

    // Another delivery's flush is exporting, and it collected the meter before the turn is counted.
    const overlapping = flushFactorySignals();
    await sleep(100);

    // July's dispatch chain at turn end (session-engine.js): turn.completed reaches
    // the collector, which counts the turn; then session.waiting's hooks are awaited.
    // The turn hook's scheduled flush is left out, so only the awaited one can export.
    sessionEmit("turn_s", "turn.completed", usage(13));
    assert.equal(sent(), false, "nothing about the turn has been exported yet");
    await sessionWaitingHook("turn_s");
    sessionEmit("turn_s", "session.waiting", {});

    // waitForCompletion has awaited the chain, so afterHostedWork returns the reply now.
    assert.ok(sent(), "the awaited session flush exported the turn count before the reply returned");
    assert.ok(posts("metrics").some((body) => body.includes("agent_sdk.turn.count")), "and it is the turn counter");
    assert.equal(occurrences({ path: "traces", word: TURN_SPAN }), 1, "and the turn span");
    await overlapping;
  } finally {
    traceDelayMs = 0;
    sessionCollector.close();
    await factorySignalsSettled();
  }
});

test("July 0.2.22: a tool call that never gets an action.result is ended with cursor.tool.status=unknown", { timeout: 20_000 }, async () => {
  await factorySignalsSettled();
  hits.length = 0;
  emit("turn_a", "turn.started", {});
  emit("turn_a", "actions.requested", { calls: [call("call_done", "ReadDone")] });
  emit("turn_a", "action.result", { callId: "call_done", toolName: "ReadDone", output: { text: "ok" }, isError: false });
  emit("turn_a", "actions.requested", { calls: [call("call_open", "GetDynamicToolsOpen")] });
  emit("turn_a", "turn.completed", usage(1));
  await sessionWaitingHook("turn_a");

  assert.equal(occurrences({ path: "traces", word: "ReadDone" }), 1, pin("the completed call's span left once"));
  assert.equal(occurrences({ path: "traces", word: "GetDynamicToolsOpen" }), 1, pin("as did the one with no result"));
  assert.equal(occurrences({ path: "traces", word: "cursor.tool.status" }), 2, pin("0.2.22 stamps status on both: the completed call, and unknown + ERROR no result on the open one"));
  assert.equal(occurrences({ path: "traces", word: "unknown" }) >= 1, true, pin("the open call is cursor.tool.status=unknown"));
  assert.ok(julyLog.every((line) => !line.includes("collector failed")), "the collector did not fail");
});

after(() => {
  collector.close();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  server.closeAllConnections();
  server.close();
});

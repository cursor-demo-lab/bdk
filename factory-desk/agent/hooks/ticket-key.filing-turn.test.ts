import assert from "node:assert/strict";
import { test } from "node:test";
import type { Meter } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { HostKvApi, HostOtelApi } from "@cursor/july";
import { TICKET_KEY_ATTRIBUTE } from "../lib/factory-otel.js";
import hook from "./ticket-key.js";

// The desk's filing turn, end to end through July's own pieces: the
// `action.result` a server tool produces (event-mapper.js describeToolResult
// over the SDK's MCP text result: the tool's object as a JSON STRING, not an
// object), the hook, the collector, and a plain meter provider. A real
// file_ticket result must re-tag the turn, or the filing turn's usage stays
// `none` until the next turn reads the key from kv.

const internal = (file: string) => new URL(`../../node_modules/@cursor/july/dist/internal/${file}`, import.meta.url).href;
const { describeToolResult } = (await import(internal("event-mapper.js"))) as { describeToolResult: (toolCall: unknown) => { output?: unknown; isError: boolean } };
const { createOtelCollector } = (await import(internal("otel/collector.js"))) as {
  createOtelCollector: (
    runtime: { tracer: unknown; meter: Meter; config: { enabled: true; logs: false } },
    agentName: string,
    log: (line: string) => void,
  ) => { onEvent(event: Record<string, unknown>, session: Record<string, unknown>): void; close(): void };
};
const { createHostOtelApi } = (await import(internal("host-otel.js"))) as {
  createHostOtelApi: (options: { agentName: string; meter?: () => Meter | undefined; collector?: unknown; sessionId?: string }) => Pick<HostOtelApi, "enabled" | "increment" | "setAttributes">;
};

type Handler = (event: { turnId?: string; data: Record<string, unknown> }, ctx: unknown) => Promise<void> | void;
const events = hook.events as unknown as Record<string, Handler>;

const THREAD = { channelId: "C0123456789", threadTs: "1727000000.000100" } as const;
const FILED = {
  created: true,
  reason: "created",
  issueKey: "TLSSN-46",
  project: "TLSSN",
  url: "https://example.atlassian.net/browse/TLSSN-46",
  reply: "[TLSSN-46](https://example.atlassian.net/browse/TLSSN-46) is filed.",
  threadBound: true,
};

/**
 * The `action.result` output July hands a hook for a server tool, built here
 * in the MCP result shape July's describeToolResult reads
 * (`{ content: [{ text: { text } }], isError }`) with the tool's object as
 * the JSON text; describeToolResult joins the text parts into one string.
 */
function julyOutputFor(result: unknown): unknown {
  const described = describeToolResult({
    type: "mcp",
    args: { providerIdentifier: "agentsdk-tools", toolName: "file_ticket", args: {} },
    result: { status: "success", value: { content: [{ text: { text: JSON.stringify(result) } }], isError: false } },
  });
  assert.equal(described.isError, false);
  return described.output;
}

test("the filing turn: July's string output of file_ticket re-tags the turn, and its token and turn samples and its turn and tool spans carry the new key, not `none`", async () => {
  const spans = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 })] });
  const meter = meterProvider.getMeter("agent_sdk");
  const julyLog: string[] = [];
  const collector = createOtelCollector({ tracer: tracerProvider.getTracer("agent_sdk"), meter, config: { enabled: true, logs: false } }, "factory-desk", (line) => julyLog.push(line));
  const sessionId = "ses_filing";
  const turnId = "trn_filing";
  const session = { id: sessionId, channelId: "slack", mode: "chat", purpose: "live", auth: null };
  const at = new Date().toISOString();
  try {
    const kv: HostKvApi = { get: async () => undefined as never, put: async () => undefined, delete: async () => undefined };
    const otel = createHostOtelApi({ agentName: "factory-desk", meter: () => meter, collector, sessionId });
    const ctx = { session: { id: sessionId, channelId: "slack", auth: { attributes: { channel_id: THREAD.channelId, thread_ts: THREAD.threadTs } } }, channel: { id: "slack", continuationToken: null }, host: { kv, otel } };

    // July dispatches each event hook-first, then to the collector (session-engine.js dispatchEvent).
    collector.onEvent({ index: 0, sessionId, at, type: "session.started", data: { channelId: "slack" } }, session);
    await events["turn.started"]!({ turnId, data: {} }, ctx);
    collector.onEvent({ index: 1, sessionId, at, turnId, type: "turn.started", data: {} }, session);
    collector.onEvent({ index: 2, sessionId, at, turnId, type: "actions.requested", data: { calls: [{ callId: "call_1", toolName: "file_ticket", args: { title: "CSV export returns 500" } }] } }, session);
    const output = julyOutputFor(FILED);
    assert.equal(typeof output, "string", "July's output for a server tool is the SDK's MCP text: a JSON string, the shape the hook must read");
    assert.equal(JSON.parse(output as string).issueKey, "TLSSN-46");
    await events["action.result"]!({ turnId, data: { callId: "call_1", toolName: "file_ticket", output, isError: false } }, ctx);
    collector.onEvent({ index: 3, sessionId, at, turnId, type: "action.result", data: { callId: "call_1", toolName: "file_ticket", output, isError: false } }, session);
    const usage = { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 0, reasoningTokens: 20, totalTokens: 1_050 };
    collector.onEvent({ index: 4, sessionId, at, turnId, type: "turn.completed", data: { status: "completed", usage, cost: { model: "grok-4.6-fast", totalUsd: 0.0123, source: "estimate" } } }, session);
    collector.close();
    await meterProvider.forceFlush();
    await tracerProvider.forceFlush();

    const points = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .flatMap((metric) => metric.dataPoints.map((point) => ({ name: metric.descriptor.name, attributes: { ...point.attributes }, value: point.value as number })));
    const byKey = (name: string) => points.filter((point) => point.name === name).map((point) => [point.attributes[TICKET_KEY_ATTRIBUTE], point.value] as const);
    assert.deepEqual(
      points.filter((point) => point.name === "cursor.token.usage").map((point) => [point.attributes[TICKET_KEY_ATTRIBUTE], point.attributes["cursor.token.type"], point.value]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      [
        ["TLSSN-46", "cache_read", 600],
        ["TLSSN-46", "input", 1_000],
        ["TLSSN-46", "output", 50],
        ["TLSSN-46", "reasoning", 20],
      ],
      "the filing turn's whole token usage lands on the key filed mid-turn, none of it on `none`",
    );
    assert.equal(points.some((point) => point.name === "cursor.cost.usage"), false, "the 0.2.25 collector creates no cost counter (otel/collector.js:703-720)");
    assert.deepEqual(byKey("agent_sdk.turn.count"), [["TLSSN-46", 1]]);
    assert.equal(points.some((point) => point.attributes[TICKET_KEY_ATTRIBUTE] === "none"), false, "no sample of the turn is `none`");
    for (const point of points.filter((point) => point.name === "cursor.tool.calls")) {
      assert.equal(point.attributes[TICKET_KEY_ATTRIBUTE], "TLSSN-46", "with no View, July's tool counter carries the session's ticket tag too");
    }

    const finished = spans.getFinishedSpans();
    const named = (name: string) => finished.filter((span) => span.name === name);
    assert.equal(named("agent_sdk.turn").length, 1);
    assert.equal(named("agent_sdk.tool").length, 1);
    assert.equal(named("agent_sdk.turn")[0]!.attributes[TICKET_KEY_ATTRIBUTE], "TLSSN-46", "paintOpenSpans re-painted the open turn span");
    assert.equal(named("agent_sdk.tool")[0]!.attributes[TICKET_KEY_ATTRIBUTE], "TLSSN-46", "and the open tool span");
    assert.deepEqual(julyLog, [], "the collector saw nothing to complain about");
  } finally {
    await meterProvider.shutdown();
    await tracerProvider.shutdown();
  }
});

test("issueKeyOf through July's describeToolResult: the JSON string of a result that names a key, a result without one, and an error result", async () => {
  const { issueKeyOf } = await import("./ticket-key.js");
  assert.equal(issueKeyOf(julyOutputFor(FILED)), "TLSSN-46");
  assert.equal(issueKeyOf(julyOutputFor({ approved: false, issueKey: "TLSSN-46", status: "not_originator" })), "TLSSN-46", "a refusal still names the ticket the turn was about");
  assert.equal(issueKeyOf(julyOutputFor({ created: false, reason: "already_filing", title: "x" })), undefined);
  assert.equal(issueKeyOf(julyOutputFor({ status: "Planned" })), undefined);
  assert.equal(issueKeyOf(julyOutputFor({ issueKey: "issue:TLSSN-46#1" })), undefined, "only a Jira key");
  const failed = describeToolResult({ type: "mcp", args: { providerIdentifier: "agentsdk-tools", toolName: "file_ticket", args: {} }, result: { status: "error", error: "Tool \"file_ticket\" failed: boom" } });
  assert.equal(failed.isError, true);
  assert.equal(issueKeyOf(failed.output), undefined);
});

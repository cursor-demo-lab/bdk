import assert from "node:assert/strict";
import { test } from "node:test";
import { context, metrics, type Meter } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, type MetricData } from "@opentelemetry/sdk-metrics";
import type { HostOtelApi } from "@cursor/july";
import {
  countTicketMerged,
  isJiraIssueKey,
  isTicketLabelled,
  JIRA_ISSUE_KEY,
  NO_TICKET,
  OTHER_TICKET,
  tagSessionTicket,
  TICKET_KEY_ATTRIBUTE,
  TICKET_LABELLED_METRICS,
  TICKET_MERGED_METRIC,
  ticketLabel,
  ticketLabelledContext,
} from "./factory-otel.js";
import { factoryMeterProvider, METRIC_ATTRIBUTE_KEYS, METRIC_CARDINALITY_LIMIT, metricAttributes } from "./factory-otel-signals.js";
import { OPS_METRIC } from "./ops-funnel.js";

// The ticket label on token usage (factory-otel.ts, "Ticket on token
// usage"): the bounded value, tagSessionTicket, the worker's merged
// counter, and the factory View that keeps the label on TICKET_LABELLED_METRICS
// only (July's token and turn counters, the merged counter), while
// July's `cursor.tool.calls` and the factory's ops metric leave without it,
// whatever their samples or a session's tag bag carried. Its own file, like
// factory-otel.buckets.test.ts: it registers the global meter provider.
// How the tag reaches July's collector, its spans and these counters is
// july-otel.test.ts.

const hostOtel = new URL("../../node_modules/@cursor/july/dist/internal/host-otel.js", import.meta.url).href;
const { createHostOtelApi } = (await import(hostOtel)) as {
  createHostOtelApi: (options: { agentName: string; meter?: Meter; collector?: unknown; sessionId?: string }) => Pick<HostOtelApi, "enabled" | "increment" | "setAttributes">;
};

/** A session's tag bag and ids, as July's collector `join` merges them into every sample of the session. */
const julySample = (sessionId: string, ticket: string | undefined, rest: Record<string, string>) => ({
  ...(ticket === undefined ? {} : { [TICKET_KEY_ATTRIBUTE]: ticket }),
  "cursor.conversation.id": sessionId,
  "agent_sdk.session_id": sessionId,
  "agent_sdk.agent": "factory-desk",
  ...rest,
});

function pointsNamed(exporter: InMemoryMetricExporter, name: string): MetricData["dataPoints"] {
  const all = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name);
  return all.at(-1)?.dataPoints ?? [];
}

test("ticketLabel: a Jira key is itself, no ticket is `none`, and any other value is `other`", () => {
  for (const key of ["TLSSN-1", "TLSSN-123456789", "A-1", "AB12CD34EF-9", "X1-42"]) {
    assert.equal(ticketLabel(key), key, key);
    assert.ok(isJiraIssueKey(key), key);
  }
  for (const none of [undefined, null, "", NO_TICKET]) assert.equal(ticketLabel(none), NO_TICKET, JSON.stringify(none));
  for (const other of [
    "tlssn-1",
    "TLSSN-",
    "TLSSN-1a",
    " TLSSN-1",
    "issue:TLSSN-1#1",
    "cont:TLSSN-1",
    "pr:acme/repo#3",
    "ABCDEFGHIJK-1",
    "TLSSN-1234567890",
    "1TLSSN-1",
    "ses_0123456789abcdef",
    "approve TLSSN-1 please",
    42,
    true,
    { issueKey: "TLSSN-1" },
    ["TLSSN-1"],
  ]) {
    assert.equal(ticketLabel(other), OTHER_TICKET, JSON.stringify(other));
    assert.equal(isJiraIssueKey(other), false, JSON.stringify(other));
  }
  assert.equal(JIRA_ISSUE_KEY.flags, "", "no global flag: a sticky lastIndex would make the second test of one key fail");
});

test("tagSessionTicket writes the bounded label through host.otel.setAttributes, returns it, and never throws", () => {
  const tags: Array<Record<string, unknown>> = [];
  const host = { otel: { setAttributes: (attributes: Record<string, unknown>) => void tags.push(attributes) } };
  assert.equal(tagSessionTicket(host, "TLSSN-7"), "TLSSN-7");
  assert.equal(tagSessionTicket(host, undefined), NO_TICKET);
  assert.equal(tagSessionTicket(host, "issue:TLSSN-7#1"), OTHER_TICKET);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-7" }, { [TICKET_KEY_ATTRIBUTE]: NO_TICKET }, { [TICKET_KEY_ATTRIBUTE]: OTHER_TICKET }]);
  const throwing = {
    otel: {
      setAttributes: () => {
        throw new Error("no collector");
      },
    },
  };
  assert.equal(tagSessionTicket(throwing, "TLSSN-7"), "TLSSN-7");
});

test("metricAttributes keeps factory.ticket.key, bounded, only on a sample recorded in the ticket-labelled context, and drops it, like every session tag, anywhere else", () => {
  assert.equal(METRIC_ATTRIBUTE_KEYS.includes(TICKET_KEY_ATTRIBUTE), false, "not a plain allowlisted key");
  assert.deepEqual([...TICKET_LABELLED_METRICS].sort(), ["agent_sdk.turn.count", TICKET_MERGED_METRIC, "cursor.token.usage"].sort());
  const sample = {
    [TICKET_KEY_ATTRIBUTE]: "TLSSN-7",
    "cursor.token.type": "input",
    "agent_sdk.agent": "factory-desk",
    "cursor.conversation.id": "ses_abc",
    "agent_sdk.session_id": "ses_abc",
    "support.ticket_id": "INC-1",
    "factory.pr": "acme/repo#3",
  };
  assert.deepEqual(metricAttributes(sample), { "cursor.token.type": "input", "agent_sdk.agent": "factory-desk" }, "no context: the key is dropped");
  assert.deepEqual(metricAttributes(sample, context.active()), { "cursor.token.type": "input", "agent_sdk.agent": "factory-desk" }, "a plain context: the same");
  assert.deepEqual(metricAttributes(sample, ticketLabelledContext()), { [TICKET_KEY_ATTRIBUTE]: "TLSSN-7", "cursor.token.type": "input", "agent_sdk.agent": "factory-desk" });
  const ticket = ticketLabelledContext();
  assert.equal(metricAttributes({ [TICKET_KEY_ATTRIBUTE]: "none" }, ticket)[TICKET_KEY_ATTRIBUTE], NO_TICKET);
  assert.equal(metricAttributes({ [TICKET_KEY_ATTRIBUTE]: "" }, ticket)[TICKET_KEY_ATTRIBUTE], NO_TICKET);
  assert.equal(metricAttributes({}, ticket)[TICKET_KEY_ATTRIBUTE], NO_TICKET, "a ticket-labelled instrument always has the label: a turn no hook tagged is `none`");
  for (const stranger of ["ses_0123456789abcdef", "approve TLSSN-7", "x".repeat(60), 42, true]) {
    assert.equal(metricAttributes({ [TICKET_KEY_ATTRIBUTE]: stranger as never }, ticket)[TICKET_KEY_ATTRIBUTE], OTHER_TICKET, JSON.stringify(stranger));
  }
  assert.equal(isTicketLabelled(undefined), false);
  assert.equal(isTicketLabelled(context.active()), false);
  assert.equal(isTicketLabelled(ticket), true);
});

test("through the factory provider, July's token and turn counters keep the session's ticket label, bounded, one series per ticket however many sessions, and without the session ids", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  metrics.setGlobalMeterProvider(provider);
  try {
    // As July's collector creates and records them (0.2.22 collector.js createMetrics, addTokens, join), through metrics.getMeter: the factory's wrapper.
    const meter = metrics.getMeter("agent_sdk");
    const tokens = meter.createCounter("cursor.token.usage");
    const turns = meter.createCounter("agent_sdk.turn.count");
    for (let session = 0; session < 40; session++) {
      tokens.add(100, julySample(`ses_${session}`, "TLSSN-7", { "cursor.token.type": "input" }));
      tokens.add(60, julySample(`ses_${session}`, "TLSSN-7", { "cursor.token.type": "cache_read" }));
      tokens.add(1, julySample(`ses_${session}`, "TLSSN-8", { "cursor.token.type": "input" }));
      tokens.add(2, julySample(`ses_${session}`, undefined, { "cursor.token.type": "input" }));
      turns.add(1, julySample(`ses_${session}`, "TLSSN-7", { "agent_sdk.turn_status": "completed" }));
    }
    tokens.add(3, julySample("ses_x", "issue:TLSSN-7#1", { "cursor.token.type": "input" }));
    await provider.forceFlush();
    const found = pointsNamed(exporter, "cursor.token.usage");
    const series = found.map((point) => `${String(point.attributes[TICKET_KEY_ATTRIBUTE])}/${String(point.attributes["cursor.token.type"])}`).sort();
    assert.deepEqual(series, ["TLSSN-7/cache_read", "TLSSN-7/input", "TLSSN-8/input", "none/input", "other/input"]);
    for (const point of found) assert.deepEqual(Object.keys(point.attributes).sort(), ["agent_sdk.agent", "cursor.token.type", TICKET_KEY_ATTRIBUTE].sort());
    const value = (ticket: string, type: string) => found.find((point) => point.attributes[TICKET_KEY_ATTRIBUTE] === ticket && point.attributes["cursor.token.type"] === type)?.value;
    assert.equal(value("TLSSN-7", "input"), 4_000, "40 sessions' input summed under one ticket series");
    assert.equal(value("TLSSN-7", "cache_read"), 2_400, "cache reads stay their own type: the dashboard prices input - cache_read, so nothing is counted twice here");
    assert.equal(value("TLSSN-8", "input"), 40);
    assert.equal(value("none", "input"), 80, "a session no hook tagged is `none`, a fixed value, not a missing label");
    assert.equal(value("other", "input"), 3);
    const turnCount = pointsNamed(exporter, "agent_sdk.turn.count");
    assert.deepEqual(
      turnCount.map((point) => [point.attributes, point.value]),
      [[{ "agent_sdk.agent": "factory-desk", "agent_sdk.turn_status": "completed", [TICKET_KEY_ATTRIBUTE]: "TLSSN-7" }, 40]],
    );
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
});

test("the label never reaches cursor.tool.calls or the ops metric: July's tool counter and a session-bound host.otel increment of apj_factory.kv.failure leave without factory.ticket.key, whatever the sample or the session's tag bag carried", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  metrics.setGlobalMeterProvider(provider);
  try {
    // As July's collector records a tool call (0.2.18 collector.js action.result): the session's tag bag, the ids, the tool, kind and status, the agent.
    const toolCalls = metrics.getMeter("agent_sdk").createCounter("cursor.tool.calls");
    toolCalls.add(1, julySample("ses_a", "TLSSN-7", { "cursor.tool.name": "file_ticket", "cursor.tool.kind": "server", "cursor.tool.status": "success" }));
    toolCalls.add(1, julySample("ses_b", "TLSSN-8", { "cursor.tool.name": "file_ticket", "cursor.tool.kind": "server", "cursor.tool.status": "success" }));
    // A host.otel bound to a session (July host-otel.js createBoundHostOtelApi) merges the session's tags into every increment it makes.
    // ops-funnel.ts keeps the last bound host for apj_factory.kv.failure, so any session's tags can arrive on it. No collector is attached
    // here, so the tag reaches no span; it only models a bag some session carried.
    const host = createHostOtelApi({ agentName: "factory-desk", meter: metrics.getMeter("agent_sdk"), sessionId: "ses_c" });
    host.setAttributes({ [TICKET_KEY_ATTRIBUTE]: "TLSSN-9", "support.ticket_id": "INC-1" });
    host.increment(OPS_METRIC, { slug: "factory-desk", site: "desk.intake.get", reason: "http_503" });
    await provider.forceFlush();
    const tools = pointsNamed(exporter, "cursor.tool.calls");
    assert.deepEqual(
      tools.map((point) => [point.attributes, point.value]),
      [[{ "agent_sdk.agent": "factory-desk", "cursor.tool.name": "file_ticket", "cursor.tool.kind": "server", "cursor.tool.status": "success" }, 2]],
      "one series per tool, kind and status, as on main: two tickets' calls aggregate",
    );
    const ops = pointsNamed(exporter, OPS_METRIC);
    assert.deepEqual(
      ops.map((point) => [point.attributes, point.value]),
      [[{ "agent_sdk.agent": "factory-desk", slug: "factory-desk", site: "desk.intake.get", reason: "http_503" }, 1]],
      "the bound host's own agent label stays, as on main; the session's ticket tag does not",
    );
    for (const point of [...tools, ...ops]) assert.equal(TICKET_KEY_ATTRIBUTE in point.attributes, false);
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
});

test("countTicketMerged counts one merged ticket under its key on the factory meter, and a non-key under `other`", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  metrics.setGlobalMeterProvider(provider);
  try {
    countTicketMerged("TLSSN-7");
    countTicketMerged("TLSSN-7");
    countTicketMerged("TLSSN-9");
    countTicketMerged("not a key");
    await provider.forceFlush();
    const found = pointsNamed(exporter, TICKET_MERGED_METRIC);
    const byKey = Object.fromEntries(found.map((point) => [String(point.attributes[TICKET_KEY_ATTRIBUTE]), point.value]));
    assert.deepEqual(byKey, { "TLSSN-7": 2, "TLSSN-9": 1, [OTHER_TICKET]: 1 });
    for (const point of found) assert.deepEqual(Object.keys(point.attributes), [TICKET_KEY_ATTRIBUTE]);
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
});

test("countTicketMerged with no meter provider is a silent no-op", () => {
  countTicketMerged("TLSSN-7");
});

test("cardinality (README, Cost per ticket): the 500 cap counts the distinct (ticket, type) sets recorded within one export interval, not a life's; beyond it a turn's tokens land in an unlabelled otel.metric.overflow series, lost to every ticket's row but to no total", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = factoryMeterProvider(exporter);
  metrics.setGlobalMeterProvider(provider);
  const tokens = metrics.getMeter("agent_sdk").createCounter("cursor.token.usage");
  const input = (i: number) => tokens.add(1, julySample(`ses_${i}`, `TLSSN-${i}`, { "cursor.token.type": "input" }));
  try {
    // 800 tickets over two intervals, 400 per interval: well under the cap each time, 800 series for the life.
    for (let i = 0; i < 400; i++) input(i);
    await provider.forceFlush();
    for (let i = 400; i < 800; i++) input(i);
    await provider.forceFlush();
    let found = pointsNamed(exporter, "cursor.token.usage");
    assert.equal(found.length, 800, "a life may hold more series than the cap; the cap is per interval");
    assert.equal(found.some((point) => point.attributes["otel.metric.overflow"] === true), false);
    // One interval with 600 distinct tickets: 499 of them are their own series, the rest one overflow series.
    for (let i = 1_000; i < 1_600; i++) input(i);
    await provider.forceFlush();
    found = pointsNamed(exporter, "cursor.token.usage");
    const overflow = found.filter((point) => point.attributes["otel.metric.overflow"] === true);
    assert.equal(overflow.length, 1);
    assert.deepEqual(Object.keys(overflow[0]!.attributes), ["otel.metric.overflow"], "no ticket, no type, no agent: the overflow series carries no label");
    assert.equal(overflow[0]!.value, 600 - (METRIC_CARDINALITY_LIMIT - 1), "the 500th and later distinct sets of the interval");
    assert.equal(found.length, 800 + (METRIC_CARDINALITY_LIMIT - 1) + 1);
    assert.equal(
      found.reduce((sum, point) => sum + (point.value as number), 0),
      800 + 600,
      "every token is in some series: a sum over all keys still reconciles, a per-ticket row does not",
    );
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
});

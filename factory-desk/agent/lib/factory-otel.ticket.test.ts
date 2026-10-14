import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, type MetricData } from "@opentelemetry/sdk-metrics";
import {
  countTicketMerged,
  isJiraIssueKey,
  JIRA_ISSUE_KEY,
  NO_TICKET,
  OTHER_TICKET,
  tagSessionTicket,
  TICKET_KEY_ATTRIBUTE,
  TICKET_MERGED_METRIC,
  ticketLabel,
} from "./factory-otel.js";

// The ticket label on token usage (factory-otel.ts, "Ticket on token
// usage"): the bounded value, tagSessionTicket, and the worker's merged
// counter on the global meter. Its own file: it registers the global meter
// provider. How the tag reaches July's collector, its spans and counters is
// july-otel.test.ts.

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

test("countTicketMerged counts one merged ticket under its key on the factory meter, and a non-key under `other`", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })] });
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

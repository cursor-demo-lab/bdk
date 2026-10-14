import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, type MetricData } from "@opentelemetry/sdk-metrics";
import { recordImplementation } from "./claim.js";
import { ticketMergedKey } from "./kv-keys.js";
import { TICKET_KEY_ATTRIBUTE, TICKET_MERGED_METRIC } from "./factory-otel.js";
import type { PrDecision } from "./pr-decide.js";
import { advanceTicket } from "./pr-status.js";
import { fakeTracker, memoryKv, type MemoryKv } from "./testing/fakes.js";

// The denominator of cost per merged ticket (observability/grafana/README.md):
// `apj_factory.ticket.merged` counts the one move into Done the merge path
// makes, under the ticket's key, once per ticket (a kv marker), and nothing
// else. Its own file, like the desk's factory-otel.ticket.test.ts: it
// registers the global meter provider.

const NOW = new Date("2026-09-25T00:00:00.000Z");
const ENV: NodeJS.ProcessEnv = { FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_CLAIM_SETTLE_MS: "1" };
const URL = "https://github.com/cursor-demo-lab/marsbank/pull/13";
const PR = "cursor-demo-lab/marsbank#13";
const IN_REVIEW: Extract<PrDecision, { move: true }> = { move: true, stage: "in_review", issueKey: "TLSSN-9", pr: PR, url: URL };
const DONE: Extract<PrDecision, { move: true }> = { move: true, stage: "done", issueKey: "TLSSN-9", pr: PR, url: URL };

async function launchedKv(): Promise<MemoryKv> {
  const kv = memoryKv();
  await recordImplementation(kv, "TLSSN-9", {
    state: "launched",
    at: NOW.toISOString(),
    agentId: "bc-example-1",
    url: "https://cursor.com/agents/bc-example-1",
    commented: true,
    moved: true,
  });
  return kv;
}

async function deps(status: string) {
  const tracker = fakeTracker({ status });
  return { kv: await launchedKv(), mcp: tracker.mcp, env: ENV, now: () => NOW, log: () => undefined };
}

function mergedPoints(exporter: InMemoryMetricExporter): MetricData["dataPoints"] {
  const all = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === TICKET_MERGED_METRIC);
  return all.at(-1)?.dataPoints ?? [];
}

test("a merge that moves the ticket to Done counts it once under its key; the In Review move, a ticket already Done, and a redelivery count nothing", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })] });
  metrics.setGlobalMeterProvider(provider);
  try {
    assert.deepEqual(await advanceTicket(await deps("In Progress"), IN_REVIEW), { outcome: "moved", move: "transitioned", catchUp: false });
    assert.deepEqual(await advanceTicket(await deps("Done"), DONE), { outcome: "moved", move: "already", catchUp: false });
    await provider.forceFlush();
    assert.deepEqual(mergedPoints(exporter), [], "no Done move, no count");

    const merge = await deps("In Review");
    assert.deepEqual(await advanceTicket(merge, DONE), { outcome: "moved", move: "transitioned", catchUp: false });
    assert.deepEqual(await advanceTicket(merge, DONE), { outcome: "duplicate" });
    await provider.forceFlush();
    const found = mergedPoints(exporter);
    assert.deepEqual(
      found.map((point) => [point.attributes, point.value]),
      [[{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-9" }, 1]],
    );
    assert.deepEqual(await merge.kv.get(ticketMergedKey("TLSSN-9")), { at: NOW.toISOString() }, "the first count leaves its marker");

    // The ticket is reopened and a second PR merges: Jira transitions again, the marker makes the count silent.
    const again = { ...(await deps("In Review")), kv: merge.kv };
    const SECOND: Extract<PrDecision, { move: true }> = { ...DONE, pr: "cursor-demo-lab/marsbank#14", url: "https://github.com/cursor-demo-lab/marsbank/pull/14" };
    assert.deepEqual(await advanceTicket(again, SECOND), { outcome: "moved", move: "transitioned", catchUp: false });
    await provider.forceFlush();
    assert.deepEqual(
      mergedPoints(exporter).map((point) => [point.attributes, point.value]),
      [[{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-9" }, 1]],
      "a ticket is one merged ticket however many PRs move it to Done",
    );
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
});

test("a kv that cannot be read still counts the merge (the queries clamp a double count) and never fails the move", async () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })] });
  metrics.setGlobalMeterProvider(provider);
  try {
    const merge = await deps("In Review");
    const kv = merge.kv;
    let broken = false;
    const flaky = {
      get: async (key: string) => {
        if (broken && key.startsWith("ticket-merged/")) throw new Error("kv down");
        return kv.get(key);
      },
      put: async (key: string, value: never) => {
        if (broken && key.startsWith("ticket-merged/")) throw new Error("kv down");
        return kv.put(key, value);
      },
      delete: (key: string) => kv.delete(key),
    };
    broken = true;
    assert.deepEqual(await advanceTicket({ ...merge, kv: flaky as never }, DONE), { outcome: "moved", move: "transitioned", catchUp: false });
    await provider.forceFlush();
    assert.deepEqual(
      mergedPoints(exporter).map((point) => [point.attributes, point.value]),
      [[{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-9" }, 1]],
    );
    assert.equal(await kv.get(ticketMergedKey("TLSSN-9")), undefined, "the marker could not be written");
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
});

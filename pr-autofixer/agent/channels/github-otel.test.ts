import assert from "node:assert/strict";
import { after, test } from "node:test";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { HostKvApi } from "@cursor/july";
import { getGitHubChannelOptions } from "@cursor/july/channels/github";
import { affinityKey } from "../lib/kv-keys.js";
import { githubPrRef } from "../lib/drive.js";

// A wake for a PR whose agent is bound only buffers, so its delivery span
// says `buffered`, and the debounced flush that sends it later has its own
// `factory.background` span (lib/factory-otel.ts). In its own file: it
// registers a global tracer provider.

const REPO = "acme/in-scope";
process.env.FACTORY_REPOS = REPO;
delete process.env.PR_AUTOFIXER_REPOS;
delete process.env.FACTORY_KV_RETRY_PAUSES_MS;

const exporter = new InMemorySpanExporter();
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const channelReady = import("./github.js");
const pr = githubPrRef({ owner: "acme", repo: "in-scope", number: 61, url: `https://github.com/${REPO}/pull/61` });
const store = new Map<string, unknown>([[String(affinityKey(pr)), { bcId: "bc-otel-61", updatedAt: "2026-10-03T00:00:00.000Z" }]]);
const kv: HostKvApi = {
  get: async (key) => store.get(key) as never,
  put: async (key, value) => void store.set(key, value),
  delete: async (key) => void store.delete(key),
};
const sends: string[] = [];
const send = async (message: string) => {
  sends.push(message);
  return { id: "ses_otel", info: {}, waitForCompletion: async () => ({ status: "completed" }) };
};

// Stops the buffer's timers whether or not the test failed.
after(async () => {
  await getGitHubChannelOptions((await channelReady).default)?.onStop?.();
});

test("a bound PR's wake is a `buffered` delivery, and its debounced flush is a background span", { timeout: 20_000 }, async () => {
  const options = getGitHubChannelOptions((await channelReady).default)!;
  await options.onStart?.({ send, host: { kv, github: {} } } as never);
  const ctx = { repository: { owner: "acme", name: "in-scope", fullName: REPO }, payload: {}, host: { kv } };
  const event = { action: "synchronize", number: 61, url: pr.url, headSha: "6".repeat(40), merged: false };
  const dispatch = await options.onPullRequest?.(ctx as never, event as never);
  assert.ok(dispatch !== null && dispatch !== undefined && "task" in dispatch);

  const delivery = exporter.getFinishedSpans().find((span) => span.name === "factory.delivery");
  assert.equal(delivery?.attributes["factory.delivery.kind"], "github.pull_request");
  assert.equal(delivery?.attributes["factory.outcome"], "buffered");
  assert.equal(delivery?.attributes["factory.pr"], `${REPO}#61`);

  const deadline = Date.now() + 10_000;
  while (!exporter.getFinishedSpans().some((span) => span.name === "factory.background") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const flush = exporter.getFinishedSpans().find((span) => span.name === "factory.background");
  assert.equal(flush?.attributes["factory.delivery.kind"], "buffer.flush");
  assert.equal(flush?.attributes["factory.pr"], `${REPO}#61`);
  assert.equal(flush?.attributes["factory.outcome"], "flushed");
  assert.equal(sends.length, 1, "the flush sent the buffered wake to the bound agent's session");
});

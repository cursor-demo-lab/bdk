import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { WebhookBuffer, type BufferedWebhookEvent } from "./webhook-buffer.js";

function memoryKv(): HostKvApi {
  const store = new Map<string, unknown>();
  return {
    get: async (key) => structuredClone(store.get(key)) as never,
    put: async (key, value) => { store.set(key, structuredClone(value)); },
    delete: async (key) => { store.delete(key); },
  };
}

const EVENT: BufferedWebhookEvent = {
  eventName: "check_suite",
  prUrl: "https://github.com/example/sandbox/pull/40",
  owner: "example",
  repo: "sandbox",
  number: 40,
  conclusion: "failure",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Round-2 finding 7: the timer ran `void this.flush(key)` and flush rethrows
// after rescheduling, so every failed flush was an unhandled rejection.
test("a flush that fails is logged and retried after the debounce, and never rejects unhandled", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { process.off("unhandledRejection", onUnhandled); });

  const flushed: BufferedWebhookEvent[] = [];
  let failures = 2;
  const buffer = new WebhookBuffer({
    kv: memoryKv(),
    debounceMs: 5,
    onFlush: async (event) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("drive session busy elsewhere");
      }
      flushed.push(event);
    },
  });
  await buffer.enqueue(EVENT);
  for (let waited = 0; flushed.length === 0 && waited < 1000; waited += 5) await sleep(5);
  await sleep(10);

  assert.deepEqual(flushed, [EVENT], "the entry stays buffered and flushes once onFlush answers");
  assert.deepEqual(unhandled, []);
  assert.deepEqual(
    errors.mock.calls.map((call) => String(call.arguments[0])),
    Array(2).fill("[pr-autofixer] webhook buffer: flush of example/sandbox#40 failed: drive session busy elsewhere"),
  );
  await buffer.clear();
});

test("a flush that answers retryInMs keeps its event, logs no error, and flushes it again after that long", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const calls: number[] = [];
  const buffer = new WebhookBuffer({
    kv: memoryKv(),
    debounceMs: 5,
    onFlush: async () => {
      calls.push(Date.now());
      return calls.length < 3 ? { retryInMs: 40 } : undefined;
    },
  });
  await buffer.enqueue(EVENT);
  for (let waited = 0; calls.length < 3 && waited < 2000; waited += 5) await sleep(5);
  await sleep(100);
  assert.equal(calls.length, 3, "kept until onFlush settles it, then gone");
  assert.ok(calls[1]! - calls[0]! >= 35 && calls[2]! - calls[1]! >= 35, "each retry waits retryInMs, not the debounce");
  assert.equal(errors.mock.calls.length, 0);
  await buffer.clear();
});

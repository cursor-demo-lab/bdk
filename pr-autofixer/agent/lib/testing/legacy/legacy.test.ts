import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { bugbotRoundsKey, peekBugbotRound, recordBugbotRound } from "./bugbot-rounds.js";
import { WEBHOOK_BUFFER_KV_KEY, WebhookBuffer, type BufferedWebhookEvent } from "./webhook-buffer.js";

const PR = { owner: "cursor-demo-lab", repo: "marsbank", number: 13, url: "https://github.com/cursor-demo-lab/marsbank/pull/13", label: "cursor-demo-lab/marsbank#13" };

function rowsKv(rows: Map<string, JsonValue>): HostKvApi {
  return {
    get: async (key) => rows.get(key),
    put: async (key, value) => void rows.set(key, value),
    delete: async (key) => void rows.delete(key),
  };
}

/** Two views of `kv` whose first reads both return before either view writes. */
function bothReadFirst(kv: HostKvApi): [HostKvApi, HostKvApi] {
  let arrived = 0;
  let open!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    open = resolve;
  });
  const view = (): HostKvApi => {
    let reads = 0;
    return {
      ...kv,
      get: async (key) => {
        const value = await kv.get(key);
        if (reads++ === 0 && ++arrived === 2) open();
        await bothRead;
        return value;
      },
    };
  };
  return [view(), view()];
}

function event(number: number): BufferedWebhookEvent {
  return { eventName: "check_suite", prUrl: `https://github.com/cursor-demo-lab/marsbank/pull/${number}`, owner: "cursor-demo-lab", repo: "marsbank", number };
}

test("frozen Bugbot rounds: a head counts once, and past the cap the next head is cap_reached once, then capped", async () => {
  const kv = rowsKv(new Map());
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "a1" }), "drive");
  await recordBugbotRound(kv, { pr: PR, headSha: "a1" });
  await recordBugbotRound(kv, { pr: PR, headSha: "A1" });
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "a1" }), "duplicate");
  await recordBugbotRound(kv, { pr: PR, headSha: "b2" });
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "c3" }), "cap_reached");
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "d4" }), "capped");
});

test("frozen recordBugbotRound with no compare-and-set: two heads recorded at once spend one round, not two", async () => {
  const rows = new Map<string, JsonValue>();
  const [first, second] = bothReadFirst(rowsKv(rows));
  await Promise.all([recordBugbotRound(first, { pr: PR, headSha: "a1" }), recordBugbotRound(second, { pr: PR, headSha: "b2" })]);
  assert.equal((rows.get(bugbotRoundsKey(PR)) as { rounds: number }).rounds, 1);
});

test("frozen WebhookBuffer: each process persists its whole snapshot, so a second process's enqueue replaces the first's entry", async () => {
  const rows = new Map<string, JsonValue>();
  const onFlush = () => undefined;
  const a = new WebhookBuffer({ kv: rowsKv(rows), onFlush, debounceMs: 60_000 });
  const b = new WebhookBuffer({ kv: rowsKv(rows), onFlush, debounceMs: 60_000 });
  await a.enqueue(event(13));
  await b.enqueue(event(14));
  await a.clear();
  await b.clear();
  assert.deepEqual(Object.keys((rows.get(WEBHOOK_BUFFER_KV_KEY) as { entries: object }).entries), ["cursor-demo-lab/marsbank#14"]);

  const restarted = new WebhookBuffer({ kv: rowsKv(rows), onFlush, debounceMs: 60_000 });
  assert.equal(await restarted.restore(), 1);
  await restarted.clear();
});

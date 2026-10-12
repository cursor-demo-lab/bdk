import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { readFile } from "node:fs/promises";
import {
  deleteVerified,
  isRetryable,
  KV_PERMANENT_REASON_CODES,
  KV_RETRY_PAUSE_BUDGET_MS,
  KV_RETRY_PAUSES_MS,
  kvRetryPausesMs,
  readRetrying,
  sameJson,
  updateVerified,
} from "./kv-verified.js";
import type { KvKey } from "./kv-keys.js";

const asKey = (raw: string): KvKey => raw as KvKey;

// Contract tests for the shared helper, on both backends ctx.host.kv has:
// the July filesystem kv (local serve) and the hosted storage path (July's
// own wrapper over a plain get/put/delete sink). Neither has compare-and-set.
// The hosted fake sorts object keys on write, as a JSONB column would.

const julyRoot = dirname(createRequire(import.meta.url).resolve("@cursor/july/package.json"));
const { createHostKvApi } = (await import(pathToFileURL(join(julyRoot, "dist/internal/host-kv.js")).href)) as {
  createHostKvApi: (options: { agentName?: string; stateRoot?: string; storage?: unknown }) => HostKvApi;
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
}

const backends: Array<{ name: string; make: () => Promise<HostKvApi> }> = [
  { name: "filesystem kv", make: async () => createHostKvApi({ agentName: "kv-verified-test", stateRoot: await mkdtemp(join(tmpdir(), "kv-verified-")) }) },
  {
    name: "hosted storage kv",
    make: async () => {
      const sink = new Map<string, string>();
      const storage = {
        supportsAuthorKv: true,
        kvGet: async (key: string) => (sink.has(key) ? JSON.parse(sink.get(key) as string) : undefined),
        kvPut: async (key: string, value: unknown) => { sink.set(key, JSON.stringify(sortKeys(value))); },
        kvDelete: async (key: string) => { sink.delete(key); },
      };
      return createHostKvApi({ storage });
    },
  },
];

type Hooks = {
  beforeGet?: (n: number) => Promise<void> | void;
  beforePut?: (n: number) => Promise<void> | void;
  afterPut?: (n: number) => Promise<void> | void;
  beforeDelete?: (n: number) => Promise<void> | void;
  afterDelete?: (n: number) => Promise<void> | void;
};

/** The same store seen through a caller whose operations can fail or wait. */
function through(kv: HostKvApi, hooks: Hooks): HostKvApi & { puts: () => number } {
  const count = { get: 0, put: 0, delete: 0 };
  return {
    puts: () => count.put,
    get: async (key) => { await hooks.beforeGet?.(count.get++); return kv.get(key); },
    put: async (key, value) => {
      const n = count.put++;
      await hooks.beforePut?.(n);
      await kv.put(key, value);
      await hooks.afterPut?.(n);
    },
    delete: async (key) => {
      const n = count.delete++;
      await hooks.beforeDelete?.(n);
      await kv.delete(key);
      await hooks.afterDelete?.(n);
    },
  };
}

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait: () => opened };
}

const K = asKey("claim:example#1");
const createIfAbsent = (value: JsonValue) => (current: JsonValue | undefined) => (current === undefined ? value : undefined);
const ownedBy = (owner: string) => (current: JsonValue | undefined) => typeof current === "object" && current !== null && !Array.isArray(current) && current["owner"] === owner;

for (const backend of backends) {
  test(`${backend.name}: key absent, an update creates the key and a delete finds nothing to remove`, async () => {
    const kv = await backend.make();
    assert.deepEqual(await updateVerified(kv, K, createIfAbsent({ owner: "a" })), { status: "written", value: { owner: "a" } });
    assert.deepEqual(await kv.get(K), { owner: "a" });
    assert.deepEqual(await deleteVerified(kv, asKey("claim:none"), ownedBy("a")), { status: "lost", current: undefined });
    assert.deepEqual(await updateVerified(kv, K, createIfAbsent({ owner: "b" })), { status: "lost", current: { owner: "a" } });
  });

  test(`${backend.name}: key absent, a create that loses the race sees the winner on read-back and yields`, async () => {
    const kv = await backend.make();
    const a = through(kv, { afterPut: async (n) => { if (n === 0) await updateVerified(kv, K, () => ({ owner: "b" })); } });
    assert.deepEqual(await updateVerified(a, K, createIfAbsent({ owner: "a" })), { status: "lost", current: { owner: "b" } });
    assert.deepEqual(await kv.get(K), { owner: "b" });
  });

  test(`${backend.name}: ambiguous write, a put that lands but throws is written; one that throws before landing is retried`, async () => {
    const kv = await backend.make();
    const landed = through(kv, { afterPut: (n) => { if (n === 0) throw new Error("timeout after write"); } });
    assert.equal((await updateVerified(landed, K, createIfAbsent({ owner: "a" }))).status, "written");
    assert.equal(landed.puts(), 1);

    const refused = through(kv, { beforePut: (n) => { if (n === 0) throw new Error("refused"); } });
    assert.equal((await updateVerified(refused, asKey("claim:two"), createIfAbsent({ owner: "a" }))).status, "written");
    assert.deepEqual(await kv.get("claim:two"), { owner: "a" });

    const blind = through(kv, { afterPut: () => { throw new Error("timeout after write"); }, beforeGet: (n) => { if (n === 1) throw new Error("read-back down"); } });
    assert.equal((await updateVerified(blind, asKey("claim:three"), createIfAbsent({ owner: "a" }))).status, "written");

    const deleted = through(kv, { afterDelete: () => { throw new Error("timeout after delete"); } });
    assert.equal((await deleteVerified(deleted, K, ownedBy("a"))).status, "written");
    assert.equal(await kv.get(K), undefined);

    await kv.put(K, { owner: "a" });
    const unapplied = through(kv, { beforeDelete: (n) => { if (n === 0) throw new Error("refused"); } });
    assert.equal((await deleteVerified(unapplied, K, ownedBy("a"))).status, "written");
    assert.equal(await kv.get(K), undefined);
  });

  test(`${backend.name}: read outage, nothing is written and the caller hears unavailable; a single failed read is retried`, async () => {
    const kv = await backend.make();
    await kv.put(K, { owner: "a" });
    const down = through(kv, { beforeGet: () => { throw new Error("kv unavailable"); } });
    assert.deepEqual(await updateVerified(down, K, () => ({ owner: "b" })), { status: "unavailable" });
    assert.deepEqual(await deleteVerified(down, K, ownedBy("a")), { status: "unavailable" });
    assert.deepEqual(await readRetrying(down, K), { ok: false });
    assert.equal(down.puts(), 0);
    assert.deepEqual(await kv.get(K), { owner: "a" });

    const flaky = through(kv, { beforeGet: (n) => { if (n === 0) throw new Error("kv unavailable"); } });
    assert.deepEqual(await readRetrying(flaky, K), { ok: true, value: { owner: "a" } });
    assert.equal((await updateVerified(through(kv, { beforeGet: (n) => { if (n === 0) throw new Error("blip"); } }), K, () => ({ owner: "b" }))).status, "written");
  });

  test(`${backend.name}: reordered writes, an update overwritten after its read-back is merged back by the other writer`, async () => {
    const kv = await backend.make();
    await kv.put(K, { owner: "a" });
    const bPut = gate();
    const aPut = gate();
    const merge = (field: string) => (current: JsonValue | undefined) => ({ ...(current as Record<string, JsonValue>), [field]: true });
    const a = through(kv, { beforePut: async (n) => { if (n === 0) await bPut.wait(); }, afterPut: (n) => { if (n === 0) aPut.open(); } });
    const b = through(kv, { afterPut: (n) => { if (n === 0) bPut.open(); }, beforeGet: async (n) => { if (n === 1) await aPut.wait(); } });
    const [ra, rb] = await Promise.all([updateVerified(a, K, merge("started")), updateVerified(b, K, merge("stamped"))]);
    assert.deepEqual([ra.status, rb.status], ["written", "written"]);
    assert.ok(sameJson(await kv.get(K), { owner: "a", started: true, stamped: true }));
  });

  test(`${backend.name}: replayed delivery, a decision replayed after the owner changed leaves the new owner`, async () => {
    const kv = await backend.make();
    await kv.put(K, { owner: "new" });
    const releaseOld = (current: JsonValue | undefined) => (ownedBy("old")(current) ? { owner: "old", released: true } : undefined);
    assert.deepEqual(await updateVerified(kv, K, releaseOld), { status: "lost", current: { owner: "new" } });
    assert.deepEqual(await deleteVerified(kv, K, ownedBy("old")), { status: "lost", current: { owner: "new" } });
    assert.deepEqual(await kv.get(K), { owner: "new" });
  });

  test(`${backend.name}: concurrent openers, two creates that both read the key absent yield one winner`, async () => {
    const kv = await backend.make();
    const bRead = gate();
    const aPut = gate();
    const bPut = gate();
    const a = through(kv, { beforePut: async () => { await bRead.wait(); }, afterPut: (n) => { if (n === 0) aPut.open(); }, beforeGet: async (n) => { if (n === 1) await bPut.wait(); } });
    const b = through(kv, { beforePut: async (n) => { bRead.open(); if (n === 0) await aPut.wait(); }, afterPut: (n) => { if (n === 0) bPut.open(); } });
    const results = await Promise.all([updateVerified(a, K, createIfAbsent({ owner: "a" })), updateVerified(b, K, createIfAbsent({ owner: "b" }))]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["lost", "written"]);
    assert.deepEqual(await kv.get(K), { owner: "b" });
  });

  test(`${backend.name}: concurrent openers, the residual window: a put landing after the other's read-back leaves both written`, async () => {
    const kv = await backend.make();
    const aDone = gate();
    const bRead = gate();
    const a = through(kv, { beforePut: async () => { await bRead.wait(); } });
    const b = through(kv, { beforePut: async () => { bRead.open(); await aDone.wait(); } });
    const pa = updateVerified(a, K, createIfAbsent({ owner: "a" })).then((result) => { aDone.open(); return result; });
    const results = await Promise.all([pa, updateVerified(b, K, createIfAbsent({ owner: "b" }))]);
    assert.deepEqual(results.map((result) => result.status), ["written", "written"]);
    assert.deepEqual(await kv.get(K), { owner: "b" });
  });

  test(`${backend.name}: concurrent openers, a writer overwritten on every attempt gives up as lost, not unavailable`, async () => {
    const kv = await backend.make();
    await kv.put(K, { owner: "a", rival: 0 });
    const outwritten = through(kv, { afterPut: async (n) => { await kv.put(K, { owner: "a", rival: n + 1 }); } });
    const result = await updateVerified(outwritten, K, (current) => ({ ...(current as Record<string, JsonValue>), mine: true }));
    assert.deepEqual(result, { status: "lost", current: undefined });
    assert.equal(outwritten.puts(), 3);
    assert.deepEqual(await kv.get(K), { owner: "a", rival: 3 });
  });

  test(`${backend.name}: a read blip, then a writer overwritten on every later attempt, gives up as lost, not unavailable`, async () => {
    const kv = await backend.make();
    await kv.put(K, { owner: "a", rival: 0 });
    let gets = 0;
    let puts = 0;
    const blip: HostKvApi = {
      get: async (key) => { if (gets++ === 0) throw new Error("kv blip"); return kv.get(key); },
      put: async (key, value) => { await kv.put(key, value); await kv.put(key, { owner: "a", rival: ++puts }); },
      delete: (key) => kv.delete(key),
    };
    assert.deepEqual(await updateVerified(blip, K, (current) => ({ ...(current as Record<string, JsonValue>), mine: true })), { status: "lost", current: undefined });
  });

  test(`${backend.name}: write outage, puts that keep failing while reads work give unavailable, not lost`, async () => {
    const kv = await backend.make();
    await kv.put(K, { owner: "a" });
    const refused = through(kv, { beforePut: () => { throw new Error("kv write refused"); } });
    assert.deepEqual(await updateVerified(refused, K, (current) => ({ ...(current as Record<string, JsonValue>), mine: true })), { status: "unavailable" });
    assert.equal(refused.puts(), 3);
    assert.deepEqual(await kv.get(K), { owner: "a" });

    const lastLanded = through(kv, { beforePut: (n) => { if (n < 2) throw new Error("kv write refused"); }, afterPut: async () => { await kv.put(K, { owner: "rival" }); } });
    assert.deepEqual(await updateVerified(lastLanded, K, (current) => ({ ...(current as Record<string, JsonValue>), mine: true })), { status: "lost", current: undefined });
  });

  test(`${backend.name}: pausesMs waits before each retry, and only before a retry`, async () => {
    const kv = await backend.make();
    const waits: number[] = [];
    let last = Date.now();
    const down = through(kv, { beforeGet: () => { const now = Date.now(); waits.push(now - last); last = now; throw new Error("kv unavailable"); } });
    assert.deepEqual(await updateVerified(down, K, () => ({ owner: "a" }), { attempts: 3, pausesMs: [150, 300] }), { status: "unavailable" });
    assert.equal(waits.length, 3);
    assert.ok(waits[0] < 100, `no pause before the first attempt (${waits[0]}ms)`);
    assert.ok(waits[1] >= 140 && waits[2] >= 290, `paused ${waits.join(", ")}ms`);

    last = Date.now();
    waits.length = 0;
    assert.deepEqual(await deleteVerified(down, K, ownedBy("a"), { attempts: 2, pausesMs: [150] }), { status: "unavailable" });
    assert.ok(waits[0] < 100 && waits[1] >= 140, `paused ${waits.join(", ")}ms`);

    const outage = through(kv, { beforeGet: (n) => { if (n < 3) throw new Error("kv unavailable"); } });
    assert.equal((await updateVerified(outage, K, () => ({ owner: "a" }), { attempts: 4, pausesMs: [1, 1, 1] })).status, "written");
  });

  test(`${backend.name}: an owner-matched delete keeps a value that stopped matching and one written after the delete`, async () => {
    const kv = await backend.make();
    await kv.put(K, { owner: "a" });
    const retakeAfter = through(kv, { afterDelete: async () => { await kv.put(K, { owner: "b" }); } });
    assert.equal((await deleteVerified(retakeAfter, K, ownedBy("a"))).status, "written");
    assert.deepEqual(await kv.get(K), { owner: "b" });
  });
}

test("JSON equality ignores key order and undefined members, not values", () => {
  assert.equal(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
  assert.equal(sameJson({ a: 1, gone: undefined }, { a: 1 }), true);
  assert.equal(sameJson({ a: 1 }, { a: 2 }), false);
  assert.equal(sameJson([1, 2], [2, 1]), false);
  assert.equal(sameJson({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(sameJson(null, {}), false);
});

// Retry policy (plan K6). The store below is July's own hosted v2 backend
// over a fake fetch, so failures arrive as July's StorageRpcError, with the
// status and reason code the helpers classify.

const hostedV2 = (await import(pathToFileURL(join(julyRoot, "dist/storage-backends/cursor-hosted-v2.js")).href)) as {
  cursorHostedStorageV2: (options: { apiKey: string; baseUrl: string; fetch: typeof fetch }) => {
    get: (key: string) => Promise<JsonValue | undefined>;
    put: (key: string, value: JsonValue) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
};

type Rpc = { op: string; key: string; value?: JsonValue };
type Failure = { status: number; code?: string } | "network";

/** A hosted kv whose `fail(rpc)` can refuse any call; `rpcs` counts every call made. */
function hostedKv(fail: (rpc: Rpc & { n: number }) => Failure | undefined) {
  const rows = new Map<string, JsonValue>();
  const rpcs: Rpc[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const rpc: Rpc = { op: String(url).split("/").pop() ?? "", ...(JSON.parse(String(init?.body)) as { key: string; value?: JsonValue }) };
    rpcs.push(rpc);
    const failure = fail({ ...rpc, n: rpcs.length - 1 });
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure !== undefined) return new Response(JSON.stringify({ error: "refused", code: failure.code }), { status: failure.status });
    if (rpc.op === "get") return Response.json(rows.has(rpc.key) ? { found: true, value: rows.get(rpc.key) } : { found: false });
    if (rpc.op === "put") rows.set(rpc.key, rpc.value as JsonValue);
    if (rpc.op === "delete") rows.delete(rpc.key);
    return Response.json({});
  }) as typeof fetch;
  const storage = hostedV2.cursorHostedStorageV2({ apiKey: "test", baseUrl: "https://kv.test", fetch: fakeFetch });
  const kv: HostKvApi = { get: (key) => storage.get(key), put: (key, value) => storage.put(key, value), delete: (key) => storage.delete(key) };
  return { kv, rpcs, rows };
}

/** Pauses and warnings recorded instead of slept and logged; `random: 1` is the widest jitter. */
function recorded(extra: { env?: NodeJS.ProcessEnv; random?: () => number } = {}) {
  const slept: number[] = [];
  const warned: Array<Record<string, unknown>> = [];
  const options = {
    env: extra.env ?? {},
    random: extra.random ?? (() => 1),
    sleep: async (ms: number) => { slept.push(ms); },
    warn: (line: string) => { warned.push(JSON.parse(line) as Record<string, unknown>); },
  };
  return { slept, warned, options };
}

const total = (values: readonly number[]) => {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
};

test("retry policy: a 429 twice then success is written, after the default pauses", async () => {
  const store = hostedKv(({ n }) => (n < 2 ? { status: 429 } : undefined));
  const run = recorded();
  assert.deepEqual(await updateVerified(store.kv, K, createIfAbsent({ owner: "a" }), run.options), { status: "written", value: { owner: "a" } });
  assert.deepEqual(run.slept, [...KV_RETRY_PAUSES_MS]);
  assert.deepEqual(store.rpcs.map((rpc) => rpc.op), ["get", "get", "get", "put", "get"]);
  assert.deepEqual(run.warned, []);

  const reads = hostedKv(({ n }) => (n < 2 ? { status: 503 } : undefined));
  const read = recorded({ random: () => 0 });
  assert.deepEqual(await readRetrying(reads.kv, K, read.options), { ok: true, value: undefined });
  assert.deepEqual(read.slept, [50, 200], "jitter keeps each pause within half to all of its nominal value");

  const network = hostedKv(({ n }) => (n === 0 ? "network" : undefined));
  assert.deepEqual(await deleteVerified(network.kv, K, ownedBy("a"), recorded().options), { status: "lost", current: undefined });
  assert.equal(network.rpcs.length, 2, "a network error has no status and is retried");
});

test("retry policy: a 400 agentsdk_kv_key_invalid is unavailable after one attempt, logged, and never thrown", async () => {
  const refused = { status: 400, code: "agentsdk_kv_key_invalid" };
  for (const [name, call] of [
    ["updateVerified", (kv: HostKvApi, options: object) => updateVerified(kv, K, createIfAbsent({ owner: "a" }), options)],
    ["deleteVerified", (kv: HostKvApi, options: object) => deleteVerified(kv, K, () => true, options)],
    ["readRetrying", (kv: HostKvApi, options: object) => readRetrying(kv, K, options)],
  ] as const) {
    const store = hostedKv(() => refused);
    const run = recorded();
    const result = await call(store.kv, run.options);
    assert.deepEqual(result, name === "readRetrying" ? { ok: false } : { status: "unavailable" }, name);
    assert.equal(store.rpcs.length, 1, `${name}: one attempt`);
    assert.deepEqual(run.slept, [], `${name}: no pause`);
    assert.deepEqual(run.warned, [{ kv: "retry_stopped", op: "get", key: K, status: 400, reasonCode: "agentsdk_kv_key_invalid" }], name);
  }

  const putRefused = hostedKv(({ op }) => (op === "put" ? { status: 413, code: "agentsdk_kv_value_invalid" } : undefined));
  const run = recorded();
  assert.deepEqual(await updateVerified(putRefused.kv, K, createIfAbsent({ owner: "a" }), run.options), { status: "unavailable" });
  assert.deepEqual(putRefused.rpcs.map((rpc) => rpc.op), ["get", "put"]);
  assert.equal(run.warned[0]?.["op"], "put");

  const forbidden = hostedKv(() => ({ status: 404 }));
  const plain = recorded();
  assert.deepEqual(await updateVerified(forbidden.kv, K, createIfAbsent({ owner: "a" }), plain.options), { status: "unavailable" });
  assert.equal(forbidden.rpcs.length, 1, "any other 4xx stops too");
  assert.equal(plain.warned[0]?.["reasonCode"], "agentsdk_storage_http_error");
});

test("retry policy: total pause time stays within the G4 admission cap", async () => {
  assert.ok(total(KV_RETRY_PAUSES_MS) <= KV_RETRY_PAUSE_BUDGET_MS);
  for (const env of [{}, { FACTORY_KV_RETRY_PAUSES_MS: "250,250" }, { FACTORY_KV_RETRY_PAUSES_MS: "400,400" }]) {
    const store = hostedKv(() => ({ status: 503 }));
    const run = recorded({ env, random: () => 0.999999 });
    assert.deepEqual(await updateVerified(store.kv, K, createIfAbsent({ owner: "a" }), { ...run.options, attempts: 6 }), { status: "unavailable" });
    assert.equal(store.rpcs.length, 6);
    assert.ok(total(run.slept) <= KV_RETRY_PAUSE_BUDGET_MS, `${JSON.stringify(env)} paused ${run.slept.join(" + ")} ms`);
  }
});

test("retry policy: FACTORY_KV_RETRY_PAUSES_MS empty or off turns the pauses off, not the retries", async () => {
  for (const value of ["", " ", "off"]) {
    const store = hostedKv(({ n }) => (n < 2 ? { status: 500 } : undefined));
    const run = recorded({ env: { FACTORY_KV_RETRY_PAUSES_MS: value } });
    assert.deepEqual(await readRetrying(store.kv, K, run.options), { ok: true, value: undefined });
    assert.deepEqual(run.slept, [], JSON.stringify(value));
    assert.equal(store.rpcs.length, 3);
  }

  const saved = process.env.FACTORY_KV_RETRY_PAUSES_MS;
  process.env.FACTORY_KV_RETRY_PAUSES_MS = "";
  try {
    const store = hostedKv(() => ({ status: 503 }));
    const started = Date.now();
    assert.deepEqual(await updateVerified(store.kv, K, createIfAbsent({ owner: "a" })), { status: "unavailable" });
    assert.ok(Date.now() - started < 90, "read from process.env per call");
  } finally {
    if (saved === undefined) delete process.env.FACTORY_KV_RETRY_PAUSES_MS;
    else process.env.FACTORY_KV_RETRY_PAUSES_MS = saved;
  }
});

test("retry policy: FACTORY_KV_RETRY_PAUSES_MS parsing", () => {
  assert.deepEqual(kvRetryPausesMs({}), KV_RETRY_PAUSES_MS);
  assert.deepEqual(kvRetryPausesMs({ FACTORY_KV_RETRY_PAUSES_MS: "" }), []);
  assert.deepEqual(kvRetryPausesMs({ FACTORY_KV_RETRY_PAUSES_MS: "OFF" }), []);
  assert.deepEqual(kvRetryPausesMs({ FACTORY_KV_RETRY_PAUSES_MS: " 50, 150 " }), [50, 150]);
  assert.deepEqual(kvRetryPausesMs({ FACTORY_KV_RETRY_PAUSES_MS: "0" }), [0]);
  assert.deepEqual(kvRetryPausesMs({ FACTORY_KV_RETRY_PAUSES_MS: "100,abc" }), KV_RETRY_PAUSES_MS);
  assert.deepEqual(kvRetryPausesMs({ FACTORY_KV_RETRY_PAUSES_MS: "-5" }), KV_RETRY_PAUSES_MS);
  assert.deepEqual(kvRetryPausesMs({ FACTORY_KV_RETRY_PAUSES_MS: "300,300" }), KV_RETRY_PAUSES_MS, "over the budget keeps the defaults");
});

/** The error July's hosted store throws for one refused call, got through the fake fetch. */
async function rpcError(failure: { status: number; code?: string }): Promise<unknown> {
  const store = hostedKv(() => failure);
  return store.kv.get(K).then(() => assert.fail("expected the call to be refused"), (error: unknown) => error);
}

test("isRetryable: 429, 5xx and no status retry; other 4xx and hosted reason codes stop", async () => {
  assert.equal(isRetryable(await rpcError({ status: 429 })), true);
  assert.equal(isRetryable(await rpcError({ status: 429, code: "agentsdk_kv_rate_limited" })), true, "a future rate-limit code still retries");
  assert.equal(isRetryable(await rpcError({ status: 429, code: "agentsdk_kv_key_invalid" })), true, "429 is checked first, even with a permanent reason code");
  assert.equal(isRetryable(await rpcError({ status: 500 })), true);
  assert.equal(isRetryable(await rpcError({ status: 503 })), true);
  assert.equal(isRetryable(new TypeError("fetch failed")), true);
  assert.equal(isRetryable(new Error("cursorHostedStorage /get returned non-JSON (502)")), true);
  assert.equal(isRetryable("boom"), true);
  assert.equal(isRetryable(await rpcError({ status: 400 })), false);
  assert.equal(isRetryable(await rpcError({ status: 404 })), false);
  assert.equal(isRetryable(await rpcError({ status: 409 })), false);
  assert.equal(isRetryable(await rpcError({ status: 400, code: "agentsdk_kv_key_invalid" })), false);
  assert.equal(isRetryable(await rpcError({ status: 503, code: "agentsdk_kv_deployment_unbound" })), false, "a reason code stops even on a 5xx");
  assert.equal((await rpcError({ status: 400, code: "agentsdk_kv_key_invalid" }) as { reasonCode?: string }).reasonCode, "agentsdk_kv_key_invalid");
});

test("the permanent reason codes match July's hosted store", async () => {
  const source = await readFile(join(julyRoot, "dist/storage-backends/cursor-hosted.js"), "utf8");
  const block = /STORAGE_RPC_ERROR_CODES = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1];
  assert.ok(block !== undefined, "STORAGE_RPC_ERROR_CODES not found in July's cursor-hosted.js");
  const july = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...KV_PERMANENT_REASON_CODES].sort(), july);
});

test("retry policy: a 429 that carries a permanent reason code still retries, and succeeds", async () => {
  const store = hostedKv(({ n }) => (n < 2 ? { status: 429, code: "agentsdk_kv_key_invalid" } : undefined));
  const run = recorded();
  assert.deepEqual(await updateVerified(store.kv, K, createIfAbsent({ owner: "a" }), run.options), { status: "written", value: { owner: "a" } });
  assert.equal(store.rpcs.length, 5);
  assert.deepEqual(run.warned, []);
});

test("retry policy: a delete refused with a reason code is one delete, unavailable, and one log line", async () => {
  const store = hostedKv(({ op }) => (op === "delete" ? { status: 400, code: "agentsdk_kv_key_invalid" } : undefined));
  store.rows.set(K, { owner: "a" });
  const run = recorded();
  assert.deepEqual(await deleteVerified(store.kv, K, ownedBy("a"), run.options), { status: "unavailable" });
  assert.deepEqual(store.rpcs.map((rpc) => rpc.op), ["get", "delete"]);
  assert.deepEqual(run.warned, [{ kv: "retry_stopped", op: "delete", key: K, status: 400, reasonCode: "agentsdk_kv_key_invalid" }]);
  assert.deepEqual(store.rows.get(K), { owner: "a" });
});

test("retry policy: hooks that throw or misbehave keep the no-throw contract and the budget", async () => {
  const downThenUp = () => hostedKv(({ n }) => (n < 2 ? { status: 503 } : undefined));
  const slept = (random: () => number) => {
    const pauses: number[] = [];
    return { pauses, options: { env: {}, random, sleep: async (ms: number) => { pauses.push(ms); } } };
  };

  for (const [name, random, expected] of [
    ["random throws", () => { throw new Error("no entropy"); }, [50, 200]],
    ["random is 10", () => 10, [100, 400]],
    ["random is NaN", () => Number.NaN, [50, 200]],
    ["random is negative", () => -3, [50, 200]],
    ["random is Infinity", () => Number.POSITIVE_INFINITY, [50, 200]],
  ] as const) {
    const run = slept(random);
    assert.deepEqual(await readRetrying(downThenUp().kv, K, run.options), { ok: true, value: undefined }, name);
    assert.deepEqual(run.pauses, expected, name);
    assert.ok(total(run.pauses) <= KV_RETRY_PAUSE_BUDGET_MS, name);
  }

  for (const [name, sleep] of [
    ["sleep throws", (_ms: number): Promise<void> => { throw new Error("no timers"); }],
    ["sleep rejects", async (_ms: number): Promise<void> => { throw new Error("timer cancelled"); }],
  ] as const) {
    const store = downThenUp();
    assert.deepEqual(await updateVerified(store.kv, K, createIfAbsent({ owner: "a" }), { env: {}, sleep }), { status: "written", value: { owner: "a" } }, name);
    assert.equal(store.rpcs.length, 5, name);
  }

  const refusedStore = hostedKv(() => ({ status: 400, code: "agentsdk_kv_key_invalid" }));
  const warn = () => { throw new Error("log sink down"); };
  assert.deepEqual(await updateVerified(refusedStore.kv, K, createIfAbsent({ owner: "a" }), { env: {}, warn }), { status: "unavailable" });
  assert.deepEqual(await deleteVerified(refusedStore.kv, K, ownedBy("a"), { env: {}, warn }), { status: "unavailable" });
  assert.deepEqual(await readRetrying(refusedStore.kv, K, { env: {}, warn }), { ok: false });
});

test("retry policy: an env value that is not a string, or an env that throws, keeps the default pauses", async () => {
  const throwing = Object.defineProperty({}, "FACTORY_KV_RETRY_PAUSES_MS", { get: () => { throw new Error("env unreadable"); } }) as NodeJS.ProcessEnv;
  const notString = { FACTORY_KV_RETRY_PAUSES_MS: 5 } as unknown as NodeJS.ProcessEnv;
  assert.deepEqual(kvRetryPausesMs(notString), KV_RETRY_PAUSES_MS);
  assert.deepEqual(kvRetryPausesMs(throwing), KV_RETRY_PAUSES_MS);
  for (const env of [notString, throwing]) {
    const store = hostedKv(({ n }) => (n < 2 ? { status: 503 } : undefined));
    const run = recorded({ env });
    assert.deepEqual(await readRetrying(store.kv, K, run.options), { ok: true, value: undefined });
    assert.deepEqual(run.slept, [...KV_RETRY_PAUSES_MS]);
  }
  const options = Object.defineProperty({ random: () => 1 }, "env", { get: () => { throw new Error("options unreadable"); } });
  assert.equal((await readRetrying(hostedKv(() => undefined).kv, K, options)).ok, true);
});

test("retry policy: July's local refusals (an empty key, no deployment credential) stop at once; a network error still retries", async () => {
  const empty = createHostKvApi({ agentName: "kv-verified-test", stateRoot: await mkdtemp(join(tmpdir(), "kv-verified-")) });
  const run = recorded();
  assert.deepEqual(await updateVerified(empty, asKey(""), createIfAbsent({ owner: "a" }), run.options), { status: "unavailable" });
  assert.deepEqual(run.slept, []);
  assert.deepEqual(run.warned, [{ kv: "retry_stopped", op: "get", key: "", message: "host.kv key must be a non-empty string" }]);

  const savedKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  try {
    let calls = 0;
    const storage = hostedV2.cursorHostedStorageV2({ baseUrl: "https://kv.test", fetch: (async () => { calls += 1; return Response.json({}); }) as typeof fetch } as never);
    const noCredential: HostKvApi = { get: (key) => storage.get(key), put: (key, value) => storage.put(key, value), delete: (key) => storage.delete(key) };
    const missing = recorded();
    assert.deepEqual(await readRetrying(noCredential, K, missing.options), { ok: false });
    assert.equal(calls, 0);
    assert.equal(missing.warned.length, 1);
    assert.equal(missing.warned[0]?.["message"], "cursorHostedStorage requires CURSOR_API_KEY (deployment pod credential on Cursor hosting)");
  } finally {
    if (savedKey !== undefined) process.env.CURSOR_API_KEY = savedKey;
  }

  const realFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = undefined;
  try {
    const storage = hostedV2.cursorHostedStorageV2({ apiKey: "test", baseUrl: "https://kv.test" } as never);
    const noFetch: HostKvApi = { get: (key) => storage.get(key), put: (key, value) => storage.put(key, value), delete: (key) => storage.delete(key) };
    const missing = recorded();
    assert.deepEqual(await readRetrying(noFetch, K, missing.options), { ok: false });
    assert.deepEqual(missing.warned, [{ kv: "retry_stopped", op: "get", key: K, message: "cursorHostedStorage requires fetch" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(isRetryable(new Error("cursorHostedStorage requires CURSOR_API_KEY")), true, "only July's full message counts");
  assert.equal(isRetryable(new Error("cursorHostedStorage requires fetch, and more")), true, "anchored at the end too");
  assert.equal(isRetryable(new Error("connect ECONNREFUSED host.kv key must be a non-empty string")), true, "only the whole message counts");
  const network = hostedKv(({ n }) => (n < 2 ? "network" : undefined));
  assert.deepEqual(await readRetrying(network.kv, K, recorded().options), { ok: true, value: undefined });
  assert.equal(network.rpcs.length, 3);
});

/** July 0.2.13's three local refusal messages, each thrown by July's own code. */
async function julyLocalRefusalMessages(): Promise<string[]> {
  const caught = (call: Promise<unknown>) => call.then(() => assert.fail("expected July to refuse"), (error: unknown) => (error as Error).message);
  const messages: string[] = [];
  const fsKv = createHostKvApi({ agentName: "kv-verified-test", stateRoot: await mkdtemp(join(tmpdir(), "kv-verified-")) });
  messages.push(await caught(fsKv.get("")));

  const savedKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  try {
    const noCredential = hostedV2.cursorHostedStorageV2({ baseUrl: "https://kv.test", fetch: (async () => Response.json({})) as typeof fetch } as never);
    messages.push(await caught(noCredential.get("k")));
  } finally {
    if (savedKey !== undefined) process.env.CURSOR_API_KEY = savedKey;
  }

  const realFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = undefined;
  try {
    const noFetch = hostedV2.cursorHostedStorageV2({ apiKey: "test", baseUrl: "https://kv.test" } as never);
    messages.push(await caught(noFetch.get("k")));
  } finally {
    globalThis.fetch = realFetch;
  }
  return messages;
}

test("KV_LOCAL_REFUSALS: each July message stops as is, and retries with anything before or after it", async () => {
  const messages = await julyLocalRefusalMessages();
  assert.deepEqual(messages, [
    "host.kv key must be a non-empty string",
    "cursorHostedStorage requires CURSOR_API_KEY (deployment pod credential on Cursor hosting)",
    "cursorHostedStorage requires fetch",
  ]);
  for (const message of messages) {
    assert.equal(isRetryable(new Error(message)), false, `exact: ${message}`);
    assert.equal(isRetryable(new Error(`x ${message}`)), true, `prefixed: ${message}`);
    assert.equal(isRetryable(new Error(`${message} x`)), true, `suffixed: ${message}`);
  }
});

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { HostKvApi, HostKvCasApi, JsonValue } from "@cursor/july";
import { finishLease, leaseExpired, pendingLease, releaseLease, takeLease, type TakeResult } from "./claim-lease.js";
import { casShapedKv } from "./kv-backends.fixtures.js";
import { racingStores } from "./kv-race.fixtures.js";
import type { KvKey } from "./kv-keys.js";

const asKey = (raw: string): KvKey => raw as KvKey;

// Contract tests for the shared claim helper, on both backends ctx.host.kv
// has (see kv-verified.test.ts): the July filesystem kv and the hosted
// storage path, whose fake sorts object keys on write.

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
  { name: "filesystem kv", make: async () => createHostKvApi({ agentName: "claim-lease-test", stateRoot: await mkdtemp(join(tmpdir(), "claim-lease-")) }) },
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
};

function through(kv: HostKvApi, hooks: Hooks): HostKvApi & { puts: () => number } {
  const count = { get: 0, put: 0 };
  return {
    puts: () => count.put,
    get: async (key) => { await hooks.beforeGet?.(count.get++); return kv.get(key); },
    put: async (key, value) => {
      const n = count.put++;
      await hooks.beforePut?.(n);
      await kv.put(key, value);
      await hooks.afterPut?.(n);
    },
    delete: (key) => kv.delete(key),
  };
}

const K = asKey("announced/EX-1:Planned:1");
const LEASE_MS = 120_000;
const T0 = new Date("2026-09-23T00:00:00.000Z");
const after = (ms: number) => new Date(T0.getTime() + ms);
const take = (kv: HostKvApi, owner: string, now = T0) => takeLease(kv, K, { owner, leaseMs: LEASE_MS, now });

function gate(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === parties) open();
    await opened;
  };
}

/** Every kv call waits 0–10 ms first, as hosted round trips do. */
function jittered(kv: HostKvApi): HostKvApi {
  const pause = () => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 11)));
  return {
    get: async (key) => { await pause(); return kv.get(key); },
    put: async (key, value) => { await pause(); await kv.put(key, value); },
    delete: async (key) => { await pause(); await kv.delete(key); },
  };
}

test("a kv with compare-and-set takes with putIfAbsent: of two openers that both read the key absent, one is taken and the other held, with no settle wait", async () => {
  const kv = casShapedKv() as unknown as HostKvCasApi & { casCalls: string[] };
  const bothRead = gate(2);
  const opener = (): HostKvCasApi => ({
    get: (key) => kv.get(key),
    put: (key, value) => kv.put(key, value),
    delete: (key) => kv.delete(key),
    getWithVersion: async (key) => { const entry = await kv.getWithVersion(key); await bothRead(); return entry; },
    putIfAbsent: (key, value: JsonValue) => kv.putIfAbsent(key, value),
    putIfVersion: (key, value: JsonValue, version: string) => kv.putIfVersion(key, value, version),
    listKeys: (prefix) => kv.listKeys(prefix),
  });
  const started = Date.now();
  const options = (owner: string) => ({ owner, leaseMs: LEASE_MS, now: T0, settleMs: 5_000 });
  const results: TakeResult[] = await Promise.all([takeLease(opener(), K, options("a")), takeLease(opener(), K, options("b"))]);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(results.map((result) => result.status).sort(), ["held", "taken"]);
  const winner = results[0]?.status === "taken" ? "a" : "b";
  assert.equal(pendingLease(await kv.get(K))?.owner, winner);
  assert.ok(kv.casCalls.includes(`putIfAbsent:${K}`));
  assert.deepEqual(await finishLease(kv, K, winner, { fields: { ts: "1.2" } }), { status: "finished" });
  assert.ok(kv.casCalls.includes(`putIfVersion:${K}`));
  assert.equal((await take(kv, winner === "a" ? "b" : "a", after(10 * LEASE_MS))).status, "done");
});

for (const backend of backends) {
  test(`${backend.name}: an absent key is taken as pending; another owner sees it held, the same owner takes it again`, async () => {
    const kv = await backend.make();
    assert.deepEqual(await takeLease(kv, K, { owner: "a", leaseMs: LEASE_MS, now: T0, fields: { channel: "C1" } }), { status: "taken", at: T0.toISOString() });
    assert.deepEqual(await kv.get(K), { channel: "C1", state: "pending", owner: "a", at: T0.toISOString() });
    assert.deepEqual(await take(kv, "b", after(1000)), { status: "held", owner: "a", at: T0.toISOString() });
    assert.equal((await take(kv, "a", after(1000))).status, "taken");
  });

  test(`${backend.name}: a pending claim past its lease is taken over; before it, it is held`, async () => {
    const kv = await backend.make();
    await take(kv, "a");
    assert.equal((await take(kv, "b", after(LEASE_MS - 1))).status, "held");
    assert.equal((await take(kv, "b", after(LEASE_MS))).status, "taken");
    assert.equal(pendingLease(await kv.get(K))?.owner, "b");
    assert.equal(leaseExpired({ owner: "x", at: "not a time" }, LEASE_MS, T0), true);
    assert.equal(leaseExpired({ owner: "x", at: after(LEASE_MS + 1).toISOString() }, LEASE_MS, T0), true);
    assert.equal(leaseExpired({ owner: "x", at: after(1000).toISOString() }, LEASE_MS, T0), false);
  });

  test(`${backend.name}: done is final: finishing moves only this owner's pending claim, and done is never taken`, async () => {
    const kv = await backend.make();
    await takeLease(kv, K, { owner: "a", leaseMs: LEASE_MS, now: T0, fields: { channel: "C1" } });
    assert.deepEqual(await finishLease(kv, K, "b"), { status: "lost", current: { channel: "C1", state: "pending", owner: "a", at: T0.toISOString() } });
    assert.deepEqual(await finishLease(kv, K, "a", { fields: { ts: "1.2" } }), { status: "finished" });
    const done = { channel: "C1", state: "done", owner: "a", at: T0.toISOString(), ts: "1.2" };
    assert.deepEqual(await kv.get(K), done);
    assert.deepEqual(await take(kv, "b", after(10 * LEASE_MS)), { status: "done", current: done });
    assert.deepEqual(await finishLease(kv, K, "a"), { status: "lost", current: done });
    assert.deepEqual(await releaseLease(kv, K, "a"), { status: "lost", current: done });
    assert.deepEqual(await kv.get(K), done);
    assert.deepEqual(await finishLease(kv, asKey("absent"), "a"), { status: "lost", current: undefined });
  });

  test(`${backend.name}: a site's own final record ends the claim, and any stored value that is not pending counts as done`, async () => {
    const kv = await backend.make();
    await take(kv, "a");
    assert.deepEqual(await finishLease(kv, K, "a", { value: { threadTs: "1.2" } }), { status: "finished" });
    assert.deepEqual(await take(kv, "b", after(10 * LEASE_MS)), { status: "done", current: { threadTs: "1.2" } });
  });

  test(`${backend.name}: a release drops only this owner's pending claim`, async () => {
    const kv = await backend.make();
    await take(kv, "a");
    assert.equal((await releaseLease(kv, K, "b")).status, "lost");
    assert.equal(pendingLease(await kv.get(K))?.owner, "a");
    assert.deepEqual(await releaseLease(kv, K, "a"), { status: "released" });
    assert.equal(await kv.get(K), undefined);
  });

  test(`${backend.name}: an unreadable key or a put that never sticks is unavailable, never held or done`, async () => {
    const kv = await backend.make();
    const down = through(kv, { beforeGet: () => { throw new Error("kv unavailable"); } });
    assert.deepEqual(await take(down, "a"), { status: "unavailable" });
    assert.equal(down.puts(), 0);
    const refused = through(kv, { beforePut: () => { throw new Error("put refused"); } });
    assert.deepEqual(await take(refused, "a"), { status: "unavailable" });
    assert.equal(await kv.get(K), undefined);
  });

  test(`${backend.name}: no claim can block forever: a claim that landed unverified expires, and the side effect runs exactly once more`, async () => {
    const kv = await backend.make();
    let effects = 0;
    const deliver = async (store: HostKvApi, owner: string, now: Date) => {
      const taken = await take(store, owner, now);
      if (taken.status === "unavailable") {
        await releaseLease(store, K, owner).catch(() => undefined);
        return taken.status;
      }
      if (taken.status !== "taken") return taken.status;
      effects += 1;
      await finishLease(store, K, owner);
      return "done here";
    };
    const blind = through(kv, { beforeGet: (n) => { if (n >= 1) throw new Error("verify read down"); } });
    assert.equal(await deliver(blind, "a", T0), "unavailable");
    assert.equal(pendingLease(await kv.get(K))?.owner, "a");
    assert.equal(effects, 0);
    assert.equal(await deliver(kv, "b", after(LEASE_MS - 1)), "held");
    assert.equal(effects, 0);
    assert.equal(await deliver(kv, "c", after(LEASE_MS)), "done here");
    assert.equal(effects, 1);
    assert.equal(await deliver(kv, "d", after(10 * LEASE_MS)), "done");
    assert.equal(effects, 1);
  });

  test(`${backend.name}: pausesMs outlasts a short outage from a fresh read`, async () => {
    const kv = await backend.make();
    let down = true;
    const flaky = through(kv, { beforeGet: () => { if (down) throw new Error("kv unavailable"); } });
    const taking = takeLease(flaky, K, { owner: "a", leaseMs: LEASE_MS, now: T0, pausesMs: [5, 5] });
    setTimeout(() => { down = false; }, 1);
    assert.equal((await taking).status, "taken");
    assert.equal(pendingLease(await kv.get(K))?.owner, "a");
  });

  test(`${backend.name}: concurrent openers: a taker whose read-back finds another owner's claim yields to it`, async () => {
    const kv = await backend.make();
    const a = through(kv, { afterPut: async (n) => { if (n === 0) await kv.put(K, { state: "pending", owner: "b", at: T0.toISOString() }); } });
    assert.deepEqual(await take(a, "a"), { status: "held", owner: "b", at: T0.toISOString() });
    assert.equal(pendingLease(await kv.get(K))?.owner, "b");
  });

  test(`${backend.name}: concurrent openers that both read the key absent: without settleMs both are taken (the race), with it exactly one is`, async () => {
    const race = async (settleMs: number) => {
      const kv = await backend.make();
      const [first, second] = racingStores(kv, { prefix: K, after: "readBack" });
      const options = (owner: string) => ({ owner, leaseMs: LEASE_MS, now: T0, settleMs });
      const results = await Promise.all([takeLease(first, K, options("a")), takeLease(second, K, options("b"))]);
      return { statuses: results.map((result) => result.status), stored: pendingLease(await kv.get(K))?.owner };
    };
    assert.deepEqual(await race(0), { statuses: ["taken", "taken"], stored: "b" });
    assert.deepEqual(await race(20), { statuses: ["held", "taken"], stored: "b" });
  });

  test(`${backend.name}: eight concurrent openers with jittered kv latency: one side effect`, async () => {
    for (let round = 0; round < 10; round += 1) {
      const kv = await backend.make();
      let effects = 0;
      const open = async (owner: string) => {
        const taken = await takeLease(jittered(kv), K, { owner, leaseMs: LEASE_MS, now: T0, settleMs: 60 });
        if (taken.status !== "taken") return;
        effects += 1;
        await finishLease(kv, K, owner);
      };
      await Promise.all(Array.from({ length: 8 }, (_, i) => open(`o${i}`)));
      assert.equal(effects, 1, `round ${round}`);
      assert.equal((await kv.get(K) as Record<string, unknown>)["state"], "done");
    }
  });

  test(`${backend.name}: a claim that vanished during the settle wait is unavailable, never taken`, async () => {
    const kv = await backend.make();
    const deleting = through(kv, { beforeGet: async (n) => { if (n === 2) await kv.delete(K); } });
    assert.deepEqual(await takeLease(deleting, K, { owner: "a", leaseMs: LEASE_MS, now: T0, settleMs: 1 }), { status: "unavailable" });
  });

  test(`${backend.name}: an owner whose claim was taken over after expiry can neither finish nor release it`, async () => {
    const kv = await backend.make();
    await take(kv, "a");
    await take(kv, "b", after(LEASE_MS));
    assert.equal((await finishLease(kv, K, "a")).status, "lost");
    assert.equal((await releaseLease(kv, K, "a")).status, "lost");
    assert.equal(pendingLease(await kv.get(K))?.owner, "b");
  });
}

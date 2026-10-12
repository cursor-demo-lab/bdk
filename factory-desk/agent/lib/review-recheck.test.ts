import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { racingStores, recordKv } from "./kv-race.fixtures.js";
import { takeRecheck } from "./review-announce.js";
import { takeRecheck as takeRecheckFrozen } from "./testing/legacy/review-recheck.js";

// K4: the review re-check loop takes its head as an owner lease that the
// frozen read-then-put code (testing/legacy/review-recheck.ts), still running
// on a slug mid-deploy, honours through `until`.

const PR = { repository: "cursor-demo-lab/marsbank", number: 19 };
const HEAD = { headSha: "ABC123" };
const KEY = "review-recheck/cursor-demo-lab/marsbank#19/abc123";
const SCHEDULE = [60_000, 120_000];
const UNTIL = "2026-09-23T00:04:00.000Z";
const ENV = { FACTORY_DESK_CLAIM_SETTLE_MS: "5" };
const now = () => new Date("2026-09-23T00:00:00.000Z");

const takeNew = (kv: HostKvApi, env: NodeJS.ProcessEnv = ENV) => takeRecheck({ kv, env, now }, PR, HEAD, SCHEDULE);
const takeOld = (kv: HostKvApi) => takeRecheckFrozen({ kv, now }, PR, HEAD, SCHEDULE);
const loops = (taken: boolean[]) => taken.filter(Boolean).length;

type Faults = {
  /** Put numbers (0-based) that are lost without an error. */
  dropPuts?: readonly number[];
  /** Get numbers (0-based) that throw, or come back empty while the row stays. */
  gets?: Readonly<Record<number, "fail" | "absent">>;
};

/** Counts kv RPCs, with scripted faults. */
function countingKv(rows: Record<string, unknown>, faults: Faults = {}) {
  const count = { get: 0, put: 0, delete: 0 };
  const kv: HostKvApi = {
    get: async (key) => {
      const n = count.get++;
      const fault = faults.gets?.[n];
      if (fault === "fail") throw new Error("kv unavailable");
      return fault === "absent" ? undefined : (rows[key] as JsonValue | undefined);
    },
    put: async (key, value) => {
      const n = count.put++;
      if (faults.dropPuts?.includes(n)) return;
      rows[key] = value;
    },
    delete: async (key) => {
      count.delete += 1;
      delete rows[key];
    },
  };
  return { kv, count, total: () => count.get + count.put + count.delete };
}

test("a free head is taken as a lease old code reads: `{ state: pending, owner, at, until }` under the same key", async () => {
  const rows: Record<string, unknown> = {};
  assert.equal(await takeNew(recordKv(rows)), true);
  const stored = rows[KEY] as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored).sort(), ["at", "owner", "state", "until"]);
  assert.equal(stored["state"], "pending");
  assert.equal(stored["at"], now().toISOString());
  assert.equal(stored["until"], UNTIL, "the window the plain record had: the schedule plus the grace");
  assert.match(String(stored["owner"]), /^[0-9a-f-]{36}$/);
  assert.equal(await takeNew(recordKv(rows)), false, "a second wake on the head yields to the lease");
  assert.equal(await takeOld(recordKv(rows)), false, "old code honours the lease's until");
});

test("a lease past its window is taken over, by new code and old code alike", async () => {
  const later = () => new Date("2026-09-23T00:04:00.001Z");
  const rows: Record<string, unknown> = {};
  await takeNew(recordKv(rows));
  const first = (rows[KEY] as Record<string, unknown>)["owner"];
  assert.equal(await takeRecheck({ kv: recordKv(rows), env: ENV, now: later }, PR, HEAD, SCHEDULE), true);
  assert.notEqual((rows[KEY] as Record<string, unknown>)["owner"], first);

  const old: Record<string, unknown> = {};
  await takeNew(recordKv(old));
  assert.equal(await takeRecheckFrozen({ kv: recordKv(old), now: later }, PR, HEAD, SCHEDULE), true);
});

test("a legacy `{ until }` still inside its window holds the head and is left as it is", async () => {
  const rows: Record<string, unknown> = { [KEY]: { until: UNTIL } };
  const { kv, count } = countingKv(rows);
  assert.equal(await takeNew(kv), false);
  assert.deepEqual(rows, { [KEY]: { until: UNTIL } });
  assert.deepEqual(count, { get: 1, put: 0, delete: 0 });
});

test("a legacy `{ until }` past its window is overwritten while unchanged, then the lease settles", async () => {
  const rows: Record<string, unknown> = { [KEY]: { until: "2026-09-22T23:59:59.999Z" } };
  const { kv, count } = countingKv(rows);
  assert.equal(await takeNew(kv), true);
  const stored = rows[KEY] as Record<string, unknown>;
  assert.equal(stored["state"], "pending");
  assert.equal(stored["until"], UNTIL);
  assert.deepEqual(count, { get: 6, put: 2, delete: 0 }, "read; overwrite get, put, read back; lease get, put, read back, settle read");

  // Anything else that is not a lease (an unreadable until, a stray value) is no hold either, as for old code.
  for (const junk of [{ until: "soon" }, "x", [1], null] as JsonValue[]) {
    const other: Record<string, unknown> = { [KEY]: junk };
    assert.equal(await takeNew(recordKv(other)), true, JSON.stringify(junk));
    assert.equal((other[KEY] as Record<string, unknown>)["state"], "pending");
  }
});

test("an expired legacy record rewritten before the overwrite is kept: the new wake yields to it", async () => {
  const rows: Record<string, unknown> = { [KEY]: { until: "2026-09-22T23:59:59.999Z" } };
  const base = recordKv(rows);
  let gets = 0;
  const kv: HostKvApi = {
    ...base,
    get: async (key) => {
      const value = await base.get(key);
      // An old wake takes the head between this wake's read and its overwrite.
      if (gets++ === 0) rows[KEY] = { until: UNTIL };
      return value;
    },
  };
  assert.equal(await takeNew(kv), false);
  assert.deepEqual(rows, { [KEY]: { until: UNTIL } });
});

const EXPIRED = { until: "2026-09-22T23:59:59.999Z" };

/**
 * Deliveries sharing `kv`, whose kv calls run in `script` order: `A3` is
 * delivery A's fourth call (get, put or delete). One store per letter, in
 * the order the letters first appear. Calls after the script ends run
 * freely; until then every call waits its turn.
 */
function scriptedStores(kv: HostKvApi, script: readonly string[]): HostKvApi[] {
  let at = 0;
  let waiting: (() => void)[] = [];
  const turn = async (label: string) => {
    while (at < script.length && script[at] !== label) await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const advance = () => {
    const woken = waiting;
    waiting = [];
    for (const resolve of woken) resolve();
  };
  const store = (role: string): HostKvApi => {
    let calls = 0;
    const run = async <T>(op: () => Promise<T>): Promise<T> => {
      const label = `${role}${calls++}`;
      await turn(label);
      try {
        return await op();
      } finally {
        if (script[at] === label) {
          at += 1;
          advance();
        }
      }
    };
    return { get: (key) => run(() => kv.get(key)), put: (key, value) => run(() => kv.put(key, value)), delete: (key) => run(() => kv.delete(key)) };
  };
  const roles = [...new Set(script.map((label) => label.replace(/\d+$/, "")))];
  return roles.map(store);
}

for (const [name, start] of [["an expired legacy record", EXPIRED], ["a junk value", "x"]] as const) {
  test(`new × new from ${name}: two wakes that both read it start one loop, in every racing order`, async () => {
    for (const passReads of [0, 1]) {
      for (const after of ["readBack", "put"] as const) {
        const rows: Record<string, unknown> = { [KEY]: start };
        const [first, second] = racingStores(recordKv(rows), { prefix: "review-recheck/", after, passReads });
        const taken = await Promise.all([takeNew(first), takeNew(second)]);
        assert.equal(loops(taken), 1, `passReads ${passReads}, ${after}: ${taken}`);
        assert.equal((rows[KEY] as Record<string, unknown>)["state"], "pending");
      }
    }
  });

  test(`new × new from ${name}: a rival's overwrite landing between this wake's read-back and its settle makes it yield`, async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "log", (line: string) => void logged.push(line));
    const rows: Record<string, unknown> = { [KEY]: start };
    // Both read the stale value, B reads it again to replace it, then A
    // replaces it, takes and reads back its lease; B's replace put lands on
    // top (under delete-then-take, B's delete removed A's lease here) before
    // A's settle read.
    const [a, b] = scriptedStores(recordKv(rows), ["A0", "B0", "B1", "A1", "A2", "A3", "A4", "A5", "A6", "B2", "A7"]);
    const taken = await Promise.all([takeNew(a!), takeNew(b!)]);
    assert.deepEqual(taken, [false, true]);
    assert.deepEqual(logged, [], "a healthy store never logs unavailable");
  });
}

test("a stale record the overwrite cannot replace (every put lost) lets the loop run, as the delete it replaced did, and logs stale", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));
  for (const start of [EXPIRED, "x"] as JsonValue[]) {
    logged.length = 0;
    const rows: Record<string, unknown> = { [KEY]: start };
    const stuck = countingKv(rows, { dropPuts: [0, 1, 2] });
    assert.equal(await takeNew(stuck.kv), true, JSON.stringify(start));
    assert.deepEqual(rows, { [KEY]: start });
    assert.deepEqual(logged, ["stale"]);
    assert.equal(stuck.total(), 11, "read; three overwrite tries of get, put, read back; the lease read");
  }
});

test("an old wake whose clock is behind writes an already-past `{ until }` after two new wakes took the head: at most one new wake loops", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));
  // A and B both read the head free and take it (B's lease lands last);
  // the old wake read it free too and puts its `{ until }` before either settles.
  const schedule = ["A0", "B0", "O0", "A1", "B1", "A2", "A3", "B2", "B3", "O1", "A4", "B4"];
  for (const behindMs of [0, 20 * 60_000]) {
    logged.length = 0;
    const rows: Record<string, unknown> = {};
    const [a, b, o] = scriptedStores(recordKv(rows), schedule);
    const oldNow = () => new Date(now().getTime() - behindMs);
    const taken = await Promise.all([takeNew(a!), takeNew(b!), takeRecheckFrozen({ kv: o!, now: oldNow }, PR, HEAD, SCHEDULE)]);
    assert.deepEqual(taken, [false, false, true], `old clock ${behindMs} ms behind`);
    assert.deepEqual(logged, [], "the old wake's record is not the stale value first read");
  }
});

test("an old wake reading between the overwrite and the lease put sees the overwrite's live until and yields", async () => {
  const rows: Record<string, unknown> = { [KEY]: EXPIRED };
  // New wake: 0 read, 1 overwrite get, 2 overwrite put; then the old wake reads.
  const [fresh, old] = scriptedStores(recordKv(rows), ["A0", "A1", "A2", "O0"]);
  assert.deepEqual(await Promise.all([takeNew(fresh!), takeOld(old!)]), [true, false]);
  assert.equal((rows[KEY] as Record<string, unknown>)["until"], UNTIL);
});

test("an overwrite that cannot reach the store fails open, as documented, and logs unavailable", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));
  const rows: Record<string, unknown> = { [KEY]: EXPIRED };
  const down = countingKv(rows, { gets: { 1: "fail", 2: "fail", 3: "fail" } });
  assert.equal(await takeNew(down.kv), true);
  assert.deepEqual(logged, ["unavailable"]);
  assert.deepEqual(rows, { [KEY]: EXPIRED });
  assert.equal(down.total(), 4, "read, then three overwrite reads that fail");
});

test("a settle read that keeps failing, then an extra read that finds this wake's own lease: the loop runs, nothing logged", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));
  // Gets: 0 read, 1 lease read, 2 read back, 3-5 settle reads (fail), 6 the extra read.
  const flaky = countingKv({}, { gets: { 3: "fail", 4: "fail", 5: "fail" } });
  assert.equal(await takeNew(flaky.kv), true);
  assert.deepEqual(logged, []);
  assert.equal(flaky.total(), 8);
});

test("a lease gone at the settle is read once more: anything written since yields, an empty row logs vanished, a failed read logs unavailable", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));
  const rival = { until: UNTIL, state: "pending", owner: "rival", at: now().toISOString() };
  // Gets: 0 read, 1 lease read, 2 read back, 3 settle read (empty), 4 the extra read.
  const empty = { 3: "absent" } as const;
  const cases = [
    { name: "rival lease", gets: empty, row: rival, taken: false, outcome: [] },
    { name: "legacy until", gets: empty, row: { until: UNTIL }, taken: false, outcome: [] },
    { name: "already-past legacy until", gets: empty, row: EXPIRED, taken: false, outcome: [] },
    { name: "rival's expired lease", gets: empty, row: { ...rival, at: "2026-09-22T23:00:00.000Z", until: "2026-09-22T23:16:00.000Z" }, taken: false, outcome: [] },
    { name: "empty row", gets: { ...empty, 4: "absent" }, row: undefined, taken: true, outcome: ["vanished"] },
    { name: "store down", gets: { ...empty, 4: "fail" }, row: undefined, taken: true, outcome: ["unavailable"] },
  ] as const;
  for (const c of cases) {
    logged.length = 0;
    const rows: Record<string, unknown> = {};
    const counted = countingKv(rows, { gets: c.gets });
    const kv: HostKvApi = {
      ...counted.kv,
      get: async (key) => {
        if (counted.count.get === 4 && c.row !== undefined) rows[key] = c.row;
        return counted.kv.get(key);
      },
    };
    assert.equal(await takeNew(kv), c.taken, c.name);
    assert.deepEqual(logged, c.outcome, c.name);
    assert.equal(counted.total(), 6, c.name);
  }
});

test("the extra read finding the stale value first read, still unreplaced, lets the loop run and logs stale", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));
  const rows: Record<string, unknown> = { [KEY]: EXPIRED };
  // Gets: 0 read, 1 overwrite get, 2 read back, 3 lease get, 4 read back, 5 settle read (empty), 6 the extra read.
  const counted = countingKv(rows, { gets: { 5: "absent" } });
  const kv: HostKvApi = {
    ...counted.kv,
    get: async (key) => {
      if (counted.count.get === 6) rows[key] = EXPIRED;
      return counted.kv.get(key);
    },
  };
  assert.equal(await takeNew(kv), true);
  assert.deepEqual(logged, ["stale"]);
  assert.equal(counted.total(), 9);
});

test("a flaky but readable store: a rival's lease first read, the lease reads failing, then read again unchanged: a live one holds the head, an expired one is stale", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));
  const live = { until: UNTIL, state: "pending", owner: "rival", at: now().toISOString() };
  const expired = { until: "2026-09-22T23:16:00.000Z", state: "pending", owner: "rival", at: "2026-09-22T23:00:00.000Z" };
  // Gets: 0 read (ok), 1-3 the lease's reads (fail, so takeLease is unavailable), 4 the extra read (ok).
  for (const [row, taken, outcome] of [
    [live, false, []],
    [expired, true, ["stale"]],
  ] as const) {
    logged.length = 0;
    const rows: Record<string, unknown> = { [KEY]: row };
    const flaky = countingKv(rows, { gets: { 1: "fail", 2: "fail", 3: "fail" } });
    assert.equal(await takeNew(flaky.kv), taken, row.owner + " " + row.at);
    assert.deepEqual(logged, outcome);
    assert.deepEqual(rows, { [KEY]: row });
    assert.equal(flaky.total(), 5);
  }
});

/** `store`, with the gets numbered in `fail` (0-based, this store's own) throwing after they ran. */
function failingGets(store: HostKvApi, fail: ReadonlySet<number>): HostKvApi {
  let gets = 0;
  return {
    ...store,
    get: async (key) => {
      const n = gets++;
      const value = await store.get(key);
      if (fail.has(n)) throw new Error("kv unavailable");
      return value;
    },
  };
}

test("an old wake whose clock is behind puts an already-past `{ until }` while a new wake's settle reads fail: its extra read yields, so a later new wake is the only new loop", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));
  // A takes the free head; the old wake, which also read it free, puts its
  // `{ until }` after A's read-back; A's three settle reads fail and its extra
  // read sees the old record. B wakes after that.
  const schedule = ["A0", "O0", "A1", "A2", "A3", "O1", "A4", "A5", "A6", "A7", "B0"];
  for (const [behindMs, expected] of [
    [20 * 60_000, [false, true, true]],
    [0, [false, true, false]],
  ] as const) {
    logged.length = 0;
    const [a, o, b] = scriptedStores(recordKv({}), schedule);
    const oldNow = () => new Date(now().getTime() - behindMs);
    const taken = await Promise.all([takeNew(failingGets(a!, new Set([3, 4, 5]))), takeRecheckFrozen({ kv: o!, now: oldNow }, PR, HEAD, SCHEDULE), takeNew(b!)]);
    assert.deepEqual(taken, expected, `old clock ${behindMs} ms behind`);
    assert.ok(loops([taken[0], taken[2]]) <= 1, "at most one new loop");
    assert.ok(!logged.includes("vanished"));
  }
});

for (const after of ["readBack", "put"] as const) {
  test(`new × new with no compare-and-set (${after}): two wakes that both find the head free start one loop`, async () => {
    const rows: Record<string, unknown> = {};
    const [first, second] = racingStores(recordKv(rows), { prefix: "review-recheck/", after, passReads: 1 });
    const taken = await Promise.all([takeNew(first), takeNew(second)]);
    assert.equal(loops(taken), 1, JSON.stringify(taken));
    assert.equal((rows[KEY] as Record<string, unknown>)["state"], "pending");
  });
}

test("new × new, both gated on their first read: still one loop", async () => {
  for (const after of ["readBack", "put"] as const) {
    const [first, second] = racingStores(recordKv({}), { prefix: "review-recheck/", after });
    assert.equal(loops(await Promise.all([takeNew(first), takeNew(second)])), 1, after);
  }
});

/**
 * `passReads: 1` for one delivery only: the new wake's first read (before it
 * takes the lease) goes straight to `direct`, so racingStores gates its lease
 * read and counts its read-back as the second read. The old wake reads once.
 */
function pastFirstRead(stores: { racing: HostKvApi; direct: HostKvApi }): HostKvApi {
  const { racing, direct } = stores;
  let first = true;
  return {
    ...racing,
    get: (key) => {
      if (!first) return racing.get(key);
      first = false;
      return direct.get(key);
    },
  };
}

test("old × new, the new wake first: the old put lands after the new wake's put or read-back, inside its settle, and the new wake yields: one loop", async () => {
  for (const after of ["readBack", "put"] as const) {
    const base = recordKv({});
    const [first, second] = racingStores(base, { prefix: "review-recheck/", after });
    const [fresh, old] = await Promise.all([takeNew(pastFirstRead({ racing: first, direct: base })), takeOld(second)]);
    assert.deepEqual([fresh, old], [false, true], after);
  }
});

test("old × new, the old wake first: the new put lands on the old one and both loop, today's worst case, never more", async () => {
  const base = recordKv({});
  const [first, second] = racingStores(base, { prefix: "review-recheck/", after: "put" });
  const [old, fresh] = await Promise.all([takeOld(first), takeNew(pastFirstRead({ racing: second, direct: base }))]);
  assert.deepEqual([old, fresh], [true, true]);
});

/** `stores` deliveries sharing `kv`: every one reads the key before any writes, then each put waits its own delay. */
function gatedStores(kv: HostKvApi, putDelaysMs: readonly number[]): HostKvApi[] {
  let arrived = 0;
  let open!: () => void;
  const allRead = new Promise<void>((resolve) => (open = resolve));
  return putDelaysMs.map((delay) => {
    let first = true;
    return {
      get: async (key) => {
        if (first) {
          first = false;
          arrived += 1;
          if (arrived === putDelaysMs.length) open();
          await allRead;
        }
        return kv.get(key);
      },
      put: async (key, value) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await kv.put(key, value);
      },
      delete: (key) => kv.delete(key),
    };
  });
}

test("one old and two new wakes on one head, every put order: never three loops, and never two new ones", async () => {
  const env = { FACTORY_DESK_CLAIM_SETTLE_MS: "30" };
  const orders = [
    [0, 3, 6],
    [0, 6, 3],
    [3, 0, 6],
    [3, 6, 0],
    [6, 0, 3],
    [6, 3, 0],
  ];
  for (const delays of orders) {
    const [old, a, b] = gatedStores(recordKv({}), delays);
    const [byOld, byA, byB] = await Promise.all([takeOld(old!), takeNew(a!, env), takeNew(b!, env)]);
    assert.ok(loops([byOld, byA, byB]) <= 2, `${delays}: ${[byOld, byA, byB]}`);
    assert.ok(loops([byA, byB]) <= 1, `${delays}: ${[byA, byB]}`);
  }
});

test("FACTORY_DESK_RECHECK_LEASE=off restores the plain read-then-put exactly: the same record and the same race", async () => {
  const off = { ...ENV, FACTORY_DESK_RECHECK_LEASE: "off" };
  const rows: Record<string, unknown> = {};
  const frozen: Record<string, unknown> = {};
  assert.equal(await takeNew(recordKv(rows), off), await takeOld(recordKv(frozen)));
  assert.deepEqual(rows, frozen);
  assert.deepEqual(rows, { [KEY]: { until: UNTIL } });
  assert.equal(await takeNew(recordKv(rows), off), false);

  const [first, second] = racingStores(recordKv({}), { prefix: "review-recheck/", after: "put" });
  assert.deepEqual(await Promise.all([takeNew(first, off), takeNew(second, off)]), [true, true], "two loops, as before the lease");

  const unreadable = countingKv({}, { gets: { 0: "fail" } });
  assert.equal(await takeNew(unreadable.kv, off), true);
  assert.equal(unreadable.total(), 1, "one read, then fail open");
  for (const [value, state] of [["OFF", undefined], [" off ", undefined], ["on", "pending"], ["", "pending"]] as const) {
    const flagged: Record<string, unknown> = {};
    await takeNew(recordKv(flagged), { ...ENV, FACTORY_DESK_RECHECK_LEASE: value });
    assert.equal((flagged[KEY] as Record<string, unknown>)["state"], state, JSON.stringify(value));
  }
});

test("store-operation budget (plan §3.4): 5 RPCs to take a free head and 16 at most; 8 over a stale record and 25 at most", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => void logged.push(JSON.parse(line).outcome));

  const typical = countingKv({});
  assert.equal(await takeNew(typical.kv), true);
  assert.deepEqual(typical.count, { get: 4, put: 1, delete: 0 }, "read, then read, put, read back, settle read");

  // The most a free head can cost: the first read retried to its third try,
  // updateVerified's three tries of get/put/get (two puts lost), the settle
  // read retried three times, and the one extra read after unavailable.
  const free = countingKv({}, { dropPuts: [0, 1], gets: { 0: "fail", 1: "fail", 9: "fail", 10: "fail", 11: "fail", 12: "fail" } });
  assert.equal(await takeNew(free.kv), true, "unavailable fails open, as before");
  assert.equal(free.total(), 16);
  assert.deepEqual(logged.splice(0), ["unavailable"]);

  const stale = countingKv({ [KEY]: EXPIRED });
  assert.equal(await takeNew(stale.kv), true);
  assert.equal(stale.total(), 8, "read; overwrite get, put, read back; lease get, put, read back, settle read");

  // The most over a stale record (rollout only): as above, plus the
  // overwrite's own three tries before the lease's.
  const worst = countingKv(
    { [KEY]: EXPIRED },
    { dropPuts: [0, 1], gets: { 0: "fail", 1: "fail", 10: "absent", 11: "absent", 12: "absent", 13: "absent", 15: "fail", 16: "fail", 17: "fail", 18: "fail" } }
  );
  assert.equal(await takeNew(worst.kv), true);
  assert.equal(worst.total(), 25);
  assert.deepEqual(logged.splice(0), ["unavailable"]);

  const held: Record<string, unknown> = {};
  await takeNew(recordKv(held));
  const yielding = countingKv(held);
  assert.equal(await takeNew(yielding.kv), false);
  assert.equal(yielding.total(), 2, "read, then the lease's read refuses");

  const live = countingKv({ [KEY]: { until: UNTIL } });
  assert.equal(await takeNew(live.kv), false);
  assert.equal(live.total(), 1);

  const unreadable = countingKv({}, { gets: { 0: "fail", 1: "fail", 2: "fail" } });
  assert.equal(await takeNew(unreadable.kv), true, "an unreadable store lets the loop run");
  assert.equal(unreadable.total(), 3);
  assert.deepEqual(logged, ["unavailable"]);
});

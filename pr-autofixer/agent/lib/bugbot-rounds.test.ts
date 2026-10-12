import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { BUGBOT_MAX_ROUNDS, bugbotRoundsKey, peekBugbotRound, recordBugbotRound, roundsMergeOn, type BugbotRound } from "./auto-drive.js";
import * as legacy from "./testing/legacy/bugbot-rounds.js";

// Bugbot round records (plan K8): the round and the cap note are verified
// merges, decided again on whatever a rival wrote, so two heads recorded at
// once spend two rounds and two peeks past the cap post one note, whenever
// each put lands before the other's read-back. Two new writers can still
// lose a round when a put lands after the rival's read-back (the residual
// kv-verified.ts documents: host.kv has no compare-and-set). The old code
// (testing/legacy, still run by a slug mid-deploy) never reads back, so
// against it any old put that lands before the new put is lost.

const PR = { owner: "cursor-demo-lab", repo: "marsbank", number: 13, url: "https://github.com/cursor-demo-lab/marsbank/pull/13", label: "cursor-demo-lab/marsbank#13" };
const KEY = bugbotRoundsKey(PR);
const ON = {};
const OFF = { FACTORY_FIXER_ROUNDS_MERGE: "off" };

type Rows = Map<string, JsonValue>;
type Rounds = { shas: string[]; rounds: number; capNoted?: true };

function rowsKv(rows: Rows): HostKvApi {
  return {
    get: async (key) => structuredClone(rows.get(key)),
    put: async (key, value) => void rows.set(key, structuredClone(value)),
    delete: async (key) => void rows.delete(key),
  };
}

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait: () => opened };
}

/**
 * Two writers on one store, each of which puts at least once. Both make
 * every read that precedes their first put before either puts; then
 * `first`'s put lands, then `second`'s, and only then may either read again
 * (a read-back): the "put" interleaving, where a writer that reads back sees
 * the other's value.
 */
function interleaved(rows: Rows): { first: HostKvApi; second: HostKvApi } {
  const kv = rowsKv(rows);
  const bothArrived = gate();
  const firstPut = gate();
  const secondPut = gate();
  let arrived = 0;
  const view = (role: "first" | "second"): HostKvApi => {
    let puts = 0;
    return {
      get: async (key) => {
        if (puts > 0) await secondPut.wait();
        return kv.get(key);
      },
      put: async (key, value) => {
        const n = puts++;
        if (n === 0) {
          if (++arrived === 2) bothArrived.open();
          await bothArrived.wait();
          if (role === "second") await firstPut.wait();
        }
        await kv.put(key, value);
        if (n === 0) (role === "first" ? firstPut : secondPut).open();
      },
      delete: kv.delete,
    };
  };
  return { first: view("first"), second: view("second") };
}

/** The record without the cap note's owner token, shas sorted. */
function plain(rows: Rows) {
  const { capNotedBy: _token, ...rest } = (rows.get(KEY) ?? {}) as Rounds & { capNotedBy?: string };
  return { ...rest, shas: rest.shas?.slice().sort() };
}

const rounds = (rows: Rows) => rows.get(KEY) as Rounds | undefined;

/** A PR whose first round's peek wrote the empty record, as every record now expects. */
const opened = (): Rows => new Map([[KEY, { shas: [], rounds: 0 }]]);

test("two heads recorded at once spend two rounds, in either order", async () => {
  for (const order of ["a first", "b first"]) {
    const rows: Rows = opened();
    const { first, second } = interleaved(rows);
    const [a, b] = order === "a first" ? [first, second] : [second, first];
    await Promise.all([recordBugbotRound(a, { pr: PR, headSha: "a1", env: ON }), recordBugbotRound(b, { pr: PR, headSha: "b2", env: ON })]);
    assert.equal(rounds(rows)?.rounds, 2, order);
    assert.deepEqual(rounds(rows)?.shas.slice().sort(), ["a1", "b2"], order);
  }
});

test("the same head recorded twice at once, or again later, spends one round", async () => {
  const rows: Rows = opened();
  const { first, second } = interleaved(rows);
  await Promise.all([recordBugbotRound(first, { pr: PR, headSha: "a1", env: ON }), recordBugbotRound(second, { pr: PR, headSha: "A1", env: ON })]);
  assert.deepEqual(rounds(rows), { shas: ["a1"], rounds: 1 });
  await recordBugbotRound(rowsKv(rows), { pr: PR, headSha: "a1", env: ON });
  assert.deepEqual(rounds(rows), { shas: ["a1"], rounds: 1 });
});

test("a record keeps the cap note and any field it does not know", async () => {
  const rows: Rows = new Map([[KEY, { shas: ["a1"], rounds: 1, capNoted: true, capNotedBy: "t-1", v: 2 }]]);
  await recordBugbotRound(rowsKv(rows), { pr: PR, headSha: "b2", env: ON });
  assert.deepEqual(rows.get(KEY), { shas: ["a1", "b2"], rounds: 2, capNoted: true, capNotedBy: "t-1", v: 2 });
});

// Old code puts without reading back. An old put that lands between the new
// put and its read-back is found and merged onto. One that lands before the
// new put is overwritten by it (the new writer decided on a read that
// predates it, and its read-back sees its own value); against new code the
// rival's own read-back would repair that, but old code has none.
test("old code against new: an old put landing before the new read-back is merged; one landing before the new put can still lose one round", async () => {
  const newPutFirst: Rows = opened();
  const race1 = interleaved(newPutFirst);
  await Promise.all([recordBugbotRound(race1.first, { pr: PR, headSha: "a1", env: ON }), legacy.recordBugbotRound(race1.second, { pr: PR, headSha: "b2" })]);
  assert.equal(rounds(newPutFirst)?.rounds, 2, "the new read-back saw the old round and merged onto it");

  const oldPutFirst: Rows = opened();
  const race2 = interleaved(oldPutFirst);
  await Promise.all([legacy.recordBugbotRound(race2.first, { pr: PR, headSha: "b2" }), recordBugbotRound(race2.second, { pr: PR, headSha: "a1", env: ON })]);
  assert.equal(rounds(oldPutFirst)?.rounds, 1, "the new put overwrote the old round, and old code never reads back (residual while a slug deploys)");
});

test("FACTORY_FIXER_ROUNDS_MERGE=off is the plain read-then-put: two heads at once spend one round, like the old code", async () => {
  const rows: Rows = opened();
  const { first, second } = interleaved(rows);
  await Promise.all([recordBugbotRound(first, { pr: PR, headSha: "a1", env: OFF }), recordBugbotRound(second, { pr: PR, headSha: "b2", env: OFF })]);
  assert.equal(rounds(rows)?.rounds, 1);
  assert.equal(rounds(rows)?.shas.length, 1);
});

const atCap = (): Rows => new Map([[KEY, { shas: ["a1", "b2"], rounds: BUGBOT_MAX_ROUNDS }]]);

test("two peeks past the cap at once: one notes the cap, the other finds the note and stays quiet", async () => {
  for (const heads of [["c3", "d4"], ["c3", "c3"]]) {
    const rows = atCap();
    const { first, second } = interleaved(rows);
    const outcomes = await Promise.all([
      peekBugbotRound(first, { pr: PR, headSha: heads[0], env: ON }),
      peekBugbotRound(second, { pr: PR, headSha: heads[1], env: ON }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome === "cap_reached").length, 1, JSON.stringify({ heads, outcomes }));
    const other: BugbotRound = heads[0] === heads[1] ? "duplicate" : "capped";
    assert.equal(outcomes.filter((outcome) => outcome === other).length, 1, JSON.stringify({ heads, outcomes }));
    assert.equal(rounds(rows)?.capNoted, true);
    assert.equal(rounds(rows)?.rounds, BUGBOT_MAX_ROUNDS, "a cap note spends no round");
  }
});

test("a cap note and a rival's round recorded at once both survive, in either order, and the note still goes", async () => {
  for (const order of ["round first", "note first"]) {
    const rows = atCap();
    const { first, second } = interleaved(rows);
    const [recorder, peeker] = order === "round first" ? [first, second] : [second, first];
    const [, peeked] = await Promise.all([recordBugbotRound(recorder, { pr: PR, headSha: "c3", env: ON }), peekBugbotRound(peeker, { pr: PR, headSha: "d4", env: ON })]);
    assert.equal(peeked, "cap_reached", order);
    assert.deepEqual(plain(rows), { shas: ["a1", "b2", "c3", "d4"], rounds: 3, capNoted: true }, order);
  }
});

test("FACTORY_FIXER_ROUNDS_MERGE=off: two peeks past the cap at once both note it, as before K8", async () => {
  const rows = atCap();
  const { first, second } = interleaved(rows);
  const outcomes = await Promise.all([peekBugbotRound(first, { pr: PR, headSha: "c3", env: OFF }), peekBugbotRound(second, { pr: PR, headSha: "d4", env: OFF })]);
  assert.deepEqual(outcomes, ["cap_reached", "cap_reached"]);
});

test("peek outcomes are unchanged: drive, duplicate, cap_reached once, then capped; a key deleted on close starts at round 0", async () => {
  const rows: Rows = new Map();
  const kv = rowsKv(rows);
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "a1", env: ON }), "drive");
  await recordBugbotRound(kv, { pr: PR, headSha: "a1", env: ON });
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "A1", env: ON }), "duplicate");
  await recordBugbotRound(kv, { pr: PR, headSha: "b2", env: ON });
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "c3", env: ON }), "cap_reached");
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "c3", env: ON }), "duplicate");
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "d4", env: ON }), "capped");
  rows.delete(KEY);
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "d4", env: ON }), "drive");
});

test("a record or cap note the store will not take never throws; the record is logged and the note still goes", async (t) => {
  const warned: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => { warned.push(String(line)); });
  const rows = atCap();
  const refusing: HostKvApi = { ...rowsKv(rows), put: async () => { throw Object.assign(new Error("kv 503"), { status: 503 }); } };
  const retry = { pausesMs: [] };
  await recordBugbotRound(refusing, { pr: PR, headSha: "c3", env: ON, retry });
  assert.equal(await peekBugbotRound(refusing, { pr: PR, headSha: "c3", env: ON, retry }), "cap_reached");
  assert.equal(warned.filter((line) => line.includes('"record_unavailable"')).length, 1);
  assert.deepEqual(rows.get(KEY), { shas: ["a1", "b2"], rounds: BUGBOT_MAX_ROUNDS });
});

// The peek's cap note lands, a rival's round is merged onto it, and only then
// does the peek read back: it finds its own note (by `capNotedBy`) inside the
// rival's record. Without the token it would read its head as already taken,
// answer `duplicate`, and the cap note would never be posted.
test("a peek whose note a rival merged a round onto before its read-back still answers cap_reached", async () => {
  const rows = atCap();
  const kv = rowsKv(rows);
  const peekPut = gate();
  const recordPut = gate();
  let peekReads = 0;
  const peeker: HostKvApi = {
    get: async (key) => {
      if (peekReads++ === 2) await recordPut.wait();
      return kv.get(key);
    },
    put: async (key, value) => { await kv.put(key, value); peekPut.open(); },
    delete: kv.delete,
  };
  let recordReads = 0;
  const recorder: HostKvApi = {
    get: async (key) => {
      if (recordReads++ === 0) await peekPut.wait();
      return kv.get(key);
    },
    put: async (key, value) => { await kv.put(key, value); recordPut.open(); },
    delete: kv.delete,
  };
  const [peeked] = await Promise.all([peekBugbotRound(peeker, { pr: PR, headSha: "d4", env: ON }), recordBugbotRound(recorder, { pr: PR, headSha: "c3", env: ON })]);
  assert.equal(peeked, "cap_reached");
  assert.deepEqual(plain(rows), { shas: ["a1", "b2", "c3", "d4"], rounds: 3, capNoted: true });
});

test("FACTORY_FIXER_ROUNDS_MERGE=off (any case or spacing) notes the cap with one plain put and no read-back; the next head is capped", async () => {
  for (const off of ["off", " OFF ", "Off"]) {
    const rows = atCap();
    const calls: string[] = [];
    const inner = rowsKv(rows);
    const kv: HostKvApi = {
      get: async (key) => { calls.push("get"); return inner.get(key); },
      put: async (key, value) => { calls.push("put"); await inner.put(key, value); },
      delete: inner.delete,
    };
    const env = { FACTORY_FIXER_ROUNDS_MERGE: off };
    assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "c3", env }), "cap_reached", off);
    assert.deepEqual(calls, ["get", "put"], off);
    assert.deepEqual(rows.get(KEY), { shas: ["a1", "b2", "c3"], rounds: BUGBOT_MAX_ROUNDS, capNoted: true }, off);
    assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "d4", env }), "capped", off);
  }
  assert.equal(roundsMergeOn({ FACTORY_FIXER_ROUNDS_MERGE: " OFF " }), false);
  assert.equal(roundsMergeOn({ FACTORY_FIXER_ROUNDS_MERGE: "on" }), true);
  assert.equal(roundsMergeOn({}), true);
});

// A peek past the cap races the PR's close: the close deletes the record
// between the peek's first read and its merge. The merge finds nothing
// stored, reads again, finds the record gone, and answers round 0 (`drive`)
// instead of posting a cap note on a PR whose rounds were just reset.
test("a peek racing a close that deleted the record answers drive, and notes no cap", async () => {
  const rows = atCap();
  const inner = rowsKv(rows);
  let reads = 0;
  const kv: HostKvApi = {
    ...inner,
    get: async (key) => {
      if (reads++ === 1) rows.delete(KEY);
      return inner.get(key);
    },
  };
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "c3", env: ON, retry: { pausesMs: [] } }), "drive");
  assert.equal(rows.has(KEY), false, "nothing written");
});

test("a merge that loses with nothing stored and cannot read again still notes the cap (fails open, as before)", async () => {
  const rows = atCap();
  const inner = rowsKv(rows);
  let reads = 0;
  const kv: HostKvApi = {
    ...inner,
    get: async (key) => {
      reads += 1;
      if (reads === 2) rows.delete(KEY);
      if (reads > 2) throw Object.assign(new Error("kv 503"), { status: 503 });
      return inner.get(key);
    },
  };
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "c3", env: ON, retry: { pausesMs: [] } }), "cap_reached");
});

// Bugbot on PR #198: a record that lands after a close deleted the key (an
// in-flight start, or a flush's send) used to write `{ rounds: 1 }` back, so
// the reopened PR began at round 1. The peek now writes the empty record
// before a PR's first round, and the record only adds to one that exists.
test("the first peek writes the empty record; a record that finds no record (the close deleted it) writes nothing and is logged", async (t) => {
  const warned: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => { warned.push(String(line)); });
  const rows: Rows = new Map();
  const kv = rowsKv(rows);
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "a1", env: ON }), "drive");
  assert.deepEqual(rows.get(KEY), { shas: [], rounds: 0 }, "the peek opened the count");
  rows.delete(KEY);
  await recordBugbotRound(kv, { pr: PR, headSha: "a1", env: ON });
  assert.equal(rows.has(KEY), false, "the reopened PR still starts at round 0");
  assert.equal(warned.filter((line) => line.includes('"record_skipped_no_record"')).length, 1);
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "a1", env: ON }), "drive");
  await recordBugbotRound(kv, { pr: PR, headSha: "a1", env: ON });
  assert.deepEqual(rows.get(KEY), { shas: ["a1"], rounds: 1 });
});

test("a later peek on an existing record, or a peek with rounds merge off, writes no empty record", async () => {
  const rows: Rows = new Map([[KEY, { shas: ["a1"], rounds: 1 }]]);
  const puts: unknown[] = [];
  const inner = rowsKv(rows);
  const kv: HostKvApi = { ...inner, put: async (key, value) => { puts.push(value); await inner.put(key, value); } };
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "b2", env: ON }), "drive");
  rows.delete(KEY);
  assert.equal(await peekBugbotRound(kv, { pr: PR, headSha: "b2", env: OFF }), "drive");
  assert.deepEqual(puts, []);
});

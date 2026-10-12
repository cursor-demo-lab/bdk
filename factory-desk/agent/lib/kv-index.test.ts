import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { addIndexEntry, indexList, indexMergeOn, pruneIndexEntries } from "./kv-index.js";
import type { KvKey } from "./kv-keys.js";
import { racingStores, recordKv } from "./kv-race.fixtures.js";

// The shared verified index merge on its own; hop-watch.index.test.ts here
// and factory-worker's implement-pr-index.test.ts race it through the callers.

const KEY = "hop-watch/index" as KvKey;

type Op = "get" | "put";

function counting(inner: HostKvApi, script: (n: number) => { value?: unknown; fail?: true } | undefined = () => undefined) {
  const ops: Op[] = [];
  const kv: HostKvApi = {
    get: async (key) => {
      ops.push("get");
      const step = script(ops.length);
      if (step?.fail) throw new Error("kv read failed");
      if (step !== undefined && "value" in step) return step.value as never;
      return inner.get(key);
    },
    put: async (key, value) => {
      ops.push("put");
      if (script(ops.length)?.fail) throw new Error("kv write failed");
      await inner.put(key, value);
    },
    delete: (key) => inner.delete(key),
  };
  return { kv, ops };
}

test("FACTORY_INDEX_MERGE=off is the only way to turn the merge off", () => {
  assert.equal(indexMergeOn({}), true);
  assert.equal(indexMergeOn({ FACTORY_INDEX_MERGE: "off" }), false);
  assert.equal(indexMergeOn({ FACTORY_INDEX_MERGE: " OFF " }), false);
  assert.equal(indexMergeOn({ FACTORY_INDEX_MERGE: "on" }), true);
  assert.equal(indexMergeOn({ FACTORY_INDEX_MERGE: "0" }), true);
});

test("indexList keeps the strings of a stored list and reads anything else as empty", () => {
  assert.deepEqual(indexList(["A-1", 2, "A-3", null]), ["A-1", "A-3"]);
  assert.deepEqual(indexList(undefined), []);
  assert.deepEqual(indexList({ keys: ["A-1"] }), []);
});

test("an add unions onto the stored list: added once, then present, never a duplicate", async () => {
  const rows: Record<string, unknown> = { [KEY]: ["A-1"] };
  assert.equal(await addIndexEntry(recordKv(rows), KEY, { entry: "A-2", attempts: 2 }), "added");
  assert.equal(await addIndexEntry(recordKv(rows), KEY, { entry: "A-2", attempts: 1 }), "present");
  assert.deepEqual(rows[KEY], ["A-1", "A-2"]);
});

for (const after of ["readBack", "put"] as const) {
  test(`two adds that both read first, "${after}" interleaving: the loser merges onto the winner`, async () => {
    const rows: Record<string, unknown> = {};
    const [first, second] = racingStores(recordKv(rows), { prefix: KEY, after, passReads: 0 });
    const results = await Promise.all([addIndexEntry(first, KEY, { entry: "A-1", attempts: 3 }), addIndexEntry(second, KEY, { entry: "A-2", attempts: 3 })]);
    if (after === "put") assert.deepEqual([...(rows[KEY] as string[])].sort(), ["A-1", "A-2"]);
    else {
      // The second put lands after the first read-back: the confirm (a later add) is what puts A-1 back.
      assert.deepEqual(results, ["added", "added"]);
      assert.equal(await addIndexEntry(recordKv(rows), KEY, { entry: "A-1", attempts: 1 }), "added");
      assert.deepEqual([...(rows[KEY] as string[])].sort(), ["A-1", "A-2"]);
    }
  });
}

test("a prune removes only the gone entries from the list as stored now, and reports an unchanged list", async () => {
  const rows: Record<string, unknown> = { [KEY]: ["A-1", "A-2", "A-3"] };
  assert.equal(await pruneIndexEntries(recordKv(rows), KEY, { gone: new Set(["A-1", "A-9"]) }), "pruned");
  assert.deepEqual(rows[KEY], ["A-2", "A-3"]);
  assert.equal(await pruneIndexEntries(recordKv(rows), KEY, { gone: new Set(["A-1"]) }), "unchanged");
});

test("a prune racing an add keeps the add in either order", async () => {
  for (const role of [0, 1] as const) {
    const rows: Record<string, unknown> = { [KEY]: ["A-1"] };
    const [first, second] = racingStores(recordKv(rows), { prefix: KEY, after: "put" });
    const [pruning, adding] = role === 0 ? [first, second] : [second, first];
    await Promise.all([pruneIndexEntries(pruning, KEY, { gone: new Set(["A-1"]) }), addIndexEntry(adding, KEY, { entry: "A-2", attempts: 3 })]);
    assert.ok((rows[KEY] as string[]).includes("A-2"), `role ${role}: ${JSON.stringify(rows[KEY])}`);
  }
});

test("kv calls: an add is 1 (present) or 3 (added) per attempt, at most 3 per attempt; a prune is 3, at most 9", async () => {
  const added = counting(recordKv({}));
  await addIndexEntry(added.kv, KEY, { entry: "A-1", attempts: 2 });
  assert.deepEqual(added.ops, ["get", "put", "get"]);

  const present = counting(recordKv({ [KEY]: ["A-1"] }));
  await addIndexEntry(present.kv, KEY, { entry: "A-1", attempts: 2 });
  assert.deepEqual(present.ops, ["get"]);

  const other = (n: number) => ({ value: [`OTHER-${n}`] });
  const worstAdd = counting(recordKv({}), (n) => (n > 1 && n % 3 !== 2 ? other(n) : undefined));
  assert.equal(await addIndexEntry(worstAdd.kv, KEY, { entry: "A-1", attempts: 2 }), "unavailable");
  assert.equal(worstAdd.ops.length, 6);

  const pruned = counting(recordKv({ [KEY]: ["A-1", "A-2"] }));
  await pruneIndexEntries(pruned.kv, KEY, { gone: new Set(["A-1"]) });
  assert.deepEqual(pruned.ops, ["get", "put", "get"]);

  const worstPrune = counting(recordKv({ [KEY]: ["A-1"] }), (n) => (n > 1 && n % 3 !== 2 ? { value: ["A-1", `OTHER-${n}`] } : undefined));
  assert.equal(await pruneIndexEntries(worstPrune.kv, KEY, { gone: new Set(["A-1"]) }), "unavailable");
  assert.equal(worstPrune.ops.length, 9);

  for (const attempts of [1, 2, 3]) {
    const broken = counting(recordKv({}), () => ({ fail: true }));
    assert.equal(await addIndexEntry(broken.kv, KEY, { entry: "A-1", attempts }), "unavailable");
    assert.ok(broken.ops.length <= 3 * attempts);
  }
});

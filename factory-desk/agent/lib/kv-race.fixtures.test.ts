import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { racingStores, recordKv } from "./kv-race.fixtures.js";

const KEY = "claim/TLSSN-42";

/** What one delivery saw: its first read, and its read-back when it does one. */
type Seen = { before: unknown; after?: unknown };

async function readThenPut(kv: HostKvApi, value: JsonValue): Promise<Seen> {
  const before = await kv.get(KEY);
  await kv.put(KEY, value);
  return { before };
}

async function readPutReadBack(kv: HostKvApi, value: JsonValue): Promise<Seen> {
  const before = await kv.get(KEY);
  await kv.put(KEY, value);
  return { before, after: await kv.get(KEY) };
}

test('after: "put": both deliveries read the key absent, and the second put lands after the first', async () => {
  const rows: Record<string, unknown> = {};
  const [first, second] = racingStores(recordKv(rows), { prefix: "claim/", after: "put" });
  const seen = await Promise.all([readThenPut(first, "first"), readThenPut(second, "second")]);
  assert.deepEqual(seen, [{ before: undefined }, { before: undefined }]);
  assert.equal(rows[KEY], "second");
});

test('after: "readBack": the first delivery reads its own value back before the second put lands, so both read-backs pass', async () => {
  const rows: Record<string, unknown> = {};
  const [first, second] = racingStores(recordKv(rows), { prefix: "claim/", after: "readBack" });
  const seen = await Promise.all([readPutReadBack(first, "first"), readPutReadBack(second, "second")]);
  assert.deepEqual(seen, [
    { before: undefined, after: "first" },
    { before: undefined, after: "second" },
  ]);
  assert.equal(rows[KEY], "second");
});

test("passReads lets each delivery's leading reads through, and keys outside the prefix are never held", async () => {
  const rows: Record<string, unknown> = { [KEY]: "old", "other/key": "untouched" };
  const [first, second] = racingStores(recordKv(rows), { prefix: "claim/", after: "put", passReads: 1 });
  assert.equal(await first.get(KEY), "old");
  assert.equal(await second.get(KEY), "old");
  assert.equal(await first.get("other/key"), "untouched");
  await second.put("other/key", "written");
  assert.equal(rows["other/key"], "written");
  await first.delete("other/key");
  assert.equal("other/key" in rows, false);
});

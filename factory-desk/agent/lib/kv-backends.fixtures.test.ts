import assert from "node:assert/strict";
import { after, test } from "node:test";
import { supportsKvCas, type HostKvCasApi } from "@cursor/july";
import { casShapedKv, filesystemKv, hostedKv, KV_BACKENDS, removeKvRoots } from "./kv-backends.fixtures.js";

after(removeKvRoots);

test("the stand-ins for ctx.host.kv have no compare-and-set, as on July 0.2.13; only casShapedKv does", async () => {
  assert.equal(supportsKvCas(await filesystemKv()), false);
  assert.equal(supportsKvCas(hostedKv()), false);
  assert.equal(supportsKvCas(casShapedKv()), true);
  assert.deepEqual(
    KV_BACKENDS.map(([name]) => name),
    ["filesystem kv", "hosted storage kv", "kv with unused CAS methods"]
  );
});

test("every backend puts, gets, and deletes a JSON value; the hosted one returns object keys reordered", async () => {
  const value = { state: "pending", at: "2026-09-23T00:00:00.000Z", owner: "a" };
  for (const [name, make] of KV_BACKENDS) {
    const kv = await make();
    assert.equal(await kv.get("claim/TLSSN-42"), undefined, name);
    await kv.put("claim/TLSSN-42", value);
    assert.deepEqual(await kv.get("claim/TLSSN-42"), value, name);
    await kv.delete("claim/TLSSN-42");
    assert.equal(await kv.get("claim/TLSSN-42"), undefined, name);
  }
  const hosted = hostedKv();
  await hosted.put("k", value);
  assert.notDeepEqual(Object.keys((await hosted.get("k")) as object), Object.keys(value));
});

test("casShapedKv records each compare-and-set call and refuses a stale version", async () => {
  const kv = casShapedKv() as unknown as HostKvCasApi & { casCalls: string[] };
  assert.deepEqual(await kv.putIfAbsent("k", 1), { ok: true, version: "1" });
  assert.deepEqual(await kv.putIfAbsent("k", 2), { ok: false });
  assert.deepEqual(await kv.putIfVersion("k", 3, "0"), { ok: false });
  assert.deepEqual(await kv.putIfVersion("k", 3, "1"), { ok: true, version: "2" });
  assert.deepEqual(await kv.getWithVersion("k"), { value: 3, version: "2" });
  assert.deepEqual(kv.casCalls, ["putIfAbsent:k", "putIfAbsent:k", "putIfVersion:k", "putIfVersion:k", "getWithVersion:k"]);
});

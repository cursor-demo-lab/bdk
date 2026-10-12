import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { KV_BACKENDS, removeKvRoots } from "./kv-backends.fixtures.js";
import { updateVerifiedDesk } from "./kv-verified-desk.js";
import type { KvKey } from "./kv-keys.js";

const asKey = (raw: string): KvKey => raw as KvKey;

after(removeKvRoots);

const K = asKey("claim:desk#1");
const create = (value: JsonValue) => (current: JsonValue | undefined) => (current === undefined ? value : undefined);

/** Puts numbered from 0: `refuse` throws before writing, `lose` writes then throws. */
function puts(kv: HostKvApi, faults: { refuse?: (n: number) => boolean; lose?: (n: number) => boolean; before?: (n: number) => Promise<void> }) {
  let n = 0;
  const wrapped: HostKvApi & { count: () => number } = {
    count: () => n,
    get: (key) => kv.get(key),
    put: async (key, value) => {
      const i = n++;
      await faults.before?.(i);
      if (faults.refuse?.(i) === true) throw new Error("kv put refused");
      await kv.put(key, value);
      if (faults.lose?.(i) === true) throw new Error("kv put response lost");
    },
    delete: (key) => kv.delete(key),
  };
  return wrapped;
}

for (const [name, make] of KV_BACKENDS) {
  test(`${name}: a put that keeps failing while reads work is unavailable, never lost`, async () => {
    const kv = await make();
    assert.deepEqual(await updateVerifiedDesk(puts(kv, { refuse: () => true }), K, create({ owner: "a" })), { status: "unavailable" });
    assert.equal(await kv.get(K), undefined);
  });

  test(`${name}: a refusal after a failed put is lost, with the rival value it saw`, async () => {
    const kv = await make();
    const racing = puts(kv, { refuse: (n) => n === 0, before: async (n) => { if (n === 0) await kv.put(K, { owner: "b" }); } });
    assert.deepEqual(await updateVerifiedDesk(racing, K, create({ owner: "a" })), { status: "lost", current: { owner: "b" } });
  });

  test(`${name}: a put that lands but reports an error is written`, async () => {
    const kv = await make();
    assert.equal((await updateVerifiedDesk(puts(kv, { lose: (n) => n === 0 }), K, create({ owner: "a" }))).status, "written");
    assert.deepEqual(await kv.get(K), { owner: "a" });
  });
}

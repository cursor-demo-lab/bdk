import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
// Not in the package exports map; this is the factory July uses for ctx.host.kv.
import { createHostKvApi } from "../../node_modules/@cursor/july/dist/internal/host-kv.js";
import { priorReview, recordReview, reviewedRecord } from "./reviewed-head.js";

// host.kv offers get, put, and delete only; no backend offers compare-and-set,
// so these helpers never branch on one. The contract they need is that a put
// is read back as the same JSON, keys are independent, and an absent key reads
// as undefined. Each backend July can hand the agent is checked for that.
async function backends(): Promise<[string, HostKvApi][]> {
  const stateRoot = await mkdtemp(join(tmpdir(), "reviewer-kv-"));
  const hosted = new Map<string, string>();
  return [
    ["filesystem", createHostKvApi({ agentName: "security-reviewer", stateRoot })],
    [
      "hosted storage",
      createHostKvApi({
        agentName: "security-reviewer",
        stateRoot,
        storage: {
          supportsAuthorKv: true,
          kvGet: async (key) => {
            const raw = hosted.get(key);
            return raw === undefined ? undefined : (JSON.parse(raw) as JsonValue);
          },
          kvPut: async (key, value) => { hosted.set(key, JSON.stringify(value)); },
          kvDelete: async (key) => { hosted.delete(key); },
        },
      }),
    ],
  ];
}

const SHA = "0123456789ABCDEF0123456789abcdef01234567";
const BASE = "b".repeat(40);

test("a first write, an overwrite, and a neighbouring PR read back per key on every backend", async () => {
  const identity = { fullName: "Acme/Repo", number: 7, base: BASE, headSha: SHA };
  const complete = { base: BASE, headSha: SHA.toLowerCase(), complete: true };
  for (const [name, kv] of await backends()) {
    assert.equal(await priorReview({ kv, identity }), undefined, name);
    await recordReview({ kv, identity, at: "2026-09-23T00:00:00.000Z" });
    assert.deepEqual(await priorReview({ kv, identity: { ...identity, fullName: "acme/repo" } }), complete, name);
    assert.equal(await priorReview({ kv, identity: { ...identity, number: 70 } }), undefined, name);
    await recordReview({ kv, identity: { ...identity, base: "c".repeat(40) }, at: "2026-09-23T00:00:01.000Z" });
    assert.equal(await priorReview({ kv, identity }), undefined, name);
    assert.deepEqual(await priorReview({ kv, identity: { ...identity, base: "c".repeat(40) } }), { ...complete, base: "c".repeat(40) }, name);
    await recordReview({ kv, identity, at: "2026-09-23T00:00:02.000Z", incomplete: { totalChars: 305_000 } });
    const incomplete = { base: BASE, headSha: SHA.toLowerCase(), complete: false, totalChars: 305_000 };
    assert.deepEqual(await reviewedRecord(kv, "acme/repo", 7), incomplete, name);
    assert.deepEqual(await priorReview({ kv, identity }), incomplete, name);
  }
});

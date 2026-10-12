import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { priorReview, recordReview, reviewedRecord } from "./reviewed-head.js";

function memoryKv(): HostKvApi {
  const store = new Map<string, unknown>();
  return {
    get: async (key) => store.get(key) as never,
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
  };
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "b".repeat(40);
const AT = "2026-09-24T00:00:00.000Z";
const IDENTITY = { fullName: "acme/repo", number: 7, base: BASE, headSha: SHA };

test("a review is recorded per repo and PR, whatever the case of the repo and the shas", async () => {
  const kv = memoryKv();
  await recordReview({ kv, identity: { fullName: "Acme/Repo", number: 7, base: BASE.toUpperCase(), headSha: SHA.toUpperCase() }, at: AT });
  assert.deepEqual(await kv.get("reviewed/acme/repo#7"), { base: BASE, headSha: SHA, at: AT });
  assert.deepEqual(await priorReview({ kv, identity: IDENTITY }), { base: BASE, headSha: SHA, complete: true });
  assert.deepEqual(await priorReview({ kv, identity: { ...IDENTITY, base: BASE.toUpperCase(), headSha: SHA.toUpperCase() } }), { base: BASE, headSha: SHA, complete: true });
});

test("changing any one field of the evidence identity reviews again", async () => {
  const kv = memoryKv();
  await recordReview({ kv, identity: IDENTITY, at: AT });
  const variants = {
    repo: { ...IDENTITY, fullName: "acme/other" },
    number: { ...IDENTITY, number: 17 },
    base: { ...IDENTITY, base: "c".repeat(40) },
    head: { ...IDENTITY, headSha: "f".repeat(40) },
  };
  const decided: Record<string, boolean> = {};
  for (const [field, identity] of Object.entries(variants)) {
    decided[field] = (await priorReview({ kv, identity })) !== undefined;
  }
  assert.deepEqual(decided, { repo: false, number: false, base: false, head: false });
  assert.notEqual(await priorReview({ kv, identity: IDENTITY }), undefined);
});

test("a base named by branch is not pinned, so it never suppresses, recorded or not", async () => {
  const kv = memoryKv();
  await recordReview({ kv, identity: { ...IDENTITY, base: "main" }, at: AT });
  assert.deepEqual(await reviewedRecord(kv, "acme/repo", 7), { base: "main", headSha: SHA, complete: true });
  assert.equal(await priorReview({ kv, identity: { ...IDENTITY, base: "main" } }), undefined);
  await recordReview({ kv, identity: IDENTITY, at: AT });
  assert.equal(await priorReview({ kv, identity: { ...IDENTITY, base: "main" } }), undefined);
  assert.notEqual(await priorReview({ kv, identity: IDENTITY }), undefined);
});

test("a head-only record from before the base was recorded reviews again", async () => {
  const kv = memoryKv();
  await kv.put("reviewed/acme/repo#7", { headSha: SHA, at: AT });
  assert.equal(await reviewedRecord(kv, "acme/repo", 7), undefined);
  assert.equal(await priorReview({ kv, identity: IDENTITY }), undefined);
  await kv.put("reviewed/acme/repo#7", { headSha: SHA, at: AT, complete: false, totalChars: 9e9 });
  assert.equal(await priorReview({ kv, identity: IDENTITY }), undefined);
});

test("a corrupt record, a stored sha that is only a prefix of the head or longer than it, or a missing store reads as not reviewed", async () => {
  const kv = memoryKv();
  for (const value of [
    { base: BASE, headSha: SHA.slice(0, 7) },
    { base: BASE, headSha: `${SHA}0` },
    "x",
    [],
    null,
    { base: BASE, headSha: 5 },
    { base: 5, headSha: SHA },
    { base: BASE, headSha: SHA, complete: false },
    { base: BASE, headSha: SHA, complete: false, totalChars: "9e9" },
    { base: BASE, headSha: SHA, complete: "no", totalChars: 9e9 },
  ]) {
    await kv.put("reviewed/acme/repo#7", value as never);
    assert.equal(await priorReview({ kv, identity: IDENTITY }), undefined);
  }
  assert.equal(await priorReview({ kv: undefined, identity: IDENTITY }), undefined);
});

test("an incomplete review suppresses its identity until the cap can hold the whole diff", async () => {
  const kv = memoryKv();
  await recordReview({ kv, identity: IDENTITY, at: AT, incomplete: { totalChars: 200_000 } });
  const incomplete = { base: BASE, headSha: SHA, complete: false, totalChars: 200_000 };
  assert.deepEqual(await reviewedRecord(kv, "acme/repo", 7), incomplete);
  assert.deepEqual(await priorReview({ kv, identity: IDENTITY }), incomplete);
  assert.deepEqual(await priorReview({ kv, identity: IDENTITY, maxChars: 199_999 }), incomplete);
  assert.equal(await priorReview({ kv, identity: IDENTITY, maxChars: 200_000 }), undefined);
  assert.equal(await priorReview({ kv, identity: IDENTITY, maxChars: 250_000 }), undefined);
  assert.equal(await priorReview({ kv, identity: { ...IDENTITY, base: "c".repeat(40) } }), undefined);
  await recordReview({ kv, identity: IDENTITY, at: "2026-09-24T00:00:01.000Z" });
  assert.deepEqual(await reviewedRecord(kv, "acme/repo", 7), { base: BASE, headSha: SHA, complete: true });
  assert.deepEqual(await priorReview({ kv, identity: IDENTITY, maxChars: 250_000 }), { base: BASE, headSha: SHA, complete: true });
});

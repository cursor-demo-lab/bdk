import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { memoryKv } from "../fakes.js";
import { addToIndex, IMPLEMENT_PR_INDEX } from "./implement-pr-index.js";

test("frozen addToIndex: its in-process queue keeps both keys when two arms in one process add at once", async () => {
  const kv = memoryKv();
  await Promise.all([addToIndex(kv, "TLSSN-1"), addToIndex(kv, "TLSSN-2")]);
  assert.deepEqual(kv.entries.get(IMPLEMENT_PR_INDEX), ["TLSSN-1", "TLSSN-2"]);
});

test("frozen addToIndex: another process's index write between its read and its put is lost", async () => {
  const kv = memoryKv();
  const otherProcess: HostKvApi = {
    ...kv,
    get: async (key) => {
      const seen = await kv.get(key);
      if (key === IMPLEMENT_PR_INDEX) await kv.put(key, ["TLSSN-1"]);
      return seen;
    },
  };
  await addToIndex(otherProcess, "TLSSN-2");
  assert.deepEqual(kv.entries.get(IMPLEMENT_PR_INDEX), ["TLSSN-2"]);
});

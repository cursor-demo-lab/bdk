import type { JsonValue } from "@cursor/july";
import { updateVerified, type VerifiedResult } from "./kv-verified.js";
import type { KeyedKv, KvKey } from "./kv-keys.js";

// Desk only. kv-verified.ts is the copy shared verbatim with the other
// agents; what the desk needs beyond it lives here, and every desk update
// goes through this function.
//
// 1. A put that keeps failing while reads work comes back from
//    updateVerified as `lost` with `current: undefined`, as if another
//    writer held the key. Here it is `unavailable`: the key is unknown, so
//    a write reports a kv failure instead of "already held".
//
// Claims that dedupe a side effect go through claim-lease.ts instead.
export async function updateVerifiedDesk(kv: KeyedKv, key: KvKey, decide: (current: JsonValue | undefined) => JsonValue | undefined): Promise<VerifiedResult> {
  // Reset on every decision, so it describes only the last attempt's put;
  // a refusal returns before any put.
  let putFailed = false;
  const tracked: KeyedKv = {
    get: (k) => kv.get(k),
    put: async (k, value) => {
      try {
        await kv.put(k, value);
      } catch (error) {
        putFailed = true;
        throw error;
      }
    },
    delete: (k) => kv.delete(k),
  };
  const result = await updateVerified(tracked, key, (current) => {
    putFailed = false;
    return decide(current);
  });
  return result.status === "lost" && putFailed ? { status: "unavailable" } : result;
}

import type { HostKvApi } from "@cursor/july";

// Frozen: the desk's `addToIndex` for `hop-watch/index` from
// agent/lib/hop-watch.ts at 268fc79, with `readIndex`. A slug mid-deploy
// still runs this code, so race tests pit it against the live index writes
// in both orders. Never edit it to follow the live file; delete it once no
// deployed slug can run it.

export const HOP_WATCH_INDEX = "hop-watch/index";

export async function addToIndex(kv: HostKvApi, issueKey: string): Promise<void> {
  const index = await readIndex(kv);
  if (!index.includes(issueKey)) await kv.put(HOP_WATCH_INDEX, [...index, issueKey]);
}

export async function readIndex(kv: HostKvApi): Promise<string[]> {
  const value = await kv.get(HOP_WATCH_INDEX);
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
}

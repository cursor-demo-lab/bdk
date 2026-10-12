import type { JsonValue } from "@cursor/july";
import { updateVerified } from "./kv-verified.js";
import type { KeyedKv, KvKey } from "./kv-keys.js";

// A kv list of keys (`hop-watch/index`, `implement-pr-watch/index`), kept
// because host.kv cannot list keys. host.kv has no compare-and-set, so two
// writers that read the list and put it back used to lose one another's
// change: an arm could drop another arm's entry, and a sweep's prune could
// drop an entry armed while it ran. Both writes here go through
// updateVerified, which re-reads the stored list and re-decides on it:
//
// - An add is a union onto whatever the list holds now. The caller writes it
//   with `attempts: 2`, waits (the desk's claim settle plus jitter, or the
//   worker's reminder create), then confirms with `attempts: 1`, which re-adds only if
//   the entry is missing again. Worst case 6 + 3 = 9 kv calls per arm.
// - A prune removes only the entries the caller verified gone, from the list
//   as stored at the write, never from the snapshot the sweep started with.
//
// The residual is a writer whose put lands after the other's last read-back
// (and, for an add, after its confirm). The entry then comes back on that
// ticket's next arm or fire, which adds it again.
//
// `FACTORY_INDEX_MERGE=off` restores each caller's plain read-then-put; the
// callers read it per request.
//
// Shared verbatim by factory-desk and factory-worker; its test is
// factory-desk's kv-index.test.ts (scripts/copies-parity.test.mjs).

/** `FACTORY_INDEX_MERGE=off` turns the verified merge off; anything else, or unset, keeps it on. */
export function indexMergeOn(env: NodeJS.ProcessEnv): boolean {
  return env.FACTORY_INDEX_MERGE?.trim().toLowerCase() !== "off";
}

export function indexList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
}

export type IndexAdd = "added" | "present" | "unavailable";

/** Union `entry` onto the stored list. `unavailable`: the put never stuck, or kept failing. */
export async function addIndexEntry(kv: KeyedKv, key: KvKey, input: { entry: string; attempts: number }): Promise<IndexAdd> {
  let present = false;
  const result = await updateVerified(
    kv,
    key,
    (current) => {
      const list = indexList(current);
      present = list.includes(input.entry);
      return present ? undefined : ([...list, input.entry] satisfies JsonValue);
    },
    { attempts: input.attempts }
  );
  if (result.status === "written") return "added";
  return result.status === "lost" && present ? "present" : "unavailable";
}

export type IndexPrune = "pruned" | "unchanged" | "unavailable";

/** Remove `gone` from the list as stored now; entries added since the caller's snapshot stay. */
export async function pruneIndexEntries(kv: KeyedKv, key: KvKey, input: { gone: ReadonlySet<string> }): Promise<IndexPrune> {
  let unchanged = false;
  const result = await updateVerified(kv, key, (current) => {
    const list = indexList(current);
    const next = list.filter((entry) => !input.gone.has(entry));
    unchanged = next.length === list.length;
    return unchanged ? undefined : next;
  });
  if (result.status === "written") return "pruned";
  return result.status === "lost" && unchanged ? "unchanged" : "unavailable";
}

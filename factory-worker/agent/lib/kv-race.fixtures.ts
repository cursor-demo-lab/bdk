import type { HostKvApi } from "@cursor/july";

/**
 * Two deliveries sharing `kv`. On keys under `race.prefix` both read before
 * either writes, and the second delivery's put lands only after the first
 * has read the key back (`after: "readBack"`) or written it (`after: "put"`):
 * the interleavings a read, put, read-back claim cannot see on its own.
 * `passReads` lets that many leading reads of each delivery through untouched,
 * for a caller that checks the key once before it takes the claim.
 * `after: "readBack"` waits for the first delivery's second read of the key,
 * so a claim that never reads back (plain read then put) needs `"put"`.
 */
export function racingStores(kv: HostKvApi, race: { prefix: string; after: "readBack" | "put"; passReads?: number }): [HostKvApi, HostKvApi] {
  const { prefix, after } = race;
  const passReads = race.passReads ?? 0;
  let arrived = 0;
  let open!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    open = resolve;
  });
  let signal!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const store = (role: "first" | "second"): HostKvApi => {
    let gets = 0;
    return {
      get: async (key) => {
        if (!key.startsWith(prefix)) return kv.get(key);
        const n = gets++ - passReads;
        if (n < 0) return kv.get(key);
        if (n === 0) {
          arrived += 1;
          if (arrived === 2) open();
          await bothRead;
        }
        const value = await kv.get(key);
        if (role === "first" && after === "readBack" && n === 1) signal();
        return value;
      },
      put: async (key, value) => {
        if (key.startsWith(prefix) && role === "second") await firstDone;
        await kv.put(key, value);
        if (key.startsWith(prefix) && role === "first" && after === "put") signal();
      },
      delete: (key) => kv.delete(key),
    };
  };
  return [store("first"), store("second")];
}

/** A plain object as a kv, as the channel tests keep it. */
export function recordKv(rows: Record<string, unknown>): HostKvApi {
  return {
    get: async (key) => rows[key] as never,
    put: async (key, value) => void (rows[key] = value),
    delete: async (key) => void delete rows[key],
  };
}

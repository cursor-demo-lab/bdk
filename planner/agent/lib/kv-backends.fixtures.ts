import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostKvApi, JsonValue } from "@cursor/july";
// Not a public export: this is the factory July 0.2.13 uses to build
// ctx.host.kv (internal/session-engine.js:304), so helpers run against
// exactly what a handler gets.
import { createHostKvApi } from "../../node_modules/@cursor/july/dist/internal/host-kv.js";

const roots: string[] = [];

export async function removeKvRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** Local serve: one JSON file per key under the state root. */
export async function filesystemKv(): Promise<HostKvApi> {
  const stateRoot = await mkdtemp(join(tmpdir(), "desk-kv-"));
  roots.push(stateRoot);
  return createHostKvApi({ agentName: "factory-desk", stateRoot });
}

/**
 * Hosted: a defineStorage sink reached through July's storage coordinator
 * (internal/storage-coordinator.js:514-546). Values are stored serialized
 * and come back with object keys reordered, as a JSON column may return
 * them.
 */
export function hostedKv(): HostKvApi {
  const rows = new Map<string, string>();
  return createHostKvApi({
    agentName: "factory-desk",
    stateRoot: "/nonexistent",
    storage: {
      supportsAuthorKv: true,
      kvGet: async (key: string) => {
        const row = rows.get(key);
        return row === undefined ? undefined : reorderKeys(JSON.parse(row) as JsonValue);
      },
      kvPut: async (key: string, value: JsonValue) => {
        rows.set(key, JSON.stringify(value));
      },
      kvDelete: async (key: string) => {
        rows.delete(key);
      },
    } as never,
  });
}

function reorderKeys(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reorderKeys);
  const names = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? 1 : a > b ? -1 : 0));
  return Object.fromEntries(names.map((name) => [name, reorderKeys(value[name]!)]));
}

/**
 * A kv that also carries working compare-and-set methods, the shape
 * `supportsKvCas` probes for. `ctx.host.kv` never has them yet; every call
 * is recorded, so a test can show which helpers use them (claim-lease.ts
 * does) and which must work without them.
 */
export function casShapedKv(): HostKvApi & { casCalls: string[] } {
  const rows = new Map<string, { value: JsonValue; version: number }>();
  let version = 0;
  const casCalls: string[] = [];
  return {
    casCalls,
    get: async (key: string) => rows.get(key)?.value,
    put: async (key: string, value: JsonValue) => void rows.set(key, { value, version: (version += 1) }),
    delete: async (key: string) => void rows.delete(key),
    getWithVersion: async (key: string) => {
      casCalls.push(`getWithVersion:${key}`);
      const row = rows.get(key);
      return row === undefined ? undefined : { value: row.value, version: String(row.version) };
    },
    putIfAbsent: async (key: string, value: JsonValue) => {
      casCalls.push(`putIfAbsent:${key}`);
      if (rows.has(key)) return { ok: false };
      rows.set(key, { value, version: (version += 1) });
      return { ok: true, version: String(version) };
    },
    putIfVersion: async (key: string, value: JsonValue, expected: string) => {
      casCalls.push(`putIfVersion:${key}`);
      if (String(rows.get(key)?.version) !== expected) return { ok: false };
      rows.set(key, { value, version: (version += 1) });
      return { ok: true, version: String(version) };
    },
    listKeys: async () => {
      casCalls.push("listKeys");
      return [...rows.keys()];
    },
  } as HostKvApi & { casCalls: string[] };
}

export const KV_BACKENDS: Array<[string, () => Promise<HostKvApi> | HostKvApi]> = [
  ["filesystem kv", filesystemKv],
  ["hosted storage kv", hostedKv],
  ["kv with unused CAS methods", casShapedKv],
];

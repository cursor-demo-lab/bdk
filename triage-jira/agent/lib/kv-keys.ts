// Every host.kv key triage-jira reads or writes is built here, and every
// prefix is listed in KEY_REGISTRY. host.kv cannot list keys, so this file is
// the only inventory of what it keeps (cleanup and operator tooling read it).
//
// What holds that in place:
// - Builders return KvKey, which only `kvKey` below can make. Agent code
//   takes its store as KeyedKv, and the verified and lease helpers and the
//   options fields that carry a key are typed KvKey, so `npm run check`
//   rejects a plain string passed to any of them.
// - ../../../scripts/kv-key-registry.test.mjs checks, with the compiler's
//   types, every call that reaches July's HostKvApi or HostKvCasApi (under
//   any name, destructured, or after supportsKvCas) and every `key` or
//   `claimKey` field passed to an agent function: each must be a KvKey. It
//   also fails on a cast to KvKey, a HostKvApi annotation, or a literal that
//   spells a registry key anywhere in agent code but this file (tests and
//   fixtures aside), on a store passed, assigned, returned or cast into a
//   declared type other than KeyedKv, HostKvApi, HostKvCasApi, a Partial of
//   one, or unknown (a hand-written `{ put(key: string) }` would take any
//   string; the script lists the flows it follows), on `any` where a KvKey
//   goes, and on a registry entry it cannot act on.
// Neither can tell whether a KvKey from one builder was passed where another
// was meant; that is what the builder names are for.
//
// The stored row is `agentsdk/v1/<agent name>/kv/<key>`, and every key below
// is a live format: changing a builder's output, or the agent name pinned in
// ../agent.ts, orphans every record written under the old one. July writes
// `<key>` URI-encoded (`ticket/X-1` is stored as `ticket%2FX-1`), and a key
// whose encoding is over 256 bytes as `sha256:<hex digest of the raw key>`
// (0.2.13 dist/storage-protocol.js `keySegment`), so operator tooling that
// reads rows directly must encode keys the same way.

import type { HostKvApi, JsonValue } from "@cursor/july";
/**
 * keep: never deleted; a later event reads it to refuse a repeat.
 * transient: the code deletes it on its normal path; a leftover can go.
 * expire: nothing deletes it; safe to drop once idle for `horizonDays`.
 */
export type KeyLifecycle = "keep" | "transient" | "expire";

/**
 * How writers race on the key. lease: takeLease with a settle re-read.
 * verified: updateVerified/deleteVerified. claim: CAS when present, else
 * get then put. blind: plain put, last writer wins. index: a read-modify-write list.
 */
export type KeyConcurrency = "lease" | "verified" | "claim" | "blind" | "index";

/**
 * One builder's keys. Several builders can share a prefix (a keep index next
 * to transient per-ticket records), so a sweeper must pick keys by builder
 * and lifecycle, never by prefix alone.
 */
export type KeyEntry = {
  prefix: string;
  builder: string;
  identity: readonly string[];
  owner: string;
  readers: readonly string[];
  lifecycle: KeyLifecycle;
  horizonDays?: number;
  concurrency: KeyConcurrency;
  pii: boolean;
  note?: string;
};

/**
 * A host.kv key. Only this file makes one (`kvKey`), so a string built
 * anywhere else does not type-check where a key is expected.
 */
export type KvKey = string & { readonly __kvKey: true };

/**
 * host.kv with every key typed KvKey. Agent code takes its store as KeyedKv;
 * ctx.host.kv (July's HostKvApi) is assignable to it as is, so `keyedKv` is
 * only for a call made on ctx.host.kv in place.
 */
export type KeyedKv = {
  get(key: KvKey): Promise<JsonValue | undefined>;
  put(key: KvKey, value: JsonValue): Promise<void>;
  delete(key: KvKey): Promise<void>;
};

export function keyedKv(kv: HostKvApi): KeyedKv {
  return kv;
}

function kvKey(raw: string): KvKey {
  return raw as KvKey;
}

/** This agent's production deploy slug (docs/factory-deployment.md); lib/ops-funnel.ts adds `-staging` on a staging slug. */
export const factorySlug = "factory-triage-jira";

/** The ops funnel's hourly dedupe marker, `v1/ops-alert/<hash16>/<UTC hour>`, and its host.files path when kv fails (lib/ops-funnel.ts). */
export function opsAlertKey(input: { hash: string; hour: string }): KvKey {
  return kvKey(`v1/ops-alert/${input.hash}/${input.hour}`);
}

/** The issue as Jira delivered it, for the Jev judge. Read and delete. */
export function inboundKey(identifier: string): KvKey {
  return kvKey(`triage-inbound/${identifier}`);
}

/** What Jev answered on the wake, for a fallback record_triage. Read and delete. */
export function jevAnswersKey(identifier: string): KvKey {
  return kvKey(`triage-jev/${identifier}`);
}

export function outcomeKey(sessionId: string): KvKey {
  return kvKey(`triage-outcome/${sessionId}`);
}

/** Per Jira project: the issue types the tracker lists (agent/lib/issue-type.ts, shared with factory-desk). */
export function issueTypesCacheKey(project: string): KvKey {
  return kvKey(`triage-issue-types/${project}`);
}

const DAYS = 7;

export const KEY_REGISTRY: readonly KeyEntry[] = [
  { prefix: "triage-inbound/", builder: "inboundKey", identity: ["issueKey"], owner: "lib/inbound.ts", readers: ["tools/record_triage.ts", "lib/jev-first.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: true, note: "Holds the reporter and description; deleted when read or when no turn will read it." },
  { prefix: "triage-jev/", builder: "jevAnswersKey", identity: ["issueKey"], owner: "lib/jev-first.ts", readers: ["tools/record_triage.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "triage-outcome/", builder: "outcomeKey", identity: ["sessionId"], owner: "lib/record-verdict.ts", readers: ["hooks/triage-outcome.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "triage-issue-types/", builder: "issueTypesCacheKey", identity: ["jiraProjectKey"], owner: "lib/issue-type.ts", readers: ["lib/issue-type.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false, note: "A cache with `exp`; deleted when read expired." },
  { prefix: "v1/ops-alert/", builder: "opsAlertKey", identity: ["hash16 of (slug, site, reason)", "UTC hour"], owner: "lib/ops-funnel.ts", readers: ["lib/ops-funnel.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false, note: "One ops Slack line per signature per hour; read then put, no CAS." },
];

// Every host.kv key the planner reads or writes is built here, and every
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
// (`keySegment`, July 0.2.24 dist/storage-protocol.js), so operator tooling that
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
export const factorySlug = "factory-planner";

/** The ops funnel's hourly dedupe marker, `v1/ops-alert/<hash16>/<UTC hour>`, and its host.files path when kv fails (lib/ops-funnel.ts). */
export function opsAlertKey(input: { hash: string; hour: string }): KvKey {
  return kvKey(`v1/ops-alert/${input.hash}/${input.hour}`);
}

/** One claim per transition. A redelivery carries the same changelog id; a replan carries a new one. */
export function planClaimKey(input: { issueKey: string; status: string; changelogId: string }): KvKey {
  return kvKey(`plan/${input.issueKey}:${input.status}:${input.changelogId}`);
}

/** The comment path claims once per ticket. `replan` clears it first. */
export function commentClaimKey(issueKey: string): KvKey {
  return kvKey(`plan-claimed/${issueKey}`);
}

export function outcomeKey(sessionId: string): KvKey {
  return kvKey(`plan-outcome/${sessionId}`);
}

/** One report per move into Triaged: a redelivery carries the same changelog id. */
export function skipClaimKey(input: { issueKey: string; changelogId: string }): KvKey {
  return kvKey(`plan-skip/${input.issueKey}:${input.changelogId}`);
}

/** One marker per turn: a follow-up or a redelivered webhook that resumes the session is a new start with its own time. */
export function startedClaimKey(input: { sessionId: string; turnId?: string }): KvKey {
  return kvKey(`plan-started/${input.sessionId}${input.turnId === undefined ? "" : `:${input.turnId}`}`);
}

export function searchBudgetKey(sessionId: string): KvKey {
  return kvKey(`search-budget/${sessionId}`);
}

/** The refuse-once record for a session's digest; reset on each turn start (hooks/plan-outcome.ts), like the search budget. */
export function digestRefusedKey(sessionId: string): KvKey {
  return kvKey(`plan-digest-refused/${sessionId}`);
}

const DAYS = 7;

export const KEY_REGISTRY: readonly KeyEntry[] = [
  { prefix: "plan/", builder: "planClaimKey", identity: ["issueKey", "Triaged status name", "changelogId"], owner: "lib/start-plan.ts", readers: ["lib/start-plan.ts", "channels/webhook.ts"], lifecycle: "keep", concurrency: "claim", pii: false, note: "`started` with the session id once the plan run is sent." },
  { prefix: "plan-claimed/", builder: "commentClaimKey", identity: ["issueKey"], owner: "lib/start-plan.ts", readers: ["lib/start-plan.ts", "channels/webhook.ts"], lifecycle: "keep", concurrency: "claim", pii: false, note: "The legacy comment path; `replan` clears it first." },
  { prefix: "plan-outcome/", builder: "outcomeKey", identity: ["sessionId"], owner: "tools/record_plan.ts", readers: ["hooks/plan-outcome.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "plan-skip/", builder: "skipClaimKey", identity: ["issueKey", "changelogId"], owner: "lib/plan-outcome.ts", readers: ["lib/plan-outcome.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false },
  { prefix: "plan-started/", builder: "startedClaimKey", identity: ["sessionId", "turnId?"], owner: "lib/planning-started.ts", readers: ["lib/planning-started.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false },
  { prefix: "search-budget/", builder: "searchBudgetKey", identity: ["sessionId"], owner: "lib/search-budget.ts", readers: ["lib/search-budget.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Reset at every turn start." },
  { prefix: "plan-digest-refused/", builder: "digestRefusedKey", identity: ["sessionId"], owner: "tools/record_plan.ts", readers: ["tools/record_plan.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Deleted at every turn start." },
  { prefix: "v1/ops-alert/", builder: "opsAlertKey", identity: ["hash16 of (slug, site, reason)", "UTC hour"], owner: "lib/ops-funnel.ts", readers: ["lib/ops-funnel.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false, note: "One ops Slack line per signature per hour; read then put, no CAS." },
];

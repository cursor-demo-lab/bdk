// Every host.kv key pr-autofixer reads or writes is built here, and every
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
import type { GithubPrRef } from "./drive.js";

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
export const factorySlug = "factory-pr-autofixer";

/** The ops funnel's hourly dedupe marker, `v1/ops-alert/<hash16>/<UTC hour>`, and its host.files path when kv fails (lib/ops-funnel.ts). */
export function opsAlertKey(input: { hash: string; hour: string }): KvKey {
  return kvKey(`v1/ops-alert/${input.hash}/${input.hour}`);
}

// Pull request keys keep the owner and repo as the event or link spelled
// them; none is lowercased.

export function autoDriveKey(pr: GithubPrRef): KvKey {
  return kvKey(`auto-drive:${pr.owner}/${pr.repo}#${pr.number}`);
}

export function driveSessionKey(sessionId: string): KvKey {
  return kvKey(`drive-session/${sessionId}`);
}

export function bugbotRoundsKey(pr: GithubPrRef): KvKey {
  return kvKey(`bugbot-rounds:${pr.owner}/${pr.repo}#${pr.number}`);
}

export function affinityKey(pr: GithubPrRef): KvKey {
  return kvKey(`affinity/${pr.label}`);
}

/** The first key in K12's grammar for new keys, `v1/<entity>/<parts>`; owner and repo as sent. */
export function prGenerationKey(pr: GithubPrRef): KvKey {
  return kvKey(`v1/pr-generation/${pr.owner}/${pr.repo}/${pr.number}`);
}

/** Failed fresh-Bugbot attempts on one head; an unknown head shares `unknown`. */
export function freshFailuresKey(input: { pr: GithubPrRef; headSha: string | undefined }): KvKey {
  return kvKey(`bugbot-fresh-failures:${input.pr.label}:${input.headSha?.toLowerCase() ?? "unknown"}`);
}

export const WEBHOOK_BUFFER_KV_KEY = kvKey("webhook-buffer");

const DAYS = 7;
const PR = ["owner (as sent)", "repo (as sent)", "prNumber"];

export const KEY_REGISTRY: readonly KeyEntry[] = [
  { prefix: "auto-drive:", builder: "autoDriveKey", identity: PR, owner: "lib/auto-drive.ts", readers: ["lib/auto-drive.ts", "lib/close-cleanup.ts", "channels/github.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "lease", pii: false, note: "The drive claim, settled for FACTORY_FIXER_CLAIM_SETTLE_MS (2 s; 0 turns the settle off) after its write; deleted on close or a failed drive, else lapses with its 2 h lease." },
  { prefix: "drive-session/", builder: "driveSessionKey", identity: ["sessionId"], owner: "lib/auto-drive.ts", readers: ["lib/auto-drive.ts", "lib/close-cleanup.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "verified", pii: false, note: "Deleted when a drive turn ends or fails and releases its claim, and on close once the claim is gone (deleted or absent), when the claim named this session and the record still names the PR and the claim's token (lib/close-cleanup.ts)." },
  { prefix: "bugbot-rounds:", builder: "bugbotRoundsKey", identity: PR, owner: "lib/auto-drive.ts", readers: ["lib/auto-drive.ts", "lib/close-cleanup.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "verified", pii: false, note: "Rounds and the cap note are verified merges (FACTORY_FIXER_ROUNDS_MERGE=off: plain put). The first peek writes the empty record { shas: [], rounds: 0 }, and a round is only added to a record that exists, so a record landing after a close is skipped. Deleted on close, so a reopened PR starts at round 0 (owner decision on plan K8 open question 1; FACTORY_FIXER_CLOSE_CLEANUP=off keeps it)." },
  { prefix: "affinity/", builder: "affinityKey", identity: ["PR label (owner/repo#number as sent)"], owner: "lib/affinity.ts", readers: ["lib/affinity.ts", "lib/close-cleanup.ts", "channels/github.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Deleted on close (lib/close-cleanup.ts), with the continuation generation bumped (v1/pr-generation/) unless the PR merged, so a reopened PR's wakes and drive-channel sends reach no pre-close agent or session. The bind hooks write it only while GitHub does not say the PR is closed or merged, and not for a pr: session on an older generation (lib/affinity.ts recordPrAgentWhileOpen), so a late bind cannot undo the close; FACTORY_FIXER_CLOSE_CLEANUP=off keeps it." },
  { prefix: "v1/pr-generation/", builder: "prGenerationKey", identity: PR, owner: "lib/pr-generation.ts", readers: ["lib/pr-generation.ts", "lib/start-drive.ts", "lib/affinity.ts", "lib/close-cleanup.ts", "channels/github.ts"], lifecycle: "keep", concurrency: "verified", pii: false, note: "How many times the PR closed ({ n }); bumped on a close that is not a merge, so the drive channel's and buffered wakes' continuation key (pr:<label>@g<n>) names new sessions after a reopen. Kept: back at 0 it would resume the pre-close sessions. A merged PR cannot reopen, so merges add nothing; growth is one small record per PR ever closed unmerged." },
  { prefix: "bugbot-fresh-failures:", builder: "freshFailuresKey", identity: ["PR label (owner/repo#number as sent)", "headSha (lowercased) or 'unknown'"], owner: "channels/github.ts", readers: ["channels/github.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Carries a 1 h `exp`; left on close, since nothing records which heads have one." },
  { prefix: "webhook-buffer", builder: "WEBHOOK_BUFFER_KV_KEY", identity: [], owner: "lib/webhook-buffer.ts", readers: ["lib/webhook-buffer.ts"], lifecycle: "keep", concurrency: "blind", pii: false, note: "One snapshot of every buffered PR, rewritten whole on each persist." },
  { prefix: "v1/ops-alert/", builder: "opsAlertKey", identity: ["hash16 of (slug, site, reason)", "UTC hour"], owner: "lib/ops-funnel.ts", readers: ["lib/ops-funnel.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false, note: "One ops Slack line per signature per hour; read then put, no CAS." },
];

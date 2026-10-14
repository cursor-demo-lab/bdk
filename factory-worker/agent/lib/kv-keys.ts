// Every host.kv key factory-worker reads or writes is built here, and every
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
import type { PrStage } from "./pr-decide.js";

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
export const factorySlug = "factory-worker";

/** The ops funnel's hourly dedupe marker, `v1/ops-alert/<hash16>/<UTC hour>`, and its host.files path when kv fails (lib/ops-funnel.ts). */
export function opsAlertKey(input: { hash: string; hour: string }): KvKey {
  return kvKey(`v1/ops-alert/${input.hash}/${input.hour}`);
}

type PrRef = { repository: string; number: number };

/** Also the Agent.create idempotency key (handle.ts), so it names one launch per ticket outside kv too. */
export function implementClaimKey(issueKey: string): KvKey {
  return kvKey(`implement/${issueKey}`);
}

export function launchFailureNoticeKey(input: { issueKey: string; changelogId: string }): KvKey {
  return kvKey(`implement-failed/${input.issueKey}/${input.changelogId}`);
}

/**
 * The cloud agent July bound to a ticket's implement session, written by the
 * session's `agent.bound` handler before the claim is touched (claim.ts
 * `noteBoundAgent`), so a takeover can adopt it when the claim record failed.
 */
export function implementAgentKey(issueKey: string): KvKey {
  return kvKey(`implement-agent/${issueKey}`);
}

/** `pr` is `<repository>#<number>` as GitHub sent it, not lowercased. */
export function prStatusClaimKey(input: { issueKey: string; stage: PrStage; pr: string }): KvKey {
  return kvKey(`pr-status/${input.issueKey}/${input.stage}/${input.pr}`);
}

/** Written with the ticket's first count on apj_factory.ticket.merged (lib/pr-status.ts), so a later move into Done does not count it again. */
export function ticketMergedKey(issueKey: string): KvKey {
  return kvKey(`ticket-merged/${issueKey}`);
}

/** One note per stage, pull request, and skipped outcome; `current` is the status a skipped move read. */
export function prStatusNoteKey(input: { issueKey: string; stage: PrStage; pr: string; outcome: string; current?: string }): KvKey {
  return kvKey(`pr-status-note/${input.issueKey}/${input.stage}/${input.pr}/${input.outcome}:${input.current ?? ""}`);
}

export function readyRecordKey(target: PrRef): KvKey {
  return kvKey(`pr-ready/${target.repository.toLowerCase()}#${target.number}`);
}

export function readyNoteKey(target: PrRef): KvKey {
  return kvKey(`pr-ready-note/${target.repository.toLowerCase()}#${target.number}`);
}

export function implementPrWatchKey(issueKey: string): KvKey {
  return kvKey(`implement-pr-watch/${issueKey}`);
}

export const IMPLEMENT_PR_INDEX = kvKey("implement-pr-watch/index");
export const IMPLEMENT_PR_SWEEP_KEY = kvKey("implement-pr-watch/last-sweep");

/** An approval the worker still owes a recorded launch for (lib/launch-watch.ts). */
export function launchWatchKey(issueKey: string): KvKey {
  return kvKey(`implement-launch/${issueKey}`);
}

export const LAUNCH_WATCH_INDEX = kvKey("implement-launch/index");

/** One trace comment per ticket, approval, and kind of skipped launch. */
export function launchNoteKey(input: { issueKey: string; changelogId: string; kind: string }): KvKey {
  return kvKey(`implement-note/${input.issueKey}/${input.changelogId}/${input.kind}`);
}

const DAYS = 7;

export const KEY_REGISTRY: readonly KeyEntry[] = [
  { prefix: "implement/", builder: "implementClaimKey", identity: ["issueKey"], owner: "lib/claim.ts", readers: ["lib/claim.ts", "lib/implement-pr.ts", "lib/handle.ts"], lifecycle: "keep", concurrency: "claim", pii: false, note: "`launched` with the agent id; a reopened ticket reads it to refuse a second launch." },
  { prefix: "implement-failed/", builder: "launchFailureNoticeKey", identity: ["issueKey", "changelogId"], owner: "lib/claim.ts", readers: ["lib/claim.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false },
  { prefix: "implement-agent/", builder: "implementAgentKey", identity: ["issueKey"], owner: "lib/claim.ts", readers: ["lib/claim.ts", "lib/handle.ts"], lifecycle: "keep", concurrency: "blind", pii: false, note: "The cloud agent July bound to the ticket's implement session, written before the claim (a takeover's own binding: after it, so a late record of the launch it replaced is seen first); a takeover adopts it (after reading its status), a failed turn reads its status; deleted when that launch fails or the agent is retired." },
  { prefix: "pr-status/", builder: "prStatusClaimKey", identity: ["issueKey", "stage", "repository (as sent) # prNumber"], owner: "lib/pr-status.ts", readers: ["lib/pr-status.ts"], lifecycle: "keep", concurrency: "claim", pii: false, note: "`moved` once the ticket moved for this PR." },
  { prefix: "ticket-merged/", builder: "ticketMergedKey", identity: ["issueKey"], owner: "lib/pr-status.ts", readers: ["lib/pr-status.ts"], lifecycle: "keep", concurrency: "claim", pii: false, note: "`at` of the ticket's first move into Done; read then put, no CAS, so a race may count a ticket twice." },
  { prefix: "pr-status-note/", builder: "prStatusNoteKey", identity: ["issueKey", "stage", "repository (as sent) # prNumber", "outcome", "current status or ''"], owner: "lib/pr-status.ts", readers: ["lib/pr-status.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false },
  { prefix: "pr-ready/", builder: "readyRecordKey", identity: ["repository (lowercased)", "prNumber"], owner: "lib/pr-ready.ts", readers: ["lib/pr-ready.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "pr-ready-note/", builder: "readyNoteKey", identity: ["repository (lowercased)", "prNumber"], owner: "lib/pr-ready.ts", readers: ["lib/pr-ready.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false },
  { prefix: "implement-pr-watch/", builder: "implementPrWatchKey", identity: ["issueKey"], owner: "lib/implement-pr.ts", readers: ["lib/implement-pr.ts", "lib/implement-pr-sweep.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Deleted once the implement PR is found or the watch gives up." },
  { prefix: "implement-pr-watch/index", builder: "IMPLEMENT_PR_INDEX", identity: [], owner: "lib/implement-pr.ts", readers: ["lib/implement-pr.ts", "lib/implement-pr-sweep.ts"], lifecycle: "keep", concurrency: "index", pii: false, note: "Issue keys with a live watch; an issue key cannot be `index`." },
  { prefix: "implement-pr-watch/last-sweep", builder: "IMPLEMENT_PR_SWEEP_KEY", identity: [], owner: "lib/implement-pr-sweep.ts", readers: ["lib/implement-pr-sweep.ts"], lifecycle: "keep", concurrency: "blind", pii: false },
  { prefix: "implement-launch/", builder: "launchWatchKey", identity: ["issueKey"], owner: "lib/launch-watch.ts", readers: ["lib/launch-watch.ts", "lib/launch-heal.ts", "lib/handle.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Deleted once the launch is recorded, or a failure, a missing plan, or a ticket that left Approved is." },
  { prefix: "implement-launch/index", builder: "LAUNCH_WATCH_INDEX", identity: [], owner: "lib/launch-watch.ts", readers: ["lib/launch-watch.ts", "lib/launch-heal.ts"], lifecycle: "keep", concurrency: "index", pii: false, note: "Issue keys with a launch watch; an issue key cannot be `index`." },
  { prefix: "implement-note/", builder: "launchNoteKey", identity: ["issueKey", "changelogId", "kind"], owner: "lib/handle.ts", readers: ["lib/handle.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false },
  { prefix: "v1/ops-alert/", builder: "opsAlertKey", identity: ["hash16 of (slug, site, reason)", "UTC hour"], owner: "lib/ops-funnel.ts", readers: ["lib/ops-funnel.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false, note: "One ops Slack line per signature per hour; read then put, no CAS." },
];

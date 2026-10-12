import type { HostKvCasApi, JsonValue, KvCasResult, KvVersionedEntry } from "@cursor/july";
import { deleteVerified, readRetrying, updateVerified, VERIFY_ATTEMPTS, type RetryOptions, type VerifiedResult } from "./kv-verified.js";
import type { KeyedKv, KvKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

// A claim that dedupes a side effect (a Slack post, a launch, a drive start)
// across deliveries, on the verified writes of kv-verified.ts.
//
// 1. The claim is written `{ state: "pending", owner, at }` before the side
//    effect and moved to done (`state: "done"`, or a site's own final
//    record) only after it succeeds.
// 2. A pending claim older than the site's lease is abandoned: the next
//    delivery takes it over. Each site fixes its lease as a constant, longer
//    than its side effect can take.
// 3. Done is final. Anything stored that is not a pending claim counts as
//    done, so a site's own final record (a thread binding) ends the claim.
// 4. A failed side effect or an unverifiable write releases the claim (only
//    while it is still this owner's) or leaves it pending to expire; no
//    outcome leaves a claim that blocks forever.
//
// The side effect is at-least-once, not exactly-once: a delivery that
// performs it and then cannot mark the claim done leaves it pending, and a
// redelivery after the lease performs it again. A rare duplicate Slack post
// is accepted over a silent drop.
//
// Concurrent takers. A kv with compare-and-set (HostKvCasApi) takes and
// finishes with putIfAbsent / putIfVersion, so one taker wins outright.
// ctx.host.kv has no CAS on any July backend (docs/bugs.md ask 11), and
// read, put, read back only catches a rival whose put lands before the
// read-back: two takers that both read the key absent, where one verifies
// before the other's put lands, both come back taken. `settleMs` closes
// that window as far as get/put allow: after the read-back, wait
// `settleMs` and read again, and hold the claim only if it is still this
// owner's. A rival that read the key before this put landed has put by
// then (its read-to-put gap is one kv round trip), so every such taker
// but the last writer yields. The residual is a rival whose put takes
// longer than `settleMs` to land.
//
// Shared verbatim by the factory agents that keep claims in host.kv; its
// test is factory-desk's claim-lease.test.ts (scripts/copies-parity.test.mjs).

export type LeaseState = { owner: string; at: string };

export type TakeResult =
  | { status: "taken"; at: string }
  | { status: "held"; owner: string; at: string }
  | { status: "done"; current: JsonValue }
  | { status: "unavailable" };

export type FinishResult = { status: "finished" } | { status: "lost"; current: JsonValue | undefined } | { status: "unavailable" };

export type ReleaseResult = { status: "released" } | { status: "lost"; current: JsonValue | undefined } | { status: "unavailable" };

type Fields = Record<string, JsonValue>;

/** The owner and time of a pending claim, or undefined for anything else. */
export function pendingLease(value: unknown): LeaseState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["state"] !== "pending" || typeof record["owner"] !== "string" || typeof record["at"] !== "string") return undefined;
  return { owner: record["owner"], at: record["at"] };
}

/**
 * Past its lease, or with a time that cannot be trusted (unparseable, or
 * further ahead than one lease, so clock skew cannot pin a claim).
 */
export function leaseExpired(lease: LeaseState, leaseMs: number, now: Date): boolean {
  const age = now.getTime() - Date.parse(lease.at);
  return !Number.isFinite(age) || age >= leaseMs || age < -leaseMs;
}

/**
 * Take `key` for `owner` when it is absent, an expired pending claim, or
 * already this owner's pending claim. `fields` ride on the pending record.
 * `unavailable` means the claim may or may not have landed: the caller
 * releases it or leaves it to expire, and never performs the side effect.
 * `settleMs` re-reads the claim that long after it was written (see the
 * top of this file); a kv with compare-and-set never waits. `pausesMs`
 * retries an unavailable take from a fresh read after each pause, and then
 * owns the pauses: kv-verified's own retries run without theirs unless
 * `retry` says otherwise.
 */
export async function takeLease(
  kv: KeyedKv,
  key: KvKey,
  options: { owner: string; leaseMs: number; now: Date; fields?: Fields; pausesMs?: readonly number[]; settleMs?: number; retry?: RetryOptions }
): Promise<TakeResult> {
  const at = options.now.toISOString();
  const mine: JsonValue = { ...options.fields, state: "pending", owner: options.owner, at };
  const result = await settle(
    kv,
    key,
    (current) => {
      if (current === undefined) return mine;
      const held = pendingLease(current);
      if (held === undefined) return undefined;
      return held.owner === options.owner || leaseExpired(held, options.leaseMs, options.now) ? mine : undefined;
    },
    { pausesMs: options.pausesMs, retry: options.retry }
  );
  if (result.status === "written") {
    const settleMs = options.settleMs ?? 0;
    return settleMs > 0 && !hasCas(kv) ? confirmTaken(kv, key, { owner: options.owner, at, settleMs, retry: options.retry }) : { status: "taken", at };
  }
  if (result.status === "unavailable" || result.current === undefined) return { status: "unavailable" };
  return heldOrDone(result.current);
}

function heldOrDone(current: JsonValue): TakeResult {
  const held = pendingLease(current);
  return held === undefined ? { status: "done", current } : { status: "held", ...held };
}

// A claim that vanished (a rival took it and released it) or cannot be read
// is unavailable: the caller releases its own claim if it is still there
// and does not perform the side effect.
async function confirmTaken(kv: KeyedKv, key: KvKey, take: { owner: string; at: string; settleMs: number; retry?: RetryOptions }): Promise<TakeResult> {
  const { owner, at, settleMs } = take;
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const read = await readRetrying(kv, key, take.retry);
  if (!read.ok || read.value === undefined) return { status: "unavailable" };
  return pendingLease(read.value)?.owner === owner ? { status: "taken", at } : heldOrDone(read.value);
}

function hasCas(kv: KeyedKv): kv is HostKvCasApi {
  const candidate = kv as Partial<HostKvCasApi>;
  return (
    typeof candidate.getWithVersion === "function" &&
    typeof candidate.putIfAbsent === "function" &&
    typeof candidate.putIfVersion === "function" &&
    typeof candidate.listKeys === "function"
  );
}

/**
 * Mark the claim done once the side effect succeeded, only while `key`
 * still holds this owner's pending claim. The done record is the pending
 * one with `fields` and `state: "done"`, or `value` when the site keeps its
 * own final record there. `pausesMs` and `retry` as for {@link takeLease}.
 */
export async function finishLease(
  kv: KeyedKv,
  key: KvKey,
  owner: string,
  options: { fields?: Fields; value?: JsonValue; pausesMs?: readonly number[]; retry?: RetryOptions } = {}
): Promise<FinishResult> {
  const result = await settle(
    kv,
    key,
    (current) => {
      if (pendingLease(current)?.owner !== owner) return undefined;
      return options.value ?? { ...(current as Fields), ...options.fields, state: "done" };
    },
    { pausesMs: options.pausesMs, retry: options.retry }
  );
  return result.status === "written" ? { status: "finished" } : result;
}

/**
 * Drop the claim after a failed side effect, only while it is this owner's
 * pending claim. A caller that retries the release in its own loop passes
 * `retry: { pausesMs: [] }`, so only its loop pauses.
 */
export async function releaseLease(kv: KeyedKv, key: KvKey, owner: string, options: { retry?: RetryOptions } = {}): Promise<ReleaseResult> {
  const result = await deleteVerified(kv, key, (current) => pendingLease(current)?.owner === owner, options.retry);
  return result.status === "written" ? { status: "released" } : result;
}

type Settled = { status: "written" } | { status: "lost"; current: JsonValue | undefined } | { status: "unavailable" };

// updateVerified reports a put that never stuck (it kept failing, or was
// overwritten on every attempt) as `lost` with no current value; here that
// is `unavailable`, since the key's state is unknown. A refusal is `lost`. `pausesMs` retries `unavailable` from a fresh read after
// each pause, for a write that must outlast a longer kv outage. That loop
// owns the pauses: with any `pausesMs`, updateVerified's own retries run
// back to back unless `retry` is given, so the two never stack.
async function settle(
  kv: KeyedKv,
  key: KvKey,
  decide: (current: JsonValue | undefined) => JsonValue | undefined,
  options: { pausesMs?: readonly number[]; retry?: RetryOptions }
): Promise<Settled> {
  const pausesMs = options.pausesMs ?? [];
  const inner = options.retry ?? (pausesMs.length > 0 ? { pausesMs: [] } : {});
  let result = await once(kv, key, { decide, retry: inner });
  for (const ms of pausesMs) {
    if (result.status !== "unavailable") break;
    await new Promise((resolve) => setTimeout(resolve, ms));
    result = await once(kv, key, { decide, retry: inner });
  }
  return result;
}

async function once(
  kv: KeyedKv,
  key: KvKey,
  step: { decide: (current: JsonValue | undefined) => JsonValue | undefined; retry: RetryOptions }
): Promise<Settled> {
  const { decide } = step;
  if (hasCas(kv)) return onceCas(kv, key, decide);
  let refused = false;
  const result: VerifiedResult = await updateVerified(
    kv,
    key,
    (current) => {
      const next = decide(current);
      refused = next === undefined;
      return next;
    },
    step.retry
  );
  if (result.status === "written") return { status: "written" };
  if (result.status === "lost" && refused) return result;
  return { status: "unavailable" };
}

// A conflict re-reads the key and runs `decide` again on what it holds. A
// read or conditional put that throws (the put may have applied) is
// unavailable.
async function onceCas(kv: HostKvCasApi, key: KvKey, decide: (current: JsonValue | undefined) => JsonValue | undefined): Promise<Settled> {
  try {
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      const entry: KvVersionedEntry | undefined = await kv.getWithVersion(key);
      const next = decide(entry?.value);
      if (next === undefined) return { status: "lost", current: entry?.value };
      const result: KvCasResult = entry === undefined ? await kv.putIfAbsent(key, next) : await kv.putIfVersion(key, next, entry.version);
      if (result.ok) return { status: "written" };
    }
  } catch (error) {
    warnKv("claim-lease.onceCas", error);
    // Unknown whether the put applied.
  }
  return { status: "unavailable" };
}

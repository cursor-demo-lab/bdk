import { randomUUID } from "node:crypto";
import type { JsonValue } from "@cursor/july";
import { deleteVerified, readRetrying, sameJson, updateVerified } from "./kv-verified.js";
import type { KeyedKv, KvKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

// The claim the planner and the worker take before a side effect (a planning
// session, an agent launch, a Jira move), on a kv with get, put and delete
// only. ctx.host.kv has no compare-and-set (docs/bugs.md ask 11), so the
// claim is best effort:
//
// 1. Read the key and run the site's own `classify` on what it holds.
// 2. Write `{ ...pending, owner }` with `updateVerified`: put, read back,
//    and yield to any value that is neither ours nor the one step 1 read.
// 3. After `settleMs`, read again. A rival that read the key before our put
//    landed has put by then, so every such taker but the last writer yields.
// 4. Any value that is not ours goes through the site's `classify`, with
//    `stale` read as `in_flight`: the confirm step never retakes. An
//    ownerless pending (code from before this file) is a young pending,
//    so it is in flight, never done, which is why claim-lease.ts's
//    `confirmTaken` is not used here.
//
// Residual: a put that lands later than `settleMs` after ours, and, while a
// slug deploys, old code (no read-back, no owner) whose put lands after our
// settle re-read or in the one round trip between our pre-read and our put.
// Each can still give two claims; the external guards (Agent.create's
// idempotencyKey, Jira's `transitionFrom`) bound the damage.
//
// `FACTORY_CLAIM_MODE=legacy` keeps each site's plain get-then-put path and
// plain delete, and logs no claim lines; `FACTORY_CLAIM_SETTLE_MS=0` keeps
// the owner and read-back but skips step 3. Both are read per request.
//
// Shared verbatim by the planner and the worker; its test is factory-worker's
// verified-claim.test.ts (scripts/copies-parity.test.mjs).

export const CLAIM_SETTLE_MS = 2_000;
const CLAIM_SETTLE_MAX_MS = 10_000;

export type ClaimMode = "verified" | "legacy";

export type Sleep = (ms: number) => Promise<void>;

export type ClaimHost = "planner" | "worker";

/** One delivery's claim settings: a fresh owner, and the env as it was when the request arrived. */
export type ClaimRun = { host: ClaimHost; mode: ClaimMode; owner: string; settleMs: number; sleep: Sleep; log: (line: string) => void };

/**
 * How long a claim waits before it re-reads itself: longer than one hosted
 * kv put takes to land. `FACTORY_CLAIM_SETTLE_MS` overrides it (0 turns the
 * wait off); anything unparseable or above ten seconds keeps the default.
 */
export function claimSettleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.FACTORY_CLAIM_SETTLE_MS?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return CLAIM_SETTLE_MS;
  const ms = Number(raw);
  return ms <= CLAIM_SETTLE_MAX_MS ? ms : CLAIM_SETTLE_MS;
}

/** `FACTORY_CLAIM_MODE=legacy` restores the plain get-then-put claim; anything else is the verified claim. */
export function claimMode(env: NodeJS.ProcessEnv): ClaimMode {
  return env.FACTORY_CLAIM_MODE?.trim().toLowerCase() === "legacy" ? "legacy" : "verified";
}

export function claimRun(env: NodeJS.ProcessEnv, options: { host: ClaimHost; owner?: string; sleep?: Sleep; log?: (line: string) => void }): ClaimRun {
  return {
    host: options.host,
    mode: claimMode(env),
    owner: options.owner ?? randomUUID(),
    settleMs: claimSettleMs(env),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    log: options.log ?? ((line) => console.log(line)),
  };
}

/** True when `value` is a record stamped with this `owner`. */
export function ownedBy(value: unknown, owner: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>)["owner"] === owner;
}

type Stale = { status: "stale" };
type Held = { status: "in_flight" } | { status: "unavailable" };

export type VerifiedTake<Lost> = { status: "claimed"; retried: boolean } | Lost | Held;

/**
 * Steps 1 to 4 above. `classify` is the site's own reading of a stored
 * value: `stale` lets step 2 take the key over, anything else is returned.
 * `unavailable` means this owner's claim may or may not be in the key: the
 * caller releases it with {@link releaseClaim} and performs nothing.
 */
export async function takeVerifiedClaim<Lost extends { status: string }>(
  kv: KeyedKv,
  key: KvKey,
  input: { pending: Record<string, JsonValue>; run: ClaimRun; classify: (value: unknown) => Lost | Stale }
): Promise<VerifiedTake<Lost>> {
  const { run, classify } = input;
  const confirm = (value: unknown): Lost | Held => {
    const lost = classify(value);
    return lost.status === "stale" ? { status: "in_flight" } : (lost as Lost);
  };
  let existing: JsonValue | undefined;
  try {
    existing = await kv.get(key);
  } catch (error) {
    warnKv("verified-claim.takeVerifiedClaim", error);
    return { status: "unavailable" };
  }
  if (existing !== undefined) {
    const lost = classify(existing);
    if (lost.status !== "stale") return lost as Lost;
  }
  const mine: JsonValue = { ...input.pending, owner: run.owner };
  const written = await updateVerified(kv, key, (current) =>
    current === undefined || ownedBy(current, run.owner) || sameJson(current, existing) ? mine : undefined
  );
  if (written.status === "unavailable") return { status: "unavailable" };
  // A put overwritten on every attempt leaves the key's state unknown.
  if (written.status === "lost") return written.current === undefined ? { status: "unavailable" } : confirm(written.current);
  const retried = existing !== undefined;
  if (run.settleMs <= 0) return { status: "claimed", retried };
  await run.sleep(run.settleMs);
  const read = await readRetrying(kv, key);
  if (!read.ok) return { status: "unavailable" };
  return ownedBy(read.value, run.owner) ? { status: "claimed", retried } : confirm(read.value);
}

export type ReleaseOutcome = "released" | "not_owner" | "unavailable";

/**
 * Drop a claim after a failed side effect or an `unavailable` take. The
 * verified mode deletes only while the key still holds this owner's value,
 * so a rival's claim is never removed on this path; legacy is a plain delete.
 * Never throws: a claim left behind goes stale after the site's window.
 */
export async function releaseClaim(kv: KeyedKv, key: KvKey, run: ClaimRun): Promise<ReleaseOutcome> {
  let outcome: ReleaseOutcome;
  if (run.mode === "legacy") {
    try {
      await kv.delete(key);
      outcome = "released";
    } catch (error) {
      warnKv("verified-claim.releaseClaim", error);
      outcome = "unavailable";
    }
  } else {
    const result = await deleteVerified(kv, key, (current) => ownedBy(current, run.owner));
    outcome = result.status === "written" ? "released" : result.status === "lost" ? "not_owner" : "unavailable";
  }
  logClaim(run, { claim: `release_${outcome}`, key });
  return outcome;
}

/** One JSON line per claim decision: `{ host, claim, key, mode }`. Legacy mode logs nothing, as before this file. */
export function logClaim(run: ClaimRun, fields: { claim: string; key: KvKey; retried?: boolean }): void {
  if (run.mode === "legacy") return;
  run.log(JSON.stringify({ host: run.host, claim: fields.claim, key: fields.key, mode: run.mode, ...(fields.retried ? { retried: true } : {}) }));
}

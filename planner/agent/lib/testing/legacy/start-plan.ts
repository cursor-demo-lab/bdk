import { supportsKvCas, type HostKvApi } from "@cursor/july";

// Frozen: `claimPlan` from agent/lib/start-plan.ts at 268fc79, with the
// helpers it calls. A slug mid-deploy still runs this code, so race tests
// pit it against the live claim in both orders. Never edit it to follow the
// live file; delete it once no deployed slug can run it.

export const STALE_PENDING_MS = 10 * 60_000;

export type PendingPlanClaim = { state: "pending"; at: string; deliveryId?: string };

export type StartedPlanClaim = { state: "started"; at: string; sessionId: string; deliveryId?: string };

export type PlanClaim = PendingPlanClaim | StartedPlanClaim;

export type PlanClaimOutcome =
  | { status: "claimed"; retried: boolean }
  | { status: "started"; claim: StartedPlanClaim }
  | { status: "in_flight" }
  | { status: "unavailable" };

type Lost = Exclude<PlanClaimOutcome, { status: "claimed" }> | { status: "stale" };

export async function claimPlan(kv: HostKvApi, key: string, now: Date, clearFirst = false, deliveryId?: string): Promise<PlanClaimOutcome> {
  const pending: PendingPlanClaim = { state: "pending", at: now.toISOString(), ...(deliveryId === undefined ? {} : { deliveryId }) };
  if (clearFirst) {
    try {
      await kv.delete(key);
    } catch {
      // A failed delete still tries the claim, which then meets the record that remains.
    }
  }
  try {
    if (supportsKvCas(kv)) {
      const first = await kv.putIfAbsent(key, pending);
      if (first.ok) return { status: "claimed", retried: false };
      const entry = await kv.getWithVersion(key);
      // Absent or unreadable: the winner has not finished writing it, or released it after a failed send.
      if (entry === undefined) return { status: "in_flight" };
      const lost = classify(entry.value, now, deliveryId);
      if (lost.status !== "stale") return lost;
      const taken = await kv.putIfVersion(key, pending, entry.version);
      return taken.ok ? { status: "claimed", retried: true } : { status: "in_flight" };
    }
    const existing = await kv.get(key);
    if (existing !== undefined) {
      const lost = classify(existing, now, deliveryId);
      if (lost.status !== "stale") return lost;
    }
    await kv.put(key, pending);
    return { status: "claimed", retried: existing !== undefined };
  } catch {
    return { status: "unavailable" };
  }
}

export function parsePlanClaim(value: unknown): PlanClaim | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const at = record["at"];
  if (typeof at !== "string") return undefined;
  const delivery = typeof record["deliveryId"] === "string" && record["deliveryId"] !== "" ? { deliveryId: record["deliveryId"] } : {};
  if (record["state"] === "pending") return { state: "pending", at, ...delivery };
  const sessionId = record["sessionId"];
  if (record["state"] !== "started" || typeof sessionId !== "string" || sessionId === "") return undefined;
  return { state: "started", at, sessionId, ...delivery };
}

function classify(value: unknown, now: Date, deliveryId: string | undefined): Lost {
  const claim = parsePlanClaim(value);
  // This delivery's own claim, met again on a replayed admission: its earlier send never became a session here.
  if (deliveryId !== undefined && claim?.deliveryId === deliveryId) return { status: "stale" };
  if (claim?.state === "started") return { status: "started", claim };
  if (claim?.state === "pending" && now.getTime() - Date.parse(claim.at) > STALE_PENDING_MS) return { status: "stale" };
  return { status: "in_flight" };
}

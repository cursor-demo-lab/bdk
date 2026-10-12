import { supportsKvCas, type HostKvApi } from "@cursor/july";

// Frozen: `claimImplementation` and `claimStatusMove` from agent/lib/claim.ts
// at 268fc79, with the helpers they call (`implementClaimKey` from
// decide.ts inlined). A slug mid-deploy still runs this code, so race tests
// pit it against the live claims in both orders. Never edit it to follow the
// live file; delete it once no deployed slug can run it.

export const STALE_PENDING_MS = 10 * 60_000;

export type PendingClaim = { state: "pending"; at: string };

export type LaunchedClaim = { state: "launched"; at: string; agentId: string; url: string; commented: boolean; moved: boolean };

export type ImplementationClaim = PendingClaim | LaunchedClaim;

export type ClaimOutcome =
  | { status: "claimed"; retried: boolean }
  | { status: "launched"; claim: LaunchedClaim }
  | { status: "in_flight" }
  | { status: "unavailable" };

type Lost = Exclude<ClaimOutcome, { status: "claimed" }> | { status: "stale" };

export function implementClaimKey(issueKey: string): string {
  return `implement/${issueKey}`;
}

export async function claimImplementation(kv: HostKvApi, issueKey: string, now: Date): Promise<ClaimOutcome> {
  const key = implementClaimKey(issueKey);
  const pending: PendingClaim = { state: "pending", at: now.toISOString() };
  try {
    if (supportsKvCas(kv)) {
      const first = await kv.putIfAbsent(key, pending);
      if (first.ok) return { status: "claimed", retried: false };
      const entry = await kv.getWithVersion(key);
      // Absent or unreadable: the winner has not finished writing it, or released it after a failed launch.
      if (entry === undefined) return { status: "in_flight" };
      const lost = classify(entry.value, now);
      if (lost.status !== "stale") return lost;
      // Retrying is safe: Agent.create carries idempotencyKey implement/<KEY>, so a retry returns the same agent.
      const taken = await kv.putIfVersion(key, pending, entry.version);
      return taken.ok ? { status: "claimed", retried: true } : { status: "in_flight" };
    }
    const existing = await kv.get(key);
    if (existing !== undefined) {
      const lost = classify(existing, now);
      if (lost.status !== "stale") return lost;
    }
    await kv.put(key, pending);
    return { status: "claimed", retried: existing !== undefined };
  } catch {
    return { status: "unavailable" };
  }
}

export type StatusMoveClaim = { state: "pending"; at: string } | { state: "moved"; at: string; outcome: string };

export type StatusMoveOutcome = { status: "claimed" } | { status: "moved"; claim: { at: string; outcome: string } } | { status: "in_flight" } | { status: "unavailable" };

export async function claimStatusMove(kv: HostKvApi, key: string, now: Date): Promise<StatusMoveOutcome> {
  const pending: StatusMoveClaim = { state: "pending", at: now.toISOString() };
  try {
    if (supportsKvCas(kv)) {
      const first = await kv.putIfAbsent(key, pending);
      if (first.ok) return { status: "claimed" };
      const entry = await kv.getWithVersion(key);
      if (entry === undefined) return { status: "in_flight" };
      const lost = classifyStatusMove(entry.value, now);
      if (lost.status !== "stale") return lost;
      const taken = await kv.putIfVersion(key, pending, entry.version);
      return taken.ok ? { status: "claimed" } : { status: "in_flight" };
    }
    const existing = await kv.get(key);
    if (existing !== undefined) {
      const lost = classifyStatusMove(existing, now);
      if (lost.status !== "stale") return lost;
    }
    await kv.put(key, pending);
    return { status: "claimed" };
  } catch {
    return { status: "unavailable" };
  }
}

function classifyStatusMove(value: unknown, now: Date): Exclude<StatusMoveOutcome, { status: "claimed" }> | { status: "stale" } {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const at = typeof record["at"] === "string" ? record["at"] : "";
    if (record["state"] === "moved") return { status: "moved", claim: { at, outcome: typeof record["outcome"] === "string" ? record["outcome"] : "" } };
    if (record["state"] === "pending" && now.getTime() - Date.parse(at) > STALE_PENDING_MS) return { status: "stale" };
  }
  return { status: "in_flight" };
}

export function parseClaim(value: unknown): ImplementationClaim | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const at = record["at"];
  if (typeof at !== "string") return undefined;
  if (record["state"] === "pending") return { state: "pending", at };
  const agentId = record["agentId"];
  const url = record["url"];
  if (record["state"] !== "launched" || typeof agentId !== "string" || typeof url !== "string" || url === "") return undefined;
  return { state: "launched", at, agentId, url, commented: record["commented"] === true, moved: record["moved"] === true };
}

function classify(value: unknown, now: Date): Lost {
  const claim = parseClaim(value);
  if (claim?.state === "launched") return { status: "launched", claim };
  if (claim?.state === "pending" && now.getTime() - Date.parse(claim.at) > STALE_PENDING_MS) return { status: "stale" };
  return { status: "in_flight" };
}

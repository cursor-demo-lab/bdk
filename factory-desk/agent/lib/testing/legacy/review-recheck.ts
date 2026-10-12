import type { HostKvApi } from "@cursor/july";

// Frozen: `takeRecheck` from agent/lib/review-announce.ts at 268fc79. `deps`
// and `result` are narrowed to the fields it reads. A slug mid-deploy still
// runs this code, so race tests pit it against the live lease in both
// orders. Never edit it to follow the live file; delete it once no deployed
// slug can run it.

const RECHECK_GRACE_MS = 60_000;

/** False while another re-check loop for this head is inside its window; an unreadable store lets this one run. */
export async function takeRecheck(deps: { kv: HostKvApi; now: () => Date }, input: { repository: string; number: number }, result: { headSha?: string }, schedule: readonly number[]): Promise<boolean> {
  if (result.headSha === undefined) return true;
  const key = `review-recheck/${input.repository.toLowerCase()}#${input.number}/${result.headSha.toLowerCase()}`;
  const now = deps.now().getTime();
  try {
    const held = await deps.kv.get(key);
    const until = held !== null && typeof held === "object" && !Array.isArray(held) ? Date.parse(String((held as Record<string, unknown>)["until"])) : Number.NaN;
    if (Number.isFinite(until) && until > now) return false;
    await deps.kv.put(key, { until: new Date(now + schedule.reduce((sum, ms) => sum + ms, 0) + RECHECK_GRACE_MS).toISOString() });
  } catch {
    // Two loops at worst; the claims keep them from posting twice.
  }
  return true;
}

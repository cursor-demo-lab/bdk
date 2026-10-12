import { supportsKvCas } from "@cursor/july";
import { continuationFor, planPrompt, type PlanRequest } from "./chain.js";
import type { KeyedKv, KvKey } from "./kv-keys.js";
import { claimRun, logClaim, releaseClaim, takeVerifiedClaim, type ClaimRun, type Sleep } from "./verified-claim.js";
import { warnKv } from "./ops-funnel.js";
import { planSessionCloud } from "./checkout.js";
import type { SendMessageOptions } from "@cursor/july/channels";

// The webhook's claim and dispatch. A claim is `pending` from before `send`
// until `send` returns, then `started` with the session id. The claim is the
// only guard: continuationToken + coalesce does not serialize custom HTTP
// deliveries on v2 (ADR 0003), and a planning session has no idempotency key
// behind it. Hosted `host.kv` has get, put, and delete only (July 0.2.13),
// so the claim is verified-claim.ts's: read, put `{ ...pending, owner }`,
// read back, wait `FACTORY_CLAIM_SETTLE_MS`, read again, and hold the claim
// only while it is still this owner's. Two concurrent deliveries now send
// once unless one put lands later than the settle; there is still no
// cross-session atomicity. `FACTORY_CLAIM_MODE=legacy` restores the plain
// get-then-put. The compare-and-set branch in `claimPlan` runs only against
// a kv that has those methods, which today is a test fake.
//
// Hosted, this handler runs at admission: `send` is only captured, and the
// control plane creates the session after the delivery is acknowledged. When
// it has to admit the same delivery again (the pod that held the capture was
// replaced, or the handoff expired) it replays this request with the same
// `x-agent-sdk-delivery-id`. The claim records that id, so the replay sends
// again instead of meeting its own claim and being skipped with no session.

/** A pending claim older than this belongs to a process that died before `send` returned. */
export const STALE_PENDING_MS = 10 * 60_000;

/** The header hosted admission sets on a replayed request, the same on every attempt of one delivery. */
export const DELIVERY_ID_HEADER = "x-agent-sdk-delivery-id";

/** `owner` rides on the stored value only; `parsePlanClaim` and old code ignore it. */
export type PendingPlanClaim = { state: "pending"; at: string; deliveryId?: string };

export type StartedPlanClaim = { state: "started"; at: string; sessionId: string; deliveryId?: string };

export type PlanClaim = PendingPlanClaim | StartedPlanClaim;

export type PlanClaimOutcome =
  | { status: "claimed"; retried: boolean }
  | { status: "started"; claim: StartedPlanClaim }
  | { status: "in_flight" }
  | { status: "unavailable" };

type Lost = Exclude<PlanClaimOutcome, { status: "claimed" }> | { status: "stale" };

export type Send = (
  message: string,
  options: { continuationToken: string; admission: "coalesce"; title: string } & Pick<SendMessageOptions, "cloud">
) => Promise<{ id: string }>;

export type StartPlanInput = {
  kv: KeyedKv;
  key: KvKey;
  /** The comment path's replan drops the ticket's claim before claiming again. */
  clearFirst: boolean;
  request: PlanRequest;
  replan: boolean;
  /** The changelog or comment id. A redelivery carries the same one and reuses its continuation. */
  attempt: string;
  send: Send;
  via: "status" | "comment";
  now: () => Date;
  /** `DELIVERY_ID_HEADER` when hosted admission replayed the request. */
  deliveryId?: string;
  /** Read per request for `FACTORY_CLAIM_MODE` and `FACTORY_CLAIM_SETTLE_MS`. */
  env: NodeJS.ProcessEnv;
  /** The claim's settle wait; a timer when unset. */
  sleep?: Sleep;
  /** The claim's JSON lines; console.log when unset. */
  log?: (line: string) => void;
};

export async function startPlan(input: StartPlanInput): Promise<Response> {
  const { kv, key, request, via } = input;
  const issueKey = request.issueKey;
  const now = input.now();
  const deliveryId = input.deliveryId === undefined || input.deliveryId === "" ? undefined : input.deliveryId;
  const run = claimRun(input.env, {
    host: "planner",
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    ...(input.log === undefined ? {} : { log: input.log }),
  });
  const claim = await claimPlan(kv, key, { now, run, clearFirst: input.clearFirst, ...(deliveryId === undefined ? {} : { deliveryId }) });
  if (claim.status === "unavailable") {
    // The put may have landed. Drop it (only while it is this delivery's) so a retried delivery finds nothing, or a rival's claim.
    if (run.mode === "verified") await releaseClaim(kv, key, run);
    return Response.json({ ok: false, started: false, reason: "claim_unavailable", issueKey, via }, { status: 503 });
  }
  if (claim.status === "in_flight") return Response.json({ ok: true, duplicate: true, issueKey, via, inFlight: true });
  if (claim.status === "started") return Response.json({ ok: true, duplicate: true, issueKey, via });
  let session: { id: string };
  try {
    session = await input.send(planPrompt(request, { replan: input.replan }), {
      continuationToken: continuationFor({ issueKey, attempt: input.attempt }),
      admission: "coalesce",
      title: `${issueKey}: ${request.title}`,
      ...planSessionCloud(input.env),
    });
  } catch (error) {
    await releaseClaim(kv, key, run);
    throw error;
  }
  const sessionId = sessionIdOf(session);
  const started: StartedPlanClaim = {
    state: "started",
    at: now.toISOString(),
    sessionId: sessionId ?? DEFERRED_SESSION_ID,
    ...(deliveryId === undefined ? {} : { deliveryId }),
  };
  try {
    await kv.put(key, started);
  } catch (error) {
    warnKv("start-plan.startPlan", error);
    // The claim stays pending, so a redelivery after STALE_PENDING_MS plans again.
  }
  return Response.json({
    ok: true,
    started: true,
    ...(sessionId === undefined ? {} : { sessionId }),
    issueKey,
    via,
    ...(claim.retried ? { retried: true } : {}),
  });
}

/** Stands in for the id of a session hosted admission has not created yet. `parsePlanClaim` needs a non-empty id. */
export const DEFERRED_SESSION_ID = "deferred";

/**
 * The session's id, or undefined when hosted admission handed back a deferred
 * session, whose members throw until the turn is admitted.
 */
export function sessionIdOf(session: { readonly id: string }): string | undefined {
  try {
    return session.id;
  } catch {
    return undefined;
  }
}

type ClaimPlanOptions = { now: Date; run: ClaimRun; clearFirst?: boolean; deliveryId?: string };

export async function claimPlan(kv: KeyedKv, key: KvKey, options: ClaimPlanOptions): Promise<PlanClaimOutcome> {
  const outcome = await takePlan(kv, key, options);
  logClaim(options.run, { claim: outcome.status, key, retried: outcome.status === "claimed" && outcome.retried });
  return outcome;
}

async function takePlan(kv: KeyedKv, key: KvKey, options: ClaimPlanOptions): Promise<PlanClaimOutcome> {
  const { now, run, deliveryId } = options;
  const pending: PendingPlanClaim = { state: "pending", at: now.toISOString(), ...(deliveryId === undefined ? {} : { deliveryId }) };
  const stored = run.mode === "legacy" ? pending : { ...pending, owner: run.owner };
  const lostTo = (value: unknown) => classify(value, now, deliveryId);
  if (options.clearFirst === true) {
    try {
      await kv.delete(key);
    } catch (error) {
      warnKv("start-plan.takePlan.delete", error);
      // A failed delete still tries the claim, which then meets the record that remains.
    }
  }
  try {
    if (supportsKvCas(kv)) {
      const first = await kv.putIfAbsent(key, stored);
      if (first.ok) return { status: "claimed", retried: false };
      const entry = await kv.getWithVersion(key);
      // Absent or unreadable: the winner has not finished writing it, or released it after a failed send.
      if (entry === undefined) return { status: "in_flight" };
      const lost = lostTo(entry.value);
      if (lost.status !== "stale") return lost;
      const taken = await kv.putIfVersion(key, stored, entry.version);
      return taken.ok ? { status: "claimed", retried: true } : { status: "in_flight" };
    }
    if (run.mode === "verified") return await takeVerifiedClaim(kv, key, { pending, run, classify: lostTo });
    const existing = await kv.get(key);
    if (existing !== undefined) {
      const lost = lostTo(existing);
      if (lost.status !== "stale") return lost;
    }
    await kv.put(key, pending);
    return { status: "claimed", retried: existing !== undefined };
  } catch (error) {
    warnKv("start-plan.takePlan.putIfAbsent", error);
    return { status: "unavailable" };
  }
}

/** A stored claim, or undefined for anything that is not one of the two shapes. */
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

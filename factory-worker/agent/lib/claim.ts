import { supportsKvCas, type JsonValue } from "@cursor/july";
import { implementAgentKey, implementClaimKey, type KeyedKv, type KvKey, launchFailureNoticeKey } from "./kv-keys.js";
import { deleteVerified, sameJson, updateVerified } from "./kv-verified.js";
import { LAUNCH_LATE_WAIT_MS, LAUNCH_TIMEOUT_MS } from "./launch.js";
import { logClaim, ownedBy, releaseClaim, takeVerifiedClaim, type ClaimMode, type ClaimRun, type ReleaseOutcome } from "./verified-claim.js";
import { warnKv } from "./ops-funnel.js";

// One claim per ticket. `pending` is written before the launch and replaced
// by `launched` once the launch returns; a launched claim is never released.
// `commented` and `moved` record whether the Implementing: comment and the
// move to In Progress happened, so a later delivery can repair whichever did
// not. `continuationToken` and `admission: "coalesce"` do not serialize
// custom HTTP deliveries (ADR 0003). Hosted `host.kv` has get, put, and
// delete only (July 0.2.13), so the claim is verified-claim.ts's: read,
// put `{ ...pending, owner }`, read back, wait `FACTORY_CLAIM_SETTLE_MS`,
// read again, and hold the claim only while it is still this owner's. Two
// concurrent approvals now launch once unless one put lands later than the
// settle; Agent.create's idempotencyKey (the claim key) is the guard behind
// that, though how it treats two concurrent creates is unverified. The
// pending claim records the `x-agent-sdk-delivery-id` hosted admission
// replays a request with, so a replay of the same delivery takes its own
// pending claim over instead of meeting it as in flight. The compare-and-set
// branches run only against a kv that has those methods, which today is a
// test fake. `FACTORY_CLAIM_MODE=legacy` restores the plain get-then-put.

/** A pending status-move claim older than this belongs to a process that died before recording its move. */
export const STALE_PENDING_MS = 10 * 60_000;

/**
 * A pending `implement/<KEY>` claim older than this is presumed lost, and any
 * delivery or the launch watch (launch-heal.ts) may take it over. For a live
 * process the claim's settle, the reminder create, and the launch deadline
 * end well inside it, but timers do not run while a hosted pod is parked, so
 * a frozen launch can thaw after the grace. So a takeover never launches on
 * the grace alone: it first looks for an agent already started (an
 * `Implementing:` comment, or `findLaunchedAgent`) and adopts it, and
 * `recordLaunch` refuses a record from a launch that no longer holds the claim.
 */
export const LAUNCH_GRACE_MS = 3 * 60_000;

/**
 * How long hosted admission holds a captured send in process memory before
 * dropping it (July 0.2.18 hosted-delivery.js `registerHostedDeliveryRoute`,
 * `pendingTtlMs`): the platform's
 * start call must run the send within this.
 */
export const HOSTED_PENDING_SEND_TTL_MS = 10 * 60_000;

/**
 * A pending claim whose launch is a July cloud turn (`sentAt` set) is lost
 * only this long after the send: the hold above, then the launch's own
 * deadline and late wait (launch.ts), the time the SDK create inside July's
 * turn may take once the send runs, before the session's `agent.bound`
 * event records the agent (handle.ts). 11.5 minutes. Past that July has
 * dropped the send itself, so a claim still pending then is a lost launch
 * and the heal relaunches it through the SDK, after `existingAgent` looked
 * for the agent the send may have started.
 */
export const LAUNCH_SENT_GRACE_MS = HOSTED_PENDING_SEND_TTL_MS + LAUNCH_TIMEOUT_MS + LAUNCH_LATE_WAIT_MS;

/**
 * `owner` and `deliveryId` ride on the value only; `parseClaim` and old code
 * ignore `owner`. `sentAt`: when the delivery handed the launch to July as a
 * cloud turn (`markLaunchSent`); the record itself comes from the session's
 * `agent.bound` event, so such a claim waits {@link LAUNCH_SENT_GRACE_MS}.
 */
export type PendingClaim = { state: "pending"; at: string; deliveryId?: string; sentAt?: string };

/**
 * `implement-agent/<KEY>`: the cloud agent July bound to the ticket's
 * implement session, written by the `agent.bound` handler before it touches
 * the claim (`noteBoundAgent`; a takeover's binding writes it after the
 * claim instead, so the replaced launch's late record is seen first:
 * handle.ts `bound`), and read by a takeover before any listing
 * (handle.ts `existingAgent`) and by a failed turn before it releases the
 * claim (`turnFailed`). It is the only durable trace of a July-started
 * agent this worker can read: July passes the agent no name and takes no
 * usable seeded id (launch.ts), so `findLaunchedAgent` cannot see it. `at`
 * is the claim the session carried; `boundAt` when the event was handled.
 * Independent of the claim on purpose: a record `recordLaunch` refused or
 * a kv write that failed after it leaves this behind for the heal. It is
 * cleared when the agent it names is finished with: a failed launch
 * releasing the claim (`launchFailed`, only the record of its own agent or
 * approval) and an orphan retire (`orphaned`), so a retry whose binding is
 * lost too does not adopt a dead agent; and `existingAgent` reads the
 * agent's status before adopting in case a clear was missed.
 */
export type BoundAgentRecord = { agentId: string; url: string; changelogId: string; at: string; boundAt: string };

/** Write the bound-agent record. Plain put: one session binds once, and a later approval's binding overwrites it. Never throws. */
export async function noteBoundAgent(kv: KeyedKv, input: { issueKey: string; record: BoundAgentRecord }): Promise<"noted" | "unavailable"> {
  try {
    await kv.put(implementAgentKey(input.issueKey), input.record);
    return "noted";
  } catch (error) {
    warnKv("claim.noteBoundAgent", error);
    return "unavailable";
  }
}

/** The bound-agent record, or undefined when there is none, it is malformed, or kv failed (logged). */
export async function readBoundAgent(kv: KeyedKv, issueKey: string): Promise<BoundAgentRecord | undefined> {
  try {
    return parseBoundAgent(await kv.get(implementAgentKey(issueKey)));
  } catch (error) {
    warnKv("claim.readBoundAgent", error);
    return undefined;
  }
}

/**
 * Which bound-agent record a clear may drop: one naming `agentId`, or one
 * written for the launch of `approval` (its claim's `changelogId` and
 * `at`). Any other record is another launch's agent, possibly alive and
 * the ticket's: a late binding of a replaced launch landing while the
 * takeover's claim is pending, which only that takeover's failure must
 * not erase.
 */
export type BoundAgentOwner = { agentId?: string; approval?: { changelogId: string; at: string } };

function ownsBoundAgent(record: BoundAgentRecord, owner: BoundAgentOwner): boolean {
  if (owner.agentId !== undefined && record.agentId === owner.agentId) return true;
  return owner.approval !== undefined && record.changelogId === owner.approval.changelogId && record.at === owner.approval.at;
}

/**
 * Drop the bound-agent record, only when `owner` matches it
 * (`ownsBoundAgent`); a record another launch wrote is `kept`. Never
 * throws; `unavailable` when kv failed (logged), and a record that then
 * survives is caught by `existingAgent`'s status read.
 */
export async function clearBoundAgent(kv: KeyedKv, input: { issueKey: string; owner: BoundAgentOwner }): Promise<"cleared" | "kept" | "unavailable"> {
  const key = implementAgentKey(input.issueKey);
  try {
    const current = parseBoundAgent(await kv.get(key));
    if (current === undefined) return "cleared";
    if (!ownsBoundAgent(current, input.owner)) return "kept";
    await kv.delete(key);
    return "cleared";
  } catch (error) {
    warnKv("claim.clearBoundAgent", error);
    return "unavailable";
  }
}

export function parseBoundAgent(value: unknown): BoundAgentRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = (field: string): string | undefined => (typeof record[field] === "string" && record[field] !== "" ? (record[field] as string) : undefined);
  const agentId = text("agentId");
  const url = text("url");
  const changelogId = text("changelogId");
  const at = text("at");
  const boundAt = text("boundAt");
  if (agentId === undefined || url === undefined || changelogId === undefined || at === undefined || boundAt === undefined) return undefined;
  return { agentId, url, changelogId, at, boundAt };
}

export type LaunchedClaim = { state: "launched"; at: string; agentId: string; url: string; commented: boolean; moved: boolean };

export type ImplementationClaim = PendingClaim | LaunchedClaim;

/**
 * `unconfirmed`: this delivery wrote its claim, but the confirm read found the
 * key empty (a hosted read that lags the put, or a rival that released). The
 * delivery launches nothing; the launch watch relaunches after the grace.
 */
export type ClaimOutcome =
  | { status: "claimed"; retried: boolean }
  | { status: "launched"; claim: LaunchedClaim }
  | { status: "in_flight" }
  | { status: "unconfirmed" }
  | { status: "unavailable" };

type Lost = Exclude<ClaimOutcome, { status: "claimed" }> | { status: "stale" };

/** `onTakeover` hears the `at` of a pending claim this claim took over: the time a launch that may still have started an agent began. */
export async function claimImplementation(
  kv: KeyedKv,
  issueKey: string,
  options: { now: Date; run: ClaimRun; deliveryId?: string; onTakeover?: (previousAt: string) => void }
): Promise<ClaimOutcome> {
  const key = implementClaimKey(issueKey);
  const { now, run } = options;
  const deliveryId = run.mode === "legacy" || options.deliveryId === "" ? undefined : options.deliveryId;
  const pending: PendingClaim = { state: "pending", at: now.toISOString(), ...(deliveryId === undefined ? {} : { deliveryId }) };
  const outcome = await takeImplementation(kv, key, {
    pending,
    run,
    classify: (value) => {
      const lost = classify(value, { now, deliveryId, mode: run.mode });
      const held = parseClaim(value);
      if (lost.status === "stale" && held?.state === "pending") options.onTakeover?.(held.at);
      return lost;
    },
  });
  logClaim(run, { claim: outcome.status, key, retried: outcome.status === "claimed" && outcome.retried });
  return outcome;
}

async function takeImplementation(kv: KeyedKv, key: KvKey, input: { pending: PendingClaim; run: ClaimRun; classify: (value: unknown) => Lost }): Promise<ClaimOutcome> {
  const { run, classify } = input;
  const pending = run.mode === "legacy" ? input.pending : { ...input.pending, owner: run.owner };
  try {
    if (supportsKvCas(kv)) {
      const first = await kv.putIfAbsent(key, pending);
      if (first.ok) return { status: "claimed", retried: false };
      const entry = await kv.getWithVersion(key);
      // Absent or unreadable: the winner has not finished writing it, or released it after a failed launch.
      if (entry === undefined) return { status: "in_flight" };
      const lost = classify(entry.value);
      if (lost.status !== "stale") return lost;
      // Retrying relies on Agent.create's idempotencyKey implement/<KEY> returning the same agent, which is unverified.
      const taken = await kv.putIfVersion(key, pending, entry.version);
      return taken.ok ? { status: "claimed", retried: true } : { status: "in_flight" };
    }
    if (run.mode === "verified") return await takeVerifiedClaim(kv, key, { pending: input.pending, run, classify });
    const existing = await kv.get(key);
    if (existing !== undefined) {
      const lost = classify(existing);
      if (lost.status !== "stale") return lost;
    }
    await kv.put(key, pending);
    return { status: "claimed", retried: existing !== undefined };
  } catch (error) {
    warnKv("claim.takeImplementation", error);
    return { status: "unavailable" };
  }
}

export async function recordImplementation(kv: KeyedKv, issueKey: string, claim: LaunchedClaim): Promise<void> {
  await kv.put(implementClaimKey(issueKey), claim);
}

/**
 * Delete the ticket's claim only while it is still exactly the pending
 * claim the caller read (`expected`) and past its grace, so a fresh
 * delivery's claim taken since is kept; a launched claim is never touched.
 * Only the launch watch's give-up after an agent check that never answered
 * uses it, so a person's next move to Approved takes a fresh claim and
 * launches. Never throws.
 */
export async function abandonPendingClaim(kv: KeyedKv, input: { issueKey: string; expected: unknown; now: Date; mode: ClaimMode }): Promise<boolean> {
  const result = await deleteVerified(kv, implementClaimKey(input.issueKey), (current) => {
    const claim = parseClaim(current);
    return claim?.state === "pending" && sameJson(current, input.expected) && pendingLost({ claim, now: input.now, mode: input.mode });
  });
  return result.status === "written";
}

export type RecordOutcome = "recorded" | "superseded" | "unavailable";

/**
 * Record a launch only while this launch still holds the claim. The first
 * record (`stage: "launch"`) needs this run's own pending claim (or an empty
 * key, which no rival holds); a later one (`"update"`: commented, moved)
 * needs the launched record for this same agent. Anything else is
 * `superseded`: a takeover owns the ticket now, and a thawed launch must not
 * overwrite it or comment. Legacy mode keeps the frozen blind put. Never throws.
 */
export async function recordLaunch(kv: KeyedKv, input: { issueKey: string; claim: LaunchedClaim; run: ClaimRun; stage: "launch" | "update" }): Promise<RecordOutcome> {
  const key = implementClaimKey(input.issueKey);
  const { claim, run } = input;
  if (run.mode === "legacy") {
    try {
      await kv.put(key, claim);
      return "recorded";
    } catch (error) {
      warnKv("claim.recordLaunch", error);
      return "unavailable";
    }
  }
  const written = await updateVerified(kv, key, (current) => {
    const held = parseClaim(current);
    // Only this launch's own pending claim: an empty key is not recordable, since a give-up that cleared it has already said so on the ticket.
    if (input.stage === "launch") return held?.state === "pending" && ownedBy(current, run.owner) ? claim : undefined;
    return held?.state === "launched" && held.agentId === claim.agentId ? claim : undefined;
  });
  return written.status === "written" ? "recorded" : written.status === "lost" ? "superseded" : "unavailable";
}

export type MarkSentOutcome = "marked" | "lost" | "unavailable";

/**
 * Stamp `sentAt` on this delivery's own pending claim, just before its
 * launch is handed to July as a cloud turn. From then on the claim is lost
 * only after {@link LAUNCH_SENT_GRACE_MS}, and a replay of the same delivery
 * meets it as in flight instead of taking it over (`classify`). `lost`: a
 * takeover owns the ticket now, and nothing may be sent. Legacy mode, which
 * stores no owner, stamps whatever pending claim is there. Never throws.
 */
export async function markLaunchSent(kv: KeyedKv, input: { issueKey: string; run: ClaimRun; sentAt: Date }): Promise<MarkSentOutcome> {
  const key = implementClaimKey(input.issueKey);
  const sentAt = input.sentAt.toISOString();
  if (input.run.mode === "legacy") {
    try {
      const current = parseClaim(await kv.get(key));
      if (current?.state !== "pending") return "lost";
      await kv.put(key, { ...current, sentAt });
      return "marked";
    } catch (error) {
      warnKv("claim.markLaunchSent", error);
      return "unavailable";
    }
  }
  const written = await updateVerified(kv, key, (current) => {
    const held = parseClaim(current);
    if (held?.state !== "pending" || !ownedBy(current, input.run.owner)) return undefined;
    return { ...(current as Record<string, JsonValue>), sentAt };
  });
  return written.status === "written" ? "marked" : written.status === "lost" ? "lost" : "unavailable";
}

/** Drop this delivery's pending claim; a claim another delivery holds is kept. A claim left behind goes stale after LAUNCH_GRACE_MS. */
export async function releaseImplementation(kv: KeyedKv, input: { issueKey: string; run: ClaimRun }): Promise<ReleaseOutcome> {
  return releaseClaim(kv, implementClaimKey(input.issueKey), input.run);
}

/**
 * True for the first caller to report a failed launch of this approval.
 * Keyed by changelog id, so redeliveries of one approval post once while a
 * fresh move to Approved (a new changelog id) reports its own failure.
 */
export async function takeLaunchFailureNotice(
  kv: KeyedKv,
  input: { issueKey: string; changelogId: string; now: Date }
): Promise<boolean> {
  const key = launchFailureNoticeKey(input);
  const value = { at: input.now.toISOString() };
  try {
    if (supportsKvCas(kv)) return (await kv.putIfAbsent(key, value)).ok;
    if ((await kv.get(key)) !== undefined) return false;
    await kv.put(key, value);
    return true;
  } catch (error) {
    warnKv("claim.takeLaunchFailureNotice", error);
    // The claim write just succeeded on this store, so a failure here is transient; one extra comment beats none.
    return true;
  }
}

export async function returnLaunchFailureNotice(kv: KeyedKv, input: { issueKey: string; changelogId: string }): Promise<void> {
  try {
    await kv.delete(launchFailureNoticeKey(input));
  } catch (error) {
    warnKv("claim.returnLaunchFailureNotice", error);
    // The comment for this approval is then never posted; a new approval posts its own.
  }
}

// One claim per ticket, stage, and pull request (`pr-status/<KEY>/<stage>/<repo>#<n>`).
// `pending` is written before the Jira read; `moved` replaces it once the
// ticket is in the target status, and is never released, so a redelivery or
// a later push writes nothing. Any other outcome deletes the claim, only
// while it is still this delivery's, so the next delivery for that PR tries
// again. The claim keeps two concurrent deliveries from both seeing In
// Progress and moving the ticket twice, which would give the desk two
// changelog ids to announce. It is the verified claim above, so the same
// residual applies: a put slower than the settle can still give two moves,
// and `transitionFrom` is the last guard.

export type StatusMoveClaim = { state: "pending"; at: string } | { state: "moved"; at: string; outcome: string };

export type StatusMoveOutcome = { status: "claimed" } | { status: "moved"; claim: { at: string; outcome: string } } | { status: "in_flight" } | { status: "unavailable" };

export async function claimStatusMove(kv: KeyedKv, key: KvKey, options: { now: Date; run: ClaimRun }): Promise<StatusMoveOutcome> {
  const { now, run } = options;
  const outcome = await takeStatusMove(kv, key, { pending: { state: "pending", at: now.toISOString() }, run, classify: (value) => classifyStatusMove(value, now) });
  logClaim(run, { claim: outcome.status, key });
  return outcome;
}

type StatusMoveLost = Exclude<StatusMoveOutcome, { status: "claimed" }> | { status: "stale" };

async function takeStatusMove(
  kv: KeyedKv,
  key: KvKey,
  input: { pending: StatusMoveClaim; run: ClaimRun; classify: (value: unknown) => StatusMoveLost }
): Promise<StatusMoveOutcome> {
  const { run, classify } = input;
  const pending = run.mode === "legacy" ? input.pending : { ...input.pending, owner: run.owner };
  try {
    if (supportsKvCas(kv)) {
      const first = await kv.putIfAbsent(key, pending);
      if (first.ok) return { status: "claimed" };
      const entry = await kv.getWithVersion(key);
      if (entry === undefined) return { status: "in_flight" };
      const lost = classify(entry.value);
      if (lost.status !== "stale") return lost;
      const taken = await kv.putIfVersion(key, pending, entry.version);
      return taken.ok ? { status: "claimed" } : { status: "in_flight" };
    }
    if (run.mode === "verified") {
      const taken = await takeVerifiedClaim(kv, key, { pending: input.pending, run, classify });
      return taken.status === "claimed" ? { status: "claimed" } : taken;
    }
    const existing = await kv.get(key);
    if (existing !== undefined) {
      const lost = classify(existing);
      if (lost.status !== "stale") return lost;
    }
    await kv.put(key, pending);
    return { status: "claimed" };
  } catch (error) {
    warnKv("claim.takeStatusMove", error);
    return { status: "unavailable" };
  }
}

export async function recordStatusMove(kv: KeyedKv, key: KvKey, claim: { at: string; outcome: string }): Promise<boolean> {
  try {
    await kv.put(key, { state: "moved", ...claim });
    return true;
  } catch (error) {
    warnKv("claim.recordStatusMove", error);
    // The pending claim then goes stale and the next delivery re-reads the ticket, which is already moved.
    return false;
  }
}

/** Drop this delivery's pending claim; a claim another delivery holds is kept. A claim left behind goes stale after STALE_PENDING_MS. */
export async function releaseStatusMove(kv: KeyedKv, key: KvKey, run: ClaimRun): Promise<ReleaseOutcome> {
  return releaseClaim(kv, key, run);
}

/** True when the worker recorded a launch for this ticket: the PR is the one its agent was asked to open. */
export async function hasLaunched(kv: KeyedKv, issueKey: string): Promise<boolean | "unavailable"> {
  try {
    return parseClaim(await kv.get(implementClaimKey(issueKey)))?.state === "launched";
  } catch (error) {
    warnKv("claim.hasLaunched", error);
    return "unavailable";
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

/** A stored claim, or undefined for anything that is not one of the two shapes. */
export function parseClaim(value: unknown): ImplementationClaim | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const at = record["at"];
  if (typeof at !== "string") return undefined;
  if (record["state"] === "pending") {
    const deliveryId = record["deliveryId"];
    const sentAt = record["sentAt"];
    return {
      state: "pending",
      at,
      ...(typeof deliveryId === "string" && deliveryId !== "" ? { deliveryId } : {}),
      ...(typeof sentAt === "string" && sentAt !== "" ? { sentAt } : {}),
    };
  }
  const agentId = record["agentId"];
  const url = record["url"];
  if (record["state"] !== "launched" || typeof agentId !== "string" || typeof url !== "string" || url === "") return undefined;
  return { state: "launched", at, agentId, url, commented: record["commented"] === true, moved: record["moved"] === true };
}

function classify(value: unknown, input: { now: Date; deliveryId: string | undefined; mode: ClaimMode }): Lost {
  const { now, deliveryId } = input;
  // Only the verified claim's confirm step passes an empty key here: the pre-read, legacy, and CAS paths never do.
  if (value === undefined) return { status: "unconfirmed" };
  const claim = parseClaim(value);
  // No version of the worker writes anything else here, so it holds no launch; left as in flight it would block the ticket for good.
  if (claim === undefined) return input.mode === "legacy" ? { status: "in_flight" } : { status: "stale" };
  if (claim.state === "launched") return { status: "launched", claim };
  // This delivery's own pending claim, met again on a replayed admission: its launch never got past the claim.
  // Unlike the planner's rule this stops at pending: a launched claim is final and never launches again.
  // Once the launch was handed to July (`sentAt`) the replay meets it as in flight: the send is the launch.
  if (deliveryId !== undefined && claim.deliveryId === deliveryId && claim.sentAt === undefined) return { status: "stale" };
  if (pendingLost({ claim, now, mode: input.mode })) return { status: "stale" };
  return { status: "in_flight" };
}

/**
 * True once a pending launch claim is older than {@link LAUNCH_GRACE_MS}, or
 * its `at` is no time at all; a claim whose launch was sent as a July cloud
 * turn (`sentAt`) is lost only {@link LAUNCH_SENT_GRACE_MS} after the send.
 * `FACTORY_CLAIM_MODE=legacy` keeps the frozen claim's {@link STALE_PENDING_MS}
 * and its reading of an unreadable `at` as in flight.
 */
export function pendingLost(input: { claim: PendingClaim; now: Date; mode: ClaimMode }): boolean {
  const at = Date.parse(input.claim.at);
  if (input.mode === "legacy") return input.now.getTime() - at > STALE_PENDING_MS;
  if (!Number.isFinite(at)) return true;
  const sentAt = input.claim.sentAt === undefined ? NaN : Date.parse(input.claim.sentAt);
  if (Number.isFinite(sentAt)) return input.now.getTime() - sentAt > LAUNCH_SENT_GRACE_MS;
  return input.now.getTime() - at > LAUNCH_GRACE_MS;
}

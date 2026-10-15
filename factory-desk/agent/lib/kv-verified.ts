import type { JsonValue } from "@cursor/july";
import type { KeyedKv, KvKey } from "./kv-keys.js";
import { warnKvUnavailable } from "./ops-funnel.js";

// ctx.host.kv has only get, put and delete, locally and hosted: no
// compare-and-set. Every conditional write here is best effort, verified
// after write: read, decide, write, read back, and retry a bounded number of
// times. The residual window is a second writer whose put lands after this
// writer's read-back: both see their own value and both report "written";
// the later put is what the key holds. Where exactly-once matters, pair
// this with an external check (Jira state, GitHub, an idempotency key).
//
// Retry policy. A failed kv call is retried only when it can pass on a
// retry (`isRetryable`: HTTP 429, a 5xx, or no status at all, as for a
// network error). A permanent refusal (another 4xx, one of the hosted
// store's own reason codes such as `agentsdk_kv_key_invalid`, or one of
// July's local refusals in `KV_LOCAL_REFUSALS`) stops at once and the helper
// returns `unavailable`, logging why. Retries
// wait `KV_RETRY_PAUSES_MS` (100 ms, then 400 ms) with jitter, unless the
// caller passes its own `pausesMs`. `FACTORY_KV_RETRY_PAUSES_MS`, read per
// call, overrides those defaults: a comma list of milliseconds whose sum is
// at most `KV_RETRY_PAUSE_BUDGET_MS`; empty (or `off`) turns the pauses off.
// None of these helpers throws, whatever the options' hooks or the env do:
// callers branch on the status they return. A caller that retries in a loop
// of its own passes `pausesMs: []`, so only its loop pauses.
//
// Every `unavailable` (and a failed `readRetrying`) goes to the ops funnel
// (ops-funnel.ts) as site `kv-verified.<helper>/<key prefix>`, with the last
// failure's status and reason code: a `{"kv":"unavailable"}` line unless the
// refusal was already logged, then at most one ops Slack line per hour.
//
// Shared verbatim by the factory agents that keep state in host.kv; its
// test is factory-desk's kv-verified.test.ts (scripts/copies-parity.test.mjs).

export const VERIFY_ATTEMPTS = 3;

/** The default wait before the second and third attempts, before jitter. */
export const KV_RETRY_PAUSES_MS: readonly number[] = [100, 400];

/**
 * The most one call may spend in default pauses. Half of the shortest sleep
 * the admission-budget probe (plan gate G4) tries, so it fits whatever G4 finds.
 */
export const KV_RETRY_PAUSE_BUDGET_MS = 500;

/**
 * The hosted store's reason codes (July 0.2.25, `STORAGE_RPC_ERROR_CODES` in
 * storage-backends/cursor-hosted.js). Each is a refusal a retry cannot fix.
 * Its catch-all `agentsdk_storage_http_error` is not here: it goes by status.
 */
export const KV_PERMANENT_REASON_CODES: ReadonlySet<string> = new Set([
  "agentsdk_kv_credential_missing",
  "agentsdk_kv_cursor_invalid",
  "agentsdk_kv_deployment_unbound",
  "agentsdk_kv_key_invalid",
  "agentsdk_kv_request_invalid",
  "agentsdk_kv_storage_not_allowed",
  "agentsdk_kv_value_invalid",
  "agentsdk_kv_version_invalid",
]);

/**
 * July's own refusals made before any request (no status, no reason code),
 * which a retry cannot fix: an empty key (internal/host-kv.js), and hosted
 * storage with no deployment credential or no fetch
 * (storage-backends/cursor-hosted.js). Each pattern is anchored at both
 * ends on July 0.2.25's exact message text, so a reworded message is
 * retried like any other failure with no status.
 */
export const KV_LOCAL_REFUSALS: readonly RegExp[] = [
  /^host\.kv key must be a non-empty string$/,
  /^cursorHostedStorage requires CURSOR_API_KEY \(deployment pod credential on Cursor hosting\)$/,
  /^cursorHostedStorage requires fetch$/,
];

/**
 * - `written`: the read-back found this caller's value (or, for a delete, no
 *   matching value).
 * - `lost`: the decision refused the stored value; `current` is what it saw.
 * - `unavailable`: reads or writes kept failing, or the store refused the
 *   call outright; the key may or may not hold this caller's value.
 */
export type VerifiedResult =
  | { status: "written"; value: JsonValue | undefined }
  | { status: "lost"; current: JsonValue | undefined }
  | { status: "unavailable" };

export type ReadResult = { ok: true; value: JsonValue | undefined } | { ok: false };

export type RetryOptions = {
  /** Attempts in all, the first included. Default {@link VERIFY_ATTEMPTS}. */
  attempts?: number;
  /** The exact wait before attempt i + 2, no jitter. Default: the env or {@link KV_RETRY_PAUSES_MS}, with jitter. */
  pausesMs?: readonly number[];
  /** Where `FACTORY_KV_RETRY_PAUSES_MS` is read. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Jitter source in [0, 1]; anything outside, non-finite, or a throw counts as 0. Default `Math.random`. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Receives the one JSON line logged when a refusal stops the retries. Default `console.warn`. */
  warn?: (line: string) => void;
};

type KvOp = "get" | "put" | "delete";

/** A failure's HTTP status, hosted reason code, and message, when it carries them. */
function storageFailure(error: unknown): { status?: number; reasonCode?: string; message?: string } {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  return {
    status: typeof record["status"] === "number" ? record["status"] : undefined,
    reasonCode: typeof record["reasonCode"] === "string" ? record["reasonCode"] : undefined,
    message: typeof record["message"] === "string" ? record["message"] : undefined,
  };
}

function localRefusal(failure: { status?: number; reasonCode?: string; message?: string }): boolean {
  const { status, reasonCode, message } = failure;
  return status === undefined && reasonCode === undefined && message !== undefined && KV_LOCAL_REFUSALS.some((pattern) => pattern.test(message));
}

/**
 * Whether a failed kv call can pass on a retry: HTTP 429 (whatever its reason
 * code), a 5xx, or no status (a network error, a timeout). A hosted reason
 * code in {@link KV_PERMANENT_REASON_CODES}, any other 4xx, or one of
 * {@link KV_LOCAL_REFUSALS} cannot.
 */
export function isRetryable(error: unknown): boolean {
  const failure = storageFailure(error);
  const { status, reasonCode } = failure;
  if (status === 429) return true;
  if (reasonCode !== undefined && KV_PERMANENT_REASON_CODES.has(reasonCode)) return false;
  if (status === undefined) return !localRefusal(failure);
  return status < 400 || status >= 500;
}

/**
 * The default pauses under `FACTORY_KV_RETRY_PAUSES_MS`: unset keeps
 * {@link KV_RETRY_PAUSES_MS}; empty or `off` is none; a comma list of whole
 * milliseconds is used when its sum is within {@link KV_RETRY_PAUSE_BUDGET_MS}.
 * Anything else keeps the defaults.
 */
export function kvRetryPausesMs(env: NodeJS.ProcessEnv): readonly number[] {
  let value: unknown;
  try {
    value = env.FACTORY_KV_RETRY_PAUSES_MS;
  } catch {
    return KV_RETRY_PAUSES_MS;
  }
  if (typeof value !== "string") return KV_RETRY_PAUSES_MS;
  const raw = value.trim();
  if (raw === "" || raw.toLowerCase() === "off") return [];
  const parts = raw.split(",").map((part) => part.trim());
  if (!parts.every((part) => /^\d+$/.test(part))) return KV_RETRY_PAUSES_MS;
  const pauses = parts.map((part) => Number(part));
  let total = 0;
  for (const ms of pauses) total += ms;
  return total <= KV_RETRY_PAUSE_BUDGET_MS ? pauses : KV_RETRY_PAUSES_MS;
}

type Retry = {
  attempts: number;
  /** Wait before `attempt` (0-based); never before the first. */
  pauseBefore: (attempt: number) => Promise<void>;
  /** True when `failure` cannot pass on a retry; that is logged once. Records the failure for `unavailable`. */
  refused: (failure: { op: KvOp; error: unknown }) => boolean;
  /** Reports the last failure to the ops funnel and returns `unavailable`. */
  unavailable: (helper: "read" | "update" | "delete") => { status: "unavailable" };
};

/** `random()` held to [0, 1]; a throw, a non-number, or a value below 0 is 0. */
function jitterFraction(random: () => number): number {
  let value: number;
  try {
    value = Number(random());
  } catch {
    return 0;
  }
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, 1);
}

/** The default pauses, each jittered to within [half, all] of its nominal value, so their sum stays in budget. */
function defaultPauses(options: RetryOptions): number[] {
  let env: NodeJS.ProcessEnv;
  try {
    env = options.env ?? process.env;
  } catch {
    env = {};
  }
  const random = options.random ?? Math.random;
  return kvRetryPausesMs(env).map((ms) => Math.round(ms * (0.5 + jitterFraction(random) / 2)));
}

function retryPolicy(key: KvKey, options: RetryOptions): Retry {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const pausesMs = options.pausesMs ?? defaultPauses(options);
  let last: { error: unknown; logged: boolean } | undefined;
  return {
    attempts: options.attempts ?? VERIFY_ATTEMPTS,
    pauseBefore: async (attempt) => {
      const ms = attempt > 0 ? pausesMs[attempt - 1] : undefined;
      if (ms === undefined || !(ms > 0)) return;
      try {
        await sleep(ms);
      } catch {
        // A pause that fails is skipped; the retry still runs.
      }
    },
    refused: ({ op, error }) => {
      last = { error, logged: false };
      if (isRetryable(error)) return false;
      last.logged = true;
      const failure = storageFailure(error);
      const local = localRefusal(failure) ? { message: failure.message } : {};
      try {
        warn(JSON.stringify({ kv: "retry_stopped", op, key: String(key).slice(0, 120), status: failure.status, reasonCode: failure.reasonCode, ...local }));
      } catch {
        // Logging must not break the no-throw contract.
      }
      return true;
    },
    unavailable: (helper) => {
      const prefix = String(key).split(/[/:]/)[0]?.slice(0, 40) ?? "";
      warnKvUnavailable({ site: `kv-verified.${helper}/${prefix}`, error: last?.error, logged: last?.logged });
      return { status: "unavailable" };
    },
  };
}

export async function readRetrying(kv: KeyedKv, key: KvKey, options: RetryOptions = {}): Promise<ReadResult> {
  const retry = retryPolicy(key, options);
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    await retry.pauseBefore(attempt);
    try {
      return { ok: true, value: await kv.get(key) };
    } catch (error) {
      if (retry.refused({ op: "get", error })) break;
    }
  }
  retry.unavailable("read");
  return { ok: false };
}

/**
 * Write `decide(current)` to `key`, creating it when absent. `decide`
 * returns undefined to refuse (the result is `lost`). When the read-back
 * shows another writer's value, `decide` runs again on that value, so a
 * writer that lost the race either yields or merges onto the winner.
 */
export async function updateVerified(
  kv: KeyedKv,
  key: KvKey,
  decide: (current: JsonValue | undefined) => JsonValue | undefined,
  options: RetryOptions = {},
): Promise<VerifiedResult> {
  const retry = retryPolicy(key, options);
  let wrote: JsonValue | undefined;
  let lastFailed = false;
  // Describes only the last attempt's put: a put that resolves clears it.
  let putFailed = false;
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    await retry.pauseBefore(attempt);
    let current: JsonValue | undefined;
    try {
      current = await kv.get(key);
    } catch (error) {
      if (retry.refused({ op: "get", error })) return retry.unavailable("update");
      lastFailed = true;
      continue;
    }
    // A write whose read-back failed may have landed; it is ours, not a rival's.
    if (wrote !== undefined && sameJson(current, wrote)) return { status: "written", value: wrote };
    const next = decide(current);
    if (next === undefined) return { status: "lost", current };
    wrote = next;
    try {
      await kv.put(key, next);
      putFailed = false;
    } catch (error) {
      if (retry.refused({ op: "put", error })) return retry.unavailable("update");
      // Possibly applied; the read-back decides.
      putFailed = true;
    }
    try {
      if (sameJson(await kv.get(key), next)) return { status: "written", value: next };
      lastFailed = false;
    } catch (error) {
      if (retry.refused({ op: "get", error })) return retry.unavailable("update");
      lastFailed = true;
    }
  }
  // A put that never stuck because it kept failing leaves the key unknown;
  // one overwritten by another writer on every attempt is lost.
  return lastFailed || putFailed ? retry.unavailable("update") : { status: "lost", current: undefined };
}

/**
 * Delete `key` only while `matches(current)` holds (the stored owner or
 * session id is still the caller's). A value that stops matching before the
 * delete is kept; one written after the delete is kept too. A rival that
 * writes between the read and the delete is removed: that is the residual
 * window, and why callers that can prefer an owner-stamped marker written
 * with {@link updateVerified}.
 */
export async function deleteVerified(
  kv: KeyedKv,
  key: KvKey,
  matches: (current: JsonValue | undefined) => boolean,
  options: RetryOptions = {},
): Promise<VerifiedResult> {
  const retry = retryPolicy(key, options);
  let deleted = false;
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    await retry.pauseBefore(attempt);
    let current: JsonValue | undefined;
    try {
      current = await kv.get(key);
    } catch (error) {
      if (retry.refused({ op: "get", error })) return retry.unavailable("delete");
      continue;
    }
    if (!matches(current)) return deleted ? { status: "written", value: undefined } : { status: "lost", current };
    try {
      await kv.delete(key);
    } catch (error) {
      if (retry.refused({ op: "delete", error })) return retry.unavailable("delete");
      // Possibly applied; the read-back decides.
    }
    deleted = true;
    try {
      if (!matches(await kv.get(key))) return { status: "written", value: undefined };
    } catch (error) {
      if (retry.refused({ op: "get", error })) return retry.unavailable("delete");
      // Retried from the top.
    }
  }
  return retry.unavailable("delete");
}

/** Structural JSON equality; a hosted store need not keep key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

import { MAX_DIFF_CHARS } from "./diff-evidence.js";
import { type KeyedKv, reviewedKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { reviewedKey };

// The last review posted per PR, and the evidence it read. post_findings
// writes it only after GitHub accepts the review, so a preempted or failed
// turn never suppresses the next delivery. The channel skips a delivery whose
// evidence identity matches: synchronize, ready_for_review, and reopened on
// one base and head would otherwise each start a full review turn.
//
// Evidence identity: a review reads the compare diff `{base}...{head}` of one
// pull request, so the identity is { repo, PR number, base sha, head sha }.
// Repo (lowercased) and number are the kv key; base and head are in the
// record, and a delivery is skipped only when both match. Two shas pin the
// compare: the diff of fixed commits does not change. A base named by branch
// (an event without base.sha) is not pinned, so it never matches. A record
// without a base (written before the base was recorded) never matches either,
// so it reviews again. The base is the base branch tip, not the merge base
// the three-dot diff follows: a moved base re-reviews an unchanged diff (safe
// direction), and the merge base would cost a compare request before every
// skip decision. The diff shaping (lockfile order, the cap) is code:
// only the cap is part of the identity, below; a deploy that changes the
// shaping does not re-review a recorded identity.
//
// This is a dedupe record written after the side effect, not a claim: nothing
// is taken before the post, and an absent or unreadable record means review.
// So a lost or failed write costs one repeat review and can never block an
// identity that was not reviewed, and with no redelivery nothing is left
// waiting on a retry. The put is a blind last-write-wins overwrite with no
// read of the current value: whichever identity it names was reviewed.
//
// A truncated review is recorded with complete: false and the diff's size.
// The diff of one identity does not change, so a repeat would post the same
// INCOMPLETE review; it is suppressed unless the cap has since grown to hold
// the whole diff.

const SHA = /^[0-9a-f]{40}$/i;

export type EvidenceIdentity = { fullName: string; number: number; base: string; headSha: string };

export type ReviewedRecord = { base: string; headSha: string; complete: boolean; totalChars?: number };

function normalBase(base: string): string {
  return SHA.test(base) ? base.toLowerCase() : base;
}

export async function recordReview({
  kv,
  identity,
  at,
  incomplete,
}: {
  kv: KeyedKv;
  identity: EvidenceIdentity;
  at: string;
  incomplete?: { totalChars: number };
}): Promise<void> {
  const key = reviewedKey(identity.fullName, identity.number);
  const record = { base: normalBase(identity.base), headSha: identity.headSha.toLowerCase(), at };
  if (incomplete === undefined) {
    await kv.put(key, record);
  } else {
    await kv.put(key, { ...record, complete: false, totalChars: incomplete.totalChars });
  }
}

/** Undefined when nothing was recorded, the record predates the base, or the store cannot be read, so the review runs. */
export async function reviewedRecord(kv: KeyedKv | undefined, fullName: string, number: number): Promise<ReviewedRecord | undefined> {
  if (kv === undefined) return undefined;
  try {
    const stored = await kv.get(reviewedKey(fullName, number));
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined;
    const record = stored as Record<string, unknown>;
    const base = record["base"];
    const headSha = record["headSha"];
    if (typeof base !== "string" || typeof headSha !== "string") return undefined;
    if (record["complete"] === undefined) return { base, headSha, complete: true };
    if (record["complete"] !== false) return undefined;
    const totalChars = record["totalChars"];
    return typeof totalChars === "number" ? { base, headSha, complete: false, totalChars } : undefined;
  } catch (error) {
    warnKv("reviewed-head.reviewedRecord", error);
    return undefined;
  }
}

/** The recorded review a delivery with this identity would only repeat, or undefined when it should review. */
export async function priorReview({
  kv,
  identity,
  maxChars = MAX_DIFF_CHARS,
}: {
  kv: KeyedKv | undefined;
  identity: EvidenceIdentity;
  maxChars?: number;
}): Promise<ReviewedRecord | undefined> {
  if (!SHA.test(identity.base)) return undefined;
  const record = await reviewedRecord(kv, identity.fullName, identity.number);
  if (record === undefined) return undefined;
  if (record.base !== identity.base.toLowerCase() || record.headSha !== identity.headSha.toLowerCase()) return undefined;
  if (!record.complete && (record.totalChars ?? 0) <= maxChars) return undefined;
  return record;
}

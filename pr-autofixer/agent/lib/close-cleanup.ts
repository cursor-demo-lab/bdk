import type { JsonValue } from "@cursor/july";
import { releaseAutoDrive } from "./auto-drive.js";
import type { GithubPrRef } from "./drive.js";
import { deleteVerified, readRetrying, type RetryOptions, type VerifiedResult } from "./kv-verified.js";
import { affinityKey, autoDriveKey, bugbotRoundsKey, driveSessionKey, type KeyedKv } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";
import { bumpPrGeneration } from "./pr-generation.js";

// What a closed pull request leaves behind in host.kv, and what goes. A
// reopened PR starts over: no agent bound, no drive claim, Bugbot rounds
// back at 0 (the owner's decision on plan K8's open question 1), and new
// `pr:` sessions. Per PR:
//
// - auto-drive:<pr>          deleted (releaseAutoDrive, whatever it holds)
// - drive-session/<session>  deleted once the claim is gone (deleted or
//                            absent), when the claim named that session and
//                            the record still names this PR and the claim's
//                            token. While the claim may still be there the
//                            record stays: the drive's turn-end release
//                            needs it, or the claim would block the PR for
//                            the rest of its 2 h lease.
// - affinity/<label>         deleted, so a reopen's wakes name no old agent;
//                            a drive that binds after the close writes it
//                            back only if GitHub no longer says closed
//                            (lib/affinity.ts recordPrAgentWhileOpen)
// - bugbot-rounds:<pr>       deleted, cap note included; a round recorded
//                            after the close finds no record and is skipped
// - v1/pr-generation/<o>/<r>/<n>
//                            bumped, so the drive channel's and buffered
//                            wakes' continuation key (`pr:<label>@g<n>`)
//                            names a new session after a reopen; not on a
//                            merge (`bumpGeneration: false`), since a merged
//                            PR cannot reopen
// - bugbot-fresh-failures:*  left: keyed by heads nothing records, and each
//                            carries a 1 h `exp`
// - webhook-buffer           left: one snapshot shared by every PR; the
//                            channel discards this PR's entry first
//
// Best effort and idempotent: a redelivered close, or a close after merge,
// finds the keys gone and reports `absent` (the generation is bumped again,
// which only skips a key). Never throws; one JSON line. The channel skips
// all of this when GitHub says the PR is open again and was updated after
// the close event (a late or redelivered close after a reopen).

export const CLOSE_LEAVES: readonly string[] = ["bugbot-fresh-failures (1 h exp)", "webhook-buffer (shared; entry discarded)"];

export type CleanupOutcome = "deleted" | "absent" | "kept" | "bumped" | "skipped_merged" | "unavailable";

export type CloseCleanup = {
  claim: CleanupOutcome;
  driveSession: CleanupOutcome;
  affinity: CleanupOutcome;
  bugbotRounds: CleanupOutcome;
  generation: CleanupOutcome;
};

/** `FACTORY_FIXER_CLOSE_CLEANUP=off` puts back the close from before K8: release the claim only, and throw when kv fails. */
export function closeCleanupOn(env: NodeJS.ProcessEnv): boolean {
  return env.FACTORY_FIXER_CLOSE_CLEANUP?.trim().toLowerCase() !== "off";
}

function outcomeOf(result: VerifiedResult): CleanupOutcome {
  if (result.status === "written") return "deleted";
  if (result.status === "unavailable") return "unavailable";
  return result.current === undefined ? "absent" : "kept";
}

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One step's outcome; a step that throws is `unavailable` and stops no other step. */
async function guarded(run: () => Promise<CleanupOutcome>): Promise<CleanupOutcome> {
  try {
    return await run();
  } catch {
    return "unavailable";
  }
}

/**
 * Delete what a closed PR leaves in host.kv (see the top of this file).
 * `retryMs` is the claim release's (auto-drive's SETTLE_RETRY_MS by
 * default); `retry` the other steps' (kv-verified's defaults). After one
 * read of the claim, the claim release (then the session record), affinity,
 * rounds and the generation run side by side, so a close pauses about as
 * long as the claim release plus one delete. `fields` ride on the log line.
 */
export async function cleanupClosedPr(
  kv: KeyedKv,
  input: { pr: GithubPrRef; retryMs?: readonly number[]; retry?: RetryOptions; fields?: Record<string, string>; bumpGeneration?: boolean }
): Promise<CloseCleanup> {
  const { pr, retry } = input;
  let result: CloseCleanup = { claim: "unavailable", driveSession: "unavailable", affinity: "unavailable", bugbotRounds: "unavailable", generation: "unavailable" };
  try {
    const seen = await readRetrying(kv, autoDriveKey(pr), retry);
    const claim = seen.ok ? record(seen.value) : undefined;
    const sessionId = text(claim?.["sessionId"]);
    const token = text(claim?.["owner"]);
    const releaseThenSession = async (): Promise<[CleanupOutcome, CleanupOutcome]> => {
      const released = await guarded(async () => ((await releaseAutoDrive(kv, pr, input.retryMs)) === "written" ? "deleted" : "absent"));
      const session = await guarded(async () => {
        if (!seen.ok) return "unavailable";
        if (sessionId === undefined || token === undefined) return "absent";
        if (released === "unavailable") return "kept";
        const owned = (current: JsonValue | undefined) => text(record(current)?.["pr"]) === pr.label && text(record(current)?.["token"]) === token;
        return outcomeOf(await deleteVerified(kv, driveSessionKey(sessionId), owned, retry));
      });
      return [released, session];
    };
    const [[claimOutcome, driveSession], affinity, bugbotRounds, generation] = await Promise.all([
      releaseThenSession(),
      guarded(async () => outcomeOf(await deleteVerified(kv, affinityKey(pr), (current) => current !== undefined, retry))),
      guarded(async () => outcomeOf(await deleteVerified(kv, bugbotRoundsKey(pr), (current) => current !== undefined, retry))),
      guarded(async () => {
        if (input.bumpGeneration === false) return "skipped_merged";
        return (await bumpPrGeneration(kv, { pr, ...(retry === undefined ? {} : { retry }) })).status === "written" ? "bumped" : "unavailable";
      }),
    ]);
    result = { claim: claimOutcome, driveSession, affinity, bugbotRounds, generation };
  } catch (error) {
    // Reported below as unavailable.
    warnKv("close-cleanup.cleanupClosedPr", error);
  }
  try {
    console.log(JSON.stringify({ fixer: "close_cleanup", pr: pr.label, ...input.fields, ...result, left: CLOSE_LEAVES }));
  } catch {
    // Logging must not break the no-throw contract.
  }
  return result;
}

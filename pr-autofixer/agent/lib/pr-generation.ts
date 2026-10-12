import type { JsonValue } from "@cursor/july";
import { continuationTokenFor, type GithubPrRef } from "./drive.js";
import { readRetrying, updateVerified, type RetryOptions, type VerifiedResult } from "./kv-verified.js";
import { prGenerationKey, type KeyedKv } from "./kv-keys.js";

export { prGenerationKey };

// How many times a PR has been closed without merging, as `{ n }`. July resumes the session
// an existing continuation key names, so without this a reopened PR's
// `drive_pr`, drive route or fresh Bugbot drive would resume its session
// from before the close (and that session's cloud agent). The close bumps
// `n`, and continuationTokenFor appends it. Kept: a key that went back to 0
// would resume the pre-close sessions again.

function generationOf(value: JsonValue | undefined): number {
  const n = typeof value === "object" && value !== null && !Array.isArray(value) ? value["n"] : undefined;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The PR's continuation key at its current generation. A read that fails
 * every try falls back to generation 0 with one log line: the send still
 * goes, at worst into the session from before the PR's first close.
 */
export async function prContinuationToken(kv: KeyedKv, input: { pr: GithubPrRef; retry?: RetryOptions }): Promise<string> {
  const generation = await readPrGeneration(kv, input);
  if (generation === undefined) {
    console.warn(JSON.stringify({ fixer: "pr_generation", pr: input.pr.label, outcome: "unread_generation_0" }));
    return continuationTokenFor(input.pr);
  }
  return continuationTokenFor(input.pr, generation);
}

/** The PR's generation, or undefined when kv will not answer (never guessed). */
export async function readPrGeneration(kv: KeyedKv, input: { pr: GithubPrRef; retry?: RetryOptions }): Promise<number | undefined> {
  const read = await readRetrying(kv, prGenerationKey(input.pr), input.retry);
  return read.ok ? generationOf(read.value) : undefined;
}

/** One more close. A verified increment: two closes at once may count two, which only skips a key. */
export async function bumpPrGeneration(kv: KeyedKv, input: { pr: GithubPrRef; retry?: RetryOptions }): Promise<VerifiedResult> {
  return updateVerified(kv, prGenerationKey(input.pr), (current) => ({ n: generationOf(current) + 1 }), input.retry);
}

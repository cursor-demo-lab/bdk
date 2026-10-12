import type { HostGitHubClient } from "@cursor/july";
import type { GithubPrRef } from "./drive.js";
import { affinityKey, type KeyedKv } from "./kv-keys.js";
import { isTerminalPrState, fetchPrState } from "./pr-state.js";
import { continuationTokenFor } from "./drive.js";
import { readPrGeneration } from "./pr-generation.js";

export { affinityKey };

export async function lookupPrAgent(
  pr: GithubPrRef,
  kv: KeyedKv
): Promise<string | undefined> {
  const stored = await kv.get(affinityKey(pr));
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return undefined;
  }
  return typeof stored.bcId === "string" && stored.bcId.startsWith("bc-")
    ? stored.bcId
    : undefined;
}

export async function recordPrAgent(
  pr: GithubPrRef,
  bcId: string,
  kv: KeyedKv
): Promise<void> {
  if ((await lookupPrAgent(pr, kv)) === bcId) {
    return;
  }
  await kv.put(affinityKey(pr), {
    bcId,
    updatedAt: new Date().toISOString(),
  });
}

export type BindOutcome = "recorded" | "pr_closed" | "stale_generation";

/**
 * Record a bound agent's affinity from an `agent.bound` hook, unless the bind
 * lands after the PR's close: a close deletes `affinity/` so a reopened PR
 * wakes no pre-close agent, and a drive that sent before the close can still
 * bind after it. So nothing is written while GitHub says the PR is closed or
 * merged (no answer counts as open, as before), nor for a `pr:` session whose
 * continuation key names an older generation than the PR's current one (a
 * pre-close session binding after a reopen). `continuationToken` is the
 * session's key; a delivery session (`evt:`) or none skips that check, and
 * so does a generation kv will not return: it is never guessed, since a
 * guess of 0 would pass a pre-close session and refuse a current one. The
 * bind is then recorded, as it was before the check existed.
 */
export async function recordPrAgentWhileOpen(input: {
  pr: GithubPrRef;
  bcId: string;
  kv: KeyedKv;
  github?: HostGitHubClient;
  continuationToken?: string | null;
}): Promise<BindOutcome> {
  const { pr, kv } = input;
  if (input.github !== undefined && isTerminalPrState(await fetchPrState({ github: input.github, pr }))) return logBind({ pr, outcome: "pr_closed" });
  const token = input.continuationToken;
  if (typeof token === "string" && token.startsWith("pr:")) {
    const generation = await readPrGeneration(kv, { pr });
    if (generation !== undefined && token !== continuationTokenFor(pr, generation)) return logBind({ pr, outcome: "stale_generation" });
  }
  await recordPrAgent(pr, input.bcId, kv);
  return "recorded";
}

function logBind(input: { pr: GithubPrRef; outcome: BindOutcome }): BindOutcome {
  console.log(JSON.stringify({ fixer: "bind_skipped", pr: input.pr.label, outcome: input.outcome }));
  return input.outcome;
}

import type { HostKvApi, JsonValue } from "@cursor/july";
import type { GithubPrRef } from "@cursor/july/channels/slack";

// Frozen: `peekBugbotRound` and `recordBugbotRound` from
// agent/lib/auto-drive.ts at 268fc79, with the helpers they call. A slug
// mid-deploy still runs this code, so race tests pit it against the live
// round record in both orders. Never edit it to follow the live file; delete
// it once no deployed slug can run it.

export const BUGBOT_MAX_ROUNDS = 2;

export function bugbotRoundsKey(pr: GithubPrRef): string {
  return `bugbot-rounds:${pr.owner}/${pr.repo}#${pr.number}`;
}

type BugbotRounds = { shas: string[]; rounds: number; capNoted?: true };

export type BugbotRound = "drive" | "duplicate" | "cap_reached" | "capped";

type Claim = Record<string, JsonValue>;

export async function peekBugbotRound(kv: HostKvApi, input: { pr: GithubPrRef; headSha: string | undefined }): Promise<BugbotRound> {
  const current = await readRounds(kv, input.pr);
  if (current === undefined) return "drive";
  const sha = shaOf(input.headSha);
  if (current.shas.includes(sha)) return "duplicate";
  if (current.rounds < BUGBOT_MAX_ROUNDS) return "drive";
  if (current.capNoted === true) return "capped";
  await kv.put(bugbotRoundsKey(input.pr), { ...current, shas: [...current.shas, sha], capNoted: true }).catch(() => undefined);
  return "cap_reached";
}

export async function recordBugbotRound(kv: HostKvApi, input: { pr: GithubPrRef; headSha: string | undefined }): Promise<void> {
  const current = (await readRounds(kv, input.pr)) ?? { shas: [], rounds: 0 };
  const sha = shaOf(input.headSha);
  if (current.shas.includes(sha)) return;
  await kv.put(bugbotRoundsKey(input.pr), { ...current, shas: [...current.shas, sha], rounds: current.rounds + 1 }).catch(() => undefined);
}

function shaOf(headSha: string | undefined): string {
  return headSha?.toLowerCase() ?? "unknown";
}

function asClaim(value: unknown): Claim | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Claim) : undefined;
}

async function readRounds(kv: HostKvApi, pr: GithubPrRef): Promise<BugbotRounds | undefined> {
  try {
    const stored = asClaim(await kv.get(bugbotRoundsKey(pr)));
    return {
      shas: Array.isArray(stored?.["shas"]) ? stored["shas"].filter((value): value is string => typeof value === "string") : [],
      rounds: typeof stored?.["rounds"] === "number" ? stored["rounds"] : 0,
      ...(stored?.["capNoted"] === true ? { capNoted: true as const } : {}),
    };
  } catch {
    return undefined;
  }
}

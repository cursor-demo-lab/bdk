import {
  prompt,
  type HostGitHubClient,
  type ReminderHostApi,
  type ReminderInfo,
} from "@cursor/july";
import type { GithubPrRef } from "./drive.js";
import { noteFactory, traced } from "./factory-otel.js";

export const MERGE_CONFLICT_PURPOSE = "merge_conflict_watch";

export type ConflictStatus = "closed" | "conflicted" | "clear";

export function conflictStatusFromPull(data: {
  state?: string;
  merged?: boolean;
  mergeable?: boolean | null;
}): ConflictStatus {
  if (data.merged === true || data.state === "closed") {
    return "closed";
  }
  return data.mergeable === false ? "conflicted" : "clear";
}

function mergeConflictTarget(pr: GithubPrRef): Record<string, unknown> {
  return {
    prUrl: pr.url,
    prLabel: pr.label,
    prOwner: pr.owner.toLowerCase(),
    prRepo: pr.repo.toLowerCase(),
    prNumber: pr.number,
  };
}

function isMergeConflictWatchForPr(
  reminder: ReminderInfo,
  pr: GithubPrRef
): boolean {
  const target = reminder.target;
  return (
    reminder.purpose === MERGE_CONFLICT_PURPOSE &&
    target !== undefined &&
    target.prOwner === pr.owner.toLowerCase() &&
    target.prRepo === pr.repo.toLowerCase() &&
    target.prNumber === pr.number
  );
}

async function checkMergeConflict(input: {
  github: HostGitHubClient;
  pr: GithubPrRef;
}): Promise<ConflictStatus> {
  try {
    const octokit = await input.github.getOctokit();
    const { data } = await octokit.rest.pulls.get({
      owner: input.pr.owner,
      repo: input.pr.repo,
      pull_number: input.pr.number,
    });
    return conflictStatusFromPull(data);
  } catch {
    return "clear";
  }
}

export async function armMergeConflictWatch(input: {
  reminders: ReminderHostApi;
  pr: GithubPrRef;
  channelId: string;
  continuationToken: string;
}): Promise<ReminderInfo> {
  await cancelRemindersForPr({
    reminders: input.reminders,
    pr: input.pr,
    reason: "rearm",
  });

  return input.reminders.create({
    purpose: MERGE_CONFLICT_PURPOSE,
    channelId: input.channelId,
    continuationToken: input.continuationToken,
    target: mergeConflictTarget(input.pr),
    every: "30m",
    busyPolicy: "skipIfBusy",
    run: traced({ span: "factory.reminder", kind: "reminder.merge_conflict", describe: (result) => ({ outcome: result.action }) }, async ({ followup, host }) => {
      noteFactory({ pr: input.pr.label });
      const status = await checkMergeConflict({
        github: host.github,
        pr: input.pr,
      });
      if (status === "closed") {
        return { action: "stop" };
      }
      if (status !== "conflicted") {
        return { action: "skip" };
      }
      await followup({
        message: prompt`
          Merge conflict detected. Resolve it if the PR is still conflicted. Auto-fix: rebase onto base, verify the resolution, and push. Never merge, enable auto-merge, or force-push.
        `,
      });
      return { action: "delivered" };
    }),
  });
}

export async function cancelRemindersForPr(input: {
  reminders: ReminderHostApi;
  pr: GithubPrRef;
  reason?: string;
}): Promise<number> {
  const armed = await input.reminders.list({
    status: "armed",
    purpose: MERGE_CONFLICT_PURPOSE,
  });
  const matches = armed.filter((rem) =>
    isMergeConflictWatchForPr(rem, input.pr)
  );
  await Promise.all(
    matches.map((rem) =>
      input.reminders.cancel(rem.id, input.reason ?? "pr_closed")
    )
  );
  return matches.length;
}

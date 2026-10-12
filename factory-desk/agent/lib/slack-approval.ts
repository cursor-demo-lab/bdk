// An approval made from Slack is answered once in the ticket's thread: by
// the In Progress line with the agent link. The desk records the approval
// just before it moves the ticket (the webhook can land before the move call
// returns) and clears it when the move fails. A move that finds the ticket
// already Approved keeps it: that approval raced this one. The Approved status webhook
// that follows posts nothing while the record is fresh. An approval made on
// the board has no record, so its Approved line still posts.

import { type KeyedKv, type KvKey, pullRequestRetryKey, retryBounceKey, slackApprovalKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { pullRequestRetryKey, retryBounceKey, slackApprovalKey };

/** Long enough for the Automation delivery, short enough that a later board approval is announced. */
export const SLACK_APPROVAL_WINDOW_MS = 10 * 60_000;

/** Best effort: without the record the Approved line posts, as it did before. */
export async function recordSlackApproval(kv: KeyedKv, input: { issueKey: string; at: Date; by?: string }): Promise<void> {
  try {
    await kv.put(slackApprovalKey(input.issueKey), { at: input.at.toISOString(), ...(input.by === undefined ? {} : { by: input.by }) });
  } catch (error) {
    warnKv("slack-approval.recordSlackApproval", error);
    // The thread hears an extra Approved line instead.
  }
}

/** The move did not land: a board approval that follows must still be announced. */
export async function clearSlackApproval(kv: KeyedKv, issueKey: string): Promise<void> {
  try {
    await kv.delete(slackApprovalKey(issueKey));
  } catch (error) {
    warnKv("slack-approval.clearSlackApproval", error);
    // A fresh record left behind silences at most one Approved line inside the window.
  }
}

/** True while an approval this desk made from Slack is fresh. An unreadable record is not one. */
export async function approvedInSlack(kv: KeyedKv, issueKey: string, now: Date): Promise<boolean> {
  return fresh(kv, slackApprovalKey(issueKey), now);
}

// `retry KEY` on an Approved ticket redelivers the approval to the worker by
// moving it Approved → Planned → Approved. The retry reply is the thread's
// answer, so the move-back line stays quiet the same way a Slack approval
// quiets the Approved line.

export async function recordRetryBounce(kv: KeyedKv, input: { issueKey: string; at: Date }): Promise<void> {
  try {
    await kv.put(retryBounceKey(input.issueKey), { at: input.at.toISOString() });
  } catch (error) {
    warnKv("slack-approval.recordRetryBounce", error);
    // The thread hears a move-back line as well as the retry reply.
  }
}

export async function clearRetryBounce(kv: KeyedKv, issueKey: string): Promise<void> {
  try {
    await kv.delete(retryBounceKey(issueKey));
  } catch (error) {
    warnKv("slack-approval.clearRetryBounce", error);
    // A fresh record left behind silences at most one move-back line inside the window.
  }
}

export async function retryBounceActive(kv: KeyedKv, issueKey: string, now: Date): Promise<boolean> {
  return fresh(kv, retryBounceKey(issueKey), now);
}

// `retry KEY` on an In Progress ticket the worker launched (TLSSN-35: the
// agent pushed its branch, no pull request opened) sends it back to the worker
// as In Progress → Approved. The worker moves it back to In Progress and opens
// the pull request. The retry reply is the thread's answer and In Review is the
// next beat, so the Approved line and the repeated In Progress line stay quiet.

export async function recordPullRequestRetry(kv: KeyedKv, input: { issueKey: string; at: Date }): Promise<void> {
  try {
    await kv.put(pullRequestRetryKey(input.issueKey), { at: input.at.toISOString() });
  } catch (error) {
    warnKv("slack-approval.recordPullRequestRetry", error);
    // The thread hears the Approved and In Progress lines again as well as the retry reply.
  }
}

export async function clearPullRequestRetry(kv: KeyedKv, issueKey: string): Promise<void> {
  try {
    await kv.delete(pullRequestRetryKey(issueKey));
  } catch (error) {
    warnKv("slack-approval.clearPullRequestRetry", error);
    // A fresh record left behind silences at most one Approved and one In Progress line inside the window.
  }
}

export async function pullRequestRetryActive(kv: KeyedKv, issueKey: string, now: Date): Promise<boolean> {
  return fresh(kv, pullRequestRetryKey(issueKey), now);
}

async function fresh(kv: KeyedKv, key: KvKey, now: Date): Promise<boolean> {
  let value: unknown;
  try {
    value = await kv.get(key);
  } catch (error) {
    warnKv("slack-approval.fresh", error);
    return false;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const at = Date.parse(String((value as Record<string, unknown>)["at"]));
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  return age >= -60_000 && age <= SLACK_APPROVAL_WINDOW_MS;
}

// The desk posts a ✅/❌ reaction can decide (reaction-approval.ts), recorded
// by the Slack ts they landed at when they are posted: the plan post
// (announcePlan) and the filing prompt (the one-reply sink). A reaction on
// any other message, including the stage reactions on a thread root, is not
// a decision.

import { pendingLease } from "./claim-lease.js";
import { updateVerifiedDesk } from "./kv-verified-desk.js";
import { deleteVerified } from "./kv-verified.js";
import { approveTicketKey, filingPromptKey, type KeyedKv, planPostKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { approveTicketKey, filingPromptKey, planPostKey };

/** The plan post just landed at `ts`; a ✅ or ❌ on it is about this ticket. */
export async function recordPlanPost(kv: KeyedKv, post: { channel: string; ts: string; threadTs?: string; issueKey: string; at: Date }): Promise<void> {
  // kv-decide-blind: the key names the ts Slack just gave this post; nothing else writes it.
  await updateVerifiedDesk(kv, planPostKey({ channelId: post.channel, ts: post.ts }), () => ({
    issueKey: post.issueKey,
    ...(post.threadTs === undefined ? {} : { threadTs: post.threadTs }),
    at: post.at.toISOString(),
  }));
  // A new plan is a new decision: the hold an approval of the last plan left
  // pending must not swallow this one's ✅ or `approve KEY`.
  await deleteVerified(kv, approveTicketKey(post.issueKey), (current) => pendingLease(current) !== undefined).catch((error: unknown) => warnKv("reaction-targets.recordPlanPost", error));
}

/** A filing prompt just landed at `ts`, answering `requester` in `threadTs`'s thread. */
/** `before`: in a DM, the tickets already filed there, none of which is this prompt's. `request`: the ts of the request whose triage the prompt shows. */
export async function recordFilingPrompt(kv: KeyedKv, post: { channel: string; ts: string; threadTs?: string; requester: string; at: Date; before?: string[]; request?: string }): Promise<void> {
  // kv-decide-blind: the key names the ts Slack just gave this post; nothing else writes it.
  await updateVerifiedDesk(kv, filingPromptKey({ channelId: post.channel, ts: post.ts }), () => ({
    requester: post.requester,
    ...(post.threadTs === undefined ? {} : { threadTs: post.threadTs }),
    ...(post.before === undefined ? {} : { before: post.before }),
    ...(post.request === undefined ? {} : { request: post.request }),
    at: post.at.toISOString(),
  }));
}

// The prompt's closing ask (intake-triage.ts `FILING_ASK`), mentioned (older
// prompts) or not, or the reaction-only `FILING_ASK_REACTIONS` as a whole
// line among the last three (the model may add a sentence after it).
const FILING_ASK = /`(?:@[\w.-]+ )?approve file`/;
const REACTIONS_ASK = "React ✅ to file or ❌ to drop.";

/** A reply that asks for `approve file` is a filing prompt. */
export function asksToFile(text: string): boolean {
  return FILING_ASK.test(text) || text.trim().split("\n").slice(-3).some((line) => line.trim() === REACTIONS_ASK);
}

// A ticket filed in Jira gets its Slack thread when the desk opens its intake
// root. The root's permalink then goes on the ticket as one comment in the
// same `Slack thread: <permalink>` shape file_ticket writes into a Slack
// filing's description, so the planner's brief (planner/agent/lib/plan.ts
// `slackThreadUrl` reads the description and the comments) and the worker's
// implement PR body (factory-worker/agent/lib/pr-body.ts) link back to it
// the same way. Best effort: a missing link never blocks an announcement.

import type { HostMcpRegistry } from "@cursor/july";
import { addComment, readComments } from "./jira.js";
import { backlinkComment, threadPermalink } from "./slack-link.js";
import { parseThreadRef, ticketKey } from "./threads.js";
import { backlinkKey, type KeyedKv } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { backlinkKey };

export type BacklinkOutcome = "written" | "present" | "not_intake_root" | "no_permalink" | "unavailable" | "failed";

// The planner reads the ticket for this line when it records its plan, before
// the Planned move, so the next announcement is too late to repair a failed
// write for the brief. A planning run takes minutes; these pauses finish in
// seconds of the Triaged line.
export const BACKLINK_RETRY_MS = [500, 2000, 5000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Leave the backlink comment once for a ticket bound to an intake root the
 * desk opened (`root: "jira"`). `backlink/<KEY>` records it; without that
 * record (never written, or a kv error) the ticket's comments are read first
 * and a comment already naming the permalink counts as written, so a retry
 * on a later announcement never comments twice.
 */
export async function ensureIntakeBacklink(input: {
  kv: KeyedKv;
  mcp: HostMcpRegistry;
  client: unknown;
  issueKey: string;
  now: Date;
  retryMs?: readonly number[];
}): Promise<BacklinkOutcome> {
  const { kv, mcp, client, issueKey } = input;
  let ticket: ReturnType<typeof parseThreadRef>;
  try {
    ticket = parseThreadRef(await kv.get(ticketKey(issueKey)));
  } catch (error) {
    warnKv("intake-backlink.ensureIntakeBacklink.get.1", error);
    return "unavailable";
  }
  if (ticket?.root !== "jira" || ticket.threadTs === undefined) return "not_intake_root";
  try {
    const recorded = await kv.get(backlinkKey(issueKey));
    if (recorded !== null && typeof recorded === "object" && !Array.isArray(recorded) && (recorded as Record<string, unknown>)["threadTs"] === ticket.threadTs) return "present";
  } catch (error) {
    warnKv("intake-backlink.ensureIntakeBacklink.get.2", error);
    // Unknown: the comment read below decides.
  }
  const permalink = await threadPermalink(client, ticket);
  if (permalink === undefined) return "no_permalink";
  const record = { channelId: ticket.channelId, threadTs: ticket.threadTs, permalink, at: input.now.toISOString() };
  const pauses = input.retryMs ?? BACKLINK_RETRY_MS;
  let present = false;
  for (let attempt = 0; ; attempt += 1) {
    // Re-read before every attempt: a write that reported an error may have landed.
    const read = await readComments(mcp, issueKey);
    if (read.status === "read") {
      present = read.comments.some((body) => body.includes(permalink));
      if (present) break;
      const written = await addComment(mcp, { issueKey, body: backlinkComment(permalink) });
      if (written.status === "commented") break;
    }
    const pause = pauses[attempt];
    if (pause === undefined) return read.status === "read" ? "failed" : "unavailable";
    await sleep(pause);
  }
  try {
    await kv.put(backlinkKey(issueKey), record);
  } catch (error) {
    warnKv("intake-backlink.ensureIntakeBacklink.put", error);
    // The comment is on the ticket; the next announcement reads it and stops there.
  }
  return present ? "present" : "written";
}

// The thread itself is the last word on what it has already heard. The gate
// claims live in hosted kv, which gives two concurrent wakes neither
// compare-and-set nor each other's fresh writes (TLSSN-38: two identical CI
// posts 0.24 s apart, each wake holding its own claim). Slack is one ordered
// store both wakes can read, so every review update checks it twice: before
// posting, a line the thread already shows for this head is not posted
// again; after posting, a line an earlier desk update for this head already
// carries is taken back out of the new post (the whole post is deleted when
// nothing of its own is left). The earliest post always stands.
//
// A line is matched on its gate and status, not its emoji or link: Slack
// hands back `:building_construction::white_check_mark:` for 🏗️✅.

import { shortSha } from "./review-update.js";

export type ThreadReview = { ts: string; keys: ReadonlySet<string> };

type RepliesClient = { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };
type ThreadMessage = { ts?: unknown; text?: unknown; bot_id?: unknown };

// A head's review updates land within hours of its push.
const LOOKBACK_S = 6 * 60 * 60;
const PAGE = 200;

/** `Bugbot — clean` for `🐛✅ Bugbot — clean · <url|Bugbot run>` (or its `:bug::white_check_mark:` form). */
export function reviewLineKey(line: string): string | undefined {
  const body = line
    .replace(/^\s*(?:\u2022|&bull;)\s*/, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
  const gate = body.replace(/^\S+\s+/, "");
  const dash = gate.indexOf(" \u2014 ");
  if (dash <= 0) return undefined;
  const link = gate.indexOf(" \u00b7 ", dash);
  return (link === -1 ? gate : gate.slice(0, link)).replace(/\s+/g, " ").trim();
}

/**
 * The desk's review updates for this head in the thread, oldest first.
 * Undefined when the thread cannot be read (no `apiCall`, no history scope,
 * Slack down): the caller then relies on its claims alone.
 */
export async function threadReviews(client: unknown, input: { channel: string; threadTs: string | undefined; headSha: string; now: Date }): Promise<ThreadReview[] | undefined> {
  const api = client as Partial<RepliesClient>;
  if (input.threadTs === undefined || typeof api.apiCall !== "function") return undefined;
  const header = `review update on \`${shortSha(input.headSha)}\`:`;
  try {
    const oldest = (Math.floor(input.now.getTime() / 1000) - LOOKBACK_S).toString();
    const answer = (await api.apiCall("conversations.replies", { channel: input.channel, ts: input.threadTs, oldest, limit: PAGE })) as { messages?: unknown };
    const messages = (Array.isArray(answer?.messages) ? answer.messages : []) as ThreadMessage[];
    const found: ThreadReview[] = [];
    for (const message of messages) {
      if (typeof message.bot_id !== "string" || typeof message.ts !== "string" || typeof message.text !== "string" || message.ts === input.threadTs) continue;
      const [first, ...rest] = message.text.split("\n");
      if (first === undefined || !first.trim().endsWith(header)) continue;
      const keys = new Set(rest.map(reviewLineKey).filter((key): key is string => key !== undefined));
      if (keys.size > 0) found.push({ ts: message.ts, keys });
    }
    return found.sort((a, b) => Number(a.ts) - Number(b.ts));
  } catch {
    return undefined;
  }
}

/** The earliest update (posted before `beforeTs`, when given) that already carries `line`. */
export function carriedBy(reviews: readonly ThreadReview[] | undefined, query: { line: string; beforeTs?: string }): ThreadReview | undefined {
  const { line, beforeTs } = query;
  const key = reviewLineKey(line);
  if (reviews === undefined || key === undefined) return undefined;
  return reviews.find((review) => review.keys.has(key) && (beforeTs === undefined || Number(review.ts) < Number(beforeTs)));
}

import { refusesProductionTarget } from "./factory-stage.js";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@cursor/july";
import { finishLease, pendingLease, releaseLease, takeLease } from "./claim-lease.js";
import { intakeChannel } from "./desk-channels.js";
import { deleteVerified, sameJson } from "./kv-verified.js";
import { updateVerifiedDesk } from "./kv-verified-desk.js";
import { jiraSiteUrl, rootPost, ticketUrl, type Block } from "./plan-post.js";
import { setStatusReaction, type ReactionOutcome, type StatusStage } from "./status-reaction.js";
import { recordThreadTicket } from "./thread-tickets.js";
import {
  announcedKey,
  isSlackTs,
  parseThreadRef,
  postTarget,
  rootStatus,
  sameRootStatus,
  supersedes,
  ticketKey,
  type PostTarget,
  type RootStatus,
  type TicketThread,
} from "./threads.js";
import type { KeyedKv, KvKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export type TicketPost = { ticket?: TicketThread; target?: PostTarget };

/**
 * Where a ticket's next post goes. A kv read error throws: an unreadable
 * binding must fail the update, never look unbound and open an intake root.
 * Every ticket-thread post (announce, review update, crumb) resolves its
 * channel here, so on a staging slug a binding to a production channel
 * counts as none (factory-stage.ts).
 */
export async function ticketPost(kv: KeyedKv, issueKey: string, env: NodeJS.ProcessEnv = process.env): Promise<TicketPost> {
  const bound = parseThreadRef(await kv.get(ticketKey(issueKey)));
  const ticket = bound !== undefined && refusesProductionTarget(env, { kind: "slackChannels", value: bound.channelId }) ? undefined : bound;
  const target = postTarget(ticket, intakeChannel(env));
  return { ...(ticket === undefined ? {} : { ticket }), ...(target === undefined ? {} : { target }) };
}

type PostArgs = { channel: string; text: string; blocks?: Block[]; thread_ts?: string };
type UpdateArgs = { channel: string; ts: string; text: string; blocks?: Block[] };

export type SlackPoster = {
  chat: {
    postMessage(args: PostArgs): Promise<{ ts?: unknown }>;
    update?(args: UpdateArgs): Promise<unknown>;
    delete?(args: { channel: string; ts: string }): Promise<unknown>;
  };
};

// Slack posts and their bookkeeping finish in seconds; two minutes leaves
// room for Slack's own retries before a redelivery may post again.
export const ANNOUNCE_LEASE_MS = 120_000;
// The intake root's claim covers one root post and its binding write, whose
// kv backoff (BINDING_RETRY_MS) pauses 3.85 s at most: finishLease's loop
// owns those pauses, so kv-verified's own retries add none. An opener slower
// than this loses its claim to the next update, finds its binding refused,
// and deletes its own root; the next update's root is the one bound.
export const ROOT_LEASE_MS = 30_000;
const ROOT_WAIT_MS = 250;
// A pre-lease placeholder (`pendingRoot`, before claim leases) is taken
// over after this long, as it was when it was written.
const LEGACY_PLACEHOLDER_TTL_MS = 60_000;
export const BINDING_RETRY_MS: readonly number[] = [100, 250, 500, 1000, 2000];
const ROOT_STATUS_PASSES = 3;

type RootInput = { kv: KeyedKv; client: SlackPoster; issueKey: string; channel: string; root: { text: string; blocks: Block[] }; shown: RootStatus; at: string; env: NodeJS.ProcessEnv };
type Acquired = { ticket: TicketThread } | { claimed: true };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open the intake root for an unbound ticket. The binding is claimed as a
 * lease (claim-lease.ts) before the root is posted, so a second update
 * waits for that root instead of posting its own, and takes the claim over
 * only once its lease has expired. A binding that replaced the claim
 * meanwhile (a Slack filing) wins, and the orphan root is deleted. An
 * update that loses its claim twice, or cannot write its binding, throws;
 * the caller releases the announce claim.
 */
async function openRoot(input: RootInput): Promise<{ ticket: TicketThread; openedRoot: boolean }> {
  const { kv, client, issueKey, channel, root, shown, at } = input;
  const key = ticketKey(issueKey);
  const owner = randomUUID();
  const ours = (current: unknown) => pendingLease(current)?.owner === owner;
  const deleteRoot = async (ts: string) => {
    try {
      await client.chat.delete?.({ channel, ts });
    } catch {
      // Best effort; a root with no binding says nothing is in its thread yet.
    }
  };
  for (let round = 0; round < 2; round += 1) {
    const acquired = await acquireRoot(input, owner);
    if ("ticket" in acquired) return { ticket: acquired.ticket, openedRoot: false };
    let ts: string;
    try {
      const opened = await client.chat.postMessage({ channel, text: root.text, blocks: root.blocks });
      ts = typeof opened.ts === "string" ? opened.ts : "";
      if (!isSlackTs(ts)) throw new Error(`the intake root for ${issueKey} came back without a ts`);
    } catch (error) {
      await releaseLease(kv, key, owner);
      throw error;
    }
    const boundHere = (current: unknown) => parseThreadRef(current)?.threadTs === ts;
    const bound = await bindRoot(kv, key, { owner, boundHere }, { channelId: channel, threadTs: ts, root: "jira", boundAt: at, rootStatus: shown });
    const ticket: TicketThread = { channelId: channel, threadTs: ts, root: "jira", rootStatus: shown };
    if (bound === "bound") return { ticket, openedRoot: true };
    // A failed write may still have landed. Only a successful read that
    // shows some other value proves the root is unbound and safe to delete.
    let current: unknown;
    try {
      current = await kv.get(key);
    } catch {
      throw new Error(`the intake root for ${issueKey} may be bound as its thread, but the binding cannot be read; the root is kept`);
    }
    if (boundHere(current)) return { ticket, openedRoot: true };
    await deleteRoot(ts);
    if (bound === "failed") {
      if (ours(current)) await releaseLease(kv, key, owner);
      throw new Error(`the intake root for ${issueKey} could not be bound as its thread`);
    }
  }
  throw new Error(`the intake root for ${issueKey} kept losing its claim`);
}

/**
 * Finish the claim with the binding while the key still holds our pending
 * claim, verified after write, re-reading before every attempt so a retry
 * never overwrites a binding that landed meanwhile. A key that already
 * binds this root (a put that landed but reported an error) no longer holds
 * the claim, so it is left as it is and counts as bound: an update may have
 * recorded a newer root status on it since. kv errors back off for
 * BINDING_RETRY_MS, 3.85 s of pauses in all.
 */
async function bindRoot(
  kv: KeyedKv,
  key: KvKey,
  holds: { owner: string; boundHere: (current: unknown) => boolean },
  binding: JsonValue
): Promise<"bound" | "lost" | "failed"> {
  const result = await finishLease(kv, key, holds.owner, { value: binding, pausesMs: BINDING_RETRY_MS });
  if (result.status === "finished") return "bound";
  if (result.status === "lost") return holds.boundHere(result.current) ? "bound" : "lost";
  return "failed";
}

/**
 * Take the root claim, or wait for the root another update holds it for.
 * A live claim is never taken over: the wait lasts until that claim's lease
 * expires, when the next take succeeds. An unverifiable claim is released
 * (or left to expire) and throws.
 */
async function acquireRoot(input: RootInput, owner: string): Promise<Acquired> {
  const { kv, issueKey, channel, env } = input;
  const key = ticketKey(issueKey);
  const giveUpAt = Date.now() + ROOT_LEASE_MS + 10 * ROOT_WAIT_MS;
  for (;;) {
    const taken = await takeLease(kv, key, { owner, leaseMs: ROOT_LEASE_MS, now: new Date(), fields: { channelId: channel, root: "jira" } });
    if (taken.status === "taken") return { claimed: true };
    if (taken.status === "unavailable") {
      await releaseLease(kv, key, owner);
      throw new Error(`the intake root for ${issueKey} could not be claimed`);
    }
    if (taken.status === "done") {
      const ticket = parseThreadRef(taken.current);
      if (ticket !== undefined && postTarget(ticket, intakeChannel(env)) !== undefined) return { ticket };
      const legacy = legacyPlaceholder(taken.current);
      if (legacy === undefined) throw new Error(`the intake root for ${issueKey} could not be claimed`);
      if (legacy.abandoned) await deleteVerified(kv, key, (current) => sameJson(current, taken.current));
    }
    if (Date.now() > giveUpAt) throw new Error(`the intake root for ${issueKey} could not be claimed`);
    await sleep(ROOT_WAIT_MS);
  }
}

function legacyPlaceholder(value: unknown): { abandoned: boolean } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["pendingRoot"] !== "string") return undefined;
  const since = typeof record["pendingSince"] === "string" ? record["pendingSince"] : record["boundAt"];
  const age = Date.now() - Date.parse(typeof since === "string" ? since : "");
  return { abandoned: !Number.isFinite(age) || age > LEGACY_PLACEHOLDER_TTL_MS };
}

export type TicketUpdate = {
  issueKey: string;
  /** Headline for a root this update opens. */
  title: string;
  /** Jira status shown on the root. */
  status: string;
  /** Changelog id of the transition into `status`; orders root status edits. */
  changelogId?: string;
  text: string;
  blocks?: Block[];
  /** Builds the reply from the binding it lands under, which may only be known after a raced root. Overrides text and blocks. */
  render?: (ticket: TicketThread | undefined) => { text: string; blocks?: Block[] };
  /** A comment outcome is not a transition: it replies only in a thread the ticket already has, and never opens an intake root or rewrites its status line. */
  threadOnly?: true;
  /** With `threadOnly`: a ticket with no thread yet still gets its intake root, so a Jira-filed ticket hears an early stop. An existing root's status line is still never rewritten. */
  opensRoot?: true;
  /** A short desk reply this update supersedes: the latest desk message in the thread, recent and matching, is edited into this update instead of a new post. */
  replaces?: RegExp;
};

type ThreadMessage = { ts?: unknown; text?: unknown; bot_id?: unknown };
type RepliesClient = { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };

// Long enough to cover an approve and the worker's launch; short enough that
// an old line from an earlier attempt is never rewritten.
const REPLACE_WINDOW_S = 15 * 60;
const REPLACE_MAX_CHARS = 160;

/**
 * The desk's newest message in the thread, when it is a short line matching
 * `pattern` from the last fifteen minutes. Any doubt (no history access, a
 * later desk message, a person's message, a longer reply) returns undefined
 * and the caller posts as usual.
 */
async function supersededReply(client: SlackPoster, channel: string, threadTs: string, pattern: RegExp, now: Date): Promise<string | undefined> {
  const api = client as unknown as Partial<RepliesClient>;
  if (typeof api.apiCall !== "function" || client.chat.update === undefined) return undefined;
  try {
    const oldest = (Math.floor(now.getTime() / 1000) - REPLACE_WINDOW_S).toString();
    const answer = (await api.apiCall("conversations.replies", { channel, ts: threadTs, oldest, limit: 50 })) as { messages?: unknown };
    const messages = (Array.isArray(answer?.messages) ? answer.messages : []) as ThreadMessage[];
    const latestBot = messages.filter((message) => message.ts !== threadTs).at(-1);
    if (latestBot === undefined || typeof latestBot.bot_id !== "string" || typeof latestBot.ts !== "string" || typeof latestBot.text !== "string") return undefined;
    if (latestBot.text.length > REPLACE_MAX_CHARS || !pattern.test(latestBot.text.trim())) return undefined;
    return isSlackTs(latestBot.ts) && Number(latestBot.ts) >= Number(oldest) ? latestBot.ts : undefined;
  } catch {
    return undefined;
  }
}

export type TicketUpdateOutcome =
  | { posted: false }
  | { posted: true; ticket?: TicketThread; channel: string; threadTs?: string; ts: string; openedRoot: boolean; replacedReply?: true; rootStatusUpdated?: boolean; rootStatusSuperseded?: true };

/**
 * Post one update into a ticket's thread. A ticket with no thread gets a
 * short root in the intake channel first, bound as its thread, and the
 * update is the first reply. An intake root this update did not open itself
 * (including one it waited for) has its status line rewritten unless it
 * already shows a later transition; that edit is best-effort and never
 * blocks the reply. A failed reply throws and never falls back to a
 * top-level post.
 */
export async function postTicketUpdate(input: { kv: KeyedKv; client: SlackPoster; update: TicketUpdate; at: string; env?: NodeJS.ProcessEnv }): Promise<TicketUpdateOutcome> {
  const { kv, client, update, at, env = process.env } = input;
  const first = await ticketPost(kv, update.issueKey, env);
  if (first.target === undefined) return { posted: false };
  const rootFor = (status: string) => rootPost({ issueKey: update.issueKey, title: update.title, status, ...withUrl(update, env) });
  const shown = rootStatus({ status: update.status, ...(update.changelogId === undefined ? {} : { changelogId: update.changelogId }) }, env);
  let ticket = first.ticket;
  let openedRoot = false;
  let rootEdit: RootEdit | undefined;
  if (first.target.root) {
    if (update.threadOnly === true && update.opensRoot !== true) return { posted: false };
    ({ ticket, openedRoot } = await openRoot({ kv, client, issueKey: update.issueKey, channel: first.target.channel, root: rootFor(update.status), shown, at, env }));
  }
  if (!openedRoot && update.threadOnly !== true && ticket?.root === "jira" && ticket.threadTs !== undefined && client.chat.update !== undefined) {
    rootEdit = await raiseRootStatus({ kv, client, key: ticketKey(update.issueKey), channel: ticket.channelId, threadTs: ticket.threadTs, mine: shown, render: rootFor });
  }
  if (ticket !== undefined) await recordThreadTicket(kv, ticket, update.issueKey);
  const channel = ticket?.channelId ?? first.target.channel;
  const threadTs = ticket?.threadTs;
  const body = update.render?.(ticket) ?? { text: update.text, ...(update.blocks === undefined ? {} : { blocks: update.blocks }) };
  const superseded = update.replaces === undefined || openedRoot || threadTs === undefined ? undefined : await supersededReply(client, channel, threadTs, update.replaces, new Date(at));
  if (superseded !== undefined) {
    try {
      await client.chat.update!({ channel, ts: superseded, text: body.text, ...(body.blocks === undefined ? {} : { blocks: body.blocks }) });
      return {
        posted: true,
        ...(ticket === undefined ? {} : { ticket }),
        channel,
        threadTs: threadTs!,
        ts: superseded,
        openedRoot,
        replacedReply: true,
        ...(rootEdit === undefined ? {} : { rootStatusUpdated: rootEdit === "updated" }),
        ...(rootEdit === "superseded" ? { rootStatusSuperseded: true as const } : {}),
      };
    } catch {
      // The edit was refused (not our message, or too old to edit); post instead.
    }
  }
  const reply = await client.chat.postMessage({
    channel,
    text: body.text,
    ...(body.blocks === undefined ? {} : { blocks: body.blocks }),
    ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
  });
  return {
    posted: true,
    ...(ticket === undefined ? {} : { ticket }),
    channel,
    ...(threadTs === undefined ? {} : { threadTs }),
    ts: typeof reply.ts === "string" ? reply.ts : "",
    openedRoot,
    ...(rootEdit === undefined ? {} : { rootStatusUpdated: rootEdit === "updated" }),
    ...(rootEdit === "superseded" ? { rootStatusSuperseded: true as const } : {}),
  };
}

type RootEdit = "updated" | "superseded" | "failed";

/**
 * Rewrite a Jira root's status line only when this update supersedes what
 * it shows. The status is recorded in the binding before the edit, so an
 * older update that finishes later reads it and leaves the root alone. The
 * binding is re-read after the edit: a newer status recorded meanwhile may
 * have been edited in before this edit landed, so it is put back, and a
 * record of ours that an older put overwrote after its own verify (the kv
 * is read then write) is written again.
 */
async function raiseRootStatus(input: {
  kv: KeyedKv;
  client: SlackPoster;
  key: KvKey;
  channel: string;
  threadTs: string;
  mine: RootStatus;
  render: (status: string) => { text: string; blocks: Block[] };
}): Promise<RootEdit> {
  const { kv, client, key, channel, threadTs, mine, render } = input;
  const onThisRoot = (current: unknown) => {
    const bound = parseThreadRef(current);
    return bound?.root === "jira" && bound.threadTs === threadTs ? bound : undefined;
  };
  const record = async (status: RootStatus): Promise<"written" | "superseded" | "failed"> => {
    const result = await updateVerifiedDesk(kv, key, (current) => {
      const bound = onThisRoot(current);
      if (bound === undefined || !supersedes(status, bound.rootStatus)) return undefined;
      return { ...(current as Record<string, JsonValue>), rootStatus: status };
    });
    return result.status === "written" ? "written" : result.status === "lost" ? "superseded" : "failed";
  };
  const edit = async (status: RootStatus) => {
    const body = render(status.status);
    await client.chat.update!({ channel, ts: threadTs, text: body.text, blocks: body.blocks });
  };
  const recorded = await record(mine);
  if (recorded !== "written") return recorded;
  try {
    await edit(mine);
  } catch {
    return "failed";
  }
  let shown = mine;
  for (let pass = 0; pass < ROOT_STATUS_PASSES; pass += 1) {
    let stored: RootStatus | undefined;
    try {
      stored = onThisRoot(await kv.get(key))?.rootStatus;
    } catch (error) {
      warnKv("ticket-thread.raiseRootStatus", error);
      break;
    }
    if (sameRootStatus(stored, shown)) break;
    if (stored !== undefined && supersedes(stored, shown)) {
      try {
        await edit(stored);
      } catch {
        break;
      }
      shown = stored;
    } else if ((await record(shown)) !== "written") {
      break;
    }
  }
  return sameRootStatus(shown, mine) ? "updated" : "superseded";
}

export type AnnounceContext = { host: { kv: KeyedKv; slack: { getClient(): Promise<unknown> } }; now(): Date };

/**
 * A status update claimed once per transition as a lease (claim-lease.ts),
 * then posted with postTicketUpdate. The post is at-least-once: a claim
 * that cannot be verified, or a post whose claim cannot be marked done,
 * stays pending until ANNOUNCE_LEASE_MS passes, and a redelivery after that
 * posts again. A rare duplicate is accepted over a transition that is never
 * announced. An unreadable or unverifiable claim does not post: a failed
 * read must not look like "never announced". `prepare` runs only once the
 * claim is held, so a redelivery costs no Jira read. A post that throws, or
 * finds nowhere to go, drops the claim (only while it is still this
 * delivery's) so a redelivery can post.
 */
export async function announceTicketUpdate(
  ctx: AnnounceContext,
  input: {
    changelogId: string;
    /** Overrides the default per-transition claim. Planned dumps pass a sticky per-status key. */
    claimKey?: KvKey;
    /** Re-read the claim this long after taking it (claim-lease.ts); for claims that concurrent deliveries share. */
    settleMs?: number;
    update: TicketUpdate;
    record: Record<string, string>;
    /** The status reaction the filer's message shows once this update is posted (status-reaction.ts). `prepare` may override it. */
    reaction?: StatusStage;
    prepare?: () => Promise<{ update?: Partial<TicketUpdate>; result?: Record<string, string>; reaction?: StatusStage }>;
    /** Runs once the post landed and its claim is done, with where it landed. Best effort: a throw is swallowed. */
    posted?: (post: { channel: string; ts: string; threadTs?: string }) => Promise<void>;
  }
) {
  const issueKey = input.update.issueKey;
  const kv = ctx.host.kv;
  const { target } = await ticketPost(kv, issueKey);
  if (target === undefined) return { posted: false, reason: "no_thread_and_no_intake_channel", issueKey };
  const key = input.claimKey ?? announcedKey({ issueKey, status: input.update.status, changelogId: input.changelogId });
  const owner = randomUUID();
  const claim = await takeLease(kv, key, {
    owner,
    leaseMs: ANNOUNCE_LEASE_MS,
    now: ctx.now(),
    fields: { ...input.record, channel: target.channel },
    ...(input.settleMs === undefined ? {} : { settleMs: input.settleMs }),
  });
  if (claim.status === "done") return { posted: false, reason: "already_announced", issueKey };
  if (claim.status === "held") return { posted: false, reason: "announce_in_progress", issueKey };
  if (claim.status === "unavailable") {
    // The claim may have landed; released here or expired later, it never blocks a redelivery.
    await releaseLease(kv, key, owner);
    return { posted: false, reason: "failed", issueKey };
  }
  let outcome: TicketUpdateOutcome;
  let extra: Record<string, string> = {};
  let client: SlackPoster;
  let stage = input.reaction;
  try {
    const prepared = (await input.prepare?.()) ?? {};
    extra = prepared.result ?? {};
    stage = prepared.reaction ?? stage;
    client = (await ctx.host.slack.getClient()) as SlackPoster;
    outcome = await postTicketUpdate({ kv, client, update: { ...input.update, ...prepared.update, changelogId: input.changelogId }, at: claim.at });
  } catch (error) {
    await releaseLease(kv, key, owner);
    throw error;
  }
  if (!outcome.posted) {
    await releaseLease(kv, key, owner);
    return { posted: false, reason: "no_thread_and_no_intake_channel", issueKey };
  }
  const done = outcome;
  await finishLease(kv, key, owner, { fields: { channel: done.channel, ts: done.ts } });
  if (input.posted !== undefined && isSlackTs(done.ts)) {
    try {
      await input.posted({ channel: done.channel, ts: done.ts, ...(done.threadTs === undefined ? {} : { threadTs: done.threadTs }) });
    } catch {
      // Only bookkeeping for the post; the announce still counts.
    }
  }
  let reaction: ReactionOutcome | undefined;
  if (stage !== undefined) {
    try {
      reaction = await setStatusReaction({ kv, client, issueKey, ticket: done.ticket, stage, changelogId: input.changelogId });
    } catch {
      reaction = "failed";
    }
  }
  const shownReaction = reaction === undefined || reaction === "no_client" || reaction === "no_target" ? {} : { reaction };
  return {
    posted: true,
    reason: done.openedRoot ? "opened_intake_thread" : done.replacedReply === true ? "replaced_reply_in_thread" : "posted_in_thread",
    issueKey,
    channel: done.channel,
    inThread: done.threadTs !== undefined,
    ...extra,
    ...shownReaction,
    ...(done.openedRoot && done.threadTs !== undefined ? { rootTs: done.threadTs } : {}),
    ...(done.rootStatusUpdated === undefined ? {} : { rootStatusUpdated: done.rootStatusUpdated }),
    ...(done.rootStatusSuperseded === undefined ? {} : { rootStatusSuperseded: true }),
  };
}

function withUrl(update: TicketUpdate, env: NodeJS.ProcessEnv): { ticketUrl?: string } {
  const url = ticketUrl({ issueKey: update.issueKey, site: jiraSiteUrl(env) });
  return url === undefined ? {} : { ticketUrl: url };
}

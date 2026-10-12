import { randomUUID } from "node:crypto";
import type { HostMcpRegistry, JsonValue } from "@cursor/july";
import { finishLease, leaseExpired, pendingLease, releaseLease, takeLease } from "./claim-lease.js";
import { claimSettleMs, jiraProjects, recheckLeaseOn, statusNames } from "./config.js";
import { readRetrying, sameJson, updateVerified } from "./kv-verified.js";
import { readComments } from "./jira.js";
import {
  COMPONENT_ORDER,
  changeMonitorClaimKey,
  changeMonitorMessageKey,
  changeMonitorPendingKey,
  failedCiRuns,
  isBotPush,
  ownsCiAnnouncement,
  reviewClaimKey,
  renderReviewUpdate,
  reviewMessageKey,
  reviewPrKey,
  reviewUpdateLines,
  securityAnnouncedKey,
  securityClaimKey,
  settledComponents,
  type CheckRunFacts,
  type ReviewComponent,
  type ReviewEvidence,
  type CommentFacts,
  type ReviewFacts,
  type Settled,
  type SuiteFacts,
  type WorkflowFacts,
} from "./review-update.js";
import { latestPullRequestComment } from "./status-event.js";
import { clearLoader, loaderKey, parseLoader, postLoader, readReviewGates, writeReviewGates, type ReviewGate } from "./loader.js";
import { carriedBy, threadReviews } from "./review-thread.js";
import { ANNOUNCE_LEASE_MS, postTicketUpdate, ticketPost, type SlackPoster } from "./ticket-thread.js";
import { type KeyedKv, type KvKey, reviewRecheckKey } from "./kv-keys.js";
import { warnKv, warnStep } from "./ops-funnel.js";

// Review updates: when a factory PR's quality gates settle, the ticket's
// Slack thread hears it. Host code only, called from the read-only GitHub
// channel; no model turn sees or posts one. Every fact is re-read from
// GitHub at the PR's current head, never taken from the wake.

export type PullFacts = {
  number: number;
  state: string;
  merged: boolean;
  headSha: string;
  headRef: string;
  title: string;
  authorLogin?: string;
};

/** GitHub reads, through the channel's read-only credential. */
export type ReviewReader = {
  pull(number: number): Promise<PullFacts>;
  /** Undefined when the token cannot read check runs; the wake stands in. */
  checkRuns(sha: string): Promise<CheckRunFacts[] | undefined>;
  reviews(number: number): Promise<ReviewFacts[]>;
  /** PR conversation comments; undefined when they cannot be read. */
  comments?(number: number): Promise<CommentFacts[] | undefined>;
};

export type ReviewWake =
  | { kind: "pull_request"; action: string; before?: string; sender?: { login?: string; type?: string } }
  | { kind: "check_suite"; suite: SuiteFacts }
  | { kind: "workflow_run"; workflow: WorkflowFacts }
  | { kind: "review" };

export type ReviewDeps = {
  kv: KeyedKv;
  slack: { getClient(): Promise<unknown> };
  mcp: HostMcpRegistry;
  github: ReviewReader;
  env: NodeJS.ProcessEnv;
  now(): Date;
};

export type ReviewUpdateResult = {
  posted: boolean;
  reason:
    | "posted_in_thread"
    | "updated_in_thread"
    | "pr_not_open"
    | "not_factory_pr"
    | "no_thread"
    | "other_pull_request"
    | "nothing_settled"
    | "already_announced"
    | "deferred"
    | "failed";
  pr: string;
  issueKey?: string;
  components?: ReviewComponent[];
  /** Gates not yet settled on the head (never autofix). */
  pending?: ReviewGate[];
  headSha?: string;
  /** Change-monitor's state on the head, heard before or not. */
  changeReview?: Extract<Settled, { component: "changeMonitor" }>["verdict"];
  /** CI settled, unannounced, and this wake does not own it (`ownsCiAnnouncement`). */
  ciDeferred?: true;
};

const SHA = /^[0-9a-f]{40}$/i;

/**
 * Post, into the ticket's thread, every gate that settled on the PR's head
 * and has not been posted for that head yet, as one reply. Posted only into
 * a thread the ticket already has: a review update never opens an intake
 * root or rewrites its status line. Claimed per PR, head, and gate (the
 * security review per PR and verdict fingerprint, so an unchanged verdict on
 * a new head is not news) before
 * the post and released if it fails, the way the lifecycle posts are
 * (ticket-thread.ts `announceTicketUpdate`), so the post is at-least-once.
 */
export async function announceReviewUpdate(input: { repository: string; number: number; wake: ReviewWake }, deps: ReviewDeps): Promise<ReviewUpdateResult> {
  const label = `${input.repository}#${input.number}`;
  const pull = await deps.github.pull(input.number);
  const issueKey = reviewPrKey({ headRef: pull.headRef, title: pull.title, ...(pull.authorLogin === undefined ? {} : { authorLogin: pull.authorLogin }), projects: jiraProjects(deps.env) });
  if (pull.state !== "open" || pull.merged) {
    if (issueKey !== undefined) await syncReviewLoader(deps, issueKey, [], { closed: true });
    return { posted: false, reason: "pr_not_open", pr: label };
  }
  if (issueKey === undefined) return { posted: false, reason: "not_factory_pr", pr: label };
  const { ticket } = await ticketPost(deps.kv, issueKey, deps.env);
  if (ticket === undefined) return { posted: false, reason: "no_thread", pr: label, issueKey };
  const result = await announceSettled(input, deps, { label, pull, issueKey, channel: ticket.channelId, ...(ticket.threadTs === undefined ? {} : { threadTs: ticket.threadTs }) });
  if (result.reason !== "other_pull_request") await syncReviewLoader(deps, issueKey, result.pending ?? []);
  return result;
}

/**
 * Keep the `reviewing` crumb in step with the gates still running: rewrite it
 * to name them, or drop it once none are left. A missing crumb is posted
 * only after the In Review line landed (a new push re-running the gates); an
 * earlier phase's crumb is left for its own announce to clear. Best effort,
 * like every other loader.
 */
async function syncReviewLoader(deps: ReviewDeps, issueKey: string, pending: readonly ReviewGate[], options: { closed?: boolean } = {}): Promise<void> {
  const { inReview } = await readReviewGates(deps.kv, issueKey);
  await writeReviewGates(deps.kv, issueKey, { pending: [...pending], ...(options.closed === true ? { inReview: false } : {}) });
  // The review line (if any) landed; a stale crumb is fixed on the next wake.
  let shown: ReturnType<typeof parseLoader>;
  try {
    shown = parseLoader(await deps.kv.get(loaderKey(issueKey)));
  } catch (error) {
    warnKv("review-announce.syncReviewLoader", error);
    return;
  }
  if (shown !== undefined && shown.phase !== "reviewing") return;
  if (shown === undefined && (pending.length === 0 || inReview !== true || options.closed === true)) return;
  try {
    const client = await deps.slack.getClient();
    if (pending.length === 0) await clearLoader({ kv: deps.kv, client, issueKey });
    else await postLoader({ kv: deps.kv, client, issueKey, phase: "reviewing", pending });
  } catch (error) {
    warnStep("review-announce.syncReviewLoader.crumb", error);
  }
}

async function announceSettled(
  input: { repository: string; number: number; wake: ReviewWake },
  deps: ReviewDeps,
  ctx: { label: string; pull: PullFacts; issueKey: string; channel: string; threadTs?: string }
): Promise<ReviewUpdateResult> {
  const { label, pull, issueKey } = ctx;
  const ticket = { channelId: ctx.channel };

  const evidence = await gather(input, pull, deps.github);
  const settled = settledComponents(evidence);
  const pending = (["bugbot", "security", "ci"] as const).filter((component) => !settled.some((item) => item.component === component));
  const pr = { repository: input.repository, number: input.number };
  const headClaim = (component: ReviewComponent) => reviewClaimKey({ ...pr, headSha: pull.headSha, component });
  const lastSecurity = settled.some((item) => item.component === "security") ? await readAnnouncedSecurity(deps.kv, securityAnnouncedKey(pr)) : undefined;
  const head = { ...pr, headSha: pull.headSha };
  const claimFor = (item: Settled) =>
    item.component === "security"
      ? securityClaimKey({ ...pr, fingerprint: item.fingerprint, ...(lastSecurity === undefined ? {} : { after: lastSecurity.headSha }) })
      : item.component === "changeMonitor"
        ? changeMonitorClaimKey({ ...head, verdict: item.verdict })
        : headClaim(item.component);
  const fresh: Settled[] = [];
  for (const item of settled) {
    if (item.component === "security") {
      if (lastSecurity?.fingerprint === item.fingerprint) continue;
      // A head announced under the per-head security claim, before the fingerprint record existed.
      if (lastSecurity === undefined && (await claimedDone(deps.kv, headClaim("security")))) continue;
    }
    if (!(await claimedDone(deps.kv, claimFor(item)))) fresh.push(item);
  }
  const changeReview = settled.find((item): item is Extract<Settled, { component: "changeMonitor" }> => item.component === "changeMonitor")?.verdict;
  const now = deps.now();
  const ciDeferred = fresh.some((item) => item.component === "ci") && !ownsCiAnnouncement(evidence, now);
  const due = ciDeferred ? fresh.filter((item) => item.component !== "ci") : fresh;
  const base = { pr: label, issueKey, headSha: pull.headSha, pending: [...pending], ...(changeReview === undefined ? {} : { changeReview }), ...(ciDeferred ? { ciDeferred: true as const } : {}) };
  if (settled.length === 0) return { posted: false, reason: "nothing_settled", ...base };
  if (fresh.length === 0) return { posted: false, reason: "already_announced", ...base };
  if (due.length === 0) return { posted: false, reason: "deferred", ...base };
  if (await linksAnotherPullRequest(deps.mcp, issueKey, label)) return { posted: false, reason: "other_pull_request", ...base };

  const owner = randomUUID();
  // The claims settle (claim-lease.ts) before they count. On hosted kv two
  // concurrent wakes can each read back their own claim, so the claim is not
  // the only guard: CI has one owning wake, and the thread is read before and
  // after the post (review-thread.ts).
  const settleMs = claimSettleMs(deps.env);
  const claims = await Promise.all(
    due.map(async (item) => {
      const key = claimFor(item);
      const claim = await takeLease(deps.kv, key, { owner, leaseMs: ANNOUNCE_LEASE_MS, now, fields: { issueKey, channel: ticket.channelId }, settleMs });
      if (claim.status === "unavailable") await releaseLease(deps.kv, key, owner);
      return claim.status === "taken";
    })
  );
  const claimed = due.filter((_, index) => claims[index]);
  if (claimed.length === 0) return { posted: false, reason: "already_announced", ...base };
  const lineOf = (item: Settled) => reviewUpdateLines({ ...head, settled: [item] })[0]!;
  const client = (await deps.slack.getClient()) as SlackPoster;
  const where = { channel: ticket.channelId, threadTs: ctx.threadTs, headSha: pull.headSha, now };

  // A line the thread already shows for this head is done, whatever the claims say.
  const seen = await threadReviews(client, where);
  const heard: Settled[] = [];
  const held: Settled[] = [];
  for (const item of claimed) {
    const by = carriedBy(seen, { line: lineOf(item) });
    if (by === undefined) held.push(item);
    else {
      heard.push(item);
      await finishLease(deps.kv, claimFor(item), owner, { fields: { ts: by.ts } });
    }
  }
  if (held.length === 0) {
    await recordSecurity(deps.kv, pr, heard, pull.headSha, now);
    return { posted: false, reason: "already_announced", ...base };
  }

  // Each later change-monitor state edits the 📡 line already in the thread
  // (running → plan ready → needs attention), and a running line that is the
  // only news joins the head's latest update, so none adds a post of its own.
  const edited: Settled[] = [];
  const toPost: Settled[] = [];
  for (const item of held) {
    const into =
      item.component !== "changeMonitor"
        ? undefined
        : item.verdict !== "pending"
          ? ((await readReviewMessage(deps.kv, changeMonitorMessageKey(head))) ?? (await readReviewMessage(deps.kv, changeMonitorPendingKey(head))))
          : held.length === 1
            ? await readReviewMessage(deps.kv, reviewMessageKey(head))
            : undefined;
    if (into !== undefined && (await editReviewMessage(deps, client, { issueKey, headSha: pull.headSha, into, line: lineOf(item), key: claimFor(item), owner, head }))) edited.push(item);
    else toPost.push(item);
  }
  let ts: string | undefined;
  if (toPost.length > 0) {
    const release = () => Promise.all(toPost.map((item) => releaseLease(deps.kv, claimFor(item), owner)));
    const lines = toPost.sort((a, b) => COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component)).map(lineOf);
    let outcome: Awaited<ReturnType<typeof postTicketUpdate>>;
    try {
      outcome = await postTicketUpdate({
        kv: deps.kv,
        client,
        update: { issueKey, title: issueKey, status: statusNames(deps.env).inReview, text: renderReviewUpdate({ issueKey, headSha: pull.headSha, lines }), threadOnly: true },
        at: now.toISOString(),
        env: deps.env,
      });
    } catch (error) {
      await release();
      throw error;
    }
    if (!outcome.posted) {
      await release();
      if (edited.length === 0) return { posted: false, reason: "no_thread", ...base };
    } else {
      // A concurrent wake may have posted the same lines first; the earliest post stands.
      const kept = await yieldToEarlier(deps, client, { ...where, channel: outcome.channel, ts: outcome.ts, issueKey, items: toPost, lineOf, claimFor, owner });
      heard.push(...kept.yielded);
      toPost.splice(0, toPost.length, ...kept.items);
      if (kept.items.length > 0) {
        ts = outcome.ts;
        const message = { channel: outcome.channel, ts: outcome.ts, lines: kept.items.map(lineOf) };
        await Promise.all(toPost.map((item) => finishLease(deps.kv, claimFor(item), owner, { fields: { ts: outcome.ts, ...(item.component === "changeMonitor" ? { message } : {}) } })));
        await writeReviewMessage(deps.kv, reviewMessageKey(head), message);
        if (toPost.some((item) => item.component === "changeMonitor")) await writeReviewMessage(deps.kv, changeMonitorMessageKey(head), message);
      }
    }
  }
  const announced = [...(ts === undefined ? [] : toPost), ...edited];
  await recordSecurity(deps.kv, pr, [...announced, ...heard], pull.headSha, now);
  if (announced.length === 0) return { posted: false, reason: "already_announced", ...base };
  return { posted: true, reason: ts === undefined ? "updated_in_thread" : "posted_in_thread", ...base, components: announced.map((item) => item.component) };
}

/** What the thread last heard of the security review, so an unchanged verdict on a new head stays quiet. */
async function recordSecurity(kv: KeyedKv, pr: { repository: string; number: number }, items: readonly Settled[], headSha: string, now: Date): Promise<void> {
  const security = items.find((item): item is Extract<Settled, { component: "security" }> => item.component === "security");
  if (security === undefined) return;
  try {
    await kv.put(securityAnnouncedKey(pr), { fingerprint: security.fingerprint, headSha: headSha.toLowerCase(), at: now.toISOString() });
  } catch (error) {
    warnKv("review-announce.recordSecurity", error);
    // The done claim still stops a repeat of this change; only the record of what was last heard is behind.
  }
}

/**
 * Read the thread back after posting. Lines an earlier desk update for this
 * head already carries come out of this post: an edit when some of its own
 * lines are left, a delete when none are. Their claims finish on the earlier
 * post. When the thread cannot be read, or Slack refuses the edit, the post
 * stays as it is.
 */
async function yieldToEarlier(
  deps: ReviewDeps,
  client: SlackPoster,
  input: {
    channel: string;
    threadTs: string | undefined;
    headSha: string;
    now: Date;
    ts: string;
    issueKey: string;
    items: readonly Settled[];
    lineOf: (item: Settled) => string;
    claimFor: (item: Settled) => KvKey;
    owner: string;
  }
): Promise<{ items: Settled[]; yielded: Settled[] }> {
  const all = { items: [...input.items], yielded: [] as Settled[] };
  const after = await threadReviews(client, input);
  if (after === undefined) return all;
  const earlier = new Map<Settled, string>();
  for (const item of input.items) {
    const by = carriedBy(after, { line: input.lineOf(item), beforeTs: input.ts });
    if (by !== undefined) earlier.set(item, by.ts);
  }
  if (earlier.size === 0) return all;
  const own = input.items.filter((item) => !earlier.has(item));
  try {
    if (own.length === 0) {
      if (client.chat.delete === undefined) return all;
      await client.chat.delete({ channel: input.channel, ts: input.ts });
    } else {
      if (client.chat.update === undefined) return all;
      await client.chat.update({ channel: input.channel, ts: input.ts, text: renderReviewUpdate({ issueKey: input.issueKey, headSha: input.headSha, lines: own.map(input.lineOf) }) });
    }
  } catch {
    return all;
  }
  console.log(JSON.stringify({ desk: "review_update", outcome: own.length === 0 ? "yielded_post" : "yielded_lines", channel: input.channel, ts: input.ts, lines: [...earlier.keys()].map((item) => item.component) }));
  await Promise.all([...earlier].map(([item, ts]) => finishLease(deps.kv, input.claimFor(item), input.owner, { fields: { ts } })));
  return { items: own, yielded: [...earlier.keys()] };
}

type ReviewMessage = { channel: string; ts: string; lines: string[] };

/** A stored review update: the head's latest (`reviewMessageKey`), or the one a running change-monitor line is in (its done pending claim). */
async function readReviewMessage(kv: KeyedKv, key: KvKey): Promise<ReviewMessage | undefined> {
  let stored: unknown;
  try {
    stored = await kv.get(key);
  } catch (error) {
    warnKv("review-announce.readReviewMessage", error);
    return undefined;
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const record = stored as Record<string, unknown>;
  const message = (record["message"] ?? record) as Record<string, unknown>;
  const { channel, ts, lines } = message;
  if (typeof channel !== "string" || typeof ts !== "string" || !Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return undefined;
  if (pendingLease(stored) !== undefined) return undefined;
  return { channel, ts, lines: lines as string[] };
}

async function writeReviewMessage(kv: KeyedKv, key: KvKey, message: ReviewMessage): Promise<void> {
  try {
    await kv.put(key, message);
  } catch (error) {
    warnKv("review-announce.writeReviewMessage", error);
    // The next change-monitor line posts as its own update instead of joining this one.
  }
}

function isChangeReviewLine(line: string): boolean {
  return line.startsWith("📡") && line.includes(" Change review \u2014 ");
}

/**
 * Put `line` into a review update already in the thread: a change-monitor
 * state replaces the 📡 line there, anything else is added at the end. True
 * once Slack took the edit and the claim is done; false leaves the claim held
 * for a new post.
 */
async function editReviewMessage(
  deps: ReviewDeps,
  client: SlackPoster,
  input: { issueKey: string; headSha: string; into: ReviewMessage; line: string; key: KvKey; owner: string; head: { repository: string; number: number; headSha: string } }
): Promise<boolean> {
  const { into, line } = input;
  if (client.chat.update === undefined) return false;
  const at = isChangeReviewLine(line) ? into.lines.findIndex(isChangeReviewLine) : -1;
  const lines = at === -1 ? [...into.lines, line] : into.lines.map((existing, index) => (index === at ? line : existing));
  try {
    await client.chat.update({ channel: into.channel, ts: into.ts, text: renderReviewUpdate({ issueKey: input.issueKey, headSha: input.headSha, lines }) });
  } catch {
    return false;
  }
  const message = { channel: into.channel, ts: into.ts, lines };
  await finishLease(deps.kv, input.key, input.owner, { fields: { ts: into.ts, message } });
  const latest = await readReviewMessage(deps.kv, reviewMessageKey(input.head));
  if (latest === undefined || latest.ts === into.ts) await writeReviewMessage(deps.kv, reviewMessageKey(input.head), message);
  if (isChangeReviewLine(line)) await writeReviewMessage(deps.kv, changeMonitorMessageKey(input.head), message);
  return true;
}

// Hosted v2 forwards check_suite and workflow_run completions but no
// check_run, and the security reviewer's result is a PR review, which may not
// be forwarded at all (docs/deployment-issues.md issue 12). Change-monitor's
// sticky comment never wakes the desk: July drops every issue_comment action
// but `created` before the channel sees it, and this channel does not take
// comments. So after a wake that leaves the security review as the only gate
// outstanding (a CI or Bugbot wake), or change-monitor still running (any
// wake), the desk looks again on this schedule, then gives up; the next push
// starts over. TLSSN-37's plan landed about two minutes after its running line.
export const REVIEW_RECHECK_MS: readonly number[] = [60_000, 120_000, 180_000, 240_000, 300_000];
// A re-check loop holds this long past its schedule before another wake on the head may start one.
const RECHECK_GRACE_MS = 60_000;

/**
 * announceReviewUpdate, then a bounded re-read while the security review is
 * the one gate missing after a CI or Bugbot completion, change-monitor is
 * still running, or a wake other than workflow_run saw CI settle without
 * owning its line. One loop per head at a time (`review-recheck/…`); best
 * effort: a replaced process drops the wait, and the claims keep a second
 * loop from posting twice.
 */
export async function announceReviewUpdateWithRecheck(
  input: { repository: string; number: number; wake: ReviewWake },
  deps: ReviewDeps & { sleep?: (ms: number) => Promise<void>; recheckMs?: readonly number[] }
): Promise<ReviewUpdateResult[]> {
  const results = [await announceReviewUpdate(input, deps)];
  const gateWake = input.wake.kind === "check_suite" || input.wake.kind === "workflow_run";
  // A workflow_run's own check_suite owns its CI line and arrives with it; a CI line deferred in any other wake is looked at again once the owner had its turn.
  const ciWait = input.wake.kind !== "workflow_run";
  const waiting = (result: ReviewUpdateResult) => settledReason(result) && ((gateWake && waitingOnSecurity(result)) || result.changeReview === "pending" || (ciWait && result.ciDeferred === true));
  const schedule = deps.recheckMs ?? REVIEW_RECHECK_MS;
  if (!waiting(results[0]!) || !(await takeRecheck(deps, input, results[0]!, schedule))) return results;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (const ms of schedule) {
    await sleep(ms);
    const next = await announceReviewUpdate({ ...input, wake: { kind: "review" } }, deps);
    results.push(next);
    if (!waiting(next)) break;
  }
  return results;
}

function settledReason(result: ReviewUpdateResult): boolean {
  return result.issueKey !== undefined && ["posted_in_thread", "updated_in_thread", "nothing_settled", "already_announced", "deferred"].includes(result.reason);
}

function waitingOnSecurity(result: ReviewUpdateResult): boolean {
  return result.pending !== undefined && result.pending.includes("security") && result.pending.length === 1;
}

/**
 * False while another re-check loop for this head is inside its window; an
 * unreadable store lets this one run.
 *
 * The head is an owner lease (claim-lease.ts) with a settle re-read, so of
 * two new-code wakes that both find it free only one loops. The lease keeps
 * the `until` the plain `{ until }` record carried, and a slug mid-deploy
 * (or rolled back) still runs that code: it reads `until` and yields to a
 * lease the same way. Old code puts without looking at an owner, so an old
 * and a new wake can still both loop, as two wakes could before; a new wake
 * that sees the old one's record at its read-back or settle yields.
 */
export async function takeRecheck(
  deps: Pick<ReviewDeps, "kv" | "env" | "now">,
  input: { repository: string; number: number },
  result: Pick<ReviewUpdateResult, "headSha">,
  schedule: readonly number[]
): Promise<boolean> {
  if (result.headSha === undefined) return true;
  const key = reviewRecheckKey({ ...input, headSha: result.headSha });
  if (!recheckLeaseOn(deps.env)) return takeRecheckLegacy(deps, key, schedule);
  const now = deps.now();
  const leaseMs = totalMs(schedule) + RECHECK_GRACE_MS;
  const log = (outcome: string) => console.log(JSON.stringify({ desk: "review_recheck", outcome, repository: input.repository, number: input.number, head: result.headSha }));
  const read = await readRetrying(deps.kv, key);
  if (!read.ok) {
    log("unavailable");
    return true;
  }
  const owner = randomUUID();
  const until = new Date(now.getTime() + leaseMs).toISOString();
  if (read.value !== undefined && pendingLease(read.value) === undefined) {
    // A plain `{ until }` from old code, or anything else that is not a lease.
    if (liveUntil(read.value, now)) return false;
    // Overwritten only while it still holds what was read: a delete here
    // could remove a rival's fresh lease. takeLease then settles this lease
    // as its owner's own; a rival's put in between makes it yield.
    const stored = read.value;
    const replaced = await updateVerified(deps.kv, key, (current) => (current === undefined || sameJson(current, stored) ? { until, state: "pending", owner, at: now.toISOString() } : undefined));
    if (replaced.status === "unavailable") {
      log("unavailable");
      return true;
    }
  }
  const claim = await takeLease(deps.kv, key, { owner, leaseMs, now, settleMs: claimSettleMs(deps.env), fields: { until } });
  if (claim.status === "done") {
    // Not a lease. Only the stale value first read, which the overwrite
    // could not replace (its puts never stuck), lets the loop run. Anything
    // else was written since, by an old wake, and holds the head even when
    // that wake's clock made its `until` already past.
    if (read.value === undefined || !sameJson(claim.current, read.value)) return false;
    log("stale");
    return true;
  }
  if (claim.status !== "unavailable") return claim.status === "taken";
  // takeLease also says unavailable when the lease vanished from a store it
  // could read. One more read tells a rival's hold, and a healthy store,
  // from an outage. As for done: anything written since the first read that
  // is not this wake's lease holds the head, even an old wake's `{ until }`
  // that a slow clock made already past.
  let current: JsonValue | undefined;
  try {
    current = await deps.kv.get(key);
  } catch {
    log("unavailable");
    return true;
  }
  if (pendingLease(current)?.owner === owner) return true;
  if (current === undefined) {
    log("vanished");
    return true;
  }
  if (read.value === undefined || !sameJson(current, read.value)) return false;
  // Unchanged since the first read, but a rival's live lease still holds.
  const held = pendingLease(current);
  if (held !== undefined && !leaseExpired(held, leaseMs, now)) return false;
  log("stale");
  return true;
}

function totalMs(schedule: readonly number[]): number {
  let total = 0;
  for (const ms of schedule) total += ms;
  return total;
}

function liveUntil(value: unknown, now: Date): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const until = Date.parse(String((value as Record<string, unknown>)["until"]));
  return Number.isFinite(until) && until > now.getTime();
}

/** The plain read-then-put `{ until }` record, behind `FACTORY_DESK_RECHECK_LEASE=off`. */
async function takeRecheckLegacy(deps: Pick<ReviewDeps, "kv" | "now">, key: KvKey, schedule: readonly number[]): Promise<boolean> {
  const now = deps.now().getTime();
  try {
    const held = await deps.kv.get(key);
    const until = held !== null && typeof held === "object" && !Array.isArray(held) ? Date.parse(String((held as Record<string, unknown>)["until"])) : Number.NaN;
    if (Number.isFinite(until) && until > now) return false;
    await deps.kv.put(key, { until: new Date(now + schedule.reduce((sum, ms) => sum + ms, 0) + RECHECK_GRACE_MS).toISOString() });
  } catch (error) {
    warnKv("review-announce.takeRecheckLegacy", error);
    // Two loops at worst; the claims keep them from posting twice.
  }
  return true;
}

async function gather(input: { repository: string; number: number; wake: ReviewWake }, pull: PullFacts, github: ReviewReader): Promise<ReviewEvidence> {
  const [checkRuns, reviews, comments] = await Promise.all([github.checkRuns(pull.headSha), github.reviews(input.number), github.comments?.(input.number)]);
  const wake = input.wake;
  const evidence: ReviewEvidence = {
    repository: input.repository,
    number: input.number,
    headSha: pull.headSha,
    ...(checkRuns === undefined ? {} : { checkRuns }),
    reviews,
    ...(comments === undefined ? {} : { comments }),
    ...(wake.kind === "check_suite" ? { suite: wake.suite } : {}),
    ...(wake.kind === "workflow_run" ? { workflow: wake.workflow } : {}),
  };
  if (wake.kind === "pull_request" && wake.action === "synchronize" && isBotPush(wake.sender) && wake.before !== undefined && SHA.test(wake.before) && wake.before.toLowerCase() !== pull.headSha.toLowerCase()) {
    const before = await github.checkRuns(wake.before);
    const failed = before === undefined ? [] : failedCiRuns(before);
    if (failed.length > 0) evidence.autofix = { before: wake.before, failed };
  }
  return evidence;
}

/** Undefined when nothing was announced for the PR yet or the store cannot be read. */
async function readAnnouncedSecurity(kv: KeyedKv, key: KvKey): Promise<{ fingerprint: string; headSha: string } | undefined> {
  try {
    const stored = await kv.get(key);
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;
    const record = stored as Record<string, unknown>;
    const { fingerprint, headSha } = record;
    return typeof fingerprint === "string" && typeof headSha === "string" && SHA.test(headSha) ? { fingerprint, headSha } : undefined;
  } catch (error) {
    warnKv("review-announce.readAnnouncedSecurity", error);
    return undefined;
  }
}

async function claimedDone(kv: KeyedKv, key: KvKey): Promise<boolean> {
  let current: unknown;
  try {
    current = await kv.get(key);
  } catch (error) {
    warnKv("review-announce.claimedDone", error);
    return false;
  }
  return current !== undefined && current !== null && pendingLease(current) === undefined;
}

/**
 * The worker leaves `Pull request: <url>` on the ticket before it moves it to
 * In Review. When that comment names another PR, a branch that only borrows
 * the key does not speak for the ticket. An unreadable ticket, or one with no
 * such comment (a card moved by hand), does not block the update.
 */
async function linksAnotherPullRequest(mcp: HostMcpRegistry, issueKey: string, label: string): Promise<boolean> {
  try {
    const read = await readComments(mcp, issueKey);
    if (read.status !== "read") return false;
    const linked = latestPullRequestComment(read.comments);
    return linked !== undefined && linked.label.toLowerCase() !== label.toLowerCase();
  } catch {
    return false;
  }
}

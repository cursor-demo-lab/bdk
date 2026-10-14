// Every host.kv key factory-desk reads or writes is built here, and every
// prefix is listed in KEY_REGISTRY. host.kv cannot list keys, so this file is
// the only inventory of what it keeps (cleanup and operator tooling read it).
//
// What holds that in place:
// - Builders return KvKey, which only `kvKey` below can make. Agent code
//   takes its store as KeyedKv, and the verified and lease helpers and the
//   options fields that carry a key are typed KvKey, so `npm run check`
//   rejects a plain string passed to any of them.
// - ../../../scripts/kv-key-registry.test.mjs checks, with the compiler's
//   types, every call that reaches July's HostKvApi or HostKvCasApi (under
//   any name, destructured, or after supportsKvCas) and every `key` or
//   `claimKey` field passed to an agent function: each must be a KvKey. It
//   also fails on a cast to KvKey, a HostKvApi annotation, or a literal that
//   spells a registry key anywhere in agent code but this file (tests and
//   fixtures aside), on a store passed, assigned, returned or cast into a
//   declared type other than KeyedKv, HostKvApi, HostKvCasApi, a Partial of
//   one, or unknown (a hand-written `{ put(key: string) }` would take any
//   string; the script lists the flows it follows), on `any` where a KvKey
//   goes, and on a registry entry it cannot act on.
// Neither can tell whether a KvKey from one builder was passed where another
// was meant; that is what the builder names are for.
//
// The stored row is `agentsdk/v1/<agent name>/kv/<key>`, and every key below
// is a live format: changing a builder's output, or the agent name pinned in
// ../agent.ts, orphans every record written under the old one. July writes
// `<key>` URI-encoded (`ticket/X-1` is stored as `ticket%2FX-1`), and a key
// whose encoding is over 256 bytes as `sha256:<hex digest of the raw key>`
// (`keySegment`, July 0.2.24 dist/storage-protocol.js), so operator tooling that
// reads rows directly must encode keys the same way.

import type { HostKvApi, JsonValue } from "@cursor/july";
import type { Hop } from "./hop-watch.js";
import type { Command } from "./originator.js";
import type { ReviewComponent, Settled } from "./review-update.js";
import type { ThreadRef } from "./threads.js";

/**
 * keep: never deleted; a later event reads it to refuse a repeat.
 * transient: the code deletes it on its normal path; a leftover can go.
 * expire: nothing deletes it; safe to drop once idle for `horizonDays`.
 */
export type KeyLifecycle = "keep" | "transient" | "expire";

/**
 * How writers race on the key. lease: takeLease with a settle re-read.
 * verified: updateVerified/deleteVerified. claim: CAS when present, else
 * get then put. blind: plain put, last writer wins. index: a read-modify-write list.
 */
export type KeyConcurrency = "lease" | "verified" | "claim" | "blind" | "index";

/**
 * One builder's keys. Several builders can share a prefix (a keep index next
 * to transient per-ticket records), so a sweeper must pick keys by builder
 * and lifecycle, never by prefix alone.
 */
export type KeyEntry = {
  prefix: string;
  builder: string;
  identity: readonly string[];
  owner: string;
  readers: readonly string[];
  lifecycle: KeyLifecycle;
  horizonDays?: number;
  concurrency: KeyConcurrency;
  pii: boolean;
  note?: string;
};

/**
 * A host.kv key. Only this file makes one (`kvKey`), so a string built
 * anywhere else does not type-check where a key is expected.
 */
export type KvKey = string & { readonly __kvKey: true };

/**
 * host.kv with every key typed KvKey. Agent code takes its store as KeyedKv;
 * ctx.host.kv (July's HostKvApi) is assignable to it as is, so `keyedKv` is
 * only for a call made on ctx.host.kv in place.
 */
export type KeyedKv = {
  get(key: KvKey): Promise<JsonValue | undefined>;
  put(key: KvKey, value: JsonValue): Promise<void>;
  delete(key: KvKey): Promise<void>;
};

export function keyedKv(kv: HostKvApi): KeyedKv {
  return kv;
}

function kvKey(raw: string): KvKey {
  return raw as KvKey;
}

/** This agent's production deploy slug (docs/factory-deployment.md); lib/ops-funnel.ts adds `-staging` on a staging slug. */
export const factorySlug = "factory-desk";

/** The ops funnel's hourly dedupe marker, `v1/ops-alert/<hash16>/<UTC hour>`, and its host.files path when kv fails (lib/ops-funnel.ts). */
export function opsAlertKey(input: { hash: string; hour: string }): KvKey {
  return kvKey(`v1/ops-alert/${input.hash}/${input.hour}`);
}

export type SlackMessageRef = { channelId: string; ts: string };

type PrRef = { repository: string; number: number };
type PrHeadRef = PrRef & { headSha: string };
type ChangeMonitorVerdict = Extract<Settled, { component: "changeMonitor" }>["verdict"];

/** `<channel>:<thread ts>`, or `<channel>:` for a context with no thread. */
export function threadId(thread: ThreadRef): string {
  return `${thread.channelId}:${thread.threadTs ?? ""}`;
}

function messageId(message: SlackMessageRef): string {
  return `${message.channelId}:${message.ts}`;
}

// Per Jira ticket.

export function ticketKey(issueKey: string): KvKey {
  return kvKey(`ticket/${issueKey}`);
}

/**
 * One claim per transition by default (changelog id). Omit `changelogId` for
 * a sticky per-status claim: Planned dumps fall back to that only when no
 * `Plan:` comment id is readable (`planAnnounceKey` keys them per plan
 * otherwise, so a replan posts its new plan).
 */
export function announcedKey(input: { issueKey: string; status: string; changelogId?: string }): KvKey {
  const base = `announced/${input.issueKey}:${input.status}`;
  return kvKey(input.changelogId === undefined ? base : `${base}:${input.changelogId}`);
}

/**
 * The Planned announce's claim: `announced/<KEY>:Planned:plan-<comment id>`
 * for the `Plan:` comment the post carries, else the per-ticket
 * `announced/<KEY>:Planned` when no comment or id could be read.
 */
export function planAnnounceKey(input: { issueKey: string; status: string; commentId?: string }): KvKey {
  const base = announcedKey({ issueKey: input.issueKey, status: input.status });
  return kvKey(input.commentId === undefined ? base : `${base}:plan-${input.commentId}`);
}

/**
 * The Triaged announce's claim: `announced/<KEY>:Triaged:verdict-<fingerprint>`
 * so a bounce with the same type, severity, Jev, and gate posts nothing.
 */
export function triagedAnnounceKey(input: { issueKey: string; status: string; fingerprint: string }): KvKey {
  return kvKey(`${announcedKey({ issueKey: input.issueKey, status: input.status })}:verdict-${input.fingerprint}`);
}

export function hopWatchClaimKey(input: { issueKey: string; hop: Hop; changelogId: string }): KvKey {
  return kvKey(`announced/${input.issueKey}:hop-${input.hop}:${input.changelogId}`);
}

/**
 * The plan start check's one line per Triaged entry: `alert` (planning
 * never started, re-sent once) or `final` (the retried entry never started
 * either). Shares `announced/` with the hop lines; `plan-start-` keeps
 * them apart.
 */
export function planStartClaimKey(input: { issueKey: string; step: "alert" | "final"; changelogId: string }): KvKey {
  return kvKey(`announced/${input.issueKey}:plan-start-${input.step}:${input.changelogId}`);
}

export function hopWatchKey(issueKey: string): KvKey {
  return kvKey(`hop-watch/${issueKey}`);
}

/**
 * The desk's one automatic planning re-send per stuck episode (hop-watch.ts
 * plan start check): a lease taken before the move, marked done after it,
 * carrying the Triaged entry it retried. Stands until a planning start is
 * seen, the ticket leaves the plan path, or PLAN_START_RETRY_TTL_MS passes.
 */
export function planStartRetryKey(issueKey: string): KvKey {
  return kvKey(`plan-start-retry/${issueKey}`);
}

export const HOP_WATCH_INDEX = kvKey("hop-watch/index");
export const BACKSTOP_SWEEP_KEY = kvKey("hop-watch/last-sweep");

/**
 * When the ticket last entered Triaged. Kept per ticket, apart from the watch
 * (which is deleted once it fires), so retry can still tell a planner run of
 * this entry from an older run's marker after the watch has gone.
 */
export function triagedSinceKey(issueKey: string): KvKey {
  return kvKey(`triaged-since/${issueKey}`);
}

/** The newest Triaged entry the desk saw for a ticket; a Needs info announce claims once per entry. */
export function triagedEntryKey(issueKey: string): KvKey {
  return kvKey(`triaged-entry/${issueKey}`);
}

export function reactionKey(issueKey: string): KvKey {
  return kvKey(`reaction/${issueKey}`);
}

export function backlinkKey(issueKey: string): KvKey {
  return kvKey(`backlink/${issueKey}`);
}

export function plannerSentKey(issueKey: string): KvKey {
  return kvKey(`planner-sent/${issueKey}`);
}

export function planDeclinedKey(issueKey: string): KvKey {
  return kvKey(`plan-declined/${issueKey}`);
}

/** The per-ticket decision hold (approve-command.ts `takeTicketDecision`). */
export function approveTicketKey(issueKey: string): KvKey {
  return kvKey(`approve-ticket/${issueKey}`);
}

export function loaderKey(issueKey: string): KvKey {
  return kvKey(`loader/${issueKey}`);
}

export function reviewGatesKey(issueKey: string): KvKey {
  return kvKey(`review-gates/${issueKey}`);
}

export function slackApprovalKey(issueKey: string): KvKey {
  return kvKey(`approved-in-slack/${issueKey}`);
}

export function retryBounceKey(issueKey: string): KvKey {
  return kvKey(`retry-bounce/${issueKey}`);
}

export function pullRequestRetryKey(issueKey: string): KvKey {
  return kvKey(`retry-pr/${issueKey}`);
}

/** Per Jira project: the issue types the tracker lists (agent/lib/issue-type.ts, shared with triage-jira). */
export function issueTypesCacheKey(project: string): KvKey {
  return kvKey(`triage-issue-types/${project}`);
}

// Per Slack thread.

export function threadTicketsKey(thread: ThreadRef): KvKey {
  return kvKey(`thread-tickets/${threadId(thread)}`);
}

export function filingThreadKey(thread: ThreadRef): KvKey {
  return kvKey(`filing-thread/${threadId(thread)}`);
}

/** file_ticket's hold while this thread's request is being filed. */
export function filingHoldKey(thread: ThreadRef): KvKey {
  return kvKey(`file-ticket/${threadId(thread)}`);
}

export function speakerKey(thread: ThreadRef): KvKey {
  return kvKey(`speaker/${threadId(thread)}`);
}

export function commandKey(thread: ThreadRef, command: Command): KvKey {
  return kvKey(`command/${threadId(thread)}/${command.verb}:${command.target}`);
}

export function awaitingKey(thread: ThreadRef): KvKey {
  return kvKey(`awaiting-info/${threadId(thread)}`);
}

export function intakeTriageKey(thread: ThreadRef): KvKey {
  return kvKey(`intake-triage/${threadId(thread)}`);
}

/** The one thread key that writes "-", not "", for a context with no thread. */
export function declineAnsweredKey(input: { thread: ThreadRef; issueKey: string }): KvKey {
  return kvKey(`decline-answered/${input.thread.channelId}:${input.thread.threadTs ?? "-"}/${input.issueKey}`);
}

// Per Slack message.

export function handledMessageKey(message: SlackMessageRef): KvKey {
  return kvKey(`handled-message/${messageId(message)}`);
}

export function reactionClaimKey(input: SlackMessageRef & { act: "filing" | "approve" | "decline" }): KvKey {
  return kvKey(`reaction/${messageId(input)}/${input.act}`);
}

export function planPostKey(post: SlackMessageRef): KvKey {
  return kvKey(`plan-post/${messageId(post)}`);
}

export function filingPromptKey(post: SlackMessageRef): KvKey {
  return kvKey(`filing-prompt/${messageId(post)}`);
}

/**
 * Written when a request's triage is dropped (filed or declined); every copy
 * of it kept under another ts then stops counting as pending. `ts` is the
 * request's, not the prompt's.
 */
export function intakeSettledKey(request: SlackMessageRef): KvKey {
  return kvKey(`intake-settled/${messageId(request)}`);
}

export function planCommandKey(message: SlackMessageRef): KvKey {
  return kvKey(`plan-command/${messageId(message)}`);
}

export function approveCommandKey(message: SlackMessageRef): KvKey {
  return kvKey(`approve-command/${messageId(message)}`);
}

export function retryCommandKey(message: SlackMessageRef): KvKey {
  return kvKey(`retry-command/${messageId(message)}`);
}

export function threadDetailKey(message: SlackMessageRef): KvKey {
  return kvKey(`thread-detail/${messageId(message)}`);
}

// Per pull request. Repository and head sha are lowercased; the component,
// fingerprint, and verdict are not.

/**
 * One claim per PR, head, and gate: a re-run of a gate on the same head, a
 * redelivery, or a second wake for the same result posts nothing. A new push
 * is a new head, so its results post again. The security review is the
 * exception (`securityClaimKey`).
 */
export function reviewClaimKey(input: PrHeadRef & { component: ReviewComponent }): KvKey {
  return kvKey(`review/${input.repository.toLowerCase()}#${input.number}/${input.headSha.toLowerCase()}/${input.component}`);
}

/**
 * Change-monitor's running line, claimed apart from its result so the result
 * still announces; the done record keeps the message the line is in, which
 * the result edits in place.
 */
export function changeMonitorPendingKey(input: PrHeadRef): KvKey {
  return kvKey(`${reviewClaimKey({ ...input, component: "changeMonitor" })}-pending`);
}

/**
 * One claim per change-monitor state on a head, so running, plan ready, and a
 * later escalation each reach the thread once. Verified, attention, and a
 * stopped watch keep the per-head key they have always had.
 */
export function changeMonitorClaimKey(input: PrHeadRef & { verdict: ChangeMonitorVerdict }): KvKey {
  if (input.verdict === "pending") return kvKey(changeMonitorPendingKey(input));
  const key = reviewClaimKey({ ...input, component: "changeMonitor" });
  return kvKey(input.verdict === "planned" ? `${key}-planned` : key);
}

/** The review update the head's 📡 line is in (`{ channel, ts, lines }`), which each later change-monitor state edits. */
export function changeMonitorMessageKey(input: PrHeadRef): KvKey {
  return kvKey(`review-change/${input.repository.toLowerCase()}#${input.number}/${input.headSha.toLowerCase()}`);
}

/** The latest review update posted for a head: `{ channel, ts, lines }`, so a later line can join it. */
export function reviewMessageKey(input: PrHeadRef): KvKey {
  return kvKey(`review-message/${input.repository.toLowerCase()}#${input.number}/${input.headSha.toLowerCase()}`);
}

/**
 * The security verdict the thread last heard for this PR:
 * `{ fingerprint, headSha, at }`, written after the post lands. The reviewer
 * reviews every head, so a push that leaves the fingerprint alone posts
 * nothing; a changed fingerprint posts, even back to one heard before.
 */
export function securityAnnouncedKey(input: PrRef): KvKey {
  return kvKey(`review-security/${input.repository.toLowerCase()}#${input.number}`);
}

/**
 * One claim per security fingerprint and the head it follows (the head of the
 * last announced verdict, or `none`), so wakes racing on one change share a
 * claim, and CLEAN → FINDINGS → CLEAN is three claims.
 */
export function securityClaimKey(input: PrRef & { fingerprint: string; after?: string }): KvKey {
  return kvKey(`review/${input.repository.toLowerCase()}#${input.number}/security/${input.fingerprint}/after/${input.after?.toLowerCase() ?? "none"}`);
}

/** The window one re-check loop holds for a head (`{ until }`). */
export function reviewRecheckKey(input: PrHeadRef): KvKey {
  return kvKey(`review-recheck/${input.repository.toLowerCase()}#${input.number}/${input.headSha.toLowerCase()}`);
}

const DAYS = 7;
const TICKET = ["issueKey"];
const THREAD = ["slackChannelId", "slackThreadTs or ''"];
const MESSAGE = ["slackChannelId", "slackTs"];
const PR_HEAD = ["repository (lowercased)", "prNumber", "headSha (lowercased)"];

export const KEY_REGISTRY: readonly KeyEntry[] = [
  { prefix: "ticket/", builder: "ticketKey", identity: TICKET, owner: "lib/ticket-thread.ts", readers: ["lib/ticket-thread.ts", "tools/file_ticket.ts", "lib/command-thread.ts", "lib/hop-watch.ts", "lib/intake-backlink.ts", "lib/loader.ts", "lib/originator.ts", "lib/plan-decline.ts", "lib/planner-wait.ts", "lib/reaction-approval.ts", "lib/thread-detail.ts"], lifecycle: "keep", concurrency: "lease", pii: true, note: "The ticket's Slack thread; carries originatorUserId. file_ticket writes it too." },
  { prefix: "announced/", builder: "announcedKey", identity: [...TICKET, "status name", "changelogId?"], owner: "lib/ticket-thread.ts", readers: ["lib/announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false, note: "Status is the free-text Jira status name." },
  { prefix: "announced/", builder: "planAnnounceKey", identity: [...TICKET, "status name", "Plan: comment id?"], owner: "lib/announce.ts", readers: ["lib/announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "announced/", builder: "triagedAnnounceKey", identity: [...TICKET, "status name", "verdict fingerprint"], owner: "lib/announce.ts", readers: ["lib/announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false, note: "The fingerprint ends in `first` to keep #121's keys valid." },
  { prefix: "announced/", builder: "hopWatchClaimKey", identity: [...TICKET, "hop", "changelogId"], owner: "lib/hop-watch.ts", readers: ["lib/hop-watch.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false, note: "Shares announced/ with the status claims; `hop-` keeps them apart." },
  { prefix: "announced/", builder: "planStartClaimKey", identity: [...TICKET, "step (alert|final)", "changelogId"], owner: "lib/hop-watch.ts", readers: ["lib/hop-watch.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false, note: "Shares announced/ with the status claims; `plan-start-` keeps them apart." },
  { prefix: "hop-watch/", builder: "hopWatchKey", identity: TICKET, owner: "lib/hop-watch.ts", readers: ["lib/hop-watch.ts", "lib/retry-command.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Deleted when the watch fires or is superseded. A plan record also carries the 4-minute start check's due time and outcome." },
  { prefix: "plan-start-retry/", builder: "planStartRetryKey", identity: TICKET, owner: "lib/hop-watch.ts", readers: ["lib/hop-watch.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false, note: "Deleted when a planning start is seen or the ticket leaves the plan path; read as absent once PLAN_START_RETRY_TTL_MS (2 h) old." },
  { prefix: "hop-watch/index", builder: "HOP_WATCH_INDEX", identity: [], owner: "lib/hop-watch.ts", readers: ["lib/hop-watch.ts"], lifecycle: "keep", concurrency: "index", pii: false, note: "Issue keys with a live watch; an issue key cannot be `index`." },
  { prefix: "hop-watch/last-sweep", builder: "BACKSTOP_SWEEP_KEY", identity: [], owner: "lib/hop-watch.ts", readers: ["lib/hop-watch.ts"], lifecycle: "keep", concurrency: "lease", pii: false },
  { prefix: "triaged-since/", builder: "triagedSinceKey", identity: TICKET, owner: "lib/hop-watch.ts", readers: ["lib/hop-watch.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "triaged-entry/", builder: "triagedEntryKey", identity: TICKET, owner: "lib/announce.ts", readers: ["lib/announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Written with a settle re-read so it ends on the newest changelog id." },
  { prefix: "reaction/", builder: "reactionKey", identity: TICKET, owner: "lib/status-reaction.ts", readers: ["lib/status-reaction.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Shares reaction/ with reactionClaimKey; an issue key has no `:`." },
  { prefix: "backlink/", builder: "backlinkKey", identity: TICKET, owner: "lib/intake-backlink.ts", readers: ["lib/intake-backlink.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "planner-sent/", builder: "plannerSentKey", identity: TICKET, owner: "lib/plan-move.ts", readers: ["lib/plan-move.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "plan-declined/", builder: "planDeclinedKey", identity: TICKET, owner: "lib/plan-decline.ts", readers: ["lib/plan-decline.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Deleted when the ticket leaves Planned." },
  { prefix: "approve-ticket/", builder: "approveTicketKey", identity: TICKET, owner: "lib/approve-command.ts", readers: ["lib/approve-command.ts", "lib/reaction-targets.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false, note: "A new plan post deletes a pending hold." },
  { prefix: "loader/", builder: "loaderKey", identity: TICKET, owner: "lib/loader.ts", readers: ["lib/loader.ts", "lib/announce.ts", "lib/review-announce.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "review-gates/", builder: "reviewGatesKey", identity: TICKET, owner: "lib/loader.ts", readers: ["lib/loader.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "approved-in-slack/", builder: "slackApprovalKey", identity: TICKET, owner: "lib/slack-approval.ts", readers: ["lib/slack-approval.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: true, note: "May carry the approver's Slack user id (`by`)." },
  { prefix: "retry-bounce/", builder: "retryBounceKey", identity: TICKET, owner: "lib/slack-approval.ts", readers: ["lib/slack-approval.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "retry-pr/", builder: "pullRequestRetryKey", identity: TICKET, owner: "lib/slack-approval.ts", readers: ["lib/slack-approval.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "triage-issue-types/", builder: "issueTypesCacheKey", identity: ["jiraProjectKey"], owner: "lib/issue-type.ts", readers: ["lib/issue-type.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false, note: "A cache with `exp`; deleted when read expired." },
  { prefix: "thread-tickets/", builder: "threadTicketsKey", identity: THREAD, owner: "lib/thread-tickets.ts", readers: ["lib/thread-tickets.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "verified", pii: false },
  { prefix: "filing-thread/", builder: "filingThreadKey", identity: THREAD, owner: "lib/thread-tickets.ts", readers: ["lib/thread-tickets.ts", "lib/approve-command.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "file-ticket/", builder: "filingHoldKey", identity: THREAD, owner: "tools/file_ticket.ts", readers: ["tools/file_ticket.ts", "lib/thread-tickets.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "speaker/", builder: "speakerKey", identity: THREAD, owner: "lib/originator.ts", readers: ["lib/originator.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "verified", pii: true, note: "The thread's last human speaker (Slack user id)." },
  { prefix: "command/", builder: "commandKey", identity: [...THREAD, "verb", "target"], owner: "lib/originator.ts", readers: ["lib/originator.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "verified", pii: true, note: "Who said the command (Slack user id)." },
  { prefix: "awaiting-info/", builder: "awaitingKey", identity: THREAD, owner: "lib/thread-detail.ts", readers: ["lib/thread-detail.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "intake-triage/", builder: "intakeTriageKey", identity: THREAD, owner: "lib/intake-triage.ts", readers: ["lib/intake-triage.ts"], lifecycle: "transient", horizonDays: DAYS, concurrency: "blind", pii: true, note: "Stashes the request's Slack text; carries `exp`. A DM is keyed with no thread on purpose." },
  { prefix: "decline-answered/", builder: "declineAnsweredKey", identity: ["slackChannelId", "slackThreadTs or '-'", ...TICKET], owner: "lib/reaction-approval.ts", readers: ["lib/reaction-approval.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "handled-message/", builder: "handledMessageKey", identity: MESSAGE, owner: "lib/handled-message.ts", readers: ["lib/handled-message.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "reaction/", builder: "reactionClaimKey", identity: [...MESSAGE, "act"], owner: "lib/reaction-approval.ts", readers: ["lib/reaction-approval.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "plan-post/", builder: "planPostKey", identity: MESSAGE, owner: "lib/reaction-targets.ts", readers: ["lib/reaction-approval.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "verified", pii: false },
  { prefix: "filing-prompt/", builder: "filingPromptKey", identity: MESSAGE, owner: "lib/reaction-targets.ts", readers: ["lib/reaction-approval.ts", "lib/one-reply.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "verified", pii: true, note: "Carries the requester's Slack user id." },
  { prefix: "intake-settled/", builder: "intakeSettledKey", identity: MESSAGE, owner: "lib/intake-triage.ts", readers: ["lib/intake-triage.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false, note: "Carries `exp`." },
  { prefix: "plan-command/", builder: "planCommandKey", identity: MESSAGE, owner: "lib/plan-command.ts", readers: ["lib/plan-command.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "approve-command/", builder: "approveCommandKey", identity: MESSAGE, owner: "lib/approve-command.ts", readers: ["lib/approve-command.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "retry-command/", builder: "retryCommandKey", identity: MESSAGE, owner: "lib/retry-command.ts", readers: ["lib/retry-command.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "thread-detail/", builder: "threadDetailKey", identity: MESSAGE, owner: "lib/thread-detail.ts", readers: ["lib/thread-detail.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "review/", builder: "reviewClaimKey", identity: [...PR_HEAD, "component"], owner: "lib/review-announce.ts", readers: ["lib/review-announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "review/", builder: "changeMonitorPendingKey", identity: PR_HEAD, owner: "lib/review-announce.ts", readers: ["lib/review-announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "review/", builder: "changeMonitorClaimKey", identity: [...PR_HEAD, "verdict"], owner: "lib/review-announce.ts", readers: ["lib/review-announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "review/", builder: "securityClaimKey", identity: ["repository (lowercased)", "prNumber", "fingerprint", "after headSha (lowercased) or 'none'"], owner: "lib/review-announce.ts", readers: ["lib/review-announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false, note: "Disjoint from the head claims only because a sha is hex, never `security`." },
  { prefix: "review-change/", builder: "changeMonitorMessageKey", identity: PR_HEAD, owner: "lib/review-announce.ts", readers: ["lib/review-announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "review-message/", builder: "reviewMessageKey", identity: PR_HEAD, owner: "lib/review-announce.ts", readers: ["lib/review-announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "review-security/", builder: "securityAnnouncedKey", identity: ["repository (lowercased)", "prNumber"], owner: "lib/review-announce.ts", readers: ["lib/review-announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "blind", pii: false },
  { prefix: "review-recheck/", builder: "reviewRecheckKey", identity: PR_HEAD, owner: "lib/review-announce.ts", readers: ["lib/review-announce.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "lease", pii: false },
  { prefix: "v1/ops-alert/", builder: "opsAlertKey", identity: ["hash16 of (slug, site, reason)", "UTC hour"], owner: "lib/ops-funnel.ts", readers: ["lib/ops-funnel.ts"], lifecycle: "expire", horizonDays: DAYS, concurrency: "claim", pii: false, note: "One ops Slack line per signature per hour; read then put, no CAS." },
];

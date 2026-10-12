import { supportsKvCas, type HostMcpRegistry } from "@cursor/july";
import { claimStatusMove, hasLaunched, recordStatusMove, releaseStatusMove } from "./claim.js";
import { FactoryConfigError, jiraProjects, sandboxRef, sandboxRepo, statusNames, type StatusNames } from "./config.js";
import { addComment, issueStatus, readComments, transitionFrom, type GuardedTransition } from "./jira.js";
import { linkablePullRequest, linkTicketInBody, type PullRequestApi } from "./pr-body.js";
import { markReadyForReview, noteNotReady, readyablePullRequest, readyFailed, type ReadyApi } from "./pr-ready.js";
import { decidePullRequest, isMergedByComment, isPullRequestComment, mergedByComment, prStatusClaimKey, prStatusNote, pullRequestComment, rawPullRequestFacts, type PrDecision, type PrDelivery } from "./pr-decide.js";
import { type KeyedKv, prStatusNoteKey, ticketMergedKey } from "./kv-keys.js";
import { claimRun, type Sleep } from "./verified-claim.js";
import { warnKv } from "./ops-funnel.js";
import { countTicketMerged } from "./factory-otel.js";

// The worker's second path, in the order it runs inside the GitHub channel's
// `{ task }` (after the 202, no model turn): a recorded launch for the key,
// the claim, then one guarded move. In Review is entered only from In
// Progress, so a push to a PR whose ticket someone moved back (a replan)
// leaves it where they put it. A person's merge is the strongest evidence the
// flow gets, so Done is entered from In Review, or through In Review from any
// factory status before it: In Progress (the opened delivery was missed) or
// one the ticket drifted back to after the launch (Approved, Planned,
// Triaged, To Do; TLSSN-21 sat in Planned). The desk announces both moves.
// A status outside the factory's seven (or Done) is left alone with a note.
// The desk hears each move through its own Jira Automation rule. The worker
// does not call it. The first move into Done this path makes also counts the
// ticket once on `apj_factory.ticket.merged` (factory-otel.ts
// countTicketMerged), the denominator of cost per merged ticket: a
// `ticket-merged/<KEY>` kv marker (kv-keys.ts ticketMergedKey) is written
// with the first count, so a ticket found already at Done, or one reopened
// and moved to Done again by a second PR, is not counted again. A kv that
// cannot be read counts (rather a ticket counted twice than missed), and
// two deliveries can race read-then-put, so a key's series can increment
// twice; the dashboard queries clamp each key's increment to 1
// (observability/grafana/generate.py merged_tickets), so a double count
// neither halves that ticket's cost per merge nor adds a ticket to the
// keyed denominator. A marker that cannot be written is tried again next
// time.

export type PrStatusDeps = {
  kv: KeyedKv;
  mcp: HostMcpRegistry;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  log?: (line: string) => void;
  /** The channel's `ctx.github`. Without it the PR is left draft and its description alone. */
  github?: PullRequestApi & ReadyApi;
  /** Pauses between in-task undraft tries; `READY_RETRY_MS` when unset. */
  readyRetryMs?: readonly number[];
  /** The claim's settle wait (`FACTORY_CLAIM_SETTLE_MS`); a timer when unset. */
  sleep?: Sleep;
};

type Move = GuardedTransition["status"];

export type PrStatusOutcome =
  | { outcome: "moved"; move: "transitioned" | "already"; catchUp: boolean; resyncedFrom?: string }
  | { outcome: "not_moved"; move: Exclude<Move, "transitioned" | "already">; current?: string }
  | { outcome: "not_launched" | "duplicate" | "in_flight" };

/** Thrown after the claim is released when a retry could succeed. Hosted admission maps a rejected task to a retryable 503. */
export class PrStatusRetryableError extends Error {
  constructor(message: string) {
    super(`factory-worker: pr status: ${message}`);
    this.name = "PrStatusRetryableError";
  }
}

export async function advanceTicket(deps: PrStatusDeps, decision: Extract<PrDecision, { move: true }>): Promise<PrStatusOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { issueKey, stage, pr } = decision;
  const decided = (fields: Record<string, unknown>) => log(JSON.stringify({ worker: "pr_status", issueKey, stage, pr, ...fields }));

  const launched = await hasLaunched(deps.kv, issueKey);
  if (launched === "unavailable") {
    decided({ outcome: "claim_unavailable" });
    throw new PrStatusRetryableError("kv unavailable");
  }
  if (!launched) {
    decided({ outcome: "not_launched" });
    return { outcome: "not_launched" };
  }

  const key = prStatusClaimKey(decision);
  const now = deps.now();
  const run = claimRun(deps.env, { host: "worker", log, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
  const claim = await claimStatusMove(deps.kv, key, { now, run });
  if (claim.status === "unavailable") {
    // As on the Jira route: drop this delivery's possible put so the retried task is not held off by its own claim.
    const released = run.mode === "verified" ? await releaseStatusMove(deps.kv, key, run) : undefined;
    decided({ outcome: "claim_unavailable", ...(released === undefined ? {} : { released }) });
    throw new PrStatusRetryableError("kv unavailable");
  }
  if (claim.status === "moved") {
    decided({ outcome: "duplicate", recorded: claim.claim.outcome });
    return { outcome: "duplicate" };
  }
  if (claim.status === "in_flight") {
    decided({ outcome: "in_flight" });
    return { outcome: "in_flight" };
  }

  const seen = await ticketComments(deps, issueKey);
  const evidence: DeskEvidence = { linked: await linkPullRequest(deps, decision, seen) };
  const statuses = statusNames(deps.env);
  let catchUp = false;
  let resyncedFrom: string | undefined;
  let result: GuardedTransition;
  try {
    if (stage === "in_review") {
      result = await guarded(deps.mcp, { issueKey, from: statuses.inProgress, toStatus: statuses.inReview });
    } else {
      const login = decision.mergedBy;
      const walk = await walkToDone(deps.mcp, issueKey, statuses, async () => {
        if (login !== undefined) evidence.merged = await leaveMergedBy(deps, issueKey, login, seen);
      });
      result = walk.result;
      catchUp = walk.catchUp;
      resyncedFrom = walk.resyncedFrom;
      if (login !== undefined) evidence.merged ??= "skipped";
    }
  } catch (error) {
    await releaseStatusMove(deps.kv, key, run);
    decided({ outcome: "move_threw", message: error instanceof Error ? error.message : String(error) });
    throw new PrStatusRetryableError("transition threw");
  }

  const resynced = resyncedFrom === undefined ? {} : { resyncedFrom };
  if (result.status === "transitioned" || result.status === "already") {
    if (stage === "done" && result.status === "transitioned") await countMergedOnce(deps, issueKey);
    const recorded = await recordStatusMove(deps.kv, key, { at: now.toISOString(), outcome: result.status });
    decided({ outcome: "moved", move: result.status, catchUp, ...resynced, recorded, ...evidence });
    return { outcome: "moved", move: result.status, catchUp, ...resynced };
  }
  await releaseStatusMove(deps.kv, key, run);
  const current = "current" in result ? result.current : undefined;
  const noted = await noteSkip(deps, decision, result);
  decided({ outcome: "not_moved", move: result.status, catchUp, ...resynced, noted, ...(current === undefined ? {} : { current }), ...evidence });
  if (result.status === "failed") throw new PrStatusRetryableError(`transition failed: ${result.message.slice(0, 200)}`);
  // A merge is delivered once, so a status that could not be read is retried rather than dropped.
  if (result.status === "skipped_status" && current === undefined && stage === "done") throw new PrStatusRetryableError("status unreadable");
  return { outcome: "not_moved", move: result.status, ...(current === undefined ? {} : { current }) };
}

/** Counts the ticket on apj_factory.ticket.merged the first time it is moved to Done; the kv marker makes a later move (a reopened ticket, a second PR) silent. Never throws. */
async function countMergedOnce(deps: PrStatusDeps, issueKey: string): Promise<void> {
  const key = ticketMergedKey(issueKey);
  try {
    if ((await deps.kv.get(key)) !== undefined) return;
  } catch (error) {
    warnKv("pr-status.merged.get", error);
  }
  countTicketMerged(issueKey);
  await deps.kv.put(key, { at: deps.now().toISOString() }).catch((error: unknown) => warnKv("pr-status.merged.put", error));
}

type CommentWrite = "written" | "present" | "failed";
/** `merged` is `skipped` when the ticket never reached In Review or Done, so no merger was named. */
type DeskEvidence = { linked: CommentWrite; merged?: CommentWrite | "skipped" };

/**
 * The ticket's comments, read once per delivery to dedupe the desk lines
 * below. Unreadable comments dedupe nothing: the lines are written anyway,
 * because the desk reads the latest one and a repeated line costs nothing,
 * while a missing one leaves the thread's In Review and Done lines without
 * the pull request and the merger.
 */
async function ticketComments(deps: PrStatusDeps, issueKey: string): Promise<readonly string[]> {
  const read = await readComments(deps.mcp, issueKey).catch(() => undefined);
  return read?.status === "read" ? read.comments : [];
}

/**
 * `Pull request: <url>` on the ticket before any move, once per pull
 * request, so the desk's In Review and Done lines can link it. Best effort:
 * a comment that cannot be written never holds the move back; the desk then
 * posts the line without the link.
 */
async function linkPullRequest(deps: PrStatusDeps, decision: Extract<PrDecision, { move: true }>, seen: readonly string[]): Promise<CommentWrite> {
  return writeOnce(deps, decision.issueKey, pullRequestComment(decision.url), seen.some((comment) => isPullRequestComment(comment, decision.url)));
}

/**
 * `Merged by: <login>`, so the desk's Done line can name the human merger.
 * {@link walkToDone} calls this only once the ticket is at In Review (read
 * there, or moved there by the catch-up) or already Done, so a merge that
 * leaves the ticket short of Done names no merger. It still lands before
 * the Done move, because the desk reads the latest `Merged by:` when its
 * Done webhook arrives. Best effort, like the link.
 */
async function leaveMergedBy(deps: PrStatusDeps, issueKey: string, login: string, seen: readonly string[]): Promise<CommentWrite> {
  return writeOnce(deps, issueKey, mergedByComment(login), seen.some((comment) => isMergedByComment(comment, login)));
}

async function writeOnce(deps: PrStatusDeps, issueKey: string, body: string, present: boolean): Promise<CommentWrite> {
  if (present) return "present";
  const written = await addComment(deps.mcp, { issueKey, body }).catch(() => undefined);
  return written?.status === "commented" ? "written" : "failed";
}

type DoneWalk = { result: GuardedTransition; catchUp: boolean; resyncedFrom?: string };

/**
 * A person's merge: In Review → Done, or through In Review from any factory
 * status before it. `atReview` runs once the ticket is confirmed at In
 * Review (or already Done) and before the Done move; a ticket that stops
 * anywhere else never reaches it.
 */
async function walkToDone(mcp: HostMcpRegistry, issueKey: string, statuses: StatusNames, atReview: () => Promise<void>): Promise<DoneWalk> {
  const read = await issueStatus(mcp, issueKey);
  if (read.status === "not_connected") return { result: { status: "not_connected" }, catchUp: false };
  if (read.status === "unread") return { result: { status: "skipped_status" }, catchUp: false };
  const current = read.name;
  if (sameName(current, statuses.done)) {
    await atReview();
    return { result: { status: "already" }, catchUp: false };
  }
  let catchUp = false;
  let resyncedFrom: string | undefined;
  const behind = beforeReview(statuses).find((name) => sameName(current, name));
  if (behind !== undefined) {
    catchUp = true;
    if (!sameName(behind, statuses.inProgress)) resyncedFrom = current;
    const review = await guarded(mcp, { issueKey, from: behind, toStatus: statuses.inReview });
    if (review.status !== "transitioned" && review.status !== "already") return { result: review, catchUp, ...(resyncedFrom === undefined ? {} : { resyncedFrom }) };
  } else if (!sameName(current, statuses.inReview)) {
    return { result: { status: "skipped_status", current }, catchUp: false };
  }
  await atReview();
  const result = await guarded(mcp, { issueKey, from: statuses.inReview, toStatus: statuses.done });
  return { result, catchUp, ...(resyncedFrom === undefined ? {} : { resyncedFrom }) };
}

type Skipped = Exclude<GuardedTransition, { status: "transitioned" | "already" }>;

/**
 * Hosted v2 keeps no logs a person can read, so a move the implement PR
 * should have made and did not is said once on the ticket, per stage, pull
 * request, and outcome. Raw errors never reach Jira, like `Launch failed:`.
 * Best effort: a note that cannot be claimed or written changes nothing.
 */
async function noteSkip(deps: PrStatusDeps, decision: Extract<PrDecision, { move: true }>, result: Skipped): Promise<"written" | "duplicate" | "skipped" | "failed"> {
  if (result.status === "not_connected") return "skipped";
  const statuses = statusNames(deps.env);
  const target = decision.stage === "in_review" ? statuses.inReview : statuses.done;
  const expected = decision.stage === "in_review" ? statuses.inProgress : `a factory status before ${statuses.done}`;
  const current = result.status === "skipped_status" ? result.current : undefined;
  const body = prStatusNote({ issueKey: decision.issueKey, pr: decision.pr, target, expected, skipped: result });
  const key = prStatusNoteKey({ issueKey: decision.issueKey, stage: decision.stage, pr: decision.pr, outcome: result.status, ...(current === undefined ? {} : { current }) });
  // Plain read then put, with no owner and no settle (accepted, KV Phase 1
  // K3): the note runs only after the move claim above, so a race needs two
  // deliveries past that claim, and the worst case is one repeated note.
  try {
    if (supportsKvCas(deps.kv)) {
      if (!(await deps.kv.putIfAbsent(key, { at: deps.now().toISOString() })).ok) return "duplicate";
    } else {
      if ((await deps.kv.get(key)) !== undefined) return "duplicate";
      await deps.kv.put(key, { at: deps.now().toISOString() });
    }
  } catch (error) {
    warnKv("pr-status.noteSkip.putIfAbsent", error);
    return "failed";
  }
  const written = await addComment(deps.mcp, { issueKey: decision.issueKey, body }).catch(() => undefined);
  if (written?.status === "commented") return "written";
  await deps.kv.delete(key).catch((error: unknown) => warnKv("pr-status.noteSkip.delete", error));
  return "failed";
}

/** The slice of July's pull_request hook arguments the decision reads. */
export type PrHookInput = {
  ctx: { repository: { fullName: string }; sender?: { login: string; type?: string }; payload: unknown };
  pr: { action: string; number: number; url: string; headRef: string; baseRef: string; title: string; authorLogin?: string; merged: boolean };
};

export function prDelivery({ ctx, pr }: PrHookInput): PrDelivery {
  const raw = rawPullRequestFacts(ctx.payload);
  return {
    action: pr.action,
    repository: ctx.repository.fullName,
    number: pr.number,
    url: pr.url,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    title: pr.title,
    ...(pr.authorLogin === undefined ? {} : { authorLogin: pr.authorLogin }),
    merged: pr.merged,
    ...(ctx.sender === undefined ? {} : { sender: { login: ctx.sender.login, ...(ctx.sender.type === undefined ? {} : { type: ctx.sender.type }) } }),
    ...(raw.mergedBy === undefined ? {} : { mergedBy: raw.mergedBy }),
    autoMerge: raw.autoMerge,
  };
}

/**
 * The GitHub channel's `onPullRequest`. Returns `{ task }` for a delivery
 * that moves a ticket, so the Jira work runs after the 202 with no model
 * turn, and `null` for everything else.
 */
export function prStatusDispatch(input: PrHookInput & { deps: PrStatusDeps }): { task: () => Promise<void> } | null {
  const { deps } = input;
  const log = deps.log ?? ((line: string) => console.log(line));
  const delivery = prDelivery(input);
  const base = { worker: "pr_status", pr: `${delivery.repository}#${delivery.number}`, action: delivery.action };
  let target: { sandboxRepo: string; sandboxRef: string };
  try {
    target = { sandboxRepo: sandboxRepo(deps.env), sandboxRef: sandboxRef(deps.env) };
  } catch (error) {
    if (!(error instanceof FactoryConfigError)) throw error;
    log(JSON.stringify({ ...base, outcome: "config_error", message: error.message }));
    return null;
  }
  const opts = { ...target, projects: jiraProjects(deps.env) };
  const decision = decidePullRequest(delivery, opts);
  const github = deps.github;
  const linkable = github === undefined ? undefined : linkablePullRequest(delivery, opts);
  const readyable = github === undefined ? undefined : readyablePullRequest({ ...delivery, ...draftFact(input.ctx.payload) }, opts);
  if (!decision.move) {
    log(JSON.stringify({ ...base, outcome: "ignored", reason: decision.reason, ...(decision.issueKey === undefined ? {} : { issueKey: decision.issueKey }) }));
    if (linkable === undefined && readyable === undefined) return null;
  }
  return {
    task: async () => {
      // Ready before In Review is announced, so Bugbot is already running when the thread links the PR.
      let leftDraft = false;
      if (readyable !== undefined && github !== undefined) {
        const result = await markReadyForReview({ kv: deps.kv, github, now: deps.now, ...(deps.readyRetryMs === undefined ? {} : { retryMs: deps.readyRetryMs }) }, readyable);
        leftDraft = readyFailed(result.outcome);
        const noted = leftDraft ? await noteNotReady(deps, { issueKey: readyable.issueKey, pr: base.pr, target: readyable, result }) : undefined;
        log(JSON.stringify({ worker: "pr_ready", issueKey: readyable.issueKey, pr: base.pr, action: delivery.action, mode: readyable.mode, ...result, ...(noted === undefined ? {} : { noted }) }));
      }
      if (linkable !== undefined && github !== undefined) {
        const outcome = await linkTicketInBody({ kv: deps.kv, mcp: deps.mcp, github }, linkable);
        log(JSON.stringify({ worker: "pr_body", issueKey: linkable.issueKey, pr: base.pr, action: delivery.action, outcome }));
      }
      if (decision.move) await advanceTicket(deps, decision);
      // After the move, so a redelivery finds it recorded and only retries the undraft.
      if (leftDraft) throw new PrStatusRetryableError("pull request left draft");
    },
  };
}

/** `pull_request.draft` from the raw body, when the body carries it. */
function draftFact(payload: unknown): { draft?: boolean } {
  const pullRequest = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>)["pull_request"] : undefined;
  const draft = pullRequest !== null && typeof pullRequest === "object" ? (pullRequest as Record<string, unknown>)["draft"] : undefined;
  return typeof draft === "boolean" ? { draft } : {};
}

/** `transitionFrom`, with a ticket already in the target status read as `already`. */
async function guarded(mcp: HostMcpRegistry, input: { issueKey: string; from: string; toStatus: string }): Promise<GuardedTransition> {
  const result = await transitionFrom(mcp, input);
  if (result.status === "skipped_status" && sameName(result.current, input.toStatus)) return { status: "already" };
  return result;
}

/** The statuses a merge walks through In Review to Done, nearest first. */
function beforeReview(statuses: StatusNames): string[] {
  return [statuses.inProgress, statuses.approved, statuses.planned, statuses.triaged, statuses.todo];
}

function sameName(a: string | undefined, b: string): boolean {
  return a !== undefined && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

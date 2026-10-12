import type { HostMcpRegistry, ReminderHostApi } from "@cursor/july";
import {
  claimImplementation,
  clearBoundAgent,
  LAUNCH_GRACE_MS,
  markLaunchSent,
  noteBoundAgent,
  parseClaim,
  readBoundAgent,
  recordLaunch,
  releaseImplementation,
  returnLaunchFailureNotice,
  takeLaunchFailureNotice,
  type BoundAgentRecord,
  type LaunchedClaim,
} from "./claim.js";
import { implementContinuation, startImplementTurn, type ImplementSessionState, type StartTurn } from "./implement-turn.js";
import { FactoryConfigError, jiraProjects, sandboxRef, sandboxRepo, statusNames, IMPLEMENT_MODEL, type ModelChoice } from "./config.js";
import {
  adoptedComment,
  decideApproved,
  extractBrief,
  implementingComment,
  latestPlanComment,
  launchFailedComment,
  launchPendingComment,
  launchSkippedComment,
  noBriefComment,
  relaunchedComment,
  staleApprovalComment,
  type LaunchPending,
} from "./decide.js";
import { implementClaimKey, launchNoteKey, type KeyedKv } from "./kv-keys.js";
import { armImplementPrWatch, ensureImplementPr, implementPrPending, type ArmResult, type ReadAgentRun } from "./implement-pr.js";
import { addComment, issueStatus, readComments, trackerUnusable, transitionFrom, transitionIssue, type CommentWrite, type GuardedTransition, type TransitionOutcome } from "./jira.js";
import {
  agentUrl,
  findLaunchedAgent,
  type AgentStatus,
  type RetireAgent,
  LAUNCH_LATE_WAIT_MS,
  launchFailureReason,
  launchImplementation,
  LaunchNotStartedError,
  LaunchTimeoutError,
  type CreateAgent,
  type Launched,
  type ListAgents,
} from "./launch.js";
import { armLaunchWatch, armOrphanLaunchWatch, closeLaunchWatch, openLaunchWatch, type LaunchArm, type WatchOpen } from "./launch-watch.js";
import type { ReadyApi } from "./pr-ready.js";
import { claimRun, ownedBy, type ClaimRun, type Sleep } from "./verified-claim.js";
import { verifyTrackerWebhook } from "./verify-webhook.js";
import { warnKv, warnOps, warnStep } from "./ops-funnel.js";

/** The header hosted admission sets on a replayed request, the same on every attempt of one delivery. */
export const DELIVERY_ID_HEADER = "x-agent-sdk-delivery-id";

// The worker's hot path in the order of the design's `factory-worker` block:
// verify, decide, brief, open the launch watch, claim, then launch, record,
// comment, transition. Everything after the claim runs inside `waitUntil`.
// Hosted admission replays the Jira POST after Jira already has its 202 and
// waits for that work before it replies; a handler 5xx or a rejected
// `waitUntil` is terminal there (channel_dispatch_failed,
// background_dispatch_failed) and is never redelivered. So nothing here
// relies on a redelivery: every verified approval either launches, or leaves
// a Jira comment saying why not, or leaves a launch watch that relaunches it
// (launch-watch.ts, launch-heal.ts). A launch that throws or passes its
// deadline releases the claim and posts one Launch failed: comment, deduped
// per changelog id; the retry is a person moving the ticket to Approved again.
// The ticket moves to In Progress only once its Implementing: comment is on
// it, because the desk reads the agent URL from that comment.
//
// A delivery's launch is a July cloud turn on the jira channel
// (implement-turn.ts): the claim is stamped `sentAt`, the channel's `send()`
// is called once inside `waitUntil` (hosted admission captures it and runs
// it after the reply), and the record, comment and move happen when the
// session's `agent.bound` event names the agent (`bound` below, wired by
// channels/jira.ts `events`); a `turn.failed` before that binding is the
// launch failure. The heal (`via: "heal"`), which runs from a reminder, has
// no `send` that could carry a cloud attach and launches through the SDK as
// before (launch.ts), with the same record, comment and move.
// The worker, not the agent, opens the implement PR (implement-pr.ts): a
// launch arms the reminder that opens it once the branch is pushed, and a
// later Approved delivery for a launched ticket (the desk's `retry KEY`)
// opens it at once when the branch is already there.

export type HandlerDeps = {
  kv: KeyedKv;
  mcp: HostMcpRegistry;
  /** `Agent.create`: the heal's launch, and a delivery's when no `send` is wired. */
  createAgent: CreateAgent;
  /**
   * The jira channel's `send`. Set, a delivery launches by starting a July
   * cloud turn on that channel (implement-turn.ts) and the record follows
   * from `agent.bound`; the hosted channel always wires it. Unset (the heal,
   * whose reminder has no cloud send; the SDK launch tests), a delivery
   * launches through `createAgent`.
   */
  send?: StartTurn;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  log?: (line: string) => void;
  /** `host.github`. With `readRun`, a redelivered approval opens the implement PR. */
  github?: ReadyApi;
  readRun?: ReadAgentRun;
  /** `host.reminders`, for the implement PR watch and the launch watch. */
  reminders?: ReminderHostApi;
  /** The implement PR watch's and launch watch's backstop sweep, run in `waitUntil` after every verified delivery. */
  backstop?: () => Promise<unknown>;
  /** The claim's settle wait (`FACTORY_CLAIM_SETTLE_MS`); a timer when unset. */
  sleep?: Sleep;
  /** The launch's deadline; launch.ts LAUNCH_TIMEOUT_MS when unset. */
  launchTimeoutMs?: number;
  /** How long a launch past its deadline is still awaited before the delivery leaves its claim pending; LAUNCH_LATE_WAIT_MS when unset. */
  launchLateWaitMs?: number;
  /**
   * `Agent.list`, for the positive check before a takeover launches
   * (launch.ts `findLaunchedAgent`), which sees agents the SDK heal named;
   * an agent July started is found by its `implement-agent/<KEY>` record
   * first (`existingAgent`). The hosted channel and reminder always wire
   * it; unset (tests), the ticket's `Implementing:` comment and that record
   * are the only checks.
   */
  listAgents?: ListAgents;
  /**
   * Cancel and archive an agent a launch started but may no longer record
   * (launch.ts `sdkRetireAgent`). Unset (tests), such an agent is only reported.
   */
  retireAgent?: RetireAgent;
  /**
   * `Agent.get`'s status (launch.ts `sdkAgentStatus`), read before a failed
   * implement turn is called a launch failure and before a takeover adopts
   * the agent its `implement-agent/<KEY>` record names. Unset (tests), a
   * failed turn's agent is unknown and a noted agent is adopted unchecked.
   */
  agentStatus?: AgentStatus;
};

export { LAUNCH_LATE_WAIT_MS };

export type HandlerContext = { waitUntil(promise: Promise<unknown>): void };

export type LaunchTransition = TransitionOutcome["status"] | "skipped_no_comment";

export type LaunchOutcome =
  | {
      ok: true;
      launched: true;
      issueKey: string;
      agentId: string;
      url: string;
      transition: LaunchTransition;
      comment: CommentWrite["status"] | "on_ticket";
      recorded: boolean;
      prWatch: ArmResult;
      adopted?: true;
    }
  | { ok: true; launched: false; issueKey: string; reason: string; detail?: string };

/** `delivery`: a verified Jira webhook. `heal`: the launch watch replaying an approval whose launch was lost. */
export type Via = "delivery" | "heal";

/**
 * `snapshot`: the status a delivery's body rendered when it was not Approved
 * (`stale_status`). The pipeline then asks Jira, as the heal always does,
 * and launches only while the ticket is Approved there.
 */
export type Approval = { issueKey: string; changelogId: string; title: string; via: Via; deliveryId?: string; attempt?: number; snapshot?: string };

export type ApprovalReply = { status: number; body: Record<string, unknown> };

/** Where the pipeline hands work that outlives its reply: `waitUntil` on a delivery, a list the heal awaits. */
export type Schedule = (work: Promise<unknown>) => void;

/** What July's `agent.bound` event carries (types.d.ts `SessionEventPayload`): the cloud agent's id, and its URL when the server gave one. */
export type BoundAgent = { sdkAgentId: string; url?: string | undefined };

/** What July's `turn.failed` event carries (types.d.ts `SessionEventPayload`). */
export type FailedTurn = { message: string; status?: "error" | "cancelled" | undefined };

/** What the failed turn's session context carries (types.d.ts `SessionInfo`): the cloud agent id once July bound it. */
export type FailedSession = { sdkAgentId?: string | undefined };

export type LaunchPipeline = {
  approve(approval: Approval, schedule: Schedule): Promise<ApprovalReply>;
  reportLaunchFailure(input: { issueKey: string; changelogId: string; reason: string }): Promise<Trace>;
  note(input: { issueKey: string; changelogId: string; kind: string; body: string }): Promise<Trace>;
  /** The implement session's `agent.bound`: record the agent, comment, move, arm the PR watch. Never rejects. */
  bound(state: ImplementSessionState, agent: BoundAgent): Promise<LaunchOutcome>;
  /** The implement session's `turn.failed`: a launch failure while the claim is still this launch's pending one and no live agent is found. Never rejects. */
  turnFailed(state: ImplementSessionState, failure: FailedTurn, session?: FailedSession): Promise<LaunchOutcome>;
};

type Target = { repo: string; ref: string; model: ModelChoice };

/**
 * What the record, comment and move need of a launch, and what a July
 * session carries for them (implement-turn.ts ImplementSessionState):
 * the approval, the claim's `at` and run, and `armed`, the launch watch the
 * delivery opened and the reminder it armed, for the decision line.
 */
type Settling = Approval & {
  at: string;
  retried: boolean;
  run: ClaimRun;
  armed: { watch?: WatchOpen; reminder?: LaunchArm };
};

/**
 * `takenOverAt`: the pending claim this one replaced, whose launch may have
 * started an agent. `comments`: the ticket as read.
 */
type Claimed = Settling & {
  brief: string;
  target: Target;
  comments: readonly string[];
  takenOverAt?: string;
};

/** What a trace comment did: posted, deduped for this approval, or failed. */
export type Trace = CommentWrite["status"] | "already_reported";

/** Where a deferred approval went: `watched` when a watch or reminder will retry it. */
type Deferred = { watched: boolean; trace?: Trace; reminder?: LaunchArm };

const GRACE_MINUTES = Math.ceil(LAUNCH_GRACE_MS / 60_000) + 1;

/** Clock skew between the pods that wrote a claim and handled the binding, allowed when matching a bound-agent record to a takeover's window. */
const BOUND_SKEW_MS = 5 * 60_000;

/**
 * Whether a bound-agent record belongs to a launch since `since` (the
 * replaced claim's `at`): its claim began then or later, or it was bound
 * then or later (a binding that landed after the claim was taken over). A
 * record whose times do not parse is not adopted.
 */
function boundSince(record: BoundAgentRecord, since: string): boolean {
  const from = Date.parse(since) - BOUND_SKEW_MS;
  const at = Date.parse(record.at);
  const boundAt = Date.parse(record.boundAt);
  if (!Number.isFinite(from)) return false;
  return (Number.isFinite(at) && at >= from) || (Number.isFinite(boundAt) && boundAt >= from);
}

export function createLaunchPipeline(deps: HandlerDeps): LaunchPipeline {
  const log = deps.log ?? ((line: string) => console.log(line));
  const decided = (fields: Record<string, unknown>) => log(JSON.stringify({ worker: "decision", ...fields }));

  async function moveToInProgress(issueKey: string): Promise<TransitionOutcome["status"]> {
    return (await transitionIssue(deps.mcp, { issueKey, toStatus: statusNames(deps.env).inProgress })).status;
  }

  // A repair moves only from Approved: a ticket someone has since moved on
  // (In Review, back to Planned) stays where they put it.
  async function repairMove(issueKey: string): Promise<GuardedTransition> {
    const statuses = statusNames(deps.env);
    return transitionFrom(deps.mcp, { issueKey, from: statuses.approved, toStatus: statuses.inProgress });
  }

  async function reportLaunchFailure(input: { issueKey: string; changelogId: string; reason: string }): Promise<Trace> {
    const { issueKey, changelogId, reason } = input;
    if (!(await takeLaunchFailureNotice(deps.kv, { issueKey, changelogId, now: deps.now() }))) return "already_reported";
    let status: CommentWrite["status"];
    try {
      status = (await addComment(deps.mcp, { issueKey, body: launchFailedComment(reason) })).status;
    } catch {
      status = "failed";
    }
    if (status !== "commented") await returnLaunchFailureNotice(deps.kv, { issueKey, changelogId });
    return status;
  }

  /** One trace comment per ticket, approval, and kind. Read then put, like the failure notice: the worst race is one repeat. */
  async function note(input: { issueKey: string; changelogId: string; kind: string; body: string }): Promise<Trace> {
    const key = launchNoteKey(input);
    try {
      if ((await deps.kv.get(key)) !== undefined) return "already_reported";
      await deps.kv.put(key, { at: deps.now().toISOString() });
    } catch (error) {
      // One extra comment beats none.
      warnKv("handle.note", error);
    }
    let status: CommentWrite["status"];
    try {
      status = (await addComment(deps.mcp, { issueKey: input.issueKey, body: input.body })).status;
    } catch {
      status = "failed";
    }
    if (status !== "commented") await deps.kv.delete(key).catch((error: unknown) => warnKv("handle.note.return", error));
    return status;
  }

  /**
   * A delivery that launched nothing on a failure a later try can fix: hand
   * it to the launch watch, whose reminder or the backstop retries it. With
   * no watch record (kv down) the reminder carries the approval itself. Only
   * when neither could be scheduled is it a Launch failed: the desk
   * announces; otherwise the ticket gets a Launch pending: line. The heal's
   * own replay keeps its watch and writes nothing here.
   */
  async function defer(input: { approval: Approval; kind: LaunchPending; watch: WatchOpen | undefined }): Promise<Deferred> {
    const { approval, kind, watch } = input;
    const { issueKey, changelogId, title } = approval;
    if (watch === undefined) return { watched: true };
    const { watched, reminder } = await retryLater({ approval, watch });
    // An in-flight claim is another delivery's launch, which its own watch covers; it is never a failure.
    const trace =
      watched || kind === "in_flight"
        ? await note({ issueKey, changelogId, kind, body: launchPendingComment({ issueKey, kind, graceMinutes: GRACE_MINUTES, timer: reminder === "armed" || reminder === "already" }) })
        : await reportLaunchFailure({ issueKey, changelogId, reason: kind });
    return { watched, trace, reminder };
  }

  /** Arm the watch's reminder, or with no watch record the orphan reminder that carries the approval. */
  async function retryLater(input: { approval: Approval; watch: WatchOpen }): Promise<{ watched: boolean; reminder: LaunchArm }> {
    const { issueKey, changelogId, title } = input.approval;
    const reminder =
      input.watch === "unavailable"
        ? await armOrphanLaunchWatch({ reminders: deps.reminders, now: deps.now }, { issueKey, changelogId, title, at: deps.now() })
        : await arm(issueKey);
    return { watched: input.watch !== "unavailable" || reminder === "armed", reminder };
  }

  /** 202 while a watch or reminder will retry (hosted admission never redelivers a non-2xx); 503 only when nothing could be scheduled. */
  function deferredReply(input: { deferred: Deferred; reason: LaunchPending; extra?: Record<string, unknown> }): ApprovalReply {
    const { deferred, reason } = input;
    return deferred.watched
      ? { status: 202, body: { ok: true, launched: false, reason, watched: true, ...input.extra } }
      : { status: 503, body: { ok: false, launched: false, reason, watched: false, ...input.extra } };
  }

  /** The connector is what failed, so no Jira comment can say so: ops Slack does. */
  async function connectorWarning(): Promise<Record<string, unknown>> {
    const unusable = await trackerUnusable(deps.mcp);
    if (unusable === undefined) return {};
    const message = unusable.serverState ?? unusable.message;
    warnOps({ site: "handle.tracker", kind: "Jira connector", reasonCode: unusable.reason, ...(message === undefined ? {} : { message }) });
    return { connector: unusable };
  }

  function arm(issueKey: string): Promise<LaunchArm> {
    return armLaunchWatch({ kv: deps.kv, reminders: deps.reminders, now: deps.now }, { issueKey });
  }

  function skipped(claimed: Settling, why: { reason: string; detail?: string }): LaunchOutcome {
    return { ok: true, launched: false, issueKey: claimed.issueKey, reason: why.reason, ...(why.detail === undefined ? {} : { detail: why.detail }) };
  }

  /** Whether this launch's own pending claim is still the ticket's (legacy mode, which stores no owner, goes by its `at`). */
  async function stillHolds(claimed: Settling): Promise<boolean> {
    try {
      const current = await deps.kv.get(implementClaimKey(claimed.issueKey));
      const held = parseClaim(current);
      if (held?.state !== "pending") return false;
      return claimed.run.mode === "legacy" ? held.at === claimed.at : ownedBy(current, claimed.run.owner);
    } catch (error) {
      warnKv("handle.stillHolds", error);
      return false;
    }
  }

  /**
   * A launch whose record was refused started an agent nothing records.
   * When the claim now names another agent, that one is the ticket's (the
   * heal may have adopted it, so it is never touched) and this one is
   * cancelled and archived. So is it when the claim is gone (the watch gave
   * up and cleared it): nothing can adopt it any more. When the claim cannot
   * be read, or names no agent yet (a takeover still deciding, which may
   * adopt this one), nothing is archived. Either way ops Slack hears it, because hosted logs are
   * unreadable and no Jira comment belongs to an agent the ticket does not use.
   * The ticket and agent ride as the alert's `subject`, so each orphan is its
   * own alert while the metric's reason stays one of four.
   */
  /** Cancel and archive an agent the ticket does not use (`retireAgent`); `reported` when none is wired. */
  async function retire(agentId: string): Promise<"archived" | "archive_failed" | "reported"> {
    if (deps.retireAgent === undefined) return "reported";
    try {
      await deps.retireAgent(agentId);
      return "archived";
    } catch (error) {
      warnStep("handle.orphaned.retire", error);
      return "archive_failed";
    }
  }

  /**
   * `record` is this binding's bound-agent record when `bound` has not
   * written it yet (a takeover's binding records the claim first, so the
   * replaced launch's record is still there for `retireLateBound`). A
   * `kept` agent then needs it, for the pending takeover to adopt; it is
   * written here, and the claim read again: a takeover that recorded
   * between the two reads looked for this record before it was written,
   * so this agent is the orphan and is retired here instead.
   */
  async function orphaned(claimed: Settling, launched: Launched, record?: BoundAgentRecord): Promise<string> {
    const { issueKey } = claimed;
    const readClaim = async (): Promise<{ claim: ReturnType<typeof parseClaim> } | undefined> => {
      try {
        return { claim: parseClaim(await deps.kv.get(implementClaimKey(issueKey))) };
      } catch (error) {
        warnKv("handle.orphaned", error);
        return undefined;
      }
    };
    const read = await readClaim();
    if (read === undefined) {
      warnOps({ site: "handle.orphan", kind: "unrecorded agent", reasonCode: "claim_unread", subject: `${issueKey} ${launched.agentId}`, message: `${issueKey}: ${launched.agentId} is not recorded and the claim could not be read; not archived` });
      return "claim_unread";
    }
    let current = read.claim;
    if (current?.state === "launched" && current.agentId === launched.agentId) return "same_agent";
    if (current !== undefined && current.state !== "launched") {
      if (record !== undefined) {
        const noted = await noteBoundAgent(deps.kv, { issueKey, record });
        if (noted !== "noted") decided({ outcome: "bound_unnoted", issueKey, changelogId: claimed.changelogId, via: claimed.via, agentId: launched.agentId });
        const again = await readClaim();
        if (again === undefined || again.claim?.state !== "launched") {
          // A takeover's pending claim: its `existingAgent` or `turnFailed` reads this agent from `implement-agent/<KEY>` and adopts it, or its `finish` retires it (`retireLateBound`).
          warnOps({ site: "handle.orphan", kind: "unrecorded agent", reasonCode: "kept", subject: `${issueKey} ${launched.agentId}`, message: `${issueKey}: ${launched.agentId} is not recorded; the claim is ${current.state}; not archived` });
          return "kept";
        }
        current = again.claim;
        if (current.agentId === launched.agentId) return "same_agent";
      } else {
        // A takeover's pending claim: its `existingAgent` or `turnFailed` reads this agent from `implement-agent/<KEY>` (`bound` wrote it first) and adopts it, or its `finish` retires it (`retireLateBound`).
        warnOps({ site: "handle.orphan", kind: "unrecorded agent", reasonCode: "kept", subject: `${issueKey} ${launched.agentId}`, message: `${issueKey}: ${launched.agentId} is not recorded; the claim is ${current.state}; not archived` });
        return "kept";
      }
    }
    const action = await retire(launched.agentId);
    // A retired agent must not be adopted from its record by a later takeover.
    await clearBoundAgent(deps.kv, { issueKey, owner: { agentId: launched.agentId } });
    const holder = current === undefined ? "no claim" : `claim ${current.agentId}`;
    warnOps({ site: "handle.orphan", kind: "unrecorded agent", reasonCode: action, subject: `${issueKey} ${launched.agentId} (${holder})`, message: `${issueKey}: ${launched.agentId} ${action}; ${current === undefined ? "the claim is gone" : `the claim names ${current.agentId}`}` });
    return action;
  }

  /**
   * The agent `implement-agent/<KEY>` names, when it was bound for a launch
   * since `since` (`boundSince`) and `Agent.get` does not report it in
   * `error` or `cancelled`; a dead agent's record is dropped and "none" lets
   * the caller go on. "unknown" is a record whose agent's status could not
   * be read: not adopted, not replaced.
   */
  async function adoptableBoundAgent(approval: Approval, since: string): Promise<{ found: Launched } | { found: "none" } | { found: "unknown"; agentId: string }> {
    const noted = await readBoundAgent(deps.kv, approval.issueKey);
    if (noted === undefined || !boundSince(noted, since)) return { found: "none" };
    const status = deps.agentStatus === undefined ? "running" : await deps.agentStatus(noted.agentId);
    if (status === "unknown") return { found: "unknown", agentId: noted.agentId };
    if (status !== "error" && status !== "cancelled") return { found: { agentId: noted.agentId, url: noted.url } };
    const cleared = await clearBoundAgent(deps.kv, { issueKey: approval.issueKey, owner: { agentId: noted.agentId } });
    decided({ outcome: "bound_agent_dead", issueKey: approval.issueKey, changelogId: approval.changelogId, via: approval.via, agentId: noted.agentId, agentStatus: status, cleared });
    return { found: "none" };
  }

  /**
   * An agent a lost launch already started, before a takeover launches:
   * the ticket's latest `Implementing:` URL; else the agent July bound to
   * the ticket's implement session since the replaced claim began
   * (`implement-agent/<KEY>`, written by `bound` before the claim, the only
   * trace of a July-started agent: launch.ts), adopted only while
   * `Agent.get` does not report it in `error` or `cancelled` (a failed
   * launch clears the record, but a clear can be missed, and a retry within
   * `BOUND_SKEW_MS` of the failure would otherwise adopt the dead agent);
   * else `findLaunchedAgent`, which sees the agents the SDK heal named.
   * Only a positive "none" lets a new create run: a record whose agent's
   * status cannot be read is "unknown", like a listing cut short.
   */
  async function existingAgent(claimed: Claimed, since: string): Promise<{ found: Launched; onTicket: boolean } | { found: "none" } | { found: "unknown"; why: string }> {
    for (let i = claimed.comments.length - 1; i >= 0; i -= 1) {
      const agentId = /^Implementing:\s*https:\/\/cursor\.com\/agents\/([A-Za-z0-9_-]+)/.exec(claimed.comments[i]?.trim() ?? "")?.[1];
      if (agentId !== undefined) return { found: { agentId, url: agentUrl(agentId) }, onTicket: true };
    }
    const noted = await adoptableBoundAgent(claimed, since);
    if (noted.found === "unknown") return { found: "unknown", why: `bound agent ${noted.agentId}: status unreadable` };
    if (noted.found !== "none") return { found: noted.found, onTicket: false };
    if (deps.listAgents === undefined) return { found: "none" };
    const listed = await findLaunchedAgent(deps.listAgents, { issueKey: claimed.issueKey, since: new Date(since) });
    return typeof listed.found === "string" ? (listed as { found: "none" } | { found: "unknown"; why: string }) : { found: listed.found, onTicket: false };
  }

  /**
   * The launch failed: release the claim, say so once, close the watch.
   * `agentId` is the agent this launch is known to have bound (a failed
   * turn's session). Only the record of that agent, or of this launch's
   * approval, is dropped: a retry whose binding is lost too must not adopt
   * a dead agent, while a record another launch wrote (a late binding of
   * the launch this one replaced, alive and the ticket's: `turnFailed` adopts it)
   * must survive this failure.
   */
  async function launchFailed(claimed: Settling, error: unknown, agentId?: string): Promise<LaunchOutcome> {
    const { issueKey, changelogId, at, retried, run, via, armed } = claimed;
    const released = await releaseImplementation(deps.kv, { issueKey, run });
    const recordCleared = await clearBoundAgent(deps.kv, { issueKey, owner: { ...(agentId === undefined ? {} : { agentId }), approval: { changelogId, at } } });
    const reason = error instanceof LaunchNotStartedError ? error.reason : launchFailureReason(error);
    const notice = await reportLaunchFailure({ issueKey, changelogId, reason });
    // The failure is on the ticket, so a person retries; a failure with no comment stays watched.
    const watch = notice === "commented" || notice === "already_reported" ? await closeLaunchWatch(deps, issueKey) : false;
    decided({ outcome: "launch_failed", issueKey, changelogId, via, retried, claimReleased: run.mode === "legacy" || released === "released", recordCleared, reason, notice, ...armed, watchClosed: watch, message: describe(error) });
    return skipped(claimed, { reason });
  }

  /**
   * A delivery's launch as a July cloud turn. The claim is stamped `sentAt`
   * first, so a replay of this delivery meets it as in flight and the heal
   * waits LAUNCH_SENT_GRACE_MS for the binding; then the channel's `send`
   * runs once, inside this delivery's `waitUntil`, which hosted admission
   * captures and starts after the reply. The record, comment and move
   * follow in `bound`, from the session's `agent.bound` event. A send July
   * refuses is a launch failure like a refused create.
   */
  async function dispatchTurn(claimed: Claimed, send: StartTurn): Promise<LaunchOutcome> {
    const { issueKey, changelogId, via, retried, armed } = claimed;
    const marked = await markLaunchSent(deps.kv, { issueKey, run: claimed.run, sentAt: deps.now() });
    if (marked === "lost") {
      // A takeover owns the ticket now; its own launch is the ticket's.
      decided({ outcome: "superseded", issueKey, changelogId, via, stage: "send", ...armed });
      return skipped(claimed, { reason: "superseded", detail: "before_send" });
    }
    // `unavailable`: the stamp may or may not be on the claim. The send still goes: a claim without it is lost after
    // LAUNCH_GRACE_MS, and a heal that takes it over adopts or retires the agent `bound` then reports as superseded.
    const continuation = implementContinuation({ issueKey, changelogId });
    const state: ImplementSessionState = { kind: "implement", issueKey, changelogId, title: claimed.title, at: claimed.at, owner: claimed.run.owner, retried, ...(claimed.takenOverAt === undefined ? {} : { takenOverAt: claimed.takenOverAt }) };
    try {
      await startImplementTurn(send, { issueKey, changelogId, title: claimed.title, brief: claimed.brief, ...claimed.target, state });
    } catch (error) {
      return await launchFailed(claimed, error);
    }
    decided({ outcome: "turn_sent", issueKey, changelogId, via, retried, continuation, sentMarked: marked === "marked", ...armed });
    return skipped(claimed, { reason: "turn_sent", detail: continuation });
  }

  /**
   * Launch, or adopt what a lost launch started, then record, comment, and
   * move. Never rejects: a rejected `waitUntil` would fail hosted
   * admission's Promise.all early, before the backstop in the same delivery.
   */
  async function actuate(claimed: Claimed): Promise<LaunchOutcome> {
    const { issueKey, changelogId, via, armed } = claimed;
    try {
      if (claimed.takenOverAt !== undefined) {
        const existing = await existingAgent(claimed, claimed.takenOverAt);
        if (existing.found === "unknown") {
          // No positive check, no create: the claim stays this run's pending and the watch retries after the grace.
          const trace = via === "delivery" ? await note({ issueKey, changelogId, kind: "agent_unverified", body: launchPendingComment({ issueKey, kind: "agent_unverified", graceMinutes: GRACE_MINUTES, timer: armed.reminder === "armed" || armed.reminder === "already" }) }) : undefined;
          decided({ outcome: "agent_unverified", issueKey, changelogId, via, why: existing.why, ...armed, ...(trace === undefined ? {} : { trace }) });
          return skipped(claimed, { reason: "agent_unverified", detail: existing.why });
        }
        if (existing.found !== "none") return await finish(claimed, { launched: existing.found, onTicket: existing.onTicket, adopted: true });
      }
      if (via === "delivery" && deps.send !== undefined) return await dispatchTurn(claimed, deps.send);
      let launched: Launched;
      try {
        launched = await launchImplementation(
          { createAgent: deps.createAgent, ...(deps.launchTimeoutMs === undefined ? {} : { timeoutMs: deps.launchTimeoutMs }) },
          { issueKey, title: claimed.title, brief: claimed.brief, ...claimed.target, idempotencyKey: implementClaimKey(issueKey) }
        );
      } catch (error) {
        if (!(error instanceof LaunchTimeoutError)) return await launchFailed(claimed, error);
        // Not a failure: the create may still answer. Keep the claim, the watch, and no Launch failed: line.
        const late = await settleWithin(error.late, deps.launchLateWaitMs ?? LAUNCH_LATE_WAIT_MS);
        if (late.status === "failed") return await launchFailed(claimed, late.error);
        if (late.status === "pending") {
          // A later answer in this process is still recorded; if the process is parked first, the heal adopts the agent.
          void error.late.then(
            (value) => finish(claimed, { launched: value, onTicket: false, adopted: false, ...(claimed.takenOverAt === undefined ? {} : { since: claimed.takenOverAt }) }),
            // A failure after this delivery returned is said only while this launch still holds the claim: a heal may own it now.
            async (lateError: unknown) => ((await stillHolds(claimed)) ? launchFailed(claimed, lateError) : decided({ outcome: "late_failure_superseded", issueKey, changelogId, via, message: describe(lateError) })),
          ).catch(() => undefined);
          decided({ outcome: "launch_timeout", issueKey, changelogId, via, claimKept: true, ...armed });
          return skipped(claimed, { reason: "launch_timeout" });
        }
        launched = late.value;
      }
      return await finish(claimed, { launched, onTicket: false, adopted: false, ...(claimed.takenOverAt === undefined ? {} : { since: claimed.takenOverAt }) });
    } catch (error) {
      decided({ outcome: "actuate_threw", issueKey, changelogId, via, message: describe(error) });
      return skipped(claimed, { reason: "threw" });
    }
  }

  /**
   * The `kept` race, closed from the other side: a takeover's `existingAgent`
   * read no record, then a binding wrote one and its `recordLaunch` met the
   * takeover's pending claim (`orphaned` → `kept`, trusting the takeover to
   * adopt it), and the takeover then launched its own agent and recorded
   * that. Once this launch is recorded, a record naming another agent bound
   * since the takeover is that unrecorded agent: retire it and drop the
   * record, as `orphaned` does when the order is the other way round.
   * The record is read after the claim was written and before this launch
   * writes its own record (`bound` on a takeover): a binding that read the
   * claim before this write is seen here, one that reads it after sees the
   * launched claim and retires itself (`orphaned`), so neither is missed.
   */
  async function retireLateBound(claimed: Settling, launched: Launched, since: string): Promise<void> {
    const noted = await readBoundAgent(deps.kv, claimed.issueKey);
    if (noted === undefined || noted.agentId === launched.agentId || !boundSince(noted, since)) return;
    const action = await retire(noted.agentId);
    const cleared = await clearBoundAgent(deps.kv, { issueKey: claimed.issueKey, owner: { agentId: noted.agentId } });
    warnOps({ site: "handle.orphan", kind: "unrecorded agent", reasonCode: action, subject: `${claimed.issueKey} ${noted.agentId} (claim ${launched.agentId})`, message: `${claimed.issueKey}: ${noted.agentId} ${action}; it was bound after the takeover looked and the claim names ${launched.agentId}` });
    decided({ outcome: "late_bound_retired", issueKey: claimed.issueKey, changelogId: claimed.changelogId, via: claimed.via, agentId: noted.agentId, keptAgentId: launched.agentId, action, cleared });
  }

  /**
   * Record, comment, move, arm the PR watch: only while this launch still
   * holds the claim (`recordLaunch`). `since` is a takeover's window, for
   * `retireLateBound`. `record` is this binding's bound-agent record when
   * `bound` left it for after the claim (a takeover): written once the
   * late agent, if any, is retired, or by `orphaned` when kept.
   */
  async function finish(claimed: Settling, found: { launched: Launched; onTicket: boolean; adopted: boolean; since?: string; record?: BoundAgentRecord }): Promise<LaunchOutcome> {
    const { issueKey, changelogId, at, retried, run, via, armed } = claimed;
    const { launched, onTicket, adopted, since, record } = found;
    let claim: LaunchedClaim = { state: "launched", at, agentId: launched.agentId, url: launched.url, commented: onTicket, moved: false };
    const first = await recordLaunch(deps.kv, { issueKey, claim, run, stage: "launch" });
    if (first === "superseded") {
      const orphan = await orphaned(claimed, launched, record);
      decided({ outcome: "superseded", issueKey, changelogId, via, agentId: launched.agentId, orphan, ...armed });
      return skipped(claimed, { reason: "superseded", detail: orphan });
    }
    let recorded = first === "recorded";
    if (first === "recorded" && !adopted && since !== undefined) await retireLateBound(claimed, launched, since);
    if (record !== undefined) {
      // Written after the retire above (which drops the late agent's record), and even when the claim write was `unavailable`: the heal that takes this claim over adopts the agent from it.
      const noted = await noteBoundAgent(deps.kv, { issueKey, record });
      if (noted !== "noted") decided({ outcome: "bound_unnoted", issueKey, changelogId, via, agentId: launched.agentId });
    }
    const body = adopted ? adoptedComment(launched.url) : via === "heal" ? relaunchedComment({ url: launched.url, attempt: claimed.attempt ?? 1 }) : implementingComment(launched.url);
    const comment: CommentWrite["status"] | "on_ticket" = onTicket ? "on_ticket" : (await addComment(deps.mcp, { issueKey, body })).status;
    let transition: LaunchTransition = "skipped_no_comment";
    if (comment === "commented" || comment === "on_ticket") {
      claim = { ...claim, commented: true };
      if (!onTicket) recorded = (await recordLaunch(deps.kv, { issueKey, claim, run, stage: "update" })) === "recorded";
      transition = await moveToInProgress(issueKey);
      if (transition === "transitioned" || transition === "already") recorded = (await recordLaunch(deps.kv, { issueKey, claim: { ...claim, moved: true }, run, stage: "update" })) === "recorded";
    }
    // Anything short of a recorded, commented, moved launch stays watched, so the heal repairs it.
    const done = recorded && claim.commented && (transition === "transitioned" || transition === "already");
    const watchClosed = done ? await closeLaunchWatch(deps, issueKey) : false;
    const prWatch = await armImplementPrWatch({ kv: deps.kv, reminders: deps.reminders, now: deps.now, env: deps.env }, { issueKey, title: claimed.title });
    decided({ outcome: "launched", issueKey, changelogId, via, retried, agentId: launched.agentId, url: launched.url, transition, comment, recorded, prWatch, ...armed, watchClosed, ...(adopted ? { adopted: true } : {}) });
    return { ok: true, launched: true, issueKey, agentId: launched.agentId, url: launched.url, transition, comment, recorded, prWatch, ...(adopted ? { adopted: true as const } : {}) };
  }

  /** The launch a July session carries, as `finish` and `launchFailed` take it; the run is rebuilt around the claim's owner. */
  function settling(state: ImplementSessionState): Settling {
    const { issueKey, changelogId, title, at, retried } = state;
    return { issueKey, changelogId, title, via: "delivery", at, retried, run: claimRun(deps.env, { host: "worker", owner: state.owner, log }), armed: {} };
  }

  /** The agent `bound` noted for this very session (same approval and claim), when the event context did not carry it. */
  async function boundAgentOf(state: ImplementSessionState): Promise<string | undefined> {
    const noted = await readBoundAgent(deps.kv, state.issueKey);
    return noted !== undefined && noted.changelogId === state.changelogId && noted.at === state.at ? noted.agentId : undefined;
  }

  /**
   * July bound the implement session to its cloud agent: the same record,
   * comment, move and PR watch as a launch the SDK returned. The URL is built
   * from the id the way the SDK launch builds it (launch.ts `agentUrl`), so
   * the `Implementing:` line the desk and `existingAgent` read keeps its
   * shape. A record `recordLaunch` refuses (a takeover owns the ticket) ends
   * in `orphaned`, which retires this agent when the claim names another.
   *
   * A first launch's agent goes to `implement-agent/<KEY>` first, before
   * the claim is read or written: it is the only trace of a July-started
   * agent the worker can read back (launch.ts), so if this process dies in
   * `finish` or the record is refused or fails, the takeover that follows
   * adopts this agent (`existingAgent`) instead of starting a second one.
   *
   * A takeover's agent (`takenOverAt` set) is recorded the other way round:
   * the claim first, its record after (`finish`, or `orphaned` when kept).
   * The record may still be the replaced launch's agent, bound late during
   * this claim, and writing over it before the claim is written would hide
   * that agent from `retireLateBound`. The window a crash leaves unrecorded
   * is the claim write alone: the heal that follows reads an agent still
   * unbound as absent and starts another, as a lost `agent.bound` would.
   */
  async function bound(state: ImplementSessionState, agent: BoundAgent): Promise<LaunchOutcome> {
    const claimed = settling(state);
    try {
      const launched: Launched = { agentId: agent.sdkAgentId, url: agentUrl(agent.sdkAgentId) };
      const record: BoundAgentRecord = { agentId: launched.agentId, url: launched.url, changelogId: state.changelogId, at: state.at, boundAt: deps.now().toISOString() };
      if (state.takenOverAt !== undefined) return await finish(claimed, { launched, onTicket: false, adopted: false, since: state.takenOverAt, record });
      const noted = await noteBoundAgent(deps.kv, { issueKey: state.issueKey, record });
      if (noted !== "noted") decided({ outcome: "bound_unnoted", issueKey: state.issueKey, changelogId: state.changelogId, via: "delivery", agentId: launched.agentId });
      return await finish(claimed, { launched, onTicket: false, adopted: false });
    } catch (error) {
      decided({ outcome: "bound_threw", issueKey: state.issueKey, changelogId: state.changelogId, via: "delivery", agentId: agent.sdkAgentId, message: describe(error) });
      return skipped(claimed, { reason: "threw" });
    }
  }

  /**
   * The implement session's turn failed. Before `agent.bound` recorded an
   * agent (the claim is still this launch's pending one) that is the launch
   * failing: July could not start the cloud agent, so the claim is released
   * and one `Launch failed:` line names the reason, as a refused create
   * does. After the binding the agent ran and stopped on its own; the SDK
   * launch never saw that either, and the implement PR watch
   * (implement-pr.ts `readRun`) reports a run that ended with no branch.
   *
   * A turn can fail while its agent is fine: the pod's `CURSOR_API_KEY` is
   * a 60-minute token, so a build past an hour ends its turn with an
   * auth error mid-stream while the cloud agent keeps running (the token
   * lives on the serve pod, not in the agent's VM), and a stream cut on a
   * pod replacement reads the same way. So when the session or the
   * ticket's bound-agent record names an agent, its real status is read
   * first (`Agent.get`), and a running or finished agent is never called a
   * failed launch: the claim is left as it is (still pending only when
   * `bound` could not record it, which the heal repairs by adopting that
   * agent) and nothing is posted. A status that could not be read is left
   * alone too: the heal takes the claim over after the sent grace and
   * does the positive check itself. Only an agent in `error` (or
   * `cancelled`), or no agent at all, is a launch failure.
   *
   * A takeover's turn can fail with no live agent of its own while the
   * launch it replaced bound one late, during this claim (`orphaned` kept
   * it for this takeover to adopt). That agent is the ticket's: it is adopted
   * here (`turn_failed_late_bound`, the same record, comment and move as
   * `existingAgent`'s adoption), not reported as a failed launch, and the
   * release of a real failure drops only this launch's own record.
   */
  async function turnFailed(state: ImplementSessionState, failure: FailedTurn, session: FailedSession = {}): Promise<LaunchOutcome> {
    const claimed = settling(state);
    const { issueKey, changelogId } = state;
    try {
      if (!(await stillHolds(claimed))) {
        decided({ outcome: "turn_failed_after_launch", issueKey, changelogId, via: "delivery", status: failure.status ?? "error", message: failure.message });
        return skipped(claimed, { reason: "turn_failed_after_launch" });
      }
      const agentId = session.sdkAgentId ?? (await boundAgentOf(state));
      if (agentId !== undefined) {
        const status = deps.agentStatus === undefined ? "unknown" : await deps.agentStatus(agentId);
        if (status !== "error" && status !== "cancelled") {
          const outcome = status === "unknown" ? "turn_failed_status_unknown" : "turn_failed_agent_alive";
          decided({ outcome, issueKey, changelogId, via: "delivery", agentId, agentStatus: status, status: failure.status ?? "error", message: failure.message });
          return skipped(claimed, { reason: outcome, detail: agentId });
        }
      }
      if (state.takenOverAt !== undefined) {
        // This launch's own agent is dead or never was; the one the replaced launch bound late, if alive, is the ticket's.
        const late = await adoptableBoundAgent(claimed, state.takenOverAt);
        if (late.found === "unknown") {
          decided({ outcome: "turn_failed_status_unknown", issueKey, changelogId, via: "delivery", agentId: late.agentId, agentStatus: "unknown", status: failure.status ?? "error", message: failure.message });
          return skipped(claimed, { reason: "turn_failed_status_unknown", detail: late.agentId });
        }
        if (late.found !== "none") {
          decided({ outcome: "turn_failed_late_bound", issueKey, changelogId, via: "delivery", agentId: late.found.agentId, status: failure.status ?? "error", message: failure.message });
          return await finish(claimed, { launched: late.found, onTicket: false, adopted: true });
        }
      }
      const reason = failure.status === "cancelled" ? "cancelled" : launchFailureReason(new Error(failure.message));
      return await launchFailed(claimed, new LaunchNotStartedError({ message: failure.message, reason }), agentId);
    } catch (error) {
      decided({ outcome: "turn_failed_threw", issueKey, changelogId, via: "delivery", message: describe(error) });
      return skipped(claimed, { reason: "threw" });
    }
  }

  /**
   * A later Approved delivery for a launched ticket: open the implement PR
   * when the agent's branch is there (or reuse the open one), else watch for
   * it, and after any failure a retry could fix. Runs after the move back to
   * In Progress, so the In Review move that follows the PR can land. Never throws.
   */
  async function reconcilePullRequest(input: { issueKey: string; title: string; brief: string; github: ReadyApi; readRun: ReadAgentRun }): Promise<void> {
    const { issueKey } = input;
    try {
      const result = await ensureImplementPr(
        { kv: deps.kv, mcp: deps.mcp, env: deps.env, now: deps.now, github: input.github, readRun: input.readRun, log },
        { issueKey, title: input.title, brief: input.brief }
      );
      const prWatch = implementPrPending(result) ? await armImplementPrWatch({ kv: deps.kv, reminders: deps.reminders, now: deps.now, env: deps.env }, { issueKey, title: input.title }) : undefined;
      log(JSON.stringify({ worker: "implement_pr", via: "approved", issueKey, ...result, ...(prWatch === undefined ? {} : { prWatch }) }));
    } catch (error) {
      log(JSON.stringify({ worker: "implement_pr", via: "approved", issueKey, outcome: "threw", message: describe(error) }));
    }
  }

  async function duplicate(input: { approval: Approval; claim: LaunchedClaim; comments: string[]; run: ClaimRun }): Promise<ApprovalReply> {
    const { run } = input;
    const { approval } = input;
    const { issueKey, changelogId, via } = approval;
    let claim = input.claim;
    const body = implementingComment(claim.url);
    const onTicket = input.comments.some((comment) => comment.includes(body));
    const reposted = !onTicket && (await addComment(deps.mcp, { issueKey, body })).status === "commented";
    // A repost is its own trace; otherwise say why this approval started nothing.
    const skipNote = async (): Promise<Trace | undefined> =>
      via === "delivery" && !reposted ? note({ issueKey, changelogId, kind: "duplicate", body: launchSkippedComment({ issueKey, url: claim.url }) }) : undefined;
    const traced = (trace: Trace | undefined) => (trace === undefined ? {} : { trace });
    if (!claim.commented) {
      if (!onTicket && !reposted) {
        const trace = await skipNote();
        decided({ outcome: "duplicate", issueKey, changelogId, via, reposted, transition: "skipped_no_comment", ...traced(trace) });
        return { status: 200, body: { ok: true, duplicate: true, issueKey, reposted, transition: "skipped_no_comment" } };
      }
      claim = { ...claim, commented: true };
      await recordLaunch(deps.kv, { issueKey, claim, run, stage: "update" });
    }
    // Even after a recorded move: a ticket that drifted back and was approved
    // again never relaunches, so without this it would sit in Approved.
    const move = await repairMove(issueKey);
    const moved = move.status === "transitioned" || move.status === "already";
    // The agent's URL is on the ticket and the ticket is not left in Approved: nothing is left to repair.
    const watchClosed = moved || move.status === "skipped_status" ? await closeLaunchWatch(deps, issueKey) : false;
    const trace = await skipNote();
    if (claim.moved && !moved) {
      decided({ outcome: "duplicate", issueKey, changelogId, via, reposted, watchClosed, ...traced(trace) });
      return { status: 200, body: { ok: true, duplicate: true, issueKey, reposted } };
    }
    const recorded = moved ? (await recordLaunch(deps.kv, { issueKey, claim: { ...claim, moved: true }, run, stage: "update" })) === "recorded" : false;
    decided({ outcome: "duplicate", issueKey, changelogId, via, reposted, transition: move.status, recorded, watchClosed, ...traced(trace), ...("current" in move ? { current: move.current } : {}) });
    return { status: 200, body: { ok: true, duplicate: true, issueKey, reposted, transition: move.status } };
  }

  async function approve(approval: Approval, schedule: Schedule): Promise<ApprovalReply> {
    const { issueKey, changelogId, title, via } = approval;
    const delivery = via === "delivery";

    let target: Target;
    try {
      target = { repo: sandboxRepo(deps.env), ref: sandboxRef(deps.env), model: IMPLEMENT_MODEL };
    } catch (error) {
      if (!(error instanceof FactoryConfigError)) throw error;
      const trace = await reportLaunchFailure({ issueKey, changelogId, reason: "config" });
      await closeLaunchWatch(deps, issueKey);
      decided({ outcome: "config_error", issueKey, changelogId, via, trace, message: error.message });
      return { status: 500, body: { ok: false, launched: false, reason: "config", message: error.message } };
    }

    const { snapshot } = approval;
    if (!delivery || snapshot !== undefined) {
      // The heal has no webhook body, and a stale body's snapshot is not the ticket: Jira decides.
      const tag = snapshot === undefined ? {} : { snapshot };
      const status = await issueStatus(deps.mcp, issueKey);
      if (status.status !== "read") {
        // A delivery opens the watch, whose heal reads the status again after the grace.
        const connector = await connectorWarning();
        const watch = delivery ? await openLaunchWatch(deps.kv, { issueKey, changelogId, title, now: deps.now(), env: deps.env }) : undefined;
        const deferred = await defer({ approval, kind: "status_unreadable", watch });
        decided({ outcome: "status_unreadable", issueKey, changelogId, via, ...tag, tracker: status.status, ...connector, ...deferred });
        return deferredReply({ deferred, reason: "status_unreadable" });
      }
      if (status.name.trim().toLowerCase() !== statusNames(deps.env).approved.trim().toLowerCase()) {
        const watchClosed = await closeLaunchWatch(deps, issueKey);
        // A delivery whose ticket really left Approved says so once; the heal only closes its watch.
        const trace = delivery ? await note({ issueKey, changelogId, kind: "stale_status", body: staleApprovalComment({ issueKey, current: status.name }) }) : undefined;
        decided({ outcome: delivery ? "ignored" : "not_approved", ...(delivery ? { reason: "stale_status" } : {}), issueKey, changelogId, via, ...tag, current: status.name, watchClosed, ...(trace === undefined ? {} : { trace }) });
        return { status: 200, body: delivery ? { ok: true, ignored: true, reason: "stale_status" } : { ok: true, launched: false, reason: "not_approved", current: status.name } };
      }
    }

    const read = await readComments(deps.mcp, issueKey);
    if (read.status !== "read") {
      const connector = await connectorWarning();
      const watch = delivery ? await openLaunchWatch(deps.kv, { issueKey, changelogId, title, now: deps.now(), env: deps.env }) : undefined;
      const deferred = await defer({ approval, kind: "comments_unreadable", watch });
      decided({ outcome: "comments_unreadable", issueKey, changelogId, via, tracker: read.status, ...connector, ...deferred });
      return deferredReply({ deferred, reason: "comments_unreadable", extra: { tracker: read.status } });
    }
    const plan = latestPlanComment(read.comments, issueKey);
    const brief = plan === undefined ? undefined : extractBrief(plan);
    if (brief === undefined) {
      const comment = await addComment(deps.mcp, { issueKey, body: noBriefComment(issueKey) });
      if (comment.status === "commented") await closeLaunchWatch(deps, issueKey);
      // A refusal that could not be said stays watched: the heal reads the ticket again and says it, or launches a plan added since.
      const kept =
        comment.status !== "commented" && delivery
          ? await retryLater({ approval, watch: await openLaunchWatch(deps.kv, { issueKey, changelogId, title, now: deps.now(), env: deps.env }) })
          : undefined;
      decided({ outcome: "no_brief", issueKey, changelogId, via, comment: comment.status, ...(kept === undefined ? {} : kept) });
      return { status: 200, body: { ok: true, launched: false, reason: "no_brief", ...(kept === undefined ? {} : { watched: kept.watched }) } };
    }

    const now = deps.now();
    const watch = delivery ? await openLaunchWatch(deps.kv, { issueKey, changelogId, title, now, env: deps.env }) : undefined;
    const run = claimRun(deps.env, { host: "worker", log, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
    let takenOverAt: string | undefined;
    const claim = await claimImplementation(deps.kv, issueKey, {
      now,
      run,
      ...(approval.deliveryId === undefined ? {} : { deliveryId: approval.deliveryId }),
      onTakeover: (previousAt) => {
        takenOverAt = previousAt;
      },
    });

    if (claim.status === "unavailable") {
      // The put may have landed. Drop it (only while it is this delivery's); what the drop cannot reach, the watch retakes after the grace.
      const released = run.mode === "verified" ? await releaseImplementation(deps.kv, { issueKey, run }) : undefined;
      // kv-verified reports most of these itself, but not a put overwritten on every attempt; the hourly dedupe keeps it to one line.
      warnOps({ site: "handle.claim", kind: "launch claim", reasonCode: "claim_unavailable" });
      const deferred = await defer({ approval, kind: "claim_unavailable", watch });
      decided({ outcome: "claim_unavailable", issueKey, changelogId, via, ...(released === undefined ? {} : { released }), ...deferred });
      return deferredReply({ deferred, reason: "claim_unavailable" });
    }
    if (claim.status === "unconfirmed" || claim.status === "in_flight") {
      const kind = claim.status;
      const deferred = await defer({ approval, kind, watch });
      decided({ outcome: kind, issueKey, changelogId, via, ...deferred });
      return { status: 200, body: { ok: true, duplicate: true, issueKey, ...(kind === "in_flight" ? { inFlight: true } : { unconfirmed: true }) } };
    }
    if (claim.status === "launched") {
      const reply = await duplicate({ approval, claim: claim.claim, comments: read.comments, run });
      const { github, readRun } = deps;
      if (github !== undefined && readRun !== undefined) schedule(reconcilePullRequest({ issueKey, title, brief, github, readRun }));
      return reply;
    }

    // Armed before the launch, so a launch lost with its process still has its wake. A watch kv could not
    // confirm (its record or index entry) gets the orphan reminder that carries the approval instead.
    const reminder =
      watch === undefined
        ? undefined
        : watch === "unavailable"
          ? await armOrphanLaunchWatch({ reminders: deps.reminders, now: deps.now }, { issueKey, changelogId, title, at: now })
          : await arm(issueKey);
    const armed = { ...(watch === undefined ? {} : { watch }), ...(reminder === undefined ? {} : { reminder }) };
    schedule(actuate({ ...approval, brief, at: now.toISOString(), retried: claim.retried, target, run, armed, comments: read.comments, ...(claim.retried && takenOverAt !== undefined ? { takenOverAt } : {}) }));
    return { status: 202, body: { ok: true, launching: true, issueKey, ...(claim.retried ? { retried: true } : {}) } };
  }

  return { approve, reportLaunchFailure, note, bound, turnFailed };
}

export function createHandler(deps: HandlerDeps): (request: Request, ctx: HandlerContext) => Promise<Response> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const decided = (fields: Record<string, unknown>) => log(JSON.stringify({ worker: "decision", ...fields }));
  const pipeline = createLaunchPipeline({ ...deps, log });

  async function respond(request: Request, ctx: HandlerContext, onVerified: () => void): Promise<Response> {
    const rawBody = await request.text();
    const verified = verifyTrackerWebhook({
      rawBody,
      linearSignature: request.headers.get("linear-signature"),
      hubSignature: request.headers.get("x-hub-signature-256") ?? request.headers.get("x-hub-signature"),
      factoryWebhookSecret: request.headers.get("x-factory-webhook-secret"),
      authorization: request.headers.get("authorization"),
      // Jira only. A Linear-signed delivery has no secret here and is refused.
      linearSecret: undefined,
      jiraSecret: deps.env.JIRA_WEBHOOK_SECRET,
      nowMs: deps.now().getTime(),
    });
    if (!verified.ok) {
      decided({ outcome: "unauthorized" });
      return Response.json({ ok: false }, { status: verified.status });
    }
    onVerified();

    const decision = decideApproved(parseJson(rawBody), {
      approvedStatus: statusNames(deps.env).approved,
      projects: jiraProjects(deps.env),
    });
    const deliveryId = request.headers.get(DELIVERY_ID_HEADER) ?? undefined;
    if (!decision.launch && decision.reason === "stale_status") {
      // The body rendered another status (an Automation snapshot can lag the transition that fired it). Ask Jira before dropping it.
      const { issueKey, changelogId, title, current } = decision;
      const reply = await pipeline.approve(
        { issueKey, changelogId, title, via: "delivery", snapshot: current, ...(deliveryId === undefined ? {} : { deliveryId }) },
        (work) => ctx.waitUntil(work)
      );
      return Response.json(reply.body, { status: reply.status });
    }
    if (!decision.launch) {
      decided({ outcome: "ignored", reason: decision.reason });
      return Response.json({ ok: true, ignored: true, reason: decision.reason });
    }
    const reply = await pipeline.approve(
      { issueKey: decision.issueKey, changelogId: decision.changelogId, title: decision.title, via: "delivery", ...(deliveryId === undefined ? {} : { deliveryId }) },
      (work) => ctx.waitUntil(work)
    );
    return Response.json(reply.body, { status: reply.status });
  }

  return async (request, ctx) => {
    let verified = false;
    const response = await respond(request, ctx, () => {
      verified = true;
    });
    if (verified && deps.backstop !== undefined) ctx.waitUntil(deps.backstop());
    return response;
  };
}

type Settled<T> = { status: "ok"; value: T } | { status: "failed"; error: unknown } | { status: "pending" };

/** What `promise` did within `ms`, without leaving an unobserved rejection behind. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "pending" }), ms);
  });
  const settled = promise.then(
    (value): Settled<T> => ({ status: "ok", value }),
    (error: unknown): Settled<T> => ({ status: "failed", error })
  );
  try {
    return await Promise.race([settled, pending]);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

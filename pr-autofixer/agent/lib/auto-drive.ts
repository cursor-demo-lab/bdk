import { randomUUID } from "node:crypto";
import type { HostGitHubClient, JsonValue } from "@cursor/july";
import type { StartDriveResult } from "./start-drive.js";
import { jiraProjects } from "./config.js";
import { parsePrRef, type GithubPrRef } from "./drive.js";
import { CURSOR_BOT, issueKeyAtStart } from "./factory-pr-key.js";
import { leaseExpired, pendingLease, releaseLease, takeLease } from "./claim-lease.js";
import { VERIFY_ATTEMPTS, deleteVerified, readRetrying, sameJson, updateVerified, type RetryOptions, type VerifiedResult } from "./kv-verified.js";
import { FAILING_CONCLUSIONS, isBugbotFindings, isBugbotRunName } from "./webhook-routing.js";
import { autoDriveKey, bugbotRoundsKey, driveSessionKey, type KeyedKv, type KvKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { autoDriveKey, bugbotRoundsKey, driveSessionKey };

// Factory pull requests fix themselves. A PR the factory opened carries the
// ticket key at the start of its branch and its title (the brief demands
// it). When such a PR is not yet driven and a check goes red, the channel
// starts a drive itself instead of waiting for a person's `factory: drive`.
// Human-opened PRs keep the opt-in: the branch alone counts, and a title
// alone counts only when the Cursor bot opened the PR (platform
// autoCreatePR), the factory PR rule in factory-pr-key.ts. A
// person who titles a PR "TLSSN-1: ..." from any branch is not handing the
// fixer push access to it. Projects come from
// PR_AUTOFIXER_AUTO_DRIVE_PROJECTS when that variable is set, and an empty
// value turns the automatic drive off. When it is unset, projects come from
// FACTORY_JIRA_PROJECTS. An empty list means no automatic drive.

export const AUTO_DRIVE_PROJECTS_ENV = "PR_AUTOFIXER_AUTO_DRIVE_PROJECTS";
// check_run and status reach the channel only when red. Hosted v2 never
// forwards check_run and Actions never emit status, so on hosted the drive
// comes from check_suite or workflow_run, which carry every conclusion.
const FAILURE_EVENTS = new Set(["check_run", "status"]);
const CONCLUDED_EVENTS = new Set(["check_suite", "workflow_run"]);

export function isAutoDriveFailure(eventName: string, conclusion: string | undefined): boolean {
  if (FAILURE_EVENTS.has(eventName)) return true;
  return CONCLUDED_EVENTS.has(eventName) && conclusion !== undefined && FAILING_CONCLUSIONS.has(conclusion);
}

export function autoDriveProjects(env: NodeJS.ProcessEnv): string[] {
  return jiraProjects(env, AUTO_DRIVE_PROJECTS_ENV);
}

/** What woke the drive: a red check, or Bugbot's findings (a neutral Bugbot check). */
export type AutoDriveTrigger = "red_check" | "bugbot";

export function autoDriveTrigger(event: { eventName: string; conclusion?: string; checkName?: string }): AutoDriveTrigger | undefined {
  // First: a check_run counts as red by its event alone, and Bugbot's neutral run is findings, not a failure.
  if (isBugbotFindings(event)) return "bugbot";
  return isAutoDriveFailure(event.eventName, event.conclusion) ? "red_check" : undefined;
}

export type AutoDriveDecision =
  | { drive: true; issueKey: string; trigger: AutoDriveTrigger }
  | { drive: false; reason: "disabled" | "not_a_failure_event" | "not_a_factory_pr" | "title_only_from_person" };

/**
 * Only a red check on an undriven PR whose branch starts with an allowed
 * ticket key, or whose title does and `cursor[bot]` opened it. A keyed title
 * on a PR a person opened is `title_only_from_person`: the fixer would push
 * to that person's branch with no opt-in, so it does not drive.
 */
export function autoDriveDecision(input: {
  eventName: string;
  conclusion?: string;
  /** The check's GitHub App and check-run name, which tell Bugbot's neutral findings apart. */
  app?: string;
  checkName?: string;
  headRefName?: string | undefined;
  title?: string | undefined;
  /** The PR author's login. Undefined (a body without a user) never counts as the bot. */
  authorLogin?: string | undefined;
  projects: string[];
}): AutoDriveDecision {
  if (input.projects.length === 0) return { drive: false, reason: "disabled" };
  const trigger = autoDriveTrigger(input);
  if (trigger === undefined) return { drive: false, reason: "not_a_failure_event" };
  const fromBranch = issueKeyAtStart(input.headRefName, input.projects);
  if (fromBranch !== undefined) return { drive: true, issueKey: fromBranch, trigger };
  const fromTitle = issueKeyAtStart(input.title, input.projects);
  if (fromTitle === undefined) return { drive: false, reason: "not_a_factory_pr" };
  if (input.authorLogin !== CURSOR_BOT) return { drive: false, reason: "title_only_from_person" };
  return { drive: true, issueKey: fromTitle, trigger };
}

/** The first message of a drive the fixer started on its own, for what woke it. */
export function autoDriveBrief(decision: { issueKey: string; trigger: AutoDriveTrigger }): string {
  if (decision.trigger === "bugbot") {
    return `Bugbot reported findings on ${decision.issueKey}'s pull request, which the factory opened from an approved plan. Read Bugbot's unresolved review threads; fix each real bug with the smallest verified change and reply on its thread, or reply why it is not a bug. Do not change the plan's scope.`;
  }
  return `A check went red on ${decision.issueKey}'s pull request, which the factory opened from an approved plan. Make CI green; do not change the plan's scope.`;
}

/**
 * Hosted admission only delivers repositories bound with
 * `--cursor-events-repo`, so a factory PR (or a trusted person's `factory:
 * drive`) from a repository outside the fixer's list is a stale
 * `FACTORY_REPOS` secret, not a PR to skip. startDrive would refuse it as
 * `out_of_scope` and release the claim without a word, and every red check
 * or opt-in on the sandbox would end the same way. Fail the delivery.
 * `subject` names what asked for the drive, for the error.
 */
export function assertAutoDriveInScope(pr: GithubPrRef, repos: readonly string[], subject = "is a factory pull request"): void {
  const wanted = `${pr.owner}/${pr.repo}`.toLowerCase();
  if (repos.some((repo) => repo.toLowerCase() === wanted)) return;
  throw loud(`${pr.label} ${subject}, but ${pr.owner}/${pr.repo} is not in PR_AUTOFIXER_REPOS or FACTORY_REPOS (${repos.join(", ")}); no drive started`);
}

export type PrHead = { headRefName?: string; title?: string; authorLogin?: string };

/**
 * The branch, title, and author {@link autoDriveDecision} judges. REST, not
 * GraphQL: on hosted, github-proxy scopes each call by the repo in its URL,
 * and POST /graphql carries none, so the proxy answers 400.
 *
 * A read that fails is tried again over {@link CLAIM_RETRY_MS} (it runs
 * before the handler answers, like the claim). One that fails every time
 * throws: a PR that cannot be read cannot be judged, and reading it as "not
 * a factory PR" would skip a real factory PR's drive in silence, with
 * nothing to redeliver the red check.
 */
export async function fetchPrHead(input: { github: HostGitHubClient; pr: GithubPrRef; retryMs?: readonly number[] }): Promise<PrHead> {
  const pauses = input.retryMs ?? CLAIM_RETRY_MS;
  let failure: unknown;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const octokit = await input.github.getOctokit();
      const { data: pull } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: input.pr.owner,
        repo: input.pr.repo,
        pull_number: input.pr.number,
      });
      const authorLogin = pull.user?.login;
      return { headRefName: pull.head.ref, title: pull.title, ...(typeof authorLogin === "string" ? { authorLogin } : {}) };
    } catch (error) {
      failure = error;
      const pause = pauses[attempt];
      if (pause === undefined) break;
      await sleep(pause);
    }
  }
  const reason = failure instanceof Error ? failure.message : String(failure);
  throw loud(`could not read ${input.pr.label} from GitHub after ${pauses.length + 1} tries (${reason}); its red check was not judged, so no drive started`);
}

/**
 * The lease on a claim whose start has not answered. A start is one PR read,
 * one kv read and one send (seconds), tried at most three times over
 * {@link START_RETRY_MS}, then marked or released over at most
 * {@link SETTLE_RETRY_MS}: well under a minute. Ten minutes leaves margin
 * for a slow control-plane admission. An unmarked claim older than this is
 * abandoned, and the next red check or `factory: drive` retakes it.
 */
export const START_LEASE_MS = 10 * 60 * 1000;

/**
 * The lease once the drive started. A delivery-started drive writes no
 * affinity (its session is keyed `evt:`), so the claim is the only record
 * that an agent owns the PR; two hours keeps a second agent off it while the
 * first is likely still at work, and still frees a PR whose send the control
 * plane never ran.
 */
export const DRIVE_LEASE_MS = 2 * 60 * 60 * 1000;

// Nothing redelivers a GitHub event the fixer failed to act on: hosted
// delivery retries are not observable, and a lease only helps when something
// retries. So every kv write and the start itself are retried here, with a
// pause before each retry, and a site that still fails says so loudly (a
// console.error, and a thrown error where the delivery can show it).
/** Before the handler answers: 1.25 s of pauses, inside hosted admission's time budget, which July does not document. */
export const CLAIM_RETRY_MS: readonly number[] = [250, 1000];
/** A start that throws is tried three times, 5 s of pauses. */
export const START_RETRY_MS: readonly number[] = [1000, 4000];
/** Marking, stamping or releasing a claim: 7.5 s of pauses, far inside {@link START_LEASE_MS}. */
export const SETTLE_RETRY_MS: readonly number[] = [500, 2000, 5000];

/**
 * The pauses a delivery may spend from its PR read to its start's mark or
 * release. Hosted admission's budget, not GitHub's 10 s webhook timeout, is
 * what bounds a delivery, and July does not document it; plan gate G4
 * probes handlers that sleep up to 20 s, so nothing longer is known to pass.
 * Three quarters of that leaves 5 s for the kv round trips and the start's
 * own send. Worst cases, pinned with timers stubbed (auto-drive.test.ts, and
 * the whole delivery in channels/github-timing.test.ts): the PR read
 * ({@link fetchPrHead}) 1.25 s; a claim that holds 5.75 s (three
 * {@link CLAIM_RETRY_MS} loops and the settle), one that fails 5.0 s (four
 * loops, no settle); the start task {@link TASK_PAUSE_BUDGET_MS} 7.5 s (a
 * Bugbot round's record inside it retries without pauses). A claim that
 * fails never starts, so a delivery pauses 14.5 s at most, which is also the
 * sum of each phase's worst.
 */
export const ADMISSION_PAUSE_CAP_MS = 15_000;

/**
 * The start's retries and its mark or release share this many ms of pauses:
 * a start that already paused {@link START_RETRY_MS} leaves the mark or
 * release 2.5 s of {@link SETTLE_RETRY_MS}, not 7.5 s. A mark or release
 * that still fails leaves the claim to lapse after {@link START_LEASE_MS},
 * as it would after the full 7.5 s.
 */
export const TASK_PAUSE_BUDGET_MS = 7_500;

/**
 * How long a drive claim waits after its write before it re-reads itself
 * (claim-lease.ts `settleMs`), so of two openers that both read the key
 * empty only the last writer drives. Below half of every G4 probe from 5 s
 * up.
 */
export const CLAIM_SETTLE_MS = 2_000;

/**
 * The drive claim's settle, read per call: `FACTORY_FIXER_CLAIM_SETTLE_MS`
 * as whole ms from 0 (no settle, the claim as before K8) up to
 * {@link CLAIM_SETTLE_MS}; anything else keeps {@link CLAIM_SETTLE_MS}. The
 * override can only shorten the settle, so {@link ADMISSION_PAUSE_CAP_MS}
 * holds whatever it says.
 */
export function claimSettleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.FACTORY_FIXER_CLAIM_SETTLE_MS?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return CLAIM_SETTLE_MS;
  const ms = Number(raw);
  return ms <= CLAIM_SETTLE_MS ? ms : CLAIM_SETTLE_MS;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `pausesMs` cut so their sum stays within `budgetMs`; the last kept pause is shortened to fit. */
function withinBudget(input: { pausesMs: readonly number[]; budgetMs: number }): number[] {
  const kept: number[] = [];
  let left = input.budgetMs;
  for (const ms of input.pausesMs) {
    if (left <= 0) break;
    const pause = Math.min(ms, left);
    kept.push(pause);
    left -= pause;
  }
  return kept;
}

/**
 * kv-verified's own retries, run back to back inside a loop here that
 * already pauses; otherwise its default pauses would stack under this one's.
 */
const INNER_RETRY: RetryOptions = { pausesMs: [] };

/** Run `op` again after each pause while it reports `unavailable` (reads and lease releases). */
async function untilAvailable<T extends { status: string }>(op: () => Promise<T>, pausesMs: readonly number[]): Promise<T> {
  let result = await op();
  for (const ms of pausesMs) {
    if (result.status !== "unavailable") break;
    await sleep(ms);
    result = await op();
  }
  return result;
}

/**
 * Attempts and pauses for a verified write: the helper's own immediate
 * retries, then one more attempt after each pause.
 */
function verifiedRetry(pausesMs: readonly number[]): { attempts: number; pausesMs: number[] } {
  return { attempts: VERIFY_ATTEMPTS + pausesMs.length, pausesMs: [...Array<number>(VERIFY_ATTEMPTS - 1).fill(0), ...pausesMs] };
}

type Read = { status: "read"; value: JsonValue | undefined } | { status: "unavailable" };

function readUntilAvailable(kv: KeyedKv, key: KvKey, pausesMs: readonly number[]): Promise<Read> {
  return untilAvailable(async (): Promise<Read> => {
    const read = await readRetrying(kv, key, INNER_RETRY);
    return read.ok ? { status: "read", value: read.value } : { status: "unavailable" };
  }, pausesMs);
}

function loud(message: string): Error {
  console.error(`[pr-autofixer] auto-drive: ${message}`);
  return new Error(message);
}

type Claim = Record<string, JsonValue>;

function asClaim(value: unknown): Claim | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Claim) : undefined;
}

function claimField(value: unknown, field: "token" | "sessionId"): string | undefined {
  const found = asClaim(value)?.[field];
  return typeof found === "string" ? found : undefined;
}

/** A lease the drive has started under is judged by {@link DRIVE_LEASE_MS}. */
function leaseMsFor(value: unknown): number {
  return asClaim(value)?.["started"] === true ? DRIVE_LEASE_MS : START_LEASE_MS;
}

/**
 * Once per PR at a time, on a claim lease (lib/claim-lease.ts):
 * `{ state: "pending", owner, at }`, the owner a fresh token per claim. An
 * unmarked claim is retaken after {@link START_LEASE_MS}, a started one
 * after {@link DRIVE_LEASE_MS}. A start that fails outright releases the
 * claim, as do a drive turn that completes or fails, a failed session
 * (hooks/drive-claim.ts), and
 * closing the PR. A value that is not a lease (a claim written before
 * leases, or garbage) is cleared and retaken at once.
 *
 * Best effort, verified after write (lib/kv-verified.ts), then settled: the
 * claim waits {@link claimSettleMs} after its read-back and holds only if it
 * still reads this owner's lease. Two openers that both read an empty key
 * and both write yield one drive, whichever order their writes land in, as
 * long as the later write lands within the settle. The residual window is a
 * write slower than that: both drive. host.kv has no conditional write to
 * close it; the one-send-per-delivery limit bounds it to one extra start.
 * A settle re-read that fails every try holds the claim (fails open, one
 * log line): its read-back already verified it, and dropping it would drop
 * the drive with nothing to redeliver the event.
 *
 * Returns the claim's token when this caller holds the claim. When the
 * store stays unavailable through {@link CLAIM_RETRY_MS}, the claim may
 * have landed: it is released if the store lets it, or left pending to
 * expire, and this throws so the delivery fails visibly instead of
 * skipping. A claim the settle re-read finds gone (taken and released by
 * another delivery meanwhile) throws too.
 */
export async function claimAutoDrive(
  kv: KeyedKv,
  pr: GithubPrRef,
  at: string,
  retryMs: readonly number[] = CLAIM_RETRY_MS,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<string | undefined> {
  const key = autoDriveKey(pr);
  const seen = await readUntilAvailable(kv, key, retryMs);
  if (seen.status === "unavailable") throw loud(`host.kv unavailable claiming ${pr.label}; no drive started`);
  if (seen.value !== undefined && pendingLease(seen.value) === undefined) {
    const retry = verifiedRetry(retryMs);
    const cleared = await deleteVerified(kv, key, (current) => sameJson(current, seen.value), retry);
    if (cleared.status === "unavailable") throw loud(`host.kv unavailable clearing a non-lease claim on ${pr.label}; no drive started`);
  }
  const owner = randomUUID();
  const taken = await takeLease(kv, key, { owner, leaseMs: leaseMsFor(seen.value), now: new Date(at), pausesMs: retryMs, retry: INNER_RETRY });
  if (taken.status === "unavailable") {
    const released = await untilAvailable(() => releaseLease(kv, key, owner, { retry: INNER_RETRY }), retryMs);
    const left = released.status === "unavailable" ? `; the claim may be left pending until ${START_LEASE_MS / 60_000} minutes pass` : "";
    throw loud(`host.kv unavailable claiming ${pr.label}; no drive started${left}`);
  }
  if (taken.status !== "taken") return undefined;
  const settleMs = claimSettleMs(options.env ?? process.env);
  return settleMs > 0 ? settleClaim(kv, { pr, owner, settleMs }) : owner;
}

/** Re-read a claim `settleMs` after its verified write; see {@link claimAutoDrive}. */
async function settleClaim(kv: KeyedKv, input: { pr: GithubPrRef; owner: string; settleMs: number }): Promise<string | undefined> {
  const { pr, owner } = input;
  await sleep(input.settleMs);
  const read = await readRetrying(kv, autoDriveKey(pr), INNER_RETRY);
  if (!read.ok) {
    console.warn(JSON.stringify({ fixer: "auto_drive_claim", pr: pr.label, outcome: "settle_unread_held" }));
    return owner;
  }
  if (read.value === undefined) throw loud(`the claim on ${pr.label} was gone after its settle (another delivery took and released it); no drive started`);
  return pendingLease(read.value)?.owner === owner ? owner : undefined;
}

/**
 * Whether another drive holds a live claim on the PR, read without taking it.
 * A value that is not a lease, or a lapsed lease, is not held.
 */
export async function autoDriveClaimHeld(kv: KeyedKv, pr: GithubPrRef, now: Date): Promise<boolean> {
  const value = await kv.get(autoDriveKey(pr));
  const lease = pendingLease(value);
  return lease !== undefined && !leaseExpired(lease, leaseMsFor(value), now);
}

/**
 * Closing the PR ends any drive, so the claim goes whatever it holds:
 * `written` when this deleted it, `lost` when there was none. Throws when
 * the store stays unavailable; the claim then lapses with its lease.
 */
export async function releaseAutoDrive(kv: KeyedKv, pr: GithubPrRef, retryMs: readonly number[] = SETTLE_RETRY_MS): Promise<"written" | "lost"> {
  const retry = verifiedRetry(retryMs);
  const released = await deleteVerified(kv, autoDriveKey(pr), (current) => current !== undefined, retry);
  if (released.status === "unavailable") throw loud(`host.kv unavailable releasing the claim on closed ${pr.label}; it lapses with its lease`);
  return released.status;
}

/** The claim `owner` took, not yet stamped by any session. */
function stampable(value: unknown, owner: string): boolean {
  return pendingLease(value)?.owner === owner && claimField(value, "sessionId") === undefined;
}

/**
 * Record which session drives the PR, when its first turn starts. The
 * harness may replace the session title (the only place the PR is named)
 * before the turn ends, and a claim can be retaken while an old drive still
 * runs, so the release goes by session id and the claim's owner token. A
 * turn that started means the drive started, so the stamp marks the lease
 * started as well. Only the unstamped lease this stamp first read is
 * stamped: a lease another session owns, or one retaken since, is left
 * alone. A start's mark that overwrites the stamp is merged back by
 * whichever read-back sees the other's write; if neither does, the release
 * still finds the lease by its owner.
 */
export async function stampAutoDriveSession(kv: KeyedKv, pr: GithubPrRef, sessionId: string, retryMs: readonly number[] = SETTLE_RETRY_MS): Promise<VerifiedResult["status"]> {
  const key = autoDriveKey(pr);
  const seen = await readUntilAvailable(kv, key, retryMs);
  if (seen.status === "unavailable") {
    loud(`host.kv unavailable stamping ${pr.label} with ${sessionId}; a failure of this drive cannot release its claim`);
    return "unavailable";
  }
  const owner = pendingLease(seen.value)?.owner;
  if (owner === undefined || !stampable(seen.value, owner)) return "lost";
  const record: Claim = { pr: pr.label, token: owner };
  const retry = verifiedRetry(retryMs);
  const recorded = await updateVerified(kv, driveSessionKey(sessionId), (current) => (current === undefined || sameJson(current, record) ? record : undefined), retry);
  if (recorded.status !== "written") {
    if (recorded.status === "unavailable") loud(`host.kv unavailable recording ${sessionId} for ${pr.label}; a failure of this drive cannot release its claim`);
    return recorded.status;
  }
  const stamped = await updateVerified(
    kv,
    key,
    (current) => (stampable(current, owner) ? { ...asClaim(current), at: new Date().toISOString(), started: true, sessionId } : undefined),
    retry,
  );
  if (stamped.status === "unavailable") loud(`host.kv unavailable stamping ${pr.label} with ${sessionId}`);
  return stamped.status;
}

/**
 * Release the lease a failed drive session holds, and only that one: the
 * lease with this session's owner token, stamped with this session or not
 * stamped at all. An owner-matched verified delete: a retake whose write
 * lands between the release's read and its delete is removed (the residual
 * window), and that retaken drive runs with no claim until its own mark
 * finds the lease gone. When the store stays unavailable the session record
 * is kept, so a replayed failure can retry.
 */
export async function releaseAutoDriveForSession(kv: KeyedKv, sessionId: string, retryMs: readonly number[] = SETTLE_RETRY_MS): Promise<VerifiedResult["status"]> {
  const recordKey = driveSessionKey(sessionId);
  const record = await readUntilAvailable(kv, recordKey, retryMs);
  if (record.status === "unavailable") {
    loud(`host.kv unavailable reading ${recordKey}; the failed drive's claim lapses with its lease`);
    return "unavailable";
  }
  const label = asClaim(record.value)?.["pr"];
  const pr = typeof label === "string" ? parsePrRef(label) : undefined;
  const token = claimField(record.value, "token");
  if (pr === undefined || token === undefined) return "lost";
  const owns = (current: JsonValue | undefined) => {
    if (pendingLease(current)?.owner !== token) return false;
    const stampedBy = claimField(current, "sessionId");
    return stampedBy === undefined || stampedBy === sessionId;
  };
  const retry = verifiedRetry(retryMs);
  const released = await deleteVerified(kv, autoDriveKey(pr), owns, retry);
  if (released.status === "unavailable") {
    loud(`host.kv unavailable releasing ${pr.label} for failed ${sessionId}; the claim lapses with its lease`);
    return "unavailable";
  }
  const dropped = await deleteVerified(kv, recordKey, (current) => sameJson(current, record.value), retry);
  if (dropped.status === "unavailable") loud(`host.kv unavailable dropping ${recordKey}`);
  return released.status;
}

/**
 * Mark the lease this start took as started, from now. A lease that is gone
 * or has another owner was released or retaken while the start was in
 * flight, so it is not written back.
 */
async function markStarted(kv: KeyedKv, pr: GithubPrRef, owner: string, retryMs: readonly number[]): Promise<VerifiedResult["status"]> {
  const retry = verifiedRetry(retryMs);
  const result = await updateVerified(
    kv,
    autoDriveKey(pr),
    (current) => (pendingLease(current)?.owner === owner ? { ...asClaim(current), at: new Date().toISOString(), started: true } : undefined),
    retry,
  );
  return result.status;
}

export type AutoDriveRetry = { start?: readonly number[]; settle?: readonly number[] };

/**
 * Start the drive and, when nothing started, release the lease if this
 * start still owns it. The channel returns this promise as the delivery's
 * task, so the host keeps the delivery window open until the start has
 * answered. `start` answers `{ ok: false }` for a reference it refuses (the
 * lease is released, nothing retried) and may throw (retried over
 * {@link START_RETRY_MS}; when every try throws, the lease is released and
 * this rejects). A lease the store will not release is left pending to
 * expire, and this rejects. A started drive whose lease cannot be marked is
 * logged: the lease then lapses after {@link START_LEASE_MS} while the
 * drive runs. The start's pauses and the mark's or release's share
 * {@link TASK_PAUSE_BUDGET_MS}.
 *
 * Through a delivery's send, `started` means the send was captured, not that
 * the session exists; the handle cannot tell. A control-plane retry re-runs
 * admission and finds the claim, so if the send is never run the PR waits
 * out DRIVE_LEASE_MS, or until it is closed and reopened.
 */
export async function startAutoDrive(input: { start: () => Promise<StartDriveResult>; kv: KeyedKv; pr: GithubPrRef; claim: string; retryMs?: AutoDriveRetry }): Promise<void> {
  const startPauses = input.retryMs?.start ?? START_RETRY_MS;
  let started = false;
  let failure: unknown;
  let paused = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await input.start();
      started = result.ok && result.status === "started";
      failure = undefined;
      break;
    } catch (error) {
      failure = error;
      const pause = startPauses[attempt];
      if (pause === undefined) break;
      paused += pause;
      await sleep(pause);
    }
  }
  const settlePauses = withinBudget({ pausesMs: input.retryMs?.settle ?? SETTLE_RETRY_MS, budgetMs: TASK_PAUSE_BUDGET_MS - paused });
  if (started) {
    if ((await markStarted(input.kv, input.pr, input.claim, settlePauses)) === "unavailable") {
      loud(`host.kv unavailable marking ${input.pr.label} started; its claim lapses after ${START_LEASE_MS / 60_000} minutes while the drive runs`);
    }
    return;
  }
  const released = await untilAvailable(() => releaseLease(input.kv, autoDriveKey(input.pr), input.claim, { retry: INNER_RETRY }), settlePauses);
  if (released.status === "unavailable") throw loud(`host.kv unavailable releasing ${input.pr.label} after its start did not run; the claim lapses after ${START_LEASE_MS / 60_000} minutes`);
  if (failure !== undefined) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw loud(`start of ${input.pr.label} failed ${startPauses.length + 1} times (${reason}); the claim is released`);
  }
}

/** Automatic Bugbot fix rounds per pull request before a person has to look. */
export const BUGBOT_MAX_ROUNDS = 2;

type BugbotRounds = { shas: string[]; rounds: number; capNoted?: true };

export type BugbotRound = "drive" | "duplicate" | "cap_reached" | "capped";

/**
 * One Bugbot fix round per head, read before anything is sent: findings on a
 * head already handed to a round are a `duplicate` (a redelivery, or the
 * suite and the run for the same push). A new head goes until
 * BUGBOT_MAX_ROUNDS; the next one is `cap_reached` once (the caller notes it
 * on the PR, so that is recorded here), then `capped`. A round is spent only
 * by {@link recordBugbotRound}, once the follow-up or drive actually went, so
 * a send that fails leaves the head free to retry and the cap note true. A kv
 * that fails lets the round through: the drive claim still keeps one agent
 * on the PR.
 *
 * The cap note is a verified merge that ORs `capNoted` into what the key
 * holds then: a rival that noted the cap (or took this head) since the first
 * read turns this into `capped` (or `duplicate`), so two peeks post one note.
 * A merge that finds the record deleted meanwhile (the PR closed) reads
 * again and answers round 0. A merge the store will not verify, or whose
 * second read fails, still answers `cap_reached`, as before.
 * `FACTORY_FIXER_ROUNDS_MERGE=off` (read per call) puts back the plain put.
 */
export async function peekBugbotRound(
  kv: KeyedKv,
  input: { pr: GithubPrRef; headSha: string | undefined; env?: NodeJS.ProcessEnv; retry?: RetryOptions }
): Promise<BugbotRound> {
  const stored = await readStoredRounds(kv, input.pr);
  if (stored === undefined) return "drive";
  const current = parseRounds(stored.value);
  const sha = shaOf(input.headSha);
  const round = roundFor({ rounds: current, sha });
  const mergeOn = roundsMergeOn(input.env ?? process.env);
  if (round === "drive" && mergeOn && stored.value === undefined) await markRoundsOpen(kv, input.pr);
  if (round !== "cap_reached") return round;
  if (!mergeOn) {
    await kv.put(bugbotRoundsKey(input.pr), { ...current, shas: [...current.shas, sha], capNoted: true }).catch((error: unknown) => warnKv("auto-drive.peekBugbotRound", error));
    return "cap_reached";
  }
  // `capNotedBy` tells this peek's note apart from a rival's once a rival's
  // round has been merged onto it; readers before K8 ignore the field.
  const token = randomUUID();
  const noted = await updateVerified(
    kv,
    bugbotRoundsKey(input.pr),
    (stored) => {
      if (stored !== undefined && asClaim(stored)?.["capNotedBy"] === token) return stored;
      const rounds = parseRounds(stored);
      if (roundFor({ rounds, sha }) !== "cap_reached") return undefined;
      return { ...asClaim(stored), ...rounds, shas: [...rounds.shas, sha], capNoted: true, capNotedBy: token };
    },
    input.retry
  );
  if (noted.status !== "lost") return "cap_reached";
  if (noted.current !== undefined) return roundFor({ rounds: parseRounds(noted.current), sha });
  // Lost with nothing stored: the record was deleted (the PR closed) or
  // every attempt was overwritten. A read that finds it gone is round 0.
  const reread = await readRetrying(kv, bugbotRoundsKey(input.pr), input.retry);
  if (!reread.ok) return "cap_reached";
  return roundFor({ rounds: parseRounds(reread.value), sha });
}

/**
 * Spend the round for a head whose follow-up or drive went. A head already
 * counted is not counted twice. A verified merge: when the read-back finds a
 * rival's record (another head's round), the increment is decided again on
 * that record, so two heads recorded at once spend two rounds. The residual
 * is kv-verified's: a rival put that lands after this read-back overwrites
 * the round, unless the rival's own read-back sees this one. It only adds to
 * a record that exists: the peek writes the empty record before a PR's first
 * round, and a close deletes it, so a record that lands after the close (an
 * in-flight start, a flush's send) is skipped and logged
 * (`record_skipped_no_record`) instead of bringing the old count back to a
 * reopened PR. Never throws; a record the store will not verify is logged. With
 * `FACTORY_FIXER_ROUNDS_MERGE=off` (read per call) it is the plain
 * read-then-put, which can lose one of two concurrent increments.
 */
export async function recordBugbotRound(
  kv: KeyedKv,
  input: { pr: GithubPrRef; headSha: string | undefined; env?: NodeJS.ProcessEnv; retry?: RetryOptions }
): Promise<void> {
  const sha = shaOf(input.headSha);
  if (!roundsMergeOn(input.env ?? process.env)) {
    const current = (await readRounds(kv, input.pr)) ?? { shas: [], rounds: 0 };
    if (current.shas.includes(sha)) return;
    await kv.put(bugbotRoundsKey(input.pr), { ...current, shas: [...current.shas, sha], rounds: current.rounds + 1 }).catch((error: unknown) => warnKv("auto-drive.recordBugbotRound", error));
    return;
  }
  const recorded = await updateVerified(
    kv,
    bugbotRoundsKey(input.pr),
    (stored) => {
      if (stored === undefined) return undefined;
      const rounds = parseRounds(stored);
      if (rounds.shas.includes(sha)) return undefined;
      return { ...asClaim(stored), ...rounds, shas: [...rounds.shas, sha], rounds: rounds.rounds + 1 };
    },
    input.retry
  );
  if (recorded.status === "unavailable") {
    console.warn(JSON.stringify({ fixer: "bugbot_round", pr: input.pr.label, head: input.headSha ?? null, outcome: "record_unavailable" }));
  }
  if (recorded.status === "lost" && recorded.current === undefined) {
    console.warn(JSON.stringify({ fixer: "bugbot_round", pr: input.pr.label, head: input.headSha ?? null, outcome: "record_skipped_no_record" }));
  }
}

/** `FACTORY_FIXER_ROUNDS_MERGE=off` turns the verified round merges off; anything else keeps them. */
export function roundsMergeOn(env: NodeJS.ProcessEnv): boolean {
  return env.FACTORY_FIXER_ROUNDS_MERGE?.trim().toLowerCase() !== "off";
}

/** What this head's findings get against one round record. */
function roundFor(input: { rounds: BugbotRounds; sha: string }): BugbotRound {
  const { rounds, sha } = input;
  if (rounds.shas.includes(sha)) return "duplicate";
  if (rounds.rounds < BUGBOT_MAX_ROUNDS) return "drive";
  return rounds.capNoted === true ? "capped" : "cap_reached";
}

function shaOf(headSha: string | undefined): string {
  return headSha?.toLowerCase() ?? "unknown";
}

function parseRounds(value: unknown): BugbotRounds {
  const stored = asClaim(value);
  return {
    shas: Array.isArray(stored?.["shas"]) ? stored["shas"].filter((item): item is string => typeof item === "string") : [],
    rounds: typeof stored?.["rounds"] === "number" ? stored["rounds"] : 0,
    ...(stored?.["capNoted"] === true ? { capNoted: true as const } : {}),
  };
}

async function readRounds(kv: KeyedKv, pr: GithubPrRef): Promise<BugbotRounds | undefined> {
  const stored = await readStoredRounds(kv, pr);
  return stored === undefined ? undefined : parseRounds(stored.value);
}

/** The stored round record as it is (`value` undefined when absent), or undefined when kv fails. */
async function readStoredRounds(kv: KeyedKv, pr: GithubPrRef): Promise<{ value: JsonValue | undefined } | undefined> {
  try {
    return { value: await kv.get(bugbotRoundsKey(pr)) };
  } catch (error) {
    warnKv("auto-drive.readRounds", error);
    return undefined;
  }
}

/**
 * Before a PR's first round goes, write its empty record: {@link recordBugbotRound}
 * only adds to a record that exists, so a record landing after a close
 * deleted the key cannot bring the old count back. Retried back to back (the
 * peek can run inside admission, before the start). A marker that does not
 * land costs one uncounted round, logged when the record finds no record.
 */
async function markRoundsOpen(kv: KeyedKv, pr: GithubPrRef): Promise<void> {
  await updateVerified(kv, bugbotRoundsKey(pr), (current) => (current === undefined ? { shas: [], rounds: 0 } : undefined), { pausesMs: [] });
}

export function bugbotCapNote(issueKey: string | undefined): string {
  return `Bugbot still reports findings after ${BUGBOT_MAX_ROUNDS} automatic fix rounds${issueKey === undefined ? "" : ` on ${issueKey}`}, so the factory stopped fixing them. A person needs to review the remaining Bugbot threads.`;
}

/**
 * Whether a neutral cursor check_suite holds a neutral `Cursor Bugbot` run:
 * the one check that means Bugbot findings. Another cursor check's neutral
 * suite is not. A read that fails is no confirmation.
 */
export async function confirmBugbotSuite(input: { github: HostGitHubClient; pr: GithubPrRef; checkSuiteId: number }): Promise<boolean> {
  try {
    const octokit = await input.github.getOctokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs", {
      owner: input.pr.owner,
      repo: input.pr.repo,
      check_suite_id: input.checkSuiteId,
    });
    const runs = (data as { check_runs?: Array<{ name?: unknown; conclusion?: unknown }> }).check_runs ?? [];
    return runs.some((run) => typeof run.name === "string" && isBugbotRunName(run.name) && run.conclusion === "neutral");
  } catch {
    return false;
  }
}

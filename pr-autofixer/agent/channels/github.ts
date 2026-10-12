import {
  SessionBusyError,
  type HostContext,
  type HostGitHubClient,
  type ReminderHostApi,
  type SendMessageFn,
} from "@cursor/july";
import { githubChannel, type GitHubTaskDispatch } from "@cursor/july/channels/github";
import {
  assertAutoDriveInScope,
  autoDriveClaimHeld,
  autoDriveKey,
  autoDriveDecision,
  autoDriveProjects,
  claimAutoDrive,
  fetchPrHead,
  type PrHead,
  autoDriveBrief,
  autoDriveTrigger,
  bugbotCapNote,
  confirmBugbotSuite,
  releaseAutoDrive,
  peekBugbotRound,
  recordBugbotRound,
  startAutoDrive,
} from "../lib/auto-drive.js";
import {
  decideFactoryDrive,
  isBotAuthor,
  isFactoryDriveComment,
  payloadAuthorAssociation,
  type FactoryDriveDecision,
} from "../lib/factory-drive.js";
import {
  buildGenericPrUpdatePrompt,
  cloudOptionsFor,
  githubPrRef,
} from "../lib/drive.js";
import { cancelRemindersForPr } from "../lib/merge-watch.js";
import { lookupPrAgent } from "../lib/affinity.js";
import { cleanupClosedPr, closeCleanupOn } from "../lib/close-cleanup.js";
import { prContinuationToken } from "../lib/pr-generation.js";
import { freshFailuresKey, type KeyedKv } from "../lib/kv-keys.js";
import { releaseLease } from "../lib/claim-lease.js";
import { refusesProductionTarget } from "../lib/factory-stage.js";
import { fetchPrStatus, shouldRequeueBusyWake } from "../lib/pr-state.js";
import { githubRepos, githubReposAtBoot, githubReposIfSet } from "../lib/repos.js";
import { startDrive, type StartDriveResult } from "../lib/start-drive.js";
import {
  WebhookBuffer,
  type BufferedWebhookEvent,
  type FlushResult,
} from "../lib/webhook-buffer.js";
import {
  bufferedEventFromCheckRun,
  bufferedEventFromCheckSuite,
  bufferedEventFromComment,
  bufferedEventFromPr,
  bufferedEventFromRaw,
  bufferedEventFromStatus,
  bufferedEventFromWorkflowRun,
  isBugbotCandidate,
  isBugbotFindings,
} from "../lib/webhook-routing.js";
import { bindOpsFunnel, warnKv } from "../lib/ops-funnel.js";
import { noteFactory, traceFactory, tracedGithubHook } from "../lib/factory-otel.js";

interface Runtime {
  send: SendMessageFn;
  github: HostGitHubClient;
  kv: KeyedKv;
  reminders: ReminderHostApi | undefined;
  buffer: WebhookBuffer;
  host: HostContext;
}

let runtime: Runtime | undefined;

function prOf(event: BufferedWebhookEvent) {
  return githubPrRef({
    owner: event.owner,
    repo: event.repo,
    number: event.number,
    url: event.prUrl,
  });
}

async function wake(
  received: BufferedWebhookEvent | null
): Promise<GitHubTaskDispatch | null> {
  if (received === null || runtime === undefined) {
    return null;
  }
  const pr = prOf(received);
  if ((await lookupPrAgent(pr, runtime.kv)) === undefined) {
    return autoDrive(received);
  }
  // A driven PR: the check-runs read only now, after the cheap affinity check.
  // Bugbot rounds are spent at flush, when the follow-up is actually sent.
  const event = await confirmedBugbot(runtime, { event: received, pr });
  if (event === undefined) {
    return null;
  }
  await runtime.buffer.enqueue(event);
  noteFactory({ outcome: "buffered" });
  return { task() {} };
}

/**
 * A neutral cursor check_suite is Bugbot findings only when its runs include
 * a neutral `Cursor Bugbot` run; it is then carried with that name, and
 * dropped otherwise (a neutral suite is no failure). Every other event passes.
 */
async function confirmedBugbot(current: Runtime, input: { event: BufferedWebhookEvent; pr: ReturnType<typeof prOf> }): Promise<BufferedWebhookEvent | undefined> {
  const { event, pr } = input;
  if (!isBugbotCandidate(event)) return event;
  if (event.checkSuiteId === undefined) return undefined;
  if (!(await confirmBugbotSuite({ github: current.github, pr, checkSuiteId: event.checkSuiteId }))) return undefined;
  return { ...event, checkName: BUGBOT_RUN };
}

const BUGBOT_RUN = "Cursor Bugbot";

/** kv-verified's retries back to back, for calls inside a loop that already pauses. */
const INNER_RETRY = { pausesMs: [] };

/**
 * Whether this head may have a Bugbot round, BUGBOT_MAX_ROUNDS per PR
 * (peekBugbotRound). Nothing is spent here: the caller records the round
 * once the follow-up or drive went. The round past the cap leaves one PR
 * comment saying a person is needed, then the fixer stays quiet on Bugbot
 * for that PR.
 */
async function bugbotRoundGoes(current: Runtime, input: { event: BufferedWebhookEvent; pr: ReturnType<typeof prOf>; issueKey: string | undefined }): Promise<boolean> {
  const round = await peekBugbotRound(current.kv, { pr: input.pr, headSha: input.event.headSha });
  console.log(JSON.stringify({ fixer: "bugbot_round", pr: input.pr.label, head: input.event.headSha ?? null, outcome: round }));
  if (round === "cap_reached" && !refusesProductionTarget(process.env, { kind: "repos", value: `${input.pr.owner}/${input.pr.repo}` })) {
    try {
      const octokit = await current.github.getOctokit();
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: input.pr.owner,
        repo: input.pr.repo,
        issue_number: input.pr.number,
        body: bugbotCapNote(input.issueKey),
      });
    } catch (error) {
      console.error(`[pr-autofixer] could not note the Bugbot round cap on ${input.pr.label}:`, error);
    }
  }
  return round === "drive";
}

// Factory edit (docs/edits.md): a red check on an undriven pull request the
// factory opened (branch starts with an allowed ticket key, or the title
// does and cursor[bot] opened it) starts the drive itself, through
// startDrive, the path a person's `factory: drive` comment takes. The
// drive's first turn triages the red check, so this event is not buffered.
// Once per PR at a time; human-opened PRs still need the opt-in, a keyed
// title included. The claim's lifetime is in lib/auto-drive.ts
// (claimAutoDrive).
async function autoDrive(
  received: BufferedWebhookEvent
): Promise<GitHubTaskDispatch | null> {
  if (runtime === undefined) {
    return null;
  }
  // A neutral cursor suite is judged as the Bugbot run it may hold; its check
  // runs are read only once the PR is known to be a factory PR in scope.
  const candidate = isBugbotCandidate(received);
  const projects = autoDriveProjects(process.env);
  if (projects.length === 0 || (!candidate && autoDriveTrigger(received) === undefined)) {
    return null;
  }
  const pr = prOf(received);
  const head = await fetchPrHead({ github: runtime.github, pr });
  const checkName = candidate ? BUGBOT_RUN : received.checkName;
  const decision = autoDriveDecision({
    eventName: received.eventName,
    ...(received.conclusion === undefined ? {} : { conclusion: received.conclusion }),
    ...(checkName === undefined ? {} : { checkName }),
    headRefName: head.headRefName,
    title: head.title,
    authorLogin: head.authorLogin,
    projects,
  });
  if (!decision.drive) {
    // A keyed title on a person's PR is the one refusal worth a line: it looks
    // like a factory PR to a reader of the board, and the opt-in is the answer.
    if (decision.reason === "title_only_from_person") {
      console.log(JSON.stringify({ fixer: "auto_drive", pr: pr.label, outcome: decision.reason, author: head.authorLogin ?? null }));
    }
    return null;
  }
  assertAutoDriveInScope(pr, githubRepos());
  const event = await confirmedBugbot(runtime, { event: received, pr });
  if (event === undefined) {
    return null;
  }
  const claim = await claimAutoDrive(runtime.kv, pr, new Date().toISOString());
  if (claim === undefined) {
    // A drive holds the PR. Bugbot findings wait in the buffer until its
    // agent binds (flush re-arms while the claim is held), or start a fresh
    // drive if the claim goes unbound; no round is spent until one is sent.
    if (decision.trigger === "bugbot") {
      await runtime.buffer.enqueue(event);
      noteFactory({ outcome: "buffered" });
      return { task() {} };
    }
    return null;
  }
  // Checked only once this delivery holds the claim; spent only once the drive started.
  if (decision.trigger === "bugbot" && !(await bugbotRoundGoes(runtime, { event, pr, issueKey: decision.issueKey }))) {
    await releaseLease(runtime.kv, autoDriveKey(pr), claim).catch((error: unknown) => warnKv("github.autoDrive", error));
    return null;
  }
  const current = runtime;
  // Inside the start's retry loop, which owns the pauses (K6).
  const onStarted = decision.trigger === "bugbot" ? () => recordBugbotRound(current.kv, { pr, headSha: event.headSha, retry: INNER_RETRY }) : undefined;
  // Returned, not floated: the host keeps the delivery open until the start has answered.
  return driveTask(current, { pr, claim, hint: autoDriveBrief(decision), ...(onStarted === undefined ? {} : { onStarted }) });
}

async function factoryDrive(
  target: Extract<FactoryDriveDecision, { drive: true }>["pr"]
): Promise<GitHubTaskDispatch | null> {
  if (runtime === undefined) {
    return null;
  }
  const pr = githubPrRef(target);
  // A PR already driven keeps its one agent; a second start would open another
  // session on it (bound) or a second agent (claimed by a delivery drive).
  if ((await lookupPrAgent(pr, runtime.kv)) !== undefined) {
    return null;
  }
  const claim = await claimAutoDrive(runtime.kv, pr, new Date().toISOString());
  if (claim === undefined) {
    return null;
  }
  const current = runtime;
  return driveTask(current, { pr, claim, hint: "A factory: drive comment opted this pull request in. Make CI green; do not change the plan's scope." });
}

// Hosted v2 admits with the full webhook body, which carries the association.
// A body without it (the --cursor-events relay, a hand-made fixture) is
// answered by GitHub's comment endpoint. An unanswered lookup refuses.
async function fetchCommentAssociation(
  repository: { owner: string; name: string },
  commentId: number
): Promise<string | undefined> {
  if (runtime === undefined) {
    return undefined;
  }
  try {
    const octokit = await runtime.github.getOctokit();
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner: repository.owner,
      repo: repository.name,
      comment_id: commentId,
    });
    return typeof data.author_association === "string" ? data.author_association : undefined;
  } catch {
    return undefined;
  }
}

// The start goes through the task's own send. On hosted v2 the task body runs
// inside the admission window, where the onStart-bound send (and so a
// drive_pr tool call's ctx.send) throws HostedAdmissionLocalSendError.
function driveTask(current: Runtime, input: { pr: ReturnType<typeof githubPrRef>; claim: string; hint: string; onStarted?: () => Promise<void> }): GitHubTaskDispatch {
  const { pr, claim, hint, onStarted } = input;
  return {
    task: ({ send }) =>
      startAutoDrive({
        kv: current.kv,
        pr,
        claim,
        start: () => startedThen(startDrive({ pr: pr.url, hint, repos: githubRepos(), send, host: current.host, deliverySend: true }), onStarted),
      }),
  };
}

async function startedThen(start: Promise<StartDriveResult>, onStarted: (() => Promise<void>) | undefined): Promise<StartDriveResult> {
  const result = await start;
  if (onStarted !== undefined && result.ok && result.status === "started") await onStarted();
  return result;
}

/** How often a Bugbot wake re-checks for the bound agent while a drive holds the PR (PR_AUTOFIXER_BIND_WAIT_MS overrides). */
export const BIND_WAIT_MS = 30_000;

function bindWaitMs(): number {
  const value = Number(process.env["PR_AUTOFIXER_BIND_WAIT_MS"]);
  return Number.isFinite(value) && value > 0 ? value : BIND_WAIT_MS;
}

function logBugbotWake(pr: ReturnType<typeof prOf>, fields: { outcome: string; head: string | undefined; reason?: string }): void {
  console.log(JSON.stringify({ fixer: "bugbot_wake", pr: pr.label, head: fields.head ?? null, outcome: fields.outcome, ...(fields.reason === undefined ? {} : { reason: fields.reason }) }));
}

/**
 * Bugbot findings for a PR with no bound agent. While a drive holds the claim
 * they wait (the buffer re-arms) for its agent to bind. Once the claim is
 * gone unbound (its turn ended before binding, or the lease lapsed) they
 * start a fresh drive through the drive_pr path, the runtime's own send,
 * which is usable outside a delivery. Whatever cannot be delivered is logged
 * with its reason; no round is spent unless the drive started.
 */
async function bugbotWithoutAgent(current: Runtime, event: BufferedWebhookEvent): Promise<FlushResult> {
  const pr = prOf(event);
  // While another drive holds the claim, wait for its agent: no GitHub read, and nothing counted.
  const held = await autoDriveClaimHeld(current.kv, pr, new Date()).catch((error: unknown) => {
    logBugbotWake(pr, { outcome: "waiting_for_bind", head: event.headSha, reason: `claim unread: ${error instanceof Error ? error.message : String(error)}` });
    return true;
  });
  if (held) {
    logBugbotWake(pr, { outcome: "waiting_for_bind", head: event.headSha });
    return { retryInMs: bindWaitMs() };
  }
  const failures = { pr, headSha: event.headSha };
  let claim: string | undefined;
  try {
    // Read before claiming, as autoDrive does: a PR GitHub will not read claims nothing.
    const head = await fetchPrHead({ github: current.github, pr });
    claim = await claimAutoDrive(current.kv, pr, new Date().toISOString());
    if (claim === undefined) {
      logBugbotWake(pr, { outcome: "waiting_for_bind", head: event.headSha });
      return { retryInMs: bindWaitMs() };
    }
    const result = await freshBugbotDrive(current, { event, pr, head, claim });
    await clearFreshFailures(current.kv, failures);
    return result;
  } catch (error) {
    // Nothing that throws after the claim may keep it: a later red check or factory: drive must still start.
    if (claim !== undefined) await releaseLease(current.kv, autoDriveKey(pr), claim).catch((error: unknown) => warnKv("github.bugbotWithoutAgent", error));
    const count = await countFreshFailure(current.kv, failures);
    if (count === undefined) {
      logBugbotWake(pr, { outcome: "waiting_for_bind", head: event.headSha, reason: "could not count the failed attempt; retrying" });
      return { retryInMs: bindWaitMs() };
    }
    if (count < FRESH_DRIVE_ATTEMPTS) throw error;
    await clearFreshFailures(current.kv, failures);
    const reason = error instanceof Error ? error.message : String(error);
    logBugbotWake(pr, { outcome: "dropped", head: event.headSha, reason: `the fresh drive failed ${FRESH_DRIVE_ATTEMPTS} times (${reason})` });
    return undefined;
  }
}

/** Failed attempts to take the PR for a fresh drive (an unreadable PR, or a start that throws) per head before its findings are dropped (logged). */
const FRESH_DRIVE_ATTEMPTS = 3;

/** A failure count older than this is stale and starts again from zero. */
const FRESH_FAILURES_TTL_MS = 60 * 60_000;

type FreshFailures = { pr: ReturnType<typeof prOf>; headSha: string | undefined };

/** Count one more failed attempt for this head; undefined when kv fails, which is not an attempt. */
async function countFreshFailure(kv: KeyedKv, input: FreshFailures): Promise<number | undefined> {
  const key = freshFailuresKey(input);
  try {
    const seen = await kv.get(key);
    const record = typeof seen === "object" && seen !== null && !Array.isArray(seen) ? (seen as Record<string, unknown>) : {};
    const live = typeof record["exp"] === "number" && record["exp"] > Date.now() && typeof record["count"] === "number";
    const count = (live ? (record["count"] as number) : 0) + 1;
    await kv.put(key, { count, exp: Date.now() + FRESH_FAILURES_TTL_MS });
    return count;
  } catch (error) {
    warnKv("github.countFreshFailure", error);
    return undefined;
  }
}

async function clearFreshFailures(kv: KeyedKv, input: FreshFailures): Promise<void> {
  await kv.delete(freshFailuresKey(input)).catch((error: unknown) => warnKv("github.clearFreshFailures", error));
}

async function freshBugbotDrive(current: Runtime, input: { event: BufferedWebhookEvent; pr: ReturnType<typeof prOf>; head: PrHead; claim: string }): Promise<FlushResult> {
  const { event, pr, head, claim } = input;
  const decision = autoDriveDecision({
    eventName: event.eventName,
    ...(event.conclusion === undefined ? {} : { conclusion: event.conclusion }),
    checkName: BUGBOT_RUN,
    headRefName: head.headRefName,
    title: head.title,
    authorLogin: head.authorLogin,
    projects: autoDriveProjects(process.env),
  });
  if (!decision.drive) {
    await releaseLease(current.kv, autoDriveKey(pr), claim).catch((error: unknown) => warnKv("github.freshBugbotDrive.releaseLease.1", error));
    logBugbotWake(pr, { outcome: "dropped", head: event.headSha, reason: `drive ended unbound; no fresh drive (${decision.reason})` });
    return undefined;
  }
  if (!(await bugbotRoundGoes(current, { event, pr, issueKey: decision.issueKey }))) {
    await releaseLease(current.kv, autoDriveKey(pr), claim).catch((error: unknown) => warnKv("github.freshBugbotDrive.releaseLease.2", error));
    logBugbotWake(pr, { outcome: "dropped", head: event.headSha, reason: "no Bugbot round left for this head" });
    return undefined;
  }
  let started = false;
  await startAutoDrive({
    kv: current.kv,
    pr,
    claim,
    start: () =>
      startedThen(startDrive({ pr: pr.url, hint: autoDriveBrief(decision), repos: githubRepos(), send: current.send, host: current.host, kvRetry: INNER_RETRY }), async () => {
        started = true;
        await recordBugbotRound(current.kv, { pr, headSha: event.headSha, retry: INNER_RETRY });
      }),
  });
  logBugbotWake(pr, started ? { outcome: "fresh_drive", head: event.headSha } : { outcome: "dropped", head: event.headSha, reason: "the fresh drive was refused" });
  return undefined;
}

/** The debounced flush of one PR's buffered wake, in its own span (no delivery is open when the timer fires). */
function tracedFlush(event: BufferedWebhookEvent): Promise<FlushResult> {
  return traceFactory({ span: "factory.background", kind: "buffer.flush", describe: (result) => ({ outcome: result === undefined ? "flushed" : "retry_scheduled" }) }, () => {
    noteFactory({ pr: prOf(event).label });
    return flush(event);
  });
}

async function flush(event: BufferedWebhookEvent): Promise<FlushResult> {
  if (runtime === undefined) {
    return undefined;
  }
  const pr = prOf(event);
  const bcId = await lookupPrAgent(pr, runtime.kv);
  const bugbot = isBugbotFindings(event);
  if (bcId === undefined) {
    return bugbot ? bugbotWithoutAgent(runtime, event) : undefined;
  }
  const continuationToken = await prContinuationToken(runtime.kv, { pr });
  if (bugbot && !(await bugbotRoundGoes(runtime, { event, pr, issueKey: undefined }))) {
    return undefined;
  }

  try {
    const session = await runtime.send(buildGenericPrUpdatePrompt(event.prUrl), {
      auth: {
        authenticator: "github-webhook",
        principalId: "pr-autofixer-webhook",
        principalType: "service",
      },
      continuationToken,
      title: `PR ${pr.label}`,
      cloud: cloudOptionsFor(pr),
      sdkAgentId: bcId,
    });
    // The round is spent once the follow-up was sent: a send that throws
    // leaves the head free, so the buffer's retry sends it again.
    if (bugbot) {
      await recordBugbotRound(runtime.kv, { pr, headSha: event.headSha });
      await clearFreshFailures(runtime.kv, { pr, headSha: event.headSha });
    }
    await session.waitForCompletion();
  } catch (error) {
    if (error instanceof SessionBusyError) {
      const current = runtime;
      if (
        current !== undefined &&
        (await shouldRequeueBusyWake({ github: current.github, pr }))
      ) {
        await current.buffer.enqueue(event);
      } else if (bugbot) {
        logBugbotWake(pr, { outcome: "dropped", head: event.headSha, reason: "agent busy and the PR no longer needs a wake" });
      }
      return undefined;
    }
    throw error;
  }
}

/** `pull_request.updated_at` from the raw webhook body, when it carries one. */
function payloadPrUpdatedAt(payload: unknown): string | undefined {
  const pull = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["pull_request"] : undefined;
  const updatedAt = typeof pull === "object" && pull !== null ? (pull as Record<string, unknown>)["updated_at"] : undefined;
  return typeof updatedAt === "string" ? updatedAt : undefined;
}

/** True only when both times parse and `fetched` is later than `event`. */
function newerThanEvent(times: { fetched: string | undefined; event: string | undefined }): boolean {
  const fetched = Date.parse(times.fetched ?? "");
  const event = Date.parse(times.event ?? "");
  return Number.isFinite(fetched) && Number.isFinite(event) && fetched > event;
}

/**
 * A closed PR's reminders and buffered wake go, then its kv
 * (lib/close-cleanup.ts): a reopened PR starts with no agent, no claim,
 * Bugbot rounds at 0 and new `pr:` sessions. A close that arrives after the
 * PR was reopened (late, or redelivered) must not wipe the reopened PR, so
 * nothing is done when GitHub says the PR is open and was updated after the
 * close event. An open answer that is not newer (GitHub lagging behind its
 * own close), one whose time cannot be compared (a body with no
 * `updated_at`), or no answer at all is taken as the event says: closed. A
 * merged PR cannot reopen, so its close does not bump the continuation
 * generation. Best effort: nothing here throws, and the one `close_cleanup`
 * line says what each step did.
 */
async function closePr(current: Runtime, input: { pr: ReturnType<typeof githubPrRef>; merged: boolean; eventUpdatedAt: string | undefined }): Promise<void> {
  const { pr } = input;
  const status = await fetchPrStatus({ github: current.github, pr });
  const times = { fetched: status?.updatedAt, event: input.eventUpdatedAt };
  if (status?.state === "OPEN" && newerThanEvent(times)) {
    try {
      console.log(JSON.stringify({ fixer: "close_cleanup", pr: pr.label, prState: "OPEN", prUpdatedAt: times.fetched, eventUpdatedAt: times.event, outcome: "skipped_reopened" }));
    } catch {
      // Logging must not break the no-throw contract.
    }
    return;
  }
  const failed = (step: string) => (error: unknown) => {
    console.error(`[pr-autofixer] close of ${pr.label}: ${step} failed:`, error);
    return "failed";
  };
  const fields: Record<string, string> = { prState: status?.state ?? "unknown" };
  if (current.reminders !== undefined) {
    const reminders = current.reminders;
    fields.reminders = await cancelRemindersForPr({ reminders, pr, reason: "pr_closed" }).then(() => "cancelled", failed("cancelling reminders"));
  }
  fields.buffer = await current.buffer.discard(WebhookBuffer.keyFor(pr)).then((had) => (had ? "discarded" : "empty"), failed("discarding the buffered wake"));
  const merged = input.merged || status?.state === "MERGED";
  await cleanupClosedPr(current.kv, { pr, fields, bumpGeneration: !merged });
}

// For the cursorAccount declaration only. Every decision below reads the
// list again at delivery time (githubRepos / githubReposIfSet).
const repos = githubReposAtBoot();

export default githubChannel({
  botName: "factory-pr-autofixer",
  // workflow_run, status and pull_request_review_thread have no PR
  // membership, so the v2 default is already github.none/v2. Deliveries only
  // buffer; flush() routes each wake to the PR's session with its own
  // continuationTokenFor(pr), so no delivery relies on channel continuation.
  continuation: "github.none/v2",
  // Empty list cannot be `{ repos: [] }` (July throws). `true` still
  // starts the hosted event stream; the next task with FACTORY_REPOS set
  // reloads this module as `{ repos, permissions }`.
  cursorAccount:
    repos.length === 0
      ? true
      : { repos, permissions: "contents-write" },
  progress: { reactions: false },
  deliverReplies: false,

  onPullRequest: tracedGithubHook("github.pull_request", async (ctx, pr) => {
    if (pr.action === "closed") {
      const ref = githubPrRef({
        owner: ctx.repository.owner,
        repo: ctx.repository.name,
        number: pr.number,
        url: pr.url,
      });
      if (runtime !== undefined) {
        if (closeCleanupOn(process.env)) {
          await closePr(runtime, { pr: ref, merged: pr.merged === true, eventUpdatedAt: payloadPrUpdatedAt(ctx.payload) });
          return null;
        }
        if (runtime.reminders !== undefined) {
          await cancelRemindersForPr({
            reminders: runtime.reminders,
            pr: ref,
            reason: "pr_closed",
          });
        }
        await runtime.buffer.discard(WebhookBuffer.keyFor(ref));
        await releaseAutoDrive(runtime.kv, ref);
      }
      return null;
    }
    return wake(bufferedEventFromPr({ ctx, pr }));
  }),

  onComment: tracedGithubHook("github.comment", async (ctx, comment) => {
    if (!isFactoryDriveComment(comment.body)) {
      return wake(bufferedEventFromComment({ ctx, eventName: ctx.eventName }));
    }
    // The scope is read now, not at boot. A hosted freeze boots before its
    // secrets exist, so the boot list (`repos`, above) can be empty while
    // FACTORY_REPOS is set by the time a person types the opt-in; the
    // red-check path already reads the live list, and startDrive judges
    // the same one, so this decision must too.
    const scope = githubReposIfSet();
    const input = { body: comment.body, conversation: ctx.conversation, repository: ctx.repository, repos: scope };
    const author = {
      login: comment.author?.login ?? ctx.senderLogin,
      type: comment.author?.type ?? ctx.sender?.type,
      association: payloadAuthorAssociation(ctx.payload),
    };
    let decision = decideFactoryDrive({ ...input, author });
    // Only a PR timeline comment can drive (a review thread is not a
    // pull_request conversation), so only that one is worth a lookup.
    if (
      !decision.drive &&
      decision.reason === "untrusted_author" &&
      author.association === undefined &&
      !isBotAuthor(author) &&
      ctx.eventName === "issue_comment"
    ) {
      const association = await fetchCommentAssociation(ctx.repository, comment.id);
      decision = decideFactoryDrive({ ...input, author: { ...author, association } });
    }
    if (decision.drive) {
      return factoryDrive(decision.pr);
    }
    const label = `${ctx.repository.owner}/${ctx.repository.name}#${ctx.conversation.number}`;
    console.log(JSON.stringify({ fixer: "factory_drive", pr: label, outcome: decision.reason, author: author.login ?? null }));
    // A trusted person's opt-in on a repository the host delivered but the
    // list omits is a stale FACTORY_REPOS, the same fault the red-check path
    // reports (#107); it must not end as a silent null.
    if (decision.reason === "out_of_scope") {
      const pr = githubPrRef({ owner: ctx.repository.owner, repo: ctx.repository.name, number: ctx.conversation.number, url: ctx.conversation.url });
      assertAutoDriveInScope(pr, scope, "got a person's factory: drive");
    }
    return null;
  }),

  onCheckSuite: tracedGithubHook("github.check_suite", async (ctx, suite) =>
    wake(await bufferedEventFromCheckSuite({ ctx, suite }))),

  onCheckRun: tracedGithubHook("github.check_run", async (ctx, run) =>
    wake(await bufferedEventFromCheckRun({ ctx, run }))),

  onWorkflowRun: tracedGithubHook("github.workflow_run", async (ctx, run) =>
    wake(await bufferedEventFromWorkflowRun({ ctx, run }))),

  onStatus: tracedGithubHook("github.status", async (ctx, status) =>
    wake(await bufferedEventFromStatus({ ctx, status }))),

  onEvent: tracedGithubHook("github.event", (ctx, event) => wake(bufferedEventFromRaw({ ctx, event }))),

  onStart: async (args) => {
    bindOpsFunnel(args.host);
    runtime = {
      send: args.send,
      github: args.host.github,
      kv: args.host.kv,
      reminders: args.host.reminders,
      buffer: new WebhookBuffer({
        kv: args.host.kv,
        onFlush: tracedFlush,
      }),
      host: args.host,
    };
    await runtime.buffer.restore();
  },

  onStop: async () => {
    await runtime?.buffer.clear();
    runtime = undefined;
  },
});

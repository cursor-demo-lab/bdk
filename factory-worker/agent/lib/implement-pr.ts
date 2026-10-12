import type { HostMcpRegistry, ReminderHostApi } from "@cursor/july";
import { DEFAULT_CLOUD_ID, jiraCloudId } from "./atlassian.js";
import { parseClaim } from "./claim.js";
import { FactoryConfigError, jiraProjects, sandboxRef, sandboxRepo } from "./config.js";
import { extractBrief, latestPlanComment } from "./decide.js";
import { implementClaimKey, type KeyedKv } from "./kv-keys.js";
import { issueKeyAtStart } from "./factory-pr-key.js";
import { readComments } from "./jira.js";
import { wordPrefix } from "./launch.js";
import { briefLinks, type TicketLinks } from "./pr-links.js";
import { markReadyForReview, noteNotReady, readyFailed, type ReadyApi, type ReadyOutcome } from "./pr-ready.js";
import { advanceTicket } from "./pr-status.js";
import { addIndexEntry, indexList, indexMergeOn, pruneIndexEntries } from "./kv-index.js";
import { IMPLEMENT_PR_INDEX, implementPrWatchKey } from "./kv-keys.js";
import { warnKv, warnStep } from "./ops-funnel.js";

export { IMPLEMENT_PR_INDEX, implementPrWatchKey };

// The worker opens the implement PR, not the agent. On TLSSN-35 the agent
// pushed its branch and its PR tool refused the body's Slack line as agent
// metadata, so no PR opened and the ticket sat in In Progress; the platform's
// autoCreatePR opens drafts, which Bugbot skips. So the worker reads the
// agent's run (`@cursor/sdk`, the API the launch already uses) for the branch
// it pushed and its final message, and opens the PR ready for review through
// the GitHub channel's Cursor account credential (`pr-write`, github-proxy on
// api.cursor.com), the same access that undrafts and links PRs today.
//
// Idempotent: GitHub is the record. An open PR for the branch is reused and
// undrafted (a bot draft, as pr-ready.ts does, not one a person drafted); a
// closed one is left alone, so a PR a person closed is never reopened. Then
// the same In Review move a `pull_request.opened` delivery makes, so the
// ticket moves even when that delivery never arrives.
//
// Two wakes run it: a reminder armed at launch that polls the run until the
// branch is pushed, and any later Approved delivery for a launched ticket
// (the desk's `retry KEY`), which is how a ticket stuck before this existed
// gets its PR.

export type AgentRunStatus = "running" | "finished" | "error" | "cancelled";

/** What the worker needs from the agent's latest run. */
export type AgentRunFacts = { status: AgentRunStatus; branch?: string; summary?: string };

/** The agent's latest run, or undefined when it has none yet. */
export type ReadAgentRun = (input: { agentId: string; repo: string }) => Promise<AgentRunFacts | undefined>;

/** The slice of `@cursor/sdk`'s `Run` the reader uses. */
export type RunLike = {
  status: string;
  result?: string | undefined;
  git?: { branches: readonly { repoUrl: string; branch?: string | undefined }[] } | undefined;
  createdAt?: number | undefined;
};

export type ListRuns = (agentId: string, options: { runtime: "cloud"; limit: number }) => Promise<{ items: readonly RunLike[] }>;

/** A {@link ReadAgentRun} over `Agent.listRuns`. */
export function sdkRunReader(listRuns: ListRuns): ReadAgentRun {
  return async ({ agentId, repo }) => latestRunFacts((await listRuns(agentId, { runtime: "cloud", limit: 5 })).items, repo);
}

/** The newest run's status, the branch it pushed on `repo`, and its final message. */
export function latestRunFacts(runs: readonly RunLike[], repo: string): AgentRunFacts | undefined {
  const latest = [...runs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  if (latest === undefined) return undefined;
  const status = runStatus(latest.status);
  const branch = branchOn(latest.git?.branches ?? [], repo);
  const summary = latest.result?.trim();
  return { status, ...(branch === undefined ? {} : { branch }), ...(summary === undefined || summary === "" ? {} : { summary }) };
}

// `listRuns` on a cloud agent folds EXPIRED into "error", but the SDK's local
// store returns "expired"; either way the run has stopped and will push nothing.
function runStatus(status: string): AgentRunStatus {
  if (status === "finished" || status === "error" || status === "cancelled") return status;
  if (status === "expired") return "error";
  return "running";
}

function branchOn(branches: readonly { repoUrl: string; branch?: string | undefined }[], repo: string): string | undefined {
  const pushed = branches.filter((entry) => (entry.branch?.trim() ?? "") !== "");
  const wanted = `/${repo.toLowerCase()}`;
  const onRepo = pushed.find((entry) => {
    const url = entry.repoUrl.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
    return url === repo.toLowerCase() || url.endsWith(wanted);
  });
  return (onRepo ?? (pushed.length === 1 ? pushed[0] : undefined))?.branch?.trim();
}

export type ImplementPrDeps = {
  kv: KeyedKv;
  mcp: HostMcpRegistry;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  github: ReadyApi;
  readRun: ReadAgentRun;
  log?: (line: string) => void;
  /** Pauses between in-task undraft tries; pr-ready's default when unset. */
  readyRetryMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export type ImplementPrInput = { issueKey: string; title?: string; brief?: string };

type Step = "run" | "branch" | "lookup" | "create";

export type ImplementPrResult =
  | { outcome: "config_error" | "unavailable" | "not_launched" | "no_run" | "agent_running" }
  | { outcome: "no_branch"; runStatus: AgentRunStatus; candidates: number }
  | { outcome: "read_failed" | "write_failed"; step: Step; status?: number; branch?: string }
  | { outcome: "pr_closed"; pr: string; url: string; branch: string }
  | {
      outcome: "opened" | "reused";
      pr: string;
      url: string;
      branch: string;
      base?: string;
      ready: ReadyOutcome;
      move: "moved" | "not_moved" | "not_launched" | "duplicate" | "in_flight" | "retry";
    };

type Octokit = Awaited<ReturnType<ReadyApi["getOctokit"]>>;
type PullSummary = { number: number; state: string };

/**
 * Opens the implement PR for the agent's pushed branch, or reuses the one
 * already open, then moves the ticket to In Review. Never throws.
 */
export async function ensureImplementPr(deps: ImplementPrDeps, input: ImplementPrInput): Promise<ImplementPrResult> {
  const { issueKey } = input;
  let repo: string;
  try {
    repo = sandboxRepo(deps.env);
  } catch (error) {
    if (error instanceof FactoryConfigError) return { outcome: "config_error" };
    throw error;
  }
  let agentId: string;
  let agentUrl: string;
  try {
    const claim = parseClaim(await deps.kv.get(implementClaimKey(issueKey)));
    if (claim?.state !== "launched") return { outcome: "not_launched" };
    agentId = claim.agentId;
    agentUrl = claim.url;
  } catch (error) {
    warnKv("implement-pr.ensureImplementPr", error);
    return { outcome: "unavailable" };
  }

  let run: AgentRunFacts | undefined;
  try {
    run = await deps.readRun({ agentId, repo });
  } catch (error) {
    return { outcome: "read_failed", step: "run", ...httpStatus(error) };
  }
  if (run === undefined) return { outcome: "no_run" };
  // A branch the run reports is enough; without one, only a run that ended is worth a look on GitHub.
  if (run.branch === undefined && run.status === "running") return { outcome: "agent_running" };

  const [owner = "", name = ""] = repo.split("/");
  let octokit: Octokit;
  try {
    octokit = await deps.github.getOctokit();
  } catch (error) {
    return { outcome: "read_failed", step: "lookup", ...httpStatus(error) };
  }

  let branch = run.branch;
  if (branch === undefined) {
    const found = await keyBranch(octokit, { owner, name, issueKey, projects: jiraProjects(deps.env) });
    if ("failed" in found) return { outcome: "read_failed", step: "branch", ...found.failed };
    if (found.branches.length !== 1) return { outcome: "no_branch", runStatus: run.status, candidates: found.branches.length };
    branch = found.branches[0]!;
  }

  const pulls = await pullsForHead(octokit, { owner, name, branch });
  if ("failed" in pulls) return { outcome: "read_failed", step: "lookup", branch, ...pulls.failed };
  let open = pulls.pulls.find((pull) => pull.state === "open");
  const closed = pulls.pulls[0];
  if (open === undefined && closed !== undefined) {
    return { outcome: "pr_closed", pr: `${repo}#${closed.number}`, url: pullUrl(repo, closed.number), branch };
  }

  let opened = false;
  let base: string | undefined;
  if (open === undefined) {
    // The ref the agent started from, which the PR hooks require the base to be; the repo default unless FACTORY_SANDBOX_REF says otherwise.
    base = sandboxRef(deps.env);
    const brief = input.brief ?? (await briefFromTicket(deps.mcp, issueKey));
    const links = brief === undefined ? {} : briefLinks(brief, issueKey);
    try {
      const created = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo: name,
        title: implementPrTitle({ issueKey, title: input.title }),
        head: branch,
        base,
        body: implementPrBody({ issueKey, links, summary: run.summary, agentUrl, env: deps.env }),
        draft: false,
      });
      const number = (created.data as { number?: unknown } | undefined)?.number;
      if (typeof number !== "number") return { outcome: "write_failed", step: "create", status: created.status, branch };
      open = { number, state: "open" };
      opened = true;
    } catch (error) {
      // 422 is GitHub's "a pull request already exists": the agent opened one after all.
      const again = httpStatus(error).status === 422 ? await pullsForHead(octokit, { owner, name, branch }) : undefined;
      const raced = again !== undefined && "pulls" in again ? again.pulls.find((pull) => pull.state === "open") : undefined;
      if (raced === undefined) return { outcome: "write_failed", step: "create", branch, ...httpStatus(error) };
      open = raced;
    }
  }

  const pr = `${repo}#${open.number}`;
  const url = pullUrl(repo, open.number);
  // A reused PR is checked the way pr-ready.ts retries: undrafted unless a person drafted it.
  const target = { issueKey, repository: repo, number: open.number, ...(opened ? { mode: "open" as const } : { mode: "retry" as const, draft: true }) };
  const ready = await markReadyForReview(
    { kv: deps.kv, github: deps.github, now: deps.now, ...(deps.readyRetryMs === undefined ? {} : { retryMs: deps.readyRetryMs }), ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
    target
  );
  if (readyFailed(ready.outcome)) await noteNotReady(deps, { issueKey, pr, target, result: ready });

  let move: Extract<ImplementPrResult, { outcome: "opened" | "reused" }>["move"];
  try {
    move = (await advanceTicket({ kv: deps.kv, mcp: deps.mcp, env: deps.env, now: deps.now, ...(deps.log === undefined ? {} : { log: deps.log }) }, { move: true, stage: "in_review", issueKey, pr, url })).outcome;
  } catch {
    move = "retry";
  }
  return { outcome: opened ? "opened" : "reused", pr, url, branch, ...(base === undefined ? {} : { base }), ready: ready.outcome, move };
}

/** `KEY: <ticket title>`, inside GitHub's 256-character title limit, cut between words. */
export function implementPrTitle(input: { issueKey: string; title?: string | undefined }): string {
  const title = input.title?.trim() ?? "";
  const full = title === "" || title === input.issueKey ? input.issueKey : title.startsWith(`${input.issueKey}:`) ? title : `${input.issueKey}: ${title}`;
  return full.length <= 256 ? full : `${wordPrefix(full, 255)}…`;
}

/** Leading link lines an agent may still write into its final message; the worker writes its own. */
const LINK_LINE = /^\s*(?:\*\*)?(?:Jira|Slack(?: thread)?)(?:\*\*)?:/i;

const SUMMARY_MAX = 60_000;

/**
 * `Jira:` then `Slack:` (the brief's links; the Jira line falls back to this
 * site's browse URL), then the agent's final message, then the agent link.
 * The header is the shape pr-body.ts keeps, so its `opened` check writes nothing.
 */
export function implementPrBody(input: { issueKey: string; links: TicketLinks; summary?: string | undefined; agentUrl: string; env: NodeJS.ProcessEnv }): string {
  const jira = input.links.jira ?? browseUrl(input.issueKey, input.env);
  const header = [`Jira: ${jira}`, ...(input.links.slack === undefined ? [] : [`Slack: ${input.links.slack}`])];
  const lines = (input.summary ?? "").replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && (lines[0]!.trim() === "" || LINK_LINE.test(lines[0]!))) lines.shift();
  const summary = lines.join("\n").trim().slice(0, SUMMARY_MAX);
  return [...header, "", ...(summary === "" ? [] : [summary, ""]), `Implement agent: ${input.agentUrl}`].join("\n");
}

function browseUrl(issueKey: string, env: NodeJS.ProcessEnv): string {
  const site = jiraCloudId(env);
  return `${(/^https:\/\//.test(site) ? site : DEFAULT_CLOUD_ID).replace(/\/+$/, "")}/browse/${issueKey}`;
}

async function briefFromTicket(mcp: HostMcpRegistry, issueKey: string): Promise<string | undefined> {
  const read = await readComments(mcp, issueKey).catch(() => undefined);
  if (read?.status !== "read") return undefined;
  const plan = latestPlanComment(read.comments, issueKey);
  return plan === undefined ? undefined : extractBrief(plan);
}

type Failed = { failed: { status?: number } };

/** Branches on the repo whose name starts with exactly this key (`TLSSN-35-…`, never `TLSSN-350-…`). */
async function keyBranch(octokit: Octokit, input: { owner: string; name: string; issueKey: string; projects: readonly string[] }): Promise<{ branches: string[] } | Failed> {
  try {
    const read = await octokit.request(`GET /repos/{owner}/{repo}/git/matching-refs/heads/${encodeURIComponent(input.issueKey)}`, { owner: input.owner, repo: input.name });
    const refs = Array.isArray(read.data) ? (read.data as { ref?: unknown }[]) : [];
    const branches = refs
      .map((entry) => (typeof entry.ref === "string" ? entry.ref.replace(/^refs\/heads\//, "") : ""))
      .filter((branch) => issueKeyAtStart(branch, input.projects) === input.issueKey);
    return { branches };
  } catch (error) {
    return { failed: httpStatus(error) };
  }
}

/** Every PR from `branch`, open first. */
async function pullsForHead(octokit: Octokit, input: { owner: string; name: string; branch: string }): Promise<{ pulls: PullSummary[] } | Failed> {
  try {
    const read = await octokit.request("GET /repos/{owner}/{repo}/pulls", { owner: input.owner, repo: input.name, head: `${input.owner}:${input.branch}`, state: "all", per_page: 30 });
    const pulls = (Array.isArray(read.data) ? (read.data as { number?: unknown; state?: unknown }[]) : [])
      .filter((pull): pull is PullSummary => typeof pull.number === "number" && typeof pull.state === "string")
      .map((pull) => ({ number: pull.number, state: pull.state }));
    return { pulls: [...pulls.filter((pull) => pull.state === "open"), ...pulls.filter((pull) => pull.state !== "open")] };
  } catch (error) {
    return { failed: httpStatus(error) };
  }
}

function pullUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

function httpStatus(error: unknown): { status?: number } {
  const status = error !== null && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? { status } : {};
}

// The reminder armed at launch. It fires first after IMPLEMENT_PR_FIRST_MS and
// then every IMPLEMENT_PR_POLL_MS while the agent has pushed nothing, up to
// IMPLEMENT_PR_MAX_MS after it was armed. A named handler with JSON args,
// because hosted v2 fires those and rejects anonymous reminder `run`.
//
// `implement-pr-watch/<KEY>` is written before the reminder and listed in
// `implement-pr-watch/index` (host.kv cannot list keys), so a watch whose
// reminder could not be created, or stopped firing, is still found: the
// backstop sweep (implement-pr-sweep.ts) fires it from the worker's own
// deliveries, and a later arm (`retry KEY`) re-arms it. The record names its
// reminder; a fire from any other reminder is superseded and stops, so one
// ticket has one live poller.

export const IMPLEMENT_PR_HANDLER = "implement_pr";
export const IMPLEMENT_PR_FIRST_MS = 10 * 60_000;
export const IMPLEMENT_PR_POLL_MS = 5 * 60_000;
export const IMPLEMENT_PR_MAX_MS = 8 * 60 * 60_000;
/** A watch whose reminder is this late past its due time counts as lost. */
export const IMPLEMENT_PR_GRACE_MS = 10 * 60_000;

export type ImplementPrArgs = { issueKey: string; title?: string; armedAt: string };

export type ImplementPrWatch = { armedAt: string; dueAt: string; reminderId?: string; title?: string };

/** Records written before `dueAt` existed are due at their first fire. */
export function parseImplementPrWatch(value: unknown): ImplementPrWatch | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const armedAt = record["armedAt"];
  if (typeof armedAt !== "string" || !Number.isFinite(Date.parse(armedAt))) return undefined;
  const due = record["dueAt"];
  const dueAt = typeof due === "string" && Number.isFinite(Date.parse(due)) ? due : new Date(Date.parse(armedAt) + IMPLEMENT_PR_FIRST_MS).toISOString();
  const reminderId = record["reminderId"];
  const title = record["title"];
  return { armedAt, dueAt, ...(typeof reminderId === "string" ? { reminderId } : {}), ...(typeof title === "string" && title !== "" ? { title } : {}) };
}

/** Past its due time, plus the grace when a reminder is recorded to fire it. */
export function implementPrWatchLate(watch: ImplementPrWatch, now: Date): boolean {
  return now.getTime() >= Date.parse(watch.dueAt) + (watch.reminderId === undefined ? 0 : IMPLEMENT_PR_GRACE_MS);
}

export async function readImplementPrIndex(kv: KeyedKv): Promise<string[]> {
  return indexList(await kv.get(IMPLEMENT_PR_INDEX));
}

// Hosted kv has no compare-and-set. Index writes are verified merges
// (kv-index.ts): an add is a union onto the list as stored, a prune removes
// only the keys the sweep verified gone from the list as stored. This
// in-process queue only orders the writes of one pod; another replica's
// writes are the merges' job. `FACTORY_INDEX_MERGE=off` restores the plain
// read-then-put, still behind the queue.
let indexWrite: Promise<void> = Promise.resolve();

function withIndexWrite<T>(work: () => Promise<T>): Promise<T> {
  const run = indexWrite.then(work, work);
  indexWrite = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Remove `gone` from `implement-pr-watch/index`: the verified re-filter of
 * the stored list, then a re-add of any gone key whose record is back (a
 * re-arm whose add found the key still listed wrote nothing, and an arm
 * writes its record before it adds). With the merge off, a plain
 * read-then-put.
 */
export async function pruneImplementPrIndex(kv: KeyedKv, input: { gone: ReadonlySet<string>; env: NodeJS.ProcessEnv }): Promise<void> {
  const { gone } = input;
  await withIndexWrite(async () => {
    if (indexMergeOn(input.env)) {
      await pruneIndexEntries(kv, IMPLEMENT_PR_INDEX, { gone });
      for (const key of gone) {
        if ((await kv.get(implementPrWatchKey(key))) !== undefined) await addIndexEntry(kv, IMPLEMENT_PR_INDEX, { entry: key, attempts: 3 });
      }
      return;
    }
    const current = await readImplementPrIndex(kv);
    await kv.put(IMPLEMENT_PR_INDEX, current.filter((key) => !gone.has(key)));
  });
}

/**
 * List `issueKey`: a verified union with `attempts` (2 before the reminder
 * create, 1 as the confirm after it, 3 on a self-heal), or with the merge off
 * a plain read-then-put.
 */
async function addToIndex(kv: KeyedKv, input: { issueKey: string; attempts: number; env: NodeJS.ProcessEnv }): Promise<void> {
  const { issueKey } = input;
  await withIndexWrite(async () => {
    if (indexMergeOn(input.env)) {
      await addIndexEntry(kv, IMPLEMENT_PR_INDEX, { entry: issueKey, attempts: input.attempts });
      return;
    }
    const current = await readImplementPrIndex(kv);
    if (!current.includes(issueKey)) await kv.put(IMPLEMENT_PR_INDEX, [...current, issueKey]);
  });
}

export function parseImplementPrArgs(args: unknown): ImplementPrArgs | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const issueKey = record["issueKey"];
  const armedAt = record["armedAt"];
  if (typeof issueKey !== "string" || !/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey) || typeof armedAt !== "string" || !Number.isFinite(Date.parse(armedAt))) return undefined;
  const title = record["title"];
  return { issueKey, armedAt, ...(typeof title === "string" && title.trim() !== "" ? { title } : {}) };
}

export type ArmResult = "armed" | "already" | "unavailable" | "failed";

/**
 * One watch per ticket. A young watch whose reminder is recorded and on time
 * is left alone; one whose reminder was never created, or is late past the
 * grace, gets a new reminder (the lost one cancelled) and keeps its lifetime.
 * The record lands before the reminder, so a failed create leaves it for the
 * sweep. Never throws.
 */
export async function armImplementPrWatch(
  deps: { kv: KeyedKv; reminders: ReminderHostApi | undefined; now: () => Date; env?: NodeJS.ProcessEnv },
  input: { issueKey: string; title?: string }
): Promise<ArmResult> {
  const now = deps.now();
  const env = deps.env ?? process.env;
  const key = implementPrWatchKey(input.issueKey);
  try {
    const current = parseImplementPrWatch(await deps.kv.get(key));
    const young = current !== undefined && now.getTime() - Date.parse(current.armedAt) < IMPLEMENT_PR_MAX_MS ? current : undefined;
    if (young !== undefined && (deps.reminders === undefined || (young.reminderId !== undefined && !implementPrWatchLate(young, now)))) {
      // Self-heal: an index entry another writer dropped comes back on the next arm.
      if (indexMergeOn(env)) await addToIndex(deps.kv, { issueKey: input.issueKey, attempts: 3, env });
      return deps.reminders === undefined ? "unavailable" : "already";
    }
    const title = input.title ?? young?.title;
    const dueMs = young === undefined ? IMPLEMENT_PR_FIRST_MS : Math.max(Date.parse(young.dueAt) - now.getTime(), 0) || IMPLEMENT_PR_POLL_MS;
    const watch: ImplementPrWatch = {
      armedAt: young?.armedAt ?? now.toISOString(),
      dueAt: new Date(now.getTime() + dueMs).toISOString(),
      ...(title === undefined ? {} : { title }),
    };
    await deps.kv.put(key, watch);
    await addToIndex(deps.kv, { issueKey: input.issueKey, attempts: 2, env });
    if (deps.reminders === undefined) return "unavailable";
    if (young?.reminderId !== undefined) await deps.reminders.cancel(young.reminderId, "lost").catch(() => undefined);
    const args: ImplementPrArgs = { issueKey: input.issueKey, armedAt: watch.armedAt, ...(title === undefined ? {} : { title }) };
    // The second addToIndex, whether the create worked or not, is the confirm:
    // it puts back a key another pod's write dropped while the create ran.
    let reminder: Awaited<ReturnType<typeof deps.reminders.create>>;
    try {
      reminder = await deps.reminders.create({
        purpose: IMPLEMENT_PR_HANDLER,
        channelId: "jira",
        continuationToken: `implement-pr:${input.issueKey}`,
        target: { issueKey: input.issueKey },
        delay: `${Math.max(1, Math.ceil(dueMs / 60_000))}m`,
        handler: IMPLEMENT_PR_HANDLER,
        args,
      });
    } catch (error) {
      warnStep("implement-pr.armImplementPrWatch.reminder", error);
      return "failed";
    } finally {
      await addToIndex(deps.kv, { issueKey: input.issueKey, attempts: 1, env }).catch((error: unknown) => warnKv("implement-pr.armImplementPrWatch.addToIndex", error));
    }
    const latest = parseImplementPrWatch(await deps.kv.get(key));
    if (latest?.armedAt === watch.armedAt) await deps.kv.put(key, { ...latest, reminderId: reminder.id });
    return "armed";
  } catch (error) {
    warnKv("implement-pr.armImplementPrWatch", error);
    return "failed";
  }
}

/** Outcomes the next fire may change: the agent is still working, or a read or write failed. */
const WAIT_OUTCOMES = new Set<ImplementPrResult["outcome"]>(["no_run", "agent_running", "unavailable", "read_failed", "write_failed"]);

/** True when a later try may still open the PR or make the move, so a watch should keep trying. */
export function implementPrPending(result: ImplementPrResult): boolean {
  return WAIT_OUTCOMES.has(result.outcome) || ("move" in result && result.move === "retry");
}

export type ImplementPrFire = { result: ImplementPrResult | { outcome: "superseded" }; rescheduleMs?: number };

/**
 * One fire, from the watch's reminder (`reminderId`) or the sweep (none):
 * try, then keep polling while the outcome can still change and the watch
 * is young. A reminder the record does not name was replaced and stops
 * without a read.
 */
export async function fireImplementPrWatch(deps: ImplementPrDeps, args: ImplementPrArgs, options: { reminderId?: string } = {}): Promise<ImplementPrFire> {
  const key = implementPrWatchKey(args.issueKey);
  const watch = await deps.kv.get(key).then(parseImplementPrWatch, (error: unknown) => warnKv("implement-pr.fireImplementPrWatch.get", error));
  if (options.reminderId !== undefined && watch?.reminderId !== undefined && watch.reminderId !== options.reminderId) return { result: { outcome: "superseded" } };
  const result = await ensureImplementPr(deps, args);
  const now = deps.now();
  if (implementPrPending(result) && now.getTime() - Date.parse(args.armedAt) < IMPLEMENT_PR_MAX_MS) {
    // Re-read: an arm during the fire may have named a new reminder, which this write must keep.
    const latest = await deps.kv.get(key).then(parseImplementPrWatch, (error: unknown) => warnKv("implement-pr.fireImplementPrWatch.get.2", error));
    if (latest !== undefined) await deps.kv.put(key, { ...latest, dueAt: new Date(now.getTime() + IMPLEMENT_PR_POLL_MS).toISOString() }).catch((error: unknown) => warnKv("implement-pr.fireImplementPrWatch.put", error));
    await addToIndex(deps.kv, { issueKey: args.issueKey, attempts: 3, env: deps.env }).catch((error: unknown) => warnKv("implement-pr.fireImplementPrWatch.addToIndex", error));
    return { result, rescheduleMs: IMPLEMENT_PR_POLL_MS };
  }
  await deps.kv.delete(key).catch((error: unknown) => warnKv("implement-pr.fireImplementPrWatch.delete", error));
  return { result };
}

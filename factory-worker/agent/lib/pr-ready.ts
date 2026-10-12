import { refusesProductionTarget } from "./factory-stage.js";
import { supportsKvCas, type HostMcpRegistry } from "@cursor/july";
import { hasLaunched } from "./claim.js";
import { addComment } from "./jira.js";
import { implementPrKey, isHuman, type PrActor, type PrDelivery } from "./pr-decide.js";
import { type KeyedKv, readyNoteKey, readyRecordKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { readyRecordKey };

// Every factory PR is ready for review, never left a draft: Bugbot does not
// run on drafts, so a draft waits on a person before it gets a review.
// The worker opens the PR ready itself (implement-pr.ts); this is the safety
// net for one that still arrives a draft (an agent that opened its own, or a
// bot that re-drafts it), marked ready the moment a delivery for it arrives,
// before the In Review move.
// GitHub's REST API cannot undraft; the GraphQL
// `markPullRequestReadyForReview` mutation is the only way.
//
// Hosted github-proxy scopes each call by `x-cursor-github-repos`, which July
// fills from a `/repos/<owner>/<repo>` URL. A hosted slot boots before
// FACTORY_SANDBOX_REPO is bound, so the channel is `cursorAccount: true` and
// no static scope is set; `POST /graphql` has no repo in its URL, and the
// proxy answers 400. That left cursor-demo-lab/marsbank#28 a draft, so the
// mutation names its repo in that header itself.
//
// `opened` and `reopened` always check. Until the worker has seen the PR
// ready (`pr-ready/<repo>#<n>`), a push or an edit checks again, so one
// failed write is retried by the PR's next delivery. A PR a person converted
// to draft stays a draft. A bot that drafts it (the implement agent itself,
// which on marsbank#29 said it left its PR in draft) is undrafted again, and
// so is a PR recorded ready whose push or edit arrives with `draft: true`.

const OPEN_ACTIONS = new Set(["opened", "reopened"]);
const RETRY_ACTIONS = new Set(["synchronize", "edited"]);

/** Pauses between in-task tries of a failed read or write. */
export const READY_RETRY_MS: readonly number[] = [1_000, 4_000];

type ReadyResponse = { status: number; data: unknown };

/** The slice of July's `ctx.github` this path uses. */
export type ReadyApi = {
  getOctokit(): Promise<{ request(route: string, params?: Record<string, unknown>): Promise<ReadyResponse> }>;
};

/** `open`: opened or reopened. `retry`: a later delivery, acted on only until the PR is recorded. `seen`: a delivery that only records. */
export type ReadyMode = "open" | "retry" | "seen_ready" | "person_drafted";

export type ReadyTarget = { issueKey: string; repository: string; number: number; mode: ReadyMode; draft?: boolean };

export type ReadyOutcome =
  | "marked_ready"
  | "already_ready"
  | "recorded"
  | "not_launched"
  | "unavailable"
  | "read_failed"
  | "write_failed"
  | "failed"
  | "staging_refused";

export type ReadyResult = { outcome: ReadyOutcome; attempts?: number; status?: number };

/** The outcomes that leave a launched implement PR a draft the worker should have undrafted. */
export function readyFailed(outcome: ReadyOutcome): boolean {
  return outcome === "read_failed" || outcome === "write_failed" || outcome === "failed" || outcome === "unavailable";
}

/**
 * The implement PR the worker marks ready (or records), or undefined. `draft`
 * is the delivery body's `pull_request.draft` when it carries one; only an
 * explicit `false` skips the GitHub read, since the Cursor event stream may
 * omit it.
 */
export function readyablePullRequest(
  input: PrDelivery & { draft?: boolean },
  opts: { sandboxRepo: string; sandboxRef: string; projects: readonly string[] }
): ReadyTarget | undefined {
  if (input.merged) return undefined;
  if (input.repository.toLowerCase() !== opts.sandboxRepo.toLowerCase()) return undefined;
  if (input.baseRef !== opts.sandboxRef) return undefined;
  const mode = readyMode(input.action, input.sender, input.draft);
  if (mode === undefined) return undefined;
  const issueKey = implementPrKey({ headRef: input.headRef, title: input.title, authorLogin: input.authorLogin, projects: opts.projects });
  if (issueKey === undefined) return undefined;
  return { issueKey, repository: input.repository, number: input.number, mode, ...(input.draft === undefined ? {} : { draft: input.draft }) };
}

function readyMode(action: string, sender: PrActor | undefined, draft: boolean | undefined): ReadyMode | undefined {
  if (action === "ready_for_review") return "seen_ready";
  if (action === "converted_to_draft") return sender !== undefined && isHuman(sender) ? "person_drafted" : "open";
  if (draft === false) return undefined;
  if (OPEN_ACTIONS.has(action)) return "open";
  if (RETRY_ACTIONS.has(action)) return "retry";
  return undefined;
}

type ReadyRecord = { at: string; state: "ready" | "person_drafted" };

const MARK_READY = "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }";

type Attempt = { outcome: Exclude<ReadyOutcome, "recorded" | "not_launched" | "unavailable">; status?: number };

/**
 * Needs a `launched` `implement/<KEY>`, so only a PR the worker's own agent
 * opened is touched. Reads the PR for `draft` and `node_id`, then runs the
 * mutation only on a draft; a read or write that fails is tried again after
 * each of `retryMs`. Never throws: the caller decides what a PR left draft
 * does to the rest of the delivery.
 */
export async function markReadyForReview(
  deps: { kv: KeyedKv; github: ReadyApi; now?: () => Date; retryMs?: readonly number[]; sleep?: (ms: number) => Promise<void> },
  target: ReadyTarget
): Promise<ReadyResult> {
  // A staging slug never undrafts a pull request on the production repository (factory-stage.ts).
  if (refusesProductionTarget(process.env, { kind: "repos", value: target.repository })) return { outcome: "staging_refused" };
  const now = deps.now ?? (() => new Date());
  const key = readyRecordKey(target);
  try {
    const launched = await hasLaunched(deps.kv, target.issueKey);
    if (launched === "unavailable") return { outcome: "unavailable" };
    if (!launched) return { outcome: "not_launched" };
    if (target.mode === "seen_ready" || target.mode === "person_drafted") {
      await deps.kv.put(key, { at: now().toISOString(), state: target.mode === "seen_ready" ? "ready" : "person_drafted" } satisfies ReadyRecord);
      return { outcome: "recorded" };
    }
    if (target.mode === "retry") {
      const record = await deps.kv.get(key);
      const state = record !== null && typeof record === "object" ? (record as Record<string, unknown>)["state"] : undefined;
      if (state === "person_drafted" || (record !== undefined && target.draft !== true)) return { outcome: "recorded" };
    }
  } catch (error) {
    warnKv("pr-ready.markReadyForReview.put.1", error);
    return { outcome: "unavailable" };
  }

  const pauses = deps.retryMs ?? READY_RETRY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt: Attempt = { outcome: "failed" };
  let attempts = 0;
  for (;;) {
    attempts += 1;
    attempt = await tryMarkReady(deps.github, target);
    const pause = pauses[attempts - 1];
    if (!readyFailed(attempt.outcome) || pause === undefined) break;
    await sleep(pause);
  }
  if (!readyFailed(attempt.outcome)) {
    await deps.kv.put(key, { at: now().toISOString(), state: "ready" } satisfies ReadyRecord).catch((error: unknown) => warnKv("pr-ready.markReadyForReview.put.2", error));
  }
  return { outcome: attempt.outcome, attempts, ...(attempt.status === undefined ? {} : { status: attempt.status }) };
}

async function tryMarkReady(github: ReadyApi, target: ReadyTarget): Promise<Attempt> {
  const [owner = "", repo = ""] = target.repository.split("/");
  let octokit: Awaited<ReturnType<ReadyApi["getOctokit"]>>;
  let current: { draft?: unknown; node_id?: unknown };
  try {
    octokit = await github.getOctokit();
    const read = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: target.number });
    current = (read.data ?? {}) as typeof current;
  } catch (error) {
    return { outcome: "read_failed", ...httpStatus(error) };
  }
  if (typeof current.node_id !== "string") return { outcome: "read_failed" };
  if (current.draft !== true) return { outcome: "already_ready" };
  try {
    const written = await octokit.request("POST /graphql", {
      query: MARK_READY,
      variables: { id: current.node_id },
      headers: { "x-cursor-github-repos": target.repository.toLowerCase() },
    });
    const body = (written.data ?? {}) as { errors?: unknown[]; data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } } };
    if ((body.errors?.length ?? 0) > 0 || body.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
      return { outcome: "write_failed", status: written.status };
    }
    return { outcome: "marked_ready" };
  } catch (error) {
    return { outcome: "write_failed", ...httpStatus(error) };
  }
}

function httpStatus(error: unknown): { status?: number } {
  const status = error !== null && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? { status } : {};
}

/** The one Jira note for a launched implement PR the worker could not undraft. No raw error text, like `Launch failed:`. */
export function prReadyNote(input: { pr: string; result: ReadyResult }): string {
  const { outcome, status } = input.result;
  const why = `${outcome}${status === undefined ? "" : `, HTTP ${status}`}`;
  return `Ready for review not marked on ${input.pr}: the worker could not undraft it (${why}), so Bugbot has not reviewed it. The pull request's next push retries; if it stays a draft, mark it ready on GitHub.`;
}

/**
 * {@link prReadyNote} on the ticket, once per pull request (`pr-ready-note/`
 * in kv). Hosted v2 keeps no logs a person can read, so this is the evidence.
 * Best effort: a note that cannot be claimed or written changes nothing.
 */
export async function noteNotReady(
  deps: { kv: KeyedKv; mcp: HostMcpRegistry; now: () => Date },
  input: { issueKey: string; pr: string; target: ReadyTarget; result: ReadyResult }
): Promise<"written" | "duplicate" | "failed"> {
  const key = readyNoteKey(input.target);
  // Plain read then put, with no owner and no settle (accepted, KV Phase 1
  // K3): two deliveries can both pass, and the worst case is one repeated note.
  try {
    if (supportsKvCas(deps.kv)) {
      if (!(await deps.kv.putIfAbsent(key, { at: deps.now().toISOString() })).ok) return "duplicate";
    } else {
      if ((await deps.kv.get(key)) !== undefined) return "duplicate";
      await deps.kv.put(key, { at: deps.now().toISOString() });
    }
  } catch (error) {
    warnKv("pr-ready.noteNotReady.putIfAbsent", error);
    return "failed";
  }
  const written = await addComment(deps.mcp, { issueKey: input.issueKey, body: prReadyNote({ pr: input.pr, result: input.result }) }).catch(() => undefined);
  if (written?.status === "commented") return "written";
  await deps.kv.delete(key).catch((error: unknown) => warnKv("pr-ready.noteNotReady.delete", error));
  return "failed";
}

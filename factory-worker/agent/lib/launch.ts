import { noteFactory, traceFactory } from "./factory-otel.js";
import { refusesProductionTarget, stagingRefusal } from "./factory-stage.js";
import type { AgentOptions, ModelSelection } from "@cursor/sdk";

// One cloud agent per approved ticket. A delivery starts it as a July cloud
// turn on the jira channel (implement-turn.ts), so July attributes the
// agent's turns, tokens and cost to the ticket's session. What stays on
// `@cursor/sdk` here is the launch watch's heal (launch-heal.ts), which runs
// from a reminder: July's reminder `followup` carries no `cloud` attach and
// the engine refuses a send inside a hosted admission it did not capture
// (reminder-runner.js `sendFollowup`, session-engine.js `send`), so a lost launch is
// relaunched through `Agent.create` with the claim key as its
// `idempotencyKey`. The SDK sends nothing at `Agent.create`; the first
// `send` is the `POST /v1/agents` that carries the prompt and the
// `Idempotency-Key` header.
//
// The SDK pieces a July-started agent still needs. `findLaunchedAgent` can
// only see agents the SDK heal named `factory <KEY>: …`: July's cloud create
// passes no `name` (sdk-runner.js `buildSharedOptions`; the session title
// stays on the session), and the server names the agent from its prompt.
// Nor can the id be chosen up front: `SendMessageOptions.sdkAgentId` is
// forwarded to `Agent.create({ agentId })` only for an id that does not
// start with `bc-` (sdk-runner.js `openCloudAgent` resumes a `bc-` seed as
// server-minted), and the SDK routes an id that does not start with `bc-`
// to its local store on the calls that route by id prefix (`Agent.get`,
// `archive`, `unarchive`, `delete`: `GetAgentOptions` in agent.d.ts, and
// `Agent.resume` with no `cloud` option; `Agent.listRuns` routes on
// `options.runtime === "cloud"` instead, so the run reader is unaffected),
// where the cloud agent is not. So a July-started agent is
// known by its `agent.bound` event alone, and the session's handler writes
// it to `implement-agent/<KEY>` (claim.ts `noteBoundAgent`) before the
// claim, where a takeover reads it before any listing (handle.ts
// `existingAgent`). The listing stays as the check for an agent the SDK
// heal started; the orphan retire (`sdkRetireAgent`), the status read
// behind a failed turn (`sdkAgentStatus`) and the run reader behind the
// implement PR watch (implement-pr.ts) stay on the SDK too: July exposes no
// listing or status of another session's cloud agents.

/** Thrown when no launch can be assumed. The caller releases its claim. */
export class LaunchNotStartedError extends Error {
  /** A short code safe to post on the ticket. Never the raw message. */
  readonly reason: string;
  constructor(input: { message: string; reason?: string }) {
    super(`factory-worker: launch did not start: ${input.message}`);
    this.name = "LaunchNotStartedError";
    this.reason = input.reason ?? "unknown_error";
  }
}

/**
 * The create and first send did not answer within the deadline. Nothing is
 * known about the agent: the request is still running, and `late` settles
 * with its result. The caller keeps its claim and records a late success;
 * it never treats this as a failure.
 */
export class LaunchTimeoutError extends LaunchNotStartedError {
  readonly late: Promise<Launched>;
  constructor(input: { timeoutMs: number; late: Promise<Launched> }) {
    super({ message: `no answer from the launch API within ${input.timeoutMs} ms`, reason: "launch_timeout" });
    this.name = "LaunchTimeoutError";
    this.late = input.late;
  }
}

const REASON_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Node and undici network error codes, plus the SDK's retryable
 * `connection_stalled`. They name the transport, not the launch, so they read as unavailable.
 */
const TRANSPORT_CODE = /^(ECONN[A-Z]*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_[A-Z_]+|connection_stalled)$/i;

/** The SDK wraps undici's `fetch failed`, which wraps the socket error, so the transport code sits two causes down. */
const CAUSE_DEPTH = 4;

/**
 * Maps an SDK or API error to a code from a closed alphabet. Only the code
 * leaves the process, so a message carrying a token or a URL cannot reach Jira.
 */
export function launchFailureReason(error: unknown): string {
  const record = asRecord(error);
  const message = error instanceof Error ? error.message : String(error);
  const structuredStatus = typeof record["status"] === "number" ? record["status"] : undefined;
  const status = structuredStatus ?? Number(/\b([45]\d\d)\b/.exec(message)?.[1] ?? NaN);
  const code = typeof record["code"] === "string" ? record["code"] : (/^\[([a-z0-9_]+)\]/i.exec(message)?.[1] ?? "");
  if (/at most 100 character/i.test(message)) return "name_too_long";
  if (status === 401 || /unauthori[sz]ed|unauthenticated/i.test(message)) return "unauthorized";
  if (status === 403 || /forbidden|permission denied/i.test(message)) return "forbidden";
  if (status === 429 || /rate.?limit/i.test(message)) return "rate_limited";
  if (causeCodes(error).some((each) => TRANSPORT_CODE.test(each))) return "service_unavailable";
  if (structuredStatus !== undefined && structuredStatus >= 500) return "service_unavailable";
  const normalized = code.toLowerCase();
  if (REASON_CODE.test(normalized) && normalized !== "unknown") return normalized;
  if (status >= 500 || /timed? ?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message)) return "service_unavailable";
  if (record["name"] === "NetworkError") return "service_unavailable";
  return "unknown_error";
}

/** String `code`s on the error and its `cause` chain, nearest first. */
function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= CAUSE_DEPTH && current !== null && typeof current === "object"; depth += 1) {
    const code = asRecord(current)["code"];
    if (typeof code === "string") codes.push(code);
    current = asRecord(current)["cause"];
  }
  return codes;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The slice of `SDKAgent` the launch uses, so tests can pass a fake `Agent.create`. */
export type LaunchedAgent = {
  readonly agentId: string;
  send(message: string): Promise<unknown>;
  close(): void;
};

export type CreateAgent = (options: AgentOptions) => Promise<LaunchedAgent>;

/**
 * How long the create and first send may take together. The SDK's `fetch`
 * has no deadline of its own, and a socket frozen across a hosted pod park
 * can stall it far past the admission; a stalled launch must end as a
 * recorded failure that releases its claim, never as a silent pending one.
 * The retry the delivery took about 8 s end to end (TLSSN-51).
 */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** A launch past its deadline is still awaited this long (handle.ts), so a slow create is recorded by the delivery that made it. */
export const LAUNCH_LATE_WAIT_MS = 60_000;

export type LaunchDeps = { createAgent: CreateAgent; timeoutMs?: number };

export type LaunchInput = {
  issueKey: string;
  title: string;
  brief: string;
  model: ModelSelection;
  repo: string;
  ref: string;
  idempotencyKey: string;
};

export type Launched = { agentId: string; url: string };

/** One `factory.cloud_agent.launch` span per attempt: the ticket, the agent id, or the failure's reason code. */
export async function launchImplementation(deps: LaunchDeps, input: LaunchInput): Promise<Launched> {
  return traceFactory({ span: "factory.cloud_agent.launch", kind: "cloud_agent.launch", ticketKey: input.issueKey }, async () => {
    const launched = await launchWithin(deps, input);
    noteFactory({ outcome: "launched", agentId: launched.agentId });
    return launched;
  });
}

async function launchWithin(deps: LaunchDeps, input: LaunchInput): Promise<Launched> {
  // A staging slug never starts an implementing agent on the production repository (factory-stage.ts).
  if (refusesProductionTarget(process.env, { kind: "repos", value: input.repo })) {
    throw new LaunchNotStartedError({ message: stagingRefusal(input.repo), reason: "staging_refuses_production" });
  }
  const timeoutMs = deps.timeoutMs ?? LAUNCH_TIMEOUT_MS;
  const started = startLaunch(deps, input);
  // The race's loser still runs; its own `finally` closes a late agent, and its rejection is observed here.
  started.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([started, expired]);
    if (result === "timeout") throw new LaunchTimeoutError({ timeoutMs, late: started });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function startLaunch(deps: LaunchDeps, input: LaunchInput): Promise<Launched> {
  let agent: LaunchedAgent;
  try {
    agent = await deps.createAgent({
      name: agentName({ issueKey: input.issueKey, title: input.title }),
      idempotencyKey: input.idempotencyKey,
      model: input.model,
      cloud: {
        repos: [{ url: `https://github.com/${input.repo}`, startingRef: input.ref }],
        // The platform opens autoCreatePR PRs as drafts and Bugbot skips drafts,
        // so the worker opens a ready PR from the agent's branch (implement-pr.ts).
        autoCreatePR: false,
      },
    });
  } catch (error) {
    throw new LaunchNotStartedError({ message: describe(error), reason: launchFailureReason(error) });
  }
  try {
    await agent.send(implementPrompt(input));
    return { agentId: agent.agentId, url: agentUrl(agent.agentId) };
  } catch (error) {
    // A send can fail after the server created the agent. The retry relies on
    // the same idempotency key returning that agent, which is unverified.
    throw new LaunchNotStartedError({ message: describe(error), reason: launchFailureReason(error) });
  } finally {
    agent.close();
  }
}

/**
 * Stop an agent this worker started but no longer records: cancel its
 * running runs, then archive it (`Agent.listRuns`, `Agent.cancelRun`,
 * `Agent.archive`, @cursor/sdk 1.0.35). Archive is reversible from the dashboard.
 */
export type RetireAgent = (agentId: string) => Promise<void>;

export function sdkRetireAgent(sdk: {
  listRuns: (agentId: string, options: { runtime: "cloud"; limit: number }) => Promise<{ items: readonly { id: string; status: string }[] }>;
  cancelRun: (runId: string, options: { runtime: "cloud"; agentId: string }) => Promise<void>;
  archive: (agentId: string) => Promise<void>;
}): RetireAgent {
  return async (agentId) => {
    const runs = await sdk.listRuns(agentId, { runtime: "cloud", limit: 5 });
    for (const run of runs.items) {
      if (run.status === "running") await sdk.cancelRun(run.id, { runtime: "cloud", agentId });
    }
    await sdk.archive(agentId);
  };
}

/**
 * What a cloud agent is doing now, as `Agent.get` reports it: `running`,
 * `finished`, `error` (the SDK's `status`), `cancelled` when the SDK ever adds
 * it, or `unknown` when the read failed or the server gave no status. A failed
 * implement turn is a launch failure only when the agent itself is not
 * running or finished (handle.ts `turnFailed`).
 */
export type AgentStatusName = "running" | "finished" | "error" | "cancelled" | "unknown";

export type AgentStatus = (agentId: string) => Promise<AgentStatusName>;

export function sdkAgentStatus(get: (agentId: string) => Promise<{ status?: string | undefined }>): AgentStatus {
  return async (agentId) => {
    try {
      const status = (await get(agentId)).status;
      return status === "running" || status === "finished" || status === "error" || status === "cancelled" ? status : "unknown";
    } catch {
      return "unknown";
    }
  };
}

/** The slice of `Agent.list` the positive check uses. */
export type ListAgents = (options: { runtime: "cloud"; limit: number; cursor?: string }) => Promise<{
  items: readonly { agentId: string; name: string; createdAt?: number | undefined; lastModified: number }[];
  nextCursor?: string | undefined;
}>;

export type ExistingAgent = { found: Launched } | { found: "none" } | { found: "unknown"; why: string };

const LIST_PAGE = 50;
const LIST_PAGES = 3;
/** Clock skew between this host and the agents API, allowed when matching an agent to a claim's time. */
const LIST_SKEW_MS = 5 * 60_000;

/**
 * Whether a launch for this ticket since `since` already started an agent:
 * the newest agent named `factory <KEY>: …` created then or later. "none"
 * only when the listing reached past `since` (or its end); a listing cut
 * short or refused is "unknown", and the caller must not launch.
 * `@cursor/sdk` does not document what `idempotencyKey` does with a repeat,
 * so this is the check before any second create.
 *
 * GET /v1/agents documents no order (the SDK's local store sorts by update
 * time), so paging stops only on an item last modified before the window:
 * an agent is modified no earlier than it is created, so under creation or
 * update order everything after such an item was created before the window.
 * An older agent touched recently does not end the search.
 */
export async function findLaunchedAgent(listAgents: ListAgents, input: { issueKey: string; since: Date }): Promise<ExistingAgent> {
  const prefix = `factory ${input.issueKey}: `;
  const from = input.since.getTime() - LIST_SKEW_MS;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < LIST_PAGES; page += 1) {
      const listed = await listAgents({ runtime: "cloud", limit: LIST_PAGE, ...(cursor === undefined ? {} : { cursor }) });
      const stamp = (agent: { createdAt?: number | undefined; lastModified: number }) => agent.createdAt ?? agent.lastModified;
      const match = listed.items.filter((agent) => agent.name.startsWith(prefix) && stamp(agent) >= from).sort((a, b) => stamp(b) - stamp(a))[0];
      if (match !== undefined) return { found: { agentId: match.agentId, url: agentUrl(match.agentId) } };
      const reachedPast = listed.items.some((agent) => agent.lastModified < from);
      if (reachedPast || listed.nextCursor === undefined) return { found: "none" };
      cursor = listed.nextCursor;
    }
    return { found: "unknown", why: "listing_truncated" };
  } catch (error) {
    return { found: "unknown", why: launchFailureReason(error) };
  }
}

/**
 * How the implement agent hands its change to the worker, which opens the PR
 * (implement-pr.ts). The branch must start with the key: `factoryPrKey` finds
 * the PR by its head branch. The planner's brief still describes "one pull
 * request", so this says who opens it; the final message is the description.
 */
export function prHandoff(input: { issueKey: string; repo: string; ref: string }): string {
  const { issueKey, repo, ref } = input;
  return [
    "## Handing off the change",
    "",
    `When the change is committed, push it to a branch on ${repo}, based on \`${ref}\`, whose name starts with \`${issueKey}\` (for example \`${issueKey}-short-slug\`).`,
    "Do not open a pull request yourself, with a tool or with `gh`, even where the brief above asks for one: factory-worker opens it from your branch, ready for review, when you finish.",
    "Your final message becomes that pull request's description, below the `Jira:` and `Slack:` lines the worker writes. Write it as the description the brief asks for, without those two lines.",
    "Do not merge, enable auto-merge, or force-push.",
  ].join("\n");
}

/** The agent's first message, the same whether July sends it as a cloud turn (implement-turn.ts) or the SDK heal does. */
export function implementPrompt(input: Pick<LaunchInput, "issueKey" | "brief" | "repo" | "ref">): string {
  return `${input.brief}\n\n${prHandoff(input)}`;
}

// `SDKAgent` exposes only `agentId`. The server's `V1Agent.url` is not
// surfaced, so the URL is built from the id the way the dashboard links runs.
export function agentUrl(agentId: string): string {
  return `https://cursor.com/agents/${agentId}`;
}

/** The launch API refuses a name longer than this, counted in UTF-16 code units. */
export const AGENT_NAME_MAX = 100;

const ELLIPSIS = "…";

/** `factory KEY: title`, with the title cut between words (`wordPrefix`) so the name fits the API cap. */
export function agentName(input: { issueKey: string; title: string }): string {
  const { issueKey, title } = input;
  const prefix = `factory ${issueKey}: `;
  const full = `${prefix}${title}`;
  if (full.length <= AGENT_NAME_MAX) return full;
  const budget = Math.max(0, AGENT_NAME_MAX - prefix.length - ELLIPSIS.length);
  return `${prefix}${wordPrefix(title, budget)}${ELLIPSIS}`;
}

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The longest start of `text` at most `room` code units long, without
 * trailing spaces or `,;:([{/-–—`. It ends before a space, else between
 * UAX #29 words, each only when that keeps at least half the room; else
 * between graphemes (one long URL or hash), never inside an emoji.
 */
export function wordPrefix(text: string, room: number): string {
  if (text.length <= room) return text;
  const end = (segments: Iterable<{ index: number; segment: string }>) => {
    let last = 0;
    for (const { index, segment } of segments) {
      if (index + segment.length > room) break;
      last = index + segment.length;
    }
    return { last, enough: last * 2 >= room };
  };
  const spaced = end(Array.from(text.matchAll(/\s*\S+/g), (match) => ({ index: match.index, segment: match[0] })));
  const worded = spaced.enough ? spaced : end(WORDS.segment(text));
  return text.slice(0, worded.enough ? worded.last : end(GRAPHEMES.segment(text)).last).replace(/[\s,;:([{/\-–—]+$/u, "");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { SendMessageOptions } from "@cursor/july";
import { JIRA_ISSUE_KEY, noteFactory, traceFactory } from "./factory-otel.js";
import { refusesProductionTarget, stagingRefusal } from "./factory-stage.js";
import { agentName, implementPrompt, LaunchNotStartedError, launchFailureReason } from "./launch.js";

// The implement agent as a July cloud turn on the worker's own `jira`
// channel (July 0.2.18). A delivery calls the channel's `send()` with a
// per-send `cloud` attach; July creates the cloud agent with the pod's
// CURSOR_API_KEY (sdk-runner.js `buildSharedOptions` and `requireApiKey`,
// cursor/credentials.js resolveApiKeySync), the same identity the SDK launch
// used, and the session is the attribution unit: `cursor.token.usage`,
// `agent_sdk.turn.count` and the turn's spans carry the
// session's `factory.ticket.key` (hooks/ticket-key.ts). The `cloud` block
// rides on the send, never on agent.ts: FACTORY_SANDBOX_REPO is a hosted
// secret bound per request, not at load, and a cloud send with no repos
// makes the backend pick a team "no-repo" environment a service account may
// be refused ("You do not have permission to start this environment").
// Only the first send of a hosted admission is honored
// (hosted-delivery.js `runAdmission`, `pendingSend`):
// one launch per approved ticket is also one send per delivery. The agent
// id is learned from the session's `agent.bound` event
// (session-engine.js `buildTurnRequest` `onSdkAgentId`), which handle.ts turns into the recorded claim,
// the Implementing: comment and the move to In Progress.
//
// The send names no model. July 0.2.18 accepts `modelConfig` only on a
// dry-run send (session-engine.js `send` → model-config.js
// `modelConfigForDryRun`, which throws `InvalidModelConfigError:
// invalid argument: modelConfig requires dryRun` otherwise), and the
// throw lands in hosted execution, after admission already answered, so
// no session exists for `turn.failed` to fire on (docs/deployment-issues.md
// issue 27). A live turn runs agent.ts's `model` (session-engine.js
// `turnModel`, sdk-runner.js `toModelSelection` passes `{ id, params }`
// through), which is `IMPLEMENT_MODEL` (config.ts, read once at load): the
// same constant the heal's `Agent.create` sends.

/**
 * Set by Cursor-managed hosting on every pod, and the variable July itself
 * reads to decide it is on managed v2 hosting (dist/internal/v2-hosting.js).
 * channels/http.ts gates the HTTP session API on it.
 */
export const MANAGED_HOSTING_ENV = "AGENT_SERVE_GENERATION";

/** The slice of July's `send` the launch uses, so tests can pass a fake. */
export type StartTurn = (message: string, options: SendMessageOptions) => Promise<unknown>;

const CONTINUATION_PREFIX = "implement:";
const APPROVAL_SEPARATOR = "#";

/**
 * One session per approval, `implement:<KEY>#<changelogId>`. A second send
 * with the same token would resume the first session (session-engine.js
 * send:651-683 findByContinuation, which `Agent.resume`s its bound agent),
 * so the token names
 * the approval: a person's next move to Approved is a new changelog id and
 * a fresh agent, while a replay of one delivery meets its claim as in flight
 * (claim.ts) and never sends.
 */
export function implementContinuation(input: { issueKey: string; changelogId: string }): string {
  return `${CONTINUATION_PREFIX}${input.issueKey}${APPROVAL_SEPARATOR}${input.changelogId}`;
}

/** The issue key an implement session is pinned to, or undefined for any other session (a direct chat). */
export function implementIssueKey(continuationKey: string | null | undefined): string | undefined {
  if (typeof continuationKey !== "string") return undefined;
  // Hosted v2 stores continuation keys as `cont:<key>`; local serve and evals use the bare key.
  const bare = continuationKey.startsWith("cont:") ? continuationKey.slice("cont:".length) : continuationKey;
  if (!bare.startsWith(CONTINUATION_PREFIX)) return undefined;
  const pinned = bare.slice(CONTINUATION_PREFIX.length);
  const cut = pinned.indexOf(APPROVAL_SEPARATOR);
  const key = cut === -1 ? pinned : pinned.slice(0, cut);
  return JIRA_ISSUE_KEY.test(key) ? key : undefined;
}

/**
 * What the session carries for the `agent.bound` and `turn.failed` handlers
 * (handle.ts), which may run in another process than the delivery: the
 * approval, and the pending claim's `at` and `owner`, so the record is
 * written only while that claim is still the ticket's (claim.ts recordLaunch).
 * `takenOverAt` is the replaced claim's `at` when this launch took a lost
 * one over: the window in which that launch's agent may still bind, which
 * `bound` and `turnFailed` read (handle.ts `retireLateBound`, `lateBoundAgent`).
 */
export type ImplementSessionState = {
  kind: "implement";
  issueKey: string;
  changelogId: string;
  title: string;
  at: string;
  owner: string;
  retried: boolean;
  takenOverAt?: string;
};

/** The state back from July's channel context, or undefined for a session that is not an implement launch. */
export function parseImplementState(value: unknown): ImplementSessionState | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "implement") return undefined;
  const text = (field: string): string | undefined => (typeof record[field] === "string" && record[field] !== "" ? (record[field] as string) : undefined);
  const issueKey = text("issueKey");
  const changelogId = text("changelogId");
  const at = text("at");
  const owner = text("owner");
  if (issueKey === undefined || changelogId === undefined || at === undefined || owner === undefined) return undefined;
  const takenOverAt = text("takenOverAt");
  return { kind: "implement", issueKey, changelogId, title: text("title") ?? issueKey, at, owner, retried: record["retried"] === true, ...(takenOverAt === undefined ? {} : { takenOverAt }) };
}

export type ImplementTurnInput = {
  issueKey: string;
  changelogId: string;
  title: string;
  brief: string;
  repo: string;
  ref: string;
  state: ImplementSessionState;
};

/**
 * The options one implement send carries. Exported so the test can pin
 * their shape against July's types and run them through July's own send
 * validation (`modelConfigForDryRun`): no `modelConfig` on a live send.
 */
export function implementSendOptions(input: ImplementTurnInput): SendMessageOptions {
  return {
    continuationToken: implementContinuation(input),
    // July passes no agent name to the launch API (sdk-runner.js buildSharedOptions), so the session title carries it.
    title: agentName(input),
    state: input.state,
    cloud: {
      repos: [{ url: `https://github.com/${input.repo}`, startingRef: input.ref }],
      // The platform opens autoCreatePR PRs as drafts and Bugbot skips drafts,
      // so the worker opens a ready PR from the agent's branch (implement-pr.ts).
      autoCreatePR: false,
    },
  };
}

/**
 * Hand the implementation to July as one cloud turn. One
 * `factory.cloud_agent.launch` span per attempt, as the SDK launch has: the
 * ticket and `sent`, or the failure's reason code; the agent id is noted by
 * the `agent.bound` handler, which has it. Throws LaunchNotStartedError (the
 * caller releases its claim) for a staging refusal or a send July refused.
 */
export async function startImplementTurn(send: StartTurn, input: ImplementTurnInput): Promise<void> {
  return traceFactory({ span: "factory.cloud_agent.launch", kind: "cloud_agent.launch", ticketKey: input.issueKey }, async () => {
    // A staging slug never starts an implementing agent on the production repository (factory-stage.ts).
    if (refusesProductionTarget(process.env, { kind: "repos", value: input.repo })) {
      throw new LaunchNotStartedError({ message: stagingRefusal(input.repo), reason: "staging_refuses_production" });
    }
    try {
      await send(implementPrompt(input), implementSendOptions(input));
    } catch (error) {
      throw new LaunchNotStartedError({ message: error instanceof Error ? error.message : String(error), reason: launchFailureReason(error) });
    }
    noteFactory({ outcome: "sent" });
  });
}

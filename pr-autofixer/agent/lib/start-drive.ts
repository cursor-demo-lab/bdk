import type { HostContext } from "@cursor/july";
import type { SendMessageFn, SendMessageOptions } from "@cursor/july/channels";
import {
  cloudOptionsFor,
  continuationTokenFor,
  driveMessage,
  parsePrRef,
} from "./drive.js";
import { traceFactory, type FactoryNote } from "./factory-otel.js";
import { refusesProductionTarget, stagingRefusal } from "./factory-stage.js";
import { armMergeConflictWatch } from "./merge-watch.js";
import { lookupPrAgent } from "./affinity.js";
import type { RetryOptions } from "./kv-verified.js";
import { prContinuationToken } from "./pr-generation.js";
import { fetchPrState, isTerminalPrState } from "./pr-state.js";

export type StartDriveErrorCode = "missing_pr" | "unrecognized_pr" | "out_of_scope" | "staging_refuses_production";

export interface StartDriveError {
  ok: false;
  code: StartDriveErrorCode;
  error: string;
}

export interface StartDriveSuccess {
  ok: true;
  pr: string;
  sessionId: string | null;
  continuationToken: string | null;
  bcId: string | null;
  agentUrl: string | null;
  status: string;
  result: string | null;
  mergeConflictReminderId: string | null;
}

export type StartDriveResult = StartDriveError | StartDriveSuccess;

export interface StartDriveArgs {
  pr: string;
  hint?: string;
  /** The owner/repo list the factory drives. A pull request elsewhere is refused before any read. */
  repos: readonly string[];
  send: SendMessageFn;
  host: HostContext;
  /**
   * `send` is a GitHub delivery's own task send. On hosted v2 that channel
   * takes its continuation from the delivery mailbox and throws on a
   * `continuationToken`, and the returned handle is inert until the control
   * plane allocates the session.
   */
  deliverySend?: boolean;
  /**
   * The continuation generation read's kv retries. A caller that runs
   * startDrive inside a retry loop of its own passes `{ pausesMs: [] }`, so
   * only its loop pauses (K6).
   */
  kvRetry?: RetryOptions;
}

function agentUrlFor(bcId: string | null): string | null {
  return bcId === null ? null : `https://cursor.com/agents/${bcId}`;
}

/** A hosted-admission send returns a handle whose fields throw until the session exists. */
function readDeferred<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function inScope(pr: { owner: string; repo: string }, repos: readonly string[]): boolean {
  const wanted = `${pr.owner}/${pr.repo}`.toLowerCase();
  return repos.some((repo) => repo.toLowerCase() === wanted);
}

/** One `factory.cloud_agent.launch` span per drive start: the PR, the status or refusal code, and the agent id once known. */
export async function startDrive(args: StartDriveArgs): Promise<StartDriveResult> {
  return traceFactory({ span: "factory.cloud_agent.launch", kind: "cloud_agent.drive", describe: describeDrive }, () => startDriveOnce(args));
}

function describeDrive(result: StartDriveResult): FactoryNote {
  if (!result.ok) return { outcome: "refused", reason: result.code };
  return { outcome: result.status, pr: result.pr, ...(result.bcId === null ? {} : { agentId: result.bcId }) };
}

async function startDriveOnce(args: StartDriveArgs): Promise<StartDriveResult> {
  const prRaw = args.pr.trim();
  if (prRaw === "") {
    return {
      ok: false,
      code: "missing_pr",
      error: 'Body must include "pr": a GitHub PR URL or owner/repo#N.',
    };
  }
  const pr = parsePrRef(prRaw);
  if (pr === undefined) {
    return {
      ok: false,
      code: "unrecognized_pr",
      error: `Unrecognized PR reference: ${args.pr}`,
    };
  }
  // The cursorAccount subscription bounds what GitHub delivers, not what a
  // person pastes. Without this the drive would mount any repository the
  // signed-in host can reach.
  // Every drive (drive_pr, the drive route, a red check, a comment) starts
  // here, so a staging slug refuses the production repository here whatever
  // list its caller passed.
  if (refusesProductionTarget(process.env, { kind: "repos", value: `${pr.owner}/${pr.repo}` })) {
    return { ok: false, code: "staging_refuses_production", error: stagingRefusal(`${pr.owner}/${pr.repo}`) };
  }
  if (!inScope(pr, args.repos)) {
    return {
      ok: false,
      code: "out_of_scope",
      error: `${pr.owner}/${pr.repo} is not a repository this factory drives. Configured: ${args.repos.join(", ")}.`,
    };
  }

  const hint = args.hint?.trim() || undefined;
  const prState = await fetchPrState({ github: args.host.github, pr });

  if (isTerminalPrState(prState)) {
    return {
      ok: true,
      pr: pr.label,
      sessionId: null,
      continuationToken: null,
      bcId: null,
      agentUrl: null,
      status: "finished",
      result: `PR ${pr.label} is already ${prState.toLowerCase()}. Nothing to drive.`,
      mergeConflictReminderId: null,
    };
  }

  // A delivery's send takes no key, so only the drive channel's reads the generation.
  const continuationToken = args.deliverySend === true ? continuationTokenFor(pr) : await prContinuationToken(args.host.kv, { pr, ...(args.kvRetry === undefined ? {} : { retry: args.kvRetry }) });
  const boundAgent = await lookupPrAgent(pr, args.host.kv);
  const sendOptions: SendMessageOptions = {
    ...(args.deliverySend === true ? {} : { continuationToken }),
    title: `PR ${pr.label}`,
    cloud: cloudOptionsFor(pr),
    sdkAgentId: boundAgent,
  };

  const session = await args.send(driveMessage(pr, { hint }), sendOptions);

  // A delivery-started drive lives on the delivery's own session, not at
  // `drive` / continuationTokenFor, so a watch armed there could never reach it.
  let reminderId: string | null = null;
  if (args.deliverySend !== true && args.host.reminders !== undefined) {
    const reminder = await armMergeConflictWatch({
      reminders: args.host.reminders,
      pr,
      channelId: "drive",
      continuationToken,
    }).catch(() => undefined);
    if (reminder !== undefined) {
      reminderId = reminder.id;
    }
  }

  const sdkAgentId = readDeferred(() => session.info.sdkAgentId);
  const bcId = sdkAgentId?.startsWith("bc-") ? sdkAgentId : null;

  return {
    ok: true,
    pr: pr.label,
    sessionId: readDeferred(() => session.id) ?? null,
    continuationToken: args.deliverySend === true ? null : continuationToken,
    bcId,
    agentUrl: agentUrlFor(bcId),
    status: "started",
    result: null,
    mergeConflictReminderId: reminderId,
  };
}

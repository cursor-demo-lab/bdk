import type { HostContext, HostMcpRegistry, ReminderHostApi } from "@cursor/july";
import { Agent } from "@cursor/sdk";
import {
  armImplementPrWatch,
  fireImplementPrWatch,
  implementPrWatchKey,
  implementPrWatchLate,
  parseImplementPrWatch,
  pruneImplementPrIndex,
  readImplementPrIndex,
  sdkRunReader,
  type ArmResult,
  type ImplementPrDeps,
  type ImplementPrFire,
} from "./implement-pr.js";
import type { HandlerDeps } from "./handle.js";
import { IMPLEMENT_PR_SWEEP_KEY } from "./kv-keys.js";
import { sdkAgentStatus, sdkRetireAgent, type AgentStatus, type CreateAgent, type ListAgents, type RetireAgent } from "./launch.js";
import { tendLaunchWatches, type TendResult } from "./launch-heal.js";
import { readLaunchIndex } from "./launch-watch.js";

export { IMPLEMENT_PR_SWEEP_KEY };

// The backstop for the implement PR watch, the worker's counterpart of the
// desk's hop-watch `backstopSweep` (#176). The worker declares no schedule
// (on 0.2.13 hosted v2 fires only the ones the deploy manifest lists), so
// the sweep runs from inside deliveries the worker already
// handles: every verified Jira delivery, every GitHub `pull_request` task,
// and every implement PR reminder fire, at most once per
// IMPLEMENT_PR_SWEEP_EVERY_MS per deployment. It fires a watch whose
// reminder was never created, or is IMPLEMENT_PR_GRACE_MS late, and gives a
// still-pending one a new reminder; it re-arms one whose create failed
// before it is due. Each fire is ensureImplementPr, which GitHub keeps
// idempotent (an open PR is reused, a 422 reuses the raced one), so a late
// reminder and a sweep that both fire open one PR and make one move.

/** `createAgent` turns on the launch watch's heal (launch-heal.ts) in the same throttled sweep; `listAgents` is its positive check. */
export type SweepDeps = ImplementPrDeps & { reminders?: ReminderHostApi; createAgent?: CreateAgent; listAgents?: ListAgents; retireAgent?: RetireAgent };

export type SweepFire = { issueKey: string; outcome: ImplementPrFire["result"]["outcome"]; rearmed?: ArmResult };

/** A watch created without a reminder is left this long before the sweep arms one, so it never races the arm in flight. */
export const IMPLEMENT_PR_ARM_SETTLE_MS = 60_000;

export async function sweepImplementPrWatches(deps: SweepDeps): Promise<SweepFire[]> {
  const { kv } = deps;
  const index = await readImplementPrIndex(kv);
  const fires: SweepFire[] = [];
  const keep: string[] = [];
  for (const issueKey of index) {
    try {
      const key = implementPrWatchKey(issueKey);
      const watch = parseImplementPrWatch(await kv.get(key));
      if (watch === undefined) continue;
      const now = deps.now();
      if (!implementPrWatchLate(watch, now)) {
        keep.push(issueKey);
        if (watch.reminderId === undefined && deps.reminders !== undefined && now.getTime() - Date.parse(watch.armedAt) >= IMPLEMENT_PR_ARM_SETTLE_MS) {
          await armImplementPrWatch({ kv, reminders: deps.reminders, now: deps.now, env: deps.env }, { issueKey, ...(watch.title === undefined ? {} : { title: watch.title }) });
        }
        continue;
      }
      // Lost: forget its reminder, so a revived one is superseded and the re-arm below is not "already".
      if (watch.reminderId !== undefined) {
        await deps.reminders?.cancel(watch.reminderId, "lost").catch(() => undefined);
        const { reminderId: _lost, ...rest } = watch;
        await kv.put(key, rest);
      }
      const fired = await fireImplementPrWatch(deps, { issueKey, armedAt: watch.armedAt, ...(watch.title === undefined ? {} : { title: watch.title }) });
      const fire: SweepFire = { issueKey, outcome: fired.result.outcome };
      if (fired.rescheduleMs !== undefined) {
        keep.push(issueKey);
        if (deps.reminders !== undefined) fire.rearmed = await armImplementPrWatch({ kv, reminders: deps.reminders, now: deps.now, env: deps.env }, { issueKey, ...(watch.title === undefined ? {} : { title: watch.title }) });
      }
      fires.push(fire);
    } catch (error) {
      keep.push(issueKey);
      console.error(JSON.stringify({ worker: "implement_pr", via: "sweep", issueKey, outcome: "threw", message: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (keep.length !== index.length) {
    // Only keys whose record is verified gone are removed, from the list as
    // stored at the write (a verified re-filter, kv-index.ts), so a new key an
    // arm on any pod added before the write stays. A gone key re-armed before
    // the write (its add found it still listed) is put back by the prune's
    // record re-read; one whose add lands inside the write's last round trip
    // comes back with that arm's confirm or its next pending fire.
    const gone = new Set<string>();
    for (const key of index) {
      if (!keep.includes(key) && (await kv.get(implementPrWatchKey(key))) === undefined) gone.add(key);
    }
    if (gone.size > 0) await pruneImplementPrIndex(kv, { gone, env: deps.env });
  }
  return fires;
}

export const IMPLEMENT_PR_SWEEP_EVERY_MS = 5 * 60_000;
export const IMPLEMENT_PR_SWEEP_TIMEOUT_MS = 20_000;
export type BackstopResult = { swept: false; why: "idle" | "throttled" | "timeout" | "threw" } | { swept: true; fires: SweepFire[]; tended?: TendResult[] };

/**
 * The sweep, throttled by `implement-pr-watch/last-sweep`. The implement PR
 * sweep runs first, capped at `timeoutMs`. Then, with `createAgent`, the
 * launch watches are tended (`tendLaunchWatches`): a watch with no reminder,
 * or a lost one, gets a new reminder, and gone keys are pruned. No heal runs
 * here: a heal can take the 30 s launch deadline and the 60 s late wait, and
 * the delivery running the backstop is not the heal's owner. The heal runs
 * in the watch's own `implement_launch` reminder, once per fire. So the
 * backstop adds at most `timeoutMs` plus LAUNCH_ARMS_PER_TEND reminder
 * creates (5 s cap each) to any delivery. Hosted kv has no compare-and-set,
 * so two pods can both sweep in one window; that costs a second read of
 * GitHub, not a second PR. Never throws.
 */
export async function backstopImplementPrSweep(
  deps: SweepDeps,
  options: { everyMs?: number; timeoutMs?: number; sweep?: (deps: SweepDeps) => Promise<SweepFire[]>; tend?: (deps: HandlerDeps) => Promise<TendResult[]> } = {}
): Promise<BackstopResult> {
  const { createAgent } = deps;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? IMPLEMENT_PR_SWEEP_TIMEOUT_MS);
  });
  let launches = 0;
  const run = (async (): Promise<BackstopResult> => {
    const watched = (await readImplementPrIndex(deps.kv)).length > 0;
    launches = createAgent === undefined ? 0 : (await readLaunchIndex(deps.kv)).length;
    if (!watched && launches === 0) return { swept: false, why: "idle" };
    const now = deps.now();
    const last = await deps.kv.get(IMPLEMENT_PR_SWEEP_KEY);
    const lastAt = last !== null && typeof last === "object" && !Array.isArray(last) ? Date.parse(String((last as Record<string, unknown>)["at"])) : NaN;
    if (Number.isFinite(lastAt) && now.getTime() - lastAt < (options.everyMs ?? IMPLEMENT_PR_SWEEP_EVERY_MS)) return { swept: false, why: "throttled" };
    await deps.kv.put(IMPLEMENT_PR_SWEEP_KEY, { at: now.toISOString() });
    return { swept: true, fires: watched ? await (options.sweep ?? sweepImplementPrWatches)(deps) : [] };
  })().catch((error: unknown): BackstopResult => {
    console.error(JSON.stringify({ worker: "implement_pr", via: "backstop", swept: false, why: "threw", message: error instanceof Error ? error.message : String(error) }));
    return { swept: false, why: "threw" };
  });
  const raced = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
  if (raced === "timeout") {
    console.error(JSON.stringify({ worker: "implement_pr", via: "backstop", swept: false, why: "timeout" }));
    return { swept: false, why: "timeout" };
  }
  if (raced.swept && raced.fires.length > 0) console.log(JSON.stringify({ worker: "implement_pr", via: "backstop", fires: raced.fires }));
  if (!raced.swept || createAgent === undefined || launches === 0) return raced;
  const tended = await (options.tend ?? tendLaunchWatches)({ ...deps, createAgent }).catch((error: unknown): TendResult[] => {
    console.error(JSON.stringify({ worker: "launch_watch", via: "backstop", why: "threw", message: error instanceof Error ? error.message : String(error) }));
    return [];
  });
  if (tended.length > 0) console.log(JSON.stringify({ worker: "launch_watch", via: "backstop", tended }));
  return { ...raced, tended };
}

/**
 * A `pull_request` task that also runs the backstop once its own work is
 * done, whether that work threw or not; a skipped delivery stays skipped.
 */
export function withImplementPrBackstop(dispatch: { task: () => Promise<void> } | null, backstop: () => Promise<unknown>): { task: () => Promise<void> } | null {
  if (dispatch === null) return null;
  return {
    task: async () => {
      try {
        await dispatch.task();
      } finally {
        await backstop();
      }
    },
  };
}

/** The deps a hosted delivery or reminder fire wires: host kv, GitHub, and reminders, `Agent.listRuns`, `Agent.create`, `Agent.list`, `Agent.get`, and process.env. */
export function hostImplementPrDeps(input: { host: Pick<HostContext, "kv" | "github" | "reminders">; mcp: HostMcpRegistry }): SweepDeps & { createAgent: CreateAgent; listAgents: ListAgents; retireAgent: RetireAgent; agentStatus: AgentStatus } {
  return {
    kv: input.host.kv,
    mcp: input.mcp,
    env: process.env,
    now: () => new Date(),
    github: input.host.github,
    readRun: sdkRunReader((agentId, options) => Agent.listRuns(agentId, options)),
    createAgent: (options) => Agent.create(options),
    listAgents: (options) => Agent.list(options),
    agentStatus: sdkAgentStatus((agentId) => Agent.get(agentId)),
    retireAgent: sdkRetireAgent({
      listRuns: (agentId, options) => Agent.listRuns(agentId, options),
      cancelRun: (runId, options) => Agent.cancelRun(runId, options),
      archive: (agentId) => Agent.archive(agentId),
    }),
    ...(input.host.reminders === undefined ? {} : { reminders: input.host.reminders }),
  };
}

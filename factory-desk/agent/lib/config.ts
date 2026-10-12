// Scope read from the environment. Jira project lists are required only
// when a tool runs, so an empty list is returned and the tool turns it into
// a refusal. The repository list only scopes the read-only GitHub channel
// that hears review results; the desk never writes to GitHub.

import { envList } from "./factory-env.js";
import { refusesProductionTarget } from "./factory-stage.js";

export { factoryFallbacks, factoryModel, HOST_MODEL_PARAMS, LIGHT_MODEL, REGISTRY_MODELS } from "./factory-model.js";
export { jiraProjects } from "./factory-env.js";

// Looser than the strict factoryRepos rule the other agents share: this list
// only scopes a read-only channel, so a bad entry is dropped, never thrown.
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/**
 * The repositories whose pull requests the desk reports review results for,
 * from the shared `FACTORY_REPOS`. Unset or malformed entries are dropped,
 * never thrown: a hosted freeze boots before its secrets exist. A staging
 * slug drops the production repository too (factory-stage.ts).
 */
export function reviewRepos(env: NodeJS.ProcessEnv): string[] {
  const repos: string[] = [];
  const seen = new Set<string>();
  for (const part of envList(env, { shared: "FACTORY_REPOS" })) {
    if (!REPO.test(part) || seen.has(part.toLowerCase())) continue;
    if (refusesProductionTarget(env, { kind: "repos", value: part })) continue;
    seen.add(part.toLowerCase());
    repos.push(part);
  }
  return repos;
}

export type StatusNames = { todo: string; triaged: string; planned: string; approved: string; inProgress: string; inReview: string; done: string };

export function statusNames(env: NodeJS.ProcessEnv): StatusNames {
  return {
    todo: env.FACTORY_STATUS_TODO || "To Do",
    triaged: env.FACTORY_STATUS_TRIAGED || "Triaged",
    planned: env.FACTORY_STATUS_PLANNED || "Planned",
    approved: env.FACTORY_STATUS_APPROVED || "Approved",
    inProgress: env.FACTORY_STATUS_IN_PROGRESS || "In Progress",
    inReview: env.FACTORY_STATUS_IN_REVIEW || "In Review",
    done: env.FACTORY_STATUS_DONE || "Done",
  };
}

export type DeskSelfIdentity = { userId: string; name?: string };

let selfIdentity: DeskSelfIdentity | undefined;

/** The bot's own Slack identity, once `self-identity.ts` has read it from `auth.test`. */
export function deskSelfIdentity(): DeskSelfIdentity | undefined {
  return selfIdentity;
}

export function setDeskSelfIdentity(identity: DeskSelfIdentity | undefined): void {
  selfIdentity = identity;
}

// `auth.test` names the bot's username, not its profile name (which July's
// own `self_name` uses since 0.2.12), and `factory-desk` is the directory
// name every copy rule forbids.
const SLACK_USERNAME = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function usableSelfName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (trimmed === undefined || !SLACK_USERNAME.test(trimmed) || trimmed.toLowerCase() === "factory-desk") return undefined;
  return trimmed;
}

/**
 * Slack mention users type: `FACTORY_DESK_SLACK_HANDLE` when set, else the
 * bot's own `auth.test` username once it is known and usable, else
 * `@factory` (the live bot). Copy built before the first `auth.test`
 * answer uses the fallback.
 */
export function deskSlackHandle(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.FACTORY_DESK_SLACK_HANDLE?.trim() || usableSelfName(selfIdentity?.name) || "factory";
  return raw.startsWith("@") ? raw : `@${raw}`;
}

export const CLAIM_SETTLE_MS = 2_000;
const CLAIM_SETTLE_MAX_MS = 10_000;

/**
 * How long a Triaged, Needs info, or thread-detail claim waits before it
 * re-reads itself (claim-lease.ts `settleMs`): longer than one hosted kv put
 * takes to land. `FACTORY_DESK_CLAIM_SETTLE_MS` overrides it (0 turns the
 * wait off); anything unparseable or above ten seconds keeps the default.
 */
export function claimSettleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FACTORY_DESK_CLAIM_SETTLE_MS?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return CLAIM_SETTLE_MS;
  const ms = Number(raw);
  return ms <= CLAIM_SETTLE_MAX_MS ? ms : CLAIM_SETTLE_MS;
}

/**
 * Whether a review re-check loop takes its head as an owner lease
 * (review-announce.ts `takeRecheck`). `FACTORY_DESK_RECHECK_LEASE=off` puts
 * back the plain read-then-put `{ until }` it replaced; read per request.
 */
export function recheckLeaseOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FACTORY_DESK_RECHECK_LEASE?.trim().toLowerCase() !== "off";
}

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { SendMessageOptions } from "@cursor/july/channels";
import { FactoryConfigError, sandboxRef, sandboxRepo } from "./config.js";

export const CHECKOUT_ENV = "FACTORY_PLANNER_CHECKOUT";

/**
 * Set by Cursor-managed hosting on every pod, and the variable July itself
 * reads to decide it is on managed v2 hosting before it builds the engine
 * (dist/internal/v2-hosting.js:17-35, read from
 * framework-storage-selection.js:50-53), so it is present when agent.ts loads.
 */
export const MANAGED_HOSTING_ENV = "AGENT_SERVE_GENERATION";

/** The variable's trimmed value, or `undefined` when unset or blank. */
function checkoutSetting(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env[CHECKOUT_ENV] ?? "").trim();
  return raw === "" ? undefined : raw;
}

/**
 * Where the planner reads code from, off managed hosting. `local.workspaceDir`
 * points every session at this directory, so the read tools see a real
 * checkout of the sandbox. Unset, blank, or not a directory: `undefined`, and
 * each session gets an empty workspace; `search_sandbox` then reads the
 * GitHub tree for FACTORY_SANDBOX_REPO through `ctx.host.github`. A miss or
 * an unread tree is `record_needs_info`, not a prompt-only plan.
 */
export function plannerCheckout(env: NodeJS.ProcessEnv): string | undefined {
  const raw = checkoutSetting(env);
  if (raw === undefined) return undefined;
  const path = resolve(raw);
  if (!existsSync(path)) return undefined;
  try {
    return statSync(path).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when this process runs every turn on a Cursor cloud agent: on managed
 * hosting. The managed-hosting signal alone decides, so the boot-time read in
 * agent.ts (before hosted v2 binds any secret) and the send-time read here
 * cannot disagree. July has no per-send tool allowlist: it reads `tools` off
 * the agent and refuses any non-local turn of an agent that declares one
 * (dist/internal/session-engine.js:2090-2092, discovery/agent.js:166-172).
 * So the agent is either local with the read-only allowlist enforced on
 * every turn, or `runtime: "cloud"` with none, and never a mix in which a
 * local turn runs without the allowlist. The value is trimmed before the
 * empty check, the same test July's relay applies to this variable
 * (dist/internal/cursor-relay-core.js:89-91), so a blank or whitespace-only
 * value is "not hosted" to both.
 */
export function cloudPlanning(env: NodeJS.ProcessEnv): boolean {
  return (env[MANAGED_HOSTING_ENV] ?? "").trim() !== "";
}

/**
 * Send options for a planning session. Under cloudPlanning, a per-session
 * `cloud` attach that clones FACTORY_SANDBOX_REPO@FACTORY_SANDBOX_REF (the
 * same `cloud.repos` the worker's launch passes to `@cursor/sdk`); an unset
 * or staging-refused sandbox throws sandboxRepo's named error, so the send
 * fails instead of planning on an empty VM. FACTORY_PLANNER_CHECKOUT is
 * forbidden on managed hosting: a cloud turn runs on its own VM and can never
 * read a directory on the planner host, so a set value is a misconfiguration
 * and throws the same named error rather than sending a cloud turn whose
 * operator expected a local checkout. Otherwise nothing: the turn stays local
 * under the read-only allowlist. Read at send time, never at boot: hosted v2
 * binds FACTORY_SANDBOX_* per request.
 */
export function planSessionCloud(env: NodeJS.ProcessEnv): Pick<SendMessageOptions, "cloud"> {
  if (!cloudPlanning(env)) return {};
  const checkout = checkoutSetting(env);
  if (checkout !== undefined) {
    throw new FactoryConfigError(
      `Unset ${CHECKOUT_ENV} on managed hosting. Hosted planning turns run on a Cursor cloud agent with a clone of FACTORY_SANDBOX_REPO, which cannot read "${checkout}" on the planner host.`
    );
  }
  return { cloud: { repos: [{ url: `https://github.com/${sandboxRepo(env)}`, startingRef: sandboxRef(env) }] } };
}

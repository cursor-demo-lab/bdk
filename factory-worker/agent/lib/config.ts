// Scope read from the environment. Repository lists are required when a
// module that serves GitHub loads, so an empty list throws and names the
// variable. Jira project lists are required only when a tool runs, so an
// empty list is returned and the tool turns it into a refusal.

export { factoryFallbacks, factoryModel, HOST_MODEL_PARAMS, REGISTRY_MODELS } from "./factory-model.js";
export { jiraProjects } from "./factory-env.js";
export { FactoryConfigError, factoryRepos } from "./factory-repos.js";
export { sandboxRef, sandboxRepo, sandboxReposAtBoot } from "./factory-sandbox.js";
export { claimMode, claimSettleMs } from "./verified-claim.js";

export type ModelChoice = { id: string; params: { id: string; value: string }[] };

/**
 * The cloud agent that implements an approved ticket. The launch API matches
 * id plus params against one catalog variant, so every parameter is spelled
 * out; a partial set can be refused as `invalid_model`.
 */
export function workerModel(env: NodeJS.ProcessEnv): ModelChoice {
  return {
    id: env.FACTORY_WORKER_MODEL?.trim() || "claude-opus-5-5",
    params: [
      { id: "context", value: env.FACTORY_WORKER_CONTEXT?.trim().toLowerCase() || "300k" },
      { id: "effort", value: env.FACTORY_WORKER_EFFORT?.trim().toLowerCase() || "high" },
      { id: "fast", value: env.FACTORY_WORKER_FAST?.trim().toLowerCase() || "false" },
    ],
  };
}

/**
 * The implement model, read once when this module loads. July resolves
 * `agent.ts` `model` at discovery, and the live cloud turn runs that (a live
 * send may not carry `modelConfig`; docs/deployment-issues.md issue 27), so
 * the heal's `Agent.create` (handle.ts `approve`) uses this same constant
 * rather than re-reading the environment per request. On hosted v2 the
 * deployment secrets reach `process.env` only per request, after this
 * module has loaded, so FACTORY_WORKER_* are not hosted secrets: they apply
 * where the process starts with them set (local `serve`, evals), and the
 * hosted worker always runs the default variant.
 */
export const IMPLEMENT_MODEL: ModelChoice = workerModel(process.env);

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

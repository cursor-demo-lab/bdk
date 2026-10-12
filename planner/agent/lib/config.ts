// Scope read from the environment. Repository lists are required when a
// module that serves GitHub loads, so an empty list throws and names the
// variable. Jira project lists are required only when a tool runs, so an
// empty list is returned and the tool turns it into a refusal.

export { factoryFallbacks, factoryModel, HOST_MODEL_PARAMS, REGISTRY_MODELS } from "./factory-model.js";
export { jiraProjects } from "./factory-env.js";
export { FactoryConfigError, factoryRepos } from "./factory-repos.js";
export { sandboxRef, sandboxRepo, sandboxReposAtBoot } from "./factory-sandbox.js";
export { claimMode, claimSettleMs } from "./verified-claim.js";

export type StatusNames = { triaged: string; planned: string };

// Jira workflow status names are per project, so they are configuration.
export function statusNames(env: NodeJS.ProcessEnv): StatusNames {
  return {
    triaged: env.FACTORY_STATUS_TRIAGED || "Triaged",
    planned: env.FACTORY_STATUS_PLANNED || "Planned",
  };
}

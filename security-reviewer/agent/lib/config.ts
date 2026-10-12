// Scope read from the environment. Repository lists are required when a
// module that serves GitHub loads, so an empty list throws and names the
// variable. Jira project lists are required only when a tool runs, so an
// empty list is returned and the tool turns it into a refusal.

export { factoryFallbacks, factoryModel, HOST_MODEL_PARAMS, REGISTRY_MODELS } from "./factory-model.js";
export { jiraProjects } from "./factory-env.js";
export { FactoryConfigError, factoryRepos } from "./factory-repos.js";

export { factoryFallbacks, factoryModel, HOST_MODEL_PARAMS, LIGHT_MODEL, REGISTRY_MODELS } from "./factory-model.js";

export type StatusNames = { todo: string; triaged: string; planned: string; approved: string; inProgress: string; inReview: string; done: string };

// Jira workflow status names are per project, so they are configuration.
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

/** The statuses a ticket reaches only after triage: one in any of them was triaged already. */
export function pastTodoStatuses(env: NodeJS.ProcessEnv): string[] {
  const { triaged, planned, approved, inProgress, inReview, done } = statusNames(env);
  return [triaged, planned, approved, inProgress, inReview, done];
}

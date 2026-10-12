// Comma-separated lists read from the shared factory environment, and the
// Jira project list every agent that reads FACTORY_JIRA_PROJECTS builds from
// one. A per-agent override replaces the shared list whenever it is set,
// even to empty. Lists never throw: each caller decides what empty means.
//
// Shared verbatim by the agents that read FACTORY_JIRA_PROJECTS and
// re-exported from each config.ts (scripts/copies-parity.test.mjs);
// scripts/factory-config-parity.test.mjs holds every copy to one behaviour.

import { factoryStage, refusesProductionTarget } from "./factory-stage.js";

// Jira project keys are 1 to 10 characters and start with a letter.
const JIRA_KEY = /^[A-Z][A-Z0-9]{0,9}$/;

/** Trimmed, non-empty entries of `override` when that variable is set, else of `shared`. */
export function envList(env: NodeJS.ProcessEnv, names: { shared: string; override?: string | undefined }): string[] {
  const { shared, override } = names;
  const raw = override !== undefined && env[override] !== undefined ? env[override] ?? "" : env[shared] ?? "";
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Upper-cased, de-duplicated Jira project keys; entries that are not a key
 * are dropped, and so is a production project on a staging slug
 * (factory-stage.ts).
 */
export function jiraProjects(env: NodeJS.ProcessEnv, override?: string): string[] {
  const projects: string[] = [];
  const seen = new Set<string>();
  for (const part of envList(env, { shared: "FACTORY_JIRA_PROJECTS", override })) {
    const key = part.toUpperCase();
    if (!JIRA_KEY.test(key) || seen.has(key)) continue;
    if (refusesProductionTarget(env, { kind: "jiraProjects", value: key })) continue;
    seen.add(key);
    projects.push(key);
  }
  return projects;
}

/**
 * Whether `project` is one this slug acts on. An empty list means every
 * project on production. On staging it means none: there it is usually a
 * list emptied by refusing the production project, which must not turn into
 * "allow all" (factory-stage.ts).
 */
export function inProjectScope(env: NodeJS.ProcessEnv, scope: { projects: readonly string[]; project: string }): boolean {
  const staging = factoryStage(env) === "staging";
  if (scope.projects.length === 0) return !staging;
  // Production compares exactly as before this file existed: upper-cased,
  // untrimmed, so a padded project.key is still not allowed there.
  const project = scope.project.toUpperCase();
  return scope.projects.includes(staging ? project.trim() : project);
}

/**
 * inProjectScope for a delivered issue. Production checks `project` alone, as
 * before. Staging also checks the issue key's own prefix, so a body whose
 * project.key names a staging project cannot carry a production key.
 */
export function issueInProjectScope(env: NodeJS.ProcessEnv, issue: { projects: readonly string[]; project: string; issueKey: string }): boolean {
  if (!inProjectScope(env, { projects: issue.projects, project: issue.project })) return false;
  if (factoryStage(env) === "production") return true;
  const dash = issue.issueKey.lastIndexOf("-");
  return inProjectScope(env, { projects: issue.projects, project: dash <= 0 ? issue.issueKey : issue.issueKey.slice(0, dash) });
}

// The strict repository list from FACTORY_REPOS (or a per-agent override).
// Unlike a Jira project list it throws, naming the variables, when it is
// empty or holds anything that is not an owner/repo: a caller that needs
// repositories cannot act on a partial list. Boot-time readers catch
// FactoryConfigError so a hosted freeze with no secrets yet still loads.
//
// Shared verbatim by the agents that read FACTORY_REPOS strictly and
// re-exported from each config.ts (scripts/copies-parity.test.mjs);
// scripts/factory-config-parity.test.mjs holds every copy to one behaviour.

import { envList } from "./factory-env.js";
import { refusesProductionTarget, stagingRefusal } from "./factory-stage.js";

export class FactoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryConfigError";
  }
}

// Each side starts and ends with a letter or digit, with one slash between
// them, so a typo cannot pass as a repository.
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isOwnerRepo(value: string): boolean {
  return REPO.test(value);
}

function unsetReposMessage(override: string | undefined): string {
  const names = override === undefined ? "FACTORY_REPOS" : `${override} or FACTORY_REPOS`;
  return `Set ${names} to a comma-separated owner/repo list.`;
}

/**
 * A production repository on a staging slug (factory-stage.ts) is left out;
 * a list left empty by that throws the staging refusal, not the unset one.
 */
export function factoryRepos(env: NodeJS.ProcessEnv, override?: string): readonly string[] {
  const repos: string[] = [];
  const seen = new Set<string>();
  let refused: string | undefined;
  for (const repo of envList(env, { shared: "FACTORY_REPOS", override })) {
    if (!isOwnerRepo(repo)) {
      throw new FactoryConfigError(`${unsetReposMessage(override)} "${repo}" is not an owner/repo.`);
    }
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (refusesProductionTarget(env, { kind: "repos", value: repo })) {
      refused ??= repo;
      continue;
    }
    repos.push(repo);
  }
  if (repos.length === 0) {
    throw new FactoryConfigError(refused === undefined ? unsetReposMessage(override) : `${unsetReposMessage(override)} ${stagingRefusal(refused)}`);
  }
  return repos;
}

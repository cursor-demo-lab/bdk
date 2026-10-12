import { FactoryConfigError, factoryRepos } from "./config.js";

const OVERRIDE = "PR_AUTOFIXER_REPOS";

export function githubRepos(): readonly string[] {
  return factoryRepos(process.env, OVERRIDE);
}

/** The list as it stands now, or an empty list when neither variable is set. */
export function githubReposIfSet(): readonly string[] {
  try {
    return githubRepos();
  } catch (error) {
    if (error instanceof FactoryConfigError) return [];
    throw error;
  }
}

// The GitHub channel used to call githubRepos() while this module loaded
// so a missing scope failed the process. A hosted freeze has no secrets
// until the installation is READY, so import must not throw. The channel
// still reads the list at boot through githubReposAtBoot, for the
// cursorAccount declaration only; every per-delivery decision reads the
// list again (githubRepos / githubReposIfSet), because the boot list is
// empty on a freeze that started before its secrets existed.
export function githubReposAtBoot(): readonly string[] {
  return githubReposIfSet();
}

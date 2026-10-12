import { FactoryConfigError, factoryRepos } from "./config.js";

const OVERRIDE = "SECURITY_REVIEWER_REPOS";

export function githubRepos(): readonly string[] {
  return factoryRepos(process.env, OVERRIDE);
}

export function watches(fullName: string): boolean {
  return githubRepos().some((repo) => repo.toLowerCase() === fullName.toLowerCase());
}

// The GitHub channel used to call githubRepos() while this module loaded
// so a missing scope failed the process. A hosted freeze has no secrets
// until the installation is READY, so import must not throw. The channel
// still reads the list at boot through githubReposAtBoot; a turn that
// needs a list still calls githubRepos() and gets the named error.
export function githubReposAtBoot(): readonly string[] {
  try {
    return githubRepos();
  } catch (error) {
    if (error instanceof FactoryConfigError) return [];
    throw error;
  }
}

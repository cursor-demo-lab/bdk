// The one sandbox repository and ref an agent reads or launches in, from
// FACTORY_SANDBOX_REPO and FACTORY_SANDBOX_REF. An unset repository falls
// back to the first FACTORY_REPOS entry; an unset ref is main.
//
// Shared verbatim by the agents that read FACTORY_SANDBOX_* and re-exported
// from each config.ts (scripts/copies-parity.test.mjs);
// scripts/factory-config-parity.test.mjs holds every copy to one behaviour.

import { FactoryConfigError, factoryRepos, isOwnerRepo } from "./factory-repos.js";
import { refusesProductionTarget, stagingRefusal } from "./factory-stage.js";

export function sandboxRepo(env: NodeJS.ProcessEnv): string {
  const explicit = env.FACTORY_SANDBOX_REPO?.trim() ?? "";
  if (explicit !== "") {
    if (!isOwnerRepo(explicit)) {
      throw new FactoryConfigError(`Set FACTORY_SANDBOX_REPO to one owner/repo. "${explicit}" is not an owner/repo.`);
    }
    if (refusesProductionTarget(env, { kind: "repos", value: explicit })) {
      throw new FactoryConfigError(`Set FACTORY_SANDBOX_REPO to the staging sandbox. ${stagingRefusal(explicit)}`);
    }
    return explicit;
  }
  if ((env.FACTORY_REPOS?.trim() ?? "") === "") {
    throw new FactoryConfigError("Set FACTORY_SANDBOX_REPO to one owner/repo, or FACTORY_REPOS to a comma-separated owner/repo list.");
  }
  return factoryRepos(env)[0]!;
}

export function sandboxRef(env: NodeJS.ProcessEnv): string {
  const ref = env.FACTORY_SANDBOX_REF?.trim() ?? "";
  return ref === "" ? "main" : ref;
}

/**
 * The sandbox as the GitHub channel's repository list, read once when the
 * module loads. Unset is an empty list, not a throw, so a first boot before
 * secrets attach still reaches READY. A turn that needs the repo still calls
 * sandboxRepo() and gets the named error.
 */
export function sandboxReposAtBoot(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  try {
    return [sandboxRepo(env)];
  } catch (error) {
    if (error instanceof FactoryConfigError) return [];
    throw error;
  }
}

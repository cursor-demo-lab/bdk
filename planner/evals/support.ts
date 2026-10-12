// Shared by evals.config.ts and the eval files. Not an eval: discovery only
// runs `*.eval.ts` and `evals.config.ts`.

// Non-secret settings the planner's tools read at call time. Without a repo,
// search_sandbox, record_plan, and record_needs_info throw "Set
// FACTORY_SANDBOX_REPO ... or FACTORY_REPOS" and three of four cases fail
// before the model decides anything. Values match the factory's root
// .env.example. A non-empty value already in the environment wins.
export const EVAL_ENV = {
  FACTORY_REPOS: "cursor-demo-lab/marsbank",
  FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank",
  FACTORY_SANDBOX_REF: "main",
  FACTORY_JIRA_PROJECTS: "TLSSN",
} as const;

export function applyEvalEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(EVAL_ENV)) {
    if ((env[name]?.trim() ?? "") === "") env[name] = value;
  }
}

type SandboxResult = { available?: unknown; source?: unknown; paths?: unknown; matches?: unknown };

function sandboxResult(value: unknown): SandboxResult | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  return parsed !== null && typeof parsed === "object" ? (parsed as SandboxResult) : undefined;
}

function resultPaths(result: SandboxResult): string[] {
  const paths = Array.isArray(result.paths) ? result.paths : [];
  const matches = Array.isArray(result.matches) ? result.matches.map((match) => (match as { path?: unknown })?.path) : [];
  return [...paths, ...matches].filter((path): path is string => typeof path === "string");
}

/** A search_sandbox result that could not read any tree (GitHub 401/403/404, no token, a failed fetch). */
export function sandboxUnavailable(value: unknown): boolean {
  return sandboxResult(value)?.available === false;
}

/**
 * A search_sandbox result that read the seeded session workspace and found no
 * path matching `absent`: evidence the planner checked the tree, as opposed
 * to a GitHub read that failed and reported nothing.
 */
export function searchedWorkspaceWithout(absent: RegExp): (value: unknown) => boolean {
  return (value) => {
    const result = sandboxResult(value);
    if (result === undefined || result.available !== true || result.source !== "workspace") return false;
    return !resultPaths(result).some((path) => absent.test(path));
  };
}

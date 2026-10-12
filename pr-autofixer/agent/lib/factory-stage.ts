// Which stage a slug runs as, from FACTORY_ENV, and the production targets a
// staging slug refuses. Hosted KV is reached only with the slug's own pod
// credential, from which the API resolves the deployment, so a
// `<slug>-staging` deployment should not read production state (enforced
// server-side). This keeps it from acting on the production Slack intake,
// Jira project, or sandbox repository when a secret is copied across by
// mistake. It is read per request: hosted secrets reach process.env only then. A production target is acted on in staging
// only when FACTORY_STAGING_ALLOW_PRODUCTION names it.
//
// Unset, `production`, or `prod` is production, the stage every live slug
// runs today. Any other value is staging, so a typo fails closed.
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs).
// scripts/doctor-checks.mjs keeps its own copy of PRODUCTION_TARGETS;
// scripts/doctor.test.mjs holds the two to the same lists.

export type FactoryStage = "production" | "staging";

export const PRODUCTION_TARGETS = {
  repos: ["cursor-demo-lab/marsbank"],
  jiraProjects: ["TLSSN"],
  slackChannels: ["C0EXAMPLE1", "#mars-eng-intake"],
  // The production desk's Slack app (docs/deployment-issues.md, issue 13). A
  // staging desk holding a copy of its bot token acts as that app.
  slackApps: ["A0EXAMPLE1"],
} as const;

export type ProductionTargetKind = keyof typeof PRODUCTION_TARGETS;

export type ProductionTarget = { kind: ProductionTargetKind; value: string };

export function factoryStage(env: NodeJS.ProcessEnv): FactoryStage {
  const raw = env.FACTORY_ENV?.trim().toLowerCase() ?? "";
  return raw === "" || raw === "production" || raw === "prod" ? "production" : "staging";
}

/** Case, surrounding space, and a channel name's leading `#` never make two targets differ. */
function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/^#/, "");
}

function stagingAllowList(env: NodeJS.ProcessEnv): string[] {
  return (env.FACTORY_STAGING_ALLOW_PRODUCTION ?? "")
    .split(",")
    .map(normalized)
    .filter((part) => part !== "");
}

/** True when this slug is staging and `target` is a production target it was not told to allow. */
export function refusesProductionTarget(env: NodeJS.ProcessEnv, target: ProductionTarget): boolean {
  if (factoryStage(env) !== "staging") return false;
  const value = normalized(target.value);
  const production = (PRODUCTION_TARGETS[target.kind] as readonly string[]).some((entry) => normalized(entry) === value);
  return production && !stagingAllowList(env).includes(value);
}

/** `values` without the production targets this slug refuses; unchanged on production. */
export function withoutProductionTargets(env: NodeJS.ProcessEnv, targets: { kind: ProductionTargetKind; values: readonly string[] }): string[] {
  return targets.values.filter((value) => !refusesProductionTarget(env, { kind: targets.kind, value }));
}

/** The line a refusing reader puts in its error or log, naming the switch that would allow `value`. */
export function stagingRefusal(value: string): string {
  return `FACTORY_ENV is staging, so production target ${value} is refused; name it in FACTORY_STAGING_ALLOW_PRODUCTION to use it anyway.`;
}

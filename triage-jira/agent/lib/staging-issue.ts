import { inProjectScope, jiraProjects } from "./factory-env.js";
import { factoryStage } from "./factory-stage.js";
import { isIssueId } from "./parse-queue-event.js";

// On production triage-jira reads no project list: it triages whatever its
// own signed rule delivers, exactly as before. On a staging slug it acts
// only on a full Jira key (`TLSTG-12`, as isIssueId reads it: no numeric id,
// no lowercase, no padding) whose project is in FACTORY_JIRA_PROJECTS, like
// the other hosts. An empty list refuses every key (factory-env.ts
// inProjectScope), and FACTORY_STAGING_ALLOW_PRODUCTION still gates TLSSN.

/** The project part of `TLSSN-45` (`TLSSN`), upper-cased. */
export function issueProject(identifier: string): string {
  const dash = identifier.lastIndexOf("-");
  return (dash <= 0 ? identifier : identifier.slice(0, dash)).trim().toUpperCase();
}

/** The reason a staging refusal reports, in every result shape triage returns. */
export const STAGING_REFUSED = "staging_refuses_production";

/**
 * Why this staging slug must not read or write `identifier`, or undefined
 * when it may. Every tracker read and write, the planner handoff, and
 * record_triage check it before any connector call, whatever the key's source
 * (the delivered issue, the session, or the model's input).
 */
export function stagingRefusalFor(identifier: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!stagingRefusesIssue(env, identifier)) return undefined;
  return `${STAGING_REFUSED}: FACTORY_ENV is staging and ${JSON.stringify(identifier)} is not a key in this slug's Jira projects (${jiraProjects(env).join(", ") || "none"}), so it was not read or written.`;
}

/** True when this staging slug refuses the identifier (see above); logs the refusal once. Always false on production. */
export function stagingRefusesIssue(env: NodeJS.ProcessEnv, identifier: string): boolean {
  if (factoryStage(env) === "production") return false;
  if (isIssueId(identifier) && inProjectScope(env, { projects: jiraProjects(env), project: issueProject(identifier) })) return false;
  console.log(JSON.stringify({ triage: "staging_refused", identifier }));
  return true;
}

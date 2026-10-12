/**
 * @typedef {object} Facts
 * @property {Record<string, string | undefined>} env
 * @property {{ version: string, isBun: boolean }} node
 * @property {{ version: string, sandboxRepo: string }} factory
 * @property {Record<string, { installedJulyVersion: string | undefined }>} projects
 * @property {{ configured: string | undefined, exists: boolean, isGitRepo: boolean, originUrl: string | undefined }} checkout
 * @property {string[]} trackedEnvFiles
 * @property {{
 *   whoami: { ran: boolean, signedIn: boolean, detail: string },
 *   slackDoctor: { ran: boolean, ok: boolean, detail: string },
 *   validate: { ran: boolean, ok: boolean, detail: string },
 *   githubApp: GithubAppProbe
 * }} cli
 */

/**
 * @typedef {object} GithubAppProbe
 * @property {boolean} ran
 * @property {{ owner: string, status: "installed" | "missing" | "unknown", reason?: string }[]} owners
 */

/** @typedef {(command: string, args: string[]) => string} Exec */

// Copied from factory-desk/agent/lib/config.ts. Keep the two in lockstep.
const REPO =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const JIRA_KEY = /^[A-Z][A-Z0-9]{0,9}$/;

export const PROJECTS = [
  "factory-desk",
  "planner",
  "triage-jira",
  "pr-autofixer",
  "security-reviewer",
];

const INTAKE_CHANNEL = /^[CG][A-Z0-9]{5,}$/;

// Copied from agent/lib/factory-stage.ts; doctor.test.mjs holds the two to
// the same lists.
export const PRODUCTION_TARGETS = {
  repos: ["cursor-demo-lab/marsbank"],
  jiraProjects: ["TLSSN"],
  slackChannels: ["C0EXAMPLE1", "#mars-eng-intake"],
  slackApps: ["A0EXAMPLE1"],
};

const CURSOR_APP_SLUG = "cursor";

const JULY_PACKAGE = "@cursor/july";

/** The pinned CLI prefix for fix hints: `npx -p <package>@<factory.json version> agent-sdk`. */
function julyCli(facts) {
  const version = facts.factory.version;
  return `npx -p ${JULY_PACKAGE}${version ? `@${version}` : ""} agent-sdk`;
}

const TAG = {
  ok: "ok  ",
  warn: "WARN",
  fail: "FAIL",
  skip: "skip",
};

export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    let value = line.slice(eq + 1);
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.length >= 2 &&
      value[value.length - 1] === quote
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function layerEnv(base, ...files) {
  /** @type {Record<string, string | undefined>} */
  const out = { ...base };
  for (const file of files) {
    for (const [key, value] of Object.entries(file)) {
      if (out[key] === undefined) out[key] = value;
    }
  }
  return out;
}

function csv(raw) {
  return String(raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function effectiveSandbox(env) {
  const explicit = String(env.FACTORY_SANDBOX_REPO ?? "").trim();
  if (explicit !== "") return explicit;
  return csv(env.FACTORY_REPOS)[0];
}

function sandboxRef(env) {
  const ref = String(env.FACTORY_SANDBOX_REF ?? "").trim();
  return ref === "" ? "main" : ref;
}

function envValue(env, key) {
  const value = env[key];
  return value === undefined ? "" : String(value);
}

function envSet(env, key) {
  return envValue(env, key) !== "";
}

function nodeMeetsMinimum(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(String(version));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 13);
}

function checkNodeVersion(facts) {
  if (facts.node.isBun || !nodeMeetsMinimum(facts.node.version)) {
    return {
      id: "node-version",
      level: "fail",
      title: facts.node.isBun
        ? "Bun is not supported"
        : `Node ${facts.node.version} is below 22.13`,
      fix: "Use Node 22.13+, never Bun.",
    };
  }
  return {
    id: "node-version",
    level: "ok",
    title: `Node ${facts.node.version}`,
  };
}

function checkDepsInstalled(facts) {
  const missing = PROJECTS.filter(
    (name) => facts.projects[name]?.installedJulyVersion === undefined
  );
  if (missing.length > 0) {
    return {
      id: "deps-installed",
      level: "fail",
      title: "Some projects are missing @cursor/july",
      detail: missing.join(", "),
      fix: "Run npm ci in each named project.",
    };
  }
  return {
    id: "deps-installed",
    level: "ok",
    title: "All five projects have @cursor/july installed",
  };
}

function checkJulyVersion(facts) {
  const expected = facts.factory.version;
  const diffs = PROJECTS.flatMap((name) => {
    const installed = facts.projects[name]?.installedJulyVersion;
    if (installed === expected) return [];
    return [`${name}: ${installed} vs ${expected}`];
  });
  if (diffs.length > 0) {
    return {
      id: "july-version",
      level: "warn",
      title: "@cursor/july version mismatch",
      detail: diffs.join("; "),
      fix: "Run npm ci in each mismatched project so installedJulyVersion matches factory.version.",
    };
  }
  return {
    id: "july-version",
    level: "ok",
    title: `@cursor/july ${expected} in every project`,
  };
}

function checkFactoryRepos(facts) {
  const entries = csv(facts.env.FACTORY_REPOS);
  const fix =
    "Set FACTORY_REPOS=owner/repo[,owner/repo] in .env.local at the factory root.";
  if (entries.length === 0) {
    return {
      id: "factory-repos",
      level: "fail",
      title: "FACTORY_REPOS is unset or empty",
      detail: "FACTORY_REPOS has no owner/repo entries",
      fix,
    };
  }
  const bad = entries.filter((entry) => !REPO.test(entry));
  if (bad.length > 0) {
    return {
      id: "factory-repos",
      level: "fail",
      title: "FACTORY_REPOS has invalid entries",
      detail: bad.join(", "),
      fix,
    };
  }
  return {
    id: "factory-repos",
    level: "ok",
    title: `FACTORY_REPOS ${entries.join(", ")}`,
  };
}

function checkSandboxRepo(facts) {
  const explicit = String(facts.env.FACTORY_SANDBOX_REPO ?? "").trim();
  const ref = sandboxRef(facts.env);
  if (explicit !== "" && !REPO.test(explicit)) {
    return {
      id: "sandbox-repo",
      level: "fail",
      title: `sandbox ${explicit} (FACTORY_SANDBOX_REF=${ref})`,
      detail: "FACTORY_SANDBOX_REPO is not owner/repo",
      fix: "Set FACTORY_SANDBOX_REPO to one owner/repo.",
    };
  }
  const sandbox = effectiveSandbox(facts.env);
  const title = `sandbox ${sandbox ?? "unset"} (FACTORY_SANDBOX_REF=${ref})`;
  const listed = csv(facts.env.FACTORY_REPOS);
  if (
    sandbox !== undefined &&
    !listed.some((repo) => repo.toLowerCase() === sandbox.toLowerCase())
  ) {
    return {
      id: "sandbox-repo",
      level: "warn",
      title,
      detail:
        "the security reviewer, the autofixer, and the desk's review updates only act on FACTORY_REPOS, so a PR the cloud agent opens there gets no review, no automatic fix, and no review update in Slack",
      fix: "Add the effective sandbox owner/repo to FACTORY_REPOS.",
    };
  }
  return { id: "sandbox-repo", level: "ok", title };
}

function checkJiraProjects(facts) {
  const keys = csv(facts.env.FACTORY_JIRA_PROJECTS)
    .map((part) => part.toUpperCase())
    .filter((key) => JIRA_KEY.test(key));
  if (keys.length === 0) {
    return {
      id: "jira-projects",
      level: "fail",
      title: "FACTORY_JIRA_PROJECTS has no valid Jira key",
      detail:
        "file_ticket refuses, the planner cannot comment, and no pull request is fixed automatically",
      fix: "Set FACTORY_JIRA_PROJECTS=KEY at the root.",
    };
  }
  return {
    id: "jira-projects",
    level: "ok",
    title: `FACTORY_JIRA_PROJECTS ${keys.join(", ")}`,
  };
}

function checkSlackTokens(facts) {
  const bot = envValue(facts.env, "FACTORY_DESK_SLACK_BOT_TOKEN");
  const app = envValue(facts.env, "FACTORY_DESK_SLACK_APP_TOKEN");
  if (!bot.startsWith("xoxb-") || !app.startsWith("xapp-")) {
    return {
      id: "slack-tokens",
      level: "fail",
      title: "FACTORY_DESK Slack tokens are missing or malformed",
      detail:
        "FACTORY_DESK_SLACK_BOT_TOKEN must start with xoxb- and FACTORY_DESK_SLACK_APP_TOKEN must start with xapp-",
      fix: `Run ${julyCli(facts)} slack create --dir factory-desk --name Factory (needs agent-sdk login first).`,
    };
  }
  return {
    id: "slack-tokens",
    level: "ok",
    title:
      "FACTORY_DESK_SLACK_BOT_TOKEN and FACTORY_DESK_SLACK_APP_TOKEN prefixes look right",
  };
}

function checkOneSlackApp(facts) {
  if (
    envSet(facts.env, "PR_AUTOFIXER_SLACK_BOT_TOKEN") ||
    envSet(facts.env, "PR_AUTOFIXER_SLACK_APP_TOKEN")
  ) {
    return {
      id: "one-slack-app",
      level: "warn",
      title: "PR_AUTOFIXER Slack tokens are set",
      detail:
        "the factory has one Slack app, the desk; a second one answers PR mentions on its own",
      fix: "Unset PR_AUTOFIXER_SLACK_BOT_TOKEN and PR_AUTOFIXER_SLACK_APP_TOKEN.",
    };
  }
  return {
    id: "one-slack-app",
    level: "ok",
    title: "Only the desk Slack app is configured",
  };
}

function checkIntakeChannel(facts) {
  const raw = envValue(facts.env, "FACTORY_DESK_INTAKE_CHANNEL").trim();
  if (raw === "") {
    return {
      id: "intake-channel",
      level: "warn",
      title: "FACTORY_DESK_INTAKE_CHANNEL is unset",
      detail:
        "a ticket filed in Jira directly is planned but not announced in Slack",
      fix: "Set FACTORY_DESK_INTAKE_CHANNEL to a Slack channel id.",
    };
  }
  if (!INTAKE_CHANNEL.test(raw)) {
    return {
      id: "intake-channel",
      level: "fail",
      title: "FACTORY_DESK_INTAKE_CHANNEL is not a Slack channel id",
      detail: "FACTORY_DESK_INTAKE_CHANNEL must match C… or G…",
      fix: "Set FACTORY_DESK_INTAKE_CHANNEL to a C or G Slack channel id.",
    };
  }
  return {
    id: "intake-channel",
    level: "ok",
    title: "FACTORY_DESK_INTAKE_CHANNEL is set",
  };
}

function checkJiraWebhookSecret(facts) {
  if (!envSet(facts.env, "JIRA_WEBHOOK_SECRET")) {
    return {
      id: "jira-webhook-secret",
      level: "warn",
      title: "JIRA_WEBHOOK_SECRET is unset",
      detail:
        "the signed route POST /triage-jira/v1/channels/webhook rejects every delivery with 401, so only the dev route /triage-jira/v1/channels/queue/issue starts a triage",
      fix: "Set JIRA_WEBHOOK_SECRET in triage-jira/.env.local.",
    };
  }
  return {
    id: "jira-webhook-secret",
    level: "ok",
    title:
      "JIRA_WEBHOOK_SECRET set; register <public-url>/triage-jira/v1/channels/webhook as a Jira webhook with this secret",
  };
}

function checkPlannerCheckout(facts) {
  const configured = facts.checkout.configured;
  if (configured === undefined || String(configured).trim() === "") {
    return {
      id: "planner-checkout",
      level: "warn",
      title: "FACTORY_PLANNER_CHECKOUT is unset",
      detail: "plans are written from the ticket alone, evidence: prompt",
      fix: "Set FACTORY_PLANNER_CHECKOUT to a local clone of the sandbox.",
    };
  }
  if (!facts.checkout.exists || !facts.checkout.isGitRepo) {
    return {
      id: "planner-checkout",
      level: "fail",
      title: "FACTORY_PLANNER_CHECKOUT is not a git checkout",
      detail: facts.checkout.exists
        ? "FACTORY_PLANNER_CHECKOUT is not a git repository"
        : "FACTORY_PLANNER_CHECKOUT does not exist",
      fix: "Point FACTORY_PLANNER_CHECKOUT at a git clone of the sandbox.",
    };
  }
  const sandbox = effectiveSandbox(facts.env);
  const origin = facts.checkout.originUrl;
  if (
    origin !== undefined &&
    sandbox !== undefined &&
    !origin.toLowerCase().includes(sandbox.toLowerCase())
  ) {
    return {
      id: "planner-checkout",
      level: "warn",
      title: "FACTORY_PLANNER_CHECKOUT origin is not the sandbox",
      detail: `origin does not contain ${sandbox}`,
      fix: "Point FACTORY_PLANNER_CHECKOUT at a clone of the effective sandbox owner/repo.",
    };
  }
  return {
    id: "planner-checkout",
    level: "ok",
    title:
      sandbox === undefined
        ? "FACTORY_PLANNER_CHECKOUT is a git checkout"
        : `FACTORY_PLANNER_CHECKOUT is a git checkout of ${sandbox}`,
  };
}

function stageName(env) {
  const raw = envValue(env, "FACTORY_ENV").trim().toLowerCase();
  return raw === "" || raw === "production" || raw === "prod" ? "production" : "staging";
}

// Same comparison as factory-stage.ts: case, space, and a leading # ignored.
function normalizedTarget(value) {
  return String(value).trim().toLowerCase().replace(/^#/, "");
}

function isProductionTarget({ kind, value }) {
  const needle = normalizedTarget(value);
  return PRODUCTION_TARGETS[kind].some((entry) => normalizedTarget(entry) === needle);
}

// Every variable a host reads its repositories, Jira projects, or intake
// channel from, per-host overrides included.
const STAGE_SCOPE = [
  { name: "FACTORY_REPOS", kind: "repos" },
  { name: "FACTORY_SANDBOX_REPO", kind: "repos" },
  { name: "PR_AUTOFIXER_REPOS", kind: "repos" },
  { name: "SECURITY_REVIEWER_REPOS", kind: "repos" },
  { name: "FACTORY_JIRA_PROJECTS", kind: "jiraProjects" },
  { name: "FACTORY_DESK_JIRA_PROJECT", kind: "jiraProjects" },
  { name: "FACTORY_PLANNER_JIRA_PROJECTS", kind: "jiraProjects" },
  { name: "PR_AUTOFIXER_AUTO_DRIVE_PROJECTS", kind: "jiraProjects" },
  { name: "FACTORY_DESK_INTAKE_CHANNEL", kind: "slackChannels" },
];

function checkStage(facts) {
  const raw = envValue(facts.env, "FACTORY_ENV").trim();
  if (stageName(facts.env) === "production") {
    return {
      id: "stage",
      level: "ok",
      title: raw === "" ? "FACTORY_ENV unset: production stage" : "FACTORY_ENV production",
    };
  }
  const allowed = csv(facts.env.FACTORY_STAGING_ALLOW_PRODUCTION).map(normalizedTarget);
  const configured = STAGE_SCOPE.flatMap(({ name, kind }) => csv(facts.env[name]).map((value) => ({ name, kind, value }))).filter(isProductionTarget);
  const refused = configured.filter((entry) => !allowed.includes(normalizedTarget(entry.value)));
  if (refused.length > 0) {
    return {
      id: "stage",
      level: "fail",
      title: "FACTORY_ENV is staging but production targets are configured",
      detail: `${refused.map((entry) => `${entry.name}=${entry.value}`).join(", ")}; the staging slug refuses them, so it acts on nothing there`,
      fix: "Point these at the staging sandbox repo, Jira project, and Slack channel, or name each in FACTORY_STAGING_ALLOW_PRODUCTION.",
    };
  }
  if (configured.length > 0) {
    return {
      id: "stage",
      level: "warn",
      title: "FACTORY_ENV is staging and allows production targets",
      detail: configured.map((entry) => `${entry.name}=${entry.value}`).join(", "),
      fix: "Remove them from FACTORY_STAGING_ALLOW_PRODUCTION unless this staging run must touch production.",
    };
  }
  if (raw.toLowerCase() !== "staging") {
    return {
      id: "stage",
      level: "warn",
      title: `FACTORY_ENV=${raw} is treated as staging`,
      fix: "Set FACTORY_ENV to staging, or unset it (production, prod) on a live slug.",
    };
  }
  return { id: "stage", level: "ok", title: "FACTORY_ENV staging, no production target configured" };
}

function checkOpsSlackToken(facts) {
  const ops = envValue(facts.env, "FACTORY_OPS_SLACK_BOT_TOKEN");
  if (ops === "") {
    return {
      id: "ops-slack-token",
      level: "skip",
      title: "FACTORY_OPS_SLACK_BOT_TOKEN unset",
      detail: "the low-scope ops bot for staging probe summaries and the ops failure funnel",
    };
  }
  if (!ops.startsWith("xoxb-")) {
    return {
      id: "ops-slack-token",
      level: "fail",
      title: "FACTORY_OPS_SLACK_BOT_TOKEN is not a bot token",
      detail: "FACTORY_OPS_SLACK_BOT_TOKEN must start with xoxb-",
      fix: "Use the dedicated ops bot's token (chat:write only).",
    };
  }
  if (ops === envValue(facts.env, "FACTORY_DESK_SLACK_BOT_TOKEN")) {
    return {
      id: "ops-slack-token",
      level: "warn",
      title: "FACTORY_OPS_SLACK_BOT_TOKEN is the desk's bot token",
      detail: "the ops bot is a separate low-scope app, so a leaked ops token cannot act as the desk",
      fix: "Mint a dedicated ops bot with chat:write only and use its token.",
    };
  }
  return { id: "ops-slack-token", level: "ok", title: "FACTORY_OPS_SLACK_BOT_TOKEN is a separate bot token" };
}

/**
 * The Slack app the desk's bot token belongs to: auth.test names the bot,
 * bots.info names its app. Only on staging, where a copied production token
 * would make the staging desk post as the production app.
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchFn
 */
export async function probeSlackApp(env, fetchFn) {
  if (stageName(env) !== "staging") return { ran: false };
  const token = envValue(env, "FACTORY_DESK_SLACK_BOT_TOKEN");
  if (!token.startsWith("xoxb-")) return { ran: false };
  const call = async (method, params = {}) => {
    const response = await fetchFn(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    return /** @type {Record<string, any>} */ (await response.json());
  };
  try {
    const auth = await call("auth.test");
    if (auth.ok !== true) return { ran: true, error: `auth.test: ${auth.error ?? "not ok"}` };
    const bot = await call("bots.info", { bot: String(auth.bot_id ?? "") });
    const appId = bot?.bot?.app_id;
    if (bot.ok !== true || typeof appId !== "string") return { ran: true, error: `bots.info: ${bot.error ?? "no app_id"}` };
    return { ran: true, appId, teamId: String(auth.team_id ?? ""), botUserId: String(auth.user_id ?? "") };
  } catch (error) {
    return { ran: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function checkSlackApp(facts) {
  if (stageName(facts.env) === "production") {
    return { id: "slack-app", level: "ok", title: "Slack app check is for staging only" };
  }
  const probe = facts.cli.slackApp ?? { ran: false };
  if (!probe.ran) {
    return { id: "slack-app", level: "skip", title: "Slack app identity not checked", detail: "no FACTORY_DESK_SLACK_BOT_TOKEN locally, or --offline" };
  }
  if (probe.error !== undefined) {
    return { id: "slack-app", level: "warn", title: "Could not read the desk token's Slack app", detail: probe.error, fix: "Check FACTORY_DESK_SLACK_BOT_TOKEN is the staging app's token." };
  }
  if (isProductionTarget({ kind: "slackApps", value: probe.appId })) {
    return {
      id: "slack-app",
      level: "fail",
      title: `FACTORY_DESK_SLACK_BOT_TOKEN belongs to the production Slack app ${probe.appId}`,
      detail: "a staging desk with this token posts as the production Factory app; the desk refuses every Slack event and delivery until it changes",
      fix: "Run the v2 wizard for factory-desk-staging and use that app's bot token.",
    };
  }
  return { id: "slack-app", level: "ok", title: `Staging desk token belongs to Slack app ${probe.appId}, not production's` };
}

function checkEnvNotTracked(facts) {
  if (facts.trackedEnvFiles.length > 0) {
    return {
      id: "env-not-tracked",
      level: "fail",
      title: "Tracked .env.local files",
      detail: facts.trackedEnvFiles.join(", "),
      fix: "Run git rm --cached <file> and rotate the tokens in it.",
    };
  }
  return {
    id: "env-not-tracked",
    level: "ok",
    title: "No tracked .env.local files",
  };
}

function checkCursorLogin(facts) {
  if (!facts.cli.whoami.ran) {
    return { id: "cursor-login", level: "skip", title: "whoami skipped" };
  }
  if (!facts.cli.whoami.signedIn) {
    return {
      id: "cursor-login",
      level: "fail",
      title: "Not signed in to Cursor",
      detail: facts.cli.whoami.detail,
      fix: `Run ${julyCli(facts)} login.`,
    };
  }
  return {
    id: "cursor-login",
    level: "ok",
    title: "Signed in to Cursor",
    detail: facts.cli.whoami.detail,
  };
}

function factoryRepoOwners(env) {
  const owners = [];
  const seen = new Set();
  for (const entry of csv(env.FACTORY_REPOS)) {
    if (!REPO.test(entry)) continue;
    const owner = entry.slice(0, entry.indexOf("/"));
    if (seen.has(owner.toLowerCase())) continue;
    seen.add(owner.toLowerCase());
    owners.push(owner);
  }
  return owners;
}

function ghFailure(error) {
  if (error && error.code === "ENOENT") return "gh is not installed";
  const stderr = error && error.stderr != null ? String(error.stderr) : "";
  const text = stderr.trim() !== "" ? stderr : error instanceof Error ? error.message : String(error);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Lists the GitHub App installations on each distinct FACTORY_REPOS owner.
 * @param {Record<string, string | undefined>} env
 * @param {Exec} exec returns stdout, throws on a non-zero exit or a missing binary
 * @returns {GithubAppProbe}
 */
export function probeGithubApp(env, exec) {
  return {
    ran: true,
    owners: factoryRepoOwners(env).map((owner) => {
      let stdout;
      try {
        stdout = exec("gh", ["api", `orgs/${owner}/installations`, "--jq", ".installations[].app_slug"]);
      } catch (error) {
        return { owner, status: "unknown", reason: ghFailure(error) };
      }
      const slugs = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim());
      return { owner, status: slugs.includes(CURSOR_APP_SLUG) ? "installed" : "missing" };
    }),
  };
}

function checkGithubApp(facts) {
  const probe = facts.cli.githubApp;
  if (!probe.ran) {
    return { id: "github-app", level: "skip", title: "GitHub App check skipped" };
  }
  if (probe.owners.length === 0) {
    return {
      id: "github-app",
      level: "skip",
      title: "GitHub App check skipped",
      detail: "FACTORY_REPOS has no owner/repo entries",
    };
  }
  const names = (status) =>
    probe.owners.filter((entry) => entry.status === status).map((entry) => entry.owner);
  const missing = names("missing");
  if (missing.length > 0) {
    return {
      id: "github-app",
      level: "fail",
      title: `Cursor GitHub App is not installed on ${missing.join(", ")}`,
      detail:
        "deploys of the GitHub agents end failed: GitHub repository is not accessible through this team's installation",
      fix: `Install the Cursor GitHub App on ${missing.join(", ")} for the deploying team (Cursor dashboard, Integrations, GitHub), or move the sandbox to an org that has it.`,
    };
  }
  const unknown = probe.owners.filter((entry) => entry.status === "unknown");
  if (unknown.length > 0) {
    return {
      id: "github-app",
      level: "skip",
      title: `GitHub App check skipped for ${unknown.map((entry) => entry.owner).join(", ")}`,
      detail: unknown.map((entry) => `${entry.owner}: ${entry.reason}`).join("; "),
    };
  }
  return {
    id: "github-app",
    level: "ok",
    title: `Cursor GitHub App installed on ${names("installed").join(", ")}`,
  };
}

function checkSlackDoctor(facts) {
  if (!facts.cli.slackDoctor.ran) {
    return { id: "slack-doctor", level: "skip", title: "slack doctor skipped" };
  }
  if (!facts.cli.slackDoctor.ok) {
    return {
      id: "slack-doctor",
      level: "fail",
      title: "slack doctor failed",
      detail: facts.cli.slackDoctor.detail,
      fix: `Run ${julyCli(facts)} slack doctor --dir factory-desk --prefix FACTORY_DESK.`,
    };
  }
  return { id: "slack-doctor", level: "ok", title: "slack doctor passed" };
}

function checkValidate(facts) {
  if (!facts.cli.validate.ran) {
    return { id: "validate", level: "skip", title: "validate skipped" };
  }
  if (!facts.cli.validate.ok) {
    return {
      id: "validate",
      level: "fail",
      title: "validate failed",
      detail: facts.cli.validate.detail,
      fix: `Run ${julyCli(facts)} validate --dir . from the factory root.`,
    };
  }
  return { id: "validate", level: "ok", title: "validate passed" };
}

export const CHECKS = [
  { id: "node-version", run: checkNodeVersion },
  { id: "deps-installed", run: checkDepsInstalled },
  { id: "july-version", run: checkJulyVersion },
  { id: "factory-repos", run: checkFactoryRepos },
  { id: "sandbox-repo", run: checkSandboxRepo },
  { id: "jira-projects", run: checkJiraProjects },
  { id: "slack-tokens", run: checkSlackTokens },
  { id: "one-slack-app", run: checkOneSlackApp },
  { id: "intake-channel", run: checkIntakeChannel },
  { id: "jira-webhook-secret", run: checkJiraWebhookSecret },
  { id: "planner-checkout", run: checkPlannerCheckout },
  { id: "stage", run: checkStage },
  { id: "ops-slack-token", run: checkOpsSlackToken },
  { id: "slack-app", run: checkSlackApp },
  { id: "env-not-tracked", run: checkEnvNotTracked },
  { id: "cursor-login", run: checkCursorLogin },
  { id: "github-app", run: checkGithubApp },
  { id: "slack-doctor", run: checkSlackDoctor },
  { id: "validate", run: checkValidate },
];

export function runChecks(facts) {
  return CHECKS.map((check) => check.run(facts));
}

export function summarize(findings) {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const finding of findings) {
    counts[finding.level] += 1;
  }
  return {
    exitCode: counts.fail > 0 ? 1 : 0,
    counts,
  };
}

export function render(findings) {
  const lines = [];
  for (const finding of findings) {
    lines.push(`${TAG[finding.level]} ${finding.title}`);
    if (finding.level === "ok") continue;
    if (finding.detail) lines.push(`     ${finding.detail}`);
    if (finding.fix) lines.push(`     ${finding.fix}`);
  }
  return lines.join("\n");
}

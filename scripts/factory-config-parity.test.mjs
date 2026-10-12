import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

register("./ts-resolve.mjs", import.meta.url);

// The settings the factory agents share must mean the same thing on every
// agent that reads them: the same env names, defaults, parsing, and
// validation, and the same .env.example wording. A setting stays only on the
// agents that already read it, so each list below names exactly those agents.
// copies-parity.test.mjs holds the shared files byte for byte; this file
// holds each agent's config.ts to the same answers, so a wrapper or a
// per-agent copy (statusNames) cannot drift either.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROJECTS = ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"];
const JIRA_PROJECTS = ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer"];
const STRICT_REPOS = ["factory-worker", "planner", "pr-autofixer", "security-reviewer"];
const SANDBOX = ["factory-worker", "planner"];

const STATUSES = {
  todo: ["FACTORY_STATUS_TODO", "To Do"],
  triaged: ["FACTORY_STATUS_TRIAGED", "Triaged"],
  planned: ["FACTORY_STATUS_PLANNED", "Planned"],
  approved: ["FACTORY_STATUS_APPROVED", "Approved"],
  inProgress: ["FACTORY_STATUS_IN_PROGRESS", "In Progress"],
  inReview: ["FACTORY_STATUS_IN_REVIEW", "In Review"],
  done: ["FACTORY_STATUS_DONE", "Done"],
};
const STATUS_KEYS = {
  "factory-desk": Object.keys(STATUSES),
  "factory-worker": Object.keys(STATUSES),
  planner: ["triaged", "planned"],
  "triage-jira": Object.keys(STATUSES),
};

// Signed Jira webhook route per agent (agent/channels/<route>.ts), and the
// agents whose route also verifies Linear-Signature.
const JIRA_ROUTES = { "factory-desk": "jira", "factory-worker": "jira", planner: "webhook", "triage-jira": "webhook" };
const LINEAR_READERS = ["factory-desk", "planner", "triage-jira"];

// The override half of the model block is the same on every agent. The
// default it opens with is the agent's own root model: Auto, except the two
// agents whose agent.ts passes LIGHT_MODEL (grok-4.6 fast) to factoryModel.
const MODEL_OVERRIDES = ` FACTORY_AGENT_MODEL=grok-4.7 defaults to effort high and
# speed fast. Effort and speed are params, never an id suffix.
FACTORY_AGENT_MODEL=
FACTORY_AGENT_EFFORT=
FACTORY_AGENT_SPEED=
`;
const AUTO_DEFAULT = `# Host model. Unset: Auto (auto-smart, optimize_for=balanced), which takes
# no effort or speed.`;
const MODEL_DEFAULTS = {
  "factory-desk": `# Host model. Unset: grok-4.6 with effort high and fast=true (grok-4.6-fast)
# for every desk turn: the filing prompt, its fallback triage, commands, and
# status answers. FACTORY_AGENT_MODEL=auto-smart runs them on Auto
# (optimize_for=balanced).`,
  "triage-jira": `# Host model. Unset: grok-4.6 with effort high and fast=true (grok-4.6-fast),
# because this agent's only model turn is the fallback triage turn when Jev
# does not settle the ticket. FACTORY_AGENT_MODEL=auto-smart runs it on Auto
# (optimize_for=balanced).`,
};
const LIGHT_AGENTS = Object.keys(MODEL_DEFAULTS);
const modelBlock = (project) => `${MODEL_DEFAULTS[project] ?? AUTO_DEFAULT}${MODEL_OVERRIDES}`;
const CLOUD_ID_BLOCK = `# Site the Atlassian MCP tools take as cloudId (the site URL or its cloud id).
# Unset: https://example.atlassian.net.
JIRA_CLOUD_ID=
`;
const jiraSecretBlock = (route) => `# HMAC secret of this slug's Jira webhook on /v1/channels/${route}. Each slug has
# its own; the values may match. Unset: every Jira delivery is refused (401).
JIRA_WEBHOOK_SECRET=
`;
const LINEAR_SECRET_BLOCK = `# HMAC secret for Linear deliveries (Linear-Signature) on the same route.
# Unset: every Linear delivery is refused (401).
LINEAR_WEBHOOK_SECRET=
`;

async function config(project) {
  return import(new URL(`${project}/agent/lib/config.ts`, `file://${ROOT}`).href);
}

function envExample(project) {
  return readFileSync(join(ROOT, project, ".env.example"), "utf8");
}

/** Every non-test TypeScript source under `dir`, concatenated. */
function sources(dir) {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !/\.(test|fixtures)\.ts$/.test(entry.name)) files.push(readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return files.join("\n");
}

/** The answer, or the thrown error's name and message, so throws compare too. */
function outcome(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { threw: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

async function assertSameAnswers(projects, name, calls) {
  const modules = await Promise.all(projects.map(config));
  for (const call of calls) {
    const answers = modules.map((module) => outcome(() => call(module[name])));
    projects.forEach((project, index) => assert.deepEqual(answers[index], answers[0], `${project} ${name} differs from ${projects[0]} for ${call}`));
  }
}

test("each shared config function is exported by exactly the agents that read its setting", async () => {
  const expected = {
    factoryModel: PROJECTS,
    jiraProjects: JIRA_PROJECTS,
    factoryRepos: STRICT_REPOS,
    FactoryConfigError: STRICT_REPOS,
    sandboxRepo: SANDBOX,
    sandboxRef: SANDBOX,
    sandboxReposAtBoot: SANDBOX,
    statusNames: Object.keys(STATUS_KEYS),
  };
  for (const project of PROJECTS) {
    const module = await config(project);
    for (const [name, owners] of Object.entries(expected)) {
      assert.equal(typeof module[name] === "function", owners.includes(project), `${project} ${owners.includes(project) ? "must" : "must not"} export ${name}`);
    }
  }
});

test("factoryModel: every agent answers the same for the same FACTORY_AGENT_* settings", async () => {
  await assertSameAnswers(PROJECTS, "factoryModel", [
    (f) => f({}),
    (f) => f({ FACTORY_AGENT_MODEL: " auto-smart ", FACTORY_AGENT_EFFORT: "high", FACTORY_AGENT_SPEED: "fast" }),
    (f) => f({ FACTORY_AGENT_MODEL: "grok-4.7" }),
    (f) => f({ FACTORY_AGENT_MODEL: "grok-4.7", FACTORY_AGENT_EFFORT: " low ", FACTORY_AGENT_SPEED: "standard" }),
    (f) => f({ FACTORY_AGENT_MODEL: "claude-opus-5-5" }),
    (f) => f({ FACTORY_AGENT_MODEL: "grok-4.6", FACTORY_AGENT_EFFORT: "xhigh", FACTORY_AGENT_SPEED: "standard" }),
    (f) => f({ FACTORY_AGENT_MODEL: "unknown-model", FACTORY_AGENT_EFFORT: "max" }),
  ]);
});

test("jiraProjects: every agent parses FACTORY_JIRA_PROJECTS and its override the same way", async () => {
  await assertSameAnswers(JIRA_PROJECTS, "jiraProjects", [
    (f) => f({}),
    (f) => f({ FACTORY_JIRA_PROJECTS: " tlssn, TLSSN,, ops ,1bad, WAYTOOLONGKEY " }),
    (f) => f({ OVERRIDE: "abc", FACTORY_JIRA_PROJECTS: "TLSSN" }, "OVERRIDE"),
    (f) => f({ OVERRIDE: "", FACTORY_JIRA_PROJECTS: "TLSSN" }, "OVERRIDE"),
    (f) => f({ FACTORY_JIRA_PROJECTS: "TLSSN" }, "OVERRIDE"),
    (f) => f({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "tlssn, TLSTG" }),
    (f) => f({ FACTORY_ENV: "staging", FACTORY_STAGING_ALLOW_PRODUCTION: "TLSSN", FACTORY_JIRA_PROJECTS: "TLSSN" }),
    (f) => f({ FACTORY_ENV: "staging", OVERRIDE: "TLSSN" }, "OVERRIDE"),
  ]);
  const planner = await config("planner");
  assert.deepEqual(planner.jiraProjects({ FACTORY_JIRA_PROJECTS: " tlssn, TLSSN,, ops ,1bad " }), ["TLSSN", "OPS"]);
  assert.deepEqual(planner.jiraProjects({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "tlssn, TLSTG" }), ["TLSTG"]);
});

test("factoryRepos: every agent validates FACTORY_REPOS and its override the same way", async () => {
  await assertSameAnswers(STRICT_REPOS, "factoryRepos", [
    (f) => f({}),
    (f) => f({ FACTORY_REPOS: " acme/one, Acme/One, acme/two " }),
    (f) => f({ FACTORY_REPOS: "acme/one, not a repo" }),
    (f) => f({ FACTORY_REPOS: "acme/one." }),
    (f) => f({ OVERRIDE: "other/repo", FACTORY_REPOS: "acme/one" }, "OVERRIDE"),
    (f) => f({ OVERRIDE: "", FACTORY_REPOS: "acme/one" }, "OVERRIDE"),
    (f) => f({ FACTORY_ENV: "staging", FACTORY_REPOS: "cursor-demo-lab/marsbank, cursor-demo-lab/marsbank-staging" }),
    (f) => f({ FACTORY_ENV: "staging", FACTORY_REPOS: "Cursor-Demo-Lab/MarsBank" }),
    (f) => f({ FACTORY_ENV: "staging", FACTORY_STAGING_ALLOW_PRODUCTION: "cursor-demo-lab/marsbank", FACTORY_REPOS: "cursor-demo-lab/marsbank" }),
  ]);
  const planner = await config("planner");
  assert.deepEqual(planner.factoryRepos({ FACTORY_ENV: "staging", FACTORY_REPOS: "cursor-demo-lab/marsbank, acme/stage" }), ["acme/stage"]);
  assert.throws(() => planner.factoryRepos({ FACTORY_ENV: "staging", FACTORY_REPOS: "cursor-demo-lab/marsbank" }), /FACTORY_STAGING_ALLOW_PRODUCTION/);
});

test("sandboxRepo, sandboxRef, sandboxReposAtBoot: planner and worker answer the same", async () => {
  const envs = [
    {},
    { FACTORY_SANDBOX_REPO: " acme/sandbox ", FACTORY_SANDBOX_REF: " dev " },
    { FACTORY_SANDBOX_REPO: "not/a/repo" },
    { FACTORY_REPOS: "acme/one, acme/two", FACTORY_SANDBOX_REF: " " },
    { FACTORY_REPOS: "bad repo" },
    { FACTORY_ENV: "staging", FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank" },
    { FACTORY_ENV: "staging", FACTORY_REPOS: "cursor-demo-lab/marsbank, acme/stage" },
    { FACTORY_ENV: "staging", FACTORY_STAGING_ALLOW_PRODUCTION: "cursor-demo-lab/marsbank", FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank" },
  ];
  for (const name of ["sandboxRepo", "sandboxRef", "sandboxReposAtBoot"]) {
    await assertSameAnswers(SANDBOX, name, envs.map((env) => (f) => f(env)));
  }
});

test("statusNames: each agent reads the same FACTORY_STATUS_* names with the same defaults and parsing", async () => {
  for (const [project, keys] of Object.entries(STATUS_KEYS)) {
    const { statusNames } = await config(project);
    assert.deepEqual(Object.keys(statusNames({})).sort(), [...keys].sort(), `${project} reads a different set of statuses`);
    for (const key of keys) {
      const [name, fallback] = STATUSES[key];
      assert.equal(statusNames({})[key], fallback, `${project} ${key} default`);
      assert.equal(statusNames({ [name]: "" })[key], fallback, `${project} ${key} empty`);
      assert.equal(statusNames({ [name]: "Custom" })[key], "Custom", `${project} ${key} reads ${name}`);
      assert.equal(statusNames({ [name]: " " })[key], " ", `${project} ${key} keeps the value untrimmed`);
    }
  }
});

// factory-worker's root model is its implement model (IMPLEMENT_MODEL,
// workerModel read once at load): its one model turn is the implement cloud turn, and a
// live July send may carry no modelConfig (docs/deployment-issues.md issue
// 27). It reads no FACTORY_AGENT_* and documents none.
const IMPLEMENT_MODEL_AGENTS = ["factory-worker"];

test(".env.example: the model block is worded the same on every host-model agent, and its default is the agent's root model; the worker's root model is workerModel", () => {
  for (const project of PROJECTS) {
    const agent = readFileSync(join(ROOT, project, "agent/agent.ts"), "utf8");
    if (IMPLEMENT_MODEL_AGENTS.includes(project)) {
      assert.match(agent, /(?:model:|const model =)\s*IMPLEMENT_MODEL\b/, `${project}/agent/agent.ts must set model: IMPLEMENT_MODEL (workerModel read once at load)`);
      assert.doesNotMatch(agent, /factoryModel\(/, `${project}/agent/agent.ts reads the host model, which its turn never runs`);
      assert.doesNotMatch(envExample(project), /^FACTORY_AGENT_/m, `${project}/.env.example documents FACTORY_AGENT_*, which ${project} never reads`);
      assert.doesNotMatch(agent, /"FACTORY_AGENT_/, `${project}/agent/agent.ts declares a FACTORY_AGENT_* secret it never reads`);
      continue;
    }
    assert.ok(envExample(project).includes(modelBlock(project)), `${project}/.env.example model block drifted`);
    const light = /(?:model:|const model =)\s*factoryModel\(process\.env,\s*LIGHT_MODEL\)/.test(agent);
    const auto = /(?:model:|const model =)\s*factoryModel\(process\.env\)/.test(agent);
    assert.ok(light !== auto, `${project}/agent/agent.ts must set model: factoryModel(process.env) or factoryModel(process.env, LIGHT_MODEL)`);
    assert.equal(light, LIGHT_AGENTS.includes(project), `${project}: the .env.example model default and agent.ts disagree`);
  }
});

const STAGE_BLOCK = `# Stage. Unset, production, or prod: a live slug. Any other value (staging)
# is a staging slug that refuses the production Slack intake, Jira project,
# and sandbox repository (agent/lib/factory-stage.ts) unless
# FACTORY_STAGING_ALLOW_PRODUCTION names them, comma-separated.
FACTORY_ENV=
FACTORY_STAGING_ALLOW_PRODUCTION=
`;

test(".env.example and hosting.secretNames: every agent documents and declares FACTORY_ENV the same way", () => {
  for (const project of PROJECTS) {
    assert.ok(envExample(project).includes(STAGE_BLOCK), `${project}/.env.example FACTORY_ENV block drifted`);
    const agent = readFileSync(join(ROOT, project, "agent/agent.ts"), "utf8");
    for (const name of ["FACTORY_ENV", "FACTORY_STAGING_ALLOW_PRODUCTION"]) assert.ok(agent.includes(`"${name}"`), `${project}/agent/agent.ts does not declare ${name}`);
  }
});

const OPS_BLOCK = `# Ops failure funnel (agent/lib/ops-funnel.ts), optional. A kv failure the
# code swallows logs one {"kv":"warn"} line either way. With both set, an
# unexpected kv or claim failure also posts one line per site and reason per
# hour to FACTORY_OPS_SLACK_CHANNEL (a C... id) as the separate chat:write-only
# ops bot, never the desk's token. Either unset: no post. FACTORY_OPS_FUNNEL=off
# turns the posts off.
FACTORY_OPS_SLACK_BOT_TOKEN=
FACTORY_OPS_SLACK_CHANNEL=
FACTORY_OPS_FUNNEL=
`;

test(".env.example and hosting: every agent documents the ops funnel the same way, declares its two optional secrets, and may reach slack.com", () => {
  for (const project of PROJECTS) {
    assert.ok(envExample(project).includes(OPS_BLOCK), `${project}/.env.example ops funnel block drifted`);
    const agent = readFileSync(join(ROOT, project, "agent/agent.ts"), "utf8");
    for (const name of ["FACTORY_OPS_SLACK_BOT_TOKEN", "FACTORY_OPS_SLACK_CHANNEL"]) assert.ok(agent.includes(`"${name}"`), `${project}/agent/agent.ts does not declare ${name}`);
    assert.doesNotMatch(agent, /"FACTORY_OPS_FUNNEL"/, `${project}: FACTORY_OPS_FUNNEL is a kill switch read per request, not a declared secret`);
    assert.match(agent, /egressDomains: \[[^\]]*"slack\.com"/, `${project}/agent/agent.ts egress does not allow slack.com for the ops funnel`);
  }
});

test(".env.example: the Jira and Linear blocks are worded the same on the agents that read them", () => {
  for (const [project, route] of Object.entries(JIRA_ROUTES)) {
    assert.ok(existsSync(join(ROOT, project, "agent/channels", `${route}.ts`)), `${project} has no /v1/channels/${route}`);
    const text = envExample(project);
    assert.ok(text.includes(CLOUD_ID_BLOCK), `${project}/.env.example JIRA_CLOUD_ID block drifted`);
    assert.ok(text.includes(jiraSecretBlock(route)), `${project}/.env.example JIRA_WEBHOOK_SECRET block drifted`);
    const readsLinear = sources(join(ROOT, project, "agent")).includes("LINEAR_WEBHOOK_SECRET");
    assert.equal(readsLinear, LINEAR_READERS.includes(project), `${project} LINEAR_WEBHOOK_SECRET reader list is stale`);
    assert.equal(text.includes(LINEAR_SECRET_BLOCK), readsLinear, `${project}/.env.example LINEAR_WEBHOOK_SECRET block`);
  }
  for (const project of PROJECTS.filter((p) => !(p in JIRA_ROUTES))) {
    assert.doesNotMatch(envExample(project), /^(JIRA|LINEAR)_/m, `${project} has no Jira webhook`);
  }
});

test(".env.example documents only settings its agent reads, and every FACTORY_STATUS_* its statusNames reads", () => {
  for (const project of PROJECTS) {
    const code = sources(join(ROOT, project, "agent"));
    const documented = [...envExample(project).matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);
    for (const name of documented) assert.ok(new RegExp(`\\b${name}\\b`).test(code), `${project}/.env.example documents ${name}, which ${project}/agent never reads`);
    const statuses = documented.filter((name) => name.startsWith("FACTORY_STATUS_")).sort();
    const reads = (STATUS_KEYS[project] ?? []).map((key) => STATUSES[key][0]).sort();
    assert.deepEqual(statuses, reads, `${project}/.env.example FACTORY_STATUS_* list`);
  }
});

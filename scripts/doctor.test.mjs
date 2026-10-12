import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import {
  CHECKS,
  layerEnv,
  parseEnvFile,
  probeGithubApp,
  PRODUCTION_TARGETS,
  probeSlackApp,
  PROJECTS,
  render,
  runChecks,
  summarize,
} from "./doctor-checks.mjs";

register("./ts-resolve.mjs", import.meta.url);

const FACTORY = JSON.parse(readFileSync(new URL("../factory.json", import.meta.url), "utf8"));
const JULY_VERSION = FACTORY.version;
const JULY_VERSION_PATTERN = JULY_VERSION.replaceAll(".", "\\.");
const JULY_PIN_PATTERN = `${FACTORY.package}@${JULY_VERSION}`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function installed(version = JULY_VERSION) {
  return Object.fromEntries(
    PROJECTS.map((name) => [name, { installedJulyVersion: version }])
  );
}

function baseFacts({
  env,
  node,
  factory,
  projects,
  checkout,
  trackedEnvFiles,
  cli,
} = {}) {
  const facts = {
    env: {
      FACTORY_REPOS: "example-org/demo-repo",
      FACTORY_SANDBOX_REPO: "example-org/demo-repo",
      FACTORY_SANDBOX_REF: "main",
      FACTORY_JIRA_PROJECTS: "TLSSN",
      FACTORY_DESK_SLACK_BOT_TOKEN: "xoxb-test",
      FACTORY_DESK_SLACK_APP_TOKEN: "xapp-test",
      FACTORY_DESK_INTAKE_CHANNEL: "C01234567",
      JIRA_WEBHOOK_SECRET: "secret",
      FACTORY_PLANNER_CHECKOUT: "/tmp/sandbox",
      FACTORY_OPS_SLACK_BOT_TOKEN: "xoxb-ops",
    },
    node: { version: "v22.13.0", isBun: false },
    factory: { version: JULY_VERSION, sandboxRepo: "example-org/demo-repo" },
    projects: installed(),
    checkout: {
      configured: "/tmp/sandbox",
      exists: true,
      isGitRepo: true,
      originUrl: "https://github.com/example-org/demo-repo.git",
    },
    trackedEnvFiles: [],
    cli: {
      whoami: { ran: true, signedIn: true, detail: "user@example.com" },
      slackDoctor: { ran: true, ok: true, detail: "pass" },
      validate: { ran: true, ok: true, detail: "ok" },
      githubApp: { ran: true, owners: [{ owner: "example-org", status: "installed" }] },
    },
  };
  return {
    ...facts,
    env: { ...facts.env, ...env },
    node: { ...facts.node, ...node },
    factory: { ...facts.factory, ...factory },
    projects: projects ?? facts.projects,
    checkout: { ...facts.checkout, ...checkout },
    trackedEnvFiles: trackedEnvFiles ?? facts.trackedEnvFiles,
    cli: {
      whoami: { ...facts.cli.whoami, ...cli?.whoami },
      slackDoctor: { ...facts.cli.slackDoctor, ...cli?.slackDoctor },
      validate: { ...facts.cli.validate, ...cli?.validate },
      githubApp: { ...facts.cli.githubApp, ...cli?.githubApp },
    },
  };
}

function byId(id, facts) {
  const check = CHECKS.find((item) => item.id === id);
  assert.ok(check, `missing check ${id}`);
  const finding = check.run(facts);
  assert.ok(finding, `check ${id} returned undefined`);
  return finding;
}

function assertNonOk(finding, level, pattern) {
  assert.equal(finding.level, level);
  assert.match(`${finding.detail ?? ""}\n${finding.fix ?? ""}`, pattern);
}

test("parseEnvFile handles quotes, comments, and blank lines", () => {
  assert.deepEqual(
    parseEnvFile(
      [
        "# heading",
        "",
        "FOO=bar",
        'QUOTED="hello world"',
        "SINGLE='xyz'",
        "  # indented comment",
        "HASH=#not-a-comment",
        "EMPTY=",
        'BLANK=""',
      ].join("\n")
    ),
    {
      FOO: "bar",
      QUOTED: "hello world",
      SINGLE: "xyz",
      HASH: "#not-a-comment",
      EMPTY: "",
      BLANK: "",
    }
  );
});

test("layerEnv never overrides an earlier layer", () => {
  const base = { A: "env", PATH: "/bin" };
  assert.deepEqual(
    layerEnv(
      base,
      { A: "local", B: "local", C: "local" },
      { B: "dotenv", C: "dotenv", D: "dotenv" },
      { D: "later", E: "later" }
    ),
    {
      A: "env",
      PATH: "/bin",
      B: "local",
      C: "local",
      D: "dotenv",
      E: "later",
    }
  );
  assert.deepEqual(base, { A: "env", PATH: "/bin" });
});

test("runChecks returns one finding per check in registry order, and summarize exits 1 on fail", () => {
  const ids = [
    "node-version",
    "deps-installed",
    "july-version",
    "factory-repos",
    "sandbox-repo",
    "jira-projects",
    "slack-tokens",
    "one-slack-app",
    "intake-channel",
    "jira-webhook-secret",
    "planner-checkout",
    "stage",
    "ops-slack-token",
    "slack-app",
    "env-not-tracked",
    "cursor-login",
    "github-app",
    "slack-doctor",
    "validate",
  ];
  assert.deepEqual(CHECKS.map((check) => check.id), ids);
  const findings = runChecks(baseFacts());
  assert.deepEqual(findings.map((finding) => finding.id), ids);
  for (const finding of findings) assert.equal(finding.level, "ok", finding.id);
  assert.deepEqual(summarize(findings), {
    exitCode: 0,
    counts: { ok: 19, warn: 0, fail: 0, skip: 0 },
  });
  assert.equal(
    summarize([{ id: "x", level: "fail", title: "nope" }]).exitCode,
    1
  );
  assert.equal(
    summarize([
      { id: "a", level: "warn", title: "w" },
      { id: "b", level: "skip", title: "s" },
    ]).exitCode,
    0
  );
});

test("render prints a fixed-width tag and indents non-ok detail and fix", () => {
  assert.equal(
    render([
      { id: "node-version", level: "ok", title: "Node v22.13.0" },
      {
        id: "factory-repos",
        level: "fail",
        title: "FACTORY_REPOS is unset or empty",
        detail: "FACTORY_REPOS has no owner/repo entries",
        fix: "Set FACTORY_REPOS=owner/repo[,owner/repo] in .env.local at the factory root.",
      },
    ]),
    [
      "ok   Node v22.13.0",
      "FAIL FACTORY_REPOS is unset or empty",
      "     FACTORY_REPOS has no owner/repo entries",
      "     Set FACTORY_REPOS=owner/repo[,owner/repo] in .env.local at the factory root.",
    ].join("\n")
  );
});

test("node-version", () => {
  const ok = byId("node-version", baseFacts());
  assert.equal(ok.level, "ok");
  assertNonOk(
    byId("node-version", baseFacts({ node: { version: "v20.11.0" } })),
    "fail",
    /Node 22\.13/
  );
  assertNonOk(
    byId("node-version", baseFacts({ node: { isBun: true } })),
    "fail",
    /Bun/
  );
});

test("deps-installed", () => {
  const ok = byId("deps-installed", baseFacts());
  assert.equal(ok.level, "ok");
  const fail = byId(
    "deps-installed",
    baseFacts({
      projects: {
        ...installed(),
        planner: { installedJulyVersion: undefined },
        "triage-jira": { installedJulyVersion: undefined },
      },
    })
  );
  assertNonOk(fail, "fail", /npm ci/);
  assert.match(fail.detail, /planner/);
  assert.match(fail.detail, /triage-jira/);
});

test("july-version", () => {
  const ok = byId("july-version", baseFacts());
  assert.equal(ok.level, "ok");
  const warn = byId(
    "july-version",
    baseFacts({
      projects: { ...installed(), planner: { installedJulyVersion: "0.2.1" } },
    })
  );
  assertNonOk(warn, "warn", new RegExp(`planner: 0\\.2\\.1 vs ${JULY_VERSION_PATTERN}`));
});

test("factory-repos", () => {
  const ok = byId("factory-repos", baseFacts());
  assert.equal(ok.level, "ok");
  assertNonOk(
    byId("factory-repos", baseFacts({ env: { FACTORY_REPOS: undefined } })),
    "fail",
    /FACTORY_REPOS/
  );
  assertNonOk(
    byId("factory-repos", baseFacts({ env: { FACTORY_REPOS: "bad" } })),
    "fail",
    /FACTORY_REPOS/
  );
});

test("sandbox-repo", () => {
  const ok = byId("sandbox-repo", baseFacts());
  assert.equal(ok.level, "ok");
  assert.match(ok.title, /example-org\/demo-repo/);
  assert.match(ok.title, /FACTORY_SANDBOX_REF=main/);
  assertNonOk(
    byId("sandbox-repo", baseFacts({ env: { FACTORY_SANDBOX_REPO: "nope" } })),
    "fail",
    /FACTORY_SANDBOX_REPO/
  );
  const warn = byId(
    "sandbox-repo",
    baseFacts({ env: { FACTORY_SANDBOX_REPO: "acme/other" } })
  );
  assertNonOk(warn, "warn", /FACTORY_REPOS/);
  assert.match(warn.detail, /security reviewer/);
});

test("jira-projects", () => {
  const ok = byId("jira-projects", baseFacts({ env: { FACTORY_JIRA_PROJECTS: "tlssn" } }));
  assert.equal(ok.level, "ok");
  assertNonOk(
    byId("jira-projects", baseFacts({ env: { FACTORY_JIRA_PROJECTS: "not-a-key" } })),
    "fail",
    /FACTORY_JIRA_PROJECTS/
  );
  assert.match(
    byId("jira-projects", baseFacts({ env: { FACTORY_JIRA_PROJECTS: undefined } }))
      .detail,
    /file_ticket/
  );
});

test("slack-tokens", () => {
  const ok = byId("slack-tokens", baseFacts());
  assert.equal(ok.level, "ok");
  const fail = byId(
    "slack-tokens",
    baseFacts({
      env: {
        FACTORY_DESK_SLACK_BOT_TOKEN: undefined,
        FACTORY_DESK_SLACK_APP_TOKEN: undefined,
      },
    })
  );
  assertNonOk(fail, "fail", /FACTORY_DESK_SLACK_BOT_TOKEN/);
  assert.match(fail.fix, /slack create/);
  assert.doesNotMatch(`${fail.title}\n${fail.detail}\n${fail.fix}`, /xoxb-test|xapp-test/);
});

test("one-slack-app", () => {
  const ok = byId("one-slack-app", baseFacts());
  assert.equal(ok.level, "ok");
  assertNonOk(
    byId(
      "one-slack-app",
      baseFacts({ env: { PR_AUTOFIXER_SLACK_BOT_TOKEN: "xoxb-other" } })
    ),
    "warn",
    /PR_AUTOFIXER_SLACK_BOT_TOKEN/
  );
});

test("intake-channel", () => {
  const ok = byId("intake-channel", baseFacts());
  assert.equal(ok.level, "ok");
  assertNonOk(
    byId("intake-channel", baseFacts({ env: { FACTORY_DESK_INTAKE_CHANNEL: undefined } })),
    "warn",
    /FACTORY_DESK_INTAKE_CHANNEL/
  );
  assertNonOk(
    byId("intake-channel", baseFacts({ env: { FACTORY_DESK_INTAKE_CHANNEL: "intake" } })),
    "fail",
    /FACTORY_DESK_INTAKE_CHANNEL/
  );
});

test("jira-webhook-secret", () => {
  const ok = byId("jira-webhook-secret", baseFacts());
  assert.equal(ok.level, "ok");
  assert.match(ok.title, /JIRA_WEBHOOK_SECRET/);
  assert.match(ok.title, /\/triage-jira\/v1\/channels\/webhook/);
  assertNonOk(
    byId("jira-webhook-secret", baseFacts({ env: { JIRA_WEBHOOK_SECRET: undefined } })),
    "warn",
    /JIRA_WEBHOOK_SECRET/
  );
});

test("planner-checkout", () => {
  const ok = byId("planner-checkout", baseFacts());
  assert.equal(ok.level, "ok");
  assertNonOk(
    byId("planner-checkout", baseFacts({ checkout: { configured: undefined } })),
    "warn",
    /FACTORY_PLANNER_CHECKOUT/
  );
  assertNonOk(
    byId(
      "planner-checkout",
      baseFacts({ checkout: { configured: "/missing", exists: false, isGitRepo: false } })
    ),
    "fail",
    /FACTORY_PLANNER_CHECKOUT/
  );
  assertNonOk(
    byId(
      "planner-checkout",
      baseFacts({
        checkout: { originUrl: "https://github.com/acme/other.git" },
      })
    ),
    "warn",
    /example-org\/demo-repo/
  );
});

test("env-not-tracked", () => {
  const ok = byId("env-not-tracked", baseFacts());
  assert.equal(ok.level, "ok");
  const fail = byId(
    "env-not-tracked",
    baseFacts({ trackedEnvFiles: ["factory-desk/.env.local"] })
  );
  assertNonOk(fail, "fail", /git rm --cached/);
  assert.match(fail.detail, /factory-desk\/\.env\.local/);
});

test("cursor-login", () => {
  const ok = byId("cursor-login", baseFacts());
  assert.equal(ok.level, "ok");
  assert.equal(byId("cursor-login", baseFacts({ cli: { whoami: { ran: false } } })).level, "skip");
  assertNonOk(
    byId(
      "cursor-login",
      baseFacts({ cli: { whoami: { ran: true, signedIn: false, detail: "Not signed in" } } })
    ),
    "fail",
    new RegExp(`npx -p ${JULY_PIN_PATTERN} agent-sdk login`)
  );
});

function fakeExec(byOwner) {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    const owner = /^orgs\/([^/]+)\/installations$/.exec(args[1])?.[1];
    const reply = byOwner[owner];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { exec, calls };
}

function execError(message, fields) {
  return Object.assign(new Error(message), fields);
}

function githubAppFinding(env, exec) {
  return byId("github-app", baseFacts({ env, cli: { githubApp: probeGithubApp({ ...baseFacts().env, ...env }, exec) } }));
}

test("github-app is ok when cursor is among each owner's installations, and fails once per distinct owner when it is not", () => {
  const installed = fakeExec({ "example-org": "vercel\ncursor\n" });
  assert.deepEqual(githubAppFinding({}, installed.exec), {
    id: "github-app",
    level: "ok",
    title: "Cursor GitHub App installed on example-org",
  });
  assert.deepEqual(installed.calls, [
    ["gh", "api", "orgs/example-org/installations", "--jq", ".installations[].app_slug"],
  ]);

  const gh = fakeExec({ "cursor-demo-lab": "vercel\n", "example-org": "cursor\n" });
  const finding = githubAppFinding(
    { FACTORY_REPOS: "cursor-demo-lab/factory-sandbox, Cursor-Demo-Lab/other, example-org/demo-repo" },
    gh.exec
  );
  assert.deepEqual(finding, {
    id: "github-app",
    level: "fail",
    title: "Cursor GitHub App is not installed on cursor-demo-lab",
    detail:
      "deploys of the GitHub agents end failed: GitHub repository is not accessible through this team's installation",
    fix: "Install the Cursor GitHub App on cursor-demo-lab for the deploying team (Cursor dashboard, Integrations, GitHub), or move the sandbox to an org that has it.",
  });
  assert.deepEqual(
    gh.calls.map((call) => call[2]),
    ["orgs/cursor-demo-lab/installations", "orgs/example-org/installations"]
  );
});

test("github-app skips with the reason when gh is missing or the call fails", () => {
  const missing = fakeExec({ "example-org": execError("spawnSync gh ENOENT", { code: "ENOENT" }) });
  assert.deepEqual(githubAppFinding({}, missing.exec), {
    id: "github-app",
    level: "skip",
    title: "GitHub App check skipped for example-org",
    detail: "example-org: gh is not installed",
  });

  const notFound = fakeExec({
    "example-org": execError("Command failed: gh api", { status: 1, stderr: "gh: Not Found (HTTP 404)\n" }),
  });
  assert.deepEqual(githubAppFinding({}, notFound.exec), {
    id: "github-app",
    level: "skip",
    title: "GitHub App check skipped for example-org",
    detail: "example-org: gh: Not Found (HTTP 404)",
  });

  const scope = fakeExec({
    "example-org": execError("Command failed: gh api", {
      status: 1,
      stderr:
        'gh: This API operation needs the "admin:org" scope. To request it, run:  gh auth refresh -h github.com -s admin:org\n',
    }),
  });
  assert.equal(
    githubAppFinding({}, scope.exec).detail,
    'example-org: gh: This API operation needs the "admin:org" scope. To request it, run:  gh auth refresh -h github.com -s admin:org'
  );

  assert.deepEqual(byId("github-app", baseFacts({ cli: { githubApp: { ran: false, owners: [] } } })), {
    id: "github-app",
    level: "skip",
    title: "GitHub App check skipped",
  });
  const none = fakeExec({});
  assert.deepEqual(githubAppFinding({ FACTORY_REPOS: undefined }, none.exec), {
    id: "github-app",
    level: "skip",
    title: "GitHub App check skipped",
    detail: "FACTORY_REPOS has no owner/repo entries",
  });
  assert.deepEqual(none.calls, []);
});

test("slack-doctor", () => {
  const ok = byId("slack-doctor", baseFacts());
  assert.equal(ok.level, "ok");
  assert.equal(
    byId("slack-doctor", baseFacts({ cli: { slackDoctor: { ran: false } } })).level,
    "skip"
  );
  assertNonOk(
    byId(
      "slack-doctor",
      baseFacts({
        cli: { slackDoctor: { ran: true, ok: false, detail: "auth_test failed" } },
      })
    ),
    "fail",
    /slack doctor/
  );
});

test("validate", () => {
  const ok = byId("validate", baseFacts());
  assert.equal(ok.level, "ok");
  assert.equal(byId("validate", baseFacts({ cli: { validate: { ran: false } } })).level, "skip");
  assertNonOk(
    byId(
      "validate",
      baseFacts({
        cli: { validate: { ran: true, ok: false, detail: "error: broken" } },
      })
    ),
    "fail",
    /validate/
  );
});

test("stage: production passes, staging fails on each production target it was not told to allow", () => {
  assert.equal(byId("stage", baseFacts()).level, "ok");
  assert.equal(byId("stage", baseFacts({ env: { FACTORY_ENV: "production", FACTORY_JIRA_PROJECTS: "TLSSN" } })).level, "ok");
  const staging = { FACTORY_ENV: "staging", FACTORY_REPOS: "cursor-demo-lab/marsbank-staging", FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank-staging", FACTORY_JIRA_PROJECTS: "TLSTG", FACTORY_DESK_INTAKE_CHANNEL: "C0STAGING1" };
  assert.equal(byId("stage", baseFacts({ env: staging })).level, "ok");
  for (const [name, value] of [
    ["FACTORY_REPOS", "cursor-demo-lab/marsbank-staging, Cursor-Demo-Lab/MarsBank"],
    ["FACTORY_SANDBOX_REPO", "cursor-demo-lab/marsbank"],
    ["FACTORY_JIRA_PROJECTS", "tlssn"],
    ["FACTORY_DESK_INTAKE_CHANNEL", "C0EXAMPLE1"],
  ]) {
    assertNonOk(byId("stage", baseFacts({ env: { ...staging, [name]: value } })), "fail", new RegExp(`${name}=`));
  }
  const allowed = byId("stage", baseFacts({ env: { ...staging, FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_STAGING_ALLOW_PRODUCTION: "tlssn" } }));
  assertNonOk(allowed, "warn", /FACTORY_JIRA_PROJECTS=TLSSN/);
  assertNonOk(byId("stage", baseFacts({ env: { ...staging, FACTORY_ENV: "stagng" } })), "warn", /FACTORY_ENV to staging/);
});

test("stage: prod is production, a bare channel name is refused, and per-host overrides are checked", () => {
  assert.equal(byId("stage", baseFacts({ env: { FACTORY_ENV: "prod", FACTORY_JIRA_PROJECTS: "TLSSN" } })).level, "ok");
  const staging = { FACTORY_ENV: "staging", FACTORY_REPOS: "cursor-demo-lab/marsbank-staging", FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank-staging", FACTORY_JIRA_PROJECTS: "TLSTG", FACTORY_DESK_INTAKE_CHANNEL: "C0STAGING1" };
  for (const [name, value] of [
    ["FACTORY_DESK_INTAKE_CHANNEL", "mars-eng-intake"],
    ["FACTORY_DESK_JIRA_PROJECT", "TLSSN"],
    ["FACTORY_PLANNER_JIRA_PROJECTS", "TLSSN"],
    ["PR_AUTOFIXER_AUTO_DRIVE_PROJECTS", "tlssn"],
    ["PR_AUTOFIXER_REPOS", "cursor-demo-lab/marsbank"],
    ["SECURITY_REVIEWER_REPOS", "cursor-demo-lab/marsbank"],
  ]) {
    assertNonOk(byId("stage", baseFacts({ env: { ...staging, [name]: value } })), "fail", new RegExp(`${name}=`));
  }
  assertNonOk(byId("stage", baseFacts({ env: { ...staging, FACTORY_DESK_INTAKE_CHANNEL: "mars-eng-intake", FACTORY_STAGING_ALLOW_PRODUCTION: "#mars-eng-intake" } })), "warn", /FACTORY_DESK_INTAKE_CHANNEL=mars-eng-intake/);
});

test("ops-slack-token: unset skips, a non-bot token fails, the desk's own token warns", () => {
  assert.equal(byId("ops-slack-token", baseFacts()).level, "ok");
  assert.equal(byId("ops-slack-token", baseFacts({ env: { FACTORY_OPS_SLACK_BOT_TOKEN: undefined } })).level, "skip");
  assertNonOk(byId("ops-slack-token", baseFacts({ env: { FACTORY_OPS_SLACK_BOT_TOKEN: "xapp-ops" } })), "fail", /xoxb-/);
  assertNonOk(byId("ops-slack-token", baseFacts({ env: { FACTORY_OPS_SLACK_BOT_TOKEN: "xoxb-test" } })), "warn", /dedicated ops bot/);
});

test("PRODUCTION_TARGETS matches agent/lib/factory-stage.ts", async () => {
  const stage = await import(new URL("../factory-desk/agent/lib/factory-stage.ts", import.meta.url).href);
  assert.deepEqual(PRODUCTION_TARGETS, JSON.parse(JSON.stringify(stage.PRODUCTION_TARGETS)));
});

test("slack-app: production is not checked; staging fails on the production app's token, passes its own, and says when it could not tell", () => {
  assert.equal(byId("slack-app", baseFacts()).level, "ok");
  const staging = { FACTORY_ENV: "staging", FACTORY_REPOS: "cursor-demo-lab/marsbank-staging", FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank-staging", FACTORY_JIRA_PROJECTS: "TLSTG" };
  assertNonOk(byId("slack-app", { ...baseFacts({ env: staging }), cli: { ...baseFacts().cli, slackApp: { ran: true, appId: "A0EXAMPLE1" } } }), "fail", /wizard for factory-desk-staging/);
  assert.equal(byId("slack-app", { ...baseFacts({ env: staging }), cli: { ...baseFacts().cli, slackApp: { ran: true, appId: "A0STAGING1" } } }).level, "ok");
  assertNonOk(byId("slack-app", { ...baseFacts({ env: staging }), cli: { ...baseFacts().cli, slackApp: { ran: true, error: "auth.test: invalid_auth" } } }), "warn", /invalid_auth/);
  assert.equal(byId("slack-app", { ...baseFacts({ env: staging }), cli: { ...baseFacts().cli, slackApp: { ran: false } } }).level, "skip");
});

test("probeSlackApp asks auth.test then bots.info on staging only, with the bot token", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    asked.push([String(url).replace(/^https:\/\/slack\.com\/api\//, ""), init.headers.authorization]);
    const body = String(url).includes("auth.test") ? { ok: true, bot_id: "B0BOT", user_id: "U0BOT", team_id: "T0EXAMPLE1" } : { ok: true, bot: { app_id: "A0EXAMPLE1" } };
    return { json: async () => body };
  };
  assert.deepEqual(await probeSlackApp({ FACTORY_DESK_SLACK_BOT_TOKEN: "xoxb-1" }, fetchFn), { ran: false });
  assert.deepEqual(asked, []);
  assert.deepEqual(await probeSlackApp({ FACTORY_ENV: "staging", FACTORY_DESK_SLACK_BOT_TOKEN: "xoxb-1" }, fetchFn), { ran: true, appId: "A0EXAMPLE1", teamId: "T0EXAMPLE1", botUserId: "U0BOT" });
  assert.deepEqual(asked, [["auth.test?", "Bearer xoxb-1"], ["bots.info?bot=B0BOT", "Bearer xoxb-1"]]);
  assert.deepEqual(await probeSlackApp({ FACTORY_ENV: "staging" }, fetchFn), { ran: false });
});

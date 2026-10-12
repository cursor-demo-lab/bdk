import assert from "node:assert/strict";
import { test } from "node:test";
import { FactoryConfigError, HOST_MODEL_PARAMS, REGISTRY_MODELS, factoryModel, factoryRepos, jiraProjects, sandboxRef, sandboxRepo, sandboxReposAtBoot, statusNames, workerModel } from "./config.js";

test("factoryModel defaults to Auto: auto-smart, optimize_for balanced, and ignores effort and speed", () => {
  const variant = { id: "auto-smart", params: [{ id: "optimize_for", value: "balanced" }] };
  assert.deepEqual(factoryModel({ FACTORY_AGENT_EFFORT: "xhigh", FACTORY_AGENT_SPEED: "standard" }), variant);
  assert.deepEqual(factoryModel({}), variant);
  assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: " ", FACTORY_AGENT_EFFORT: "", FACTORY_AGENT_SPEED: " " }), variant);
});

test("factoryModel sends registry speed on grok-4.7 and catalog fast on other known ids", () => {
  assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: "grok-4.7", FACTORY_AGENT_EFFORT: "xhigh", FACTORY_AGENT_SPEED: "standard" }), {
    id: "grok-4.7",
    params: [{ id: "reasoning_effort", value: "xhigh" }, { id: "speed", value: "standard" }],
  });
  assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: " grok-4.6 ", FACTORY_AGENT_EFFORT: "xhigh" }), {
    id: "grok-4.6",
    params: [{ id: "effort", value: "xhigh" }, { id: "fast", value: "true" }],
  });
  assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: "claude-opus-5-5" }), {
    id: "claude-opus-5-5",
    params: [{ id: "context", value: "300k" }, { id: "effort", value: "low" }, { id: "fast", value: "false" }],
  });
});

test("factoryModel sends an id it has no catalog params for without params", () => {
  assert.deepEqual([...REGISTRY_MODELS], ["grok-4.7"]);
  assert.deepEqual(Object.keys(HOST_MODEL_PARAMS), ["claude-opus-5-5", "grok-4.6", "grok-4.5"]);
  assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: "claude-opus-5", FACTORY_AGENT_SPEED: "standard" }), { id: "claude-opus-5", params: [] });
});

// The launch API refused { id, params: [effort] } with "does not match a known variant".
test("workerModel defaults to a full claude-opus-5-5 catalog variant", () => {
  assert.deepEqual(workerModel({}), {
    id: "claude-opus-5-5",
    params: [
      { id: "context", value: "300k" },
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ],
  });
});

test("workerModel reads the model id and every variant parameter from the environment", () => {
  assert.deepEqual(
    workerModel({ FACTORY_WORKER_MODEL: "claude-opus-5", FACTORY_WORKER_CONTEXT: "1M", FACTORY_WORKER_EFFORT: " max ", FACTORY_WORKER_FAST: "TRUE" }),
    {
      id: "claude-opus-5",
      params: [
        { id: "context", value: "1m" },
        { id: "effort", value: "max" },
        { id: "fast", value: "true" },
      ],
    }
  );
});

test("statusNames defaults to the seven factory statuses and reads the overrides", () => {
  assert.deepEqual(statusNames({}), {
    todo: "To Do",
    triaged: "Triaged",
    planned: "Planned",
    approved: "Approved",
    inProgress: "In Progress",
    inReview: "In Review",
    done: "Done",
  });
  assert.deepEqual(
    statusNames({
      FACTORY_STATUS_TODO: "Backlog",
      FACTORY_STATUS_TRIAGED: "Sorted",
      FACTORY_STATUS_PLANNED: "Designed",
      FACTORY_STATUS_APPROVED: "Ready to build",
      FACTORY_STATUS_IN_PROGRESS: "Building",
      FACTORY_STATUS_IN_REVIEW: "Reviewing",
      FACTORY_STATUS_DONE: "Shipped",
    }),
    { todo: "Backlog", triaged: "Sorted", planned: "Designed", approved: "Ready to build", inProgress: "Building", inReview: "Reviewing", done: "Shipped" }
  );
});

test("sandboxReposAtBoot is the sandbox, or empty when it is unset", () => {
  assert.deepEqual(sandboxReposAtBoot({ FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank" }), ["cursor-demo-lab/marsbank"]);
  assert.deepEqual(sandboxReposAtBoot({ FACTORY_REPOS: "acme/one, acme/two" }), ["acme/one"]);
  assert.deepEqual(sandboxReposAtBoot({}), []);
  assert.deepEqual(sandboxReposAtBoot({ FACTORY_SANDBOX_REPO: "nope" }), []);
});

test("sandboxRepo prefers FACTORY_SANDBOX_REPO, else the first FACTORY_REPOS entry", () => {
  assert.equal(sandboxRepo({ FACTORY_SANDBOX_REPO: "acme/sandbox", FACTORY_REPOS: "acme/one" }), "acme/sandbox");
  assert.equal(sandboxRepo({ FACTORY_REPOS: "acme/one, acme/two" }), "acme/one");
  assert.throws(
    () => sandboxRepo({}),
    (error: unknown) => error instanceof FactoryConfigError && /FACTORY_SANDBOX_REPO/.test(error.message) && /FACTORY_REPOS/.test(error.message)
  );
  assert.throws(
    () => sandboxRepo({ FACTORY_SANDBOX_REPO: "nope", FACTORY_REPOS: "acme/one" }),
    (error: unknown) => error instanceof FactoryConfigError && /FACTORY_SANDBOX_REPO/.test(error.message)
  );
});

test("factoryRepos dedupes case-insensitively and rejects an empty list", () => {
  assert.deepEqual(factoryRepos({ FACTORY_REPOS: " acme/one, Acme/One, other/repo " }), ["acme/one", "other/repo"]);
  assert.throws(() => factoryRepos({}), (error: unknown) => error instanceof FactoryConfigError && /FACTORY_REPOS/.test(error.message));
});

test("sandboxRef defaults to main", () => {
  assert.equal(sandboxRef({}), "main");
  assert.equal(sandboxRef({ FACTORY_SANDBOX_REF: "  release " }), "release");
});

test("jiraProjects uppercases, dedupes, drops invalid keys, and stays empty when unset", () => {
  assert.deepEqual(jiraProjects({}), []);
  assert.deepEqual(jiraProjects({ FACTORY_JIRA_PROJECTS: " tlssn, demo, tlssn, nope-1, " }), ["TLSSN", "DEMO"]);
  assert.deepEqual(jiraProjects({ FACTORY_JIRA_PROJECTS: "not a key" }), []);
});

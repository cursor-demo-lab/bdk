import assert from "node:assert/strict";
import { test } from "node:test";
import { FactoryConfigError, HOST_MODEL_PARAMS, REGISTRY_MODELS, factoryModel, factoryRepos, jiraProjects } from "./config.js";

const OVERRIDE = "PROJECT_REPOS";

test("factoryRepos reads the override, then FACTORY_REPOS, and rejects an empty list", () => {
  assert.deepEqual(factoryRepos({ FACTORY_REPOS: " acme/one, acme/two " }), ["acme/one", "acme/two"]);
  assert.deepEqual(factoryRepos({ [OVERRIDE]: " acme/one, Acme/One, Other/Repo ", FACTORY_REPOS: "ignored/repo" }, OVERRIDE), ["acme/one", "Other/Repo"]);
  assert.throws(
    () => factoryRepos({}, OVERRIDE),
    (error: unknown) => error instanceof FactoryConfigError && /PROJECT_REPOS/.test(error.message) && /FACTORY_REPOS/.test(error.message)
  );
  assert.throws(
    () => factoryRepos({ [OVERRIDE]: "", FACTORY_REPOS: "acme/one" }, OVERRIDE),
    (error: unknown) => error instanceof FactoryConfigError && /PROJECT_REPOS/.test(error.message) && /FACTORY_REPOS/.test(error.message)
  );
  assert.throws(
    () => factoryRepos({ [OVERRIDE]: "acme/one, not a repo" }, OVERRIDE),
    (error: unknown) => error instanceof FactoryConfigError && /not a repo/.test(error.message) && /FACTORY_REPOS/.test(error.message)
  );
});

test("jiraProjects uppercases, dedupes, drops invalid keys, and stays empty when unset", () => {
  assert.deepEqual(jiraProjects({}), []);
  assert.deepEqual(jiraProjects({ FACTORY_JIRA_PROJECTS: " tlssn, demo, tlssn, nope-1, " }), ["TLSSN", "DEMO"]);
  assert.deepEqual(jiraProjects({ PROJECT_JIRA: "abc", FACTORY_JIRA_PROJECTS: "tlssn" }, "PROJECT_JIRA"), ["ABC"]);
  assert.deepEqual(jiraProjects({ PROJECT_JIRA: "", FACTORY_JIRA_PROJECTS: "tlssn" }, "PROJECT_JIRA"), []);
  assert.deepEqual(jiraProjects({ FACTORY_JIRA_PROJECTS: "not a key" }), []);
});

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

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_SETTLE_MS, HOST_MODEL_PARAMS, REGISTRY_MODELS, claimSettleMs, deskSlackHandle, factoryModel, jiraProjects, reviewRepos, statusNames } from "./config.js";

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

test("statusNames defaults to the factory workflow and reads FACTORY_STATUS_*", () => {
  assert.deepEqual(statusNames({}), { todo: "To Do", triaged: "Triaged", planned: "Planned", approved: "Approved", inProgress: "In Progress", inReview: "In Review", done: "Done" });
  assert.deepEqual(
    statusNames({
      FACTORY_STATUS_TODO: "Open",
      FACTORY_STATUS_TRIAGED: "Ready to plan",
      FACTORY_STATUS_PLANNED: "Plan ready",
      FACTORY_STATUS_APPROVED: "Go",
      FACTORY_STATUS_IN_PROGRESS: "Building",
      FACTORY_STATUS_IN_REVIEW: "PR open",
      FACTORY_STATUS_DONE: "Merged",
    }),
    { todo: "Open", triaged: "Ready to plan", planned: "Plan ready", approved: "Go", inProgress: "Building", inReview: "PR open", done: "Merged" }
  );
});

test("claimSettleMs defaults to two seconds; FACTORY_DESK_CLAIM_SETTLE_MS sets 0 to 10000 ms and anything else keeps the default", () => {
  assert.equal(CLAIM_SETTLE_MS, 2000);
  assert.equal(claimSettleMs({}), 2000);
  assert.equal(claimSettleMs({ FACTORY_DESK_CLAIM_SETTLE_MS: " 0 " }), 0);
  assert.equal(claimSettleMs({ FACTORY_DESK_CLAIM_SETTLE_MS: "750" }), 750);
  assert.equal(claimSettleMs({ FACTORY_DESK_CLAIM_SETTLE_MS: "10000" }), 10_000);
  for (const raw of ["", "-5", "1.5", "2s", "10001"]) assert.equal(claimSettleMs({ FACTORY_DESK_CLAIM_SETTLE_MS: raw }), 2000, raw);
});

test("deskSlackHandle defaults to @factory and reads FACTORY_DESK_SLACK_HANDLE", () => {
  assert.equal(deskSlackHandle({}), "@factory");
  assert.equal(deskSlackHandle({ FACTORY_DESK_SLACK_HANDLE: " " }), "@factory");
  assert.equal(deskSlackHandle({ FACTORY_DESK_SLACK_HANDLE: "@factory-desk" }), "@factory-desk");
  assert.equal(deskSlackHandle({ FACTORY_DESK_SLACK_HANDLE: "factory-bot" }), "@factory-bot");
});

test("jiraProjects uppercases, dedupes, drops invalid keys, and stays empty when unset", () => {
  assert.deepEqual(jiraProjects({}), []);
  assert.deepEqual(jiraProjects({ FACTORY_JIRA_PROJECTS: " tlssn, demo, tlssn, nope-1, " }), ["TLSSN", "DEMO"]);
  assert.deepEqual(jiraProjects({ PROJECT_JIRA: "abc", FACTORY_JIRA_PROJECTS: "tlssn" }, "PROJECT_JIRA"), ["ABC"]);
  assert.deepEqual(jiraProjects({ PROJECT_JIRA: "", FACTORY_JIRA_PROJECTS: "tlssn" }, "PROJECT_JIRA"), []);
  assert.deepEqual(jiraProjects({ FACTORY_JIRA_PROJECTS: "not a key" }), []);
});

test("reviewRepos reads FACTORY_REPOS, drops what is not owner/repo, and never throws", () => {
  assert.deepEqual(reviewRepos({}), []);
  assert.deepEqual(reviewRepos({ FACTORY_REPOS: " cursor-demo-lab/marsbank, not-a-repo, Cursor-Demo-Lab/Marsbank ,acme/w.idgets" }), ["cursor-demo-lab/marsbank", "acme/w.idgets"]);
});

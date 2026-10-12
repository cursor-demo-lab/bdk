import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_MODEL_PARAMS, REGISTRY_MODELS, factoryModel, pastTodoStatuses, statusNames } from "./config.js";

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

test("statusNames defaults to the factory's seven statuses and reads FACTORY_STATUS_*", () => {
  assert.deepEqual(statusNames({}), { todo: "To Do", triaged: "Triaged", planned: "Planned", approved: "Approved", inProgress: "In Progress", inReview: "In Review", done: "Done" });
  assert.deepEqual(
    statusNames({
      FACTORY_STATUS_TODO: "Open",
      FACTORY_STATUS_TRIAGED: "Ready to plan",
      FACTORY_STATUS_PLANNED: "Awaiting approval",
      FACTORY_STATUS_APPROVED: "Go",
      FACTORY_STATUS_IN_PROGRESS: "Building",
      FACTORY_STATUS_IN_REVIEW: "Reviewing",
      FACTORY_STATUS_DONE: "Shipped",
    }),
    { todo: "Open", triaged: "Ready to plan", planned: "Awaiting approval", approved: "Go", inProgress: "Building", inReview: "Reviewing", done: "Shipped" }
  );
});

test("pastTodoStatuses is every status after To Do, overrides included", () => {
  assert.deepEqual(pastTodoStatuses({}), ["Triaged", "Planned", "Approved", "In Progress", "In Review", "Done"]);
  assert.deepEqual(pastTodoStatuses({ FACTORY_STATUS_TODO: "Open", FACTORY_STATUS_IN_PROGRESS: "Building", FACTORY_STATUS_DONE: "Shipped" }), ["Triaged", "Planned", "Approved", "Building", "In Review", "Shipped"]);
});

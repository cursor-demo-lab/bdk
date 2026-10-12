import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { CLOUD_AGENT } from "./e2e-lib.mjs";

register("./ts-resolve.mjs", import.meta.url);

// Catalog models (GET /v1/models, recorded in fixtures/model-catalog.json)
// must be sent as one exact variant. grok-4.7 is a registry model: hosted
// turns reject catalog-only params such as `context` with
// "Invalid parameters for registry model". Re-record the fixture when the
// catalog changes. Live GET https://api.cursor.com/v1/models needs a user
// API key; this fixture was last recorded 2026-09-23.

const ROOT = new URL("../", import.meta.url);
const PROJECTS = ["factory-desk", "planner", "factory-worker", "triage-jira", "pr-autofixer", "security-reviewer"];
const CATALOG_IDS = ["grok-4.6", "grok-4.5", "claude-opus-5-5"];
const DEFAULT = { id: "auto-smart", params: [{ id: "optimize_for", value: "balanced" }] };
const REGISTRY_OVERRIDE = {
  id: "grok-4.7",
  params: [
    { id: "reasoning_effort", value: "high" },
    { id: "speed", value: "fast" },
  ],
};

const catalog = JSON.parse(readFileSync(new URL("fixtures/model-catalog.json", import.meta.url), "utf8"));
const byId = new Map(catalog.models.map((model) => [model.id, model]));

async function config(project) {
  return import(new URL(`${project}/agent/lib/config.ts`, ROOT).href);
}

function asMap(model) {
  const params = {};
  for (const param of model.params ?? []) {
    assert.equal(params[param.id], undefined, `${model.id} sends ${param.id} twice`);
    params[param.id] = param.value;
  }
  return params;
}

function sameParams(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Fails unless the model names a catalog id and its params are exactly one of that id's variants. */
function assertVariant(model, where) {
  const entry = byId.get(model.id);
  assert.ok(entry !== undefined, `${where}: ${model.id} is not in the catalog`);
  const sent = asMap(model);
  for (const name of Object.keys(sent)) {
    assert.ok(Object.hasOwn(entry.parameters, name), `${where}: ${model.id} has no param ${name}; the catalog offers ${Object.keys(entry.parameters).join(", ")}`);
  }
  assert.ok(entry.variants.some((variant) => sameParams(variant, sent)), `${where}: ${JSON.stringify(sent)} is not a ${model.id} variant`);
}

test("the recorded catalog lists the factory's models; its grok-4.7 row has context, which registry turns must not send, and no speed", () => {
  for (const id of ["grok-4.7", "auto-smart", ...CATALOG_IDS]) assert.ok(byId.has(id), id);
  assert.deepEqual(Object.keys(byId.get("grok-4.7").parameters), ["context", "reasoning_effort", "fast"]);
  assert.ok(byId.get("grok-4.7").parameters.context.includes("500k"));
});

for (const project of PROJECTS) {
  test(`${project}: the default host model is Auto (auto-smart, optimize_for balanced), a catalog variant`, async () => {
    const { factoryModel } = await config(project);
    assert.deepEqual(factoryModel({}), DEFAULT);
    assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: " ", FACTORY_AGENT_EFFORT: "", FACTORY_AGENT_SPEED: " " }), DEFAULT);
    assertVariant(factoryModel({}), `${project} default`);
  });

  test(`${project}: a grok-4.7 override is the registry encoding, never catalog context or fast`, async () => {
    const { factoryModel, REGISTRY_MODELS } = await config(project);
    assert.deepEqual([...REGISTRY_MODELS], ["grok-4.7"]);
    assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: "grok-4.7" }), REGISTRY_OVERRIDE);
    const sent = asMap(factoryModel({ FACTORY_AGENT_MODEL: "grok-4.7" }));
    assert.equal(sent.context, undefined, `${project} grok-4.7 must not send catalog-only context`);
    assert.equal(sent.fast, undefined, `${project} grok-4.7 must send registry speed, not catalog fast`);
  });

  test(`${project}: every effort the catalog offers, fast or not, is one catalog variant for each catalog model`, async () => {
    const module = await config(project);
    const ids = new Set([...CATALOG_IDS, ...Object.keys(module.HOST_MODEL_PARAMS ?? {})]);
    for (const id of ids) {
      const entry = byId.get(id);
      assert.ok(entry !== undefined, `${project}: ${id} is not in the catalog`);
      const efforts = entry.parameters.reasoning_effort ?? entry.parameters.effort;
      for (const effort of efforts) {
        for (const speed of ["fast", "standard"]) {
          assertVariant(module.factoryModel({ FACTORY_AGENT_MODEL: id, FACTORY_AGENT_EFFORT: effort, FACTORY_AGENT_SPEED: speed }), `${project} ${id} ${effort} ${speed}`);
        }
      }
    }
  });

  test(`${project}: a model id the factory does not know is sent without params`, async () => {
    const { factoryModel } = await config(project);
    assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: "claude-opus-5", FACTORY_AGENT_EFFORT: "xhigh", FACTORY_AGENT_SPEED: "fast" }), { id: "claude-opus-5", params: [] });
  });
}

const LIGHT = { id: "grok-4.6", params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] };

for (const project of PROJECTS) {
  test(`${project}: LIGHT_MODEL is grok-4.6 fast, one catalog variant, and FACTORY_AGENT_* override it exactly as they override Auto`, async () => {
    const { factoryModel } = await config(project);
    const { LIGHT_MODEL } = await import(new URL(`${project}/agent/lib/factory-model.ts`, ROOT).href);
    assert.equal(LIGHT_MODEL, "grok-4.6");
    assert.deepEqual(factoryModel({}, LIGHT_MODEL), LIGHT);
    assert.deepEqual(factoryModel({ FACTORY_AGENT_MODEL: " ", FACTORY_AGENT_EFFORT: "", FACTORY_AGENT_SPEED: " " }, LIGHT_MODEL), LIGHT);
    assertVariant(factoryModel({}, LIGHT_MODEL), `${project} light default`);
    assertVariant(factoryModel({ FACTORY_AGENT_EFFORT: "low", FACTORY_AGENT_SPEED: "standard" }, LIGHT_MODEL), `${project} light low standard`);
    for (const env of [{ FACTORY_AGENT_MODEL: "auto-smart" }, { FACTORY_AGENT_MODEL: "grok-4.7" }, { FACTORY_AGENT_MODEL: "claude-opus-5-5" }, { FACTORY_AGENT_MODEL: "unknown-model", FACTORY_AGENT_EFFORT: "max" }]) {
      assert.deepEqual(factoryModel(env, LIGHT_MODEL), factoryModel(env), `${project} ${JSON.stringify(env)}`);
    }
  });
}

// The worker's one model turn is the implement agent, run as a July cloud
// turn of the worker itself; a live send may carry no modelConfig (0.2.18
// model-config.js), so its root model is the implement model, workerModel
// (docs/deployment-issues.md issue 27).
const MODEL_ENV = ["FACTORY_AGENT_MODEL", "FACTORY_AGENT_EFFORT", "FACTORY_AGENT_SPEED", "FACTORY_WORKER_MODEL", "FACTORY_WORKER_CONTEXT", "FACTORY_WORKER_EFFORT", "FACTORY_WORKER_FAST"];

async function withDefaultModelEnv(run) {
  const saved = Object.fromEntries(MODEL_ENV.map((name) => [name, process.env[name]]));
  for (const name of MODEL_ENV) delete process.env[name];
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  }
}

test("the root model: factory-desk (every turn) and triage-jira (its fallback triage turn) run grok-4.6 fast; factory-worker runs its implement model; the other three stay on Auto balanced", async () => {
  await withDefaultModelEnv(async () => {
    const { workerModel } = await config("factory-worker");
    for (const project of PROJECTS) {
      const { default: agent } = await import(new URL(`${project}/agent/agent.ts`, ROOT).href);
      const light = project === "factory-desk" || project === "triage-jira";
      const expected = project === "factory-worker" ? workerModel({}) : light ? LIGHT : DEFAULT;
      assert.deepEqual(agent.model, expected, project);
      assertVariant(agent.model, `${project} root model`);
    }
  });
});

test("the six agents send the same host model for the same settings", async () => {
  const settings = [{}, { FACTORY_AGENT_MODEL: "grok-4.6", FACTORY_AGENT_EFFORT: "xhigh", FACTORY_AGENT_SPEED: "standard" }];
  for (const env of settings) {
    const models = await Promise.all(PROJECTS.map(async (project) => (await config(project)).factoryModel(env)));
    for (const model of models) assert.deepEqual(model, models[0]);
  }
});

test("every cloud agent launch model is one catalog variant: the worker's, default and overridden, and the e2e driver's", async () => {
  const { workerModel } = await config("factory-worker");
  assertVariant(workerModel({}), "workerModel default");
  assertVariant(workerModel({ FACTORY_WORKER_CONTEXT: "1M", FACTORY_WORKER_EFFORT: "Max", FACTORY_WORKER_FAST: "true" }), "workerModel override");
  assertVariant(CLOUD_AGENT.model, "e2e-lib CLOUD_AGENT");
});

test("every host pins architecture v2 and lists two catalog-variant fallbacks that differ from its root model", async () => {
  await withDefaultModelEnv(async () => {
    for (const project of PROJECTS) {
      const { default: agent } = await import(new URL(`${project}/agent/agent.ts`, ROOT).href);
      assert.equal(agent.architecture, "v2", project);
      assert.equal(agent.fallbacks.length, 2, project);
      const light = project === "factory-desk" || project === "triage-jira";
      const expected = project === "factory-worker" ? ["grok-4.6", "auto-smart"] : light ? ["auto-smart", "claude-opus-5-5"] : ["grok-4.6", "claude-opus-5-5"];
      assert.deepEqual(agent.fallbacks.map((model) => model.id), expected, project);
      for (const model of agent.fallbacks) {
        assert.notEqual(model.id, agent.model.id, project);
        assertVariant(model, `${project} fallback ${model.id}`);
      }
    }
  });
});

test("fallbacks ignore FACTORY_AGENT_* and skip an overridden root model's id", async () => {
  for (const project of PROJECTS) {
    const { factoryFallbacks, factoryModel } = await config(project);
    const primary = factoryModel({ FACTORY_AGENT_MODEL: "claude-opus-5-5" });
    assert.deepEqual(factoryFallbacks(primary).map((model) => model.id), ["grok-4.6", "auto-smart"], project);
    assert.deepEqual(factoryFallbacks(factoryModel({ FACTORY_AGENT_MODEL: "grok-4.7" })).map((model) => model.id), ["grok-4.6", "auto-smart"], project);
  }
});

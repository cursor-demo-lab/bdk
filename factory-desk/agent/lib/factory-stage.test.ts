import assert from "node:assert/strict";
import { test } from "node:test";
import { factoryStage, PRODUCTION_TARGETS, refusesProductionTarget, stagingRefusal, withoutProductionTargets } from "./factory-stage.js";

test("unset, empty, and production are production; any other FACTORY_ENV is staging", () => {
  assert.equal(factoryStage({}), "production");
  assert.equal(factoryStage({ FACTORY_ENV: " " }), "production");
  assert.equal(factoryStage({ FACTORY_ENV: " Production " }), "production");
  assert.equal(factoryStage({ FACTORY_ENV: "prod" }), "production", "prod is production, so following the deploy warning with prod cannot stage a live slug");
  assert.equal(factoryStage({ FACTORY_ENV: "staging" }), "staging");
  assert.equal(factoryStage({ FACTORY_ENV: "stagng" }), "staging");
});

test("production refuses nothing, even with an allow list", () => {
  for (const [kind, values] of Object.entries(PRODUCTION_TARGETS)) {
    for (const value of values) {
      assert.equal(refusesProductionTarget({}, { kind: kind as keyof typeof PRODUCTION_TARGETS, value }), false);
    }
  }
  assert.deepEqual(withoutProductionTargets({ FACTORY_ENV: "production" }, { kind: "repos", values: ["cursor-demo-lab/marsbank", "acme/one"] }), ["cursor-demo-lab/marsbank", "acme/one"]);
});

test("staging refuses each production target, case-insensitively, and nothing else", () => {
  const env = { FACTORY_ENV: "staging" };
  assert.equal(refusesProductionTarget(env, { kind: "repos", value: " Cursor-Demo-Lab/MarsBank " }), true);
  assert.equal(refusesProductionTarget(env, { kind: "jiraProjects", value: "tlssn" }), true);
  assert.equal(refusesProductionTarget(env, { kind: "slackChannels", value: "C0EXAMPLE1" }), true);
  assert.equal(refusesProductionTarget(env, { kind: "slackChannels", value: "#mars-eng-intake" }), true);
  assert.equal(refusesProductionTarget(env, { kind: "slackApps", value: "A0EXAMPLE1" }), true);
  assert.equal(refusesProductionTarget(env, { kind: "slackApps", value: "A0STAGING1" }), false);
  assert.equal(refusesProductionTarget(env, { kind: "repos", value: "cursor-demo-lab/marsbank-staging" }), false);
  assert.equal(refusesProductionTarget(env, { kind: "jiraProjects", value: "TLSTG" }), false);
  assert.equal(refusesProductionTarget(env, { kind: "jiraProjects", value: "cursor-demo-lab/marsbank" }), false, "a value is a production target only for its own kind");
  assert.deepEqual(withoutProductionTargets(env, { kind: "jiraProjects", values: ["TLSSN", "TLSTG"] }), ["TLSTG"]);
});

test("FACTORY_STAGING_ALLOW_PRODUCTION lets a staging slug use exactly the targets it names", () => {
  const env = { FACTORY_ENV: "staging", FACTORY_STAGING_ALLOW_PRODUCTION: " tlssn , C0EXAMPLE1 ,," };
  assert.equal(refusesProductionTarget(env, { kind: "jiraProjects", value: "TLSSN" }), false);
  assert.equal(refusesProductionTarget(env, { kind: "slackChannels", value: "C0EXAMPLE1" }), false);
  assert.equal(refusesProductionTarget(env, { kind: "slackChannels", value: "#mars-eng-intake" }), true);
  assert.equal(refusesProductionTarget(env, { kind: "repos", value: "cursor-demo-lab/marsbank" }), true);
});

test("the refusal names the value and both switches", () => {
  const line = stagingRefusal("TLSSN");
  assert.match(line, /TLSSN/);
  assert.match(line, /FACTORY_ENV/);
  assert.match(line, /FACTORY_STAGING_ALLOW_PRODUCTION/);
});

test("a channel name matches with or without its leading #, in the target and in the allow list", () => {
  const env = { FACTORY_ENV: "staging" };
  assert.equal(refusesProductionTarget(env, { kind: "slackChannels", value: "mars-eng-intake" }), true);
  assert.equal(refusesProductionTarget(env, { kind: "slackChannels", value: " #Mars-Eng-Intake " }), true);
  assert.equal(refusesProductionTarget({ ...env, FACTORY_STAGING_ALLOW_PRODUCTION: "mars-eng-intake" }, { kind: "slackChannels", value: "#mars-eng-intake" }), false);
  assert.equal(refusesProductionTarget({ ...env, FACTORY_STAGING_ALLOW_PRODUCTION: "#mars-eng-intake" }, { kind: "slackChannels", value: "mars-eng-intake" }), false);
});

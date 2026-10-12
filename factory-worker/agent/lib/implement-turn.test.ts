import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SendMessageOptions } from "@cursor/july";
import { mergeCloudOptions, resolveSessionRuntime } from "../../node_modules/@cursor/july/dist/internal/cloud-merge.js";
import { InvalidModelConfigError, MODEL_CONFIG_REQUIRES_DRY_RUN, modelConfigForDryRun } from "../../node_modules/@cursor/july/dist/internal/model-config.js";
import { toModelSelection } from "../../node_modules/@cursor/july/dist/internal/sdk-runner.js";
import agent from "../agent.js";
import { IMPLEMENT_MODEL, workerModel } from "./config.js";
import {
  implementContinuation,
  implementIssueKey,
  implementSendOptions,
  MANAGED_HOSTING_ENV,
  parseImplementState,
  startImplementTurn,
  type ImplementSessionState,
  type ImplementTurnInput,
} from "./implement-turn.js";
import { LaunchNotStartedError } from "./launch.js";
import { BRIEF } from "./testing/fakes.js";

const STATE: ImplementSessionState = { kind: "implement", issueKey: "TLSSN-42", changelogId: "10042", title: "Retry CSV export on empty filter", at: "2026-09-23T00:00:00.000Z", owner: "owner-1", retried: false };

const INPUT: ImplementTurnInput = {
  issueKey: "TLSSN-42",
  changelogId: "10042",
  title: "Retry CSV export on empty filter",
  brief: BRIEF,
  repo: "example-org/demo-repo",
  ref: "main",
  state: STATE,
};

function fakeSend(options: { fail?: Error } = {}) {
  const calls: Array<{ message: string; options: SendMessageOptions }> = [];
  const send = async (message: string, sendOptions: SendMessageOptions) => {
    calls.push({ message, options: sendOptions });
    if (options.fail !== undefined) throw options.fail;
    return { id: "ses_1", isNew: true, continuationToken: "tok" };
  };
  return { send, calls };
}

test("the continuation names the approval: one session per move to Approved, and the key reads back from it", () => {
  assert.equal(implementContinuation({ issueKey: "TLSSN-42", changelogId: "10042" }), "implement:TLSSN-42#10042");
  assert.notEqual(implementContinuation({ issueKey: "TLSSN-42", changelogId: "10042" }), implementContinuation({ issueKey: "TLSSN-42", changelogId: "10077" }));
  assert.equal(implementIssueKey("implement:TLSSN-42#10042"), "TLSSN-42");
  // Hosted v2 prefixes the mailbox key; a direct chat, an eval, or a token of another shape is no implement session.
  assert.equal(implementIssueKey("cont:implement:TLSSN-42#10042"), "TLSSN-42");
  assert.equal(implementIssueKey("implement:TLSSN-42"), "TLSSN-42");
  assert.equal(implementIssueKey("implement:not a key#1"), undefined);
  assert.equal(implementIssueKey("pr:acme/shop#43"), undefined);
  assert.equal(implementIssueKey("cont:session:ses_1"), undefined);
  assert.equal(implementIssueKey(null), undefined);
  assert.equal(implementIssueKey(undefined), undefined);
});

test("the session state round-trips through JSON and anything else is not an implement launch", () => {
  assert.deepEqual(parseImplementState(JSON.parse(JSON.stringify(STATE))), STATE);
  assert.deepEqual(parseImplementState({ ...STATE, title: undefined, retried: "yes" }), { ...STATE, title: "TLSSN-42", retried: false });
  assert.deepEqual(parseImplementState({ ...STATE, takenOverAt: "2026-09-22T23:50:00.000Z" }), { ...STATE, takenOverAt: "2026-09-22T23:50:00.000Z" });
  assert.deepEqual(parseImplementState({ ...STATE, takenOverAt: "" }), STATE, "an empty takenOverAt is none");
  for (const other of [null, undefined, "implement", [], {}, { kind: "drive" }, { ...STATE, owner: "" }, { ...STATE, at: undefined }, { ...STATE, changelogId: 10042 }]) {
    assert.equal(parseImplementState(other), undefined, JSON.stringify(other));
  }
});

test("one send carries the approval's continuation, the agent name as title, the state, and the sandbox as a per-send cloud attach with auto PR off, and no model", () => {
  const options = implementSendOptions(INPUT);
  assert.deepEqual(options, {
    continuationToken: "implement:TLSSN-42#10042",
    title: "factory TLSSN-42: Retry CSV export on empty filter",
    state: STATE,
    cloud: { repos: [{ url: "https://github.com/example-org/demo-repo", startingRef: "main" }], autoCreatePR: false },
  });
  assert.equal("modelConfig" in options, false);
});

// TLSSN-60 (docs/deployment-issues.md issue 27): the send carried
// `modelConfig`, which July 0.2.18 accepts on a dry run only. The throw came
// in hosted execution, after admission had answered `turn_sent`, so no
// session existed for `turn.failed` and the claim waited for the heal.
test("July pin: the live send passes July's own send validation, which rejects any modelConfig that is not a dry run", () => {
  const sessionEngine = readFileSync(new URL("../../node_modules/@cursor/july/dist/internal/session-engine.js", import.meta.url), "utf8");
  assert.ok(sessionEngine.includes("modelConfig: modelConfigForDryRun(sendOptions.modelConfig, sendOptions.dryRun)"), "session-engine.js send no longer validates modelConfig this way; re-pin");
  const options = implementSendOptions(INPUT);
  assert.equal(modelConfigForDryRun(options.modelConfig, options.dryRun), undefined);
  // What main sent before the fix, through the same gate.
  assert.throws(
    () => modelConfigForDryRun({ model: workerModel({}) }, options.dryRun),
    (error: unknown) => error instanceof InvalidModelConfigError && error.message === MODEL_CONFIG_REQUIRES_DRY_RUN
  );
  // And even on a dry run, the implement variant's `context` param is not one modelConfig admits.
  assert.throws(() => modelConfigForDryRun({ model: workerModel({}) }, true), InvalidModelConfigError);
});

test("the live turn's model is agent.ts's, so agent.ts carries the implement model, the same constant the heal's Agent.create sends", () => {
  assert.deepEqual(agent.model, IMPLEMENT_MODEL);
  assert.deepEqual(IMPLEMENT_MODEL, workerModel(process.env));
  const overridden = ["FACTORY_WORKER_MODEL", "FACTORY_WORKER_CONTEXT", "FACTORY_WORKER_EFFORT", "FACTORY_WORKER_FAST"].filter((name) => process.env[name] !== undefined);
  if (overridden.length === 0) {
    assert.deepEqual(agent.model, {
      id: "claude-opus-5-5",
      params: [
        { id: "context", value: "300k" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    });
  }
  // sdk-runner.js hands the authored selection to the SDK unchanged, as launch.ts's `model: input.model` does.
  assert.deepEqual(toModelSelection(agent.model!), IMPLEMENT_MODEL);
  assert.ok(Array.isArray(agent.fallbacks) && agent.fallbacks.every((fallback) => typeof fallback !== "string" && fallback.id !== IMPLEMENT_MODEL.id));
});

test("FACTORY_WORKER_* are not hosted secrets: hosted v2 binds secrets after agent.ts loads, which a load-time model cannot see", () => {
  const names = agent.hosting?.secretNames ?? [];
  for (const name of ["FACTORY_WORKER_MODEL", "FACTORY_WORKER_CONTEXT", "FACTORY_WORKER_EFFORT", "FACTORY_WORKER_FAST"]) {
    assert.ok(!names.includes(name), `${name} must not be a hosted secret`);
  }
});

test("July pin: the per-send attach turns a local agent's session into a cloud turn and its repos win the merge over agent.ts", () => {
  const options = implementSendOptions(INPUT);
  assert.equal(resolveSessionRuntime({ agentRuntime: "local", cloudOverride: options.cloud }), "cloud");
  const merged = mergeCloudOptions({ base: { autoCreatePR: false }, override: options.cloud });
  assert.deepEqual(merged, { autoCreatePR: false, repos: [{ url: "https://github.com/example-org/demo-repo", startingRef: "main" }] });
});

test("startImplementTurn sends the brief with the PR handoff once, with those options", async () => {
  const { send, calls } = fakeSend();
  await startImplementTurn(send, INPUT);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.message.startsWith(`${BRIEF}\n\n## Handing off the change`));
  assert.ok(calls[0]!.message.includes("Do not open a pull request yourself"));
  assert.deepEqual(calls[0]!.options, implementSendOptions(INPUT));
});

test("a send July refuses is a LaunchNotStartedError with the failure's reason, as a refused create is", async () => {
  const refused = fakeSend({ fail: Object.assign(new Error("[invalid_model] Model 'x' does not match a known variant"), { code: "invalid_model", status: 400 }) });
  await assert.rejects(startImplementTurn(refused.send, INPUT), (error: unknown) => {
    assert.ok(error instanceof LaunchNotStartedError);
    assert.equal(error.reason, "invalid_model");
    assert.equal(error.message, "factory-worker: launch did not start: [invalid_model] Model 'x' does not match a known variant");
    return true;
  });
  const down = fakeSend({ fail: new Error("fetch failed") });
  await assert.rejects(startImplementTurn(down.send, INPUT), (error: unknown) => error instanceof LaunchNotStartedError && error.reason === "service_unavailable");
});

test("a staging slug never sends an implement turn against the production repository", async (t) => {
  const saved = { env: process.env.FACTORY_ENV, allow: process.env.FACTORY_STAGING_ALLOW_PRODUCTION };
  process.env.FACTORY_ENV = "staging";
  delete process.env.FACTORY_STAGING_ALLOW_PRODUCTION;
  t.after(() => {
    if (saved.env === undefined) delete process.env.FACTORY_ENV;
    else process.env.FACTORY_ENV = saved.env;
    if (saved.allow !== undefined) process.env.FACTORY_STAGING_ALLOW_PRODUCTION = saved.allow;
  });
  const { send, calls } = fakeSend();
  await assert.rejects(startImplementTurn(send, { ...INPUT, repo: "cursor-demo-lab/marsbank" }), (error: unknown) => error instanceof LaunchNotStartedError && error.reason === "staging_refuses_production");
  assert.equal(calls.length, 0);
});

test("the hosted-posture variable is the one July itself reads", () => {
  assert.equal(MANAGED_HOSTING_ENV, "AGENT_SERVE_GENERATION");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError, NetworkError } from "@cursor/sdk";
import { approvedBody } from "./fixtures.js";
import { createHandler } from "./handle.js";
import { agentName, implementPrompt, LAUNCH_TIMEOUT_MS, launchFailureReason, LaunchNotStartedError, launchImplementation, prHandoff, wordPrefix, type CreateAgent } from "./launch.js";
import { backgroundWork, ENV, fakeCreateAgent, fakeTracker, memoryKv, PLAN_COMMENT, signedRequest, TRIAGE_COMMENT } from "./testing/fakes.js";

const INPUT = {
  issueKey: "TLSSN-42",
  title: "Retry CSV export on empty filter",
  brief: "Return an empty file when the filter matches no rows.",
  model: { id: "claude-opus-5-5", params: [{ id: "context", value: "300k" }, { id: "effort", value: "high" }, { id: "fast", value: "false" }] },
  repo: "example-org/demo-repo",
  ref: "main",
  idempotencyKey: "implement/TLSSN-42",
};

test("one cloud agent on the sandbox, keyed by the claim, prompted with the brief", async () => {
  const launcher = fakeCreateAgent({ agentId: "bc-abc" });
  const launched = await launchImplementation({ createAgent: launcher.createAgent }, INPUT);
  assert.deepEqual(launched, { agentId: "bc-abc", url: "https://cursor.com/agents/bc-abc" });
  assert.deepEqual(launcher.calls, [
    {
      name: "factory TLSSN-42: Retry CSV export on empty filter",
      idempotencyKey: "implement/TLSSN-42",
      model: { id: "claude-opus-5-5", params: [{ id: "context", value: "300k" }, { id: "effort", value: "high" }, { id: "fast", value: "false" }] },
      cloud: {
        repos: [{ url: "https://github.com/example-org/demo-repo", startingRef: "main" }],
        autoCreatePR: false,
      },
    },
  ]);
  assert.deepEqual(launcher.sent, [implementPrompt(INPUT)]);
  assert.ok(launcher.sent[0]?.startsWith("Return an empty file when the filter matches no rows.\n\n## Handing off the change"));
  assert.equal(launcher.closed, 1);
});

test("TLSSN-35: the handoff keeps the key-prefixed branch and tells the agent not to open the PR, since the worker opens it", () => {
  const handoff = prHandoff(INPUT);
  assert.match(handoff, /push it to a branch on example-org\/demo-repo, based on `main`, whose name starts with `TLSSN-42`/);
  assert.match(handoff, /Do not open a pull request yourself, with a tool or with `gh`, even where the brief above asks for one/);
  assert.match(handoff, /factory-worker opens it from your branch, ready for review/);
  assert.match(handoff, /final message becomes that pull request's description/);
  assert.match(handoff, /Do not merge/);
  assert.doesNotMatch(handoff, /ManagePullRequest|gh pr create|draft: false/, "no instruction the agent could read as opening the PR");
});

test("an agent name at 99 or 100 characters is kept whole; at 101 or more it is cut to 100 with an ellipsis and keeps the key", () => {
  const prefix = "factory TLSSN-42: ";
  const titleOf = (length: number) => "x".repeat(length - prefix.length);
  assert.equal(agentName({ issueKey: "TLSSN-42", title: titleOf(99) }), `${prefix}${titleOf(99)}`);
  assert.equal(agentName({ issueKey: "TLSSN-42", title: titleOf(100) }).length, 100);
  assert.equal(agentName({ issueKey: "TLSSN-42", title: titleOf(100) }), `${prefix}${titleOf(100)}`);
  for (const length of [101, 109, 255 + prefix.length]) {
    const name = agentName({ issueKey: "TLSSN-42", title: titleOf(length) });
    assert.equal(name.length, 100);
    assert.ok(name.startsWith(prefix));
    assert.ok(name.endsWith("…"));
  }
});

test("a truncated agent name never splits an emoji or a combined grapheme", () => {
  const prefix = "factory TLSSN-42: ";
  const family = "👨‍👩‍👧";
  const flag = "🇦🇺";
  // 81 code units fit before the ellipsis; the family emoji spans units 79 to 86.
  const title = `${"x".repeat(78)}${family}${flag} tail`;
  const name = agentName({ issueKey: "TLSSN-42", title });
  assert.equal(name, `${prefix}${"x".repeat(78)}…`);
  assert.ok(name.length <= 100);

  const emojiOnly = agentName({ issueKey: "TLSSN-42", title: flag.repeat(60) });
  assert.ok(emojiOnly.length <= 100);
  assert.equal(emojiOnly, `${prefix}${flag.repeat(20)}…`);
  assert.equal(agentName({ issueKey: "TLSSN-42", title: `${"y".repeat(80)}${family}` }), `${prefix}${"y".repeat(80)}…`);
});

test("a create that throws is a launch that did not start, carrying the sanitized reason", async () => {
  const failures = [
    ["401 Unauthorized", "unauthorized"],
    ["[invalid_model] Model 'claude-opus-5-5' does not match a known variant.", "invalid_model"],
  ] as const;
  for (const [message, reason] of failures) {
    const launcher = fakeCreateAgent({ fail: () => new Error(message) });
    await assert.rejects(
      launchImplementation({ createAgent: launcher.createAgent }, INPUT),
      (error: unknown) => error instanceof LaunchNotStartedError && error.message === `factory-worker: launch did not start: ${message}` && error.reason === reason
    );
  }
});

test("a launch failure reason is a short code from the error, never its message, including the SDK's NetworkError and ConfigurationError", () => {
  const socket = (code: string) => Object.assign(new Error(`connect ${code} 10.0.0.1:443`), { code });
  const refused = (code: string) => new NetworkError("Network request failed", { isRetryable: true, cause: Object.assign(new TypeError("fetch failed"), { cause: socket(code) }) });
  const cases: [unknown, string][] = [
    [refused("ECONNREFUSED"), "service_unavailable"],
    [refused("ENOTFOUND"), "service_unavailable"],
    [refused("UND_ERR_CONNECT_TIMEOUT"), "service_unavailable"],
    [new NetworkError("Bad gateway", { status: 502, code: "unknown" }), "service_unavailable"],
    [new NetworkError("Internal", { status: 500, code: "internal" }), "service_unavailable"],
    [new NetworkError("Connection stalled", { code: "connection_stalled", isRetryable: true, cause: Object.assign(new Error("Connection stalled"), { code: "connection_stalled" }) }), "service_unavailable"],
    [new NetworkError("Connection stalled repeatedly", { isRetryable: true, cause: Object.assign(new Error("Connection stalled repeatedly"), { code: "connection_stalled" }) }), "service_unavailable"],
    [Object.assign(new Error("Connection stalled"), { code: "connection_stalled" }), "service_unavailable"],
    [Object.assign(new Error("[unknown] huh"), { status: 400, code: "unknown" }), "unknown_error"],
    [new ConfigurationError("Model does not match", { status: 400, code: "invalid_model" }), "invalid_model"],
    [new Error("[invalid_model] Model 'claude-opus-5-5' does not match a known variant."), "invalid_model"],
    [new Error("[validation_error] String must contain at most 100 character(s)"), "name_too_long"],
    [new Error("[validation_error] cloud.repos is required"), "validation_error"],
    [Object.assign(new Error("Invalid API key"), { status: 401, code: "unauthenticated" }), "unauthorized"],
    [new Error("401 Unauthorized"), "unauthorized"],
    [Object.assign(new Error("slow down"), { status: 429 }), "rate_limited"],
    [new Error("upstream 503"), "service_unavailable"],
    [new Error("fetch failed"), "service_unavailable"],
    [new Error("credential rejected at https://api.cursor.com/v1/agents?token=xyz"), "unknown_error"],
    [Object.assign(new Error("boom"), { code: "has spaces and a secret" }), "unknown_error"],
    ["plain string", "unknown_error"],
    [Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" }), "service_unavailable"],
    [Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }), "service_unavailable"],
    [Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "service_unavailable"],
    [Object.assign(new Error("boom"), { code: "econnreset" }), "service_unavailable"],
  ];
  for (const [error, reason] of cases) assert.equal(launchFailureReason(error), reason, String(error));
});

test("a first send that throws is a launch that did not start, and the handle still closes", async () => {
  let closed = 0;
  const createAgent = async () => ({
    agentId: "bc-abc",
    send: async () => {
      throw new Error("model claude-opus-5-5 is not available");
    },
    close: () => {
      closed += 1;
    },
  });
  await assert.rejects(
    launchImplementation({ createAgent }, INPUT),
    (error: unknown) =>
      error instanceof LaunchNotStartedError && error.message === "factory-worker: launch did not start: model claude-opus-5-5 is not available"
  );
  assert.equal(closed, 1);
});

function sandboxWorker(env: NodeJS.ProcessEnv) {
  const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const launcher = fakeCreateAgent();
  const kv = memoryKv();
  const handle = createHandler({ kv, mcp: tracker.mcp, createAgent: launcher.createAgent, env, now: () => new Date("2026-09-23T00:00:00.000Z"), log: () => {} });
  const deliver = async () => {
    const background = backgroundWork();
    const response = await handle(signedRequest(approvedBody()), background);
    return { status: response.status, body: (await response.json()) as unknown, settled: await background.settle() };
  };
  return { tracker, launcher, kv, deliver };
}

test("FACTORY_SANDBOX_REPO and FACTORY_SANDBOX_REF from the delivery's env are the launch's repo and starting ref", async () => {
  const w = sandboxWorker({ ...ENV, FACTORY_SANDBOX_REPO: "cursor-demo-lab/factory-sandbox", FACTORY_SANDBOX_REF: "release/2026-09" });
  const delivery = await w.deliver();
  assert.equal(delivery.status, 202);
  assert.equal(delivery.settled[0]?.ok, true);
  assert.equal(w.launcher.calls.length, 1);
  assert.deepEqual(w.launcher.calls[0]?.cloud, {
    repos: [{ url: "https://github.com/cursor-demo-lab/factory-sandbox", startingRef: "release/2026-09" }],
    autoCreatePR: false,
  });
});

test("an invalid FACTORY_SANDBOX_REPO is refused before any createAgent call, with one Launch failed: config comment and no claim", async () => {
  for (const repo of ["cursor-demo-lab", "https://github.com/cursor-demo-lab/factory-sandbox", "cursor-demo-lab/factory-sandbox/extra"]) {
    const w = sandboxWorker({ ...ENV, FACTORY_SANDBOX_REPO: repo, FACTORY_SANDBOX_REF: "release/2026-09" });
    const delivery = await w.deliver();
    assert.equal(delivery.status, 500);
    assert.deepEqual(delivery.body, {
      ok: false,
      launched: false,
      reason: "config",
      message: `Set FACTORY_SANDBOX_REPO to one owner/repo. "${repo}" is not an owner/repo.`,
    });
    assert.deepEqual(delivery.settled, []);
    assert.deepEqual(w.launcher.calls, []);
    assert.deepEqual(
      w.tracker.calls.map((call) => call.args["commentBody"]),
      ["Launch failed: config. Moving the card to Approved again retries."]
    );
    assert.deepEqual([...w.kv.entries.keys()], ["implement-failed/TLSSN-42/10042"]);
  }
});

test("a launch with no answer within its deadline is launch_timeout, and a create that answers later is closed", async () => {
  let answer!: () => void;
  const late = new Promise<void>((resolve) => {
    answer = resolve;
  });
  let closed = 0;
  const createAgent: CreateAgent = async () => {
    await late;
    return { agentId: "bc-late", send: async () => undefined, close: () => void (closed += 1) };
  };
  // The deadline's timer is unref'd, as a served process keeps its own loop alive; this test must.
  const alive = setInterval(() => {}, 1_000);
  await assert
    .rejects(launchImplementation({ createAgent, timeoutMs: 5 }, INPUT), (error: unknown) => {
      assert.ok(error instanceof LaunchNotStartedError);
      assert.equal(error.reason, "launch_timeout");
      assert.match(error.message, /no answer from the launch API within 5 ms/);
      return true;
    })
    .finally(() => clearInterval(alive));
  answer();
  for (let i = 0; i < 5 && closed === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1, "the late agent handle is closed, not leaked");
  assert.equal(LAUNCH_TIMEOUT_MS, 30_000);

  const fast = await launchImplementation({ createAgent: async () => ({ agentId: "bc-1", send: async () => undefined, close: () => {} }), timeoutMs: 5 }, INPUT);
  assert.deepEqual(fast, { agentId: "bc-1", url: "https://cursor.com/agents/bc-1" });
});

test("a long agent name is cut between words, never mid-word", () => {
  const title = 'Small one on Accounts: a home loan with no linked offset account shows "Offset 0.00" in the Held column';
  const name = agentName({ issueKey: "TLSSN-42", title });
  const prefix = "factory TLSSN-42: ";
  assert.ok(name.length <= 100 && name.endsWith("…"));
  const kept = name.slice(prefix.length, -1);
  assert.ok(title.startsWith(kept));
  assert.match(title.slice(kept.length), /^\s/, `cut mid-word: …${kept.slice(-12)}|${title.slice(kept.length, kept.length + 8)}`);
});

test("an agent name cut near a path ends before the path, with no separator before the …", () => {
  const name = agentName({ issueKey: "TLSSN-42", title: "Held column shows Offset 0.00 for every loan in components/banking/accounts-table.tsx on main" });
  assert.equal(name, "factory TLSSN-42: Held column shows Offset 0.00 for every loan in…");
  assert.equal(wordPrefix("Offset shows, zero for loans", 14), "Offset shows");
});

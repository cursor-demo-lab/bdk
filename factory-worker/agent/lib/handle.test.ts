import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { approvedBody } from "./fixtures.js";
import { createHandler } from "./handle.js";
import { IMPLEMENT_MODEL } from "./config.js";
import agent from "../agent.js";
import { racingStores } from "./kv-race.fixtures.js";
import {
  backgroundWork,
  BRIEF,
  ENV,
  fakeCreateAgent,
  fakeTracker,
  memoryKv,
  PLAN_COMMENT,
  SECRET,
  signedRequest,
  tick,
  TRIAGE_COMMENT,
  type FakeLauncher,
  type FakeTracker,
  type MemoryKv,
} from "./testing/fakes.js";

const CLOUD = { cloudId: "https://<JIRA_SITE>.atlassian.net" };

const NOW = new Date("2026-09-23T00:00:00.000Z");

function worker(options: { tracker?: FakeTracker; launcher?: FakeLauncher; kv?: MemoryKv; env?: NodeJS.ProcessEnv; now?: () => Date } = {}) {
  const tracker = options.tracker ?? fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const launcher = options.launcher ?? fakeCreateAgent();
  const kv = options.kv ?? memoryKv();
  const lines: string[] = [];
  const handle = createHandler({
    kv,
    mcp: tracker.mcp,
    createAgent: launcher.createAgent,
    env: options.env ?? ENV,
    now: options.now ?? (() => NOW),
    log: (line) => lines.push(line),
  });
  const deliver = async (request: Request) => {
    const background = backgroundWork();
    const response = await handle(request, background);
    return { status: response.status, body: (await response.json()) as unknown, settled: await background.settle() };
  };
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const decisions = () => parsed().filter((line) => "worker" in line);
  const outcomes = () => decisions().map((line) => line["outcome"]);
  const claims = () => parsed().filter((line) => "claim" in line);
  return { tracker, launcher, kv, lines, deliver, decisions, outcomes, claims };
}

function toolCalls(tracker: FakeTracker, tool: string) {
  return tracker.calls.filter((call) => call.tool === tool).map((call) => call.args);
}

test("the heal's launch model is the load-time implement model, the live turn's, whatever the per-request env says", async () => {
  // Hosted v2 binds secrets into the env per request, after agent.ts has
  // loaded, so a per-request FACTORY_WORKER_* must not split the heal from
  // the live cloud turn (which runs agent.ts `model`).
  const w = worker({ env: { ...ENV, FACTORY_WORKER_MODEL: "grok-4.6", FACTORY_WORKER_EFFORT: "max", FACTORY_WORKER_FAST: "true" } });
  const delivery = await w.deliver(signedRequest(approvedBody()));
  assert.equal(delivery.status, 202);
  assert.equal(w.launcher.calls.length, 1);
  assert.deepEqual(w.launcher.calls[0]?.model, IMPLEMENT_MODEL);
  assert.deepEqual(w.launcher.calls[0]?.model, agent.model);
});

test("an approved ticket launches one cloud agent from its brief, comments the URL, and moves to In Progress", async () => {
  const w = worker();
  const delivery = await w.deliver(signedRequest(approvedBody()));

  assert.equal(delivery.status, 202);
  assert.deepEqual(delivery.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
  assert.deepEqual(delivery.settled, [
    {
      ok: true,
      value: {
        ok: true,
        launched: true,
        issueKey: "TLSSN-42",
        agentId: "bc-test-1",
        url: "https://cursor.com/agents/bc-test-1",
        transition: "transitioned",
        comment: "commented",
        recorded: true,
        prWatch: "unavailable",
      },
    },
  ]);
  assert.deepEqual(w.launcher.calls, [
    {
      name: "factory TLSSN-42: Retry CSV export on empty filter",
      idempotencyKey: "implement/TLSSN-42",
      model: {
        id: "claude-opus-5-5",
        params: [
          { id: "context", value: "300k" },
          { id: "effort", value: "high" },
          { id: "fast", value: "false" },
        ],
      },
      cloud: {
        repos: [{ url: "https://github.com/example-org/demo-repo", startingRef: "main" }],
        autoCreatePR: false,
      },
    },
  ]);
  assert.ok(w.launcher.sent.length === 1 && w.launcher.sent[0]?.startsWith(`${BRIEF}\n\n## Handing off the change`));
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Implementing: https://cursor.com/agents/bc-test-1" },
  ]);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), [{ ...CLOUD, issueIdOrKey: "TLSSN-42", transition: { id: "31" } }]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), {
    state: "launched",
    at: "2026-09-23T00:00:00.000Z",
    agentId: "bc-test-1",
    url: "https://cursor.com/agents/bc-test-1",
    commented: true,
    moved: true,
  });
  assert.deepEqual(w.outcomes(), ["launched"]);
});

test("an approved ticket with no Brief: gets one comment and no launch", async () => {
  const w = worker({ tracker: fakeTracker({ comments: [TRIAGE_COMMENT] }) });
  const delivery = await w.deliver(signedRequest(approvedBody()));

  assert.equal(delivery.status, 200);
  assert.deepEqual(delivery.body, { ok: true, launched: false, reason: "no_brief" });
  assert.deepEqual(delivery.settled, []);
  assert.equal(w.launcher.calls.length, 0);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [
    {
      ...CLOUD,
      issueIdOrKey: "TLSSN-42",
      commentBody: "Approved without a plan on the ticket; nothing was launched. Move TLSSN-42 back to Triaged in Jira to plan it, then approve the new plan.",
    },
  ]);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), []);
  assert.equal(w.kv.entries.size, 0);
});

test("a redelivered approval launches nothing, repeats no comment, moves nothing, and leaves the launched claim as it was", async () => {
  const w = worker();
  await w.deliver(signedRequest(approvedBody()));
  const launched = w.kv.entries.get("implement/TLSSN-42");
  const again = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));

  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false });
  assert.deepEqual(again.settled, []);
  assert.equal(w.launcher.calls.length, 1);
  assert.deepEqual(
    toolCalls(w.tracker, "addCommentToJiraIssue").map((call) => call["commentBody"]),
    ["Implementing: https://cursor.com/agents/bc-test-1", "Launch skipped: TLSSN-42 already has its implement agent, https://cursor.com/agents/bc-test-1. No second agent was started."],
    "the redelivery says why it started nothing"
  );
  assert.equal(toolCalls(w.tracker, "transitionJiraIssue").length, 1);
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), launched);
  assert.deepEqual(w.outcomes(), ["launched", "duplicate"]);

  await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.equal(toolCalls(w.tracker, "addCommentToJiraIssue").length, 2, "one note per approval, however often it is redelivered");
});

test("a second approval after a withdrawal re-posts the recorded URL instead of launching, then returns the ticket to In Progress", async () => {
  const kv = memoryKv();
  await kv.put("implement/TLSSN-42", {
    state: "launched",
    at: "2026-09-22T00:00:00.000Z",
    agentId: "bc-old",
    url: "https://cursor.com/agents/bc-old",
    commented: true,
    moved: true,
  });
  const w = worker({ kv, tracker: fakeTracker({ comments: [PLAN_COMMENT] }) });
  const delivery = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));

  assert.deepEqual(delivery.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: true, transition: "transitioned" });
  assert.equal(w.launcher.calls.length, 0);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Implementing: https://cursor.com/agents/bc-old" },
  ]);
  const order = w.tracker.calls.map((call) => call.tool);
  assert.ok(order.indexOf("addCommentToJiraIssue") < order.indexOf("transitionJiraIssue"), "the desk reads the URL from the comment when it announces In Progress");
  assert.equal(w.tracker.status(), "In Progress");
});

test("a delivery for a ticket that has already moved on is ignored once Jira confirms it, with one Launch skipped: line", async () => {
  const w = worker({ tracker: fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT], status: "In Progress" }) });
  const delivery = await w.deliver(signedRequest(approvedBody({ currentStatus: "In Progress" })));

  assert.equal(delivery.status, 200);
  assert.deepEqual(delivery.body, { ok: true, ignored: true, reason: "stale_status" });
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Launch skipped: TLSSN-42 was no longer Approved (now In Progress) when this approval's delivery arrived, so it launched nothing." },
  ]);
  assert.equal(w.launcher.calls.length, 0);
  assert.deepEqual(w.outcomes(), ["ignored"]);
  assert.deepEqual(w.decisions()[0], {
    worker: "decision",
    outcome: "ignored",
    reason: "stale_status",
    issueKey: "TLSSN-42",
    changelogId: "10042",
    via: "delivery",
    snapshot: "In Progress",
    current: "In Progress",
    watchClosed: true,
    trace: "commented",
  });

  await w.deliver(signedRequest(approvedBody({ currentStatus: "In Progress" })));
  assert.equal(toolCalls(w.tracker, "addCommentToJiraIssue").length, 1, "a replay of that approval adds nothing");
});

test("a move into Approved whose body rendered the status from before the move still launches, because Jira says Approved", async () => {
  // Automation renders {{issue.status.name}} when the rule runs; a snapshot that lags the transition used to drop the approval silently.
  const w = worker();
  const delivery = await w.deliver(signedRequest(approvedBody({ currentStatus: "Planned" })));

  assert.equal(delivery.status, 202);
  assert.deepEqual(delivery.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
  assert.equal(w.launcher.calls.length, 1);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((call) => call["commentBody"]), ["Implementing: https://cursor.com/agents/bc-test-1"]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.deepEqual(w.outcomes(), ["launched"]);
});

test("a stale body whose ticket status cannot be read launches nothing and leaves a launch watch with a Launch pending: line", async () => {
  const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const unread: FakeTracker = {
    ...tracker,
    mcp: {
      ...tracker.mcp,
      callTool: async (connection, tool, args) => {
        if (tool === "getJiraIssue") return { content: [{ type: "text", text: "unavailable" }], isError: true };
        return tracker.mcp.callTool(connection, tool, args);
      },
    },
  };
  const w = worker({ tracker: unread });
  const delivery = await w.deliver(signedRequest(approvedBody({ currentStatus: "Planned" })));

  assert.equal(delivery.status, 202, "handed to the watch: a non-2xx would be terminal on hosted with nothing scheduled");
  assert.deepEqual(delivery.body, { ok: true, launched: false, reason: "status_unreadable", watched: true });
  assert.equal(w.launcher.calls.length, 0);
  assert.ok(w.kv.entries.has("implement-launch/TLSSN-42"), "the heal reads the status again after the grace");
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((call) => call["commentBody"]), [
    "Launch pending: TLSSN-42: this approval's delivery named another status and Jira's could not be read to confirm it. No retry timer could be set yet; factory-worker sets one the next time it handles an Approved move or a pull request. If no Implementing: comment follows within 4 minutes, move the card to Approved again.",
  ]);
});

test("a delivery authenticated with X-Factory-Webhook-Secret launches", async () => {
  const w = worker();
  const delivery = await w.deliver(
    new Request("http://127.0.0.1:3000/factory-worker/v1/channels/jira/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-webhook-secret": SECRET },
      body: JSON.stringify(approvedBody()),
    })
  );
  assert.equal(delivery.status, 202);
  assert.deepEqual(delivery.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
});

test("a delivery with a wrong or missing signature is refused before anything is read", async () => {
  const w = worker();
  const wrong = await w.deliver(signedRequest(approvedBody(), "not-the-secret"));
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { ok: false });

  const unsigned = await w.deliver(
    new Request("http://127.0.0.1:3000/factory-worker/v1/channels/jira/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(approvedBody()),
    })
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(w.tracker.calls, []);
  assert.equal(w.launcher.calls.length, 0);
  assert.deepEqual(w.outcomes(), ["unauthorized", "unauthorized"]);
});

test("a launch that throws releases the claim, so the next delivery launches", async () => {
  const launcher = fakeCreateAgent({ fail: (call) => (call === 1 ? new Error("upstream 503") : undefined) });
  const w = worker({ launcher });

  const failed = await w.deliver(signedRequest(approvedBody()));
  assert.equal(failed.status, 202);
  assert.equal(failed.settled.length, 1);
  // The background work resolves, never rejects: a rejection fails hosted admission's Promise.all before the backstop.
  assert.deepEqual(failed.settled, [{ ok: true, value: { ok: true, launched: false, issueKey: "TLSSN-42", reason: "service_unavailable" } }]);
  assert.equal(w.decisions()[0]?.["message"], "factory-worker: launch did not start: upstream 503");
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Launch failed: service_unavailable. Moving the card to Approved again retries." },
  ]);

  const retried = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(retried.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
  assert.equal(retried.settled[0]?.ok, true);

  const third = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(third.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false });
  assert.equal(launcher.calls.length, 2);
  assert.ok(launcher.sent.length === 1 && launcher.sent[0]?.startsWith(`${BRIEF}\n\n## Handing off the change`));
  assert.deepEqual(w.outcomes(), ["launch_failed", "launched", "duplicate"]);
});

test("an approval whose summary would make a 109-character agent name launches with the name cut between words within 100", async () => {
  const w = worker();
  const summary = "Factory e2e 2026-09-23T11:05:24.230Z: CSV export returns 500 when the filter matches no rows";
  const delivery = await w.deliver(signedRequest(approvedBody({ issueKey: "TLSSN-42", summary })));
  assert.equal(delivery.status, 202);
  assert.equal(w.launcher.calls[0]?.name, "factory TLSSN-42: Factory e2e 2026-09-23T11:05:24.230Z: CSV export returns 500 when the filter…");
  assert.ok((w.launcher.calls[0]?.name?.length ?? 0) <= 100);
});

function launchFailedComments(tracker: FakeTracker) {
  return toolCalls(tracker, "addCommentToJiraIssue")
    .map((args) => String(args["commentBody"]))
    .filter((body) => body.startsWith("Launch failed: "));
}

test("a launch refused for its model posts one sanitized Launch failed: comment and releases the claim", async () => {
  const launcher = fakeCreateAgent({
    fail: () =>
      Object.assign(new Error("[invalid_model] Model 'claude-opus-5-5' does not match a known variant. token=not-a-real-token"), {
        code: "invalid_model",
        status: 400,
      }),
  });
  const w = worker({ launcher });
  const delivery = await w.deliver(signedRequest(approvedBody({ changelogId: "32154" })));

  assert.equal(delivery.status, 202);
  assert.deepEqual(delivery.settled[0], { ok: true, value: { ok: true, launched: false, issueKey: "TLSSN-42", reason: "invalid_model" } });
  assert.deepEqual(launchFailedComments(w.tracker), ["Launch failed: invalid_model. Moving the card to Approved again retries."]);
  assert.ok(!JSON.stringify(w.tracker.calls).includes("not-a-real-token"));
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), []);
  const logged = w.decisions()[0] ?? {};
  assert.equal(logged["reason"], "invalid_model");
  assert.equal(logged["notice"], "commented");
});

test("a failing approval posts one notice per move to Approved but retries every launch, then launches once the cause is fixed", async () => {
  const launcher = fakeCreateAgent({ fail: (call) => (call <= 6 ? new Error("401 Unauthorized") : undefined) });
  const w = worker({ launcher });
  for (let i = 0; i < 5; i += 1) {
    const delivery = await w.deliver(signedRequest(approvedBody({ changelogId: "32154" })));
    assert.equal(delivery.status, 202);
  }
  assert.equal(launcher.calls.length, 5);
  assert.deepEqual(launchFailedComments(w.tracker), ["Launch failed: unauthorized. Moving the card to Approved again retries."]);
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(w.outcomes(), Array(5).fill("launch_failed"));

  await w.deliver(signedRequest(approvedBody({ changelogId: "32160" })));
  assert.deepEqual(launchFailedComments(w.tracker), [
    "Launch failed: unauthorized. Moving the card to Approved again retries.",
    "Launch failed: unauthorized. Moving the card to Approved again retries.",
  ]);

  const fixed = await w.deliver(signedRequest(approvedBody({ changelogId: "32170" })));
  assert.equal(fixed.settled[0]?.ok, true);
  assert.equal(w.tracker.status(), "In Progress");
  assert.equal(launchFailedComments(w.tracker).length, 2);
});

test("a Launch failed: comment that Jira rejects is posted by the next redelivery of the same approval", async () => {
  const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT], commentFailures: 1 });
  const launcher = fakeCreateAgent({ fail: () => new Error("upstream 503") });
  const w = worker({ tracker, launcher });
  await w.deliver(signedRequest(approvedBody({ changelogId: "32154" })));
  assert.deepEqual(launchFailedComments(w.tracker), ["Launch failed: service_unavailable. Moving the card to Approved again retries."]);
  assert.equal(w.tracker.comments.filter((body) => body.startsWith("Launch failed: ")).length, 0);

  await w.deliver(signedRequest(approvedBody({ changelogId: "32154" })));
  await w.deliver(signedRequest(approvedBody({ changelogId: "32154" })));
  assert.equal(w.tracker.comments.filter((body) => body.startsWith("Launch failed: ")).length, 1);
});

const CLAIMED_AT = "2026-09-23T00:00:00.000Z";

test("a pending claim older than the stale window is taken over and launches exactly once", async () => {
  const kv = memoryKv();
  await kv.put("implement/TLSSN-42", { state: "pending", at: CLAIMED_AT });
  const w = worker({ kv, now: () => new Date("2026-09-23T00:10:00.001Z") });

  const taken = await w.deliver(signedRequest(approvedBody()));
  assert.equal(taken.status, 202);
  assert.deepEqual(taken.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
  assert.equal(taken.settled[0]?.ok, true);
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), {
    state: "launched",
    at: "2026-09-23T00:10:00.001Z",
    agentId: "bc-test-1",
    url: "https://cursor.com/agents/bc-test-1",
    commented: true,
    moved: true,
  });

  const again = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(again.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false });
  assert.deepEqual(w.launcher.calls.map((call) => call.idempotencyKey), ["implement/TLSSN-42"]);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), [{ ...CLOUD, issueIdOrKey: "TLSSN-42", transition: { id: "31" } }]);
  assert.deepEqual(w.outcomes(), ["launched", "duplicate"]);
});

test("a launched ticket that drifted back and was approved again returns to In Progress without a second launch", async () => {
  const kv = memoryKv();
  const launched = { state: "launched", at: CLAIMED_AT, agentId: "bc-old", url: "https://cursor.com/agents/bc-old", commented: true, moved: true };
  await kv.put("implement/TLSSN-42", launched);
  const tracker = fakeTracker({ comments: [PLAN_COMMENT, "Implementing: https://cursor.com/agents/bc-old"], status: "Approved" });
  const w = worker({ kv, tracker, now: () => new Date("2026-09-25T02:30:00.000Z") });

  const delivery = await w.deliver(signedRequest(approvedBody({ changelogId: "10099" })));
  assert.equal(delivery.status, 200);
  assert.deepEqual(delivery.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false, transition: "transitioned" });
  assert.equal(w.launcher.calls.length, 0);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [{ ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Launch skipped: TLSSN-42 already has its implement agent, https://cursor.com/agents/bc-old. No second agent was started." }]);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), [{ ...CLOUD, issueIdOrKey: "TLSSN-42", transition: { id: "31" } }]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), launched);

  const redelivery = await w.deliver(signedRequest(approvedBody({ changelogId: "10099" })));
  assert.deepEqual(redelivery.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false });
  assert.equal(toolCalls(w.tracker, "transitionJiraIssue").length, 1);
});

test("a launch whose Implementing: comment fails does not move the ticket; the next approval posts it and moves the ticket exactly once", async () => {
  const w = worker({ tracker: fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT], commentFailures: 1 }) });
  const first = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(first.settled, [
    {
      ok: true,
      value: {
        ok: true,
        launched: true,
        issueKey: "TLSSN-42",
        agentId: "bc-test-1",
        url: "https://cursor.com/agents/bc-test-1",
        transition: "skipped_no_comment",
        comment: "failed",
        recorded: true,
        prWatch: "unavailable",
      },
    },
  ]);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), []);
  assert.equal(w.tracker.status(), "Approved");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), {
    state: "launched",
    at: "2026-09-23T00:00:00.000Z",
    agentId: "bc-test-1",
    url: "https://cursor.com/agents/bc-test-1",
    commented: false,
    moved: false,
  });

  const second = await w.deliver(signedRequest(approvedBody()));
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: true, transition: "transitioned" });
  assert.deepEqual(second.settled, []);

  const third = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(third.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false });

  assert.equal(w.launcher.calls.length, 1);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Implementing: https://cursor.com/agents/bc-test-1" },
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Implementing: https://cursor.com/agents/bc-test-1" },
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Launch skipped: TLSSN-42 already has its implement agent, https://cursor.com/agents/bc-test-1. No second agent was started." },
  ]);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), [{ ...CLOUD, issueIdOrKey: "TLSSN-42", transition: { id: "31" } }]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), {
    state: "launched",
    at: "2026-09-23T00:00:00.000Z",
    agentId: "bc-test-1",
    url: "https://cursor.com/agents/bc-test-1",
    commented: true,
    moved: true,
  });
  assert.deepEqual(w.outcomes(), ["launched", "duplicate", "duplicate"]);
});

test("a launch whose move to In Progress fails records moved: false; the next approval, with the ticket still Approved, moves it exactly once and records moved: true", async () => {
  const w = worker({ tracker: fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT], transitionFailures: 1 }) });
  const first = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(first.settled, [
    {
      ok: true,
      value: {
        ok: true,
        launched: true,
        issueKey: "TLSSN-42",
        agentId: "bc-test-1",
        url: "https://cursor.com/agents/bc-test-1",
        transition: "failed",
        comment: "commented",
        recorded: true,
        prWatch: "unavailable",
      },
    },
  ]);
  assert.equal(w.tracker.status(), "Approved");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), {
    state: "launched",
    at: "2026-09-23T00:00:00.000Z",
    agentId: "bc-test-1",
    url: "https://cursor.com/agents/bc-test-1",
    commented: true,
    moved: false,
  });
  assert.equal(toolCalls(w.tracker, "transitionJiraIssue").length, 1);

  const second = await w.deliver(signedRequest(approvedBody()));
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false, transition: "transitioned" });
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), [
    { ...CLOUD, issueIdOrKey: "TLSSN-42", transition: { id: "31" } },
    { ...CLOUD, issueIdOrKey: "TLSSN-42", transition: { id: "31" } },
  ]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), {
    state: "launched",
    at: "2026-09-23T00:00:00.000Z",
    agentId: "bc-test-1",
    url: "https://cursor.com/agents/bc-test-1",
    commented: true,
    moved: true,
  });

  const third = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(third.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false });
  assert.equal(toolCalls(w.tracker, "transitionJiraIssue").length, 2);
  assert.equal(w.launcher.calls.length, 1);
  assert.deepEqual(
    toolCalls(w.tracker, "addCommentToJiraIssue").map((call) => call["commentBody"]),
    ["Implementing: https://cursor.com/agents/bc-test-1", "Launch skipped: TLSSN-42 already has its implement agent, https://cursor.com/agents/bc-test-1. No second agent was started."]
  );
  assert.deepEqual(w.outcomes(), ["launched", "duplicate", "duplicate"]);
});

test("a duplicate approval does not move a ticket that has moved on to In Review", async () => {
  const kv = memoryKv();
  const launched = { state: "launched", at: CLAIMED_AT, agentId: "bc-old", url: "https://cursor.com/agents/bc-old", commented: true, moved: false };
  await kv.put("implement/TLSSN-42", launched);
  const tracker = fakeTracker({ comments: [PLAN_COMMENT, "Implementing: https://cursor.com/agents/bc-old"], status: "In Review" });
  const w = worker({ kv, tracker });

  const delivery = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.equal(delivery.status, 200);
  assert.deepEqual(delivery.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false, transition: "skipped_status" });
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), []);
  assert.equal(w.tracker.status(), "In Review");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), launched);
  assert.equal(w.launcher.calls.length, 0);
});

test("an unconnected tracker launches nothing, answers 202 with the approval handed to the launch watch, since hosted admission never redelivers a non-2xx", async () => {
  const w = worker({ tracker: fakeTracker({ connected: false }) });
  const delivery = await w.deliver(signedRequest(approvedBody()));
  assert.equal(delivery.status, 202);
  assert.deepEqual(delivery.body, { ok: true, launched: false, reason: "comments_unreadable", watched: true, tracker: "not_connected" });
  assert.equal(w.launcher.calls.length, 0);
  assert.deepEqual(w.kv.entries.get("implement-launch/TLSSN-42"), { at: NOW.toISOString(), changelogId: "10042", title: "Retry CSV export on empty filter", attempts: 0 });
  assert.deepEqual(w.kv.entries.get("implement-launch/index"), ["TLSSN-42"]);
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false, "no claim is taken");
  assert.deepEqual(w.decisions()[0], {
    worker: "decision",
    outcome: "comments_unreadable",
    issueKey: "TLSSN-42",
    changelogId: "10042",
    via: "delivery",
    tracker: "not_connected",
    connector: { reason: "not_attached", attempts: 0 },
    trace: "not_connected",
    watched: true,
    reminder: "unavailable",
  });
});

test("a missing sandbox repository refuses before any claim", async () => {
  const w = worker({ env: { JIRA_WEBHOOK_SECRET: "test-secret", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_CLAIM_SETTLE_MS: "1" } });
  const delivery = await w.deliver(signedRequest(approvedBody()));
  assert.equal(delivery.status, 500);
  assert.deepEqual(delivery.body, {
    ok: false,
    launched: false,
    reason: "config",
    message: "Set FACTORY_SANDBOX_REPO to one owner/repo, or FACTORY_REPOS to a comma-separated owner/repo list.",
  });
  assert.deepEqual([...w.kv.entries.keys()], ["implement-failed/TLSSN-42/10042"], "no claim and no watch; only the failure notice's dedupe marker");
  assert.equal(w.launcher.calls.length, 0);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Launch failed: config. Moving the card to Approved again retries." },
  ]);
});

// Hosted host.kv (July 0.2.13) has no compare-and-set: on the plain get/put kv these two deliveries both claim, so this race only holds on the CAS branch.
describe("CAS path (ask 11)", () => {
  test("two concurrent deliveries of one approval race to the claim: exactly one launches, the other is in flight", async () => {
    const w = worker({ kv: memoryKv({ cas: true }) });
    const deliveries = await Promise.all([w.deliver(signedRequest(approvedBody())), w.deliver(signedRequest(approvedBody()))]);
    const winner = deliveries.find((delivery) => delivery.status === 202);
    const loser = deliveries.find((delivery) => delivery !== winner);

    assert.deepEqual(winner?.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
    assert.deepEqual(winner?.settled.map((settled) => settled.ok), [true]);
    assert.equal(loser?.status, 200);
    assert.deepEqual(loser?.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", inFlight: true });
    assert.deepEqual(loser?.settled, []);
    assert.deepEqual(w.launcher.calls.map((call) => call.idempotencyKey), ["implement/TLSSN-42"]);
    assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]).sort(), ["Implementing: https://cursor.com/agents/bc-test-1", "Launch pending: TLSSN-42: another delivery of this approval holds the launch claim. No retry timer could be set yet; factory-worker sets one the next time it handles an Approved move or a pull request. If no Implementing: comment follows within 4 minutes, move the card to Approved again."]);
    assert.equal((w.kv.entries.get("implement/TLSSN-42") as { url?: string } | undefined)?.url, "https://cursor.com/agents/bc-test-1");
    assert.deepEqual(w.outcomes().sort(), ["in_flight", "launched"]);
  });
});

function withDeliveryId(request: Request, deliveryId: string): Request {
  request.headers.set("x-agent-sdk-delivery-id", deliveryId);
  return request;
}

// Hosted host.kv has no compare-and-set: the claim is the owner, read-back, settle claim (verified-claim.ts).
describe("no compare-and-set: owner, read-back, settle", () => {
  test("two concurrent approvals of one ticket with different delivery ids launch exactly one agent", async () => {
    const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
    const launcher = fakeCreateAgent();
    const shared = memoryKv();
    const lines: string[] = [];
    const [first, second] = racingStores(shared, { prefix: "implement/", after: "readBack", passReads: 1 });
    const deliver = async (kv: typeof first, deliveryId: string) => {
      const handle = createHandler({ kv, mcp: tracker.mcp, createAgent: launcher.createAgent, env: ENV, now: () => NOW, log: (line) => lines.push(line), sleep: tick });
      const background = backgroundWork();
      const response = await handle(withDeliveryId(signedRequest(approvedBody()), deliveryId), background);
      return { status: response.status, body: (await response.json()) as unknown, settled: await background.settle() };
    };
    const deliveries = await Promise.all([deliver(first, "dlv_a"), deliver(second, "dlv_b")]);

    assert.deepEqual(deliveries.map((delivery) => delivery.status).sort(), [200, 202]);
    assert.deepEqual(deliveries.find((delivery) => delivery.status === 200)?.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", inFlight: true });
    assert.deepEqual(launcher.calls.map((call) => call.idempotencyKey), ["implement/TLSSN-42"]);
    assert.deepEqual(toolCalls(tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]).sort(), ["Implementing: https://cursor.com/agents/bc-test-1", "Launch pending: TLSSN-42: another delivery of this approval holds the launch claim. No retry timer could be set yet; factory-worker sets one the next time it handles an Approved move or a pull request. If no Implementing: comment follows within 4 minutes, move the card to Approved again."]);
    const claims = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => "claim" in line);
    assert.deepEqual(claims.map((line) => line["claim"]).sort(), ["claimed", "in_flight"]);
    assert.ok(claims.every((line) => line["host"] === "worker" && line["key"] === "implement/TLSSN-42"));
  });

  test("a replay of the same delivery takes its own pending claim over and launches; another delivery stays in flight", async () => {
    const kv = memoryKv();
    await kv.put("implement/TLSSN-42", { state: "pending", at: "2026-09-22T23:59:30.000Z", deliveryId: "dlv_1", owner: "gone" });
    const w = worker({ kv });

    const other = await w.deliver(withDeliveryId(signedRequest(approvedBody()), "dlv_2"));
    assert.deepEqual(other.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", inFlight: true });
    assert.equal(w.launcher.calls.length, 0);

    const replay = await w.deliver(withDeliveryId(signedRequest(approvedBody()), "dlv_1"));
    assert.deepEqual(replay.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
    assert.equal(w.launcher.calls.length, 1);
    assert.equal((kv.entries.get("implement/TLSSN-42") as { state?: string }).state, "launched");
    assert.deepEqual(w.claims().map((line) => line["claim"]), ["in_flight", "claimed"]);
  });

  test("residual: a replay of the same delivery while its first launch is still running launches again, under the same idempotencyKey", async () => {
    // The replay rule retakes this delivery's own pending claim at any age, because a
    // replay usually means the first attempt's work was lost. When it was not, the second
    // Agent.create carries the same idempotencyKey, which is the only (unverified) guard.
    let open!: () => void;
    const firstLaunch = new Promise<void>((resolve) => {
      open = resolve;
    });
    const keys: (string | undefined)[] = [];
    const base = fakeCreateAgent();
    const createAgent: typeof base.createAgent = async (options) => {
      keys.push(options.idempotencyKey);
      if (keys.length === 1) await firstLaunch;
      return base.createAgent(options);
    };
    const w = worker();
    const background = backgroundWork();
    const handle = createHandler({ kv: w.kv, mcp: w.tracker.mcp, createAgent, env: ENV, now: () => NOW, log: () => {}, sleep: tick });
    const first = await handle(withDeliveryId(signedRequest(approvedBody()), "dlv_1"), background);
    assert.equal(first.status, 202);
    while (keys.length === 0) await tick(0);

    const replay = await handle(withDeliveryId(signedRequest(approvedBody()), "dlv_1"), background);
    assert.deepEqual(await replay.json(), { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
    open();
    await background.settle();
    assert.deepEqual(keys, ["implement/TLSSN-42", "implement/TLSSN-42"]);
  });

  test("a claim that cannot be confirmed releases this delivery's put, answers 202 with the watch armed, and the retried delivery launches", async () => {
    const inner = memoryKv();
    let reads = 0;
    // The claim's read and pre-read work; every read after its put fails until the release reads.
    const flaky: MemoryKv = {
      ...inner,
      get: async (key) => {
        if (key !== "implement/TLSSN-42") return inner.get(key);
        reads += 1;
        if (reads >= 3 && reads <= 5) throw new Error("kv read failed");
        return inner.get(key);
      },
    };
    const w = worker({ kv: flaky });
    const delivery = await w.deliver(signedRequest(approvedBody()));
    assert.equal(delivery.status, 202);
    assert.deepEqual(delivery.body, { ok: true, launched: false, reason: "claim_unavailable", watched: true });
    assert.equal(inner.entries.has("implement/TLSSN-42"), false, "the put landed and was released");
    assert.deepEqual(w.decisions().at(-1), {
      worker: "decision",
      outcome: "claim_unavailable",
      issueKey: "TLSSN-42",
      changelogId: "10042",
      via: "delivery",
      released: "released",
      trace: "commented",
      watched: true,
      reminder: "unavailable",
    });
    assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), [
      "Launch pending: TLSSN-42: the launch claim could not be taken (kv unavailable). No retry timer could be set yet; factory-worker sets one the next time it handles an Approved move or a pull request. If no Implementing: comment follows within 4 minutes, move the card to Approved again.",
    ]);
    assert.equal(w.launcher.calls.length, 0);

    const retried = await w.deliver(signedRequest(approvedBody()));
    assert.equal(retried.status, 202);
    assert.equal(w.launcher.calls.length, 1);
  });

  test("a claim whose put is overwritten on every attempt (lost, current undefined) releases its own put and hands the approval to the watch, never an in-flight 200", async () => {
    const inner = memoryKv();
    const rival = { state: "pending", at: "2026-09-23T00:00:00.000Z", owner: "rival" };
    let reads = 0;
    const overwritten: MemoryKv = {
      ...inner,
      get: async (key) => {
        if (key !== "implement/TLSSN-42") return inner.get(key);
        reads += 1;
        if (reads === 3 || reads === 5 || reads === 7) return rival;
        if (reads === 4 || reads === 6) return undefined;
        return inner.get(key);
      },
    };
    const w = worker({ kv: overwritten });
    const delivery = await w.deliver(signedRequest(approvedBody()));
    assert.equal(delivery.status, 202);
    assert.deepEqual(delivery.body, { ok: true, launched: false, reason: "claim_unavailable", watched: true });
    assert.equal(inner.entries.has("implement/TLSSN-42"), false);
    assert.deepEqual(inner.entries.get("implement-launch/index"), ["TLSSN-42"], "the watch will retake it after the grace");
    assert.equal(w.decisions().at(-1)?.["released"], "released");
    assert.equal(w.launcher.calls.length, 0);
  });

  test("the claim_unavailable release and the launch-failure release never delete another delivery's claim", async () => {
    const inner = memoryKv();
    const rival = { state: "pending", at: "2026-09-23T00:00:00.000Z", owner: "rival" };
    let reads = 0;
    const flaky: MemoryKv = {
      ...inner,
      get: async (key) => {
        if (key !== "implement/TLSSN-42") return inner.get(key);
        reads += 1;
        if (reads === 3) await inner.put(key, rival);
        if (reads >= 4 && reads <= 6) throw new Error("kv read failed");
        return inner.get(key);
      },
    };
    const w = worker({ kv: flaky });
    const delivery = await w.deliver(signedRequest(approvedBody()));
    assert.equal(delivery.status, 202);
    assert.deepEqual(inner.entries.get("implement/TLSSN-42"), rival);

    const kv = memoryKv();
    const launcher = fakeCreateAgent({
      fail: () => {
        void kv.put("implement/TLSSN-42", rival);
        return new Error("401 Unauthorized");
      },
    });
    const failing = worker({ kv, launcher });
    const launch = await failing.deliver(signedRequest(approvedBody()));
    assert.equal((launch.settled[0] as { value?: { launched?: boolean } } | undefined)?.value?.launched, false);
    assert.deepEqual(kv.entries.get("implement/TLSSN-42"), rival);
    assert.equal(failing.decisions().at(-1)?.["claimReleased"], false);
  });

  test("FACTORY_CLAIM_MODE=legacy reports claimReleased: true after a failed launch even when the delete throws, as main did", async () => {
    const launcher = fakeCreateAgent({ fail: () => new Error("401 Unauthorized") });
    const kv = memoryKv();
    const failingDelete: MemoryKv = {
      ...kv,
      delete: async (key) => {
        if (key === "implement/TLSSN-42") throw new Error("kv delete failed");
        await kv.delete(key);
      },
    };
    const w = worker({ kv: failingDelete, launcher, env: { ...ENV, FACTORY_CLAIM_MODE: "legacy" } });
    const delivery = await w.deliver(signedRequest(approvedBody()));
    assert.equal((delivery.settled[0] as { value?: { launched?: boolean } } | undefined)?.value?.launched, false);
    assert.equal(kv.entries.has("implement/TLSSN-42"), true, "the delete failed, so the pending claim is still there");
    assert.equal(w.decisions().at(-1)?.["outcome"], "launch_failed");
    assert.equal(w.decisions().at(-1)?.["claimReleased"], true);
  });

  test("FACTORY_CLAIM_MODE=legacy stores today's ownerless pending, does not settle, and logs what main logged", async () => {
    const launcher = fakeCreateAgent({ fail: () => new Error("401 Unauthorized") });
    const w = worker({ launcher, env: { ...ENV, FACTORY_CLAIM_MODE: "legacy", FACTORY_CLAIM_SETTLE_MS: "10000" } });
    const kvSeen: unknown[] = [];
    const original = w.kv.put;
    w.kv.put = async (key, value) => {
      if (key === "implement/TLSSN-42") kvSeen.push(value);
      await original(key, value);
    };
    const started = Date.now();
    await w.deliver(signedRequest(approvedBody()));
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(kvSeen, [{ state: "pending", at: "2026-09-23T00:00:00.000Z" }]);
    assert.equal(w.kv.entries.has("implement/TLSSN-42"), false, "legacy releases with a plain delete");
    assert.deepEqual(w.claims(), [], "no claim lines in legacy mode");
    assert.equal(w.lines.length, 1);
    assert.deepEqual(w.decisions()[0], {
      worker: "decision",
      outcome: "launch_failed",
      issueKey: "TLSSN-42",
      changelogId: "10042",
      via: "delivery",
      retried: false,
      claimReleased: true,
      recordCleared: "cleared",
      reason: "unauthorized",
      notice: "commented",
      watch: "opened",
      reminder: "unavailable",
      watchClosed: true,
      message: "factory-worker: launch did not start: 401 Unauthorized",
    });
  });
});

test("the handler passes its env to the implement PR index: FACTORY_INDEX_MERGE=off there gives the plain read-then-put", async () => {
  const shapes: Record<string, string[]> = {};
  for (const merge of ["on", "off"] as const) {
    const inner = memoryKv();
    const calls: string[] = [];
    const kv: MemoryKv = {
      ...inner,
      get: async (key) => {
        if (key === "implement-pr-watch/index") calls.push("get");
        return inner.get(key);
      },
      put: async (key, value) => {
        if (key === "implement-pr-watch/index") calls.push("put");
        await inner.put(key, value);
      },
    };
    const w = worker({ kv, env: merge === "off" ? { ...ENV, FACTORY_INDEX_MERGE: "off" } : ENV });
    const delivery = await w.deliver(signedRequest(approvedBody()));
    assert.equal(delivery.status, 202);
    shapes[merge] = calls;
  }
  // No reminders API here, so the arm writes the index once and stops before the create.
  assert.deepEqual(shapes, { on: ["get", "put", "get"], off: ["get", "put"] });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SendMessageOptions } from "@cursor/july";
import { LAUNCH_SENT_GRACE_MS } from "./claim.js";
import { approvedBody } from "./fixtures.js";
import { createHandler, createLaunchPipeline, type HandlerDeps } from "./handle.js";
import { implementSendOptions, parseImplementState, type ImplementSessionState } from "./implement-turn.js";
import type { AgentStatusName, ListAgents } from "./launch.js";
import { backgroundWork, BRIEF, ENV, fakeCreateAgent, fakeTracker, memoryKv, PLAN_COMMENT, signedRequest, TRIAGE_COMMENT, type FakeLauncher, type FakeTracker, type MemoryKv } from "./testing/fakes.js";

// The launch as a July cloud turn (implement-turn.ts): a delivery with the
// jira channel's `send` wired sends once and records nothing; the session's
// `agent.bound` and `turn.failed` events (channels/jira.ts) finish or fail
// the launch through the pipeline's `bound` and `turnFailed`.

const CLOUD = { cloudId: "https://<JIRA_SITE>.atlassian.net" };
const NOW = new Date("2026-09-23T00:00:00.000Z");
const CONTINUATION = "implement:TLSSN-42#10042";

type Sent = { message: string; options: SendMessageOptions };

function fakeSend(options: { fail?: (call: number) => Error | undefined } = {}) {
  const calls: Sent[] = [];
  const send = async (message: string, sendOptions: SendMessageOptions) => {
    calls.push({ message, options: sendOptions });
    const failure = options.fail?.(calls.length);
    if (failure !== undefined) throw failure;
    return { id: `ses_${calls.length}`, isNew: true, continuationToken: sendOptions.continuationToken ?? "" };
  };
  return { send, calls };
}

/** A kv whose puts on the ticket's claim fail while `failClaimPuts` is set: the record `bound` makes, lost, with the bound-agent record kept. */
function flakyClaimKv(): MemoryKv & { failClaimPuts: boolean } {
  const base = memoryKv();
  const flaky = {
    ...base,
    failClaimPuts: false,
    put: async (key: string, value: Parameters<MemoryKv["put"]>[1]) => {
      if (flaky.failClaimPuts && key === "implement/TLSSN-42") throw new Error("kv down");
      await base.put(key, value);
    },
  };
  return flaky;
}

/** `Agent.list` as July's cloud create leaves it: the agent is there, named by the server from its prompt, never `factory <KEY>: …`. */
function serverNamedListing(agentId: string, calls: number[]): ListAgents {
  return async () => {
    calls.push(1);
    return { items: [{ agentId, name: "Retry CSV export on empty filter", createdAt: NOW.getTime() + 60_000, lastModified: NOW.getTime() + 60_000 }] };
  };
}

function worker(
  options: {
    tracker?: FakeTracker;
    launcher?: FakeLauncher;
    kv?: MemoryKv;
    sender?: ReturnType<typeof fakeSend>;
    now?: () => Date;
    retired?: string[];
    listAgents?: ListAgents;
    agentStatus?: (agentId: string) => Promise<AgentStatusName>;
  } = {}
) {
  const tracker = options.tracker ?? fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const launcher = options.launcher ?? fakeCreateAgent();
  const kv = options.kv ?? memoryKv();
  const sender = options.sender ?? fakeSend();
  const lines: string[] = [];
  const retired = options.retired ?? [];
  const deps: HandlerDeps = {
    kv,
    mcp: tracker.mcp,
    createAgent: launcher.createAgent,
    send: sender.send,
    env: ENV,
    now: options.now ?? (() => NOW),
    log: (line) => lines.push(line),
    retireAgent: async (agentId) => {
      retired.push(agentId);
    },
    ...(options.listAgents === undefined ? {} : { listAgents: options.listAgents }),
    ...(options.agentStatus === undefined ? {} : { agentStatus: options.agentStatus }),
  };
  const handle = createHandler(deps);
  const pipeline = createLaunchPipeline(deps);
  const deliver = async (request: Request) => {
    const background = backgroundWork();
    const response = await handle(request, background);
    return { status: response.status, body: (await response.json()) as unknown, settled: await background.settle() };
  };
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const decisions = () => parsed().filter((line) => "worker" in line);
  const outcomes = () => decisions().map((line) => line["outcome"]);
  /** The session state the sent turn carries, as July hands it back to the channel's event handlers. */
  const sentState = (call = 0): ImplementSessionState => {
    const state = parseImplementState(JSON.parse(JSON.stringify(sender.calls[call]?.options.state)));
    assert.ok(state !== undefined, "the sent turn carries implement state");
    return state;
  };
  return { tracker, launcher, kv, sender, lines, deliver, pipeline, decisions, outcomes, sentState, retired };
}

function toolCalls(tracker: FakeTracker, tool: string) {
  return tracker.calls.filter((call) => call.tool === tool).map((call) => call.args);
}

const SENT_CLAIM = { state: "pending", at: "2026-09-23T00:00:00.000Z", sentAt: "2026-09-23T00:00:00.000Z" };

/** The ticket's claim without its `owner`, which the handler mints per run (a UUID). */
function sentClaim(kv: MemoryKv): unknown {
  const claim = kv.entries.get("implement/TLSSN-42");
  if (claim === null || typeof claim !== "object" || Array.isArray(claim)) return claim;
  const { owner, ...rest } = claim;
  assert.equal(typeof owner, "string");
  return rest;
}

test("an approved ticket starts one implement cloud turn from its brief: one send with the sandbox attached, the claim stamped sent, nothing recorded yet", async () => {
  const w = worker();
  const delivery = await w.deliver(signedRequest(approvedBody()));

  assert.equal(delivery.status, 202);
  assert.deepEqual(delivery.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
  assert.deepEqual(delivery.settled, [{ ok: true, value: { ok: true, launched: false, issueKey: "TLSSN-42", reason: "turn_sent", detail: CONTINUATION } }]);
  assert.equal(w.launcher.calls.length, 0, "no SDK create on the delivery path");
  assert.equal(w.sender.calls.length, 1);
  const sent = w.sender.calls[0]!;
  assert.ok(sent.message.startsWith(`${BRIEF}\n\n## Handing off the change`));
  const owner = (w.kv.entries.get("implement/TLSSN-42") as { owner: string }).owner;
  const state: ImplementSessionState = { kind: "implement", issueKey: "TLSSN-42", changelogId: "10042", title: "Retry CSV export on empty filter", at: "2026-09-23T00:00:00.000Z", owner, retried: false };
  assert.deepEqual(
    sent.options,
    implementSendOptions({
      issueKey: "TLSSN-42",
      changelogId: "10042",
      title: "Retry CSV export on empty filter",
      brief: BRIEF,
      repo: "example-org/demo-repo",
      ref: "main",
      state,
    })
  );
  assert.deepEqual(sent.options.cloud, { repos: [{ url: "https://github.com/example-org/demo-repo", startingRef: "main" }], autoCreatePR: false });
  // The live turn runs agent.ts's model; a modelConfig on the send is refused by July 0.2.18 (deployment-issues.md issue 27).
  assert.equal(sent.options.modelConfig, undefined);
  assert.deepEqual(sentClaim(w.kv), SENT_CLAIM);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), []);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), []);
  assert.equal(w.tracker.status(), "Approved");
  assert.deepEqual(w.outcomes(), ["turn_sent"]);
  assert.equal(w.decisions()[0]?.["continuation"], CONTINUATION);
  assert.equal(w.decisions()[0]?.["sentMarked"], true);
});

test("agent.bound on that session records the agent, comments its URL, moves the ticket to In Progress, and a redelivery is then a duplicate", async () => {
  const w = worker();
  await w.deliver(signedRequest(approvedBody()));
  const outcome = await w.pipeline.bound(w.sentState(), { sdkAgentId: "bc-july-1", url: "https://cursor.com/agents/bc-july-1" });

  assert.deepEqual(outcome, {
    ok: true,
    launched: true,
    issueKey: "TLSSN-42",
    agentId: "bc-july-1",
    url: "https://cursor.com/agents/bc-july-1",
    transition: "transitioned",
    comment: "commented",
    recorded: true,
    prWatch: "unavailable",
  });
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [{ ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Implementing: https://cursor.com/agents/bc-july-1" }]);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), [{ ...CLOUD, issueIdOrKey: "TLSSN-42", transition: { id: "31" } }]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), {
    state: "launched",
    at: "2026-09-23T00:00:00.000Z",
    agentId: "bc-july-1",
    url: "https://cursor.com/agents/bc-july-1",
    commented: true,
    moved: true,
  });
  assert.deepEqual(w.outcomes(), ["turn_sent", "launched"]);

  const again = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(again.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false });
  assert.equal(w.sender.calls.length, 1);
  assert.equal(w.launcher.calls.length, 0);
});

test("a replay of the delivery between the send and the binding sends nothing again: the claim is in flight", async () => {
  const w = worker();
  const first = await w.deliver(signedRequest(approvedBody()));
  assert.equal(first.status, 202);
  const replay = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(replay.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", inFlight: true });
  assert.deepEqual(replay.settled, []);
  assert.equal(w.sender.calls.length, 1);
  assert.deepEqual(sentClaim(w.kv), SENT_CLAIM);
});

test("a new approval while the first is still unbound waits for the sent grace; after it the ticket is taken over and sent again", async () => {
  let now = NOW;
  const w = worker({ now: () => now });
  await w.deliver(signedRequest(approvedBody()));
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS);
  const waiting = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(waiting.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", inFlight: true });
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  const taken = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(taken.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
  assert.equal(w.sender.calls.length, 2);
  assert.equal(w.sender.calls[1]?.options.continuationToken, "implement:TLSSN-42#10077", "a new approval is a new session");
  assert.equal(w.sentState(1).retried, true);
});

test("turn.failed before the binding is the launch failing: the claim is released, one Launch failed: line, and the next approval sends again", async () => {
  const w = worker();
  await w.deliver(signedRequest(approvedBody()));
  const outcome = await w.pipeline.turnFailed(w.sentState(), { message: "cloud agent could not be started: upstream 503", status: "error" });

  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "service_unavailable" });
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [
    { ...CLOUD, issueIdOrKey: "TLSSN-42", commentBody: "Launch failed: service_unavailable. Moving the card to Approved again retries." },
  ]);
  assert.deepEqual(toolCalls(w.tracker, "transitionJiraIssue"), []);
  assert.deepEqual(w.outcomes(), ["turn_sent", "launch_failed"]);

  const retried = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(retried.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
  assert.equal(w.sender.calls.length, 2);
  assert.equal(w.launcher.calls.length, 0);
});

test("a cancelled turn before the binding releases the claim under its own reason", async () => {
  const w = worker();
  await w.deliver(signedRequest(approvedBody()));
  const outcome = await w.pipeline.turnFailed(w.sentState(), { message: "turn interrupted", status: "cancelled" });
  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "cancelled" });
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), ["Launch failed: cancelled. Moving the card to Approved again retries."]);
});

test("turn.failed after the binding changes nothing: the agent ran and stopped, which the PR watch reports", async () => {
  const w = worker();
  await w.deliver(signedRequest(approvedBody()));
  await w.pipeline.bound(w.sentState(), { sdkAgentId: "bc-july-1" });
  const launched = w.kv.entries.get("implement/TLSSN-42");
  const comments = toolCalls(w.tracker, "addCommentToJiraIssue").length;

  const outcome = await w.pipeline.turnFailed(w.sentState(), { message: "agent run failed", status: "error" });
  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "turn_failed_after_launch" });
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), launched);
  assert.equal(toolCalls(w.tracker, "addCommentToJiraIssue").length, comments);
  assert.equal(w.tracker.status(), "In Progress");
  assert.deepEqual(w.outcomes(), ["turn_sent", "launched", "turn_failed_after_launch"]);
});

test("a send July refuses is a launch failure: the claim is released and one sanitized Launch failed: line names the reason", async () => {
  const sender = fakeSend({
    fail: (call) => (call === 1 ? Object.assign(new Error("[invalid_model] Model 'claude-opus-5-5' does not match a known variant. token=not-a-real-token"), { code: "invalid_model", status: 400 }) : undefined),
  });
  const w = worker({ sender });
  const delivery = await w.deliver(signedRequest(approvedBody()));

  assert.equal(delivery.status, 202);
  assert.deepEqual(delivery.settled, [{ ok: true, value: { ok: true, launched: false, issueKey: "TLSSN-42", reason: "invalid_model" } }]);
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), ["Launch failed: invalid_model. Moving the card to Approved again retries."]);
  assert.ok(!JSON.stringify(w.tracker.calls).includes("not-a-real-token"));
  assert.deepEqual(w.outcomes(), ["launch_failed"]);

  const retried = await w.deliver(signedRequest(approvedBody()));
  assert.deepEqual(retried.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
  assert.deepEqual(sentClaim(w.kv), SENT_CLAIM);
  assert.equal(w.launcher.calls.length, 0);
});

test("agent.bound for a session whose claim a takeover owns records nothing and retires the late agent", async () => {
  let now = NOW;
  const w = worker({ now: () => now });
  await w.deliver(signedRequest(approvedBody()));
  const first = w.sentState();
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  await w.pipeline.bound(w.sentState(1), { sdkAgentId: "bc-july-2" });
  assert.equal(w.tracker.status(), "In Progress");

  const late = await w.pipeline.bound(first, { sdkAgentId: "bc-july-1" });
  assert.equal(late.launched, false);
  assert.deepEqual(w.retired, ["bc-july-1"]);
  assert.deepEqual((w.kv.entries.get("implement/TLSSN-42") as { agentId: string }).agentId, "bc-july-2");
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), ["Implementing: https://cursor.com/agents/bc-july-2"]);
});

test("the SDK launch still runs when no send is wired: the heal's path and the older tests are unchanged", async () => {
  const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const launcher = fakeCreateAgent();
  const handle = createHandler({ kv: memoryKv(), mcp: tracker.mcp, createAgent: launcher.createAgent, env: ENV, now: () => NOW, log: () => {} });
  const background = backgroundWork();
  const response = await handle(signedRequest(approvedBody()), background);
  assert.equal(response.status, 202);
  const settled = await background.settle();
  assert.equal((settled[0] as { value: { launched: boolean } }).value.launched, true);
  assert.equal(launcher.calls.length, 1);
});

const BOUND_RECORD = { agentId: "bc-july-1", url: "https://cursor.com/agents/bc-july-1", changelogId: "10042", at: "2026-09-23T00:00:00.000Z", boundAt: "2026-09-23T00:00:00.000Z" };

/** A delivery whose binding landed but whose record and comment did not: the agent runs, the claim is still pending and sent, and only `implement-agent/<KEY>` names it. */
async function lostBinding(options: { listed?: number[]; agentStatus?: (agentId: string) => Promise<AgentStatusName> } = {}) {
  let now = NOW;
  const kv = flakyClaimKv();
  const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT], commentFailures: 1 });
  const w = worker({
    kv,
    tracker,
    now: () => now,
    ...(options.listed === undefined ? {} : { listAgents: serverNamedListing("bc-july-1", options.listed) }),
    ...(options.agentStatus === undefined ? {} : { agentStatus: options.agentStatus }),
  });
  await w.deliver(signedRequest(approvedBody()));
  kv.failClaimPuts = true;
  const bound = await w.pipeline.bound(w.sentState(), { sdkAgentId: "bc-july-1" });
  kv.failClaimPuts = false;
  assert.equal(bound.launched, true);
  assert.deepEqual({ ...bound, launched: undefined }, { ...bound, launched: undefined, recorded: false, comment: "failed" });
  assert.deepEqual(sentClaim(kv), SENT_CLAIM, "the claim is still the delivery's pending, sent one");
  assert.deepEqual(kv.entries.get("implement-agent/TLSSN-42"), BOUND_RECORD, "the binding was noted before the claim was touched");
  assert.equal(tracker.status(), "Approved");
  return { w, kv, tracker, setNow: (date: Date) => (now = date) };
}

test("agent.bound notes the agent at implement-agent/<KEY> before the claim: a binding whose record and comment failed leaves that behind, and after the sent grace a new approval adopts the agent instead of sending again, without any listing", async () => {
  const listed: number[] = [];
  const { w, kv, tracker, setNow } = await lostBinding({ listed });
  setNow(new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1));

  const taken = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(taken.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
  assert.equal(w.sender.calls.length, 1, "no second cloud turn");
  assert.equal(w.launcher.calls.length, 0, "no SDK relaunch");
  assert.deepEqual(listed, [], "the agent is known by its record, so the listing (where July's agent carries the server's name) is never asked");
  assert.deepEqual(toolCalls(tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), [
    "Implementing: https://cursor.com/agents/bc-july-1",
    "Implementing: https://cursor.com/agents/bc-july-1\nRecovered by factory-worker: an earlier launch for this approval started this agent but never recorded it, so no second agent was started.",
  ]);
  assert.deepEqual(kv.entries.get("implement/TLSSN-42"), { state: "launched", at: new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1).toISOString(), agentId: "bc-july-1", url: "https://cursor.com/agents/bc-july-1", commented: true, moved: true });
  assert.equal(tracker.status(), "In Progress");
  assert.deepEqual(w.retired, []);
  const launched = w.decisions().find((line) => line["outcome"] === "launched" && line["changelogId"] === "10077");
  assert.equal(launched?.["adopted"], true);
  assert.equal(launched?.["agentId"], "bc-july-1");
});

test("the launch watch's heal adopts the agent July bound the same way: the SDK relaunch never runs", async () => {
  const listed: number[] = [];
  const { w, kv, tracker, setNow } = await lostBinding({ listed });
  setNow(new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1));

  const work: Promise<unknown>[] = [];
  const reply = await w.pipeline.approve({ issueKey: "TLSSN-42", changelogId: "10042", title: "Retry CSV export on empty filter", via: "heal", attempt: 1 }, (promise) => work.push(promise));
  await Promise.all(work);
  assert.deepEqual(reply, { status: 202, body: { ok: true, launching: true, issueKey: "TLSSN-42", retried: true } });
  assert.equal(w.launcher.calls.length, 0, "no SDK relaunch");
  assert.equal(w.sender.calls.length, 1);
  assert.deepEqual(listed, []);
  assert.equal((kv.entries.get("implement/TLSSN-42") as { agentId: string }).agentId, "bc-july-1");
  assert.equal(tracker.status(), "In Progress");
  assert.equal(toolCalls(tracker, "addCommentToJiraIssue").at(-1)?.["commentBody"], "Implementing: https://cursor.com/agents/bc-july-1\nRecovered by factory-worker: an earlier launch for this approval started this agent but never recorded it, so no second agent was started.");
});

test("a bound-agent record from before the replaced claim is not adopted: the listing (and then a launch) decides", async () => {
  let now = NOW;
  const listed: number[] = [];
  const kv = memoryKv();
  await kv.put("implement-agent/TLSSN-42", { ...BOUND_RECORD, changelogId: "9000", at: "2026-09-22T00:00:00.000Z", boundAt: "2026-09-22T00:05:00.000Z" });
  const w = worker({ kv, now: () => now, listAgents: serverNamedListing("bc-old-1", listed) });
  await w.deliver(signedRequest(approvedBody()));
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  const taken = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(taken.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
  assert.equal(listed.length, 1, "the stale record is skipped and the listing asked");
  assert.equal(w.sender.calls.length, 2, "the server-named agent in the listing is not this ticket's by name, so the takeover sends again");
});

test("turn.failed while the session's agent is still running is not a launch failure: the claim and the ticket are left alone", async () => {
  const asked: string[] = [];
  const w = worker({
    agentStatus: async (agentId) => {
      asked.push(agentId);
      return "running";
    },
  });
  await w.deliver(signedRequest(approvedBody()));
  const outcome = await w.pipeline.turnFailed(w.sentState(), { message: "[unauthenticated] token expired", status: "error" }, { sdkAgentId: "bc-july-1" });

  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "turn_failed_agent_alive", detail: "bc-july-1" });
  assert.deepEqual(asked, ["bc-july-1"]);
  assert.deepEqual(sentClaim(w.kv), SENT_CLAIM, "the claim is kept for the heal, which adopts the agent");
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), [], "no Launch failed: line");
  assert.equal(w.tracker.status(), "Approved");
  assert.deepEqual(w.outcomes(), ["turn_sent", "turn_failed_agent_alive"]);
  assert.equal(w.decisions()[1]?.["agentStatus"], "running");
});

test("turn.failed with no agent id on the session reads the noted binding: a finished agent is not a failed launch, a status that cannot be read is not either", async () => {
  const statuses: AgentStatusName[] = ["finished", "unknown"];
  const { w, kv } = await lostBinding({ agentStatus: async () => statuses.shift() ?? "unknown" });
  const comments = toolCalls(w.tracker, "addCommentToJiraIssue").length;

  const finished = await w.pipeline.turnFailed(w.sentState(), { message: "stream closed", status: "error" });
  assert.deepEqual(finished, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "turn_failed_agent_alive", detail: "bc-july-1" });
  const unknown = await w.pipeline.turnFailed(w.sentState(), { message: "stream closed", status: "error" });
  assert.deepEqual(unknown, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "turn_failed_status_unknown", detail: "bc-july-1" });
  assert.deepEqual(sentClaim(kv), SENT_CLAIM);
  assert.equal(toolCalls(w.tracker, "addCommentToJiraIssue").length, comments);
  assert.deepEqual(w.outcomes().slice(-2), ["turn_failed_agent_alive", "turn_failed_status_unknown"]);
});

test("turn.failed whose agent the SDK reports in error is the launch failing after all: the claim is released and Launch failed: posted", async () => {
  const w = worker({ agentStatus: async () => "error" });
  await w.deliver(signedRequest(approvedBody()));
  const outcome = await w.pipeline.turnFailed(w.sentState(), { message: "cloud agent could not be started: upstream 503", status: "error" }, { sdkAgentId: "bc-july-1" });
  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "service_unavailable" });
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), ["Launch failed: service_unavailable. Moving the card to Approved again retries."]);
});

test("a failed launch clears the bound-agent record: a retry whose binding is also lost does not adopt the dead agent", async () => {
  let now = NOW;
  const listed: number[] = [];
  const statuses = new Map<string, AgentStatusName>([["bc-july-1", "error"]]);
  const w = worker({ now: () => now, listAgents: serverNamedListing("bc-july-1", listed), agentStatus: async (agentId) => statuses.get(agentId) ?? "running" });
  await w.deliver(signedRequest(approvedBody()));
  await w.kv.put("implement-agent/TLSSN-42", BOUND_RECORD);
  const failed = await w.pipeline.turnFailed(w.sentState(), { message: "agent run failed", status: "error" }, { sdkAgentId: "bc-july-1" });
  assert.deepEqual(failed, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "unknown_error" });
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.equal(w.kv.entries.has("implement-agent/TLSSN-42"), false, "the dead agent's record went with the claim");

  now = new Date(NOW.getTime() + 2 * 60_000);
  const retry = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(retry.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
  assert.equal(w.sender.calls.length, 2, "the retry is a new cloud turn");
  now = new Date(now.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  const taken = await w.deliver(signedRequest(approvedBody({ changelogId: "10078" })));
  assert.deepEqual(taken.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
  assert.equal(w.sender.calls.length, 3, "the takeover sends again: no record, nothing in the listing by name");
  assert.equal(listed.length, 1);
  assert.deepEqual(w.retired, []);
  assert.ok(!w.outcomes().some((outcome) => outcome === "launched"), "nothing was adopted");
});

test("a bound-agent record a clear missed is still not adopted when the SDK reports the agent in error or cancelled: the record is dropped and the takeover launches", async () => {
  let now = NOW;
  const listed: number[] = [];
  const asked: string[] = [];
  const kv = memoryKv();
  const w = worker({
    kv,
    now: () => now,
    listAgents: serverNamedListing("bc-july-1", listed),
    agentStatus: async (agentId) => {
      asked.push(agentId);
      return "cancelled";
    },
  });
  await w.deliver(signedRequest(approvedBody()));
  // The record of a dead agent, left behind as if `launchFailed`'s clear had been unavailable; within BOUND_SKEW_MS of the takeover.
  await kv.put("implement-agent/TLSSN-42", BOUND_RECORD);
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  const taken = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(taken.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
  assert.deepEqual(asked, ["bc-july-1"]);
  assert.equal(kv.entries.has("implement-agent/TLSSN-42"), false, "the dead agent's record is dropped");
  assert.equal(listed.length, 1, "the listing is asked next");
  assert.equal(w.sender.calls.length, 2, "and the takeover sends again rather than adopting");
  const dead = w.decisions().find((line) => line["outcome"] === "bound_agent_dead");
  assert.equal(dead?.["agentId"], "bc-july-1");
  assert.equal(dead?.["agentStatus"], "cancelled");
  assert.equal(dead?.["cleared"], "cleared");
});

test("a bound-agent record whose agent's status cannot be read is not adopted and not replaced: the claim stays pending for the watch", async () => {
  const listed: number[] = [];
  const { w, kv, setNow } = await lostBinding({ listed, agentStatus: async () => "unknown" });
  setNow(new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1));
  const taken = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(taken.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
  assert.equal(w.sender.calls.length, 1, "no second cloud turn");
  assert.equal(w.launcher.calls.length, 0);
  assert.deepEqual(listed, [], "no listing either: the record names the agent, only its status is missing");
  assert.deepEqual(kv.entries.get("implement-agent/TLSSN-42"), BOUND_RECORD, "the record is kept");
  assert.equal((kv.entries.get("implement/TLSSN-42") as { state: string }).state, "pending");
  const unverified = w.decisions().find((line) => line["outcome"] === "agent_unverified");
  assert.equal(unverified?.["why"], "bound agent bc-july-1: status unreadable");
});

test("retiring an orphaned late binding drops its record too", async () => {
  let now = NOW;
  const w = worker({ now: () => now });
  await w.deliver(signedRequest(approvedBody()));
  const first = w.sentState();
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  await w.pipeline.bound(w.sentState(1), { sdkAgentId: "bc-july-2" });
  await w.pipeline.bound(first, { sdkAgentId: "bc-july-1" });
  assert.deepEqual(w.retired, ["bc-july-1"]);
  assert.equal(w.kv.entries.has("implement-agent/TLSSN-42"), false, "the retired agent's record is gone");
});

test("a binding that lands after the heal looked and before it recorded its own agent is retired once the heal's launch is recorded (the kept race)", async () => {
  let now = NOW;
  const kv = memoryKv();
  const launcher = fakeCreateAgent();
  const w = worker({ kv, now: () => now, launcher });
  await w.deliver(signedRequest(approvedBody()));
  const first = w.sentState();
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  // The heal's `createAgent` runs after its `existingAgent` found nothing; the binding lands in that gap and meets the heal's pending claim (`kept`).
  const originalCreate = launcher.createAgent;
  let bindOnce: Promise<unknown> | undefined;
  const w2 = worker({
    kv,
    now: () => now,
    tracker: w.tracker,
    retired: w.retired,
    launcher: {
      ...launcher,
      createAgent: async (options) => {
        bindOnce ??= w.pipeline.bound(first, { sdkAgentId: "bc-july-1" });
        await bindOnce;
        return originalCreate(options);
      },
    },
  });
  const work: Promise<unknown>[] = [];
  const reply = await w2.pipeline.approve({ issueKey: "TLSSN-42", changelogId: "10042", title: "Retry CSV export on empty filter", via: "heal", attempt: 1 }, (promise) => work.push(promise));
  await Promise.all(work);
  assert.deepEqual(reply, { status: 202, body: { ok: true, launching: true, issueKey: "TLSSN-42", retried: true } });
  const bound = await bindOnce;
  assert.equal((bound as { launched: boolean }).launched, false, "the binding's record was refused: the heal's pending claim is another run's");
  assert.deepEqual(w.retired, ["bc-july-1"], "the heal retired the late-bound agent once its own launch was recorded");
  assert.equal(kv.entries.has("implement-agent/TLSSN-42"), false);
  const heal = (kv.entries.get("implement/TLSSN-42") as { agentId: string }).agentId;
  assert.notEqual(heal, "bc-july-1");
  const retiredLine = w2.decisions().find((line) => line["outcome"] === "late_bound_retired");
  assert.equal(retiredLine?.["agentId"], "bc-july-1");
  assert.equal(retiredLine?.["keptAgentId"], heal);
});

/** A lost first launch taken over by a second delivery after the sent grace; the first session then binds its agent late, which meets the takeover's pending claim (`kept`). */
async function lateFirstBinding(options: { agentStatus?: (agentId: string) => Promise<AgentStatusName> } = {}) {
  let now = NOW;
  const w = worker({ now: () => now, ...(options.agentStatus === undefined ? {} : { agentStatus: options.agentStatus }) });
  await w.deliver(signedRequest(approvedBody()));
  const first = w.sentState();
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  const taken = await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  assert.deepEqual(taken.body, { ok: true, launching: true, issueKey: "TLSSN-42", retried: true });
  assert.equal(w.sender.calls.length, 2);
  const takeover = w.sentState(1);
  assert.equal(takeover.takenOverAt, NOW.toISOString(), "the takeover's session carries the replaced claim's at");
  const late = await w.pipeline.bound(first, { sdkAgentId: "bc-july-1" });
  assert.equal(late.launched, false, "the first binding meets the takeover's pending claim");
  assert.deepEqual(w.retired, [], "and is kept for the takeover to adopt");
  assert.equal((w.kv.entries.get("implement-agent/TLSSN-42") as { agentId: string }).agentId, "bc-july-1");
  return { w, first, takeover, now: () => now };
}

test("a takeover whose turn fails with no agent of its own adopts the first agent that bound late during its claim: no Launch failed: line, no third agent, the record kept", async () => {
  const { w, takeover } = await lateFirstBinding({ agentStatus: async () => "running" });
  const outcome = await w.pipeline.turnFailed(takeover, { message: "cloud agent could not be started: upstream 503", status: "error" });
  assert.equal(outcome.launched, true);
  assert.deepEqual({ ...outcome, prWatch: undefined }, { ...outcome, prWatch: undefined, agentId: "bc-july-1", recorded: true, adopted: true });
  assert.equal((w.kv.entries.get("implement-agent/TLSSN-42") as { agentId: string }).agentId, "bc-july-1", "the first agent's record survives the takeover's failure");
  assert.deepEqual(w.kv.entries.get("implement/TLSSN-42"), { state: "launched", at: takeover.at, agentId: "bc-july-1", url: "https://cursor.com/agents/bc-july-1", commented: true, moved: true });
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), [
    "Implementing: https://cursor.com/agents/bc-july-1\nRecovered by factory-worker: an earlier launch for this approval started this agent but never recorded it, so no second agent was started.",
  ]);
  assert.equal(w.tracker.status(), "In Progress");
  assert.equal(w.sender.calls.length, 2, "no third cloud turn");
  assert.deepEqual(w.retired, []);
  assert.deepEqual(w.outcomes().slice(-2), ["turn_failed_late_bound", "launched"]);
  const retry = await w.deliver(signedRequest(approvedBody({ changelogId: "10078" })));
  assert.deepEqual(retry.body, { ok: true, duplicate: true, issueKey: "TLSSN-42", reposted: false }, "a later approval meets the launched claim");
});

test("a takeover whose own agent died adopts the live first agent too: its own record alone would be cleared, the first agent's is kept", async () => {
  const statuses = new Map<string, AgentStatusName>([["bc-july-1", "running"], ["bc-july-2", "error"]]);
  const { w, takeover } = await lateFirstBinding({ agentStatus: async (agentId) => statuses.get(agentId) ?? "unknown" });
  const outcome = await w.pipeline.turnFailed(takeover, { message: "agent run failed", status: "error" }, { sdkAgentId: "bc-july-2" });
  assert.equal(outcome.launched, true);
  assert.equal((outcome as { agentId: string }).agentId, "bc-july-1");
  assert.equal((w.kv.entries.get("implement-agent/TLSSN-42") as { agentId: string }).agentId, "bc-july-1");
  assert.ok(!toolCalls(w.tracker, "addCommentToJiraIssue").some((args) => String(args["commentBody"]).startsWith("Launch failed:")));
});

test("a late-bound first agent that is itself dead does not save the failed takeover: its record is dropped, Launch failed: posted, and a retry sends a new turn", async () => {
  const { w, takeover } = await lateFirstBinding({ agentStatus: async () => "error" });
  const outcome = await w.pipeline.turnFailed(takeover, { message: "cloud agent could not be started: upstream 503", status: "error" });
  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "service_unavailable" });
  assert.equal(w.kv.entries.has("implement-agent/TLSSN-42"), false);
  assert.equal(w.kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), ["Launch failed: service_unavailable. Moving the card to Approved again retries."]);
  assert.deepEqual(w.outcomes().slice(-2), ["bound_agent_dead", "launch_failed"]);
  const retry = await w.deliver(signedRequest(approvedBody({ changelogId: "10078" })));
  assert.deepEqual(retry.body, { ok: true, launching: true, issueKey: "TLSSN-42" });
  assert.equal(w.sender.calls.length, 3);
});

test("a late-bound first agent whose status cannot be read leaves the failed takeover's claim pending for the heal, which adopts it", async () => {
  const statuses: AgentStatusName[] = ["unknown"];
  const { w, takeover } = await lateFirstBinding({ agentStatus: async () => statuses.shift() ?? "running" });
  const outcome = await w.pipeline.turnFailed(takeover, { message: "stream closed", status: "error" });
  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "turn_failed_status_unknown", detail: "bc-july-1" });
  assert.equal((w.kv.entries.get("implement/TLSSN-42") as { state: string }).state, "pending");
  assert.equal((w.kv.entries.get("implement-agent/TLSSN-42") as { agentId: string }).agentId, "bc-july-1");
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue"), []);
});

test("a cloud-turn takeover that binds its own agent retires the first agent that bound late during its claim, and its own record stands", async () => {
  const { w, takeover } = await lateFirstBinding();
  const second = await w.pipeline.bound(takeover, { sdkAgentId: "bc-july-2" });
  assert.equal(second.launched, true);
  assert.deepEqual(w.retired, ["bc-july-1"], "the kept first agent is retired once the takeover's launch is recorded");
  assert.deepEqual(w.kv.entries.get("implement-agent/TLSSN-42"), { agentId: "bc-july-2", url: "https://cursor.com/agents/bc-july-2", changelogId: "10077", at: takeover.at, boundAt: takeover.at });
  assert.equal((w.kv.entries.get("implement/TLSSN-42") as { agentId: string }).agentId, "bc-july-2");
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), ["Implementing: https://cursor.com/agents/bc-july-2"]);
  const retiredLine = w.decisions().find((line) => line["outcome"] === "late_bound_retired");
  assert.equal(retiredLine?.["agentId"], "bc-july-1");
  assert.equal(retiredLine?.["keptAgentId"], "bc-july-2");
  assert.equal(retiredLine?.["cleared"], "cleared", "the first agent's record goes before the takeover writes its own");
  assert.deepEqual(w.outcomes().slice(-2), ["late_bound_retired", "launched"]);
});

/** A kv that runs `after` once a put lands a value matching `when` on `key`: another handler's steps, interleaved at that exact point. */
function interleavingKv(key: string, when: (value: unknown) => boolean, after: () => Promise<void>): MemoryKv {
  const base = memoryKv();
  let fired = false;
  return {
    ...base,
    put: async (k: string, value: Parameters<MemoryKv["put"]>[1]) => {
      await base.put(k, value);
      if (!fired && k === key && when(value)) {
        fired = true;
        await after();
      }
    },
  };
}

test("a first agent binding in the gap between the takeover's claim write and its record read is retired by its own orphan check, once", async () => {
  // The order Bugbot's race needs: the takeover has written the launched claim but not yet looked for a late record, and only then does the first binding land.
  let now = NOW;
  let pending: (() => Promise<void>) | undefined;
  const kv = interleavingKv(
    "implement/TLSSN-42",
    (value) => (value as { state: string; agentId?: string }).state === "launched" && (value as { agentId?: string }).agentId === "bc-july-2",
    async () => pending?.()
  );
  const w = worker({ kv, now: () => now });
  await w.deliver(signedRequest(approvedBody()));
  const first = w.sentState();
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  const takeover = w.sentState(1);
  pending = async () => {
    const late = await w.pipeline.bound(first, { sdkAgentId: "bc-july-1" });
    assert.equal(late.launched, false);
  };
  const second = await w.pipeline.bound(takeover, { sdkAgentId: "bc-july-2" });
  assert.equal(second.launched, true);
  assert.deepEqual(w.retired, ["bc-july-1"], "the first binding read a launched claim naming another agent and retired itself");
  assert.deepEqual(w.kv.entries.get("implement-agent/TLSSN-42"), { agentId: "bc-july-2", url: "https://cursor.com/agents/bc-july-2", changelogId: "10077", at: takeover.at, boundAt: takeover.at });
  assert.equal((w.kv.entries.get("implement/TLSSN-42") as { agentId: string }).agentId, "bc-july-2");
  assert.ok(!w.outcomes().includes("late_bound_retired"), "nothing was left for retireLateBound to find");
  assert.deepEqual(toolCalls(w.tracker, "addCommentToJiraIssue").map((args) => args["commentBody"]), ["Implementing: https://cursor.com/agents/bc-july-2"]);
});

test("a takeover's agent kept against a later takeover's pending claim writes its record and looks again: a claim launched meanwhile by that takeover retires it", async () => {
  let now = NOW;
  const kv = interleavingKv(
    "implement-agent/TLSSN-42",
    (value) => (value as { agentId: string }).agentId === "bc-july-2",
    async () => {
      // The third launch records its own agent right after reading an empty record: it missed this one.
      const claim = kv.entries.get("implement/TLSSN-42") as Record<string, unknown>;
      kv.entries.set("implement/TLSSN-42", { ...claim, state: "launched", agentId: "bc-july-3", url: "https://cursor.com/agents/bc-july-3", commented: true, moved: false });
    }
  );
  const w = worker({ kv, now: () => now });
  await w.deliver(signedRequest(approvedBody()));
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  const second = w.sentState(1);
  now = new Date(now.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  await w.deliver(signedRequest(approvedBody({ changelogId: "10078" })));
  assert.equal(w.sender.calls.length, 3);
  const outcome = await w.pipeline.bound(second, { sdkAgentId: "bc-july-2" });
  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "superseded", detail: "archived" });
  assert.deepEqual(w.retired, ["bc-july-2"]);
  assert.equal(w.kv.entries.has("implement-agent/TLSSN-42"), false, "the retired agent's record is dropped");
  assert.equal((w.kv.entries.get("implement/TLSSN-42") as { agentId: string }).agentId, "bc-july-3");
});

test("a takeover's agent kept against a later takeover's still-pending claim leaves its record for that takeover to adopt", async () => {
  let now = NOW;
  const w = worker({ now: () => now });
  await w.deliver(signedRequest(approvedBody()));
  now = new Date(NOW.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  await w.deliver(signedRequest(approvedBody({ changelogId: "10077" })));
  const second = w.sentState(1);
  now = new Date(now.getTime() + LAUNCH_SENT_GRACE_MS + 1);
  await w.deliver(signedRequest(approvedBody({ changelogId: "10078" })));
  const third = w.sentState(2);
  const outcome = await w.pipeline.bound(second, { sdkAgentId: "bc-july-2" });
  assert.deepEqual(outcome, { ok: true, launched: false, issueKey: "TLSSN-42", reason: "superseded", detail: "kept" });
  assert.deepEqual(w.retired, []);
  assert.equal((w.kv.entries.get("implement-agent/TLSSN-42") as { agentId: string }).agentId, "bc-july-2", "written after the claim was read, for the third launch");
  // The third launch's own binding then retires the kept agent, as a late binding of the launch it replaced.
  const last = await w.pipeline.bound(third, { sdkAgentId: "bc-july-3" });
  assert.equal(last.launched, true);
  assert.deepEqual(w.retired, ["bc-july-2"]);
  assert.equal((w.kv.entries.get("implement-agent/TLSSN-42") as { agentId: string }).agentId, "bc-july-3");
});

test("a first delivery's binding (no takeover) retires nothing and carries no takenOverAt", async () => {
  const w = worker();
  await w.deliver(signedRequest(approvedBody()));
  assert.equal(w.sentState().takenOverAt, undefined);
  await w.pipeline.bound(w.sentState(), { sdkAgentId: "bc-july-1" });
  assert.deepEqual(w.retired, []);
  assert.ok(!w.outcomes().includes("late_bound_retired"));
});

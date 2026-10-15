import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadAgentProject } from "@cursor/july";
import type { ChannelEventHandler, HostContext } from "@cursor/july";
import { claimImplementation, markLaunchSent } from "../lib/claim.js";
import { implementContinuation, type ImplementSessionState } from "../lib/implement-turn.js";
import { claimRunFor, fakeTracker, memoryKv, PLAN_COMMENT, TRIAGE_COMMENT } from "../lib/testing/fakes.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// github.ts reads sandboxReposAtBoot() while the project loads.
process.env.FACTORY_SANDBOX_REPO = "cursor-demo-lab/marsbank";
process.env.FACTORY_JIRA_PROJECTS = "TLSSN";
process.env.FACTORY_CLAIM_SETTLE_MS = "1";
delete process.env.FACTORY_REPOS;

const projectReady = loadAgentProject(ROOT);

type Handler = ChannelEventHandler<unknown, never>;

async function jiraEvents(): Promise<Record<string, Handler>> {
  const project = await projectReady;
  const jira = project.channels.find((channel) => channel.id === "jira");
  assert.ok(jira !== undefined, "the jira channel is mounted");
  return (jira.definition as { events?: Record<string, Handler> }).events ?? {};
}

/** The channel event context and session context as July's session engine builds them. */
function dispatch(input: { state: unknown; continuationToken: string | null; host: Pick<HostContext, "kv" | "mcp"> }) {
  const channel = { channelId: "jira", state: input.state, continuationToken: input.continuationToken, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_1", channelId: "jira", title: null }, host: input.host as HostContext, artifacts: {} };
  return { channel, ctx };
}

const STATE: ImplementSessionState = { kind: "implement", issueKey: "TLSSN-42", changelogId: "10042", title: "Retry CSV export on empty filter", at: "2026-09-23T00:00:00.000Z", owner: "owner-1", retried: false };

test("the project runs the implement turn on a cloud agent July can attribute: no tool allowlist, auto PR off, local otherwise, the ticket-key hook and the gated http channel mounted", async () => {
  const project = await projectReady;
  assert.equal(project.agent.runtime, "local");
  assert.equal(project.agent.allowedTools, undefined, "July refuses a per-send cloud attach on an agent that declares tools");
  assert.deepEqual(project.agent.cloud, { autoCreatePR: false });
  assert.deepEqual(project.hooks.map((hook) => hook.name).sort(), ["ticket-key"]);
  assert.equal(typeof project.httpChannel?.onMessage, "function");
  assert.deepEqual(Object.keys(await jiraEvents()).sort(), ["agent.bound", "turn.failed"]);
});

test("agent.bound on a session with no implement state (a direct chat) touches nothing", async () => {
  const events = await jiraEvents();
  const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const kv = memoryKv();
  const { channel, ctx } = dispatch({ state: null, continuationToken: null, host: { kv, mcp: tracker.mcp } });
  await events["agent.bound"]!({ type: "agent.bound", data: { sdkAgentId: "bc-1" } } as never, channel as never, ctx as never);
  await events["turn.failed"]!({ type: "turn.failed", data: { message: "x", status: "error" } } as never, channel as never, ctx as never);
  assert.equal(kv.entries.size, 0);
  assert.equal(tracker.calls.length, 0);
});

test("agent.bound on an implement session finishes the launch from the host's own kv and tracker: the claim, the Implementing: comment, In Progress", async () => {
  const events = await jiraEvents();
  const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const kv = memoryKv();
  const run = claimRunFor({ owner: STATE.owner });
  await claimImplementation(kv, "TLSSN-42", { now: new Date(STATE.at), run });
  await markLaunchSent(kv, { issueKey: "TLSSN-42", run, sentAt: new Date("2026-09-23T00:00:01.000Z") });
  const { channel, ctx } = dispatch({ state: JSON.parse(JSON.stringify(STATE)), continuationToken: implementContinuation(STATE), host: { kv, mcp: tracker.mcp } });

  await events["agent.bound"]!({ type: "agent.bound", data: { sdkAgentId: "bc-july-1" } } as never, channel as never, ctx as never);

  assert.deepEqual(kv.entries.get("implement/TLSSN-42"), { state: "launched", at: STATE.at, agentId: "bc-july-1", url: "https://cursor.com/agents/bc-july-1", commented: true, moved: true });
  assert.deepEqual(
    tracker.calls.filter((call) => call.tool === "addCommentToJiraIssue").map((call) => call.args["commentBody"]),
    ["Implementing: https://cursor.com/agents/bc-july-1"]
  );
  assert.equal(tracker.status(), "In Progress");
});

test("turn.failed on an implement session still pending releases the claim and reports the failure on the ticket", async () => {
  const events = await jiraEvents();
  const tracker = fakeTracker({ comments: [TRIAGE_COMMENT, PLAN_COMMENT] });
  const kv = memoryKv();
  const run = claimRunFor({ owner: STATE.owner });
  await claimImplementation(kv, "TLSSN-42", { now: new Date(STATE.at), run });
  await markLaunchSent(kv, { issueKey: "TLSSN-42", run, sentAt: new Date("2026-09-23T00:00:01.000Z") });
  const { channel, ctx } = dispatch({ state: JSON.parse(JSON.stringify(STATE)), continuationToken: implementContinuation(STATE), host: { kv, mcp: tracker.mcp } });

  await events["turn.failed"]!({ type: "turn.failed", data: { message: "cloud agent could not be started: forbidden", status: "error" } } as never, channel as never, ctx as never);

  assert.equal(kv.entries.has("implement/TLSSN-42"), false);
  assert.deepEqual(
    tracker.calls.filter((call) => call.tool === "addCommentToJiraIssue").map((call) => call.args["commentBody"]),
    ["Launch failed: forbidden. Moving the card to Approved again retries."]
  );
  assert.equal(tracker.status(), "Approved");
});

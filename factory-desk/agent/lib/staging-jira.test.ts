import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import approveTicket from "../tools/approve_ticket.js";
import denyTicket from "../tools/deny_ticket.js";
import requestPlan from "../tools/request_plan.js";
import { jiraProjects, statusNames } from "./config.js";
import { isDeskCommand } from "./intake-candidate.js";
import { addComment, stagingWriteRefusal, transitionFrom, transitionIssue } from "./jira.js";
import { decideCommentEvent } from "./outcome-event.js";
import { planDeclinedLabel } from "./plan-decline.js";
import { decideStatusEvent, leftPlannedKey } from "./status-event.js";

const ENV = ["FACTORY_ENV", "FACTORY_JIRA_PROJECTS", "FACTORY_DESK_JIRA_PROJECT", "FACTORY_STAGING_ALLOW_PRODUCTION"] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setEnv(values: Partial<Record<(typeof ENV)[number], string>>): void {
  for (const name of ENV) delete process.env[name];
  Object.assign(process.env, values);
}

function json(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function tool(name: string, properties: string[]): HostMcpToolInfo {
  return { name, inputSchema: { type: "object", properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])) } };
}

const TOOLS = [
  tool("getJiraIssue", ["issueIdOrKey"]),
  tool("transitionJiraIssue", ["issueIdOrKey", "transitionName"]),
  tool("addCommentToJiraIssue", ["issueIdOrKey", "commentBody"]),
  tool("editJiraIssue", ["issueIdOrKey", "update"]),
];

/** A connector that answers every read with a To Do ticket and records every call. */
function tracker(status = "To Do") {
  const calls: string[] = [];
  const mcp: HostMcpRegistry = {
    names: () => ["tracker"],
    listTools: async () => TOOLS,
    callTool: async (_connection, name, args = {}) => {
      calls.push(name);
      if (name === "getJiraIssue") return json({ key: String(args["issueIdOrKey"]), fields: { summary: "x", status: { name: status }, comment: { comments: [] }, labels: [] } });
      return json({ ok: true });
    },
  };
  return { mcp, calls, writes: () => calls.filter((name) => name !== "getJiraIssue") };
}

/** A tool context in a DM with an empty kv: the staging desk has no thread for a production ticket. */
function context(mcp: HostMcpRegistry) {
  const kv: Record<string, unknown> = {};
  const auth = { authenticator: "slack", principalId: "slack:T:dm", principalType: "user", attributes: { channel_id: "D0DIRECT1", user_id: "U0ALICE01" } };
  const store = { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] };
  return { session: { id: "ses_1", channelId: "slack", mode: "chat", purpose: "live", auth, continuationKey: null }, now: () => new Date("2026-09-28T00:00:00.000Z"), host: { mcp, kv: store } } as never;
}

const quiet = async <T>(run: () => T | Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.log = log;
  }
};

test("request_plan on a staging desk never moves a production ticket (the verifier's TLSSN-47 repro)", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  const t = tracker();
  const result = (await quiet(() => requestPlan.execute!({ issueKey: "TLSSN-47" } as never, context(t.mcp)))) as Record<string, unknown>;
  assert.equal(result["requested"], false);
  assert.equal(result["reason"], "staging_refused");
  assert.deepEqual(t.calls, [], "not even a read of the production ticket");
});

test("approve_ticket and deny_ticket on a staging desk write nothing to a production ticket", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  for (const run of [
    (mcp: HostMcpRegistry) => approveTicket.execute!({ issueKey: "TLSSN-47" } as never, context(mcp)),
    (mcp: HostMcpRegistry) => denyTicket.execute!({ issueKey: "TLSSN-47", by: "Alice" } as never, context(mcp)),
  ]) {
    const t = tracker("Planned");
    const result = (await quiet(() => run(t.mcp))) as Record<string, unknown>;
    assert.equal(result["reason"], "staging_refused");
    assert.deepEqual(t.calls, [], "not even a read of the production ticket");
  }
});

test("request_plan on a staging desk still reads and moves its own project's unbound ticket", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  const t = tracker();
  const result = (await quiet(() => requestPlan.execute!({ issueKey: "TLSTG-4" } as never, context(t.mcp)))) as Record<string, unknown>;
  assert.equal(result["requested"], true, JSON.stringify(result));
  assert.deepEqual(t.writes(), ["transitionJiraIssue"]);
});

test("every desk Jira write refuses a production key on staging before any connector call", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  const t = tracker();
  const moved = await quiet(() => transitionIssue(t.mcp, { issueKey: "TLSSN-47", toStatus: "Triaged" }));
  assert.equal(moved.status, "failed");
  assert.match((moved as { message: string }).message, /FACTORY_ENV is staging and TLSSN is not one of this slug's Jira projects \(TLSTG\)/);
  assert.equal((await quiet(() => transitionFrom(t.mcp, { issueKey: "TLSSN-47", from: "To Do", toStatus: "Triaged" }))).status, "failed");
  assert.equal((await quiet(() => addComment(t.mcp, { issueKey: "TLSSN-47", body: "hi" }))).status, "failed");
  assert.equal(await quiet(() => planDeclinedLabel(t.mcp, { issueKey: "TLSSN-47", on: true })), "failed");
  assert.deepEqual(t.calls, []);
});

test("an emptied project list refuses every key on staging, and the desk's own staging project goes through", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN" });
  assert.match(stagingWriteRefusal("TLSSN-47") ?? "", /\(none\)/);
  assert.match(stagingWriteRefusal("TLSTG-1") ?? "", /\(none\)/);
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  assert.equal(stagingWriteRefusal("TLSTG-1"), undefined);
  const t = tracker();
  assert.deepEqual(await transitionIssue(t.mcp, { issueKey: "TLSTG-1", toStatus: "Triaged" }), { status: "transitioned" });
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_STAGING_ALLOW_PRODUCTION: "TLSSN" });
  assert.equal(stagingWriteRefusal("TLSSN-47"), undefined, "an explicitly allowed production project is writable");
});

test("production desk writes are unchanged: any key, even with no project list", async () => {
  setEnv({});
  assert.equal(stagingWriteRefusal("TLSSN-47"), undefined);
  assert.equal(stagingWriteRefusal("OTHER-1"), undefined);
  const t = tracker();
  assert.deepEqual(await transitionIssue(t.mcp, { issueKey: "TLSSN-47", toStatus: "Triaged" }), { status: "transitioned" });
  assert.deepEqual(t.writes(), ["transitionJiraIssue"]);
});

const statusBody = (move: { issueKey: string; status: string }) => ({
  webhookEvent: "jira:issue_updated",
  issue: { key: move.issueKey, fields: { summary: "x", status: { name: move.status } } },
  changelog: { id: "1", items: [{ field: "status", fromString: "Planned", toString: move.status }] },
});

test("status and comment events: an empty list allows every project on production and none on staging", () => {
  const statuses = statusNames({});
  const staging = { FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN" };
  const projects = jiraProjects(staging);
  assert.deepEqual(projects, []);
  assert.deepEqual(decideStatusEvent(statusBody({ issueKey: "TLSSN-47", status: "Approved" }), { statuses, projects, env: staging }), { kind: "ignored", reason: "project_not_allowed" });
  assert.equal(decideStatusEvent(statusBody({ issueKey: "TLSSN-47", status: "Approved" }), { statuses, projects: [], env: {} }).kind, "approved");
  assert.equal(leftPlannedKey(statusBody({ issueKey: "TLSSN-47", status: "To Do" }), { statuses, projects, env: staging }), undefined);
  assert.equal(leftPlannedKey(statusBody({ issueKey: "TLSSN-47", status: "To Do" }), { statuses, projects: [], env: {} }), "TLSSN-47");

  const comment = { webhookEvent: "comment_created", issue: { key: "TLSSN-47", fields: {} }, comment: { body: "just a note" } };
  assert.deepEqual(decideCommentEvent(comment, { statuses, projects, env: staging }), { kind: "ignored", reason: "project_not_allowed" });
  assert.deepEqual(decideCommentEvent(comment, { statuses, projects: [], env: {} }), { kind: "ignored", reason: "not_outcome" });
});

test("intake: a staging desk with no project left counts no key, so a production key is never read as its own", () => {
  setEnv({});
  assert.equal(isDeskCommand("is TLSSN-47 done?"), true);
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN" });
  assert.equal(isDeskCommand("is TLSSN-47 done?"), false);
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  assert.equal(isDeskCommand("is TLSTG-4 done?"), true);
});

const withProject = (move: { issueKey: string; status: string; projectKey: string }) => {
  const body = statusBody({ issueKey: move.issueKey, status: move.status });
  return { ...body, issue: { ...body.issue, fields: { ...body.issue.fields, project: { key: move.projectKey } } } };
};

test("production parity: a padded project.key is still not allowed on every production spelling of FACTORY_ENV", () => {
  const statuses = statusNames({});
  const padded = withProject({ issueKey: "TLSSN-47", status: "Approved", projectKey: " TLSSN" });
  const comment = { webhookEvent: "comment_created", issue: { key: "TLSSN-47", fields: { project: { key: " TLSSN" } } }, comment: { body: "just a note" } };
  for (const env of [{}, { FACTORY_ENV: "prod" }, { FACTORY_ENV: "production" }, { FACTORY_ENV: "PROD" }]) {
    assert.deepEqual(decideStatusEvent(padded, { statuses, projects: ["TLSSN"], env }), { kind: "ignored", reason: "project_not_allowed" }, JSON.stringify(env));
    assert.deepEqual(decideCommentEvent(comment, { statuses, projects: ["TLSSN"], env }), { kind: "ignored", reason: "project_not_allowed" }, JSON.stringify(env));
  }
});

test("staging refuses a status or comment body whose issue key is production even when project.key names the staging project", () => {
  const statuses = statusNames({});
  const staging = { FACTORY_ENV: "staging" };
  const mixed = withProject({ issueKey: "TLSSN-47", status: "Approved", projectKey: "TLSTG" });
  assert.deepEqual(decideStatusEvent(mixed, { statuses, projects: ["TLSTG"], env: staging }), { kind: "ignored", reason: "project_not_allowed" });
  assert.equal(leftPlannedKey(withProject({ issueKey: "TLSSN-47", status: "To Do", projectKey: "TLSTG" }), { statuses, projects: ["TLSTG"], env: staging }), undefined);
  const comment = { webhookEvent: "comment_created", issue: { key: "TLSSN-47", fields: { project: { key: "TLSTG" } } }, comment: { body: "just a note" } };
  assert.deepEqual(decideCommentEvent(comment, { statuses, projects: ["TLSTG"], env: staging }), { kind: "ignored", reason: "project_not_allowed" });
  assert.equal(decideStatusEvent(withProject({ issueKey: "TLSTG-1", status: "Approved", projectKey: "TLSTG" }), { statuses, projects: ["TLSTG"], env: staging }).kind, "approved");
  assert.equal(decideStatusEvent(mixed, { statuses, projects: ["TLSTG"], env: {} }).kind, "approved", "production still trusts project.key, as on main");
});

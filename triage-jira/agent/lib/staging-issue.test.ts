import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import queue from "../channels/queue.js";
import webhook from "../channels/webhook.js";
import { issueProject, stagingRefusesIssue } from "./staging-issue.js";

const SECRET = "stage-secret";
const saved = { env: process.env.FACTORY_ENV, secret: process.env.JIRA_WEBHOOK_SECRET, projects: process.env.FACTORY_JIRA_PROJECTS };

afterEach(() => {
  for (const [name, value] of [["FACTORY_ENV", saved.env], ["JIRA_WEBHOOK_SECRET", saved.secret], ["FACTORY_JIRA_PROJECTS", saved.projects]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("issueProject takes the part before the last dash", () => {
  assert.equal(issueProject("TLSSN-45"), "TLSSN");
  assert.equal(issueProject("tlstg-7"), "TLSTG");
  assert.equal(issueProject("NODASH"), "NODASH");
});

test("stagingRefusesIssue: production refuses nothing; staging allows only full keys of FACTORY_JIRA_PROJECTS", () => {
  for (const identifier of ["TLSSN-45", "10047", "tlssn-45", " TLSSN-45 "]) assert.equal(stagingRefusesIssue({}, identifier), false, identifier);
  const log = console.log;
  console.log = () => undefined;
  try {
    const staging = { FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" };
    assert.equal(stagingRefusesIssue(staging, "TLSTG-1"), false);
    for (const identifier of ["TLSSN-45", "10047", "tlstg-1", " TLSTG-1 ", "TLSTG-1 ", "TLSTG", "OTHER-3"]) {
      assert.equal(stagingRefusesIssue(staging, identifier), true, JSON.stringify(identifier));
    }
    assert.equal(stagingRefusesIssue({ FACTORY_ENV: "staging" }, "TLSTG-1"), true, "no project list refuses every key");
    assert.equal(stagingRefusesIssue({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN" }, "TLSSN-45"), true, "TLSSN is dropped from the list");
    assert.equal(stagingRefusesIssue({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_STAGING_ALLOW_PRODUCTION: "TLSSN" }, "TLSSN-45"), false);
  } finally {
    console.log = log;
  }
});

type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };

const created = {
  webhookEvent: "jira:issue_created",
  issue: { key: "TLSSN-40", fields: { summary: "Login fails", description: "Ordinary.", status: { name: "To Do" }, issuetype: { name: "Task" } } },
};

async function call(channel: unknown, headers: Record<string, string>) {
  const route = (channel as { routes: Route[] }).routes[0]!;
  let woke = false;
  const touch = () => {
    woke = true;
    throw new Error("a refused issue must not reach the host");
  };
  const host = { kv: { get: touch, put: touch, delete: touch }, mcp: { names: touch, listTools: touch, callTool: touch } };
  const log = console.log;
  console.log = () => undefined;
  try {
    const response = await route.handler(
      new Request("http://triage/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(created) }),
      { body: created, host, waitUntil: touch, send: touch }
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, woke };
  } finally {
    console.log = log;
  }
}

test("on staging, the signed webhook and the queue route both ignore a production issue without touching kv, Jira, or a session", async () => {
  process.env.FACTORY_ENV = "staging";
  process.env.FACTORY_JIRA_PROJECTS = "TLSTG";
  process.env.JIRA_WEBHOOK_SECRET = SECRET;
  for (const [channel, headers] of [[webhook, { "x-factory-webhook-secret": SECRET }], [queue, {}]] as const) {
    const result = await call(channel, headers);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true, ignored: true, reason: "staging_refuses_production" });
    assert.equal(result.woke, false);
  }
});

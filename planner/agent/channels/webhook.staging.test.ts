import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HostMcpRegistry } from "@cursor/july";
import planIssue from "../tools/plan_issue.js";
import { issueStatus, readTicket, transitionIssue } from "../lib/jira.js";
import planChannel from "./plan.js";
import channel from "./webhook.js";

// The staging checks docs/factory-deployment.md §10 step 4 describes: the
// replay scripts' signed bodies for a production key, answered by this route
// on a staging slug with the ignored reason and no planning run, and every
// other planner path that takes a key from a body, a comment, or the model.

const scriptUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/jira-payload.mjs")).href;
const SECRET = "local-check";
const NAMES = ["JIRA_WEBHOOK_SECRET", "FACTORY_ENV", "FACTORY_JIRA_PROJECTS", "FACTORY_PLANNER_JIRA_PROJECTS", "FACTORY_STAGING_ALLOW_PRODUCTION"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setEnv(values: Partial<Record<(typeof NAMES)[number], string>>): void {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, { JIRA_WEBHOOK_SECRET: SECRET, ...values });
}

type Payloads = {
  transitionBody: (input: Record<string, unknown>) => unknown;
  commentBody: (input: Record<string, unknown>) => unknown;
  signedRequest: (body: unknown, secret: string) => { rawBody: string; headers: Record<string, string> };
};

type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };
const route = (channel as unknown as { routes: Route[] }).routes[0]!;

const touch = () => {
  throw new Error("a refused delivery must not reach kv, Jira, or a session");
};
const refusingHost = { kv: { get: touch, put: touch, delete: touch }, mcp: { names: touch, listTools: touch, callTool: touch } };

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

async function deliver(body: unknown, host: Record<string, unknown> = refusingHost): Promise<{ status: number; json: Record<string, unknown>; sent: string[] }> {
  const { signedRequest } = (await import(scriptUrl)) as Payloads;
  const { rawBody, headers } = signedRequest(body, SECRET);
  const sent: string[] = [];
  const response = await quietly(() =>
    route.handler(new Request("http://127.0.0.1:3000/planner/v1/channels/webhook/", { method: "POST", headers, body: rawBody }), {
      body,
      host,
      send: async (_message: string, options: { continuationToken?: string } = {}) => {
        sent.push(options.continuationToken ?? "");
        return { id: "ses_1" };
      },
    })
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown>, sent };
}

async function comment(input: { onIssue: string; text: string }): Promise<unknown> {
  const { commentBody } = (await import(scriptUrl)) as Payloads;
  return commentBody({ issueKey: input.onIssue, commentId: "20001", body: input.text, timestamp: 1, summary: "check", status: "Triaged" });
}

const REFUSED = { ok: true, ignored: true, reason: "project_not_allowed", via: "comment" };
const TRIAGE = "Triage: bug, high severity.\nSummary: Export returns 500.\nSeverity: high";

test("a staging planner answers the replayed TLSSN status delivery with project_not_allowed and plans nothing", async () => {
  const { transitionBody } = (await import(scriptUrl)) as Payloads;
  for (const projects of ["TLSTG", "TLSSN"]) {
    setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: projects });
    const body = transitionBody({ issueKey: "TLSSN-999999", toStatus: "Triaged", fromStatus: "To Do", changelogId: "1", timestamp: 1, summary: "check" });
    const result = await deliver(body);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true, ignored: true, reason: "project_not_allowed", via: "status" }, projects);
    assert.deepEqual(result.sent, []);
  }
});

test("a staging planner ignores every comment that would plan a production ticket (the round-2 verifier's three cases)", async () => {
  const cases = [
    { name: "Plan requested: TLSSN-47 on a staging ticket", onIssue: "TLSTG-1", text: "Plan requested: TLSSN-47" },
    { name: "Plan requested: TLSSN-47 on TLSSN-47", onIssue: "TLSSN-47", text: "Plan requested: TLSSN-47" },
    { name: "production triage's Triage: comment on TLSSN-47", onIssue: "TLSSN-47", text: TRIAGE },
  ];
  for (const projects of ["TLSTG", "TLSSN"]) {
    setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: projects });
    for (const { name, onIssue, text } of cases) {
      const result = await deliver(await comment({ onIssue, text }));
      assert.equal(result.status, 200, name);
      assert.deepEqual(result.json, REFUSED, `${projects}: ${name}`);
      assert.deepEqual(result.sent, [], `${projects}: ${name} opened a session`);
    }
  }
});

function memoryHost() {
  const entries = new Map<string, unknown>();
  return { kv: { get: async (key: string) => entries.get(key), put: async (key: string, value: unknown) => void entries.set(key, value), delete: async (key: string) => void entries.delete(key) }, mcp: refusingHost.mcp };
}

test("a staging planner still plans its own project's comments", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  const result = await deliver(await comment({ onIssue: "TLSTG-1", text: "Plan requested: TLSTG-1" }), memoryHost());
  assert.equal(result.json["started"], true, JSON.stringify(result.json));
  assert.equal(result.sent.length, 1);
  assert.match(result.sent[0] ?? "", /^issue:TLSTG-1#/);
});

test("production comment deliveries are unchanged: all three cases still plan, with or without a project list", async () => {
  for (const env of [{}, { FACTORY_JIRA_PROJECTS: "TLSSN" }]) {
    for (const { onIssue, text } of [
      { onIssue: "TLSSN-47", text: "Plan requested: TLSSN-47" },
      { onIssue: "OTHER-1", text: "Plan requested: TLSSN-47" },
      { onIssue: "TLSSN-47", text: TRIAGE },
    ]) {
      setEnv(env);
      const result = await deliver(await comment({ onIssue, text }), memoryHost());
      assert.equal(result.json["started"], true, `${JSON.stringify(env)} ${onIssue} ${text}: ${JSON.stringify(result.json)}`);
      assert.match(result.sent[0] ?? "", /^issue:TLSSN-47#/);
    }
  }
});

test("the plan route, plan_issue, and the planner's Jira reads and moves refuse a production key on staging", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  const planRoute = (planChannel as unknown as { routes: Route[] }).routes[0]!;
  const body = { issueKey: "TLSSN-47", title: "check" };
  const response = await planRoute.handler(new Request("http://127.0.0.1:3000/planner/v1/channels/plan/issue", { method: "POST", body: JSON.stringify(body) }), { body, send: touch });
  assert.deepEqual(await response.json(), { ok: true, started: false, reason: "project_not_allowed", issueKey: "TLSSN-47" });

  const context = { session: { id: "ses_1", purpose: "live" }, send: touch } as never;
  assert.deepEqual(await planIssue.execute!({ issueKey: "TLSSN-47", title: "check" } as never, context), { started: false, reason: "project_not_allowed", issueKey: "TLSSN-47" });

  const mcp = refusingHost.mcp as unknown as HostMcpRegistry;
  const read = await readTicket(mcp, "TLSSN-47");
  assert.equal(read.status, "failed");
  assert.match("message" in read ? read.message : "", /FACTORY_ENV is staging and TLSSN is not one of this planner's Jira projects/);
  assert.equal(await issueStatus(mcp, "TLSSN-47"), undefined);
  assert.equal((await transitionIssue(mcp, { issueKey: "TLSSN-47", toStatus: "Planned" })).status, "failed");

  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_STAGING_ALLOW_PRODUCTION: "TLSSN" });
  assert.notDeepEqual(await planIssue.execute!({ issueKey: "TLSSN-47", title: "check" } as never, { session: { id: "ses_1", purpose: "eval" } } as never), { started: false, reason: "project_not_allowed", issueKey: "TLSSN-47" }, "an explicitly allowed production project is not refused");
});

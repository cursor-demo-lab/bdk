import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import { commentOnIssue } from "../lib/actuate.js";
import { deskFiledOnTracker } from "../lib/desk-filed.js";
import { projectIssueTypes, setIssueType } from "../lib/issue-type.js";
import { triageWake } from "../lib/jev-first.js";
import { issueStatus, transitionFrom, transitionIssue } from "../lib/transition.js";
import recordTriage from "./record_triage.js";

// A staging triage slug acts only on a full key of its own projects
// (FACTORY_JIRA_PROJECTS). A production key, a numeric issue id, or a
// lowercase or padded key from the model's input is refused whatever the
// session's continuation key, and every tracker helper refuses it before any
// connector call.

const NAMES = ["FACTORY_ENV", "FACTORY_JIRA_PROJECTS", "FACTORY_STAGING_ALLOW_PRODUCTION", "FACTORY_INPROCESS_PEERS", "TYPESAFE_API_KEY"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setEnv(values: Partial<Record<(typeof NAMES)[number], string>>): void {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, { FACTORY_INPROCESS_PEERS: "1", ...values });
}

const STAGING = { FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" } as const;
const REFUSED_IDS = ["TLSSN-47", "10047", "tlssn-47", " TLSSN-47 ", "tlstg-1", " TLSTG-1 "];

const str = { type: "string" };
const TOOLS: HostMcpToolInfo[] = [
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "addComment", inputSchema: { type: "object", properties: { issueIdOrKey: str, body: str } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, transition: { type: "object" } } } },
  { name: "getJiraProjectIssueTypesMetadata", inputSchema: { type: "object", properties: { projectIdOrKey: str } } },
  { name: "editJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: str, fields: { type: "object" } } } },
];

function host() {
  const calls: string[] = [];
  const store = new Map<string, unknown>();
  const mcp = {
    names: () => ["tracker", "planner"],
    listTools: async () => {
      calls.push("listTools");
      return TOOLS;
    },
    callTool: async (connection, tool) => {
      calls.push(`${connection}.${tool}`);
      if (tool === "getJiraIssue") return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-47", fields: { status: { name: "To Do" } } }) }] };
      if (tool === "getTransitionsForJiraIssue") return { content: [{ type: "text", text: "ok" }], structuredContent: { transitions: [{ id: "41", name: "Triaged", to: { name: "Triaged" } }] } } as HostMcpCallResult;
      return { content: [{ type: "text", text: "ok" }] };
    },
  } satisfies HostMcpRegistry;
  const kvCalls: string[] = [];
  const kv = {
    get: async (key: string) => (kvCalls.push(`get ${key}`), store.get(key)),
    put: async (key: string, value: unknown) => void (kvCalls.push(`put ${key}`), store.set(key, value)),
    delete: async (key: string) => void (kvCalls.push(`delete ${key}`), store.delete(key)),
  };
  return { mcp, kv, calls, kvCalls };
}

const VERDICT = { identifier: "TLSSN-47", kind: "bug", severity: "high", title: "Export 500", summary: "CSV export fails.", nextStep: "Fix the export." };

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

async function record(input: { continuationKey: string | null; identifier: string }) {
  const h = host();
  const ctx = { session: { id: "ses_1", channelId: "webhook", mode: "chat", purpose: "live", auth: null, continuationKey: input.continuationKey }, host: { kv: h.kv, mcp: h.mcp } };
  const output = (await quietly(() => Promise.resolve(recordTriage.execute!({ ...VERDICT, identifier: input.identifier } as never, ctx as never)))) as Record<string, any>;
  return { output, calls: h.calls, kvCalls: h.kvCalls };
}

test("record_triage on staging refuses a production key, a numeric id, and a lowercase or padded key for every continuation key", async () => {
  setEnv(STAGING);
  for (const continuationKey of [null, "slack:thread-1", "cont:TLSSN-47"]) {
    for (const identifier of REFUSED_IDS) {
      const { output, calls, kvCalls } = await record({ continuationKey, identifier });
      const label = `${continuationKey} ${JSON.stringify(identifier)}`;
      assert.deepEqual(output["tracker"], { status: "skipped", reason: "staging_refuses_production" }, label);
      assert.deepEqual(calls, [], `${label}: no issue-type read, comment, transition, or plan_issue call`);
      assert.deepEqual(kvCalls, [], `${label}: record_triage refuses before reading the inbound or Jev stash`);
    }
  }
});

test("record_triage on staging refuses when either the session's key or the model's key is refused", async () => {
  setEnv(STAGING);
  for (const identifier of ["TLSSN-47", "10047"]) {
    const pinnedStaging = await record({ continuationKey: "cont:TLSTG-1", identifier });
    assert.equal(pinnedStaging.output["tracker"]["reason"], "staging_refuses_production", identifier);
    assert.deepEqual(pinnedStaging.calls, []);
  }
});

test("record_triage on staging still writes to its own project's full key", async () => {
  setEnv(STAGING);
  const { output, calls } = await record({ continuationKey: "cont:TLSTG-1", identifier: "TLSTG-1" });
  assert.notEqual(output["tracker"]["reason"], "staging_refuses_production");
  assert.ok(calls.some((call) => call.endsWith("addComment")), JSON.stringify(calls));
});

test("record_triage on production is unchanged: a TLSSN key and a numeric id both reach the tracker", async () => {
  setEnv({});
  for (const [continuationKey, identifier] of [["TLSSN-47", "TLSSN-47"], [null, "10047"]] as const) {
    const { output, calls } = await record({ continuationKey, identifier });
    assert.notEqual(output["tracker"]["reason"], "staging_refuses_production", identifier);
    assert.ok(calls.some((call) => call.endsWith("addComment")), `${identifier}: ${JSON.stringify(calls)}`);
  }
});

test("every triage tracker helper refuses a refused identifier on staging before any connector call", async () => {
  setEnv(STAGING);
  for (const identifier of REFUSED_IDS) {
    const h = host();
    const comment = await quietly(() => commentOnIssue(h.mcp, { issueKey: identifier, body: "Triage stopped: x" }));
    assert.equal(comment.status, "failed", identifier);
    assert.match("message" in comment ? comment.message : "", /^staging_refuses_production: /);
    assert.match(JSON.stringify(await quietly(() => transitionIssue(h.mcp, { issueKey: identifier, toStatus: "Triaged" }))), /staging_refuses_production/);
    assert.match(JSON.stringify(await quietly(() => transitionFrom(h.mcp, { issueKey: identifier, from: "To Do", toStatus: "Triaged" }))), /staging_refuses_production/);
    assert.equal(await quietly(() => issueStatus(h.mcp, identifier)), undefined);
    assert.match(JSON.stringify(await setIssueType(h.mcp, identifier, { name: "Bug" })), /staging_refuses_production/);
    const look = await quietly(() => deskFiledOnTracker(h.mcp, identifier, { env: process.env }));
    assert.equal(look.skip, false);
    assert.match("detail" in look ? look.detail : "", /^staging_refuses_production: /);
    const woke = await quietly(() => triageWake({ issue: { identifier, title: "x", description: "y", url: "", reporter: "" } as never, mcp: h.mcp, kv: h.kv as never, send: async () => "sent" }));
    assert.deepEqual(woke, { fast: false, skipped: "staging_refuses_production" }, identifier);
    assert.deepEqual(h.calls, [], identifier);
  }
  const h = host();
  for (const project of ["TLSSN", "10047", "tlssn"]) assert.equal(await projectIssueTypes(h.mcp, h.kv as never, project), undefined, project);
  assert.deepEqual(h.calls, []);
});

test("an explicitly allowed production project is not refused by the triage helpers", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_STAGING_ALLOW_PRODUCTION: "TLSSN" });
  const h = host();
  assert.equal((await commentOnIssue(h.mcp, { issueKey: "TLSSN-47", body: "x" })).status, "commented");
});

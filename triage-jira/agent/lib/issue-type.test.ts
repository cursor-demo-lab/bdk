import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostMcpCallResult, HostMcpToolInfo } from "@cursor/july";
import { ISSUE_TYPES_OPERATION, projectIssueTypes, projectOf, sameTypeName, setIssueType } from "./issue-type.js";

const S = { type: "string" };
const SITE = "https://<JIRA_SITE>.atlassian.net";

function tool(name: string, properties: Record<string, unknown>): HostMcpToolInfo {
  return { name, inputSchema: { type: "object", properties } as HostMcpToolInfo["inputSchema"] };
}

const V1_LIST = tool("getJiraProjectIssueTypesMetadata", { cloudId: S, projectIdOrKey: S });
const V2_EXECUTE = tool("executeRead", { name: S, cloudId: S, inputs: { type: "object" } });
const EDIT = tool("editJiraIssue", { cloudId: S, issueIdOrKey: S, fields: { type: "object" } });

// GET /rest/api/3/issue/createmeta/{project}/issuetypes on a team-managed software project.
const CREATEMETA = {
  issueTypes: [
    { id: "10170", name: "Task", subtask: false, hierarchyLevel: 0, iconUrl: "x" },
    { id: "10171", name: "Story", subtask: false, hierarchyLevel: 0, iconUrl: "x" },
    { id: "10172", name: "Bug", subtask: false, hierarchyLevel: 0, iconUrl: "x" },
    { id: "10173", name: "Epic", subtask: false, hierarchyLevel: 1, iconUrl: "x" },
    { id: "10174", name: "Subtask", subtask: true, hierarchyLevel: -1, iconUrl: "x" },
  ],
};

function text(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function setup(tools: HostMcpToolInfo[], reply: (name: string, args: Record<string, unknown>) => HostMcpCallResult | Promise<HostMcpCallResult>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const store = new Map<string, unknown>();
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => tools,
    callTool: async (_connection: string, name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      return reply(name, args);
    },
  };
  const kv = {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
  return { mcp: mcp as never, kv: kv as never, calls, store };
}

test("v1: lists the project's standard types with ids; Epic and sub-tasks are dropped", async () => {
  const { mcp, kv, calls } = setup([V1_LIST, EDIT], () => text(CREATEMETA));
  assert.deepEqual(await projectIssueTypes(mcp, kv, "TLSSN"), [
    { name: "Task", id: "10170" },
    { name: "Story", id: "10171" },
    { name: "Bug", id: "10172" },
  ]);
  assert.deepEqual(calls[0], { name: "getJiraProjectIssueTypesMetadata", args: { projectIdOrKey: "TLSSN", cloudId: SITE } });
});

test("v2: runs the same operation through executeRead, reading the values page from structuredContent", async () => {
  const { mcp, kv, calls } = setup([V2_EXECUTE, EDIT], () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { values: CREATEMETA.issueTypes } }));
  assert.deepEqual((await projectIssueTypes(mcp, kv, "TLSSN"))?.map((type) => type.name), ["Task", "Story", "Bug"]);
  assert.deepEqual(calls[0], { name: "executeRead", args: { name: ISSUE_TYPES_OPERATION, inputs: { projectIdOrKey: "TLSSN" }, cloudId: SITE } });
});

test("the list is cached per project with an expiry, and read again once it passes", async () => {
  let now = 1_000;
  const { mcp, kv, calls } = setup([V1_LIST], () => text(CREATEMETA));
  await projectIssueTypes(mcp, kv, "TLSSN", () => now);
  await projectIssueTypes(mcp, kv, "TLSSN", () => now);
  assert.equal(calls.length, 1);
  now += 7 * 60 * 60 * 1000;
  await projectIssueTypes(mcp, kv, "TLSSN", () => now);
  assert.equal(calls.length, 2);
});

test("no list tool, an error reply, a throw, or no types: undefined, nothing cached", async () => {
  const cases = [
    setup([EDIT], () => text(CREATEMETA)),
    setup([V1_LIST], () => ({ content: [{ type: "text", text: "no" }], isError: true })),
    setup([V1_LIST], () => {
      throw new Error("down");
    }),
    setup([V1_LIST], () => text({ issueTypes: [] })),
  ];
  for (const { mcp, kv, store } of cases) {
    assert.equal(await projectIssueTypes(mcp, kv, "TLSSN"), undefined);
    assert.equal(store.size, 0);
  }
});

test("setIssueType edits fields.issuetype by id, else by name", async () => {
  const { mcp, calls } = setup([EDIT], () => text({ ok: true }));
  assert.deepEqual(await setIssueType(mcp, "TLSSN-42", { name: "Bug", id: "10172" }), { status: "set" });
  assert.deepEqual(await setIssueType(mcp, "TLSSN-42", { name: "Story" }), { status: "set" });
  assert.deepEqual(calls.map((call) => call.args), [
    { issueIdOrKey: "TLSSN-42", fields: { issuetype: { id: "10172" } }, cloudId: SITE },
    { issueIdOrKey: "TLSSN-42", fields: { issuetype: { name: "Story" } }, cloudId: SITE },
  ]);
});

test("setIssueType reports a refused edit, a throw, and a missing tool as failed", async () => {
  const refused = setup([EDIT], () => ({ content: [{ type: "text", text: "Field 'issuetype' cannot be set." }], isError: true }));
  assert.deepEqual(await setIssueType(refused.mcp, "TLSSN-42", { name: "Bug" }), { status: "failed", message: "Field 'issuetype' cannot be set." });
  const thrown = setup([EDIT], () => {
    throw new Error("socket hang up");
  });
  assert.deepEqual(await setIssueType(thrown.mcp, "TLSSN-42", { name: "Bug" }), { status: "failed", message: "socket hang up" });
  const none = setup([V1_LIST], () => text({}));
  assert.equal((await setIssueType(none.mcp, "TLSSN-42", { name: "Bug" })).status, "failed");
});

test("helpers", () => {
  assert.equal(projectOf("TLSSN-42"), "TLSSN");
  assert.equal(sameTypeName(" bug ", "Bug"), true);
  assert.equal(sameTypeName(undefined, "Bug"), false);
});

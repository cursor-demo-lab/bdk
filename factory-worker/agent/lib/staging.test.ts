import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { HostMcpRegistry } from "@cursor/july";
import { addComment, issueStatus, readComments, stagingRefusal, transitionFrom, transitionIssue } from "./jira.js";
import { LaunchNotStartedError, launchImplementation } from "./launch.js";
import { markReadyForReview } from "./pr-ready.js";

// On a staging slug the worker's Jira helpers, its implement-PR undraft, and
// its agent launch refuse a production ticket or repository before any call.

const NAMES = ["FACTORY_ENV", "FACTORY_JIRA_PROJECTS", "FACTORY_STAGING_ALLOW_PRODUCTION"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setEnv(values: Partial<Record<(typeof NAMES)[number], string>>): void {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, values);
}

function tracker() {
  const calls: string[] = [];
  const mcp = {
    names: () => {
      calls.push("names");
      return [] as string[];
    },
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
  } satisfies HostMcpRegistry;
  return { mcp, calls };
}

test("the worker's Jira helpers refuse a production key on staging without touching the connector", async () => {
  for (const projects of ["TLSTG", "TLSSN"]) {
    setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: projects });
    const t = tracker();
    assert.match(JSON.stringify(await readComments(t.mcp, "TLSSN-47")), /staging_refuses_production/);
    assert.match(JSON.stringify(await addComment(t.mcp, { issueKey: "TLSSN-47", body: "x" })), /staging_refuses_production/);
    assert.match(JSON.stringify(await transitionIssue(t.mcp, { issueKey: "TLSSN-47", toStatus: "In Review" })), /staging_refuses_production/);
    assert.match(JSON.stringify(await transitionFrom(t.mcp, { issueKey: "TLSSN-47", from: "In Progress", toStatus: "In Review" })), /staging_refuses_production/);
    assert.deepEqual(await issueStatus(t.mcp, "TLSSN-47"), { status: "unread" });
    assert.deepEqual(t.calls, [], projects);
  }
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  assert.equal(stagingRefusal("TLSTG-1"), undefined);
});

test("production worker Jira helpers are unchanged: they reach the connector for any key", async () => {
  setEnv({});
  const t = tracker();
  assert.equal(stagingRefusal("TLSSN-47"), undefined);
  assert.deepEqual(await readComments(t.mcp, "TLSSN-47"), { status: "not_connected", issueKey: "TLSSN-47" });
  assert.ok(t.calls.length > 0);
});

test("a staging worker neither undrafts a production PR nor launches an agent on the production repository", async () => {
  setEnv({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSTG" });
  const touch = () => {
    throw new Error("a refused undraft must not touch kv or GitHub");
  };
  const ready = await markReadyForReview(
    { kv: { get: touch, put: touch, delete: touch } as never, github: { getOctokit: touch } as never },
    { issueKey: "TLSTG-1", repository: "cursor-demo-lab/marsbank", number: 7, mode: "open", draft: true }
  );
  assert.deepEqual(ready, { outcome: "staging_refused" });

  let created = 0;
  await assert.rejects(
    launchImplementation(
      { createAgent: async () => ((created += 1), { agentId: "a", send: async () => undefined, close: () => undefined }) },
      { issueKey: "TLSTG-1", title: "x", brief: "y", model: { id: "auto-smart" } as never, repo: "cursor-demo-lab/marsbank", ref: "main", idempotencyKey: "k" }
    ),
    (error: unknown) => error instanceof LaunchNotStartedError && error.reason === "staging_refuses_production"
  );
  assert.equal(created, 0);
});

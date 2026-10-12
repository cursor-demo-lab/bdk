import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadAgentProject } from "@cursor/july";

// The desk reads GitHub through one channel, read-only, to hear review
// results; it holds no GitHub connection or token and never writes to
// GitHub. `agent-sdk info` does not list host connections, so this reads
// July's own discovery, which does. channels/github.test.ts pins the
// channel's read-only credential.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GITHUB = /git\s*hub|\bgh[_-]|github_token/i;

function listing(dir: string): string[] {
  const path = new URL(dir, import.meta.url);
  return existsSync(path) ? readdirSync(path).filter((name) => !name.endsWith(".test.ts")).sort() : [];
}

test("host-connections holds only the Atlassian tracker, and mcp-connections is empty or absent", () => {
  assert.deepEqual(listing("./host-connections/"), ["tracker.ts"]);
  assert.deepEqual(listing("./mcp-connections/"), []);
});

test("the loaded agent has one host connection, the Factory Atlassian tracker, and no model connection", async () => {
  const project = await loadAgentProject(ROOT);
  assert.deepEqual(project.diagnostics, []);
  assert.deepEqual(project.agent.connections, []);
  assert.deepEqual(
    (project.agent.hostConnections ?? []).map((connection) => ({ name: connection.name, transport: connection.transport })),
    [{ name: "tracker", transport: { cursorAccount: true, servers: ["Factory Atlassian"] } }]
  );
  const everyConnection = JSON.stringify([project.agent.connections, project.agent.hostConnections]);
  assert.doesNotMatch(everyConnection, GITHUB);
});

test("the desk mounts the slack, jira, and read-only github channels", async () => {
  const project = await loadAgentProject(ROOT);
  assert.deepEqual(project.channels.map((channel) => channel.id).sort(), ["github", "jira", "slack"]);
});

test("the desk's hosting secrets name no GitHub token; FACTORY_REPOS only scopes the review channel", async () => {
  const project = await loadAgentProject(ROOT);
  const secretNames = project.agent.hosting?.secretNames ?? [];
  assert.ok(secretNames.includes("FACTORY_DESK_SLACK_BOT_TOKEN"), "secretNames did not load");
  assert.ok(secretNames.includes("FACTORY_REPOS"));
  assert.deepEqual(
    secretNames.filter((name) => GITHUB.test(name)),
    []
  );
});

test("the Jev mount adds only its hosting contribution: api.typesafe.ai egress and the TYPESAFE_API_KEY secret, no model tool", async () => {
  const project = await loadAgentProject(ROOT);
  assert.deepEqual(listing("./extensions/"), ["jev.ts"]);
  assert.ok(project.agent.hosting?.egressDomains?.includes("api.typesafe.ai"));
  assert.ok(project.agent.hosting?.secretNames?.includes("TYPESAFE_API_KEY"));
  assert.deepEqual(project.agent.tools.map((tool) => tool.name).sort(), ["approve_ticket", "deny_ticket", "file_ticket", "request_plan"]);
});

test("every desk turn runs on the light model, grok-4.6 fast, not Auto", async () => {
  const saved = process.env.FACTORY_AGENT_MODEL;
  delete process.env.FACTORY_AGENT_MODEL;
  try {
    const project = await loadAgentProject(ROOT);
    assert.deepEqual(project.agent.model, { id: "grok-4.6", params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] });
    assert.equal((project.agent.subagents ?? []).length, 0, "no subagent turn on another model");
  } finally {
    if (saved !== undefined) process.env.FACTORY_AGENT_MODEL = saved;
  }
});

// July 0.2.13 hosted v2 takes its calendars from the release manifest, which
// deploy builds from agent/schedules/ (the guest no longer upserts platform
// timers at boot), and fires each by id through the reserved schedule
// admission. Not a public export: the same builder `agent-sdk manifest` and
// `deploy` call.
const julyRoot = dirname(createRequire(import.meta.url).resolve("@cursor/july/package.json"));
const { buildAgentDeployManifest } = (await import(pathToFileURL(join(julyRoot, "dist/internal/deploy-manifest.js")).href)) as {
  buildAgentDeployManifest: (project: unknown) => { declarations: { architecture?: string; schedules?: Array<{ id: string; cron: string; kind: string }> } };
};

test("the release manifest declares the hop-watch backstop sweep, the desk's one schedule, for hosted v2", async () => {
  assert.deepEqual(listing("./schedules/"), [".gitkeep", "hop-watch.ts"]);
  const { declarations } = buildAgentDeployManifest(await loadAgentProject(ROOT));
  assert.equal(declarations.architecture, "v2");
  assert.deepEqual(declarations.schedules, [{ id: "hop-watch", cron: "*/5 * * * *", kind: "run" }]);
});

// Hosted v2 fires named reminder handlers by file stem (July registers
// agent/reminders/*.ts as namedHandlers); the manifest does not list them, so
// the loader's view is the only pin that both deadlines have a handler.
test("the loader finds the two reminder handlers, the hop deadline and the plan start check", async () => {
  assert.deepEqual(listing("./reminders/"), ["hop_watch.ts", "plan_start.ts"]);
  const project = await loadAgentProject(ROOT);
  assert.deepEqual((project.reminders ?? []).map((reminder) => reminder.name).sort(), ["hop_watch", "plan_start"]);
});

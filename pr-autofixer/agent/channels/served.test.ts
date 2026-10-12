import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("../../node_modules/@cursor/july/dist/bin/agent-serve.js", import.meta.url));

// Asks the host what it would serve, so a Slack channel is caught however it
// is added. factory-desk is the factory's only Slack app.
test("the fixer serves GitHub, the drive route, and HTTP, and no Slack channel", () => {
  const result = spawnSync(process.execPath, [cli, "info", "--dir", ".", "--json"], {
    cwd: projectRoot,
    env: { ...process.env, FACTORY_REPOS: "acme/widgets" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout) as { agents: { channels: { id: string; kind?: string }[] }[] };
  const channels = info.agents[0]!.channels;
  assert.deepEqual(channels.map((channel) => channel.id).sort(), ["drive", "github", "http"]);
  assert.deepEqual(channels.filter((channel) => channel.kind === "slack"), []);
});

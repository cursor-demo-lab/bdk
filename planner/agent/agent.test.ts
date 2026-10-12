import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CHECKOUT_ENV, MANAGED_HOSTING_ENV } from "./lib/checkout.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// July appends "mcp" to an authored allowlist so server tools stay reachable.
const READ_ONLY = ["read", "grep", "glob", "ls", "mcp"];

type Loaded = {
  errors: boolean;
  runtime: string;
  allowedTools?: string[];
  workspaceDir?: string;
  autoCreatePR?: boolean;
  egressDomains?: string[];
  secretNames?: string[];
};

// agent.ts reads its posture when the module loads, and ESM caches the
// module, so each posture loads in its own process. Only the child's env is
// set; this process's environment is never changed.
function load(env: Partial<Record<typeof CHECKOUT_ENV | typeof MANAGED_HOSTING_ENV, string>>): Loaded {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv[CHECKOUT_ENV];
  delete childEnv[MANAGED_HOSTING_ENV];
  const script = `
    import { hasErrorDiagnostics, loadAgentProject } from "@cursor/july";
    const project = await loadAgentProject(${JSON.stringify(ROOT)});
    const { agent } = project;
    console.log(JSON.stringify({
      errors: hasErrorDiagnostics(project),
      runtime: agent.runtime,
      allowedTools: agent.allowedTools,
      workspaceDir: agent.local?.workspaceDir,
      autoCreatePR: agent.cloud?.autoCreatePR,
      egressDomains: agent.hosting?.egressDomains,
      secretNames: agent.hosting?.secretNames,
    }));
  `;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: ROOT,
    env: { ...childEnv, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").at(-1)!) as Loaded;
}

test("off managed hosting with no checkout every turn is local under the read-only allowlist", () => {
  const agent = load({});
  assert.equal(agent.errors, false);
  assert.equal(agent.runtime, "local");
  assert.deepEqual(agent.allowedTools, READ_ONLY);
  assert.equal(agent.workspaceDir, undefined);
});

test("a local checkout keeps the allowlist and pins every session's workspace to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-checkout-"));
  const agent = load({ [CHECKOUT_ENV]: dir });
  assert.equal(agent.errors, false);
  assert.equal(agent.runtime, "local");
  assert.deepEqual(agent.allowedTools, READ_ONLY);
  assert.equal(agent.workspaceDir, dir);
});

// July refuses a cloud turn on an agent that declares `tools`
// (discovery/agent.js:166-172, session-engine.js:2090-2092) and hands server
// tools to cloud turns only when the agent declares `cloud` (server.js:955).
test("on managed hosting every turn is a cloud turn, so no local turn runs without the allowlist", () => {
  const agent = load({ [MANAGED_HOSTING_ENV]: "1" });
  assert.equal(agent.errors, false);
  assert.equal(agent.runtime, "cloud");
  assert.equal(agent.allowedTools, undefined);
  assert.equal(agent.autoCreatePR, false);
  assert.ok(agent.egressDomains?.includes("api.cursor.com"));
  assert.equal(agent.secretNames?.includes(CHECKOUT_ENV), false);
});

// The hosting signal alone decides, so a checkout that reaches a hosted pod
// cannot turn the agent local at boot while planSessionCloud fails each send
// by name (lib/checkout.ts).
test("on managed hosting a set checkout changes nothing about the agent: still cloud, no workspace pin", () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-checkout-"));
  const agent = load({ [MANAGED_HOSTING_ENV]: "1", [CHECKOUT_ENV]: dir });
  assert.equal(agent.errors, false);
  assert.equal(agent.runtime, "cloud");
  assert.equal(agent.allowedTools, undefined);
  assert.equal(agent.workspaceDir, undefined);
});

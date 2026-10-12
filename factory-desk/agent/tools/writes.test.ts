import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadAgentProject } from "@cursor/july";

// Reads source instead of importing each tool. The host treats an authored
// tool without `effect` as a write, and a write without dryRunResult is
// answered with a generic string in a dry-run session, so the result shape
// the model reads changes between a live and a dry run. Only a declared
// read is exempt.
const dir = dirname(fileURLToPath(import.meta.url));

async function toolFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
}

// Every file here is discovered as a tool the model can call. The lifecycle
// announcements live in agent/lib/announce.ts, which is never discovered.
test("the desk has exactly four model tools and no announce or GitHub tool", async () => {
  assert.deepEqual(await toolFiles(), [
    "approve_ticket.ts",
    "deny_ticket.ts",
    "file_ticket.ts",
    "request_plan.ts",
  ]);
});

test("every tool that is not a declared read declares dryRunResult", async () => {
  const names = await toolFiles();
  const missing: string[] = [];
  for (const name of names) {
    const source = await readFile(join(dir, name), "utf8");
    const read = /effect:\s*["']read["']/.test(source);
    const dryRun = /\bdryRunResult\b/.test(source);
    if (!read && !dryRun) missing.push(name);
  }
  assert.deepEqual(missing, []);
});

// July 0.2.12+ re-runs a read-effect tool up to three times when its error
// looks transient, matching a bare 429/502/503/504 anywhere in the message,
// so a Jira key like MARS-503 would read as one. Every desk tool moves or
// writes Jira, and the connector reads behind them go through ctx.host.mcp,
// which July never retries. A read tool added here needs its error text
// checked against that match first.
test("every desk tool is a declared write, so July's read-tool retry never re-runs one", async () => {
  const project = await loadAgentProject(join(dir, "..", ".."));
  assert.deepEqual(
    project.agent.tools.map((tool) => [tool.name, tool.effect]),
    [
      ["approve_ticket", "write"],
      ["deny_ticket", "write"],
      ["file_ticket", "write"],
      ["request_plan", "write"],
    ]
  );
});

test("no desk tool declares needsApproval; the gates are text replies in the thread", async () => {
  const gated: string[] = [];
  for (const name of await toolFiles()) {
    if (/\bneedsApproval\b/.test(await readFile(join(dir, name), "utf8"))) gated.push(name);
  }
  assert.deepEqual(gated, []);
});

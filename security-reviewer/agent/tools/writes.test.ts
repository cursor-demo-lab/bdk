import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Reads source instead of importing each tool. The host treats an authored
// tool without `effect` as a write, and a write without dryRunResult is
// answered with a generic string in a dry-run session, so the result shape
// the model reads changes between a live and a dry run. Only a declared
// read is exempt.
test("every tool that is not a declared read declares dryRunResult", async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  const missing: string[] = [];
  for (const name of names) {
    const source = await readFile(join(dir, name), "utf8");
    const read = /effect:\s*["']read["']/.test(source);
    const dryRun = /\bdryRunResult\b/.test(source);
    if (!read && !dryRun) missing.push(name);
  }
  assert.deepEqual(missing, []);
});

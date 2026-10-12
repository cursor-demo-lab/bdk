import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "merge-gate.sh");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function fakeGh(states) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const cases = Object.entries(states)
    .map(([pr, state]) => (state === null ? `  ${pr}) exit 1 ;;` : `  ${pr}) echo ${state} ;;`))
    .join("\n");
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash\ncase "$3" in\n${cases}\nesac\n`);
  chmodSync(gh, 0o755);
  return dir;
}

function warnOnly(env) {
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, GATE_WARN_ONLY: "1", GATE_VALIDATED_SHA: "", GATE_MERGE_AFTER: "", ...env },
  });
  return { status: result.status, lines: result.stdout.split("\n").filter(Boolean) };
}

test("no preconditions set prints no warnings", () => {
  assert.deepEqual(warnOnly({}), { status: 0, lines: [] });
});

test("a validator sha that is not the gated sha warns, and never fails the gate", () => {
  assert.deepEqual(warnOnly({ GATE_VALIDATED_SHA: "0000000" }), {
    status: 0,
    lines: [`WARN  validator sha 0000000 != gated sha ${head}`],
  });
});

test("the validator sha may be a prefix of the gated sha", () => {
  assert.deepEqual(warnOnly({ GATE_VALIDATED_SHA: head.slice(0, 7) }), { status: 0, lines: [] });
});

test("an open or unreadable Merge-after PR warns; a merged one does not", () => {
  const bin = fakeGh({ 11: "OPEN", 12: "MERGED", 13: null, 14: "CLOSED" });
  assert.deepEqual(warnOnly({ GATE_MERGE_AFTER: "11 12 13 14", PATH: `${bin}:${process.env.PATH}` }), {
    status: 0,
    lines: ["WARN  Merge-after: #11 open", "WARN  Merge-after: #13 state unreadable", "WARN  Merge-after: #14 closed"],
  });
});

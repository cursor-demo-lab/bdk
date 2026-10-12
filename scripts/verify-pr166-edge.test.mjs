import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { planStoppedComment } from "../planner/agent/lib/needs-info.ts";

register("./ts-resolve.mjs", import.meta.url);
const { skipReason } = await import("../planner/agent/lib/plan-outcome.ts");

// The desk's Plan stopped relay edge test feeds a literal skipped-entry
// comment; this holds it to what the planner actually writes.

test("the desk edge test's skipped Plan stopped: literal is the planner's own skipped-entry comment", () => {
  const why = skipReason({ plan: false, reason: "question", issueKey: "TLSSN-40", changelogId: "c", from: "desk", replan: false });
  const written = planStoppedComment({ issueKey: "TLSSN-40", why, at: new Date("2026-09-27T05:10:00Z"), skipped: true });
  const source = readFileSync(new URL("../factory-desk/agent/channels/jira.plan-stopped-edge.test.ts", import.meta.url), "utf8");
  const literal = source.match(/const SKIPPED = \[\n([\s\S]*?)\n\]\.join\("\\n"\);/)?.[1];
  assert.ok(literal !== undefined);
  const lines = literal.split("\n").map((line) => JSON.parse(line.trim().replace(/,$/, "")));
  assert.equal(lines.join("\n"), written);
});

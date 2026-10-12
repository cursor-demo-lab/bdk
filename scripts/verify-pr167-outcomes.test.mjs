import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { parseTriageOutcome } from "../factory-desk/agent/lib/triage-outcome.ts";
import { parsePlannerOutcome } from "../factory-desk/agent/lib/planner-outcome.ts";
import { planStoppedComment } from "../planner/agent/lib/needs-info.ts";
import { triageStoppedComment } from "../triage-jira/agent/lib/triage-stopped.ts";

register("./ts-resolve.mjs", import.meta.url);
const { planStoppedMessage, triageStoppedMessage } = await import("../factory-desk/agent/lib/threads.ts");
const { stopReason: triageStopReason } = await import("../triage-jira/agent/lib/triage-outcome.ts");
const { stopReason: planStopReason } = await import("../planner/agent/lib/plan-outcome.ts");

// Independent verification of PR #167: triage-jira and the planner cut a
// long failure at 300 in the Jira comment (mid-word, their own `cut`); the
// desk's outcome line re-cuts the longer `Why:` between words, so Slack never
// shows the Jira-side mid-word cut.

const AT = new Date("2026-09-27T04:41:00Z");
const long = "resource_exhausted while streaming the transcript from the orchestrator backend ".repeat(8);

function whyLine(message) {
  return message.split("\n").find((line) => line.startsWith("Why: ")).slice(5);
}
function assertClean(why) {
  assert.ok(why.length <= 300, `${why.length}`);
  assert.ok(why.endsWith("…"));
  const kept = why.slice(0, -1);
  assert.doesNotMatch(kept, /[,;:\s(]$/);
}

test("Triage stopped: a 600-character failure reaches Slack's Why: line cut between words", () => {
  const why = triageStopReason({ failed: long, statuses: { todo: "To Do", triaged: "Triaged" } });
  const body = triageStoppedComment({ issueKey: "TLSSN-42", why, at: AT, triaged: "Triaged" });
  const outcome = parseTriageOutcome(body, "TLSSN-42");
  const shown = whyLine(triageStoppedMessage({ issueKey: "TLSSN-42", prefix: "", outcome }));
  assertClean(shown);
  const words = new Set(long.split(/\s+/));
  const last = shown.slice(0, -1).split(/\s+/).pop();
  assert.ok(words.has(last), `last word whole: ${last}`);
});

test("Plan stopped: a 600-character failure reaches Slack's Why: line cut between words", () => {
  const why = planStopReason({ failed: long, repo: "cursor-demo-lab/marsbank", ref: "main" });
  const body = planStoppedComment({ issueKey: "TLSSN-42", why, at: AT });
  const outcome = parsePlannerOutcome(body, "TLSSN-42");
  const shown = whyLine(planStoppedMessage({ issueKey: "TLSSN-42", prefix: "", outcome }));
  assertClean(shown);
  const last = shown.slice(0, -1).split(/\s+/).pop();
  assert.ok(new Set(long.split(/\s+/)).has(last), `last word whole: ${last}`);
});

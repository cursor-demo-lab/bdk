import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { readOutcome, reportSkippedPlan, settled, skipClaimKey, skipReason, stopReason, type PlanOutcome } from "./plan-outcome.js";

const SANDBOX = { repo: "cursor-demo-lab/marsbank", ref: "main" };

test("a Needs info comment, a plan moved to Planned, or a plan that found the ticket moved on is the run's outcome", () => {
  const cases: Array<[PlanOutcome | undefined, boolean]> = [
    [{ tool: "record_needs_info", reason: "commented", tracker: "commented" }, true],
    [{ tool: "record_needs_info", reason: "already_commented", tracker: "already_commented" }, true],
    [{ tool: "record_needs_info", reason: "not_triaged", tracker: "skipped" }, true],
    [{ tool: "record_needs_info", reason: "failed", tracker: "failed", message: "403" }, false],
    [{ tool: "record_plan", reason: "recorded", tracker: "commented", transition: "transitioned" }, true],
    [{ tool: "record_plan", reason: "recorded", tracker: "already_commented", transition: "already" }, true],
    [{ tool: "record_plan", reason: "not_triaged", tracker: "skipped", transition: "skipped_status" }, true],
    [{ tool: "record_plan", reason: "recorded", tracker: "commented", transition: "no_transition" }, false],
    [{ tool: "record_plan", reason: "recorded", tracker: "failed" }, false],
    [{ tool: "record_plan", reason: "paths_missing", tracker: "skipped", missing: ["lib/x.ts"] }, false],
    [undefined, false],
  ];
  for (const [outcome, expected] of cases) assert.equal(settled(outcome), expected, JSON.stringify(outcome));
});

test("the stop reason says what the run did last, in words a person can act on", () => {
  assert.equal(
    stopReason({ ...SANDBOX, outcome: { tool: "record_plan", reason: "paths_missing", tracker: "skipped", missing: ["lib/csv.ts", "lib/export.ts"] } }),
    "The plan cited paths that are not on cursor-demo-lab/marsbank@main (lib/csv.ts, lib/export.ts), so it was not recorded."
  );
  assert.equal(
    stopReason({ ...SANDBOX, outcome: { tool: "record_plan", reason: "unverified", tracker: "skipped" } }),
    "The plan did not cite code the planner opened on cursor-demo-lab/marsbank@main, so it was not recorded."
  );
  assert.equal(
    stopReason({ ...SANDBOX, outcome: { tool: "record_plan", reason: "recorded", tracker: "failed", message: "403 Forbidden." } }),
    "The plan could not be written to the ticket (failed: 403 Forbidden)."
  );
  assert.equal(
    stopReason({ ...SANDBOX, outcome: { tool: "record_plan", reason: "recorded", tracker: "commented", transition: "no_transition" } }),
    "The plan is on the ticket, but it was not moved to Planned (no_transition). Move the card to Planned in Jira to post the plan in the thread."
  );
  assert.equal(
    stopReason({ ...SANDBOX, outcome: { tool: "record_needs_info", reason: "not_connected", tracker: "not_connected" } }),
    "The planner did not find the failure on cursor-demo-lab/marsbank@main, but its Needs info comment did not land (not_connected)."
  );
  assert.equal(stopReason({ ...SANDBOX, failed: "resource_exhausted:\n try again later." }), "The planning run failed: resource_exhausted: try again later.");
  assert.equal(
    stopReason({ ...SANDBOX, failed: "boom", outcome: { tool: "record_plan", reason: "unverified", tracker: "skipped" } }),
    "The plan did not cite code the planner opened on cursor-demo-lab/marsbank@main, so it was not recorded."
  );
  assert.equal(stopReason(SANDBOX), "The planning run ended without recording a plan or saying what information it needs.");
  assert.ok(stopReason({ ...SANDBOX, failed: "x".repeat(900) }).length < 340);
});

test("an outcome record that is not one of the two tools' shapes reads as none", async () => {
  const kv = (value: JsonValue): HostKvApi => ({ get: async () => value, put: async () => {}, delete: async () => {} });
  assert.equal(await readOutcome(kv({ tool: "record_triage", reason: "x", tracker: "y" }), "ses_1"), undefined);
  assert.equal(await readOutcome(kv("recorded"), "ses_1"), undefined);
  const down: HostKvApi = { get: async () => { throw new Error("kv down"); }, put: async () => {}, delete: async () => {} };
  assert.equal(await readOutcome(down, "ses_1"), undefined);
  assert.deepEqual(await readOutcome(kv({ tool: "record_plan", reason: "paths_missing", tracker: "skipped", missing: ["a", 3] }), "ses_1"), {
    tool: "record_plan",
    reason: "paths_missing",
    tracker: "skipped",
    missing: ["a"],
  });
});

test("skipReason names whose verdict stopped the plan and why", () => {
  const skip = { plan: false as const, issueKey: "TLSSN-40", changelogId: "c1" };
  assert.equal(skipReason({ ...skip, reason: "duplicate", from: "latest", duplicateOf: "TLSSN-38" }), "The triage verdict (the latest Triage: comment) marks it a duplicate of TLSSN-38, and the planner does not plan duplicates.");
  assert.equal(skipReason({ ...skip, reason: "duplicate", from: "latest" }), "The triage verdict (the latest Triage: comment) marks it a duplicate of another ticket, and the planner does not plan duplicates.");
  assert.equal(skipReason({ ...skip, reason: "needs_info", from: "desk" }), "The triage verdict (factory-desk's triage from filing) asks for more information, and no reply in the ticket's Slack thread has answered it yet.");
  assert.equal(skipReason({ ...skip, reason: "question", from: "triage" }), "The triage verdict (the Triage: comment triage wrote) is a question, and the planner does not plan questions.");
  assert.equal(skipClaimKey(skip), "plan-skip/TLSSN-40:c1");
});

test("reportSkippedPlan releases its claim when the comment does not land, so a redelivery retries", async () => {
  const store = new Map<string, unknown>();
  const kv = { get: async (key: string) => store.get(key) as never, put: async (key: string, value: unknown) => void store.set(key, value), delete: async (key: string) => void store.delete(key) };
  const skip = { plan: false as const, reason: "question" as const, from: "latest" as const, issueKey: "TLSSN-40", changelogId: "c1" };
  const env = { FACTORY_PLANNER_JIRA_PROJECTS: "TLSSN" };
  const unconnected = { names: () => [], listTools: async () => [], callTool: async () => ({ content: [] }) };
  const report = await reportSkippedPlan({ skip, kv: kv as never, mcp: unconnected as never, env, now: new Date() });
  assert.equal(report.status, "reported");
  assert.equal(store.has(skipClaimKey(skip)), false);

});

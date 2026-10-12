import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register("./ts-resolve.mjs", import.meta.url);
const { HOPS, PLAN_START_DEADLINE_MS, PLAN_START_RETRY_TTL_MS, PLAN_START_UNREAD_RETRY_MS, MAX_UNREAD } = await import("../factory-desk/agent/lib/hop-watch.ts");
const { START_SKEW_MS, PLANNING_LIVE_MS } = await import("../factory-desk/agent/lib/planner-liveness.ts");
const { LAUNCH_GRACE_MS, STALE_PENDING_MS } = await import("../factory-worker/agent/lib/claim.ts");
const { LAUNCH_TIMEOUT_MS } = await import("../factory-worker/agent/lib/launch.ts");
const { LAUNCH_LATE_WAIT_MS } = await import("../factory-worker/agent/lib/handle.ts");
const { LAUNCH_HEAL_FIRST_MS } = await import("../factory-worker/agent/lib/launch-watch.ts");

// The desk's launch hop watch and the worker's own recovery run on one
// clock from the move into Approved (TLSSN-51). The desk speaks, and lets a
// person `retry`, only once the worker had its chance to relaunch by itself:
// its claim's grace, then its watch's first fire, then one launch deadline
// and the late wait after it, plus a minute for Jira and the agents API.
// A desk that spoke first would send people to retry a launch the worker
// was about to heal; one far later would leave a real stall unannounced.

const MIN = 60_000;
const HEAL_DONE_MS = LAUNCH_HEAL_FIRST_MS + LAUNCH_TIMEOUT_MS + LAUNCH_LATE_WAIT_MS;

test("the desk's launch deadline falls a minute or more after the worker's own relaunch could last have landed", () => {
  assert.ok(LAUNCH_HEAL_FIRST_MS > LAUNCH_GRACE_MS, "the watch fires only once a pending claim is lost");
  assert.equal(HEAL_DONE_MS, 5.5 * MIN, "4 min first fire + 30 s deadline + 60 s late wait");
  assert.ok(HOPS.launch.deadlineMs >= HEAL_DONE_MS + MIN, "the desk waits for the heal's launch, its late wait, and a margin");
  assert.ok(HOPS.launch.deadlineMs >= LAUNCH_GRACE_MS, "a desk retry after the deadline takes any pending claim over");
});

test("and not much later: the desk's line comes within two minutes of that", () => {
  assert.ok(HOPS.launch.deadlineMs <= HEAL_DONE_MS + 2 * MIN);
  assert.equal(HOPS.launch.deadlineMs, 7 * MIN);
  assert.ok(HOPS.launch.deadlineMs < STALE_PENDING_MS, "shorter than the old 10-minute window it was sized for");
});

// The plan hop's start check (TLSSN-60: a hosted delivery that never started
// its turn) reads the planner's `Planning started:` marker, which a healthy
// run writes within seconds of the Triaged move. The check waits out the
// clock skew the marker is allowed and a cold pod, re-sends once, and is done
// (its unread retries included) well before the 15-minute line would speak.
test("the plan start check falls after the marker's skew allowance and, with its unread retries, before the plan deadline", () => {
  assert.equal(PLAN_START_DEADLINE_MS, 4 * MIN);
  assert.ok(PLAN_START_DEADLINE_MS >= START_SKEW_MS + MIN, "a marker inside the skew allowance is still this entry's; the check waits past it");
  assert.ok(PLAN_START_DEADLINE_MS + (MAX_UNREAD - 1) * PLAN_START_UNREAD_RETRY_MS < HOPS.plan.deadlineMs, "an unread Jira never pushes the check past the deadline line");
  assert.ok(2 * PLAN_START_DEADLINE_MS + HOPS.plan.deadlineMs < PLAN_START_RETRY_TTL_MS, "one re-send record outlives the whole episode: two checks and the deadline line");
  assert.ok(PLAN_START_RETRY_TTL_MS > PLANNING_LIVE_MS, "and a run that is lost rather than never started");
});

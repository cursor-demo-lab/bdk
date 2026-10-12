import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { triageOutcomeKind, parseTriageOutcome } from "../factory-desk/agent/lib/triage-outcome.ts";
import { parsePlannerOutcome } from "../factory-desk/agent/lib/planner-outcome.ts";
import { parseWorkerOutcome } from "../factory-desk/agent/lib/worker-outcome.ts";
import { needsInfoComment, planStoppedComment } from "../planner/agent/lib/needs-info.ts";
import { triageStoppedComment } from "../triage-jira/agent/lib/triage-stopped.ts";

register("./ts-resolve.mjs", import.meta.url);
const { DETAIL_SENTINEL } = await import("../factory-desk/agent/lib/triage-comment.ts");
const { latestImplementingComment, latestPullRequestComment } = await import("../factory-desk/agent/lib/status-event.ts");
const { adoptedComment, launchFailedComment, launchPendingComment, launchSkippedComment, noBriefComment, relaunchedComment, staleApprovalComment } = await import("../factory-worker/agent/lib/decide.ts");
const { PLANNING_STARTED_SENTINEL: DESK_STARTED, parsePlanningStarted } = await import("../factory-desk/agent/lib/planner-liveness.ts");
const { outcomeKind } = await import("../factory-desk/agent/lib/outcomes.ts");
const { PLANNING_STARTED_SENTINEL: PLANNER_STARTED, planningStartedComment } = await import("../planner/agent/lib/planning-started.ts");
const { prStatusNote, pullRequestComment } = await import("../factory-worker/agent/lib/pr-decide.ts");

// Every comment an agent leaves instead of moving the ticket is announced by
// the desk, which wakes on the comment's first line. The agents are separate
// projects, so this is the one place their writers meet the desk's parsers:
// a change to either side that breaks the other fails here, not in a silent
// Slack thread.

const AT = new Date("2026-09-25T04:41:00Z");
const WORKER_STATUSES = { inReview: "In Review", done: "Done" };

test("triage's Triage stopped comment is the desk's triage_stopped, with its Why: line", () => {
  const body = triageStoppedComment({ issueKey: "TLSSN-42", why: "The triage run failed: resource_exhausted.", at: AT, triaged: "Triaged" });
  assert.equal(triageOutcomeKind(body, "TLSSN-42"), "triage_stopped");
  assert.deepEqual(parseTriageOutcome(body, "TLSSN-42"), { kind: "triage_stopped", why: "The triage run failed: resource_exhausted." });
  assert.equal(triageOutcomeKind(body, "TLSSN-4"), undefined);
});

test("the planner's Needs info and Plan stopped comments are the desk's needs_info and plan_stopped", () => {
  const needsInfo = needsInfoComment({
    issueKey: "TLSSN-42",
    repo: "cursor-demo-lab/marsbank",
    ref: "main",
    claimed: "CSV export truncates the last column.",
    mismatch: "No CSV export on main.",
    searched: ["csv export"],
    at: AT,
  });
  assert.deepEqual(parsePlannerOutcome(needsInfo, "TLSSN-42"), {
    kind: "needs_info",
    repo: "cursor-demo-lab/marsbank",
    ref: "main",
    claimed: "CSV export truncates the last column.",
    mismatch: "No CSV export on main.",
    searched: ["csv export"],
  });
  const stopped = planStoppedComment({ issueKey: "TLSSN-42", why: "The planning run failed: boom.", at: AT });
  assert.deepEqual(parsePlannerOutcome(stopped, "TLSSN-42"), { kind: "plan_stopped", why: "The planning run failed: boom." });
});

test("the planner's Plan stopped for a Triaged entry its verdict gate skipped is the desk's plan_stopped, with its Why: line", () => {
  const why = "The triage verdict (the latest Triage: comment) is a question, and the planner does not plan questions.";
  const skipped = planStoppedComment({ issueKey: "TLSSN-42", why, at: AT, skipped: true });
  assert.match(skipped.split("\n")[1], /^The planner did not start a planning run for this move to Triaged at /);
  assert.deepEqual(parsePlannerOutcome(skipped, "TLSSN-42"), { kind: "plan_stopped", why, skipped: true });
  assert.equal(parsePlannerOutcome(planStoppedComment({ issueKey: "TLSSN-42", why, at: AT }), "TLSSN-42")?.skipped, undefined, "a run that stopped is not a skip");
});

test("every Launch failed: reason the worker writes is the desk's launch_failed, with the reason", () => {
  // claim_unavailable, comments_unreadable, status_unreadable, config, and launch_lost are the lost-launch fixes' reasons (TLSSN-51).
  for (const reason of ["service_unavailable", "invalid_model", "name_too_long", "unauthorized", "unknown_error", "claim_unavailable", "comments_unreadable", "status_unreadable", "config", "launch_lost", "x".repeat(60)]) {
    const body = launchFailedComment(reason);
    assert.deepEqual(parseWorkerOutcome(body, "TLSSN-42", WORKER_STATUSES), { kind: "launch_failed", reason: reason.slice(0, 40) }, reason);
  }
});

test("the worker's Launch pending: and Launch skipped: trace lines are no outcome the desk announces or lets end its hop watch", () => {
  const bodies = [
    ...["in_flight", "unconfirmed", "claim_unavailable", "comments_unreadable", "status_unreadable", "agent_unverified"].flatMap((kind) =>
      [true, false].map((timer) => launchPendingComment({ issueKey: "TLSSN-42", kind, graceMinutes: 4, timer }))
    ),
    launchSkippedComment({ issueKey: "TLSSN-42", url: "https://cursor.com/agents/bc-1" }),
    staleApprovalComment({ issueKey: "TLSSN-42", current: "Planned" }),
  ];
  for (const body of bodies) {
    assert.equal(parseWorkerOutcome(body, "TLSSN-42", WORKER_STATUSES), undefined, body);
    assert.equal(outcomeKind(body, "TLSSN-42", { ...WORKER_STATUSES, triaged: "Triaged", planned: "Planned", approved: "Approved", inProgress: "In Progress" }), undefined, body);
    assert.equal(latestImplementingComment([body]), undefined, `${body} is not an agent URL`);
  }
});

test("the worker's relaunch and adoption comments are still the Implementing: line the desk reads the agent URL from", () => {
  assert.equal(latestImplementingComment([relaunchedComment({ url: "https://cursor.com/agents/bc-healed", attempt: 2 })]), "https://cursor.com/agents/bc-healed");
  assert.equal(latestImplementingComment([adoptedComment("https://cursor.com/agents/bc-lost")]), "https://cursor.com/agents/bc-lost");
});

test("the worker's Approved without a plan comment is the desk's approved_without_plan, for that ticket only", () => {
  const body = noBriefComment("TLSSN-42");
  assert.deepEqual(parseWorkerOutcome(body, "TLSSN-42", WORKER_STATUSES), { kind: "approved_without_plan" });
  assert.equal(parseWorkerOutcome(body, "TLSSN-4", WORKER_STATUSES), undefined);
  assert.equal(parseWorkerOutcome(noBriefComment("TLSSN-420"), "TLSSN-42", WORKER_STATUSES), undefined);
});

test("the desk and the planner read the same Detail from Slack: first line as the answer to a needs-info verdict", () => {
  const planner = readFileSync(new URL("../planner/agent/lib/jira-event.ts", import.meta.url), "utf8");
  const desk = readFileSync(new URL("../factory-desk/agent/lib/thread-detail.ts", import.meta.url), "utf8");
  assert.equal(planner.match(/export const DETAIL_SENTINEL = "([^"]+)";/)?.[1], DETAIL_SENTINEL);
  assert.match(desk, /\$\{DETAIL_SENTINEL\} \$\{input\.issueKey\}/);
});

test("the worker's Pull request: comment is the link the desk puts in its In Review and Done lines", () => {
  const url = "https://github.com/cursor-demo-lab/marsbank/pull/19";
  assert.deepEqual(latestPullRequestComment(["Implementing: https://cursor.com/agents/bc-1", pullRequestComment(url)]), { url, label: "cursor-demo-lab/marsbank#19" });
});

test("every note the worker leaves when its pull request did not move the ticket is the desk's move_skipped", () => {
  const skipped = [
    { status: "skipped_status", current: "Planned" },
    { status: "skipped_status" },
    { status: "no_transition", available: ["Done"] },
    { status: "no_transition", available: [] },
    { status: "failed" },
  ];
  for (const [target, expected] of [["In Review", "In Progress"], ["Done", "a factory status before Done"]]) {
    for (const move of skipped) {
      const body = prStatusNote({ issueKey: "TLSSN-9", pr: "cursor-demo-lab/marsbank#13", target, expected, skipped: move });
      const parsed = parseWorkerOutcome(body, "TLSSN-9", WORKER_STATUSES);
      assert.equal(parsed?.kind, "move_skipped", body);
      assert.equal(parsed.target, target);
      assert.equal(parsed.pr, "cursor-demo-lab/marsbank#13");
      assert.equal(`${target} not set from ${parsed.pr}: ${parsed.detail}`, body);
    }
  }
});

test("the planner's Planning started: comment is the desk's liveness marker, and no outcome it announces", () => {
  assert.equal(PLANNER_STARTED, DESK_STARTED);
  const body = planningStartedComment({ issueKey: "TLSSN-45", sessionId: "ses_8de9de41", at: AT });
  assert.deepEqual(parsePlanningStarted({ body, issueKey: "TLSSN-45" }), { sessionId: "ses_8de9de41", startedAt: AT.toISOString() });
  assert.equal(parsePlanningStarted({ body, issueKey: "TLSSN-4" }), undefined);
  const statuses = { todo: "To Do", triaged: "Triaged", planned: "Planned", approved: "Approved", inProgress: "In Progress", inReview: "In Review", done: "Done" };
  assert.equal(outcomeKind(body, "TLSSN-45", statuses), undefined);
  assert.equal(parsePlannerOutcome(body, "TLSSN-45"), undefined);
});

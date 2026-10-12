import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { githubClient, readOnly, runDrive } from "./e2e-drive.mjs";
import {
  adfText,
  agentCommentsSince,
  annotateConnector,
  attribute,
  bindRuns,
  captureBaseline,
  driveCommentPrompt,
  evaluateAgentRun,
  githubMode,
  GITHUB_STEPS,
  openPrPrompt,
  pickCursorKey,
  prBody,
  verifyAgentComment,
  verifyAgentPr,
  settleVerdict,
  isExactDriveComment,
  commitEvidence,
  ciEvidence,
  ciState,
  cleanupPlan,
  connectorSignal,
  decideAdvance,
  decideApprove,
  decideDriveComment,
  decidePr,
  decideReset,
  decideTicket,
  DEFAULTS,
  describeCredentials,
  deskOutcome,
  evaluateDrive,
  evaluateHop,
  evaluateRedCheck,
  evaluateSecurityReview,
  formatEvidence,
  githubActor,
  githubCommentEvidence,
  hasBrief,
  headMoved,
  implementingUrl,
  isPlanComment,
  isSafeToDelete,
  issueEvidence,
  issueFacts,
  newTicketFields,
  openedEvent,
  parseCli,
  pickTransition,
  pinRestarts,
  poll,
  postEvidence,
  postOutcome,
  prEvidence,
  PRIOR_PASS,
  priorRun,
  protectedRefs,
  pusherOf,
  readPages,
  renderReport,
  renderSummary,
  renderTable,
  replayTransition,
  requireEvidence,
  resolveCredentials,
  resolveRoutes,
  result,
  reviewEvidence,
  routesFromDoc,
  runOnPr,
  selectSteps,
  sinceBaseline,
  summarizeResults,
  ticketSummary,
  triageGate,
  USAGE,
} from "./e2e-lib.mjs";
import { createdBody, signature, signedRequest, transitionBody } from "./jira-payload.mjs";
import * as replayScript from "./replay-jira-transition.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** Red-check with the PR head the tests mean: the last listed commit unless the case names one. */
const redCheckAt = (input) => evaluateRedCheck({ headSha: input.commits.at(-1)?.sha, ...input });
const T0 = Date.parse("2026-09-23T04:00:00.000Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

const DRIVER = "712020:726a07dd-driver";
const AGENT = "712020:95b89517-agent";
const WHO = { driverId: DRIVER, agentIds: [] };

function issue({ status = "To Do", comments = [], transitions = [] } = {}) {
  return {
    key: "TLSSN-42",
    id: "10042",
    status,
    summary: "CSV export returns 500",
    description: "",
    url: "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42",
    comments: comments.map((c, i) => ({ id: String(100 + i), author: "the operator", authorId: AGENT, url: `https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42?focusedCommentId=${100 + i}`, ...c })),
    transitions,
  };
}

const TRIAGE = { text: "Triage: bug\nSeverity: high\nSummary: Export 500.", created: at(10) };
const PLAN = { text: "Plan: TLSSN-42 Retry CSV export\nProblem\nx\n\nBrief:\nImplement it.", created: at(20) };
const IMPLEMENTING = { text: "Implementing: https://cursor.com/agents/bc-1", created: at(40) };
const INTO = (id, from, to, seconds, authorId = AGENT) => ({ id: String(id), from, to, created: at(seconds), author: "the operator", authorId });

// ---------------------------------------------------------------- CLI and config

test("parseCli defaults to replay with every step but cleanup, reads flags, and rejects bad combinations", () => {
  const defaults = parseCli([]);
  assert.equal(defaults.mode, "replay");
  assert.deepEqual([...defaults.steps], ["ticket", "triage", "plan", "announce", "approve", "progress", "prs", "review", "red-check", "drive"]);
  assert.equal(defaults.skipReasons.cleanup, "pass --cleanup");
  assert.deepEqual(defaults.timeouts, { jiraMs: 600_000, githubMs: 1_800_000, agentMs: 900_000, quietMs: 180_000, pollMs: 15_000 });
  assert.equal(defaults.githubFlag, undefined);

  const options = parseCli(["--live", "--ticket", "TLSSN-3", "--assume-blocked", "atlassian,github", "--cleanup", "--cleanup-branches", "--timeout", "5"]);
  assert.equal(options.mode, "live");
  assert.equal(options.ticket, "TLSSN-3");
  assert.deepEqual([...options.assume], ["atlassian", "github"]);
  assert.equal(options.steps.has("cleanup"), true);
  assert.equal(options.timeouts.jiraMs, 5000);
  assert.deepEqual(parseCli(["--help"]), { help: true });
  assert.match(parseCli(["--replay", "--live"]).error, /exclusive/);
  assert.match(parseCli(["--ticket", "tlssn-3"]).error, /not a Jira key/);
  assert.match(parseCli(["--ticket", "TLSSN-3", "--new-ticket"]).error, /exclusive/);
  assert.match(parseCli(["--cleanup-branches"]).error, /needs --cleanup/);
  assert.match(parseCli(["--assume-blocked", "slack"]).error, /atlassian or github/);
  assert.match(parseCli(["--poll", "soon"]).error, /--poll/);
});

test("--github picks the write path: the flag wins, else a write token means token mode", () => {
  assert.equal(parseCli(["--github=cloud-agent"]).githubFlag, "cloud-agent");
  assert.equal(parseCli(["--github", "token"]).githubFlag, "token");
  assert.match(parseCli(["--github=bot"]).error, /--github takes token or cloud-agent, not "bot"/);
  assert.equal(parseCli(["--agent-timeout", "60"]).timeouts.agentMs, 60_000);
  assert.match(parseCli(["--agent-timeout", "soon"]).error, /--agent-timeout/);

  const withToken = { FACTORY_E2E_GITHUB_TOKEN: "github_pat_x" };
  assert.equal(githubMode({ flag: undefined, env: {} }), "cloud-agent");
  assert.equal(githubMode({ flag: undefined, env: { FACTORY_E2E_GITHUB_TOKEN: "  " } }), "cloud-agent");
  assert.equal(githubMode({ flag: undefined, env: withToken }), "token");
  assert.equal(githubMode({ flag: "cloud-agent", env: withToken }), "cloud-agent");
  assert.equal(githubMode({ flag: "token", env: {} }), "token");
});

test("cloud agents launch only with a Cursor user key: the explicit env key, else the stored login", () => {
  assert.deepEqual(pickCursorKey({ env: { FACTORY_E2E_CURSOR_API_KEY: "k1" }, stored: { source: "login", apiKey: "k2" } }), { ok: true, name: "FACTORY_E2E_CURSOR_API_KEY", apiKey: "k1" });
  assert.deepEqual(pickCursorKey({ env: {}, stored: { source: "login", apiKey: "k2" } }), { ok: true, name: "agent-sdk login", apiKey: "k2" });
  assert.match(pickCursorKey({ env: {}, stored: { source: "service-account", apiKey: "k3" } }).reason, /refusing the service-account Cursor key/);
  assert.match(pickCursorKey({ env: {}, stored: { source: "file", apiKey: "k4" } }).reason, /refusing the file Cursor key/);
  assert.match(pickCursorKey({ env: { CURSOR_API_KEY: "k5" } }).reason, /agent-sdk login/);
  const text = describeCredentials({ ...resolveCredentials({}), cursor: { ok: true, name: "agent-sdk login", apiKey: "secret-key" } }).join("\n");
  assert.match(text, /cloud agents: Cursor key from agent-sdk login/);
  assert.equal(text.includes("secret-key"), false);
});

test("selectSteps honours --only and --skip and names unknown steps", () => {
  const only = selectSteps({ only: "plan,drive" });
  assert.deepEqual([...only.steps], ["plan", "drive"]);
  assert.equal(only.reasons.triage, "not in --only");
  const skip = selectSteps({ skip: "announce", cleanup: true });
  assert.equal(skip.steps.has("announce"), false);
  assert.equal(skip.steps.has("cleanup"), true);
  assert.equal(skip.reasons.announce, "--skip");
  assert.deepEqual([...selectSteps({ only: "cleanup" }).steps], ["cleanup"]);
  assert.match(selectSteps({ skip: "deploy" }).error, /unknown step "deploy"/);
});

test("routes come from docs/jira-webhooks.md unless an env override names them", () => {
  const doc = readFileSync(join(here, "..", "docs", "jira-webhooks.md"), "utf8");
  const fromDoc = routesFromDoc(doc);
  for (const slug of ["factory-triage-jira", "factory-planner", "factory-worker", "factory-desk"]) {
    assert.match(fromDoc[slug], /^https:\/\/api\.cursor\.com\/internal\/agentsdk\/agents\/.+\/engine\/v1\/channels\/(webhook|jira)\/$/);
  }
  const routes = resolveRoutes({ FACTORY_ROUTE_PLANNER: "http://127.0.0.1:3000/x", FACTORY_ROUTE_DESK: "" }, doc);
  assert.equal(routes.triage.source, "docs/jira-webhooks.md");
  assert.deepEqual(routes.planner, { slug: "factory-planner", url: "http://127.0.0.1:3000/x", source: "FACTORY_ROUTE_PLANNER" });
  assert.equal(routes.desk.url, undefined);
  assert.equal(resolveRoutes({}, "").worker.source, "none");
});

test("credentials resolve by name and describeCredentials never prints a value", () => {
  const env = { JIRA_API_KEY: "jira-secret-value", JIRA_WEBHOOK_SECRET: "hook-secret-value", FACTORY_E2E_GITHUB_TOKEN: "github_pat_value" };
  const creds = resolveCredentials(env);
  assert.equal(creds.jira.tokenName, "JIRA_API_KEY");
  assert.equal(creds.jira.email, DEFAULTS.email);
  assert.equal(creds.jira.cloudIdSource, "tenant_info");
  const text = describeCredentials(creds, resolveRoutes({}, "")).join("\n");
  for (const value of Object.values(env)) assert.equal(text.includes(value), false);
  assert.match(text, /JIRA_API_KEY/);
  assert.match(text, /FACTORY_E2E_GITHUB_TOKEN/);

  const empty = resolveCredentials({ GH_TOKEN: "ignored", GITHUB_TOKEN: "ignored" });
  assert.equal(empty.github.ok, false);
  assert.equal(empty.github.reason, "set FACTORY_E2E_GITHUB_TOKEN");
  assert.equal(empty.jira.ok, false);
  assert.equal(empty.secret.ok, false);
});

// ---------------------------------------------------------------- Jira facts

test("adfText flattens paragraphs, hard breaks, and lists", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Plan: TLSSN-42 Retry" }] },
      { type: "paragraph", content: [{ type: "text", text: "Brief:", marks: [{ type: "strong" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] }] },
    ],
  };
  assert.equal(adfText(doc), "Plan: TLSSN-42 Retry\nBrief:\na\nb\nc");
  assert.equal(adfText("plain"), "plain");
});

test("issueFacts sorts comments and status transitions and builds links", () => {
  const facts = issueFacts({
    id: "10042",
    key: "TLSSN-42",
    fields: {
      summary: "CSV export",
      status: { name: "Planned" },
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "desc" }] }] },
      comment: {
        comments: [
          { id: "2", created: at(20), body: "Plan: TLSSN-42 x", author: { displayName: "Simon" } },
          { id: "1", created: at(10), body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Triage: bug" }] }] } },
        ],
      },
    },
    changelog: {
      histories: [
        { id: "501", created: at(21), items: [{ field: "status", fromString: "Triaged", toString: "Planned" }] },
        { id: "500", created: at(11), items: [{ field: "status", fromString: "To Do", toString: "Triaged" }, { field: "labels" }] },
        { id: "499", created: at(5), items: [{ field: "assignee" }] },
      ],
    },
  });
  assert.deepEqual(facts.comments.map((c) => c.text), ["Triage: bug", "Plan: TLSSN-42 x"]);
  assert.equal(facts.comments[0].url, "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42?focusedCommentId=1");
  assert.deepEqual(facts.transitions.map((t) => [t.id, t.from, t.to]), [["500", "To Do", "Triaged"], ["501", "Triaged", "Planned"]]);
  assert.equal(facts.description, "desc");
  assert.equal(facts.status, "Planned");
});

test("sentinels match what the agents write", () => {
  assert.equal(isPlanComment("Plan: TLSSN-42 Retry", "TLSSN-42"), true);
  assert.equal(isPlanComment("Plan: TLSSN-42", "TLSSN-42"), true);
  assert.equal(isPlanComment("Plan: TLSSN-420 Retry", "TLSSN-42"), false);
  assert.equal(isPlanComment("Someone: Plan: TLSSN-42", "TLSSN-42"), false);
  assert.equal(hasBrief("x\nBrief:\ny"), true);
  assert.equal(hasBrief("x\n**Brief:**\ny"), true);
  assert.equal(hasBrief("x\nBrief: inline text"), false);
  assert.equal(implementingUrl("Implementing: https://cursor.com/agents/bc-1"), "https://cursor.com/agents/bc-1");
  assert.equal(implementingUrl("Implementing soon"), undefined);
  assert.equal(triageGate("Triage: question\nSeverity: low"), "question");
  assert.equal(triageGate("Triage: bug\nNeeds info: which export?"), "needs_info");
  assert.equal(triageGate("Triage: bug\nDuplicate of: TLSSN-7"), "duplicate");
  assert.equal(triageGate("Triage: bug\nSeverity: high"), undefined);
  const facts = issue({ comments: [{ ...TRIAGE, created: at(-60) }, PLAN, { text: "looks good", created: at(30) }, { ...IMPLEMENTING, authorId: DRIVER }] });
  assert.deepEqual(agentCommentsSince(facts, at(0), WHO).map((c) => c.id), ["101"]);
});

// ---------------------------------------------------------------- hop classification

test("triage hop: pass, wait, missing, stuck, assumed blocked", () => {
  const opts = { timeoutSec: 600, identity: WHO };
  const triaged = [INTO(1, "To Do", "Triaged", 11)];
  assert.equal(evaluateHop("triage", issue({ status: "Triaged", comments: [TRIAGE], transitions: triaged }), { ...opts, timedOut: false }).status, "pass");
  assert.equal(evaluateHop("triage", issue({ status: "Planned", comments: [TRIAGE], transitions: [...triaged, INTO(2, "Triaged", "Planned", 21)] }), { ...opts, timedOut: false }).status, "pass");
  assert.equal(evaluateHop("triage", issue(), { ...opts, timedOut: false }).wait, true);
  const missing = evaluateHop("triage", issue(), { ...opts, timedOut: true });
  assert.equal(missing.status, "fail");
  assert.equal(missing.kind, "missing");
  assert.match(missing.reason, /no Triage: comment within 600s/);
  const stuck = evaluateHop("triage", issue({ comments: [TRIAGE] }), { ...opts, timedOut: true });
  assert.equal(stuck.kind, "stuck");
  assert.match(stuck.reason, /stayed in To Do, expected Triaged/);
  const assumed = evaluateHop("triage", issue(), { timedOut: false, assumeAtlassian: true, identity: WHO });
  assert.equal(assumed.status, "blocked");
  assert.match(assumed.reason, /--assume-blocked atlassian/);
});

test("plan hop: a Brief: is required, and a triage verdict that is not planned is blocked", () => {
  const planned = [INTO(1, "Triaged", "Planned", 21)];
  assert.equal(evaluateHop("plan", issue({ status: "Planned", comments: [TRIAGE, PLAN], transitions: planned }), { timedOut: false, identity: WHO }).status, "pass");
  const noBrief = issue({ status: "Planned", comments: [TRIAGE, { text: "Plan: TLSSN-42 Retry\nProblem", created: at(20) }], transitions: planned });
  assert.equal(evaluateHop("plan", noBrief, { timedOut: false, identity: WHO }).wait, true);
  assert.match(evaluateHop("plan", noBrief, { timedOut: true, identity: WHO }).reason, /no Brief: section/);
  const question = evaluateHop("plan", issue({ status: "Triaged", comments: [{ text: "Triage: question\nSeverity: low", created: at(10) }] }), { timedOut: false, identity: WHO });
  assert.equal(question.status, "blocked");
  assert.match(question.reason, /triage verdict is question/);
});

test("approve hop: pass, worker refusal, and an earlier launch", () => {
  const approved = [INTO(1, "Triaged", "Planned", 21), INTO(2, "Planned", "Approved", 30)];
  const moved = [...approved, INTO(3, "Approved", "In Progress", 41)];
  assert.equal(evaluateHop("approve", issue({ status: "In Progress", comments: [PLAN, IMPLEMENTING], transitions: moved }), { timedOut: false, identity: WHO }).status, "pass");

  const refusal = { text: "Approved without a plan; nothing launched", created: at(31) };
  const refused = evaluateHop("approve", issue({ status: "Approved", comments: [refusal], transitions: approved }), { timedOut: false });
  assert.equal(refused.status, "fail");
  assert.equal(refused.kind, "refused");
  const replanned = issue({ status: "Planned", comments: [refusal, PLAN], transitions: [...approved, INTO(4, "Approved", "Planned", 50)] });
  assert.equal(evaluateHop("approve", replanned, { timedOut: false }).wait, true);

  const early = { ...IMPLEMENTING, created: at(5) };
  const again = issue({ status: "Approved", comments: [PLAN, early], transitions: approved });
  assert.equal(evaluateHop("approve", again, { timedOut: false }).wait, true);
  const blocked = evaluateHop("approve", again, { timedOut: true });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /implement\/TLSSN-42 was launched before this approval/);
});

test("with a baseline, only comments and status moves from this run count as a hop's artifact", () => {
  const before = issue({ status: "In Progress", comments: [TRIAGE, PLAN, IMPLEMENTING], transitions: [INTO(1, "To Do", "Triaged", 11), INTO(2, "Triaged", "Planned", 21)] });
  const baseline = captureBaseline(before, at(100));
  assert.deepEqual(baseline, { at: at(100), status: "In Progress", commentIds: ["100", "101", "102"], latestCommentAt: at(40), transitionIds: ["1", "2"] });

  const reset = { ...before, status: "To Do", transitions: [...before.transitions, INTO(3, "In Progress", "To Do", 101)] };
  const movedAgain = { ...reset, status: "Triaged", transitions: [...reset.transitions, INTO(4, "To Do", "Triaged", 130)] };
  assert.equal(evaluateHop("triage", movedAgain, { timedOut: false, identity: WHO }).status, "pass");
  assert.equal(evaluateHop("triage", movedAgain, { timedOut: false, baseline, identity: WHO }).wait, true);
  const stale = evaluateHop("triage", reset, { timedOut: true, timeoutSec: 30, baseline, identity: WHO });
  assert.equal(stale.status, "fail");
  assert.equal(stale.kind, "stale");
  assert.match(stale.reason, /no new Triage: comment within 30s .*from before this run and does not count/);
  assert.equal(annotateConnector({ results: [stale], signal: connectorSignal([]) })[0].status, "fail");

  const fresh = { ...movedAgain, comments: [...movedAgain.comments, { id: "103", text: "Triage: bug", created: at(125), url: "u", author: "the operator", authorId: AGENT }] };
  assert.equal(evaluateHop("triage", fresh, { timedOut: false, baseline, identity: WHO }).status, "pass");
  const commentOnly = { ...reset, status: "Triaged", comments: fresh.comments };
  assert.equal(evaluateHop("triage", commentOnly, { timedOut: false, baseline, identity: WHO }).wait, true);
  assert.equal(sinceBaseline(fresh, baseline).comments.length, 1);
  assert.equal(sinceBaseline(fresh, undefined), fresh);

  assert.equal(priorRun("triage", before, baseline, WHO)?.status, "pass");
  assert.equal(priorRun("triage", reset, baseline, WHO), undefined);
  assert.equal(priorRun("triage", before, undefined, WHO), undefined);
});

test("a route that does not answer 202 is a fail, never inferred away", () => {
  assert.equal(postOutcome("triage", "factory-triage-jira", { status: 202 }), undefined);
  const refused = postOutcome("triage", "factory-triage-jira", { status: 404 });
  assert.equal(refused.status, "fail");
  assert.equal(refused.kind, "http");
  assert.match(refused.reason, /answered HTTP 404/);
  assert.match(postOutcome("plan", "factory-planner", { status: 0, error: "ECONNREFUSED" }).reason, /failed: ECONNREFUSED/);
  const annotated = annotateConnector({ results: [refused], signal: connectorSignal([]) });
  assert.deepEqual(annotated[0], refused);
});

test("desk hops are unverified on 202 or live, and a fail otherwise", () => {
  const facts = issue({ status: "In Progress" });
  const posted = { kind: "post", slug: "factory-desk", status: 202, at: at(0) };
  const planned = deskOutcome({ step: "announce", mode: "replay", issue: facts, response: { status: 202 }, slug: "factory-desk", evidence: [posted] });
  assert.equal(planned.status, "unverified");
  assert.equal(planned.reason, "factory-desk accepted the Planned transition (HTTP 202); the plan post to Slack is unverified without Slack access");
  assert.deepEqual(planned.evidence, [posted]);
  assert.match(deskOutcome({ step: "progress", mode: "live", issue: facts, slug: "factory-desk" }).reason, /^live: .*the implementation post is unverified without Slack access$/);
  const refused = deskOutcome({ step: "progress", mode: "replay", issue: facts, response: { status: 500 }, slug: "factory-desk", evidence: [posted] });
  assert.equal(refused.status, "fail");
  assert.deepEqual(refused.evidence, [posted]);
});

test("the connector note is appended to missing or stuck Jira fails and never changes a verdict", () => {
  const results = [
    result("triage", "fail", "no Triage: comment", { kind: "missing" }),
    result("plan", "fail", "stuck", { kind: "stuck" }),
    result("approve", "fail", "refused", { kind: "refused" }),
    result("review", "fail", "no review", { kind: "missing" }),
  ];
  const unknown = annotateConnector({ results, signal: connectorSignal([]) });
  assert.deepEqual(unknown.map((r) => r.status), ["fail", "fail", "fail", "fail"]);
  assert.equal(unknown[0].reason, "no Triage: comment; Atlassian connector: unknown (not observable from the driver; no agent-account comment this run)");
  assert.equal(unknown[2].reason, "refused");
  assert.equal(unknown[3].reason, "no review");
  const authorised = annotateConnector({ results, signal: connectorSignal([{ id: "15202", authorId: AGENT }], WHO) });
  assert.equal(authorised[1].reason, `stuck; Atlassian connector: authorised (a non-driver account (${AGENT}) wrote comment 15202 this run)`);
  const pinned = annotateConnector({ results, signal: connectorSignal([{ id: "15202", authorId: AGENT }], { driverId: DRIVER, agentIds: [AGENT] }) });
  assert.equal(pinned[1].reason, "stuck; Atlassian connector: authorised (the agent account wrote comment 15202 this run)");
});

test("attribute tells the driver's account from the agent's by accountId, and says unknown without the driver's id", () => {
  const PINNED = { driverId: DRIVER, agentIds: [AGENT] };
  assert.equal(attribute({ authorId: AGENT }, WHO), "non-driver");
  assert.equal(attribute({ authorId: AGENT }, PINNED), "agent");
  assert.equal(attribute({ authorId: DRIVER }, WHO), "driver");
  assert.equal(attribute({ authorId: "" }, WHO), "unknown");
  assert.equal(attribute({ authorId: AGENT }, { driverId: undefined, agentIds: [] }), "unknown");
  assert.equal(attribute({ authorId: "712020:someone" }, PINNED), "other");
  assert.equal(attribute({ authorId: DRIVER }, { driverId: DRIVER, agentIds: [DRIVER] }), "driver");
});

// ---------------------------------------------------------------- next-step decisions

test("decideTicket reuses --ticket, then an open e2e ticket, else creates", () => {
  assert.deepEqual(decideTicket({ ticketArg: "TLSSN-3", openTickets: [{ key: "TLSSN-9" }] }), { action: "reuse", key: "TLSSN-3", source: "--ticket" });
  assert.equal(decideTicket({ openTickets: [{ key: "TLSSN-9" }, { key: "TLSSN-8" }] }).key, "TLSSN-9");
  assert.deepEqual(decideTicket({ openTickets: [{ key: "TLSSN-9" }], newTicket: true }), { action: "create" });
  assert.deepEqual(decideTicket({ openTickets: [] }), { action: "create" });
  assert.deepEqual(decideTicket({ openTickets: [], create: false }), { action: "missing" });
});

test("approve, advance, and reset decide from the current status", () => {
  assert.deepEqual(decideApprove(issue({ status: "Planned" })), { action: "transition", to: "Approved" });
  assert.equal(decideApprove(issue({ status: "In Progress" })).action, "none");
  assert.match(decideApprove(issue({ status: "Triaged" })).reason, /not Planned/);
  assert.deepEqual(decideAdvance({ issue: issue(), target: "Triaged", upstreamRan: false }), { action: "transition", to: "Triaged" });
  assert.deepEqual(decideAdvance({ issue: issue(), target: "Triaged", upstreamRan: true }), { action: "none" });
  assert.deepEqual(decideAdvance({ issue: issue({ status: "Planned" }), target: "Triaged", upstreamRan: false }), { action: "none" });
  assert.deepEqual(decideReset({ reset: true, issue: issue({ status: "Done" }) }), { action: "transition", to: "To Do" });
  assert.deepEqual(decideReset({ reset: true, issue: issue() }), { action: "none" });
  assert.deepEqual(decideReset({ reset: false, issue: issue({ status: "Done" }) }), { action: "none" });
});

test("replayTransition reuses the real changelog id and status, else synthesizes", () => {
  const real = issue({ status: "Planned", transitions: [INTO(700, "To Do", "Triaged", 11), INTO(701, "Triaged", "Planned", 21)] });
  assert.deepEqual(replayTransition(real, "Triaged", { now: 5, fallbackFrom: "To Do" }), {
    toStatus: "Triaged",
    fromStatus: "To Do",
    changelogId: "700",
    currentStatus: "Planned",
    synthesized: false,
  });
  assert.deepEqual(replayTransition(issue(), "Triaged", { now: 5, fallbackFrom: "To Do" }), {
    toStatus: "Triaged",
    fromStatus: "To Do",
    changelogId: "5",
    currentStatus: "Triaged",
    synthesized: true,
  });
  assert.equal(pickTransition([{ id: "11", name: "To Do", to: { name: "To Do" } }, { id: "61", name: "Approve", to: { name: "Approved" } }], "approved"), "61");
  assert.equal(pickTransition([{ id: "31", name: "Done" }], "Done"), "31");
  assert.equal(pickTransition([], "Done"), undefined);
});

// ---------------------------------------------------------------- GitHub decisions

const REPO = "cursor-demo-lab/marsbank";
const pull = (number, head, title, extra = {}) => ({ number, state: "open", title, html_url: `https://github.com/${REPO}/pull/${number}`, head: { ref: head, repo: { full_name: REPO } }, ...extra });

test("decidePr reuses an open PR with the same head and never creates a duplicate", () => {
  const review = decidePr({ pulls: [pull(12, "factory-test/review", "Factory e2e: review")], repo: REPO, head: "factory-test/review", title: "Factory e2e: review" });
  assert.deepEqual(review, { action: "reuse", number: 12, url: `https://github.com/${REPO}/pull/12`, title: "Factory e2e: review" });
  const retitle = decidePr({ pulls: [pull(13, DEFAULTS.redHead, "red check")], repo: REPO, head: DEFAULTS.redHead, title: DEFAULTS.redTitle, titlePrefix: "TLSSN-3" });
  assert.equal(retitle.action, "retitle");
  assert.equal(retitle.title, DEFAULTS.redTitle);
  assert.equal(decidePr({ pulls: [pull(13, DEFAULTS.redHead, "TLSSN-3 x")], repo: REPO, head: DEFAULTS.redHead, title: DEFAULTS.redTitle, titlePrefix: "TLSSN-3" }).action, "reuse");
  const others = [pull(14, "factory-test/review", "fork", { head: { ref: "factory-test/review", repo: { full_name: "someone/marsbank" } } }), pull(15, "factory-test/review", "closed", { state: "closed" })];
  assert.deepEqual(decidePr({ pulls: others, repo: REPO, head: "factory-test/review", title: "Factory e2e: review" }), { action: "create", head: "factory-test/review", title: "Factory e2e: review" });
  assert.deepEqual(decidePr({ pulls: [], repo: REPO, head: "factory-test/review", title: "t", create: false }), { action: "missing" });
});

test("ciState: a failed run is red even beside a pending one, and green needs every run done", () => {
  const cases = [
    [[], "none"],
    [[{ status: "completed", conclusion: "cancelled" }], "none"],
    [[{ status: "in_progress" }], "pending"],
    [[{ status: "completed", conclusion: "success" }, { status: "in_progress" }], "pending"],
    [[{ status: "completed", conclusion: "cancelled" }, { status: "queued" }], "pending"],
    [[{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }], "red"],
    [[{ status: "completed", conclusion: "failure" }, { status: "queued" }], "red"],
    [[{ status: "completed", conclusion: "timed_out" }, { status: "in_progress" }, { status: "completed", conclusion: "success" }], "red"],
    [[{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "cancelled" }], "green"],
    [[{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "neutral" }], "green"],
  ];
  for (const [runs, state] of cases) assert.equal(ciState(runs), state, JSON.stringify(runs));
});

const commit = (sha, seconds, login) => ({ sha: sha.padEnd(40, "0"), html_url: `https://github.com/${REPO}/commit/${sha}`, ...(login === undefined ? {} : { author: { login } }), commit: { committer: { date: at(seconds) } } });

/** The workflow run GitHub started when `login` pushed `pushed`: the pusher evidence red-check and drive read. */
const pushRun = (pushed, login, { conclusion = "success", id = 3, event = "pull_request" } = {}) => ({ id, status: "completed", conclusion, event, actor: { login }, created_at: pushed.commit.committer.date });

/** The fake world's fixer: the cloud agent it drives pushes and comments as the Cursor app. */
const FIXER = "cursor[bot]";

test("red check: red, then a fixer push, then green", () => {
  const red = commit("aaa", 0);
  const fix = commit("bbb", 100, FIXER);
  assert.equal(redCheckAt({ commits: [red, fix], ci: { [red.sha]: "red", [fix.sha]: "green" }, runs: { [fix.sha]: [pushRun(fix, FIXER)] }, fixerLogins: [FIXER], timedOut: false }).status, "pass");
  assert.equal(redCheckAt({ commits: [red], ci: { [red.sha]: "pending" }, timedOut: false }).wait, true);
  assert.deepEqual(redCheckAt({ commits: [red], ci: { [red.sha]: "red" }, timedOut: false }), { wait: true, note: "red on aaa0000, waiting for the fixer's push" });
  assert.match(redCheckAt({ commits: [red], ci: { [red.sha]: "red" }, timedOut: true, timeoutSec: 60 }).reason, /CI failed on aaa0000 but no commit was pushed after it within 60s/);
  assert.equal(redCheckAt({ commits: [red, fix], ci: { [red.sha]: "red", [fix.sha]: "red" }, timedOut: true }).status, "fail");
  const green = redCheckAt({ commits: [red], ci: { [red.sha]: "green" }, timedOut: false });
  assert.equal(green.status, "blocked");
  assert.match(green.reason, /never force-pushes/);
  assert.equal(redCheckAt({ commits: [red], ci: { [red.sha]: "none" }, timedOut: true }).kind, "missing");
});

const comment = (login, body, seconds, id = seconds) => ({ id, user: { login }, body, created_at: at(seconds), html_url: `https://github.com/${REPO}/pull/12#issuecomment-${id}` });

test("factory: drive is posted once and reused on a re-run", () => {
  assert.deepEqual(decideDriveComment({ comments: [comment("alice", "factory: drive", 0)], driverLogin: "simon" }), { action: "post", body: "factory: drive" });
  const mine = comment("simon", "factory: drive", 0);
  assert.deepEqual(decideDriveComment({ comments: [mine], driverLogin: "simon" }), { action: "reuse", comment: mine });
});

test("drive: exactly one start and a quiet window, also when the sentinel is the fixer's own comment", () => {
  const sentinel = comment("simon", "factory: drive", 0);
  const base = { sentinel, driverLogin: "simon", fixerLogins: [FIXER], quietMs: 60_000, timedOut: false, commits: [] };
  const start = comment("cursor[bot]", "Driving: https://cursor.com/agents/bc-1", 10);
  assert.equal(evaluateDrive({ ...base, comments: [sentinel, start], now: T0 + 30_000 }).wait, true);
  const pass = evaluateDrive({ ...base, comments: [sentinel, start], now: T0 + 80_000 });
  assert.equal(pass.status, "pass");
  assert.match(pass.reason, /one drive start \(comment\)/);
  const push = commit("ccc", 5, FIXER);
  assert.equal(evaluateDrive({ ...base, comments: [sentinel], commits: [push], runs: { [push.sha]: [pushRun(push, FIXER)] }, now: T0 + 80_000 }).status, "pass");

  const echo = evaluateDrive({ ...base, comments: [sentinel, start, comment("cursor[bot]", "factory: drive", 20)], now: T0 + 80_000 });
  assert.equal(echo.status, "fail");
  assert.equal(echo.kind, "loop");
  const two = evaluateDrive({ ...base, comments: [sentinel, start, comment("cursor[bot]", "Driving: https://cursor.com/agents/bc-2", 20)], now: T0 + 80_000 });
  assert.match(two.reason, /two drives/);

  const noise = [sentinel, comment("cursor[bot]", "## Security review\n\n**Verdict:** CLEAN", 5), comment("cursor[bot]", "Cursor Bugbot has reviewed your changes", 6), comment("simon", "note", 7)];
  assert.equal(evaluateDrive({ ...base, comments: noise, now: T0 + 80_000 }).wait, true);
  assert.equal(evaluateDrive({ ...base, comments: noise, now: T0 + 80_000, timedOut: true }).kind, "missing");
  assert.equal(evaluateDrive({ ...base, comments: [sentinel, start], fixerLogins: ["factory-pr-autofixer[bot]"], now: T0 + 80_000 }).wait, true);
  assert.equal(evaluateDrive({ ...base, comments: [sentinel, comment("cursor[bot]", "before", -5)], now: T0 + 80_000 }).wait, true);

  const own = { ...base, sentinel: comment(FIXER, "factory: drive", 0), driverLogin: undefined, now: T0 + 80_000 };
  assert.equal(evaluateDrive({ ...own, comments: [own.sentinel] }).wait, true);
  assert.equal(evaluateDrive({ ...own, comments: [own.sentinel, start] }).status, "pass");
  assert.equal(evaluateDrive({ ...own, comments: [own.sentinel, start, comment(FIXER, "factory: drive", 20)] }).kind, "loop");
});

// ---------------------------------------------------------------- cloud-agent writes

test("the open PR prompt names one PR exactly and forbids every other change", () => {
  const review = openPrPrompt({ repo: REPO, head: DEFAULTS.reviewHead, base: "main", title: DEFAULTS.reviewTitle, body: prBody(DEFAULTS.reviewHead) });
  assert.equal(
    review,
    [
      "You have exactly one task: open one pull request in the GitHub repository cursor-demo-lab/marsbank.",
      "",
      "- head branch: factory-test/review (it already exists on GitHub; use it as it is)",
      "- base branch: main",
      "- title, exactly: Factory e2e: review",
      "- body, exactly: Opened by scripts/e2e-drive.mjs. Fixture branch `factory-test/review`; do not merge.",
      "- ready for review, not a draft",
      "",
      "If an open pull request with head factory-test/review already exists, do not open another one; reply with its URL.",
      "",
      "Do nothing else. Do not edit, create, or delete any file. Do not commit. Do not push.",
      "Do not create, rename, or delete any branch. Do not open any other pull request.",
      "Do not post any other comment, review, or reaction. Do not change the title, body, labels, reviewers, or state of any pull request.",
      "",
      "When you are done, reply with only the pull request URL.",
    ].join("\n")
  );
  const red = openPrPrompt({ repo: REPO, head: DEFAULTS.redHead, base: "main", title: DEFAULTS.redTitle, body: prBody(DEFAULTS.redHead) });
  assert.ok(DEFAULTS.redTitle.startsWith("TLSSN-3:"));
  for (const part of ["- head branch: TLSSN-3-factory-red-check", "- base branch: main", `- title, exactly: ${DEFAULTS.redTitle}`, "Do not commit. Do not push.", "Do not create, rename, or delete any branch."]) {
    assert.ok(red.includes(part), part);
  }
});

test("the drive comment prompt asks for exactly factory: drive and nothing else", () => {
  const prompt = driveCommentPrompt({ repo: REPO, number: 12, url: `https://github.com/${REPO}/pull/12` });
  assert.equal(
    prompt,
    [
      `You have exactly one task: post one comment on pull request #12 in the GitHub repository ${REPO} (https://github.com/${REPO}/pull/12).`,
      "",
      "The comment body must be exactly this one line, with nothing before or after it:",
      "factory: drive",
      "",
      "If that pull request already has a comment whose body is exactly `factory: drive`, post nothing; reply with that comment's URL.",
      "",
      "Do nothing else. Do not edit, create, or delete any file. Do not commit. Do not push.",
      "Do not create, rename, or delete any branch. Do not open any other pull request.",
      "Do not post any other comment, review, or reaction. Do not change the title, body, labels, reviewers, or state of any pull request.",
      "",
      "When you are done, reply with only the comment URL.",
    ].join("\n")
  );
});

test("agent run status: ended runs stop the wait, a stuck run times out", () => {
  const url = "https://cursor.com/agents/bc-1";
  assert.equal(evaluateAgentRun({ status: "running", timedOut: false, url }).wait, true);
  assert.equal(evaluateAgentRun({ status: "finished", timedOut: false, url }).status, "pass");
  assert.equal(evaluateAgentRun({ status: "error", timedOut: false, url }).status, "fail");
  assert.match(evaluateAgentRun({ status: "running", timedOut: true, timeoutSec: 900, url }).reason, /still running after 900s/);
});

const agentPull = (number, head, title, extra = {}) => pull(number, head, title, { base: { ref: "main" }, user: { login: "example-user" }, ...extra });
const RED_SHA = { sha: "124b6f2".padEnd(40, "0"), ahead: 1 };
const verifyRed = (overrides = {}) =>
  verifyAgentPr({
    pulls: [agentPull(7, DEFAULTS.redHead, DEFAULTS.redTitle)],
    commits: [commit("124b6f2", 0)],
    repo: REPO,
    head: DEFAULTS.redHead,
    base: "main",
    title: DEFAULTS.redTitle,
    titlePrefix: DEFAULTS.redTitlePrefix,
    before: RED_SHA,
    after: RED_SHA,
    ...overrides,
  });

test("verifyAgentPr passes the right PR with its GitHub facts, and fails a wrong base, extra commits, a changed title, a duplicate, a moved branch, or no PR", () => {
  const ok = verifyRed();
  assert.equal(ok.status, "pass");
  assert.deepEqual(ok.facts, {
    number: 7,
    url: `https://github.com/${REPO}/pull/7`,
    author: "example-user",
    head: DEFAULTS.redHead,
    base: "main",
    title: DEFAULTS.redTitle,
    draft: false,
    commits: 1,
    shaBefore: RED_SHA.sha,
    shaAfter: RED_SHA.sha,
    aheadBefore: 1,
    aheadAfter: 1,
  });
  assert.match(ok.reason, /#7 by example-user, TLSSN-3-factory-red-check into main, 1 commit\(s\)/);
  const review = verifyAgentPr({ pulls: [agentPull(6, DEFAULTS.reviewHead, DEFAULTS.reviewTitle)], commits: [commit("e7acd1d", 0)], repo: REPO, head: DEFAULTS.reviewHead, base: "main", title: DEFAULTS.reviewTitle, before: { sha: "e".repeat(40), ahead: 1 }, after: { sha: "e".repeat(40), ahead: 1 } });
  assert.equal(review.status, "pass");

  const wrongBase = verifyRed({ pulls: [agentPull(7, DEFAULTS.redHead, DEFAULTS.redTitle, { base: { ref: "develop" } })] });
  assert.equal(wrongBase.status, "fail");
  assert.equal(wrongBase.kind, "agent");
  assert.match(wrongBase.reason, /base is develop, expected main/);
  assert.match(verifyRed({ pulls: [agentPull(7, DEFAULTS.redHead, DEFAULTS.redTitle, { draft: true })] }).reason, /opened as a draft/);

  const moved = { sha: "abcdef1".padEnd(40, "0"), ahead: 2 };
  const extra = verifyRed({ commits: [commit("124b6f2", 0), commit("abcdef1", 10)], after: moved });
  assert.match(extra.reason, /PR has 2 commit\(s\), the branch had 1/);
  assert.match(extra.reason, /moved from 124b6f2 to abcdef1/);
  assert.match(extra.reason, /was 1 commit\(s\) ahead of main, now 2/);

  assert.match(verifyRed({ pulls: [agentPull(7, DEFAULTS.redHead, "TLSSN-3 red check")] }).reason, /expected a "TLSSN-3:" prefix/);
  const retitled = verifyAgentPr({ pulls: [agentPull(6, DEFAULTS.reviewHead, "Factory e2e: review PR")], commits: [commit("e7acd1d", 0)], repo: REPO, head: DEFAULTS.reviewHead, base: "main", title: DEFAULTS.reviewTitle, before: RED_SHA, after: RED_SHA });
  assert.match(retitled.reason, /title is "Factory e2e: review PR", expected "Factory e2e: review"/);

  const duplicate = verifyRed({ pulls: [agentPull(7, DEFAULTS.redHead, DEFAULTS.redTitle), agentPull(8, DEFAULTS.redHead, DEFAULTS.redTitle)] });
  assert.match(duplicate.reason, /duplicate PRs #7, #8/);

  const none = verifyRed({ pulls: [agentPull(7, DEFAULTS.redHead, DEFAULTS.redTitle, { state: "closed" }), agentPull(9, DEFAULTS.redHead, "fork", { head: { ref: DEFAULTS.redHead, repo: { full_name: "someone/marsbank" } } })] });
  assert.equal(none.kind, "missing");
  assert.equal(none.facts, undefined);
});

test("verifyAgentComment wants one exact factory: drive from an allowed login and nothing else", () => {
  const since = at(0);
  const sentinel = comment("example-user", "factory: drive", 10, 501);
  const ok = verifyAgentComment({ comments: [comment("cursor[bot]", "## Security review", 5, 500), sentinel], number: 6, allowedLogins: ["example-user"], since });
  assert.equal(ok.status, "pass");
  assert.deepEqual(ok.facts, { id: 501, url: sentinel.html_url, author: "example-user", body: "factory: drive", createdAt: at(10) });

  const stranger = verifyAgentComment({ comments: [comment("cursor[bot]", "factory: drive", 10)], number: 6, allowedLogins: ["example-user"], since });
  assert.equal(stranger.status, "fail");
  assert.match(stranger.reason, /author cursor\[bot\] is not one of example-user/);

  assert.match(verifyAgentComment({ comments: [sentinel, comment("example-user", "factory: drive\n", 20, 502)], number: 6, allowedLogins: ["example-user"], since }).reason, /2 factory: drive comments/);
  assert.match(verifyAgentComment({ comments: [sentinel, comment("example-user", "Posted it: https://x", 20, 503)], number: 6, allowedLogins: ["example-user"], since }).reason, /also posted 1 other comment/);
  const fixerSameApp = [sentinel, comment("example-user", "Driving: https://cursor.com/agents/bc-9", 60, 504)];
  assert.equal(verifyAgentComment({ comments: fixerSameApp, number: 6, allowedLogins: ["example-user"], since, until: at(30) }).status, "pass");
  assert.equal(verifyAgentComment({ comments: fixerSameApp, number: 6, allowedLogins: ["example-user"], since, until: at(90) }).status, "fail");
  const nearOnly = verifyAgentComment({ comments: [comment("example-user", "factory: drive\nplease", 10)], number: 6, since });
  assert.equal(nearOnly.kind, "agent");
  assert.match(nearOnly.reason, /more than the sentinel/);
  assert.equal(verifyAgentComment({ comments: [], number: 6, since }).kind, "missing");
  const older = comment("example-user", "earlier note", -30, 400);
  assert.equal(verifyAgentComment({ comments: [older, sentinel], number: 6, allowedLogins: ["example-user"], since }).status, "pass");
});

test("cleanup closes open test PRs, moves the ticket, and deletes only fixer branches", () => {
  const protectedList = protectedRefs();
  const allPulls = [
    pull(20, "fix/tlssn-3-csv", "fix", { user: { login: "factory-pr-autofixer[bot]" } }),
    pull(21, DEFAULTS.redHead, "red", { user: { login: "factory-pr-autofixer[bot]" } }),
    pull(22, "main", "main", { user: { login: "factory-pr-autofixer[bot]" } }),
    pull(23, "feature/x", "human", { user: { login: "alice" } }),
    pull(24, "fix/fork", "fork", { user: { login: "factory-pr-autofixer[bot]" }, head: { ref: "fix/fork", repo: { full_name: "someone/marsbank" } } }),
  ];
  const prs = [{ number: 12, state: "open" }, { number: 13, state: "closed" }, undefined];
  const plan = cleanupPlan({ prs, issue: issue({ status: "In Progress" }), allPulls, repo: REPO, fixerLogins: DEFAULTS.fixerLogins, cleanupBranches: true, protectedList });
  assert.deepEqual(plan, { closePrs: [12], ticketToDone: true, deleteBranches: ["fix/tlssn-3-csv"] });
  assert.deepEqual(cleanupPlan({ prs, issue: issue({ status: "Done" }), allPulls, repo: REPO, fixerLogins: DEFAULTS.fixerLogins, cleanupBranches: false, protectedList }).deleteBranches, []);
  assert.equal(isSafeToDelete("main", protectedList), false);
  assert.equal(isSafeToDelete("factory-test/review", protectedList), false);
  assert.equal(isSafeToDelete("TLSSN-3-factory-red-check", protectedList), false);
  assert.equal(isSafeToDelete("", protectedList), false);
  assert.equal(isSafeToDelete("fix/tlssn-3-csv", protectedList), true);
});

// ---------------------------------------------------------------- payloads

test("transitionBody without the new fields is still the worker fixture literal", () => {
  const body = transitionBody({ issueKey: "TLSSN-42", toStatus: "Approved", fromStatus: "Planned", changelogId: "10042", timestamp: 1_790_000_000_000, summary: "Retry CSV export on empty filter" });
  assert.deepEqual(body, {
    timestamp: 1_790_000_000_000,
    webhookEvent: "jira:issue_updated",
    issue_event_type_name: "issue_generic",
    user: { accountId: "712020:5f1c2b7a-0d3e-4c1a-9e2f-3a4b5c6d7e8f", displayName: "Alice Example", active: true, accountType: "atlassian" },
    issue: { id: "10142", key: "TLSSN-42", fields: { summary: "Retry CSV export on empty filter", status: { id: "10002", name: "Approved" }, project: { id: "10000", key: "TLSSN" } } },
    changelog: { id: "10042", items: [{ field: "status", fieldtype: "jira", fieldId: "status", from: "10001", fromString: "Planned", to: "10002", toString: "Approved" }] },
  });
  const stale = transitionBody({ issueKey: "TLSSN-3", toStatus: "Triaged", fromStatus: "To Do", changelogId: "7", timestamp: 1, summary: "s", currentStatus: "Planned", issueId: "10003" });
  assert.equal(stale.issue.fields.status.name, "Planned");
  assert.equal(stale.changelog.items[0].toString, "Triaged");
  assert.equal(stale.issue.id, "10003");
});

test("createdBody is the issue_created shape triage parses", () => {
  const body = createdBody({ issueKey: "TLSSN-42", summary: "CSV export", description: "500 on empty filter", timestamp: 1, issueId: "10042" });
  assert.equal(body.webhookEvent, "jira:issue_created");
  assert.equal(body.issue.key, "TLSSN-42");
  assert.equal(body.issue.fields.summary, "CSV export");
  assert.equal(body.issue.fields.description, "500 on empty filter");
  assert.equal(body.issue.fields.project.key, "TLSSN");
  assert.equal(body.issue.self, "https://<JIRA_SITE>.atlassian.net/rest/api/2/issue/10042");
});

test("signing is sha256 HMAC hex over the raw body, and the replay script re-exports the builder", () => {
  const { rawBody, headers } = signedRequest({ a: 1 }, "x");
  assert.equal(rawBody, '{"a":1}');
  assert.equal(headers["x-hub-signature-256"], `sha256=${createHmac("sha256", "x").update(rawBody).digest("hex")}`);
  assert.equal(signature(rawBody, "x"), headers["x-hub-signature-256"]);
  assert.equal(replayScript.transitionBody, transitionBody);
  assert.equal(replayScript.signature, signature);
});

// ---------------------------------------------------------------- poll and output

function fakeClock() {
  let now = T0;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

test("poll returns the first verdict, times out, and retries failed reads", async () => {
  const clock = fakeClock();
  let calls = 0;
  const pass = await poll({ step: "x", clock, timeoutMs: 60_000, intervalMs: 10_000, fetch: async () => ++calls, evaluate: (n) => (n >= 3 ? result("x", "pass", "ok") : { wait: true, note: "not yet" }) });
  assert.equal(pass.status, "pass");
  assert.equal(calls, 3);
  const late = await poll({ step: "x", clock, timeoutMs: 30_000, intervalMs: 10_000, fetch: async () => 0, evaluate: (_, s) => (s.timedOut ? result("x", "fail", "late") : { wait: true, note: "w" }) });
  assert.equal(late.reason, "late");
  let flaky = 0;
  const recovered = await poll({ step: "x", clock, timeoutMs: 60_000, intervalMs: 10_000, fetch: async () => { if (++flaky < 2) throw new Error("ECONNRESET"); return 1; }, evaluate: () => result("x", "pass", "ok") });
  assert.equal(recovered.status, "pass");
  const broken = await poll({ step: "x", clock, timeoutMs: 20_000, intervalMs: 10_000, fetch: async () => { throw new Error("401"); }, evaluate: () => result("x", "pass", "ok") });
  assert.equal(broken.status, "fail");
  assert.match(broken.reason, /could not read state: 401/);
});

// ---------------------------------------------------------------- runDrive over fakes

const ROUTE_URLS = { triage: "https://routes.test/triage", planner: "https://routes.test/planner", worker: "https://routes.test/worker", desk: "https://routes.test/desk" };
const TEST_ROUTES = Object.fromEntries(Object.entries(ROUTE_URLS).map(([role, url]) => [role, { slug: `factory-${role}`, url, source: "test" }]));

/**
 * A Jira, GitHub, and factory stand-in. `agents: false` models a connector
 * that never writes; `silent` lists routes whose agent never writes.
 * REST moves are authored by DRIVER, agent writes by AGENT, as on the real
 * site. `triageMoves: false` makes triage comment without moving;
 * `concurrentDriverMove` then moves the ticket as the driver's account, the
 * way a second driver run did on TLSSN-7. `myself: false` hides the
 * driver's own account.
 */
function fakeWorld({ agents = true, routeStatus = 202, silent = [], triageMoves = true, concurrentDriverMove = false, myself = true } = {}) {
  const clock = fakeClock();
  const iso = () => new Date(clock.now()).toISOString();
  const tickets = new Map();
  const posts = [];
  let nextKey = 100;
  let nextHistory = 900;
  const statusIds = { "To Do": "11", Triaged: "41", Planned: "51", Approved: "61", "In Progress": "21", "In Review": "71", Done: "31" };
  const setStatus = (ticket, to, accountId = DRIVER) => {
    ticket.changelog.histories.push({ id: String(nextHistory++), created: iso(), author: { accountId, displayName: "the operator" }, items: [{ field: "status", fromString: ticket.fields.status.name, toString: to }] });
    ticket.fields.status.name = to;
  };
  const addComment = (ticket, body) => ticket.fields.comment.comments.push({ id: String(ticket.fields.comment.comments.length + 1), created: iso(), author: { accountId: AGENT, displayName: "the operator" }, body });
  const seedTicket = (key, { status, comments = [], histories = [] }) =>
    tickets.set(key, {
      id: "10007",
      key,
      fields: { summary: "Leftover e2e ticket", status: { name: status }, comment: { comments: comments.map((c, i) => ({ id: String(i + 1), author: { accountId: AGENT, displayName: "the operator" }, ...c })) } },
      changelog: { histories },
    });
  const hasTriage = (ticket) => ticket.fields.comment.comments.some((c) => typeof c.body === "string" && c.body.startsWith("Triage:"));
  const jira = {
    ...(myself ? { myself: async () => ({ accountId: DRIVER, emailAddress: "<OPERATOR_EMAIL>" }) } : {}),
    search: async () => [],
    create: async (fields) => {
      const key = `TLSSN-${nextKey++}`;
      tickets.set(key, { id: "10100", key, fields: { summary: fields.summary, status: { name: "To Do" }, comment: { comments: [] } }, changelog: { histories: [] } });
      return { key };
    },
    get: async (key) => {
      const ticket = tickets.get(key);
      if (concurrentDriverMove && hasTriage(ticket) && ticket.fields.status.name === "To Do") setStatus(ticket, "Triaged", DRIVER);
      return structuredClone(ticket);
    },
    transitions: async () => Object.entries(statusIds).map(([name, id]) => ({ id, name, to: { name } })),
    transition: async (key, id) => setStatus(tickets.get(key), Object.entries(statusIds).find(([, value]) => value === id)[0]),
  };
  const post = async (url, rawBody, headers) => {
    assert.equal(headers["x-hub-signature-256"], signature(rawBody, "s"));
    const body = JSON.parse(rawBody);
    posts.push({ url, body });
    if (routeStatus !== 202) return { status: routeStatus };
    const ticket = tickets.get(body.issue.key);
    const to = body.changelog?.items[0].toString;
    const live = (role) => agents && !silent.includes(role);
    if (live("triage") && url === ROUTE_URLS.triage && body.webhookEvent === "jira:issue_created" && !hasTriage(ticket)) {
      addComment(ticket, "Triage: bug\nSeverity: high");
      if (triageMoves) setStatus(ticket, "Triaged", AGENT);
    } else if (live("planner") && url === ROUTE_URLS.planner && to === "Triaged" && ticket.fields.status.name === "Triaged") {
      addComment(ticket, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Plan: ${ticket.key} Retry` }] }, { type: "paragraph", content: [{ type: "text", text: "Brief:" }] }, { type: "paragraph", content: [{ type: "text", text: "Do it." }] }] });
      setStatus(ticket, "Planned", AGENT);
    } else if (live("worker") && url === ROUTE_URLS.worker && to === "Approved" && ticket.fields.status.name === "Approved") {
      addComment(ticket, "Implementing: https://cursor.com/agents/bc-9");
      setStatus(ticket, "In Progress", AGENT);
    }
    return { status: 202 };
  };

  const pulls = [];
  const comments = new Map();
  let driveAt;
  const red = { sha: "a".repeat(40), html_url: "https://github.com/c/red", author: { login: "simon" }, commit: { committer: { date: new Date(T0 - 60_000).toISOString() } } };
  const fix = { sha: "b".repeat(40), html_url: "https://github.com/c/fix", author: { login: "cursor[bot]" }, commit: { committer: { date: new Date(T0 + 120_000).toISOString() } } };
  const reviewCommit = { sha: "e".repeat(40), html_url: "https://github.com/c/review", author: { login: "simon" }, commit: { committer: { date: new Date(T0 - 60_000).toISOString() } } };
  const redCommits = () => (clock.now() >= T0 + 120_000 ? [red, fix] : [red]);
  const pushers = {};
  const openPull = ({ title, head, base = "main", login = "simon" }) => {
    const created = { number: 10 + pulls.length, state: "open", title, html_url: `https://github.com/${REPO}/pull/${10 + pulls.length}`, head: { ref: head, repo: { full_name: REPO } }, base: { ref: base }, user: { login }, created_at: iso() };
    pulls.push(created);
    comments.set(created.number, []);
    return created;
  };
  const postComment = (number, body, login = "simon") => {
    driveAt = clock.now();
    const created = { id: 1, user: { login }, body, created_at: iso(), html_url: "https://github.com/c/sentinel" };
    comments.get(number).push(created);
    return created;
  };
  const github = {
    user: async () => ({ login: "simon" }),
    pulls: async (head) => pulls.filter((p) => p.head.ref === head),
    allPulls: async () => pulls,
    createPull: async (input) => openPull(input),
    branchSha: async (head) => (head === DEFAULTS.redHead ? redCommits().at(-1).sha : reviewCommit.sha),
    aheadBy: async (_base, head) => (head === DEFAULTS.redHead ? redCommits().length : 1),
    updatePull: async (number, patch) => Object.assign(pulls.find((p) => p.number === number), patch),
    reviews: async (number) => (pulls.find((p) => p.number === number).head.ref === DEFAULTS.reviewHead ? [{ id: 3301, body: "## Security review\n\n**Verdict:** CLEAN", state: "COMMENTED", user: { login: "cursor[bot]", type: "Bot" }, commit_id: reviewCommit.sha, submitted_at: iso(), html_url: "https://github.com/r/review" }] : []),
    issueComments: async (number) => {
      const list = [...comments.get(number)];
      if (driveAt !== undefined && clock.now() > driveAt + 5000) list.push({ id: 2, user: { login: "cursor[bot]" }, body: "Driving: https://cursor.com/agents/bc-7", created_at: new Date(driveAt + 5000).toISOString(), html_url: "https://github.com/c/drive" });
      return list;
    },
    commits: async (number) => (pulls.find((p) => p.number === number).head.ref === DEFAULTS.redHead ? redCommits() : [reviewCommit]),
    pull: async (number) => {
      const found = pulls.find((p) => p.number === number);
      return { ...found, head: { ...found.head, sha: (await github.commits(number)).at(-1)?.sha } };
    },
    reopens: async () => [],
    runs: async (sha) => {
      const pushed = [red, fix, reviewCommit].find((c) => c.sha === sha);
      return [{ id: sha === red.sha ? 7001 : 7002, status: "completed", conclusion: sha === red.sha ? "failure" : "success", event: "pull_request", actor: { login: pushers[sha] ?? pushed.author.login }, created_at: pushed.commit.committer.date }];
    },
    comment: async (number, body) => postComment(number, body),
    deleteBranch: async () => {},
  };
  const identity = async (sha) => {
    for (const pull of pulls.filter((p) => p.state === "open")) {
      if (!(await github.commits(pull.number)).some((c) => c.sha === sha)) continue;
      const repo = { url: `https://api.github.com/repos/${REPO}`, name: REPO.split("/")[1] };
      return { head_sha: sha, head_branch: pull.head.ref, head_repository: { full_name: REPO }, pull_requests: [{ number: pull.number, head: { ref: pull.head.ref, sha, repo }, base: { ref: pull.base.ref, sha: "0".repeat(40), repo } }] };
    }
    return {};
  };
  let runsImpl = github.runs;
  Object.defineProperty(github, "runs", {
    enumerable: true,
    get: () => {
      const impl = runsImpl;
      return async (sha) => {
        const id = await identity(sha);
        return (await impl(sha)).map((run) => ({ ...id, ...run }));
      };
    },
    set: (impl) => {
      runsImpl = impl;
    },
  });
  return { clock, jira, github, post, posts, tickets, seedTicket, pulls, openPull, postComment, pushers, shas: { red: red.sha, fix: fix.sha, review: reviewCommit.sha } };
}

/**
 * Cloud agents that do what the prompt says after one `running` poll: PRs as
 * the key owner, comments as the Cursor app, as the real run showed.
 * `misbehave(prompt, world)` replaces the action.
 */
function fakeAgents(world, { login = "example-user", commentLogin = "cursor[bot]", misbehave } = {}) {
  const launches = [];
  const agents = {
    launch: async ({ name, idempotencyKey, prompt }) => {
      const id = `bc-${launches.length + 1}`;
      launches.push({ id, name, idempotencyKey, prompt, polls: 0 });
      return { agentId: id, runId: `run-${id}`, url: `https://cursor.com/agents/${id}` };
    },
    status: async ({ agentId }) => {
      const launch = launches.find((entry) => entry.id === agentId);
      if (launch.polls++ === 0) return "running";
      if (launch.polls === 2) {
        if (misbehave !== undefined) misbehave(launch.prompt, world);
        else if (launch.prompt.includes("open one pull request")) {
          const head = /- head branch: (\S+)/.exec(launch.prompt)[1];
          const title = /- title, exactly: (.+)/.exec(launch.prompt)[1];
          world.openPull({ title, head, login });
        } else {
          world.postComment(Number(/pull request #(\d+)/.exec(launch.prompt)[1]), "factory: drive", commentLogin);
        }
      }
      return "finished";
    },
  };
  return { agents, launches };
}

const AGENT_CREDS = { ...resolveCredentials({ FACTORY_E2E_FIXER_LOGINS: FIXER }), github: { ok: true, name: "gh auth token", readOnly: true }, cursor: { ok: true, name: "agent-sdk login" } };
const readOnlyGithub = readOnly;

test("runDrive in cloud-agent mode opens both PRs and the opt-in through agents, verified from GitHub", async () => {
  const world = fakeWorld();
  const { agents, launches } = fakeAgents(world);
  const options = { ...parseCli(["--only", "prs,review,red-check,drive", "--github-timeout", "600", "--quiet", "60", "--poll", "10"]), github: "cloud-agent" };
  const client = { ...world.clock, post: world.post, github: readOnlyGithub(world.github), agents };
  const results = await runDrive({ client, options, creds: AGENT_CREDS, routes: TEST_ROUTES });
  const byStep = Object.fromEntries(results.map((r) => [r.step, r]));
  assert.deepEqual(
    ["prs", "review", "red-check", "drive"].map((step) => byStep[step].status),
    ["pass", "pass", "pass", "pass"],
    byStep.drive.reason
  );
  assert.deepEqual(launches.map((l) => l.idempotencyKey), ["factory-e2e/prs/factory-test/review", "factory-e2e/prs/TLSSN-3-factory-red-check", "factory-e2e/drive/factory-test/review"]);
  assert.match(byStep.prs.reason, /factory-test\/review: #\d+ by example-user/);
  assert.match(byStep.prs.reason, /https:\/\/cursor\.com\/agents\/bc-1, agent run finished/);
  assert.match(byStep.drive.reason, /^factory: drive by cursor\[bot\], body exact .*; one drive start/);
  assert.equal(world.pulls.length, 2);

  const again = await runDrive({ client, options, creds: AGENT_CREDS, routes: TEST_ROUTES });
  assert.equal(launches.length, 3);
  assert.match(again.find((r) => r.step === "prs").reason, /existing, no agent launched/);
  assert.match(again.find((r) => r.step === "drive").reason, /existing, no agent launched/);
});

test("runDrive in cloud-agent mode fails a step when GitHub disagrees with the prompt", async () => {
  const world = fakeWorld();
  const { agents } = fakeAgents(world, {
    misbehave: (prompt, w) => {
      const head = /- head branch: (\S+)/.exec(prompt)[1];
      w.openPull({ title: "Some other title", head, base: "develop" });
    },
  });
  const options = { ...parseCli(["--only", "prs", "--poll", "10"]), github: "cloud-agent" };
  const results = await runDrive({ client: { ...world.clock, post: world.post, github: readOnlyGithub(world.github), agents }, options, creds: AGENT_CREDS, routes: TEST_ROUTES });
  const prs = results.find((r) => r.step === "prs");
  assert.equal(prs.status, "fail");
  assert.equal(prs.kind, "agent");
  assert.match(prs.reason, /base is develop, expected main/);
  assert.match(prs.reason, /title is "Some other title"/);
  const mallory = fakeWorld();
  const strangers = fakeAgents(mallory, { commentLogin: "mallory" });
  const drive = await runDrive({ client: { ...mallory.clock, post: mallory.post, github: readOnlyGithub(mallory.github), agents: strangers.agents }, options: { ...parseCli(["--only", "prs,drive", "--poll", "10"]), github: "cloud-agent" }, creds: AGENT_CREDS, routes: TEST_ROUTES });
  assert.match(drive.find((r) => r.step === "drive").reason, /author mallory is not one of cursor\[bot\], simon, example-user/);
  const empty = fakeWorld();
  const blocked = await runDrive({ client: { ...empty.clock, post: empty.post, github: readOnlyGithub(empty.github) }, options, creds: { ...AGENT_CREDS, cursor: { ok: false, reason: "no Cursor user key" } }, routes: TEST_ROUTES });
  const noPrs = blocked.find((r) => r.step === "prs");
  assert.equal(noPrs.status, "blocked");
  assert.match(noPrs.reason, /factory-test\/review: no open PR, and opening one needs a cloud agent \(no Cursor user key\)/);
});

test("runDrive in cloud-agent mode with no launcher still reads existing PRs, the review, and the red check", async () => {
  const world = fakeWorld();
  world.openPull({ title: DEFAULTS.reviewTitle, head: DEFAULTS.reviewHead });
  world.openPull({ title: DEFAULTS.redTitle, head: DEFAULTS.redHead });
  const options = { ...parseCli(["--only", "prs,review,red-check,drive", "--github-timeout", "600", "--poll", "10"]), github: "cloud-agent" };
  const creds = { ...AGENT_CREDS, cursor: { ok: false, reason: "no Cursor user key" } };
  const results = await runDrive({ client: { ...world.clock, post: world.post, github: readOnlyGithub(world.github) }, options, creds, routes: TEST_ROUTES });
  const byStep = Object.fromEntries(results.map((r) => [r.step, r]));
  assert.deepEqual(
    ["prs", "review", "red-check", "drive"].map((step) => byStep[step].status),
    [PRIOR_PASS, "pass", "pass", "blocked"],
    JSON.stringify(byStep)
  );
  assert.match(byStep.prs.reason, /existing, no agent launched/);
  assert.match(byStep.review.reason, /Security review/);
  assert.match(byStep["red-check"].reason, /^red on aaaaaaa, 1 fixer push\(es\), green on bbbbbbb pushed by the fixer account cursor\[bot\] \(actor of workflow run 7002\)$/);
  assert.match(byStep.drive.reason, /posting one needs a cloud agent \(no Cursor user key\)/);
  assert.equal(world.pulls.length, 2);
  assert.equal(summarizeResults(results).exitCode, 0);
});

const CREDS = resolveCredentials({ JIRA_API_KEY: "k", JIRA_WEBHOOK_SECRET: "s", FACTORY_E2E_GITHUB_TOKEN: "t", FACTORY_E2E_FIXER_LOGINS: FIXER });

test("runDrive replays every hop on a new ticket and passes end to end", async () => {
  const world = fakeWorld();
  const options = parseCli(["--cleanup", "--timeout", "120", "--github-timeout", "600", "--quiet", "60", "--poll", "10"]);
  const results = await runDrive({ client: { ...world.clock, post: world.post, jira: world.jira, github: world.github }, options, creds: CREDS, routes: TEST_ROUTES });
  const status = Object.fromEntries(results.map((r) => [r.step, r.status]));
  assert.deepEqual(status, { ticket: "pass", triage: "pass", plan: "pass", announce: "unverified", approve: "pass", progress: "unverified", prs: "pass", review: "pass", "red-check": "pass", drive: "pass", cleanup: "pass" });
  assert.deepEqual(world.posts.map((p) => [p.url, p.body.webhookEvent, p.body.changelog?.items[0].toString]), [
    [ROUTE_URLS.triage, "jira:issue_created", undefined],
    [ROUTE_URLS.planner, "jira:issue_updated", "Triaged"],
    [ROUTE_URLS.desk, "jira:issue_updated", "Planned"],
    [ROUTE_URLS.worker, "jira:issue_updated", "Approved"],
    [ROUTE_URLS.desk, "jira:issue_updated", "In Progress"],
  ]);
  const ticket = world.tickets.get("TLSSN-100");
  const intoApproved = ticket.changelog.histories.find((h) => h.items[0].toString === "Approved");
  assert.equal(world.posts[3].body.changelog.id, intoApproved.id);
  assert.equal(ticket.fields.status.name, "Done");
  assert.equal(summarizeResults(results).exitCode, 0);

  const again = await runDrive({ client: { ...world.clock, post: world.post, jira: world.jira, github: world.github }, options: parseCli(["--ticket", "TLSSN-100", "--only", "triage,plan,prs", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  assert.match(again.find((r) => r.step === "triage").reason, /already done before this run, nothing sent/);
  assert.equal(world.posts.length, 5);
});

test("runDrive with a silent connector and no GitHub token fails the Jira hops and blocks only the GitHub steps", async () => {
  const world = fakeWorld({ agents: false });
  const creds = resolveCredentials({ JIRA_API_KEY: "k", JIRA_WEBHOOK_SECRET: "s" });
  const options = parseCli(["--timeout", "30", "--poll", "10"]);
  const results = await runDrive({ client: { ...world.clock, post: world.post, jira: world.jira }, options, creds, routes: TEST_ROUTES });
  const byStep = Object.fromEntries(results.map((r) => [r.step, r]));
  assert.equal(byStep.ticket.status, "pass");
  assert.equal(byStep.triage.status, "fail");
  assert.equal(byStep.plan.status, "fail");
  assert.match(byStep.announce.reason, /not Planned/);
  assert.match(byStep.approve.reason, /not Planned/);
  assert.match(byStep.progress.reason, /not In Progress/);
  for (const step of ["prs", "review", "red-check", "drive"]) assert.equal(byStep[step].reason, "set FACTORY_E2E_GITHUB_TOKEN");
  assert.equal(summarizeResults(results).exitCode, 1);
});

// ---------------------------------------------------------------- reporting accuracy (TLSSN-5..8)

const JIRA_ONLY = ["--only", "ticket,triage,plan,announce,approve,progress", "--timeout", "60", "--poll", "10"];
const jiraRun = (world, argv = JIRA_ONLY) => runDrive({ client: { ...world.clock, post: world.post, jira: world.jira }, options: parseCli(argv), creds: CREDS, routes: TEST_ROUTES });
const API_REPO = `https://api.github.com/repos/${REPO}`;
const githubRows = async (world, only, { client = {}, options = {}, creds = CREDS } = {}) =>
  Object.fromEntries(
    (await runDrive({ client: { ...world.clock, post: world.post, github: world.github, ...client }, options: { ...parseCli(["--only", only, "--github-timeout", "600", "--quiet", "60", "--poll", "10"]), ...options }, creds, routes: TEST_ROUTES })).map((r) => [r.step, r])
  );

test("D1 ticket summaries differ per run and leave room for the worker's 100-character agent name", () => {
  const first = newTicketFields({ stamp: "2026-09-23T11:05:24.230Z" }).summary;
  const second = newTicketFields({ stamp: "2026-09-23T11:17:02.004Z" }).summary;
  assert.equal(first, "Factory e2e 0923-110524: CSV export 500 on empty filter");
  assert.equal(second, "Factory e2e 0923-111702: CSV export 500 on empty filter");
  assert.equal(`factory TLSSN-99999: ${first}`.length <= 100, true);
});

test("D2 a silent run reports the Atlassian connector as unknown, never as not authorised", async () => {
  const silent = (await jiraRun(fakeWorld({ agents: false }), ["--only", "ticket,triage", "--timeout", "30", "--poll", "10"])).find((r) => r.step === "triage");
  assert.equal(silent.status, "fail");
  assert.equal(silent.reason, "no Triage: comment within 30s (ticket in To Do); Atlassian connector: unknown (not observable from the driver; no agent-account comment this run)");

  const planner = (await jiraRun(fakeWorld({ silent: ["planner"] }), ["--only", "ticket,triage,plan", "--timeout", "30", "--poll", "10"])).find((r) => r.step === "plan");
  assert.equal(planner.status, "fail");
  assert.equal(planner.reason, `no Plan: comment within 30s (ticket in Triaged); Atlassian connector: authorised (a non-driver account (${AGENT}) wrote comment 1 this run)`);
});

test("D3 a status move by the driver's own Jira account is never an agent pass", async () => {
  const raw = (authorId) => ({
    key: "TLSSN-7",
    fields: { status: { name: "Triaged" }, comment: { comments: [{ id: "15199", created: at(35), author: { accountId: AGENT, displayName: "the operator" }, body: "Triage: bug\nSeverity: medium" }] } },
    changelog: { histories: [{ id: "32140", created: at(134), author: { accountId: authorId, displayName: "the operator" }, items: [{ field: "status", fromString: "To Do", toString: "Triaged" }] }] },
  });
  const byDriver = evaluateHop("triage", issueFacts(raw(DRIVER)), { timedOut: true, timeoutSec: 180, identity: WHO });
  assert.equal(byDriver.status, "fail");
  assert.equal(byDriver.reason, "Triage: comment landed, but the move into Triaged (changelog 32140) was made by the driver's own Jira account, not the agent");
  assert.equal(evaluateHop("triage", issueFacts(raw(AGENT)), { timedOut: false, identity: WHO }).status, "pass");
  const laterAgentMove = raw(DRIVER);
  laterAgentMove.fields.status.name = "In Progress";
  laterAgentMove.changelog.histories.push({ id: "32167", created: at(400), author: { accountId: AGENT, displayName: "the operator" }, items: [{ field: "status", fromString: "Approved", toString: "In Progress" }] });
  const notTriages = evaluateHop("triage", issueFacts(laterAgentMove), { timedOut: true, timeoutSec: 180, identity: WHO });
  assert.equal(notTriages.status, "fail");
  assert.match(notTriages.reason, /changelog 32140\) was made by the driver's own Jira account/);

  const concurrent = (await jiraRun(fakeWorld({ triageMoves: false, concurrentDriverMove: true }), ["--only", "ticket,triage", "--timeout", "30", "--poll", "10"])).find((r) => r.step === "triage");
  assert.equal(concurrent.status, "fail");
  assert.match(concurrent.reason, /^Triage: comment landed, but the move into Triaged \(changelog 900\) was made by the driver's own Jira account, not the agent/);

  const standInWorld = fakeWorld({ silent: ["planner"] });
  standInWorld.seedTicket("TLSSN-50", { status: "To Do" });
  const standIn = await jiraRun(standInWorld, ["--ticket", "TLSSN-50", "--only", "plan", "--timeout", "30", "--poll", "10"]);
  const plan = standIn.find((r) => r.step === "plan");
  assert.equal(plan.status, "fail");
  assert.deepEqual(plan.evidence.filter((e) => e.kind === "transition").map((e) => [e.from, e.to, e.by, e.authorId]), [["To Do", "Triaged", "driver", DRIVER]]);
});

test("D4 the driver replays In Progress to the desk and reports its Slack post as unverified", async () => {
  assert.equal(parseCli(JIRA_ONLY).error, undefined);
  const world = fakeWorld();
  const results = await jiraRun(world);
  const progress = results.find((r) => r.step === "progress");
  assert.equal(progress.status, "unverified");
  assert.equal(progress.reason, "factory-desk accepted the In Progress transition (HTTP 202); the implementation post to Slack is unverified without Slack access");
  const desk = world.posts.filter((p) => p.url === ROUTE_URLS.desk).map((p) => [p.body.changelog.items[0].toString, p.body.changelog.id]);
  const intoProgress = world.tickets.get("TLSSN-100").changelog.histories.find((h) => h.items[0].toString === "In Progress");
  assert.deepEqual(desk, [["Planned", "901"], ["In Progress", intoProgress.id]]);
  assert.deepEqual(progress.evidence.map((e) => [e.kind, e.id ?? e.changelogId ?? e.slug, e.by ?? e.status]), [["transition", "903", "non-driver"], ["replay", "903", "non-driver"], ["post", "factory-desk", 202]]);
  assert.equal(results.find((r) => r.step === "announce").status, "unverified");
});

test("D5 every Jira hop carries reproducible evidence, and a hop whose authors cannot be told apart is unverified", async () => {
  const results = await jiraRun(fakeWorld(), ["--only", "ticket,triage,plan,announce,approve", "--timeout", "60", "--poll", "10"]);
  const byStep = Object.fromEntries(results.map((r) => [r.step, r]));
  const kinds = (step) => (byStep[step].evidence ?? []).map((e) => [e.kind, e.id ?? e.slug ?? e.changelogId, e.status ?? e.by]);
  assert.deepEqual(kinds("triage"), [["post", "factory-triage", 202], ["comment", "1", "non-driver"], ["transition", "900", "non-driver"]]);
  assert.deepEqual(kinds("plan"), [["replay", "900", "non-driver"], ["post", "factory-planner", 202], ["comment", "2", "non-driver"], ["transition", "901", "non-driver"]]);
  assert.deepEqual(kinds("approve"), [["transition", "902", "driver"], ["replay", "902", "driver"], ["post", "factory-worker", 202], ["comment", "3", "non-driver"], ["transition", "903", "non-driver"]]);
  const table = renderTable(results);
  assert.match(table, /evidence: comment 1 by the operator \[non-driver 712020:95b89517-agent\] at 2026-09-23T04:00:\d\d\.\d{3}Z: "Triage: bug \/ Severity: high"/);
  assert.match(table, /evidence: changelog 902 Planned -> Approved by the operator \[driver 712020:726a07dd-driver\]/);
  assert.match(table, /evidence: POST factory-desk HTTP 202 at 2026-09-23T04:0/);
  assert.equal(formatEvidence(issueEvidence(issueFacts({ key: "TLSSN-10", id: "19897", fields: { created: "2026-09-23T09:21:14.108-0400", summary: "Factory e2e 0923-132111: CSV export 500 on empty filter" } }))), 'issue TLSSN-10 id 19897 created 2026-09-23T13:21:14.108Z, summary "Factory e2e 0923-132111: CSV export 500 on empty filter"');

  const noAuthor = evaluateHop("triage", issue({ status: "Triaged", comments: [{ ...TRIAGE, authorId: "" }], transitions: [INTO(1, "To Do", "Triaged", 11)] }), { timedOut: false, identity: WHO });
  assert.equal(noAuthor.status, "unverified");
  assert.match(noAuthor.reason, /comment 100 is by an account the driver cannot tell apart from its own$/);
});

// ---------------------------------------------------------------- reporting accuracy, round 2 (validator findings on df83950)

const URL_15209 = "https://cursor.com/agents/bc-example-1";
const oneComment = (body, status = "In Progress") => ({
  key: "TLSSN-10",
  fields: { status: { name: status }, comment: { comments: [{ id: "15209", created: at(40), author: { accountId: AGENT, displayName: "the operator" }, body }] } },
  changelog: { histories: [{ id: "32167", created: at(51), author: { accountId: AGENT, displayName: "the operator" }, items: [{ field: "status", fromString: "Approved", toString: "In Progress" }] }] },
});

test("R5 an Implementing: URL is read from a smart link, a sibling block or embed card, card data, and a link-marked URL (TLSSN-10 comment 15209)", () => {
  const shapes = [
    { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Implementing: " }, { type: "inlineCard", attrs: { url: URL_15209 } }] }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Implementing:" }] }, { type: "blockCard", attrs: { url: URL_15209 } }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Implementing:" }] }, { type: "embedCard", attrs: { url: URL_15209 } }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Implementing: " }, { type: "inlineCard", attrs: { data: { url: URL_15209 } } }] }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Implementing: " }, { type: "text", text: URL_15209, marks: [{ type: "link", attrs: { href: URL_15209 } }] }] }] },
  ];
  assert.equal(issueFacts(oneComment(shapes[0])).comments[0].text, `Implementing: ${URL_15209}`);
  for (const body of shapes) {
    const facts = issueFacts(oneComment(body));
    assert.equal(implementingUrl(facts.comments[0].text), URL_15209, JSON.stringify(body));
    assert.equal(evaluateHop("approve", facts, { timedOut: false, identity: WHO }).status, "pass");
  }
});

// ---------------------------------------------------------------- reporting accuracy, round 3 (adversarial review of 4976f2b)

const PLAN_LINKED = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Plan: " }, { type: "text", text: "TLSSN-10", marks: [{ type: "link", attrs: { href: "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-10" } }] }, { type: "text", text: " Retry CSV export" }] },
    { type: "paragraph", content: [{ type: "text", text: "Brief:", marks: [{ type: "link", attrs: { href: "https://<JIRA_SITE>.atlassian.net/wiki/brief" } }] }] },
    { type: "paragraph", content: [{ type: "text", text: "Do it." }] },
  ],
};
const agentHistory = (id, from, to, seconds, accountId = AGENT) => ({ id: String(id), created: at(seconds), author: { accountId, displayName: "the operator" }, items: [{ field: "status", fromString: from, toString: to }] });

test("V1 a link-marked issue key or Brief: heading keeps its text, so the planner's Plan: comment still counts", async () => {
  const facts = issueFacts({ key: "TLSSN-10", fields: { status: { name: "Planned" }, comment: { comments: [{ id: "15208", created: at(20), author: { accountId: AGENT, displayName: "the operator" }, body: PLAN_LINKED }] } }, changelog: { histories: [agentHistory(32165, "Triaged", "Planned", 25)] } });
  assert.equal(facts.comments[0].text, "Plan: TLSSN-10 Retry CSV export\nBrief:\nDo it.");
  assert.equal(isPlanComment(facts.comments[0].text, "TLSSN-10"), true);
  assert.equal(hasBrief(facts.comments[0].text), true);
  assert.equal(evaluateHop("plan", facts, { timedOut: false, identity: WHO }).status, "pass");
  assert.equal(adfText({ type: "text", text: "the cloud agent", marks: [{ type: "link", attrs: { href: URL_15209 } }] }), "the cloud agent");

  const world = fakeWorld();
  world.seedTicket("TLSSN-10", { status: "Planned", comments: [{ body: PLAN_LINKED, created: at(-600) }], histories: [agentHistory(32165, "Triaged", "Planned", -590)] });
  const plan = (await jiraRun(world, ["--ticket", "TLSSN-10", "--only", "plan", "--timeout", "30", "--poll", "10"])).find((r) => r.step === "plan");
  assert.equal(plan.status, "pass (prior run)", plan.reason);
});

test("V2 an unpinned pass names a non-driver account; a pinned run credits only the pinned account, another non-driver account's writes are unverified, and the routes are still sent", async () => {
  const facts = issueFacts(oneComment({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Implementing: ${URL_15209}` }] }] }));
  assert.equal(evaluateHop("approve", facts, { timedOut: false, identity: WHO }).reason, `Implementing: comment and move into In Progress by a non-driver account (${AGENT}); ticket in In Progress`);
  assert.equal(evaluateHop("approve", facts, { timedOut: false, identity: { driverId: DRIVER, agentIds: [AGENT] } }).reason, "Implementing: comment and move into In Progress by the agent account; ticket in In Progress");
  assert.equal(resolveCredentials({ FACTORY_E2E_AGENT_JIRA_ACCOUNTS: `${AGENT}, 712020:other` }).agentJiraAccounts.join("|"), `${AGENT}|712020:other`);

  const OTHER = "712020:someone-else";
  const byOther = issue({ status: "Triaged", comments: [{ ...TRIAGE, authorId: OTHER }], transitions: [INTO(1, "To Do", "Triaged", 11, OTHER)] });
  const refused = evaluateHop("triage", byOther, { timedOut: false, identity: { driverId: DRIVER, agentIds: [AGENT] } });
  assert.equal(refused.status, "unverified");
  assert.match(refused.reason, /comment 100 is by account 712020:someone-else, not one of FACTORY_E2E_AGENT_JIRA_ACCOUNTS/);

  const pinnedRun = async (pin) => {
    const world = fakeWorld();
    const creds = resolveCredentials({ JIRA_API_KEY: "k", JIRA_WEBHOOK_SECRET: "s", FACTORY_E2E_AGENT_JIRA_ACCOUNTS: pin });
    const results = await runDrive({ client: { ...world.clock, post: world.post, jira: world.jira }, options: parseCli(["--only", "ticket,triage,plan,approve", "--timeout", "30", "--poll", "10"]), creds, routes: TEST_ROUTES });
    return { world, byStep: Object.fromEntries(results.map((r) => [r.step, r])) };
  };
  const mismatch = await pinnedRun(OTHER);
  assert.deepEqual(["triage", "plan", "approve"].map((step) => mismatch.byStep[step].status), ["unverified", "unverified", "unverified"]);
  assert.match(mismatch.byStep.triage.reason, new RegExp(`is by account ${AGENT}, not one of FACTORY_E2E_AGENT_JIRA_ACCOUNTS`));
  assert.deepEqual(mismatch.world.posts.map((p) => p.url), [ROUTE_URLS.triage, ROUTE_URLS.planner, ROUTE_URLS.worker]);

  const matched = await pinnedRun(AGENT);
  assert.deepEqual(["triage", "plan", "approve"].map((step) => matched.byStep[step].status), ["pass", "pass", "pass"]);
  assert.match(matched.byStep.approve.reason, /^Implementing: comment and move into In Progress by the agent account/);
});

test("V3 the summary counts what the run sent: a hop done before this run is 'pass (prior run)', counted apart, and re-reads of a reused ticket are never 'from this run'", async () => {
  const fresh = fakeWorld();
  assert.equal(renderSummary(await jiraRun(fresh, ["--only", "ticket,triage", "--timeout", "30", "--poll", "10"])), "e2e: 2 pass, 0 pass (prior run), 0 fail, 0 blocked, 0 unverified, 9 skipped");

  await fresh.clock.sleep(60_000);
  const mixed = await jiraRun(fresh, ["--ticket", "TLSSN-100", "--only", "ticket,triage,plan", "--timeout", "30", "--poll", "10"]);
  assert.deepEqual(mixed.filter((r) => ["ticket", "triage", "plan"].includes(r.step)).map((r) => r.status), ["pass", "pass (prior run)", "pass"]);
  assert.equal(
    renderSummary(mixed).split("\n")[1],
    "note: 2 pass row(s) re-read Jira or GitHub state from before this run and sent or wrote nothing (ticket, triage); 1 pass row(s) came from this run's sends or writes; 1 route POST(s) this run"
  );

  const done = fakeWorld();
  await jiraRun(done, ["--only", "ticket,triage,plan", "--timeout", "60", "--poll", "10"]);
  await done.clock.sleep(60_000);
  const again = await jiraRun(done, ["--ticket", "TLSSN-100", "--only", "ticket,triage,plan", "--timeout", "60", "--poll", "10"]);
  assert.deepEqual(again.filter((r) => ["ticket", "triage", "plan"].includes(r.step)).map((r) => r.status), ["pass", "pass (prior run)", "pass (prior run)"]);
  assert.equal(summarizeResults(again).counts["pass (prior run)"], 2);
  assert.equal(done.posts.length, 2);
  assert.equal(
    renderSummary(again),
    "e2e: 1 pass, 2 pass (prior run), 0 fail, 0 blocked, 0 unverified, 8 skipped\nnote: 3 pass row(s) re-read Jira or GitHub state from before this run and sent or wrote nothing (ticket, triage, plan); 0 pass row(s) came from this run's sends or writes; 0 route POST(s) this run"
  );
  assert.equal(summarizeResults(again).exitCode, 0);

  const reset = fakeWorld();
  reset.seedTicket("TLSSN-9", { status: "Triaged" });
  const rows = await jiraRun(reset, ["--ticket", "TLSSN-9", "--reset", "--only", "ticket", "--timeout", "30", "--poll", "10"]);
  assert.equal(rows.find((r) => r.step === "ticket").reread, undefined);
  assert.equal(renderSummary(rows), "e2e: 1 pass, 0 pass (prior run), 0 fail, 0 blocked, 0 unverified, 10 skipped");
});

test("V4 a hop is 'done before this run' only from the baseline snapshot, and the evidence guard holds for tickets and prior-run rows", () => {
  const drivenDuringRun = issue({ status: "To Do", comments: [TRIAGE], transitions: [INTO(1, "To Do", "Triaged", 11), INTO(2, "Triaged", "To Do", 12, DRIVER)] });
  const belowTarget = captureBaseline(drivenDuringRun, at(100));
  const movedDuringRun = { ...drivenDuringRun, status: "Triaged", transitions: [...drivenDuringRun.transitions, INTO(3, "To Do", "Triaged", 130)] };
  assert.equal(priorRun("triage", movedDuringRun, belowTarget, WHO), undefined);

  const movedOnly = issue({ status: "Triaged", transitions: [INTO(1, "To Do", "Triaged", 11)] });
  const noComment = captureBaseline(movedOnly, at(100));
  const commentedDuringRun = { ...movedOnly, comments: issue({ comments: [{ ...TRIAGE, created: at(120) }] }).comments };
  assert.equal(priorRun("triage", commentedDuringRun, noComment, WHO), undefined);

  const lateComment = issue({ status: "Triaged", comments: [{ ...TRIAGE, created: at(105) }], transitions: [INTO(1, "To Do", "Triaged", 11)] });
  assert.equal(priorRun("triage", lateComment, captureBaseline(lateComment, at(100)), WHO), undefined);
  const lateMove = issue({ status: "Triaged", comments: [TRIAGE], transitions: [INTO(1, "To Do", "Triaged", 105)] });
  assert.equal(priorRun("triage", lateMove, captureBaseline(lateMove, at(100)), WHO), undefined);
  const earlier = issue({ status: "Triaged", comments: [TRIAGE], transitions: [INTO(1, "To Do", "Triaged", 11)] });
  assert.equal(priorRun("triage", earlier, captureBaseline(earlier, at(100)), WHO)?.status, "pass");
  const unseenComment = captureBaseline({ ...earlier, comments: [] }, at(100));
  assert.equal(priorRun("triage", earlier, unseenComment, WHO), undefined);
  const unseenMove = captureBaseline({ ...earlier, transitions: [] }, at(100));
  assert.equal(priorRun("triage", earlier, unseenMove, WHO), undefined);

  const checked = requireEvidence([
    result("ticket", "pass", "t", { evidence: [] }),
    result("ticket", "pass", "t", { evidence: [issueEvidence(issueFacts({ key: "TLSSN-1", id: "1", fields: {} }))] }),
    result("triage", "pass (prior run)", "p", { evidence: [] }),
  ]);
  assert.deepEqual(checked.map((r) => r.status), ["unverified", "pass", "unverified"]);
  assert.equal(checked[0].reason, "t (no issue evidence, so not a pass)");
});

test("V5 GET /myself is retried at the poll interval; when it keeps failing every Jira step is blocked, even when the agent pin names the driver's own account", async () => {
  const world = fakeWorld();
  const calls = [];
  const real = world.jira.myself;
  world.jira.myself = async () => {
    calls.push(world.clock.now());
    if (calls.length < 3) throw new Error("socket hang up");
    return real();
  };
  const results = await jiraRun(world, ["--only", "ticket,triage", "--timeout", "30", "--poll", "10"]);
  assert.deepEqual(calls.map((t) => t - T0), [0, 10_000, 20_000]);
  assert.deepEqual(results.filter((r) => ["ticket", "triage"].includes(r.step)).map((r) => r.status), ["pass", "pass"]);

  const count = async (fails) => {
    const counted = fakeWorld();
    let n = 0;
    const ok = counted.jira.myself;
    counted.jira.myself = async () => {
      n += 1;
      if (fails) throw new Error("socket hang up");
      return ok();
    };
    await jiraRun(counted, ["--only", "ticket", "--timeout", "30", "--poll", "10"]);
    return n;
  };
  assert.deepEqual([await count(true), await count(false)], [3, 1]);

  const selfWrites = oneComment({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Implementing: ${URL_15209}` }] }] });
  selfWrites.fields.comment.comments[0].author.accountId = DRIVER;
  selfWrites.changelog.histories[0].author.accountId = DRIVER;
  assert.equal(evaluateHop("approve", issueFacts(selfWrites), { timedOut: false, identity: { driverId: undefined, agentIds: [DRIVER] } }).status, "unverified");

  const down = fakeWorld({ myself: false });
  const creds = resolveCredentials({ JIRA_API_KEY: "k", JIRA_WEBHOOK_SECRET: "s", FACTORY_E2E_AGENT_JIRA_ACCOUNTS: DRIVER });
  const blocked = await runDrive({ client: { ...down.clock, post: down.post, jira: down.jira }, options: parseCli(JIRA_ONLY), creds, routes: TEST_ROUTES });
  const jiraRows = blocked.filter((r) => ["ticket", "triage", "plan", "announce", "approve", "progress"].includes(r.step));
  assert.deepEqual([...new Set(jiraRows.map((r) => r.status))], ["blocked"]);
  assert.equal(jiraRows[1].reason, "cannot read the driver's own Jira account (jira.myself is not a function); without it the driver cannot tell its own writes from the agent's");
  assert.equal(down.posts.length, 0);
});

test("V6 a pass row needs its evidence: a Jira row a comment and a changelog line by a non-driver account, a GitHub row its ids and authors, or it is unverified", async () => {
  const post = { kind: "post", slug: "factory-triage-jira", status: 202, at: at(0) };
  const jiraComment = { kind: "comment", id: "15207", by: "non-driver", authorId: AGENT, at: at(1), excerpt: "Triage: bug" };
  const jiraMove = { kind: "transition", id: "32163", from: "To Do", to: "Triaged", by: "non-driver", authorId: AGENT, at: at(2) };
  const jira = requireEvidence([
    result("triage", "pass", "a", { evidence: [post] }),
    result("plan", "pass", "b", { evidence: [jiraComment, jiraMove] }),
    result("approve", "pass", "c", { evidence: [{ ...jiraComment, by: "driver" }, jiraMove] }),
    result("triage", "pass", "d", { evidence: [jiraComment] }),
  ]);
  assert.deepEqual(jira.map((r) => r.status), ["unverified", "pass", "unverified", "unverified"]);
  assert.equal(jira[0].reason, "a (evidence lacks a comment line and a changelog line by a non-driver account, so not a pass)");

  const pr = { kind: "pr", number: 12, author: "example-user", head: DEFAULTS.reviewHead };
  const review = { kind: "review", id: "3301", author: "cursor[bot]", commitId: "e".repeat(40), at: at(0), by: "reviewer" };
  const red = { kind: "ci", sha: "a".repeat(40), runId: "7001", conclusion: "failure" };
  const green = { kind: "ci", sha: "b".repeat(40), runId: "7002", conclusion: "success" };
  const push = { kind: "commit", sha: "b".repeat(40), author: "cursor[bot]", pusher: "cursor[bot]", pushRun: "7002", at: at(1), by: "fixer" };
  const checked = requireEvidence([
    result("prs", "pass", "a", { evidence: [] }),
    result("prs", "pass", "b", { evidence: [{ ...pr, author: "" }] }),
    result("prs", "pass", "c", { evidence: [pr] }),
    result("review", "pass", "d", { evidence: [{ ...review, commitId: "" }] }),
    result("review", "pass", "e", { evidence: [review] }),
    result("review", "pass", "e2", { evidence: [{ ...review, author: "" }] }),
    result("red-check", "pass", "f", { evidence: [red] }),
    result("red-check", "pass", "g", { evidence: [green] }),
    result("red-check", "pass", "h", { evidence: [red, push, green] }),
    result("drive", "pass", "i", { evidence: [{ ...push, pusher: "" }] }),
    result("drive", "pass", "j", { evidence: [push] }),
    result("drive", "pass", "k", { evidence: [{ kind: "gh-comment", id: "2", author: "cursor[bot]", at: at(2), by: "fixer" }] }),
  ]);
  assert.deepEqual(checked.map((r) => r.status), ["unverified", "unverified", "pass", "unverified", "pass", "unverified", "unverified", "unverified", "pass", "unverified", "pass", "pass"]);
  assert.equal(checked[3].reason, "d (evidence lacks a review line with its id, author, and commit, by an allowed reviewer, so not a pass)");
  assert.equal(checked[5].reason, "e2 (evidence lacks a review line with its id, author, and commit, by an allowed reviewer, so not a pass)");
  assert.equal(checked[6].reason, "f (evidence lacks a commit line pushed by a pinned fixer login, with the workflow run that names the pusher and a successful CI run line with its run id, so not a pass)");

  const asComment = evaluateSecurityReview({ reviews: [], comments: [{ id: 9, body: "## Security review\n\n**Verdict:** CLEAN", user: { login: "cursor[bot]" }, created_at: at(0) }], number: 12, headSha: "e".repeat(40), timedOut: true, timeoutSec: 60 });
  assert.equal(asComment.status, "unverified");

  const world = fakeWorld();
  const githubRun = () => runDrive({ client: { ...world.clock, post: world.post, github: world.github }, options: parseCli(["--only", "prs,review,red-check,drive", "--github-timeout", "600", "--quiet", "60", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  const results = await githubRun();
  const reused = (await githubRun()).find((r) => r.step === "prs");
  assert.equal(reused.status, PRIOR_PASS, reused.reason);
  assert.deepEqual(reused.evidence.map((e) => [e.number, e.author]), [[10, "simon"], [11, "simon"]]);
  const table = renderTable(results);
  assert.match(table, /evidence: PR #10 by simon, head factory-test\/review/);
  assert.match(table, /evidence: review 3301 by cursor\[bot\] on commit eeeeeee/);
  assert.match(table, /evidence: CI run 7001 failure on aaaaaaa/);
  assert.match(table, /evidence: commit bbbbbbb authored as cursor\[bot\], pushed by cursor\[bot\] \(actor of workflow run 7002\) at 2026-09-23T04:02:00.000Z \[fixer\]/);
  assert.match(table, /evidence: CI run 7002 success on bbbbbbb/);
  assert.match(table, /evidence: GitHub comment 2 by cursor\[bot\]/);
});

test("V7 red-check cites only the runs that failed on the red commit and finished on the green one", () => {
  const red = commit("aaa", 0);
  const fix = { ...commit("bbb", 100), author: { login: "cursor[bot]" } };
  const runs = {
    [red.sha]: [
      { id: 1, status: "completed", conclusion: "success" },
      { id: 2, status: "completed", conclusion: "failure" },
      { id: 3, status: "in_progress" },
    ],
    [fix.sha]: [
      pushRun(fix, FIXER, { id: 4 }),
      { id: 5, status: "completed", conclusion: "skipped" },
    ],
  };
  const fixed = redCheckAt({ commits: [red, fix], ci: { [red.sha]: "red", [fix.sha]: "green" }, runs, fixerLogins: [FIXER], timedOut: false });
  assert.equal(fixed.status, "pass");
  assert.deepEqual(
    fixed.evidence.map((e) => [e.kind, e.sha.slice(0, 3), e.runId ?? e.author, e.conclusion ?? ""]),
    [["ci", "aaa", "2", "failure"], ["commit", "bbb", "cursor[bot]", ""], ["ci", "bbb", "4", "success"]]
  );
  assert.equal(requireEvidence([fixed])[0].status, "pass");
  const greenOnly = redCheckAt({ commits: [red, fix], ci: { [red.sha]: "red", [fix.sha]: "green" }, runs: { [fix.sha]: runs[fix.sha] }, fixerLogins: [FIXER], timedOut: false });
  assert.equal(requireEvidence([greenOnly])[0].status, "unverified");
});

test("V8 only a fail makes the exit code non-zero; the printed report is the run's start time, the table with its links, then the summary", () => {
  assert.equal(summarizeResults([result("a", "pass", ""), result("b", "blocked", ""), result("c", "unverified", ""), result("d", "skipped", "")]).exitCode, 0);
  const failed = summarizeResults([result("a", "pass", ""), result("b", "fail", "")]);
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.counts, { pass: 1, "pass (prior run)": 0, fail: 1, blocked: 0, unverified: 0, skipped: 0 });
  const table = renderTable([result("ticket", "pass", "TLSSN-42 created", { links: ["https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42"] })]);
  assert.match(table, /^step\s+status\s+detail$/m);
  assert.match(table, /ticket\s+pass\s+TLSSN-42 created/);
  assert.match(table, /browse\/TLSSN-42$/m);

  const rows = [result("ticket", "pass", "TLSSN-10 reused (--ticket), status In Progress", { evidence: [issueEvidence(issueFacts({ key: "TLSSN-10", id: "19897", fields: {} }))], reread: true })];
  const lines = renderReport("2026-09-23T16:00:00.000Z", rows).split("\n");
  assert.equal(lines[0], "run started 2026-09-23T16:00:00.000Z; evidence before this time is from an earlier run");
  assert.equal(lines.slice(1, -3).join("\n"), renderTable(rows));
  assert.equal(lines.slice(-2).join("\n"), renderSummary(rows));
});

test("V9 drive passes only on a pinned fixer's comment or push; unpinned it names a non-driver account and is unverified", async () => {
  const sentinel = comment("simon", "factory: drive", 0);
  const base = { sentinel, driverLogin: "simon", quietMs: 60_000, timedOut: false, now: T0 + 80_000 };
  const human = comment("alice", "Looks good to me", 10, 30);

  const unpinned = evaluateDrive({ ...base, comments: [sentinel, human], commits: [] });
  assert.equal(unpinned.status, "unverified");
  assert.equal(unpinned.reason, "one drive start (comment) by a non-driver account (alice); set FACTORY_E2E_FIXER_LOGINS to pin it; no second drive for 60s");
  assert.equal(unpinned.evidence[0].by, "non-driver");

  const pinned = { ...base, fixerLogins: [FIXER] };
  const humanPush = commit("ccc", 5, "alice");
  const humanRuns = { [humanPush.sha]: [pushRun(humanPush, "alice")] };
  assert.equal(evaluateDrive({ ...pinned, comments: [sentinel], commits: [humanPush], runs: humanRuns }).wait, true);
  const late = evaluateDrive({ ...pinned, comments: [sentinel, human], commits: [humanPush], runs: humanRuns, timedOut: true, timeoutSec: 600 });
  assert.deepEqual([late.status, late.kind], ["fail", "wrong-actor"]);
  assert.equal(late.reason, "no fixer comment or push within 600s of factory: drive; activity only from alice, not one of FACTORY_E2E_FIXER_LOGINS (wrong actor)");
  const driverPush = commit("ddd", 5, "simon");
  assert.equal(evaluateDrive({ ...pinned, fixerLogins: [FIXER, "simon"], comments: [sentinel], commits: [driverPush], runs: { [driverPush.sha]: [pushRun(driverPush, "simon")] }, timedOut: true }).kind, "missing");

  const fixerPush = commit("eee", 20, FIXER);
  const runs = { ...humanRuns, [fixerPush.sha]: [pushRun(fixerPush, FIXER, { id: 9 })] };
  const pass = evaluateDrive({ ...pinned, comments: [sentinel, human], commits: [humanPush, fixerPush], runs });
  assert.equal(pass.status, "pass");
  assert.equal(pass.reason, "one drive start (push) by the fixer account cursor[bot] (actor of workflow run 9); no second drive for 60s");
  assert.deepEqual(pass.evidence.map((e) => [e.kind, e.pusher, e.pushRun, e.by]), [["commit", FIXER, "9", "fixer"]]);
  assert.equal(requireEvidence([pass])[0].status, "pass");
  assert.equal(evaluateDrive({ ...pinned, comments: [sentinel], commits: [fixerPush], runs, since: at(60) }).status, PRIOR_PASS);
  assert.equal(evaluateDrive({ ...pinned, comments: [sentinel], commits: [fixerPush], runs, since: at(20) }).status, "pass");
  assert.equal(requireEvidence([result("drive", "pass", "x", { evidence: [{ ...pass.evidence[0], by: "non-driver" }] })])[0].status, "unverified");

  const world = fakeWorld();
  const creds = resolveCredentials({ JIRA_API_KEY: "k", JIRA_WEBHOOK_SECRET: "s", FACTORY_E2E_GITHUB_TOKEN: "t" });
  const results = await runDrive({ client: { ...world.clock, post: world.post, github: world.github }, options: parseCli(["--only", "prs,review,red-check,drive", "--github-timeout", "600", "--quiet", "60", "--poll", "10"]), creds, routes: TEST_ROUTES });
  const byStep = Object.fromEntries(results.map((r) => [r.step, r]));
  assert.deepEqual(["prs", "review", "red-check", "drive"].map((step) => byStep[step].status), ["pass", "pass", "unverified", "unverified"]);
  assert.match(byStep.drive.reason, /^one drive start \(comment\) by a non-driver account \(cursor\[bot\]\); set FACTORY_E2E_FIXER_LOGINS to pin it/);
  assert.match(byStep["red-check"].reason, /green on bbbbbbb pushed by a non-driver account \(cursor\[bot\]\); set FACTORY_E2E_FIXER_LOGINS to pin it, so not the fixer's fix$/);
});

test("V10 a Security review passes only from an allowed reviewer login; a person, the driver, or another login is a wrong-actor fail, a dismissed review unverified", async () => {
  const body = "## Security review\n\n**Verdict:** CLEAN";
  const head = "e".repeat(40);
  const review = (login, extra = {}) => ({ id: 3301, body, state: "COMMENTED", user: { login, type: "Bot" }, commit_id: head, submitted_at: at(10), html_url: "https://github.com/r/review", ...extra });
  const check = (reviews, extra = {}) => evaluateSecurityReview({ reviews, comments: [], number: 12, headSha: head, driverLogin: "simon", timedOut: true, timeoutSec: 600, ...extra });

  const allowed = check([review("cursor[bot]")]);
  assert.equal(allowed.status, "pass");
  assert.equal(allowed.reason, "## Security review (CLEAN) by the reviewer account cursor[bot] on #12 at the head eeeeeee");
  assert.equal(allowed.evidence[0].by, "reviewer");
  assert.equal(requireEvidence([allowed])[0].status, "pass");

  const refused = [
    [review("alice", { user: { login: "alice", type: "User" } }), "alice, a person", "fail"],
    [review("simon", { user: { login: "simon" } }), "the driver's own login (simon)", "fail"],
    [review("mallory[bot]"), "mallory[bot], not one of FACTORY_E2E_REVIEWER_LOGINS", "fail"],
    [review("cursor[bot]", { state: "DISMISSED" }), "a dismissed review by cursor[bot]", "unverified"],
  ];
  for (const [item, words, status] of refused) {
    const out = check([item]);
    assert.equal(out.status, status, words);
    assert.equal(out.reason, `## Security review on #12 only from ${words}; none by the reviewer within 600s${status === "fail" ? " (wrong actor)" : ""}`);
    assert.equal(out.kind, status === "fail" ? "wrong-actor" : undefined);
    assert.equal(requireEvidence([out])[0].status, status);
    assert.deepEqual(check([item], { timedOut: false }), { wait: true, note: `## Security review on #12 only from ${words}` });
  }
  const mixed = check([refused[0][0], refused[3][0]]);
  assert.equal(mixed.status, "unverified");
  assert.deepEqual(check([], { timedOut: false }), { wait: true, note: "no ## Security review on #12 yet" });
  assert.equal(check([review("cursor[bot]")], { reviewerLogins: [] }).status, "unverified");
  assert.equal(check([review("cursor[bot]", { state: "DISMISSED", id: 1 }), review("cursor[bot]", { id: 2 })]).evidence[0].id, "2");
  const before = check([review("cursor[bot]")], { since: at(60) });
  assert.deepEqual([before.status, before.reason], [PRIOR_PASS, `${allowed.reason} (already done before this run, nothing written)`]);
  assert.equal(check([review("cursor[bot]")], { since: at(10) }).status, "pass");
  assert.equal(requireEvidence([result("review", "pass", "x", { evidence: [{ ...allowed.evidence[0], by: "other" }] })])[0].status, "unverified");

  const world = fakeWorld();
  const creds = resolveCredentials({ JIRA_API_KEY: "k", JIRA_WEBHOOK_SECRET: "s", FACTORY_E2E_GITHUB_TOKEN: "t", FACTORY_E2E_REVIEWER_LOGINS: "factory-security-reviewer[bot]" });
  const results = await runDrive({ client: { ...world.clock, post: world.post, github: world.github }, options: parseCli(["--only", "prs,review", "--github-timeout", "60", "--poll", "10"]), creds, routes: TEST_ROUTES });
  const row = results.find((r) => r.step === "review");
  assert.deepEqual([row.status, row.kind], ["fail", "wrong-actor"]);
  assert.match(row.reason, /only from cursor\[bot\], not one of FACTORY_E2E_REVIEWER_LOGINS/);
  assert.equal(summarizeResults(results).exitCode, 1);
});

test("V11 red-check passes only when a pinned fixer login pushed the green tip; the driver's push or anyone else's is a wrong-actor fail", () => {
  const red = commit("aaa", 0, "simon");
  const human = commit("bbb", 50, "alice");
  const fixer = commit("ccc", 100, FIXER);
  const driverTip = commit("ddd", 120, "simon");
  const ci = { [red.sha]: "red", [human.sha]: "red", [fixer.sha]: "green" };
  const runs = {
    [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 1 })],
    [human.sha]: [pushRun(human, "alice", { conclusion: "failure", id: 2 })],
    [fixer.sha]: [pushRun(fixer, FIXER, { id: 3 })],
    [driverTip.sha]: [pushRun(driverTip, "simon", { id: 4 })],
  };
  const check = (commits, { ci: more = {}, ...extra } = {}) => redCheckAt({ commits, ci: { ...ci, ...more }, runs, driverLogin: "simon", fixerLogins: [FIXER], timedOut: false, ...extra });

  const pass = check([red, human, fixer]);
  assert.equal(pass.status, "pass");
  assert.equal(pass.reason, "red on aaa0000, 1 fixer push(es), green on ccc0000 pushed by the fixer account cursor[bot] (actor of workflow run 3)");
  assert.deepEqual(pass.evidence.filter((e) => e.kind === "commit").map((e) => [e.pusher, e.by]), [["alice", "other"], [FIXER, "fixer"]]);
  assert.equal(requireEvidence([pass])[0].status, "pass");

  const byHuman = check([red, fixer, human], { ci: { [human.sha]: "green", [fixer.sha]: "red" } });
  assert.deepEqual([byHuman.status, byHuman.kind], ["fail", "wrong-actor"]);
  assert.equal(byHuman.reason, "red on aaa0000, green on bbb0000 pushed by alice, not one of FACTORY_E2E_FIXER_LOGINS, so not the fixer's fix (wrong actor)");
  const byDriver = check([red, driverTip], { fixerLogins: [FIXER, "simon"], ci: { [driverTip.sha]: "green" } });
  assert.equal(byDriver.status, "fail");
  assert.match(byDriver.reason, /pushed by the driver's own login \(simon\)/);
  const unpinned = check([red, fixer], { fixerLogins: [] });
  assert.equal(unpinned.status, "unverified");
  assert.match(unpinned.reason, /pushed by a non-driver account \(cursor\[bot\]\); set FACTORY_E2E_FIXER_LOGINS to pin it/);

  assert.equal(check([red, fixer], { since: at(200) }).status, PRIOR_PASS);
  assert.equal(check([red, fixer], { since: at(100) }).status, "pass");
  const relabelled = pass.evidence.map((e) => (e.kind === "commit" ? { ...e, by: "non-driver" } : e));
  assert.equal(requireEvidence([result("red-check", "pass", "x", { evidence: relabelled })])[0].status, "unverified");
});

test("V12 GitHub rows that only re-read state from before the run are 'pass (prior run)', counted apart from this run's passes", async () => {
  const world = fakeWorld();
  const reviews = world.github.reviews;
  world.github.reviews = async (number) => (await reviews(number)).map((review) => ({ ...review, submitted_at: at(-3600) }));
  const githubRun = () => runDrive({ client: { ...world.clock, post: world.post, github: world.github }, options: parseCli(["--only", "prs,review,red-check,drive", "--github-timeout", "600", "--quiet", "60", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  const first = await githubRun();
  assert.deepEqual(first.filter((r) => r.status === PRIOR_PASS).map((r) => r.step), ["review"]);
  assert.equal(renderSummary(first).split("\n")[1], "note: 1 pass row(s) re-read Jira or GitHub state from before this run and sent or wrote nothing (review); 3 pass row(s) came from this run's sends or writes; 0 route POST(s) this run");

  await world.clock.sleep(60_000);
  const second = await githubRun();
  assert.deepEqual(second.filter((r) => GITHUB_STEPS.includes(r.step) && r.step !== "cleanup").map((r) => [r.step, r.status]), [
    ["prs", PRIOR_PASS],
    ["review", PRIOR_PASS],
    ["red-check", PRIOR_PASS],
    ["drive", PRIOR_PASS],
  ]);
  assert.deepEqual([summarizeResults(second).counts.pass, summarizeResults(second).counts[PRIOR_PASS]], [0, 4]);
  assert.equal(renderSummary(second).split("\n")[1], "note: 4 pass row(s) re-read Jira or GitHub state from before this run and sent or wrote nothing (prs, review, red-check, drive); 0 pass row(s) came from this run's sends or writes; 0 route POST(s) this run");

  const retitle = fakeWorld();
  retitle.openPull({ title: DEFAULTS.reviewTitle, head: DEFAULTS.reviewHead });
  retitle.openPull({ title: "Old title", head: DEFAULTS.redHead });
  const retitled = await runDrive({ client: { ...retitle.clock, post: retitle.post, github: retitle.github }, options: parseCli(["--only", "prs", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  assert.equal(retitled.find((r) => r.step === "prs").status, "pass");

  const agentWorld = fakeWorld();
  const { agents } = fakeAgents(agentWorld);
  const agentOptions = { ...parseCli(["--only", "prs", "--poll", "10"]), github: "cloud-agent" };
  const agentClient = { ...agentWorld.clock, post: agentWorld.post, github: readOnlyGithub(agentWorld.github), agents };
  assert.equal((await runDrive({ client: agentClient, options: agentOptions, creds: AGENT_CREDS, routes: TEST_ROUTES })).find((r) => r.step === "prs").status, "pass");
  const reused = (await runDrive({ client: agentClient, options: agentOptions, creds: AGENT_CREDS, routes: TEST_ROUTES })).find((r) => r.step === "prs");
  assert.equal(reused.status, PRIOR_PASS, reused.reason);
  assert.match(reused.reason, / \(already open before this run, nothing written\)$/);

  const draftWorld = fakeWorld();
  draftWorld.openPull({ title: DEFAULTS.reviewTitle, head: DEFAULTS.reviewHead, login: "example-user" }).draft = true;
  draftWorld.openPull({ title: DEFAULTS.redTitle, head: DEFAULTS.redHead, login: "example-user" });
  const draft = (await runDrive({ client: { ...draftWorld.clock, post: draftWorld.post, github: readOnlyGithub(draftWorld.github), agents: fakeAgents(draftWorld).agents }, options: agentOptions, creds: AGENT_CREDS, routes: TEST_ROUTES })).find((r) => r.step === "prs");
  assert.equal(draft.status, "fail", draft.reason);
  assert.match(draft.reason, /opened as a draft/);
  assert.doesNotMatch(draft.reason, /already open before this run/);
});

test("V13 a GitHub evidence line keeps a missing author or id empty, so the row is unverified, never a placeholder that passes", () => {
  const fixerCommit = { kind: "commit", sha: "c".repeat(40), author: FIXER, pusher: FIXER, pushRun: "3", at: at(1), by: "fixer" };
  const green = { kind: "ci", sha: "c".repeat(40), runId: "3", conclusion: "success" };
  for (const unpushed of [{ pusher: "" }, { pushRun: "" }, { pusher: undefined, pushRun: undefined }]) {
    assert.equal(requireEvidence([result("red-check", "pass", "c", { evidence: [{ kind: "ci", sha: "a".repeat(40), runId: "1", conclusion: "failure" }, { ...fixerCommit, ...unpushed }, green] })])[0].status, "unverified");
    assert.equal(requireEvidence([result("drive", "pass", "d", { evidence: [{ ...fixerCommit, ...unpushed }] })])[0].status, "unverified");
  }
  assert.equal(requireEvidence([result("drive", "pass", "d", { evidence: [fixerCommit] })])[0].status, "pass");
  const failed = { kind: "ci", sha: "a".repeat(40), runId: "1", conclusion: "failure" };

  const pr = prEvidence({ number: 10, head: DEFAULTS.reviewHead });
  assert.equal(pr.author, "");
  assert.equal(requireEvidence([result("prs", "pass", "p", { evidence: [pr] })])[0].status, "unverified");

  const review = reviewEvidence({ id: 3301, commit_id: "e".repeat(40), submitted_at: at(0) }, "reviewer");
  assert.equal(review.author, "");
  assert.equal(requireEvidence([result("review", "pass", "r", { evidence: [review] })])[0].status, "unverified");

  const noRunId = ciEvidence("a".repeat(40), { status: "completed", conclusion: "failure" });
  assert.equal(noRunId.runId, "");
  assert.equal(requireEvidence([result("red-check", "pass", "c", { evidence: [noRunId, fixerCommit, green] })])[0].status, "unverified");
  assert.equal(requireEvidence([result("red-check", "pass", "c", { evidence: [failed, fixerCommit, green] })])[0].status, "pass");

  const noId = githubCommentEvidence({ user: { login: FIXER }, created_at: at(2) }, "fixer");
  assert.equal(noId.id, "");
  assert.equal(requireEvidence([result("drive", "pass", "d", { evidence: [noId] })])[0].status, "unverified");
  const fixerComment = githubCommentEvidence({ id: 30, user: { login: FIXER }, created_at: at(2) }, "fixer");
  assert.equal(requireEvidence([result("drive", "pass", "d", { evidence: [fixerComment] })])[0].status, "pass");
  assert.equal(requireEvidence([result("drive", "pass", "d", { evidence: [{ ...fixerComment, author: "" }] })])[0].status, "unverified");
  assert.equal(requireEvidence([result("drive", "pass", "d", { evidence: [{ ...fixerComment, by: "non-driver" }] })])[0].status, "unverified");

  const noUser = verifyAgentPr({ pulls: [pull(6, DEFAULTS.reviewHead, DEFAULTS.reviewTitle, { base: { ref: "main" } })], commits: [commit("e7acd1d", 0)], repo: REPO, head: DEFAULTS.reviewHead, base: "main", title: DEFAULTS.reviewTitle, before: { sha: "e".repeat(40), ahead: 1 }, after: { sha: "e".repeat(40), ahead: 1 } });
  assert.equal(noUser.status, "pass");
  assert.equal(noUser.evidence[0].author, "");
  assert.equal(requireEvidence([noUser])[0].status, "unverified");

  assert.deepEqual(["", undefined].map((login) => githubActor(login, { allowed: [FIXER] })), ["unknown", "unknown"]);
});

test("docs/e2e-driver.md and --help describe the rules the driver scores by", () => {
  const usage = [
    /marked pass, pass \(prior run\), fail, blocked, unverified, or skipped;\nexits 1 on any fail\./,
    /FACTORY_E2E_REVIEWER_LOGINS {2}comma list of reviewer logins \(default cursor\[bot\]\)/,
    /A push's login is the actor of the push or\n +pull_request workflow run on the commit, never the commit's author; with no\n +such run the push does not count\./,
    /their COMMENTED review of the PR head whose body opens with "## Security review"\n +then "\*\*Verdict:\*\* CLEAN" or "FINDINGS" passes\./,
    /A pull_request run its\n +reopener started right after reopening the PR names no pusher\./,
    /Nor does one\n +its author started right after opening it\./,
    /A run counts only when its head_sha, head_branch, head_repository and\n +pull_requests name this commit, fixture branch, repo and PR alone\./,
  ];
  for (const pattern of usage) assert.match(USAGE, pattern);

  const readme = readFileSync(join(here, "..", "docs", "e2e-driver.md"), "utf8");
  const says = [
    "Cloud-agent commits on marsbank are signed (`verification.verified: true`, committer `cursoragent`)",
    "the driver reads the PR's `reopened` issue events and its opening (`user.login` and `created_at` on `GET /pulls/{n}`",
    "an `opened` run names whoever opened it, and a commit pushed while no PR was open may have no other run",
    "It pins each event to the commit of its own run: the earliest `pull_request` run by the event's login from 5 seconds before the event to 600 seconds after it, both ends included, among the runs of every commit read.",
    "so a run 601 seconds after the event reads as a push",
    "A (re)open event or run whose time does not parse drops every `pull_request` run by that login",
    "Only when that opening run was not read does a fixer push within 600 seconds of the opening read `unverified`.",
    "every entry of its `pull_requests` is this PR's number on that repository",
    "A pull request with no `head.sha` makes both rows wait, then read `unverified`",
    "when it is no longer open or its head moved, the row waits for a poll where both reads agree",
    "Two or more open PRs on the branch are a `fail`, one into another base is `unverified`, and the steps that read that PR are `blocked`",
  ];
  for (const text of says) assert.ok(readme.includes(text), `docs/e2e-driver.md lacks: ${text}`);
  const retired = [
    "cloud-agent pushes are unsigned",
    "never takes the pusher from a `pull_request` run its reopener started within 10 minutes after a `reopened` event",
    "with a push by someone else the commit then has two logins and no pusher, so the error runs toward `unverified`, not toward a pass",
    "The rule does not cover an `opened` run",
    "On the fixtures nothing is lost",
  ];
  for (const text of retired) assert.ok(!readme.includes(text), `docs/e2e-driver.md still says: ${text}`);
});

test("V15 a GitHub pass cites the item that decided it, and the driver's own login never passes even when a pin names it", async () => {
  const body = "## Security review\n\n**Verdict:** CLEAN";
  const bot = { login: FIXER, type: "Bot" };
  const review = { id: 3301, body, state: "COMMENTED", user: bot, commit_id: "e".repeat(40), submitted_at: at(10), html_url: "https://github.com/r/review" };
  const issueReview = { id: 9, body, user: bot, created_at: at(5), html_url: "https://github.com/r/comment" };
  const reviewCheck = (reviews, comments = []) => evaluateSecurityReview({ reviews, comments, number: 12, headSha: "e".repeat(40), driverLogin: "simon", timedOut: true, timeoutSec: 600 });
  const both = reviewCheck([review], [issueReview]);
  assert.deepEqual([both.evidence[0].id, requireEvidence([both])[0].status], ["3301", "pass"]);
  assert.equal(reviewCheck([{ ...review, body: "Security looks fine" }]).kind, "missing");

  const sentinel = comment("simon", "factory: drive", 0);
  const drive = { sentinel, driverLogin: "simon", fixerLogins: [FIXER], quietMs: 60_000, timedOut: true, timeoutSec: 600, now: T0 + 200_000 };
  const later = commit("fff", 20, FIXER);
  const earlier = commit("fff", -10, FIXER);
  const cited = evaluateDrive({ ...drive, comments: [sentinel, comment(FIXER, "Working on it", 10, 30)], commits: [later], runs: { [later.sha]: [pushRun(later, FIXER)] } });
  assert.deepEqual(cited.evidence.map((e) => [e.kind, e.id]), [["gh-comment", "30"]]);
  assert.equal(evaluateDrive({ ...drive, comments: [sentinel], commits: [earlier], runs: { [earlier.sha]: [pushRun(earlier, FIXER)] } }).kind, "missing");
  const nameless = evaluateDrive({ ...drive, fixerLogins: [], comments: [sentinel, { ...comment(FIXER, "hi", 10), user: undefined }], commits: [] });
  assert.equal(nameless.reason, "no fixer comment or push within 600s of factory: drive; activity only from an author with no login");

  const red = commit("aaa", 0, "simon");
  const noLogin = commit("bbb", 50);
  const redCheck = redCheckAt({ commits: [red, noLogin], ci: { [red.sha]: "red", [noLogin.sha]: "green" }, driverLogin: "simon", fixerLogins: [FIXER], timedOut: false });
  assert.equal(redCheck.status, "unverified");
  assert.match(redCheck.reason, /pushed by an unknown pusher \(no push or pull_request workflow run names exactly one actor\), so not the fixer's fix$/);
  const lines = (conclusion) => [{ kind: "ci", sha: red.sha, runId: "1", conclusion: "failure" }, { kind: "commit", sha: "c".repeat(40), author: FIXER, pusher: FIXER, pushRun: "3", at: at(1), by: "fixer" }, { kind: "ci", sha: "c".repeat(40), runId: "3", conclusion }];
  assert.deepEqual(["success", "neutral"].map((conclusion) => requireEvidence([result("red-check", "pass", "c", { evidence: lines(conclusion) })])[0].status), ["pass", "unverified"]);

  assert.match(formatEvidence(lines("success")[1]), / \[fixer\]$/);
  const posted = [result("ticket", "pass", "t", { reread: true }), result("desk", "unverified", "d", { evidence: [postEvidence({ slug: "factory-desk", status: 202, at: T0 })] })];
  assert.match(renderSummary(posted), /; 1 route POST\(s\) this run$/);

  const world = fakeWorld();
  world.pushers[world.shas.fix] = "simon";
  const fakeRuns = world.github.runs;
  world.github.runs = async (sha) => (await fakeRuns(sha)).map((run) => (sha === world.shas.fix ? { ...run, event: "push" } : run));
  world.github.reviews = async () => [];
  const issueComments = world.github.issueComments;
  world.github.issueComments = async (number) => [...(await issueComments(number)), ...(world.pulls.find((p) => p.number === number).head.ref === DEFAULTS.reviewHead ? [{ ...issueReview, user: { login: "simon" } }] : [])];
  const pins = { JIRA_API_KEY: "k", JIRA_WEBHOOK_SECRET: "s", FACTORY_E2E_GITHUB_TOKEN: "t", FACTORY_E2E_FIXER_LOGINS: `simon,${FIXER}`, FACTORY_E2E_REVIEWER_LOGINS: `simon,${FIXER}` };
  const githubOptions = parseCli(["--only", "prs,review,red-check", "--github-timeout", "600", "--poll", "10"]);
  const byStep = Object.fromEntries((await runDrive({ client: { ...world.clock, post: world.post, github: world.github }, options: githubOptions, creds: resolveCredentials(pins), routes: TEST_ROUTES })).map((r) => [r.step, r]));
  assert.match(byStep.review.reason, /only from the driver's own login \(simon\)/);
  assert.match(byStep["red-check"].reason, /pushed by the driver's own login \(simon\)/);

  const commentOnly = fakeWorld();
  commentOnly.github.reviews = async () => [];
  const onlyComments = commentOnly.github.issueComments;
  commentOnly.github.issueComments = async (number) => [...(await onlyComments(number)), ...(commentOnly.pulls.find((p) => p.number === number).head.ref === DEFAULTS.reviewHead ? [issueReview] : [])];
  const reviewRow = (await runDrive({ client: { ...commentOnly.clock, post: commentOnly.post, github: commentOnly.github }, options: parseCli(["--only", "prs,review", "--github-timeout", "60", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES })).find((r) => r.step === "review");
  assert.equal(reviewRow.status, "unverified");
  assert.match(reviewRow.reason, /only from cursor\[bot\], but an issue comment, not a PR review; none by the reviewer within 60s$/);

  const agentWorld = fakeWorld();
  agentWorld.openPull({ title: DEFAULTS.reviewTitle, head: DEFAULTS.reviewHead, login: "example-user" });
  const { agents } = fakeAgents(agentWorld);
  const mixed = (await runDrive({ client: { ...agentWorld.clock, post: agentWorld.post, github: readOnlyGithub(agentWorld.github), agents }, options: { ...parseCli(["--only", "prs", "--poll", "10"]), github: "cloud-agent" }, creds: AGENT_CREDS, routes: TEST_ROUTES })).find((r) => r.step === "prs");
  assert.equal(mixed.status, "pass", mixed.reason);
  assert.equal(mixed.reread, undefined);
});

test("runDrive fails a hop whose route does not answer 202, and blocks a hop whose route is unknown", async () => {
  const world = fakeWorld({ routeStatus: 404 });
  const options = parseCli(["--only", "ticket,triage", "--timeout", "30", "--poll", "10"]);
  const results = await runDrive({ client: { ...world.clock, post: world.post, jira: world.jira }, options, creds: CREDS, routes: TEST_ROUTES });
  const triage = results.find((r) => r.step === "triage");
  assert.equal(triage.status, "fail");
  assert.match(triage.reason, /answered HTTP 404/);
  assert.equal(summarizeResults(results).exitCode, 1);

  const quiet = fakeWorld();
  const routes = { ...TEST_ROUTES, planner: { slug: "factory-planner", url: undefined, source: "FACTORY_ROUTE_PLANNER" } };
  const unknown = await runDrive({ client: { ...quiet.clock, post: quiet.post, jira: quiet.jira }, options: parseCli(["--only", "ticket,triage,plan", "--timeout", "30", "--poll", "10"]), creds: CREDS, routes });
  assert.equal(unknown.find((r) => r.step === "plan").reason, "route unknown: set FACTORY_ROUTE_PLANNER");
});

test("runDrive --reset counts only this run's comments, so leftovers from an earlier attempt neither pass nor block a hop", async () => {
  const world = fakeWorld();
  const old = (seconds) => new Date(T0 - seconds * 1000).toISOString();
  const history = (id, from, to, seconds) => ({ id: String(id), created: old(seconds), author: { accountId: AGENT, displayName: "the operator" }, items: [{ field: "status", fromString: from, toString: to }] });
  const histories = [history(500, "To Do", "Triaged", 3500), history(501, "Triaged", "Planned", 2900), history(502, "Planned", "Approved", 2500), history(503, "Approved", "In Progress", 1900)];
  const leftoverPlan = { body: "Plan: TLSSN-7 Retry\n\nBrief:\nDo it.", created: old(3000) };
  const leftoverImplementing = { body: "Implementing: https://cursor.com/agents/bc-3", created: old(2000) };
  world.seedTicket("TLSSN-7", { status: "In Progress", comments: [{ body: "Triage: bug\nSeverity: high", created: old(3600) }, leftoverPlan, leftoverImplementing], histories });
  const options = parseCli(["--ticket", "TLSSN-7", "--reset", "--only", "ticket,triage,plan", "--timeout", "30", "--poll", "10"]);
  const client = { ...world.clock, post: world.post, jira: world.jira };
  const results = await runDrive({ client, options, creds: CREDS, routes: TEST_ROUTES });
  const byStep = Object.fromEntries(results.map((r) => [r.step, r]));
  assert.match(byStep.ticket.reason, /reset to To Do/);
  for (const hop of ["triage", "plan"]) {
    assert.equal(byStep[hop].status, "fail", byStep[hop].reason);
    assert.equal(byStep[hop].kind, "stale");
    assert.match(byStep[hop].reason, /from before this run and does not count/);
  }
  assert.equal(world.tickets.get("TLSSN-7").fields.comment.comments.length, 3);
  assert.equal(summarizeResults(results).exitCode, 1);

  world.seedTicket("TLSSN-8", { status: "In Progress", comments: [leftoverPlan, leftoverImplementing], histories });
  const rerun = await runDrive({ client, options: parseCli(["--ticket", "TLSSN-8", "--reset", "--only", "ticket,triage,plan", "--timeout", "30", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  assert.deepEqual(rerun.filter((r) => ["triage", "plan"].includes(r.step)).map((r) => [r.step, r.status]), [["triage", "pass"], ["plan", "pass"]]);
  assert.equal(world.tickets.get("TLSSN-8").fields.comment.comments.length, 4);
});

test("V16 a commit authored as the fixer passes red-check and drive only when a workflow run names the fixer as its pusher", () => {
  const red = commit("aaa", 0, "simon");
  const spoof = commit("ccc", 100, FIXER);
  const redRuns = [pushRun(red, "simon", { conclusion: "failure", id: 1 })];
  const redCheck = (spoofRuns) => redCheckAt({ commits: [red, spoof], ci: { [red.sha]: "red", [spoof.sha]: "green" }, runs: { [red.sha]: redRuns, [spoof.sha]: spoofRuns }, driverLogin: "simon", fixerLogins: [FIXER], timedOut: false });
  const sentinel = comment("simon", "factory: drive", 0);
  const late = commit("ddd", 10, FIXER);
  const drive = (lateRuns) => evaluateDrive({ sentinel, comments: [sentinel], commits: [late], runs: { [late.sha]: lateRuns }, driverLogin: "simon", fixerLogins: [FIXER], quietMs: 60_000, timedOut: true, timeoutSec: 600, now: T0 + 400_000 });

  const pushedByAlice = [redCheck([pushRun(spoof, "alice")]), drive([pushRun(late, "alice")])];
  assert.deepEqual(pushedByAlice.map((r) => [r.status, r.kind]), [["fail", "wrong-actor"], ["fail", "wrong-actor"]]);
  assert.match(pushedByAlice[0].reason, /green on ccc0000 pushed by alice, not one of FACTORY_E2E_FIXER_LOGINS, so not the fixer's fix \(wrong actor\)$/);
  assert.match(pushedByAlice[1].reason, /activity only from alice, not one of FACTORY_E2E_FIXER_LOGINS \(wrong actor\)$/);

  const noPusher = [[], undefined, [pushRun(spoof, FIXER, { event: "workflow_dispatch" })], [pushRun(spoof, FIXER), pushRun(spoof, "alice", { id: 4 })]];
  for (const runs of noPusher) {
    const rows = [redCheck(runs), drive(runs?.map((run) => ({ ...run, created_at: late.commit.committer.date })))];
    assert.deepEqual(rows.map((r) => r.status), ["unverified", "unverified"], JSON.stringify(runs));
    assert.deepEqual(requireEvidence(rows).map((r) => r.status), ["unverified", "unverified"]);
  }
  assert.match(redCheck([]).reason, /pushed by an unknown pusher \(no push or pull_request workflow run names exactly one actor\)/);
  const unpushed = redCheck([]).evidence.find((e) => e.kind === "commit");
  assert.deepEqual([unpushed.author, unpushed.pusher, unpushed.pushRun], [FIXER, "", ""]);
  assert.equal(formatEvidence(unpushed), "commit ccc0000 authored as cursor[bot], pusher unknown, committed at 2026-09-23T04:01:40.000Z [unknown]");

  const committedEarlier = commit("eee", -10, FIXER);
  const pushedLater = { ...pushRun(committedEarlier, FIXER, { id: 6, event: "push" }), created_at: at(15) };
  const late2 = evaluateDrive({ sentinel, comments: [sentinel], commits: [committedEarlier], runs: { [committedEarlier.sha]: [pushedLater] }, driverLogin: "simon", fixerLogins: [FIXER], quietMs: 60_000, timedOut: true, timeoutSec: 600, now: T0 + 400_000 });
  assert.equal(late2.status, "pass", late2.reason);
  assert.equal(late2.evidence[0].at, at(15));
  const committedLater = commit("eee", 20, FIXER);
  const pushedEarlier = { ...pushRun(committedLater, FIXER, { id: 6, event: "push" }), created_at: at(-5) };
  assert.equal(evaluateDrive({ sentinel, comments: [sentinel], commits: [committedLater], runs: { [committedLater.sha]: [pushedEarlier] }, driverLogin: "simon", fixerLogins: [FIXER], quietMs: 60_000, timedOut: true, timeoutSec: 600, now: T0 + 400_000 }).kind, "missing");

  const fixed = [redCheck([pushRun(spoof, FIXER, { id: 3 })]), drive([pushRun(late, FIXER, { id: 5, event: "push" })])];
  assert.deepEqual(requireEvidence(fixed).map((r) => r.status), ["pass", "pass"]);
  assert.match(fixed[1].reason, /^one drive start \(push\) by the fixer account cursor\[bot\] \(actor of workflow run 5\);/);
});

test("V17 a later Triage: comment by the driver's own Jira account does not replace the agent's earlier one", () => {
  const facts = issue({ status: "Triaged", comments: [TRIAGE, { text: "Triage: a note by a person on the driver's token", created: at(30), authorId: DRIVER }], transitions: [INTO(900, "To Do", "Triaged", 20)] });
  for (const timedOut of [true, false]) {
    const hop = evaluateHop("triage", facts, { timedOut, timeoutSec: 600, identity: WHO });
    assert.equal(hop.status, "pass", hop.reason);
    assert.equal(hop.evidence[0].id, "100");
  }
});

test("V18 an item the baseline recorded in the same millisecond as its read belongs to the baseline, so the hop is done before the run", () => {
  const baseline = { at: at(100), status: "Triaged", commentIds: ["100"], transitionIds: ["900"] };
  const sameMs = issue({ status: "Triaged", comments: [{ ...TRIAGE, created: at(100) }], transitions: [INTO(900, "To Do", "Triaged", 100)] });
  assert.equal(priorRun("triage", sameMs, baseline, WHO)?.status, "pass");
  const newer = issue({ status: "Triaged", comments: [{ ...TRIAGE, created: at(100.001) }], transitions: [INTO(900, "To Do", "Triaged", 100)] });
  assert.equal(priorRun("triage", newer, baseline, WHO), undefined);
});

test("V19 the security review passes only in the reviewer's own shape: a COMMENTED review of the head whose body opens with the verdict; a review of another commit names both shas far enough to tell them apart", () => {
  const head = "e".repeat(40);
  const body = "## Security review\n\n**Verdict:** CLEAN";
  const good = { id: 1, body, state: "COMMENTED", user: { login: FIXER, type: "Bot" }, commit_id: head, submitted_at: at(10), html_url: "https://github.com/r/review" };
  const check = (reviews, extra = {}) => evaluateSecurityReview({ reviews, comments: [], number: 12, headSha: head, driverLogin: "simon", timedOut: true, timeoutSec: 600, ...extra });
  assert.equal(check([good]).reason, "## Security review (CLEAN) by the reviewer account cursor[bot] on #12 at the head eeeeeee");
  const findings = check([{ ...good, body: "## Security review\n\n**Verdict:** FINDINGS\n- [high] src/a.ts:3 SQL injection" }]);
  assert.deepEqual([findings.status, /\(FINDINGS\)/.test(findings.reason)], ["pass", true]);
  assert.equal(check([{ ...good, submitted_at: undefined }], { timedOut: false }).status, "pass");
  assert.deepEqual(check([], { timedOut: false, comments: [{ id: 2, body, user: good.user, html_url: "h" }] }), { wait: true, note: "## Security review on #12 only from cursor[bot], but an issue comment, not a PR review" });
  assert.equal(check([{ body: "LGTM" }], { timedOut: false }).wait, true);
  assert.equal(check([]).status, "fail");

  const misfits = [
    [{ ...good, body: `Quoting the reviewer: ${body}` }, "a body that does not open with ## Security review then **Verdict:** CLEAN or FINDINGS"],
    [{ ...good, body: "## Security review\n\nLooks fine to me" }, "a body that does not open with ## Security review then **Verdict:** CLEAN or FINDINGS"],
    [{ ...good, body: "## Security review\n\n**Verdict:** CLEANISH" }, "a body that does not open with ## Security review then **Verdict:** CLEAN or FINDINGS"],
    [{ ...good, state: "APPROVED" }, "a review in state APPROVED, not COMMENTED"],
    [{ ...good, state: "CHANGES_REQUESTED" }, "a review in state CHANGES_REQUESTED, not COMMENTED"],
    [{ ...good, commit_id: "f".repeat(40) }, "a review of fffffff, not the head eeeeeee"],
    [{ ...good, commit_id: `${"e".repeat(12)}${"c".repeat(28)}` }, "a review of eeeeeeeeeeeec, not the head eeeeeeeeeeeee"],
    [{ ...good, commit_id: `${"e".repeat(39)}d` }, `a review of ${"e".repeat(39)}d, not the head ${head}`],
    [{ ...good, commit_id: undefined }, "a review of no commit, not the head eeeeeee"],
  ];
  for (const [review, why] of misfits) {
    const row = check([review]);
    assert.deepEqual([row.status, row.reason], ["unverified", `## Security review on #12 only from cursor[bot], but ${why}; none by the reviewer within 600s`]);
    assert.equal(check([review], { timedOut: false }).wait, true);
  }
  assert.match(check([good], { headSha: undefined }).reason, /cursor\[bot\], but no PR head to compare its commit with;/);
  const asComment = evaluateSecurityReview({ reviews: [], comments: [{ id: 5, body, user: { login: FIXER, type: "Bot" }, created_at: at(5), html_url: "h" }], number: 12, headSha: head, driverLogin: "simon", timedOut: true, timeoutSec: 600 });
  assert.deepEqual([asComment.status, /cursor\[bot\], but an issue comment, not a PR review;/.test(asComment.reason)], ["unverified", true]);
  assert.deepEqual([asComment.evidence[0].commitId, asComment.evidence[0].id], ["", "5"]);
  assert.equal(check([{ ...good, state: "APPROVED" }, good]).status, "pass");
  const both = evaluateSecurityReview({ reviews: [{ ...good, state: "APPROVED" }], comments: [{ id: 5, body, user: { login: FIXER, type: "Bot" }, created_at: at(5), html_url: "h" }], number: 12, headSha: head, driverLogin: "simon", timedOut: true, timeoutSec: 600 });
  assert.match(both.reason, /only from cursor\[bot\], but a review in state APPROVED, not COMMENTED; cursor\[bot\], but an issue comment, not a PR review;/);
});

test("V23 runDrive reviews the PR head, starts a drive on a fixer push alone, and reads the newest commits of a long PR", async () => {
  const world = fakeWorld();
  const older = { ...commit("0de", -300, "simon"), sha: "d".repeat(40) };
  const commits = world.github.commits;
  world.github.commits = async (number) => {
    const list = await commits(number);
    return world.pulls.find((p) => p.number === number).head.ref === DEFAULTS.reviewHead ? [older, ...list] : list;
  };
  const reviewRow = (await githubRows(world, "prs,review")).review;
  assert.equal(reviewRow.status, "pass", reviewRow.reason);
  assert.match(reviewRow.reason, /at the head eeeeeee$/);

  const pushWorld = fakeWorld();
  const padding = Array.from({ length: 11 }, (_, i) => ({ ...commit(`${i}`.padStart(3, "f"), -600 + i, "simon"), sha: `${i}`.padStart(40, "f") }));
  let push;
  const reviewCommits = pushWorld.github.commits;
  pushWorld.github.commits = async (number) => {
    const list = await reviewCommits(number);
    if (pushWorld.pulls.find((p) => p.number === number).head.ref !== DEFAULTS.reviewHead) return [...padding, ...list];
    const sentinel = (await pushWorld.github.issueComments(number)).find((c) => c.body === "factory: drive");
    if (sentinel !== undefined && push === undefined) push = { ...commit("abc", 0, "someone"), sha: "c".repeat(40), commit: { committer: { date: new Date(Date.parse(sentinel.created_at) + 1000).toISOString() } } };
    return [...padding, ...list, ...(push === undefined ? [] : [push])];
  };
  const issueComments = pushWorld.github.issueComments;
  pushWorld.github.issueComments = async (number) => (await issueComments(number)).filter((c) => !c.body.startsWith("Driving:"));
  const runs = pushWorld.github.runs;
  pushWorld.github.runs = async (sha) => (sha === push?.sha ? [pushRun(push, FIXER, { id: 7010, event: "push" })] : padding.some((c) => c.sha === sha) ? [] : runs(sha));
  const rows = await runDrive({ client: { ...pushWorld.clock, post: pushWorld.post, github: pushWorld.github }, options: parseCli(["--only", "prs,red-check,drive", "--github-timeout", "600", "--quiet", "60", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  const byStep = Object.fromEntries(rows.map((r) => [r.step, r]));
  assert.equal(byStep.drive.status, "pass", byStep.drive.reason);
  assert.match(byStep.drive.reason, /^one drive start \(push\) by the fixer account cursor\[bot\] \(actor of workflow run 7010\);/);
  assert.equal(byStep["red-check"].status, "pass", byStep["red-check"].reason);

  const allGreen = Object.fromEntries(padding.map((c) => [c.sha, "green"]));
  const windowed = (ci, timedOut) => redCheckAt({ commits: padding.slice(-10), older: 1, ci, runs: {}, driverLogin: "simon", fixerLogins: [FIXER], timedOut });
  const unread = `no red commit among the newest 10 of 11 commits on ${DEFAULTS.redHead}; the driver reads workflow runs for the newest 10 only`;
  assert.deepEqual([windowed(allGreen, false).status, windowed(allGreen, false).reason], ["unverified", unread]);
  assert.deepEqual([windowed({}, false).wait, windowed({}, true).status], [true, "unverified"]);
  assert.equal(redCheckAt({ commits: padding.slice(-10), ci: {}, runs: {}, driverLogin: "simon", fixerLogins: [FIXER], timedOut: false }).wait, true);

  const buried = fakeWorld();
  const buriedCommits = buried.github.commits;
  buried.github.commits = async (number) => {
    const list = await buriedCommits(number);
    return buried.pulls.find((p) => p.number === number).head.ref === DEFAULTS.redHead ? [list[0], ...padding] : list;
  };
  const buriedRuns = buried.github.runs;
  buried.github.runs = async (sha) => (padding.some((c) => c.sha === sha) ? [] : buriedRuns(sha));
  const buriedRow = (await githubRows(buried, "prs,red-check"))["red-check"];
  assert.deepEqual([buriedRow.status, buriedRow.reason], ["unverified", `no red commit among the newest 10 of 12 commits on ${DEFAULTS.redHead}; the driver reads workflow runs for the newest 10 only`]);
});

const openRun = (state, login, id, seconds) => (state === "none" ? [] : [{ id, status: state, conclusion: null, event: "pull_request", actor: { login }, created_at: at(seconds) }]);

test("V24 red-check on a 12-commit PR waits while the newest commit's CI is pending, then passes once it goes red and the fixer's push goes green", async () => {
  const world = fakeWorld();
  const padding = Array.from({ length: 11 }, (_, i) => ({ ...commit("pad", -900 + i, "simon"), sha: String(i).padStart(2, "0").padStart(40, "1") }));
  const newest = { ...commit("c12", -300, "simon"), sha: "2".repeat(40) };
  const fixed = { ...commit("c13", 200, FIXER), sha: "3".repeat(40) };
  let reads = 0;
  let pullReads = 0;
  const redPr = (number) => world.pulls.find((p) => p.number === number).head.ref === DEFAULTS.redHead;
  const pull = world.github.pull;
  world.github.pull = async (number) => {
    if (!redPr(number)) return pull(number);
    if (pullReads++ % 2 === 0) reads += 1;
    const found = world.pulls.find((p) => p.number === number);
    return { ...found, head: { ...found.head, sha: (reads >= 4 ? fixed : newest).sha } };
  };
  const commits = world.github.commits;
  world.github.commits = async (number) => (redPr(number) ? [...padding, newest, ...(reads >= 4 ? [fixed] : [])] : commits(number));
  const runs = world.github.runs;
  world.github.runs = async (sha) => {
    const pad = padding.findIndex((c) => c.sha === sha);
    if (pad !== -1) return [pushRun(padding[pad], "simon", { id: 7100 + pad })];
    if (sha === newest.sha) return reads === 1 ? openRun("in_progress", "simon", 7200, -300) : reads === 2 ? openRun("queued", "simon", 7200, -300) : [pushRun(newest, "simon", { conclusion: "failure", id: 7200 })];
    if (sha === fixed.sha) return reads === 4 ? openRun("in_progress", FIXER, 7300, 200) : [pushRun(fixed, FIXER, { id: 7300 })];
    return runs(sha);
  };
  const lines = [];
  const rows = await runDrive({ client: { ...world.clock, post: world.post, github: world.github, log: (line) => lines.push(line) }, options: parseCli(["--only", "prs,red-check", "--github-timeout", "600", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  const row = rows.find((r) => r.step === "red-check");
  assert.deepEqual([row.status, row.reason], ["pass", "red on 2222222, 1 fixer push(es), green on 3333333 pushed by the fixer account cursor[bot] (actor of workflow run 7300)"]);
  assert.equal(reads, 5);
  assert.deepEqual(
    lines.filter((line) => line.startsWith("red-check: ") && !line.startsWith("red-check: pass")).map((line) => line.replace(/^red-check: \d+s, /, "")),
    ["no red commit yet; CI not finished on 1 of 10 commit(s), pending on 2222222", "no red commit yet; CI not finished on 1 of 10 commit(s), pending on 2222222", "red on 2222222, waiting for the fixer's push", "1 commit(s) after the red one; CI pending on 3333333"]
  );
});

test("V25 red-check waits on any commit whose CI is unfinished before calling a green head blocked", () => {
  const first = commit("a1", -300, "simon");
  const tip = commit("b1", 100, FIXER);
  const check = (firstRuns, timedOut = false) => {
    const runs = { [first.sha]: firstRuns, [tip.sha]: [pushRun(tip, FIXER, { id: 7002 })] };
    return redCheckAt({ commits: [first, tip], runs, ci: { [first.sha]: ciState(firstRuns), [tip.sha]: "green" }, driverLogin: "simon", fixerLogins: [FIXER], timedOut, timeoutSec: 600 });
  };
  for (const state of ["queued", "in_progress", "waiting", "pending", "none"]) {
    const out = check(openRun(state, "simon", 7001, -300));
    assert.deepEqual(out, { wait: true, note: `no red commit yet; CI not finished on 1 of 2 commit(s), green on ${tip.sha.slice(0, 7)}` }, state);
  }
  assert.equal(check([pushRun(first, "simon", { conclusion: "failure", id: 7001 })]).status, "pass");
  assert.equal(check([pushRun(first, "simon", { id: 7001 })]).status, "blocked");
  const late = check(openRun("in_progress", "simon", 7001, -300), true);
  assert.deepEqual([late.status, late.kind, late.reason], ["fail", "missing", `CI never went red on ${tip.sha.slice(0, 7)} within 600s (state green)`]);
});

test("V26 rule: no evaluator returns a final verdict (unverified, blocked, fail, pass) from a pending, none, in_progress, or queued input", () => {
  const STATES = ["pending", "none", "in_progress", "queued"];
  const ciOf = (commits, runs) => Object.fromEntries(commits.map((c) => [c.sha, ciState(runs[c.sha] ?? [])]));
  const redCheck = (commits, runs, older = 0) => redCheckAt({ commits, runs, ci: ciOf(commits, runs), older, driverLogin: "simon", fixerLogins: [FIXER], timedOut: false, timeoutSec: 600 });
  const window = Array.from({ length: 10 }, (_, i) => commit(`ab${i}`, -600 + i, "simon"));
  const greenWindow = Object.fromEntries(window.map((c, i) => [c.sha, [pushRun(c, "simon", { id: 7100 + i })]]));
  const middle = commit("a2", -300, "simon");
  const tip = commit("b2", 100, FIXER);
  const red = commit("a3", -300, "simon");
  const pushed = commit("b3", 100, FIXER);
  const head = "e".repeat(40);
  const review = (state) => ({ id: 3301, body: "## Security review\n\n**Verdict:** CLEAN", state, user: { login: FIXER, type: "Bot" }, commit_id: head, submitted_at: state === "PENDING" ? undefined : at(50), html_url: "https://github.com/r/review" });
  const reviewOf = (reviews) => evaluateSecurityReview({ reviews, comments: [], number: 12, headSha: head, driverLogin: "simon", reviewerLogins: [FIXER], timedOut: false, timeoutSec: 600 });
  const sentinel = comment("simon", "factory: drive", 0, 1);
  const push = commit("c4", 5, "someone");
  const driveOf = (runs, seconds) => evaluateDrive({ sentinel, comments: [sentinel], commits: [push], runs: { [push.sha]: runs }, driverLogin: "simon", fixerLogins: [FIXER], now: T0 + seconds * 1000, quietMs: 60_000, timedOut: false, timeoutSec: 600 });
  const branch = { sha: "c".repeat(40), ahead: 1 };
  const pull = { number: 12, state: "open", title: "e2e: red", html_url: `https://github.com/${REPO}/pull/12`, head: { ref: "e2e/red", repo: { full_name: REPO } }, base: { ref: "main" }, user: { login: "example-user" } };
  const prOf = (pulls) => settleVerdict(verifyAgentPr({ pulls, commits: pulls.length === 0 ? [] : [push], repo: REPO, head: "e2e/red", base: "main", title: "e2e: red", before: branch, after: branch }), { timedOut: false });
  const commentOf = (comments) => settleVerdict(verifyAgentComment({ comments, number: 12, allowedLogins: [FIXER] }), { timedOut: false });
  const hopOf = (state) =>
    evaluateHop("triage", state === "done" ? issue({ status: "Triaged", comments: [TRIAGE], transitions: [INTO(1, "To Do", "Triaged", 11)] }) : issue({ comments: state === "none" ? [] : [TRIAGE] }), { timedOut: false, timeoutSec: 600, identity: WHO });

  // Each row maps a non-terminal state onto its input (open) and names the verdict once that input settles, so an evaluator that always waits fails too.
  const rows = [
    { name: "red-check: newest of 10 read commits open, 1 older unread", open: (s) => redCheck(window, { ...greenWindow, [window[9].sha]: openRun(s, "simon", 7109, -591) }, 1), settled: () => redCheck(window, greenWindow, 1), final: "unverified" },
    { name: "red-check: all commits read, one open under the fixer's green tip", open: (s) => redCheck([middle, tip], { [middle.sha]: openRun(s, "simon", 7001, -300), [tip.sha]: [pushRun(tip, FIXER, { id: 7002 })] }), settled: () => redCheck([middle, tip], { [middle.sha]: [pushRun(middle, "simon", { conclusion: "failure", id: 7001 })], [tip.sha]: [pushRun(tip, FIXER, { id: 7002 })] }), final: "pass" },
    { name: "red-check: one commit, its CI open", open: (s) => redCheck([tip], { [tip.sha]: openRun(s, FIXER, 7002, 100) }), settled: () => redCheck([tip], { [tip.sha]: [pushRun(tip, FIXER, { id: 7002 })] }), final: "blocked" },
    { name: "red-check: red, then the fixer's push with its CI open", open: (s) => redCheck([red, pushed], { [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 7001 })], [pushed.sha]: openRun(s, FIXER, 7002, 100) }), settled: () => redCheck([red, pushed], { [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 7001 })], [pushed.sha]: [pushRun(pushed, FIXER, { id: 7002 })] }), final: "pass" },
    // A review has no queued or in_progress state; every non-terminal state maps to a draft (PENDING) review, and none to no review.
    { name: "review: no review, or a draft (PENDING) review", open: (s) => reviewOf(s === "none" ? [] : [review("PENDING")]), settled: () => reviewOf([review("COMMENTED")]), final: "pass" },
    // A push whose run has not been created names no pusher even long after the quiet window; a queued or running run already names its actor, so it waits only for the quiet window.
    { name: "drive: the fixer's push with no workflow run yet, or one still running", open: (s) => driveOf(openRun(s, FIXER, 7400, 5).map((r) => ({ ...r, event: "push" })), s === "none" ? 3600 : 20), settled: () => driveOf([pushRun(push, FIXER, { id: 7400, event: "push" })], 120), final: "pass" },
    // @cursor/sdk RunStatus is running | finished | error | cancelled; in_progress maps to running, none to no status read.
    { name: "agent run: not ended", open: (s) => evaluateAgentRun({ status: { none: undefined, in_progress: "running" }[s] ?? s, timedOut: false, timeoutSec: 600, url: "https://cursor.com/agents/bc-1" }), settled: () => evaluateAgentRun({ status: "finished", timedOut: false, url: "https://cursor.com/agents/bc-1" }), final: "pass" },
    // GitHub lists have no pending state; every state maps to the agent's PR or comment not listed yet.
    { name: "prs (cloud agent): PR not listed yet", open: () => prOf([]), settled: () => prOf([pull]), final: "pass" },
    { name: "drive (cloud agent): factory: drive not listed yet", open: () => commentOf([]), settled: () => commentOf([comment(FIXER, "factory: drive", 5)]), final: "pass" },
    // Jira has no pending state; none maps to nothing written, the others to the comment written and the move not yet.
    { name: "Jira hop: partly written", open: (s) => hopOf(s), settled: () => hopOf("done"), final: "pass" },
  ];
  for (const row of rows) {
    for (const state of STATES) {
      const out = row.open(state);
      assert.deepEqual(Object.keys(out).sort(), ["note", "wait"], `${row.name} / ${state}: got ${out.status} (${out.reason})`);
      assert.equal(out.wait, true, `${row.name} / ${state}`);
    }
    const done = row.settled();
    assert.deepEqual([done.wait, done.status], [undefined, row.final], `${row.name} settled: ${done.reason ?? done.note}`);
  }
});

test("V27 a cloud agent's PR or comment not listed yet is a wait until the settle timeout; a wrong one is final at once", async () => {
  const missing = result("prs", "fail", "no open PR with head h", { kind: "missing" });
  const wrong = result("prs", "fail", "base is develop, expected main", { kind: "agent" });
  assert.deepEqual(settleVerdict(missing, { timedOut: false }), { wait: true, note: "no open PR with head h" });
  assert.equal(settleVerdict(missing, { timedOut: true }), missing);
  assert.equal(settleVerdict(wrong, { timedOut: false }), wrong);

  const lagging = fakeWorld();
  const listed = new Set();
  const firstReadHides = (key) => (listed.has(key) ? true : (listed.add(key), false));
  const pulls = lagging.github.pulls;
  lagging.github.pulls = async (head) => (await pulls(head)).filter((p) => firstReadHides(`pull ${p.number}`));
  const issueComments = lagging.github.issueComments;
  lagging.github.issueComments = async (number) => (await issueComments(number)).filter((c) => !isExactDriveComment(c.body) || firstReadHides(`comment ${c.id}`));
  const lines = [];
  const options = { ...parseCli(["--only", "prs,drive", "--github-timeout", "600", "--quiet", "60", "--poll", "10"]), github: "cloud-agent" };
  const rows = await runDrive({ client: { ...lagging.clock, post: lagging.post, github: readOnlyGithub(lagging.github), agents: fakeAgents(lagging).agents, log: (line) => lines.push(line) }, options, creds: AGENT_CREDS, routes: TEST_ROUTES });
  const byStep = Object.fromEntries(rows.map((r) => [r.step, r]));
  assert.deepEqual([byStep.prs.status, byStep.drive.status], ["pass", "pass"], `${byStep.prs.reason} | ${byStep.drive.reason}`);
  assert.equal(listed.size, 3);

  const idle = fakeWorld();
  const openOnly = (prompt, w) => {
    if (prompt.includes("open one pull request")) w.openPull({ title: /- title, exactly: (.+)/.exec(prompt)[1], head: /- head branch: (\S+)/.exec(prompt)[1], login: "example-user" });
  };
  const idleRows = await runDrive({ client: { ...idle.clock, post: idle.post, github: readOnlyGithub(idle.github), agents: fakeAgents(idle, { misbehave: openOnly }).agents }, options, creds: AGENT_CREDS, routes: TEST_ROUTES });
  const idleDrive = idleRows.find((r) => r.step === "drive");
  assert.deepEqual([idleDrive.status, idleDrive.kind], ["fail", "missing"]);
  assert.match(idleDrive.reason, /^no factory: drive comment on #\d+ \(https:\/\/cursor\.com\/agents\/bc-3, agent run finished, \d+s launch to verified\)$/);

  const none = fakeWorld();
  const noPr = (await runDrive({ client: { ...none.clock, post: none.post, github: readOnlyGithub(none.github), agents: fakeAgents(none, { misbehave: () => {} }).agents }, options: { ...parseCli(["--only", "prs", "--github-timeout", "600", "--poll", "10"]), github: "cloud-agent" }, creds: AGENT_CREDS, routes: TEST_ROUTES })).find((r) => r.step === "prs");
  assert.deepEqual([noPr.status, noPr.kind], ["fail", "missing"]);
  assert.match(noPr.reason, new RegExp(`^${DEFAULTS.reviewHead}: no open PR with head ${DEFAULTS.reviewHead} \\(https://cursor\\.com/agents/bc-\\d, agent run finished, \\d+s launch to verified\\); ${DEFAULTS.redHead}: no open PR with head ${DEFAULTS.redHead} \\(`));
});

test("V20 pusherOf names one pusher from push or pull_request runs, and nobody when the runs disagree or none names an actor", () => {
  const run = (id, login, seconds, event = "pull_request") => ({ id, event, actor: login === undefined ? undefined : { login }, created_at: at(seconds) });
  assert.equal(pusherOf(), undefined);
  assert.equal(pusherOf([]), undefined);
  assert.equal(pusherOf([run(1, FIXER, 5, "workflow_dispatch"), run(2, FIXER, 6, "schedule")]), undefined);
  assert.equal(pusherOf([run(1, undefined, 5), run(2, "", 6, "push")]), undefined);
  assert.equal(pusherOf([run(1, FIXER, 5), run(2, "alice", 6, "push")]), undefined);
  assert.deepEqual(pusherOf([run(9, FIXER, 20, "push"), run(4, FIXER, 10), run(7, "alice", 1, "workflow_dispatch")]), { login: FIXER, runId: "4", event: "pull_request", at: at(10) });
  assert.equal(pusherOf([{ event: "push", actor: { login: FIXER }, created_at: at(1) }]).runId, "");
});

test("V21 GitHub lists are read page by page, and the PR commits list refuses to guess past its 250-commit cap", async () => {
  const items = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }));
  const client = (pages) => {
    const urls = [];
    const send = async (method, url) => {
      urls.push(url);
      return pages[Number(new URL(url).searchParams.get("page")) - 1] ?? [];
    };
    return { urls, github: githubClient({ token: "t", repo: REPO, send }) };
  };
  const two = client([items(100), items(1, 100)]);
  assert.equal((await two.github.issueComments(12)).length, 101);
  assert.equal((await two.github.reviews(12)).at(-1).id, 100);
  assert.deepEqual(two.urls.map((url) => new URL(url).pathname + new URL(url).search), [
    `/repos/${REPO}/issues/12/comments?per_page=100&page=1`,
    `/repos/${REPO}/issues/12/comments?per_page=100&page=2`,
    `/repos/${REPO}/pulls/12/reviews?per_page=100&page=1`,
    `/repos/${REPO}/pulls/12/reviews?per_page=100&page=2`,
  ]);
  const exact = client([items(100)]);
  assert.equal((await exact.github.commits(12)).length, 100);
  assert.equal(exact.urls.length, 2);
  assert.equal((await client([items(100), items(100, 100), items(49, 200)]).github.commits(12)).at(-1).id, 248);
  await assert.rejects(client([items(100), items(100, 100), items(50, 200)]).github.commits(12), /the list reached GitHub's cap of 250 items, so its newest items cannot be read/);
  await assert.rejects(readPages(async () => items(100), { maxPages: 2 }), /the list has more than 200 items/);
  assert.equal((await readPages(async (page) => (page === 1 ? items(100) : items(5, 100)), { maxPages: 2 })).length, 105);
  assert.equal((await readPages(async (page) => items(page < 3 ? 2 : 1), { perPage: 2 })).length, 5);
});

test("V22 a GitHub row refused only for wrong actors fails the run with exit 1; one with any unknown actor stays unverified", async () => {
  const world = fakeWorld();
  world.pushers[world.shas.fix] = "alice";
  const results = await runDrive({ client: { ...world.clock, post: world.post, github: world.github }, options: parseCli(["--only", "prs,red-check", "--github-timeout", "600", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  const row = results.find((r) => r.step === "red-check");
  assert.deepEqual([row.status, row.kind], ["fail", "wrong-actor"], row.reason);
  assert.equal(summarizeResults(results).exitCode, 1);

  const unknown = fakeWorld();
  unknown.pushers[unknown.shas.fix] = "";
  const unknownRows = await runDrive({ client: { ...unknown.clock, post: unknown.post, github: unknown.github }, options: parseCli(["--only", "prs,red-check", "--github-timeout", "600", "--poll", "10"]), creds: CREDS, routes: TEST_ROUTES });
  assert.equal(unknownRows.find((r) => r.step === "red-check").status, "unverified");
  assert.equal(summarizeResults(unknownRows).exitCode, 0);
});

const NO_PUSHER_TEXT = "an unknown pusher (no push or pull_request workflow run names exactly one actor)";
const prRun = (sha, login, seconds, id = 41, extra = {}) => ({ id, event: "pull_request", status: "completed", conclusion: "success", actor: { login }, head_sha: sha, created_at: at(seconds), ...extra });
const reopenEvent = (login, seconds) => ({ event: "reopened", actor: { login }, created_at: at(seconds) });

/**
 * runDrive's drive row on a world where the fixer pushes (one pull_request
 * run as the fixer) 3 s after factory: drive. `restart`, when set, is who
 * reopened (`kind: "reopened"`) or opened (`kind: "opened"`) the review PR
 * 2 s before that push. `patch` overrides fields of the push's run.
 */
async function fixerPushDrive(restart, patch = {}) {
  const pushWorld = fakeWorld();
  let push;
  const onReview = (number) => pushWorld.pulls.find((p) => p.number === number).head.ref === DEFAULTS.reviewHead;
  const restartAt = () => new Date(Date.parse(push.commit.committer.date) - 2000).toISOString();
  const commits = pushWorld.github.commits;
  pushWorld.github.commits = async (number) => {
    const list = await commits(number);
    if (!onReview(number)) return list;
    const posted = (await pushWorld.github.issueComments(number)).find((c) => c.body === "factory: drive");
    if (posted !== undefined && push === undefined) push = { ...commit("c7", 0, "alice"), sha: "c".repeat(40), commit: { committer: { date: new Date(Date.parse(posted.created_at) + 3000).toISOString() } } };
    return [...list, ...(push === undefined ? [] : [push])];
  };
  const issueComments = pushWorld.github.issueComments;
  pushWorld.github.issueComments = async (number) => (await issueComments(number)).filter((c) => !c.body.startsWith("Driving:"));
  const runs = pushWorld.github.runs;
  pushWorld.github.runs = async (sha) => (sha === push?.sha ? [{ ...pushRun(push, FIXER, { id: 7010 }), head_sha: push.sha, ...patch }] : runs(sha));
  const active = (kind, number) => restart?.kind === kind && push !== undefined && onReview(number);
  pushWorld.github.reopens = async (number) => (active("reopened", number) ? [{ event: "reopened", actor: { login: restart.login }, created_at: restartAt() }] : []);
  const pull = pushWorld.github.pull;
  pushWorld.github.pull = async (number) => ({ ...(await pull(number)), ...(active("opened", number) ? { user: { login: restart.login }, created_at: restartAt() } : {}) });
  return (await githubRows(pushWorld, "prs,drive")).drive;
}

test("V28 a pull_request run its reopener started right after reopening the PR never names the pusher, the window tolerates 5 s of skew, a reopen or run with no parseable time never frees the run, and a run for another commit never counts", async () => {
  const fix = commit("f1", 100, "alice");
  const run = (seconds, login = FIXER, id = 41) => prRun(fix.sha, login, seconds, id);
  const of = (runs, reopens = []) => pusherOf(runs, { sha: fix.sha, reopens });
  assert.equal(of([run(203)], [reopenEvent(FIXER, 200)]), undefined);
  assert.equal(of([run(203)], [reopenEvent("Cursor[BOT]", 200)]), undefined);
  assert.equal(of([run(200)], [reopenEvent(FIXER, 200)]), undefined);
  assert.equal(of([run(800)], [reopenEvent(FIXER, 200)]), undefined);
  assert.equal(of([run(801)], [reopenEvent(FIXER, 200)]).login, FIXER);
  assert.equal(of([run(194)], [reopenEvent(FIXER, 200)]).login, FIXER);
  assert.equal(of([run(195)], [reopenEvent(FIXER, 200)]), undefined);
  assert.equal(of([run(900)], [{ event: "reopened", actor: { login: FIXER } }]), undefined);
  assert.equal(of([run(900)], [{ event: "reopened", actor: { login: FIXER }, created_at: "soon" }]), undefined);
  assert.equal(of([run(900)], [{ event: "reopened", actor: { login: "alice" } }]).login, FIXER);
  assert.equal(of([{ ...run(0), created_at: undefined }], [reopenEvent(FIXER, 200)]), undefined);
  assert.equal(of([{ ...run(900), event: "push" }], [{ event: "reopened", actor: { login: FIXER } }]).login, FIXER);
  assert.equal(of([run(203)], [reopenEvent("alice", 200)]).login, FIXER);
  assert.equal(of([{ ...run(203), event: "push" }], [reopenEvent(FIXER, 200)]).login, FIXER);
  assert.equal(of([run(203), run(150, "alice", 40)], [reopenEvent(FIXER, 200)]).login, "alice");
  assert.equal(of([run(203), run(150, "alice", 40)]), undefined);
  assert.equal(of([{ ...run(203), head_sha: "9".repeat(40) }]), undefined);
  assert.equal(of([{ ...run(203), head_sha: undefined }]).login, FIXER);
  assert.equal(pusherOf([run(203)]).login, FIXER);
  assert.equal(pusherOf([run(203)], { reopens: [reopenEvent(FIXER, 200)] }), undefined);
  assert.equal(of([{ ...run(203), event: "dynamic" }]), undefined);

  const red = commit("r1", -300, "simon");
  const redCheck = (reopens, fixRuns = [run(203)]) =>
    redCheckAt({ commits: [red, fix], ci: { [red.sha]: "red", [fix.sha]: "green" }, runs: { [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 40 })], [fix.sha]: fixRuns }, reopens, driverLogin: "simon", fixerLogins: [FIXER], timedOut: false });
  assert.equal(redCheck([]).status, "pass");
  assert.deepEqual([redCheck([reopenEvent(FIXER, 200)]).status, redCheck([reopenEvent(FIXER, 200)]).reason], ["unverified", `red on r100000, green on f100000 pushed by ${NO_PUSHER_TEXT}, so not the fixer's fix`]);
  assert.equal(redCheck([], [{ ...run(203), head_sha: "9".repeat(40) }]).status, "unverified");
  assert.deepEqual([redCheck([{ event: "reopened", actor: { login: FIXER } }], [run(900)]).status, redCheck([{ event: "reopened", actor: { login: FIXER } }], [run(900)]).reason], ["unverified", `red on r100000, green on f100000 pushed by ${NO_PUSHER_TEXT}, so not the fixer's fix`]);

  const sentinel = comment("simon", "factory: drive", 0, 1);
  const drive = (reopens, fixRuns = [run(203)]) => evaluateDrive({ sentinel, comments: [sentinel], commits: [fix], runs: { [fix.sha]: fixRuns }, reopens, driverLogin: "simon", fixerLogins: [FIXER], now: T0 + 900_000, quietMs: 60_000, timedOut: true, timeoutSec: 600 });
  assert.equal(drive([]).status, "pass");
  assert.equal(drive([reopenEvent(FIXER, 200)]).status, "unverified");
  assert.equal(drive([], [{ ...run(203), head_sha: "9".repeat(40) }]).status, "unverified");

  const world = fakeWorld();
  world.github.reopens = async (number) => (world.pulls.find((p) => p.number === number).head.ref === DEFAULTS.redHead ? [reopenEvent(FIXER, 118)] : []);
  const row = (await githubRows(world, "prs,red-check"))["red-check"];
  assert.deepEqual([row.status, row.reason], ["unverified", `red on aaaaaaa, green on bbbbbbb pushed by ${NO_PUSHER_TEXT}, so not the fixer's fix`]);

  const reopenedDrive = await fixerPushDrive({ kind: "reopened", login: FIXER });
  assert.deepEqual([reopenedDrive.status, reopenedDrive.reason], ["unverified", `no fixer comment or push within 600s of factory: drive; activity only from ${NO_PUSHER_TEXT}`]);

  const urls = [];
  const client = githubClient({ token: "t", repo: REPO, send: async (method, url) => (urls.push(url), [{ event: "closed" }, reopenEvent(FIXER, 5), { event: "labeled" }]) });
  assert.deepEqual(await client.reopens(12), [reopenEvent(FIXER, 5)]);
  assert.deepEqual(urls.map((url) => new URL(url).pathname + new URL(url).search), [`/repos/${REPO}/issues/12/events?per_page=100&page=1`]);
});

test("V30 re-runs: the pusher is the run's actor at its created_at, whoever re-ran it and whenever; the earliest of several runs per commit decides", async () => {
  const rerun = (id, actor, triggering, created, started) => ({ id, event: "pull_request", status: "completed", conclusion: "success", actor: { login: actor }, triggering_actor: { login: triggering }, run_attempt: 2, created_at: at(created), run_started_at: at(started) });
  assert.deepEqual(pusherOf([rerun(51, FIXER, "alice", 10, 500)]), { login: FIXER, runId: "51", event: "pull_request", at: at(10) });
  assert.deepEqual(pusherOf([rerun(52, "alice", FIXER, 10, 500)]).login, "alice");
  assert.deepEqual(pusherOf([rerun(62, FIXER, FIXER, 30, 30), rerun(61, FIXER, "alice", 10, 700)]), { login: FIXER, runId: "61", event: "pull_request", at: at(10) });

  const pushed = commit("c5", -100, "alice");
  assert.equal(formatEvidence(commitEvidence(pushed, pusherOf([rerun(51, FIXER, "alice", 10, 500)]), "fixer")), `commit c500000 authored as alice, pushed by cursor[bot] (actor of workflow run 51) at ${at(10)} [fixer]`);

  const red = commit("r5", -300, "simon");
  const redCheck = (runs) =>
    redCheckAt({ commits: [red, pushed], ci: { [red.sha]: "red", [pushed.sha]: "green" }, runs: { [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 70 })], [pushed.sha]: runs }, driverLogin: "simon", fixerLogins: [FIXER], since: at(0), timedOut: false });
  const during = redCheck([rerun(71, FIXER, FIXER, 50, 900)]);
  assert.deepEqual([during.status, during.reason], ["pass", "red on r500000, 1 fixer push(es), green on c500000 pushed by the fixer account cursor[bot] (actor of workflow run 71)"]);
  assert.equal(redCheck([rerun(72, FIXER, "alice", -50, 900)]).status, PRIOR_PASS);

  const world = fakeWorld();
  const runs = world.github.runs;
  world.github.runs = async (sha) => (sha === world.shas.fix ? [prRun(sha, FIXER, 130, 7003), prRun(sha, "alice", 120, 7002)] : runs(sha));
  const row = (await githubRows(world, "prs,red-check"))["red-check"];
  assert.deepEqual([row.status, row.reason], ["unverified", `red on aaaaaaa, green on bbbbbbb pushed by ${NO_PUSHER_TEXT}, so not the fixer's fix`]);

  const urls = [];
  const client = githubClient({ token: "t", repo: REPO, send: async (method, url) => (urls.push(url), { workflow_runs: [{ id: 1 }, { id: 2 }] }) });
  assert.deepEqual((await client.runs("abc")).map((r) => r.id), [1, 2]);
  assert.deepEqual(urls.map((url) => new URL(url).pathname + new URL(url).search), [`/repos/${REPO}/actions/runs?head_sha=abc&per_page=50`]);
});

test("V31 GitHub logins compare case-insensitively", () => {
  assert.equal(githubActor("cursor[bot]", { allowed: ["Cursor[bot]"] }), "pinned");
  assert.equal(githubActor("Simon", { driverLogin: "simon", allowed: ["SIMON"] }), "driver");
  assert.equal(githubActor("alice", { allowed: ["Cursor[bot]"] }), "other");
  const pushed = commit("c8", 100, "alice");
  const red = commit("r8", -300, "simon");
  const redCheck = redCheckAt({ commits: [red, pushed], ci: { [red.sha]: "red", [pushed.sha]: "green" }, runs: { [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 80 })], [pushed.sha]: [pushRun(pushed, FIXER, { id: 81 })] }, driverLogin: "simon", fixerLogins: ["CURSOR[BOT]"], timedOut: false });
  assert.equal(redCheck.status, "pass", redCheck.reason);
  const review = { id: 1, body: "## Security review\n\n**Verdict:** CLEAN", state: "COMMENTED", user: { login: FIXER, type: "Bot" }, commit_id: "e".repeat(40), submitted_at: at(10), html_url: "u" };
  assert.equal(evaluateSecurityReview({ reviews: [review], comments: [], number: 12, headSha: "e".repeat(40), driverLogin: "simon", reviewerLogins: ["Cursor[Bot]"], timedOut: false }).status, "pass");
  assert.equal(verifyAgentComment({ comments: [comment(FIXER, "factory: drive", 5)], number: 12, allowedLogins: ["Cursor[bot]"] }).status, "pass");
  const chatty = verifyAgentComment({ comments: [comment("Cursor[bot]", "factory: drive", 5, 1), comment(FIXER, "Driving: https://cursor.com/agents/bc-9", 6, 2)], number: 12, since: at(0) });
  assert.deepEqual([chatty.status, chatty.reason], ["fail", "factory: drive by Cursor[bot]: Cursor[bot] also posted 1 other comment(s)"]);
  assert.equal(pusherOf([pushRun(pushed, "Cursor[bot]", { id: 90 }), { ...pushRun(pushed, FIXER, { id: 91 }), created_at: at(200) }]).runId, "90");
  assert.equal(decideDriveComment({ comments: [comment("simon", "factory: drive", 1)], driverLogin: "Simon" }).action, "reuse");
  const sentinel = comment("simon", "factory: drive", 0, 1);
  const echo = comment("Simon", "factory: drive", 5, 2);
  assert.equal(evaluateDrive({ sentinel, comments: [sentinel, echo], commits: [], driverLogin: "simon", fixerLogins: [FIXER], now: T0 + 900_000, quietMs: 60_000, timedOut: true, timeoutSec: 600 }).kind, "missing");
  const nameless = { ...comment("x", "starting", 5, 3), user: {} };
  const agentDrive = evaluateDrive({ sentinel, comments: [sentinel, nameless], commits: [], driverLogin: undefined, fixerLogins: [FIXER], now: T0 + 900_000, quietMs: 60_000, timedOut: true, timeoutSec: 600 });
  assert.deepEqual([agentDrive.status, agentDrive.reason], ["unverified", "no fixer comment or push within 600s of factory: drive; activity only from an author with no login"]);
});

test("V32 review and red-check take the PR head from the pull request, not from the commits list order", async () => {
  const stray = { ...commit("5ab", -200, "simon"), sha: "5".repeat(40) };
  const world = fakeWorld();
  const commits = world.github.commits;
  world.github.commits = async (number) => [...(await commits(number)), stray];
  const pull = world.github.pull;
  world.github.pull = async (number) => {
    const found = await pull(number);
    return { ...found, head: { ...found.head, sha: found.head.ref === DEFAULTS.redHead ? world.shas.fix : world.shas.review } };
  };
  const runs = world.github.runs;
  world.github.runs = async (sha) => (sha === stray.sha ? [] : runs(sha));
  const byStep = await githubRows(world, "prs,review,red-check");
  assert.deepEqual([byStep.review.status, byStep["red-check"].status], ["pass", "pass"], `${byStep.review.reason} | ${byStep["red-check"].reason}`);
  assert.match(byStep.review.reason, /at the head eeeeeee$/);
  assert.match(byStep["red-check"].reason, /^red on aaaaaaa, 1 fixer push\(es\), green on bbbbbbb pushed by the fixer account cursor\[bot\] \(actor of workflow run 7002\)$/);

  const red = commit("r9", -300, "simon");
  const tip = commit("c9", 100, "simon");
  const check = (headSha, timedOut) => redCheckAt({ commits: [red, tip], headSha, ci: { [red.sha]: "red", [tip.sha]: "green" }, runs: { [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 1 })], [tip.sha]: [pushRun(tip, FIXER, { id: 2 })] }, driverLogin: "simon", fixerLogins: [FIXER], timedOut, timeoutSec: 600 });
  assert.equal(check(tip.sha, false).status, "pass");
  assert.equal(check(red.sha, false).wait, true);
  assert.deepEqual(check("9".repeat(40), false), { wait: true, note: "the PR head 9999999 is not among the 2 newest commits read yet" });
  const late = check("9".repeat(40), true);
  assert.deepEqual([late.status, late.kind, late.reason], ["fail", "missing", "the PR head 9999999 is not among the 2 newest commits read within 600s"]);

  const head = "e".repeat(40);
  const review = { id: 1, body: "## Security review\n\n**Verdict:** CLEAN", state: "COMMENTED", user: { login: FIXER, type: "Bot" }, submitted_at: at(10), html_url: "u" };
  const reviewOf = (commitId) => evaluateSecurityReview({ reviews: [{ ...review, commit_id: commitId }], comments: [], number: 12, headSha: head, driverLogin: "simon", timedOut: true, timeoutSec: 600 });
  assert.equal(reviewOf(head).status, "pass");
  assert.deepEqual([reviewOf(`${"e".repeat(7)}${"f".repeat(33)}`).status, reviewOf(`${"e".repeat(7)}${"f".repeat(33)}`).reason], ["unverified", `## Security review on #12 only from cursor[bot], but a review of eeeeeeef, not the head eeeeeeee; none by the reviewer within 600s`]);

  const urls = [];
  const client = githubClient({ token: "t", repo: REPO, send: async (method, url) => (urls.push(url), { number: 12, head: { sha: "e".repeat(40) } }) });
  assert.equal((await client.pull(12)).head.sha, "e".repeat(40));
  assert.deepEqual(urls.map((url) => new URL(url).pathname), [`/repos/${REPO}/pulls/12`]);
});

test("V33 cloud-agent mode's read-only client keeps every GitHub read and no write", () => {
  const full = githubClient({ token: "t", repo: REPO, send: async () => ({}) });
  const writes = ["createPull", "updatePull", "comment", "deleteBranch"];
  const kept = readOnly(full);
  assert.deepEqual(Object.keys(kept).sort(), Object.keys(full).filter((name) => !writes.includes(name)).sort());
  assert.ok(Object.values(kept).every((read) => typeof read === "function"));
});

test("V34 a pull_request run its opener started right after opening the PR names no pusher, like a reopen", async () => {
  assert.deepEqual(openedEvent({ number: 12, user: { login: FIXER }, created_at: at(100) }), { event: "opened", actor: { login: FIXER }, created_at: at(100) });
  assert.deepEqual(openedEvent(undefined), { event: "opened", actor: { login: undefined }, created_at: undefined });
  const green = commit("g1", 50, "alice");
  const of = (opener, openedAt) => pusherOf([prRun(green.sha, FIXER, 130)], { sha: green.sha, reopens: [openedEvent({ user: { login: opener }, created_at: at(openedAt) })] });
  assert.equal(of(FIXER, 100), undefined);
  assert.equal(of("Cursor[BOT]", 100), undefined);
  assert.equal(of("alice", 100).login, FIXER);
  assert.equal(of(FIXER, -500).login, FIXER);
  assert.equal(pusherOf([prRun(green.sha, FIXER, 130)], { sha: green.sha, reopens: [openedEvent({})] }).login, FIXER);

  const world = fakeWorld();
  const fixRun = (await world.github.runs(world.shas.fix))[0];
  const pull = world.github.pull;
  const openedBy = (login) => async (number) => {
    const found = await pull(number);
    return found.head.ref === DEFAULTS.redHead ? { ...found, user: { login }, created_at: new Date(Date.parse(fixRun.created_at) - 60_000).toISOString() } : found;
  };
  const redRow = async (login) => {
    world.github.pull = openedBy(login);
    return (await githubRows(world, "prs,red-check"))["red-check"];
  };
  const byFixer = await redRow(FIXER);
  assert.deepEqual([byFixer.status, byFixer.reason], ["unverified", `red on aaaaaaa, green on bbbbbbb pushed by ${NO_PUSHER_TEXT}, so not the fixer's fix`]);
  assert.equal((await redRow("example-user")).status, "pass");

  assert.equal((await fixerPushDrive()).status, "pass");
  const openedDrive = await fixerPushDrive({ kind: "opened", login: FIXER });
  assert.deepEqual([openedDrive.status, openedDrive.reason], ["unverified", `no fixer comment or push within 600s of factory: drive; activity only from ${NO_PUSHER_TEXT}`]);
  assert.equal((await fixerPushDrive({ kind: "opened", login: "example-user" })).status, "pass");
});

test("V35 red-check refuses, as review does, when the pull request shows no head sha", async () => {
  const red = commit("r35", -300, "simon");
  const tip = commit("c35", 100, "simon");
  const check = (timedOut) => evaluateRedCheck({ commits: [red, tip], ci: { [red.sha]: "red", [tip.sha]: "green" }, runs: { [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 1 })], [tip.sha]: [pushRun(tip, FIXER, { id: 2 })] }, driverLogin: "simon", fixerLogins: [FIXER], timedOut, timeoutSec: 600 });
  assert.deepEqual(check(false), { wait: true, note: "the PR shows no head commit yet" });
  const late = check(true);
  assert.deepEqual([late.status, late.reason], ["unverified", "the PR shows no head commit within 600s, so no commit can be taken as its head"]);

  const world = fakeWorld();
  const pull = world.github.pull;
  world.github.pull = async (number) => {
    const found = await pull(number);
    return { ...found, head: { ref: found.head.ref, repo: found.head.repo } };
  };
  const byStep = await githubRows(world, "prs,review,red-check");
  assert.deepEqual([byStep.review.status, byStep["red-check"].status], ["unverified", "unverified"]);
  assert.equal(byStep["red-check"].reason, "the PR shows no head commit within 600s, so no commit can be taken as its head");
});

test("V38 identity matrix: a workflow run counts only when its commit, branch, repository and PR are this PR's alone", async () => {
  const sha = "b".repeat(40);
  const bound = { head_sha: sha, head_branch: DEFAULTS.redHead, head_repository: { full_name: REPO }, pull_requests: [{ number: 7, head: { ref: DEFAULTS.redHead, sha }, base: { ref: "main", repo: { url: API_REPO } } }] };
  const on = (patch, pr = {}) => runOnPr({ ...bound, ...patch }, { number: 7, repo: REPO, head: DEFAULTS.redHead, sha, ...pr });
  assert.equal(on({}), true);
  assert.equal(on({ head_repository: { full_name: REPO.toUpperCase() } }), true);
  assert.equal(on({}, { sha: undefined }), false);
  assert.equal(on({}, { head: undefined }), false);
  assert.equal(on({ head_sha: "9".repeat(40) }), false);
  assert.equal(on({ head_branch: "mallory/fix" }), false);
  assert.equal(on({ head_repository: undefined }), false);
  assert.equal(on({ head_repository: { full_name: "mallory/marsbank" } }), false);
  assert.equal(on({ pull_requests: undefined }), false);
  assert.equal(on({ pull_requests: {} }), false);
  assert.equal(on({ pull_requests: [] }), false);
  assert.equal(on({ pull_requests: [null] }), false);
  assert.equal(on({ pull_requests: [{ ...bound.pull_requests[0], number: 99 }] }), false);
  assert.equal(on({ pull_requests: [{ ...bound.pull_requests[0], number: "7" }] }), false);
  assert.equal(on({ pull_requests: [bound.pull_requests[0], { ...bound.pull_requests[0], number: 99 }] }), false);
  assert.equal(on({ pull_requests: [{ ...bound.pull_requests[0], base: { ref: "main", repo: { url: "https://api.github.com/repos/mallory/marsbank" } } }] }), false);
  assert.deepEqual(bindRuns({ [sha]: [{ ...bound, id: 1 }, { ...bound, id: 2, head_branch: "x" }], ["9".repeat(40)]: [{ ...bound, id: 3 }], ["8".repeat(40)]: undefined }, { number: 7, repo: REPO, head: DEFAULTS.redHead }), { [sha]: [{ ...bound, id: 1 }], ["9".repeat(40)]: [], ["8".repeat(40)]: [] });

  const redCheckWith = async (patch, { on: target = "fix", setup = () => {}, extra = () => [] } = {}) => {
    const world = fakeWorld();
    setup(world);
    const runs = world.github.runs;
    world.github.runs = async (sha) => (sha === world.shas[target] ? [...(await runs(sha)).map((run) => ({ ...run, ...patch(run, world) })), ...extra(sha)] : runs(sha));
    return (await githubRows(world, "prs,red-check"))["red-check"];
  };
  const pr0 = (run) => run.pull_requests[0];
  const PASS = /^red on aaaaaaa, 1 fixer push\(es\), green on bbbbbbb pushed by the fixer account cursor\[bot\] \(actor of workflow run 7002\)$/;
  const NO_CI = "1 commit(s) pushed after the red one, but CI on bbbbbbb is none after 600s";
  const opener = (login, secondsBeforeRun) => (world) => {
    const pull = world.github.pull;
    world.github.pull = async (number) => {
      const found = await pull(number);
      return found.head.ref === DEFAULTS.redHead ? { ...found, user: { login }, created_at: new Date(T0 + 120_000 - secondsBeforeRun * 1000).toISOString() } : found;
    };
  };
  const matrix = [
    ["baseline", () => ({}), {}, "pass", PASS],
    ["repository in another case", () => ({ head_repository: { full_name: REPO.toUpperCase() } }), {}, "pass", PASS],
    ["another PR number", (run) => ({ pull_requests: [{ ...pr0(run), number: 99 }] }), {}, "fail", NO_CI],
    ["no associated PR", () => ({ pull_requests: [] }), {}, "fail", NO_CI],
    ["no pull_requests field", () => ({ pull_requests: undefined }), {}, "fail", NO_CI],
    ["this PR and another", (run) => ({ pull_requests: [pr0(run), { ...pr0(run), number: 99 }] }), {}, "fail", NO_CI],
    ["PR base on a fork", (run) => ({ pull_requests: [{ ...pr0(run), base: { ...pr0(run).base, repo: { url: "https://api.github.com/repos/mallory/marsbank" } } }] }), {}, "fail", NO_CI],
    ["another branch", () => ({ head_branch: "mallory/fix" }), {}, "fail", NO_CI],
    ["a fork's head repository", () => ({ head_repository: { full_name: "mallory/marsbank" } }), {}, "fail", NO_CI],
    ["no head repository", () => ({ head_repository: undefined }), {}, "fail", NO_CI],
    ["another commit", () => ({ head_sha: "9".repeat(40) }), {}, "fail", NO_CI],
    ["no head sha", () => ({ head_sha: undefined }), {}, "fail", NO_CI],
    ["same commit on a second open PR", (run, world) => ({ head_branch: "mallory/fix", pull_requests: [{ ...pr0(run), number: world.other.number, head: { ...pr0(run).head, ref: "mallory/fix" } }] }), { setup: (world) => (world.other = world.openPull({ title: "x", head: "mallory/fix" })) }, "fail", NO_CI],
    ["red run on another PR", (run) => ({ pull_requests: [{ ...pr0(run), number: 99 }] }), { on: "red" }, "fail", "CI never went red on bbbbbbb within 600s (state green)"],
    ["another PR's failed run on the fix commit", () => ({}), { extra: (sha) => [{ id: 7099, status: "completed", conclusion: "failure", event: "pull_request", actor: { login: "mallory" }, created_at: at(125), head_sha: sha, head_branch: "mallory/fix", head_repository: { full_name: REPO }, pull_requests: [{ number: 99, base: { repo: { url: API_REPO } } }] }] }, "pass", PASS],
    ["actor alice", () => ({ actor: { login: "alice" } }), {}, "fail", "red on aaaaaaa, green on bbbbbbb pushed by alice, not one of FACTORY_E2E_FIXER_LOGINS, so not the fixer's fix (wrong actor)"],
    ["actor the driver, who opened the PR", () => ({ actor: { login: "simon" } }), {}, "unverified", `red on aaaaaaa, green on bbbbbbb pushed by ${NO_PUSHER_TEXT}, so not the fixer's fix`],
    ["actor the driver, push event", () => ({ actor: { login: "simon" }, event: "push" }), {}, "fail", "red on aaaaaaa, green on bbbbbbb pushed by the driver's own login (simon), so not the fixer's fix (wrong actor)"],
    ["event push", () => ({ event: "push" }), {}, "pass", PASS],
    ["event dynamic", () => ({ event: "dynamic" }), {}, "unverified", `red on aaaaaaa, green on bbbbbbb pushed by ${NO_PUSHER_TEXT}, so not the fixer's fix`],
    ["created before the run", () => ({ created_at: "2020-01-01T00:00:00.000Z" }), {}, PRIOR_PASS, /green on bbbbbbb pushed by the fixer account cursor\[bot\]/],
    ["PR opened by the fixer 600 s before", () => ({}), { setup: opener(FIXER, 600) }, "unverified", `red on aaaaaaa, green on bbbbbbb pushed by ${NO_PUSHER_TEXT}, so not the fixer's fix`],
    ["PR opened by the fixer 601 s before", () => ({}), { setup: opener(FIXER, 601) }, "pass", PASS],
    ["PR opened by someone else 60 s before", () => ({}), { setup: opener("example-user", 60) }, "pass", PASS],
  ];
  for (const [name, patch, options, status, reason] of matrix) {
    const row = await redCheckWith(patch, options);
    assert.equal(row.status, status, `${name}: ${row.reason}`);
    if (reason instanceof RegExp) assert.match(row.reason, reason, name);
    else assert.equal(row.reason, reason, name);
  }

  const drive = async (patch) => fixerPushDrive(undefined, patch);
  const unbound = `no fixer comment or push within 600s of factory: drive; activity only from ${NO_PUSHER_TEXT}`;
  assert.equal((await drive({})).status, "pass");
  for (const patch of [{ pull_requests: [{ number: 99, base: { repo: { url: API_REPO } } }] }, { pull_requests: [] }, { head_branch: "mallory/fix" }, { head_repository: { full_name: "mallory/marsbank" } }, { head_sha: "9".repeat(40) }]) {
    const row = await drive(patch);
    assert.deepEqual([row.status, row.reason], ["unverified", unbound], JSON.stringify(patch));
  }
});

test("V39 a head that moves between the two pull request reads is a wait, and the verdict is on the head both reads agree on", () => {
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  assert.equal(headMoved(b, undefined), undefined);
  assert.equal(headMoved(b, { state: "open", head: { sha: b } }), undefined);
  assert.equal(headMoved(b, { state: "closed", head: { sha: b } }), "the PR is closed on the second read");
  assert.equal(headMoved(b, { head: { sha: b } }), "the PR is in no state on the second read");
  assert.equal(headMoved(b, { state: "open", head: {} }), "the PR shows no head commit on the second read, after bbbbbbb on the first");
  assert.equal(headMoved(b, { state: "open" }), "the PR shows no head commit on the second read, after bbbbbbb on the first");
  assert.equal(headMoved(b, { state: "open", head: { sha: c } }), "the PR head moved from bbbbbbb to ccccccc while the driver read it");
  assert.equal(headMoved(b, { state: "open", head: { sha: `${"b".repeat(9)}c${"b".repeat(30)}` } }), "the PR head moved from bbbbbbbbbb to bbbbbbbbbc while the driver read it");

  const red = commit("r39", -300, "simon");
  const fix = commit("f39", 100, "alice");
  const check = (recheck, timedOut = false) => redCheckAt({ commits: [red, fix], recheck, ci: { [red.sha]: "red", [fix.sha]: "green" }, runs: { [red.sha]: [pushRun(red, "simon", { conclusion: "failure", id: 1 })], [fix.sha]: [pushRun(fix, FIXER, { id: 2 })] }, driverLogin: "simon", fixerLogins: [FIXER], timedOut, timeoutSec: 600 });
  assert.equal(check({ state: "open", head: { sha: fix.sha } }).status, "pass");
  assert.deepEqual(check({ state: "open", head: { sha: c } }), { wait: true, note: "the PR head moved from f390000 to ccccccc while the driver read it" });
  const late = check({ state: "open", head: { sha: c } }, true);
  assert.deepEqual([late.status, late.reason], ["unverified", "the PR head moved from f390000 to ccccccc while the driver read it, still at 600s, so no read is one snapshot"]);
  assert.deepEqual([check({ state: "closed", head: { sha: fix.sha } }, true).status, check({ state: "closed", head: { sha: fix.sha } }, true).reason], ["unverified", "the PR is closed on the second read, still at 600s, so no read is one snapshot"]);

  const review = { id: 1, body: "## Security review\n\n**Verdict:** CLEAN", state: "COMMENTED", user: { login: FIXER, type: "Bot" }, commit_id: b, submitted_at: at(10), html_url: "u" };
  const reviewed = (recheck, timedOut = false, headSha = b) => evaluateSecurityReview({ reviews: [review], comments: [], number: 12, headSha: headSha ?? undefined, recheck, driverLogin: "simon", timedOut, timeoutSec: 600 });
  assert.equal(reviewed({ state: "open", head: { sha: b } }).status, "pass");
  assert.deepEqual(reviewed({ state: "open", head: { sha: c } }), { wait: true, note: "the PR head moved from bbbbbbb to ccccccc while the driver read it" });
  assert.deepEqual([reviewed({ state: "closed", head: { sha: b } }, true).status, reviewed({ state: "closed", head: { sha: b } }, true).reason], ["unverified", "the PR is closed on the second read, still at 600s, so no read is one snapshot"]);
  assert.deepEqual(reviewed({ state: "open", head: { sha: c } }, false, null), { wait: true, note: `${SECURITY_REVIEW_TEXT} on #12 only from cursor[bot], but no PR head to compare its commit with` });
});

const SECURITY_REVIEW_TEXT = "## Security review";

test("V39 runDrive: a push that lands between the head read and the commits read never passes the old head", async () => {
  const newer = { ...commit("c39", 150, "alice"), sha: "c".repeat(40) };
  const splitWorld = (newerRuns, { alternate = false } = {}) => {
    const world = fakeWorld();
    const fixed = () => world.clock.now() >= T0 + 120_000;
    const commits = world.github.commits;
    const onRed = (number) => world.pulls.find((p) => p.number === number).head.ref === DEFAULTS.redHead;
    world.github.commits = async (number) => (onRed(number) && fixed() ? [...(await commits(number)), newer] : commits(number));
    let afterFix = 0;
    const pull = world.github.pull;
    world.github.pull = async (number) => {
      const found = await pull(number);
      if (!onRed(number) || !fixed()) return found;
      const n = afterFix++;
      const first = alternate ? n % 2 === 0 : n === 0;
      return { ...found, head: { ...found.head, sha: first ? world.shas.fix : newer.sha } };
    };
    const runs = world.github.runs;
    world.github.runs = async (sha) => (sha === newer.sha ? newerRuns : runs(sha));
    return world;
  };
  const redCheck = async (world) => {
    const lines = [];
    const rows = await githubRows(world, "prs,red-check", { client: { log: (line) => lines.push(line) } });
    return { row: rows["red-check"], lines };
  };
  const MOVED = "the PR head moved from bbbbbbb to ccccccc while the driver read it";

  const mallory = await redCheck(splitWorld([pushRun(newer, "mallory", { id: 7400 })]));
  assert.deepEqual([mallory.row.status, mallory.row.kind, mallory.row.reason], ["fail", "wrong-actor", "red on aaaaaaa, green on ccccccc pushed by mallory, not one of FACTORY_E2E_FIXER_LOGINS, so not the fixer's fix (wrong actor)"]);
  assert.ok(mallory.lines.some((line) => line.endsWith(MOVED)), mallory.lines.join("\n"));

  const pending = await redCheck(splitWorld(openRun("in_progress", FIXER, 7400, 150)));
  assert.deepEqual([pending.row.status, pending.row.reason], ["fail", "2 commit(s) pushed after the red one, but CI on ccccccc is pending after 600s"]);

  const fixer = await redCheck(splitWorld([pushRun(newer, FIXER, { id: 7400 })]));
  assert.deepEqual([fixer.row.status, fixer.row.reason], ["pass", "red on aaaaaaa, 2 fixer push(es), green on ccccccc pushed by the fixer account cursor[bot] (actor of workflow run 7400)"]);

  const unsettled = await redCheck(splitWorld([pushRun(newer, FIXER, { id: 7400 })], { alternate: true }));
  assert.deepEqual([unsettled.row.status, unsettled.row.reason], ["unverified", `${MOVED}, still at 600s, so no read is one snapshot`]);

  const reviewWorld = fakeWorld();
  const onReview = (number) => reviewWorld.pulls.find((p) => p.number === number).head.ref === DEFAULTS.reviewHead;
  let reviewReads = 0;
  const reviewPull = reviewWorld.github.pull;
  reviewWorld.github.pull = async (number) => {
    const found = await reviewPull(number);
    return onReview(number) && reviewReads++ > 0 ? { ...found, head: { ...found.head, sha: "f".repeat(40) } } : found;
  };
  const reviewRows = await githubRows(reviewWorld, "prs,review");
  assert.deepEqual([reviewRows.review.status, reviewRows.review.reason], ["unverified", "## Security review on #10 only from cursor[bot], but a review of eeeeeee, not the head fffffff; none by the reviewer within 600s"]);

  const closedWorld = fakeWorld();
  const closedReads = new Map();
  const closedPull = closedWorld.github.pull;
  closedWorld.github.pull = async (number) => {
    const found = await closedPull(number);
    const n = closedReads.get(number) ?? 0;
    closedReads.set(number, n + 1);
    return n % 2 === 1 ? { ...found, state: "closed" } : found;
  };
  const closedRows = await githubRows(closedWorld, "prs,review,red-check");
  for (const step of ["review", "red-check"]) assert.deepEqual([closedRows[step].status, closedRows[step].reason], ["unverified", "the PR is closed on the second read, still at 600s, so no read is one snapshot"], step);
});

test("V40 token mode reuses a fixture PR only when it is the one open PR on its branch into main", async () => {
  const pr = (number, base, extra = {}) => ({ number, state: "open", title: DEFAULTS.reviewTitle, html_url: `u${number}`, head: { ref: DEFAULTS.reviewHead, repo: { full_name: REPO } }, base: { ref: base }, user: { login: "simon" }, ...extra });
  const decide = (pulls, extra = {}) => decidePr({ pulls, repo: REPO, head: DEFAULTS.reviewHead, base: "main", title: DEFAULTS.reviewTitle, ...extra });
  assert.deepEqual(decide([pr(7, "main")]), { action: "reuse", number: 7, url: "u7", title: DEFAULTS.reviewTitle, author: "simon" });
  assert.deepEqual(decide([pr(7, "develop"), pr(8, "main")]), { action: "duplicate", numbers: [7, 8] });
  assert.deepEqual(decide([pr(7, "main"), pr(8, "main")]), { action: "duplicate", numbers: [7, 8] });
  assert.deepEqual(decide([pr(7, "develop")]), { action: "wrong-base", number: 7, url: "u7", base: "develop" });
  assert.deepEqual(decide([pr(7, undefined)]), { action: "wrong-base", number: 7, url: "u7", base: undefined });
  assert.equal(decide([pr(7, "develop")], { base: undefined }).action, "reuse");
  assert.equal(decide([pr(7, "develop", { state: "closed" }), pr(8, "main")]).number, 8);
  assert.equal(decide([pr(7, "main", { head: { ref: DEFAULTS.reviewHead, repo: { full_name: "mallory/marsbank" } } }), pr(8, "main")]).number, 8);
  assert.equal(decide([pr(7, "main", { head: { ref: "other", repo: { full_name: REPO } } }), pr(8, "main")]).number, 8);
  assert.deepEqual(decide([pr(7, "main", { title: "Something else" })]), { action: "retitle", number: 7, url: "u7", title: DEFAULTS.reviewTitle, author: "simon" });
  assert.deepEqual(decide([pr(7, "main", { title: "Something else" })], { create: false }), { action: "reuse", number: 7, url: "u7", title: "Something else", author: "simon" });
  assert.equal(decide([pr(7, "main", { title: "Something else" })], { title: undefined }).action, "reuse");
  assert.equal(decide([pr(7, "main", { title: `${DEFAULTS.redTitlePrefix} other` })], { title: DEFAULTS.redTitle, titlePrefix: DEFAULTS.redTitlePrefix }).action, "reuse");
  assert.equal(decide([pr(7, "main", { title: "no prefix" })], { title: DEFAULTS.redTitle, titlePrefix: DEFAULTS.redTitlePrefix }).action, "retitle");
  assert.deepEqual(decide([]), { action: "create", head: DEFAULTS.reviewHead, title: DEFAULTS.reviewTitle });

  const all = "prs,review,red-check,drive";
  const twice = fakeWorld();
  twice.openPull({ title: "unrelated", head: DEFAULTS.reviewHead, base: "develop" });
  twice.openPull({ title: DEFAULTS.reviewTitle, head: DEFAULTS.reviewHead });
  twice.openPull({ title: DEFAULTS.redTitle, head: DEFAULTS.redHead, base: "develop" });
  twice.openPull({ title: DEFAULTS.redTitle, head: DEFAULTS.redHead });
  const writes = [];
  const createPull = twice.github.createPull;
  twice.github.createPull = async (input) => (writes.push("create"), createPull(input));
  const updatePull = twice.github.updatePull;
  twice.github.updatePull = async (number, patch) => (writes.push("update"), updatePull(number, patch));
  const twiceRows = await githubRows(twice, all);
  assert.deepEqual([twiceRows.prs.status, twiceRows.prs.kind], ["fail", "duplicate"]);
  assert.equal(twiceRows.prs.reason, `${DEFAULTS.reviewHead} has 2 open PRs (#10, #11); the driver needs exactly one; ${DEFAULTS.redHead} has 2 open PRs (#12, #13); the driver needs exactly one`);
  assert.deepEqual(["review", "red-check", "drive"].map((step) => [twiceRows[step].status, twiceRows[step].reason]), [
    ["blocked", `no PR to read: ${DEFAULTS.reviewHead} has 2 open PRs (#10, #11); the driver needs exactly one`],
    ["blocked", `no PR to read: ${DEFAULTS.redHead} has 2 open PRs (#12, #13); the driver needs exactly one`],
    ["blocked", `no PR to read: ${DEFAULTS.reviewHead} has 2 open PRs (#10, #11); the driver needs exactly one`],
  ]);
  assert.deepEqual(writes, []);
  assert.equal(summarizeResults(Object.values(twiceRows)).exitCode, 1);

  const wrongBase = fakeWorld();
  wrongBase.openPull({ title: DEFAULTS.reviewTitle, head: DEFAULTS.reviewHead, base: "develop" });
  const baseRows = await githubRows(wrongBase, "prs,review,red-check");
  assert.deepEqual([baseRows.prs.status, baseRows.prs.reason], ["unverified", `${DEFAULTS.reviewHead} #10 is into develop, not main; ${DEFAULTS.redHead} #11 (created)`]);
  assert.deepEqual([baseRows.review.status, baseRows.review.reason], ["blocked", `no PR to read: ${DEFAULTS.reviewHead} #10 is into develop, not main`]);
  assert.equal(baseRows["red-check"].status, "pass");

  const retitled = fakeWorld();
  retitled.openPull({ title: "unrelated", head: DEFAULTS.reviewHead });
  retitled.openPull({ title: DEFAULTS.redTitle, head: DEFAULTS.redHead });
  const titleRows = await githubRows(retitled, "prs");
  assert.deepEqual([titleRows.prs.status, titleRows.prs.reason], ["pass", `${DEFAULTS.reviewHead} #10 (reused, retitled), ${DEFAULTS.redHead} #11 (reused)`]);
  assert.equal(retitled.pulls[0].title, DEFAULTS.reviewTitle);

  const agentTwice = fakeWorld();
  agentTwice.openPull({ title: DEFAULTS.reviewTitle, head: DEFAULTS.reviewHead, base: "develop" });
  agentTwice.openPull({ title: DEFAULTS.reviewTitle, head: DEFAULTS.reviewHead });
  agentTwice.openPull({ title: DEFAULTS.redTitle, head: DEFAULTS.redHead });
  const { agents, launches } = fakeAgents(agentTwice);
  const agentRows = await githubRows(agentTwice, "prs", { client: { github: readOnlyGithub(agentTwice.github), agents }, options: { github: "cloud-agent" }, creds: AGENT_CREDS });
  assert.equal(agentRows.prs.status, "fail");
  assert.match(agentRows.prs.reason, /duplicate PRs #10, #11/);
  assert.equal(launches.length, 0);
});

test("V41 each (re)open is pinned to the commit of its own run, so a later push by the same login counts", async () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const pinnedTo = (reopen, runsBySha) => pinRestarts([reopen], runsBySha)[0].sha;
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [prRun(A, FIXER, 203)], [B]: [prRun(B, FIXER, 260)] }), A);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [B]: [prRun(B, FIXER, 260)], [A]: [prRun(A, FIXER, 203)] }), A);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [prRun(A, FIXER, 210)], [B]: [prRun(B, FIXER, 203)] }), B);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [prRun(A, FIXER, 195)] }), A);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [prRun(A, FIXER, 194)] }), undefined);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [prRun(A, FIXER, 800)] }), A);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [prRun(A, FIXER, 801)] }), undefined);
  assert.equal(pinnedTo(reopenEvent("alice", 200), { [A]: [prRun(A, FIXER, 203)] }), undefined);
  assert.equal(pinnedTo(reopenEvent("Cursor[BOT]", 200), { [A]: [prRun(A, FIXER, 203)] }), A);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [prRun(A, FIXER, 203, 41, { event: "push" })] }), undefined);
  assert.equal(pinnedTo({ event: "reopened", actor: { login: FIXER } }, { [A]: [prRun(A, FIXER, 203)] }), undefined);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [{ ...prRun(A, FIXER, 0), created_at: "soon" }] }), undefined);
  assert.equal(pinnedTo(reopenEvent(FIXER, 200), { [A]: [{ ...prRun(A, FIXER, 203), actor: undefined }] }), undefined);
  assert.deepEqual(pinRestarts([reopenEvent(FIXER, 200)], { [A]: undefined }), [{ ...reopenEvent(FIXER, 200), sha: undefined }]);
  assert.deepEqual(pinRestarts(), []);

  const pin = { ...reopenEvent(FIXER, 200), sha: A };
  const of = (run, sha, reopens = [pin]) => pusherOf([run], { sha, reopens })?.login;
  assert.equal(of(prRun(A, FIXER, 203), A), undefined);
  assert.equal(of(prRun(A, FIXER, 900), A), undefined);
  assert.equal(of(prRun(A, FIXER, 195), A), undefined);
  assert.equal(of(prRun(A, FIXER, 194), A), FIXER);
  assert.equal(of(prRun(B, FIXER, 260), B), FIXER);
  assert.equal(of(prRun(B, FIXER, 260), undefined), undefined);
  assert.equal(of(prRun(B, FIXER, 900), undefined), FIXER);
  assert.equal(of(prRun(A, FIXER, 203), A, [{ ...pin, created_at: "soon" }]), undefined);
  assert.equal(of(prRun(B, FIXER, 260), B, [{ ...pin, created_at: "soon" }]), undefined);
  assert.equal(of(prRun(A, "alice", 203), A), "alice");
  assert.equal(of({ ...prRun(A, FIXER, 203), event: "push" }, A), FIXER);

  const world = fakeWorld();
  world.pushers[world.shas.red] = FIXER;
  const pull = world.github.pull;
  world.github.pull = async (number) => {
    const found = await pull(number);
    return found.head.ref === DEFAULTS.redHead ? { ...found, user: { login: FIXER }, created_at: new Date(T0 - 62_000).toISOString() } : found;
  };
  const row = (await githubRows(world, "prs,red-check"))["red-check"];
  assert.deepEqual([row.status, row.reason], ["pass", "red on aaaaaaa, 1 fixer push(es), green on bbbbbbb pushed by the fixer account cursor[bot] (actor of workflow run 7002)"]);

  const review = commit("e41", 0, "simon");
  const pushed = commit("c41", 100, "alice");
  const sentinel = comment("simon", "factory: drive", 50, 1);
  const opened = openedEvent({ user: { login: FIXER }, created_at: at(-2) });
  const drive = (runs) => evaluateDrive({ sentinel, comments: [sentinel], commits: [review, pushed], runs, reopens: [opened], driverLogin: "simon", fixerLogins: [FIXER], now: T0 + 900_000, quietMs: 60_000, timedOut: true, timeoutSec: 600 });
  const withOpeningRun = drive({ [review.sha]: [prRun(review.sha, FIXER, 1, 50)], [pushed.sha]: [prRun(pushed.sha, FIXER, 100, 51)] });
  assert.deepEqual([withOpeningRun.status, withOpeningRun.reason], ["pass", "one drive start (push) by the fixer account cursor[bot] (actor of workflow run 51); no second drive for 60s"]);
  assert.equal(drive({ [pushed.sha]: [prRun(pushed.sha, FIXER, 100, 51)] }).status, "unverified");
});

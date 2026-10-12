#!/usr/bin/env node
// End-to-end driver for the Slack, Jira, GitHub factory. Decisions and
// verdicts are in e2e-lib.mjs; this file does the I/O through an injectable
// client so runDrive can be exercised against fakes.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { layerEnv, parseEnvFile } from "./doctor-checks.mjs";
import { createdBody, signedRequest, transitionBody } from "./jira-payload.mjs";
import { execFileSync } from "node:child_process";
import {
  agentCommentsSince,
  agentIdempotencyKey,
  annotateConnector,
  captureBaseline,
  CLOUD_AGENT,
  cleanupPlan,
  ciState,
  bindRuns,
  connectorSignal,
  DEFAULTS,
  DESK_HOPS,
  deskOutcome,
  decideAdvance,
  decideApprove,
  decideDriveComment,
  decidePr,
  decideReset,
  decideTicket,
  describeCredentials,
  driveCommentPrompt,
  evaluateAgentRun,
  evaluateDrive,
  evaluateHop,
  evaluateRedCheck,
  evaluateSecurityReview,
  GITHUB_STEPS,
  githubMode,
  isExactDriveComment,
  isSafeToDelete,
  issueEvidence,
  issueFacts,
  JIRA_HOPS,
  newTicketFields,
  openedEvent,
  openPrPrompt,
  openTicketsJql,
  parseCli,
  pickCursorKey,
  pickTransition,
  poll,
  postEvidence,
  postOutcome,
  prBody,
  prEvidence,
  PRIOR_PASS,
  priorRun,
  protectedRefs,
  readPages,
  renderReport,
  replayEvidence,
  replayTransition,
  requireEvidence,
  resolveCredentials,
  resolveRoutes,
  result,
  ROUTES,
  settleVerdict,
  sinceBaseline,
  STEPS,
  statusRank,
  summarizeResults,
  transitionEvidence,
  USAGE,
  verifyAgentComment,
  verifyAgentPr,
} from "./e2e-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const MYSELF_ATTEMPTS = 3;

const PRS_REUSED = " (already open before this run, nothing written)";

/** The newest PR commits whose workflow runs red-check and drive read: the red commit, the pushes after it, and the tip. */
const RECENT_COMMITS = 10;

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the selected steps and returns one result per step in STEPS order.
 * `client` supplies now, sleep, log, post, and optional jira and github.
 */
export async function runDrive({ client, options, creds, routes, defaults = DEFAULTS }) {
  const clock = { now: client.now, sleep: client.sleep };
  const log = client.log ?? (() => {});
  const runStart = new Date(client.now()).toISOString();
  const site = creds.jira.ok ? creds.jira.site : defaults.site;
  const results = new Map();
  const on = (step) => options.steps.has(step);
  const { jiraMs, githubMs, quietMs, pollMs, agentMs = defaults.agentTimeoutSec * 1000 } = options.timeouts;
  const set = (entry) => {
    results.set(entry.step, entry);
    log(`${entry.step}: ${entry.status}, ${entry.reason}`);
    return entry;
  };
  const waitLog = (step) => (note, elapsed) => log(`${step}: ${Math.round(elapsed / 1000)}s, ${note}`);

  const jira = client.jira;
  let key;
  let issue;
  let baseline;
  let noTicket = "no ticket: pass --ticket KEY or run the ticket step";
  const identity = { driverId: undefined, agentIds: creds.agentJiraAccounts ?? [] };
  const fetchIssue = async () => issueFacts(await jira.get(key), site);
  let hopEvidence = [];
  const move = async (to) => {
    const id = pickTransition(await jira.transitions(key), to);
    if (id === undefined) throw new Error(`${key} has no transition to ${to} from ${issue?.status ?? "its status"}`);
    const known = new Set(issue?.transitions.map((t) => t.id) ?? []);
    await jira.transition(key, id);
    issue = await fetchIssue();
    const made = issue.transitions.filter((t) => !known.has(t.id) && statusRank(t.to) === statusRank(to)).at(-1);
    if (made !== undefined) hopEvidence.push(transitionEvidence(made, identity));
    log(`${key}: the driver moved it to ${to}${made === undefined ? "" : ` (changelog ${made.id})`}`);
  };
  const withEvidence = (entry, before) => ({ ...entry, evidence: [...before, ...(entry.evidence ?? [])] });

  const replayBlocked = (hop, role) => {
    if (options.mode !== "replay") return undefined;
    if (routes[role].url === undefined) return result(hop, "blocked", `route unknown: set ${ROUTES[role].env}`);
    if (!creds.secret.ok) return result(hop, "blocked", creds.secret.reason);
    return undefined;
  };
  const replay = async (hop, role, body) => {
    const route = routes[role];
    const { rawBody, headers } = signedRequest(body, creds.secret.value);
    const at = new Date(client.now()).toISOString();
    const response = await client.post(route.url, rawBody, headers);
    hopEvidence.push(postEvidence({ slug: route.slug, status: response.status, at, error: response.error }));
    log(`${hop}: POST ${route.slug}, HTTP ${response.status}`);
    return response;
  };
  const transitionFor = (toStatus, fallbackFrom) => {
    const input = replayTransition(issue, toStatus, { now: client.now(), fallbackFrom });
    hopEvidence.push(replayEvidence(input, issue, identity));
    log(`${key}: ${input.synthesized ? "synthesized" : `real changelog ${input.changelogId} for`} ${input.fromStatus} to ${toStatus}`);
    return transitionBody({ issueKey: key, issueId: issue.id, summary: issue.summary, timestamp: client.now(), ...input });
  };

  async function ticketStep() {
    try {
      const openTickets = options.ticket !== undefined || options.newTicket ? [] : await jira.search(openTicketsJql(defaults.project, defaults.label));
      const decision = decideTicket({ ticketArg: options.ticket, openTickets, newTicket: options.newTicket, create: on("ticket") });
      if (decision.action === "missing") return;
      let how;
      if (decision.action === "create") {
        key = (await jira.create(newTicketFields({ project: defaults.project, label: defaults.label, stamp: runStart }))).key;
        how = "created";
      } else {
        key = decision.key;
        how = `reused (${decision.source})`;
      }
      issue = await fetchIssue();
      baseline = captureBaseline(issue, runStart);
      log(`${key}: baseline ${baseline.status || "?"}, ${baseline.commentIds.length} comment(s), ${baseline.transitionIds.length} status move(s) before this run`);
      if (!on("ticket")) return;
      hopEvidence = [issueEvidence(issue)];
      const reset = decideReset({ reset: options.reset, issue });
      if (reset.action === "transition") {
        await move(reset.to);
        how += ", reset to To Do";
      }
      set(result("ticket", "pass", `${key} ${how}, status ${issue.status}`, { links: [issue.url], evidence: hopEvidence, reread: decision.action === "reuse" && reset.action !== "transition" }));
    } catch (error) {
      key = undefined;
      noTicket = "no ticket (the ticket step failed)";
      if (on("ticket")) set(result("ticket", "fail", message(error), { kind: "io" }));
      else noTicket = `no ticket: ${message(error)}`;
    }
  }

  async function hop(name, role, prepare) {
    if (!on(name)) return;
    if (key === undefined) return set(result(name, "blocked", noTicket));
    const blocked = replayBlocked(name, role);
    if (blocked !== undefined) return set(blocked);
    hopEvidence = [];
    try {
      issue = await fetchIssue();
      const done = priorRun(name, issue, baseline, identity);
      if (done !== undefined) {
        return set({ ...done, status: PRIOR_PASS, reason: `${done.reason} (already done before this run, nothing sent)` });
      }
      const first = evaluateHop(name, issue, { timedOut: false, baseline, identity });
      if (!first.wait) return set(first);
      const prepared = await prepare();
      if (prepared.result !== undefined) return set(withEvidence(prepared.result, hopEvidence));
      if (options.mode === "replay") {
        const failed = postOutcome(name, routes[role].slug, await replay(name, role, prepared.body()));
        if (failed !== undefined) return set(withEvidence(failed, hopEvidence));
      }
      const sent = hopEvidence;
      const verdict = await poll({
        step: name,
        fetch: fetchIssue,
        evaluate: (facts, state) => {
          issue = facts;
          return evaluateHop(name, facts, { timedOut: state.timedOut, assumeAtlassian: options.assume.has("atlassian"), timeoutSec: jiraMs / 1000, baseline, identity });
        },
        clock,
        timeoutMs: jiraMs,
        intervalMs: pollMs,
        onWait: waitLog(name),
      });
      return set(withEvidence(verdict, sent));
    } catch (error) {
      return set(withEvidence(result(name, "fail", message(error), { kind: "io" }), hopEvidence));
    }
  }

  async function deskStep(step) {
    if (!on(step)) return;
    const { status, fallbackFrom } = DESK_HOPS[step];
    if (key === undefined) return set(result(step, "blocked", noTicket));
    const blocked = replayBlocked(step, "desk");
    if (blocked !== undefined) return set(blocked);
    hopEvidence = [];
    try {
      issue = await fetchIssue();
      if (statusRank(issue.status) < statusRank(status)) {
        return set(result(step, "blocked", `ticket is in ${issue.status}, not ${status}; nothing to announce`, { links: [issue.url] }));
      }
      const real = issue.transitions.filter((t) => statusRank(t.to) === statusRank(status)).at(-1);
      if (real !== undefined) hopEvidence.push(transitionEvidence(real, identity));
      const response = options.mode === "replay" ? await replay(step, "desk", transitionFor(status, fallbackFrom)) : undefined;
      return set(deskOutcome({ step, mode: options.mode, issue, response, slug: routes.desk.slug, evidence: hopEvidence }));
    } catch (error) {
      return set(withEvidence(result(step, "fail", message(error), { kind: "io" }), hopEvidence));
    }
  }

  async function jiraChain() {
    const steps = ["ticket", ...JIRA_HOPS].filter(on);
    if (steps.length === 0 && !on("cleanup")) return;
    if (jira === undefined) {
      for (const step of steps) set(result(step, "blocked", creds.jira.ok ? creds.jira.unavailable ?? "Jira REST unavailable" : creds.jira.reason));
      return;
    }
    let myselfError;
    for (let attempt = 1; attempt <= MYSELF_ATTEMPTS; attempt++) {
      try {
        identity.driverId = (await jira.myself()).accountId || undefined;
        myselfError = identity.driverId === undefined ? "GET /myself returned no accountId" : undefined;
      } catch (error) {
        myselfError = message(error);
      }
      if (myselfError === undefined) break;
      if (attempt < MYSELF_ATTEMPTS) {
        log(`jira: GET /myself attempt ${attempt} of ${MYSELF_ATTEMPTS} failed (${myselfError}), retrying`);
        await clock.sleep(pollMs);
      }
    }
    if (myselfError !== undefined) {
      const reason = `cannot read the driver's own Jira account (${myselfError}); without it the driver cannot tell its own writes from the agent's`;
      for (const step of steps) set(result(step, "blocked", reason));
      return;
    }
    log(`jira: the driver writes as account ${identity.driverId}; agent accounts: ${identity.agentIds.length > 0 ? `${identity.agentIds.join(", ")} (FACTORY_E2E_AGENT_JIRA_ACCOUNTS)` : "unpinned, any non-driver account"}`);
    await ticketStep();
    await hop("triage", "triage", async () => ({
      body: () => createdBody({ issueKey: key, issueId: issue.id, summary: issue.summary, description: issue.description, timestamp: client.now(), site, status: issue.status }),
    }));
    await hop("plan", "planner", async () => {
      const advance = decideAdvance({ issue, target: "Triaged", upstreamRan: on("triage") });
      if (advance.action === "transition") await move(advance.to);
      return { body: () => transitionFor("Triaged", "To Do") };
    });
    await deskStep("announce");
    await hop("approve", "worker", async () => {
      const decision = decideApprove(issue);
      if (decision.action === "blocked") return { result: result("approve", "blocked", decision.reason, { links: [issue.url] }) };
      if (decision.action === "transition") await move(decision.to);
      return { body: () => transitionFor("Approved", "Planned") };
    });
    await deskStep("progress");
  }

  const github = client.github;
  const agentMode = options.github === "cloud-agent";
  const noLauncher = agentMode && client.agents === undefined ? creds.cursor?.reason ?? "no cloud agent launcher" : undefined;
  const prs = {};
  const refusedPrs = {};
  let driverLogin;

  // Launch one cloud agent, wait for its run to end, and return what the
  // driver knows about it. GitHub, not this status, decides the step.
  async function runAgent(step, head, name, prompt) {
    const idempotencyKey = agentIdempotencyKey(step, head);
    const launched = await client.agents.launch({ name, idempotencyKey, prompt });
    log(`${step}: launched ${launched.url} for ${head} (idempotency key ${idempotencyKey})`);
    const run = await poll({
      step,
      fetch: () => client.agents.status(launched),
      evaluate: (status, state) => evaluateAgentRun({ status, timedOut: state.timedOut, timeoutSec: agentMs / 1000, url: launched.url }),
      clock,
      timeoutMs: agentMs,
      intervalMs: pollMs,
      onWait: waitLog(`${step} ${head}`),
    });
    log(`${step}: ${launched.url} ${run.reason}`);
    return { ...launched, idempotencyKey, runStatus: run.reason, endedAt: new Date(client.now()).toISOString() };
  }

  const branchState = async (head) => ({ sha: await github.branchSha(head), ahead: await github.aheadBy(defaults.base, head) });
  const settle = { clock, timeoutMs: Math.min(60_000, githubMs), intervalMs: Math.min(pollMs, 5000) };
  const agentNote = (agent, started) => (agent === undefined ? "existing, no agent launched" : `${agent.url}, ${agent.runStatus}, ${Math.round((client.now() - started) / 1000)}s launch to verified`);

  async function agentPr(fixture) {
    const started = client.now();
    const before = await branchState(fixture.head);
    const existing = decidePr({ pulls: await github.pulls(fixture.head), repo: defaults.repo, create: false, ...fixture });
    let agent;
    if (existing.action === "missing") {
      if (!on("prs")) return undefined;
      if (noLauncher !== undefined) return result("prs", "blocked", `${fixture.head}: no open PR, and opening one needs a cloud agent (${noLauncher})`);
      const prompt = openPrPrompt({ repo: defaults.repo, head: fixture.head, base: defaults.base, title: fixture.title, body: prBody(fixture.head) });
      agent = await runAgent("prs", fixture.head, `factory e2e: open PR from ${fixture.head}`, prompt);
    }
    const verdict = await poll({
      step: "prs",
      ...settle,
      fetch: async () => {
        const pulls = await github.pulls(fixture.head);
        const match = pulls.find((pull) => pull.head?.ref === fixture.head);
        return { pulls, commits: match === undefined ? [] : await github.commits(match.number), after: await branchState(fixture.head) };
      },
      evaluate: (facts, state) => settleVerdict(verifyAgentPr({ ...facts, repo: defaults.repo, head: fixture.head, base: defaults.base, title: fixture.title, titlePrefix: fixture.titlePrefix, before }), state),
    });
    const note = agentNote(agent, started);
    log(`prs: ${fixture.head} ${JSON.stringify({ ...verdict.facts, agent: agent?.url, idempotencyKey: agent?.idempotencyKey, run: agent?.runStatus, verifiedAfterSec: Math.round((client.now() - started) / 1000) })}`);
    if (verdict.facts !== undefined) prs[fixture.role] = { number: verdict.facts.number, url: verdict.facts.url, head: fixture.head, author: verdict.facts.author };
    return { ...verdict, reason: `${fixture.head}: ${verdict.reason} (${note})`, links: [...verdict.links, ...(agent === undefined ? [] : [agent.url])], reused: agent === undefined };
  }

  async function prsStep() {
    const fixtures = [
      { role: "review", head: defaults.reviewHead, title: defaults.reviewTitle, titlePrefix: undefined },
      { role: "red", head: defaults.redHead, title: defaults.redTitle, titlePrefix: defaults.redTitlePrefix },
    ];
    if (agentMode) {
      try {
        driverLogin = (await github.user()).login;
        const verdicts = (await Promise.all(fixtures.map(agentPr))).filter((verdict) => verdict !== undefined);
        if (!on("prs")) return;
        const failed = verdicts.filter((verdict) => verdict.status === "fail");
        const status = failed.length > 0 ? "fail" : verdicts.some((verdict) => verdict.status === "blocked") ? "blocked" : "pass";
        const reused = status === "pass" && verdicts.length > 0 && verdicts.every((verdict) => verdict.reused);
        set(
          result("prs", reused ? PRIOR_PASS : status, `${verdicts.map((verdict) => verdict.reason).join("; ")}${reused ? PRS_REUSED : ""}`, {
            links: verdicts.flatMap((verdict) => verdict.links),
            kind: failed[0]?.kind,
            evidence: verdicts.flatMap((verdict) => verdict.evidence ?? []),
          })
        );
      } catch (error) {
        if (on("prs")) set(result("prs", "fail", message(error), { kind: "io" }));
      }
      return;
    }
    try {
      driverLogin = (await github.user()).login;
      const notes = [];
      const evidence = [];
      const actions = [];
      const refused = [];
      for (const fixture of fixtures) {
        const decision = decidePr({ pulls: await github.pulls(fixture.head), repo: defaults.repo, base: defaults.base, create: on("prs"), ...fixture });
        if (decision.action === "missing") continue;
        if (decision.action === "duplicate" || decision.action === "wrong-base") {
          const reason =
            decision.action === "duplicate"
              ? `${fixture.head} has ${decision.numbers.length} open PRs (${decision.numbers.map((n) => `#${n}`).join(", ")}); the driver needs exactly one`
              : `${fixture.head} #${decision.number} is into ${decision.base ?? "no base"}, not ${defaults.base}`;
          refused.push({ status: decision.action === "duplicate" ? "fail" : "unverified", reason });
          refusedPrs[fixture.role] = reason;
          continue;
        }
        if (decision.action === "create") {
          const pull = await github.createPull({ title: fixture.title, head: fixture.head, base: defaults.base, body: prBody(fixture.head) });
          prs[fixture.role] = { number: pull.number, url: pull.html_url, head: fixture.head, author: pull.user?.login };
        } else {
          if (decision.action === "retitle") await github.updatePull(decision.number, { title: decision.title });
          prs[fixture.role] = { number: decision.number, url: decision.url, head: fixture.head, author: decision.author };
        }
        evidence.push(prEvidence(prs[fixture.role]));
        actions.push(decision.action);
        notes.push(`${fixture.head} #${prs[fixture.role].number} (${decision.action === "create" ? "created" : decision.action === "retitle" ? "reused, retitled" : "reused"})`);
      }
      if (refused.length > 0) {
        const duplicate = refused.some((entry) => entry.status === "fail");
        if (on("prs")) set(result("prs", duplicate ? "fail" : "unverified", [...refused.map((entry) => entry.reason), ...notes].join("; "), { links: Object.values(prs).map((pr) => pr.url), kind: duplicate ? "duplicate" : undefined }));
        return;
      }
      const reused = actions.length > 0 && actions.every((action) => action === "reuse");
      if (on("prs")) set(result("prs", reused ? PRIOR_PASS : "pass", `${notes.join(", ")}${reused ? PRS_REUSED : ""}`, { links: Object.values(prs).map((pr) => pr.url), evidence }));
    } catch (error) {
      if (on("prs")) set(result("prs", "fail", message(error), { kind: "io" }));
    }
  }

  const runsFor = async (commits, pr) => {
    const runs = {};
    for (const commit of commits) runs[commit.sha] = await github.runs(commit.sha);
    return bindRuns(runs, { number: pr.number, repo: defaults.repo, head: pr.head });
  };

  const missingPr = (step, role) => {
    const head = role === "review" ? defaults.reviewHead : defaults.redHead;
    if (prs[role] !== undefined) return undefined;
    return result(step, "blocked", refusedPrs[role] === undefined ? `no open PR for ${head}; run the prs step` : `no PR to read: ${refusedPrs[role]}`);
  };

  async function reviewStep() {
    if (!on("review")) return;
    const missing = missingPr("review", "review");
    if (missing !== undefined) return set(missing);
    const { number } = prs.review;
    set(
      await poll({
        step: "review",
        fetch: async () => {
          const headSha = (await github.pull(number)).head?.sha;
          const reviews = await github.reviews(number);
          const comments = await github.issueComments(number);
          return { reviews, comments, headSha, recheck: await github.pull(number) };
        },
        evaluate: (facts, state) =>
          evaluateSecurityReview({ ...facts, number, driverLogin, reviewerLogins: creds.reviewerLogins.length > 0 ? creds.reviewerLogins : defaults.reviewerLogins, since: runStart, timedOut: state.timedOut, timeoutSec: githubMs / 1000 }),
        clock,
        timeoutMs: githubMs,
        intervalMs: pollMs,
        onWait: waitLog("review"),
      })
    );
  }

  async function redCheckStep() {
    if (!on("red-check")) return;
    const missing = missingPr("red-check", "red");
    if (missing !== undefined) return set(missing);
    const { number } = prs.red;
    set(
      await poll({
        step: "red-check",
        fetch: async () => {
          const pull = await github.pull(number);
          const headSha = pull.head?.sha;
          const all = await github.commits(number);
          const commits = all.slice(-RECENT_COMMITS);
          const runs = await runsFor(commits, prs.red);
          const reopens = [openedEvent(pull), ...(await github.reopens(number))];
          return { commits, headSha, reopens, older: all.length - commits.length, ci: Object.fromEntries(commits.map((commit) => [commit.sha, ciState(runs[commit.sha])])), runs, recheck: await github.pull(number) };
        },
        evaluate: (facts, state) => evaluateRedCheck({ ...facts, driverLogin, fixerLogins: creds.fixerLogins, since: runStart, timedOut: state.timedOut, timeoutSec: githubMs / 1000 }),
        clock,
        timeoutMs: githubMs,
        intervalMs: pollMs,
        onWait: waitLog("red-check"),
      })
    );
  }

  async function driveStep() {
    if (!on("drive")) return;
    const missing = missingPr("drive", "review");
    if (missing !== undefined) return set(missing);
    const { number } = prs.review;
    try {
      let sentinel;
      let posted = "";
      if (agentMode) {
        const started = client.now();
        const existing = (await github.issueComments(number)).some((comment) => isExactDriveComment(comment.body));
        if (!existing && noLauncher !== undefined) return set(result("drive", "blocked", `no factory: drive on #${number}, and posting one needs a cloud agent (${noLauncher})`, { links: [prs.review.url] }));
        const since = existing ? undefined : new Date(client.now()).toISOString();
        const agent = existing ? undefined : await runAgent("drive", prs.review.head, `factory e2e: factory: drive on #${number}`, driveCommentPrompt({ repo: defaults.repo, number, url: prs.review.url }));
        const allowedLogins = creds.agentLogins.length > 0 ? creds.agentLogins : [...new Set([...CLOUD_AGENT.commentLogins, driverLogin, ...Object.values(prs).map((pr) => pr.author)].filter(Boolean))];
        const verdict = await poll({
          step: "drive",
          ...settle,
          fetch: () => github.issueComments(number),
          evaluate: (comments, state) => settleVerdict(verifyAgentComment({ comments, number, allowedLogins, since, until: agent?.endedAt }), state),
        });
        log(`drive: comment ${JSON.stringify({ ...verdict.facts, agent: agent?.url, idempotencyKey: agent?.idempotencyKey, run: agent?.runStatus, verifiedAfterSec: Math.round((client.now() - started) / 1000) })}`);
        if (verdict.status !== "pass") return set({ ...verdict, reason: `${verdict.reason} (${agentNote(agent, started)})`, links: [...verdict.links, ...(agent === undefined ? [] : [agent.url])] });
        sentinel = { id: verdict.facts.id, created_at: verdict.facts.createdAt, html_url: verdict.facts.url };
        posted = `${verdict.reason} (${agentNote(agent, started)}); `;
      } else {
        const decision = decideDriveComment({ comments: await github.issueComments(number), driverLogin });
        sentinel = decision.action === "reuse" ? decision.comment : await github.comment(number, decision.body);
        log(`drive: ${decision.action === "reuse" ? "reusing" : "posted"} factory: drive on #${number}`);
      }
      const readActivity = async () => {
        const reviews = (await github.reviews(number)).map((review) => ({ ...review, created_at: review.submitted_at }));
        const commits = (await github.commits(number)).slice(-RECENT_COMMITS);
        return { comments: [...(await github.issueComments(number)), ...reviews], commits, runs: await runsFor(commits, prs.review), reopens: [openedEvent(await github.pull(number)), ...(await github.reopens(number))] };
      };
      const verdict = await poll({
        step: "drive",
        fetch: readActivity,
        evaluate: (facts, state) =>
          evaluateDrive({ ...facts, sentinel, driverLogin: agentMode ? undefined : driverLogin, fixerLogins: creds.fixerLogins, since: runStart, now: state.now, quietMs, timedOut: state.timedOut, timeoutSec: githubMs / 1000 }),
        clock,
        timeoutMs: githubMs,
        graceMs: quietMs,
        intervalMs: pollMs,
        onWait: waitLog("drive"),
      });
      set({ ...verdict, reason: `${posted}${verdict.reason}` });
    } catch (error) {
      set(result("drive", "fail", message(error), { kind: "io" }));
    }
  }

  async function githubChain() {
    const steps = GITHUB_STEPS.filter(on);
    const cleanupNeedsPrs = on("cleanup");
    if (github === undefined || options.assume.has("github")) {
      const reason = github === undefined ? creds.github.reason : "--assume-blocked github";
      for (const step of steps) set(result(step, "blocked", reason));
      return;
    }
    if (steps.length === 0 && !cleanupNeedsPrs) return;
    await prsStep();
    await Promise.all([reviewStep(), redCheckStep(), driveStep()]);
  }

  async function cleanupStep() {
    if (!on("cleanup")) return;
    const done = [];
    const blocked = [];
    try {
      if (agentMode) {
        blocked.push("PRs left open (cloud-agent mode reads GitHub only)");
      } else if (github !== undefined) {
        const allPulls = options.cleanupBranches ? await github.allPulls() : [];
        const plan = cleanupPlan({
          prs: Object.values(prs),
          issue,
          allPulls,
          repo: defaults.repo,
          fixerLogins: creds.fixerLogins.length > 0 ? creds.fixerLogins : defaults.fixerLogins,
          cleanupBranches: options.cleanupBranches,
          protectedList: protectedRefs(defaults),
        });
        for (const number of plan.closePrs) {
          await github.updatePull(number, { state: "closed" });
          done.push(`closed #${number}`);
        }
        for (const ref of plan.deleteBranches) {
          if (!isSafeToDelete(ref, protectedRefs(defaults))) continue;
          await github.deleteBranch(ref);
          done.push(`deleted ${ref}`);
        }
      } else {
        blocked.push(`PRs left open (${creds.github.reason})`);
      }
      if (jira !== undefined && key !== undefined) {
        issue = await fetchIssue();
        if (statusRank(issue.status) !== statusRank("Done")) {
          await move("Done");
          done.push(`${key} to Done`);
        }
      } else {
        blocked.push(`ticket not moved (${key === undefined ? noTicket : creds.jira.reason})`);
      }
    } catch (error) {
      return set(result("cleanup", "fail", [...done, message(error)].join("; "), { kind: "io" }));
    }
    const reason = [...done, ...blocked].join("; ") || "nothing to clean";
    return set(result("cleanup", blocked.length > 0 ? "blocked" : "pass", reason, { links: issue === undefined ? [] : [issue.url] }));
  }

  await Promise.all([jiraChain(), githubChain()]);
  await cleanupStep();

  let agentComments = [];
  if (jira !== undefined && key !== undefined) {
    try {
      agentComments = agentCommentsSince(sinceBaseline(await fetchIssue(), baseline), runStart, identity);
    } catch {}
  }
  const ordered = STEPS.map((step) => results.get(step) ?? result(step, "skipped", options.skipReasons[step] ?? "not run"));
  return requireEvidence(annotateConnector({ results: ordered, signal: connectorSignal(agentComments, identity) }));
}

// ---------------------------------------------------------------- real I/O

class HttpError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} answered HTTP ${status}${body ? `: ${body}` : ""}`);
    this.status = status;
  }
}

async function request(method, url, { headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(method, url.replace(/\?.*$/, ""), response.status, text.replace(/\s+/g, " ").slice(0, 300));
  return text === "" ? {} : JSON.parse(text);
}

async function tenantCloudId(site) {
  const info = await request("GET", `https://${site}/_edge/tenant_info`);
  if (typeof info.cloudId !== "string" || info.cloudId === "") throw new Error(`https://${site}/_edge/tenant_info returned no cloudId`);
  return info.cloudId;
}

function jiraClient({ cloudId, email, token }) {
  const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  const headers = { authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` };
  const call = (method, path, body) => request(method, `${base}${path}`, { headers, body });
  return {
    myself: () => call("GET", "/myself"),
    get: (key) => call("GET", `/issue/${encodeURIComponent(key)}?expand=changelog&fields=summary,status,comment,project,description,created`),
    search: async (jql) => (await call("POST", "/search/jql", { jql, fields: ["summary", "status", "created"], maxResults: 10 })).issues ?? [],
    create: (fields) => call("POST", "/issue", { fields }),
    transitions: async (key) => (await call("GET", `/issue/${encodeURIComponent(key)}/transitions`)).transitions ?? [],
    transition: (key, id) => call("POST", `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id } }),
  };
}

export function githubClient({ token, repo, send = request }) {
  const base = `https://api.github.com/repos/${repo}`;
  const owner = repo.slice(0, repo.indexOf("/"));
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory-e2e-drive" };
  const call = (method, url, body) => send(method, url, { headers, body });
  const all = (path, options) => readPages((page) => call("GET", `${base}${path}?per_page=100&page=${page}`), options);
  return {
    user: () => call("GET", "https://api.github.com/user"),
    pulls: (head) => call("GET", `${base}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${head}`)}`),
    allPulls: () => call("GET", `${base}/pulls?state=all&per_page=100`),
    pull: (number) => call("GET", `${base}/pulls/${number}`),
    createPull: (input) => call("POST", `${base}/pulls`, input),
    updatePull: (number, patch) => call("PATCH", `${base}/pulls/${number}`, patch),
    reviews: (number) => all(`/pulls/${number}/reviews`),
    issueComments: (number) => all(`/issues/${number}/comments`),
    commits: (number) => all(`/pulls/${number}/commits`, { cap: 250 }),
    reopens: async (number) => (await all(`/issues/${number}/events`)).filter((event) => event.event === "reopened"),
    runs: async (sha) => (await call("GET", `${base}/actions/runs?head_sha=${sha}&per_page=50`)).workflow_runs ?? [],
    branchSha: async (ref) => (await call("GET", `${base}/branches/${ref.split("/").map(encodeURIComponent).join("/")}`)).commit.sha,
    aheadBy: async (baseRef, head) => (await call("GET", `${base}/compare/${encodeURIComponent(baseRef)}...${head.split("/").map(encodeURIComponent).join("/")}`)).ahead_by,
    comment: (number, body) => call("POST", `${base}/issues/${number}/comments`, { body }),
    deleteBranch: (ref) => call("DELETE", `${base}/git/refs/heads/${ref.split("/").map(encodeURIComponent).join("/")}`),
  };
}

const GITHUB_READS = ["user", "pulls", "allPulls", "pull", "reviews", "issueComments", "commits", "reopens", "runs", "branchSha", "aheadBy"];

/** The GitHub client without its write methods, so cloud-agent mode cannot write with the driver's token. */
export function readOnly(client) {
  return Object.fromEntries(GITHUB_READS.map((name) => [name, client[name]]));
}

/** A read token for cloud-agent mode: FACTORY_E2E_GITHUB_TOKEN, else the `gh` keyring login. Never printed. */
function githubReadCreds(env) {
  const explicit = String(env.FACTORY_E2E_GITHUB_TOKEN ?? "").trim();
  if (explicit !== "") return { ok: true, name: "FACTORY_E2E_GITHUB_TOKEN", token: explicit, readOnly: true };
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (token !== "") return { ok: true, name: "gh auth token", token, readOnly: true };
  } catch {}
  return { ok: false, reason: "set FACTORY_E2E_GITHUB_TOKEN or run `gh auth login` (read access is enough)" };
}

const julyCredentials = join(root, "factory-worker", "node_modules", "@cursor", "july", "dist", "internal", "cursor", "credentials.js");
const cursorSdk = join(root, "factory-worker", "node_modules", "@cursor", "sdk", "dist", "esm", "index.js");

/** The stored `agent-sdk login` key, resolved the way @cursor/july does with every env key source removed first. */
async function cursorKeyCreds(env) {
  for (const name of ["CURSOR_API_KEY", "CURSOR_API_KEY_FILE", "CURSOR_SERVICE_ACCOUNT_KEY"]) delete process.env[name];
  if (String(env.FACTORY_E2E_CURSOR_API_KEY ?? "").trim() !== "") return pickCursorKey({ env });
  if (!existsSync(julyCredentials)) return { ok: false, reason: "run npm install in factory-worker (needs @cursor/july for the stored login)" };
  const { resolveApiKey } = await import(pathToFileURL(julyCredentials).href);
  return pickCursorKey({ env, stored: await resolveApiKey() });
}

/** One cloud agent per GitHub write, through @cursor/sdk the way factory-worker launches implementations. */
async function cloudAgents(apiKey) {
  if (!existsSync(cursorSdk)) throw new Error("run npm install in factory-worker (needs @cursor/sdk)");
  const { Agent } = await import(pathToFileURL(cursorSdk).href);
  return {
    launch: async ({ name, idempotencyKey, prompt }) => {
      const agent = await Agent.create({
        apiKey,
        name,
        idempotencyKey,
        model: CLOUD_AGENT.model,
        cloud: { repos: [{ url: CLOUD_AGENT.repoUrl, startingRef: CLOUD_AGENT.startingRef }], autoCreatePR: CLOUD_AGENT.autoCreatePR },
      });
      try {
        const run = await agent.send(prompt);
        return { agentId: agent.agentId, runId: run.id, url: `https://cursor.com/agents/${agent.agentId}` };
      } finally {
        agent.close();
      }
    },
    status: async ({ agentId, runId }) => (await Agent.getRun(runId, { runtime: "cloud", agentId, apiKey })).status,
  };
}

async function postWebhook(url, rawBody, headers) {
  try {
    const response = await fetch(url, { method: "POST", headers, body: rawBody, signal: AbortSignal.timeout(30_000) });
    await response.text();
    return { status: response.status };
  } catch (error) {
    return { status: 0, error: message(error) };
  }
}

function loadEnv() {
  const files = [".env.local", ".env"]
    .map((name) => join(root, name))
    .filter((path) => existsSync(path))
    .map((path) => parseEnvFile(readFileSync(path, "utf8")));
  return layerEnv({ ...process.env }, ...files);
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.error !== undefined) {
    console.error(`${options.error}\n\n${USAGE}`);
    return 2;
  }
  const env = loadEnv();
  const docPath = join(root, "docs", "jira-webhooks.md");
  const routes = resolveRoutes(env, existsSync(docPath) ? readFileSync(docPath, "utf8") : "");
  const creds = resolveCredentials(env);
  options.github = githubMode({ flag: options.githubFlag, env });
  const agentMode = options.github === "cloud-agent";
  let agents;
  if (agentMode) {
    creds.github = githubReadCreds(env);
    creds.cursor = await cursorKeyCreds(env);
    if (creds.cursor.ok) {
      try {
        agents = await cloudAgents(creds.cursor.apiKey);
      } catch (error) {
        creds.cursor = { ok: false, reason: message(error) };
      }
    }
  }
  for (const line of describeCredentials(creds, routes)) console.log(line);
  console.log(`mode: ${options.mode}; github: ${options.github}; steps: ${[...options.steps].join(", ")}`);

  let jira;
  if (creds.jira.ok) {
    try {
      const cloudId = creds.jira.cloudId ?? (await tenantCloudId(creds.jira.site));
      jira = jiraClient({ cloudId, email: creds.jira.email, token: creds.jira.token });
    } catch (error) {
      creds.jira.unavailable = `Jira cloud id lookup failed: ${message(error)}`;
    }
  }
  const client = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(`  ${new Date().toISOString().slice(11, 19)} ${line}`),
    post: postWebhook,
    jira,
    github: creds.github.ok ? (agentMode ? readOnly : (full) => full)(githubClient({ token: creds.github.token, repo: DEFAULTS.repo })) : undefined,
    agents,
  };
  const startedAt = new Date(client.now()).toISOString();
  const results = await runDrive({ client, options, creds, routes });
  console.log("");
  console.log(renderReport(startedAt, results));
  return summarizeResults(results).exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}

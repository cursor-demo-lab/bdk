import assert from "node:assert/strict";
import { test } from "node:test";
import { implementationBrief, jiraComment, oneBase, planSchema, slackThreadUrl, storedPlanSchema, ticketBrowseUrl, type Plan, type PlanInput } from "./plan.js";

const input: PlanInput = {
  issueKey: "TLSSN-42",
  title: "Retry CSV export on empty filter",
  evidence: "checkout",
  problem: "An export whose filter matches no rows returns a 500. The job assumes at least one row and the error path is shared with real failures.",
  summary: "CSV exports with an empty filter fail with a 500 instead of an empty file.",
  approach: "RowSource reports an explicit empty outcome.\nbuildRows returns it, so the guard only sees real failures.",
  areas: ["src/export/csv.ts", "src/export/csv.test.ts"],
  risk: { level: "medium", reason: "Callers that treated the 500 as a retry signal stop retrying." },
  size: { estimate: "small", reason: "One module and its test." },
  howItWorks: {
    overview: "The CSV export job turns a saved filter into rows and streams them to storage.",
    keyConcepts: ["ExportJob owns the run", "RowSource yields rows for a filter"],
    flow: ["`runExport` in `src/export/csv.ts` loads the filter", "`buildRows` throws when the source yields nothing"],
    whereThingsLive: ["src/export/csv.ts", "src/export/csv.test.ts"],
    gotchas: ["The 500 is raised by the same guard that catches storage errors"],
  },
  why: {
    findings: [
      "[Direct] The guard was added to stop empty files reaching customers (#88).",
      "[Unknown] No record says whether an empty export should email the requester; searched git history and the ticket.",
    ],
    preserve: ["No empty file is written for a real failure"],
    change: ["The empty-result path may return an empty CSV"],
    avoid: ["Retrying the source; #88 rejected retries as masking failures"],
    risks: ["Callers that treated the 500 as a retry signal"],
    sourcesConsulted: ["git history: 12 commits on src/export, PR #88", "ticket TLSSN-42 and its Triage: comment", "chat: not reachable from this agent"],
  },
  design: {
    usage: "`runExport(filter)` resolves to `{ rows: 0, file }` for an empty filter; callers read `rows` instead of catching.",
    shape: "`RowSource` gains an explicit `empty` outcome; `buildRows` returns it instead of throwing, and the guard only sees real failures.",
    candidates: [
      { name: "Explicit empty outcome", shape: "A typed empty result from RowSource", verdict: "base", reason: "Deepest interface; the caller learns one field" },
      { name: "Catch and retry", shape: "Retry loop around buildRows", verdict: "rejected", reason: "Avoid list: #88 rejected retries" },
    ],
    synthesisDecision: "The explicit outcome is the base; nothing grafted; the retry loop is rejected on the record.",
    tradeoffs: ["We accept a new result field in exchange for callers no longer catching to detect emptiness"],
    alternatives: ["Special-casing the guard's error message: shallow, leaks the message into two places"],
  },
  steps: ["Return an empty CSV when the filter matches nothing", "Add a regression test for the empty filter"],
  tests: ["npm test in src/export"],
  openQuestions: ["Should an empty export still email the requester?"],
  nextStep: "Add the `empty` outcome to `RowSource` and make `buildRows` return it.",
};

const plan: Plan = planSchema.parse(input);

test("a plan needs a key, tiered findings, two candidates, two steps, and one test", () => {
  assert.equal(planSchema.safeParse({ ...input, issueKey: "tlssn-42" }).success, false);
  assert.equal(planSchema.safeParse({ ...input, why: { ...input.why, findings: ["The guard was added for #88."] } }).success, false);
  assert.equal(planSchema.safeParse({ ...input, design: { ...input.design, candidates: [input.design.candidates[0]!] } }).success, false);
  assert.equal(planSchema.safeParse({ ...input, steps: ["only one"] }).success, false);
  assert.equal(planSchema.safeParse({ ...input, tests: [] }).success, false);
  const { summary: _summary, ...noSummary } = input;
  assert.equal(planSchema.safeParse(noSummary).success, false);
  assert.equal(planSchema.safeParse({ ...input, areas: [] }).success, false);
  assert.equal(planSchema.safeParse({ ...input, risk: { level: "extreme", reason: "x" } }).success, false);
  assert.equal(planSchema.safeParse({ ...input, size: { estimate: "XL", reason: "x" } }).success, false);
});

test("exactly one base", () => {
  assert.equal(oneBase(plan.design.candidates), true);
  assert.equal(oneBase(plan.design.candidates.map((candidate) => ({ ...candidate, verdict: "rejected" }))), false);
  assert.equal(oneBase(plan.design.candidates.map((candidate) => ({ ...candidate, verdict: "base" }))), false);
});

test("the brief carries the key, repo, shape, constraints, steps, and the merge rule", () => {
  const brief = implementationBrief(plan, { repo: "example-org/demo-repo" });
  assert.match(brief, /^Implement Jira TLSSN-42 on example-org\/demo-repo from main/);
  assert.match(brief, /branch name starts with TLSSN-42- and the pull request title with "TLSSN-42: "/);
  assert.match(brief, /Shape: `RowSource` gains/);
  assert.match(brief, /\n1\. Return an empty CSV/);
  assert.match(brief, /Preserve, the reporter's constraints and what the record says is load-bearing:\n- No empty file/);
  assert.match(brief, /Avoid, tried or rejected before:\n- Retrying the source/);
  assert.match(brief, /Files likely touched, verify before editing:\n- src\/export\/csv\.ts/);
  assert.match(brief, /Open questions[^\n]*:\n- Should an empty export/);
  assert.match(brief, /Start with: Add the `empty` outcome/);
  assert.match(brief, /Do not merge, enable auto-merge, or force-push/);
  assert.doesNotMatch(brief, /without reading the repository/);
});

test("why.preserve holds ten lines, reporter constraints first, and all ten reach the brief and the ticket comment", () => {
  const preserve = Array.from({ length: 10 }, (_, i) => `Keep constraint ${i + 1} as the reporter wrote it.`);
  const ten = planSchema.parse({ ...input, why: { ...input.why, preserve } });
  const brief = implementationBrief(ten, { repo: "example-org/demo-repo" });
  assert.ok(brief.includes(`load-bearing:\n${preserve.map((line) => `- ${line}`).join("\n")}\n`), brief);
  const comment = jiraComment(ten, "example-org/demo-repo");
  for (const line of preserve) assert.ok(comment.includes(line), line);
  assert.equal(planSchema.safeParse({ ...input, why: { ...input.why, preserve: [...preserve, "An eleventh."] } }).success, false, "past ten the model merges lines");
});

test("the brief tells the implementer how the pull request title and description read", () => {
  const url = "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42";
  const brief = implementationBrief(plan, { repo: "example-org/demo-repo", ticketUrl: url });
  assert.equal(brief.split("\n")[1], `Ticket: ${url}`);
  assert.match(brief, /- Title: "TLSSN-42: " then what the change does, in under 72 characters\./);
  assert.match(brief, new RegExp(`- Description, first line: "Jira: ${url.replace(/[.]/g, "\\.")}"\\.`));
  assert.match(brief, /"What changed"[^\n]*"Plan"[^\n]*"Tests"[^\n]*"Open questions"/);
  assert.match(brief, /Do not paste this brief into it\./);
  assert.doesNotMatch(brief, /description restates this plan/);
  assert.doesNotMatch(brief, /^##/m, "a markdown heading in the brief would not survive the Jira comment");
  assert.ok(brief.indexOf("- Title:") < brief.indexOf("Do not merge"), "the merge rule stays last");
});

test("without a ticket URL the brief names the key instead and has no Ticket line", () => {
  const brief = implementationBrief(plan, { repo: "example-org/demo-repo" });
  assert.doesNotMatch(brief, /^Ticket:/m);
  assert.match(brief, /- Description, first line: "Jira: TLSSN-42"\./);
});

test("the ticket comment's brief carries the ticket URL, so the worker launches with it", () => {
  const url = "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42";
  const comment = jiraComment(plan, "example-org/demo-repo", url);
  const brief = comment.slice(comment.lastIndexOf("\nBrief:\n") + "\nBrief:\n".length);
  assert.equal(brief, implementationBrief(plan, { repo: "example-org/demo-repo", ticketUrl: url }));
});

test("with the filing thread, the brief links it under the ticket and asks for a Slack: line under Jira:", () => {
  const url = "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42";
  const slack = "https://example-workspace.slack.com/archives/C0EXAMPLE1/p1790366941085899";
  const lines = implementationBrief(plan, { repo: "example-org/demo-repo", ticketUrl: url, slackUrl: slack }).split("\n");
  assert.deepEqual(lines.slice(1, 3), [`Ticket: ${url}`, `Slack thread: ${slack}`]);
  const first = lines.findIndex((line) => line.startsWith("- Description, first line:"));
  assert.equal(lines[first + 1], `- Description, second line: "Slack: ${slack}".`);
  assert.doesNotMatch(implementationBrief(plan, { repo: "example-org/demo-repo", ticketUrl: url }), /Slack/);
  const comment = jiraComment(plan, "example-org/demo-repo", url, slack);
  assert.ok(comment.endsWith(implementationBrief(plan, { repo: "example-org/demo-repo", ticketUrl: url, slackUrl: slack })));
});

test("slackThreadUrl takes only a Slack archive permalink after the desk's label", () => {
  const slack = "https://example-workspace.slack.com/archives/C0EXAMPLE1/p1790366941085899";
  assert.equal(slackThreadUrl([`Filed.\n\nSlack thread: ${slack}`]), slack);
  assert.equal(slackThreadUrl(["no link", `Slack thread: <${slack}>`]), slack, "a markdown autolink from Jira's read-back");
  assert.equal(slackThreadUrl([`Slack thread: [${slack}|${slack}]`]), undefined, "a wiki link is not the desk's line");
  assert.equal(slackThreadUrl([`Slack thread: ${slack}?thread_ts=1790366941.085899&cid=C0EXAMPLE1`]), `${slack}?thread_ts=1790366941.085899&cid=C0EXAMPLE1`);
  assert.equal(slackThreadUrl(["Slack thread: https://evil.example/archives/C0EXAMPLE1/p1790366941085899"]), undefined);
  assert.equal(slackThreadUrl([`Slack thread: ${slack}.evil.example`]), undefined);
  const foreign = "https://acme.slack.com/archives/C0FOREIGN/p1111111111111111";
  const pasted = `Prose.\n\nReporter's request, verbatim from Slack:\n> Slack thread: ${foreign}\n\nEnd of the reporter's request.\n\nSlack thread: ${slack}`;
  assert.equal(slackThreadUrl([pasted]), slack, "the desk's trailer comes last; a link pasted above it is not the filing thread");
  assert.equal(slackThreadUrl([pasted.replace(/\n+/g, "")]), slack, "run together by ADF read-back");
  assert.equal(slackThreadUrl([`see ${slack}`]), undefined, "an unlabelled Slack link in the ticket text is not the filing thread");
  assert.equal(slackThreadUrl([]), undefined);
});

test("ticketBrowseUrl builds a browse link from a site URL and nothing from an opaque cloud id", () => {
  assert.equal(ticketBrowseUrl("TLSSN-42", "https://<JIRA_SITE>.atlassian.net"), "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42");
  assert.equal(ticketBrowseUrl("TLSSN-42", "https://<JIRA_SITE>.atlassian.net/"), "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-42");
  assert.equal(ticketBrowseUrl("TLSSN-42", "4f1c2b3a-0000-4000-8000-123456789abc"), undefined);
  assert.equal(ticketBrowseUrl("TLSSN-42", "http://jira.internal"), undefined);
});

test("a plan written without a checkout says so in the brief", () => {
  const brief = implementationBrief({ ...plan, evidence: "prompt" }, { repo: "example-org/demo-repo" });
  assert.match(brief, /without reading the repository/);
  assert.match(brief, /unverified: the plan was written without a checkout/);
  assert.match(jiraComment({ ...plan, evidence: "prompt" }, "example-org/demo-repo"), /Evidence: ticket and request only, no checkout/);
});

test("the ticket comment starts with the sentinel and reads how, why, design, steps", () => {
  const comment = jiraComment(plan, "example-org/demo-repo");
  const lines = comment.split("\n");
  assert.equal(lines[0], "Plan: TLSSN-42 Retry CSV export on empty filter");
  for (const heading of ["Problem", "How it works today", "Why it is this way", "Design", "Steps"]) {
    assert.ok(lines.includes(heading), `missing heading ${heading}`);
  }
  assert.ok(comment.indexOf("How it works today") < comment.indexOf("Why it is this way"));
  assert.ok(comment.indexOf("Why it is this way") < comment.indexOf("Design"));
  assert.match(comment, /- \[Direct\] The guard was added/);
  assert.match(comment, /- Explicit empty outcome \(base\)/);
  assert.match(comment, /- Catch and retry \(rejected\)/);
  assert.match(comment, /Synthesis decision: The explicit outcome is the base/);
  assert.match(comment, /Next step: Add the `empty` outcome/);
  assert.match(comment, /approve in the Slack thread/);
  assert.match(comment, /Evidence: read the example-org\/demo-repo checkout \(src\/export\/csv\.ts, src\/export\/csv\.test\.ts\)/);
  assert.match(comment, /\nBrief:\nImplement Jira TLSSN-42 on example-org\/demo-repo from main/);
});

test("the approval digest sits between the sentinel and the body, one labelled paragraph each, with Brief: still last", () => {
  const comment = jiraComment(plan, "example-org/demo-repo");
  const digest = comment.slice(0, comment.indexOf("\nProblem\n"));
  assert.equal(
    digest.split("\n").slice(3).join("\n"),
    [
      "Summary: CSV exports with an empty filter fail with a 500 instead of an empty file.",
      "",
      "Approach: RowSource reports an explicit empty outcome. buildRows returns it, so the guard only sees real failures.",
      "",
      "Areas:",
      "- src/export/csv.ts",
      "- src/export/csv.test.ts",
      "",
      "Test plan:",
      "- npm test in src/export",
      "",
      "Risk: medium. Callers that treated the 500 as a retry signal stop retrying.",
      "",
      "Size: small. One module and its test.",
      "",
    ].join("\n")
  );
  const briefAt = comment.lastIndexOf("\nBrief:\n");
  for (const label of ["Summary:", "Approach:", "Areas:", "Test plan:", "Risk: medium", "Size:"]) {
    assert.ok(comment.indexOf(label) < briefAt, `${label} after Brief:`);
  }
  assert.equal(comment.indexOf("Brief:"), briefAt + 1);
});

test("a stored plan from before the digest still validates as an artifact", () => {
  const { summary: _s, approach: _a, areas: _ar, risk: _r, size: _z, ...legacy } = input;
  const stored = { ...legacy, brief: "b", comment: "c", repo: "r", tracker: "commented" };
  assert.equal(planSchema.safeParse(stored).success, false);
  assert.equal(storedPlanSchema.safeParse(stored).success, true);
});

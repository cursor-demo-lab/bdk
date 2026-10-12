import assert from "node:assert/strict";
import { test } from "node:test";
import { backlinkComment } from "../factory-desk/agent/lib/slack-link.ts";
import { implementationBrief, planSchema, slackThreadUrl } from "../planner/agent/lib/plan.ts";
import { briefLinks, withTicketLinks } from "../factory-worker/agent/lib/pr-links.ts";

// The desk writes `Slack thread:` onto the ticket (the description for a
// Slack filing, a comment for a Jira filing's intake root); the planner
// reads it into the brief's Ticket: and Slack thread: lines; the worker
// reads them back to put Jira: and Slack: at the top of the implement PR's
// description. Separate projects, so this is where the writer meets the reader.

const JIRA = "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-28";
const SLACK = "https://<SLACK_WORKSPACE>.slack.com/archives/C0EXAMPLE1/p1790370261284789?thread_ts=1790370261.284789&cid=C0EXAMPLE1";

const plan = planSchema.parse({
  issueKey: "TLSSN-28",
  title: "Transfers page shows stale balance",
  evidence: "checkout",
  problem: "The balance does not refresh after a transfer settles.",
  summary: "Refetch the balance when a transfer settles.",
  approach: "The transfer hook invalidates the balance query.",
  areas: ["src/transfers/useTransfer.ts"],
  risk: { level: "low", reason: "One query key." },
  size: { estimate: "small", reason: "One hook and its test." },
  howItWorks: { overview: "o", keyConcepts: ["k"], flow: ["f"], whereThingsLive: ["src/transfers/useTransfer.ts"], gotchas: ["g"] },
  why: { findings: ["[Direct] The balance is cached per session."], preserve: ["p"], change: ["c"], avoid: ["a"], risks: ["r"], sourcesConsulted: ["git history"] },
  design: {
    usage: "u",
    shape: "s",
    candidates: [
      { name: "Invalidate", shape: "invalidate the query", verdict: "base", reason: "smallest" },
      { name: "Poll", shape: "poll the balance", verdict: "rejected", reason: "load" },
    ],
    synthesisDecision: "d",
    tradeoffs: ["t"],
    alternatives: ["a"],
  },
  steps: ["Invalidate the balance query on settle", "Add a test"],
  tests: ["npm test"],
  openQuestions: ["None"],
  nextStep: "Edit useTransfer.",
});

test("the worker reads the planner's brief links and the TLSSN-28 description gains its Slack line", () => {
  const brief = implementationBrief(plan, { repo: "cursor-demo-lab/marsbank", ticketUrl: JIRA, slackUrl: SLACK });
  const links = briefLinks(brief, "TLSSN-28");
  assert.deepEqual(links, { jira: JIRA, slack: SLACK });
  const before = `Jira: ${JIRA}\n\n## What changed\n- Refetch the balance`;
  const after = withTicketLinks(before, { issueKey: "TLSSN-28", links });
  assert.deepEqual(after?.split("\n").slice(0, 3), [`Jira: ${JIRA}`, `Slack: ${SLACK}`, ""]);
  assert.ok(brief.includes(`- Description, second line: "Slack: ${SLACK}".`), "the worker writes the line the brief asks for");
});

test("a Jira-filed ticket's intake backlink comment reaches the brief and the PR description like a Slack filing's line", () => {
  const intake = "https://<SLACK_WORKSPACE>.slack.com/archives/C0EXAMPLE1/p1790370300000001";
  const description = "Filed by hand in Jira. No Slack line here.";
  const slackUrl = slackThreadUrl([description, "Triage: bug\nSeverity: high", backlinkComment(intake)]);
  assert.equal(slackUrl, intake);
  const brief = implementationBrief(plan, { repo: "cursor-demo-lab/marsbank", ticketUrl: JIRA, slackUrl });
  const links = briefLinks(brief, "TLSSN-28");
  assert.deepEqual(links, { jira: JIRA, slack: intake });
  assert.deepEqual(withTicketLinks(`Jira: ${JIRA}`, { issueKey: "TLSSN-28", links })?.split("\n").slice(0, 2), [`Jira: ${JIRA}`, `Slack: ${intake}`]);
});

test("a ticket filed without a Slack thread gives the worker nothing to add", () => {
  const brief = implementationBrief(plan, { repo: "cursor-demo-lab/marsbank", ticketUrl: JIRA });
  assert.deepEqual(briefLinks(brief, "TLSSN-28"), { jira: JIRA });
  assert.equal(withTicketLinks(`Jira: ${JIRA}`, { issueKey: "TLSSN-28", links: briefLinks(brief, "TLSSN-28") }), undefined);
});

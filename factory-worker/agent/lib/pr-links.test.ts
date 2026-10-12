import assert from "node:assert/strict";
import { test } from "node:test";
import { briefLinks, withTicketLinks } from "./pr-links.js";

const JIRA = "https://<JIRA_SITE>.atlassian.net/browse/TLSSN-28";
const SLACK = "https://<SLACK_WORKSPACE>.slack.com/archives/C0EXAMPLE1/p1790370261284789?thread_ts=1790370261.284789&cid=C0EXAMPLE1";
const LINKS = { jira: JIRA, slack: SLACK };

const BRIEF = [
  "Implement Jira TLSSN-28 on cursor-demo-lab/marsbank from main: Transfers page shows stale balance",
  `Ticket: ${JIRA}`,
  `Slack thread: ${SLACK}`,
  'The branch name starts with TLSSN-28- and the pull request title with "TLSSN-28: ".',
  "",
  "Problem: The balance does not refresh after a transfer.",
].join("\n");

// cursor-demo-lab/marsbank#25 as the agent opened it on TLSSN-28.
const TLSSN_28_BODY = [`Jira: ${JIRA}`, "", "## What changed", "- Refetch the balance after a transfer settles", "", "## Tests", "- npm test"].join("\n");

test("briefLinks reads the Ticket and Slack thread lines the planner writes", () => {
  assert.deepEqual(briefLinks(BRIEF, "TLSSN-28"), LINKS);
  assert.deepEqual(briefLinks(BRIEF.replace(`Slack thread: ${SLACK}`, `Slack thread: <${SLACK}>`), "TLSSN-28"), LINKS, "a Jira autolink read-back");
  assert.deepEqual(briefLinks(BRIEF.replace(`Slack thread: ${SLACK}`, `Slack thread: [${SLACK}](${SLACK})`), "TLSSN-28"), LINKS, "a markdown link read-back");
  assert.deepEqual(briefLinks(BRIEF.replace(/\n/g, "\r\n"), "TLSSN-28"), LINKS);
});

test("briefLinks takes only a Slack archive permalink and this key's browse URL, from the brief's opening block", () => {
  assert.deepEqual(briefLinks(BRIEF.replace(SLACK, "https://evil.example/archives/C0EXAMPLE1/p1790370261284789"), "TLSSN-28"), { jira: JIRA });
  assert.deepEqual(briefLinks(BRIEF.replace(SLACK, `${SLACK.split("?")[0]}.evil.example`), "TLSSN-28"), { jira: JIRA });
  assert.deepEqual(briefLinks(BRIEF, "TLSSN-2"), { slack: SLACK }, "another ticket's browse URL");
  const late = ["Implement Jira TLSSN-28 on cursor-demo-lab/marsbank from main: x", "", `Problem: see Slack thread: ${SLACK}`, `Ticket: ${JIRA}`].join("\n");
  assert.deepEqual(briefLinks(late, "TLSSN-28"), {}, "ticket text after the opening block is not the planner's line");
  assert.deepEqual(briefLinks(BRIEF.replace(`Slack thread: ${SLACK}\n`, ""), "TLSSN-28"), { jira: JIRA });
});

test("TLSSN-28: a description with only the Jira line gets the Slack line second, and the rest is untouched", () => {
  const after = withTicketLinks(TLSSN_28_BODY, { issueKey: "TLSSN-28", links: LINKS });
  assert.equal(after, [`Jira: ${JIRA}`, `Slack: ${SLACK}`, "", "## What changed", "- Refetch the balance after a transfer settles", "", "## Tests", "- npm test"].join("\n"));
  assert.equal(withTicketLinks(after, { issueKey: "TLSSN-28", links: LINKS }), undefined, "the worker's own edit comes back unchanged");
});

test("the header is rebuilt when the Jira line is missing, the Slack line is wrong or labelled differently, or the body is empty", () => {
  const rest = "## What changed\n- x";
  const want = `Jira: ${JIRA}\nSlack: ${SLACK}\n\n${rest}`;
  assert.equal(withTicketLinks(rest, { issueKey: "TLSSN-28", links: LINKS }), want, "no Jira line: the brief's ticket URL");
  assert.equal(withTicketLinks(rest, { issueKey: "TLSSN-28", links: { slack: SLACK } }), `Jira: TLSSN-28\nSlack: ${SLACK}\n\n${rest}`, "no ticket URL: the key");
  assert.equal(withTicketLinks(`Jira: ${JIRA}\nSlack thread: ${SLACK}\n\n${rest}`, { issueKey: "TLSSN-28", links: LINKS }), want);
  assert.equal(withTicketLinks(`Jira: ${JIRA}\nSlack: https://x.slack.com/archives/C1/p1\n\n${rest}`, { issueKey: "TLSSN-28", links: LINKS }), want);
  assert.equal(withTicketLinks(`Slack: ${SLACK}\nJira: ${JIRA}\n\n${rest}`, { issueKey: "TLSSN-28", links: LINKS }), want, "Jira comes first");
  assert.equal(withTicketLinks(`\n\nJira: ${JIRA}\n${rest}`, { issueKey: "TLSSN-28", links: LINKS }), want);
  assert.equal(withTicketLinks(`**Jira:** ${JIRA}\n\n${rest}`, { issueKey: "TLSSN-28", links: LINKS }), `**Jira:** ${JIRA}\nSlack: ${SLACK}\n\n${rest}`, "the agent's Jira line is kept as written");
  assert.equal(withTicketLinks(null, { issueKey: "TLSSN-28", links: LINKS }), `Jira: ${JIRA}\nSlack: ${SLACK}`);
  assert.equal(withTicketLinks("", { issueKey: "TLSSN-28", links: LINKS }), `Jira: ${JIRA}\nSlack: ${SLACK}`);
});

test("a ticket with no Slack thread leaves the description alone", () => {
  assert.equal(withTicketLinks(TLSSN_28_BODY, { issueKey: "TLSSN-28", links: { jira: JIRA } }), undefined);
  assert.equal(withTicketLinks("", { issueKey: "TLSSN-28", links: {} }), undefined);
});

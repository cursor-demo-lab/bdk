import assert from "node:assert/strict";
import { test } from "node:test";
import { isIntakeCandidate } from "./intake-candidate.js";
import { LIVE_INTAKE_CHANNEL, LIVE_INTAKE_TEXT, LIVE_INTAKE_TS } from "./live-intake.fixtures.js";

const top = (text: string, extra: Record<string, unknown> = {}) => ({ text, markdown: text, ts: LIVE_INTAKE_TS, channelId: LIVE_INTAKE_CHANNEL, ...extra });

test("a top-level problem report is a new request without a filing phrase: the live #mars-eng-intake report", () => {
  assert.equal(isIntakeCandidate(top(LIVE_INTAKE_TEXT)), true);
  assert.equal(isIntakeCandidate(top(LIVE_INTAKE_TEXT, { threadTs: LIVE_INTAKE_TS })), true, "a thread root");
  assert.equal(isIntakeCandidate(top("<@U0FACTORY> CSV export returns 500")), true);
  assert.equal(isIntakeCandidate(top("add a running balance to the register please", { channelId: "D0123ABCD", threadTs: "1790510000.000001" })), true, "a DM");
  assert.equal(isIntakeCandidate(top("<@U0FACTORY> Status code 500 on /export since this morning")), true, "a report that starts with a status word");
  assert.equal(isIntakeCandidate(top("<@U0FACTORY> Status: 500 on /export since this morning")), true);
});

test("a filing phrase still counts anywhere, but approve file / deny file do not", () => {
  assert.equal(isIntakeCandidate(top("<@U0FACTORY> file a bug: export 500", { threadTs: "1790510000.000001" })), true, "a thread reply with a filing phrase, as before");
  assert.equal(isIntakeCandidate(top("approve file")), false);
  assert.equal(isIntakeCandidate(top("<@U0FACTORY> deny file")), false);
  assert.equal(isIntakeCandidate(top("we should backlog this for next sprint", { threadTs: "1790510000.000001" })), false, "a phrase inside a word is not one");
});

test("desk commands, status questions, a lone key, chat, thread replies, and bots are not new requests", () => {
  for (const text of [
    "<@U0FACTORY> what happened to TLSSN-4?",
    "<@U0FACTORY> status of TLSSN-4",
    "<@U0FACTORY> is the plan ready?",
    "approve TLSSN-1",
    "<@U0FACTORY> approve TLSSN-1\n*Sent using* <@U0EXAMPLE1|Cursor>",
    "deny TLSSN-1",
    "<@U0FACTORY> replan TLSSN-1",
    "retry TLSSN-1",
    "<@U0FACTORY> fix https://github.com/cursor-demo-lab/marsbank/pull/12",
    "<@U0FACTORY> drive cursor-demo-lab/marsbank#12",
    "<@U0FACTORY> implement TLSSN-4 as planned today",
    "<@U0FACTORY> can you look at TLSSN-4 again today?",
    "<@U0FACTORY> TLSSN-4 TLSSN-5",
    "<@U0FACTORY> approve",
    "<@U0FACTORY> hello there",
    "thanks!",
    "<@U0FACTORY> is the plan ready",
    "<@U0FACTORY> is the plan ready for the transfer form",
    "<@U0FACTORY> where is my ticket for the export",
    "<@U0FACTORY> status please on the export bug",
    "<@U0FACTORY> state of the transfer form ticket",
    "<@U0FACTORY> can you fix cursor-demo-lab/marsbank#12 the build is red",
    "<@U0FACTORY> please drive https://github.com/cursor-demo-lab/marsbank/pull/12 to green",
    "<@U0FACTORY>\n*Sent using* <@U0EXAMPLE1|Cursor>",
  ]) {
    assert.equal(isIntakeCandidate(top(text)), false, text);
  }
  assert.equal(isIntakeCandidate(top(LIVE_INTAKE_TEXT, { threadTs: "1790510000.000001" })), false, "a channel thread reply");
  assert.equal(isIntakeCandidate(top(LIVE_INTAKE_TEXT, { author: { isBot: true } })), false, "a bot");
});

test("a word-digits token that is not a key of the configured project leaves a report a report", () => {
  const saved = process.env.FACTORY_DESK_JIRA_PROJECT;
  process.env.FACTORY_DESK_JIRA_PROJECT = "TLSSN";
  try {
    for (const text of [
      "<@U0FACTORY> [e2e-158] Why does the transfer form drop the reference after 60 characters?",
      "<@U0FACTORY> Can the CSV export use ISO-8601 dates instead of MM/DD/YYYY?",
      "<@U0FACTORY> Add ISO-8601 timestamps to the statements CSV export",
      "<@U0FACTORY> Build e2e-158 keeps failing on the transfer form reference field",
    ]) {
      assert.equal(isIntakeCandidate(top(text)), true, text);
    }
    for (const text of ["<@U0FACTORY> Why does TLSSN-39's fix not cover the Cards page?", "<@U0FACTORY> can you look at tlssn-39 again today?", "<@U0FACTORY> implement TLSSN-4 as planned today"]) {
      assert.equal(isIntakeCandidate(top(text)), false, `${text}: a question or build ask about a ticket stays a desk question`);
    }
  } finally {
    if (saved === undefined) delete process.env.FACTORY_DESK_JIRA_PROJECT;
    else process.env.FACTORY_DESK_JIRA_PROJECT = saved;
  }
});

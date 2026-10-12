import assert from "node:assert/strict";
import { test } from "node:test";
import { detailComment, isAcknowledgement, isDeskRequest, slackPlainText } from "./thread-detail.js";

test("a Slack reply keeps its links and mentions as plain text on the ticket", () => {
  assert.equal(slackPlainText("<@U0FACTORY> see <https://x.dev/a?b=1|the page>, <https://x.dev/raw> and <#C0EXAMPLE1|mars-eng-intake>"), "see the page (https://x.dev/a?b=1), https://x.dev/raw and #mars-eng-intake");
  assert.equal(slackPlainText("ask <@U0ALICE01> or <mailto:a@b.co|a@b.co> &lt;script&gt; &amp; <!here>"), "ask @U0ALICE01 or a@b.co <script> & @here");
  assert.equal(slackPlainText("<https://x.dev/same|https://x.dev/same>"), "https://x.dev/same");
});

test("only a reply made of thanks, okays, and emoji is an acknowledgement", () => {
  for (const text of ["thanks", "Thank you!", "ok, thx", "got it :+1:", "👍", ":pray: :pray:", "cheers."]) assert.equal(isAcknowledgement(text), true, text);
  for (const text of ["yes", "no", "Chrome", "ok the file is src/export.ts", "thanks, it is /reports/export", "404 on /export"]) assert.equal(isAcknowledgement(text), false, text);
});

test("a new filing request or a status question is the model's; detail that only starts with those words is not", () => {
  for (const text of ["file a bug: login button is grey", "Log this: exports fail on Safari", "status of TLSSN-42?", "What happened to TLSSN-42?", "where is the plan?"]) assert.equal(isDeskRequest(text), true, text);
  for (const text of ["Status code 500 on /export", "the status page shows it too", "where is the file? src/export.ts", "logged this morning at 9:02", "it happens on new tickets only"]) assert.equal(isDeskRequest(text), false, text);
});

test("the ticket comment names who answered and what was asked, and a long reply is cut", () => {
  const body = detailComment({ issueKey: "TLSSN-42", author: "bob", kind: "needs_info", text: "x".repeat(5000) });
  const [first, second, blank, text] = body.split("\n");
  assert.deepEqual([first, second, blank], ["Detail from Slack: TLSSN-42", "bob replied in the ticket's Slack thread after the planner said it needs more information:", ""]);
  assert.equal(text?.length, 4000);
  assert.ok(text?.endsWith("…"));
});

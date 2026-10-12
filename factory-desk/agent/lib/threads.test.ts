import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInfo } from "@cursor/july";
import { announcedKey, approvedMessage, doneMessage, filedMessage, inReviewMessage, parseThreadRef, pastPlanned, postTarget, progressMessage, rootStatus, sameThread, supersedes, threadFromSession, ticketKey, triagedMessage } from "./threads.js";

function session(auth: SessionInfo["auth"], continuationKey: string | null = "C0123ABCD:1758510000.123456"): SessionInfo {
  return { id: "ses_1", channelId: "slack", mode: "chat", purpose: "live", auth, continuationKey };
}

function slackAuth(input: { channelId: string; threadTs?: string }): NonNullable<SessionInfo["auth"]> {
  const { channelId, threadTs } = input;
  return {
    authenticator: "slack",
    principalId: "slack:T:thread",
    principalType: "user",
    attributes: threadTs === undefined ? { channel_id: channelId } : { channel_id: channelId, thread_ts: threadTs },
  };
}

test("a Slack session's auth attributes become a thread ref; the continuation key does not", () => {
  assert.deepEqual(threadFromSession(session(slackAuth({ channelId: "C0123ABCD", threadTs: "1758510000.123456" }), "issue:TLSSN-42")), {
    channelId: "C0123ABCD",
    threadTs: "1758510000.123456",
  });
  assert.deepEqual(threadFromSession(session(slackAuth({ channelId: "G0123ABCD", threadTs: "1758510000.123456" }))), {
    channelId: "G0123ABCD",
    threadTs: "1758510000.123456",
  });
  assert.deepEqual(threadFromSession(session(slackAuth({ channelId: "D0123ABCD" }))), { channelId: "D0123ABCD" });
  assert.equal(threadFromSession(session(slackAuth({ channelId: "C0123ABCD" }))), undefined);
  assert.equal(threadFromSession(session(slackAuth({ channelId: "D0123ABCD", threadTs: "not-a-ts" }))), undefined);
  assert.equal(threadFromSession(session(slackAuth({ channelId: "not-a-channel", threadTs: "1758510000.123456" }))), undefined);
  assert.equal(threadFromSession(session({ authenticator: "slack", principalId: "x", principalType: "user" })), undefined);
  assert.equal(threadFromSession(session(null)), undefined);
  assert.equal(threadFromSession(session(null, null)), undefined);
});

test("kv keys are one path per ticket, and a stored binding parses or is ignored", () => {
  assert.equal(ticketKey("TLSSN-42"), "ticket/TLSSN-42");
  assert.equal(announcedKey({ issueKey: "TLSSN-42", status: "Planned", changelogId: "10042" }), "announced/TLSSN-42:Planned:10042");
  assert.equal(announcedKey({ issueKey: "TLSSN-42", status: "Planned" }), "announced/TLSSN-42:Planned");
  assert.equal(announcedKey({ issueKey: "TLSSN-42", status: "In Progress", changelogId: "10043" }), "announced/TLSSN-42:In Progress:10043");
  assert.deepEqual(parseThreadRef({ channelId: "C0123ABCD", threadTs: "1758510000.123456", filedAt: "2026-09-22T00:00:00.000Z" }), {
    channelId: "C0123ABCD",
    threadTs: "1758510000.123456",
  });
  assert.deepEqual(parseThreadRef({ channelId: "D0123ABCD" }), { channelId: "D0123ABCD" });
  assert.equal(parseThreadRef({ channelId: "C0123ABCD", threadTs: "nope" }), undefined);
  assert.equal(parseThreadRef({ channelId: "nope", threadTs: "1758510000.123456" }), undefined);
  assert.equal(parseThreadRef(null), undefined);
  assert.equal(parseThreadRef("C0123ABCD:1758510000.123456"), undefined);
  assert.equal(parseThreadRef(["C0123ABCD"]), undefined);
});

test("pastPlanned is Approved and every later column, not Planned or empty", () => {
  assert.equal(pastPlanned(undefined), false);
  assert.equal(pastPlanned(""), false);
  assert.equal(pastPlanned("Planned"), false);
  assert.equal(pastPlanned("Triaged"), false);
  for (const status of ["Approved", "In Progress", "Implementing", "In Review", "Done"]) {
    assert.equal(pastPlanned(status), true, status);
  }
  assert.equal(pastPlanned("Go", { FACTORY_STATUS_APPROVED: "Go" }), true);
});

test("each lifecycle line states what just happened, with no Next: look-ahead", () => {
  const pr = { url: "https://github.com/cursor-demo-lab/marsbank/pull/21", label: "cursor-demo-lab/marsbank#21" };
  assert.equal(progressMessage({ issueKey: "TLSSN-26", url: "https://cursor.com/agents/bc-1" }), "TLSSN-26 is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: https://cursor.com/agents/bc-1");

  assert.equal(inReviewMessage({ issueKey: "TLSSN-26", pr }), "TLSSN-26 is In Review: <https://github.com/cursor-demo-lab/marsbank/pull/21|cursor-demo-lab/marsbank#21> is open.");
  assert.equal(approvedMessage({ issueKey: "TLSSN-26" }), "TLSSN-26 is Approved.");

  const unlinked = inReviewMessage({ issueKey: "TLSSN-26" });
  assert.doesNotMatch(unlinked, /\bis open\b/, "no link means the line cannot claim a pull request is open");
  assert.equal(unlinked, `TLSSN-26 is In Review. No pull request link is on the ticket; the factory's pull request title starts with "TLSSN-26: ".`);

  assert.equal(doneMessage({ issueKey: "TLSSN-26", pr, mergedBy: "example-user" }), "TLSSN-26 is Done: <https://github.com/cursor-demo-lab/marsbank/pull/21|cursor-demo-lab/marsbank#21> was merged by example-user.");
  assert.equal(doneMessage({ issueKey: "TLSSN-26" }), "TLSSN-26 is Done. No pull request link is on the ticket.");
});

test("the Triaged line is the verdict in plain words and who triaged it; no scores, no look-ahead; a needs-info verdict asks for the detail now", () => {
  const jev = { type: { choice: "Bug", probability: "0.99", outcome: "set" as const }, severity: { choice: "low", probability: "0.54", outcome: "agreed" as const } };
  const lines = triagedMessage({ issueKey: "TLSSN-27", replan: false, verdict: { kind: "bug", severity: "low", issueType: "Bug", jev, triagedBy: "model", triageModel: "Grok 4.6 Fast", confidence: 50 } }).split("\n");
  assert.deepEqual(lines, ["TLSSN-27 is Triaged by Grok 4.6 Fast (Jev was only 50% confident): Bug, low severity."]);
  assert.equal(
    triagedMessage({ issueKey: "TLSSN-27", replan: true, verdict: { kind: "bug", severity: "low", issueType: "Bug", triagedBy: "model", triageModel: "Grok 4.6 Fast", confidence: 50 } }),
    "TLSSN-27 is Triaged for a new plan. Triaged by Grok 4.6 Fast (Jev was only 50% confident): Bug, low severity."
  );
  assert.equal(triagedMessage({ issueKey: "TLSSN-27", replan: false, verdict: { kind: "bug", severity: "low", issueType: "Bug", triagedBy: "jev", confidence: 78 } }).split("\n")[0], "TLSSN-27 is Triaged by Jev: Bug, low severity (78% confidence).");
  assert.equal(triagedMessage({ issueKey: "TLSSN-27", replan: false, verdict: { kind: "bug", severity: "low", issueType: "Bug" } }), "TLSSN-27 is Triaged: Bug, low severity.", "a person's verdict credits no one");
  assert.equal(triagedMessage({ issueKey: "TLSSN-27", replan: false, verdict: { kind: "bug", severity: "low", issueType: "Bug", triagedBy: "model", fallback: "no_key" } }), "TLSSN-27 is Triaged by Grok 4.6 Fast (Jev wasn't asked): Bug, low severity.");
  assert.doesNotMatch(lines.join("\n"), /0\.\d\d|Jev:|set in Jira|agreed/);
  const needsInfo = triagedMessage({ issueKey: "TLSSN-24", replan: false, verdict: { kind: "bug", severity: "low", gate: "needs_info", nextStep: "Ask for steps.", jev } });
  assert.equal(needsInfo, "TLSSN-24 is Triaged, but triage needs more information: Ask for steps.\nNext: reply here with it.");
  assert.doesNotMatch(needsInfo, /planner checks it/);
  assert.equal(triagedMessage({ issueKey: "TLSSN-9", replan: false, verdict: { kind: "bug", severity: "low", gate: "duplicate", duplicateOf: "TLSSN-3" } }), "TLSSN-9 is Triaged as a duplicate of TLSSN-3, so the planner skips it.");
});

test("TLSSN-36: the Filed post is the key link once and the triage it was filed with and who made it; no look-ahead", () => {
  const base = { issueKey: "TLSSN-36", url: "https://x.atlassian.net/browse/TLSSN-36", issueType: "Bug", severity: "low", summary: "Card export CSV drops the last row.", kind: "bug" as const, triaged: true };
  assert.equal(
    filedMessage({ ...base, credit: { by: "jev", percent: 78 } }),
    "[TLSSN-36](https://x.atlassian.net/browse/TLSSN-36) is filed. Triaged by Jev: Bug, low severity (78% confidence).",
    "the filing prompt just showed the Summary, so the Filed post does not repeat it"
  );
  const model = filedMessage({ ...base, credit: { by: "model", model: "Grok 4.6 Fast", percent: 50, reason: "below_bar" } });
  assert.match(model, /^\[TLSSN-36\]\([^)]+\) is filed\. Triaged by Grok 4\.6 Fast \(Jev was only 50% confident\): Bug, low severity\./);
  assert.doesNotMatch(model, /the model/);
  assert.equal(model.match(/TLSSN-36/g)?.length, 2, "the key once, in its link (plus the link's URL)");
  assert.doesNotMatch(model, /Triaged line|follows in this thread|0\.\d\d/);
  assert.match(filedMessage({ ...base, credit: { by: "jev" }, needsInfo: true }), /\nNext: reply here with what you saw, where it happens, and what you expected\.$/);
  assert.match(filedMessage({ ...base, credit: { by: "model" }, kind: "question", issueType: "Task", nextStep: "Answer the reporter in the ticket's thread." }), /\nIt is a question, so the planner skips it\.$/);
  assert.match(filedMessage({ ...base, credit: { by: "jev" }, triaged: false }), /\nIt did not reach Triaged, so the planner has not started\.$/);
  const { url: _url, ...unlinked } = base;
  assert.match(filedMessage({ ...unlinked, credit: { by: "jev" } }), /^TLSSN-36 is filed\. Triaged by Jev: Bug, low severity\.$/);
});

test("the progress message names the key and the agent URL", () => {
  assert.equal(
    progressMessage({ issueKey: "TLSSN-42", url: "https://cursor.com/agents/bc-1234" }),
    `TLSSN-42 is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: https://cursor.com/agents/bc-1234`
  );
  assert.equal(
    progressMessage({ url: "https://cursor.com/agents/bc-5678", issueKey: "TLSSN-7" }),
    `TLSSN-7 is In Progress. The factory opens the PR up to about 10 minutes after the agent pushes. Agent: https://cursor.com/agents/bc-5678`
  );
});

test("a stored binding keeps a valid originator, and only a DM binding may lack a thread", () => {
  assert.deepEqual(parseThreadRef({ channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE01" }), {
    channelId: "C0123ABCD",
    threadTs: "1758510000.123456",
    originatorUserId: "U0ALICE01",
  });
  assert.deepEqual(parseThreadRef({ channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "<!channel>" }), {
    channelId: "C0123ABCD",
    threadTs: "1758510000.123456",
  });
  assert.equal(parseThreadRef({ channelId: "C0123ABCD", originatorUserId: "U0ALICE01" }), undefined);
});

test("a bound ticket always replies in its thread; an unbound one opens a root in the intake channel", () => {
  assert.deepEqual(postTarget({ channelId: "C0123ABCD", threadTs: "1758510000.123456" }, "C0INTAKE01"), { channel: "C0123ABCD", threadTs: "1758510000.123456", root: false });
  assert.deepEqual(postTarget({ channelId: "D0123ABCD" }, "C0INTAKE01"), { channel: "D0123ABCD", root: false });
  assert.deepEqual(postTarget(undefined, " C0INTAKE01 "), { channel: "C0INTAKE01", root: true });
  assert.equal(postTarget(undefined, ""), undefined);
  assert.equal(postTarget(undefined, undefined), undefined);
});

test("threads compare by channel and root ts", () => {
  assert.ok(sameThread({ channelId: "C0123ABCD", threadTs: "1.1" }, { channelId: "C0123ABCD", threadTs: "1.1" }));
  assert.ok(!sameThread({ channelId: "C0123ABCD", threadTs: "1.1" }, { channelId: "C0123ABCD", threadTs: "1.2" }));
  assert.ok(!sameThread({ channelId: "C0123ABCD", threadTs: "1.1" }, { channelId: "C0999ABCD", threadTs: "1.1" }));
  assert.ok(sameThread({ channelId: "D0123ABCD" }, { channelId: "D0123ABCD" }));
});

test("a root status is ordered by changelog id when both are numeric, else by lifecycle rank", () => {
  const at = (status: string, changelogId?: string) => rootStatus({ status, ...(changelogId === undefined ? {} : { changelogId }) }, {});
  assert.deepEqual(at("In Review", "7"), { status: "In Review", rank: 4, changelogId: "7" });
  assert.deepEqual(at("Launch failed"), { status: "Launch failed" });
  assert.equal(supersedes(at("Planned", "1"), at("Approved", "2")), false);
  assert.equal(supersedes(at("Planned", "4"), at("In Progress", "3")), true);
  assert.equal(supersedes(at("Approved", "2"), at("Approved", "2")), true);
  assert.equal(supersedes(at("Approved", "b"), at("In Progress", "a")), false);
  assert.equal(supersedes(at("Done", "b"), at("In Progress", "a")), true);
  assert.equal(supersedes(at("Launch failed"), at("Planned")), false);
  assert.equal(supersedes(at("Planned"), at("Launch failed")), true);
  assert.equal(supersedes(at("Planned", "1"), undefined), true);
  assert.equal(supersedes(at("Planned", "99999999999999999"), at("Done", "99999999999999998")), true);
  assert.deepEqual(parseThreadRef({ channelId: "C0INTAKE01", threadTs: "1758510001.000100", root: "jira", rootStatus: { status: "Done", rank: 5, changelogId: "9" } })?.rootStatus, {
    status: "Done",
    rank: 5,
    changelogId: "9",
  });
});

test("the Filed post never repeats the filing prompt's Summary, however long", () => {
  const summary = "The Held column shows Offset 0.00 for every home loan with no linked offset account at all ".repeat(5).trim();
  const post = filedMessage({ issueKey: "TLSSN-40", issueType: "Bug", severity: "low", summary, kind: "bug", triaged: true, credit: { by: "jev" } });
  assert.doesNotMatch(post, /Summary:|Held column/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { answersConfidence, calibrateSeverity, fallbackTriageModel, jevConfidence, severityCeiling, templateVerdict, triageRecordLines, type JevAnswers, type TriageJudgment } from "./jev-triage.js";
import { FILING_ASK, FILING_ASK_REACTIONS, capitalizedTitle, intakeTriageContext, filingPrompt, intakeText, requestSummary, triagedByLead, unaskedFilingPrompt } from "./intake-triage.js";
import { asksToFile } from "./reaction-targets.js";
import { governingTriage, isDeskTriageComment, withDeskTriaged } from "./desk-triaged.js";
import { latestTriageVerdict } from "./triage-comment.js";
import { triageLine } from "./triage-credit.js";
import { replyPrefix } from "./desk-channels.js";
import type { TriageSeverity } from "./triage-verdict.js";

// c69c1b2 and pin the round-2 fixes. Under the cap-on-evidence contract a Bug
// with no loss or critical phrase and no typed-input, UI, or request evidence
// keeps Jev's severity (ceiling urgent); a Story or question is capped by its
// type, so a Story row also shows that no loss or critical phrase was read.

type Row = { text: string; type: string; ceiling: TriageSeverity };

const AGREED: Row[] = [
  { text: "Can we add a confirm dialog before deleting a project?", type: "Story", ceiling: "medium" },
  { text: "The Save button copy should say Submit", type: "Story", ceiling: "medium" },
  { text: "Would be nice to have dark mode", type: "Story", ceiling: "medium" },
  { text: "How do I export my report?", type: "question", ceiling: "low" },
  { text: "Add a warning before closing an unsaved form", type: "Story", ceiling: "medium" },
  { text: "Expose a setting for the default currency", type: "Story", ceiling: "medium" },
  { text: "Memory leak in the dashboard tab", type: "Bug", ceiling: "urgent" },
  { text: "Memory leak in the dashboard tab", type: "Task", ceiling: "medium" },
  { text: "The down arrow icon is misaligned", type: "Bug", ceiling: "medium" },
  { text: "The button colour is wrong 😅", type: "Bug", ceiling: "medium" },
  { text: "I typed a long comment and lost it when the page refreshed", type: "Bug", ceiling: "urgent" },
  { text: "I typed a long comment and lost it when the page refreshed", type: "Story", ceiling: "medium" },
  { text: "I was typing a long comment and lost it when the page refreshed", type: "Bug", ceiling: "medium" },
  { text: "Nothing was lost but the save button is slow", type: "Bug", ceiling: "urgent" },
  { text: "Nothing was lost but the save button is slow", type: "Story", ceiling: "medium" },
  { text: "No data was lost, the page just flickered", type: "Bug", ceiling: "urgent" },
  { text: "No data was lost, the page just flickered", type: "Story", ceiling: "medium" },
  { text: "We never lost any payments, but the receipt email is late", type: "Bug", ceiling: "urgent" },
  { text: "We never lost any payments, but the receipt email is late", type: "Story", ceiling: "medium" },
  { text: "Please don't delete my files without asking — add a confirm step", type: "Story", ceiling: "medium" },
  { text: "Please don't delete my files without asking — add a confirm step", type: "Bug", ceiling: "medium" },
  { text: "Site is down, everyone gets 502", type: "Bug", ceiling: "urgent" },
  { text: "Production outage: API returns 500 for all users", type: "Bug", ceiling: "urgent" },
  { text: "🔥🔥 site is down 🔥", type: "Bug", ceiling: "urgent" },
  { text: "Users can't log in since this morning", type: "Bug", ceiling: "urgent" },
  { text: "I can’t log in to online banking", type: "Bug", ceiling: "urgent" },
  { text: "Customer statements PDF is exposed via a public URL", type: "Bug", ceiling: "urgent" },
  { text: "API tokens leaked in the logs", type: "Bug", ceiling: "urgent" },
  { text: "Unauthorized users can view the admin page", type: "Bug", ceiling: "urgent" },
  { text: "Not a security issue but user emails are exposed on the profile page", type: "Bug", ceiling: "urgent" },
  { text: "Transfer was sent twice to the same payee", type: "Bug", ceiling: "urgent" },
  { text: "I got charged twice for my subscription", type: "Bug", ceiling: "urgent" },
  { text: "Money went to the wrong account", type: "Bug", ceiling: "urgent" },
  { text: "The balance is wrong after the refund", type: "Bug", ceiling: "urgent" },
  { text: "All my files were deleted after the sync", type: "Bug", ceiling: "urgent" },
  { text: "The database got corrupted overnight", type: "Bug", ceiling: "urgent" },
  { text: "**data loss** after the migration", type: "Bug", ceiling: "urgent" },
  { text: `${"x ".repeat(5000)}and then the database was wiped`, type: "Bug", ceiling: "urgent" },
  { text: 'The "Log out" button in the banking header signs you out immediately, even when you\'re halfway through a transfer on Move tokens.\n\nOne of our testers lost a half-filled transfer after brushing it on a trackpad. It would be nicer if it asked "Leave this transfer?" when the form has unsaved input, and logged out straight away otherwise.', type: "Bug", ceiling: "medium" },
];

const REGRESSIONS: Array<Row & { why: string }> = [
  { text: "Not a security issue, but the tooltip is misaligned", type: "Bug", ceiling: "medium", why: "negated security phrase still lifts the ceiling (CRITICAL_LANGUAGE has no negation check)" },
  { text: "The app is down to one column on mobile", type: "Bug", ceiling: "urgent", why: "`is down` reads as an outage; a drop in a measure is left to Jev (the drop machinery is gone)" },
  { text: "Without a confirm step someone could lose data", type: "Story", ceiling: "medium", why: "hypothetical loss in a feature ask lifts the ceiling" },
  { text: "Customer records were\ndeleted after the import", type: "Bug", ceiling: "urgent", why: "loss split across a line break is not seen, so real data loss is capped to medium" },
  { text: "`deleteAll` removed customer records", type: "Bug", ceiling: "urgent", why: "`removed` is not a loss verb, so real data loss is capped to medium" },
  { text: "データが消えました（全顧客の取引履歴）", type: "Bug", ceiling: "urgent", why: "non-English data loss is capped to medium" },
  { text: "ログインできません。全員ブロックされています", type: "Bug", ceiling: "urgent", why: "non-English outage is capped to medium" },
  { text: "We might lose all customer records if the import runs twice; add a guard", type: "Story", ceiling: "medium", why: "hypothetical loss" },
  { text: "We don't know why, but users can't log in", type: "Bug", ceiling: "urgent", why: "an earlier negation must not hide an outage" },
  { text: "Records were purged by the cleanup job", type: "Bug", ceiling: "urgent", why: "purged is a loss verb" },
  { text: "All customer records were deleted and could not be recovered", type: "Bug", ceiling: "urgent", why: "a later negation in the clause does not hide the loss (Bugbot)" },
  { text: "Funds are missing and not showing in the app", type: "Bug", ceiling: "urgent", why: "a later negation in the clause does not hide the loss (Bugbot)" },
  { text: "The data was not lost, only hidden", type: "Story", ceiling: "medium", why: "a negated loss verb" },
  { text: "The data was not lost, only hidden", type: "Bug", ceiling: "urgent", why: "a negation is not evidence of a cosmetic report: a Bug keeps Jev's severity" },
  { text: "A bug can expose customer passwords", type: "Bug", ceiling: "urgent", why: "expose before a secret noun (Bugbot)" },
  { text: "Secrets exposure in the build log", type: "Bug", ceiling: "urgent", why: "exposure after a secret noun (Bugbot)" },
  { text: "We might have lost all customer records in the migration", type: "Bug", ceiling: "urgent", why: "a past-tense modal is a real report (Bugbot)" },
  { text: "Someone may have deleted the payments table", type: "Bug", ceiling: "urgent", why: "a past-tense modal is a real report (Bugbot)" },
  { text: "The mobile banking gateway is down", type: "Bug", ceiling: "urgent", why: "generic downtime with an unlisted subject (Bugbot)" },
  { text: "Card payments are down since 9am", type: "Bug", ceiling: "urgent", why: "generic downtime (Bugbot)" },
  { text: "Conversion is down by 5% this week", type: "Bug", ceiling: "urgent", why: "`is down` is left to Jev: reading a drop off an outage by regex capped real outages" },
];

for (const row of AGREED) {
  test(`guard ceiling: ${JSON.stringify(row.text.slice(0, 60))} → ${row.ceiling}`, () => {
    assert.equal(severityCeiling(row), row.ceiling);
  });
}

for (const row of REGRESSIONS) {
  test(`guard ceiling: ${JSON.stringify(row.text.slice(0, 60))} → ${row.ceiling} (${row.why})`, () => {
    assert.equal(severityCeiling(row), row.ceiling);
  });
}

test("guard never raises, for every row and every input severity", () => {
  const rank = { low: 0, medium: 1, high: 2, urgent: 3 } as const;
  for (const row of [...AGREED, ...REGRESSIONS]) {
    for (const severity of ["low", "medium", "high", "urgent"] as const) {
      assert.ok(rank[calibrateSeverity({ ...row, severity })] <= rank[severity]);
    }
  }
});

function answers(type: [string, number], severity: [string, number], gate: [string, number] = ["proceed", 1]): JevAnswers {
  const one = ([choice, p]: [string, number]) => ({ choice, probabilities: { [choice]: p } });
  return { issueType: one(type), severity: one(severity), gate: one(gate) } as unknown as JevAnswers;
}

test("Jev-only path (templateVerdict, used by triage-jira jev-first) caps Test B's urgent to medium", () => {
  const text = AGREED.at(-1)!.text;
  const verdict = templateVerdict({ identifier: "T-1", title: text.split("\n")[0]!, description: text }, answers(["Bug", 0.99], ["urgent", 0.62]));
  assert.equal(verdict?.severity, "medium");
});

test("confidence rounding boundaries", () => {
  assert.equal(jevConfidence([0.525]), 53);
  assert.equal(jevConfidence([0.775]), 78);
  assert.equal(jevConfidence([0.995]), 100);
  assert.equal(jevConfidence([1]), 100);
  assert.equal(jevConfidence([0.99, 0.62, 1]), 62);
});

test("confidence: a missing or NaN probability field gives no number", () => {
  for (const probabilities of [{}, { low: Number.NaN }]) {
    const missing = { ...answers(["Bug", 0.9], ["low", 0.4]), severity: { choice: "low", probabilities } } as unknown as JevAnswers;
    assert.equal(answersConfidence(missing), undefined);
    const lead = triagedByLead({ by: "model", reason: "below_bar", jev: { answers: missing } as never });
    assert.doesNotMatch(lead, /confidence/);
  }
  assert.equal(jevConfidence([0.9, Number.NaN, 1]), undefined);
});

test("Jev unavailable or unasked: no number in the lead or the Triaged by line", () => {
  for (const reason of ["unavailable", "no_key", "labels"] as const) assert.doesNotMatch(triagedByLead({ by: "model", reason }), /%/);
  const down: TriageJudgment = { status: "unavailable", message: "timeout" };
  assert.doesNotMatch(triageRecordLines(down), /%/);
});

const OLD_PROMPT = "Checkout 500s\nTriaged by Jev: Bug, high severity.\nSummary: It fails.\nReact ✅ to file it with this triage or ❌ to drop it, or reply `@factory approve file` / `@factory deny file`. Once it is filed and planned, react ✅ on the plan or reply `@factory approve` in this thread to start the build.";
const NEW_PROMPT = filingPrompt({ title: "Checkout 500s", lead: "Triaged by Jev", type: "Bug", severity: "medium", note: "62% confidence; Jev said urgent", summary: "It fails.", ask: FILING_ASK });

test("filing prompt: new wording, ends with the ask, and both old and new are found by asksToFile", () => {
  assert.equal(NEW_PROMPT.split("\n")[1], "Triaged by Jev: Bug, medium severity (62% confidence; Jev said urgent).");
  assert.ok(NEW_PROMPT.endsWith("React ✅ to file or ❌ to drop, or reply `approve file` / `deny file`."));
  assert.ok(asksToFile(OLD_PROMPT));
  assert.ok(asksToFile(NEW_PROMPT));
  assert.ok(asksToFile(unaskedFilingPrompt()));
  assert.doesNotMatch(NEW_PROMPT, /\b(once|next the|after that|lands in this thread)\b/i);
});

test("filing ask in a channel the desk does not watch offers reactions only, with no mention; a watched thread keeps the typed replies", () => {
  assert.notEqual(replyPrefix("C0UNWATCHED", {}), "", "precondition: a plain reply does not reach the desk there");
  const triage = { by: "model", reason: "unavailable" } as const;
  const unwatched = intakeTriageContext(triage, { text: "the export is broken", bareReply: false });
  const watched = intakeTriageContext(triage, { text: "the export is broken", bareReply: true });
  const prompt = (block: string) => block.split("<filing_prompt>\n")[1]!.split("\n</filing_prompt>")[0]!;
  assert.ok(prompt(unwatched).endsWith(`\n${FILING_ASK_REACTIONS}`));
  assert.doesNotMatch(prompt(unwatched), /@|approve file/);
  assert.ok(prompt(watched).endsWith(`\n${FILING_ASK}`));
  for (const text of [prompt(unwatched), prompt(watched), OLD_PROMPT]) assert.ok(asksToFile(text), text);
  assert.equal(asksToFile("React ✅ to file or ❌ to drop. Then something else."), false, "only as the prompt's last line");
});

test("old and new Triage: comments read the same through every comment reader", () => {
  const base = "Triage: bug\nType: Bug\nSeverity: medium\nSummary: It fails.\nNext step: Planner: reproduce.";
  const old = withDeskTriaged(`${base}\nTriaged by: Jev (type, severity, and gate all above 0.52)\nJudge: Jev type Bug 0.99 (set in Jira; Jev only); severity medium 0.62 (Jev only)`);
  const neu = withDeskTriaged(`${base}\nTriaged by: Jev (62% confidence; Jev said urgent; type, severity, and gate all above 0.52)\nJudge: Jev type Bug 0.99 (set in Jira; Jev only); severity medium 0.62 (Jev only)`);
  for (const comment of [old, neu]) {
    assert.ok(isDeskTriageComment(comment));
    assert.deepEqual(governingTriage([comment]), { index: 0, from: "desk" });
    const verdict = latestTriageVerdict([comment]);
    assert.equal(verdict?.severity, "medium");
    assert.equal(verdict?.triagedBy, "jev");
  }
});

const TITLES: Array<[string, string]> = [
  ["Quick question: the transfer box is empty", "The transfer box is empty"],
  ["Hey team,\nthe transfer box is empty", "The transfer box is empty"],
  ["`camelCase` breaks", "`camelCase` breaks"],
  ["camelCase breaks", "camelCase breaks"],
  ["snake_case field breaks", "snake_case field breaks"],
  ["./scripts/run.sh fails", "./scripts/run.sh fails"],
  ["/abs/path fails", "/abs/path fails"],
  ["~/x fails", "~/x fails"],
  ["a/b.ts fails", "a/b.ts fails"],
  ["https://x.io/a is 500", "https://x.io/a is 500"],
  ["--flag is ignored", "--flag is ignored"],
  ["#channel is noisy", "#channel is noisy"],
  ["file.ext is missing", "file.ext is missing"],
  ["iOS app crashes", "iOS app crashes"],
  ["eBay import fails", "eBay import fails"],
  ["3 users see 500", "3 users see 500"],
  ["🔥 the page is down", "🔥 the page is down"],
  ["保存ボタンが動かない", "保存ボタンが動かない"],
  ["(the modal) is stuck", "(the modal) is stuck"],
  ['"the modal" is stuck', '"the modal" is stuck'],
  ["Quick question: (the modal) is stuck", "(the modal) is stuck"],
];

for (const [raw, expected] of TITLES) {
  test(`title caps: ${JSON.stringify(raw)}`, () => {
    assert.equal(capitalizedTitle(intakeText(raw).title), expected);
  });
}

// Pre-existing on main (intakeText drops a leading @mention, so it returns
// "gets pinged…"); this PR only capitalises what is left.
test("title: a leading @handle that is not the desk is stripped from the title", { todo: "pre-existing leading-mention strip on main" }, () => {
  assert.equal(capitalizedTitle(intakeText("@handle gets pinged on every deploy").title), "@handle gets pinged on every deploy");
});

test("summary de-dup still holds after a capitalised title", () => {
  const one = intakeText("Quick question: the export is slow. It takes 5 minutes.");
  assert.equal(requestSummary(capitalizedTitle(one.title), one.description), "It takes 5 minutes.");
  const only = intakeText("Quick question: the export is slow");
  assert.equal(requestSummary(capitalizedTitle(only.title), only.description), undefined);
});

test("the backup triage model is named from the host's model settings: grok-4.6 at fast is Grok 4.6 Fast", () => {
  assert.equal(fallbackTriageModel({}), "Grok 4.6 Fast");
  assert.equal(fallbackTriageModel({ FACTORY_AGENT_SPEED: "standard" }), "Grok 4.6");
  assert.equal(fallbackTriageModel({ FACTORY_AGENT_MODEL: "grok-4.7" }), "Grok 4.7 Fast");
  assert.equal(fallbackTriageModel({ FACTORY_AGENT_MODEL: "auto-smart" }), "Cursor Auto");
  assert.equal(fallbackTriageModel({ FACTORY_AGENT_MODEL: "claude-opus-5-5" }), "Claude Opus 5.5");
  assert.equal(fallbackTriageModel({ FACTORY_AGENT_MODEL: "some-new-model" }), "some-new-model");
});

test("the spec's triage lines: Jev with its whole-percent confidence, or the backup model by name with Jev's", () => {
  assert.equal(triageLine({ by: "jev", percent: 78 }, { type: "Bug", severity: "medium" }), "Triaged by Jev: Bug, medium severity (78% confidence)");
  assert.equal(triageLine({ by: "model", model: "Grok 4.6 Fast", percent: 50, reason: "below_bar" }, { type: "Bug", severity: "high" }), "Triaged by Grok 4.6 Fast (Jev was only 50% confident): Bug, high severity");
  assert.equal(triageLine({ by: "model", model: "Grok 4.6 Fast", reason: "unavailable" }, { type: "Bug", severity: "high" }), "Triaged by Grok 4.6 Fast (Jev didn't answer): Bug, high severity");
  assert.doesNotMatch(triageLine({ by: "model", percent: 50, reason: "below_bar" }, { type: "Bug", severity: "high" }), /the model|0\.\d\d/);
});

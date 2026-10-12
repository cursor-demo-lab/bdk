import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrateSeverity, severityCeiling, templateVerdict, type JevAnswers } from "./jev-triage.js";

// The contract: the guard caps only on clear evidence, and otherwise leaves
// Jev's severity. A loss or critical phrase means no cap for any type; a
// Story, Task, feedback, or question without one is at most medium (a question
// low); a Bug without one is capped only when it reads as typed input, a UI
// element's appearance, or a UX or feature request. Graded failures: capping
// real stored-data loss is High, leaving a common cosmetic report at urgent is
// Medium, an unrecognised phrasing left at Jev's severity is Low.

const SEVERITIES = ["low", "medium", "high", "urgent"] as const;
const RANK = { low: 0, medium: 1, high: 2, urgent: 3 } as const;
const TYPES = ["Bug", "Story", "Task", "bug", "feedback", "question"];

// ---- Never capped: stored-data loss, for every type. ----

const STORED_LOSS = ["all my payees were deleted", "I lost all my payees", "my payees were deleted", "All my payees got deleted", "All my contacts disappeared after the update", "payees I had saved are gone", "my saved transactions are gone", "All my contacts disappeared", "my saved transactions were wiped", "every scheduled payment vanished", "On the payee form all my payees were deleted", "While I was typing a new payee, all my existing payees were deleted", "my transaction history is gone"];
const MORE_STORED_LOSS = ["my account type was deleted", "the transaction type was removed", "all my payees disappeared from the page", "my contacts vanished from the dashboard", "my invoices are gone from the screen", "I deleted my payees while I was typing a note", "Saving a payee deleted every transaction record on the account."];
const LOSS_BEFORE_A_TYPING_CLAUSE = ["I lost my payees filling out the form", "we lost all our contacts typing in the search box", "deleted my transactions while typing", "I lost my payees typing a new one", "we lost our saved payees filling in the transfer form"];
// 647fa9e read three words before a noun-first match for its determiner and crossed "and", so a draft in the clause before capped a real loss.
const LOSS_AFTER_A_TRANSIENT_CLAUSE = ["I was filling in a draft and all my payees were deleted", "I saved a draft and my payees were deleted", "I opened a draft and all my payees were deleted", "after typing my password all my saved payees were gone", "I saved a draft. My payees were deleted", "unsaved changes aside, my payees were deleted", "my payees were deleted when I saved a draft", "I was typing a note and my payees were deleted", "I opened the drafts tab and all my contacts were deleted", "I saved a draft and payments were deleted", "I saved a draft - payments were deleted"];

for (const text of [...STORED_LOSS, ...MORE_STORED_LOSS, ...LOSS_BEFORE_A_TYPING_CLAUSE, ...LOSS_AFTER_A_TRANSIENT_CLAUSE]) test(`stored-data loss is never capped, for any type: ${JSON.stringify(text)}`, () => {
  for (const type of TYPES) {
    assert.equal(severityCeiling({ text, type }), "urgent", type);
    for (const severity of SEVERITIES) assert.equal(calibrateSeverity({ text, type, severity }), severity, `${type} ${severity}`);
  }
});

// ---- Left at Jev's severity: a Bug the guard has no evidence on. ----

// Stored data lost, in words the loss patterns do not know: terse titles and
// third-person possessives. Capping any of these was High; they now keep Jev's severity.
const LOSS_IN_OTHER_WORDS = ["Payees deleted after the update", "All payees gone", "Payees missing since yesterday", "Customer payees deleted by the sync job", "Contacts wiped after the migration", "Direct debits vanished", "Beneficiaries are gone from every account", "A customer lost their saved payees after the migration", "The customer's payees were deleted", "Customers report their payees were deleted", "Saved payees should not be deleted when the app updates", "Will the deleted payees be restored?", "Can you restore the payees that were deleted?", "The transfer I entered yesterday is gone", "On the payees tab all payees missing", "Customer payees vanished from the payees tab", "The payee list disappeared from the sidebar after the redesign", "Support suggested clearing the cache and now payees gone"];
// Bugbot on 2a6f812: a phrase that also states an expected state or a past data entry is not evidence.
const EXPECTED_STATE_OR_PAST_ENTRY = ["The payee I typed in yesterday has disappeared", "The address I typed in last week is gone", "all the payees I typed in yesterday are gone", "I typed a new payee yesterday and it is gone", "everything I entered yesterday is gone", "everything I had entered was deleted", "everything I typed yesterday is gone", "everything I typed in yesterday is gone", "everything I typed this morning is gone", "what I typed a few days ago has disappeared", "everything I had typed yesterday is gone", "everything I had typed was deleted from my account", "what I typed last week has disappeared", "what we had written on Monday is gone", "everything I entered on the payees page is gone", "everything I typed on the payees screen yesterday is gone", "everything I entered in the form is gone", "everything I entered before we went live is gone", "everything I had written before restarted is gone", "what I entered before the migration went ahead is gone", "The payees should be restored from backup", "The balance should be 500 but shows 300", "The transfer should be in the list but is not", "Could the payees be restored?", "The dashboard should show today's transactions but it is blank", "The API response is missing headers", "The statement export is missing columns", "Transfers fail in dark mode", "The padding on the transfers page changed and payees gone"];
// A core flow broken with no workaround: the rubric's high, with no loss or outage words.
const LEGIT_HIGH = ["Transfers fail for all our business customers with no workaround", "Nobody on the ops team can approve payments", "Every teller is blocked on the approval screen", "Transfers fail for every business customer since the release", "The approval step errors for our whole ops team"];
// Common phrasings that may be typed input or a UI state, with a loss match and no other evidence: left to Jev (Low under the rubric).
const AMBIGUOUS_LOSS = ["I lost all my work when the page refreshed", "I lost my place in the list after scrolling", "my session was lost and I had to log in again", "all my filters were lost after the update", "My dashboard is gone", "I typed a long comment and lost it when the page refreshed"];
// Nothing severe and no evidence: a Bug keeps Jev's severity; a negation is not evidence either.
const NO_EVIDENCE = ["Memory leak in the dashboard tab", "The receipt email is late", "No outage, just a slow page", "The save spinner is slow", "The label says 保存", "Nobody lost any data", "my payees were not deleted", "The data was not lost, only hidden", "I can't access the settings page from the transfer form.", "Traffic is down from 10k to 2k", "Conversion is down by 5% this week", "App down to one column on mobile", "Not a data leak, only the tooltip text"];

for (const text of [...LOSS_IN_OTHER_WORDS, ...EXPECTED_STATE_OR_PAST_ENTRY, ...LEGIT_HIGH, ...AMBIGUOUS_LOSS, ...NO_EVIDENCE]) test(`a Bug without evidence keeps Jev's severity: ${JSON.stringify(text)}`, () => {
  assert.equal(severityCeiling({ text, type: "Bug" }), "urgent");
  for (const severity of SEVERITIES) assert.equal(calibrateSeverity({ text, type: "Bug", severity }), severity, severity);
});

test("legit high stays high", () => {
  for (const text of LEGIT_HIGH) assert.equal(calibrateSeverity({ text, type: "Bug", severity: "high" }), "high", text);
});

// ---- Type-based cap: Jev's own type is the evidence. ----

test("a Story, Task, or feedback with no loss or critical phrase is at most medium; a question at most low", () => {
  for (const text of ["The export button throws an error on empty filters.", "Memory leak in the dashboard tab", "The receipt email is late", "How do I export my report?", "Please expose the session timeout as a setting.", "Nobody lost any data", "The data was not lost, only hidden", "I can't access the settings page from the transfer form."]) {
    for (const type of ["Story", "Task", "feedback"]) assert.equal(severityCeiling({ text, type }), "medium", `${type}: ${text}`);
    assert.equal(severityCeiling({ text, type: "question" }), "low", text);
  }
});

test("a loss or critical phrase beats the type", () => {
  for (const text of ["all my payees were deleted", "The app is down for everyone.", "Users can't log in since this morning", "Customer statements PDF is exposed via a public URL", "The transfer went through twice", "Duplicate payments on my statement"]) for (const type of TYPES) assert.equal(severityCeiling({ text, type }), "urgent", `${type}: ${text}`);
});

test("a payment that went through twice beats typed-input evidence", () => {
  for (const text of ["The transfer I was filling in went through twice", "The payment I was typing in was submitted twice", "I typed the transfer once and it was processed twice"]) for (const severity of SEVERITIES) assert.equal(calibrateSeverity({ text, type: "Bug", severity }), severity, `${severity}: ${text}`);
});

// ---- Capped: a Bug that reads as typed input, a UI element's appearance, or a request. ----

const TRANSIENT_OBJECT_LOSS = ["I lost my half-filled transfer", "we lost our unsaved draft", "my draft transfer was lost", "the details I was typing were lost", "the form I was filling in was lost", "we lost our new unsaved payees", "my draft payments were deleted", "my typed message disappeared", "I lost all of my unsaved payees", "the new draft payments were deleted"];
const TYPED_INPUT = ["the details I was typing were lost when the page refreshed", "I lost everything I had typed", "I lost everything I had typed.", "I lost what I was typing", "everything I typed before the page refreshed is gone", "everything I had typed was lost when the page refreshed", "everything I entered before the page refreshed is gone", "everything I had typed was lost when the session expired", "what I typed when it timed out is gone", "Losing what I typed in the transfer form when the page reloads is annoying.", "I lost what I typed in the transfer form.", "I was typing a new payee and it vanished", "the transfer form has something typed in. Could it ask to confirm first?", "One of our testers lost a half-filled transfer after brushing it", "Tellers keep re-entering every transfer after a timeout; please add autosave."];
const UI_GONE = ["all my icons disappeared from the toolbar in dark mode", "every tooltip vanished after the update", "my avatar is gone after the redesign", "all my filters were removed when I refreshed the page", "all my notifications disappeared after I muted the channel", "the logo disappeared from the header", "the export button is gone from the toolbar", "dark mode icons are missing", "all my charts vanished in dark mode", "The icons are gone in dark mode", "the logo in the header disappeared", "the button label is cut off on mobile"];
const COSMETIC = ["The down arrow icon is misaligned", "The button colour is wrong 😅", "Not a security issue, but the tooltip is misaligned", "Not really a security issue: the logo is blurry", "Not really a security issue: the tooltip overlaps the logo", "No data was lost, but the export button is misaligned."];
const FEATURE_REQUESTS = ["Can we add a confirm dialog before deleting a project?", "Would be nice to have dark mode", "Please don't delete my files without asking — add a confirm step", "Add a warning before closing an unsaved form", "The Save button copy should say Submit", "Could the Save button say Saved instead of Done?", "Someone could easily delete customer records; add a confirm", "Please add a way to delete old files", "No security issue here, but can we rename the button"];

for (const text of [...TRANSIENT_OBJECT_LOSS, ...TYPED_INPUT]) test(`losing typed input is capped: ${JSON.stringify(text)}`, () => {
  assert.equal(calibrateSeverity({ text, type: "Bug", severity: "urgent" }), "medium");
  assert.equal(calibrateSeverity({ text, type: "Bug", severity: "high" }), "medium");
});
for (const text of [...UI_GONE, ...COSMETIC]) test(`a UI element's appearance is capped: ${JSON.stringify(text)}`, () => {
  assert.equal(calibrateSeverity({ text, type: "Bug", severity: "urgent" }), "medium");
});
for (const text of FEATURE_REQUESTS) test(`a UX or feature request is capped, as a Bug or a Story: ${JSON.stringify(text)}`, () => {
  assert.equal(calibrateSeverity({ text, type: "Bug", severity: "urgent" }), "medium");
  assert.equal(calibrateSeverity({ text, type: "Story", severity: "urgent" }), "medium");
});

// The live request behind the guard: a tester lost typed input, and asks for a confirmation step.
const LOG_OUT_TESTER = 'The "Log out" button logs you out straight away. One of our testers lost a half-filled transfer. Could it ask to confirm first when the form has input?';
const TEST_B = 'The "Log out" button in the banking header signs you out immediately, even when you\'re halfway through a transfer on Move tokens.\n\nOne of our testers lost a half-filled transfer after brushing it on a trackpad. It would be nicer if it asked "Leave this transfer?" when the form has unsaved input, and logged out straight away otherwise.';

test("the Log out confirmation request and live Test B stay capped", () => {
  for (const text of [LOG_OUT_TESTER, TEST_B]) for (const severity of ["urgent", "high"] as const) assert.equal(calibrateSeverity({ text, type: "Bug", severity }), "medium", text.slice(0, 40));
});

test("a model title naming data loss lifts no cap: the template reads an already capped choice and only lowers it", () => {
  // planFiling (factory-desk intake-triage.ts) caps over the reporter's text first, then hands the template that choice.
  const capped = calibrateSeverity({ text: LOG_OUT_TESTER, type: "Bug", severity: "urgent" });
  assert.equal(capped, "medium");
  const answers = { issueType: { choice: "Bug", probabilities: { Bug: 0.99 } }, severity: { choice: capped, probabilities: { urgent: 0.62 } }, gate: { choice: "proceed", probabilities: { proceed: 1 } } } as unknown as JevAnswers;
  const verdict = templateVerdict({ identifier: "T-1", title: "Log out deletes all data", description: LOG_OUT_TESTER }, answers)!;
  assert.equal(verdict.severity, "medium");
  assert.match(verdict.summary, /, medium severity\.$/, "the summary names the same severity as the verdict");
  assert.equal(severityCeiling({ text: `Log out deletes all data\n${LOG_OUT_TESTER}`, type: "Bug" }), "urgent", "read together with the reporter's words the title would lift the cap, which is why the cap is taken over the reporter's text first");
});

// ---- Generated: a clause about a draft, typing, unsaved input, or filling in a form, before or after each loss clause, joined by a conjunction, a subordinator, a comma, a full stop, a semicolon, or a dash, never caps it. ----

const LOSS_CLAUSES = ["all my payees were deleted", "my payees were deleted", "all my existing payees were deleted", "my payees disappeared from the page", "all my contacts were deleted", "I lost my payees", "we lost all our contacts", "my saved transactions were wiped", "payments were deleted", "all payments were deleted", "every transaction record was deleted", "my account type was deleted", "all my saved payees were gone"];
const TRANSIENT_CLAUSES = ["I was filling in a draft", "I saved a draft", "I opened a draft", "I was typing a note", "I had typed a new payee", "the form had unsaved input", "I was filling out the transfer form", "there were unsaved changes", "I was typing", "I opened the drafts tab", "my draft was still open"];
const JOINERS = [" and ", " while ", " when ", ", ", ". ", " then ", " so ", " as ", " after ", " but ", "; ", " - "];
const GENERATED = LOSS_CLAUSES.flatMap((loss) => TRANSIENT_CLAUSES.flatMap((transient) => JOINERS.flatMap((join) => [`${transient}${join}${loss}`, `${loss}${join}${transient}`])));

test("generated: a transient clause before or after a loss clause never caps the loss", () => {
  assert.ok(GENERATED.length > 3000, `${GENERATED.length} probes`);
  for (const text of GENERATED) assert.equal(severityCeiling({ text, type: "Bug" }), "urgent", text);
});

const EVERY_PROBE = [...STORED_LOSS, ...MORE_STORED_LOSS, ...LOSS_BEFORE_A_TYPING_CLAUSE, ...LOSS_AFTER_A_TRANSIENT_CLAUSE, ...LOSS_IN_OTHER_WORDS, ...EXPECTED_STATE_OR_PAST_ENTRY, ...LEGIT_HIGH, ...AMBIGUOUS_LOSS, ...NO_EVIDENCE, ...TRANSIENT_OBJECT_LOSS, ...TYPED_INPUT, ...UI_GONE, ...COSMETIC, ...FEATURE_REQUESTS, LOG_OUT_TESTER, TEST_B, ...GENERATED];

test("generated: the guard never raises, for every probe, type, and severity", () => {
  for (const text of EVERY_PROBE) {
    for (const type of TYPES) {
      for (const severity of SEVERITIES) {
        const out = calibrateSeverity({ text, type, severity });
        assert.ok(RANK[out] <= RANK[severity], `${type} ${severity} -> ${out}: ${text}`);
      }
    }
  }
});

test("many negated phrases in a long report are read in linear time", () => {
  const started = performance.now();
  for (const phrase of ["not a security issue ", "no data was lost ", "lost my draft "]) severityCeiling({ text: phrase.repeat(20_000), type: "Bug" });
  assert.ok(performance.now() - started < 1_500, `${Math.round(performance.now() - started)} ms`);
});

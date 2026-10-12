import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrateSeverity, severityCeiling, templateVerdict, type JevAnswers } from "./jev-triage.js";
import { asksToFile } from "./reaction-targets.js";
import type { TriageSeverity } from "./triage-verdict.js";


// `type` defaults to Bug. A Story row shows that no loss or critical phrase
// was read (its type caps it); a Bug row with no evidence keeps Jev's severity.
type Row = { text: string; ceiling: TriageSeverity; type?: string; why?: string };

const HOLDS: Row[] = [
  { text: "Site is down from the deploy", ceiling: "urgent" },
  { text: "The site is down two hours", ceiling: "urgent" },
  { text: "The app is down 3 hours", ceiling: "urgent" },
  { text: "No, actually the site is down", ceiling: "urgent" },
  { text: "Nobody can log in", ceiling: "urgent" },
  { text: "Not a security issue, it's a data leak of tokens", ceiling: "urgent" },
  // A drop in a measure reads as "down" and is left to Jev: the drop machinery capped real outages.
  { text: "Traffic is down from 10k to 2k", ceiling: "urgent", why: "left to Jev" },
  { text: "App down to one column", ceiling: "urgent", why: "left to Jev" },
  { text: "Site down to zero requests", ceiling: "urgent", why: "down to zero is an outage" },
  { text: "Payments are down 100% since the deploy", ceiling: "urgent", why: "down 100% is an outage" },
  { text: "Signups are down to 0 today", ceiling: "urgent", why: "down to 0 is an outage" },
  { text: "Latency went down from 900ms to 200ms", ceiling: "urgent", why: "left to Jev" },
  { text: "Errors are down from 40% to 10%", ceiling: "urgent", why: "left to Jev" },
  { text: "Signups are down from last week", ceiling: "urgent", why: "the same words after a service are an outage start (Bugbot)" },
  { text: "The site is down from last week's release", ceiling: "urgent", why: "an outage start (Bugbot)" },
  { text: "Conversion is down to 0.5%", ceiling: "urgent", why: "left to Jev" },
  { text: "Price went down to 0.25 per unit", ceiling: "urgent", why: "left to Jev" },
  { text: "The site is down from yesterday evening", ceiling: "urgent", why: "a start time, not a comparison" },
  { text: "Nobody lost any data", ceiling: "medium", type: "Story", why: "nobody negates the loss" },
  { text: "Nobody lost any data", ceiling: "urgent", why: "a negation is not evidence: a Bug keeps Jev's severity" },
  { text: "Not really a security issue: the logo is blurry", ceiling: "medium", why: "a UI element's appearance" },
  { text: "The label says 保存", ceiling: "medium", type: "Story" },
  { text: "The label says 保存", ceiling: "urgent", why: "no evidence: a Bug keeps Jev's severity" },
  { text: "ログイン画面 is slow", ceiling: "urgent", why: "≥4 non-Latin letters: no cap (fail-open)" },
];

// REGRESSIONS: genuine outages capped to medium at 9f892e4 (`down from <digit>` read as a number drop).
const REGRESSIONS: Row[] = [
  { text: "The site was down from 9 to 11 this morning", ceiling: "urgent" },
  { text: "API is down from 10:30 UTC", ceiling: "urgent" },
  { text: "Checkout down from 2pm until now", ceiling: "urgent" },
  { text: "The portal was down from 9am to 11:15am AEST", ceiling: "urgent" },
];

for (const row of HOLDS) test(`guard holds: ${JSON.stringify(row.text)} as ${row.type ?? "Bug"} → ${row.ceiling}${row.why === undefined ? "" : ` (${row.why})`}`, () => assert.equal(severityCeiling({ text: row.text, type: row.type ?? "Bug" }), row.ceiling));
for (const row of REGRESSIONS) test(`guard: ${JSON.stringify(row.text)} → ${row.ceiling} (outage time range capped)`, () => assert.equal(severityCeiling({ text: row.text, type: "Bug" }), row.ceiling));

test("guard never raises over every row", () => {
  const rank = { low: 0, medium: 1, high: 2, urgent: 3 } as const;
  for (const row of [...HOLDS, ...REGRESSIONS]) for (const type of ["Bug", "Story", "question"]) for (const severity of ["low", "medium", "high", "urgent"] as const) assert.ok(rank[calibrateSeverity({ text: row.text, type, severity })] <= rank[severity]);
});

const TEST_B = 'The "Log out" button in the banking header signs you out immediately, even when you\'re halfway through a transfer on Move tokens.\n\nOne of our testers lost a half-filled transfer after brushing it on a trackpad. It would be nicer if it asked "Leave this transfer?" when the form has unsaved input, and logged out straight away otherwise.';

test("live Test B stays ≤ medium", () => {
  const answers = { issueType: { choice: "Bug", probabilities: { Bug: 0.99 } }, severity: { choice: "urgent", probabilities: { urgent: 0.62 } }, gate: { choice: "proceed", probabilities: { proceed: 0.97 } } } as unknown as JevAnswers;
  assert.equal(templateVerdict({ identifier: "T-1", title: TEST_B.split("\n")[0]!, description: TEST_B }, answers)?.severity, "medium");
  assert.equal(severityCeiling({ text: TEST_B, type: "Bug" }), "medium");
});

test("reaction-only detection: whole line within the last three only", () => {
  const ask = "React ✅ to file or ❌ to drop.";
  assert.ok(asksToFile(`x\n${ask}\nThanks`));
  assert.ok(asksToFile(`x\n${ask}\na\nb`));
  assert.equal(asksToFile(`x\n${ask}\na\nb\nc`), false);
  assert.equal(asksToFile(`> ${ask}`), false);
  assert.equal(asksToFile(`Please ${ask}`), false);
  assert.equal(asksToFile("React ✅ to start the build or ❌ to stop."), false, "the plan post's ask is not a filing prompt");
});

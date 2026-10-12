import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrateSeverity, severityCeiling } from "./jev-triage.js";
import type { TriageSeverity } from "./triage-verdict.js";

type Row = { text: string; ceiling: TriageSeverity };

// "Down" with a time, a range, a quantity, or a percentage. Rounds 3 to 6 told
// clock times (outages) from quantities (a drop in a measure) by regex and
// capped the drops; each cut capped a real outage ("down from 9 to 11", "from
// 1000 to 500" as a clock). Under the cap-on-evidence contract every one of
// these is left at Jev's severity as a Bug: the ones with an outage phrase
// because of it, the rest because nothing in them is evidence of a cosmetic
// report. A drop left at urgent is Low under the rubric; a capped outage was High.
const ROWS: Row[] = [
  { text: "The site was down from 9 to 11", ceiling: "urgent" },
  { text: "Site down from 9:00 to 11:00", ceiling: "urgent" },
  { text: "Site down from 09:00 to 11:00", ceiling: "urgent" },
  { text: "API down from 1030 UTC", ceiling: "urgent" },
  { text: "API is down from 0900 to 1100 UTC", ceiling: "urgent" },
  { text: "API is down from 0900 to 1100 AEST", ceiling: "urgent" },
  { text: "Site was down from 1000 to 1130pm", ceiling: "urgent" },
  { text: "Checkout down from 14:00", ceiling: "urgent" },
  { text: "Server was down from 2am until 4am", ceiling: "urgent" },
  { text: "Site down to zero", ceiling: "urgent" },
  { text: "The site is down 100%", ceiling: "urgent" },
  { text: "Payments down 100 percent", ceiling: "urgent" },
  { text: "The app is down 2 days", ceiling: "urgent" },
  { text: "App is down to 0.5 fps", ceiling: "urgent" },
  { text: "Traffic is down from 10k to 2k", ceiling: "urgent" },
  { text: "Traffic is down from 1000 to 500", ceiling: "urgent" },
  { text: "Revenue is down from 500 to 300", ceiling: "urgent" },
  { text: "Signups down from 1,200 to 900", ceiling: "urgent" },
  { text: "Signups went down, dropped from 1200 to 300", ceiling: "urgent" },
  { text: "Orders are down from 1200 to 300", ceiling: "urgent" },
  { text: "Conversion is down from 5% to 3%", ceiling: "urgent" },
  { text: "Latency is down from 300ms to 120ms", ceiling: "urgent" },
  { text: "App down 12%", ceiling: "urgent" },
];

for (const row of ROWS) test(`down with a time or quantity is left to Jev: ${JSON.stringify(row.text)} → ${row.ceiling}`, () => {
  assert.equal(severityCeiling({ text: row.text, type: "Bug" }), row.ceiling);
  for (const severity of ["low", "medium", "high", "urgent"] as const) assert.equal(calibrateSeverity({ text: row.text, type: "Bug", severity }), severity);
});

test("the time and quantity rows never raise", () => {
  const rank = { low: 0, medium: 1, high: 2, urgent: 3 } as const;
  for (const row of ROWS) for (const type of ["Bug", "Story", "question"]) for (const severity of ["low", "medium", "high", "urgent"] as const) assert.ok(rank[calibrateSeverity({ text: row.text, type, severity })] <= rank[severity]);
});

// A top-level bug report in #mars-eng-intake (2026-09-27 22:03:57 AEST) with
// no filing phrase. On fd1adbf it got no Jev triage, no 👀, and the old ask.

export const LIVE_INTAKE_CHANNEL = "C0EXAMPLE1";
export const LIVE_INTAKE_TS = "1790510637.708999";

export const LIVE_INTAKE_TITLE = 'Transfer form: the "Transfer reference" field silently stops accepting text at 60 characters, with no hint of the limit.';

export const LIVE_INTAKE_SUMMARY =
  "in `components/banking/transfer-form.tsx` the `#transfer-description` input has `maxLength={60}` but nothing tells the user about the cap, so longer references just get cut off mid-typing.";

export const LIVE_INTAKE_TEXT = [
  `<@U0EXAMPLE2|factory> ${LIVE_INTAKE_TITLE}`,
  "",
  `_On main:_ ${LIVE_INTAKE_SUMMARY}`,
  "",
  "_Repro:_ sign in as Cameron, open Transfer, type a long note into Transfer reference: typing stops at 60 characters with no feedback.",
  "",
  "_Expected:_ show a small live character count under the field (e.g. `12/60`), linked to the input via `aria-describedby`. Keep the 60 limit and existing copy. Add a test in `components/banking/transfer-form.test.tsx` that the counter updates as you type. No other behavior changes.",
  "",
  "[reaction-e2e A2 20260927-2206] Please take this through to In Review; don't merge.",
  "*Sent using* <@U0EXAMPLE1|Cursor>",
].join("\n");

// #mars-eng-intake on c83562b (2026-09-27 23:48–23:54 AEST), as Slack's raw
// `text` carries them: `<` and `>` typed by the reporter arrive as `&lt;` and
// `&gt;`. A's title and both `_On main:_` lines are verbatim; the other lines stand in for the rest.
// A's summary was cut mid-word at 200 characters and B's showed the entities
// and stopped at "e.g.".

export const LIVE_CARDS_TEXT = [
  '<@U0EXAMPLE2|factory> Cards: every "Freeze card" button has the same accessible name, so screen-reader users can\'t tell which card a button will freeze.',
  "",
  '_On main:_ in `components/banking/card-panel.tsx` the `.freeze-button` renders only "Freeze card" / "Unfreeze card" with no link to the card it belongs to, while the card label (`cardFormLabel(card)`) sits in the `&lt;strong&gt;` inside `.card-meta` right above it.',
  "",
  "_Repro:_ sign in, open Cards, and move through the freeze buttons with a screen reader.",
].join("\n");

export const LIVE_SURVEY_TEXT = [
  "<@U0EXAMPLE2|factory> Survey: the frequency select is announced only by its value.",
  "",
  '_On main:_ `components/banking/survey-select.tsx` sets `aria-label={selected?.label}` on the trigger `&lt;button&gt;`, which replaces any visible label, so it is announced as just e.g. "Weekly". Nothing names the field.',
].join("\n");

export const LIVE_SURVEY_SUMMARY = '`components/banking/survey-select.tsx` sets `aria-label={selected?.label}` on the trigger `<button>`, which replaces any visible label, so it is announced as just e.g. "Weekly".';

// #mars-eng-intake on the hosted desk (2026-09-28 02:06 AEST): both filing
// prompts showed these first lines cut mid-word at 160 characters with no
// ellipsis ("…and the list re", "…rather than not se"). The first 160
// characters are verbatim; the rest of each line and the bodies stand in.

export const LIVE_ACTIVITY_TITLE =
  'On the Activity page the "Sol 214"-style day separators are plain divs, so screen reader users can\'t jump between days with the heading shortcut and the list reads as one unbroken run of transactions.';

export const LIVE_ACTIVITY_TEXT = [
  `<@U0EXAMPLE2|factory> ${LIVE_ACTIVITY_TITLE}`,
  "",
  "_On main:_ in `components/banking/activity-list.tsx` each day label is a `div.day-separator` with no heading role or level.",
  "",
  "_Expected:_ render each day label as an `h3` so the heading shortcut moves between days.",
].join("\n");

export const LIVE_ACCOUNTS_TITLE =
  'Small one on Accounts: a home loan with no linked offset account shows "Offset 0.00" in the Held column, which reads like the offset is empty rather than not set up.';

export const LIVE_ACCOUNTS_TEXT = [
  `<@U0EXAMPLE2|factory> ${LIVE_ACCOUNTS_TITLE}`,
  "",
  '_On main:_ `components/banking/accounts-table.tsx` falls back to `0` when `offsetAccountId` is missing. Show "No offset account" there instead.',
].join("\n");

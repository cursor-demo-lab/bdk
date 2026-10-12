import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChoiceAnswer } from "@cursor/july/extensions/jev";
import { readFileSync } from "node:fs";
import { DESK_TRIAGED_LINE as DESK_TRIAGED } from "./desk-triaged.js";
import { NEEDS_INFO_LINE, REPORTER_REQUEST_END, REPORTER_REQUEST_LABEL, SLOT, capitalizedTitle, copiesRequest, dropIntakeTriage, settleFiling, reporterRequest, withReporterRequest, filingPrompt, pendingIntake, stashIntakeTriage, intakeText, intakeTriageContext, planFiling, requestSummary, fittedRequestTitle, unaskedFilingPrompt, type IntakeTriage } from "./intake-triage.js";
import { LIVE_CARDS_TEXT, LIVE_INTAKE_SUMMARY, LIVE_INTAKE_TEXT, LIVE_INTAKE_TITLE, LIVE_SURVEY_SUMMARY, LIVE_SURVEY_TEXT } from "./live-intake.fixtures.js";

// The filing prompt is host text: Jev's triage fills every line, the model's
// fills only the slots it is given, and a request with no intake block gets
// the same lines from instructions.md. desk/file-ticket-asks-first gates on
// this shape (the verdict in plain words, `Summary:`, `approve file`).

const TEXT = "<@U0FACTORY> file a bug: Card export CSV drops the last row\nSince the 26th, every export.";
const OPTIONS = { text: TEXT };
const ASK = "React ✅ to file or ❌ to drop, or reply `approve file` / `deny file`.";
// The Slack filing prompt (the intake block) also takes a ✅ or ❌ on it.
const REACT_ASK = "React ✅ to file or ❌ to drop, or reply `approve file` / `deny file`.";
const TYPES = { source: "project" as const, types: [{ name: "Task" }, { name: "Bug" }] };
const answer = (choice: string, p: number): ChoiceAnswer => ({ choice, probabilities: { [choice]: p } }) as ChoiceAnswer;
const jevPart = (type: [string, number], severity: [string, number]) => ({ answers: { issueType: answer(...type), severity: answer(...severity), gate: answer("proceed", 0.9) }, source: "webhook" as const, types: TYPES });

const between = (context: string) => context.slice(context.indexOf("<filing_prompt>\n") + "<filing_prompt>\n".length, context.indexOf("\n</filing_prompt>"));

test("filingPrompt: title, who triaged it and the verdict, Summary:, the needs-info line when thin, then the ask", () => {
  const fields = { title: "Card export CSV drops the last row", lead: "Triaged by Jev", type: "Bug", severity: "low", summary: "The export drops its last row.", ask: ASK };
  assert.equal(
    filingPrompt(fields),
    ["Card export CSV drops the last row", "Triaged by Jev: Bug, low severity.", "Summary: The export drops its last row.", ASK].join("\n")
  );
  assert.equal(filingPrompt({ ...fields, needsInfo: true }).split("\n")[3], NEEDS_INFO_LINE);
});

test("Jev confident, with a body: the host writes the whole prompt, the summary the request's own first sentence after the title", () => {
  const triage: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.99], ["low", 0.54]), type: "Bug", severity: "low", needsInfo: false, title: "Card export CSV drops the last row", summary: "Since the 26th, every export." };
  const context = intakeTriageContext(triage, OPTIONS);
  assert.equal(between(context), [SLOT.title, "Triaged by Jev: Bug, low severity (54% confidence).", "Summary: Since the 26th, every export.", REACT_ASK].join("\n"));
  assert.match(context, /Jev gives no title, so you write only that\. Your whole reply is the filing prompt below with the title slot filled and every other character kept/);
  assert.doesNotMatch(context, /<Type>|<severity>|<one sentence|triage_rubric|0\.99|0\.54|approve KEY|reported as/);
  assert.equal(between(intakeTriageContext({ ...triage, needsInfo: true }, OPTIONS)).split("\n")[3], NEEDS_INFO_LINE);
});

const TLSSN_37 = '<@U0FACTORY> file a bug: [e2e-155 2026-09-26] Settings "All six registers restored." confirmation is not announced to screen readers.';

test("TLSSN-37: Jev confident on a request that is only its title: the turn writes just the summary, never the title template", async () => {
  const title = '[e2e-155 2026-09-26] Settings "All six registers restored." confirmation is not announced to screen readers.';
  assert.equal(requestSummary(title, title), undefined, "nothing after the title to summarize");
  const triage: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["medium", 0.6]), type: "Bug", severity: "medium", needsInfo: false, title };
  const context = intakeTriageContext(triage, { ...OPTIONS, text: TLSSN_37 });
  assert.equal(between(context), [SLOT.title, "Triaged by Jev: Bug, medium severity (60% confidence).", `Summary: ${SLOT.summary}`, REACT_ASK].join("\n"));
  assert.match(context, /Jev gives no title or summary, so you write only those\. Your whole reply is the filing prompt below with the title and summary slots filled and every other character kept/);
  assert.match(context, /Never copy a sentence from the request, never the title line again, and never the type or severity\./);
  assert.doesNotMatch(context, /reported as|<Type>|<severity>|triage_rubric/);
  // A thread stashed before this fix still holds the title template: it is not a summary.
  const stale = intakeTriageContext({ ...triage, summary: `Bug reported as "${title}", medium severity.` }, { ...OPTIONS, text: TLSSN_37 });
  assert.equal(between(stale).split("\n")[2], `Summary: ${SLOT.summary}`);
});

test("requestSummary: the first sentence after the title; nothing for a title alone, a repeat of it, or Slack's footer", () => {
  const title = "Card export CSV drops the last row";
  assert.equal(requestSummary(title, `${title}\nSince the 26th, every export loses its final line. Alice noticed it first.`), "Since the 26th, every export loses its final line.");
  assert.equal(requestSummary(title, `${title}\n*Sent using* Cursor`), undefined);
  assert.equal(requestSummary(title, `${title}\ncard export: CSV drops the last row!`), undefined, "a body that only repeats the title");
  assert.equal(requestSummary(title, `${title}\nno punctuation here`), "No punctuation here");
  assert.equal(requestSummary(title, `${title}\n${"x".repeat(300)}.`)?.length, 200);
});

test("planFiling on Jev's triage: the request's summary, else the turn's, else the template for the Triage: comment only", () => {
  const jev = jevPart(["Bug", 0.97], ["medium", 0.6]);
  const title = "Settings restore confirmation is not announced";
  const model = { title, kind: "bug" as const, severity: "low" as const, summary: "Screen readers stay silent after the six registers are restored." };
  const base: IntakeTriage = { by: "jev", jev, type: "Bug", severity: "medium", needsInfo: false, title };
  assert.equal(planFiling({ ...base, summary: "It happens on every restore." }, model).verdict.summary, "It happens on every restore.");
  const fromTurn = planFiling(base, model);
  assert.equal(fromTurn.verdict.summary, "Screen readers stay silent after the six registers are restored.");
  assert.equal(fromTurn.summaryFromTemplate, undefined);
  const repeated = planFiling(base, { ...model, summary: "Settings restore confirmation is NOT announced." });
  assert.equal(repeated.verdict.summary, 'Bug reported as "Settings restore confirmation is not announced", medium severity.');
  assert.equal(repeated.summaryFromTemplate, true);
  assert.equal(planFiling({ ...base, summary: `Bug reported as "${title}", medium severity.` }, model).verdict.summary, model.summary, "a stale stashed template gives way to the turn's summary");
});

test("Jev below the bar: the host writes every line but the severity and summary slots; a type Jev was sure of is filled in", () => {
  const context = intakeTriageContext({ by: "model", reason: "below_bar", jev: jevPart(["Bug", 0.99], ["low", 0.5]) }, OPTIONS);
  assert.equal(
    between(context),
    [SLOT.title, "Triaged by Grok 4.6 Fast (Jev was only 50% confident): Bug, <severity> severity.", `Summary: ${SLOT.summary}`, REACT_ASK].join("\n")
  );
  assert.match(context, /Bug is fixed: Jev was sure of the Jira type/);
  assert.match(context, /each <…> slot filled and every other character kept/);
  assert.match(context, /<triage_rubric>\n# Triage rubric/);
  assert.doesNotMatch(context, /0\.99|0\.50/);
});

test("Jev error: the model fills the type, severity, and summary slots; the lead says Jev didn't answer", () => {
  const context = intakeTriageContext({ by: "model", reason: "unavailable" }, OPTIONS);
  assert.equal(
    between(context),
    [SLOT.title, "Triaged by Grok 4.6 Fast (Jev didn't answer): <Type>, <severity> severity.", `Summary: ${SLOT.summary}`, REACT_ASK].join("\n")
  );
  assert.match(context, /<Type>: Bug for a bug, Task for feedback or a question\./);
  assert.match(context, new RegExp(`add this line after the summary, exactly: ${NEEDS_INFO_LINE.replace(/[.,]/g, "\\$&")}`));
});

test("a request with no words after the filing phrase leaves the title to the model; the ask is the current decision only", () => {
  const context = intakeTriageContext({ by: "model", reason: "no_key" }, { text: "<@U0FACTORY> file a bug:" });
  assert.equal(between(context).split("\n")[0], SLOT.title);
  assert.match(context, /<a short title in your own words>: a short title in your own words, under 80 characters/);
  assert.match(between(context), /\nReact ✅ to file or ❌ to drop, or reply `approve file` \/ `deny file`\.$/);
  assert.doesNotMatch(context, /Once it is filed|planned|no mention needed/);
});

test("a request with no intake block gets the same lines, every field a slot, and still offers ✅/❌", () => {
  assert.equal(
    unaskedFilingPrompt(),
    [SLOT.title, "Triaged by Grok 4.6 Fast (Jev wasn't asked): <Type>, <severity> severity.", `Summary: ${SLOT.summary}`, REACT_ASK].join("\n")
  );
  assert.match(unaskedFilingPrompt(), /\nReact ✅ to file or ❌ to drop, or reply `approve file` \/ `deny file`\.$/);
  assert.match(readFileSync(new URL("../instructions.md", import.meta.url), "utf8"), /React ✅ to file or ❌ to drop, or reply `approve file` \/ `deny file`\./);
});

test("a block for a message with no filing phrase lets a non-report be answered normally; one that says file a bug does not", () => {
  const jev: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["medium", 0.6]), type: "Bug", severity: "medium", needsInfo: false };
  const escape = /^<intake_triage by="\w+">\nIf this message names no problem and asks for no change \(thanks, a greeting, a question about the desk itself\), ignore this block and answer it by its own rule\. Any problem report or change request gets the filing prompt below\.\n/;
  for (const triage of [jev, { by: "model", reason: "unavailable" } as const]) {
    assert.match(intakeTriageContext(triage, OPTIONS), escape);
    const explicit = intakeTriageContext(triage, { ...OPTIONS, explicit: true });
    assert.doesNotMatch(explicit, /ignore this block/, "a message that asked to file a bug is a filing request");
    assert.match(explicit, /^<intake_triage by="\w+">\n(?:Host code triaged|Jev did not settle)/);
  }
  assert.match(intakeTriageContext({ ...jev, summary: "The last row is missing from every export." }, OPTIONS), /Your whole reply is the filing prompt below with the title slot filled and every other character kept/, "Jev's path still asks for the rest of the prompt verbatim");
});

test("requestSummary keeps a bracket that is not a run tag opening its line", () => {
  assert.equal(requestSummary("Export fails", "Export fails\nIt 500s in [read-only mode] on every run."), "It 500s in [read-only mode] on every run.");
  assert.equal(requestSummary("Export fails", "Export fails\n_Repro:_\nopen Export and press Go."), "Open Export and press Go.", "a label alone on its line");
  assert.equal(requestSummary("La exportación falla", "La exportación falla\n_Pasos:_ abrir Exportar y pulsar Ir."), "Abrir Exportar y pulsar Ir.");
  assert.equal(requestSummary("Export fails", "Export fails\n`exportCsv()` throws on an empty filter."), "`exportCsv()` throws on an empty filter.", "a code span is the reporter's words");
});

test("requestSummary drops Slack line labels and run tags: the live report's summary is its On main sentence, not the title or the repro", () => {
  const { title, description } = intakeText(LIVE_INTAKE_TEXT);
  assert.equal(title, LIVE_INTAKE_TITLE);
  assert.equal(requestSummary(title, description), `I${LIVE_INTAKE_SUMMARY.slice(1)}`);
  assert.equal(requestSummary("Export fails", "Export fails\n*Repro:* open Export and press Go.\n_Expected:_ a file."), "Open Export and press Go.");
  assert.equal(requestSummary("Export fails", "Export fails\n*Repro*: open Export and press Go."), "Open Export and press Go.");
  assert.equal(requestSummary("Export fails", "Export fails\n[reaction-e2e A2 20260927-2206] It 500s on every run."), "It 500s on every run.");
  assert.equal(requestSummary("Export fails", "Export fails\n*Summary:* Export fails."), undefined, "a labelled line that only repeats the title is no summary");
  const triage: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["medium", 0.6]), type: "Bug", severity: "medium", needsInfo: false, title, summary: requestSummary(title, description)! };
  assert.equal(between(intakeTriageContext(triage, { text: LIVE_INTAKE_TEXT })).split("\n")[2], `Summary: ${SLOT.summary}`, "a stale stash that lifted the body's sentence is dropped");
});

test("live #mars-eng-intake A: a summary over the limit is cut at a word boundary, outside any code span, capitalised, entities decoded", () => {
  const { title, description } = intakeText(LIVE_CARDS_TEXT);
  assert.doesNotMatch(description, /&lt;|&gt;/, "Jev reads the reporter's < and >");
  const summary = requestSummary(title, description)!;
  assert.equal(summary, 'In `components/banking/card-panel.tsx` the `.freeze-button` renders only "Freeze card" / "Unfreeze card" with no link to the card it belongs to, while the card label (`cardFormLabel(card)`) sits in…');
  assert.ok(summary.length <= 200);
  assert.equal((summary.match(/`/g)?.length ?? 0) % 2, 0, "no unbalanced backtick");
});

test("live #mars-eng-intake B: entities decoded, and the sentence runs past e.g. to its real end", () => {
  const { title, description } = intakeText(LIVE_SURVEY_TEXT);
  assert.equal(requestSummary(title, description), LIVE_SURVEY_SUMMARY);
});

test("requestSummary ends a sentence only outside code spans and abbreviations, and never leaves a code span open when it cuts", () => {
  const title = "Export fails";
  assert.equal(requestSummary(title, `${title}\nIt fails, i.e. every run. Then more.`), "It fails, i.e. every run.");
  assert.equal(requestSummary(title, `${title}\nsee \`a. b\` and Dr. Who etc. and vs. them. Next.`), "See `a. b` and Dr. Who etc. and vs. them.");
  assert.equal(requestSummary(title, `${title}\nHe said "stop." Then it broke.`), 'He said "stop."');
  const long = `${title}\nThe export ${"word ".repeat(34)}then \`someVeryLongIdentifierName(argument, other)\` breaks.`;
  const cut = requestSummary(title, long)!;
  assert.ok(cut.length <= 200 && cut.endsWith("…"));
  assert.doesNotMatch(cut, /`/, "the open code span is dropped whole");
  assert.match(cut, /word then…$/);
  assert.equal(intakeText("<@U0FACTORY> Export fails\n&amp;lt;b&amp;gt; &lt;i&gt; is shown").description, "Export fails\n&lt;b&gt; <i> is shown", "decoded once");
});

test("requestSummary: Slack markup reads as plain text that pings no one; initials, fences, quotes, and a lone backtick do not break the sentence", () => {
  const title = "Export fails";
  const summary = (body: string) => {
    const text = intakeText(`<@U0FACTORY> ${title}\n${body}`);
    return requestSummary(text.title, text.description);
  };
  assert.equal(summary("<!here> ask <@U0ABC123> or <@U0BOB0001|bob> in <#C0ABC|eng>, see <https://x.io/a?b=1&amp;c=2|the doc> or <https://x.io>. More."), "@here ask @U0ABC123 or @bob in #eng, see the doc or https://x.io.", "no `<…>` left for Slack to read as markup");
  assert.equal(intakeText("<@U0FACTORY> See <https://x.io/?a=1&amp;b=2> for `&lt;b&gt;`").title, "See https://x.io/?a=1&b=2 for `<b>`");
  assert.equal(summary("shows `&amp;lt;` in code. More."), "Shows `&lt;` in code.", "an entity in a code span is decoded once too");
  assert.equal(summary("In the U.S. region it fails at 3 p.m. daily. More."), "In the U.S. region it fails at 3 p.m. daily.");
  assert.equal(summary("```\nconst x = 1;\nfoo()\n```"), undefined, "a paste alone is no summary; the turn writes one");
  assert.equal(summary(`\`${"x".repeat(250)}\` breaks`), undefined, "not a bare `…`");
  assert.equal(summary("&gt; quoted line broke it. More."), "Quoted line broke it.");
  assert.equal(summary("The `x` fails `unclosed code. More."), "The `x` fails `unclosed code.", "an unpaired backtick opens no code span");
  assert.equal(summary("iOS export fails. More."), "iOS export fails.", "a name spelled lowercase-first stays so");
});

test("requestSummary: a period inside a link label, a display name, or an initial ends no sentence; typed markup stays inert", () => {
  const title = "Export fails";
  const summary = (body: string) => {
    const text = intakeText(`<@U0FACTORY> ${title}\n${body}`);
    return requestSummary(text.title, text.description)?.replaceAll("\u2060", "");
  };
  assert.equal(summary("Reported by <@U0ABC123|J. Smith> after the deploy. More."), "Reported by @J. Smith after the deploy.");
  assert.equal(summary("See <https://x.io/a|Read me. Now> for the steps. More."), "See Read me. Now for the steps.");
  assert.equal(summary("Reported by J. Smith yesterday. More."), "Reported by J. Smith yesterday.");
  const typed = intakeText(`<@U0FACTORY> ${title}\nTyping &lt;!here&gt; or &lt;https://x.io&gt; or &lt;@U0ABC123&gt; breaks it.`).description;
  assert.doesNotMatch(typed, /<(?:!|@|https:)/, "what the reporter typed is never live Slack markup");
  assert.equal(typed.replaceAll("\u2060", ""), `${title}\nTyping <!here> or <https://x.io> or <@U0ABC123> breaks it.`, "and reads the same");
});

test("the filing ask never carries a mention and never looks past this prompt, in any channel", () => {
  for (const triage of [{ by: "model", reason: "no_key" } as const, { by: "jev", jev: jevPart(["Bug", 0.97], ["low", 0.9]), type: "Bug", severity: "low", needsInfo: false } as const]) {
    const context = intakeTriageContext(triage, { text: TEXT });
    assert.equal(between(context).split("\n").at(-1), "React ✅ to file or ❌ to drop, or reply `approve file` / `deny file`.");
    assert.doesNotMatch(context, /@factory|Once it is filed|start the build|no mention needed/);
  }
});

function memoryKv() {
  const rows: Record<string, unknown> = {};
  return { rows, kv: { get: async (key: string) => rows[key], put: async (key: string, value: unknown) => void (rows[key] = value), delete: async (key: string) => void delete rows[key] } as never };
}

test("a filed DM request stops being pending in every thread a copy of its triage was kept for", async () => {
  const { kv } = memoryKv();
  const now = new Date("2026-09-27T12:00:00Z");
  const triage: IntakeTriage = { by: "model", reason: "below_bar" };
  const report = { ts: "1758510100.000100", text: "CSV export returns 500 when the filter matches no rows" };
  await stashIntakeTriage(kv, [{ channelId: "D0DM00001", threadTs: report.ts }, { channelId: "D0DM00001" }], triage, now, report);
  await stashIntakeTriage(kv, [{ channelId: "D0DM00001", threadTs: "1758510160.000100" }, { channelId: "D0DM00001" }], triage, now, report);
  await dropIntakeTriage(kv, { channelId: "D0DM00001", threadTs: report.ts }, report.ts, now);
  assert.equal(await pendingIntake(kv, [{ channelId: "D0DM00001", threadTs: "1758510160.000100" }], "1758510200.000100", now), undefined, "the follow-up's copy is settled too");
});

test("filing an earlier DM request leaves a later request pending", async () => {
  const { kv } = memoryKv();
  const now = new Date("2026-09-27T12:00:00Z");
  const triage: IntakeTriage = { by: "model", reason: "below_bar" };
  const first = { ts: "1758510100.000100", text: "CSV export returns 500" };
  const second = { ts: "1758510300.000100", text: "the login page takes ten seconds on mobile" };
  await stashIntakeTriage(kv, [{ channelId: "D0DM00001", threadTs: first.ts }, { channelId: "D0DM00001" }], triage, now, first);
  await stashIntakeTriage(kv, [{ channelId: "D0DM00001", threadTs: second.ts }, { channelId: "D0DM00001" }], triage, now, second);
  await dropIntakeTriage(kv, { channelId: "D0DM00001", threadTs: first.ts }, first.ts, now);
  assert.equal((await pendingIntake(kv, [{ channelId: "D0DM00001" }], "1758510400.000100", now))?.source.ts, second.ts);
});

test("a title that opens with a code span longer than the cap keeps its words, not a bare …, and no backtick", () => {
  const sql = `SELECT id FROM accounts WHERE offset_account_id IS NULL AND ${Array.from({ length: 60 }, (_, i) => `kind_${i} = 'loan'`).join(" AND ")}`;
  const context = intakeTriageContext({ by: "model", reason: "unavailable" }, { text: `<@U0FACTORY> file a bug: \`${sql}\` returns zero offsets\nSeen on main.`, explicit: true });
  assert.equal(context.split("<filing_prompt>\n")[1]!.split("\n")[0], SLOT.title);
  const title = fittedRequestTitle(`<@U0FACTORY> file a bug: \`${sql}\` returns zero offsets\nSeen on main.`);
  assert.ok(title.length <= 400 && title.length > 300, `${title.length}`);
  assert.ok(title.endsWith("…"));
  assert.doesNotMatch(title, /`/);
  const kept = title.slice(0, -1);
  assert.ok(sql.startsWith(kept));
  let at = 0;
  const ends = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(sql), ({ segment }) => (at += segment.length)));
  assert.ok(ends.has(kept.length), `cut mid-word: …${kept.slice(-12)}|${sql.slice(kept.length, kept.length + 8)}`);
});

// The request's own title (what Jev reads; the prompt's title is the turn's) and the summary as the filing prompt shows it for a Jev-confident request.
const titleAndSummary = (text: string) => {
  const { title, description } = intakeText(text);
  const summary = requestSummary(title, description);
  const triage: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.99], ["low", 0.9]), type: "Bug", severity: "low", needsInfo: false, title, ...(summary === undefined ? {} : { summary }) };
  const lines = between(intakeTriageContext(triage, { text, explicit: true })).split("\n");
  // The prompt never shows the request's own sentence; `requestSummary` still finds it so a lifted Summary can be caught.
  assert.equal(lines[0], SLOT.title, "the turn writes the title");
  return [fittedRequestTitle(text), summary === undefined ? lines[2] : `Summary: ${summary}`];
};
const EXPORT = "The export button does nothing on Accounts.";

test("a greeting or a bare label opening the request is not its title, and the summary is what follows the title", () => {
  for (const opener of ["Hi", "Hey team!", "Quick one:", "*Repro:*", ":wave: hey all @here"]) {
    assert.deepEqual(titleAndSummary(`<@U0FACTORY> ${opener}\n${EXPORT}\nSeen on main.`), [EXPORT, "Summary: Seen on main."], opener);
  }
  assert.deepEqual(titleAndSummary(`<@U0FACTORY> Hi team! ${EXPORT} Seen on main.`), [EXPORT, "Summary: Seen on main."], "one paragraph");
  assert.deepEqual(titleAndSummary(`<@U0FACTORY> Hi team! ${EXPORT}\nSeen on main.`), [EXPORT, "Summary: Seen on main."], "a first line that opens with one");
  assert.deepEqual(titleAndSummary(`<@U0FACTORY> Hey team, the export button does nothing. Seen on main.`), ["Hey team, the export button does nothing.", "Summary: Seen on main."], "a greeting inside the sentence stays");
  assert.equal(titleAndSummary("<@U0FACTORY> Hi team")[0], "Hi team", "a request that is only a greeting keeps it");
});

test("a one-paragraph title: a two-word sentence is enough, a bare `.` before lowercase ends it, a quote or `...` before lowercase does not", () => {
  assert.deepEqual(titleAndSummary("<@U0FACTORY> Export broken. The CSV button does nothing on Accounts."), ["Export broken.", "Summary: The CSV button does nothing on Accounts."]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> Export fails on Accounts. it also fails on Loans."), ["Export fails on Accounts.", "Summary: It also fails on Loans."]);
  assert.deepEqual(titleAndSummary('<@U0FACTORY> The "Saved." toast is silent. Seen on main.'), ['The "Saved." toast is silent.', "Summary: Seen on main."]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> The export hangs... and then fails. Seen on main."), ["The export hangs... and then fails.", "Summary: Seen on main."]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> The job fails at 3 p.m. every day, e.g. on v2.3.1 in the U.S. region. Seen on main."), ["The job fails at 3 p.m. every day, e.g. on v2.3.1 in the U.S. region.", "Summary: Seen on main."]);
});

test("a title leaves out a footer whose newline hosted delivery collapsed, a quote mark, and a fenced paste", () => {
  assert.equal(titleAndSummary("<@U0FACTORY> The export is broken on Accounts *Sent using* <@U0EXAMPLE1|Cursor>")[0], "The export is broken on Accounts");
  assert.equal(titleAndSummary("<@U0FACTORY> The email is sent using Firefox and fails. Seen on main.")[0], "The email is sent using Firefox and fails.");
  assert.deepEqual(titleAndSummary("<@U0FACTORY> &gt; The export crashes on Accounts.\nSeen on main."), ["The export crashes on Accounts.", "Summary: Seen on main."]);
  assert.equal(titleAndSummary("<@U0FACTORY> ```\nTypeError: x is undefined\n```\nThe export crashes on Accounts.")[0], "The export crashes on Accounts.");
});

test("every greeting sentence opening the title line is left out, and Jev reads the same title", () => {
  for (const openers of ["Hi team! Quick one.", "Hey all. Good morning!", "Hi! Hey team, quick one:"]) {
    assert.deepEqual(titleAndSummary(`<@U0FACTORY> ${openers} ${EXPORT} Seen on main.`), [EXPORT, "Summary: Seen on main."], openers);
    assert.equal(intakeText(`<@U0FACTORY> ${openers} ${EXPORT}\nSeen on main.`).title, EXPORT, openers);
  }
  assert.equal(titleAndSummary("<@U0FACTORY> Hi team! Quick one. Good morning.")[0], "Hi team! Quick one. Good morning.", "all openers: kept whole");
});

test("a quoted request: title and summary drop the same `>` marks, so the summary is not taken for the title", () => {
  assert.deepEqual(titleAndSummary(`<@U0FACTORY> &gt; ${EXPORT} Seen on main.`), [EXPORT, "Summary: Seen on main."], "one paragraph");
  assert.deepEqual(titleAndSummary(`<@U0FACTORY> &gt; ${EXPORT}\n&gt; Seen on main.`), [EXPORT, "Summary: Seen on main."], "a quoted block");
  assert.deepEqual(titleAndSummary(`<@U0FACTORY> &gt;${EXPORT} Seen on main.`), [EXPORT, "Summary: Seen on main."], "no space after the mark");
});

test("full-width sentence ends split title and summary with no space after them; a full-width decimal does not", () => {
  assert.deepEqual(titleAndSummary("<@U0FACTORY> 保存ボタンが反応しません！設定画面で再現します。"), ["保存ボタンが反応しません！", "Summary: 設定画面で再現します。"]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> 导出为什么失败？「昨天」还可以。"), ["导出为什么失败？", "Summary: 「昨天」还可以。"]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> 版本１．５的导出按钮失效了。页面没有提示。"), ["版本１．５的导出按钮失效了。", "Summary: 页面没有提示。"]);
});

test("an opener ending in a colon is left out; a colon after real words stays in the title", () => {
  assert.equal(titleAndSummary(`<@U0FACTORY> Quick one: ${EXPORT} Seen on main.`)[0], EXPORT);
  assert.equal(titleAndSummary("<@U0FACTORY> Small one on Accounts: the Held column shows 0.00. Seen on main.")[0], "Small one on Accounts: the Held column shows 0.00.");
});

test("a full-width `．` after a digit is a list marker, and a run of sentence ends (`！！`, `！？`, `?!`) ends the sentence once", () => {
  assert.deepEqual(titleAndSummary("<@U0FACTORY> 手順１．設定を開くとエクスポートボタンが無効です。再読み込みでも直りません。"), ["手順１．設定を開くとエクスポートボタンが無効です。", "Summary: 再読み込みでも直りません。"]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> 図１．の画面でボタンが押せません！！毎回です。"), ["図１．の画面でボタンが押せません！！", "Summary: 毎回です。"]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> なぜ保存できないの！？設定画面で起きます。"), ["なぜ保存できないの！？", "Summary: 設定画面で起きます。"]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> Why does export fail?! It worked yesterday."), ["Why does export fail?!", "Summary: It worked yesterday."]);
  assert.deepEqual(titleAndSummary("<@U0FACTORY> Export fails on Accounts.\nWhy?! It worked yesterday."), ["Export fails on Accounts.", "Summary: Why?!"]);
});

test("a greetings-only line of any length is skipped when a request follows it", () => {
  assert.deepEqual(titleAndSummary(`<@U0FACTORY> Hi team! Quick one. Good morning all.\n${EXPORT} It happens on every account.`), [EXPORT, "Summary: It happens on every account."]);
  assert.deepEqual(titleAndSummary(`<@U0FACTORY> Hi team!\nQuick one. Good morning all.\n${EXPORT}\nSeen on main.`), [EXPORT, "Summary: Seen on main."]);
});

// TLSSN-42: the filing turn's description dropped "Keep the 60 limit", and the
// plan raised the cap. The ticket now quotes the request as the reporter wrote it.
const TLSSN_42 = [
  "<@U0FACTORY> The \"Transfer reference\" box on the Move tokens form just stops accepting text at 60 characters, with no counter or message, so people think the keyboard broke.",
  "Could it show a live count under the field (like \"42 / 60\") and change the hint once you hit the limit? Keep the 60 limit and the \"Optional note\" placeholder as they are &amp; no other changes.",
  "",
  "*Sent using* <@U0CURSOR|Cursor>",
].join("\n");

test("reporterRequest: the reporter's words as typed, minus the bot mention and the Sent using footer, entities decoded", () => {
  const request = reporterRequest(TLSSN_42);
  assert.match(request, /^The "Transfer reference" box on the Move tokens form/);
  assert.match(request, /Keep the 60 limit and the "Optional note" placeholder as they are & no other changes\.$/);
  assert.doesNotMatch(request, /U0FACTORY|Sent using|Cursor/);
  assert.equal(reporterRequest("<@U0FACTORY> file a bug: see <https://x.dev/a|the page>, J. Smith *Sent using* @Cursor"), "file a bug: see the page, J. Smith", "inline footer, link label, no word joiners, filing phrase kept");
  assert.doesNotMatch(reporterRequest("<https://x.dev|Read me. Now> ok"), /\u2060/);
});

test("withReporterRequest: the request is quoted after the model's description, once, and inside the cap", () => {
  const description = "Show a live character count under Transfer reference. Asked by Alice.";
  const filed = withReporterRequest(description, TLSSN_42);
  assert.ok(filed.startsWith(`${description}\n\n${REPORTER_REQUEST_LABEL}\n> The "Transfer reference" box`), filed);
  assert.match(filed, /^> Could it show a live count .*Keep the 60 limit and the "Optional note" placeholder as they are/m);
  assert.equal(withReporterRequest("x", "First para.\n\nSecond para."), `x\n\n${REPORTER_REQUEST_LABEL}\n> First para.\n>\n> Second para.\n\n${REPORTER_REQUEST_END}`, "a blank line stays inside the quote");
  assert.doesNotMatch(filed, /Sent using|U0FACTORY/);
  assert.equal(withReporterRequest(filed, TLSSN_42), filed, "idempotent");
  assert.equal(withReporterRequest(description, undefined), description, "no stash, no quote");
  assert.equal(withReporterRequest(description, "<@U0FACTORY>  *Sent using* <@U0CURSOR|Cursor>"), description, "nothing but chrome");

  const verbatim = `Alice asked:\n${reporterRequest(TLSSN_42).replace(/\n+/g, " ")}`;
  assert.equal(withReporterRequest(verbatim, TLSSN_42), verbatim, "a description that already carries the request word for word is left alone");

  const long = `${"word ".repeat(900)}Keep the limit.`;
  const cut = withReporterRequest(description, long.slice(0, 4000));
  const quote = cut.slice(cut.indexOf("\n> ") + 3, cut.lastIndexOf(`\n\n${REPORTER_REQUEST_END}`));
  assert.match(cut, /\(cut; the Slack thread has all of it\):\n> word/);
  assert.ok(quote.length <= 4000, `quote is ${quote.length}`);
  assert.match(quote, /word…$/, "cut between words");
  assert.ok(cut.endsWith(`\n\n${REPORTER_REQUEST_END}`));
});

// The live TLSSN-42 root, as Slack delivered it: a labelled bot mention and
// Cursor's footer on its own line.
const TLSSN_42_LIVE =
  '<@U0EXAMPLE2|factory> The "Transfer reference" box on the Move tokens form just stops accepting text at 60 characters, with no counter or message, so people think the keyboard broke. Could it show a live count under the field (like "42 / 60") and change the hint once you hit the limit? Keep the 60 limit and the "Optional note" placeholder as they are.\n*Sent using* <@U0EXAMPLE1|Cursor>';

test("the live TLSSN-42 text: labelled mention and footer gone, the constraint kept, quoted once", () => {
  const request = reporterRequest(TLSSN_42_LIVE);
  assert.match(request, /^The "Transfer reference" box on the Move tokens form/);
  assert.match(request, /Keep the 60 limit and the "Optional note" placeholder as they are\.$/);
  assert.doesNotMatch(request, /U0EXAMPLE2|U0EXAMPLE1|factory|Sent using|Cursor/);
  const encoded = TLSSN_42_LIVE.replaceAll('"', "&quot;").replace("they are.", "they are &amp; no other changes.");
  assert.equal(reporterRequest(encoded), request.replace("they are.", "they are & no other changes."), "&quot; and &amp; decode");
  assert.equal(reporterRequest("<@U0FACTORY> it&#39;s &apos;fine&#x27; &amp;quot;x&amp;quot;"), "it's 'fine' &quot;x&quot;", "a typed entity stays typed");

  const filed = withReporterRequest("Show a live count. Asked by Simon.", TLSSN_42_LIVE);
  assert.equal(filed.split(REPORTER_REQUEST_LABEL).length, 2);
  assert.equal(withReporterRequest(filed, TLSSN_42_LIVE), filed, "idempotent");
  assert.equal(withReporterRequest(request, TLSSN_42_LIVE), request, "a description that is the request is not quoted again");
  const retyped = `Simon asked: ${request.replaceAll('"', "\u201C")}`;
  assert.equal(withReporterRequest(retyped, TLSSN_42_LIVE), retyped, "nor one that only changed the quote marks");
});

test("a pasted Slack thread line in the request is quoted, not left as a trailer", () => {
  const foreign = "https://acme.slack.com/archives/C0FOREIGN/p1111111111111111";
  const raw = `<@U0FACTORY> Same bug as <${foreign}> and\nSlack thread: ${foreign}\nslack THREAD : ${foreign}\n${DESK_TRIAGED}`;
  const filed = withReporterRequest("Prose.", raw);
  assert.match(filed, new RegExp(`^> Same bug as ${foreign} and$`, "m"), "a link in prose stays as typed");
  assert.match(filed, new RegExp(`^> Slack thread \\(quoted\\): ${foreign}$`, "m"));
  assert.match(filed, new RegExp(`^> slack THREAD \\(quoted\\) : ${foreign}$`, "m"));
  assert.doesNotMatch(filed, /Slack thread:/i);
  assert.ok(filed.endsWith(`> ${DESK_TRIAGED}\n\n${REPORTER_REQUEST_END}`), "the quote never ends the description");
  for (const pasted of ["Slack thread\\:", "*Slack thread*:", "_Slack  thread_ :", "Slack\\ thread:", "xSlack thread:", "1Slack thread:"]) {
    const quoted = withReporterRequest("Prose.", `<@U0FACTORY> ${pasted} ${foreign}`).replace(/\\(.)/g, "$1").replace(/[*_]/g, "");
    assert.doesNotMatch(quoted, /Slack\s+thread\s*:/i, pasted);
  }
});

test("only Cursor's trailing footer is dropped: a reporter line that starts with Sent using stays", () => {
  assert.equal(reporterRequest("<@U1> Sent using the Android app, the form drops the last word.\nKeep the 60 limit.\n*Sent using* <@U2|Cursor>"), "Sent using the Android app, the form drops the last word.\nKeep the 60 limit.");
  assert.equal(reporterRequest("<@U1> Keep the 60 limit.\nSent using Cursor"), "Keep the 60 limit.");
  assert.equal(reporterRequest("<@U1> Keep the 60 limit.\nSent using Firefox"), "Keep the 60 limit.\nSent using Firefox", "a one-word tool that is not Cursor is the reporter's");
  assert.equal(reporterRequest("<@U1> Keep the 60 limit.\n*Sent using* <@U0EXAMPLE1>"), "Keep the 60 limit.", "an unlabelled footer mention");
  assert.equal(reporterRequest("<@U1> Keep the 60 limit. *Sent using* <@U2|Cursor>"), "Keep the 60 limit.");
  assert.equal(reporterRequest("<@U1> It broke when the page was sent using Firefox"), "It broke when the page was sent using Firefox", "no inline footer without a sender mention");
});

test("a cut quote is not quoted again", () => {
  const raw = "wordy ".repeat(700).slice(0, 4000);
  const once = withReporterRequest("Prose.", raw);
  assert.match(once, /\(cut; the Slack thread has all of it\):/);
  assert.equal(withReporterRequest(once, raw), once);
});

// Live 2026-09-27: "Triaged by Jev: Bug, urgent severity." on a confirmation-step ask.
const LOG_OUT = 'The "Log out" button logs you out straight away even when the transfer form has something typed in. Could it ask to confirm first when the form has input?';

test("planFiling caps the fallback model's urgent on a confirmation-step ask to medium, and the Triage: comment says medium", () => {
  const model = { title: "Log out asks no confirmation", kind: "bug" as const, severity: "urgent" as const, summary: "Log out ignores typed input." };
  for (const triage of [{ by: "model", reason: "unavailable" } as const, { by: "model", reason: "below_bar", jev: jevPart(["Bug", 0.9], ["urgent", 0.9]) } as const, undefined]) {
    const plan = planFiling(triage, model, { text: LOG_OUT });
    assert.equal(plan.verdict.severity, "medium", triage?.reason ?? "no intake");
    assert.match(settleFiling(plan, "TLSSN-9", { status: "not_written" }).comment, /^Severity: medium$/m, "Jev's urgent above the bar does not put it back");
  }
  assert.equal(planFiling({ by: "model", reason: "unavailable" }, { ...model, kind: "feedback", severity: "high" }, { text: LOG_OUT }).verdict.severity, "medium", "feedback is capped like a bug");
  assert.equal(planFiling({ by: "model", reason: "unavailable" }, { ...model, kind: "question", severity: "high" }, { text: LOG_OUT }).verdict.severity, "low", "a question is at most low");
});

test("planFiling keeps urgent for a real data-loss, security, or outage report, and caps a stale Jev stash too", () => {
  const model = { title: "Payee save wipes history", kind: "bug" as const, severity: "urgent" as const, summary: "x" };
  assert.equal(planFiling({ by: "model", reason: "unavailable" }, model, { text: "Saving a payee deleted every transaction record on the account." }).verdict.severity, "urgent");
  assert.equal(planFiling({ by: "model", reason: "unavailable" }, model, { text: "Statement PDFs are exposed to anyone with the link." }).verdict.severity, "urgent");
  const stale: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["urgent", 0.9]), type: "Bug", severity: "urgent", needsInfo: false, title: "Log out" };
  assert.equal(planFiling(stale, { ...model, title: "Log out" }, { text: LOG_OUT }).verdict.severity, "medium", "a stash from before the guard is capped at filing");
});

test("planFiling's template summary and severity line name one severity, calibrated over the reporter's text", () => {
  const model = { title: "Payee save", kind: "bug" as const, severity: "low" as const, summary: "" };
  const urgent: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["urgent", 0.9]), type: "Bug", severity: "urgent", needsInfo: false, title: "Payee save" };
  const kept = planFiling(urgent, model, { text: "Payee save\nSaving a payee deleted every transaction record on the account." });
  assert.equal(kept.verdict.severity, "urgent");
  assert.match(kept.verdict.summary, /, urgent severity\.$/);
  const capped = planFiling({ ...urgent, title: "Log out" }, { ...model, title: "Log out" }, { text: LOG_OUT });
  assert.equal(capped.verdict.severity, "medium");
  assert.match(capped.verdict.summary, /, medium severity\.$/);
});

test("a model title naming data loss does not lift the reporter-text cap on a Jev filing", () => {
  const urgent: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["urgent", 0.9]), type: "Bug", severity: "urgent", needsInfo: false, title: "Log out" };
  const plan = planFiling(urgent, { title: "Log out deletes all data", kind: "bug", severity: "urgent", summary: "" }, { text: LOG_OUT });
  assert.equal(plan.verdict.severity, "medium");
  assert.match(plan.verdict.summary, /, medium severity\.$/);
  assert.match(settleFiling(plan, "TLSSN-9", { status: "not_written" }).comment, /^Severity: medium$/m);
});

// The tester's report behind the guard, filed under a model title that names data loss, on every filing path.
const LOG_OUT_TESTER = 'The "Log out" button logs you out straight away. One of our testers lost a half-filled transfer. Could it ask to confirm first when the form has input?';

test("the Log out request under a data-loss title is medium on the Jev path, both backup paths, and with no intake, and every line agrees", () => {
  const model = { title: "Log out deletes all data", kind: "bug" as const, severity: "urgent" as const, summary: "Log out drops a half-filled transfer." };
  const jev: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.99], ["urgent", 0.62]), type: "Bug", severity: "urgent", needsInfo: false, title: "Log out" };
  const onJev = planFiling(jev, model, { text: LOG_OUT_TESTER });
  assert.equal(onJev.verdict.severity, "medium");
  const jevComment = settleFiling(onJev, "TLSSN-9", { status: "set" }).comment;
  assert.match(jevComment, /^Severity: medium$/m);
  assert.match(jevComment, /^Triaged by: Jev \(62% confidence; Jev said urgent; type, severity, and gate all above 0\.52\)$/m);
  assert.match(jevComment, /^Judge: .*severity medium 0\.62 \(Jev only\)$/m, "the probability is Jev's own choice's; the Triaged by: line names that choice");
  for (const triage of [{ by: "model", reason: "below_bar", jev: jevPart(["Bug", 0.9], ["urgent", 0.4]) } as const, { by: "model", reason: "unavailable" } as const, undefined]) {
    const plan = planFiling(triage, model, { text: LOG_OUT_TESTER });
    assert.equal(plan.verdict.severity, "medium", triage?.reason ?? "no intake");
    assert.equal(plan.verdict.summary, model.summary, "the model's summary is filed as written");
    const comment = settleFiling(plan, "TLSSN-9", { status: "not_written" }).comment;
    assert.match(comment, /^Severity: medium$/m, triage?.reason ?? "no intake");
    assert.doesNotMatch(comment, /urgent(?! 0\.)/, "nothing on the ticket files the title's urgent");
  }
});

test("a stash below Jev's severity files one severity in the summary and the Severity: line", () => {
  const low: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["urgent", 0.9]), type: "Bug", severity: "low", needsInfo: false, title: "Payee save" };
  const plan = planFiling(low, { title: "Payee save", kind: "bug", severity: "low", summary: "" }, { text: "Payee save\nSaving a payee deleted every transaction record on the account." });
  assert.equal(plan.verdict.severity, "low");
  assert.match(plan.verdict.summary, /, low severity\.$/);
  assert.match(settleFiling(plan, "TLSSN-9", { status: "not_written" }).comment, /^Severity: low$/m);
});

test("the fallback filing block tells the model the severity ceiling from the reporter's words", () => {
  const capped = intakeTriageContext({ by: "model", reason: "unavailable" }, { text: `<@U0FACTORY> ${LOG_OUT}` });
  assert.match(capped, /<severity>: low or medium\. The request is about typed input, how the UI looks, or a change the reporter wants, and names no data loss, security exposure, or outage, so it is never high or urgent/);
  const open = intakeTriageContext({ by: "model", reason: "unavailable" }, { text: "<@U0FACTORY> file a bug: the app is down for everyone since 9am" });
  assert.match(open, /<severity>: low, medium, high, or urgent\./);
  // A Bug the guard has no evidence on is open too: it keeps whatever the model picks within the rubric.
  const noEvidence = intakeTriageContext({ by: "model", reason: "unavailable" }, { text: "<@U0FACTORY> file a bug: payees deleted after the update" });
  assert.match(noEvidence, /<severity>: low, medium, high, or urgent\./);
  // A confident Task type is capped by the type.
  const task = intakeTriageContext({ by: "model", reason: "below_bar", jev: jevPart(["Task", 0.9], ["urgent", 0.4]) }, { text: "<@U0FACTORY> file a bug: the receipt email is late" });
  assert.match(task, /<severity>: low or medium\. A Task is a request or a chore, and this one names no data loss, security exposure, or outage, so it is never high or urgent\./);
});

test("a title left lowercase by a dropped lead-in is capitalised", () => {
  for (const lead of ["Quick question: ", "Hey team,\n", "Small one: ", "Hi team! Quick one. "]) {
    assert.equal(intakeText(`<@U0FACTORY> ${lead}the transfer box clears when I switch tabs`).title, "The transfer box clears when I switch tabs", lead);
  }
  assert.equal(capitalizedTitle("the transfer box"), "The transfer box");
  assert.equal(capitalizedTitle("ärger mit dem Export"), "Ärger mit dem Export");
});

test("a title that opens with code or an identifier keeps its first letter as typed", () => {
  for (const title of [
    "`exportCsv()` drops the last row",
    "exportCsv drops the last row",
    "iOS app freezes on launch",
    "snake_case_flag is ignored",
    "e2e-158 fails on main",
    "./scripts/doctor.mjs exits 1",
    "/settings page is blank",
    "components/banking/list.tsx has no heading",
    "~/config is ignored",
    "https://x.io/a returns 404",
    "--dry-run still writes",
    "@factory ignores me",
    "#mars-eng-intake posts twice",
    "package.json lists a stale dep",
    "readme.md, has a typo",
    "42 rows go missing",
  ]) {
    assert.equal(capitalizedTitle(title), title, title);
  }
  assert.equal(intakeText("<@U0FACTORY> Quick question: `exportCsv()` drops the last row").title, "`exportCsv()` drops the last row");
  assert.equal(intakeText("<@U0FACTORY> Hey team,\niOS app freezes on launch").title, "iOS app freezes on launch");
});

// TLSSN-43 shape: a report of something wrong, closed with a polite "could it…?".
const WRONG_NOTE = "The Tokens dispatched screen after a transfer doesn't show the reference note I typed. Could the confirmation show the note?";

test("type guard: Jev's confident Story over a report of something broken is not offered as fixed, and the filed ticket keeps the model's type", () => {
  const jev = { ...jevPart(["Story", 0.95], ["medium", 0.9]), types: { source: "project" as const, types: [{ name: "Task" }, { name: "Story" }, { name: "Bug" }] } };
  const triage: IntakeTriage = { by: "model", reason: "type_guard", jev };
  const context = intakeTriageContext(triage, { text: `<@U0FACTORY> ${WRONG_NOTE}` });
  assert.doesNotMatch(context, /Story is fixed/);
  assert.match(between(context), /^Triaged by Grok 4\.6 Fast \(Jev's type didn't fit a report of something broken\): <Type>, <severity> severity\.$/m);
  const model = { title: "Confirmation drops the reference note", kind: "bug" as const, severity: "medium" as const, summary: "The note is missing." };
  // The model's restatement need not carry the defect words: the intake's guard still holds.
  const plan = planFiling(triage, model, { text: "Show the reference note on the confirmation." });
  assert.equal(plan.verdict.kind, "bug");
  assert.equal(plan.createType, undefined, "Jev's held type is not what the ticket is created as");
  const comment = settleFiling(plan, "TLSSN-43", { status: "not_written" }).comment;
  assert.match(comment, /^Judge: Jev type Story 0\.95 \(held back: the report says something is broken now; kept the model's bug\)/m);
});

test("type guard: a held Story does not cap Jev's severity; the model's kind is read instead (Bugbot)", () => {
  const jev = { ...jevPart(["Story", 0.95], ["high", 0.9]), types: { source: "project" as const, types: [{ name: "Task" }, { name: "Story" }, { name: "Bug" }] } };
  const triage: IntakeTriage = { by: "model", reason: "type_guard", jev };
  const model = { title: "Freeze card stopped working", kind: "bug" as const, severity: "low" as const, summary: "Freeze card does nothing." };
  const plan = planFiling(triage, model, { text: "Freeze card stopped working for me." });
  assert.equal(plan.judged.status === "judged" && plan.judged.type.held, true);
  assert.equal(settleFiling(plan, "TLSSN-9", { status: "not_written" }).verdict.severity, "high");
});

test("planFiling keeps an urgent Jev stash on a stored-data loss report, and still files a low stash low", () => {
  const urgent: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["urgent", 0.9]), type: "Bug", severity: "urgent", needsInfo: false, title: "Payees gone" };
  const text = "Payees gone\nAll my payees were deleted after the update.";
  const plan = planFiling(urgent, { title: "Payees gone", kind: "bug", severity: "urgent", summary: "" }, { text });
  assert.equal(plan.verdict.severity, "urgent");
  assert.match(plan.verdict.summary, /, urgent severity\.$/);
  assert.match(settleFiling(plan, "TLSSN-9", { status: "not_written" }).comment, /^Severity: urgent$/m);
  const typed = planFiling({ ...urgent, title: "Form reset" }, { title: "Form reset", kind: "bug", severity: "urgent", summary: "" }, { text: "Form reset\nThe details I was typing were lost when the page refreshed." });
  assert.equal(typed.verdict.severity, "medium");
});

const TLSSN_44 = "<@U0FACTORY> Activity shows the wrong time for my transfer\nI sent 250 tokens between my own accounts at 9:40am Sydney time this morning and the row on Activity shows 23:40, so it looks like it happened last night. Seen on main.";
const TLSSN_44_FIRST = "I sent 250 tokens between my own accounts at 9:40am Sydney time this morning and the row on Activity shows 23:40, so it looks like it happened last night.";

test("TLSSN-44: the filing prompt's Summary is never the body's first sentence copied; the turn writes a synthesis", () => {
  const triage: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["medium", 0.78]), type: "Bug", severity: "medium", needsInfo: false, title: "Activity shows the wrong time for my transfer" };
  const context = intakeTriageContext(triage, { text: TLSSN_44, explicit: true });
  assert.equal(between(context).split("\n")[2], `Summary: ${SLOT.summary}`);
  assert.ok(!context.includes(`Summary: ${TLSSN_44_FIRST}`));
  assert.match(context, /in your own words: what is wrong, where it shows, and the likely cause or area/);
  const stale = intakeTriageContext({ ...triage, summary: TLSSN_44_FIRST }, { text: TLSSN_44, explicit: true });
  assert.equal(between(stale).split("\n")[2], `Summary: ${SLOT.summary}`, "a stash from before this that lifted the sentence is dropped");
});

test("copiesRequest: the body's first sentence, or any long run of the request, is a copy; a synthesis is not", () => {
  assert.equal(copiesRequest({ summary: TLSSN_44_FIRST, request: TLSSN_44 }), true);
  assert.equal(copiesRequest({ summary: TLSSN_44_FIRST.slice(0, 90) + "…", request: TLSSN_44 }), true, "a cut copy is still a copy");
  assert.equal(copiesRequest({ summary: "The row on Activity shows 23:40", request: TLSSN_44 }), true);
  assert.equal(copiesRequest({ summary: "Activity renders transfer times in UTC instead of the account's Sydney time zone, so morning transfers look like the previous night.", request: TLSSN_44 }), false);
  assert.equal(copiesRequest({ summary: "Seen on main.", request: TLSSN_44 }), false, "too short to call a copy");
});

test("planFiling drops a turn Summary lifted from the reporter's message and keeps a synthesis", () => {
  const triage: IntakeTriage = { by: "jev", jev: jevPart(["Bug", 0.97], ["medium", 0.78]), type: "Bug", severity: "medium", needsInfo: false, title: "Activity shows the wrong time for my transfer" };
  const model = { title: "Activity shows the wrong time for my transfer", kind: "bug" as const, severity: "medium" as const, summary: TLSSN_44_FIRST };
  const lifted = planFiling(triage, model, { text: TLSSN_44, request: TLSSN_44 });
  assert.notEqual(lifted.verdict.summary, TLSSN_44_FIRST);
  assert.equal(lifted.summaryFromTemplate, true);
  const synthesis = "Activity renders transfer times in UTC instead of the account's Sydney time zone.";
  assert.equal(planFiling(triage, { ...model, summary: synthesis }, { text: TLSSN_44, request: TLSSN_44 }).verdict.summary, synthesis);
});

test("planFiling on the model's triage (Jev below the bar or unavailable) also drops a Summary copied from the request for the template", () => {
  const model = { title: "Activity shows the wrong time for my transfer", kind: "bug" as const, severity: "medium" as const, summary: TLSSN_44_FIRST };
  for (const triage of [{ by: "model", reason: "unavailable" }, { by: "model", reason: "below_bar", jev: jevPart(["Bug", 0.6], ["medium", 0.4]) }] as IntakeTriage[]) {
    const lifted = planFiling(triage, model, { text: TLSSN_44, request: TLSSN_44 });
    assert.equal(lifted.verdict.summary, 'Bug reported as "Activity shows the wrong time for my transfer", medium severity.');
    assert.equal(lifted.summaryFromTemplate, true);
    const synthesis = "Activity renders transfer times in UTC instead of the account's Sydney time zone.";
    const kept = planFiling(triage, { ...model, summary: synthesis }, { text: TLSSN_44, request: TLSSN_44 });
    assert.equal(kept.verdict.summary, synthesis);
    assert.equal(kept.summaryFromTemplate, undefined);
  }
});

// TLSSN-46: the filing prompt's first line was the reporter's first line,
// `Could we add a "Download CSV" option on the Activity page? Tax time is coming up…`.
test("the filing prompt's title is the turn's short synthesized title on every path, never the reporter's first line", () => {
  const text = '<@U0FACTORY> Could we add a "Download CSV" option on the Activity page? Tax time is coming up and I need my history.\nThanks!';
  for (const triage of [
    { by: "jev", jev: jevPart(["Story", 0.97], ["low", 0.9]), type: "Story", severity: "low", needsInfo: false, title: fittedRequestTitle(text) } as IntakeTriage,
    { by: "model", reason: "below_bar", jev: jevPart(["Story", 0.97], ["low", 0.5]) } as IntakeTriage,
    { by: "model", reason: "unavailable" } as IntakeTriage,
  ]) {
    const context = intakeTriageContext(triage, { text });
    assert.equal(between(context).split("\n")[0], SLOT.title, triage.by);
    assert.doesNotMatch(between(context), /Could we add|Tax time/, triage.by);
    assert.match(context, /Not a question, not a request, one phrase only; never copy the reporter's sentence and never add their reasons\./, triage.by);
    assert.match(context, /pass the same title/, triage.by);
  }
});

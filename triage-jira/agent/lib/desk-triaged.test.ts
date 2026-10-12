import assert from "node:assert/strict";
import { test } from "node:test";
import { DESK_TRIAGED_LINE, deskTriaged, governingTriage, isDeskTriageComment, withDeskTriaged } from "./desk-triaged.js";

// The desk's line as the readers get it. Hosted, triage-jira gets the
// description from Automation's `{{issue.description.plainText.jsonEncode}}`
// (TLSSN-33, -35, -40 were triaged twice because the line-of-its-own test
// missed that rendering), and the planner gets it from the connector's ADF.

const PERMALINK = "https://<SLACK_WORKSPACE>.slack.com/archives/C0EXAMPLE1/p1758510000123456";
const FILED = withDeskTriaged(`Freeze card has no aria-describedby.\n\nSlack thread: ${PERMALINK}`);

test("the desk's description as written, and as Automation's plainText glues it, both end with the line", () => {
  assert.equal(deskTriaged(FILED), true);
  assert.equal(deskTriaged(FILED.replace(/\n/g, "\r\n")), true);
  assert.equal(deskTriaged(`${FILED}\n\n`), true);
  assert.equal(deskTriaged(`Freeze card has no aria-describedby.Slack thread: ${PERMALINK}${DESK_TRIAGED_LINE}`), true);
  assert.equal(deskTriaged(`Freeze card has no aria-describedby. Slack thread: ${PERMALINK} ${DESK_TRIAGED_LINE}`), true);
  assert.equal(deskTriaged(`Slack thread: ${PERMALINK}\nTriaged in Slack by factory-desk\nbefore filing.`), true, "wrapped mid-sentence");
  assert.equal(deskTriaged(`Slack thread: ${PERMALINK}Triaged in Slack by factory-desk before filing`), true, "no final period");
});

test("markdown, ADF, and wiki artifacts around the line are ignored", () => {
  for (const wrapped of [`*${DESK_TRIAGED_LINE}*`, `_${DESK_TRIAGED_LINE}_`, `> ${DESK_TRIAGED_LINE}`, `**${DESK_TRIAGED_LINE}**  `, `<p>${DESK_TRIAGED_LINE}</p>`, `${DESK_TRIAGED_LINE}\\`]) {
    assert.equal(deskTriaged(`Slack thread: ${PERMALINK}\n\n${wrapped}`), true, wrapped);
  }
  assert.equal(deskTriaged("Triaged in Slack by factory\\-desk before filing\\."), true, "markdown escapes");
});

test("smart punctuation, entities, and odd spaces are normalised", () => {
  assert.equal(deskTriaged("x. Triaged in Slack by factory\u2011desk before filing."), true, "non-breaking hyphen");
  assert.equal(deskTriaged("x. Triaged in Slack by factory\u2013desk before filing."), true, "en dash");
  assert.equal(deskTriaged("x. Triaged\u00a0in Slack by factory-desk before\u202Ffiling."), true, "no-break spaces");
  assert.equal(deskTriaged("x. Triaged in Slack by factory&#45;desk before filing&#46;"), true, "numeric entities");
  assert.equal(deskTriaged("x. Triaged in Slack by factory-desk before filing.&nbsp;"), true, "trailing &nbsp;");
  assert.equal(deskTriaged("x. Triaged in Slack by factory-desk\u200B before filing."), true, "zero-width space");
  assert.equal(deskTriaged("x. Triaged in Slack by factory-desk before filing\u2026"), false, "an ellipsis is not the sentence's end");
});

test("a quote of the line inside other prose is not the desk's line", () => {
  assert.equal(deskTriaged(`Someone wrote "${DESK_TRIAGED_LINE}" in a comment once.`), false);
  assert.equal(deskTriaged(`Someone wrote \u201C${DESK_TRIAGED_LINE}\u201D`), false, "ends with a closing quote");
  assert.equal(deskTriaged(`Someone wrote &quot;${DESK_TRIAGED_LINE}&quot;`), false, "entity-encoded quote");
  assert.equal(deskTriaged(`${DESK_TRIAGED_LINE}\n\nThen it broke again.`), false);
  assert.equal(deskTriaged(""), false);
  assert.equal(deskTriaged("Triaged in Slack by someone else before filing."), false);
  assert.equal(deskTriaged(`The desk appends ${DESK_TRIAGED_LINE}`), false, "ends a sentence that quotes it after other words");
  assert.equal(deskTriaged(`Why did TLSSN-40 say *${DESK_TRIAGED_LINE}*`), false, "emphasised mid-sentence");
  assert.equal(deskTriaged(`Someone wrote "${DESK_TRIAGED_LINE}`), false, "after an opening quote");
  assert.equal(deskTriaged(`Code:\n\`\`\`\n${DESK_TRIAGED_LINE}\n\`\`\``), false, "inside a code fence");
  assert.equal(deskTriaged(`Inline \`${DESK_TRIAGED_LINE}\``), false, "inline code");
  assert.equal(deskTriaged("This ticket is about the factory-desk and how it triages before filing."), false, "only mentions the desk");
});

test("glued to the paragraph before it, after a sentence end or the Slack link, or on its own line, it is the desk's line", () => {
  assert.equal(deskTriaged(`Export returns 500${DESK_TRIAGED_LINE}`), true, "paragraphs run together with no space");
  assert.equal(deskTriaged(`Export returns 500.${DESK_TRIAGED_LINE}`), true);
  assert.equal(deskTriaged(`Export returns 500. ${DESK_TRIAGED_LINE}`), true);
  assert.equal(deskTriaged(`Slack thread: ${PERMALINK}**${DESK_TRIAGED_LINE}**`), true, "emphasised, glued to the link");
  assert.equal(deskTriaged(`<p>Export returns 500</p><p>${DESK_TRIAGED_LINE}</p>`), true, "rendered HTML paragraphs");
  assert.equal(deskTriaged(`Export returns 500\n${DESK_TRIAGED_LINE}`), true);
  // Space-joined after a word with no sentence end or link is prose; the tracker re-read (desk-filed.ts) still catches a desk ticket rendered that way.
  assert.equal(deskTriaged(`Export returns 500 ${DESK_TRIAGED_LINE}`), false);
});

test("the desk's Triage: comment is told apart from triage-jira's", () => {
  const comment = "Triage: bug\nType: Bug\nSeverity: medium\nSummary: x\nNext step: y\nTriaged by: Jev (type, severity, and gate all above 0.52)";
  assert.equal(isDeskTriageComment(withDeskTriaged(comment)), true);
  assert.equal(isDeskTriageComment(`${comment}${DESK_TRIAGED_LINE}`), true, "flattened with its paragraphs run together");
  assert.equal(isDeskTriageComment(`\uFEFF${withDeskTriaged(comment)}`), true);
  assert.equal(isDeskTriageComment(comment), false);
  assert.equal(isDeskTriageComment(withDeskTriaged("Plan: TLSSN-40 Add aria-describedby")), false, "only a Triage: comment");
});

test("governingTriage: the desk's marked comment, else the first machine-written one; a person's later comment corrects either", () => {
  const by = "\nTriaged by: model (Jev was not above 0.52 on every answer)";
  const desk = withDeskTriaged(`Triage: bug\nSeverity: medium${by}`);
  const legacyDesk = `Triage: bug\nSeverity: medium${by}`;
  const second = `Triage: question\nSeverity: low${by}`;
  const person = "Triage: question\nSeverity: low";
  assert.equal(governingTriage([]), undefined);
  assert.equal(governingTriage(["Plan: TLSSN-42 x", "Triage: duplicate inbound TLSSN-50"]), undefined);
  assert.deepEqual(governingTriage([desk, second]), { index: 0, from: "desk" });
  assert.deepEqual(governingTriage([second, desk]), { index: 1, from: "desk" });
  assert.deepEqual(governingTriage([legacyDesk, second]), { index: 0, from: "triage" }, "a ticket filed before the desk marked its comment");
  assert.deepEqual(governingTriage([desk, second, person]), { index: 2, from: "latest" });
  assert.deepEqual(governingTriage([legacyDesk, person, second]), { index: 1, from: "latest" });
  assert.deepEqual(governingTriage([person, "Triage: bug\nSeverity: high"]), { index: 1, from: "latest" }, "no machine-written comment: the newest");
  assert.deepEqual(governingTriage([`\uFEFF${second}`, "Triage: duplicate inbound TLSSN-50"]), { index: 0, from: "triage" });
});

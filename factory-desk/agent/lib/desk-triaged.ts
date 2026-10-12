// The line that says factory-desk triaged a ticket before filing it. The desk
// ends every description it files with it, and its own Triage: comment, so
// triage-jira leaves the ticket alone and the planner gates on the desk's
// verdict. Shared verbatim by factory-desk, triage-jira, and planner
// (scripts/copies-parity.test.mjs); the tests live next to triage-jira's copy.
// No runtime imports, so root tests can load it.

export const DESK_TRIAGED_LINE = "Triaged in Slack by factory-desk before filing.";

// Readers get the description the way Jira Automation's
// `{{issue.description.plainText}}` renders the ADF the Atlassian MCP wrote
// from the desk's markdown: paragraphs may run together with no newline, and
// the sentence may come back escaped, entity-encoded, emphasised, or with
// smart punctuation. So the test is "the text ends with the sentence" after
// undoing those, not "the sentence is on a line of its own". The sentence
// must start a line, follow a sentence end or the `Slack thread:` link, or
// be glued to the paragraph before it with no space (how plainText runs
// paragraphs together): a sentence that ends by quoting it after other words
// on the same line ("the desk appends Triaged in Slack by …") is prose, and
// a quote, inline code, or a code fence around it is a quote.
const SENTENCE = String.raw`Triaged\s+in\s+Slack\s+by\s+factory-desk\s+before\s+filing\.?`;
const MARKUP = "[*_>~|]";
const DESK_TRIAGED_END = new RegExp(
  String.raw`(?:(?:^|\n|[.!?]|https?:\/\/\S+?)[^\S\n]*${MARKUP}*[^\S\n]*|(?<=[^\s*_>~|"'\`(])${MARKUP}*)${SENTENCE}$`,
  "i"
);
const TRAILING_MARKUP = /(?:\s|[*_>~|]|\\(?=\s*$))+$/;
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

export function withDeskTriaged(text: string): string {
  return `${text.trimEnd()}\n\n${DESK_TRIAGED_LINE}`;
}

/** True when a description or comment (plain text, flattened rich text, or Automation's plainText) ends with the desk's line. */
export function deskTriaged(text: string): boolean {
  return DESK_TRIAGED_END.test(plain(text).replace(TRAILING_MARKUP, ""));
}

/** True for the Triage: comment factory-desk writes when it files a ticket, not triage-jira's. */
export function isDeskTriageComment(text: string): boolean {
  return /^\s*Triage:/.test(text.replace(/^\uFEFF/, "")) && deskTriaged(text);
}

export type GoverningTriage = { index: number; from: "desk" | "triage" | "latest" };

/**
 * Which `Triage:` comment the planner's gate and the desk's readers go by:
 * the one rule both sides use, from the comments alone. The base verdict is
 * the desk's own comment (it ends with DESK_TRIAGED_LINE), else the first
 * comment a triage run wrote (it has a `Triaged by:` line; on a ticket filed
 * before the desk marked its comment that first one is the desk's). A later
 * machine-written `Triage:` comment is a second triage that should not have
 * run (TLSSN-40); a later one with no `Triaged by:` line is a person
 * correcting the verdict in Jira, and the newest of those governs. With no
 * machine-written comment at all, the newest governs. `Triage: duplicate
 * inbound <KEY>` is written on the original when a later ticket duplicates
 * it, so it is never this ticket's verdict.
 */
export function governingTriage(comments: readonly string[]): GoverningTriage | undefined {
  const triages: number[] = [];
  comments.forEach((text, index) => {
    const first = firstLine(text);
    if (first.startsWith("Triage:") && !/duplicate inbound/i.test(first)) triages.push(index);
  });
  const newest = triages.at(-1);
  if (newest === undefined) return undefined;
  const machine = (index: number) => /^Triaged by:/m.test(comments[index] ?? "");
  const desk = triages.filter((index) => isDeskTriageComment(comments[index] ?? "")).at(-1);
  const base = desk ?? triages.find(machine);
  if (base === undefined) return { index: newest, from: "latest" };
  const person = triages.filter((index) => index > base && !machine(index)).at(-1);
  if (person !== undefined) return { index: person, from: "latest" };
  return { index: base, from: desk === undefined ? "triage" : "desk" };
}

function firstLine(text: string): string {
  const trimmed = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const end = trimmed.indexOf("\n");
  return (end === -1 ? trimmed : trimmed.slice(0, end)).trim();
}

function plain(text: string): string {
  let out = text.replace(/\r\n?/g, "\n");
  // Twice, for text that was entity-encoded on top of an encoding (`&amp;quot;`).
  for (let pass = 0; pass < 2; pass += 1) out = decodeEntities(out);
  return out
    .replace(/<\/?[a-z][^>]*>/gi, "\n")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
    .replace(/[^\S\n]+/g, " ");
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

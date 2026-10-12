import assert from "node:assert/strict";
import { test } from "node:test";
import { templateVerdict, triagedByLine } from "./jev-triage.js";
import { planBlocks, planPost, rootPost } from "./plan-post.js";
import { filedMessage, triagedMessage } from "./threads.js";
import { wordPrefix } from "./word-cut.js";

// Independent verification of PR #167: every other title/summary cut lands
// between words, with no trailing `,;:` before the `…`.

const WORDISH = /[\p{L}\p{N}_]/u;
const REPORT = "The export button stays disabled after the filter changes and nothing on the page says why";
const words = (seed: string, min: number) => {
  let out = seed;
  while (out.length < min) out += ` ${seed}`;
  return out;
};

/** The text before `…` in `shown` is a start of `whole` (after `prefix`) that ends between words. */
function assertWordCut(shown: string, whole: string, label: string) {
  assert.ok(shown.includes("…"), `${label}: expected a cut: ${shown.slice(-40)}`);
  const kept = shown.slice(0, shown.indexOf("…"));
  assert.ok(whole.startsWith(kept), `${label}: kept text is a start of the source`);
  assert.doesNotMatch(kept, /[,;:\s]$/, `${label}: trailing ,;: or space before …`);
  const last = kept.slice(-1);
  const next = whole.slice(kept.length, kept.length + 1);
  assert.ok(!(WORDISH.test(last) && WORDISH.test(next)), `${label}: mid-word …${kept.slice(-20)}|${whole.slice(kept.length, kept.length + 12)}`);
}

const TYPES_ANSWERS = {
  issueType: { type: "choice" as const, choice: "Bug", probabilities: { Bug: 0.93 } },
  severity: { type: "choice" as const, choice: "medium", probabilities: { medium: 0.84 } },
  gate: { type: "choice" as const, choice: "proceed", probabilities: { proceed: 0.9 } },
};

test("Jev template: verdict title (80) and templated summary title (160) cut between words, no ,;: before …", () => {
  const title = `Transfer form, reference field; ${words(REPORT, 300)}`;
  const verdict = templateVerdict({ identifier: "TLSSN-1", title }, TYPES_ANSWERS as never)!;
  assert.ok(verdict.title.length <= 80);
  assertWordCut(verdict.title, title, "verdict title");
  const quoted = verdict.summary.match(/reported as "(.*)", medium severity\.$/)![1]!;
  assert.ok(quoted.length <= 160);
  assertWordCut(quoted, title, "template summary");
  const commas = templateVerdict({ identifier: "TLSSN-1", title: `${"word ".repeat(15)}alpha, beta, gamma, delta, epsilon, zeta` }, TYPES_ANSWERS as never)!;
  assert.doesNotMatch(commas.title, /[,;:]…$/);
});

test("Triaged by: line cuts Jev's unavailable message between words at 160", () => {
  const message = words("TypeSafe returned an internal error while scoring the request", 400);
  const lines = triagedByLine({ status: "unavailable", message } as never);
  const inner = lines.match(/Jev did not settle it: (.*)\)/)![1]!;
  assert.ok(inner.length <= 160);
  assertWordCut(inner, message, "Triaged by");
});

test("plan post header (150) and root post headline (300) cut between words; entities never split", () => {
  const title = `Held column & offset <slot> ${words(REPORT, 400)}`;
  const blocks = planBlocks({ issueKey: "TLSSN-9", title, tracker: "Jira" } as never);
  const header = (blocks[0] as unknown as { text: { text: string } }).text.text;
  assert.ok(header.length <= 150);
  assertWordCut(header, `TLSSN-9 is planned: ${title}`, "plan header");
  const root = rootPost({ issueKey: "TLSSN-9", title, status: "To Do" });
  const headline = JSON.stringify(root.blocks).match(/TLSSN-9: Held column[^*]*/)![0];
  assert.ok(headline.length <= 300, `${headline.length}`);
  assert.doesNotMatch(headline, /&(?:a|am|l|g)?…/, "no split entity");
  const plain = headline.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  assertWordCut(plain, `TLSSN-9: ${title}`, "root headline");
  assert.ok(planPost({ issueKey: "TLSSN-9", title, tracker: "Jira" } as never).text.length > 0);
});

test("Filed post carries no Summary; Triaged line step (300) cut between words", () => {
  const summary = `${words(REPORT, 420)}.`;
  const reply = filedMessage({ issueKey: "TLSSN-9", issueType: "Bug", severity: "low", summary, credit: { by: "model" }, triaged: true, kind: "bug" });
  assert.ok(!reply.includes("Summary: "));
  const step = words("ask the reporter which account they used, and when", 400);
  const triaged = triagedMessage({ issueKey: "TLSSN-9", verdict: { identifier: "TLSSN-9", kind: "question", severity: "low", title: "t", summary: "s", nextStep: step, gate: "needs_info" } as never, replan: false });
  const shown = triaged.split("\n")[0]!.match(/needs more information: (.*)\.$/)![1]!;
  assertWordCut(shown, step, "Triaged step");
});

test("wordPrefix: emoji, ZWJ sequences, flags, and CJK are never split; a long token falls back to graphemes", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (let room = 1; room < 60; room++) {
    const cut = wordPrefix("👨‍👩‍👧🇦🇺🔥".repeat(10), room);
    assert.doesNotMatch(cut, lone, `room ${room}`);
    assert.ok(cut.length <= room);
    assert.doesNotMatch(cut, /\u200D$/, `room ${room}: ZWJ tail`);
  }
  assert.equal(wordPrefix("https://example.com/" + "a".repeat(100), 50).length, 50, "one long URL: graphemes");
  assert.equal(wordPrefix("alpha beta, gamma", 11), "alpha beta");
});

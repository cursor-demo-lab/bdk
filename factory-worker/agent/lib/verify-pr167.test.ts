import assert from "node:assert/strict";
import { test } from "node:test";
import { implementPrTitle } from "./implement-pr.js";
import { AGENT_NAME_MAX, agentName } from "./launch.js";

// Independent verification of PR #167: the worker's PR title and agent name
// keep their prefix and are cut between words.

const WORDISH = /[\p{L}\p{N}_]/u;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const words = (seed: string, min: number) => {
  let out = seed;
  while (out.length < min) out += ` ${seed}`;
  return out;
};

function assertWordCut(shown: string, whole: string, max: number, label: string) {
  assert.ok(shown.length <= max, `${label}: ${shown.length} > ${max}`);
  assert.ok(shown.endsWith("…"), label);
  const kept = shown.slice(0, -1);
  assert.ok(whole.startsWith(kept), `${label}: a start of the source`);
  assert.doesNotMatch(kept, /[,;:\s]$/, `${label}: trailing ,;: before …`);
  assert.ok(!(WORDISH.test(kept.slice(-1)) && WORDISH.test(whole.slice(kept.length, kept.length + 1))), `${label}: mid-word …${kept.slice(-20)}|${whole.slice(kept.length, kept.length + 10)}`);
  assert.doesNotMatch(shown, LONE, `${label}: lone surrogate`);
}

const TITLE = 'On the Activity page the "Sol 214"-style day separators are plain divs, so screen reader users can\'t jump between days with the heading shortcut and the list reads as one long run of rows';

test("implementPrTitle keeps `KEY: `, stays ≤256, and cuts between words", () => {
  const title = words(TITLE, 600);
  const shown = implementPrTitle({ issueKey: "TLSSN-167", title });
  assert.ok(shown.startsWith("TLSSN-167: "));
  assertWordCut(shown, `TLSSN-167: ${title}`, 256, "PR title");
  assert.ok(shown.length > 200, "generous");
  const prefixed = implementPrTitle({ issueKey: "TLSSN-167", title: `TLSSN-167: ${title}` });
  assert.ok(prefixed.startsWith("TLSSN-167: ") && !prefixed.startsWith("TLSSN-167: TLSSN-167"));
  assertWordCut(prefixed, `TLSSN-167: ${title}`, 256, "already prefixed");
  const exact = `TLSSN-167: ${"x".repeat(256 - 11)}`;
  assert.equal(implementPrTitle({ issueKey: "TLSSN-167", title: exact.slice(11) }), exact, "exactly 256 is whole");
});

test("implementPrTitle with one long token and emoji keeps the prefix and never splits a surrogate pair", () => {
  const shown = implementPrTitle({ issueKey: "TLSSN-167", title: "🔥".repeat(200) });
  assert.ok(shown.startsWith("TLSSN-167: 🔥"));
  assert.ok(shown.length <= 256);
  assert.doesNotMatch(shown, LONE);
  const comma = implementPrTitle({ issueKey: "TLSSN-1", title: `${"alpha ".repeat(40)}beta, ${"gamma ".repeat(20)}` });
  assert.doesNotMatch(comma, /[,;:]…$/);
});

test("agentName keeps `factory KEY: `, stays ≤100, and cuts between words", () => {
  const name = agentName({ issueKey: "TLSSN-167", title: TITLE });
  assert.ok(name.startsWith("factory TLSSN-167: "));
  assertWordCut(name, `factory TLSSN-167: ${TITLE}`, AGENT_NAME_MAX, "agent name");
  assert.equal(AGENT_NAME_MAX, 100);
  const emoji = agentName({ issueKey: "TLSSN-167", title: "👨‍👩‍👧".repeat(40) });
  assert.ok(emoji.length <= 100);
  assert.doesNotMatch(emoji, LONE);
  assert.doesNotMatch(emoji, /\u200D…$/);
  const cjk = agentName({ issueKey: "TLSSN-167", title: "导出按钮在筛选条件改变后一直处于禁用状态页面上也没有任何提示".repeat(5) });
  assert.ok(cjk.length <= 100 && cjk.length > 60, `${cjk.length}`);
});

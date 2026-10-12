import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The Jira Automation bodies in docs/jira-automation.md are pasted into
// "Send web request" custom data, where Automation inserts each smart value
// as raw text. A free-text value (a title, description, comment, or name)
// with a double quote, backslash, or newline ends its JSON string early and
// the whole body stops being JSON. The pod then answers 400 before any
// factory handler runs and hosted delivery skips it with no session and no
// log (TLSSN-40 and TLSSN-41, 2026-09-27 UTC: raw `{{issue.summary}}` on the
// status rules, titles with double quotes). These checks keep every template
// in the doc on `.jsonEncode` for free text, and prove each one still parses
// when that text is hostile.

const here = dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(join(here, "..", "docs", "jira-automation.md"), "utf8");

/** Fenced ```json blocks that carry at least one smart value. */
function templates(markdown) {
  const blocks = [];
  const fence = /```json[ \t]*\r?\n([\s\S]*?)```/g;
  for (let match = fence.exec(markdown); match !== null; match = fence.exec(markdown)) {
    if (match[1].includes("{{")) blocks.push(match[1]);
  }
  return blocks;
}

const SMART_VALUE = /\{\{([^}]*)\}\}/g;

/**
 * Smart values that render as a key, id, status name, URL, or timestamp and so
 * are safe raw. Anything else is treated as free text, so a new field added to
 * a template has to be encoded or listed here on purpose.
 */
const SAFE_RAW = new Set([
  "issue.key",
  "issue.url",
  "issue.status.name",
  "issue.project.key",
  "issue.updated",
  "comment.id",
  "changelog.id",
  "fieldChange.fromString",
  "fieldChange.toString",
]);

/**
 * `fromString` / `toString` are status names only inside
 * `{{#changelog.status}}…{{/}}`; under `{{#changelog.summary}}` they are the
 * old and new title.
 */
const SAFE_IN_STATUS_SECTION = new Set(["fromString", "toString"]);

const isSection = (expression) => expression.startsWith("#") || expression.startsWith("/");
const isEncoded = (expression) => expression.endsWith(".jsonEncode");

/**
 * Every `{{…}}` expression inside the template, trimmed, section tags
 * included, with whether it is safe raw where it stands.
 */
function smartValues(template) {
  const sections = [];
  return [...template.matchAll(SMART_VALUE)].map((match) => {
    const expression = match[1].trim();
    if (expression.startsWith("#")) sections.push(expression.slice(1).trim());
    else if (expression.startsWith("/")) sections.pop();
    const safe =
      SAFE_RAW.has(expression) ||
      (SAFE_IN_STATUS_SECTION.has(expression) && sections.at(-1) === "changelog.status");
    return { expression, safe };
  });
}

const HOSTILE = 'Cards: every "Freeze card" button \\ breaks\non two lines';

/**
 * Renders a template the way Automation does for a ticket whose free text is
 * hostile: `.jsonEncode` values become the JSON-escaped text, any other free
 * text is inserted as is, and safe values become a plain token.
 */
function render(template) {
  const values = smartValues(template);
  let index = 0;
  return template.replace(SMART_VALUE, () => {
    const { expression, safe } = values[index++];
    if (isSection(expression)) return "";
    if (isEncoded(expression)) return JSON.stringify(HOSTILE).slice(1, -1);
    if (safe) return "TLSSN-1";
    return HOSTILE;
  });
}

function stringsIn(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(stringsIn);
}

test("the doc carries the Created, Status, and Comment templates", () => {
  const found = templates(doc);
  assert.equal(found.length, 3, "expected exactly three JSON body templates");
  assert.ok(found.some((template) => template.includes('"jira:issue_created"')));
  assert.ok(found.some((template) => template.includes('"jira:issue_updated"')));
  assert.ok(found.some((template) => template.includes('"comment_created"')));
});

test("every free-text smart value in every template ends in .jsonEncode", () => {
  for (const template of templates(doc)) {
    for (const { expression, safe } of smartValues(template)) {
      if (isSection(expression) || safe) continue;
      assert.ok(isEncoded(expression), `{{${expression}}} must end in .jsonEncode`);
    }
  }
});

test("each template stays valid JSON when its free text holds quotes, a backslash, and a newline", () => {
  for (const template of templates(doc)) {
    const encoded = smartValues(template).filter(({ expression }) => isEncoded(expression)).length;
    const parsed = JSON.parse(render(template));
    assert.equal(parsed.issue?.fields?.summary, HOSTILE, "the summary round-trips through .jsonEncode");
    assert.equal(
      stringsIn(parsed).filter((value) => value === HOSTILE).length,
      encoded,
      "every encoded value round-trips",
    );
  }
});

test("the same hostile text inserted raw breaks every template (TLSSN-40, TLSSN-41)", () => {
  for (const template of templates(doc)) {
    const unencoded = template.replace(/\.jsonEncode(\s*\}\})/g, "$1");
    assert.notEqual(unencoded, template);
    assert.throws(() => JSON.parse(render(unencoded)), SyntaxError);
  }
});

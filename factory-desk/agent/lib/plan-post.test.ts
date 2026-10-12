import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlanComment } from "./plan-comment.js";
import { DIGEST_COMMENT } from "./plan-comment.fixtures.js";
import { SLACK_LIMITS, escapeMrkdwn, fitMrkdwn, fitPlain, jiraSiteUrl, link, planBlocks, planCommentUrl, planPost, ticketUrl, type Block } from "./plan-post.js";

const TICKET = "https://x.atlassian.net/browse/TLSSN-42";
const PLAN = "https://x.atlassian.net/browse/TLSSN-42?focusedCommentId=10077";
const digest = parsePlanComment(DIGEST_COMMENT, "TLSSN-42");

function texts(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) => {
    const out: string[] = [];
    const text = block["text"] as { text?: string } | undefined;
    if (text?.text !== undefined) out.push(text.text);
    for (const field of (block["fields"] as { text: string }[] | undefined) ?? []) out.push(field.text);
    for (const element of (block["elements"] as { text: string }[] | undefined) ?? []) out.push(element.text);
    return out;
  });
}

function assertWithinLimits(blocks: readonly Block[]): void {
  assert.ok(blocks.length <= SLACK_LIMITS.blocks, `${blocks.length} blocks`);
  for (const block of blocks) {
    const text = block["text"] as { type: string; text: string } | undefined;
    if (block["type"] === "header") assert.ok(text!.text.length <= SLACK_LIMITS.headerText);
    else if (text !== undefined) assert.ok(text.text.length <= SLACK_LIMITS.sectionText, `section of ${text.text.length}`);
    const fields = (block["fields"] as { text: string }[] | undefined) ?? [];
    assert.ok(fields.length <= SLACK_LIMITS.fields);
    for (const field of fields) assert.ok(field.text.length <= SLACK_LIMITS.fieldText);
  }
}

test("a digest plan posts header, problem, approach, risk and size, areas, test plan, the Next line, and links; the brief stays on Jira", () => {
  const { text, blocks } = planPost({ issueKey: "TLSSN-42", title: "Retry CSV export on empty filter", tracker: "transitioned", digest, ticketUrl: TICKET, planUrl: PLAN, originatorUserId: "U0ALICE01" });
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["header", "section", "section", "section", "section", "section", "divider", "section", "context"]
  );
  assert.deepEqual(blocks[0], { type: "header", text: { type: "plain_text", text: "TLSSN-42 is planned: Retry CSV export on empty filter" } });
  assert.deepEqual(texts(blocks).slice(1, 7), [
    "*Problem*\nCSV exports with an empty filter fail with a 500 instead of an empty file.",
    "*Approach*\nRowSource reports an explicit empty outcome. buildRows returns it, so the guard only sees real failures.",
    "*Risk*\nMedium. Callers that treated the 500 as a retry signal stop retrying.",
    "*Size*\nSmall. One module and its test.",
    "*Files or areas*\n\u2022 src/export/csv.ts\n\u2022 src/export/csv.test.ts",
    "*Test plan*\n\u2022 npm test in src/export\n\u2022 Export an empty filter and get a header-only CSV",
  ]);
  assert.equal(
    texts(blocks)[7],
    "<@U0ALICE01>, react ✅ to start the build or ❌ to stop, or reply `approve` / `deny`."
  );
  assert.match(texts(blocks)[8]!, /^<https:\/\/x\.atlassian\.net\/browse\/TLSSN-42\|TLSSN-42 on Jira>  ·  <https:\/\/x\.atlassian\.net\/browse\/TLSSN-42\?focusedCommentId=10077\|Full plan and worker brief>  ·  Evidence: read the example-org\/apj-gtm checkout$/);
  assertWithinLimits(blocks);
  const all = [text, ...texts(blocks)].join("\n");
  assert.doesNotMatch(all, /```|Implement Jira TLSSN-42|Brief/, "the worker brief is on the Plan comment, not in Slack");

  assert.match(text, /^<@U0ALICE01> TLSSN-42 is planned: Retry CSV export on empty filter\.\nProblem: CSV exports/);
  assert.match(text, /\nRisk: Medium\. Callers[^\n]*\| Size: Small\. One module and its test\.\n/);
  assert.match(text, /\nFiles or areas: src\/export\/csv\.ts, src\/export\/csv\.test\.ts\n/);
  assert.match(text, /\nThe plan is on the ticket: https:\/\/x\.atlassian\.net\/browse\/TLSSN-42\?focusedCommentId=10077\n/);
  assert.match(text, /\nReact ✅ to start the build or ❌ to stop, or reply `approve` \/ `deny`\.( |$)/);
  assert.doesNotMatch(all, /Nothing is built|Next:/);
});

test("where a plain reply never reaches the desk, the plan post offers reactions only, still with no mention", () => {
  const { text, blocks } = planPost({ issueKey: "TLSSN-42", title: "Retry", tracker: "transitioned", originatorUserId: "U0ALICE01", bareReply: false });
  assert.equal(texts(blocks).at(-2), "<@U0ALICE01>, react ✅ to start the build or ❌ to stop.");
  assert.ok(text.endsWith("\nReact ✅ to start the build or ❌ to stop."));
  assert.doesNotMatch(text, /@factory|`approve`|deny TLSSN-42/);
});

test("a DM or watched channel keeps the typed replies: no mention, and only the decision on this plan", () => {
  const { text, blocks } = planPost({ issueKey: "TLSSN-42", title: "Retry", tracker: "transitioned", originatorUserId: "U0ALICE01" });
  assert.equal(texts(blocks).at(-2), "<@U0ALICE01>, react ✅ to start the build or ❌ to stop, or reply `approve` / `deny`.");
  assert.ok(text.endsWith("\nReact ✅ to start the build or ❌ to stop, or reply `approve` / `deny`."));
  assert.doesNotMatch(text, /@factory|no mention needed|Nothing is built|until then/);
});

test("a TLSSN-27-sized plan fits a phone: no code fence, lists cut to six, the evidence file list counted", () => {
  const files = Array.from({ length: 11 }, (_, i) => `app/banking/file-${i}.tsx`);
  const big = parsePlanComment(
    [
      "Plan: TLSSN-27 Activity search ignores transaction id",
      `Evidence: read the cursor-demo-lab/marsbank checkout (${files.join(", ")}). Recorded by the factory planner.`,
      "Summary: Activity ?q= matches description only.",
      "Approach: Widen the predicate.",
      "Areas:",
      ...files.map((file) => `- ${file}`),
      "Brief:",
      Array.from({ length: 80 }, (_, i) => `brief line ${i}`).join("\n"),
    ].join("\n\n"),
    "TLSSN-27"
  );
  const { text, blocks } = planPost({ issueKey: "TLSSN-27", title: "Activity search ignores transaction id", tracker: "transitioned", digest: big, ticketUrl: TICKET, planUrl: PLAN, originatorUserId: "U0ALICE01" });
  const all = texts(blocks).join("\n");
  assert.doesNotMatch(all, /```|brief line/);
  assert.doesNotMatch(text, /brief line/);
  assert.match(all, /\u2022 app\/banking\/file-5\.tsx\nand 5 more/);
  assert.match(all, /Evidence: read the cursor-demo-lab\/marsbank checkout \(11 files\)$/);
  assert.ok(all.split("\n").length <= 20, `${all.split("\n").length} lines`);
});

test("a legacy digest says the plan predates the digest", () => {
  const legacy = parsePlanComment("Plan: TLSSN-42 Retry\nProblem\nEmpty filter.\nBrief:\nDo it.", "TLSSN-42");
  const blocks = planBlocks({ issueKey: "TLSSN-42", title: "Retry", tracker: "transitioned", digest: legacy, ticketUrl: TICKET });
  assert.ok(texts(blocks).some((entry) => /before the plan digest existed/.test(entry)));
  assert.ok(texts(blocks).includes("*Problem*\nEmpty filter."));
});

test("user content is escaped in mrkdwn and in the fallback, and left literal in the plain_text header", () => {
  const hostile = parsePlanComment(
    ["Plan: TLSSN-42 x", "Summary: <!channel> & <https://evil.example|click> > here", "Areas:", "- a<b>&c", "Brief:", "if (a < b && c > d) {}"].join("\n\n"),
    "TLSSN-42"
  );
  const { text, blocks } = planPost({ issueKey: "TLSSN-42", title: "A & B <x>", tracker: "transitioned", digest: hostile });
  assert.equal((blocks[0]!["text"] as { text: string }).text, "TLSSN-42 is planned: A & B <x>");
  const all = texts(blocks).slice(1).join("\n");
  assert.match(all, /&lt;!channel&gt; &amp; &lt;https:\/\/evil\.example\|click&gt; &gt; here/);
  assert.match(all, /a&lt;b&gt;&amp;c/);
  assert.doesNotMatch(all, /<!channel>|<https:\/\/evil/);
  assert.match(text, /A &amp; B &lt;x&gt;/);
  assert.doesNotMatch(text, /<!channel>/);
  assert.equal(escapeMrkdwn("a & <b>"), "a &amp; &lt;b&gt;");
  assert.equal(link({ url: "https://x.test/a|b c>", label: "A & B" }), "<https://x.test/a%7Cb%20c%3E|A &amp; B>");
});

test("oversized parts are cut on grapheme boundaries with an ellipsis and a full-plan link, inside every Slack limit", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const long = parsePlanComment(
    [
      "Plan: TLSSN-42 x",
      `Summary: ${"&".repeat(2000)}`,
      `Approach: ${family.repeat(800)}`,
      "Areas:",
      ...Array.from({ length: 30 }, (_, i) => `- src/area-${i}.ts`),
      `Risk: high. ${"r".repeat(5000)}`,
      "Brief:",
      Array.from({ length: 900 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n"),
    ].join("\n\n"),
    "TLSSN-42"
  );
  const { text, blocks } = planPost({ issueKey: "TLSSN-42", title: "t".repeat(400), tracker: "transitioned", digest: long, ticketUrl: TICKET, planUrl: PLAN });
  assertWithinLimits(blocks);
  const header = (blocks[0]!["text"] as { text: string }).text;
  assert.equal(header.length, SLACK_LIMITS.headerText);
  assert.ok(header.endsWith("\u2026"));

  const [problem, approach, fields, areas] = blocks.slice(1, 5);
  const more = `<${PLAN}|full plan on the ticket>`;
  const problemText = (problem!["text"] as { text: string }).text;
  assert.ok(problemText.endsWith(`\u2026 ${more}`));
  assert.match(problemText, /^\*Problem\*\n(?:&amp;)+\u2026 /);
  const approachText = (approach!["text"] as { text: string }).text;
  const kept = approachText.slice("*Approach*\n".length, approachText.indexOf("\u2026"));
  assert.equal(kept.length % family.length, 0);
  assert.equal(kept, family.repeat(kept.length / family.length));
  const risk = (fields!["fields"] as { text: string }[])[0]!.text;
  assert.equal(risk.length, SLACK_LIMITS.fieldText);
  assert.ok(risk.endsWith("\u2026"));
  assert.match((areas!["text"] as { text: string }).text, /\u2022 src\/area-5\.ts\nand 24 more$/);
  assert.equal(blocks.filter((block) => /```/.test((block["text"] as { text?: string } | undefined)?.text ?? "")).length, 0);

  assert.ok(text.length <= 39000);
  assert.match(text, /\nFiles or areas: src\/area-0\.ts, [^\n]*src\/area-5\.ts, and 24 more\n/);
  assert.ok(text.endsWith("TLSSN-42 was filed in Jira: to start the build, move the card to Approved in Jira."));
  assert.equal(blocks.at(-2)!.type, "section");
  assert.equal(blocks.at(-1)!.type, "context");
});

test("fit helpers never split an entity or a surrogate pair", () => {
  assert.equal(fitMrkdwn("a&b", 10), "a&amp;b");
  assert.equal(fitMrkdwn("&&&&", 10), "&amp;\u2026");
  assert.equal(fitMrkdwn("&&&&", 11), "&amp;&amp;\u2026");
  assert.equal(fitMrkdwn("\u{1F600}\u{1F600}\u{1F600}", 5), "\u{1F600}\u{1F600}\u2026");
  assert.equal(fitMrkdwn("abcdef", 6, { suffix: " <u|more>", prefix: "*L*\n" }), "*L*\n\u2026 <u|more>");
  assert.equal(fitPlain("\u{1F600}".repeat(100), 9), "\u{1F600}".repeat(4) + "\u2026");
});

test("the ticket and plan-comment URLs come from the site, the key, and the comment id", () => {
  assert.equal(jiraSiteUrl({ JIRA_CLOUD_ID: "https://acme.atlassian.net/" }), "https://acme.atlassian.net");
  assert.equal(jiraSiteUrl({ JIRA_CLOUD_ID: "0f6a3e2c-1111-4222-8333-944455556666" }), undefined);
  assert.equal(jiraSiteUrl({}), "https://<JIRA_SITE>.atlassian.net");
  assert.equal(ticketUrl({ issueKey: "TLSSN-7", site: "https://acme.atlassian.net" }), "https://acme.atlassian.net/browse/TLSSN-7");
  assert.equal(ticketUrl({ issueKey: "TLSSN-7", url: TICKET, site: "https://acme.atlassian.net" }), TICKET);
  assert.equal(ticketUrl({ issueKey: "TLSSN-7" }), undefined);
  assert.equal(planCommentUrl({ ticketUrl: TICKET, commentId: "10077" }), PLAN);
  assert.equal(planCommentUrl({ ticketUrl: TICKET }), TICKET);
  assert.equal(planCommentUrl({ ticketUrl: TICKET, commentId: "abc" }), TICKET);
  assert.equal(planCommentUrl({ commentId: "10077" }), undefined);
});

test("plan copy never writes FACTORY_DESK_SLACK_HANDLE into the decision line", () => {
  const saved = process.env.FACTORY_DESK_SLACK_HANDLE;
  process.env.FACTORY_DESK_SLACK_HANDLE = "factory-bot";
  try {
    const { text } = planPost({ issueKey: "TLSSN-42", title: "Retry", tracker: "transitioned", originatorUserId: "U0ALICE01" });
    assert.match(text, /reply `approve` \/ `deny`\.$/);
    assert.doesNotMatch(text, /@factory-bot|@factory-desk/);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_DESK_SLACK_HANDLE;
    else process.env.FACTORY_DESK_SLACK_HANDLE = saved;
  }
});

test("a ticket filed in Jira says it can only be approved by moving the card, and offers no Slack reply", () => {
  const { text, blocks } = planPost({ issueKey: "TLSSN-42", title: "Retry", tracker: "transitioned", ticketUrl: TICKET });
  const decide = "TLSSN-42 was filed in Jira: to start the build, move the card to Approved in Jira.";
  assert.equal(texts(blocks).at(-2), decide);
  assert.ok(text.endsWith(decide));
  assert.doesNotMatch(text, /`approve TLSSN-42`/);
  assert.doesNotMatch(texts(blocks).join("\n"), /<@/);
});

test("fit helpers and the plan header cut a title between words, never mid-word", () => {
  assert.equal(fitPlain("Offset shows zero for loans", 16), "Offset shows\u2026");
  assert.equal(fitMrkdwn("Offset shows zero for loans", 16), "Offset shows\u2026");
  assert.equal(fitMrkdwn("Offset <shows> zero for loans", 19), "Offset &lt;shows\u2026");
  const title = 'Small one on Accounts: a home loan with no linked offset account shows "Offset 0.00" in the Held column, which reads like the offset is empty rather than not set up.';
  const { blocks, text } = planPost({ issueKey: "TLSSN-42", title, tracker: "transitioned", digest: parsePlanComment("Plan: TLSSN-42 x\n\nSummary: s", "TLSSN-42"), ticketUrl: TICKET, planUrl: PLAN });
  const header = (blocks[0]!["text"] as { text: string }).text;
  const whole = `TLSSN-42 is planned: ${title}`;
  assert.ok(header.length <= SLACK_LIMITS.headerText && header.endsWith("\u2026"));
  const kept = header.slice(0, -1);
  assert.ok(whole.startsWith(kept));
  assert.match(whole.slice(kept.length), /^[\s,]/, `cut mid-word: …${kept.slice(-12)}|${whole.slice(kept.length, kept.length + 8)}`);
  assert.ok(text.includes(title), "the plain-text fallback keeps the whole title");
});

test("fit helpers end before a path when a space is near, and leave no separator before the …", () => {
  assert.equal(fitPlain("Offset shows, zero for loans", 15), "Offset shows\u2026");
  assert.equal(fitMrkdwn("Offset shows, zero for loans", 15), "Offset shows\u2026");
  const line = "The Held column is wrong in components/banking/accounts-table.tsx for loans";
  assert.equal(fitPlain(line, 50), "The Held column is wrong in\u2026");
  assert.equal(fitMrkdwn(line, 50), "The Held column is wrong in\u2026");
});

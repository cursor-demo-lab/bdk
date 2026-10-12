import assert from "node:assert/strict";
import { test } from "node:test";
import { DIGEST_COMMENT } from "./plan-comment.fixtures.js";
import { isPlanComment, latestPlanComment, parsePlanComment } from "./plan-comment.js";

// jiraComment before the approval digest existed.
const LEGACY_COMMENT = DIGEST_COMMENT.split("\n")
  .filter((_line, index) => index < 3 || index > 18)
  .join("\n");

test("a digest comment yields every approval field, first occurrence winning over the body", () => {
  assert.deepEqual(parsePlanComment(DIGEST_COMMENT, "TLSSN-42"), {
    format: "digest",
    title: "Retry CSV export on empty filter",
    evidence: "read the example-org/demo-repo checkout. Recorded by the factory planner; approve in the Slack thread to launch a cloud agent on it.",
    summary: "CSV exports with an empty filter fail with a 500 instead of an empty file.",
    approach: "RowSource reports an explicit empty outcome. buildRows returns it, so the guard only sees real failures.",
    areas: ["src/export/csv.ts", "src/export/csv.test.ts"],
    testPlan: ["npm test in src/export", "Export an empty filter and get a header-only CSV"],
    risk: { level: "medium", reason: "Callers that treated the 500 as a retry signal stop retrying." },
    size: { estimate: "small", reason: "One module and its test." },
    brief: "Implement Jira TLSSN-42 on example-org/demo-repo from main: Retry CSV export on empty filter\nTests:\n- npm test in src/export",
  });
});

test("the same comment read back from Jira's document format, without blank lines or list dashes, parses the same", () => {
  const flattened = DIGEST_COMMENT.split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.replace(/^- /, ""))
    .join("\r\n");
  const parsed = parsePlanComment(flattened, "TLSSN-42");
  assert.equal(parsed.format, "digest");
  assert.deepEqual(parsed.areas, ["src/export/csv.ts", "src/export/csv.test.ts"]);
  assert.deepEqual(parsed.testPlan, ["npm test in src/export", "Export an empty filter and get a header-only CSV"]);
  assert.deepEqual(parsed.risk, { level: "medium", reason: "Callers that treated the 500 as a retry signal stop retrying." });
  assert.match(parsed.brief ?? "", /^Implement Jira TLSSN-42/);
});

test("a legacy comment falls back to the body's own headings", () => {
  assert.deepEqual(parsePlanComment(LEGACY_COMMENT, "TLSSN-42"), {
    format: "legacy",
    title: "Retry CSV export on empty filter",
    evidence: "read the example-org/demo-repo checkout. Recorded by the factory planner; approve in the Slack thread to launch a cloud agent on it.",
    summary: "An export whose filter matches no rows returns a 500.",
    approach: "`RowSource` gains an explicit `empty` outcome.",
    areas: ["src/export/csv.ts"],
    testPlan: ["npm test in src/export"],
    risk: { reason: "Callers that treated the 500 as a retry signal" },
    brief: "Implement Jira TLSSN-42 on example-org/demo-repo from main: Retry CSV export on empty filter\nTests:\n- npm test in src/export",
  });
});

test("a bare comment shows what it has and nothing else", () => {
  assert.deepEqual(parsePlanComment("Plan: TLSSN-42 Retry\nBrief:\nDo it.", "TLSSN-42"), {
    format: "legacy",
    title: "Retry",
    areas: [],
    testPlan: [],
    brief: "Do it.",
  });
  assert.deepEqual(parsePlanComment("Plan: TLSSN-42", "TLSSN-42"), { format: "legacy", areas: [], testPlan: [] });
});

test("unlabelled grades and colons inside content stay content", () => {
  const body = ["Plan: TLSSN-42 x", "Summary: Fix it. Note: carefully.", "Risk: unclear until the export owners weigh in", "Size: XL"].join("\n\n");
  const parsed = parsePlanComment(body, "TLSSN-42");
  assert.equal(parsed.summary, "Fix it. Note: carefully.");
  assert.deepEqual(parsed.risk, { reason: "unclear until the export owners weigh in" });
  assert.deepEqual(parsed.size, { reason: "XL" });
});

test("the latest Plan: comment for exactly this key wins", () => {
  const comments = [
    { id: "1", body: "Triage: bug" },
    { id: "2", body: "Plan: TLSSN-42 First\nBrief:\nOld." },
    { id: "3", body: "Plan: TLSSN-420 Other\nBrief:\nNot this." },
    { id: "4", body: "\nPlan: TLSSN-42 Second\nBrief:\nNew." },
    { body: "Someone: Plan: TLSSN-42 quoted" },
  ];
  assert.equal(latestPlanComment(comments, "TLSSN-42")?.id, "4");
  assert.equal(latestPlanComment(comments, "TLSSN-4"), undefined);
  assert.equal(isPlanComment("Plan: TLSSN-42", "TLSSN-42"), true);
  assert.equal(isPlanComment("Plan: TLSSN-420", "TLSSN-42"), false);
});

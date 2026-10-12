import { defineEval, includes, satisfies } from "@cursor/july/evals";
import { sandboxUnavailable, searchedWorkspaceWithout } from "./support.js";

const KEY = "TLSSN-42";

function lacks(pattern: RegExp, label: string) {
  return satisfies((value) => !pattern.test(String(value ?? "")), label);
}

const CSV_EXPORT = [
  "export function runExport(filter: { rows: unknown[] }) {",
  "  if (filter.rows.length === 0) throw new Error('500 empty filter');",
  "  return filter.rows;",
  "}",
].join("\n");

const TRANSFER = [
  "export const TRANSFER_REFERENCE_MAX = 60;",
  "",
  "export function parseTransfer(input: { amount: string; reference?: string }) {",
  "  const reference = (input.reference ?? '').trim();",
  "  if (reference.length > TRANSFER_REFERENCE_MAX) throw new Error('reference too long');",
  "  return { amount: Number(input.amount), reference };",
  "}",
].join("\n");

const MOVE_TOKENS_FORM = [
  "import { TRANSFER_REFERENCE_MAX } from './transfer';",
  "",
  "export function MoveTokensForm() {",
  "  return (",
  "    <label>",
  "      Transfer reference",
  "      <input name=\"reference\" maxLength={TRANSFER_REFERENCE_MAX} placeholder=\"Optional note\" />",
  "      <small>Shown on both statements.</small>",
  "    </label>",
  "  );",
  "}",
].join("\n");

// TLSSN-42 (2026-09-27): the reporter said "Keep the 60 limit", and the plan
// set TRANSFER_REFERENCE_MAX to 280.
const TLSSN_42_REQUEST = [
  `Plan ${KEY}: Transfer reference box stops at 60 characters with no counter`,
  "",
  "Reporter's request, verbatim from Slack:",
  '> The "Transfer reference" box on the Move tokens form just stops accepting text at 60 characters, with no counter or message, so people think the keyboard broke.',
  '> Could it show a live count under the field (like "42 / 60") and change the hint once you hit the limit? Keep the 60 limit and the "Optional note" placeholder as they are.',
  "",
  "End of the reporter's request.",
].join("\n");

const RAISES_LIMIT = /TRANSFER_REFERENCE_MAX\W+(?:to|at|=|of)\W*(?!60\b)\d+|\b(?:raise|increase|bump|lift)\w*\s+(?:the\s+)?(?:60[- ]character\s+)?(?:limit|cap|max)\w*\s+to\s+\d+/i;

export default defineEval({
  tags: ["smoke"],
  cases: [
    {
      id: "records-once",
      description: "When the sandbox has the claimed export path, the plan is recorded once with checkout evidence.",
      async test(t) {
        await t.send(
          `Plan ${KEY}: retry CSV export on empty filter. The export job returns 500 when the filter matches no rows; it should return an empty file.`,
          {
            workspaceFiles: {
              "src/export/csv.ts": CSV_EXPORT,
              "src/export/csv.test.ts": "test('empty filter', () => {});\n",
            },
          }
        );
        t.succeeded();
        t.noFailedActions();
        t.calledTool("search_sandbox");
        t.calledTool("record_plan", { count: 1, input: { issueKey: KEY, evidence: "checkout" } });
        t.notCalledTool("record_needs_info");
        t.check(t.reply, includes(KEY));
        t.check(t.reply, includes(/Brief:/));
        t.check(t.reply, includes(/approve/i));
        t.check(t.reply, lacks(/\bI (merged|launched|opened a pull request|pushed)\b/i, "does not claim to build"));
      },
    },
    {
      id: "no-key-no-plan",
      description: "A request without a ticket key asks for one and records nothing.",
      async test(t) {
        await t.send("Plan retrying the CSV export when the filter is empty.");
        t.succeeded();
        t.noFailedActions();
        t.notCalledTool("record_plan");
        t.notCalledTool("record_needs_info");
        t.check(t.reply, includes(/key|TLSSN/i));
      },
    },
    {
      id: "csv-not-on-sandbox",
      description: "A CSV-export ticket on a tree with no CSV export is Needs info, not an invented plan, and the search actually read that tree.",
      async test(t) {
        // Seeded so search_sandbox reads the workspace and never the GitHub
        // tree. Unseeded, a 403 on the sandbox repo returned available: false
        // and the case passed without the planner checking anything.
        await t.send(
          `Plan ${KEY}: the CSV export returns 500 when the filter matches no rows; return an empty file instead.`,
          {
            workspaceFiles: {
              "src/transfers/transfer.ts": TRANSFER,
              "src/transfers/move-tokens-form.tsx": MOVE_TOKENS_FORM,
            },
          }
        );
        t.succeeded();
        t.noFailedActions();
        t.calledTool("search_sandbox", { output: searchedWorkspaceWithout(/csv/i) });
        t.calledTool("search_sandbox", { output: sandboxUnavailable, count: 0 });
        t.calledTool("record_needs_info", { count: 1, input: { issueKey: KEY } });
        t.notCalledTool("record_plan");
        t.check(t.reply, includes(/Needs info|not on|no csv|no export|mismatch/i));
        t.check(t.reply, lacks(/Brief:/, "does not hand the worker a brief"));
      },
    },
    {
      id: "keeps-reporter-constraints",
      description: "TLSSN-42: the reporter said to keep the 60 limit and the placeholder; the plan adds the counter and keeps both.",
      async test(t) {
        await t.send(TLSSN_42_REQUEST, {
          workspaceFiles: {
            "src/transfers/transfer.ts": TRANSFER,
            "src/transfers/move-tokens-form.tsx": MOVE_TOKENS_FORM,
          },
        });
        t.succeeded();
        t.calledTool("record_plan", { count: 1, input: { issueKey: KEY, evidence: "checkout" } });
        t.notCalledTool("record_needs_info");
        t.calledTool("record_plan", {
          input: (value: unknown) => {
            const plan = value as { why?: { preserve?: string[] } };
            return (plan.why?.preserve ?? []).some((entry) => /\b60\b/.test(entry)) && !RAISES_LIMIT.test(JSON.stringify(value));
          },
        });
        t.check(t.reply, lacks(RAISES_LIMIT, "the reply never raises the limit"));
      },
    },
  ],
});

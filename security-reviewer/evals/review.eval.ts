import { defineEval, includes } from "@cursor/july/evals";

const OPENED = [
  "GitHub pull request trigger: acme/api#12",
  "Action: opened",
  "PR: https://github.com/acme/api/pull/12",
  "Title: Search results",
  "Head: feat/search (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
  "Base: main",
  "Author: sam",
  "",
  "Read pr/diff.patch.",
].join("\n");

type Findings = { findings?: { file?: string }[] };

// post_findings answers an eval session with { posted: false, reason: "eval" }
// instead of posting; the event stream carries it as JSON text.
function isEvalResult(value: unknown): boolean {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return JSON.stringify(parsed) === JSON.stringify({ posted: false, reason: "eval" });
  } catch {
    return false;
  }
}

// July 0.2.2 snapshots t.reply before send resolves, so the reply is read
// from the turn that send returns.
export default defineEval({
  tags: ["smoke"],
  cases: [
    {
      id: "xss",
      description: "Unescaped query reflection is posted as a finding.",
      async test(t) {
        const turn = await t.send(OPENED, {
          workspaceFiles: {
            "pr/diff.patch": [
              "diff --git a/app/routes/search.ts b/app/routes/search.ts",
              "+res.send(`<h1>Results for ${req.query.q}</h1>`);",
            ].join("\n"),
          },
        });
        t.succeeded();
        turn.calledTool("post_findings", {
          input: (value) => ((value as Findings).findings ?? []).some((item) => item.file === "app/routes/search.ts"),
          output: isEvalResult,
          count: 1,
        });
        // Unfiltered, so a schema-rejected attempt before the valid one fails.
        turn.calledTool("post_findings", { count: 1 });
        t.check(turn.message, includes(/xss|cross-site|injection|finding/i));
      },
    },
    {
      id: "clean",
      description: "A docs-only change is posted as clean.",
      async test(t) {
        const turn = await t.send(OPENED.replace("Search results", "Docs"), {
          workspaceFiles: {
            "pr/diff.patch": [
              "diff --git a/README.md b/README.md",
              "+# API",
            ].join("\n"),
          },
        });
        t.succeeded();
        turn.calledTool("post_findings", {
          input: (value) => (value as Findings).findings?.length === 0,
          output: isEvalResult,
          count: 1,
        });
        turn.calledTool("post_findings", { count: 1 });
        // The instructions ask for the count and one line per finding.
        t.check(turn.message, includes(/\b0\b|\bzero\b|\bno findings\b|\bno vulnerabilities\b|\bclean\b/i));
      },
    },
  ],
});

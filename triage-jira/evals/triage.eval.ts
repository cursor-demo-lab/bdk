import { defineEval, includes } from "@cursor/july/evals";
import { formatQueuePrompt } from "../agent/lib/parse-queue-event.js";

export default defineEval({
  tags: ["smoke"],
  cases: [
    {
      id: "bug",
      description: "A concrete failure is recorded as a bug.",
      async test(t) {
        await t.send(
          formatQueuePrompt({
            identifier: "TRI-101",
            title: "CSV export returns 500",
            description:
              "Export to CSV has failed with a 500 since this morning. Request id 41ac. Retrying does not help.",
            url: "https://linear.app/acme/issue/TRI-101",
            reporter: "Sam",
          })
        );
        t.succeeded();
        t.calledTool("record_triage");
        t.check(t.reply, includes(/bug/i));
      },
    },
    {
      id: "question",
      description: "A how-does-it-work ask is recorded as a question.",
      async test(t) {
        await t.send(
          formatQueuePrompt({
            identifier: "TRI-102",
            title: "Rotate staging API keys",
            description:
              "How do I rotate the API keys for the staging environment?",
            url: "https://linear.app/acme/issue/TRI-102",
            reporter: "Morgan",
          })
        );
        t.succeeded();
        t.calledTool("record_triage");
        t.check(t.reply, includes(/question/i));
      },
    },
    {
      id: "feedback",
      description: "A suggestion is recorded as feedback.",
      async test(t) {
        await t.send(
          formatQueuePrompt({
            identifier: "TRI-103",
            title: "Collapse onboarding profile pages",
            description:
              "The onboarding wizard has too many steps. You should collapse the profile pages into one.",
            url: "https://linear.app/acme/issue/TRI-103",
            reporter: "Riley",
          })
        );
        t.succeeded();
        t.calledTool("record_triage");
        t.check(t.reply, includes(/feedback/i));
      },
    },
    {
      id: "failure-question",
      description: "A question about a failure that already happened is recorded as a bug.",
      async test(t) {
        await t.send(
          formatQueuePrompt({
            identifier: "TRI-104",
            title: "Why did my export fail yesterday?",
            description: "My CSV export failed at 14:02 yesterday with a 500. Request id 9f2c.",
            url: "https://linear.app/acme/issue/TRI-104",
            reporter: "Sam",
          })
        );
        t.succeeded();
        t.calledTool("record_triage", { output: recorded("bug", "Bug") });
      },
    },
    {
      id: "feature-question",
      description: "A feature idea phrased as a question is recorded as feedback.",
      async test(t) {
        await t.send(
          formatQueuePrompt({
            identifier: "TRI-105",
            title: "Could we have dark mode?",
            description: "Could the dashboard get a dark mode? It is hard to read at night.",
            url: "https://linear.app/acme/issue/TRI-105",
            reporter: "Riley",
          })
        );
        t.succeeded();
        t.calledTool("record_triage", { output: recorded("feedback", "Story") });
      },
    },
  ],
});

// The recorded verdict, which the host judge owns when TYPESAFE_API_KEY is
// set. When Jev answered, it must also have picked the expected Jira type.
function recorded(kind: string, issueType: string) {
  return (value: unknown): boolean => {
    try {
      const parsed = (typeof value === "string" ? JSON.parse(value) : value) as {
        verdict?: { kind?: string };
        judge?: { status?: string; type?: { choice?: string } };
      };
      const typed = parsed.judge?.status !== "judged" || parsed.judge.type?.choice === issueType;
      return parsed.verdict?.kind === kind && typed;
    } catch {
      return false;
    }
  };
}

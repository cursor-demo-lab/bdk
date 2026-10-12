import { defineEval, includes, satisfies } from "@cursor/july/evals";

const REPO = "example-org/demo-repo";
const KEY = "TLSSN-42";

// cloud__launch no longer exists on the desk. The gate stays so a launch
// tool that comes back is caught.
const CLOUD_LAUNCH = "cloud__launch";
const FILE_TICKET = "file_ticket";
const APPROVE_TICKET = "approve_ticket";
const DENY_TICKET = "deny_ticket";
const REQUEST_PLAN = "request_plan";
// The announcements are host code (agent/lib/announce.ts), not tools. These
// gates stay so an announce tool that comes back is caught.
const ANNOUNCE_PLAN = "announce_plan";
const ANNOUNCE_PROGRESS = "announce_progress";

export default defineEval({
  tags: ["smoke"],
  timeoutMs: 180_000,
  cases: [
    {
      id: "chat-no-target",
      description: "A question with no ticket or PR is answered from instructions.",
      async test(t) {
        await t.send("What does this factory do?");
        t.succeeded();
        t.noFailedActions();
        t.usedNoTools();
        t.check(t.reply, includes(/approve/i));
        t.check(t.reply, satisfies((text) => !/I used/i.test(String(text)) && !/@factory-desk/i.test(String(text)), "no tool narration or @factory-desk"));
      },
    },
    {
      id: "jira-key-explain",
      description: "A status question about a ticket explains triage and uses no tool.",
      async test(t) {
        await t.send(`What happened to ${KEY}?`);
        t.succeeded();
        t.noFailedActions();
        t.usedNoTools();
        t.notCalledTool(ANNOUNCE_PLAN);
        t.notCalledTool(ANNOUNCE_PROGRESS);
        t.check(t.reply, includes(/triage/i));
        t.check(t.reply, includes(/this thread/i));
        t.check(t.reply, satisfies((text) => !/I used/i.test(String(text)), "no tool narration"));
      },
    },
    {
      id: "file-ticket-asks-first",
      description: "A request to file a bug asks for a plain approve file (no @factory: a plain reply in a factory thread reaches the desk) and does not create a ticket yet. Hosted Slack has no cards.",
      async test(t) {
        await t.send("File a bug: CSV export returns 500 when the filter matches no rows. Since this morning.");
        t.succeeded();
        t.noFailedActions();
        t.usedNoTools();
        t.notCalledTool(FILE_TICKET);
        t.check(t.reply, includes(/^React ✅ to file or ❌ to drop, or reply `approve file` \/ `deny file`\.$/m));
        t.check(t.reply, satisfies((text) => !/@factory (?:approve|deny)/i.test(String(text)), "in-thread commands carry no @factory"));
        // The prompt says who triaged it and the verdict in plain words (the desk's own, with no Jev block on this route), with no scores.
        // The lines instructions.md quotes from intake-triage.ts `unaskedFilingPrompt` (no Slack intake block on this route).
        t.check(t.reply, includes(/^Triaged by Grok 4\.6 Fast \(Jev wasn't asked\): (Bug|Task), (low|medium|high|urgent) severity\.$/m));
        t.check(t.reply, includes(/^Summary: \S/m));
        t.check(
          t.reply,
          satisfies((text) => {
            const lines = String(text).split("\n").map((line) => line.trim());
            const summary = lines.find((line) => line.startsWith("Summary: "))?.slice("Summary: ".length);
            const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
            return summary !== undefined && squash(summary) !== squash(lines[0] ?? "") && !/reported as "/.test(summary);
          }, "the summary is not the title line again or the title template (TLSSN-37)"),
        );
        t.check(t.reply, satisfies((text) => !/approve [A-Z][A-Z0-9]+-\d+|approve KEY|\b0\.\d\d\b|skill file|triage rubric from/i.test(String(text)), "no approve KEY before a key exists, no scores, no narration of loading a rubric"));
        t.check(t.reply, satisfies((text) => !/I used/i.test(String(text)) && !/@factory-desk/i.test(String(text)), "no tool narration or @factory-desk"));
      },
    },
    {
      id: "approve-file-includes-browse-url",
      description: "approve file after a named problem creates once, launches nothing, and the filed reply includes the Jira browse URL from the tool.",
      async test(t) {
        await t.send("File a bug: CSV export returns 500 when the filter matches no rows. Since this morning.");
        t.notCalledTool(FILE_TICKET);
        await t.send("approve file");
        t.succeeded();
        t.calledTool(FILE_TICKET, { count: 1, input: { kind: /^(bug|feedback|question)$/, severity: /^(low|medium|high|urgent)$/, summary: /\S/ } });
        t.maxToolCalls(1);
        t.notCalledTool(APPROVE_TICKET);
        t.notCalledTool(CLOUD_LAUNCH);
        t.check(t.reply, includes(/https:\/\/<JIRA_SITE>\.atlassian\.net\/browse\/EVALX-1/));
        // The tool's `reply` verbatim (TLSSN-36): the key link once and the triage it was filed with and who made it; no look-ahead.
        t.check(t.reply, includes(/^\[EVALX-1\]\(https:\/\/<JIRA_SITE>\.atlassian\.net\/browse\/EVALX-1\) is filed\. Triaged by (Jev|Grok 4\.6 Fast \([^)]+\)): (Bug|Task|Story), (low|medium|high|urgent) severity( \(\d{1,3}% confidence\))?\./));
        t.check(
          t.reply,
          satisfies(
            (text) => !/Triaged line|underway|I used|file_ticket|lands in this thread|\nNext: the planner/i.test(String(text)) && !/EVALX-1 is filed: /.test(String(text)),
            "no promised Triaged line, no key repeated after `is filed:`, no claim that planning is underway, no look-ahead, no tool narration",
          ),
        );
      },
    },
    {
      id: "approve-key-transitions",
      description: "approve KEY moves the ticket to Approved once and launches nothing. The worker launches on that status.",
      async test(t) {
        await t.send(`approve ${KEY}`);
        t.succeeded();
        t.calledTool(APPROVE_TICKET, { count: 1 });
        t.maxToolCalls(1);
        t.notCalledTool(CLOUD_LAUNCH);
        t.notCalledTool(ANNOUNCE_PROGRESS);
        t.check(t.reply, satisfies((text) => !/I used/i.test(String(text)) && !/approve_ticket/i.test(String(text)), "no tool narration"));
      },
    },
    {
      id: "deny-key-comments",
      description: "deny KEY records the denial on the ticket once and never approves.",
      async test(t) {
        await t.send(`deny ${KEY}`);
        t.succeeded();
        t.calledTool(DENY_TICKET, { count: 1 });
        t.maxToolCalls(1);
        t.notCalledTool(APPROVE_TICKET);
        t.check(t.reply, includes(/plan declined/i));
      },
    },
    {
      id: "plan-key-requests-plan",
      description: "A key plus a plan verb moves the ticket to Triaged once and never approves or launches.",
      async test(t) {
        await t.send(`plan ${KEY}`);
        t.succeeded();
        t.calledTool(REQUEST_PLAN, { count: 1 });
        t.maxToolCalls(1);
        t.notCalledTool(APPROVE_TICKET);
        t.notCalledTool(CLOUD_LAUNCH);
        t.check(t.reply, includes(/planner/i));
        t.check(
          t.reply,
          satisfies(
            (text) => !/I used|request_plan|lands in this thread|once it|nothing is built/i.test(String(text)),
            "says the ticket is with the planner, no look-ahead, no tool narration",
          ),
        );
      },
    },
    {
      id: "pr-status-no-drive",
      description: "A PR status question never drives and points at GitHub or the escalation channel.",
      async test(t) {
        await t.send(`What is the state of ${REPO}#12?`);
        t.succeeded();
        t.noFailedActions();
        t.usedNoTools();
        t.check(t.reply, includes(/github|factory-escalations/i));
      },
    },
    {
      id: "pr-url-fix-instructs",
      tags: ["route"],
      description: "A fix verb with a PR URL uses no tool and tells the person to type factory: drive on the PR.",
      async test(t) {
        await t.send(`Fix https://github.com/${REPO}/pull/1`);
        t.succeeded();
        t.noFailedActions();
        t.usedNoTools();
        t.check(t.reply, includes(/factory: drive/));
      },
    },
  ],
});

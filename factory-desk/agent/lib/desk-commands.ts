// The desk's routing phrases, one list per rule of the routing table in
// `agent/instructions.md`. `desk-commands.test.ts` parses that table and
// fails when the two drift. `KEY` stands for a Jira key.

export const DESK_COMMAND_PHRASES = {
  filing: [
    "file a bug",
    "raise a ticket",
    "create a ticket",
    "new ticket",
    "log this",
    "report a bug",
    "raise an issue",
    "create an issue",
    "log an issue",
  ],
  filingGate: ["approve file", "deny file"],
  approve: ["approve KEY"],
  deny: ["deny KEY"],
  plan: ["plan KEY", "replan KEY"],
  retry: ["retry KEY"],
  planWithKey: ["open a PR for", "implement", "build", "add", "ship"],
  fix: ["fix", "drive", "take over", "get CI green", "address the review"],
  status: ["what happened to", "state of", "status", "where is", "is the plan ready"],
} as const;

import assert from "node:assert/strict";
import { test } from "node:test";
import { jiraProjects } from "./config.js";
import {
  commentClaimKey,
  decideComment,
  decideStatusEvent,
  isStatusEvent,
  parseCommentEvent,
  planClaimKey,
  planFromStatus,
} from "./jira-event.js";

function payload(comment: string, { event = "comment_created", key = "TLSSN-42" }: { event?: string; key?: string } = {}) {
  return {
    webhookEvent: event,
    comment: { body: comment },
    issue: { key, fields: { summary: "CSV export returns 500" } },
  };
}

const opts = { triagedStatus: "Triaged", plannedStatus: "Planned", projects: ["TLSSN"] };

const skip = (reason: string, extra: Record<string, unknown> = {}) => ({ plan: false, reason, issueKey: "TLSSN-42", changelogId: "10041", from: "latest", ...extra });

const triaged = {
  timestamp: 1790124000000,
  webhookEvent: "jira:issue_updated",
  issue_event_type_name: "issue_generic",
  issue: {
    id: "10042",
    key: "TLSSN-42",
    fields: {
      summary: "CSV export returns 500",
      status: { name: "Triaged" },
      project: { key: "TLSSN" },
    },
  },
  changelog: {
    id: "10041",
    items: [{ field: "status", fieldtype: "jira", from: "10000", fromString: "To Do", to: "10005", toString: "Triaged" }],
  },
};

const replanned = {
  timestamp: 1790124600000,
  webhookEvent: "jira:issue_updated",
  issue_event_type_name: "issue_generic",
  issue: {
    id: "10042",
    key: "TLSSN-42",
    fields: {
      summary: "CSV export returns 500",
      status: { name: "Triaged" },
      project: { key: "TLSSN" },
    },
  },
  changelog: {
    id: "10057",
    items: [{ field: "status", fieldtype: "jira", from: "10006", fromString: "Planned", to: "10005", toString: "Triaged" }],
  },
};

const edited = {
  timestamp: 1790124000000,
  webhookEvent: "jira:issue_updated",
  issue_event_type_name: "issue_updated",
  issue: {
    id: "10042",
    key: "TLSSN-42",
    fields: {
      summary: "CSV export returns 500",
      status: { name: "Triaged" },
      project: { key: "TLSSN" },
    },
  },
  changelog: {
    id: "10043",
    items: [{ field: "summary", fieldtype: "jira", fromString: "CSV export 500", toString: "CSV export returns 500" }],
  },
};

const approved = {
  timestamp: 1790124000000,
  webhookEvent: "jira:issue_updated",
  issue_event_type_name: "issue_generic",
  issue: {
    id: "10042",
    key: "TLSSN-42",
    fields: {
      summary: "CSV export returns 500",
      status: { name: "Approved" },
      project: { key: "TLSSN" },
    },
  },
  changelog: {
    id: "10044",
    items: [{ field: "status", fieldtype: "jira", fromString: "Planned", toString: "Approved" }],
  },
};

const stale = {
  timestamp: 1790124000000,
  webhookEvent: "jira:issue_updated",
  issue_event_type_name: "issue_generic",
  issue: {
    id: "10042",
    key: "TLSSN-42",
    fields: {
      summary: "CSV export returns 500",
      status: { name: "Planned" },
      project: { key: "TLSSN" },
    },
  },
  changelog: {
    id: "10041",
    items: [{ field: "status", fieldtype: "jira", fromString: "To Do", toString: "Triaged" }],
  },
};

const otherProject = {
  timestamp: 1790124000000,
  webhookEvent: "jira:issue_updated",
  issue_event_type_name: "issue_generic",
  issue: {
    id: "20007",
    key: "OPS-7",
    fields: {
      summary: "Rotate staging keys",
      status: { name: "Triaged" },
      project: { key: "OPS" },
    },
  },
  changelog: {
    id: "20011",
    items: [{ field: "status", fieldtype: "jira", fromString: "To Do", toString: "Triaged" }],
  },
};

const created = {
  timestamp: 1790124000000,
  webhookEvent: "jira:issue_created",
  issue_event_type_name: "issue_created",
  issue: {
    id: "10042",
    key: "TLSSN-42",
    fields: {
      summary: "CSV export returns 500",
      status: { name: "To Do" },
      project: { key: "TLSSN" },
    },
  },
};

test("claim keys: one per transition on the status path, one per ticket on the comment path", () => {
  assert.equal(planClaimKey({ issueKey: "TLSSN-42", status: "Triaged", changelogId: "10041" }), "plan/TLSSN-42:Triaged:10041");
  assert.equal(commentClaimKey("TLSSN-42"), "plan-claimed/TLSSN-42");
});

test("a ticket entering Triaged is planned with its changelog id", () => {
  assert.deepEqual(decideStatusEvent(triaged, opts), {
    plan: true,
    request: { issueKey: "TLSSN-42", title: "CSV export returns 500" },
    changelogId: "10041",
    replan: false,
  });
  assert.deepEqual(decideStatusEvent({ ...triaged, webhookEvent: "issue_updated" }, opts), {
    plan: true,
    request: { issueKey: "TLSSN-42", title: "CSV export returns 500" },
    changelogId: "10041",
    replan: false,
  });
  assert.equal(isStatusEvent(triaged), true);
  assert.equal(isStatusEvent(payload("Triage: bug")), false);

  const automation = {
    webhookEvent: "jira:issue_updated",
    issue: {
      key: "TLSSN-42",
      fields: {
        summary: "CSV export returns 500",
        status: { name: "Triaged" },
        project: { key: "TLSSN" },
      },
    },
    changelog: {
      id: "TLSSN-42:Triaged:2026-09-24T00:00:00.000+0000",
      items: [{ field: "status", fromString: "To Do", toString: "Triaged" }],
    },
  };
  assert.deepEqual(decideStatusEvent(automation, opts), {
    plan: true,
    request: { issueKey: "TLSSN-42", title: "CSV export returns 500" },
    changelogId: "TLSSN-42:Triaged:2026-09-24T00:00:00.000+0000",
    replan: false,
  });
  assert.equal(isStatusEvent(automation), true);
});

test("status names compare case-insensitively and come from the options", () => {
  assert.equal(decideStatusEvent(triaged, { ...opts, triagedStatus: "triaged" }).plan, true);
  assert.deepEqual(decideStatusEvent(triaged, { ...opts, triagedStatus: "Ready to plan" }), { plan: false, reason: "other_status" });
});

test("every status payload that must not plan names its reason", () => {
  assert.deepEqual(decideStatusEvent(created, opts), { plan: false, reason: "ignored" });
  assert.deepEqual(decideStatusEvent({ ...triaged, issue: { ...triaged.issue, key: "not-a-key" } }, opts), { plan: false, reason: "ignored" });
  assert.deepEqual(decideStatusEvent(otherProject, opts), { plan: false, reason: "project_not_allowed" });
  assert.deepEqual(decideStatusEvent(edited, opts), { plan: false, reason: "not_status_change" });
  assert.deepEqual(decideStatusEvent({ ...triaged, changelog: undefined }, opts), { plan: false, reason: "not_status_change" });
  assert.deepEqual(decideStatusEvent(approved, opts), { plan: false, reason: "other_status" });
  assert.deepEqual(decideStatusEvent(stale, opts), { plan: false, reason: "stale_status" });
});

test("an empty project list allows every project", () => {
  assert.equal(decideStatusEvent(otherProject, { ...opts, projects: [] }).plan, true);
});

test("planFromStatus reads a Triage: comment with triage's Type: and Jev Judge: lines exactly as one without them", async () => {
  const base = "Triage: bug\nSeverity: high\nSummary: Export 500 yesterday.\nNext step: Inspect 9f2c.";
  const judged = base.replace("Triage: bug\n", "Triage: bug\nType: Bug\n") + "\nJudge: Jev type Bug 0.93 (set in Jira; model said question); severity high 0.84 (model said low)";
  const plain = await planFromStatus(triaged, { ...opts, readComments: async () => [base] });
  assert.equal(plain.plan, true);
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [judged] }), plain);
  const read: string[] = [];
  const question = "Triage: question\nType: Task\nSeverity: low\nSummary: x\nNext step: Answer it.\nJudge: Jev type Task 0.91 (set in Jira; agreed); severity low 0.9 (agreed)";
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async (issueKey) => (read.push(issueKey), [question]) }), skip("question"));
  assert.deepEqual(read, ["TLSSN-42"]);
});

test("planFromStatus plans a needs-info verdict once the desk's Detail from Slack: comment answers it", async () => {
  const needsInfo = "Triage: bug\nSeverity: low\nSummary: Export truncates.\nNext step: Name the page.\nNeeds info: Name the page.";
  const detail = "Detail from Slack: TLSSN-42\nbob replied in the ticket's Slack thread after triage asked for more information:\n\nThe /reports/export page.";
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [needsInfo, detail] }), {
    plan: true,
    request: {
      issueKey: "TLSSN-42",
      title: "CSV export returns 500",
      answer: "The /reports/export page.",
      verdict: { kind: "bug", severity: "low", nextStep: "Name the page." },
      summary: "Export truncates.",
    },
    changelogId: "10041",
    replan: false,
  });
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [detail, needsInfo] }), skip("needs_info"));
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => ["Triage: question\nSeverity: low", detail] }), skip("question"));
});

test("planFromStatus plans a Triage: bug and carries its verdict into the request", async () => {
  const decision = await planFromStatus(triaged, {
    ...opts,
    readComments: async () => [
      "Triage: question\nSeverity: low",
      "Someone: this is a real failure.",
      "Triage: bug\nSeverity: high\nSummary: Export 500 since this morning.\nNext step: Inspect 41ac.",
      "Triage: duplicate inbound TLSSN-51",
    ],
  });
  assert.deepEqual(decision, {
    plan: true,
    request: {
      issueKey: "TLSSN-42",
      title: "CSV export returns 500",
      verdict: { kind: "bug", severity: "high", nextStep: "Inspect 41ac." },
      summary: "Export 500 since this morning.",
    },
    changelogId: "10041",
    replan: false,
  });
});

test("planFromStatus plans without a verdict when there is no Triage: comment or no read", async () => {
  const expected = {
    plan: true,
    request: { issueKey: "TLSSN-42", title: "CSV export returns 500" },
    changelogId: "10041",
    replan: false,
  };
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [] }), expected);
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => undefined }), expected);
});

test("planFromStatus treats a bounce from To Do as a replan when a Plan: comment is on the ticket", async () => {
  let reads = 0;
  const decision = await planFromStatus(triaged, {
    ...opts,
    readComments: async () => {
      reads++;
      return [
        "Triage: bug\nSeverity: high",
        "Plan: TLSSN-42 Retry CSV export on empty filter\nEvidence: read the example-org/demo-repo checkout.\n\nProblem\nExport 500s on an empty filter.",
      ];
    },
  });
  assert.deepEqual(decision, {
    plan: true,
    request: { issueKey: "TLSSN-42", title: "CSV export returns 500", verdict: { kind: "bug", severity: "high" } },
    changelogId: "10041",
    replan: true,
  });
  assert.equal(reads, 1);
});

test("planFromStatus keeps a bounce from To Do a first plan when no Plan: comment for this key is on the ticket", async () => {
  const decision = await planFromStatus(triaged, {
    ...opts,
    readComments: async () => [
      "Triage: bug\nSeverity: high",
      "Plan requested: TLSSN-42",
      "Plan: TLSSN-420 Rotate staging keys",
      "Someone: Plan: TLSSN-42 is coming.",
    ],
  });
  assert.deepEqual(decision, {
    plan: true,
    request: { issueKey: "TLSSN-42", title: "CSV export returns 500", verdict: { kind: "bug", severity: "high" } },
    changelogId: "10041",
    replan: false,
  });
});

test("planFromStatus keeps Planned to Triaged a replan with or without a Plan: comment", async () => {
  const expected = {
    plan: true,
    request: { issueKey: "TLSSN-42", title: "CSV export returns 500" },
    changelogId: "10057",
    replan: true,
  };
  assert.deepEqual(await planFromStatus(replanned, { ...opts, readComments: async () => [] }), expected);
  assert.deepEqual(await planFromStatus(replanned, { ...opts, readComments: async () => ["Plan: TLSSN-42 Retry CSV export"] }), expected);
});

test("planFromStatus stops on needs-info and duplicate verdicts, and never reads for an ignored payload", async () => {
  assert.deepEqual(
    await planFromStatus(triaged, { ...opts, readComments: async () => ["Triage: bug\nSeverity: high\nNeeds info: which export?"] }),
    skip("needs_info")
  );
  assert.deepEqual(
    await planFromStatus(triaged, { ...opts, readComments: async () => ["Triage: bug\nSeverity: high\nDuplicate of: TLSSN-7"] }),
    skip("duplicate", { duplicateOf: "TLSSN-7" })
  );
  let reads = 0;
  const skipped = await planFromStatus(stale, {
    ...opts,
    readComments: async () => {
      reads++;
      return [];
    },
  });
  assert.deepEqual(skipped, { plan: false, reason: "stale_status" });
  assert.equal(reads, 0);
});

test("a Triage: bug or feedback comment is planned; question, needs-info, duplicate are not", () => {
  assert.equal(decideComment(payload("Triage: bug\nSeverity: high\nSummary: Export 500.\nNext step: Inspect.")).plan, true);
  assert.equal(decideComment(payload("Triage: feedback\nSeverity: low")).plan, true);
  assert.deepEqual(decideComment(payload("Triage: question\nSeverity: low")), { plan: false, reason: "question" });
  assert.deepEqual(decideComment(payload("Triage: bug\nSeverity: high\nNeeds info: which export?")), {
    plan: false,
    reason: "needs_info",
  });
  assert.deepEqual(decideComment(payload("Triage: duplicate inbound TLSSN-7")), { plan: false, reason: "duplicate" });
  assert.deepEqual(decideComment(payload("Triage: bug\nDuplicate of: TLSSN-7")), { plan: false, reason: "duplicate" });
});

test("Plan requested: starts a plan, and replan is flagged", () => {
  const asked = decideComment(payload("Plan requested: TLSSN-42"));
  assert.equal(asked.plan, true);
  if (asked.plan) {
    assert.equal(asked.replan, false);
    assert.equal(asked.request.issueKey, "TLSSN-42");
  }
  const again = decideComment(payload("Plan requested: TLSSN-42 replan"));
  assert.equal(again.plan, true);
  if (again.plan) assert.equal(again.replan, true);
});

test("other events and other comments are ignored", () => {
  assert.deepEqual(decideComment(payload("Triage: bug", { event: "jira:issue_created" })), { plan: false, reason: "ignored" });
  assert.deepEqual(decideComment(payload("Plan: TLSSN-42 Retry CSV export")), { plan: false, reason: "ignored" });
  assert.deepEqual(decideComment({ webhookEvent: "comment_created" }), { plan: false, reason: "ignored" });
  assert.deepEqual(decideComment(triaged), { plan: false, reason: "ignored" });
});

test("jira:comment_created is the same event, and ADF text flattens", () => {
  const parsed = parseCommentEvent({
    webhookEvent: "jira:comment_created",
    comment: { body: { content: [{ text: "Triage: bug" }, { text: "\nSeverity: high" }] } },
    issue: { key: "TLSSN-42", fields: { summary: "CSV export returns 500" } },
  });
  assert.equal(parsed?.kind, "triage");
  assert.equal(parsed?.request.issueKey, "TLSSN-42");
  assert.equal(parsed?.request.verdict?.kind, "bug");
});

// TLSSN-40 (2026-09-27): factory-desk filed it with its own Triage: comment,
// then triage-jira triaged it a second time. The desk's verdict governs.
const DESK_LINE = "Triaged in Slack by factory-desk before filing.";
const deskVerdict = "Triage: bug\nType: Bug\nSeverity: medium\nSummary: Freeze card lacks aria-describedby.\nNext step: Add it.";
const expectedDesk = {
  plan: true,
  request: {
    issueKey: "TLSSN-42",
    title: "CSV export returns 500",
    verdict: { kind: "bug", severity: "medium", nextStep: "Add it." },
    summary: "Freeze card lacks aria-describedby.",
  },
  changelogId: "10041",
  replan: false,
};

test("planFromStatus gates on the desk's marked Triage: comment, not a later second triage", async () => {
  const marked = `${deskVerdict}\n\n${DESK_LINE}`;
  for (const later of ["Triage: bug\nSeverity: low\nDuplicate of: TLSSN-38", "Triage: question\nSeverity: low", "Triage: bug\nNeeds info: which card?"]) {
    assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [marked, `${later}\nTriaged by: model (Jev was not above 0.52 on every answer)`] }), expectedDesk, later);
  }
});

test("planFromStatus lets a person's later Triage: comment (no Triaged by: line) correct the desk's verdict", async () => {
  const marked = `${deskVerdict}\n\n${DESK_LINE}`;
  const machine = "Triage: bug\nSeverity: low\nDuplicate of: TLSSN-38\nTriaged by: model (Jev was not above 0.52 on every answer)";
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [marked, machine, "Triage: question\nSeverity: low"] }), skip("question"));
});

test("planFromStatus gates on the first machine-written Triage: comment of a ticket filed before the desk marked its comment", async () => {
  const legacyDesk = `${deskVerdict}\nTriaged by: Jev (type, severity, and gate all above 0.52)`;
  const second = "Triage: question\nSeverity: low\nTriaged by: model (Jev was not above 0.52 on every answer)";
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [legacyDesk, second] }), expectedDesk);
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [legacyDesk, second, "Triage: question\nSeverity: low"] }), skip("question"), "a person's correction still governs");
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [second] }), skip("question", { from: "triage" }));
});

test("a desk verdict that gates is reported as the desk's", async () => {
  const deskQuestion = `Triage: question\nSeverity: low\n\n${DESK_LINE}`;
  assert.deepEqual(await planFromStatus(triaged, { ...opts, readComments: async () => [deskQuestion, "Triage: bug\nSeverity: high\nTriaged by: model (Jev was not above 0.52 on every answer)"] }), skip("question", { from: "desk" }));
});

test("the planner's own Plan stopped comment is not a comment the legacy comment route plans on", () => {
  const stopped = "Plan stopped: TLSSN-42\nThe planner did not start a planning run for this move to Triaged at 2026-09-27 00:09 UTC.\nWhy: The triage verdict (the latest Triage: comment) is a question, and the planner does not plan questions.";
  assert.deepEqual(decideComment(payload(stopped)), { plan: false, reason: "ignored" });
});

test("an empty project list plans any project on production and none on staging (a list emptied by refusing TLSSN)", () => {
  const staging = { FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN" };
  const projects = jiraProjects(staging);
  assert.deepEqual(projects, []);
  assert.deepEqual(decideStatusEvent(triaged, { ...opts, projects, env: staging }), { plan: false, reason: "project_not_allowed" });
  assert.equal(decideStatusEvent(triaged, { ...opts, projects: [], env: {} }).plan, true);
  assert.equal(decideStatusEvent(triaged, { ...opts, projects: jiraProjects({ FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_STAGING_ALLOW_PRODUCTION: "TLSSN" }), env: { FACTORY_ENV: "staging" } }).plan, true);
});

const withProjectKey = (body: { projectKey: string; issueKey?: string }) => ({ ...triaged, issue: { ...triaged.issue, key: body.issueKey ?? "TLSSN-42", fields: { ...triaged.issue.fields, project: { key: body.projectKey } } } });

test("production parity: a padded project.key is still not allowed on every production spelling of FACTORY_ENV", () => {
  for (const env of [{}, { FACTORY_ENV: "prod" }, { FACTORY_ENV: "production" }, { FACTORY_ENV: "PROD" }]) {
    assert.deepEqual(decideStatusEvent(withProjectKey({ projectKey: " TLSSN" }), { ...opts, env }), { plan: false, reason: "project_not_allowed" }, JSON.stringify(env));
  }
});

test("staging refuses a status body whose issue key is production even when project.key names the staging project", () => {
  const staging = { FACTORY_ENV: "staging" };
  assert.deepEqual(decideStatusEvent(withProjectKey({ projectKey: "TLSTG", issueKey: "TLSSN-47" }), { ...opts, projects: ["TLSTG"], env: staging }), { plan: false, reason: "project_not_allowed" });
  assert.equal(decideStatusEvent(withProjectKey({ projectKey: "TLSTG", issueKey: "TLSTG-1" }), { ...opts, projects: ["TLSTG"], env: staging }).plan, true);
  assert.equal(decideStatusEvent(withProjectKey({ projectKey: "TLSTG", issueKey: "TLSSN-47" }), { ...opts, projects: ["TLSTG"], env: {} }).plan, true, "production still trusts project.key, as on main");
});

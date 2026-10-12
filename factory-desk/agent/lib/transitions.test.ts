import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo } from "@cursor/july";
import approveTicket from "../tools/approve_ticket.js";
import denyTicket from "../tools/deny_ticket.js";
import requestPlan from "../tools/request_plan.js";
import { issueStatus, transitionFrom, transitionIssue } from "./jira.js";

const STATUS_ENV = ["FACTORY_STATUS_TODO", "FACTORY_STATUS_TRIAGED", "FACTORY_STATUS_PLANNED", "FACTORY_STATUS_APPROVED", "FACTORY_STATUS_IN_PROGRESS", "JIRA_CLOUD_ID"] as const;
const CLOUD = { cloudId: "https://example.atlassian.net" };
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const name of STATUS_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

after(() => {
  for (const name of STATUS_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

type Reply = HostMcpCallResult | ((args: Record<string, unknown>) => HostMcpCallResult);

function json(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function tool(name: string, properties: string[]): HostMcpToolInfo {
  return { name, inputSchema: { type: "object", properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])) } };
}

function tracker(tools: HostMcpToolInfo[], replies: Record<string, Reply>, options: { connected?: boolean; listThrows?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const mcp: HostMcpRegistry = {
    names: () => (options.connected === false ? [] : ["tracker"]),
    listTools: async () => {
      if (options.listThrows === true) throw new Error("connector down");
      return tools;
    },
    callTool: async (_connection, name, args = {}) => {
      calls.push({ tool: name, ...args });
      const reply = replies[name];
      if (reply === undefined) throw new Error(`unexpected call to ${name}`);
      return typeof reply === "function" ? reply(args) : reply;
    },
  };
  return { mcp, calls };
}

// Atlassian's hosted connector names.
const ROVO_TOOLS = [
  tool("getTransitionsForJiraIssue", ["cloudId", "issueIdOrKey"]),
  tool("transitionJiraIssue", ["cloudId", "issueIdOrKey", "transition"]),
  tool("getJiraIssue", ["cloudId", "issueIdOrKey"]),
  tool("addCommentToJiraIssue", ["cloudId", "issueIdOrKey", "comment"]),
  tool("createJiraIssue", ["projectKey", "summary", "description", "issueTypeName"]),
];

const WORKFLOW = {
  transitions: [
    { id: "11", name: "Start triage", to: { name: "Triaged" } },
    { id: "21", name: "Plan ready", to: { name: "Planned" } },
    { id: "31", name: "Approve", to: { name: "Approved" } },
    { id: "41", name: "Back to To Do", to: { name: "To Do" } },
  ],
};

function issue(status: string): HostMcpCallResult {
  return json({ key: "TLSSN-42", fields: { summary: "Retry", status: { name: status } } });
}

const THREAD = { channelId: "C0123ABCD", threadTs: "1758510000.123456" };
const ORIGINATOR = "U0ALICE01";

// By default the caller is the ticket's originator, in the ticket's thread.
function tools(purpose: string, mcp: HostMcpRegistry, kv: Record<string, unknown> = originatorKv()) {
  const auth = { authenticator: "slack", principalId: "slack:T:thread", principalType: "user", attributes: { channel_id: THREAD.channelId, thread_ts: THREAD.threadTs, user_id: ORIGINATOR } };
  const store = {
    get: async (key: string) => kv[key],
    put: async (key: string, value: unknown) => {
      kv[key] = value;
    },
    delete: async (key: string) => {
      delete kv[key];
    },
  };
  return { session: { id: "ses_1", channelId: "slack", mode: "chat", purpose, auth, continuationKey: null }, now: () => new Date("2026-09-23T00:00:00.000Z"), host: { mcp, kv: store } } as never;
}

function originatorKv(speaker: string = ORIGINATOR): Record<string, unknown> {
  const spoken = { userId: speaker, ts: `${Date.parse("2026-09-23T00:00:00.000Z") / 1000 - 30}.000100` };
  const thread = `${THREAD.channelId}:${THREAD.threadTs}`;
  return {
    "ticket/TLSSN-42": { ...THREAD, originatorUserId: ORIGINATOR },
    [`speaker/${thread}`]: spoken,
    ...Object.fromEntries(["approve", "deny", "plan", "replan"].map((verb) => [`command/${thread}/${verb}:TLSSN-42`, spoken])),
  };
}

test("transitionIssue picks the transition by target status and uses the schema's argument names", async () => {
  const t = tracker(ROVO_TOOLS, { getTransitionsForJiraIssue: json(WORKFLOW), transitionJiraIssue: json({ ok: true }) });
  assert.deepEqual(await transitionIssue(t.mcp, { issueKey: "TLSSN-42", toStatus: "approved" }), { status: "transitioned" });
  assert.deepEqual(t.calls, [
    { tool: "getTransitionsForJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "transitionJiraIssue", issueIdOrKey: "TLSSN-42", transition: { id: "31" }, ...CLOUD },
  ]);
});

test("transitionIssue matches a transition by its own name and passes a flat transition id", async () => {
  const t = tracker(
    [tool("get_transitions", ["issue_key"]), tool("transition_issue", ["issue_key", "transition_id"])],
    {
      get_transitions: { content: [], structuredContent: { data: { items: [{ id: 41, name: "Triaged" }, { id: 51, name: "Done" }] } } },
      transition_issue: json({}),
    }
  );
  assert.deepEqual(await transitionIssue(t.mcp, { issueKey: "TLSSN-42", toStatus: "Triaged" }), { status: "transitioned" });
  assert.deepEqual(t.calls, [
    { tool: "get_transitions", issue_key: "TLSSN-42" },
    { tool: "transition_issue", issue_key: "TLSSN-42", transition_id: "41" },
  ]);
});

test("transitionIssue is already when no transition matches and the issue is in the status", async () => {
  const t = tracker(ROVO_TOOLS, {
    getTransitionsForJiraIssue: json({ transitions: [{ id: "21", name: "Back to plan", to: { name: "Planned" } }] }),
    getJiraIssue: issue("Approved"),
  });
  assert.deepEqual(await transitionIssue(t.mcp, { issueKey: "TLSSN-42", toStatus: "Approved" }), { status: "already" });
  assert.deepEqual(t.calls, [
    { tool: "getTransitionsForJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "getJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
  ]);
});

test("transitionIssue is no_transition, with what is available, when the workflow has no path", async () => {
  const t = tracker(ROVO_TOOLS, {
    getTransitionsForJiraIssue: json({ transitions: [{ id: "21", name: "Back to plan", to: { name: "Planned" } }, { id: "61", name: "Close" }] }),
    getJiraIssue: issue("Triaged"),
  });
  assert.deepEqual(await transitionIssue(t.mcp, { issueKey: "TLSSN-42", toStatus: "Approved" }), {
    status: "no_transition",
    available: ["Planned", "Close"],
  });
});

test("transitionIssue is not_connected without the tracker connection or when it cannot list", async () => {
  assert.deepEqual(await transitionIssue(tracker(ROVO_TOOLS, {}, { connected: false }).mcp, { issueKey: "TLSSN-42", toStatus: "Approved" }), {
    status: "not_connected",
  });
  assert.deepEqual(await transitionIssue(tracker(ROVO_TOOLS, {}, { listThrows: true }).mcp, { issueKey: "TLSSN-42", toStatus: "Approved" }), {
    status: "not_connected",
  });
});

test("transitionIssue passes the status name when the connector cannot list transitions", async () => {
  const t = tracker([tool("transition_issue", ["issue_key", "status"])], { transition_issue: json({}) });
  assert.deepEqual(await transitionIssue(t.mcp, { issueKey: "TLSSN-42", toStatus: "Approved" }), { status: "transitioned" });
  assert.deepEqual(t.calls, [{ tool: "transition_issue", issue_key: "TLSSN-42", status: "Approved" }]);
});

test("transitionIssue fails on a connector error or a missing transition tool", async () => {
  const t = tracker(ROVO_TOOLS, {
    getTransitionsForJiraIssue: json(WORKFLOW),
    transitionJiraIssue: { content: [{ type: "text", text: "Transition 31 is not valid" }], isError: true },
  });
  assert.deepEqual(await transitionIssue(t.mcp, { issueKey: "TLSSN-42", toStatus: "Approved" }), {
    status: "failed",
    message: "Transition 31 is not valid",
  });
  assert.deepEqual(await transitionIssue(tracker([tool("getJiraIssue", ["issueIdOrKey"])], {}).mcp, { issueKey: "TLSSN-42", toStatus: "Approved" }), {
    status: "failed",
    message: "the tracker connector exposes no transition tool",
  });
});

test("approve_ticket moves a Planned ticket to Approved and does nothing else", async () => {
  const t = tracker(ROVO_TOOLS, { getJiraIssue: issue("Planned"), getTransitionsForJiraIssue: json(WORKFLOW), transitionJiraIssue: json({}) });
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp)), {
    approved: true,
    reason: "transitioned",
    issueKey: "TLSSN-42",
    transition: "transitioned",
    toStatus: "Approved",
  });
  // The guard's status read is the last call before the move.
  assert.deepEqual(
    t.calls.map((call) => call["tool"]),
    ["getJiraIssue", "getTransitionsForJiraIssue", "getJiraIssue", "transitionJiraIssue"]
  );
  assert.deepEqual(t.calls[3], { tool: "transitionJiraIssue", issueIdOrKey: "TLSSN-42", transition: { id: "31" }, ...CLOUD });
});

test("approve_ticket records the Slack approval so the Approved webhook stays quiet, and clears it when the move fails", async () => {
  const kv = originatorKv();
  const moved = tracker(ROVO_TOOLS, { getJiraIssue: issue("Planned"), getTransitionsForJiraIssue: json(WORKFLOW), transitionJiraIssue: json({}) });
  await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", moved.mcp, kv));
  assert.deepEqual(kv["approved-in-slack/TLSSN-42"], { at: "2026-09-23T00:00:00.000Z", by: ORIGINATOR });

  const failed = originatorKv();
  const refused = tracker(ROVO_TOOLS, { getJiraIssue: issue("Planned"), getTransitionsForJiraIssue: json({ transitions: [] }) });
  await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", refused.mcp, failed));
  assert.equal(failed["approved-in-slack/TLSSN-42"], undefined);

  // Read as Planned, then Approved by an approval in flight: Jira offers no move and the status reads Approved.
  const raced = originatorKv();
  let reads = 0;
  const meanwhile = tracker(ROVO_TOOLS, { getJiraIssue: () => issue((reads += 1) === 1 ? "Planned" : "Approved"), getTransitionsForJiraIssue: json({ transitions: [] }) });
  const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", meanwhile.mcp, raced))) as Record<string, unknown>;
  assert.deepEqual([result["approved"], result["reason"]], [true, "already_approved"]);
  assert.deepEqual(raced["approved-in-slack/TLSSN-42"], { at: "2026-09-23T00:00:00.000Z", by: ORIGINATOR });
});

test("approve_ticket reads FACTORY_STATUS_APPROVED, reports already, and in evals touches nothing but answers like a live move", async () => {
  process.env.FACTORY_STATUS_APPROVED = "Go";
  try {
    const t = tracker(ROVO_TOOLS, {
      getJiraIssue: issue("Planned"),
      getTransitionsForJiraIssue: json({ transitions: [{ id: "71", name: "Ship it", to: { name: "Go" } }] }),
      transitionJiraIssue: json({}),
    });
    const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp))) as Record<string, unknown>;
    assert.equal(result["toStatus"], "Go");
    assert.deepEqual(t.calls.at(-1), { tool: "transitionJiraIssue", issueIdOrKey: "TLSSN-42", transition: { id: "71" }, ...CLOUD });
  } finally {
    delete process.env.FACTORY_STATUS_APPROVED;
  }

  const again = tracker(ROVO_TOOLS, { getTransitionsForJiraIssue: json({ transitions: [] }), getJiraIssue: issue("Approved") });
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", again.mcp)), {
    approved: true,
    reason: "already_approved",
    issueKey: "TLSSN-42",
    transition: "already",
    toStatus: "Approved",
  });

  const inEval = tracker(ROVO_TOOLS, {});
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("eval", inEval.mcp)), {
    ok: true,
    approved: true,
    reason: "transitioned",
    issueKey: "TLSSN-42",
    transition: "transitioned",
    toStatus: "Approved",
    eval: true,
    message: "Approved TLSSN-42 (eval mode: Jira write simulated).",
  });
  assert.deepEqual(inEval.calls, []);
});

test("approve_ticket and request_plan move nothing when the ticket's status cannot be read", async () => {
  const unread = { content: [{ type: "text", text: "issue lookup failed" }], isError: true } as HostMcpCallResult;
  const approve = tracker(ROVO_TOOLS, { getJiraIssue: unread });
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", approve.mcp)), {
    approved: false,
    reason: "status_unknown",
    issueKey: "TLSSN-42",
    transition: "skipped",
    toStatus: "Approved",
    detail: "issue lookup failed",
  });
  const replan = tracker(ROVO_TOOLS, { getJiraIssue: unread });
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42", replan: true } as never, tools("live", replan.mcp)), {
    requested: false,
    reason: "status_unknown",
    issueKey: "TLSSN-42",
    replan: true,
    toStatus: "Triaged",
    detail: "issue lookup failed",
  });
  assert.deepEqual([...approve.calls, ...replan.calls].map((call) => call["tool"]), ["getJiraIssue", "getJiraIssue"]);
  assert.deepEqual(await issueStatus(approve.mcp, "TLSSN-42"), { status: "unread", detail: "issue lookup failed" });
});

test("issueStatus reads fields.status.name, wrappers, and top-level status.name", async () => {
  const shapes = [
    { fields: { status: { name: "Planned" } } },
    { status: { name: "Planned" } },
    { issue: { fields: { status: { name: "Planned" } } } },
    { data: { status: { name: "Planned" } } },
    { issues: [{ fields: { status: { name: "Planned" } } }] },
    { result: { fields: { status: "Planned" } } },
  ];
  for (const shape of shapes) {
    const t = tracker(ROVO_TOOLS, { getJiraIssue: json(shape) });
    assert.deepEqual(await issueStatus(t.mcp, "TLSSN-42"), { status: "read", name: "Planned" }, JSON.stringify(shape));
  }
  const wrapped = tracker(ROVO_TOOLS, { getJiraIssue: issue("Planned"), getTransitionsForJiraIssue: json(WORKFLOW), transitionJiraIssue: json({}) });
  assert.equal(((await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", wrapped.mcp))) as { approved: boolean }).approved, true);
});

// Rovo's getJiraIssue as the Cursor backend relays it: the REST v3 issue as
// the text block and, because Cursor is a client Rovo recognises, the
// `issues.nodes` envelope as structuredContent (atlassian/atlassian-mcp-server
// #213, #118). Both channels reach host.mcp; the text is the same either way.
function rovoIssue(status: string, options: { text?: string } = {}): HostMcpCallResult {
  const rest = {
    id: "10442",
    key: "TLSSN-42",
    self: "https://api.atlassian.com/ex/jira/564eb250-21c1-45d7-81f9-527d6bf705ad/rest/api/3/issue/10442",
    fields: { summary: "Retry", status: { name: status, id: "10003", statusCategory: { key: "new" } }, issuetype: { name: "Bug" }, project: { key: "TLSSN" } },
  };
  return {
    content: [{ type: "text", text: options.text ?? JSON.stringify(rest) }],
    structuredContent: { issues: { nodes: [{ ...rest, webUrl: "https://example.atlassian.net/browse/TLSSN-42" }] } },
  };
}

// Hosted v2 lists the Factory Atlassian tools as "<serverIdentifier>-<tool>".
const HOSTED = "team-Factory_Atlassian-";
const HOSTED_TOOLS = ROVO_TOOLS.map((candidate) => ({ ...candidate, name: HOSTED + candidate.name }));

test("approve_ticket reads Planned from Rovo's reply when structuredContent is the issues.nodes envelope", async () => {
  const t = tracker(HOSTED_TOOLS, {
    [`${HOSTED}getJiraIssue`]: rovoIssue("Planned"),
    [`${HOSTED}getTransitionsForJiraIssue`]: json(WORKFLOW),
    [`${HOSTED}transitionJiraIssue`]: json({}),
  });
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp)), {
    approved: true,
    reason: "transitioned",
    issueKey: "TLSSN-42",
    transition: "transitioned",
    toStatus: "Approved",
  });
  assert.deepEqual(t.calls.at(-1), { tool: `${HOSTED}transitionJiraIssue`, issueIdOrKey: "TLSSN-42", transition: { id: "31" }, ...CLOUD });
});

test("issueStatus reads the status from structuredContent's issues.nodes when the text is not JSON", async () => {
  const t = tracker(ROVO_TOOLS, { getJiraIssue: rovoIssue("Planned", { text: "TLSSN-42 Retry is Planned." }) });
  assert.deepEqual(await issueStatus(t.mcp, "TLSSN-42"), { status: "read", name: "Planned" });
});

test("transitionIssue finds the transition list in whichever reply channel carries it", async () => {
  const replies: HostMcpCallResult[] = [
    { content: [{ type: "text", text: JSON.stringify(WORKFLOW) }], structuredContent: { issue: { key: "TLSSN-42", webUrl: "https://example.atlassian.net/browse/TLSSN-42" } } },
    { content: [{ type: "text", text: "3 transitions" }], structuredContent: { transitions: { nodes: WORKFLOW.transitions } } },
  ];
  for (const listed of replies) {
    const t = tracker(ROVO_TOOLS, { getJiraIssue: rovoIssue("Planned"), getTransitionsForJiraIssue: listed, transitionJiraIssue: json({}) });
    assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp)), {
      approved: true,
      reason: "transitioned",
      issueKey: "TLSSN-42",
      transition: "transitioned",
      toStatus: "Approved",
    }, JSON.stringify(listed.structuredContent));
    assert.deepEqual(transitionIds(t.calls), [{ id: "31" }]);
  }
});

test("a get-issue reply with no status anywhere is status_unknown, and the detail says which channels came back", async () => {
  const t = tracker(ROVO_TOOLS, {
    getJiraIssue: { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields: { summary: "Retry" } }) }], structuredContent: { issues: { nodes: [] } } },
  });
  const result = (await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp))) as Record<string, unknown>;
  assert.equal(result["reason"], "status_unknown");
  assert.equal(result["detail"], 'getJiraIssue replied without a status. structuredContent keys: issues. text: {"key":"TLSSN-42","fields":{"summary":"Retry"}}');
  assert.deepEqual(t.calls.map((call) => call["tool"]), ["getJiraIssue"]);
});

test("issueStatus is unread when getJiraIssue omits status, and approve_ticket stays status_unknown", async () => {
  const t = tracker(ROVO_TOOLS, { getJiraIssue: json({ key: "TLSSN-42", fields: { summary: "Retry" } }) });
  const detail = `getJiraIssue replied without a status. no structuredContent. text: ${JSON.stringify({ key: "TLSSN-42", fields: { summary: "Retry" } })}`;
  assert.deepEqual(await issueStatus(t.mcp, "TLSSN-42"), { status: "unread", detail });
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp)), {
    approved: false,
    reason: "status_unknown",
    issueKey: "TLSSN-42",
    transition: "skipped",
    toStatus: "Approved",
    detail,
  });
  assert.deepEqual(t.calls.map((call) => call["tool"]), ["getJiraIssue", "getJiraIssue"]);
});

test("the status read asks getJiraIssue for the status field only", async () => {
  const getIssue: HostMcpToolInfo = {
    name: "getJiraIssue",
    inputSchema: {
      type: "object",
      properties: {
        cloudId: { type: "string" },
        issueIdOrKey: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
      },
    },
  };
  const t = tracker([...ROVO_TOOLS.filter((candidate) => candidate.name !== "getJiraIssue"), getIssue], { getJiraIssue: issue("Planned") });
  assert.deepEqual(await issueStatus(t.mcp, "TLSSN-42"), { status: "read", name: "Planned" });
  assert.deepEqual(t.calls, [{ tool: "getJiraIssue", issueIdOrKey: "TLSSN-42", fields: ["status"], ...CLOUD }]);

  const commaList = tracker([tool("getJiraIssue", ["cloudId", "issueIdOrKey", "fields"])], { getJiraIssue: issue("Planned") });
  await issueStatus(commaList.mcp, "TLSSN-42");
  assert.equal(commaList.calls[0]?.["fields"], "status");
});

test("deny_ticket comments nothing while an approval holds the ticket's decision, and releases its own hold after a denial", async () => {
  const held = { ...originatorKv(), "approve-ticket/TLSSN-42": { state: "pending", owner: "approver", at: "2026-09-22T23:59:50.000Z" } };
  const busy = tracker(ROVO_TOOLS, { getJiraIssue: withComments([PLAN]), addCommentToJiraIssue: json({ id: "902" }) });
  assert.deepEqual(await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice Ng" } as never, tools("live", busy.mcp, held)), {
    denied: false,
    reason: "decision_in_flight",
    issueKey: "TLSSN-42",
  });
  assert.deepEqual(busy.calls, []);

  const kv = originatorKv();
  const free = tracker(ROVO_TOOLS, { getJiraIssue: withComments([PLAN]), addCommentToJiraIssue: json({ id: "903" }) });
  assert.equal(((await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice Ng" } as never, tools("live", free.mcp, kv))) as Record<string, unknown>)["denied"], true);
  assert.equal(kv["approve-ticket/TLSSN-42"], undefined, "a denied plan can still be approved");
});

test("deny_ticket comments who denied and never transitions", async () => {
  const t = tracker(ROVO_TOOLS, { getJiraIssue: withComments([PLAN]), addCommentToJiraIssue: json({ id: "900" }) });
  assert.deepEqual(await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice Ng" } as never, tools("live", t.mcp)), {
    denied: true,
    reason: "commented",
    issueKey: "TLSSN-42",
    reply: "TLSSN-42: plan declined, so nothing is built. To change it, add a comment on TLSSN-42 and say `@factory replan TLSSN-42`.",
  });
  assert.deepEqual(writes(t.calls), [{ tool: "addCommentToJiraIssue", issueIdOrKey: "TLSSN-42", comment: "Denied in Slack by Alice Ng", ...CLOUD }]);

  const unnamed = tracker(ROVO_TOOLS, { getJiraIssue: withComments([PLAN]), addCommentToJiraIssue: json({ id: "901" }) });
  await denyTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", unnamed.mcp));
  assert.deepEqual(writes(unnamed.calls), [{ tool: "addCommentToJiraIssue", issueIdOrKey: "TLSSN-42", comment: "Denied in Slack by a person in the Slack thread", ...CLOUD }]);

  const denyEval = tracker(ROVO_TOOLS, {});
  assert.deepEqual(await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice" } as never, tools("eval", denyEval.mcp)), {
    ok: true,
    denied: true,
    reason: "commented",
    issueKey: "TLSSN-42",
    eval: true,
    reply: "TLSSN-42: plan declined, so nothing is built. To change it, add a comment on TLSSN-42 and say `@factory replan TLSSN-42`.",
    message: "Denied TLSSN-42 (eval mode: Jira write simulated).",
  });
  assert.deepEqual(denyEval.calls, [], "an eval writes nothing to Jira");
});

const PLAN = { id: "10", body: "Plan: TLSSN-42\nSummary: add a retry" };
const DENIED = { id: "11", body: "Denied in Slack by Alice Ng" };
const withComments = (comments: Array<{ id: string; body: string }>) => json({ key: "TLSSN-42", fields: { summary: "Retry", status: { name: "Planned" }, comment: { comments } } });
const writes = (calls: Record<string, unknown>[]) => calls.filter((call) => call.tool === "addCommentToJiraIssue");

// One denial per plan: Jira's comments are the record (a ❌ or an earlier
// deny whose claim expired left one), and a replan opens the next plan.
test("deny_ticket after the plan was already declined writes no second Denied comment and says so once", async () => {
  const t = tracker(ROVO_TOOLS, { getJiraIssue: withComments([PLAN, DENIED]), addCommentToJiraIssue: json({ id: "904" }) });
  assert.deepEqual(await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice Ng" } as never, tools("live", t.mcp)), {
    denied: false,
    reason: "already_declined",
    issueKey: "TLSSN-42",
    message: "The plan for TLSSN-42 is already declined; nothing changed.",
  });
  assert.deepEqual(writes(t.calls), []);
});

test("deny_ticket on a fresh plan after a declined one writes a new Denied comment", async () => {
  const t = tracker(ROVO_TOOLS, { getJiraIssue: withComments([PLAN, DENIED, { id: "12", body: "Plan: TLSSN-42\nSummary: retry with backoff" }]), addCommentToJiraIssue: json({ id: "905" }) });
  assert.equal(((await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice Ng" } as never, tools("live", t.mcp))) as Record<string, unknown>)["denied"], true);
  assert.equal(writes(t.calls).length, 1);
});

test("deny_ticket orders comments by numeric Jira id, not as listed or as strings", async () => {
  // The denial (9) predates the replan (10); list order and string order both put it last.
  const listed = [{ id: "8", body: "Plan: TLSSN-42\nSummary: add a retry" }, { id: "10", body: "Plan: TLSSN-42\nSummary: retry with backoff" }, { id: "9", body: "Denied in Slack by Alice Ng" }];
  const t = tracker(ROVO_TOOLS, { getJiraIssue: withComments(listed), addCommentToJiraIssue: json({ id: "907" }) });
  assert.equal(((await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice Ng" } as never, tools("live", t.mcp))) as Record<string, unknown>)["denied"], true);
  assert.equal(writes(t.calls).length, 1);
});

test("deny_ticket writes nothing when Jira cannot be read: the status check comes first", async () => {
  const t = tracker(ROVO_TOOLS, { getJiraIssue: { content: [{ type: "text", text: "Jira is down" }], isError: true }, addCommentToJiraIssue: json({ id: "906" }) });
  const kv = originatorKv();
  assert.deepEqual(await denyTicket.execute!({ issueKey: "TLSSN-42", by: "Alice Ng" } as never, tools("live", t.mcp, kv)), {
    denied: false,
    reason: "status_unknown",
    issueKey: "TLSSN-42",
    message: "I could not read TLSSN-42 in Jira, so nothing changed.",
  });
  assert.deepEqual(writes(t.calls), []);
  assert.equal(kv["approve-ticket/TLSSN-42"], undefined, "the decision hold is released");
});

// A stand-in Jira workflow: getJiraIssue reports the status, and a transition
// moves it. Every transition is offered from every status, as a global one is.
// `meanwhile` is someone else's move landing after the ticket's first `reads` status reads.
function workflow(status: string, options: { failTo?: string; comments?: Array<{ id: string; body: string }>; meanwhile?: { reads: number; status: string } } = {}) {
  let current = status;
  let reads = 0;
  const comments = options.comments;
  return tracker(ROVO_TOOLS, {
    getJiraIssue: () => {
      const reply = comments === undefined ? issue(current) : json({ key: "TLSSN-42", fields: { summary: "Retry", status: { name: current }, comment: { comments } } });
      if ((reads += 1) === options.meanwhile?.reads) current = options.meanwhile.status;
      return reply;
    },
    getTransitionsForJiraIssue: json(WORKFLOW),
    transitionJiraIssue: (args) => {
      const id = (args["transition"] as { id?: string } | undefined)?.id;
      const chosen = WORKFLOW.transitions.find((transition) => transition.id === id);
      if (chosen === undefined || chosen.to.name === options.failTo) {
        return { content: [{ type: "text", text: `Transition ${String(id)} is not valid` }], isError: true };
      }
      current = chosen.to.name;
      return json({});
    },
  });
}

function transitionIds(calls: Record<string, unknown>[]): unknown[] {
  return calls.filter((call) => call["tool"] === "transitionJiraIssue").map((call) => call["transition"]);
}

test("transitionFrom reads the status after the transitions list, as its last call before the move", async () => {
  const t = workflow("Planned");
  assert.deepEqual(await transitionFrom(t.mcp, { issueKey: "TLSSN-42", from: "planned", toStatus: "Approved" }), { status: "transitioned" });
  assert.deepEqual(t.calls, [
    { tool: "getTransitionsForJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "getJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "transitionJiraIssue", issueIdOrKey: "TLSSN-42", transition: { id: "31" }, ...CLOUD },
  ]);
});

test("transitionFrom moves nothing from another status, answers already in the target, and never guesses an unread status", async () => {
  const triaged = workflow("Triaged");
  assert.deepEqual(await transitionFrom(triaged.mcp, { issueKey: "TLSSN-42", from: "Planned", toStatus: "Approved" }), { status: "skipped_status", current: "Triaged" });
  assert.deepEqual(transitionIds(triaged.calls), []);

  const approved = workflow("Approved");
  assert.deepEqual(await transitionFrom(approved.mcp, { issueKey: "TLSSN-42", from: "Planned", toStatus: "Approved" }), { status: "already" });
  assert.deepEqual(transitionIds(approved.calls), []);

  const unread = tracker(ROVO_TOOLS, { getTransitionsForJiraIssue: json(WORKFLOW), getJiraIssue: { content: [{ type: "text", text: "issue lookup failed" }], isError: true } });
  assert.deepEqual(await transitionFrom(unread.mcp, { issueKey: "TLSSN-42", from: "Planned", toStatus: "Approved" }), { status: "skipped_status", detail: "issue lookup failed" });
  assert.deepEqual(transitionIds(unread.calls), []);

  const byName = tracker([tool("getJiraIssue", ["issueIdOrKey"]), tool("transition_issue", ["issue_key", "status"])], { getJiraIssue: issue("Triaged") });
  assert.deepEqual(await transitionFrom(byName.mcp, { issueKey: "TLSSN-42", from: "Planned", toStatus: "Approved" }), { status: "skipped_status", current: "Triaged" });
  assert.deepEqual(byName.calls.map((call) => call["tool"]), ["getJiraIssue"]);

  assert.deepEqual(await transitionFrom(tracker(ROVO_TOOLS, {}, { connected: false }).mcp, { issueKey: "TLSSN-42", from: "Planned", toStatus: "Approved" }), { status: "not_connected" });
});

// Round-2 finding 5: approve read Planned, then moved with no guard, so a
// replan (Planned → Triaged) landing in between went Triaged → Approved and
// the worker launched the old brief.
test("a replan that lands between approve_ticket's read and its move leaves the ticket in Triaged and clears the Slack approval", async () => {
  const kv = originatorKv();
  const t = workflow("Planned", { meanwhile: { reads: 1, status: "Triaged" } });
  assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp, kv)), {
    approved: false,
    reason: "moved_on",
    issueKey: "TLSSN-42",
    transition: "skipped",
    toStatus: "Approved",
    current: "Triaged",
  });
  assert.deepEqual(transitionIds(t.calls), []);
  assert.equal(kv["approved-in-slack/TLSSN-42"], undefined);
});

test("an approve that lands between request_plan's read and its move is not pulled back to Triaged", async () => {
  const t = workflow("Planned", { meanwhile: { reads: 1, status: "Approved" } });
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42", replan: true } as never, tools("live", t.mcp)), {
    requested: false,
    reason: "moved_on",
    issueKey: "TLSSN-42",
    replan: true,
    toStatus: "Triaged",
    current: "Approved",
  });
  assert.deepEqual(transitionIds(t.calls), []);

  // The bounce of a ticket already in Triaged is guarded at each step too.
  const bounced = workflow("Triaged", { meanwhile: { reads: 1, status: "Approved" } });
  const result = (await requestPlan.execute!({ issueKey: "TLSSN-42", replan: true } as never, tools("live", bounced.mcp))) as Record<string, unknown>;
  assert.deepEqual([result["requested"], result["reason"], result["toStatus"], result["current"]], [false, "moved_on", "To Do", "Approved"]);
  assert.deepEqual(transitionIds(bounced.calls), []);
});

test("request_plan from To Do moves the ticket to Triaged with one transition", async () => {
  const t = workflow("To Do");
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp)), {
    requested: true,
    reason: "transitioned",
    issueKey: "TLSSN-42",
    replan: false,
    toStatus: "Triaged",
  });
  assert.deepEqual(transitionIds(t.calls), [{ id: "11" }]);
});

test("request_plan from Planned is a replan with one transition to Triaged", async () => {
  const t = workflow("Planned");
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42", replan: true } as never, tools("live", t.mcp)), {
    requested: true,
    reason: "transitioned",
    issueKey: "TLSSN-42",
    replan: true,
    toStatus: "Triaged",
  });
  assert.deepEqual(transitionIds(t.calls), [{ id: "11" }]);
});

test("request_plan on a ticket already in Triaged bounces it to To Do and back to Triaged", async () => {
  const t = workflow("Triaged");
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42", replan: true } as never, tools("live", t.mcp)), {
    requested: true,
    reason: "bounced",
    issueKey: "TLSSN-42",
    replan: true,
    toStatus: "Triaged",
  });
  // Status, then comments (the triage gate), then each move with its guard read just before it.
  assert.deepEqual(t.calls, [
    { tool: "getJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "getJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "getTransitionsForJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "getJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "transitionJiraIssue", issueIdOrKey: "TLSSN-42", transition: { id: "41" }, ...CLOUD },
    { tool: "getTransitionsForJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "getJiraIssue", issueIdOrKey: "TLSSN-42", ...CLOUD },
    { tool: "transitionJiraIssue", issueIdOrKey: "TLSSN-42", transition: { id: "11" }, ...CLOUD },
  ]);
});

test("a plan KEY that sends the ticket to the planner stops its thread awaiting a reply; one that moves nothing keeps it", async () => {
  const awaiting = `awaiting-info/${THREAD.channelId}:${THREAD.threadTs}`;
  const kv = { ...originatorKv(), [awaiting]: { issueKey: "TLSSN-42", kind: "needs_info", at: "" } };
  await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("live", workflow("Triaged").mcp, kv));
  assert.equal(kv[awaiting], undefined);

  const kept = { ...originatorKv(), [awaiting]: { issueKey: "TLSSN-42", kind: "needs_info", at: "" } };
  await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("live", workflow("Approved").mcp, kept));
  assert.deepEqual(kept[awaiting], { issueKey: "TLSSN-42", kind: "needs_info", at: "" });
});

test("a needs-info verdict answered by a Detail from Slack: comment no longer holds plan KEY back", async () => {
  const t = workflow("Triaged", {
    comments: [{ id: "1", body: "Triage: bug\nNeeds info: which export?" }, { id: "2", body: "Detail from Slack: TLSSN-42\nbob replied…\n\nThe CSV one." }],
  });
  const result = (await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp))) as Record<string, unknown>;
  assert.deepEqual([result["requested"], result["reason"]], [true, "bounced"]);
});

// A ticket whose latest Triage: comment is one the planner's status gate skips.
function triagedWith(status: string, triage: string) {
  return workflow(status, { comments: [{ id: "1", body: "Looks like the filter." }, { id: "2", body: triage }] });
}

test("request_plan moves nothing when the latest triage verdict is one the planner skips", async () => {
  const cases = [
    { triage: "Triage: bug\nSeverity: low\nSummary: CSV export 500.\nNext step: Name the export URL.\nNeeds info: Name the export URL.", gated: { gate: "needs_info", nextStep: "Name the export URL." } },
    { triage: "Triage: question\nSeverity: low\nSummary: How do exports work?\nNext step: Answer in the thread.", gated: { gate: "question", nextStep: "Answer in the thread." } },
    { triage: "Triage: bug\nSeverity: medium\nSummary: Same as TLSSN-19.\nNext step: Close it.\nDuplicate of: TLSSN-19", gated: { gate: "duplicate", duplicateOf: "TLSSN-19", nextStep: "Close it." } },
  ];
  for (const { triage, gated } of cases) {
    for (const status of ["Triaged", "To Do"]) {
      const t = triagedWith(status, triage);
      assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp)), {
        requested: false,
        reason: "triage_gate",
        issueKey: "TLSSN-42",
        replan: false,
        toStatus: "Triaged",
        ...gated,
        current: status,
      }, `${gated.gate} from ${status}`);
      assert.deepEqual(transitionIds(t.calls), [], `${gated.gate} from ${status}`);
    }
  }
});

test("request_plan still bounces a ticket whose latest triage verdict the planner plans", async () => {
  const t = triagedWith("Triaged", "Triage: bug\nSeverity: high\nSummary: CSV export 500.\nNext step: Fix the empty filter.");
  const result = (await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp))) as Record<string, unknown>;
  assert.equal(result["reason"], "bounced");
  assert.deepEqual(transitionIds(t.calls), [{ id: "41" }, { id: "11" }]);
});

test("request_plan reports a failed bounce to To Do and does not move the ticket back", async () => {
  const t = workflow("Triaged", { failTo: "To Do" });
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("live", t.mcp)), {
    requested: false,
    reason: "failed",
    issueKey: "TLSSN-42",
    replan: false,
    toStatus: "To Do",
    message: "Transition 41 is not valid",
  });
  assert.deepEqual(transitionIds(t.calls), [{ id: "41" }]);
  assert.equal(t.calls.some((call) => call["tool"] === "addCommentToJiraIssue"), false);
});

test("request_plan names the status each failed step was headed for", async () => {
  const first = workflow("To Do", { failTo: "Triaged" });
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42", replan: true } as never, tools("live", first.mcp)), {
    requested: false,
    reason: "failed",
    issueKey: "TLSSN-42",
    replan: true,
    toStatus: "Triaged",
    message: "Transition 11 is not valid",
  });
  assert.deepEqual(transitionIds(first.calls), [{ id: "11" }]);

  const forward = workflow("Triaged", { failTo: "Triaged" });
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("live", forward.mcp)), {
    requested: false,
    reason: "failed",
    issueKey: "TLSSN-42",
    replan: false,
    toStatus: "Triaged",
    message: "Transition 11 is not valid",
    current: "To Do",
  });
  assert.deepEqual(transitionIds(forward.calls), [{ id: "41" }, { id: "11" }]);
});

test("request_plan in an eval touches nothing and answers like a live move, so the reply takes the transitioned branch", async () => {
  const inEval = tracker(ROVO_TOOLS, {});
  assert.deepEqual(await requestPlan.execute!({ issueKey: "TLSSN-42" } as never, tools("eval", inEval.mcp)), {
    ok: true,
    requested: true,
    reason: "transitioned",
    issueKey: "TLSSN-42",
    replan: false,
    toStatus: "Triaged",
    eval: true,
    message: "Moved TLSSN-42 to Triaged (eval mode: Jira write simulated).",
  });
  assert.deepEqual(inEval.calls, []);
});

// Deep-imports July internals (dist/internal/tool-call-retry.js); recheck these tests on every July bump.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { retryReadOnlyToolCall, setToolRetrySleepForTests } from "../../node_modules/@cursor/july/dist/internal/tool-call-retry.js";
import getPlan from "../tools/get_plan.js";
import planIssue from "../tools/plan_issue.js";
import recordNeedsInfo from "../tools/record_needs_info.js";
import recordPlan from "../tools/record_plan.js";
import searchSandbox from "../tools/search_sandbox.js";
import { pinnedIssueKey } from "./chain.js";
import { digestProblem, fallbackTitle, jiraComment, planSchema } from "./plan.js";
import { needsInfoComment } from "./needs-info.js";
import { SEARCH_BUDGET, searchBudgetKey } from "./search-budget.js";

const savedScope = {
  repos: process.env.FACTORY_REPOS,
  sandbox: process.env.FACTORY_SANDBOX_REPO,
  projects: process.env.FACTORY_PLANNER_JIRA_PROJECTS,
  shared: process.env.FACTORY_JIRA_PROJECTS,
};

const workspace = mkdtempSync(join(tmpdir(), "planner-sandbox-"));
mkdirSync(join(workspace, "src", "export"), { recursive: true });
writeFileSync(join(workspace, "src", "export", "csv.ts"), "export function runExport() { if (empty) throw new Error('500'); }\n");
writeFileSync(join(workspace, "src", "export", "csv.test.ts"), "test('empty filter', () => {});\n");

before(() => {
  delete process.env.FACTORY_REPOS;
  delete process.env.FACTORY_JIRA_PROJECTS;
  process.env.FACTORY_SANDBOX_REPO = "example-org/demo-repo";
  process.env.FACTORY_PLANNER_JIRA_PROJECTS = "TLSSN";
});

after(() => {
  if (savedScope.repos === undefined) delete process.env.FACTORY_REPOS;
  else process.env.FACTORY_REPOS = savedScope.repos;
  if (savedScope.sandbox === undefined) delete process.env.FACTORY_SANDBOX_REPO;
  else process.env.FACTORY_SANDBOX_REPO = savedScope.sandbox;
  if (savedScope.projects === undefined) delete process.env.FACTORY_PLANNER_JIRA_PROJECTS;
  else process.env.FACTORY_PLANNER_JIRA_PROJECTS = savedScope.projects;
  if (savedScope.shared === undefined) delete process.env.FACTORY_JIRA_PROJECTS;
  else process.env.FACTORY_JIRA_PROJECTS = savedScope.shared;
});

// The tool definitions are plain objects; call execute with a stub context
// so the chain, the pin, and the read-back are proven without a signed-in host.

type Sent = { channelId: string; message: string; options: Record<string, unknown> | undefined };

type TrackerCall = { tool: string; args: Record<string, unknown> | undefined };

const trackerTools = [
  { name: "getJiraIssueComments", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } },
  { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, body: { type: "string" } } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
];

const getIssueTool = { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } };

type DeskCall = { tool: string; args: Record<string, unknown> | undefined };

/** `tracker.status` adds a getJiraIssue tool that reports that status. Each tag is one second after the last. */
function ctx(overrides: { purpose?: string; sessionId?: string; kv?: Map<string, unknown>; continuationKey?: string | null; records?: Record<string, unknown>[]; deskReply?: unknown; tracker?: { comments: string[]; status?: string; description?: unknown }; workspaceDir?: string; github?: { getOctokit(): Promise<{ request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }> }> } } = {}) {
  const sent: Sent[] = [];
  const tagged: Record<string, unknown>[] = [];
  const trackerCalls: TrackerCall[] = [];
  const deskCalls: DeskCall[] = [];
  const records = overrides.records ?? [];
  const desk = overrides.deskReply;
  const tracker = overrides.tracker;
  const store = overrides.kv ?? new Map<string, unknown>();
  const context = {
    session: { id: overrides.sessionId ?? "ses_1", channelId: "plan", mode: "chat", purpose: overrides.purpose ?? "live", auth: null, continuationKey: overrides.continuationKey ?? null },
    workspaceDir: overrides.workspaceDir ?? workspace,
    host: {
      kv: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => void store.set(key, value),
        delete: async (key: string) => void store.delete(key),
      },
      ...(overrides.github === undefined ? {} : { github: overrides.github }),
      mcp: {
        names: () => [...(desk === undefined ? [] : ["desk"]), ...(tracker === undefined ? [] : ["tracker"])],
        listTools: async (connection: string) =>
          connection === "tracker" && tracker !== undefined ? (tracker.status === undefined ? trackerTools : [getIssueTool, ...trackerTools]) : [],
        callTool: async (connection: string, tool: string, args?: Record<string, unknown>) => {
          if (connection === "tracker") {
            trackerCalls.push({ tool, args });
            if (tool === "getJiraIssue") return { content: [{ type: "text", text: JSON.stringify({ key: "TLSSN-42", fields: { status: { name: tracker?.status }, ...(tracker?.description === undefined ? {} : { description: tracker.description }) } }) }] };
            if (tool === "getJiraIssueComments") return { content: [{ type: "text", text: JSON.stringify({ comments: (tracker?.comments ?? []).map((body) => ({ body })) }) }] };
            if (tool === "getTransitionsForJiraIssue") return { content: [{ type: "text", text: JSON.stringify({ transitions: [{ id: "21", name: "Plan", to: { name: "Planned" } }] }) }] };
            return { content: [{ type: "text", text: "{}" }] };
          }
          deskCalls.push({ tool, args });
          return desk === undefined ? { content: [] } : { content: [{ type: "text", text: JSON.stringify(desk) }], structuredContent: desk };
        },
      },
    },
    send: async (channelId: string, message: string, options?: Record<string, unknown>) => {
      sent.push({ channelId, message, options });
      return { id: "ses_plan_1", continuationToken: "issue:TLSSN-42", isNew: true };
    },
    artifacts: {
      tag: async (input: Record<string, unknown>) => {
        tagged.push(input);
        const at = new Date(Date.UTC(2026, 8, 22, 0, 0, tagged.length - 1)).toISOString();
        return { id: "art_1", kind: "plan", data: input["data"], createdAt: at, updatedAt: at, source: "host" };
      },
      list: async () => records,
    },
    now: () => "2026-09-22T00:00:00.000Z",
  };
  return { context, sent, tagged, trackerCalls, deskCalls, store };
}

function transitions(calls: TrackerCall[]): TrackerCall[] {
  return calls.filter((call) => call.tool === "transitionJiraIssue");
}

// The framework validates through planSchema before execute, which fills the list defaults; do the same here.
const plan = planSchema.parse({
  issueKey: "TLSSN-42",
  title: "Retry CSV export on empty filter",
  evidence: "checkout",
  problem: "An export whose filter matches no rows returns a 500.",
  summary: "Empty-filter CSV exports fail with a 500.",
  approach: "Return an empty CSV for an empty filter.",
  areas: ["src/export/csv.ts"],
  risk: { level: "low", reason: "One code path." },
  size: { estimate: "small", reason: "One function and a test." },
  howItWorks: {
    overview: "The export job streams rows to storage.",
    flow: ["runExport loads the filter", "buildRows throws on empty"],
    whereThingsLive: ["src/export/csv.ts", "src/export/csv.test.ts"],
  },
  why: { findings: ["[Direct] runExport throws on empty in src/export/csv.ts."], sourcesConsulted: ["src/export/csv.ts", "ticket TLSSN-42"] },
  design: {
    usage: "runExport(filter) resolves to { rows: 0, file } for an empty filter.",
    shape: "RowSource gains an explicit empty outcome.",
    candidates: [
      { name: "Explicit empty outcome", shape: "Typed empty result", verdict: "base", reason: "Deepest interface" },
      { name: "Catch and retry", shape: "Retry loop", verdict: "rejected", reason: "Masks failures" },
    ],
    synthesisDecision: "The explicit outcome is the base.",
    tradeoffs: ["We accept a new result field in exchange for no catch-to-detect"],
    alternatives: ["Special-case the guard message: shallow"],
  },
  steps: ["Return an empty CSV when the filter matches nothing", "Add a regression test"],
  tests: ["npm test in src/export"],
  nextStep: "Add the empty outcome to RowSource.",
});

test("plan_issue opens one planning session keyed to the issue and attempt, and skips what triage ruled out", async () => {
  const { context, sent } = ctx();
  const started = (await planIssue.execute!(
    { issueKey: "TLSSN-42", title: "CSV export returns 500", summary: "Since this morning.", verdict: { kind: "bug", severity: "high" }, attempt: "triage-1" } as never,
    context as never
  )) as Record<string, unknown>;
  assert.equal(started["started"], true);
  assert.equal(started["continuationToken"], "issue:TLSSN-42#triage-1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.channelId, "plan");
  assert.match(sent[0]?.message ?? "", /^Plan TLSSN-42: CSV export returns 500/);
  assert.deepEqual(sent[0]?.options, {
    continuationToken: "issue:TLSSN-42#triage-1",
    admission: "coalesce",
    title: "TLSSN-42: CSV export returns 500",
  });

  const skipped = (await planIssue.execute!(
    { issueKey: "TLSSN-42", title: "x", verdict: { kind: "bug", severity: "high", needsInfo: true } } as never,
    context as never
  )) as Record<string, unknown>;
  assert.deepEqual(skipped, { started: false, reason: "needs_info", issueKey: "TLSSN-42" });
  assert.equal(sent.length, 1);

  const evalCtx = ctx({ purpose: "eval" });
  const inEval = (await planIssue.execute!({ issueKey: "TLSSN-42", title: "x" } as never, evalCtx.context as never)) as Record<string, unknown>;
  assert.deepEqual(inEval, { started: false, reason: "eval", issueKey: "TLSSN-42" });
  assert.equal(evalCtx.sent.length, 0);
});

test("two plan_issue calls for one ticket without an attempt send on distinct continuations", async () => {
  const { context, sent } = ctx();
  const request = { issueKey: "TLSSN-7", title: "CSV export returns 500", verdict: { kind: "bug", severity: "high" } };
  const first = (await planIssue.execute!(request as never, context as never)) as Record<string, unknown>;
  const second = (await planIssue.execute!(request as never, context as never)) as Record<string, unknown>;
  const tokens = sent.map((s) => String(s.options?.["continuationToken"]));
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  for (const token of tokens) {
    assert.match(token, /^issue:TLSSN-7#[0-9a-f-]{36}$/);
    assert.equal(pinnedIssueKey(token), "TLSSN-7");
  }
  assert.deepEqual([first["continuationToken"], second["continuationToken"]], tokens);
});

test("plan_issue reports a started plan when the session it opened has no id yet, and sends once", async () => {
  const { context } = ctx();
  const tokens: unknown[] = [];
  const deferred = {
    ...context,
    send: async (_channelId: string, _message: string, options?: Record<string, unknown>) => {
      tokens.push(options?.["continuationToken"]);
      return {
        get id(): string {
          throw new Error("deferred channel session: id is not available until admission");
        },
      };
    },
  };
  const result = await planIssue.execute!(
    { issueKey: "TLSSN-7", title: "CSV export returns 500", verdict: { kind: "bug", severity: "high" }, attempt: "32152" } as never,
    deferred as never
  );
  assert.deepEqual(result, { started: true, reason: "started", issueKey: "TLSSN-7", continuationToken: "issue:TLSSN-7#32152" });
  assert.deepEqual(tokens, ["issue:TLSSN-7#32152"]);
});

test("record_plan pins a chained session to its ticket whatever key the model typed", async () => {
  const { context, tagged } = ctx({ continuationKey: "issue:TLSSN-42" });
  const result = (await recordPlan.execute!({ ...plan, issueKey: "TLSSN-99" } as never, context as never)) as Record<string, unknown>;
  assert.equal(result["issueKey"], "TLSSN-42");
  assert.equal(result["pinned"], true);
  assert.equal(result["planKey"], "plan:TLSSN-42");
  assert.equal(result["recorded"], true);
  assert.equal((result["tracker"] as Record<string, unknown>)["status"], "not_connected");
  assert.equal(tagged[0]?.["key"], "plan:TLSSN-42");
  assert.match(String(result["brief"]), /^Implement Jira TLSSN-42 /);
  const ticketLine = `Ticket: https://example.atlassian.net/browse/TLSSN-42`;
  assert.equal(String(result["brief"]).split("\n")[1], ticketLine);
  assert.match(String((tagged[0]?.["data"] as Record<string, unknown>)["comment"]), new RegExp(`\\nBrief:\\n[^\\n]+\\n${ticketLine.replace(/[.]/g, "\\.")}\\n`));
});

test("record_plan links the filing Slack thread in the brief and the Plan: comment, so the pull request can", async () => {
  const permalink = "https://example-workspace.slack.com/archives/C0EXAMPLE1/p1790366941085899";
  // Jira may hand the description back as ADF with the link as a smart link.
  const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Filed from Slack.\n\nSlack thread: " }, { type: "inlineCard", attrs: { url: permalink } }] }] };
  for (const description of [`Filed from Slack.\n\nSlack thread: ${permalink}`, adf]) {
    const { context, tagged } = ctx({ continuationKey: "issue:TLSSN-42", tracker: { comments: [], status: "Triaged", description } });
    const result = (await recordPlan.execute!(plan as never, context as never)) as Record<string, unknown>;
    const brief = String(result["brief"]);
    assert.equal(brief.split("\n")[2], `Slack thread: ${permalink}`, JSON.stringify(description).slice(0, 40));
    assert.ok(brief.includes(`- Description, second line: "Slack: ${permalink}".`));
    assert.ok(String((tagged[0]?.["data"] as Record<string, unknown>)["comment"]).endsWith(brief));
  }
  const { context } = ctx({ continuationKey: "issue:TLSSN-42", tracker: { comments: [], status: "Triaged", description: "Slack thread: https://evil.example/archives/C1/p1" } });
  const plain = (await recordPlan.execute!(plan as never, context as never)) as Record<string, unknown>;
  assert.doesNotMatch(String(plain["brief"]), /Slack/);
});

test("record_plan comments on a chained ticket in Triaged and moves it to Planned once", async () => {
  const { context, trackerCalls, store } = ctx({ continuationKey: "issue:TLSSN-42", tracker: { comments: [], status: "Triaged" } });
  const result = (await recordPlan.execute!(plan as never, context as never)) as Record<string, unknown>;
  assert.deepEqual(result["tracker"], { status: "commented", issueKey: "TLSSN-42" });
  assert.deepEqual(result["transition"], { status: "transitioned" });
  assert.deepEqual(transitions(trackerCalls), [
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "21" } } },
  ]);
  assert.deepEqual(store.get("plan-outcome/ses_1"), { tool: "record_plan", reason: "recorded", tracker: "commented", transition: "transitioned" });
});

test("a late planning session writes nothing and never drags a ticket that left Triaged back to Planned", async () => {
  for (const status of ["Planned", "Approved", "In Progress", "In Review", "Done", "To Do"]) {
    const { context, trackerCalls, tagged } = ctx({ continuationKey: "cont:issue:TLSSN-42#TLSSN-42:Triaged:2026-09-25T12:04:40.000+1000", tracker: { comments: [], status } });
    const result = (await recordPlan.execute!(plan as never, context as never)) as Record<string, unknown>;
    assert.equal(result["recorded"], false, status);
    assert.equal(result["reason"], "not_triaged", status);
    assert.deepEqual(result["tracker"], { status: "skipped", reason: "not_triaged", issueKey: "TLSSN-42" }, status);
    assert.deepEqual(result["transition"], { status: "skipped_status", current: status }, status);
    assert.equal(result["brief"], "", status);
    assert.deepEqual(tagged, [], status);
    assert.deepEqual(trackerCalls.map((call) => call.tool), ["getJiraIssue"], status);
  }
});

test("record_plan comments but moves nothing when the ticket's status cannot be read", async () => {
  const { context, trackerCalls } = ctx({ continuationKey: "issue:TLSSN-42", tracker: { comments: [] } });
  const result = (await recordPlan.execute!(plan as never, context as never)) as Record<string, unknown>;
  assert.deepEqual(result["tracker"], { status: "commented", issueKey: "TLSSN-42" });
  assert.deepEqual(result["transition"], { status: "skipped_status" });
  assert.deepEqual(transitions(trackerCalls), []);
});

test("record_plan moves nothing when the Plan: comment is already there, in an eval, or unpinned", async () => {
  const existing = jiraComment(plan, "example-org/demo-repo", "https://example.atlassian.net/browse/TLSSN-42");
  const again = ctx({ continuationKey: "issue:TLSSN-42", tracker: { comments: [existing] } });
  const redelivered = (await recordPlan.execute!(plan as never, again.context as never)) as Record<string, unknown>;
  assert.deepEqual(redelivered["tracker"], { status: "already_commented", issueKey: "TLSSN-42" });
  assert.deepEqual(redelivered["transition"], { status: "skipped_status" });
  assert.deepEqual(transitions(again.trackerCalls), []);

  const evalCtx = ctx({ purpose: "eval", continuationKey: "issue:TLSSN-42", tracker: { comments: [] } });
  const inEval = (await recordPlan.execute!(plan as never, evalCtx.context as never)) as Record<string, unknown>;
  assert.equal(inEval["transition"], undefined);
  assert.deepEqual(evalCtx.trackerCalls, []);

  const unpinned = ctx({ tracker: { comments: [] } });
  const asked = (await recordPlan.execute!(plan as never, unpinned.context as never)) as Record<string, unknown>;
  assert.deepEqual(asked["tracker"], { status: "commented", issueKey: "TLSSN-42" });
  assert.equal(asked["recorded"], true);
  assert.equal(asked["pinned"], false);
  assert.equal(unpinned.tagged.length, 1);
  assert.equal(asked["transition"], undefined);
  assert.deepEqual(transitions(unpinned.trackerCalls), []);
});

test("record_plan whose Plan: comment is already there moves a ticket still in Triaged to Planned once", async () => {
  const existing = jiraComment(plan, "example-org/demo-repo", "https://example.atlassian.net/browse/TLSSN-42");
  const { context, trackerCalls } = ctx({ continuationKey: "issue:TLSSN-42", tracker: { comments: [existing], status: "Triaged" } });
  const result = (await recordPlan.execute!(plan as never, context as never)) as Record<string, unknown>;
  assert.deepEqual(result["tracker"], { status: "already_commented", issueKey: "TLSSN-42" });
  assert.deepEqual(result["transition"], { status: "transitioned" });
  assert.deepEqual(transitions(trackerCalls), [
    { tool: "transitionJiraIssue", args: { issueIdOrKey: "TLSSN-42", transition: { id: "21" } } },
  ]);
});

test("record_plan gives the desk peer a changelogId unique to each recorded plan", async () => {
  const saved = process.env.FACTORY_INPROCESS_PEERS;
  process.env.FACTORY_INPROCESS_PEERS = "1";
  try {
    const { context, deskCalls } = ctx({ continuationKey: "issue:TLSSN-42", deskReply: { posted: true, reason: "posted_in_thread", issueKey: "TLSSN-42" } });
    await recordPlan.execute!(plan as never, context as never);
    await recordPlan.execute!(plan as never, context as never);
    assert.deepEqual(deskCalls, [
      {
        tool: "call_tool",
        args: {
          toolName: "announce_plan",
          input: {
            issueKey: "TLSSN-42",
            title: "Retry CSV export on empty filter",
            problem: "An export whose filter matches no rows returns a 500.",
            tracker: "not_connected",
            changelogId: "art_1:2026-09-22T00:00:00.000Z",
          },
        },
      },
      {
        tool: "call_tool",
        args: {
          toolName: "announce_plan",
          input: {
            issueKey: "TLSSN-42",
            title: "Retry CSV export on empty filter",
            problem: "An export whose filter matches no rows returns a 500.",
            tracker: "not_connected",
            changelogId: "art_1:2026-09-22T00:00:01.000Z",
          },
        },
      },
    ]);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_INPROCESS_PEERS;
    else process.env.FACTORY_INPROCESS_PEERS = saved;
  }
});

test("record_plan skips the desk peer when the event bus is the product path", async () => {
  const saved = process.env.FACTORY_INPROCESS_PEERS;
  delete process.env.FACTORY_INPROCESS_PEERS;
  try {
    const { context } = ctx({ continuationKey: "issue:TLSSN-42", deskReply: { posted: true, reason: "posted_in_thread" } });
    const result = (await recordPlan.execute!(plan as never, context as never)) as Record<string, unknown>;
    assert.deepEqual(result["announce"], { status: "skipped", reason: "event_bus" });
  } finally {
    if (saved === undefined) delete process.env.FACTORY_INPROCESS_PEERS;
    else process.env.FACTORY_INPROCESS_PEERS = saved;
  }
});

// The desk answers announce_plan with { posted, reason }. A reply that did not
// post is not a post, whatever the transport said. Local serve --dir . only.
test("record_plan reports what the desk's announce_plan answered", async () => {
  const saved = process.env.FACTORY_INPROCESS_PEERS;
  process.env.FACTORY_INPROCESS_PEERS = "1";
  try {
  const posted = ctx({ continuationKey: "issue:TLSSN-42", deskReply: { posted: true, reason: "posted_in_thread", issueKey: "TLSSN-42" } });
  const a = (await recordPlan.execute!(plan as never, posted.context as never)) as Record<string, unknown>;
  assert.deepEqual(a["announce"], { status: "posted", reason: "posted_in_thread" });

  const already = ctx({ continuationKey: "issue:TLSSN-42", deskReply: { posted: false, reason: "already_announced", issueKey: "TLSSN-42" } });
  const b = (await recordPlan.execute!(plan as never, already.context as never)) as Record<string, unknown>;
  assert.deepEqual(b["announce"], { status: "skipped", reason: "already_announced" });

  const noThread = ctx({ continuationKey: "issue:TLSSN-42", deskReply: { posted: false, reason: "no_thread_and_no_intake_channel", issueKey: "TLSSN-42" } });
  const c = (await recordPlan.execute!(plan as never, noThread.context as never)) as Record<string, unknown>;
  assert.deepEqual(c["announce"], { status: "skipped", reason: "no_thread_and_no_intake_channel" });

  const failed = ctx({ continuationKey: "issue:TLSSN-42", deskReply: { posted: false, reason: "failed", issueKey: "TLSSN-42" } });
  const d = (await recordPlan.execute!(plan as never, failed.context as never)) as Record<string, unknown>;
  assert.deepEqual(d["announce"], { status: "failed", reason: "failed" });
  } finally {
    if (saved === undefined) delete process.env.FACTORY_INPROCESS_PEERS;
    else process.env.FACTORY_INPROCESS_PEERS = saved;
  }
});

test("record_plan's eval and dry-run results carry the ticket and the reason in tracker", async () => {
  const evalCtx = ctx({ purpose: "eval" });
  const inEval = (await recordPlan.execute!(plan as never, evalCtx.context as never)) as Record<string, unknown>;
  assert.deepEqual(inEval["tracker"], { status: "skipped", reason: "eval", issueKey: "TLSSN-42" });
  assert.equal(inEval["recorded"], false);
  assert.equal(inEval["reason"], "eval");
  assert.equal(evalCtx.tagged.length, 0);
  const dryRun = recordPlan.dryRunResult;
  assert.equal(typeof dryRun, "function");
  const planned = (dryRun as (input: never) => Record<string, unknown>)(plan as never);
  assert.equal(planned["reason"], "dry_run");
  assert.deepEqual(planned["tracker"], { status: "skipped", reason: "dry_run", issueKey: "TLSSN-42" });
});

test("get_plan reads the recorded brief back by ticket", async () => {
  const empty = ctx();
  assert.deepEqual(await getPlan.execute!({ issueKey: "TLSSN-42" } as never, empty.context as never), { found: false, issueKey: "TLSSN-42" });
  const stocked = ctx({
    records: [{ id: "art_1", key: "plan:TLSSN-42", kind: "plan", updatedAt: "2026-09-22T00:00:00.000Z", data: { title: "Retry", evidence: "checkout", tracker: "commented", brief: "Implement Jira TLSSN-42 …" } }],
  });
  const found = (await getPlan.execute!({ issueKey: "TLSSN-42" } as never, stocked.context as never)) as Record<string, unknown>;
  assert.equal(found["found"], true);
  assert.equal(found["brief"], "Implement Jira TLSSN-42 …");
  assert.equal(found["tracker"], "commented");
});

test("record_plan refuses prompt evidence and invents no brief", async () => {
  const { context, tagged, trackerCalls } = ctx({ continuationKey: "issue:TLSSN-42", tracker: { comments: [] } });
  const result = (await recordPlan.execute!({ ...plan, evidence: "prompt" } as never, context as never)) as Record<string, unknown>;
  assert.equal(result["recorded"], false);
  assert.equal(result["reason"], "unverified");
  assert.equal(result["brief"], "");
  assert.match(String(result["hint"]), /record_needs_info/);
  assert.deepEqual(result["tracker"], { status: "skipped", reason: "unverified", issueKey: "TLSSN-42" });
  assert.equal(tagged.length, 0);
  assert.deepEqual(trackerCalls, []);
});

test("record_plan refuses cited paths that are not on the sandbox", async () => {
  const { context, tagged, store } = ctx({ continuationKey: "issue:TLSSN-42" });
  const result = (await recordPlan.execute!(
    {
      ...plan,
      howItWorks: { ...plan.howItWorks, whereThingsLive: ["src/export/csv.ts", "lib/transactions-csv.ts"] },
    } as never,
    context as never
  )) as Record<string, unknown>;
  assert.equal(result["recorded"], false);
  assert.equal(result["reason"], "paths_missing");
  assert.deepEqual(result["missing"], ["lib/transactions-csv.ts"]);
  assert.equal(result["brief"], "");
  assert.match(String(result["hint"]), /record_needs_info/);
  assert.equal(tagged.length, 0);
  assert.deepEqual(store.get("plan-outcome/ses_1"), { tool: "record_plan", reason: "paths_missing", tracker: "skipped", missing: ["lib/transactions-csv.ts"] });
});

test("search_sandbox reports the claimed path when it is on the workspace", async () => {
  const { context } = ctx();
  const found = (await searchSandbox.execute!({ query: "csv export 500" } as never, context as never)) as Record<string, unknown>;
  assert.equal(found["available"], true);
  assert.equal(found["source"], "workspace");
  assert.ok((found["paths"] as string[]).includes("src/export/csv.ts"));
});

test("search_sandbox reads host.github when the workspace is empty", async () => {
  const empty = mkdtempSync(join(tmpdir(), "planner-empty-github-"));
  const { context } = ctx({
    workspaceDir: empty,
    github: {
      getOctokit: async () => ({
        request: async () => ({ data: { tree: [{ path: "lib/accounts.ts", type: "blob" }] } }),
      }),
    },
  });
  const found = (await searchSandbox.execute!({ query: "accounts" } as never, context as never)) as Record<string, unknown>;
  assert.equal(found["available"], true);
  assert.equal(found["source"], "github");
  assert.deepEqual(found["paths"], ["lib/accounts.ts"]);
});

test("search_sandbox answers a repeated query without searching again", async () => {
  let reads = 0;
  const empty = mkdtempSync(join(tmpdir(), "planner-repeat-"));
  const { context } = ctx({
    workspaceDir: empty,
    github: {
      getOctokit: async () => ({
        request: async () => {
          reads += 1;
          return { data: { tree: [{ path: "lib/accounts.ts", type: "blob" }] } };
        },
      }),
    },
  });
  await searchSandbox.execute!({ query: "Accounts" } as never, context as never);
  const readsAfterFirst = reads;
  const again = (await searchSandbox.execute!({ query: "  accounts " } as never, context as never)) as Record<string, unknown>;
  assert.equal(again["searched"], false);
  assert.equal(again["reason"], "repeated_query");
  assert.equal(reads, readsAfterFirst);
});

test("search_sandbox stops after the budget and tells the model to record now (TLSSN-45: 215 searches)", async () => {
  const { context, store } = ctx({ sessionId: "ses_budget" });
  store.set(searchBudgetKey("ses_budget"), { count: SEARCH_BUDGET, queries: [] });
  const spent = (await searchSandbox.execute!({ query: "csv export 500" } as never, context as never)) as Record<string, unknown>;
  assert.equal(spent["searched"], false);
  assert.equal(spent["reason"], "search_budget_spent");
  assert.match(String(spent["next"]), /record_plan now/);
  assert.match(String(spent["next"]), /record_needs_info/);
  assert.equal((store.get(searchBudgetKey("ses_budget")) as { count: number }).count, SEARCH_BUDGET + 1);
});

test("search_sandbox counts per session, so another run starts with a full budget", async () => {
  const kv = new Map<string, unknown>();
  kv.set(searchBudgetKey("ses_old"), { count: SEARCH_BUDGET + 5, queries: ["csv export 500"] });
  const { context } = ctx({ sessionId: "ses_new", kv });
  const found = (await searchSandbox.execute!({ query: "csv export 500" } as never, context as never)) as Record<string, unknown>;
  assert.equal(found["available"], true);
  assert.deepEqual(kv.get(searchBudgetKey("ses_new")), { count: 1, queries: ["csv export 500"] });
});

test("search_sandbox still searches when kv cannot be read", async () => {
  const { context } = ctx();
  const broken = { ...context, host: { ...context.host, kv: { get: async () => { throw new Error("kv down"); }, put: async () => undefined, delete: async () => undefined } } };
  const found = (await searchSandbox.execute!({ query: "csv export 500" } as never, broken as never)) as Record<string, unknown>;
  assert.equal(found["available"], true);
});

// July 0.2.12+ reruns a read tool's execute, same input and ctx, when the
// error looks transient: a status or code, or a bare 429/502/503/504 in the
// message. These drive the tool through July's own retry loop.
async function withReadRetry(run: () => unknown): Promise<unknown> {
  setToolRetrySleepForTests(async () => undefined);
  try {
    return await retryReadOnlyToolCall({ toolName: "search_sandbox", effect: "read", execute: async () => run() });
  } finally {
    setToolRetrySleepForTests(undefined);
  }
}

test("search_sandbox counts a search July's read retry recovers once, and searches again", async () => {
  const { context, store } = ctx({ sessionId: "ses_retry" });
  let attempts = 0;
  const flaky = {
    ...context,
    get workspaceDir() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("upstream unavailable"), { status: 503 });
      return workspace;
    },
  };
  const found = (await withReadRetry(() => searchSandbox.execute!({ query: "csv export 500" } as never, flaky as never))) as Record<string, unknown>;
  assert.equal(attempts, 2);
  assert.equal(found["available"], true);
  assert.ok((found["paths"] as string[]).includes("src/export/csv.ts"));
  assert.deepEqual(store.get(searchBudgetKey("ses_retry")), { count: 1, queries: ["csv export 500"] });
});

test("search_sandbox surfaces an error whose text only looks transient instead of answering repeated_query", async () => {
  const saved = process.env.FACTORY_SANDBOX_REPO;
  process.env.FACTORY_SANDBOX_REPO = "marsbank-503";
  const { context, store } = ctx({ sessionId: "ses_bare_status" });
  try {
    await assert.rejects(
      withReadRetry(() => searchSandbox.execute!({ query: "csv export 500" } as never, context as never)),
      /^Error: failed after 3 attempts: Set FACTORY_SANDBOX_REPO to one owner\/repo\. "marsbank-503"/
    );
  } finally {
    if (saved === undefined) delete process.env.FACTORY_SANDBOX_REPO;
    else process.env.FACTORY_SANDBOX_REPO = saved;
  }
  assert.deepEqual(store.get(searchBudgetKey("ses_bare_status")), { count: 0, queries: [] });
});

test("search_sandbox refunds a slot whose put landed and then threw, so July's retry searches again and counts once", async () => {
  const { context, store } = ctx({ sessionId: "ses_put_landed" });
  let puts = 0;
  const kv = {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      store.set(key, value);
      puts += 1;
      if (puts === 1) throw Object.assign(new Error("kv put: bad gateway"), { status: 502 });
    },
    delete: async (key: string) => void store.delete(key),
  };
  let attempts = 0;
  const flaky = {
    ...context,
    host: { ...context.host, kv },
    get workspaceDir(): string {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("upstream unavailable"), { status: 503 });
      return workspace;
    },
  };
  const found = (await withReadRetry(() => searchSandbox.execute!({ query: "csv export" } as never, flaky as never))) as Record<string, unknown>;
  assert.equal(attempts, 2);
  assert.equal(found["available"], true);
  assert.ok((found["paths"] as string[]).includes("src/export/csv.ts"));
  assert.deepEqual(store.get(searchBudgetKey("ses_put_landed")), { count: 1, queries: ["csv export"] });
});

test("search_sandbox refunds nothing when its budget read failed, so an earlier search of the same query stays counted", async () => {
  const { context, store } = ctx({ sessionId: "ses_read_fails" });
  let failNextGet = false;
  const kv = {
    get: async (key: string) => {
      if (!failNextGet) return store.get(key);
      failNextGet = false;
      throw new Error("kv read failed");
    },
    put: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
  const counted = { ...context, host: { ...context.host, kv } };
  await searchSandbox.execute!({ query: "csv export" } as never, counted as never);
  assert.deepEqual(store.get(searchBudgetKey("ses_read_fails")), { count: 1, queries: ["csv export"] });

  failNextGet = true;
  const failure = new Error("search failed");
  const throwing = {
    ...counted,
    get workspaceDir(): string {
      throw failure;
    },
  };
  await assert.rejects(searchSandbox.execute!({ query: "csv export" } as never, throwing as never) as Promise<unknown>, (error) => error === failure);
  assert.equal(failNextGet, false);
  assert.deepEqual(store.get(searchBudgetKey("ses_read_fails")), { count: 1, queries: ["csv export"] });
});

test("the planner instructions carry the search budget rule the tool enforces", () => {
  const instructions = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");
  assert.match(instructions, new RegExp(`budget of ${SEARCH_BUDGET} \`search_sandbox\``));
  assert.match(instructions, /search_budget_spent/);
  assert.match(instructions, /Never repeat a query/);
});

test("record_needs_info comments Needs info and does not move the ticket", async () => {
  const { context, trackerCalls, tagged, store } = ctx({ continuationKey: "issue:TLSSN-42", tracker: { comments: [] } });
  const result = (await recordNeedsInfo.execute!(
    {
      issueKey: "TLSSN-99",
      claimed: "CSV export returns 500 on an empty filter.",
      mismatch: "No csv or export path on main.",
      searched: ["csv export", "src/export"],
    } as never,
    context as never
  )) as Record<string, unknown>;
  assert.equal(result["recorded"], true);
  assert.equal(result["reason"], "commented");
  assert.equal(result["issueKey"], "TLSSN-42");
  assert.deepEqual(result["tracker"], { status: "commented", issueKey: "TLSSN-42" });
  assert.equal(result["brief"], undefined);
  assert.equal(tagged.length, 0);
  assert.equal(
    trackerCalls.some((call) => call.tool === "addCommentToJiraIssue"),
    true
  );
  assert.deepEqual(transitions(trackerCalls), []);
  const body = String(trackerCalls.find((call) => call.tool === "addCommentToJiraIssue")?.args?.["body"] ?? "");
  assert.match(body, /^Needs info: TLSSN-42\nClaimed failure is not on example-org\/demo-repo@main \(checked \d{4}-\d\d-\d\d \d\d:\d\d UTC\)\./);
  assert.match(body, /Do not implement/);
  assert.deepEqual(store.get("plan-outcome/ses_1"), { tool: "record_needs_info", reason: "commented", tracker: "commented" });
});

test("record_needs_info writes once per planning run, and a later run (a replan) writes its own", async () => {
  const input = { issueKey: "TLSSN-42", claimed: "CSV export 500", mismatch: "no csv path", searched: ["csv"] };
  const first = ctx({ continuationKey: "issue:TLSSN-42#10030", tracker: { comments: [], status: "Triaged" } });
  await recordNeedsInfo.execute!(input as never, first.context as never);
  const repeated = (await recordNeedsInfo.execute!(input as never, first.context as never)) as Record<string, unknown>;
  assert.deepEqual(repeated, {
    recorded: false,
    reason: "already_commented",
    issueKey: "TLSSN-42",
    repo: "example-org/demo-repo",
    ref: "main",
    tracker: { status: "already_commented", issueKey: "TLSSN-42" },
  });
  assert.equal(first.trackerCalls.filter((call) => call.tool === "addCommentToJiraIssue").length, 1);

  const earlier = needsInfoComment({ ...input, repo: "example-org/demo-repo", ref: "main", at: new Date("2026-09-24T10:00:00.000Z") });
  const replan = ctx({ sessionId: "ses_2", continuationKey: "issue:TLSSN-42#10090", tracker: { comments: [earlier], status: "Triaged" } });
  const again = (await recordNeedsInfo.execute!(input as never, replan.context as never)) as Record<string, unknown>;
  assert.equal(again["reason"], "commented");
  assert.equal(replan.trackerCalls.filter((call) => call.tool === "addCommentToJiraIssue").length, 1);
});

test("record_needs_info writes nothing on a ticket that already left Triaged", async () => {
  const { context, trackerCalls, store } = ctx({ continuationKey: "issue:TLSSN-42#10030", tracker: { comments: [], status: "Planned" } });
  const result = (await recordNeedsInfo.execute!(
    { issueKey: "TLSSN-42", claimed: "CSV export 500", mismatch: "no csv path", searched: ["csv"] } as never,
    context as never
  )) as Record<string, unknown>;
  assert.equal(result["recorded"], false);
  assert.equal(result["reason"], "not_triaged");
  assert.match(String(result["hint"]), /TLSSN-42 is Planned, not Triaged/);
  assert.equal(trackerCalls.some((call) => call.tool === "addCommentToJiraIssue"), false);
  assert.deepEqual(store.get("plan-outcome/ses_1"), { tool: "record_needs_info", reason: "not_triaged", tracker: "skipped" });
});

test("record_needs_info in an eval writes nothing", async () => {
  const evalCtx = ctx({ purpose: "eval", continuationKey: "issue:TLSSN-42", tracker: { comments: [] } });
  const inEval = (await recordNeedsInfo.execute!(
    { issueKey: "TLSSN-42", claimed: "CSV export 500", mismatch: "no csv path", searched: ["csv"] } as never,
    evalCtx.context as never
  )) as Record<string, unknown>;
  assert.equal(inEval["recorded"], false);
  assert.equal(inEval["reason"], "eval");
  assert.deepEqual(evalCtx.trackerCalls, []);
  assert.equal(evalCtx.store.size, 0);
});

test("record_plan refuses a title that is the reporter's question or two sentences, and a summary that repeats the title (TLSSN-46)", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ title: 'Could we add a "Download CSV" option on the Activity page?' }, /title is a question/],
    [{ title: "Add CSV download to Activity. Tax time is coming up" }, /more than one sentence/],
    [{ title: "x".repeat(81) }, /under 80/],
    [{ summary: "Retry CSV export on empty filter." }, /summary repeats the title/],
  ];
  for (const [index, [override, why]] of cases.entries()) {
    const { context, trackerCalls } = ctx({ sessionId: `ses_digest_${index}`, continuationKey: "issue:TLSSN-42", tracker: { comments: [], status: "Triaged" } });
    await assert.rejects(async () => recordPlan.execute!({ ...plan, ...override } as never, context as never), why, JSON.stringify(override));
    assert.deepEqual(trackerCalls, [], "a refused plan reads and writes nothing");
  }
  assert.equal(digestProblem(plan), undefined);
});

test("the title check reads abbreviations, initials, and version numbers as one sentence", () => {
  for (const title of ["Export fails on v2.3.1 for e.g. empty filters", "Mr. Smith's transfers vs. scheduled payments", "Totals off by 1.5x i.e. doubled", "Fees for J. Smith's account"]) {
    assert.equal(digestProblem({ title, summary: "Something the title does not say." }), undefined, title);
  }
});

test("a title refused twice in one run is replaced by the host's truncated title, so the plan still records", async () => {
  const kv = new Map<string, unknown>();
  const question = { ...plan, title: 'Could we add a "Download CSV" option on the Activity page? Tax time is coming up' };
  const first = ctx({ sessionId: "ses_twice", kv, tracker: { comments: [], status: "Triaged" } });
  await assert.rejects(async () => recordPlan.execute!(question as never, first.context as never), /title is a question|more than one sentence/);
  const second = ctx({ sessionId: "ses_twice", kv, tracker: { comments: [], status: "Triaged" } });
  const result = (await recordPlan.execute!(question as never, second.context as never)) as Record<string, unknown>;
  assert.notEqual(result["reason"], undefined);
  const comment = second.trackerCalls.find((call) => call.tool === "addCommentToJiraIssue")?.args?.["body"];
  assert.match(String(comment), /^Plan: TLSSN-42 Could we add a "Download CSV" option on the Activity page\n/);
  assert.equal(fallbackTitle({ title: "x ".repeat(60).trim(), issueKey: "TLSSN-9" }).length <= 80, true);
  assert.equal(fallbackTitle({ title: "Export fails on v2.3.1. Seen on main", issueKey: "TLSSN-9" }), "Export fails on v2.3.1");
  // Verifier: a title of "?" left nothing, and an empty title reached the ticket.
  assert.equal(fallbackTitle({ title: "?", issueKey: "TLSSN-9", summary: "Cap retries on the export job so a failure stops after three tries." }), "Cap retries on the export job so a");
  assert.equal(fallbackTitle({ title: " ?! ", issueKey: "TLSSN-9" }), "TLSSN-9 plan");
  assert.equal(fallbackTitle({ title: "...", issueKey: "TLSSN-9", summary: "?" }), "TLSSN-9 plan");
});

test("the plan schema and instructions ask for a synthesized title and a Problem that states the problem, not the solution", () => {
  assert.match(String(planSchema.shape.title.description), /own words/);
  assert.match(String(planSchema.shape.problem.description), /the problem, not the solution/);
  assert.match(String(planSchema.shape.summary.description), /something the title does not say/);
  const instructions = readFileSync(new URL("../instructions.md", import.meta.url), "utf8");
  assert.match(instructions, /`problem` states the problem/);
  assert.match(instructions, /never the reporter's\n\s+question or sentence copied/);
});

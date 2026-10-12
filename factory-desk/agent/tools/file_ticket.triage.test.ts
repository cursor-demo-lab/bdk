import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, HostMcpToolInfo } from "@cursor/july";
import { hopWatchKey } from "../lib/hop-watch.js";
import { REPORTER_REQUEST_END, REPORTER_REQUEST_LABEL, intakeTriageKey, type IntakeTriage } from "../lib/intake-triage.js";
import { latestTriageVerdict } from "../lib/triage-comment.js";
import { DESK_TRIAGED_LINE, deskTriaged, governingTriage, isDeskTriageComment } from "../lib/desk-triaged.js";
import fileTicket from "./file_ticket.js";

// `approve file` files the ticket already triaged: the create carries the
// type, the Triage: comment carries the verdict, and the ticket moves To Do →
// Triaged, the move the planner wakes on and the desk announces once.

const ENV = ["FACTORY_DESK_JIRA_PROJECT", "FACTORY_JIRA_PROJECTS", "FACTORY_STATUS_TODO", "FACTORY_STATUS_TRIAGED", "JIRA_CLOUD_ID", "FACTORY_DESK_CLAIM_SETTLE_MS"] as const;
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.FACTORY_DESK_JIRA_PROJECT = "TLSSN";
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
});
after(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const THREAD = { channelId: "C0123ABCD", threadTs: "1758510000.123456" };
const NOW = new Date("2026-09-22T00:00:00.000Z");

function tool(name: string, properties: string[]): HostMcpToolInfo {
  return { name, inputSchema: { type: "object", properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])) } };
}
const TOOLS = [
  tool("createJiraIssue", ["projectKey", "summary", "description", "issueTypeName"]),
  tool("addCommentToJiraIssue", ["cloudId", "issueIdOrKey", "commentBody"]),
  tool("getTransitionsForJiraIssue", ["cloudId", "issueIdOrKey"]),
  tool("transitionJiraIssue", ["cloudId", "issueIdOrKey", "transition"]),
  tool("getJiraIssue", ["cloudId", "issueIdOrKey"]),
];
const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function desk(options: { intake?: IntakeTriage; refuseType?: string; commentFails?: boolean } = {}) {
  const kv: Record<string, unknown> = {};
  if (options.intake !== undefined) kv[intakeTriageKey(THREAD)] = { exp: NOW.getTime() + 60_000, triage: options.intake };
  const calls: Array<Record<string, unknown>> = [];
  let status = "To Do";
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => TOOLS,
    callTool: async (_connection: string, name: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      calls.push({ tool: name, ...args });
      if (name === "createJiraIssue") {
        if (options.refuseType !== undefined && args["issueTypeName"] === options.refuseType) return { isError: true, content: [{ type: "text", text: `issue type ${options.refuseType} is not valid for TLSSN` }] };
        return json({ key: "TLSSN-42", self: "https://x.atlassian.net/browse/TLSSN-42" });
      }
      if (name === "addCommentToJiraIssue") return options.commentFails === true ? { isError: true, content: [{ type: "text", text: "no permission" }] } : json({ id: "1" });
      if (name === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "11", name: "Start triage", to: { name: "Triaged" } }] });
      if (name === "getJiraIssue") return json({ key: "TLSSN-42", fields: { status: { name: status } } });
      if (name === "transitionJiraIssue") {
        status = "Triaged";
        return json({});
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const context = {
    session: {
      id: "ses_1",
      channelId: "slack",
      mode: "chat",
      purpose: "live",
      auth: { authenticator: "slack", principalId: "slack:T:thread", principalType: "user", attributes: { channel_id: THREAD.channelId, thread_ts: THREAD.threadTs } },
      continuationKey: `${THREAD.channelId}:${THREAD.threadTs}`,
    },
    now: () => NOW,
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      slack: { getClient: async () => ({ apiCall: async () => ({ ok: true }) }) },
      mcp,
      reminders: { create: async () => ({ id: "rem_1" }), cancel: async () => undefined },
      // The turn's ticket tag (hooks/ticket-key.ts), recorded among the Jira calls so its moment is visible.
      otel: { setAttributes: (attributes: Record<string, unknown>) => void calls.push({ tool: "otel.setAttributes", ...attributes }) },
    },
  };
  const creates = () => calls.filter((call) => call.tool === "createJiraIssue");
  const comment = () => calls.find((call) => call.tool === "addCommentToJiraIssue")?.["commentBody"] as string | undefined;
  const moved = () => calls.some((call) => call.tool === "transitionJiraIssue");
  return { kv, calls, context, creates, comment, moved };
}

type Pair = [string, number];
const answer = ([choice, probability]: Pair) => ({ type: "choice" as const, choice, probabilities: { [choice]: probability } });
const answers = (type: Pair, severity: Pair, gate: Pair = ["proceed", 0.9]) => ({ issueType: answer(type), severity: answer(severity), gate: answer(gate) });
const TYPES = { source: "project" as const, types: [{ name: "Task", id: "10170" }, { name: "Story", id: "10171" }, { name: "Bug", id: "10172" }] };
const MODEL = { title: "CSV export returns 500", description: "Since this morning. Asked by Alice.", kind: "question", severity: "low", summary: "The CSV export fails with a 500." };

async function file(d: ReturnType<typeof desk>, input: Record<string, unknown> = MODEL) {
  return (await fileTicket.execute!(input as never, d.context as never)) as Record<string, any>;
}

test("Jev confident: filed as Jev's type and severity with the request's summary, Triage: comment written, moved to Triaged, no triage hop", async () => {
  const d = desk({ intake: { by: "jev", jev: { answers: answers(["Bug", 0.93], ["medium", 0.84]), source: "webhook", types: TYPES }, type: "Bug", severity: "medium", needsInfo: false, title: "CSV export returns 500", summary: "It fails whenever the filter matches no rows." } });
  const result = await file(d);
  assert.equal(result["created"], true);
  assert.equal(d.creates()[0]?.["issueTypeName"], "Bug", "the model said question; Jev's type wins");
  assert.ok(deskTriaged(String(d.creates()[0]?.["description"])), "triage-jira leaves it alone");
  assert.ok(String(d.creates()[0]?.["description"]).endsWith(DESK_TRIAGED_LINE));
  const comment = d.comment()!;
  assert.deepEqual(comment.split("\n").slice(0, 4), ["Triage: bug", "Type: Bug", "Severity: medium", "Summary: It fails whenever the filter matches no rows."]);
  assert.match(comment, /^Triaged by: Jev \(84% confidence; type, severity, and gate all above 0\.52\)\nJudge: Jev type Bug 0\.93 \(set in Jira; Jev only\); severity medium 0\.84 \(Jev only\)$/m, "who triaged it, then the scores");
  assert.equal(String(result["reply"]), "[TLSSN-42](https://x.atlassian.net/browse/TLSSN-42) is filed. Triaged by Jev: Bug, medium severity (84% confidence).", "the filing prompt already showed the Summary");
  const read = latestTriageVerdict([comment]);
  assert.equal(read?.kind, "bug");
  assert.equal(read?.issueType, "Bug");
  const order = d.calls.map((call) => call.tool);
  assert.ok(order.indexOf("addCommentToJiraIssue") < order.indexOf("transitionJiraIssue"), "the verdict is on the ticket before the move wakes the planner");
  assert.deepEqual(d.calls.filter((call) => call.tool === "otel.setAttributes"), [{ tool: "otel.setAttributes", "factory.ticket.key": "TLSSN-42" }], "file_ticket tags the turn with the key it minted");
  assert.ok(order.indexOf("createJiraIssue") < order.indexOf("otel.setAttributes") && order.indexOf("otel.setAttributes") < order.indexOf("addCommentToJiraIssue"), "the moment the key exists, before the Triage: comment");
  assert.equal(d.moved(), true);
  const filed = Object.entries(d.kv).filter(([key]) => key.startsWith("announced/TLSSN-42:Triaged:verdict-"));
  assert.deepEqual(filed.map(([key, value]) => [key, (value as Record<string, unknown>)["filed"]]), [["announced/TLSSN-42:Triaged:verdict-bug.medium.plan.bug.medium.first", true]], "the Filed post is this verdict's Triaged line");
  assert.equal(d.kv[hopWatchKey("TLSSN-42")], undefined, "Triaged arms the plan hop from the Jira channel; no triage hop");
  assert.equal(d.kv[intakeTriageKey(THREAD)], undefined, "the intake answer is used once");
  assert.deepEqual(result["triage"], { by: "jev", issueType: "Bug", kind: "bug", severity: "medium", summary: "It fails whenever the filter matches no rows.", status: "triaged" });
  assert.doesNotMatch(String(result["reply"]), /Summary:/);
});

test("TLSSN-37: Jev confident on a title-only request files the turn's summary, and the Filed post never shows the title template", async () => {
  const title = '[e2e-155] Settings "All six registers restored." confirmation is not announced to screen readers.';
  const intake = { by: "jev" as const, jev: { answers: answers(["Bug", 0.93], ["medium", 0.84]), source: "webhook" as const, types: TYPES }, type: "Bug", severity: "medium" as const, needsInfo: false, title };
  const written = desk({ intake });
  const result = await file(written, { ...MODEL, title: title.slice(0, 80), kind: "bug", severity: "medium", summary: "Screen readers stay silent after the six registers are restored." });
  assert.match(written.comment()!, /^Summary: Screen readers stay silent after the six registers are restored\.$/m);
  assert.doesNotMatch(String(result["reply"]), /Summary:/);

  const restated = desk({ intake });
  const repeat = await file(restated, { ...MODEL, title: title.slice(0, 80), kind: "bug", severity: "medium", summary: title });
  assert.match(restated.comment()!, /^Summary: Bug reported as /m, "the Triage: comment still gets a summary");
  assert.doesNotMatch(String(repeat["reply"]), /Summary:|reported as/, "the Filed post leaves out a summary that only repeats the title");
});

test("Jev at the bar: the model's triage is filed, a type Jev was confident about goes on the ticket, and the Judge: line compares", async () => {
  const d = desk({ intake: { by: "model", reason: "below_bar", jev: { answers: answers(["Bug", 0.93], ["high", 0.52]), source: "webhook", types: TYPES } } });
  const result = await file(d);
  assert.equal(d.creates()[0]?.["issueTypeName"], "Bug");
  const comment = d.comment()!;
  assert.match(comment, /^Triage: bug$/m, "the type on the ticket sets the kind, as in triage-jira");
  assert.match(comment, /^Severity: low$/m, "severity at the bar keeps the model's");
  assert.match(comment, /^Summary: The CSV export fails with a 500\.$/m);
  assert.match(comment, /^Triaged by: Grok 4\.6 Fast \(Jev was only 52% confident; not above 0\.52 on every answer\)\nJudge: Jev type Bug 0\.93 \(set in Jira; model said question\); severity high 0\.52 \(kept the model's low, below 0\.52\)$/m);
  assert.match(String(result["reply"]), /is filed\. Triaged by Grok 4\.6 Fast \(Jev was only 52% confident\): Bug, low severity\./);
  assert.doesNotMatch(String(result["reply"]), /0\.\d\d/, "no scores in Slack");
  assert.equal(d.moved(), true);
  assert.equal(result["triage"]?.["by"], "model");
  assert.equal(result["triage"]?.["fallback"], "below_bar");
});

test("Jev failed: the model's triage is filed with the kind's own type and no Judge: line, and still moves to Triaged", async () => {
  const d = desk({ intake: { by: "model", reason: "unavailable" } });
  const result = await file(d, { ...MODEL, kind: "bug", severity: "medium" });
  assert.equal(d.creates()[0]?.["issueTypeName"], "Bug");
  assert.match(d.comment()!, /^Triage: bug\nType: Bug\nSeverity: medium\nSummary: The CSV export fails with a 500\.\nNext step: Planner: reproduce the failure/);
  assert.doesNotMatch(d.comment()!, /^Judge:/m);
  assert.match(d.comment()!, /^Triaged by: Grok 4\.6 Fast \(Jev did not settle it: Jev did not answer\)$/m);
  assert.equal(d.moved(), true);
  assert.equal(result["triage"]?.["status"], "triaged");
  assert.match(String(result["reply"]), /is filed\. Triaged by Grok 4\.6 Fast \(Jev didn't answer\): Bug, medium severity\./);
});

test("a project that refuses Jev's type is filed with the kind's type, and the Judge: line says the Jira type did not take", async () => {
  const d = desk({ refuseType: "Story", intake: { by: "jev", jev: { answers: answers(["Story", 0.9], ["low", 0.9]), source: "webhook", types: TYPES }, type: "Story", severity: "low", needsInfo: false, summary: 'Story reported as "x", low severity.' } });
  const result = await file(d);
  assert.deepEqual(d.creates().map((call) => call["issueTypeName"]), ["Story", "Task"]);
  assert.equal(result["created"], true);
  assert.match(d.comment()!, /^Type: Task$/m);
  assert.match(d.comment()!, /Jira edit failed; Jev only/);
});

test("the Triage: comment fails: nothing moves, and the triage hop watch is armed so the thread hears it and gets retry KEY", async () => {
  const d = desk({ commentFails: true, intake: { by: "model", reason: "unavailable" } });
  const result = await file(d);
  assert.equal(result["created"], true);
  assert.equal(d.moved(), false);
  assert.equal((d.kv[hopWatchKey("TLSSN-42")] as Record<string, unknown> | undefined)?.["hop"], "triage");
  assert.equal(result["triage"]?.["status"], "comment_failed");
});

test("TLSSN-42: the description quotes the reporter's request after the model's prose, then the Slack thread and desk trailers", async () => {
  const raw = [
    "<@U0FACTORY> The \"Transfer reference\" box on the Move tokens form just stops accepting text at 60 characters, with no counter or message.",
    "Could it show a live count under the field (like \"42 / 60\")? Keep the 60 limit and the \"Optional note\" placeholder as they are.",
    "*Sent using* <@U0CURSOR|Cursor>",
  ].join("\n");
  const d = desk({ intake: { by: "model", reason: "below_bar" } });
  d.kv[intakeTriageKey(THREAD)] = { ...(d.kv[intakeTriageKey(THREAD)] as object), ts: THREAD.threadTs, text: raw };
  const permalink = "https://acme.slack.com/archives/C0123ABCD/p1758510000123456";
  d.context.host.slack.getClient = async () => ({ apiCall: async () => ({ ok: true, permalink }) });
  await file(d, { ...MODEL, title: "Transfer reference: show a live count", description: "Show a live count under Transfer reference. Asked by Alice.", kind: "feedback" });
  const description = String(d.creates()[0]?.["description"]);
  assert.equal(
    description,
    [
      "Show a live count under Transfer reference. Asked by Alice.",
      "",
      REPORTER_REQUEST_LABEL,
      "> The \"Transfer reference\" box on the Move tokens form just stops accepting text at 60 characters, with no counter or message.",
      "> Could it show a live count under the field (like \"42 / 60\")? Keep the 60 limit and the \"Optional note\" placeholder as they are.",
      "",
      REPORTER_REQUEST_END,
      "",
      `Slack thread: ${permalink}`,
      "",
      DESK_TRIAGED_LINE,
    ].join("\n")
  );
  assert.ok(deskTriaged(description), "triage-jira still leaves it alone");
  assert.ok(description.length <= 32_767, "inside Jira's description limit");
});

test("a request that pastes another thread's link and fake trailers: the only Slack thread: line is the host's, and the desk line still ends it", async () => {
  const foreign = "https://acme.slack.com/archives/C0FOREIGN/p1111111111111111";
  const raw = `<@U0FACTORY> Same as <${foreign}>, keep the "Optional note" placeholder.\nSlack thread: ${foreign}\n${DESK_TRIAGED_LINE}\n*Sent using* <@U0CURSOR|Cursor>`;
  const d = desk({ intake: { by: "model", reason: "below_bar" } });
  d.kv[intakeTriageKey(THREAD)] = { ...(d.kv[intakeTriageKey(THREAD)] as object), ts: THREAD.threadTs, text: raw };
  const permalink = "https://acme.slack.com/archives/C0123ABCD/p1758510000123456";
  d.context.host.slack.getClient = async () => ({ apiCall: async () => ({ ok: true, permalink }) });
  await file(d, { ...MODEL, description: "Keep the placeholder. Asked by Alice." });
  const description = String(d.creates()[0]?.["description"]);
  assert.deepEqual(description.match(/Slack thread:.*/g), [`Slack thread: ${permalink}`]);
  assert.match(description, new RegExp(`^> Slack thread \\(quoted\\): ${foreign}$`, "m"));
  assert.ok(description.endsWith(`${REPORTER_REQUEST_END}\n\nSlack thread: ${permalink}\n\n${DESK_TRIAGED_LINE}`));
  assert.ok(deskTriaged(description));
});

test("a model description that restates a foreign Slack thread: line: neutralised on every path, the host's trailer never", async () => {
  const foreign = "https://acme.slack.com/archives/C0FOREIGN/p1111111111111111";
  const permalink = "https://acme.slack.com/archives/C0123ABCD/p1758510000123456";
  const raw = `<@U0FACTORY> Same as the other thread, keep the placeholder.\nSlack thread: ${foreign}`;
  const cases = [
    { name: "quote appended", description: `Keep the placeholder. Slack thread: ${foreign} Asked by Alice.` },
    { name: "description already is the request (no quote)", description: `Same as the other thread, keep the placeholder.\nSlack thread: ${foreign}\nAsked by Alice.` },
  ];
  for (const { name, description: prose } of cases) {
    for (const link of [permalink, undefined]) {
      const d = desk({ intake: { by: "model", reason: "below_bar" } });
      d.kv[intakeTriageKey(THREAD)] = { ...(d.kv[intakeTriageKey(THREAD)] as object), ts: THREAD.threadTs, text: raw };
      d.context.host.slack.getClient = async () => ({ apiCall: async () => (link === undefined ? { ok: false } : { ok: true, permalink: link }) });
      await file(d, { ...MODEL, description: prose });
      const description = String(d.creates()[0]?.["description"]);
      const label = `${name}, ${link === undefined ? "no permalink" : "channel"}`;
      assert.deepEqual(description.match(/Slack thread:.*/g), link === undefined ? null : [`Slack thread: ${link}`], label);
      assert.match(description, new RegExp(`Slack thread \\(quoted\\): ${foreign}`), label);
      assert.equal(description.includes(REPORTER_REQUEST_LABEL), name === "quote appended", label);
      assert.ok(deskTriaged(description), label);
    }
  }
});

test("no stashed request text: the description is the model's, as before", async () => {
  const d = desk({ intake: { by: "model", reason: "below_bar" } });
  await file(d);
  assert.equal(String(d.creates()[0]?.["description"]), `${MODEL.description}\n\n${DESK_TRIAGED_LINE}`);
});

test("Jev failed, the model said urgent on a confirmation-step ask: file_ticket files medium, in the comment and the Filed post", async () => {
  const d = desk({ intake: { by: "model", reason: "unavailable" } });
  const logOut = 'The "Log out" button logs you out straight away even when the transfer form has something typed in. Could it ask to confirm first when the form has input? Asked by Alice.';
  const result = await file(d, { ...MODEL, title: "Log out asks no confirmation", description: logOut, kind: "bug", severity: "urgent", summary: "Log out ignores typed input." });
  assert.match(d.comment()!, /^Severity: medium$/m);
  assert.match(String(result["reply"]), /is filed\. Triaged by Grok 4\.6 Fast \(Jev didn't answer\): Bug, medium severity\./);
  assert.equal(result["triage"]?.["severity"], "medium");
});

test("Jev failed, the model said urgent on an outage: file_ticket keeps urgent", async () => {
  const d = desk({ intake: { by: "model", reason: "unavailable" } });
  await file(d, { ...MODEL, title: "Login outage", description: "Customers can't log in on web or mobile since 9am. Asked by Alice.", kind: "bug", severity: "urgent" });
  assert.match(d.comment()!, /^Severity: urgent$/m);
});

test("no stashed request text: the model's title cannot lift the cap over its description", async () => {
  const d = desk({ intake: { by: "model", reason: "unavailable" } });
  const description = 'One of our testers lost a half-filled transfer when they hit "Log out". Could it ask for a confirmation first? Asked by Alice.';
  const result = await file(d, { ...MODEL, title: "Log out deletes all data", description, kind: "bug", severity: "urgent" });
  assert.match(d.comment()!, /^Severity: medium$/m);
  assert.equal(result["triage"]?.["severity"], "medium");
});

test("the severity guard reads the reporter's stashed words, not the model's description", async () => {
  const d = desk({ intake: { by: "model", reason: "unavailable" } });
  const raw = '<@U0FACTORY> The "Log out" button logs you out straight away even when the transfer form has something typed in. Could it ask to confirm first?';
  d.kv[intakeTriageKey(THREAD)] = { ...(d.kv[intakeTriageKey(THREAD)] as object), ts: THREAD.threadTs, text: raw };
  await file(d, { ...MODEL, title: "Log out confirm", description: "Users lose data when they log out. Asked by Alice.", kind: "bug", severity: "urgent" });
  assert.match(d.comment()!, /^Severity: medium$/m, "the model's own 'lose data' is not the reporter's");
});

test("live Test B filed on Jev's triage: the Triage: comment carries the confidence and the cap, and every reader still reads it", async () => {
  const TEST_B = 'The "Log out" button in the banking header signs you out immediately, even when you\'re halfway through a transfer on Move tokens.\n\nOne of our testers lost a half-filled transfer after brushing it on a trackpad. It would be nicer if it asked "Leave this transfer?" when the form has unsaved input, and logged out straight away otherwise.';
  const d = desk({ intake: { by: "jev", jev: { answers: answers(["Bug", 0.99], ["urgent", 0.62], ["proceed", 1]), source: "webhook", types: TYPES }, type: "Bug", severity: "medium", needsInfo: false, title: "Log out" } });
  d.kv[intakeTriageKey(THREAD)] = { ...(d.kv[intakeTriageKey(THREAD)] as object), ts: THREAD.threadTs, text: `<@U0FACTORY> ${TEST_B}` };
  const result = await file(d, { ...MODEL, title: "Log out asks no confirmation", description: TEST_B, kind: "bug", severity: "urgent" });
  const comment = d.comment()!;
  assert.match(comment, /^Severity: medium$/m);
  assert.match(comment, /^Triaged by: Jev \(62% confidence; Jev said urgent; type, severity, and gate all above 0\.52\)$/m);
  const read = latestTriageVerdict([comment]);
  assert.equal(read?.triagedBy, "jev");
  assert.equal(read?.severity, "medium");
  assert.deepEqual(governingTriage([comment]), { index: 0, from: "desk" }, "planner and desk still pick the desk's machine-written verdict");
  assert.ok(isDeskTriageComment(comment), "triage-jira still skips it");
  assert.match(String(result["reply"]), /Triaged by Jev: Bug, medium severity \(62% confidence\)/);
});

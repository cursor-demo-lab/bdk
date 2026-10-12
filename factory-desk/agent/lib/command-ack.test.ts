import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostKvApi, HostMcpCallResult, HostMcpToolInfo } from "@cursor/july";
import approveTicket from "../tools/approve_ticket.js";
import denyTicket from "../tools/deny_ticket.js";
import { declinedLine } from "./plan-decline.js";
import fileTicket from "../tools/file_ticket.js";
import { ackCommand, APPROVED_REACTION } from "./command-ack.js";
import { stashIntakeTriage } from "./intake-triage.js";
import { commandKey, speakerKey } from "./originator.js";
import { filingHoldKey } from "./thread-tickets.js";

// TLSSN-27/28: `approve file` and `approve TLSSN-N` were processed (filed,
// approved) but the person's own reply never got a reaction. `approve file`
// had no ack anywhere, and `approve KEY` only on the host path; the model
// path (`approve_ticket`) moved the card silently.

const THREAD = { channelId: "C0EXAMPLE1", threadTs: "1790370261.284789" };
const FILER = "U0EXAMPLE3";
const NOW = new Date("2026-09-25T21:16:00.000Z");
const COMMAND_TS = `${NOW.getTime() / 1000 - 18}.310909`;

let savedProject: string | undefined;
let lines: string[] = [];
const realLog = console.log;
const realError = console.error;

before(() => {
  savedProject = process.env.FACTORY_DESK_JIRA_PROJECT;
  process.env.FACTORY_DESK_JIRA_PROJECT = "TLSSN";
  console.log = (line: unknown) => void lines.push(`out ${String(line)}`);
  console.error = (line: unknown) => void lines.push(`err ${String(line)}`);
});

after(() => {
  console.log = realLog;
  console.error = realError;
  if (savedProject === undefined) delete process.env.FACTORY_DESK_JIRA_PROJECT;
  else process.env.FACTORY_DESK_JIRA_PROJECT = savedProject;
});

type Call = { method: string; args: Record<string, unknown> };

/** A Slack client whose reactions.add answers from `reactions` in order (an Error rejects), then ok. */
function slack(reactions: Array<"ok" | Error | "hang"> = [], present: Array<{ name: string; users: string[] }> | Error = []) {
  const calls: Call[] = [];
  const client = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      if (method === "reactions.get") {
        if (present instanceof Error) throw present;
        return { ok: true, message: { reactions: present.map((r) => ({ ...r, count: r.users.length })) } };
      }
      if (method !== "reactions.add") return { ok: true };
      const next = reactions.shift() ?? "ok";
      if (next === "hang") return new Promise(() => {});
      if (next instanceof Error) throw next;
      return { ok: true };
    },
  };
  return { calls, getClient: async () => client };
}

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
}

function acks(): Array<Record<string, unknown>> {
  return lines.filter((line) => line.includes('"command_ack"')).map((line) => ({ stream: line.slice(0, 3), ...JSON.parse(line.slice(4)) }));
}

test("ackCommand adds ✅ to the command message and logs it", async () => {
  lines = [];
  const s = slack();
  assert.equal(await ackCommand({ getClient: s.getClient, target: { channel: THREAD.channelId, ts: COMMAND_TS }, command: "approve file", issueKey: "TLSSN-28" }), "reacted");
  assert.deepEqual(s.calls, [
    { method: "reactions.get", args: { channel: THREAD.channelId, timestamp: COMMAND_TS, full: true } },
    { method: "reactions.add", args: { channel: THREAD.channelId, timestamp: COMMAND_TS, name: APPROVED_REACTION } },
  ]);
  assert.deepEqual(acks(), [{ stream: "out", desk: "command_ack", command: "approve file", outcome: "reacted", issueKey: "TLSSN-28", channel: THREAD.channelId, ts: COMMAND_TS }]);
});

// TLSSN-30: the Cursor client put the person's own ✅ on `approve file`, then
// the desk added its own, and Slack showed white_check_mark × 2.
test("ackCommand skips the add when any user's ✅ is already on the message", async () => {
  for (const command of ["approve file", "approve KEY", "deny file"] as const) {
    lines = [];
    const s = slack([], [{ name: "eyes", users: ["U0EXAMPLE2"] }, { name: APPROVED_REACTION, users: [FILER] }]);
    assert.equal(await ackCommand({ getClient: s.getClient, target: { channel: THREAD.channelId, ts: COMMAND_TS }, command, issueKey: "TLSSN-30" }), "already_present");
    assert.deepEqual(reactionsOn(s.calls), []);
    assert.deepEqual(acks(), [{ stream: "out", desk: "command_ack", command, outcome: "already_present", issueKey: "TLSSN-30", channel: THREAD.channelId, ts: COMMAND_TS }]);
  }
});

test("ackCommand still adds once when the message has other reactions or reactions.get fails", async () => {
  for (const present of [[{ name: "eyes", users: [FILER] }], slackError("missing_scope")]) {
    const s = slack([], present);
    assert.equal(await ackCommand({ getClient: s.getClient, target: { channel: THREAD.channelId, ts: COMMAND_TS }, command: "approve file" }), "reacted");
    assert.equal(reactionsOn(s.calls).length, 1);
  }
});

test("ackCommand treats already_reacted as done, retries a transient error once, and does not retry a permanent one", async () => {
  lines = [];
  assert.equal(await ackCommand({ getClient: slack([slackError("already_reacted")]).getClient, target: { channel: THREAD.channelId, ts: COMMAND_TS }, command: "approve KEY" }), "already");

  const flaky = slack([slackError("internal_error")]);
  assert.equal(await ackCommand({ getClient: flaky.getClient, target: { channel: THREAD.channelId, ts: COMMAND_TS }, command: "approve KEY" }), "reacted");
  assert.equal(reactionsOn(flaky.calls).length, 2);

  const denied = slack([slackError("missing_scope"), slackError("missing_scope")]);
  assert.equal(await ackCommand({ getClient: denied.getClient, target: { channel: THREAD.channelId, ts: COMMAND_TS }, command: "approve KEY", issueKey: "TLSSN-28" }), "failed");
  assert.equal(reactionsOn(denied.calls).length, 1);
  assert.deepEqual(acks().at(-1), { stream: "err", desk: "command_ack", command: "approve KEY", outcome: "failed", issueKey: "TLSSN-28", channel: THREAD.channelId, ts: COMMAND_TS, error: "missing_scope" });
});

test("ackCommand never throws: no client, a hung call, or no message ts each log on stderr and return", async () => {
  lines = [];
  const noToken = async () => {
    throw new Error("No Slack bot token available (set FACTORY_DESK_SLACK_BOT_TOKEN).");
  };
  assert.equal(await ackCommand({ getClient: noToken, target: { channel: THREAD.channelId, ts: COMMAND_TS }, command: "approve file" }), "no_client");
  assert.equal(await ackCommand({ getClient: async () => ({}), target: { channel: THREAD.channelId, ts: COMMAND_TS }, command: "approve file" }), "no_client");
  const started = Date.now();
  assert.equal(await ackCommand({ getClient: slack(["hang"]).getClient, target: { channel: THREAD.channelId, ts: COMMAND_TS }, command: "approve KEY", timeoutMs: 20 }), "timeout");
  assert.ok(Date.now() - started < 1000);
  const untouched = slack();
  assert.equal(await ackCommand({ getClient: untouched.getClient, target: { channel: THREAD.channelId, ts: undefined }, command: "approve KEY" }), "no_target");
  assert.deepEqual(untouched.calls, []);
  assert.deepEqual(
    acks().map((line) => [line["stream"], line["outcome"]]),
    [
      ["err", "no_client"],
      ["err", "no_client"],
      ["err", "timeout"],
      ["err", "no_target"],
    ]
  );
});

const TOOLS: HostMcpToolInfo[] = [
  { name: "createJiraIssue", inputSchema: { type: "object", properties: { projectKey: {}, summary: {}, description: {}, issueTypeName: {} } } },
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: {} } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: {} } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: {}, transition: {} } } },
];

function json(value: unknown): HostMcpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** A tool context in the ticket thread, with the command record the inbound handler writes for `text`. */
function toolContext(input: { text: string; speaker?: string; status?: string; slack: ReturnType<typeof slack>; bound?: boolean }) {
  const [verb, target] = input.text.split(" ") as [string, string];
  const spoken = { userId: input.speaker ?? FILER, ts: COMMAND_TS };
  const kv: Record<string, unknown> = {
    [speakerKey(THREAD)]: spoken,
    [commandKey(THREAD, { verb: verb as never, target })]: spoken,
    ...(input.bound === false ? {} : { "ticket/TLSSN-28": { ...THREAD, originatorUserId: FILER } }),
  };
  const jira: string[] = [];
  let status = input.status ?? "Planned";
  const context = {
    session: {
      id: "ses_1",
      channelId: "slack",
      mode: "chat",
      purpose: "live",
      continuationKey: null,
      auth: { authenticator: "slack", principalId: "slack:T:thread", principalType: "user", attributes: { channel_id: THREAD.channelId, thread_ts: THREAD.threadTs, user_id: FILER } },
    },
    now: () => NOW,
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      slack: { getClient: input.slack.getClient },
      mcp: {
        names: () => ["tracker"],
        listTools: async () => TOOLS,
        callTool: async (_connection: string, tool: string): Promise<HostMcpCallResult> => {
          jira.push(tool);
          if (tool === "createJiraIssue") return json({ key: "TLSSN-28", self: "https://example.atlassian.net/browse/TLSSN-28" });
          if (tool === "getJiraIssue") return json({ key: "TLSSN-28", fields: { status: { name: status } } });
          if (tool === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "31", name: "Approve", to: { name: "Approved" } }] });
          if (tool === "transitionJiraIssue") status = "Approved";
          return json({});
        },
      },
    },
  };
  return { kv, jira, context: context as never };
}

function reactionsOn(calls: Call[]): Array<Record<string, unknown>> {
  return calls.filter((call) => call.method === "reactions.add").map((call) => call.args);
}

test("approve_ticket (the model path) moves the ticket and adds ✅ to the filer's approve KEY message", async () => {
  const s = slack();
  const t = toolContext({ text: "approve TLSSN-28", slack: s });
  const result = (await approveTicket.execute!({ issueKey: "TLSSN-28" } as never, t.context)) as Record<string, unknown>;
  assert.equal(result["approved"], true);
  assert.deepEqual(t.jira, ["getJiraIssue", "getTransitionsForJiraIssue", "getJiraIssue", "transitionJiraIssue"]);
  assert.deepEqual(reactionsOn(s.calls), [{ channel: THREAD.channelId, timestamp: COMMAND_TS, name: APPROVED_REACTION }]);

  const already = slack();
  const again = toolContext({ text: "approve TLSSN-28", status: "Approved", slack: already });
  assert.equal(((await approveTicket.execute!({ issueKey: "TLSSN-28" } as never, again.context)) as Record<string, unknown>)["reason"], "already_approved");
  assert.equal(reactionsOn(already.calls).length, 1);
});

test("approve_ticket still approves when the reaction fails or there is no Slack client; the result is unchanged", async () => {
  for (const failure of [slackError("ratelimited"), new Error("socket hang up")]) {
    const s = slack([failure, failure]);
    const t = toolContext({ text: "approve TLSSN-28", slack: s });
    assert.deepEqual(await approveTicket.execute!({ issueKey: "TLSSN-28" } as never, t.context), {
      approved: true,
      reason: "transitioned",
      issueKey: "TLSSN-28",
      transition: "transitioned",
      toStatus: "Approved",
    });
    assert.equal(t.jira.at(-1), "transitionJiraIssue");
  }
  const broken = toolContext({ text: "approve TLSSN-28", slack: { calls: [], getClient: async () => Promise.reject(new Error("no token")) } });
  assert.equal(((await approveTicket.execute!({ issueKey: "TLSSN-28" } as never, broken.context)) as Record<string, unknown>)["approved"], true);
});

test("approve_ticket adds no reaction when it did not approve: a refusal, or a ticket that moved on", async () => {
  const refusedSlack = slack();
  const refused = toolContext({ text: "approve TLSSN-28", speaker: "U0BOB0001", slack: refusedSlack });
  assert.equal(((await approveTicket.execute!({ issueKey: "TLSSN-28" } as never, refused.context)) as Record<string, unknown>)["status"], "not_originator");
  const movedSlack = slack();
  const moved = toolContext({ text: "approve TLSSN-28", status: "Triaged", slack: movedSlack });
  assert.equal(((await approveTicket.execute!({ issueKey: "TLSSN-28" } as never, moved.context)) as Record<string, unknown>)["reason"], "moved_on");
  assert.deepEqual([reactionsOn(refusedSlack.calls), reactionsOn(movedSlack.calls)], [[], []]);
});

test("file_ticket adds ✅ to the approve file message once the issue exists, beside the 👀 on the thread root", async () => {
  const s = slack();
  const t = toolContext({ text: "approve file", slack: s, bound: false });
  const result = (await fileTicket.execute!({ title: "Accounts register search ignores account id", description: "Asked by Simon.", kind: "bug" } as never, t.context)) as Record<string, unknown>;
  assert.equal(result["created"], true);
  assert.equal(result["originatorUserId"], FILER);
  assert.deepEqual(reactionsOn(s.calls), [
    { channel: THREAD.channelId, timestamp: THREAD.threadTs, name: "eyes" },
    { channel: THREAD.channelId, timestamp: COMMAND_TS, name: APPROVED_REACTION },
  ]);
});

test("file_ticket adds no second ✅ when the filer's own ✅ is already on approve file", async () => {
  const s = slack([], [{ name: APPROVED_REACTION, users: [FILER] }]);
  const t = toolContext({ text: "approve file", slack: s, bound: false });
  const result = (await fileTicket.execute!({ title: "x", description: "y", kind: "bug" } as never, t.context)) as Record<string, unknown>;
  assert.equal(result["created"], true);
  assert.deepEqual(reactionsOn(s.calls).map((args) => args["name"]), ["eyes"]);
});

test("file_ticket files and binds the ticket when the ✅ fails", async () => {
  // The root's 👀 fails first, then both tries of the ✅.
  const s = slack([slackError("fatal_error"), slackError("fatal_error"), slackError("fatal_error")]);
  const t = toolContext({ text: "approve file", slack: s, bound: false });
  const result = (await fileTicket.execute!({ title: "x", description: "y", kind: "bug" } as never, t.context)) as Record<string, unknown>;
  assert.equal(result["created"], true);
  assert.equal(result["threadBound"], true);
  assert.deepEqual(t.kv["ticket/TLSSN-28"], { ...THREAD, originatorUserId: FILER, filedAt: NOW.toISOString() });
});

test("file_ticket filed from a ✅ on the filing prompt keeps the reactor as filer and acks nothing: the reaction's ts is no message", async () => {
  const s = slack();
  const t = toolContext({ text: "approve file", slack: s, bound: false });
  const spoken = { userId: FILER, ts: COMMAND_TS, reaction: true };
  t.kv[speakerKey(THREAD)] = spoken;
  t.kv[commandKey(THREAD, { verb: "approve", target: "file" })] = spoken;
  const stderr: string[] = [];
  const error = console.error;
  console.error = (line: unknown) => void stderr.push(String(line));
  try {
    const result = (await fileTicket.execute!({ title: "x", description: "y", kind: "bug" } as never, t.context)) as Record<string, unknown>;
    assert.equal(result["created"], true);
    assert.equal(result["originatorUserId"], FILER);
  } finally {
    console.error = error;
  }
  assert.deepEqual(reactionsOn(s.calls).map((args) => args["name"]), ["eyes"]);
  assert.deepEqual(stderr.filter((line) => line.includes("command_ack")), []);
});

test("file_ticket's thread hold makes a second filing inside it a no-op, and a new filing request in the thread (a DM's next bug) past the in-flight window releases it", async () => {
  const t = toolContext({ text: "approve file", slack: slack(), bound: false });
  const file = async () => (await fileTicket.execute!({ title: "x", description: "y", kind: "bug" } as never, t.context)) as Record<string, unknown>;
  assert.equal((await file())["created"], true);
  assert.equal((t.kv[filingHoldKey(THREAD)] as Record<string, unknown>)["state"], "pending");
  assert.equal((await file())["reason"], "already_filing", "a ✅ plus a typed approve file inside the hold file once");
  const kv = (t.context as { host: { kv: HostKvApi } }).host.kv;
  await stashIntakeTriage(kv, [THREAD], { by: "model", reason: "no_key" }, NOW);
  assert.equal((t.kv[filingHoldKey(THREAD)] as Record<string, unknown>)["state"], "pending", "a hold young enough to be a create in flight stays");
  await stashIntakeTriage(kv, [THREAD], { by: "model", reason: "no_key" }, new Date(NOW.getTime() + 61_000));
  assert.equal(t.kv[filingHoldKey(THREAD)], undefined);
  assert.equal((await file())["created"], true, "the next request files");
});

test("file_ticket adds no ✅ when no fresh approve file vouches for the filing", async () => {
  const s = slack();
  const t = toolContext({ text: "approve file", slack: s, bound: false });
  delete t.kv[commandKey(THREAD, { verb: "approve", target: "file" })];
  await fileTicket.execute!({ title: "x", description: "y", kind: "bug" } as never, t.context);
  assert.deepEqual(reactionsOn(s.calls).map((args) => args["name"]), ["eyes"]);
});

/** deny_ticket in the ticket thread: a Plan: comment on the ticket, optionally already declined. */
function denyContext(input: { text: string; slack: ReturnType<typeof slack>; declined?: boolean; speaker?: string; status?: string }) {
  const [verb, target] = input.text.split(" ") as [string, string];
  const spoken = { userId: input.speaker ?? FILER, ts: COMMAND_TS };
  const kv: Record<string, unknown> = {
    [speakerKey(THREAD)]: spoken,
    [commandKey(THREAD, { verb: verb as never, target })]: spoken,
    "ticket/TLSSN-28": { ...THREAD, originatorUserId: FILER },
  };
  const comments = [{ id: "100", body: "Plan: TLSSN-28 CSV download on the Activity page\nSummary: x" }, ...(input.declined === true ? [{ id: "101", body: "Denied in Slack by alice" }] : [])];
  const jira: string[] = [];
  const labels: string[] = [];
  const heldAtLabel: boolean[] = [];
  const context = {
    session: {
      id: "ses_1",
      channelId: "slack",
      mode: "chat",
      purpose: "live",
      continuationKey: null,
      auth: { authenticator: "slack", principalId: "slack:T:thread", principalType: "user", attributes: { channel_id: THREAD.channelId, thread_ts: THREAD.threadTs, user_id: FILER } },
    },
    now: () => NOW,
    host: {
      kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
      slack: { getClient: input.slack.getClient },
      mcp: {
        names: () => ["tracker"],
        listTools: async () => [
          { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: {} } } },
          { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: {}, commentBody: {} } } },
          { name: "editJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: {}, update: {} } } },
        ],
        callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
          jira.push(tool);
          if (tool === "editJiraIssue") {
            labels.push(JSON.stringify(args["update"]));
            heldAtLabel.push(kv["approve-ticket/TLSSN-28"] !== undefined);
          }
          if (tool === "getJiraIssue") return json({ key: "TLSSN-28", fields: { status: { name: input.status ?? "Planned" }, comment: { comments } } });
          return json({ id: "102" });
        },
      },
    },
  };
  return { jira, labels, heldAtLabel, kv, context: context as never };
}

test("deny_ticket adds ✅ to the filer's deny KEY message once the decline is on the ticket, as approve does", async () => {
  const s = slack();
  const t = denyContext({ text: "deny TLSSN-28", slack: s });
  const result = (await denyTicket.execute!({ issueKey: "TLSSN-28", by: "alice" } as never, t.context)) as Record<string, unknown>;
  assert.equal(result["denied"], true);
  assert.ok(t.jira.includes("addCommentToJiraIssue"));
  // TLSSN-48: a typed `deny` answered "stays Planned" while ❌ said "plan declined"; both now give the same line and record the same.
  assert.equal(result["reply"], declinedLine({ issueKey: "TLSSN-28", prefix: "" }));
  assert.deepEqual(t.labels, [JSON.stringify({ labels: [{ add: "plan-declined" }] })]);
  assert.deepEqual(t.heldAtLabel, [true], "the decision hold still covers the label write, so an approve cannot land in between (Bugbot)");
  assert.equal(t.kv["approve-ticket/TLSSN-28"], undefined, "and it is released once the decline is written");
  assert.deepEqual(reactionsOn(s.calls), [
    { channel: THREAD.channelId, timestamp: COMMAND_TS, name: APPROVED_REACTION },
    { channel: THREAD.channelId, timestamp: THREAD.threadTs, name: "no_entry_sign" },
  ], "the deny message gets ✅ and the root moves to 🚫");
  assert.ok(acks().some((line) => line["command"] === "deny KEY" && line["outcome"] === "reacted"));

  const again = slack();
  const already = denyContext({ text: "deny TLSSN-28", slack: again, declined: true });
  const repeat = (await denyTicket.execute!({ issueKey: "TLSSN-28" } as never, already.context)) as Record<string, unknown>;
  assert.equal(repeat["message"], "The plan for TLSSN-28 is already declined; nothing changed.");
  assert.deepEqual(reactionsOn(again.calls), [], "a deny of a plan already declined says so, with no second ✅ and no record");
  assert.deepEqual(already.labels, []);
});

test("deny_ticket adds no reaction to a refused deny", async () => {
  const s = slack();
  const t = denyContext({ text: "deny TLSSN-28", slack: s, speaker: "U0BOB0001" });
  assert.equal(((await denyTicket.execute!({ issueKey: "TLSSN-28" } as never, t.context)) as Record<string, unknown>)["status"], "not_originator");
  assert.deepEqual(reactionsOn(s.calls), []);
});

// Verifier finding: deny on an In Progress ticket added plan-declined, swapped 🛠️ for 🚫, and said "nothing is built".
test("deny_ticket on a ticket past Planned refuses the way ❌ does: no comment, no label, no reaction, the not-Planned line", async () => {
  for (const status of ["In Progress", "In Review", "Done"]) {
    const s = slack();
    const t = denyContext({ text: "deny TLSSN-28", slack: s, status });
    const result = (await denyTicket.execute!({ issueKey: "TLSSN-28", by: "alice" } as never, t.context)) as Record<string, unknown>;
    assert.equal(result["denied"], false, status);
    assert.equal(result["reason"], "not_planned", status);
    assert.equal(result["message"], `TLSSN-28 is ${status}, not Planned, so there is no plan to decline.`, status);
    assert.equal(t.jira.includes("addCommentToJiraIssue"), false, status);
    assert.deepEqual(t.labels, [], status);
    assert.deepEqual(reactionsOn(s.calls), [], status);
    assert.equal(t.kv["plan-declined/TLSSN-28"], undefined, status);
  }
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { loadAgentProject, type HostMcpCallResult, type HostMcpToolInfo, type ReminderCreateInput } from "@cursor/july";
import channel, { entryTime } from "../channels/jira.js";
import { planDeclinedKey } from "./plan-decline.js";
import hopWatchReminder from "../reminders/hop_watch.js";
import fileTicket from "../tools/file_ticket.js";
import {
  armHopWatch,
  fireHopWatch,
  HOP_WATCH_HANDLER,
  HOP_WATCH_INDEX,
  HOPS,
  hopWatchKey,
  MAX_UNREAD,
  PLAN_START_DEADLINE_MS,
  PLAN_START_HANDLER,
  runHopWatchSchedule,
  SWEEP_GRACE_MS,
  sweepHopWatches,
  UNREAD_RETRY_MS,
  planningWork,
  readTriagedSince,
  triagedSinceKey,
  type HopWatch,
} from "./hop-watch.js";
import { PLANNING_LIVE_MS, planningRun } from "./planner-liveness.js";

// A hop that never lands (a pod replaced mid-turn, a Jira rule that is off, a
// comment or move that fails) used to leave the ticket's thread silent. Each
// entry arms one record and one named-handler reminder due at the hop's
// deadline; the fire re-reads Jira and posts one line, or nothing when the
// ticket moved on or its outcome was already heard.

const ENV = { JIRA_WEBHOOK_SECRET: "test-secret", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_DESK_JIRA_PROJECT: "TLSSN", FACTORY_DESK_CLAIM_SETTLE_MS: "5" } as const;
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
after(() => {
  for (const name of Object.keys(ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const KEY = "TLSSN-29";
const THREAD = { channelId: "C0123ABCD", threadTs: "1758510000.123456" };
const BOUND = { [`ticket/${KEY}`]: { ...THREAD, originatorUserId: "U0ALICE01" } };
const T0 = new Date("2026-09-25T23:50:00Z");

type Comment = { id?: string; body: string };

function memoryKv(initial: Record<string, unknown> = BOUND) {
  const rows: Record<string, unknown> = structuredClone(initial);
  return { rows, kv: { get: async (key: string) => rows[key] as never, put: async (key: string, value: unknown) => void (rows[key] = value), delete: async (key: string) => void delete rows[key] } };
}

function jira(input: { status?: string; comments?: Comment[]; unreadable?: boolean }) {
  const state = { status: input.status ?? "Triaged", comments: input.comments ?? [], unreadable: input.unreadable === true, reads: 0, edits: [] as unknown[] };
  const mcp = {
    names: () => ["tracker"],
    listTools: async (): Promise<HostMcpToolInfo[]> => [
      { name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } },
      { name: "editJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" }, update: { type: "object" } } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (tool === "editJiraIssue") {
        state.edits.push(args["update"]);
        return { content: [{ type: "text", text: "{}" }] };
      }
      state.reads += 1;
      if (state.unreadable) return { content: [{ type: "text", text: "Jira is having a moment" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify({ key: KEY, fields: { status: { name: state.status }, comment: { comments: state.comments } } }) }] };
    },
  };
  return { state, mcp };
}

function reminders(options: { createThrows?: boolean } = {}) {
  const created: ReminderCreateInput[] = [];
  const cancelled: Array<{ id: string; reason?: string }> = [];
  return {
    created,
    cancelled,
    api: {
      create: async (input: ReminderCreateInput) => {
        if (options.createThrows === true) throw new Error("reminder control plane down");
        created.push(input);
        return { id: `rem_${created.length}` } as never;
      },
      cancel: async (id: string, reason?: string) => (cancelled.push({ id, ...(reason === undefined ? {} : { reason }) }), undefined),
      list: async () => [],
      cancelForContinuation: async () => 0,
      rekeyContinuation: async () => 0,
      dispatch: async () => ({ reminderId: "", outcome: "noop" as const }),
    },
  };
}

function host(kv: ReturnType<typeof memoryKv>["kv"], mcp: ReturnType<typeof jira>["mcp"], posts: Record<string, unknown>[], rem?: ReturnType<typeof reminders>, reactions: string[] = []) {
  return {
    kv,
    mcp,
    ...(rem === undefined ? {} : { reminders: rem.api }),
    slack: {
      getClient: async () => ({
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            posts.push(args);
            return { ok: true, ts: `1758510002.00${String(posts.length).padStart(4, "0")}` };
          },
        },
        apiCall: async (method: string, args: Record<string, unknown>) => {
          if (method.startsWith("reactions.")) reactions.push(`${method}:${String(args["name"])}@${String(args["timestamp"])}`);
          return { ok: true };
        },
      }),
    },
  };
}

type Handler = (request: Request, ctx: unknown) => Promise<Response>;
const handler = (channel as unknown as { routes: Array<{ handler: Handler }> }).routes[0]!.handler;
const sign = (raw: string) => `sha256=${createHmac("sha256", ENV.JIRA_WEBHOOK_SECRET).update(raw).digest("hex")}`;

async function deliver(body: unknown, h: ReturnType<typeof host>) {
  const raw = JSON.stringify(body);
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } });
  const background: Promise<unknown>[] = [];
  const response = await handler(request, { host: h, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body });
  await Promise.all(background);
  return response;
}

function moved(from: string, to: string, id: string) {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { key: KEY, fields: { summary: "Add payees", status: { name: to }, project: { key: "TLSSN" } } },
    changelog: { id, items: [{ field: "status", fromString: from, toString: to }] },
  };
}

function commented(body: string, status: string, id = "20001") {
  return {
    webhookEvent: "comment_created",
    issue: { key: KEY, fields: { summary: "Add payees", status: { name: status }, project: { key: "TLSSN" } } },
    comment: { id, body },
  };
}

const record = (rows: Record<string, unknown>) => rows[hopWatchKey(KEY)] as HopWatch | undefined;
const at = (ms: number) => () => new Date(T0.getTime() + ms);
const texts = (posts: Record<string, unknown>[]) => posts.map((post) => String(post["text"]));

test("Triaged arms the plan hop with a named-handler reminder and its 4-minute start check; a Needs info comment clears both and cancels the reminders", async () => {
  const { rows, kv } = memoryKv();
  const rem = reminders();
  const h = host(kv, jira({ status: "Triaged", comments: [{ id: "10010", body: "Triage: feedback\nSeverity: medium" }] }).mcp, [], rem);
  await deliver(moved("To Do", "Triaged", "5001"), h);

  assert.equal(record(rows)?.hop, "plan");
  assert.equal(record(rows)?.changelogId, "5001");
  assert.equal(record(rows)?.baselineCommentId, "10010");
  assert.equal(record(rows)?.reminderId, "rem_1");
  assert.equal(record(rows)?.startReminderId, "rem_2");
  assert.equal(record(rows)?.startDueAt, new Date(Date.parse(record(rows)!.since) + PLAN_START_DEADLINE_MS).toISOString());
  assert.deepEqual(rows[HOP_WATCH_INDEX], [KEY]);
  assert.equal(rem.created.length, 2);
  const created = rem.created[0]!;
  assert.equal(created.handler, HOP_WATCH_HANDLER);
  assert.equal(created.channelId, "jira");
  assert.equal(created.delay, "15m");
  assert.deepEqual(created.args, { issueKey: KEY, hop: "plan", changelogId: "5001" });
  assert.equal(created.run, undefined, "hosted v2 rejects anonymous reminder run");
  const start = rem.created[1]!;
  assert.equal(start.handler, PLAN_START_HANDLER);
  assert.equal(start.channelId, "jira");
  assert.equal(start.delay, "4m");
  assert.deepEqual(start.args, { issueKey: KEY, hop: "plan", changelogId: "5001" });
  assert.equal(start.run, undefined);

  // The same delivery again arms nothing new.
  await deliver(moved("To Do", "Triaged", "5001"), h);
  assert.equal(rem.created.length, 2);

  await deliver(commented(`Needs info: ${KEY}\nClaimed failure is not on o/r@main.`, "Triaged"), h);
  assert.equal(record(rows), undefined);
  assert.deepEqual(rem.cancelled, [
    { id: "rem_1", reason: "cleared" },
    { id: "rem_2", reason: "cleared" },
  ]);
  assert.equal((rows[triagedSinceKey(KEY)] as { since: string }).since, (await readTriagedSince(kv, KEY))?.toISOString(), "the Triaged entry time outlives the watch, for retry");
  assert.notEqual(rows[triagedSinceKey(KEY)], undefined);
});

test("Approved arms the launch hop; In Progress clears it; an outcome of another hop never clears it", async () => {
  const { rows, kv } = memoryKv();
  const rem = reminders();
  const tracker = jira({ status: "Approved" });
  const h = host(kv, tracker.mcp, [], rem);
  await deliver(moved("Planned", "Approved", "6001"), h);
  assert.equal(record(rows)?.hop, "launch");
  assert.equal(rem.created[0]?.delay, "7m", "past the worker's own relaunch at 4 minutes and its launch's deadline and late wait");

  await deliver(commented(`Plan stopped: ${KEY}\nThe run hit its limit.`, "Triaged", "20002"), h);
  assert.equal(record(rows)?.hop, "launch", "a planner outcome does not end the launch hop");

  tracker.state.status = "In Progress";
  await deliver(moved("Approved", "In Progress", "6002"), h);
  assert.equal(record(rows), undefined);
});

test("a new entry replaces the old hop and cancels its reminder; the old reminder's fire is stale", async () => {
  const { rows, kv } = memoryKv();
  const rem = reminders();
  const tracker = jira({ status: "Triaged" });
  const posts: Record<string, unknown>[] = [];
  const h = host(kv, tracker.mcp, posts, rem);
  await deliver(moved("To Do", "Triaged", "5001"), h);
  tracker.state.status = "Approved";
  await deliver(moved("Planned", "Approved", "6001"), h);
  assert.equal(record(rows)?.hop, "launch");
  assert.deepEqual(rem.cancelled, [
    { id: "rem_1", reason: "superseded" },
    { id: "rem_2", reason: "superseded" },
  ]);

  const announced = posts.length;
  const stale = await fireHopWatch({ host: h, now: at(HOPS.plan.deadlineMs + 1) }, { issueKey: KEY, hop: "plan", changelogId: "5001" });
  assert.equal(stale.result, "superseded");
  assert.equal(posts.length, announced);
});

test("a plan hop past its deadline with the ticket still Triaged posts one retry line; the sweep then finds nothing", async () => {
  const { rows, kv } = memoryKv({ ...BOUND, [`reaction/${KEY}`]: { channel: THREAD.channelId, ts: THREAD.threadTs, name: "hourglass_flowing_sand", changelogId: "5001" } });
  const posts: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const h = host(kv, jira({ status: "Triaged", comments: [{ id: "10010", body: "Triage: feedback\nSeverity: medium" }] }).mcp, posts, reminders(), reactions);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 });

  const fired = await fireHopWatch({ host: h, now: at(HOPS.plan.deadlineMs + 60_000) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.deepEqual(fired, { issueKey: KEY, hop: "plan", result: "posted" });
  assert.deepEqual(posts.map((post) => [post["channel"], post["thread_ts"]]), [[THREAD.channelId, THREAD.threadTs]]);
  assert.match(texts(posts)[0]!, /^TLSSN-29 still has no plan 16 minutes after it went to the planner\./);
  assert.match(texts(posts)[0]!, /`@factory retry TLSSN-29`/);
  assert.equal(record(rows), undefined);
  assert.equal(rows[`announced/${KEY}:hop-plan:c1`] !== undefined, true, "the line is claimed per entry");
  // ⏳ said the planner was running; the root now says a person should look.
  assert.deepEqual(reactions, [`reactions.add:warning@${THREAD.threadTs}`, `reactions.remove:hourglass_flowing_sand@${THREAD.threadTs}`]);
  assert.equal((rows[`reaction/${KEY}`] as Record<string, unknown>)["name"], "warning");

  assert.deepEqual(await sweepHopWatches({ host: h, now: at(2 * HOPS.plan.deadlineMs + SWEEP_GRACE_MS) }), []);
  assert.equal(posts.length, 1);
});

// TLSSN-45: the planner was still working at 15 minutes and the line said it
// "may never have started", with a feature/bug aside on a ticket triaged as a
// Bug. The line now reads the planner's `Planning started:` marker and the
// governing verdict's type.
function started(input: { id: string; minutesBeforeFire: number; fireAt: number; sessionId?: string }): Comment {
  const startedAt = new Date(T0.getTime() + input.fireAt - input.minutesBeforeFire * 60_000).toISOString();
  return { id: input.id, body: `Planning started: ${KEY}\nSession: ${input.sessionId ?? "ses_8de9de41"}\nStarted at: ${startedAt}\n\nThe planner is reading the code.` };
}

async function firePlan(comments: Comment[], options: { baseline?: string; fireMs?: number } = {}) {
  const { kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const tracker = jira({ status: "Triaged", comments: [] });
  const h = host(kv, tracker.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c45", at: T0, baselineCommentId: options.baseline ?? "10010" });
  tracker.state.comments = comments;
  const fired = await fireHopWatch({ host: h, now: at(options.fireMs ?? HOPS.plan.deadlineMs) }, { issueKey: KEY, hop: "plan", changelogId: "c45" });
  assert.equal(fired.result, "posted");
  return texts(posts)[0]!;
}

test("a plan hop whose planner is still running says so, with its minutes and the ticket's type, never 'may never have started'", async () => {
  const fireAt = HOPS.plan.deadlineMs;
  const bug = await firePlan([{ id: "10010", body: "Triage: bug\nSeverity: high\nType: Bug" }, started({ id: "10011", minutesBeforeFire: 15, fireAt })]);
  assert.match(bug, /^TLSSN-29 still has no plan 15 minutes after it went to the planner, but the planner is still running \(15 min\)\.\n/);
  assert.match(bug, /Confirming a bug in the code and planning its fix can take a while\./);
  assert.match(bug, /If nothing lands in about 25 minutes, say `@factory retry TLSSN-29` here to start a fresh run\.$/);
  assert.doesNotMatch(bug, /feature|never started|never reported/);

  const story = await firePlan([{ id: "10010", body: "Triage: feedback\nSeverity: medium\nType: Story" }, started({ id: "10011", minutesBeforeFire: 12, fireAt })]);
  assert.match(story, /still running \(12 min\)/);
  assert.match(story, /Planning a new feature against the code it joins can take a while\./);
  assert.doesNotMatch(story, /bug/i);

  const task = await firePlan([{ id: "10010", body: "Triage: bug\nSeverity: low\nType: Task" }, started({ id: "10011", minutesBeforeFire: 3, fireAt })]);
  assert.match(task, /Planning a change against the code it touches can take a while\./);
});

test("a plan hop with no Planning started marker since the entry says the planner never reported starting, and offers retry", async () => {
  const text = await firePlan([{ id: "10010", body: "Triage: bug\nSeverity: high\nType: Bug" }]);
  assert.match(text, /^TLSSN-29 still has no plan 15 minutes after it went to the planner\.\nThe planner never reported starting a run for it: the wake may have been lost\. Say `@factory retry TLSSN-29` here to start one\.$/);

  const older = await firePlan([started({ id: "10005", minutesBeforeFire: 20, fireAt: HOPS.plan.deadlineMs }), { id: "10010", body: "Triage: bug\nSeverity: high\nType: Bug" }]);
  assert.match(older, /never reported starting/, "a marker that started well before this entry is an earlier run's");
});

// Verifier finding: the desk arms the watch only after its Triaged announce
// settles, so the planner's marker can land first and sit below the watch's
// baseline comment id. It is still this entry's run.
test("a planner marker that lands before the plan hop watch is armed still counts as this entry's live run", async () => {
  const text = await firePlan(
    [{ id: "10010", body: "Triage: bug\nSeverity: high\nType: Bug" }, started({ id: "10011", minutesBeforeFire: 14, fireAt: HOPS.plan.deadlineMs })],
    { baseline: "10011" }
  );
  assert.match(text, /the planner is still running \(14 min\)/);
  assert.doesNotMatch(text, /never reported starting/);
});

test("a plan hop whose run started long ago and never ended counts it lost; one that ended counts as unknown", async () => {
  const fireMs = PLANNING_LIVE_MS + 5 * 60_000;
  const lost = await firePlan([{ id: "10010", body: "Triage: bug\nType: Bug" }, started({ id: "10011", minutesBeforeFire: PLANNING_LIVE_MS / 60_000 + 5, fireAt: fireMs })], { fireMs });
  assert.match(lost, /The planner started a run 45 minutes ago that never finished, so it was probably lost\. Say `@factory retry TLSSN-29` here to start a fresh run\.$/);
});

test("planningWork names the ticket's type from the verdict's Jira type, else its kind", () => {
  assert.equal(planningWork({ kind: "feedback", severity: "medium", issueType: "Bug" }), "bug");
  assert.equal(planningWork({ kind: "bug", severity: "medium", issueType: "Story" }), "feature");
  assert.equal(planningWork({ kind: "bug", severity: "medium", issueType: "Task" }), "task");
  assert.equal(planningWork({ kind: "bug", severity: "medium" }), "bug");
  assert.equal(planningWork({ kind: "feedback", severity: "medium" }), "feature");
  assert.equal(planningWork(undefined), undefined);
});

test("planningRun: live until an outcome or PLANNING_LIVE_MS; a Plan comment, a Needs info, or a Plan stopped ends it", () => {
  const now = new Date(T0.getTime() + 10 * 60_000);
  const marker = { id: "2", body: `Planning started: ${KEY}\nSession: ses_a\nStarted at: ${T0.toISOString()}` };
  const statuses = { todo: "To Do", triaged: "Triaged", planned: "Planned", approved: "Approved", inProgress: "In Progress", inReview: "In Review", done: "Done" };
  assert.deepEqual(planningRun({ comments: [marker], issueKey: KEY, statuses, now }), { state: "live", run: { sessionId: "ses_a", startedAt: T0.toISOString(), commentId: "2" }, minutes: 10, liveForMinutes: 30 });
  for (const end of [`Plan: ${KEY} Add payees\nSummary: x`, `Needs info: ${KEY}\nClaimed failure is not on o/r@main.`, `Plan stopped: ${KEY}\nWhy: boom`]) {
    assert.equal(planningRun({ comments: [marker, { id: "3", body: end }], issueKey: KEY, statuses, now }).state, "finished", end);
  }
  assert.equal(planningRun({ comments: [marker], issueKey: "TLSSN-2", statuses, now }).state, "not_started", "another ticket's marker");
  assert.equal(planningRun({ comments: [marker], issueKey: KEY, statuses, now, since: new Date(T0.getTime() + 5 * 60_000) }).state, "not_started", "started before this entry, past the skew allowance");
  assert.equal(planningRun({ comments: [marker], issueKey: KEY, statuses, now, since: new Date(T0.getTime() + 60_000) }).state, "live", "within the skew allowance");
  assert.equal(planningRun({ comments: [{ ...marker, body: marker.body.replace(/Started at: .*/, "Started at: soon") }], issueKey: KEY, statuses, now }).state, "not_started", "an unreadable start is no marker");
});

// A Jira-filed ticket's thread (the intake root the desk opened) has no
// Slack filer, and the desk refuses `retry KEY` there as unbound. Its stuck
// line names the Jira move retry would have made, like the outcome lines do.
test("a Jira-filed ticket's stuck line names the board move, never a retry the desk would refuse", async () => {
  const JIRA_ROOT = { [`ticket/${KEY}`]: { ...THREAD, root: "jira" } };
  const cases = [
    { hop: "triage", status: "To Do", comments: [] as Comment[], expect: /Move TLSSN-29 to Triaged in Jira to send it to the planner without a triage verdict\.$/ },
    { hop: "plan", status: "Triaged", comments: [], expect: /Move TLSSN-29 to To Do and back to Triaged in Jira to start one\.$/ },
    { hop: "launch", status: "Approved", comments: [], expect: /Move TLSSN-29 to Planned and back to Approved in Jira to send the approval to the worker again\. The worker usually reuses an agent that already started, but cannot guarantee it\.$/ },
    {
      hop: "launch",
      status: "Approved",
      comments: [{ id: "30001", body: "Implementing: https://cursor.com/agents/bc-123" }],
      expect: /Move TLSSN-29 to Planned and back to Approved in Jira to send the approval again; the worker moves the ticket and links the agent it already started\.$/,
    },
  ] as const;
  for (const { hop, status, comments, expect } of cases) {
    const { kv } = memoryKv(JIRA_ROOT);
    const posts: Record<string, unknown>[] = [];
    const reactions: string[] = [];
    const tracker = jira({ status });
    const h = host(kv, tracker.mcp, posts, undefined, reactions);
    await armHopWatch(h, { issueKey: KEY, hop, changelogId: "e1", at: T0, baselineCommentId: "0" });
    tracker.state.comments = [...comments];
    const fired = await fireHopWatch({ host: h, now: at(HOPS[hop].deadlineMs) }, { issueKey: KEY, hop, changelogId: "e1" });
    assert.equal(fired.result, "posted", hop);
    assert.match(texts(posts)[0]!, expect, hop);
    assert.doesNotMatch(texts(posts)[0]!, /retry/, hop);
    assert.deepEqual(reactions, [`reactions.add:warning@${THREAD.threadTs}`], hop);
  }

  const { kv } = memoryKv(JIRA_ROOT);
  const posts: Record<string, unknown>[] = [];
  const h = host(kv, jira({ unreadable: true }).mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "e1", at: T0, baselineCommentId: "0" });
  let now = HOPS.plan.deadlineMs;
  for (let attempt = 0; attempt < MAX_UNREAD; attempt += 1, now += UNREAD_RETRY_MS) {
    await fireHopWatch({ host: h, now: at(now) }, { issueKey: KEY, hop: "plan", changelogId: "e1" });
  }
  assert.match(texts(posts)[0]!, /Check the ticket in Jira\. If it has not moved, move TLSSN-29 to To Do and back to Triaged in Jira\.$/);
});

test("an overdue hop posts nothing when the ticket moved on or triage's verdict is one the planner skips", async () => {
  for (const [tracker, result] of [
    [jira({ status: "Planned" }), "moved_on"],
    [jira({ status: "Triaged", comments: [{ id: "1", body: "Triage: question\nSeverity: low" }] }), "gated"],
  ] as const) {
    const { rows, kv } = memoryKv();
    const posts: Record<string, unknown>[] = [];
    const h = host(kv, tracker.mcp, posts);
    await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 });
    const fired = await fireHopWatch({ host: h, now: at(HOPS.plan.deadlineMs + 1) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
    assert.equal(fired.result, result);
    assert.equal(posts.length, 0);
    assert.equal(record(rows), undefined);
  }
});

test("a launch hop still Approved says no implementation started, or names the agent whose move to In Progress did not land", async () => {
  const cases = [
    { comments: [] as Comment[], expect: /^TLSSN-29 was approved 7 minutes ago, but no implementation has started\.\n.*its own relaunch has not landed.*usually reuses an agent that already started, but cannot guarantee it/s },
    {
      comments: [{ id: "30001", body: "Implementing: https://cursor.com/agents/bc-123" }],
      expect: /^TLSSN-29 is still Approved 7 minutes after the approval, though implementation started: https:\/\/cursor\.com\/agents\/bc-123\n.*did not land/s,
    },
  ];
  for (const { comments, expect } of cases) {
    const { kv } = memoryKv();
    const posts: Record<string, unknown>[] = [];
    const tracker = jira({ status: "Approved", comments: [] });
    const h = host(kv, tracker.mcp, posts);
    await armHopWatch(h, { issueKey: KEY, hop: "launch", changelogId: "6001", at: T0 });
    tracker.state.comments = comments;
    const fired = await fireHopWatch({ host: h, now: at(HOPS.launch.deadlineMs) }, { issueKey: KEY, hop: "launch", changelogId: "6001" });
    assert.equal(fired.result, "posted");
    assert.match(texts(posts)[0]!, expect);
  }
});

test("an outcome comment the comment rule never delivered is announced by the fire; one from before the entry is not replayed", async () => {
  const { kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const tracker = jira({ status: "Approved", comments: [{ id: "30000", body: "Launch failed: quota exceeded. Moving the card to Approved again retries." }] });
  const h = host(kv, tracker.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "launch", changelogId: "6001", at: T0 });
  const old = await fireHopWatch({ host: h, now: at(HOPS.launch.deadlineMs) }, { issueKey: KEY, hop: "launch", changelogId: "6001" });
  assert.equal(old.result, "posted");
  assert.match(texts(posts)[0]!, /no implementation has started/, "the earlier failure is not this approval's outcome");

  const fresh = memoryKv();
  const freshPosts: Record<string, unknown>[] = [];
  const plan = { id: "30001", body: "Plan: TLSSN-29\nSummary: add payees" };
  const freshTracker = jira({ status: "Approved", comments: [plan] });
  const h2 = host(fresh.kv, freshTracker.mcp, freshPosts);
  await armHopWatch(h2, { issueKey: KEY, hop: "launch", changelogId: "6002", at: T0 });
  assert.equal(fresh.rows[hopWatchKey(KEY)] !== undefined && (fresh.rows[hopWatchKey(KEY)] as HopWatch).baselineCommentId, "30001");
  freshTracker.state.comments = [plan, { id: "30005", body: "Launch failed: quota exceeded. Moving the card to Approved again retries." }];
  const outcome = await fireHopWatch({ host: h2, now: at(HOPS.launch.deadlineMs) }, { issueKey: KEY, hop: "launch", changelogId: "6002" });
  assert.equal(outcome.result, "outcome");
  assert.equal(freshPosts.length, 1);
  assert.doesNotMatch(texts(freshPosts)[0]!, /no implementation has started/);
  assert.equal(fresh.rows[`announced/${KEY}:Launch failed:30005`] !== undefined, true, "claimed like the comment rule would, so a late delivery stays quiet");
});

test("an unreadable status is retried, then the thread hears that the desk cannot tell", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const h = host(kv, jira({ unreadable: true }).mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "0" });
  let now = HOPS.plan.deadlineMs;
  for (let attempt = 1; attempt < MAX_UNREAD; attempt += 1) {
    const fired = await fireHopWatch({ host: h, now: at(now) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
    assert.deepEqual(fired, { issueKey: KEY, hop: "plan", result: "unread", rescheduleMs: UNREAD_RETRY_MS });
    assert.equal(record(rows)?.unread, attempt);
    now += UNREAD_RETRY_MS;
  }
  const last = await fireHopWatch({ host: h, now: at(now) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.equal(last.result, "posted");
  assert.match(texts(posts)[0]!, /^The desk could not read TLSSN-29 from Jira for 25 minutes, so it cannot tell whether the planner finished\./);
  assert.equal(record(rows), undefined);
});

// The planner's marker is on these tickets, so the plan hop's 4-minute start
// check (plan-start-watch.test.ts) finds the run started and the deadline
// line under test is the only one.
const RUNNING = { status: "Triaged", comments: [started({ id: "10011", minutesBeforeFire: 0, fireAt: 0 })] };

test("the sweep fires a record whose reminder could not be armed, and leaves an armed one to its reminder until the grace passes", async () => {
  const unarmed = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const h = host(unarmed.kv, jira(RUNNING).mcp, posts, reminders({ createThrows: true }));
  const armed = await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 });
  assert.deepEqual(armed, { armed: true, reminder: "failed" });
  assert.equal(record(unarmed.rows)?.reminderId, undefined);
  assert.deepEqual(await sweepHopWatches({ host: h, now: at(HOPS.plan.deadlineMs - 1) }), []);
  const swept = await sweepHopWatches({ host: h, now: at(HOPS.plan.deadlineMs) });
  assert.deepEqual(swept.map((fire) => fire.result), ["posted"]);
  assert.deepEqual(unarmed.rows[HOP_WATCH_INDEX], []);

  const withReminder = memoryKv();
  const h2 = host(withReminder.kv, jira(RUNNING).mcp, [], reminders());
  await armHopWatch(h2, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 });
  assert.deepEqual(await sweepHopWatches({ host: h2, now: at(HOPS.plan.deadlineMs + SWEEP_GRACE_MS - 1) }), []);
  assert.deepEqual((await sweepHopWatches({ host: h2, now: at(HOPS.plan.deadlineMs + SWEEP_GRACE_MS) })).map((fire) => fire.result), ["posted"]);
});

test("every hop-watch schedule run logs exactly one line, idle, inside a deadline, or firing", async () => {
  const { kv } = memoryKv();
  const h = host(kv, jira(RUNNING).mcp, [], reminders({ createThrows: true }));
  const run = async (nowMs: number) => {
    const lines: string[] = [];
    const returned = await runHopWatchSchedule({ host: h, now: at(nowMs) }, { log: (line) => void lines.push(line) });
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), returned);
    return returned;
  };
  assert.deepEqual(await run(0), { desk: "hop_watch", via: "schedule", due: 0, fired: 0 }, "no records: still one line");
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 });
  assert.deepEqual(await run(HOPS.plan.deadlineMs - 1), { desk: "hop_watch", via: "schedule", due: 0, fired: 0 });
  assert.deepEqual(await run(HOPS.plan.deadlineMs), {
    desk: "hop_watch",
    via: "schedule",
    due: 1,
    fired: 1,
    fires: [{ issueKey: KEY, hop: "plan", result: "posted" }],
  });
});

test("a hop-watch schedule run whose sweep throws still logs its one line, then rethrows", async () => {
  const lines: string[] = [];
  const sweep = async (_ctx: unknown, tally: { due: number }) => {
    tally.due += 2;
    throw new Error("kv down");
  };
  await assert.rejects(
    runHopWatchSchedule({ host: host(memoryKv().kv, jira({}).mcp, [], reminders()), now: at(0) }, { sweep, log: (line) => void lines.push(line) }),
    /kv down/
  );
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ desk: "hop_watch", via: "schedule", due: 2, fired: 0, error: "kv down" }]);
});

test("a sweep that throws in the index prune after a fire posted logs fired: 1 with the error, then rethrows", async () => {
  const saved = process.env.FACTORY_INDEX_MERGE;
  process.env.FACTORY_INDEX_MERGE = "off";
  try {
    const memory = memoryKv();
    const posts: Record<string, unknown>[] = [];
    // The run started, so the 4-minute start check (also due by now) posts nothing of its own.
    const h = host(memory.kv, jira({ status: "Triaged", comments: [started({ id: "10011", minutesBeforeFire: 0, fireAt: 0 })] }).mcp, posts, reminders({ createThrows: true }));
    await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10011" });
    const put = memory.kv.put;
    memory.kv.put = async (key: string, value: unknown) => {
      if (key === HOP_WATCH_INDEX) throw new Error("index put failed");
      return put(key, value);
    };
    const lines: string[] = [];
    await assert.rejects(runHopWatchSchedule({ host: h, now: at(HOPS.plan.deadlineMs) }, { log: (line) => void lines.push(line) }), /index put failed/);
    assert.equal(posts.length, 1, "the fire posted its line before the prune threw");
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ desk: "hop_watch", via: "schedule", due: 1, fired: 1, error: "index put failed" }]);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_INDEX_MERGE;
    else process.env.FACTORY_INDEX_MERGE = saved;
  }
});

test("the hop-watch schedule's run is runHopWatchSchedule, so a hosted fire logs its line", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    const schedule = (await import("../schedules/hop-watch.js")).default as unknown as { run: (input: { host: unknown }) => Promise<void> };
    await schedule.run({ host: host(memoryKv({}).kv, jira({}).mcp, [], reminders()) });
  } finally {
    console.log = log;
  }
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ desk: "hop_watch", via: "schedule", due: 0, fired: 0 }]);
});

test("a ticket with no Slack thread arms nothing", async () => {
  const { rows, kv } = memoryKv({});
  const rem = reminders();
  assert.deepEqual(await armHopWatch(host(kv, jira({}).mcp, [], rem), { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 }), { armed: false, reason: "no_thread" });
  assert.deepEqual(rows, {});
  assert.equal(rem.created.length, 0);
});

test("the reminder handler is discovered under its stem and stops or reschedules as the fire says", async () => {
  const project = await loadAgentProject(fileURLToPath(new URL("../..", import.meta.url)));
  assert.deepEqual(project.diagnostics, []);
  assert.deepEqual((project.reminders ?? []).map((reminder) => reminder.name).sort(), [HOP_WATCH_HANDLER, PLAN_START_HANDLER]);
  assert.deepEqual(project.schedules.map((schedule) => schedule.name).sort(), ["hop-watch"]);

  const { kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const tracker = jira({ unreadable: true });
  const h = host(kv, tracker.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: new Date(Date.now() - HOPS.plan.deadlineMs), baselineCommentId: "0" });
  const context = (args: Record<string, unknown>) => ({ args, host: h, mcp: tracker.mcp }) as never;
  assert.deepEqual(await hopWatchReminder.run(context({ issueKey: KEY, hop: "plan", changelogId: "c1" })), { action: "skip", reschedule: { delay: UNREAD_RETRY_MS } });
  tracker.state.unreadable = false;
  tracker.state.status = "Planned";
  assert.deepEqual(await hopWatchReminder.run(context({ issueKey: KEY, hop: "plan", changelogId: "c1" })), { action: "stop" });
  assert.deepEqual(await hopWatchReminder.run(context({ hop: "nope" })), { action: "stop" });
  assert.equal(posts.length, 0);
});

// The connector here has no comment tool, so the desk's Triage: comment and
// Triaged move cannot land: the ticket stays in To Do and the triage hop is watched.
test("file_ticket arms the triage hop once the thread is bound when its own triage did not reach Triaged", async () => {
  const { rows, kv } = memoryKv({});
  const rem = reminders();
  const context = {
    session: {
      id: "ses_1",
      channelId: "slack",
      mode: "chat",
      purpose: "live",
      auth: { authenticator: "slack", principalId: "slack:T:thread", principalType: "user", attributes: { channel_id: THREAD.channelId, thread_ts: THREAD.threadTs } },
      continuationKey: `${THREAD.channelId}:${THREAD.threadTs}`,
    },
    now: () => T0,
    host: {
      kv,
      reminders: rem.api,
      slack: { getClient: async () => ({ chat: { postMessage: async () => ({ ok: true, ts: "1758510001.000100" }) } }) },
      mcp: {
        names: () => ["tracker"],
        listTools: async () => [{ name: "createJiraIssue", inputSchema: { type: "object", properties: { projectKey: { type: "string" }, summary: { type: "string" }, description: { type: "string" }, issueTypeName: { type: "string" } } } }],
        callTool: async (): Promise<HostMcpCallResult> => ({ content: [{ type: "text", text: JSON.stringify({ key: KEY }) }] }),
      },
    },
  };
  const result = (await fileTicket.execute!({ title: "Add payees", description: "Asked by Alice.", kind: "feedback" } as never, context as never)) as Record<string, unknown>;
  assert.equal(result["threadBound"], true);
  assert.deepEqual(record(rows), { hop: "triage", since: T0.toISOString(), dueAt: new Date(T0.getTime() + HOPS.triage.deadlineMs).toISOString(), changelogId: "filed", baselineCommentId: "0", reminderId: "rem_1" });
  assert.deepEqual(rem.created[0]?.args, { issueKey: KEY, hop: "triage", changelogId: "filed" });
});

test("a filed ticket still in To Do past the triage deadline offers retry; the Triaged move clears it first", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const tracker = jira({ status: "To Do" });
  const h = host(kv, tracker.mcp, posts, reminders());
  await armHopWatch(h, { issueKey: KEY, hop: "triage", changelogId: "filed", at: T0, baselineCommentId: "0" });
  const fired = await fireHopWatch({ host: h, now: at(HOPS.triage.deadlineMs) }, { issueKey: KEY, hop: "triage", changelogId: "filed" });
  assert.equal(fired.result, "posted");
  assert.match(texts(posts)[0]!, /^TLSSN-29 has not been triaged 15 minutes after it was filed\.\n.*`@factory retry TLSSN-29`/s);

  await armHopWatch(h, { issueKey: KEY, hop: "triage", changelogId: "filed2", at: T0, baselineCommentId: "0" });
  tracker.state.status = "Triaged";
  await deliver(moved("To Do", "Triaged", "5001"), h);
  assert.equal(record(rows)?.hop, "plan", "the plan hop replaces the triage hop");
});

// Verifier finding: plan-declined stayed on a ticket dragged out of Planned in Jira.
test("any status move the desk sees out of Planned takes the plan-declined label off", async () => {
  for (const [from, to, changelog] of [["Planned", "Approved", "7001"], ["Planned", "Triaged", "7002"], ["Planned", "Done", "7003"], ["Planned", "To Do", "7004"], ["Planned", "Blocked", "7005"]] as const) {
    const { rows, kv } = memoryKv({ ...BOUND, [planDeclinedKey(KEY)]: { at: T0.toISOString() } });
    const tracker = jira({ status: to });
    await deliver(moved(from, to, changelog), host(kv, tracker.mcp, []));
    assert.deepEqual(tracker.state.edits, [{ labels: [{ remove: "plan-declined" }] }], to);
    assert.equal(rows[planDeclinedKey(KEY)], undefined, to);
  }
});

// Verifier round 4: a late Planned → X redelivery after a replan and a fresh
// decline cleared the new plan-declined label.
test("a stale or older move out of Planned does not clear a newer decline", async () => {
  const late = moved("Planned", "To Do", "7101");
  late.issue.fields.status.name = "Planned";
  const replayed = moved("Planned", "To Do", `${KEY}:To Do:2026-09-25T23:40:00.0+0000`);
  for (const [name, body] of [["ticket is Planned again", late], ["move predates the decline", replayed]] as const) {
    const { rows, kv } = memoryKv({ ...BOUND, [planDeclinedKey(KEY)]: { at: T0.toISOString() } });
    const tracker = jira({ status: body.issue.fields.status.name });
    await deliver(body, host(kv, tracker.mcp, []));
    assert.deepEqual(tracker.state.edits, [], name);
    assert.notEqual(rows[planDeclinedKey(KEY)], undefined, name);
  }
});

test("a move within the clock skew of the decline still clears it: the host and Jira clocks may disagree", async () => {
  const { rows, kv } = memoryKv({ ...BOUND, [planDeclinedKey(KEY)]: { at: T0.toISOString() } });
  const tracker = jira({ status: "To Do" });
  await deliver(moved("Planned", "To Do", `${KEY}:To Do:2026-09-25T23:49:00.0+0000`), host(kv, tracker.mcp, []));
  assert.deepEqual(tracker.state.edits, [{ labels: [{ remove: "plan-declined" }] }]);
  assert.equal(rows[planDeclinedKey(KEY)], undefined);
});

test("the plan hop's entry time is Jira's timestamp when it is earlier than receipt, else receipt", () => {
  const received = new Date("2026-09-28T07:30:40Z");
  assert.equal(entryTime({ body: { timestamp: Date.parse("2026-09-28T07:30:27Z") }, received }).toISOString(), "2026-09-28T07:30:27.000Z");
  assert.equal(entryTime({ body: { timestamp: Date.parse("2026-09-28T07:31:00Z") }, received }), received, "a clock ahead of ours is not trusted");
  assert.equal(entryTime({ body: {}, received }), received);
  // The hosted Automation body has no timestamp; its changelog.id ends in {{issue.updated}}.
  assert.equal(entryTime({ body: { changelog: { id: "TLSSN-45:Triaged:2026-09-28T07:30:27.0+0000" } }, received }).toISOString(), "2026-09-28T07:30:27.000Z");
  assert.equal(entryTime({ body: { changelog: { id: "TLSSN-45:Triaged:2026-09-28T17:30:27.000+10:00" } }, received }).toISOString(), "2026-09-28T07:30:27.000Z");
  assert.equal(entryTime({ body: { changelog: { id: "5001" } }, received }), received, "a native changelog id carries no time");
  assert.equal(entryTime({ body: { changelog: { id: "TLSSN-45:Triaged:2026-09-28T07:40:00.0+0000" } }, received }), received, "nor is a later issue.updated trusted");
});

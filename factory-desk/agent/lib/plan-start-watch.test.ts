import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, ReminderCreateInput } from "@cursor/july";
import channel from "../channels/jira.js";
import planStartReminder from "../reminders/plan_start.js";
import {
  armHopWatch,
  fireHopWatch,
  firePlanStartCheck,
  HOPS,
  hopWatchKey,
  MAX_UNREAD,
  PLAN_START_DEADLINE_MS,
  PLAN_START_RETRY_LEASE_MS,
  PLAN_START_RETRY_TTL_MS,
  PLAN_START_UNREAD_RETRY_MS,
  planStartClaimKey,
  planStartRetryKey,
  startCheckFreesRetry,
  sweepHopWatches,
  type HopWatch,
} from "./hop-watch.js";
import { plannerSentKey } from "./plan-move.js";
import { hostedKv } from "./kv-backends.fixtures.js";
import { racingStores } from "./kv-race.fixtures.js";

// TLSSN-60: a hosted planner delivery handed a reused session by the control
// plane threw before its turn started and logged nothing, so no `Planning
// started:` marker landed and the thread heard nothing for 54 minutes until
// a planner redeploy. The plan hop's start check (hop-watch.ts
// firePlanStartCheck) reads the ticket 4 minutes after a Triaged entry: a run
// that left no sign of starting is re-sent to the planner once, with one
// line; the retried entry that does not start either gets the final line and
// no further move.

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

const KEY = "TLSSN-62";
const THREAD = { channelId: "C0123ABCD", threadTs: "1758510000.123456" };
const BOUND = { [`ticket/${KEY}`]: { ...THREAD, originatorUserId: "U0ALICE01" } };
const JIRA_ROOT = { [`ticket/${KEY}`]: { ...THREAD, root: "jira" } };
const T0 = new Date("2026-10-04T11:21:00Z");
const VERDICT = { id: "10010", body: "Triage: bug\nSeverity: high\nType: Bug" };
const at = (ms: number) => () => new Date(T0.getTime() + ms);
const CHECK_AT = PLAN_START_DEADLINE_MS;

type Comment = { id?: string; body: string };
type Kv = { get: (key: string) => Promise<unknown>; put: (key: string, value: unknown) => Promise<void>; delete: (key: string) => Promise<void> };

function memoryKv(initial: Record<string, unknown> = BOUND) {
  const rows: Record<string, unknown> = structuredClone(initial);
  return { rows, kv: { get: async (key: string) => rows[key] as never, put: async (key: string, value: unknown) => void (rows[key] = value), delete: async (key: string) => void delete rows[key] } };
}

/** A Jira whose transitions go to any status by name and change what it reads back; `failMoveTo` refuses one. */
function tracker(input: { status?: string; comments?: Comment[]; unreadable?: boolean; failMoveTo?: string } = {}) {
  const state = { status: input.status ?? "Triaged", comments: input.comments ?? [VERDICT], unreadable: input.unreadable === true, moves: [] as string[] };
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const statuses = ["To Do", "Triaged", "Planned", "Approved", "In Progress"];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (state.unreadable) return { content: [{ type: "text", text: "Jira is having a moment" }], isError: true };
      if (tool === "getJiraIssue") return json({ key: KEY, fields: { summary: "Payee search", status: { name: state.status }, comment: { comments: state.comments } } });
      if (tool === "getTransitionsForJiraIssue") return json({ transitions: statuses.map((name, i) => ({ id: String(i + 1), name, to: { name } })) });
      if (tool === "transitionJiraIssue") {
        const to = statuses[Number((args["transition"] as { id: string }).id) - 1]!;
        if (to === input.failMoveTo) return { content: [{ type: "text", text: "Transition is not valid" }], isError: true };
        state.moves.push(`${state.status} → ${to}`);
        state.status = to;
      }
      return json({});
    },
  };
  return { state, mcp };
}

function reminders() {
  const created: ReminderCreateInput[] = [];
  const cancelled: Array<{ id: string; reason?: string }> = [];
  return {
    created,
    cancelled,
    api: {
      create: async (input: ReminderCreateInput) => (created.push(input), { id: `rem_${created.length}` } as never),
      cancel: async (id: string, reason?: string) => (cancelled.push({ id, ...(reason === undefined ? {} : { reason }) }), undefined),
      list: async () => [],
      cancelForContinuation: async () => 0,
      rekeyContinuation: async () => 0,
      dispatch: async () => ({ reminderId: "", outcome: "noop" as const }),
    },
  };
}

function slack(posts: Record<string, unknown>[], reactions: string[] = []) {
  return {
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
  };
}

function host(kv: Kv, mcp: ReturnType<typeof tracker>["mcp"], posts: Record<string, unknown>[], rem?: ReturnType<typeof reminders>, reactions: string[] = []) {
  return { kv: kv as never, mcp, ...(rem === undefined ? {} : { reminders: rem.api }), slack: slack(posts, reactions) };
}

const texts = (posts: Record<string, unknown>[]) => posts.map((post) => String(post["text"]));
const record = (rows: Record<string, unknown>) => rows[hopWatchKey(KEY)] as HopWatch | undefined;
const marker = (startedAt: Date, id = "10011"): Comment => ({ id, body: `Planning started: ${KEY}\nSession: ses_fb22df82\nStarted at: ${startedAt.toISOString()}\n\nThe planner is reading the code.` });

async function captured<T>(run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const original = console.log;
  const lines: Record<string, unknown>[] = [];
  console.log = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])));
    } catch {
      // not a structured line
    }
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.log = original;
  }
}

type Handler = (request: Request, ctx: unknown) => Promise<Response>;
const handler = (channel as unknown as { routes: Array<{ handler: Handler }> }).routes[0]!.handler;

async function deliver(body: unknown, h: ReturnType<typeof host>) {
  const raw = JSON.stringify(body);
  const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.JIRA_WEBHOOK_SECRET).update(raw).digest("hex")}` } });
  const background: Promise<unknown>[] = [];
  await captured(() => handler(request, { host: h, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body }));
  await Promise.all(background);
}

function moved(from: string, to: string, id: string) {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { key: KEY, fields: { summary: "Payee search", status: { name: to }, project: { key: "TLSSN" } } },
    changelog: { id, items: [{ field: "status", fromString: from, toString: to }] },
  };
}

test("healthy: the planner's marker landed before the check, so nothing is posted or moved and the run counts as started", async () => {
  const { rows, kv } = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "done", owner: "old", at: new Date(T0.getTime() - 60_000).toISOString(), changelogId: "c0" } });
  const posts: Record<string, unknown>[] = [];
  const jira = tracker({ comments: [VERDICT, marker(new Date(T0.getTime() + 20_000))] });
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal(record(rows)?.startDueAt, new Date(T0.getTime() + PLAN_START_DEADLINE_MS).toISOString());

  const fired = await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.deepEqual(fired, { issueKey: KEY, changelogId: "c1", result: "started" });
  assert.deepEqual([posts, jira.state.moves], [[], []]);
  assert.equal(record(rows)?.startCheck, "started");
  assert.equal(rows[planStartRetryKey(KEY)], undefined, "a start seen gives the one re-send back");

  // A second fire for the same entry (the sweep after the reminder) is a no-op.
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT + 1) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "already_checked");
});

// Verifier finding: the desk arms the watch after its Triaged announce settles,
// so the marker can sit below the baseline comment id; it is still this entry's.
test("a marker that landed before the watch was armed, or a plan or outcome above the baseline, all count as started", async () => {
  const cases: Array<{ comments: Comment[]; baseline: string }> = [
    { comments: [VERDICT, marker(new Date(T0.getTime() - 30_000), "10011")], baseline: "10011" },
    { comments: [VERDICT, { id: "10012", body: `Plan: ${KEY} Payee search\nSummary: add the index` }], baseline: "10010" },
    { comments: [VERDICT, { id: "10012", body: `Needs info: ${KEY}\nWhich build?` }], baseline: "10010" },
    { comments: [VERDICT, { id: "10012", body: `Plan stopped: ${KEY}\nWhy: boom` }], baseline: "10010" },
  ];
  for (const { comments, baseline } of cases) {
    const { kv } = memoryKv();
    const posts: Record<string, unknown>[] = [];
    const jira = tracker({ comments });
    const h = host(kv, jira.mcp, posts);
    await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: baseline });
    const fired = await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
    assert.equal(fired.result, "started", comments.at(-1)!.body);
    assert.deepEqual([posts, jira.state.moves], [[], []]);
  }

  // An outcome from before this entry is not this entry's.
  const { kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker({ comments: [VERDICT, { id: "10009", body: `Plan stopped: ${KEY}\nWhy: earlier` }] });
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "retried");
});

test("never started: one alert, one bounce to the planner, one retry record; the reminder and the sweep racing on it still make one", async () => {
  const { rows, kv } = memoryKv({ ...BOUND, [`reaction/${KEY}`]: { channel: THREAD.channelId, ts: THREAD.threadTs, name: "hourglass_flowing_sand", changelogId: "c1" } });
  const posts: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const jira = tracker();
  const rem = reminders();
  const h = host(kv, jira.mcp, posts, rem, reactions);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });

  const ctx = { host: h, now: at(CHECK_AT) };
  const [fromReminder, fromSweep] = await Promise.all([
    firePlanStartCheck(ctx, { issueKey: KEY, hop: "plan", changelogId: "c1" }),
    sweepHopWatches(ctx).then(() => "swept" as const),
  ]);
  assert.equal(fromSweep, "swept");
  assert.equal(fromReminder.result === "retried" || fromReminder.result === "duplicate" || fromReminder.result === "already_checked", true, fromReminder.result);
  assert.deepEqual(jira.state.moves, ["Triaged → To Do", "To Do → Triaged"], "exactly one bounce");
  assert.equal(jira.state.status, "Triaged");
  assert.equal(posts.filter((post) => /sent it to the planner again/.test(String(post["text"]))).length, 1, "exactly one alert");
  assert.deepEqual(posts.map((post) => [post["channel"], post["thread_ts"]])[0], [THREAD.channelId, THREAD.threadTs]);
  assert.equal(texts(posts)[0], `${KEY}'s planning hasn't started 4 minutes after it went to the planner, so I've sent it to the planner again.\nIf this run doesn't start either, I'll say so here.`);
  assert.doesNotMatch(texts(posts)[0]!, /session|July|mailbox/i);
  const retry = rows[planStartRetryKey(KEY)] as Record<string, unknown>;
  assert.equal(retry["state"], "done");
  assert.equal(retry["changelogId"], "c1");
  assert.equal(retry["outcome"], "retried");
  assert.notEqual(rows[planStartClaimKey({ issueKey: KEY, step: "alert", changelogId: "c1" })], undefined, "the alert is claimed per entry");
  assert.notEqual(rows[plannerSentKey(KEY)], undefined, "the re-send counts as a send, as retry's does");
  assert.equal(record(rows)?.startCheck, "retried");
  // Planning is running again: the planner crumb is up and the root keeps ⏳, not ⚠️.
  assert.ok(posts.some((post) => /planner is checking the code/.test(String(post["text"]))), "the planner crumb went up");
  assert.ok(!reactions.some((reaction) => reaction.startsWith("reactions.add:warning")), reactions.join(","));

  // Another check on the same entry does nothing more.
  assert.equal((await firePlanStartCheck(ctx, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "already_checked");
  assert.deepEqual(jira.state.moves.length, 2);
});

// Review finding: the re-send claim went done inside said() before the alert
// settled and before the record was marked, so a second fire for the same
// entry in that window (a late or twice-delivered reminder, the bounce
// webhook's admission sweep on another pod) read the done claim and posted
// the final line seconds after the alert, with ⚠️, while the re-sent run
// was starting.
test("a second fire for the entry just re-sent, inside the re-send's own window, is a duplicate: one bounce, one alert, no final line", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts, undefined, reactions);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  // The other fire runs from inside the first one's alert post, when the claim is already done and the record not yet marked by anyone else.
  let other: Promise<Awaited<ReturnType<typeof firePlanStartCheck>>> | undefined;
  const racing = {
    ...h,
    slack: {
      getClient: async () => {
        const client = await h.slack.getClient();
        return {
          ...client,
          chat: {
            postMessage: async (args: Record<string, unknown>) => {
              if (other === undefined && /sent it to the planner again/.test(String(args["text"]))) {
                other = firePlanStartCheck({ host: h, now: at(CHECK_AT + 2_000) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
              }
              return client.chat.postMessage(args);
            },
          },
        };
      },
    },
  };
  const first = await firePlanStartCheck({ host: racing, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.equal(first.result, "retried");
  assert.notEqual(other, undefined, "the race ran");
  assert.equal((await other!).result, "already_checked");
  assert.deepEqual(jira.state.moves, ["Triaged → To Do", "To Do → Triaged"], "exactly one bounce");
  assert.equal(posts.filter((post) => /sent it to the planner again/.test(String(post["text"]))).length, 1, "one alert");
  assert.deepEqual(
    texts(posts).filter((text) => /couldn't start/.test(text)),
    [],
    "no final line for the entry that was just re-sent"
  );
  assert.ok(!reactions.some((reaction) => reaction.startsWith("reactions.add:warning")), reactions.join(","));
  assert.equal(record(rows)?.startCheck, "retried");

  // The same, with the record not yet marked (the mark write lost): the done claim is this entry's own, never a final line.
  rows[hopWatchKey(KEY)] = { ...record(rows)!, startCheck: undefined };
  const again = await firePlanStartCheck({ host: h, now: at(CHECK_AT + 5_000) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.equal(again.result, "duplicate");
  assert.deepEqual(
    texts(posts).filter((text) => /couldn't start/.test(text)),
    []
  );
  assert.equal(jira.state.moves.length, 2);
});

// Bugbot: the re-send's own bounce parks the ticket in To Do for a few
// seconds. A concurrent check reading that (a late reminder beside the sweep,
// the To Do webhook's admission backstop, with the pre-move mark lost) took
// To Do for "moved on", cleared the re-send record, and let the bounced
// entry be re-sent again.
test("a concurrent check that reads To Do mid-bounce leaves the re-send record, so the successor gets the final line and not a second re-send", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "retried");
  assert.equal(jira.state.moves.length, 2);

  // Mid-bounce: the ticket reads To Do, and the entry's pre-move mark did not land.
  jira.state.status = "To Do";
  rows[hopWatchKey(KEY)] = { ...record(rows)!, startCheck: undefined };
  const midBounce = await firePlanStartCheck({ host: h, now: at(CHECK_AT + 1_000) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.equal(midBounce.result, "moved_on");
  assert.equal(record(rows)?.startCheck, "moved_on");
  assert.equal((rows[planStartRetryKey(KEY)] as Record<string, unknown>)["changelogId"], "c1", "the re-send record survives the bounce");
  assert.equal(jira.state.moves.length, 2);

  // The bounce lands and its Triaged entry is armed; when it never starts either, it hears the final line and nothing moves.
  jira.state.status = "Triaged";
  const T1 = CHECK_AT + 5_000;
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c2", at: new Date(T0.getTime() + T1), baselineCommentId: "10010" });
  const successor = await firePlanStartCheck({ host: h, now: at(T1 + CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c2" });
  assert.equal(successor.result, "final");
  assert.equal(jira.state.moves.length, 2, "no second re-send");
  assert.match(texts(posts).at(-1)!, /after one automatic retry/);

  // A status past the plan path still gives the one re-send back.
  const planned = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "done", owner: "o", at: T0.toISOString(), changelogId: "c0" } });
  const h2 = host(planned.kv, tracker({ status: "Planned" }).mcp, []);
  await armHopWatch(h2, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h2, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "moved_on");
  assert.equal(planned.rows[planStartRetryKey(KEY)], undefined);
});

// Bugbot: the record is marked `retried` before the move, so a request that
// died between that mark and the bounce's second move left the ticket in To
// Do with no alert, every later start fire at already_checked, the deadline
// fire reading To Do as "moved on", and `retry KEY` refused as inside the
// deadline: a ticket no one could unstick for 15 minutes, then never.
test("a re-send that died between its mark and its moves: the deadline fire still speaks for a ticket left in To Do, and a manual retry is let through", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  // The abort: the record says retried, the claim is pending, the ticket made it to To Do and no further; no alert posted.
  rows[hopWatchKey(KEY)] = { ...record(rows)!, startCheck: "retried" };
  rows[planStartRetryKey(KEY)] = { state: "pending", owner: "died", at: new Date(T0.getTime() + CHECK_AT).toISOString(), changelogId: "c1", since: T0.toISOString() };
  jira.state.status = "To Do";
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT + 60_000) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "already_checked");
  assert.ok(startCheckFreesRetry(record(rows)!), "retry-command does not wait this entry out");

  const deadline = await fireHopWatch({ host: h, now: at(HOPS.plan.deadlineMs) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.deepEqual(deadline, { issueKey: KEY, hop: "plan", result: "posted" });
  assert.match(texts(posts).at(-1)!, /^TLSSN-62 still has no plan 15 minutes after it went to the planner\.\nThe planner never reported starting a run for it.*Say `@factory retry TLSSN-62` here to start one\.$/s);
  assert.equal(record(rows), undefined);
  assert.deepEqual(jira.state.moves, [], "the deadline watch itself still never moves");

  // The same abort read after the second move landed but before the Triaged webhook armed the next entry: Triaged is the waited status as before.
  const landed = memoryKv();
  const landedJira = tracker();
  const h2 = host(landed.kv, landedJira.mcp, []);
  await armHopWatch(h2, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  landed.rows[hopWatchKey(KEY)] = { ...(landed.rows[hopWatchKey(KEY)] as HopWatch), startCheck: "retried" };
  assert.equal((await fireHopWatch({ host: h2, now: at(HOPS.plan.deadlineMs) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "posted");

  // Any other status is still a ticket that moved on, retried record or not.
  const planned = memoryKv();
  const h3 = host(planned.kv, tracker({ status: "Planned" }).mcp, []);
  await armHopWatch(h3, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  planned.rows[hopWatchKey(KEY)] = { ...(planned.rows[hopWatchKey(KEY)] as HopWatch), startCheck: "retried" };
  assert.equal((await fireHopWatch({ host: h3, now: at(HOPS.plan.deadlineMs) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "moved_on");
});

// Opus low: the successor is named on the record when its entry is armed;
// when that write was lost, the entry whose Triaged time is within the clock
// skew of the move is still the one the re-send produced.
test("without a named successor, an entry armed within the skew of the move still hears 'after one automatic retry'; a later one does not", async () => {
  const movedAt = new Date(T0.getTime() - 5_000).toISOString();
  for (const [sinceOffset, expectAuto] of [
    [0, true],
    [10 * 60_000, false],
  ] as const) {
    const { kv } = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "done", owner: "o", at: movedAt, changelogId: "c1", movedAt } });
    const posts: Record<string, unknown>[] = [];
    const jira = tracker();
    const h = host(kv, jira.mcp, posts);
    const since = new Date(T0.getTime() + sinceOffset);
    await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c2", at: since, baselineCommentId: "10010" });
    // The arm named c2 as successor; drop it to stand in for a lost write.
    const kvRows = (h.kv as unknown as { get: (key: string) => Promise<unknown> });
    const stored = (await kvRows.get(planStartRetryKey(KEY))) as Record<string, unknown>;
    delete stored["successor"];
    await (h.kv as unknown as { put: (key: string, value: unknown) => Promise<void> }).put(planStartRetryKey(KEY), stored);
    const fired = await firePlanStartCheck({ host: h, now: () => new Date(since.getTime() + CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c2" });
    assert.equal(fired.result, "final");
    assert.equal(/after one automatic retry/.test(texts(posts).at(-1)!), expectAuto, `${sinceOffset}: ${texts(posts).at(-1)}`);
    assert.deepEqual(jira.state.moves, []);
  }
});

test("two pods racing on a shared hosted-shaped kv move once and alert once", async () => {
  const shared = hostedKv();
  await shared.put(`ticket/${KEY}`, BOUND[`ticket/${KEY}`]);
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const arm = host(shared as never, jira.mcp, posts);
  await armHopWatch(arm, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  // Both pods read the retry record absent, and the second's put lands only after the first read it back.
  const [first, second] = racingStores(shared, { prefix: planStartRetryKey(KEY), after: "readBack", passReads: 1 });
  const results = await Promise.all([
    firePlanStartCheck({ host: host(first as never, jira.mcp, posts), now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" }),
    firePlanStartCheck({ host: host(second as never, jira.mcp, posts), now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" }),
  ]);
  assert.deepEqual(results.map((fire) => fire.result).sort(), ["duplicate", "retried"], JSON.stringify(results));
  assert.deepEqual(jira.state.moves, ["Triaged → To Do", "To Do → Triaged"]);
  assert.equal(posts.filter((post) => /sent it to the planner again/.test(String(post["text"]))).length, 1);
});

test("the retried entry that never starts gets one final line and no second move; its 15-minute fire posts nothing; a manual retry is no longer waited out", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const jira = tracker();
  const rem = reminders();
  const h = host(kv, jira.mcp, posts, rem, reactions);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "retried");
  assert.equal(jira.state.moves.length, 2);

  // The bounce's Triaged webhook arms a new entry (channels/jira.ts → armHopWatch): it replaces the record, and the re-send record stands.
  const T1 = CHECK_AT + 5_000;
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c2", at: new Date(T0.getTime() + T1), baselineCommentId: "10010" });
  assert.equal(record(rows)?.changelogId, "c2");
  assert.equal(record(rows)?.startCheck, undefined);
  assert.notEqual(rows[planStartRetryKey(KEY)], undefined);

  const final = await firePlanStartCheck({ host: h, now: at(T1 + CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c2" });
  assert.equal(final.result, "final");
  assert.equal(jira.state.moves.length, 2, "no second move");
  const finals = texts(posts).filter((text) => /automatic retry/.test(text));
  assert.deepEqual(finals, [`${KEY}'s planning still hasn't started after one automatic retry, so planning couldn't start.\nThe next step is a planner redeploy or asking ops; say \`@factory retry ${KEY}\` here to try again.`]);
  assert.doesNotMatch(finals[0]!, /session|July|mailbox/i);
  assert.equal(record(rows)?.startCheck, "final");
  assert.ok(reactions.some((reaction) => reaction === `reactions.add:warning@${THREAD.threadTs}`), "the root says a person should look");
  assert.ok(startCheckFreesRetry(record(rows)!), "retry-command lets a manual retry through inside the deadline");

  // Any later check while the record stands posts the final line once and never retries again.
  assert.equal((await firePlanStartCheck({ host: h, now: at(T1 + CHECK_AT + 1) }, { issueKey: KEY, hop: "plan", changelogId: "c2" })).result, "already_checked");
  assert.equal(texts(posts).filter((text) => /automatic retry/.test(text)).length, 1);

  // The 15-minute deadline fire for the same entry is quiet: the final line already said it.
  const before = posts.length;
  const deadline = await fireHopWatch({ host: h, now: at(T1 + HOPS.plan.deadlineMs) }, { issueKey: KEY, hop: "plan", changelogId: "c2" });
  assert.deepEqual(deadline, { issueKey: KEY, hop: "plan", result: "suppressed" });
  assert.equal(posts.length, before);
  assert.equal(record(rows), undefined);
});

test("a run that started late after the final line is still news at the 15-minute fire", async () => {
  const { kv } = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "done", owner: "o", at: T0.toISOString(), changelogId: "c1" } });
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c2", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c2" })).result, "final");
  jira.state.comments = [VERDICT, marker(new Date(T0.getTime() + 6 * 60_000))];
  const deadline = await fireHopWatch({ host: h, now: at(HOPS.plan.deadlineMs) }, { issueKey: KEY, hop: "plan", changelogId: "c2" });
  assert.equal(deadline.result, "posted");
  assert.match(texts(posts).at(-1)!, /the planner is still running \(9 min\)/);
});

// Review finding: a check that died after its move but before the finish
// write left the claim pending; two minutes on, the next entry read it as no
// claim and re-sent again. A newer entry is proof the move landed.
test("an expired pending claim from an earlier entry counts as that entry's re-send: the next entry gets the final line, not a second bounce", async () => {
  const pendingAt = new Date(T0.getTime() - PLAN_START_RETRY_LEASE_MS - 1).toISOString();
  const { rows, kv } = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "pending", owner: "died", at: pendingAt, changelogId: "c1", since: pendingAt } });
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c2", at: T0, baselineCommentId: "10010" });
  const fired = await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c2" });
  assert.equal(fired.result, "final");
  assert.deepEqual(jira.state.moves, [], "no second bounce");
  assert.equal(texts(posts).filter((text) => /couldn't start/.test(text)).length, 1);
  assert.equal(record(rows)?.startCheck, "final");

  // The same entry's own expired claim (its check died before the move landed, or the move never happened) is taken over.
  const own = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "pending", owner: "died", at: pendingAt, changelogId: "c1", since: pendingAt } });
  const ownPosts: Record<string, unknown>[] = [];
  const ownJira = tracker();
  const h2 = host(own.kv, ownJira.mcp, ownPosts);
  await armHopWatch(h2, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h2, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "retried");
  assert.equal(ownJira.state.moves.length, 2);
  assert.equal((own.rows[planStartRetryKey(KEY)] as Record<string, unknown>)["state"], "done");
});

test("a finish write that is lost is warned about, never silent", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  // A rival overwrites the claim while the move runs, so the finish finds it no longer this check's.
  const callTool = jira.mcp.callTool;
  jira.mcp.callTool = async (connection, tool, args) => {
    if (tool === "transitionJiraIssue" && jira.state.moves.length === 0) rows[planStartRetryKey(KEY)] = { state: "pending", owner: "rival", at: T0.toISOString(), changelogId: "c1" };
    return callTool(connection, tool, args);
  };
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
  try {
    assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "retried");
  } finally {
    console.warn = warn;
  }
  const warned = warnings.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["site"] === "hop-watch.firePlanStartCheck.finishLease");
  assert.equal(warned.length, 1, warnings.join("\n"));
  assert.equal(warned[0]!["kv"], "warn");
  assert.match(String(warned[0]!["message"]), /not marked done: lost/);
});

// Review nit: a reminder the sweep armed rounds its delay to whole minutes
// and can fire up to 30 s early.
test("a fire before the start is due reschedules for the time left instead of checking early", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  const early = await firePlanStartCheck({ host: h, now: at(CHECK_AT - 30_000) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.deepEqual(early, { issueKey: KEY, changelogId: "c1", result: "early", rescheduleMs: 30_000 });
  assert.deepEqual([posts, jira.state.moves], [[], []]);
  assert.equal(record(rows)?.startCheck, undefined, "nothing decided yet");

  // The handler runs on the wall clock: an entry armed just now is not due for about 4 minutes, and the reminder is pushed to that.
  const fresh = memoryKv();
  const freshJira = tracker();
  const h2 = host(fresh.kv, freshJira.mcp, posts);
  await armHopWatch(h2, { issueKey: KEY, hop: "plan", changelogId: "c1", at: new Date(Date.now() - 30_000), baselineCommentId: "10010" });
  const run = (await planStartReminder.run({ args: { issueKey: KEY, hop: "plan", changelogId: "c1" }, host: h2, mcp: freshJira.mcp } as never)) as { action: string; reschedule?: { delay: number } };
  assert.equal(run.action, "skip");
  assert.ok(run.reschedule !== undefined && run.reschedule.delay > PLAN_START_DEADLINE_MS - 40_000 && run.reschedule.delay <= PLAN_START_DEADLINE_MS - 30_000, JSON.stringify(run));
  assert.deepEqual([posts, freshJira.state.moves], [[], []]);
});

test("a standing retry record older than its TTL is an old episode's, so the ticket gets its one automatic re-send again", async () => {
  const { rows, kv } = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "done", owner: "o", at: new Date(T0.getTime() - PLAN_START_RETRY_TTL_MS).toISOString(), changelogId: "c0" } });
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "retried");
  assert.equal(jira.state.moves.length, 2);
  assert.equal((rows[planStartRetryKey(KEY)] as Record<string, unknown>)["changelogId"], "c1");
});

test("no automatic re-send for a gated verdict, a ticket that moved on, or a Jira the desk cannot read", async () => {
  for (const [jira, result] of [
    [tracker({ comments: [{ id: "10010", body: "Triage: question\nSeverity: low" }] }), "gated"],
    [tracker({ status: "Planned" }), "moved_on"],
  ] as const) {
    const { rows, kv } = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "done", owner: "o", at: T0.toISOString(), changelogId: "c0" } });
    const posts: Record<string, unknown>[] = [];
    const h = host(kv, jira.mcp, posts);
    await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
    const fired = await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
    assert.equal(fired.result, result);
    assert.deepEqual([posts, jira.state.moves], [[], []], result);
    assert.equal(record(rows)?.startCheck, result);
    assert.equal(rows[planStartRetryKey(KEY)], undefined, `${result}: the one re-send is given back`);
  }

  // Unread: look again a minute later, MAX_UNREAD times, then give up for this entry. Never retry blind.
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker({ unreadable: true });
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  let now = CHECK_AT;
  for (let attempt = 1; attempt < MAX_UNREAD; attempt += 1, now += PLAN_START_UNREAD_RETRY_MS) {
    const fired = await firePlanStartCheck({ host: h, now: at(now) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
    assert.deepEqual(fired, { issueKey: KEY, changelogId: "c1", result: "unread", rescheduleMs: PLAN_START_UNREAD_RETRY_MS });
    assert.equal(record(rows)?.startUnread, attempt);
    assert.equal(record(rows)?.startDueAt, new Date(T0.getTime() + now + PLAN_START_UNREAD_RETRY_MS).toISOString());
  }
  assert.deepEqual(await firePlanStartCheck({ host: h, now: at(now) }, { issueKey: KEY, hop: "plan", changelogId: "c1" }), { issueKey: KEY, changelogId: "c1", result: "unread" });
  assert.equal(record(rows)?.startCheck, "unread");
  assert.deepEqual([posts, jira.state.moves], [[], []]);
  assert.equal(rows[planStartRetryKey(KEY)], undefined);
});

test("a re-send whose move fails says so, offers retry, and leaves no record that would block the next entry's one re-send", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const reactions: string[] = [];
  const jira = tracker({ failMoveTo: "To Do" });
  const h = host(kv, jira.mcp, posts, undefined, reactions);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  const fired = await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.equal(fired.result, "not_moved");
  assert.deepEqual(jira.state.moves, []);
  assert.deepEqual(texts(posts), [`${KEY}'s planning hasn't started 4 minutes after it went to the planner, and I could not send it to the planner again (failed).\nSay \`@factory retry ${KEY}\` here to try again.`]);
  assert.doesNotMatch(texts(posts)[0]!, /sent it to the planner again/);
  assert.equal(rows[planStartRetryKey(KEY)], undefined, "released: the next Triaged entry gets its own automatic re-send");
  assert.equal(record(rows)?.startCheck, "not_moved");
  assert.ok(startCheckFreesRetry(record(rows)!), "the retry it offers is not refused as within the deadline");
  assert.ok(reactions.includes(`reactions.add:warning@${THREAD.threadTs}`));

  // The alert already offered the retry; the 15-minute line for the same entry would only repeat it.
  const deadline = await fireHopWatch({ host: h, now: at(HOPS.plan.deadlineMs) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.deepEqual(deadline, { issueKey: KEY, hop: "plan", result: "suppressed" });
  assert.equal(posts.length, 1);
  assert.equal(record(rows), undefined);
});

// Review nit: after the final line a person's `retry` makes a new entry; if
// that one never starts either, "after one automatic retry" would name a
// re-send that entry did not get.
test("the final line names the automatic retry only on the entry that re-send produced; a later entry's is generic", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "retried");
  // The bounce's entry is named as the re-send's successor when it is armed.
  const T1 = CHECK_AT + 5_000;
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c2", at: new Date(T0.getTime() + T1), baselineCommentId: "10010" });
  assert.equal((rows[planStartRetryKey(KEY)] as Record<string, unknown>)["successor"], "c2");
  assert.equal((await firePlanStartCheck({ host: h, now: at(T1 + CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c2" })).result, "final");
  assert.match(texts(posts).at(-1)!, /^TLSSN-62's planning still hasn't started after one automatic retry, so planning couldn't start\.\n/);
  // A person's `retry` after that: a third entry, not the successor. Still no move, and no retry it did not get.
  const T2 = T1 + CHECK_AT + 60_000;
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c3", at: new Date(T0.getTime() + T2), baselineCommentId: "10010" });
  assert.equal((rows[planStartRetryKey(KEY)] as Record<string, unknown>)["successor"], "c2", "the successor is named once");
  assert.equal((await firePlanStartCheck({ host: h, now: at(T2 + CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c3" })).result, "final");
  assert.equal(texts(posts).at(-1), `${KEY}'s planning still hasn't started, so planning couldn't start.\nThe next step is a planner redeploy or asking ops; say \`@factory retry ${KEY}\` here to try again.`);
  assert.equal(jira.state.moves.length, 2, "one bounce in the whole episode");
  for (const text of texts(posts).filter((t) => /couldn't start/.test(t))) assert.equal(text.split("\n").length, 2);
});

test("a Jira-filed ticket's thread hears the board move, never a retry the desk would refuse", async () => {
  const notMoved = memoryKv(JIRA_ROOT);
  const posts: Record<string, unknown>[] = [];
  const h = host(notMoved.kv, tracker({ failMoveTo: "To Do" }).mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.match(texts(posts)[0]!, /\nMove TLSSN-62 to To Do and back to Triaged in Jira to try again\.$/);
  assert.doesNotMatch(texts(posts)[0]!, /retry/);

  const final = memoryKv({ ...JIRA_ROOT, [planStartRetryKey(KEY)]: { state: "done", owner: "o", at: T0.toISOString(), changelogId: "c1" } });
  const finalPosts: Record<string, unknown>[] = [];
  const h2 = host(final.kv, tracker().mcp, finalPosts);
  await armHopWatch(h2, { issueKey: KEY, hop: "plan", changelogId: "c2", at: T0, baselineCommentId: "10010" });
  await firePlanStartCheck({ host: h2, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c2" });
  assert.equal(texts(finalPosts)[0], `${KEY}'s planning still hasn't started after one automatic retry, so planning couldn't start.\nThe next step is a planner redeploy or asking ops; move TLSSN-62 to To Do and back to Triaged in Jira to try again.`);
  for (const text of [...texts(posts), ...texts(finalPosts)]) assert.equal(text.split("\n").length, 2, "two short lines");
});

test("a stale entry, a cleared record, and a Planned move: the check stops and the re-send record is given back", async () => {
  const { rows, kv } = memoryKv({ ...BOUND, [planStartRetryKey(KEY)]: { state: "done", owner: "o", at: T0.toISOString(), changelogId: "c1" } });
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const rem = reminders();
  const h = host(kv, jira.mcp, posts, rem);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c2", at: T0, baselineCommentId: "10010" });
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c1" })).result, "superseded");

  jira.state.status = "Planned";
  await deliver(moved("Triaged", "Planned", "c3"), h);
  assert.equal(record(rows), undefined);
  assert.equal(rows[planStartRetryKey(KEY)], undefined, "the ticket left the plan path");
  assert.deepEqual(
    rem.cancelled.map((cancelled) => cancelled.id).sort(),
    ["rem_1", "rem_2"],
    "both reminders are cancelled"
  );
  assert.equal((await firePlanStartCheck({ host: h, now: at(CHECK_AT) }, { issueKey: KEY, hop: "plan", changelogId: "c2" })).result, "superseded");
  assert.deepEqual(
    texts(posts).filter((text) => /planning/.test(text)),
    [],
    "only the plan post, no start-check line"
  );
});

test("the sweep runs a due start check whose reminder is missing or late, and leaves one inside its due time to its reminder", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const rem = reminders();
  const h = host(kv, jira.mcp, posts, rem);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  assert.equal(record(rows)?.startReminderId, "rem_2");
  // Due, with a reminder armed: the sweep waits out the grace.
  const early = await captured(() => sweepHopWatches({ host: h, now: at(CHECK_AT + 30_000) }));
  assert.deepEqual([early.result, jira.state.moves, early.lines.filter((line) => line["desk"] === "plan_start_watch")], [[], [], []]);
  const late = await captured(() => sweepHopWatches({ host: h, now: at(CHECK_AT + 60_000) }));
  assert.deepEqual(late.result, [], "the deadline is not due; only the start check ran");
  assert.deepEqual(late.lines.filter((line) => line["desk"] === "plan_start_watch"), [{ desk: "plan_start_watch", via: "sweep", issueKey: KEY, changelogId: "c1", result: "retried", posted: true }]);
  assert.deepEqual(jira.state.moves, ["Triaged → To Do", "To Do → Triaged"]);
  assert.equal(posts.filter((post) => /sent it to the planner again/.test(String(post["text"]))).length, 1);
});

test("a sweep that finds the start check and the deadline both overdue re-sends once and leaves the deadline line to the next pass", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker();
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0, baselineCommentId: "10010" });
  const first = await captured(() => sweepHopWatches({ host: h, now: at(HOPS.plan.deadlineMs + 60_000) }));
  assert.deepEqual(first.result, [], "no deadline fire in the pass that re-sent");
  assert.deepEqual(jira.state.moves, ["Triaged → To Do", "To Do → Triaged"]);
  assert.deepEqual(
    texts(posts).filter((text) => /still has no plan/.test(text)),
    [],
    "the alert is not followed by the stalled line it would repeat"
  );
  assert.equal(record(rows)?.startCheck, "retried");
  // The bounce's Triaged entry normally replaces the record within seconds; when it never arrives, the next pass fires the deadline as before.
  const second = await sweepHopWatches({ host: h, now: at(HOPS.plan.deadlineMs + 2 * 60_000) });
  assert.deepEqual(second.map((fire) => fire.result), ["posted"]);
  assert.equal(jira.state.moves.length, 2);
});

test("the plan_start reminder handler logs one line per fire and stops or reschedules as the check says", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const jira = tracker({ unreadable: true });
  const h = host(kv, jira.mcp, posts);
  await armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: new Date(Date.now() - PLAN_START_DEADLINE_MS), baselineCommentId: "10010" });
  const context = (args: Record<string, unknown>) => ({ args, host: h, mcp: jira.mcp }) as never;
  const unread = await captured(() => planStartReminder.run(context({ issueKey: KEY, hop: "plan", changelogId: "c1" })));
  assert.deepEqual(unread.result, { action: "skip", reschedule: { delay: PLAN_START_UNREAD_RETRY_MS } });
  assert.deepEqual(unread.lines, [{ desk: "plan_start_watch", via: "reminder", issueKey: KEY, changelogId: "c1", result: "unread", rescheduleMs: PLAN_START_UNREAD_RETRY_MS }]);
  // The unread look pushed the due time a minute out; the rescheduled reminder arrives then. Here, the clock does not move, so the record is.
  assert.equal(Date.parse(record(rows)!.startDueAt!) > Date.now(), true);
  rows[hopWatchKey(KEY)] = { ...record(rows)!, startDueAt: new Date(Date.now() - 1).toISOString() };
  jira.state.unreadable = false;
  jira.state.comments = [VERDICT, marker(new Date())];
  const started = await captured(() => planStartReminder.run(context({ issueKey: KEY, hop: "plan", changelogId: "c1" })));
  assert.deepEqual(started.result, { action: "stop" });
  assert.deepEqual(started.lines, [{ desk: "plan_start_watch", via: "reminder", issueKey: KEY, changelogId: "c1", result: "started" }]);
  assert.deepEqual(await planStartReminder.run(context({ issueKey: KEY, hop: "launch", changelogId: "c1" })), { action: "stop" });
  assert.deepEqual(posts, []);
});

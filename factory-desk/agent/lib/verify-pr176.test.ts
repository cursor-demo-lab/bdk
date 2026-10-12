import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, ReminderCreateInput } from "@cursor/july";
import { withBackstopSweep } from "../channels/slack.js";
import { armHopWatch, BACKSTOP_SWEEP_EVERY_MS, BACKSTOP_SWEEP_KEY, backstopSweep, fireHopWatch, HOP_WATCH_INDEX, HOPS, hopWatchKey, sweepHopWatches } from "./hop-watch.js";
import { planDecline } from "./plan-decline.js";

// Verifier edge cases for PR 176: the throttled backstop sweep and the
// Jira-recorded plan decline.

const ENV = { FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_DESK_CLAIM_SETTLE_MS: "5" } as const;
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
const T0 = new Date("2026-09-25T23:50:00Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);

type Comment = { id?: string | number; body: unknown };
// The planner's start marker: the plan hop's 4-minute start check (plan-start-watch.test.ts) then finds the run started and posts nothing of its own.
const STARTED: Comment = { id: "6", body: `Planning started: ${KEY}\nSession: ses_8de9de41\nStarted at: ${T0.toISOString()}` };

function countingKv(initial: Record<string, unknown> = { [`ticket/${KEY}`]: { ...THREAD, originatorUserId: "U0ALICE01" } }) {
  const rows: Record<string, unknown> = structuredClone(initial);
  const reads: string[] = [];
  return {
    rows,
    reads,
    kv: {
      get: async (key: string) => (reads.push(key), structuredClone(rows[key]) as never),
      put: async (key: string, value: unknown) => void (rows[key] = structuredClone(value)),
      delete: async (key: string) => void delete rows[key],
    },
  };
}

function tracker(state: { status: string; comments: Comment[]; unreadable?: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    mcp: {
      names: () => ["tracker"],
      listTools: async () => [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } }],
      callTool: async (_c: string, tool: string): Promise<HostMcpCallResult> => {
        calls.push(tool);
        if (state.unreadable === true) return { content: [{ type: "text", text: "Jira is having a moment" }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify({ key: KEY, fields: { status: { name: state.status }, comment: { comments: state.comments } } }) }] };
      },
    },
  };
}

function reminders() {
  const created: ReminderCreateInput[] = [];
  return {
    created,
    api: {
      create: async (input: ReminderCreateInput) => (created.push(input), { id: `rem_${created.length}` } as never),
      cancel: async () => undefined,
      list: async () => [],
      cancelForContinuation: async () => 0,
      rekeyContinuation: async () => 0,
      dispatch: async () => ({ reminderId: "", outcome: "noop" as const }),
    },
  };
}

function host(kv: ReturnType<typeof countingKv>["kv"], posts: Record<string, unknown>[], mcp: ReturnType<typeof tracker>["mcp"], rem?: ReturnType<typeof reminders>) {
  return {
    kv,
    mcp,
    ...(rem === undefined ? {} : { reminders: rem.api }),
    slack: {
      getClient: async () => ({
        chat: { postMessage: async (args: Record<string, unknown>) => (posts.push(args), { ok: true, ts: `1758510002.00${String(posts.length).padStart(4, "0")}` }) },
        apiCall: async () => ({ ok: true }),
      }),
    },
  };
}

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.error = error;
  }
};

// --- Sweep -----------------------------------------------------------------

test("sweep: two admissions in the same window, concurrently, run one sweep", async () => {
  const { kv } = countingKv({ [HOP_WATCH_INDEX]: [KEY] });
  let sweeps = 0;
  const sweep = async () => (sweeps += 1, await new Promise((r) => setTimeout(r, 20)), []);
  const h = host(kv, [], tracker({ status: "Triaged", comments: [] }).mcp);
  const results = await Promise.all([backstopSweep({ host: h, now: at(0) }, { sweep }), backstopSweep({ host: h, now: at(1) }, { sweep })]);
  assert.equal(sweeps, 1, JSON.stringify(results));
});

test("sweep: one hanging past its cap returns, leaves a finished lease, and the next window sweeps", async () => {
  const { rows, kv } = countingKv({ [HOP_WATCH_INDEX]: [KEY] });
  const h = host(kv, [], tracker({ status: "Triaged", comments: [] }).mcp);
  const started = Date.now();
  const hung = await quiet(() => backstopSweep({ host: h, now: at(0) }, { sweep: () => new Promise(() => {}), timeoutMs: 50 }));
  assert.deepEqual(hung, { swept: false, why: "timeout" });
  assert.ok(Date.now() - started < 1_000);
  assert.equal((rows[BACKSTOP_SWEEP_KEY] as Record<string, unknown>)["finished"], true);
  let sweeps = 0;
  const sweep = async () => (sweeps += 1, []);
  assert.deepEqual(await backstopSweep({ host: h, now: at(60_000) }, { sweep }), { swept: false, why: "throttled" });
  assert.equal((await backstopSweep({ host: h, now: at(BACKSTOP_SWEEP_EVERY_MS) }, { sweep })).swept, true);
  assert.equal(sweeps, 1);
});

test("sweep: kv.get and kv.put throwing never reach the handler", async () => {
  const boom = async () => {
    throw new Error("kv down");
  };
  const mcp = tracker({ status: "Triaged", comments: [] }).mcp;
  for (const kv of [
    { get: boom, put: boom, delete: boom },
    { get: async (key: string) => (key === HOP_WATCH_INDEX ? [KEY] : undefined) as never, put: boom, delete: boom },
  ]) {
    const result = await quiet(() => backstopSweep({ host: { ...host(countingKv().kv, [], mcp), kv }, now: at(0) }));
    assert.equal(result.swept, false);
    const decision = { prompt: "x" };
    const wrapped = withBackstopSweep(async () => decision as never);
    assert.equal(await quiet(async () => wrapped({ host: { ...host(countingKv().kv, [], mcp), kv }, slack: THREAD } as never, { text: "hi" } as never)), decision);
  }
});

test("sweep: a Slack admission whose sweep hangs returns its decision within about a second", async () => {
  const hang = () => new Promise<never>(() => {});
  const kv = { get: hang, put: hang, delete: hang };
  const decision = { prompt: "x" };
  const wrapped = withBackstopSweep(async () => decision as never);
  const started = Date.now();
  const out = await wrapped({ host: { ...host(countingKv().kv, [], tracker({ status: "Triaged", comments: [] }).mcp), kv }, slack: THREAD } as never, { text: "hi" } as never);
  const took = Date.now() - started;
  assert.equal(out, decision);
  assert.ok(took >= 900 && took < 1_500, `took ${took} ms`);
});

test("sweep: the cap covers the whole backstop, so a kv read that hangs still settles the waitUntil promise", async () => {
  const hang = () => new Promise<never>(() => {});
  const kv = { get: hang, put: hang, delete: hang };
  const h = { ...host(countingKv().kv, [], tracker({ status: "Triaged", comments: [] }).mcp), kv };
  const settled = await Promise.race([
    backstopSweep({ host: h, now: at(0) }, { timeoutMs: 50 }).then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 500)),
  ]);
  assert.equal(settled, "settled");
});

test("sweep: an empty index costs one kv read and no MCP call", async () => {
  const { kv, reads } = countingKv({});
  const t = tracker({ status: "Triaged", comments: [] });
  assert.deepEqual(await backstopSweep({ host: host(kv, [], t.mcp), now: at(0) }), { swept: false, why: "idle" });
  assert.deepEqual(reads, [HOP_WATCH_INDEX]);
  assert.deepEqual(t.calls, []);
});

test("sweep: the reminder's fire and a sweep racing on one due record post exactly one line", async () => {
  const { kv } = countingKv();
  const posts: Record<string, unknown>[] = [];
  const t = tracker({ status: "Triaged", comments: [{ id: "5", body: "hello" }, STARTED] });
  const rem = reminders();
  await quiet(() => armHopWatch(host(kv, [], t.mcp, rem), { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 }));
  const due = HOPS.plan.deadlineMs + 11 * 60_000;
  const h = host(kv, posts, t.mcp, rem);
  await quiet(() => Promise.all([fireHopWatch({ host: h, now: at(due) }, { issueKey: KEY, hop: "plan", changelogId: "c1" }), sweepHopWatches({ host: h, now: at(due) })]));
  assert.equal(posts.length, 1, JSON.stringify(posts.map((p) => p["text"])));
});

test("sweep: a record with no reminder is re-armed only while inside its deadline", async () => {
  const { rows, kv } = countingKv();
  const t = tracker({ status: "Triaged", comments: [STARTED] });
  await quiet(() => armHopWatch(host(kv, [], t.mcp), { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 }));
  const late = reminders();
  const posts: Record<string, unknown>[] = [];
  await quiet(() => sweepHopWatches({ host: host(kv, posts, t.mcp, late), now: at(HOPS.plan.deadlineMs + 1) }));
  assert.equal(late.created.length, 0, "past the deadline it fires, it does not re-arm");
  assert.equal(posts.length, 1);
  assert.equal(rows[hopWatchKey(KEY)], undefined);
});

test("sweep: a due record whose ticket already left the hop status is cleared with no line", async () => {
  const { rows, kv } = countingKv();
  const posts: Record<string, unknown>[] = [];
  await quiet(() => armHopWatch(host(kv, [], tracker({ status: "Triaged", comments: [] }).mcp), { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 }));
  const fires = await quiet(() => sweepHopWatches({ host: host(kv, posts, tracker({ status: "Planned", comments: [] }).mcp), now: at(HOPS.plan.deadlineMs + 1) }));
  assert.deepEqual(fires.map((f) => f.result), ["moved_on"]);
  assert.equal(posts.length, 0);
  assert.equal(rows[hopWatchKey(KEY)], undefined);
  assert.deepEqual(rows[HOP_WATCH_INDEX], []);
});

// --- Decline ---------------------------------------------------------------

const KEY42 = "TLSSN-42";
const decline = (comments: Comment[], unreadable = false) => planDecline(tracker({ status: "Planned", comments, unreadable }).mcp as never, KEY42);
const PLAN = (id?: string | number, extra = "") => ({ ...(id === undefined ? {} : { id }), body: `Plan: ${KEY42}\nSummary: CSV export${extra}` });
const DENY = (id?: string | number) => ({ ...(id === undefined ? {} : { id }), body: "Denied in Slack by Alice" });
const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

test("decline: a replan's larger Plan: id reopens the plan", async () => {
  assert.equal((await decline([PLAN("10"), DENY("11"), PLAN("12")])).state, "open");
  assert.deepEqual(await decline([PLAN("10"), DENY("11")]), { state: "declined", planId: "10" });
});

test("decline: ids order numerically, so a denial at 10 follows a plan at 9", async () => {
  assert.equal((await decline([DENY("10"), PLAN("9")])).state, "declined");
  assert.equal((await decline([PLAN("10"), DENY("9")])).state, "open");
  assert.equal((await decline([PLAN(9), DENY(10)])).state, "declined", "numeric ids from the connector");
});

test("decline: with missing ids the connector's oldest-first order stands", async () => {
  assert.equal((await decline([PLAN(), DENY()])).state, "declined");
  assert.equal((await decline([DENY(), PLAN()])).state, "open");
  assert.deepEqual(await decline([PLAN(), DENY()]), { state: "declined" });
});

test("decline: ADF comment bodies count", async () => {
  assert.equal((await decline([{ id: "1", body: adf(`Plan: ${KEY42}`) }, { id: "2", body: adf("Denied in Slack by Alice") }])).state, "declined");
});

test("decline: 'Denied in Slack by' inside a Plan: body or quoted reporter text is not a denial", async () => {
  assert.equal((await decline([PLAN("1", "\nDenied in Slack by Alice")])).state, "open");
  assert.equal((await decline([PLAN("1"), { id: "2", body: "Reporter wrote:\n> Denied in Slack by Alice" }])).state, "open");
  assert.equal((await decline([PLAN("1"), { id: "2", body: "> Denied in Slack by Alice" }])).state, "open");
});

test("decline: a person's own comment that merely starts with the denial words is not the desk's denial", async () => {
  // Only the one-line shape deniedComment writes counts.
  assert.equal((await decline([PLAN("1"), { id: "2", body: "Denied in Slack by mistake? No, please build this." }])).state, "open");
});

test("decline: a Plan stopped: after the denial keeps the plan declined", async () => {
  assert.equal((await decline([PLAN("1"), DENY("2"), { id: "3", body: `Plan stopped: ${KEY42}\nno run started` }])).state, "declined");
});

test("decline: unreadable comments are unread", async () => {
  assert.deepEqual(await decline([], true), { state: "unread" });
});

test("decline: no Plan: comment at all and a denial is still declined, with no planId", async () => {
  assert.deepEqual(await decline([DENY("5")]), { state: "declined" });
});

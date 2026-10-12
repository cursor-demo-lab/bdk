import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import type { HostMcpCallResult, ReminderCreateInput } from "@cursor/july";
import type { SlackBinding, SlackMessage } from "@cursor/july/channels/slack";
import channel from "../channels/jira.js";
import { withBackstopSweep } from "../channels/slack.js";
import { armHopWatch, BACKSTOP_SWEEP_EVERY_MS, BACKSTOP_SWEEP_KEY, backstopSweep, HOPS, hopWatchKey, sweepHopWatches } from "./hop-watch.js";

// Hosted v2 binds CURSOR_API_KEY per request and fires the hop-watch
// schedule only from its release manifest, so the sweep also runs from desk
// admissions, throttled per deployment, and every reminder arm logs its
// outcome.

const ENV = { JIRA_WEBHOOK_SECRET: "test-secret", FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_DESK_CLAIM_SETTLE_MS: "5" } as const;
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

function memoryKv(initial: Record<string, unknown> = { [`ticket/${KEY}`]: { ...THREAD, originatorUserId: "U0ALICE01" } }) {
  const rows: Record<string, unknown> = structuredClone(initial);
  return { rows, kv: { get: async (key: string) => rows[key] as never, put: async (key: string, value: unknown) => void (rows[key] = value), delete: async (key: string) => void delete rows[key] } };
}

// The planner's start marker, so the 4-minute start check (hop-watch.test.ts)
// finds the run started and only the deadline watch under test speaks.
const STARTED = [{ id: "10011", body: `Planning started: ${KEY}\nSession: ses_8de9de41\nStarted at: ${T0.toISOString()}` }];

function jira(status = "Triaged", comments: Array<{ id: string; body: string }> = STARTED) {
  return {
    names: () => ["tracker"],
    listTools: async () => [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { issueIdOrKey: { type: "string" } } } }],
    callTool: async (): Promise<HostMcpCallResult> => ({ content: [{ type: "text", text: JSON.stringify({ key: KEY, fields: { status: { name: status }, comment: { comments } } }) }] }),
  };
}

function reminders(options: { createThrows?: boolean } = {}) {
  const created: ReminderCreateInput[] = [];
  return {
    created,
    api: {
      create: async (input: ReminderCreateInput) => {
        if (options.createThrows === true) throw new Error("platform timers require CURSOR_API_KEY");
        created.push(input);
        return { id: `rem_${created.length}` } as never;
      },
      cancel: async () => undefined,
      list: async () => [],
      cancelForContinuation: async () => 0,
      rekeyContinuation: async () => 0,
      dispatch: async () => ({ reminderId: "", outcome: "noop" as const }),
    },
  };
}

function host(kv: ReturnType<typeof memoryKv>["kv"], posts: Record<string, unknown>[], rem?: ReturnType<typeof reminders>, mcp = jira()) {
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

async function captured<T>(stream: "log" | "error", run: () => Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const original = console[stream];
  const lines: Record<string, unknown>[] = [];
  console[stream] = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])));
    } catch {
      // not a structured line
    }
  };
  try {
    return { result: await run(), lines };
  } finally {
    console[stream] = original;
  }
}

test("every reminder arm logs one hop_watch line with its outcome (and one plan_start_watch line for a plan entry), and no error text is a secret", async () => {
  const ok = memoryKv();
  const armed = await captured("log", () => armHopWatch(host(ok.kv, [], reminders()), { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 }));
  assert.deepEqual(armed.lines, [
    { desk: "hop_watch", via: "arm", issueKey: KEY, hop: "plan", changelogId: "c1", armed: "armed", reminderId: "rem_1" },
    { desk: "plan_start_watch", via: "arm", issueKey: KEY, changelogId: "c1", result: "armed", reminderId: "rem_2" },
  ]);

  const failing = memoryKv();
  const failed = await captured("error", () => armHopWatch(host(failing.kv, [], reminders({ createThrows: true })), { issueKey: KEY, hop: "launch", changelogId: "c2", at: T0 }));
  assert.deepEqual(failed.result, { armed: true, reminder: "failed" });
  assert.deepEqual(failed.lines, [{ desk: "hop_watch", via: "arm", issueKey: KEY, hop: "launch", changelogId: "c2", armed: "failed", error: "platform timers require CURSOR_API_KEY" }]);

  const bare = memoryKv();
  const unavailable = await captured("log", () => armHopWatch(host(bare.kv, []), { issueKey: KEY, hop: "plan", changelogId: "c3", at: T0 }));
  assert.deepEqual(unavailable.lines, [
    { desk: "hop_watch", via: "arm", issueKey: KEY, hop: "plan", changelogId: "c3", armed: "unavailable" },
    { desk: "plan_start_watch", via: "arm", issueKey: KEY, changelogId: "c3", result: "unavailable" },
  ]);
});

test("the backstop sweeps at most once per window: a second admission inside it does not sweep", async () => {
  const { kv } = memoryKv({ "hop-watch/index": [KEY] });
  let sweeps = 0;
  const sweep = async () => (sweeps += 1, []);
  const h = host(kv, []);
  assert.deepEqual(await backstopSweep({ host: h, now: at(0) }, { sweep }), { swept: true, fires: [] });
  assert.deepEqual(await backstopSweep({ host: h, now: at(BACKSTOP_SWEEP_EVERY_MS - 1) }, { sweep }), { swept: false, why: "throttled" });
  assert.equal(sweeps, 1);
  assert.equal((await backstopSweep({ host: h, now: at(BACKSTOP_SWEEP_EVERY_MS) }, { sweep })).swept, true);
  assert.equal(sweeps, 2);
});

test("a sweep frozen before it finished holds the lease only past its cap, not the whole window", async () => {
  // What a Slack admission's sweep leaves when the pod freezes mid-way.
  const { kv } = memoryKv({ "hop-watch/index": [KEY], [BACKSTOP_SWEEP_KEY]: { state: "pending", owner: "frozen", at: T0.toISOString(), holdMs: 30_000 } });
  const h = host(kv, []);
  let sweeps = 0;
  const sweep = async () => (sweeps += 1, []);
  assert.deepEqual(await backstopSweep({ host: h, now: at(29_000) }, { sweep }), { swept: false, why: "throttled" });
  assert.equal((await backstopSweep({ host: h, now: at(30_000) }, { sweep })).swept, true);
  assert.deepEqual(await backstopSweep({ host: h, now: at(30_000 + BACKSTOP_SWEEP_EVERY_MS - 1) }, { sweep }), { swept: false, why: "throttled" });
  assert.equal(sweeps, 1);
});

test("a due record whose reminder never armed gets its line once from admission sweeps", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const h = host(kv, posts, reminders({ createThrows: true }));
  await captured("error", () => armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 }));
  const due = HOPS.plan.deadlineMs;
  const first = await backstopSweep({ host: h, now: at(due) });
  assert.deepEqual(first.swept && first.fires.map((fire) => fire.result), ["posted"]);
  assert.equal(posts.length, 1);
  assert.equal(rows[hopWatchKey(KEY)], undefined);
  await backstopSweep({ host: h, now: at(due + BACKSTOP_SWEEP_EVERY_MS) });
  assert.equal(posts.length, 1);
});

test("the sweep arms a reminder for a record inside its deadline whose arm failed", async () => {
  const { rows, kv } = memoryKv();
  await captured("error", () => armHopWatch(host(kv, [], reminders({ createThrows: true })), { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 }));
  const rem = reminders();
  const { lines } = await captured("log", () => sweepHopWatches({ host: host(kv, [], rem), now: at(5 * 60_000) }));
  assert.equal(rem.created.length, 1);
  assert.equal(rem.created[0]!.delay, "10m");
  assert.deepEqual(rem.created[0]!.args, { issueKey: KEY, hop: "plan", changelogId: "c1" });
  assert.equal((rows[hopWatchKey(KEY)] as Record<string, unknown>)["reminderId"], "rem_1");
  // The start check was due too (4 min, no reminder of its own): the sweep ran it and found the run started, so no start reminder is needed.
  assert.deepEqual(lines, [
    { desk: "plan_start_watch", via: "sweep", issueKey: KEY, changelogId: "c1", result: "started" },
    { desk: "hop_watch", via: "sweep", issueKey: KEY, hop: "plan", changelogId: "c1", armed: "armed", reminderId: "rem_1" },
  ]);
});

test("the sweep arms a start reminder for a plan record inside its start deadline whose arm failed", async () => {
  const { rows, kv } = memoryKv();
  await captured("error", () => armHopWatch(host(kv, [], reminders({ createThrows: true })), { issueKey: KEY, hop: "plan", changelogId: "c1", at: T0 }));
  const rem = reminders();
  const { lines } = await captured("log", () => sweepHopWatches({ host: host(kv, [], rem), now: at(60_000) }));
  assert.deepEqual(
    rem.created.map((created) => [created.handler, created.delay]),
    [
      ["plan_start", "3m"],
      ["hop_watch", "14m"],
    ]
  );
  assert.equal((rows[hopWatchKey(KEY)] as Record<string, unknown>)["startReminderId"], "rem_1");
  assert.equal((rows[hopWatchKey(KEY)] as Record<string, unknown>)["reminderId"], "rem_2");
  assert.deepEqual(lines, [
    { desk: "plan_start_watch", via: "sweep", issueKey: KEY, changelogId: "c1", result: "armed", reminderId: "rem_1" },
    { desk: "hop_watch", via: "sweep", issueKey: KEY, hop: "plan", changelogId: "c1", armed: "armed", reminderId: "rem_2" },
  ]);
});

test("a sweep that throws or hangs never breaks the admission it rides on", async () => {
  const { kv } = memoryKv({ "hop-watch/index": [KEY] });
  const threw = await captured("error", () => backstopSweep({ host: host(kv, []), now: at(0) }, { sweep: async () => { throw new Error("kv down"); } }));
  assert.deepEqual(threw.result, { swept: false, why: "threw" });

  const hung = await backstopSweep({ host: host(memoryKv({ "hop-watch/index": [KEY] }).kv, []), now: at(0) }, { sweep: () => new Promise(() => {}), timeoutMs: 5 });
  assert.deepEqual(hung, { swept: false, why: "timeout" });

  const broken = { get: async () => { throw new Error("kv down"); }, put: async () => {}, delete: async () => {} };
  const decision = { prompt: "hello" };
  const wrapped = withBackstopSweep(async () => decision as never);
  const ctx = { host: { ...host(memoryKv().kv, []), kv: broken }, slack: THREAD } as unknown as SlackBinding;
  const out = await captured("error", async () => wrapped(ctx, { text: "hi", ts: "1758510001.000100" } as SlackMessage));
  assert.equal(out.result, decision);
});

test("a Jira webhook admission runs the backstop sweep, once per window", async () => {
  const { rows, kv } = memoryKv();
  const posts: Record<string, unknown>[] = [];
  const enteredAt = new Date(Date.now() - HOPS.plan.deadlineMs - 60_000);
  const h = host(kv, posts, reminders({ createThrows: true }), jira("Triaged", [{ id: "10011", body: `Planning started: ${KEY}\nSession: ses_8de9de41\nStarted at: ${enteredAt.toISOString()}` }]));
  await captured("error", () => armHopWatch(h, { issueKey: KEY, hop: "plan", changelogId: "c1", at: enteredAt }));
  type Handler = (request: Request, ctx: unknown) => Promise<Response>;
  const handler = (channel as unknown as { routes: Array<{ handler: Handler }> }).routes[0]!.handler;
  const deliver = async () => {
    const raw = JSON.stringify({ webhookEvent: "comment_created", issue: { key: KEY, fields: { summary: "x", status: { name: "Triaged" }, project: { key: "TLSSN" } } }, comment: { id: "1", body: "just a note" } });
    const background: Promise<unknown>[] = [];
    const request = new Request("http://desk/v1/channels/jira", { method: "POST", body: raw, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.JIRA_WEBHOOK_SECRET).update(raw).digest("hex")}` } });
    await handler(request, { host: h, waitUntil: (promise: Promise<unknown>) => void background.push(promise), body: JSON.parse(raw) });
    await Promise.all(background);
  };
  await captured("log", deliver);
  assert.equal(posts.length, 1);
  assert.notEqual(rows[BACKSTOP_SWEEP_KEY], undefined);
  await captured("log", deliver);
  assert.equal(posts.length, 1);
});

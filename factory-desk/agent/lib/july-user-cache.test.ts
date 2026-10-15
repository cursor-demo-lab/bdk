import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchSlackUserInfo,
  isExternalSlackSender,
  resetExternalSenderCache,
  resolveSlackSender,
  type SlackApiTransport,
  type SlackBinding,
  type SlackMessage,
} from "@cursor/july/channels/slack";
import { julyClassifiedSender } from "./fix-request.js";
import { julyUserCacheGuard } from "./july-user-cache.js";
import { hostSlackTransport, recordingSpeakers } from "./originator.js";

const TEAM = "T0DESK0001";

function slackDirectory(): { transport: SlackApiTransport; calls: string[]; guests: Set<string> } {
  const calls: string[] = [];
  const guests = new Set<string>();
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "directory",
    call: async (method, args) => {
      calls.push(`${method}:${String(args["user"] ?? args["bot"])}`);
      if (method === "bots.info") return { ok: true, bot: { name: `bot-${String(args["bot"])}` } };
      const user = String(args["user"]);
      return { ok: true, user: { id: user, team_id: TEAM, is_restricted: guests.has(user), profile: { display_name: `name-${user}` } } };
    },
  };
  return { transport, calls, guests };
}

function message(userId: string, ts = "1758510000.000100"): SlackMessage {
  return { text: "hello", body: "hello", markdown: "hello", ts, threadTs: ts, channelId: "C0INTAKE01", teamId: TEAM, author: { userId, userName: "", isBot: false } };
}

function manualClock(start = 0) {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

function manualTimer() {
  const ticks: (() => void)[] = [];
  return { every: (_ms: number, tick: () => void) => (ticks.push(tick), () => void ticks.splice(ticks.indexOf(tick), 1)), fire: () => ticks.forEach((tick) => tick()), ticks };
}

// Characterizes @cursor/july 0.2.25 (docs/july-users-info-cache.md). When an
// upgrade fails one of these, July has changed its cache and the guard below
// may be removable.
test("July 0.2.24 keeps every users.info record and verdict with no expiry", async () => {
  resetExternalSenderCache();
  const slack = slackDirectory();
  for (let i = 0; i < 50; i++) await isExternalSlackSender({ botToken: slack.transport, slackTeamId: TEAM, userId: `U${i}` });
  slack.calls.length = 0;
  for (let i = 0; i < 50; i++) await fetchSlackUserInfo({ botToken: slack.transport, userId: `U${i}` });
  assert.deepEqual(slack.calls, [], "all 50 records are still cached");

  slack.guests.add("U0");
  assert.equal(await isExternalSlackSender({ botToken: slack.transport, slackTeamId: TEAM, userId: "U0" }), false, "a member made a guest is still internal");
  resetExternalSenderCache();
  assert.equal(await isExternalSlackSender({ botToken: slack.transport, slackTeamId: TEAM, userId: "U0" }), true, "only a reset shows the change");
});

test("July 0.2.24 shares a verdict across token objects, including one that cannot reach Slack", async () => {
  resetExternalSenderCache();
  const slack = slackDirectory();
  await isExternalSlackSender({ botToken: slack.transport, slackTeamId: TEAM, userId: "U0ALICE" });
  const blind: SlackApiTransport = { kind: "api-transport", label: "blind", call: async () => Promise.reject(new Error("no access")) };
  assert.equal(await isExternalSlackSender({ botToken: blind, slackTeamId: TEAM, userId: "U0ALICE" }), false);
});

test("the guard clears July's caches once they are older than maxAgeMs, so a demoted member is seen", async () => {
  resetExternalSenderCache();
  const slack = slackDirectory();
  const clock = manualClock();
  const timer = manualTimer();
  const guard = julyUserCacheGuard({ maxAgeMs: 1_000, maxUsers: 100, now: clock.now, every: timer.every });
  const handler = guard.wrap(async (_ctx, m) => ({ auth: null, message: String(await isExternalSlackSender({ botToken: slack.transport, slackTeamId: TEAM, userId: m.author!.userId })) }));
  const ctx = {} as SlackBinding;

  assert.equal((await handler(ctx, message("U0BOB")))?.message, "false");
  slack.guests.add("U0BOB");
  clock.advance(999);
  assert.equal((await handler(ctx, message("U0BOB")))?.message, "false", "still inside maxAgeMs");
  clock.advance(1);
  assert.equal((await handler(ctx, message("U0BOB")))?.message, "false", "this message read the old verdict; the clear runs after it");
  assert.equal(guard.stats().sweeps, 1);
  assert.equal((await handler(ctx, message("U0BOB")))?.message, "true");
  guard.stop();
});

test("the guard clears once maxUsers distinct senders are seen, and tracks at most maxUsers ids", async () => {
  const resets: number[] = [];
  const clock = manualClock();
  const guard = julyUserCacheGuard({ maxAgeMs: 60_000, maxUsers: 3, now: clock.now, reset: () => resets.push(clock.now()), every: manualTimer().every });
  const handler = guard.wrap(async () => null);
  for (const user of ["U1", "U1", "U2"]) await handler({} as SlackBinding, message(user));
  assert.deepEqual(resets, []);
  assert.equal(guard.stats().users, 2);
  await handler({} as SlackBinding, message("U3"));
  assert.deepEqual(resets, [0]);
  assert.equal(guard.stats().users, 0);
  guard.stop();
});

test("the guard never clears while a handler is running, and clears when the last one ends", async () => {
  const resets: string[] = [];
  const clock = manualClock();
  const timer = manualTimer();
  const guard = julyUserCacheGuard({ maxAgeMs: 10, maxUsers: 100, now: clock.now, reset: () => resets.push("reset"), every: timer.every });
  const gates: (() => void)[] = [];
  const handler = guard.wrap(() => new Promise((resolve) => gates.push(() => resolve(null))));
  const first = handler({} as SlackBinding, message("U1"));
  const second = handler({} as SlackBinding, message("U2", "1758510000.000200"));
  clock.advance(10);
  timer.fire();
  assert.equal(guard.sweep(), false);
  gates[0]!();
  await first;
  assert.deepEqual(resets, [], "one handler is still running");
  gates[1]!();
  await second;
  assert.deepEqual(resets, ["reset"]);
  guard.stop();
});

test("the timer clears a quiet desk's caches, and the first handler starts only one timer", async () => {
  const resets: string[] = [];
  const clock = manualClock();
  const timer = manualTimer();
  const guard = julyUserCacheGuard({ maxAgeMs: 100, maxUsers: 100, now: clock.now, reset: () => resets.push("reset"), every: timer.every });
  assert.equal(timer.ticks.length, 0, "no timer before the first message");
  const handler = guard.wrap(async () => null);
  await handler({} as SlackBinding, message("U1"));
  await handler({} as SlackBinding, message("U2"));
  assert.equal(timer.ticks.length, 1);
  clock.advance(100);
  timer.fire();
  assert.deepEqual(resets, ["reset"]);
  timer.fire();
  assert.deepEqual(resets, ["reset"], "not due again until maxAgeMs later");
  guard.stop();
  assert.equal(timer.ticks.length, 0);
});

test("a throwing handler or reset still leaves the guard idle and working", async () => {
  const clock = manualClock();
  let resets = 0;
  const guard = julyUserCacheGuard({ maxAgeMs: 1, maxUsers: 100, now: clock.now, reset: () => { resets += 1; throw new Error("boom"); }, every: manualTimer().every });
  const handler = guard.wrap(async () => { throw new Error("handler failed"); });
  clock.advance(1);
  await assert.rejects(async () => await handler({} as SlackBinding, message("U1")), /handler failed/);
  assert.equal(resets, 1);
  assert.deepEqual({ inFlight: guard.stats().inFlight, users: guard.stats().users }, { inFlight: 0, users: 0 });
  guard.stop();
});

test("a due clear does not wipe the verdict a running handler is waiting to read", { timeout: 2000 }, async () => {
  resetExternalSenderCache();
  const slack = slackDirectory();
  const clock = manualClock();
  const timer = manualTimer();
  const guard = julyUserCacheGuard({ maxAgeMs: 1, maxUsers: 100, now: clock.now, every: timer.every });
  const check = julyClassifiedSender({ waitMs: 200, stepMs: 5 });
  // July starts its lookup before the handler, as dispatch.js does.
  const july = isExternalSlackSender({ botToken: slack.transport, slackTeamId: TEAM, userId: "U0CAROL" });
  const handler = guard.wrap(async (_ctx, m) => {
    await july;
    clock.advance(5);
    timer.fire();
    return { auth: null, message: String(await check(m)) };
  });
  const decision = await handler({} as SlackBinding, message("U0CAROL"));
  assert.equal(decision?.message, "false", "the desk read July's answer, not an unclassified miss");
  assert.equal(await july, false);
  assert.equal(guard.stats().sweeps, 1, "the clear ran after the handler");
  guard.stop();
});

test("the sender name July puts in the turn header is refreshed by a clear", async () => {
  resetExternalSenderCache();
  const calls: string[] = [];
  let name = "old-name";
  const transport: SlackApiTransport = { kind: "api-transport", label: "names", call: async (method, args) => (calls.push(method), { ok: true, user: { id: String(args["user"]), team_id: TEAM, profile: { display_name: name } } }) };
  const clock = manualClock();
  const guard = julyUserCacheGuard({ maxAgeMs: 10, now: clock.now, every: manualTimer().every });
  const author = { userId: "U0DAVE", userName: "", isBot: false };
  assert.equal((await resolveSlackSender({ botToken: transport, author })).name, "old-name");
  name = "new-name";
  assert.equal((await resolveSlackSender({ botToken: transport, author })).name, "old-name");
  clock.advance(10);
  await guard.wrap(async () => null)({} as SlackBinding, message("U0DAVE"));
  assert.equal((await resolveSlackSender({ botToken: transport, author })).name, "new-name");
  guard.stop();
});

function binding(slack: SlackBinding["host"]["slack"], kv: Record<string, unknown>): SlackBinding {
  const store = { get: async (k: string) => kv[k], put: async (k: string, v: unknown) => void (kv[k] = v), delete: async (k: string) => void delete kv[k] };
  return { slack: { channelId: "C0INTAKE01", threadTs: "1758510000.000100", teamId: TEAM }, host: { kv: store, slack } } as unknown as SlackBinding;
}

test("recordingSpeakers hands July one transport per host Slack client, not one per message", async () => {
  const usersInfo: string[] = [];
  const client = { apiCall: async (_method: string, args: Record<string, unknown>) => (usersInfo.push(String(args["user"])), { ok: true, user: { id: String(args["user"]), team_id: TEAM } }) };
  const hostSlack = { getClient: async () => client } as unknown as SlackBinding["host"]["slack"];
  const otherHost = { getClient: async () => client } as unknown as SlackBinding["host"]["slack"];
  assert.equal(hostSlackTransport(hostSlack), hostSlackTransport(hostSlack));
  assert.notEqual(hostSlackTransport(hostSlack), hostSlackTransport(otherHost), "a second agent's host client gets its own transport");

  const handler = recordingSpeakers(async () => null);
  for (let i = 0; i < 3; i++) {
    // A reset before each message is the case that used to leak: July has
    // no verdict yet, so the desk's transport becomes a users.info cache key.
    resetExternalSenderCache();
    await handler(binding(hostSlack, {}), message("U0ERIN", `1758510000.00010${i}`));
  }
  assert.deepEqual(usersInfo, ["U0ERIN", "U0ERIN", "U0ERIN"]);
  usersInfo.length = 0;
  await fetchSlackUserInfo({ botToken: hostSlackTransport(hostSlack), userId: "U0ERIN" });
  assert.deepEqual(usersInfo, [], "the record is cached under the one shared transport");
});

test("a clear between July's lookup and the handler fails closed: the desk's check reads the member as external", { timeout: 2000 }, async () => {
  resetExternalSenderCache();
  const slack = slackDirectory();
  const clock = manualClock();
  const guard = julyUserCacheGuard({ maxAgeMs: 1, maxUsers: 100, now: clock.now, every: manualTimer().every });
  assert.equal(await isExternalSlackSender({ botToken: slack.transport, slackTeamId: TEAM, userId: "U0FRAN" }), false, "July's own verdict: internal");
  clock.advance(1);
  assert.equal(guard.sweep(), true, "idle and due, so the clear lands before the handler starts");
  const check = julyClassifiedSender({ waitMs: 30, stepMs: 5 });
  const handler = guard.wrap(async (_ctx, m) => ({ auth: null, message: String(await check(m)) }));
  assert.equal((await handler({} as SlackBinding, message("U0FRAN")))?.message, "true", "unclassified after the wait counts as external, so a gated command is refused");
  guard.stop();
});

test("after a clear, recordingSpeakers re-reads Slack: a member is recorded, a Slack Connect sender is not", { timeout: 2000 }, async () => {
  resetExternalSenderCache();
  const teams: Record<string, string> = { U0GINA: TEAM, U0HANK: "T0PARTNER1" };
  const client = { apiCall: async (_m: string, args: Record<string, unknown>) => ({ ok: true, user: { id: String(args["user"]), team_id: teams[String(args["user"])] } }) };
  const hostSlack = { getClient: async () => client } as unknown as SlackBinding["host"]["slack"];
  for (const user of Object.keys(teams)) await isExternalSlackSender({ botToken: hostSlackTransport(hostSlack), slackTeamId: TEAM, userId: user });
  const clock = manualClock();
  const guard = julyUserCacheGuard({ maxAgeMs: 1, maxUsers: 100, now: clock.now, every: manualTimer().every });
  clock.advance(1);
  assert.equal(guard.sweep(), true);
  const check = julyClassifiedSender({ waitMs: 30, stepMs: 5 });
  const handler = guard.wrap(recordingSpeakers(async (_ctx, m) => ({ auth: null, message: String(await check(m)) })));
  const memberKv: Record<string, unknown> = {};
  assert.equal((await handler(binding(hostSlack, memberKv), message("U0GINA")))?.message, "false");
  assert.notDeepEqual(memberKv, {}, "the member's message is recorded");
  const guestKv: Record<string, unknown> = {};
  assert.equal((await handler(binding(hostSlack, guestKv), message("U0HANK")))?.message, "true");
  assert.deepEqual(guestKv, {}, "the Slack Connect sender records nothing, so cannot vouch for a command");
  guard.stop();
});

test("a throwing reset logs the failure and never logs a clear", (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const clock = manualClock();
  const guard = julyUserCacheGuard({ maxAgeMs: 1, now: clock.now, reset: () => { throw new Error("boom"); }, every: manualTimer().every });
  clock.advance(1);
  guard.sweep();
  const lines = [...logs.mock.calls, ...errors.mock.calls].map((call) => String(call.arguments[0]));
  assert.ok(!lines.some((line) => line.includes('"outcome":"cleared"')), "no clear is logged");
  assert.ok(errors.mock.calls.some((call) => /"outcome":"reset_threw".*boom/.test(String(call.arguments[0]))), "the failure is logged");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { LIVE_INTAKE_CHANNEL, LIVE_INTAKE_TEXT, LIVE_INTAKE_TS } from "./live-intake.fixtures.js";
import { ackIntake, isIntakeRequest, reactionKey, reactionTarget, setStatusReaction, STATUS_REACTIONS } from "./status-reaction.js";

const FILED = { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE01" };

function slack(fail: Record<string, string> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    client: {
      apiCall: async (method: string, args: Record<string, unknown>) => {
        calls.push([method, args]);
        const code = fail[`${method}:${String(args["name"])}`];
        if (code !== undefined) throw Object.assign(new Error(code), { data: { error: code } });
        return { ok: true };
      },
    },
  };
}

function memoryKv(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const kv: HostKvApi = {
    get: async (key: string) => store[key] as JsonValue | undefined,
    put: async (key: string, value: JsonValue) => void (store[key] = value),
    delete: async (key: string) => void delete store[key],
  };
  return { store, kv };
}

test("the filer's message walks one reaction through the lifecycle: add the new stage, then remove the last", async () => {
  const { kv, store } = memoryKv();
  const { client, calls } = slack();
  const at = { channel: "C0123ABCD", timestamp: "1758510000.123456" };
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "received" }), "set");
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "triaged", changelogId: "10030" }), "set");
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "planned", changelogId: "10031" }), "set");
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "building", changelogId: "10033" }), "set");
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "in_review", changelogId: "10034" }), "set");
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "done", changelogId: "10035" }), "set");
  assert.deepEqual(calls, [
    ["reactions.add", { ...at, name: "eyes" }],
    ["reactions.add", { ...at, name: "eyes" }],
    ["reactions.add", { ...at, name: "memo" }],
    ["reactions.remove", { ...at, name: "eyes" }],
    ["reactions.add", { ...at, name: "hammer_and_wrench" }],
    ["reactions.remove", { ...at, name: "memo" }],
    ["reactions.add", { ...at, name: "mag" }],
    ["reactions.remove", { ...at, name: "hammer_and_wrench" }],
    ["reactions.add", { ...at, name: "white_check_mark" }],
    ["reactions.remove", { ...at, name: "mag" }],
  ]);
  assert.deepEqual(store[reactionKey("TLSSN-42")], { channel: "C0123ABCD", ts: "1758510000.123456", name: "white_check_mark", changelogId: "10035" });
});

test("a late transition changes nothing; an outcome comment replaces the stage without losing the transition order", async () => {
  const { kv, store } = memoryKv({ [reactionKey("TLSSN-42")]: { channel: "C0123ABCD", ts: "1758510000.123456", name: "memo", changelogId: "10031" } });
  const { client, calls } = slack();
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "triaged", changelogId: "10030" }), "stale");
  assert.equal(calls.length, 0);
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "stopped", changelogId: "comment-10502" }), "set");
  assert.deepEqual((store[reactionKey("TLSSN-42")] as Record<string, unknown>)["changelogId"], "10031");
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "stopped", changelogId: "comment-10503" }), "unchanged");
  // A move back to Planned after a failed launch has a newer changelog, so it wins.
  assert.equal(await setStatusReaction({ kv, client, issueKey: "TLSSN-42", ticket: FILED, stage: "planned", changelogId: "10040" }), "set");
  assert.deepEqual(calls.map(([method, args]) => `${method}:${String(args["name"])}`), ["reactions.add:warning", "reactions.remove:memo", "reactions.add:memo", "reactions.remove:warning"]);
});

test("Slack errors never throw: already_reacted counts as set, a refused add removes and records nothing", async () => {
  const already = slack({ "reactions.add:memo": "already_reacted", "reactions.remove:eyes": "no_reaction" });
  const first = memoryKv({ [reactionKey("TLSSN-42")]: { channel: "C0123ABCD", ts: "1758510000.123456", name: "eyes" } });
  assert.equal(await setStatusReaction({ kv: first.kv, client: already.client, issueKey: "TLSSN-42", ticket: FILED, stage: "planned" }), "set");
  assert.equal((first.store[reactionKey("TLSSN-42")] as Record<string, unknown>)["name"], "memo");

  const refused = slack({ "reactions.add:memo": "missing_scope" });
  const second = memoryKv({ [reactionKey("TLSSN-42")]: { channel: "C0123ABCD", ts: "1758510000.123456", name: "eyes" } });
  assert.equal(await setStatusReaction({ kv: second.kv, client: refused.client, issueKey: "TLSSN-42", ticket: FILED, stage: "planned" }), "failed");
  assert.deepEqual(refused.calls.map(([method]) => method), ["reactions.add"]);
  assert.equal((second.store[reactionKey("TLSSN-42")] as Record<string, unknown>)["name"], "eyes");

  const unreadable: HostKvApi = { get: async () => Promise.reject(new Error("kv down")), put: async () => assert.fail("no write after a failed read"), delete: async () => undefined };
  const blind = slack();
  assert.equal(await setStatusReaction({ kv: unreadable, client: blind.client, issueKey: "TLSSN-42", ticket: FILED, stage: "planned" }), "set");
  assert.deepEqual(blind.calls.map(([method]) => method), ["reactions.add"], "an unknown previous stage is never removed");
});

test("a channel thread root gets reactions, the desk's Jira intake root included; a DM or a missing client does not", async () => {
  assert.deepEqual(reactionTarget(FILED), { channel: "C0123ABCD", ts: "1758510000.123456" });
  const intake = { channelId: "C0INTAKE01", threadTs: "1758510002.000001", root: "jira" as const };
  assert.deepEqual(reactionTarget(intake), { channel: "C0INTAKE01", ts: "1758510002.000001" });
  assert.equal(reactionTarget({ channelId: "D0123ABCD" }), undefined);
  assert.equal(reactionTarget({ channelId: "D0123ABCD", threadTs: "1758510000.123456" }), undefined);
  assert.equal(reactionTarget(undefined), undefined);
  const { kv } = memoryKv();
  assert.equal(await setStatusReaction({ kv, client: { chat: {} }, issueKey: "TLSSN-42", ticket: FILED, stage: "planned" }), "no_client");
  assert.equal(await setStatusReaction({ kv, client: slack().client, issueKey: "TLSSN-42", ticket: intake, stage: "planned" }), "set");
});

test("the legend uses standard Slack emoji names", () => {
  assert.deepEqual(STATUS_REACTIONS, {
    received: "eyes",
    triaged: "eyes",
    planning: "hourglass_flowing_sand",
    planned: "memo",
    declined: "no_entry_sign",
    building: "hammer_and_wrench",
    in_review: "mag",
    done: "white_check_mark",
    needs_person: "question",
    stopped: "warning",
  });
});

test("a top-level filing request gets 👀 at once; a thread reply, a DM, a bot, or chat does not", async () => {
  const request = { text: "<@U0FACTORY> file a bug: export 500", ts: "1758510000.123456", threadTs: "1758510000.123456", channelId: "C0123ABCD" };
  assert.equal(isIntakeRequest(request), true);
  assert.equal(isIntakeRequest({ ...request, threadTs: "" }), true);
  assert.equal(isIntakeRequest({ ...request, text: "Please RAISE A TICKET for this" }), true);
  assert.equal(isIntakeRequest({ ...request, threadTs: "1758509999.000001" }), false);
  assert.equal(isIntakeRequest({ ...request, channelId: "D0123ABCD" }), false);
  assert.equal(isIntakeRequest({ ...request, author: { isBot: true } }), false);
  assert.equal(isIntakeRequest({ ...request, text: "<@U0FACTORY> hello" }), false);
  const { client, calls } = slack();
  assert.equal(await ackIntake(client, request), true);
  assert.deepEqual(calls, [["reactions.add", { channel: "C0123ABCD", timestamp: "1758510000.123456", name: "eyes" }]]);
  assert.equal(await ackIntake(slack({ "reactions.add:eyes": "already_reacted" }).client, request), true);
  assert.equal(await ackIntake(client, { ...request, text: "hello" }), false);
});

test("a top-level problem report with no filing phrase gets 👀 too; a status question or a command does not", async () => {
  const request = { text: LIVE_INTAKE_TEXT, ts: LIVE_INTAKE_TS, channelId: LIVE_INTAKE_CHANNEL };
  assert.equal(isIntakeRequest(request), true);
  const { client, calls } = slack();
  assert.equal(await ackIntake(client, request), true);
  assert.deepEqual(calls, [["reactions.add", { channel: LIVE_INTAKE_CHANNEL, timestamp: LIVE_INTAKE_TS, name: "eyes" }]]);
  for (const text of ["<@U0FACTORY> what happened to TLSSN-4?", "<@U0FACTORY> approve TLSSN-1", "<@U0FACTORY> fix https://github.com/o/r/pull/1"]) {
    assert.equal(isIntakeRequest({ ...request, text }), false, text);
  }
});

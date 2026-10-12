import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { TICKET_KEY_ATTRIBUTE } from "../lib/factory-otel.js";
import hook, { issueKeyOf } from "./ticket-key.js";

// The hook as the host dispatches it: one event, a stub context with the
// session (a Slack thread in its auth attributes), kv, and host.otel.

type Handler = (event: { turnId?: string; data: Record<string, unknown> }, ctx: unknown) => Promise<void> | void;
const events = hook.events as unknown as Record<string, Handler>;

const THREAD = { channelId: "C0123456789", threadTs: "1727000000.000100" } as const;

function context(input: { thread?: { channelId: string; threadTs?: string } | undefined; rows?: Array<[string, unknown]>; throwing?: boolean; failingKv?: boolean }) {
  const store = new Map<string, unknown>(input.rows ?? []);
  const reads: string[] = [];
  const kv: HostKvApi = {
    get: async (key) => {
      reads.push(key);
      if (input.failingKv === true) throw new Error("kv unavailable");
      return store.get(key) as never;
    },
    put: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
  const tags: Array<Record<string, unknown>> = [];
  const otel = {
    setAttributes: (attributes: Record<string, unknown>) => {
      if (input.throwing === true) throw new Error("no collector");
      tags.push(attributes);
    },
  };
  const auth = input.thread === undefined ? null : { attributes: { channel_id: input.thread.channelId, ...(input.thread.threadTs === undefined ? {} : { thread_ts: input.thread.threadTs }) } };
  const ctx = { session: { id: "ses_desk", channelId: "slack", auth }, channel: { id: "slack", continuationToken: null }, host: { kv, otel } };
  return { ctx, tags, reads };
}

const bound = (thread: { channelId: string; threadTs?: string }, keys: string[]): Array<[string, unknown]> => [
  [`thread-tickets/${thread.channelId}:${thread.threadTs ?? ""}`, keys],
  ...keys.map((key): [string, unknown] => [`ticket/${key}`, { channelId: thread.channelId, ...(thread.threadTs === undefined ? {} : { threadTs: thread.threadTs }) }]),
];

test("turn.started in a thread with a filed ticket: the thread's latest ticket is the turn's key", async () => {
  const { ctx, tags } = context({ thread: THREAD, rows: bound(THREAD, ["TLSSN-4", "TLSSN-5"]) });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-5" }]);
});

test("turn.started in a thread with no ticket yet (intake before `approve file`): `none`, a fixed value", async () => {
  const { ctx, tags } = context({ thread: THREAD });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("a kv that fails is `none`, a fixed value, not a failed turn or a missing label (the README's `none when` column)", async () => {
  const { ctx, tags } = context({ thread: THREAD, rows: bound(THREAD, ["TLSSN-5"]), failingKv: true });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("turn.started with no Slack thread on the session (playground, eval): `none`, and kv is not read", async () => {
  const { ctx, tags, reads } = context({ thread: undefined, rows: bound(THREAD, ["TLSSN-5"]) });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
  assert.deepEqual(reads, []);
});

test("a thread whose index lists a ticket now bound elsewhere does not take that ticket's key", async () => {
  const elsewhere = { channelId: "C0999999999", threadTs: "1727000000.000900" };
  const rows: Array<[string, unknown]> = [[`thread-tickets/${THREAD.channelId}:${THREAD.threadTs}`, ["TLSSN-5"]], ["ticket/TLSSN-5", elsewhere]];
  const { ctx, tags } = context({ thread: THREAD, rows });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("a DM thread is a thread: its ticket is the key", async () => {
  const dm = { channelId: "D0123456789" };
  const { ctx, tags } = context({ thread: dm, rows: bound(dm, ["TLSSN-6"]) });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-6" }]);
});

test("action.result naming a Jira key (file_ticket) re-tags the turn with the new key; other answers leave the tag alone", async () => {
  const { ctx, tags } = context({ thread: THREAD });
  await events["action.result"]!({ turnId: "trn_1", data: { callId: "c1", toolName: "file_ticket", output: { issueKey: "TLSSN-9", url: "https://example.atlassian.net/browse/TLSSN-9" }, isError: false } }, ctx);
  await events["action.result"]!({ turnId: "trn_1", data: { callId: "c2", toolName: "lookup_ticket", output: { status: "Planned" }, isError: false } }, ctx);
  await events["action.result"]!({ turnId: "trn_1", data: { callId: "c3", toolName: "file_ticket", output: { issueKey: "not a key" }, isError: false } }, ctx);
  await events["action.result"]!({ turnId: "trn_1", data: { callId: "c4", toolName: "file_ticket", output: "TLSSN-10", isError: false } }, ctx);
  // July's real output for a server tool: the result as a JSON string (ticket-key.filing-turn.test.ts builds it through describeToolResult).
  await events["action.result"]!({ turnId: "trn_1", data: { callId: "c5", toolName: "approve_ticket", output: JSON.stringify({ approved: true, issueKey: "TLSSN-11" }), isError: false } }, ctx);
  await events["action.result"]!({ turnId: "trn_1", data: { callId: "c6", toolName: "file_ticket", output: "{not json", isError: false } }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-9" }, { [TICKET_KEY_ATTRIBUTE]: "TLSSN-11" }]);
});

test("issueKeyOf reads only an object's `issueKey`, as an object or as its JSON string, and only a Jira key", () => {
  assert.equal(issueKeyOf({ issueKey: "TLSSN-9" }), "TLSSN-9");
  assert.equal(issueKeyOf(JSON.stringify({ issueKey: "TLSSN-9", url: "https://example.atlassian.net/browse/TLSSN-9" })), "TLSSN-9");
  assert.equal(issueKeyOf(JSON.stringify({ issueKey: "tlssn-9" })), undefined);
  assert.equal(issueKeyOf(JSON.stringify(["TLSSN-9"])), undefined);
  assert.equal(issueKeyOf("TLSSN-9"), undefined, "a bare string is not a result");
  assert.equal(issueKeyOf("{\"issueKey\": "), undefined, "broken JSON is no key, not a throw");
  assert.equal(issueKeyOf(""), undefined);
  assert.equal(issueKeyOf({ issueKey: "tlssn-9" }), undefined);
  assert.equal(issueKeyOf({ issueKey: 9 }), undefined);
  assert.equal(issueKeyOf({ key: "TLSSN-9" }), undefined);
  assert.equal(issueKeyOf(["TLSSN-9"]), undefined);
  assert.equal(issueKeyOf(null), undefined);
  assert.equal(issueKeyOf(undefined), undefined);
});

test("a host.otel that throws never fails the turn", async () => {
  const { ctx } = context({ thread: THREAD, rows: bound(THREAD, ["TLSSN-5"]), throwing: true });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  await events["action.result"]!({ turnId: "trn_1", data: { callId: "c1", toolName: "file_ticket", output: { issueKey: "TLSSN-9" }, isError: false } }, ctx);
});

test("the hook listens to turn.started and action.result only", () => {
  assert.deepEqual(Object.keys(events).sort(), ["action.result", "turn.started"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlackMessage } from "@cursor/july/channels/slack";
import { isDenyFile, isPlainApprove, isPlainDeny, isWholeCommand, plainDenyKey } from "./approve-command.js";

const CHANNEL = "C0123ABCD";
const ROOT = "1758510000.123456";

function said(text: string): SlackMessage {
  return { text, body: text, markdown: text, ts: "1758510000.200000", threadTs: ROOT, channelId: CHANNEL, teamId: "T0123" };
}

function ctxWith(kv: Record<string, unknown>) {
  return {
    slack: { channelId: CHANNEL, threadTs: ROOT, teamId: "T0123" },
    host: { kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] } },
  } as never;
}

const bound = (key: string) => ({ [`ticket/${key}`]: { channelId: CHANNEL, threadTs: ROOT, originatorUserId: "U0ALICE" } });

test("isPlainDeny: the whole reply is `deny`, with Slack chrome allowed; a sentence with deny in it is not", () => {
  for (const text of ["deny", "deny.", "Deny!", "*deny*", "<@U0FACTORY> deny"]) assert.equal(isPlainDeny(said(text)), true, text);
  for (const text of ["I deny that it's broken", "deny TLSSN-44", "deny file", "don't deny"]) assert.equal(isPlainDeny(said(text)), false, text);
});

test("plainDenyKey: one ticket in the thread denies that key; none or several ask; a filing thread with no ticket is left to the filing turn", async () => {
  assert.deepEqual(await plainDenyKey(ctxWith({ [`thread-tickets/${CHANNEL}:${ROOT}`]: ["TLSSN-44"], ...bound("TLSSN-44") }), said("deny")), { issueKey: "TLSSN-44" });
  assert.equal(await plainDenyKey(ctxWith({ [`thread-tickets/${CHANNEL}:${ROOT}`]: ["TLSSN-44", "TLSSN-45"], ...bound("TLSSN-44"), ...bound("TLSSN-45") }), said("Deny!")), "ask");
  assert.equal(await plainDenyKey(ctxWith({}), said("deny.")), "ask");
  assert.equal(await plainDenyKey(ctxWith({ [`filing-thread/${CHANNEL}:${ROOT}`]: { at: "2026-09-28T00:00:00.000Z" } }), said("deny")), undefined);
  assert.equal(await plainDenyKey(ctxWith({ [`thread-tickets/${CHANNEL}:${ROOT}`]: ["TLSSN-44"], ...bound("TLSSN-44") }), said("I deny that it's broken")), undefined);
});

test("plainDenyKey: when the filing-thread record cannot be read, a plain `deny` is left to the filing turn", async () => {
  const ctx = {
    slack: { channelId: CHANNEL, threadTs: ROOT, teamId: "T0123" },
    host: { kv: { get: async () => { throw new Error("kv down"); }, put: async () => {}, delete: async () => {} } },
  } as never;
  assert.equal(await plainDenyKey(ctx, said("deny")), undefined);
});

const LIVE_FOOTERS = ["\nSent using @Cursor", "\n*Sent using* <@U0EXAMPLE1|Cursor>", "\nSent using Cursor", "\n_Sent using_ <@U0EXAMPLE1>", "\n"];

test("plain in-thread commands survive the Cursor connector footer (TLSSN-46 live shape `deny\\nSent using @Cursor`)", () => {
  for (const footer of LIVE_FOOTERS) {
    assert.equal(isPlainDeny(said(`deny${footer}`)), true, JSON.stringify(footer));
    assert.equal(isPlainApprove(said(`approve${footer}`)), true, JSON.stringify(footer));
    assert.equal(isDenyFile(said(`deny file${footer}`)), true, JSON.stringify(footer));
    assert.equal(isWholeCommand(said(`approve file${footer}`), /^approve\s+file[.!]*$/i), true, JSON.stringify(footer));
    assert.equal(isPlainDeny(said(`*deny*${footer}`)), true, JSON.stringify(footer));
    assert.equal(isPlainDeny(said(`I deny that it's broken${footer}`)), false, JSON.stringify(footer));
    assert.equal(isPlainApprove(said(`I approve of the idea${footer}`)), false, JSON.stringify(footer));
  }
});

test("plain `deny` whose footer arrives only as an attachment (July `body`) is still a plain deny", () => {
  const message: SlackMessage = { text: "deny", body: "deny\n\nSent using @Cursor", markdown: "deny\nSent using <@U0EXAMPLE1|Cursor>", ts: "1758510000.200000", threadTs: ROOT, channelId: CHANNEL, teamId: "T0123" };
  assert.equal(isPlainDeny(message), true);
  assert.equal(isPlainDeny({ ...message, text: "" }), true);
});

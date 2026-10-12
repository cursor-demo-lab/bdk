import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlackBinding, SlackMessage } from "@cursor/july/channels/slack";
import { replyPrefix } from "./desk-channels.js";
import { commandKey, factoryThreadReplies, isBotThreadReply, plainReplyKind } from "./plain-reply.js";

const FOOTER = "\n*Sent using* <@U0EXAMPLE1|Cursor>";
const said = (text: string): SlackMessage => ({ text, body: text, markdown: text, ts: "1790447000.000200", threadTs: "1790447000.000100", channelId: "C0EXAMPLE1" });

test("a plain reply is a command only when the whole reply is one desk command", () => {
  for (const text of ["approve", "Approve!", "approve file", "deny file.", "approve TLSSN-42", "approve TLSSN\u201142", "deny TLSSN-42", "deny", "Deny.", "plan", "plan TLSSN-42", "replan TLSSN-42", "retry", "retry TLSSN-42", "fix", "fix https://github.com/cursor-demo-lab/marsbank/pull/29", "*approve*"]) {
    assert.equal(plainReplyKind(said(`${text}${FOOTER}`)), "command", text);
  }
  for (const text of ["approve it", "I'd approve TLSSN-42 once CI is green", "approve TLSSN-42 please", "don't approve", "replan", "fix the typo on line 3", "retry later"]) {
    assert.notEqual(plainReplyKind(said(text)), "command", text);
  }
});

test("a plain question counts only when it is clearly for the factory", () => {
  for (const text of ["factory, what's the status?", "Factory: is it stuck?", "status?", "status of TLSSN-42?", "is the plan ready?", "where is TLSSN-42?", "any update on TLSSN-42?", "when does the PR go up?", "is the build green?"]) {
    assert.equal(plainReplyKind(said(`${text}${FOOTER}`), ["TLSSN-42"]), "question", text);
  }
  for (const text of ["did anyone try it on staging?", "<@U0ALICE01> is the plan ready?", "is TLSSN-7 related?", "thanks!", "ok", "the plan looks right to me", "what do you think?"]) {
    assert.equal(plainReplyKind(said(text), ["TLSSN-42"]), "chatter", text);
  }
});

test("commandKey reads the key an exact key command names, and nothing else", () => {
  assert.equal(commandKey(said(`retry tlssn-42${FOOTER}`)), "TLSSN-42");
  assert.equal(commandKey(said("deny TLSSN-42.")), "TLSSN-42");
  assert.equal(commandKey(said("approve")), undefined);
  assert.equal(commandKey(said("I'd approve TLSSN-42 later")), undefined);
});

test("replyPrefix: no mention where a plain reply reaches the desk (a DM, a watched channel, the intake channel), the mention anywhere else", () => {
  const env = { FACTORY_DESK_INTAKE_CHANNEL: "C0INTAKE01" } as NodeJS.ProcessEnv;
  for (const channel of ["C0EXAMPLE1", "D0123ABCD", "C0INTAKE01", undefined, ""]) assert.equal(replyPrefix(channel, env), "", String(channel));
  assert.equal(replyPrefix("C0OTHER001", env), "@factory ");
  assert.equal(replyPrefix("C0OTHER001", { ...env, FACTORY_DESK_SLACK_HANDLE: "factory-bot" }), "@factory-bot ");
});

test("the TLSSN-46 live footer `\\nSent using @Cursor` keeps every plain command a command; a sentence stays chatter", () => {
  for (const text of ["deny", "approve", "approve file", "deny file", "retry"]) assert.equal(plainReplyKind(said(`${text}\nSent using @Cursor`)), "command", text);
  assert.notEqual(plainReplyKind(said("I deny that it's broken\nSent using @Cursor")), "command");
});

test("factoryThreadReplies ignores bot_id and bot messages before the factory-thread gate", async () => {
  const seen: string[] = [];
  const handler = factoryThreadReplies(async (_ctx, message) => {
    seen.push(message.ts);
    return { auth: null };
  });
  const ctx = { slack: { channelId: "C0EXAMPLE1" }, host: { kv: { get: async () => undefined, put: async () => undefined, delete: async () => undefined } } } as unknown as SlackBinding;
  const human = { ...said("approve"), author: { userId: "U0ALICE", userName: "alice", isBot: false } };
  const bots: SlackMessage[] = [
    { ...human, author: { userId: "", isBot: true, botId: "B0FACTORY" } },
    { ...human, author: { userId: "U0BOT", userName: "bot", isBot: false, botId: "B0FACTORY" } },
    { ...human, bot_id: "B0FACTORY" } as SlackMessage,
    { ...human, subtype: "bot_message" } as SlackMessage,
  ];
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => void lines.push(String(line));
  try {
    for (const message of bots) {
      assert.equal(isBotThreadReply(message), true);
      assert.equal(await handler(ctx, message), null);
    }
    assert.equal(isBotThreadReply(human), false);
    await handler(ctx, human);
  } finally {
    console.log = original;
  }
  assert.deepEqual(seen, []);
  const ignored = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line["desk"] === "plain_reply");
  assert.equal(ignored.filter((line) => line["ignored"] === "bot").length, 4);
  assert.ok(ignored.some((line) => line["ignored"] !== "bot"), "a human still goes through the factory-thread gate");
});

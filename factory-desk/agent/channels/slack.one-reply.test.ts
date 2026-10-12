import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDefaultEvents, emptySlackChannelState, type SlackApiTransport, type SlackChannelState } from "@cursor/july/channels/slack";
import type { ChannelEventHandlers } from "@cursor/july/channels";
import { oneReplyEvents } from "../lib/one-reply.js";
import slack from "./slack.js";

// TLSSN-36 (and TLSSN-35): the filing prompt posted twice, first with the
// model's narration glued on (650 chars), then clean (364 chars). The turn
// had two assistant steps and no tool call between them: July's mapper
// flushes both steps' text as one `message.completed`, while `turn.completed`
// carries the SDK's result, the last step only.
const NARRATION = "I'll triage this filing request with the rubric first… Checking how to read that skill file… Trying to load the triage rubric from the workspace…\n\n";
const PROMPT = "Triaged by Jev: Bug, low severity.\nSummary: Card export CSV drops the last row.\n\nReply `@factory approve file` in this thread to file it, or `@factory deny file` to drop it.";

function slackApi() {
  const posts: Record<string, unknown>[] = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, body) => {
      if (method === "chat.postMessage") {
        posts.push(body as Record<string, unknown>);
        return { ok: true, ts: `1790459911.60${posts.length}` };
      }
      return { ok: true };
    },
  };
  return { posts, transport };
}

type Events = ChannelEventHandlers<SlackChannelState>;

async function replay(events: Events, steps: { text: string; finishReason: "stop" | "tool_call" }[], result: string | undefined) {
  const channel = { channelId: "slack", state: emptySlackChannelState({ channelId: "C0EXAMPLE1", threadTs: "1790459863.848459" }), continuationToken: null, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_0f938827794260bf449a8f51" }, host: {} } as never;
  const base = { sessionId: "ses_0f938827794260bf449a8f51", turnId: "turn_1" };
  await events["turn.started"]?.({ ...base, type: "turn.started", data: {} } as never, channel, ctx);
  for (const step of steps) await events["message.completed"]?.({ ...base, type: "message.completed", data: step } as never, channel, ctx);
  await events["turn.completed"]?.({ ...base, type: "turn.completed", data: result === undefined ? {} : { result } } as never, channel, ctx);
}

test("July's stock post sinks post a two-step turn twice (the live TLSSN-36 double)", async () => {
  const api = slackApi();
  await replay(buildDefaultEvents({ credentials: { botToken: api.transport }, reply: { mode: "post" } }), [{ text: NARRATION + PROMPT, finishReason: "stop" }], PROMPT);
  assert.equal(api.posts.length, 2);
});

test("the desk posts a two-step turn once: the SDK's final text, no narration", async () => {
  const api = slackApi();
  await replay(oneReplyEvents({ credentials: { botToken: api.transport } }), [{ text: NARRATION + PROMPT, finishReason: "stop" }], PROMPT);
  assert.equal(api.posts.length, 1);
  const body = String(api.posts[0]?.["markdown_text"] ?? api.posts[0]?.["text"]);
  assert.match(body, /Triaged by Jev: Bug, low severity/);
  assert.doesNotMatch(body, /I'll triage|skill file|Trying to load/);
  assert.equal(api.posts[0]?.["thread_ts"], "1790459863.848459");
});

test("a one-step turn, a turn with tool calls, and a turn whose result is empty each post once", async () => {
  const single = slackApi();
  await replay(oneReplyEvents({ credentials: { botToken: single.transport } }), [{ text: PROMPT, finishReason: "stop" }], PROMPT);
  assert.equal(single.posts.length, 1);

  const tools = slackApi();
  await replay(oneReplyEvents({ credentials: { botToken: tools.transport } }), [{ text: "Filing it now.", finishReason: "tool_call" }, { text: "TLSSN-36 is filed.", finishReason: "stop" }], "TLSSN-36 is filed.");
  assert.equal(tools.posts.length, 1);
  assert.match(String(tools.posts[0]?.["markdown_text"] ?? tools.posts[0]?.["text"]), /^TLSSN-36 is filed\.$/);

  const empty = slackApi();
  await replay(oneReplyEvents({ credentials: { botToken: empty.transport } }), [{ text: PROMPT, finishReason: "stop" }], "");
  assert.equal(empty.posts.length, 1, "an empty SDK result falls back to the held text");
});

test("slack.ts delivers turns through the one-reply sinks", async () => {
  const events = (slack as { events?: Events }).events;
  assert.ok(events !== undefined);
  const channel = { channelId: "slack", state: emptySlackChannelState(), continuationToken: null, setContinuationToken: async () => {} };
  await events["message.completed"]?.({ sessionId: "s", turnId: "t", type: "message.completed", data: { text: PROMPT, finishReason: "stop" } } as never, channel, {} as never);
  assert.equal((channel.state as SlackChannelState & { deskHeldReply?: string }).deskHeldReply, PROMPT, "the stop text is held for turn.completed, not posted");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKET_KEY_ATTRIBUTE } from "../lib/factory-otel.js";
import hook from "./ticket-key.js";

// The hook as the host dispatches it: one event, a stub context with the
// channel's continuation token and host.otel.

type Handler = (event: { turnId?: string; data: Record<string, unknown> }, ctx: unknown) => Promise<void> | void;
const events = hook.events as unknown as Record<string, Handler>;

function context(input: { continuationToken?: string | null; channelId?: string; throwing?: boolean }) {
  const tags: Array<Record<string, unknown>> = [];
  const otel = {
    setAttributes: (attributes: Record<string, unknown>) => {
      if (input.throwing === true) throw new Error("no collector");
      tags.push(attributes);
    },
  };
  const channelId = input.channelId ?? "jira";
  const ctx = {
    session: { id: "ses_1", channelId, title: null },
    channel: { id: channelId, continuationToken: input.continuationToken ?? null },
    channelState: null,
    host: { otel },
  };
  return { ctx, tags };
}

test("an implement session (token `implement:<KEY>#<changelogId>`): the key from the token, no read", async () => {
  const { ctx, tags } = context({ continuationToken: "implement:TLSSN-42#10042" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-42" }]);
});

test("the hosted mailbox prefix on the token is stripped", async () => {
  const { ctx, tags } = context({ continuationToken: "cont:implement:TLSSN-7#1" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-7" }]);
});

test("a direct chat (no token, or the http channel's), is `none`, a fixed value", async () => {
  const chat = context({ channelId: "http" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, chat.ctx);
  assert.deepEqual(chat.tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
  const other = context({ continuationToken: "cont:session:ses_9" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, other.ctx);
  assert.deepEqual(other.tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("a host.otel that throws never fails the turn", async () => {
  const { ctx } = context({ continuationToken: "implement:TLSSN-42#10042", throwing: true });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
});

test("the hook listens to turn.started only", () => {
  assert.deepEqual(Object.keys(events), ["turn.started"]);
});

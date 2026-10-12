import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKET_KEY_ATTRIBUTE } from "../lib/factory-otel.js";
import hook from "./ticket-key.js";

// The hook as the host dispatches it: one event, a stub context with the
// session's continuation key (hosted) or the channel's token (local) and host.otel.

type Handler = (event: { turnId?: string; data: Record<string, unknown> }, ctx: unknown) => Promise<void> | void;
const events = hook.events as unknown as Record<string, Handler>;

function context(input: { continuationKey: string | null; continuationToken?: string | null; throwing?: boolean }) {
  const tags: Array<Record<string, unknown>> = [];
  const otel = {
    setAttributes: (attributes: Record<string, unknown>) => {
      if (input.throwing === true) throw new Error("no collector");
      tags.push(attributes);
    },
  };
  const ctx = {
    session: { id: "ses_triage", channelId: "jira", continuationKey: input.continuationKey },
    channel: { id: "jira", continuationToken: input.continuationToken ?? null },
    host: { otel },
  };
  return { ctx, tags };
}

test("a hosted triage run pinned by `cont:<KEY>` tags its ticket", async () => {
  const { ctx, tags } = context({ continuationKey: "cont:TLSSN-3" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-3" }]);
});

test("a local run (serve, eval) pinned by the channel's bare key tags its ticket", async () => {
  const { ctx, tags } = context({ continuationKey: null, continuationToken: "TLSSN-3" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-3" }]);
});

test("a session with no pin (playground chat) is `none`, a fixed value", async () => {
  const { ctx, tags } = context({ continuationKey: null });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("a pin that is not an issue key is `none`, not the pin", async () => {
  const { ctx, tags } = context({ continuationKey: "cont:evt:0123abcd" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("a host.otel that throws never fails the turn", async () => {
  const { ctx } = context({ continuationKey: "cont:TLSSN-3", throwing: true });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
});

test("the hook listens to turn.started only", () => {
  assert.deepEqual(Object.keys(events), ["turn.started"]);
});

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
    session: { id: "ses_plan", channelId: "planning", continuationKey: input.continuationKey },
    channel: { id: "planning", continuationToken: input.continuationToken ?? null },
    host: { otel },
  };
  return { ctx, tags };
}

test("a hosted planning run pinned by `cont:issue:<KEY>#<attempt>` tags its ticket", async () => {
  const { ctx, tags } = context({ continuationKey: "cont:issue:TLSSN-22#TLSSN-22:Triaged:2026-09-25T13:17:00.000+1000" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-22" }]);
});

test("a local run (serve, eval) pinned by the channel's bare `issue:<KEY>` token tags its ticket", async () => {
  const { ctx, tags } = context({ continuationKey: null, continuationToken: "issue:TLSSN-7" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-7" }]);
});

test("a session with no pin (playground chat) is `none`, a fixed value", async () => {
  const { ctx, tags } = context({ continuationKey: null });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("a pin that is not an issue pin is `none`, not the pin", async () => {
  const { ctx, tags } = context({ continuationKey: "cont:thread:C0123:1727000000.000100" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "none" }]);
});

test("a follow-up turn on the same session tags again with the same key", async () => {
  const { ctx, tags } = context({ continuationKey: "cont:issue:TLSSN-22#2" });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
  await events["turn.started"]!({ turnId: "trn_2", data: {} }, ctx);
  assert.deepEqual(tags, [{ [TICKET_KEY_ATTRIBUTE]: "TLSSN-22" }, { [TICKET_KEY_ATTRIBUTE]: "TLSSN-22" }]);
});

test("a host.otel that throws never fails the turn", async () => {
  const { ctx } = context({ continuationKey: "cont:issue:TLSSN-22#1", throwing: true });
  await events["turn.started"]!({ turnId: "trn_1", data: {} }, ctx);
});

test("the hook listens to turn.started only", () => {
  assert.deepEqual(Object.keys(events), ["turn.started"]);
});

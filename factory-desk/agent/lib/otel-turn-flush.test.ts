import assert from "node:assert/strict";
import { mock, test } from "node:test";
import hook from "../hooks/zz-otel-turn-flush.js";
import { awaitFactorySignalsFlush, scheduleFactorySignalsFlush } from "./otel-turn-flush.js";

// The scheduling and awaiting contracts of agent/lib/otel-turn-flush.ts. That
// the scheduled flush exports the turn count after July's collector has
// counted the turn, and that the awaited session-end flush exports it before
// the reply, is proved against July's real collector in
// july-otel.turn-end.test.ts.

const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the flush is deferred past the current tick, so July's synchronous collector runs first", async () => {
  const calls: string[] = [];
  // July's dispatch: it awaits the hook, then its collector runs synchronously.
  const handler = () => {
    scheduleFactorySignalsFlush(async () => {
      calls.push("flush");
    });
  };
  await handler();
  calls.push("collector");
  assert.deepEqual(calls, ["collector"]);
  await nextImmediate();
  assert.deepEqual(calls, ["collector", "flush"]);
});

test("turn ends scheduled before the callback runs share one flush; a later one schedules again", async () => {
  let flushes = 0;
  const flush = async () => {
    flushes += 1;
  };
  scheduleFactorySignalsFlush(flush);
  scheduleFactorySignalsFlush(flush);
  scheduleFactorySignalsFlush(flush);
  await nextImmediate();
  assert.equal(flushes, 1);
  scheduleFactorySignalsFlush(flush);
  await nextImmediate();
  assert.equal(flushes, 2);
});

test("scheduling returns at once, even when the flush never settles", async () => {
  let started = false;
  const result = scheduleFactorySignalsFlush(() => {
    started = true;
    return new Promise<void>(() => undefined);
  });
  assert.equal(result, undefined);
  await nextImmediate();
  assert.equal(started, true);
});

test("a rejecting or throwing flush is logged and never thrown into July", async () => {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    scheduleFactorySignalsFlush(() => Promise.reject(new Error("export refused")));
    await nextImmediate();
    await nextImmediate();
    scheduleFactorySignalsFlush(() => {
      throw new Error("thrown synchronously");
    });
    await nextImmediate();
    const lines = warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])) as { otel: string; message: string });
    assert.deepEqual(lines, [
      { otel: "turn_flush_failed", message: "export refused" },
      { otel: "turn_flush_failed", message: "thrown synchronously" },
    ]);
  } finally {
    warn.mock.restore();
  }
});

test("the awaited flush has settled when it returns", async () => {
  const calls: string[] = [];
  await awaitFactorySignalsFlush(async () => {
    await nextImmediate();
    calls.push("flush settled");
  });
  calls.push("returned");
  assert.deepEqual(calls, ["flush settled", "returned"]);
});

test("the awaited flush is not coalesced: each call runs its own flush", async () => {
  let flushes = 0;
  const flush = async () => {
    flushes += 1;
  };
  await Promise.all([awaitFactorySignalsFlush(flush), awaitFactorySignalsFlush(flush)]);
  assert.equal(flushes, 2);
});

test("a rejecting or throwing awaited flush is logged and resolves, never rejecting into July", async () => {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    assert.equal(await awaitFactorySignalsFlush(() => Promise.reject(new Error("export refused"))), undefined);
    assert.equal(
      await awaitFactorySignalsFlush(() => {
        throw new Error("thrown synchronously");
      }),
      undefined,
    );
    const lines = warn.mock.calls.map((call) => JSON.parse(String(call.arguments[0])) as { otel: string; message: string });
    assert.deepEqual(lines, [
      { otel: "turn_flush_failed", message: "export refused" },
      { otel: "turn_flush_failed", message: "thrown synchronously" },
    ]);
  } finally {
    warn.mock.restore();
  }
});

test("the hook handles the turn and session ends, and nothing else", () => {
  assert.deepEqual(Object.keys(hook.events).sort(), ["session.completed", "session.failed", "session.waiting", "turn.completed", "turn.failed"]);
});

test("the hook's turn handlers return synchronously, so the flush they schedule runs after July's collector", async () => {
  for (const type of ["turn.completed", "turn.failed"] as const) {
    const handler = hook.events[type] as unknown as (event: unknown, ctx: unknown) => unknown;
    assert.equal(handler({ type, data: {} }, {}), undefined);
  }
  await nextImmediate();
});

test("the hook's session handlers return the awaited flush, which July awaits before the reply", async () => {
  for (const type of ["session.waiting", "session.completed", "session.failed"] as const) {
    const handler = hook.events[type] as unknown as (event: unknown, ctx: unknown) => unknown;
    const result = handler({ type, data: {} }, {});
    assert.ok(result instanceof Promise, `${type} returns a promise July awaits`);
    assert.equal(await result, undefined);
  }
});

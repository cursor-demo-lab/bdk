import { flushFactorySignals } from "./factory-otel-signals.js";

// Gets a session turn's end out of the pod before the hosted reply, without
// waiting for the metric reader's 10 s tick. July adds the turn to
// agent_sdk.turn.count and ends the turn span when `turn.completed` reaches
// its collector, and nothing it awaits before the hosted reply exports
// either: July adopts the factory's global tracer, meter, and logger
// providers (lib/factory-otel-signals.ts; the tracer under the Bug 6b
// exception) and its forceFlush skips all three
// (docs/july-otel-upstream.md section 12). This flush carries the turn's
// spans (agent_sdk.turn and its tools, which wait in the factory's span
// queue), its metrics (the turn count; tokens only for a `turn.completed`
// that carries usage; cost only when July recorded it:
// docs/july-otel-upstream.md section 10), and July's log records.
//
// agent/hooks/zz-otel-turn-flush.ts calls both helpers:
//
// - `turn.completed` / `turn.failed`: scheduleFactorySignalsFlush. July
//   awaits hooks and only then hands the event to its collector,
//   synchronously, so the flush is deferred with setImmediate: it runs after
//   the collector has counted the turn. Repeated turn ends before the
//   callback runs share one callback. The reply does not wait for it.
// - `session.waiting` / `session.completed` / `session.failed`:
//   awaitFactorySignalsFlush. July appends these after the turn's
//   `turn.completed` / `turn.failed` (session-engine.js) on the same
//   sequential dispatch chain, so the turn is already counted when their
//   hooks run, and the hosted execution's waitForCompletion awaits that chain
//   before afterHostedWork returns the reply. Awaiting here holds the reply
//   until the flush settles, so a pod hibernated right after the reply has
//   already exported the turn's spans, metrics, and logs. It adds at most
//   SIGNALS_BUDGET_MS to the reply (flushFactorySignals' own cap). With the
//   factory's tracer global this is the one flush the reply waits for that
//   carries the turn's spans: removing it brings back missing turn spans.
//
// July runs agent/hooks/ in localeCompare order, then mounted extensions'
// hooks, and awaits each; the hook file sorts last in agent/hooks/ and
// scripts/otel-turn-flush-order.test.mjs holds it last overall, so that no
// other hook's awaited I/O falls between the schedule and the collector.
//
// Both flush the factory's tracer, meter, and logger providers
// (flushFactorySignals) and nothing else: no July span or log is rewritten,
// dropped, or reordered. flushFactorySignals joins a running flush with the
// next instead of overlapping it (until the running one passes its
// SIGNALS_BUDGET_MS + 100 ms deadline; its exports may carry on). An error is
// logged, never thrown into July.
//
// Limit: when another provider took the global tracer slot
// (`global_provider_taken`, `tracer: false`), July's spans are not in the
// factory's queue and this flush does not export them. Shared verbatim by all
// six agents (scripts/copies-parity.test.mjs).

let scheduled = false;

function report(error: unknown): void {
  console.warn(JSON.stringify({ otel: "turn_flush_failed", message: error instanceof Error ? error.message : String(error) }));
}

/** Deferred, coalesced, error-contained flush of the factory's providers. `flush` is injectable for tests. */
export function scheduleFactorySignalsFlush(flush: () => Promise<void> = flushFactorySignals): void {
  if (scheduled) return;
  scheduled = true;
  try {
    setImmediate(() => {
      scheduled = false;
      try {
        flush().catch(report);
      } catch (error) {
        report(error);
      }
    });
  } catch (error) {
    scheduled = false;
    report(error);
  }
}

/** Awaited, error-contained flush of the factory's providers; never rejects. `flush` is injectable for tests. */
export async function awaitFactorySignalsFlush(flush: () => Promise<void> = flushFactorySignals): Promise<void> {
  try {
    await flush();
  } catch (error) {
    report(error);
  }
}

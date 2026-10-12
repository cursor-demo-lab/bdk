import { defineHook } from "@cursor/july/hooks";
import { awaitFactorySignalsFlush, scheduleFactorySignalsFlush } from "../lib/otel-turn-flush.js";

// Exports the turn's spans (July's, in the factory's global tracer: Bug 6b),
// metrics (the turn count; tokens only for a `turn.completed` that carries
// usage; cost only when July recorded it: docs/july-otel-upstream.md section
// 10), and July's log records after July records them, after any factory
// flush already running; see agent/lib/otel-turn-flush.ts. `turn.*`
// schedules the flush past July's collector; `session.*`, which July
// dispatches after the turn's end, awaits it, and is the path that holds the
// hosted reply until the turn's spans, metrics, and logs have left the pod
// (Bug 6a).
// Named zz to sort last in agent/hooks/: July runs agent/hooks/ in
// localeCompare order, then mounted extensions' hooks, and awaits each;
// scripts/otel-turn-flush-order.test.mjs holds this hook last overall, so no
// other hook's I/O may sit between this schedule and the collector. Shared
// verbatim by all six agents.
export default defineHook({
  events: {
    "turn.completed": () => {
      scheduleFactorySignalsFlush();
    },
    "turn.failed": () => {
      scheduleFactorySignalsFlush();
    },
    "session.waiting": () => awaitFactorySignalsFlush(),
    "session.completed": () => awaitFactorySignalsFlush(),
    "session.failed": () => awaitFactorySignalsFlush(),
  },
});

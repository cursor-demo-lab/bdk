import { defineHook } from "@cursor/july/hooks";
import { flushFactoryMetrics } from "../lib/factory-metrics.js";

// Exports the factory's meter provider when a session's turn is over, before
// the hosted reply: July's own flush skips it (lib/factory-metrics.ts). It runs
// on session.*, not turn.completed, because July's collector records the turn's
// usage after hooks run. Dist line references: docs/july-otel-upstream.md
// section 12. Shared verbatim by all six agents (scripts/copies-parity.test.mjs).
export default defineHook({
  events: {
    "session.waiting": async () => {
      await flushFactoryMetrics();
    },
    "session.completed": async () => {
      await flushFactoryMetrics();
    },
    "session.failed": async () => {
      await flushFactoryMetrics();
    },
  },
});

import { defineOtel } from "@cursor/july/internal/otel";
import { factoryOtelResolver } from "./lib/factory-otel-signals.js";

// OTLP export of traces, metrics, and logs, off until the
// OTEL_EXPORTER_OTLP_HEADERS secret is set. Loading this file registers the
// factory's tracer, meter, and logger providers globally before July's
// startServer, so July adopts all three and records no span in memory; the
// resolver turns July's metrics and logs on (lib/factory-otel-signals.ts).
// July 0.2.22 exports defineOtel only from this internal path.
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs).
export default defineOtel(factoryOtelResolver());

import { defineOtel } from "@cursor/july/internal/otel";
import { installConsoleBridge } from "./lib/console-otel.js";
import { factoryOtelConfig } from "./lib/factory-otel.js";
import { installFactoryMeter } from "./lib/factory-metrics.js";

// OTLP export of traces, metrics, and logs to Grafana Cloud, off until the
// OTEL_EXPORTER_OTLP_HEADERS secret is set. July builds the tracer and logger
// providers and their exporters from this config and registers them globally
// (lib/factory-otel.ts has the config). Metrics go through the one cumulative
// meter provider lib/factory-metrics.ts registers here, before July's
// startServer, because July's own metric exporters are DELTA and Grafana Cloud
// rejects those. The console bridge sends the factory's console lines through
// July's global logger. July exports defineOtel only from this internal path.
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs).
installConsoleBridge();
installFactoryMeter();

export default defineOtel(() => factoryOtelConfig(process.env));

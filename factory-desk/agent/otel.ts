import { defineOtel } from "@cursor/july/internal/otel";
import { installConsoleBridge } from "./lib/console-otel.js";
import { factoryOtelConfig } from "./lib/factory-otel.js";

// OTLP export of traces, metrics, and logs to Grafana Cloud, off until the
// OTEL_EXPORTER_OTLP_HEADERS secret is set. July builds the providers and
// their exporters from this config (lib/factory-otel.ts has it) and registers
// them globally. Grafana Cloud rejects July's default DELTA metrics, so the
// resolver defaults July's temporality variable to cumulative. It sets it on
// each resolve, not at module load: a hosted pod's secrets bind after it
// starts, July reads the variable when it builds its meter provider, and the
// variable stays an operator's to override. The console bridge sends the
// factory's console lines through July's global logger. July exports
// defineOtel only from this internal path.
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs).
installConsoleBridge();

export default defineOtel(() => {
  process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"] ||= "cumulative";
  return factoryOtelConfig(process.env);
});

import { format } from "node:util";
import { context, diag, type DiagLogger } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

// Console lines as OTel log records, through the global logger July registers
// (@opentelemetry/api-logs; no provider is built here). July exports its own
// session events as logs but not the console, and the factory's JSON event
// lines (ops-funnel.ts, the milestone lines the business dashboard reads) are
// console lines, so each console call is also one record: `util.format` of
// every argument as the body, at the method's level, with no derived
// attributes. Until July builds its providers (a hosted pod's first request)
// the global logger is a no-op and the lines are only printed. Nothing is
// dropped, filtered, or rewritten.
//
// The one relabel is a Node process warning (ExperimentalWarning,
// DeprecationWarning): Node prints it through `console.error`, and that print
// is exported at WARN. Node prints from its own `warning` listener inside one
// synchronous `process.emit("warning", warning)`. The bridge wraps
// `process.emit` for that event, works out the print Node will make from the
// warning's `name` and `message` data values (no getter or method of the
// warning runs), and the first `console.error` inside the call with that shape
// takes the WARN. With no prediction (a custom `toString()`, getters) or no
// print (`--no-warnings`), nothing is relabelled. Install before any warning
// is printed: Node reads `console.error` once, at its first warning print.
//
// July prints the OTel SDK's own diag messages through the console (export
// failures, `[bdk:otel] ...`). Exporting those would feed an export failure
// back into the exporter, so the guard around `diag.setLogger` keeps them out
// of the bridge; they still print.
//
// Shared verbatim by all six agents (scripts/copies-parity.test.mjs); its test
// is factory-desk's console-otel.test.ts.

const SCOPE = "apj_factory";
const INSTALLED = Symbol.for("apj_factory.otel.console");
const CONSOLE_METHODS = { debug: SeverityNumber.DEBUG, log: SeverityNumber.INFO, info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR } as const;
const SEVERITY_TEXT: Record<number, string> = { [SeverityNumber.DEBUG]: "DEBUG", [SeverityNumber.INFO]: "INFO", [SeverityNumber.WARN]: "WARN", [SeverityNumber.ERROR]: "ERROR" };

type WarningPrint = { prefix: string; text: string };

let sdkDiagLogging = false;

function wrapDiagLogger(inner: DiagLogger): DiagLogger {
  const run =
    (method: keyof DiagLogger): DiagLogger[keyof DiagLogger] =>
    (message: string, ...args: unknown[]) => {
      const prev = sdkDiagLogging;
      sdkDiagLogging = true;
      try {
        inner[method](message, ...args);
      } finally {
        sdkDiagLogging = prev;
      }
    };
  return { error: run("error"), warn: run("warn"), info: run("info"), debug: run("debug"), verbose: run("verbose") };
}

/** An own or inherited data property's value; undefined for a getter or a missing property, so no user code runs. */
function dataValue(target: object, key: string): unknown {
  for (let object: object | null = target; object !== null; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined;
  }
  return undefined;
}

function expectedWarningPrint(warning: Error): WarningPrint | undefined {
  if (dataValue(warning, "toString") !== Error.prototype.toString) return undefined;
  const name = dataValue(warning, "name");
  const message = dataValue(warning, "message");
  if (typeof name !== "string" || typeof message !== "string") return undefined;
  return { prefix: `(${process.release.name}:${process.pid}) `, text: Error.prototype.toString.call({ name, message }) };
}

function isNodeWarningPrint(expected: WarningPrint, args: unknown[]): boolean {
  return args.length === 1 && typeof args[0] === "string" && args[0].startsWith(expected.prefix) && args[0].includes(expected.text);
}

/** Patches the console methods and `process.emit` once per process. */
export function installConsoleBridge(): void {
  const holder = globalThis as { [INSTALLED]?: true };
  if (holder[INSTALLED] === true) return;
  holder[INSTALLED] = true;

  const setLogger = diag.setLogger.bind(diag);
  diag.setLogger = ((logger: DiagLogger, options?: Parameters<typeof diag.setLogger>[1]) => setLogger(wrapDiagLogger(logger), options)) as typeof diag.setLogger;

  let dispatching: WarningPrint | undefined;
  const emit = process.emit;
  process.emit = function bridgedEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]) {
    if (event !== "warning") return Reflect.apply(emit, this, [event, ...args]);
    const outer = dispatching;
    dispatching = args[0] instanceof Error ? expectedWarningPrint(args[0]) : undefined;
    try {
      return Reflect.apply(emit, this, [event, ...args]);
    } finally {
      dispatching = outer;
    }
  } as typeof process.emit;

  for (const [method, base] of Object.entries(CONSOLE_METHODS) as [keyof typeof CONSOLE_METHODS, SeverityNumber][]) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      try {
        let severity = base;
        if (method === "error" && dispatching !== undefined && isNodeWarningPrint(dispatching, args)) {
          severity = SeverityNumber.WARN;
          dispatching = undefined;
        }
        if (sdkDiagLogging) return;
        logs.getLogger(SCOPE).emit({ body: format(...args), severityNumber: severity, severityText: SEVERITY_TEXT[severity], attributes: {}, context: context.active() });
      } catch {
        // Logging never breaks the caller.
      }
    };
  }
}

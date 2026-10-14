import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The console bridge (console-otel.ts) in a child Node process each, over a
// capturing global logger provider: the bridge patches the global console and
// Node's warning handler for the life of the process, and a Node warning is
// printed once per process. July registers the real global logger provider;
// these tests stand in for it with a capturing one.

const HOST_DIR = fileURLToPath(new URL("../../", import.meta.url));

// ---- console bridge: Node process warnings ----

type BridgedRecord = { severityNumber: number; severityText: string; body: string; attributes: Record<string, unknown> };

/**
 * Runs `scenario` in a child Node process with the real console bridge over a
 * capturing logger, and returns what the bridge exported next to what Node
 * and the console wrote to stderr. A child, because the bridge patches the
 * global console and Node's warning handler for the life of the process.
 * `before` is user code that runs ahead of `installConsoleBridge`, as a module that
 * registers a listener early would.
 */
function bridgedRun(input: { scenario: string; before?: string; nodeArgs?: string[]; bridge?: boolean }): { records: BridgedRecord[]; probes: unknown[]; stderr: string } {
  const { records, probes, stderr } = bridgedRunWithStdout(input);
  return { records, probes, stderr };
}

function bridgedRunWithStdout(input: { scenario: string; before?: string; nodeArgs?: string[]; bridge?: boolean }): { records: BridgedRecord[]; probes: unknown[]; stderr: string; stdout: string } {
  const code = `
    import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
    import { logs } from "@opentelemetry/api-logs";
    import { diag } from "@opentelemetry/api";
    import { installConsoleBridge } from "./agent/lib/console-otel.ts";
    const captured = [];
    const probes = [];
    ${input.before ?? ""}
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({
        export: (records, done) => {
          for (const r of records) captured.push({ severityNumber: r.severityNumber, severityText: r.severityText, body: r.body, attributes: { ...r.attributes } });
          done({ code: 0 });
        },
        shutdown: async () => undefined,
      })],
    });
    logs.setGlobalLoggerProvider(provider);
    ${input.bridge === false ? "" : "installConsoleBridge();"}
    ${input.scenario}
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.stdout.write("\\n@@" + JSON.stringify(captured) + "\\n##" + JSON.stringify(probes));
  `;
  const run = spawnSync(process.execPath, [...(input.nodeArgs ?? []), "--import", "tsx", "--input-type=module", "-e", code], {
    cwd: HOST_DIR,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  const tail = run.stdout.slice(run.stdout.lastIndexOf("\n@@") + 3);
  const [recordsJson, probesJson] = tail.split("\n##");
  return { records: JSON.parse(recordsJson!) as BridgedRecord[], probes: JSON.parse(probesJson!) as unknown[], stderr: run.stderr, stdout: run.stdout.slice(0, run.stdout.lastIndexOf("\n@@")) };
}

const SQLITE_WARNING = "SQLite is an experimental feature and might change at any time";
const WARN = 13;
const ERROR = 17;

test("console bridge: an ExperimentalWarning is one WARN record (13, WARN) whose body is exactly what Node printed, and no ERROR record", { timeout: 60_000 }, () => {
  const { records, stderr } = bridgedRun({ scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");` });
  assert.equal(records.length, 1, "one record, not one at WARN and another at ERROR");
  const [record] = records;
  assert.equal(record!.severityNumber, WARN);
  assert.equal(record!.severityText, "WARN");
  assert.match(record!.body, /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time/);
  assert.equal(record!.body, stderr.replace(/\n$/, ""), "the body is the text Node wrote to stderr, byte for byte");
  assert.deepEqual(record!.attributes, {}, "no attribute is derived from the warning");
});

test("console bridge: ordinary console lines keep their level, an error line that looks like a warning included", { timeout: 60_000 }, () => {
  const lookalike = `(node:1) ExperimentalWarning: ${SQLITE_WARNING}`;
  const { records } = bridgedRun({
    scenario: `
      console.error("plain failure");
      console.error("[factory-desk] hop-watch failed:", new Error("boom"));
      console.error(${JSON.stringify(lookalike)});
      console.warn("careful");
      console.info("fyi");
      console.log("hello");
      console.debug("detail");
    `,
  });
  assert.deepEqual(
    records.map((r) => [r.severityNumber, r.severityText]),
    [[ERROR, "ERROR"], [ERROR, "ERROR"], [ERROR, "ERROR"], [WARN, "WARN"], [9, "INFO"], [9, "INFO"], [5, "DEBUG"]]
  );
  assert.equal(records[2]!.body, lookalike, "text alone does not make a console.error a warning");
});

test("console bridge: a console.error right after a warning is an error again, and each warning is its own record", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    scenario: `
      process.emitWarning("first", "ExperimentalWarning");
      await new Promise((resolve) => setImmediate(resolve));
      console.error("after the warning");
      process.emitWarning("second", { type: "DeprecationWarning", code: "DEP_TEST", detail: "some detail" });
      await new Promise((resolve) => setImmediate(resolve));
      console.error("after the second");
    `,
  });
  assert.deepEqual(
    records.map((r) => r.severityNumber),
    [WARN, ERROR, WARN, ERROR]
  );
  assert.match(records[0]!.body, /ExperimentalWarning: first/);
  assert.equal(records[1]!.body, "after the warning");
  assert.match(records[2]!.body, /^\(node:\d+\) \[DEP_TEST\] DeprecationWarning: second\nsome detail/, "the code and detail Node printed are in the body");
  assert.equal(records[3]!.body, "after the second");
});

test("console bridge: nothing is deduplicated beyond Node: the same warning emitted twice is two WARN records", { timeout: 60_000 }, () => {
  const { records, stderr } = bridgedRun({
    scenario: `
      process.emitWarning("again", "CustomWarning");
      await new Promise((resolve) => setImmediate(resolve));
      process.emitWarning("again", "CustomWarning");
    `,
  });
  assert.deepEqual(
    records.map((r) => r.severityNumber),
    [WARN, WARN]
  );
  assert.equal(stderr.split("CustomWarning: again").length - 1, 2, "Node printed it twice, so there are two records");
});

test("console bridge: a warning listener's own console.error is an error, only Node's print is a warning", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    scenario: `
      process.on("warning", (warning) => console.error("listener saw " + warning.name));
      process.emitWarning("seen", "CustomWarning");
    `,
  });
  assert.deepEqual(
    records.map((r) => [r.severityNumber, r.body.startsWith("(node:") ? "node" : r.body]),
    [[WARN, "node"], [ERROR, "listener saw CustomWarning"]]
  );
});

test("console bridge: a warning Node does not print is not exported, and does not relabel a later console.error, even one in Node's own shape", { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-redirect-"));
  try {
    for (const nodeArgs of [["--disable-warning=ExperimentalWarning"], ["--no-warnings"], [`--redirect-warnings=${join(dir, "warnings.log")}`]]) {
      const { records, stderr } = bridgedRun({
        nodeArgs,
        scenario: `
          process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");
          await new Promise((resolve) => setImmediate(resolve));
          console.error("(" + process.release.name + ":" + process.pid + ") ExperimentalWarning: " + ${JSON.stringify(SQLITE_WARNING)});
        `,
      });
      assert.deepEqual(
        records.map((r) => r.severityNumber),
        [ERROR],
        nodeArgs.join(" ")
      );
      assert.equal(stderr.split("ExperimentalWarning").length - 1, 1, `${nodeArgs.join(" ")}: only the console.error line was written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("console bridge: when --redirect-warnings cannot be opened, Node's fallback print is made inside its listener, so it is the one WARN", { timeout: 60_000 }, () => {
  const { records, stderr } = bridgedRun({
    nodeArgs: [`--redirect-warnings=${join(tmpdir(), "no-such-dir-for-bridge-test", "warnings.log")}`],
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.equal(records.length, 1, "Node's fallback print is exported once, not dropped");
  assert.equal(records[0]!.severityNumber, WARN);
  assert.match(records[0]!.body, /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/);
  assert.equal(records[0]!.body, stderr.replace(/\n$/, ""));
});

test("console bridge: when a --redirect-warnings write fails later, Node's fallback print comes after the window and is exported as ERROR, not dropped", { timeout: 60_000, skip: !existsSync("/dev/full") }, () => {
  const { records, stderr } = bridgedRun({
    nodeArgs: ["--redirect-warnings=/dev/full"],
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.equal(records.length, 1, "Node's fallback print is exported once, not dropped");
  assert.equal(records[0]!.severityNumber, ERROR);
  assert.match(records[0]!.body, /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/);
  assert.equal(records[0]!.body, stderr.replace(/\n$/, ""));
});

test("console bridge: a listener registered before the bridge that logs a string, or String(warning), is an error, under default flags and --no-warnings", { timeout: 60_000 }, () => {
  const before = `
    process.on("warning", (warning) => {
      console.error("my handler: " + String(warning));
      console.error(String(warning));
      console.error("an arbitrary line");
    });
  `;
  const scenario = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const summary = (records: BridgedRecord[]) => records.map((r) => [r.severityNumber, r.body.startsWith("(node:") ? "node" : r.body]);
  const listenerLines = [
    [ERROR, `my handler: ExperimentalWarning: ${SQLITE_WARNING}`],
    [ERROR, `ExperimentalWarning: ${SQLITE_WARNING}`],
    [ERROR, "an arbitrary line"],
  ];

  const printed = bridgedRun({ before, scenario });
  assert.deepEqual(summary(printed.records), [[WARN, "node"], ...listenerLines], "default flags: only Node's own print is WARN");

  const silent = bridgedRun({ before, scenario, nodeArgs: ["--no-warnings"] });
  assert.deepEqual(summary(silent.records), listenerLines, "--no-warnings: Node prints nothing, so nothing is WARN");
});

test("console bridge: the limit: a listener registered before the bridge that writes Node's exact shape through console.error takes the WARN only when Node prints nothing; under default flags Node's print matches first and the listener's line is ERROR", { timeout: 60_000 }, () => {
  const before = `
    process.on("warning", (warning) => {
      const line = "(" + process.release.name + ":" + process.pid + ") " + String(warning);
      console.log(line);
      console.error(line);
      console.warn(line);
    });
  `;
  const scenario = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const printed = bridgedRun({ before, scenario });
  assert.deepEqual(
    printed.records.map((r) => r.severityNumber),
    [WARN, 9, ERROR, WARN],
    "Node prints: its print takes the WARN and closes the window before the listener runs"
  );
  const silent = bridgedRun({ before, scenario, nodeArgs: ["--no-warnings"] });
  assert.deepEqual(
    silent.records.map((r) => r.severityNumber),
    [9, WARN, WARN],
    "Node prints nothing: nothing closes the window before the listener, so its console.error takes the WARN"
  );
});

test("console bridge: a warning whose toString throws on its first call crashes Node's own listener exactly as without the bridge: nothing is printed and nothing is exported", { timeout: 60_000 }, () => {
  const before = `process.on("uncaughtException", (e) => probes.push(e.message));`;
  const scenario = `
    const warning = new Error("odd");
    warning.name = "CustomWarning";
    let calls = 0;
    warning.toString = () => {
      if (calls++ === 0) throw new Error("toString failed");
      return "CustomWarning: odd";
    };
    process.emitWarning(warning);
  `;
  for (const bridge of [false, true]) {
    const { records, probes, stderr } = bridgedRun({ before, scenario, bridge });
    assert.deepEqual(probes, ["toString failed"], `bridge ${bridge}: the first toString call is Node's, and its throw reaches the handler`);
    assert.equal(stderr, "", `bridge ${bridge}: nothing printed`);
    assert.deepEqual(records, [], `bridge ${bridge}: nothing exported, no WARN`);
  }
});

test("console bridge: the bridge never runs the warning's own code: a counting toString, or a name or message getter, prints what Node prints without the bridge, and stays ERROR", { timeout: 120_000 }, () => {
  const cases: Record<string, string> = {
    "counting toString": `warning.toString = () => "CustomWarning: odd " + n++;`,
    "name getter": `Object.defineProperty(warning, "name", { get: () => "CustomWarning " + n++ });`,
    "message getter": `Object.defineProperty(warning, "message", { get: () => "odd " + n++ });`,
  };
  const normalize = (text: string) => text.replace(/\(node:\d+\)/g, "(node:N)");
  for (const [name, setup] of Object.entries(cases)) {
    const scenario = `
      let n = 0;
      const warning = new Error("odd");
      warning.name = "CustomWarning";
      ${setup}
      process.emitWarning(warning);
    `;
    const plain = bridgedRun({ scenario, bridge: false });
    const bridged = bridgedRun({ scenario });
    if (name === "counting toString") assert.match(plain.stderr, /CustomWarning: odd 0\n/, "Node's own first call sees the count at 0");
    assert.equal(normalize(bridged.stderr), normalize(plain.stderr), `${name}: same text with and without the bridge`);
    assert.deepEqual(bridged.records.map((r) => r.severityNumber), [ERROR], name);
    assert.equal(bridged.records[0]!.body, bridged.stderr.replace(/\n$/, ""), name);
  }
});

test("console bridge: a listener ahead of Node's that changes name or message leaves Node's print ERROR (the text is read once), and a later on-listener's original-shape line then takes the WARN", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    before: `
      process.prependListener("warning", (warning) => { warning.name = "ChangedWarning"; });
      process.on("warning", () => console.error("(" + process.release.name + ":" + process.pid + ") ExperimentalWarning: ${SQLITE_WARNING}"));
    `,
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.deepEqual(
    records.map((r) => [r.severityText, r.body.replace(/^\(node:\d+\) /, "").split(":")[0]]),
    [["ERROR", "ChangedWarning"], ["WARN", "ExperimentalWarning"]]
  );
});

test("console bridge: matcher: inside the window and ahead of Node's print, console.log and console.info keep their level, a console.error with an extra argument or other text stays ERROR, and Node's print is the WARN", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    before: `
      process.prependListener("warning", (warning) => {
        const line = "(" + process.release.name + ":" + process.pid + ") " + String(warning);
        console.log(line);
        console.info(line);
        console.error(line, "extra");
        console.error("(" + process.release.name + ":" + process.pid + ") something else");
      });
    `,
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.deepEqual(
    records.map((r) => r.severityNumber),
    [9, 9, ERROR, ERROR, WARN],
    "console.log and console.info keep their level; a Node-shaped console.error with a second argument, or with other text, is an error; Node's own print is the WARN"
  );
});

test("console bridge: every warning listener runs inside the window, so a Node-shaped console.error takes the WARN only while no line in the dispatch has matched yet", { timeout: 120_000 }, () => {
  const line = `const L = () => "(" + process.release.name + ":" + process.pid + ") ExperimentalWarning: ${SQLITE_WARNING}";`;
  const emit = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const positions: Record<string, { before: string; scenario: string }> = {
    "prepended before the bridge": { before: `${line} process.prependListener("warning", () => console.error(L()));`, scenario: emit },
    "on before the bridge": { before: `${line} process.on("warning", () => console.error(L()));`, scenario: emit },
    "prepended after the bridge": { before: line, scenario: `process.prependListener("warning", () => console.error(L())); ${emit}` },
    "on after the bridge": { before: line, scenario: `process.on("warning", () => console.error(L())); ${emit}` },
  };
  const seen = (records: BridgedRecord[]) => records.map((r) => `${r.body.includes("\n(Use ") ? "node" : "listener"} ${r.severityText}`);
  const expected: Record<string, { printed: string[]; silent: string[] }> = {
    "prepended before the bridge": { printed: ["listener WARN", "node ERROR"], silent: ["listener WARN"] },
    "on before the bridge": { printed: ["node WARN", "listener ERROR"], silent: ["listener WARN"] },
    "prepended after the bridge": { printed: ["listener WARN", "node ERROR"], silent: ["listener WARN"] },
    "on after the bridge": { printed: ["node WARN", "listener ERROR"], silent: ["listener WARN"] },
  };
  for (const [name, { before, scenario }] of Object.entries(positions)) {
    assert.deepEqual(seen(bridgedRun({ before, scenario }).records), expected[name]!.printed, `${name}, default flags`);
    assert.deepEqual(seen(bridgedRun({ before, scenario, nodeArgs: ["--no-warnings"] }).records), expected[name]!.silent, `${name}, --no-warnings`);
  }
});

test("console bridge: --trace-warnings and --trace-deprecation print warning.stack: a stack header equal to toString() is still the WARN, a header that differs stays ERROR", { timeout: 60_000 }, () => {
  const traced = bridgedRun({
    nodeArgs: ["--trace-warnings"],
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.deepEqual(traced.records.map((r) => r.severityNumber), [WARN]);
  assert.match(traced.records[0]!.body, /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n {4}at /, "the stack, not toString(), is what Node printed");

  const deprecation = bridgedRun({
    nodeArgs: ["--trace-deprecation"],
    scenario: `process.emitWarning("old api", "DeprecationWarning", "DEP_TEST");`,
  });
  assert.deepEqual(deprecation.records.map((r) => r.severityNumber), [WARN]);
  assert.match(deprecation.records[0]!.body, /^\(node:\d+\) \[DEP_TEST\] DeprecationWarning: old api\n {4}at /);

  // V8 formats the stack header when .stack is first read, so a header differs
  // from toString() only if something read it before name or message changed, or
  // if toString is custom.
  const differing: Record<string, { code: string; header: RegExp }> = {
    "name changed after .stack was read": { code: `void warning.stack; warning.name = "CustomWarning";`, header: /^\(node:\d+\) Error: odd\n {4}at / },
    "message changed after .stack was read": { code: `void warning.stack; warning.message = "changed";`, header: /^\(node:\d+\) Error: odd\n {4}at / },
    "custom toString": { code: `warning.toString = () => "Custom: not the stack header";`, header: /^\(node:\d+\) Error: odd\n {4}at / },
  };
  for (const [name, { code, header }] of Object.entries(differing)) {
    const differs = bridgedRun({
      nodeArgs: ["--trace-warnings"],
      scenario: `
        const warning = new Error("odd");
        ${code}
        process.emitWarning(warning);
      `,
    });
    assert.deepEqual(differs.records.map((r) => r.severityNumber), [ERROR], name);
    assert.match(differs.records[0]!.body, header, `${name}: Node printed the stack, whose header toString() no longer matches`);
  }

  const mutatedBeforeRead = bridgedRun({
    nodeArgs: ["--trace-warnings"],
    scenario: `
      const warning = new Error("odd");
      warning.name = "CustomWarning";
      process.emitWarning(warning);
    `,
  });
  assert.deepEqual(mutatedBeforeRead.records.map((r) => r.severityNumber), [WARN], "a name set before .stack is first read is in the header");

  const untraced = bridgedRun({
    scenario: `
      const warning = new Error("odd");
      warning.name = "CustomWarning";
      process.emitWarning(warning);
    `,
  });
  assert.deepEqual(untraced.records.map((r) => r.severityNumber), [WARN], "without a trace flag Node prints toString(), so the same warning is the WARN");
});

test("console bridge: a toString() that returns a non-string stays ERROR, and Node's print is still exported", { timeout: 60_000 }, () => {
  const { records, stderr } = bridgedRun({
    scenario: `
      const warning = new Error("odd");
      warning.name = "CustomWarning";
      warning.toString = () => 42;
      process.emitWarning(warning);
    `,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.severityNumber, ERROR);
  assert.match(records[0]!.body, /^\(node:\d+\) 42/);
  assert.equal(records[0]!.body, stderr.replace(/\n$/, ""));
});

test("console bridge: when Node's print did not match (--trace-warnings and a name changed after .stack was read), the window stays open, so an on-before-the-bridge listener's Node-shaped console.error takes the WARN", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    nodeArgs: ["--trace-warnings"],
    before: `
      process.on("warning", (warning) => {
        console.error("(" + process.release.name + ":" + process.pid + ") " + Error.prototype.toString.call(warning));
      });
    `,
    scenario: `
      const warning = new Error("odd");
      warning.stack;
      warning.name = "CustomWarning";
      process.emitWarning(warning);
    `,
  });
  assert.deepEqual(
    records.map((r) => [r.severityText, r.body.split("\n")[0]!.replace(/\(node:\d+\)/, "(node:N)")]),
    [["ERROR", "(node:N) Error: odd"], ["WARN", "(node:N) CustomWarning: odd"]],
    "Node's unmatched stack print is ERROR; the window is still open for the later listener"
  );
});

test("console bridge: the window is exactly the synchronous dispatch: after a listener throws, an uncaughtException handler, an already-queued nextTick, a microtask queued by an earlier listener, and a later timer all stay ERROR", { timeout: 60_000 }, () => {
  const nodeShaped = `"(" + process.release.name + ":" + process.pid + ") ExperimentalWarning: " + ${JSON.stringify(SQLITE_WARNING)}`;
  const emit = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const cases: Record<string, { before: string; scenario: string }> = {
    "20 ms later": {
      before: `process.on("uncaughtException", () => {}); process.prependListener("warning", () => { throw new Error("listener failed"); });`,
      scenario: `${emit} await new Promise((resolve) => setTimeout(resolve, 20)); console.error(${nodeShaped});`,
    },
    "the uncaughtException handler": {
      before: `process.on("uncaughtException", () => console.error(${nodeShaped})); process.prependListener("warning", () => { throw new Error("listener failed"); });`,
      scenario: emit,
    },
    "a nextTick queued after emitWarning": {
      before: `process.on("uncaughtException", () => {}); process.prependListener("warning", () => { throw new Error("listener failed"); });`,
      scenario: `${emit} process.nextTick(() => console.error(${nodeShaped}));`,
    },
    "a nextTick queued by the throwing listener": {
      before: `process.on("uncaughtException", () => {}); process.prependListener("warning", () => { process.nextTick(() => console.error(${nodeShaped})); throw new Error("listener failed"); });`,
      scenario: emit,
    },
    "a microtask queued by a listener prepended after the bridge": {
      before: `process.on("uncaughtException", () => {}); process.prependListener("warning", () => { throw new Error("listener failed"); });`,
      scenario: `process.prependListener("warning", () => queueMicrotask(() => console.error(${nodeShaped}))); ${emit}`,
    },
  };
  for (const [name, { before, scenario }] of Object.entries(cases)) {
    const { records, stderr } = bridgedRun({ before, scenario });
    assert.deepEqual(
      records.map((r) => r.severityNumber),
      [ERROR],
      name
    );
    assert.equal(stderr.split("ExperimentalWarning").length - 1, 1, `${name}: only the scenario's own line was written; Node's print never ran`);
  }
});

test("console bridge: a listener that re-emits warning synchronously with process.emit gets its own window for the inner warning, and Node's outer print stays the WARN", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    before: `
      let inner = false;
      process.prependListener("warning", () => {
        if (inner) return;
        inner = true;
        const second = new Error("inner");
        second.name = "CustomWarning";
        process.emit("warning", second);
      });
    `,
    scenario: `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`,
  });
  assert.deepEqual(
    records.map((r) => [r.severityText, r.body.split("\n")[0]!.replace(/\(node:\d+\)/, "(node:N)")]),
    [["WARN", "(node:N) CustomWarning: inner"], ["WARN", `(node:N) ExperimentalWarning: ${SQLITE_WARNING}`]],
    "each warning's own print is the WARN; the inner re-emit does not take the outer one"
  );
});

test("console bridge: the process.emit wrapper passes every event through: arguments, this, return value and throws are emit's own", { timeout: 60_000 }, () => {
  const { records, probes } = bridgedRun({
    scenario: `
      const boom = new Error("boom");
      let seen;
      process.on("custom", function (a, b) { seen = [this === process, a, b]; });
      probes.push(["custom returns", process.emit("custom", 1, "two")]);
      probes.push(["custom seen", seen]);
      probes.push(["nobody returns", process.emit("nobody")]);
      let thrown;
      const thrower = () => { throw boom; };
      process.on("custom2", thrower);
      try { process.emit("custom2"); } catch (e) { thrown = e; }
      probes.push(["custom throw propagates", thrown === boom]);
      let warningThis;
      process.on("warning", function () { warningThis = this === process; });
      const w = new Error("w");
      w.name = "CustomWarning";
      probes.push(["warning returns", process.emit("warning", w)]);
      probes.push(["warning this", warningThis]);
      probes.push(["non-error warning returns", typeof process.emit("warning", "not an error")]);
      process.removeAllListeners("warning");
      process.on("warning", thrower);
      thrown = undefined;
      try { process.emit("warning", w); } catch (e) { thrown = e; }
      probes.push(["warning throw propagates", thrown === boom]);
    `,
  });
  assert.deepEqual(probes, [
    ["custom returns", true],
    ["custom seen", [true, 1, "two"]],
    ["nobody returns", false],
    ["custom throw propagates", true],
    ["warning returns", true],
    ["warning this", true],
    ["non-error warning returns", "boolean"],
    ["warning throw propagates", true],
  ]);
  assert.deepEqual(records.map((r) => r.severityNumber), [WARN], "the one real warning dispatch printed once, as the WARN");
});

test("console bridge: July's proper-lockfile (signal-exit@3 wraps process.emit at load) chains with the bridge in either load order: Node's print is one WARN", { timeout: 120_000 }, () => {
  const emit = `process.emitWarning(${JSON.stringify(SQLITE_WARNING)}, "ExperimentalWarning");`;
  const load = `await import("proper-lockfile");`;
  for (const [order, input] of [
    ["before the bridge", { before: load, scenario: emit }],
    ["after the bridge", { scenario: `${load} ${emit}` }],
  ] as const) {
    const { records } = bridgedRun(input);
    assert.deepEqual(records.map((r) => r.severityNumber), [WARN], `proper-lockfile loaded ${order}`);
  }
});

test("console bridge: a line July prints for the OTel SDK's own diag (an export failure) is printed and not exported, so a failing export cannot feed itself; every other line is exported", { timeout: 60_000 }, () => {
  const { records, stderr, stdout } = bridgedRunWithStdout({
    scenario: `
      diag.setLogger({ error: (m) => console.log("[bdk:otel] error: " + m), warn: (m) => console.log("[bdk:otel] warn: " + m), info: () => undefined, debug: () => undefined, verbose: () => undefined });
      diag.error("export failed 401");
      console.log("app line");
      diag.warn("slow export");
      console.log("another app line");
    `,
  });
  assert.deepEqual(records.map((r) => r.body), ["app line", "another app line"]);
  assert.match(stdout, /\[bdk:otel\] error: export failed 401/);
  assert.match(stdout, /\[bdk:otel\] warn: slow export/);
  assert.equal(stderr, "");
});

test("console bridge: a nested diag call leaves the outer call's later console.log exported", { timeout: 60_000 }, () => {
  const { records } = bridgedRun({
    scenario: `
      diag.setLogger({
        error: (m) => { console.log("outer " + m); diag.warn("inner"); console.log("outer again " + m); },
        warn: (m) => console.log("inner " + m),
        info: () => undefined, debug: () => undefined, verbose: () => undefined,
      });
      diag.error("e");
      console.log("after");
    `,
  });
  assert.deepEqual(records.map((r) => r.body), ["after"]);
});

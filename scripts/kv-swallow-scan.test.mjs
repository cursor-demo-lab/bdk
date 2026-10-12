import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// KV Phase 1 K7: no kv failure is swallowed silently. A kv call whose
// failure the code ignores must say so with `warnKv(site, error)`
// (agent/lib/ops-funnel.ts), which logs one structured line and feeds the ops
// funnel. Run with the compiler's own types over each agent's program (tests,
// fixtures, and testing/ aside), this fails on:
//
// - a rejection handler (`.catch(h)`, or the second argument of `.then`) on
//   a promise whose expression makes a kv call, when the handler neither
//   throws nor reports (warnKv, warnKvUnavailable, warnStep, a `log` / `warn`
//   / `refused` call, or console), whatever its parameters or return value.
//   A named handler is resolved to its declaration; one that cannot be
//   resolved counts as a swallow;
// - `Promise.allSettled(…)` over a kv call whose results are dropped;
// - a `catch` clause around a kv call that neither throws nor reports.
//
// A kv call is a method of July's HostKvApi / HostKvCasApi or the agent's
// KeyedKv (get, put, delete, and the CAS calls), or a function exported by one
// of the shared kv helpers (KV_HELPER_FILES), anywhere in the expression or
// try block, nested arrows included (their rejections reach the enclosing
// promise). A receiver or allSettled argument that is an identifier is
// followed to its variable's initializer in the same function.
//
// Accepted by design: a one-hop kv wrapper (a local function that calls kv,
// swallowed at its call site) is not followed, and a catch that only logs
// (console.*, log, warn) counts as reporting. The negative fixtures at the
// bottom must each be caught; the control must pass.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROJECTS = ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"];
const STORE_TYPES = new Set(["KeyedKv", "HostKvApi", "HostKvCasApi"]);
const KV_HELPER_FILES = new Set(["kv-verified.ts", "kv-verified-desk.ts", "claim-lease.ts", "kv-index.ts", "verified-claim.ts"]);
const REPORTERS = new Set(["warnKv", "warnKvUnavailable", "warnStep", "log", "warn", "refused"]);
// A handler that is one of these on `console` (`.catch(console.error)`) reports too.
const CONSOLE_REPORTERS = new Set(["log", "warn", "error", "info"]);

function loadTypeScript() {
  for (const project of PROJECTS) {
    try {
      return createRequire(join(ROOT, project, "package.json"))("typescript");
    } catch {
      // Not installed in this project; try the next.
    }
  }
  throw new Error(`typescript is not installed in any of ${PROJECTS.join(", ")}; run npm ci --prefix factory-desk`);
}

const ts = loadTypeScript();

/** The agent's program as `npm run check` sees it, plus `extra` in-memory files (path relative to the project). */
function programFor(project, extra = {}) {
  const dir = join(ROOT, project);
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile).config, ts.sys, dir);
  const virtual = new Map(Object.entries(extra).map(([path, text]) => [join(dir, path), text]));
  const host = ts.createCompilerHost(config.options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (path) => virtual.has(path) || fileExists.call(host, path);
  host.readFile = (path) => virtual.get(path) ?? readFile.call(host, path);
  host.getSourceFile = (path, language, onError, create) =>
    virtual.has(path) ? ts.createSourceFile(path, virtual.get(path), language, true) : getSourceFile.call(host, path, language, onError, create);
  return ts.createProgram([...config.fileNames, ...virtual.keys()], config.options, host);
}

function isAgentSource(input) {
  const agent = join(ROOT, input.project, "agent") + "/";
  const file = input.fileName;
  return file.startsWith(agent) && !file.endsWith(".test.ts") && !file.includes(".fixtures.") && !file.includes("/testing/");
}

function isKvCall(checker, call) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined) return false;
  const file = declaration.getSourceFile().fileName;
  if (ts.isFunctionDeclaration(declaration) && KV_HELPER_FILES.has(file.slice(file.lastIndexOf("/") + 1))) return true;
  let owner = declaration.parent;
  while (owner !== undefined && !ts.isInterfaceDeclaration(owner) && !ts.isTypeAliasDeclaration(owner)) owner = owner.parent;
  return owner !== undefined && STORE_TYPES.has(owner.name.text);
}

/** The first kv call anywhere under `node`, nested functions included: their rejections reach the enclosing promise. */
function kvCallIn(checker, node) {
  let found;
  const walk = (child) => {
    if (found !== undefined) return;
    if (ts.isCallExpression(child) && isKvCall(checker, child)) {
      found = child;
      return;
    }
    ts.forEachChild(child, walk);
  };
  walk(node);
  return found;
}

/** Whether `node` throws or calls a reporter (REPORTERS, or console), outside nested functions. */
function reports(node) {
  let found = false;
  const walk = (child) => {
    if (found) return;
    if (ts.isThrowStatement(child)) found = true;
    else if (ts.isCallExpression(child)) {
      const callee = child.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      const onConsole = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console";
      if (onConsole || (name !== undefined && REPORTERS.has(name))) found = true;
    }
    if (!found && (child === node || !ts.isFunctionLike(child))) ts.forEachChild(child, walk);
  };
  walk(node);
  return found;
}

/** The function a handler expression names: inline, or a declaration its identifier resolves to; undefined when it cannot be resolved. */
function handlerFunction(checker, handler) {
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) return handler;
  if (REPORTERS.has(ts.isIdentifier(handler) ? handler.text : ts.isPropertyAccessExpression(handler) ? handler.name.text : "")) return handler;
  if (ts.isPropertyAccessExpression(handler) && ts.isIdentifier(handler.expression) && handler.expression.text === "console" && CONSOLE_REPORTERS.has(handler.name.text)) return handler;
  let symbol = checker.getSymbolAtLocation(handler);
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol?.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return declaration.initializer;
  }
  return undefined;
}

/** A rejection handler: `.catch(h)` or the second argument of `.then(ok, h)`. */
function rejectionHandler(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const method = node.expression.name.text;
  if (method === "catch") return node.arguments[0];
  if (method === "then") return node.arguments[1];
  return undefined;
}

/** A handler that neither throws nor reports swallows the rejection, whatever its parameters or its return value. */
function swallowsRejection(checker, handler) {
  const fn = handlerFunction(checker, handler);
  if (fn === undefined) return true;
  if (!ts.isFunctionLike(fn)) return false;
  return fn.body === undefined || !reports(fn.body);
}

function enclosingFunction(node) {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) return cur;
  return undefined;
}

function unwrap(expression) {
  let cur = expression;
  while (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
  return cur;
}

/**
 * The first kv call in `expression`, or, when it is an identifier (a promise
 * held in a variable, `const p = kv.delete(k); … p.catch(…)`), in the
 * initializer of its variable declared in the same function, following such
 * identifiers a few hops. An array literal's elements are followed the same way.
 */
function kvCallThrough(checker, expression) {
  const direct = kvCallIn(checker, expression);
  if (direct !== undefined) return direct;
  const scope = enclosingFunction(expression);
  const follow = (node, hops) => {
    const bare = unwrap(node);
    if (ts.isArrayLiteralExpression(bare)) {
      for (const element of bare.elements) {
        const found = follow(element, hops);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!ts.isIdentifier(bare) || hops === 0) return undefined;
    const declaration = checker.getSymbolAtLocation(bare)?.valueDeclaration;
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined || enclosingFunction(declaration) !== scope) return undefined;
    return kvCallIn(checker, declaration.initializer) ?? follow(declaration.initializer, hops - 1);
  };
  return follow(expression, 3);
}

/** Whether the variable `declaration` names is read anywhere in `scope` besides its own declaration. */
function isRead(checker, input) {
  const symbol = checker.getSymbolAtLocation(input.declaration.name);
  let read = false;
  const walk = (child) => {
    if (read) return;
    if (ts.isIdentifier(child) && child !== input.declaration.name && checker.getSymbolAtLocation(child) === symbol) read = true;
    else ts.forEachChild(child, walk);
  };
  walk(input.scope);
  return read;
}

/** `Promise.allSettled(…)` whose settled results are dropped: a bare statement, or a variable that is never read. */
function isDroppedAllSettled(checker, node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "allSettled") return false;
  if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "Promise") return false;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent) || ts.isVoidExpression(parent)) parent = parent.parent;
  if (ts.isExpressionStatement(parent)) return true;
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return false;
  const scope = enclosingFunction(parent);
  return scope !== undefined && !isRead(checker, { declaration: parent, scope });
}

function swallows(program, project) {
  const checker = program.getTypeChecker();
  const found = [];
  for (const source of program.getSourceFiles()) {
    if (!isAgentSource({ project, fileName: source.fileName })) continue;
    const at = (node) => `${relative(ROOT, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = (node) => {
      const handler = rejectionHandler(node);
      if (handler !== undefined && swallowsRejection(checker, handler)) {
        const call = kvCallThrough(checker, node.expression.expression);
        if (call !== undefined) found.push(`${at(node)} ${call.expression.getText(source)}(…) has a rejection handler that swallows a kv failure; use (error: unknown) => warnKv(site, error)`);
      } else if (isDroppedAllSettled(checker, node)) {
        const call = node.arguments.map((arg) => kvCallThrough(checker, arg)).find((found) => found !== undefined);
        if (call !== undefined) found.push(`${at(node)} Promise.allSettled drops the failure of ${call.expression.getText(source)}(…); read the results and warnKv the rejected ones`);
      } else if (ts.isTryStatement(node) && node.catchClause !== undefined && !reports(node.catchClause.block)) {
        const call = kvCallIn(checker, node.tryBlock);
        if (call !== undefined) found.push(`${at(node.catchClause)} a silent catch around ${call.expression.getText(source)}(…); call warnKv(site, error) in it`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

for (const project of PROJECTS) {
  test(`${project}: no kv failure is swallowed without warnKv`, () => {
    assert.deepEqual(swallows(programFor(project), project), []);
  });
}

const PROBE = "agent/lib/swallow-probe.ts";
const HEADER = `import { ticketKey, type KeyedKv } from "./kv-keys.js";
import { deleteVerified, updateVerified } from "./kv-verified.js";
import { warnKv } from "./ops-funnel.js";
`;
const NEGATIVES = {
  "catch-undefined": "export async function a(kv: KeyedKv) { return kv.get(ticketKey('X-1')).catch(() => undefined); }",
  "catch-empty-block": "export async function b(kv: KeyedKv) { await kv.put(ticketKey('X-1'), 1).catch(() => {}); }",
  "catch-null-on-helper": "export async function c(kv: KeyedKv) { await deleteVerified(kv, ticketKey('X-1'), () => true).catch(() => null); }",
  "catch-return-void": "export async function d(kv: KeyedKv) { await kv.delete(ticketKey('X-1')).catch(function () { return; }); }",
  "catch-with-param": "export async function h(kv: KeyedKv) { return kv.get(ticketKey('X-1')).catch((_error: unknown) => undefined); }",
  "catch-object": "export async function i(kv: KeyedKv) { return kv.get(ticketKey('X-1')).catch(() => ({})); }",
  "catch-array": "export async function j(kv: KeyedKv) { return kv.get(ticketKey('X-1')).catch(() => []); }",
  "catch-value": "export async function k(kv: KeyedKv) { return kv.get(ticketKey('X-1')).then(() => 'ok').catch(() => 'failed'); }",
  "catch-noop-identifier": "const noop = () => {};\nexport async function l(kv: KeyedKv) { await kv.delete(ticketKey('X-1')).catch(noop); }",
  "catch-noop-declaration": "function ignore(_error: unknown): void {}\nexport async function m(kv: KeyedKv) { await kv.delete(ticketKey('X-1')).catch(ignore); }",
  "then-second-argument": "export async function n(kv: KeyedKv) { return kv.get(ticketKey('X-1')).then((value) => value, () => undefined); }",
  "nested-arrow": "export async function o(kv: KeyedKv) { const keys = [ticketKey('X-1'), ticketKey('X-2')]; await Promise.all(keys.map((key) => kv.delete(key))).catch(() => undefined); }",
  "all-settled": "export async function p(kv: KeyedKv) { await Promise.allSettled([kv.put(ticketKey('X-1'), 1)]); }",
  "silent-clause": "export async function e(kv: KeyedKv) { try { await kv.delete(ticketKey('X-1')); } catch { /* ignored */ } }",
  "silent-clause-return": "export async function f(kv: KeyedKv) { try { return await updateVerified(kv, ticketKey('X-1'), () => 1); } catch (error) { return undefined; } }",
  "silent-clause-nested-arrow": "export async function q(kv: KeyedKv) { try { await Promise.all([ticketKey('X-1')].map((key) => kv.delete(key))); } catch { return false; } return true; }",
  "held-promise": "export async function r(kv: KeyedKv) { const pending = kv.delete(ticketKey('X-1')); await pending.catch(() => undefined); }",
  "held-array-all-settled": "export async function s(kv: KeyedKv) { const writes = [kv.put(ticketKey('X-1'), 1)]; await Promise.allSettled(writes); }",
  "assigned-all-settled-unread": "export async function t(kv: KeyedKv) { const settled = await Promise.allSettled([kv.put(ticketKey('X-1'), 1)]); return true; }",
  "destructured-store": "export async function g({ kv }: { kv: KeyedKv }) { const { put } = kv; try { await put(ticketKey('X-1'), 1); } catch {} }",
};
const CONTROL = `const report = (error: unknown) => warnKv("probe.named", error);
export async function ok(kv: KeyedKv) {
  await kv.get(ticketKey("X-1")).catch((error: unknown) => warnKv("probe.get", error));
  await kv.get(ticketKey("X-1")).then((value) => value, (error: unknown) => warnKv("probe.then", error));
  await kv.delete(ticketKey("X-1")).catch(report);
  await kv.delete(ticketKey("X-1")).catch((error: unknown) => {
    throw new Error("kept", { cause: error });
  });
  try {
    await kv.put(ticketKey("X-1"), 1);
  } catch (error) {
    warnKv("probe.put", error);
  }
  try {
    await kv.delete(ticketKey("X-1"));
  } catch (error) {
    throw new Error("kept", { cause: error });
  }
  const settled = await Promise.allSettled([kv.put(ticketKey("X-1"), 1)]);
  for (const result of settled) if (result.status === "rejected") warnKv("probe.settled", result.reason);
  await Promise.resolve(1).catch(() => undefined);
  await kv.delete(ticketKey("X-1")).catch(console.error);
  const held = kv.delete(ticketKey("X-1"));
  await held.catch((error: unknown) => warnKv("probe.held", error));
  let queue: Promise<unknown> = Promise.resolve();
  const next = queue.then(() => 1);
  queue = next.catch(() => undefined);
}
`;

for (const [name, body] of Object.entries(NEGATIVES)) {
  test(`the scan catches ${name}`, () => {
    const found = swallows(programFor("factory-desk", { [PROBE]: `${HEADER}${body}\n` }), "factory-desk").filter((line) => line.includes("swallow-probe.ts"));
    assert.equal(found.length, 1, found.join("\n"));
  });
}

test("the scan passes warnKv (inline, named, or on .then), a rethrow, read allSettled results, and a non-kv catch", () => {
  const found = swallows(programFor("factory-desk", { [PROBE]: `${HEADER}${CONTROL}` }), "factory-desk").filter((line) => line.includes("swallow-probe.ts"));
  assert.deepEqual(found, []);
});

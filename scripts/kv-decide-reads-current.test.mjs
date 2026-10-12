import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// ctx.host.kv has no compare-and-set, so the verified helpers re-read the
// key and hand what they find to a `decide` (or `matches`) callback. A
// callback that ignores that value overwrites or deletes whatever another
// writer stored since the caller's own read. So does a bare kv.delete or
// kv.put after a helper reported `lost` or `unavailable`. This scans every
// agent that keeps state in host.kv for both. A blind callback that is safe
// carries `// kv-decide-blind: <reason>` on the line above.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = ["factory-desk", "pr-autofixer", "factory-worker"];
/** Helper name to the index of its decide / matches argument. */
const HELPERS = new Map([
  ["updateVerified", 2],
  ["updateVerifiedDesk", 2],
  ["deleteVerified", 2],
]);
const WAIVER = /\/\/\s*kv-decide-blind:\s*\S/;

function loadTypeScript() {
  for (const project of PROJECTS) {
    const manifest = join(ROOT, project, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      return createRequire(manifest)("typescript");
    } catch {
      // Not installed in this project; try the next.
    }
  }
  throw new Error(`typescript is not installed in any of ${PROJECTS.join(", ")}; run npm ci --prefix factory-desk`);
}

const ts = loadTypeScript();

function agentSources(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "testing") walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.includes(".fixtures.")) {
        files.push(path);
      }
    }
  };
  for (const project of PROJECTS) {
    const agent = join(root, project, "agent");
    if (existsSync(agent)) walk(agent);
  }
  return files;
}

const isFunction = (node) => node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node));

function helperName(call, helpers) {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name !== undefined && helpers.has(name) ? name : undefined;
}

/** The nearest declaration of `name` in scope at `from`: a local, a function, or a parameter of an enclosing function. */
function declarationOf(name, from) {
  for (let node = from.parent; node !== undefined; node = node.parent) {
    if (isFunction(node)) {
      const index = node.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (index >= 0) return { parameterOf: node, index };
    }
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      for (const statement of node.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { node: statement };
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return { node: declaration };
          }
        }
      }
    }
  }
  return undefined;
}

function functionName(fn) {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return undefined;
}

/** The function whose parameter receives the stored value, or a reason it cannot be found. */
function resolveCallback(source, node) {
  if (isFunction(node)) return { fn: node };
  if (ts.isParenthesizedExpression(node)) return resolveCallback(source, node.expression);
  if (ts.isIdentifier(node)) {
    const found = declarationOf(node.text, node);
    if (found?.parameterOf !== undefined) {
      const wrapper = functionName(found.parameterOf);
      return wrapper === undefined ? { unresolved: `${node.text} is forwarded from an anonymous function` } : { forwarded: { wrapper, index: found.index } };
    }
    if (found !== undefined && ts.isFunctionDeclaration(found.node)) return { fn: found.node };
    if (found?.node.initializer !== undefined) return resolveCallback(source, found.node.initializer);
    return { unresolved: `cannot find ${node.text}` };
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const factory = resolveCallback(source, node.expression);
    if (factory.fn === undefined) return factory;
    const returned = returnedFunction(factory.fn);
    return returned === undefined ? { unresolved: `${node.expression.text}(...) does not return a function` } : { fn: returned };
  }
  return { unresolved: `unsupported callback ${ts.SyntaxKind[node.kind]}` };
}

function returnedFunction(fn) {
  if (fn.body === undefined) return undefined;
  if (!ts.isBlock(fn.body)) return isFunction(fn.body) ? fn.body : ts.isParenthesizedExpression(fn.body) && isFunction(fn.body.expression) ? fn.body.expression : undefined;
  let found;
  const visit = (node) => {
    if (found !== undefined || (node !== fn.body && isFunction(node))) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined && isFunction(node.expression)) found = node.expression;
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

function referencesParameter(fn) {
  const parameter = fn.parameters[0];
  if (parameter === undefined || fn.body === undefined) return false;
  const names = new Set();
  const bind = (name) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  bind(parameter.name);
  let used = false;
  const visit = (node) => {
    if (used) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const parent = node.parent;
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName) used = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return used;
}

function waived(source, lines, node) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  return line > 0 && WAIVER.test(lines[line - 1]);
}

const isBareKvWrite = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  (node.expression.name.text === "delete" || node.expression.name.text === "put") &&
  /(^|\.)kv$/i.test(node.expression.expression.getText());

const parse = (fileName, text) => ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/**
 * A parameter of a named enclosing function that `fn` calls with its own
 * stored-value parameter, as in `(current) => decide(current)`.
 */
function delegatedParameter(fn) {
  const parameter = fn.parameters[0];
  if (parameter === undefined || !ts.isIdentifier(parameter.name) || fn.body === undefined) return undefined;
  let found;
  const visit = (node) => {
    if (found !== undefined || (node !== fn.body && isFunction(node))) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === parameter.name.text)) {
      const declared = declarationOf(node.expression.text, fn);
      const wrapper = declared?.parameterOf === undefined ? undefined : functionName(declared.parameterOf);
      if (wrapper !== undefined) found = { wrapper, index: declared.index };
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

/**
 * A function that passes its own parameter straight through as a helper's
 * callback, or calls it on the stored value inside one, is a wrapper: its
 * callers' callbacks are checked the same way.
 */
function withWrappers(sources) {
  const helpers = new Map(HELPERS);
  for (let grew = true; grew; ) {
    grew = false;
    for (const source of sources) {
      const visit = (node) => {
        const name = ts.isCallExpression(node) ? helperName(node, helpers) : undefined;
        const argument = name === undefined ? undefined : node.arguments[helpers.get(name)];
        const resolved = argument === undefined ? undefined : resolveCallback(source, argument);
        const forwarded = resolved?.forwarded ?? (resolved?.fn === undefined ? undefined : delegatedParameter(resolved.fn));
        if (forwarded !== undefined && !helpers.has(forwarded.wrapper)) {
          helpers.set(forwarded.wrapper, forwarded.index);
          grew = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return helpers;
}

/** Findings for one parsed file: `line: message`. */
function lintParsed(source, helpers) {
  const lines = source.text.split("\n");
  const findings = [];
  const where = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  let helperCalls = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = helperName(node, helpers);
      if (name !== undefined) {
        helperCalls += 1;
        const argument = node.arguments[helpers.get(name)];
        if (argument !== undefined && !waived(source, lines, node) && !waived(source, lines, argument)) {
          const resolved = resolveCallback(source, argument);
          if (resolved.unresolved !== undefined) findings.push(`${where(argument)}: ${name} callback: ${resolved.unresolved}`);
          else if (resolved.fn !== undefined && resolved.fn.parameters.length === 0) findings.push(`${where(argument)}: ${name} callback takes no parameter, so it ignores the stored value`);
          else if (resolved.fn !== undefined && !referencesParameter(resolved.fn)) findings.push(`${where(argument)}: ${name} callback never reads its parameter (the stored value)`);
        }
      }
    }
    if (isFunction(node) && node.body !== undefined) {
      let afterHelper;
      const scan = (child) => {
        if (isFunction(child)) return;
        if (ts.isCallExpression(child)) {
          const name = helperName(child, helpers);
          if (name !== undefined && afterHelper === undefined) afterHelper = name;
          else if (afterHelper !== undefined && isBareKvWrite(child) && !waived(source, lines, child)) {
            findings.push(`${where(child)}: bare ${child.expression.getText()}( after ${afterHelper} in the same function; go through the verified helper with a matcher`);
          }
        }
        ts.forEachChild(child, scan);
      };
      ts.forEachChild(node.body, scan);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, helperCalls };
}

function lintSources(sources) {
  const helpers = withWrappers(sources);
  const findings = [];
  let helperCalls = 0;
  for (const source of sources) {
    const result = lintParsed(source, helpers);
    helperCalls += result.helperCalls;
    for (const finding of result.findings) findings.push(`${source.fileName}:${finding}`);
  }
  return { findings, helperCalls };
}

function lintTree(root) {
  return lintSources(agentSources(root).map((file) => parse(relative(root, file), readFileSync(file, "utf8"))));
}

const lintSource = (fileName, text) => lintSources([parse(fileName, text)]);

test("every decide / matches callback passed to a verified kv helper reads the stored value, and no bare kv write follows a helper", () => {
  const { findings, helperCalls } = lintTree(ROOT);
  assert.ok(helperCalls > 0, "no verified-helper calls found; the scan is looking in the wrong place");
  assert.deepEqual(findings, []);
});

test("the lint flags blind callbacks and bare writes, and accepts callbacks that read current or carry a waiver", () => {
  const flagged = (text) => lintSource("case.ts", text).findings.length;
  assert.equal(flagged("async function f(kv) { await updateVerifiedDesk(kv, k, () => ({ ts })); }"), 1);
  assert.equal(flagged("async function f(kv) { await updateVerified(kv, k, (_current) => value); }"), 1);
  assert.equal(flagged("async function f(kv) { await deleteVerified(kv, k, function () { return true; }); }"), 1);
  assert.equal(flagged("async function f(kv) { const r = await updateVerifiedDesk(kv, k, (c) => (c === undefined ? v : undefined)); if (r.status !== 'written') await kv.delete(k); }"), 1);
  assert.equal(flagged("async function f(ctx) { await updateVerifiedDesk(ctx.host.kv, k, (c) => c ?? v); await ctx.host.kv.put(k, v); }"), 1);
  assert.equal(flagged("const blind = () => v; async function f(kv) { await updateVerified(kv, k, blind); }"), 1);
  assert.equal(flagged("const older = (s) => (current) => s; async function f(kv) { await updateVerified(kv, k, older(true)); }"), 1);
  assert.equal(flagged("function wrap(kv, decide) { return updateVerified(kv, k, decide); } async function f(kv) { await wrap(kv, () => v); }"), 1);
  assert.equal(flagged("async function f(kv) { await updateVerified(kv, k, ...rest); }"), 1);
  assert.equal(flagged("async function once(kv, decide) { let seen; await updateVerified(kv, k, (current) => { seen = decide(current); return seen; }); } async function f(kv) { await once(kv, () => v); }"), 1);

  assert.equal(flagged("async function f(kv) { await updateVerifiedDesk(kv, k, (current) => (same(current) ? v : undefined)); }"), 0);
  assert.equal(flagged("const mine = (c) => c?.id === id; async function f(kv) { await deleteVerified(kv, k, mine); }"), 0);
  assert.equal(flagged("const older = (s) => (current) => (current === undefined || s ? v : undefined); async function f(kv) { await updateVerified(kv, k, older(true)); }"), 0);
  assert.equal(flagged("async function f(kv) {\n  // kv-decide-blind: the key was minted just above\n  await updateVerifiedDesk(kv, k, () => v);\n}"), 0);
  assert.equal(flagged("async function f(kv) { await kv.put(k, v); await updateVerified(kv, k, (c) => c); }"), 0);
  assert.equal(flagged("async function f(kv) { const t = { put: async (k, v) => { await kv.put(k, v); } }; await updateVerified(t, k, (c) => c); }"), 0);
  assert.equal(flagged("async function once(kv, decide) { let seen; await updateVerified(kv, k, (current) => { seen = decide(current); return seen; }); } async function f(kv) { await once(kv, (c) => c ?? v); }"), 0);
});

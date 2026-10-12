import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

register("./ts-resolve.mjs", import.meta.url);

// host.kv cannot list keys, so each agent's agent/lib/kv-keys.ts is the only
// inventory of what it stores. Keys there are typed KvKey, which only
// kv-keys.ts can make, and `npm run check` rejects a plain string wherever
// agent code hands a key to KeyedKv, a verified or lease helper, or an
// options field typed KvKey. This file is the backstop, run with the
// compiler's own types over each agent's program (tests and fixtures aside):
//
// - every call that reaches July's HostKvApi / HostKvCasApi or KeyedKv,
//   whatever the receiver is called, destructured, or narrowed by
//   supportsKvCas, passes a KvKey;
// - every `key` / `claimKey` field (shorthand too) in an object passed to one
//   of the agent's own functions is a KvKey;
// - nothing outside kv-keys.ts casts to KvKey or annotates HostKvApi, and no
//   literal there spells a registry key;
// - a KeyedKv, HostKvApi or HostKvCasApi, a Partial of one, or an object or
//   array carrying one (three levels deep), that is passed as an argument,
//   assigned or initialised into a declared type, put in an object literal,
//   returned, or cast, lands in one of those three types, a Partial of one,
//   or unknown, never a hand-written `{ put(key: string, …) }` that would
//   take any string to kv. It follows those flows only, and loses a store
//   that is first put in an unknown slot (then cast back out) or nested
//   deeper than three levels;
// - nothing typed any lands where a KvKey goes;
// - the registry is complete enough to act on, and each agent pins its name.
//
// The twenty-two negative fixtures at the bottom (thirteen ways, a to m) run
// through the same checks, in memory, and each must be rejected; one control
// must pass.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// The agent name is the kv root (`agentsdk/v1/<name>/kv/<key>`). These are the
// names every deployed slug has stored under; a change here moves all of it.
const PINNED = {
  "factory-desk": "factory-desk",
  "factory-worker": "factory-worker",
  planner: "planner",
  "pr-autofixer": "pr-autofixer",
  "security-reviewer": "security-reviewer",
  "triage-jira": "triage-jira",
};
const PROJECTS = Object.keys(PINNED);
// Plan M10: the permanent claims a reopened ticket or replay reads to refuse a repeat.
const KEEP = { "factory-desk": ["ticketKey"], "factory-worker": ["implementClaimKey", "prStatusClaimKey"], planner: ["planClaimKey", "commentClaimKey"] };
// keep keys that share a prefix with a transient builder. Each is safe only
// because sweepers match per builder, never per prefix (kv-keys.ts KeyEntry),
// and the transient builder's identity part (an issue key, [A-Z][A-Z0-9]+-\d+)
// can never spell `index` or `last-sweep`.
const KEEP_UNDER_TRANSIENT = new Set([
  "factory-desk HOP_WATCH_INDEX",
  "factory-desk BACKSTOP_SWEEP_KEY",
  "factory-worker IMPLEMENT_PR_INDEX",
  "factory-worker IMPLEMENT_PR_SWEEP_KEY",
  "factory-worker LAUNCH_WATCH_INDEX",
]);
const KV_METHODS = new Set(["get", "put", "delete", "getWithVersion", "putIfAbsent", "putIfVersion"]);
const JULY_KV_TYPES = new Set(["HostKvApi", "HostKvCasApi"]);
const KEY_FIELDS = new Set(["key", "claimKey"]);
const PRIMITIVES = new Set(["string", "number", "boolean", "bigint"]);

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

function isAgentSource(project, fileName) {
  const agent = join(ROOT, project, "agent") + "/";
  return fileName.startsWith(agent) && !fileName.endsWith(".test.ts") && !fileName.includes(".fixtures.") && !fileName.includes("/testing/") && !fileName.endsWith("/kv-keys.ts");
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function where(source, node) {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(ROOT, source.fileName)}:${line + 1}`;
}

function isKvKey(checker, node) {
  return isKvKeyType(checker, checker.getTypeAtLocation(node));
}

function isKvKeyType(checker, type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.every((part) => checker.getPropertyOfType(part, "__kvKey") !== undefined);
}

/** The interface or type alias a kv method signature belongs to, when it is July's or this agent's KeyedKv. */
function kvApiOf(declaration) {
  if (declaration === undefined || !(ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration))) return undefined;
  if (!ts.isIdentifier(declaration.name) || !KV_METHODS.has(declaration.name.text)) return undefined;
  const owner = declaration.parent;
  const file = declaration.getSourceFile().fileName;
  if (ts.isInterfaceDeclaration(owner) && JULY_KV_TYPES.has(owner.name.text) && file.includes("/@cursor/july/")) return owner.name.text;
  if (ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent) && owner.parent.name.text === "KeyedKv" && file.endsWith("/kv-keys.ts")) return "KeyedKv";
  return undefined;
}

/** Whether `type` is July's HostKvApi / HostKvCasApi or this agent's KeyedKv, by declaration, not by shape. */
function isKvStore(type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declaration = symbol?.declarations?.[0];
  if (declaration === undefined) return false;
  const file = declaration.getSourceFile().fileName;
  if (ts.isInterfaceDeclaration(declaration)) return JULY_KV_TYPES.has(declaration.name.text) && file.includes("/@cursor/july/");
  return ts.isTypeAliasDeclaration(declaration) && declaration.name.text === "KeyedKv" && file.endsWith("/kv-keys.ts");
}

function withoutNullish(type) {
  const parts = type.isUnion() ? type.types : [type];
  return parts.filter((part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
}

/** A store, or a Partial of one: either may carry a store on. */
function holdsKvStore(type) {
  return withoutNullish(type).some((part) => isKvStore(part) || isStoreProbe(part) || (part.isIntersection() && part.types.some(isKvStore)));
}

// claim-lease.ts `hasCas` reads a store as Partial<HostKvCasApi> to probe
// which methods it has, so a Partial of a store type is a slot a store may
// land in. It is still a store: handing it on to any other type is a
// kv-escape, and calling one of its methods resolves to the store's own
// method, which the `key` rule checks.
function isStoreProbe(type) {
  const declaration = type.aliasSymbol?.declarations?.[0];
  return type.aliasSymbol?.name === "Partial" && /\/typescript\/lib\/lib\.[^/]*\.d\.ts$/.test(declaration?.getSourceFile().fileName ?? "") && isKvStore(type.aliasTypeArguments?.[0] ?? type);
}

/** A slot a kv store may land in: one of the three store types (a union of them, or an intersection of only them), a Partial of one, or unknown. */
function takesKvStore(type) {
  if (type.flags & ts.TypeFlags.Unknown) return true;
  const parts = withoutNullish(type);
  return parts.length > 0 && parts.every((part) => isKvStore(part) || isStoreProbe(part) || (part.isIntersection() && part.types.every(isKvStore)));
}

/**
 * Where a store in `source` lands in a slot of `target` typed as anything
 * but a store type: `""` for the value itself, `.kv` for a property, or
 * undefined when every store lands in a store type. A hand-written
 * `{ put(key: string, …) }` takes a KeyedKv (method parameters are
 * bivariant), and from there any string reaches kv.
 */
function kvEscape(checker, flow, depth = 0) {
  const { source, target, at } = flow;
  if (depth > 3 || target.flags & ts.TypeFlags.Unknown) return undefined;
  if (holdsKvStore(source)) return takesKvStore(target) ? undefined : "";
  if (target.flags & ts.TypeFlags.Any) return undefined;
  for (const part of withoutNullish(source)) {
    if (!(part.flags & ts.TypeFlags.Object) || part.getCallSignatures().length > 0) continue;
    const element = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
    for (const slot of element === undefined ? [] : withoutNullish(target)) {
      const into = checker.getIndexTypeOfType(slot, ts.IndexKind.Number);
      const path = into === undefined ? undefined : kvEscape(checker, { source: element, target: into, at }, depth + 1);
      if (path !== undefined) return `[]${path}`;
    }
    for (const property of checker.getPropertiesOfType(part)) {
      const slots = withoutNullish(target).map((slot) => checker.getPropertyOfType(slot, property.name)).filter((slot) => slot !== undefined);
      for (const slot of slots) {
        const path = kvEscape(checker, { source: checker.getTypeOfSymbolAtLocation(property, at), target: checker.getTypeOfSymbolAtLocation(slot, at), at }, depth + 1);
        if (path !== undefined) return `.${property.name}${path}`;
      }
    }
  }
  return undefined;
}

/** The declared type of argument `index` of `signature`, a rest parameter's element included. */
function parameterType(checker, signature, index, at) {
  const parameters = signature.getParameters();
  const last = parameters.at(-1);
  const rest = last?.valueDeclaration !== undefined && ts.isParameter(last.valueDeclaration) && last.valueDeclaration.dotDotDotToken !== undefined;
  if (index < parameters.length - (rest ? 1 : 0)) return checker.getTypeOfSymbolAtLocation(parameters[index], at);
  if (!rest) return undefined;
  const spread = checker.getTypeOfSymbolAtLocation(last, at);
  return checker.getIndexTypeOfType(spread, ts.IndexKind.Number) ?? spread;
}

function isAssertion(node) {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function outsideParentheses(node) {
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return parent;
}

/** Each value `node` hands to a declared slot, with that slot's type. Object literals are checked per property, against their contextual type. */
function valueFlows(checker, node) {
  const plain = (value) => value !== undefined && !ts.isObjectLiteralExpression(value) && !ts.isSpreadElement(value);
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const signature = checker.getResolvedSignature(node);
    if (signature === undefined) return [];
    return (node.arguments ?? []).flatMap((value, index) => {
      const target = plain(value) ? parameterType(checker, signature, index, value) : undefined;
      return target === undefined ? [] : [{ value, source: checker.getTypeAtLocation(value), target }];
    });
  }
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) && node.type !== undefined && plain(node.initializer)) {
    return [{ value: node.initializer, source: checker.getTypeAtLocation(node.initializer), target: checker.getTypeFromTypeNode(node.type) }];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && plain(node.right)) {
    return [{ value: node.right, source: checker.getTypeAtLocation(node.right), target: checker.getTypeAtLocation(node.left) }];
  }
  if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !isAssertion(outsideParentheses(node))) {
    let value = node.expression;
    while (isAssertion(value) || ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
    return [{ value, source: checker.getTypeAtLocation(value), target: checker.getTypeAtLocation(node) }];
  }
  // A return or an arrow's expression body, against the return type its
  // function declares or takes from context (a callback's). Array literals
  // are checked element by element as the arrays they build (kvEscape).
  const returned = ts.isReturnStatement(node) ? node.expression : ts.isArrowFunction(node) && !ts.isBlock(node.body) ? node.body : undefined;
  if (plain(returned)) {
    const target = checker.getContextualType(returned);
    return target === undefined ? [] : [{ value: returned, source: checker.getTypeAtLocation(returned), target }];
  }
  if (ts.isSpreadAssignment(node)) {
    const target = checker.getContextualType(node.parent);
    return target === undefined ? [] : [{ value: node.expression, source: checker.getTypeAtLocation(node.expression), target }];
  }
  if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent) && ts.isIdentifier(node.name)) {
    const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
    const contextual = ts.isObjectLiteralExpression(value) ? undefined : checker.getContextualType(node.parent);
    const slot = contextual === undefined ? undefined : checker.getPropertyOfType(contextual, node.name.text);
    return slot === undefined ? [] : [{ value, source: checker.getTypeAtLocation(value), target: checker.getTypeOfSymbolAtLocation(slot, node) }];
  }
  return [];
}

function literalHead(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, open: false };
  if (ts.isTemplateExpression(node)) return { text: node.head.text, open: true };
  return undefined;
}

/** A literal that spells a registry key: the whole key, or a prefix ending in `/` or `:` followed by more key, not by a space. */
function spellsKey(literal, prefix) {
  if (literal.text === prefix) return true;
  if (!/[/:]$/.test(prefix) || !literal.text.startsWith(prefix)) return false;
  const rest = literal.text.slice(prefix.length);
  return rest === "" ? literal.open : !/^\s/.test(rest);
}

function insideConsole(node) {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression) && at.expression.expression.getText() === "console") return true;
  }
  return false;
}

/** Everything in `project`'s agent code that builds or passes a kv key outside kv-keys.ts. */
function scan(program, project, prefixes) {
  const checker = program.getTypeChecker();
  const agentDir = join(ROOT, project, "agent") + "/";
  const findings = [];
  const found = (source, node, rule, detail) => findings.push({ at: where(source, node), rule, detail });
  let kvCalls = 0;
  for (const source of program.getSourceFiles()) {
    if (!isAgentSource(project, source.fileName)) continue;
    visit(source, (node) => {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        const api = kvApiOf(declaration);
        if (api !== undefined) {
          kvCalls += 1;
          const key = node.arguments[0];
          if (key === undefined || !isKvKey(checker, key)) found(source, node, "key", `${api}.${declaration.name.text}(${key?.getText() ?? ""}) takes a string, not a KvKey`);
        }
        const callee = declaration?.getSourceFile().fileName ?? "";
        if (callee.startsWith(agentDir)) {
          for (const argument of node.arguments) {
            if (!ts.isObjectLiteralExpression(argument)) continue;
            for (const property of argument.properties) {
              const field = (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && ts.isIdentifier(property.name) ? property.name.text : undefined;
              if (field === undefined || !KEY_FIELDS.has(field)) continue;
              const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
              if (!isKvKey(checker, value)) found(source, property, "object-key", `${field}: ${value.getText()} is not a KvKey`);
            }
          }
        }
      }
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && isKvKey(checker, node) && !isKvKey(checker, node.expression)) {
        found(source, node, "cast", `${node.getText()} makes a KvKey outside kv-keys.ts`);
      }
      for (const flow of valueFlows(checker, node)) {
        const path = kvEscape(checker, { source: flow.source, target: flow.target, at: flow.value });
        if (path !== undefined) found(source, flow.value, "kv-escape", `${flow.value.getText()}${path} is a kv store passed as ${checker.typeToString(flow.target)}; take it as KeyedKv`);
        const keySlot = withoutNullish(flow.target);
        if (flow.source.flags & ts.TypeFlags.Any && keySlot.length > 0 && keySlot.every((part) => !(part.flags & ts.TypeFlags.Any) && isKvKeyType(checker, part))) {
          found(source, flow.value, "any-key", `${flow.value.getText()} is any where a KvKey goes`);
        }
      }
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "HostKvApi") {
        found(source, node, "host-kv-type", "take the store as KeyedKv from kv-keys.ts");
      }
      const literal = literalHead(node);
      if (literal !== undefined && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) && !insideConsole(node)) {
        const prefix = prefixes.find((candidate) => spellsKey(literal, candidate));
        if (prefix !== undefined) found(source, node, "literal", `${JSON.stringify(literal.text)} spells a ${prefix} key`);
      }
    });
  }
  return { findings, kvCalls };
}

async function registryOf(project) {
  return (await import(pathToFileURL(join(ROOT, project, "agent/lib/kv-keys.ts")).href)).KEY_REGISTRY;
}

for (const project of PROJECTS) {
  test(`${project}: every kv key is a KvKey from kv-keys.ts`, async (t) => {
    const prefixes = (await registryOf(project)).map((entry) => entry.prefix);
    const { findings, kvCalls } = scan(programFor(project), project, prefixes);
    assert.ok(kvCalls > 0, `${project}: no kv calls found; the scan is broken`);
    t.diagnostic(`${kvCalls} kv calls checked`);
    assert.deepEqual(findings, [], "build the key in agent/lib/kv-keys.ts and pass it as a KvKey");
  });

  test(`${project}: every registry entry says who writes it, who reads it, and when it can go`, async () => {
    const registry = await registryOf(project);
    assert.ok(registry.length > 0);
    for (const entry of registry) {
      const id = `${project} ${entry.builder}`;
      assert.match(entry.prefix, /^[a-z][a-z0-9-]*([/:]|$)/, id);
      assert.ok(entry.identity.every((part) => typeof part === "string" && part !== ""), id);
      for (const path of [entry.owner, ...entry.readers]) assert.ok(existsSync(join(ROOT, project, "agent", path)), `${id}: ${path} does not exist`);
      assert.ok(["keep", "transient", "expire"].includes(entry.lifecycle), id);
      assert.ok(["lease", "verified", "claim", "blind", "index"].includes(entry.concurrency), id);
      assert.equal(typeof entry.pii, "boolean", id);
      if (entry.lifecycle === "keep") assert.equal(entry.horizonDays, undefined, `${id}: a keep key has no horizon`);
      // Plan R3: nothing is dropped inside the longest lease plus the manual replay window.
      else assert.ok(entry.horizonDays >= 7, `${id}: horizon under 7 days`);
    }
    for (const builder of KEEP[project] ?? []) assert.equal(registry.find((entry) => entry.builder === builder)?.lifecycle, "keep", `${project} ${builder} must be keep`);
  });

  test(`${project}: no keep key shares a prefix with a key a sweeper may drop, unless allowlisted`, async () => {
    const registry = await registryOf(project);
    const overlaps = [];
    for (const kept of registry.filter((entry) => entry.lifecycle === "keep")) {
      for (const other of registry.filter((entry) => entry.lifecycle !== "keep")) {
        const shared = kept.prefix.startsWith(other.prefix) || other.prefix.startsWith(kept.prefix);
        if (shared && !KEEP_UNDER_TRANSIENT.has(`${project} ${kept.builder}`)) overlaps.push(`${kept.builder} (${kept.prefix}) and ${other.builder} (${other.prefix})`);
      }
    }
    assert.deepEqual(overlaps, []);
    for (const allowed of KEEP_UNDER_TRANSIENT) {
      const [owner, builder] = allowed.split(" ");
      if (owner === project) assert.equal(registry.find((entry) => entry.builder === builder)?.lifecycle, "keep", `${allowed} is allowlisted but not keep`);
    }
  });

  test(`${project}: kv-keys.ts builders take no two same-typed primitives side by side`, () => {
    const path = join(ROOT, project, "agent/lib/kv-keys.ts");
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const offenders = [];
    visit(source, (node) => {
      if (!(ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))) return;
      const types = node.parameters.map((parameter) => parameter.type?.getText());
      types.forEach((type, index) => {
        if (index > 0 && PRIMITIVES.has(type) && type === types[index - 1]) offenders.push(`${node.name?.getText() ?? "(anonymous)"}: parameters ${index} and ${index + 1} are both ${type}`);
      });
    });
    assert.deepEqual(offenders, [], "take an options object");
  });
}

test("each agent pins its name, the kv root, to the name it has always stored under", async () => {
  for (const project of PROJECTS) {
    const { default: agent } = await import(pathToFileURL(join(ROOT, project, "agent/agent.ts")).href);
    assert.equal(agent.name, PINNED[project], `${project}/agent/agent.ts must pin name: "${PINNED[project]}"`);
    const pkg = JSON.parse(readFileSync(join(ROOT, project, "package.json"), "utf8"));
    assert.equal(pkg.name, agent.name, `${project}: package.json names a different agent than the pinned kv root; keep the pin, or migrate the kv rows first`);
  }
});

test("the literal check flags keys, not prose that starts with a key word", () => {
  const prefixes = ["auto-drive:", "webhook-buffer", "bugbot-rounds:", "hop-watch/"];
  const spelled = (text, open = false) => prefixes.some((prefix) => spellsKey({ text, open }, prefix));
  for (const prose of ["auto-drive: claim taken", "webhook-buffer flushed", "bugbot-rounds: 2 of 2", "hop-watch/ sweep"]) assert.equal(spelled(prose), false, prose);
  for (const key of ["auto-drive:o/r#1", "webhook-buffer", "hop-watch/TLSSN-1"]) assert.equal(spelled(key), true, key);
  assert.equal(spelled("auto-drive:", true), true, "`auto-drive:${pr}`");
  assert.equal(spelled("auto-drive:", false), true, "the bare prefix");
});

// Each fixture is one way to build or pass a key outside kv-keys.ts. `by`
// names what must reject it: tsc (a KvKey diagnostic in `npm run check`) or
// the scan rule above. `none` is the control: a builder's key passes both.
const FIXTURES = {
  "a-options-object-to-agent-helper": {
    by: "tsc",
    source: `import { startPlan, type StartPlanInput } from "./start-plan.js";
export async function claim(input: Omit<StartPlanInput, "key">, id: string) {
  return startPlan({ ...input, key: \`zzz/\${id}\` });
}`,
  },
  "a-options-object-to-new-helper": {
    by: "object-key",
    source: `import type { HostKvApi } from "@cursor/july";
async function claim(input: { kv: HostKvApi; key: string }) {
  await input.kv.put(input.key, { at: "now" });
}
export async function take(kv: HostKvApi, id: string) {
  await claim({ kv, key: \`zzz/\${id}\` });
}`,
  },
  "b-key-parameter-with-any-name": {
    by: "key",
    source: `import type { HostKvApi } from "@cursor/july";
export async function read(kv: HostKvApi, name: string) {
  return kv.get(name);
}`,
  },
  "b-key-parameter-on-keyed-kv": {
    by: "tsc",
    source: `import type { KeyedKv } from "./kv-keys.js";
export async function read(kv: KeyedKv, name: string) {
  return kv.get(name);
}`,
  },
  "c-kv-under-another-name": {
    by: "key",
    source: `import type { HostKvApi } from "@cursor/july";
export async function remember(ctx: { host: { kv: HostKvApi } }, id: string) {
  const store = ctx.host.kv;
  await store.put(\`zzz/\${id}\`, 1);
}`,
  },
  "d-joined-key": {
    by: "key",
    source: `import type { HostKvApi } from "@cursor/july";
export async function read(kv: HostKvApi, id: string) {
  return kv.get(["zzz", id].join("/"));
}`,
  },
  "e-object-method-key": {
    by: "key",
    source: `import type { HostKvApi } from "@cursor/july";
const keys = { of: (id: string) => \`zzz/\${id}\` };
export async function write(kv: HostKvApi, id: string) {
  await kv.put(keys.of(id), 1);
}`,
  },
  "f-destructured-method": {
    by: "key",
    source: `import type { HostKvApi } from "@cursor/july";
export async function write(kv: HostKvApi) {
  const { put } = kv;
  await put("zzz", 1);
}`,
  },
  "g-cast-to-kv-key": {
    by: "cast",
    source: `import type { KeyedKv, KvKey } from "./kv-keys.js";
export async function read(kv: KeyedKv, id: string) {
  return kv.get(\`zzz/\${id}\` as KvKey);
}`,
  },
  "h-cas-call-after-narrowing": {
    by: "key",
    source: `import { supportsKvCas } from "@cursor/july";
import type { KeyedKv } from "./kv-keys.js";
export async function claim(kv: KeyedKv, id: string) {
  if (supportsKvCas(kv)) await kv.putIfAbsent(\`zzz/\${id}\`, 1);
}`,
  },
  "i-store-into-structural-parameter": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
type Store = { put(key: string, value: number): Promise<void> };
async function remember(store: Store, id: string) {
  await store.put(\`zzz/\${id}\`, 1);
}
export async function take(kv: KeyedKv, id: string) {
  await remember(kv, id);
}`,
  },
  "i-store-into-structural-variable": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
export async function take(ctx: { host: { kv: KeyedKv } }, id: string) {
  const store: { put(key: string, value: number): Promise<void> } = ctx.host.kv;
  await store.put(\`zzz/\${id}\`, 1);
}`,
  },
  "i-store-into-structural-property": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
async function read(deps: { kv: { get(key: string): Promise<unknown> } }, id: string) {
  return deps.kv.get(\`zzz/\${id}\`);
}
export async function take(kv: KeyedKv, id: string) {
  return read({ kv }, id);
}`,
  },
  "i-store-inside-a-passed-object": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
type Deps = { now(): Date; kv: { get(key: string): Promise<unknown> } };
async function read(deps: Deps, id: string) {
  return deps.kv.get(\`zzz/\${id}\`);
}
export async function take(deps: { now(): Date; kv: KeyedKv }, id: string) {
  await read({ ...deps }, id);
  return read(deps, id);
}`,
  },
  "i-store-cast-to-structural": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
export async function take(kv: KeyedKv, id: string) {
  await (kv as unknown as { put(key: string, value: number): Promise<void> }).put(\`zzz/\${id}\`, 1);
}`,
  },
  "j-any-into-kv-key": {
    by: "any-key",
    source: `import type { KeyedKv, KvKey } from "./kv-keys.js";
async function read(kv: KeyedKv, key: KvKey) {
  return kv.get(key);
}
export async function take(kv: KeyedKv, id: string) {
  return read(kv, \`zzz/\${id}\` as any);
}`,
  },
  "k-partial-store-handed-on": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
type Store = { put(key: string, value: number): Promise<void> };
async function remember(store: Store, id: string) {
  await store.put(\`zzz/\${id}\`, 1);
}
export async function take(kv: KeyedKv, id: string) {
  const probe: Partial<KeyedKv> = kv;
  await remember(probe as Store, id);
}`,
  },
  "k-partial-probe-method-call": {
    by: "key",
    source: `import type { HostKvCasApi } from "@cursor/july";
import type { KeyedKv } from "./kv-keys.js";
export async function take(kv: KeyedKv, id: string) {
  await (kv as Partial<HostKvCasApi>).putIfAbsent?.(\`zzz/\${id}\`, 1);
}`,
  },
  "l-store-returned-as-structural": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
type Store = { put(key: string, value: number): Promise<void> };
function storeOf(kv: KeyedKv): Store {
  return kv;
}
export async function take(kv: KeyedKv, id: string) {
  await storeOf(kv).put(\`zzz/\${id}\`, 1);
}`,
  },
  "l-store-returned-from-arrow": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
type Store = { put(key: string, value: number): Promise<void> };
const storeOf = async (kv: KeyedKv): Promise<Store> => kv;
export async function take(kv: KeyedKv, id: string) {
  await (await storeOf(kv)).put(\`zzz/\${id}\`, 1);
}`,
  },
  "m-store-in-structural-array": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
type Store = { put(key: string, value: number): Promise<void> };
async function rememberAll(stores: Store[], id: string) {
  for (const store of stores) await store.put(\`zzz/\${id}\`, 1);
}
export async function take(kv: KeyedKv, id: string) {
  const stores: Store[] = [kv];
  await rememberAll(stores, id);
}`,
  },
  "m-store-array-handed-on": {
    by: "kv-escape",
    source: `import type { KeyedKv } from "./kv-keys.js";
type Store = { put(key: string, value: number): Promise<void> };
async function rememberAll(stores: Store[], id: string) {
  for (const store of stores) await store.put(\`zzz/\${id}\`, 1);
}
export async function take(stores: KeyedKv[], id: string) {
  await rememberAll(stores, id);
}`,
  },
  "none-builder-key": {
    by: "none",
    source: `import { supportsKvCas } from "@cursor/july";
import { planClaimKey, type KeyedKv } from "./kv-keys.js";
export async function claim(kv: KeyedKv, issueKey: string) {
  const key = planClaimKey({ issueKey, status: "Triaged", changelogId: "1" });
  await kv.put(key, 1);
  if (supportsKvCas(kv)) await kv.putIfAbsent(key, 1);
}`,
  },
};

test("every way around kv-keys.ts is rejected by tsc or the scan: options objects, any parameter name, aliases, joins, methods, destructuring, casts, CAS, structural stores, any", async (t) => {
  assert.equal(Object.keys(FIXTURES).filter((name) => FIXTURES[name].by !== "none").length, 22, "keep the count in this file's header comment in step");
  const project = "planner";
  const files = Object.fromEntries(Object.entries(FIXTURES).map(([name, fixture]) => [`agent/lib/__fixture_${name}.ts`, fixture.source]));
  const program = programFor(project, files);
  const { findings } = scan(program, project, (await registryOf(project)).map((entry) => entry.prefix));
  const outcome = {};
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const file = join(ROOT, project, `agent/lib/__fixture_${name}.ts`);
    const diagnostics = program.getSemanticDiagnostics(program.getSourceFile(file)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    const rules = findings.filter((finding) => finding.at.startsWith(`${relative(ROOT, file)}:`)).map((finding) => finding.rule);
    const tsc = diagnostics.some((message) => /KvKey/.test(message));
    const unrelated = diagnostics.filter((message) => !/KvKey/.test(message));
    assert.deepEqual(unrelated, [], `${name}: the fixture itself does not compile`);
    outcome[name] = fixture.by === "none" ? (tsc || rules.length > 0 ? `rejected: ${diagnostics.join("; ")} ${rules.join(", ")}` : "none") : fixture.by === "tsc" ? (tsc ? "tsc" : `missed (${rules.join(", ")})`) : rules.includes(fixture.by) ? fixture.by : `missed (${tsc ? "tsc, " : ""}${rules.join(", ")})`;
  }
  for (const [name, by] of Object.entries(outcome)) t.diagnostic(`${name}: ${by}`);
  assert.deepEqual(outcome, Object.fromEntries(Object.entries(FIXTURES).map(([name, fixture]) => [name, fixture.by])));
});

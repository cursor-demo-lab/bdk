import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The OpenTelemetry packages the six hosts load must be one set, at one
// version, with one copy of the API.
//
// Why. July builds the tracer and logger providers and registers them
// globally; the factory registers one meter provider
// (agent/lib/factory-metrics.ts) because July's DELTA metric exporters are
// rejected by Grafana Cloud. The factory's spans, counters, and console lines
// (agent/lib/factory-otel.ts, agent/lib/console-otel.ts) reach all three
// through @opentelemetry/api and @opentelemetry/api-logs. That handover goes
// through the API's global slot, keyed by the API's major version and shared
// only by copies of the API that resolve to one module. A second copy (a
// nested node_modules/.../@opentelemetry/api, which npm creates when a
// package's range cannot be met by the top-level one) gets a registry of its
// own: the meter provider the factory registers would be invisible to July,
// the factory's spans would stop parenting under July's, and the active
// context would not cross. The SDK packages the host loads must also be
// versions July's own copies can interoperate with, so each resolved version
// has to satisfy the range @cursor/july declares for it.
//
// Checked, for every host's package.json and package-lock.json:
// - the host declares each @opentelemetry package the host's code imports
//   (tests may use devDependencies);
// - the lockfile root spec equals package.json's, and the top-level resolved
//   version satisfies it;
// - every host declares the same runtime @opentelemetry packages, with the
//   same specs, resolving to the same versions;
// - each resolved version satisfies the range @cursor/july declares for it;
// - the lockfile holds exactly one @opentelemetry/api.
// The checks run against the lockfiles as committed, not node_modules.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOSTS = ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"];
const SCOPE = "@opentelemetry/";
const API = "@opentelemetry/api";
const JULY = "@cursor/july";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  assert.ok(match, `cannot compare ${JSON.stringify(text)}: this check reads x.y.z only (no prerelease, build, or tag)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero, or positive as `found` is below, at, or above `bound` (both [major, minor, patch]). */
function compare(input) {
  const { found, bound } = input;
  for (let i = 0; i < 3; i++) if (found[i] !== bound[i]) return found[i] - bound[i];
  return 0;
}

/**
 * True when `version` (x.y.z) is within `range`: an exact x.y.z, `^x.y.z`, or
 * `~x.y.z`, the only forms the manifests and July use. Any other range form
 * throws, so a manifest that starts using one fails here loudly instead of
 * being waved through.
 */
function satisfies(input) {
  const { version, range } = input;
  const found = parseVersion(version);
  const match = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(range);
  assert.ok(match, `unsupported range ${JSON.stringify(range)}: extend satisfies() in scripts/otel-version-parity.test.mjs`);
  const floor = parseVersion(match[2]);
  if (match[1] === "") return compare({ found, bound: floor }) === 0;
  if (compare({ found, bound: floor }) < 0) return false;
  const [major, minor, patch] = floor;
  let ceiling;
  if (match[1] === "~") ceiling = [major, minor + 1, 0];
  else if (major > 0) ceiling = [major + 1, 0, 0];
  else if (minor > 0) ceiling = [0, minor + 1, 0];
  else ceiling = [0, 0, patch + 1];
  return compare({ found, bound: ceiling }) < 0;
}

/** The lockfile paths of every copy of `name`, nested ones included. */
function copiesOf(lock, name) {
  return Object.keys(lock.packages ?? {}).filter((path) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
}

function host(name) {
  const pkg = readJson(join(ROOT, name, "package.json"));
  const lock = readJson(join(ROOT, name, "package-lock.json"));
  const only = (record) => Object.fromEntries(Object.entries(record ?? {}).filter(([dep]) => dep.startsWith(SCOPE)));
  const root = lock.packages?.[""] ?? {};
  const july = lock.packages?.[`node_modules/${JULY}`] ?? {};
  return {
    name,
    dependencies: only(pkg.dependencies),
    devDependencies: only(pkg.devDependencies),
    lockDependencies: only(root.dependencies),
    lockDevDependencies: only(root.devDependencies),
    julyRanges: only({ ...july.peerDependencies, ...july.dependencies }),
    resolved: (dep) => lock.packages?.[`node_modules/${dep}`]?.version,
    lock,
  };
}

const hosts = HOSTS.map(host);

function sourceFiles(dir) {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(join(at, entry.name));
      } else if (/\.ts$/.test(entry.name)) files.push(join(at, entry.name));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

const IMPORT = /\bfrom\s+"(@opentelemetry\/[a-z][a-z-]*)(?:\/[^"]*)?"/g;

/** The @opentelemetry packages the text imports. */
function importsIn(text) {
  return [...new Set([...text.matchAll(IMPORT)].map((match) => match[1]))];
}

const isTest = (file) => /\.test\.ts$/.test(file) || /[\\/]testing[\\/]/.test(file);

test("every @opentelemetry package a host's code imports is declared, in dependencies when non-test code imports it", () => {
  const off = [];
  for (const h of hosts) {
    for (const file of sourceFiles(join(ROOT, h.name, "agent"))) {
      const declared = isTest(file) ? { ...h.devDependencies, ...h.dependencies } : h.dependencies;
      for (const dep of importsIn(readFileSync(file, "utf8"))) {
        if (declared[dep] === undefined) off.push(`  ${relative(ROOT, file)} imports ${dep}, which ${h.name}/package.json does not declare${isTest(file) ? "" : " in dependencies"}`);
      }
    }
  }
  assert.deepEqual(off, [], `Undeclared OpenTelemetry imports:\n${off.join("\n")}`);
});

test("every host's lockfile root declares the same @opentelemetry specs as its package.json, and resolves each at the top level to a version in range", () => {
  const off = [];
  for (const h of hosts) {
    for (const [group, lockGroup] of [
      ["dependencies", "lockDependencies"],
      ["devDependencies", "lockDevDependencies"],
    ]) {
      for (const [dep, spec] of Object.entries(h[group])) {
        if (h[lockGroup][dep] !== spec) off.push(`  ${h.name}: ${dep} is ${JSON.stringify(spec)} in package.json and ${JSON.stringify(h[lockGroup][dep])} in the lockfile root`);
        const resolved = h.resolved(dep);
        if (resolved === undefined) off.push(`  ${h.name}: ${dep} has no top-level node_modules entry in the lockfile`);
        else if (!satisfies({ version: resolved, range: spec })) off.push(`  ${h.name}: ${dep} resolves to ${resolved}, outside ${spec}`);
      }
      for (const dep of Object.keys(h[lockGroup])) if (h[group][dep] === undefined) off.push(`  ${h.name}: ${dep} is in the lockfile root ${group} but not package.json`);
    }
  }
  assert.deepEqual(off, [], `Lockfiles out of step with package.json:\n${off.join("\n")}`);
});

test("the six hosts declare the same runtime @opentelemetry packages at the same specs, and every host resolves each to the same version", () => {
  const [first, ...rest] = hosts;
  assert.ok(Object.keys(first.dependencies).length > 0, "the baseline host declares no @opentelemetry package");
  const off = [];
  for (const h of rest) {
    const names = new Set([...Object.keys(first.dependencies), ...Object.keys(h.dependencies)]);
    for (const dep of [...names].sort()) {
      if (first.dependencies[dep] !== h.dependencies[dep]) off.push(`  ${dep}: ${first.name} ${JSON.stringify(first.dependencies[dep])}, ${h.name} ${JSON.stringify(h.dependencies[dep])}`);
    }
  }
  const versions = new Map();
  for (const h of hosts) {
    for (const dep of new Set([...Object.keys(h.dependencies), ...Object.keys(h.devDependencies)])) {
      const list = versions.get(dep) ?? [];
      list.push(`${h.name} ${h.resolved(dep)}`);
      versions.set(dep, list);
    }
  }
  for (const [dep, list] of [...versions].sort()) {
    if (new Set(list.map((entry) => entry.split(" ")[1])).size > 1) off.push(`  ${dep} resolves differently: ${list.join(", ")}`);
  }
  assert.deepEqual(off, [], `Hosts disagree on OpenTelemetry:\n${off.join("\n")}`);
});

test(`every resolved @opentelemetry version satisfies the range ${JULY} declares for it`, () => {
  const off = [];
  let checked = 0;
  for (const h of hosts) {
    assert.ok(Object.keys(h.julyRanges).length > 0, `${h.name}: ${JULY} declares no @opentelemetry dependency in its lockfile entry`);
    for (const [dep, range] of Object.entries(h.julyRanges)) {
      const resolved = h.resolved(dep);
      if (resolved === undefined) {
        off.push(`  ${h.name}: ${JULY} needs ${dep} ${range} and the lockfile has no top-level copy`);
        continue;
      }
      checked += 1;
      if (!satisfies({ version: resolved, range })) off.push(`  ${h.name}: ${dep} resolves to ${resolved}, outside ${JULY}'s ${range}`);
    }
  }
  assert.ok(checked >= HOSTS.length, "the July ranges were not read");
  assert.deepEqual(off, [], `Versions July cannot use:\n${off.join("\n")}`);
});

test(`every lockfile holds exactly one ${API}, at the top level`, () => {
  const off = hosts
    .map((h) => ({ name: h.name, copies: copiesOf(h.lock, API) }))
    .filter(({ copies }) => copies.length !== 1 || copies[0] !== `node_modules/${API}`)
    .map(({ name, copies }) => `  ${name}: ${copies.length === 0 ? "none" : copies.join(", ")}`);
  assert.deepEqual(off, [], `A second copy of ${API} splits the global tracer, meter, and logger registries between two modules:\n${off.join("\n")}`);
});

test("satisfies() reads exact, caret, and tilde ranges as npm does, and refuses every other form", () => {
  const yes = [
    ["1.9.1", "1.9.1"],
    ["1.9.1", "^1.9.0"],
    ["1.10.0", "^1.9.0"],
    ["0.208.0", "^0.208.0"],
    ["0.208.7", "^0.208.0"],
    ["2.11.0", "^2.6.1"],
    ["2.6.1", "^2.6.1"],
    ["0.0.3", "^0.0.3"],
    ["1.2.9", "~1.2.3"],
  ];
  const no = [
    ["1.9.2", "1.9.1"],
    ["1.8.9", "^1.9.0"],
    ["2.0.0", "^1.9.0"],
    ["0.209.0", "^0.208.0"],
    ["0.207.9", "^0.208.0"],
    ["2.6.0", "^2.6.1"],
    ["3.0.0", "^2.6.1"],
    ["0.0.4", "^0.0.3"],
    ["1.3.0", "~1.2.3"],
    ["1.2.2", "~1.2.3"],
  ];
  assert.deepEqual(
    yes.filter(([version, range]) => !satisfies({ version, range })),
    [],
    "a version in range was refused"
  );
  assert.deepEqual(
    no.filter(([version, range]) => satisfies({ version, range })),
    [],
    "a version out of range was accepted"
  );
  for (const range of [">=1.0.0", "1.x", "*", "latest", "^1.0.0 || ^2.0.0", "1.0.0 - 2.0.0", "^1.0.0-rc.1", "workspace:*", ""]) {
    assert.throws(() => satisfies({ version: "1.0.0", range }), /unsupported range/, range);
  }
  assert.throws(() => satisfies({ version: "1.0.0-rc.1", range: "^1.0.0" }), /cannot compare/);
});

test("copiesOf() finds a nested copy of a package, and importsIn() every package a file imports", () => {
  const lock = { packages: { "": {}, [`node_modules/${API}`]: { version: "1.9.1" }, [`node_modules/some-dep/node_modules/${API}`]: { version: "1.8.0" }, "node_modules/@opentelemetry/api-logs": { version: "0.208.0" } } };
  assert.deepEqual(copiesOf(lock, API), [`node_modules/${API}`, `node_modules/some-dep/node_modules/${API}`]);
  assert.deepEqual(copiesOf({ packages: { [`node_modules/${API}`]: {} } }, API), [`node_modules/${API}`]);
  assert.deepEqual(copiesOf({ packages: { "": {} } }, API), []);
  const text = `import { context } from "@opentelemetry/api";\nimport type { X } from "@opentelemetry/sdk-trace-base";\nimport { y } from "@opentelemetry/exporter-trace-otlp-proto";\nimport { z } from "@opentelemetry/api/build/src/foo";\nimport { w } from "./local.js";\nexport * from "@opentelemetry/core";`;
  assert.deepEqual(importsIn(text).sort(), ["@opentelemetry/api", "@opentelemetry/core", "@opentelemetry/exporter-trace-otlp-proto", "@opentelemetry/sdk-trace-base"]);
});

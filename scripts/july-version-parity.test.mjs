import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The six hosts, factory.json, and every CLI reference to @cursor/july or
// @cursor/bdk in the factory docs and scripts must name one exact version.
// A CLI reference is any `@cursor/july@…` or `@cursor/bdk@…` token, and any
// `npx` or `-p` of either package; each must carry exactly factory.json's
// version (so `@^0.2.11`, `@latest`, and a bare `-p @cursor/july` all fail).
// Prose such as "`@cursor/july` 0.2.11" is not a CLI reference and is not
// checked. Scanned: the factory root (scripts, docs, README), each host's
// README.md, AGENTS.md, and docs/, and the factory's Cursor Automation
// specs. Not scanned: docs/candidates/ (design candidates from before the
// factory was built), node_modules, package manifests (the host tests cover
// those), and this file.
//
// The deploy CLI and the hosted runtime have to move together: from 0.2.13
// the CLI writes v2 schedules (the desk's hop-watch) into the deploy
// manifest and the runtime no longer registers them itself, so an older CLI
// with a newer runtime, or the reverse, leaves hop-watch unscheduled or
// refused. factory.json is the source of truth.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO = join(ROOT, "..");
const HOSTS = ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"];
const PACKAGE = "@cursor/july";
const EXACT = /^\d+\.\d+\.\d+$/;
const VERSIONED = /@cursor\/(?:july|bdk)@[^\s`'")\]<>,;]*/g;
const UNVERSIONED = /(?:-p|npx(?:\s+(?:-y|--yes))?)\s+@cursor\/(?:july|bdk)(?![@\w/-])/g;
const PROSE_PIN = /@cursor\/(?:july|bdk) (\d+\.\d+\.\d+)/g;
const SCANNED = /\.(md|mjs|html|json|toml|ya?ml|sh)$/;
const SKIPPED_DIRS = new Set([...HOSTS, "node_modules", ".git", "candidates"]);

// CLI references that record what was true at an earlier version, or quote
// a command to show that it fails. Exact tokens, per file.
const HISTORICAL = {
  "docs/deployment-issues.md": ["@cursor/bdk@0.2.11"],
  "docs/improvement-plan.md": ["@cursor/july@0.2.1"],
  "docs/july-event-driven-approach.md": ["@cursor/july@0.2.1"],
  "docs/learnings/README.md": ["@cursor/july@0.2.1", "@cursor/bdk@*"],
  "docs/learnings/where-this-factory-diverges.md": ["@cursor/bdk@*"],
  "docs/reaction-approvals.md": ["@cursor/july@0.2.2"],
  "docs/README.md": ["npx @cursor/july"],
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const factory = readJson(join(ROOT, "factory.json"));
const VERSION = factory.version;
const GOOD_TOKENS = new Set([`@cursor/july@${VERSION}`, `@cursor/bdk@${VERSION}`]);

function hostManifest(host) {
  const pkg = readJson(join(ROOT, host, "package.json"));
  const lock = readJson(join(ROOT, host, "package-lock.json"));
  return {
    host,
    declared: pkg.dependencies?.[PACKAGE],
    lockDeclared: lock.packages?.[""]?.dependencies?.[PACKAGE],
    resolved: lock.packages?.[`node_modules/${PACKAGE}`]?.version,
  };
}

function scannedFiles(dir) {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(at, entry.name));
      } else if (SCANNED.test(entry.name) && !/^package(-lock)?\.json$/.test(entry.name)) {
        files.push(join(at, entry.name));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

const SELF = fileURLToPath(import.meta.url);

function hostDocFiles(host) {
  const tops = ["README.md", "AGENTS.md"].map((name) => join(ROOT, host, name)).filter((path) => existsSync(path));
  return [...tops, ...scannedFiles(join(ROOT, host, "docs"))];
}

/** Every CLI reference in the text that is not factory.json's exact version. */
function badTokensIn(text) {
  const versioned = [...text.matchAll(VERSIONED)].map((match) => match[0].replace(/[.:]+$/, ""));
  const unversioned = [...text.matchAll(UNVERSIONED)].map((match) => match[0].replace(/\s+/g, " "));
  return [...versioned.filter((token) => !GOOD_TOKENS.has(token)), ...unversioned];
}

/** badTokensIn for a file, less the file's HISTORICAL tokens. */
function badTokens(file) {
  const allowed = HISTORICAL[relative(ROOT, file)] ?? [];
  return badTokensIn(readFileSync(file, "utf8")).filter((token) => !allowed.includes(token));
}

function report(files) {
  return files
    .map((file) => ({ path: relative(ROOT, file), bad: [...new Set(badTokens(file))] }))
    .filter((entry) => entry.bad.length > 0)
    .map((entry) => `  ${entry.path}: ${entry.bad.join(", ")}`);
}

test("factory.json pins one exact @cursor/july version, and its init commands use it", () => {
  assert.equal(factory.package, PACKAGE);
  assert.match(VERSION, EXACT, `factory.json version ${JSON.stringify(VERSION)} is not an exact x.y.z version`);
  const off = factory.init.filter((command) => !command.includes(`${PACKAGE}@${VERSION} `));
  assert.deepEqual(off, [], `factory.json init commands not on ${PACKAGE}@${VERSION}`);
});

test("every host package.json pins factory.json's @cursor/july exactly, with no caret", () => {
  const off = HOSTS.map(hostManifest)
    .filter((manifest) => manifest.declared !== VERSION)
    .map((manifest) => `  ${manifest.host}/package.json: ${JSON.stringify(manifest.declared)}`);
  assert.deepEqual(off, [], `Hosts whose package.json does not pin "${VERSION}" (factory.json):\n${off.join("\n")}`);
});

test("every host lockfile declares and resolves factory.json's @cursor/july", () => {
  const off = HOSTS.map(hostManifest)
    .filter((manifest) => manifest.lockDeclared !== VERSION || manifest.resolved !== VERSION)
    .map((manifest) => `  ${manifest.host}/package-lock.json: declares ${JSON.stringify(manifest.lockDeclared)}, resolves ${JSON.stringify(manifest.resolved)}`);
  assert.deepEqual(off, [], `Hosts whose lockfile is not on "${VERSION}" (factory.json):\n${off.join("\n")}`);
});

test("the six hosts pin the same exact @cursor/july as one another", () => {
  const manifests = HOSTS.map(hostManifest);
  const listing = manifests.map((manifest) => `  ${manifest.host}: ${manifest.declared} / lock ${manifest.lockDeclared} / resolved ${manifest.resolved}`);
  const shapes = new Set(manifests.map((manifest) => JSON.stringify([manifest.declared, manifest.lockDeclared, manifest.resolved])));
  assert.equal(shapes.size, 1, `Hosts disagree on ${PACKAGE}:\n${listing.join("\n")}`);
  const ranged = manifests.filter((manifest) => !EXACT.test(manifest.declared ?? "")).map((manifest) => manifest.host);
  assert.deepEqual(ranged, [], `Hosts pinning ${PACKAGE} as a range, not an exact version:\n${listing.join("\n")}`);
});

test("every CLI reference in the factory root docs and scripts is factory.json's exact version", () => {
  const off = report(scannedFiles(ROOT).filter((file) => file !== SELF));
  assert.deepEqual(off, [], `CLI references that are not ${PACKAGE}@${VERSION} (deploy with npx -y -p ${PACKAGE}@${VERSION} agent-sdk deploy):\n${off.join("\n")}`);
});

test("every CLI reference in each host's README, AGENTS.md, and docs is factory.json's exact version", () => {
  const off = report(HOSTS.flatMap(hostDocFiles));
  assert.deepEqual(off, [], `Host CLI references that are not ${PACKAGE}@${VERSION}:\n${off.join("\n")}`);
});

test("the CLI-reference scan flags every non-exact or unversioned form and passes the exact pin", () => {
  const exact = [`npx -y -p ${PACKAGE}@${VERSION} agent-sdk deploy --ref <SHA>`, `npx --yes -p @cursor/bdk@${VERSION} bdk logs`];
  const mutants = [
    "npx -y -p @cursor/july@0.2.11 agent-sdk deploy --ref <SHA>",
    `npx -p @cursor/july@^${VERSION} agent-sdk validate --dir .`,
    "npx -p @cursor/july@latest agent-sdk logs --prod",
    "npx -p @cursor/july agent-sdk login",
    "npx @cursor/july serve --dir .",
    "npx -y @cursor/bdk validate --dir .",
    "npx --yes @cursor/july deploy --dir .",
  ];
  assert.deepEqual(exact.filter((line) => badTokensIn(line).length > 0), [], "an exact pin was flagged");
  assert.deepEqual(mutants.filter((line) => badTokensIn(line).length === 0), [], "a stale or unversioned reference was not flagged");
});

test("the factory's Cursor Automation specs name factory.json's @cursor/july", () => {
  const dir = join(REPO, ".cursor", "automations");
  const specs = existsSync(dir) ? readdirSync(dir).filter((name) => /^factory-.*\.ya?ml$/.test(name)) : [];
  const off = specs
    .map((name) => ({ name, bad: [...badTokens(join(dir, name)), ...[...readFileSync(join(dir, name), "utf8").matchAll(PROSE_PIN)].map((match) => match[1]).filter((pin) => pin !== VERSION)] }))
    .filter((spec) => spec.bad.length > 0)
    .map((spec) => `  .cursor/automations/${spec.name}: ${spec.bad.join(", ")}`);
  assert.deepEqual(off, [], `Automation specs that disagree with factory.json (${VERSION}):\n${off.join("\n")}`);
});

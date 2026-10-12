#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layerEnv, parseEnvFile, probeGithubApp, probeSlackApp, PROJECTS, render, runChecks, summarize } from "./doctor-checks.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(
  root,
  "factory-desk",
  "node_modules",
  "@cursor",
  "july",
  "dist",
  "bin",
  "agent-serve.js"
);

const argv = process.argv.slice(2);
const offline = argv.includes("--offline");
const noValidate = argv.includes("--no-validate");

const env = loadLayeredEnv(root);
const factory = readFactory(root);
const facts = {
  env,
  node: {
    version: process.version,
    isBun:
      Boolean(process.versions.bun) || typeof globalThis.Bun !== "undefined",
  },
  factory,
  projects: readProjects(root),
  checkout: inspectCheckout(env.FACTORY_PLANNER_CHECKOUT),
  trackedEnvFiles: listTrackedEnvFiles(root),
  cli: { ...collectCli(env), slackApp: offline ? { ran: false } : await probeSlackApp(env, fetch) },
};

const findings = runChecks(facts);
const summary = summarize(findings);
const counts = summary.counts;
process.stdout.write(`${render(findings)}\n`);
process.stdout.write(
  `doctor: ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skipped\n`
);
process.exit(summary.exitCode);

function loadLayeredEnv(dir) {
  const files = [];
  const addDir = (agentDir) => {
    for (const name of [".env.local", ".env"]) {
      const path = join(agentDir, name);
      if (existsSync(path)) files.push(parseEnvFile(readFileSync(path, "utf8")));
    }
  };
  addDir(dir);
  let children = [];
  try {
    children = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return layerEnv({ ...process.env }, ...files);
  }
  for (const child of children) {
    if (child === "node_modules") continue;
    addDir(join(dir, child));
  }
  return layerEnv({ ...process.env }, ...files);
}

function readFactory(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "factory.json"), "utf8"));
    return {
      version: typeof raw.version === "string" ? raw.version : "",
      sandboxRepo: typeof raw.sandboxRepo === "string" ? raw.sandboxRepo : "",
    };
  } catch {
    return { version: "", sandboxRepo: "" };
  }
}

function readProjects(dir) {
  /** @type {Record<string, { installedJulyVersion: string | undefined }>} */
  const projects = {};
  for (const name of PROJECTS) {
    projects[name] = { installedJulyVersion: readJulyVersion(join(dir, name)) };
  }
  return projects;
}

function readJulyVersion(projectDir) {
  try {
    const raw = JSON.parse(
      readFileSync(join(projectDir, "node_modules/@cursor/july/package.json"), "utf8")
    );
    return typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

function inspectCheckout(configuredRaw) {
  const configured =
    configuredRaw === undefined || String(configuredRaw).trim() === ""
      ? undefined
      : String(configuredRaw).trim();
  if (configured === undefined) {
    return { configured: undefined, exists: false, isGitRepo: false, originUrl: undefined };
  }
  const exists = existsSync(configured);
  const isGitRepo = exists && existsSync(join(configured, ".git"));
  let originUrl;
  if (isGitRepo) {
    try {
      const url = execFileSync("git", ["-C", configured, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
      originUrl = url === "" ? undefined : url;
    } catch {
      originUrl = undefined;
    }
  }
  return { configured, exists, isGitRepo, originUrl };
}

function listTrackedEnvFiles(dir) {
  try {
    return execFileSync("git", ["ls-files", "--", "*.env.local", ".env.local"], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectCli(layered) {
  const childEnv = stringEnv(layered);
  const whoami = offline
    ? { ran: false, signedIn: false, detail: "" }
    : runWhoami(childEnv);
  const slackDoctor =
    offline || !slackTokensReady(layered)
      ? { ran: false, ok: false, detail: "" }
      : runSlackDoctor(childEnv);
  const validate = noValidate
    ? { ran: false, ok: false, detail: "" }
    : runValidate(childEnv);
  const githubApp = offline ? { ran: false, owners: [] } : probeGithubApp(layered, runGh);
  return { whoami, slackDoctor, validate, githubApp };
}

// Not given the layered env: an agent's GITHUB_TOKEN from .env.local would
// replace the person's gh login and usually lacks the admin:org scope the
// installations endpoint needs.
function runGh(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
    cwd: root,
  });
}

function slackTokensReady(layered) {
  return (
    envValue(layered, "FACTORY_DESK_SLACK_BOT_TOKEN").startsWith("xoxb-") &&
    envValue(layered, "FACTORY_DESK_SLACK_APP_TOKEN").startsWith("xapp-")
  );
}

function envValue(layered, key) {
  const value = layered[key];
  return value === undefined ? "" : String(value);
}

function stringEnv(layered) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(layered)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function runCli(args, childEnv) {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      env: childEnv,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000,
      cwd: root,
    });
    return { status: 0, stdout: String(stdout), stderr: "" };
  } catch (error) {
    const stdout = error && error.stdout != null ? String(error.stdout) : "";
    const stderr = error && error.stderr != null ? String(error.stderr) : "";
    const status = error && typeof error.status === "number" ? error.status : 1;
    const fallback = error instanceof Error ? error.message : String(error);
    return { status, stdout, stderr: stderr || (stdout ? "" : fallback) };
  }
}

function cliDetail(result) {
  return [result.stdout, result.stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

function parseJson(text) {
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return undefined;
  }
}

function whoamiIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (typeof value.email === "string" && value.email) return value;
  if (typeof value.authId === "string" && value.authId) return value;
  return undefined;
}

function runWhoami(childEnv) {
  const result = runCli(["whoami", "--json"], childEnv);
  const parsed = parseJson(result.stdout);
  const identity = whoamiIdentity(parsed);
  if (identity) {
    const bits = [identity.email, identity.authId, identity.teamName, identity.credentialSource]
      .filter((part) => typeof part === "string" && part);
    return { ran: true, signedIn: true, detail: bits.join(" ") };
  }
  return {
    ran: true,
    signedIn: false,
    detail: cliDetail(result) || "Not signed in",
  };
}

function slackFailures(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["slack doctor did not return JSON"];
  }
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  return checks
    .filter((check) => check && check.ok === false)
    .map((check) => `${check.id}: ${check.message}`);
}

function runSlackDoctor(childEnv) {
  const result = runCli(
    ["slack", "doctor", "--dir", "factory-desk", "--prefix", "FACTORY_DESK", "--json"],
    childEnv
  );
  const parsed = parseJson(result.stdout);
  const failures = slackFailures(parsed);
  const ok =
    result.status === 0 &&
    parsed !== undefined &&
    parsed.ok === true &&
    failures.length === 0;
  return {
    ran: true,
    ok,
    detail: ok ? "slack doctor reported no failures" : failures.join("; ") || cliDetail(result),
  };
}

function runValidate(childEnv) {
  const result = runCli(["validate", "--dir", "."], childEnv);
  const hasErrorLine = result.stdout
    .split(/\r?\n/)
    .some((line) => line.startsWith("error:"));
  return {
    ran: true,
    ok: result.status === 0 && !hasErrorLine,
    detail: cliDetail(result),
  };
}

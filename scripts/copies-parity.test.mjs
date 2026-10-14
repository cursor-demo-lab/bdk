import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Agents are self-contained projects, so a shared file is copied into each.
// Every project directory (one with a package.json) is scanned for each
// shared file, and every copy found must hash the same. `required` lists
// exactly the projects that carry a copy: a copy anywhere else fails, so a
// shared file cannot hand a setting or integration to an agent that does not
// use it. `among`, when set, limits the scan to those projects because the
// others keep a different file of that name.
//
// A shared file is tested once. Its test sits next to one copy (`testedIn`)
// and no other project carries it: the hash check makes that one test cover
// every copy, and `mise run test` runs this file with every project's suite.
// agent/lib/factory-model.ts has no `testedIn`: factory-model-catalog.test.mjs
// loads every copy through its project's config.ts. The factory-env,
// factory-repos, and factory-sandbox files have none either:
// factory-config-parity.test.mjs loads every copy the same way.
// agent/lib/triage-verdict.ts has none: scripts/jev-judge-line.test.mjs and
// scripts/desk-triage.test.mjs load both sides' writers and readers.
// agent/tools/writes.test.ts is itself a test: each copy scans its own
// project's tools.
//
// Same name, different on purpose, so not listed here:
// - agent/tools/writes.test.ts in factory-desk adds checks for the desk's
//   own tools, so its group is `among` the other four.
// - triage-jira's tracker.ts lives under agent/mcp-connections/, a different
//   attachment surface from the agent/host-connections/ copy the others share.
// - agent/lib/atlassian.test.ts drives each agent's own jira.ts or actuate.ts
//   verbs over the shared atlassian.ts, so each copy tests different code.
// - agent/lib/peers.test.ts names each agent's real peer (planner in
//   triage-jira, factory-desk in planner).
// - agent/lib/triage-comment.ts is the desk's Triage: reader; triage-jira's
//   writer lives in the shared agent/lib/triage-verdict.ts.
// - agent/lib/testing/legacy/ holds frozen copies of each agent's own
//   pre-change kv code for old-versus-new race tests; never shared or synced.
// - agent/lib/kv-keys.ts is each agent's own key registry
//   (kv-key-registry.test.mjs holds all six to the same rules).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const JIRA_SLUGS = ["factory-desk", "factory-worker", "planner", "triage-jira"];
const WRITES_TEST_SLUGS = ["planner", "pr-autofixer", "security-reviewer", "triage-jira"];
const JIRA_PROJECTS_SLUGS = ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer"];
const STRICT_REPOS_SLUGS = ["factory-worker", "planner", "pr-autofixer", "security-reviewer"];
const SANDBOX_SLUGS = ["factory-worker", "planner"];
const JEV_SLUGS = ["factory-desk", "triage-jira"];
const KV_FIXTURE_SLUGS = ["factory-desk", "factory-worker", "planner"];
const CLAIM_SLUGS = ["factory-worker", "planner"];
const GROUPS = [
  { file: "agent/lib/verify-webhook.ts", required: JIRA_SLUGS, testedIn: "factory-desk" },
  { file: "agent/lib/atlassian.ts", required: JIRA_SLUGS },
  { file: "agent/lib/peers.ts", required: ["planner", "triage-jira"] },
  { file: "agent/lib/kv-verified.ts", required: ["factory-desk", "pr-autofixer", ...CLAIM_SLUGS], testedIn: "factory-desk" },
  { file: "agent/lib/claim-lease.ts", required: ["factory-desk", "pr-autofixer"], testedIn: "factory-desk" },
  // The verified merge for the desk's hop-watch/index and the worker's implement-pr-watch/index, and FACTORY_INDEX_MERGE.
  { file: "agent/lib/kv-index.ts", required: ["factory-desk", "factory-worker"], testedIn: "factory-desk" },
  // The planner's and worker's owner, read-back, settle claim, and FACTORY_CLAIM_SETTLE_MS / FACTORY_CLAIM_MODE.
  { file: "agent/lib/verified-claim.ts", required: CLAIM_SLUGS, testedIn: "factory-worker" },
  // Race and hosted-shaped kv fixtures for the claim tests in every agent that races deliveries at a kv claim.
  { file: "agent/lib/kv-race.fixtures.ts", required: KV_FIXTURE_SLUGS, testedIn: "factory-desk" },
  { file: "agent/lib/kv-backends.fixtures.ts", required: KV_FIXTURE_SLUGS, testedIn: "factory-desk" },
  { file: "agent/lib/config.ts", required: ["pr-autofixer", "security-reviewer"], among: ["pr-autofixer", "security-reviewer"], testedIn: "pr-autofixer" },
  { file: "agent/lib/factory-pr-key.ts", required: ["factory-desk", "factory-worker", "pr-autofixer", "security-reviewer"], testedIn: "factory-worker" },
  // The ticket a PR turn's token usage is labelled with (hooks/ticket-key.ts): the head branch in the channel state, else one PR read per session.
  { file: "agent/lib/pr-ticket.ts", required: ["pr-autofixer", "security-reviewer"], testedIn: "pr-autofixer" },
  { file: "agent/lib/factory-model.ts", required: [...JIRA_SLUGS, "pr-autofixer", "security-reviewer"] },
  // triage-jira reads FACTORY_JIRA_PROJECTS only as its staging allowlist (staging-issue.ts).
  { file: "agent/lib/factory-env.ts", required: [...JIRA_PROJECTS_SLUGS, "triage-jira"] },
  { file: "agent/lib/factory-repos.ts", required: STRICT_REPOS_SLUGS },
  { file: "agent/lib/factory-sandbox.ts", required: SANDBOX_SLUGS },
  // FACTORY_ENV and the production targets a staging slug refuses; every slug can be staged.
  { file: "agent/lib/factory-stage.ts", required: ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"], testedIn: "factory-desk" },
  // warnKv and the Slack ops failure funnel (FACTORY_OPS_SLACK_BOT_TOKEN / _CHANNEL, FACTORY_OPS_FUNNEL); each agent's kv-keys.ts supplies factorySlug and opsAlertKey.
  { file: "agent/lib/ops-funnel.ts", required: ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"], testedIn: "factory-desk" },
  // July's own OTel setup for traces and logs: the OTLP config agent/otel.ts hands July (the Grafana endpoint in code, OTEL_EXPORTER_OTLP_HEADERS the one secret), the factory.* spans and delivery counters on the global API, and the one ticket-key helper; each agent's kv-keys.ts supplies factorySlug. factory-desk's july-otel.test.ts drives it through July's runtime.
  { file: "agent/lib/factory-otel.ts", required: ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"], testedIn: "factory-desk" },
  // The one cumulative meter provider (July's metric exporters are DELTA, which Grafana Cloud rejects): header read on each export, one service.instance.id per process life, one View for July's hosted-execution buckets. factory-desk's factory-metrics.test.ts drives it.
  { file: "agent/lib/factory-metrics.ts", required: ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"], testedIn: "factory-desk" },
  // Flushes that meter provider when a session turn ends (session.waiting / completed / failed), before the hosted reply can park the VM. factory-desk's metrics-flush.test.ts drives it.
  { file: "agent/hooks/metrics-flush.ts", required: ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"], testedIn: "factory-desk" },
  // Console lines as OTel log records through July's global logger, and Node process warnings exported at WARN. factory-desk's console-otel.test.ts drives it.
  { file: "agent/lib/console-otel.ts", required: ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"], testedIn: "factory-desk" },
  { file: "agent/otel.ts", required: ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"] },
  // The planner's copy adds a `tools` allowlist: it declares `cloud`, which serves host connections at the cloud tool endpoint (not mounted on the turn).
  { file: "agent/host-connections/tracker.ts", required: ["factory-desk", "factory-worker"], among: ["factory-desk", "factory-worker"] },
  // Jev triage: triage-jira on a ticket filed in Jira, factory-desk on a Slack filing request before it files.
  { file: "agent/lib/jev-triage.ts", required: JEV_SLUGS, testedIn: "triage-jira" },
  { file: "agent/lib/issue-type.ts", required: JEV_SLUGS, testedIn: "triage-jira" },
  { file: "agent/lib/triage-verdict.ts", required: JEV_SLUGS },
  // The desk's "triaged before filing" line: the desk writes it, triage-jira skips on it, the planner gates on the desk's verdict.
  { file: "agent/lib/desk-triaged.ts", required: [...JEV_SLUGS, "planner"], testedIn: "triage-jira" },
  { file: "agent/extensions/jev.ts", required: JEV_SLUGS },
  // factory-desk has no harness tools to load a skill, so it inlines the rubric
  // (agent/lib/triage-rubric.ts); scripts/desk-triage.test.mjs pins that text to this file.
  { file: "agent/skills/triage-rubric.md", required: ["triage-jira"] },
  { file: "agent/tools/writes.test.ts", required: WRITES_TEST_SLUGS, among: WRITES_TEST_SLUGS },
];

function projects(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
}

function copyHashes(root, file, among) {
  const hashes = {};
  for (const project of projects(root)) {
    if (among !== undefined && !among.includes(project)) continue;
    const path = join(root, project, file);
    if (existsSync(path)) hashes[project] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return hashes;
}

for (const group of GROUPS) {
  test(`every copy of ${group.file} is identical`, () => {
    const hashes = copyHashes(ROOT, group.file, group.among);
    const present = Object.keys(hashes);
    const missing = group.required.filter((project) => !present.includes(project));
    assert.deepEqual(missing, [], `${group.file} is missing from ${missing.join(", ")}`);
    const extra = present.filter((project) => !group.required.includes(project));
    assert.deepEqual(extra, [], `${group.file} is copied into ${extra.join(", ")}, which do not use it`);
    const distinct = new Set(Object.values(hashes));
    assert.equal(distinct.size, 1, `${group.file} copies differ:\n${present.map((p) => `  ${hashes[p]}  ${p}`).join("\n")}`);
  });

  if (group.testedIn === undefined) continue;
  const testFile = group.file.replace(/\.ts$/, ".test.ts");
  test(`${testFile} lives only in ${group.testedIn}`, () => {
    assert.deepEqual(Object.keys(copyHashes(ROOT, testFile, group.among)), [group.testedIn]);
  });
}

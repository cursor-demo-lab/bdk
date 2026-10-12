import assert from "node:assert/strict";
import { test } from "node:test";
import { githubPrRef, type GithubPrRef } from "./drive.js";
import * as keys from "./kv-keys.js";

// The builders as they were before kv-keys.ts (268fc79), body for body. Each
// stored record is found only by these exact bytes, so the central builders
// must reproduce them for every input.
const legacy = {
  autoDriveKey: (pr: GithubPrRef) => `auto-drive:${pr.owner}/${pr.repo}#${pr.number}`,
  driveSessionKey: (sessionId: string) => `drive-session/${sessionId}`,
  bugbotRoundsKey: (pr: GithubPrRef) => `bugbot-rounds:${pr.owner}/${pr.repo}#${pr.number}`,
  affinityKey: (pr: GithubPrRef) => `affinity/${pr.label}`,
  // Private to channels/github.ts.
  freshFailuresKey: (input: { pr: GithubPrRef; headSha: string | undefined }) => `bugbot-fresh-failures:${input.pr.label}:${input.headSha?.toLowerCase() ?? "unknown"}`,
  WEBHOOK_BUFFER_KV_KEY: "webhook-buffer",
  // Added with KV Phase 1 K8; no earlier format.
  prGenerationKey: (pr: GithubPrRef) => `v1/pr-generation/${pr.owner}/${pr.repo}/${pr.number}`,
};

const PRS: GithubPrRef[] = [
  githubPrRef({ owner: "cursor-demo-lab", repo: "marsbank", number: 28, url: "https://github.com/cursor-demo-lab/marsbank/pull/28" }),
  githubPrRef({ owner: "Cursor-Demo-Lab", repo: "MarsBank", number: 1, url: "https://github.com/Cursor-Demo-Lab/MarsBank/pull/1" }),
  { owner: "Org", repo: "Re#po", number: 7, url: "https://github.com/Org/Re#po/pull/7", label: "org/re#po#7" },
];
const SESSIONS = ["ses_01JABCDEF", "pr:o/r#1", ""];
const HEADS = ["0123456789abcdefABCDEF0123456789abcdef01", undefined, ""];

type Pair = { legacy: string; current: string };
const same = <T>(inputs: readonly T[], cases: { legacy: (input: T) => string; current: (input: T) => string }): Pair[] =>
  inputs.map((input) => ({ legacy: cases.legacy(input), current: cases.current(input) }));

// New with the ops funnel (K7): no older bytes to match, so the pair pins the documented shape.
const OPS_ALERTS = [
  { hash: "0123456789abcdef", hour: "2026-09-29T05" },
  { hash: "ffffffffffffffff", hour: "2026-12-31T23" },
];

const PAIRS: Record<string, Pair[]> = {
  opsAlertKey: OPS_ALERTS.map((input) => ({ legacy: `v1/ops-alert/${input.hash}/${input.hour}`, current: keys.opsAlertKey(input) })),
  autoDriveKey: same(PRS, { legacy: legacy.autoDriveKey, current: keys.autoDriveKey }),
  driveSessionKey: same(SESSIONS, { legacy: legacy.driveSessionKey, current: keys.driveSessionKey }),
  bugbotRoundsKey: same(PRS, { legacy: legacy.bugbotRoundsKey, current: keys.bugbotRoundsKey }),
  affinityKey: same(PRS, { legacy: legacy.affinityKey, current: keys.affinityKey }),
  freshFailuresKey: same(
    PRS.flatMap((pr) => HEADS.map((headSha) => ({ pr, headSha }))),
    { legacy: legacy.freshFailuresKey, current: keys.freshFailuresKey }
  ),
  WEBHOOK_BUFFER_KV_KEY: [{ legacy: legacy.WEBHOOK_BUFFER_KV_KEY, current: keys.WEBHOOK_BUFFER_KV_KEY }],
  prGenerationKey: same(PRS, { legacy: legacy.prGenerationKey, current: keys.prGenerationKey }),
};

test("every builder writes the same bytes it wrote before kv-keys.ts", () => {
  for (const [builder, pairs] of Object.entries(PAIRS)) {
    for (const pair of pairs) assert.equal(pair.current, pair.legacy, builder);
  }
  const pr = PRS[1]!;
  assert.equal(keys.autoDriveKey(pr), "auto-drive:Cursor-Demo-Lab/MarsBank#1");
  assert.equal(keys.affinityKey(pr), "affinity/Cursor-Demo-Lab/MarsBank#1");
  assert.equal(keys.freshFailuresKey({ pr, headSha: "ABCDEF" }), "bugbot-fresh-failures:Cursor-Demo-Lab/MarsBank#1:abcdef");
  assert.equal(keys.freshFailuresKey({ pr, headSha: undefined }), "bugbot-fresh-failures:Cursor-Demo-Lab/MarsBank#1:unknown");
});

test("the registry names every builder, and each builder's keys start with its prefix", () => {
  const exported = Object.entries(keys).filter(([name, value]) => (typeof value === "function" && name.endsWith("Key")) || (typeof value === "string" && /^[A-Z_]+$/.test(name)));
  const registered = keys.KEY_REGISTRY.map((entry) => entry.builder);
  assert.deepEqual(exported.map(([name]) => name).sort(), registered.slice().sort());
  assert.deepEqual(Object.keys(PAIRS).sort(), registered.slice().sort());
  for (const entry of keys.KEY_REGISTRY) {
    for (const pair of PAIRS[entry.builder] ?? []) assert.ok(pair.current.startsWith(entry.prefix), `${entry.builder}: ${pair.current}`);
  }
});

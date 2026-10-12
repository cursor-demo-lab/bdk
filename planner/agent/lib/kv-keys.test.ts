import assert from "node:assert/strict";
import { test } from "node:test";
import * as keys from "./kv-keys.js";

// The builders as they were before kv-keys.ts (268fc79), body for body. Each
// stored record is found only by these exact bytes, so the central builders
// must reproduce them for every input.
const legacy = {
  planClaimKey: (input: { issueKey: string; status: string; changelogId: string }) => `plan/${input.issueKey}:${input.status}:${input.changelogId}`,
  commentClaimKey: (issueKey: string) => `plan-claimed/${issueKey}`,
  outcomeKey: (sessionId: string) => `plan-outcome/${sessionId}`,
  skipClaimKey: (input: { issueKey: string; changelogId: string }) => `plan-skip/${input.issueKey}:${input.changelogId}`,
  startedClaimKey: (input: { sessionId: string; turnId?: string }) => `plan-started/${input.sessionId}${input.turnId === undefined ? "" : `:${input.turnId}`}`,
  searchBudgetKey: (sessionId: string) => `search-budget/${sessionId}`,
  digestRefusedKey: (sessionId: string) => `plan-digest-refused/${sessionId}`,
};

const ISSUE_KEYS = ["TLSSN-36", "OPS-1", "A1-999999"];
const STATUSES = ["Triaged", "In Progress"];
const CHANGELOG_IDS = ["10245", "comment-10245", ""];
const SESSIONS = ["ses_01JABCDEF", "issue:TLSSN-36#2", ""];
const TURNS = [undefined, "turn_1", ""];

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
  planClaimKey: same(
    ISSUE_KEYS.flatMap((issueKey) => STATUSES.flatMap((status) => CHANGELOG_IDS.map((changelogId) => ({ issueKey, status, changelogId })))),
    { legacy: legacy.planClaimKey, current: keys.planClaimKey }
  ),
  commentClaimKey: same(ISSUE_KEYS, { legacy: legacy.commentClaimKey, current: keys.commentClaimKey }),
  outcomeKey: same(SESSIONS, { legacy: legacy.outcomeKey, current: keys.outcomeKey }),
  skipClaimKey: same(
    ISSUE_KEYS.flatMap((issueKey) => CHANGELOG_IDS.map((changelogId) => ({ issueKey, changelogId }))),
    { legacy: legacy.skipClaimKey, current: keys.skipClaimKey }
  ),
  startedClaimKey: same(
    SESSIONS.flatMap((sessionId) => TURNS.map((turnId) => (turnId === undefined ? { sessionId } : { sessionId, turnId }))),
    { legacy: legacy.startedClaimKey, current: keys.startedClaimKey }
  ),
  searchBudgetKey: same(SESSIONS, { legacy: legacy.searchBudgetKey, current: keys.searchBudgetKey }),
  digestRefusedKey: same(SESSIONS, { legacy: legacy.digestRefusedKey, current: keys.digestRefusedKey }),
};

test("every builder writes the same bytes it wrote before kv-keys.ts", () => {
  for (const [builder, pairs] of Object.entries(PAIRS)) {
    for (const pair of pairs) assert.equal(pair.current, pair.legacy, builder);
  }
  assert.equal(keys.planClaimKey({ issueKey: "TLSSN-36", status: "Triaged", changelogId: "10245" }), "plan/TLSSN-36:Triaged:10245");
  assert.equal(keys.startedClaimKey({ sessionId: "issue:TLSSN-36#2" }), "plan-started/issue:TLSSN-36#2");
  assert.equal(keys.startedClaimKey({ sessionId: "issue:TLSSN-36#2", turnId: "t1" }), "plan-started/issue:TLSSN-36#2:t1");
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

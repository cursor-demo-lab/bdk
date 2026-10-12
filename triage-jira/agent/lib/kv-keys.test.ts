import assert from "node:assert/strict";
import { test } from "node:test";
import * as keys from "./kv-keys.js";

// The builders as they were before kv-keys.ts (268fc79), body for body. Each
// stored record is found only by these exact bytes, so the central builders
// must reproduce them for every input.
const legacy = {
  inboundKey: (identifier: string) => `triage-inbound/${identifier}`,
  jevAnswersKey: (identifier: string) => `triage-jev/${identifier}`,
  outcomeKey: (sessionId: string) => `triage-outcome/${sessionId}`,
  issueTypesCacheKey: (project: string) => `triage-issue-types/${project}`,
};

const ISSUE_KEYS = ["TLSSN-36", "OPS-1", "A1-999999", ""];
const SESSIONS = ["ses_01JABCDEF", "issue:TLSSN-36#2", ""];
const PROJECTS = ["TLSSN", "ops", ""];

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
  inboundKey: same(ISSUE_KEYS, { legacy: legacy.inboundKey, current: keys.inboundKey }),
  jevAnswersKey: same(ISSUE_KEYS, { legacy: legacy.jevAnswersKey, current: keys.jevAnswersKey }),
  outcomeKey: same(SESSIONS, { legacy: legacy.outcomeKey, current: keys.outcomeKey }),
  issueTypesCacheKey: same(PROJECTS, { legacy: legacy.issueTypesCacheKey, current: keys.issueTypesCacheKey }),
};

test("every builder writes the same bytes it wrote before kv-keys.ts", () => {
  for (const [builder, pairs] of Object.entries(PAIRS)) {
    for (const pair of pairs) assert.equal(pair.current, pair.legacy, builder);
  }
  assert.equal(keys.inboundKey("TLSSN-36"), "triage-inbound/TLSSN-36");
  assert.equal(keys.outcomeKey("issue:TLSSN-36#2"), "triage-outcome/issue:TLSSN-36#2");
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

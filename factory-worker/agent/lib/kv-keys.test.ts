import assert from "node:assert/strict";
import { test } from "node:test";
import * as keys from "./kv-keys.js";
import type { PrStage } from "./pr-decide.js";

// The builders as they were before kv-keys.ts (268fc79), body for body. Each
// stored record is found only by these exact bytes, so the central builders
// must reproduce them for every input.
type PrRef = { repository: string; number: number };
type Note = { issueKey: string; stage: PrStage; pr: string; outcome: string; current?: string };
const legacy = {
  implementClaimKey: (issueKey: string) => `implement/${issueKey}`,
  launchFailureNoticeKey: (input: { issueKey: string; changelogId: string }) => `implement-failed/${input.issueKey}/${input.changelogId}`,
  prStatusClaimKey: (input: { issueKey: string; stage: PrStage; pr: string }) => `pr-status/${input.issueKey}/${input.stage}/${input.pr}`,
  // Inline in pr-status.ts `noteSkip`, with `result.status` as the outcome.
  prStatusNoteKey: ({ issueKey, stage, pr, outcome, current }: Note) => `pr-status-note/${issueKey}/${stage}/${pr}/${outcome}:${current ?? ""}`,
  readyRecordKey: (target: PrRef) => `pr-ready/${target.repository.toLowerCase()}#${target.number}`,
  // Inline in pr-ready.ts `noteNotReady`.
  readyNoteKey: (target: PrRef) => `pr-ready-note/${target.repository.toLowerCase()}#${target.number}`,
  implementPrWatchKey: (issueKey: string) => `implement-pr-watch/${issueKey}`,
  IMPLEMENT_PR_INDEX: "implement-pr-watch/index",
  IMPLEMENT_PR_SWEEP_KEY: "implement-pr-watch/last-sweep",
};

const ISSUE_KEYS = ["TLSSN-36", "OPS-1", "A1-999999"];
const CHANGELOG_IDS = ["10245", ""];
const STAGES: PrStage[] = ["in_review", "done"];
const REPOS = ["cursor-demo-lab/marsbank", "Cursor-Demo-Lab/MarsBank", "Org/Re#po"];
const PRS = REPOS.flatMap((repository) => [28, 1].map((number) => ({ repository, number })));
const PR_LABELS = PRS.map((pr) => `${pr.repository}#${pr.number}`);
const OUTCOMES: { outcome: string; current?: string }[] = [{ outcome: "skipped_status", current: "In Progress" }, { outcome: "skipped_status" }, { outcome: "no_transition" }, { outcome: "failed", current: "" }];

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
  implementClaimKey: same(ISSUE_KEYS, { legacy: legacy.implementClaimKey, current: keys.implementClaimKey }),
  launchFailureNoticeKey: same(
    ISSUE_KEYS.flatMap((issueKey) => CHANGELOG_IDS.map((changelogId) => ({ issueKey, changelogId }))),
    { legacy: legacy.launchFailureNoticeKey, current: keys.launchFailureNoticeKey }
  ),
  prStatusClaimKey: same(
    ISSUE_KEYS.flatMap((issueKey) => STAGES.flatMap((stage) => PR_LABELS.map((pr) => ({ issueKey, stage, pr })))),
    { legacy: legacy.prStatusClaimKey, current: keys.prStatusClaimKey }
  ),
  prStatusNoteKey: same(
    ISSUE_KEYS.flatMap((issueKey) => STAGES.flatMap((stage) => PR_LABELS.flatMap((pr) => OUTCOMES.map((outcome) => ({ issueKey, stage, pr, ...outcome }))))),
    { legacy: legacy.prStatusNoteKey, current: keys.prStatusNoteKey }
  ),
  readyRecordKey: same(PRS, { legacy: legacy.readyRecordKey, current: keys.readyRecordKey }),
  readyNoteKey: same(PRS, { legacy: legacy.readyNoteKey, current: keys.readyNoteKey }),
  implementPrWatchKey: same(ISSUE_KEYS, { legacy: legacy.implementPrWatchKey, current: keys.implementPrWatchKey }),
  IMPLEMENT_PR_INDEX: [{ legacy: legacy.IMPLEMENT_PR_INDEX, current: keys.IMPLEMENT_PR_INDEX }],
  IMPLEMENT_PR_SWEEP_KEY: [{ legacy: legacy.IMPLEMENT_PR_SWEEP_KEY, current: keys.IMPLEMENT_PR_SWEEP_KEY }],
  // New with the launch watch: no older bytes to match, so each pair pins the documented shape.
  launchWatchKey: ISSUE_KEYS.map((issueKey) => ({ legacy: `implement-launch/${issueKey}`, current: keys.launchWatchKey(issueKey) })),
  LAUNCH_WATCH_INDEX: [{ legacy: "implement-launch/index", current: keys.LAUNCH_WATCH_INDEX }],
  launchNoteKey: ISSUE_KEYS.flatMap((issueKey) =>
    CHANGELOG_IDS.map((changelogId) => ({ legacy: `implement-note/${issueKey}/${changelogId}/in_flight`, current: keys.launchNoteKey({ issueKey, changelogId, kind: "in_flight" }) }))
  ),
  // New with apj_factory.ticket.merged (#224): the first count of a ticket's move into Done; no older bytes to match.
  ticketMergedKey: ISSUE_KEYS.map((issueKey) => ({ legacy: `ticket-merged/${issueKey}`, current: keys.ticketMergedKey(issueKey) })),
  // New with the implement cloud turn: the agent July bound to the ticket's session; no older bytes to match.
  implementAgentKey: ISSUE_KEYS.map((issueKey) => ({ legacy: `implement-agent/${issueKey}`, current: keys.implementAgentKey(issueKey) })),
};

test("every builder writes the same bytes it wrote before kv-keys.ts", () => {
  for (const [builder, pairs] of Object.entries(PAIRS)) {
    for (const pair of pairs) assert.equal(pair.current, pair.legacy, builder);
  }
  assert.equal(keys.prStatusClaimKey({ issueKey: "TLSSN-36", stage: "done", pr: "Cursor-Demo-Lab/MarsBank#28" }), "pr-status/TLSSN-36/done/Cursor-Demo-Lab/MarsBank#28");
  assert.equal(keys.prStatusNoteKey({ issueKey: "TLSSN-36", stage: "in_review", pr: "o/r#1", outcome: "no_transition" }), "pr-status-note/TLSSN-36/in_review/o/r#1/no_transition:");
  assert.equal(keys.readyNoteKey({ repository: "Cursor-Demo-Lab/MarsBank", number: 28 }), "pr-ready-note/cursor-demo-lab/marsbank#28");
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

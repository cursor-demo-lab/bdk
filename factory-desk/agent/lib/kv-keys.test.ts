import assert from "node:assert/strict";
import { test } from "node:test";
import * as keys from "./kv-keys.js";
import type { Hop } from "./hop-watch.js";
import type { Command } from "./originator.js";
import type { ReviewComponent } from "./review-update.js";
import type { ThreadRef } from "./threads.js";

// The builders as they were before kv-keys.ts (268fc79), body for body. Each
// stored record is found only by these exact bytes, so the central builders
// must reproduce them for every input. Builders that took two strings side
// by side take the same fields as an object here; the template is unchanged.
type Msg = { channelId: string; ts: string };
type PrHead = { repository: string; number: number; headSha: string };
const legacy = {
  ticketKey: (issueKey: string) => `ticket/${issueKey}`,
  announcedKey: (input: { issueKey: string; status: string; changelogId?: string }) => {
    const base = `announced/${input.issueKey}:${input.status}`;
    return input.changelogId === undefined ? base : `${base}:${input.changelogId}`;
  },
  planAnnounceKey: (input: { issueKey: string; status: string; commentId?: string }) => {
    const base = legacy.announcedKey({ issueKey: input.issueKey, status: input.status });
    return input.commentId === undefined ? base : `${base}:plan-${input.commentId}`;
  },
  triagedAnnounceKey: (input: { issueKey: string; status: string; fingerprint: string }) => `${legacy.announcedKey({ issueKey: input.issueKey, status: input.status })}:verdict-${input.fingerprint}`,
  hopWatchClaimKey: (input: { issueKey: string; hop: Hop; changelogId: string }) => `announced/${input.issueKey}:hop-${input.hop}:${input.changelogId}`,
  hopWatchKey: (issueKey: string) => `hop-watch/${issueKey}`,
  HOP_WATCH_INDEX: "hop-watch/index",
  BACKSTOP_SWEEP_KEY: "hop-watch/last-sweep",
  triagedSinceKey: (issueKey: string) => `triaged-since/${issueKey}`,
  triagedEntryKey: (issueKey: string) => `triaged-entry/${issueKey}`,
  reactionKey: (issueKey: string) => `reaction/${issueKey}`,
  backlinkKey: (issueKey: string) => `backlink/${issueKey}`,
  plannerSentKey: (issueKey: string) => `planner-sent/${issueKey}`,
  planDeclinedKey: (issueKey: string) => `plan-declined/${issueKey}`,
  approveTicketKey: (issueKey: string) => `approve-ticket/${issueKey}`,
  loaderKey: (issueKey: string) => `loader/${issueKey}`,
  reviewGatesKey: (issueKey: string) => `review-gates/${issueKey}`,
  slackApprovalKey: (issueKey: string) => `approved-in-slack/${issueKey}`,
  retryBounceKey: (issueKey: string) => `retry-bounce/${issueKey}`,
  pullRequestRetryKey: (issueKey: string) => `retry-pr/${issueKey}`,
  issueTypesCacheKey: (project: string) => `triage-issue-types/${project}`,
  // thread-tickets.ts and originator.ts each had this helper.
  threadId: (thread: ThreadRef) => `${thread.channelId}:${thread.threadTs ?? ""}`,
  threadTicketsKey: (thread: ThreadRef) => `thread-tickets/${legacy.threadId(thread)}`,
  filingThreadKey: (thread: ThreadRef) => `filing-thread/${legacy.threadId(thread)}`,
  filingHoldKey: (thread: ThreadRef) => `file-ticket/${legacy.threadId(thread)}`,
  speakerKey: (thread: ThreadRef) => `speaker/${legacy.threadId(thread)}`,
  commandKey: (thread: ThreadRef, command: Command) => `command/${legacy.threadId(thread)}/${command.verb}:${command.target}`,
  awaitingKey: (thread: ThreadRef) => `awaiting-info/${thread.channelId}:${thread.threadTs ?? ""}`,
  intakeTriageKey: (thread: ThreadRef) => `intake-triage/${thread.channelId}:${thread.threadTs ?? ""}`,
  declineAnsweredKey: ({ thread, issueKey }: { thread: ThreadRef; issueKey: string }) => `decline-answered/${thread.channelId}:${thread.threadTs ?? "-"}/${issueKey}`,
  handledMessageKey: ({ channelId, ts }: Msg) => `handled-message/${channelId}:${ts}`,
  reactionClaimKey: ({ channelId, ts, act }: Msg & { act: "filing" | "approve" | "decline" }) => `reaction/${channelId}:${ts}/${act}`,
  planPostKey: ({ channelId, ts }: Msg) => `plan-post/${channelId}:${ts}`,
  filingPromptKey: ({ channelId, ts }: Msg) => `filing-prompt/${channelId}:${ts}`,
  intakeSettledKey: ({ channelId, ts: sourceTs }: Msg) => `intake-settled/${channelId}:${sourceTs}`,
  // Inline in plan-command.ts, approve-command.ts, retry-command.ts, and thread-detail.ts.
  planCommandKey: (message: Msg) => `plan-command/${message.channelId}:${message.ts}`,
  approveCommandKey: (message: Msg) => `approve-command/${message.channelId}:${message.ts}`,
  retryCommandKey: (message: Msg) => `retry-command/${message.channelId}:${message.ts}`,
  threadDetailKey: (message: Msg) => `thread-detail/${message.channelId}:${message.ts}`,
  reviewClaimKey: (input: PrHead & { component: ReviewComponent }) => `review/${input.repository.toLowerCase()}#${input.number}/${input.headSha.toLowerCase()}/${input.component}`,
  changeMonitorPendingKey: (input: PrHead) => `${legacy.reviewClaimKey({ ...input, component: "changeMonitor" })}-pending`,
  changeMonitorClaimKey: (input: PrHead & { verdict: ChangeMonitorVerdict }) => {
    if (input.verdict === "pending") return legacy.changeMonitorPendingKey(input);
    const key = legacy.reviewClaimKey({ ...input, component: "changeMonitor" });
    return input.verdict === "planned" ? `${key}-planned` : key;
  },
  changeMonitorMessageKey: (input: PrHead) => `review-change/${input.repository.toLowerCase()}#${input.number}/${input.headSha.toLowerCase()}`,
  reviewMessageKey: (input: PrHead) => `review-message/${input.repository.toLowerCase()}#${input.number}/${input.headSha.toLowerCase()}`,
  securityAnnouncedKey: (input: { repository: string; number: number }) => `review-security/${input.repository.toLowerCase()}#${input.number}`,
  securityClaimKey: (input: { repository: string; number: number; fingerprint: string; after?: string }) =>
    `review/${input.repository.toLowerCase()}#${input.number}/security/${input.fingerprint}/after/${input.after?.toLowerCase() ?? "none"}`,
  // Inline in review-announce.ts `takeRecheck`.
  reviewRecheckKey: (input: PrHead) => `review-recheck/${input.repository.toLowerCase()}#${input.number}/${input.headSha.toLowerCase()}`,
};

type ChangeMonitorVerdict = "pending" | "planned" | "verified" | "attention" | "incomplete";

const ISSUE_KEYS = ["TLSSN-36", "OPS-1", "A1-999999"];
const STATUSES = ["Triaged", "In Progress", "Planned"];
const CHANGELOG_IDS = ["10245", "triaged-10245", ""];
const THREADS: ThreadRef[] = [
  { channelId: "C0123ABCD", threadTs: "1712345678.123456" },
  { channelId: "D0ABC12" },
  { channelId: "C0123ABCD", threadTs: "" },
  { channelId: "C0123ABCD", threadTs: "-" },
  { channelId: "G01", threadTs: "1712345678.000100" },
];
const MESSAGES: Msg[] = [
  { channelId: "C0123ABCD", ts: "1712345678.123456" },
  { channelId: "D0ABC12", ts: "1.2" },
  { channelId: "C0123ABCD", ts: "" },
];
const REPOS = ["cursor-demo-lab/marsbank", "Cursor-Demo-Lab/MarsBank", "Org/Re#po", "a/b/c"];
const SHAS = ["0123456789abcdefABCDEF0123456789abcdef01", "DEADBEEF"];
const COMPONENTS: ReviewComponent[] = ["autofix", "bugbot", "security", "ci", "changeMonitor"];
const VERDICTS: ChangeMonitorVerdict[] = ["pending", "planned", "verified", "attention", "incomplete"];
const HOPS: Hop[] = ["triage", "plan", "launch"];
const COMMANDS: Command[] = [
  { verb: "approve", target: "TLSSN-36" },
  { verb: "deny", target: "file" },
  { verb: "replan", target: "OPS-1" },
];

const heads: PrHead[] = REPOS.flatMap((repository) => [28, 1].flatMap((number) => SHAS.map((headSha) => ({ repository, number, headSha }))));
const statusClaims = ISSUE_KEYS.flatMap((issueKey) => STATUSES.map((status) => ({ issueKey, status })));

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
  // New with the plan start check: no older bytes to match, so the pairs pin the documented shapes.
  planStartClaimKey: ISSUE_KEYS.flatMap((issueKey) =>
    (["alert", "final"] as const).flatMap((step) => CHANGELOG_IDS.map((changelogId) => ({ legacy: `announced/${issueKey}:plan-start-${step}:${changelogId}`, current: keys.planStartClaimKey({ issueKey, step, changelogId }) })))
  ),
  planStartRetryKey: ISSUE_KEYS.map((issueKey) => ({ legacy: `plan-start-retry/${issueKey}`, current: keys.planStartRetryKey(issueKey) })),
  ticketKey: same(ISSUE_KEYS, { legacy: legacy.ticketKey, current: keys.ticketKey }),
  announcedKey: same(
    statusClaims.flatMap((claim) => [claim, ...CHANGELOG_IDS.map((changelogId) => ({ ...claim, changelogId }))]),
    { legacy: legacy.announcedKey, current: keys.announcedKey }
  ),
  planAnnounceKey: same(
    statusClaims.flatMap((claim) => [claim, { ...claim, commentId: "10500" }, { ...claim, commentId: "" }]),
    { legacy: legacy.planAnnounceKey, current: keys.planAnnounceKey }
  ),
  triagedAnnounceKey: same(
    statusClaims.flatMap((claim) => ["none.first", "bug.high.plan.bug.high.first"].map((fingerprint) => ({ ...claim, fingerprint }))),
    { legacy: legacy.triagedAnnounceKey, current: keys.triagedAnnounceKey }
  ),
  hopWatchClaimKey: same(
    ISSUE_KEYS.flatMap((issueKey) => HOPS.flatMap((hop) => CHANGELOG_IDS.map((changelogId) => ({ issueKey, hop, changelogId })))),
    { legacy: legacy.hopWatchClaimKey, current: keys.hopWatchClaimKey }
  ),
  hopWatchKey: same(ISSUE_KEYS, { legacy: legacy.hopWatchKey, current: keys.hopWatchKey }),
  HOP_WATCH_INDEX: [{ legacy: legacy.HOP_WATCH_INDEX, current: keys.HOP_WATCH_INDEX }],
  BACKSTOP_SWEEP_KEY: [{ legacy: legacy.BACKSTOP_SWEEP_KEY, current: keys.BACKSTOP_SWEEP_KEY }],
  triagedSinceKey: same(ISSUE_KEYS, { legacy: legacy.triagedSinceKey, current: keys.triagedSinceKey }),
  triagedEntryKey: same(ISSUE_KEYS, { legacy: legacy.triagedEntryKey, current: keys.triagedEntryKey }),
  reactionKey: same(ISSUE_KEYS, { legacy: legacy.reactionKey, current: keys.reactionKey }),
  backlinkKey: same(ISSUE_KEYS, { legacy: legacy.backlinkKey, current: keys.backlinkKey }),
  plannerSentKey: same(ISSUE_KEYS, { legacy: legacy.plannerSentKey, current: keys.plannerSentKey }),
  planDeclinedKey: same(ISSUE_KEYS, { legacy: legacy.planDeclinedKey, current: keys.planDeclinedKey }),
  approveTicketKey: same(ISSUE_KEYS, { legacy: legacy.approveTicketKey, current: keys.approveTicketKey }),
  loaderKey: same(ISSUE_KEYS, { legacy: legacy.loaderKey, current: keys.loaderKey }),
  reviewGatesKey: same(ISSUE_KEYS, { legacy: legacy.reviewGatesKey, current: keys.reviewGatesKey }),
  slackApprovalKey: same(ISSUE_KEYS, { legacy: legacy.slackApprovalKey, current: keys.slackApprovalKey }),
  retryBounceKey: same(ISSUE_KEYS, { legacy: legacy.retryBounceKey, current: keys.retryBounceKey }),
  pullRequestRetryKey: same(ISSUE_KEYS, { legacy: legacy.pullRequestRetryKey, current: keys.pullRequestRetryKey }),
  issueTypesCacheKey: same(["TLSSN", "ops", ""], { legacy: legacy.issueTypesCacheKey, current: keys.issueTypesCacheKey }),
  threadTicketsKey: same(THREADS, { legacy: legacy.threadTicketsKey, current: keys.threadTicketsKey }),
  filingThreadKey: same(THREADS, { legacy: legacy.filingThreadKey, current: keys.filingThreadKey }),
  filingHoldKey: same(THREADS, { legacy: legacy.filingHoldKey, current: keys.filingHoldKey }),
  speakerKey: same(THREADS, { legacy: legacy.speakerKey, current: keys.speakerKey }),
  commandKey: same(
    THREADS.flatMap((thread) => COMMANDS.map((command) => ({ thread, command }))),
    { legacy: ({ thread, command }) => legacy.commandKey(thread, command), current: ({ thread, command }) => keys.commandKey(thread, command) }
  ),
  awaitingKey: same(THREADS, { legacy: legacy.awaitingKey, current: keys.awaitingKey }),
  intakeTriageKey: same(THREADS, { legacy: legacy.intakeTriageKey, current: keys.intakeTriageKey }),
  declineAnsweredKey: same(
    THREADS.flatMap((thread) => ISSUE_KEYS.map((issueKey) => ({ thread, issueKey }))),
    { legacy: legacy.declineAnsweredKey, current: keys.declineAnsweredKey }
  ),
  handledMessageKey: same(MESSAGES, { legacy: legacy.handledMessageKey, current: keys.handledMessageKey }),
  reactionClaimKey: same(
    MESSAGES.flatMap((message) => (["filing", "approve", "decline"] as const).map((act) => ({ ...message, act }))),
    { legacy: legacy.reactionClaimKey, current: keys.reactionClaimKey }
  ),
  planPostKey: same(MESSAGES, { legacy: legacy.planPostKey, current: keys.planPostKey }),
  filingPromptKey: same(MESSAGES, { legacy: legacy.filingPromptKey, current: keys.filingPromptKey }),
  intakeSettledKey: same(MESSAGES, { legacy: legacy.intakeSettledKey, current: keys.intakeSettledKey }),
  planCommandKey: same(MESSAGES, { legacy: legacy.planCommandKey, current: keys.planCommandKey }),
  approveCommandKey: same(MESSAGES, { legacy: legacy.approveCommandKey, current: keys.approveCommandKey }),
  retryCommandKey: same(MESSAGES, { legacy: legacy.retryCommandKey, current: keys.retryCommandKey }),
  threadDetailKey: same(MESSAGES, { legacy: legacy.threadDetailKey, current: keys.threadDetailKey }),
  reviewClaimKey: same(
    heads.flatMap((head) => COMPONENTS.map((component) => ({ ...head, component }))),
    { legacy: legacy.reviewClaimKey, current: keys.reviewClaimKey }
  ),
  changeMonitorPendingKey: same(heads, { legacy: legacy.changeMonitorPendingKey, current: keys.changeMonitorPendingKey }),
  changeMonitorClaimKey: same(
    heads.flatMap((head) => VERDICTS.map((verdict) => ({ ...head, verdict }))),
    { legacy: legacy.changeMonitorClaimKey, current: keys.changeMonitorClaimKey }
  ),
  changeMonitorMessageKey: same(heads, { legacy: legacy.changeMonitorMessageKey, current: keys.changeMonitorMessageKey }),
  reviewMessageKey: same(heads, { legacy: legacy.reviewMessageKey, current: keys.reviewMessageKey }),
  securityAnnouncedKey: same(heads, { legacy: legacy.securityAnnouncedKey, current: keys.securityAnnouncedKey }),
  securityClaimKey: same(
    heads.flatMap(({ repository, number, headSha }) =>
      ["findings-0123456789abcdef", "clean"].flatMap((fingerprint) => [{ repository, number, fingerprint }, { repository, number, fingerprint, after: headSha }])
    ),
    { legacy: legacy.securityClaimKey, current: keys.securityClaimKey }
  ),
  reviewRecheckKey: same(heads, { legacy: legacy.reviewRecheckKey, current: keys.reviewRecheckKey }),
};

test("every builder writes the same bytes it wrote before kv-keys.ts", () => {
  for (const [builder, pairs] of Object.entries(PAIRS)) {
    assert.ok(pairs.length > 0, builder);
    for (const pair of pairs) assert.equal(pair.current, pair.legacy, builder);
  }
});

test("the keys stored today, spelled out", () => {
  assert.equal(keys.ticketKey("TLSSN-36"), "ticket/TLSSN-36");
  assert.equal(keys.announcedKey({ issueKey: "TLSSN-36", status: "In Progress", changelogId: "10245" }), "announced/TLSSN-36:In Progress:10245");
  assert.equal(keys.planAnnounceKey({ issueKey: "TLSSN-36", status: "Planned", commentId: "10500" }), "announced/TLSSN-36:Planned:plan-10500");
  assert.equal(keys.hopWatchClaimKey({ issueKey: "TLSSN-36", hop: "plan", changelogId: "10245" }), "announced/TLSSN-36:hop-plan:10245");
  assert.equal(keys.handledMessageKey({ channelId: "C0123ABCD", ts: "1712345678.123456" }), "handled-message/C0123ABCD:1712345678.123456");
  assert.equal(keys.reactionClaimKey({ channelId: "C0123ABCD", ts: "1712345678.123456", act: "approve" }), "reaction/C0123ABCD:1712345678.123456/approve");
  assert.equal(keys.speakerKey({ channelId: "D0ABC12" }), "speaker/D0ABC12:");
  assert.equal(keys.intakeTriageKey({ channelId: "D0ABC12", threadTs: "" }), "intake-triage/D0ABC12:");
  assert.equal(keys.declineAnsweredKey({ thread: { channelId: "D0ABC12" }, issueKey: "TLSSN-36" }), "decline-answered/D0ABC12:-/TLSSN-36");
  assert.equal(keys.declineAnsweredKey({ thread: { channelId: "D0ABC12", threadTs: "" }, issueKey: "TLSSN-36" }), "decline-answered/D0ABC12:/TLSSN-36");
  assert.equal(keys.commandKey({ channelId: "C1", threadTs: "1.2" }, { verb: "deny", target: "file" }), "command/C1:1.2/deny:file");
  const head = { repository: "Cursor-Demo-Lab/MarsBank", number: 28, headSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" };
  assert.equal(keys.reviewClaimKey({ ...head, component: "changeMonitor" }), "review/cursor-demo-lab/marsbank#28/abcdef0123456789abcdef0123456789abcdef01/changeMonitor");
  assert.equal(keys.changeMonitorClaimKey({ ...head, verdict: "planned" }), "review/cursor-demo-lab/marsbank#28/abcdef0123456789abcdef0123456789abcdef01/changeMonitor-planned");
  assert.equal(keys.securityClaimKey({ repository: head.repository, number: 28, fingerprint: "findings-ABC" }), "review/cursor-demo-lab/marsbank#28/security/findings-ABC/after/none");
  assert.equal(keys.reviewRecheckKey(head), "review-recheck/cursor-demo-lab/marsbank#28/abcdef0123456789abcdef0123456789abcdef01");
});

test("one threadId: every thread key embeds the same `<channel>:<thread ts or ''>` segment", () => {
  for (const thread of THREADS) {
    const id = keys.threadId(thread);
    assert.equal(id, legacy.threadId(thread));
    for (const [prefix, key] of [
      ["thread-tickets/", keys.threadTicketsKey(thread)],
      ["filing-thread/", keys.filingThreadKey(thread)],
      ["file-ticket/", keys.filingHoldKey(thread)],
      ["speaker/", keys.speakerKey(thread)],
      ["awaiting-info/", keys.awaitingKey(thread)],
      ["intake-triage/", keys.intakeTriageKey(thread)],
    ] as const) {
      assert.equal(key, `${prefix}${id}`);
    }
  }
});

test("the registry names every builder once per prefix, and each builder's keys start with its prefix", () => {
  const exported = Object.entries(keys).filter(([name, value]) => (typeof value === "function" && name.endsWith("Key")) || (typeof value === "string" && /^[A-Z_]+$/.test(name)));
  const registered = keys.KEY_REGISTRY.map((entry) => entry.builder);
  assert.deepEqual([...new Set(registered)].sort(), registered.slice().sort(), "a builder is registered twice");
  assert.deepEqual(exported.map(([name]) => name).sort(), registered.slice().sort());
  assert.deepEqual(Object.keys(PAIRS).sort(), registered.slice().sort(), "every registered builder has old-vs-new cases");
  for (const entry of keys.KEY_REGISTRY) {
    for (const pair of PAIRS[entry.builder] ?? []) assert.ok(pair.current.startsWith(entry.prefix), `${entry.builder}: ${pair.current} does not start with ${entry.prefix}`);
  }
});

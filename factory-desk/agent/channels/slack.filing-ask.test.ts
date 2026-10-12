import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultOnInbound, createEventIdDedupe, dispatchInboundFromEventBody, getSlackChannelOptions, resetExternalSenderCache, type SlackApiTransport } from "@cursor/july/channels/slack";
import { recordKv } from "../lib/kv-race.fixtures.js";
import { oneReplyEvents } from "../lib/one-reply.js";
import { FILING_ASK, FILING_ASK_REACTIONS, filingPrompt, intakeTriageContext, triagedByLead } from "../lib/intake-triage.js";
import { answersConfidence, severityCeiling, templateVerdict, type JevAnswers } from "../lib/jev-triage.js";
import { asksToFile, filingPromptKey } from "../lib/reaction-targets.js";
import { bareReplyReaches } from "../lib/desk-channels.js";
import type { TriageSeverity } from "../lib/triage-verdict.js";
import slack from "./slack.js";


process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";

// `type` defaults to Bug. A Story row shows that no loss or critical phrase
// was read (its type caps it); a Bug row with no evidence keeps Jev's severity.
type Row = { text: string; ceiling: TriageSeverity; type?: string; why?: string };

const HOLDS: Row[] = [
  { text: "No outage, just a slow page", ceiling: "medium", type: "Story", why: "no outage negates the outage" },
  { text: "No outage, just a slow page", ceiling: "urgent", why: "no evidence: a Bug keeps Jev's severity" },
  { text: "Not a data leak, only the tooltip text", ceiling: "medium", type: "Story", why: "not a negates the leak" },
  { text: "Not a data leak, only the tooltip text", ceiling: "urgent", why: "a UI word with no cosmetic predicate is not evidence" },
  { text: "We didn’t lose any records", ceiling: "medium", type: "Story", why: "didn't negates the loss" },
  { text: "We didn’t lose any records", ceiling: "urgent", why: "no evidence: a Bug keeps Jev's severity" },
  { text: "Customer records were\u00A0\u00A0deleted", ceiling: "urgent" },
  { text: "Customer records were\r\n\r\ndeleted", ceiling: "urgent" },
  { text: "We could have lost data here", ceiling: "urgent" },
  { text: "Someone could easily delete customer records; add a confirm", ceiling: "medium", why: "hypothetical loss, and a request" },
  { text: "Site down", ceiling: "urgent" },
  { text: "The ＡＰＩ is down", ceiling: "urgent" },
  { text: "The price went down to 0", ceiling: "urgent" },
  { text: "Please add a way to delete old files", ceiling: "medium", why: "a request" },
  { text: "No security issue here, but can we rename the button", ceiling: "medium", why: "a request" },
  { text: "保存ボタンの文言を変えてほしい please", ceiling: "urgent", why: "Japanese-majority: fail-open" },
  { text: "ログインできません users can't log in", ceiling: "urgent" },
];

// REGRESSIONS: failed at e7e8226; pinned by the round-3 fixes. The drop rows
// are left to Jev since the drop machinery went: a drop left at urgent is Low,
// the outages it capped were High.
const REGRESSIONS: Row[] = [
  { text: "App down to one column on mobile", ceiling: "urgent", why: "left to Jev" },
  { text: "Payments down by 5% this week", ceiling: "urgent", why: "left to Jev" },
  { text: "Login down to two seconds after the fix", ceiling: "urgent", why: "left to Jev" },
  { text: "The export page shows データが消えました", ceiling: "urgent", why: "Latin-majority mixed text: a Japanese data-loss phrase is capped" },
  { text: "The export page: データが消えました after the update yesterday afternoon for our team", ceiling: "urgent", why: "Latin-majority mixed text: a Japanese data-loss phrase is capped" },
  { text: "Nobody lost any data, the chart is just slow", ceiling: "medium", type: "Story", why: "nobody negates the loss" },
  { text: "Nobody lost any data, the chart is just slow", ceiling: "urgent", why: "a negation is not evidence: a Bug keeps Jev's severity" },
  { text: "The site is down from the deploy", ceiling: "urgent", why: "down from a cause (Bugbot)" },
  { text: "The API is down an hour now", ceiling: "urgent", why: "down a duration (Bugbot)" },
  { text: "We've been down two hours", ceiling: "urgent", why: "down a duration (Bugbot)" },
  { text: "Revenue is down 5% this week", ceiling: "urgent", why: "left to Jev" },
  { text: "Latency went down from 900ms to 200ms", ceiling: "urgent", why: "left to Jev" },
  { text: "Not really a security issue: the tooltip overlaps the logo", ceiling: "medium", why: "not really a negates the security phrase; a UI element's appearance is evidence" },
];

for (const row of HOLDS) {
  test(`guard holds: ${JSON.stringify(row.text)} as ${row.type ?? "Bug"} → ${row.ceiling}${row.why === undefined ? "" : ` (${row.why})`}`, () => assert.equal(severityCeiling({ text: row.text, type: row.type ?? "Bug" }), row.ceiling));
}
for (const row of REGRESSIONS) {
  test(`guard: ${JSON.stringify(row.text)} as ${row.type ?? "Bug"} → ${row.ceiling} (${row.why})`, () => assert.equal(severityCeiling({ text: row.text, type: row.type ?? "Bug" }), row.ceiling));
}

const TEST_B = 'The "Log out" button in the banking header signs you out immediately, even when you\'re halfway through a transfer on Move tokens.\n\nOne of our testers lost a half-filled transfer after brushing it on a trackpad. It would be nicer if it asked "Leave this transfer?" when the form has unsaved input, and logged out straight away otherwise.';

function answers(severity: [string, number], probabilities?: Record<string, number>): JevAnswers {
  return {
    issueType: { choice: "Bug", probabilities: { Bug: 0.99 } },
    severity: { choice: severity[0], probabilities: probabilities ?? { [severity[0]]: severity[1] } },
    gate: { choice: "proceed", probabilities: { proceed: 0.97 } },
  } as unknown as JevAnswers;
}

test("live Test B stays ≤ medium for every Jev severity", () => {
  for (const s of ["low", "medium", "high", "urgent"]) {
    const v = templateVerdict({ identifier: "T-1", title: TEST_B.split("\n")[0]!, description: TEST_B }, answers([s, 0.9]));
    assert.ok(v !== undefined && ["low", "medium"].includes(v.severity), `${s} → ${v?.severity}`);
  }
});

test("confidence: zero probability gives no number anywhere", () => {
  const zero = answers(["low", 0]);
  assert.equal(answersConfidence(zero), undefined);
  assert.doesNotMatch(triagedByLead({ by: "model", reason: "below_bar", jev: { answers: zero } as never }), /confidence|%/);
});

test("filing prompt per channel kind: DM and watched get typed replies, unwatched gets reactions only; every variant and the old prompt are found", () => {
  const block = (channel: string) => intakeTriageContext({ by: "model", reason: "unavailable" }, { text: "the export is broken", bareReply: bareReplyReaches(channel, {}) });
  const prompt = (b: string) => b.split("<filing_prompt>\n")[1]!.split("\n</filing_prompt>")[0]!;
  assert.ok(prompt(block("D0DM00001")).endsWith(FILING_ASK));
  assert.ok(prompt(block("C0EXAMPLE1")).endsWith(FILING_ASK));
  assert.ok(prompt(block("C0UNWATCHED")).endsWith(FILING_ASK_REACTIONS));
  const old = "X\nTriaged by Jev: Bug, high severity.\nReact ✅ to file it with this triage or ❌ to drop it, or reply `@factory approve file` / `@factory deny file`.";
  for (const text of [prompt(block("D0DM00001")), prompt(block("C0UNWATCHED")), old, filingPrompt({ title: "X", lead: "Triaged by Jev", type: "Bug", severity: "low", summary: "Y", ask: FILING_ASK_REACTIONS })]) assert.ok(asksToFile(text), text);
  assert.equal(asksToFile("Thanks! React ✅ to file or ❌ to drop"), false, "not a whole last line");
});

test("a reaction-only prompt with a trailing model line is still a filing prompt; ordinary replies are not", () => {
  const tail = "\nLet me know if anything looks off.";
  assert.ok(asksToFile(`X\n${FILING_ASK}${tail}`));
  assert.ok(asksToFile(`X\n${FILING_ASK_REACTIONS}${tail}`));
  assert.ok(asksToFile(`X\n${FILING_ASK_REACTIONS}\nOne more line.\nAnd another.`), "on the third-last line");
  for (const reply of [
    `${FILING_ASK_REACTIONS}\nA\nB\nC`,
    `You can react to the prompt above: "${FILING_ASK_REACTIONS}"`,
    "TLSSN-42 is filed. Triaged by Jev: Bug, low severity (78% confidence).",
    "React ✅ to start the build or ❌ to stop.",
  ]) assert.equal(asksToFile(reply), false, reply);
});

const TEAM = "T0123";
const UNWATCHED = "C0UNWATCHED";
const ROOT = "1758510000.123456";
const FILER = "U0ALICE01";

test("end to end in an unwatched channel: the sink records a reaction-only prompt and the requester's ✅ on it starts the approve-file turn", async () => {
  const rows: Record<string, unknown> = {};
  const kv = recordKv(rows);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      const body = args as Record<string, unknown>;
      calls.push({ method, args: body });
      if (method === "auth.test") return { ok: true, user_id: "U0FACTORY", user: "factory" };
      if (method === "users.info") return { ok: true, user: { id: body["user"], name: "alice", team_id: TEAM, is_bot: false, profile: { display_name: "alice" } } };
      if (method === "chat.postMessage") return { ok: true, ts: "1758510100.000900" };
      return { ok: true, messages: [] };
    },
  };
  const events = oneReplyEvents({ credentials: { botToken: transport } });
  const state = { channelId: UNWATCHED, threadTs: ROOT, teamId: TEAM, triggeringUserId: FILER } as never;
  const channel = { channelId: "slack", state, continuationToken: null, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_r2", auth: { attributes: { channel_id: UNWATCHED, thread_ts: ROOT } } }, host: { kv } } as never;
  const prompt = filingPrompt({ title: "CSV export drops the header", lead: "Triaged by Jev", type: "Bug", severity: "low", summary: "The header row is gone.", ask: FILING_ASK_REACTIONS });
  await events["turn.completed"]?.({ sessionId: "ses_r2", turnId: "t1", type: "turn.completed", data: { result: prompt } } as never, channel, ctx);
  const recorded = rows[filingPromptKey({ channelId: UNWATCHED, ts: "1758510100.000900" })] as Record<string, unknown> | undefined;
  assert.equal(recorded?.["requester"], FILER, "reaction-only prompt recorded");

  resetExternalSenderCache();
  const options = getSlackChannelOptions(slack)!;
  const sends: Array<Record<string, unknown>> = [];
  const pending: Promise<unknown>[] = [];
  const client = { apiCall: (method: string, args: Record<string, unknown>) => transport.call(method, args) };
  dispatchInboundFromEventBody(
    { type: "event_callback", team_id: TEAM, event_id: "EvR2", event: { type: "reaction_added", user: FILER, reaction: "white_check_mark", item: { type: "message", channel: UNWATCHED, ts: "1758510100.000900" }, item_user: "U0FACTORY", event_ts: "1758510200.000100" } },
    {
      send: (async (p: string, o: Record<string, unknown>) => (sends.push({ ...o, prompt: p }), { sessionId: "ses_x" })) as never,
      waitUntil: (p) => void pending.push(p),
      onAppMention: options.onAppMention ?? createDefaultOnInbound(),
      onDirectMessage: options.onDirectMessage ?? createDefaultOnInbound(),
      ...(options.onReactionAdded === undefined ? {} : { onReactionAdded: options.onReactionAdded }),
      credentials: { botToken: transport },
      eventIds: createEventIdDedupe(),
      host: { kv, slack: { getClient: async () => client }, mcp: { names: () => [], listTools: async () => [], callTool: async () => ({ content: [] }) } } as never,
      artifacts: {} as never,
      log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never,
      mentionsEnabled: true,
      directMessagesEnabled: true,
    }
  );
  await Promise.all(pending);
  assert.equal(sends.length, 1, "one filing turn");
  assert.match(String(sends[0]!["prompt"]), /\napprove file$/);
  const auth = sends[0]!["auth"] as { attributes: Record<string, unknown> };
  assert.deepEqual([auth.attributes["channel_id"], auth.attributes["thread_ts"]], [UNWATCHED, ROOT]);
});

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import {
  createDefaultOnInbound,
  createEventIdDedupe,
  dispatchInboundFromEventBody,
  getSlackChannelOptions,
  resetExternalSenderCache,
  type SlackApiTransport,
} from "@cursor/july/channels/slack";
import { fittedRequestTitle, intakeTriageKey, SLOT } from "../lib/intake-triage.js";
import {
  LIVE_ACCOUNTS_TEXT,
  LIVE_ACCOUNTS_TITLE,
  LIVE_ACTIVITY_TEXT,
  LIVE_ACTIVITY_TITLE,
  LIVE_INTAKE_CHANNEL,
  LIVE_INTAKE_SUMMARY,
  LIVE_INTAKE_TEXT,
  LIVE_INTAKE_TITLE,
  LIVE_INTAKE_TS,
} from "../lib/live-intake.fixtures.js";
import { filingThreadKey } from "../lib/thread-tickets.js";
import { asksToFile } from "../lib/reaction-targets.js";
import slack from "./slack.js";

// Triage before filing: a Slack filing request is asked of Jev before the
// model turn that drafts the filing prompt, through July's own dispatch.
// Confident, the turn is told to copy Jev's type, severity, and summary;
// at or under the bar, or with Jev down, the turn is told to triage it
// itself. Either way the answer is kept for the thread `approve file` reads.

const TEAM = "T0123";
const saved = { key: process.env.TYPESAFE_API_KEY, project: process.env.FACTORY_DESK_JIRA_PROJECT, settle: process.env.FACTORY_DESK_CLAIM_SETTLE_MS, fetch: globalThis.fetch };
let order: string[] = [];

before(() => {
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
});
beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.FACTORY_DESK_JIRA_PROJECT = "TLSSN";
  order = [];
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
});
after(() => {
  for (const [name, value] of [["TYPESAFE_API_KEY", saved.key], ["FACTORY_DESK_JIRA_PROJECT", saved.project], ["FACTORY_DESK_CLAIM_SETTLE_MS", saved.settle]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Pair = [string, number];
function jev(issueType: Pair, severity: Pair, gate: Pair = ["proceed", 0.9]) {
  globalThis.fetch = (async () => {
    order.push("jev");
    const answer = ([choice, probability]: Pair) => ({ choice, probabilities: { [choice]: probability } });
    return new Response(JSON.stringify({ answers: { issueType: answer(issueType), severity: answer(severity), gate: answer(gate) } }), { status: 200 });
  }) as typeof globalThis.fetch;
}
function jevDown() {
  globalThis.fetch = (async () => {
    order.push("jev");
    throw new Error("TypeSafe unreachable");
  }) as typeof globalThis.fetch;
}

const TYPES = { issueTypes: [{ id: "10170", name: "Task", subtask: false }, { id: "10171", name: "Story", subtask: false }, { id: "10172", name: "Bug", subtask: false }] };

async function deliver(event: Record<string, unknown>, kv: Record<string, unknown> = {}) {
  resetExternalSenderCache();
  const options = getSlackChannelOptions(slack)!;
  const slackCalls: Array<[string, Record<string, unknown>]> = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args) => {
      slackCalls.push([method, args as Record<string, unknown>]);
      if (method === "users.info") return { ok: true, user: { id: "U0ALICE", team_id: TEAM } };
      if (method === "chat.postMessage") return { ok: true, ts: "1758510001.000100" };
      return { ok: true, messages: [] };
    },
  };
  const client = { apiCall: (method: string, args: Record<string, unknown>) => transport.call(method, args) };
  const mcpCalls: string[] = [];
  const host = {
    kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] },
    slack: { getClient: async () => client },
    mcp: {
      names: () => ["tracker"],
      listTools: async () => [{ name: "getJiraProjectIssueTypesMetadata", inputSchema: { type: "object", properties: { projectIdOrKey: { type: "string" } } } }],
      callTool: async (_connection: string, tool: string): Promise<HostMcpCallResult> => {
        mcpCalls.push(tool);
        return { content: [{ type: "text", text: JSON.stringify(TYPES) }] };
      },
    },
  };
  const sends: unknown[][] = [];
  const pending: Promise<unknown>[] = [];
  dispatchInboundFromEventBody(
    { type: "event_callback", team_id: TEAM, event_id: `Ev${Math.random()}`, event: { team: TEAM, ...event } },
    {
      send: (async (...args: unknown[]) => {
        order.push("model");
        sends.push(args);
        return { sessionId: "ses_test" };
      }) as never,
      waitUntil: (promise) => void pending.push(promise),
      onAppMention: options.onAppMention ?? createDefaultOnInbound(),
      onDirectMessage: options.onDirectMessage ?? createDefaultOnInbound(),
      credentials: { botToken: transport },
      eventIds: createEventIdDedupe(),
      host: host as never,
      artifacts: {} as never,
      log: { info: () => {}, error: () => {}, warn: () => {} } as never,
      mentionsEnabled: true,
      directMessagesEnabled: true,
    }
  );
  await Promise.all(pending);
  return { sends, kv, mcpCalls, slackCalls, prompt: JSON.stringify(sends[0] ?? []) };
}

const TOP = "1758510000.123456";
const filing = (text: string) => ({ type: "app_mention", user: "U0ALICE", text, ts: TOP, channel: "C0123ABCD" });
const stashed = (kv: Record<string, unknown>) => (kv[intakeTriageKey({ channelId: "C0123ABCD", threadTs: TOP })] as { triage?: Record<string, unknown> } | undefined)?.triage;

// The filing prompt host code wrote, unescaped out of the send payload.
const filingPromptIn = (sends: unknown[][]) => {
  const context = JSON.stringify(sends[0] ?? []);
  const block = context.match(/<filing_prompt>\\n(.*?)\\n<\/filing_prompt>/)?.[1];
  return block === undefined ? undefined : (JSON.parse(`"${block}"`) as string);
};
// Never a mention, and only this prompt's decision: typed replies where a
// plain reply reaches the desk (a DM, a watched channel), reactions only in
// C0123ABCD, which the desk does not watch.
const ASK = "React ✅ to file or ❌ to drop, or reply `approve file` / `deny file`.";
const REACT_ASK = "React ✅ to file or ❌ to drop.";

test("Jev confident: asked before the filing turn, which says in plain words that Jev triaged it before filing, with no scores", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const { sends, kv, mcpCalls, prompt } = await deliver(filing("<@U0FACTORY> file a bug: CSV export returns 500 since this morning"));
  assert.deepEqual(order, ["jev", "model"], "Jev answers before the model turn starts");
  assert.equal(sends.length, 1, "one filing turn");
  assert.ok(mcpCalls.includes("getJiraProjectIssueTypesMetadata"), "Jev chooses among the project's own types");
  assert.match(prompt, /<intake_triage by=\\"jev\\">/);
  assert.equal(
    filingPromptIn(sends),
    [SLOT.title, "Triaged by Jev: Bug, medium severity (84% confidence).", "Summary: <one short sentence in your own words>", REACT_ASK].join("\n"),
    "the host writes every line but the summary a one-line request cannot give, and the ask is this prompt's decision only"
  );
  assert.doesNotMatch(prompt, /reported as/, "TLSSN-37: never the title template");
  assert.doesNotMatch(prompt, /approve KEY|0\.93|0\.84|triage_rubric/);
  const triage = stashed(kv);
  assert.equal(triage?.["by"], "jev");
  assert.equal(triage?.["type"], "Bug");
});

test("Jev confident on a request with a body: the turn writes the Summary, never the body's first sentence copied", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const { sends, kv } = await deliver(filing("<@U0FACTORY> file a bug: CSV export returns 500\nIt fails whenever the filter matches no rows. Since this morning."));
  assert.equal(filingPromptIn(sends)?.split("\n").slice(0, 3).join("\n"), `${SLOT.title}\nTriaged by Jev: Bug, medium severity (84% confidence).\nSummary: <one short sentence in your own words>`);
  assert.equal(stashed(kv)?.["summary"], undefined, "no summary lifted from the body");
  assert.doesNotMatch(filingPromptIn(sends) ?? "", /Summary: It fails whenever/);
});

test("TLSSN-36 at the 0.52 bar: severity 0.54 (under the old 0.55) now takes Jev's path", async () => {
  jev(["Bug", 0.99], ["low", 0.54]);
  const { kv, prompt, sends } = await deliver(filing("<@U0FACTORY> file a bug: card export CSV drops the last row"));
  assert.match(prompt, /<intake_triage by=\\"jev\\">/);
  assert.equal(filingPromptIn(sends)?.split("\n")[1], "Triaged by Jev: Bug, low severity (54% confidence).");
  assert.equal(stashed(kv)?.["by"], "jev");
});

test("Jev below the bar: the filing turn triages it with the rubric inline, and the prompt says Jev wasn't sure", async () => {
  jev(["Story", 0.91], ["medium", 0.52]);
  const { sends, kv, prompt } = await deliver(filing("<@U0FACTORY> file a bug: could the register show running balances"));
  assert.deepEqual(order, ["jev", "model"]);
  assert.equal(sends.length, 1, "one filing turn, no second triage turn");
  assert.match(prompt, /<intake_triage by=\\"model\\">/);
  assert.match(prompt, /Jev was not confident: an answer at or under 0\.52/);
  assert.equal(
    filingPromptIn(sends),
    [SLOT.title, "Triaged by Grok 4.6 Fast (Jev was only 52% confident): Story, <severity> severity.", "Summary: <one short sentence in your own words>", REACT_ASK].join("\n"),
    "every line but the model's slots is host text, Summary: included"
  );
  assert.match(prompt, /<triage_rubric>\\n# Triage rubric/, "the rubric is in the turn; no skill to go looking for");
  assert.match(prompt, /no search for a skill or file/);
  assert.equal(stashed(kv)?.["by"], "model");
  assert.equal(stashed(kv)?.["reason"], "below_bar");
});

test("a confident Story over defect wording is type_guard even when severity is under the bar, so filing never takes Jev's Story from the model's restatement", async () => {
  jev(["Story", 0.91], ["medium", 0.52]);
  const { sends, kv } = await deliver(filing("<@U0FACTORY> file a bug: the statement PDF is blank since the release"));
  assert.equal(stashed(kv)?.["reason"], "type_guard");
  assert.doesNotMatch(filingPromptIn(sends) ?? "", /: Story,/);
});

test("Jev error: the filing turn triages it with the rubric inline, and the prompt says Jev didn't answer", async () => {
  jevDown();
  const { sends, kv, prompt } = await deliver(filing("<@U0FACTORY> file a bug: payee search ignores the account id"));
  assert.equal(sends.length, 1);
  assert.match(prompt, /<intake_triage by=\\"model\\">/);
  assert.equal(filingPromptIn(sends)?.split("\n").slice(1, 3).join("\n"), "Triaged by Grok 4.6 Fast (Jev didn't answer): <Type>, <severity> severity.\nSummary: <one short sentence in your own words>");
  assert.match(prompt, /<Type>: Bug for a bug, Task for feedback or a question\./);
  assert.match(prompt, /<triage_rubric>/);
  assert.deepEqual(stashed(kv), { by: "model", reason: "unavailable" });
});

test("in a watched channel the ask is the same decision line, with no look-ahead", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const { sends } = await deliver({ ...filing("<@U0FACTORY> file a bug: CSV export returns 500"), channel: "C0EXAMPLE1" });
  assert.equal(filingPromptIn(sends)?.split("\n").at(-1), ASK);
  assert.doesNotMatch(filingPromptIn(sends) ?? "", /Once it is filed|planned|start the build/);
});

// Live 2026-09-27: a confirmation-step request came out "Triaged by Jev: Bug, urgent severity."
const LOG_OUT = 'The "Log out" button logs you out straight away even when the transfer form has something typed in. Could it ask to confirm first when the form has input?';

test("a confirmation-step request Jev calls urgent is filed at medium: the guard caps it before the filing prompt", async () => {
  jev(["Bug", 0.93], ["urgent", 0.84]);
  const { sends, kv } = await deliver(filing(`<@U0FACTORY> ${LOG_OUT}`));
  assert.equal(filingPromptIn(sends)?.split("\n")[1], "Triaged by Jev: Bug, medium severity (84% confidence; Jev said urgent).");
  assert.equal(stashed(kv)?.["severity"], "medium");
});

test("a data-loss report Jev calls urgent stays urgent", async () => {
  jev(["Bug", 0.93], ["urgent", 0.84]);
  const { sends } = await deliver(filing("<@U0FACTORY> file a bug: saving a payee deleted every transaction record on the account"));
  assert.equal(filingPromptIn(sends)?.split("\n")[1], "Triaged by Jev: Bug, urgent severity (84% confidence).");
});

test("Jev below the bar on the Log out request: the model's severity slot is told it is at most medium", async () => {
  jev(["Bug", 0.93], ["urgent", 0.5]);
  const { prompt } = await deliver(filing(`<@U0FACTORY> ${LOG_OUT}`));
  assert.match(prompt, /<severity>: low or medium\. The request is about typed input, how the UI looks, or a change the reporter wants, and names no data loss, security exposure, or outage, so it is never high or urgent/);
  assert.doesNotMatch(prompt, /<severity>: low, medium, high, or urgent/);
});

test("a message that is not a filing request gets no Jev call and no triage block", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const { prompt, kv } = await deliver(filing("<@U0FACTORY> what happened to TLSSN-4?"));
  assert.deepEqual(order, ["model"]);
  assert.doesNotMatch(prompt, /intake_triage/);
  assert.equal(stashed(kv), undefined);
});

test("in the watched intake channel the filing ask and the reply hint drop the mention: a plain `approve file` reaches the desk there", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const { sends, prompt } = await deliver({ ...filing("<@U0FACTORY> file a bug: CSV export returns 500 since this morning"), channel: "C0EXAMPLE1" });
  assert.equal(filingPromptIn(sends)?.split("\n").at(-1), "React ✅ to file or ❌ to drop, or reply `approve file` / `deny file`.");
  assert.match(prompt, /A command you ask for is written without a mention: `approve file`, `deny file`, `approve`\./);
  assert.doesNotMatch(prompt, /@factory approve/);
});

// The #mars-eng-intake report that named its bug without a filing phrase:
// on fd1adbf it got no Jev call, no 👀, and "Jev wasn't asked".
const live = () => ({ type: "app_mention", user: "U0ALICE", text: LIVE_INTAKE_TEXT, ts: LIVE_INTAKE_TS, channel: LIVE_INTAKE_CHANNEL });
const liveThread = { channelId: LIVE_INTAKE_CHANNEL, threadTs: LIVE_INTAKE_TS };

test("a top-level problem report with no filing phrase is asked of Jev first, gets 👀, and marks its thread a filing thread", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const { sends, kv, slackCalls, prompt } = await deliver(live());
  assert.deepEqual(order, ["jev", "model"], "Jev answers before the filing turn");
  assert.match(prompt, /<intake_triage by=\\"jev\\">/);
  assert.equal(
    filingPromptIn(sends),
    [
      SLOT.title,
      "Triaged by Jev: Bug, medium severity (84% confidence).",
      "Summary: <one short sentence in your own words>",
      "React ✅ to file or ❌ to drop, or reply `approve file` / `deny file`.",
    ].join("\n"),
    "Jev's triage, a summary beyond the title, and no mention: a plain reply reaches the desk in #mars-eng-intake"
  );
  assert.doesNotMatch(filingPromptIn(sends) ?? "", /@factory/);
  assert.doesNotMatch(prompt, /Jev wasn't asked/);
  const stash = (kv[intakeTriageKey(liveThread)] as { triage?: Record<string, unknown> } | undefined)?.triage;
  assert.equal(stash?.["by"], "jev");
  assert.ok(slackCalls.some(([method, args]) => method === "reactions.add" && args["name"] === "eyes" && args["timestamp"] === LIVE_INTAKE_TS), "👀 on the request");
  assert.notEqual(kv[filingThreadKey(liveThread)], undefined, "a plain approve there before filing takes the approve file route");
});

test("the block for a report with no filing phrase lets a non-report be answered normally; a filing phrase gets no way out", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  assert.match((await deliver(live())).prompt, /ignore this block and answer it by its own rule/);
  jev(["Bug", 0.93], ["medium", 0.84]);
  assert.doesNotMatch((await deliver(filing("<@U0FACTORY> file a bug: CSV export returns 500 since this morning"))).prompt, /ignore this block/);
});

// A DM is one conversation (July keys it on the channel), so every message
// in it is top-level: a follow-up to a pending filing prompt must not be
// asked of Jev as a new request and overwrite the triage that prompt shows.
const DM = "D0DM00001";
const dm = (text: string, ts: string) => ({ type: "message", channel_type: "im", user: "U0ALICE", text, ts, channel: DM });
const DM_REPORT = "1758510100.000100";
const dmStash = (kv: Record<string, unknown>, threadTs?: string) =>
  (kv[intakeTriageKey(threadTs === undefined ? { channelId: DM } : { channelId: DM, threadTs })] as { triage?: Record<string, unknown> } | undefined)?.triage;

test("in a DM, a follow-up to a pending filing prompt is shown that prompt again: no Jev call, and the triage ✅ files is not overwritten", async () => {
  const kv: Record<string, unknown> = {};
  jev(["Bug", 0.93], ["medium", 0.84]);
  await deliver(dm("CSV export returns 500 when the filter matches no rows", DM_REPORT), kv);
  assert.equal(dmStash(kv)?.["severity"], "medium");
  for (const [text, ts] of [["it also happens on Safari when I click Export", "1758510160.000100"], ["yes please go ahead and file it", "1758510170.000100"]] as const) {
    order = [];
    jev(["Task", 0.95], ["low", 0.95]);
    const { sends } = await deliver(dm(text, ts), kv);
    assert.deepEqual(order, ["model"], `${text}: no Jev call`);
    assert.equal(
      filingPromptIn(sends)?.split("\n").slice(0, 2).join("\n"),
      `${SLOT.title}\nTriaged by Jev: Bug, medium severity (84% confidence).`,
      `${text}: the pending prompt, not one for the follow-up`
    );
    for (const threadTs of [undefined, DM_REPORT, ts]) {
      assert.deepEqual([dmStash(kv, threadTs)?.["type"], dmStash(kv, threadTs)?.["severity"]], ["Bug", "medium"], `${text}: the triage at ${threadTs ?? "the DM"} is the report's`);
    }
  }
});

test("in a DM, a filing phrase or a report after deny file is a new request and is asked of Jev", async () => {
  const kv: Record<string, unknown> = {};
  jev(["Bug", 0.93], ["medium", 0.84]);
  await deliver(dm("CSV export returns 500 when the filter matches no rows", DM_REPORT), kv);
  order = [];
  jev(["Task", 0.95], ["low", 0.95]);
  await deliver(dm("file a bug: the login page takes ten seconds on mobile", "1758510200.000100"), kv);
  assert.deepEqual(order, ["jev", "model"], "a filing phrase in a DM starts a new request");
  assert.equal(dmStash(kv)?.["type"], "Task");

  await deliver(dm("deny file", "1758510210.000100"), kv);
  assert.equal(dmStash(kv), undefined, "deny file forgets the request");
  order = [];
  jev(["Bug", 0.95], ["medium", 0.95]);
  await deliver(dm("the payee list shows every payee twice since today", "1758510220.000100"), kv);
  assert.deepEqual(order, ["jev", "model"], "nothing is pending after deny file");
});

test("in a DM, after deny file a threaded reply under the follow-up is not shown the declined request again", async () => {
  const kv: Record<string, unknown> = {};
  jev(["Bug", 0.93], ["medium", 0.84]);
  await deliver(dm("CSV export returns 500 when the filter matches no rows", DM_REPORT), kv);
  const FOLLOW_UP = "1758510160.000100";
  await deliver(dm("it also happens on Safari when I click Export", FOLLOW_UP), kv);
  await deliver(dm("deny file", "1758510170.000100"), kv);
  order = [];
  jev(["Task", 0.95], ["low", 0.95]);
  const { sends } = await deliver({ ...dm("the payee list shows every payee twice since today", "1758510180.000100"), thread_ts: FOLLOW_UP }, kv);
  assert.deepEqual(order, ["jev", "model"], "the declined request's copy under the follow-up is settled");
  assert.doesNotMatch(filingPromptIn(sends) ?? "", /CSV export returns 500/);
});

test("in a channel thread, a reply that says file a bug while the thread's prompt is pending does not replace its triage", async () => {
  const kv: Record<string, unknown> = {};
  jev(["Bug", 0.93], ["medium", 0.84]);
  await deliver(filing("<@U0FACTORY> file a bug: CSV export returns 500 since this morning"), kv);
  order = [];
  jev(["Task", 0.95], ["low", 0.95]);
  const { sends } = await deliver({ ...filing("<@U0FACTORY> yes please file a bug for this"), ts: "1758510050.000100", thread_ts: TOP }, kv);
  assert.deepEqual(order, ["model"], "no Jev call on the reply");
  assert.equal(filingPromptIn(sends)?.split("\n").slice(0, 2).join("\n"), `${SLOT.title}\nTriaged by Jev: Bug, medium severity (84% confidence).`);
  assert.deepEqual([stashed(kv)?.["type"], stashed(kv)?.["severity"]], ["Bug", "medium"]);
});

test("an e2e-tagged report phrased as a question is asked of Jev and gets 👀: e2e-158 is no TLSSN key", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const ts = "1790510965.000100";
  const { slackCalls, prompt } = await deliver({ ...live(), text: "<@U0EXAMPLE2|factory> [e2e-158] Why does the transfer form drop the reference after 60 characters?", ts });
  assert.deepEqual(order, ["jev", "model"]);
  assert.match(prompt, /<intake_triage by=\\"jev\\">/);
  assert.ok(slackCalls.some(([method, args]) => method === "reactions.add" && args["name"] === "eyes" && args["timestamp"] === ts));
});

test("a status question, an approve KEY, or a fix request is not a new request: no Jev call, no 👀, no filing-thread mark", async () => {
  for (const text of [
    "<@U0FACTORY> what happened to TLSSN-4?",
    "<@U0FACTORY> approve TLSSN-1",
    "<@U0FACTORY> fix https://github.com/cursor-demo-lab/marsbank/pull/12",
    "<@U0FACTORY> is the plan ready for the transfer form",
    "<@U0FACTORY> can you fix cursor-demo-lab/marsbank#12 the build is red",
  ]) {
    order = [];
    jev(["Bug", 0.93], ["medium", 0.84]);
    const { kv, slackCalls, prompt } = await deliver({ ...live(), text });
    assert.ok(!order.includes("jev"), `${text}: no Jev call`);
    assert.doesNotMatch(prompt, /intake_triage/, text);
    assert.ok(!slackCalls.some(([method, args]) => method === "reactions.add" && args["name"] === "eyes"), `${text}: no 👀`);
    assert.equal(kv[filingThreadKey(liveThread)], undefined, text);
  }
});

// Whole titles (hosted, 2026-09-28): the filing prompt opened with the
// request's first line cut mid-word at 160 characters and no ellipsis. It is
// whole up to 400 now, and any cut (the prompt's, or the title Jev reads at
// 160) ends between words with `…`.
let jevTitles: string[] = [];
function jevReading(issueType: Pair, severity: Pair) {
  jev(issueType, severity);
  const answer = globalThis.fetch;
  jevTitles = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    jevTitles.push((JSON.parse(String(init?.body)) as { state: { title: string } }).state.title);
    return answer(url, init);
  }) as typeof globalThis.fetch;
}

const wordEnds = (text: string) => {
  const ends = new Set([0]);
  let at = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) ends.add((at += segment.length));
  return ends;
};

/** `cut` is `whole`, or a start of it that ends between words, then `…`, within `max`. */
function assertWordCut(cut: string, whole: string, max: number) {
  assert.ok(cut.length <= max, `${cut.length} characters, over ${max}`);
  if (cut === whole) return;
  assert.ok(cut.endsWith("…"), `a cut ends with …: ${cut.slice(-30)}`);
  const kept = cut.slice(0, -1);
  assert.ok(whole.startsWith(kept), "the cut is a start of the line");
  assert.ok(wordEnds(whole).has(kept.length), `cut mid-word: …${kept.slice(-20)}|${whole.slice(kept.length, kept.length + 10)}`);
  assert.equal((kept.match(/`/g) ?? []).length % 2, 0, "no code span left open");
}

/** The prompt's lines, the title slot the turn fills checked and replaced by the request's own fitted title (what Jev read and a summary is checked against). */
const promptLines = (sends: unknown[][], text: string) => {
  const lines = filingPromptIn(sends)!.split("\n");
  assert.equal(lines[0], SLOT.title, "the turn writes the title");
  return [fittedRequestTitle(text), ...lines.slice(1)];
};
const phrase = (words: string, min: number) => {
  let line = words;
  while (line.length < min) line += ` ${words}`;
  return line;
};
const REPORT = "The export button stays disabled after the filter changes and nothing on the page says why";

test("live 2026-09-28, Activity: the turn writes the title, Jev reads the whole first line, the summary is the turn's, and Jev's title ends between words", async () => {
  jevReading(["Bug", 0.93], ["medium", 0.84]);
  const { sends, kv } = await deliver({ type: "app_mention", user: "U0ALICE", text: LIVE_ACTIVITY_TEXT, ts: TOP, channel: "C0123ABCD" });
  const lines = promptLines(sends, LIVE_ACTIVITY_TEXT);
  assert.ok(LIVE_ACTIVITY_TITLE.length > 160);
  assert.equal(lines[0], LIVE_ACTIVITY_TITLE, "not `…and the list re`");
  assert.equal(lines[2], "Summary: <one short sentence in your own words>");
  assert.equal(stashed(kv)?.["title"], LIVE_ACTIVITY_TITLE);
  assert.equal(jevTitles.length, 1);
  assert.notEqual(jevTitles[0], LIVE_ACTIVITY_TITLE, "Jev reads at most 160 characters");
  assertWordCut(jevTitles[0]!, LIVE_ACTIVITY_TITLE, 160);
});

test("live 2026-09-28, Accounts: whole first line on Jev's prompt and the model's alike, and the summary is not the title again", async () => {
  jevReading(["Bug", 0.93], ["low", 0.84]);
  const confident = promptLines((await deliver({ type: "app_mention", user: "U0ALICE", text: LIVE_ACCOUNTS_TEXT, ts: TOP, channel: "C0123ABCD" })).sends, LIVE_ACCOUNTS_TEXT);
  assert.equal(confident[0], LIVE_ACCOUNTS_TITLE, "not `…rather than not se`");
  assert.equal(confident[2], "Summary: <one short sentence in your own words>");
  jevDown();
  const fallback = promptLines((await deliver({ type: "app_mention", user: "U0ALICE", text: LIVE_ACCOUNTS_TEXT, ts: TOP, channel: "C0123ABCD" })).sends, LIVE_ACCOUNTS_TEXT);
  assert.equal(fallback[0], LIVE_ACCOUNTS_TITLE);
  assert.equal(fallback[1], "Triaged by Grok 4.6 Fast (Jev didn't answer): <Type>, <severity> severity.");
});

test("a one-paragraph request is titled by its first sentence and summarized by the next (a Sent using footer is no second line)", async () => {
  jevReading(["Bug", 0.93], ["low", 0.84]);
  const paragraph = `${LIVE_ACCOUNTS_TITLE} It should say "No offset account" instead. Seen on main today.`;
  const text = `<@U0FACTORY> file a bug: ${paragraph}\n*Sent using* <@U0EXAMPLE1|Cursor>`;
  const { sends, kv } = await deliver(filing(text));
  const lines = promptLines(sends, text);
  assert.equal(lines[0], LIVE_ACCOUNTS_TITLE);
  assert.equal(lines[2], "Summary: <one short sentence in your own words>");
  assert.equal(stashed(kv)?.["summary"], undefined);
});

test("a 1,000-character first line is cut between words near 400 with …; Jev's title near 160, the same way", async () => {
  jevReading(["Bug", 0.93], ["medium", 0.84]);
  const line = phrase(REPORT, 1000);
  const text = `<@U0FACTORY> file a bug: ${line}\nIt started after Tuesday's release.`;
  const { sends } = await deliver(filing(text));
  const lines = promptLines(sends, text);
  assertWordCut(lines[0]!, line, 400);
  assert.ok(lines[0]!.length > 350, `generous: ${lines[0]!.length}`);
  assert.equal(lines[2], "Summary: <one short sentence in your own words>");
  assertWordCut(jevTitles[0]!, line, 160);
  assert.ok(jevTitles[0]!.length > 140);
});

test("a code span across the cut is dropped whole, never split or left open", async () => {
  jevReading(["Bug", 0.93], ["medium", 0.84]);
  const lead = phrase(REPORT, 400).slice(0, 360);
  const line = `${lead.slice(0, lead.lastIndexOf(" "))} because it calls \`accountsTable.renderHeldColumn(offsetAccount, { fallback: 0 })\` for every loan row`;
  const text = `<@U0FACTORY> file a bug: ${line}\nSeen on main.`;
  const { sends } = await deliver(filing(text));
  const title = promptLines(sends, text)[0]!;
  assert.ok(line.indexOf("`") < 399 && line.lastIndexOf("`") > 399, "the span straddles the cut");
  assertWordCut(title, line, 400);
  assert.doesNotMatch(title, /`/, "the split span is gone");
  assert.match(title, /because it calls…$/);
});

test("CJK with no spaces is cut between words, not at a fixed character", async () => {
  jevReading(["Bug", 0.93], ["medium", 0.84]);
  const line = "导出按钮在筛选条件改变后一直处于禁用状态，页面上也没有任何提示".repeat(35);
  const text = `<@U0FACTORY> file a bug: ${line}`;
  const { sends } = await deliver(filing(text));
  const title = promptLines(sends, text)[0]!;
  assertWordCut(title, line, 400);
  assert.ok(title.length > 300);
  assertWordCut(jevTitles[0]!, line, 160);
});

test("a first line of exactly 400 characters is whole; one word more is cut between words with …", async () => {
  jevReading(["Bug", 0.93], ["medium", 0.84]);
  const exact = `${phrase(REPORT, 400).slice(0, 399).trimEnd()}${"x".repeat(400)}`.slice(0, 400);
  assert.equal(exact.length, 400);
  const exactText = `<@U0FACTORY> file a bug: ${exact}\nSeen on main.`;
  assert.equal(promptLines((await deliver(filing(exactText))).sends, exactText)[0], exact);
  jevReading(["Bug", 0.93], ["medium", 0.84]);
  const over = `${exact} again`;
  const overText = `<@U0FACTORY> file a bug: ${over}\nSeen on main.`;
  const title = promptLines((await deliver(filing(overText))).sends, overText)[0]!;
  assertWordCut(title, over, 400);
  assert.notEqual(title, over);
});

// Live Test B (2026-09-27): Jev replay Bug 0.99, urgent 0.58-0.65, proceed 1.0.
const TEST_B = 'The "Log out" button in the banking header signs you out immediately, even when you\'re halfway through a transfer on Move tokens.\n\nOne of our testers lost a half-filled transfer after brushing it on a trackpad. It would be nicer if it asked "Leave this transfer?" when the form has unsaved input, and logged out straight away otherwise.';

test("live Test B: Jev's urgent is capped to medium, and the triage line says Jev's confidence and the cap", async () => {
  jev(["Bug", 0.99], ["urgent", 0.62], ["proceed", 1.0]);
  const { sends, kv } = await deliver(filing(`<@U0FACTORY> ${TEST_B}`));
  const prompt = filingPromptIn(sends)!;
  assert.equal(prompt.split("\n")[1], "Triaged by Jev: Bug, medium severity (62% confidence; Jev said urgent).");
  assert.equal(stashed(kv)?.["severity"], "medium");
  assert.ok(asksToFile(prompt), "reaction-targets and one-reply still find the filing prompt");
});

test("Jev below the bar: the lead gives Jev's confidence as Jev's, never as the model's", async () => {
  jev(["Bug", 0.99], ["medium", 0.41]);
  const { sends } = await deliver(filing("<@U0FACTORY> file a bug: CSV export returns 500"));
  assert.equal(filingPromptIn(sends)?.split("\n")[1], "Triaged by Grok 4.6 Fast (Jev was only 41% confident): Bug, <severity> severity.");
  jevDown();
  const down = await deliver(filing("<@U0FACTORY> file a bug: CSV export returns 500"));
  assert.doesNotMatch(filingPromptIn(down.sends)!, /confidence/, "no Jev answer, no number");
});

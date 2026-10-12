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
import { intakeText, intakeTriageKey, requestSummary, fittedRequestTitle, SLOT } from "../lib/intake-triage.js";
import { recordKv } from "../lib/kv-race.fixtures.js";
import { oneReplyEvents } from "../lib/one-reply.js";
import { filingPromptKey } from "../lib/reaction-targets.js";
import fileTicket from "../tools/file_ticket.js";
import slack from "./slack.js";

// Independent verification of PR #167 (filing prompt title never cut mid-word).
// Live texts go mention → Jev → filing prompt → one-reply sink (records the
// prompt) → ✅ / ❌ reaction → (✅) file_ticket → the Filed post, all through
// July's dispatch with Slack, Jev, and Jira stubbed.

const TEAM = "T0123";
const CHANNEL = "C0EXAMPLE1";
const ROOT = "1790560000.100100";
const FILER = "U0ALICE01";
const DESK = "U0FACTORY";
const ENV = ["TYPESAFE_API_KEY", "FACTORY_DESK_JIRA_PROJECT", "FACTORY_JIRA_PROJECTS", "FACTORY_DESK_CLAIM_SETTLE_MS", "FACTORY_STATUS_TODO", "FACTORY_STATUS_TRIAGED", "JIRA_CLOUD_ID"] as const;
const saved: Record<string, string | undefined> = {};
const savedFetch = globalThis.fetch;

before(() => {
  for (const name of ENV) saved[name] = process.env[name];
});
beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  process.env.TYPESAFE_API_KEY = "test-key";
  process.env.FACTORY_DESK_JIRA_PROJECT = "TLSSN";
  process.env.FACTORY_DESK_CLAIM_SETTLE_MS = "5";
});
afterEach(() => {
  globalThis.fetch = savedFetch;
});
after(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const LIVE_A =
  '<@U0EXAMPLE2|factory> On the Activity page the "Sol 214"-style day separators are plain divs, so screen reader users can\'t jump between days with the heading shortcut and the list reads as one long run of rows. Could we make each sol separator a real heading (h3 is fine) inside `TransactionList` in components/banking/transaction-list.tsx, keeping the current look? A small test that the headings show up would be great.\n*Sent using* <@U0EXAMPLE1|Cursor>';
const LIVE_A_TITLE =
  'On the Activity page the "Sol 214"-style day separators are plain divs, so screen reader users can\'t jump between days with the heading shortcut and the list reads as one long run of rows.';
const LIVE_A_SUMMARY = "Could we make each sol separator a real heading (h3 is fine) inside `TransactionList` in components/banking/transaction-list.tsx, keeping the current look?";

const LIVE_B =
  '<@U0EXAMPLE2|factory> Small one on Accounts: a home loan with no linked offset account shows "Offset 0.00" in the Held column, which reads like the offset is empty rather than not set up. Could that slot show a dash when no offset account is linked?\n*Sent using* <@U0EXAMPLE1|Cursor>';
const LIVE_B_TITLE = 'Small one on Accounts: a home loan with no linked offset account shows "Offset 0.00" in the Held column, which reads like the offset is empty rather than not set up.';
const LIVE_B_SUMMARY = "Could that slot show a dash when no offset account is linked?";

type Pair = [string, number];
let jevTitles: string[] = [];
function jev(issueType: Pair = ["Bug", 0.93], severity: Pair = ["medium", 0.84]) {
  jevTitles = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    jevTitles.push((JSON.parse(String(init?.body)) as { state: { title: string } }).state.title);
    const answer = ([choice, probability]: Pair) => ({ choice, probabilities: { [choice]: probability } });
    return new Response(JSON.stringify({ answers: { issueType: answer(issueType), severity: answer(severity), gate: answer(["proceed", 0.9]) } }), { status: 200 });
  }) as typeof globalThis.fetch;
}

function world() {
  const rows: Record<string, unknown> = {};
  const kv = recordKv(rows);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let posted = 0;
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      const body = args as Record<string, unknown>;
      calls.push({ method, args: body });
      if (method === "auth.test") return { ok: true, user_id: DESK, user: "factory" };
      if (method === "users.info") {
        const id = String(body["user"]);
        return { ok: true, user: { id, name: id === FILER ? "alice" : id.toLowerCase(), team_id: TEAM, is_bot: id === DESK, profile: { display_name: id === FILER ? "alice" : "" } } };
      }
      if (method === "chat.postMessage") return { ok: true, ts: `1790560100.00${++posted}`, channel: body["channel"], message: { thread_ts: body["thread_ts"] } };
      if (method === "chat.getPermalink") return { ok: true, permalink: `https://example.slack.com/archives/${CHANNEL}/p${ROOT.replace(".", "")}` };
      return { ok: true, messages: [] };
    },
  };
  const creates: Array<Record<string, unknown>> = [];
  const comments: string[] = [];
  let status = "To Do";
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraProjectIssueTypesMetadata", inputSchema: schema("projectIdOrKey") },
      { name: "createJiraIssue", inputSchema: schema("projectKey", "summary", "description", "issueTypeName") },
      { name: "addCommentToJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey", "commentBody") },
      { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
      { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
    ],
    callTool: async (_connection: string, tool: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      if (tool === "getJiraProjectIssueTypesMetadata") return json({ issueTypes: [{ id: "10170", name: "Task", subtask: false }, { id: "10172", name: "Bug", subtask: false }] });
      if (tool === "createJiraIssue") {
        creates.push(args);
        return json({ key: "TLSSN-99", self: "https://x.atlassian.net/browse/TLSSN-99" });
      }
      if (tool === "addCommentToJiraIssue") {
        comments.push(String(args["commentBody"]));
        return json({ id: "1" });
      }
      if (tool === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "11", name: "Start triage", to: { name: "Triaged" } }] });
      if (tool === "getJiraIssue") return json({ key: "TLSSN-99", fields: { summary: "x", status: { name: status } } });
      if (tool === "transitionJiraIssue") {
        status = "Triaged";
        return json({});
      }
      return json({});
    },
  };
  const client = { apiCall: (method: string, args: Record<string, unknown>) => transport.call(method, args) };
  const host = { kv, slack: { getClient: async () => client }, mcp, reminders: { create: async () => ({ id: "rem_1" }), cancel: async () => undefined } };
  const posts = () => calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  return { rows, kv, calls, transport, host, posts, creates, comments };
}
type World = ReturnType<typeof world>;

const options = getSlackChannelOptions(slack)!;
const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never;

async function dispatch(w: World, event: Record<string, unknown>) {
  resetExternalSenderCache();
  const sends: Array<Record<string, unknown>> = [];
  const pending: Promise<unknown>[] = [];
  dispatchInboundFromEventBody(
    { type: "event_callback", team_id: TEAM, event_id: `Ev${Math.random()}`, event: { team: TEAM, ...event } },
    {
      send: (async (prompt: string, sendOptions: Record<string, unknown>) => (sends.push({ ...sendOptions, prompt }), { sessionId: "ses_test" })) as never,
      waitUntil: (promise) => void pending.push(promise),
      onAppMention: options.onAppMention ?? createDefaultOnInbound(),
      onDirectMessage: options.onDirectMessage ?? createDefaultOnInbound(),
      ...(options.onReactionAdded === undefined ? {} : { onReactionAdded: options.onReactionAdded }),
      credentials: { botToken: w.transport },
      eventIds: createEventIdDedupe(),
      host: w.host as never,
      artifacts: {} as never,
      log,
      mentionsEnabled: true,
      directMessagesEnabled: true,
    }
  );
  await Promise.all(pending);
  return sends;
}

const mention = (text: string, channel = CHANNEL) => ({ type: "app_mention", user: FILER, text, ts: ROOT, channel });
const reaction = (reactionName: string, ts: string) => ({ type: "reaction_added", user: FILER, reaction: reactionName, item: { type: "message", channel: CHANNEL, ts }, item_user: DESK, event_ts: "1790560200.000100" });

function filingPromptIn(sends: Array<Record<string, unknown>>): string | undefined {
  const prompt = String(sends[0]?.["prompt"] ?? "");
  return prompt.match(/<filing_prompt>\n([\s\S]*?)\n<\/filing_prompt>/)?.[1];
}

/** The model's one reply, through the desk's one-reply sink: posted once, and recorded as a filing prompt when it asks for approve file. */
async function sinkReply(w: World, text: string, auth: Record<string, unknown> = { attributes: { channel_id: CHANNEL, thread_ts: ROOT } }) {
  const events = oneReplyEvents({ credentials: { botToken: w.transport } });
  const state = { channelId: CHANNEL, threadTs: ROOT, teamId: TEAM, triggeringUserId: FILER } as never;
  const channel = { channelId: "slack", state, continuationToken: null, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_sink", auth }, host: { kv: w.kv } } as never;
  const before = w.posts().length;
  await events["turn.completed"]?.({ sessionId: "ses_sink", turnId: `t${Math.random()}`, type: "turn.completed", data: { result: text } } as never, channel, ctx);
  return { posts: w.posts().slice(before) };
}

const WORDISH = /[\p{L}\p{N}_]/u;
/** `line` is `whole`, or a start of it that ends between words (the next source character is not a letter/digit continuing the last one) then `…`. */
function assertCleanCut(line: string, whole: string, max: number, label: string) {
  assert.ok(line.length <= max, `${label}: ${line.length} > ${max}`);
  if (line === whole) return;
  assert.ok(line.endsWith("…"), `${label}: a cut ends with …: ${JSON.stringify(line.slice(-40))}`);
  const kept = line.slice(0, -1);
  assert.doesNotMatch(kept, /[,;:\s]$/, `${label}: no trailing ,;: or space before …`);
  assert.equal((kept.match(/`/g) ?? []).length % 2, 0, `${label}: balanced backticks`);
  assert.doesNotMatch(kept, /[\uD800-\uDBFF]$/, `${label}: no lone high surrogate at the cut`);
  const at = whole.indexOf(kept.replace(/…$/, ""));
  if (at === 0) {
    const last = kept.slice(-1);
    const next = whole.slice(kept.length, kept.length + 1);
    assert.ok(!(WORDISH.test(last) && WORDISH.test(next)) || /\p{Script=Han}/u.test(last), `${label}: mid-word: …${kept.slice(-20)}|${whole.slice(kept.length, kept.length + 15)}`);
  }
}

// ---------------------------------------------------------------- live A / B

test("live A: the turn writes the title and the Summary, Jev reads the whole first sentence ≤160 cut at a word; ✅ files it, a lifted Summary is dropped, and the Filed post has none", async () => {
  jev(["Bug", 0.93], ["medium", 0.84]);
  const w = world();
  const sends = await dispatch(w, mention(LIVE_A));
  assert.equal(sends.length, 1, "one filing turn");
  const prompt = filingPromptIn(sends)!;
  const lines = prompt.split("\n");
  assert.equal(lines[0], SLOT.title, "the turn writes a short title of its own, never the reporter's sentence");
  assert.equal(fittedRequestTitle(LIVE_A), LIVE_A_TITLE, "the request's own first line, which Jev reads");
  assert.equal(lines[1], "Triaged by Jev: Bug, medium severity (84% confidence).");
  assert.equal(lines[2], `Summary: ${SLOT.summary}`);
  const request = intakeText(LIVE_A);
  assert.equal(requestSummary(request.title, request.description), LIVE_A_SUMMARY, "the body's own first sentence, which the Summary must not copy");
  assert.doesNotMatch(prompt, /…/, "nothing is cut in live A");
  assert.equal(jevTitles.length, 1);
  assertCleanCut(jevTitles[0]!, LIVE_A_TITLE, 160, "Jev title");
  console.log(`[verify] live A filing prompt: ${prompt.length} chars; model context ${String(sends[0]!["prompt"]).length} chars; Jev title ${jevTitles[0]!.length}: ${JSON.stringify(jevTitles[0])}`);

  const sink = await sinkReply(w, prompt);
  assert.equal(sink.posts.length, 1);
  const promptTs = Object.keys(w.rows).find((key) => key.startsWith(`filing-prompt/${CHANNEL}:`))!.split(":")[1]!;
  assert.ok(w.rows[filingPromptKey({ channelId: CHANNEL, ts: promptTs })], "the prompt is recorded for reactions");

  const turn = await dispatch(w, reaction("white_check_mark", promptTs));
  assert.equal(turn.length, 1, "✅ is one approve file turn");
  const auth = turn[0]!["auth"] as Record<string, unknown>;
  const result = (await fileTicket.execute!(
    { title: "Activity day separators should be real headings", description: LIVE_A_TITLE, kind: "bug", severity: "medium", summary: LIVE_A_SUMMARY } as never,
    { session: { id: "ses_file", channelId: "slack", mode: "chat", purpose: "live", auth }, now: () => new Date(), host: w.host } as never
  )) as Record<string, unknown>;
  assert.equal(result["created"], true, JSON.stringify(result));
  assert.equal(w.creates.length, 1);
  assert.equal(w.creates[0]!["summary"], "Activity day separators should be real headings", "Jira summary is the tool's title, uncut");
  const reply = String(result["reply"]);
  assert.equal(reply.split("\n").find((line) => line.startsWith("Summary: ")), undefined, "the Filed post never repeats the prompt's Summary");
  assert.doesNotMatch(reply, /…/);
  assert.ok(!w.comments[0]!.includes(`Summary: ${LIVE_A_SUMMARY}`), "a Summary copied from the body is dropped from the Triage: comment too");
  const filed = await sinkReply(w, reply, auth);
  assert.equal(filed.posts.length, 1, "one Filed post");
  assert.equal(filed.posts[0]!["thread_ts"], ROOT);
});

test("live B: the turn writes the title, Jev reads the whole first sentence; ❌ gets one short reply and nothing in Jira", async () => {
  jev(["Bug", 0.93], ["low", 0.84]);
  const w = world();
  const sends = await dispatch(w, mention(LIVE_B));
  const prompt = filingPromptIn(sends)!;
  const lines = prompt.split("\n");
  assert.equal(lines[0], SLOT.title);
  assert.equal(fittedRequestTitle(LIVE_B), LIVE_B_TITLE, "not `…rather than not se`");
  assert.equal(lines[2], `Summary: ${SLOT.summary}`);
  const request = intakeText(LIVE_B);
  assert.equal(requestSummary(request.title, request.description), LIVE_B_SUMMARY);
  assertCleanCut(jevTitles[0]!, LIVE_B_TITLE, 160, "Jev title");
  console.log(`[verify] live B filing prompt: ${prompt.length} chars; model context ${String(sends[0]!["prompt"]).length} chars; Jev title ${jevTitles[0]!.length}: ${JSON.stringify(jevTitles[0])}`);
  await sinkReply(w, prompt);
  const promptTs = Object.keys(w.rows).find((key) => key.startsWith(`filing-prompt/${CHANNEL}:`))!.split(":")[1]!;
  const before = w.posts().length;
  const turn = await dispatch(w, reaction("x", promptTs));
  assert.deepEqual(turn, [], "no model turn");
  const replies = w.posts().slice(before);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!["text"], "Okay, I won't file this; nothing was created in Jira.");
  assert.equal(w.creates.length, 0);
  assert.equal(w.rows[intakeTriageKey({ channelId: CHANNEL, threadTs: ROOT })], undefined, "the request's triage is dropped");
});

// ---------------------------------------------------------------- edges

// An unspaced CJK or emoji message is one "word" to the intake rule (MIN_PROBLEM_WORDS), so those carry a filing phrase.
async function titleAndSummary(text: string, phrase = "") {
  jev();
  const w = world();
  const sends = await dispatch(w, mention(`<@U0EXAMPLE2|factory> ${phrase}${text}`, "C0123ABCD"));
  const prompt = filingPromptIn(sends);
  assert.ok(prompt, `a filing prompt for ${JSON.stringify(text.slice(0, 60))}`);
  const lines = prompt.split("\n");
  assert.equal(lines[2], `Summary: ${SLOT.summary}`, "the turn writes the Summary");
  // What a lifted Summary would be: the request's own sentence after the title.
  const request = intakeText(`<@U0EXAMPLE2|factory> ${phrase}${text}`);
  const own = requestSummary(request.title, request.description);
  assert.equal(lines[0], SLOT.title, "the turn writes the title");
  return { title: fittedRequestTitle(`<@U0EXAMPLE2|factory> ${phrase}${text}`), summary: own ?? SLOT.summary, jevTitle: jevTitles[0]!, prompt };
}
const SLOT_SUMMARY = "<one short sentence in your own words>";
const words = (seed: string, min: number) => {
  let out = seed;
  while (out.length < min) out += ` ${seed}`;
  return out;
};
const REPORT = "The export button stays disabled after the filter changes and nothing on the page says why";

test("old-style multi-paragraph request with _On main:_ / _Repro:_ labels: the whole first line, Summary from the labelled line", async () => {
  const { title, summary } = await titleAndSummary(
    "Transfer form: the reference field stops at 60 characters. No hint is shown.\n\n_On main:_ in `transfer-form.tsx` the input has `maxLength={60}` and no counter.\n\n_Repro:_ type a long note.\n*Sent using* <@U0EXAMPLE1|Cursor>"
  );
  assert.equal(title, "Transfer form: the reference field stops at 60 characters. No hint is shown.");
  assert.equal(summary, "In `transfer-form.tsx` the input has `maxLength={60}` and no counter.");
});

test("a greeting-only first line is skipped; a greeting sentence opening the paragraph is skipped", async () => {
  const own = await titleAndSummary("Hi team!\nThe export button stays disabled after the filter changes. It happens on every account.");
  assert.equal(own.title, "The export button stays disabled after the filter changes.");
  assert.equal(own.summary, "It happens on every account.");
  const inline = await titleAndSummary("Hey all, quick one. The export button stays disabled after the filter changes. It happens on every account.");
  assert.equal(inline.title, "The export button stays disabled after the filter changes.");
  assert.equal(inline.summary, "It happens on every account.");
});

test("all-lowercase sentences split on a bare '. lowercase' and the title and summary are capitalised", async () => {
  const { title, summary } = await titleAndSummary("the export button stays disabled after the filter changes. it happens on every account. please take a look");
  assert.equal(title, "The export button stays disabled after the filter changes.");
  assert.equal(summary, "It happens on every account.");
});

test("a 1,000-character single line with no sentence end: cut between words ≤400 with …, no summary to repeat it", async () => {
  const line = words(REPORT, 1000);
  const { title, summary, jevTitle } = await titleAndSummary(line);
  assertCleanCut(title, line, 400, "title");
  assert.ok(title.length > 350 && title.length <= 400, `${title.length}`);
  assert.equal(summary, SLOT_SUMMARY);
  assertCleanCut(jevTitle, line, 160, "Jev title");
});

test("a 600-character first sentence then a second: title cut ≤400 at a word, Summary is the second sentence and not the title", async () => {
  const first = `${words(REPORT, 600)}.`;
  const { title, summary } = await titleAndSummary(`${first} It started after Tuesday's release.`);
  assertCleanCut(title, first, 400, "title");
  assert.equal(summary, "It started after Tuesday's release.");
});

test("a code span straddling 400 in a one-paragraph request is dropped whole; no unbalanced backtick", async () => {
  const lead = words(REPORT, 380).slice(0, 370);
  const body = `${lead.slice(0, lead.lastIndexOf(" "))} because it calls \`accountsTable.renderHeldColumn(offsetAccount, { fallback: 0 })\` on every row`;
  assert.ok(body.indexOf("`") < 399 && body.lastIndexOf("`") > 399);
  const { title } = await titleAndSummary(`${body}. Seen on main.`);
  assertCleanCut(title, `${body}.`, 400, "title");
  assert.doesNotMatch(title, /`/);
});

test("an odd literal backtick before the cut is removed; a code span before the cut is kept whole", async () => {
  const line = `The \`exportCsv()\` call and a stray \` tick: ${words(REPORT, 700)}`;
  const { title } = await titleAndSummary(line);
  assertCleanCut(title, line, 400, "title");
  assert.match(title, /^The `exportCsv\(\)` call and a stray {2}?tick/);
});

test("CJK with no spaces is cut between words ≤400", async () => {
  const line = "导出按钮在筛选条件改变后一直处于禁用状态页面上也没有任何提示".repeat(30);
  const { title, jevTitle } = await titleAndSummary(line, "file a bug: ");
  assertCleanCut(title, line, 400, "title");
  assert.ok(title.length > 300);
  assertCleanCut(jevTitle, line, 160, "Jev title");
});

test("CJK one-paragraph request: title is its first sentence (ends at 。), Summary the next", async () => {
  const { title, summary } = await titleAndSummary("导出按钮在筛选条件改变后一直处于禁用状态。页面上也没有任何提示。请修复。", "file a bug: ");
  assert.equal(title, "导出按钮在筛选条件改变后一直处于禁用状态。");
  assert.equal(summary, "页面上也没有任何提示。");
});

test("emoji and surrogate pairs at the cut are never split (spaced and unspaced)", async () => {
  for (const [label, line] of [
    ["spaced 🔥", words("the export 🔥 button 👨‍👩‍👧 stays disabled 🇦🇺 after filter changes", 900)],
    ["unspaced", "🔥".repeat(150) + "👨‍👩‍👧".repeat(60)],
    ["emoji straddling 399", `${"a".repeat(3)} ${words("word", 393).slice(0, 393)}🔥🔥🔥 tail words here`],
  ] as const) {
    const { title, jevTitle } = await titleAndSummary(line, "file a bug: ");
    assertCleanCut(title, line, 400, label);
    assertCleanCut(jevTitle, line, 160, `${label} Jev`);
    assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `${label}: lone surrogate`);
    assert.doesNotMatch(title, /\u200D…$/, `${label}: ZWJ sequence split`);
  }
});

test("a URL or path straddling the cut is dropped whole, not split", async () => {
  const lead = words(REPORT, 360).slice(0, 350).trimEnd();
  for (const target of ["https://github.com/cursor-demo-lab/marsbank/blob/main/components/banking/transaction-list.tsx#L42", "components/banking/transaction-list/very/deep/path/transaction-list.tsx"]) {
    const line = `${lead} see ${target} for details and more words after it`;
    const { title } = await titleAndSummary(line);
    assertCleanCut(title, line, 400, target);
    assert.ok(!title.includes(target.slice(0, 20)) || title.includes(target), `split ${target}: ${title.slice(-60)}`);
    assert.match(title, / see…$/);
  }
});

test("exactly 400 characters is whole; 401 is cut between words with …", async () => {
  const base = words(REPORT, 420);
  let exact = base.slice(0, 400);
  exact = exact.slice(0, exact.lastIndexOf(" ")) + " " + "z".repeat(400 - exact.lastIndexOf(" ") - 1);
  assert.equal(exact.length, 400);
  assert.equal((await titleAndSummary(exact)).title, exact);
  const over = `${exact}z`;
  const { title } = await titleAndSummary(over);
  assert.notEqual(title, over);
  assertCleanCut(title, over, 400, "cap+1");
  assert.ok(!title.includes("zzz"), "the last word is dropped whole");
});

test("e.g. and v2.3.1 do not end the title sentence", async () => {
  const { title, summary } = await titleAndSummary("Since v2.3.1 the export fails on filtered views, e.g. the Savings tab. It started Tuesday.");
  assert.equal(title, "Since v2.3.1 the export fails on filtered views, e.g. the Savings tab.");
  assert.equal(summary, "It started Tuesday.");
});

test("a summary over 200 is cut between words with …, never splitting a code span", async () => {
  const second = `${words("the export stays disabled", 180).slice(0, 180).trimEnd()} \`accountsTable.render(offsetAccount, fallback)\` more words after.`;
  const { summary } = await titleAndSummary(`CSV export is broken on filtered views. ${second}`);
  assert.ok(summary.length <= 200, `${summary.length}`);
  assert.ok(summary.endsWith("…"));
  assert.equal((summary.match(/`/g) ?? []).length % 2, 0);
  assert.doesNotMatch(summary, /[,;:\s]…$/);
});

test("the Summary never repeats the title", async () => {
  const { title, summary } = await titleAndSummary("The export is broken.\nThe export is broken.");
  assert.equal(title, "The export is broken.");
  assert.equal(summary, SLOT_SUMMARY);
});

test("the Jira summary (file_ticket title) is validated at 80 by zod and never cut", () => {
  const schema = fileTicket.inputSchema as unknown as { safeParse: (value: unknown) => { success: boolean; data?: { title: string } } };
  const base = { description: "d", kind: "bug", severity: "low", summary: "s" };
  const eighty = "x".repeat(80);
  assert.equal(schema.safeParse({ ...base, title: eighty }).data?.title, eighty);
  assert.equal(schema.safeParse({ ...base, title: `${eighty}y` }).success, false, "81 is rejected, not cut");
});

// ---------------------------------------------------------------- round 2 (head 86fa972)

const EXPORT = "The export button stays disabled after changing the filter.";

test("r2: consecutive greeting sentences are stripped: `Hi team! Quick one. <sentence>` titles the sentence, and Jev reads the same title", async () => {
  const { title, summary, jevTitle } = await titleAndSummary(`Hi team! Quick one. ${EXPORT}`);
  assert.equal(title, EXPORT);
  assert.equal(summary, SLOT_SUMMARY);
  assert.equal(jevTitle, EXPORT, "Jev reads the cleaned title");
});

test("r2: a leading greeting clause ending in a colon is stripped", async () => {
  const { title, jevTitle } = await titleAndSummary(`Hey team, quick one: ${EXPORT} It happens on every account.`);
  assert.equal(title, EXPORT);
  assert.equal(jevTitle, EXPORT);
});

test("r2: `Small one on Accounts: <sentence>` keeps its label clause", async () => {
  const sentence = "Small one on Accounts: a home loan with no offset shows Offset 0.00 in the Held column.";
  const { title, jevTitle } = await titleAndSummary(`${sentence} Could it show a dash?`);
  assert.equal(title, sentence);
  assert.equal(jevTitle, sentence);
});

test("r2: a request that is only greetings keeps its line whole, never empty", async () => {
  const { title } = await titleAndSummary("file a bug: Hi team! Quick one. Good morning all.");
  assert.equal(title, "Hi team! Quick one. Good morning all.");
});

test("r2: a greetings-only first line (over four words) followed by the request: title is the request", async () => {
  const { title, summary } = await titleAndSummary(`Hi team! Quick one. Good morning all.\n${EXPORT} It happens on every account.`);
  assert.equal(title, EXPORT);
  assert.equal(summary, "It happens on every account.");
});

test("r2: full-width `１．５` is a number, not a sentence end", async () => {
  const { title, summary } = await titleAndSummary("バージョン１．５以降、エクスポートボタンが無効のままです。フィルターを変えても直りません。", "file a bug: ");
  assert.equal(title, "バージョン１．５以降、エクスポートボタンが無効のままです。");
  assert.equal(summary, "フィルターを変えても直りません。");
});

test("r2: CJK sentence ending inside closing brackets `。」` ends after the bracket", async () => {
  const { title, summary } = await titleAndSummary("ボタンを押すと「保存できません。」と表示されます。再読み込みすると直ります。", "file a bug: ");
  assert.equal(title, "ボタンを押すと「保存できません。」と表示されます。");
  assert.equal(summary, "再読み込みすると直ります。");
});

test("r2: a quoted CJK sentence opening the title does not end it (the `\"Saved.\" toast is silent` rule)", async () => {
  const { title, summary } = await titleAndSummary("「保存しました。」というトーストが読み上げられません。画面を再読み込みすると出ます。", "file a bug: ");
  assert.equal(title, "「保存しました。」というトーストが読み上げられません。");
  assert.equal(summary, "画面を再読み込みすると出ます。");
});

test("r2: CJK with 」 and no sentence-ending mark inside the quote", async () => {
  const { title, summary } = await titleAndSummary("エクスポートボタンが「無効」のままです。フィルターを変えると直りません。", "file a bug: ");
  assert.equal(title, "エクスポートボタンが「無効」のままです。");
  assert.equal(summary, "フィルターを変えると直りません。");
});

test("r2: Jev's title is the cleaned title for live A and live B", async () => {
  for (const [text, title] of [[LIVE_A, LIVE_A_TITLE], [LIVE_B, LIVE_B_TITLE]] as const) {
    jev();
    const sends = await dispatch(world(), mention(text));
    assert.equal(filingPromptIn(sends)!.split("\n")[0], SLOT.title);
    assert.equal(fittedRequestTitle(text), title);
    assert.ok(title.startsWith(jevTitles[0]!.replace(/…$/, "")), `Jev: ${jevTitles[0]}`);
  }
});

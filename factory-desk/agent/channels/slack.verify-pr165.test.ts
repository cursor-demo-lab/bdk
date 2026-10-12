import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { HostKvApi, HostMcpCallResult, HostMcpToolInfo } from "@cursor/july";
import {
  createDefaultOnInbound,
  createEventIdDedupe,
  dispatchInboundFromEventBody,
  getSlackChannelOptions,
  resetExternalSenderCache,
  type SlackApiTransport,
} from "@cursor/july/channels/slack";
import fileTicket from "../tools/file_ticket.js";
import { fittedRequestTitle, intakeText, intakeTriageKey, requestSummary, SLOT } from "../lib/intake-triage.js";
import { recordKv } from "../lib/kv-race.fixtures.js";
import { LIVE_SURVEY_SUMMARY, LIVE_SURVEY_TEXT } from "../lib/live-intake.fixtures.js";
import { oneReplyEvents } from "../lib/one-reply.js";
import { filingPromptKey, planPostKey } from "../lib/reaction-targets.js";
import { threadTicketsKey } from "../lib/thread-tickets.js";
import slack from "./slack.js";

// Independent verification of PR #165: the filing prompt / Filed post
// `Summary:` and the ✅/❌ reply landing in the thread root, driven through
// July's own dispatch with Slack, Jev, and Jira stubbed.

const TEAM = "T0123";
const CHANNEL = "C0EXAMPLE1";
const OTHER = "C0OTHER001";
const DM = "D0DM00001";
const ROOT = "1758510000.123456";
const PROMPT_TS = "1758510001.000300";
const PLAN_TS = "1758510005.000200";
const FILER = "U0ALICE01";
const DESK = "U0FACTORY";

const ENV = ["TYPESAFE_API_KEY", "FACTORY_DESK_JIRA_PROJECT", "FACTORY_JIRA_PROJECTS", "FACTORY_DESK_CLAIM_SETTLE_MS", "JIRA_CLOUD_ID", "FACTORY_STATUS_TODO", "FACTORY_STATUS_TRIAGED"] as const;
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

const LIVE_A = [
  '<@U0EXAMPLE2|factory> Cards: every "Freeze card" button has the same accessible name, so screen-reader users can\'t tell which card a button will freeze.',
  "",
  '_On main:_ in `components/banking/card-panel.tsx` the `.freeze-button` renders only "Freeze card" / "Unfreeze card" with no link to the card it belongs to, while the card label (`cardFormLabel(card)`) sits in the `&lt;strong&gt;` inside `.card-meta` right above it.',
  "",
  "_Repro:_ sign in as Cameron, open Cards, tab through the Freeze card buttons with a screen reader: each one is announced identically.",
  "",
  '_Expected:_ give that `&lt;strong&gt;` a stable id per card and point the button\'s `aria-describedby` at it, so it reads e.g. "Freeze card, Debit card". Keep the button\'s visible text and accessible name unchanged. No other behavior changes.',
  "*Sent using* <@U0EXAMPLE1|Cursor>",
].join("\n");
const LIVE_A_TITLE = 'Cards: every "Freeze card" button has the same accessible name, so screen-reader users can\'t tell which card a button will freeze.';
const LIVE_A_SENTENCE = 'In `components/banking/card-panel.tsx` the `.freeze-button` renders only "Freeze card" / "Unfreeze card" with no link to the card it belongs to, while the card label (`cardFormLabel(card)`) sits in the `<strong>` inside `.card-meta` right above it.';
const LIVE_A_SUMMARY = 'In `components/banking/card-panel.tsx` the `.freeze-button` renders only "Freeze card" / "Unfreeze card" with no link to the card it belongs to, while the card label (`cardFormLabel(card)`) sits in…';

// ---------- intake: a Slack mention through July's dispatch, Jev confident ----------

function jevConfident() {
  globalThis.fetch = (async () => {
    const answer = (choice: string, probability: number) => ({ choice, probabilities: { [choice]: probability } });
    return new Response(JSON.stringify({ answers: { issueType: answer("Bug", 0.93), severity: answer("medium", 0.8), gate: answer("proceed", 0.9) } }), { status: 200 });
  }) as typeof globalThis.fetch;
}

const TYPES = { issueTypes: [{ id: "10170", name: "Task", subtask: false }, { id: "10172", name: "Bug", subtask: false }] };
const INTAKE_CHANNEL = "C0123ABCD";
const TOP = "1758510000.123456";

async function mention(text: string) {
  jevConfident();
  resetExternalSenderCache();
  const options = getSlackChannelOptions(slack)!;
  const kv: Record<string, unknown> = {};
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method) => {
      if (method === "users.info") return { ok: true, user: { id: "U0ALICE", team_id: TEAM } };
      if (method === "chat.postMessage") return { ok: true, ts: "1758510001.000100" };
      return { ok: true, messages: [] };
    },
  };
  const client = { apiCall: (method: string, args: Record<string, unknown>) => transport.call(method, args) };
  const host = {
    kv: recordKv(kv),
    slack: { getClient: async () => client },
    mcp: {
      names: () => ["tracker"],
      listTools: async () => [{ name: "getJiraProjectIssueTypesMetadata", inputSchema: { type: "object", properties: { projectIdOrKey: { type: "string" } } } }],
      callTool: async (): Promise<HostMcpCallResult> => ({ content: [{ type: "text", text: JSON.stringify(TYPES) }] }),
    },
  };
  const sends: unknown[][] = [];
  const pending: Promise<unknown>[] = [];
  dispatchInboundFromEventBody(
    { type: "event_callback", team_id: TEAM, event_id: `Ev${Math.random()}`, event: { team: TEAM, type: "app_mention", user: "U0ALICE", text, ts: TOP, channel: INTAKE_CHANNEL } },
    {
      send: (async (...args: unknown[]) => (sends.push(args), { sessionId: "ses_test" })) as never,
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
  const context = JSON.stringify(sends[0] ?? []);
  const block = context.match(/<filing_prompt>\\n(.*?)\\n<\/filing_prompt>/)?.[1];
  const prompt = block === undefined ? undefined : (JSON.parse(`"${block}"`) as string);
  return { kv, sends, prompt, lines: prompt?.split("\n") ?? [] };
}

/**
 * The request's own first sentence after `title` (`requestSummary`, what a
 * lifted Summary is checked against). The filing prompt never shows it: the
 * turn writes the Summary.
 */
async function summaryFor(body: string, title = "Export page is broken") {
  const text = `<@U0FACTORY> ${title}\n${body}`;
  const { lines } = await mention(text);
  assert.equal(lines[0], SLOT.title, "the turn writes the title");
  assert.equal(fittedRequestTitle(text), title);
  assert.equal(lines[2], `Summary: ${SLOT.summary}`, "the turn writes the Summary");
  const request = intakeText(text);
  const summary = requestSummary(request.title, request.description);
  assert.ok(summary !== undefined, "the request has a sentence after its title");
  return summary;
}

function assertCleanSummary(summary: string, title: string) {
  assert.ok(summary.length <= 200, `≤ 200 chars (${summary.length})`);
  assert.equal((summary.match(/`/g)?.length ?? 0) % 2, 0, "balanced backticks");
  assert.notEqual(summary.replace(/[^\p{L}\p{N}]/gu, ""), "", "not just punctuation");
  assert.notEqual(summary.toLowerCase(), title.toLowerCase());
  assert.doesNotMatch(summary, /&(?:lt|gt|amp);(?!lt;|gt;)/, "no entity left from Slack's own encoding");
}

// ---------- Jira + file_ticket for the Filed post ----------

function tool(name: string, properties: string[]): HostMcpToolInfo {
  return { name, inputSchema: { type: "object", properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])) } };
}

async function fileFrom(kv: Record<string, unknown>) {
  let status = "To Do";
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const calls: Array<Record<string, unknown>> = [];
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      tool("createJiraIssue", ["projectKey", "summary", "description", "issueTypeName"]),
      tool("addCommentToJiraIssue", ["cloudId", "issueIdOrKey", "commentBody"]),
      tool("getTransitionsForJiraIssue", ["cloudId", "issueIdOrKey"]),
      tool("transitionJiraIssue", ["cloudId", "issueIdOrKey", "transition"]),
      tool("getJiraIssue", ["cloudId", "issueIdOrKey"]),
    ],
    callTool: async (_c: string, name: string, args: Record<string, unknown> = {}): Promise<HostMcpCallResult> => {
      calls.push({ tool: name, ...args });
      if (name === "createJiraIssue") return json({ key: "TLSSN-50", self: "https://x.atlassian.net/browse/TLSSN-50" });
      if (name === "addCommentToJiraIssue") return json({ id: "1" });
      if (name === "getTransitionsForJiraIssue") return json({ transitions: [{ id: "11", name: "Start triage", to: { name: "Triaged" } }] });
      if (name === "getJiraIssue") return json({ key: "TLSSN-50", fields: { status: { name: status } } });
      if (name === "transitionJiraIssue") return (status = "Triaged"), json({});
      throw new Error(`unexpected ${name}`);
    },
  };
  const context = {
    session: {
      id: "ses_1",
      channelId: "slack",
      mode: "chat",
      purpose: "live",
      auth: { authenticator: "slack", principalId: `slack:${TEAM}:${INTAKE_CHANNEL}:${TOP}`, principalType: "user", attributes: { channel_id: INTAKE_CHANNEL, thread_ts: TOP } },
      continuationKey: `${INTAKE_CHANNEL}:${TOP}`,
    },
    now: () => new Date(),
    host: { kv: recordKv(kv), slack: { getClient: async () => ({ apiCall: async () => ({ ok: true }) }) }, mcp, reminders: { create: async () => ({ id: "rem_1" }), cancel: async () => undefined } },
  };
  const model = { title: "model title", description: "d", kind: "bug", severity: "low", summary: "The model's own summary." };
  const result = (await fileTicket.execute!(model as never, context as never)) as Record<string, unknown>;
  const comment = calls.find((call) => call.tool === "addCommentToJiraIssue")?.["commentBody"] as string | undefined;
  return { result, comment };
}

// ---------- 1. live texts end to end ----------

test("verify: live A through dispatch: filing prompt Summary decoded, capitalised, cut at a word boundary with …", async () => {
  const { lines, kv } = await mention(LIVE_A);
  assert.equal(lines[0], SLOT.title, "the turn writes a short title, never the reporter's sentence");
  assert.equal(fittedRequestTitle(LIVE_A), LIVE_A_TITLE);
  assert.equal(lines[1], "Triaged by Jev: Bug, medium severity (80% confidence).");
  assert.equal(lines[2], `Summary: ${SLOT.summary}`, "the turn writes the Summary; the body's sentence is never copied in");
  const request = intakeText(LIVE_A);
  assert.equal(requestSummary(request.title, request.description), LIVE_A_SUMMARY);
  assert.ok(LIVE_A_SUMMARY.length <= 200);
  const kept = LIVE_A_SUMMARY.slice(0, -1);
  assert.ok(LIVE_A_SENTENCE.startsWith(kept) && LIVE_A_SENTENCE[kept.length] === " ", "cut exactly at a word boundary, no mid-word cut");
  assertCleanSummary(LIVE_A_SUMMARY, LIVE_A_TITLE);
  const stash = kv[intakeTriageKey({ channelId: INTAKE_CHANNEL, threadTs: TOP })] as { triage: { summary?: string } };
  assert.equal(stash.triage.summary, undefined, "no summary lifted from the body is stashed");
});

test("verify: live A: the Filed post never repeats a Summary", async () => {
  const { kv } = await mention(LIVE_A);
  const { result, comment } = await fileFrom(kv);
  assert.equal(result["created"], true);
  const reply = String(result["reply"]).split("\n");
  assert.equal(reply.find((line) => line.startsWith("Summary: ")), undefined);
  assert.ok(comment?.split("\n").some((line) => line.startsWith("Summary: ")), "the Triage: comment still carries a Summary");
});

test("verify: live B through dispatch: entities decoded and the sentence runs past e.g. to its real end", async () => {
  const { lines, kv } = await mention(LIVE_SURVEY_TEXT);
  assert.equal(lines[2], `Summary: ${SLOT.summary}`);
  const request = intakeText(LIVE_SURVEY_TEXT);
  assert.equal(requestSummary(request.title, request.description), LIVE_SURVEY_SUMMARY);
  assert.match(LIVE_SURVEY_SUMMARY, /e\.g\. "Weekly"\.$/);
  const { result } = await fileFrom(kv);
  assert.equal(String(result["reply"]).split("\n").find((line) => line.startsWith("Summary: ")), undefined);
});

// ---------- 2. summary edge cases through dispatch ----------

test("verify: summary: &amp;lt; is decoded once", async () => {
  assert.equal(await summaryFor("It shows &amp;lt;b&amp;gt; in the header. More."), "It shows &lt;b&gt; in the header.");
});

test("verify: summary: <!here>, <@U…>, <#C…|name>, <url|label> are inert", async () => {
  const summary = await summaryFor("<!here> <@U0BOB0001> says <#C0ABC123|eng> links <https://x.io/a|the doc> fail. More.");
  assert.equal(summary, "@here @U0BOB0001 says #eng links the doc fail.");
  assert.doesNotMatch(summary, /[<>]/);
});

test("verify: summary: <!channel> and <!subteam^S1|@eng> are inert", async () => {
  const summary = await summaryFor("ping <!channel> and <!subteam^S0123|@eng> about export. More.");
  assert.equal(summary, "Ping @channel and @eng about export.");
});

test("verify: summary: a reporter-typed literal &lt;!here&gt; does not become a live broadcast", async () => {
  const summary = await summaryFor("Typing &lt;!here&gt; in a note breaks export. More.");
  assert.doesNotMatch(summary, /<!(?:here|channel|everyone)[>|^]/, `summary: ${summary}`);
});

test("verify: summary: 3 p.m. is not a sentence end", async () => {
  assert.equal(await summaryFor("It fails at 3 p.m. on weekdays only. More."), "It fails at 3 p.m. on weekdays only.");
});

test("verify: summary: v2.3.1 and 1.5x do not split", async () => {
  assert.equal(await summaryFor("Since v2.3.1 the page at 1.5x zoom hides the button. More."), "Since v2.3.1 the page at 1.5x zoom hides the button.");
  assert.equal(await summaryFor("It broke in v2.3.1. Then more."), "It broke in v2.3.1.");
});

test("verify: summary: a code-only body gives the slot, never … or the title", async () => {
  const { lines } = await mention("<@U0FACTORY> Export page is broken\n```\nTypeError: x is undefined\n  at foo (a.ts:1)\n```");
  assert.equal(lines[2], `Summary: ${SLOT.summary}`);
  const long = await mention(`<@U0FACTORY> Export page is broken\n\`${"y".repeat(240)}\``);
  assert.equal(long.lines[2], `Summary: ${SLOT.summary}`, "a single over-long code span is no summary");
});

test("verify: summary: an unpaired backtick neither opens a span nor swallows the sentence", async () => {
  assert.equal(await summaryFor("The `--force flag. is ignored by export. More."), "The `--force flag.");
  const long = `The \`--force flag is ignored by export, ${"and then the page reloads ".repeat(8)}forever.`;
  const summary = await summaryFor(long);
  assertCleanSummary(summary, "Export page is broken");
  assert.ok(summary.length > 100, `an early lone backtick keeps the sentence (got ${JSON.stringify(summary)})`);
});

test("verify: summary: a long sentence with code spans is cut at a word boundary and never inside a span", async () => {
  const body = `Calling \`exportCsv(filter)\` ${"with an empty filter ".repeat(8)}then \`renderRowsForTheSelectedAccount(accountId, options)\` throws.`;
  const summary = await summaryFor(body);
  assertCleanSummary(summary, "Export page is broken");
  assert.ok(summary.endsWith("…"));
  assert.doesNotMatch(summary, /\s…$/);
  const kept = summary.slice(0, -1);
  assert.ok(body.startsWith(kept) && /\s/.test(body[kept.length] ?? " "), "no mid-word cut");
});

test("verify: summary: iOS, eBay, and a lowercase non-ASCII first word", async () => {
  assert.equal(await summaryFor("iOS export fails on Safari. More."), "iOS export fails on Safari.");
  assert.equal(await summaryFor("eBay links open blank. More."), "eBay links open blank.");
  assert.equal(await summaryFor("échec de l'export depuis lundi. Plus."), "Échec de l'export depuis lundi.");
});

test("verify: summary: a hyphenated compound with a capital after the hyphen is still capitalised", async () => {
  assert.equal(await summaryFor("über-Export lädt nicht. Wirklich."), "Über-Export lädt nicht.");
});

test("verify: summary: text ending in etc. keeps etc.", async () => {
  assert.equal(await summaryFor("Export drops rows, headers, totals, etc."), "Export drops rows, headers, totals, etc.");
});

test("verify: summary: never equal to the title", async () => {
  const { lines } = await mention("<@U0FACTORY> Export page is broken\nexport page is broken.");
  assert.equal(lines[2], `Summary: ${SLOT.summary}`);
});

// ---------- 3. reactions: through July's reaction dispatch, then the one-reply sinks ----------

function reactionsWorld(rows: Record<string, unknown>) {
  const kv = recordKv(rows);
  const posts: Array<Record<string, unknown>> = [];
  const jiraCalls: string[] = [];
  let status = "Planned";
  let posted = 0;
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      const body = args as Record<string, unknown>;
      if (method === "auth.test") return { ok: true, user_id: DESK, user: "factory" };
      if (method === "users.info") return { ok: true, user: { id: String(body["user"]), name: "alice", team_id: TEAM, is_bot: String(body["user"]) === DESK, profile: { display_name: "alice" } } };
      if (method === "chat.postMessage") return posts.push(body), { ok: true, ts: `1758510100.00${++posted}` };
      return { ok: true, messages: [] };
    },
  };
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const schema = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [
      { name: "getJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "getTransitionsForJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey") },
      { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
      { name: "addCommentToJiraIssue", inputSchema: schema("cloudId", "issueIdOrKey", "commentBody") },
      { name: "createJiraIssue", inputSchema: schema("projectKey", "summary") },
    ],
    callTool: async (_c: string, name: string): Promise<HostMcpCallResult> => {
      jiraCalls.push(name);
      if (name === "getJiraIssue") return json({ key: "TLSSN-42", fields: { summary: "CSV export", status: { name: status } } });
      if (name === "getTransitionsForJiraIssue") return json({ transitions: status === "Planned" ? [{ id: "31", name: "Approve", to: { name: "Approved" } }] : [] });
      if (name === "transitionJiraIssue") status = "Approved";
      return json({ id: "10001" });
    },
  };
  const client = { apiCall: (method: string, args: Record<string, unknown>) => transport.call(method, args) };
  return { rows, kv, posts, jiraCalls, transport, host: { kv, slack: { getClient: async () => client }, mcp } };
}

async function react(w: ReturnType<typeof reactionsWorld>, reaction: string, ts: string, channel = CHANNEL) {
  resetExternalSenderCache();
  const options = getSlackChannelOptions(slack)!;
  const sends: Array<Record<string, unknown>> = [];
  const pending: Promise<unknown>[] = [];
  dispatchInboundFromEventBody(
    {
      type: "event_callback",
      team_id: TEAM,
      event_id: `Ev${Math.random()}`,
      event: { type: "reaction_added", user: FILER, reaction, item: { type: "message", channel, ts }, item_user: DESK, event_ts: "1758510200.000100" },
    },
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
      log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never,
      mentionsEnabled: true,
      directMessagesEnabled: true,
    }
  );
  await Promise.all(pending);
  return sends;
}

/**
 * Slack as it answers: a post aimed at a reply lands under that reply's root
 * (and says so in `message.thread_ts`); a thread-scoped call aimed at a reply
 * is `invalid_thread_ts`. `roots` maps a reply's ts to its root.
 */
function slackLike(roots: Record<string, string>) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let n = 0;
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "slack",
    call: async (method, args = {}) => {
      const body = args as Record<string, unknown>;
      calls.push({ method, args: body });
      const asked = body["thread_ts"];
      const root = typeof asked === "string" ? (roots[`${String(body["channel"])}:${asked}`] ?? asked) : undefined;
      if (method === "chat.postMessage") return { ok: true, ts: `1758510300.00${++n}`, channel: body["channel"], message: root === undefined ? {} : { thread_ts: root } };
      if (typeof asked === "string" && root !== asked) return { ok: false, error: "invalid_thread_ts" };
      return { ok: true };
    },
  };
  return { transport, calls, posts: () => calls.filter((c) => c.method === "chat.postMessage") };
}

/** One model turn through the desk's one-reply sinks; `reset` re-applies July's wake state before each event, as a hosted wake does. */
async function runTurn(input: { state: Record<string, unknown>; auth: unknown; kv: HostKvApi; slackApi: ReturnType<typeof slackLike>; steps: Array<{ text: string; finishReason: string }>; result: string; reset?: string }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const log = { info: () => {}, debug: () => {}, error: (line: string) => void errors.push(line), warn: (line: string) => void warnings.push(line) };
  const events = oneReplyEvents({ credentials: { botToken: input.slackApi.transport }, suggestedPrompts: [{ title: "File a bug", message: "File a bug: " }], getLog: () => log as never });
  const channel = { channelId: "slack", state: input.state as never, continuationToken: null, setContinuationToken: async () => {} };
  const ctx = { session: { id: "ses_v", auth: input.auth }, host: { kv: input.kv } } as never;
  const base = { sessionId: "ses_v", turnId: "turn_v" };
  const wake = () => {
    if (input.reset !== undefined) input.state["threadTs"] = input.reset;
  };
  wake();
  await events["turn.started"]?.({ ...base, type: "turn.started", data: {} } as never, channel, ctx);
  for (const step of input.steps) {
    wake();
    await events["message.completed"]?.({ ...base, type: "message.completed", data: step } as never, channel, ctx);
  }
  wake();
  await events["turn.completed"]?.({ ...base, type: "turn.completed", data: { result: input.result } } as never, channel, ctx);
  return { errors, warnings };
}

const filingRows = (): Record<string, unknown> => ({ [filingPromptKey({ channelId: CHANNEL, ts: PROMPT_TS })]: { requester: FILER, threadTs: ROOT, at: new Date().toISOString() } });
const FILED = "[TLSSN-44](https://example.atlassian.net/browse/TLSSN-44) is filed. Triaged by Jev: Bug, medium severity (78% confidence).\nSummary: It fails.\nNext: the planner checks it against the code.";

test("verify: ✅ on the filing prompt: exactly one Filed post in the root, no July error, lastBotMessageTs set, prompts on the root (narration + tool call turn)", async () => {
  const w = reactionsWorld(filingRows());
  const sends = await react(w, "white_check_mark", PROMPT_TS);
  assert.equal(sends.length, 1, "one approve file turn");
  assert.deepEqual(w.posts, [], "the host posts nothing itself");
  const state = { ...(sends[0]!["state"] as Record<string, unknown>) };
  assert.equal(state["threadTs"], PROMPT_TS);
  const api = slackLike({ [`${CHANNEL}:${PROMPT_TS}`]: ROOT });
  const { errors, warnings } = await runTurn({
    state,
    auth: sends[0]!["auth"],
    kv: w.kv,
    slackApi: api,
    steps: [
      { text: "Filing it now.", finishReason: "tool_call" },
      { text: FILED, finishReason: "stop" },
    ],
    result: FILED,
  });
  const posts = api.posts();
  assert.ok(posts.length > 0 && posts.every((p) => p.args["thread_ts"] === ROOT), `every post in the root: ${JSON.stringify(posts.map((p) => p.args["thread_ts"]))}`);
  assert.equal(posts.filter((p) => String(p.args["markdown_text"] ?? p.args["text"]).includes("is filed")).length, 1, "exactly one Filed post");
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter((l) => /thread_ts|setSuggestedPrompts/.test(l)), []);
  assert.match(String(state["lastBotMessageTs"]), /^1758510300\.00\d$/);
  assert.deepEqual(api.calls.filter((c) => c.args["thread_ts"] === PROMPT_TS), [], "nothing aimed at the prompt");
  const suggested = api.calls.filter((c) => c.method === "assistant.threads.setSuggestedPrompts").map((c) => c.args["thread_ts"]);
  assert.ok(suggested.length > 0 && suggested.every((t) => t === ROOT), `suggested prompts on the root: ${JSON.stringify(suggested)}`);
});

test("verify: ✅ filing turn when every event re-wakes with threadTs on the prompt (hosted): still one post in the root, no error", async () => {
  const w = reactionsWorld(filingRows());
  const sends = await react(w, "white_check_mark", PROMPT_TS);
  const state = { ...(sends[0]!["state"] as Record<string, unknown>) };
  const api = slackLike({ [`${CHANNEL}:${PROMPT_TS}`]: ROOT });
  const { errors } = await runTurn({ state, auth: sends[0]!["auth"], kv: w.kv, slackApi: api, steps: [{ text: FILED, finishReason: "stop" }], result: FILED, reset: PROMPT_TS });
  assert.deepEqual(api.posts().map((p) => p.args["thread_ts"]), [ROOT]);
  assert.deepEqual(errors, []);
  assert.notEqual(state["lastBotMessageTs"], null);
});

test("verify: ❌ on the filing prompt: exactly one short reply in the root, no model turn, no Jira call", async () => {
  const w = reactionsWorld(filingRows());
  const sends = await react(w, "x", PROMPT_TS);
  assert.deepEqual(sends, []);
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0]!["thread_ts"], ROOT);
  assert.ok(String(w.posts[0]!["text"]).length < 80, "short");
  assert.match(String(w.posts[0]!["text"]), /won't file/);
  assert.deepEqual(w.jiraCalls, [], "no ticket, no Jira read");
});

test("verify: ✅ on the plan post: exactly one starting-implementation post in the root, no model turn", async () => {
  const w = reactionsWorld({
    "ticket/TLSSN-42": { channelId: CHANNEL, threadTs: ROOT, originatorUserId: FILER },
    [threadTicketsKey({ channelId: CHANNEL, threadTs: ROOT })]: ["TLSSN-42"],
    [planPostKey({ channelId: CHANNEL, ts: PLAN_TS })]: { issueKey: "TLSSN-42", threadTs: ROOT, at: new Date().toISOString() },
  });
  const sends = await react(w, "white_check_mark", PLAN_TS);
  assert.deepEqual(sends, []);
  assert.deepEqual(w.posts.map((p) => [p["thread_ts"], p["text"]]), [[ROOT, "TLSSN-42: starting implementation…"]]);
  assert.equal(w.jiraCalls.filter((c) => c === "transitionJiraIssue").length, 1);
});

test("verify: a normal in-thread reply is not retargeted, even with a filing prompt recorded in that thread", async () => {
  const rows = filingRows();
  const api = slackLike({});
  const state: Record<string, unknown> = { channelId: CHANNEL, threadTs: ROOT, teamId: TEAM, triggeringUserId: FILER, lastBotMessageTs: null };
  const { errors } = await runTurn({ state, auth: { attributes: { channel_id: CHANNEL, thread_ts: ROOT } }, kv: recordKv(rows), slackApi: api, steps: [{ text: "It is Planned.", finishReason: "stop" }], result: "It is Planned." });
  assert.deepEqual(api.posts().map((p) => p.args["thread_ts"]), [ROOT]);
  assert.deepEqual(errors, []);
  assert.equal(state["threadTs"], ROOT);
});

test("verify: a normal DM turn is not retargeted", async () => {
  const M = "1758520000.000100";
  const rows: Record<string, unknown> = { [filingPromptKey({ channelId: CHANNEL, ts: M })]: { requester: FILER, threadTs: ROOT, at: new Date().toISOString() } };
  const api = slackLike({});
  const state: Record<string, unknown> = { channelId: DM, threadTs: M, teamId: TEAM, triggeringUserId: FILER, lastBotMessageTs: null };
  await runTurn({ state, auth: { attributes: { channel_id: DM, thread_ts: M } }, kv: recordKv(rows), slackApi: api, steps: [{ text: "Hi.", finishReason: "stop" }], result: "Hi." });
  assert.deepEqual(api.posts().map((p) => [p.args["channel"], p.args["thread_ts"]]), [[DM, M]]);
});

test("verify: a turn in another channel at the same ts as a recorded filing prompt is not retargeted; a reaction there starts nothing", async () => {
  const w = reactionsWorld(filingRows());
  assert.deepEqual(await react(w, "white_check_mark", PROMPT_TS, OTHER), []);
  assert.deepEqual(w.posts, []);
  const api = slackLike({});
  const state: Record<string, unknown> = { channelId: OTHER, threadTs: PROMPT_TS, teamId: TEAM, triggeringUserId: FILER, lastBotMessageTs: null };
  await runTurn({ state, auth: { attributes: { channel_id: OTHER, thread_ts: PROMPT_TS } }, kv: w.kv, slackApi: api, steps: [{ text: "Hi.", finishReason: "stop" }], result: "Hi." });
  assert.deepEqual(api.posts().map((p) => [p.args["channel"], p.args["thread_ts"]]), [[OTHER, PROMPT_TS]]);
});

test("verify: DM, second request: ✅ on its filing prompt replies in that request's thread, not the DM's first message", async () => {
  // July keys a DM session on the channel and keeps the auth it was created
  // with, while `threadTs` is refreshed to each new DM message.
  const M1 = "1758520000.000100";
  const M2 = "1758523000.000100";
  const rows: Record<string, unknown> = {};
  const kv = recordKv(rows);
  const firstAuth = { authenticator: "slack", principalId: `slack:${TEAM}:${DM}`, principalType: "user", attributes: { channel_id: DM, thread_ts: M1, user_id: FILER } };
  const prompt = "CSV export drops the header\nTriaged by Jev: Bug, low severity.\nSummary: The header row is gone.\nReact ✅ to file it with this triage or ❌ to drop it, or reply `approve file` / `deny file`.";
  const api = slackLike({});
  const asked: Record<string, unknown> = { channelId: DM, threadTs: M2, teamId: TEAM, triggeringUserId: FILER, lastBotMessageTs: null };
  await runTurn({ state: asked, auth: firstAuth, kv, slackApi: api, steps: [{ text: prompt, finishReason: "stop" }], result: prompt });
  const promptPost = api.posts()[0]!;
  assert.equal(promptPost.args["thread_ts"], M2, "the prompt lands in the second request's thread");
  const promptTs = String(asked["lastBotMessageTs"]);
  assert.ok(rows[filingPromptKey({ channelId: DM, ts: promptTs })] !== undefined, "the prompt is recorded");

  const after = slackLike({ [`${DM}:${promptTs}`]: M2 });
  const reacted: Record<string, unknown> = { channelId: DM, threadTs: promptTs, teamId: TEAM, triggeringUserId: FILER, lastBotMessageTs: null };
  const { errors } = await runTurn({ state: reacted, auth: firstAuth, kv, slackApi: after, steps: [{ text: FILED, finishReason: "stop" }], result: FILED });
  assert.deepEqual(after.posts().map((p) => p.args["thread_ts"]), [M2], `recorded root: ${JSON.stringify((rows[filingPromptKey({ channelId: DM, ts: promptTs })] as Record<string, unknown>)["threadTs"])}`);
  assert.deepEqual(errors, []);
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HostMcpCallResult } from "@cursor/july";
import {
  createChannelPostWatcher,
  createEventIdDedupe,
  dispatchInboundFromEventBody,
  dispatchInboundMessage,
  getSlackChannelOptions,
  resetExternalSenderCache,
  SlackChannelAllowlist,
  type SlackApiTransport,
} from "@cursor/july/channels/slack";
import { approveCommandText, approveTarget, isDenyFile } from "../lib/approve-command.js";
import { fixTarget, pullRequestToken } from "../lib/fix-request.js";
import { planCommandTarget } from "../lib/plan-command.js";
import { retryTarget } from "../lib/retry-command.js";
import slack, { DESK_CHANNEL_POSTS } from "./slack.js";

// The TLSSN-33 smoke after #147 (thread 1790416144.037009, #mars-eng-intake):
// `@factory plan TLSSN-33` on an In Review ticket, a bare `retry TLSSN-33`,
// and `@factory fix <PR>` each came back as a model reply. These drive the
// same Slack event bodies through July's dispatch (app_mention and the
// channel-post watcher, as hosted admission does) and count model sends and
// host posts. The one-reply contract: an exact host command posts one host
// line and starts no model turn.

const ENV = { FACTORY_JIRA_PROJECTS: "TLSSN", FACTORY_DESK_CLAIM_SETTLE_MS: "1" } as const;
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});
after(() => {
  for (const name of Object.keys(ENV)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const TEAM = "T0EXAMPLE1";
const BOT = "U0EXAMPLE2";
const CHANNEL = "C0EXAMPLE1";
const ROOT = "1790416144.037009";
const FILER = "U0EXAMPLE3";
const KEY = "TLSSN-33";
const FOOTER = "\n*Sent using* <@U0EXAMPLE1|Cursor>";
const PR = "https://github.com/cursor-demo-lab/marsbank/pull/29";

type Delivered = { sends: number; posts: string[]; failed: unknown[] };

async function deliver(input: {
  type: "app_mention" | "message";
  text: string;
  ts: string;
  status?: string;
  kvGet?: (key: string) => unknown;
  /** The thread the post is in; the post's own ts for a top-level post. Defaults to the ticket's thread. */
  threadTs?: string;
  /** Replaces the default store (the ticket bound to ROOT, indexed there). */
  kv?: Record<string, unknown>;
}): Promise<Delivered> {
  resetExternalSenderCache();
  const posts: string[] = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "test",
    call: async (method, args = {}) => {
      const body = args as Record<string, unknown>;
      if (method === "users.info") return { ok: true, user: { id: FILER, team_id: TEAM } };
      if (method === "chat.postMessage") {
        posts.push(String(body["text"] ?? body["markdown_text"]));
        return { ok: true, ts: "1790446999.000100" };
      }
      return { ok: true, messages: [] };
    },
  };
  const kv: Record<string, unknown> = input.kv ?? { [`ticket/${KEY}`]: { channelId: CHANNEL, threadTs: ROOT, originatorUserId: FILER }, [`thread-tickets/${CHANNEL}:${ROOT}`]: [KEY] };
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp = {
    names: () => ["tracker"],
    listTools: async () => [{ name: "getJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } } } }],
    callTool: async (): Promise<HostMcpCallResult> => json({ key: KEY, fields: { status: { name: input.status ?? "In Review" }, comment: { comments: [] } } }),
  };
  const asks = new Set<string>();
  const client = { apiCall: (method: string, args: Record<string, unknown>) => transport.call(method, args) };
  const host = {
    kv: {
      get: async (key: string) => (input.kvGet === undefined ? kv[key] : input.kvGet(key) ?? kv[key]),
      put: async (key: string, value: unknown) => void (kv[key] = value),
      delete: async (key: string) => void delete kv[key],
    },
    slack: { getClient: async () => client },
    mcp,
    // Hosted serving's once-per-message claim before a model turn (July's dispatch).
    slackNudges: {
      tryClaimAsk: async (channelId: string, ts: string) => (asks.has(`${channelId}:${ts}`) ? false : (asks.add(`${channelId}:${ts}`), true)),
      releaseAsk: async (channelId: string, ts: string) => void asks.delete(`${channelId}:${ts}`),
      append: async () => true,
      drainFormatted: async () => undefined,
      clear: async () => {},
      hasUndelivered: async () => false,
      isDelivered: async () => false,
    },
  };
  const options = getSlackChannelOptions(slack)!;
  let sends = 0;
  const pending: Promise<unknown>[] = [];
  const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never;
  const send = (async () => ((sends += 1), { id: "ses_test", isNew: true })) as never;
  const watcher = createChannelPostWatcher({
    options: { ...DESK_CHANNEL_POSTS, debounceMs: 0 },
    allowlist: new SlackChannelAllowlist(DESK_CHANNEL_POSTS.allow),
    getBotUserId: () => BOT,
    log,
    dispatch: (message) => {
      pending.push(dispatchInboundMessage({ kind: "channel_post", message, handler: options.onChannelPost!, send, credentials: { botToken: transport }, host: host as never, artifacts: {} as never, log, evalCommandsEnabled: true, propagateHandlerErrors: true }));
    },
  });
  const deps = { send, waitUntil: (promise: Promise<unknown>) => void pending.push(promise), onAppMention: options.onAppMention!, onDirectMessage: options.onDirectMessage!, credentials: { botToken: transport }, host: host as never, artifacts: {} as never, log, mentionsEnabled: true, directMessagesEnabled: true, propagateHandlerErrors: true, channelWatch: watcher };
  const threadTs = input.threadTs ?? ROOT;
  const event = { team: TEAM, channel: CHANNEL, channel_type: "channel", user: FILER, text: input.text, ts: input.ts, ...(threadTs === input.ts ? {} : { thread_ts: threadTs }) };
  const body = (type: string) => ({ type: "event_callback", team_id: TEAM, event_id: `Ev${Math.random()}`, authorizations: [{ user_id: BOT }], event: { ...event, type } });
  const quiet = [console.log, console.error] as const;
  console.log = () => {};
  console.error = () => {};
  try {
    // Slack sends a mention as app_mention and message; the watcher skips the
    // message twin only when the text holds the unlabeled `<@BOT>`.
    if (input.type === "app_mention") dispatchInboundFromEventBody(body("app_mention"), { ...deps, eventIds: createEventIdDedupe() });
    dispatchInboundFromEventBody(body("message"), { ...deps, eventIds: createEventIdDedupe() });
    const settled = await Promise.allSettled(pending);
    return { sends, posts, failed: settled.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason) };
  } finally {
    [console.log, console.error] = quiet;
  }
}

function assertOneHostReply(result: Delivered, reply: RegExp): void {
  assert.deepEqual(result.failed, [], "the handler did not throw");
  assert.equal(result.sends, 0, "no model turn");
  assert.equal(result.posts.length, 1, result.posts.join("\n---\n"));
  assert.match(result.posts[0]!, reply);
}

test("TLSSN-33: `@factory plan KEY` on an In Review ticket, labeled or not, gets the host's past-planning line and no model turn", async () => {
  for (const [text, ts] of [
    [`<@${BOT}|factory> plan ${KEY}${FOOTER}`, "1790446322.593229"],
    [`<@${BOT}> plan ${KEY}${FOOTER}`, "1790446322.593230"],
  ] as const) {
    assertOneHostReply(await deliver({ type: "app_mention", text, ts }), /^TLSSN-33 is In Review, past planning, so I did not send it back to the planner\.$/);
  }
});

test("TLSSN-33: a bare `retry KEY` channel post on an In Review ticket gets the host's nothing-to-retry line and no model turn", async () => {
  assertOneHostReply(await deliver({ type: "message", text: `retry ${KEY}${FOOTER}`, ts: "1790446426.846909" }), /^TLSSN-33 is In Review\. Nothing is waiting on triage, the planner, or the worker's launch, so there is nothing to retry\.$/);
});

test("TLSSN-33: `@factory fix <url|github.com/…>`, Slack's own autolink, gets the host fix reply once and no model turn", async () => {
  const text = `<@${BOT}|factory> fix <${PR}|github.com/cursor-demo-lab/marsbank/pull/29>${FOOTER}`;
  assertOneHostReply(await deliver({ type: "app_mention", text, ts: "1790446495.401919" }), /^I can't drive cursor-demo-lab\/marsbank#29\./);
});

// The hosted runtime delivered these with the newline before the footer
// collapsed to a space (the desk's `{"desk":"inbound"}` log after #148).
test("TLSSN-33 as hosted delivers it, footer inline: `plan`, bare `retry`, and `fix <autolink>` each get one host reply and no model turn", async () => {
  assertOneHostReply(
    await deliver({ type: "app_mention", text: `<@${BOT}> plan ${KEY} *Sent using* <@U0EXAMPLE1>`, ts: "1790446322.593231" }),
    /^TLSSN-33 is In Review, past planning, so I did not send it back to the planner\.$/
  );
  assertOneHostReply(
    await deliver({ type: "message", text: `retry ${KEY} *Sent using* <@U0EXAMPLE1>`, ts: "1790446426.846911" }),
    /^TLSSN-33 is In Review\. Nothing is waiting on triage, the planner, or the worker's launch, so there is nothing to retry\.$/
  );
  assertOneHostReply(
    await deliver({ type: "app_mention", text: `<@${BOT}> fix <${PR}|github.com/cursor-demo-lab/marsbank/pull/29> *Sent using* <@U0EXAMPLE1>`, ts: "1790446495.401920" }),
    /^I can't drive cursor-demo-lab\/marsbank#29\./
  );
});

test("an inline Sent using footer ending the message is chrome in every host parser; words after it or a longer sender are not", () => {
  for (const footer of [" *Sent using* <@U0EXAMPLE1>", " *Sent using* <@U0EXAMPLE1|Cursor>", " _Sent using_ Cursor", " Sent using @U0EXAMPLE1", " **Sent using** *Cursor*", "  *Sent using*  <@U0EXAMPLE1>  "]) {
    assert.deepEqual(planCommandTarget(`<@${BOT}> replan ${KEY}${footer}`), { verb: "replan", issueKey: KEY }, JSON.stringify(footer));
    assert.equal(retryTarget(`retry ${KEY}${footer}`), KEY, JSON.stringify(footer));
    assert.equal(approveTarget(`approve ${KEY}${footer}`), KEY, JSON.stringify(footer));
    assert.equal(fixTarget(`fix ${PR}${footer}`)?.label, "cursor-demo-lab/marsbank#29", JSON.stringify(footer));
    assert.equal(isDenyFile({ text: `deny file${footer}`, body: "", markdown: "", ts: "1.0", threadTs: ROOT, channelId: CHANNEL }), true, JSON.stringify(footer));
  }
  assert.equal(approveTarget(`@${BOT} approve ${KEY} *Sent using* @U0EXAMPLE1`), KEY, "July's markdown form");
  for (const text of [
    `plan ${KEY} please *Sent using* <@U0EXAMPLE1>`,
    `plan ${KEY} sent using my phone`,
    `plan ${KEY} *Sent using* <@U0EXAMPLE1> and also the CI`,
    `plan ${KEY} *Sent using* Cursor Agent`,
  ]) {
    assert.equal(planCommandTarget(text), undefined, JSON.stringify(text));
  }
  assert.equal(fixTarget(`fix ${PR} and rebase it *Sent using* <@U0EXAMPLE1>`), undefined);
});

test("a host command that throws still posts one host line and starts no model turn", async () => {
  const kvGet = (key: string) => {
    if (key === `hop-watch/${KEY}`) throw new Error("kv unavailable");
    return undefined;
  };
  assertOneHostReply(await deliver({ type: "message", text: `retry ${KEY}${FOOTER}`, ts: "1790446426.846910", kvGet }), /^Something failed while I handled that command/);
});

test("other Slack attribution footers, invisible characters, and a typographic dash are still the exact command", () => {
  for (const text of [
    `plan ${KEY}\n_Sent using_ <@U0EXAMPLE1|Cursor>`,
    `plan ${KEY}\nSent using Cursor`,
    `plan ${KEY}\n\n*Sent using* <@U0EXAMPLE1>\n`,
    `plan ${KEY}\u2060${FOOTER}`,
    `plan TLSSN\u201133`,
    `plan *${KEY}*`,
    `plan \`${KEY}\``,
  ]) {
    assert.deepEqual(planCommandTarget(text), { verb: "plan", issueKey: KEY }, JSON.stringify(text));
  }
  assert.equal(retryTarget(`<@${BOT}|factory> retry ${KEY}\n_Sent using_ Cursor`), KEY);
  assert.equal(approveCommandText("approve MY_PROJ-1"), "approve MY_PROJ-1", "an underscore inside a key is kept");
  for (const text of [`plan ${KEY} please${FOOTER}`, `plan ${KEY} sent using my phone`, `plan ${KEY}\nand also look at the CI`]) {
    assert.equal(planCommandTarget(text), undefined, JSON.stringify(text));
  }
});

test("a Slack link counts as a PR when its label is that PR's URL, with or without the scheme, and never otherwise", () => {
  const same = { owner: "cursor-demo-lab", repo: "marsbank", number: 29, url: PR, label: "cursor-demo-lab/marsbank#29" };
  for (const token of [`<${PR}>`, `<${PR}|${PR}>`, `<${PR}|github.com/cursor-demo-lab/marsbank/pull/29>`, `<${PR}|www.github.com/Cursor-Demo-Lab/marsbank/pull/29/>`]) {
    assert.deepEqual(pullRequestToken(token), same, token);
  }
  for (const token of [`<${PR}|github.com/cursor-demo-lab/marsbank/pull/30>`, `<${PR}|cursor-demo-lab/marsbank#29>`, `<${PR}|acme/other#29>`, `<${PR}|the fix>`]) {
    assert.equal(pullRequestToken(token), undefined, token);
  }
  assert.equal(fixTarget(`<@${BOT}|factory> fix <${PR}|github.com/cursor-demo-lab/marsbank/pull/29>${FOOTER}`)?.label, "cursor-demo-lab/marsbank#29");
  assert.equal(fixTarget(`fix ${PR}${FOOTER}`)?.label, "cursor-demo-lab/marsbank#29");
  assert.equal(fixTarget(`fix ${PR} and rebase it${FOOTER}`), undefined);
});

// Simon: a reply inside a factory thread needs no @factory. The channel watch
// passes a plain reply on only in a thread the factory owns, and only when it
// is a command, a needs-info answer, or a clear question to the factory.
const OTHER = "1790416999.000100";
const FILING_ROOT = "1790417000.000100";
const filingKv = () => ({ [`filing-thread/${CHANNEL}:${FILING_ROOT}`]: { at: "2026-09-27T00:00:00.000Z" } });
let seq = 0;
const nextTs = () => `1790447${String(100 + (seq += 1)).padStart(3, "0")}.000100`;

test("plain replies in a ticket's thread: host commands answer once with no model turn; model commands start exactly one turn", async () => {
  for (const text of ["approve", `approve ${KEY}`, `retry ${KEY}`, `plan ${KEY}`, `replan ${KEY}`, `fix ${PR}`]) {
    const result = await deliver({ type: "message", text: `${text}${FOOTER}`, ts: nextTs() });
    assertOneHostReply(result, /\S/);
  }
  for (const text of [`deny ${KEY}`, "deny", "retry", "plan", "fix"]) {
    const result = await deliver({ type: "message", text: `${text}${FOOTER}`, ts: nextTs() });
    assert.deepEqual(result.failed, []);
    assert.equal(result.sends, 1, `${text}: one model turn`);
    assert.deepEqual(result.posts, [], `${text}: the turn's reply is the only one`);
  }
});

test("plain `approve file` / `deny file` in the intake thread the desk replied to reach the filing turn once", async () => {
  for (const text of ["approve file", "deny file"]) {
    const result = await deliver({ type: "message", text: `${text}${FOOTER}`, ts: nextTs(), threadTs: FILING_ROOT, kv: filingKv() });
    assert.deepEqual(result.failed, []);
    assert.equal(result.sends, 1, text);
  }
});

test("a mentioned `approve file` delivered twice (app_mention and the watch, labeled mention) still starts exactly one turn", async () => {
  const result = await deliver({ type: "app_mention", text: `<@${BOT}|factory> approve file${FOOTER}`, ts: nextTs(), threadTs: FILING_ROOT, kv: filingKv() });
  assert.deepEqual(result.failed, []);
  assert.equal(result.sends, 1);
  const host = await deliver({ type: "app_mention", text: `<@${BOT}|factory> approve${FOOTER}`, ts: nextTs() });
  assertOneHostReply(host, /\S/);
});

test("a clear question to the factory in its thread gets a turn; chatter, thanks, and a question to a teammate get nothing", async () => {
  for (const text of ["factory, what's the status?", "is the plan ready?", `any update on ${KEY}?`, "when does the PR go up?", "status?"]) {
    const result = await deliver({ type: "message", text: `${text}${FOOTER}`, ts: nextTs() });
    assert.equal(result.sends, 1, text);
  }
  for (const text of ["thanks!", "looks good to me", `<@U0ALICE01> can you check the staging deploy?`, "did anyone try it on staging?", `I'd approve ${KEY} once CI is green`, "approve it when you're ready"]) {
    const result = await deliver({ type: "message", text: `${text}${FOOTER}`, ts: nextTs() });
    assert.deepEqual(result, { sends: 0, posts: [], failed: [] }, text);
  }
});

test("outside a factory thread a plain post is ignored: top-level posts and other people's threads, commands included", async () => {
  for (const text of [`approve ${KEY}`, "approve", "approve file", `retry ${KEY}`, "file a bug: login is broken", "factory, what's the status?"]) {
    const top = nextTs();
    assert.deepEqual(await deliver({ type: "message", text: `${text}${FOOTER}`, ts: top, threadTs: top }), { sends: 0, posts: [], failed: [] }, `top-level: ${text}`);
    assert.deepEqual(await deliver({ type: "message", text: `${text}${FOOTER}`, ts: nextTs(), threadTs: OTHER }), { sends: 0, posts: [], failed: [] }, `other thread: ${text}`);
  }
  const top = nextTs();
  assert.equal((await deliver({ type: "app_mention", text: `<@${BOT}> file a bug: login is broken`, ts: top, threadTs: top, kv: {} })).sends, 1, "starting a request still takes the mention");
});

test("a key command counts in the thread its ticket is bound to even before the thread index has it", async () => {
  const kv = { [`ticket/${KEY}`]: { channelId: CHANNEL, threadTs: ROOT, originatorUserId: FILER } };
  assertOneHostReply(await deliver({ type: "message", text: `retry ${KEY}${FOOTER}`, ts: nextTs(), kv }), /nothing to retry/);
  assert.deepEqual(await deliver({ type: "message", text: `retry TLSSN-99${FOOTER}`, ts: nextTs(), kv }), { sends: 0, posts: [], failed: [] });
});

test("in a thread waiting on a needs-info answer, a plain reply is the answer; a bare thanks is not", async () => {
  const kv = { [`ticket/${KEY}`]: { channelId: CHANNEL, threadTs: ROOT, originatorUserId: FILER }, [`awaiting-info/${CHANNEL}:${ROOT}`]: { issueKey: KEY, kind: "needs_info", at: "2026-09-27T00:00:00.000Z" } };
  assert.deepEqual(await deliver({ type: "message", text: `thanks${FOOTER}`, ts: nextTs(), kv: { ...kv } }), { sends: 0, posts: [], failed: [] });
  const answer = await deliver({ type: "message", text: `It happens on Safari 17 only, since Tuesday's deploy.${FOOTER}`, ts: nextTs(), kv: { ...kv }, status: "Triaged" });
  assert.equal(answer.sends, 0, "host code takes the answer, no model turn");
  assert.equal(answer.posts.length, 1, answer.posts.join("\n"));
  assert.match(answer.posts[0]!, /your reply to TLSSN-33 in Jira/, "the ticket-update path took it (this harness's Jira has no comment tool)");
});

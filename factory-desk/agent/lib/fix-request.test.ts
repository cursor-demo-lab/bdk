import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isExternalSlackSender,
  resetExternalSenderCache,
  slackTextToMarkdown,
  type SlackApiTransport,
  type SlackMessage,
  type SlackMessageHandler,
} from "@cursor/july/channels/slack";
import { deskInbound, JULY_CACHE_PROBE, julyClassifiedSender, slackConnectSender } from "./fix-request.js";

const PR = "https://github.com/acme/widgets/pull/12";
const TEAM_ID = "T0123";

function mention(raw: string, author: SlackMessage["author"] | null = { userId: "U0ALICE", userName: "alice", isBot: false }): SlackMessage {
  const message: SlackMessage = {
    text: raw,
    body: raw,
    markdown: slackTextToMarkdown(raw),
    ts: "1758510000.200000",
    threadTs: "1758510000.123456",
    channelId: "C0123ABCD",
    teamId: "T0123",
  };
  if (author !== null) message.author = author;
  return message;
}

function harness(external = false) {
  const posts: string[] = [];
  const fallbackCalls: string[] = [];
  const externalChecks: string[] = [];
  const fallback: SlackMessageHandler = (_ctx, message) => {
    fallbackCalls.push(message.text);
    return { auth: null, message: "model turn" };
  };
  const ctx = {
    thread: {
      post: async (text: string) => {
        posts.push(text);
        return { ts: "1758510001.000100" };
      },
      startTyping: async () => {},
      setTitle: async () => {},
      setSuggestedPrompts: async () => {},
    },
    slack: { channelId: "C0123ABCD", threadTs: "1758510000.123456", teamId: "T0123" },
    host: {},
    artifacts: {},
  };
  const isExternal = async (message: SlackMessage) => {
    externalChecks.push(message.author?.userId ?? "");
    return external;
  };
  return { posts, fallbackCalls, externalChecks, handler: deskInbound({ fallback, isExternal }), ctx: ctx as never };
}

const MODEL_TURN = { auth: null, message: "model turn" };

function contextText(decision: { context?: string[] } | null | undefined): string {
  return decision?.context?.join("\n") ?? "";
}

test("a fix request on a PR URL is answered in the thread with the factory: drive instruction and starts no model turn", async () => {
  const h = harness();
  const decision = await h.handler(h.ctx, mention(`<@U0FACTORY> fix ${PR}`));
  assert.equal(decision, null);
  assert.deepEqual(h.fallbackCalls, []);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0]!, /`factory: drive`/);
  assert.match(h.posts[0]!, /https:\/\/github\.com\/acme\/widgets\/pull\/12/);
  assert.match(h.posts[0]!, /yourself/);
  assert.match(h.posts[0]!, /first time a check goes red/);
});

// Exactly `<fix verb> [on|for] <one PR ref> [.!?]*` after the bot mention.
const CANNED: Array<[raw: string, label: string]> = [
  ["drive acme/widgets#7", "acme/widgets#7"],
  ["take over <https://github.com/acme/widgets/pull/7>", "acme/widgets#7"],
  ["<@U0FACTORY> fix <https://github.com/acme/widgets/pull/7|https://github.com/acme/widgets/pull/7>", "acme/widgets#7"],
  ["get CI green on acme/widgets#7", "acme/widgets#7"],
  ["<@U0FACTORY> address the review for https://github.com/acme/widgets/pull/7/files!", "acme/widgets#7"],
  ["Fix https://github.com/acme/widgets/pull/7.", "acme/widgets#7"],
  ["take  over\tacme/widgets#7", "acme/widgets#7"],
  ["@U0FACTORY: fix acme/widgets#7 ?!", "acme/widgets#7"],
  // Bugbot at 20ec5c6: a command word inside a repo name, and a trailing `?`.
  ["fix acme/x-status#3", "acme/x-status#3"],
  [`fix ${PR}?`, "acme/widgets#12"],
  ["fix acme/widgets#12?", "acme/widgets#12"],
  ["fix <https://github.com/acme/widgets/pull/12>?", "acme/widgets#12"],
  ["fix acme/report-a-bug#2", "acme/report-a-bug#2"],
  ["fix acme/log-issue#4", "acme/log-issue#4"],
  ["fix acme/status#1", "acme/status#1"],
  ["fix acme/log-this#5", "acme/log-this#5"],
  ["fix acme/approve-file#6", "acme/approve-file#6"],
  ["fix acme/TLSSN-42#7", "acme/TLSSN-42#7"],
  ["fix TLSSN-42/widgets#7", "TLSSN-42/widgets#7"],
  // Shape only: the desk cannot ask GitHub whether this PR exists, so a
  // path-like `owner/repo#n` gets the instruction too.
  ["fix docs/readme#3", "docs/readme#3"],
];

test("exactly a fix verb and one PR ref gets the factory: drive instruction, whatever words the repo name holds", async () => {
  for (const [raw, label] of CANNED) {
    const h = harness();
    assert.equal(await h.handler(h.ctx, mention(raw)), null, raw);
    assert.deepEqual(h.fallbackCalls, [], raw);
    assert.equal(h.posts.length, 1, raw);
    assert.ok(h.posts[0]!.includes(label), `${raw}: ${h.posts[0]}`);
  }
});

test("the raw Slack text is read, not markdown, so a link's label cannot stand in for its URL", async () => {
  const unwrapped = harness();
  const plain = mention("<@U0FACTORY> fix <https://github.com/acme/widgets/pull/7>");
  plain.markdown = "";
  assert.equal(await unwrapped.handler(unwrapped.ctx, plain), null);
  assert.equal(unwrapped.posts.length, 1);
  assert.match(unwrapped.posts[0]!, /acme\/widgets#7/);

  const relabelled = harness();
  const message = mention("fix <https://github.com/acme/widgets/pull/7|https://github.com/acme/widgets/pull/8>");
  assert.equal(message.markdown, "fix https://github.com/acme/widgets/pull/8");
  const relabelledTurn = await relabelled.handler(relabelled.ctx, message);
  assert.equal(relabelledTurn?.message, "model turn");
  assert.match(contextText(relabelledTurn), /<slack_reply>/);
  assert.deepEqual(relabelled.posts, []);
});

const MODEL: string[] = [
  // A second token after the ref.
  `fix ${PR} and log this`,
  `fix ${PR} please`,
  `fix ${PR} thanks!`,
  `fix ${PR} and raise an issue: the CSV export is broken`,
  `fix ${PR} and report a bug: the CSV export is broken`,
  `fix ${PR} about TLSSN-42`,
  `Fix ${PR} was reverted, why?`,
  "fix acme/widgets#12 and TLSSN\u201142",
  // Two refs.
  `fix ${PR} ${PR}`,
  "fix acme/widgets#7 acme/widgets#8",
  "fix acme/widgets#7,acme/widgets#8",
  // Punctuation other than . ! ? after the ref.
  `fix ${PR},`,
  `fix ${PR}; what is the status of the plan?`,
  `fix ${PR}, then deny TLSSN-42`,
  // Anything before the verb, or words between the verb and the ref.
  `approve TLSSN-42 and fix ${PR}`,
  `replan TLSSN-42 and take over ${PR}`,
  `can you fix ${PR}?`,
  `please fix ${PR}`,
  "fix the PR https://github.com/acme/widgets/pull/7",
  "get CI green on the acme/widgets#7",
  "get CI green on for acme/widgets#7",
  "fix the acme/widgets#7",
  "take under acme/widgets#7",
  "<@U0FACTORY>fix acme/widgets#7",
  "fix acme/widgets#7 ,",
  "fix see:https://github.com/acme/widgets/pull/7",
  "<@U0FACTORY> <@U0BOB> fix acme/widgets#7",
  `<@U0BOB> fix ${PR}, <@U0FACTORY> what do you think?`,
  "don't fix acme/widgets#7.",
  `the shared drive link is in ${PR}`,
  "What is the status of the fix for acme/widgets#12?",
  "please acme/widgets#7",
  // No PR ref, or not a GitHub PR.
  "approve TLSSN-42 please",
  "fix TLSSN-42",
  "fix",
  "fix acme/widgets",
  "fix https://github.com/acme/widgets/issues/12",
  "fix https://gitlab.com/acme/widgets/pull/12",
  "fix http://github.com/acme/widgets/pull/12",
  "fix https://github.com/acme/../pull/12",
  "fix https://github.com/acme/widgets/pull/0",
  "fix -acme/widgets#3",
  "fix acme/widgets#",
  "fix x/acme/widgets#7",
  "fix x<https://github.com/acme/widgets/pull/7>",
  "fix <https://github.com/acme/widgets/pull/7>x",
  "fix <https://github.com/acme/widgets/pull/7|the widgets PR>",
  "fix <https://github.com/acme/widgets/pull/7|acme/widgets#7>",
  "fix <https://github.com/acme/widgets/pull/7|https://github.com/acme/widgets/pull/8>",
  "fix <acme/widgets#7>",
  "File a bug: CSV export returns 500",
];

test("anything else goes to the model: a second token, two refs, words around the verb, or no PR ref", async () => {
  for (const raw of MODEL) {
    const h = harness();
    const decision = await h.handler(h.ctx, mention(raw));
    assert.equal(decision?.message, "model turn", raw);
    assert.equal(decision && "auth" in decision ? decision.auth : undefined, null, raw);
    assert.deepEqual(h.posts, [], raw);
  }
});

test("bare or mentioned approve KEY is the host's to answer: one reply, null, no model turn", async () => {
  for (const raw of ["approve TLSSN-19", "<@U0FACTORY> approve TLSSN-19", "<@U0FACTORY|factory> approve TLSSN-19"]) {
    const h = harness();
    const decision = await h.handler(h.ctx, mention(raw));
    assert.equal(decision, null, raw);
    assert.deepEqual(h.fallbackCalls, [], raw);
    assert.equal(h.posts.length, 1, raw);
    assert.match(h.posts[0]!, /TLSSN-19 was not filed from Slack/, raw);
  }
});

test("approve KEY with more words is still tagged for approve_ticket on the model turn", async () => {
  const h = harness();
  const decision = await h.handler(h.ctx, mention("<@U0FACTORY> approve TLSSN-19 please"));
  const tagged = contextText(decision);
  assert.equal(decision?.message, "model turn");
  assert.match(tagged, /approve_ticket/);
  assert.match(tagged, /<slack_reply>/);
  assert.doesNotMatch(tagged, /@factory-desk approve/);
});

test("approve file stays untagged for desk_command; filing is still a model routing decision", async () => {
  const h = harness();
  const decision = await h.handler(h.ctx, mention("approve file"));
  const tagged = contextText(decision);
  assert.equal(decision?.message, "model turn");
  assert.doesNotMatch(tagged, /<desk_command>/);
  assert.match(tagged, /<slack_reply>/);
  assert.match(tagged, /Never name a tool/);
  assert.match(tagged, /@factory/);
  assert.doesNotMatch(tagged, /@factory-desk approve/);
});

test("bare deny KEY and replan KEY are tagged for their tools", async () => {
  const denied = harness();
  const deny = await denied.handler(denied.ctx, mention("deny TLSSN-19"));
  assert.match(contextText(deny), /deny_ticket/);
  assert.match(contextText(deny), /<slack_reply>/);
  const replanned = harness();
  const replan = await replanned.handler(replanned.ctx, mention("replan TLSSN-19 now"));
  assert.match(contextText(replan), /request_plan/);
  assert.match(contextText(replan), /replan: true/);
  assert.match(contextText(replan), /<slack_reply>/);
});

test("slack_reply ask copy reads FACTORY_DESK_SLACK_HANDLE and never offers @factory-desk", async () => {
  const saved = process.env.FACTORY_DESK_SLACK_HANDLE;
  process.env.FACTORY_DESK_SLACK_HANDLE = "factory-bot";
  try {
    const h = harness();
    const decision = await h.handler(h.ctx, mention("File a bug: CSV export returns 500"));
    const tagged = contextText(decision);
    assert.match(tagged, /Your Slack handle is @factory-bot\./, "the model writes the host's handle, not July's raw self_name");
    assert.match(tagged, /A plain reply in this thread does not reach you, so ask for a ✅ or ❌ reaction, never a typed command\. Never write @factory-bot or @factory-desk\./, "an unwatched channel gets reactions, never a mentioned command");
    assert.doesNotMatch(tagged, /`@factory-bot approve/);
    assert.doesNotMatch(tagged, /@factory-desk approve/);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_DESK_SLACK_HANDLE;
    else process.env.FACTORY_DESK_SLACK_HANDLE = saved;
  }
});

test("a Slack Connect sender gets no canned post; the stock path, which applies July's external policy, decides", async () => {
  const h = harness(true);
  const decision = await h.handler(h.ctx, mention(`fix ${PR}`, { userId: "U0GUEST", isBot: false }));
  assert.equal(decision?.message, "model turn");
  assert.match(contextText(decision), /<slack_reply>/);
  assert.deepEqual(h.posts, []);
  assert.deepEqual(h.externalChecks, ["U0GUEST"]);
});

test("the sender check reads July's cached users.info answer and makes no Slack call of its own", { timeout: 2000 }, async () => {
  const check = julyClassifiedSender({ waitMs: 1000, stepMs: 5 });
  for (const [userTeam, external] of [[TEAM_ID, false], ["T0OTHER", true]] as const) {
    resetExternalSenderCache();
    const julyCalls: string[] = [];
    const july = isExternalSlackSender({
      botToken: {
        kind: "api-transport",
        label: "july",
        call: async (method: string) => {
          julyCalls.push(method);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { ok: true, user: { team_id: userTeam } };
        },
      },
      slackTeamId: TEAM_ID,
      userId: "U0ALICE",
    });
    assert.equal(await check(mention(`fix ${PR}`)), external);
    assert.equal(await july, external);
    assert.deepEqual(julyCalls, ["users.info"]);
  }
});

test("a sender July never classified counts as external once the wait runs out", { timeout: 2000 }, async () => {
  resetExternalSenderCache();
  let clock = 0;
  let reads = 0;
  let sleeps = 0;
  // Both fakes throw past their budget, so a loop that ignores either one
  // stops within the test timeout instead of polling on.
  const check = julyClassifiedSender({
    waitMs: 500,
    stepMs: 5,
    now: () => {
      reads += 1;
      if (reads > 150) throw new Error("the sender check did not use the injected sleep");
      return clock;
    },
    sleep: async (ms) => {
      sleeps += 1;
      if (sleeps > 150) throw new Error("the sender check did not stop at its deadline");
      clock += ms;
    },
  });
  assert.equal(await check(mention(`fix ${PR}`)), true);
  assert.equal(clock, 500);
  assert.equal(sleeps, 100);
});

test("every sender check, polls and checkers alike, hands July the one probe object", async () => {
  const tokens = new Set<unknown>();
  let misses = 3;
  const classify: typeof isExternalSlackSender = async (args) => {
    tokens.add(args.botToken);
    if (misses > 0) {
      misses -= 1;
      await (args.botToken as SlackApiTransport).call("users.info", { user: args.userId }).catch(() => undefined);
      return true;
    }
    return false;
  };
  const sleep = async () => {};
  const first = julyClassifiedSender({ stepMs: 1, sleep, classify });
  const second = julyClassifiedSender({ stepMs: 1, sleep, classify });
  assert.equal(await first(mention(`fix ${PR}`)), false, "three misses, then July's answer");
  assert.equal(await first(mention(`fix ${PR}`, { userId: "U0BOB", isBot: false })), false);
  assert.equal(await second(mention(`fix ${PR}`)), false);
  assert.equal(await slackConnectSender(mention(`fix ${PR}`, { userId: "", isBot: false })), true);
  assert.equal(tokens.size, 1);
  assert.ok(tokens.has(JULY_CACHE_PROBE));
});

test("two checks of one sender while July's lookup is in flight both wait for July's answer", { timeout: 2000 }, async () => {
  for (const [userTeam, external] of [[TEAM_ID, false], ["T0OTHER", true]] as const) {
    resetExternalSenderCache();
    const check = julyClassifiedSender({ waitMs: 1000, stepMs: 5 });
    const early = [check(mention(`fix ${PR}`)), check(mention(`fix ${PR}`))];
    const july = isExternalSlackSender({
      botToken: {
        kind: "api-transport",
        label: "july",
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { ok: true, user: { team_id: userTeam } };
        },
      },
      slackTeamId: TEAM_ID,
      userId: "U0ALICE",
    });
    assert.deepEqual(await Promise.all([...early, check(mention(`fix ${PR}`))]), [external, external, external], userTeam);
    assert.equal(await july, external);
  }
});

test("a bot author never gets the canned post, and no author posts nothing and starts nothing", async () => {
  const bot = harness();
  assert.deepEqual(await bot.handler(bot.ctx, mention(`fix ${PR}`, { userId: "", botId: "B0DESK", isBot: true })), MODEL_TURN);
  assert.deepEqual(bot.posts, []);

  const anonymous = harness();
  assert.equal(await anonymous.handler(anonymous.ctx, mention("fix acme/widgets#12", null)), null);
  assert.deepEqual(anonymous.posts, []);
  assert.deepEqual(anonymous.fallbackCalls, []);
});

test("a plain `deny` in a ticket's thread is tagged for deny_ticket with that ticket's key, like `deny KEY`", async () => {
  const h = harness();
  const kv: Record<string, unknown> = { "thread-tickets/C0123ABCD:1758510000.123456": ["TLSSN-44"], "ticket/TLSSN-44": { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE" } };
  (h.ctx as { host: unknown }).host = { kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] } };
  for (const raw of ["deny", "Deny.", "*deny*"]) {
    const tagged = contextText(await h.handler(h.ctx, mention(raw)));
    assert.match(tagged, /Call deny_ticket once with issueKey TLSSN-44\./, raw);
    assert.match(tagged, /`deny TLSSN-44`/, raw);
  }
  const keyed = contextText(await h.handler(h.ctx, mention("deny TLSSN-44")));
  assert.match(keyed, /Call deny_ticket once with issueKey TLSSN-44\./, "the keyed form still works");
});

test("a plain `deny` in a thread with no ticket or several asks which ticket, and never guesses or names @factory", async () => {
  const two = { "thread-tickets/C0123ABCD:1758510000.123456": ["TLSSN-44", "TLSSN-45"], "ticket/TLSSN-44": { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE" }, "ticket/TLSSN-45": { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE" } };
  for (const kv of [{}, two] as Record<string, unknown>[]) {
    const h = harness();
    (h.ctx as { host: unknown }).host = { kv: { get: async (key: string) => kv[key], put: async (key: string, value: unknown) => void (kv[key] = value), delete: async (key: string) => void delete kv[key] } };
    const tagged = contextText(await h.handler(h.ctx, mention("deny")));
    assert.match(tagged, /not tied to exactly one ticket/);
    assert.match(tagged, /ask which ticket to deny/);
    assert.doesNotMatch(tagged, /Call deny_ticket/);
    assert.doesNotMatch(tagged, /@factory deny/);
  }
});

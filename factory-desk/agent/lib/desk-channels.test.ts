import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import type { SlackMessageHandler } from "@cursor/july/channels/slack";
import { getSlackChannelOptions } from "@cursor/july/channels/slack";
import slack, { DESK_CHANNEL_POSTS, stagingChannelGuard } from "../channels/slack.js";
import { reviewRepos } from "./config.js";
import { bareReplyReaches, intakeChannel, replyPrefix, WATCHED_CHANNELS, watchedChannels } from "./desk-channels.js";
import { ticketPost } from "./ticket-thread.js";

const STAGING = { FACTORY_ENV: "staging", FACTORY_DESK_INTAKE_CHANNEL: "C0STAGING1" };
const emptyKv = { get: async () => undefined } as unknown as HostKvApi;
const savedEnv = process.env.FACTORY_ENV;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.FACTORY_ENV;
  else process.env.FACTORY_ENV = savedEnv;
});

test("production watches the production intake and posts intake roots there, as before", () => {
  const env = { FACTORY_DESK_INTAKE_CHANNEL: "C0EXAMPLE1" };
  assert.deepEqual(watchedChannels(env), [...WATCHED_CHANNELS]);
  assert.equal(intakeChannel(env), "C0EXAMPLE1");
  assert.equal(bareReplyReaches("C0EXAMPLE1", env), true);
  assert.equal(bareReplyReaches("C0OTHER01", { FACTORY_DESK_INTAKE_CHANNEL: "C0OTHER01" }), true, "production still counts its intake channel");
});

test("the manifest's watch list is the same on every stage: hosted v2 builds it before secrets reach process.env", () => {
  process.env.FACTORY_ENV = "staging";
  assert.deepEqual(getSlackChannelOptions(slack)?.engagement?.channelPosts, DESK_CHANNEL_POSTS);
});

test("staging: no watched channel, and a plain reply in its own intake channel never arrives, so copy keeps the mention", () => {
  assert.deepEqual(watchedChannels(STAGING), []);
  assert.equal(bareReplyReaches("C0EXAMPLE1", STAGING), false);
  assert.equal(bareReplyReaches("C0STAGING1", STAGING), false);
  assert.equal(bareReplyReaches("D0DIRECT1", STAGING), true);
  assert.equal(replyPrefix("C0STAGING1", STAGING), "@factory ");
  assert.equal(replyPrefix("C0EXAMPLE1", STAGING), "@factory ");
});

test("staging posts intake roots in its own channel, never the production one unless allowed", async () => {
  assert.equal(intakeChannel(STAGING), "C0STAGING1");
  assert.deepEqual(await ticketPost(emptyKv, "TLSTG-1", STAGING), { target: { channel: "C0STAGING1", root: true } });
  for (const value of ["C0EXAMPLE1", "#mars-eng-intake", "mars-eng-intake"]) {
    const copied = { FACTORY_ENV: "staging", FACTORY_DESK_INTAKE_CHANNEL: value };
    assert.equal(intakeChannel(copied), undefined, value);
    assert.deepEqual(await ticketPost(emptyKv, "TLSTG-1", copied), {});
  }
  const allowed = { FACTORY_ENV: "staging", FACTORY_DESK_INTAKE_CHANNEL: "C0EXAMPLE1", FACTORY_STAGING_ALLOW_PRODUCTION: "C0EXAMPLE1" };
  assert.equal(intakeChannel(allowed), "C0EXAMPLE1");
  assert.deepEqual(watchedChannels(allowed), ["C0EXAMPLE1"]);
  assert.equal(bareReplyReaches("C0EXAMPLE1", allowed), true);
});

test("staging drops the production repository from the review-update scope", () => {
  const repos = "cursor-demo-lab/marsbank, cursor-demo-lab/marsbank-staging";
  assert.deepEqual(reviewRepos({ FACTORY_REPOS: repos }), ["cursor-demo-lab/marsbank", "cursor-demo-lab/marsbank-staging"]);
  assert.deepEqual(reviewRepos({ FACTORY_ENV: "staging", FACTORY_REPOS: repos }), ["cursor-demo-lab/marsbank-staging"]);
});

function guarded() {
  const seen: string[] = [];
  const inner: SlackMessageHandler = (_ctx, message) => {
    seen.push(message.channelId);
    return {} as never;
  };
  return { handler: stagingChannelGuard(inner), seen };
}

const message = (channelId: string) => ({ channelId, ts: "1.0", text: "hi" }) as never;

test("stagingChannelGuard: on staging a production channel reaches no handler; DMs and staging channels do; production passes all", async () => {
  const log = console.log;
  console.log = () => undefined;
  try {
    process.env.FACTORY_ENV = "staging";
    const staged = guarded();
    assert.equal(await staged.handler({} as never, message("C0EXAMPLE1")), null);
    assert.deepEqual(await staged.handler({} as never, message("C0STAGING1")), {});
    assert.deepEqual(await staged.handler({} as never, message("D0DIRECT1")), {});
    assert.deepEqual(staged.seen, ["C0STAGING1", "D0DIRECT1"]);

    delete process.env.FACTORY_ENV;
    const live = guarded();
    assert.deepEqual(await live.handler({} as never, message("C0EXAMPLE1")), {});
    assert.deepEqual(live.seen, ["C0EXAMPLE1"]);
  } finally {
    console.log = log;
  }
});

test("mentions, DMs, channel posts, and reactions all go through the staging guard", async () => {
  const options = getSlackChannelOptions(slack);
  const log = console.log;
  console.log = () => undefined;
  process.env.FACTORY_ENV = "staging";
  try {
    for (const name of ["onAppMention", "onDirectMessage", "onChannelPost", "onReactionAdded"] as const) {
      const handler = options?.[name] as SlackMessageHandler | undefined;
      assert.ok(handler, name);
      assert.equal(await handler({} as never, message("C0EXAMPLE1")), null, `${name} ignores the production intake on staging`);
    }
  } finally {
    console.log = log;
  }
});

test("staging: a ticket bound to a production channel posts nowhere; production keeps the binding", async () => {
  const bound = { get: async () => ({ channelId: "C0EXAMPLE1", threadTs: "1.0" }) } as unknown as HostKvApi;
  assert.deepEqual(await ticketPost(bound, "TLSTG-1", { FACTORY_ENV: "staging" }), {});
  assert.deepEqual(await ticketPost(bound, "TLSTG-1", STAGING), { target: { channel: "C0STAGING1", root: true } });
  const live = await ticketPost(bound, "TLSSN-1", {});
  assert.equal(live.target?.channel, "C0EXAMPLE1");
});

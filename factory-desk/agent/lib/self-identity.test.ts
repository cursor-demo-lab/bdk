import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resetSlackSelfIdentityCache, resetSlackUserInfoCache, resolveSlackSelfIdentity, type SlackApiTransport } from "@cursor/july/channels/slack";
import { deskSelfIdentity, deskSlackHandle } from "./config.js";
import { replyPrefix } from "./desk-channels.js";
import { learnDeskSelfIdentity, resetDeskSelfIdentity } from "./self-identity.js";

beforeEach(() => {
  resetDeskSelfIdentity();
});

function host(answer: (method: string) => Promise<Record<string, unknown>>) {
  const calls: string[] = [];
  return {
    calls,
    host: {
      slack: {
        getClient: async () => ({
          apiCall: async (method: string) => {
            calls.push(method);
            return answer(method);
          },
        }),
      },
    },
  };
}

/** Slack answers for a bot whose username is `factorybot` and whose profile names it something else. */
function slackBot(profile: Record<string, unknown>) {
  return async (method: string): Promise<Record<string, unknown>> =>
    method === "auth.test"
      ? { ok: true, user_id: "U0SELF", user: "factorybot" }
      : { ok: true, user: { id: "U0SELF", name: "factorybot", real_name: profile["real_name"], is_bot: true, profile } };
}

test("the bot's own handle from auth.test replaces the @factory default, asked once however many messages arrive", async () => {
  const h = host(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, user_id: "U0SELF", user: "factorybot" };
  });
  assert.equal(deskSlackHandle({}), "@factory", "the fallback before Slack answers");
  const answers = await Promise.all([learnDeskSelfIdentity(h.host), learnDeskSelfIdentity(h.host)]);
  assert.deepEqual(answers, [{ userId: "U0SELF", name: "factorybot" }, { userId: "U0SELF", name: "factorybot" }]);
  await learnDeskSelfIdentity(h.host);
  assert.deepEqual(h.calls, ["auth.test"]);
  assert.deepEqual(deskSelfIdentity(), { userId: "U0SELF", name: "factorybot" });
  assert.equal(deskSlackHandle({}), "@factorybot");
  assert.equal(deskSlackHandle({ FACTORY_DESK_SLACK_HANDLE: "factory" }), "@factory", "an explicit FACTORY_DESK_SLACK_HANDLE wins over Slack's username");
  assert.equal(replyPrefix("C0UNWATCHED", {}), "@factorybot ");
  assert.equal(replyPrefix("C0EXAMPLE1", {}), "", "a watched channel still takes plain commands");
});

test("a failed or nameless auth.test keeps FACTORY_DESK_SLACK_HANDLE, then @factory, and is asked again next time", async () => {
  let answer: Record<string, unknown> | Error = new Error("slack down");
  const h = host(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  assert.equal(await learnDeskSelfIdentity(h.host), undefined);
  assert.equal(deskSlackHandle({ FACTORY_DESK_SLACK_HANDLE: "factory-bot" }), "@factory-bot");
  assert.equal(deskSlackHandle({}), "@factory");

  answer = { ok: true, user_id: "U0SELF" };
  assert.deepEqual(await learnDeskSelfIdentity(h.host), { userId: "U0SELF" });
  assert.equal(deskSlackHandle({ FACTORY_DESK_SLACK_HANDLE: "factory-bot" }), "@factory-bot", "no name from Slack: the env still names the handle");
  assert.deepEqual(h.calls, ["auth.test", "auth.test"]);
});

test("a profile real_name or display name never changes the handle: it stays the auth.test username", async () => {
  for (const profile of [
    { display_name: "", real_name: "Factory Desk" },
    { display_name: "Factory", real_name: "Factory Desk" },
  ]) {
    resetDeskSelfIdentity();
    const h = host(slackBot(profile));
    assert.deepEqual(await learnDeskSelfIdentity(h.host), { userId: "U0SELF", name: "factorybot" }, JSON.stringify(profile));
    assert.deepEqual(h.calls, ["auth.test"], "no users.info: the profile is never read");
    assert.equal(deskSlackHandle({}), "@factorybot", JSON.stringify(profile));
    assert.equal(replyPrefix("C0UNWATCHED", {}), "@factorybot ", JSON.stringify(profile));
    assert.equal(deskSlackHandle({ FACTORY_DESK_SLACK_HANDLE: "factory" }), "@factory", "FACTORY_DESK_SLACK_HANDLE still wins");
  }
});

// Why the desk does not use July's resolver: since 0.2.12 it names the bot
// from the profile, so the same Slack answers would turn @factorybot into
// "Factory Desk" (no usable handle, so @factory) or "Factory". When this
// fails, July has changed how it names the bot.
test("July's own resolveSlackSelfIdentity names the bot from its profile, which is what the desk avoids", async () => {
  resetSlackSelfIdentityCache();
  resetSlackUserInfoCache();
  const answer = slackBot({ display_name: "", real_name: "Factory Desk" });
  const calls: string[] = [];
  const transport: SlackApiTransport = {
    kind: "api-transport",
    label: "july self identity",
    call: async (method) => {
      calls.push(method);
      return answer(method);
    },
  };
  assert.deepEqual(await resolveSlackSelfIdentity(transport), { userId: "U0SELF", name: "Factory Desk" });
  assert.deepEqual(calls, ["auth.test", "users.info"]);
});

test("a Slack name that is not one username token, or is factory-desk, never reaches copy", async () => {
  for (const user of ["factory-desk", "Factory-Desk", "Factory Desk", "factory\u00a0desk", "@factory", "fábrica", " ", "x".repeat(81)]) {
    resetDeskSelfIdentity();
    assert.deepEqual(await learnDeskSelfIdentity(host(async () => ({ ok: true, user_id: "U0SELF", user })).host), { userId: "U0SELF", name: user });
    assert.equal(deskSlackHandle({}), "@factory", JSON.stringify(user));
    assert.equal(replyPrefix("C0UNWATCHED", {}), "@factory ", JSON.stringify(user));
    assert.equal(deskSlackHandle({ FACTORY_DESK_SLACK_HANDLE: "factory-bot" }), "@factory-bot", JSON.stringify(user));
  }
});

test("no Slack client on the host asks nothing and keeps the fallback", async () => {
  assert.equal(await learnDeskSelfIdentity({}), undefined);
  assert.equal(await learnDeskSelfIdentity(undefined), undefined);
  assert.equal(deskSlackHandle({}), "@factory");
});

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SlackMessageHandler } from "@cursor/july/channels/slack";
import { reviewTask } from "../channels/github.js";
import jira from "../channels/jira.js";
import { stagingChannelGuard } from "../channels/slack.js";
import { resetSlackAppId, slackAppId, stagingRefusesSlackApp } from "./slack-app-guard.js";

// A staging desk holding a copy of the production bot token refuses every
// Slack event and Jira delivery; production never asks Slack which app it is.

const NAMES = ["FACTORY_ENV", "JIRA_WEBHOOK_SECRET", "FACTORY_STAGING_ALLOW_PRODUCTION", "FACTORY_REPOS", "FACTORY_DESK_SLACK_BOT_TOKEN"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  resetSlackAppId();
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

// The client holds a token bound to one app; `rebind` swaps both, as a
// changed hosted secret would without a restart.
function slackHost(app: { appId: string; token?: string }) {
  const calls: string[] = [];
  const bound = { appId: app.appId, token: app.token ?? `xoxb-${app.appId}` };
  const client = {
    get token() {
      return bound.token;
    },
    apiCall: async (method: string) => {
      calls.push(method);
      if (method === "auth.test") return { ok: true, bot_id: `B-${bound.appId}`, user_id: "U0BOT", team_id: "T0EXAMPLE1" };
      if (method === "bots.info") return { ok: true, bot: { app_id: bound.appId } };
      return { ok: false };
    },
  };
  const host = {
    slack: {
      getClient: async () => {
        calls.push("getClient");
        return client;
      },
    },
  };
  const rebind = (next: { appId: string; token: string }) => Object.assign(bound, next);
  return { host, calls, rebind };
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const error = console.error;
  const log = console.log;
  console.error = () => undefined;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.error = error;
    console.log = log;
  }
}

test("production never asks Slack which app the token is, and refuses nothing", async () => {
  const s = slackHost({ appId: "A0EXAMPLE1" });
  assert.equal(await stagingRefusesSlackApp(s.host, {}), false);
  assert.equal(await stagingRefusesSlackApp(s.host, { FACTORY_ENV: "prod" }), false);
  assert.deepEqual(s.calls, [], "not even getClient");
});

test("staging refuses the production app's token, asks once, and passes its own app", async () => {
  const prod = slackHost({ appId: "A0EXAMPLE1" });
  assert.equal(await quietly(() => stagingRefusesSlackApp(prod.host, { FACTORY_ENV: "staging" })), true);
  assert.equal(await quietly(() => stagingRefusesSlackApp(prod.host, { FACTORY_ENV: "staging" })), true);
  assert.deepEqual(prod.calls, ["getClient", "auth.test", "bots.info", "getClient"], "one lookup per token");
  resetSlackAppId();
  const own = slackHost({ appId: "A0STAGING1" });
  assert.equal(await stagingRefusesSlackApp(own.host, { FACTORY_ENV: "staging" }), false);
  assert.equal(await slackAppId(own.host), "A0STAGING1");
  resetSlackAppId();
  assert.equal(await stagingRefusesSlackApp(undefined, { FACTORY_ENV: "staging" }), false, "no Slack client: unknown, not refused");
});

test("a failed lookup is not cached: the next one asks again and a production app is then refused", async () => {
  const calls: string[] = [];
  let authTests = 0;
  const client = {
    token: "xoxb-flaky",
    apiCall: async (method: string) => {
      calls.push(method);
      if (method === "auth.test") {
        authTests += 1;
        if (authTests === 1) throw new Error("slack is having a moment");
        return { ok: true, bot_id: "B0PROD", user_id: "U0BOT", team_id: "T0EXAMPLE1" };
      }
      if (method === "bots.info") return { ok: true, bot: { app_id: "A0EXAMPLE1" } };
      return { ok: false };
    },
  };
  const host = { slack: { getClient: async () => client } };
  assert.equal(await quietly(() => stagingRefusesSlackApp(host, { FACTORY_ENV: "staging" })), false, "an unreadable app refuses nothing");
  assert.equal(await quietly(() => stagingRefusesSlackApp(host, { FACTORY_ENV: "staging" })), true);
  assert.deepEqual(calls, ["auth.test", "auth.test", "bots.info"]);
  assert.equal(await slackAppId(host), "A0EXAMPLE1", "the good answer is cached");
  assert.deepEqual(calls, ["auth.test", "auth.test", "bots.info"]);
});

test("a staging desk on the production app takes no Slack event and no Jira delivery", async () => {
  process.env.FACTORY_ENV = "staging";
  process.env.JIRA_WEBHOOK_SECRET = "s";
  const prod = slackHost({ appId: "A0EXAMPLE1" });
  let handled = 0;
  const inner: SlackMessageHandler = () => ((handled += 1), {} as never);
  const decision = await quietly(async () => stagingChannelGuard(inner)({ host: prod.host } as never, { channelId: "D0DIRECT1", ts: "1.0", text: "hi" } as never));
  assert.equal(decision, null);
  assert.equal(handled, 0);

  type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };
  const route = (jira as unknown as { routes: Route[] }).routes[0]!;
  const body = { webhookEvent: "jira:issue_updated", issue: { key: "TLSTG-1", fields: {} }, changelog: { id: "1", items: [] } };
  const response = await quietly(() =>
    route.handler(new Request("http://desk/v1/channels/jira/", { method: "POST", headers: { "x-factory-webhook-secret": "s", "content-type": "application/json" }, body: JSON.stringify(body) }), {
      body,
      host: { ...prod.host, kv: { get: async () => undefined, put: async () => undefined, delete: async () => undefined } },
      waitUntil: () => undefined,
    })
  );
  assert.deepEqual(await response.json(), { ok: true, ignored: true, reason: "staging_refuses_production" });
});

test("a changed bot token is looked up again: staging app first, then the production app is refused", async () => {
  const s = slackHost({ appId: "A0STAGING1", token: "xoxb-staging-token" });
  assert.equal(await stagingRefusesSlackApp(s.host, { FACTORY_ENV: "staging" }), false);
  assert.equal(await stagingRefusesSlackApp(s.host, { FACTORY_ENV: "staging" }), false);
  assert.deepEqual(s.calls.filter((call) => call !== "getClient"), ["auth.test", "bots.info"], "same token: cached");
  s.rebind({ appId: "A0EXAMPLE1", token: "xoxb-production-token" });
  const logged: string[] = [];
  const error = console.error;
  console.error = (line: string) => void logged.push(line);
  try {
    assert.equal(await stagingRefusesSlackApp(s.host, { FACTORY_ENV: "staging" }), true);
  } finally {
    console.error = error;
  }
  assert.deepEqual(s.calls.filter((call) => call !== "getClient"), ["auth.test", "bots.info", "auth.test", "bots.info"], "new token: asked again");
  assert.match(logged.join("\n"), /A0EXAMPLE1/);
  assert.doesNotMatch(logged.join("\n"), /xoxb-/, "the token is never logged");
});

test("the review-wake task on the production app reads no PR and touches no kv", async () => {
  process.env.FACTORY_ENV = "staging";
  process.env.FACTORY_REPOS = "cursor-demo-lab/marsbank-staging";
  const prod = slackHost({ appId: "A0EXAMPLE1" });
  const touched: string[] = [];
  const kv = { get: async (key: string) => void touched.push(`kv.get ${key}`), put: async (key: string) => void touched.push(`kv.put ${key}`), delete: async (key: string) => void touched.push(`kv.delete ${key}`) };
  const ctx = {
    repository: { fullName: "cursor-demo-lab/marsbank-staging", owner: "cursor-demo-lab", name: "marsbank-staging" },
    host: { ...prod.host, kv, mcp: { names: () => [], listTools: async () => [], callTool: async () => ({ content: [] }) } },
    github: {
      getOctokit: async () => {
        touched.push("octokit");
        return { request: async () => ({ data: {} }) };
      },
    },
  };
  const dispatch = reviewTask(ctx as never, [7], { kind: "pull_request", action: "opened" } as never);
  assert.ok(dispatch !== null && "task" in dispatch);
  await quietly(() => (dispatch as { task: () => Promise<void> }).task());
  assert.deepEqual(touched, []);
  assert.ok(prod.calls.includes("bots.info"), "the app was checked");
});

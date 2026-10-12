import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadAgentProject } from "@cursor/july";
import type { ChannelHandlerArgs } from "@cursor/july";
import {
  deriveGitHubWebhookEvents,
  dispatchGitHubWebhook,
  getGitHubChannelOptions,
} from "@cursor/july/channels/github";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SANDBOX = "cursor-demo-lab/marsbank";

// github.ts reads sandboxReposAtBoot() while this module loads. Set the
// sandbox so the channel declares a read-scoped cursorAccount.
process.env.FACTORY_SANDBOX_REPO = SANDBOX;
delete process.env.FACTORY_REPOS;

const channelReady = import("./github.js");

function pullRequestPayload(fullName: string) {
  const slash = fullName.indexOf("/");
  const owner = fullName.slice(0, slash);
  const repo = fullName.slice(slash + 1);
  return {
    action: "opened",
    repository: {
      full_name: fullName,
      name: repo,
      html_url: `https://github.com/${fullName}`,
      owner: { login: owner },
    },
    pull_request: {
      number: 7,
      html_url: `https://github.com/${fullName}/pull/7`,
      title: "Outside the factory",
      draft: false,
      merged: false,
      user: { login: "cursor[bot]" },
      head: { ref: "topic", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    },
  };
}

test("declares cursorAccount read for the sandbox, no webhook events, no replies", async () => {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) throw new Error("github channel options were not recorded");
  assert.equal(options.deliverReplies, false);
  assert.deepEqual(options.webhookEvents, []);
  assert.deepEqual(deriveGitHubWebhookEvents(options), []);
  const account = options.cursorAccount;
  if (typeof account !== "object") throw new Error("cursorAccount repos are not declared");
  assert.deepEqual([...account.repos], [SANDBOX]);
  assert.equal(account.permissions, "read");
});

test("a pull request delivery never starts a planning turn", async () => {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) throw new Error("github channel options were not recorded");
  const sends: string[] = [];
  const args = {
    params: {},
    requestIp: null,
    auth: null,
    host: {},
    artifacts: {},
    send: async (message: string) => {
      sends.push(message);
      throw new Error("send ran");
    },
    getSession: async () => null,
    receive: async () => {
      throw new Error("receive ran");
    },
    callTool: async () => {
      throw new Error("callTool ran");
    },
    waitUntil() {},
    sessionUrls: () => ({ playgroundUrl: "http://127.0.0.1/", traceUrl: "http://127.0.0.1/" }),
  } as unknown as ChannelHandlerArgs;
  const response = await dispatchGitHubWebhook({
    options,
    eventName: "pull_request",
    payload: pullRequestPayload(SANDBOX),
    args,
  });
  const body = (await response.json()) as { skipped?: boolean; reason?: string };
  assert.equal(body.skipped, true);
  assert.equal(body.reason, "not_dispatched");
  assert.deepEqual(sends, []);
});

test("hosted planner does not require FACTORY_GITHUB_TOKEN", async () => {
  const project = await loadAgentProject(ROOT);
  const secretNames = project.agent.hosting?.secretNames ?? [];
  assert.equal(secretNames.includes("FACTORY_GITHUB_TOKEN"), false);
  assert.ok(secretNames.includes("FACTORY_SANDBOX_REPO"), "secretNames did not load");
});

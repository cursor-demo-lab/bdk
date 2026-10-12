import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelHandlerArgs } from "@cursor/july";
import {
  deriveGitHubWebhookEvents,
  dispatchGitHubWebhook,
  getGitHubChannelOptions,
} from "@cursor/july/channels/github";

const IN_SCOPE = "acme/in-scope";
const OUT_OF_SCOPE = "other/out-of-scope";

// github.ts reads githubReposAtBoot() while the module loads. An unset
// list is an empty allowlist so a hosted freeze can start; the tests
// still set the variables so the channel declares the fixture repos.
process.env.FACTORY_REPOS = IN_SCOPE;
process.env.PR_AUTOFIXER_REPOS = IN_SCOPE;
process.env.SECURITY_REVIEWER_REPOS = IN_SCOPE;

const channelReady = import("./github.js");

function pullRequestPayload(fullName: string, action: string) {
  const slash = fullName.indexOf("/");
  const owner = fullName.slice(0, slash);
  const repo = fullName.slice(slash + 1);
  return {
    action,
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
      head: { ref: "topic", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    },
  };
}

function commentPayload(fullName: string, body: string, user: { login: string; type: string }) {
  const { repository } = pullRequestPayload(fullName, "created");
  return {
    action: "created",
    repository,
    issue: {
      number: 7,
      html_url: `https://github.com/${fullName}/pull/7`,
      pull_request: { url: `https://api.github.com/repos/${fullName}/pulls/7` },
    },
    comment: {
      id: 501,
      body,
      html_url: `https://github.com/${fullName}/pull/7#issuecomment-501`,
      user,
    },
  };
}

function trackingArgs(): { args: ChannelHandlerArgs; sends: string[] } {
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
    sessionUrls: () => ({
      playgroundUrl: "http://127.0.0.1/",
      traceUrl: "http://127.0.0.1/",
    }),
  } as unknown as ChannelHandlerArgs;
  return { args, sends };
}

test("declares contents-write, no reply delivery, and the hook event set", async () => {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) {
    throw new Error("github channel options were not recorded");
  }
  assert.equal(options.deliverReplies, false);
  assert.equal(options.botName, "factory-pr-autofixer");
  const account = options.cursorAccount;
  if (typeof account !== "object") {
    throw new Error("cursorAccount repos are not declared");
  }
  assert.deepEqual([...account.repos], [IN_SCOPE]);
  assert.equal(account.permissions, "contents-write");
  assert.equal(options.webhookEvents, undefined);
  assert.deepEqual(deriveGitHubWebhookEvents(options), [
    "pull_request",
    "issue_comment",
    "pull_request_review_comment",
    "check_suite",
    "check_run",
    "workflow_run",
    "status",
    "pull_request_review",
    "pull_request_review_thread",
  ]);
});

// The handler does not read cursorAccount.repos. Host admission does.
// With the channel runtime unset, wake returns null, so this delivery
// does not send. An in-scope synchronize would also not send here.
test("an out of scope pull request produces no send", async () => {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) {
    throw new Error("github channel options were not recorded");
  }
  const { args, sends } = trackingArgs();
  const response = await dispatchGitHubWebhook({
    options,
    eventName: "pull_request",
    payload: pullRequestPayload(OUT_OF_SCOPE, "synchronize"),
    args,
  });
  const body = (await response.json()) as { skipped?: boolean; reason?: string };
  assert.equal(body.skipped, true);
  assert.equal(body.reason, "not_dispatched");
  assert.deepEqual(sends, []);
});

// The fixer's own factory: drive is dropped before onComment runs, so it
// never re-claims its own PR. A person's comment reaches onComment, which
// returns null here only because the channel runtime is unset.
test("a factory: drive comment by the fixer's own bot is ignored before onComment", async () => {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) {
    throw new Error("github channel options were not recorded");
  }
  const own = trackingArgs();
  const ownResponse = await dispatchGitHubWebhook({
    options,
    eventName: "issue_comment",
    payload: commentPayload(IN_SCOPE, "factory: drive", { login: "factory-pr-autofixer[bot]", type: "Bot" }),
    args: own.args,
  });
  assert.deepEqual(await ownResponse.json(), { ok: true, skipped: true, reason: "ignored_comment" });
  assert.deepEqual(own.sends, []);

  const person = trackingArgs();
  const personResponse = await dispatchGitHubWebhook({
    options,
    eventName: "issue_comment",
    payload: commentPayload(IN_SCOPE, "factory: drive", { login: "alice", type: "User" }),
    args: person.args,
  });
  const body = (await personResponse.json()) as { skipped?: boolean; reason?: string };
  assert.equal(body.skipped, true);
  assert.equal(body.reason, "not_dispatched");
  assert.deepEqual(person.sends, []);
});

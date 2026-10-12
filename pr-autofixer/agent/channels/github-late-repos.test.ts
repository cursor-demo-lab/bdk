import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelHandlerArgs, HostKvApi } from "@cursor/july";
import { dispatchGitHubWebhook, getGitHubChannelOptions } from "@cursor/july/channels/github";

// A hosted freeze boots before its secrets exist (deployment-issues.md issue
// 8), so github.ts loads with an empty repo list and `cursorAccount: true`.
// FACTORY_REPOS is set once the installation is READY. Every delivery-time
// decision must read the list then, not the boot copy: before this test a
// person's `factory: drive` on such a boot was `out_of_scope` forever, with
// no log and no error, while the red-check path already read the live list.
// Own file: the boot state is module-level, so it needs its own process.

const REPO = "acme/late-scope";
delete process.env.FACTORY_REPOS;
delete process.env.PR_AUTOFIXER_REPOS;
process.env.FACTORY_JIRA_PROJECTS = "TLSSN";
delete process.env.PR_AUTOFIXER_AUTO_DRIVE_PROJECTS;

const channelReady = import("./github.js");

const repository = {
  full_name: REPO,
  name: "late-scope",
  html_url: `https://github.com/${REPO}`,
  owner: { login: "acme" },
};

const store = new Map<string, unknown>();
const kv: HostKvApi = {
  get: async (key) => store.get(key) as never,
  put: async (key, value) => { store.set(key, value); },
  delete: async (key) => { store.delete(key); },
};
type CapturedSend = { message: string; options: { cloud?: { repos?: Array<{ prUrl?: string }> } } };
const drives: CapturedSend[] = [];
const hostGithub = {
  getOctokit: async () => ({
    request: async (route: string, params: { pull_number: number }) => {
      if (route.includes("/comments/")) throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: { head: { ref: `TLSSN-${params.pull_number}-fix` }, title: "Fix", user: { login: "cursor[bot]" }, state: "open", merged: false } };
    },
  }),
};
const admissionRefusal = async () => {
  throw new Error("send() reached the local engine during hosted admission.");
};
function inertSession() {
  const unavailable = () => { throw new Error("deferred channel session"); };
  return { get id() { return unavailable(); }, get info() { return unavailable(); } };
}
const deliverySend = async (message: string, options: CapturedSend["options"] = {}) => {
  drives.push({ message, options });
  return inertSession();
};

let started: Promise<void> | undefined;

async function ready() {
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) throw new Error("github channel options were not recorded");
  started ??= Promise.resolve(
    options.onStart?.({ send: admissionRefusal, host: { github: hostGithub, kv }, callTool: admissionRefusal } as never)
  );
  await started;
  return options;
}

async function deliver(eventName: string, payload: unknown) {
  const options = await ready();
  const background: Promise<unknown>[] = [];
  const args = {
    params: {},
    requestIp: null,
    auth: null,
    host: { github: hostGithub, kv },
    artifacts: {},
    send: deliverySend,
    getSession: async () => null,
    receive: async () => { throw new Error("receive ran"); },
    callTool: admissionRefusal,
    waitUntil(promise: Promise<unknown>) { background.push(promise); },
    sessionUrls: () => ({ playgroundUrl: "http://127.0.0.1/", traceUrl: "http://127.0.0.1/" }),
  } as unknown as ChannelHandlerArgs;
  const response = await dispatchGitHubWebhook({ options, eventName, payload, args });
  await Promise.all(background);
  return (await response.json()) as { dispatched?: boolean; skipped?: boolean; reason?: string };
}

function driveCommentPayload(number: number) {
  return {
    action: "created",
    repository,
    issue: {
      number,
      html_url: `https://github.com/${REPO}/pull/${number}`,
      pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${number}` },
    },
    comment: {
      id: 700 + number,
      body: "factory: drive",
      html_url: `https://github.com/${REPO}/pull/${number}#issuecomment-${700 + number}`,
      user: { login: "simon", type: "User" },
      author_association: "COLLABORATOR",
    },
    sender: { login: "simon", type: "User" },
  };
}

function drivesFor(number: number) {
  return drives.filter((call) => call.options.cloud?.repos?.[0]?.prUrl === `https://github.com/${REPO}/pull/${number}`);
}

test("the channel booted without a repo list declares cursorAccount: true", async () => {
  const options = await ready();
  assert.equal(options.cursorAccount, true);
});

test("a person's factory: drive drives once FACTORY_REPOS is set after boot", async (t) => {
  process.env.FACTORY_REPOS = REPO;
  t.after(() => { delete process.env.FACTORY_REPOS; });
  const body = await deliver("issue_comment", driveCommentPayload(31));
  assert.equal(body.dispatched, true);
  assert.equal(drivesFor(31).length, 1);
  assert.match(drivesFor(31)[0]?.message ?? "", new RegExp(`https://github\\.com/${REPO}/pull/31`));
  assert.equal(store.has(`auto-drive:${REPO}#31`), true);
});

test("a person's factory: drive while FACTORY_REPOS is still unset fails loudly and names the variables", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  await assert.rejects(deliver("issue_comment", driveCommentPayload(32)), /acme\/late-scope#32 got a person's factory: drive, but acme\/late-scope is not in PR_AUTOFIXER_REPOS or FACTORY_REPOS \(\)/);
  assert.equal(drivesFor(32).length, 0);
  assert.equal(store.has(`auto-drive:${REPO}#32`), false);
  assert.equal(errors.mock.calls.length, 1);
});

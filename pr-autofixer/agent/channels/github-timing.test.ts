import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelHandlerArgs, HostKvApi } from "@cursor/july";
import { dispatchGitHubWebhook, getGitHubChannelOptions } from "@cursor/july/channels/github";
import { ADMISSION_PAUSE_CAP_MS, CLAIM_RETRY_MS, CLAIM_SETTLE_MS, START_RETRY_MS } from "../lib/auto-drive.js";

// One Bugbot delivery on an undriven factory PR, end to end through the
// channel, with every timer stubbed: the PR read (fetchPrHead), the claim
// with its settle, then the start task with its round record and mark. Each
// phase is pushed to its worst case, so the pauses asked for are the most a
// delivery can spend inside hosted admission. In its own file: the stub
// replaces the global setTimeout.

const REPO = "acme/in-scope";
process.env.FACTORY_REPOS = REPO;
process.env.FACTORY_JIRA_PROJECTS = "TLSSN";
delete process.env.PR_AUTOFIXER_REPOS;
delete process.env.PR_AUTOFIXER_AUTO_DRIVE_PROJECTS;
delete process.env.FACTORY_FIXER_CLAIM_SETTLE_MS;
delete process.env.FACTORY_KV_RETRY_PAUSES_MS;

const channelReady = import("./github.js");
const repository = { full_name: REPO, name: "in-scope", html_url: `https://github.com/${REPO}`, owner: { login: "acme" } };
const CLAIM_KEY = `auto-drive:${REPO}#60`;
const ROUNDS_KEY = `bugbot-rounds:${REPO}#60`;

const unavailable = () => Object.assign(new Error("kv 503"), { status: 503 });
const store = new Map<string, unknown>([[CLAIM_KEY, { at: "2026-09-21T00:00:00.000Z", token: "pre-lease" }]]);
// Claim reads that answer; every other one fails. Read 6 ends the first
// read's loop, 11 and 12 the clear of the pre-lease value, 19 and 20 the
// take, 21 the settle; from 22 on (the mark) the store is down.
const CLAIM_READS_ANSWERED = new Set([6, 11, 12, 19, 20, 21]);
let claimReads = 0;
const kv: HostKvApi = {
  get: async (key) => {
    if (key === CLAIM_KEY && !CLAIM_READS_ANSWERED.has(claimReads++)) throw unavailable();
    if (key === ROUNDS_KEY) throw unavailable();
    return store.get(key) as never;
  },
  put: async (key, value) => {
    if (key === ROUNDS_KEY) throw unavailable();
    store.set(key, value);
  },
  delete: async (key) => { store.delete(key); },
};

let prReadFailures = 2;
const hostGithub = {
  getOctokit: async () => ({
    request: async (route: string) => {
      if (route.includes("/check-suites/")) return { data: { check_runs: [{ name: "Cursor Bugbot", conclusion: "neutral" }] } };
      if (prReadFailures > 0) {
        prReadFailures -= 1;
        throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      }
      return { data: { head: { ref: "TLSSN-60-timing" }, title: "TLSSN-60: timing", state: "open", merged: false } };
    },
  }),
};

let sendFailures = 2;
const sends: string[] = [];
const deliverySend = async (message: string) => {
  if (sendFailures > 0) {
    sendFailures -= 1;
    throw new Error("send refused by the network");
  }
  sends.push(message);
  const deferred = () => { throw new Error("deferred channel session"); };
  return { get id() { return deferred(); }, get info() { return deferred(); } };
};

function bugbotSuite() {
  return {
    action: "completed",
    repository,
    check_suite: {
      id: 9060,
      head_sha: "6".repeat(40),
      status: "completed",
      conclusion: "neutral",
      app: { slug: "cursor", name: "Cursor" },
      pull_requests: [{ number: 60, url: `https://github.com/${REPO}/pull/60` }],
    },
    sender: { login: "cursor[bot]", type: "Bot", id: 1 },
  };
}

const sum = (values: readonly number[]) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

test("a Bugbot delivery at its worst pauses 14.5 s: PR read 1.25 s, claim 5.75 s (settle included), start task 7.5 s", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) throw new Error("github channel options were not recorded");
  const callTool = async () => { throw new Error("no tools in admission"); };
  await options.onStart?.({ send: deliverySend, host: { github: hostGithub, kv }, callTool } as never);

  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    setImmediate(handler);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
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
      callTool,
      waitUntil(promise: Promise<unknown>) { background.push(promise); },
      sessionUrls: () => ({ playgroundUrl: "http://127.0.0.1/", traceUrl: "http://127.0.0.1/" }),
    } as unknown as ChannelHandlerArgs;
    const response = await dispatchGitHubWebhook({ options, eventName: "check_suite", payload: bugbotSuite(), args });
    await Promise.all(background);
    assert.equal(((await response.json()) as { dispatched?: boolean }).dispatched, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.equal(sends.length, 1, "the third start went");
  const paused = delays.filter((ms) => ms > 0);
  assert.deepEqual(paused, [
    ...CLAIM_RETRY_MS, // the PR read: two 502s
    ...CLAIM_RETRY_MS, // the claim's first read
    ...CLAIM_RETRY_MS, // the clear of the pre-lease value
    ...CLAIM_RETRY_MS, // the take
    CLAIM_SETTLE_MS,
    ...START_RETRY_MS, // two sends that throw
    500, 2000, // the mark, with what the start left of TASK_PAUSE_BUDGET_MS; the round record inside the start adds none
  ]);
  assert.equal(sum(paused), 14_500);
  assert.ok(sum(paused) <= ADMISSION_PAUSE_CAP_MS);
});

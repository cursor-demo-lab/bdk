import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { getGitHubChannelOptions } from "@cursor/july/channels/github";
import { ADMISSION_PAUSE_CAP_MS, CLAIM_RETRY_MS, CLAIM_SETTLE_MS, START_RETRY_MS } from "../lib/auto-drive.js";

// The flush path's fresh Bugbot drive, end to end with every timer stubbed:
// a buffered Bugbot wake (restored from the snapshot) for a PR with no bound
// agent and no live claim reads the PR, claims it with its settle, and
// starts a drive on the runtime's send (startDrive's continuation
// generation read included), recording the round inside the start and then
// marking the claim. Each phase is at its worst, as in github-timing.test.ts.
// In its own file: the stub replaces the global setTimeout, and onStart
// restores the snapshot seeded here.

const REPO = "acme/in-scope";
process.env.FACTORY_REPOS = REPO;
process.env.FACTORY_JIRA_PROJECTS = "TLSSN";
delete process.env.PR_AUTOFIXER_REPOS;
delete process.env.PR_AUTOFIXER_AUTO_DRIVE_PROJECTS;
delete process.env.FACTORY_FIXER_CLAIM_SETTLE_MS;
delete process.env.FACTORY_KV_RETRY_PAUSES_MS;

const channelReady = import("./github.js");
const LABEL = `${REPO}#61`;
const CLAIM_KEY = `auto-drive:${LABEL}`;
const ROUNDS_KEY = `bugbot-rounds:${LABEL}`;
const GENERATION_KEY = "v1/pr-generation/acme/in-scope/61";
const HEAD = "7".repeat(40);

const unavailable = () => Object.assign(new Error("kv 503"), { status: 503 });
const store = new Map<string, unknown>([
  [CLAIM_KEY, { at: "2026-09-21T00:00:00.000Z", token: "pre-lease" }],
  [
    "webhook-buffer",
    {
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      entries: {
        [LABEL]: {
          latest: { eventName: "check_suite", conclusion: "neutral", app: "cursor", checkName: "Cursor Bugbot", checkSuiteId: 9061, headSha: HEAD, prUrl: `https://github.com/${REPO}/pull/61`, owner: "acme", repo: "in-scope", number: 61 },
          count: 1,
          deadlineMs: 0,
        },
      },
    },
  ],
]);
// Claim reads that answer; every other one fails. Read 0 is the wake's check
// for a held claim; then as in github-timing.test.ts, shifted by one: 7 ends
// the first read's loop, 12 and 13 the clear, 20 and 21 the take, 22 the
// settle; from 23 on (the mark) the store is down. The generation read fails
// every time, and so does every write of the head's round (the peek's empty
// record, written before the start, lands).
const CLAIM_READS_ANSWERED = new Set([0, 7, 12, 13, 20, 21, 22]);
let claimReads = 0;
const roundPuts: unknown[] = [];
let generationReads = 0;
const kv: HostKvApi = {
  get: async (key) => {
    if (key === CLAIM_KEY && !CLAIM_READS_ANSWERED.has(claimReads++)) throw unavailable();
    if (key === GENERATION_KEY) {
      generationReads += 1;
      throw unavailable();
    }
    return store.get(key) as never;
  },
  put: async (key, value) => {
    // The peek's empty record lands; every write of this head's round fails.
    if (key === ROUNDS_KEY && JSON.stringify(value).includes(HEAD)) {
      roundPuts.push(value);
      throw unavailable();
    }
    store.set(key, value);
  },
  delete: async (key) => { store.delete(key); },
};

let prReadFailures = 2;
const hostGithub = {
  getOctokit: async () => ({
    request: async () => {
      if (prReadFailures > 0) {
        prReadFailures -= 1;
        throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      }
      return { data: { head: { ref: "TLSSN-61-flush" }, title: "TLSSN-61: flush", state: "open", merged: false } };
    },
  }),
};

let sendFailures = 2;
const sends: Array<{ continuationToken?: string }> = [];
const send = async (_message: string, options: { continuationToken?: string } = {}) => {
  if (sendFailures > 0) {
    sendFailures -= 1;
    throw new Error("send refused by the network");
  }
  sends.push(options);
  return { id: "ses_fresh_61", info: { sdkAgentId: "" } };
};

const sum = (values: readonly number[]) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

test("a fresh Bugbot drive from the flush pauses 14.5 s at worst: the generation read and round record inside the start add none, and the round is recorded", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => { logs.push(String(line)); });
  const { default: channel } = await channelReady;
  const options = getGitHubChannelOptions(channel);
  if (options === undefined) throw new Error("github channel options were not recorded");

  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realImmediate = globalThis.setImmediate;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    realImmediate(handler);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    const callTool = async () => { throw new Error("no tools"); };
    await options.onStart?.({ send, host: { github: hostGithub, kv }, callTool } as never);
    const done = () => logs.some((line) => line.includes('"bugbot_wake"') && line.includes(LABEL));
    for (let turns = 0; !done() && turns < 100_000; turns += 1) await new Promise((resolve) => realImmediate(resolve));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.ok(logs.some((line) => line.includes('"fresh_drive"') && line.includes(LABEL)), "the fresh drive started");
  assert.equal(sends.length, 1, "the third start went");
  assert.equal(sends[0]?.continuationToken, `pr:${LABEL}`, "an unread generation falls back to the plain key");
  assert.equal(generationReads, 9, "three starts, three back-to-back reads each");
  assert.deepEqual(roundPuts.map((put) => (put as { shas?: string[] }).shas), [[HEAD], [HEAD], [HEAD]], "the round for this head was recorded (three back-to-back tries)");
  const paused = delays.filter((ms) => ms > 0);
  assert.deepEqual(paused, [
    ...CLAIM_RETRY_MS, // the PR read: two 502s
    ...CLAIM_RETRY_MS, // the claim's first read
    ...CLAIM_RETRY_MS, // the clear of the pre-lease value
    ...CLAIM_RETRY_MS, // the take
    CLAIM_SETTLE_MS,
    ...START_RETRY_MS, // two sends that throw
    500, 2000, // the mark, with what the start left of TASK_PAUSE_BUDGET_MS
  ]);
  assert.equal(sum(paused), 14_500);
  assert.ok(sum(paused) <= ADMISSION_PAUSE_CAP_MS);
  await options.onStop?.();
});

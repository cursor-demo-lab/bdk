import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { prepareDiff } from "../lib/diff-evidence.js";
import { priorReview, reviewedRecord } from "../lib/reviewed-head.js";
import tool from "./post_findings.js";

const SHA = "AbCdEf".padEnd(40, "0");
const BASE = "BbBb".padEnd(40, "1");

/** The head a delivery with this PR's base and head would skip, or undefined. */
async function reviewedHead(kv: HostKvApi, maxChars?: number): Promise<string | undefined> {
  return (await priorReview({ kv, identity: { fullName: "acme/repo", number: 4, base: BASE, headSha: SHA }, maxChars }))?.headSha;
}

function memoryKv(): HostKvApi {
  const store = new Map<string, unknown>();
  return {
    get: async (key) => store.get(key) as never,
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
  };
}

type ExecuteTool = { execute: (input: { findings: unknown[] }, ctx: never) => Promise<unknown> };

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n+const q = input;\n";

// Files the channel writes; `undefined` leaves a file out.
type Evidence = { "pr/head.sha"?: string; "pr/diff.patch"?: string; "pr/diff.json"?: string };

function evidence(diff = DIFF, max?: number): Evidence {
  const { patch, meta } = prepareDiff({ diff, base: BASE, headSha: SHA, max });
  return { "pr/head.sha": SHA, "pr/diff.patch": patch, "pr/diff.json": JSON.stringify(meta) };
}

async function run(
  kv: HostKvApi,
  createReview: (params?: unknown) => Promise<unknown>,
  findings: unknown[] = [],
  files: Evidence = evidence(),
  purpose = "run"
) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "post-findings-"));
  await mkdir(join(workspaceDir, "pr"));
  for (const [name, content] of Object.entries(files)) {
    if (content !== undefined) await writeFile(join(workspaceDir, name), content);
  }
  return (tool as unknown as ExecuteTool).execute({ findings }, {
    session: { purpose, continuationKey: "cont:github-pr:Acme/Repo#4" },
    workspaceDir,
    host: { kv, github: { getOctokit: async () => ({ rest: { pulls: { createReview } } }) } },
  } as never);
}

test("a posted review records its head for the PR", async () => {
  const kv = memoryKv();
  const result = await run(kv, async () => ({ data: { html_url: "https://github.com/r" } }));
  assert.equal((result as { posted?: boolean }).posted, true);
  assert.equal(await reviewedHead(kv), SHA.toLowerCase());
  const { at, ...record } = (await kv.get("reviewed/acme/repo#4")) as { at?: string };
  assert.equal(typeof at, "string");
  assert.deepEqual(record, { base: BASE.toLowerCase(), headSha: SHA.toLowerCase() });
});

test("a CLEAN review names its head and scope below the verdict, in the shape the e2e checker reads", async () => {
  const posted: { body?: string }[] = [];
  await run(memoryKv(), async (params?: unknown) => {
    posted.push(params as { body?: string });
    return { data: { html_url: "https://github.com/r" } };
  });
  const body = String(posted[0]?.body);
  // scripts/e2e-lib.mjs REVIEWER_BODY
  assert.match(body, /^## Security review\n\n\*\*Verdict:\*\* (CLEAN|FINDINGS)(?:\n|$)/);
  assert.equal(body.split("\n")[3], "Security only, on head `abcdef0`; Bugbot covers correctness. A new push gets a new review.");
});

test("a review GitHub refuses records nothing", async () => {
  const kv = memoryKv();
  await assert.rejects(run(kv, async () => { throw new Error("422"); }), /422/);
  assert.equal(await reviewedHead(kv), undefined);
});

test("a store that cannot write does not fail a posted review, and says it was not recorded", async () => {
  const kv = { ...memoryKv(), put: async () => { throw new Error("kv down"); } };
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { lines.push(String(line)); };
  let result: unknown;
  try {
    result = await run(kv, async () => ({ data: { html_url: "https://github.com/r" } }));
  } finally {
    console.log = log;
  }
  assert.deepEqual(result, { posted: true, pr: "Acme/Repo#4", url: "https://github.com/r", verdict: "CLEAN", recorded: false });
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as { recorded?: boolean }).recorded), [false]);
  assert.equal(await reviewedHead(kv), undefined);
});

test("the review is an advisory COMMENT at the head in pr/head.sha, never an approval or change request", async () => {
  const kv = memoryKv();
  const posted: unknown[] = [];
  await run(kv, async (params?: unknown) => {
    posted.push(params);
    return { data: { html_url: "https://github.com/r" } };
  }, [{ severity: "high", file: "src/a.ts", line: 3, title: "SQL injection", detail: "user input reaches the query" }]);
  assert.deepEqual(posted, [
    {
      owner: "Acme",
      repo: "Repo",
      pull_number: 4,
      commit_id: SHA,
      event: "COMMENT",
      body: `## Security review\n\n**Verdict:** FINDINGS\nSecurity only, on head \`${SHA.slice(0, 7).toLowerCase()}\`; Bugbot covers correctness. A new push gets a new review.\n- **high** \`src/a.ts:3\` — SQL injection\n  user input reaches the query`,
    },
  ]);
});

async function refuses(files: Evidence, message: RegExp) {
  const kv = memoryKv();
  const posted: unknown[] = [];
  await assert.rejects(run(kv, async (p?: unknown) => { posted.push(p); return { data: {} }; }, [], files), message);
  assert.deepEqual(posted, []);
  assert.equal(await reviewedHead(kv), undefined);
}

test("without a valid pr/head.sha nothing is posted or recorded", async () => {
  await refuses({ ...evidence(), "pr/head.sha": "main" }, /missing pr\/head\.sha/);
  await refuses({ ...evidence(), "pr/head.sha": undefined }, /missing pr\/head\.sha/);
});

test("without pr/diff.patch, or with a patch pr/diff.json does not vouch for, nothing is posted or recorded", async () => {
  await refuses({ ...evidence(), "pr/diff.patch": undefined }, /missing pr\/diff\.patch/);
  await refuses({ ...evidence(), "pr/diff.patch": "" }, /not the patch/);
  await refuses({ "pr/head.sha": SHA, "pr/diff.patch": "" }, /missing pr\/diff\.json/);
  await refuses({ ...evidence(), "pr/diff.json": "{" }, /not JSON/);
  await refuses({ ...evidence(), "pr/diff.json": "{}" }, /malformed/);
  const meta = JSON.parse(evidence()["pr/diff.json"]!) as Record<string, unknown>;
  for (const base of [undefined, "", 5]) {
    await refuses({ ...evidence(), "pr/diff.json": JSON.stringify({ ...meta, base }) }, /malformed/);
  }
  await refuses({ ...evidence(), "pr/diff.patch": `${DIFF}+more\n` }, /not the patch/);
  const other = prepareDiff({ diff: DIFF, base: BASE, headSha: "f".repeat(40) }).meta;
  await refuses({ ...evidence(), "pr/diff.json": JSON.stringify(other) }, /different head/);
  const truncated = evidence(DIFF + DIFF, 40);
  const claimsWhole = { ...(JSON.parse(truncated["pr/diff.json"]!) as object), truncated: false, cutFiles: [] };
  await refuses({ ...truncated, "pr/diff.json": JSON.stringify(claimsWhole) }, /whole diff/);
  const whole = JSON.parse(evidence()["pr/diff.json"]!) as { totalChars: number };
  await refuses({ ...evidence(), "pr/diff.json": JSON.stringify({ ...whole, truncated: true, cutFiles: ["src/a.ts"] }) }, /truncation/);
});

test("an empty patch that pr/diff.json verifies as a zero-file compare posts CLEAN and records", async () => {
  const kv = memoryKv();
  const result = await run(kv, async () => ({ data: { html_url: "https://github.com/r" } }), [], evidence(""));
  assert.deepEqual(result, { posted: true, pr: "Acme/Repo#4", url: "https://github.com/r", verdict: "CLEAN", recorded: true });
  assert.equal(await reviewedHead(kv), SHA.toLowerCase());
});

test("a truncated diff posts an INCOMPLETE review that says what was cut, and records the head as incomplete", async () => {
  const kv = memoryKv();
  const posted: { body?: string; commit_id?: string; event?: string }[] = [];
  const files = evidence(DIFF + "diff --git a/b.lock b/b.lock\n+x\n", 40);
  const result = await run(kv, async (params?: unknown) => {
    posted.push(params as { body?: string });
    return { data: { html_url: "https://github.com/r" } };
  }, [{ severity: "low", file: "src/a.ts", line: 2, title: "Unchecked input", detail: "input is used as is" }], files);
  assert.deepEqual(result, { posted: true, pr: "Acme/Repo#4", url: "https://github.com/r", verdict: "INCOMPLETE", recorded: true });
  assert.equal(posted[0]?.commit_id, SHA);
  assert.equal(posted[0]?.event, "COMMENT");
  assert.equal(
    posted[0]?.body,
    `## Security review\n\n**Verdict:** INCOMPLETE\nSecurity only, on head \`${SHA.slice(0, 7).toLowerCase()}\`; Bugbot covers correctness. A new push gets a new review.\n\nPartial review: diff truncated at 40 of 83 chars.\nNot fully reviewed: \`src/a.ts\`, \`b.lock\`\n\n- **low** \`src/a.ts:2\` — Unchecked input\n  input is used as is`
  );
  assert.deepEqual(await reviewedRecord(kv, "acme/repo", 4), { base: BASE.toLowerCase(), headSha: SHA.toLowerCase(), complete: false, totalChars: 83 });
  assert.equal(await reviewedHead(kv, 40), SHA.toLowerCase());
});

test("an eval session posts nothing and records nothing", async () => {
  const kv = memoryKv();
  const posted: unknown[] = [];
  const result = await run(
    kv,
    async (params?: unknown) => { posted.push(params); return { data: { html_url: "https://github.com/r" } }; },
    [{ severity: "high", file: "src/a.ts", line: 3, title: "XSS", detail: "query reflected" }],
    evidence(),
    "eval"
  );
  assert.deepEqual(result, { posted: false, reason: "eval" });
  assert.deepEqual(posted, []);
  assert.equal(await kv.get("reviewed/acme/repo#4"), undefined);
});

test("each posted review is a review-posted log line", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { lines.push(String(line)); };
  try {
    await run(memoryKv(), async () => ({ data: { html_url: "https://github.com/r" } }));
    await run(memoryKv(), async () => ({ data: { html_url: "https://github.com/r" } }), [], evidence(DIFF + DIFF, 40));
  } finally {
    console.log = log;
  }
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { factoryDebug: "review-posted", repo: "Acme/Repo", number: 4, base: BASE, headSha: SHA.toLowerCase(), verdict: "CLEAN", recorded: true },
    { factoryDebug: "review-posted", repo: "Acme/Repo", number: 4, base: BASE, headSha: SHA.toLowerCase(), verdict: "INCOMPLETE", recorded: true },
  ]);
});

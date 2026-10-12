import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostContext } from "@cursor/july";
import { continuationTokenFor, parsePrRef, prRefFromContinuationToken } from "./drive.js";
import { bumpPrGeneration } from "./pr-generation.js";
import { startDrive } from "./start-drive.js";

// A host that refuses to be touched. A refusal on scope has to happen before
// any GitHub read or session send.
function untouchableHost(): HostContext {
  return new Proxy({} as HostContext, {
    get(_target, property) {
      throw new Error(`host.${String(property)} was touched`);
    },
  });
}

test("a pull request outside the repository scope, or on a lookalike that only shares a configured name as a prefix, is refused before any read", async () => {
  const cases = [
    ["someone-else/private-app", ["example/sandbox", "example/other"], "Configured: example/sandbox, example/other."],
    ["example/sandbox-evil", ["example/sandbox"], "Configured: example/sandbox."],
    ["example/sandbox.github.io", ["example/sandbox"], "Configured: example/sandbox."],
  ] as const;
  for (const [repo, repos, configured] of cases) {
    const result = await startDrive({
      pr: `https://github.com/${repo}/pull/9`,
      repos: [...repos],
      send: async () => { throw new Error("send was called"); },
      host: untouchableHost(),
    });
    assert.deepEqual(result, { ok: false, code: "out_of_scope", error: `${repo} is not a repository this factory drives. ${configured}` });
  }
});

test("scope is matched case-insensitively, the way GitHub names repositories", async () => {
  // Past the gate the first thing the drive does is read the PR state from GitHub, which this host refuses.
  await assert.rejects(
    startDrive({
      pr: "https://github.com/Example/Sandbox/pull/9",
      repos: ["example/sandbox"],
      send: async () => { throw new Error("send was called"); },
      host: untouchableHost(),
    }),
    /host\.github was touched/
  );
});

test("a bad reference is still answered before scope", async () => {
  const result = await startDrive({
    pr: "not a pull request",
    repos: ["example/sandbox"],
    send: async () => { throw new Error("send was called"); },
    host: untouchableHost(),
  });
  assert.deepEqual(result, { ok: false, code: "unrecognized_pr", error: "Unrecognized PR reference: not a pull request" });
});

function openPrHost(created: Array<{ channelId: string; continuationToken: string }>): HostContext {
  const store = new Map<string, unknown>();
  return {
    github: {
      getOctokit: async () => ({ request: async () => ({ data: { state: "open", merged: false, merged_at: null } }) }),
    },
    kv: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    },
    reminders: {
      list: async () => [],
      cancel: async () => undefined,
      create: async (input: { channelId: string; continuationToken: string }) => {
        created.push({ channelId: input.channelId, continuationToken: input.continuationToken });
        return { id: `rem_${created.length}` };
      },
    },
  } as unknown as HostContext;
}

function deferredSession() {
  const unavailable = () => { throw new Error("ChannelSession.info is not available"); };
  return { get id() { return unavailable(); }, get info() { return unavailable(); } };
}

test("a drive started through a delivery's send arms no merge watch and reports no drive-channel token", async () => {
  const created: Array<{ channelId: string; continuationToken: string }> = [];
  const result = await startDrive({
    pr: "https://github.com/example/sandbox/pull/8",
    repos: ["example/sandbox"],
    send: async () => deferredSession() as never,
    host: openPrHost(created),
    deliverySend: true,
  });
  assert.equal(result.ok && result.status, "started");
  assert.equal(result.ok ? result.continuationToken : "refused", null);
  assert.equal(result.ok ? result.mergeConflictReminderId : "refused", null);
  assert.deepEqual(created, []);
});

test("a drive started on the drive channel arms the merge watch at its pr: token", async () => {
  const created: Array<{ channelId: string; continuationToken: string }> = [];
  const result = await startDrive({
    pr: "https://github.com/example/sandbox/pull/8",
    repos: ["example/sandbox"],
    send: async () => ({ id: "ses_1", info: { sdkAgentId: "bc-1" } }) as never,
    host: openPrHost(created),
  });
  assert.equal(result.ok ? result.continuationToken : "refused", "pr:example/sandbox#8");
  assert.equal(result.ok ? result.mergeConflictReminderId : "refused", "rem_1");
  assert.deepEqual(created, [{ channelId: "drive", continuationToken: "pr:example/sandbox#8" }]);
});

// July resumes the session a continuation key names. A PR closed and reopened
// must not resume its drive session from before the close, so each close
// bumps the PR's generation and the drive channel's key carries it.
test("after a close, the drive channel sends, and arms its watch, at the next generation's pr: token", async () => {
  const created: Array<{ channelId: string; continuationToken: string }> = [];
  const host = openPrHost(created);
  const pr = parsePrRef("example/sandbox#8")!;
  await bumpPrGeneration(host.kv, { pr });
  await bumpPrGeneration(host.kv, { pr });
  const sent: Array<string | undefined> = [];
  const result = await startDrive({
    pr: "https://github.com/example/sandbox/pull/8",
    repos: ["example/sandbox"],
    send: async (_message, options) => {
      sent.push(options?.continuationToken);
      return { id: "ses_2", info: { sdkAgentId: "bc-2" } } as never;
    },
    host,
  });
  assert.deepEqual(sent, ["pr:example/sandbox#8@g2"]);
  assert.equal(result.ok ? result.continuationToken : "refused", "pr:example/sandbox#8@g2");
  assert.deepEqual(created, [{ channelId: "drive", continuationToken: "pr:example/sandbox#8@g2" }]);
});

test("a generation that cannot be read falls back to the plain pr: token, with one log line, and the drive still goes", async (t) => {
  const warned = t.mock.method(console, "warn", () => {});
  const created: Array<{ channelId: string; continuationToken: string }> = [];
  const host = openPrHost(created);
  const kv = host.kv;
  const refusing = { ...kv, get: async (key: string) => { if (key.startsWith("v1/pr-generation/")) throw Object.assign(new Error("kv 503"), { status: 503 }); return kv.get(key as never); } };
  const result = await startDrive({
    pr: "https://github.com/example/sandbox/pull/8",
    repos: ["example/sandbox"],
    send: async () => ({ id: "ses_3", info: { sdkAgentId: "bc-3" } }) as never,
    host: { ...host, kv: refusing } as unknown as HostContext,
  });
  assert.equal(result.ok ? result.continuationToken : "refused", "pr:example/sandbox#8");
  assert.equal(warned.mock.calls.filter((call) => String(call.arguments[0]).includes('"unread_generation_0"')).length, 1);
});

test("continuation keys: generation 0 is the key as it always was; later ones carry @g<n> and still name the PR", () => {
  const pr = parsePrRef("Example/Sandbox#8")!;
  assert.equal(continuationTokenFor(pr), "pr:Example/Sandbox#8");
  assert.equal(continuationTokenFor(pr, 3), "pr:Example/Sandbox#8@g3");
  for (const token of ["pr:Example/Sandbox#8", "pr:Example/Sandbox#8@g3"]) assert.equal(prRefFromContinuationToken(token)?.label, pr.label, token);
  assert.equal(prRefFromContinuationToken("evt:abc"), undefined);
});

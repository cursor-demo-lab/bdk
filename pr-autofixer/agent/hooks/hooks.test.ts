import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { readdirSync } from "node:fs";

// Every authored hook sees every event, as the host dispatches them.
type Handler = (event: { data: Record<string, unknown> }, ctx: unknown) => Promise<void>;
const hooks = await Promise.all(
  readdirSync(new URL(".", import.meta.url))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(async (file) => (await import(`./${file.replace(/\.ts$/, ".js")}`)).default as { events: Record<string, Handler | undefined> })
);
async function emit(type: string, data: Record<string, unknown>, context: unknown): Promise<void> {
  for (const hook of hooks) {
    await hook.events[type]?.({ data }, context);
  }
}

// Drive leases (lib/claim-lease.ts) a started drive holds, one owner token per PR.
const STARTED = { state: "pending", at: "2026-09-23T00:00:00.000Z", started: true };

function claims() {
  const store = new Map<string, unknown>([
    ["auto-drive:acme/in-scope#3", { ...STARTED, owner: "tok3" }],
    ["auto-drive:acme/in-scope#4", { ...STARTED, owner: "tok4" }],
  ]);
  const kv: HostKvApi = {
    get: async (key) => store.get(key) as never,
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
  };
  return { store, kv };
}

function ctx(kv: HostKvApi, sessionId: string, title: string | undefined, channelId = "github", continuationToken: string | null = "evt:0123abcd") {
  return { channel: { id: channelId, continuationToken }, session: { id: sessionId, channelId, title }, host: { kv } };
}

const claimed = (store: Map<string, unknown>) => [...store.keys()].filter((key) => key.startsWith("auto-drive:")).sort();
const HARNESS_SUMMARY = "Fix failing CI on TLSSN-3";

test("a drive that fails after the harness rewrote its title releases its own PR's claim", async () => {
  const { store, kv } = claims();
  await emit("turn.started", {}, ctx(kv, "ses_a", "PR acme/in-scope#3"));
  await emit("turn.failed", { status: "error", message: "invalid_model" }, ctx(kv, "ses_a", HARNESS_SUMMARY));
  assert.deepEqual(claimed(store), ["auto-drive:acme/in-scope#4"]);
  assert.equal(store.has("drive-session/ses_a"), false);
});

test("an old drive failing after the PR was retaken leaves the newer drive's claim", async () => {
  const { store, kv } = claims();
  await emit("turn.started", {}, ctx(kv, "ses_old", "PR acme/in-scope#3"));
  store.set("auto-drive:acme/in-scope#3", { ...STARTED, owner: "tok3-retaken", at: "2026-09-23T02:01:00.000Z" });
  await emit("turn.started", {}, ctx(kv, "ses_new", "PR acme/in-scope#3"));

  await emit("turn.failed", { status: "error", message: "boom" }, ctx(kv, "ses_old", "PR acme/in-scope#3"));
  assert.deepEqual(claimed(store), ["auto-drive:acme/in-scope#3", "auto-drive:acme/in-scope#4"]);
  const retaken = store.get("auto-drive:acme/in-scope#3") as Record<string, unknown>;
  assert.deepEqual([retaken["owner"], retaken["sessionId"]], ["tok3-retaken", "ses_new"]);

  await emit("turn.failed", { status: "error", message: "boom" }, ctx(kv, "ses_new", HARNESS_SUMMARY));
  assert.deepEqual(claimed(store), ["auto-drive:acme/in-scope#4"]);
});

test("a drive whose session fails releases its PR's claim", async () => {
  const { store, kv } = claims();
  await emit("turn.started", {}, ctx(kv, "ses_b", "PR acme/in-scope#4"));
  await emit("session.failed", { message: "task failed" }, ctx(kv, "ses_b", HARNESS_SUMMARY));
  assert.deepEqual(claimed(store), ["auto-drive:acme/in-scope#3"]);
});

test("a cancelled turn, another channel, or a session that never stamped keeps the claim, and a first turn on a PR with no claim stamps nothing", async () => {
  const { store, kv } = claims();
  await emit("turn.started", {}, ctx(kv, "ses_c", "PR acme/in-scope#3"));
  await emit("turn.failed", { status: "cancelled", message: "turn interrupted" }, ctx(kv, "ses_c", HARNESS_SUMMARY));

  await emit("turn.started", {}, ctx(kv, "ses_d", "PR acme/in-scope#4", "drive", "pr:acme/in-scope#4"));
  await emit("turn.failed", { status: "error", message: "boom" }, ctx(kv, "ses_d", "PR acme/in-scope#4", "drive", "pr:acme/in-scope#4"));
  await emit("turn.failed", { status: "error", message: "boom" }, ctx(kv, "ses_never", "PR acme/in-scope#4"));
  await emit("turn.started", {}, ctx(kv, "ses_e", "PR acme/in-scope#9"));

  assert.deepEqual(claimed(store), ["auto-drive:acme/in-scope#3", "auto-drive:acme/in-scope#4"]);
  assert.equal((store.get("auto-drive:acme/in-scope#3") as { sessionId?: string }).sessionId, "ses_c");
  assert.equal((store.get("auto-drive:acme/in-scope#4") as { sessionId?: string }).sessionId, undefined);
});

// A delivery-started (evt:) drive now records affinity from its title, so a
// later red check or Bugbot finding wakes its agent instead of finding a held
// claim with nothing to wake (#190 round 3).
test("binding an agent writes affinity for a pr: session and for an evt: drive session named by its title", async () => {
  const { store, kv } = claims();
  await emit("agent.bound", { sdkAgentId: "bc-evt-drive" }, ctx(kv, "ses_f", "PR acme/in-scope#3", "github", "evt:0123abcd"));
  assert.equal((store.get("affinity/acme/in-scope#3") as { bcId: string }).bcId, "bc-evt-drive");
  await emit("agent.bound", { sdkAgentId: "bc-evt-other" }, ctx(kv, "ses_h", "Some summary title", "github", "evt:4567"));
  assert.equal((store.get("affinity/acme/in-scope#3") as { bcId: string }).bcId, "bc-evt-drive", "a session whose title names no PR writes nothing");
  await emit("agent.bound", { sdkAgentId: "bc-pr-drive" }, ctx(kv, "ses_g", "PR acme/in-scope#3", "drive", "pr:acme/in-scope#3"));
  assert.equal((store.get("affinity/acme/in-scope#3") as { bcId: string }).bcId, "bc-pr-drive");
});

test("a drive turn that completes releases its claim, so the PR is not held for DRIVE_LEASE_MS after the work", async () => {
  const { store, kv } = claims();
  store.set("auto-drive:acme/in-scope#3", { state: "pending", owner: "tok", at: new Date().toISOString(), started: true });
  await emit("turn.started", {}, ctx(kv, "ses_done", "PR acme/in-scope#3", "github", "evt:9"));
  await emit("turn.completed", {}, ctx(kv, "ses_done", "PR acme/in-scope#3", "github", "evt:9"));
  assert.equal(store.has("auto-drive:acme/in-scope#3"), false);
});

// Bugbot on PR #198: a close deletes affinity/ so a reopened PR wakes no
// pre-close agent, but a drive that sent before the close could bind after
// it and write affinity back. Binds now check the PR's state, and a pr:
// session's generation.
function githubAnswering(state: "open" | "closed" | "merged" | "unreachable") {
  return {
    getOctokit: async () => ({
      request: async () => {
        if (state === "unreachable") throw Object.assign(new Error("Bad Gateway"), { status: 502 });
        return { data: { state: state === "merged" ? "closed" : state, merged: state === "merged" } };
      },
    }),
  };
}

function bindCtx(input: { kv: HostKvApi; github: ReturnType<typeof githubAnswering>; channelId: string; continuationToken: string }) {
  return { channel: { id: input.channelId, continuationToken: input.continuationToken }, session: { id: "ses_bind", channelId: input.channelId, title: "PR acme/in-scope#3" }, host: { kv: input.kv, github: input.github } };
}

test("a bind that lands after its PR closed or merged writes no affinity; an open PR, or GitHub not answering, still records it", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  for (const [state, recorded] of [["closed", false], ["merged", false], ["open", true], ["unreachable", true]] as const) {
    const { store, kv } = claims();
    for (const [channelId, continuationToken] of [["github", "evt:0123abcd"], ["drive", "pr:acme/in-scope#3"]] as const) {
      store.delete("affinity/acme/in-scope#3");
      await emit("agent.bound", { sdkAgentId: "bc-late" }, bindCtx({ kv, github: githubAnswering(state), channelId, continuationToken }));
      assert.equal(store.has("affinity/acme/in-scope#3"), recorded, `${state} ${channelId}`);
    }
  }
  const skipped = logs.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('"bind_skipped"'));
  assert.ok(skipped.length >= 4 && skipped.every((line) => line.includes('"pr_closed"')));
});

test("a pr: session from before the PR's last close binds nothing after a reopen; one on the current generation records", async (t) => {
  t.mock.method(console, "log", () => {});
  const { store, kv } = claims();
  store.set("v1/pr-generation/acme/in-scope/3", { n: 1 });
  const github = githubAnswering("open");
  await emit("agent.bound", { sdkAgentId: "bc-old" }, bindCtx({ kv, github, channelId: "drive", continuationToken: "pr:acme/in-scope#3" }));
  assert.equal(store.has("affinity/acme/in-scope#3"), false, "generation 0 is stale once the PR closed once");
  await emit("agent.bound", { sdkAgentId: "bc-new" }, bindCtx({ kv, github, channelId: "drive", continuationToken: "pr:acme/in-scope#3@g1" }));
  assert.equal((store.get("affinity/acme/in-scope#3") as { bcId?: string } | undefined)?.bcId, "bc-new");
});

// Bugbot on PR #198 (c5d82a0): the generation check compared the bind's key
// with a token whose unread fallback is generation 0, so a kv blip let a
// pre-close session bind and refused the current one. An unread generation
// now skips the check (the bind is recorded, as before the check existed).
test("a generation kv will not return is not guessed: the bind is recorded, whether its key names generation 0 or the current one", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  for (const continuationToken of ["pr:acme/in-scope#3", "pr:acme/in-scope#3@g1"]) {
    const { store, kv: inner } = claims();
    store.set("v1/pr-generation/acme/in-scope/3", { n: 1 });
    const kv: HostKvApi = {
      ...inner,
      get: async (key) => {
        if (key.startsWith("v1/pr-generation/")) throw Object.assign(new Error("kv 503"), { status: 503 });
        return inner.get(key);
      },
    };
    await emit("agent.bound", { sdkAgentId: "bc-blip" }, bindCtx({ kv, github: githubAnswering("open"), channelId: "drive", continuationToken }));
    assert.equal((store.get("affinity/acme/in-scope#3") as { bcId?: string } | undefined)?.bcId, "bc-blip", continuationToken);
  }
});

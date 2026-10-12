import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi, JsonValue } from "@cursor/july";
import { clearLoader, ensureLoader, loaderKey, loaderMessage, parseLoader, postLoader, readReviewGates, writeReviewGates } from "./loader.js";

const BOUND = { "ticket/TLSSN-42": { channelId: "C0123ABCD", threadTs: "1758510000.123456", originatorUserId: "U0ALICE01" } };

function memoryKv(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const kv: HostKvApi = {
    get: async (key: string) => store[key] as JsonValue | undefined,
    put: async (key: string, value: JsonValue) => void (store[key] = value),
    delete: async (key: string) => void delete store[key],
  };
  return { store, kv };
}

function slack() {
  const posts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const deletes: Record<string, unknown>[] = [];
  let n = 0;
  return {
    posts,
    updates,
    deletes,
    client: {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          posts.push(args);
          n += 1;
          return { ok: true, ts: `1758510002.${String(n).padStart(6, "0")}` };
        },
        update: async (args: Record<string, unknown>) => {
          updates.push(args);
          return { ok: true };
        },
        delete: async (args: Record<string, unknown>) => {
          deletes.push(args);
          return { ok: true };
        },
      },
    },
  };
}

test("loader messages are one short line per wait phase", () => {
  assert.equal(loaderMessage("TLSSN-29", "planning"), "TLSSN-29: planner is checking the code…");
  assert.equal(loaderMessage("TLSSN-29", "replanning"), "TLSSN-29: re-planning with your reply…");
  assert.equal(loaderMessage("TLSSN-29", "implementing"), "TLSSN-29: starting implementation…");
  assert.equal(loaderKey("TLSSN-29"), "loader/TLSSN-29");
});

test("postLoader posts once per phase and rewrites the same crumb when the phase changes", async () => {
  const { kv, store } = memoryKv({ ...BOUND });
  const client = slack();
  assert.equal(await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "planning" }), "posted");
  assert.deepEqual(client.posts, [{ channel: "C0123ABCD", thread_ts: "1758510000.123456", text: "TLSSN-42: planner is checking the code…" }]);
  assert.deepEqual(parseLoader(store[loaderKey("TLSSN-42")]), { channel: "C0123ABCD", ts: "1758510002.000001", phase: "planning" });

  assert.equal(await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "planning" }), "unchanged");
  assert.equal(client.posts.length, 1);

  assert.equal(await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "replanning" }), "updated");
  assert.deepEqual(client.updates, [{ channel: "C0123ABCD", ts: "1758510002.000001", text: "TLSSN-42: re-planning with your reply…" }]);
  assert.equal(client.posts.length, 1);
  assert.equal(parseLoader(store[loaderKey("TLSSN-42")])?.phase, "replanning");
});

test("ensureLoader leaves a Needs-info replan crumb in place", async () => {
  const { kv } = memoryKv({ ...BOUND });
  const client = slack();
  assert.equal(await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "replanning" }), "posted");
  assert.equal(await ensureLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "planning" }), "unchanged");
  assert.equal(client.posts.length, 1);
  assert.equal(client.updates.length, 0);
});

test("clearLoader deletes the Slack crumb; keepMessage only drops the record", async () => {
  const { kv, store } = memoryKv({ ...BOUND });
  const client = slack();
  await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "planning" });
  assert.equal(await clearLoader({ kv, client: client.client, issueKey: "TLSSN-42" }), "cleared");
  assert.deepEqual(client.deletes, [{ channel: "C0123ABCD", ts: "1758510002.000001" }]);
  assert.equal(store[loaderKey("TLSSN-42")], undefined);

  await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "implementing" });
  assert.equal(await clearLoader({ kv, client: client.client, issueKey: "TLSSN-42", keepMessage: true }), "cleared");
  assert.equal(client.deletes.length, 1);
  assert.equal(store[loaderKey("TLSSN-42")], undefined);
  assert.equal(await clearLoader({ kv, client: client.client, issueKey: "TLSSN-42" }), "missing");
});

test("an unbound ticket gets no crumb", async () => {
  const { kv } = memoryKv();
  assert.equal(await postLoader({ kv, client: slack().client, issueKey: "TLSSN-42", phase: "planning" }), "no_thread");
});

test("reviewing crumb names only the gates still pending, in a fixed order", () => {
  assert.equal(loaderMessage("TLSSN-30", "reviewing"), "TLSSN-30: checks running…");
  assert.equal(loaderMessage("TLSSN-30", "reviewing", ["ci", "bugbot", "security"]), "TLSSN-30: waiting on Bugbot, security, CI…");
  assert.equal(loaderMessage("TLSSN-30", "reviewing", ["ci"]), "TLSSN-30: waiting on CI…");
  assert.deepEqual(parseLoader({ channel: "C1", ts: "1758510002.000001", phase: "reviewing", pending: ["ci", "nope", "bugbot"] }), { channel: "C1", ts: "1758510002.000001", phase: "reviewing", pending: ["bugbot", "ci"] });
});

test("postLoader rewrites a reviewing crumb only when its pending set changes", async () => {
  const { kv, store } = memoryKv(BOUND);
  const client = slack();
  assert.equal(await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "reviewing", pending: ["bugbot", "security", "ci"] }), "posted");
  assert.equal(client.posts[0]?.["text"], "TLSSN-42: waiting on Bugbot, security, CI…");
  assert.equal(await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "reviewing", pending: ["ci", "security", "bugbot"] }), "unchanged");
  assert.equal(await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "reviewing", pending: ["security"] }), "updated");
  assert.equal(client.updates[0]?.["text"], "TLSSN-42: waiting on security…");
  assert.deepEqual(store[loaderKey("TLSSN-42")], { channel: "C0123ABCD", ts: "1758510002.000001", phase: "reviewing", pending: ["security"] });
  assert.equal(await postLoader({ kv, client: client.client, issueKey: "TLSSN-42", phase: "reviewing" }), "updated");
  assert.equal(client.updates[1]?.["text"], "TLSSN-42: checks running…");
  assert.equal(client.posts.length, 1, "one crumb per ticket");
  assert.equal(await clearLoader({ kv, client: client.client, issueKey: "TLSSN-42" }), "cleared");
});

test("review-gates record merges pending and the In Review flag", async () => {
  const { kv } = memoryKv();
  assert.deepEqual(await readReviewGates(kv, "TLSSN-42"), {});
  await writeReviewGates(kv, "TLSSN-42", { inReview: true });
  await writeReviewGates(kv, "TLSSN-42", { pending: ["ci", "bugbot"] });
  assert.deepEqual(await readReviewGates(kv, "TLSSN-42"), { pending: ["bugbot", "ci"], inReview: true });
  await writeReviewGates(kv, "TLSSN-42", { inReview: false });
  assert.deepEqual(await readReviewGates(kv, "TLSSN-42"), { pending: ["bugbot", "ci"] });
});

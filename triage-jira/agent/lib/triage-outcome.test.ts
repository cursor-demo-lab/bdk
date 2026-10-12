import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostKvApi } from "@cursor/july";
import { settled, stopReason, takeOutcome, triageOutcome } from "./triage-outcome.js";

const STATUSES = { todo: "To Do", triaged: "Triaged" };
const acted = { verdict: {} as never, evaluatedAt: "", tracker: { status: "acted" as const, issue: { identifier: "TLSSN-42", url: "" }, actions: [{ op: "commented" as const }] } };

test("each way a recorded verdict can fail to move the ticket has its own reason", () => {
  const reason = (transition: Parameters<typeof triageOutcome>[1]) => stopReason({ outcome: triageOutcome(acted, transition), statuses: STATUSES });
  assert.equal(reason({ status: "failed", message: "could not move TLSSN-42 to Triaged: 400 Bad Request." }), "Triage recorded its verdict on the ticket, but the move to Triaged failed (could not move TLSSN-42 to Triaged: 400 Bad Request).");
  assert.equal(reason({ status: "not_connected" }), "Triage recorded its verdict on the ticket, but could not reach Jira to move it to Triaged.");
  assert.equal(reason({ status: "skipped_status" }), "Triage recorded its verdict on the ticket, but could not read its status, so it did not move it to Triaged.");
  assert.equal(reason({ status: "no_transition", available: [] }), "Triage recorded its verdict on the ticket, but Jira offers no move from To Do to Triaged (available: none).");
  assert.equal(stopReason({ outcome: { tracker: "not_connected" }, failed: "boom", statuses: STATUSES }), "Triage could not reach Jira: its tracker connection is not connected.");
  assert.equal(stopReason({ failed: `x${" long".repeat(100)}`, statuses: STATUSES }).length, "The triage run failed: ".length + 300 + 1);
});

test("a move that landed, or found the ticket already past To Do, is settled", () => {
  assert.equal(settled(triageOutcome(acted, { status: "transitioned" }), "To Do"), true);
  assert.equal(settled(triageOutcome(acted, { status: "already" }), "To Do"), true);
  assert.equal(settled(triageOutcome(acted, { status: "skipped_status", current: "Planned" }), "To Do"), true);
  assert.equal(settled(triageOutcome(acted, { status: "skipped_status" }), "To Do"), false);
  assert.equal(settled(triageOutcome(acted, { status: "no_transition", available: ["Done"] }), "To Do"), false);
  assert.equal(settled(undefined, "To Do"), false);
});

test("a record that is not one record_triage wrote reads as none, and is removed either way", async () => {
  for (const value of ["acted", ["acted"], { tracker: "moved" }, { transition: "transitioned" }]) {
    const store = new Map<string, unknown>([["triage-outcome/ses_1", value]]);
    const kv: HostKvApi = { get: async (key) => store.get(key) as never, put: async () => {}, delete: async (key) => void store.delete(key) };
    assert.equal(await takeOutcome(kv, "ses_1"), undefined, JSON.stringify(value));
    assert.equal(store.size, 0);
  }
  const failing: HostKvApi = { get: async () => { throw new Error("kv down"); }, put: async () => {}, delete: async () => {} };
  assert.equal(await takeOutcome(failing, "ses_1"), undefined);
});

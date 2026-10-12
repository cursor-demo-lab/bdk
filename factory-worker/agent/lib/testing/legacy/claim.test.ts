import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedKv } from "../../kv-backends.fixtures.js";
import { racingStores } from "../../kv-race.fixtures.js";
import { prStatusClaimKey } from "../../kv-keys.js";
import { memoryKv } from "../fakes.js";
import { claimImplementation, claimStatusMove } from "./claim.js";

const AT = new Date("2026-09-23T00:00:00.000Z");

test("frozen claimImplementation on hosted-shaped kv: claims, holds a young pending claim, and takes over a stale one", async () => {
  const kv = hostedKv();
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", AT), { status: "claimed", retried: false });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", new Date("2026-09-23T00:10:00.000Z")), { status: "in_flight" });
  assert.deepEqual(await claimImplementation(kv, "TLSSN-42", new Date("2026-09-23T00:10:00.001Z")), { status: "claimed", retried: true });
});

test("frozen claimImplementation with no compare-and-set: two deliveries that both read before either puts both claim", async () => {
  const [first, second] = racingStores(memoryKv(), { prefix: "implement/", after: "put" });
  const outcomes = await Promise.all([claimImplementation(first, "TLSSN-42", AT), claimImplementation(second, "TLSSN-42", AT)]);
  assert.deepEqual(outcomes, [
    { status: "claimed", retried: false },
    { status: "claimed", retried: false },
  ]);
});

test("frozen claimStatusMove with no compare-and-set: two deliveries that both read before either puts both claim", async () => {
  const key = prStatusClaimKey({ issueKey: "TLSSN-42", stage: "in_review", pr: "cursor-demo-lab/marsbank#13" });
  const [first, second] = racingStores(memoryKv(), { prefix: "pr-status/", after: "put" });
  assert.deepEqual(await Promise.all([claimStatusMove(first, key, AT), claimStatusMove(second, key, AT)]), [{ status: "claimed" }, { status: "claimed" }]);
});

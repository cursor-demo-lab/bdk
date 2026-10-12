import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedKv } from "../../kv-backends.fixtures.js";
import { racingStores } from "../../kv-race.fixtures.js";
import { claimPlan } from "./start-plan.js";

const KEY = "plan/TLSSN-42:Triaged:10041";
const AT = new Date("2026-09-23T00:00:00.000Z");

test("frozen claimPlan on hosted-shaped kv: claims, holds a young pending claim, and takes over a stale one", async () => {
  const kv = hostedKv();
  assert.deepEqual(await claimPlan(kv, KEY, AT), { status: "claimed", retried: false });
  assert.deepEqual(await claimPlan(kv, KEY, new Date("2026-09-23T00:10:00.000Z")), { status: "in_flight" });
  assert.deepEqual(await claimPlan(kv, KEY, new Date("2026-09-23T00:10:00.001Z")), { status: "claimed", retried: true });
});

test("frozen claimPlan with no compare-and-set: two deliveries that both read before either puts both claim", async () => {
  const [first, second] = racingStores(hostedKv(), { prefix: "plan/", after: "put" });
  const outcomes = await Promise.all([claimPlan(first, KEY, AT, false, "dlv_1"), claimPlan(second, KEY, AT, false, "dlv_2")]);
  assert.deepEqual(outcomes, [
    { status: "claimed", retried: false },
    { status: "claimed", retried: false },
  ]);
});

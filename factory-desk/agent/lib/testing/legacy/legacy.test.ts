import assert from "node:assert/strict";
import { test } from "node:test";
import { racingStores, recordKv } from "../../kv-race.fixtures.js";
import { addToIndex, HOP_WATCH_INDEX, readIndex } from "./hop-watch-index.js";
import { takeRecheck } from "./review-recheck.js";

const PR = { repository: "cursor-demo-lab/marsbank", number: 19 };
const HEAD = { headSha: "ABC123" };
const SCHEDULE = [60_000, 120_000];
const now = () => new Date("2026-09-23T00:00:00.000Z");

test("frozen takeRecheck: a live lease holds a second loop off; an expired one lets it take the head again", async () => {
  const rows: Record<string, unknown> = {};
  const kv = recordKv(rows);
  assert.equal(await takeRecheck({ kv, now }, PR, HEAD, SCHEDULE), true);
  assert.deepEqual(rows, { "review-recheck/cursor-demo-lab/marsbank#19/abc123": { until: "2026-09-23T00:04:00.000Z" } });
  assert.equal(await takeRecheck({ kv, now }, PR, HEAD, SCHEDULE), false);
  assert.equal(await takeRecheck({ kv, now: () => new Date("2026-09-23T00:04:00.001Z") }, PR, HEAD, SCHEDULE), true);
});

test("frozen takeRecheck with no compare-and-set: two wakes that both read before either puts both start a loop", async () => {
  const [first, second] = racingStores(recordKv({}), { prefix: "review-recheck/", after: "put" });
  assert.deepEqual(await Promise.all([takeRecheck({ kv: first, now }, PR, HEAD, SCHEDULE), takeRecheck({ kv: second, now }, PR, HEAD, SCHEDULE)]), [true, true]);
});

test("frozen hop-watch addToIndex with no compare-and-set: of two arms that both read the index first, only the later put survives", async () => {
  const rows: Record<string, unknown> = {};
  const [first, second] = racingStores(recordKv(rows), { prefix: HOP_WATCH_INDEX, after: "put" });
  await Promise.all([addToIndex(first, "TLSSN-1"), addToIndex(second, "TLSSN-2")]);
  assert.deepEqual(await readIndex(recordKv(rows)), ["TLSSN-2"]);
});

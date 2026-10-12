import assert from "node:assert/strict";
import { test } from "node:test";
import * as keys from "./kv-keys.js";

// The builder as it was before kv-keys.ts (268fc79). Each stored record is
// found only by these exact bytes, so the central builder must reproduce them.
const legacy = {
  reviewedKey: (pr: { fullName: string; number: number }) => `reviewed/${pr.fullName.toLowerCase()}#${pr.number}`,
};

const PRS = ["cursor-demo-lab/marsbank", "Cursor-Demo-Lab/MarsBank", "Org/Re#po"].flatMap((fullName) => [28, 1].map((number) => ({ fullName, number })));

test("the builder writes the same bytes it wrote before kv-keys.ts", () => {
  for (const pr of PRS) assert.equal(keys.reviewedKey(pr.fullName, pr.number), legacy.reviewedKey(pr));
  assert.equal(keys.reviewedKey("Cursor-Demo-Lab/MarsBank", 28), "reviewed/cursor-demo-lab/marsbank#28");
});

test("the registry names every builder, and each builder's keys start with its prefix", () => {
  const exported = Object.entries(keys).filter(([name, value]) => (typeof value === "function" && name.endsWith("Key")) || (typeof value === "string" && /^[A-Z_]+$/.test(name)));
  assert.deepEqual(exported.map(([name]) => name).sort(), keys.KEY_REGISTRY.map((entry) => entry.builder).sort());
  for (const pr of PRS) assert.ok(keys.reviewedKey(pr.fullName, pr.number).startsWith(keys.KEY_REGISTRY[0]!.prefix));
});

test("the ops funnel's marker is v1/ops-alert/<hash16>/<hour> under its registered prefix", () => {
  const key = keys.opsAlertKey({ hash: "0123456789abcdef", hour: "2026-09-29T05" });
  assert.equal(key, "v1/ops-alert/0123456789abcdef/2026-09-29T05");
  assert.ok(key.startsWith(keys.KEY_REGISTRY.find((entry) => entry.builder === "opsAlertKey")!.prefix));
});

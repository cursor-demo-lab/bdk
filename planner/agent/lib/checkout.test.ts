import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECKOUT_ENV, MANAGED_HOSTING_ENV, cloudPlanning, planSessionCloud, plannerCheckout } from "./checkout.js";
import { FactoryConfigError } from "./config.js";

test("unset, blank, a missing path, or a file is not a checkout", () => {
  const file = join(mkdtempSync(join(tmpdir(), "planner-")), "not-a-dir");
  writeFileSync(file, "");
  assert.equal(plannerCheckout({}), undefined);
  for (const value of ["  ", join(tmpdir(), "planner-does-not-exist"), file]) {
    assert.equal(plannerCheckout({ [CHECKOUT_ENV]: value }), undefined, value);
  }
});

test("an existing directory is returned resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-"));
  assert.equal(plannerCheckout({ [CHECKOUT_ENV]: dir }), dir);
});

const SANDBOX = { FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank", FACTORY_SANDBOX_REF: "release" };
const HOSTED = { [MANAGED_HOSTING_ENV]: "7" };

test("cloud planning is the managed-hosting signal alone, so boot and send time cannot disagree", () => {
  assert.equal(cloudPlanning({}), false);
  assert.equal(cloudPlanning({ [MANAGED_HOSTING_ENV]: "" }), false);
  // Trimmed before the empty check, as July's relay reads it (cursor-relay-core.js:89-91).
  assert.equal(cloudPlanning({ [MANAGED_HOSTING_ENV]: "  " }), false);
  assert.equal(cloudPlanning({ [MANAGED_HOSTING_ENV]: "\t\n" }), false);
  assert.equal(cloudPlanning({ [MANAGED_HOSTING_ENV]: " 7 " }), true);
  assert.equal(cloudPlanning({ [CHECKOUT_ENV]: mkdtempSync(join(tmpdir(), "planner-")) }), false);
  assert.equal(cloudPlanning(HOSTED), true);
  assert.equal(cloudPlanning({ ...HOSTED, [CHECKOUT_ENV]: mkdtempSync(join(tmpdir(), "planner-")) }), true);
});

test("on managed hosting a set checkout fails the send by name, whether or not the directory exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-"));
  for (const checkout of [dir, join(tmpdir(), "planner-does-not-exist")]) {
    assert.throws(
      () => planSessionCloud({ ...HOSTED, ...SANDBOX, [CHECKOUT_ENV]: checkout }),
      (error: unknown) => error instanceof FactoryConfigError && error.message.includes(CHECKOUT_ENV) && error.message.includes(checkout),
      checkout
    );
  }
  assert.deepEqual(planSessionCloud({ ...HOSTED, ...SANDBOX, [CHECKOUT_ENV]: "  " }), {
    cloud: { repos: [{ url: "https://github.com/cursor-demo-lab/marsbank", startingRef: "release" }] },
  });
});

test("on managed hosting planSessionCloud attaches the sandbox at its ref", () => {
  assert.deepEqual(planSessionCloud({ ...HOSTED, ...SANDBOX }), {
    cloud: { repos: [{ url: "https://github.com/cursor-demo-lab/marsbank", startingRef: "release" }] },
  });
});

test("off managed hosting planSessionCloud attaches nothing, so the turn stays local and read-only", () => {
  assert.deepEqual(planSessionCloud(SANDBOX), {});
  assert.deepEqual(planSessionCloud({ ...SANDBOX, [CHECKOUT_ENV]: mkdtempSync(join(tmpdir(), "planner-")) }), {});
  assert.deepEqual(planSessionCloud({ ...SANDBOX, [MANAGED_HOSTING_ENV]: "  " }), {});
  assert.deepEqual(planSessionCloud({}), {});
});

test("on managed hosting an unset, malformed, or staging-refused sandbox fails the send by name", () => {
  assert.throws(() => planSessionCloud(HOSTED), FactoryConfigError);
  assert.throws(() => planSessionCloud({ ...HOSTED, FACTORY_SANDBOX_REPO: "not-a-repo" }), FactoryConfigError);
  assert.throws(
    () => planSessionCloud({ ...HOSTED, FACTORY_ENV: "staging", FACTORY_SANDBOX_REPO: "cursor-demo-lab/marsbank" }),
    FactoryConfigError
  );
});

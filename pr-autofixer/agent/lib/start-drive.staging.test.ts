import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { startDrive } from "./start-drive.js";

// Every drive starts in startDrive, so a staging fixer refuses the production
// repository there even when its caller's list names it.

const saved = process.env.FACTORY_ENV;
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_ENV;
  else process.env.FACTORY_ENV = saved;
});

const touch = () => {
  throw new Error("a refused drive must not send, read GitHub, or touch kv");
};

test("startDrive on staging refuses the production repository before any read or send", async () => {
  process.env.FACTORY_ENV = "staging";
  const result = await startDrive({ pr: "cursor-demo-lab/marsbank#7", repos: ["cursor-demo-lab/marsbank"], send: touch as never, host: { kv: { get: touch, put: touch, delete: touch }, github: { getOctokit: touch } } as never });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "staging_refuses_production");
});

test("startDrive on production still takes a listed marsbank PR past the stage check", async () => {
  delete process.env.FACTORY_ENV;
  const result = await startDrive({ pr: "cursor-demo-lab/marsbank#7", repos: [], send: touch as never, host: {} as never });
  assert.equal(!result.ok && result.code, "out_of_scope", "production reaches the existing scope check, unchanged");
});

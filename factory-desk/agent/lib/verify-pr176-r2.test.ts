import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKSTOP_SWEEP_EVERY_MS, BACKSTOP_SWEEP_KEY, backstopSweep, HOP_WATCH_INDEX } from "./hop-watch.js";
import { deniedComment, isDeniedComment } from "./plan-decline.js";

// Round-2 verifier cases for PR 176.

const T0 = new Date("2026-09-25T23:50:00Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);

function memoryKv(initial: Record<string, unknown>) {
  const rows: Record<string, unknown> = structuredClone(initial);
  return { rows, kv: { get: async (key: string) => structuredClone(rows[key]) as never, put: async (key: string, value: unknown) => void (rows[key] = structuredClone(value)), delete: async (key: string) => void delete rows[key] } };
}

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.error = error;
  }
};

test("decline: every denial line the desk writes is one it recognises (no second denial for any Slack name)", () => {
  const names = [
    "José",
    "Zoë",
    "Alice Ng",
    "a person in the Slack thread",
    "Ana María de la Cruz Pérez Gómez",
    "Alice (she/her)",
    "Bob 🌴 OOO",
    "Chris, PM",
    "李小龍",
  ];
  const missed = names.filter((name) => !isDeniedComment(deniedComment(name)));
  assert.deepEqual(missed, []);
});

test("sweep: a capped sweep that finishes late does not overwrite a newer sweep's lease", async () => {
  const { rows, kv } = memoryKv({ [HOP_WATCH_INDEX]: ["TLSSN-1"] });
  const h = { kv } as never;
  let releaseA!: () => void;
  const hungA = new Promise<[]>((resolve) => (releaseA = () => resolve([])));
  const a = await quiet(() => backstopSweep({ host: h, now: at(0) }, { owner: "A", sweep: () => hungA, timeoutMs: 20 }));
  assert.equal(a.swept, false);
  let releaseB!: () => void;
  const hungB = new Promise<[]>((resolve) => (releaseB = () => resolve([])));
  const b = backstopSweep({ host: h, now: at(BACKSTOP_SWEEP_EVERY_MS) }, { owner: "B", sweep: () => hungB, timeoutMs: 5_000 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((rows[BACKSTOP_SWEEP_KEY] as Record<string, unknown>)["owner"], "B");
  releaseA();
  await new Promise((r) => setTimeout(r, 20));
  const lease = rows[BACKSTOP_SWEEP_KEY] as Record<string, unknown>;
  releaseB();
  await b;
  assert.equal(lease["owner"], "B", `lease after A's late finish: ${JSON.stringify(lease)}`);
});

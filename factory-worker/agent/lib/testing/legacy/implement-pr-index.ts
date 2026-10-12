import type { HostKvApi } from "@cursor/july";

// Frozen: the worker's `addToIndex` for `implement-pr-watch/index` from
// agent/lib/implement-pr.ts at 268fc79, with `updateImplementPrIndex` and its
// in-process queue. This module has its own queue, as an old process would,
// so writes here never wait on the live module's queue. Never edit it to
// follow the live file; delete it once no deployed slug can run it.

export const IMPLEMENT_PR_INDEX = "implement-pr-watch/index";

export async function readImplementPrIndex(kv: HostKvApi): Promise<string[]> {
  const value = await kv.get(IMPLEMENT_PR_INDEX);
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
}

let indexWrite: Promise<void> = Promise.resolve();

function withIndexWrite<T>(work: () => Promise<T>): Promise<T> {
  const run = indexWrite.then(work, work);
  indexWrite = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function updateImplementPrIndex(kv: HostKvApi, update: (current: string[]) => string[] | undefined | Promise<string[] | undefined>): Promise<void> {
  await withIndexWrite(async () => {
    const current = await readImplementPrIndex(kv);
    const next = await update(current);
    if (next !== undefined) await kv.put(IMPLEMENT_PR_INDEX, next);
  });
}

export async function addToIndex(kv: HostKvApi, issueKey: string): Promise<void> {
  await updateImplementPrIndex(kv, (index) => (index.includes(issueKey) ? undefined : [...index, issueKey]));
}

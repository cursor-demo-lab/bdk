import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// agent/hooks/zz-otel-turn-flush.ts schedules the factory's telemetry flush
// with setImmediate from a turn.completed / turn.failed hook. July awaits every
// hook, in the order its project loader lists them, and only then hands the
// event to its collector (session-engine.js, `for (const hook of
// this.project.hooks)` then `this.otel?.onEvent`). The scheduled flush is meant
// to run after that synchronous onEvent. A hook listed after ours that awaits
// I/O would let the immediate fire first and export before the turn is
// counted, so ours must be the last hook every host loads. Its session.waiting
// / session.completed / session.failed handlers await the flush instead (July
// dispatches them after the turn's end, so ordering does not matter there).
//
// The order is July's, not reproduced here: each host is loaded with July's own
// project loader (`loadAgentProject`, as factory-desk's agent/discovery.test.ts
// does) and `project.hooks` is read. That list is the files in agent/hooks/ by
// `localeCompare` (discovery/hooks.js, fs.js), followed by the hooks that
// mounted extensions contribute, which July appends after them
// (discovery/project.js `hooks.push(...projectSlots.hooks)`, named
// `<ns>__<name>` by discovery/extensions.js). factory-desk and triage-jira
// mount `jev`; a hook added to a mount, or to any host, after ours would fail
// here. The loader runs under plain Node, so agent `./x.js` imports are
// retried as `.ts` (ts-resolve.mjs).

register("./ts-resolve.mjs", import.meta.url);

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOSTS = ["factory-desk", "factory-worker", "planner", "pr-autofixer", "security-reviewer", "triage-jira"];
const HOOK = "zz-otel-turn-flush";

async function loadedProject(host) {
  const dir = join(ROOT, host);
  const july = await import(pathToFileURL(join(dir, "node_modules", "@cursor", "july", "dist", "index.js")).href);
  const project = await july.loadAgentProject(dir);
  assert.deepEqual(project.diagnostics, [], `${host} has discovery diagnostics`);
  return project;
}

for (const host of HOSTS) {
  test(`${host}: the turn-flush hook is loaded, and last, as July's project loader orders hooks (extension hooks included)`, async () => {
    const names = (await loadedProject(host)).hooks.map((hook) => hook.name);
    assert.ok(names.includes(HOOK), `${host} does not load the ${HOOK} hook: ${JSON.stringify(names)}`);
    assert.equal(names.at(-1), HOOK, `${host}: July runs hooks in this order ${JSON.stringify(names)}; ${HOOK} must be last so no other hook's awaited work runs between its schedule and July's collector`);
  });

  test(`${host}: the loaded turn-flush hook subscribes to exactly the turn and session ends`, async () => {
    const hook = (await loadedProject(host)).hooks.find((entry) => entry.name === HOOK);
    assert.ok(hook, `${host} does not load the ${HOOK} hook`);
    assert.deepEqual(Object.keys(hook.definition.events).sort(), ["session.completed", "session.failed", "session.waiting", "turn.completed", "turn.failed"]);
  });
}

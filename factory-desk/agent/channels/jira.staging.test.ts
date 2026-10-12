import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HostMcpRegistry } from "@cursor/july";
import channel from "./jira.js";

// docs/factory-deployment.md §10 step 4 on the desk: the replay script's
// signed body for a production key, on a staging slug whose project list is
// the staging key or was emptied by refusing TLSSN. The route answers
// project_not_allowed and the desk writes nothing to Jira (the verifier's
// TLSSN-47 → Approved case edited the ticket's label).

const scriptUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/jira-payload.mjs")).href;
const SECRET = "local-check";
const NAMES = ["JIRA_WEBHOOK_SECRET", "FACTORY_ENV", "FACTORY_JIRA_PROJECTS", "FACTORY_DESK_JIRA_PROJECT"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

type Route = { handler: (request: Request, args: Record<string, unknown>) => Promise<Response> };
const route = (channel as unknown as { routes: Route[] }).routes[0]!;

async function replay(input: { projects: string; toStatus: string; fromStatus: string }) {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, { JIRA_WEBHOOK_SECRET: SECRET, FACTORY_ENV: "staging", FACTORY_JIRA_PROJECTS: input.projects });
  const { transitionBody, signedRequest } = (await import(scriptUrl)) as {
    transitionBody: (fields: Record<string, unknown>) => unknown;
    signedRequest: (body: unknown, secret: string) => { rawBody: string; headers: Record<string, string> };
  };
  const body = transitionBody({ issueKey: "TLSSN-47", toStatus: input.toStatus, fromStatus: input.fromStatus, changelogId: "1", timestamp: 1, summary: "check" });
  const { rawBody: raw, headers } = signedRequest(body, SECRET);
  const tracker: string[] = [];
  const kv = new Map<string, unknown>();
  const host = {
    kv: { get: async (key: string) => kv.get(key), put: async (key: string, value: unknown) => void kv.set(key, value), delete: async (key: string) => void kv.delete(key) },
    mcp: {
      names: () => ["tracker"],
      listTools: async () => {
        tracker.push("listTools");
        return [];
      },
      callTool: async (_connection, name) => {
        tracker.push(name);
        return { content: [] };
      },
    } satisfies HostMcpRegistry,
  };
  const background: Promise<unknown>[] = [];
  const log = console.log;
  console.log = () => undefined;
  try {
    const response = await route.handler(
      new Request("http://127.0.0.1:3000/factory-desk/v1/channels/jira/", { method: "POST", headers, body: raw }),
      { body, host, waitUntil: (promise: Promise<unknown>) => void background.push(promise.catch(() => undefined)) }
    );
    await Promise.all(background);
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, tracker };
  } finally {
    console.log = log;
  }
}

test("a staging desk answers a replayed TLSSN move with project_not_allowed and never calls the tracker", async () => {
  for (const projects of ["TLSTG", "TLSSN"]) {
    for (const [fromStatus, toStatus] of [["Planned", "Approved"], ["Planned", "To Do"], ["To Do", "Triaged"]] as const) {
      const result = await replay({ projects, toStatus, fromStatus });
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true, ignored: true, reason: "project_not_allowed" }, `${projects} ${toStatus}`);
      assert.deepEqual(result.tracker, [], `${projects} ${fromStatus} → ${toStatus} touched the tracker`);
    }
  }
});

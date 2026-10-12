import { createHmac } from "node:crypto";
import type { HostKvApi, HostKvCasApi, HostMcpCallResult, HostMcpRegistry, HostMcpToolInfo, JsonValue, KvCasResult } from "@cursor/july";
import type { AgentOptions } from "@cursor/sdk";
import type { CreateAgent } from "../launch.js";
import type { ClaimRun, Sleep } from "../verified-claim.js";

export const SECRET = "test-secret";

// A 1 ms claim settle keeps the re-read on every handler path without the 2 s wait.
export const ENV: NodeJS.ProcessEnv = {
  JIRA_WEBHOOK_SECRET: SECRET,
  FACTORY_JIRA_PROJECTS: "TLSSN",
  FACTORY_SANDBOX_REPO: "example-org/demo-repo",
  FACTORY_CLAIM_SETTLE_MS: "1",
};

/** The settle wait without the wall-clock wait: every pending in-memory kv call has landed when it resolves. */
export const tick: Sleep = () => new Promise((resolve) => setImmediate(resolve));

export const OWNER = "owner-1";

/** A verified claim run with a fixed owner, a 2 s settle that does not really wait, and no log output. */
export function claimRunFor(overrides: Partial<ClaimRun> = {}): ClaimRun {
  return { host: "worker", mode: "verified", owner: OWNER, settleMs: 2_000, sleep: tick, log: () => {}, ...overrides };
}

export const BRIEF = "Make the CSV export return an empty file with headers when the filter matches no rows. Add a test for the empty filter.";

export const PLAN_COMMENT = [
  "Plan: TLSSN-42 Retry CSV export on empty filter",
  "Problem",
  "The export job returns 500 when the filter matches no rows.",
  "",
  "Brief:",
  BRIEF,
].join("\n");

export const TRIAGE_COMMENT = "Triage: bug. Severity: high";

export function signedRequest(body: unknown, secret: string = SECRET): Request {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return new Request("http://127.0.0.1:3000/factory-worker/v1/channels/jira/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: raw,
  });
}

export type MemoryKv = HostKvApi & { entries: Map<string, JsonValue> };

/**
 * In-memory kv. Like hosted `host.kv` (July 0.2.13: get, put, delete), it has
 * no compare-and-set by default. `cas: true` adds the methods `supportsKvCas`
 * probes for; only the "CAS path (ask 11)" suites use it.
 */
export function memoryKv(options: { cas?: boolean } = {}): MemoryKv {
  const entries = new Map<string, JsonValue>();
  const versions = new Map<string, number>();
  let counter = 0;
  const write = (key: string, value: JsonValue): string => {
    counter += 1;
    entries.set(key, value);
    versions.set(key, counter);
    return String(counter);
  };
  const current = (key: string) => {
    const value = entries.get(key);
    return value === undefined ? undefined : { value, version: String(versions.get(key)) };
  };
  const plain: MemoryKv = {
    entries,
    get: async (key) => entries.get(key),
    put: async (key, value) => {
      write(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
      versions.delete(key);
    },
  };
  if (options.cas !== true) return plain;
  const cas: HostKvCasApi & MemoryKv = {
    ...plain,
    getWithVersion: async (key) => current(key),
    putIfAbsent: async (key, value): Promise<KvCasResult> =>
      entries.has(key) ? { ok: false, current: current(key) } : { ok: true, version: write(key, value) },
    putIfVersion: async (key, value, expected): Promise<KvCasResult> =>
      current(key)?.version === expected ? { ok: true, version: write(key, value) } : { ok: false, current: current(key) },
    listKeys: async (prefix) => [...entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
  return cas;
}

export type TrackerCall = { tool: string; args: Record<string, unknown> };

// Shaped like the Atlassian connector: comments come back inside getJiraIssue,
// transitions are listed per issue and applied by id.
const TRACKER_TOOLS: HostMcpToolInfo[] = [
  { name: "getJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } } } },
  { name: "addCommentToJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, commentBody: { type: "string" } } } },
  { name: "getTransitionsForJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } } } },
  { name: "transitionJiraIssue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
];

const TRANSITIONS = [
  { id: "21", name: "Withdraw", to: { name: "Planned" } },
  { id: "31", name: "Start work", to: { name: "In Progress" } },
  { id: "71", name: "Review", to: { name: "In Review" } },
  { id: "81", name: "Close", to: { name: "Done" } },
];

export type FakeTracker = { mcp: HostMcpRegistry; calls: TrackerCall[]; comments: string[]; status: () => string };

/** `commentFailures: n` and `transitionFailures: n` make the first n comment writes or transitions fail. */
export function fakeTracker(
  options: { comments?: string[]; status?: string; connected?: boolean; commentFailures?: number; transitionFailures?: number } = {}
): FakeTracker {
  const comments = [...(options.comments ?? [])];
  const calls: TrackerCall[] = [];
  let status = options.status ?? "Approved";
  let commentFailures = options.commentFailures ?? 0;
  let transitionFailures = options.transitionFailures ?? 0;
  const json = (value: unknown): HostMcpCallResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const mcp: HostMcpRegistry = {
    names: () => (options.connected === false ? [] : ["tracker"]),
    listTools: async () => TRACKER_TOOLS,
    callTool: async (_connection, tool, args = {}) => {
      calls.push({ tool, args });
      if (tool === "getJiraIssue") {
        return json({
          key: args["issueIdOrKey"],
          fields: { status: { name: status }, comment: { comments: comments.map((body, i) => ({ id: String(i + 1), body })) } },
        });
      }
      if (tool === "addCommentToJiraIssue") {
        if (commentFailures > 0) {
          commentFailures -= 1;
          return { content: [{ type: "text", text: "comment rejected" }], isError: true };
        }
        comments.push(String(args["commentBody"]));
        return json({ id: String(comments.length) });
      }
      if (tool === "getTransitionsForJiraIssue") return json({ transitions: TRANSITIONS });
      if (tool === "transitionJiraIssue") {
        const id = (args["transition"] as { id?: string } | undefined)?.id;
        const chosen = TRANSITIONS.find((transition) => transition.id === id);
        if (chosen === undefined) return { content: [{ type: "text", text: `no transition ${String(id)}` }], isError: true };
        if (transitionFailures > 0) {
          transitionFailures -= 1;
          return { content: [{ type: "text", text: "transition rejected" }], isError: true };
        }
        status = chosen.to.name;
        return json({});
      }
      return { content: [{ type: "text", text: `unknown tool ${tool}` }], isError: true };
    },
  };
  return { mcp, calls, comments, status: () => status };
}

export type FakeLauncher = { createAgent: CreateAgent; calls: AgentOptions[]; sent: string[]; closed: number };

/** A stand-in for `Agent.create`. `fail(n)` returning an error makes the nth create throw it. */
export function fakeCreateAgent(options: { agentId?: string; fail?: (call: number) => Error | undefined } = {}): FakeLauncher {
  const launcher: FakeLauncher = {
    calls: [],
    sent: [],
    closed: 0,
    createAgent: async (agentOptions) => {
      launcher.calls.push(agentOptions);
      const error = options.fail?.(launcher.calls.length);
      if (error !== undefined) throw error;
      return {
        agentId: options.agentId ?? "bc-test-1",
        send: async (message: string) => {
          launcher.sent.push(message);
        },
        close: () => {
          launcher.closed += 1;
        },
      };
    },
  };
  return launcher;
}

export type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

/** A `waitUntil` that keeps every background promise, settled, for the test to await. */
export function backgroundWork(): { waitUntil(promise: Promise<unknown>): void; settle(): Promise<Settled[]> } {
  const pending: Promise<Settled>[] = [];
  return {
    waitUntil(promise) {
      pending.push(promise.then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error })));
    },
    settle: () => Promise.all(pending.splice(0)),
  };
}

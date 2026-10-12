// One in-thread crumb while the factory is working and the next real status
// has not landed yet. Silence after Triaged (the planner is checking) or
// after a Needs-info reply (a replan is running) looked like a stall on
// TLSSN-29. One message per wait phase, never a heartbeat: post or update
// it here, and the next lifecycle announce deletes it. After In Review the
// `reviewing` crumb names the Bugbot / security / CI gates still running;
// review-announce.ts rewrites it per wake and deletes it when they settle.

import { isSlackTs, parseThreadRef, ticketKey } from "./threads.js";
import { type KeyedKv, loaderKey, reviewGatesKey } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { loaderKey, reviewGatesKey };

export type LoaderPhase = "planning" | "replanning" | "implementing" | "reviewing";

/** Review gates a `reviewing` crumb can name, in display order. */
export type ReviewGate = "bugbot" | "security" | "ci";

const GATE_ORDER: readonly ReviewGate[] = ["bugbot", "security", "ci"];
const GATE_LABEL: Record<ReviewGate, string> = { bugbot: "Bugbot", security: "security", ci: "CI" };

export type LoaderRecord = { channel: string; ts: string; phase: LoaderPhase; pending?: ReviewGate[] };

type PostArgs = { channel: string; text: string; thread_ts?: string };
type SlackClient = {
  chat?: {
    postMessage?(args: PostArgs): Promise<{ ts?: unknown }>;
    update?(args: { channel: string; ts: string; text: string }): Promise<unknown>;
    delete?(args: { channel: string; ts: string }): Promise<unknown>;
  };
  apiCall?(method: string, args: Record<string, unknown>): Promise<unknown>;
};

export function loaderMessage(issueKey: string, phase: LoaderPhase, pending: readonly ReviewGate[] = []): string {
  switch (phase) {
    case "planning":
      return `${issueKey}: planner is checking the code…`;
    case "replanning":
      return `${issueKey}: re-planning with your reply…`;
    case "implementing":
      return `${issueKey}: starting implementation…`;
    case "reviewing": {
      const gates = normalizeGates(pending);
      return gates.length === 0 ? `${issueKey}: checks running…` : `${issueKey}: waiting on ${gates.map((gate) => GATE_LABEL[gate]).join(", ")}…`;
    }
  }
}

export function parseLoader(value: unknown): LoaderRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { channel, ts, phase } = record;
  if (typeof channel !== "string" || !isSlackTs(ts)) return undefined;
  if (phase !== "planning" && phase !== "replanning" && phase !== "implementing" && phase !== "reviewing") return undefined;
  const pending = Array.isArray(record["pending"]) ? normalizeGates(record["pending"].filter((gate): gate is ReviewGate => GATE_ORDER.includes(gate as ReviewGate))) : [];
  return { channel, ts, phase, ...(phase === "reviewing" && pending.length > 0 ? { pending } : {}) };
}

function normalizeGates(gates: readonly ReviewGate[]): ReviewGate[] {
  return GATE_ORDER.filter((gate) => gates.includes(gate));
}

/**
 * Post the crumb for `phase`, or rewrite the existing one when the phase
 * changed. A crumb already showing this phase is left alone. A `reviewing`
 * crumb names the still-pending gates and is rewritten when that set changes.
 */
export async function postLoader(input: { kv: KeyedKv; client: unknown; issueKey: string; phase: LoaderPhase; pending?: readonly ReviewGate[] }): Promise<"posted" | "updated" | "unchanged" | "no_thread" | "failed"> {
  const target = await loaderTarget(input.kv, input.issueKey);
  if (target === undefined) return "no_thread";
  const client = input.client as SlackClient;
  const pending = input.phase === "reviewing" ? normalizeGates(input.pending ?? []) : [];
  const text = loaderMessage(input.issueKey, input.phase, pending);
  const next = { phase: input.phase, ...(pending.length > 0 ? { pending } : {}) };
  let shown: LoaderRecord | undefined;
  try {
    shown = parseLoader(await input.kv.get(loaderKey(input.issueKey)));
  } catch (error) {
    warnKv("loader.postLoader", error);
    shown = undefined;
  }
  if (shown !== undefined && shown.channel === target.channel && shown.phase === input.phase && (shown.pending ?? []).join() === pending.join()) return "unchanged";
  if (shown !== undefined && shown.channel === target.channel) {
    try {
      await slackUpdate(client, { channel: shown.channel, ts: shown.ts, text });
      await remember(input.kv, input.issueKey, { channel: shown.channel, ts: shown.ts, ...next });
      return "updated";
    } catch {
      // The old crumb could not be edited; post a new one.
    }
  }
  try {
    const ts = await slackPost(client, { channel: target.channel, text, ...(target.threadTs === undefined ? {} : { thread_ts: target.threadTs }) });
    if (!isSlackTs(ts)) return "failed";
    await remember(input.kv, input.issueKey, { channel: target.channel, ts, ...next });
    return "posted";
  } catch {
    return "failed";
  }
}

/**
 * Post a planning crumb only when the thread shows no planner crumb. A
 * Needs-info reply or `replan KEY` already left `re-planning…`; a later
 * Triaged bounce must not overwrite that. A leftover crumb from another
 * phase (a moved-back ticket's `starting implementation…`) is rewritten.
 */
export async function ensureLoader(input: { kv: KeyedKv; client: unknown; issueKey: string; phase: LoaderPhase }): Promise<"posted" | "unchanged" | "no_thread" | "failed"> {
  let shown: LoaderRecord | undefined;
  try {
    shown = parseLoader(await input.kv.get(loaderKey(input.issueKey)));
  } catch (error) {
    warnKv("loader.ensureLoader", error);
    return "failed";
  }
  if (shown !== undefined && (shown.phase === "planning" || shown.phase === "replanning")) return "unchanged";
  const posted = await postLoader(input);
  return posted === "updated" ? "posted" : posted;
}

/**
 * Drop the crumb when a real status lands. `keepMessage` is for In Progress
 * rewriting the implementing line in place: the Slack message stays, the
 * record does not.
 */
export async function clearLoader(input: { kv: KeyedKv; client: unknown; issueKey: string; keepMessage?: boolean }): Promise<"cleared" | "missing" | "failed"> {
  const key = loaderKey(input.issueKey);
  let shown: LoaderRecord | undefined;
  try {
    shown = parseLoader(await input.kv.get(key));
  } catch (error) {
    warnKv("loader.clearLoader.get", error);
    return "failed";
  }
  if (shown === undefined) return "missing";
  if (input.keepMessage !== true) {
    try {
      await slackDelete(input.client as SlackClient, { channel: shown.channel, ts: shown.ts });
    } catch (error) {
      const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
      if (code !== "message_not_found" && code !== "cant_delete_message") return "failed";
    }
  }
  try {
    await input.kv.delete(key);
  } catch (error) {
    warnKv("loader.clearLoader.delete", error);
    return "failed";
  }
  return "cleared";
}

async function loaderTarget(kv: KeyedKv, issueKey: string): Promise<{ channel: string; threadTs?: string } | undefined> {
  let bound: unknown;
  try {
    bound = await kv.get(ticketKey(issueKey));
  } catch (error) {
    warnKv("loader.loaderTarget", error);
    return undefined;
  }
  const ticket = parseThreadRef(bound);
  if (ticket === undefined) return undefined;
  return { channel: ticket.channelId, ...(ticket.threadTs === undefined ? {} : { threadTs: ticket.threadTs }) };
}

async function remember(kv: KeyedKv, issueKey: string, record: LoaderRecord): Promise<void> {
  try {
    await kv.put(loaderKey(issueKey), record);
  } catch (error) {
    warnKv("loader.remember", error);
    // The crumb is in the thread; a later clear just cannot find it.
  }
}

async function slackPost(client: SlackClient, args: PostArgs): Promise<string> {
  if (typeof client.chat?.postMessage === "function") {
    const posted = await client.chat.postMessage(args);
    return typeof posted?.ts === "string" ? posted.ts : "";
  }
  if (typeof client.apiCall === "function") {
    const posted = (await client.apiCall("chat.postMessage", args)) as { ts?: unknown };
    return typeof posted?.ts === "string" ? posted.ts : "";
  }
  throw new Error("no slack post");
}

async function slackUpdate(client: SlackClient, args: { channel: string; ts: string; text: string }): Promise<void> {
  if (typeof client.chat?.update === "function") {
    await client.chat.update(args);
    return;
  }
  if (typeof client.apiCall === "function") {
    await client.apiCall("chat.update", args);
    return;
  }
  throw new Error("no slack update");
}

async function slackDelete(client: SlackClient, args: { channel: string; ts: string }): Promise<void> {
  if (typeof client.chat?.delete === "function") {
    await client.chat.delete(args);
    return;
  }
  if (typeof client.apiCall === "function") {
    await client.apiCall("chat.delete", args);
    return;
  }
  throw new Error("no slack delete");
}

/**
 * `review-gates/<KEY>`: the pending gates the last review wake saw, and
 * whether the In Review line has landed. A late In Review line reads the
 * first to decide whether to wait; a review wake reads the second so it
 * never puts a crumb up before In Review.
 */
export type ReviewGatesRecord = { pending?: ReviewGate[]; inReview?: boolean };

export async function readReviewGates(kv: KeyedKv, issueKey: string): Promise<ReviewGatesRecord> {
  let value: unknown;
  try {
    value = await kv.get(reviewGatesKey(issueKey));
  } catch (error) {
    warnKv("loader.readReviewGates", error);
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const pending = Array.isArray(record["pending"]) ? normalizeGates(record["pending"].filter((gate): gate is ReviewGate => GATE_ORDER.includes(gate as ReviewGate))) : undefined;
  return { ...(pending === undefined ? {} : { pending }), ...(record["inReview"] === true ? { inReview: true } : {}) };
}

export async function writeReviewGates(kv: KeyedKv, issueKey: string, patch: ReviewGatesRecord): Promise<void> {
  try {
    const current = await readReviewGates(kv, issueKey);
    const next = { ...current, ...patch };
    await kv.put(reviewGatesKey(issueKey), { ...(next.pending === undefined ? {} : { pending: normalizeGates(next.pending) }), ...(next.inReview === true ? { inReview: true } : {}) });
  } catch (error) {
    warnKv("loader.writeReviewGates", error);
    // In Review then falls back to the generic crumb.
  }
}

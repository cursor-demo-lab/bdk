// ✅ on the person's own command message once the desk has acted on it:
// `approve file` (the ticket was filed), `deny file` (nothing will be),
// `approve KEY` (the ticket is Approved), and `deny KEY` (the decline is on
// the ticket). The ✅ means "done", for a denial as for an approval; it goes
// on the person's message, never on a filing prompt or plan post, and the
// reaction handler ignores the desk's own reactions (reaction-approval.ts),
// so it can never decide anything. The reaction is the whole
// acknowledgement; the Filed and In Progress lines are the next beat, so
// no text reply is added.
//
// Every path that acts on a command acks it here: the host `approve KEY`
// path, and the model's `file_ticket` and `approve_ticket`, which learn the
// message ts from the command record the inbound handler wrote
// (originator.ts). The ack never blocks or fails the command it follows:
// it is bounded by ACK_TIMEOUT_MS, and every outcome is one
// `{"desk":"command_ack",…}` log line, on stderr when it did not land.

import { isSlackTs } from "./threads.js";

export const APPROVED_REACTION = "white_check_mark";

// @slack/web-api has no request timeout by default and retries network and
// rate-limit failures for up to half an hour.
export const ACK_TIMEOUT_MS = 5_000;

export type AckCommand = "approve file" | "deny file" | "approve KEY" | "deny KEY" | "plan KEY";
export type AckTarget = { channel: string; ts: string };
export type AckOutcome = "reacted" | "already" | "already_present" | "no_target" | "no_client" | "failed" | "timeout";

type SlackApi = { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };

// Slack answers these the same way on a second try.
const PERMANENT = new Set([
  "already_reacted",
  "channel_not_found",
  "invalid_auth",
  "invalid_name",
  "is_archived",
  "message_not_found",
  "missing_scope",
  "no_item_specified",
  "not_authed",
  "not_in_channel",
  "account_inactive",
  "token_revoked",
  "too_many_emoji",
  "too_many_reactions",
]);

const TIMED_OUT = Symbol("timeout");

function errorCode(error: unknown): string | undefined {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === "string" ? code : undefined;
}

function errorText(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.message : String(error));
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when the message already carries ✅ from any user. A failed read is false, so the add still runs. */
async function alreadyPresent(api: SlackApi, target: AckTarget): Promise<boolean> {
  try {
    const response = (await api.apiCall("reactions.get", { channel: target.channel, timestamp: target.ts, full: true })) as {
      message?: { reactions?: Array<{ name?: unknown; count?: unknown }> };
    } | null;
    return (response?.message?.reactions ?? []).some((reaction) => reaction.name === APPROVED_REACTION && (typeof reaction.count !== "number" || reaction.count > 0));
  } catch {
    return false;
  }
}

async function attempt(getClient: () => Promise<unknown>, target: AckTarget): Promise<{ outcome: AckOutcome; error?: string }> {
  let client: unknown;
  try {
    client = await getClient();
  } catch (error) {
    return { outcome: "no_client", error: errorText(error) };
  }
  if (typeof (client as { apiCall?: unknown } | null | undefined)?.apiCall !== "function") return { outcome: "no_client" };
  const api = client as SlackApi;
  // Slack counts one ✅ per reactor, so a ✅ someone else already put on the
  // message (the Cursor client reacts as the person when it sends a command)
  // plus ours shows as two. already_reacted only covers our own.
  if (await alreadyPresent(api, target)) return { outcome: "already_present" };
  let last: string | undefined;
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      await api.apiCall("reactions.add", { channel: target.channel, timestamp: target.ts, name: APPROVED_REACTION });
      return { outcome: "reacted" };
    } catch (error) {
      const code = errorCode(error);
      if (code === "already_reacted") return { outcome: "already" };
      last = errorText(error);
      if (code !== undefined && PERMANENT.has(code)) break;
    }
  }
  return { outcome: "failed", ...(last === undefined ? {} : { error: last }) };
}

/** Add ✅ to the command message at `target`. Never throws. */
export async function ackCommand(input: {
  getClient: () => Promise<unknown>;
  target: Partial<AckTarget> | undefined;
  command: AckCommand;
  issueKey?: string;
  timeoutMs?: number;
}): Promise<AckOutcome> {
  const channel = input.target?.channel;
  const ts = input.target?.ts;
  let result: { outcome: AckOutcome; error?: string };
  if (typeof channel !== "string" || !/^[CDG][A-Z0-9]+$/.test(channel) || !isSlackTs(ts)) {
    result = { outcome: "no_target" };
  } else {
    const settled = await within(
      attempt(input.getClient, { channel, ts }).catch((error: unknown) => ({ outcome: "failed" as const, error: errorText(error) })),
      input.timeoutMs ?? ACK_TIMEOUT_MS
    );
    result = settled === TIMED_OUT ? { outcome: "timeout" } : settled;
  }
  const line = JSON.stringify({
    desk: "command_ack",
    command: input.command,
    outcome: result.outcome,
    ...(input.issueKey === undefined ? {} : { issueKey: input.issueKey }),
    ...(channel === undefined ? {} : { channel }),
    ...(ts === undefined ? {} : { ts }),
    ...(result.error === undefined ? {} : { error: result.error }),
  });
  if (result.outcome === "reacted" || result.outcome === "already" || result.outcome === "already_present") console.log(line);
  else console.error(line);
  return result.outcome;
}

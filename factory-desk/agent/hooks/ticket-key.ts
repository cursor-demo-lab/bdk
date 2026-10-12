import { defineHook, type HookContext } from "@cursor/july/hooks";
import { isJiraIssueKey, tagSessionTicket } from "../lib/factory-otel.js";
import { threadTickets } from "../lib/thread-tickets.js";
import { threadFromSession } from "../lib/threads.js";

// Puts `factory.ticket.key` on the token and turn samples July records
// for a desk turn, and on the turn's July spans, so Grafana can price each
// ticket on its own (factory-otel.ts, "Ticket on token usage": the one
// approved addition to July's spans; `cursor.tool.calls` and the factory's
// other metrics drop the label). A desk session is a Slack thread
// (threads.ts threadFromSession), and the thread's filed tickets are in kv
// (thread-tickets.ts); the latest one is the turn's ticket. A thread with
// none yet (the intake chat before `approve file`, a question, a DM with no
// ticket), or one whose kv read fails, is `none`. The turn that files the
// ticket starts as `none`; file_ticket itself calls tagSessionTicket the
// moment createIssue returns the key, before July's collector records that
// turn's usage on `turn.completed`, so the filing turn's whole cost lands
// on the new key. approve_ticket, deny_ticket and request_plan tag their
// input key the same way, on entry. The `action.result` listener below is
// the second path for the same keys: July's `output` for a server tool is
// the SDK's MCP text, a JSON string of the tool's return (@cursor/sdk 1.0.35
// wraps the object as text; July 0.2.18 event-mapper.js describeToolResult
// hands the text on as a string), so issueKeyOf parses a string before
// reading `issueKey`. Hooks run before July's collector sees the event.
export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      await tagFromThread(ctx);
    },
    "action.result": (event, ctx) => {
      const key = issueKeyOf(event.data.output);
      if (key !== undefined) tagSessionTicket(ctx.host, key);
    },
  },
});

async function tagFromThread(ctx: HookContext): Promise<void> {
  const thread = threadFromSession(ctx.session);
  let key: string | undefined;
  try {
    key = thread === undefined ? undefined : (await threadTickets(ctx.host.kv, thread)).at(-1);
  } catch {
    // A kv outage is `none`, not a failed turn or a missing label.
  }
  tagSessionTicket(ctx.host, key);
}

/**
 * The `issueKey` a tool answered with, when it is a Jira key. The answer is
 * the object the tool returned, or that object as the JSON string July's
 * event stream carries for a server tool; anything else is no key.
 */
export function issueKeyOf(output: unknown): string | undefined {
  const value = typeof output === "string" ? parseJson(output) : output;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const key = (value as Record<string, unknown>)["issueKey"];
  return isJiraIssueKey(key) ? key : undefined;
}

function parseJson(text: string): unknown {
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

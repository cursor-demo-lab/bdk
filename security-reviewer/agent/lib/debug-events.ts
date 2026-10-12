import { noteFactory } from "./factory-otel.js";

// Each GitHub delivery that reaches a hook leaves one JSON log line with the
// hook's decision. `bdk logs --prod` covers sessions only, so a delivery that
// starts no turn (skipped, suppressed, fetch_failed) is visible nowhere else.

export type DebugEvent = {
  at: string;
  event: string;
  action: string | null;
  repo: string;
  number: number | null;
  sender: string | null;
  isBot: boolean;
  decision: string;
  deliveryId: string | null;
  installationId: number | null;
  watches?: boolean;
  draft?: boolean;
  dispatched?: boolean;
  factoryKey?: string;
  error?: string;
};

export type DebugDelivery = {
  deliveryId?: string;
  eventName: string;
  repository: { fullName: string };
  conversation: { number: number };
  sender?: { login: string; type?: string };
  senderLogin?: string;
  installationId?: number;
};

type PullRequestFacts = Pick<DebugEvent, "watches" | "draft" | "dispatched" | "factoryKey" | "error">;

export function debugEvent(input: {
  ctx: DebugDelivery;
  action: string | undefined;
  decision: string;
  at?: string;
  facts?: PullRequestFacts;
}): DebugEvent {
  const { ctx } = input;
  const sender = ctx.sender?.login ?? ctx.senderLogin ?? null;
  const type = ctx.sender?.type?.toLowerCase();
  return {
    at: input.at ?? new Date().toISOString(),
    event: ctx.eventName,
    action: input.action ?? null,
    repo: ctx.repository.fullName,
    number: ctx.conversation.number > 0 ? ctx.conversation.number : null,
    sender,
    isBot: type === "bot" || type === "app" || (sender?.toLowerCase().endsWith("[bot]") ?? false),
    decision: input.decision,
    deliveryId: ctx.deliveryId ?? null,
    installationId: ctx.installationId ?? null,
    ...input.facts,
  };
}

/** The line, and the same decision and factory ticket on the delivery's factory span (lib/factory-otel.ts). */
export function logDebugEvent(event: DebugEvent, log: (line: string) => void = console.log): void {
  log(JSON.stringify({ factoryDebug: "github-event", ...event }));
  noteFactory({ outcome: event.decision, ...(event.factoryKey === undefined ? {} : { ticketKey: event.factoryKey }) });
}

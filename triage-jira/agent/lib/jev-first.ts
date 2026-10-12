import type { FactoryNote } from "./factory-otel.js";
import { stagingRefusesIssue } from "./staging-issue.js";
import type { HostMcpRegistry } from "@cursor/july";
import { statusNames } from "./config.js";
import { inboundKey, jevAnswersKey, stashJevAnswers } from "./inbound.js";
import { projectOf } from "./issue-type.js";
import { JEV_THRESHOLD, allAboveBar, askTriageJev, calibrateJudgment, issueText, readAnswers, templateVerdict, typeContradicted, type InboundIssue } from "./jev-triage.js";
import { recordVerdict, type RecordedVerdict } from "./record-verdict.js";
import { deskFiledOnTracker, type TrackerLook } from "./desk-filed.js";
import { deskTriaged } from "./desk-triaged.js";
import { settled, triageOutcome } from "./triage-outcome.js";
import type { QueueIssue } from "./types.js";
import type { KeyedKv } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

// Jev first, on the wake, before any model turn. When Jev's issue type,
// severity, and needs-info gate are all above JEV_THRESHOLD, the verdict is
// Jev's plus host templates for the prose, recorded the way record_triage
// records one, and the channel starts no turn. Anything else (no key, an
// outage, a timeout, an answer outside the labels, one answer at or under the
// bar, a Story or Task over words that say something is broken now
// (typeContradicted), or a ticket that did not reach Triaged) falls back to the model turn,
// which runs on the root model (agent.ts: LIGHT_MODEL, grok-4.6 fast).
// The answers are stashed so that turn's record_triage does not ask again.

export type JevFirst =
  | { status: "fast"; recorded: RecordedVerdict }
  | { status: "fallback"; reason: "no_key" | "no_text" | "types" | "unavailable" | "labels" | "below_bar" | "type_guard" | "not_settled"; recorded?: RecordedVerdict };

export async function jevFirst(input: {
  issue: QueueIssue;
  mcp: HostMcpRegistry;
  kv: KeyedKv;
  env: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<JevFirst> {
  const { issue } = input;
  const inbound: InboundIssue = {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    ...(issue.reporter === undefined ? {} : { reporter: issue.reporter }),
    ...(issue.issueType === undefined ? {} : { issueType: issue.issueType }),
  };
  const asked = await askTriageJev({
    inbound,
    project: projectOf(issue.identifier),
    mcp: input.mcp,
    kv: input.kv,
    env: input.env,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  if (asked.status === "skipped") return { status: "fallback", reason: asked.reason };
  if (asked.status === "unavailable") {
    await stashJevAnswers(input.kv, issue.identifier, "unavailable");
    return { status: "fallback", reason: "unavailable" };
  }
  const { answers, state, types } = asked;
  // Judged on the delivered text, which the wake always has; stashed so record_triage holds the type even without the inbound stash.
  const typeHeld = typeContradicted({ text: issueText(issue), type: answers.issueType.choice });
  await stashJevAnswers(input.kv, issue.identifier, answers, { typeHeld });
  const verdict = templateVerdict(issue, answers);
  if (verdict === undefined) return { status: "fallback", reason: "labels" };
  if (!allAboveBar(answers)) return { status: "fallback", reason: "below_bar" };
  if (typeHeld) return { status: "fallback", reason: "type_guard" };
  const judged = calibrateJudgment(readAnswers(verdict, state.source, types.source, types.types, answers), issueText(issue));
  if (judged.status !== "judged") return { status: "fallback", reason: "labels" };
  const recorded = await recordVerdict({
    verdict,
    judged: { ...judged, jevOnly: true },
    ...(issue.issueType === undefined ? {} : { currentType: issue.issueType }),
    mcp: input.mcp,
    kv: input.kv,
    purpose: "live",
    continuationKey: issue.identifier,
  });
  const transition = "transition" in recorded ? recorded.transition : undefined;
  if (!settled(triageOutcome(recorded, transition), statusNames(input.env).todo)) return { status: "fallback", reason: "not_settled", recorded };
  // No turn will take the stashes.
  await dropStashes(input.kv, issue.identifier);
  return { status: "fast", recorded };
}

export type TriageWake<T> =
  | { fast: true }
  | { fast: false; sent: T }
  | { fast: false; skipped: "desk_triaged"; via?: "tracker_description" | "desk_triage_comment" | "past_todo" }
  | { fast: false; skipped: "staging_refuses_production" };

const DIAGNOSTIC_TAIL = 80;

/**
 * The wake: Jev first, and a model turn only when Jev does not settle the
 * ticket. A ticket factory-desk filed from Slack was triaged there before it
 * was filed (the desk writes its Triage: comment and moves it to Triaged), so
 * it gets neither: no Jev call, no turn, no second Triage: comment. The
 * delivered description is checked first; when it does not carry the desk's
 * line, the ticket is read back from Jira (deskFiledOnTracker) before
 * anything is judged. Never throws past `send`.
 */
export async function triageWake<T>(input: { issue: QueueIssue; mcp: HostMcpRegistry; kv: KeyedKv; send: () => Promise<T> }): Promise<TriageWake<T>> {
  const { identifier, description } = input.issue;
  if (stagingRefusesIssue(process.env, identifier)) return { fast: false, skipped: "staging_refuses_production" };
  if (deskTriaged(description)) {
    console.log(`[triage] ${identifier} was triaged by factory-desk before filing; not triaging it again`);
    await dropStashes(input.kv, identifier);
    return { fast: false, skipped: "desk_triaged" };
  }
  let look: TrackerLook;
  try {
    look = await deskFiledOnTracker(input.mcp, identifier, { env: process.env, ...(input.issue.status === undefined ? {} : { deliveredStatus: input.issue.status }) });
  } catch (error) {
    look = { skip: false, read: "unread", detail: error instanceof Error ? error.message : String(error) };
  }
  if (look.skip) {
    const via = look.why === "description" ? "tracker_description" : look.why;
    console.log(`[triage] ${identifier} was triaged before this wake (${via}${look.status === undefined ? "" : `, status ${look.status}`}); not triaging it again`);
    await dropStashes(input.kv, identifier);
    return { fast: false, skipped: "desk_triaged", via };
  }
  const tracker = look.read === "read" ? `read${look.status === undefined ? "" : `, status ${look.status}`}` : `unread: ${look.detail}`;
  console.log(`[triage] ${identifier} triaging: description length ${description.length}, ends ${JSON.stringify(description.slice(-DIAGNOSTIC_TAIL))}; tracker ${tracker}`);
  let first: JevFirst;
  try {
    first = await jevFirst({ issue: input.issue, mcp: input.mcp, kv: input.kv, env: process.env });
  } catch (error) {
    console.error(`[triage] Jev-first failed for ${input.issue.identifier}; starting the model turn:`, error);
    first = { status: "fallback", reason: "unavailable" };
  }
  if (first.status === "fast") {
    console.log(`[triage] ${input.issue.identifier} triaged by Jev alone (above ${JEV_THRESHOLD.toFixed(2)}); no model turn`);
    return { fast: true };
  }
  if (first.reason !== "no_key") console.log(`[triage] ${input.issue.identifier} Jev-first fell back (${first.reason}); starting the model turn`);
  return { fast: false, sent: await input.send() };
}

async function dropStashes(kv: KeyedKv, issueKey: string): Promise<void> {
  for (const key of [jevAnswersKey(issueKey), inboundKey(issueKey)]) await kv.delete(key).catch((error: unknown) => warnKv("jev-first.dropStashes", error));
}

/** A wake's result for its `factory.background` span: Jev settled it, it was skipped, or a triage turn was sent. */
export function describeWake<T>(woke: TriageWake<T>): FactoryNote {
  if (woke.fast) return { outcome: "jev_only" };
  return "skipped" in woke ? { outcome: "skipped", reason: woke.skipped } : { outcome: "turn" };
}

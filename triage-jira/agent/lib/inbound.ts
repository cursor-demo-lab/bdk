import type { InboundIssue, JevAnswers } from "./jev-triage.js";
import type { QueueIssue } from "./types.js";
import { inboundKey, jevAnswersKey, type KeyedKv } from "./kv-keys.js";
import { warnKv } from "./ops-funnel.js";

export { inboundKey, jevAnswersKey };

// The webhook keeps the issue as Jira delivered it so record_triage can give
// the Jev judge the reporter's words instead of the model's summary. Read
// and delete: a redelivery stashes it again before its turn starts.

export async function stashInbound(kv: KeyedKv, issue: QueueIssue): Promise<void> {
  const value: InboundIssue = {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    ...(issue.reporter === undefined ? {} : { reporter: issue.reporter }),
    ...(issue.issueType === undefined ? {} : { issueType: issue.issueType }),
  };
  try {
    await kv.put(inboundKey(issue.identifier), value);
  } catch (error) {
    warnKv("inbound.stashInbound", error);
    // Without the stash the judge falls back to the model's title and summary.
  }
}

export async function takeInbound(kv: KeyedKv, identifier: string): Promise<InboundIssue | undefined> {
  let value: unknown;
  try {
    value = await kv.get(inboundKey(identifier));
    if (value !== undefined && value !== null) await kv.delete(inboundKey(identifier));
  } catch (error) {
    warnKv("inbound.takeInbound", error);
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record["identifier"] !== identifier) return undefined;
  const title = typeof record["title"] === "string" ? record["title"] : "";
  const description = typeof record["description"] === "string" ? record["description"] : "";
  const reporter = typeof record["reporter"] === "string" ? record["reporter"] : undefined;
  const issueType = typeof record["issueType"] === "string" ? record["issueType"] : undefined;
  return {
    identifier,
    title,
    description,
    ...(reporter === undefined ? {} : { reporter }),
    ...(issueType === undefined ? {} : { issueType }),
  };
}

// What Jev answered on the wake (jev-first.ts), so a fallback record_triage
// judges the model's verdict without a second TypeSafe call. `unavailable`
// means that call failed or timed out: the fallback does not retry it.

// `typeHeld` records that the wake's type guard fired on the delivered text, so
// record_triage still holds a Story/Task over defect words when the inbound
// stash was lost and it would otherwise read only the model's restatement.
export async function stashJevAnswers(kv: KeyedKv, identifier: string, answers: JevAnswers | "unavailable", options: { typeHeld?: boolean } = {}): Promise<void> {
  try {
    await kv.put(jevAnswersKey(identifier), answers === "unavailable" ? { unavailable: true } : { answers, ...(options.typeHeld === true ? { typeHeld: true } : {}) });
  } catch (error) {
    warnKv("inbound.stashJevAnswers", error);
    // The fallback then asks Jev itself.
  }
}

export async function takeJevAnswers(kv: KeyedKv, identifier: string): Promise<JevAnswers | "unavailable" | undefined> {
  return (await takeJevStash(kv, identifier)).asked;
}

/** The stashed answers and whether the wake's type guard held Jev's type. Read and delete. */
export async function takeJevStash(kv: KeyedKv, identifier: string): Promise<{ asked: JevAnswers | "unavailable" | undefined; typeHeld: boolean }> {
  let value: unknown;
  try {
    value = await kv.get(jevAnswersKey(identifier));
    if (value !== undefined && value !== null) await kv.delete(jevAnswersKey(identifier));
  } catch (error) {
    warnKv("inbound.takeJevStash", error);
    return { asked: undefined, typeHeld: false };
  }
  const typeHeld = value !== null && typeof value === "object" && (value as Record<string, unknown>)["typeHeld"] === true;
  return { asked: readJevAnswers(value), typeHeld };
}

function readJevAnswers(value: unknown): JevAnswers | "unavailable" | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record["unavailable"] === true) return "unavailable";
  const answers = record["answers"];
  if (answers === null || typeof answers !== "object") return undefined;
  const parts = answers as Record<string, unknown>;
  const choice = (key: string) => {
    const part = parts[key];
    return part !== null && typeof part === "object" && typeof (part as Record<string, unknown>)["choice"] === "string";
  };
  return choice("issueType") && choice("severity") && choice("gate") ? (answers as JevAnswers) : undefined;
}

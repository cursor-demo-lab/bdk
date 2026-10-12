// `plan KEY` or `replan KEY`, exactly (a leading mention and approve's Slack
// chrome allowed), from the person who filed KEY, in KEY's thread, sends KEY
// to the planner in host code with no model turn: the same status check,
// triage gate, and move request_plan makes. Success is a ✅ on the command
// and the planner crumb; the plan or Needs info replaces the crumb. A
// refusal (not the filer, another thread, an unbound ticket) gets a fixed
// host reply too (filerGateRefusal), so the command never also wakes the model.

import { randomUUID } from "node:crypto";
import type { SlackBinding, SlackMessage } from "@cursor/july/channels/slack";
import { approveCommandText } from "./approve-command.js";
import { finishLease, releaseLease, takeLease } from "./claim-lease.js";
import { ackCommand } from "./command-ack.js";
import { statusNames } from "./config.js";
import { replyPrefix } from "./desk-channels.js";
import { issueStatus, readCommentRecords } from "./jira.js";
import { moveToPlanner } from "./plan-move.js";
import { showPlannerWait } from "./planner-wait.js";
import { answerRefusal, type FilerGateWhy } from "./host-refusal.js";
import { filerGate } from "./retry-command.js";
import { clearAwaitingFor } from "./thread-detail.js";
import { latestTriageVerdict } from "./triage-comment.js";
import { planCommandKey } from "./kv-keys.js";

const EXACT_PLAN = /^(plan|replan)\s+([A-Za-z][A-Za-z0-9]+-\d+)[.!]*$/i;
const PLAN_LEASE_MS = 60_000;

export type PlanCommand = { verb: "plan" | "replan"; issueKey: string };
export type PlanCommandDeps = { isExternal: (message: SlackMessage) => Promise<boolean>; now?: () => Date };

type Outcome = "not_plan" | "not_eligible" | "duplicate" | "claim_unavailable" | "status_unread" | "moved_on" | "triage_gate" | "not_moved" | "sent_to_planner";
type Decision = { outcome: Outcome; why?: FilerGateWhy; issueKey?: string; verb?: string; status?: string; detail?: string };

export function planCommandTarget(text: string): PlanCommand | undefined {
  const match = EXACT_PLAN.exec(approveCommandText(text));
  return match === null ? undefined : { verb: match[1]!.toLowerCase() as PlanCommand["verb"], issueKey: match[2]!.toUpperCase() };
}

function planCommandFromMessage(message: SlackMessage): PlanCommand | undefined {
  for (const text of [message.text, message.body, message.markdown]) {
    if (typeof text !== "string") continue;
    const command = planCommandTarget(text);
    if (command !== undefined) return command;
  }
  return undefined;
}

/** Returns true when host code answered the message and it needs no model turn. */
export async function takePlanCommand(ctx: SlackBinding, message: SlackMessage, deps: PlanCommandDeps): Promise<boolean> {
  const decision = await plan(ctx, message, deps);
  if (decision.outcome !== "not_plan") console.log(JSON.stringify({ desk: "plan_command", ...decision, channel: ctx.slack.channelId, ts: message.ts }));
  if (decision.outcome === "not_eligible") return answerRefusal(ctx, decision.why!, decision.verb!, decision.issueKey!);
  return decision.outcome !== "not_plan";
}

async function plan(ctx: SlackBinding, message: SlackMessage, deps: PlanCommandDeps): Promise<Decision> {
  const command = planCommandFromMessage(message);
  if (command === undefined) return { outcome: "not_plan" };
  const { issueKey, verb } = command;
  const gate = await filerGate(ctx, message, deps, issueKey);
  if (gate.why !== undefined) return { outcome: "not_eligible", why: gate.why, issueKey, verb };

  const kv = ctx.host.kv;
  const claimKey = planCommandKey({ channelId: ctx.slack.channelId, ts: message.ts });
  const owner = randomUUID();
  const claim = await takeLease(kv, claimKey, { owner, leaseMs: PLAN_LEASE_MS, now: deps.now?.() ?? new Date(), fields: { issueKey } });
  if (claim.status === "done" || claim.status === "held") return { outcome: "duplicate", issueKey, verb };
  const say = (text: string) => ctx.thread.post(text);
  const handle = replyPrefix(ctx.slack.channelId);
  if (claim.status === "unavailable") {
    await releaseLease(kv, claimKey, owner);
    await say(`I could not record your ${verb} for ${issueKey} just now, so nothing moved. Say it again in a minute.`);
    return { outcome: "claim_unavailable", issueKey, verb };
  }
  const decision = await sendToPlanner({ ctx, message, command, handle, say });
  if (decision.outcome === "status_unread") await releaseLease(kv, claimKey, owner);
  else await finishLease(kv, claimKey, owner, { fields: { outcome: decision.outcome } });
  return decision;
}

async function sendToPlanner(input: { ctx: SlackBinding; message: SlackMessage; command: PlanCommand; handle: string; say: (text: string) => Promise<unknown> }): Promise<Decision> {
  const { ctx, message, command, handle, say } = input;
  const { issueKey, verb } = command;
  const statuses = statusNames(process.env);
  const live = await issueStatus(ctx.host.mcp, issueKey);
  if (live.status !== "read") {
    await say(`I could not read ${issueKey} in Jira just now, so nothing moved. Say \`${handle}${verb} ${issueKey}\` again in a minute.`);
    return { outcome: "status_unread", issueKey, verb };
  }
  const current = live.name;
  const is = (name: string) => current.trim().toLowerCase() === name.trim().toLowerCase();
  if (!is(statuses.todo) && !is(statuses.triaged) && !is(statuses.planned)) {
    await say(`${issueKey} is ${current}, past planning, so I did not send it back to the planner.`);
    return { outcome: "moved_on", issueKey, verb, status: current };
  }
  const read = await readCommentRecords(ctx.host.mcp, issueKey).catch(() => undefined);
  const verdict = read?.status === "read" ? latestTriageVerdict(read.comments.map((comment) => comment.body)) : undefined;
  if (verdict?.gate !== undefined) {
    await say(`${issueKey}'s triage verdict is one the planner does not plan (${verdict.gate}), so nothing moved. ${verdict.gate === "needs_info" ? "Reply here with the missing detail and it goes onto the ticket and back to the planner." : "Change the ticket in Jira first."}`);
    return { outcome: "triage_gate", issueKey, verb, status: current, detail: verdict.gate };
  }
  const moved = await moveToPlanner(ctx.host.mcp, { issueKey, current, statuses, kv: ctx.host.kv });
  if (!moved.requested) {
    await say(`I could not send ${issueKey} to the planner (${moved.reason}${moved.current === undefined ? "" : `, it is ${moved.current}`}), so nothing changed.`);
    return { outcome: "not_moved", issueKey, verb, status: current, detail: moved.reason };
  }
  await clearAwaitingFor(ctx.host.kv, issueKey);
  const getClient = () => ctx.host.slack.getClient();
  await ackCommand({ getClient, target: { channel: ctx.slack.channelId || message.channelId, ts: message.ts }, command: "plan KEY", issueKey });
  await showPlannerWait({ kv: ctx.host.kv, getClient, issueKey, phase: "planning" });
  return { outcome: "sent_to_planner", issueKey, verb, status: current, detail: moved.reason };
}

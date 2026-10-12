import type { HostMcpRegistry } from "@cursor/july";
import { defineTool } from "@cursor/july/tools";
import { pinnedIssueKey } from "../lib/chain.js";
import { sandboxRepo, statusNames } from "../lib/config.js";
import { commentOnTicket, issueStatus, readTicket, transitionFrom, type CommentOutcome, type GuardedTransition } from "../lib/jira.js";
import { inProcessPeers } from "../lib/peers.js";
import { rememberOutcome, type PlanOutcome } from "../lib/plan-outcome.js";
import { jiraCloudId } from "../lib/atlassian.js";
import { digestRefusedKey, type KeyedKv } from "../lib/kv-keys.js";
import { digestProblem, fallbackTitle, implementationBrief, jiraComment, oneBase, planKey, planSchema, slackThreadUrl, ticketBrowseUrl, type Plan } from "../lib/plan.js";
import { existingSandboxPaths, type GitHubTreeClient } from "../lib/sandbox.js";
import { bindOpsFunnel, warnKv } from "../lib/ops-funnel.js";

// The brief names the repository, which is read when the plan is recorded.
// Unset scope throws here and names the variable, so the brief never invents one.
function sandbox(): string {
  return sandboxRepo(process.env);
}

function briefFor(plan: Plan, slackUrl?: string): string {
  const ticketUrl = ticketBrowseUrl(plan.issueKey, jiraCloudId(process.env));
  return implementationBrief(plan, { repo: sandbox(), ...(ticketUrl === undefined ? {} : { ticketUrl }), ...(slackUrl === undefined ? {} : { slackUrl }) });
}

function commentFor(plan: Plan, slackUrl?: string): string {
  return jiraComment(plan, sandbox(), ticketBrowseUrl(plan.issueKey, jiraCloudId(process.env)), slackUrl);
}

// The Slack thread a ticket was filed from, so the brief (and the pull
// request it asks for) links back to it. An unreadable ticket plans without it.
async function filingThread(mcp: HostMcpRegistry, issueKey: string): Promise<string | undefined> {
  try {
    const ticket = await readTicket(mcp, issueKey);
    return ticket.status === "read" ? slackThreadUrl([ticket.description, ...ticket.comments]) : undefined;
  } catch {
    return undefined;
  }
}

type Tracker = CommentOutcome | { status: "skipped"; reason: "eval" | "dry_run" | "unverified" | "not_triaged"; issueKey: string };

/** Whether the Slack thread that filed the ticket was told. Only a chained (pinned) plan announces; a desk-requested plan is answered in its own thread. */
type Announce = { status: "posted" | "skipped" | "not_connected" | "failed"; reason?: string };

const DESK_CONNECTION = "desk";

type Recorded = {
  recorded: boolean;
  reason: "recorded" | "eval" | "dry_run" | "unverified" | "paths_missing" | "not_triaged";
  issueKey: string;
  planKey: string;
  artifactId?: string;
  /** True when the session was pinned to the ticket and the key came from it, not from the model. */
  pinned?: boolean;
  tracker: Tracker;
  transition?: GuardedTransition;
  announce?: Announce;
  brief: string;
  missing?: string[];
  hint?: string;
};

export default defineTool({
  description:
    "Record the plan for one Jira ticket: how the touched code works today, why it is that way, the chosen design with the candidates it beat, and the steps. Stores the plan artifact, writes the plan as a comment on the ticket, moves a chained ticket to Planned, and returns the implementation brief the cloud launch starts from. Call it once, after search_sandbox confirmed the claimed failure is on the sandbox and how, why, and architect are done. evidence must be checkout and whereThingsLive must name paths that exist. If the sandbox disagrees, call record_needs_info instead. Exactly one candidate has verdict base. The approach and steps must satisfy every explicit constraint the reporter stated (keep X, a limit, exact copy); list each in why.preserve and never propose changing what they said to keep.",
  inputSchema: planSchema,
  effect: "write",
  dryRunResult: (input) => result(input, { recorded: false, reason: "dry_run" }, skipped({ issueKey: input.issueKey, reason: "dry_run" })),
  async execute(raw, ctx) {
    bindOpsFunnel(ctx.host);
    if (!oneBase(raw.design.candidates)) {
      throw new Error("design.candidates needs exactly one entry with verdict \"base\".");
    }
    let settledRaw = raw;
    const digest = digestProblem(raw);
    if (digest !== undefined) {
      if (!(await secondDigestRefusal(ctx.host.kv, ctx.session.id))) throw new Error(`Not recorded: ${digest.why}`);
      if (digest.field === "title") settledRaw = { ...raw, title: fallbackTitle({ title: raw.title, issueKey: pinnedIssueKey(ctx.session.continuationKey) ?? raw.issueKey, summary: raw.summary }) };
    }
    // A chained session is pinned to its ticket. The plan goes to that ticket
    // whatever key the model typed, the same rule record_triage follows.
    const pinned = pinnedIssueKey(ctx.session.continuationKey);
    const input: Plan = pinned === undefined ? settledRaw : { ...settledRaw, issueKey: pinned };
    const live = ctx.session.purpose !== "eval";
    const remember = async (recorded: Recorded): Promise<Recorded> => {
      if (live) await rememberOutcome(ctx.host.kv, ctx.session.id, outcomeOf(recorded));
      return recorded;
    };
    const blocked = await refuseUnverified(input, ctx);
    if (blocked !== undefined) return remember(blocked);
    if (!live) {
      return result(input, { recorded: false, reason: "eval" }, skipped({ issueKey: input.issueKey, reason: "eval" }));
    }
    if (pinned !== undefined) {
      const late = await supersededPlan(ctx.host.mcp, input);
      if (late !== undefined) return remember(late);
    }
    const slackUrl = await filingThread(ctx.host.mcp, input.issueKey);
    const brief = briefFor(input, slackUrl);
    const comment = commentFor(input, slackUrl);
    const tracker = await commentOnTicket(ctx.host.mcp, { issueKey: input.issueKey, body: comment }, process.env);
    const record = await ctx.artifacts.tag({
      kind: "plan",
      key: planKey(input.issueKey),
      title: `${input.issueKey}: ${input.title}`,
      data: { ...input, brief, comment, repo: sandbox(), tracker: tracker.status },
    });
    const transition = pinned === undefined ? undefined : await moveToPlanned(ctx.host.mcp, { issueKey: input.issueKey, tracker: tracker.status });
    // The artifact id is fixed per ticket; updatedAt is fresh on every tag, so
    // a replan is announced again and a retried peer call is not.
    const changelogId = `${record.id}:${record.updatedAt}`;
    const announce =
      pinned === undefined
        ? { status: "skipped" as const, reason: "desk_requested" }
        : inProcessPeers()
          ? await announceToDesk(ctx.host.mcp, { issueKey: input.issueKey, title: input.title, problem: input.problem, tracker: tracker.status, changelogId })
          : { status: "skipped" as const, reason: "event_bus" };
    return remember({
      ...result(input, { recorded: true, reason: "recorded", artifactId: record.id, pinned: pinned !== undefined }, tracker, brief),
      ...(transition === undefined ? {} : { transition }),
      announce,
    });
  },
});

function outcomeOf(recorded: Recorded): PlanOutcome {
  return {
    tool: "record_plan",
    reason: recorded.reason,
    tracker: recorded.tracker.status,
    ...(recorded.transition === undefined ? {} : { transition: recorded.transition.status }),
    ...(recorded.missing === undefined ? {} : { missing: recorded.missing }),
    ...("message" in recorded.tracker ? { message: recorded.tracker.message } : {}),
  };
}

// Every entry into Triaged opens its own planning session (the claim is per
// transition), so a triage move, a desk bounce, and a replay can all be
// planning one ticket at once. The first to finish plans it. A later one that
// finds the ticket out of Triaged writes nothing: its Plan: comment would
// replace the plan a person already approved, and its move would drag the
// ticket back to Planned.
async function supersededPlan(mcp: HostMcpRegistry, plan: Plan): Promise<Recorded | undefined> {
  const triaged = statusNames(process.env).triaged;
  const current = await issueStatus(mcp, plan.issueKey);
  if (current === undefined || current.trim().toLowerCase() === triaged.trim().toLowerCase()) return undefined;
  return {
    ...result(plan, { recorded: false, reason: "not_triaged", pinned: true }, { status: "skipped", reason: "not_triaged", issueKey: plan.issueKey }, ""),
    transition: { status: "skipped_status", current },
    hint: `${plan.issueKey} is ${current}, not ${triaged}: another plan already landed or the ticket moved on. Nothing was written. Reply that no new plan was recorded and give no brief.`,
  };
}

// The ticket entering Planned is what wakes the desk to announce. It moves
// only from Triaged, whether this call wrote the Plan: comment or found it
// there from an earlier call that died before the move: from any later
// status the move would drag an approved or launched ticket back.
async function moveToPlanned(
  mcp: HostMcpRegistry,
  input: { issueKey: string; tracker: Tracker["status"] }
): Promise<GuardedTransition | undefined> {
  const { issueKey, tracker } = input;
  if (tracker !== "commented" && tracker !== "already_commented") return undefined;
  const statuses = statusNames(process.env);
  return transitionFrom(mcp, { issueKey, from: statuses.triaged, toStatus: statuses.planned });
}

async function announceToDesk(
  mcp: { names(): string[]; callTool(connection: string, tool: string, args?: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: unknown }> },
  input: { issueKey: string; title: string; problem: string; tracker: string; changelogId: string }
): Promise<Announce> {
  if (!mcp.names().includes(DESK_CONNECTION)) return { status: "not_connected" };
  try {
    const called = await mcp.callTool(DESK_CONNECTION, "call_tool", { toolName: "announce_plan", input });
    if (called.isError === true) return { status: "failed", reason: called.content.map((part) => part.text ?? "").join(" ").trim() };
    return announceOutcome(called);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

// announce_plan answers { posted, reason }. A reply that says it did not post
// is a skip or a failure here, not a post, whatever the transport said.
function announceOutcome(called: { content: Array<{ type: string; text?: string }>; structuredContent?: unknown }): Announce {
  const reply = announceReply(called);
  if (reply === undefined) return { status: "posted" };
  const reason = typeof reply["reason"] === "string" ? reply["reason"] : undefined;
  if (reply["posted"] === true) return reason === undefined ? { status: "posted" } : { status: "posted", reason };
  if (reason === "failed") return { status: "failed", reason };
  return reason === undefined ? { status: "skipped" } : { status: "skipped", reason };
}

function announceReply(called: { content: Array<{ type: string; text?: string }>; structuredContent?: unknown }): Record<string, unknown> | undefined {
  const structured = called.structuredContent;
  if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) return structured as Record<string, unknown>;
  const text = called.content.find((part) => part.type === "text" && typeof part.text === "string")?.text;
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function refuseUnverified(
  input: Plan,
  ctx: { workspaceDir?: string; host?: { github?: GitHubTreeClient } }
): Promise<Recorded | undefined> {
  const hint = "Call record_needs_info. Do not invent an implementation plan.";
  const tracker = skipped({ issueKey: input.issueKey, reason: "unverified" });
  if (input.evidence !== "checkout") {
    return { ...result(input, { recorded: false, reason: "unverified" }, tracker, ""), hint };
  }
  if (input.howItWorks.whereThingsLive.length === 0) {
    return {
      ...result(input, { recorded: false, reason: "unverified" }, tracker, ""),
      hint: `${hint} Cite opened paths in howItWorks.whereThingsLive.`,
    };
  }
  const check = await existingSandboxPaths({
    paths: input.howItWorks.whereThingsLive,
    workspaceDir: ctx.workspaceDir,
    env: process.env,
    github: ctx.host?.github,
  });
  if (check.missing.length === 0) return undefined;
  return {
    ...result(input, { recorded: false, reason: "paths_missing" }, tracker, ""),
    missing: check.missing,
    hint: `${hint} Those paths are not on ${check.repo}@${check.ref}.`,
  };
}

function skipped(input: { issueKey: string; reason: "eval" | "dry_run" | "unverified" }): Tracker {
  return { status: "skipped", reason: input.reason, issueKey: input.issueKey };
}

function result(
  plan: Plan,
  outcome: { recorded: boolean; reason: Recorded["reason"]; artifactId?: string; pinned?: boolean },
  tracker: Tracker,
  brief?: string
): Recorded {
  return {
    recorded: outcome.recorded,
    reason: outcome.reason,
    issueKey: plan.issueKey,
    planKey: planKey(plan.issueKey),
    ...(outcome.artifactId === undefined ? {} : { artifactId: outcome.artifactId }),
    ...(outcome.pinned === undefined ? {} : { pinned: outcome.pinned }),
    tracker,
    brief: brief ?? briefFor(plan),
  };
}

/**
 * True when this session's plan was already refused once for its title or
 * summary: the second time, the host uses its own truncated title (and lets a
 * summary stand) rather than refuse again and end the run in Plan stopped.
 * A kv that fails counts as a first refusal.
 */
async function secondDigestRefusal(kv: KeyedKv, sessionId: string): Promise<boolean> {
  const key = digestRefusedKey(sessionId);
  try {
    if ((await kv.get(key)) !== undefined) return true;
    await kv.put(key, { at: new Date().toISOString() });
  } catch (error) {
    warnKv("record_plan.secondDigestRefusal", error);
    // Refused as a first time.
  }
  return false;
}

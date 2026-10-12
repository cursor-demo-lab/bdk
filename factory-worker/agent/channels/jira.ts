import type { HostContext } from "@cursor/july";
import { defineChannel, POST, publicEndpoint, type ChannelHandlerArgsWithBody } from "@cursor/july/channels";
import { z } from "zod";
import { createHandler, createLaunchPipeline, type HandlerDeps } from "../lib/handle.js";
import { backstopImplementPrSweep, hostImplementPrDeps } from "../lib/implement-pr-sweep.js";
import { parseImplementState } from "../lib/implement-turn.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { describeResponse, traced } from "../lib/factory-otel.js";

// `host.github` is the GitHub channel's Cursor account credential (github-proxy
// on api.cursor.com, `pr-write`); the worker opens the implement PR with it.
// The backstop tends lost launches' watches; their own reminders heal them (lib/launch-heal.ts).
//
// An approved ticket's implement agent is a July cloud turn on this channel
// (lib/implement-turn.ts): the route's handler calls `send()` once with the
// sandbox repo attached, and the session's `events` below finish the launch
// when July binds the cloud agent (`agent.bound`: record, Implementing:
// comment, In Progress, PR watch) or report it when the turn fails before
// that and the agent itself is not running (`turn.failed`; a turn can
// outlive its pod's hour-long token while the agent keeps working). A
// direct chat on this channel carries no implement state and the
// handlers ignore it. The handlers get the same host services as the route
// (session-engine.js dispatchEvent `hostForSession`), so the record lands in
// the same kv whichever process runs the session.

/** The pipeline deps a route or a session event builds from the host: kv, tracker, GitHub, reminders, and the SDK pieces the heal keeps. */
export function hostHandlerDeps(host: Pick<HostContext, "kv" | "mcp" | "github" | "reminders">): HandlerDeps & { backstop: () => Promise<unknown> } {
  bindOpsFunnel(host);
  const prDeps = hostImplementPrDeps({ host, mcp: host.mcp });
  return {
    kv: host.kv,
    mcp: host.mcp,
    createAgent: prDeps.createAgent,
    listAgents: prDeps.listAgents,
    retireAgent: prDeps.retireAgent,
    agentStatus: prDeps.agentStatus,
    env: process.env,
    now: () => new Date(),
    github: prDeps.github,
    readRun: prDeps.readRun,
    ...(host.reminders === undefined ? {} : { reminders: host.reminders }),
    backstop: () => backstopImplementPrSweep(prDeps),
  };
}

export default defineChannel({
  auth: [publicEndpoint()],
  routes: [
    POST("/", {
      description:
        "Jira issue_updated webhook (HMAC or Automation header secret). A move into Approved starts one implement cloud turn from the ticket's Brief:; a later one for a launched ticket opens its implement PR once the agent pushed its branch.",
      bodySchema: z.unknown(),
      handler: traced({ span: "factory.delivery", kind: "jira.webhook", describe: describeResponse }, async (request: Request, { host, send, waitUntil }: ChannelHandlerArgsWithBody<unknown>) => {
        const handle = createHandler({ ...hostHandlerDeps(host), send });
        return handle(request, { waitUntil });
      }),
    }),
  ],
  events: {
    "agent.bound": async (event, channel, ctx) => {
      const state = parseImplementState(channel.state);
      if (state === undefined) return;
      await createLaunchPipeline(hostHandlerDeps(ctx.host)).bound(state, event.data);
    },
    "turn.failed": async (event, channel, ctx) => {
      const state = parseImplementState(channel.state);
      if (state === undefined) return;
      // The session carries the agent id once bound (SessionInfo.sdkAgentId); `turnFailed` reads that agent's status before it calls the launch failed.
      await createLaunchPipeline(hostHandlerDeps(ctx.host)).turnFailed(state, event.data, { sdkAgentId: ctx.session.sdkAgentId });
    },
  },
});

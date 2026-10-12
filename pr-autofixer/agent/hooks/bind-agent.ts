import { defineHook } from "@cursor/july/hooks";
import { prRefFromContinuationToken } from "../lib/drive.js";
import { recordPrAgentWhileOpen } from "../lib/affinity.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

export default defineHook({
  events: {
    "agent.bound": async (event, ctx) => {
      bindOpsFunnel(ctx.host);
      const bcId = event.data.sdkAgentId;
      if (!bcId.startsWith("bc-")) {
        return;
      }
      const pr = prRefFromContinuationToken(ctx.channel.continuationToken);
      if (pr === undefined) {
        return;
      }
      await recordPrAgentWhileOpen({ pr, bcId, kv: ctx.host.kv, github: ctx.host.github, continuationToken: ctx.channel.continuationToken });
    },
  },
});

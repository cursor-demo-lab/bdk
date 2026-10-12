import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { readTicket } from "../lib/jira.js";
import { issueKeySchema } from "../lib/plan.js";

export default defineTool({
  description:
    "Read one Jira issue through the host's tracker connection: title, description, and every comment, including the Triage: comment the ticket stage left. Call it once, first, so the plan is written against the ticket and not only the Slack message.",
  inputSchema: z.object({ issueKey: issueKeySchema }),
  effect: "read",
  async execute(input, ctx) {
    if (ctx.session.purpose === "eval") {
      return { status: "skipped", reason: "eval", issueKey: input.issueKey };
    }
    const read = await readTicket(ctx.host.mcp, input.issueKey);
    return { ...read };
  },
});

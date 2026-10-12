import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { plannerCheckout } from "../lib/checkout.js";
import { history } from "../lib/git.js";
import { sandboxHistory } from "../lib/sandbox.js";

export default defineTool({
  description:
    "Recent git history of the sandbox, or of one path inside it: sha, date, author, subject, and the pull request number when the subject carries one. Reads the local checkout when the planner has one, else the commits GitHub lists for FACTORY_SANDBOX_REPO at FACTORY_SANDBOX_REF. This is the why step's code anchor. Read the commits and PR numbers it returns; do not guess history from file contents.",
  inputSchema: z.object({
    path: z.string().optional().describe("Path relative to the repository root. Omit for the whole repository."),
    limit: z.number().int().min(1).max(50).optional().describe("Commits to return, default 20."),
  }),
  effect: "read",
  async execute(input, ctx) {
    const checkout = plannerCheckout(process.env);
    const result =
      checkout === undefined
        ? await sandboxHistory({ ...input, env: process.env, github: ctx.host.github })
        : await history(checkout, input);
    return { ...result };
  },
});

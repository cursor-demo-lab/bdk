import { defineTool } from "@cursor/july/tools";
import { z } from "zod";
import { searchSandbox } from "../lib/sandbox.js";
import { budgetAnswer, refundSearch, SEARCH_BUDGET, spendSearch } from "../lib/search-budget.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";

export default defineTool({
  description:
    `Search the factory sandbox for the feature, path, or error the ticket claims. Reads the session workspace first, then the GitHub tree of FACTORY_SANDBOX_REPO (default the factory's configured repo) at FACTORY_SANDBOX_REF (default main), and fills snippets from those blobs so the claimed failure can be opened without a local checkout. Call it before record_plan. Empty matches or available: false means the claimed failure is not on that ref: call record_needs_info, do not invent an implementation plan. A run gets ${SEARCH_BUDGET} searches and a repeated query is not searched again; searched: false with reason search_budget_spent means record the plan or the Needs info now.`,
  inputSchema: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Feature, path, or error text the ticket claims, for example csv export 500."),
  }),
  effect: "read",
  async execute(input, ctx) {
    bindOpsFunnel(ctx.host);
    const decision = await spendSearch(ctx.host.kv, { sessionId: ctx.session.id, query: input.query });
    if (!decision.search) return budgetAnswer({ decision, query: input.query });
    try {
      return await searchSandbox({
        query: input.query,
        workspaceDir: ctx.workspaceDir,
        env: process.env,
        github: ctx.host.github,
      });
    } catch (error) {
      if (decision.recorded) await refundSearch(ctx.host.kv, { sessionId: ctx.session.id, query: input.query });
      throw error;
    }
  },
});

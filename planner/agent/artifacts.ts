import { defineArtifacts } from "@cursor/july/artifacts";
import { storedPlanSchema } from "./lib/plan.js";

// One artifact kind: the plan for a ticket, keyed `plan:<KEY>` so a re-plan
// replaces the previous record. Host code tags it from `record_plan`; the
// model has no `tag_artifact`. Listed and downloaded over the artifact routes.
export default defineArtifacts({
  kinds: {
    plan: {
      description:
        "The recorded plan for one Jira ticket: how, why, the chosen design, the steps, the brief handed to the cloud launch, the comment written on the ticket, and whether that comment landed.",
      schema: storedPlanSchema,
    },
  },
});

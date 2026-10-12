import { defineAgent } from "@cursor/july";
import { LIGHT_MODEL, factoryFallbacks, factoryModel } from "./lib/config.js";

// The only model turn here is the fallback triage turn when Jev does not
// settle the ticket, so the root model defaults to the light grok-4.6 fast
// variant, not Auto. FACTORY_AGENT_* override it as on every factory host.
const model = factoryModel(process.env, LIGHT_MODEL);

export default defineAgent({
  // Pinned so a default change or a v1 switch cannot recreate the slug and
  // wipe kv (desk dedupe/speaker/one-reply records, pr-autofixer claim leases).
  architecture: "v2",
  // Pinned for the same reason: kv rows live under the agent name, which
  // otherwise follows package.json, so a package rename would hide every
  // record (lib/kv-keys.ts).
  name: "triage-jira",
  model,
  fallbacks: factoryFallbacks(model),
  tools: ["read", "grep", "glob", "ls"],
  local: {
    sandbox: true,
  },
  hosting: {
    secretNames: [
      "FACTORY_ENV",
      "FACTORY_STAGING_ALLOW_PRODUCTION",
      "FACTORY_JIRA_PROJECTS",
      "JIRA_WEBHOOK_SECRET",
      "JIRA_CLOUD_ID",
      "FACTORY_AGENT_MODEL",
      "FACTORY_AGENT_EFFORT",
      "FACTORY_AGENT_SPEED",
      "FACTORY_STATUS_TODO",
      "FACTORY_STATUS_TRIAGED",
      "FACTORY_STATUS_PLANNED",
      "FACTORY_STATUS_APPROVED",
      "FACTORY_STATUS_IN_PROGRESS",
      "FACTORY_STATUS_IN_REVIEW",
      "FACTORY_STATUS_DONE",
      "FACTORY_OPS_SLACK_BOT_TOKEN",
      "FACTORY_OPS_SLACK_CHANNEL",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ],
    // Only the optional ops failure funnel (lib/ops-funnel.ts) posts to Slack from here.
    // OTLP export (agent/otel.ts) goes to the Grafana Cloud stack's gateway in <GRAFANA_REGION>;
    // the endpoint is in lib/factory-otel.ts and only OTEL_EXPORTER_OTLP_HEADERS is a secret.
    egressDomains: ["slack.com", "<GRAFANA_OTLP_HOST>"],
  },
});

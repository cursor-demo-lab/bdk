import { defineAgent } from "@cursor/july";
import { factoryFallbacks, factoryModel } from "./lib/config.js";

const model = factoryModel(process.env);

export default defineAgent({
  // Pinned so a default change or a v1 switch cannot recreate the slug and
  // wipe kv (desk dedupe/speaker/one-reply records, pr-autofixer claim leases).
  architecture: "v2",
  // Pinned for the same reason: kv rows live under the agent name, which
  // otherwise follows package.json, so a package rename would hide every
  // record (lib/kv-keys.ts).
  name: "security-reviewer",
  model,
  fallbacks: factoryFallbacks(model),
  tools: ["read", "grep"],
  local: {
    sandbox: true,
  },
  hosting: {
    secretNames: [
      "FACTORY_ENV",
      "FACTORY_STAGING_ALLOW_PRODUCTION",
      "FACTORY_REPOS",
      "FACTORY_JIRA_PROJECTS",
      "FACTORY_AGENT_MODEL",
      "FACTORY_AGENT_EFFORT",
      "FACTORY_AGENT_SPEED",
      "FACTORY_OPS_SLACK_BOT_TOKEN",
      "FACTORY_OPS_SLACK_CHANNEL",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ],
    // OTLP export (agent/otel.ts) goes to the Grafana Cloud stack's gateway in <GRAFANA_REGION>;
    // the endpoint is in lib/factory-otel.ts and only OTEL_EXPORTER_OTLP_HEADERS is a secret.
    egressDomains: ["api.github.com", "github.com", "slack.com", "otlp.example.com"],
  },
});

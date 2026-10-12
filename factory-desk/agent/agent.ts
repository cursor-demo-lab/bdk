import { defineAgent } from "@cursor/july";
import { LIGHT_MODEL, factoryFallbacks, factoryModel } from "./lib/config.js";

// Off Auto, like triage-jira's fallback turn: every desk turn (the filing prompt, the
// fallback triage when Jev does not settle a request, commands, status
// answers) runs on the light grok-4.6 fast variant. FACTORY_AGENT_* override
// it as on every factory host.
const model = factoryModel(process.env, LIGHT_MODEL);

export default defineAgent({
  // Pinned so a default change or a v1 switch cannot recreate the slug and
  // wipe kv (desk dedupe/speaker/one-reply records, pr-autofixer claim leases).
  architecture: "v2",
  // Pinned for the same reason: kv rows live under the agent name, which
  // otherwise follows package.json, so a package rename would hide every
  // record (lib/kv-keys.ts).
  name: "factory-desk",
  model,
  fallbacks: factoryFallbacks(model),
  tools: [],
  local: { sandbox: true },
  hosting: {
    secretNames: [
      "FACTORY_ENV",
      "FACTORY_STAGING_ALLOW_PRODUCTION",
      "FACTORY_DESK_SLACK_BOT_TOKEN",
      "FACTORY_DESK_SLACK_APP_TOKEN",
      "FACTORY_JIRA_PROJECTS",
      "FACTORY_REPOS",
      "FACTORY_DESK_INTAKE_CHANNEL",
      "FACTORY_DESK_SLACK_HANDLE",
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
    // Web API calls go to slack.com; Socket Mode connects to wss-*.slack.com.
    // An entry is an exact host unless it starts with "*.", so both are needed.
    // Jira goes through the Cursor account connector, not direct egress. The
    // GitHub channel only reads a PR's checks and reviews (channels/github.ts).
    // OTLP export (agent/otel.ts) goes to the Grafana Cloud stack's gateway in <GRAFANA_REGION>;
    // the endpoint is in lib/factory-otel.ts and only OTEL_EXPORTER_OTLP_HEADERS is a secret.
    egressDomains: ["slack.com", "*.slack.com", "api.github.com", "otlp.example.com"],
  },
});

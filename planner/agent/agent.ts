import { defineAgent } from "@cursor/july";
import { cloudPlanning, plannerCheckout } from "./lib/checkout.js";
import { factoryFallbacks, factoryModel } from "./lib/config.js";

// Read-only over a checkout. Off managed hosting every turn is local and
// limited to the read tools below, on FACTORY_PLANNER_CHECKOUT when set. On
// managed hosting (AGENT_SERVE_GENERATION set; lib/checkout.ts cloudPlanning)
// every turn is a Cursor cloud agent, and each planning send attaches
// `cloud.repos` for the sandbox, so the turn reads a real clone; a set
// FACTORY_PLANNER_CHECKOUT fails every planning send there by name, so it is
// not a hosted secret. July refuses cloud turns on an agent that declares
// `tools` (it cannot enforce the list there), so that configuration has
// none: read-only is the instructions plus `autoCreatePR: false` (README
// "Checkout"). The `cloud` block also makes July mount every server tool
// (record_plan, record_needs_info, plan_issue, ...) on each cloud turn as
// the `agentsdk-tools` MCP server over hosting's --cloud-tools-url, so a
// hosted turn calls them on this host while it runs. The same endpoint
// serves the host-only tracker connection (`?connection=tracker`) but does
// not mount it on the turn; the VM reaches it only if it can read the
// agentsdk-tools Authorization header and URL (README "Checkout").
const cloud = cloudPlanning(process.env);
const checkout = cloud ? undefined : plannerCheckout(process.env);

const model = factoryModel(process.env);

export default defineAgent({
  // Pinned so a default change or a v1 switch cannot recreate the slug and
  // wipe kv (desk dedupe/speaker/one-reply records, pr-autofixer claim leases).
  architecture: "v2",
  // Pinned for the same reason: kv rows live under the agent name, which
  // otherwise follows package.json, so a package rename would hide every
  // record (lib/kv-keys.ts).
  name: "planner",
  model,
  fallbacks: factoryFallbacks(model),
  ...(cloud ? { runtime: "cloud" as const } : { runtime: "local" as const, tools: ["read", "grep", "glob", "ls"] }),
  cloud: { autoCreatePR: false },
  local: {
    sandbox: true,
    ...(checkout === undefined ? {} : { workspaceDir: checkout }),
  },
  hosting: {
    secretNames: [
      "FACTORY_ENV",
      "FACTORY_STAGING_ALLOW_PRODUCTION",
      "FACTORY_REPOS",
      "FACTORY_SANDBOX_REPO",
      "FACTORY_SANDBOX_REF",
      "FACTORY_JIRA_PROJECTS",
      "JIRA_WEBHOOK_SECRET",
      "JIRA_CLOUD_ID",
      "FACTORY_AGENT_MODEL",
      "FACTORY_AGENT_EFFORT",
      "FACTORY_AGENT_SPEED",
      "FACTORY_STATUS_TRIAGED",
      "FACTORY_STATUS_PLANNED",
      "FACTORY_OPS_SLACK_BOT_TOKEN",
      "FACTORY_OPS_SLACK_CHANNEL",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ],
    // OTLP export (agent/otel.ts) goes to the Grafana Cloud stack's gateway in <GRAFANA_REGION>;
    // the endpoint is in lib/factory-otel.ts and only OTEL_EXPORTER_OTLP_HEADERS is a secret.
    egressDomains: ["api.github.com", "api.cursor.com", "slack.com", "<GRAFANA_OTLP_HOST>"],
  },
});

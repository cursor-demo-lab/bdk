import { defineAgent } from "@cursor/july";
import { factoryFallbacks, IMPLEMENT_MODEL } from "./lib/config.js";

// The jira channel decides, claims, and launches in host code, and the github
// channel moves the ticket to In Review and Done from its implement PR; no
// model turn runs on either path. The one model turn this agent runs is the
// implement agent itself: each approved ticket's launch is a July cloud turn
// the jira channel starts with a per-send `cloud` attach for the sandbox
// repo (lib/implement-turn.ts), so July attributes its tokens and cost to
// the ticket's session. The agent stays `runtime: "local"` (the default):
// only those sends run on a cloud agent, the way the planner's planning
// sends do (planner lib/checkout.ts planSessionCloud). The `cloud` block is
// attached per send, never here: FACTORY_SANDBOX_REPO is a hosted secret
// bound per request, not when this file loads, and a cloud send with no
// repos lands on a team environment a service account may be refused.
// July refuses a cloud turn on an agent that declares `tools`
// (session-engine.js `buildTurnRequest`: `tools: []` still sets
// `allowedTools`), so this agent declares none; the implement turn gets the
// cloud agent's own tools, and the HTTP session API is gated instead
// (channels/http.ts). instructions.md travels inline as the cloud turn's
// AGENTS.md preamble (session-engine.js `buildTurnRequest`), so it carries the implement
// agent's standing orders as well as the answer to a person who chats
// directly.
//
// `model` is the implement model, not the shared host model
// (`factoryModel`, FACTORY_AGENT_*): a live July send may not carry
// `modelConfig` (0.2.18 model-config.js `modelConfigForDryRun` throws
// unless `dryRun`; docs/deployment-issues.md issue 27), so the cloud turn
// runs whatever this field says (session-engine.js `turnModel`). It is
// `IMPLEMENT_MODEL` (lib/config.ts), read once at load, and the heal's
// `Agent.create` (lib/handle.ts `approve`, lib/launch.ts) sends the same
// constant, so both launch paths always run one variant. FACTORY_WORKER_*
// are not hosted secrets: hosted v2 binds secrets per request, after this
// file has loaded (docs/deployment-issues.md, "agent.ts cannot read
// FACTORY_SANDBOX_REPO at boot"), so the hosted worker runs the default
// variant and the variables apply only where the process starts with them
// (local `serve`). A person who chats directly gets the same model. The
// fallbacks are the shared catalog list minus the primary's id (grok-4.6
// fast, then Auto balanced), as on every host: they engage only when the
// implement model is refused or out of capacity before any output
// (types.d.ts `AgentConfig.fallbacks`), where the alternative is a
// `turn.failed` and one `Launch failed:` line on the ticket.
const model = IMPLEMENT_MODEL;

export default defineAgent({
  // Pinned so a default change or a v1 switch cannot recreate the slug and
  // wipe kv (desk dedupe/speaker/one-reply records, pr-autofixer claim leases).
  architecture: "v2",
  // Pinned for the same reason: kv rows live under the agent name, which
  // otherwise follows package.json, so a package rename would hide every
  // record (lib/kv-keys.ts).
  name: "factory-worker",
  model,
  fallbacks: factoryFallbacks(model),
  // The platform opens autoCreatePR PRs as drafts and Bugbot skips drafts, so
  // the worker opens a ready PR from the agent's branch (lib/implement-pr.ts).
  // The per-send `cloud.repos` merges over this (dist/internal/cloud-merge.js
  // mergeCloudOptions).
  cloud: { autoCreatePR: false },
  local: { sandbox: true },
  hosting: {
    secretNames: [
      "FACTORY_ENV",
      "FACTORY_STAGING_ALLOW_PRODUCTION",
      "FACTORY_SANDBOX_REPO",
      "FACTORY_SANDBOX_REF",
      "FACTORY_JIRA_PROJECTS",
      "JIRA_WEBHOOK_SECRET",
      "JIRA_CLOUD_ID",
      "FACTORY_STATUS_APPROVED",
      "FACTORY_STATUS_IN_PROGRESS",
      "FACTORY_STATUS_IN_REVIEW",
      "FACTORY_STATUS_DONE",
      "FACTORY_OPS_SLACK_BOT_TOKEN",
      "FACTORY_OPS_SLACK_CHANNEL",
      "OTEL_EXPORTER_OTLP_HEADERS",
    ],
    // OTLP export (agent/otel.ts) goes to the Grafana Cloud stack's gateway in <GRAFANA_REGION>;
    // the endpoint is in lib/factory-otel.ts and only OTEL_EXPORTER_OTLP_HEADERS is a secret.
    egressDomains: ["api.cursor.com", "slack.com", "otlp.example.com"],
  },
});

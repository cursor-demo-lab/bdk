# factory-planner

Plans a Triaged ticket the way pstack does (`how`, `why`, `architect`).
It writes no code and opens nothing. Jira writes run on the planner
host, not on the cloud VM.

## What wakes it

Jira Automation rule `factory-planner` POSTs status → Triaged to
`POST /v1/channels/webhook/`
(`planner/agent/channels/webhook.ts`).
Gated on the governing `Triage:` comment: the desk's marked comment,
else the first comment a triage run wrote, unless a later `Triage:`
with no `Triaged by:` line corrects it
(`planner/agent/lib/desk-triaged.ts`).
Question, needs-info, and duplicate verdicts get `Plan stopped:` and no
plan. A `Detail from Slack:` comment after a needs-info verdict answers
it and plans.

No Slack. The GitHub channel is `read` only; its hooks return null. It
exists so host tools can read the sandbox tree
(`planner/agent/channels/github.ts`).

Hosted, `FACTORY_INPROCESS_PEERS` is unset, so triage-jira does not call
`plan_issue`. The Triaged move is the event. Local factory-root `serve`
with `FACTORY_INPROCESS_PEERS=1` can chain inline.

## What it writes

| Where | What |
| --- | --- |
| Jira | `Planning started:`; `Plan:` ending in `Brief:` then Triaged → Planned; or `Needs info:` / `Plan stopped:` (no move) |
| Slack | Nothing (the desk posts the plan) |
| GitHub | Nothing |
| Artifacts | One `plan` record per ticket (`GET /planner/v1/artifacts?kind=plan` on a local serve). The worker reads the `Brief:` from the `Plan:` comment, not this row |

`record_plan` and `record_needs_info` run on the host through
`ctx.host.mcp`
(`planner/agent/host-connections/tracker.ts`).
`planner/agent/hooks/plan-outcome.ts`
writes `Planning started:` on `turn.started` and `Plan stopped:` if a
pinned run ends with neither a plan nor needs-info.

## How it runs

Hosted v2. `@cursor/july` `0.2.22` exactly
(`planner/package.json`).
Default model: Auto (`auto-smart`, `optimize_for=balanced`) unless
`FACTORY_AGENT_*` say otherwise.

Runtime
(`planner/agent/lib/checkout.ts`):

- Off managed hosting: `runtime: "local"`, tools locked to `read`,
  `grep`, `glob`, `ls`. `FACTORY_PLANNER_CHECKOUT` sets
  `local.workspaceDir`.
- On managed hosting (`AGENT_SERVE_GENERATION` set): `runtime: "cloud"`.
  Each planning send attaches `cloud.repos` for
  `FACTORY_SANDBOX_REPO` @ `FACTORY_SANDBOX_REF`.
  `FACTORY_PLANNER_CHECKOUT` is forbidden there (a cloud VM cannot read
  a directory on the planner host) and is not in `hosting.secretNames`.

Host tools `search_sandbox`, `git_history`, and `record_plan` read the
GitHub tree through `githubChannel({ cursorAccount })` when there is no
local checkout. Local override: `FACTORY_GITHUB_TOKEN` / `GITHUB_TOKEN`
/ `GH_TOKEN`.

## Checkout (hosted residual)

Read-only on a hosted cloud turn is instruction-only
(`planner/agent/instructions.md`
"Never") plus `cloud: { autoCreatePR: false }`. July refuses `tools` on
any non-local turn. A hosted turn still reaches:

- Its own clone (it could edit and push; `autoCreatePR: false` only
  stops the platform from opening a PR).
- Its own server tools on the host (`record_plan`, `record_needs_info`,
  `plan_issue`, …) mounted as `agentsdk-tools` while the turn is in
  flight.
- The host's Cursor key in that MCP config. Whether a shell on the VM
  can read it is unknown; see
  [`docs/deployment-issues.md`](../docs/deployment-issues.md) issue 24.
- No `FACTORY_*` secret is sent to the VM.

`planner/agent/channels/http.ts`
refuses principal-bearing HTTP session sends under the hosted posture so
a caller cannot override `cloud`.

## Config and secrets

Names only. `hosting.secretNames` in
`planner/agent/agent.ts`:

`FACTORY_ENV`, `FACTORY_STAGING_ALLOW_PRODUCTION`, `FACTORY_REPOS`,
`FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`, `FACTORY_JIRA_PROJECTS`,
`JIRA_WEBHOOK_SECRET`, `JIRA_CLOUD_ID`, `FACTORY_AGENT_MODEL`,
`FACTORY_AGENT_EFFORT`, `FACTORY_AGENT_SPEED`, `FACTORY_STATUS_TRIAGED`,
`FACTORY_STATUS_PLANNED`, `FACTORY_OPS_SLACK_BOT_TOKEN`,
`FACTORY_OPS_SLACK_CHANNEL`, `OTEL_EXPORTER_OTLP_HEADERS`.

`FACTORY_PLANNER_CHECKOUT` is local only. For a local serve (not hosted):

```bash
git clone https://github.com/cursor-demo-lab/marsbank /tmp/marsbank-sandbox
echo 'FACTORY_PLANNER_CHECKOUT=/tmp/marsbank-sandbox' >> .env.local
```

Optional, not in `hosting.secretNames`:

- `FACTORY_PLANNER_JIRA_PROJECTS` — comment allowlist override
- `FACTORY_CLAIM_SETTLE_MS` — claim settle wait, default 2000; `0` skips it
- `FACTORY_CLAIM_MODE=legacy` — plain read-then-put claim
- `FACTORY_KV_RETRY_PAUSES_MS` — kv retry pauses; empty or `off` turns pauses off

The webhook claims `plan/<KEY>:<Triaged>:<changelog id>` before it sends
(`planner/agent/lib/verified-claim.ts`).
A planning session has no idempotency key; a put slower than the settle
can still start a second session.

## Telemetry

Same factory providers and session flush as the other five hosts
(`planner/agent/otel.ts`,
`planner/agent/hooks/zz-otel-turn-flush.ts`).
`planner/agent/hooks/ticket-key.ts`
tags the session with the ticket key. Export is off until
`OTEL_EXPORTER_OTLP_HEADERS` is set. See the factory README
OpenTelemetry section.

## Deploy

Folder `planner`, slug `factory-planner`. From
``:

```bash
npx -y -p @cursor/july@0.2.22 agent-sdk deploy --ref <full 40-char SHA> --dir planner --slug factory-planner --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
npx -y -p @cursor/july@0.2.22 agent-sdk logs --prod --slug factory-planner --team <CURSOR_TEAM_ID>
```

Jira rule `factory-planner` (transitioned to Triaged) POSTs to
`/v1/channels/webhook/`. Setup:
[`docs/jira-automation.md`](../docs/jira-automation.md).

## Tests

```bash
npm test
npm run check
npm run validate
npx -p @cursor/july@0.2.22 agent-sdk eval --dir . --list
npx -p @cursor/july@0.2.22 agent-sdk eval --dir .
npx -p @cursor/july@0.2.22 agent-sdk call get_plan --dir . --input '{ "issueKey": "TLSSN-42" }'
```

`call`, `eval`, and `serve` need a signed-in host (Jira connection).
`validate`, `info`, `eval --list`, `check`, and `test` do not.

Cases: `planner/evals/plan.eval.ts`
(`records-once`, `no-key-no-plan`, `csv-not-on-sandbox`,
`keeps-reporter-constraints`). Case timeout 300s
(`planner/evals/evals.config.ts`).
Leave `FACTORY_PLANNER_CHECKOUT` unset for evals so seeded workspace
files are what the cases read.

From the factory folder: `mise run test`, `mise run check`,
`mise run validate`. Live: `node scripts/e2e-drive.mjs`,
`scripts/replay-jira-transition.mjs`.

## Limits

- Hosted kv has no compare-and-set. Claim residual: a put slower than
  the settle, or old code mid-deploy, can start two planning sessions.
- `sessions --prod` refuses v2 slugs; `logs --prod` works.
- Hosted cloud-turn residual: see Checkout above and
  [`docs/deployment-issues.md`](../docs/deployment-issues.md) issue 24.
- A `get_plan` record whose `Plan:` comment never landed is
  `found: false` with `unpublished`.
- Nothing replays a missing Automation delivery except `retry KEY` /
  `plan KEY` from the desk or a signed replay script.

Automation spec (shipped `enabled: false`):
`factory-planner.yaml` (not included in this snapshot; lived at `.cursor/automations/` in the old monorepo).

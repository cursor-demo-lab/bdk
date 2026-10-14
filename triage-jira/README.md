# factory-triage-jira

Triages tickets filed in Jira. Desk-filed tickets are skipped: the desk
already wrote `Triage:` and moved them to Triaged.

## What wakes it

Jira Automation rule `factory-triage-jira` POSTs `issue_created` to
`POST /v1/channels/webhook/`
(`triage-jira/agent/channels/webhook.ts`).
No Slack. No GitHub. The same route also accepts a Linear webhook
signature (`LINEAR_WEBHOOK_SECRET`); the factory flow does not use it.

A ticket whose description ends `Triaged in Slack by factory-desk before
filing.` is skipped with no Jev call and no model turn. When the
delivered description does not show that line, the wake reads the ticket
back and still skips if the stored description carries it, the desk's
`Triage:` comment is there, or a ticket created in To Do is already past
it (`triage-jira/agent/lib/jev-first.ts`,
`triage-jira/agent/lib/desk-filed.ts`).
A read that fails or takes over 8 s skips nothing.

Local playground: `POST /v1/channels/queue/issue`
(`triage-jira/agent/channels/queue.ts`).
Connect Jira in Cursor before a playground turn that writes. For a real
`issue_created` webhook, self-host with `JIRA_WEBHOOK_SECRET` pointing at
`POST /<slug>/v1/channels/webhook/`. Hosted Jev needs `TYPESAFE_API_KEY`
on the slug (set after the slug is running, then redeploy); without it
the fallback turn still triages. Steps:
[`docs/jev-host-judge.md`](../docs/jev-host-judge.md).

## What it writes

| Where | What |
| --- | --- |
| Jira | `Triage:` comment (type, severity, `Triaged by:`, `Judge:`); To Do → Triaged; `Triage stopped:` when the fallback turn fails (`triage-jira/agent/hooks/triage-outcome.ts`) |
| Slack | Nothing (the desk announces Triaged) |
| GitHub | Nothing |

Writes go through the host-only tracker. Hosted, `FACTORY_INPROCESS_PEERS`
is unset, so `record_triage` reports `event_bus` and does not call the
planner; the Triaged move is the event the planner wakes on.

## How it runs

Hosted v2. `@cursor/july` `0.2.24` exactly
(`triage-jira/package.json`).
Turns are local. The only model turn is the fallback when Jev does not
settle the ticket: `grok-4.6` with `effort=high`, `fast=true`
(`factoryModel(process.env, LIGHT_MODEL)` in
`triage-jira/agent/agent.ts`),
tools locked to `read`, `grep`, `glob`, `ls`.
`FACTORY_AGENT_MODEL=auto-smart` puts it back on Auto.

Jev first (`triage-jira/agent/lib/jev-triage.ts`,
threshold `0.52`): issue type, severity, needs-info gate. If every
answer is strictly above 0.52, the host records the verdict and exits.
Otherwise the fallback turn's `record_triage` judges with the answers
Jev already gave. A Story or Task the type guard holds back (the report
says something that exists is broken now) also goes to the model.

## Config and secrets

Names only. `hosting.secretNames` in
`triage-jira/agent/agent.ts`:

`FACTORY_ENV`, `FACTORY_STAGING_ALLOW_PRODUCTION`,
`FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET`, `JIRA_CLOUD_ID`,
`FACTORY_AGENT_MODEL`, `FACTORY_AGENT_EFFORT`, `FACTORY_AGENT_SPEED`,
`FACTORY_STATUS_TODO` … `FACTORY_STATUS_DONE`,
`FACTORY_OPS_SLACK_BOT_TOKEN`, `FACTORY_OPS_SLACK_CHANNEL`,
`OTEL_EXPORTER_OTLP_HEADERS`.

`TYPESAFE_API_KEY` comes from the Jev extension
(`triage-jira/agent/extensions/jev.ts`).
Without it, triage keeps working on the model's verdict.

Optional: `FACTORY_INPROCESS_PEERS=1` on a local factory-root `serve`
so `record_triage` calls the planner inline. Leave unset when hosted.

## Telemetry

Same OTel files as the other five hosts (`triage-jira/agent/otel.ts`,
`triage-jira/agent/lib/factory-otel.ts`, `triage-jira/agent/lib/factory-metrics.ts`,
`triage-jira/agent/lib/console-otel.ts`, held identical by
`scripts/copies-parity.test.mjs`). July builds the trace and log providers; the
factory registers one cumulative meter provider.
Export is off until `OTEL_EXPORTER_OTLP_HEADERS` is set. See the factory
README OpenTelemetry section.

## Deploy

Folder `triage-jira`, slug `factory-triage-jira`. From
``:

```bash
npx -y -p @cursor/july@0.2.24 agent-sdk deploy --ref <full 40-char SHA> --dir triage-jira --slug factory-triage-jira --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
npx -y -p @cursor/july@0.2.24 agent-sdk logs --prod --slug factory-triage-jira --team <CURSOR_TEAM_ID>
```

Jira rule `factory-triage-jira` (Work item created) POSTs to
`/v1/channels/webhook/`. Setup:
[`docs/jira-automation.md`](../docs/jira-automation.md).

## Tests

```bash
npm test
npm run check
npm run validate
npx -p @cursor/july@0.2.24 agent-sdk eval --dir . --list
npx -p @cursor/july@0.2.24 agent-sdk eval --dir . --tag smoke
```

Eval sessions skip Jira writes. Cases:
`triage-jira/evals/triage.eval.ts`
(`bug`, `question`, `feedback`, `failure-question`, `feature-question`).

From the factory folder: `mise run test`, `mise run check`,
`mise run validate`. Live: `node scripts/e2e-drive.mjs`.

## Limits

- Hosted kv has no compare-and-set. A redelivery finds its own `Triage:`
  comment and skips; there is no claim key.
- `sessions --prod` refuses v2 slugs; `logs --prod` works.
- The tracker grant must allow editing issues (same account already
  comments and transitions).
- A missed Work item created delivery is not an `issue_updated`
  transition. `scripts/replay-jira-transition.mjs` does not wake this
  slug. Desk `retry KEY` on To Do sends the ticket to the planner
  (`redeliverToPlanner` in
  `factory-desk/agent/lib/retry-command.ts`)
  and can skip a triage verdict; it does not re-POST `issue_created`
  here. Recover the triage hop with a signed `jira:issue_created` to
  `/v1/channels/webhook/` (`scripts/e2e-drive.mjs --only ticket,triage`)
  or, locally, `POST /v1/channels/queue/issue`.

Automation spec (shipped `enabled: false`):
`factory-triage-jira.yaml` (not included in this snapshot; lived at `.cursor/automations/` in the old monorepo).

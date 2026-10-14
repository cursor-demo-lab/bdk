# factory-desk

<img src="assets/logo.png" alt="factory-desk logo" width="96" />

The Slack front door for the factory. It files tickets, relays plan
approvals as a Jira transition, and posts every stage and review update
into the ticket's Slack thread. It launches nothing and holds no sandbox
repository; `factory-worker` launches when a ticket enters Approved.

The Slack app icon is [`assets/logo.png`](assets/logo.png) (1024x1024 PNG).

## What wakes it

| Source | Where | What |
| --- | --- | --- |
| Slack | `#mars-eng-intake` (`C0EXAMPLE1`) and DMs | Mentions, DMs, plain replies in a factory thread, and ✅ / ❌ on the filing prompt or plan post (`factory-desk/agent/channels/slack.ts`) |
| Jira | `POST /v1/channels/jira/` | Status → Triaged, Planned, Approved, In Progress, In Review, Done; factory outcome comments (`factory-desk/agent/channels/jira.ts`) |
| GitHub | `cursorAccount`, `permissions: "read"` | `pull_request`, `check_suite`, `workflow_run`, `pull_request_review` — review updates only; no GitHub writes (`factory-desk/agent/channels/github.ts`) |
| Schedule | `hop-watch` every 5 minutes | Hop watchdog sweep (`factory-desk/agent/schedules/hop-watch.ts`) |

A new request is a top-level mention (or DM) with a filing phrase. Inside
a factory thread, reply with plain text. Do not mention the bot.

## What it writes

| Where | What |
| --- | --- |
| Jira | Creates the issue; `Triage:` comment; To Do → Triaged; Planned → Approved; `Denied in Slack by <name>`; `Detail from Slack:`; `Slack thread:` backlink |
| Slack | Filing prompt, Filed post, plan post, In Progress / In Review / Done, review-update gate lines, hop-watch lines; one stage emoji on the thread root |
| GitHub | Nothing |

Jira writes go through the host-only tracker
(`factory-desk/agent/host-connections/tracker.ts`).
The model never sees a Jira or GitHub tool. Four model tools:
`file_ticket`, `approve_ticket`, `deny_ticket`, `request_plan`
(`factory-desk/agent/tools/`).

Lifecycle announcements are host code in
`factory-desk/agent/lib/announce.ts`,
not tools.

## Slack

In a factory thread, one plain-text reply or one reaction is enough.
Never mention the bot for these.

| Reply | Effect |
| --- | --- |
| `approve file` / `deny file` | File the ticket as triaged, or drop it |
| `approve` | Approve the plan when the thread maps to exactly one ticket; otherwise the desk asks for `approve KEY` |
| `approve KEY` / `deny KEY` | Planned → Approved, or a `Denied in Slack` comment (ticket stays Planned) |
| `plan KEY` / `replan KEY` | Send the ticket back to the planner. Host code moves nothing (`triage_gate`) when the governing `Triage:` verdict is one the planner skips (question, unanswered needs-info, duplicate) (`factory-desk/agent/tools/request_plan.ts`) |
| `retry KEY` | Redeliver a stalled hop without launching twice. On To Do or Triaged this sends the planner; it does not re-POST `issue_created` to triage-jira (`factory-desk/agent/lib/retry-command.ts`) |
| `fix` / `fix <PR>` | Fixed reply: type `factory: drive` on the PR yourself. No model turn, no GitHub write (`factory-desk/agent/lib/fix-request.ts`) |
| a reply to a Needs info line | Added as `Detail from Slack:` and replanned |

| Reaction | On the filing prompt | On the plan post |
| --- | --- | --- |
| ✅ | Same as `approve file` | Same as `approve KEY` |
| ❌ | Same as `deny file` | Same as `deny KEY` |

Each approval is a single action: one ✅ or one text reply. A ✅ and a
typed approve of the same ticket approve once. Approve and deny never
both land. Only the person who filed the ticket, in that ticket's
thread, can approve, deny, retry, or replan. A Jira-filed ticket has no
Slack filer; approve it on the board.

Anyone else is ignored with no reply. Only a filing prompt or plan post
the desk recorded when it posted it counts. The stage emoji on the
thread root approves nothing.

The Slack app needs a 0.2.11-or-later manifest (`reaction_added` and
`reactions:read`). Hosted v2 delivers `reaction_added` since July 0.2.11
([`docs/reaction-approvals.md`](../docs/reaction-approvals.md); the
comment in
`factory-desk/agent/lib/reaction-approval.ts`
names 0.2.13 as the current package). Manifest and doctor:
[`docs/slack-and-github-setup.md`](../docs/slack-and-github-setup.md).

Review updates use one line per gate, in `COMPONENT_ORDER`: 🔧 Autofix,
🐛 Bugbot, 🔒 Security review, 🏗️ CI, 📡 Change review
(`factory-desk/agent/lib/review-update.ts`).
CI is announced only from the `github-actions` `check_suite`. An
unchanged security verdict is not reposted after a new push. Change
review never shows ⚠️ from a comment alone, only from a check run's
conclusion. A 📡 line can append `(services: …)` from the change-monitor
marker, minus the six factory deploy slugs and their `-staging` twins
(`FACTORY_HOST_SERVICES` in
`factory-desk/agent/lib/review-update.ts`).
The thread-root stage emoji includes 🚫 when a plan is declined
(`no_entry_sign` in
`factory-desk/agent/lib/status-reaction.ts`).

## How it runs

Hosted v2 (`architecture: "v2"`, `name: "factory-desk"`).
`@cursor/july` `0.2.24` exactly
(`factory-desk/package.json`).
Every turn is local. Default model: `grok-4.6` with `effort=high`,
`fast=true` (`factoryModel(process.env, LIGHT_MODEL)` in
`factory-desk/agent/agent.ts`).
`FACTORY_AGENT_MODEL=auto-smart` puts it back on Auto.

Triage before filing: host code asks Jev
(`factory-desk/agent/lib/jev-triage.ts`,
threshold `0.52`). If every answer is strictly above 0.52, that verdict
is used and no model turn is needed for triage. Otherwise a grok-4.6-fast
turn fills the gaps. Scores never appear in Slack.

## Config and secrets

Names only. `hosting.secretNames` in
`factory-desk/agent/agent.ts`:

`FACTORY_ENV`, `FACTORY_STAGING_ALLOW_PRODUCTION`,
`FACTORY_DESK_SLACK_BOT_TOKEN`, `FACTORY_DESK_SLACK_APP_TOKEN`,
`FACTORY_JIRA_PROJECTS`, `FACTORY_REPOS`, `FACTORY_DESK_INTAKE_CHANNEL`,
`FACTORY_DESK_SLACK_HANDLE`, `JIRA_WEBHOOK_SECRET`, `JIRA_CLOUD_ID`,
`FACTORY_AGENT_MODEL`, `FACTORY_AGENT_EFFORT`, `FACTORY_AGENT_SPEED`,
`FACTORY_STATUS_TODO` … `FACTORY_STATUS_DONE`,
`FACTORY_OPS_SLACK_BOT_TOKEN`, `FACTORY_OPS_SLACK_CHANNEL`,
`OTEL_EXPORTER_OTLP_HEADERS`.

`TYPESAFE_API_KEY` comes from the Jev extension
(`factory-desk/agent/extensions/jev.ts`),
not from `agent.ts`. GitHub uses `githubChannel({ cursorAccount })`; no
GitHub token secret.

Optional overrides, not in `hosting.secretNames` (set with
`agent-sdk secrets set` if needed):

- `FACTORY_DESK_JIRA_PROJECT` — create in this project; else the first of
  `FACTORY_JIRA_PROJECTS` (`factory-desk/agent/lib/jira.ts`)
- `FACTORY_DESK_CLAIM_SETTLE_MS` — claim settle wait, integer 0–10000 ms
  (default 2000; `0` skips it; above 10000 falls back to 2000)
- `FACTORY_KV_RETRY_PAUSES_MS` — kv retry pauses; empty or `off` turns pauses off
- `FACTORY_INDEX_MERGE=off` — plain read-then-put for `hop-watch/index`
- `FACTORY_DESK_RECHECK_LEASE=off` — plain `{ until }` review-recheck record
- `FACTORY_INPROCESS_PEERS` — local `serve` only; leave unset when hosted

## Telemetry

July builds the trace and log providers from the config
`factory-desk/agent/otel.ts` hands it (`factory-desk/agent/lib/factory-otel.ts`).
The factory registers one cumulative meter provider before July starts
(`factory-desk/agent/lib/factory-metrics.ts`), because July's metric exporters
are DELTA and Grafana Cloud rejects them, and sends its console lines through
July's logger (`factory-desk/agent/lib/console-otel.ts`). July flushes its
providers after each hosted delivery, at most 1 s; a pod destroyed within 10 s
of its last turn loses that interval's metrics. Export is off until
`OTEL_EXPORTER_OTLP_HEADERS` is set. Shared by all six hosts. See the factory
README OpenTelemetry section and
[`docs/factory-deployment.md`](../docs/factory-deployment.md#11-opentelemetry-export-grafana-cloud).

## Deploy

Folder `factory-desk`, slug `factory-desk`. From
`` after `npm ci` in this folder:

```bash
npx -y -p @cursor/july@0.2.24 agent-sdk deploy --ref <full 40-char SHA> --dir factory-desk --slug factory-desk --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
npx -y -p @cursor/july@0.2.24 agent-sdk logs --prod --slug factory-desk --team <CURSOR_TEAM_ID>
```

Order across the six hosts:
[`docs/factory-deployment.md`](../docs/factory-deployment.md).

Jira rules `factory-desk` (status changes) and `factory-desk-comments`
(Comment added) POST to `/v1/channels/jira/`. Setup:
[`docs/jira-automation.md`](../docs/jira-automation.md).

## Tests

```bash
npm test          # agent/**/*.test.ts and evals/**/*.test.ts
npm run check
npm run validate
npx -p @cursor/july@0.2.24 agent-sdk eval --dir . --list
npx -p @cursor/july@0.2.24 agent-sdk eval --dir . --tag smoke
npm run eval:jev-triage -- --runs 3
```

`eval:jev-triage` reads `TYPESAFE_API_KEY` from the environment or
`.env.local`. Do not put the value in this file.

Eval sessions short-circuit every write tool. Cases live in
`factory-desk/evals/desk.eval.ts` and
`factory-desk/evals/gates.eval.ts`
(`pasted-instruction`). Jev eval:
[`evals/jev-triage/README.md`](evals/jev-triage/README.md).

From the factory folder: `mise run test`, `mise run check`,
`mise run validate`. Live: `node scripts/e2e-drive.mjs`,
`scripts/replay-jira-transition.mjs`, `scripts/replay-jira-comment.mjs`.

## Hop watch

If triage or plan leaves no Jira artifact within 15 minutes, or a launch
within 7, the thread gets one line naming the hop and offering
`retry KEY`. The deadline watch never retries on its own
(`factory-desk/agent/lib/hop-watch.ts`).
A To Do (triage) hop's `retry KEY` still sends the planner; recover a
missed `issue_created` as in the triage-jira README.

The plan hop also has a start check 4 minutes after Triaged
(`PLAN_START_DEADLINE_MS`,
`factory-desk/agent/reminders/plan_start.ts`).
If the planner never wrote `Planning started:`, the desk re-sends the
ticket once, then stops. A second silence asks for a planner redeploy or
`retry KEY`.

Hosted v2 fires `hop-watch` from the deploy manifest (July 0.2.13+). The
deploy CLI and the runtime must both be 0.2.24.

## Limits

- Hosted kv has get, put, delete only (no compare-and-set). Claims use
  read, put, read-back, and a settle wait
  (`factory-desk/agent/lib/claim-lease.ts`,
  `factory-desk/agent/lib/kv-verified.ts`).
  The `putIfAbsent` branches never run in production.
- `sessions --prod` refuses v2 slugs; `logs --prod` and `session` work.
- Slack `setTitle not-ok error=no_permission` still needs
  `withAgentSession` (`factory-desk/agent/lib/agent-session.ts`).
- `users.info` cache still needs
  `factory-desk/agent/lib/july-user-cache.ts`.
- Nothing replays a missing Jira Automation delivery except `retry KEY`
  or a signed `scripts/replay-jira-transition.mjs`. A To Do / Triaged
  `retry KEY` sends the planner; it does not re-wake triage-jira.
- Serve `--dev` never fires `hop-watch` or named reminders. POST
  `/v1/dev/schedules/hop-watch` or `/v1/dev/reminders/<id>`
  (`factory-desk/agent/schedules/hop-watch.ts`).

Automation spec (shipped `enabled: false`):
`factory-desk.yaml` (not included in this snapshot; lived at `.cursor/automations/` in the old monorepo).

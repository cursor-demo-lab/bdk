# factory-worker

Implements an Approved ticket. It launches one Cursor cloud agent on the
sandbox, prompted with the `Brief:` from the ticket's latest `Plan:`
comment. The worker, not the cloud agent, opens the implement PR. It
never merges.

## What wakes it

| Source | Where | What |
| --- | --- | --- |
| Jira | `POST /v1/channels/jira/` | Status → Approved (`factory-worker/agent/channels/jira.ts`) |
| GitHub | `cursorAccount`, `permissions: "pr-write"` | `pull_request` on the implement PR: In Review on open, Done on a person's merge (`factory-worker/agent/channels/github.ts`) |
| Reminders | `implement_launch`, `implement_pr` | Heal a lost launch; open the PR once the agent pushes a branch |

No Slack. No schedule file: hosted v2 fires only schedules the deploy
manifest lists, and the worker lists none. A throttled backstop sweep
runs from Jira deliveries, PR tasks, and reminder fires.

## What it writes

| Where | What |
| --- | --- |
| Jira | `Implementing: <url>` then Approved → In Progress; `Pull request: <url>` then In Progress → In Review; `Merged by: <login>` then In Review → Done; `Launch failed:` / `Launch pending:` / `Launch skipped:` / `Approved without a plan` / `<status> not set from` |
| GitHub | Opens the implement PR (`draft: false`); marks a leftover draft ready; writes leading `Jira:` / `Slack:` lines. No comments, reviews, reactions, or merges |
| Slack | Nothing (the desk announces In Progress / In Review / Done) |

Every Jira write runs on the host through
`factory-worker/agent/host-connections/tracker.ts`
and `factory-worker/agent/lib/jira.ts`.
The cloud agent is told not to open a PR, merge, enable auto-merge, or
force-push (`factory-worker/agent/lib/launch.ts`
`prHandoff`).

Done moves only for a merge by a person (`GitHub type User`, no
`[bot]`, `auto_merge` not set). A bot merge or auto-merge moves nothing.

## How it runs

Hosted v2 (`architecture: "v2"`, `name: "factory-worker"`).
`@cursor/july` `0.2.24` and `@cursor/sdk` `1.0.37` exactly
(`factory-worker/package.json`).
The agent stays `runtime: "local"` and declares no `tools` (July refuses
a cloud turn on an agent that declares them).

The implement run is a July cloud turn
(`factory-worker/agent/lib/implement-turn.ts`):
the Jira delivery calls the channel's `send()` once with a per-send
`cloud: { repos: [sandbox], autoCreatePR: false }` and continuation
`implement:<KEY>#<changelogId>`. July creates the agent with the pod's
`CURSOR_API_KEY`. Tokens and cost land under `factory.ticket.key`
(`factory-worker/agent/hooks/ticket-key.ts`).

The launch heal (a reminder with no channel `send`) still uses
`Agent.create` with `idempotencyKey: "implement/<KEY>"`.

Model is `IMPLEMENT_MODEL` (`workerModel()` read once at load in
`factory-worker/agent/lib/config.ts`):
default `claude-opus-5-5`, `context=300k`, `effort=high`, `fast=false`.
The worker reads no `FACTORY_AGENT_*`. `FACTORY_WORKER_MODEL` /
`_CONTEXT` / `_EFFORT` / `_FAST` apply to a local `serve` only: hosted
v2 binds secrets after `agent.ts` loads, so the hosted worker runs the
default. A live July 0.2.18 send may carry no `modelConfig`
([`docs/deployment-issues.md`](../docs/deployment-issues.md) issue 27),
so the turn takes `agent.ts`'s model.

No decision runs on a model turn. The Jira route verifies, claims
`implement/<KEY>`, launches, comments, and moves in host code
(`factory-worker/agent/lib/handle.ts`).

## The implement PR

The worker opens the PR
(`factory-worker/agent/lib/implement-pr.ts`).
A launch arms a reminder (first check at 10 min, then every 5 min for
up to 8 h). Title starts `KEY: `; body starts with `Jira:` and `Slack:`.
`draft: false` into `FACTORY_SANDBOX_REF` (Bugbot skips drafts). An
open PR from the branch is reused and marked ready unless a person
drafted it. A PR a person closed is never reopened.

`retry KEY` on an In Progress ticket with an `Implementing:` comment
moves it back to Approved; the worker opens the PR from the branch
already pushed.

## Lost launches

If an Approved delivery claims and then dies before `Implementing:`
lands, `implement-launch/<KEY>` plus an `implement_launch` reminder
relaunches about 4 minutes later
(`factory-worker/agent/lib/launch-watch.ts`,
`factory-worker/agent/lib/launch-heal.ts`).
The desk's launch hop watch speaks at 7 minutes if that did not land
either. A delivery that never reaches the worker leaves no watch;
`retry KEY` is the path for that.

## Config and secrets

Names only. `hosting.secretNames` in
`factory-worker/agent/agent.ts`:

`FACTORY_ENV`, `FACTORY_STAGING_ALLOW_PRODUCTION`,
`FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`, `FACTORY_JIRA_PROJECTS`,
`JIRA_WEBHOOK_SECRET`, `JIRA_CLOUD_ID`, `FACTORY_STATUS_APPROVED`,
`FACTORY_STATUS_IN_PROGRESS`, `FACTORY_STATUS_IN_REVIEW`,
`FACTORY_STATUS_DONE`, `FACTORY_OPS_SLACK_BOT_TOKEN`,
`FACTORY_OPS_SLACK_CHANNEL`, `OTEL_EXPORTER_OTLP_HEADERS`.

GitHub uses `githubChannel({ cursorAccount })`; no GitHub token secret.

Optional, not in `hosting.secretNames`:

- `FACTORY_CLAIM_SETTLE_MS` — claim settle wait, default 2000; `0` skips it
- `FACTORY_CLAIM_MODE=legacy` — plain read-then-put claim
- `FACTORY_KV_RETRY_PAUSES_MS` — kv retry pauses; empty or `off` turns pauses off
- `FACTORY_INDEX_MERGE=off` — plain read-then-put for `implement-pr-watch/index`
- `FACTORY_WORKER_*` — local `serve` only (see How it runs)
- `FACTORY_STATUS_TODO`, `_TRIAGED`, `_PLANNED` — names a merge re-syncs from; not hosted secrets
- `FACTORY_TRACKER_RETRY_MS` — connector listing retries

## Telemetry

Same OTel files as the other five hosts (`factory-worker/agent/otel.ts`,
`factory-worker/agent/lib/factory-otel.ts`, `factory-worker/agent/lib/factory-metrics.ts`,
`factory-worker/agent/lib/console-otel.ts`, held identical by
`scripts/copies-parity.test.mjs`). July builds the trace and log providers; the
factory registers one cumulative meter provider.
The July cloud turn's tokens and cost carry `factory.ticket.key`. An
`Agent.create` heal is invisible to July. A turn over 60 minutes loses
its tokens to telemetry (the pod's `CURSOR_API_KEY` is a 60-minute
token). Export is off until `OTEL_EXPORTER_OTLP_HEADERS` is set. See the
factory README OpenTelemetry section.

## Deploy

Folder `factory-worker`, slug `factory-worker`. From
``:

```bash
npx -y -p @cursor/july@0.2.24 agent-sdk deploy --ref <full 40-char SHA> --dir factory-worker --slug factory-worker --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
npx -y -p @cursor/july@0.2.24 agent-sdk logs --prod --slug factory-worker --team <CURSOR_TEAM_ID>
```

Jira rule `factory-worker` (transitioned to Approved) POSTs to
`/v1/channels/jira/`. Setup:
[`docs/jira-automation.md`](../docs/jira-automation.md).

The deploy warning `missing_agent_session_stopped_event_subscription` is
expected: 0.2.18 has no agent-session channel. The implement-PR watch
covers a stopped run.

## Tests

```bash
npm test
npm run check
npm run validate
node ../scripts/replay-jira-transition.mjs http://127.0.0.1:3000/factory-worker/v1/channels/jira/ TLSSN-42 Approved
```

No eval cases (`factory-worker/evals/`
has only a config). `npm test` includes claim races, launch-heal, and
implement-PR tests. From the factory folder: `mise run test`,
`mise run check`, `mise run validate`. Live: `node scripts/e2e-drive.mjs`.

The replay URL above is the factory-root `serve` mount. `serve --dir
factory-worker --mode single` has no mount: POST
`http://127.0.0.1:3000/v1/channels/jira/`
(`factory-worker/AGENTS.md`).

## Limits

- Hosted kv has no compare-and-set. Two concurrent approvals launch once
  unless a put lands later than the settle. Whether `idempotencyKey`
  collapses two concurrent `Agent.create` calls is unverified.
- `sessions --prod` refuses v2 slugs; `logs --prod` works.
- A launch frozen with its pod whose create had not reached the agents
  API when the heal listed agents can still produce a second agent.
  Only one is recorded and commented.
- HTTP session API is gated on hosted
  (`factory-worker/agent/channels/http.ts`).
- Nothing replays a missing Automation delivery except `retry KEY` or a
  signed replay script.
- `Launch pending:` on the ticket means this approval launched nothing
  and a later try can still do it
  (`factory-worker/agent/lib/decide.ts`
  `launchPendingComment`). When a reminder is armed, the line says the
  worker relaunches on its own if no `Implementing:` comment follows
  within about 4 minutes. When no reminder could be set yet, the line
  says the worker sets one on the next Approved move or pull request; if
  no `Implementing:` follows within about 4 minutes, move the card to
  Approved again
  ([`docs/factory-deployment.md`](../docs/factory-deployment.md),
  [`docs/jira-automation.md`](../docs/jira-automation.md)).

Automation spec (shipped `enabled: false`):
`factory-worker.yaml` (not included in this snapshot; lived at `.cursor/automations/` in the old monorepo).

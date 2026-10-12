# factory-pr-autofixer

Attaches a factory pull request to a Cursor cloud agent and pushes
verified fixes toward merge. It never merges, enables auto-merge, or
force-pushes. No Slack channel; `factory-desk` is the factory's only
Slack app.

## What wakes it

GitHub (`cursorAccount`, `permissions: "contents-write"`,
`pr-autofixer/agent/channels/github.ts`):

- First red `check_suite` / `workflow_run` (also `check_run` and commit
  `status` when those arrive) on a factory PR
- A person's `factory: drive` comment (`OWNER`, `MEMBER`, or
  `COLLABORATOR`; any bot is refused)
- Bugbot findings: a `neutral` `Cursor Bugbot` check run, at most
  `BUGBOT_MAX_ROUNDS` (2) per PR
  (`pr-autofixer/agent/lib/auto-drive.ts`)
- Later comment, review, and failing-CI events resume a PR already driven
- Closing a PR cleans up its `host.kv`
  (`pr-autofixer/agent/lib/close-cleanup.ts`)

Opening a PR does not start a session by itself. Hosted v2 forwards
`check_suite` and `workflow_run`; `check_run` / `status` may not arrive
([`docs/deployment-issues.md`](../docs/deployment-issues.md) issue 12).

HTTP: `POST /v1/channels/drive` with `{ "pr": "https://github.com/…/pull/N" }`
(`pr-autofixer/agent/channels/drive.ts`).
Playground: paste a PR URL; the local agent calls `drive_pr`.

A factory PR is one whose head branch starts with a key in
`FACTORY_JIRA_PROJECTS` (or `PR_AUTOFIXER_AUTO_DRIVE_PROJECTS`), or
whose title does and `cursor[bot]` opened it. A person's title-only key
is not driven (`title_only_from_person`); it needs `factory: drive`.

Asked in Slack to fix a PR, the desk replies "type `factory: drive` on
the PR yourself" and writes nothing to GitHub.

## What it writes

| Where | What |
| --- | --- |
| GitHub | Pushes verified fixes to the PR head; one cap note when Bugbot rounds are spent |
| Jira | Nothing |
| Slack | Nothing |

## How it runs

Hosted v2. `@cursor/july` `0.2.22` exactly
(`pr-autofixer/package.json`).
Chat stays local. Work runs on a cloud VM
(`cloud: { env: { type: "cloud" }, autoCreatePR: false }` in
`pr-autofixer/agent/agent.ts`).
Default model: Auto (`auto-smart`, `optimize_for=balanced`) unless
`FACTORY_AGENT_*` say otherwise.

The automatic drive claims the PR in `host.kv` as a lease
(`pr-autofixer/agent/lib/claim-lease.ts`).
While a drive is in flight the claim is retaken after 10 minutes; once
accepted it is held for 2 hours. A turn that errors releases the claim
for that session only
(`pr-autofixer/agent/hooks/drive-claim.ts`).

## Config and secrets

Names only. `hosting.secretNames` in
`pr-autofixer/agent/agent.ts`:

`FACTORY_ENV`, `FACTORY_STAGING_ALLOW_PRODUCTION`, `FACTORY_REPOS`,
`FACTORY_JIRA_PROJECTS`, `FACTORY_AGENT_MODEL`, `FACTORY_AGENT_EFFORT`,
`FACTORY_AGENT_SPEED`, `FACTORY_OPS_SLACK_BOT_TOKEN`,
`FACTORY_OPS_SLACK_CHANNEL`, `OTEL_EXPORTER_OTLP_HEADERS`.

GitHub uses `githubChannel({ cursorAccount })`; no GitHub token secret.

Optional overrides, not in `hosting.secretNames` (read per request):

- `PR_AUTOFIXER_REPOS` — repo allowlist override of `FACTORY_REPOS`
- `PR_AUTOFIXER_AUTO_DRIVE_PROJECTS` — project-key override of
  `FACTORY_JIRA_PROJECTS`
- `FACTORY_FIXER_CLAIM_SETTLE_MS` — drive-claim settle, default 2000; `0` skips it
- `FACTORY_FIXER_CLOSE_CLEANUP=off` — close releases the claim only
- `FACTORY_FIXER_ROUNDS_MERGE=off` — plain puts for Bugbot rounds
- `FACTORY_KV_RETRY_PAUSES_MS` — kv retry pauses; empty or `off` turns pauses off

A PR outside `PR_AUTOFIXER_REPOS` / `FACTORY_REPOS` is refused
`out_of_scope` before any GitHub read. A red check on a factory PR
outside that list fails the delivery (the list is what is wrong).

## Telemetry

Same factory providers and session flush as the other five hosts
(`pr-autofixer/agent/otel.ts`,
`pr-autofixer/agent/hooks/zz-otel-turn-flush.ts`).
Export is off until `OTEL_EXPORTER_OTLP_HEADERS` is set. See the factory
README OpenTelemetry section.

## Deploy

Folder `pr-autofixer`, slug `factory-pr-autofixer`. From
``:

```bash
npx -y -p @cursor/july@0.2.22 agent-sdk deploy --ref <full 40-char SHA> --dir pr-autofixer --slug factory-pr-autofixer --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
npx -y -p @cursor/july@0.2.22 agent-sdk logs --prod --slug factory-pr-autofixer --team <CURSOR_TEAM_ID>
```

No Jira rule.

## Tests

```bash
npm test
npm run check
npm run validate
npx -p @cursor/july@0.2.22 agent-sdk eval --dir . --list
npx -p @cursor/july@0.2.22 agent-sdk eval --dir .
```

Smoke case: `pr-autofixer/evals/coordinator.eval.ts`
(`no-pr`: chat without a PR does not call `drive_pr`). Timing tests:
`pr-autofixer/agent/channels/github-timing.test.ts`.
From the factory folder: `mise run test`, `mise run check`,
`mise run validate`. Live: `node scripts/e2e-drive.mjs`.

## Limits

- Hosted kv has no compare-and-set. Two red events that race on an empty
  claim yield one drive unless a write lands after the other's settle.
- Bot comments (Bugbot, the security review) never start a drive by
  themselves except the Bugbot-findings path above. Findings on a green
  PR stay unfixed unless a person types `factory: drive` or Bugbot
  reports findings.
- Nothing redelivers a GitHub event the fixer failed on. After a
  release, the next red check or `factory: drive` starts a new drive.
  To re-drive inside the 2-hour hold, close and reopen the PR, then
  comment `factory: drive` or wait for the next red check.
- If the GitHub head read fails three times, the delivery fails with
  `[pr-autofixer] auto-drive: could not read <pr> from GitHub after 3 …`
  and no drive starts
  (`pr-autofixer/agent/lib/auto-drive.ts`).
  That is not a silent skip.
- `sessions --prod` refuses v2 slugs; `logs --prod` works.

Automation spec (shipped `enabled: false`):
`factory-pr-autofixer.yaml` (not included in this snapshot; lived at `.cursor/automations/` in the old monorepo).

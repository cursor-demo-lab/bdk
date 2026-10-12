# Factory automations as Cursor Automations (cursor-agent YAML)

The live factory runs as six hosted Agent SDK deployments (`@cursor/july`
0.2.18; see [`factory-deployment.md`](factory-deployment.md)). TLSSN Jira
Automation rules POST to each host's engine channel URL
([`jira-automation.md`](jira-automation.md)), Slack reaches the desk over
Socket Mode, and GitHub events arrive through `--cursor-events-repo
cursor-demo-lab/marsbank`.

The same event wiring was also written down as Cursor Automations
config-as-code: one YAML file per role in the old monorepo
`.cursor/automations/` (not included in this snapshot).
Every file ships `enabled: false`. Deploying them next to the live hosts
creates the automation records (so `validate`, `get --yaml`, and `test`
work) without handling any event twice. Enable one only when it replaces
the matching host, or when its trigger is pointed somewhere the host does
not listen (a shadow run).

## What config-as-code is

Cursor Automations are server-managed agent runs with triggers (cron, Git,
Slack, webhook, …) and actions (open a PR, comment, post to Slack, MCP).
`cursor-agent automations …` (`agent` is the same binary) validates and
deploys them from YAML. The first deploy of a key creates the automation
and binds the key; later deploys of the same key update it in place.

Evidence, <PRIVATE_MONOREPO> @ `e9b35e7`:

- `packages/agent-cli/README.md`, "Automations (`agent automations ...`)":
  the commands below.
- `packages/automation-deploy-spec/src/parser.ts`: the file format.
- `schema/aiserver/v1/automations.proto`: the `Workflow` message that
  `workflow:` is parsed into (proto JSON, camelCase field names).
- `.cursor/automations/*.yaml`: everysphere's own specs
  (`ltsaheed-ci-babysit.yaml`, `cls-weekly-sweep.yaml`,
  `client-infra-rollout-perf-monitor.yaml`, …).

**Gate.** Every `automations` verb is behind the `automations_config_as_code`
Statsig gate (the CLI registers the command only when that gate or
`cli_factory` is on). If `cursor-agent automations --help` prints only the
main help, the gate is off for your account. The public build 2026.09.15
does not list it. everysphere deploys its own specs from the monorepo with
`cd packages/agent-cli && pnpm dev --trust --statsig-overrides
'{"featureFlags":{"automations_config_as_code":true,"cli_factory":true}}'
automations deploy the old monorepo `.cursor/automations/` (not included in this snapshot)/<file>.yaml`; that is
monorepo-internal and not something to run here.

## File location and format

- Repo root `.cursor/automations/<key>.yaml`, one automation per file,
  filename stem = `key`.
- The file starts with `---` YAML frontmatter and closes it with `---`.
  Everything after the closing `---` is free-text notes that the parser
  ignores; each factory file uses it for what it mirrors, why it is off,
  what the owner needs, and the deploy command.
- Top-level keys (anything else is an error): `version` (1), `key`,
  `name`, `description`, `enabled` (required boolean), `scope`,
  `workflow`, `managed-by` (`UI` | `DEPLOY` | `ANY`; `ANY` keeps it editable
  in the dashboard, `DEPLOY` makes the YAML authoritative).

Every factory file sets `version: 1`, `enabled: false`,
`scope: team_visible`, `managed-by: ANY`. `workflow` fields used:

| Field | Used for |
| --- | --- |
| `prompts[].prompt` | A fixed prompt that points at the host's files in this repo (below) |
| `triggers[]` | One trigger kind per item, optional `agenticFilterPrompt` |
| `actions[]` | `gitPr`, `prComment`, `slack`, `mcp` (by server name) |
| `model` + `modelSelection` | claude-opus-5-5, low effort (below) |
| `gitConfig` | Checkout for non-Git triggers: the private monorepo (not in this snapshot), plus marsbank for planner and worker |
| `disabledDefaultTools` | `AUTOMATION_DEFAULT_TOOL_OPEN_GIT_PR` on every role except the worker |

The prompt never changes. It follows everysphere's
`client-infra-rollout-perf-monitor.yaml` pattern: read
`<folder>/AGENTS.md` and
`<folder>/agent/instructions.md` from the checkout and follow
`agent/instructions.md` (the host's served prompt). The triggering
Jira, Slack, or GitHub payload is in the run context. Change behaviour by
changing those files, not the YAML.

**Model.** Automation agents run claude-opus-5-5 at low effort. Each file
sets both the legacy slug and the structured selection, because the proto
comment on `modelSelection` says "Writers set both; readers prefer this":

```yaml
  model: claude-opus-5-5-low
  modelSelection:
    modelId: claude-opus-5-5
    parameters:
      - id: effort
        value: low
```

This is separate from the hosts' own model settings (Auto with
`optimize_for=balanced`; grok-4.6 fast on `factory-desk` and on
`triage-jira`'s fallback triage turn).

## Mapping to the live factory

| File | Live host (folder) | Live trigger | Automation triggers | Actions |
| --- | --- | --- | --- | --- |
| `factory-triage-jira.yaml` | `factory-triage-jira` (`triage-jira`) | Jira rule `factory-triage-jira`, work item created | `webhook: {}` | `mcp` Factory Atlassian |
| `factory-planner.yaml` | `factory-planner` (`planner`) | Jira rule `factory-planner`, transitioned to Triaged | `webhook: {}` | `mcp` Factory Atlassian |
| `factory-worker.yaml` | `factory-worker` (`factory-worker`) | Jira rule `factory-worker`, transitioned to Approved | `webhook: {}` | `gitPr`, `mcp` Factory Atlassian |
| `factory-desk.yaml` | `factory-desk` (`factory-desk`) | Slack Socket Mode (`#mars-eng-intake` `C0EXAMPLE1`, DMs); Jira rules `factory-desk` and `factory-desk-comments` | `slackMention`, `slackReactionAdded` `white_check_mark` and `x`, `slackTrigger` (`topLevelOnly: false` + filter), `webhook: {}`, all on `C0EXAMPLE1` | `slack` `C0EXAMPLE1`, `mcp` Factory Atlassian |
| `factory-security-reviewer.yaml` | `factory-security-reviewer` (`security-reviewer`) | marsbank `pull_request` opened, synchronize, reopened, ready_for_review | `git.pullRequest` OPENED, PUSHED | `prComment` (inline) |
| `factory-pr-autofixer.yaml` | `factory-pr-autofixer` (`pr-autofixer`) | marsbank failed check_suite / check_run / workflow_run / status; PR comment `factory: drive` | `git.ciCompleted` FAILURE + `agenticFilterPrompt` for factory PRs only (branch starts with a ticket key, or keyed title from `cursor[bot]`; a model-evaluated approximation of `autoDriveDecision`, with no equivalent of `PR_AUTOFIXER_AUTO_DRIVE_PROJECTS` / `FACTORY_JIRA_PROJECTS`), `git.pullRequest` COMMENTED + `commentContains: "factory: drive"`, `agenticFilterPrompt` for first line + trusted author | `prComment` |

`Factory Atlassian` is the team MCP server the hosts already use
(`factory-desk/agent/host-connections/tracker.ts`). MCP servers are named
only; the config comes from the deploying owner's settings.

## Webhook trigger (where a Jira rule would point)

```text
POST https://api2.cursor.sh/automations/webhook/<automationId>
Authorization: Bearer <Cursor API key scoped to the automation owner>
Content-Type: application/json
```

Get `<automationId>` (a UUID) from `cursor-agent automations get <key>`.
API keys in the URL are rejected. Any JSON body is forwarded into the run
context; a string `context` field is also added to the prompt.

To point a TLSSN rule at an automation, keep the same trigger and the same
body from [`jira-automation.md`](jira-automation.md), swap the URL, and send
`Authorization: Bearer …` instead of `X-Factory-Webhook-Secret`. Every
free-text smart value still needs `.jsonEncode`: a title with an unescaped
quote is invalid JSON, and Jira logs "Successfully published web request"
either way.

## Commands

Run from the repo root, as a real user: Slack posts and PR actions act
through the deploying owner's connections.

```bash
cursor-agent automations validate .cursor/automations/factory-desk.yaml
cursor-agent automations deploy   .cursor/automations/factory-desk.yaml
cursor-agent automations list --managed-by ANY --format text
cursor-agent automations get factory-desk --yaml
cursor-agent automations test factory-desk --trigger slack --payload '{"message":"@Factory file a bug: ..."}'
cursor-agent automations runs list factory-desk --limit 50
cursor-agent automations runs get <background-composer-id>
cursor-agent automations pull ./automations
cursor-agent automations adopt <uuid> --key <deploy-key> --dry-run
cursor-agent automations delete factory-desk --dry-run
```

All eight (the six factory roles plus `find-vulnerabilities` and `find-bugs`):

```bash
for f in .cursor/automations/factory-*.yaml .cursor/automations/find-vulnerabilities.yaml .cursor/automations/find-bugs.yaml; do cursor-agent automations validate "$f" && cursor-agent automations deploy "$f"; done
```

Output is one JSON object per line by default; `--format text` prints a
table where supported. `get --yaml` prints redeployable YAML, which is the
way to check what the server holds against the file.

## Why `enabled: false`

The six hosts are live on the same events. An enabled automation on the
same Slack channel or marsbank repo would answer beside the host: a second
desk reply, a second review, a second fix. The Jira-triggered roles only
fire when a rule POSTs to their webhook, but a second rule on the same
transition would still plan or launch twice. Keep them off until one
replaces its host.

## What the schema cannot express

- **No Jira trigger kind.** Jira rules map to `webhook: {}`.
- **No `X-Factory-Webhook-Secret`.** That header is checked by host code
  against the slug's `JIRA_WEBHOOK_SECRET`. The automation webhook
  authenticates by the Bearer key instead; there is no shared-secret or
  HMAC check.
- **Host-side dedupe and gates.** Claims per changelog id, the desk's claim
  settle and hop watches, the planner's governing-triage gate, the security
  reviewer's once-per-head review, and the autofixer's trusted-author check
  are TypeScript in each host. An automation has only its prompt.
- **Slack DMs.** `slackTrigger` and `slackReactionAdded` accept public
  channel ids (`C…`) only, so the desk's DM path has no trigger.
- **Posting identity.** The `slack` action posts through the owner's Slack
  connection, not the Factory bot.
- **Some GitHub actions.** security-reviewer also reviews `reopened` and
  `ready_for_review`; there is no matching `prAction` value we verified, so
  those are not covered. The worker's In Review / Done moves come from
  marsbank PR events and are not part of `factory-worker.yaml`.

## Out-of-the-box automations (Bugbot, security review, change monitor)

Cursor's out-of-the-box automation templates live in <PRIVATE_MONOREPO>
`backend/server/src/automations/templates/*.yaml`. Each has a `workflow:`
block with the same shape as a deploy spec's `workflow`. The other keys
(`id`, `category`, `icon`, `featured_index`, `template_config`,
`input_schema`) are template-only, and the `input_schema` placeholders
(`repos: []`, `repo: ""`, `channel: ""`) have to be filled with real
values. Numeric `prAction` values are written by name: `1` is
`GIT_PULL_REQUEST_ACTION_OPENED`, `2` is `GIT_PULL_REQUEST_ACTION_PUSHED`.

Of Bugbot, security review and change monitor, only security review has a YAML form:

| Product | As YAML? | What to use |
| --- | --- | --- |
| Bugbot | No. Bugbot is its own product, not an automation type. It has no trigger, managed type or template (`managedAutomations/managedTypes.ts` lists only `SECURITY_REVIEWER`, `VULNERABILITY_SCANNER`, `PR_APPROVAL`, and `templates/` has no Bugbot file). | Put repo rules in `.cursor/BUGBOT.md` and turn Bugbot on in the Bugbot dashboard. The closest automation template is "Find critical bugs", shipped as [`find-bugs.yaml`](the old monorepo `.cursor/automations/` (not included in this snapshot)/find-bugs.yaml): a daily cron bug hunt that opens fix PRs. It is not Bugbot. |
| Security review | Partly. The "Find vulnerabilities" template is shipped as [`find-vulnerabilities.yaml`](the old monorepo `.cursor/automations/` (not included in this snapshot)/find-vulnerabilities.yaml), with the prompt unchanged, triggers on marsbank PRs opened and pushed, and a Slack summary to `C0EXAMPLE1`. | The managed **Security Reviewer** cannot be YAML. It is `managed_type` `SECURITY_REVIEWER` on the Automation record, and the server builds its prompt from `managedConfig.enabledChecks` with a fixed model (`securityReviewerConfig.ts`). The deploy spec has no managed-type field (`packages/automation-deploy-spec/src/parser.ts`; `configAsCode/deployService.ts` `buildDeployMetadata`), so a deploy always creates a plain automation. Turn the managed reviewer on in the dashboard. |
| Change monitor | No. It is a hosted Agent SDK v2 application (`factory/change-monitor/`: planner, executor, curator, knowledge-curator) installed per team (`changeMonitorTenantProvisioning.ts`, RPC `GetChangeMonitorTeamSettings`). No automation workflow, template or trigger represents it. | Enable it in the dashboard's Change Monitor settings. The factory's 📡 gate line reads its result. |

Both new files ship `enabled: false`. `find-vulnerabilities` covers the same
marsbank PRs as the live `factory-security-reviewer` host, and `find-bugs`
opens fix PRs every day.

Names: every file is `.cursor/automations/<key>.yaml`. The six factory specs
use the key as `name` too (`factory-desk`, `factory-triage-jira`,
`factory-planner`, `factory-worker`, `factory-security-reviewer`,
`factory-pr-autofixer`). The two template copies take the template `id` as
`key` and the gallery's display name as `name`: `find-vulnerabilities` is
"Find vulnerabilities" and `find-bugs` is "Find critical bugs"
(everysphere `backend/server/src/automations/templates/find-vulnerabilities.yaml`
and `find-bugs.yaml`).

- **No `bugbot.yaml`.** Bugbot has no managed type, template or trigger, and the deploy spec has no managed-type field; configure it in `.cursor/BUGBOT.md` and the Bugbot dashboard.
- **No `change-monitor.yaml`.** Change monitor has no managed type, and no trigger kind covers the deployment and checkpoint events it wakes on; enable it in the dashboard's Change Monitor settings ("Rollouts" under From Cursor).

To turn any automation made in the dashboard into YAML, pull it:

```bash
cursor-agent automations pull ./automations
cursor-agent automations get <key> --yaml
```

Pulling a managed Security Reviewer gives you its workflow without the
managed type. Deploying that file creates a plain automation with a frozen
copy of the prompt, not the managed reviewer.

## Full example: `factory-desk.yaml`

```yaml
---
version: 1
key: factory-desk
name: "factory-desk"
description: "Slack front door for #mars-eng-intake: requests, ✅/❌ approvals, thread replies, Jira status lines."
enabled: false
scope: team_visible
managed-by: ANY
workflow:
  prompts:
    - prompt: |-
        You are the Software Factory `factory-desk` role, run as a Cursor Automation.
        Read factory-desk/AGENTS.md and
        factory-desk/agent/instructions.md from the
        example-org/demo-repo checkout, and follow agent/instructions.md as your
        role prompt. The triggering Slack event or Jira payload is in the run context.
        Do not edit this prompt to change behaviour; change the files it points at.
  triggers:
    - slackMention:
        channel: C0EXAMPLE1
    - slackReactionAdded:
        channel: C0EXAMPLE1
        emojiName: white_check_mark
    - slackReactionAdded:
        channel: C0EXAMPLE1
        emojiName: x
    - slackTrigger:
        channel: C0EXAMPLE1
        topLevelOnly: false
      agenticFilterPrompt: |-
        Pass only a plain reply inside a thread the factory started (a filing
        prompt, a Filed post, or a ticket status thread). Drop top-level posts
        and replies in threads the factory is not part of.
    - webhook: {}
  actions:
    - slack:
        channel: C0EXAMPLE1
    - mcp:
        server:
          name: Factory Atlassian
  model: claude-opus-5-5-low
  modelSelection:
    modelId: claude-opus-5-5
    parameters:
      - id: effort
        value: low
  gitConfig:
    repo: https://github.com/example-org/demo-repo
    branch: main
  disabledDefaultTools:
    - AUTOMATION_DEFAULT_TOOL_OPEN_GIT_PR
---
Deploy spec notes (factory-desk)

Mirrors the hosted slug `factory-desk` (folder factory-desk). Live ingress:
Slack Socket Mode on the Factory app (#mars-eng-intake C0EXAMPLE1 and DMs)
plus two TLSSN rules POSTing to `.../engine/v1/channels/jira/`:
`factory-desk` (transitioned to In Progress, Planned, Approved, In Review,
Done or Triaged; Status body) and `factory-desk-comments` (comment added;
Comment body). Both rules would POST to the one webhook trigger here, with
`Authorization: Bearer <owner's Cursor API key>`.

Trigger mapping: new requests start with @Factory (slackMention); approvals
are ✅/❌ reactions (slackReactionAdded white_check_mark and x); plain
in-thread replies need no mention (slackTrigger with topLevelOnly: false,
narrowed by agenticFilterPrompt). DMs have no trigger here: slackTrigger and
slackReactionAdded accept public channel ids only.

The host's claim/settle logic (one post per changelog id, hop watches,
exactly one In Progress post) is host code with no automation equivalent.
The Slack action posts as the deploying owner's Slack connection, not the
Factory bot. Both are reasons this ships enabled: false.

Owner needs: a Slack connection in the Cursor account that can read and post
in C0EXAMPLE1, and the `Factory Atlassian` MCP server. The slug's secrets
(FACTORY_DESK_SLACK_BOT_TOKEN, FACTORY_DESK_SLACK_APP_TOKEN,
JIRA_WEBHOOK_SECRET) are not used by the automation.

Deploy (repo root): cursor-agent automations validate .cursor/automations/factory-desk.yaml
                    cursor-agent automations deploy .cursor/automations/factory-desk.yaml
Test:               cursor-agent automations test factory-desk --trigger slack --payload '{"message":"@Factory file a bug: ..."}'
Reference: docs/cursor-agent-automations.md
```

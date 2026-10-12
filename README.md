# Software factory on Slack, Jira, and GitHub

This is a **public copy** of the Slack / Jira / GitHub software factory.
Internal secrets, Slack / Jira / Grafana / Cursor identifiers, personal
emails, and private-repo links were replaced with placeholders before
import. Fill these in (or set the matching env vars) before you deploy:

| Placeholder | What to put |
| --- | --- |
| `<SLACK_CHANNEL_ID>` / `C0EXAMPLE1` | Slack intake channel id (`C…`). `FACTORY_DESK_INTAKE_CHANNEL` |
| `<SLACK_APP_ID>` / `A0EXAMPLE1` | Production Slack app id. Staging slugs refuse this app |
| `<SLACK_TEAM_ID>` / `T0EXAMPLE1` | Slack workspace / team id |
| `<SLACK_WORKSPACE>` / `example-workspace` | Slack workspace hostname (without `.slack.com`). Fixtures use `example-workspace.slack.com` so permalink parsers still match |
| `<JIRA_SITE>` / `example` | Jira Cloud site hostname. Code default and fixtures use `https://example.atlassian.net` (`JIRA_CLOUD_ID`) |
| `<GRAFANA_STACK>` | Grafana Cloud stack slug |
| `<GRAFANA_STACK_URL>` | `https://<GRAFANA_STACK>.grafana.net` (`GRAFANA_URL`) |
| `<GRAFANA_OTLP_HOST>` / `otlp.example.com` | Grafana Cloud OTLP gateway host (`OTEL_EXPORTER_OTLP_ENDPOINT`). Also listed in each agent's `egressDomains` |
| `<GRAFANA_REGION>` | Grafana Cloud region of that stack |
| `<CURSOR_TEAM_ID>` / `<CURSOR_TEAM_NAME>` | Cursor team id and display name (`--team`) |
| `<MCP_SERVER_ID>` | Team MCP server id for Factory Atlassian |
| `<OPERATOR_EMAIL>` | Operator email for Jira REST / e2e scripts |
| `<SANDBOX_REPO>` | Already defaulted to `cursor-demo-lab/marsbank` in `.env.example` |

Tokens, webhook secrets, and Grafana/OTLP headers stay empty in
`.env.example`. Copy to `.env.local` (gitignored) and fill them there.

**Not in this snapshot:** Cursor Automations YAML that lived at
`.cursor/automations/` in the old monorepo; notes under
`agent-sdk/findings/`; and any sibling checkout such as a Jev-as-judge
tree. Jev here is the `@cursor/july/extensions/jev` package, not a
sibling folder. This copy has no `LICENSE`.

<img src="factory-desk/assets/logo.png" alt="factory-desk logo" width="96" />

Six hosted agents on the Cursor Agent SDK (`@cursor/july`, hosted v2) take a
request posted in Slack `#mars-eng-intake`, triage it, file it in Jira,
plan it, implement it as a pull request in `cursor-demo-lab/marsbank`, and
report review results back to the Slack thread. A person approves twice
(filing and the plan) and merges the PR. No agent merges.

Jira is the bus. Each agent writes its artifact to the ticket (a comment)
and moves the ticket; the next agent wakes on that status. No agent calls
another agent.

Deeper material:

- [`docs/factory-deployment.md`](docs/factory-deployment.md): operator runbook (deploy, secrets, first-deploy steps, smoke test).
- [`docs/event-driven-factory.md`](docs/event-driven-factory.md): design and transition table.
- [`docs/jira-automation.md`](docs/jira-automation.md): the TLSSN Automation rules and body templates.
- [`docs/slack-and-github-setup.md`](docs/slack-and-github-setup.md): the Factory Slack app (scopes, events) and the GitHub side.
- [`docs/cursor-agent-automations.md`](docs/cursor-agent-automations.md): the same wiring as Cursor Automations YAML in the old monorepo `.cursor/automations/` (not included in this snapshot).
- [`docs/deployment-issues.md`](docs/deployment-issues.md): incident diary. [`docs/next-steps.md`](docs/next-steps.md): backlog.
- Each project's `README.md` and `AGENTS.md`: per-agent detail.

## Flow

```mermaid
sequenceDiagram
    actor P as Person (Slack)
    participant D as factory-desk
    participant J as Jira (TLSSN)
    participant PL as factory-planner
    participant W as factory-worker
    participant GH as GitHub marsbank
    participant R as factory-security-reviewer / factory-pr-autofixer

    P->>D: @Factory file a bug: ...
    D->>D: Jev triage before filing (grok-4.6-fast fallback)
    D-->>P: filing prompt (verdict, Summary)
    P->>D: ✅ (or ❌) reaction on the filing prompt
    D->>J: create issue, Triage: comment, To Do → Triaged
    D-->>P: Filed post
    J->>PL: issue_updated → Triaged
    PL->>J: Plan: comment (with Brief:), → Planned
    J->>D: → Planned
    D-->>P: plan post
    P->>D: ✅ reaction on the plan post
    D->>J: Planned → Approved
    J->>W: issue_updated → Approved
    W->>W: launch cloud agent on the brief
    W->>J: Implementing: comment, → In Progress
    D-->>P: one KEY is In Progress post
    W->>GH: open marsbank PR (ready, not draft)
    W->>J: Pull request: comment, → In Review
    GH->>R: security review comment; red CI drives the autofixer
    GH->>D: Bugbot / security / CI / change review / autofix settle
    D-->>P: review updates, gate lines 🔧 🐛 🔒 🏗️ 📡, then KEY is In Review
    P->>GH: merge (a person)
    GH->>W: pull_request merged
    W->>J: → Done
    D-->>P: KEY is Done
```

In words: a top-level `@Factory file …` starts a request; Jev triages it
before filing; a ✅ (or ❌) on the filing prompt files it; the thread
gets the Filed post, then Triaged, then the plan post; a ✅ on the plan
approves it. In the ticket thread, reply with plain text (`approve`,
`approve KEY`, `deny KEY`, `retry KEY`); do not mention the bot. Each
approval is one action (a ✅ or one reply). Exactly one In Progress post
follows; the worker opens the marsbank PR; review updates arrive with
gate lines in `COMPONENT_ORDER` 🔧 🐛 🔒 🏗️ 📡; the ticket reaches In Review.

Ticket statuses: `To Do → Triaged → Planned → Approved → In Progress → In Review → Done`.
A ticket filed directly in Jira takes the same path, except that
`factory-triage-jira` triages it (the desk-filed path skips triage-jira) and
it can only be approved by moving the card to Approved in Jira.

## The six agents

| Directory | Hosted slug | Wakes on | Does |
| --- | --- | --- | --- |
| `factory-desk` | `factory-desk` | Slack mentions, DMs, and replies in factory threads in `#mars-eng-intake`; Jira status changes and factory outcome comments; GitHub PR, check, and review events (read-only) | Triages filing requests, files the ticket (`Triage:` comment, move to Triaged), approves tickets, posts every stage and review update into the ticket's Slack thread, runs the hop watchdog |
| `triage-jira` | `factory-triage-jira` | Jira `issue_created` | Triages tickets filed in Jira; skips tickets the desk filed (their description ends `Triaged in Slack by factory-desk before filing.`; when the delivered description does not show it, the ticket read back from Jira does, or carries the desk's `Triage:` comment, or was created in To Do and is already past it). Writes `Triage:` or `Triage stopped:`, moves to Triaged |
| `planner` | `factory-planner` | Jira status → Triaged | Reads the sandbox repo, writes `Plan:` ending in `Brief:` and moves to Planned; or `Needs info:` / `Plan stopped:`. Skips question, needs-info, and duplicate verdicts |
| `factory-worker` | `factory-worker` | Jira status → Approved; GitHub `pull_request` on its implement PR | Host code launches one July cloud turn per ticket (claim `implement/<KEY>`), comments `Implementing: <url>`, moves to In Progress; the worker opens the PR itself and moves to In Review; moves to Done when a person merges. Jira writes stay on the host |
| `pr-autofixer` | `factory-pr-autofixer` | GitHub PR, check, and comment events | On a factory PR's first red `check_suite` / `workflow_run`, Bugbot findings (2 rounds), or a person's `factory: drive` comment, pushes fixes to the PR branch |
| `security-reviewer` | `factory-security-reviewer` | GitHub `pull_request` opened / synchronize / ready_for_review / reopened, and `edited` when the base is retargeted | Posts one `## Security review` review with a verdict. PR comments are logged and ignored |

### Triage

Host code asks Jev (TypeSafe, `@cursor/july/extensions/jev`) three choices:
issue type, severity, and a needs-info gate. The threshold is
`JEV_THRESHOLD = 0.52` in
`factory-desk/agent/lib/jev-triage.ts`
(copy in triage-jira), shared verbatim by the desk and triage-jira.

- If every answer is strictly above 0.52, Jev's verdict is used and no model
  turn is needed for triage.
- Otherwise (any answer at or below 0.52, Jev errors, times out after 8 s,
  or `TYPESAFE_API_KEY` is unset) a grok-4.6-fast turn triages. A Jev
  answer that did clear the bar (for example the type) is still applied.

On the desk this happens before the filing prompt, so the person sees the
verdict before saying `approve file`.

### The implement PR

- The worker, not the cloud agent, opens the implement PR (#152, #153).
  The live launch is a July cloud turn
  (`factory-worker/agent/lib/implement-turn.ts`)
  with `autoCreatePR: false`. The heal still uses `@cursor/sdk`
  `Agent.create`. Once the agent pushes its branch, the worker opens the
  PR with `draft: false` into `FACTORY_SANDBOX_REF`, because Bugbot skips
  drafts. It notices the push from a reminder armed at launch (first
  check at 10 min, then every 5 min for up to 8 h), or from `retry KEY`
  (`factory-worker/agent/lib/implement-pr.ts`,
  `factory-worker/agent/lib/launch.ts`,
  `factory-worker/agent/reminders/implement_pr.ts`).
- If an open PR from the branch already exists, the worker reuses it and
  marks it ready, unless a person drafted it. It never reopens a PR that a
  person closed.
- Title starts `KEY: `; the body starts with `Jira:` and `Slack:` lines.
- The cloud agent is told not to merge, enable auto-merge, or force-push.
  The worker moves the ticket to Done only for a merge by a person; a bot
  merge or auto-merge moves nothing.

## Models

From `factoryModel()` in each project's
`<slug>/agent/lib/factory-model.ts`
(identical copies):

| Host | Default |
| --- | --- |
| `factory-desk` (every turn) and `factory-triage-jira` (its fallback turn) | `grok-4.6` with `effort=high`, `fast=true` (grok-4.6-fast) |
| `factory-planner`, `factory-pr-autofixer`, `factory-security-reviewer` | Auto: `auto-smart` with `optimize_for=balanced` |
| `factory-worker` (its one model turn: the implement cloud session) | `claude-opus-5-5`, `context=300k`, `effort=high`, `fast=false` (`IMPLEMENT_MODEL` / `workerModel()` in `factory-worker/agent/lib/config.ts`). The worker reads no `FACTORY_AGENT_*` |

`FACTORY_AGENT_MODEL`, `FACTORY_AGENT_EFFORT`, `FACTORY_AGENT_SPEED`
override the host model on any slug (`auto-smart` puts a slug back on Auto;
`grok-4.7` is sent with registry params `reasoning_effort` and `speed`).
`FACTORY_WORKER_MODEL`, `FACTORY_WORKER_CONTEXT`, `FACTORY_WORKER_EFFORT`,
`FACTORY_WORKER_FAST` override the cloud agent model when the worker
process starts with them (local `serve`); they are not hosted secrets,
because hosted v2 binds secrets after `agent.ts` loads, so the hosted
worker runs the default variant.
`scripts/factory-model-catalog.test.mjs` pins these defaults. Jev
triages a filing request before the desk files it (see Triage).

The YAML automations in `the old monorepo `.cursor/automations/` (not included in this snapshot)/` run `claude-opus-5-5` at
`effort` `low` (see Automations as code).

## Slack

The desk watches `#mars-eng-intake` (`C0EXAMPLE1`) and DMs.

- **Start a request** with a top-level message that mentions the bot and
  uses a filing phrase: `@factory file a bug: CSV export returns 500 when
  the filter matches no rows`. Other phrases: `raise a ticket`, `create a
  ticket`, `new ticket`, `log this`, `report a bug`, `raise an issue`,
  `create an issue`, `log an issue` (`factory-desk/agent/lib/desk-commands.ts`).
- **In the ticket thread, reply with plain text. Do not mention the bot.**
  The intake channel is watched: `C0EXAMPLE1` / `#mars-eng-intake` is
  hardcoded in `factory-desk/agent/lib/desk-channels.ts`,
  plus `FACTORY_DESK_INTAKE_CHANNEL` if set. There, and in DMs, a plain
  reply in a factory thread reaches the desk if it is one of these
  (`factory-desk/agent/lib/plain-reply.ts`):
  - an exact command from the table below (bare `plan`, `retry`, `fix` or
    `fix <PR>` included);
  - the answer to a needs-info question;
  - a clear question to the factory ending in `?`.

  Anything else, and any top-level post without the mention, is ignored.
  The full routing list is in [`factory-desk/README.md`](factory-desk/README.md).

| Command (in the thread) | Effect |
| --- | --- |
| `approve file` / `deny file` | File the ticket as triaged, or drop it |
| `approve` | Approve the plan, when the thread maps to exactly one ticket; otherwise the desk asks for `approve KEY` |
| `approve KEY` / `deny KEY` | Approve (Planned → Approved) or deny (a comment, no move) |
| `plan KEY` / `replan KEY` | Send the ticket back to the planner. Host code moves nothing when the governing `Triage:` verdict is one the planner skips (question, unanswered needs-info, duplicate) |
| `retry KEY` | Redeliver a stalled hop without launching twice. On To Do or Triaged this sends the planner (`redeliverToPlanner` in `factory-desk/agent/lib/retry-command.ts`); it does not re-POST `issue_created` to triage-jira. On Approved it bounces Approved → Planned → Approved. On In Progress with an `Implementing:` comment it moves back to Approved so the worker opens the PR |
| `fix` / `fix <PR>` | Fixed reply: type `factory: drive` on the PR yourself. No model turn, no GitHub write |
| a reply to a Needs info line | Added to the ticket as `Detail from Slack:` and replanned |

Slack approvals, `retry`, and `plan` are accepted only from the person who
filed the ticket, in that ticket's thread. Anyone can approve by moving the
card to Approved in Jira. Interactive cards are not used.

**Approve or decline with a reaction.** A ✅ or ❌ on two desk posts does
the same as the typed command. The typed commands above still work
unchanged.

| Reaction | On the filing prompt | On the plan post |
| --- | --- | --- |
| ✅ | Same as `approve file`: the ticket is filed with the prompt's triage | Same as `approve KEY`: Planned → Approved, then `KEY: starting implementation…` |
| ❌ | Same as `deny file`: one line, nothing is filed | Same as `deny KEY`: a `Denied in Slack by <name>` comment on the ticket, then one line asking to add what should change as a comment on the ticket and say `replan KEY`. The ticket stays Planned, so a later ✅ or `approve KEY` still builds it |

- Who counts is who the typed command takes: on the filing prompt, the
  person whose message the prompt answers; on the plan post, the person
  who filed the ticket, in the ticket's own thread. A Jira-filed ticket has
  no Slack filer, so only the board approves it.
- Everyone else is ignored with no reply: other people, bots and apps
  (the desk's own reactions included; July marks every reactor human, so
  the desk looks each one up, and a failed lookup counts as a bot), and
  Slack Connect senders.
- Approve and decline of one ticket never both happen: a ❌ (or `deny KEY`)
  while an approval is landing does nothing. A ✅ and a typed approve, or a
  redelivered reaction, approve once. A new plan post can be approved
  right away, even just after the last plan was approved.
- Only a filing prompt or plan post the desk recorded when it posted it
  counts. Posts from before this version was deployed, the stage emoji on
  the thread root, and any other message do nothing.
- The Slack app must carry a 0.2.11-or-later manifest (the `reaction_added`
  event and the `reactions:read` scope) before any reaction arrives; see Deploy
  and [`docs/slack-and-github-setup.md`](docs/slack-and-github-setup.md).

What the thread shows:

- A filing prompt: title, `<who triaged>: <Type>, <severity> severity.`,
  `Summary:`, and the ask to reply `approve file`. The first part reads
  `Triaged by Jev`, `Jev wasn't sure, so the model triaged it`, or
  `Jev didn't answer, …`. Scores are never shown in Slack.
- After `approve file`: one Filed post, `KEY is filed with that triage:
  <verdict>.`, then `Summary:` and `Next:`. No separate Triaged post for a
  desk-filed ticket.
- A plan post when Planned, ending in a `Next:` line with the commands.
- `KEY is In Progress…`, `KEY is In Review…`, `KEY is Done: <PR> was merged
  by <login>.`   (`inReviewMessage` / `doneMessage` in
  `factory-desk/agent/lib/threads.ts`).
  The login comes from the worker's `Merged by:` comment
  (`factory-worker/agent/lib/pr-decide.ts`),
  and the PR link from its `Pull request:` comment.
- Short "loader" lines while the planner runs and while review gates are
  pending.
- While the PR is open, `KEY review update on <sha>:` replies with one line
  per gate, `<gate emoji><status emoji> <Gate> — <status> · <link>`:

| Gate | Line |
| --- | --- |
| Autofix | `🔧` after a fixer push |
| Bugbot | `🐛✅` clean, `🐛⚠️` findings, `🐛❔` unfinished |
| Security review | `🔒✅` clean, `🔒⚠️` findings, `🔒❔` incomplete |
| CI | `🏗️✅` passing, `🏗️❌` failing |
| Change review (change-monitor) | `📡❔` running, then edited in place to `📡✅` plan ready / verified or `📡⚠️` |

CI is announced only from the `github-actions` `check_suite` event, and
each update checks the thread before and after posting and removes its own
duplicate, so each gate line appears once per head commit
(`factory-desk/agent/lib/review-thread.ts`,
#158). An unchanged security verdict is not reposted after a new push.
A change-review 📡 line can append `(services: …)` from the change-monitor
marker, minus the six factory deploy slugs and their `-staging` twins
(`FACTORY_HOST_SERVICES` in
`factory-desk/agent/lib/review-update.ts`).

The desk also keeps one stage emoji on the thread's root message
(`factory-desk/agent/lib/status-reaction.ts`).
These are the desk's own reactions; they approve nothing, and a person's 👍
approves nothing either (only ✅ and ❌ on the filing prompt or plan post
count).

| Emoji | Stage |
| --- | --- |
| 👀 | Filing request received; ticket filed |
| ⏳ | Planner running |
| 📝 | Planned (plan waiting for approval) |
| 🚫 | Plan declined (❌ or `deny KEY`); a new plan or an approval replaces it |
| 🛠️ | Approved / In Progress |
| 🔍 | In Review |
| ✅ | Done |
| ❓ | A person needs to answer (needs info, gated verdict) |
| ⚠️ | Triage or plan stopped, launch failed, approved without a plan, or a hop is stalled |

Separately, ✅ is added to the person's own `approve file`, `deny file`, and
`approve KEY` messages when they take effect.

July opens each Slack turn with the desk's own user id and name
(`self_user_id`, `self_name`) and the sender's `user_tz` and bot flag, so
the model can tell a mention of itself and a bot sender from a person.
Since 0.2.12 the name is the bot's Slack profile name (`users.info`:
display name, then real name), falling back to the `auth.test` handle
(`factory`) only when that lookup fails.
The runtime already drops the desk's own posts before any handler.

**Hop watchdog.** If triage or plan leaves no Jira artifact within 15
minutes, or a launch within 7, the thread gets one line naming the hop and
offering `retry KEY`. The deadline watch never retries on its own. On a
To Do (triage) hop, that retry sends the planner; recover a missed
triage-jira `issue_created` with a signed created replay (see the
triage-jira README). The plan hop also has a start check at 4 minutes
that re-sends the ticket once if planning never started
(`factory-desk/agent/lib/hop-watch.ts`).

## Configuration

Names only; values live in deployment secrets or a local `.env.local`
(gitignored). The `hosting` block in each
`<slug>/agent/agent.ts` is the source.
Since 0.2.11 any GitHub, GitLab, or Bitbucket credential is referenced by
name, `{ secretName: "NAME" }`; the factory's GitHub channels use
`cursorAccount` and need none.

Every slug declares `FACTORY_ENV`, `FACTORY_STAGING_ALLOW_PRODUCTION`,
`FACTORY_OPS_SLACK_BOT_TOKEN`, `FACTORY_OPS_SLACK_CHANNEL`, and
`OTEL_EXPORTER_OTLP_HEADERS`. Plus, from each
`<slug>/agent/agent.ts`
`hosting.secretNames`:

| Slug | Also declared |
| --- | --- |
| `factory-desk` | `FACTORY_DESK_SLACK_BOT_TOKEN`, `FACTORY_DESK_SLACK_APP_TOKEN` (local Socket Mode), `FACTORY_JIRA_PROJECTS`, `FACTORY_REPOS`, `FACTORY_DESK_INTAKE_CHANNEL`, `FACTORY_DESK_SLACK_HANDLE`, `JIRA_WEBHOOK_SECRET`, `JIRA_CLOUD_ID`, `FACTORY_AGENT_*`, `FACTORY_STATUS_*`. `TYPESAFE_API_KEY` comes from the Jev extension, not `agent.ts` |
| `factory-triage-jira` | `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET`, `JIRA_CLOUD_ID`, `FACTORY_AGENT_*`, `FACTORY_STATUS_*`. `TYPESAFE_API_KEY` from the Jev extension |
| `factory-planner` | `FACTORY_REPOS`, `FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`, `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET`, `JIRA_CLOUD_ID`, `FACTORY_AGENT_*`, `FACTORY_STATUS_TRIAGED`, `FACTORY_STATUS_PLANNED`. `FACTORY_PLANNER_CHECKOUT` is local only and not a hosted secret |
| `factory-worker` | `FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`, `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET`, `JIRA_CLOUD_ID`, `FACTORY_STATUS_APPROVED` … `_DONE`. `FACTORY_WORKER_*`: local `serve` only |
| `factory-pr-autofixer` | `FACTORY_REPOS`, `FACTORY_JIRA_PROJECTS`, `FACTORY_AGENT_*`. `PR_AUTOFIXER_REPOS` / `PR_AUTOFIXER_AUTO_DRIVE_PROJECTS` are optional env overrides, not hosted secrets |
| `factory-security-reviewer` | `FACTORY_REPOS`, `FACTORY_JIRA_PROJECTS`, `FACTORY_AGENT_*`. `SECURITY_REVIEWER_REPOS` is an optional env override, not a hosted secret |

- `FACTORY_REPOS`: repo allowlist, `cursor-demo-lab/marsbank`.
  `FACTORY_SANDBOX_REPO` / `FACTORY_SANDBOX_REF`: where the worker launches
  and which base its PR targets (`main`).
- `FACTORY_JIRA_PROJECTS`: `TLSSN`. `JIRA_CLOUD_ID` defaults to
  `https://example.atlassian.net`.
- `FACTORY_STATUS_TODO`, `_TRIAGED`, `_PLANNED`, `_APPROVED`,
  `_IN_PROGRESS`, `_IN_REVIEW`, `_DONE`: Jira status names; defaults are
  the names in the flow above.
- Other env read by code:
  - Desk: `FACTORY_DESK_JIRA_PROJECT` (defaults to the first of
    `FACTORY_JIRA_PROJECTS`), `FACTORY_DESK_SLACK_HANDLE` (default
    `@factory`), `FACTORY_DESK_CLAIM_SETTLE_MS` (default 2000).
  - Planner: `FACTORY_PLANNER_JIRA_PROJECTS`; `FACTORY_GITHUB_TOKEN` is for
    local runs only, and hosted uses the GitHub App.
  - Planner and worker: `FACTORY_CLAIM_SETTLE_MS` (default 2000, 0 skips the
    claim's settle re-read) and `FACTORY_CLAIM_MODE=legacy` (the plain
    read-then-put claim), both read per request.
  - Desk, planner, worker, fixer: `FACTORY_KV_RETRY_PAUSES_MS` (the pauses
    between kv retries in `kv-verified.ts`, default 100,400 ms with jitter;
    empty or `off` turns them off), read per call.
  - Fixer: `PR_AUTOFIXER_REPOS`, `PR_AUTOFIXER_AUTO_DRIVE_PROJECTS`, and
    three kill switches read per request (KV Phase 1 K8):
    `FACTORY_FIXER_CLAIM_SETTLE_MS` (the drive claim's settle, default and
    most 2000; 0 skips it), `FACTORY_FIXER_CLOSE_CLEANUP=off` (a close
    releases the claim only), `FACTORY_FIXER_ROUNDS_MERGE=off` (plain puts
    for Bugbot rounds). Reviewer: `SECURITY_REVIEWER_REPOS`.
  - Desk, triage, planner: `LINEAR_WEBHOOK_SECRET` (Linear webhook
    verification; not used by the Jira flow).
  - `FACTORY_INPROCESS_PEERS`: local `serve` only; leave unset when hosted.
- The security reviewer's debug channel (`GET /v1/channels/debug/events`)
  and its `host.kv` event list are removed (#160), and the
  `FACTORY_DEBUG_TOKEN` hosted secret is deleted after the redeploy. Read
  its hosted logs with `agent-sdk logs --prod --slug factory-security-reviewer --team <CURSOR_TEAM_ID>`
  (see Deploy). Its console log lines stay: one
  `factoryDebug: "github-event"` line per delivery the hooks see (skipped
  and refused ones included) and one `factoryDebug: "review-posted"` line
  per posted review. `logs --prod` follows sessions, so it has shown these
  lines for a delivery that started a review; a skipped delivery starts no
  session, and its line is not proven readable there.
  Details: [`security-reviewer/README.md`](security-reviewer/README.md).

### OpenTelemetry

Each host's `<slug>/agent/otel.ts`,
`<slug>/agent/lib/factory-otel.ts`,
`<slug>/agent/lib/factory-otel-signals.ts`,
and `<slug>/agent/lib/factory-otel-rebase.ts`
(identical copies) export traces,
metrics, and logs to Grafana Cloud (the `<GRAFANA_STACK>` stack, its
gateway `https://otlp.example.com/otlp`, in
code) once a slug has the one secret, `OTEL_EXPORTER_OTLP_HEADERS`
(`Authorization=Basic base64(<instance id>:<glc_ token>)`, a literal space
after `Basic`). Unset, nothing is exported; unsetting it is the kill
switch. Every Jira, Slack, and GitHub delivery, reminder, schedule, and
cloud-agent launch gets a `factory.*` span with its kind, outcome, and
ticket key. Each is a new root span, in a trace of its own and linked to the
inbound request's span: Cursor's backend leaves about 96% of inbound
requests unsampled, and a child of an unsampled parent is not recorded.
Metrics are July's token, cost, session, turn, and hosted-execution
counters and histograms plus `apj_factory.delivery`, cumulative; logs are
July's session events and the factory's console lines, exported unaltered
(original body; only attributes the emitter set; the factory does not
parse bodies to mint fields; a console line's level is its method's,
except that Node's print of a process warning is one `WARN`; a print the bridge cannot match, or a listener that writes Node's exact shape, differs: see `docs/factory-deployment.md`). User prompts and tool content are on in the
resolver. Grafana access is the only control on logs and traces. Metric
labels are allowlisted (no session ids; the hosted-execution phase and a
few other enum-like labels stay).
Every signal carries `service.name` (the hosted slug) and a
`service.instance.id` drawn for the VM's life after its restore, and the
factory's span and trace ids are drawn from the kernel's random pool when
the span starts, because a snapshot clones `Math.random`, which OTel's
default generator uses. The factory registers tracer, meter, and logger
providers globally before July starts
(`factory-desk/agent/otel.ts`,
`factory-desk/agent/lib/factory-otel-signals.ts`,
copies in every host). July adopts them and records no span in memory
(Bug 6b, #249). `factory-desk/agent/hooks/zz-otel-turn-flush.ts`
schedules a flush on `turn.completed` / `turn.failed` (`setImmediate`;
the reply does not wait) and awaits it on `session.waiting` /
`session.completed` / `session.failed` (Bug 6a, #248), so a hosted reply
waits at most 2.25 s (`SIGNALS_BUDGET_MS`) for the factory providers.
July's `forceFlush` does not export those spans. If another provider
already took the global tracer (`global_provider_taken`), July's spans
are not in the factory queue and this flush does not export them.
Setup, Grafana access, latency, restores, and Tempo, Prometheus, and Loki
queries: [`docs/factory-deployment.md`](docs/factory-deployment.md#11-opentelemetry-export-grafana-cloud);
the July behaviours worked around: [`docs/july-otel-upstream.md`](docs/july-otel-upstream.md).
The two Grafana dashboards (Factory business: delivery, lead times,
first-pass rate, cost; Factory ops: health, ticket lookup, debug) are code
in [`observability/grafana/`](observability/grafana/README.md): generate,
apply, and verify them from there.

External setup the factory depends on (details in the runbook):

- Team `<CURSOR_TEAM_NAME>` (id `<CURSOR_TEAM_ID>`) owns the slugs and the
  Cursor GitHub App installation on `cursor-demo-lab`.
- Team MCP server `Factory Atlassian` (id `<MCP_SERVER_ID>`), authorised once per
  Jira slug (desk, triage, planner, worker).
- Five TLSSN project Automation rules POST to each slug's engine alias
  plus a channel path, with header `X-Factory-Webhook-Secret` set to that
  slug's `JIRA_WEBHOOK_SECRET` ([`docs/jira-automation.md`](docs/jira-automation.md)):

  | Slug | Path | Trigger |
  | --- | --- | --- |
  | `factory-triage-jira` | `/v1/channels/webhook/` | Issue created |
  | `factory-planner` | `/v1/channels/webhook/` | → Triaged |
  | `factory-desk` | `/v1/channels/jira/` | → Triaged, Planned, Approved, In Progress, In Review, Done |
  | `factory-desk` (comments) | `/v1/channels/jira/` | Issue commented |
  | `factory-worker` | `/v1/channels/jira/` | → Approved |

  Every free-text smart value in a body uses `.jsonEncode`: a quote in an
  unencoded title made invalid JSON that the host dropped while Jira still
  logged "Successfully published web request" (TLSSN-40, TLSSN-41).
  Use these rules or site system webhooks, never both, or every event
  arrives twice. No rule moves a card to In Review or Done; the worker
  does that from the PR.
- The desk's Slack app comes from the v2 wizard, not `agent-sdk slack create`.

## Deploy

Hosting bakes a pushed commit, never local files. Push first, then from
``:

```bash
npm ci --prefix factory-desk; for p in triage-jira planner factory-worker pr-autofixer security-reviewer; do npm ci --prefix $p; done
node scripts/doctor.mjs
mise run check && mise run test && mise run validate

SHA=$(git rev-parse HEAD)
D="npx -y -p @cursor/july@0.2.22 agent-sdk deploy --ref $SHA --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>"
$D --dir triage-jira       --slug factory-triage-jira
$D --dir planner           --slug factory-planner
$D --dir factory-worker    --slug factory-worker
$D --dir factory-desk      --slug factory-desk
$D --dir pr-autofixer      --slug factory-pr-autofixer
$D --dir security-reviewer --slug factory-security-reviewer
```

- Node 22.18 or later, never Bun. All six hosts (`factory-desk`, `planner`,
  `factory-worker`, `triage-jira`, `pr-autofixer`, `security-reviewer`) pin
  `@cursor/july` 0.2.22. One slug's deploy, in general form:
  `npx -y -p @cursor/july@0.2.22 agent-sdk deploy --ref <SHA> --dir <folder> --slug <slug> --cursor-events-repo cursor-demo-lab/marsbank --team <team id>`.
- `--ref` is the full 40-character SHA of a pushed commit. One slug per
  `deploy`. Every slug gets `--cursor-events-repo cursor-demo-lab/marsbank`
  and `--team <CURSOR_TEAM_ID>`: that flag is the SCM event watch list only (not
  the Rollouts `deploySourceUri`); a redeploy without it drops the GitHub
  subscription. Details:
  [`docs/factory-deployment.md`](docs/factory-deployment.md#hard-rules).
  Redeploy steps: [`docs/factory-deployment.md`](docs/factory-deployment.md#redeploy).
- The deploy CLI version (`@cursor/july@0.2.22` above) must equal the
  version the hosts install (`factory.json`, each `package.json` and
  lockfile). From 0.2.13 the CLI writes the desk's `hop-watch` schedule
  into the deploy manifest and the runtime stops registering it itself,
  so a mismatch in either direction leaves hop-watch unscheduled or
  refused. `scripts/july-version-parity.test.mjs` fails on any drift.
  Details: [`docs/factory-deployment.md`](docs/factory-deployment.md#bdk-0213-upgrade).
- A rollback from 0.2.18 to 0.2.14 is safe: the checkpoint and kv code is
  byte-identical. A 0.2.13 rollback still cannot restore a conversation
  0.2.14 re-packed: [`docs/factory-deployment.md`](docs/factory-deployment.md#bdk-0222-upgrade).
- Deploy with a credential for <CURSOR_TEAM_NAME> (team `CURSOR_API_KEY` or your own
  `agent-sdk login`), never a service account. The runbook says not to
  unset `CURSOR_API_KEY` for this team.
- Secrets are set after a slug is `running`, then redeployed once.
- Ops alerts are optional: `FACTORY_OPS_SLACK_BOT_TOKEN` and
  `FACTORY_OPS_SLACK_CHANNEL` turn on the ops failure funnel; with either
  unset, alerts are off and nothing else changes. Set them with
  `agent-sdk secrets set <slug> NAME --team <team id>`, never in a file or doc.
- A worker launch lost after an Approved delivery heals itself (TLSSN-51):
  the worker writes a durable launch watch plus a reminder and relaunches
  about 4 minutes after the approval, and the desk's launch hop watch
  speaks at 7 minutes. Details: the `factory-worker` README, "Lost
  launches", and [`docs/factory-deployment.md`](docs/factory-deployment.md).
- Staging uses `<slug>-staging` slugs with `FACTORY_ENV=staging`, their own
  Slack app, Jira project, and sandbox. A staging slug must not target
  production TLSSN, marsbank, or `#mars-eng-intake`
  ([`docs/factory-deployment.md`](docs/factory-deployment.md#10-staging-slugs)).
- Reaction approvals need the Factory Slack app on a 0.2.11-or-later manifest
  once: `npx -y -p @cursor/july@0.2.22 agent-sdk slack manifest --dir factory-desk
  --channel-posts --env prod --print` adds the `reaction_added` event and
  the `reactions:read` scope. Apply it through the v2 wizard the app was
  minted with (not `slack create`, which still drafts v1 on this team),
  reinstall when Slack asks for the new scope, then redeploy the desk.
  Full steps: [`docs/slack-and-github-setup.md`](docs/slack-and-github-setup.md).
- Read hosted logs with `logs --prod` (works on v2 since 0.2.11):

  ```bash
  S="npx -y -p @cursor/july@0.2.22 agent-sdk"
  $S logs --prod --slug factory-desk --team <CURSOR_TEAM_ID>                # follow recent sessions
  $S logs --prod --slug factory-desk --team <CURSOR_TEAM_ID> --once --json  # print once, as JSON
  $S session ses_... --prod --slug factory-desk --team <CURSOR_TEAM_ID>     # one session
  ```

  Grep Slack channel lines by their `[bdk/slack]` prefix.
  `sessions --prod` still refuses v2 slugs; use `session` for one session,
  or the dashboard's Sessions list.
  The ticket, the thread, and the PR remain the product evidence.

### Automations as code

The same wiring also exists as Cursor Automations config-as-code, one
file per host in the old monorepo `.cursor/automations/` (not included in this snapshot)
(`factory-desk.yaml`, `factory-triage-jira.yaml`, `factory-planner.yaml`,
`factory-worker.yaml`, `factory-pr-autofixer.yaml`,
`factory-security-reviewer.yaml`). Each prompt reads that host's
`AGENTS.md` and follows it. Two out-of-the-box templates sit beside them:
`find-vulnerabilities.yaml` (the "Find vulnerabilities" template) and
`find-bugs.yaml` ("Find critical bugs", which is not Bugbot). Bugbot and
change monitor have no automation form; see
[Out-of-the-box automations](docs/cursor-agent-automations.md#out-of-the-box-automations-bugbot-security-review-change-monitor). All eight ship `enabled: false`, so deploying them
beside the live hosts never handles an event twice. The desk's triggers (abridged; the
filter prompt is shortened):

```yaml
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
        agenticFilterPrompt: Only plain replies in a factory thread.
      - webhook: {}
```

From the repo root, as a real user:

```bash
cursor-agent automations validate .cursor/automations/factory-desk.yaml
cursor-agent automations deploy   .cursor/automations/factory-desk.yaml
```

Reference: [`docs/cursor-agent-automations.md`](docs/cursor-agent-automations.md);
runbook section: [`docs/factory-deployment.md`](docs/factory-deployment.md#9-automations-as-code-cursor-agent--yaml).

## Tests and evals

```bash
mise run test       # offline: scripts/*.test.mjs, then npm test in each project
mise run check      # tsc --noEmit in each project
mise run validate   # agent-sdk validate in each project
mise run doctor     # local preflight
```

Without mise, run the scripts' tests as
`node --experimental-strip-types --test scripts/*.test.mjs`: they import agent
`.ts` files, and Node before 22.18 strips types only with that flag.

Repo CI runs none of these tests (the orchestrator-managed workflow has no
app test hook; the request is drafted in
[`docs/orchestrator-test-hook-request.md`](docs/orchestrator-test-hook-request.md)). Before merging a factory change, run
`scripts/merge-gate.sh` on a clean checkout of the PR's final SHA and paste
its summary block into the PR description. Its optional `GATE_*` preconditions
only print warnings.

`mise.toml` pins Node 22.18 because `scripts/*.test.mjs` import `.ts`
sources. Shared modules copied between projects are held identical by
`scripts/copies-parity.test.mjs`, so run the whole task, not one project's
`npm test`. `scripts/otel-version-parity.test.mjs` keeps the six hosts on one
set of `@opentelemetry/*` versions and one copy of `@opentelemetry/api`.

Live checks, not in CI:

- `npx -p @cursor/july@0.2.22 agent-sdk eval --dir <project>` runs the model-turn
  evals and needs a Cursor credential:
  - `factory-desk/evals/desk.eval.ts` and `gates.eval.ts`
  - `triage-jira/evals/triage.eval.ts`
  - `planner/evals/plan.eval.ts`
  - `pr-autofixer/evals/coordinator.eval.ts`
  - `security-reviewer/evals/review.eval.ts`

  `factory-worker/evals/` has only a config; the worker has no eval cases.
- `node scripts/e2e-drive.mjs [--ticket KEY]` drives the deployed slugs
  through Jira and GitHub and prints one pass/fail row per step (`--help`).
  How it scores each row: [`docs/e2e-driver.md`](docs/e2e-driver.md).
- `node scripts/replay-jira-transition.mjs <URL> KEY Approved` and
  `scripts/replay-jira-comment.mjs` post signed synthetic Jira events.

## Known limitations

- Only ✅ and ❌ on the filing prompt and the plan post approve or decline.
  Block Kit buttons and cards are not used.
- Hosted kv has no compare-and-set (July 0.2.13 `host.kv` is get, put,
  delete), so there is no cross-session atomicity; how soon one run sees
  another's put is unverified. The `putIfAbsent` branches in the code
  never run in production. Duplicate suppression relies on read, put, and
  read back (the desk and the fixer), a settle wait on some desk claims,
  an owner, read-back, and settle re-read on the planner and worker claims
  (`verified-claim.ts`, `FACTORY_CLAIM_SETTLE_MS`, `FACTORY_CLAIM_MODE`),
  thread re-reads, and external checks (Jira status; `Agent.create`
  `idempotencyKey`, unverified for concurrent creates), not atomic claims.
  A put slower than the settle, or old code while a slug deploys, can still
  start a second planning session or launch; a planning session has no
  external guard.
- `sessions --prod` refuses v2 slugs (`logs --prod` and `session <id>
  --prod` work).
- The autofixer starts on a factory PR's first red check, Bugbot
  findings (at most 2 rounds), or a person's `factory: drive` comment.
  Other bot comments (the security review) never wake it, so findings on
  a green PR stay unfixed unless Bugbot reports or a person drives it.
- Nothing replays Jira events: if an Automation rule is missing or has a
  stale secret, that hop stalls until the watchdog line and `retry KEY`.
  A rule that sends a free-text smart value without `.jsonEncode` drops
  every delivery for a title with a double quote (the body is not JSON).
  When that is the desk rule, no hop-watch line posts, and `retry KEY`
  fires the same broken rule: fix the rule's custom data first, then
  `retry KEY` / `plan KEY` or a signed `scripts/replay-jira-transition.mjs`
  ([`docs/jira-automation.md`](docs/jira-automation.md), "Every free-text
  smart value needs `.jsonEncode`").
- Change review never shows ⚠️ from a comment alone, only from a check
  run's conclusion.
- Merges are human only; there is no auto-merge path.

## BDK 0.2.22 notes

All six projects pin `@cursor/july` `0.2.22` exactly, with no caret
(`factory.json`, each host's
`package.json` and lockfile, and the deploy CLI),
and the desk and the worker pin `@cursor/sdk` `1.0.37`, the version July
pins. What changes in operation (dropped `cursor.cost.usage`, dummy OTel
exporter so July builds no local provider, sdk 1.0.37) and the rollback
note are
in [`docs/factory-deployment.md`](docs/factory-deployment.md#bdk-0222-upgrade).
The package ships two bins, `bdk` and `agent-sdk`; they are the same CLI.
These docs use `agent-sdk`.

New in 0.2.12 and 0.2.13 (operational detail and the post-upgrade checks
are in [`docs/factory-deployment.md`](docs/factory-deployment.md#bdk-0213-upgrade)):

- Read tools (`effect: "read"`: the planner's `read_ticket`, `get_plan`,
  `git_history`, `search_sandbox`) are retried up to 3 times when they
  throw a transient error.
- A hosted turn that fails with `connection_stalled` is retried instead of
  failing.
- Hosted v2 schedules (the desk's `hop-watch`) are declared in the deploy
  manifest, so the `platform timer upsert failed for schedule "hop-watch"`
  boot line goes away.
- The hosts' `fallbacks` models also take over when a team admin blocks
  the main model ("Model Blocked").
- The desk's `selfName` is its Slack profile name (Slack section).

Still needed on 0.2.18 (its `setTitle` and `users.info` code is byte-identical to 0.2.13), because neither bug is fixed upstream:
`withAgentSession` for `setTitle not-ok error=no_permission` (#183), and
`july-user-cache.ts` plus `hostSlackTransport` for the `users.info` cache
(#182, [`docs/july-users-info-cache.md`](docs/july-users-info-cache.md)).

Adopted in 0.2.11:

- `agent-sdk logs --prod --slug <slug> --team <team> [--session <ses_>] [--once] [--json]` reads
  hosted v2 logs. Checked live on `factory-security-reviewer`: it shows the
  `pull_request` admission, the `github-event` line, the review session's
  tool calls, and `review-posted`. So the reviewer's debug channel and
  `host.kv` event list are removed (#160), and the `FACTORY_DEBUG_TOKEN`
  secret is deleted after the redeploy.
- Slack `reaction_added` reaches the hosted desk (July 0.2.11 and later),
  so ✅ and ❌ approve or decline on the filing prompt and the plan post
  (see Slack), once the app carries a 0.2.11-or-later manifest. The
  comment in `factory-desk/agent/lib/reaction-approval.ts`
  names 0.2.13 as the current package, not the first release that delivered
  the event.
- Slack sender fields on each message: `userTz`, `userIsBot`,
  `selfUserId`, and `selfName`. The desk uses its runtime self identity
  and the sender's bot flag.
- Slack channel log lines are prefixed `[bdk/slack]`.

Unchanged:

- `sessions --prod` still refuses v2 slugs ([`docs/bugs.md`](docs/bugs.md) ask 3).
- `ctx.host.kv` has no compare-and-set, so no cross-session atomicity
  (cross-run staleness is unverified), and the claim, settle, and dedupe
  workarounds stay
  (`factory-desk/agent/lib/kv-verified.ts`,
  `claim-lease.ts`, `verified-claim.ts`,
  `FACTORY_DESK_CLAIM_SETTLE_MS`, `FACTORY_CLAIM_SETTLE_MS`).
- Jira and Linear webhook signatures are still checked in the handler
  (`factory-desk/agent/lib/verify-webhook.ts`).
  The platform's pre-compute signature
  check covers SCM channels, not these custom webhook routes.
- Since 0.2.11, GitHub, GitLab, and Bitbucket credentials are referenced
  in named `{ secretName }` form only. The factory declares none: the GitHub
  channels use `cursorAccount`, which needs no token or webhook secret.
- Hosted evals are not adopted yet; evals run locally (Tests and evals).

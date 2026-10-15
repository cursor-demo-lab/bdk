# Hosted v2 deployment issues

What we hit taking the factory from local `serve --dir .` to Cursor-managed
hosting, and then running it there as a set of long-running autonomous
agents that carry tickets from intake to Done. It records the working
state each fix encodes. Issues 1 to 14 blocked a deploy. Issues 15 to 22
came from live tickets on the running factory. Secret names appear here.
Values never do. The current runbook is
[`factory-deployment.md`](factory-deployment.md).

The local path in [`../README.md`](../README.md) is unchanged: five
projects on one host, peers on, `FACTORY_INPROCESS_PEERS=1`. This page is
only the hosted path.

## What we chose

| Project directory | Hosted slug | Why |
| --- | --- | --- |
| `factory-desk` | `factory-desk` | Already running on the team |
| `planner` | `factory-planner` | Prefix every remaining slug the same way |
| `pr-autofixer` | `factory-pr-autofixer` | Same |
| `security-reviewer` | `factory-security-reviewer` | Same |
| `triage-jira` | `factory-triage-jira` | `triage-jira` is already taken on the team |
| `factory-worker` | `factory-worker` | New. Wakes on the `Approved` status and launches the implementation |

Prefix is `factory-` on every app but the desk, which already carried it.
Directory names stay the local mount slugs. Do not rename the directories
to match hosted slugs: local `serve --dir .` still mounts `planner`,
`pr-autofixer`, and `triage-jira`.

## Issues, in the order they blocked a deploy

### 1. New v1 deployments are closed

`agent-sdk slack create` and any other call that drafts an Agent Serve v1
app (`POST /internal/agent-serve/slack/apps` with
`storeTokens.architecture=v1`, or a missing `architecture` query) return
409 `v1_create_closed` / "New architecture v1 deployments are closed".
Team `<CURSOR_TEAM_ID>` is fail-closed on `agent_serve_v1_create_allowed`.

This is not factory config. Hosted factory apps are Agent SDK v2
(`/internal/agentsdk/*`). Existing v1 pods on the team keep running;
nothing new can be created there.

### 2. `slack create` hardcodes v1

The July 0.2.1 CLI wizard (`slack-provision-client`) posts to
`/internal/agent-serve/slack/wizard` and defaults `env=dev` with no
`architecture` field. The dashboard treats a missing
`?architecture=` as v1.

Do not run `slack create` for these hosted apps. Only `factory-desk` has
Slack. After that slug is READY, mint the v2 wizard against
`POST /internal/agentsdk/slack/wizard` with
`{ architecture: "v2", env: "prod", … }` and open the printed URL
**with** `&architecture=v2`.

| | Incorrect (`slack create`) | Correct (v2 dashboard) |
| --- | --- | --- |
| Wizard host | `/internal/agent-serve/slack/wizard` | `/internal/agentsdk/slack/wizard` |
| Query | `wizardId` only | `wizardId` and `architecture=v2` |
| Env | `dev` | `prod` |
| Slack mode | Socket Mode (`xapp-` app token) | Events API (bot token only) |
| Result | 409 `v1_create_closed` | Slack tokens stored on the v2 installation |

v2 Slack does not use `FACTORY_DESK_SLACK_APP_TOKEN`. The desk still
declares the name for local Socket Mode.

### 3. Multi-component deploy is gated

`agent-sdk deploy --dir . --all` (or a parent directory of all six
projects) is refused: `agent_sdk_v2_multi_component` is off for this
team. Each hosted app is a **single-slug** v2 deploy:

```bash
env -u CURSOR_API_KEY -u CURSOR_SERVICE_ACCOUNT_KEY \
  npx -y -p @cursor/july@0.2.25 agent-sdk deploy --ref <SHA> --dir <folder> --slug <slug> --cursor-events-repo cursor-demo-lab/marsbank --team <team>
```

### 4. In-process peers fail at startup on managed hosting

`defineConnection({ agent: "<directory-slug>" })` is resolved by
`collectPeerConnections` against **this process's mounts**. A
single-slug hosted app has one mount. An unknown peer throws before the
process becomes READY.

v2 HTTP ingress is channel routes only. There is no `/<slug>/v1/mcp`, so
a remote `{ url: …/v1/mcp }` hop is not a workaround. `agent-sdk mcp
--prod` refuses v2.

This branch gates every `{ agent }` file behind
`FACTORY_INPROCESS_PEERS`. Unset (hosted default): the file still
default-exports `defineConnection` (July errors on a missing one, and
`disableConnection()` is only valid in an extension overlay) as an
inline `unmounted` stub. Set to `1` / `true` / `yes`: the real peer,
which local `serve --dir .` needs.

Do not set `FACTORY_INPROCESS_PEERS` as a hosted secret. Even if you
did, the peer `agent` values are local directory slugs (`planner`,
`pr-autofixer`, `factory-desk`), not the prefixed hosted slugs.

### 5. Import-time `FACTORY_*` throws block the first freeze

A hosted install cannot receive secrets until at least one component is
READY. Several modules used to throw while loading when `FACTORY_REPOS`
/ `FACTORY_SANDBOX_REPO` were unset, so the freeze never started and
`secrets set` returned 500.

Fixed on this branch:

| Module | Was | Now |
| --- | --- | --- |
| `factory-desk/agent/extensions/cloud.ts` | `sandboxRepo(process.env)` at import | Catch `FactoryConfigError`, mount no repo |
| `pr-autofixer/agent/lib/repos.ts` | `githubRepos()` at import | Import is quiet; `githubReposAtBoot()` returns `[]` |
| `security-reviewer/agent/lib/repos.ts` | Same | Same |
| `pr-autofixer` / `security-reviewer` GitHub channels | `repos: githubRepos()` | `githubReposAtBoot()`; empty becomes `cursorAccount: true` (July throws on `{ repos: [] }`) |

`githubRepos()` still throws when a turn or `POST /drive` needs a list
and none is configured. Set secrets after READY; the next task sees
them. No redeploy is required for v2 installation secrets.

### 6. Deploy as the user login, not a service account

A service-account `CURSOR_API_KEY` (`sa_…`) has no GitHub identity. The
hosted freeze clone then fails with `GithubNoUserCredentialsError` /
`[unauthenticated] Error`.

Use `agent-sdk login` (Simon) and unset `CURSOR_API_KEY` /
`CURSOR_SERVICE_ACCOUNT_KEY` for `deploy`. A user `crsr_…` token also
works; the `.env.local` service-account key does not.

### 7. `agent-sdk logs --prod` does not support v2

Resolved for `logs` in 0.2.11. Before 0.2.11 the CLI rejected v2 slugs
(`rejectV2ForLegacyCommand`). Since 0.2.11, `logs --prod` has its own v2
path: `bdk logs --prod --slug <slug> [--session <id>] [--once] [--json]`
follows the slug's recent sessions, or one session with `--session`.
`sessions --prod` still goes through the guard and refuses v2 (still open,
[`bugs.md`](bugs.md) ask 3). Verify a deploy with `agent-sdk deployments`
(status `running`) and the dashboard.

### 8. Secrets only after READY

`agent-sdk secrets set <slug> NAME…` reads one value per stdin line and
needs an installation. That exists only after the first component is
READY. Setting secrets during `deploying` returns 500.

Per hosted slug, after `running`:

Every slug also takes the model triple `FACTORY_AGENT_MODEL`,
`FACTORY_AGENT_EFFORT`, `FACTORY_AGENT_SPEED` (default model `auto-smart`
with `optimize_for=balanced`, except `grok-4.6` fast on `factory-desk` and
`factory-triage-jira`; effort and speed apply only to other ids;
set only to override) and the status names it reads
(`FACTORY_STATUS_*`, defaults in `event-driven-factory.md`).

| Slug | Secret names |
| --- | --- |
| `factory-desk` | `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET`, `FACTORY_DESK_INTAKE_CHANNEL`, plus `FACTORY_DESK_SLACK_BOT_TOKEN` after the v2 Slack wizard |
| `factory-triage-jira` | `JIRA_WEBHOOK_SECRET`, `FACTORY_JIRA_PROJECTS` |
| `factory-planner` | `FACTORY_REPOS`, `FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`, `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET` |
| `factory-worker` | `FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`, `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET` (the implement model is `IMPLEMENT_MODEL`, `claude-opus-5-5`, `300k`, `high`, `false`; `FACTORY_WORKER_*` apply to a local `serve` only, issue 27) |
| `factory-pr-autofixer` | `FACTORY_REPOS`, `FACTORY_JIRA_PROJECTS` |
| `factory-security-reviewer` | `FACTORY_REPOS` |

`FACTORY_PLANNER_CHECKOUT` is a local path. It is useless on the hosted
VM; leave it unset. Hosted planning turns run on a Cursor cloud agent
with a clone of `FACTORY_SANDBOX_REPO` @ `FACTORY_SANDBOX_REF` (issue 24),
so the model reads files there. The host-side tools (`search_sandbox`,
`record_plan`'s path check) still read the GitHub tree through
`githubChannel({ cursorAccount })` / `ctx.host.github` (github-proxy
pass-through; no PAT). A claimed failure that is not on that ref is
`Needs info:`, not a prompt-only plan.

### 9. No Atlassian or GitHub connector on the deploying account

Found 2026-09-23 while trying to read the `TLSSN` workflow. A throwaway
project with `defineConnection({ cursorAccount: true, servers: "*" })`
run as `<OPERATOR_EMAIL>` (`agent-sdk whoami`: `credentialSource:
login`) lists only the Canva connector. `servers: ["Jira"]`,
`["Atlassian"]`, and `["GitHub"]` each return "No matching connectors on
this account". Every factory Jira read and write goes through the
Atlassian connector, so a hosted slug deployed as this login has no Jira until Atlassian is
connected at `https://cursor.com/dashboard/integrations`. The
`githubChannel({ cursorAccount })` event stream on the fixer and reviewer
is a different mechanism and is not covered by this finding.

Consequence for the design: status names are configuration
(`FACTORY_STATUS_*`), and the transition tool names are discovered by
shape at run time, because neither could be observed.

### 10. GitHub-channel slugs need the team's GitHub App on the sandbox

`deploy --dir pr-autofixer --slug factory-pr-autofixer --cursor-events-repo
example-org/demo-repo` bakes, starts, passes health, then ends
`failed: GitHub repository is not accessible through this team's
installation` (2026-09-23, same for `factory-security-reviewer`). The
check runs at "Finishing deployment" for a `githubChannel({ cursorAccount })`
subscription. The desk, which has no GitHub channel, accepts the same
flag. The two running GitHub-channel apps on the team watch `rysuds/*`
repositories, so the team's Cursor GitHub App installation does not
cover the `example-org` organisation.

Resolution (2026-09-23): the sandbox moved to `cursor-demo-lab/marsbank`,
an org where the `cursor` GitHub App is installed on all repositories
(`gh api orgs/cursor-demo-lab/installations`). `marsbank` is a
single-commit snapshot of `cursor-demo-lab/marsbank@8d0af40` with the
example-org platform wiring removed and a plain CI workflow (lint,
vitest). The agent source stays in `example-org/demo-repo`; only the
watched and launched-into repository changed. `scripts/doctor.mjs` now
has a `github-app` check for this.

Not resolved by the move. Redeploying both slugs with
`--cursor-events-repo cursor-demo-lab/marsbank` at `00d276f` fails with
the same message. The `cursor` app being installed on the GitHub org is
necessary but not sufficient: the installation must be linked to the
**Cursor team** that owns the slug (team `<CURSOR_TEAM_ID>`, <CURSOR_TEAM_NAME> &
ADM). The desk accepted the same flag because it declares no GitHub
channel, so nothing checks it. The doctor's `github-app` check therefore
passes on this org and still cannot predict the failure; the deploy is
the only check. Fix: in the Cursor dashboard, with team <CURSOR_TEAM_NAME>
& ADM selected, Integrations → GitHub → Manage, and add the
`cursor-demo-lab` installation (or `cursor-demo-lab/marsbank`) to this
team.


**Planner search snippets (2026-09-25):** Hosted `search_sandbox` listed GitHub paths with empty snippets (tree-only), so the model could not open `lib/report-csv.ts` / the intentional empty-habit 500 fixture and wrote `Needs info:` on TLSSN-20 after desk bounces. Hydrate top path hits via `GET …/contents/{path}` through `ctx.host.github` (same pass-through as the tree). Redeploy `factory-planner` with `--cursor-events-repo cursor-demo-lab/marsbank`, then bounce the ticket.

**Planner (2026-09-25):** PR #84 added `planner/agent/channels/github.ts` (`githubChannel({ cursorAccount })` for hosted sandbox tree reads). A bare `deploy --dir planner --slug factory-planner --ref main` then fails at Finishing deployment with `GitHub repository is not accessible through this team's installation` (release `cc107ae2`, Automation rule `factory-planner` emailed audit `dacdf03b-…` while the slug was down). Recover with `--cursor-events-repo cursor-demo-lab/marsbank` so finish-check binds the team-owned install; confirm `watching: cursor-demo-lab/marsbank`. Do not attach the `example-org` installation to team `<CURSOR_TEAM_ID>`.

### 11. Hosted connectors run as the deployment service account

Every hosted Jira write returned `not_connected` although Simon had
connected Atlassian. Traced from source (`@cursor/july` 0.2.2, everysphere
`main`):

- The pod's `CURSOR_API_KEY` is "one team API key bound to its dedicated
  service account" per deployment (`agentServePodCredential.ts:4-7`); the
  account MCP bridge binds to it at task time (`dist/internal/server.js:508-517`).
- "The hosted bridge resolves the SA's team servers, so personal
  connectors can never apply to a deployment"; the catalog is filtered to
  `isTeamServer` (`dist/internal/cursor-account-mcp-auth.js:5-7, 51-53`).
  `servers` entries match a server `name` or `serverIdentifier`,
  case-insensitive (`:120-133`).
- The team plugin's Atlassian MCP (plugin <CURSOR_PLUGIN_ID>) shows in the dashboard's
  Team MCP Servers, but the backend returns it per user
  (`serverIdentifier: "user-Atlassian"`, no `isTeamServer`, no
  `owningTeamId`), so hosted slugs skip it. Measured with
  `GetAvailableMcpServers`, 2026-09-23.

**Viable path, and its constraints.**

1. **A team MCP server, not a plugin-managed one.** `Factory Atlassian`
   (team MCP server id `<MCP_SERVER_ID>`, HTTP, `https://mcp.atlassian.com/v2/mcp`),
   selected with `defineConnection({ cursorAccount: true, servers: ["Factory Atlassian"] })`.
   Plugin-managed servers surface per user (above), so no slug sees them.
2. **One identity per slug.** Each deployment runs as its own service
   account, `agent-serve-agentsdk:v2:<slug>` (`ListTeamServiceAccounts`).
   Probing as your own login tests the wrong principal.
3. **Grants are per service account, per server.** No shared team
   credential mode was found, so the four Jira slugs (`factory-desk`,
   `factory-triage-jira`, `factory-planner`, `factory-worker`) each need
   one consent. Two ways to give it:
   - Dashboard: Deployed Agents, slug, MCP connectors, **Authenticate**. It
     posts `/api/background-composer/check-http-mcp-status` with the
     deployment's `serviceAccountId` and opens the returned `authUrl`
     (everysphere
     `portal-website/.../deployed-agents/DeployedAgentConnectorsSection.tsx:240-263`,
     gated on `deployment.capabilities.mcp`,
     `DeployedAgentConfigurationSection.tsx:626-638`).
   - As a team admin, mint the same link with
     `CheckHttpMcpStatus({ serverIds: [<MCP_SERVER_ID>], oauthRedirectUri, serviceAccountId })`
     and open its `authUrl`.

   The CLI cannot do it: `agent-sdk mcp oauth` refuses v2 ("not supported
   for architecture v2 deployment",
   `dist/internal/legacy-command-guard.js:37`, called from
   `cli-mcp-oauth.js:223`), and the deploy hook points to the dashboard
   (`cli-deploy.js:807`).
4. **Host connections share the grant.** The desk, planner, and worker keep
   the tracker in `agent/host-connections/` (the model never sees Jira
   tools); triage keeps it in `agent/mcp-connections/`. Both kinds go into
   one account bridge (`dist/internal/cursor/account-mcp.js:58-61` collects
   `connections` and `hostConnections` together), and that bridge binds to
   the pod's service-account key (`dist/internal/server.js:508-517`). The
   dashboard's MCP connectors card lists only `mcp-connections`, so for
   the three host-connection slugs it may show nothing to Authenticate;
   minting the link with `CheckHttpMcpStatus` covers them.
5. **Consent comes from an Atlassian account on the site.** Sign in to
   Atlassian as `<OPERATOR_EMAIL>`, which is on `<JIRA_SITE>`.
   Any other account sees "Your account isn't associated with a supported
   site" and is offered Bitbucket scopes only; accepting that stores a token
   with no Jira access. Whoever consents is who every Jira write is made as.
6. **Tool names and `cloudId`.** From Atlassian's supported-tools page and
   `github.com/atlassian/atlassian-mcp-server` (skills README, 2026-09-15).
   v2 lists its primary tools directly: `getJiraIssue`, `createJiraIssue`,
   `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`
   (renamed from v1's `addCommentToJiraIssue`), `searchJiraIssuesUsingJql`,
   `getAccessibleAtlassianResources`, plus the meta-tools `discover`,
   `executeRead`, `executeWrite`, `executeDestructive`. Listing transitions
   (`listJiraIssueTransitions`, v1's `getTransitionsForJiraIssue`) and
   comments (`listJiraIssueComments`) are catalog operations, reached as
   `executeRead({ name, cloudId, inputs: { issueIdOrKey } })`; the
   `?tools=all` endpoint lists them flat instead. v2's `getJiraIssue` is
   documented as returning a comment count, not bodies. The helpers
   (`agent/lib/jira.ts` in the desk, planner, and worker; `actuate.ts` and
   `transition.ts` in triage, with the shared `agent/lib/atlassian.ts`)
   match both generations and the generic snake_case names, list
   transitions and comments through `executeRead` when no direct tool is
   listed, fall back to `getJiraIssue` with `fields` including `comment`,
   and read bodies from `fields.comment.comments[].body` or a comment page,
   flattening ADF. Every Atlassian tool requires `cloudId`, and the site
   URL is accepted, so each call adds `cloudId` exactly when the tool's
   schema declares it (`cloudId` or `cloud_id`), from `JIRA_CLOUD_ID`,
   default `https://example.atlassian.net`. Triage's search
   sends JQL (`key = TLSSN-42`, `project = TLSSN AND summary ~ "..."`).
   Not observed live: the exact v2 input schemas, and whether the Cursor
   backend lists the default or the `?tools=all` set.

**Fallback.** If the connector path stays blocked, branch
`cursor/factory-jira-rest-54c8` on origin replaces the tracker connections
with a Jira Cloud REST v3 client in host code (`api.atlassian.com`, Basic
auth `JIRA_EMAIL:JIRA_API_TOKEN`), keeping the helpers' names and return
shapes. It also reads `JIRA_CLOUD_ID`; the site's cloud UUID
(`564eb250-21c1-45d7-81f9-527d6bf705ad`, that branch's default) satisfies
both that client and the MCP tools, while the site URL satisfies only the
MCP tools.

### 12. GitHub events on hosted v2

Found 2026-09-23 on marsbank #6 and #7: zero sessions on the fixer and the
reviewer. everysphere paths are under `backend/server/src`.

- **Bot-authored comments never reach the app.** Webhook ingress drops
  every `issue_comment created` whose author is a bot before auth and
  before the Agent SDK tap (`github/githubWebhook.ts:1320-1329`; bot is
  type `Bot` or `App`, a `[bot]` login, `github-actions`, or the Cursor
  bot, `github/githubWebhookBotGuards.ts:16-38`). The `factory: drive` on
  #7 was `cursor[bot]` (the e2e driver's cloud agent,
  `scripts/e2e-drive.mjs:382` on the #41 branch), so it was dropped. The
  sentinel must be typed by a person on GitHub.
- **`check_run` is not forwarded.** `isPlatformWorkflowWebhook` has no
  `check_run` branch (`bugbot/github/githubWebhookAuthed.ts:216`), so the
  automations trigger, the only path to the v2 tap, never runs for it.
  `check_suite completed` (`:194-197`) and `workflow_run completed`
  (`:211-214`) do pass. Actions never emit `status`.
- **Desk drive comment. Resolved by removal.** The desk no longer has a
  GitHub tool or connection, so it cannot post a comment that ingress
  would drop. Asked to fix a PR, it replies in the thread that the person
  types `factory: drive` on the PR. The main path for factory PRs is the
  fixer's drive on the first red check; that human-typed comment is the
  manual override.

What we changed: pr-autofixer's first-red-check drive also fires on
`check_suite` and `workflow_run` completed with conclusion `failure`,
`timed_out`, `action_required`, or `startup_failure`, same factory-PR test and
`auto-drive:<owner>/<repo>#<n>` claim (`pr-autofixer/agent/lib/auto-drive.ts`,
`agent/channels/github.ts`). The manifest now also declares
`workflow_run`, so the fixer needs a redeploy with its
`--cursor-events-repo`.

Open: factory-security-reviewer produced no session for `pull_request
opened`. Manifest, deployment record, secret names, and gate defaults
check out; the event is lost after the Temporal handoff or in the guest
(hypothesis H1 in the diagnosis). The reviewer's debug build (a `host.kv`
`debug/github-events` list served at `GET /v1/channels/debug/events`
behind `FACTORY_DEBUG_TOKEN`) is removed (#160) now that `logs --prod`
reads v2 slugs (issue 7); the `FACTORY_DEBUG_TOKEN` secret is deleted
after the redeploy. The hooks still log one `factoryDebug: "github-event"`
line per delivery they see, skipped and refused ones included, and a
`factoryDebug: "review-posted"` line per posted review. A live check of
`bdk logs --prod --slug factory-security-reviewer` showed the
`pull_request` admission, the `github-event` line, the review session's
tool calls, and `review-posted`.

### 13. Slack mentions on the desk start no session

Found 2026-09-23. `@factory-desk hello` in `#mars-eng-intake` (workspace
Cursor FE & ADM, `T0EXAMPLE1`) got no reply and no 👀 fast-ack. The
dashboard shows 0 sessions for `factory-desk`, ever.

Checked and fine on our side:

- Deployment `running` at main `2eb526c`, Slack channel tag present,
  `FACTORY_DESK_SLACK_BOT_TOKEN` a secret on the release, Slack card
  Installed.
- Slack app `factory-desk` (`A0EXAMPLE1`): Enable Events on, request URL
  `https://api2.cursor.sh/slack/agent-sdk/events` Verified, bot events
  `app_mention`, `message.im`, `app_home_opened`, installed in
  `T0EXAMPLE1`, the workspace the mention came from.
- The engagement is mentions and DMs, so the channel type does not
  matter.

The Events route (`backend/server/src/agentServe/agentSdkSlackAppEvents.ts`)
answers 200 on every path and drops silently at five points: unknown app
id (no custody row), bad signature, workspace mismatch, an inadmissible
event (bot author, system subtype), and the dispatch gate. The fast-ack
and the mailbox fanout both sit after the gate (`:382-396`, `:435`). The
gate is `agent_sdk_slack_events_dispatch`, `default: false`, evaluated
against the custody row's owner team (`experiments/experimentConfig.ts`,
the `agent_sdk_slack_events_dispatch` entry). The custody row exists (the
card reads Installed), the workspace matches, and a human `app_mention`
is admissible, so the gate is the one default-closed switch left. The
other v2 ingress gates, `agent_sdk_shadow_tap_enabled` and
`agent_sdk_verified_ingress_admit`, default true, and Jira events reach
our slugs through the same fanout.

Status: open, inferred rather than proven. We cannot read the gate value
for team <CURSOR_TEAM_ID> or the route's `outcome` metric (`gated` would confirm
it). Ask: the gate owner adds a teamID rule for <CURSOR_TEAM_ID>, or confirms the
outcome for `A0EXAMPLE1` at 07:24 UTC on 2026-09-23. The bot token is
not the cause: events route by `api_app_id` to the custody row, and the
token is used only to reply, so a wrong token would show a session with a
failed reply, not zero sessions.

Related cleanup: a second wizard app, `factory-worker` (`A0EXAMPLE2`),
exists in the same workspace with `FACTORY_WORKER_SLACK_BOT_TOKEN` on that
slug (created 2026-09-23 04:19 UTC), and `factory-pr-autofixer` has a
Pending Installation app with `PR_AUTOFIXER_SLACK_BOT_TOKEN` (04:19 UTC).
Neither the worker's nor the fixer's code declares a Slack channel;
`factory-desk` is the only Slack agent. Remove wizard apps through
the dashboard Slack card or `slack destroy` so the custody row goes with
the Slack app.

### 14. Approve returned `status_unknown`: reply shape, not scope

Found 2026-09-24 on TLSSN-18. `approve KEY` returned
`reason: "status_unknown"` ("Jira could not be read"), while
`file_ticket` had worked on the same connector. Factory Atlassian's
consent was not the cause, and no re-consent is needed.

Rovo's `getJiraIssue` answers on two channels. The text block is the REST
v3 issue, with `fields.status.name`. For MCP clients it recognises
(`cursor` is one), it also sends `structuredContent`, an `issues.nodes`
envelope around the issue (atlassian/atlassian-mcp-server #213, #118).
The Cursor backend and July's account bridge pass both channels to
`ctx.host.mcp` (`toCallResult` in
`dist/internal/cursor/backend-client.js`).

Before #82, the desk's `statusOf` went through `parsedResult`. That helper
returned `structuredContent` whenever it was present and never read the
text, and `statusOf` then looked for `fields.status.name` at its top level.
The envelope has no top-level `fields`, so every read came back unread.
`createIssue` finds the new key with a regex over either channel, so
`file_ticket` worked. The planner, worker, and triage read
`structuredContent` and then the text, so their status reads worked on the
same server.

#82 added a text fallback to the status read, and that fallback is what
fixed it. Its `fields` request and its scope note were not the cause. The
transition list and the comment reads still used `parsedResult`, so an
approve could pass the status read and then stop at `no_transition` with
nothing available. Now every desk reply is read from `structuredContent`
and then from the text. The status walk understands `nodes`, the status
read asks for `status` only, and a reply with no status says in `detail`
which channels came back. An unread status still moves nothing.

### 15. TLSSN-21: a late plan rolled a launched ticket back to Planned

Found 2026-09-25 on TLSSN-21 (`#mars-eng-intake`, thread
`1790301410.693199`). Times are AEST.

| Time | Slack thread | Jira history |
| --- | --- | --- |
| 11:58:01 | `Filed TLSSN-21 … Triage and planning are underway` | created, To Do |
| 11:58 to 12:04 | nothing | (triage's comment and To Do → Triaged; not in the history read) |
| 12:04:13 | `plan TLSSN-21`; desk replies "is in Triaged" at 12:04:54 | the desk bounces Triaged → To Do → Triaged |
| 12:05:34 | `TLSSN-21 is planned` | Triaged → Planned (~12:05) |
| 12:06:00 | `approve TLSSN-21` | Planned → Approved (~12:06) |
| 12:06:59 | `Implementation of TLSSN-21 started: <url>` (the In Progress announce) | Approved → In Progress (~12:07) |
| ~12:10 | nothing | **In Progress → Planned** |
| ~12:12 | nothing | Planned → Planned |
| later | nothing after marsbank #18 opened and went ready for review | still Planned |

Every move reads "the operator" in Jira because every connector write is
made as the consenting account (`<OPERATOR_EMAIL>`), whichever
slug made it.

Cause, from the code:

1. Every entry into Triaged opens its own planning session. The planner
   claims `plan/<KEY>:Triaged:<changelog.id>`, one per transition, so
   triage's own move, the desk's `plan KEY` bounce, and a signed replay
   each start one. A planner run takes minutes: on TLSSN-19 the plan
   landed about 4¾ minutes after the desk's bounce.
2. `record_plan` moved the ticket to Planned with an unguarded
   `transitionIssue` whenever it wrote a new `Plan:` comment. A second
   session never writes a byte-identical plan, so it always took that
   branch. The function's own comment said the move must not drag an
   approved ticket back, but only the `already_commented` branch was
   guarded (`transitionFrom` Triaged).
3. Three Planned moves means three sessions finished: one at ~12:05, one
   at ~12:10 (the one that moved In Progress → Planned), and one at
   ~12:12 (Planned → Planned).
4. With the ticket in Planned, the worker's move on marsbank #18
   (`transitionFrom` In Progress → In Review) correctly did nothing.
   Its only record was a log line, and hosted v2 showed no logs then
   (`logs --prod` reads v2 from 0.2.11). The
   desk's Planned announce was skipped behind its sticky
   `announced/<KEY>:Planned` claim, so Slack never heard the rollback.

`triage-jira` had the same unguarded shape: a fresh `Triage:` comment
moved any status to Triaged.

The six silent minutes after filing were not a stall. The desk did not
wake on Triaged, so the thread gets nothing between filing and the plan,
and it said "triage and planning are underway" after filing and after
every `plan KEY`. That silence is what prompted the bounce and the
replays that started the extra sessions. TLSSN-19 and TLSSN-20 show the
same pattern. TLSSN-20's triage verdict was a duplicate of TLSSN-19,
which the planner skips by design, so it would never have planned, and
the desk told the thread twice that planning was underway.

Not provable without the TLSSN Automation audit log and the ticket's
changelog with timestamps:

- Which wake started the session that finished at ~12:05. The timing
  (54 seconds after the bounce, where a planner run takes minutes)
  points to triage's own Triaged move at about 11:59 reaching the
  planner through Automation. Two of the three wakes were manual (the
  bounce and the signed planner replay), so at least one came from
  Automation on a connector move. An Automation redelivery rendered
  after `issue.updated` changed would also carry a new changelog id in
  the status template and start a session.
- Whether `triage-jira` woke from Automation or from the operator's
  signed `issue_created` replay. Either way the ticket was in Triaged by
  12:04, which is what the desk read. A replay after triage had
  commented is a no-op: triage finds its own comment and moves only
  from To Do.
- The `Implementing:` comment that is hard to find on the ticket now.
  The desk posted the agent URL at 12:06:59 from the latest
  `Implementing:` comment, so it was there then. No factory code edits
  or deletes a comment; the two later `Plan:` comments bury it.

Fixed on `cursor/triage-plan-wake-stall-650e`:

- `record_plan`, in a chained session, reads the status first. Outside
  Triaged it writes no comment, tags no artifact, and moves nothing
  (`reason: "not_triaged"`). The Planned move is `transitionFrom`
  Triaged in every case.
- `record_triage` moves to Triaged only from To Do.
- The desk wakes on Triaged and posts the latest `Triage:` verdict into
  the ticket's thread, including when the planner will skip it.
  `request_plan` moves nothing (`triage_gate`) when the planner would
  skip it. A move into Planned from Approved or later is posted as a
  move back. The In Progress line now reads `KEY is In Progress.
  Implementation started: <url>`.
- `factory-worker` leaves one Jira comment when the implement PR's In
  Review or Done move is skipped, naming the status it found.
- One status reader in the shared `atlassian.ts` (status-only `fields`,
  Rovo's `issues.nodes` envelope, never a string `status` envelope) for
  the planner, triage, and worker guards.

Operator steps: add Triaged to the `factory-desk` rule's trigger
([`jira-automation.md`](jira-automation.md), "Operator checklist"),
then redeploy `factory-triage-jira`, `factory-planner` (with
`--cursor-events-repo`), `factory-worker` (with
`--cursor-events-repo`), and `factory-desk`. While a ticket waits for
its plan, do not bounce it or replay Triaged: the Triaged line says the
planner is working, and each extra entry into Triaged spends a planner
run even though a late one now writes nothing.

TLSSN-21 itself is still in Planned with its agent running and #18
open. Drag the card to In Progress (the desk posts the agent link
again), then to In Review, or push to #18 once it is In Progress and the
worker moves it.

Nobody dragged it. #18 was merged in Planned and the card stayed there;
see issue 17.

### 16. TLSSN-22: the planner asked for more information and the thread heard nothing

Found 2026-09-25 on TLSSN-22 (`#mars-eng-intake`, thread
`1790306219.976189`), the first smoke after #93. Times are AEST.

| Time | Slack thread | Jira |
| --- | --- | --- |
| 13:16:59 | `@factory file a bug: … CSV export truncates the last column when the download filename contains spaces` | |
| 13:19:47 | `TLSSN-22 is filed … the Plan lands here when the ticket reaches Planned.` | created, To Do |
| 13:19:48 | `TLSSN-22 is Triaged: bug, high severity. The planner is writing the plan; it lands in this thread when the ticket reaches Planned.` | `Triage:` bug, high; To Do → Triaged |
| minutes later | nothing | planner searched `cursor-demo-lab/marsbank@main`, found no CSV export, wrote `Needs info: TLSSN-22`; ticket stays Triaged |
| 30+ minutes | nothing | still Triaged |

Not a wake stall: the planner woke, checked, and did the right thing.
Two gaps in the desk:

1. The filing reply and the Triaged line promised a plan. The planner
   checks the claim against the sandbox before it plans (#83), so a
   bug report can end in `Needs info:` instead.
2. The desk wakes only on status changes. `Needs info:` leaves the
   ticket in Triaged, so no Automation rule fired and the desk never
   learned the planner had finished. The same held for a planning run
   that failed, or whose plan `record_plan` refused, and for a replan
   that found nothing again (`record_needs_info` skipped any ticket that
   already had a `Needs info:` comment, so it wrote nothing new).

Fixed on `cursor/slack-always-reply-why-8bfd`:

- The desk takes a signed `comment_created` on its Jira route from a
  fifth TLSSN rule, `factory-desk-comments`. A first line of
  `Needs info: <KEY>` or `Plan stopped: <KEY>` posts, into the ticket's
  thread, what the planner checked, what the ticket claimed, what it
  searched, and the next step (add a failing path to the ticket, then
  `plan KEY`). Every other comment is ignored before any Jira read. No
  new Jira status and no status bounce, so the planner is not woken.
- The Triaged line, the filing reply, and the `plan KEY` reply name both
  endings: a plan at Planned, or what information the planner needs.
- `record_needs_info` writes once per planning run, not once per ticket,
  and outside Triaged writes nothing (the #93 guard). Each body carries
  the minute it was checked, so a replan's verdict is a new comment.
- A planner hook writes `Plan stopped: <KEY>` with one `Why:` line when a
  pinned run ends with neither a plan moved to Planned nor Needs info,
  and the ticket is still Triaged.

Operator steps: add `factory-desk-comments` ([`jira-automation.md`](jira-automation.md),
"Five rules" and step 5 of the checklist), redeploy `factory-desk` and
`factory-planner` (with `--cursor-events-repo`), then post TLSSN-22's
existing comment with `node scripts/replay-jira-comment.mjs <desk URL>
TLSSN-22 --comment-id <id>`.

### 17. TLSSN-21: the implement PR was merged and the ticket stayed Planned

Found 2026-09-25. example-user merged
[marsbank #18](https://github.com/cursor-demo-lab/marsbank/pull/18)
(`d87a589c`) at 09:14:07Z (19:14 AEST). The code was right. The worker
posted `Done not set from cursor-demo-lab/marsbank#18: TLSSN-21 is
Planned, not In Review or In Progress, so the worker left it there`, and
the desk relayed it to `#mars-eng-intake` (thread `1790301410.693199`).

The gaps:

1. **Done-on-merge refused Planned.** `advanceTicket` moved to Done only
   from In Review, or from In Progress through In Review. Anything else
   got the note and no move. That rule assumed the ticket could only be
   behind because an event was missed. On TLSSN-21 it was behind because
   of drift (issue 15), and a person's merge of the ticket's own
   implement PR (a recorded launch, the key on the head branch, the
   sandbox base, not a bot merge or auto-merge) is enough evidence to
   close it.
2. **Why it was Planned.** A late planner session moved it In Progress →
   Planned at ~12:10 AEST (02:10Z). #93 guarded that at 03:10Z, an hour
   later, but did not repair tickets that had already drifted. Issue 15's
   hand fix was never done. On main, the planner moves to Planned only
   from Triaged, triage moves to Triaged only from To Do, and the desk's
   `approve` / `plan` read the status before they move (Planned only; To
   Do, Triaged, or Planned).
3. **The PR-open move was skipped too.** #18 opened while the ticket was
   Planned, so In Review (In Progress only) was skipped. It opened before
   #93, so there was no note either. This stays strict on purpose: a push
   to a PR whose ticket someone replanned must not pull it back.
4. **Re-approval left the ticket in Approved.** Still on main: a launched
   ticket that drifted back and was approved again found `moved: true`
   on `implement/<KEY>` and returned without moving it. It never
   relaunches, so it sat in Approved.
5. **An unreadable status on a merge was dropped.** A merge is delivered
   once, and a status read that failed returned without a retry.

Fixed on `cursor/factory-done-on-merge-drift-f97b`:

- A person's merge moves the ticket to Done from In Review, or through In
  Review from In Progress, Approved, Planned, Triaged, or To Do. The desk
  announces both moves. The log line carries `resyncedFrom`. Any other
  status (a custom "Won't Do", say) stays put, with the note.
- A merge that cannot read the status notes it once and throws, so hosted
  admission retries.
- A later Approved on a launched ticket moves Approved → In Progress even
  after a recorded move. It never launches again.

TLSSN-21 itself: the merge delivery for #18 has passed and its claim was
released, so after redeploying `factory-worker`, drag the card to Done
(or In Review, then Done) by hand. Tickets merged after the redeploy
close on their own.

### 18. marsbank#28: the implement PR stayed a draft (github-proxy GraphQL scope)

Found 2026-09-26 on TLSSN-31, the first run after #126 made every
factory PR ready for review on open. Times are AEST.

| Time | What |
| --- | --- |
| 11:08:40 | `factory-worker` running #126 (`2f41356`) |
| 12:10:48 | `cursor[bot]` opens [marsbank #28](https://github.com/cursor-demo-lab/marsbank/pull/28) as a draft (`autoCreatePR` has no draft switch) |
| seconds later | Worker task: `GET /repos/cursor-demo-lab/marsbank/pulls/28` answers 200 with `draft: true`. `POST /graphql` (`markPullRequestReadyForReview`) answers 400. The worker records `pr_ready: failed`, and the Pull request link and the In Review move still run |
| about 4 h later | A person or agent marks #28 ready by hand, and Bugbot runs |

The token's scopes were fine. A hosted v2 slot boots before deployment
secrets are bound, so `agent/channels/github.ts` declares
`cursorAccount: true` and July binds github-proxy with no static
`x-cursor-github-repos`. July's Octokit hook fills that header per request
only from a `/repos/<owner>/<repo>` URL. `POST /graphql` has none, so the
proxy answered `400 Missing x-cursor-github-repos header`. That is the
same failure `pr-autofixer` hit in #60, which is why the fixer reads PRs
over REST. July's `ctx.github.request` throws on a non-2xx response, and
the worker's catch dropped the status. The unit tests faked
`ok: false`, so they never went down that path.

Fixed in #130 (`97612fc1`), worker only:

- The mutation goes through `ctx.github.getOctokit()` with
  `x-cursor-github-repos: <sandbox repo>` set explicitly. The PR read uses
  the same client.
- Three tries in the task. Success, or a person's own draft, is recorded
  at `pr-ready/<repo>#<n>`. Until then, `synchronize` and `edited`
  deliveries retry.
- A PR still draft after the task gets one Jira comment,
  `Ready for review not marked on <repo>#<n>: … (write_failed, HTTP 400)`,
  and the task throws after the move so hosted admission redelivers it.
- A person's `converted_to_draft` is recorded and never undone.
- `channels/github.test.ts` drives July's real proxy transport on a
  hosted-style boot and fails on the old code.

Status: fixed and redeployed. Open follow-up: the desk does not yet post
a Slack crumb for the `Ready for review not marked` note.

### 19. Concurrent deliveries both won a claim (no kv compare-and-set)

Found 2026-09-26 during the TLSSN-30 and TLSSN-31 review. #125 had fixed
replays that arrive one after another: the Triaged line is claimed per
verdict fingerprint, and Needs info is claimed once per
`triaged-entry/<KEY>`. The claim itself was still `takeLease`:
read, put, read back. `ctx.host.kv` has only get, put, and delete
([`bugs.md`, ask 11](bugs.md#ask-11-ctxhostkv-has-no-compare-and-set-or-conditional-put)).

Two deliveries A and B both read the key as absent. A reads its own put
back before B's put lands. B then reads back its own put. Both win, and
both post. This shape produced:

- two Triaged lines and planner crumbs for one verdict (a Jira retry, or
  a `plan KEY` bounce while the first entry was still announcing);
- two Needs info lines when two planner sessions of one entry commented
  seconds apart;
- two planner wakes from one Slack reply, because both deliveries took
  `thread-detail/<ts>`, each wrote a `Detail from Slack:` comment, and each
  bounced To Do → Triaged.

`recordTriagedEntry` had the same shape: a late put from an older entry
could overwrite the newer id.

Fixed in #133 (`364a2941`), in the desk, with the shared `claim-lease.ts`
kept in parity with `pr-autofixer`:

- When the kv implements `HostKvCasApi`, the claim uses `putIfAbsent` /
  `putIfVersion`. `ctx.host.kv` does not expose CAS yet, so this path
  switches on only when ask 11 ships.
- Otherwise the desk passes `settleMs` (`FACTORY_DESK_CLAIM_SETTLE_MS`,
  default 2 s, 0 to 10000). After the verified write it waits, reads again,
  and keeps the claim only if it is still its own. Every taker but the
  last writer yields.
- The Triaged claim, every outcome claim, and the thread-detail claim
  settle. `pr-autofixer` does not pass `settleMs`, so its behaviour is
  unchanged.
- Race fixtures (`kv-race.fixtures.ts`) force the interleaving and show
  the duplicate with the settle off.

Status: mitigated, not closed. A rival put that takes longer than the
settle window can still duplicate a line. The real fix is platform CAS on
agent kv (ask 11).

### 20. The security line repeated on every harmless push

Found 2026-09-26 on TLSSN-31: marsbank #28 at head `f681b53` posted
`🔒✅ security review completed — CLEAN` twice with nothing changed. The
desk leased the security line per PR, head sha, and gate. The reviewer
posts a fresh GitHub review on every head, so every push (autofix pushes
included) and every replay announced the same CLEAN again. That buried
the `🔧 pr-autofixer pushed …` line that explained the push.

Fixed in #129 (`25cefb32`), desk only; the reviewer needed no redeploy:

- `securityFingerprint` in `agent/lib/review-update.ts` hashes the
  normalized verdict, each finding's severity, file, and title (not its
  line), and the files a truncated review did not read. The head sha is
  left out.
- The claim is `review/<repo>#<n>/security/<fingerprint>/after/<last head>`,
  and `review-security/<repo>#<n>` records the last verdict the thread
  heard. The same fingerprint on a new head posts nothing. A changed one
  posts and links the new head's review, including a change back
  (CLEAN → FINDINGS → CLEAN posts three times).
- A new finding, a finding in another file, a severity change, or a
  different unreviewed scope always changes the fingerprint.

Status: fixed and redeployed for Slack. Still open by design:
security-reviewer posts one GitHub review per head. Suppressing that needs
`scripts/e2e-lib.mjs` `review` to accept an earlier head's CLEAN.

### 21. A stalled hop left the thread on a loader with no explanation

Found across TLSSN-27 to TLSSN-31. A pod replaced mid-turn, a Jira rule
that was off, an unreadable status, or a worker comment or move that never
landed each left the filer looking at a loader crumb. The planner could
end quietly, and the old `plan-wait` schedule was a TypeScript schedule
`run` handler, which hosted v2 does not fire. There was no recovery
command short of `plan KEY` or a board drag.

Fixed in #132 (`9b2fc10c`), desk only:

- Each hop entry writes `hop-watch/<KEY>` and arms a one-shot reminder
  with the named handler `agent/reminders/hop_watch.ts`, which hosted v2
  does fire. The hops are triage (15 min from filing), plan (15 min from
  Triaged), and launch (10 min from Approved; 7 min since TLSSN-51,
  after the worker's own relaunch).
- The fire re-reads Jira. It stays quiet if the ticket moved on, and it
  announces an outcome comment the comment rule never delivered.
  Otherwise it posts one claimed line naming the hop and ending in
  `@factory retry KEY`.
- `retry KEY` is host code. It is accepted only as exactly that text, from
  the filer, in the ticket's thread. A hop still inside its deadline is
  not restarted. To Do and Triaged get the `plan KEY` move after the
  triage gate. Approved bounces Approved → Planned → Approved so the
  worker gets a fresh delivery. The worker's `implement/<KEY>` claim
  means that never launches a second agent.
- The `hop-watch` schedule replaces `plan-wait` as a backstop sweep where
  schedules fire (self-hosted serve).

Status: fixed and redeployed. Not yet proven live: a real hosted v2
reminder firing on a stalled ticket. Still unwatched: In Progress →
In Review, and a Jira-filed ticket whose triage never runs
([`event-driven-factory.md`](event-driven-factory.md), "Hop watchdogs").

### 22. A ticket filed in Jira had no Slack thread until Planned

A ticket filed from Slack gets its permalink on the ticket, a bound
thread, and status reactions on the filer's message. A ticket filed
straight in Jira got none of that. The desk opened a generic intake root
only at Planned, so the Triaged line, the planner crumb, the plan wait,
and any triage stop reached nobody. Intake roots took no reactions, and
nothing put a Slack link on the ticket, so the brief and the implement PR
had no `Slack:` line.

Fixed in #131 (`51164b9b`), desk only:

- The root opens at Triaged, the first status the desk hears, or on an
  earlier triage stop. Every early outcome (Triage stopped, Needs info,
  Plan stopped, Launch failed, Approved without a plan) may open it
  (`opensRoot`). The worker's move-skipped note still replies only in an
  existing thread.
- The root walks the same reactions as a filer's message.
- Once a post lands under the root, the desk comments
  `Slack thread: <root permalink>` on the ticket once (`backlink/<KEY>`,
  checked against existing comments). A failed write retries in place
  within the Triaged announce, because the planner reads that line before
  Planned. The planner's brief and the worker's PR `Slack:` line already
  read it.
- A ticket whose description carries `file_ticket`'s `Slack thread:` line
  was filed from Slack and lost its binding. It gets no second root.
- Roots go only to `FACTORY_DESK_INTAKE_CHANNEL`, and only for
  `FACTORY_JIRA_PROJECTS`. Approval stays Jira-only.

Status: fixed and redeployed. Trade-off: a Jira-filed ticket that triage
gates (a question or a duplicate) now gets a root too. Before, it was
silent.

### 23. `setTitle not-ok error=no_permission` on every channel request

Each new `@Factory` request in a channel logged
`[bdk/slack] warn setTitle not-ok error=no_permission channel=C… thread_ts=…`.
#176 put this down to `setTitle` working only in assistant DM threads.
The cause is an ordering race in July 0.2.11 through 0.2.13 against
Slack's agent-sessions bridge:

- `channels/slack/dispatch.js:387-404`: once the handler accepts a root
  message, July starts `paintTurnStart` (👀 plus
  `assistant.threads.setStatus`) and, in the same tick, calls
  `void maybeSetThreadTitle(...)` (`assistant.threads.setTitle`). The gate is
  `message.ts === message.threadTs && !isSlackImChannel(...)`, so only
  channel roots are titled. DMs, where the legacy title belongs, are never
  titled.
- Slack (changelog 2026-08-20, "Agent sessions") now serves both legacy
  methods through a bridge. A non-empty `setStatus` creates the thread's
  session. `setTitle` "applies the provided title to the thread's agent
  session", and a channel thread has none until a status write or
  `chat.startStream` creates it. When `setTitle` arrives first it is
  refused. The replacement method, `agents.sessions.rename`, names the same
  case `session_not_found`.
- The cause is not a missing scope. The 0.2.11 manifest has
  `assistant:write`, `chat:write`, and `agent_view`, and a missing scope
  returns `missing_scope`. `@cursor/bdk@0.2.11`, the latest release at the
  time, has the same dispatch code, and so do 0.2.12 and 0.2.13, so
  upgrading does not help.

Factory side (desk only): `agent/lib/agent-session.ts` `withAgentSession`
wraps the desk's mention and DM handler. The handler runs before July's
paint. For an accepted root outside a DM, it calls
`agents.sessions.setStatus` (`active`, `firstLineTitle(markdown)`,
`initiator_user_id`), waits at most 1.5 s, and stays silent if the call
fails. July's `setTitle` then renames an existing session. It opens
the session `active`, because a late `processing` could land after July's
turn end and leave the thread loading for up to an hour. July's paint and
clear still drive the spinner. `agent-session.test.ts` drives July's real
`dispatchInboundMessage` against a model of the bridge. The bare handler
reproduces `setTitle not-ok`, and the wrapped handler logs nothing.

If the line still appears after a deploy, the live app is not declared as
an agent. Apply the 0.2.11 manifest (Agents feature `agent_view`,
`assistant:write`) and reinstall. No other manifest change is needed.

Upstream (July / BDK `channels/slack`), for the fix to leave the desk:

- **Repro.** `slackChannel({ envPrefix })` with the default `ack`, an app
  declared as an agent, and `@app hello` as a new top-level message in a
  public channel. July logs `setTitle not-ok error=no_permission` on most
  deliveries.
- **Expected.** The thread's session exists and has the first-line title,
  with no warning.
- **Actual.** `assistant.threads.setTitle` races the session-creating
  `assistant.threads.setStatus` from `paintTurnStart` and is refused.
- **Suggested fix.** Create the session with its title in one call:
  `agents.sessions.setStatus({ channel_id, thread_ts, status: "processing", title, initiator_user_id })`
  inside `paintTurnStart`. Or await the paint and then call
  `agents.sessions.rename`. Log `session_not_found` and `no_permission` on
  the title at debug, not warn, and add a
  `slackChannel({ threadTitles: false })` opt-out. Separately, a
  `slackChannel({ logger })` is replaced by the server logger at mount
  (`slack-channel.js:414`), so a channel cannot filter its own lines.

Status: fixed on the factory side, pending a deploy. July fix not yet filed.

### 24. The hosted planner had no checkout: every file read hit ENOENT

Hosted planning turns opened `src/...` paths that `search_sandbox` had
found on GitHub and got `ENOENT`. `git_history` answered `no_checkout`.
The cause is the runtime, not a missing setting:

- `planner/agent/agent.ts` ran every turn on July's `local` runtime with
  `local.workspaceDir` only when `FACTORY_PLANNER_CHECKOUT` named an
  existing directory (`agent/lib/checkout.ts` `plannerCheckout`). Nothing
  clones the sandbox onto the hosted VM, so that is unset there, and July
  gives a local session a fresh per-session directory under its state
  root (only `memory/` in it). `read` / `grep` / `ls` run against that
  empty directory.
- July clones a repository only for a `cloud` turn: `cloud.repos` on
  `defineAgent` or per send (`SendMessageOptions.cloud`), passed to
  `@cursor/sdk` `Agent.create`. A per-send `cloud` makes that session
  cloud even on a local agent (`internal/session-engine.js`
  `buildTurnRequest`, `resolveSessionRuntime`). The worker already does
  this: `factory-worker/agent/lib/launch.ts` passes
  `cloud: { repos: [{ url, startingRef }] }`.
- Two July rules shaped the fix. A cloud turn on an agent that declares
  `tools` is refused (`session-engine.js` "declares a built-in tool
  allowlist", and discovery for `runtime: "cloud"`). Server tools reach a
  cloud turn only when the agent declares `cloud`
  (`internal/server.js`, `cloudCapable`, over `--cloud-tools-url`).
- Hosted v2 restores a frozen process and binds `FACTORY_*` per request
  (issue 8), so `agent.ts` cannot read `FACTORY_SANDBOX_REPO` at boot.

July has no per-send tool allowlist: `tools` is read off the agent, and
the same refusal covers a per-send cloud session of a local agent
(`session-engine.js:2090-2092`), while subagents are pinned local with no
`tools` (`discovery/subagent.js:17-18,54-58`). So one agent cannot keep
local turns under the allowlist and also run cloud planning turns; the
choice is per process.

Fix (`agent/lib/checkout.ts` `cloudPlanning`): the runtime follows one
signal, `AGENT_SERVE_GENERATION`, the variable July itself reads at boot
on every Cursor-managed hosting pod (`internal/v2-hosting.js:17-35`). On
managed hosting the agent is `runtime: "cloud"` with no `tools`, and
every planning send (`channels/plan.ts`, `lib/start-plan.ts`,
`tools/plan_issue.ts`) spreads `planSessionCloud(process.env)`, which
attaches `cloud.repos` for the sandbox at send time. An unset or
staging-refused `FACTORY_SANDBOX_REPO` throws the named config error and
the send fails; it never plans on an empty VM. `FACTORY_PLANNER_CHECKOUT`
is local only: it is not in `hosting.secretNames`, and if it is set on a
hosting pod anyway, `planSessionCloud` throws `FactoryConfigError`
("Checkout") on every planning send, so boot-time and send-time cannot
disagree. Everywhere else the agent is `runtime: "local"` with
`tools: ["read", "grep", "glob", "ls"]` on every turn, exactly as before,
and `planSessionCloud` attaches nothing. `agent.ts` declares
`cloud: { autoCreatePR: false }` and adds `api.cursor.com` egress.
`git_history` reads the sandbox's commits from GitHub when there is no
checkout, so it no longer answers `no_checkout` on hosted.

Residual:

- Read-only on a hosted turn is instruction-only (`instructions.md`
  "Never") plus `autoCreatePR: false`: July refuses `tools` on cloud
  turns (above, and `discovery/agent.js:166-172`), and `@cursor/sdk`
  1.0.35 throws for `tools`, `disallowedTools`, or `systemPrompt` with
  `cloud` (`dist/esm/options.d.ts:404-410,433-436,455-458`). The planner
  README "Checkout" has the detail. The worker's turns are cloud too, but
  the worker is meant to write (it pushes a branch), so this is not a
  posture it shares.
- `autoCreatePR: false` is a default a per-session override can beat:
  July's built-in HTTP session API reads a caller-supplied `body.cloud`
  (`http-channel.js:57`, `readCloudOptions` at `:468-521`) and the merge
  lets the caller's `autoCreatePR`, `repos`, `env`, and `envVars` win
  (`cloud-merge.js:10-24`). On 0.2.18 that body never reaches a hosted
  turn: a hosted v2 guest mounts no `/v1/session*` (`server.js:1673-1676`)
  and the control-plane admission fails closed on any payload field
  beyond message/dryRun/asOf/modelConfig/instructions, so a `cloud` key
  is a 400 before authored code runs (`http-control-plane-session.js:37-39`).
  Off hosting the agent declares `tools`, which July refuses to combine
  with a per-send cloud attach (`session-engine.js:2091-2093`). The one
  open shape — a serve with `AGENT_SERVE_GENERATION` set outside managed
  hosting, where the session routes stay mounted and the agent has no
  `tools` — is closed by the planner's own gate: the authored
  `agent/channels/http.ts` override refuses every principal-bearing HTTP
  session send under the hosted posture with a 400 (control-plane
  admissions arrive with `auth: null` and pass), and
  `agent/channels/http.test.ts` pins the July behaviors this relies on.
  Residual: the "no auto PR" claim holds only while those gates hold —
  whoever holds a credential the session surface admits, and July's
  guest-side payload parser across upgrades, are the two things to watch
  (step 6 of "Verify" below).
- Every hosted turn (planning, playground, `ask`, MCP) runs on a cloud
  agent; non-planning ones get no repository. Each one can call all
  seven planner server tools on this host while it is active, including
  `record_plan`, `record_needs_info`, and `plan_issue`: a `cloud` agent
  mounts its server tools as the `agentsdk-tools` MCP server on the
  cloud turn (`session-engine.js:2459-2475`, `server.js` `cloudCapable`),
  pinned to the turn's own session (`?agentkitSessionId=<its id>`), and
  the endpoint answers while that session has an active turn
  (`session-engine.js:2584-2593`). The endpoint checks the session id,
  not the calling turn, so another active session's tools are reachable
  too, but only by a hand-built call that carries the `agentsdk-tools`
  Authorization header and URL (whether the VM can read them is the
  `unknown` below). The tool-server config July sends with the turn
  carries the host's Cursor key as `Authorization: Bearer`
  (`server.js:968-989`, `liveCursorApiKey()`; on hosting, the deployment
  service account's key). Whether a shell command on the VM can read that
  config, and so the key, is `unknown` from the installed dists: the
  header is sent in the create-agent request (`@cursor/sdk`
  `dist/esm/448.js`), and the VM-side runtime is not in either package.
  Blast radius if it can: the key is the deployment's general Cursor
  credential (`CURSOR_API_KEY`, else `CURSOR_SERVICE_ACCOUNT_KEY`;
  `cursor/credentials.js:239,247`), not a planner-only token. July
  authenticates hosted peers with the same key
  (`peer-connections.js:101-110` sends `Bearer ${CURSOR_API_KEY}` to
  `<peersUrl>/<slug>/v1/mcp`), so a readable key likely reaches the
  hosting peers gateway for this team's other factory deployments
  (`factory-desk`, `factory-worker`, ...) and the Cursor API, outside
  July's active-turn gate; which deployments it reaches is decided by the
  backend. The response plan is the key step in "Verify" below: probe
  once after the first deploy, record yes/no here, rotate the
  service-account key whatever the result, and on `yes` turn hosted
  planning off. Server tools get no `FACTORY_*` values from the VM; they
  read this host's env. No `FACTORY_*` or other bound secret is sent to
  the VM (no `envVars` / `env`); the only host credential that leaves is
  the Cursor key in the `agentsdk-tools` header.
- Declaring `cloud` serves the host-only `tracker` connection at the
  cloud turn's tool endpoint while the turn is active
  (`?connection=tracker`, `session-engine.js:2311-2335`,
  `mcp-endpoint.js:121-126,186-196`, registered at `server.js:955-990`),
  but does not mount it on the turn: `buildMcpServers` skips every host
  connection (`session-engine.js:2371,2380,2388,2428`), so the turn's MCP
  config holds only `agentsdk-tools`. A VM reaches the bridge, or another
  active session's tools, only if it can read the `agentsdk-tools`
  Authorization header and URL (unknown; the key bullet above). If it
  can, then: the bridge lists and calls through `host.mcp`, which honors
  the connection's `tools` (`mcp-host.js:70-77,123-125`), so
  `host-connections/tracker.ts` limits it to the names `lib/jira.ts`
  uses. Those names still reach past the planner's own gates:
  `executeRead` is Atlassian's generic read (any Jira or Confluence
  content the connected account can see), and bridged
  `addCommentToJiraIssue`, `addOrEditJiraIssueComment` (adds or edits a
  comment), and `transitionJiraIssue` calls skip `lib/jira.ts`'s
  `FACTORY_JIRA_PROJECTS` check and dedupe.
- Deploy boundary only: a session created local before this deploy
  resumes as a cloud session after it, and the SDK resumes a non-first
  cloud turn by the stored agent id (`internal/sdk-runner.js:647-655`),
  which for that session is a local id, so the turn fails. Planning
  continuations are keyed `issue:<KEY>#<attempt>` with the Jira changelog
  or comment id as the attempt, so every new event or replan is a new
  session; a duplicate delivery meets its `started` claim and is skipped
  (`lib/start-plan.ts:94`, `:209`). What can hit this: hosted admission
  replaying a pre-deploy delivery after the deploy (same delivery id,
  which re-sends, `:208`), and a pre-deploy playground or `ask` thread.
  Both fail on the turn with the SDK error, and the plan-outcome hook
  leaves `Plan stopped:` on the ticket; a new event or a new chat starts
  a cloud session. Sessions created after the deploy are cloud from
  their first turn.

Verify after redeploying `factory-planner`:

1. Plan a `TLSSN` ticket. The session's `turn.started` runs on a cloud
   agent (the session page links a `bc-…` agent), its `read` / `grep`
   calls on `src/...` return contents, no tool result says `ENOENT`,
   `git_history` returns commits, and `record_plan` lands with
   `evidence: "checkout"`.
2. The key step, once, after the first deploy from this change. Open a
   hosted `ask` or playground session on the deployed planner (a cloud
   turn with `agentsdk-tools` mounted and no Jira side effects) and tell
   the model to run the script below verbatim as one shell call and paste
   only its output, overriding the instructions' "only `git log`, `git
   show`, `git blame`" shell rule for this one command. The script prints
   only paths, PIDs, process names, variable names, counts, lengths, a
   12-character hash prefix, and one HTTP status code, never a value; the
   only file it writes is a mode-0600 header temp file it removes in the
   same call. Do not add any step that echoes a value (no `env`, `cat`,
   or `grep` without `-l` on a config file), since the transcript is
   stored in the planner's state root and in the Cursor cloud-agent
   transcript.

   ```bash
   set +x; umask 077
   pat='/internal/agent-serve/mcp/|agentkitSessionId|agentsdk-tools'
   tokpat='[Bb]earer [A-Za-z0-9._~+/=-]{20,}'
   found=no; keyfile=
   for f in $(grep -rlsIE "$pat" "$HOME" "$PWD" /tmp /etc /run /var /opt 2>/dev/null | head -50); do
     n=$(grep -cE "$tokpat" "$f" 2>/dev/null)
     if [ "${n:-0}" -gt 0 ]; then
       t=$(grep -oE "$tokpat" "$f" | head -1 | cut -d' ' -f2)
       printf 'FILE %s bearer=yes len=%s sha12=%s\n' "$f" "$(printf %s "$t" | wc -c)" "$(printf %s "$t" | sha256sum | cut -c1-12)"
       unset t; found=yes; keyfile="${keyfile:-$f}"
     else
       printf 'FILE %s bearer=no\n' "$f"
     fi
   done
   chain=" $$ "; a=$PPID
   while [ -n "$a" ] && [ "$a" != "0" ] && [ "$a" != "1" ]; do
     chain="$chain$a "
     a=$(awk '/^PPid:/{print $2}' "/proc/$a/status" 2>/dev/null)
   done
   for p in /proc/[0-9]*; do
     pid=${p#/proc/}
     case "$chain" in *" $pid "*) continue ;; esac
     for k in environ cmdline; do
       if tr '\0' '\n' 2>/dev/null < "$p/$k" | grep -qE "$tokpat"; then
         printf 'PROC pid=%s comm=%s in=%s\n' "$pid" "$(cat "$p/comm" 2>/dev/null)" "$k"; found=yes
       elif tr '\0' '\n' 2>/dev/null < "$p/$k" | grep -qE "$pat"; then
         printf 'PROC pid=%s comm=%s in=%s url_only\n' "$pid" "$(cat "$p/comm" 2>/dev/null)" "$k"
       fi
     done
   done
   env -0 | cut -z -d= -f1 | tr '\0' '\n' | grep -E 'MCP|CURSOR|AGENTSDK|AUTH|TOKEN|KEY' | sort | sed 's/^/ENVNAME /'
   env -0 | cut -z -d= -f1 | tr '\0' '\n' | grep -qxE 'CURSOR_API_KEY|CURSOR_SERVICE_ACCOUNT_KEY' && found=yes
   printf 'ptrace_scope=%s shell_uid=%s\n' "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo n/a)" "$(id -u)"
   ps -eo user=,comm= | sort -u | sed 's/^/PROCUSER /' | head -40
   if [ -n "$keyfile" ]; then
     u=$(grep -oE "https?://[^\" ]*agentkitSessionId=[^\" ]*" "$keyfile" | head -1)
     b=$(grep -oE "$tokpat" "$keyfile" | head -1)
     if [ -n "$u" ] && [ -n "$b" ]; then
       hf=$(mktemp); printf 'authorization: %s\n' "$b" > "$hf"; unset b
       printf 'TRACKER tools/list http_code=%s\n' "$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H @"$hf" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "${u}&connection=tracker")"
       rm -f "$hf"; unset u
     else
       printf 'TRACKER tools/list skipped\n'
     fi
   fi
   printf 'KEY_READABLE=%s\n' "$found"
   ```

   What the script measures. Only a real token sets `found`: a `tokpat`
   match in a file or in another process's environment or command line,
   or the raw deployment key sitting in the VM's environment (the
   `CURSOR_API_KEY` / `CURSOR_SERVICE_ACCOUNT_KEY` variable NAME in the
   `env -0` name-only listing — a raw key has no `Bearer` prefix, so
   `tokpat` alone would miss it). A `pat`-only match (the endpoint URL or
   the MCP names, no token) prints as `PROC … url_only` and does not set
   `found`. The `/proc` loop skips the probe's own process chain — this
   shell and its ancestors up to pid 1, walked over `PPid:` in
   `/proc/<pid>/status` — whose command lines necessarily carry the
   patterns; without that skip the probe reported its own `bash -c` as a
   finding. The env listing is name-only by construction: `env -0` with
   `cut -z` splits on NUL, so a multi-line value can never leak a
   fragment into the output the way `env | cut -d= -f1` could. The
   `TRACKER` line is the bridge check, fixed here rather than improvised
   in step 5: when a file holds a bearer, the URL and header go from that
   file into shell variables and a mode-0600 temp file (umask 077)
   removed in the same call — never into the chat or curl's argv, which
   `/proc/<pid>/cmdline` would expose — and one JSON-RPC `tools/list`
   POST to the mounted URL with `&connection=tracker` prints only
   `%{http_code}`.

   Reading the output. `KEY_READABLE=yes` with a `sha12` means a file on
   the VM holds a bearer; to confirm it is this deployment's key, in a
   private terminal (not a session) read the service-account key without
   echoing it (`read -rs K`), run
   `printf %s "$K" | sha256sum | cut -c1-12; unset K`, and compare the
   12 characters (a 12-hex prefix of a high-entropy key's hash does not
   reveal the key). A `PROC` line without `url_only` means another
   process's environment or command line carries the token; an
   `ENVNAME CURSOR_API_KEY` or `ENVNAME CURSOR_SERVICE_ACCOUNT_KEY` line
   means the raw key is in the VM's environment. A
   `TRACKER tools/list http_code=200` makes the Jira bridge exposure in
   the residual above real rather than conditional. If no `PROCUSER` line
   matches `shell_uid` and `ptrace_scope` is 1 or higher, in-memory reads
   are unlikely. A `no` is not proof (other paths, other users' memory, a
   model that deviated from the script), so the next step runs whatever
   the result.
3. Record the result here, in this issue, as one line:
   `KEY_READABLE=<yes|no>, <date>, <session id>`. Not recorded yet.
4. Rotate the deployment's service-account key, the credential itself
   (the Cursor dashboard's service account for the `factory-planner`
   deployment), not the `rotate-token` alias token; then redeploy so the
   pod picks it up. Do this whatever step 2 printed.
5. On `KEY_READABLE=yes`, hosted planning is turned off: do not redeploy
   the planner from this change (revert it on the hosted slug), record
   the decision here, and the factory owner chooses between a
   per-session scoped endpoint token from July (a platform ask) and local
   planner turns with seeded files (the pre-issue-24 posture, with
   `search_sandbox` reading the GitHub tree). The Jira bridge check (one
   `tools/list` POST over the found header) is the fixed `TRACKER` line
   in step 2's script: it has to run inside step 2's active turn anyway,
   before step 4's rotation kills the key, and fixing it verbatim there
   keeps the header out of curl's argv and out of the chat.
6. The per-session HTTP `cloud` override (the residual above): keep the
   deployment's HTTP and alias credentials to the operators who deploy
   (they already hold the service-account key), and on every `@cursor/july`
   upgrade re-run `planner/agent/channels/http.test.ts` — its July pins
   fail if an upgrade starts forwarding `cloud` through the hosted
   admission or changes the merge — before trusting "no auto PR" again.
   The platform ask stands: an agent-level switch that refuses per-session
   `cloud` overrides outright.

### 25. Every planner Jira call answered `not_connected` after #227

Symptom. From the `factory-planner` deploy at 2026-10-04 15:43 AEDT
(merge 8362ae5, the first deploy carrying #227): `Planning started:`
reported `not_connected`, `read_ticket` answered `not_connected` in 7 ms,
the webhook read no `Triage:` verdict (`no verdict` in its planned line),
and neither the `Plan:` comment nor the move to Planned landed. The cloud
turn itself was fine; the webhook handler, which runs no model turn,
failed the same way, so the fault was host-side and runtime-independent.
The planner's grant was fine (`CheckHttpMcpStatus` for its service
account: `requiresAuth=false`). The desk, worker, and triage-jira kept
working: their tracker connections declare no `tools`.

Cause. #227 (9dfa304) added `tools: TRACKER_TOOLS` to
`planner/agent/host-connections/tracker.ts` with bare Atlassian names
(`getJiraIssue`, `executeRead`, `addOrEditJiraIssueComment`,
`transitionJiraIssue`, ...). July matches that list by exact name:
`dist/types.js:109-114` `connectionAllowsTool` is
`filter.tools.includes(toolName)`; `dist/internal/mcp-host.js`
`McpHost.listTools` (70-77) filters every listed tool through it and
`callTool` (123-125) asserts it. The Cursor-account bridge does not
list bare names: the Cursor backend's `ListSandMcpTools` returns
`<serverIdentifier>-<tool>` (`dist/internal/cursor/backend-client.js:204-226`),
and July only sanitizes it (`[^a-zA-Z0-9_-]` to `_`, 128 characters) and
suffixes collisions (`dist/internal/cursor/account-mcp.js` `buildCatalog`,
`dist/internal/sanitize-mcp-tool-name.js`). The prefix is the backend's,
so the fix is pinned to the live names below, not to July code. Tempo's `tools/call` spans
(`mcp.tool.name`, connection `tracker`) over the two days before show the
hosted names: `Factory_Atlassian-getJiraIssue`,
`Factory_Atlassian-executeRead`,
`Factory_Atlassian-addOrEditJiraIssueComment`,
`Factory_Atlassian-transitionJiraIssue`, and
`Factory_Atlassian-createJiraIssue` (the desk). The planner's last
successful call was `Factory_Atlassian-transitionJiraIssue` at 04:38
AEDT; none after 15:43. So every hosted tool was filtered out,
`listTools` answered `[]`, and `lib/jira.ts` `connectedTools` reads an
empty list as `not_connected`. (The older `tool-prefix.test.ts` fixtures
used `team-Factory_Atlassian-`; the live prefix has no `team-`.
`lib/jira.ts`'s name regexes accept any `-` prefix, so they never cared.)

Fix. `tracker.ts` keeps the allowlist (it still bounds what a cloud VM
can reach through the `?connection=tracker` bridge; issue 24) but allows
each base name twice: bare, for a connector that lists plain names, and
hosted, `sanitize("<server>-<base>")` for each `TRACKER_SERVERS` entry,
with July's sanitize rule copied locally (`dist/internal` is not a
package export). `TRACKER_TOOL_BASES` is the readable list; `TRACKER_TOOLS`
is what the connection declares. Still no `createJiraIssue`,
`editJiraIssue`, `executeWrite`, or `executeDestructive` under any
prefix. `tracker-connection.test.ts` runs the live hosted names through
July's own `connectionAllowsTool`; `jira.hosted-bridge.test.ts` drives
`readTicket`, `commentOnTicket`, and `transitionIssue` through a registry
that lists the live v2 names filtered by the real tracker connection, and
fails with `not_connected` on the #227 list. `ask` and playground turns
need nothing more: they are cloud turns too, and their Jira access is
only through the host-side server tools and hooks on `ctx.host.mcp`
(host connections are never mounted on a turn,
`session-engine.js:2371-2428`), the same `lib/jira.ts` path. Redeploy
`factory-planner` only.

### 26. TLSSN-60: a plan nobody could read stopped every retry

Symptom. 2026-10-04, while issue 25 was live. The 21:06 AEDT planning
run reached `record_plan`, which tagged the `plan` artifact (key
`plan:TLSSN-60`) with `data.tracker = "not_connected"`: no `Plan:`
comment, no move to Planned, nothing announced; nobody read that plan.
After #231, `retry TLSSN-60` (22:15 AEDT) opened a fresh pinned run. Its
`get_plan` answered `found: true` for the stale record, so step 2 of the
instructions ("a recorded plan that nobody asked to replace is the
answer") stopped it, and the hook wrote `Plan stopped:`. The desk's
`plan TLSSN-60` bounce would meet the same record. `replan` is signalled
only by a `Plan:` comment on the ticket or a move out of Planned
(`agent/lib/jira-event.ts` `hasPlan`, `decideStatusEvent`), and there
was neither, so the ticket was stuck.

Cause. `get_plan` read any artifact under the ticket's key as the
recorded plan, while `record_plan` moves a ticket to Planned only when
`tracker` is `commented` or `already_commented` (`moveToPlanned`). The
two readers disagreed about what a recorded plan is.

Fix. `get_plan` applies `record_plan`'s test: a record whose comment did
not land answers `found: false` with
`unpublished: { artifactId, recordedAt, tracker }`. The instructions
say to plan on a `Plan <KEY>` message when that comes back and to
answer `Get plan` / `approve` with "no plan is recorded" (it was never
posted). `record_plan` still tags the artifact on a failed comment, so the
next plan replaces the row. No other reader of the plan artifact exists:
the desk's `kind: "plan"` in `reaction-approval.ts` is its own approval
target type, and the worker reads the brief from the `Plan:` comment.
`agent/tools/get_plan.test.ts` covers every stored tracker status (landed and not), a record with no tracker field, and no record.
Redeploy `factory-planner`; then `retry TLSSN-60` plans.

### 27. TLSSN-60: `turn_sent`, then silence until the heal (the cloud turn's `modelConfig`)

Symptom. 2026-10-04 23:27 AEDT, the first worker launch since #229 moved
the implement agent onto a July cloud turn. The verified Approved
delivery did everything it logs: claim, `sentAt`, `turn_sent`, span
`factory.cloud_agent.launch` outcome `sent`. Then nothing: no
`agent.bound`, no `Implementing:` comment, no move to In Progress, no
`turn.failed`, and no `cursor.token.usage` series for `factory-worker`
on the ticket. The pending claim sat until the launch heal
(`lib/launch-heal.ts`) retook it past `LAUNCH_SENT_GRACE_MS` and
relaunched through `@cursor/sdk` `Agent.create` 13 minutes later
(`<CURSOR_AGENT_ID>`), which is the path #229 had
retired for deliveries. Every cloud-turn launch since #229 would have
gone the same way: a 13-minute delay per ticket and no July token
attribution for the implement agent.

Cause. The hosted execution record says it: execution
`de5596ce39005c54` for session `<CURSOR_SESSION_ID>` at
2026-10-04T12:27:19Z, `turnStatus: error`, `abortReason: execute_throw`,
771 ms, `InvalidModelConfigError: invalid argument: modelConfig requires
dryRun`, stack `dist/internal/model-config.js:53` ←
`dist/internal/session-engine.js:786` ←
`dist/internal/hosted-delivery.js:772`. `implementSendOptions`
(`agent/lib/implement-turn.ts`) put `modelConfig: { model: workerModel }`
on the send so the cloud turn would run the implement model. July
0.2.18 admits `modelConfig` on dry-run sends only: `SessionEngine.send`
(`session-engine.js:786`) builds the session record with
`modelConfigForDryRun(sendOptions.modelConfig, sendOptions.dryRun)`
(`model-config.js:50-53`), which throws unless `dryRun === true`. (Even
on a dry run it admits only `effort` and `fast` params; the implement
variant's `context` would have been refused next.) Hosted admission
answers before it runs the pending send (`hosted-delivery.js`
`runAdmission`, `pendingSend`), so the handler had already logged
`turn_sent`; the throw came in the execution phase, where no session
record exists yet, so neither `turn.failed` nor `agent.bound` fired and
the pipeline's `turnFailed` never released the claim. The
`SendMessageOptions` type allows `modelConfig`, so the shape test
against July's types passed; only the runtime refuses it.

Fix. The send carries no `modelConfig`. A live July turn runs the
agent's own `model` (`session-engine.js` `turnModel`; `sdk-runner.js`
`toModelSelection` passes `{ id, params }` through unchanged), so
`agent/agent.ts` sets `model: IMPLEMENT_MODEL` (`lib/config.ts`,
`workerModel(process.env)` read once at load), and the heal's
`Agent.create` (`lib/handle.ts` `approve`) sends the same constant,
instead of the shared host model. Hosted v2 binds secrets per request,
after `agent.ts` loads, so `FACTORY_WORKER_*` are no longer hosted
secrets: a per-request read in the heal would have split it from the
live turn. Its fallbacks stay `factoryFallbacks(model)`: the shared catalog
list minus the primary's id (grok-4.6 fast, then Auto balanced), which
engage only when the implement model is refused or out of capacity
before any output. The worker reads no `FACTORY_AGENT_*` any more and
declares none. `implement-turn.test.ts` runs `implementSendOptions`
through July's `modelConfigForDryRun` (the exact gate at
`session-engine.js:786`, re-pinned by text) and fails on main's options
with the live message; it also pins `agent.model` to `workerModel` and
`toModelSelection(agent.model)` to the heal's selection.
`scripts/factory-model-catalog.test.mjs` and
`scripts/factory-config-parity.test.mjs` now expect the worker's root
model to be the implement model. The heal path is unchanged. Redeploy
`factory-worker`.

### 28. TLSSN-60 replan: the hosted delivery never started a turn (reused session)

Symptom. 2026-10-04 22:21 AEDT (11:21Z), a TLSSN-60 replan moved the
ticket back to Triaged. The desk armed its plan hop watch as usual, and
then nothing: no `Planning started: TLSSN-60` comment, no `turn_started`
log line from the planner, no plan, no `Plan stopped:`. The planner's log
for the delivery shows one line, `[bdk] lazily restored session
ses_420d… from storage`, and no more until the planner was redeployed at
12:15Z, 54 minutes later. The desk's only bound was the 15-minute plan hop
line (`never reported starting`), which tells a person and re-drives
nothing. A healthy run starts its turn about a second after the guest's
network is up and writes `Planning started:` within seconds of the move.

Cause. A Cursor control-plane / July 0.2.18 bug, not the factory's. The
hosted delivery (`httpreq:f79745b7-cb03-44fb-916e-8bc16e12eb5c`, 11:21:09Z)
was handed the previous delivery's session id (`<CURSOR_SESSION_ID>`,
from delivery `httpreq:8e128907-2aca-4828-ad10-9e90c202d00c` at 11:15:01Z,
which had run fine) with a different continuation. The guest restored that
session and `dist/internal/session-engine.js:685-695` threw `v2: hosted
session id ses_… already belongs to another mailbox` before `startTurn`,
so the planner's `turn.started` hook (`planner/agent/hooks/plan-outcome.ts`,
which writes the marker) never ran. `dist/internal/hosted-delivery.js:858-904`
logs nothing on that `execute_throw`, never ends the `execute.send` span,
and marks the failure `retry: terminal`, so the control plane did not
redeliver either. After the redeploy, delivery
`httpreq:007aa57a-c00a-4cc7-a962-2d0a226b0859` ran on a fresh
`<CURSOR_SESSION_ID>` and planned normally. A desk `retry` inside
the same planner release likely hits the same reuse; the redeploy is what
recovered it.

Factory-side mitigation (`factory-desk`, this change). The plan hop watch
gained a start check 4 minutes after each Triaged entry
(`PLAN_START_DEADLINE_MS`, `agent/reminders/plan_start.ts`, backed by the
hop-watch sweeps). The start signal is the planner's own `Planning
started:` comment (`agent/lib/planner-liveness.ts` `planningRun` against
the entry time), plus anything else that proves the planner ran for the
entry (a plan, a `Needs info:` or `Plan stopped:` above the baseline, the
ticket having left Triaged); the desk and planner share no kv, so the
ticket is the only reliable cross-agent signal, and the planner is
unchanged. A Triaged ticket with no triage gate and none of those at 4
minutes is re-sent to the planner once, as `retry KEY` would
(`agent/lib/planner-redeliver.ts`), with one line in the thread; the
re-send is recorded at `plan-start-retry/<KEY>` before the move and stands
until a start is seen, the ticket leaves the plan path, or 2 hours pass;
the entry's own record is marked `retried` before the move too, and a
record still at `retried` later (the re-send's request died between its
mark and its bounce, the ticket left in To Do) is treated as a stall:
the 15-minute line still posts for it and `retry KEY` is not refused as
inside the deadline.
When the retried entry does not start either, the thread hears the final
line, `KEY's planning still hasn't started after one automatic retry, so
planning couldn't start. The next step is a planner redeploy or asking
ops; say `retry KEY` here to try again.`, and nothing moves again. Runbook
for that line: `agent-sdk deploy --dir planner --ref <current ref>`, then
`retry KEY`. Logs: `{"desk":"plan_start_watch",…,"result":"armed"}` then
`"started"` on a healthy run; `"retried"` then `"final"` is this bug.
([`factory-deployment.md`](factory-deployment.md), "Hosted timers";
[`event-driven-factory.md`](event-driven-factory.md#hop-watchdogs-a-stalled-hop-is-announced).)

Upstream. Reported to the July / backend owners as **"Hosted v2: a
custom-HTTP `event` delivery executes under the previous delivery's
`ses_`; the guest throws "already belongs to another mailbox" with no log,
and the run goes dark."** (factory-planner team <CURSOR_TEAM_ID>, July 0.2.18,
release 7f97e4ea; no public tracker link yet). The guest side asks for
`session-engine.js` not to throw on a reused `hostedSessionId` with a
different continuation (or to start a fresh session), and for
`hosted-delivery.js` to log the `execute_throw`, end the `execute.send`
span, and not mark it terminal; the control-plane side asks why delivery
2's `sessionPublicId` was reused.

## Where each older issue stands (2026-09-26)

Issues 1 to 17 are worked past on the factory side. The ones that only a
platform change closes are still open there:

| Issue | Factory side | Still open on the platform |
| --- | --- | --- |
| 1, 2 | v2 wizard curl, never `slack create` | `slack create` in 0.2.x still drafts v1 on this team |
| 3 | one slug per `deploy` | multi-component deploy gated ([`bugs.md`](bugs.md) ask 8) |
| 7 | `bdk logs --prod` reads v2 slugs (0.2.11); the ticket, thread, PR, and Jira notes are the product evidence | `sessions --prod` refuses v2 (ask 3) |
| 11 | consent per slug service account | team MCP consent is per service account (ask 1) |
| 12 | fixer drives on `check_suite` / `workflow_run`; `factory: drive` typed by a person | `check_run` and bot-authored comments never reach v2 (ask 4) |
| 13 | Slack mentions and thread replies reach the desk (the TLSSN-22 to TLSSN-31 runs); ✅ / ❌ reactions approve or decline on 0.2.11 once the Factory app has the 0.2.11 manifest (`reaction_added`, `reactions:read`) | none for mentions or reactions; interactivity still has no v2 path (ask 7) |
| 19 | settle window (#133) | kv compare-and-set (ask 11) |

Issue 13's dispatch gate is no longer a blocker: every smoke since
TLSSN-22 ran from Slack mentions and thread replies. Issues 4, 5, 6, 8,
9, 10, 14, 15, 16, and 17 need nothing further.

## Chain edges on hosted v2

Jira status is the bus. Comments carry the artifact; the transition is
the event. Every edge below is live on hosted v2 once the five TLSSN
Automation rules exist (one delivery source per slug) and the Atlassian
connector is attached.

| Edge | Event | Consumer route |
| --- | --- | --- |
| Jira → triage | `jira:issue_created` | `factory-triage-jira` `/v1/channels/webhook/` |
| triage → planner | `Triage:` comment, then `To Do → Triaged` | `factory-planner` `/v1/channels/webhook/` on `issue_updated` |
| planner → desk | `Plan:` comment, then `Triaged → Planned` | `factory-desk` `/v1/channels/jira/` on `issue_updated` (announce) |
| desk → worker | `approve KEY` in Slack, or the board: `Planned → Approved` | `factory-worker` `/v1/channels/jira/` on `issue_updated` |
| worker → desk | `Implementing:` comment, then `Approved → In Progress` | `factory-desk` `/v1/channels/jira/` on `issue_updated` (progress) |
| person → fixer | `factory: drive` PR comment typed by a person (issue 12). The desk only tells them to; it never writes to GitHub | `factory-pr-autofixer` GitHub `onComment` |
| GitHub → fixer, reviewer | PR, `check_suite`, `workflow_run`, human comment events (no `check_run`, issue 12) | `githubChannel({ cursorAccount })` |

The in-process peer edges (`ask`, `ask_2`, `call_tool plan_issue`,
`call_tool announce_plan`) exist only behind `FACTORY_INPROCESS_PEERS=1`
on a local `serve --dir .`. They are not the product path.

## Commands that worked

Historical. These are the commands from the first hosted deploy. Deploy
today with [`factory-deployment.md`](factory-deployment.md), which keeps
`CURSOR_API_KEY` set to the Cursor team API key.

Deploy (user login, this branch, after it is pushed):

```bash
env -u CURSOR_API_KEY -u CURSOR_SERVICE_ACCOUNT_KEY \
  agent-sdk whoami --json

env -u CURSOR_API_KEY -u CURSOR_SERVICE_ACCOUNT_KEY \
  agent-sdk deploy --dir pr-autofixer --slug factory-pr-autofixer --ref cursor/factory-hosted-v2-a26f
```

Order: `triage-jira`, `planner`, `factory-worker`, `factory-desk`,
`pr-autofixer`, `security-reviewer`, each with its slug from the table
above, so every Jira webhook has a live target when it is registered.

Secrets (after `running`; names only on the command line; values on
stdin, one per name, never printed):

```bash
agent-sdk secrets set factory-pr-autofixer FACTORY_REPOS FACTORY_JIRA_PROJECTS
```

Verify:

```bash
agent-sdk deployments
agent-sdk logs --prod --slug factory-pr-autofixer   # expected on 0.2.11+: recent session logs
```

## What is not a factory bug

- `slack create` 409 after a successful v2 Slack install: the CLI still
  drafts v1.
- `sessions --prod` refusing a `running` v2 slug (`logs --prod` works
  from 0.2.11).
- `deploy --dir . --all` on this team.
- A first-boot 502 that names `FACTORY_SANDBOX_REPO` or `FACTORY_REPOS`
  on a commit **before** this branch's boot-order fix.
- `[unauthenticated]` on a service-account deploy principal.
- `missing_agent_session_stopped_event_subscription` on the
  `factory-worker` deploy. July 0.2.13 still has no agent-session channel to
  subscribe to, and the worker's `implement_pr` watch already handles a
  stopped implement agent ([`factory-deployment.md`](factory-deployment.md),
  Redeploy gotchas).

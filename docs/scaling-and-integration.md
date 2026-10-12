# Scaling the factory, and what integration cost us

Written 2026-09-23 against `@cursor/july` 0.2.2 on hosted v2, team
`<CURSOR_TEAM_ID>`, six slugs, one sandbox repository (`cursor-demo-lab/marsbank`).
Sources are [`deployment-issues.md`](deployment-issues.md) (cited as
`issue N`), [`event-driven-factory.md`](event-driven-factory.md),
[`next-steps.md`](next-steps.md), [`jira-webhooks.md`](jira-webhooks.md),
the folder [`README.md`](../README.md), and the project store notes.
Each recommendation in section 2 is marked **proven** (it ran here,
evidence given) or **inferred** (from source or measurement, not run).

## The answer

Run one shared factory per Cursor team and onboard each repository as
configuration, not as a deployment. The four Jira slugs (desk, triage,
planner, worker) wake on ticket status and read repositories from an
allowlist, so one set serves every repository whose tickets land in the
team's Jira projects. The two GitHub slugs (fixer, reviewer) bind
repositories at deploy time with `--cursor-events-repo`, and the July
GitHub channel caps one deployment at 20 repositories under one owner, so
they are stamped out per organisation, or per block of 20 repositories,
from the same source with a new slug. A thousand repositories then cost
four Jira slugs, four Atlassian consents, four Jira webhooks, and one
Slack app per team, plus two GitHub slugs per block, not six slugs per
repository. The code shape already scales. Status transitions are the
bus, every hop is claimed in `host.kv` on a natural key (read then put;
`host.kv` has no compare-and-set, so not atomic across sessions), and the
e2e driver asserts each hop. What does not scale yet is identity. Every
slug is its own service account with its own connector consent, a GitHub
App installation must be owned by exactly one Cursor team, the worker
launches into one configured repository, and hosted v2 has no delivery
log. Each of those is a platform ask, or one inferred code change, listed
at the end.

## 1. Integration challenges we hit

Grouped by root cause. Each table gives the symptom, the root cause, what
fixed it, whether it is still open, and the deployment issue.

### 1.1 Identity and credential model

A hosted slug never acts as the person who deployed it. Each deployment
runs as its own service account, `agent-serve-agentsdk:v2:<slug>`, and the
account MCP bridge binds to that key at task time (`@cursor/july` 0.2.2
`dist/internal/server.js:508-517`). A service account sees team MCP
servers only. That explains issues 6, 9, 11, and half of 12.

| Symptom | Root cause | What fixed it | Open | Issue |
| --- | --- | --- | --- | --- |
| Freeze clone failed with `GithubNoUserCredentialsError` under `CURSOR_API_KEY` | The service account has no GitHub identity | Deploy as the user login with `env -u CURSOR_API_KEY -u CURSOR_SERVICE_ACCOUNT_KEY` | no | issue 6 |
| A probe as the deploying login listed only Canva | Personal connectors never reach a deployment. The probe tested the wrong principal | Probe as the slug's service account | no | issue 9 |
| Every hosted Jira write returned `not_connected` after Simon connected Atlassian | The bridge keeps `isTeamServer` entries only. The plugin-managed Atlassian MCP (plugin <CURSOR_PLUGIN_ID>) surfaces per user as `user-Atlassian`, so no slug sees it | A non-plugin team MCP server, `Factory Atlassian` (id `<MCP_SERVER_ID>`, `https://mcp.atlassian.com/v2/mcp`), selected with `servers: ["Factory Atlassian"]` | no | issue 11 |
| No CLI consent, and the dashboard card showed nothing to authenticate on the desk, planner, and worker | Grants are per service account, per server, with no shared mode. `agent-sdk mcp oauth` refuses v2. The card lists `mcp-connections/` only, although `host-connections/` share the grant (`dist/internal/cursor/account-mcp.js:58-61`) | Dashboard Authenticate, or `CheckHttpMcpStatus({ serverIds: [<MCP_SERVER_ID>], oauthRedirectUri, serviceAccountId })` for the link. `DeleteMcpOAuthToken({ serverUrl, serviceAccountId })` clears one. Four consents done | one consent per slug per server | issue 11 |
| A consent stored a token with no Jira access | The Atlassian account was not on `<JIRA_SITE>`, so it was offered Bitbucket scopes only | Consent as the account on the site, `<OPERATOR_EMAIL>`, not the signed-in Cursor email or another Atlassian login. Every Jira write is made as that account | no | issue 11 |
| The desk could not post `factory: drive` for a person | A hosted desk posts as its service account's grant or as a bot, and a bot-authored comment is dropped at ingress | The desk's GitHub path is removed. Asked to fix a PR, it replies that the person types `factory: drive` on the PR. The main path is the fixer's drive on a factory PR's first failed `check_suite` or `workflow_run` | no | issue 12 |

Issue 11 and README step 2 still name the Cursor login address for the
consent. The account that worked is the one on the site.

### 1.2 GitHub App installation ownership and team linking

Installed on the GitHub organisation is necessary and not sufficient. The
production binder (`agentSdkGithubScopeBinder.ts`) requires the Cursor
`githubInstallation` row to carry the slug's team, or to be adoptable, and
production never passes `allowSharedInstall`.

| Symptom | Root cause | What fixed it | Open | Issue |
| --- | --- | --- | --- | --- |
| `deploy --cursor-events-repo example-org/demo-repo` ended `failed: GitHub repository is not accessible through this team's installation` | Installation `<GITHUB_INSTALLATION_ID>` is owned by another Cursor team. No team-to-team transfer exists | Sandbox moved to `cursor-demo-lab/marsbank`, a snapshot of `cursor-demo-lab/marsbank` | `example-org` repositories stay unreachable | issue 10 |
| Same failure on `cursor-demo-lab/marsbank` at `00d276f`, although the `cursor` app covers that organisation | Installation `155310938` was a user-owned row under another Cursor user, so adoption was refused | Turning Bugbot on for `marsbank` under the team transferred the row (`teamOwned: true`). Fixer and reviewer redeployed `running`, `watching: cursor-demo-lab/marsbank` | no | issue 10 |
| The desk accepted the flag and `doctor` passed | The desk has no GitHub channel, so nothing checks the binding. The `github-app` check reads GitHub, not the Cursor row | None. The deploy is the only check | yes | issue 10 |

### 1.3 v2 platform gaps

Hosted v2 is a different runtime from local `serve`.

| Gap | Symptom | What fixed it | Open | Issue |
| --- | --- | --- | --- | --- |
| New v1 deployments closed. `slack create` in 0.2.1 drafts v1 | 409 `v1_create_closed` | `POST /internal/agentsdk/slack/wizard` with `architecture: "v2"` and a user token. 0.2.2 defaults to v2 | no | issues 1, 2 |
| Multi-component gated (`agent_sdk_v2_multi_component`) | `deploy --all` refused | Six single-slug deploys | yes | issue 3 |
| No peer calls. No `/v1/mcp`. `mcp --prod` refuses v2 | `{ agent }` throws before READY | Peers behind `FACTORY_INPROCESS_PEERS`. Jira status as the bus | by design | issue 4 |
| Secrets attach only after READY | Import-time throws gave a 502 at first boot and `secrets set` 500 | Lazy env reads. Deploy, set secrets, deploy again | no | issues 5, 8 |
| `logs --prod` and `sessions --prod` refuse v2 | No runtime log for a `running` slug | 0.2.11: `bdk logs --prod --slug <slug> [--session <id>]` reads v2 logs. `sessions --prod` still refuses v2 | `sessions` only | issue 7 |
| No Slack interactivity or reactions. `reaction_added` is outside the manifest allowlist and dropped by the classifier. `interactivity.request_url` is rejected | Thumbs up does nothing. Cards never resolve | Text gate, `approve KEY` and `deny KEY`. 0.2.11 delivers `reaction_added`, so ✅ / ❌ on the filing prompt and plan post approve or decline too, once the app has the 0.2.11 manifest | cards only (unused) | design doc |
| `check_run` never forwarded (`isPlatformWorkflowWebhook` has no branch) | Red CI never woke the fixer | Drive on failed `check_suite` and `workflow_run` | yes | issue 12 |
| `mcp oauth` refuses v2 | No CLI consent | Dashboard or `CheckHttpMcpStatus` | yes | issue 11 |
| Registry model params differ from catalog params | `grok-4.7` with `effort` or catalog-only `context` returns 503 "Invalid parameters for registry model" | `factoryModel()` sends registry params for `grok-4.7` (`reasoning_effort`, `speed`; no `context`). Catalog overrides still send a full `GET /v1/models` variant | no | design doc |

### 1.4 Event delivery and idempotency

Hosted ingress answers 202 and replays each delivery into the VM on its
own Temporal `evt:` lane, in parallel. A sender retry runs twice, because
the delivery id is `httpreq:<uuid>` per request (`ADR 0003:183-185`), and
`continuationToken` with `coalesce` gives no serialization
(`ADR 0003:194-196`). Nothing user-visible records a delivery that matched
an edge and never became a session.

| Symptom | Root cause | What fixed it | Open | Issue |
| --- | --- | --- | --- | --- |
| `factory: drive` by `cursor[bot]` on marsbank #7 did nothing | Ingress drops every bot-authored `issue_comment` before the Agent SDK tap (`githubWebhook.ts:1320-1329`) | A person types the sentinel | platform | issue 12 |
| Red CI on marsbank #6 did nothing | Actions report `check_run`, never forwarded. The fixer acted only on `check_run` and `status` | `onCheckSuite` and `onWorkflowRun`, same `auto-drive:<owner>/<repo>#<n>` claim | no | issue 12 |
| The reviewer produced no session for `pull_request opened` | Unknown. Every hop up to the Temporal handoff checks out (hypothesis H1) | The debug build (`host.kv` `debug/github-events`, `GET /v1/channels/debug/events`) is removed (#160); `bdk logs --prod --slug factory-security-reviewer` shows the `github-event` and `review-posted` lines | yes | issue 12 |
| Two deliveries for one transition could plan or launch twice | Parallel lanes, redelivery on non-2xx | Read-then-put claims on natural keys (`plan/<KEY>:Triaged:<changelog.id>`, `implement/<KEY>`; `host.kv` has no compare-and-set, so two deliveries that both read first both claim), `Agent.create` with the same string as `idempotencyKey` (unchecked for concurrent creates), stale `pending` takeover after 10 minutes (planner) or 3 minutes (worker, which first adopts any agent a lost launch started and records only while it holds the claim). Triage has no claim; it relies on `admission: "coalesce"` and `already_commented` | platform (bugs.md ask 11; the plan claim has no external guard) | design doc |
| Driver cloud-agent idempotency keys did not dedupe a re-run minutes later | Not measured | The driver reads GitHub before each launch | yes | next-steps step 11 |

### 1.5 Jira trigger registration

Jira has no first-class channel on v2. Inbound is a signed webhook into an
authored `defineChannel` route.

| Symptom | Root cause | What fixed it | Open | Issue |
| --- | --- | --- | --- | --- |
| A scoped API token cannot register webhooks. `POST /rest/api/3/webhook` is for Connect and OAuth apps. `/rest/webhooks/1.0/webhook` returns `401 scope does not match` | Project Automation is a TLSSN project-admin action | Four Automation rules, `X-Factory-Webhook-Secret` (or Bearer) against `JIRA_WEBHOOK_SECRET`; HMAC system webhooks still accepted | manual | `jira-automation.md` |
| `TLSSN` shipped with three statuses | Team-managed default | Four statuses added with `POST /rest/api/3/statuses` and `/rest/api/3/workflows/update`. Names are config, `FACTORY_STATUS_*` | no | design doc |
| Automation cannot HMAC a body | Product limit | Handler accepts `X-Factory-Webhook-Secret` or Bearer against `JIRA_WEBHOOK_SECRET` as well as HMAC. Documented native-shaped body. No unsigned path | no | `jira-automation.md` |
| A ticket sat in `Triaged` with no `Plan:` | Webhook missing or secret mismatch. The handler's 401 hides behind the 202 | `curl` the route for a 202, then the webhook's Test link | no | README |

### 1.6 CI and secret-scanner friction

Repository CI is the example-org `secrets-policy` reusable workflow
(`.github/workflows/managed-app.yml`) plus Bugbot and Autofix.

| Symptom | Root cause | What fixed it | Open | Issue |
| --- | --- | --- | --- | --- |
| The gitleaks `atlassian-api-token` rule flagged the Atlassian tool-name lists in the connector tests | The rule matches token-shaped strings. CI generates its own gitleaks config, so a repository allowlist has no effect | Rewriting the flagged literal is the only repository-side fix | recurs | none |
| Bugbot and Autofix left checks stuck and produced false positives | Async checks that did not settle. Findings on lines the PR did not change | Re-run, then merge on green CI with what was verifiable | yes | none |

### 1.7 Operator-machine fragility

Every dashboard step ran from Simon's MacBook in Simon's browser, because
consents, the Slack wizard, the GitHub team link, and Jira webhooks have
no API a service account can call.

| Symptom | Root cause | What fixed it | Open | Issue |
| --- | --- | --- | --- | --- |
| The MacBook disconnected three times mid-flow | A laptop as the control host | Re-attach and resume. Every README step has a check | yes | none |
| Chrome restarted and turned off JavaScript from Apple Events | Browser policy reset on restart | Re-enable it and repeat the step | yes | none |
| Hosted slugs ran `b0f3d4e` (`cursor/factory-hosted-v2-a26f`) and then `148bc11` (`cursor/factory-integration-54c8`) while `main` was behind | Hosting bakes a pushed ref. The fixes sat on PR branches | PRs #40 to #45 merged. A redeploy from `main` closes the drift | until redeployed | none |

## 2. Scaling to thousands of repos

### 2.1 Tenancy model

One factory instance is six slugs, six secret sets, four Atlassian
consents, four Jira webhooks, one Slack app, and two GitHub bindings. Take
R repositories across O GitHub organisations owned by one Cursor team. The
GitHub channel caps a deployment at 20 repositories under one owner (July
GitHub skill), so one fixer and reviewer pair covers one block of up to 20
repositories in one organisation.

| Model | Slugs | Consents | Jira webhooks | Slack apps | Blast radius of one slug |
| --- | --- | --- | --- | --- | --- |
| One factory per repository | 6R | 4R | 4R | R | one repository |
| One factory per organisation | 6O, plus 2 per extra block of 20 | 4O | 4O | O | one organisation |
| Shared factory per team, repository allowlist | 4, plus 2 per block of 20 | 4 | 4 | 1 | every repository in the allowlist |

At R = 1000 and O = 50 that is 6000, about 300, and 104 slugs. Consents
are manual and per slug, so the first two rows are not operable.
**Recommend the shared factory per team.** The Jira side stays at four
slugs and four consents whatever R is. The GitHub side grows by one pair
per block from one source tree with a different `--slug`. `FACTORY_REPOS`
bounds every slug, and only the worker holds the launch scope. Split the
worker by risk tier, one worker slug per allowlist, when one launch scope
is too wide. Proven for the allowlist, one slug per stage, and the worker
as sole launch holder. The arithmetic and the 20-repository cap are
inferred.

### 2.2 Identity

- **Team-owned installations.** Install the Cursor GitHub App
  organisation wide and open it first in team context, so the row is
  created team-owned. A member's first view makes it personal, and the
  Bugbot repository toggle transfers it. Proven for the toggle (issue
  10). The first-view rule is inferred from
  `githubInstallations.ts:1099-1145`. No team-to-team transfer exists.
  Ask 5.
- **Team MCP servers, not plugin servers.** One `Factory Atlassian` per
  team. Proven (issue 11).
- **Consents scale with slugs, not repositories.** Four per team.
  Whoever consents is who every Jira write is made as, so consent with a
  dedicated Atlassian service user on the site. The count is proven
  (next-steps step 2). The service user is inferred.
- **No admin consent, no shared credential.** The catalog code
  (`cursor-account-mcp-auth.js:5-7, 51-53`) filters per service account,
  and both consent RPCs take a `serviceAccountId`. Ask 1.
- **Deploy principal.** The freeze clone needs a GitHub identity, which a
  service account lacks (issue 6). Ask 6.

### 2.3 Onboarding a repository as config, not code

A repository joins by adding one entry, never by editing an agent.

| Setting | Where | Status |
| --- | --- | --- |
| `FACTORY_REPOS` allowlist | Secret on every slug that reads repositories | proven (README step 6) |
| `--cursor-events-repo owner/repo` | Every redeploy of the fixer and reviewer. A redeploy without it drops the subscription | proven (issue 12) |
| Ticket names its repository | A Jira component or field mapped to `owner/repo`, checked against `FACTORY_REPOS`. Today the worker launches into one `FACTORY_SANDBOX_REPO` | inferred, code change |
| Factory PR marker | PR title starts with the ticket key. A `factory` label is the alternative | proven for the title (fixer test) |
| CI conventions | An Actions workflow that completes as `check_suite` or `workflow_run`. A required check named `CI / test` | proven for the events (issue 12) |
| Branch protection and Bugbot | Require the check and one review. Bugbot on in the Cursor dashboard | next-steps step 4, not yet applied |

Automate it as one script per repository. Set branch protection with `gh
api`, confirm the installation row is team-owned (a dry-run deploy is the
only check, issue 10), append to `FACTORY_REPOS`, and redeploy the pair
with the full binding list. Inferred. `scripts/doctor.mjs` already holds
the checks to extend.

### 2.4 Event routing at scale

- **Status bus.** One project per team means four webhooks per project.
  Shared projects with components keep one project in the JQL and carry
  the repository in the component. A filter of `project in (A, B, C)`
  keeps four webhooks per team either way. Proven for one project
  (`jira-webhooks.md`). The `in` filter and the component mapping are
  inferred.
- **System webhooks versus Automation.** Hosted default is TLSSN project
  Automation with `X-Factory-Webhook-Secret` (or Bearer) against
  `JIRA_WEBHOOK_SECRET` (`jira-automation.md`). HMAC system webhooks
  remain accepted (`jira-webhooks.md`) for replay and leftover admin UI
  hooks. Automation cannot HMAC the body; it must not be configured
  unsigned. At thousands of tickets the Automation run cap and missing
  retry still matter.
- **Dedupe.** A kv claim (read then put, not atomic: `host.kv` has no
  compare-and-set) before actuation, the claim carrying status
  and `changelog.id` so a replan passes and a redelivery does not, and
  `Agent.create` with `idempotencyKey` equal to the claim key. What is
  proven on six slugs is sequential redelivery: a later delivery finds the
  claim and does nothing. Concurrent deliveries are not deduped (both can
  pass the read), and the platform key did not dedupe a re-run minutes
  later, so the KV claim is the only guard and it is best effort.
- **Backpressure.** Ingress limits are 600 per minute for probes and 120
  per minute per deployment, answered with 429 and `Retry-After`
  (`ADR 0003:114-118`). Bodies are capped at 256 KiB and 64 headers
  (`ADR 0003:133-135`). `host.kv` is rate-limited per deployment through
  Statsig `agentsdk_store_rate_limits`. Shard by Jira project group onto
  a second slug set before one slug nears 120 transitions a minute.
  Inferred from the cited limits.

### 2.5 Cost and throughput

Host turns run Grok 4.7 at high effort, fast, for triage, planning, and
the desk. The worker and the fixer's drive path are host code with no
model turn. Implementation is one cloud agent per approved ticket on
Claude Opus 5.5 through `Agent.create`, and one per driven PR on the
fixer. Proven for the model config (tests pin both defaults). The Opus
launch gate is untested. Existing caps are one launch per ticket
(`implement/<KEY>`), one drive per PR (`auto-drive`), the allowlist, and
the two human gates. Inferred additions are a per-team ceiling on
concurrent cloud agents checked before `Agent.create`, and a
per-repository budget in `host.kv`.

### 2.6 Observability

- **Hosted logs.** Since 0.2.11, `bdk logs --prod --slug <slug>
  [--session <id>] [--once] [--json]` reads a v2 slug's session logs.
  `sessions --prod` still refuses v2, and no endpoint lists deliveries
  that started no session (issues 7, 12).
- **Debug route.** Removed (#160). It was a `host.kv` ring buffer on the
  security reviewer behind `FACTORY_DEBUG_TOKEN` (#44); on v2 it only ever
  answered 202. The reviewer keeps its console lines (`factoryDebug:
  "github-event"` per delivery the hooks see, `review-posted` per review),
  and `bdk logs --prod` showed them for a delivery that started a review,
  checked live on `factory-security-reviewer`. `logs --prod` follows
  sessions, so the line for a delivery that started none is not proven
  readable there.
- **Synthetic check per repository.** `scripts/e2e-drive.mjs` replays
  each Jira hop, drives `Approved`, opens two PRs, and prints pass, fail,
  or blocked per row. Run it per repository from CI on a schedule, because
  TypeScript `run` schedules do not fire on v2. Proven on one repository
  for the Jira rows. The GitHub rows are open. The schedule is inferred.
- **Artifacts as evidence.** Ticket comments, transitions, PR comments,
  the Slack thread. Proven.

### 2.7 Governance

- **Approval gates.** `approve file` and `approve KEY`, or the board move
  to `Approved`. Proven. Anyone who moves the card launches, so restrict
  the `Approved` transition with a Jira workflow condition. Inferred.
- **Human-typed triggers.** `factory: drive` must be typed by a person.
  The platform enforces it. Proven (issue 12).
- **Audit.** Every Jira write is made as the consenting account, and each
  stage leaves a comment and a transition. Proven.
- **Kill switch.** Disable the four webhooks, or set
  `FACTORY_JIRA_PROJECTS` empty and redeploy, and stop the worker slug.
  Revoke a slug's Jira access with `DeleteMcpOAuthToken`. Inferred. The
  secret lifecycle it relies on is proven (issue 8).

### 2.8 Asks for the platform team

Root cause, code path, and evidence for each confirmed ask are in [`bugs.md`](bugs.md).

1. Team-level consent for team MCP servers, one grant per team instead
   of per service account (issue 11).
2. List `host-connections/` on the MCP connectors card. Let
   `agent-sdk mcp oauth` mint the v2 link (issue 11).
3. A v2 delivery log (matched edge, admitted, refused, session id) and
   `sessions --prod` for v2 slugs (issues 7, 12). `logs --prod` for v2 is
   done in 0.2.11.
4. Forward `check_run` to v2 apps. Let an app opt in to comments from
   named bots (issue 12).
5. Team-to-team installation transfer, or `allowSharedInstall` on
   production binds (issue 10).
6. A deploy principal with a GitHub identity for CI (issue 6).
7. Slack interactivity on v2. `reaction_added` is done in 0.2.11.
8. Multi-component, or a multi-slug deploy without peers (issues 3, 4).
9. Accept catalog param ids on registry models, or document
   `reasoning_effort` and `speed`.
10. Raise the 20-repository cap per GitHub binding, or bind an
    organisation.

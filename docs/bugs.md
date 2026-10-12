# Platform bugs behind the asks

Each entry below backs one ask in
[`scaling-and-integration.md`](scaling-and-integration.md) section 2.8.
Every ask was proved from source and live read-only checks, then
independently validated. Only what the validator confirmed is stated here.

Sources for every citation: everysphere `main` at
`1f4259e35f98f6a92d78455a18a2a37311886b67` and `@cursor/july` 0.2.2
(`node_modules/@cursor/july`). `everysphere:` paths are from the
everysphere repository root; `july:` paths are from the package root.
Live checks ran on 2026-09-23 against team <CURSOR_TEAM_ID> (<CURSOR_TEAM_NAME> &
ADM). Issue numbers refer to [`deployment-issues.md`](deployment-issues.md).

## Ask 1: Team MCP connector consent is per service account, never per team

**Confirmed.** Issue 11.

**Symptom.** Each hosted slug that reaches the same team MCP connector
(Atlassian here) returns `not_connected` until someone clicks
Authenticate for that slug. Consenting once, or as your own login, does
not help any other slug.

**Root cause.** Each v2 component runs as its own service account
(`agent-serve-agentsdk:v2:<slot>`). The backend derives the MCP token
owner from the pod's key and reads the OAuth token only at
`(serviceAccountId, serverUrl)`. The token owner type has no team case,
and no team or admin grant exists.

**Code path.**

1. `<PRIVATE_MONOREPO>/backend/server/src/servers/agentSdkProductionFactory.ts:57-66` mints one service account per component.
2. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/agentServePodCredential.ts:4-7` binds the pod's `CURSOR_API_KEY` to it.
3. `july:dist/internal/server.js:511-515` builds the account MCP bridge on that key; `july:dist/internal/cursor/backend-client.js:243` calls `ExecuteSandMcpTool`.
4. `<PRIVATE_MONOREPO>/backend/server/src/servers/dashboardServer.ts:23362` resolves the caller from the auth id.
5. `<PRIVATE_MONOREPO>/backend/server/src/mcp/mcpToolCaller.ts:255-257, 229-231` sets the owner to the pod's own service account.
6. `<PRIVATE_MONOREPO>/backend/server/src/mcp/backendHttpMcpManager.ts:90-92` has no team owner; `:335-344` reads the token by `(serviceAccountId, serverUrl)` with no fallback (key at `<PRIVATE_MONOREPO>/backend/packages/prisma/schema.prisma:6774`).

**Evidence.** Four v2 slugs on the team reach one Atlassian connector
under four distinct service accounts. The dashboard grants one account
per click (`service-account-mcp-auth-buttons.tsx:71-73`).

**Ask.** A team-level grant for a team MCP connector that every
deployment service account on the team can read.

## Ask 2: Host connections are missing from the connectors card, and `mcp oauth` refuses v2

**Confirmed.** Issue 11.

**Symptom.** A slug whose `cursorAccount` connections live in
`agent/host-connections/` shows "declares no Cursor account MCP
connections" on the dashboard, so there is nothing to Authenticate.
`agent-sdk mcp oauth <connection> --slug <v2 slug>` exits 1 instead of
minting a consent link.

**Root cause.** `projectInfo` serializes only `agent.connections`, and
the dashboard card reads only that list from the stored manifest, while
the runtime bridge serves host connections with the same service
account. Separately, `mcp oauth` runs the v2 legacy-command guard before
anything that could mint a link.

**Code path.**

1. `july:dist/internal/discovery/info.js:71-79` emits `connections` only; `july:dist/internal/deploy-manifest.js:161` stores it as `info`.
2. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/temporal/agentSdk/freezeBake.ts:524-548` fetches the v2 manifest (via `agentServeAnyrunRuntime.ts:1749-1767`).
3. `<PRIVATE_MONOREPO>/backend/packages/server-shared/src/agentServe/agentServeManifest.ts:262-267` reads `info.connections` only.
4. `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/agentsdkDashboardDeployments.ts:577-582` builds `declaredMcpConnections` from it.
5. `everysphere:portal-website/apps/web/src/components/redesign/dashboard/deployed-agents/DeployedAgentConnectorsSection.tsx:69-72, 255-256` renders `declares-none` for an empty list.
6. `july:dist/internal/cli-mcp-oauth.js:223-231` calls the guard; `july:dist/internal/legacy-command-guard.js:44-48` throws; `cli-mcp-oauth.js:235-237` exits 1.

**Evidence.** `agent-sdk info --dir factory-desk --json` reports
`connections: []` for two host `cursorAccount` connections.
`mcp oauth tracker --slug factory-desk` prints "This command is not
supported for architecture v2 deployment" and exits 1.

**Ask.** Include host connections in the manifest the connectors card
reads, and let `agent-sdk mcp oauth` mint the consent link for a v2
component's service account.

## Ask 3: `logs --prod` and `sessions --prod` refuse v2, and refused deliveries leave no record

**Confirmed.** Issues 7 and 12.

**Status (0.2.11).** Split in three:

| Part | Status |
| --- | --- |
| `logs --prod` on v2 | Resolved in 0.2.11. `bdk logs --prod --slug <slug> [--session <id>] [--once] [--json]` follows the slug's recent sessions, or one session (`july:dist/internal/cli-ax.js`, `cmdLogs`, v2 branch). |
| `sessions --prod` on v2 | Still refused. `cmdSessions` still goes through `resolveProdTarget`, which calls the legacy-command guard. Open. |
| A delivery log that records refused and skipped deliveries | Open. `logs --prod` shows sessions only; a delivery that starts no session still leaves no readable record. |

The rest of this section is the original 0.2.2 finding, kept as the
record.

**Symptom.** On any v2 slug, `logs --prod` and `sessions --prod` exit 1.
When a GitHub event produces no session, there is nothing a
customer can query to learn whether it was matched, dropped, or lost.

**Root cause.** Both commands funnel into the legacy-command guard after
one probe. The control plane has no v2 `logs` route and no delivery list,
only a point lookup for deliveries that reached Temporal admission.
Every earlier refusal (unforwarded event type, bot guard, fan-out miss,
managed trigger gate, dedupe, routing-key refusal) is only a metric or a
server log line.

**Code path.**

1. `july:dist/bin/agent-serve.js:1005-1006` dispatches `logs`; `july:dist/internal/cli-ax.js:1422-1426` calls the guard (`sessions`: `cli-ax.js:1490-1492`, then `july:dist/internal/resolve-prod-target.js:73-78`).
2. `july:dist/internal/legacy-command-guard.js:22-26` treats a successful v2 probe as v2; `:37` is the refusal text.
3. `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/agentsdkEndpoints.ts:2333-2353` has no `logs` route and no delivery list.
4. `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/verifiedIngress.ts:448, 475-477, 483-492` returns `no_targets` or `refused` with no row written.
5. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/temporal/agentSdk/sessionActivities.ts:846-851` is where the only per-delivery record is written, at admission.

**Evidence.** `logs --prod --slug factory-desk --once` and
`sessions --prod --slug factory-desk` both print "This command is not
supported for architecture v2 deployment" and exit 1. The v2 session
list returned 0 sessions for `factory-desk`. `session <id> --prod` does
work on v2 and prints per-session engine logs, so v2 has per-session
logs, not per-delivery outcomes.

**Ask.** Two parts. CLI support for `logs --prod` and `sessions --prod`
on v2, using the session list and runs routes that already exist. A
delivery log that also records non-admitted deliveries and the matched
subscription edge.

**Update 2026-09-23 17:55Z: no host-decision log.** A decision that
starts no turn (a handler refusal, a dedupe skip, a filter) is visible
only as a bare status, and only when the caller already holds the
`deliveryId`.

- The one readable surface is the delivery-binding lookup,
  `GET https://api.cursor.com/internal/agentsdk/deployments/<slug>/session-deliveries/<deliveryId>?teamId=<team>`,
  with the CLI's API key. It returns `skipped`, `failed`, or `allocated`
  with a `sessionId`. It records admitted-then-skipped deliveries, so the
  earlier note that refusals leave no record is too strong for HTTP
  routes.
- The reason is dropped. July returns `skipped("handler rejected the
  request (401)", {status})` and prints `catch replay rejected by handler
  ... status=401` (`july:dist/internal/hosted-catch.js:104-118`). The
  host keeps only `outcome: "skip"`
  (`<PRIVATE_MONOREPO>/backend/.../hostedDeliveryProtocol.ts:282`), the binding
  has no reason column (`agentsdkSessionDeliveryBinding.ts:7-10`), a skip
  writes no start.log (`july:dist/internal/storage-protocol.js:89-96`),
  and the VM is discarded (`sessionActivities.ts:853-865`), so the
  printed line is lost.
- `skipped` also covers "handler answered 2xx and started nothing". On
  `factory-desk` a signed, accepted control delivery reads `skipped`, the
  same as the forged ones.
- GitHub-routed deliveries are keyed on the `x-github-delivery` id from
  Cursor's GitHub App, which the customer never sees, so a reviewer or
  fixer skip has no readable record at all.
- `framework-files` answers 404 to the API key (mounted only under
  `/dashboard-internal`), and by code shows nothing for a skip.
- `agent-sdk session <id> --prod` does work on v2, but only for
  deliveries that created a session.

Proof: one forged unsigned `jira:issue_created` to `factory-triage-jira`
at 17:47:08Z got 202 `httpreq:ea3fad1a...`, binding 404 at +9 s, then
`skipped` at +20 s, session count unchanged at 9. The 16:43Z signed
control reads `allocated` with `<CURSOR_SESSION_ID>...`. Every command and its
output is in the project store, `internal/hosted-no-turn-observability.md`.

**Ask, extended.**

1. `sessions --prod` on v2 (`logs --prod` is done in 0.2.11), plus
   an `agent-sdk delivery <slug> <deliveryId>` command for the binding.
2. A host-decision log: persist the skip reason and handler HTTP status
   on the binding; a delivery list by slug and time window that includes
   GitHub delivery ids; and start.log flushed for skip outcomes, at least
   4xx rejections.

## Ask 4: `check_run` and bot-authored comments never reach a hosted v2 GitHub channel

**Confirmed.** Issue 12 (its line numbers predate a formatting commit;
the current ones are below).

**Symptom.** A v2 `githubChannel` with `onCheckRun` never wakes on a
check run, and a `factory: drive` comment posted by `cursor[bot]` starts
nothing. The deployment is `running` with no error.

**Root cause.** The mailbox tap is the only GitHub ingest for hosted v2,
and every entrance to it requires `isPlatformWorkflowWebhook`, which has
no `check_run` branch. Bot-authored `issue_comment created` is dropped
earlier, before auth, by a guard whose only inputs are the payload and
the receiving GitHub App, so no deployment can opt in.

**Code path.**

1. `<PRIVATE_MONOREPO>/backend/server/src/github/githubWebhook.ts:1174-1185` runs signed taps, then `shouldTerminateEarly`, then auth.
2. `<PRIVATE_MONOREPO>/backend/server/src/github/githubWebhook.ts:1273-1279` drops bot comments (`<PRIVATE_MONOREPO>/backend/server/src/github/githubWebhookBotGuards.ts:24-34, 37-55`).
3. `<PRIVATE_MONOREPO>/backend/server/src/github/githubWebhook.ts:1053` calls `handleGithubAuthedWebhook`.
4. `<PRIVATE_MONOREPO>/backend/server/src/bugbot/github/githubWebhookAuthed.ts:480-481` gates on `isPlatformWorkflowWebhook` (`:120-133`, no `check_run`).
5. `<PRIVATE_MONOREPO>/backend/server/src/automations/sources/handleAutomationTrigger.ts:191-193` then `<PRIVATE_MONOREPO>/backend/server/src/automations/sources/webhookHandler.ts:3782-3785`, the mailbox tap.
6. `july:dist/internal/server.js:800-809` skips the pre-guard scm-events poll on hosted v2.

**Evidence.** Zero fixer and reviewer sessions on marsbank #6 and #7.
The fixer's manifest declares `check_run`; the #7 drive comment was
authored by `cursor[bot]`.

**Ask.** Forward `check_run` to v2 apps, and let a deployment opt in to
`issue_comment` events from named bot authors.

## Ask 5: A v2 deploy cannot bind an installation owned by another Cursor team

**Partially confirmed.** Issue 10.

**What is confirmed.** A v2 `agent-sdk deploy` binds each
`--cursor-events-repo` through `createAgentSdkGithubScopeBinder` built
with `allowSharedInstall: false`; no CLI flag, deploy API field, or
Statsig gate on the binder can enable the widen, and no code path moves
a `githubInstallation` row between two active Cursor teams. For a deploy
authenticated as a Cursor user, an installation owned by another active
team is refused with `PROVIDER_SCOPE_UNBOUND: GitHub repository is not
accessible through this team's installation`.

**Not confirmed.** That exact ownership is the only accept path: a
service-account deploy inside a default-off Statsig ramp, holding a
same-organisation grant from a default-off dashboard share dialog, can
also pass.

**Code path.**

1. `july:dist/internal/cli-deploy.js:508` sends the repos; `july:dist/internal/deploy-client.js:419-437` posts the v2 body, with no shared-install field.
2. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/temporal/agentSdk/deployActivities.ts:414` builds the controller with no options.
3. `<PRIVATE_MONOREPO>/backend/server/src/servers/agentSdkProductionFactory.ts:91-93` sets `allowSharedInstall` false.
4. `<PRIVATE_MONOREPO>/backend/server/src/servers/agentSdkGithubScopeBinder.ts:101-102` calls `ensureTeamOwnsInstallation` (`<PRIVATE_MONOREPO>/backend/server/src/github/githubAccessService.ts:7947`, deny at `:8015`).
5. `<PRIVATE_MONOREPO>/backend/server/src/servers/agentSdkGithubScopeBinder.ts:110-126` returns the refusal.

**Evidence.** The refusal for `example-org/demo-repo`, and for marsbank
at `00d276f`, is recorded in issue 10. It was not re-run (a deploy is a
write).

**Ask.** Let a production v2 deploy bind an installation owned by
another active team in the same organisation: a team-to-team transfer,
or `allowSharedInstall` (honouring an explicit grant) on production
binds.

## Ask 7: Slack `reaction_added` and interactivity have no path on v2

**Confirmed.** Context in issue 13 and section 1.3.

**Status (0.2.11).** The `reaction_added` half is resolved: 0.2.11's Slack
pack takes an `onReactionAdded` handler over hosted v2 and adds
`reaction_added` to the declared event types when it is set
(`july:dist/channels/slack/types.d.ts`, `slack-channel.d.ts`). The desk
uses it for ✅ / ❌ approvals on the filing prompt and the plan post; the
deployed app still needs the 0.2.11 manifest (`reaction_added`,
`reactions:read`) before any reaction arrives.
July 0.2.11 handles Block Kit button clicks on hosted v2; the factory
still deliberately uses ✅/❌ reactions only, with no buttons or cards. The rest of this section is the original 0.2.2
finding.

**Symptom.** A thumbs-up on a desk message does nothing, and Approve
buttons on a card never resolve. The desk falls back to text replies
(`approve KEY`).

**Root cause.** Cursor-provisioned v2 Slack apps may subscribe only to
six events, none of them `reaction_added`, and get no `reactions:read`.
The events route admits only `app_mention` and `message` and acks and
drops everything else. For interactivity, the validator rejects any
`interactivity.request_url`, v2 forces Socket Mode off, and no
interactivity route is registered.

**Code path.**

1. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/agentServeSlackEndpoints.ts:1660-1673` builds and validates the v2 manifest.
2. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/agentServeSlackManifest.ts:118-123` fixes the events; `:102-116` omits `reactions:read`.
3. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/agentServeSlackProvisioning.ts:795-802, 1032-1037` rejects events outside the allowlist.
4. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/agentSdkSlackAppEvents.ts:309-321, 173-193` drops any type but `app_mention` and `message`.
5. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/agentServeSlackProvisioning.ts:1046-1051, 1089-1095` rejects a request URL and requires Socket Mode off.
6. `<PRIVATE_MONOREPO>/backend/server/src/index.ts:2272-2277` registers only the events route; `july:dist/channels/slack/slack-channel.js:447-449` wires `onInteractive` only through Socket Mode.

**Evidence.** `slack manifest --env prod --print` lists bot events
`app_mention`, `message.im`, `app_home_opened`, and
`reactions:write` only. Unit tests pin both rejections
(`agentServeSlackProvisioning.test.ts:1080-1089, 1173-1179`).

**Ask.** Admit `reaction_added` (with `reactions:read`) for v2 managed
apps, and register the v2 interactivity route for `block_actions` that
the v2 Slack design doc plans.

## Ask 8: Several v2 agents cannot be deployed as one unit, and peers never resolve

**Confirmed.** Issues 3 and 4.

**Symptom.** `agent-sdk deploy --all` on the factory parent is refused
with 403, so each agent is a separate `--slug` deploy. A
`defineConnection({ agent })` peer throws at startup, and a remote
`/v1/mcp` peer returns 404.

**Root cause.** More than one component per deploy needs
`agent_sdk_v2_multi_component` (default false, all teams but team 1).
The CLI sends an all-v2 parent only as that one multi-component request,
with no per-slug fallback. Every hosted v2 component runs
`serve --dir . --mode single` in its own pod, so its only mount has an
empty slug, and v2 ingress serves only `/v1/channels/*`.

**Code path.**

1. `july:dist/internal/cli-deploy.js:163-164, 335-339` routes an all-v2 parent to one application; `:634-636, 683` posts `components`.
2. `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/agentsdkEndpoints.ts:2281, 623` calls `acceptAgentsdkDeploy`.
3. `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/agentsdkDeployService.ts:328-337` then `agentsdkDeployAccess.ts:16-21` decide (gate default at `<PRIVATE_MONOREPO>/backend/server/src/experiments/experimentConfig.ts:10313-10321`); `agentsdkEndpoints.ts:639-640` returns 403.
4. `<PRIVATE_MONOREPO>/backend/packages/server-shared/src/agentServe/agentServeShared.ts:1113-1120` starts `serve --mode single`.
5. `july:dist/internal/discovery/project.js:143-144` gives the mount slug `""`; `july:dist/internal/peer-connections.js:22, 38-40` throws for any peer.
6. `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/agentsdkHttpIngress.ts:630-636` 404s every non-channel path.

**Evidence.** All 11 v2 applications on the team are single-component.
`/v1/mcp` on the desk's engine alias returns 404, and `mcp --prod` refuses
v2. The gate's live value for the team is not readable.

**Ask.** Turn on multi-component for the team, or add a deploy that
ships several v2 agents as separate slugs in one command. Neither brings
peers back on hosted v2.

## Ask 9: Registry models reject the catalog `effort` param id

**Confirmed.** Context in section 1.3.

**Symptom.** A slug whose model is `grok-4.7` with
`{ id: "effort", value: "high" }` fails the turn with
`Invalid parameters for registry model: "grok-4.7"` (the hosted engine
reported it as 503). Catalog rows such as `grok-4.5` and `grok-4.6`
advertise `effort`.

**Root cause.** `grok-4.7` is a registry-only model whose effort
dimension is named `reasoning_effort`. The resolver copies param ids
verbatim, remaps only `fast` to `speed`, and fails on any id the row
does not define. July forwards params unchanged and documents only
`effort` and `fast`.

**Code path.**

1. `july:dist/internal/sdk-runner.js:492` passes params to the SDK unchanged.
2. `<PRIVATE_MONOREPO>/backend/server/src/servers/agentServer.ts:1609` calls `resolveModelFromRequest`.
3. `<PRIVATE_MONOREPO>/backend/server/src/servers/modelParamsUtil.ts:1345-1349` copies ids; `:1380-1393` resolves the registry row.
4. `<PRIVATE_MONOREPO>/backend/server/src/modelDeploymentRegistry/catalog.ts:386-401` remaps `fast` only; `:507-517, 529-536` rejects unknown ids.
5. `<PRIVATE_MONOREPO>/backend/server/src/servers/modelParamsUtil.ts:1395-1411` throws `BadModelName`.

**Evidence.** Local SDK agents on `grok-4.7`: `effort=high` fails with
the error above; `reasoning_effort=high` with either `fast=true` or
`speed=fast` finishes. `Cursor.models.list()` advertises
`reasoning_effort` and `fast` for `grok-4.7`, and `effort` for `grok-4.6`.

**Ask.** Accept `effort` as an alias for `reasoning_effort` on registry
models, or document `reasoning_effort` in July's model reference. `fast`
already works.

## Ask 10: GitHub bindings take exact repositories only, and July caps them at 20 under one owner

**Partially confirmed.** Section 2.1.

**What is confirmed.** No GitHub binding surface (July
`cursorAccount.repos`, `serve --cursor-events --repo`,
`deploy --cursor-events-repo`, `event-repos`, the v2 deploy and
event-repositories APIs, or the dashboard) accepts anything but exact
`owner/name`, and every v2 GitHub subscription is one `repository` scope
row matched by exact key. The v2 deploy API allows 32 repositories with
no owner rule, but July enforces 20 under one owner on authored
`cursorAccount.repos` and on every `serve --cursor-events --repo` scope,
and the backend enforces the same on every GitHub token and proxy
request. Because v2 non-persistent session pods start with
`--cursor-events --repo` for each installation repository, a v2
`githubChannel({ cursorAccount })` deployment with more than 20
repositories or two owners fails at engine boot. The only org-wide
mechanism is reserved for Cursor-managed automations.

**Not confirmed.** The prover's statement that hosted v2 pods never hit
July's serve scope; only persistent and freeze pods start with no repos.

**Code path.**

1. `july:dist/internal/cli-deploy.js:508` then `july:dist/internal/deploy-client.js:435` send the list.
2. `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/agentsdkEndpoints.ts:125, 157` cap it at 32; `agentsdkDeployService.ts:346-350` checks grammar only.
3. `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/deployBindings.ts:36, 116-124` writes one binding per `owner/name`.
4. `<PRIVATE_MONOREPO>/backend/server/src/agentServe/agentSdkGithubMailbox.ts:95` then `<PRIVATE_MONOREPO>/backend/server/src/factory/agent-sdk/fanoutDao.ts:142-144` match by exact key.
5. `july:dist/internal/server.js:172` builds the serve scope; `july:dist/channels/github/cursor-account.js:9, 72-74, 84-85` enforce 20 and one owner.

**Evidence.** July's parser, run locally: 21 repositories throws "Cursor
account GitHub credentials support at most 20 repositories."; `acme/*`
throws "expected owner/repo".

**Ask.** Bind an organisation. Until then, check the 20-repository,
one-owner rule at deploy instead of at engine boot, or raise it (20 is a
Cursor constant; GitHub allows 500 repositories per installation token).

## Ask 11: `ctx.host.kv` has no compare-and-set or conditional put

**Proven** (coordinator, 2026-09-24, against the deployed `@cursor/july` 0.2.2; not part of the section 2.8 prover/validator set).

**What is proven.** The kv an agent gets as `ctx.host.kv` exposes only
`get`, `put`, and `delete`, on the hosted v2 storage path and on the local
filesystem store alike. `HostKvCasApi` (`getWithVersion`, `putIfAbsent`,
`putIfVersion`) exists in the types, but the agent-facing kv never
implements it, so `supportsKvCas(ctx.host.kv)` is always false.

**Code path.**

1. `july:dist/internal/session-engine.js:317` builds the agent kv with `createHostKvApi`.
2. `july:dist/internal/host-kv.js:22-34` returns `{ get, put, delete }` when a durable storage backend is present (`storage-coordinator.js:514-536`) and the filesystem store otherwise.
3. `july:dist/types.d.ts:560-567`: "The agent-facing `host.kv` stays plain HostKvApi; storage backends supply CAS via the optional `cas` group on `defineStorage`."

Rechecked against 0.2.11, again against 0.2.13 (`host-kv.js` differs only in formatting), against 0.2.14 (`host-kv.js` is byte-identical to 0.2.13), and against 0.2.18 (the version the factory pins now; `host-kv.js` is byte-identical to 0.2.14): the same result.
`session-engine.js:295` is the only place `ctx.host.kv` is built, and
`host-kv.js:13-25` still returns `{ get, put, delete }` on both paths. So
every `supportsKvCas(kv)` / `putIfAbsent` branch in the factory is dead in
production and runs only against test fakes that add those methods.

**Effect.** Every claim and dedupe in the factory is read then write:
best effort, with a residual window between read and write, and no
cross-session atomicity. The desk's and the fixer's verified helpers add a
read-back; the planner's and the worker's claims do not.
Races it would close:
- ticket claims (worker `implement/<KEY>`, planner and triage claims,
  desk announce claims), where two deliveries of one event can both pass
  the read;
- the desk's Slack thread binding (`ticket/<KEY>`), where a Slack filing
  and a Jira-filed intake root can both bind;
- the fixer's drive claims, where a release and a retake of the same PR
  can interleave.
Today nothing gives exactly-once effects. The factory leans on external
checks to narrow duplicates: the Jira status before a move, the
`Agent.create` idempotency key (its behaviour on concurrent creates is
unverified), and GitHub's own conflict responses.

**Status: open (2026-09-26).** Seen live as duplicate Triaged, Needs info,
and thread-detail effects when two deliveries raced
([`deployment-issues.md`, issue 19](deployment-issues.md#19-concurrent-deliveries-both-won-a-claim-no-kv-compare-and-set)).
Factory mitigation in #133 (`364a2941`): the desk's Triaged, outcome, and
thread-detail claims wait a settle window after the verified write
(`FACTORY_DESK_CLAIM_SETTLE_MS`, default 2 s), read again, and keep the
claim only if it is still their own. Every racer but the last writer
yields. That is best effort, not atomic: a rival put that lands later
than the window can still duplicate a line. `claim-lease.ts` already
takes a `putIfAbsent` / `putIfVersion` path when the kv implements
`HostKvCasApi`, so the factory switches to atomic claims with no code
change once this ask ships. The fixer's drive claims and the worker's
`implement/<KEY>` claim do not use the settle window and still rely on
the external checks above.

**Ask.** Expose the storage backend's `cas` group on `ctx.host.kv`
(`putIfAbsent`, `putIfVersion`, conditional delete), or document that
agent kv is last-writer-wins.

Excluded: ask 6 (a deploy principal with a GitHub identity for CI),
because the prover disproved the stated mechanism, and what the validator
confirmed is that the `example-org` installation is owned by another
Cursor team, which is issue 10 and ask 5.

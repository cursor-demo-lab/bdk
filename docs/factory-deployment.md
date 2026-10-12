# Deploying the factory

The factory is a set of long-running autonomous agents, not a chain of
one-shot scripts. Six always-on hosted slugs (desk, triage, planner,
worker, pr-autofixer, security-reviewer) carry one ticket from a Slack or
Jira intake through triage, plan, approve, the implement PR, review gates,
and Done. Each one wakes on an event, leaves its artifact on the ticket or
the pull request, and goes back to listening. People step in at two gates
(`approve file` and `approve KEY`) and at the merge. The desk's hop
watchdogs report a hop that stalls. A person recovers it with
`retry KEY`.

This is the operator runbook for deploying, redeploying, and smoke-testing
those agents on Cursor-managed hosting v2. It keeps the commands and the
checks and leaves the reasons to the linked docs. The long-form checklist is
[`../README.md`](../README.md), what blocked each past deploy is
[`deployment-issues.md`](deployment-issues.md), and the Jira rules and
body templates are [`jira-automation.md`](jira-automation.md).

Run every command from ``. Secret names
appear here. Values never do.

## Hard rules

- Everything lives on Cursor team `<CURSOR_TEAM_NAME>` (id `<CURSOR_TEAM_ID>`).
  Deploy with a credential for <CURSOR_TEAM_NAME>: the team API key exported as
  `CURSOR_API_KEY`, or your own `agent-sdk login`. Do not
  `env -u CURSOR_API_KEY` for this team's factory deploys; that path broke
  the team bind and the GitHub install. Never deploy as a Cursor service
  account. Details in [Deploy credential](#deploy-credential).
- Hosted v2 only, one slug per `deploy`. `deploy --all` is refused on this
  team. Do not run `agent-sdk slack create` here: it has drafted v1 apps
  that fail with `v1_create_closed`. The desk's Slack app comes from the
  v2 wizard (section 3).
- Staging runs on `<slug>-staging` slugs with `FACTORY_ENV=staging`, their
  own Slack app, Jira project, and sandbox repository. A staging slug never
  gets `--cursor-events-repo cursor-demo-lab/marsbank`, a TLSSN rule, or
  `#mars-eng-intake` ([section 10](#10-staging-slugs)).
- The team owns the `cursor` GitHub App installation on `cursor-demo-lab`
  (installation `155310938`, moved by turning Bugbot on for `marsbank`
  under this team). Never attach the `example-org` installation to team
  `<CURSOR_TEAM_ID>`
  ([issue 10](deployment-issues.md#10-github-channel-slugs-need-the-teams-github-app-on-the-sandbox)).
- Pass `--cursor-events-repo cursor-demo-lab/marsbank` and `--team <CURSOR_TEAM_ID>`
  on every deploy, all six slugs. That flag is the SCM Cursor-event watch
  list only (`cursorEventRepos` in July 0.2.18): GitHub / Origin / deploy
  *channel* wakes for the agent (worker PR events, fixer, review watcher,
  desk review updates). It does **not** set the Rollouts catalog
  `deploySourceUri` for Agent SDK ships — those report
  `https://origin.cursor.com/repos/example-org/demo-repo` from the deploy
  git source. A redeploy replaces the watch list, so one without the flag
  drops the GitHub subscription and breaks factory marsbank handling
  (issue 10). Do not retarget the flag at `example-org/demo-repo`: this
  team's installation cannot access that org. The desk's read-only GitHub
  channel posts the PR's review updates into the ticket's thread. Agent SDK
  also auto-creates catalog services named like the deploy slug
  (`factory-desk`, …); those are not marsbank ship targets. Change-monitor
  plans can only name a live catalog Service id — register `marsbank-web`
  (marsbank CI `register`) so reviews do not fall back to a factory slug.
- `FACTORY_REPOS` is `cursor-demo-lab/marsbank` on the planner, desk, fixer,
  and reviewer. A fixer whose list omits the repository fails every red-check
  delivery with a named error (#107).
- One Jira delivery source per slug (section 2).
- Leave `FACTORY_INPROCESS_PEERS` unset on hosted slugs. Peers are for
  local `serve --dir .` only.
- Read hosted logs with `agent-sdk logs --prod --slug <slug> --team <CURSOR_TEAM_ID>`
  (section 6). `bdk` is the same binary under its older name.

## Deploy credential

Two paths work on this team. Neither unsets `CURSOR_API_KEY`.

1. Automation, such as Grok Bot or a scripted redeploy. Export the Field
   Eng team API key as `CURSOR_API_KEY`; for Grok Bot that is
   `card.CURSOR_API_KEY` from the box secrets. Never print it. `whoami`
   reports `credentialSource: env`.
2. An interactive operator. Run `agent-sdk login` as yourself, on Field
   Eng. With no `CURSOR_API_KEY`, `CURSOR_API_KEY_FILE`, or
   `CURSOR_SERVICE_ACCOUNT_KEY` in the shell, the CLI uses the stored login
   and `whoami` reports `credentialSource: login`.

Never deploy as a Cursor service account. It has no GitHub identity, so
the build's clone fails with `[unauthenticated]`
([issue 6](deployment-issues.md#6-deploy-as-the-user-login-not-a-service-account)).
The CLI takes `CURSOR_API_KEY` first, then `CURSOR_API_KEY_FILE`, then
`CURSOR_SERVICE_ACCOUNT_KEY`, then the stored login. Unsetting
`CURSOR_API_KEY` on a box that also holds a service-account key falls
through to that key, which is what the generic Agent SDK deploy skill
does. Do not use that skill for this factory.

Check the credential in the same shell before every deploy session:

```bash
S="npx -p @cursor/july@0.2.22 agent-sdk"
$S whoami --json
```

Continue only when `teamName` is `<CURSOR_TEAM_NAME>` and
`credentialSource` is `env` (the team key) or `login` (you). Stop on
`service-account`.

Older docs (README step 1, `deployment-issues.md` issue 6 and its
"Commands that worked") still prefix commands with
`env -u CURSOR_API_KEY -u CURSOR_SERVICE_ACCOUNT_KEY`. That is out of date
for this factory; use the commands in this runbook.

## 1. Prerequisites

Once per environment. For another team or Jira project, follow README
steps 1 to 6 instead.

| What | Value | Check |
| --- | --- | --- |
| Cursor team and credential | `<CURSOR_TEAM_NAME>` (`<CURSOR_TEAM_ID>`). The team API key as `CURSOR_API_KEY` (automation), or `agent-sdk login` (interactive) | `agent-sdk whoami --json` shows that team and `credentialSource` `env` or `login` ([Deploy credential](#deploy-credential)) |
| GitHub | Sandbox `cursor-demo-lab/marsbank` with a CI workflow, Bugbot on, auto-merge off. The `cursor-demo-lab` installation linked to the team (dashboard, team selected, Integrations → GitHub → Manage) | After the deploy, `agent-sdk deployment <slug>` shows `watching: cursor-demo-lab/marsbank` on the five GitHub slugs |
| Atlassian | Team MCP server `Factory Atlassian` (id `<MCP_SERVER_ID>`, HTTP, `https://mcp.atlassian.com/v2/mcp`), added by a team admin. The plugin's Atlassian server surfaces per user and no slug sees it | Listed under Team MCP Servers. The per-slug consent comes after the first deploy (section 3) |
| Slack | Workspace `<SLACK_WORKSPACE>`, intake channel `#mars-eng-intake` (`C0EXAMPLE1`). `factory-desk` is the only Slack app | `@Factory hello` in the channel gets a reply once the wizard is done (section 3) |
| Jira | Project `TLSSN` on `example.atlassian.net` (id `11339`), seven statuses with global transitions: To Do, Triaged, Planned, Approved, In Progress, In Review, Done. A TLSSN project admin for Automation | Any TLSSN issue offers all seven statuses |

## 2. Jira delivery: one source per slug

Each Jira-consuming slug takes exactly one live source. The default is
TLSSN project Automation: "Send web request" rules that carry the slug's
`JIRA_WEBHOOK_SECRET` in the `X-Factory-Webhook-Secret` header. The
legacy alternative is a site system WebHook signed with HMAC
([`jira-webhooks.md`](jira-webhooks.md)).

Never both. With both, every transition arrives twice under two changelog
ids, so the planner starts two planning sessions per entry into Triaged
and the desk posts every status line twice. The handlers do not dedupe
this, on purpose
([`bug-hunt-round-2.md`](bug-hunt-round-2.md), finding 6). Before you
enable the rules, a site admin opens Settings → System → WebHooks and
disables any enabled webhook that points at a factory engine alias
([operator checklist](jira-automation.md#operator-checklist), step 1).
Signed replays (`scripts/replay-jira-transition.mjs`, `e2e-drive --replay`)
are fine.

The five rules. Each URL is the slug's engine alias plus the path. The
bodies are in [`jira-automation.md`](jira-automation.md#body-templates).

| Rule | Path on that slug | Trigger | Body |
| --- | --- | --- | --- |
| `factory-triage-jira` | `/v1/channels/webhook/` | Issue created | Created |
| `factory-planner` | `/v1/channels/webhook/` | Issue transitioned to Triaged, no "from" status | Status |
| `factory-desk` | `/v1/channels/jira/` | Issue transitioned to Triaged, Planned, Approved, In Progress, In Review, Done. Allow rule trigger ticked | Status |
| `factory-desk-comments` (to `factory-desk`) | `/v1/channels/jira/` | Issue commented, no condition. Allow rule trigger ticked | Comment |
| `factory-worker` | `/v1/channels/jira/` | Issue transitioned to Approved | Status |

Every rule is POST with header `Content-Type: application/json` plus the
hidden header `X-Factory-Webhook-Secret`, and "Wait for response" unticked.

Every free-text smart value in a body uses `.jsonEncode`
(`{{issue.summary.jsonEncode}}`, `{{comment.body.jsonEncode}}`,
`{{issue.description.plainText.jsonEncode}}`,
`{{issue.reporter.displayName.jsonEncode}}`). Without it, a quote in a
title makes the body invalid JSON. The host drops it silently while the
Jira audit still logs "Successfully published web request"; that is how
planning broke for TLSSN-40 and TLSSN-41. Copy the bodies from
[`jira-automation.md`](jira-automation.md) rather than retyping them.

No rule moves a card to In Review or Done; the worker does that from the
pull request. Disable any GitHub for Jira "Pull request created / merged"
transition rules. An Automation audit "Success" only means the control
plane answered 202. A stale secret is a 401 inside the pod that no audit
row shows, so the proof is a `Triage:` comment on a new ticket.

## 3. Deploy

Hosting bakes a pushed ref, never local files, so push first. Then the
preflight:

```bash
npm ci --prefix factory-desk; for p in triage-jira planner factory-worker pr-autofixer security-reviewer; do npm ci --prefix $p; done
node scripts/doctor.mjs
mise run check && mise run test && mise run validate
```

Deploy in this order, so every Jira rule has a live target. Each command
waits for `Deployment running`.

`--ref` takes the full 40-character SHA of a pushed commit. These are the
production slugs; the staging commands are in
[section 10](#10-staging-slugs).

```bash
REF=$(git rev-parse HEAD)                  # full 40-char SHA, already pushed
S="npx -y -p @cursor/july@0.2.22 agent-sdk"   # CURSOR_API_KEY stays as checked above
$S deploy --ref $REF --dir triage-jira       --slug factory-triage-jira       --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir planner           --slug factory-planner           --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir factory-worker    --slug factory-worker            --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir factory-desk      --slug factory-desk              --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir pr-autofixer      --slug factory-pr-autofixer      --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir security-reviewer --slug factory-security-reviewer --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
```

`agent-sdk deployments --team <CURSOR_TEAM_ID>` lists all six;
`agent-sdk deployment <slug> --team <CURSOR_TEAM_ID>` shows one, including its
`watching:` line. `agent-sdk rollback <slug> [--release <id|version>]`
returns a slug to an earlier release.

| Slug | GitHub events used | Factory Atlassian consent |
| --- | --- | --- |
| `factory-triage-jira` | no (flag passed anyway, so every deploy line is the same) | yes |
| `factory-planner` | yes | yes |
| `factory-worker` | yes | yes |
| `factory-desk` | yes (review updates) | yes |
| `factory-pr-autofixer` | yes | no |
| `factory-security-reviewer` | yes | no |

### First deploy only

Once all six are `running`:

1. Set the secrets (section 4) on each slug, then run the six deploys
   again so each pod reads them.
2. Authorise Factory Atlassian for the four Jira slugs. Dashboard →
   Deployed Agents → slug → MCP connectors → Authenticate, in a browser
   signed in to Atlassian as `<OPERATOR_EMAIL>`; any other account
   is offered Bitbucket only. The desk, planner, and worker keep Jira in
   `agent/host-connections/`, so their card can show nothing to
   authenticate. A team admin then mints the link with
   `CheckHttpMcpStatus({ serverIds: [<MCP_SERVER_ID>], oauthRedirectUri, serviceAccountId })`
   ([README step 2](../README.md#2-integrations-on-the-cursor-dashboard)).
   `agent-sdk mcp oauth` refuses v2 slugs.
3. Run the Slack wizard in v2 mode for the desk, never `slack create`.
   `TOKEN` is your user access token; never commit it.

   ```bash
   curl -s -X POST https://api.cursor.com/internal/agentsdk/slack/wizard \
     -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"teamId":<CURSOR_TEAM_ID>,"slug":"factory-desk","env":"prod","architecture":"v2","envPrefix":"FACTORY_DESK","name":"Factory","force":true}'
   ```

   Open the returned `url`, approve the app, and invite the bot to
   `#mars-eng-intake`. The wizard stores `FACTORY_DESK_SLACK_BOT_TOKEN`.
4. Create the five Jira rules (section 2). Read each slug's `engineAlias`
   from `agent-sdk deployment <slug> --json`. Print only that field,
   because the full JSON can carry short-lived access headers.

### Redeploy

1. Push the change and take the new full SHA (`git rev-parse HEAD`).
2. Run `npm ci` in each host folder whose code or lockfile changed.
3. Run the preflight above.
4. Rerun that slug's line from the block above with the new `--ref`, same
   flags, `--cursor-events-repo` included.
5. Check `agent-sdk deployment <slug> --team <CURSOR_TEAM_ID>` reports `running`
   and `watching: cursor-demo-lab/marsbank`, then run the smoke test.

Redeploy only the slugs whose code changed, with the same command and
flags. Docs-only changes need no redeploy. Secrets and engine aliases carry over. A slug that is deleted and
recreated gets a new engine alias, so its Automation rule URL changes too.

The P0/P1 hillclimb (#129 to #133, 2026-09-26) touched only
`factory-desk` (#129, #131, #132, #133) and `factory-worker` (#130), plus
the `claim-lease.ts` copy in `pr-autofixer` (#133). That copy only adds
code the fixer does not call, so the fixer's behaviour is unchanged. Those
redeploys are done. No new secrets, Slack scopes, or Jira rules came with
them. `FACTORY_DESK_CLAIM_SETTLE_MS` (default 2000 ms) is an optional
environment override, not a declared secret. The planner, triage, and
reviewer need nothing. Do operator checklist step 1 (one delivery source)
once, and again after any Jira admin change: it is the one duplicate
source the desk's claims cannot absorb
([`jira-automation.md`](jira-automation.md#one-delivery-source)).

The planner and worker claims (KV Phase 1 K3) change only `planner` and
`factory-worker`; redeploy those two, one at a time. Keys are unchanged
and pending values only gain `owner` (and, on the worker, `deliveryId`),
so rolling back to the previous SHA is safe: old code ignores both fields
and reads a new pending as in flight. While one slug runs old code and the
next new, two concurrent deliveries can still both claim, as before the
change. Two optional overrides, read per request, not declared secrets
(set them with `agent-sdk secrets set <slug> <NAME>` only when needed):

- `FACTORY_CLAIM_SETTLE_MS` (default 2000 ms; `0` skips the settle re-read;
  above 10000 or unparseable keeps the default).
- `FACTORY_CLAIM_MODE=legacy`: the plain read-then-put claim, plain
  delete, and log output from before K3, exactly. Unset it to return to
  the owner claim.

Whether a changed value reaches a running slug without a redeploy is
Phase 0 gate G7; until it passes, redeploy after `secrets set`. Outside
legacy mode each claim logs `{"host":"planner"|"worker","claim":…,"key":…,"mode":…}`.

The review re-check lease (KV Phase 1 K4) changes only `factory-desk`.
`review-recheck/<owner>/<repo>#<n>/<sha>` keeps its key and its `until`
field and only gains `state`, `owner`, and `at`, so old code still honours
a lease and rolling back needs no kv change. One optional override, read
per request, not a declared secret, under the same G7 caveat:
`FACTORY_DESK_RECHECK_LEASE=off` puts back the plain read-then-put
`{ until }` record (`../factory-desk/README.md`, review updates).

The index merge (KV Phase 1 K5) changes `factory-desk` and
`factory-worker`; redeploy those two, one at a time. `hop-watch/index` and
`implement-pr-watch/index` keep their key and value (a list of issue keys),
so rolling back is safe. While a slug runs old code, its plain put can
still drop an entry the new code wrote; the ticket's next arm or fire puts
it back. One optional override, read per request, not a declared secret:

- `FACTORY_INDEX_MERGE=off`: the plain read-then-put add and prune from
  before K5, with no self-heal. Unset it to return to the merge.

The desk's index confirm waits `FACTORY_DESK_CLAIM_SETTLE_MS` plus a random
jitter of up to min(500 ms, that settle), so
`FACTORY_DESK_CLAIM_SETTLE_MS=0` also turns that confirm off: an arm then
writes the index once (its verified union) and relies on self-heal alone.

The KV retry policy (KV Phase 1 K6) changes the shared
`agent/lib/kv-verified.ts` in `factory-desk`, `planner`, `factory-worker`,
and `factory-pr-autofixer`; redeploy those four, one at a time
(`triage-jira` and `security-reviewer` carry no copy). No key or value
changes, so rolling back to the previous SHA is safe. A failed kv call is
retried only on HTTP 429, a 5xx, or no status (a network error), after
100 ms and then 400 ms, each jittered to between half and all of that; any
other 4xx, or one of the hosted store's reason codes
(`agentsdk_kv_key_invalid` and the rest of July's list), or one of July's
local refusals (an empty key, no deployment credential), stops at once
with `unavailable` and one `{"kv":"retry_stopped","op":…,"key":…,"status":…,"reasonCode":…}`
line. Pauses come only after a failed call, or after a contended write
whose read-back found a rival's value: such a write can pause up to 500 ms
before it succeeds. Each helper call pauses at most 500 ms. A caller that
already retries in a loop of its own passes `pausesMs: []`, so pauses never
stack: the desk's binding backoff still pauses 3.85 s at most, and the
autofixer's claim 1.25 s in a full outage and 5.0 s at worst when it
fails (K8, below, adds a settle to a claim that holds).
Sequential helper calls in one delivery each add their own 500 ms at most
(a planner or worker claim's write and release: 1.0 s in a full outage;
with a settle read that also fails, 1.5 s at worst). One optional override, read per call, not a declared secret,
under the same G7 caveat:

- `FACTORY_KV_RETRY_PAUSES_MS`: a comma list of milliseconds (sum at most
  500; over that, or unparseable, keeps the defaults). Empty or `off` turns
  the pauses off and keeps the retries. The autofixer's drive keeps its own
  `CLAIM_RETRY_MS` / `SETTLE_RETRY_MS` pauses either way.

Structured kv warnings and the ops failure funnel (KV Phase 1 K7) change
all six slugs: redeploy each, one at a time. No stored key or value
changes; the one new key, `v1/ops-alert/<hash16>/<UTC hour>`, is an
hourly dedupe marker nothing else reads, so rolling back is safe. Every kv
failure the code used to swallow silently now logs one
`{"kv":"warn","slug":…,"site":…,"status":…,"reasonCode":…,"message":…}`
line (`agent/lib/ops-funnel.ts` `warnKv`; the message is July's error text,
cut and token-masked (Slack, GitHub, JWT and Bearer shapes), never a value or
Slack text) and otherwise behaves as before. Where a best-effort Slack or
Jira step shared the kv call's catch, the two are now split: the non-kv step
logs `{"step":"warn","site":…}` and never reaches the funnel, so a `kv` line
is always a kv failure. Every `unavailable` from the shared verified helpers logs
`{"kv":"unavailable","site":"kv-verified.<helper>/<key prefix>",…}` unless
the retry policy already logged the refusal.

Those failures (a `warnKv` whose error carries a hosted `reasonCode`, and
every verified `unavailable`) also go to the ops funnel, which is off until
both optional secrets are set on a slug:

- `FACTORY_OPS_SLACK_BOT_TOKEN`: the dedicated low-scope ops bot
  (`chat:write` only; [section 10](#once-per-staging-environment-ops)).
  That bot does not exist yet. The funnel never falls back to the desk's
  token.
- `FACTORY_OPS_SLACK_CHANNEL`: the ops channel's `C…` id.

Both are declared in every slug's `hosting.secretNames`, so a deploy lists
them under "secrets declared but not set"; that is expected and never fails
validate or deploy. With either unset, a slug posts nothing and logs
`{"ops":"funnel_unconfigured"}` once per execution. An ops token equal to
`FACTORY_DESK_SLACK_BOT_TOKEN` is refused the same way
(`{"ops":"funnel_misconfigured"}`). With both set, it posts one line per
(slug, site, reason, and `subject` when a `warnOps` caller names one) per
hour, deduped by a kv marker whose value carries
`exp` two hours on; when kv itself is failing, by a create-only `host.files`
marker at the same path (each such write removes that signature's marker for
the hour before); when both fail, at most one line per execution, marked
"dedupe unavailable". A post that fails gives its marker back, so the next
execution tries again. The funnel sees each helper call, not a caller's final
outcome: an `unavailable` inside a caller's own retry loop that later
succeeds still reports once per hour.
Every slug's egress now allows `slack.com` for that post. One optional
override, read per request, not a declared secret, under the same G7 caveat:

- `FACTORY_OPS_FUNNEL=off`: no posts, no dedupe writes and no metric; the
  warning lines stay.

Otherwise, with `OTEL_EXPORTER_OTLP_HEADERS` set (the OTLP switch,
[section 11](#11-opentelemetry-export-grafana-cloud)), each funnel failure
also counts `apj_factory.kv.failure` (`slug`, `site`, `reason`). Bind emits
one zero sample with `{ slug, site: "none", reason: "none" }` (`slug` is
`factorySlug`, or `${factorySlug}-staging` when `FACTORY_ENV` is staging) on
`host.otel`; July adds `agent_sdk.agent` (the July project name), so the
baseline matches a real failure's labels under scope `@cursor/july`.
Queries should sum by (`slug`, `site`, `reason`). A post runs in the
background of the delivery: an admission that returns first can lose it,
and the warning line stays in the logs. A process that serves several
deliveries counts as one execution for the once-per-execution lines.

The autofixer changes (KV Phase 1 K8) touch only `factory-pr-autofixer`;
redeploy it alone. No existing key changes shape: the `bugbot-rounds:`
value gains an optional `capNotedBy` token that older code ignores, and a
new kept key, `v1/pr-generation/<owner>/<repo>/<n>`, counts unmerged
closes (merged PRs cannot reopen, so merges add nothing). Rolling back is safe;
old code ignores the new key and goes back to the plain `pr:<label>`
continuation key. What changes:

- The drive claim settles: after its read-back it waits 2 s and reads
  again, and drives only if the claim is still its own (a re-read that
  keeps failing holds the claim, since the read-back verified it). The
  start's retries and its mark or release now share 7.5 s of pauses
  (12.5 s before), and the kv calls inside the start (a Bugbot round's
  record, and a fresh drive's continuation generation read) retry without
  pauses. So one delivery pauses 14.5 s at most in a kv outage: the
  PR read 1.25 s, a claim that holds 5.75 s (a claim that fails, 5.0 s,
  never starts), the start task 7.5 s. The flush path's fresh Bugbot drive
  (after admission) pauses the same 14.5 s when it starts, and up to
  15.0 s when it fails, since the channel then releases its claim with
  kv-verified's default pauses (at most 500 ms). Both are within the
  fixer's 15 s cap:
  three quarters of the longest handler gate G4 probes (20 s), leaving 5 s
  for kv round trips and the start's send. Hosted admission's budget, not
  GitHub's 10 s webhook timeout, is what bounds a delivery. A healthy
  delivery pays the 2 s settle and nothing else.
- Bugbot rounds and the cap note are verified merges: concurrent heads
  spend one round each, and two findings past the cap post one note,
  whenever each put lands before the other's read-back. A put that lands
  after it can still lose a round (the no-CAS residual
  `agent/lib/kv-verified.ts` documents).
- Closing a PR deletes its drive claim, `affinity/<pr>` and
  `bugbot-rounds:<pr>`, deletes the `drive-session/` record the claim
  names once the claim is gone, and (unless the PR merged) bumps
  `v1/pr-generation/<owner>/<repo>/<n>`, so a
  reopened PR starts with no bound agent, new `pr:<label>@g<n>` sessions
  (July resumes the session a continuation key names), and its two Bugbot
  rounds back. A drive that binds its agent after the close writes no
  affinity while GitHub says the PR is closed or merged (nor for a `pr:`
  session on an older generation), and a round recorded after the close
  finds no record and is skipped, since the first Bugbot peek writes the
  empty record rounds are added to. During the deploy, a PR whose first peek
  ran on the old revision has no empty record, so its first round recorded
  by the new one is skipped (one uncounted round, logged). Fresh-failure keys expire on their own (1 h) and the shared
  `webhook-buffer` only loses the PR's entry. A close that arrives after a
  reopen does nothing: the fixer reads the PR's state first and skips the
  cleanup when GitHub says it is open and was updated after the close
  event. A stale open answer, a body with no `updated_at`, or no answer
  counts as closed. Best effort: the close never fails
  the delivery, and logs one `{"fixer":"close_cleanup",…}` line saying what
  each step did.

While the old revision still serves, its plain round put can overwrite a
round the new code recorded (one extra Bugbot round at most). Past the
cap, an old and a new revision can each post the cap note once: the old
code's note is a plain put the new merge cannot see before it lands, and
the old code never reads back the new one's. A redeployed slug stops that.
A drive-channel session or buffered wake an old revision starts after a
reopen uses the plain `pr:<label>` key and may resume the pre-close
session. Three
optional overrides, read per request, not declared secrets, under the same
G7 caveat:

- `FACTORY_FIXER_CLAIM_SETTLE_MS`: whole ms from 0 to 2000 (default 2000;
  above 2000 or unparseable keeps the default). 0 skips the settle.
- `FACTORY_FIXER_CLOSE_CLEANUP=off`: a close releases the claim only, and a
  kv failure fails the delivery, as before K8.
- `FACTORY_FIXER_ROUNDS_MERGE=off`: Bugbot rounds and the cap note are plain
  read-then-put writes, as before K8.

The lost-launch fix (TLSSN-51, 2026-09-30) changes `factory-worker` and
`factory-desk`; redeploy those two, worker first. The shared
`agent/lib/ops-funnel.ts` gains `warnOps` in all six copies, but the other
four do not call it, so they need no redeploy; their next deploy carries it.
On that ticket the approval reached Approved and the
worker launched nothing and recorded nothing. The desk's hop watch nagged
at 11 minutes, and a plain `retry` launched in 8 s once the worker's
pending `implement/<KEY>` claim was 10 minutes old. Jira's audit log shows
the rule published both deliveries (04:46:56 and 05:02:19 AEST), so the
first was lost after it left Jira. The worker had these silent paths, the first ranked most likely:
- its Jira connector unusable on the release's first call after about 80
  idle minutes (loading, `needsAuth`, or an empty listing July caches for
  60 s), so the route answered 503 `comments_unreadable` before its claim,
  and hosted never redelivers a non-2xx;
- a launch with no deadline and no retry after its claim;
- a claim that missed its own put on a lagging read;
- handler 503s that hosted never redelivers;
- a body whose `{{issue.status.name}}` snapshot lagged the move, dropped
  as `stale_status` without asking Jira.

What changes (the `factory-worker` README, "Lost launches: the launch
watch", has the audit and detail):

- Connector discovery retries a throw or an empty listing (2.5 s, then
  3 s; `FACTORY_TRACKER_RETRY_MS`, read per call, not a declared secret).
  After an empty listing it probes with an unknown tool name, which makes
  July re-list past its cache and reports the server's state: `loading` or
  `error` from the reply text, and `needsAuth` from the `McpNeedsAuthError`
  July throws in place of a reply that mentions it. An unusable
  connector sends a `Jira connector` line to the ops funnel (site
  `handle.tracker`), and so does every `claim_unavailable` (site `handle.claim`).
- Unreadable comments or status, and `claim_unavailable`, answer 202 and
  hand the approval to the launch watch, or, when kv cannot hold it, to a
  reminder that carries the approval. A 503 remains only when neither can
  be scheduled, and then `Launch failed:` says so.
- A stale body is checked against Jira's live status and launches if the
  ticket is Approved. A claim record no version writes is taken over
  instead of blocking the ticket for good.
- The desk's launch hop watch now speaks, and accepts `retry KEY`, at 7
  minutes instead of 10. That is a minute after the worker's own relaunch
  could last land (4-minute fire, 30 s deadline, 60 s late wait);
  `../scripts/launch-timing.test.mjs` pins the order.
- Budgets:
  - Worst case, a delivery that launches spends about 100 s in admission.
    That covers the 2 s claim settle, Jira reads (up to 5.5 s of connector
    retries), a 5 s-capped reminder create, the 30 s deadline, the 60 s late
    wait, and Jira writes. Its backstop adds at most the 20 s implement PR
    sweep plus three 5 s-capped reminder creates.
  - A heal's reminder run spends about the same on its one heal (plus up
    to three `Agent.list` pages), then that backstop.
  - July documents no admission budget; the repo has only seen at least
    20 s hold.
- `Agent.list` is paged until an agent last modified before the lost
  launch's window. GET /v1/agents documents no order, so an older agent
  touched recently does not end the search.
- A late or thawed launch whose record is refused, while the claim names
  another agent or is gone (an empty key is never recordable), cancels its
  own agent's runs and archives it
  (`Agent.cancelRun`, `Agent.archive`). It never touches the agent the
  claim names. When the claim is unreadable or names no agent yet, nothing
  is archived. Either way ops Slack gets a `handle.orphan` alert whose
  `subject` carries the ticket and agent, so no orphan is deduped away
  behind another's. The shared funnel keeps `subject` out of its metric
  labels, so the metric's `reason` stays a fixed set. A late create failure posts `Launch failed:` only while that launch
  still holds the claim.
- An agent check that keeps failing (a refused `Agent.list`) gives up after
  3 attempts. It clears the pending claim, says `Launch failed:
  agent_unverified`, and sends the error to ops Slack, so a person's next
  move to Approved takes a fresh claim and launches.

- The create and first send share a 30 s deadline. A create that has not
  answered by then is not a failure. The delivery awaits it 60 s more and
  records a late answer. Past that, it keeps the claim pending, posts no
  `Launch failed:`, and still records the answer if this process lives to
  see it.
- A pending launch claim is taken over after 3 minutes, not 10
  (`FACTORY_CLAIM_MODE=legacy` keeps 10). A hosted pod's timers stop while
  it is parked, so a takeover never launches on the grace alone:
  - It adopts the agent a lost launch started (the ticket's `Implementing:`
    URL, or an `Agent.list` agent named `factory <KEY>: …` since that
    launch began).
  - It creates one only when that check positively finds none.
  - A launch records only while it still holds the claim (`recordLaunch`),
    so a thawed launch neither overwrites the takeover's record nor
    comments.
- Before its claim, each verified Approved delivery writes a launch watch,
  `implement-launch/<KEY>`, listed in `implement-launch/index`. It also
  arms one `implement_launch` reminder, first due 4 minutes after the
  approval. A watch still open after the grace relaunches through the
  route's own code (same `idempotencyKey`, one agent), from that reminder
  from that reminder only. Each run heals its own ticket once. The
  backstop sweep any worker delivery runs heals nothing: after the
  implement PR sweep it gives a watch with no reminder (or one more than
  10 minutes past the due time the watch records on each reschedule) a new
  one, recorded only while the watch still names the old reminder, so a
  delivery never spends its admission on another ticket's launch, and a
  closed watch never comes back. The relaunch's `Implementing:` comment says
  `Relaunched by factory-worker`, and an adopted agent's says `Recovered by
  factory-worker`. After 3 attempts it gives up with one `Launch failed:`
  comment, which the desk announces, unless an agent is already launched
  and only its move keeps failing (then ops Slack hears it). The reminder
  stops 30 minutes after the approval, a bound carried in its own args.
- Every verified Approved delivery that launches nothing now leaves one
  Jira line per approval: `Launch failed: <code>` (now also `config`,
  `claim_unavailable`, `comments_unreadable`, `launch_lost`), `Launch pending: …` when a retry is scheduled (it
  promises a relaunch only when a reminder is armed, and otherwise names
  the board move), or
  `Launch skipped: …` for an already-launched or stale approval. The desk
  announces only `Launch failed:`, and its parser ignores the other two
  (`../scripts/outcome-sentinels.test.mjs`).

No new secret, egress domain, Jira rule, or Slack scope comes with it. The
new keys are `implement-launch/<KEY>`, `implement-launch/index`, and
`implement-note/<KEY>/<changelogId>/<kind>`, all in the worker's
`kv-keys.ts`. `implement/<KEY>` keeps its shape, so rolling back is safe.
Old code ignores the new keys, and an `implement_launch` reminder that
fires on old code has no handler and is dropped. While the old revision
still serves, an approval it handles gets no watch, as before. The deploy
warning `missing_agent_session_stopped_event_subscription` stays expected.

For review updates in the thread (Bugbot, security review, CI, autofix, change-monitor),
the desk needs, once: `agent-sdk secrets set factory-desk FACTORY_REPOS`
with `cursor-demo-lab/marsbank`, then a desk deploy with
`--cursor-events-repo cursor-demo-lab/marsbank`, and `agent-sdk deployment
factory-desk` showing `watching: cursor-demo-lab/marsbank`. It uses the
team's `cursor` GitHub App installation (read tier), the same as the
worker: no PAT, no new Slack app, no Jira rule. The first deploy with the
flag is also the check that the installation covers the repository
([issue 10](deployment-issues.md#10-github-channel-slugs-need-the-teams-github-app-on-the-sandbox)).

The implement agent as a July cloud turn (2026-10-04) changes
`factory-worker` only; redeploy that one slug, same command and flags. A
verified Approved delivery now hands the implementation to July as one
`send()` on the worker's jira channel with a per-send `cloud` attach for
`FACTORY_SANDBOX_REPO` (continuation `implement:<KEY>#<changelogId>`),
instead of calling `@cursor/sdk` `Agent.create`
([`factory-worker/AGENTS.md`](../factory-worker/AGENTS.md), "The implement
agent is a July cloud turn"). The point is attribution: an SDK-launched
agent is invisible to July, so its turns, tokens, and cost never reached
section 11's telemetry and the cost per ticket undercounted every
implementation. The session is now July's, tagged `factory.ticket.key`
from the continuation token, so `cursor_token_usage_total` and
`agent_sdk_turn_count_total` carry the ticket. `cursor_cost_usage_USD_total`
carries it only partially: on 0.2.18 that counter arrives only for turns
whose cost estimate landed before `turn.completed` reached the collector
("BDK 0.2.18 upgrade", Turn cost; [`july-otel-upstream.md`](july-otel-upstream.md)
ask 10), so it is not a cost, and the dashboards price tickets from
tokens ([Grafana README](../observability/grafana/README.md),
`factory_ticket_key`). What to know for the deploy:

- **Identity and permissions.** July creates the cloud agent with the pod's
  `CURSOR_API_KEY`, the same credential the SDK launch used, so the
  deployment needs nothing it did not already have: the deploying identity
  (the team key or the operator's login, [Deploy
  credential](#deploy-credential), never a service account) must be able
  to start cloud agents on `cursor-demo-lab/marsbank` through the team's
  `cursor` GitHub App installation, which the existing launches already
  prove. The `cloud.repos` attach rides on every send on purpose: a cloud
  send with no repos makes the backend pick a team "no-repo" environment,
  and a deploying identity without that environment's permission is
  refused (`You do not have permission to start this environment`). If a
  launch ever fails with that text, the attach is missing, not the
  permission. No new secret, egress domain, Slack scope, or Jira rule.
- **The agent id arrives later.** Hosted admission honors one `send()` per
  delivery and runs it after the reply, so the delivery's log line is
  `turn_sent`, and the record, the `Implementing:` comment, the move to In
  Progress, and the PR watch follow from the session's `agent.bound` event,
  possibly on another pod. Expect the `Implementing:` line a little later
  than before (July's create plus the admission hop), and a pending
  `implement/<KEY>` claim stamped `sentAt` to wait 11.5 minutes before the
  launch heal retakes it. That launch grace is derived, not chosen:
  `LAUNCH_SENT_GRACE_MS` = `HOSTED_PENDING_SEND_TTL_MS` (hosted admission
  holds a pending send 10 minutes) + `LAUNCH_TIMEOUT_MS` (30 s) +
  `LAUNCH_LATE_WAIT_MS` (60 s), `claim.ts`; a July release that changes the
  admission hold changes the first term. The binding also writes the agent
  to `implement-agent/<KEY>` before it touches the claim, so a heal or a
  takeover finds an agent July started by that record and adopts it
  rather than starting a second one, after `Agent.get` confirms the agent
  is not in `error` or `cancelled`; it goes to `Agent.list` only when the
  record is missing or names a dead agent. A failed launch (its own
  agent's record only) and an orphan retire delete the record, so a retry
  does not adopt the agent that just failed; a takeover whose own turn
  fails adopts a live agent the replaced launch bound late instead of
  posting `Launch failed:`, and a takeover that binds its own agent
  retires that late one. A `turn.failed` before the binding is one `Launch
  failed: <reason>` line, as a refused create was, but only after the
  worker has read the agent's real status: see the next bullet.
- **A turn over 60 minutes fails on the pod, not in the agent.** The pod's
  `CURSOR_API_KEY` is a 60-minute token and July streams the cloud run
  through it, so an implementation past an hour ends its turn with an
  auth error mid-stream while the cloud agent keeps building (the token is
  the serve pod's, not the agent VM's); a stream cut on a pod replacement
  reads the same way. `turnFailed` therefore calls `Agent.get` on the
  session's agent (or the ticket's `implement-agent/<KEY>` record) first,
  and a `running` or `finished` agent is never a failed launch: no claim
  release, no `Launch failed:` line, log outcome
  `turn_failed_agent_alive`; a status that cannot be read is left for the
  heal (`turn_failed_status_unknown`). The build survives; its telemetry
  does not. July reports no usage on `turn.failed`, so the tokens and cost
  of every implementation that runs over an hour are lost to section 11's
  per-ticket metrics (the turn counts under `agent_sdk_turn_count_total`
  with `agent_sdk_turn_status="failed"`, and the ticket's cost undercounts
  by that run).
  Turns under an hour are the tested case; nothing here has been exercised
  on a real sixty-minute build yet. A fix needs July to refresh the token
  mid-stream or to report the run's usage on failure; neither is factory
  config.
- **Losing the session lease aborts the cloud run.** July holds a per-session
  turn lease on the pod (`turn-lease-store.js`: a lockfile refreshed every
  5 s, stale after 30 s). A pod that stalls past the stale window while a
  successor takes the session over has its turn aborted (`session-engine.js`
  "lease lost mid-turn; aborting"), and the abort cancels the SDK run
  (`sdk-runner.js` `run.cancel()`), so the cloud agent itself is stopped,
  not only the stream. That `turn.failed` carries status `cancelled`, and
  the agent reads `cancelled` (the SDK maps the server's `CANCELLED`;
  `EXPIRED` reads `error`), so the status check above does not save it.
  What the worker does depends on where the launch was: while the claim is
  still this launch's pending one (the binding had not been recorded), it
  releases the claim with one `Launch failed: cancelled` line, and moving
  the card to Approved again retries; once the binding was recorded (the
  claim is `launched`, the `Implementing:` line is on the ticket), the
  failure is `turn_failed_after_launch`, nothing on the ticket changes, and
  the implement PR watch reports the run that ended with no branch, as for
  any agent that stopped on its own. Expect it only when a pod freezes for
  half a minute during an implement run and another delivery for the same
  session arrives.
- **The heal still uses the SDK.** A reminder run has no channel `send`,
  so `healLaunch` (`via: "heal"`) launches through `Agent.create` as
  before; those agents stay unattributed, as all were. Agent listing,
  retiring, and run reading stay on `@cursor/sdk` too.
- **`tools: []` is gone from `agent.ts`.** July refuses a cloud turn on an
  agent that declares `tools`. That declaration also closed the built-in
  HTTP session API's per-session `cloud` override; `agent/channels/http.ts`
  now refuses principal-bearing `/v1/session*` sends whenever
  `AGENT_SERVE_GENERATION` is set. Hosted control-plane admissions
  (playground, `ask`, `agent-sdk run --prod`) carry no principal and pass,
  so a direct chat still answers per `instructions.md`; `instructions.md`
  also travels inline as the cloud turn's AGENTS.md preamble.
- **Rollback is a runbook step, not a redeploy.** Claim keys are unchanged
  and a pending value only gains `sentAt`, but the previous SHA's
  `parseClaim` drops `sentAt`, so it reads a stamped pending as a plain
  one and loses it after `LAUNCH_GRACE_MS` (3 minutes), and its
  `existingAgent` lists by the `factory <KEY>: ` agent name, which an agent
  July started does not carry. A launch in flight across the rollback is
  therefore relaunched through the SDK as a second agent on the same
  ticket, and the first agent's `agent.bound` has no handler on the old
  code, so it leaves no `Implementing:` line either. Before redeploying the
  previous SHA:
  1. **Stop new launches.** Ask the team not to move cards to Approved, or
     pause the Jira automation rule, for the drain.
  2. **Find the in-flight launches.** In the worker's logs, every
     `"outcome":"turn_sent"` line of the last 11.5 minutes
     (`LAUNCH_SENT_GRACE_MS`) with no later `"outcome":"launched"` for the
     same `issueKey` is a pending `implement/<KEY>` claim carrying
     `sentAt`; the ticket is still Approved with no `Implementing:`
     comment. `bound_unnoted` or `bound_threw` lines name an agent that was
     bound but not recorded.
  3. **Drain them.** Wait for each to log `launched` (the binding
     arrived), or, when the deploy cannot wait, open each ticket's agent at
     `cursor.com/agents` and either let it finish and move the card by
     hand, or retire it and move the card back to Approved after the
     rollback so the old code launches it once.
  4. **Then redeploy the previous SHA.** The `implement-agent/<KEY>` record
     the binding wrote survives the rollback as claim data (old code does
     not read the key and never deletes it; `implement-agent/` is in
     `KEY_REGISTRY`), so a later roll forward adopts that agent again
     instead of listing, and the `Recovered by factory-worker` heal picks
     up whatever the drain missed.
  A session the new code started finishes on its own either way; only its
  bookkeeping on the ticket is at stake.

## 4. Secrets per slug

Set them after the slug is `running`. The installation exists only then,
and `secrets set` returns 500 during `deploying`. Names go on the command
line and values on stdin, one per line:

```bash
printf '%s\n' "$FACTORY_REPOS" "$FACTORY_JIRA_PROJECTS" | \
  npx -p @cursor/july@0.2.22 agent-sdk secrets set factory-pr-autofixer FACTORY_REPOS FACTORY_JIRA_PROJECTS
```

| Slug | Required | Optional |
| --- | --- | --- |
| `factory-desk` | `FACTORY_JIRA_PROJECTS`, `FACTORY_REPOS` (review updates), `JIRA_WEBHOOK_SECRET`, `FACTORY_DESK_INTAKE_CHANNEL`, `FACTORY_DESK_SLACK_BOT_TOKEN` (set by the wizard) | `TYPESAFE_API_KEY` (Jev on a filing request before it is filed; unset, the desk's own grok-4.6-fast turn triages it), `FACTORY_DESK_SLACK_HANDLE`, `JIRA_CLOUD_ID` |
| `factory-triage-jira` | `JIRA_WEBHOOK_SECRET` | `TYPESAFE_API_KEY` (host-side Jev judge; unset sends every ticket to the grok-4.6-fast fallback turn), `JIRA_CLOUD_ID`, `FACTORY_JIRA_PROJECTS` (read only on staging) |
| `factory-planner` | `FACTORY_REPOS`, `FACTORY_SANDBOX_REPO`, `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET` | `FACTORY_SANDBOX_REF` (default `main`), `JIRA_CLOUD_ID` |
| `factory-worker` | `FACTORY_SANDBOX_REPO`, `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET` | `FACTORY_SANDBOX_REF` (default `main`), `JIRA_CLOUD_ID` |
| `factory-pr-autofixer` | `FACTORY_REPOS`, `FACTORY_JIRA_PROJECTS` | |
| `factory-security-reviewer` | `FACTORY_REPOS`, `FACTORY_JIRA_PROJECTS` | |

Every slug but `factory-worker` also declares `FACTORY_AGENT_MODEL`,
`FACTORY_AGENT_EFFORT`, `FACTORY_AGENT_SPEED`, and each slug declares the
`FACTORY_STATUS_*` names it reads. Leave
them unset for the defaults: Auto (`auto-smart`, `optimize_for=balanced`)
everywhere except `factory-desk` (every turn) and `factory-triage-jira`
(its fallback triage turn), which default to grok-4.6-fast (`grok-4.6`,
`effort` `high`, `fast` `true`). A set `FACTORY_AGENT_MODEL` from an
earlier pin overrides that default too; clear it on those two slugs.
`factory-worker`'s root model is its implement model (`IMPLEMENT_MODEL`,
`claude-opus-5-5`, context 300k, effort high, fast=false): its one model
turn is the implement cloud turn, and a live July send may carry no
`modelConfig` (`deployment-issues.md` issue 27). The heal's
`Agent.create` sends the same constant. `FACTORY_WORKER_*` are read once
at process start, so they only apply to a local `serve`; hosted v2 binds
secrets per request, after `agent.ts` loads, so they are not hosted
secrets. Any values still set on the slug from earlier releases are
unused.
`factory-desk` and `factory-triage-jira` mount the Jev extension, so both
deploys allowlist `api.typesafe.ai` and expect `TYPESAFE_API_KEY`. Leave these unset on hosted slugs too:
`FACTORY_PLANNER_CHECKOUT` (a local path), `FACTORY_DESK_SLACK_APP_TOKEN`
(local Socket Mode only), and `FACTORY_INPROCESS_PEERS`. Every slug also
declares the optional `FACTORY_OPS_SLACK_BOT_TOKEN` and
`FACTORY_OPS_SLACK_CHANNEL` (the ops failure funnel, section 3; unset,
nothing posts), and `FACTORY_ENV` and `FACTORY_STAGING_ALLOW_PRODUCTION`. Leave the last two
unset on the production slugs ([section 10](#10-staging-slugs)). A
production deploy lists them in its "secrets declared but not set"
warning; that is expected. If you do set `FACTORY_ENV` on a production
slug, the only safe values are `production` or `prod`. Any other value makes
the slug staging, and it then refuses TLSSN, marsbank, and
`#mars-eng-intake`.

Every slug also declares `OTEL_EXPORTER_OTLP_HEADERS`, optional: set it to
send traces, metrics, and logs to Grafana Cloud, as
[section 11](#11-opentelemetry-export-grafana-cloud) describes (the
endpoint is in code); unset, nothing is exported.

The non-secret values here are the ones in section 1: repository
`cursor-demo-lab/marsbank`, ref `main`, project `TLSSN`, intake channel
`C0EXAMPLE1`. Each Automation rule's header must match its own slug's
`JIRA_WEBHOOK_SECRET`.

Since 0.2.11, GitHub, GitLab, and Bitbucket channel credentials are
referenced by name, `{ secretName: "NAME" }`, never as a literal or a
`process.env` getter: the env var of that name locally, the deployment
secret of that name when hosted. The factory's GitHub channels use
`cursorAccount` and the team's GitHub App, so they name no SCM secret
today. If one is ever added, set it with `agent-sdk secrets set <slug>
NAME` and put only the name in the code and the docs.
`agent-sdk secrets list <slug> --team <CURSOR_TEAM_ID>` shows the names set.

The lists come from `hosting.secretNames` in each `agent/agent.ts`, plus
`TYPESAFE_API_KEY` from triage's Jev extension. `agent-sdk info --dir
<project> --json` prints them. triage-jira declares
`FACTORY_JIRA_PROJECTS` but reads it only on a staging slug, as its
allowlist ([section 10](#10-staging-slugs)). Production triage ignores it.

## 5. Smoke test after a deploy

This is the known-good path from Slack intake to Done: README
[Rehearse](../README.md#rehearse), drawn step by step in
[`html/e2e.html`](html/e2e.html).

1. `agent-sdk deployments` lists six `running` v2 applications.
   `agent-sdk deployment <slug>` shows `watching: cursor-demo-lab/marsbank`
   on the five GitHub slugs and lists the required secret names.
2. Each Automation URL answers `202` to
   `curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' <URL>`. That is
   an ingress receipt only.
3. `@Factory hello` in `#mars-eng-intake` gets a reply.
4. File a concrete bug with a symptom and the expected behaviour:
   `@Factory file a bug: <symptom>; expect <behaviour>`, then
   `approve file` (or ✅ on the filing prompt). The thread gets the key
   and URL.
5. Within a minute or two, `KEY is Triaged: …`, posted once per verdict
   (#125). A second delivery of the same transition posts nothing (#133
   settle). Several minutes later, `KEY is planned`, or one Needs info
   line saying what the planner searched, which is not a stall. Do not
   `plan KEY` or replay while you wait: each extra entry into Triaged
   starts another planner run. If nothing lands, the desk's plan hop
   watch posts `KEY still has no plan N minutes after it went to the
   planner` after 15 minutes. Then `retry KEY` starts a fresh
   run (#132).
6. `approve KEY` in the thread (or ✅ on the plan post), as the person
   who filed it. A ✅ reaction on a typed command,
   then `KEY is In Progress. Implementation started: <url>`. If no
   implementation starts within 7 minutes, the launch hop watch says so.
   The worker relaunches a lost launch itself at about 4 minutes first.
   `retry KEY` redelivers the approval, and the worker never
   starts a second agent.
7. The cloud agent pushes its `KEY-…` branch on marsbank and the worker
   opens the PR from it, ready for review, then moves the card to In
   Review (`factory-worker/agent/lib/implement-pr.ts`). A PR that still
   arrives a draft the worker marks ready on the `opened` delivery, before
   it moves the card to In Review. Bugbot skips
   drafts, so this is what makes Bugbot run (#126). The GraphQL
   `markPullRequestReadyForReview` call names its repo in
   `x-cursor-github-repos`. Without that header, hosted github-proxy
   answers 400, which is why marsbank#28 stayed draft before #130. The
   thread says `KEY is In Review: cursor-demo-lab/marsbank#N is open`.
   A `KEY: waiting on Bugbot, security, CI…` crumb names the gates still
   pending (#128), and emoji-prefixed `KEY review update on <sha>: …`
   lines follow as Bugbot,
   CI, change-monitor, and a fixer push settle (#127). The security line
   posts only when the verdict or scope fingerprint changes (#129), so a
   harmless push that keeps CLEAN adds no second 🔒✅. The reviewer
   still posts its GitHub review on every head. A red check wakes the
   fixer. No review updates after several minutes means the desk was
   deployed without `--cursor-events-repo` or `FACTORY_REPOS`.

   If the PR stays draft, the worker has already retried three times in
   the task and retries again on the task's redelivery and on every
   `synchronize` or `edited` delivery. The ticket gets one Jira comment,
   `Ready for review not marked on <repo>#<n>: … (<reason>, HTTP <status>)`.
   That comment is the durable evidence; `agent-sdk logs --prod --slug
   factory-worker --team <CURSOR_TEAM_ID>` shows the attempts. Push once to retry, or mark the PR ready by hand. A PR that
   a person converts back to draft stays draft: the worker records that
   choice and does not undraft it again.
8. A person merges the PR. The thread says
   `KEY is Done: cursor-demo-lab/marsbank#N was merged by <login>`.

For a ticket filed directly in Jira (no Slack filing), create a concrete
TLSSN issue in Jira. When triage moves it to Triaged (or writes
`Triage stopped:`), the desk opens an intake root in `#mars-eng-intake`.
It needs `FACTORY_DESK_INTAKE_CHANNEL`; without it nothing posts.
The Triaged line, planner crumb, plan, and early failures reply under it,
and the root takes the same ⏳ / 📝 / 🛠️ / 🔍 / ✅ reactions a filer's
message does. The ticket gets one `Slack thread: <root permalink>`
comment, which becomes the implement PR's `Slack:` line (#131). Approval
for such a ticket stays in Jira: move the card to Approved. `retry KEY`
needs a Slack filer too, so recover a stalled Jira-filed hop from the
board (back to Triaged to replan, or Planned then Approved to relaunch);
the hop-watch line in that thread names the move.
Until the
root exists no triage hop watch is armed, so a Jira filing whose triage
never runs is still silent
([`event-driven-factory.md`](event-driven-factory.md#hop-watchdogs-a-stalled-hop-is-announced)).

Pass bar: every stop ends in a thread line that says why and what to do
next, or, for a hop that wrote nothing at all, a hop-watch line within
its deadline (triage and plan 15 minutes, launch 10). When one does not,
read the "You see" table in
[operator checklist](jira-automation.md#operator-checklist) step 7, then
README [When it does not work](../README.md#when-it-does-not-work).
`node scripts/e2e-drive.mjs` asserts the chain by signed replay, which
does not prove that Automation delivered the events.

## 6. Logs

```bash
S="npx -y -p @cursor/july@0.2.22 agent-sdk"
$S logs --prod --slug factory-desk --team <CURSOR_TEAM_ID>                # follow recent sessions
$S logs --prod --slug factory-desk --team <CURSOR_TEAM_ID> --once --json  # print once, as JSON
$S session ses_... --prod --slug factory-desk --team <CURSOR_TEAM_ID>     # one session
```

Without `--session`, `logs` follows the slug's recent sessions; `--once`
prints and exits. Slack channel lines start with `[bdk/slack]`.

Hosted timers: on July 0.2.11 each `factory-desk` pod boot logged
`platform timer upsert failed for schedule "hop-watch": platform timers
require CURSOR_API_KEY`. From 0.2.13 the schedule is declared in the
deploy manifest and the guest no longer syncs it, so that line should be
gone ([BDK 0.2.13 upgrade](#bdk-0213-upgrade)). Each boot still logs
`reminders: control-plane list failed`. That is July reading reminders
before any request bound the pod credential (per request, `consumeHostedBoundSecrets`
sets `CURSOR_API_KEY` from the bound file if unset, then removes the file;
`dist/internal/cursor/hosted-bound-secrets.js`), not a missing secret;
July ignores any `CURSOR_*` host secret, and the reminders API refuses a
user key.
The hop watchdog runs on per-ticket reminders created inside requests, the
`hop-watch` schedule (July 0.2.13 declares it in the deploy manifest as a
5-minute `run` schedule, and the guest runs it), and a sweep that desk
admissions run about once every five minutes; a hop line any of them posts
is claimed once. Every schedule run logs one
`{"desk":"hop_watch","via":"schedule","due":N,"fired":M}` line, even with
nothing due, so that line every five minutes shows the schedule fires. Grep
`"desk":"hop_watch"` for `armed` outcomes and fired lines
([factory-desk README](../factory-desk/README.md), "Hosted timers").
The plan hop also runs a start check 4 minutes after each Triaged entry
(`plan_start` reminder, same sweeps): when the planner left no `Planning
started:` marker, plan, or outcome for the entry and the ticket is still
Triaged with no triage gate, the desk re-sends it to the planner once, as
`retry KEY` would, and the thread hears `KEY's planning hasn't started 4
minutes after it went to the planner, so I've sent it to the planner
again.`; when the retried entry does not start either, the thread hears
`KEY's planning still hasn't started after one automatic retry, so planning
couldn't start. The next step is a planner redeploy or asking ops; …`.
Grep `"desk":"plan_start_watch"`: a healthy run logs `"result":"armed"`
at the entry and `"result":"started"` four minutes later (`via` is `arm`,
`reminder`, or `sweep`); `retried`, then `final`, is the TLSSN-60 shape
([`deployment-issues.md`](deployment-issues.md), issue 28). **Runbook for
the final line: redeploy the planner at the same ref** (`agent-sdk deploy
--dir planner --ref <current ref>`); a retry inside the same release can hit
the same control-plane bug, and a redeploy is what recovered TLSSN-60. Then
`retry KEY` in the thread (or To Do and back to Triaged on the board) starts
the run.
`setTitle not-ok error=no_permission` was July titling a channel thread
before its agent session existed. The desk now opens the session first, so
if the line persists, check the app's Agents feature
([`slack-and-github-setup.md`](slack-and-github-setup.md#troubleshooting)).
`sessions --prod` still refuses v2 slugs. The ticket, the Slack thread,
and the pull request stay the product evidence.

`factory-worker` handles Jira in host code, so `logs --prod` shows none of
its decisions. Its one model session per ticket is the implement agent's
cloud turn (`sessions --prod` still refuses v2 slugs), and its record is
on the ticket:
every verified Approved delivery either launches (`Implementing: <url>`)
or leaves `Launch failed:`, `Launch pending:`, `Launch skipped:`, or
`Approved without a plan` there. A ticket in Approved with none of those
lines after a few minutes never reached the worker. Check the worker's
Jira rule audit log, then `retry KEY`.

With the OTel header set, every delivery, reminder, schedule, and
cloud-agent launch on all six slugs is a trace in Grafana Cloud, and the
worker's `{"worker":"decision",…}` lines are logs there, sessions or not ([section 11](#11-opentelemetry-export-grafana-cloud)):
`{ resource.service.name = "factory-worker" && span.factory.ticket.key = "TLSSN-123" }`
in Explore shows the worker's decision for that ticket, and the implement
session's `agent_sdk.turn` span and token and turn-count samples
carry the same key (the worker's `agent/hooks/ticket-key.ts` reads it from
the session's `implement:<KEY>#<changelogId>` continuation token).

## 7. Slack prerequisites

Full app and GitHub setup: [`slack-and-github-setup.md`](slack-and-github-setup.md).

- The Factory Slack app needs the `reactions:read` scope and the
  `reaction_added` event, on top of mentions and messages. Reinstall the
  app when Slack asks for the new scope, then redeploy the desk.
- Approvals are ✅ / ❌ reactions on the desk's filing prompt and plan
  post, or the typed commands. There are no buttons or cards.
- A new request starts with `@Factory` in `#mars-eng-intake`
  (`C0EXAMPLE1`) or a DM. Plain replies in a factory thread need no
  mention.

## 8. Models

From `factoryModel()` in each project's `agent/lib/factory-model.ts`:

- Default on every host: Auto, `auto-smart` with `optimize_for=balanced`.
- `factory-desk` (every turn) and `factory-triage-jira` (its fallback turn)
  use grok-4.6-fast (`grok-4.6`, `effort` `high`, `fast` `true`).
- `factory-worker` runs its implement model (`IMPLEMENT_MODEL`, section
  4) as its root model and reads no `FACTORY_AGENT_*`.
- Jev triages a filing request before it is filed, so the filing prompt
  shows the verdict. Without `TYPESAFE_API_KEY`, or when Jev is unsure,
  the desk's grok-4.6-fast turn triages it.

`FACTORY_AGENT_MODEL`, `FACTORY_AGENT_EFFORT`, and `FACTORY_AGENT_SPEED`
override the host model (section 4).

## 9. Automations as code (cursor-agent + YAML)

The repo root holds one Cursor Automation per factory host in
the old monorepo `.cursor/automations/` (not included in this snapshot):
`factory-desk.yaml`, `factory-triage-jira.yaml`, `factory-planner.yaml`,
`factory-worker.yaml`, `factory-pr-autofixer.yaml`, and
`factory-security-reviewer.yaml`. Each is the same event wiring as its
host, written as Automations config-as-code: Jira rules map to a
`webhook: {}` trigger, the desk's Slack intake to `slackMention`,
`slackReactionAdded` (`white_check_mark`, `x`), and `slackTrigger`, and
the reviewer and fixer to `git` triggers on `cursor-demo-lab/marsbank`.
The prompt tells the run to read that host's `AGENTS.md` from the
checkout and follow it. The model is `claude-opus-5-5` at `effort` `low`.

Two out-of-the-box templates sit beside them, also `enabled: false`:
`find-vulnerabilities.yaml` (the "Find vulnerabilities" template on marsbank
PRs, overlapping the live security-reviewer host) and `find-bugs.yaml`
("Find critical bugs", a daily bug hunt that opens fix PRs; not Bugbot).
Bugbot (`.cursor/BUGBOT.md` plus its dashboard), the managed Security
Reviewer, and change monitor are turned on in the dashboard; they have no
YAML form. Why:
[Out-of-the-box automations](cursor-agent-automations.md#out-of-the-box-automations-bugbot-security-review-change-monitor).

The live factory is still the six hosted `@cursor/july` 0.2.22 slugs
above. The YAML files ship `enabled: false`, so deploying them next to
the live hosts cannot handle the same event twice. Enable one only when
it replaces the matching host, or shadows it pointed at another channel
or repository. A disabled deploy still creates the record, so
`validate`, `get --yaml`, and `test` work. Do not enable the YAML
automations as part of this upgrade.

Run from the repo root, signed in as a real user (Slack and PR actions
act through the deploying owner's connections):

```bash
cursor-agent automations validate .cursor/automations/factory-desk.yaml
cursor-agent automations deploy   .cursor/automations/factory-desk.yaml
cursor-agent automations list --managed-by ANY --format text
cursor-agent automations get factory-desk --yaml
cursor-agent automations test factory-desk --trigger slack --payload '{"message":"@Factory file a bug: ..."}'

for f in .cursor/automations/factory-*.yaml \
         .cursor/automations/find-vulnerabilities.yaml \
         .cursor/automations/find-bugs.yaml; do
  cursor-agent automations validate "$f" && cursor-agent automations deploy "$f"
done
```

`agent` is the same binary. The `automations` command exists only when
the `automations_config_as_code` gate is on for the account; if
`cursor-agent automations --help` prints only the main help, it is off.
Field reference, trigger mapping, and the webhook URL for Jira rules:
[`cursor-agent-automations.md`](cursor-agent-automations.md).

## 10. Staging slugs

A staging slug runs the same code at the same ref as its production slug,
under the name `<slug>-staging`: `factory-desk-staging`,
`factory-triage-jira-staging`, `factory-planner-staging`,
`factory-worker-staging`, `factory-pr-autofixer-staging`, and
`factory-security-reviewer-staging`. The KV plan's Phase 0 probes run on
their own `factory-kvprobe-staging` the same way. Nothing here is
deployed until an operator runs these commands.

### What keeps staging apart

| Surface | Production | Staging | How it stays apart |
| --- | --- | --- | --- |
| KV and files | per slug | per slug | Separate by credential. The v2 store (`storage-backends/cursor-hosted-v2.js` in July 0.2.13, unchanged since 0.2.11) is called only with the slug's own pod credential, and "the API resolves the caller's deployment from it" (`internal/cursor/cursor-api-transport.js`). So `<slug>-staging` should start empty and not read a production claim. The scoping itself is enforced server-side, where the client source cannot show it |
| Slack | app `Factory`, `#mars-eng-intake` (`C0EXAMPLE1`) | its own app from the v2 wizard for `factory-desk-staging`, its own channel | Separate bot token per slug. The staging bot is invited only to the staging channel. With `FACTORY_ENV=staging`, a mention, DM, post, or reaction in `C0EXAMPLE1` reaches no desk handler, and neither that id nor `#mars-eng-intake` (with or without `#`) is accepted as `FACTORY_DESK_INTAKE_CHANNEL`. The Slack manifest itself is the same as production's (below) |
| Jira | project `TLSSN`, five rules to the production aliases | a staging project, five rules to the staging aliases | One delivery source per slug (section 2). Each staging slug has its own `JIRA_WEBHOOK_SECRET`. `FACTORY_ENV=staging` drops `TLSSN` from every project list. The desk refuses any Jira move, comment, or label outside its staging projects before calling the connector. Staging triage ignores a `TLSSN-*` issue |
| GitHub | `cursor-demo-lab/marsbank` | a staging sandbox on `cursor-demo-lab` | `--cursor-events-repo` names the staging sandbox. `FACTORY_ENV=staging` drops `cursor-demo-lab/marsbank` from `FACTORY_REPOS` and refuses it as `FACTORY_SANDBOX_REPO` |

`FACTORY_ENV` is read from `agent/lib/factory-stage.ts`, which is the same
file on all six hosts. Unset, `production`, or `prod` means production,
which is every live slug today. Any other value is staging, so a typo fails
closed. On staging, each production target above is dropped wherever the
hosts read their scope, and the hosts then treat it as out of scope.

On staging, an empty list never means "all". A repository list emptied that
way throws on the planner, worker, autofixer, and reviewer, with a message
naming both switches. The desk's review-update scope (`reviewRepos`)
becomes an empty list instead, so the desk reports on no pull request. A
Jira project list emptied that way (or never set) accepts no project.

On staging, the check runs inside each host's Jira, GitHub, and Slack
helpers, not only at its routes. A key, repository, pull request, or
channel is refused whether it comes from the delivered event, a comment's
text, a request body, the session, or the model's input. A refusal reads and
writes nothing, and answers `staging_refuses_production` (or
`project_not_allowed` on a delivery route).

| Host | Guarded on staging |
| --- | --- |
| factory-desk | Every Jira write (`move`, `addComment`, `planDeclinedLabel`, the shared `setIssueType`, and `createIssue`, which takes only a staging project). `gateCommand` refuses a production key before any read, which covers `request_plan`, `approve_ticket`, and `deny_ticket`. Status and comment deliveries check the issue key and `project.key`. All Slack handlers drop production channels. `ticketPost` ignores a binding to a production channel. |
| planner | Status deliveries check the issue key and `project.key`. Comment deliveries check the delivered issue and a `Plan requested: KEY` key. The `plan` route and `plan_issue`. `readTicket`, `issueStatus`, `transitionIssue`, and `transitionFrom`. `commentOnTicket` already allows only listed projects. |
| triage-jira | `record_triage` refuses before anything else when the key from the session or the model is refused, and the triage-outcome hook reports nothing for one. Tracker helpers: `actuate` (including its duplicate match, which never names or comments on a ticket outside the staging projects), `commentOnIssue`, `transitionIssue`, `issueStatus`, `transitionFrom`, the desk-filed ticket read, and the shared `projectIssueTypes` and `setIssueType`. The planner handoff (`plan_issue`) and the inbound wake (`triageWake`, plus the webhook and queue routes). |
| factory-worker | `decideApproved` checks the key and `project.key`. `readComments`, `addComment`, `transitionIssue`, `issueStatus`, and `transitionFrom` allow only its staging projects. `markReadyForReview` and `launchImplementation` refuse the production repository. The implement PR's repository is `sandboxRepo()`, which refuses marsbank. |
| pr-autofixer | `startDrive` refuses the production repository for every drive (`drive_pr`, the drive route, a red check, a comment). The Bugbot-cap PR comment is skipped for it. |
| security-reviewer | `post_findings` posts no review on the production repository. |

On staging, triage-jira uses the same allowlist as the other hosts. It acts
only on a full Jira key (`TLSTG-12`: letters, a dash, digits) whose project
is in its `FACTORY_JIRA_PROJECTS`. It refuses anything else before any
connector call: a production key, a numeric issue id such as `10047` (which
names no project), a lowercase or padded key, or any key when the list is
empty. On production, triage-jira still reads no project list and triages
whatever its own signed rule delivers.

One path is not guarded by code. triage-jira attaches the `Factory
Atlassian` connector to its model (`agent/mcp-connections/tracker.ts`), so a
staging triage turn could call Jira tools directly. The other hosts keep
Jira in `agent/host-connections/`, off the model. Host guards cannot see a
model's own MCP calls. A per-stage connection is not possible on July
0.2.13, because connections load at boot, before `FACTORY_ENV` is bound.
Moving triage's connector off the model would change production triage and
its per-slug Atlassian consent, so it is left for a change tested on a
staging slug first. For a triage turn started by its own rule, three things
hold:
- The turn starts only for an issue its own rule delivered and the project
  guard passed.
- Its prompt names only that issue, and its instructions route every write
  through `record_triage`.
- `record_triage` refuses production keys and numeric ids.

That does not cover a session opened some other way, such as the slug's
HTTP API or playground, where anyone who can reach the slug writes the
prompt. **Do not deploy `factory-triage-jira-staging` until one of these is
true:**
- triage-jira's tracker connector has moved to `agent/host-connections/`,
  tracked as a follow-up in the K16 pull request.
- The staging slug's Atlassian identity can reach only the staging project
  (TLSTG), not TLSSN.

The other five staging slugs do not depend on this.

On production, an empty project list still accepts every project, project
keys compare exactly as before, and every guarded path is unchanged.
`node scripts/doctor.mjs` fails its `stage` check when a staging
environment still names a production target in any of these variables,
per-host overrides included: `FACTORY_REPOS`, `FACTORY_SANDBOX_REPO`,
`PR_AUTOFIXER_REPOS`, `SECURITY_REVIEWER_REPOS`, `FACTORY_JIRA_PROJECTS`,
`FACTORY_DESK_JIRA_PROJECT`, `FACTORY_PLANNER_JIRA_PROJECTS`,
`PR_AUTOFIXER_AUTO_DRIVE_PROJECTS`, `FACTORY_DESK_INTAKE_CHANNEL`.

The guards run per request. Hosted v2 binds deployment secrets into
`process.env` at the top of each request (July
`internal/cursor/hosted-bound-secrets.js`: the control plane "cannot set
the already-running July process's environment"). Nothing read when the
engine boots can see `FACTORY_ENV`, and that includes the manifest the
control plane reads at provision. So the desk's Slack manifest subscribes
channel posts in `C0EXAMPLE1` and `#mars-eng-intake` on staging too. No
input July 0.2.13 honours at provision (slug, ref, or environment) could
select a different list without a second agent directory. The staging bot
is not a member there, and any post that does arrive is dropped by the
per-request guard. The staging channel gets no channel-post subscription,
so a plain reply there never reaches the desk: mention the staging bot, or
DM it. Staging copy already writes the mention.
The GitHub channels' repository lists at boot are likewise empty on
staging, as on a first production boot, so `--cursor-events-repo` is what
scopes their events.

To let a staging run touch a production target on purpose, name it in
`FACTORY_STAGING_ALLOW_PRODUCTION` (comma-separated, for example `TLSSN` or
`cursor-demo-lab/marsbank`). The doctor warns while any are allowed. Remove
them when the run is over.

### Once per staging environment (ops)

| What | Suggested value | Notes |
| --- | --- | --- |
| Sandbox repository | `cursor-demo-lab/marsbank-staging` | On `cursor-demo-lab`, so the team's `cursor` installation (`155310938`) covers it. CI workflow, Bugbot on, auto-merge off, as on marsbank |
| Jira project | a new key on `example.atlassian.net`, for example `TLSTG` | The same seven statuses with global transitions. Never reuse `TLSSN` |
| Slack channel | a new private channel, for example `#mars-eng-intake-staging` | Invite only the staging bot. Record its `C…` id |
| Slack app | wizard for `factory-desk-staging`, name `Factory Staging` | Below. A separate app, so a staging token can never post as the production bot. A copied production token is caught twice. `node scripts/doctor.mjs` with the staging values fails its `slack-app` check when the bot token belongs to the production app (`A0EXAMPLE1`). A staging desk that finds the production app behind its token (`auth.test`, then `bots.info`) takes no Slack event, Jira delivery, or review wake, and logs `"desk":"staging_refused","slackApp":"A0EXAMPLE1"` on stderr |
| Ops bot (optional) | a separate Slack app with `chat:write` only | `FACTORY_OPS_SLACK_BOT_TOKEN`, for Phase 0 summaries and the ops failure funnel. With `FACTORY_OPS_SLACK_CHANNEL`, every slug's ops failure funnel posts through it (section 3, KV Phase 1 K7); both optional, and unset means no post. The doctor warns if it is the desk's token |

### Deploy

Same credential and preflight as section 3. Deploy in the same order.
Pass the staging sandbox, never marsbank, as the events repository.

```bash
REF=$(git rev-parse HEAD)                  # full 40-char SHA, already pushed
S="npx -y -p @cursor/july@0.2.22 agent-sdk"   # CURSOR_API_KEY stays as checked in section 3
STAGING_REPO=cursor-demo-lab/marsbank-staging
$S deploy --ref $REF --dir triage-jira       --slug factory-triage-jira-staging       --cursor-events-repo $STAGING_REPO --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir planner           --slug factory-planner-staging           --cursor-events-repo $STAGING_REPO --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir factory-worker    --slug factory-worker-staging            --cursor-events-repo $STAGING_REPO --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir factory-desk      --slug factory-desk-staging              --cursor-events-repo $STAGING_REPO --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir pr-autofixer      --slug factory-pr-autofixer-staging      --cursor-events-repo $STAGING_REPO --team <CURSOR_TEAM_ID>
$S deploy --ref $REF --dir security-reviewer --slug factory-security-reviewer-staging --cursor-events-repo $STAGING_REPO --team <CURSOR_TEAM_ID>
```

A staging slug can run alone. For example, a planner rehearsal needs only
`factory-planner-staging` and its one Jira rule. Deploy only the slugs the
run needs.

### Secrets

Set them once each slug is `running`. The hosts read them per request, from
the secrets the control plane binds before each delivery. Whether a changed
secret reaches a pod that is already running, without a redeploy, is
unproven: that is the KV plan's gate G7. Until G7 passes, deploy each slug
again after setting or changing a secret, the same as in production
(section 3), and set `FACTORY_ENV` before the Slack app or any Jira rule
can deliver to the slug.

```bash
S="npx -p @cursor/july@0.2.22 agent-sdk"
STAGING_REPO=cursor-demo-lab/marsbank-staging
for slug in factory-triage-jira-staging factory-planner-staging factory-worker-staging \
            factory-desk-staging factory-pr-autofixer-staging factory-security-reviewer-staging; do
  printf '%s\n' staging | $S secrets set $slug FACTORY_ENV --team <CURSOR_TEAM_ID>
done
printf '%s\n' "$STAGING_REPO" "$STAGING_REPO" TLSTG | \
  $S secrets set factory-planner-staging FACTORY_REPOS FACTORY_SANDBOX_REPO FACTORY_JIRA_PROJECTS --team <CURSOR_TEAM_ID>
```

The rest are set as in section 4, with staging values:

| Slug | Staging values |
| --- | --- |
| every staging slug | `FACTORY_ENV=staging`. Leave `FACTORY_STAGING_ALLOW_PRODUCTION` unset |
| `factory-desk-staging` | `FACTORY_JIRA_PROJECTS` = the staging key, `FACTORY_REPOS` = the staging sandbox, `FACTORY_DESK_INTAKE_CHANNEL` = the staging channel id, its own `JIRA_WEBHOOK_SECRET`. `FACTORY_DESK_SLACK_BOT_TOKEN` comes from the wizard |
| `factory-triage-jira-staging` (see the connector warning above before deploying it) | `FACTORY_JIRA_PROJECTS` = the staging key, its own `JIRA_WEBHOOK_SECRET` |
| `factory-planner-staging`, `factory-worker-staging` | `FACTORY_SANDBOX_REPO` = the staging sandbox, `FACTORY_JIRA_PROJECTS` = the staging key, its own `JIRA_WEBHOOK_SECRET`. The planner also needs `FACTORY_REPOS` |
| `factory-pr-autofixer-staging`, `factory-security-reviewer-staging` | `FACTORY_REPOS` = the staging sandbox, `FACTORY_JIRA_PROJECTS` = the staging key |

Check the same values locally before a staging session:

```bash
FACTORY_ENV=staging FACTORY_REPOS=$STAGING_REPO FACTORY_SANDBOX_REPO=$STAGING_REPO \
  FACTORY_JIRA_PROJECTS=TLSTG FACTORY_DESK_INTAKE_CHANNEL=<staging channel id> node scripts/doctor.mjs
```

The `stage` line must read `ok   FACTORY_ENV staging, no production target configured`.
With the staging desk's `FACTORY_DESK_SLACK_BOT_TOKEN` in the same shell, the
`slack-app` line must name the staging app, not `A0EXAMPLE1`.

### Slack app and Jira rules

Run the v2 wizard for the staging slug only. It creates a separate app
because the slug differs. Never run it with `"slug":"factory-desk"` for
staging. Add `"force":true` only to redo the staging app itself.

```bash
curl -s -X POST https://api.cursor.com/internal/agentsdk/slack/wizard \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"teamId":<CURSOR_TEAM_ID>,"slug":"factory-desk-staging","env":"prod","architecture":"v2","envPrefix":"FACTORY_DESK","name":"Factory Staging"}'
```

Invite the staging bot to the staging channel only. The Factory Atlassian
consent is per slug, so authorise the four Jira staging slugs as in
section 3. Create the five rules of section 2 in the staging project,
pointing at each staging slug's `engineAlias`, with that slug's
`JIRA_WEBHOOK_SECRET`. Never add a staging URL to a TLSSN rule, and never
point a staging rule at TLSSN.

### Verify and tear down

1. `agent-sdk deployment <slug>-staging --team <CURSOR_TEAM_ID>` reports `running`
   and `watching: cursor-demo-lab/marsbank-staging`, not marsbank.
2. `agent-sdk secrets list <slug>-staging --team <CURSOR_TEAM_ID>` lists `FACTORY_ENV`.
3. Run the section 5 smoke test in the staging channel and project. Nothing
   appears in `#mars-eng-intake`, on a TLSSN card, or on marsbank.
4. The refusal itself, from a delivery's HTTP response. `agent-sdk logs
   --prod` tails session output only, and a refused delivery starts no
   session, so the refusal never appears there. The hosted alias answers
   every delivery with the control plane's 202 before the handler runs, so
   check against a local serve of the same ref with the staging values. The
   local serve must be signed in as in section 3, because of the Atlassian
   connection. Use a TLSSN key that does not exist:

   ```bash
   export JIRA_WEBHOOK_SECRET=local-check
   FACTORY_ENV=staging FACTORY_JIRA_PROJECTS=TLSTG npx -p @cursor/july@0.2.22 agent-sdk serve --dir planner --dev &
   node scripts/replay-jira-transition.mjs http://127.0.0.1:3000/planner/v1/channels/webhook/ TLSSN-999999 Triaged --from "To Do"
   ```

   The reply is `HTTP 200` with `{"ok":true,"ignored":true,"reason":"project_not_allowed","via":"status"}`.
   A comment delivery (`scripts/replay-jira-comment.mjs`) answers with
   `"via":"comment"` instead. The desk's `/factory-desk/v1/channels/jira/`
   answers `{"ok":true,"ignored":true,"reason":"project_not_allowed"}`, with
   no `via` field. Staging
   triage answers a created `TLSSN-*` issue with
   `{"ok":true,"ignored":true,"reason":"staging_refuses_production"}`.
   `planner/agent/channels/webhook.staging.test.ts`,
   `factory-desk/agent/channels/jira.staging.test.ts`, and
   `triage-jira/agent/lib/staging-issue.test.ts` pin these answers for the
   replay script's own signed body. On the hosted slug, a replay of that key
   must leave nothing on TLSSN or in `#mars-eng-intake`.

Redeploy a staging slug with its own line from the block above. A
production redeploy never touches it. `agent-sdk delete <slug>-staging
--team <CURSOR_TEAM_ID>` tears one down. Only ever pass a `-staging` slug to
it. Deleting a staging slug should take its KV with it, but the client
source cannot confirm that: treat a recreated slug's KV as unknown until it
is read. Its engine alias changes when it is recreated, so update its
staging rule URL.

## 11. OpenTelemetry export (Grafana Cloud)

All six slugs send traces, metrics, and logs to Simon's Grafana Cloud
stack, `https://<GRAFANA_STACK>.grafana.net/`, through its OTLP gateway.
The endpoint is not a secret and is in code
(`GRAFANA_OTLP_ENDPOINT` in `agent/lib/factory-otel.ts`); the only secret
is `OTEL_EXPORTER_OTLP_HEADERS`, the auth header. It is the switch: with it
unset no exporter is built, no collector is contacted, and outbound
requests carry no trace context. This shows what `logs --prod` cannot: a
Jira or GitHub delivery, reminder, or schedule that starts no session
writes no session log, by design in July 0.2.18.

### How each signal leaves a hosted pod

Hosted v2 starts each pod from a frozen snapshot before any deployment
secret exists, and copies the secrets into `process.env` per request (July
`dist/internal/cursor/hosted-bound-secrets.js`). July builds its OTel
runtime once, at startup (`dist/internal/server.js`).

- **The factory's spans** (`factory.*`) go through a tracer provider the
  factory owns (`agent/lib/factory-otel-signals.ts`). Until Bug 6b it was
  never registered globally, because a global one makes July skip its own;
  that is now the point: an approved exception (Bug 6b) registers it as the
  global one, so July's spans use it too (next item). A batch
  processor queues them into one cached exporter whose endpoint and header
  are read at export time. Each delivery's outermost factory span ends,
  then flushes spans, metrics, and logs together before the handler
  returns, so before the hosted reply. Spans are not recorded at all while
  the header is unset. Every `factory.*` span starts as a **new root**, in a
  trace of its own, with a **link** to the span active when it starts
  (July's `agent_sdk.http`, the inbound request). July samples with
  `ParentBased`, and Cursor's backend leaves about 96% of inbound requests
  unsampled (an audit of the logs found all 66 trace ids missing from Tempo
  with no trace `flags` and all 5 stored ones with `flags=1`); a child of an
  unsampled parent is never recorded, so before this the factory's spans
  vanished with it. Spans nested in a factory span, its logs, and its
  outbound `fetch` carry the new trace id, sampled.
- **July's own spans** (`agent_sdk.http`, `agent_sdk.turn`,
  `agent_sdk.tool`, `agent_sdk.subagent`, and the MCP client spans) are
  July's, recorded on the factory's global tracer provider (Bug 6b, an
  approved exception to "July's spans leave as July emitted them"; the
  ownership change only). `agent/otel.ts` is a `defineOtel(() => …)`
  resolver (`@cursor/july/internal/otel`, the only export of it in 0.2.22);
  loading it registers an AsyncLocalStorage context manager and the
  factory's tracer provider globally. The resolver hands July a dummy
  dummy exporter whose `includes` matches no signal (`defineOtel` rejects `signals: []`), so 0.2.22 builds no local tracer (it would
  otherwise keep one with headers frozen at `startServer`) and uses
  `trace.getTracer()` — the factory's. July's
  spans then share the factory's batch processor, exporter, sampler, ids
  (`factoryIdGenerator`), and export resource (which sets the
  `cursor.surface` and `cursor.entrypoint` July's own resource did); names, attributes, and events
  are July's. Without the exception, with no trace exporter at startup,
  July would record spans in memory (at most 2048, a `SimpleSpanProcessor`)
  and post them from `flushDeferred` after each hosted delivery, where two
  overlapping flushes drop a turn span (`july-otel-upstream.md` sections 4
  and 12). That path returns only if another provider took the global slot
  first, which logs `{"otel":"global_provider_taken","tracer":false,…}`.
  Whether a span is recorded depends on the span it starts under (the
  factory's sampler is `ParentBased` like July's, recording every root
  while the header is set):
  - `agent_sdk.http` is a child of the inbound request's span, so it is
    recorded only when Cursor's backend sampled that request (about 4%).
  - `agent_sdk.turn` starts from the root context (`otel/collector.js`
    `openTurn`), so every session turn is recorded whatever the inbound
    flag, with its `agent_sdk.tool` and `agent_sdk.subagent` children.
  - A **host MCP call** (`host.mcp`: `mcp-host.js` through `otel/mcp.js`
    `runMcpClientSpan`) starts a CLIENT span under the active span. Under an
    unsampled `agent_sdk.http` and outside a factory span it is not
    recorded. **Inside a factory span it is**: the factory span is sampled,
    so the MCP span is its child, in the factory's trace, and the
    delivery's factory flush sends it. The Jira handlers do this (`host.mcp` inside
    `factory.delivery` or `factory.background`, for example
    `planner/agent/channels/webhook.ts`,
    `triage-jira/agent/channels/webhook.ts`,
    `factory-worker/agent/channels/jira.ts`, and the desk's `announce.ts`).

  July's own reply-path flush (`forceFlush`) flushes only providers July
  built, so it sends none of these. A session turn's spans leave on the
  factory flush the reply waits for (see "A session turn's end" below), an
  MCP span inside a factory span on that delivery's flush, and a sampled
  `agent_sdk.http`, which ends after both, on the factory's 300 ms
  `TRACE_DELAY_MS` timer or the next factory flush (lost if the pod is
  frozen first; see "Latency, loss, and the kill switch").

  One attribute on July's spans is the factory's, by an approved exception
  to the "July's spans leave as July emitted them" rule: `factory.ticket.key`.
  Each host that runs model turns (desk, planner, triage, fixer, reviewer)
  has an `agent/hooks/ticket-key.ts` that resolves the session's Jira key
  on `turn.started` (desk: the Slack thread's filed ticket from its kv
  binding, re-tagged mid-turn by `file_ticket` itself, which calls
  `tagSessionTicket` the moment `createIssue` returns the key, as
  `approve_ticket`, `deny_ticket` and `request_plan` do with their input key
  on entry; the hook's `action.result` listener is a second path over the
  same keys, parsing the JSON-string tool output July hands hooks for a
  server tool; the desk is the only host that re-tags mid-turn; planner: its session pin
  `issue:<KEY>#<attempt>`; triage: its session pin, the issue key; fixer
  and reviewer: the PR's head branch, else one PR read per session within
  2 s) and tags it through July's **public** session-attribute API
  (`host.otel.setAttributes` → `collector.setSessionAttributes`). The
  worker runs no model turns, has no hook, and tags nothing; its only part
  is the `apj_factory.ticket.merged` counter. July's `paintOpenSpans`
  writes the tag onto the session's open `agent_sdk.turn`, `agent_sdk.tool`,
  and `agent_sdk.subagent` spans, and `join` stamps it on every later span
  and metric sample of the session. Which spans carry it, exactly: the
  `agent_sdk.turn` span, every `agent_sdk.tool` span (opened at the tool
  call: on `actions.requested`, or in `runInCall` when July executes the
  tool itself) and `agent_sdk.subagent` span (opened on
  `subagent.called`), both after the hook, every metric sample of the
  turn, and the `agent_sdk.turn.<phase>` spans opened after the hook
  settled. July queues the `turn.started` dispatch and opens the turn's
  first phase span synchronously (`prewarm`, else `workspace`, else
  `nudges`), so that one always predates the hook; the later early phases
  (`workspace`, `nudges`, `build_request`, `first_update`) each open after
  an `await` and may or may not, depending on the hook's latency (a
  session pin is instant; the desk's kv read and the fixer's or
  reviewer's PR read of up to 2 s are not). `paintOpenSpans` does not paint
  phase spans, so a phase span opened before the hook settled carries no
  key on a session's first turn and the previous turn's key on a re-tagged
  session; read them by their turn parent. The value is a Jira key, `none`, or
  `other` (`factory-otel.ts` `ticketLabel`), never free text. Nothing else
  on July's spans or logs is added, rewritten, or removed; beyond the
  provider that records and exports them (Bug 6b, above), the factory does
  not touch July's spans. Per-ticket queries and the
  cost dashboard: [`observability/grafana/README.md`](../observability/grafana/README.md)
  ("Cost per ticket").
- **Metrics and logs** go through providers the factory owns
  (`agent/lib/factory-otel-signals.ts`). July builds its own metric and
  log exporters only at startup, with the header object it read from env
  then (`runtime.js` `startOtelSdk`, `config.js` `withEnvHeaders`; the OTLP
  exporters read env headers only when constructed), so a header bound
  later never reaches them. 0.2.22 still snapshots that object once. From
  0.2.21, a traces/metrics/logs exporter makes July keep a *local* provider
  even when a global one is registered. Loading `agent/otel.ts` registers
  the factory's providers before July starts, and the dummy exporter
  (a dummy exporter whose `includes` matches no signal; `defineOtel` rejects `signals: []`) keeps `exporters.length > 0` so metrics and logs stay on
  without attaching any July exporter. July's collector then uses the
  factory globals. Their exporters read the header and endpoint at export
  time. So July's own metrics (`cursor.token.usage`, `cursor.tool.calls`,
  `agent_sdk.session.count`, `agent_sdk.turn.count`,
  `agent_sdk.http.duration`; 0.2.20 dropped `cursor.cost.usage`) and
  session-event logs land there, with the factory's. Do not name a
  logs-only or traces exporter: 0.2.22 would keep a local provider and
  export through frozen headers.
- **A session turn's end.** July counts the turn and ends its span, and
  nothing July awaits before the reply exports either: its `forceFlush`
  skips the adopted tracer, meter, and logger. Before Bug 6b the span sat
  in July's memory buffer, where a flush already running when the turn
  ended could `reset()` it away and leave the reply's flush nothing to do,
  count included (`july-otel-upstream.md` sections 4 and 12). Every host's
  `agent/hooks/zz-otel-turn-flush.ts` defers `flushFactorySignals()` with
  `setImmediate` from `turn.completed` and `turn.failed`, so the factory's own
  providers export right after July records the turn (or, if a factory flush
  is already running, as soon as it ends, at most `SIGNALS_BUDGET_MS` + 100 ms
  later). The same hook awaits `flushFactorySignals()` from `session.waiting`,
  `session.completed` and `session.failed`, which July dispatches after the
  turn's end and before the hosted reply returns, so the reply waits (within
  `SIGNALS_BUDGET_MS`) for the turn's spans, metrics, and logs (Bug 6a).
  Since Bug 6b the turn and tool spans are in the factory's span queue, so
  this awaited flush is what carries them out; 6b depends on it. Success
  after deploy: no `turn.completed` log without its `agent_sdk.turn` span
  over 48 hours. On the `global_provider_taken` (`tracer: false`) fallback
  July's spans are back in its memory buffer and this flush cannot reach
  them.

| Signal | What | Temporality, content |
| --- | --- | --- |
| Traces | The `factory.*` spans (table below), which are always recorded while the header is set, and July's own: `agent_sdk.http` (recorded only for a sampled inbound request), `agent_sdk.turn` with its `agent_sdk.tool` and `agent_sdk.subagent` (always recorded), and host MCP client spans (`tools/call`, `tools/list`; recorded inside a factory span, and so under an unsampled request too) | Factory span notes leave as set, including `error.message`. July `collector.js` (0.2.18): `tool_args` / `tool_output` on `agent_sdk.tool` spans; `subagent_description` on `agent_sdk.subagent` spans (:259-261); `sdk_agent_url` on open turn / tool / subagent spans (`agent.bound`, :77-88); turn span status text + `recordException` only for non-expected failures (:352-366); `session.failed` also sets open turn-span status (:398-403). Content fields except `sdk_agent_url` are truncated at 2048 + "…". Grafana access is the only control. Factory and July spans share one exporter (Bug 6b): sent before each delivery's reply, a session turn's by the `session.*` hook before the reply, and the rest every 300 ms (`TRACE_DELAY_MS`) while the pod runs |
| Metrics | July's metrics above, `apj_factory.delivery` (counter) and `apj_factory.delivery.duration` (histogram, ms, buckets 50 ms to 300 s: `DELIVERY_DURATION_BUCKETS_MS`) by `factory.span`, `factory.delivery.kind`, `factory.outcome`, July's `agent_sdk.hosted_execution.duration_ms` (histogram, ms, buckets 100 ms to 30 min: `HOSTED_EXECUTION_DURATION_BUCKETS_MS`, host MeterProvider injects `advice.explicitBucketBoundaries`; July sets no advice and the OTel default stops at 10 s), and the ops funnel's `apj_factory.kv.failure` | **Cumulative** (what Grafana Cloud's Mimir expects; July's own exporters would send delta). Bounded labels only (below). Sent before each delivery's reply and every 10 s while the pod runs; a session turn's are sent by the turn-flush hook right after the turn (after any factory flush already running) and awaited from `session.*` before the reply (Bug 6a) |
| Logs | July's session events (`message.received`, `action.result`, `turn.completed`, `turn.failed`, `session.failed`, …) and every factory console string, including JSON lines (`{"worker":"decision",…}`, `{"planner":"turn_model",…}`) and `[tag] …` lines | Unaltered: original body, only attributes the emitter set. July `collector.js` (0.2.18): `agent_sdk.user_prompt` on `message.received` logs only (:91-95, `userPrompts`); `agent_sdk.error_message` on `turn.failed` / `session.failed` logs only (:373-377, :404-408), gated by `toolContent` (`gatedContent` :625-629); the `action.result` log never carries output (:227-232). Console bodies are `util.format` of every argument; a console line's level is its method's (`error` is `ERROR`), except that Node's own print of a process warning is one `WARN` record (below, with the cases that stay `ERROR` and the listener-ordering limit). The factory does not parse a body to mint fields; dashboards read raw bodies in LogQL. Grafana access is the only control. Sent before each delivery's reply and every 1 s while the pod runs; a session turn's are sent by the turn-flush hook right after the turn (after any factory flush already running) and awaited from `session.*` before the reply (Bug 6a) |

Metric labels are an allowlist. July labels every metric with the
session and conversation id, the bound agent's id, and any session tags
(`collector.js` `join`); under a cumulative reader each session would stay
a series for the life of the pod (the review measured 900 session ids and a
500 KB export after 3,400 sessions). A View on the factory's meter keeps
only `METRIC_ATTRIBUTE_KEYS` (`agent_sdk.agent`, `agent_sdk.channel`,
`agent_sdk.subagent_name`, `agent_sdk.turn_status`, `cursor.token.type`,
`cursor.model.name`, `cursor.tool.name`, `cursor.tool.kind`,
`cursor.tool.status`, `http.request.method`, `http.response.status_code`,
`url.path`, `factory.span`, `factory.delivery.kind`, `factory.outcome`,
`slug`, `site`, `reason`, and the enum-like `phase`, `channel_kind`,
`delivery_surface`, `outcome`, `kind`, and `purpose`) and caps each metric
at 500 series (`METRIC_CARDINALITY_LIMIT`; a metric that reaches it folds
further series into one labelled `otel_metric_overflow="true"`). One
session tag is kept past that allowlist, and only on the instruments the
cost dashboard needs: `factory.ticket.key` (a Jira key, `none`, or
`other`) stays on `cursor.token.usage`,
`agent_sdk.turn.count`, and the worker's `apj_factory.ticket.merged`
(`TICKET_LABELLED_METRICS`: the factory's meter records those counters in
a marked context, and `metricAttributes` keeps the key only on a sample
from that context). `cursor.tool.calls`, `apj_factory.kv.failure`, and
every other instrument drop it with the rest of the session tags, so a
tool-heavy ticket cannot push the tool-call metric past the cap. The
per-instrument budgets are in the Grafana README's "Cost per ticket"
section. The enum-like keys are July's `agent_sdk.hosted_execution.*`
(its five phases `to_first_visible`, `first_visible_to_completion`,
`durability_drain`, `post_drain`, `total`, with channel kind, delivery
surface, and outcome), its tool retry outcome, and
`agent_sdk.reminder.fire_outcome` (`kind`, `reason`, `purpose`); without
them the five phases of `agent_sdk.hosted_execution.duration_ms` land in
one histogram.

Each of those keys has its own value set (`METRIC_VALUES`,
`METRIC_REMINDER_REASONS`, and `METRIC_REMINDER_PURPOSES` in
`factory-otel-signals.ts`, taken from July 0.2.18), and a value outside
its key's set is kept as `other`, however well formed it is. So
`phase` is one of the five phases; `channel_kind` one of `slack`,
`github`, `gitlab`, `bitbucket`, `origin`, `issues`, `runs`,
`change_monitors`, `deployments`, `custom`, `http`, `agent_sdk_reminder`,
`agent_sdk_schedule`; `delivery_surface` `slack` or
`none`; `outcome` one of `progress_update`, `final_post`, `error`, `none`,
`not_eligible`, `recovered`, `exhausted`; `kind` one of `error`,
`skipped`, `delivered`, `stop`. A reminder `purpose` is a slug a model can
choose, so it is one of the factory's own (`follow_up`, `hop_watch`,
`implement_pr`, `implement_launch`, `merge_conflict_watch`) or `other`.

`reason` is shared by two metrics and is told apart by whether the sample
has a `kind`. July's reminder outcome has one, and its `reason` is one of
the fourteen the reminder runner sets when it counts a fire (`fire_threw`,
`handler_missing`, `handler_lost_on_restart`, `missing_handler`,
`until_fn`, `busy`, `run_stop`, `run_skip`, `run_delivered`,
`session_joined`, `session_restored`, `session_opened`, `session_gone`,
`followup_failed`), else `other` (a reminder's `disarmReason` is free text
a caller chose). The ops funnel's `apj_factory.kv.failure` has none and
carries a hosted reason code such as `agentsdk_kv_key_invalid`, `http_503`,
or `none`; that is kept when it is a code (`codeLike`: charset, length,
and randomish — a cardinality bound; nothing is scrubbed) and is
`other` if not.
Queries for `apj_factory.kv.failure` should sum by (`slug`, `site`,
`reason`); July also sets `agent_sdk.agent` on the bind baseline and on
every failure. A new July release that adds a value shows up as
`other` until it is added to the set; the characterization test and the
`other` series are the way to notice. Neither a made-up value nor a
free-form one can mint a series past the cap. The characterization test
sends 1,010 sessions' turns and checks the payload stays the same size
with no `ses_` id in it.

Logs and traces leave the process as July or the factory emitted them.
There is no log redaction, no body rewrite, no attribute allowlist, no
message drop, and no parse of a log body to mint attributes or structured
metadata. The one addition is the `factory.ticket.key` session attribute
above, set through July's public API and so emitted by July itself. A July session-event record keeps its event name and every
attribute July set (`cursor.model.name`, `agent_sdk.cost_usd`, prompts,
error text). A console string keeps `util.format` of every argument as
the body and gains no derived fields (`factory.event`, `deliveryId`,
`eventType`, JSON keys). The planner's `{"planner":"turn_model",…}` line
therefore reaches Grafana as that JSON, with `model`, `costUsd`,
`pricedFrom`, and the token counts still in the body for LogQL to read
(dashboards PR). A later console argument (an `Error`) is formatted into
that body. July's content flags are on in the resolver (`logs: {
userPrompts: true, toolContent: true }`). July 0.2.18 `collector.js`
then emits this content (Grafana access is the only control; July
truncates every content field except `agent_sdk.sdk_agent_url` at
CONTENT_MAX 2048 + "…", :13, :677-682):

- `agent_sdk.user_prompt` on `message.received` logs only (:91-95), when
  `userPrompts` is on.
- `agent_sdk.error_message` on `turn.failed` / `session.failed` logs only
  (:373-377, :404-408), gated by `toolContent` (`gatedContent` :625-629).
- `agent_sdk.tool_args` / `agent_sdk.tool_output` on `agent_sdk.tool`
  spans (`actions.requested` / `action.result`).
- `agent_sdk.subagent_description` on `agent_sdk.subagent` spans
  (:259-261).
- `agent_sdk.sdk_agent_url` on open turn / tool / subagent spans
  (`agent.bound`, :77-88).
- Turn span status text + `recordException` only for non-expected
  failures (:352-366); `session.failed` also sets open turn-span status
  (:398-403).
- The `action.result` log never carries output (:227-232).

Factory *span notes* (ticket key, outcome, reason, PR, agent id) and
`error.message` leave as the factory set them. Metric labels stay
bounded (`codeLike` on `reason` and the enum sets) for cardinality
only; nothing is scrubbed. Grafana access is the only control.

One exception, by source not by body: messages the OpenTelemetry SDK
itself writes through its diag logger (at July's ERROR level: export
failures and other SDK-internal errors, including those routed via
OTel's global error handler) still print to stdout but are not
re-exported through the console bridge. App, factory, and July console
lines are unaffected. July hooks that logger to `console.log`
(`runtime.js` 93-99, `server.js` 117); re-exporting it would loop (~1
POST + 1 stack line per second on 401 or 503). The factory wraps the
diag logger and skips `logger.emit` only while that wrapper is running.

One exception to the level, not to the body: a Node process warning. Node's
default `warning` listener writes it through `console.error`, so the bridge's
method-to-level map would label it `ERROR`. `bridgeConsole`
(`agent/lib/factory-otel-signals.ts`) wraps `process.emit` for the `warning`
event. Node dispatches a warning as one synchronous
`process.emit("warning", warning)`, so the wrapper's window is exactly that
call: it records what Node's print of the warning will look like, runs the
dispatch, and puts back what it found when `emit` returns or throws. The first
`console.error` inside the window with that shape, one string that starts
`(node:<pid>) ` and holds the warning's `Name: message`, is exported once, at
`WARN` (severity number 13, text `WARN`), with the body and attributes every
console line gets (`util.format` of what Node printed, none derived). The
bridge never runs the warning's own code: it takes the warning's `name` and
`message` as data properties (own or inherited, never a getter), requires the
warning's `toString` to be `Error.prototype.toString`, and builds Node's text
from those once, when the dispatch starts. A counting or throwing `toString()`
therefore behaves exactly as without the bridge (Node's own call is the first
one; a `toString()` that throws makes Node's listener throw and nothing is
printed or exported). Node's print stays on the normal `ERROR` path, still
exported, when the bridge has nothing to match: a custom `toString()`, or a
`name` or `message` getter, or a non-string `name` or `message`; or when the
text changes during the dispatch (a listener changes `name` or `message`; the
text is read once, when it starts). With `--trace-warnings`
(or `--trace-deprecation` for a `DeprecationWarning`) Node prints
`warning.stack` instead of `toString()`. For an ordinary warning the stack
header is the same `Name: message`, so that print is still the `WARN`; it
stays `ERROR` only when the header differs from that text: a `name` or
`message` changed after `.stack` was first read (V8 formats the header on
first read). A listener's own line about a warning
(`console.error("my handler: " + String(w))`) is not in Node's shape and stays
`ERROR`.

Every `warning` listener runs inside the window, in listener order, and tests
pin each position under default flags and `--no-warnings`. Nothing outside the
`emit` call is in it: if a listener throws, the window has already ended when an
`uncaughtException` handler runs, so that handler, a `nextTick` or microtask
already queued, and any later timer or immediate all log at `ERROR`. A listener
that re-emits `warning` synchronously with `process.emit` gets its own window
for the inner warning, and the outer one is back when it returns, so Node's
print of the outer warning stays the `WARN`.

| Where the listener is | Its Node-shaped `console.error` |
| --- | --- |
| prepended after the bridge | `WARN` if no earlier line in the dispatch matched (else `ERROR`); Node's own print is then `ERROR`, so still one `WARN` |
| prepended before the bridge | the same: `WARN` if no earlier line matched (else `ERROR`), then Node's print `ERROR` |
| Node's own listener | its print is the `WARN` |
| `on`, before or after the bridge | `ERROR` once a line in the dispatch has matched (Node's print or an earlier listener's); `WARN` when nothing has matched yet (Node printed nothing, or printed something that did not match the text the bridge expected). When the bridge had no text to expect (custom `toString()`, getter), nothing is relabelled and the line is `ERROR` |

So the "one `WARN`" holds for Node's print and for every listener that does not
write Node's exact shape (`(node:<pid>) ` plus the warning text, one string,
through `console.error`). The limit is a listener that does: if it runs inside
the window and is the first line to match, ahead of Node's print, or Node
prints nothing (`--no-warnings`, `NODE_NO_WARNINGS=1`, `--disable-warning`,
`--redirect-warnings`), or Node's print did not match the expected text (a
`--trace-warnings` stack whose header differs from it, or a listener changed
`name` or `message` during the dispatch), its line takes the `WARN` instead. With `--redirect-warnings`,
Node prints nothing to the console, but it falls back to `console.error` when
it cannot open the file (inside its listener, so that print is the `WARN`) or
when a write fails later (after the dispatch, so that print is exported at
`ERROR`); either way it is exported, never dropped.

Nothing is dropped, deduplicated (beyond Node's own once-per-process rule for
experimental warnings), rewritten, or scrubbed, and no other console line, log,
or span changes. The one case this showed up as was
`ExperimentalWarning: SQLite is an experimental feature and might change at any
time`, once per hosted process on the first local turn: July 0.2.22's runner
opens an SQLite conversation store (`dist/internal/sdk-runner.js`), which
makes `@cursor/sdk` 1.0.37 load `node:sqlite`. It is Cursor's, and a hosted
deployment cannot silence it: July applies deployment secrets to `process.env`
per request, after the process started from its snapshot (July
`docs/deployment.md`, "A hosted deployment receives its secrets per request,
after its modules are loaded"), and `AgentHostingOptions` has no node-args
field, so a `NODE_OPTIONS` secret never reaches Node's launch parser. Alert on
it as a warning, not an error. Tests:
`agent/lib/factory-otel-signals.test.ts` ("console bridge: ...") run the real
bridge in a child Node process.

Node reads `console.error` once, at the process's first warning print
(`error ??= require('internal/console/global').error` in
`lib/internal/process/warning.js`), and keeps that function. The bridge must
therefore be installed before any warning is printed: a warning printed
earlier, such as a future startup warning ahead of `agent/otel.ts`, makes
every later warning print go to the unpatched `console.error` and bypass the
bridge, so it is neither `WARN` nor exported.

The bridge keeps the `process.emit` it found and calls it, so another wrapper
installed before or after chains with it. July's proper-lockfile pulls
signal-exit@3, which captures and installs its own wrapper at module load and
never unloads, so warnings pass through the bridge in either order (a test
loads it before and after the bridge). A library that captures `process.emit`
before the bridge installs and installs its wrapper afterwards, or that later
restores a captured `process.emit`, routes the dispatch around the bridge;
Node's print then goes to `ERROR` as it does today, and nothing is dropped.

The `factory.*` spans:

| Span | Where | Attributes |
| --- | --- | --- |
| `factory.delivery` | Every Jira webhook (desk, planner, triage, worker), the planner's `plan` and triage's `queue` routes, the fixer's `drive` route, every Slack mention, DM, channel post, and reaction on the desk, every GitHub hook on the desk, worker, fixer, and reviewer | `factory.delivery.kind` (`jira.webhook`, `slack.inbound` for mentions and DMs, `slack.channel_post`, `slack.reaction_added`, `github.check_suite`, …), `factory.outcome` (`buffered` for a fixer wake that only buffers), `factory.ticket.key`, `factory.reason`, `factory.pr` |
| `factory.background` | Work a handler hands to `waitUntil` after its reply: the desk's Jira announces (`jira.announce.<kind>`, outcome `posted` / `not_posted` with the reason), hop-watch arm and clear (`jira.hop_watch.*`), the backstop sweep, triage's Jev-or-turn wake (`jira.triage_wake`: `jev_only`, `skipped`, `turn`), and the fixer's debounced buffer flush (`buffer.flush`: `flushed`, `retry_scheduled`) | as above |
| `factory.github.task` | The host `{ task }` a GitHub hook returned (desk review updates, worker PR status) | as above |
| `factory.reminder` | The desk's `hop_watch` and `plan_start` (`reminder.plan_start`, the plan hop's 4-minute start check), the worker's `implement_pr` and `implement_launch`, the fixer's 30-minute merge-conflict watch (`reminder.merge_conflict`) | ticket key or PR, outcome (`plan:posted` and `plan_start:started` / `plan_start:retried` / `plan_start:final` on the desk; `opened`, `no_branch`, `not_due`, `done`, `gave_up`, … on the worker; `delivered`, `skip`, `stop` on the fixer) |
| `factory.schedule` | The desk's `hop-watch` schedule, every 5 minutes | `factory.outcome` `idle`, `due`, or `fired` |
| `factory.cloud_agent.launch` | The worker's implementing agent launch, and every fixer drive start | ticket key or PR, `factory.cloud_agent.id` (`bc-…`), or `error.type` and `factory.reason` (`launch_timeout`, `rate_limited`, …) |

The Jira `factory.delivery` span ends before the reply is returned, and is
exported with the delivery's metrics and logs before it; what the desk and
triage do after it (above) is its own `factory.background` span, a child
in the same trace, exported when it ends. The worker's post-reply launch is
its `factory.cloud_agent.launch` span. A `factory.reminder`,
`factory.schedule`, or `factory.github.task` span with no inbound request
is a root with no link.

Resource attributes, set in code: `service.name` is the hosted slug
(`factory-desk`, `factory-planner`, `factory-worker`,
`factory-triage-jira`, `factory-pr-autofixer`,
`factory-security-reviewer`, with `-staging` on a staging slug),
`service.namespace=software-factory`, `deployment.environment` and
`deployment.environment.name` = `production` or `staging` (from
`FACTORY_ENV`, read at each export), `factory.slug`, and
`service.instance.id`, a UUID shared by traces, metrics, and logs and drawn
for the VM's life after its restore (next section). `OTEL_SERVICE_NAME`
and `OTEL_RESOURCE_ATTRIBUTES` override them when set, `service.instance.id`
included, but they are not declared secrets, so a hosted slug always uses
the code values. A local
`serve --dir .` that mounts several hosts in one process reports
`service.name=software-factory` with no `factory.slug`, because July allows
one OTel config per process; `agent-sdk info` shows that process-wide name
for every host.

### Restored VMs: ids, the instance id, and counters

Hosted v2 freezes a VM after startup and restores every VM of a slug from
that snapshot, so a VM starts with whatever state the process held at the
freeze. What an audit of the desk's telemetry found, and what is done:

- **Span and trace ids repeated.** Span id `1101ba25…` appeared in 102 log
  lines across 34 traces and under all 13 `service.instance.id` values of
  the desk, and 77 of 571 distinct span ids in Tempo sat under more than
  one trace. The instance ids differed (they are drawn after the restore)
  while the ids of spans did not: OTel's default id generator draws on
  `Math.random`, whose V8 state is in the snapshot. The factory's own ids
  (spans, traces) come from `wakeHex` (`agent/lib/factory-otel.ts`), which
  `factoryIdGenerator` calls each time a span starts: a fresh read of the
  kernel's random pool (`/dev/urandom`), hashed with the monotonic and wall
  clocks, the pid, a draw counter, and the inbound request's trace and span
  ids. It keeps no generator state between draws, so there is nothing a
  snapshot can clone, and it uses none of `Math.random`. It is for ids, not
  secrets. While the export header is unset a span is never recorded and
  its ids never leave the process, but OTel draws them before it samples,
  so `factoryIdGenerator` takes them from `randomBytes` then, with no
  kernel read, clock read, or hash per id (the cheap path; the ids are
  unused). **July's own spans** (`agent_sdk.http`, turns, tools) still use
  OTel's default generator, and July offers no way to replace it
  (`defineOtel` has no id generator option), so this is a July issue and
  is not patched here ([`july-otel-upstream.md`](july-otel-upstream.md)
  ask 8). Until July changes it, a log line written outside any factory
  span (July's session events carry `agent_sdk.http`'s ids) can still show
  a span id that other traces show, and two restored VMs that serve
  requests of one inbound trace can mint the same `agent_sdk.http` span id
  in it, which Tempo keeps once. The trace id alone does not repeat for the
  factory's own traces.
- **Traces missing from Tempo were unsampled, not lost.** Covered above: the
  factory's spans are now roots, so the inbound decision no longer applies
  to them.
- **`service.instance.id`.** One id per life of the process after a
  restore, so VMs restored from one snapshot are separate series. It is
  drawn lazily, at the first export or delivery after the export header is
  set (a hosted snapshot has no header, and nothing before it draws one),
  never at import, and from `wakeHex`, salted with the request's inbound
  span ids, so it does not depend on one entropy source being reseeded. It
  is drawn again when the wall clock steps against the monotonic clock by
  more than `RESTORE_SKEW_MS` (5 s) since the last look, which is what a VM
  paused after it drew an id and resumed with its wall clock set shows. The
  first call after a resume is often a timer's export, which has no
  request to take a salt from, and two clones that resumed alike could draw
  alike. So a skew step seen outside a request does not redraw: the id is
  marked stale and kept, and the next call that has a request (a
  delivery's inbound span ids) draws the new one. The same holds for a
  first draw made outside a request (the metric or log timer, say): the
  next call in a request replaces it. A step seen in a request redraws at
  once. Each draw writes one `{"otel":"instance_id","reason":…}` console
  line (`first`, `first_unsalted`, `skew_step`, `salted_after_unsalted`;
  `skew_pending` when a step is seen and the redraw is held), which the
  log bridge sends. That is a best-effort check: a restore that sets no
  clock, or a pause shorter than 5 s, is not seen.
- **Whether a hosted VM resumes in place is not measured.** If a restore
  puts a new process on the snapshot, the lazy draw at the first
  request after it is what separates the VMs, and the skew check never
  fires. If a VM instead resumes in place with its wall clock set, every
  pause over 5 s redraws, and each redraw is a new series whose counters
  would restart at the process's current totals; the per-life rebase below
  subtracts them. Which one the hosting
  does decides how many series a slug makes. To measure it, count the
  log records whose body is the JSON `{"otel":"instance_id","reason":…}`
  over a week (parse the raw body in LogQL; the factory does not extract
  `reason`): mostly `first` or `first_unsalted` means new processes; a
  steady run of `skew_step` and `salted_after_unsalted` means resume
  in place. Until that is known, read a series that starts partway
  through a graph as a new life, not a reset.
- **Counters restart from zero at each new id drawn after a restore (`factory-otel-rebase.ts`).** July's
  counters and histograms (turns, HTTP requests, tool calls, tokens) and the
  factory's own are cumulative and live in the process, which outlives the
  `service.instance.id` it exports under: after a `skew_step` or
  `salted_after_unsalted` draw the new id's first sample was the process's
  whole history. The 2026-10-03 desk showed it: three processes that only
  handled `approve KEY` (instances `0423d6f9`, `cc736eef`, `e1dd423b`)
  each exported `agent_sdk_turn_count_total = 2` from their first sample,
  the totals of the process before the resume, and a sum of last values
  read 16 turns for 12 `turn.completed` lines. `factoryMetricExporter` now
  remembers the raw totals of every export tick the exporter reported as
  `ExportResultCode.SUCCESS` and of every tick with no header, which sends
  nothing and has nothing to fail; a reported failure is not remembered. When
  a batch carries an id it has not seen, the baseline is the newest export of
  the old life that is still pending and newer than the last delivered or
  header-less one, taken as accepted even if the exporter has not answered yet (the reader
  stops waiting after 2,250 ms, and a retried or slow OTLP request can answer
  later; see "Loss"), else the last delivered (or header-less) tick. A newer
  export that already failed does not hide an older one that is still pending.
  It is subtracted from every monotonic
  sum and histogram stream (count, sum, buckets) with a start time at that
  tick, and a rebased histogram point drops its `min` and `max` (the SDK
  keeps those for the process's lifetime). A histogram is rebased only
  when its bucket boundaries match and no count, bucket, or sum fell below
  the baseline; otherwise it passes through as it is, like a fallen counter.
  Streams are keyed by scope (name, version, schema URL), metric name, data
  point type, and attributes, and a start time is clamped to its point's end.
  Exponential histograms are not rebased; nothing exports one, and
  `factory-otel-signals.test.ts` fails if that changes. Gauges and
  up-down counters pass through, and spans and logs are not touched. What the
  process counted between the last tick and the draw (at most 10 s,
  `METRIC_INTERVAL_MS`) belongs to the new life, so a life starts at zero apart
  from that window. So does anything the old life's last export failed to
  deliver (see "Loss" below). Increments can be in no sample, or counted twice,
  in the cases listed under "Loss" (this list is not exhaustive), each bounded
  by the ticks since the last delivered one (except a `partialSuccess`, whose
  loss is the increments since the last export the collector kept in full for
  that series, and an unset header, whose loss is everything counted from the
  last delivered tick until the header is set again). The ones that lose
  increments: the export taken as accepted then reports a failure; the old
  life's last export failed and the VM is never resumed; the header is unset
  (`secrets unset`, the kill switch) and set again, and the first export after
  that carries a new id (the clock stepped while it was unset), so the
  increments between the last delivered tick and the last header-less tick are
  in no sample (a tick with no header notes totals that were never exported);
  and a 2xx with a `partialSuccess` that rejected data points
  (delivered to the exporter, partly dropped by the collector). A process
  that counted something with no header set before its first export drops
  that count. Series exported before this change keep
  their carried-over values until they age out of the dashboards' look-back.
- **Cumulative counters from a restored snapshot can still rewind.** A
  restored VM begins with the counter values the snapshot held (the rebase
  above takes them off at the first new id drawn after the restore, and a
  restore that draws none has nothing taken off); and if two lives end up with one
  `service.instance.id` (a snapshot taken after the id was drawn and
  restored more than once, or a restore the clock check did not see), each
  keeps counting from its own copy of the state and they write one series
  that moves between their totals. Prometheus's `rate` and `increase` treat
  only a *fall* as a reset: a series that jumps up to the other life's
  higher total is counted as real growth, and nothing in the data says two
  lives wrote it. The audit saw one series go 11,965, then 52,783, then
  55,769. That series cannot be repaired afterwards. What the factory does:
  it keys series per life as above (the cheap part), and it rebases each
  new life's counters and histograms at export (the per-life rebase above),
  which repairs a restore that draws a new id and nothing else. It does not
  send deltas or repair a shared id, because July's instruments are bound to
  the meter provider built before the freeze and cannot be moved to a fresh
  one without patching July. Read the counters accordingly:
  `increase()` per instance is right inside one life, a life that exported
  once contributes nothing to `increase()` (it needs two samples), and a
  jump with no matching deliveries is a shared id, so check it against the
  traces (below) before trusting a rate.
- **Other ids that must not repeat across clones.** The planner's
  `lib/chain.ts` (attempt ids), the planner's and worker's
  `lib/verified-claim.ts` (the claim `owner`), and the desk's
  `tools/file_ticket.ts` draw ids with `crypto.randomUUID()`, whose
  entropy cache a snapshot can clone, and `lib/kv-verified.ts` jitters
  retries with `Math.random`. None is a telemetry id, so they are
  unchanged here and this has not been measured for them; a claim `owner`
  that two restored VMs draw alike would defeat the claim it stamps. They
  are the same hazard and a candidate for `wakeHex`.

### Latency, loss, and the kill switch

July awaits its own flush before it answers a hosted delivery
(`hosted-delivery.js` `afterHostedWork`) and caps its deferred trace export
at 5 s. Since Bug 6b July has no deferred trace export in the factory's
hosts (its spans are in the factory's queue), so that flush posts nothing
and the reply waits only for the factory's. The factory sets two limits:

- **One OTLP request** is capped at 2 s (`EXPORT_TIMEOUT_MS`), for every
  signal. A VM's first request opens a TLS connection to the AU gateway
  (about 0.9 s cold), so the cap is about twice that. For July's deferred
  export (only on the `global_provider_taken` fallback) the resolver sets `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` just before
  July builds its exporter, and the exporter's retries stay inside that
  deadline.
- **A delivery** waits at most `SIGNALS_BUDGET_MS` = 2,250 ms for its spans,
  metrics, and logs, the three exports in parallel under one deadline,
  shared by the handler, its `waitUntil` work, and a GitHub hook's
  `{ task }` (the budget rides in the OTel context). It is a little above
  the request cap so a request that times out reports back, and keeps its
  batch, before the wait gives up. A flush asked for while one runs joins
  the next one, which starts as soon as the running one ends, so no record
  is left to the timers. Between flushes the span processor sends every
  300 ms (`TRACE_DELAY_MS`), the log processor every 1 s, and the metric
  reader every 10 s while the pod runs.

Measured against a collector that never answers
(`factory-desk/agent/lib/july-otel.test.ts`, which prints the numbers),
under an **unsampled** inbound request, which is about 96% of them:

| What the delivery does | Delivery | July's flush | Reply waits |
| --- | --- | --- | --- |
| Records no July span (no MCP call, no session turn) | 2,005 ms | 0 ms | about 2.0 s |
| Calls host MCP inside a factory span (every Jira handler) | 2,005 ms | 0 ms | about 2.0 s |
| Any later delivery while the factory still holds the unsent span | 2,006 ms | 0 ms | about 2.0 s |

Before Bug 6b the second and third rows paid July's flush too (2,003 ms,
about **4.0 s** in all): July recorded the MCP span in its memory buffer,
sent it at its own flush, and posted it again at every later flush until
the collector answered. Now the MCP span rides the factory's batch, kept
for the next export after a transient failure (at least once), and the
worst case is the factory's **2.25 s** (`SIGNALS_BUDGET_MS`). On the
`global_provider_taken` fallback the old 4.25 s (2,250 + 2,000 ms) worst
case returns. A healthy
collector adds one or two round trips to the AU gateway, on one reused
connection per signal (the span, metric, and log exporters are cached per
endpoint and header and rebuilt only when the header changes or is unset).
With the header unset nothing waits.

**Whose deadline the wait is.** The reply is the pod's answer to the hosted
control plane, so what a late reply costs depends on who is waiting behind
it:

- **Slack.** Hosted v2 takes the Events API request at the control plane,
  dedupes it there, and posts the ack itself
  ([`everysphere-slack-patterns.md`](everysphere-slack-patterns.md), Adopt
  items 4 to 6), so Slack's 3 s ack is not on the pod's reply path. The cost is the delay
  before the model turn starts while the collector is down.
- **Jira.** Who answers a Jira Automation webhook, and its timeout, are
  not established in this repo. Treat the Jira budget as **unverified**:
  nobody here has measured it, and the cap is not lowered to fit a
  deadline that has not been.

The ~4 s worst case for a collector outage was accepted (PR #215 review);
Bug 6b brings it down to 2.25 s on the factory's path, and the caps stay as
they are. The kill switch below ends it at once.

Loss:

- A **session turn** (a hosted execution, which no factory span wraps)
  waits for its spans, metrics, and logs only through the turn-flush hook.
  July's execution reply (`hosted-delivery.js` `afterHostedWork`) awaits
  only `runtime.forceFlush`, which flushes the providers July built (none
  since Bug 6b: July adopts the factory's tracer, meter, and logger) and its
  deferred trace export (none either: no memory buffer). The
  turn-flush hook (`agent/hooks/zz-otel-turn-flush.ts`) asks for an unawaited
  flush right after July counts the turn, and awaits one from the
  `session.waiting` / `session.completed` / `session.failed` event that
  follows, which the reply waits for (up to `SIGNALS_BUDGET_MS`).
  At risk when a VM is replaced right after the reply, only if that awaited
  flush did not finish within `SIGNALS_BUDGET_MS` or its export failed: that turn's
  `agent_sdk.turn` and tool spans, its `cursor.token.usage`,
  and `agent_sdk.turn.count` increments (the token-use
  and cost queries in step 4 of "Verify in Grafana" would undercount) and
  its `turn.completed` / `turn.failed` log records. A frozen VM sends them
  when it next runs.
- A sampled `agent_sdk.http` (about 4% of requests) ends after the
  factory's flush and July's `forceFlush` no longer carries it (Bug 6b), so
  it leaves on the 300 ms span timer or the next flush, and a VM frozen
  sooner holds it until it next runs or loses it if replaced.
- A delivery whose 2.25 s budget is spent (a slow collector) leaves the rest
  to the next flush or the timers.
- A log batch or a span batch (July's spans included, Bug 6b) the collector did not take for a
  transient reason (no answer, 429, 5xx) is kept and sent again with the
  next batch; a 4xx batch is dropped. Exports can overlap (a delivery's
  flush runs beside a timer's), so each failure is **added** to what an
  earlier one left, not written over it; what is kept is capped at the
  newest 1,000 log records and 2,048 spans, and the oldest go first. A metric
  batch is never re-sent, and none is needed while the id holds: the next
  cumulative export of the same life carries the failed batch's increments.
  Across a restore the rebase keeps that true as far as it can know. Every
  export is pending until the exporter reports a result, and a new life
  subtracts the totals of the old life's newest pending export that is newer
  than the last delivered or header-less tick, else that tick, so a pending
  export is taken as accepted, and a life
  whose last export was reported as failed before the new id hands those
  increments to the next life's first sample (3 delivered, then 2 on a failed
  export, a new id, then 1 gives the series A: 3 and B: 3, which sum to 6). The
  reader stops waiting for an export after 2,250 ms and the OTLP request can
  answer later (its 2,000 ms limit is a socket-idle timer, and a retried 429 or
  503 waits and resends), so a new life can start with several of the old
  life's exports in flight, answering in any order. A late result never
  changes the baseline of a life that has started, and while the slow export is
  still among the pending ones a late SUCCESS is not counted twice (3
  delivered, 2 in a slow export, a new id, then 1 gives A: 5 and B: 1). That
  holds when a newer export has already failed. In increments: 3 delivered, 2
  more in a slow export (the running total is 5), 1 more on an export that
  fails fast (6), a new id, then 1 more (7). The new life takes the slow
  export's running total (5) as its baseline, so B is 2, and the late SUCCESS
  gives A: 5 and B: 2, which sum to the 7 counted. With nothing delivered yet,
  the slow first export is the baseline in the same way. The pending exports
  are kept in sequence order, at most 64. Past 64 the oldest is forgotten, and
  if every newer pending export then fails, the forgotten one can no longer be
  the baseline, so its late SUCCESS is counted twice (the lives sum high by its
  increments). That is not expected in practice: the OTLP exporter fails the
  31st concurrent export of one `OTLPMetricExporter` instance at once, so at
  most 30 are pending per instance. A header or endpoint change builds a new
  instance (`cachedExporter`), and the old one's shutdown waits for its
  in-flight exports, whose late results still reach the one rebaser. Exceeding
  64 would take at least two such changes, with the full 30 still in flight on
  each of the first two instances and five more on the third.
  Metric increments can be lost or counted twice in the
  following cases, each bounded by the increments of the ticks since the last
  delivered one (normally one interval's; except a `partialSuccess`, whose loss
  is the increments since the last export the collector kept in full for that
  series, and an unset header, whose loss is everything counted from the last
  delivered tick until the header is set again) and none repairable on the
  client, which sees only what the exporter reports, not what the collector
  stored.
  The list is not exhaustive:
  - the export taken as accepted then reports a failure (a late FAILED): its
    increments are in no sample;
  - a life's last export fails and the VM is never resumed: the same;
  - the header is unset (`secrets unset`, the kill switch) and set again, and
    the first export after that carries a new id (the clock stepped while it
    was unset): the increments between the last delivered tick and the last
    header-less tick are in no sample, because that tick notes totals that were
    never exported (it is also what keeps a snapshot's totals out of the first
    life after a restore);
  - the collector stored a batch the exporter reported as failed (the idle
    timer destroys the socket after the body was sent): the next life carries
    it again, so the lives sum high by that much;
  - a 2xx response with a `partialSuccess` that rejected data points is a
    delivered export to the exporter: the next life subtracts increments the
    collector did not keep, and they are in no sample.
  A remembered export is ordered by a sequence number, so a late result never
  replaces a newer one. Delivery is at least once: a request that timed out on
  the factory's side may have been accepted by the collector, and then its
  retry sends the batch a second time (see the next section); the metric
  overcount above is the same effect for a life change.
- After a 401 or 403 (wrong instance ID, token, or scope) July keeps the
  rejected trace batch of its own spans (up to 2048) and posts it again on
  every delivery: one extra round trip each until the header is fixed or
  unset. The factory's span and log batches are dropped instead.
- An export that runs while the header is unset (the kill switch, below)
  discards the batch: `factoryLogExporter`, `factorySpanExporter` and
  `factoryMetricExporter` each report success and keep nothing for retry
  (the metric reader's next cumulative export carries the totals).

**Kill switch: unset the header** on a slug (`secrets unset`, below). The
next delivery binds without it, and from then on nothing is exported,
nothing is contacted, and nothing waits. No redeploy is needed.

### What the header changes when it is set, and what still is not visible

With the header set, every outbound `fetch` from a slug (Slack, GitHub,
`api.cursor.com`, Jira through the account connector, Jev) carries W3C
`traceparent` and Cursor `backend-traceparent` headers from the active
span; that is July's instrumentation, which the factory turns on only
while the header is set. With it unset July still logs at startup (the
`TracerProvider already registered`, `LoggerProvider already registered`,
and `duplicate registration of API: propagation` lines; `otel recording`
instead of the first only on the `global_provider_taken` fallback), no span
is recorded, and nothing leaves.

- **July turn / tool / subagent / HTTP / MCP spans and session-event logs
  carry content.** With `logs.userPrompts` and `logs.toolContent` on,
  `agent_sdk.tool` spans carry tool args and output, `agent_sdk.subagent`
  spans carry descriptions, open turn / tool / subagent spans carry the
  agent URL, turn spans carry failure text and exceptions for unexpected
  failures, and session-event logs carry prompts and `error_message`. HTTP
  and host MCP spans still put the thrown error's message on the span
  (`dist/internal/otel/http.js`, `mcp.js`) with no content gate. Factory
  spans also leave as emitted, including `error.message`. Grafana access
  is the only control
  ([`july-otel-upstream.md`](july-otel-upstream.md) section 6).
- **Duplicated or lost spans.** On July's memory path two flushes that
  overlap post the same `agent_sdk.*` spans twice, and a span that finishes
  while a slow export is in flight is cleared with the batch and never
  exported. Since Bug 6b July's spans share the factory's queue instead
  (that path returns only on the `global_provider_taken` fallback), where a
  span that ends during an export stays queued for the next one. But
  **spans can still be sent twice**: when an export times out the collector
  may already have taken the batch, and the factory keeps it and sends it
  again with the next one (the same at-least-once rule as logs). So a
  duplicate span id can come from a retry (or, on the fallback, from July).
  Tempo stores a duplicate
  span id twice until compaction merges the trace. Count deliveries by
  distinct traces (Search lists each trace once) or by distinct span ids
  (`| select(span:id)`), not by a raw span count. Since Bug 6b a missing
  `agent_sdk.turn` span next to its `turn.completed` log is a regression to
  investigate (first: a `global_provider_taken` warning on that pod), not
  July's known loss. A duplicated log record has no id to count by; do not
  total log lines for a rate.
- Deliveries that never reach the pod: a Jira rule that did not fire, a
  body the host dropped as invalid JSON (TLSSN-40), or a GitHub event the
  control plane did not forward.
- Work that outlives its delivery: the desk's Slack backstop sweep past its
  1 s wait, and the ops funnel's background Slack post. Their metrics and
  logs leave with the next flush on that pod, or are lost when the pod is
  replaced (see Loss above); a `factory.background` span exports itself,
  within the 2.25 s budget, when it ends.
- A later console argument (an `Error`): `util.format` of every argument
  is the body. The Error's text is in that body, unaltered.

The July behaviours above, and why the factory works around them, are in
[`july-otel-upstream.md`](july-otel-upstream.md) as asks for July.

### The endpoint and instance ID

The stack's region is `<GRAFANA_REGION>`: `dig CNAME
<GRAFANA_STACK>.grafana.net` answers
`<GRAFANA_HG_GATEWAY_HOST>`, and
`otlp.example.com` resolves (no `-0` variant
does). So the code's endpoint is
`https://otlp.example.com/otlp`, sent as
OTLP/HTTP protobuf to `/v1/traces`, `/v1/metrics`, and `/v1/logs`. Confirm
it in the portal
([Grafana: send data to the OTLP endpoint](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/)):
sign in at grafana.com, open the organization, select the
`<GRAFANA_STACK>` stack, and click **Configure** on the
**OpenTelemetry** tile. The page shows the **OTLP endpoint** (it must
match) and the **Instance ID**, a number, which is the Basic-auth user. Do
not use **Generate now** there if you create the token below.

Every `agent/agent.ts` allowlists
`otlp.example.com` in `hosting.egressDomains`.
If the portal shows another host, change `GRAFANA_OTLP_ENDPOINT` and all
six egress entries and redeploy. A local collector:
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/otlp` overrides the code's
endpoint, and it still needs some header to switch export on (a collector
with no auth ignores it, e.g. `OTEL_EXPORTER_OTLP_HEADERS=x-factory-otel=on`).

### The access-policy token

([Grafana: create access policies and tokens](https://grafana.com/docs/grafana-cloud/security-and-account-management/authentication-and-permissions/access-policies/create-access-policies/))

1. In the stack, **Administration → Users and access → Cloud access
   policies → Create access policy**. Realm: the `<GRAFANA_STACK>`
   stack only. Name it `factory-otlp-write`.
2. Scopes: `metrics:write`, `logs:write`, `traces:write`, nothing else.
   All three are used.
3. **Create**, then **Add token** on the policy. Name it
   `factory-hosted-slugs`, set an expiry you will rotate before, and copy the
   `glc_…` token once.

The header is `Authorization=Basic base64(<instance id>:<token>)`
([Grafana](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/)),
with a **literal space** after `Basic`. Do not paste Grafana's
`Basic%20…` form (its snippet for Python): July and the OTel SDK split the
variable on `,` and the first `=` and decode nothing, so `%20` is sent as is
and Grafana answers 401. Build it in a private shell, without echoing
either value:

```bash
read -r  -p "Grafana OTLP instance ID: " GRAFANA_OTLP_INSTANCE_ID
read -rs -p "Grafana glc_ token: " GRAFANA_OTLP_TOKEN; echo
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(printf '%s:%s' "$GRAFANA_OTLP_INSTANCE_ID" "$GRAFANA_OTLP_TOKEN" | base64 | tr -d '\n')"
unset GRAFANA_OTLP_TOKEN
case "$OTEL_EXPORTER_OTLP_HEADERS" in "Authorization=Basic "*) echo "header shape ok" ;; *) echo "wrong shape" ;; esac
```

### Secrets per slug

One secret, the same value on every slug, set after the slug is `running`,
then one redeploy of each slug from the commit that adds `agent/otel.ts`
(the egress entry ships with the deploy):

| Slug | Set | Do not set |
| --- | --- | --- |
| `factory-desk`, `factory-planner`, `factory-worker`, `factory-triage-jira`, `factory-pr-autofixer`, `factory-security-reviewer` | `OTEL_EXPORTER_OTLP_HEADERS` | `OTEL_EXPORTER_OTLP_ENDPOINT` (in code), `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` (set in code), `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_LOGS_EXPORTER`, `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_CONTENT` (on in the resolver; not declared as secrets) |

```bash
S="npx -y -p @cursor/july@0.2.22 agent-sdk"
for slug in factory-desk factory-planner factory-worker factory-triage-jira factory-pr-autofixer factory-security-reviewer; do
  printf '%s\n' "$OTEL_EXPORTER_OTLP_HEADERS" | $S secrets set "$slug" OTEL_EXPORTER_OTLP_HEADERS --team <CURSOR_TEAM_ID>
done
unset OTEL_EXPORTER_OTLP_HEADERS
$S secrets list factory-worker --team <CURSOR_TEAM_ID>   # names only
```

Then redeploy each slug with its section 3 line. A staging slug takes the
same secret; its signals carry `deployment.environment=staging` and a
`-staging` service name.

To turn export off on a slug (the kill switch):

```bash
$S secrets unset factory-worker OTEL_EXPORTER_OTLP_HEADERS --team <CURSOR_TEAM_ID>
```

### Verify in Grafana

Use **Explore** and pick each data source of the stack: Tempo
(`grafanacloud-<GRAFANA_STACK>-traces`), Prometheus
(`grafanacloud-<GRAFANA_STACK>-prom`), and Loki
(`grafanacloud-<GRAFANA_STACK>-logs`). Grafana Cloud maps resource
`service.name` to the `job` label on metrics (`<service.namespace>/<service.name>`,
so `software-factory/factory-desk`) and to `service_name` on logs, and
turns metric dots into underscores (`apj_factory.delivery` →
`apj_factory_delivery_total`).

1. Within five minutes of the desk's redeploy its `hop-watch` schedule
   fires. Tempo:

   ```text
   { resource.service.name = "factory-desk" && name = "factory.schedule" }
   ```

   One trace every five minutes, `factory.outcome` `idle` when nothing is
   due. Loki shows the same run's line:

   ```logql
   {service_name="factory-desk"} | desk = "hop_watch"
   ```

2. Run the section 5 smoke test, then follow its ticket across the slugs:

   ```text
   { resource.service.namespace = "software-factory" && span.factory.ticket.key = "TLSSN-123" }
   ```

   ```logql
   {service_namespace="software-factory"} | issueKey = "TLSSN-123"
   ```

   Expect the desk's `jira.webhook` and Slack deliveries and their
   `jira.announce.*` background spans, the planner's `jira.webhook`, the
   worker's `jira.webhook` (`launching`) and `factory.cloud_agent.launch`
   (`launched`, with `factory.cloud_agent.id`), `reminder.implement_pr`
   fires, and the reviewer's `github.pull_request`. Loki has the worker's
   `{"worker":"decision",…}` lines and the reviewer's
   `factoryDebug:github-event` lines, with their trace ids.
3. Failures and deliveries that did nothing:

   ```text
   { resource.service.namespace = "software-factory" && status = error }
   { resource.service.name = "factory-worker" && span.factory.outcome =~ "http_4.*|ignored|not_launched" }
   { name = "factory.cloud_agent.launch" && span.factory.outcome != "launched" }
   ```

   ```logql
   {service_namespace="software-factory"} | detected_level =~ "(?i)error|warn"
   ```

4. Metrics (Prometheus). Every series also carries `service_name` (the
   slug) and `service_namespace="software-factory"`; use those rather
   than `job`. Each VM is its own series (`service.instance.id` becomes
   the `instance` label), and hosted VMs are short-lived: a series is
   often first exported at 1 or more, which `increase()` and `rate()`
   never count (one hour on 2026-10-03 had 45 delivery series for 52
   deliveries, and `increase()` read 7.5). Count with the dashboards'
   `counter_inc` instead: the series' max in the window minus its last
   value before it, or the max when it had none. Deliveries in the last
   hour by slug, kind, and outcome:

   ```promql
   sum by (service_name, factory_delivery_kind, factory_outcome) (
     max_over_time(apj_factory_delivery_total{service_namespace="software-factory"}[1h])
       - last_over_time(apj_factory_delivery_total{service_namespace="software-factory"}[1d] offset 1h)
     or max_over_time(apj_factory_delivery_total{service_namespace="software-factory"}[1h]))
   ```

   The same shape works on `apj_factory_delivery_duration_milliseconds_bucket`
   (inside `histogram_quantile`) and `cursor_token_usage_total`; sum
   across instances only after it. No reliable cost or model is exported:
   a July regression since 0.2.8, #1071620, reported upstream
   ([`july-otel-upstream.md`](july-otel-upstream.md) ask 10), meant
   `cursor_cost_usage_USD_total` never arrived on 0.2.14, and from 0.2.18 it
   arrives only for turns whose estimate landed first ("BDK 0.2.18 upgrade",
   Turn cost). Cost is a
   token-based estimate on the Factory business and ops dashboards. These
   are metrics, so they do not double-count a duplicated span. They are
   approximate, though. Before #215 they are low: the 2026-10-03 telemetry
   coverage audit found restored VMs reusing one `service.instance.id`
   across requests and rewriting its series from a snapshot value, which
   loses the earlier life's increments (see "Restored VMs" above). With
   #215 a restored life gets its own series, but that series started at the
   snapshot's totals and `counter_inc` counts a series born in the window
   from zero, so they ran high. The per-life rebase (`factory-otel-rebase.ts`)
   starts a life at zero at the first new id drawn after a restore (apart
   from the up-to-10 s window before the draw); a restore that draws no new
   id is not repaired, and series exported before it deployed still carry
   the old values until they age out of the look-back. The Overview dashboard sets Loki counts
   (distinct `deliveryId`) beside them as the reference, and the distinct
   traces in step 5 are another check.

5. Counting deliveries from traces without double-counting duplicated
   spans: Search lists each trace once, and
   `{ resource.service.name = "factory-worker" && name = "factory.delivery" } | select(span:id)`
   lists span ids to count distinct; prefer the Prometheus counters above.

Nothing arriving after a delivery: `agent-sdk secrets list <slug>` shows
`OTEL_EXPORTER_OTLP_HEADERS`; the slug was redeployed from a commit with
`agent/otel.ts` (`agent-sdk info --dir <project> --json` shows
`"otel":{"enabled":true…}`); the egress entry matches the portal's host;
and the header starts `Authorization=Basic ` with a space, not `%20`. A 401
means the instance ID is not the OpenTelemetry card's number, the token
lacks the scope, or the header is URL-encoded; a 404 means the endpoint
lost its `/otlp` suffix.

### Dashboards

Two dashboards in the stack's **Software Factory** folder read these
signals: **Factory business** (what was delivered, lead times, first-pass
rate, cost; uid `factory-business`) and **Factory ops** (health now, the
Loki health events, ticket lookup, and every debug table under collapsed
rows; uid `factory-ops`). They replaced the earlier four (Factory overview,
traces, logs, tokens & cost), which `apply.sh` deletes by uid after a
successful upsert. They are code, in
[`observability/grafana/`](../observability/grafana/README.md):
`generate.py` writes the JSONs, `apply.sh` creates or updates them by uid
with a Grafana service-account token, and `verify.py` runs every panel
query against the stack. That README lists what each dashboard answers,
the telemetry names, how counts and the cost estimate are computed, and
the known gaps.

## BDK 0.2.22 upgrade

The factory runs `@cursor/july` `0.2.22` (same code as `@cursor/bdk`
`0.2.22`; 0.2.19 was never published), pinned exactly (no caret) in
`factory.json`, in each host's
`package.json` and lockfile, in every
deploy command (`npx -y -p @cursor/july@0.2.22 agent-sdk deploy …`), and
in `.cursor/automations/factory-triage-jira.yaml`.
`scripts/july-version-parity.test.mjs`
(part of `mise run test`) fails when
any of those disagree. The desk and the worker pin `@cursor/sdk` `1.0.37`,
the version July 0.2.22 pins. Deploy all six slugs from one ref with the
0.2.22 CLI, in this order: `factory-triage-jira` → `factory-planner` →
`factory-worker` → `factory-desk` → `factory-pr-autofixer` →
`factory-security-reviewer`. Every claim below was checked against the
published 0.2.18 and 0.2.22 packages (`dist/`).

### What changes in operation

- **No `cursor.cost.usage`.** 0.2.20 dropped the collector increment. 0.2.22
  still reserves the name (`host-otel.js`), so the factory must not mint it.
  Spend on Factory business and Factory ops stays tokens × `$price_*`
  (`observability/grafana/generate.py`
  `estimate()`). Live planner
  `{"planner":"turn_model"}` lines stay `model: "unknown"` with no
  `costUsd`; tokens still land on `turn.completed`. Durable cost is
  `GET /v1/session/:id/cost`.
- **Dummy OTel exporter.** 0.2.22 still freezes `OTEL_EXPORTER_OTLP_HEADERS`
  at `startServer`. From 0.2.21, a traces/metrics/logs exporter makes July
  keep a *local* provider even when a global one exists. The factory keeps
  host-owned providers
  (`factory-desk/agent/lib/factory-otel-signals.ts`
  `installFactorySignals`, copied to all six hosts, Bug 6b) and the session
  flush
  (`factory-desk/agent/hooks/zz-otel-turn-flush.ts`,
  copied to all six hosts, Bug 6a), and `exportConfig` in that same
  `factory-otel-signals.ts` now names
  a dummy exporter whose `includes` matches no signal so July opts metrics and logs on without attaching
  any exporter. Expected startup: no `export on a local provider` line,
  no in-memory `otel recording` buffer.
- **GitHub pagination.** 0.2.22 rewrites `/repositories/{id}` Link headers
  through the Cursor proxy. No factory workaround.
- **Slack.** 0.2.22 starts `slack.<op>` spans on the global tracer; they
  leave through the factory exporter. Do not set `includeBotPosts`.
- **Not in this upgrade.** `ctx.host.kv`
  is still get/put/delete (no CAS). Hop-watch and claim-lease stay.
  Hosted `{ agent }` peers stay stubbed: hosted v2 is still one slug per
  app, and `FACTORY_INPROCESS_PEERS` is local-only
  (`triage-jira/agent/lib/peers.ts`).
  Do not adopt `defineConnection({ agent })` on hosted slugs. A follow-up
  would need a multi-component / hosted-peer product that can resolve
  across `factory-*` slugs, then drop that stub and set real `peers` in
  the deploy manifest. Until then leave `FACTORY_INPROCESS_PEERS` unset
  on hosted slugs.

### Dashboard copy (queries unchanged)

Every spend/cost panel still uses `cursor_token_usage_total` × `$price_*`.
No panel `expr` reads `cursor_cost_usage_USD_total`. Copy dropped the
0.2.18 partial-`cursor_cost` story. Panels whose description or markdown
changed:

- **Factory business:** Overview, Spend, Cost per merge, Spend by service
  (bars: Intake & Slack, Planning, Building, Security review, PR fixes,
  Triage), Cumulative spend, Cost by ticket, About these figures, Filed,
  Filed → PR opened, Filed → merged, Ticket flow, Lead times (those five
  hovers are plain language; no Loki/Tempo).
- **Factory ops:** Cost, Spend by service (`factory-*` slugs), Cost /
  bucket, Cost per merged ticket, Cost by ticket, Estimate, not billing,
  Tokens and cost by service.

Apply
`observability/grafana/factory-business.json`
and
`observability/grafana/factory-ops.json`
only after the six slugs are running on this ref. Then run the Slack e2e
in [section 5](#5-smoke-test-after-a-deploy) (`@Factory hello` in
`#mars-eng-intake`, then file a bug through Done).

### Rollback

Redeploy the previous ref with `@cursor/july@0.2.22` CLI only if that
ref's lockfiles match the CLI; otherwise pin the CLI to the ref's July.
After rollback, Grafana spend queries still work (they never read
`cursor_cost_usage_USD_total`).

## BDK 0.2.18 upgrade

Shipped as `@cursor/july` `0.2.18`. Historical. The factory now runs
0.2.22 (above). Claims below were checked against the published 0.2.14 to
0.2.18 packages (`dist/`). No host behaviour changed on that step.

### What changes in operation

- **New July spans.** `agent_sdk.turn.<phase>` (`prewarm`, `workspace`,
  `nudges`, `build_request`, `first_update`) are children of
  `agent_sdk.turn`. `agent_sdk.hosted.<step>` (`admission.handler`,
  `execute.network_wait`, `execute.claim`, `execute.send`) are started
  with `startSpan`, never made active, so `factory.*` spans do not nest
  under them. Both end inside `afterHostedWork`, so the same post-delivery
  flush exports them. `internal/otel/runtime.js`, `config.js`, and
  `http.js` are byte-identical to 0.2.14: the processor choice, the
  in-memory span cap (2048), the sampler, the deferred flush, and the
  SIGTERM flush are unchanged. The OTel package ranges are unchanged too,
  and each host still installs one `@opentelemetry/api`. Queries that
  select `factory.*` or `agent_sdk.http` by name see the same spans; a
  query that counts every span of a service sees more.
- **`runs` channel kind.** 0.2.18 mounts a `runs` continuation channel
  (Factory `run.created`), so `METRIC_VALUES.channel_kind` lists `runs`;
  without it the desk's `factory-otel-signals.test.ts` fails and a `runs`
  latency series would be labelled `other`.
- **Turn cost.** A turn whose billed lookup misses is now catalog-priced
  from its local usage, and `cost.model` (and the `model` label on
  `cursor.cost.usage`) is the requested model id: `auto-smart` under Auto,
  never a routed model. `turn.completed` can still arrive without `cost`
  when the estimate is late: July prices it without awaiting it, with up
  to two networked requests, 5 s each, so `cost` can land about 10 s after
  the turn. `cost.model` is the id string only; params (for Auto,
  `optimize_for`) are in the new `cost.modelParams`. The planner's
  `turn_model` line carries the configured id and `costUsd` only when the
  estimate landed before the hook read the event (on 0.2.14 it never
  did); otherwise `model: "unknown"` and no cost. The hook now reads
  the event after its outcome report (one kv read for a settled plan, Jira
  calls only for a stopped one), a small head start, not a fix.
  July's own `cursor.cost.usage` metric reads the event after every hook,
  so it races the same estimate. The durable per-session cost is
  `GET /v1/session/:id/cost`.
- **Slack.** A reply with a `<@U…>` mention is sent as mrkdwn `text` so
  the mention notifies. The thread-context truncation marker is
  `…(N older replies omitted)`. The hosted edge also subscribes to
  `message.bot`. The desk sets no `includeBotPosts`, so July's
  channel-post watcher drops bot posts before the desk's `onChannelPost`
  (`factory-desk/agent/channels/slack.test.ts`). `factoryThreadReplies`
  also ignores `bot_id` / bot messages as a backup. `setTitle` and
  `users.info` code is unchanged, so the #182 and #183 workarounds stay.
- **Channel state waits for earlier handlers.** A turn now commits its
  channel state, and returns, only after the hook and channel handlers
  queued for its earlier events (`turn.started`, `agent.bound`, tool and
  message events) have run. The worker runs no model turn. The desk's are
  July's Slack sinks (status, tool chips, a non-final `message.completed`
  post), wrapped by `agent/lib/one-reply.ts` with one cached kv read per
  thread. The planner's `turn.started` (kv claim plus the
  `Planning started:` Jira comment) and the fixer's `agent.bound` (a GitHub
  read plus a kv put) and `turn.started` (a kv put) are hooks. None has a
  deadline of its own, as on 0.2.14. They normally finish long before the
  turn does; a hung Slack, Jira, or GitHub call would now also hold the
  turn's end.
- **Peers.** From 0.2.15 a single-agent serve omits an `{ agent }` peer
  with a warning instead of failing boot; from 0.2.17 the manifest lists
  each declared peer's slug (`peers`); 0.2.15 to 0.2.17 `deploy` printed
  `hosted deploys run without peer tools today`, removed in 0.2.18. The
  `FACTORY_INPROCESS_PEERS` stubs stay: unset, no host declares a peer, so
  `peers` is empty. No script reads the old warning.
- **`@cursor/sdk` 1.0.34 `connection_stalled`.** The SDK rethrows a
  stalled stream as a retryable `NetworkError` with code
  `connection_stalled`. The worker reads it as a transport failure, like
  a refused socket, so the launch failure reason is `service_unavailable`
  wherever the code sits on the cause chain
  (`factory-worker/agent/lib/launch.test.ts`).

### Rollback

Go back to the previous SHA and the 0.2.14 CLI together. Conversation
checkpoints (`conversation-mirror.js`, `conversation-pack.js`) and
`host-kv.js` are byte-identical to 0.2.14. The continuation pointer gains
a `recordUpdatedAt` field, which 0.2.14 ignores: it reads only
`sessionId`.

## BDK 0.2.14 upgrade

The factory ran `@cursor/july` `0.2.14` from #211 until the
0.2.18 upgrade. 0.2.14 needed no code change in the hosts.

- **Conversation checkpoints re-pack after the deploy.** 0.2.14 writes
  hosted conversation checkpoints as packs listed by a v2 manifest
  (`internal/conversation-mirror.js`, `conversation-pack.js`). A
  conversation last saved by 0.2.13 (a v1 manifest) still restores; the
  first turn that saves it after the deploy re-packs its whole history
  into packs. Expect those first turns after the deploy to write more to
  storage than usual, then settle. After that, a save usually appends one
  pack for the turn's new checkpoint data, but it re-packs the whole
  conversation again when:
  - the manifest already lists 32 packs (`MAX_PACKS`), so the next save
    that adds data rewrites it as fresh packs; or
  - a new process cannot read the prior manifest, or finds one that is
    not v2, so it starts from no packs and re-packs from the local store
    (logged as `conversation mirror: could not read the prior manifest …
    re-packing the conversation` when the read throws).
- **Rollback.** A 0.2.13 runtime refuses a v2 manifest (`unsupported
  manifest version`), so going back to 0.2.13 after any conversation
  re-packed leaves those conversations unrestorable.

## BDK 0.2.13 upgrade

The factory ran `@cursor/july` `0.2.13` from #208 until the 0.2.14
upgrade. Every claim below was checked against the published 0.2.11,
0.2.12, and 0.2.13 packages (`dist/`), not only the docs.

### The deploy CLI and the runtime move together

- A 0.2.13 CLI writes each v2 schedule (`{ id, cron, kind }`, `kind`
  `markdown` or `run`) into the deploy manifest
  (`internal/deploy-manifest.js`). The 0.2.11 and 0.2.12 CLIs write none.
- A 0.2.13 hosted v2 guest skips the boot-time platform-timer sync
  (`internal/server.js`, `hostedV2Guest`). The control plane owns the
  calendar and fires each schedule as a reserved `agent-sdk:schedule`
  admission (`internal/hosted-delivery-protocol.js`). The guest runs the
  schedule and waits for everything it started before it replies
  (`internal/hosted-delivery.js`, `dispatchHostedScheduleAdmission`).
- A 0.2.11 guest deployed by a 0.2.13 CLI has no handler for that admission
  and answers `404 channel_not_found`.
- A 0.2.13 guest deployed by an older CLI declares no schedule and no longer
  registers one itself, so `hop-watch` never fires, and nothing reports it.

Deploy all six slugs from one ref with the 0.2.13 CLI. To roll back, go back
to the previous SHA and the 0.2.11 CLI pin together.

### What changes in operation

- **Read-tool retry (0.2.12).** A tool declaring `effect: "read"` (the
  planner's `read_ticket`, `get_plan`, `git_history`, and `search_sandbox`),
  or an advertised MCP tool annotated read-only, runs up to 3 times when
  its `execute` throws a transient error. Writes, and tools with no declared
  effect, run once. It covers model tool calls and direct `callTool` calls,
  not host code's own `ctx.host.mcp` or `ctx.host.kv` calls
  (`internal/tool-call-retry.js`, `session-engine.js` `runExecutedTool`).
  - Backoff is full jitter from 500 ms, each pause capped at 4 s and 10 s in
    total, and it honours `Retry-After`. An attempt that ran over 15 s is
    not retried.
  - Transient means a network error code (`ECONNRESET`, `ETIMEDOUT`,
    `UND_ERR_SOCKET`, and others), a `status` or `statusCode` of 429, 502,
    503, or 504, or matching message text. 401, 403, 413, any other 4xx,
    auth or elicitation text, "too large", and a timeout over 15 s are never
    retried.
  - When the tries run out, the error the model sees becomes
    `failed after N attempts: <original message>`. Each retry emits the
    session event `action.tool_retry` and logs
    `[session] tool <name> retry connection=… attempt=… class=http_503 backoffMs=…`.
  - Quirk: the message-text test is `\b(?:HTTP\s*)?(429|502|503|504)\b`
    anywhere in the thrown message. A thrown error that names `TLSSN-503`,
    or says "504 rows", counts as transient and is tried twice more (up to
    about 10 s) before the model sees it. `TLSSN-5030` does not match.
  - For the factory the exposure is small. The planner's read tools return
    failures as values (`{ status: "failed", … }`), so a Jira or GitHub error
    is not retried. Only an uncaught throw is. The KV retries in
    `kv-verified.ts` (K6) do not throw, so a read tool that uses them is not
    retried on top of them.
- **`connection_stalled` retry (0.2.12).** A hosted turn that ends with
  `connection_stalled` is now reported to the control plane as a transient
  failure (`guest_connect_stalled`), which the control plane may redeliver,
  rather than a terminal `turn_failed`. It is counted in the
  `hosted.turn.stall_retried` metric. A redelivered turn runs its tools
  again, which the claims and dedupe already absorb, the same as a
  redelivered Jira or GitHub event.
- **Schedules from the manifest (0.2.13).** The desk's `hop-watch` (a
  `run` schedule, `*/5 * * * *`) is declared with `kind: "run"`. The boot
  line `platform timer upsert failed for schedule "hop-watch"` should
  disappear. `reminders: control-plane list failed` still appears at boot,
  because reminder hydration did not change. The per-ticket reminders stay
  the primary hop watchdog, and the desk's admission `backstopSweep` stays
  too.
- **Model Blocked fallback (0.2.13).** July's `fallbacks` now also take
  over when the root model is rejected as `Model Blocked` or
  `blocked by your team admin` (`internal/sdk-runner.js`,
  `isModelBlockedByTeamAdminMessage`). The other triggers are unchanged:
  catalog refusal ("Cannot use this model") and capacity. All six hosts set
  `fallbacks: factoryFallbacks(model)`, backups that span providers, so a
  model a team admin blocks now lands on a backup instead of failing the
  turn. Fallbacks apply only before the turn produces output.
- **Slack self-identity (0.2.12).** The desk's `self_name` is now its Slack
  profile name from `users.info` (display name, then real name), falling
  back to the `auth.test` handle when the lookup fails. That is one extra
  `users.info` per bot token per process, through July's own `users.info`
  cache (`channels/slack/self-identity.js`). Tests that count the desk's
  `users.info` calls may need to allow for it. The desk's `@` handle in its
  own copy stays the `auth.test` username (`FACTORY_DESK_SLACK_HANDLE`
  first), because
  [`factory-desk/agent/lib/self-identity.ts`](../factory-desk/agent/lib/self-identity.ts)
  reads `auth.test` itself.
- **No Slack app change.** The generated Slack manifest is the same as
  0.2.11's (`channels/slack/manifest.js`), so no reinstall or new scope.

### Workarounds that stay

0.2.13 fixes neither upstream bug, so both workarounds stay:

- #183, `setTitle not-ok error=no_permission`. `channels/slack/assistant.js`
  and `paint-start.js` are byte-identical to 0.2.11, and `dispatch.js`
  differs only in formatting: July still sends `setTitle` without waiting
  for the session.
  Keep the desk's `withAgentSession` (`agent/lib/agent-session.ts`).
- #182, the `users.info` cache and transport leak. `user-info.js` only gains
  the `slackUserName` helper. `sender-name.js` now calls `slackUserName`
  (same fallback order); `socket-mode.js` changes only in formatting;
  `external-policy.js` is unchanged. Keep
  `agent/lib/july-user-cache.ts` and `hostSlackTransport`
  ([`july-users-info-cache.md`](july-users-info-cache.md)).

KV is unchanged. `host.kv` is still `get`, `put`, and `delete`.
`storage-backends/cursor-hosted.js` is byte-identical to 0.2.11, so the
reason codes and the three local-refusal messages `kv-verified.ts` matches
are unchanged.

### Post-upgrade check: hop-watch fires

1. Before deploying, run `mise run test`, which must include a passing
   `july-version-parity.test.mjs`.
2. Deploy all six slugs with the 0.2.13 CLI (section 3).
3. After the desk's pod boots, run
   `$S logs --prod --slug factory-desk --team <CURSOR_TEAM_ID> --once`. It should
   not contain `platform timer upsert failed for schedule "hop-watch"`,
   `unknown_schedule`, `schedule_dispatch_unavailable`, or
   `channel_not_found`.
4. Look for proof that the schedule ran. Every `hop-watch` schedule run
   logs one `{"desk":"hop_watch","via":"schedule","due":N,"fired":M}` line,
   with `fires` when a clean run fired something, or `error` (with the
   `fired` count) if the sweep threw. The admission backstop logs `"via":"backstop"` and a
   reminder logs `"via":"reminder"`, so only a `"via":"schedule"` line
   comes from the schedule. Follow
   `$S logs --prod --slug factory-desk --team <CURSOR_TEAM_ID>` after the pod
   boots. The first `"via":"schedule"` line after the deploy proves hosted
   firing. No such line within about 10 minutes of boot (two `*/5 * * * *`
   ticks) is a failure: the schedule is not firing.
5. Until step 4 is seen, treat hosted `hop-watch` firing as unconfirmed.
   Nothing depends on it: the reminders and the backstop are unchanged.

## Redeploy gotchas

- Pass `--cursor-events-repo cursor-demo-lab/marsbank` and `--team
  <CURSOR_TEAM_ID>` again on every slug. Without the events flag, finish-check fails
  with `GitHub repository is not accessible through this team's
  installation`, or the GitHub subscription is dropped. Confirm the
  `watching:` line.
- A missing secret is a soft failure. `deploy` only warns "secrets
  declared but not set", the slug still reaches `running`, and it quietly
  does less: the fixer never auto-drives without `FACTORY_JIRA_PROJECTS`,
  a ticket filed in Jira gets no intake root, reactions, or `Slack
  thread:` backlink without `FACTORY_DESK_INTAKE_CHANNEL`, and triage keeps the model's verdict
  without `TYPESAFE_API_KEY`. The warning should name only optional names.
  Remove leftovers from old releases with `agent-sdk secrets unset <slug>
  <NAME>`.
- `missing_agent_session_stopped_event_subscription` on the
  `factory-worker` deploy is expected, and the slug still reaches
  `running`. The Cursor control plane sends this code; it is not in
  `@cursor/july` 0.2.13 or its docs. It fires because the worker starts
  Cursor agent sessions (`Agent.create`, one implement agent per approved
  ticket) and no channel subscribes to those sessions stopping. That can't
  be fixed on 0.2.13: no channel kind, event type, or continuation selector
  for agent sessions exists (the v2 continuations are GitHub, Slack,
  Origin, GitLab, Bitbucket, deployments, change monitors, and issues), and
  `deploy` has no flag that silences a warning. A hand-written channel
  declaring a guessed event name would pass the `none/v2` handshake but
  receive nothing, so the factory does not add one. The worker handles a
  stopped agent itself: the `implement_pr` reminder armed at launch polls
  `Agent.listRuns` every 5 minutes, for up to 8 hours. A run that
  `finished`, hit an `error` (the API's EXPIRED maps here), or was
  `cancelled` gets its PR opened if it pushed a branch, and otherwise the
  watch stops and clears `implement-pr-watch/<KEY>` (`factory-worker`
  README, "The worker opens the implement PR"). When July ships an
  agent-session channel, subscribe the worker to it and run the same
  `ensureImplementPr` from its handler. The other five hosts start no
  agent sessions and do not print this warning.
- Every factory PR must be ready for review when first seen, because
  Bugbot does not run on drafts. `@cursor/sdk` has no draft switch on
  `autoCreatePR` (the platform opens those as drafts), so the worker
  launches with `autoCreatePR: false`, the agent only pushes its
  key-prefixed branch, and the worker opens the PR itself with
  `draft: false` once that branch is pushed (TLSSN-35: the agent's own PR
  tool refused the `Slack:` line, so #145's agent-opened PR never landed).
  A PR that still arrives a draft (an agent that opened its own anyway, or
  a bot that drafted it again, #144) the worker marks ready (GraphQL
  `markPullRequestReadyForReview`) on the `opened` delivery, before it
  moves the card to In Review. The mutation
  names its repo in `x-cursor-github-repos`, since hosted github-proxy
  answers an unscoped `/graphql` with 400 (`cursor-demo-lab/marsbank#28`).
  A PR the worker could not undraft gets one Jira comment, `Ready for
  review not marked on <repo>#<n>: …`, and the worker retries on the
  task's redelivery and the PR's next push. If that comment appears and
  the PR stays draft, the HTTP status in it names the cause: 400 is the
  unscoped-proxy case (a worker built before #130), and 401 or 403 is the
  worker's `pr-write` scope. Mark the PR ready by hand. A person's own
  re-draft is never undone. Only a person's merge
  moves the card to Done. A bot merge or auto-merge never does, so keep
  auto-merge off.
- After rotating a slug's `JIRA_WEBHOOK_SECRET`, paste the same value into
  that rule's `X-Factory-Webhook-Secret` header. A stale header is a pod
  401 that the audit log reports as Success.
- Egress stays in each project's `hosting` block. A redeploy replaces any
  egress passed on the CLI.

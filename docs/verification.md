# Verification: what is proven on hosted v2

> **2026-09-26 note.** The matrix below was not re-run for this refresh.
> Since 2026-09-23 the factory has run as long-running autonomous agents
> on live tickets TLSSN-22 to TLSSN-31 (Slack intake through implement
> PRs on marsbank). The incidents from those runs and their fixes (#125 to
> #133) are [`deployment-issues.md`](deployment-issues.md) issues 15 to
> 22. All five are merged and redeployed: `factory-desk` for #129,
> #131, #132, and #133, and `factory-worker` for #130. The deployed
> commits in the table are older than those releases. Still unproven live: a hosted v2 hop-watch reminder firing on
> a stalled ticket (#132). The current backlog is
> [`next-steps.md`](next-steps.md).
>
> **BDK 0.2.11 note.** The rows below that cite these are updated. `logs --prod` now
> reads v2 slugs (`bdk logs --prod --slug <slug> [--session <id>]`);
> `sessions --prod` still refuses them (ask 3). The security reviewer's
> debug route is removed (#160) and `FACTORY_DEBUG_TOKEN` is deleted after
> the redeploy; its `github-event` and `review-posted` console lines show in
> `bdk logs --prod --slug factory-security-reviewer` for a delivery that
> started a review (a skipped one starts no session). 0.2.11 can deliver
> `reaction_added` to the hosted desk, and ✅ / ❌ on the filing prompt and
> plan post approve or decline (ask 7, reactions half): offline-proven
> (`slack.reactions.test.ts`, `verify-reactions.test.ts`), live-unproven
> until the Factory app carries a 0.2.11-or-later manifest and the desk is
> redeployed.

State as of 2026-09-23 (all times UTC unless marked local AEST). This page
lists, per agent, what "working" means, every check we run, the evidence
behind it, and who unblocks what is left. Only a check with a recorded
artifact (command output, session id, ticket comment, PR review, Slack
post) is marked **proven**. Everything else is **blocked** (a named
dependency outside our code stops it) or **gap** (not yet shown, or shown
broken in our code).

Levels:

| Level | Meaning |
| --- | --- |
| static | Typecheck, unit tests, `agent-sdk validate`, on the source at the deployed commit |
| deploy | The slug is `running` at a known commit, with the expected secrets and channels |
| credential | The slug's identity can reach the system it needs (Jira connector, GitHub App, pod `CURSOR_API_KEY`) |
| route | A delivery to the slug's route is accepted and reaches our handler |
| live | A real or replayed event produces the expected artifact and state change |

Deployed commit per slug (main releases, 2026-09-23). The v2 source ref is read
from `agent-sdk deployments --json` under `applications[].source.gitRef`;
`deployment <slug> --json` does not include it on v2. Every hosted release
reports runtime `@cursor/bdk 0.2.5` although the lockfiles pin
`@cursor/july` 0.2.2, so static evidence is for 0.2.2 (upgrade in flight on
`cursor/factory-july-0.2.5-54c8`).

| Slug | Commit | Release | When (UTC) |
| --- | --- | --- | --- |
| `factory-desk` | `9c33db8` (#68) | `09edc68a` | about 19:06Z |
| `factory-planner` | `ae036b4` (planner tree unchanged since #62) | `aaa5a13c` | 18:46Z to 18:48Z |
| `factory-worker` | `ae036b4` (worker tree unchanged since #62) | `ac6412ec` | 18:48Z |
| `factory-pr-autofixer` | `9c33db8` (#68: Slack channel removed; channels `drive`, `github`) | `7dcf6ddb` | about 19:14Z |
| `factory-triage-jira` | `ae036b4` | `9ece1c2c` | 18:5xZ |
| `factory-security-reviewer` | `ae036b4` (reviewer tree identical to #64's `f78fc21`) | `cfab6a4f` | 18:47Z to 18:48Z |

Standing checks for every slug (commands run from this directory, CLI
0.2.2 from each project's `node_modules`, principal from
`agent-sdk whoami`):

```bash
npm --prefix <project> run check
npm --prefix <project> test
npx agent-sdk validate --dir <project>
npx agent-sdk deployment <slug> --json   # filter to status, releaseId, source, lastError; never print the full body
npx agent-sdk secrets list <slug>         # names only
```

**Gap: CI runs none of these.** The only workflow,
`.github/workflows/managed-app.yml`, is orchestrator-owned (CODEOWNERS
`@example-org/security`, synced by `internal-app-orchestrator`). Its
`ci-required` job checks the owner, blocks policy-path edits, validates
`external-viewers.yml`, and runs gitleaks. It runs no project typecheck, test
or validate, and no `scripts/*.test.mjs` (so the copies-parity guard and the
`decide` lint protect nothing on their own). The repo cannot add a workflow:
`.github/workflows/*` is a policy path. Until the orchestrator offers a
per-app test hook, the merge gate is `scripts/merge-gate.sh`, run on a clean
checkout of the PR's final sha. Its summary block (sha, per-project
`npm ci`/check/test/validate, `node --test scripts/*.test.mjs`) goes in the
PR description, and a PR merges only when that block is all pass at the sha
being merged.

Two preconditions are advisory, because PRs are merged from the GitHub UI and
often ahead of the gate: `GATE_VALIDATED_SHA=<sha>` prints
`WARN  validator sha <x> != gated sha <y>` when the newest validator report
named another sha, and `GATE_MERGE_AFTER="<pr> ..."` prints
`WARN  Merge-after: #N open` for a dependency PR that is not merged. The WARN
lines appear in the gate block and never change the exit status.

**Evidence for decisions that start no turn** (skips, refusals, dedupe).
Silence is never proof. The only v2-readable record is the delivery
binding, and only for a delivery we sent (its 202 body carries the
`deliveryId`):

1. Send the probe and a signed control of the same shape on another key.
2. Poll `GET https://api.cursor.com/internal/agentsdk/deployments/<slug>/session-deliveries/<deliveryId>?teamId=<CURSOR_TEAM_ID>`
   (CLI API key) until it stops answering 404 (about 10 to 20 s).
3. Proven "refused with no turn" when the probe reads `skipped`, the
   control reads `allocated` with a `sessionId`, and the session count
   rose only by the control. The reason is inferred from the handler at
   the deployed ref; it is never stored.

This does not work for GitHub-routed deliveries (reviewer, fixer): their
ids come from Cursor's GitHub App and are never shown. It also cannot
separate refusal from acceptance on `factory-desk`, whose accepted
deliveries also read `skipped`. Every "expect no second X" or "is
skipped" claim below either cites this recipe with its ids, or is marked
offline-proven, live-unproven. Platform ask: [`bugs.md`](bugs.md) ask 3.

Sessions and pod logs: `sessions --prod` refuses v2 (issue 7). Since
0.2.11, `bdk logs --prod --slug <slug> [--session <id>]` reads v2 logs;
before that the reading was the dashboard session views
(`/api/v2/agent-serve/session-views/<app>/<session>`), the deployment
sessions API, and `agent-sdk session <id> --prod` (works on v2, only for
deliveries that made a session). `framework-files` is not a surface: it
answers 404 to the API key, needs a dashboard browser session, and by code
shows nothing for a skip or a host task. Artifacts on the
ticket, the thread, and the PR are the final evidence.

Issue numbers refer to [`deployment-issues.md`](deployment-issues.md);
ask numbers to [`bugs.md`](bugs.md).

## factory-desk

Working means: a Slack mention or DM starts a threaded conversation; `approve
file` creates a Jira ticket; a Jira move into Planned posts the plan into the
ticket's thread (or a short root in `#mars-eng-intake` for a Jira-filed
ticket); `approve KEY` from the originator moves the ticket to Approved; a
move into In Progress posts the cloud agent link into the thread.

Slack posts are at-least-once by design (claim leases, branch
`cursor/factory-desk-originator-threads-54c8`): a claim whose write could
not be verified expires after its lease, and the next delivery posts
again. A rare duplicate post is accepted; a silent drop is not.

| Check | Level | Command or procedure | Evidence | Status | Who unblocks |
| --- | --- | --- | --- | --- | --- |
| Typecheck, tests, validate | static | standing checks | `CHECK_EXIT 0`; 74/74 at `024e855`; `ok: factory-desk ... no diagnostics`. Not re-run at `7ecb0a1` for this page | proven (at `024e855`) | |
| Deployment | deploy | `agent-sdk deployment factory-desk --json` | `running` at `7ecb0a1`, `lastError` null, channels `jira`, `slack`, egress `slack.com`, `*.slack.com` | proven | |
| Secrets | deploy | `agent-sdk secrets list factory-desk` | `FACTORY_DESK_SLACK_BOT_TOKEN`, `FACTORY_JIRA_PROJECTS`, `FACTORY_REPOS`, `JIRA_WEBHOOK_SECRET`; `FACTORY_DESK_INTAKE_CHANNEL=C0EXAMPLE1` set 09:49Z. No `*_SLACK_APP_TOKEN`, which v2 Events API does not use (issue 2) | proven | |
| Slack app installed | credential | dashboard Slack card; app `A0EXAMPLE1` event subscriptions | Card `Installed`; request URL Verified; bot events `app_mention`, `message.im`, `app_home_opened` (issue 13) | proven | |
| Jira connector | credential | `CheckHttpMcpStatus` with the slug's `serviceAccountId` (host connections show no card, ask 2) | Consented per next-steps step 2. Desk-side Jira reads are shown only indirectly, by the Planned announce below | proven | |
| Jira route accepts | route | `node scripts/replay-jira-transition.mjs <desk URL> TLSSN-7 "In Progress" --from Approved --changelog-id 32143` | HTTP 202, `workflowId asd_f9ba023f...:evt:a0ec197c...` (10:21:53Z); Planned replays 202 for TLSSN-7 and TLSSN-8 | proven | |
| Outbound Slack on Planned | live | Planned replay to the desk route, then read `#mars-eng-intake` | `TLSSN-7 is planned` posted to `#mars-eng-intake` (`C0EXAMPLE1`) after the intake channel was set at 09:49Z | proven | |
| Desk refusals (unsigned Jira, wrong thread, not originator) | live | none | The desk's accepted signed deliveries also read `skipped`, so the binding cannot separate refusal from acceptance. Offline-proven only | offline-proven, live-unproven | Platform (ask 3) |
| Inbound Slack mention | live | `@factory-desk hello` in `#mars-eng-intake` | No reply, no fast-ack, 0 desk sessions ever (issue 13) | blocked | Platform: `agent_sdk_slack_events_dispatch` for team <CURSOR_TEAM_ID> |
| `approve file` creates a ticket | live | mention, file a bug, `approve file` | Never run: needs inbound Slack | blocked | Platform (issue 13) |
| `approve KEY` by originator only | live | approve as the filer, then as another user | Offline only, on branch `cursor/factory-desk-originator-threads-54c8` (11 fail-before tests); round 1 validator found a stale command record bypass (medium-high) | gap | In-flight fix, then platform (issue 13) for the live half |
| Every ticket post in its thread | live | Jira-filed ticket through Approved and In Progress: REST moves, then signed replays with the real changelog ids to the desk route | TLSSN-8 on release `abc65e16` (`ae036b4`): changelog 32213 (In Progress to Approved, 19:02:38Z) as `httpreq:a25529ef...`, 32214 (Approved to In Progress, 19:03:33Z) as `httpreq:b02c03cc...`; both 202, both bindings `skipped` (the desk never starts a turn). Thread not read: the desk bot token exists only on the pod. Jira `Slack thread` (`customfield_10388`) stays null; main does not write it | blocked | Simon: read `#mars-eng-intake` from 19:02Z for the TLSSN-8 root and its two replies |
| In Progress announce | live | replay In Progress after a real worker launch (TLSSN-8 at 12:26Z) | No thread read recorded for TLSSN-8 | gap | Coordinator: read the thread or intake channel |
| No GitHub path on the desk | deploy | `agent-sdk info` on `9c33db8` and the deployment read | Release `09edc68a` (`9c33db8`, #68): channels `http`, `jira`, `slack`; no MCP connection; one host connection `tracker` (Jira); no GitHub token or `FACTORY_REPOS` declared. Leftover unused secrets on the deployment: `FACTORY_REPOS`, `FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`. Dashboard card not read (needs a browser) | proven | Simon: unset the three leftover secrets |

## triage-jira

Working means: a Jira `issue_created` in `TLSSN` gets a `Triage:` comment
(type, severity, summary, next step, reporter), a `Duplicate of:` line when
an open ticket has the same title, and a move To Do to Triaged.

| Check | Level | Command or procedure | Evidence | Status | Who unblocks |
| --- | --- | --- | --- | --- | --- |
| Typecheck, tests, validate | static | standing checks | `CHECK_EXIT 0`; 37/37; no diagnostics (at `024e855`) | proven | |
| Deployment and secrets | deploy | `deployment`, `secrets list` | `running` at `a8a2775`; `JIRA_WEBHOOK_SECRET`, `FACTORY_JIRA_PROJECTS` set | proven | |
| Jira connector | credential | dashboard `/mcp-connectors?architecture=v2` | `Factory Atlassian Connected` | proven | |
| Webhook route | route | signed `jira:issue_created` replay via `scripts/e2e-drive.mjs --only ticket,triage` | HTTP 202 on TLSSN-5, 6, 7, 8 | proven | |
| Comment and move to Triaged | live | `node scripts/e2e-drive.mjs --new-ticket --replay --only ticket,triage` with a unique summary | [TLSSN-8](https://<JIRA_SITE>.atlassian.net/browse/TLSSN-8): session `<CURSOR_SESSION_ID>`, comment 15202 at 11:06:05Z, To Do to Triaged 11:06:07Z (changelog 32152). Fixed by #53 (prefixed tool names) | proven | |
| Duplicate detection | live | two tickets with the same summary | TLSSN-5 `Duplicate of: TLSSN-4`, TLSSN-6 `Duplicate of: TLSSN-5` (exact title match) | proven | |
| Refuses unsigned and wrong-signature webhooks | live | no-turn recipe above: forged probe plus signed control, read both bindings | 16:43Z: unsigned `httpreq:1ee933da...` and wrong-signature `httpreq:77f98d8c...` read `skipped`, signed control `httpreq:38d964c9...` reads `allocated` with `<CURSOR_SESSION_ID>...`; 17:47Z forged `httpreq:ea3fad1a...` reads `skipped`, session count unchanged at 9 | proven | |
| Real Jira system webhook (not a replay) | live | create an issue in the Jira UI, check for a second session | One session per ticket in every run, so no Jira-originated delivery was seen (not registered, or deduped) | gap | Simon: confirm the four webhooks in Jira admin, then create one issue by hand |

## planner

Working means: a move into Triaged gets a `Plan:` comment ending in a
`Brief:`, the plan pinned as an artifact, and a move Triaged to Planned; a
re-plan of the same ticket works; plans cite marsbank code.

| Check | Level | Command or procedure | Evidence | Status | Who unblocks |
| --- | --- | --- | --- | --- | --- |
| Typecheck, tests, validate | static | standing checks | 86/86 at `024e855`; 96/96 and 98/98 on the #62 branch | proven | |
| Deployment and secrets | deploy | `deployment`, `secrets list` | `running` at `7ecb0a1`; `FACTORY_REPOS`, `FACTORY_SANDBOX_REPO`, `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET`. `FACTORY_PLANNER_CHECKOUT` unset by design | proven | |
| Jira connector | credential | consent per slug (step 2) | Proven by the TLSSN-8 comment and move below | proven | |
| Webhook route | route | signed Triaged replay with the real changelog id | HTTP 202, 11:06:20Z | proven | |
| Fresh plan | live | `e2e-drive.mjs --ticket TLSSN-8 --replay --only plan` | Session `<CURSOR_SESSION_ID>`; comment 15203 at 11:08:28Z with `Brief:`; Triaged to Planned 11:08:31Z. Ran on `a8a2775`; not re-run on `7ecb0a1` | proven | |
| Refuses unsigned webhooks | live | no-turn recipe (probe plus signed control) | Not run; provable by the recipe | gap | Coordinator |
| Re-plan an already planned ticket | live | Triaged replay on TLSSN-7 | Fails: `v2: continuation belongs to session <CURSOR_SESSION_ID>` (session `<CURSOR_SESSION_ID>`). Fix is per-attempt continuation on [#62](https://github.com/example-org/demo-repo/pull/62), validated offline | gap | Merge #62, redeploy, re-plan TLSSN-7 |
| Plans grounded in marsbank code | live | plan a ticket whose path is on marsbank, check for file citations; plan a CSV-export ticket (TLSSN-18 shape) and expect `Needs info:` instead of a `Brief:` | Offline: `record_plan` refuses `evidence: "prompt"` and missing paths; `csv-not-on-sandbox` eval. Live still says `Evidence: ticket and request only, no checkout` until this ships | gap | This PR, then redeploy `factory-planner` (cursorAccount pass-through; no PAT) |

## factory-worker

Working means: a move into Approved with a `Brief:` on the ticket launches
one Claude Opus 5.5 cloud agent into `cursor-demo-lab/marsbank`, comments
`Implementing: <agent URL>`, and moves Approved to In Progress. A failed
launch leaves a `Launch failed: <code>` comment. A second approve never
launches twice.

| Check | Level | Command or procedure | Evidence | Status | Who unblocks |
| --- | --- | --- | --- | --- | --- |
| Typecheck, tests, validate | static | standing checks | 72/72 on the #61 branch head `3869949`; fail-before 3 tests on `b7bc994` | proven | |
| Deployment | deploy | `deployment factory-worker --json` | `running` at `ee648dd`, release `e777d921` (12:49Z) | proven | |
| Secrets | deploy | `secrets list factory-worker` | `FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`, `FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET`; `FACTORY_WORKER_SLACK_BOT_TOKEN` is orphaned (no Slack channel) | proven | Simon: remove the stray wizard app (issue 13) |
| Jira connector | credential | consent per slug | The 12:26Z run read the `Brief:` and wrote `Implementing:` | proven | |
| Pod `CURSOR_API_KEY` | credential | launch attempt reaches `POST /v1/agents` | TLSSN-8 attempts got API validation errors, not auth errors; then the 12:26Z launch succeeded | proven | |
| Jira route | route | `node scripts/replay-jira-transition.mjs <worker URL> TLSSN-8 Approved` | HTTP 202; pod log decision lines under `agentsdk/v1/factory-worker/logs/wf:...` | proven | |
| Launch on Approved | live | one-off deploy from `cursor/factory-worker-model-variant-54c8` @ `3869949` (release `512630a6`, 12:24Z), then TLSSN-8 Approved replay at 12:26:10Z | `Implementing:` comment with cloud agent `<CURSOR_AGENT_ID>`, ticket moved to In Progress. Earlier failures: name over 100 chars, then `invalid_model` for the effort-only variant | proven (on release `512630a6`) | |
| Launch on the main release | live | TLSSN-9 Planned to Approved by REST (changelog 32211, 18:59:06Z), signed replay with that changelog id to the worker route | Release `ac6412ec` (`ae036b4`): `httpreq:381d9e62...` 202, binding `skipped` (the route never starts a turn); `Implementing:` comment 15217 with cloud agent `bc-example-1` at 18:59:24Z and Approved to In Progress (32212) at 18:59:35Z; the agent opened [marsbank #13](https://github.com/cursor-demo-lab/marsbank/pull/13) | proven | |
| Agent name capped at 100 | live | Approved with a long summary | Offline only on [#62](https://github.com/example-org/demo-repo/pull/62) | gap | Merge #62 |
| `Launch failed:` comment | live | force a launch failure | Offline only on #62; main still fails silently on the ticket | gap | Merge #62, then one forced failure |
| One launch per ticket | live | byte-identical redelivery of changelog 32211, read the binding and the ticket | `httpreq:0be7629b...` 202 at 19:01:01Z, binding `skipped`; after 12 minutes TLSSN-9 still has one `Implementing:`, one agent move, one PR. The binding cannot tell dedupe from launch on this route; the ticket shows no second launch | proven (by ticket artifacts) | |

## pr-autofixer

Working means: a red `check_suite` or `workflow_run` on a PR whose title or
branch starts with a `TLSSN` key starts one drive session; the fixer's cloud
agent pushes a fix; CI goes green. A human `factory: drive` comment starts
the same drive. Bot comments never start one.

| Check | Level | Command or procedure | Evidence | Status | Who unblocks |
| --- | --- | --- | --- | --- | --- |
| Typecheck, tests, validate | static | standing checks | 33/33 at `024e855`; 37/37 on the delivery-send branch. `validate` warns `github.none/v2` continuation (every delivery a fresh session) | proven | Simon: pin `github.none/v2` or drop the three events |
| Deployment and secrets | deploy | `deployment`, `secrets list` | `running` at `b7bc994`, release `3b0a9598`, `lastError` null; `FACTORY_REPOS`, `FACTORY_JIRA_PROJECTS`, `PR_AUTOFIXER_SLACK_BOT_TOKEN` | proven | |
| Slack card | deploy | dashboard | `Pending Installation` although a bot token exists; branch `cursor/factory-remove-desk-github-54c8` removes the fixer's Slack | gap | In-flight fix |
| GitHub App covers marsbank | credential | `gh api orgs/cursor-demo-lab/installations` | `cursor`, `repository_selection: all`; installation team-owned (next-steps) | proven | |
| CI events reach the fixer | route | push a commit that keeps CI red on [marsbank #8](https://github.com/cursor-demo-lab/marsbank/pull/8) | Session `<CURSOR_SESSION_ID>` (github, event, hibernated) 18 s after the red suite at 11:24:16Z. Main release `7dcf6ddb` (`9c33db8`): cloud agent `<CURSOR_AGENT_ID>` pushed `e0ab306` at 19:15:52Z, run `35908154381` red at 19:17:31Z, new session `<CURSOR_SESSION_ID>` (github, event) at 19:17:51Z with zero executions; the decision inside (drive refused at admission, or the old once-per-PR claim) is not readable on v2 | proven (event received) | |
| PR URL and head read | route | same | #52 (API URL) and #60 (REST head read) moved the event past routing and the factory-PR test into the claim | proven | |
| Drive starts on red CI | live | same; expect a `drive` session, a push, CI green | No drive session, no push: the task's send is refused in the hosted admission window (`HostedAdmissionLocalSendError`). Fixed in source by #72 (`892fada`), which sends through the delivery's own send; BDK 0.2.6 hands that send to `{ task }` and captures it (`internal/channel-dispatch.js`). No fixer redeploy after #72 is recorded, and none has been read live | gap | Simon: redeploy from main ([next-steps](next-steps.md) step 13) |
| Human `factory: drive` | live | Simon comments `factory: drive` as `example-user` on #8 | Never posted; on `b7bc994` it would fail the same way as red CI | gap | Redeploy, then Simon |
| Auto-drive skip (not a factory PR, already claimed) | live | none on v2 | GitHub delivery ids are never shown, so no binding can be read. Offline-proven only | offline-proven, live-unproven | Platform (ask 3) |
| Bot comments ignored | live | `cursor[bot]` comment on marsbank #7 | Dropped at webhook ingress (issue 12, ask 4). Platform behaviour, not our filter | proven | |

## security-reviewer

Working means: an eligible marsbank `pull_request` delivery (`opened`,
`reopened`, `synchronize`, `ready_for_review`, or an `edited` base retarget
that carries `changes.base`) starts a PR-owned review session, reads the
compare diff pinned to that delivery's base sha and head sha, and posts one
advisory `## Security review` COMMENT from `cursor[bot]` at that head.
Eligible means a non-draft PR, or a factory draft: its head branch starts
with a `FACTORY_JIRA_PROJECTS` key, or its title does and `cursor[bot]`
authored it. A later delivery with the same evidence identity (repository,
PR number, base sha, head sha) is skipped on a best-effort basis, not
exactly once: there is no compare-and-set on `host.kv`, two deliveries
before the record lands both review, and a lost record reviews again. A
returned diff over 150,000 characters posts `INCOMPLETE`, never `CLEAN`,
and a repeat of that base and head is skipped (`already_reviewed_incomplete`)
until the cap can hold the whole diff. A delivery without `base.sha`, or a
record written before the base was recorded, always reviews.

Release `cfab6a4f` runs main's reviewer tree from #64 (`f78fc21`), which
keys the skip on the head only: a changed base at the same head is
suppressed there. The base-plus-head identity ships with
`cursor/factory-reviewer-followup-54c8` and the redeploy after it. By
source (everysphere `githubWebhook.ts` to July `hosted-delivery.js`), hosted
v2 hands the channel the full webhook body, so a base retarget is reviewed
on the `edited` delivery; only the `--cursor-events` relay's metadata
fallback (an envelope over 256 KiB) lacks `changes`. Not yet observed live.

Merged [#64](https://github.com/example-org/demo-repo/pull/64)'s title
and the squash subject on main (`280cf50`) say "once per head". That is
wrong twice: the skip is best effort, and the identity is base plus head.
A merged commit subject cannot be changed; this page is the correction.

| Check | Level | Command or procedure | Evidence | Status | Who unblocks |
| --- | --- | --- | --- | --- | --- |
| Typecheck, tests, validate, evals | static | standing checks plus `agent-sdk eval --dir security-reviewer` | Main `9c33db8` (reviewer tree unchanged since `f78fc21`), July 0.2.2: check exit 0, 75/75, validate clean, evals 2/2, 32/32 claimed mutants killed (validator on `f78fc21`). Follow-up branch: 89/89, evals 2/2 with an unfiltered one-`post_findings` gate | proven offline | |
| Deployment and secrets | deploy | `deployment`, `secrets list` | Read 2026-09-24: `running`, release `cfab6a4f-de63-4124-b684-408907bf8690`, `lastError` null; `FACTORY_DEBUG_TOKEN`, `FACTORY_JIRA_PROJECTS`, `FACTORY_REPOS`; repo `cursor-demo-lab/marsbank`. The read returns no source ref; `ae036b4` is from the redeploy record. Runtime July 0.2.5 while every lockfile pins 0.2.2 | proven (release); ref from record | |
| GitHub App covers marsbank | credential | `gh api orgs/cursor-demo-lab/installations` | `cursor`, all repositories | proven | |
| PR events reach the reviewer | route | open a PR on marsbank | Sessions on #8, #9, #10 with `dispatched: true` | proven | |
| Review on open | live | cloud agent opens a PR as `example-user` with a planted bug | [marsbank #10](https://github.com/cursor-demo-lab/marsbank/pull/10), session `<CURSOR_SESSION_ID>`, [review 1](https://github.com/cursor-demo-lab/marsbank/pull/10#pullrequestreview-5290105513) on `f502193` (command injection, high) 52 s after open | proven | |
| Review after a push from another identity | live | cloud agent pushes `48cafd9` as `cursoragent` | Turn 2 in the same session, no `SessionAuthError`, [review 2](https://github.com/cursor-demo-lab/marsbank/pull/10#pullrequestreview-5290173890) on `48cafd9`. Fixed by #51 (`cont:` keys) and #54 (PR-owned principal) | proven | |
| Review on a push to a factory draft | live | cloud agent `<CURSOR_AGENT_ID>` pushes one README line to [marsbank #11](https://github.com/cursor-demo-lab/marsbank/pull/11) (`cursor[bot]` draft, branch `TLSSN-8-csv-export-zero-rows`) | Release `cfab6a4f` (`ae036b4`): push `8e0f0af` by `cursoragent` at 18:58:42Z; [review 5295435981](https://github.com/cursor-demo-lab/marsbank/pull/11#pullrequestreview-5295435981) by `cursor[bot]`, `commit_id` `8e0f0af`, `**Verdict:** CLEAN`, 18:59:25Z; still the only review on that head at 19:13Z. Fixed by #64 (merged title says 'once per head'; the behaviour is best effort per head) | proven | |
| Debug route readable | route | `GET <alias>/v1/channels/debug/events` with `x-factory-debug` | Always `202` with a workflowId; v2 drops the handler's response | removed (#160; use `bdk logs --prod`, which shows the `github-event` and `review-posted` lines) | |
| Factory draft reviewed on the main deployment | live | push a non-empty planted exploit to a worker-opened `cursor[bot]` draft on a `TLSSN-` branch; read `gh api repos/cursor-demo-lab/marsbank/pulls/<n>/reviews` for `**Verdict:** FINDINGS` with `commit_id` equal to the pushed head | Worker agent `bc-example-1` (TLSSN-9) opened [marsbank #13](https://github.com/cursor-demo-lab/marsbank/pull/13) as `cursor[bot]` at 19:03:25Z; [review 5295502095](https://github.com/cursor-demo-lab/marsbank/pull/13#pullrequestreview-5295502095) on head `9f0ba2e` at 19:05:40Z, `**Verdict:** FINDINGS` (medium, CSV formula injection). #11 CLEAN on a README-only push is the admission row above | proven |
| Same base and head skipped (`already_reviewed`, `already_reviewed_incomplete`) | live | none on v2 | A decision that starts no turn leaves no session and no review, GitHub delivery ids are never shown, and `logs --prod` refuses v2. Unit tests on merged `280cf50` (head only) and on the follow-up branch (base plus head) | offline-proven, live-unproven | Platform (ask 3) |
| Changed base at a fixed head reviews again | static | `github.test.ts` "a fixed head against a changed base is reviewed again against the new base, then suppressed for that pair" | Fails on main `9c33db8` (`already_reviewed` where `review_factory_draft` is expected), passes on the follow-up branch | offline-proven, live-unproven | Redeploy after merge |
| Base retarget reviewed on the `edited` delivery | live | after the redeploy, change a watched marsbank PR's base branch in the GitHub UI without pushing; read `gh api repos/cursor-demo-lab/marsbank/pulls/<n>/reviews` for a new review at the unchanged head | Offline: `github.test.ts` "an edited delivery that retargets the base reviews; an edit of the title or body does not" fails on main `9c33db8` (`action_skipped`) and passes on the follow-up branch. By source, hosted v2 passes the webhook body with `changes.base`. No retarget has run live | offline-proven, live-unproven | Redeploy after merge, then Coordinator |
| Loud failure on a broken post | live | force `post_findings` to throw | #64 changed the instructions ("Never report a clean review that was not posted"). The #8 session that reported "0 findings. Clean review." after the tool failed predates it; no forced failure has run since | gap | Agent |

## Full chain across agents

One ticket from Slack to a reviewed, green PR. Hops in order, with the best
evidence for each.

| Hop | Evidence | Status |
| --- | --- | --- |
| Slack mention, `approve file` to ticket | Inbound Slack never reaches the desk (issue 13) | blocked |
| Ticket to Triaged | TLSSN-8 (replayed `issue_created`) | proven |
| Triaged to Planned with `Brief:` | TLSSN-8 | proven |
| Planned to plan post in Slack | `TLSSN-7 is planned` in `#mars-eng-intake` | proven |
| `approve KEY` to Approved | TLSSN-8 moved by REST (the board path), not by the desk | gap (Slack half blocked) |
| Approved to cloud agent and In Progress | TLSSN-9 on main release `ac6412ec`, `bc-example-1`, 18:59Z (earlier TLSSN-8 on a branch release) | proven (main release) |
| In Progress to link in the thread | Not read | gap |
| Cloud agent PR to security review | Worker agent `bc-example-1` (TLSSN-9) opened draft [marsbank #13](https://github.com/cursor-demo-lab/marsbank/pull/13) as `cursor[bot]` at 19:03:25Z; [review 5295502095](https://github.com/cursor-demo-lab/marsbank/pull/13#pullrequestreview-5295502095) on head `9f0ba2e` at 19:05:40Z, `**Verdict:** FINDINGS` (medium, CSV formula injection in `lib/transactions-csv.ts:14`) | proven |
| Implement PR opens to In Review (worker GitHub channel) | Offline only: `factory-worker` tests drive `github.ts` through July's `dispatchGitHubWebhook` (a `{ task }`, no turn) against a fake tracker. Needs the worker redeployed with `--cursor-events-repo cursor-demo-lab/marsbank`, then a new implement PR or a push to an open one | offline-proven, live-unproven |
| In Review to "KEY is In Review" in the thread | Desk handler shipped in #90; needs In Review on the desk's Automation trigger | gap |
| Red CI to fixer push to green | Stops at the admission send (fixer table) | gap |
| Human merge to Done (worker GitHub channel), then "KEY is Done." | Offline only, as above: a person's merge moves In Review → Done; a `cursor[bot]` merge or auto-merge moves nothing. Branch protection is still not available (below), so nothing but convention stops an early merge | offline-proven, live-unproven |

No single ticket has run the whole chain. The next full run needs #62 and
the fixer delivery-send fix merged and deployed, and a ticket approved on the
main worker release.

## Blocked on platform

| Blocker | Effect | Evidence | Who unblocks |
| --- | --- | --- | --- |
| Slack dispatch gate `agent_sdk_slack_events_dispatch` (issue 13) | No inbound Slack: no mention, DM, `approve file`, or `approve KEY` reaches the desk. Outbound posts work | 0 desk sessions ever; events route verified; gate defaults false. Inferred, not read | Gate owner: teamID rule for <CURSOR_TEAM_ID>, or confirm outcome `gated` for `A0EXAMPLE1` |
| No v2 logs and no host-decision log (issue 7, ask 3) | A skip is readable only as a bare `skipped` status, only with a `deliveryId` we sent; no reason, no list, nothing for GitHub deliveries | Before 0.2.11, `logs --prod` and `sessions --prod` exit 1 on v2 (0.2.11: `logs --prod` works, `sessions --prod` still exits 1); forged triage delivery `httpreq:ea3fad1a...` reads `skipped` with no reason; desk's accepted control also reads `skipped` | Agent SDK team |
| Branch protection on GitHub Free | `cursor-demo-lab` is on plan `free` and marsbank is private, so `main` cannot require `CI / test` or a review | `gh api repos/cursor-demo-lab/marsbank/branches/main/protection` answers 403 "Upgrade to GitHub Pro or make this repository public" | Org owner: upgrade the org, or make marsbank public |
| Per-slug connector consent (ask 1) and hidden host connections (ask 2) | Each Jira slug needs its own consent; host-connection slugs show no card; `mcp oauth` refuses v2 | Four service accounts, four consents | Platform |
| `check_run` and bot comments never forwarded (ask 4) | Fixer must use `check_suite`/`workflow_run`; `factory: drive` must be typed by a person | marsbank #6, #7 | Platform |
| No interactivity on v2 (ask 7) | Cards unused. `reaction_added` arrives on 0.2.11, so ✅ / ❌ approve or decline alongside the typed commands once the app has the 0.2.11 manifest (`reaction_added`, `reactions:read`) | v2 manifest events | Platform (interactivity only); us for the app manifest update |
| No multi-component deploy, no hosted peers (ask 8) | Six single-slug deploys; Jira is the only bus | 403 on `--all` | Platform |
| Registry model params (ask 9) | `grok-4.7` needs `reasoning_effort`, not `effort` | Fixed in our config (#42) | Platform (alias), not blocking |
| Exact repositories, 20 per owner (ask 10) | Scale limit only | July parser | Platform, not blocking the demo |
| Cross-team installation (ask 5) | Resolved for marsbank by the Bugbot toggle | next-steps "Done since #37" | Not blocking |
| No compare-and-set on agent kv | `ctx.host.kv` is plain `get`/`put`/`delete` on every backend, so every claim and dedupe in the factory is read-then-write (best effort). Code guarded by `supportsKvCas(ctx.host.kv)` never runs | July 0.2.2 dist: `internal/session-engine.js:317` builds kv via `createHostKvApi`; `internal/host-kv.js:22-34` returns only `get`, `put`, `delete` for both the hosted storage path (`storage-coordinator.js:514-536`) and the local filesystem store; `types.d.ts:560-567` says the agent-facing kv stays plain. CAS (`putIfVersion`) exists only for framework files | Platform (expose the `cas` group to `host.kv`); until then there is no exactly-once: external checks (Jira status, `Agent.create` idempotency keys, whose behaviour on concurrent creates is unverified) only narrow duplicates. Rechecked on 0.2.11: [bugs.md ask 11](bugs.md) |

## In-flight fixes

From the V&V rounds. Each lists what it will prove once merged and
redeployed.

| Round | PR or branch | Will prove | Owed after merge |
| --- | --- | --- | --- |
| 1a | [#61](https://github.com/example-org/demo-repo/pull/61) (merged, main `ee648dd`) | Worker launches the full Opus 5.5 variant | One launch on release `e777d921` |
| 1b | [#62](https://github.com/example-org/demo-repo/pull/62), `cursor/factory-worker-planner-fixes-54c8` | Agent name capped at 100; `Launch failed: <code>` on the ticket; planner re-plans on a fresh continuation | Re-plan TLSSN-7; one forced `Launch failed:` comment. Open lows: SDK `NetworkError` cause chain, non-JSON 5xx, one doc diagram |
| 1c | `cursor/factory-desk-originator-threads-54c8` | Only the filer can approve; every ticket post is in its thread | Round 2 validation (stale command record fix); live half needs issue 13 |
| 1d | `cursor/factory-fixer-delivery-send-54c8` | Red CI and human `factory: drive` start a drive through the delivery's own send | Push to #8, expect a drive session, a fixer push, CI green. Validator: add a sender check on `factory: drive` (low to medium) |
| 1e | `cursor/factory-remove-desk-github-54c8` | Desk has no GitHub path; fixer has no Slack; manual override is a human `factory: drive` | Redeploy desk and fixer; fixer Slack card gone |
| 1f | `cursor/factory-grounded-plan-54c8` | Plans cite marsbank code with a structured risk section | Plan a fresh ticket |
| 1h | `cursor/planner-verify-repo-before-plan-b005` | Planner verifies the claimed failure on the sandbox before `record_plan`. Mismatch (TLSSN-18 / no CSV export on marsbank main) is `Needs info:`, no `Brief:`, no Planned move. Match cites checkout paths | `npm --prefix planner test`; `agent-sdk eval --dir planner` when a Cursor credential is present; after deploy, replay a CSV-export ticket and a real marsbank path |
| 1g | `cursor/factory-ticket-lifecycle-thread-54c8` (not yet pushed) | The whole ticket lifecycle lands in one Slack thread; Jira holds the thread id | One ticket through In Progress |
| 3d | `cursor/factory-reviewer-followup-54c8` | Reviewer skips only on the same base and head; separate `already_reviewed_incomplete`; git-quoted paths keep lockfile order and cut-file names | Redeploy (factory-draft FINDINGS already proven on marsbank #13) |

## Demoted claims

Claims made elsewhere as proven or done without the evidence to back them,
or later disproved. Each is corrected here; the source doc should follow.

| Claim | Where | Why demoted | Correct status |
| --- | --- | --- | --- |
| "Every edge below is live on hosted v2 once the four Jira system webhooks exist" | `deployment-issues.md`, Chain edges | Desk to fixer and GitHub to fixer have never produced a drive; Slack to desk is gated | Edges into triage, planner, worker, reviewer proven; desk inbound blocked; fixer gap |
| Reviewer delivery is "lost after the Temporal handoff or in the guest" (H1); read it through the debug route | `deployment-issues.md` issue 12, `next-steps.md` | The reviewer had sessions all along; the real faults were the `cont:` key and the per-sender principal. The debug route always answers 202 on v2 | Disproved; reviewer proven after #51 and #54 |
| Jira webhooks "Status: enabled" | `jira-webhooks.md` | Every observed delivery was a signed replay; no Jira-originated second session appeared | Gap until one issue created by hand triggers triage |
| "Recommend system webhooks. Proven." | `scaling-and-integration.md` 2.4 | Same: no live system webhook delivery observed | Recommendation stands; delivery unproven |
| "Dedupe ... Proven on six slugs." | `scaling-and-integration.md` 2.4 | Claims are pinned by tests; live dedupe is not shown on any slug, and the reviewer has no claim | Offline proven; live gap |
| "Approval gates: `approve file` and `approve KEY`, or the board move ... Proven." | `scaling-and-integration.md` 2.7 | Neither Slack command has ever run on hosted (issue 13) | Board move proven (TLSSN-8); Slack commands blocked |
| "Audit: each stage leaves a comment and a transition. Proven." | `scaling-and-integration.md` 2.7 | Fixer and desk approve have left nothing yet | Proven for triage, planner, worker |
| "Debug route ... Proven as built (#44), not yet read after a live PR" | `scaling-and-integration.md` 2.6 | It cannot be read on hosted v2 | Blocked (ask 3) |
| "The Opus launch gate is untested" | `scaling-and-integration.md` 2.5 | Stale the other way | Proven on release `512630a6` |
| `factory: drive` "should start a drive on 2eb526c without the patch" | project store `internal/verify-fixer.md` (first run) | Hosted admission refuses the task's send on that path too | Gap until the delivery-send fix |
| Worker pod principal "refuses `claude-opus-5-5`" (W2) | `internal/verify-jira-chain.md` | The refusal was the effort-only variant; the full variant launched | Superseded by 1a |
| User key "accepted effort-only params" | round 1a claim | Exercised only the SDK pre-flight id check, which ignores params | Withdrawn in round 2 |
| Run 3 triage pass on TLSSN-7 | `internal/verify-jira-chain.md` | An overlapping driver run made the move | Invalid; triage proven on TLSSN-8 instead |
| Driver "Atlassian connector not authorised" | `scripts/e2e-lib.mjs` inference | The connector was authorised; tool names were unmatched (#53) | Inference wording owed |
| "No desk delivery has ever booted a desk pod" | `internal/verify-jira-chain.md` | The desk posted `TLSSN-7 is planned` from a Planned delivery | Jira route proven; only inbound Slack blocked |
| "A command record is used once" | `factory-desk` README on the originator branch | A command-shaped phrase no tool consumed stays in kv and vouches for the next caller | Fix owed in round 1c |
| Reviewer "0 findings. Clean review." on #8 | session `<CURSOR_SESSION_ID>` | `post_findings` had failed; the model reported clean | Wrong output; loud-failure instruction owed |
| Real-event GitHub tests "Not yet" | `next-steps.md` table | Stale: reviewer proven on #10 | Reviewer proven; fixer rows still gap |
| "Security reviewer reviews factory draft PRs, once per head" | #64 title, squash subject of `280cf50` | The skip is best effort (no compare-and-set), and a head-only key suppressed a changed base at the same head | Best effort per base and head (follow-up branch); factory draft review proven on #11 CLEAN and #13 FINDINGS |

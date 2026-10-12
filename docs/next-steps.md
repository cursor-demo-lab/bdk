# Next steps

State on 2026-09-26, after the P0/P1 UX hillclimb (#129 to #133) shipped
on `main` and was redeployed.

The factory runs as six long-running autonomous agents on hosted v2:
desk, triage, planner, worker, pr-autofixer, and security-reviewer. They
carry a ticket from Slack or Jira intake through triage, plan, approve,
the implement PR, review gates, and Done. People step in at
`approve file`, `approve KEY`, and the merge. This page is what is left to
make that loop trustworthy without anyone watching it. The runbook is
[`factory-deployment.md`](factory-deployment.md). Each incident that was
worked past is in [`deployment-issues.md`](deployment-issues.md). Platform
asks are in [`bugs.md`](bugs.md). Per-agent proof is in
[`verification.md`](verification.md).

## Shipped and worked past

| PR | Commit | What changed for the operator | Slugs |
| --- | --- | --- | --- |
| #129 | `25cefb32` | The security line posts only when the verdict or scope fingerprint changes. A harmless push that keeps CLEAN adds nothing ([issue 20](deployment-issues.md#20-the-security-line-repeated-on-every-harmless-push)) | desk |
| #130 | `97612fc1` | Ready-on-open GraphQL names its repo for hosted github-proxy. Three tries, then push and redelivery retries, then one `Ready for review not marked` Jira note. A person's re-draft stays a draft ([issue 18](deployment-issues.md#18-marsbank28-the-implement-pr-stayed-a-draft-github-proxy-graphql-scope)) | worker |
| #131 | `51164b9b` | A Jira-filed ticket gets its intake root at Triaged, stage reactions on the root, and one `Slack thread:` backlink on the ticket ([issue 22](deployment-issues.md#22-a-ticket-filed-in-jira-had-no-slack-thread-until-planned)) | desk |
| #132 | `9b2fc10c` | Durable hop watchdogs for triage, plan, and launch stalls, plus the filer's `@factory retry KEY` ([issue 21](deployment-issues.md#21-a-stalled-hop-left-the-thread-on-a-loader-with-no-explanation)) | desk |
| #133 | `364a2941` | Triaged, Needs info, outcome, and thread-detail claims settle before posting, and use CAS once the platform exposes it ([issue 19](deployment-issues.md#19-concurrent-deliveries-both-won-a-claim-no-kv-compare-and-set)) | desk (and the `claim-lease.ts` copy in pr-autofixer) |

Earlier on `main`, and still in force:

- #116: Jev on the Triaged line, status reactions, the Slack link on the
  ticket and the PR, a phone-sized plan post, and one beat for the filed
  and approve replies.
- #118: every implement PR opens with `Jira:` and `Slack:` lines.
- #120 and #124: one ✅ on `approve file`, `deny file`, and `approve KEY`.
- #121 and #125: one Triaged line per verdict, and one Needs info per
  Triaged entry.
- #122 and #127: review updates in Slack for Bugbot, security, CI,
  autofix, and change-monitor, each with its emoji prefix.
- #123: a replan uses the Needs info reply, and a silent plan gets a
  thread line after 15 minutes. #132 replaced that line with the plan
  hop watch.
- #126: every factory PR is ready for review on open, because Bugbot
  skips drafts.
- #128: the reviewing crumb names the gates still pending after In Review.

## Open, highest leverage first

1. **Platform compare-and-set on agent kv.** Simon, to the Agent SDK
   team. #133's settle window is best effort: a rival put slower than
   `FACTORY_DESK_CLAIM_SETTLE_MS` (2 s) can still duplicate a line. The
   CAS path in `claim-lease.ts` switches on by itself once `ctx.host.kv`
   implements `HostKvCasApi`
   ([`bugs.md`, ask 11](bugs.md#ask-11-ctxhostkv-has-no-compare-and-set-or-conditional-put)).
2. **Operator guard: one Jira delivery source per slug.** The factory
   cannot tell a second delivery of one transition from a new entry, so
   TLSSN Automation plus a site system WebHook doubles every planner run
   and every thread line. This is deliberate
   ([`jira-automation.md`](jira-automation.md#one-delivery-source)). Re-check
   operator checklist step 1 after any Jira admin change. Open idea: have
   `scripts/doctor.mjs` or the e2e driver flag two distinct changelog-id
   shapes for one transition.
3. **In Progress → In Review watchdog.** The cloud agent run can take
   hours, so this hop needs a longer deadline and a line that tells a slow
   run from a dead one. It is one `HOPS` entry, one arm in
   `channels/jira.ts`, and one `retry` branch
   ([`event-driven-factory.md`](event-driven-factory.md#hop-watchdogs-a-stalled-hop-is-announced)).
   The other watch gaps: a Jira-filed ticket whose triage never runs (no
   root, so no watch), and a reminder whose create call fails on v2,
   which only the sweep would cover and v2 does not fire it.
4. **Prove a hop watch live.** #132 is unit-tested against July's
   reminder discovery but has not fired on a hosted v2 stall. One stalled
   ticket after the redeploy (a Jira rule turned off for one hop, say)
   should end in the hop line and then a working `retry KEY`.
5. **Security-reviewer posts one GitHub review per head.** Slack is per
   verdict change since #129. Suppressing the GitHub review too needs
   `scripts/e2e-lib.mjs` `review` to accept an earlier head's CLEAN when
   the diff since then is unchanged in security terms. That is a design
   change, not a wording one.
6. **A Slack crumb for `Ready for review not marked`.** #130 writes the
   Jira note, but the desk does not parse it yet. It needs a desk outcome
   parser plus a row in `scripts/outcome-sentinels.test.mjs`.
7. **Change-monitor in the reviewing crumb: deferred.** Its sticky
   comment says nothing while Pending or Monitoring, so the crumb cannot
   tell "not yet" from "not watched". Change-monitor still posts its own
   review update line when it settles.
8. **Autofixer pushes name their ticket.** A `KEY:` prefix on the fixer
   agent's commit subjects, and one reply per Bugbot thread it resolves,
   would make the review timeline readable.
9. **`approve KEY` host-path misses.** TLSSN-27 and TLSSN-28's exact
    approves got the model path. Both paths now add the same ✅ and one
    beat. Read `{"desk":"approve_command","outcome":…,"why":…}` on the
    next miss to find the gate.
10. **Make `scripts/doctor.mjs` hosted-aware.** It still requires
    `FACTORY_DESK_SLACK_APP_TOKEN`, which hosted v2 never has.

## Operator and platform follow-ups carried from #37

These are not code on `main`. Each is done once, by the named person.

- **Platform:** `agent-sdk slack create` in 0.2.x drafts a v1 app and
  fails with `v1_create_closed`. Use the v2 wizard curl
  ([`deployment-issues.md`](deployment-issues.md), issues 1 and 2).
- **Simon:** confirm the fixer's bot identity. A person types
  `factory: drive` on a marsbank PR, and the fixer's own later comment
  starts nothing. Bot-authored comments never reach v2 (issue 12).
- **Simon:** retire stray wizard Slack apps and secrets on
  `factory-worker` and `factory-pr-autofixer`
  (`agent-sdk secrets unset factory-pr-autofixer PR_AUTOFIXER_SLACK_BOT_TOKEN`).
  `factory-desk` is the only Slack agent (issue 13).
- **Simon:** tidy marsbank: close stale Dependabot PRs, and require
  `CI / test` and one review on `main`.
- **Anyone:** `node scripts/e2e-drive.mjs` drives the chain by signed
  replay with `FACTORY_E2E_GITHUB_TOKEN`, or in `--github=cloud-agent`
  mode without it. It proves the handlers, not that Automation delivered.

The desk has no GitHub write path. Asked to fix a pull request, it tells
the person to type `factory: drive` on the PR. The fixer's automatic drive
on a factory PR's first red check is the main path.

Deploy commands in older revisions of this page prefixed
`env -u CURSOR_API_KEY -u CURSOR_SERVICE_ACCOUNT_KEY`. That is out of date
for this team. Use [`factory-deployment.md`](factory-deployment.md#deploy-credential).

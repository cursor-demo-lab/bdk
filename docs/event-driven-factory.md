# Event-driven factory (hosted v2)

The factory is six long-running autonomous agents, always on, one hosted
slug per stage. Together they carry a ticket from Slack or Jira intake
through triage, plan, approve, the implement PR, review gates, and Done.
Jira is the bus and the ticket's status is the event. No agent calls
another agent. Every hop is: write the artifact to the ticket, move the
ticket, and the next agent wakes on the status it moved to. The desk
watches the hops in between. A stall is announced in the ticket's thread
(hop watchdogs, below), and the filer recovers it with `retry KEY`. The
operator runbook is [`factory-deployment.md`](factory-deployment.md).

Sources: store notes `july-event-driven-approach.md` and
`everysphere-slack-patterns.md` (mirrored beside this file); sandy at
`<PRIVATE_MONOREPO>/factory/sandy`; everysphere `main` @ `9a4aaa4`;
`@cursor/july` 0.2.1 `dist/docs`. Decisions in this file are Simon's
(2026-09-22 and 2026-09-23) unless marked as a finding.

## The six agents

| Stage | Project dir | Hosted slug | Wakes on | Writes | Moves ticket to |
| --- | --- | --- | --- | --- | --- |
| Front door | `factory-desk` | `factory-desk` | Slack mention or DM (a filing request is judged by Jev before the filing prompt); Jira `issue_updated` into `Triaged`, `Planned`, `Approved`, `In Progress`, `In Review`, `Done` | Jira issue filed already triaged (`file_ticket`: type, `Triage:` comment); Slack posts; Jira transition to `Approved` | `Triaged` (on `approve file`), `Approved` (on `approve KEY`) |
| Triage | `triage-jira` | `factory-triage-jira` | Jira `issue_created` for a ticket filed in Jira (desk-filed tickets carry `DESK_TRIAGED_LINE` and are skipped) | `Triage:` comment | `Triaged` |
| Plan | `planner` | `factory-planner` | Jira `issue_updated` into `Triaged` | `Plan:` comment with a `Brief:` section; `plan` artifact | `Planned` |
| Implement | `factory-worker` | `factory-worker` | Jira `issue_updated` into `Approved`; GitHub `pull_request` on the implement PR | Cloud agent launch; `Implementing:` comment with the agent URL | `In Progress`; `In Review` when the PR opens; `Done` when a person merges it |
| Fix | `pr-autofixer` | `factory-pr-autofixer` | GitHub PR, check, comment events | Pushes; `gh` workflow actions | none |
| Review | `security-reviewer` | `factory-security-reviewer` | GitHub `pull_request` opened / synchronize | One `COMMENT` review | none |

The sandbox repository is `cursor-demo-lab/marsbank` (`FACTORY_REPOS`,
`FACTORY_SANDBOX_REPO`), a snapshot of `cursor-demo-lab/marsbank`. The
agent source stays in `example-org/demo-repo`. The move is
`deployment-issues.md` issue 10.

The desk is Slack only. It files tickets, relays approvals as a Jira
transition, and announces plan and progress into the thread that filed
the ticket. It launches nothing. Only `factory-worker` holds the cloud
launch scope and the sandbox repository.

## From sandy

Sandy is one July host that watches Slack, decides in host code, claims a
natural key in `host.kv`, and dispatches a Cursor cloud session through
`@cursor/sdk` `Agent.create` with `idempotencyKey`. It never calls
another agent.

**Follow.** Host-side decide and actuate. Pure `decide()` over the event
body, unit-tested on fixtures. A claim in `host.kv` before actuation;
release only when dispatch never started. `host.kv` has no compare-and-set
(July 0.2.13: get, put, delete), so a claim is read, put, and, where it
matters, read back after a settle wait; it narrows the race between two
deliveries but is not atomic across sessions. Thread refs as
`{channelId, threadTs}` under a natural key. HMAC on every webhook.
`Agent.create` with `idempotencyKey` = the claim key (how the platform
treats two concurrent creates with one key is unverified). A dedupe test
that races two deliveries at the claim. A synthetic replay script.

**Do not follow.** Sandy is one slug. This factory keeps a slug per
stage: the stages are the teaching point, each has its own artifact and
its own blast radius. Sandy watches a Slack channel; the desk stays
mentions and DMs. Sandy dispatches triage as a cloud session; here triage
and planning are July turns on their own slugs, and only implementation
is a cloud session. No `defineSchedule` `run` handler carries a stage
(they do not compile to Temporal calendars on v2). The desk's hop
deadlines use named-handler reminders, which v2 does fire. Its one
schedule is only a self-hosted backstop ("Hop watchdogs").

## Workflow

The sandbox project `TLSSN` needs these statuses, in this order. Names
are configurable per slug (`FACTORY_STATUS_*`); these are the defaults.

```
To Do → Triaged → Planned → Approved → In Progress → In Review → Done
```

`To Do`, `In Progress`, `In Review`, `Done` are Jira's default software
workflow. `Triaged`, `Planned`, `Approved` are added in Project settings
→ Board → Columns and statuses (team-managed) or in the workflow editor
(company-managed). Transitions must be all-to-all or at least follow the
arrows above plus `Planned → Triaged` (replan) and `Approved → Planned`
(withdraw).

**Observed (2026-09-23, Jira REST as `<OPERATOR_EMAIL>`).** `TLSSN`
is a team-managed software project (`style: next-gen`, id `11339`, lead
the operator) on "Software workflow for project TLSSN"
(`ce4f0097-48ef-40a8-9a4a-1ace9fbc4537`). It shipped with `To Do`,
`In Progress`, `Done` only. The four missing statuses were created in
project scope with `POST /rest/api/3/statuses` and added to the
workflow with `POST /rest/api/3/workflows/update` (validated first;
`statusMappings` omitted because no status was removed). Every status
now has a global transition, so any status can reach any other:

| Status | id | transition id | category |
| --- | --- | --- | --- |
| To Do | 12151 | 11 | TODO |
| Triaged | 12221 | 41 | TODO |
| Planned | 12222 | 51 | TODO |
| Approved | 12223 | 61 | TODO |
| In Progress | 12152 | 21 | IN_PROGRESS |
| In Review | 12224 | 71 | IN_PROGRESS |
| Done | 12153 | 31 | DONE |

The names equal the `FACTORY_STATUS_*` defaults, so nothing is set.

**Connector finding (2026-09-23).** The Cursor account connector the
agents use is still absent. `ListSandMcpTools` for `<OPERATOR_EMAIL>`
(team `<CURSOR_TEAM_ID>`) returns seven servers (`user-Notion`, `user-Google-drive`,
`user-Gmail`, `user-Google-calendar`, `user-Canva`,
`dashboard-team-<CURSOR_TEAM_ID>-Internalsphere`, `dashboard-team-<CURSOR_TEAM_ID>-Gmail`)
and none for `["Atlassian"]`, `["Jira"]`, or `["GitHub"]`. The team
catalog (`GetAvailableMcpServers`) does hold a team server named
`Atlassian` (id `2324869`). A team server reaches a user's agents only
when that user has enabled it (`mcpService.ts:2500-2505`, opt-in). Simon
enables `Atlassian` for his account and completes its OAuth; it then
appears as `dashboard-team-<CURSOR_TEAM_ID>-Atlassian`, and the bare filter
`Atlassian` matches it (verified with `Gmail`). Every tracker connection
therefore filters `servers: ["Atlassian", "Jira"]`, not `["Jira"]`.

The REST path used for the workflow read is a scoped Atlassian API
token in `.env.local`; it authenticates only against
`https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3`, not the site
host. It is the fallback if the connector never lands: `JIRA_EMAIL` +
`JIRA_API_TOKEN` secrets and `api.atlassian.com` egress on the four
Jira-writing slugs. Not adopted while the connector is expected.

**Fallback if a status cannot be added.** Labels. `factory:triaged`,
`factory:planned`, `factory:approved` on `issue_updated` with a `labels`
changelog item. Same handlers, different `decide()` predicate. Use it
only for the status that cannot exist; do not mix models on one hop.

### Transition table

| Ticket moves to | Who wakes | Checks in host code | Writes | Then moves to |
| --- | --- | --- | --- | --- |
| (created) | `factory-triage-jira` | project in `FACTORY_JIRA_PROJECTS`; no `Triage:` comment yet; the move only while still `To Do` | `Triage:` comment; or `Triage stopped:` with a `Why:` line (the `triage-outcome` hook) when the run ends with the ticket still `To Do` | `Triaged`, or stays `To Do` |
| `Triaged` | `factory-planner` | project allowed; current status is still `Triaged`; verdict is `bug` or `feedback`, not `Needs info` or `Duplicate of` (read from the `Triage:` comment); claimed failure is on `FACTORY_SANDBOX_REPO`; at `record_plan`, the ticket is still `Triaged` (a late session from another entry into `Triaged` writes nothing) | `Plan:` comment ending in `Brief:` and a `plan` artifact, or `Needs info:` when the sandbox disagrees (no brief), or `Plan stopped:` with a `Why:` line when a run ends with neither | `Planned` (only from `Triaged`), or stays `Triaged` |
| `Triaged` | `factory-desk` | thread bound at `ticket/<KEY>` | Slack post "KEY is Triaged" with the latest `Triage:` verdict, and whether the planner will skip it; else that the planner checks it and posts a plan or what information it needs | none |
| (no move; an outcome comment: `Triage stopped: <KEY>`, `Needs info: <KEY>`, `Plan stopped: <KEY>`, `Launch failed: …`, `Approved without a plan …`, `<status> not set from <repo>#<n>: …`) | `factory-desk` (comment rule) | first line is that agent's sentinel for this ticket (`agent/lib/outcomes.ts`); thread bound; still in the status the outcome leaves it in (`To Do`, `Triaged`, or `Approved`; payload and a live read), any status for a `not set from` note | Slack post saying why the ticket did not move on and the next step (table below) | none |
| `Planned` | `factory-desk` | thread bound at `ticket/<KEY>` or `FACTORY_DESK_INTAKE_CHANNEL` set | Slack post "KEY is planned. Reply `approve KEY` or `deny KEY`"; from `Approved` or later, "KEY moved back to Planned" instead | none |
| `Approved` | `factory-worker` | project allowed; current status is still `Approved`; latest `Plan:` comment has a `Brief:`; not already implemented | Cloud agent from the brief; `Implementing: <agent URL>` comment. Or "Approved without a plan …" (no brief), or `Launch failed: <code>. …` (the launch threw) | `In Progress`, or stays `Approved` |
| `In Progress` | `factory-desk` | thread bound | Slack post "KEY is In Progress. Implementation started: <url>" with the agent URL from the `Implementing:` comment | none |
| (implement PR opens, reopens, goes ready, or takes a push) | `factory-worker` (GitHub channel) | PR on `FACTORY_SANDBOX_REPO` into `FACTORY_SANDBOX_REF`; head branch starts with the key, or `cursor[bot]` opened it and the title does; `implement/<KEY>` is `launched`; current status is `In Progress` | `Pull request: <url>` comment, once per PR, before the move | `In Review` |
| `In Review` | `factory-desk` | thread bound | Slack post "KEY is In Review: <PR link> is open" (Bugbot and `pr-autofixer` drive it; a human merges), linking the PR from the latest `Pull request:` comment; "the pull request is open" for a card moved by hand | none |
| (implement PR merged) | `factory-worker` (GitHub channel) | same PR checks; merged by a person (sender and `merged_by` are GitHub type `User`, no `[bot]`), `auto_merge` not set; current status is `In Review` (from `In Progress` it moves through `In Review` first) | `Pull request: <url>` if not already there; `Merged by: <github-login>` (`merged_by` when that actor is a person, else the sender), written once the ticket is at `In Review` and before the Done move, never on a ticket the merge leaves short of Done | `Done` |
| `Done` | `factory-desk` | thread bound | Slack post "KEY is Done: <PR link> was merged by <login>." ("KEY is Done: <PR link> was merged." without a `Merged by:` comment; "KEY is Done." without a `Pull request:` comment) | none |

`factory-worker` makes the last two moves in host code, from GitHub
`pull_request` events on the implement PR. No agent merges and none turns
on auto-merge: a person pressing Merge is the event, and a merge by a bot,
an app, or GitHub auto-merge never moves the ticket to `Done`. The desk
only announces the moves, through its Jira rule, which must list
`In Review` and `Done` (`jira-automation.md`). The worker already held the
Jira write and the launch record that tells a factory PR from any other,
so it takes these moves instead of a Jira Automation rule from the GitHub
for Jira app (Simon, 2026-09-25). A "Pull request merged" rule fires on
any merge, bot merges included, and cannot check that the ticket was
launched by the factory. Giving `security-reviewer` a Jira write scope was
rejected earlier as not cheap enough.

### The thread always hears why

Product rule (Simon, 2026-09-25): "We should always reply to the user so
they know why." Every terminal or non-happy-path outcome posts into the
ticket's Slack thread with the reason and the next step, not only a Jira
move or comment. A line that says what happens next names every ending
the next stage can reach, never only the happy one. An outcome that
leaves the ticket where it is still needs a Slack line and a wake for
the desk; do not add a Jira status or bounce a status to get one.

Every line that comes from a comment names the filer (`<@U…>`) when the
thread has a Slack originator, and gives the Slack command as the next
step; a Jira-filed thread (no originator) gets the board move instead.
The worker's move note mentions nobody. Each comment is announced once
(`announced/<KEY>:<label>:<comment id>`, with the #133 settle window) and
never edits an intake root's status line. A Jira-filed ticket with no
thread yet gets its intake root from an early outcome: Triage stopped,
Needs info, Plan stopped, Launch failed, or Approved without a plan
(`opensRoot`, #131). The worker's move-skipped note replies only in a
thread that already exists.

| Outcome | On the ticket | The thread hears | Desk wakes on |
| --- | --- | --- | --- |
| Triage: a bug or feedback | `Triage:`; `Triaged` | A Jira-filed ticket: "KEY is Triaged: Bug, high severity (triaged by Jev)." (no scores; a desk-filed ticket's Filed post carries this instead), and nothing after it: the planner crumb shows the run | status rule |
| Triage: needs info | `Triage:` with `Needs info:`; `Triaged` | "KEY is Triaged, but triage needs more information: …." then the Jev line, then "Next: reply here with it." | status rule |
| Triage: question or duplicate | `Triage:` with `Duplicate of:`, or kind `question`; `Triaged` | "… as a question, so the planner skips it", "… as a duplicate of KEY, …" | status rule |
| Triage: the run failed, ended without a verdict, could not write it, or could not move the ticket | `Triage stopped: KEY` with `Why:`; stays `To Do` | "KEY is still in To Do: triage stopped before it moved the ticket to Triaged, so the planner has not started." The `Why:`, then `plan KEY` (Jira-only: move the card to Triaged) | comment rule |
| Planner: the sandbox does not show the failure | `Needs info: KEY`; stays `Triaged` | "KEY needs more information, so it has no plan." What it checked, claimed, searched; then "reply here with a file path, error message, or steps that fail on main." (`plan KEY` after a Jira edit also works) | comment rule |
| Someone replies in a thread awaiting information | `Detail from Slack: KEY` comment; bounced To Do → `Triaged` | "Added your reply to KEY and sent it back to the planner.", then the Triaged line | Slack (host code, no model turn) |
| Planner: the run failed, the plan was refused, or it did not move to Planned | `Plan stopped: KEY` with `Why:`; stays `Triaged` | "KEY has no plan: the planner stopped before it recorded one." The `Why:`, then `plan KEY` | comment rule |
| Planner: a late run after another plan landed | nothing | nothing new; the earlier plan's post stands | none |
| Plan | `Plan:`; `Planned` | the plan post, ending in "React ✅ to start the build or ❌ to stop, or reply `approve` / `deny KEY`." (reactions only, "React ✅ to start the build or ❌ to stop.", in a channel the desk does not watch) | status rule |
| `plan KEY` on a verdict the planner skips | nothing moves | the desk's reply names the verdict (`triage_gate`) | Slack |
| Worker: Approved with no plan on the ticket | "Approved without a plan on the ticket; nothing was launched. …"; stays `Approved` | "KEY is Approved, but nothing is being built: the ticket has no plan, so the worker launched nothing." Then "Next: move KEY back to Triaged in Jira to run the planner." | comment rule |
| Worker: the launch failed | `Launch failed: <code>. Moving the card to Approved again retries.`; stays `Approved` | "KEY is Approved, but nothing is being built: the cloud agent launch failed (<code>)." Move it to Planned in Jira, then `approve KEY` (Jira-only: Planned and back to Approved) | comment rule |
| Worker: the implement PR did not move the ticket | `In Review not set from <repo>#<n>: …` or `Done not set from …`; status unchanged | "The factory did not move KEY to In Review for <repo>#<n>: " and the worker's reason (another status, no transition, a failed move that retries) | comment rule |
| Moved back to Planned from Approved | the status | "… Approving it again retries a launch that failed; an implementation that already started is not stopped or launched twice." | status rule |
| `approve KEY` in Slack (exactly that, from the filer, in the thread, while Planned) | `Approved` | a ✅ reaction on the message and no reply; the next line is "KEY is In Progress. Implementation started: <agent url>" | Slack (host code), then the status rule for In Progress |
| `approve KEY` with other words in the message, or one host code declined | `Approved` | the same ✅ on the message, plus one short model line ("KEY is approved."), which the In Progress line then rewrites in place (`chat.update`), so the thread keeps one beat | Slack (model), then the status rule |
| `approve file` / `deny file` in Slack | the new ticket / nothing | a ✅ reaction on that message, then the model's filed line / one line saying nothing was filed | Slack (`file_ticket` / host code) |
| Approved on the board | `Approved` | "KEY is Approved.", rewritten in place by In Progress | status rule |
| In Progress, In Review, Done, other moves back | the status | one line each | status rule |

An approval the desk makes from Slack records `approved-in-slack/<KEY>`
just before the move (and clears it if the move fails). The Approved
status webhook that follows posts nothing while that record is under ten
minutes old, so a Slack approval is answered once, by In Progress with the
agent link. Before this, TLSSN-23's thread got three lines within about 20
seconds: the Approved announcement, the model's approve reply promising In
Progress, and In Progress itself. A failed launch or an approval without
a plan still gets its #96 line.

### Needs info is answered in the thread

Product rule (Simon, 2026-09-25): when the planner or triage needs
information, any reply in the ticket's Slack thread is the update. No
command is needed and nobody has to edit Jira first.

1. The desk posts the Needs info line (planner), or a Triaged line whose
   verdict needs information (triage), and records the thread at
   `awaiting-info/<channel>:<thread ts>`.
2. Someone replies in that thread. The desk's Slack handler
   (`factory-desk/agent/lib/thread-detail.ts`) takes the reply before any
   model turn, unless it is a desk command (`approve`, `deny`, `plan`,
   `replan` KEY or `file`, a new filing request, a status question), a
   bare thanks or emoji, from a bot (the desk's own posts included), or
   from a Slack Connect sender. Anyone in the workspace may answer: the ticket is in
   Triaged with no plan to replace, and approving stays with the filer.
3. With the ticket still in Triaged (a live read), it writes
   `Detail from Slack: KEY` with who replied and the reply as plain text
   (links keep their URL), and bounces the ticket To Do → Triaged. It says
   so in the thread and stops awaiting. The message is claimed once per
   Slack ts, so a redelivery adds nothing.
4. The planner wakes on Triaged, reads the comment with the ticket, and
   either plans or writes a new `Needs info:`, which the desk posts and
   which makes the thread await again. A `Detail from Slack:` comment
   newer than a needs-info `Triage:` verdict lifts that verdict's gate,
   the same way in the planner (`jira-event.ts`), the desk's Triaged line,
   and `plan KEY` (`triage-comment.ts`).

`plan KEY` still works, and clears the awaiting record. A reply
to a ticket that has left Triaged, a Jira comment that fails, or a move
that fails each gets a line saying so. No new status: the bounce is the
same one `plan KEY` makes.

### Hop watchdogs: a stalled hop is announced

A hop is the wait between an agent's wake and the Jira artifact it
leaves. The desk watches three hops for every ticket with a Slack thread
(`factory-desk/agent/lib/hop-watch.ts`):

| Hop | Armed when | Deadline | Ends quietly on | Otherwise the thread hears |
| --- | --- | --- | --- | --- |
| triage | `file_ticket` binds the thread, and its own `Triage:` comment or Triaged move did not land | 15 min | Triaged, or a `Triage stopped:` comment | `KEY has not been triaged N minutes after it was filed.` |
| plan | the ticket enters Triaged | 15 min | Planned, a `Needs info:` or `Plan stopped:` comment, or a triage verdict the planner skips | `KEY still has no plan N minutes after it went to the planner.` |
| launch | the ticket enters Approved | 7 min (a minute after the worker's own relaunch could last land) | In Progress, or a `Launch failed:` / "Approved without a plan" comment | `KEY was approved N minutes ago, but no implementation has started.`, or, when `Implementing:` landed but the move did not, `KEY is still Approved … though implementation started: <url>` |

Every line ends with `retry KEY`, or, in a Jira-filed ticket's
intake thread (no Slack filer, so `retry` is refused as `unbound`), the
board move that retry would make. The line sets ⚠️ on the thread root. How
it works:

1. **Durable record.** Each entry writes `hop-watch/<KEY>` (hop, entry
   changelog id, deadline, newest Jira comment id) and lists the key in
   `hop-watch/index` (a verified merge, `kv-index.ts`: union on add,
   settle confirm, self-heal on a redelivered entry, prune only of records
   verified gone; the worker's `implement-pr-watch/index` is the same). A
   new entry replaces the old record, so a ticket
   has one watched hop at a time. A redelivery of the same entry arms
   nothing new.
2. **Platform deadline.** The entry also arms a one-shot reminder with a
   named handler (`agent/reminders/hop_watch.ts`, JSON args). Hosted v2
   fires named-handler reminders and rejects anonymous reminder `run`.
   The `hop-watch` schedule is a backstop sweep every five minutes:
   self-hosted serve fires it on its own clock, and on hosted v2 July
   0.2.13 declares it in the deploy manifest as a 5-minute `run` schedule
   that the guest runs. It picks up a record whose reminder could not be
   armed, or one still there ten minutes past its deadline, and logs one
   `{"desk":"hop_watch","via":"schedule","due":N,"fired":M}` line per run.
   The desk's admission `backstopSweep` covers the same records; each hop
   line is claimed, so overlapping sweeps post it once.
3. **Clear on what Jira shows.** The expected move, any other move out of
   the hop's status, or one of the hop's outcome comments clears the
   record and cancels its reminder. An outcome from another hop does not.
4. **The fire re-reads Jira before it says anything.** When the ticket
   left the status, the fire stays quiet. It also stays quiet when the
   plan hop's triage verdict is gated. When an outcome comment newer than
   the arm-time baseline exists, the fire announces it through
   `announceOutcome`, under the same claim the comment rule uses. That
   covers a comment rule that is off. When the status read fails, the
   fire reschedules five minutes out. After three failed reads it posts
   `The desk could not read KEY from Jira…`. Otherwise it posts one
   `threadOnly` line, claimed at `announced/<KEY>:hop-<hop>:<changelog>`,
   so a reminder and a sweep that both fire post it once.
5. **No automatic retry at the deadline.** The deadline watch only
   announces. A false-positive deadline (a long planning run) costs one
   line, never a second run or launch.
6. **The plan start check, with one automatic re-send.** The one
   exception, for a stall the deadline line cannot fix: a hosted planner
   delivery that the control plane hands a reused session throws before
   its turn starts and logs nothing
   ([`deployment-issues.md`](deployment-issues.md), issue 28; TLSSN-60
   went silent for 54 minutes until a planner redeploy). A healthy run
   writes `Planning started: KEY` within seconds of the Triaged move, so
   the same Triaged entry also arms a `plan_start` reminder 4 minutes out
   (`PLAN_START_DEADLINE_MS`; the sweeps back it up a minute past a late
   reminder). The check re-reads Jira and stays quiet when the ticket left
   Triaged, its verdict is gated, or anything shows the planner ran for
   this entry (the marker since the entry, a `Plan:`, a `Needs info:` or
   `Plan stopped:` above the baseline); an unreadable Jira is looked at
   again a minute later, three times, and never retried blind. Otherwise
   it re-sends the ticket to the planner exactly as `retry KEY` does (the
   Triaged → To Do → Triaged bounce, `planner-sent/<KEY>`, the crumb), once
   per stuck episode, recorded at `plan-start-retry/<KEY>` before the move,
   and posts `KEY's planning hasn't started 4 minutes after it went to the
   planner, so I've sent it to the planner again.` When the retried entry
   does not start either, the check posts the final line, `KEY's planning
   still hasn't started after one automatic retry, so planning couldn't
   start. The next step is a planner redeploy or asking ops; say `retry
   KEY` here to try again.`, sets ⚠️, and never moves again while the
   record stands (it clears when a start is seen or the ticket leaves the
   plan path, and expires after 2 hours). The record is keyed by the
   entry it re-sent, so the re-sent entry itself never gets the final
   line, a later entry in the episode (a person's `retry`) gets it without
   "after one automatic retry", and a re-send whose finish write was lost
   still counts once a newer entry exists. The 15-minute line for an entry
   the start check already spoke for (final, or a failed re-send) is
   suppressed unless the planner started late, and `retry KEY` after
   either line is not refused as inside the deadline. A re-send whose move
   fails says planning could not be re-sent and offers the retry; it
   leaves no record, so the next entry gets its own re-send.
   Every arm and fire logs one
   `{"desk":"plan_start_watch","via":"arm"|"reminder"|"sweep",…,"result":…}`
   line (`armed`, `started`, `retried`, `final`, `moved_on`, `gated`,
   `unread`, `not_moved`, `superseded`, `duplicate`).

`retry KEY` (`agent/lib/retry-command.ts`) is host code, like
`approve KEY`. It works only as exactly `retry KEY`, from the filer, in
the ticket's thread. An exact `retry KEY` from anyone else, from another
thread, or for a Jira-filed ticket gets one host line saying why, never a
model turn (TLSSN-33). A longer message goes to the model.
It redelivers the hop the ticket is stuck in and replies once:

- A hop still inside its deadline is not started again. The reply says
  how long is left. The exception is a plan entry the 4-minute start
  check already declared not started (its final line, or a re-send that
  failed): the retry those lines offer goes through.
- To Do or Triaged: the same move `plan KEY` makes, after the same
  triage gate. From To Do this skips triage, and the reply says so.
- Approved: Approved → Planned → Approved, so the worker gets a fresh
  Approved delivery. The worker claims `implement/<KEY>` once per ticket
  and launches with that claim as its idempotency key. A redelivery that
  finds the claim `launched` re-posts a missing `Implementing:` comment and
  moves the ticket, and does not launch again (a delivery racing the first
  launch can, see "Claims per hop"). A launch that threw released the claim,
  so the redelivery launches again. The bounce records
  `retry-bounce/<KEY>` and `approved-in-slack/<KEY>`, so the move-back
  line and the Approved line stay quiet. An Approved ticket with no
  `Plan:` comment is refused, because the worker would stop the same
  way.
- Any other status: nothing to retry, and the reply says so.

Remaining silent exits (not yet announced). Each is tracked in
[`next-steps.md`](next-steps.md):

- A Jira-filed ticket whose triage never runs at all. Its intake root
  opens at Triaged, or at an earlier `Triage stopped:` (#131). The desk
  sees no `issue_created`, so no triage watch is armed and no thread
  exists to tell. From Triaged on, the plan and launch watches arm under
  that root like a Slack filing's. `retry KEY` needs a Slack filer, so on
  a Jira-filed root it is refused (`unbound`); recover from the board
  instead (move the card back to Triaged, or Planned then Approved).
- In Progress → In Review (the cloud agent never opens its pull
  request) is not watched. The run can legitimately take hours, so this
  hop needs a longer deadline and a line that can tell a slow run from a
  dead one. It is the next extension point: one `HOPS` entry, one arm in
  `channels/jira.ts`, and one `retry` branch.
- The hop watch itself needs the reminder control plane or a firing
  schedule. On hosted v2, a reminder that cannot be armed (the create
  call fails) is covered only by the sweep, and v2 does not fire the
  sweep. The desk logs that case as `could not be armed; the sweep
  covers it`.
- A Jira delivery that arrives twice under two changelog ids (Automation
  plus a site system WebHook) is not silent but noisy: two planner runs
  and two of every line. The handlers keep every delivery on purpose, so
  the operator keeps one source per slug
  ([`jira-automation.md`](jira-automation.md#one-delivery-source)).
  The settle window (#133) only absorbs two deliveries of the same id.

After In Review, `pr-autofixer` and `security-reviewer` report on the
pull request. The desk relays them into the ticket's thread as review
update lines: one security line per verdict change (#129), and Bugbot,
CI, change-monitor, and autofix per head. A PR the worker could not mark
ready leaves a `Ready for review not marked` Jira note (#130) that the
thread does not hear yet.

### Event shape

Hosted default is five TLSSN project Automation rules (created → triage;
status → Triaged → planner; Triaged, Planned, Approved, In Progress, In Review,
Done → desk; comment → desk, for the outcome comments triage, the
planner, and the worker leave instead of a move; Approved → worker). GitHub events reach the worker through
its GitHub channel, not through Jira. Each
POSTs a documented body that mimics the native `webhookEvent` + `issue`
+ `changelog` shape, authenticated by `X-Factory-Webhook-Secret` or
`Authorization: Bearer` against `JIRA_WEBHOOK_SECRET`. HMAC
`X-Hub-Signature` / `X-Hub-Signature-256` is still verified (legacy
system webhooks and `e2e-drive --replay`). Unsigned deliveries are
refused. See `jira-automation.md`.

`decide()` reads `webhookEvent`, `issue.key`, `issue.fields.status.name`,
and `changelog.items[]` for one item with `field === "status"`. The
`toString` is the status entered; `changelog.id` is unique per
transition and identical across redeliveries. A delivery with no status
item is ignored. A delivery whose `toString` is the target but whose
`issue.fields.status.name` differs (the ticket moved again before the
webhook landed) is ignored too; the later delivery carries the truth.

Hosted ingress answers **202** to Jira (Temporal `evt:` lane). The
handler's response is not what Jira sees. Each slug has its own
`JIRA_WEBHOOK_SECRET` installation secret.

### Claims per hop

`host.kv` is per slug and has no compare-and-set on any backend
(`july:dist/internal/host-kv.js:22-34`; [bugs.md ask 11](bugs.md)), so every
claim is best effort. The desk's and the fixer's claims read, write, and
read back (`kv-verified.ts`, `claim-lease.ts`); the planner's and the
worker's claims read, put an owner, read back, and re-read after a settle
wait (`verified-claim.ts`). `continuationToken` and `admission: coalesce`
do not serialize custom HTTP deliveries (ADR 0003:194-196).

| Slug | Claim key | Lifetime | Released when |
| --- | --- | --- | --- |
| triage | none. It relies on `admission: "coalesce"` and `already_commented`: a redelivery that finds its own `Triage:` comment writes no comment and moves the ticket to `Triaged` only while it is still `To Do` (`record_plan` does the same for `Plan:` from `Triaged` to `Planned`). A race can still write a second `Triage:` comment | | |
| planner | `plan/<KEY>:Triaged:<changelog.id>` | one transition | `send` threw |
| planner (replan) | same key, new changelog id | | |
| desk announce | `announced/<KEY>:<status>:<changelog.id>` | one transition | `chat.postMessage` threw |
| desk approve | none. The transition is idempotent: Jira rejects a second `Approved` from `Approved` | | |
| worker | `implement/<KEY>` **and** `Agent.create({ idempotencyKey: "implement/<KEY>" })` | ticket | `Agent.create` threw before returning an agent |
| worker (PR status) | `pr-status/<KEY>/<in_review\|done>/<owner>/<repo>#<n>` | one move per ticket, stage, PR | the move did not land (ticket in another status, no transition, connector missing or failed) |
| fixer | `auto-drive:<owner>/<repo>#<n>` (exists) | PR | never |

The worker and planner claims have two states. `{ state: "pending", at,
owner }` (plus `deliveryId` when hosted admission set
`x-agent-sdk-delivery-id`) is written before the dispatch, with a fresh
random owner per delivery (`verified-claim.ts`):

1. Read the key and classify it, as before.
2. Put the pending claim with `updateVerified`: read back, and yield to any
   value that is neither this owner's nor the one step 1 read.
3. Wait `FACTORY_CLAIM_SETTLE_MS` (default 2000 ms, 0 skips it) and read
   again.
4. Dispatch only while the key still holds this owner's claim. Any other
   value goes through the same classify with a stale one read as in
   flight, so the confirm step never takes a claim over. An ownerless
   pending written by older code is in flight, never done.

Two concurrent deliveries now dispatch once, unless one put lands later
than the settle after the other's, or a slug is mid-deploy and old code
(read then put, no read-back) lands its put after this code's settle
re-read or in the one round trip between its pre-read and its put. Then
both can dispatch: on the worker both call `Agent.create` and both post
`Implementing:`, and whether the platform `idempotencyKey` collapses two
concurrent creates into one agent has not been checked (a re-run minutes
later was not deduped, [`scaling-and-integration.md`](scaling-and-integration.md)).
The planner has no external guard at all. A claim that cannot be confirmed
(`unavailable`) deletes this owner's put, and only that, before the 503,
so a retried delivery finds nothing or a rival's claim. Every release is
owner-checked (`deleteVerified`). A replay of the same delivery id takes
its own pending claim over (the planner also takes over its own
`started`, which at admission means only "captured"; the worker never
retakes a `launched` claim). A replay that arrives while the first
attempt's launch is still running therefore calls `Agent.create` again,
under the same `idempotencyKey` (unverified for concurrent creates).
`FACTORY_CLAIM_MODE=legacy` restores the plain read-then-put and its log
output. Once it returns, the
worker writes `{ state: "launched", at, agentId, url, commented, moved }` and
the planner writes `{ state: "started", at, sessionId }`. A delivery
that loses the claim to a `launched` or `started` record is a duplicate.
One that finds `pending` younger than its window (the planner's
`STALE_PENDING_MS`, 10 minutes; the worker's `LAUNCH_GRACE_MS`, 3 minutes)
treats it as in flight and skips. An older `pending` is presumed to belong
to a process that died or was parked before recording. The worker checks
first for an agent that launch already started (an `Implementing:` comment,
or `Agent.list` by name) and adopts it. Otherwise the delivery takes it over through
the same four steps and dispatches again. The `plan-skip/`,
`planning-started/`, `pr-status-note/`, and `pr-ready-note/` claims carry
no owner and get no settle: the planner's two lean on Jira
`already_commented`, and the worker's two can repeat one note.

Two claims on the worker on purpose. The kv claim narrows the window
for a second webhook delivery in this slug but does not stop one that
races it (above). The `idempotencyKey` is meant to stop a second launch
at the platform if the VM dies between `Agent.create` returning and the
kv write, so a relaunch after a stale takeover relies on that key
returning the same agent, which has not been verified. It is the same
string as the claim so a reader can join them. A ticket that is approved,
withdrawn, and approved again does not launch twice; the second
`Approved` finds `implement/<KEY>` and only re-posts the existing agent
URL. If the first delivery's `Implementing:` comment never landed
(`commented: false`), the second posts it and only then moves the ticket
to `In Progress`. Every later `Approved` then moves the ticket back to
`In Progress` when it is in `Approved`, whether or not the first move was
recorded, because a launched ticket that drifted back and was approved
again would otherwise sit in `Approved` with no launch coming. A ticket
someone has moved anywhere else stays where it is.

## Approve moment

Alice reads the plan on the ticket or the desk's summary in the thread.
She replies `approve TLSSN-42` in that thread. The desk transitions the
ticket to `Approved`. That transition is the launch. Anyone who moves the
card to `Approved` on the Jira board gets the same launch. The board is
the single source of truth for what is approved.

| Line in the thread | Desk does |
| --- | --- |
| `approve file` / `deny file` | Create the ticket (`file_ticket`), or drop the filing |
| `approve KEY` | `approve_ticket`: transition `Planned → Approved` |
| `deny KEY` | `deny_ticket`: comment `Denied in Slack by <user>`; the ticket stays `Planned` |
| `plan KEY` / `replan KEY` | `request_plan`: transition to `Triaged` (from `To Do`, or from `Planned` for a replan). A ticket already in `Triaged` gets a status bounce, `To Do` then back to `Triaged`, because a move from `Triaged` to itself writes no status change. Re-entry into `Triaged` with a `Plan:` comment already on the ticket is a replan. No comment |
| A request to fix a PR | No tool (in Slack, host code answers with no model turn): the desk replies in the thread that the person types `factory: drive` as a comment on the PR, and that a factory PR is driven on its first red check anyway. The desk never writes to GitHub |

`file_ticket`, `approve_ticket`, `deny_ticket`, `request_plan` are the
desk's four tools, all Jira. It has no GitHub tool or connection. `get_brief`, the
`cursorCloudAgents` extension, `cloud__launch`, and `needsApproval` are
gone from the desk. `toolApprovals: false`.

### Why the gate is text and not a reaction

Reactions on the plan message would be the lighter gate. Hosted v2
cannot deliver them (everysphere `main` @ `9a4aaa4`):

1. **Manifest.** The v2 provisioner only admits `app_mention`,
   `message.im`, `app_home_opened`, `assistant_thread_started`,
   `message.channels`, `message.groups`
   (`agentServeSlackProvisioning.ts:840-847`, `ALLOWED_MANIFEST_BOT_EVENTS`).
   A manifest that subscribes `reaction_added` is rejected with
   `bot event "reaction_added" is not in the agent-serve allowlist`
   (`agentServeSlackProvisioning.test.ts:1122-1127`).
2. **Control-plane ingress.** The Events API classifier returns
   `undefined` for anything but `app_mention` and `message`
   (`agentSdkSlackAppEvents.ts:153-170`); its tests label
   `reaction_added` "unsupported event type" (`:663`).
3. **Pack.** `slackChannel` declares only `app_mention` and `message`
   as hosted event types: the `slack.thread/v2` membership admits
   exactly those two, "so `reaction_added` … is deliberately not
   declared" (`slack-channel.ts:189-199`). `onReactionAdded` is a Socket
   Mode handler (`types.ts:646-651`); Socket Mode is local `dev` only.

ADR 0002 uses reactions outbound only: the control plane posts `eyes` as
the fast ack (`0002_agent-sdk-v2-slack-channel.md:118, 264-307`).
Inbound reactions and interactivity are later tracks (C3, `:496`).

The day `reaction_added` joins the allowlist and the classifier, the
change is one `onReactionAdded` handler on the desk that calls
`approve_ticket`. Nothing downstream changes, because downstream wakes on
the Jira status, not on Slack.

Update, BDK 0.2.11: that day came. `reaction_added` reaches the hosted
desk, and ✅ / ❌ on the filing prompt and the plan post approve or
decline alongside the typed commands once the Factory app carries the
0.2.11 manifest (README, Slack section). The list
above is the 0.2.2 record.

### Why not cards

Block-action cards need `interactivity.request_url`, which the v2
manifest validator rejects (`agentServeSlackProvisioning.ts:1100-1106`).
Parked approvals die on replace. Cards are out.

## `factory-worker`

Host-only. One channel, no model turn on the hot path.

```
POST /factory-worker/v1/channels/jira/
verify X-Hub-Signature (JIRA_WEBHOOK_SECRET)
decision = decideApproved(body, env)        // pure; fixtures in tests
  ignore unless issue_updated, status item toString === Approved,
  issue.fields.status.name === Approved, project in FACTORY_JIRA_PROJECTS
brief = latest Plan: comment → text after the last Brief: heading
  none → comment "Approved without a plan; nothing launched", stop
claim = get("implement/<KEY>"), classify, then updateVerified { state: "pending", at, owner, deliveryId? },
        wait FACTORY_CLAIM_SETTLE_MS, get again (no compare-and-set on host.kv; verified-claim.ts)
  lost to launched → re-comment the agent URL if missing; ticket in Approved → transition, put moved: true; stop
  lost to pending younger than 3 minutes, LAUNCH_GRACE_MS (not this delivery id's) → in flight, launch watch armed, stop
  lost to older pending, or this delivery id's own → take it over the same way, go on
  confirm read not this owner's → in flight (or launched), launch watch armed, stop
  confirm read empty → unconfirmed, launch watch armed, stop
  unavailable → delete this owner's claim only; launch watch (or an orphan reminder) armed → 202; neither → 503 + Launch failed:
took over a pending → an Implementing: comment, or Agent.list finds "factory <KEY>: …" since it began → adopt it; listing unknown → stop, watched
agent = Agent.create({ idempotencyKey: "implement/<KEY>", model, cloud: { repos: [sandbox] }, prompt: brief }), 30 s deadline
  threw → delete this owner's claim only, Launch failed:, resolve (never reject: hosted admission never redelivers)
  deadline → keep the claim pending, await the late answer 60 s more, record it if it comes; the heal adopts it otherwise
record → only while this run still holds the claim (recordLaunch); else superseded: no comment
put("implement/<KEY>", { state: "launched", at, agentId, url, commented: false, moved: false })
comment "Implementing: <url>"
  landed → put commented: true; transition → In Progress; landed → put moved: true
  failed → no transition; the next Approved delivery posts it, then transitions
```

**`Agent.create`, not the `cursorCloudAgents` extension.** Both reach
`POST /v1/agents` with the same body. The extension's `launch` is a
model-facing tool: its repo allowlist exists to check a model-chosen
repository (`lib/repos.js:2-4`), its fleet record works around a store
with no CAS (`lib/fleet.js:27`), and its request has no
`idempotencyKey` (`lib/backend.js:103-117`). The worker has no model
choosing anything and uses a kv claim (read then put; `host.kv` has no
compare-and-set). `@cursor/sdk` `Agent.create` takes
`idempotencyKey` and `model` directly (`agent.d.ts:37, 57`), which is
sandy's shape (`dispatch.ts:55-64`). `@cursor/sdk` already ships
inside `@cursor/july` (1.0.35 in 0.2.18); the worker depends on it explicitly at that
version.

**Cloud model.** Claude Opus 5.5. Registry id `claude-opus-5-5`
(`modelIds.ts:13`), params `context` (`300k | 1m`), `effort` (`low | medium | high | xhigh |
max`) and `fast` (`true | false`), per `Cursor.models.list()`. The launch
API needs the full variant. Default `context=300k, effort=high,
fast=false`. Configurable: `FACTORY_WORKER_MODEL` (default
`claude-opus-5-5`), `FACTORY_WORKER_CONTEXT`, `FACTORY_WORKER_EFFORT`,
`FACTORY_WORKER_FAST`, read once at process start (local `serve` only;
hosted v2 binds secrets after `agent.ts` loads, so the hosted worker
runs the default); the default is asserted in a test. Risk: `mc_claude_opus_5_5` is launch-gated, "defaults to
lifecycle off" (`modelIds.ts:12`). The first hosted launch is the
check. The worker always sends exactly `context`, `effort` and `fast`, so
another `FACTORY_WORKER_MODEL` only works if its catalog variants have
exactly those parameters (`claude-opus-5` also carries `thinking` and
`cyber`, so it is not a drop-in fallback).

**Report back.** The worker comments `Implementing: <url>` and moves the
ticket to `In Progress`. The desk wakes on that status, reads the latest
`Implementing:` comment, and posts the URL into the thread from
`ticket/<KEY>`. No call between them.

**The PR moves the ticket.** A second channel on the same slug,
`githubChannel({ cursorAccount: { repos: [FACTORY_SANDBOX_REPO], permissions: "pr-write" } })`,
subscribes to `pull_request` only (`webhookEvents`), posts no comments or
reactions (`deliverReplies: false`), and answers comments with
`null` so the default `@mention` gate never starts a turn. Still no model
turn: the hook decides and returns `{ task }`, which runs after the 202.
Its one GitHub write: on `opened`, `reopened`, `ready_for_review`, and
`edited`, a launched implement PR whose brief carries `Slack thread:` gets
its description rewritten to start `Jira: <url>` then `Slack: <permalink>`
when it does not already (`factory-worker/agent/lib/pr-body.ts`).

```
onPullRequest(ctx, pr)
decision = decidePullRequest(pr + ctx.sender + raw merged_by / auto_merge)   // pure
  ignore unless repo is FACTORY_SANDBOX_REPO, base is FACTORY_SANDBOX_REF,
  head branch starts with a FACTORY_JIRA_PROJECTS key (or cursor[bot] opened it and the title does)
  opened | reopened | ready_for_review | synchronize        → stage in_review
  closed, merged, no auto_merge, sender and merged_by human → stage done
  anything else (bot merge, auto-merge, closed unmerged)     → ignore
task:
  implement/<KEY> is not launched → stop (not a factory implement PR)
  claim = the same owner, read-back, settle claim on "pr-status/<KEY>/<stage>/<repo>#<n>" (no compare-and-set)
    lost to moved → duplicate, stop; lost to pending younger than 10 minutes → stop
  in_review: transition In Progress → In Review only while In Progress
  done:      transition In Review → Done while In Review;
             In Progress, Approved, Planned, Triaged, or To Do → In Review → Done
             (a launched ticket that drifted back still closes on the merge)
  in the target status → put { state: "moved" }; already there counts
  anything else → delete this owner's claim (the next push or redelivery retries); a failed write rethrows
```

"Human" is GitHub user type `User` with no `[bot]` suffix, for both the
delivery's sender and `pull_request.merged_by`. Cursor cloud agents act on
GitHub as `cursor[bot]` (type `Bot`), so an agent merge is refused. An
agent that merged with a person's own token would pass the check; nothing
in the factory hands one such a token, and `pr-autofixer` never merges.

**Egress.** `api.cursor.com` for `Agent.create`. Jira goes through the
Cursor account Atlassian connector, no `*.atlassian.net`. The GitHub
channel reads nothing from GitHub: every field it needs is on the event.

**Secrets.** `FACTORY_SANDBOX_REPO`, `FACTORY_SANDBOX_REF`,
`FACTORY_JIRA_PROJECTS`, `JIRA_WEBHOOK_SECRET`,
`FACTORY_STATUS_APPROVED`, `FACTORY_STATUS_IN_PROGRESS`,
`FACTORY_STATUS_IN_REVIEW`, `FACTORY_STATUS_DONE`, and `CURSOR_API_KEY`
only if the launch principal should differ from the deploying login.

**Deploy.** `--cursor-events-repo cursor-demo-lab/marsbank`, like the
planner, fixer, and reviewer. Without it the finish-check fails, or the
slug never receives the PR events.

## Host model for the six July agents

Grok 4.7, high effort, fast. The July `model` field is
`{ id, params }`; effort and speed are params, and suffix ids such as
`grok-4.7-high-fast` are rejected (`agent-config.md:43-45`).

```ts
model: {
  id: "grok-4.7",
  params: [
    { id: "reasoning_effort", value: "high" },
    { id: "speed", value: "fast" },
  ],
}
```

`grok-4.7` is a Model Deployment Registry id. Hosted turns copy param ids
verbatim and remap only `fast` → `speed`; an unknown id fails with
"Invalid parameters for registry model: grok-4.7". `GET /v1/models` also
lists `grok-4.7` with catalog-only `context` (256k, 500k). Sending that
full catalog variant is what broke hosted desk (PR #74). Each project
exposes `factoryModel(env)` from its `config.ts`, reading
`FACTORY_AGENT_MODEL` (id), `FACTORY_AGENT_EFFORT`, `FACTORY_AGENT_SPEED`,
defaulting to Auto: `{ id: "auto-smart", params: [{ id: "optimize_for",
value: "balanced" }] }` (`AUTO_MODELS`; effort and speed do not apply).
`factoryModel(env, LIGHT_MODEL)` defaults to `grok-4.6` instead, sent as
`{ id: "grok-4.6", params: [{ id: "effort", value: "high" }, { id: "fast",
value: "true" }] }` (grok-4.6-fast): `factory-desk` runs every turn on it
and `triage-jira` its one fallback triage turn. The same settings override
both defaults.
`FACTORY_AGENT_MODEL=grok-4.7` gets the registry encoding above. `REGISTRY_MODELS` is
`grok-4.7`. Catalog overrides (`claude-opus-5-5`, `grok-4.6`, `grok-4.5`)
take a full `GET /v1/models` variant. Any other id is sent without params.
`scripts/factory-model-catalog.test.mjs` pins the Auto default, the grok-4.6-fast root of the desk and triage, the registry `grok-4.7` encoding, and
checks catalog overrides against a recorded catalog
(`scripts/fixtures/model-catalog.json`). This replaces
`grok-training-latest` (desk, planner) and the July default `grok-4.5`
(triage, fixer, reviewer).

## Consolidation

Four shapes were weighed. Evidence per column: slugs and webhooks and
secrets to operate; cross-agent hops left; whether a viewer of the demo
can see each stage; blast radius of one compromised or misbehaving slug;
fit with what hosted v2 delivers today.

| | A. Five slugs | B. Planner as a desk subagent | C. Triage + planner in one slug | **D. Six slugs (chosen)** |
| --- | --- | --- | --- | --- |
| Slugs / Jira webhooks / secrets | 5 / 3 / 5 | 4 / 2 / 4 | 4 / 2 (one slug, two routes) / 4 | 6 / 4 / 6 |
| Cross-agent hops | 0 | 0 | 0 | 0 |
| Stage visible on the board | triage, plan | triage only; plan is inside the desk | one "factory" stage | triage, plan, approve, implement |
| Launch scope holder | desk (also talks to Slack) | desk | desk | **worker only** |
| v2 fit | yes | no, see below | yes | yes |

**B, re-examined.** The earlier reason ("a subagent cannot be woken by a
Jira event") was too weak: the desk has a Jira route, so the desk host
is woken. What the route cannot do is start a subagent. Subagents run
inside a parent model turn through the `task` tool (`subagents.md:8-12,
41-46`); a channel handler that returns without `send` has no turn, and
one that calls `send` spends a desk model turn whose only job is to
delegate. B therefore forces a model turn on a hop that is otherwise
pure host code, and the model on that turn is the one that also reads
Slack text from anyone who can mention the bot. B also folds the
planner's checkout (`workspaceDir`), sandbox, and read tools into a
desk that today has `tools: []`, so the Slack-facing model gains a
code-reading toolset. Rejected on those grounds: it adds a model turn
to a host-only hop and widens the Slack-facing agent's tool surface.

**C, examined.** One slug with two routes (`issue_created` triages,
`Triaged` plans), one secret, one webhook with both events. It is
feasible: `triage-jira` already runs with `read, grep, glob, ls`. It is
rejected for this cut because it hides the `Triaged` stage as an
independently deployable, inspectable agent (`run --prod --slug`,
`logs --prod`, its own evals) and because `triage-jira` is a July
template whose instructions and skills diverge from the planner's. The
saving is one slug and one secret. Revisit if slug count becomes the
cost that matters.

**D, chosen.** A plus a dedicated worker. One more slug and one more
webhook than A. In exchange the desk loses the cloud launch scope and
the sandbox repository, the approve moment becomes a Jira transition
that the board can also perform, and the implementation stage has its
own logs, claim, and evidence. Simon's steer that there will still be
multiple agents stands.

## v2 channel routes

| Slug | Route | Jira events | Filter in `decide()` | Secret |
| --- | --- | --- | --- | --- |
| `factory-triage-jira` | `/v1/channels/webhook/` | `jira:issue_created` | project | `JIRA_WEBHOOK_SECRET` via `X-Factory-Webhook-Secret` or HMAC |
| `factory-planner` | `/v1/channels/webhook/` | `jira:issue_updated` | status → `Triaged`. A manual `plan KEY` arrives the same way, as the desk's status bounce. The route's `comment_created` path (`Triage:` or `Plan requested:`) is a legacy local path; the hosted webhook does not register comment events | same |
| `factory-worker` | `/v1/channels/jira/` | `jira:issue_updated` | status → `Approved` | same |
| `factory-worker` | GitHub `cursorAccount` channel (read) | `pull_request` | implement PR opened / pushed → `In Review`; merged by a person → `Done` | none extra; `--cursor-events-repo` on every redeploy |
| `factory-desk` | `/v1/channels/jira/` | `jira:issue_updated` | status → `Triaged`, `Planned`, `Approved`, `In Progress`, `In Review`, `Done` | same |
| `factory-pr-autofixer`, `factory-security-reviewer` | GitHub `cursorAccount` channel | PR / check / comment | | none extra; `--cursor-events-repo` on every redeploy |

Replay: `scripts/replay-jira-transition.mjs <slug-url> <KEY> <toStatus>`
signs a synthetic `issue_updated` body with the local secret and posts
it. Same script drives the `decide()` fixtures in tests.

## Tests

Per slug: `decide()` fixtures (created, status transition, wrong
status, stale status, other project, no changelog, redelivery); HMAC
accept and reject; the claim with a fake CAS kv. Worker only: a
dedupe race (two concurrent `Approved` deliveries over one CAS kv,
exactly one `Agent.create`), a `factoryModel`
/ worker-model default test, and the PR path: `decidePullRequest`
fixtures (open actions, human merge, bot merge, auto-merge, closed
unmerged, other repo, other base, no key), the guarded moves and the
`pr-status/` claim against a fake tracker, and the channel driven
through July's `dispatchGitHubWebhook` (a task, never a turn). Desk: `approve_ticket` transitions and
never launches; the `In Progress` route posts once. Evals stay for the
mention surface only.

## Demo script

Alice: `@Factory file a bug: …` → `approve file` → the ticket appears;
`Triage:` then `Plan:` land on it; the card moves `To Do → Triaged →
Planned`; "planned, reply approve" arrives in the thread → `approve
TLSSN-42` (or drag the card to `Approved`) → the card moves to
`In Progress` and the thread gets the cloud agent URL → a PR opens and the
card moves to `In Review` (the thread says so) → Bugbot and the security
review comment → a red check wakes the fixer → a person merges and the card
moves to `Done` (the thread says so).

Operator: four Jira Automation rules (the desk's lists Planned through
Done), one Slack app on the desk, four GitHub `cursorAccount` channels
(planner, worker, fixer, reviewer), six secrets sets. The fixer's main path
is its automatic drive on a factory PR's first red check. The manual
override for any other PR is a `factory: drive` comment a person types
on GitHub.

## Hosted slugs and deploy order

`factory-desk` exists. New: `factory-triage-jira`, `factory-planner`,
`factory-worker`, `factory-pr-autofixer`, `factory-security-reviewer`.
Deploy with the user login, not the service account (the freeze clones
with the deploying principal's GitHub identity). Secrets after READY,
then redeploy. Order: triage, planner, worker, desk, fixer, reviewer, so
each webhook has a live target when it is registered.

## Where this differs from the store notes

1. The notes keep comments as the inter-agent event. Status transitions
   replace them. Comments stay the human record and the payload the
   next stage reads (`Triage:` verdict, `Brief:`, `Implementing:` URL).
2. The notes keep the launch on the desk. It moves to `factory-worker`.
3. The notes' claim is `plan-claimed/<KEY>`. The claim now carries the
   status and the changelog id so a deliberate second transition
   (replan) passes and a redelivery does not.
4. The notes say `putIfAbsent` is the only launch guard. `host.kv` has no
   `putIfAbsent` (July 0.2.13: get, put, delete), so the claim puts an
   owner, reads back, and re-reads after a settle, which is not atomic
   across sessions. The worker adds the platform `idempotencyKey`; how it
   behaves for two concurrent creates has not been checked, so it does not
   close the residual double claim.
5. No `*.atlassian.net` egress. Jira stays behind the account connector.
6. No schedule poll. Status is the ticket. The desk's hop watch reads
   Jira once per hop, at that hop's deadline (and once more at the plan
   hop's 4-minute start check), and only to decide whether the thread
   should hear about a stall or the planner needs its one re-send.

## Open blockers

State on 2026-09-26. The Atlassian connector, the worker's launch, and
the shape-discovered transition tools all work on hosted v2 (TLSSN-22 to
TLSSN-31). What still limits the factory:

- `ctx.host.kv` has no compare-and-set. The desk's and the fixer's claims
  read back after the write, and some desk claims also settle for 2 s
  (#133; the Planned, In Progress, `approve KEY`, `retry KEY`, and
  `plan KEY` claims do not). The planner's and the worker's claims
  put an owner, read back, and re-read after `FACTORY_CLAIM_SETTLE_MS`
  (2 s). A put slower than the settle, or old code mid-deploy, can still
  double-claim. That is best effort until the
  platform ships ask 11 ([`bugs.md`](bugs.md#ask-11-ctxhostkv-has-no-compare-and-set-or-conditional-put)).
- Bot-authored comments never reach a v2 app: webhook ingress drops
  them before the Agent SDK tap (`github/githubWebhook.ts:1320-1329`).
  So `factory: drive` must be typed by a person on GitHub; the desk does
  not post it. The main path is the red check: the fixer drives a
  factory PR on its first failed `check_suite` or `workflow_run`
  (`check_run` is never forwarded to v2 apps). Detail in
  [deployment-issues.md](deployment-issues.md) issue 12.
- A hosted v2 hop-watch reminder firing on a real stall is not proven
  yet (#132 is unit-tested against July's reminder discovery).
- Jira ingress is TLSSN project Automation plus the shared header
  secret (`jira-automation.md`). Site system webhooks with HMAC remain
  accepted, but never alongside Automation on the same slug. The v3
  webhook API is still Connect/OAuth-only.

# Bug hunt, round 2: races, admission, and swallowed failures

An independent code read of the six factory packages on 2026-09-25,
biased toward what a status-path hunt misses: idempotency and double
wakes, the fixer's admission and scope, the desk's Automation reads
against the agents' own moves, error handling that fails open, and the
edge cases (drafts, keyed titles, non-implement merges, tickets already
Done). Round 1's TLSSN-21 backdrop (`deployment-issues.md` issue 15) was
read but not re-fixed; the worker's merge path already leaves a `Done not
set from …` note there, and the desk relays it.

Findings 1 and 2 were fixed with the hunt (#110). Findings 3, 5, 7, and 8
were fixed in the follow-up (#111). Every fix has a test that fails on the
old source. Findings 4 and 6 stay open, and each says why. The findings
are ranked below with the code path, then what was checked and ruled
out, so the next hunt does not re-read it.

| # | Finding | Status | Agents to redeploy |
| --- | --- | --- | --- |
| 1 | A person's keyed title gave the fixer push access | Fixed (#110) | `factory-pr-autofixer` |
| 2 | `factory: drive` judged on the boot-time repo list | Fixed (#110) | `factory-pr-autofixer` |
| 3 | `fetchPrHead` failure read as "not a factory PR" | Fixed (#111) | `factory-pr-autofixer` |
| 4 | `not_connected` on the PR path is a silent success | Open, by decision | none |
| 5 | The desk's approve was read-then-write | Fixed (#111) | `factory-desk` |
| 6 | Two delivery sources, two planner claims per transition | Open, operator config | none (Jira settings) |
| 7 | The webhook buffer rethrew inside a timer | Fixed (#111) | `factory-pr-autofixer` |
| 8 | `Merged by:` written before the Done move was known | Fixed (#111) | `factory-worker` |

## Ranked findings

### 1. Fixed: a person's keyed title handed the fixer push access to their branch

`pr-autofixer/agent/lib/auto-drive.ts` `autoDriveDecision` took the ticket
key from the branch *or* the title with no author condition, while
`github.ts` said "human-opened PRs still need the opt-in" and
`docs/plan.md` promised "a human-opened PR is never touched without a
request". A developer who opened `feature/export-fix` titled
`TLSSN-22: fix the export` (a common habit) got a `contents-write` cloud
agent pushing to their branch on the first red check, no `factory: drive`
typed. `factory-worker`'s `implementPrKey` already refuses exactly this
case ("a person titling a PR 'TLSSN-1: ...' cannot move TLSSN-1") and
counts a title only when `cursor[bot]` opened the PR; the two agents had
different definitions of "factory PR", and the one with the dangerous side
effect had the looser one.

Fix: `fetchPrHead` reads `user.login` from the same REST call;
`autoDriveDecision` counts a title only for `cursor[bot]`, answers
`title_only_from_person` otherwise, and the channel logs that one refusal.
The branch alone still counts for anyone, as it does for the worker
(`docs/questions/auto-drive-naming-convention.md` keeps that open).
Tests: `auto-drive.test.ts` (rule and `fetchPrHead`),
`channels/github-auto-drive.test.ts` (PR 22 by a person is skipped and
logged, PR 23 by `cursor[bot]` drives).

### 2. Fixed: `factory: drive` was judged on the boot-time repo list and refused silently

`pr-autofixer/agent/channels/github.ts` `onComment` passed the module-level
`repos` (captured by `githubReposAtBoot()` while the file loaded) into
`decideFactoryDrive`, while `autoDrive` and `startDrive` read
`githubRepos()` live. A hosted freeze boots before its secrets exist
(`deployment-issues.md` issue 8), so that list was `[]`, and every
`factory: drive` a person typed was `out_of_scope` for the life of the
process: `return null`, no log, no error. #107 made the red-check path fail
loudly on a stale `FACTORY_REPOS`; the manual override, the path the
README tells people to use when the automatic drive does not fire, kept
the silent one.

Fix: the opt-in reads the list at delivery time (`githubReposIfSet`); a
trusted person's opt-in on a repository the host delivered but the list
omits fails the delivery with #107's named error; `decideFactoryDrive`
judges the author before the scope so a stranger cannot raise that error;
every refused opt-in logs one line with its reason. Tests:
`channels/github-late-repos.test.ts` (own process: boots with no list,
drives once `FACTORY_REPOS` is set, fails loudly while it is not) and
`channels/github-auto-drive.test.ts` (stale list: loud for a
collaborator, quiet for a stranger).

### 3. Fixed: `fetchPrHead` failure was read as "not a factory PR"

`auto-drive.ts` `fetchPrHead` returned `{}` on any error, and
`autoDriveDecision` then answered `not_a_factory_pr`, so a GitHub or
github-proxy hiccup on a red check silently skipped the drive of a real
factory PR; nothing redelivers, so the fix waited for the next red check.
Same class as #107 and finding 2.

Fix: the read is tried three times over `CLAIM_RETRY_MS` (it runs before
the handler answers, like the claim), and a read that fails every time
throws `[pr-autofixer] auto-drive: could not read <pr> from GitHub after 3
tries (…); its red check was not judged, so no drive started`, which fails
the delivery. A red check on a person's PR fails the same way while GitHub
is down, because an unread PR cannot be told from a factory one. Tests:
`auto-drive.test.ts` (a read that recovers on a retry, and one that never
does), `channels/github-auto-drive.test.ts` (PR 26 fails loudly and claims
nothing; PR 27 fails once and still drives).

### 4. Open, by decision: a PR path that finds no tracker connection is a silent success

`factory-worker/agent/lib/pr-status.ts` `advanceTicket`: `transitionFrom`
answering `not_connected` (the slug's Jira grant revoked or expired)
releases the claim, cannot write the `not set from` note, and returns
`not_moved` without throwing, so hosted admission sees a completed task.
`failed` throws `PrStatusRetryableError` for a retry; `not_connected` does
not, and hosted v2 had no readable logs before 0.2.11, so a broken grant on the worker shows up
only as a ticket that never reaches In Review. `pr-status.test.ts` pins
"no tracker connection moves nothing and does not throw", so this is a
recorded decision rather than an oversight; the gain from throwing is
small on hosted (Ask 3: refused deliveries leave no record either;
that part is still open after 0.2.11). Left
as is; the check is the slug's MCP connectors card.

The follow-up (#111) looked again and left it. Throwing on
`not_connected` would make hosted admission retry a delivery whose grant
stays broken until a person re-consents, and it would change what a
refused delivery looks like while Ask 3 (admission records) is open.
Neither makes a broken grant visible where someone looks. The `not set
from` note cannot be written without the connection either. The useful
change is a signal outside Jira (the desk, or a health check) that the
worker's grant is gone, and that needs a channel the worker does not
have today.

### 5. Fixed: the desk's approve was read-then-write, not a guarded move

`factory-desk/agent/lib/approve-command.ts` and `tools/approve_ticket.ts`
read the status (`Planned`) and then called the unguarded `transitionIssue`
to Approved; the desk's `jira.ts` had no `transitionFrom`. The worker,
planner, and triage all moved to guarded transitions after issue 15. The
realistic racer is a replan (`Planned → Triaged`) landing between the read
and the move, after which the ticket went Triaged → Approved and the
worker launched from the old brief. The replan had the mirror race:
`request_plan` read Planned, and an approve landing before its move let
the replan pull a launched ticket back to Triaged. Re-entrancy of the
approve itself is fine: two `approve KEY` lines each take their own
per-message lease, both read Planned, the second move answers `already`,
and the worker's `implement/<KEY>` claim makes any second Approved webhook
a no-op repost.

Fix: the desk's `jira.ts` gains `transitionFrom`, which moves only from a
named status and answers `already` when the ticket is in the target. Its
status read comes after the transitions list, as the last call before the
move. Both approve paths use it from Planned. A ticket found elsewhere is
`moved_on` (the tool) or goes to the model (the host path), with the
`approved-in-slack/<KEY>` record cleared. Each step of `moveToPlanner`
(the replan, the bounce through To Do, and a Needs info reply's bounce)
uses it from the status the step before left.

What it cannot do: Jira has no conditional transition, so the guard is
still a read and then a write. A move that lands between that last read
and the transition call gets through. That window is one connector round
trip, down from the previous one, which also spanned the approval record
write and the transitions list (and the triage-comment read, for a
replan). Closing it for good needs a workflow condition in Jira (only
Planned → Approved), which the factory's global transitions rule out.
Tests: `lib/transitions.test.ts` (`transitionFrom` call order and
outcomes; a replan between `approve_ticket`'s read and its move; an
approve between `request_plan`'s read and its move, on the direct move
and the bounce), `channels/slack.approve.test.ts` (the host path under
the same replan race).

### 6. Open, operator config: two accepted delivery sources give the planner two claims per transition

`planner/agent/lib/jira-event.ts` claims `plan/<KEY>:Triaged:<changelog.id>`.
The Automation template's fallback id is
`{{issue.key}}:{{issue.status.name}}:{{issue.updated}}`; an HMAC system
webhook for the same transition carries Jira's native numeric id. Both are
accepted (`verify-webhook.ts`), so a site with both configured starts two
planning sessions per entry into Triaged. `record_plan`'s `not_triaged`
guard (#93) means the late plan writes nothing, but it still spends a run,
and `record_needs_info` checks only that the ticket is still Triaged, so
two concurrent sessions that both find nothing write two `Needs info:`
comments and the thread hears it twice.

The follow-up (#111) did not dedupe it in code. The two bodies carry no
shared name for the transition, and the planner's connector reads
(comments, status, transitions) never see Jira's changelog. So the only
signal left is that the two deliveries arrive close together. A time
window, or a per-ticket "a plan is already in flight" gate, drops a real
re-entry into Triaged whenever it lands inside the window and its
delivery from the other source is throttled or lost: a `plan KEY` after a
fast `Plan stopped:`, a Needs info reply, or a bounce while planning.
That drop is silent: the thread says the ticket went back to the planner
and no plan comes. It would also fix only half the symptom, because the
desk claims its Triaged, Approved, In Progress, In Review, and Done lines
per changelog id too, so a dual-source site double-posts every line
whatever the planner does. The remedy is configuration: one source per
slug. `jira-automation.md` now says so at the top, in operator checklist
step 1 (a site admin confirms no system webhook points at a factory
alias), in a "One delivery source" section with this reasoning, and in a
"You see" row for doubled lines; `jira-webhooks.md` and the README say
the same.

### 7. Fixed: the webhook buffer rethrew inside a timer

`pr-autofixer/agent/lib/webhook-buffer.ts` `flush` rethrows after
rescheduling, and `schedule` called it as `void this.flush(key)` from
`setTimeout`, so a persistently failing `onFlush` (the channel's `flush`
rethrows anything but `SessionBusyError`) was an unhandled rejection every
`debounceMs`, forever, for that PR. `agent-serve.js` installs an
`unhandledRejection` handler that logs and keeps the server up, so on
hosted this was a stderr line every three seconds, not a crash. Under
`node --test`, or any host without that handler, it fails the process.

Fix, deliberately minimal: the timer callback catches the rejection and
logs `[pr-autofixer] webhook buffer: flush of <pr> failed: …`. `flush` is
private and only the timer calls it, and it has already rescheduled the
entry before it rethrows, so debounce and retry are unchanged; only the
unhandled rejection is gone. The buffer is otherwise the template's.
`docs/edits.md` lists the change so a template upgrade re-applies it.
Note for BDK: the template's buffer has the same `void this.flush(key)`,
and a persistently failing flush still retries every `debounceMs` for
the life of the process. Whether it should back off or give up is the
template's call. Test: `lib/webhook-buffer.test.ts` (two failed flushes,
then a good one: logged twice, flushed once, no unhandled rejection).

### 8. Fixed: `Merged by:` was written before the Done move was known

`pr-status.ts` `leaveDeskComments` ran before the guarded move, so a merge
that then left the ticket short of Done still wrote `Merged by: <login>`
on it. #108 made Planned (the TLSSN-21 shape) walk through In Review to
Done, but a status outside the flow (`Won't Do`), an unreadable status,
or a catch-up move that failed still got the line.

Fix: `Pull request: <url>` is still written before any move, for the
desk's In Review line. The merger is written by `walkToDone` only once the
ticket is confirmed at In Review (read there, or after the catch-up move
landed) or already Done. It still comes before the In Review → Done move,
because the desk reads the latest `Merged by:` when its Done webhook
arrives; writing it after Done would race the happy-path announce that
names who merged. A merge that stops short logs `merged: "skipped"`. The
one window left is a Done move that fails after the ticket reached In
Review: the merger is already on it, so a person who drags the card to
Done gets a Done line that names them correctly. Tests: `pr-status.test.ts`
(`Won't Do`, `Blocked`, an unread status, and a failed catch-up name no
merger, then name it once when the retry reaches In Review; TLSSN-21's
writes run link, In Review move, merger, Done move; a ticket already Done
still gets the merger).

## Checked and ruled out

- **Re-entrant approve, double Approved webhooks.** Covered by the
  per-message lease, the `already` branch, and the worker's
  `implement/<KEY>` claim (`putIfAbsent` when the store has it; stale
  `pending` after ten minutes retried under the same `idempotencyKey`).
  A second Approved delivery reposts the recorded `Implementing:` URL and
  repairs the move only from Approved (`repairMove`). Never launches twice
  sequentially. Later finding: the store never has `putIfAbsent`
  ([`bugs.md`](bugs.md) ask 11), so two concurrent deliveries can both
  launch, and a stale takeover relies on an `idempotencyKey` whose
  prevention of a second agent is unchecked.
- **Concurrent In Review / Done deliveries.** Separate claims per stage
  and PR; the Done path's catch-up through In Review reads `already` when
  the opened path won. `pr-status.test.ts` has the two-concurrent-opened
  case.
- **Draft PRs.** The worker moves the ticket to In Review on `opened` even
  for a `cursor[bot]` draft; `ready_for_review` then reads `already`. The
  README states "In Review when the implement PR opens", so this is the
  design. The reviewer reviews a draft only when it is the factory's
  (`factoryDraftKey`); the fixer never skips drafts.
- **Wrong key in the branch.** `implementPrKey` anchors `^KEY-\d+`, so
  `TLSSN-210-...` is TLSSN-210, not TLSSN-21, and `revert-TLSSN-12` is
  nothing. A ticket the worker never launched (`hasLaunched` false) is
  never moved, so a keyed branch for an unlaunched ticket does nothing.
- **Merge of a non-implement PR.** A person's own `TLSSN-21-hotfix` branch,
  merged while TLSSN-21 has a launched claim, does move the ticket (the
  branch alone counts). The code comment accepts this; the registry
  alternative is in `docs/questions/auto-drive-naming-convention.md`.
  Merges by bots, apps, or `auto_merge` never move it, as designed.
- **Ticket already Done.** `guarded` reads `already` and records the
  claim as moved; no second move, no note.
- **Desk announcements against the agents' moves.** `decideStatusEvent`
  drops a delivery whose `fields.status.name` no longer matches the
  changelog target (`stale_status`), so the worker's catch-up walk
  (In Progress → In Review → Done in seconds) can lose the In Review line
  when Automation renders it after Done; the Done line still posts. By
  design ("the later delivery carries the truth"). The `move_skipped`
  outcome has no `leaves` status, so the worker's `not set from` note is
  relayed whatever status the ticket is in, TLSSN-21's Planned included.
  The Triaged, Needs info, Plan stopped, Launch failed, and Approved
  without a plan outcomes each announce only while the ticket is still in
  the status that outcome leaves it in.
- **Slack approval suppression.** `approved-in-slack/<KEY>` silences the
  Approved line for ten minutes after a desk approval, recorded before the
  move and cleared when the move fails. A board approval inside that
  window after a failed launch is also silenced; the `Launch failed:` line
  still posts through the comment rule.
- **Planner and triage late sessions.** Both move only from the expected
  status (`transitionFrom`), and `record_plan` / `record_needs_info` write
  nothing outside Triaged; the stopped-run hooks write nothing when the
  status cannot be read, so a flaky read never contradicts a move that
  landed.
- **Security reviewer.** `watches()` reads the live list on every
  delivery (unlike the fixer's comment path before this branch); the
  `reviewed/` record is written only after GitHub accepts the review, so a
  failed turn never suppresses the next delivery; an incomplete
  (truncated) review is repeated only when the cap has grown.
- **`HostedAdmissionLocalSendError`.** Both drive starts go through the
  delivery's own `send` (`driveTask`), the #72 fix; `flush` for an
  already-driven PR uses the `onStart` send, which is the intended path
  for a follow-up turn outside the admission window.

# factory-desk

Cursor Agent SDK project (`@cursor/july`). This file is for coding agents
editing the project. The served agent's prompt is `agent/instructions.md`.
Design and the six-agent factory it belongs to:
`../docs/event-driven-factory.md`.

## Loop

```bash
# The Jira host connection means call/eval/serve need a signed-in host;
# validate, info, check, test do not.
npm run check && npm test
npx -p @cursor/july@0.2.25 agent-sdk validate --dir .
npx -p @cursor/july@0.2.25 agent-sdk info --dir . --json
npx -p @cursor/july@0.2.25 agent-sdk eval --dir . --list
npx -p @cursor/july@0.2.25 agent-sdk eval --dir . --tag smoke
npx -p @cursor/july@0.2.25 agent-sdk serve --dir . --dev
```

Run the CLI under Node, never Bun. The desk has no peer connections, so
it serves and evals from this directory on its own.

## Layout

- `agent/agent.ts`: `factoryModel(process.env, LIGHT_MODEL)`, so every
  desk turn (the filing prompt, its fallback triage, commands, status
  answers) runs on catalog `grok-4.6` with `effort` `high` and `fast`
  `true` (grok-4.6-fast). The desk and triage-jira's fallback turn are the
  factory's two exceptions to Auto (`auto-smart`, `optimize_for=balanced`).
  The same `FACTORY_AGENT_MODEL` / `_EFFORT` / `_SPEED` override it as on
  every host (`auto-smart` puts it back on Auto; `grok-4.7` sends registry
  `reasoning_effort` + `speed`, no `context`). `tools: []`, `local.sandbox`, Slack egress plus `api.github.com` for the review channel's reads.
- `agent/extensions/jev.ts`: `jev({ harnessTools: false, skills: false })`,
  byte-identical to triage-jira's. It adds only hosting: `api.typesafe.ai`
  egress and the `TYPESAFE_API_KEY` secret. The model gets no Jev tool or
  skill; host code calls `decide`.
- Triage before filing (`agent/lib/intake-triage.ts`). In `deskInbound`'s
  model route, a new request (`isIntakeCandidate`,
  `agent/lib/intake-candidate.ts`: a filing phrase anywhere, not `approve
  file` / `deny file`; or a top-level mention or DM with at least
  `MIN_PROBLEM_WORDS` (4) words, keys not counted (a key is one of the
  configured projects', `TLSSN-39`; `e2e-158` and `ISO-8601` are words),
  that is no desk command,
  status question, fix request, or lone key) is asked of Jev before the
  model turn. The same predicate decides the intake 👀 (`isIntakeRequest`)
  and the filing-thread mark, so the three never disagree. Filing phrases
  match as whole words. A block for a message with no filing phrase starts
  by letting the turn answer a message that names no problem and asks for
  no change by its own rule; one with a filing phrase (`explicit`) has no
  such way out. While another message's prompt is unfiled in the same
  thread (`pendingIntake`: a channel thread, or a DM within
  `DM_FOLLOW_UP_MS`, 30 min, since a DM is one conversation July keys on
  the channel), a candidate is a follow-up: no Jev call, and the stashed
  triage is kept for its thread too and shown again, so ✅ on either prompt
  files what it says. A filing phrase in a DM is a new request. `deny
  file`, ❌ on the prompt, and `file_ticket` settle the request they decide,
  named by its source ts and never read off the DM's shared copy: the
  pending request for `deny file`, the filing prompt record's `request`
  (written by the one-reply sink from the turn's own stash) for ❌, the
  stash it read for `file_ticket`. They write
  `intake-settled/<channel>:<request ts>`, so no copy of that request under
  a follow-up's ts counts as pending again, and delete only the copies that
  are that request's (a later request's DM channel copy stays). Jev is the shared
  `agent/lib/jev-triage.ts` judge (`askTriageJev`, the project's types via
  the shared `agent/lib/issue-type.ts`, else Bug and Task), over the Slack
  text minus the mention and any filing phrase. Every answer strictly above
  `JEV_THRESHOLD` (0.52, one constant in the shared `jev-triage.ts`) is
  `by: "jev"`. Host code writes the whole filing prompt (`filingPrompt`):
  the request's title (`intakeText`: its first line that is more than an
  opener (`isOpener`: `Hi`, `Hey team!`, `Quick one:`, a bare `*Repro:*`),
  whole, minus the greeting sentences or `Quick one:` clause it opens with
  (`Hi team! Quick one. …`; a line of nothing else is skipped, and kept
  whole only when every line is openers); when that
  line is the last (one paragraph, `Sent using` footer aside, a collapsed
  inline one too), its first sentence of at least two UAX #29 words (so a
  CJK sentence counts), ending at a run of `.!?` (`?!`, `...`) before a
  space or of full-width `。！？．` (`！！`) with none (not a `．` by a digit,
  `１．５`, `手順１．`, nor inside a bracket the sentence goes on after,
  `「保存しました。」というトースト`), where a `.`
  after a quote or `...` followed by a lowercase word ends none (`"Saved."
  toast is silent`) but a bare `. lowercase` does; fenced pastes and `>`
  marks never title it (`proseLines`, shared with `requestSummary`);
  `fitTitle` cuts only past `TITLE_MAX` (400) and Jev reads it cut
  at 160, both through `fitAtWord` over `agent/lib/word-cut.ts`
  `wordPrefix`: before a space (a path or URL stays whole), else between
  UAX #29 words (CJK), each only when that keeps half the room, else
  between graphemes, with no trailing `,;:([{/-–—`), then `…`, a split code span dropped, and for a title
  that opens with one, its words kept without backticks; hosted
  2026-09-28 showed it cut mid-word at 160 with no ellipsis), `<who triaged it>: <Type>,
  <severity> severity.`, `Summary: …`, the needs-info line when thin, and
  the closing ask (`filingAsk`: `approve file` now, a plain `approve` once
  planned, never `approve KEY`; `replyPrefix` drops the mention where a
  plain reply reaches the desk, and keeps it in a channel the desk does not
  watch). For `by: "jev"` the `<intake_triage>` block carries it
  complete between `<filing_prompt>` markers and the turn replies with it
  verbatim. Jev answers no summary: it is the request's first sentence after
  its uncut title, so a one-paragraph request's next sentence (`requestSummary`, with line labels like `_On main:_` /
  `*Repro:*` and `[slug-with-dashes …]` run tags dropped; `intakeText`
  first turns Slack markup into inert text (`<url|label>` → `label`,
  `<!here>` → `@here`, `<@U…|name>` → `@name`, so the prompt pings no one
  and July posts it as `markdown_text`), then decodes `&lt;` / `&gt;` /
  `&amp;` once, so Jev reads them too; markup the reporter typed as text
  (`&lt;!here&gt;`) gets a word joiner after its `<`, and so does a `.`
  inside a link label or display name, so neither is live markup nor a
  sentence end; fenced blocks and `>` quote marks are dropped; backticks
  pair in order and an odd last one is literal (`codeSpans`), and a
  sentence never ends inside a code span, at `e.g.` / `i.e.` / `etc.` …,
  at dotted initials (`U.S.`, `p.m.`), or at a capital initial (`J.
  Smith`); past 200 characters it is cut at a word boundary, dropping a
  code span it would split and a literal backtick, with `…`, and a summary
  with no letter or digit left is none; a lowercase first letter is
  capitalised unless the first word (before a hyphen) is spelled that
  way, like `iOS`), or, for a title-only request, a slot the
  turn fills and nothing else (TLSSN-37 showed `Bug reported as "<title>",
  …` under the title). `planFiling` takes that, then the turn's summary,
  and keeps the title template only for the `Triage:` comment
  (`summaryFromTemplate`: the Filed post leaves it out). Anything else (no key, no project, Jev down or past 8 s, an
  off-label answer, an answer at or under 0.52) is `by: "model"` with the
  reason: the same prompt comes with `<Type>` (unless Jev was sure of it),
  `<severity>`, and summary slots (`SLOT`), and the same grok-4.6-fast
  turn triages the request itself to fill them, with the rubric inlined in
  the block (`agent/lib/triage-rubric.ts`, triage-jira's
  skill body; the desk has no harness tools, so a skill it cannot load
  made the TLSSN-36 turn narrate looking for it) and leads with
  `triagedByLead` (`Jev wasn't sure, so the model triaged it`, `Jev didn't
  answer, …`); a Jev type above the bar is still named. No scores reach
  Slack. There is no second model turn. A request with no block (HTTP,
  evals) uses `unaskedFilingPrompt` (reaction wording too: in Slack any
  reply asking for `approve file` is recorded for ✅/❌), which rule 0 of `instructions.md`
  quotes verbatim (`desk-commands.test.ts` fails when they drift); on
  #155's first head that rule only pointed at the block, and
  desk/file-ticket-asks-first lost its `Summary:` label.
  `agent/lib/intake-triage.test.ts` pins every variant. The answer is kept at
  `intake-triage/<channel>:<threadTs>` (the thread, the top-level
  message's own thread, and a DM's channel) for a day and logged as
  `{"desk":"intake_triage","by":…}`.
  `agent/channels/slack.intake-triage.test.ts` drives it through July's
  dispatch (Jev confident, TLSSN-36's 0.54 now above the bar, below the
  bar, Jev down).
- One reply per model turn (`agent/lib/one-reply.ts`). `slack.ts` passes
  `events` built on July's `buildDefaultEvents` in place of its
  `message.completed` / `turn.completed` / `turn.started` sinks: the
  `stop` text is held and `turn.completed` posts once, the SDK's result
  (its last assistant step), or the held text when that is empty. July's
  own sinks post both when a turn has two assistant steps and no tool call
  between them, which leaked narration ahead of the filing prompt on
  TLSSN-35 and TLSSN-36. `agent/channels/slack.one-reply.test.ts` replays
  that turn against both. Every sink first points `state.threadTs` at the
  thread root when it is a recorded `filing-prompt/…` inside a thread: July
  keys a ✅ turn's state on the reacted prompt, a reply, and its
  postMessage guard threw `ignored thread_ts` after Slack posted under the
  root (no `lastBotMessageTs`, `invalid_thread_ts` from
  setSuggestedPrompts). `slack.reactions.test.ts` replays that turn.
- `agent/instructions.md` is the always-on prompt and the whole routing table.
- `agent/channels/slack.ts`: the one Slack app (`FACTORY_DESK_SLACK_*`),
  `toolApprovals: false`, mentions and DMs plus `engagement.channelPosts`
  on the demo intake channel (`C0EXAMPLE1`, `#mars-eng-intake`) with
  `posts: "all"`, behind `factoryThreadReplies` (`agent/lib/plain-reply.ts`):
  a post without the mention counts only as a reply in a factory thread (a
  ticket's, the filing root the desk replied to, or one awaiting a
  needs-info answer), and only as an exact command, that needs-info
  answer, or a clear question to the factory; every other post there gets
  no turn. `agent/channels/slack.live-commands.test.ts` drives it through
  July's dispatch. In-thread copy writes commands plain (`approve file`)
  where a plain reply reaches the desk (`replyPrefix` in
  `agent/lib/desk-channels.ts`), with the mention elsewhere; the model gets
  the same rule in `<slack_reply>`. Hosted v2 needs the next
  `agent-sdk deploy` so the allowlist becomes subscription edges; local
  Socket Mode also needs `slack create --channel-posts` (or
  `slack manifest --channel-posts`) if the Factory app was provisioned
  without channel-post event subscriptions.
  `onAppMention`, `onDirectMessage`, and `onChannelPost` are `deskInbound`
  (`agent/lib/fix-request.ts`). Before the model path, `takeApproveCommand`
  (`agent/lib/approve-command.ts`) approves a message that is exactly
  `approve KEY` from the filer, in the ticket's thread, while KEY is
  Planned: same gates as `approve_ticket`, one move to Approved, a ✅
  reaction, no reply, claimed per message ts. Cursor Slack-send chrome
  (`*Sent using* …`) and a Slack-autolinked KEY are still that command;
  extra words from the person are not (more words go to the model). A
  refusal, a ticket not in Planned, or a failed move gets one fixed host
  reply and the handler still returns null, so no model turn follows.
  Every exact `approve KEY` it declines logs
  `{"desk":"approve_command","outcome":…,"why":…}` naming the gate
  (`not_filer`, `external`, `unbound`, `wrong_thread`,
  `claim_unavailable`, `status_unread`, …).
  A plain `approve` (same chrome and mention) is `approve KEY` for the one
  ticket its thread maps to: `thread-tickets/<channel>:<ts>`
  (`agent/lib/thread-tickets.ts`), written by `file_ticket` and every
  `postTicketUpdate`, and counted only while `ticket/<KEY>` still names that
  thread. A thread that maps to none or several gets one host line asking
  for `approve KEY`, except an unfiled filing thread
  (`filing-thread/<channel>:<ts>`, marked by a new request (`isIntakeCandidate`) or
  `approve`/`deny file`), where it goes the model route `approve file`
  goes. The plan post's Next line offers `approve` (or `approve KEY`).
  `agent/channels/slack.approve.test.ts` drives it. A reply that is exactly
  `deny file` (same chrome allowed) in a channel thread gets ✅ before the
  model's turn: it files nothing, so no tool can ack it. Then `takeThreadDetail`
  (`agent/lib/thread-detail.ts`) answers a reply in a thread the desk
  marked `awaiting-info/<channel>:<ts>` (a Needs info line, or a Triaged
  line whose verdict needs information): unless it is a desk command
  (including a filing request or a status question, from
  `DESK_COMMAND_PHRASES`), a bare thanks, a bot, or a Slack Connect
  sender, and the ticket is still
  Triaged, it writes `Detail from Slack: KEY` on the ticket, bounces it
  To Do → Triaged (`agent/lib/plan-move.ts`, shared with `request_plan`),
  posts a fixed line, and claims `thread-detail/<channel>:<ts>`. No model
  turn. `agent/channels/slack.thread-detail.test.ts` drives it through
  July's dispatch. A message whose raw Slack text, after
  trimming and removing the bot mention, is exactly a fix verb (`fix`,
  `drive`, `take over`, `get CI green`, `address the review`), optionally
  `on` or `for`, one PR reference (GitHub PR URL, Slack `<url>`,
  `<url|url>`, or Slack's autolink `<url|github.com/o/r/pull/N>`, or
  `owner/repo#N`), and nothing after it but `.`, `!` or `?` (a Cursor
  `Sent using` footer is chrome, as for `approve KEY`), gets a fixed in-thread
  reply (type `factory: drive` on the PR yourself; a factory PR is driven
  on its first red check) and no model turn. Bot authors and Slack
  Connect senders never get it: the desk reads the answer July caches
  from its own pre-handler `users.info` lookup (one call per message, none
  from the desk), and a sender not classified within 5 s counts as
  external. The cache read goes through one module-level probe
  (`JULY_CACHE_PROBE`): July keeps a `users.info` map per token object and
  never drops one, so a probe per poll leaked a map every 25 ms. Probe
  reads run one at a time, since a shared probe also shares July's
  in-flight lookup and a second read would take the first's failure for
  an answer (`fix-request.test.ts` pins both). July never expires those
  records or verdicts (`../docs/july-users-info-cache.md`), so
  `julyUserCache` (`agent/lib/july-user-cache.ts`) wraps both Slack
  handlers and clears July's user caches once they are 30 min old or
  1,000 senders in, only while no desk handler runs. `recordingSpeakers`
  hands July one transport per host Slack client (`hostSlackTransport`
  in `originator.ts`), never one per message: a new key per message kept
  every such message's binding. `july-user-cache.test.ts` pins July's
  current cache behaviour, so an upgrade that fixes it fails there first.
  `agent/channels/slack.test.ts` drives `slack.ts` through
  July's inbound dispatch and counts the Slack calls.   Everything else goes to the stock
  `createDefaultOnInbound`, where July's external policy applies. Every
  model turn also gets a `slack_reply` hint: no tool names, ask copy uses
  `deskSlackHandle()` (never `@factory-desk`).
  Tokens are split on whitespace and the PR reference is one token, so a
  command word inside a repo name (`acme/status#1`) is never read as a
  command. The routing phrases live once in `agent/lib/desk-commands.ts`
  (`DESK_COMMAND_PHRASES`, whose fix verbs the matcher uses);
  `desk-commands.test.ts` parses the routing table in `instructions.md`
  and fails when the two drift, so a new phrase goes in both.
- `agent/channels/jira.ts`: Jira `issue_updated`. HMAC or
  `X-Factory-Webhook-Secret` / Bearer first, then `decideStatusEvent`
  (`agent/lib/status-event.ts`). Entering Triaged runs `announceTriaged`,
  which posts the governing `Triage:` verdict (`agent/lib/triage-comment.ts`,
  the planner's own gate, `governingTriage` in the shared
  `agent/lib/desk-triaged.ts`: the desk's comment, which ends with
  `DESK_TRIAGED_LINE`, else the first comment a triage run wrote, unless a
  person wrote a later `Triage:` comment with no `Triaged by:` line) into the
  ticket's thread, opening a Jira-filed
  ticket's intake root there, and says when the planner will skip it.
  Every announce goes through `announceInThread` (`agent/lib/announce.ts`):
  an unbound ticket whose description has `file_ticket`'s `Slack thread:`
  line (`filedFromSlack`, `agent/lib/jira.ts`) opens no root, and a post
  that lands under an intake root leaves `Slack thread: <root permalink>`
  on the ticket once (`agent/lib/intake-backlink.ts`, `backlink/<KEY>`),
  which the planner's brief and the worker's PR body already read.
  The plan hop watch for a Triaged entry (and the launch watch for Approved) is armed after that announce settles. The claim is per verdict fingerprint
  (`triagedAnnounceKey`: type, severity, Jev choices, gate, whether a
  `Plan:` comment is already there), so a Needs-info → To Do → Triaged
  bounce with the same Jev (TLSSN-29) does not repeat the Triaged line.
  The Triaged, outcome (Needs info included), review-gate, and thread-detail claims
  pass `settleMs` (`claimSettleMs`, `FACTORY_DESK_CLAIM_SETTLE_MS`,
  default 2 s) to `takeLease`, which re-reads the claim after that wait
  and yields unless it is still this delivery's, so concurrent deliveries
  post once (README, claims). Tests that drive these paths set the env to
  a few milliseconds; `agent/lib/kv-race.fixtures.ts` forces the race.
  Hosted kv has no compare-and-set, and two concurrent sessions can each
  read back their own claim (TLSSN-38: the CI line twice, 0.24 s apart,
  after the settle claim), so review updates do not rely on it: CI is
  announced only by its owning `github-actions` `check_suite` wake
  (`ownsCiAnnouncement`; never `workflow_run`), and every review update
  reads the thread before and after it posts (`agent/lib/review-thread.ts`):
  a line already there for the head is skipped, and a later duplicate
  takes itself back (edit, or delete when nothing of its own is left).
  `review-announce.test.ts` gives each concurrent wake its own kv copy.
  A desk-filed ticket's first verdict posts no Triaged line:
  `file_ticket` marks that verdict's claim `{ state: "done", filed: true }`
  (`markFiledTriage`) before its move, and `announceTriaged` answers that
  one entry (`heard` records its changelog id) with the stage reaction,
  the planner crumb for an ungated verdict, and the needs-info awaiting
  record; later entries go the usual way. `channels/jira.test.ts` pins it beside a Jira-filed ticket
  that keeps its line. The Triaged line says the verdict in plain words,
  `Bug, low severity (triaged by Jev)`, from the comment's `Triaged by:`
  line (else `Jev only` on the Judge: line), with no scores.
  After a first (or changed) Triaged line the thread gets one planner
  crumb (`TLSSN-NN: planner is checking the code…`, `agent/lib/loader.ts`)
  and the filer's message walks to ⏳; Planned, Needs info, Plan stopped,
  a gated verdict, or the hop-watch stuck line clears that crumb. `takeThreadDetail` posts
  `re-planning with your reply…` instead of a second Triaged line;
  host `approve KEY` posts `starting implementation…` until In Progress.
  The In Review line posts `KEY: checks running…` (or `waiting on Bugbot,
  security, CI…` naming only the gates a review wake already saw pending;
  nothing when they had all settled) and records `inReview` at
  `review-gates/<KEY>`.
  Entering Planned runs
  `announcePlan`, or `announceMovedBack` when it came from Approved or
  later (`movedBackFrom`); entering Approved runs `announceApproved`,
  which posts nothing while `approved-in-slack/<KEY>`
  (`agent/lib/slack-approval.ts`, written by `approve_ticket` and the
  host approve path just before the move) is under ten minutes old, so a
  Slack approval's one beat is In Progress; entering In Progress runs
  `announceProgress`; entering In Review or Done runs `announceClosing`
  (`agent/lib/announce.ts`), which links the PR from the latest
  `Pull request: <url>` comment the worker leaves before those moves
  (`latestPullRequestComment`), and on Done names the GitHub login from
  the latest `Merged by: <login>` comment (`latestMergedByComment`). A
  missing comment posts the plain line (In Review without a link, Done
  without a login or without a link). `factory-worker` makes those last two moves
  from its implement PR (a person's merge for Done), or a person drags the
  card. No agent merges. The same route takes `comment_created` from the
  desk's TLSSN comment rule: a first line that is a factory outcome
  (`agent/lib/outcomes.ts`: triage's `Triage stopped:`, the planner's
  `Needs info:` / `Plan stopped:`, the worker's `Launch failed:`,
  `Approved without a plan …`, `<status> not set from …`) runs
  `announceOutcome`, which posts into the ticket's thread (`threadOnly`:
  never an intake root's status line; `opensRoot` lets every outcome but
  move-skipped open a Jira-filed ticket's root) and only while
  the ticket is still in the status that outcome leaves it in, why it did
  not move on and the next step. The planner writes `Plan stopped:` on
  every Triaged entry its verdict gate skips (its second line says no run
  started); `redundantSkip` posts nothing for one while no planner crumb
  is up and the desk sent nothing to the planner in the last 30 minutes
  (`planner-sent/<KEY>`, written by `moveToPlanner` before its move, so
  every `plan`, `retry`, `request_plan`, and Needs-info send counts): the
  Triaged line or Filed post already said the planner will not plan that
  verdict. After any send, or with the crumb up, it posts, so a bounce the
  planner skips never ends on the crumb. The parsers are
  `planner-outcome.ts`, `triage-outcome.ts`, `worker-outcome.ts`;
  `../scripts/outcome-sentinels.test.mjs` pins them to each writer, so a
  new outcome goes in the writer, the parser, `OUTCOMES`, and that test.
  Every other comment is ignored before any Jira read. The Triaged line names both endings (a
  plan, or what information the planner needs) and never promises a plan.
- `agent/lib/hop-watch.ts` + `agent/reminders/hop_watch.ts` +
  `agent/schedules/hop-watch.ts`: one durable watch per ticket with a
  thread, on the hop it is in (`HOPS`): triage (armed by `file_ticket`
  after the binding only when its Triage: comment or Triaged move did not
  land, 15 min), plan (entry into Triaged, 15 min), launch
  (entry into Approved, 7 min, a minute after the worker's own relaunch
  could last land). `hop-watch/<KEY>` holds the hop, the
  entry's changelog id, the deadline, and the newest Jira comment id; it
  is listed in `hop-watch/index` because `host.kv` cannot list keys. Index
  writes are the shared `agent/lib/kv-index.ts` verified merge (byte-identical
  in the worker, tested here in `kv-index.test.ts`): an arm is a union onto
  the stored list (`updateVerified`, 2 attempts), then after
  `claimSettleMs` plus a random jitter of up to min(500 ms, settle)
  (`indexConfirmDelayMs`, so two arms that raced do not confirm at the same
  instant) one confirm that re-adds the key if a concurrent write dropped
  it; a redelivery of the same entry (`already_armed`) adds it again
  (self-heal); the sweep's prune removes only keys whose record it re-read
  as gone, from the list as stored at the write, then re-reads each one's
  record and re-adds any that is back (a re-arm whose add found the key
  still listed wrote nothing). `FACTORY_DESK_CLAIM_SETTLE_MS=0` skips the
  confirm. A put that lands after the
  confirm can still drop a key until that ticket's next arm.
  `FACTORY_INDEX_MERGE=off` restores the plain read-then-put add and prune,
  with no self-heal. `hop-watch.index.test.ts` races arms, the prune, and
  the frozen `testing/legacy/hop-watch-index.ts`. The
  deadline is a one-shot reminder with the named handler `hop_watch`
  and JSON args, since hosted v2 fires those and rejects anonymous
  reminder `run`. The schedule is a backstop sweep: self-hosted serve
  fires it on its own clock, and on hosted v2 July 0.2.13 `deploy`
  declares it in the release manifest (`hop-watch`, `run`, every five
  minutes; `agent/discovery.test.ts` pins the declaration) for the
  control plane to fire, so the file name must stay a valid schedule id
  (`^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$`). Each run (`runHopWatchSchedule`)
  logs exactly one `{"desk":"hop_watch","via":"schedule","due":N,"fired":M}`
  line, idle or not, from counts the sweep already has (no extra kv or
  Jira call). The expected move, another move, or the hop's
  outcome comment clears the record and cancels the reminder. The fire
  re-reads Jira and stays quiet when the ticket moved on or a plan's
  verdict is gated. It announces an outcome comment newer than the
  baseline through `announceOutcome`, since the comment rule may be off.
  After three unreadable statuses it says the desk cannot tell.
  Otherwise it posts one `threadOnly` line naming the hop and
  `retry KEY`, claimed at `announced/<KEY>:hop-<hop>:<changelog>`. A
  thread with no Slack filer (a Jira-filed ticket's intake root, where
  `retry KEY` is refused as `unbound`) hears the board move retry would
  make instead (`redeliverStep`). Either line sets ⚠️ on the thread root,
  since the crumb comes down and the stage reaction would still say the
  hop is running. The deadline watch never retries on its own. Serve `--dev` fires neither; use
  `POST /v1/dev/reminders/<id>` or `/v1/dev/schedules/hop-watch`. A new
  hop is one `HOPS` entry, one arm in `channels/jira.ts`, and one branch
  in `retry-command.ts`.
  The plan hop also has a **start check** (`firePlanStartCheck`,
  `agent/reminders/plan_start.ts`), `PLAN_START_DEADLINE_MS` (4 min) after
  the Triaged entry, armed by the same `armHopWatch` as a second named
  reminder (`plan_start`, `startReminderId`, `startDueAt` on the record)
  and backstopped by the same sweeps (`PLAN_START_SWEEP_GRACE_MS`, 1 min,
  past a late reminder). It exists for TLSSN-60 (`../docs/deployment-issues.md`,
  issue 28): a hosted planner delivery handed a reused session by the
  control plane throws before its turn starts and logs nothing, so no
  `Planning started:` marker lands. The check re-reads Jira: a ticket that
  left Triaged (`moved_on`), a gated verdict (`gated`), or any proof the
  planner ran for this entry (`planningRun` not `not_started` against
  `since`, a `Plan:` or a plan outcome above the baseline) is `started`,
  and each of those gives the one re-send back, except a To Do read: that
  is the re-send's own bounce seen mid-way, so the record stays (a To Do
  webhook is `other_status` and never reaches `clearHopWatch` either). An
  unreadable Jira looks
  again in `PLAN_START_UNREAD_RETRY_MS` (1 min), `MAX_UNREAD` times, then
  gives up for the entry (`unread`): it never retries blind. Otherwise, with
  no standing record at `plan-start-retry/<KEY>`, it takes that lease
  (settle re-read), re-sends the ticket exactly as `retry KEY` does
  (`agent/lib/planner-redeliver.ts` `redeliverToPlanner`: `moveToPlanner`
  with `kv`, then `clearAwaitingFor` and `showPlannerWait`; the filer gate
  and the within-deadline check are skipped, the triage gate and the live
  run guard hold), writes `startCheck: "retried"` on the entry's record
  before the move (a concurrent fire for the entry stops at
  `already_checked`), marks the claim done before it posts (a lost finish
  is warned through `warnKv`), and posts one two-line alert ("…so I've
  sent it to the planner again"), claimed at
  `announced/<KEY>:plan-start-alert:<changelog>`, keeping ⏳ and the crumb.
  A move that fails releases the record (the next entry gets its own
  re-send), replaces the mark with `not_moved`, and the alert says planning
  could not be re-sent, with `redeliverStep`'s retry or board move. The
  claim is keyed by entry: one standing from this very entry is a
  `duplicate` (the re-sent entry itself never gets the final line); one
  from another entry (done, or a pending claim past its lease, since a
  newer entry proves that move landed) inside `PLAN_START_RETRY_TTL_MS`
  (2 h) posts the final line instead ("…still hasn't started after one
  automatic retry, so planning couldn't start. The next step is a planner
  redeploy or asking ops; …", `plan-start-final`), sets ⚠️, clears the
  crumb, and never moves. "After one automatic retry" is said only on the
  entry the re-send produced: `armHopWatch` names the first plan entry
  armed after the re-send as its `successor` on the record
  (`adoptPlanStartSuccessor`, a verified write on a done record only); a
  later entry (a person's `retry`, a drag) gets the generic "still hasn't
  started, so planning couldn't start". A fire before `startDueAt` (a
  sweep-armed reminder rounds its delay to minutes) is `early` and
  reschedules for the time left. The outcome on the record (`startCheck`)
  means a reminder and a sweep never run one entry twice; the 15-minute
  fire for a `final` or `not_moved` entry is `suppressed` unless the
  planner started late; and `retry-command.ts` lets a manual retry through
  inside the deadline once `startCheck` is `final`, `not_moved`, or
  `retried` (`startCheckFreesRetry`): a bounce that landed arms a new entry
  over the record within seconds, so one still at `retried` is a re-send
  whose request died between its mark and its moves, and the live-run
  guard still refuses a run that did start. For the same reason the
  deadline fire treats a `retried` record whose ticket reads To Do (the
  bounce's first move landed, the second did not) as still waiting and
  posts the stalled line (`strandedResend`); any other status past
  Triaged is `moved_on`. The final line's "after one automatic retry" also
  applies, with no named successor, to an entry whose Triaged time is
  within `START_SKEW_MS` of the record's `movedAt`. `clearHopWatch` with no hop or the plan hop,
  and an arm that leaves the plan hop, delete the record. Each
  arm and fire logs one `{"desk":"plan_start_watch","via":"arm"|"reminder"|"sweep",…,"result":…}`
  line; the `hop_watch` schedule line's counts are the deadline fires
  only. `plan-start-watch.test.ts` drives it, `slack.retry.test.ts` the
  manual retry after it, `../scripts/launch-timing.test.mjs` its timings.
- `agent/lib/planner-liveness.ts`: reads the planner's `Planning started:
  <KEY>` comment. A marker with no `Plan:`, `Needs info:`, or `Plan stopped:`
  after it is a live run for `PLANNING_LIVE_MS` (40 min), then lost. It
  belongs to the current entry when its `Started at:` is no earlier than the
  entry time (`entryTime` in `channels/jira.ts`, taken before the Triaged
  announce) minus `START_SKEW_MS`: the watch is armed after the announce,
  so a marker can land below its baseline comment id. The plan
  hop's stuck line says "the planner is still running (N min)", "never
  reported starting", or "probably lost", with the work named for the
  ticket's type (`planningWork`), and `retry KEY` on Triaged refuses a second
  run while one is live (`still_running`).
- Triage credit (`agent/lib/triage-credit.ts`): the filing prompt, Filed
  post, and Triaged line say `Triaged by Jev: Bug, medium severity (78%
  confidence)` or `Triaged by Grok 4.6 Fast (Jev was only 50% confident):
  Bug, high severity`; the model's name comes from the host's model settings
  (`fallbackTriageModel` in the shared `jev-triage.ts`), and the Triage:
  comment's `Triaged by:` line names it the same way. The filing prompt's
  title is a slot the turn fills in its own words (`TITLE_RULE`).
- Declines: ❌ on the plan post and a typed `deny` / `deny KEY` run one
  check first (`declineGate`): a ticket that is not Planned gets `KEY is X,
  not Planned, so there is no plan to decline.` and nothing is recorded; a
  plan already declined says so, with no ✅. Otherwise both give the
  same one line (`declinedLine`), write the same `Denied in Slack by`
  comment, add the `plan-declined` label, and move the root's stage to 🚫
  (`recordDecline` in `agent/lib/plan-decline.ts`); a new plan post, an
  approval, or any status move out of Planned the desk sees takes the label
  off. `deny KEY` and `deny file` in a DM get ✅
  like approve. The ❌ path logs `{"desk":"plan_decline","ms":{…}}` per phase.
- `agent/lib/retry-command.ts`: before thread detail, `takeRetryCommand`
  takes a message that is exactly `retry KEY` (approve's Slack chrome
  allowed) from the filer, in the ticket's thread. A filer-gate refusal
  gets one host line (`host-refusal.ts`; bot and Slack Connect senders get
  none), never a model turn. Claimed per message ts. A watched hop still
  inside its deadline is not started again. To Do and Triaged get
  `moveToPlanner` after the triage gate. Approved is bounced
  Approved → Planned → Approved with `retry-bounce/<KEY>` (quiets
  `announceMovedBack`) and `approved-in-slack/<KEY>`. A worker claim
  already `launched` turns the redelivery into a re-link, not a second
  launch. `retry KEY` goes ahead once the launch hop watch is past its
  7-minute deadline (`HOPS.launch`), or when there is no hop watch at all.
  The worker takes a `pending` claim over once it is older than 3 minutes
  (a younger one leaves the redelivery in flight), and its own launch watch
  relaunches at about 4 (a 30 s deadline and 60 s late wait after that), so
  the deadline falls a minute after both (`../scripts/launch-timing.test.mjs`).
  A takeover first adopts any agent the lost launch started (`Implementing:`
  URL or `Agent.list`) and creates one only when the listing positively
  finds none.
  An Approved ticket with no `Plan:` comment is refused. In Progress with the worker's
  `Implementing:` comment (TLSSN-35: the agent pushed, no pull request
  opened) is moved In Progress → Approved with `retry-pr/<KEY>`, which
  quiets that Approved line and the In Progress line that follows; the
  worker moves it back and opens the pull request from the agent's branch,
  and In Review is the next line. In Progress without that comment has
  nothing to retry. It replies once in every
  case. `channels/slack.retry.test.ts` drives it through July's dispatch.
- `agent/lib/plan-command.ts`: after retry, `takePlanCommand` takes a
  message that is exactly `plan KEY` or `replan KEY` (same chrome) with
  the same filer and thread gates (`filerGate`, `retry-command.ts`), then
  request_plan's status check, triage gate, and `moveToPlanner`. Success
  is ✅ on the command and the planner crumb, no text; a gated verdict, a
  ticket past Planned, or a failed move gets one host line, and so does a
  filer-gate refusal (`host-refusal.ts`). Every path that sends a ticket to
  the planner (this, `retry`, `request_plan`, thread detail) posts the
  crumb itself through `showPlannerWait` (`agent/lib/planner-wait.ts`):
  a same-verdict bounce posts no Triaged line, so waiting on the webhook
  left TLSSN-32 with only ⏳. A retry refused inside the plan hop's
  deadline makes sure the crumb is up, and a hop-watch stuck line clears
  it. The leading mention may be `<@U…>`, `<@U…|name>`, or `@name`
  (TLSSN-32's `@factory retry` arrived labeled and went to the model).
  `channels/slack.plan.test.ts` drives it through July's dispatch.
- The one-reply contract (TLSSN-33): every recognized host command
  (`approve`/`retry`/`plan`/`replan` KEY, bare or after `<@U…>`,
  `<@U…|name>`, `@name`) posts at most one host reply and the handler
  returns `null`; returning `{}` or a decision would start a model turn
  and add a second, `Auto routed to …` reply. `handled-message.ts` also
  claims `handled-message/<channel>:<ts>` before any of them, so the
  `app_mention` and `message` twins of one post are handled once
  (everysphere `anybot/incident-bot/handled-message-gate.ts`).
  `deskInbound` sends an exact command to `takeHostCommand` and returns
  null from there whatever happens: a command that throws gets one host
  line instead of a hosted 503 and a silent redelivery. `approveCommandText`
  treats any `Sent using` footer line (`*…*`, `_…_`, bare), invisible
  format characters, bold/italic/code marks, and a typographic dash in the
  key as chrome. Hosted delivery can collapse the footer's newline
  (`plan TLSSN-33 *Sent using* <@U…>`), so `stripSlackFooter` also drops
  an inline footer that ends the message with one sender (a mention or a
  one-word app name); command, fix-request, and thread-detail parsing all
  read it. Every human message logs
  `{"desk":"inbound","route":…,"generation":…}` (`AGENT_SERVE_GENERATION`);
  one that looks like a command but went to the model adds `nearMiss` and
  its escaped `text`/`body`/`markdown`, which tells a live miss from the
  deployed generation or the text July was given.
  `channels/slack.live-commands.test.ts` replays the TLSSN-33 smoke
  (`plan KEY` on In Review, bare `retry KEY`, autolinked `fix`) through
  July's dispatch. The fix
  request's fixed reply takes the same claim (`firstDelivery(…, {
  hostReply: true })`). A thread-detail reply is deduped by its own
  `thread-detail/<channel>:<ts>` claim, read before the awaiting record:
  the delivery that took it clears the record and bounces the ticket
  through To Do, so a later twin would otherwise read "not awaiting" and
  go to the model after the host answered.
  The planner itself wakes on each bounce: every Triaged entry is a new
  changelog id, so a new `plan/<KEY>:Triaged:<changelog>` claim and a new
  continuation; a restored finished session is a redelivered old id.
- `agent/lib/reaction-approval.ts` (`onReactionAdded`; July 0.2.11 and
  later deliver `reaction_added` on hosted v2): a person's ✅ / ❌ on the
  desk's filing prompt or plan post decides it, beside the typed commands,
  which are unchanged. Only a post recorded when it landed counts
  (`agent/lib/reaction-targets.ts`: `plan-post/<channel>:<ts>` from
  `announcePlan` through `announceTicketUpdate`'s `posted` callback,
  `filing-prompt/<channel>:<ts>` from the one-reply sink when its reply asks
  for `approve file`, with the turn's triggering user as requester and the
  thread it was posted in as its root, never the session's auth: July keys
  a DM's session on the channel and keeps its first message's auth), so the
  desk's own stage reactions on a thread root never count. July marks every
  reactor human and keys the reaction on the reacted message, so the
  handler looks the reactor up itself (the cached self identity from
  `self-identity.ts`, `users.info` for `is_bot`; a failed lookup counts as
  a bot) and applies the typed
  gates: Slack Connect senders out, the requester for a filing prompt, the
  bound filer in the ticket's own thread for a plan. Everyone else is
  ignored with no reply, logged as `{"desk":"reaction","outcome":"ignored",
  "why":…}`. Each acting reaction takes `reaction/<channel>:<ts>/<act>`
  with `settleMs` first. Only a declined or already-filed filing prompt
  marks it done; a plan reaction or a filing ✅ leaves it pending to expire
  after two minutes (a redelivery inside that is silent), so the same post
  counts again once its ticket is Planned again or its filing turn filed
  nothing, and a ✅ that found the ticket's decision hold taken releases it. Plan ✅ is `approvePlanned`
  (`approve-command.ts`), the typed approve's own path: a per-ticket hold
  `approve-ticket/<KEY>` (settle re-read, left pending for
  `APPROVE_TICKET_HOLD_MS` on success) turns a ✅ plus a typed approve, or
  any redelivery, into one move and one `starting implementation…` crumb;
  `transitionFrom` is the last guard (an `already` move posts no crumb).
  The hold is the ticket's one decision hold (`takeTicketDecision`): plan
  ❌ and `deny_ticket` take it too (and release it after, since a declined
  plan can still be approved), so an approve and a decline never both
  land; `deny_ticket` answers `decision_in_flight` while it is held. A new
  plan post clears it (`recordPlanPost`), so the new plan's ✅ or
  `approve KEY` goes through at once, and a hold older than
  `APPROVE_IN_FLIGHT_MS` (45 s) on a ticket that is Planned again (moved
  back without a new post) is taken over, unless it is a decline's hold
  (it records `act`; a decline never leaves Planned), which every taker
  honours for `DECLINE_HOLD_MS` (5 min) however long its Jira calls hang.
  Plan ❌ on a plan Jira already shows declined (`planDecline`) writes
  nothing and posts `The plan for KEY is already declined; nothing
  changed.` once, unless the thread already heard a ❌ decline of that
  plan (`decline-answered/<channel>:<thread>/<KEY>`). Otherwise plan ❌
  writes `deny KEY`'s `Denied in Slack by <name>` comment and posts
  one line asking for the change as a ticket comment then `replan KEY`;
  the ticket stays Planned, and a later ✅ or `approve KEY` still builds it. Filing ❌ posts one short line and files
  nothing. Filing ✅ returns an `approve file` model turn whose auth names
  the filing thread's root (so `file_ticket` reads that thread's triage and
  binds it), after recording the reactor there as the latest speaker with
  an `approve file` command; `file_ticket` takes `file-ticket/<channel>:<ts>`
  (settle re-read, held two minutes) so that turn and a typed `approve
  file` file one issue; the next filing request in that thread (a DM's
  next bug) ends the hold once it is past `FILING_IN_FLIGHT_MS` (60 s),
  so a create in flight keeps it (`endFilingHold`, from
  `stashIntakeTriage`). A filing prompt counts as filed when its channel
  thread has any ticket; in a DM, which is one thread holding every
  request's ticket, only the first ticket bound after the prompt landed
  (`filedAt`, 5 s clock slack) and not listed on the prompt's record as
  already there (`before`, written by the one-reply sink) is its filing. Then ✅ does nothing and ❌
  names that ticket, and the claim is left to expire. The
  reactor's speaker record carries `reaction: true`, so `file_ticket` acks
  no message (the reaction's ts is not one). The filing prompt (`filingAsk({ reactions: true
  })`, in the Slack intake block and `unaskedFilingPrompt` alike) and
  the plan post's Next line say to react ✅ / ❌ or reply.
  `agent/channels/slack.reactions.test.ts` drives it through July's
  `reaction_added` dispatch.
- `agent/lib/status-reaction.ts`: the desk's own outbound stage reactions
  on the thread root (never read back; see reaction-approval above).
  `deskInbound` adds 👀 to a top-level
  channel message that is a new request (`isIntakeCandidate`) before the model turn (not a
  bot, not Slack Connect). `file_ticket` records 👀 as the ticket's stage
  once the thread is bound. Every lifecycle announce then passes a stage
  to `announceTicketUpdate`, which, after the post lands, adds the stage's
  emoji to the thread root (the filer's message, or a Jira-filed ticket's
  intake root) and removes the one
  recorded at `reaction/<KEY>`: `eyes` (filed), `hourglass_flowing_sand`
  (planner running), `memo` (Planned, moved back), `hammer_and_wrench`
  (Approved, In Progress), `mag` (In Review), `white_check_mark` (Done),
  `question` (a gated Triaged verdict, Needs info), `warning` (triage or
  plan stopped, launch failed, approved without a plan, a hop watch's
  stuck line). A transition
  with an older changelog id than
  the one shown changes nothing. A DM gets none. Failures never block the post.
- `agent/lib/command-ack.ts`: ✅ (`APPROVED_REACTION`) on the person's own
  command message, never a text reply: `approve file` once `file_ticket`
  created the issue, `deny file` (host, above), and `approve KEY` once the
  ticket is Approved, from the host path or `approve_ticket`. The tools
  know the message from the command record the inbound handler wrote
  (`resolveCommand`, and `commandTs` on an `ok` gate), so a command the
  model handled is acked like one host code took. Bounded by
  `ACK_TIMEOUT_MS` (`@slack/web-api` has no request timeout and retries
  for half an hour), one retry on a transient Slack error, never throws,
  and one `{"desk":"command_ack",…}` line per ack, on stderr when it did not
  land. `agent/lib/command-ack.test.ts` drives the tools.
- `agent/host-connections/tracker.ts`: host-only Cursor account Jira,
  byte-identical in the planner and the worker
  (`../scripts/copies-parity.test.mjs`). The desk's tools create an issue,
  move a ticket to Triaged or Approved, and comment through it. The model
  never sees a Jira tool, so it cannot browse or edit a ticket of its own
  accord. The desk has no GitHub connection or tool
  and never writes to GitHub. `agent/discovery.test.ts` loads the project
  with July's loader and fails on any other host or model connection,
  anything GitHub in one, or a GitHub token secret name.
- `agent/channels/github.ts`: read-only `githubChannel`
  (`cursorAccount: { repos: FACTORY_REPOS, permissions: "read" }`,
  `continuation: "github.none/v2"`, no replies, no reactions, comments
  null) on `pull_request`, `check_suite` / `workflow_run` completed, and
  `pull_request_review` submitted. Every hook is a host task into
  `announceReviewUpdateWithRecheck` (`agent/lib/review-announce.ts`): re-read
  the PR, gate on open + factory key + bound `ticket/<KEY>` thread + the
  ticket's `Pull request:` comment, settle Bugbot / security review / CI / change-monitor /
  autofix at the head (`agent/lib/review-update.ts`, pure), lease each gate
  at `review/<owner>/<repo>#<n>/<sha>/<gate>` with `settleMs`, and post one
  threadOnly `KEY review update on <sha>` reply through
  `postTicketUpdate`: the header, then one bullet per gate,
  `<emoji> <Gate> — <status> · <link>`, one gate or five. The
  security review is leased per verdict change instead
  (`review/<owner>/<repo>#<n>/security/<fingerprint>/after/<sha|none>`,
  `securityFingerprint`: verdict, findings by severity/file/title, unreviewed
  files; the last one heard at `review-security/<owner>/<repo>#<n>`), so an
  unchanged CLEAN on a new push is not announced again (TLSSN-31) and a new
  finding or a changed verdict always is. Do not key it back on the head.
  Every wake past the thread gate also writes the still-pending gates to
  `review-gates/<KEY>` and keeps the `reviewing` crumb in step
  (`syncReviewLoader`): rewritten to name the remaining gates, deleted when
  none are left or the PR is merged or closed, reposted after a new push
  only once In Review has landed. It never touches another phase's crumb.
  Change-monitor shows as soon as its sticky comment (or a check run named
  for it) is on the PR: `📡❔ Change review — running` joins that wake's
  update, or the head's latest one in place (`review-message/…/<sha>`) when
  it is the only news. Its state comes from structure, never prose: the
  `<!-- cursor:plan:… -->` marker is `📡✅ plan ready`; ⚠️ only from a check
  run's conclusion (no documented comment marker for it). Each state has its
  own claim (`changeMonitorClaimKey`), and each later one edits the 📡 line
  where it is (`review-change/…/<sha>`) with `chat.update`. Comment edits
  never wake the desk (July drops non-`created` `issue_comment`), so a wake
  that leaves it running re-reads on `REVIEW_RECHECK_MS` (TLSSN-37).
  It is still not in the waiting line or the crumb. A published plan's
  services ride on the line as `(services: …)` (`changeMonitorServices`:
  the marker's `services`, else the `Services:` line above `<details>`),
  minus `FACTORY_HOST_SERVICES`, the six deploy slugs and their `-staging`
  twins, which the deploy
  pipeline makes catalog services and Rollouts linked to marsbank changes
  (`Services: factory-desk`). None left, no field. Services never change a
  state or a claim; `review-update.test.ts` pins the list to the deploy
  guide's `--slug`s.
  `channels/github.test.ts` drives it through July's dispatch with GitHub
  stubbed at `fetch` and fails on any GitHub write.
- Four model tools in `agent/tools/`:
  - `file_ticket`: files the ticket already triaged. It takes the model's
    `kind` (bug, feedback, question), `severity`, `summary`, optional
    `nextStep` and `needsInfo`, and reads the thread's `intake-triage`
    record (`planFiling`): `by: "jev"` files Jev's templated verdict and
    Jira type and ignores the model's copy; `by: "model"` files the
    model's, judged with Jev's kept answers the way triage-jira's
    `record_triage` judges one (a Jev type above the bar goes on the
    ticket and sets the kind; severity above the bar applies). It creates
    an issue in the first configured Jira project
    (`FACTORY_DESK_JIRA_PROJECT`, else `FACTORY_JIRA_PROJECTS`) with that
    type (a type the project refuses is retried as `issueTypeFor(kind)`,
    Bug or Task, and the `Judge:` line says the Jira type did not take),
    and binds the Slack thread to the key in `host.kv` (`ticket/<KEY>`).
    The Jira summary is the model's `title` as written (zod max 80, the
    model's own words, never a host cut; Jira allows 255), not the filing
    prompt's first line, which can run to 400.
    After the model's description it quotes the request the stash holds
    (`intakeSourceText`, `withReporterRequest` in `intake-triage.ts`)
    under `Reporter's request, verbatim from Slack:`: Slack markup decoded,
    the leading mention and `Sent using` footer dropped, cut at 4000
    between words, skipped when the description already has it word for
    word (letters and digits compared; a cut quote's label counts). Only
    Cursor's trailing `Sent using` footer is dropped, never a reporter line
    that starts with those words. A pasted `Slack thread:` (marked up, or
    with an escaped `\:`) is quoted as `Slack thread (quoted):`, so the planner and `filedFromSlack` read
    only the host's trailer, and the quote is closed by
    `End of the reporter's request.` so a DM filing whose last quoted line
    ends in `"` still reads as desk-triaged in Automation's plainText
    (`../scripts/desk-triage.test.mjs` sends a hostile message through all
    three readers). The planner treats its explicit constraints as binding (TLSSN-42:
    the model's prose dropped "Keep the 60 limit" and the plan raised it).
    For a channel thread it appends `Slack thread: <permalink>`
    (`chat.getPermalink`, `agent/lib/slack-link.ts`) to the description,
    which the planner copies into the brief and the implement PR's second
    description line, and every description ends with `DESK_TRIAGED_LINE`
    (`agent/lib/desk-triaged.ts`, shared with triage-jira and the planner),
    which makes triage-jira's issue-created wake skip the ticket. After the
    binding it writes the `Triage:` comment triage-jira would write (the
    shared `triageComment`, `Type:` and `Judge:` lines included), ending
    with the same `DESK_TRIAGED_LINE` (`settleFiling`), so triage-jira and
    the planner can tell the desk's verdict from a later one, and moves the
    ticket To Do → Triaged (`transitionFrom`). That move is the planner's
    handoff, as from triage-jira, and the Jira channel announces Triaged
    once. The triage hop watch is armed only when the comment or the move
    did not land, so the thread hears it and gets `retry KEY`. The result
    carries `triage: { by, issueType, kind, severity, summary, fallback?,
    status }` and `reply`, the one Filed post (`filedMessage`, threads.ts)
    the turn relays verbatim: the key link once, the triage it was filed
    with and who made it, the next step. The `Triage:` comment ends with
    `Triaged by:` (shared `triageRecordLines`) then the scored `Judge:`
    line. `agent/tools/file_ticket.triage.test.ts` drives each path.
    The filer's `approve file` message gets ✅ once the issue exists. The gate is
    the text `approve file` (plain in the filing thread, or mentioned), not
    `needsApproval`. July (0.2.11 and later) does route Block Kit
    button clicks on hosted v2, but the factory deliberately uses ✅/❌
    reactions and typed commands only, with no buttons or cards, to keep
    the Slack UI simple; parked `needsApproval` calls also die on
    replace.
  - `approve_ticket`: `transitionFrom` Planned to `FACTORY_STATUS_APPROVED`
    (read first; Approved returns already, anything
    else `moved_on`; unreadable status is `status_unknown` with optional
    `detail`). The move reads the status again as its last call, so a
    replan that lands after the first read is `moved_on`, not a
    Triaged → Approved move on the old brief. The host `approve KEY`
    path makes the same guarded move. The status read asks `getJiraIssue` for `status` only.
    `factory-worker` wakes on that status and launches. No claim. Records
    `approved-in-slack/<KEY>` before the move and clears it if the move
    does not land, so the Approved webhook stays quiet for this approval.
    An approval (`transitioned` or already Approved) adds ✅ to the
    filer's `approve KEY` message; the result shape does not change.
  - `deny_ticket`: one `Denied in Slack by <by>` comment per plan
    (`agent/lib/plan-decline.ts`: a denial line after the latest `Plan:`
    comment, ids compared numerically, only the one-line shape
    `deniedComment` writes). A plan already declined returns
    `already_declined` (`The plan for KEY is already declined; nothing
    changed.`); unreadable comments return `comments_unread` and write
    nothing. Never transitions.
  - `request_plan`: a move to `FACTORY_STATUS_TRIAGED` for a
    plan and a replan alike. It reads the status first, moves a bound
    ticket only from To Do, Triaged, or Planned (else `moved_on`); a ticket already
    in Triaged is bounced to `FACTORY_STATUS_TODO` and back to Triaged
    (`reason: "bounced"`). Each move is `transitionFrom` the status the
    step before left (`agent/lib/plan-move.ts`), so an approve that lands
    mid-replan is `moved_on`, not pulled back. A failed move to To Do is reported and the
    second move is not tried. Before moving it reads the comments: a latest
    `Triage:` verdict the planner skips (question, needs info, duplicate)
    moves nothing and returns `reason: "triage_gate"` with `gate`,
    `nextStep`, and `duplicateOf`. It never comments.
- The two announces with the most shape, called by the Jira channel. They
  are host library functions in `agent/lib/announce.ts`, not tools:
  `agent/tools/` holds only the four model tools, and the model never sees
  an announce. Each goes through `announceTicketUpdate`
  (`agent/lib/ticket-thread.ts`), which claims
  `announced/<KEY>:<status>:<changelogId>` (unless the caller passes its
  own claim key) as a lease (`agent/lib/claim-lease.ts`) before it posts,
  and releases the claim if the post throws or finds nowhere to go:
  - `announcePlan`: a Block Kit plan post with a plain `text` fallback
    (`agent/lib/plan-post.ts`). It reads the latest `Plan: <KEY>` comment
    with its id (`readCommentRecords`), parses the planner's approval
    digest (`agent/lib/plan-comment.ts`: `Summary:`, `Approach:`,
    `Areas:`, `Test plan:`, `Risk:`, `Size:`, and the `Brief:`), and falls
    back to the body's own headings on older comments, or to the title
    and problem when no comment is readable. Links the ticket and the
    comment (`?focusedCommentId=<id>`), escapes `&`, `<`, `>`, and cuts
    oversized parts inside Slack's limits between words (`fitPlain` /
    `fitMrkdwn` over `word-cut.ts`, which the Filed post and Triaged line
    use too). The worker brief is not posted
    (it made the post a phone-screen wall with broken fences on TLSSN-27);
    the link line points to the `Plan:` comment as "Full plan and worker
    brief", lists stop at six items, and the evidence file list becomes a
    count. Always ends with a `*Next:*` line: reply `approve KEY`,
    `deny KEY`, `replan KEY`, bare where a bare reply reaches the desk (a
    DM or a channel in `agent/lib/desk-channels.ts` `WATCHED_CHANNELS`),
    else with `FACTORY_DESK_SLACK_HANDLE` (default `@factory`). Planned dumps
    claim once per plan, `announced/<KEY>:Planned:plan-<comment id>` for
    the `Plan:` comment the post carries (`planAnnounceKey`; the
    per-ticket `announced/<KEY>:Planned` only when no comment id is
    readable), so a redelivery or a Planned bounce on the same plan posts
    nothing and a replan's new `Plan:` comment posts again. They skip once
    the ticket's live status is past Planned; the intake root's status
    line, which never moves back, decides only when Jira cannot be read.
  - `announceProgress`: `KEY is In Progress. Implementation started: <url>`, with the
    URL from the latest `Implementing:` comment, then a `Next:` line: the
    factory (the worker, #152) opens the pull request once the agent pushes
    its branch, and its link follows. The In Review and Done lines
    (`threads.ts`) follow the same shape: status on the first line, who acts
    next on the second, and a plain "No pull request link is on the ticket"
    instead of claiming a pull request the desk cannot name. When the
    thread's newest message is the desk's own short `KEY is approved…` line
    (the model's approve reply or the board-drag Approved line) from the
    last fifteen minutes, In Progress edits that message instead of posting
    (`TicketUpdate.replaces`: `conversations.replies`, then `chat.update`);
    any doubt posts as usual.
  Both post into the thread at `ticket/<KEY>`, else
  `FACTORY_DESK_INTAKE_CHANNEL`, else nowhere.
- `agent/lib/jira.ts`: connector tools found by name shape, argument names
  from each tool's schema. `transitionIssue` has the same contract in every
  factory project that has a copy. `transitionFrom` moves only from a
  named status, reading it after the transitions list as the last call
  before the move (Jira has no conditional transition, so that one round
  trip is the window left); a ticket already in the target is `already`.
  Every reply is read from
  `structuredContent`, then from the text: Rovo gives Cursor an
  `issues.nodes` envelope in the first and the REST body in the second
  (`../docs/deployment-issues.md`, issue 14).
- `agent/lib/config.ts`: `factoryModel` and `jiraProjects` (re-exported
  from the shared `agent/lib/factory-model.ts` and `agent/lib/factory-env.ts`),
  `statusNames`, `reviewRepos` (`FACTORY_REPOS`, never throws),
  `deskSlackHandle`: `FACTORY_DESK_SLACK_HANDLE` when set, else the
  bot's own `auth.test` username once `agent/lib/self-identity.ts` has
  read it (one `auth.test` over the host client per process, started
  without waiting by `deskInbound` and the Jira channel), else `@factory`.
  The desk does not use July's `resolveSlackSelfIdentity`: since 0.2.12 it
  names the bot from its `users.info` profile (display name, then real
  name), so a profile like "Factory Desk" would move the handle.
  `self-identity.test.ts` pins that the profile never changes it, and
  characterizes July's resolver so a change there shows. The username is
  used only when it is one Slack username token and not `factory-desk`.
  `<slack_reply>` names that handle to the model, so host copy and the
  model's replies agree; July's `self_name` can differ, and the model
  never writes `@` plus `self_name`.
- Sender fields: July (0.2.11 and later) opens every Slack turn with `<slack_context>`
  carrying `user_tz`, `user_is_bot`, `user_bot_id`, `self_user_id`, and
  `self_name`. `instructions.md` "Who sent it" tells the model to take no
  command from a bot sender and to write clock times in `user_tz` (UTC
  when it is missing); `desk-commands.test.ts` pins that section.
- Tests in `agent/**/*.test.ts` (`npm test`). `agent/tools/writes.test.ts`
  pins the four tool files, holds every write to a `dryRunResult`, keeps
  every tool a declared write (July 0.2.12+ retries a read-effect tool on
  an error text with a bare 429/502/503/504 in it, a Jira key like
  `MARS-503` included), and forbids `needsApproval`. The shared `verify-webhook.ts`, `kv-verified.ts`,
  `claim-lease.ts`, `ops-funnel.ts`, `factory-otel.ts`,
  and `console-otel.ts` are tested here for every project that copies them.
- OTel (`agent/otel.ts`, `lib/factory-otel.ts`,
  `lib/console-otel.ts`, all shared by every host;
  `../docs/factory-deployment.md` section 11, `../docs/july-otel-upstream.md`):
  `agent/otel.ts` hands July a plain config (`factoryOtelConfig`: the slug as
  `service.name`, the namespace, stage and slug resource attributes plus one
  `service.instance.id` per process life, one OTLP exporter for traces, metrics
  and logs while `OTEL_EXPORTER_OTLP_HEADERS` is set), and July builds the
  tracer, meter and logger providers, registers them globally, and flushes
  them after each hosted delivery. Grafana Cloud rejects July's default DELTA
  metrics, so the resolver in `agent/otel.ts` defaults
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` to `cumulative` on each
  resolve (an operator's value wins). Factory spans, counters, and logs go
  through the global `@opentelemetry/api` (`trace.getTracer`,
  `metrics.getMeter`, `logs.getLogger`); no other code here may call
  `setGlobal*Provider` or construct a provider, sampler, exporter, or View. No
  rebase and no factory flush: July's flush after each hosted delivery covers
  all three providers.
  `../scripts/otel-version-parity.test.mjs` holds every host's
  `@opentelemetry/*` versions to one set, satisfying July's declared ranges,
  with exactly one copy of `@opentelemetry/api` in each lockfile: a second
  copy gets its own global registry, so a provider or active context one copy
  holds is invisible to the other.
- OTel rules: a factory span is a new root linked to the inbound span, never a
  child of July's (an unsampled parent would drop it). A new entry point
  (channel route, Slack or GitHub hook, reminder, schedule) goes through
  `traced` / `tracedGithubHook`; work handed to `waitUntil` goes through
  `traceFactory` with `factory.background`. Factory span notes and
  `error.message` leave as set. Logs and traces are exported unaltered. A
  console line's level is its method's, except Node's process-warning print,
  which `console-otel.ts` exports once at WARN (documented exceptions in
  `../docs/factory-deployment.md`). The ticket key goes on July's spans and
  metrics only through `tagSessionTicket`. User prompts and tool content are
  on in the config; Grafana access is the only control.
- OTel tests: `factory-otel.test.ts` (config, spans, notes),
  `factory-otel.ticket.test.ts` (ticket label, merged counter),
  `console-otel.test.ts` (console bridge, Node warnings, diag guard), and
  `july-otel.test.ts` (July's real runtime exporting through `agent/otel.ts`
  to a local collector: cumulative metrics, the instance id, July's own flush;
  it fails when a July upgrade changes a behaviour the design relies on, and
  says what to do).
- A kv failure the code ignores goes through `warnKv(site, error)`
  (`agent/lib/ops-funnel.ts`), never a silent `.catch(…)`, `.then(ok,
  …)`, dropped `Promise.allSettled`, or empty `catch`:
  `../scripts/kv-swallow-scan.test.mjs` fails on one in any agent. A
  best-effort Slack or Jira step gets its own catch with `warnStep`,
  so a `kv` warning is always kv.
  `kv-verified.ts` retries a kv call only when `isRetryable` (429, 5xx, no
  status) holds, after `KV_RETRY_PAUSES_MS` (100, then 400 ms, jittered to
  half..all); another 4xx or a hosted reason code
  (`KV_PERMANENT_REASON_CODES`, pinned to July's list) or a July local
  refusal (`KV_LOCAL_REFUSALS`: an empty key, no deployment credential)
  returns `unavailable` at once with a `{"kv":"retry_stopped",…}` line, and
  nothing throws, even when a hook or the env misbehaves. A loop that
  already retries owns the pauses: claim-lease's `settle` (any `pausesMs`,
  as in the desk's `BINDING_RETRY_MS` binding backoff, 3.85 s) runs
  kv-verified's retries with `pausesMs: []`.
  Attempts, pauses, env, random, sleep, and warn go in one options object,
  so tests never sleep. `FACTORY_KV_RETRY_PAUSES_MS` (read per call; sum at
  most `KV_RETRY_PAUSE_BUDGET_MS`, 500; empty or `off`: no pauses) is the
  kill switch.
- `evals/` is filesystem evals (`evals/evals.config.ts` required).
  Not `agent/evals/`. That path is ignored.
- No `agent/subagents/` and no `agent/mcp-connections/`. `agent/extensions/`
  holds only `jev.ts` (`agent/discovery.test.ts` pins it, its hosting
  contribution, and the four tools). No `agent/skills/`: the turn has no
  tool to load one, so the rubric is inlined (`agent/lib/triage-rubric.ts`,
  pinned to triage-jira's skill by `../scripts/desk-triage.test.mjs`).
  `slack-communication` is left out on purpose: its tools pair with
  `reply: { mode: "agentic" }`, this channel posts the reply, and it
  would put `slack__post-card` in front of the model.

## Do not

- Launch anything. No `cursor-cloud-agents` extension, no `@cursor/sdk`
  `Agent.create`, no `cloud__launch`. `factory-worker` owns the launch.
- Hold a sandbox repository. `FACTORY_SANDBOX_REPO` and
  `FACTORY_SANDBOX_REF` belong to `factory-worker`.
- Add tools beyond the four model tools, or turn an announce into a tool.
  No GitHub tool or connection: the drive opt-in is a human-typed comment.
- Make a hop watch retry, move, or launch on its own. It announces;
  `retry KEY` from the filer is the only redelivery. The one exception,
  approved for TLSSN-60: the plan start check's single automatic re-send
  of a Triaged ticket whose planner never reported starting (never a
  second, never a launch, never past Triaged).
- Raise the GitHub channel above `permissions: "read"`, write to GitHub from
  it, or start a session from it. It reads a PR and posts to Slack, nothing else.
- Add cards or `needsApproval`. Parked approvals die on replace. The gates
  are the texts `approve file` / `approve` / `approve KEY`, plain in a
  factory thread or mentioned anywhere, and a ✅ / ❌ reaction on the
  filing prompt or plan post (`agent/lib/reaction-approval.ts`).
- Read or write a brief. The planner owns it; the worker reads it.
- Grow host TypeScript for formatting, classification, or reply composition.
  That stays in instructions. Host code owns auth and side-effect gates.
  The one exception is the shared Jev judge: Jev answers the bounded
  labels and host code holds the threshold rule. Do not add a classifier
  prompt of its own.
- Add npm deps. Stick to what `@cursor/july` already ships. The declared
  `@opentelemetry/*` packages (API, metrics SDK and its OTLP proto
  exporter, resources, core; the trace and log SDK packages are
  devDependencies for tests) are July's own, pinned to the versions it
  installs.
- Run `slack create` here without meaning to own the factory's one Slack app.

## Pointers

- Package loop: `node_modules/@cursor/july/AGENTS.md`
- Skills: `node_modules/@cursor/july/skills/` (`create-agent`, `deploy`, `evals`, `hillclimb`, `debug`)
- Docs: `npx -p @cursor/july@0.2.25 agent-sdk docs`
- LLM docs index: `node_modules/@cursor/july/dist/docs/llms.txt`

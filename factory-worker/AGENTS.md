# factory-worker

Cursor Agent SDK project (`@cursor/july`). This file is for coding agents
editing the project. The served agent's prompt is `agent/instructions.md`.
Design and the factory it belongs to: `../docs/event-driven-factory.md`
(the `factory-worker` section is the spec).

## Loop

```bash
npx -p @cursor/july@0.2.24 agent-sdk validate --dir .
npx -p @cursor/july@0.2.24 agent-sdk info --dir . --json
npx -p @cursor/july@0.2.24 agent-sdk serve --dir . --mode single --dev
node ../scripts/replay-jira-transition.mjs http://127.0.0.1:3000/v1/channels/jira/ TLSSN-42 Approved
npm run check && npm test
```

Run the CLI under Node, never Bun. There are no eval cases: the worker has
no chat surface, and its behavior is host code covered by `npm test`. The
one model turn it runs is the implement agent itself, as a July cloud turn
(below); an eval of that would push a branch on the sandbox.

## The implement agent is a July cloud turn

A verified Approved delivery no longer calls `Agent.create`. The jira
channel's handler calls the channel's `send()` once
(`agent/lib/implement-turn.ts` `startImplementTurn`), with
`continuationToken` `implement:<KEY>#<changelogId>`, `title` the agent
name, `state` the approval plus the pending claim's `at` and `owner`, and
a per-send
`cloud: { repos: [{ url: FACTORY_SANDBOX_REPO, startingRef }], autoCreatePR: false }`.
No `modelConfig`: July 0.2.18 accepts it on a dry-run send only
(`dist/internal/model-config.js` `modelConfigForDryRun`, called from
`session-engine.js` `send`; it throws `invalid argument: modelConfig
requires dryRun` otherwise, and in hosted execution, after admission has
answered, so no session exists for `turn.failed`;
`../docs/deployment-issues.md` issue 27). The turn runs `agent.ts`'s
`model` (`session-engine.js` `turnModel`), which is therefore
`IMPLEMENT_MODEL` (`lib/config.ts`, read once at load), the constant the
heal's `Agent.create` also sends. `implement-turn.test.ts` runs the send
options through `modelConfigForDryRun` and pins `agent.model` to
`IMPLEMENT_MODEL`; `FACTORY_WORKER_*` are not hosted secrets (hosted v2
binds secrets after load).
July creates the cloud agent with the pod's `CURSOR_API_KEY`, the identity
the SDK launch used, and the session is the attribution unit: its
`cursor.token.usage`, `agent_sdk.turn.count` and
turn spans carry `factory.ticket.key` (`agent/hooks/ticket-key.ts` reads the
key out of the continuation token on `turn.started`; any other session is
`none`). Why it is shaped this way, each checked in `@cursor/july@0.2.24`
`dist/`:

- Hosted admission honors one `send()` per delivery (`hosted-delivery.js`
  `runAdmission`, `pendingSend`) and starts it after the reply, so the
  handler stamps the claim `sentAt` (`claim.ts` `markLaunchSent`), sends,
  and returns `turn_sent`. The agent id arrives later on the session's
  `agent.bound` event (`channels/jira.ts` `events`), possibly in another
  process; `createLaunchPipeline(...).bound` then writes the agent to
  `implement-agent/<KEY>` (`claim.ts` `noteBoundAgent`, before anything
  that can fail) and does what a returned create did: record (only while
  the claim still names the state's `owner`), post `Implementing:`, move
  to In Progress, arm the PR watch. July's cloud create passes no agent
  name, so that record is the only way a takeover finds the agent:
  `existingAgent` and the heal read it before `findLaunchedAgent` lists,
  and adopt it without a relaunch when `Agent.get` does not report it in
  `error` or `cancelled` (a dead agent's record is dropped and the listing
  asked; an unreadable status is `agent_unverified`, no launch). The
  record is deleted when its agent is done with: `launchFailed`
  (`clearBoundAgent`, only a record naming its own agent or written for
  its own approval: `BoundAgentOwner`) and an orphan retire, so a retry
  whose binding is lost too does not adopt the agent that just failed,
  while a live agent another launch bound is never erased by this one's
  failure. The other order of the `kept` race (a binding landing between
  a takeover's look and its own record) is closed in `finish`: once the
  takeover's launch is recorded, a record naming another agent bound
  since the takeover is retired (`retireLateBound`). The takeover window
  rides in the session state (`takenOverAt`), so the cloud-turn path has
  it too. A takeover's `bound` records the claim first and writes its own
  record after (`finish`; `orphaned` when kept, which then reads the
  claim again), so the late agent's record is never written over before
  `retireLateBound` reads it; with each side writing before it reads,
  a late binding is caught by one side or the other (a kv without
  compare-and-swap allows no tighter guarantee). `turnFailed` adopts a
  live late-bound agent instead of calling the takeover a failed launch
  (`turn_failed_late_bound`). A `turn.failed` before that binding is
  the launch failing (`createLaunchPipeline(...).turnFailed`): release the
  claim, one `Launch failed: <reason>` line (`cancelled` for a cancelled
  turn), but only after `Agent.get` (`deps.agentStatus`) on the session's
  agent or the record says the agent is in `error` or `cancelled`, or
  there is none. A `running` or `finished` agent is left alone, claim and
  all (`turn_failed_agent_alive`), as is one whose status cannot be read
  (`turn_failed_status_unknown`): the pod's `CURSOR_API_KEY` is a
  60-minute token, so a build past an hour fails its turn mid-stream with
  the agent still running, and the heal adopts it. After the binding it is
  the agent stopping on its own, and the PR watch reports it.
- A pending claim with `sentAt` is lost only after `LAUNCH_SENT_GRACE_MS`
  (11.5 min, derived: `HOSTED_PENDING_SEND_TTL_MS`, hosted admission's
  ten-minute `pendingSend` hold, plus `LAUNCH_TIMEOUT_MS` plus
  `LAUNCH_LATE_WAIT_MS`) rather than `LAUNCH_GRACE_MS`, so the launch heal
  does not retake a ticket whose binding is still coming. The heal itself
  (`via: "heal"`) still launches through `Agent.create`: a reminder run has
  no channel `send`.
- The `cloud` block rides on the send, not on `agent.ts`:
  `FACTORY_SANDBOX_REPO` is a hosted secret bound per request, and a cloud
  send with no repos lands on a team "no-repo" environment the deploying
  identity may be refused (`You do not have permission to start this
  environment`). `agent.ts` keeps `cloud: { autoCreatePR: false }`, which
  the per-send `repos` merges over (`cloud-merge.js`).
- July refuses any non-local turn of an agent that declares `tools`
  (`session-engine.js` `buildTurnRequest`; `tools: []` still sets `allowedTools`), so
  `agent.ts` declares none. `tools: []` was also what closed the built-in
  HTTP session API's per-session `cloud` override; `agent/channels/http.ts`
  `gateHttpSession` takes its place, refusing principal-bearing
  `/v1/session*` sends whenever `AGENT_SERVE_GENERATION` is set (hosted
  control-plane admissions arrive with `auth: null` and pass, so a direct
  chat on the hosted playground still answers per `instructions.md`).
- `agent/instructions.md` travels inline as the cloud turn's AGENTS.md
  preamble, so it carries the implement agent's standing orders
  (`## Handing off the change`: push a key-prefixed branch, open no PR)
  as well as the no-chat-role answer.
- A second send with the same continuation token would resume the first
  session's agent, so the token names the approval: a person's next move
  to Approved is a new changelog id and a fresh agent; a replay of one
  delivery meets its own claim as in flight (`claim.ts`) and never sends.

`@cursor/sdk` stays for the heal's launch, `findLaunchedAgent`
(`Agent.list`), `sdkRetireAgent`, and `implement-pr.ts`'s run reading
(`Agent.listRuns`).

## Layout

- `agent/agent.ts`: `IMPLEMENT_MODEL` (the implement model, read once at
  load; `FACTORY_WORKER_*` on a local `serve` only: `claude-opus-5-5`, context 300k, effort high,
  fast=false), `factoryFallbacks(model)` (grok-4.6 fast, then Auto
  balanced), no `tools`, `cloud: { autoCreatePR: false }`,
  `local.sandbox`. The implement cloud turn runs this model (above); a
  person who reaches the agent directly gets the same one. The worker
  reads no `FACTORY_AGENT_*`; `factoryModel` is re-exported from the
  shared `factory-model.ts` only for the parity tests.
- `agent/instructions.md`: the no-chat-role answer, and the implement
  agent's standing orders for the cloud turn.
- `agent/channels/jira.ts`: `POST /v1/channels/jira/`. `hostHandlerDeps`
  wires real deps (`host.kv`, `host.mcp`, `Agent.create`, `process.env`,
  `host.github`, `Agent.listRuns`, `host.reminders`) into `createHandler`,
  and the route adds the channel's `send`. Its `events` finish a launch
  from `agent.bound` and fail one from `turn.failed` through
  `createLaunchPipeline`.
- `agent/channels/http.ts`: the HTTP session gate (above).
- `agent/hooks/ticket-key.ts`: `turn.started` → `tagSessionTicket` with
  the continuation token's key (above).
- `agent/lib/implement-turn.ts`: `implementContinuation`,
  `implementIssueKey`, `ImplementSessionState` / `parseImplementState`,
  `implementSendOptions`, `startImplementTurn` (one
  `factory.cloud_agent.launch` span, `sent` or the failure reason; a
  staging slug refuses the production repository here too),
  `MANAGED_HOSTING_ENV`.
- `agent/reminders/implement_pr.ts`: the named reminder a launch arms. Each
  fire is `fireImplementPrWatch` (`agent/lib/implement-pr.ts`), host code
  only, never `followup`.
- `agent/reminders/implement_launch.ts`: the launch watch's reminder, armed
  before the launch. Each fire is `healLaunch` (`agent/lib/launch-heal.ts`),
  then the backstop sweep; host code only.
- `agent/channels/github.ts`: `githubChannel({ cursorAccount })` on
  `FACTORY_SANDBOX_REPO` at `permissions: "pr-write"`, `webhookEvents:
  ["pull_request"]`, `deliverReplies: false`, no reactions, `onComment`
  returns `null`. `onPullRequest` is `prStatusDispatch`: `{ task }` or
  `null`, never a turn. Deploy needs `--cursor-events-repo`.
- `agent/host-connections/tracker.ts`: host-only Cursor account Jira,
  byte-identical in the desk and the planner
  (`../scripts/copies-parity.test.mjs`). The jira channel reads the ticket's
  comments, posts `Implementing:`, and moves the ticket through
  `ctx.host.mcp`. There is no model turn and no model-visible Jira tool.
  Unsigned or unconnected, the channel answers `comments_unreadable` and
  launches nothing.
- `agent/lib/handle.ts`: the hot path in the design's order. Verify, decide,
  read the brief, open the launch watch, claim, arm the watch's reminder,
  then in `waitUntil`: launch, record, comment
  `Implementing: <url>`, and transition to In Progress only if that comment
  landed. On a delivery with a channel `send` the launch is `dispatchTurn`
  (stamp `sentAt`, send the cloud turn, `turn_sent`) and the record,
  comment, and move run from the pipeline's `bound`; the heal, with no
  `send`, launches through `Agent.create` as before. A later approval that finds `commented: false` posts the comment
  and then transitions; any later approval then moves Approved → In
  Progress if the ticket is in Approved, even after a recorded move, so a
  launched ticket that drifted back and was approved again does not sit in
  Approved. It never launches again. One JSON log line per delivery
  (`{"worker":"decision",...}`). `createLaunchPipeline` is that path after
  the webhook (`approve`, `via: "delivery" | "heal"`), shared with the heal.
  Hosted admission never redelivers a handler 5xx or a rejected
  `waitUntil`, so every verified Approved delivery that launches nothing
  leaves one Jira line per changelog id: `Launch failed:` (a failure; the
  desk announces it), `Launch pending:` (the watch will relaunch), or
  `Launch skipped:` (already launched, or the ticket left Approved), deduped
  in `implement-note/` or `implement-failed/`. A transient Jira or kv
  failure (`comments_unreadable`, `status_unreadable`, `claim_unavailable`)
  answers 202 once the watch, or an orphan reminder carrying the approval
  (`armOrphanLaunchWatch`), is scheduled; 503 only when neither could be.
  An unusable connector and every `claim_unavailable` go to ops Slack
  through `warnOps`. A launch arms the implement PR watch; a
  later Approved delivery for a launched ticket (the desk's `retry KEY`)
  runs `ensureImplementPr` in `waitUntil` after that move, and arms the
  watch if the agent is still working.
- `agent/lib/implement-pr.ts`: the worker opens the implement PR, not the
  agent (TLSSN-35: the agent's PR tool refused the `Slack:` line and no PR
  opened). `ensureImplementPr` needs a `launched` `implement/<KEY>`, reads
  the agent's newest run (`sdkRunReader` over `Agent.listRuns`: status,
  branch on the sandbox, final message; a run that ended with no branch
  falls back to the one sandbox branch starting with exactly the key),
  then GitHub through `host.github`: an open PR from the branch is reused
  and checked by `markReadyForReview` in `retry` mode (a person's draft
  stays), a closed one is `pr_closed` and left alone, none gets
  `POST /pulls` with `draft: false`, base `sandboxRef` (the launch's
  `startingRef` and the base `decidePullRequest` requires; keep them one
  value), `implementPrTitle`, and
  `implementPrBody` (`Jira:`, `Slack:`, final message, agent link; the
  header `withTicketLinks` reads as present). A 422 reuses the PR the agent
  raced in. Then `advanceTicket` for `in_review`, same claim as the
  `opened` delivery. Never throws. `armImplementPrWatch` /
  `fireImplementPrWatch`: `implement-pr-watch/<KEY>` (`armedAt`, `dueAt`,
  `reminderId`), written and listed in `implement-pr-watch/index` before
  the reminder is created, first fire 10 min, then every 5 min while the
  outcome can change, for up to 8 h. A fire from a reminder the record does
  not name is `superseded`. An arm re-arms a watch with no reminder, or one
  `IMPLEMENT_PR_GRACE_MS` past due, and answers `already` only for a
  recorded, on-time one. The watch is the worker's session-stopped handler: `latestRunFacts` reads
  `finished`, `error`, `expired` (as `error`), and `cancelled` as stopped,
  and a stopped run with nothing pushed ends it (`no_branch`). It is why
  the deploy warning `missing_agent_session_stopped_event_subscription` is
  expected: 0.2.18 (like 0.2.13 and 0.2.14) has no agent-session channel, so do not hand-roll one
  with a guessed event type.
- `agent/lib/implement-pr-sweep.ts`: the backstop, the worker's side of the
  desk's hop-watch `backstopSweep`. `backstopImplementPrSweep` runs from
  the Jira route (`HandlerDeps.backstop`, in `waitUntil` after
  verification), every `pull_request` task (`withImplementPrBackstop`),
  and each implement PR reminder fire, at most once per 5 min
  (`implement-pr-watch/last-sweep`), capped at 20 s, never throws.
  `sweepImplementPrWatches` fires lost watches through
  `fireImplementPrWatch`, re-arms pending ones, and prunes the index. It
  never opens a PR any other way. Index writes are the shared
  `agent/lib/kv-index.ts` verified merge (the desk's copy, tested there),
  behind one in-process queue that only orders this pod's writes: an arm's
  add is a union onto the stored list (`updateVerified`, 2 attempts), its
  second `addToIndex` after the reminder create (even a failed one) is the
  confirm (1 attempt), an arm that finds a live watch (`already`) and every
  pending fire add it again (self-heal, 3 attempts), and
  `pruneImplementPrIndex` removes only keys the sweep re-read as gone, from
  the list as stored at the write, then re-reads each one's record and
  re-adds any that is back (a re-arm whose add found the key still listed
  wrote nothing). The residual: a put that lands after an
  arm's confirm drops the key until that ticket's next arm or pending fire.
  `FACTORY_INDEX_MERGE=off` restores the plain read-then-put add and prune,
  with no self-heal on `already`. `implement-pr.index.test.ts` races two
  module instances (two pods), the prune, and the frozen
  `testing/legacy/implement-pr-index.ts`.
- `agent/lib/launch-watch.ts` and `agent/lib/launch-heal.ts`: the launch
  watch (TLSSN-51). `implement-launch/<KEY>` (`at`, `changelogId`, `title`,
  `attempts`, `reminderId`, `dueAt`, `last`, `detail`) and `implement-launch/index`
  (kv-index merge), opened before the claim and on `comments_unreadable`,
  closed (and its reminder cancelled) once the launch is recorded,
  commented, and moved, or on a failure comment, no plan, or a ticket that
  left Approved. After `LAUNCH_GRACE_MS` the watch's own `implement_launch`
  reminder heals it, once per run, by replaying the approval through the
  pipeline:
  - The ticket must still be Approved.
  - A pending claim past the grace is retaken, adopting any agent the lost
    launch started.
  - A launched claim is only repaired.
  - After 3 attempts, one `Launch failed:`. After an `agent_unverified`
    give-up, the pending claim is also cleared (`abandonPendingClaim`, only
    the exact value read and past its grace) so a person's re-drag launches.
  - An expired watch is closed: by its reminder run, or by the tend when
    it never had a reminder (conditional on the record read).

  `backstopImplementPrSweep` never heals: with `createAgent` it runs
  `tendLaunchWatches` after the PR sweep, which arms a missing reminder, or
  replaces one more than 10 minutes past its recorded `dueAt` (at most
  three per run, recorded by `replaceLaunchReminder`'s verified conditional
  update), and prunes gone keys. Each heal fire records its reschedule's
  `dueAt` (`noteReminderDue`).
- `agent/lib/decide.ts`: pure. `decideApproved` (a `stale_status` refusal
  carries the key, changelog id, title, and the body's status snapshot; the
  handler then asks Jira through the pipeline's `snapshot` path and launches
  if the ticket is Approved there), the claim key, the comment
  texts, `latestPlanComment`, `extractBrief`.
- `agent/lib/claim.ts`: `implement/<KEY>`, `pending` until the launch
  returns, then `launched` with the agent id, URL, `commented`, and `moved`
  (absent in older records, read as false). A `pending` claim older than
  `LAUNCH_GRACE_MS` (3 min; `STALE_PENDING_MS`, 10 min, in legacy mode and
  for `pr-status/` claims) is taken over and launched again; whether the
  `idempotencyKey` prevents a second agent then is unchecked. A pending
  claim stamped `sentAt` (`markLaunchSent`: the delivery handed the launch
  to July as a cloud turn and awaits `agent.bound`) is lost only after
  `LAUNCH_SENT_GRACE_MS` (11.5 min, derived above). A confirm
  read that finds the key empty is `unconfirmed`: no launch, and the
  launch watch retakes the put after the grace. A stored value that is
  neither shape, or a pending with an unreadable `at`, is stale (legacy mode
  keeps the frozen in-flight reading). A younger
  one is in flight, except this delivery's own: the pending claim records
  the `x-agent-sdk-delivery-id` header (`DELIVERY_ID_HEADER` in
  `handle.ts`), and a replay of the same delivery takes it over at any
  age, the planner's rule. Residual: a replay while that delivery's first
  launch is still running calls `Agent.create` again under the same
  `idempotencyKey`, the only (unverified) guard; `handle.test.ts` pins it.
  A threshold on the pending claim's age would bring back the drop the
  rule removes. A `launched` claim is never retaken. Hosted `host.kv`
  (July 0.2.13) has get, put, and delete only, so `implement/<KEY>` and
  `pr-status/…` are the shared `agent/lib/verified-claim.ts` claim
  (byte-identical in the planner, tested here in `verified-claim.test.ts`;
  `kv-verified.ts` is the desk's copy): read and classify, put
  `{ ...pending, owner }` with a fresh owner per delivery through
  `updateVerified`, wait `FACTORY_CLAIM_SETTLE_MS` (default 2000, 0 skips
  it, above 10000 keeps the default), read again, and act only while the
  key still holds this owner's claim. Any other value found on that read
  goes through the site's `classify` with stale read as in flight, so the
  confirm step never retakes, and an ownerless pending from older code is
  in flight. Every release is owner-checked (`deleteVerified`): after a
  launch that threw, after a move that did not land, and before the 503 or
  retryable throw when the claim was `unavailable`. Residual: a put that
  lands later than the settle, or an old-code put during a deploy, can
  still launch or move twice; the `idempotencyKey` and `transitionFrom`
  are the guards behind it. `FACTORY_CLAIM_MODE=legacy` restores the plain
  read-then-put and main's log output (no claim lines, `claimReleased:
  true`). Otherwise every claim and release logs
  `{"host":"worker","claim":…,"key":…,"mode":…}` through the handler's
  log. The `supportsKvCas` / `putIfAbsent` / `putIfVersion` branches never
  run in production; only the "CAS path (ask 11)" test suites reach them.
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
  `claim.race.test.ts` races both claims against themselves and against
  the frozen `agent/lib/testing/legacy/claim.ts`. Test fakes (`memoryKv`
  in `agent/lib/testing/fakes.ts`) default to no compare-and-set, like
  hosted, and their `ENV` sets a 1 ms settle. The `pr-status-note/` and
  `pr-ready-note/` claims stay a plain read then put with no owner and no
  settle; the worst race is one repeated note.
- `agent/lib/pr-decide.ts`: pure. `decidePullRequest` (sandbox repo and
  ref, key from the head branch or a `cursor[bot]` title, open actions →
  `in_review`, a merge by a person with no `auto_merge` → `done` with
  `mergedBy` from `humanMerger`: `merged_by` when that actor is a person,
  else the sender), `isHuman`, `implementPrKey`, `prStatusClaimKey`,
  `prStatusNote` (the `not set from` comment), `rawPullRequestFacts`,
  `mergedByComment` (`Merged by: <login>`).
- `agent/lib/factory-pr-key.ts`: the factory PR key rule (`factoryPrKey`,
  `issueKeyAtStart`, `CURSOR_BOT`), byte-identical in the desk, the fixer,
  and the security reviewer (`../scripts/copies-parity.test.mjs`) and
  tested here. `implementPrKey` is `factoryPrKey`.
- The desk announces the worker's three non-move comments (`Launch
  failed:`, `noBriefComment`, `prStatusNote`) into the ticket's thread by
  their first lines. `../scripts/outcome-sentinels.test.mjs` pins them to
  the desk's parser; change the text and that test together.
- `agent/lib/pr-status.ts`: `prStatusDispatch` and `advanceTicket`. Needs
  a `launched` `implement/<KEY>`, claims `pr-status/<KEY>/<stage>/<repo>#<n>`
  (`claim.ts`: `moved` is sticky, anything else releases), then leaves
  `Pull request: <url>` (`pullRequestComment`) on the ticket unless it is
  already there, best effort, so the desk can link the PR in its In Review
  and Done lines, then one guarded
  move: In Progress → In Review on open; on a person's merge, In Review →
  Done, or through In Review from In Progress or any factory status the
  ticket drifted back to (Approved, Planned, Triaged, To Do; logged as
  `resyncedFrom`). A status outside the seven factory statuses stays put.
  On a merge, `Merged by: <login>` (`mergedByComment`, unless that line is
  already there) is written only once the ticket is at In Review (read
  there, or after the catch-up move landed) or already Done, and before
  the Done move, since the desk reads it when Done arrives; a merge that
  stops short of Done names no merger (logged `merged: "skipped"`). A
  skipped move (another status, no transition, a failed write) leaves one
  Jira comment, `<In Review|Done> not set from <repo>#<n>: …`, claimed in
  kv per stage, PR, and outcome, with no raw error text. Hosted v2 has no
  readable logs, so that comment is the evidence. A failed write, or on
  Done an unreadable status, also throws so hosted admission retries.
- `agent/lib/pr-links.ts`: pure, no imports. `briefLinks` reads `Ticket:`
  and `Slack thread:` from the brief's opening block (Slack archive
  permalinks and this key's browse URL only); `withTicketLinks` returns the
  description with `Jira:` then `Slack:` first, or undefined when it already
  opens that way or there is no Slack permalink.
  `../scripts/pr-description-links.test.mjs` holds it to the planner's
  `implementationBrief`.
- `agent/lib/pr-body.ts`: `linkablePullRequest` (`opened`, `reopened`,
  `ready_for_review`, `edited` on a sandbox implement PR) and
  `linkTicketInBody`: needs a `launched` `implement/<KEY>`, reads the brief
  from the latest `Plan:` comment, GETs the PR, and PATCHes the body only
  when `withTicketLinks` changes it. Never throws; `prStatusDispatch` runs
  it before the move and logs `{"worker":"pr_body",...}`. Tests without
  `deps.github` skip it.
- `agent/lib/pr-ready.ts`: every factory PR is ready for review on open
  (Bugbot skips drafts). The belt-and-suspenders path: the worker already
  opens it ready (`implement-pr.ts`).
  `readyablePullRequest` (`opened`, `reopened` check; `synchronize`, `edited`
  retry until `pr-ready/<repo>#<n>` is recorded, or again when the body
  still says `draft: true`; `ready_for_review` and a person's
  `converted_to_draft` only record; a bot's `converted_to_draft` checks
  again, since marsbank#29's implement agent left its PR a draft) and `markReadyForReview`: needs
  a `launched` `implement/<KEY>`, GETs the PR through `getOctokit()`, and
  runs GraphQL `markPullRequestReadyForReview` only on a draft, with
  `x-cursor-github-repos` set by hand (hosted github-proxy 400s an unscoped
  `/graphql`; marsbank#28). Three tries in the task. Never throws;
  `prStatusDispatch` runs it first and logs `{"worker":"pr_ready",...}`. A PR
  left draft gets one `Ready for review not marked on` Jira comment
  (`noteNotReady`) and the task throws after the move so hosted admission
  redelivers it.
- `agent/lib/launch.ts`: the heal's launch, and the prompt, agent name,
  URL shape and failure-reason mapping the cloud turn shares
  (`implementPrompt`, `agentName`, `agentUrl`, `launchFailureReason`,
  `LaunchNotStartedError`). `Agent.create` with `idempotencyKey` = the claim
  key and `autoCreatePR: false` (platform auto-PRs are drafts), then the
  first `send(brief + prHandoff)`, which is the `POST /v1/agents`. Both
  share `LAUNCH_TIMEOUT_MS` (30 s). Past it `LaunchTimeoutError` carries
  the still-running create (`late`); the handler keeps its claim, awaits
  `LAUNCH_LATE_WAIT_MS` more, and records a late answer. A late agent
  handle is closed. `findLaunchedAgent` (`Agent.list`, names `factory
  <KEY>: …`) is the positive check before any takeover creates an agent:
  "none" only when the listing reached past the lost launch's start.
  `claim.ts` `recordLaunch` records only while the run holds the claim.
  `prHandoff` tells the agent to push a key-prefixed branch, not to open a
  PR (the planner's brief still says "one pull request"), and that its
  final message is the PR description.
- `agent/lib/jira.ts`: comments and transitions, tools found by name shape.
  Connector discovery retries a throw or an empty listing
  (`TRACKER_RETRY_MS`, `FACTORY_TRACKER_RETRY_MS`). After an empty listing
  it calls `TRACKER_PROBE_TOOL`, an unknown name that makes July's account
  bridge re-list past its 60 s empty-catalog cache and name unhealthy
  servers. It keeps why for `trackerUnusable`, and reuses a failed
  discovery for 15 s.
- `agent/lib/config.ts`: every `FACTORY_*` read, the cloud agent's
  `workerModel`, the status names, and re-exports of the shared
  `factory-model.ts` (the host model, byte-identical in all six projects),
  `factory-env.ts` (`jiraProjects`), `factory-repos.ts` (`factoryRepos`),
  `factory-sandbox.ts` (`FACTORY_SANDBOX_*`), and `verified-claim.ts`
  (`claimSettleMs`, `claimMode`: `FACTORY_CLAIM_SETTLE_MS`,
  `FACTORY_CLAIM_MODE`, read per request).
- `agent/lib/fixtures.ts`: `approvedBody()`, the canonical Jira body. The
  replay script builds the same literal; `replay.test.ts` holds them equal.
- `agent/lib/testing/`: the fake kv, tracker, launcher, GitHub, and
  reminders. Import-only. `implement-pr-watch.test.ts` drives the watch on
  a simulated clock through a reduced July reminder runner.
  `agent/lib/testing/legacy/` keeps frozen copies of the claims and the
  index write as they were before the kv claim changes, so race tests can
  pit old code (still live on a slug mid-deploy) against new; never edit
  them to follow the live files. `agent/lib/kv-race.fixtures.ts`
  (`racingStores`) and `agent/lib/kv-backends.fixtures.ts` are
  byte-identical copies of the desk's, tested there.
- `evals/evals.config.ts`: required by the CLI. No cases.

## Do not

- Add a model turn or a tool to the decision, the claim, or the PR path.
  Code owns the decision, the claim, the launch, and the status moves. The
  one `send` is the implement cloud turn itself (`dispatchTurn`), and it
  carries the per-send `cloud.repos`; never a send without them, and never
  a second send under an implement continuation token (it would resume
  the first agent).
- Declare `tools` on `agent.ts`, even `[]`: July then refuses the cloud
  turn. The HTTP session API is gated in `channels/http.ts` instead.
- Put the `cloud.repos` attach on `agent.ts`: `FACTORY_SANDBOX_REPO` is a
  hosted secret, bound per request, not at load.
- Merge, enable auto-merge, or write to GitHub beyond opening the implement
  PR from the agent's branch (`agent/lib/implement-pr.ts`), marking it
  ready for review (`agent/lib/pr-ready.ts`), and its description's
  leading `Jira:` / `Slack:` lines (`agent/lib/pr-body.ts`). Never open a
  factory PR as, or leave it, a draft: Bugbot does not run on drafts.
  Never reopen or re-create a PR for a branch whose PR was closed.
- Ask the implement agent to open its PR. One creator: the worker.
- Reach GitHub any way but the channel's Cursor account credential
  (`ctx.github`, or `host.github`, which serve wires to it). No token
  secret, no new egress domain.
  No comments, reviews, reactions, or pushes. The GitHub channel moves the
  ticket to Done only on a person's merge.
- Move a ticket to In Review from any status but In Progress on an open or
  push: a replan after launch must not be pulled back by the next commit.
- Move a ticket to Done except through In Review on a person's merge, or
  from a status outside the factory's seven (a custom "Won't Do").
- Release `implement/<KEY>` after a launch returned. A later approval
  that finds the `launched` claim re-posts the recorded URL and does not
  launch again.
- Change the idempotency key away from the claim key. The two are one
  string so a reader can join them.
- Launch into any repository but `FACTORY_SANDBOX_REPO`.
- Reach Jira any way but `host-connections/tracker.ts`. No `*.atlassian.net`.
- Add npm deps. `@cursor/sdk` is pinned to the version `@cursor/july` ships.
  The `@opentelemetry/*` packages are July's own, pinned to the versions it
  installs. Runtime code needs `@opentelemetry/api`, `@opentelemetry/api-logs`, and
  the metrics SDK packages `lib/factory-metrics.ts` uses (`core`, `resources`,
  `sdk-metrics`, `exporter-metrics-otlp-proto`); the trace and log SDK packages
  are devDependencies for tests.

## Pointers

- Package loop: `node_modules/@cursor/july/AGENTS.md`
- Skills: `node_modules/@cursor/july/skills/` (`create-agent`, `deploy`, `evals`, `hillclimb`, `debug`)
- Docs: `npx -p @cursor/july@0.2.24 agent-sdk docs`
- LLM docs index: `node_modules/@cursor/july/dist/docs/llms.txt`

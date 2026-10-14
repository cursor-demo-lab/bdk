# planner

Cursor Agent SDK project (`@cursor/july`). This file is for coding agents
editing the project. The served agent's prompt is `agent/instructions.md`.
Design and the factory it belongs to: `../docs/plan.md` (planning stage).

## Loop

```bash
npx -p @cursor/july@0.2.24 agent-sdk validate --dir .
npx -p @cursor/july@0.2.24 agent-sdk info --dir . --json
npx -p @cursor/july@0.2.24 agent-sdk call record_plan --dir . --input '{ ... }'   # see README
npx -p @cursor/july@0.2.24 agent-sdk eval --dir . --list
npx -p @cursor/july@0.2.24 agent-sdk eval --dir .                                  # needs CURSOR_API_KEY; README "Evals"
npm run check && npm test
```

Run the CLI under Node, never Bun. The planner has one peer edge out,
`agent/host-connections/desk.ts` to `factory-desk`, so `run` and `eval`
that resolve that edge run from the factory root with the desk mounted;
`validate`, `info`, `check`, and `test` run standalone. The desk and
`triage-jira` reach the planner only when the factory root is served.

## Layout

- `agent/agent.ts`: `model: factoryModel(process.env)` (Auto:
  `auto-smart`, `optimize_for` `balanced`, unless `FACTORY_AGENT_MODEL`, `FACTORY_AGENT_EFFORT`,
  `FACTORY_AGENT_SPEED` say otherwise), `cloud: { autoCreatePR: false }`,
  and `local.sandbox`. The runtime is `cloudPlanning` in
  `agent/lib/checkout.ts`, which reads one signal, `AGENT_SERVE_GENERATION`
  (set on every Cursor-managed hosting pod). Off managed hosting, with or
  without a checkout, the agent is `runtime: "local"` and every turn is
  locked to `tools: ["read", "grep", "glob", "ls"]`; when
  `FACTORY_PLANNER_CHECKOUT` names an existing directory,
  `local.workspaceDir` is that directory. On managed hosting the agent is
  `runtime: "cloud"` and declares no `tools` (July refuses cloud turns on
  an agent that declares them): every turn (planning, playground, `ask`,
  MCP) runs on a Cursor cloud agent, and every planning send spreads
  `planSessionCloud(process.env)`, a per-send `cloud.repos` for
  `FACTORY_SANDBOX_REPO` @ `FACTORY_SANDBOX_REF` read at send time, so the
  turn has a clone (`../docs/deployment-issues.md` issue 24). A set
  `FACTORY_PLANNER_CHECKOUT` on hosting makes every planning send throw
  `FactoryConfigError`; it is local only and not in
  `hosting.secretNames`. Host-side `search_sandbox` and `record_plan`
  still read the GitHub tree through `githubChannel({ cursorAccount })` /
  `ctx.host.github` (`agent/lib/sandbox.ts`). Hosted pass-through needs
  no `FACTORY_GITHUB_TOKEN`. What a hosted cloud turn can reach on this
  host (all seven server tools; the host's Cursor key in its tool config;
  and, only if it can read that config, the Jira bridge and other
  sessions' tools) is in the README "Checkout".
- `agent/instructions.md`: `get_plan` first, `read_ticket`, `search_sandbox`
  against the claimed failure, then the `how`, `why`, `architect` skills,
  `record_plan` once when the tree matches, or `record_needs_info` when it
  does not. Reply with the plan and the `Brief:`, or the mismatch. Two
  ways in: a chained session (`Plan <KEY>:` from `plan_issue`) or the
  desk's `ask_2`. "Reporter constraints": every explicit constraint in
  the reporter's request (the desk quotes it verbatim in the description)
  is binding and goes in `why.preserve`, which the `Plan:` comment and
  the brief carry; `planPrompt` ends with the same rule (`CONSTRAINT_RULE`,
  `chain.ts`). `evals/plan.eval.ts` `keeps-reporter-constraints` is
  TLSSN-42.
- `agent/skills/{how,why,architect}/SKILL.md`: pstack's three planning
  moves for one read-only agent. `how` starts with `search_sandbox`; a
  miss is `record_needs_info`, not a prompt-only plan.
- `agent/tools/`: `search_sandbox` (workspace or GitHub tree for the
  claimed path or error; a per-session budget in `agent/lib/search-budget.ts`:
  a repeated query is answered without searching, and past 80 calls it
  answers `search_budget_spent` and tells the model to record now, which
  step 4 of the instructions mirrors; TLSSN-45 spent 215 searches and 23
  minutes. A search that throws gives its slot and query back
  (`refundSearch`): July 0.2.12+ reruns a read tool on an error that looks
  transient, including any message with a bare 429/502/503/504 such as a
  repo name in a config error, and without the refund the rerun counted
  twice and answered `repeated_query` for a search that never returned),
  `record_needs_info` (mismatch comment whose
  first line is `Needs info: <KEY>`, no brief, no move; the desk posts it
  into the ticket's Slack thread. Once per planning run, not once per
  ticket, so a replan that still finds nothing writes its own; each body
  carries the minute it was checked. A chained session writes nothing
  outside Triaged and returns `not_triaged`), `record_plan` (validates against `agent/lib/plan.ts`,
  refuses `evidence: "prompt"` and cited paths that are not on the
  sandbox, reads the ticket for the desk's `Slack thread: <permalink>` line
  (`slackThreadUrl`, the last one in the description, since the desk
  writes it after the reporter's quote; the brief then carries it and asks for a `Slack:` line
  under `Jira:` in the PR description), pins a chained session's plan to its `issue:` key, tags the `plan`
  artifact, writes the `Plan:` comment, and moves a chained ticket to
  Planned only from Triaged (`transitionFrom`, else `transition: { status:
  "skipped_status", current }`), returns the brief; the desk wakes on
  Planned. A chained session reads the status before writing anything:
  outside Triaged it writes no comment, tags no artifact, moves nothing,
  and returns `reason: "not_triaged"`. Every entry into Triaged opens its
  own session, so the first to finish plans the ticket and a late one
  cannot replace an approved plan or drag a launched ticket back to
  Planned (`../docs/deployment-issues.md` issue 15)), `read_ticket`
  and `git_history` (the evidence), `plan_issue` (the chain's entry, called
  inline by triage-jira's `record_triage` over `call_tool`; opens the `plan` channel session
  keyed `issue:<KEY>#<attempt>`, one per planning attempt because hosted v2
  binds a continuation to its first session), `get_plan` (the recorded brief, for approvals; a record whose
  `Plan:` comment never landed is `found: false` with `unpublished`,
  `../docs/deployment-issues.md` issue 26).
- `agent/channels/github.ts`: `cursorAccount` credential only
  (`permissions: "read"`). Hooks return null; no GitHub wake. Tools call
  `ctx.host.github.getOctokit()` so hosted verify uses github-proxy, not a
  PAT. Optional `FACTORY_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` is a
  local override when the host client is missing.
- `agent/channels/http.ts`: the built-in HTTP session channel override
  (`httpChannel({ onMessage })`). Under the hosted posture it refuses
  every principal-bearing `/v1/session*` send with a 400
  (`HttpSessionAdmitError`): that surface is the one place a caller's
  per-session `body.cloud` would win July's merge over
  `cloud: { autoCreatePR: false }` and the planning send's sandbox repos.
  Control-plane admissions (hosted playground, `ask`,
  `agent-sdk run --prod`) arrive with `auth: null` and pass; July already
  rejects a `cloud` field in that payload. Off managed hosting the gate
  passes everything. Do not replace `onMessage` with an `auth` override:
  `project.httpChannel.auth` also guards `/v1/info`, `/v1/logs`,
  `/v1/artifacts`, `/v1/tools`, and the MCP endpoint, which hosted pods
  serve behind the platform's bearer. `http.test.ts` pins the July
  behaviors the gate relies on; re-check them on any July upgrade.
- `agent/channels/plan.ts`: the planning channel; `POST /issue` in dev.
- `agent/channels/webhook.ts`: the Jira route, `POST /v1/channels/webhook/`
  (HMAC or Automation header secret).
  `jira:issue_updated` into the Triaged status goes through
  `planFromStatus`: the status payload decides, then the governing
  `Triage:` comment (read with `readTicket`) gates out question,
  needs-info, and duplicate. Every verdict skip writes `Plan stopped:
  <KEY>` with one `Why:` line (`reportSkippedPlan` in
  `agent/lib/plan-outcome.ts`, claimed once per changelog id at
  `plan-skip/<KEY>:<changelog.id>`): the planner cannot tell triage's own
  move from a bounce or a drag, and a guess that is wrong on a bounce
  leaves the thread on the desk's crumb. The desk relays it unless the
  thread already heard that gate (`redundantSkip` in
  `factory-desk/agent/lib/announce.ts`: no planner crumb up and no desk
  send in the last 30 minutes), so a `plan KEY` from Slack never ends in
  silence and triage's own move does not post twice. Every
  delivery logs one `[planner] webhook …` line: rejected (401), ignored
  with its reason, or planned. Claim `plan/<KEY>:<Triaged>:<changelog.id>`, so a redelivery
  skips and a replan (Planned to Triaged, new changelog id) plans again.
  Re-entry into Triaged from any status is a replan when a `Plan: <KEY>`
  comment is already on the ticket (the desk's bounce through To Do).
  `comment_created` with `Triage:` or `Plan requested:` is a legacy local
  path, not registered on the hosted webhook, and claims
  `plan-claimed/<KEY>` (cleared first on `replan`). Every response carries
  `via: "status" | "comment"`. `agent/lib/start-plan.ts` owns the claim:
  `pending` until `send` returns, then `started` with the session id. A
  `pending` claim older than `STALE_PENDING_MS` is taken over; a younger
  one is in flight. Hosted `host.kv` (July 0.2.13) has get, put, and delete
  only, so the claim is the shared `agent/lib/verified-claim.ts` (a copy of
  the worker's, with `kv-verified.ts` from the desk;
  `../scripts/copies-parity.test.mjs`): read and classify, put
  `{ ...pending, owner }` with a fresh owner per delivery through
  `updateVerified` (read back), wait `FACTORY_CLAIM_SETTLE_MS` (default
  2000, 0 skips it, above 10000 keeps the default), read again, and send
  only while the key still holds this owner's claim. Any other value found
  on the confirm read goes through `classify` with stale read as in flight,
  so it never retakes; an ownerless pending from older code is in flight.
  The claim is released, owner-checked (`deleteVerified`), when `send`
  throws, and before the 503 when the claim was `unavailable`, so a retried
  delivery finds nothing or a rival's claim. Residual: a put that lands
  later than the settle, or an old-code put during a deploy, can still send
  twice, and a planning session has no idempotency key behind it.
  `FACTORY_CLAIM_MODE=legacy` restores the plain read-then-put and logs no
  claim lines, as before. Otherwise every claim and release logs
  `{"host":"planner","claim":…,"key":…,"mode":…}`.
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
  kill switch. The
  `supportsKvCas` / `putIfAbsent` / `putIfVersion` branch never runs in
  production; only the "CAS path (ask 11)" suite in `start-plan.test.ts`
  reaches it. `start-plan.race.test.ts` races the claim against itself and
  against the frozen `agent/lib/testing/legacy/start-plan.ts`. The
  `plan-skip/` and `planning-started/` claims stay a plain read then put
  with no owner and no settle; `already_commented` keeps their second
  comment off the ticket. Hosted, the handler runs at admission,
  where `send` is only captured and the session comes after the ack, so
  `started` there means "captured", not "running". The claim records the
  `x-agent-sdk-delivery-id` the control plane replays the request with; a
  second admission of that same delivery (pod replaced, handoff expired)
  takes its own claim over and sends again. Without that, the replay met its
  own `started` claim, answered `duplicate` (a hosted `skip`), and the run
  was lost with no comment and no hook (TLSSN-32 after its replan).
- `planFromStatus` skips a needs-info `Triage:` verdict, unless a
  `Detail from Slack: <KEY>` comment (`DETAIL_SENTINEL`) comes after it:
  that is someone's reply in the ticket's Slack thread, written by the
  desk, and it answers the verdict. The desk's `triage-comment.ts` reads
  it the same way; `../scripts/outcome-sentinels.test.mjs` holds the two
  constants equal. The instructions tell the model to read that comment
  as part of the claim.
- `agent/hooks/plan-outcome.ts`: on `turn.started` a pinned run writes one
  `Planning started: <KEY>` comment with its session and start time
  (`agent/lib/planning-started.ts`, once per turn, so a resumed session gets
  a fresh start time; the same hook resets the search budget), which the desk's
  plan hop watch and `retry KEY` read to tell a live run from one that never
  started; each turn also logs `{"planner":"turn_model"}`. A failed turn's
  line carries the outcome and message only (`model: "unknown"`). A
  completed turn's line carries its tokens when the turn reported usage
  and, only when a test injects `data.cost`, `model`, `costUsd`, and
  `pricedFrom`. Live July 0.2.24 never stamps cost on `turn.completed`, so
  `model` is `unknown` and the cost fields are absent. Tokens still land
  on the event. The durable cost is July's `GET /v1/session/:id/cost`
  (`sessionCost`).
  `record_plan` refuses a title that is a question, two sentences, or over
  80 characters, and a summary that repeats the title (`digestProblem`;
  `e.g.`, `vs.`, initials, and version numbers end no sentence). A second
  refusal in the same run records the plan with the host's truncated title
  (`fallbackTitle`) instead of ending in Plan stopped.
  Every pinned planning run ends with one
  outcome the desk announces in the ticket's Slack thread. `record_plan`
  and `record_needs_info` leave what they did at `plan-outcome/<session
  id>` in `host.kv`; on `turn.completed` or `turn.failed` (not
  `turn interrupted`, which is a stop or a preempting follow-up; a
  runner-cancelled turn does report; not eval or dry run) the hook reads it (`agent/lib/plan-outcome.ts`).
  A plan moved to Planned, a `Needs info:` comment, or `not_triaged` is
  already the outcome. Otherwise, with the ticket still in Triaged, it
  writes `Plan stopped: <KEY>` with one `Why:` line (the turn's failure,
  a refused plan, a plan that landed but did not move, or no outcome at
  all). A status it cannot read writes nothing. The desk wakes on that
  comment like Needs info. Hooks run in the serving pod, as
  `pr-autofixer`'s `drive-claim` does; a one-shot `agent-sdk run` can exit
  first.
- `agent/host-connections/tracker.ts`: host-only Cursor account Jira, the
  connector triage-jira comments through. The desk and the worker keep
  their own byte-identical copy (`../scripts/copies-parity.test.mjs`);
  the planner's adds `tools`, the names `lib/jira.ts` calls. `read_ticket`
  and `record_plan` call it through `ctx.host.mcp`; the model never sees
  a Jira tool and cannot comment on a ticket of its own choosing. On a
  hosted cloud turn the connection is served at the tool MCP endpoint
  (`?connection=tracker`) while the turn runs, filtered to those names,
  but not mounted on the turn: the turn's MCP config holds only
  `agentsdk-tools`, pinned to its own session (July skips host
  connections in `buildMcpServers`). The VM reaches the bridge only if it
  can read that config's Authorization header and URL (unknown; README
  "Checkout", the key bullet). If it can, it can read anything
  `executeRead` serves (Atlassian's generic read, needed for v2's comment
  and transition lists) and can comment on, edit a comment on
  (`addOrEditJiraIssueComment`), or transition any issue the connected
  account can see, outside `lib/jira.ts`'s `FACTORY_JIRA_PROJECTS` check
  and dedupe. Unsigned or unconnected, the two tools answer
  `not_connected` and the plan still records.
- `agent/artifacts.ts`: the `plan` kind and its schema. No `agentTool`.
- `agent/lib/`: `plan.ts` (schema, brief, ticket comment), `chain.ts`
  (decide, continuation key, first message), `jira-event.ts`
  (`decideStatusEvent`, `planFromStatus`, `decideComment`, the claim keys),
  `jira.ts` (`readTicket`, `commentOnTicket`, and `transitionIssue`, which
  finds the transitions-list and transition tools by name shape and answers
  `transitioned`, `already`, `no_transition`, `not_connected`, or `failed`;
  `transitionFrom` moves only from a named status, which `record_plan` uses
  when its `Plan:` comment is already on the ticket),
  `config.ts` (`factoryModel`, `jiraProjects`, `factoryRepos`, and the sandbox reads re-exported from the shared
  `factory-model.ts`, `factory-env.ts`, `factory-repos.ts`, and `factory-sandbox.ts`; `statusNames` from
  `FACTORY_STATUS_TRIAGED` and `FACTORY_STATUS_PLANNED`), `git.ts`, `checkout.ts`, all with tests. The brief is the only prompt the cloud
  agent ever gets; change the wording in `plan.ts`.
- `evals/`: filesystem evals (`evals/evals.config.ts` required). Not
  `agent/evals/`. That path is ignored. The config fills the non-secret
  repo settings from `evals/support.ts` when unset (no committed `.env`)
  and sets a 300s case timeout; every case that reaches the sandbox seeds
  `workspaceFiles` so no eval depends on GitHub access. `support.test.ts`
  runs under `npm test`.

## Inbound gates

Hosted Plan is the Automation (or HMAC) `jira:issue_updated` into
Triaged. `FACTORY_INPROCESS_PEERS` is unset on the slugs, so the
planner peer is a stub and `triage-jira`'s `record_triage` returns
`event_bus` instead of calling `plan_issue`. Local
`serve --dir .` with `FACTORY_INPROCESS_PEERS=1` can chain inline;
that is not the hosted path.

`planFromStatus` then gates on the governing `Triage:` comment
(`governingTriage` → `parseTriage` → `decide` in `agent/lib/jira-event.ts` /
`agent/lib/chain.ts`). On a ticket factory-desk filed, that is the desk's
own comment: the one ending with `DESK_TRIAGED_LINE`
(`agent/lib/desk-triaged.ts`, shared with the desk and triage-jira), or,
else the first `Triage:` comment a triage run wrote (it has a `Triaged by:`
line; on a ticket filed before the desk marked its comment, that is the
desk's). A later machine-written `Triage:` comment is a second triage that
should not have run (TLSSN-40), not a new verdict; a later one without a
`Triaged by:` line is a person correcting the verdict in Jira, and it
governs. A ticket with no machine-written comment reads the newest. The
rule is `governingTriage` in `agent/lib/desk-triaged.ts`, byte-identical
in the desk, whose `triage-comment.ts` calls it too, so a bounce the desk
sends is one the planner plans (`../scripts/governing-triage.test.mjs`
runs both readers over the same comments). It needs no description.

The desk's `plan KEY` bounce (To Do → Triaged) is a person asking for a
plan and passes the same gate. The desk refuses to bounce a ticket whose
governing verdict is a question, a duplicate, or an unanswered needs-info
(its `triage-comment.ts` reads the verdict the same way), and a
`Detail from Slack:` reply is how a person answers a needs-info, so a
bounce the desk sends plans. A skip is written on the ticket as
`Plan stopped:` rather than dropped.

| Governing `Triage:` comment | Result |
| --- | --- |
| Line matching `Needs info:` | `{ plan: false, reason: "needs_info" }`, plus `Plan stopped:` |
| Question kind, or `Duplicate of:` / duplicate inbound | `{ plan: false, reason: "question" \| "duplicate" }`, plus `Plan stopped:` |
| Bug or feedback, no needs-info | `{ plan: true }` — writes `Plan:`, moves to Planned |
| No `Triage:` comment, or comments unread | Plans without a verdict (same as a manual request) |

HMAC replay of a Triaged event hits the same comment gate. A vague
ticket that triage marked `Needs info:` will never get `Plan:` from
replay either. Do not weaken that skip.

The status payload itself still needs `changelog.items` with
`field` = `status` and `fromString` / `toString` (see
`docs/jira-automation.md`). Missing items are `not_status_change`.

## Do not

- Add `shell`, `edit`, or `task` to `tools`. The planner reads and records.
  On the hosted cloud turn there is no `tools` list (July cannot enforce
  one there); the instructions and `autoCreatePR: false` hold the line,
  and `autoCreatePR: false` holds only while per-session `cloud`
  overrides stay off hosted turns (July's hosted admission plus
  `agent/channels/http.ts`; README "Checkout").
- Let the model write the brief. It copies `brief` from the tool result.
- Give the model a Jira tool. Jira stays behind `host-connections/`, read
  through `read_ticket`, written through `record_plan`, which keeps writes
  to `FACTORY_JIRA_PROJECTS` (`TLSSN`). That project scope holds for the
  planner's own tools only: the bridged connection is served at the tool
  endpoint with the names in `tracker.ts` and no project check, and a
  hosted cloud turn reaches it if it can read its `agentsdk-tools`
  Authorization header and URL (unknown; README "Checkout").
- Let `plan_issue` run an `ask`. The chain is host to host; the planning
  turn is the `plan` channel session it opens.
- Add npm deps. Stick to what `@cursor/july` already ships.
  The `@opentelemetry/*` packages are July's own, pinned to the versions it
  installs. Runtime code needs `@opentelemetry/api`, `@opentelemetry/api-logs`, and
  the metrics SDK packages `lib/factory-metrics.ts` uses (`core`, `resources`,
  `sdk-metrics`, `exporter-metrics-otlp-proto`); the trace and log SDK packages
  are devDependencies for tests.
- Require a GitHub PAT for hosted verify. Hosted `search_sandbox` uses
  `ctx.host.github` (cursorAccount pass-through).

## Pointers

- Package loop: `node_modules/@cursor/july/AGENTS.md`
- Skills: `node_modules/@cursor/july/skills/` (`create-agent`, `deploy`, `evals`, `hillclimb`, `debug`)
- Docs: `npx -p @cursor/july@0.2.24 agent-sdk docs`
- LLM docs index: `node_modules/@cursor/july/dist/docs/llms.txt`

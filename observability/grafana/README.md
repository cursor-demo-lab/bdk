# Software Factory dashboards (Grafana, as code)

The two Grafana Cloud (13.1+; verified on 13.3.0) dashboards for the factory's OpenTelemetry export
([`docs/factory-deployment.md` section 11](../../docs/factory-deployment.md#11-opentelemetry-export-grafana-cloud)),
kept as code. They live in the **Software Factory** folder (uid
`software-factory`) of the `<GRAFANA_STACK>` Grafana Cloud stack.
v4 replaced the four earlier dashboards (Factory overview, Factory traces,
Factory logs, Factory tokens & cost; uids `factory-overview`,
`factory-traces`, `factory-logs`, `factory-cost-tokens`, kept in
`generate.py` as `RETIRED_UIDS`): `apply.sh` deletes exactly those four
after a successful upsert of the two below.

| File | What it is |
| --- | --- |
| `generate.py` | The single source of truth. Python 3 standard library only; writes the two JSONs |
| `factory-business.json`, `factory-ops.json` | Generated; committed; never edited by hand |
| `apply.sh` | Creates or updates the folder and the two dashboards, then retires the four old uids (bash, curl, jq) |
| `verify.py` | Runs every panel query of the local dashboards through Grafana (`--deployed` for the deployed copy) |
| `grafana_client.py` | Token handling and HTTP for `verify.py` and `tools/` |
| `tools/rawcheck.py`, `tools/spansum.py` | One raw Prometheus / Loki / Tempo query; span counts by service and name |
| `tools/rawbody_check.py` | Pushes a log fixture to a Loki you own and runs the dashboards' own Loki queries against it (the milestone fixture has known lead times, a first-pass rate and modelled hours) |
| `tools/load_smoke.mjs` | Loads each deployed dashboard in headless Chrome at 24h, 7d and 30d and reports crashes and panel errors (v2) |

## The dashboards

Both share the `$service` variable (a static list of all six hosted
slugs — `label_values()` would hide an idle one; hidden on Business, which
is always all slugs), a 24-hour default range, the browser timezone, a
5-minute refresh and the **Factory** dropdown (by dashboard tag) that
keeps the time range and variables. Per-service panels zero-fill every
slug (`label_replace(vector(0), …) or` the live series), so an idle slug
shows 0 rather than vanishing; only factory-desk, factory-planner and
factory-security-reviewer run model turns, so the other slugs show 0 on
turn panels. Ticket keys open Jira
(`https://example.atlassian.net/browse/<KEY>`) or the ticket on
Factory ops (`var-ticket`), PR values open the pull request on GitHub,
trace ids and span ids open the trace, and a service cell opens Factory
ops filtered to that slug.

**Factory business** (`factory-business`). What did the factory deliver in
the range, how fast, how cleanly, and what did it cost? 17 panels, no
collapsed rows: the cold-open story. Delivery and lead-time figures read
the hosts' own Loki milestone lines (one JSON line per milestone, "Ticket
stages and the Loki milestones" below), never the lossy Tempo announce
spans; cost is the token-based estimate.

- *Delivery (range, all slugs)*: ten large stats.
  **Filed** (distinct tickets that entered Triaged: the desk's
  `plan_start_watch via arm` line, else the planner's `turn_started`; an
  approximation, said so in the description), **PRs opened** (worker
  `implement_pr opened` or `pr_status in_review moved`), **Merged**
  (worker `pr_status done moved`), **First-pass rate** (of the tickets
  merged in range, the share with no worker launch retry / heal and no
  Bugbot fix round on their PR; the Bugbot join and its approximation are
  below), **Filed → PR opened p50** and **Filed → merged p50** (per ticket,
  from the lines' own timestamps; p95 is in the Lead times table), **Slack
  approvals per ticket** (a ✅ on the plan or a typed approve, per ticket
  that reached the worker; the approve tool and a board drag leave no desk
  line, so it undercounts), **Spend (est.)**, **Cost / merged (est.)** (the
  estimate ÷ the worker's merged counter, each key once) and
  **Engineer-hours saved (modelled)**: merged tickets × the
  **Hours / ticket** variable (`$hours_per_ticket`, custom, default **4**,
  editable). MODELLED, not measured: 4 h is a conservative manual baseline
  for a small ticket (plan + implement + PR), chosen because recent factory
  e2e filed-to-PR wall-clock was about 25 to 40 minutes; it is not an
  observation of hours saved. There is no daily budget line, gauge or
  variable.
- *Flow (Loki milestones)*: **Ticket flow (Loki, distinct tickets in range)**,
  a bar gauge of distinct tickets per milestone in flow order
  (filed, plan started, approved (reached worker), launched, PR opened,
  merged) on the stage ramp; each bar counts tickets whose milestone is in
  range, not a cohort. **Lead times**: one row per ticket (filed → PR and
  filed → merged; merged stays blank until Done). The strip tiles still
  reduce the per-ticket series to a median in the browser (LogQL has no
  vector quantile).
- *Economics (estimate)*: **Cost / filed (est.)** (the Prometheus estimate ÷
  Loki's distinct filed tickets, divided in the browser; no ticket means
  "no ticket filed in range", never `$∞`), **Cumulative spend (est.)**,
  **Cost by service** (a bar gauge in slug colours; no pie), **Cost and
  tokens per ticket (all tickets in range)** (one row per
  `factory_ticket_key`), and the **Estimate, not billing** text.

**Factory ops** (`factory-ops`). Is the factory healthy now, and what is
each ticket doing? 42 panels open, and every debug table under a
collapsed **Debug:** row (42 more). Variables: **Service**, **Ticket**,
**Bucket**; **Find** (`$search`, the regex on All factory logs) is hidden so
the bar stays one line at 1280 (set `var-search=` in the URL).

- *Now · 15m*: **Stuck now** (7-day lookback), **Errors**, **Turn fails**,
  **Tool fails**, **Ack p95**, **Deliveries** (the 15m pin lives in the row
  title), then **Stuck tickets (past hop deadline)** and the
  **Activity per service** status-history grid (is a slug alive at all?).
  Hop-watch deliveries (`schedule.hop-watch`, `reminder.hop_watch`,
  `hop_watch.*`: the desk's 5-minute liveness tick, its reminders and
  sweeps) are left out of every delivery error / no-op figure on Ops —
  Errors, Error %, Deliveries, the outcome-class chart — so an idle tick
  cannot dominate a tile; the by-service and by-kind charts keep them as
  their own family.
- *In range*: deliveries, errors, error %, ack p95, 5xx, KV fails, turns,
  turn fail %, tool calls, tool err %, the cost estimate and **Cache %**
  (`cache_read / (uncached input + cache_read)`, decided per series).
- *Factory health events (Loki)* (v3, one copy): **Never started (alerts)**
  (distinct tickets whose plan start check ended retried, not_moved or
  final: red from 1), **Plan start: started**, **Launch retries / heals**
  (worker `launched` via heal or retried true: orange from 1), **📡 Change
  reviews**; the three w=8 lists **Plan start watch by result and via**,
  **Worker launch decisions by outcome**, **📡 Change review per ticket
  (latest)**; and **Health event lines** underneath. The desk's idle
  hop-watch tick (`{"desk":"hop_watch","via":"schedule","due":0,"fired":0}`)
  is dropped from every event count.
- *Tickets (Loki)*: **Recent tickets (latest 20, 7 days)** (one copy; the
  current stage from the desk's announce spans, outcomes such as
  `needs_info` included), **Ticket milestones (logs)** (one line per
  milestone, for **Ticket** or every ticket while it is empty) and **Ticket
  journey: events in time order** (every log line of the ticket in
  **Ticket**; "Pick a ticket in the Ticket box above. If one is picked,
  widen the time range." while it is empty).
- *Deliveries*: per-bucket bars by slug, by kind family (categorical
  `PALETTE` kind colours) and 100% stacked by outcome class (hop-watch
  excluded; `idle` is a no-op).
- *Failures and warnings*: errors and warnings per bucket by level, turns
  completed vs failed (Loki), and the **Failures and warnings** log panel
  (the Slack WebClient session-stopped pair is under Debug: Slack SDK).
- *Cost (estimate)*: **Cost by service**, **Cost / bucket**, **Cost per
  ticket (est.)** (Simon's mean full cost of the tickets merged in the
  trailing 24h), **Cost and tokens per ticket**, **Tokens and cost by
  service**.
- *Debug: deliveries by kind and outcome (Prometheus, approximate)*
  (collapsed): deliveries by slug, kind and outcome; deliveries that
  failed or did nothing; deliveries in logs by slug and event type (distinct
  `deliveryId`); the per-slug metric-vs-logs cross-check.
- *Debug: latency* (collapsed): p95 per factory span, hosted HTTP p95,
  hosted execution p95 (Tempo), **Exec duration (Tempo, agent_sdk.turn)**
  (the heatmap).
- *Debug: agent turns, tools, HTTP and KV* (collapsed): turns by status,
  tool calls by slug, sessions by channel, hosted executions, top tools,
  reminder fire outcomes, KV failures by slug / site / reason, HTTP
  requests by route and status (table and chart).
- *Debug: tokens and the Loki cross-check* (collapsed): tokens per bucket
  (uncached input, cache read, output), tokens by slug, per-turn p50 / p95
  from `turn.completed` logs, logs vs metric totals.
- *Debug: volume and raw logs* (collapsed): **Err & warn**, **Turn fails
  (logs)**, **Events**, **Log lines**; factory structured events; recent
  factory events; lines per bucket by slug, July event and level; **All
  factory logs** (the Find regex; tagged `[tag]` / `tag:<tag>` lines hidden
  by the Tags variable, `var-tag_lines=%5E%24` shows them).
- *Debug: Tempo span tables* (collapsed): the ticket's spans, recent
  `factory.*` spans, spans that failed or did nothing, cloud agent
  launches, recent `agent_sdk.http` spans, error spans, recent turns, failed
  tool calls, per-turn token usage. Each `factory.*` span is its own
  sampled trace (#215); **Span** / **Span ID** opens it. The error table
  lists only July and factory span names (`agent_sdk.*`, `factory.*`, MCP
  `tools/call` and `tools/list`); the hosted runtime's `context-tracer`
  spans are about 80% of stored spans and would bury it.
- *Debug: Slack SDK (expected)* (collapsed): the Slack WebClient pair
  (`missing_agent_session_stopped_event_subscription` and `Subscribe to the
  agent_session_stopped event`; about 2 per desk turn; expected). One shared
  regex includes and excludes both lines (`web-api:WebClient[^\n]*(?:…|…)`;
  Loki 3.5's line filter mishandles `.*` before an alternation). The lines
  stay in Loki; the dashboards only split them.

The Ops description says that Prometheus counts are approximate and Loki
is the reference (see "How the numbers are computed").

**Cut in v4** (about 45 panels): the Tempo announce-span funnel, stage
timeline, stage-changes chart and dwell table (lossy spans; the Loki flow
and lead times replace them), the Today strip with its Yesterday row,
Budget $ box and gauge, the Traces summary counts, Intake candidates, the
Cost share donut, the token micro-tiles and per-turn / per-session
averages, the Slow spans table and its variable, the Log ids stat, the How
to use text panels, and the second copies of the health events and Recent
tickets.

## Regenerate, apply, verify

From this folder:

```bash
python3 generate.py            # rewrite the two JSONs from generate.py
python3 generate.py --check    # exit 1 if a JSON is stale, a file here holds a secret shape,
                               # a query contains `$$` (Grafana collapses it to `$`), or a
                               # table's visible column widths break WIDTH_BUDGET_1280
python3 verify.py --offline    # every target interpolates with the variable defaults (no Grafana);
                               # with PROMTOOL set, every PromQL also parses under promtool
export PROMTOOL=/tmp/prometheus-3.5.0.linux-amd64/promtool   # promtool 3.5.0 from the Prometheus release
python3 tools/promtool_ratio_check.py     # ratio / per-unit / quantile guards
python3 tools/promtool_ticket_check.py    # per-ticket cost queries
python3 tools/promtool_shape_check.py     # the two input shapes (per-series uncached input), Cache %, per-ticket columns
python3 tools/bucket_look_ahead_check.py  # look-ahead buckets, resets, range totals

export GRAFANA_URL=https://<GRAFANA_STACK>.grafana.net   # the default when unset
export GRAFANA_TOKEN_FILE=~/.config/grafana/factory-dashboards.token   # or GRAFANA_TOKEN=...
./apply.sh                     # folder + two dashboards, idempotent by uid; then deletes the four retired uids
python3 verify.py              # every panel query of the local JSONs through Grafana, last 6 h
python3 verify.py --deployed   # the same, from the dashboards Grafana is serving
python3 verify.py --ranges 6h,24h,7d,30d   # one online pass per lookback; exit 1 on any error
python3 verify.py --from now-24h --var ticket=TLSSN-56 --json verify-results.json
python3 verify.py --ranges 24h,7d,30d   # the same, once per range (Tempo metrics stop at 25h)
node tools/load_smoke.mjs      # each dashboard in headless Chrome at 24h, 7d, 30d (needs puppeteer-core and Chrome)
```

- **Token.** A Grafana service account with Editor on the folder; its token in
  `GRAFANA_TOKEN` or in a file named by `GRAFANA_TOKEN_FILE`. Both scripts
  refuse a token file inside this git work tree (after following every
  symlink; `apply.sh` does that with `cd -P`, `pwd -P` and plain `readlink`,
  so it works on macOS and the BSDs too), never print the token, and
  never write it anywhere; `apply.sh` hands curl the header on stdin, so it is
  not on a command line either. `*.token`, `*-token` and `.grafana-*` are
  gitignored here and at the repository root.
- **apply.sh.** A GET of a folder that does not exist yet answers 403 for an
  Editor service account, so anything but 200 means "create". A 409 or 412 on
  create means a folder with this uid or this title exists, so `apply.sh` reads
  the folder again by uid: 200 means it exists and the run goes on; anything
  else stops the run with "a folder titled 'Software Factory' probably exists
  with another uid", instead of failing every dashboard post. Each dashboard is posted to `/api/dashboards/db` with
  `overwrite: true` and the folder uid, so a re-run updates in place. Only
  when both upserts answered 200 does it `DELETE /api/dashboards/uid/<uid>`
  for the four retired uids (`RETIRED_UIDS`; 404 means already gone), so a
  failed upsert leaves the old dashboards up. It never deletes any other
  dashboard or a folder.
- **verify.py.** Reads the local JSONs by default (what a merge would deploy;
  `--deployed` GETs each dashboard back and checks what Grafana is serving),
  interpolates every target (`${var:pipe}`, `${var:regex}`, `$var`, `${var}`,
  `$__range`, `$__range_s`, `$__interval`, `$__interval_ms`,
  `$__rate_interval`, and `$__auto` on Loki only; textbox, custom and constant
  variables including the prices and the empty ticket; `:regex` escapes
  what Grafana's lodash `escapeRegExp` does, never `-`, which Loki's
  string lexer rejects), honours each panel's
  min interval and relative time override, interpolates Loki `step` / target
  `interval`, posts it to `/api/ds/query`, and prints `data`,
  `empty` or `error` per target with a per-dashboard count. A panel with a
  server-side expression posts all its targets in one request (alone, the
  expression fails with `sse.missingDependentNode`), and an `Inf` or `NaN`
  in a result is a warning (v2). Exit 1 on any
  error, including a leftover `$__auto` on a Prometheus target. `--offline`
  interpolates the local JSON the same way. When `PROMTOOL` is set it also
  runs each interpolated PromQL expression through
  `promtool promql format --experimental`. `--var NAME=VALUE` overrides a
  default; `--dashboard UID` limits it.
- **Tests.** `scripts/grafana-dashboards.test.mjs` (part of `mise run test`)
  runs `generate.py --check` and `verify.py --offline`, checks the secret
  scan catches every shape it claims to, and locks the conventions below
  (slug legends, no `rate()`/`increase()`, neutral volume stats, estimate
  labelling, empty ticket default, no byValue `filterFields` ahead of a
  `groupBy`, hop-watch excluded from the Ops delivery tiles, the Business
  strip and its hours model). With a Loki at `FACTORY_LOKI_URL` or
  `127.0.0.1:3100`, `tools/rawbody_check.py` also pushes the milestone
  fixture (planner, desk, worker and fixer lines shaped as the host code
  writes them, four tickets pushed minutes apart, the idle hop-watch tick)
  and runs every Loki panel's own query against it: the flow bars, Filed,
  PRs opened, Merged, the lead times per ticket (9 minutes each), the
  first-pass rate (1 of 3 merged), Slack approvals per ticket (2 of 4),
  the modelled hours (3 × 4) and the Ops health panels; a local
  `loki-linux-amd64 -config.file=…` with filesystem storage is enough
  (checked on Loki 3.5.0 when v4 was written). Repo CI runs no factory tests (see the
  factory README, Tests and evals), so run it before merging a dashboard
  change.

## Telemetry the queries use

Datasource uids: `grafanacloud-prom`, `grafanacloud-logs`,
`grafanacloud-traces`.

**Prometheus.** Every series carries `service_name="<slug>"` and
`service_namespace="software-factory"`; queries, legends, columns and
`$service` use those, never `job` (`software-factory/<slug>`) or `instance`
(a per-VM UUID).

| Metric | Labels used |
| --- | --- |
| `apj_factory_delivery_total` | `factory_span`, `factory_delivery_kind`, `factory_outcome` |
| `apj_factory_delivery_duration_milliseconds_{bucket,sum,count}` | the same |
| `agent_sdk_http_duration_milliseconds_*` | `http_request_method`, `http_response_status_code`, `url_path` (a route class) |
| `agent_sdk_hosted_execution_duration_ms_milliseconds_*` | `phase`, `channel_kind`, `delivery_surface`, `outcome` (the doubled unit is real) |
| `agent_sdk_hosted_execution_visible_reply_total` | `channel_kind`, `delivery_surface`, `outcome` |
| `agent_sdk_reminder_fire_outcome_total` | `reason`, `kind`, `purpose` |
| `agent_sdk_session_count_total` | `agent_sdk_agent`, `agent_sdk_channel` |
| `agent_sdk_turn_count_total` | `agent_sdk_turn_status`, `factory_ticket_key` |
| `cursor_token_usage_total` | `cursor_token_type`: `input`, `cache_read`, `output`, `reasoning`; `factory_ticket_key` |
| `cursor_cost_usage_USD_total` | gone after July 0.2.20; 0.2.25 still emits none. Historical series only. Do not query |
| `cursor_tool_calls_total` | `cursor_tool_name`, `cursor_tool_status` (`success`, `failure`); also carries `factory_ticket_key` and the session ids (July stamps the session's tag bag on every sample and the factory has no View to drop it): a series per tool, status, ticket and session, which no panel breaks down |
| `apj_factory_kv_failure_total` | `slug`, `site`, `reason` (bind emits a zero baseline with `site="none"`, `reason="none"`); a session-bound `host.otel` also merges that session's tag bag, so a sample can carry any session's `factory_ticket_key`; no panel groups by it |
| `apj_factory_ticket_merged_total` | `factory_ticket_key`: one per ticket the worker moved to Done on a merged PR, counted once per Jira issue however many PRs close it (the denominator of cost per merged ticket) |

**`factory_ticket_key`** (OTLP attribute `factory.ticket.key`, the same name
the `factory.*` spans carry) is the Jira key of the ticket a turn worked on.
Each host that runs model turns has a hook (`agent/hooks/ticket-key.ts`)
that resolves the turn's ticket on `turn.started` and writes it as a
session tag through July's public API, `ctx.host.otel.setAttributes`
(`host-otel.js:47-54` → `collector.setSessionAttributes`, `collector.js:61-65`). July then does two
things with the tag, both of which the factory relies on: it merges the
tag into the attributes of every metric sample it records for the session
(`collector.js:621` `join`: `cursor.token.usage`,
`agent_sdk.turn.count`, `cursor.tool.calls`, …; 0.2.20 dropped `cursor.cost.usage`) and into the attributes
of every span it starts for the session afterwards (`agent_sdk.turn`,
`agent_sdk.turn.<phase>`, `agent_sdk.tool`, `agent_sdk.subagent`), and it
paints the tag onto the session's already-open `agent_sdk.turn`,
`agent_sdk.tool` and `agent_sdk.subagent` spans (`paintOpenSpans`, `collector.js:629`). Hooks
run before July's collector sees the event, so the tag set on
`turn.started` is on every metric sample of the turn.

Which spans carry it, exactly. July appends `turn.started` to an async
dispatch queue (`session-engine.js:3647` `queueDispatch`) and, in the same
synchronous stretch, opens the turn's first phase span (`agent_sdk.turn.prewarm`
when a local workspace is prewarmed, else `.workspace`, else `.nudges`),
so that first phase span always starts before the hook's `setAttributes`
lands, and `paintOpenSpans` does not paint phase spans. The later early
phase spans (`.workspace`, `.nudges`, `.build_request`, `.first_update`)
each open after an `await`, so whether the hook has run by then depends
on its latency: with an instant key lookup (planner and triage read a
session pin) they can already carry the current key; with a kv read (the
desk) or a PR read of up to 2 s (fixer, reviewer) they may not. The key is
reliable on the `agent_sdk.turn` span (painted, and open for the whole
turn), on every `agent_sdk.tool` span (they open at the tool call: on
`actions.requested`, or in `runInCall` when July executes the tool itself)
and `agent_sdk.subagent` span (they open on `subagent.called`), both after
the hook, on phase spans opened after the hook settled, and on the
metrics. A phase span opened before the hook settled has no key on a
session's first turn and the previous turn's key on a re-tagged session;
that is certain for the first phase span and possible for the later early
ones. Factory ops's
"Ticket journey: spans" panel (Debug: Tempo span tables) matches July spans by that
attribute, so it can list a re-tagged session's early turn-2 phase spans
under turn 1's ticket; read phase spans there by their `agent_sdk.turn`
parent, which is right.

**This is an approved exception to the rule that July's spans leave as
July makes them** ([`docs/july-otel-upstream.md`](../../docs/july-otel-upstream.md)
section 6, [`docs/factory-deployment.md`](../../docs/factory-deployment.md),
"July's own spans"). The factory adds this one attribute,
`factory.ticket.key`, to July's turn, tool, phase and subagent spans and
to July's metrics, and it does so only through July's public
`setAttributes` / `setSessionAttributes` API, never by touching a span or
an exporter directly. Nothing else on July's spans or logs changes: no
attribute is removed, rewritten, or added, no span is suppressed, and July's
logs carry no ticket (the session bag does not reach `emitLog`).

On metrics the label lands on every sample July records for the session
(`cursor_token_usage_total`, `agent_sdk_turn_count_total`,
`cursor_tool_calls_total`, ...), because July stamps the whole tag bag and the
factory has no View to drop it where pricing does not need it (July builds the
meter provider and has no View hook; the earlier factory View kept it on three
instruments only). That is one more series
per tool, status and ticket on `cursor_tool_calls_total`, which no panel reads
by ticket. `apj_factory_ticket_merged_total` is the factory's own counter
(`countTicketMerged`, on the global meter). The label's values are bounded to
one series per Jira key plus two fixed values: `none` when the turn has no
ticket yet or no ticket at all, and `other` for a session pin that is not a
Jira key (`ticketLabel` in `factory-otel.ts`, the one helper the hooks call).
A turn no hook tagged (none exist: every host with model turns has the hook)
would be `none`, not an unlabelled row. Where each slug's key comes from:

| Slug | Key | `none` when |
| --- | --- | --- |
| `factory-desk` | the Slack thread's latest filed ticket (kv `thread-tickets/…`); the turn that files a ticket is re-tagged by `file_ticket` itself, which calls `tagSessionTicket` the moment `createIssue` returns the key (`approve_ticket`, `deny_ticket` and `request_plan` tag their input key on entry), before its usage is recorded, so the filing turn's whole cost lands on the new key; the hook's `action.result` listener is a second path over the same keys, parsing the JSON-string tool output July hands hooks for a server tool | intake chat before `approve file`, a question, a DM with no ticket, a playground chat; a kv outage (the thread's tickets cannot be read: a turn on a thread with a filed ticket is then `none`, its cost counted but unattributed, and the turn runs) |
| `planner` | the session pin `issue:<KEY>#<attempt>` (the Triaged webhook and `plan_issue` both pin it); every retry attempt shares the key | a playground chat, an eval |
| `triage-jira` | the session pin, the issue key itself (the issue-created webhook and the queue route pin it) | a playground chat, an eval |
| `pr-autofixer` | the drive's PR (session title `PR owner/repo#n` or the `drive` token `pr:owner/repo#n`): the head branch when it starts with the key (a factory branch), else the PR title, read once per session and within a 2 s budget; a GitHub delivery's session reads July's channel state (`headRef`) with no read | a PR with no key in branch or title, a playground chat; a PR read that fails or takes over 2 s (that session stays `none` until the pod is replaced) |
| `security-reviewer` | the GitHub channel state's head branch when it starts with the key, else one PR read per session, within 2 s, for branch and title | a PR with no key in branch or title, a playground chat; a PR read that fails or takes over 2 s |
| `factory-worker` | the session's continuation token, `implement:<KEY>#<changelogId>` (`cont:`-prefixed on hosted v2), which the jira channel pins when it starts the implement agent as a July cloud turn with a per-send `cloud` attach for the sandbox repo (`agent/lib/implement-turn.ts`); the hook needs no read. The host's other work (the decision, the claim, the PR moves) is host work with no turn. It also exports `apj_factory_ticket_merged_total` | a direct chat on the playground, an eval; the launch heal's agents (`via: "heal"`, a reminder run with no channel `send`), which still start through `@cursor/sdk` and never reach a host |

A session that works on more than one ticket over its turns (a thread whose
latest ticket changed, a drive re-pointed) is re-tagged on each
`turn.started`, and each turn's usage lands on the ticket of that turn
only; the tag overwrites, nothing is counted twice (`july-otel.test.ts`).

An implement cloud turn is one turn for the whole run: July reads the run's
usage from `@cursor/sdk` when `wait()` returns (`dist/internal/sdk-runner.js:783-799`,
`fillMissingCloudUsage` at `:415` when the stream dropped it) and the collector
records it against the worker's session on the turn's `turn.completed`
(`dist/internal/otel/collector.js:357-371`), so a long implementation lands as
one `cursor_token_usage_total` sample per token type and one
`agent_sdk_turn_count_total` increment, hours after `turn.started`, on the
pod that ran the turn. An implement run's cost is the token-based estimate
(July 0.2.25 emits no `cursor.cost.usage`: `dist/internal/host-otel.js:14` only reserves the name). Dated note: before 2026-10-04
the worker launched that agent through `@cursor/sdk` `Agent.create`,
invisible to July, so cost panels before that date cover the planning,
triage, desk, fixer and reviewer turns only. In one line: worker cloud turns
are counted since #229, except a heal relaunch (`via: "heal"`, **Launch
retries / heals**), which still goes through `@cursor/sdk` and is not.

Cost that never reaches a host is not attributable this way: the launch
heal's SDK agents (above), and a turn that fails (July reports no usage on
`turn.failed`; for an implement turn that fails before its `agent.bound`
the worker releases its claim and posts `Launch failed:`, after first
checking through `Agent.get` that the agent is not in fact still running).
The known case is an implementation over 60 minutes: the pod's
`CURSOR_API_KEY` is a 60-minute token, so the turn ends with an auth error
mid-stream while the cloud agent keeps building, the worker leaves the
claim alone (`turn_failed_agent_alive`), and that run's tokens never reach
`cursor_token_usage_total`; its `agent_sdk_turn_count_total` increment
carries `agent_sdk_turn_status="failed"`. Losing the pod's session lease
cancels the run outright (`docs/factory-deployment.md`, "Losing the session
lease aborts the cloud run"). Neither is fixable in factory config.

Not used: `cursor_cost_usage_USD_total` (gone after July 0.2.20; historical
series only), `cursor_model_name` (0.2.25 still does not stamp it on new turns: no `cursor.model.name` in `dist/internal/otel/`),
`cursor_token_type="cache_creation"` (July's collector adds it only for a
non-zero cache write; no panel reads it, and whether the factory's models
ever report one is not verified), and `agent_sdk_subagent_count_total` (no
slug uses subagents).

**Loki.** Stream labels `service_name`, `service_namespace`. July's session
events (`message.received`, `turn.completed`, `turn.failed`,
`action.result`, ...) carry July's attributes as structured metadata:
`agent_sdk_event`, `agent_sdk_agent`, `agent_sdk_channel`,
`agent_sdk_expected_error`, `cursor_tool_name`, `cursor_tool_status`,
`agent_sdk_usage_input_tokens`, `agent_sdk_usage_output_tokens`. Levels and
ids differ by sender:

- `severity_text` is set only on the factory's console lines (the bridge's
  `INFO` / `WARN` / `ERROR`; a console line's level is its method's, except
  Node's own print of a process warning, such as a `DeprecationWarning`,
  which is one `WARN`, not an `ERROR`; the exceptions, such as a stack-trace
  print the bridge cannot match, are in `docs/factory-deployment.md`). July
  0.2.25 drops the once-per-process `ExperimentalWarning: SQLite is an
  experimental feature` that used to be the regular case. Loki takes `detected_level` from it and keeps
  its case, so those lines read `WARN` / `ERROR` (Loki 3.5; 3.7 lower-cases
  it). July's session events carry only a severity number, so their
  `detected_level` is lower case (`warn`, `error`). Level filters are
  therefore case-insensitive (`(?i)error|warn|...`), and "Log lines per
  bucket by level" groups on `level`, the lower-cased `detected_level`.
- `trace_id` and `span_id` are present only on a line logged inside a span;
  others have none.

The factory's own console lines arrive in one of two shapes, and every panel
reads both. Since #217 the console bridge exports lines as raw
`util.format` bodies and does **not** parse them into attributes:

- **Raw `util.format` bodies** (current, since #217): July's tagged lines
  such as `[bdk] hosted admission received
  deliveryId=… channelId=… eventType=… sessionMode=…`, the hosts' own
  `[planner] TLSSN-5 stopped without a plan …` lines, and the factory's JSON
  lines such as `{"desk":"intake_root","issueKey":"TLSSN-5","outcome":…}`,
  with no factory attributes.
- **Older records exported before #217**, still parsed: a `tag:<tag>` or
  `factory.<key>` body with the fields as structured metadata
  (`factory_event`, `issueKey`, `factoryKey`, `outcome`, `reason`, `via`,
  `wake`, `pr`, `deliveryId`, `eventType`, ...).

`FACTORY_FIELDS` in `generate.py` normalises them. `| json` reads the JSON
keys into `j_*` labels, where the event is the first of `worker`, `desk`,
`fixer`, `planner`, `triage`, `factoryDebug`, `kv`, `step`, `ops`, `otel`
present. `| regexp` reads `deliveryId=` and `eventType=` from tagged lines
into `r_*` labels; a `:` or `,` that ends a value, as in `deliveryId=abc:
boom`, is July's punctuation. `| drop __error__` keeps the non-JSON lines,
which would otherwise fail every metric query with `JSONParserErr`.
`label_format` then sets one `f_*` field per name from the first source that
has it: `f_event`, `f_ticket`, `f_outcome`, `f_reason`, `f_via`, `f_wake`,
`f_pr`, `f_delivery`, `f_event_type`. `f_reason` also takes a JSON line's
`why`, which many factory lines use for their reason code (`intake_root`'s
`filed_in_slack_unbound`, `threw`, `timeout`); `error` and `message` carry
exception text and stay in the body. The parsed labels never collide with
structured metadata, and no query filters on a bare factory key (a test
enforces it). `tools/rawbody_check.py` pushes a fixture of both shapes to a
Loki you can write to and checks the delivery cross-checks, the factory
event panels, the ticket journey and the tag toggle against it.

**Tempo.** `agent_sdk.http` (server), `agent_sdk.turn` (with
`agent_sdk.usage.*` tokens, `agent_sdk.channel`, `agent_sdk.session_mode`),
`agent_sdk.tool` (`cursor.tool.name`, `cursor.tool.status`), and the
`factory.*` spans (`factory.delivery`, `factory.background`,
`factory.github.task`, `factory.reminder`, `factory.schedule`,
`factory.cloud_agent.launch`) with `factory.delivery.kind`,
`factory.outcome`, `factory.ticket.key`, `factory.reason`, `factory.pr`,
`factory.cloud_agent.id`, `error.type`.

## How the numbers are computed

**Counters: `counter_inc`, not `increase()` or `rate()`.** Metric temporality
is cumulative, and has to be. July's metric exporters are DELTA unless
`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` says otherwise
(`node_modules/@cursor/july/dist/internal/otel/config.js:173-197`,
`runtime.js:191-206`), and Grafana Cloud's OTLP gateway answers a DELTA sum
with HTTP 400 (`invalid temporality and type combination`; measured
2026-10-14, where a CUMULATIVE sum with the same header was stored), so none
of July's own metrics would ever reach Mimir. The resolver in the factory's
`agent/otel.ts` defaults that variable to `cumulative`, so July's own meter
provider exports `agent_sdk_*`, `cursor_*` and `apj_factory_*` cumulative;
before 0.2.25 the factory registered a meter provider of its own for this.
Stored samples confirm the shape (a series repeats one cumulative value, e.g.
`cursor_token_usage_total{service_name="factory-desk",cursor_token_type="input"}`
= 11965 for 129 consecutive samples). Every export
carries a `service.instance.id` drawn once per process life (the factory adds it to
July's resource: July sets none, `runtime.js:269-284`), and hosted VMs are short-lived: on
2026-10-03 one hour had 45 `apj_factory_delivery_total` series for 52
deliveries. A cumulative series that is born at N is invisible to
`increase()` and `rate()` (they read 7.5 deliveries that hour, and 0 of 4
sessions). `generate.py`'s `inc()` counts a series born inside the window
from zero:

```promql
clamp_min(max_over_time(s[w]) - last_over_time(s[1d] offset w) or max_over_time(s[w]), 0)
```

that is, the series' max in the window minus its last value before the
window, or the max alone when it had none. It is correct over any window, so
per-range stats use `w = $__range`. Per-bucket Prometheus bars use
`w = $__interval` with the panel's min interval at `$bucket` (5m, 15m, 30m,
1h; default 15m) and a one-step negative offset so each point at `t`
covers `(t, t+step]` and the in-progress bucket is included. Grafana
Cloud Mimir accepts that offset (Prometheus ≥ 2.33).
Mimir never caches a negative-offset query, so the 18 per-bucket
Prometheus targets are fully re-evaluated on every refresh (most costly
on a 7d range). Measured wall time for generated `total(apj_factory_delivery_total)`
against ~60 series (Fable r11, live Mimir; 30d 1m is extrapolated):

| range | step | wall | queryable samples | peak samples |
| --- | --- | --- | --- | --- |
| 24h | 1m | 0.12s | 17.1M | 181k |
| 7d | 1m | 0.86s | 118.7M | 1.26M |
| 7d | 5m (`prom_res`) | 0.18s | 24.1M | 254k |
| 30d | 1m | ~3.7s (extrap.) | ~507M | ~5.4M |
| 30d | 5m (`prom_res`) | 0.74s | 101.4M | 1.08M |

The 5m step is the live 7d+/30d setting. 30d at 1m was not run (near
Mimir's 50M `max-samples` on the cost panels); the 30d 1m row is 7d×4.3.
`$prom_res` is a hidden query_result variable (`qryType` 5). `$smooth`
is the same form: 2m below 7d, 5m at 7d+, so the running-max window is
never shorter than the subquery step (a 2m window on a 5m grid would
skip 3 minutes of every 5 and drop short-lived VMs). Grafana Cloud
(13.1+; verified on 13.3.0) substitutes `${__to:date:seconds} -
${__from:date:seconds}` on that form
(`$__range_s` is blank). If the variable has not refreshed, panels use
the JSON current `1m` / `2m`. Now · 15m stats pin `Window.res=1m` so a 7d+
dashboard still counts all 15 minutes.

p95 timeseries panels skip the `$__to` subquery cap (`quantile(..., cap=False)`);
those bars have no range stat to match.
Prometheus look-ahead is a `${prom_res}` subquery (1m below 7d, 5m at
7d+) that keeps only samples with `from ≤ time() ≤ to`. For `_total`
the inner selector is `max_over_time(s[${smooth}])`:

```promql
(max_over_time(s[${smooth}]) and on() (vector(time()) >= ${__from:date:seconds})
   and on() (vector(time()) <= ${__to:date:seconds}))[w:${prom_res}] offset -w
```

The baseline for a straddling first bar is the counter at `$__from`
(`last_over_time(s[1d] @ ${__from:date:seconds})`) only when the bar
timestamp is before `$__from`. An empty lookback at `t ≥ from` stays
empty so a series idle longer than `LOOKBACK` is counted from zero,
not from a stale start-of-range value. `@ ${__to}` on a range query still pins
every sample to the range end, so it is not a cap; the subquery is.
Range stats use the same bounded subquery without the negative offset
(`[$__range:${prom_res}]`) so `resets()` / `increase()` see the same
1m-resampled samples as the bars. A multi-writer series that flips
1/2 at scrape cadence is then a stable value at 1m, not dozens of
fake resets.
Per-bucket look-ahead uses the same reset-safe `inc()` as the range
stats: the exact branch unless `resets(spanned) > 0` on the
`${smooth}`-resampled series, or `min_over_time(raw)` is below the
baseline (a restart on the first sample of the window, which
`resets()` misses because `(t, t+w]` excludes the pre-restart value).
The fallback is `max_over_time` when that is the only drop, else
`increase()` on that same subquery. last<max is not the gate: a
restart whose new life passes the old maximum still dropped.

```promql
((exact) unless resets(spanned) > 0
 or increase(spanned))
```

A live last bar with no reset stays on the exact branch, so
`increase()` does not extrapolate into the unfinished step. A bucket
that did reset takes `increase()` and can leave a fraction (roughly
±10–20%). Loki per-bucket bars use `w = $__auto` and set `step=$bucket`,
with the same `offset -$__auto` (Loki 3.5). `$__auto` is Loki-only:
Grafana's Prometheus backend never substitutes it, and a PromQL target
that still contains `$__auto` fails to parse. On a live range (to = now) the last bar is the in-progress bucket.
On a range that ends before now, the last bar covers its whole bucket
and can include up to one step after the range end only on Loki: LogQL
has no subquery, so a Loki bar cannot be capped at `$__to`. Prometheus
stops that last bar at the last whole `${prom_res}` step at or before
`$__to` (1m below 7d, 5m at 7d+). A range end that is not on that grid
drops those leftover events from both the bars and the range stats
(they still agree). `tools/bucket_look_ahead_check.py` pins
`to=26m30s` as last 10m bar = 1 and range = 4 vs a true 6.
The first bar starts at the first
step boundary at or after the range start on Loki (events between the
range start and that boundary, up to one step, are in the range stats
but in no bar, and the left edge can show a gap). Prometheus keeps the
bar that straddles `$__from` and counts only samples at or after
`$__from`. Quote the range stats.
`tools/bucket_look_ahead_check.py` proves both edges on scratch data
(promtool + optional Loki): live 30m last bar = 16 and total = 23;
fixed 26m last bar capped at `$__to` = 0 (uncapped = 16) and range = 7;
unaligned `from=2m` keeps the bar stamped at 0 = 5 (the pre-`from`
increment is excluded) and total = 28; a reset inside the last bucket
is exact 5 vs reset-safe `increase()` leftover 12.5; a reset on the
bucket edge is 11 with previous-bucket leftover 1.25; a restart on
the first sample of a bucket (aligned, and first inner point after
an unaligned `$__from`) reads `max_over_time` instead of 0; a
15s-interleaved 1/2 series is 2 on the 1m subquery (the series max)
while raw `increase()` counts every flip. Loki stays
uncapped at `$__to` and still drops the straddling first bar.
Bars
count what happened in each bucket; nothing is divided into a per-second
rate, because at tens of deliveries an hour a rate line is mostly spikes. A
series whose last sample before the window is older than the 1-day lookback
(`LOOKBACK`) is counted from zero, which only a VM idle for over a day and
then active again would hit. `clamp_min` floors a negative exact branch
at 0; a restart on the first sample of the window is not left at 0, it
is recovered by `min_over_time < baseline` taking `max_over_time`.

Discrete counts (deliveries, sessions, turns, tool calls, failures, KV
failures, delivery ids) display as whole numbers (`decimals: 0`). Count
**bar legends** also `round()` each bucket before the `sum` calc.
Rounding keeps the legend a whole number on the exact branch. A
Prometheus legend matches the range stat within `increase()` leftover
on a bucket that reset, and that rounding. A Loki legend can still
differ: up to one step at the start, and up to one step past a range
that ends before now. Range stats use the same reset fallback, where
`increase()` can leave a fraction.
Rates,
percentages, costs and durations keep their own decimals. Token totals
leave decimals unset so Grafana's short-unit auto scale still reads
`176 K`, not a forced `176.47 K`.

Prometheus per-bucket **cost and token** legends match the range stats
within rounding and `increase()` leftover on a bucket that reset: the
last bar is the in-progress bucket on a live range, and is capped at
`$__to` when the range ends before now; the first bar that straddles
`$__from` is kept and counts only in-range samples. The range stats and
the per-slug table are the figures to quote; after a restart the bar
sum is the better figure. The bar panels say so. The
cumulative cost line drops zero buckets (`> 0`) and `spanNulls`
connects the rest, so an idle range shows "none". The last point starts within one step of now
(the step is `$bucket`; Prometheus widens it on long ranges) and covers
the in-progress bucket. Quote the range stat, not the line's last value.

**Prometheus counts are approximate.** They can be off in either direction
wherever a restore shares or carries state:

- **Shared id: low.** The 2026-10-03 coverage audit found hosted restores
  reusing one `service.instance.id` across separate requests. A VM restored
  from a snapshot taken after its id was drawn writes the same series again,
  starting from the snapshot's value, so the earlier life's increments are
  lost. One desk VM's input tokens decompose exactly into two lives, and the
  metric kept only the second (49% short of the `turn.completed` logs).
- **One id per process life, no rebase.** The factory draws
  `service.instance.id` at the first export with the header set (a deploy
  snapshot is taken before any secret binds, so none is in it), from a fresh
  kernel read with the clocks and pid (`factory-otel.ts` `lifeId`), and
  there is no per-life rebase (earlier versions subtracted the old life's
  totals, `factory-otel-rebase.ts`, removed). A new life's series therefore
  starts at that life's own totals, which is what `counter_inc` assumes,
  because no instrument records a value before the first request: nothing is
  touched at startup, and the funnel's bind adds 0). If a restore
  ever did carry nonzero totals, the new life would be overstated by them, and
  `counter_inc` counts a series born inside the window from zero (the "max
  alone" branch): a `promtool` run, life 1 growing from 1 to 10 and a
  restored life starting at 10 and growing to 12, returns 22 for a true 12.
- **What is lost.** A pod frozen or replaced before its next 10 s export loses
  that interval unless July's flush ran: July flushes its trace, meter and log
  providers after each hosted admission and execution, at most 1 s, after the
  execution's own `agent_sdk.hosted_execution.duration_ms` and
  `agent_sdk.http.duration` are recorded, so the loss is limited to work a
  handler detaches from `waitUntil`, and exports that fail or exceed the 1 s
  bound (`runtime.js:27,44,96-117`; `docs/july-otel-upstream.md` section 12).

PromQL cannot tell a restored life from a fresh VM first exported at N, so
no query can correct what a restore carries. The dashboard and panel
descriptions say why the counts are approximate, and Factory ops carries Loki
cross-checks (Debug: deliveries by kind and outcome), which
neither error touches and which are the reference: distinct `deliveryId` values (July's `[bdk]` admission
lines and the factory lines that carry one), per slug and per `eventType`,
beside the factory event lines. The three count different things, so read
them for agreement in shape. The same restores leave two writers on some
histogram series (a `_sum` that falls while `_count` stays), so no panel
shows a `_sum`/`_count` mean, and the quantiles are noisy.

Aggregation across instances always happens after `counter_inc`
(`sum by (service_name, ...) (counter_inc(...))`), never on the raw per-VM
series, and no query uses `sum_over_time` on a counter.

- **If a host ever exports DELTA**, its samples are increments: count them
  with `sum_over_time(series[window])` instead of `counter_inc`.
- **If one `service.instance.id` ever outlives a process** (a host that
  keeps one id across restarts; the factory draws one per life), one series
  spans several processes, and a restart resets its cumulative value inside
  the window. `counter_inc` therefore counts a
  `_total` counter with `resets() > 0` in the window, or `min_over_time`
  below the baseline, with `max_over_time` when that is the only drop and
  `increase()` otherwise; every
  other series keeps the exact branch above. That `increase()` fallback is approximate
  for a series that resets inside the window: `increase()` extrapolates, so
  expect roughly ±10–20% (a `promtool` run gave 3.33 and 4.44 for a true 4,
  and 3.33 for a true 6 when the series was also born inside the window). A
  restart whose first export is above the last pre-restart value shows no
  drop, so it cannot be detected at all, and that series is undercounted. The audit found every `_total` counter monotonic, so
  today every count takes the exact branch unless two writers share a
  series and flip it. Per-bucket look-ahead panels
  and the range stats use the same form on the `${prom_res}` subquery: exact unless that window dropped
  (`resets > 0` on the `${smooth}` series, or a first-sample restart),
  then `max_over_time` or `increase()`. Histogram parts (`_bucket`,
  `_sum`, `_count`) never take the fallback: their drops are two writers, not
  restarts, and `increase()` would count each one as a reset.

  ```promql
  ((exact) unless (resets(s[w]) > 0)
   or increase(s[w]))
  ```

  Per-range windows (no look-ahead) add one more branch before that
  fallback: a restart on the window's first sample (`resets(raw) == 1`
  with `min_over_time` below the baseline, and no later drop on the
  smoothed series) takes `increase()` of the raw series, so a restart at
  the left edge of the range is estimated instead of dropped.

**Subquery cost.** Each subquery evaluates about `range / ${prom_res}`
inner steps per series. At 1m that is ~10k at 7d and 43 200 at 30d; at
5m, 8 640 at 30d. The cost panels name the subquery about 7 times per
token-kind `inc()` (5 kinds), so a 30d query with ~20 series is about
30M inner points at 1m (near Mimir's 50M `max-samples`) and about 6M
at 5m. Negative-offset queries are not cached. `$prom_res` switches to
5m at 7d+, which only loosens the `$__to` cap to 5m on those ranges.
Measured peakSamples (Fable r11, ~60 series): 181k at 24h/1m, 254k at
7d/5m, 1.08M at 30d/5m. 30d/1m is extrapolated ~5.4M.

**Zero vs no data.** Counts use `... or vector(0)` and show 0 when nothing
happened. Ratios and per-turn or per-session stats divide by `(all > 0)`
(`per_unit` in `generate.py`): 0 with traffic and no errors, and "no
traffic" both when a series is absent and when one is present but never
incremented in range, which would otherwise be `0 / 0` (`NaN`) or `x / 0`
(`+Inf`). Latency quantiles are filtered to `>= 0` (`quantile` in
`generate.py`), because buckets present in range that never incremented
are all 0 and `histogram_quantile` of those is `NaN`; the comparison drops
it, so latency shows "no traffic" too. None shows a misleading 0.
`tools/promtool_ratio_check.py` runs the guards through `promtool` for a
busy, a quiet and an absent slug.

**Outcomes.** `factory.outcome` values come from the factory code
(`traceFactory`'s `ok` and `error`, `describeResponse`, `describeDispatch`,
and every host's `describe` / `noteFactory`). Errors: `error`, `http_5..`,
`bad_args`, `failed`, `*_failed`, `threw`, `*_threw`, `config_error`,
`launch_timeout`, `unauthorized`, `*_unreadable`, `unavailable`,
`claim_unavailable`, `gave_up`. No-ops: `http_4..`, `ignored`,
`ignored_comment`, `duplicate`, `deduped`, `skipped`, `skip`, `stop`,
`not_launched`, `not_started`, `not_posted`, `not_armed`, `not_moved`,
`not_watched`, `refused`, `staging_refused`, `superseded`, `in_flight`,
`no_run`, `no_brief`, `no_branch`, `action_skipped`, `none`, `idle`.
Handoff (in-flight, not success and not a no-op): `task`, `turn`,
`dispatched`, `launching`, `started`, `accepted`, `opened`, `reused`,
`swept`, `cleared`, `armed`, `throttled`, `approved`, `announced`,
`redelivered`, `sent_to_planner`, `jev_only`, `already_approved`.
The lists are `OUTCOME_ERRORS`, `OUTCOME_NOOPS`, `OUTCOME_OK` and
`OUTCOME_HANDOFF` in `generate.py`; add a new outcome there. An
unknown outcome is the `other` class (grey).

**Latency.** The headline ack stats are the `factory.delivery` span only (the
handler up to its reply; target under 3 s, red at 10 s); background work,
reminders and launches run seconds to minutes and are split out under
Latency. Quantiles interpolate inside histogram buckets, so at low volume a
p95 reads as "at most that bucket's edge". The
factory sets explicit buckets for `apj_factory.delivery.duration` (50 ms
to 300 s, `DELIVERY_DURATION_BUCKETS_MS` in `agent/lib/factory-otel.ts`) as
histogram advice at creation. July sets no advice on
`agent_sdk.hosted_execution.duration_ms` and has no View hook, so it has the
OTel default buckets (`0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500,
5000, 7500, 10000`, then `+Inf`), and a real turn lands in `+Inf`: the Exec
histogram cannot read past 10 s. The Hosted execution p95 line and the Exec
duration heatmap therefore read Tempo span durations instead (see Latency
heatmap below); no panel reads that histogram's quantiles. Until 0.2.25 a factory View gave
it 100 ms to 30 min; series from VMs that still ran it (no 7500 bucket) keep
that layout until they age out of the look-back. Changing
`le` values mints new series; `histogram_quantile` over a window that
mixes both layouts is invalid. `_sum` / `_count` keep their names but
are already unused (two-writer noise). An OTLP exponential histogram
would land as a Prometheus native histogram (no `_bucket` / `le`), so
the existing panel would stay empty.

**Tokens.** July's collector adds `cursor.token.usage` once per type from the
hosted runtime's usage, which July passes through unchanged from
`@cursor/sdk` (July 0.2.25 `dist/internal/sdk-runner.js:783-799`, summed per step in
`event-mapper.js:146-147`).

- **Two input shapes.** `input` on `cursor_token_usage_total` means two
  things, and no label on the metric says which (July's metrics are not
  ours to change):
  - A **host (local) turn** (desk, triage, the planner before #227)
    reports provider-gross input: cache reads are inside it. July's
    `toCatalogDisjointUsage` (0.2.25 `dist/internal/estimate-cost.js:30-35`; it
    was `turn-cost.js` in 0.2.18) treats OpenAI-compatible usage (Grok,
    xAI, GPT, o-series) that way and sends `input − cache` before pricing. Live
    `agent_sdk.turn` spans on 2026-10-03 agree (input 40,818 with cache
    read 38,336; input 26,970 with cache read 18,176; cache read never
    above input, up to 94% of it), as do TLSSN-59's planner turn (input
    1,575,134, cache read 1,355,648) and TLSSN-60's desk (input 41,977,
    cache read 39,296, output 890).
  - A **cloud turn** (the planner since #227, the worker's July cloud
    turn since #229) reports input net of cache reads: TLSSN-60's planner
    turn (one cloud turn) had input 187,541, cache read 1,191,168, output
    29,543, and July billed it 1.127171 USD.

  So uncached input is decided **per series, before any sum**, with the
  test July itself applies in `toCatalogDisjointUsage` (0.2.25
  `estimate-cost.js:35`: when `inputTokens < cacheRead + cacheWrite` the usage
  is already disjoint, otherwise subtract; July applies it to OpenAI-compatible
  models only, the dashboards to every series): pair each `input`
  series with the `cache_read` series of the same labels but
  `cursor_token_type` (`sum without (cursor_token_type)` on each, then
  one-to-one matching), and
  - gross shape (`cache_read <= input`): uncached = input − cache_read;
  - net shape (`cache_read > input`): uncached = input;
  - no `cache_read` series: uncached = input;

  then sum by the panel's grouping (`factory_ticket_key`, `service_name`,
  or none). In PromQL, writing `I` and `C` for the two per-series
  counter_inc sums: `sum by (…) (I - ((C <= I) or 0 * I))`. `C <= I`
  keeps the cache-read value only on gross-shaped series (a comparison
  between vectors filters and returns the left side), and `or 0 * I`
  fills the net-shaped and cache-less series with 0, so nothing is
  subtracted there. The result is never negative, so there is no clamp.
  The form before this summed every host's series first and then took
  `clamp_min(input − cache_read, 0)`: a cloud-shaped series priced its
  input at $0 (TLSSN-60's planner: 187,541 × $4/M, about $0.75, missing),
  and a ticket that mixed shapes netted its gross desk series against its
  net planner series (`tools/promtool_shape_check.py` shows TLSSN-60 at
  1.595660 the old way and 2.356548 per series: planner 2.295848 + desk
  0.060700). Residual risks, accepted: a cloud-shaped series whose input
  happens to be ≥ its cache reads is read as gross and undercounted by
  its cache reads; one (process life, session, ticket) series that mixes local and cloud
  turns is classified as a whole (July labels every sample with the session
  id, so the pairing is per session). The panels remain estimates priced with
  the `$price_*` variables.
- **Reasoning is inside output.** `@cursor/sdk` 1.0.37 (the version July
  0.2.25 pins) documents `TokenUsage` as
  "`totalTokens` excludes `reasoningTokens` (a subset of output)"
  (`dist/esm/usage-types.d.ts:41`),
  and the live turn with reasoning 340 had output 519. So reasoning is shown
  but never added and has no price of its own.

So total tokens = input + output (the gross prompt on a host turn, the
net-of-cache prompt on a cloud turn), uncached input is the per-series
figure above, and **Cache %** is the share of the prompt served from
cache: `cache_read / (uncached_input + cache_read)`, both sides per-series
sums, so a gross host series and a net cloud series each count their
prompt once and the result is 0–100% by construction (`clamp_max(…, 1)` is
only a belt). The earlier `cache_read / input` read 435% on 2026-10-05:
the planner's and worker's cloud turns report input net of cache reads
(input ≈ 10–20k against ~1.5M cache reads per ticket), so cache reads
exceeded input. Expect 85–95% on a range of e2e tickets. The Traces per-turn table fills a missing cache-read
attribute with 0 before subtracting (Grafana's binary transform would
otherwise show NaN), floored at 0: the gross rule only,
since a Grafana transform has no per-row branch, so a cloud turn's row
reads 0 there and its description says so.

**Cost estimate.** July 0.2.25 emits no cost metric and no model label (Known
gaps), so cost is an estimate (USD per 1M tokens from the dashboard's price
variables):

```text
uncached_input × price_input + cache_read × price_cache_read
  + output × price_output (+ reasoning × price_reasoning, default 0)
```

where `uncached_input` is decided per series as above (input − cache_read on
a gross series, the whole input on a net or cache-less one). The query is
those four terms, each counted with `counter_inc` per series and summed per
slug. Defaults are Cursor's list price
for Grok 4.6 Fast, the desk's and triage's model
([cursor.com/docs/models-and-pricing](https://cursor.com/docs/models-and-pricing),
retrieved 2026-10-03): `price_input` 4, `price_cache_read` 1, `price_output`
12, and `price_reasoning` 0, because reasoning is already inside output (set
it to the output price only for a provider whose usage reports reasoning
outside output). The planner, worker, fixer and
reviewer run Cursor Auto (`auto-smart`, balanced), which bills at the list
price of whatever model each request is routed to (Grok 4.6: $2 / $0.50 / $6;
Claude Opus 5.5: $4 / $0.20 / $20). Neither Auto routing nor the Cursor Token
Rate for third-party models is modelled; one price set applies to every
slug. Price variables are hidden on both dashboards; set
`var-price_input=…` (and the other `price_*` keys) in the URL or
Settings → Variables.
The Business "Economics (estimate)" and Ops "Cost (estimate)" row titles say
`(estimate)` once; panel titles do not repeat `est.`, except Simon's **Cost
per ticket (est.)** and the Business strip tiles (Spend, Cost / merged,
Cost / filed, Cumulative spend), which sit outside those rows.
The full caveat lives in each panel's description and once on the
Business dashboard description. Do not write `Estimated cost (estimate)`.

**Cost per ticket (estimate).** The same four terms, the same prices and
the same cached-input handling, over the same `cursor_token_usage_total`,
grouped by `factory_ticket_key` instead of `service_name`: a ticket's row
sums every host that worked on it (desk, planner, fixer, reviewer), so the
per-ticket selectors carry no `service_name` matcher and the `$service`
filter does not apply. Uncached input is decided per series (Two input
shapes, above) before the per-ticket sum: a ticket worked on by a gross
desk series and a net planner series prices each on its own shape, and
cache reads are priced once at `price_cache_read`, so nothing is
double-counted or netted away.
The **Cost per ticket (est.)** chart on Factory ops reads these
queries (mean over merged tickets, 7d cost lookback, below);
`generate.py`'s `cost_per_ticket()` produces exactly the expanded query
below, and `scripts/grafana-dashboards.test.mjs` fails if this file's
expanded blocks and the generator ever differ. Writing `inc(s)` for the
`counter_inc` recipe above, per series, over `$__range`, `T` for
`cursor_token_usage_total{service_namespace="software-factory"}`, and
`per(k)` for `sum without (cursor_token_type) (inc(T{cursor_token_type="k"}))`
(one value per series, the type label dropped so input and cache_read
match one-to-one):

```promql
sum by (factory_ticket_key) (
    label_replace(
        sum by (factory_ticket_key) (per(input) - ((per(cache_read) <= per(input)) or 0 * per(input)))
      * $price_input, "part", "uncached_input", "", "")
  or label_replace(sum by (factory_ticket_key) (inc(T{cursor_token_type="cache_read"})) * $price_cache_read, "part", "cache_read", "", "")
  or label_replace(sum by (factory_ticket_key) (inc(T{cursor_token_type="output"})) * $price_output, "part", "output", "", "")
  or label_replace(sum by (factory_ticket_key) (inc(T{cursor_token_type="reasoning"})) * $price_reasoning, "part", "reasoning", "", "")
) / 1e6
```

where, for a `_total` series `s`,

```promql
inc(s) = (clamp_min(max_over_time(s[$__range]) - last_over_time(s[1d] offset $__range) or max_over_time(s[$__range]), 0))
           unless (resets(s[$__range]) > 0) or increase(s[$__range])
```

One row per ticket in range, USD; `factory_ticket_key="none"` is the
unattributed remainder (desk intake before a ticket exists, PRs with no key,
the kv and PR-read fallbacks in the table above) and `other` a pin that is
not a Jira key. Add `factory_ticket_key!~"none|other|"` to every selector
to keep Jira keys only (the trailing `|` also drops the unlabelled row,
below), or `factory_ticket_key="$ticket"` for one ticket.

Summed over every key, including `none`, `other` and the unlabelled row,
the result is close to, not equal to, the per-slug estimate over the same
range. Both read the same samples and both decide uncached input on the
same per-series rule, so the shape test itself no longer differs between
them; but the
counter-born-in-range fallback and the restart branch of `inc()` are taken
per series, and a (slug, ticket, type) series and a (slug, type) series are
born and reset at different moments (the per-slug series existed before
the label and did not reset when a ticket's first series was born, and a
host restart resets every series of that host at once, but a ticket's
series on another host not); and before this change the samples carried no
key, so a range that reaches back past the deploy has those samples in the
unlabelled row (`sum by (factory_ticket_key)` puts them there). Expect the
two to agree to within those effects, not to the cent.

*Est. cost per merged ticket* is each merged ticket's own cost: the
per-ticket estimate divided, key by key, by the tickets the worker moved to
Done on a merged PR in the same range (`apj_factory_ticket_merged_total`:
one increment per ticket, the first time the worker moves it to Done, kept
truly first-time by a `ticket-merged/<KEY>` kv marker, so a ticket reopened
and merged again by a second PR, or a replayed merge delivery, does not
count again). `merged_tickets()` counts a key as merged in the window when
EITHER its counter increased in it OR its series first appeared in it:
every ticket key is a new series the worker creates at 1, and
`increase()`/`rate()` cannot see a series' first sample (there is no
earlier point to diff against), so an increase-only denominator is empty
for every first-time merge — on live data that was every merged ticket.
The first-appearance arm is `last_over_time(m[w]) unless last_over_time(m[1d]
offset w)`: present in the window, absent in the day before it. The marker
is also not airtight the other way: a kv that cannot be read counts rather
than miss a ticket, and two deliveries can race read-then-put, so a
ticket's series can increment twice. Dividing by the raw increment would
then show that ticket at half its cost, and the mean would inherit it; so
each key's row is pinned to exactly 1 (`* 0 + 1`), a ticket merged or not,
and a double count changes nothing. `generate.py`'s
`cost_per_merged_ticket()`, writing `M` for
`apj_factory_ticket_merged_total{service_namespace="software-factory",
factory_ticket_key!~"none|other|"}` (every host, no `$service`):

```promql
  <the per-ticket estimate above>
/ on (factory_ticket_key)
  ((( max by (factory_ticket_key) (increase(M[$__range])) > 0
    ) or (
      max by (factory_ticket_key) (last_over_time(M[$__range]))
        unless max by (factory_ticket_key) (last_over_time(M[1d] offset $__range))
    )) * 0 + 1)
```

That row set is the tickets that merged in range, each valued 1 and each
with its own cost; `none`, `other`, the unlabelled row and a ticket not
merged in range have no denominator row and drop out. A ticket's cost spent before the range
(planning days earlier) is not in it, so for a per-ticket lifetime figure
pass `cost_window=` (the numerator's window widens while the merge window
stays put: the panel uses a 7d cost window against a 24h or 6h merge
window) or widen the range. The merged counter is the worker's, but the
per-ticket queries read every host, so the `$service` filter changes
nothing here.

For one number there are two, and they differ:

- *Mean cost per merged ticket* (`mean_cost_per_merged_ticket()`), the
  true mean over the tickets merged in range, each weighted once:
  `avg(<est. cost per merged ticket>)`.
- *Keyed cost over merged tickets* (`keyed_cost_per_merged_ticket()`): every
  Jira-keyed ticket's cost in range, merged or not, over the number of
  tickets merged in range (the pinned rows summed: tickets, not
  increments). The numerator holds tickets still in flight, so
  this is the range's keyed spend per merge, not a mean:
  `sum(<per-ticket estimate, factory_ticket_key!~"none|other|">) /
  (sum(<merged tickets in range>) > 0)`.

`tools/promtool_ticket_check.py` runs all five queries, plus the panel's
widened `cost_window` pair, through `promtool test rules` over one range
holding every shape they must handle: a ticket with everything and a
counter increment, one new in range with no cache reads (the `or 0 *` path
and the `or max_over_time` fallback), one counted from a non-zero value
before the range with a flat cache-read series and merged before the range
(present and flat through the window: neither arm counts it), one merged
in range but counted twice by the worker (the `* 0 + 1` pin: its cost
stays whole and it is one ticket in the keyed denominator), one whose
merged series is born inside the window already at 1 (the first-appearance
arm: increase() alone would miss it) with cost accrued on two hosts before
the merge window (0.00 with the narrow cost window, the full 3.00 with the
widened one), `none`, `other` with a merged count, and an unlabelled
series. There the mean is 3.00 over three merges and the keyed figure
3.80; without the pin the double-counted ticket would show at half its
cost (mean 2.67, keyed 2.85). `scripts/grafana-dashboards.test.mjs` runs it
when `PROMTOOL` names a binary.

`tools/promtool_shape_check.py` proves the per-series uncached rule the
same way, against the form the dashboards used before (every host summed
first, then `clamp_min(input − cache_read, 0)`, built in the test as
`legacy_*`): TLSSN-60 with its live numbers (a gross desk series on pod
`desk-a` and one net planner cloud turn on `planner-a`, merged in range)
prices 2.356548 (planner 2.295848 + desk 0.060700) where the old form read
1.595660; a net planner series whose host restarts mid-range (every series
resets at once; `inc()` takes `increase()`, exact here because each life
starts at 0) prices 1.62 against 0.98; a gross-only ticket (4.00) and a
ticket with no `cache_read` series (1.60) read the same under both; and one
slug with a gross pod and a net pod on one ticket prices 1.38 per series
against 0.78 summed first (`sum without (cursor_token_type)` keeps the pods
apart). The per-slug estimate, the factory-wide capped estimate (Spend)
and the uncached-input term are checked on the same series.

The full expansions, as a panel takes them (these five blocks are checked
against the generator and, for the two panel refs, against
`factory-ops.json`):

<details>
<summary>Est. cost per ticket, expanded (<code>cost_per_ticket()</code>)</summary>

```promql
sum by (factory_ticket_key) (label_replace(sum by (factory_ticket_key) (sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]))) - ((sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]))) <= sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range])))) or 0 * sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]))))) * $price_input, "part", "uncached_input", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]))) * $price_cache_read, "part", "cache_read", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]))) * $price_output, "part", "output", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]))) * $price_reasoning, "part", "reasoning", "", "")) / 1e6
```

</details>

<details>
<summary>Est. cost per merged ticket, expanded (<code>cost_per_merged_ticket()</code>)</summary>

```promql
(sum by (factory_ticket_key) (label_replace(sum by (factory_ticket_key) (sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]))) - ((sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]))) <= sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range])))) or 0 * sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]))))) * $price_input, "part", "uncached_input", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]))) * $price_cache_read, "part", "cache_read", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]))) * $price_output, "part", "output", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]))) * $price_reasoning, "part", "reasoning", "", "")) / 1e6) / on (factory_ticket_key) ((((max by (factory_ticket_key) (increase(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[$__range])) > 0) or (max by (factory_ticket_key) (last_over_time(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[$__range])) unless max by (factory_ticket_key) (last_over_time(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[1d] offset $__range)))) * 0 + 1))
```

</details>

<details>
<summary>Mean cost per merged ticket, expanded (<code>mean_cost_per_merged_ticket()</code>)</summary>

```promql
avg((sum by (factory_ticket_key) (label_replace(sum by (factory_ticket_key) (sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]))) - ((sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]))) <= sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range])))) or 0 * sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[$__range]))))) * $price_input, "part", "uncached_input", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[$__range]))) * $price_cache_read, "part", "cache_read", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[$__range]))) * $price_output, "part", "output", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[1d] offset $__range) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[$__range]))) * $price_reasoning, "part", "reasoning", "", "")) / 1e6) / on (factory_ticket_key) ((((max by (factory_ticket_key) (increase(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[$__range])) > 0) or (max by (factory_ticket_key) (last_over_time(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[$__range])) unless max by (factory_ticket_key) (last_over_time(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[1d] offset $__range)))) * 0 + 1)))
```

</details>

<details>
<summary>Cost per ticket (est.) panel, ref A: per 6h bucket, 7d cost lookback (<code>mean_cost_per_merged_ticket(BUCKET_MERGE, cost_window=COST_LOOKBACK)</code>)</summary>

The operator's long-hand copy (`cost-per-ticket-final.promql`, ref A): `avg` over the tickets merged in each 6h bucket of their own 7d cost. Checked against `factory-ops.json`.

```promql
avg((sum by (factory_ticket_key) (label_replace(sum by (factory_ticket_key) (sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]))) - ((sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]))) <= sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d])))) or 0 * sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]))))) * $price_input, "part", "uncached_input", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]))) * $price_cache_read, "part", "cache_read", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[7d]))) * $price_output, "part", "output", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[7d]))) * $price_reasoning, "part", "reasoning", "", "")) / 1e6) / on (factory_ticket_key) ((((max by (factory_ticket_key) (increase(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[6h])) > 0) or (max by (factory_ticket_key) (last_over_time(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[6h])) unless max by (factory_ticket_key) (last_over_time(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[1d] offset 6h)))) * 0 + 1)))
```

</details>

<details>
<summary>Cost per ticket (est.) panel, ref B: trailing 24h merges, 7d cost lookback (<code>mean_cost_per_merged_ticket(ROLLING, cost_window=COST_LOOKBACK)</code>)</summary>

The operator's long-hand copy (`cost-per-ticket-final.promql`, ref B): the same mean over the tickets merged in the trailing 24h. Checked against `factory-ops.json`.

```promql
avg((sum by (factory_ticket_key) (label_replace(sum by (factory_ticket_key) (sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]))) - ((sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]))) <= sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d])))) or 0 * sum without (cursor_token_type) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="input"}[7d]))))) * $price_input, "part", "uncached_input", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="cache_read"}[7d]))) * $price_cache_read, "part", "cache_read", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="output"}[7d]))) * $price_output, "part", "output", "", "") or label_replace(sum by (factory_ticket_key) (((clamp_min(max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[7d]) - last_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[1d] offset 7d) or max_over_time(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[7d]), 0)) unless (resets(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[7d]) > 0) or increase(cursor_token_usage_total{service_namespace="software-factory", cursor_token_type="reasoning"}[7d]))) * $price_reasoning, "part", "reasoning", "", "")) / 1e6) / on (factory_ticket_key) ((((max by (factory_ticket_key) (increase(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[1d])) > 0) or (max by (factory_ticket_key) (last_over_time(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[1d])) unless max by (factory_ticket_key) (last_over_time(apj_factory_ticket_merged_total{service_namespace="software-factory", factory_ticket_key!~"none|other|"}[1d] offset 1d)))) * 0 + 1)))
```

</details>

**Cardinality.** The factory's MeterProvider has no label allowlist, so every
attribute set July records is a series, and July labels each sample with the
session and conversation id and the session's tag bag. The SDK's default limit
applies, 2000 attribute sets per instrument per process life under a cumulative
reader (the 2000th and later sets are added to one series labelled only
`otel_metric_overflow="true"`). A hosted process serves few sessions, and the
panels sum over those labels, so the dashboards are right either way; the cost
is series in Mimir, about sessions × ticket × type, per process life. Per
instrument:

| Instrument | Series per session | Note |
| --- | --- | --- |
| `cursor_token_usage_total` | 2 to 4 token types (`input` and `output` always, `cache_read` when the model cached, `reasoning` when it reports reasoning) | the cost panels sum these |
| `agent_sdk_turn_count_total` | one per `agent_sdk_turn_status` (`completed`, `failed`, `usage_limit`, `unpaid_invoice`) | the turn panels |
| `cursor_tool_calls_total` | one per (tool, kind, status): some 20 tools × 2 statuses, 40 to 60 | the largest family: the 2000 limit is reached by some 35 to 50 sessions in one process life |
| `apj_factory_ticket_merged_total` | 1 per ticket (no session id: the factory's own counter) | the worker only |
| `apj_factory_delivery*`, `agent_sdk_hosted_execution_*`, `agent_sdk_http_duration_*` | the factory's and July's own label sets; July's add the session id where it stamps it | the latency and volume panels |

If `cursor_token_usage_total{otel_metric_overflow="true"}` (or any other
instrument's) is ever non-empty, a process life passed the limit: its tokens
are in that series with no ticket, no type and no agent, a `sum` over every key
still reconciles with the per-slug figure, and the per-ticket table lacks those
turns. That is the signal to ask July for an attribute allowlist (it has no View hook).
Query those selectors after a deploy; they should be
empty.

**Links.** Jira and dashboard links are field data links on the ticket
column, and only when the cell has a value (empty, `nil` and `-` stay
plain, so they are not a blue hyphen). A PR value `owner/repo#n` cannot be
linked as is: on Loki, `label_format pr_path=` rewrites `#` to `/pull/` and
the link is `https://github.com/${__data.fields.pr_path}`; on Tempo, an
Extract fields (RegExp) transform splits it into hidden `pr_repo` and
`pr_number` fields. Trace ids in logs use an internal link to the Tempo
datasource; Tempo's own Span ID column opens the trace (it reads the
hidden `traceIdHidden` field; that field stays in the frame). Tables
that name columns in their description are full width and keep those
columns. Hide Trace ID, fields that are constant on the query, and
fields the description doesn't name when another table already shows
them. Duration and Span ID sit immediately after Span (`minWidth` 80 /
110) so the trace link is on-screen at 1280; Kind is a 195 px floor and
Span is 190. Count is an 80 px width and Cost a 90 px
width. Overview Kind is a 195 px floor (Outcome 90) so Count
fits at 1280; Span is dropped from the deliveries table. Event tables
fix Time (165, full `YYYY-MM-DD HH:mm:ss`), Service (190), Ticket (85)
and Outcome (110) and give Event / Reason / PR / Trace a `minWidth` so
they grow. Ticket journey tables are full width (24 cols) and hide the
repeated Ticket column. Recent factory spans hides Cloud agent, Reason
and Span ID; PR is a 170 px floor. Cloud agent launches keeps Cloud
agent at 320 px (Span, Kind, PR and Ticket hidden). Slow HTTP hides
Path, Kind, PR and Span ID so Ticket (90) fits. Per-turn token headers
are short (`Input (gross)`, `Cache read`, `Uncached`, `Output`,
`Reasoning`) and right-aligned. Visible columns are fixed
`custom.width` or elastic `custom.minWidth` floors; their sum
must fit `WIDTH_BUDGET_1280` (w=8 → 362, w=12 → 555, w=24 → 1140,
measured on the live 1280 px grid);
`tools/layout_check.py` also gates stat-title, header, and cell-content
fit at 1280 / 1600 / 1920, and a whole-dashboard crash ("An unexpected
error happened") in `--renders`.
Empty Tempo/Loki tables use `merge` then `filterFields` (include fields
whose `count` is greater than 0; `filterFields` is a hidden transformer
from Grafana 13.1, the documented floor) so a zero-row frame is dropped and
`noValue` renders ("Pick a ticket" / "Nothing in range" / "✓ None — good").
Grafana 12.2 OSS does not register `filterFields` and throws a React page
error on those empty tables; these dashboards require Grafana 13.1+.

**Transform gotcha: a byValue guard before a `groupBy`.** `filterFields`
with a `byValue` matcher runs Grafana's `reduceField()`, which caches the
whole-column calcs it computes in `field.state.calcs`. `groupBy` later
reduces a copy of each field that still carries that cache, so every
group reads the whole column's `max` / `last`. Replayed on `@grafana/data`
13.2.3 against the live Tempo response (2026-10-05): with the guard inserted
right after `merge`, **Stuck tickets** and both **Recent tickets** tables
listed TLSSN-57…63 all as Triaged since 00:35:41Z (the newest span overall,
TLSSN-63's in_review); without it each ticket had its own latest stage
(57 in_progress, 58 in_progress, 59–61 in_review, 62 in_progress, 63
in_review). `sortBy`, `merge`, `filterFieldsByName` and `limit` do not clear
the cache (`filterByValue` happens to, because it builds new fields).
`calculateField reduceRow` reduces a synthetic row field and is unaffected;
`reduce` reads the same fields and is kept out of the chain too. Rule: the
guard is only ever the trailing step `table()` appends, and never before a
`groupBy` or `reduce` in the same panel; `generate.py --check`
(`guard_before_reducer_findings`) and the node tests fail on one. An empty
Tempo or Loki search still ends as a frame with no fields after the grouping,
so the trailing guard alone keeps the `noValue` sentence. The
per-service cost panel is a bar gauge in slug colours, sorted by cost,
24×8 with all six slugs always listed (an idle slug is a 0 bar). The
tokens-by-service table lists all six slugs too: an idle slug is a 0
row, not a dropped one.

**Per-VM volume.** `agent_sdk_http_duration_milliseconds_bucket` is 61.5% of
the factory's Prometheus series (16 `le` buckets per route, status and method,
per VM). Every panel sums it across instances (`sum by (le, service_name)`
or coarser); none breaks it down per instance, and the tests fail on any
`by (... instance ...)` or `service_instance_id` grouping.

## Ticket stages, the Loki milestones and the v2 / v4 visuals

Jira is the factory's bus, so a ticket's stage is its Jira status. The
desk announces every status a ticket enters into the ticket's Slack
thread, inside a `factory.background` span named by kind
`jira.announce.<status>` and tagged `factory.ticket.key`
(`factory-desk/agent/channels/jira.ts`, `lib/status-event.ts`). Every
stage is the desk's, so the stage panels ignore **Service**.

| Stage | Telemetry |
| --- | --- |
| filed | `jira.announce.triaged` (a desk-filed ticket is moved to Triaged at filing; a Jira-filed one after triage-jira) |
| planned | `jira.announce.planned` |
| approved | `jira.announce.approved` (the person's go-ahead; its own stage because it is the human gate) |
| building | `jira.announce.in_progress` (the worker launched the cloud agent) |
| PR opened | `jira.announce.in_review` (the worker opened the PR) |
| merged | `jira.announce.done` (the worker moves a ticket to Done only for a person's merge) |

**Announce spans are lossy (v3).** In the 2026-10-05 audit (last 24h)
Tempo held 18 announce spans but TLSSN-60 planned + in_progress, TLSSN-61
in_progress and TLSSN-62 planned + in_review were missing (TLSSN-57/58
in_review earlier): the v2 funnel read PR opened 3 (4 tickets had), the
timeline showed TLSSN-62 still building, the dwell table counted planned =
2 and PR opened = 0. v4 therefore cut the funnel, the stage timeline, the
stage-changes chart and the dwell table, and reads every headline flow
figure from the hosts' own JSON console lines, one per milestone
(`{"planner":"turn_started",…}`, `{"desk":"plan_start_watch",…}`,
`{"desk":"reaction","verb":"approve","target":"plan",…}`,
`{"worker":"decision","outcome":"launched",…}`,
`{"worker":"implement_pr",…,"outcome":"opened","pr":"owner/repo#n"}`,
`{"worker":"pr_status","stage":"in_review"|"done","outcome":"moved","pr":…}`,
`{"desk":"review_update","posted":true,"changeReview":…}`,
`{"fixer":"bugbot_round","pr":…,"outcome":"drive"}`,
`{"fixer":"bugbot_wake","pr":…,"outcome":"fresh_drive"}`; field names
from `factory-desk/agent/lib/hop-watch.ts`, `reaction-approval.ts`,
`approve-command.ts`, `review-announce.ts`, `planner/agent/hooks/plan-outcome.ts`,
`factory-worker/agent/lib/handle.ts`, `pr-status.ts`, `implement-pr.ts`,
`pr-autofixer/agent/channels/github.ts`). The Tempo spans still drive the
two now-state panels, **Recent tickets** and **Stuck tickets**, where a
missing span means a stale stage, not a wrong count. A distinct-ticket
count is
`count(sum by (f_ticket) (count_over_time({…} | json … | <milestone> [$__range])))`
over `FACTORY_FIELDS` plus the extra `m_*` fields (`result`, `stage`,
`retried`, `verb`, `target`, `changeReview`, `posted`, `components`). The
milestones panel filters on **Ticket** through a `label_format` template
(`{{ if or (eq "${ticket}" "") (eq .f_ticket "${ticket}") }}yes{{ end }}`),
because a LogQL label filter compares with a literal only.

**The Business figures (v4), and their approximations.**

- **Filed.** The desk arms the ticket's plan-start check as it enters
  Triaged (`plan_start_watch` via `arm`, `armHopWatch`; only a ticket with
  a Slack thread), else the planner's first turn (`turn_started`, which
  the desk triggers at Triaged). A ticket that reached neither is not
  counted, so Filed can read low by such tickets; the exact filing is the
  lossy announce span.
- **Lead times.** Per ticket, the time from its earliest filing line to its
  earliest PR-opened (or merged) line, from the lines' own timestamps:

  ```logql
  min_over_time({…} | label_format m_ts=`{{ __timestamp__ | unixEpochMillis }}` | unwrap m_ts [$__range]) by (f_ticket)
  ```

  for each side, then `A - on(f_ticket) B >= 0`. The filing side is read
  over the range `or` the last 7 days (the filing can predate the range a
  PR opened in); a ticket whose filing is older drops out. LogQL has no
  quantile over a vector, so the strip tiles reduce the per-ticket series
  in Grafana (the stat's `p50` over every field). The Lead times table
  promotes labels to fields and pivots by ticket (`labelsToFields` first,
  then `merge`, then `groupingToMatrix` on `lead`) so a single series —
  only filed → PR, nothing merged — still draws a row, and many series
  still keep `f_ticket` / `lead`. `merge` before `labelsToFields` drops
  labels once two or more frames are present. The matrix names its first
  column `f_ticket\lead`; organize renames that to Ticket. Do not
  `groupBy` on `Value #A`: that name is absent when every series shares
  one legend. Tempo dwell is not used: the spans are lossy.
- **First-pass rate.** Of the tickets merged in range (`pr_status done
  moved`), those with no worker launch retry or heal (no `decision` line
  with `outcome="launched"` and `via="heal"` or `retried="true"`) and no
  Bugbot fix round on their PR. The fixer logs the PR only
  (`owner/repo#n`), so the round is joined to the ticket through the
  worker's `implement_pr` / `pr_status` lines, which carry both `issueKey`
  and `pr`: `sum by (f_ticket) ((worker pr lines) and on(f_pr) (fixer
  rounds))`, then `merged unless on(f_ticket) retried unless on(f_ticket)
  bugbot`, counted over `count(merged) > 0`. Approximations, stated in the
  tile: `bugbot_round drive` is logged when the round is granted, just
  before the drive is dispatched (`recordBugbotRound` logs nothing on
  success), so a dispatch that then failed still counts as a round (reads
  low); a PR the worker never named on a line with the ticket cannot be
  joined (reads high); retries and rounds are read over the range `or`
  7 days, older ones are missed.
- **Slack approvals per ticket.** The desk's `reaction` line (verb approve,
  target plan, outcome approved) or `approve_command` line, per distinct
  ticket that reached the worker in range (a `decision` with outcome
  `turn_sent`, `launched` or `launch_failed`). The desk's approve tool and a
  drag to Approved on the board leave no desk line: those tickets are in the
  denominator with no approval counted, so the figure undercounts.
- **Engineer-hours saved (modelled).** `distinct merged tickets ×
  $hours_per_ticket`. The variable is a custom list (1, 2, 4, 8, 16) with
  default 4, editable on the bar or by `var-hours_per_ticket=` in the URL.
  The tile and the variable both say MODELLED, not measured; the default is
  a manual baseline for a small ticket, not an observation. There is no
  budget variable, gauge or text.
- **Cost / filed, Cost / merged.** Ratios of range totals (the Prometheus
  estimate over Loki's filed tickets, divided in the browser; over the
  worker's merged counter in PromQL), so on a short range they read high;
  per-ticket attribution is **Cost and tokens per ticket**.

**Why Tempo for the now-state, not the delivery counter.** **Recent
tickets** and **Stuck now** / **Stuck tickets** read the announce spans in
Tempo. The `factory_deliveries_total` series for `jira.announce.*`
undercounts: the desk announces from a background task after it has acked
the webhook, and the host's background flush budget can end the process
before that increment is exported, while the span (sent by its own
exporter) lands. On Simon's Grafana the counter missed status changes the
spans and the Slack threads show. That is a host-side bug, reported
separately; the counter is still used for delivery volume, where it is
labelled approximate.

- **Tempo stops metrics at 25 hours.** Grafana Cloud's Tempo refuses a
  TraceQL metrics query (`count_over_time`, `rate`) longer than
  `query_frontend.metrics.max_duration` (25h), so on 7d and 30d every such
  panel failed. Only the Hosted execution p95 and Exec duration panels use
  a TraceQL metrics query, both pinned to `timeFrom: 24h`; every other Tempo
  panel is a search (up to 1000 spans) reduced in the browser. A test
  fails on a metrics query without `timeFrom` of 24h or less.
- **Current stage.** **Recent tickets** and **Stuck tickets** read a 7-day
  lookback (a ticket's stage is its last change, which can predate the
  range). The desk's answers count as stage changes too:
  `jira.announce.needs_info`, `plan_stopped`, `approved_without_plan` and
  `launch_failed` (the ticket then waits on a person, not on a hop).
- **Stuck tickets (past hop deadline).** The desk's hop watch nudges the
  next slug when a ticket waits too long: **Triaged** for the planner after
  15 minutes, **Approved** for the worker after 7 minutes. A ticket whose
  latest status (7-day lookback) is exactly one of those, older than its
  deadline, is stuck; longest first. A ticket the desk answered
  (`needs_info`, `plan_stopped`, ...) is not. **Stuck now** counts the same
  rows.
- **Latency heatmap and Hosted execution p95** (Debug: latency). Both read
  the `agent_sdk.turn` root span's duration from Tempo (TraceQL metrics),
  because July's `agent_sdk.hosted_execution.duration_ms` has the OTel default
  buckets (top 10 s) and 0.2.25 exports no span for the whole hosted execution
  (the turn is the execution's work; webhook-only executions run no turn).
  The heatmap is `histogram_over_time(duration)` (power-of-two rows, no cap).
  The p95 is `quantile_over_time(duration, .95) by (resource.service.name)`
  joined (outer, by time) with a Prometheus zero per slug, then
  `max(p95, 0)` per slug, so all six slugs stay listed and idle ones read 0.
  Tempo's quantile also uses power-of-two duration buckets, so at low volume a
  value can read up to 2x the slowest real span (a 10.3 min turn shows as
  18.3 min); the exemplars link to the real traces. A turn whose root span is
  lost at flush (see "Turn roots are lost at flush" below) is missing from
  both panels, which matters most for long turns. Both panels are pinned to
  the last 24 h (`timeFrom`), Tempo's TraceQL metrics limit being 25 h.
- **Cost per ticket (est.)** (Simon's request; titled with est.; on Ops). The mean
  full cost of the tickets merged in the trailing 24h: for each ticket
  merged in that window, its own end-to-end estimated cost from
  `factory_ticket_key` over the last 7 days (summed over every host that
  tagged the key — the Service filter does not apply), then the mean across
  those merged tickets (`mean_cost_per_merged_ticket(window=24h,
  cost_window=7d)`). The 7d cost lookback covers a ticket's lifetime, so
  work done days before the merge is counted in full. Unkeyed turns
  (`factory_ticket_key` `none` / `other` / unlabelled) and tickets not
  merged in the window contribute nothing. The points are the same mean per
  6h bucket of merges. Tickets merged before the ticket key was deployed
  (2026-10-04 04:43 UTC) carry no key, so the line starts from then, and it
  has a value only once a merged ticket's key also appears on
  `cursor_token_usage_total`. July's
  token and turn counters count only July session turns on the factory
  hosts: the worker's implement cloud agent (launched directly through
  `@cursor/sdk` `Agent.create`, `factory-worker/agent/lib/launch.ts`) is
  not counted; the planner's cloud turns (since #227) and the worker's
  July cloud turn (since #229) are, and they report input net of cache
  reads, which the per-series uncached rule (Two input shapes) prices in
  full (TLSSN-60's planner turn was priced at $0 input before it). In the
  last 7 days of Prometheus data only factory-desk,
  factory-planner and factory-security-reviewer emitted
  `cursor_token_usage_total`. Prometheus only, so it reads at 6h, 24h, 7d
  and 30d (Tempo metrics stop at 25h); the cost side is counter-based and
  can be off after a restore that carries state (see Known gaps).

**Colours.** #219's `PALETTE` colours every slug, outcome, level and token
series (Okabe-Ito slugs, no red or orange; calm is the text colour, never a
saturated green). The stage ramp runs from pale blue to deep violet
(`STAGE_RAMP`), lightness falling in even steps so neighbours separate; the
Business flow bars and the Recent tickets stage cells use it. Token kinds
are three lightness levels: uncached input dark indigo, output mid indigo
(a hue no slug uses), cache read grey. Status tiles (Stuck now, the health
tiles) fill only for warn and bad; calm stays unfilled. Skipped and
ignored outcomes are grey, never red.
A series `PALETTE` does not name (a new span, level or July event) is the
outcome "other" grey, never palette-classic's red or orange; a test fails on
any chart that falls back to palette-classic. Spans have their own palette
(no red or orange). HTTP requests by service and status are coloured by
status class (2xx blue, 3xx grey, 4xx orange, 5xx red), matched as the
legend's last word or a quoted label value, so a 200 is never red and a 500
never green. Span tables keep their outcome and status colours: the blank-nil
mapping skips those columns, which map nil themselves.

**Layout rules.** On Ops every detail row is a collapsed **Debug:** row;
Business has no collapsed row. Every Service cell is a link to that slug
on Factory ops. The Ops "In range" row is 12 tiles, w=4, six to a row; the
Business strip is 4 × w=6 then 3 × w=8 then 3 × w=8, all h=5. The variable
bar stays one line at 1280: Ops shows Service, Ticket and Bucket (Find and
Tags are hidden), Business shows Hours / ticket. Every empty chart says "No
data in range. Widen the time range."

**Empty states.** One standard: what is missing, then what to do, as two
sentences ("No ticket filed in range. Widen the time range."). Grafana shows
a table's no-data text only when no frame has a field, and Tempo and Loki
return an empty frame with its schema, so every stream table drops it with
#219's `filterFields` count>0 guard and reads its no-data text, which also
avoids Grafana's "Data does not have a time field".

**Thresholds.** Errors (Now and In range): red from 1 (any failure is worth
a look); no-ops are never red (a no-op is usually a correct skip). Error %:
calm under 2%, orange from 2%, red from 10%. Stuck now: calm at 0, orange
from 1, red from 3. Never started: red from 1; Launch retries / heals:
orange from 1. First-pass rate, the lead times, Slack approvals per ticket
and the modelled hours are neutral: they are figures, not alarms.

## Known gaps

- **A request has no ticket key.** The desk's `intake_triage` line (one
  per Slack message the intake considered, chatter included) carries no
  ticket key and does not say which messages were filing requests, so no
  panel counts requests; v4 cut the v3 **Intake candidates** stat. Filed
  on Business starts at the ticket (the desk's arm line or the planner's
  first turn).
- **No conditional panels.** Grafana cannot hide a panel when **Ticket** is
  empty, so the journey tables stay on the page with their no-data text;
  Recent tickets above them is the way in.
- **Parallel 7d / 30d loads.** Opening several dashboards at 7d or 30d at
  once can make a few Tempo panels show a transient error while Tempo
  queues the searches; a refresh clears it. `tools/load_smoke.mjs` loads
  them one at a time.
- **Versions.** Written for Grafana Cloud (13.1+; verified on 13.3.0). A
  local check uses Grafana 12.2, which does not run Tempo search from the
  backend, so `verify.py` reports those targets as errors there; the
  browser runs them.
- **Per-ticket cost is an estimate from counters.** `factory_ticket_key`
  on the token and turn counters gives each keyed ticket its own cost
  (**Cost and tokens per ticket**, **Cost per ticket (est.)**); the
  worker's cloud build agent is not counted by July, and the counter
  caveats (restores that carry state) apply. **Cost / filed (est.)** and
  **Cost / merged (est.)** stay ratios of range totals.
- **The announce counter undercounts** (see "Why Tempo, not the delivery
  counter"): a host background flush bug, reported separately. The announce
  spans themselves can be lost at flush too ("Announce spans are lossy"),
  which is why v4 reads every flow and lead-time figure from the Loki
  milestone lines and keeps the spans only for the now-state panels (Recent
  tickets, Stuck tickets).
- **Loki milestone field names** are read from the host code, not from the
  factory's Loki (no Grafana access when v3 and v4 were written; v4's
  queries were run against a local Loki 3.5 on `tools/rawbody_check.py`'s
  fixture, which is shaped from the host code); the host code is the
  reference if a count reads 0 while the Slack thread shows the milestone.
  The v4 Business tiles and the Lead times table also lean on Grafana
  transforms that no offline gate renders (the stat `p50` over per-ticket
  series, `labelsToFields` then `merge` + `groupingToMatrix` on Lead times, the Loki
  `displayNameFromDS` legend behind `filterFieldsByName` on Cost / filed):
  run `verify.py` and `tools/load_smoke.mjs` against the stack after the
  first apply.
- **Known loss: the last interval of a destroyed pod, for work a handler
  detaches from `waitUntil` and for a flush that fails or times out.** July's
  flush covers its trace, meter and log providers after each hosted admission
  and execution, bounded to 1 s; metrics otherwise export on the 10 s timer.
  A pod destroyed within 10 s of such a metric loses that interval's metrics.
  Token usage per ticket (`factory_ticket_key`) is exported with the turn.
  Loki and Tempo are not affected.
- **Counters can be off after a restore that carries state.** The hosts keep
  cumulative counters in July's MeterProvider and draw one
  `service.instance.id` per process life; there is no rebase. Two lives that
  share an id, a restore that carries nonzero totals, a failed export, and a
  pod frozen before its next 10 s export are not repaired (`COUNT_CAVEAT`; the
  section "Prometheus counts are approximate" above). No query compensates.
  Cost per ticket (est.), the Cost / … (est.) tiles, the per-ticket cost table
  and the delivery tables under Debug say so in their descriptions
  (`RESTART_OVERCOUNT`); ratios of two counters say they can be off either way.
  Loki and Tempo are the reference.
- **No USD cost metric after July 0.2.20.** 0.2.25's collector does not
  increment `cursor.cost.usage` and does not stamp `agent_sdk.cost_usd` /
  `cursor.model.name` on new turns. Historical `cursor_cost_usage_USD_total`
  series may remain in Prometheus; no panel reads them. Spend is tokens ×
  `$price_*` by design (`generate.py` `estimate()`); see
  [`docs/july-otel-upstream.md`](../../docs/july-otel-upstream.md).
- **`factory.*` spans reach Tempo from all six services** (#215, deployed).
  Each is a sampled root of its own trace, with a span link to the inbound
  `agent_sdk.http` context. The factory-span tables search them directly
  and are empty when no factory work ran in range (or the selected slug /
  ticket has none). July's `agent_sdk.http` is still recorded only when
  Cursor's backend sampled the inbound request. In 0.2.25 it is also not
  started for the first request of each process life
  (`dist/internal/otel/http.js:32-34`;
  [`docs/july-otel-upstream.md`](../../docs/july-otel-upstream.md)).
- **Outcomes besides `ok` and `error`.** `traceFactory` reads a span's
  notes and `describe()` while the span is recording. #215 records every
  factory span, so skipped / ignored / not_posted and the rest appear on
  both the Tempo tables and the Prometheus delivery counters. A delivery
  whose span is not recording (OTLP export not configured) still lands as
  `ok` (or `error` on a throw).
- **KV-failure zero baseline.** Bind emits `apj_factory_kv_failure_total=0`
  with `site="none"`, `reason="none"` (slug is `factorySlug`, or
  `${factorySlug}-staging` when `FACTORY_ENV` is staging). The KV stat stays
  0 until a real failure; the KV table filters `site!="none"` so the
  baseline is not a row. No slug uses subagents, so there is no subagent
  panel.
- **Short-lived per-VM series**, which is why `counter_inc` exists (above).
- **Hosted-execution and reminder labels reach Prometheus.** July's own
  labels `phase`, `channel_kind`, `delivery_surface` and `outcome` are on
  hosted-execution metrics, and `kind`, `reason` and `purpose` on reminder
  fires, with whatever values July sets (no allowlist now). Hosted execution p95 reads Tempo `agent_sdk.turn`
  spans (see Latency heatmap); "hosted executions" counts executions, not visible replies.
- **Tempo search returns the newest matches, not the slowest,** so every span
  table is "newest 50"; sort the Duration column yourself.
- **Loki first-bar and last-bar edges.** LogQL has no subquery, so a Loki bar
  cannot be capped at `$__to` and the first bar can miss up to one step. That
  is a known gap, not a PromQL bug.
- **promtool / Loki factory tests skip in repo CI.**
  `scripts/grafana-dashboards.test.mjs` auto-detects `PROMTOOL` and a
  loopback Loki; without them those cases skip. They are not in the repo
  CI matrix.

From the 2026-10-03 telemetry coverage audit (one hour, all six hosts). These
leave panels empty or partial for reasons outside this folder; each panel's
description says so:

- **Counter totals are approximate**: low while restores reuse a
  `service.instance.id` (host-side fix 1), possibly high now that #215 gives each
  restored life a new series that starts at the snapshot's totals. The Loki
  cross-checks above are the reference.
- **The 2026-10-03 audit saw zero `factory.*` spans** (host-side fix 3,
  now #215). That is the pre-fix hour. After #215 the factory-span tables
  and the ticket span table list `factory.*` spans from every slug; they
  are empty when there is no factory work in range. Most log `trace_id`s
  are still the inbound request's id, which Tempo holds only when Cursor
  sampled that request; click a factory span's own Span ID instead.
- **Turn roots are lost at flush** on most large turn traces (3 of 8 turns
  stored; host-side fix 4), so Recent turns is partial. A `turn.completed`
  line's `trace_id` is the delivery's trace, not the turn's; join on
  `cursor_conversation_id` + `agent_sdk_turn_id` instead.
- **No triage-jira spans at all** in the audit hour (same pre-#215
  sampling cause). Triage now exports `factory.*` spans like the other slugs.
- **37% of log lines are July's tagged lines** (raw `[bdk] …` text now;
  older `tag:bdk` / `tag:planner` bodies exported before #217 are still
  parsed; host-side fix 11). The raw panel hides tagged lines of either
  shape by default.
- **The planner's own `turn_model` model and cost fields** are in the raw
  JSON body; no panel reads them yet.
- **`agent_sdk_agent` is `planner` / `security-reviewer`, not the slug**
  (host-side fix 12); no panel uses it, they all use `service_name`.
- **Warnings and failed turns are rare by nature**: the audit hour had one
  error line, no warning, and no failed turn. The log bars show a 0 baseline
  per slug, so an empty series means no logs, not no errors.
- **Tempo's span metrics are not on the dashboards:** they cover only sampled
  spans, `traces_spanmetrics_latency` is a native histogram (no `_bucket`
  series for a classic quantile), and 12 of 18 series were non-monotonic.
  Their labels (`service`, `span_name`, `span_kind`, `status_code`) carry no
  namespace, so a panel that brings them back must pin the factory slugs
  (`service=~"factory-.*"`, not the `$service` regex alone, which is `.*` at
  All) or any other service on the stack that emits `agent_sdk.*` spans is
  counted too.

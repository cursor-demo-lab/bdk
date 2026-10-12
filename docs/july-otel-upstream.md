# July OpenTelemetry on hosted v2: asks for upstream

The factory exports traces, metrics, and logs from its six hosted v2 slugs
to Grafana Cloud with `@cursor/july` 0.2.22 (runbook:
[`factory-deployment.md`](factory-deployment.md#11-opentelemetry-export-grafana-cloud)).
Each item below is a July behaviour the factory works around in
`agent/otel.ts`, `agent/lib/factory-otel.ts`, and
`agent/lib/factory-otel-signals.ts`, and that
`factory-desk/agent/lib/july-otel.test.ts` pins. When July changes one,
that test fails first. Sections 11 and 12 (a tool span ended with
`cursor.tool.status=unknown`; a turn's end behind an overlapping flush) are
pinned instead in
`factory-desk/agent/lib/july-otel.turn-end.test.ts`. Section 12 has a
workaround in two parts: `agent/hooks/zz-otel-turn-flush.ts` with
`agent/lib/otel-turn-flush.ts` (Bug 6a), and the factory's tracer provider
registered as the global one, so July records no span in memory (Bug 6b,
an approved exception; sections 4 and 12). Section 11's status stamp is
in 0.2.21+; the remaining gap is the missing `cursor.tool.calls` increment.

Since Bug 6b, July's `agent_sdk.*` spans leave through the factory's span
processor and exporter, with the factory's sampler, ids, and export
resource. Where a section below describes July's in-memory span buffer or
its deferred trace export (sections 1, 2, 4, 9, 12), that path now runs
only if another provider holds the global tracer slot first
(`global_provider_taken` with `tracer: false`); each says what changed for
the factory. The asks stand: they are July's gaps for any host.

## 1. Do not block the hosted reply on the export

`afterHostedWork` (`dist/internal/hosted-delivery.js`) awaits `flushOtel`
in its `finally`, so every hosted admission and execution reply waits for
`forceFlush` (`dist/internal/otel/runtime.js`), whose deferred trace export
is raced against 5 s (`OTEL_DEFERRED_EXPORT_TIMEOUT_MS`). A collector that
hangs adds about 5 s to every delivery (measured: 5004 ms). The factory caps
the export at 2 s (`EXPORT_TIMEOUT_MS`, about twice a cold first request) by
setting `OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT` from its resolver, which July
calls just before it builds the deferred exporter.

Since Bug 6b July has no deferred trace export in the factory's hosts (no
memory buffer), so its reply-path flush posts nothing and a hanging
collector costs a delivery only the factory's own `SIGNALS_BUDGET_MS`
(`july-otel.test.ts`). The cap still applies on the fallback path.

Ask: start the export and answer without waiting (keeping the pod alive
until the export settles, as `waitUntil` does), or accept an export timeout
in `defineOtel` (`exporters[].timeoutMillis`) and default it to well under
a second.

## 2. Do not re-post a batch the collector rejected with 401 or 403

`flushDeferred` resets the in-memory span buffer only when every
destination accepted it. A 401 (a wrong token) or 403 (a missing scope)
leaves the batch, up to 2048 spans, to be posted again on every later
delivery, each one paying a round trip until the secret is fixed.

Since Bug 6b July's spans go through `factorySpanExporter`, which drops a
4xx batch and keeps only a transiently failed one for the next export, so
the factory no longer re-posts them (`july-otel.test.ts`).

Ask: drop the batch on a non-retryable 4xx (log once), and retry only on
429, 5xx, and network errors.

## 3. Bind metric and log exporter headers late, as trace export does

On hosted v2 the pod starts before deployment secrets bind, and secrets
reach `process.env` per request (`dist/internal/cursor/hosted-bound-secrets.js`).
Traces cope: the authored resolver is re-read on every flush. Metrics and
logs do not: `startOtelSdk` builds `OTLPMetricExporter` and
`OTLPLogExporter` once, with a header object `withEnvHeaders`
(`dist/internal/otel/config.js`) spread from env at startup, and the
exporters read env headers only when constructed. A header set later never
reaches them, and with no exporter at startup July turns metrics and logs
off for the life of the pod. The factory registers its own global meter
and logger providers before `startServer`, whose exporters read the header
at export time. 0.2.22 is given a dummy exporter whose `includes` matches no signal (`defineOtel` rejects `signals: []`) so it
builds no local provider and uses those globals (from 0.2.21 a real
traces/logs exporter would keep a local provider with frozen headers).

Flushing matters as much as building. A hosted execution's reply
(`dist/internal/hosted-delivery.js` `afterHostedWork`, the execution at
:689) awaits only `runtime.forceFlush` (`dist/internal/otel/runtime.js`),
which flushes July's own meter and logger providers and the deferred trace
export. With the factory's global providers adopted, July's are unset, so
the execution reply returns before the turn's metrics and logs flush: its
`cursor.token.usage` and `agent_sdk.turn.count`
increments and its `turn.completed` / `turn.failed` records can be lost
when the VM is replaced right after. The factory awaits its own flush
around deliveries its code wraps and, for a session turn, from the
`session.*` hooks before the reply (section 12, Bug 6a). Since Bug 6b the
adopted tracer is the factory's too, and July's `forceFlush` skips it the
same way.

Ask: build metric and log exporters from the resolver at export time (or
take a headers function), and flush them with the trace export, including
global providers July adopted, before the execution reply. And drop
`cursor.conversation.id`, `agent_sdk.session_id`, `agent_sdk.sdk_agent_id`,
and session tags from metric attributes (collector.js `join`): under a
cumulative reader each session stays a series for the life of the process.
The factory drops them with a View.

## 4. Flush once at a time, and do not drop spans recorded during an export

`flushDeferred` copies the finished spans, exports them, then calls
`reset()`. Two flushes that overlap (a hosted admission's flush and its
execution's flush) export the same spans twice, and a span that finishes
while an export is in flight is cleared by the `reset()` that follows,
never exported.

Ask: take the batch out of the buffer when the export starts (put it back on
a retryable failure), and serialize flushes. Related: July's hosted path
records into a `SimpleSpanProcessor` and has no batch processor, so
`OTEL_BSP_SCHEDULE_DELAY` and the other `OTEL_BSP_*` settings do nothing
there; say so in the docs, or honour them.

Factory mitigation (Bug 6b, an approved exception to "July's spans leave as
July emits them"). `installFactorySignals` (`factory-otel-signals.ts`,
loaded from `agent/otel.ts` before `startServer`) registers an
AsyncLocalStorage context manager, unless one is registered, and then the
factory's tracer provider as the global one. `startOtelSdk` finds a real
global tracer (`hasRealTracerProvider`, `runtime.js` :108-109, :267-271),
is given no traces exporter, so it builds no local tracer and no memory
buffer ("[bdk] otel enabled", not "otel recording" and not "export on a
local provider"). July's spans then wait in the factory's
`BatchSpanProcessor`, which takes a batch out of its queue when the export
starts, keeps a span that ends during an export for the next one, and keeps
a transiently failed batch for the next export (at least once: a timed-out
batch the collector took can arrive twice). So for the factory neither the
loss nor the duplication above happens, and `OTEL_BSP_*` still does nothing
(the factory's processor is given `TRACE_DELAY_MS` explicitly). The
context manager is the factory's because `NodeTracerProvider.register()`,
which installed one, runs only for a provider July builds; without it a
span's parent is lost at the first `await`. What changes on July's spans,
and nothing else: the sampler (`exportGatedSampler`, parent-based like
July's, recording nothing while the header is unset), the ids
(`factoryIdGenerator`, section 8), and the resource (`exportResource`,
built at export time, which sets the `cursor.surface=unspecified` and
`cursor.entrypoint=sdk_ts` July's `buildResource`, `runtime.js` :247-256,
gave its own spans, so the collector still sees them). Names, attributes, events, and log bodies are
July's. July's `forceFlush` does not flush an adopted tracer, so this
depends on the factory's own flushes before the reply (section 12, Bug 6a).
If another provider holds the global slot first, `installFactorySignals`
warns `{"otel":"global_provider_taken","tracer":false,…}` and July falls
back to its memory path with the loss above. Pinned in
`july-otel.turn-end.test.ts` and `factory-otel-signals.test.ts`.

## 5. Let an agent turn outbound trace context off

With traces on, `installOutboundFetchInstrumentation` wraps global `fetch`
to send `traceparent` and `backend-traceparent` on every outbound request
(Slack, GitHub, Jira, `api.cursor.com`). The factory turns traces on at
startup so the deferred export can work, and wants those headers only while
export is configured. It sets July's install flag first and installs its
own wrapper.

Ask: an option (`traces: { propagateOutbound: false }`, or an env switch)
instead of the global flag.

## 6. What July 0.2.18 `collector.js` puts on the wire (information)

The factory turns `logs.userPrompts` and `logs.toolContent` on. Grafana
access is the only control; there is no ask for July to keep content off
spans or logs. July 0.2.18 `dist/internal/otel/collector.js` emits:

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
- Every content field except `agent_sdk.sdk_agent_url` is truncated at
  `CONTENT_MAX` 2048 + "…" (:13, :677-682).

HTTP and host MCP spans are outside that collector. `endActiveHttpSpan`
(`dist/internal/otel/http.js`) calls `recordException(error)` and sets
the status message to the error's message for a 5xx thrown out of a
hosted route. `runMcpClientSpan` (`dist/internal/otel/mcp.js`) sets the
status message to the thrown error's message. The MCP span is exported
for the factory's Jira calls (they run inside a factory span, so it is
recorded even under an unsampled request; see section 9). The factory
does not suppress, rewrite, or strip July's spans.

The factory adds one attribute to them, by an approved exception to that
rule: `factory.ticket.key`, the session's Jira key (`none` or `other`
when there is none), set on `turn.started` from the
`agent/hooks/ticket-key.ts` of each host that runs model turns (desk,
planner, triage, fixer, reviewer; the worker runs none, has no hook, and
only counts `apj_factory.ticket.merged`) through July's public
session-attribute API (`host.otel.setAttributes` →
`collector.setSessionAttributes`, :39-44). July's own `paintOpenSpans`
(:578-595, the same path `agent.bound` uses for `agent_sdk.sdk_agent_url`
at :88) writes it onto the session's open `agent_sdk.turn`,
`agent_sdk.tool`, and `agent_sdk.subagent` spans, and `join` stamps it on
every span and metric sample the session records after that. So it is on
the `agent_sdk.turn` span, every `agent_sdk.tool` span (opened at the tool
call: on `actions.requested`, :144-150, or in `runInCall` when July executes
the tool itself, :53-56 and :528-537) and `agent_sdk.subagent` span (opened on
`subagent.called`, :245-250), both after the hook, every metric sample of
the turn, and the `agent_sdk.turn.<phase>` spans opened after the hook
settled. `session-engine.js` emits `turn.started` into a queued dispatch
(:1706, `queueDispatch`) and opens the turn's first phase span in the same
synchronous stretch (`prewarm` :1710, else `workspace` :1717, else
`nudges` :1738), so that one always predates the hook; the later early
phases (`workspace`, `nudges`, `build_request` :1795, `first_update` :1800)
each open after an `await` and may or may not, depending on the hook's
latency. A phase span opened before the hook settled has no key on a
first turn and the previous turn's key on a re-tagged session. The factory keeps the metric
label only on `cursor.token.usage` and
`agent_sdk.turn.count` (`factory-deployment.md` section 11; 0.2.20 dropped
`cursor.cost.usage`). No span
processor, exporter, or log is touched, and nothing else on July's spans
or logs changes. Nothing is asked of July for this; the public API is
enough. (A `paintOpenSpans` that also painted the turn's open phase spans
would close the gap; not requested.)

## 7. Export `defineOtel` publicly

`defineOtel` is exported only from `@cursor/july/internal/otel` ("Internal
only: Cursor factory agents"), yet it is the only way to export telemetry
from a hosted v2 slug.

## 8. Restores: ids, instance id, and counters

Hosted v2 freezes a VM after `startServer` and restores each VM of a slug
from that snapshot. Anything the process held at the freeze is shared by
every restored VM, and an audit of the desk's telemetry found three effects
(runbook: [`factory-deployment.md`](factory-deployment.md#restored-vms-ids-the-instance-id-and-counters)):

- **July's span and trace ids repeat.** OTel's default id generator draws on
  `Math.random`, whose V8 state a snapshot clones. Span id `1101ba25…` sat
  in 102 log lines across 34 traces and under all 13 desk instance ids, and
  77 of 571 distinct span ids in Tempo were under more than one trace. The
  factory draws its own spans' ids from the kernel pool when each span
  starts (`factoryIdGenerator`). The audit predates Bug 6b: July's
  `agent_sdk.http`, turn, and tool spans then used the default generator,
  and `defineOtel` has no id generator option. Since 6b they start on the
  factory's global tracer provider and get `factoryIdGenerator` too
  (section 4); on the fallback path they would use the default again.
- **A `service.instance.id` is only as good as its draw.** The factory
  draws one lazily, after the restore, and again on a clock step that
  looks like a resume (held until a request can salt the draw if the step is
  seen outside one). Nothing tells the process that it was restored, and
  whether a hosted VM resumes in place or starts a new process on the
  snapshot is not measured; the factory logs each draw and reason so it can
  be.
- **Cumulative counters rewind across lives.** Two lives that share an
  instance id write one series from two copies of the snapshot's state
  (the audit saw 11,965, 52,783, 55,769 in one series), and PromQL sees a
  reset only on a fall, so it counts a jump up as growth. A per-life
  instance id keeps lives apart but not their starting values.

Ask: draw span and trace ids from the platform's CSPRNG when a span starts
(or accept an `idGenerator` in `defineOtel`); give each restore its own
`service.instance.id` (set by July or the host after restore, or an env var
hosting sets per VM); and give a restored life its own cumulative start time
(`start_time_unix_nano` set at restore) or reset the meter provider's
aggregation at restore, so a backend can see the reset. A restore hook
(an event or a callback in `defineAgent`) would let agents do the same.

## 9. Do not drop July's own spans under an unsampled inbound request

July builds its tracer with a `ParentBased` sampler (ratio 1 for a root).
Cursor's backend leaves about 96% of inbound requests unsampled (an audit:
all 66 trace ids missing from Tempo had no trace `flags`, all 5 stored ones
had `flags=1`). What that drops depends on the span's parent, which July
chooses per span (July 0.2.14 and 0.2.18, `dist/internal/otel/`):

- `agent_sdk.http` is a child of the inbound request's span, so it is
  **not recorded** under an unsampled request, and the logs written inside
  it carry a trace id the backend never stores.
- `agent_sdk.turn` starts from `ROOT_CONTEXT` (`collector.js` `openTurn`),
  so it is a root and is **recorded under any request**, with its
  `agent_sdk.tool` and `agent_sdk.subagent` children. A session turn is not
  affected by the inbound flag. The `agent_sdk.turn.*` phase spans 0.2.18
  adds are children of `agent_sdk.turn`, so they are recorded with it.
- A host MCP client span (`runMcpClientSpan`, `mcp.js`) starts under
  whatever span is active. Outside a factory span, under an unsampled
  `agent_sdk.http`, it is not recorded. **Inside a factory span it is**
  (the factory span is a sampled root), as that span's child.

The factory sidesteps the part that hurts for its own spans by starting
each as a new root with a link to the inbound span. It does not change
`agent_sdk.http`, which stays unrecorded for unsampled requests. Since Bug
6b July's spans take the factory's sampler, which is parent-based like
July's (`exportGatedSampler`: `ParentBased(AlwaysOn)` while the header is
set), so the three cases above are unchanged.

This also decided who paid July's post-reply flush before Bug 6b. A hosted
delivery that recorded any July span had something to post; with a
collector that does not answer, that was the 2 s export cap on top of the
factory's own wait, for a worst case of about 4 s (measured 4,008 ms). Every
session turn and every host MCP call made inside a factory span did too,
sampled or not, and July posted what it could not send again at every later
flush. Since 6b July's spans are in the factory's queue: July's flush posts
nothing, the factory's flush carries them within its `SIGNALS_BUDGET_MS`,
and a delivery with a hanging collector waits only that
(`july-otel.test.ts`). This returns on the fallback path.

Ask: sample agent spans regardless of the inbound flag (a root with a link,
as the factory does), or make the sampler configurable in `defineOtel`. If
the post-reply flush must stay, run it after the reply is sent and do not
re-post a buffer that has already failed (section 2 and section 1).

## 10. Stamp the turn's cost before `turn.completed` reaches the collector

Since 0.2.20 the collector does not increment `cursor.cost.usage` and does
not read `event.data.cost` on `turn.completed`. 0.2.22 still reserves the
name. Token usage is unaffected. Factory config must not mint that metric;
Grafana spend is tokens × `$price_*`
([`observability/grafana/`](../observability/grafana/README.md)).
Ask 10 is closed as "dropped, not renamed."

Ask: stamp the cost (and model) before the event is fanned out to the
collector, or have the collector record cost from a later event.

## 11. End a tool span that never got a result with a status

July opens an `agent_sdk.tool` span on `actions.requested` and sets
`cursor.tool.status` and the span status on `action.result`
(`dist/internal/otel/collector.js`). From 0.2.21, a call that starts and
never gets a result is ended by `turn.completed` / `turn.failed`
`endOpenChildren` with `cursor.tool.status=unknown`, span status ERROR
`"no result"`. There is still no `action.result` log or `cursor.tool.calls`
increment, so the call is invisible to status-count panels. The live case (2026-10-03,
factory-security-reviewer, trace `09c03e32…`, span `f69cabba77e18bb6`) is
the harness's built-in `GetDynamicTools` (`cursor.tool.kind=builtin`, 15,476
ms, started 16:03:36.100, ended by the turn's end at 16:03:51.576).
`TurnEventMapper` (`dist/internal/event-mapper.js` :117-130,
`noteToolCompleted` :296-333) emits `action.result` only when the harness
reports `tool-call-completed`, and `finish()` (:175-182) seals open requests
(`sealOpenRequests`) and then calls `flushOpenResults()` (:177, defined
:523). That replays only results the mapper already holds; a call with no
completion has none, so it is dropped silently, with no synthesized result.
Whether the harness never sent the completion or the mapper's wave
bookkeeping dropped it (`waveForComplete` returns `undefined` for a sealed
wave with no singleton) is not visible from the telemetry. Pinned in
`factory-desk/agent/lib/july-otel.turn-end.test.ts`.

Ask: when a turn ends with a tool or subagent span still open, record
`cursor.tool.status` (a distinct value such as `incomplete`) and set the
span status before `end()`, and count it in `cursor.tool.calls`; or have the
mapper emit a synthetic `action.result` for calls with no completion at
`finish()`. The factory does not rewrite the span.

## 12. Export the turn's end before the hosted reply

`turn.completed` (and `turn.failed`, :341-379) adds to
`agent_sdk.turn.count` and ends the turn span in memory (`collector.js`
:296-339). Nothing July awaits before the reply
exports either reliably. The bullets below are July's behaviour as pinned
before Bug 6b; with the factory's tracer global (section 4) July has no
span buffer, so the ones about `flushDeferred` and `reset()` apply only on
the fallback path, and the one about the adopted meter and logger now
covers the adopted tracer too:

- July's `forceFlush` (`dist/internal/otel/runtime.js` :198-207) flushes
  only the providers July built (meter, logger, tracer) and its deferred span
  buffer (`flushDeferred`, :205). The factory's global
  providers are the globals (0.2.22 dummy exporter, no local provider), so July's meter
  and logger providers are `undefined` and the metric and log flush is
  skipped (section 3).
- Within what July awaits before the reply, the one thing that starts the
  factory's flush is the factory's resolver (`factoryOtelResolver`, which
  starts `flushFactorySignals()` on every call after the first, the startup
  snapshot, and the flush does nothing while the header is unset:
  `factory-otel-signals.ts` :696, :751-755; July's own resolver flushes
  nothing). July invokes it from `flushDeferred` (:176-196), and only after
  `spans.length === 0` has been ruled out. July does not serialize flushes.
  A flush that was already exporting when the turn ended (an admission or
  another execution POST: `start`, `status`, `enqueue`; each wraps
  `afterHostedWork`, `dist/internal/hosted-delivery.js` :466, :533, :617
  (`enqueue` at :667), :689, :1059-1081) clears the buffer with `reset()`
  when it succeeds, the turn span included (section 4). If that `reset()`
  lands before the turn's own execution flush (:689) reads the buffer (a
  flush still exporting when it reads sends the span as well), that flush
  finds an empty buffer (unless another July span ended after that
  `reset()`), returns before the resolver, and starts no metric flush,
  sampled or not: the `start` POST answered "started" one `setImmediate`
  after starting the execution and flushed its `agent_sdk.http` then
  (:908-920), and the :689 work returns a reply object, not a `Response`, so
  :1062-1063 ends no span there. The next chance is the `status` POST that
  returns the settled reply (:645-648). It ends its own `agent_sdk.http`
  (`otel/http.js` :8-11) before `flushOtel` (:1062-1063, :1075), and so
  reaches the resolver (`runtime.js` :180-184), only when that POST is
  sampled (section 9, about 4%) or another July span is in the buffer by
  then. When that `status` POST is unsampled the increment waits for the
  next factory flush or the 10 s reader tick (`METRIC_INTERVAL_MS`),
  whichever comes first, and a pod frozen after the reply reaches neither.
- A `turn.completed` hook covers only part of it. Hooks run, awaited, before
  `this.otel.onEvent` (`dist/internal/session-engine.js` :3726-3752), so a
  flush awaited in the hook runs before the increment and the turn span's
  end. A flush deferred with `setImmediate` runs after them, but the reply
  does not await it (`afterHostedWork` awaits `flushOtel`, not the factory's
  deferred flush). See "Factory mitigation" below.
- Separately, in late-bind setups `resolveOtelConfig` turns metrics off when
  no exporter exists at boot (`config.js` :59,
  `exporters.length === 0 ? false : …`), and with metrics off July records no
  `agent_sdk.turn.count` at all. The factory avoids it because its boot-time
  resolver names a dummy exporter whose `includes` matches no signal (`exportConfig`,
  `factory-otel-signals.ts`), which turns metrics and logs on without
  attaching a July traces/metrics/logs exporter. A host that passed
  `exporters: []` would lose the count the same way.

The live case (2026-10-03, factory-planner, instance `dd619b4d`, session
`<CURSOR_SESSION_ID>`, turn ended 17:38:44.625): Loki has
`turn.completed`; Tempo has the instance's spans up to 17:38:44.406 but no
`agent_sdk.turn` span; Prometheus has three planner turns for four, while
its tool counters for the same instance (last `record_plan` at 17:38:28.174)
are complete. So the last metric export fell between 17:38:28 and 17:38:44.6
and none followed. The overlapping flush itself is not visible in the
evidence. The same drop would also explain other missing spans (the
`post_findings` tool span of that security-reviewer turn has an
`action.result` log and no span). Pinned in
`factory-desk/agent/lib/july-otel.turn-end.test.ts`, which runs July's real
runtime and collector, with the factory's providers installed, and replays
the overlap (one slow flush in flight when the turn ends) against the
factory's span queue.

Ask: flush every provider July adopted (tracer, meter, and logger) on every
reply-path flush, after the turn's end and the request's `agent_sdk.http`
have ended, not only when the span buffer is non-empty (section 3); and,
for hosts on the memory path, take the span batch out of the buffer when
its export starts (section 4). The first would let the factory drop its
session flush and would put a sampled `agent_sdk.http` back in the reply's
flush (see the limits below).

### Factory mitigation (ours)

`agent/hooks/zz-otel-turn-flush.ts` (all six hosts, shared with
`agent/lib/otel-turn-flush.ts`) schedules `flushFactorySignals()` with
`setImmediate` from the `turn.completed` and `turn.failed` hooks. The
callback runs after July's synchronous `onEvent` has added the turn to
`agent_sdk.turn.count` and ended the turn span, so the next export carries
the count, the turn span and its tool spans (in the factory's span queue
since Bug 6b), and July's log records, which go through the factory's
logger. The file name
sorts last in `agent/hooks/` (July runs `agent/hooks/` in `localeCompare`
order, then mounted extensions' hooks, and awaits each;
`scripts/otel-turn-flush-order.test.mjs` holds this hook last overall on all
six hosts), so no other hook's awaited I/O sits between the schedule and
`onEvent`. It flushes only the factory's own tracer, meter and logger
providers: nothing July wrote is rewritten, dropped or reordered. It
coalesces repeated turn ends into one pending callback, joins the flush
`flushFactorySignals` queues behind a running one rather than starting an
overlapping one (unless the running one passes its `SIGNALS_BUDGET_MS` +
100 ms deadline with exports still in flight), and swallows and logs any
error, so it never throws into July and never delays the turn's reply (a
factory-wrapped delivery that flushes meanwhile joins the queued flush and
may wait longer, within its own `SIGNALS_BUDGET_MS`). Tests: `agent/lib/otel-turn-flush.test.ts`
and the mitigation tests in `agent/lib/july-otel.turn-end.test.ts`.

The same hook also **awaits** `flushFactorySignals()` from `session.waiting`,
`session.completed` and `session.failed` (`awaitFactorySignalsFlush`; Bug
6a). July appends those after the turn's `turn.completed` / `turn.failed`
(`session-engine.js` :1841-1893) on the same sequential dispatch chain, so the
collector has already counted the turn when their hooks run, and the hosted
execution's `waitForCompletion` (:3791-3813) awaits that chain before
`afterHostedWork` returns the reply. The reply therefore waits until the
factory's tracer, meter, and logger have exported the turn's spans,
metrics, and logs, so a pod hibernated right after the reply no longer
loses them. The wait is capped by `flushFactorySignals`' own
`SIGNALS_BUDGET_MS` and an error is logged, never thrown into July.

Bug 6b (approved exception, section 4) moves July's spans into the
factory's tracer provider, so this awaited flush is the one that carries
the turn span and its tool spans out before the reply. July's own
`forceFlush` exports none of them (it flushes only providers July built),
so the two depend on each other: 6b without the session flush would leave
turn spans on the `TRACE_DELAY_MS` timer after the reply, and the session
flush without 6b cannot reach July's memory buffer. Nothing July wrote is
rewritten: span names, attributes, events, and log bodies are July's;
only the provider that records and exports its spans changed.

Limits that remain:

- **Fallback.** If another provider holds the global tracer slot first,
  `installFactorySignals` warns `{"otel":"global_provider_taken",
  "tracer":false,…}`, July records into its memory buffer again, and the
  `reset()` race, July's 5 s deferred export, and the 4xx re-post
  (sections 1, 2, 4) are back for July's spans. The factory does not
  pretend otherwise: that warning means 6b is not in effect on that pod.
- **The session flush's cap.** `flushFactorySignals` waits at most
  `SIGNALS_BUDGET_MS` (2.25 s). A collector slower than that leaves the
  batch in the processor (retried with the next export, at least once), and
  a pod frozen before then loses it.
- **A sampled `agent_sdk.http`.** The request's `agent_sdk.http` span ends
  after the session flush, just before July's reply-path `forceFlush`,
  which no longer exports it. Before 6b July's deferred export carried a
  sampled one (about 4% of requests, section 9) out with the reply; now it
  leaves on the factory's `TRACE_DELAY_MS` (300 ms) timer or the next
  factory flush, and is lost if the pod is frozen first. Unsampled ones were
  never recorded. Turn and tool spans are not affected: they end before
  the session flush.
- **July's `forceFlush` race.** July races its own provider flush against
  `OTEL_FORCE_FLUSH_TIMEOUT_MS` (1 s) and its deferred export against 5 s.
  With no provider and no buffer of July's on the factory's path, both
  settle at once and neither bounds or loses a factory export.
- **Spans recorded before the header binds.** July's memory path recorded
  spans while the header was unset and exported them once it bound. The
  factory's sampler records nothing while the header is unset, so a July
  span that starts before the header is in `process.env` is not recorded.
  Whether any hosted request starts a span before its secrets bind is not
  measured; the 48-hour check below would show missing turn spans.
- **Resource.** July's spans leave with the factory's export resource
  (section 4), which restates July's `cursor.surface` and
  `cursor.entrypoint` values; any other attribute July later adds to
  `buildResource` would not reach them.

Success criterion after deploy: no `turn.completed` log without its
`agent_sdk.turn` span in Tempo over 48 hours, and no
`global_provider_taken` warning with `tracer: false`.

Remove the session flush when July flushes every adopted provider on every
reply-path flush. Keep the global tracer registration until July's own
span path neither clears unexported spans nor waits for its deferred
export before the reply (sections 1 and 4); dropping it brings the memory
path back.

# July OpenTelemetry on hosted v2: what the factory relies on, and asks for upstream

The factory exports traces, metrics, and logs from its six hosted v2 slugs
to Grafana Cloud with `@cursor/july` 0.2.25 (the same release as
`@cursor/bdk` 0.2.25; runbook:
[`factory-deployment.md`](factory-deployment.md#11-opentelemetry-export-grafana-cloud)).
All three signals use July's own providers: `planner/agent/otel.ts` hands July
a plain config (`factoryOtelConfig` in `planner/agent/lib/factory-otel.ts`:
service name, the namespace and `service.instance.id` resource attributes,
`logs` on, one exporter for all three signals while the header is set), and
July builds the providers and exporters, registers them globally, and flushes
them. The one thing the resolver adds is a default for July's metrics
temporality variable, `cumulative`, because Grafana Cloud rejects DELTA sums
(section 18). The factory's spans, counters, and console lines go through the
global `@opentelemetry/api` (the six copies of the files are byte-identical).
`factory-desk/agent/lib/july-otel.test.ts` drives July's real runtime with
`agent/otel.ts` and pins what the design relies on; when July changes one of
them, that test fails first.

Earlier versions of this file listed July behaviours the factory worked
around with providers of its own, first for all three signals and, until
0.2.25, for metrics. The workarounds are gone (2026-10-14: use July's setup out
of the box; 0.2.25 made the metrics one unnecessary). Sections 1, 2, 3, 4, 12,
14 and 18 below say what happened to each; the rest are July behaviours that
still matter. July paths are under `node_modules/@cursor/july/dist/` and
their line numbers were checked against 0.2.25. A path of the form
`packages/agent-serve/src/...` is the source in Cursor's own monorepo; those
lines come from a diff report and were not re-checked here (external repo).

What the design relies on (July 0.2.25):

- On hosted v2 the first `reload()` runs from `onSecretsReady`, after the
  secrets load, and builds the providers from the first config that has an
  exporter; later calls only update the headers
  (`internal/server.js:141-151,658`, `internal/hosted-delivery.js:424-430`,
  `internal/otel/runtime.js:33-95`).
- The exporters read their headers from the latest config on each export
  (`runtime.js:51,191-197,263-265`), and `OTEL_EXPORTER_OTLP_HEADERS` is merged
  into an authored exporter and URL-decoded (`internal/otel/config.js:50-53,76-102,156-164`).
- July builds a provider only for a signal that has an exporter
  (`runtime.js:191-215`); for a signal with none it uses the global
  tracer, meter, or logger (`runtime.js:150-162`). The factory's exporter
  names no `signals`, so July builds all three.
- July registers its tracer and logger providers globally unless another one
  holds the slot (`runtime.js:223-251`), and installs a W3C propagator and the
  outbound `fetch` wrapper when traces are on (`runtime.js:57-59,131`).
- The resource is built from the config only: BDK ignores
  `OTEL_RESOURCE_ATTRIBUTES` (`runtime.js:269-283`). Logs are off unless the
  config turns them on (`config.js:220`).
- Metric exporters take their temporality from
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` (`cumulative`, `delta`,
  `lowmemory`; default `delta`), read from `process.env` when July resolves
  the config (`config.js:173-197`, `runtime.js:191-206`; July's own
  guide, `dist/docs/guides/opentelemetry.md:30-32`: "For Grafana Cloud, set ...
  `cumulative`"). The setting is part of the settings key, so it is read once,
  when the providers are built (`runtime.js:60-71`).
- A hosted delivery's work ends with July's `forceFlush`, capped at 1 s
  (`internal/hosted-delivery.js:1071-1090`, `runtime.js:27,44,96-117`); it
  flushes the providers July built: traces, metrics, and logs.
- July does not export console output: the only log records in its dist are
  the collector's session events (`internal/otel/collector.js:694`, the one
  `logger.emit`) and `runtime.js:162` binds the logger; no file in `dist/`
  replaces `console.log` or `console.error`. The factory's JSON event lines
  are console lines, so `console-otel.ts` sends them through the global logger.
- The metrics, spans, and logs July's collector records, and the session tag
  bag it stamps on them (section 6).

## 1. Do not block the hosted reply on the export

Status in 0.2.25: closed in July. The memory span path and its deferred export
(`OTEL_IN_MEMORY_SPAN_LIMIT`, `OTEL_DEFERRED_EXPORT_TIMEOUT_MS`) are gone, and
the reply waits for July's flush, capped at 1 s (`runtime.js:27,96-117`). The
factory has no flush of its own (section 12). Removed from the factory: the
2.25 s `SIGNALS_BUDGET_MS` wait.

## 2. Do not re-post a batch the collector rejected with 401 or 403

Status in 0.2.25: closed in July (the re-post path is gone with the memory
buffer, `runtime.js`). The OTLP exporters keep their own retry for transient
failures.

## 3. Bind metric and log exporter headers late, as trace export does

Status in 0.2.25: closed in July for all three signals, which let the factory
drop its exporters. July builds the exporters on the first request,
after the secrets load, and reads the headers on each export
(`server.js:141-151,658`, `hosted-delivery.js:424-430`,
`runtime.js:51,191-197,263-265`). Rotating the header
needs no redeploy. Unsetting it does not stop a pod that already built its
exporters: when the exporter list changes July logs `[bdk:otel] only exporter
headers change after the first export; redeploy to apply the new OTel
settings` (`runtime.js:60-71`) and keeps the old headers, metrics included
now that July builds that exporter. July's team planned to fix that message
in 0.2.25; it is unchanged (`runtime.js:69`), and the factory has no code for
it.

## 4. Flush once at a time, and do not drop spans recorded during an export

Status in 0.2.25: closed for the factory's traces, metrics, and logs. It had its own
span processor with a queue and a retry; it now has none. July's
`BatchSpanProcessor` batches every 5 s (the SDK default) and drops a batch
that still fails after the OTLP exporter's retries.

## 5. Let an agent turn outbound trace context off

Status in 0.2.25: open (July). The factory no longer works around it.

With traces on, `installOutboundFetchInstrumentation` (called from
`internal/otel/runtime.js:57-59` on every `reload()` whose config has traces
on; defined in `dist/otel.js:162-169`) wraps global `fetch` to send `traceparent` and
`backend-traceparent` on every outbound request (Slack, GitHub, Jira,
`api.cursor.com`) made while a span is active. The factory used to install its
own wrapper so that header was sent only while export was configured
(`gateOutboundTraceContext`, removed). With the header unset the config has no
exporter, so July builds no provider, no span is recorded, and no header is
sent; with it set, outbound calls inside a recorded span carry the trace
context.

Ask: an option (`traces: { propagateOutbound: false }`, or an env switch)
instead of the global flag.

## 6. What July's `collector.js` puts on the wire (information)

Status in 0.2.25: information, no ask. Checked against
`internal/otel/collector.js` 0.2.25 by name. Against 0.2.23 the collector
changed in two ways only: it builds its metric instruments lazily from
`runtime.meter` (`collector.js:21-37`) and it ignores every event while
`runtime.config.enabled` is false (`collector.js:39-43`, `:72-90`; section
16). Against 0.2.24 it changed in one: a failed tool's reason is also the
`agent_sdk.error_message` of the `action.result` log (`collector.js:250,281`;
section 14). What it puts on the wire is otherwise the same.

The factory turns `logs.userPrompts` and `logs.toolContent` on. Grafana access
is the only control; July is not asked to keep content off spans or logs.
`collector.js` emits:

- `agent_sdk.user_prompt` on `message.received` logs, when `userPrompts` is on.
- `agent_sdk.error_message` on `turn.failed` / `session.failed` logs, through
  `gatedContent` (`toolContent`).
- `agent_sdk.tool_args` / `agent_sdk.tool_output` on `agent_sdk.tool` spans.
- `agent_sdk.subagent_description` on `agent_sdk.subagent` spans.
- `agent_sdk.sdk_agent_url` on open turn, tool, and subagent spans
  (`agent.bound`), when `toolContent` is on.
- A turn span status text and `recordException` only for non-expected
  failures; `session.failed` also sets an open turn span's status.
- Every content field except `agent_sdk.sdk_agent_url` is truncated at
  `CONTENT_MAX` 2048 plus "…".

HTTP and host MCP spans are outside that collector. `endActiveHttpSpan`
(`internal/otel/http.js:8-11`, `:61-86`) calls `recordException(error)` for a 5xx thrown out
of a hosted route, and `runMcpClientSpan` (`internal/otel/mcp.js`) sets the
status message to a thrown error's message. The MCP span is exported for the
factory's Jira calls (they run inside a factory span, so it is recorded even
under an unsampled request; section 9). The factory does not suppress,
rewrite, or strip July's spans.

The factory adds one attribute, by an approved exception:
`factory.ticket.key`, the session's Jira key (`none` or `other` when there is
none), set on `turn.started` from `agent/hooks/ticket-key.ts` (all six
hosts; the worker's tags implement turns) through July's public
session-attribute API (`host.otel.setAttributes` →
`collector.setSessionAttributes`). July's `paintOpenSpans` writes it onto the
session's open turn, tool, and subagent spans, and `join` stamps it on every
span and metric sample the session records after that. The first phase span of
a turn predates the hook; later `agent_sdk.turn.<phase>` spans (`workspace`,
`nudges`, `build_request`, `first_update`) open after an `await` and may or
may not carry the key. With no metric View the label is on every metric sample
of the session, `cursor.tool.calls` included
([`factory-deployment.md`](factory-deployment.md#11-opentelemetry-export-grafana-cloud);
0.2.20 dropped `cursor.cost.usage`). The call is one helper, `tagSessionTicket`
in `agent/lib/factory-otel.ts`. No span processor, exporter, or log is
touched. Nothing is asked of July; the public API is enough. (A
`paintOpenSpans` that also painted open phase spans would close the gap; not
requested.)

## 7. Export `defineOtel` publicly

Status in 0.2.25: open (July), E7 (`dist/otel.js:4-16`: "Internal only:
Cursor factory agents. Not a public Agent SDK export.").

`defineOtel` is exported only from `@cursor/july/internal/otel` ("Internal
only: Cursor factory agents", `otel.d.ts`), yet it is the only way to export
telemetry from a hosted v2 slug with a Grafana endpoint in code. The factory
imports the internal path in `planner/agent/otel.ts`.

Ask: export it from a public path.

## 8. Restores: ids, instance id, and counters

Status in 0.2.25: open (July and hosting); not tested live in 0.2.25.
0.2.25 adds no id generator option, no restore hook, and no instance id:
`runtime.js:218-222` builds its tracer provider with OTel's default
generator, and `buildResource` (`runtime.js:269-284`) sets no
`service.instance.id`.

Hosted v2 freezes a VM after `startServer` and restores each VM of a slug from
that snapshot. Anything the process held at the freeze is shared by every
restored VM. An audit of the desk's telemetry (an older July; version not
recorded here) found three effects:

- **July's span and trace ids can repeat.** OTel's default id generator draws on
  `Math.random`, whose V8 state a snapshot clones. Span id `1101ba25…` sat in
  102 log lines across 34 traces and under all 13 desk instance ids, and 77
  of 571 distinct span ids in Tempo were under more than one trace. The
  factory used to draw ids from the kernel pool (`wakeHex`, removed), and its
  spans and July's now use OTel's default again. Not re-measured since: the
  restored VM may or may not re-seed `Math.random`.
- **A `service.instance.id` is only as good as its draw.** Cumulative
  counters of two VMs that share an instance id overwrite each other. July's
  resource has none and its metrics are now cumulative, so the factory
  adds its own to the config, which July puts on the resource of all three
  signals: one id per process life, drawn only while the header is set, from
  a fresh kernel read hashed with the clocks and pid (`lifeId` in
  `planner/agent/lib/factory-otel.ts`). July builds its providers from the
  first config that has an exporter, so the id is stable from then on. A
  snapshot is taken before any secret binds, so no id is in it. What was
  removed: the restore-skew redraw (a clock step against the monotonic clock,
  meant for a snapshot taken after the id was drawn and restored more than
  once) and the per-life rebase. Whether a hosted VM resumes in place or
  starts a new process on the snapshot is not measured; if clones of a VM that
  had already exported ever exist, they share an id and overwrite each other's
  series.
- **Cumulative counters rewind across lives.** The rebase subtracted the old
  life's totals from a new life's first export. It is gone because no
  instrument records a value before the first request, so a new life starts at
  its own increments.

Ask: draw span and trace ids from the platform's CSPRNG when a span starts (or
accept an `idGenerator` in `defineOtel`); give each restore its own
`service.instance.id` (set by July or the host after restore, or an env var
hosting sets per VM). A restore hook (an event or a callback in
`defineAgent`) would let agents do the same.

## 9. Do not drop July's own spans under an unsampled inbound request

Status in 0.2.25: open (July). Sampling checked in 0.2.25 for the turn span
only (`collector.js` starts it from `ROOT_CONTEXT`); `agent_sdk.http` starts
under the extracted parent (`internal/otel/http.js:45-56`). The MCP case was
last read on 0.2.18 and is not re-verified.

July builds its tracer with a `ParentBased` sampler (ratio 1 for a root).
Cursor's backend leaves about 96% of inbound requests unsampled (an audit:
all 66 trace ids missing from Tempo had no trace `flags`, all 5 stored ones
had `flags=1`). What that drops depends on the span's parent:

- `agent_sdk.http` is a child of the inbound request's span, so it is **not
  recorded** under an unsampled request, and the logs written inside it carry
  a trace id the backend never stores.
- `agent_sdk.turn` starts from `ROOT_CONTEXT`, so it is a root and is
  **recorded under any request**, with its `agent_sdk.tool` and
  `agent_sdk.subagent` children and its `agent_sdk.turn.<phase>` spans.
- A host MCP client span (`runMcpClientSpan`, `internal/otel/mcp.js`) starts
  under whatever span is active. Outside a factory span, under an unsampled
  `agent_sdk.http`, it is not recorded. **Inside a factory span it is** (the
  factory span is a sampled root), as that span's child.

The factory starts each of its own spans as a new root with a link to the
inbound span (`startOptions` in `factory-otel.ts`). It does not change
`agent_sdk.http`, which stays unrecorded for unsampled requests. July's
sampler is `ParentBased(TraceIdRatioBased(1))` (`runtime.js:221`), so the
three cases are as listed. A hanging collector costs a delivery July's 1 s
flush at most.

Ask: sample agent spans regardless of the inbound flag (a root with a link, as
the factory does), or make the sampler configurable in `defineOtel`.

## 10. Stamp the turn's cost before `turn.completed` reaches the collector

Status in 0.2.25: open (July). Closed on the factory side as "dropped, not
renamed".

Since 0.2.20 the collector does not increment `cursor.cost.usage` and does
not read `event.data.cost` on `turn.completed`; 0.2.25 is the same: the
collector creates five counters (`collector.js:703-720`), and the name is
only in the reserved list in `internal/host-otel.js:14`. Token
usage is unaffected. Factory config must not mint that metric; Grafana spend
is tokens × `$price_*`
([`observability/grafana/`](../observability/grafana/README.md)).

Ask: stamp the cost (and model) before the event is fanned out to the
collector, or have the collector record cost from a later event.

## 11. End a tool span that never got a result with a status

Status in 0.2.25: the status is set (since 0.2.21, July); unchanged in
0.2.25. The count is open and not verified in a live turn.

July opens an `agent_sdk.tool` span on `actions.requested` and sets
`cursor.tool.status` and the span status on `action.result`
(`internal/otel/collector.js`). Since 0.2.21 a call that starts and never gets
a result is ended by `turn.completed` / `turn.failed` (`endOpenChildren`,
`collector.js:579-602`) with `cursor.tool.status=unknown` and span status
ERROR `"no result"`. `cursor.tool.calls` is incremented only on
`action.result` (`collector.js:270`), not in `endOpenChildren`, so such a call
is invisible to status-count panels. Whether the count is emitted for that
span has not been checked in a live turn; recheck in Grafana.

The live case (2026-10-03, factory-security-reviewer, trace `09c03e32…`, span
`f69cabba77e18bb6`; an older July) is the harness's built-in
`GetDynamicTools` (`cursor.tool.kind=builtin`, 15,476 ms, ended by the turn's
end). `TurnEventMapper` (`internal/event-mapper.js`) emits `action.result`
only when the harness reports `tool-call-completed`; at `finish()` it seals
open requests and replays only results it already holds, so a call with no
completion gets no result. Whether the harness never sent the completion or
the mapper's bookkeeping dropped it is not visible from the telemetry. The
test that pinned it, `july-otel.turn-end.test.ts`, drove the removed factory
providers and is gone.

Ask: when a turn ends with a tool or subagent span still open, record
`cursor.tool.status` (a distinct value such as `incomplete`), set the span
status before `end()`, and count it in `cursor.tool.calls`; or have the mapper
emit a synthetic `action.result` for calls with no completion at `finish()`.
The factory does not rewrite the span.

## 12. Export the turn's end before the hosted reply

Status in 0.2.25: closed for all three signals by removing the factory's
code. Until 0.2.25 July's meter provider was not the one that exported the
factory's metrics (the factory's own cumulative provider was), so July's flush
skipped it and the factory carried a turn-end hook and a span-end flush to
cover the gap. July now builds the meter provider, so its hosted flush covers
traces, metrics, and logs: it runs after each hosted admission and execution
(`hosted-delivery.js:472,539,623,696,1071-1090`), capped at 1 s, and flushes
every provider it built (`runtime.js:44,118-122`). Removed from the factory:
`agent/hooks/metrics-flush.ts`, `flushFactoryMetrics`, and the span-end flush
in `traceFactory` (`registerFactoryFlush`).

Why July's flush is late enough, checked in 0.2.25's dist:
`session-engine.js` `dispatchEvent` awaits every hook handler of an event and
only then calls `this.otel?.onEvent(event)`, where `turn.completed` records
`cursor.token.usage` and `agent_sdk.turn.count` (`otel/collector.js:349-370`);
the `session.*` event that follows each turn is dispatched later on the same
per-session chain (`queueDispatch`), and hosted execution awaits that chain
(`waitForCompletion`, called at `hosted-delivery.js:794`) before the durability
drain and the reply. `afterHostedWork` runs July's flush in its `finally`
(`:1071-1090`), after all of it. The two samples the factory's flush could not
cover are inside that window too: the execution request's own
`agent_sdk.hosted_execution.duration_ms` (`finalizeHostedExecutionLatency`,
`hosted-delivery.js:861,887`, inside the execution callback that
`afterHostedWork` wraps at `:696`) and `agent_sdk.http.duration`
(`endActiveHttpSpan`, `hosted-delivery.js:1075`, `otel/http.js:81`, before the
`finally`).

A delivery that runs no turn has no `session.*` event. `runAdmission` captures
every `waitUntil` promise (`background.push`, `hosted-delivery.js:262-264`) and
awaits them all (`:294`) before it builds the admission reply, and
`afterHostedWork` then runs July's flush (`:472,1071-1090`). So work awaited
inside the handler or inside a `waitUntil` promise is exported with the reply
(`triage-jira` `webhook.otel.test.ts` pins the wake's counter).
`factory-desk/agent/lib/july-otel.test.ts` shows it on July's real runtime:
metrics recorded with no factory flush leave with `runtime.forceFlush()`.

Residual gaps, still on the 10 s export: work a handler detaches from
`waitUntil`, a flush that exceeds the 1 s bound, and any request that does not
go through `afterHostedWork`. Concurrent deliveries each flush, so full
cumulative exports can overlap; Mimir may reject an occasional out-of-order
sample, and the next export carries the same cumulative value.

## 13. Bug 7: `requestId` and `turn.bound` on cloud turns

Status in 0.2.25: open (SDK and backend, with BDK following). No workaround
in code; Grafana joins on session ids. `@cursor/sdk` stays 1.0.37; July 0.2.25
did not change the two BDK lines below.

Cloud turns emit no `turn.bound` and carry no `requestId`, so a cloud turn
cannot be linked to its request.

Evidence (re-checked on 2026-10-13):

- `@cursor/sdk@1.0.37 dist/esm/448.js`: `CloudRun` sets
  `this.requestId = e.requestId` once, from the create response. Types:
  `dist/esm/cloud-api-client.d.ts:97`, `dist/esm/run.d.ts:40,53`.
- BDK reads it once, after `send()`, with no fallback after `run.wait()`:
  `internal/sdk-runner.js:391-394` calls `onRequestId` only when
  `run.requestId` is non-empty, and `internal/session-engine.js:2278`
  turns that call into `turn.bound`. A cloud handle has none, so none is
  emitted. Source: `packages/agent-serve/src/internal/sdk-runner.ts:559`,
  `session-engine.ts:2948`; `packages/cursor-sdk/src/agent/cloud-agent.ts:550`,
  `:585` (`CloudRun.requestId` is readonly and set once).
- The backend's V1 run payload builder has no `requestId`. Not verified here
  (external repo). The `packages/agent-serve` and `packages/cursor-sdk` lines
  above are from Cursor's own monorepo and were not re-checked here.

TLSSN-64 e2e on 2026-10-09 (0.2.22): bug 7 FAIL.

Ask: SDK `CloudRun` and the backend V1 run payload should carry a `requestId`
per run, so BDK emits `turn.bound` on cloud turns.

## 14. E5: tool failure text on the span status

Status in 0.2.25: fixed for the span status in 0.2.21 and for the
`action.result` log in 0.2.25 (BDK); nothing to ask.

The span status said only "tool error". 0.2.21 added
`toolFailureReason(event.data.output)` (0 hits in 0.2.20, 2 in 0.2.21-0.2.24):
`internal/otel/collector.js:250` (the call), `:263` (the span status) and
`:732-738` (the function, truncated to `SPAN_STATUS_REASON_MAX`). 0.2.25 also
puts the text on the `action.result` log record as `agent_sdk.error_message`
(`collector.js:281`; July's guide, `dist/docs/guides/opentelemetry.md:209-210`).

## 15. July calls the resolver on every hosted request

Status in 0.2.25: information. `reload()` calls the authored `defineOtel`
factory after each hosted secrets load (`runtime.js:86-93`; `server.js:658`,
`hosted-delivery.js:429`); 0.2.23 called it once at startup. `factoryOtelConfig`
is a pure function of the environment, so repeated calls return the same
config. July logs the redeploy warning only when the exporter list changes
(the header set to unset); see section 3.

## 16. The first hosted request of each process life has no `agent_sdk.http` span

Status in 0.2.25: new, P2. Open (July). Rated minor and accepted
(2026-10-14): the factory adds no code for it.

Ask (upstream fix): in `packages/agent-serve/src/internal/otel/http.ts:56-68`
(dist `internal/otel/http.js:31-35`), extract the inbound parent context
even when traces are off, so the W3C context is there for the handler, and
record `agent_sdk.http.duration` in `end()` once the first `reload()` has
bound the meter, not only when `startHttpSpan` found `traces` on.

On hosted v2 `runtime.config` is `disabledOtelConfig()` until the first
`reload()` (`internal/otel/runtime.js:39`), and that runs inside the first
delivery after `instrumentHttp` has started the request
(`internal/server.js:900`; `internal/hosted-delivery.js:429`).
`startHttpSpan` returns `undefined` while `traces` is false
(`internal/otel/http.js:31-34`), and `instrumentHttp` then runs the handler
with no span and no extracted parent (`http.js:16-20`). Nothing is lost on
later requests: the first `reload()` builds the providers once the header is
set. 0.2.23 loaded the config at startup, so every request had both. Source:
`packages/agent-serve/src/internal/otel/http.ts:56`.

What changes for the factory, on that one request per process life:

- No `agent_sdk.http` span, no `agent_sdk.http.duration` sample
  (`runtime.httpDuration` is `undefined` until `reload()`, `runtime.js:43`, `:163`),
  and no extracted `traceparent`. The Factory ops panels that read
  `agent_sdk.http.duration` lose the first request's samples: panel 63
  "Hosted HTTP p95 by service", panel 75 "HTTP requests per bucket by service
  and status", panel 29 "5xx" and panel 74 "HTTP requests by service, route and
  status (range)". Panels 29 and 74 also lose the health and manifest samples.
- The factory's root span on that request has no link to the inbound span, so
  it does not join Cursor's backend trace (`startOptions` in
  `factory-otel.ts` adds the link only when an inbound span context is valid).
- Until July builds its providers the global tracer and logger are no-ops, so
  a factory span, counter or console line from before the load is not
  exported. The factory's handlers run after `onSecretsReady`, so only
  July's own early lines (`[bdk] hosted admission received ...`) are lost.

No factory span can read the inbound `traceparent` with code that exists today:
`traceFactory` receives no request. A fix would need new header plumbing
through every channel handler, so none is added.
`factory-desk/agent/lib/july-otel.test.ts` drives July's real runtime and
shows the first-request behaviour: with no header no provider exists and
nothing is sent; after the header binds and July reloads, spans and console
lines leave.

## 17. July logs a duplicate propagator registration on every start

Status in 0.2.25: new. Open (July). Seen with `serve --dir planner --dev` and
a header set; not seen on a hosted pod.

`startSdk` installs the W3C propagator (`ensureW3cPropagator`,
`internal/otel/propagation.js`, from `runtime.js:131`), and the
`NodeTracerProvider` that July then registers (`runtime.js:227`) sets a
propagator of its own. The second registration fails and OTel's diag logger
prints `[bdk:otel] error: Error: @opentelemetry/api: Attempted duplicate
registration of API: propagation` with a stack, once per process life. The
tracer provider still registers and traces export (a collector received
`agent_sdk.http` and `factory.delivery` spans, `apj_factory.delivery` and
`agent_sdk.http.duration` metrics, and a console line as a log record: see
a local smoke run, not committed). The line is printed and, by the diag guard in
`console-otel.ts`, not exported. With the old factory providers July never
built a tracer provider, so the line did not appear. Ask: July should skip its
own propagator when it builds a `NodeTracerProvider`, or pass
`propagator: undefined`.

## 18. Metric exporters are DELTA and Grafana Cloud rejects DELTA sums

Status in 0.2.25: closed in July. The ask was granted as an environment
variable, not a `defineOtel` option, and the factory's workaround (a
cumulative meter provider of its own) is removed.

July reads `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`
(`cumulative`, `delta`, `lowmemory`; default `delta`; an unrecognised value
logs a warning and falls back to `delta`) from `process.env` in
`resolveOtelConfig` (`internal/otel/config.js:173-197`) and passes it to its
OTLP metric exporters (`internal/otel/runtime.js:171-206`). Its guide says:
"For Grafana Cloud, set `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` to
`cumulative`" (`dist/docs/guides/opentelemetry.md:30-32`). The value is part of
the settings key, so it is read when July builds the providers (the first
config with an exporter) and a later change logs the redeploy warning
(`runtime.js:60-71`).

**How the factory sets it.** The `defineOtel` resolver in `agent/otel.ts` runs
`process.env[...] ||= "cumulative"` and returns `factoryOtelConfig`. Why there,
and not as a deployment secret or a module-level default:

- July calls the resolver at each `reload()`, which on hosted v2 is after the
  secrets bind (`server.js:658`, `hosted-delivery.js:424-430`), and
  `resolveOtelConfig` reads the variable after it resolves the authored config
  (`config.js:36,59,187-197`), so the value is in place when July reads it.
- A deployment secret needs a step per slug, and a slug that missed it
  silently exports DELTA, which Grafana drops with HTTP 400. A module-level
  default is deleted from `process.env` if the same name is ever bound and
  later unbound (`hosted-deployment-secrets.js:54-58`); the resolver sets it
  again on each call.
- `||=` leaves an operator's value alone, including `delta`, and replaces an
  empty string, which July reads as `delta`.

**Grafana-side evidence** (measured 2026-10-14; an earlier probe the same day
measured the same 400 on the factory's header):

- The stack runs Mimir weekly r413.
- The `MimirOTLPConfiguration` CRD has only `resourceAttributes.promote` and
  `resourceAttributes.neverPromote`, and no delta or temporality field, so
  there is no tenant knob to turn on.
- Probe results against
  `https://otlp.example.com/otlp/v1/metrics` with
  the factory's header:

  | Metric sent | HTTP status |
  | --- | --- |
  | delta explicit-bucket histogram | 400 |
  | delta exponential histogram | 400 |
  | delta monotonic sum | 400 (`otlp parse error: invalid temporality and type combination for metric "apj_probe.delta"`) |
  | delta non-monotonic sum | 200 |
  | cumulative (sum) | 200 (stored as 1, 3, 6) |

So the Grafana-side options were checked and rejected; the fix is on the
sender, and 0.2.25 has it. A non-monotonic delta sum is accepted, but July's
counters are monotonic, so that was no way out.

What the removal cost: July has no View hook, so
`agent_sdk.hosted_execution.duration_ms` keeps the OTel default buckets
(section 19), and July's resource has no `service.instance.id`, which the
factory keeps adding (section 8).

## 19. Bucket advice for `agent_sdk.hosted_execution.duration_ms`

Status in 0.2.25: nice-to-have, not a blocker.

July creates the histogram with `unit` and `description` only
(`internal/hosted-execution-latency.js:56-62`), so it has the OTel default
buckets, 0 to 10 000 ms and `+Inf`. The factory does not re-add a View (Simon,
2026-10-15): the Factory ops panels "Hosted execution p95 by service (total)"
and "Exec duration" read `agent_sdk.turn` span durations from Tempo instead
([`observability/grafana/README.md`](../observability/grafana/README.md)).
Bucket advice up to 30 min on that histogram, or a `views` list in
`defineOtel`, would still let the metric itself answer >10 s questions
without Tempo's 25 h query limit.

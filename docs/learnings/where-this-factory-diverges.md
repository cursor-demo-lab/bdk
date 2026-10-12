# Where this factory diverges from production

Six things this factory does that Cursor's own factory avoids, with the
evidence from the read in
[everysphere-factory-patterns.md](everysphere-factory-patterns.md). A
divergence is not automatically a defect. This factory teaches a shape in
one sitting, and production optimises for pods that restart. The point of
the list is that each one should be a decision on the record.

## 1. Four peer edges between agents

We have `factory-desk/agent/mcp-connections/pr-autofixer.ts` and
`ticket-planner.ts`, `triage-jira/agent/host-connections/planner.ts`, and
`planner/agent/host-connections/desk.ts`. Not one of the 25 everysphere
agents declares `defineConnection({ agent })`. The nearest thing is Lasso,
which calls a sibling's `/<slug>/v1/mcp` with a raw MCP client, and Lasso
is pinned to `architecture: "v1"` for it
(`docs/agentsdk-v2-unsupported.md:77,129`).

Production hands off through a shared store plus a platform event
(change-monitor), a named channel inside one agent (winnie), a reminder
bound to the target's continuation (agentic-owners), or a Slack mention
(lasso).

They are not working around a missing API. `{ agent: "<slug>" }` is a
supported connection transport in 0.2.1 with its own type guard
(`types.d.ts:1043`), and those agents are on the same 0.2.1 release we
are. Lasso's raw client to `/<slug>/v1/mcp` is the older road, which is
why it carries the v1 pin.

The peer graph is the clearest thing this factory has to teach about agents
working together, and it is also the thing most likely to move under a
version bump. Keep it, and say in `plan.md` that it is the teaching choice.

## 2. A hook that causes a cross-agent side effect

`triage-jira/agent/hooks/plan-after-triage.ts` starts the planner from an
`action.result` event. All 13 everysphere hooks are memory, telemetry, or
recording, and `record-check-events.ts:5` says observe-only so a failed
write cannot fail the turn. autopilot rejects hook bridging by name
(`agent/channels/github.ts:207`). This one is worth changing, and it is
item 1 in [production-idioms-to-adopt.md](production-idioms-to-adopt.md).

Fixed 22 Sep 2026. The hook file is deleted and `record_triage` calls the planner inline at the end of its own `execute`, only when this call wrote the `Triage:` comment.

## 3. A memory hook on an event-driven agent

`triage-jira/agent/hooks/memory.ts` is the scaffold hook. The 19
event-driven everysphere agents deleted it. The 6 that keep it are chat
assistants, and grclanker documents why it keeps one. Triage answers a
webhook and writes a comment. It has nothing to remember.

Fixed 22 Sep 2026. `triage-jira/agent/hooks/` no longer exists; the memory hook went with the chain hook.

## 4. An approval card on the cloud launch

`factory-desk/agent/extensions/cloud.ts` sets `needsApproval: true` on
`cursorCloudAgents`. patches sets it to false
(`agent/extensions/cloud/extension.ts:15`), jenny and robomax leave the
default, and winnie gates by instruction. Production puts its cards on
tracker and evidence writes, not on launches.

For a classroom the card is the lesson, because it is where the room sees
budget being spent. The production analogue of "approve TLSSN-42" is
deploy-buddy's chat word, checked against the authenticated principal and
the recorded thread (`agent/lib/deploy-gates.ts:41`). We should keep the
card and copy that check.

## 5. Splitting the continuation key to find the thread

Covered as item 3 in the adoption list. Named in
`docs/agentsdk-v2-unsupported.md:79` as the reason an agent is pinned to
v1.

Fixed 22 Sep 2026. `threadFromSession` in `factory-desk/agent/lib/threads.ts` reads the thread from the session's `auth.attributes` (`channel_id`, `thread_ts`) and the continuation key is never split.

## 6. Route evals against a served host, and `dryRunResult`

`plan.md` includes eval cases that run against a served factory with
`--url`. No everysphere agent does that. Evals there run on the ephemeral
server, and a multi-mount project passes `--slug` to pick one agent
(`change-monitor/package.json`). Both flags exist in 0.2.1
(`dist/docs/reference/cli.md:176,178`), so this is a difference in how the
two factories test, not in what the tool can do. Route cases prove the
serve host answers, which is worth teaching; keep them, and add the
ephemeral runs beside them rather than instead of them.

`dryRunResult:` appears nowhere in that factory either. It is not newer
than their pin: those agents depend on `workspace:@cursor/bdk@*`, which is
0.2.1, the same version that declares it (`tools.d.ts:92`). They express
the same idea as a `purpose === "eval"` branch inside `execute`, which
grclanker wrote before and kept. Here the declaration is better, because a
gate the framework applies cannot be skipped by a tool that forgot it.
That makes this the one item on the list where our shape is ahead, and it
is item 4 in [production-idioms-to-adopt.md](production-idioms-to-adopt.md).

## Two things that already match

Tracker tool discovery by the shape of the name with field aliases:
`sherlock/agent/lib/file-ticket.ts:34` uses the same technique as
`factory-desk/agent/lib/jira.ts`, and for the same reason, which is that
connector tool names move under you.

Keeping the model away from anything that writes: `tools: []` or a
read-only allowlist, with writes behind host connections, is what 8
everysphere agents do and what every project here does.

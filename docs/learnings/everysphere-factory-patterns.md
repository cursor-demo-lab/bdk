# Patterns in Cursor's own factory

Read 22 Sep 2026 across the 25 Agent SDK agents in `<PRIVATE_MONOREPO>`
under `factory/`. Paths below are relative to that directory. Nothing was
changed there. The point of the read was to find out which of this
factory's shapes are production idioms and which are our own invention.

## 1. Agents do not call each other

No agent in the 25 declares a peer connection. A grep of every
`agent/mcp-connections/*.ts` and `agent/host-connections/*.ts` finds no
`defineConnection({ agent })`. Every connection is `cursorAccount: true`
with a `servers` list, a `url`, or a stdio `command`.

The transport is not missing from their version. `{ agent: "<slug>" }` is
one of the four connection transports in 0.2.1, described as the "slug of
a peer agent mounted on the same serve host", and it ships a type guard,
`isPeerConnectionTransport` (`types.d.ts:1043`). Those agents are on the
same 0.2.1 line we are. They had the option and did not take it.

Work moves between agents four other ways.

A shared store plus a platform event. `change-monitor/README.md:17`: each
component is its own `defineAgent`, and "they share the host code under
`src/` and hand work to each other only through the Factory API and its
events". `change-monitor/docs/design.md:333`: "The two agents never share
a session. They share the Factory API. The Factory API owns the facts. The
agents own the judgment." `docs/curator-triggering.md:81`: "The executor
does not POST to the curator. Curation starts when Factory emits the
Checkpoint or Issue event."

A named channel inside one agent.
`winnie/agent/tools/start_implementation.ts:105` calls `ctx.send`
("implement", message, `{ continuationToken: experiment:<slug> }`), and
`winnie/agent/channels/implement.ts` is one line,
`defineChannel({})`, described as the handoff target.

A one-shot reminder bound to the target's continuation.
`agentic-owners/agent/lib/slack-wake.ts:24`: a Slack delivery's captured
send is bound to the Slack thread, so the Slack handler cannot start the
pull request turn. It arms a named reminder bound to the pull request
continuation, and the fire runs the same pipeline.

A Slack mention. `lasso/agent/tools/slack_handoff.ts:27` posts an
`@mention` of the target agent in the current thread with delegation
metadata, and the target's own Socket Mode channel wakes because its
`engagement.botMentions` allows Lasso. Lasso's other route is a raw MCP
client to `/<slug>/v1/mcp` calling the peer's `ask`
(`agent/tools/delegate.ts:30,59`), and Lasso is pinned to
`architecture: "v1"` because of it. `docs/agentsdk-v2-unsupported.md:129`
says not to treat `/v1/mcp` as a v2 public alias.

Two more points about where follow-up work belongs. Hooks observe. Of 13
hook files, 6 are the scaffold `memoryHook()` and the rest record or count
events. `change-monitor/executor/agent/hooks/record-check-events.ts:5`:
"Observe-only: a failed write is logged and skipped so it cannot fail the
turn." When the follow-up matters, the work runs inline after the turn
settles, not in a hook. `autopilot/agent/channels/github.ts:207` gives the
reason: `waitForCompletion` does not wait for hook dispatch, "so a
hook-based bridge could lose the only recording step to process exit or
the next flush".

`defineResult` is the post-turn commit gate.
`change-monitor/planner/agent/lib/commit-plan.ts:3`: the plan is published
by a write of `/plans/<change>.md`, not by the turn's text, and a change
with no plan throws a repairable error so the model can still write it in
the same turn.

## 2. Slack threading

Every agent has its own bot. 24 of 25 have `channels/slack.ts` with a
distinct `envPrefix`, and the Slack manifests are committed: the root
`.gitignore` ignores `**/.agent-serve/**` but keeps
`!**/.agent-serve/slack/`.

Reply mode is always explicit, one of `post`, `stream`, or `agentic`. Four
agents add the `slack-communication` extension with a written tone, for
example `jenny/agent/extensions/slack.ts`.

Proactive posts go through `host.slack`, pointed at a bot by a send-only
channel's `envPrefix` (`change-monitor/executor/agent/channels/slack.ts:6`,
wired in `src/notify/slack.ts:113` from the channel's `onStart`). Older
agents call the pack helpers directly, and they soft-fail:
`pr-hello/hello/agent/lib/pr-slack-delivery.ts:125` says an agent served
without Slack tokens still runs its turns, "only the delivery sits out,
and it says so rather than raising".

A handler that answers without needing the model posts and returns null.
`demo-agent/agent/channels/slack.ts:14`: `await ctx.thread.post(HELP);
return null;` with the comment that null stops July starting a model turn.

Binding an external id to a thread is a kv write made while the
originating session is still alive. `debug/agent/tools/watch-pr.ts:9`:
"The Origin channel answers the merge, which arrives long after this turn,
so the pairing has to be written while the session that opened the pull
request is still running." deploy-buddy stores the asking thread on the
pull request record and later compares
`session.continuationKey !== slackContinuationKey(channelId, ts)`
(`agent/lib/deploy-gates.ts:60`), using the framework helper rather than
splitting a string.

Dedupe claims the thread before doing the expensive part, and fails closed
on the claim write. `foreman/agent/lib/shipped-feed.ts:376`: claim before
the changed-files and policy reads, so two overlapping deliveries cannot
both pass the dedupe read, and "without a durable claim a webhook
redelivery could double-post". `foreman/agent/lib/thread-claims.ts:12`: a
failed read treats the thread as unclaimed, a failed write aborts the
dispatch.

`docs/agentsdk-v2-unsupported.md:79` records parsing a Slack key as
`{channelId}:{threadTs}` as a v1-only habit, and `:121` says to stop:
"Debug and Lasso break on every new v2 thread."

## 3. Human gates

`needsApproval: true` is rare and concentrated. Only grclanker uses it,
across its 10 write tools, and its channel opts in with `toolApprovals`
(`agent/channels/slack.ts:129`). A test pins the policy:
`agent/tools/writes.test.ts:78` asserts every authored write declares
itself and parks for approval.

The card sits on top of a structural gate, never instead of one.
`grclanker/agent/lib/authz.ts:76` refuses a write unless the session's
channel is the one private channel and the authenticated user matches, and
`:63` makes a local override a hard error once the deployment id is set.

Cloud launches are not carded. `patches/agent/extensions/cloud/extension.ts:15`
sets `needsApproval: false`, jenny and robomax leave the default, and
`winnie/agent/tools/start_implementation.ts:38` gates by instruction
instead: open a cloud agent after explicit human go-ahead. No agent in the
factory cards a launch.

Approval as a chat word is verified against the principal and the recorded
thread. deploy-buddy asks the author to reply "deploy" in the thread
(`agent/lib/slack-ask.ts:47`), then `deploy-gates.ts:41` requires the
approver to match `requireHumanSession(session)` and the reply to arrive in
the recorded ask thread. `request_author_approval.ts:26` fails closed when
no ask can be posted, so there is no silent deploy.

A bypass word is a deterministic command, not a turn.
`agentic-owners/agent/lib/slack-wake.ts:45`: a bypass is "a deterministic
command action with no wake and no model turn".

## 4. State

kv keys are path shaped or colon shaped, one per resource, and every
reader parses defensively into `T | undefined`. Examples:
`closed-pr/<owner>/<repo>/<n>` (`autopilot/agent/lib/closed-pr-gate.ts:22`),
`question-claims/<channel>/<ts>` (foreman),
`demo-result/<runId>` (demo-agent),
`notify:slack:<change>:<user>` (change-monitor),
`delegations/<session>/<ts>` (lasso).

Only what must survive goes in kv. `sandy/agent/lib/run-records.ts:31`:
run activity "is deliberately NOT stored in KV: it is observability, not
truth. KV keeps only what must survive: claims and these drop records."
`docs/agentsdk-v2-unsupported.md:53`: process-local maps, timers, and token
caches are gone when the VM is replaced, and next-wake facts belong in
`host.kv`. There is no compare-and-set, so deploy-buddy writes a
holder-tagged lock and reads it back (`agent/lib/deploy-state.ts:247`).

That last point is true of the surface an agent is handed and not of the
framework. In 0.2.1 `host.kv` is typed `HostKvApi`, which is `get`, `put`,
and `delete` (`types.d.ts:533`). A storage backend can supply the
conditional superset `HostKvCasApi`, which adds `getWithVersion`,
`putIfAbsent`, `putIfVersion`, and `listKeys`, and `supportsKvCas(kv)`
probes a store of unknown provenance (`types.d.ts:571,591`). So a claim
can be a real create-if-absent rather than a write and a read back, if the
backend under the deployment offers it.

Artifacts carry zod schemas everywhere. `agentTool: true` only where the
model does the tagging. Where the payload is deterministic host output the
tool is left off and the file says so:
`agentic-owners/agent/artifacts.ts:9` ("No `agentTool`: every payload is
deterministic host output"), `demo-agent/agent/artifacts.ts:5`. Keys read
like `pr:<owner>/<repo>#<number>` and `max` is sized on purpose.

Memory hooks survive in 6 of 25, all chat assistants. The 19 event-driven
agents deleted the scaffold. grclanker documents its keep
(`agent/hooks/memory.ts:5`): `tools: []` hides the workspace `memory/`
symlink from the model, so reading is a `recall` server tool.

Continuation tokens are the resource, with no run suffix.
`autopilot/agent/lib/pr.ts:36`: `pr:<owner>/<repo>#<n>` with "No head-SHA
suffix: pushes must resume the same conversation, not boot a fresh VM". In
v2 the same idea is `claim: { type: "pr", resource }`
(`demo-agent/agent/lib/cloud.ts:129`). One agent opts out of continuation
entirely: `security-reviewer/agent/channels/github.ts:39` sets
`continuation: "github.none/v2"` because appending re-reviews to one
session made an earlier run's findings read as this run's output.

## 5. Planning

The planner and executor split is a session decision, and the plan lives
in the store. `change-monitor/docs/design.md:126`: publishing is a
compare-and-set on a weak etag, so revisions are immutable, numbered, and
an older authoring result can never replace a newer plan. `:215`: the
session's first wake reads the current plan from the API, and a deployment
with no current plan is recorded as skipped rather than retried. `:213`:
"Knowledge crosses deployments only through the Factory API, never through
a shared transcript."

A re-plan is steering into the same planner conversation, which publishes a
new revision (`design.md:137`). A pull request comment that mentions the
agent is the instruction.

One agent plans and acts inside itself. deploy-buddy runs `plan_deploy`
then `deploy_services`, and its gates re-fetch every fact live rather than
trusting the prompt.

## 6. GitHub

Host scope (`cursorAccount: true`) and inline `{ repos }` are both in use
for different reasons. `demo-agent/agent/channels/github.ts:72` pins the
scope inline so serve and deploy need no flags, and notes the scope also
bounds the lease that `ctx.host.github` posts comments with.
agentic-owners prefers `true` so a freeze-time empty list cannot be pinned.

No agent in the factory holds `contents-write`. The tier is `pr-write`
where it is stated, and `deploy-buddy/README.md:129` says it "never pushes
code, so it holds no `contents-write` token". Pushes happen from the cloud
VM's own credential.

`deliverReplies: false` with `progress: { reactions: false }` is the norm,
and the host posts its own comment. `commitStatus` appears once, in
`security-reviewer/agent/channels/github.ts:52`, with `checks: true`,
`requireSuccessfulTools`, a `detailsUrl`, and
`failureConclusion: "neutral"`, still on `cursorAccount: true`.

Which pull requests an agent acts on is decided by an author allowlist that
fails closed (`autopilot/agent/channels/github.ts:129` "Fails closed when
the allowlist is active and the author cannot be determined"), an explicit
trigger such as a label or a slash command, or a narrow `webhookEvents`
list. `demo-agent/README.md:27` says pull request `opened` is not a default
wake because it is too noisy, and
`agentic-owners/agent/channels/github.ts:183` flag-gates `check_run`
because it is thousands of wakes per hour.

Identity is deterministic so duplicates collapse. `design.md:339`:
delivery is at least once and unordered, "so a duplicate collapses onto the
fact it duplicates". demo-agent derives a run id from a hash of forge,
label, and delivery id.

## 7. Tracker writes

There is no Jira in the factory. Linear is the tracker, and the shape is
the same as ours: a host-only connection, narrow write functions, and a
team allowlist checked before the connector is called.
`grclanker/agent/lib/linear.ts:1`: writes are two narrow operations that
only touch one team, "an identifier outside `LINEAR_TEAM_KEY` is refused
here, before the connector is called, and creation pins `team` to the GRCE
team".

Connector tools are discovered by the shape of their name, with field
aliases, because the names move. `sherlock/agent/lib/file-ticket.ts:34`:
"Linear's connector used to ship `create_issue` and now ships
`save_issue`", so the matcher is `/(?:create|save)[_-]?issue$/i`. This is
the same technique as `factory-desk/agent/lib/jira.ts` here.

Account connector tools are qualified.
`agentic-owners/agent/host-connections/buildkite.ts:19`: the account bridge
exposes `<serverIdentifier>-<tool>` names, and "bare tool names match
nothing and empty the catalog". A declaration-only twin exists so the
connector still shows on the authorize page.

Marker comments carry dedupe across a lost pod.
`change-monitor/README.md:167`: the sticky comment is remembered by id in
kv, and "the marker in its body names it on a pod that has lost that
memory".

## 8. Evals

Writes short-circuit on the session purpose, in one shape used everywhere.
`grclanker/agent/lib/authz.ts:40` defines `isEvalSession` and
`evalDryRun(action, wouldDo)` returning `{ evalDryRun: true, action,
wouldDo }`, and all 10 writes use it. `lasso/agent/tools/delegate.ts:45`
explains why the flag is the purpose and not an env var: "serve imports
those files at boot, which would leave production dry-run".

0.2.1 can do this without the helper. A session carries `purpose`, which
is `"live"` or `"eval"` (`types.d.ts:1568`), and separately a `dryRun`
flag. In a dry-run session the host answers a tool declared
`effect: "write"` from its `dryRunResult` and never calls `execute`, and
the action result says the tool never ran (`tools.d.ts:92`,
`types.d.ts:1441`). grclanker's helper predates none of this; the version
is the same. It is worth knowing that the framework offers the shorter
road before copying the longer one.

Assertion counts across 42 eval files: `t.check` 457, `t.reply` 379,
`t.succeeded` 171, `t.notCalledTool` 80, `t.calledTool` 51,
`t.noFailedActions` 30, `t.metric` 27, `t.maxToolCalls` 5, `t.parked` 3,
`t.requireInputRequest` 3, `t.judge.model` 2. Injection gates list
`notCalledTool` for every write tool plus `noFailedActions()`
(`grclanker/evals/gates.eval.ts:36`).

Only one agent uses a model judge. patches ships deterministic reply
checkers instead, each with its own unit test.

Fixtures are files, not live URLs. `security-reviewer/evals/SKILL.md:14`:
"Do not scale by blasting many live PR URLs", and do not weaken gold
location or severity gates to make a flaky live run pass. Fixtures live at
`fixtures/prs/<n>-<id>/{diff.patch,gold.json,meta.json}`.

`timeoutMs` runs from 180,000 to 600,000 and `maxConcurrency` from 4 to 20,
each tuned with a stated reason. A multi-mount project evals one agent at a
time with `--slug`. No agent anywhere uses `--url` route cases.

## 9. Testing host code

17 agents run `node --import tsx --test "agent/**/*.test.ts"`, and 6 use
vitest. Tests sit next to the code.

Tool tests build a stub context and assert refusals, the exact list of
connector calls, and the dry-run shape.
`grclanker/agent/tools/writes.test.ts:21` builds
`{ session, host: { kv, mcp: { callTool() { calls.push(...) } } } as unknown
as ToolContext`, and `:57` adds a structural test that reads every file in
`tools/` for `effect: "write"` and asserts the approval policy covers each
one.

Channel tests go through the pack.
`pr-hello/hello/agent/channels/github.test.ts:27` calls
`dispatchGitHubWebhook({ options: getGitHubChannelOptions(channel), … })`
with a tracking `send`, and `:8` asserts the channel's own settings.

kv is faked from the framework's file-backed implementation
(`sandy/agent/lib/testing/file-host-kv.ts`). Config is pinned by test:
`access-reviewer/agent/hosted-manifest.test.ts` checks the published July
range, `grclanker/agent/agent.test.ts` matches `toolApprovals: true`.

## 10. Layout

No agent has an `AGENTS.md`. 19 of 25 have a README, from 82 lines to 503.
The root `README.md:54` sets `local.cwd` outside the monorepo "so sessions
do not inherit ambient `AGENTS.md` / `.cursor` rules".

Each agent has a `mise.toml` with `start`, `test`, and `validate`, and
sometimes `typecheck`. `package.json` carries `check` running `tsc
--noEmit`, plus `test`, `start`, and `validate`.

`architecture` is pinned explicitly to `"v2"` where an agent has cut over
and to `"v1"` where it cannot, with a reason row in
`docs/agentsdk-v2-unsupported.md:72`.

The median agent has about 26 authored files. The smallest is 6
(access-reviewer) and the largest 128 (grclanker).

What is kept away from the model: `tools: []` in 8 agents, read-only
allowlists such as `["read","ls","glob","grep"]` in patches, host
connections for anything that writes, and `hosting.secretNames` and
`egressDomains` declared in `agent.ts`.

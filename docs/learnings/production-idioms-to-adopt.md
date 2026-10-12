# Production idioms worth adopting here

Eight changes, ranked by what they buy for what they cost, from the read in
[everysphere-factory-patterns.md](everysphere-factory-patterns.md). Each
one names the file to copy from in `everysphere`'s `factory/` and the file
it changes in this repository.

**Status, 22 Sep 2026.** Items 1 to 7 landed through
[improvement-plan.md](../improvement-plan.md), with one difference from
the text below: item 4 uses the framework's `dryRunResult` on every write
tool rather than a hand-rolled helper, held by a structural test per
project that treats a missing `effect` as a write, so `drive_pr` and
`post_findings` are covered too. Item 8 is still open; see
[questions/relay-credential-scope.md](../questions/relay-credential-scope.md).

## 1. Move the triage to planner handoff out of the hook

Copy from `autopilot/agent/channels/github.ts:207`, which rejects hook
bridging because `waitForCompletion` does not wait for hook dispatch, and
`change-monitor/executor/agent/hooks/record-check-events.ts:5`, which
states what a hook is for.

Changes here: delete `triage-jira/agent/hooks/plan-after-triage.ts`, call
`chainDecision` and the peer tool inline at the end of
`triage-jira/agent/tools/record_triage.ts`, and move the hook's test onto
the tool. About 30 lines move. The planner edge stays; only the trigger
changes, and it stops depending on hook dispatch surviving process exit.

## 2. Claim before posting, and shape the kv keys

`factory-desk/agent/tools/announce_plan.ts` writes its `announced:<KEY>`
row after `chat.postMessage` returns, so a redelivery in that window posts
twice. Copy the order and the failure rule from
`foreman/agent/lib/shipped-feed.ts:376` and
`foreman/agent/lib/thread-claims.ts:12`: claim first, treat a failed read
as unclaimed, and abort the dispatch on a failed write.

While in there, move the keys to the path shape every everysphere reader
uses (`autopilot/agent/lib/closed-pr-gate.ts:22`): `ticket/<KEY>`,
`announced/<KEY>`, each read through one parser that returns undefined on
anything unexpected. Changes `factory-desk/agent/lib/threads.ts`.

Prefer a conditional write to the read-then-write dance if the deployment's
store offers one. foreman reads a claim and writes it because its kv has
no compare-and-set, but 0.2.1 defines `HostKvCasApi` with `putIfAbsent`,
and `supportsKvCas(ctx.host.kv)` answers whether this store implements it
(`types.d.ts:571,591`). `putIfAbsent` is the claim: one call, no window
between the read and the write. (Later finding: `ctx.host.kv` never
implements it on any backend, through 0.2.11, so the factory's claims stay
read then write; [`../bugs.md`](../bugs.md) ask 11.) Keep foreman's failure rule either way,
because a failed claim write still has to abort the post.

## 3. Stop splitting the continuation key on a colon

`factory-desk/agent/lib/threads.ts` recovers a Slack thread by splitting
`channelId:threadTs`. `docs/agentsdk-v2-unsupported.md:79` lists that as
the reason `debug` is pinned to v1, and `:121` says it breaks on every new
v2 thread. Use `slackContinuationKey()` from
`@cursor/july/channels/slack` the way
`deploy-buddy/agent/lib/deploy-gates.ts:60` does, and read the thread from
channel state the way `debug/agent/lib/utils.ts` does.

Changes `threads.ts`, `file_ticket.ts`, and `threads.test.ts`. This is the
one item on the list that will break on its own if we leave it.

## 4. One dry-run shape, and a prompt injection eval

Declare `effect: "write"` and a `dryRunResult` on every tool that writes,
which is `file_ticket`, `announce_plan`, `record_plan`, `plan_issue`,
`record_triage`, `post_findings`, and `drive_pr`. In a dry-run session the host answers
from `dryRunResult` and never calls `execute`, and the action result
records that the tool never ran (`tools.d.ts:92`, `types.d.ts:1441`). That
is the framework doing what grclanker's `evalDryRun` helper does by hand,
and it cannot be forgotten inside one branch of one `execute`.

Keep `ctx.session.purpose === "eval"` for the guards that sit outside a
write tool's `execute`, which is where grclanker uses it
(`agent/lib/authz.ts:40`) and where the peer call in
`triage-jira` needs it. Read the purpose off the session rather than an env
var, for the reason `lasso/agent/tools/delegate.ts:45` gives: serve imports
the eval files at boot, so an env var would leave production dry-run.

Then add
`factory-desk/evals/gates.eval.ts` modelled on
`grclanker/evals/gates.eval.ts:36`: one pasted message that tries to
instruct the desk, with `notCalledTool` for every write and launch tool
and `noFailedActions()`.

## 5. Structural tests on the writes and the channels

`grclanker/agent/tools/writes.test.ts:57` reads every file in `tools/`,
finds each `effect: "write"`, and asserts the approval policy covers it.
That test catches a new write tool that forgot its gate, which a
hand-written list cannot.

`pr-hello/hello/agent/channels/github.test.ts:27` drives a channel through
`dispatchGitHubWebhook` with a tracking `send`, and asserts the channel's
own settings at `:8`.

Add `factory-desk/agent/tools/writes.test.ts`, and channel tests for
`pr-autofixer` (a red `check_run` fixture claims the pull request, and an
undriven pull request from another project returns null) and for
`security-reviewer`.

## 6. Make the desk's Slack channel explicit

Every everysphere agent states its reply mode, its engagement, and its
prompts. Copy `demo-agent/agent/channels/slack.ts:64` and
`grclanker/agent/channels/slack.ts:138` for the settings, and
`pr-hello/hello/agent/extensions/slack.ts` for a written tone.

Set `reply: { mode: "post" }` and an explicit `engagement` on
`factory-desk/agent/channels/slack.ts`, add
`factory-desk/agent/extensions/slack.ts` with the desk's tone, and commit
the Slack manifests by copying the root `.gitignore` rule that ignores
`**/.agent-serve/**` and keeps `!**/.agent-serve/slack/`.

## 7. Per-project tasks and declared hosting

Every agent there has a `mise.toml` with `start`, `test`, and `validate`,
and a `package.json` `check` script running `tsc --noEmit`. Copy
`grclanker/mise.toml` and `dottie/package.json`. Declare
`hosting.secretNames` and `hosting.egressDomains` in `agent.ts` the way
`change-monitor/planner/agent/agent.ts:36` does. Mechanical work across
the five projects and the root.

## 8. Re-check the commit status claim in Phase 3

`security-reviewer/agent/channels/github.ts:52` is the one place in the
factory that posts a commit status. It sets `checks: true`,
`requireSuccessfulTools`, a `detailsUrl`, and
`failureConclusion: "neutral"`, and it stays on `cursorAccount: true`
without `contents-write`. No agent in that factory holds
`contents-write` at all.

`plan.md` says in Phase 3 that the token opts up to `contents-write`.
Check that against the framework before keeping the sentence, and record
whatever we change in `docs/edits.md` as a template edit point. See also
[relay-credential-scope.md](../questions/relay-credential-scope.md).

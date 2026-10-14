# Rationale

Why the factory in `plan.md` has the shape it has. Read `plan.md` first.

## Problem

Amplitude's delivery pipeline is intake, ticket, PR, review, risk, merge
or escalate. The `Software_Factory_Atlassian` sibling already teaches it
on Jira and Bitbucket as seven hand-built specialists behind a routing
desk. This folder has to teach the same pipeline on Amplitude's original
stack, Slack, Jira, and GitHub, for APJ GTM sessions, under constraints
the sibling did not have:

- A customer SE must be able to reproduce it from
  `npx -p @cursor/july@0.2.24 agent-sdk init` plus a short glue list, in an afternoon.
- It must honor the July GitHub guide: debounce per PR, persist the buffer
  in `host.kv`, one `pr:owner/repo#N` conversation, keep payloads out of
  wake prompts, decide the repo allowlist explicitly.
- Amplitude's stages must stay visible for teaching even where the product
  already carries a stage as a setting.
- It must never create Jira tickets, never write from an eval session,
  keep every write in host code, run on Node 22.13+ and never Bun, and put
  any custom glue agent on `grok-training-latest`.
- Slack is intake and human-in-the-loop, not the system of record.

We wrote three candidates, kept in `candidates/`. This document is the
synthesis.

## Usage (caller's view)

A person in `#eng-intake` mentions the desk and asks it to file a bug.
`file_ticket` parks on an Approve or Deny card in that thread. On approve
the desk creates the issue in `TLSSN` through the host-only Jira
connection and saves the thread under `ticket/<KEY>` in `host.kv`, so
every later post about the ticket has a thread to go back to.

Jira's webhook then wakes `triage-jira`, which leaves one `Triage:`
comment. `record_triage` then calls the planner over the peer edge inline,
at the end of its own `execute`, and only when this call wrote the
comment. The planner reads the ticket
and a read-only checkout, records the plan as an artifact and as a `Plan:`
comment on the ticket, and calls the desk, which posts the plan into the
thread that filed it. No person acts in any of this.

The person replies `approve` with the key. The desk fetches the recorded
brief from the planner with `Get plan` and calls the cloud launch tool,
which parks on a second card. On approve a Cursor cloud agent opens a pull
request on the sandbox repo with the ticket key in the branch and title.

When the pull request opens, Bugbot reviews it from a repo setting and
`security-reviewer` posts one `## Security review` comment on a relay
wake. Jira's own GitHub integration links the pull request to the ticket
by key.

A failed check on a pull request the factory opened starts
`pr-autofixer` without a request. The fixer knows the pull request is the
factory's because the branch or title starts with the ticket key, and it
claims the pull request in `host.kv` so two deliveries cannot both drive
it. From then on every pull request, comment, review, check, and failing
status event for that pull request is debounced and resumes the same cloud
conversation, which pushes verified fixes to the pull request head.

Branch protection requires CI, Bugbot, and one human review before merge.
Nothing in the factory merges. GitHub's Slack app posts failing checks and
review requests into `#factory-escalations`, where people decide and act
on GitHub, or mention the desk again.

A ticket filed directly in Jira takes the same path from the webhook on.
It has no thread, so the plan announcement goes to
`FACTORY_DESK_INTAKE_CHANNEL`, or nowhere when that is unset. The plan is
still on the ticket. See
[questions/announce-without-a-thread.md](questions/announce-without-a-thread.md).

There are three human gates in Slack, filing the ticket, approving the
plan, and approving the launch, and one on GitHub, the review that branch
protection requires.

## Shape

Five projects on one host.

| Project | Origin | Role |
| --- | --- | --- |
| `factory-desk` | plain `init` + authored files | Slack intake, `file_ticket` and the cloud launch behind `needsApproval`, `announce_plan`, peer edges to `pr-autofixer` and `planner` |
| `planner` | plain `init` + authored files | Reads the ticket and a read-only checkout, records the plan as an artifact and a `Plan:` comment, calls the desk to post it |
| `triage-jira` | template, `record_triage` edited | Ticket stage on two pinned routes; `record_triage` hands the ticket to the planner inline at the end of its own `execute` |
| `pr-autofixer` | template, edited (auto-drive, scope refusal, lease claim) | The one GitHub write owner: `contents-write`, `WebhookBuffer` persisted in `host.kv`, `pr:owner/repo#N`, an automatic drive on a factory pull request's failed check, claimed in `host.kv`, best effort, verified after write (no compare-and-set on agent kv), and `startDrive` refusing a pull request outside the configured repositories with `out_of_scope` |
| `security-reviewer` | template, one six-line `repos.ts` edit | Read-tier observer: `pr-write`, `pull_request` events only, one comment per push |

Bugbot, the risk gate, and merge are product and GitHub settings. They
appear in the teaching table with an honest "setting, not agent" label.

There are four peer edges and no cycles, one Slack app, and one Jira MCP
connection on each project that touches Jira. There is no `FACTORY_LAUNCH` flag, because the
credential scope minted by `cursorAccount` and the account's connections
are the gate.

## Synthesis decision

**Base: Candidate C.** Its scaffold (`init` per stage), edit-point
discipline, `factory.json` plus `docs/edits.md`, baseline commit, and
three-way-diff upgrade path are taken as written. So is its answer to
"why no peer to triage or security": both templates pin correctness to a
continuation key an `ask` session cannot supply.

**From B: the single GitHub write owner with a persisted debounce.** B
argued, correctly, that GitHub event volume decides the shape and that
one project must own the PR conversation. B then built that owner as a
custom `github-factory` with `modes.ts`, `gates.ts`, `buffer.ts`, and five
tools. The `pr-autofixer` template already ships the parts of that which
matter: `WebhookBuffer` (3 s debounce, `host.kv` key `webhook-buffer`,
restore on `onStart`, discard on `closed`), `continuationTokenFor` returning
`pr:owner/repo#N`, `{ task }` on every hook, `SessionBusyError` requeue,
merge-conflict reminders cancelled on close. Taking B's principle and
delivering it through the template rather than B's code is the whole
point of this synthesis.

**From A: the teaching table, eval-never-write, and HITL on launches.** A's
stage-by-stage table is the best teaching artefact of the three and
becomes `amplitude-stages.md`. A's three-mechanism "evals never write"
discipline (session purpose, dry-run result shape, fresh state root for
route evals) is carried into the eval plan. A's HITL on the implement
route becomes `needsApproval: true` on the desk's cloud extension with
`toolApprovals: true` in Slack. A's `tools: []` and
`grok-training-latest` on the custom agent are kept for the desk.

**Rejected from A:** four `cursorAccount` relays each returning `{ auth }`
on raw check events, one per specialist; `implementer`, `ci-watch`, and
`approver` as agents; host `/v1/agents` POSTs; the `FACTORY_LAUNCH` and
`FACTORY_MERGE` flags; the HMAC escalate route. Each is a body of custom
host TypeScript a customer would have to own and that already exists in
the product as a template or a setting. A's own open question 2 (does
the relay dedupe across four channels) is a shape risk, not a lib swap.

**Rejected from B:** the custom `github-factory` project and its mode
picker, risk tiers, merge gates, and `decisionId` capability loop through
Slack; the `security-pass` skill that re-implements the
`security-reviewer` template inside another agent; `contents-write`
auto-merge under `FACTORY_LIVE=1`. B's diagnosis was right and its fix
  was a second codebase.

**Rejected from C:** nothing structural. This plan adds two things that C
deferred or left implicit: a named channel for escalations (GitHub's
Slack app on `#factory-escalations`, zero code) so "merge or escalate"
has a place to land, and an explicit statement that `pr-autofixer` is the single
GitHub owner in the sense the July guide means, so the folder can show
review, CI, and a risk gate on a live loop rather than only listing them
as dropped.

**Where this departs from the parent lean.** The lean asked for one
`githubChannel`. This plan has two `cursorAccount` channels for the same
repos: `pr-autofixer` (write owner) and `security-reviewer` (observer). It
is not the four-relay shape B argued against, because B's argument was
about `{ auth }` on check bursts, split PR state, and a router hop, and
none of those apply to `security-reviewer`: it declares only
`onPullRequest` (and `onComment: () => null`), it holds no state beyond
`pr/head.sha` in the session workspace, it makes no peer calls, and it
runs at `pr-write`. Removing it would leave the folder with no
SDK-authored review stage at all, and folding it into `pr-autofixer` would
fork both templates. If the relay turns out not to tolerate two consumers
(see the concern at the end), the fallback is to drop `security-reviewer`
and let Bugbot carry the review row alone. That fallback is one `init`
fewer, not a redesign.

## Tradeoffs accepted

- **No lights-out ticket-to-merge story.** The customer sees a ticket
  triaged, a PR opened after a click, reviews posted, CI fixed after a
  second click, and then a human merges. Amplitude's original merged on
  its own. For a GTM audience the objection we hear is "what stops it
  doing damage", not "why did a human click merge". This trade is
  deliberate.
- **The PR stage has a manual hand-off.** The cloud agent the desk
  launches opens a PR; nothing tells `pr-autofixer` about it. A human
  mentions the desk with the PR URL to opt it in. That is `pr-autofixer`'s
  own stance (`pull_request.opened` is ignored) and a second HITL gate,
  but it is a step Amplitude did not have.
- **"Second CI failure escalates" is dropped.** `pr-autofixer` keeps
  fixing. The `host.kv` failure counter from the sibling would be a fork
  of the template's channel. Escalation in v1 is GitHub's Slack app
  showing the red check and a human deciding.
- **Security review is advisory.** `post_findings` posts `event: "COMMENT"`,
  which cannot block merge. Blocking comes from branch protection on CI
  and Bugbot. Phase 3 can add `progress.commitStatus` at the cost of
  `contents-write` on the observer.
- **Triage cannot be reached from Slack.** Correctness of the identifier
  pin beat convenience. The fix, if wanted, is a ~20-line host
  `onMention` on the desk POSTing `{identifier}` to
  `/triage-jira/v1/channels/queue/issue` over loopback. It is deferred.
- **The desk does not answer PR status.** It has `tools: []` and no GitHub
  read. A status question that reached `pr-autofixer.ask` would resume the
  cloud conversation and spend budget, so the desk is told not to. Status
  is on GitHub and in `#factory-escalations`.
- **Templates keep the account default model.** Only the desk runs
  `grok-training-latest`. Setting `model` in a template's `agent.ts` is
  outside its edit points.
- **Every desk eval depends on a multi-mount server.** `eval --dir
  factory-desk` fails at boot on the unresolved `pr-autofixer` peer
  (`collectPeerConnections`), so smoke cases run as `eval --dir . --slug
  factory-desk` and the route case against a served factory. Same lesson
  the sibling records.
- **Jira priority.** `buildPriorityArgs` in the template returns
  `undefined` for Jira, so `triage-jira` comments and links duplicates but
  does not set priority. Say so in the demo script.

## Alternatives considered

- **Candidate A as-is.** Candidate A is seven projects, four GitHub relays
  each spending a model turn per check event, and six specialists a
  customer cannot get from `init`. Rejected on rule 1 and rule 2.
- **Candidate B as-is.** B diagnosed the problem correctly and delivered
  it wrongly, as a bespoke `github-factory` that re-implements
  `security-reviewer` and adds an auto-merge path behind an env flag.
  Rejected on rule 1 and on "never merges" being the product stance to
  show.
- **Candidate C as-is.** Candidate C is nearly this plan. It lacked a
  named channel for escalations and did not say out loud that
  `pr-autofixer` is the single GitHub owner the July guide describes, so a
  reader could take it as "we dropped review, CI, and risk". This plan
  keeps C's code and fixes the framing.
- **Fold `security-reviewer` into `pr-autofixer` for a strict single
  relay.** That gives one channel and one credential, but it forks both
  templates (`pr-autofixer` ignores `pull_request.opened` by design and
  the reviewer needs it) and the observer would inherit
  `contents-write`, so this is rejected.
- **Drop `security-reviewer`, Bugbot only.** That gives a strict single
  relay and zero edits, but leaves no SDK-authored review stage to
  replay, eval, or hillclimb in a session. Held as the fallback if the
  relay does not tolerate two consumers.
- **`delivery-desk` routing to templates by peer MCP, A-style.** This
  adds the router prompt B warned about and a step on every path. The
  desk here has two edges and one launch tool, which is the whole routing
  table.
- **Planning inside the desk (a `build_brief` tool or a skill).** The
  desk runs `tools: []` on purpose, so it cannot read the sandbox, and a
  brief written from the Slack message alone is not a plan; it is the
  message restated. Planning needs read tools over a checkout and a record
  that outlives the thread, which is why `planner` is a project with
  `["read","grep","glob","ls"]`, `local.workspaceDir`, and a `plan`
  artifact. The desk stays a router and copies the planner's `Brief:`
  into `cloud__launch`.
- **A plan-only cloud launch.** Launch a cloud agent to write `PLAN.md`,
  then a second one to implement it. That gets repo access for free, but
  it costs two approval cards per ticket and cloud budget spent on
  reading, it leaves the plan readable only through `cloud__dump`, and it
  leaves no record the factory owns. The planner reads a local clone at no
  cost and records the plan where `GET /planner/v1/artifacts` can list it.
- **Planner as a subagent of the desk.** The objection is the same as the
  one below: it would inherit `tools: []` and have no `record_plan`.
- **Chaining triage to plan through Jira automation or HTTP.** A second
  Jira rule ("on a `Triage:` comment, call the planner's webhook") or a
  loopback `fetch` from triage's host would both work, but both put the
  chain outside the framework: one in a dashboard nobody versions, the
  other needing the serve URL and a bearer token. The chain here is two
  July mechanisms the factory already teaches: a tool that finishes its
  own handoff (`record_triage` calls the planner inline at the end of
  `execute`), and a host-only peer edge
  (`call_tool` to `plan_issue`). No model turn on either side decides
  whether to plan; `chainDecision` does, from the verdict.
- **Planning on `issue_created`, in parallel with triage.** Faster, but
  the planner would plan questions, duplicates, and tickets that need
  information, and would not have the `Triage:` verdict to read. Planning
  after triage costs one comment's worth of delay and skips the three
  cases that should not be planned.
- **A merge or approver agent.** No template merges; a flag-gated merge is
  the code path that leaks when someone copies `.env.local`. Branch
  protection is the product answer and is what customers already trust.
- **Filing the ticket from Slack without a card.** A Jira Slack app works
  that way: a person says it and the ticket exists. Rejected for v1 because a model turn
  deciding that a sentence is a ticket is the one place an unreviewed
  external write creates new state; `needsApproval: true` on `file_ticket`
  costs one click in the thread the person is already in. It is one line
  to remove once the desk's filing behaviour has been watched for a while.
- **Posting the plan from the planner directly.** The planner has no Slack
  app; giving it the desk's bot token would make two agents share one
  credential. The desk owns Slack, so the planner tells the desk over a
  host-only peer edge and the desk posts. The cost is a host-only cycle
  between the two, which cannot loop because neither `announce_plan` nor
  `plan_issue` calls back.
- **Keeping the fix loop opt-in for factory PRs.** The plan made "fix
  <PR URL>" the human gate on the fixer, which spends cloud budget. Once a
  person has approved the plan and the launch, running that PR to green
  is inside what they approved, and the PR is recognisable without a
  registry: the brief puts the ticket key at the start of the branch and
  the title. So a red check on such a PR starts the drive itself, once,
  and the opt-in stays for PRs the factory did not open. The cost is one
  GraphQL read per red check on an undriven PR and a template channel
  edit the upgrade path must carry.
- **pr-autofixer's own Slack bot instead of a desk.** Two Slack apps is a
  documented July pattern, but the ticket-to-PR edge (cloud launch with
  approval) does not fit in `pr-autofixer`, so the desk is needed anyway.
  One Slack app is simpler to explain.
- **Subagents.** `pr-autofixer` has its own channels, cloud options, kv,
  and reminders, and a subagent inherits the parent's tools and runtime
  and gets none of them. Peer is the documented answer for composing
  independently useful agents.

## Open questions and risks

- **Two peers, one tool vocabulary.** Both peers expose `ask` and
  `check`; July suffixes the later connection in filename order, so the
  planner is `ask_2` / `check_2` only while `ticket-planner.ts` sorts
  after `pr-autofixer.ts`. A rename swaps the names under the desk's
  instructions. The desk evals name all four, so the failure is loud, but
  it is a convention held by a filename.
- **`Get plan` never plans.** An `approve` for a ticket with no recorded
  plan would otherwise make the planner write one and the desk launch it
  in the same turn, before anyone read it. The planner answers a `Get
  plan` only from the artifact; the desk, told there is none, posts a plan
  for reading and stops.
- **The brief crosses two models.** `record_plan` writes it, the planner
  returns it (`get_plan` on an approval, or the planning reply), the desk
  pastes it into `cloud__launch`. Both are told to copy;
  `approved-plan-parks-launch` checks the key and the merge rule survive.
  If drift shows up in practice, the fix is a desk-side `launch_plan`
  server tool that reads the artifact and calls the launch itself, at the
  cost of the desk's "no tools" rule.
- **A chained plan for a ticket filed in Jira.** Its "planned" post has no
  thread to go to; it goes to `FACTORY_DESK_INTAKE_CHANNEL`, or nowhere
  when that is unset. The plan is still on the ticket. If most tickets
  keep coming from Jira rather than from `@Factory`, the desk should post
  a fresh thread per ticket instead of one message in a channel.
- **The desk now writes.** `file_ticket` creates an issue and
  `announce_plan` posts to Slack, both from host code the model can name.
  `file_ticket` parks on a card; `announce_plan` claims `announced/<KEY>`
  before it posts (once per key, best effort, verified after write: `ctx.host.kv` has no
  compare-and-set on any backend) and the evals gate that the model never calls it. If the model
  does start calling it, the fix is a `defineResult` or moving the post
  into the planner's `plan` channel `events` map with the desk's client,
  not a prompt tweak.
- **The automatic drive keys on a naming convention.** A PR is a factory PR
  because its branch or title starts with a key from `FACTORY_JIRA_PROJECTS`
  (`TLSSN-` in this deployment). A person who names a
  branch that way by hand gets the fixer without asking for it, which is
  useful until someone gets a push they did not want. The registry
  alternative (the desk recording the launch's PR URL when `cloud__get`
  reports it) needs one desk reminder, if the convention proves too loose.
- **The handoff waits on the peer call.** `plan_issue` returns as soon as
  the planning session is admitted, so `record_triage` holds its own turn
  for one MCP round trip, not for the length of the plan. It moved out of
  an `action.result` hook and into the tool because `waitForCompletion`
  does not wait for hook dispatch, so a hook could lose the only recording
  of the verdict to process exit. If
  `ctx.send` ever blocks until the turn completes, the tool should
  `waitUntil` or fire without awaiting.

1. **Two `cursorAccount` consumers on one host for the same repos.** Does
   Cursor's SCM event stream fan out per channel, or is it consumed per
   principal so two relays split or duplicate deliveries? C's open
   question 3 and A's open question 2 both circle this. Verify in Phase 2
   by replaying one PR with both projects served and checking that
   `security-reviewer` posts and `pr-autofixer` buffers.
2. **Relay startup.** Answered from `src/internal/server.ts`: the relay
   starts without `--cursor-events` whenever a mount has a `cursorAccount`
   GitHub channel with a repo scope (`cursorAccountOnly` is set when
   `options.cursorEvents === undefined` and targets exist;
   `resolveCursorGithubEventConfig` unions every target's repos). The flag
   only adds explicit `--repo` entries. What remains open is scope: the
   host credential tier is the max across targets
   (`resolveCursorGithubPermissions` in `channels/github/cursor-account.ts`),
   so `pr-autofixer` lifts it to `contents-write`; Phase 2 must confirm
   `security-reviewer` still gets a narrower per-channel credential.
3. **Peer tool name in evals.** Answered: with `advertiseTools: true` the
   advertised names are the peer's own (`ask`, `check`); `desk.eval.ts`
   uses those strings. `notCalledTool` takes a `string`.
4. **Does `startDrive` fail closed for an unlisted repo?** Answered 22 Sep
   2026 by reading `start-drive.ts`, not by a live run. It had no scope
   check and `fetchPrState` swallows errors, so the allowlist was advice
   and the drive proceeded. `startDrive` now takes the configured list and
   refuses `out_of_scope` before any GitHub read. See
   [questions/start-drive-unlisted-repo.md](questions/start-drive-unlisted-repo.md).
5. **Slack interactivity.** `toolApprovals: true` needs the app created
   with interactivity; if cards do nothing, re-run `slack create`.
6. **Deployment env for repository scope.** Answered: every project reads
   `FACTORY_REPOS` (or its template override) through `agent/lib/config.ts`
   and declares the names in `hosting.secretNames`; set them with
   `agent-sdk secrets set <slug> FACTORY_REPOS`. There is no literal
   fallback, so an unset scope fails at boot with the variable named.
7. **Sandbox repository name.** Answered: `example-org/demo-repo` for this
   deployment, recorded in `factory.json` and `.env.example` and nowhere in
   code. Another team sets `FACTORY_REPOS` and `FACTORY_JIRA_PROJECTS` and
   changes no source.
8. **GitHub Slack app feature list.** `/github subscribe … pulls reviews
   statuses workflows` is written from memory of that app's syntax;
   confirm the current feature names in the channel.

## Next implementation step

Phases 0 and 1 are in the tree. The remaining Phase 1 exit criteria
(`jira-key-build` parks with a real Slack card, and `pr-url-drives`
returns `finished`) and Phase 2 steps 2 to 5 need a signed-in host,
`slack create`, Bugbot, branch protection, and Jira automation. Do not
write the demo script until someone has checked how the relay delivers to
two `cursorAccount` consumers (open question 1).

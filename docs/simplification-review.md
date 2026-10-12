# Simplification review: what can shrink without changing behavior

An adversarial read of the six factory packages on `main` at `7267678`
(2026-09-26): `factory-desk`, `planner`, `factory-worker`, `triage-jira`,
`pr-autofixer`, `security-reviewer`, and the helpers they copy between
them. The question was narrow: where can the code get smaller or harder to
drift, with no change to Slack UX, Jira transitions, the PR lifecycle,
review updates, model defaults, ready-not-draft, claim dedupe, the hop
watchdog, replan, emoji, or reactions. Nothing here is implemented. Each
item says what to do, why it keeps behavior, what could go wrong, and
which slugs need a redeploy.

Baseline before any change: `mise run test` and `mise run check` pass on
every package (desk 467, planner 129, worker 129, triage 73, fixer 94,
reviewer 70, scripts 165 tests; `tsc --noEmit` clean in all six). Every
item below must leave that true, and every item that deletes a test case
names it.

## The constraint that decides most of this

Each slug is its own npm project, and hosting bakes one at a time
(`deploy --dir <slug>`, `npm ci` per slug, `factory-deployment.md` §3).
Nothing on `main` imports across slug directories. So the obvious
simplification, one shared `lib/` for all six, is not a refactor. It is
an untested hosted build shape. The factory already chose copies instead:
`scripts/copies-parity.test.mjs` hashes every copy of
`verify-webhook.ts`, `atlassian.ts`, `peers.ts`, `kv-verified.ts`,
`claim-lease.ts`, and the fixer/reviewer `config.ts`, and fails when one
drifts. The safe way to deduplicate across slugs is to add a file to that
guard, not to hoist it.

## Ranked: safe to simplify next

Ranked by what each removes (duplicate logic, drift risk, dead surface)
against how easily it could be done wrong.

### 1. Delete verified-dead exports

- **Where.**
  - `factory-desk/agent/lib/plan-post.ts` `DESK_SLACK_HANDLE`: computed
    from `deskSlackHandle()` at import time, referenced nowhere. The live
    path calls `deskSlackHandle(env)` per use.
  - `factory-desk/agent/lib/desk-commands.ts` `DeskRoute`: an unused type.
  - `factory-desk/agent/lib/approve-command.ts`: the
    `export { APPROVED_REACTION }` re-export. Every importer reads it from
    `command-ack.ts`.
  - `triage-jira/agent/lib/issue-type.ts` `IssueTypeList`: an unused type.
    `jev-triage.ts` inlines the same shape.
  - `factory-desk/agent/lib/loader.ts` `isLoaderMessage` and
    `factory-desk/agent/lib/threads.ts` `sessionStarter`: referenced only by
    their own tests.
  - `sandboxRepo` and `sandboxRef` in the shared
    `pr-autofixer`/`security-reviewer` `agent/lib/config.ts`: neither slug
    calls them. They are the only reason those two slugs read
    `FACTORY_SANDBOX_*`.
- **What to do.** Delete them, with their test cases
  (`loader.test.ts` `isLoaderMessage` asserts, `threads.test.ts`
  `sessionStarter` asserts, and the two `sandboxRepo`/`sandboxRef` tests in
  `pr-autofixer/agent/lib/config.test.ts`). Edit both `config.ts` copies in
  the same commit so the parity hash still matches.
- **Why it is safe.** Every symbol was grepped across all six slugs,
  `scripts/`, and `evals/`, with no production reference. `isLoaderMessage`
  is not what `announce.ts` uses to replace a crumb (that is a narrower
  regex), so deleting it changes nothing. Wiring it in instead would be a
  behavior change.
- **Risk.** Low. The failure mode is a missed dynamic reference, and
  `tsc --noEmit` catches that.
- **Not dead, despite a per-slug grep.** `issueStatusName`,
  `statusReadArgs`, and `jiraCommentBodies` in `atlassian.ts` are unused
  by the desk but used by the planner, worker, and triage copies. The file
  is parity-locked, so it stays whole. `finishLease` is unused by the fixer
  but used by the desk, in the same parity-locked `claim-lease.ts`.
- **Blast radius.** desk, triage, pr-autofixer, security-reviewer.

### 2. Correct docs that contradict the code

Zero code change. These mislead the next person who simplifies:

| Doc | Says | Code |
| --- | --- | --- |
| `security-reviewer/README.md` | With no repos set, "the channel refuses to load at boot" | `githubReposAtBoot()` returns `[]` and the channel boots as `cursorAccount: true` (`repos.ts`, `channels/github.ts`) |
| `security-reviewer/README.md` | "The fixer has no author condition" | `autoDriveDecision` returns `title_only_from_person` for a keyed title a person opened (`pr-autofixer/agent/lib/auto-drive.ts`) |
| `factory-desk/AGENTS.md` | "Two host-only tools `announce_plan` / `announce_progress`", claims in `agent/lib/claims.ts`; "the four model tools and the two announce tools" | `agent.ts` has `tools: []`. Announces are library functions called from `channels/jira.ts`, and claims live in `claim-lease.ts` / `announceTicketUpdate`. There is no `claims.ts` |
| `planner/README.md` | "Two ways in": `record_triage` calls `plan_issue` over the peer edge | `planner/AGENTS.md` "Inbound gates" is right: hosted planning is the Jira `issue_updated` into Triaged, and `FACTORY_INPROCESS_PEERS` is unset, so `record_triage` returns `event_bus` |
| Root `README.md` §7 | `FACTORY_JIRA_PROJECTS` is a `factory-triage-jira` secret, and the example sets it | Nothing under `triage-jira/agent/` reads it. See footgun F3 |
| `factory-desk/agent/lib/loader.ts` | `isLoaderMessage` is "for In Progress replace" | In Progress replace uses the regex in `announce.ts`. Moot once item 1 lands |

- **Blast radius.** None (docs only, no redeploy).

### 3. One factory-PR key rule, parity-locked

- **Where.** Four hand-synced copies of "the head branch starts with a
  listed key, or the title does and `cursor[bot]` opened the PR":
  - `factory-worker/agent/lib/pr-decide.ts` `implementPrKey`, used by
    `pr-decide`, `pr-ready`, and `pr-body`
  - `factory-desk/agent/lib/review-update.ts` `reviewPrKey`, used by
    `review-announce`
  - `security-reviewer/agent/lib/factory-pr.ts` `factoryDraftKey` over
    `factoryIssueKey`
  - `pr-autofixer/agent/lib/auto-drive.ts`, inline in `autoDriveDecision`

  `CURSOR_BOT` is defined four times and `escapeRegExp` three times. The
  only thing holding them together is comments ("keep the three in step").
- **What to do.** Add a byte-identical `agent/lib/factory-pr-key.ts` to
  those four slugs, exporting `CURSOR_BOT`, `escapeRegExp`,
  `issueKeyAtStart(text, projects)`, and `factoryPrKey({ headRef, title,
  authorLogin, projects })`. Add it to `copies-parity.test.mjs` with its
  test in one slug. Keep the existing names as one-line wrappers or switch
  their imports.
- **Why it is safe.** The four implementations are semantically equal
  today. All trim, all anchor `^(KEY|KEY)-\d+`, all compare the author to
  `cursor[bot]` case-sensitively, and a capturing versus non-capturing
  group returns the same `match[0]`.
- **Risk.** Medium. Three things must survive:
  - **Fixer reason codes.** `autoDriveDecision` distinguishes
    `not_a_factory_pr` from `title_only_from_person`, so it needs the
    branch-then-title-then-author order, not just the combined result.
  - **Reviewer's author-agnostic match.** `security-reviewer` also calls
    `factoryIssueKey` without the author rule (`channels/github.ts`,
    `factoryKey`). That is a different rule and must stay.
  - **Exact-case login.** The comparison is `cursor[bot]` exactly. Tests
    pin `Cursor[bot]` as not the bot (`auto-drive.test.ts`,
    `factory-pr.test.ts`). Do not normalize case while merging.
  - **Checks.** `pr-decide`, `pr-ready`, `auto-drive`, `factory-pr`, and
    `review-update` tests pass unchanged.
- **Blast radius.** desk, worker, pr-autofixer, security-reviewer.

### 4. Model selection into one parity-locked file

- **Where.** `factoryModel`, `REGISTRY_MODELS`, `AUTO_MODELS`,
  `HOST_MODEL_PARAMS`, and the model type are repeated in all six
  `agent/lib/config.ts` files. The spelling differs trivially: the type is
  `FactoryModel` in five slugs and `ModelChoice` in the worker, and some
  use `Array<…>`, others `…[]`.
- **What to do.** Move that block verbatim into
  `agent/lib/factory-model.ts` in all six slugs and add it to the parity
  guard. Each `config.ts` re-exports `factoryModel` (and anything its tests
  import), because `scripts/factory-model-catalog.test.mjs` imports it
  from `<slug>/agent/lib/config.ts`.
- **Why it is safe.** `factory-model-catalog.test.mjs` already asserts all
  six return the same default
  (`{ id: "auto-smart", params: [{ id: "optimize_for", value: "balanced" }] }`),
  the same `grok-4.7` registry encoding, and catalog-valid variants. This
  turns a behavior test into a byte guard.
- **Risk.** Low to medium. `workerModel` is not part of this. It is the
  cloud agent's model with different defaults (`claude-opus-5-5`, context
  `300k`, effort `high`, fast `false`) and stays in the worker's
  `config.ts`, untouched.
- **Blast radius.** All six. It is a pure move, but every slug redeploys
  to ship it.

### 5. Desk: share `binding` and `commandThread`

- **Where.** `factory-desk/agent/lib/approve-command.ts` and
  `retry-command.ts` each define `binding(kv, issueKey)` and
  `commandThread(ctx, message)`. The bodies are identical; only one doc
  comment differs.
- **What to do.** Move both into one desk module (next to `parseThreadRef`
  in `threads.ts`, or a new `command-thread.ts`) and import them in both
  files. Leave the rest of each command alone (item 5 of the do-not-touch
  list).
- **Why it is safe.** A pure function move, and both callers pass the same
  arguments.
- **Risk.** Low.
- **Blast radius.** desk.

### 6. Extend the parity guard to copies that are already identical

No code shrinks, but drift becomes a test failure instead of a code-review
catch.

- **`host-connections/tracker.ts` in desk, planner, and worker.** The code
  is identical once comments are stripped (`TRACKER_SERVERS = ["Factory
  Atlassian"]` plus `defineConnection({ cursorAccount: true, servers })`).
  Normalize the comment and add a group. Leave `triage-jira`'s
  `mcp-connections/tracker.ts` out: a different directory is a different
  attachment surface.
- **`agent/tools/writes.test.ts`.** It is already byte-identical in
  planner, triage, fixer, and reviewer; the desk's version adds checks.
  Add it with `among` those four. Each copy scans its own project's tools,
  so the "test lives in one slug" rule does not apply.
- **Risk.** Low.
- **Blast radius.** None at runtime (desk, planner, and worker redeploy
  only if the comment change ships with other work).

### 7. Nits, only alongside other work

- **`isRecord`.** Defined privately 17 times across the four Jira slugs.
  Exporting it from the parity-locked `atlassian.ts` and importing it is
  safe but low value.
- **Planner `transitionIssue`.** Its body differs from
  `triage-jira/agent/lib/transition.ts` only in using
  `error instanceof Error ? error.message : String(error)` where triage
  calls `errorText(error)`. Aligning it is cosmetic: the rest of each file
  differs, so it cannot join the guard.

## Do not touch

These look like duplication or cruft and are not. Merging or "cleaning"
them changes behavior.

1. **Worker `claim.ts` versus desk/fixer `claim-lease.ts`.** They serve the
   same idea with different contracts: the record shape
   (`pending|launched|moved` with no owner, versus `{ owner, at }`), a fixed
   10-minute stale window versus a per-caller `leaseMs`, and no `settleMs`
   versus an optional settle re-read. A launched claim is never released.
2. **Boot-time repo reads that never throw.** The desk's `reviewRepos`
   (looser regex; drops bad entries), `sandboxReposAtBoot` (worker,
   planner), and `githubReposAtBoot` (fixer, reviewer) exist because a
   hosted freeze boots before its secrets. Swapping in the throwing
   `factoryRepos` crashes a first deploy.
3. **`workerModel` versus `factoryModel`.** These are two models on
   purpose: the cloud agent's (`claude-opus-5-5`, `300k` / `high` /
   `fast=false`) and the July host's Auto (`auto-smart`,
   `optimize_for=balanced`).
4. **Fixer versus reviewer `repos.ts`.** The fixer has a soft
   `githubReposIfSet()`; the reviewer's `watches()` throws. Forcing byte
   identity changes one of them.
5. **The approve, retry, and thread-detail command paths.** They share a
   lease shape, but their outcomes differ: approve is silent on an
   unavailable claim and hands the message to the model, while retry and
   thread-detail post an apology. Only thread-detail settles. Folding them
   changes who gets a model turn.
6. **The three `LEADING_MENTION` regexes.** `fix-request.ts` uses a
   lookahead so it does not eat the space before the next token;
   `approve-command.ts` and `thread-detail.ts` consume it.
7. **The issue-key regex families.** Strict uppercase for webhooks
   (`status-event`, `outcome-event`, `thread-detail`), case-insensitive
   then uppercased for Slack commands (`approve-command`, `retry-command`,
   `originator`), and a project of at most 10 characters for the Jira
   scrape (`jira.ts`). One regex changes what is accepted somewhere.
8. **Emoji and reactions.** Keep `STATUS_REACTIONS` in
   `status-reaction.ts` (one mark on the filer's root, add-then-remove,
   `changelogId` staleness) and `APPROVED_REACTION` in `command-ack.ts` (✅
   on the command message, deduped by `reactions.get`). Both use
   `white_check_mark` on different targets. Do not merge the maps.
9. **`announceTicketUpdate` versus `review-announce`.** One is a single
   claim; review gates hold and finish several claims per post.
10. **Ready-not-draft in `pr-ready.ts`.** Keep the GraphQL
    `markPullRequestReadyForReview` with its own `x-cursor-github-repos`
    header (the marsbank#28 fix), the `open` / `retry` / `seen_ready` /
    `person_drafted` modes, and the undraft, then body, then Jira order in
    `pr-status.ts`.
11. **The hop watchdog (`hop-watch.ts`).** Keep `UNREAD_RETRY_MS`,
    `SWEEP_GRACE_MS`, and the stalled / launched-not-moved messages.
12. **Producer/consumer pairs with the same name.** `triage-outcome.ts` and
    `triage-comment.ts` in triage write what the desk's same-named files
    parse, and `DETAIL_SENTINEL` exists in planner and desk. They are
    pinned by `scripts/outcome-sentinels.test.mjs`. They are two halves,
    not two copies.
13. **The two ADF flatteners.** `outcome-event.ts` `flatten` puts a newline
    between every text node; `atlassian.ts` `adfText` joins inline nodes
    and handles `hardBreak` and cards. Switching one to the other changes
    relayed outcome text (see F5).
14. **Structural channel and parser differences.** Planner versus triage
    `channels/webhook.ts`, `jira-event.ts` versus `parse-queue-event.ts`,
    triage's `mcp-connections/` versus the others' `host-connections/`, and
    the fixer's drive entry points (`channels/drive.ts`, `tools/drive_pr.ts`,
    `start-drive.ts`, `auto-drive.ts`, `webhook-buffer.ts`) are all live.
15. **Hoisting copies into a shared cross-slug directory.** See the
    constraint at the top.

## Footguns found on the way (not simplifications)

| # | Severity | Finding | Fail scenario |
| --- | --- | --- | --- |
| F1 | Medium-low | `approve KEY` and `retry KEY` take their lease without `settleMs` (`approve-command.ts`, `retry-command.ts`); thread-detail passes `claimSettleMs()`. `claim-lease.ts` documents that without CAS only the settle re-read closes the double-take window | The claim key is per Slack message, so this needs a redelivery of the same `approve KEY` racing the first. Both take the lease. Damage is limited: the second Jira move reads "already", `ackCommand` checks `reactions.get` before adding ✅, and `recordSlackApproval` rewrites the same record. But `ensureLoader` is read-then-post, so the implementing crumb can post twice. And if one taker's move fails (`not_moved`), its `clearSlackApproval` can erase the record the other taker's successful approval relies on to keep the Approved webhook quiet |
| F2 | Medium | Env names read in code but absent from `hosting.secretNames`: `PR_AUTOFIXER_REPOS`, `PR_AUTOFIXER_AUTO_DRIVE_PROJECTS` (fixer), `SECURITY_REVIEWER_REPOS` (reviewer), `TYPESAFE_API_KEY` (triage, which the root README tells operators to set), `FACTORY_DESK_CLAIM_SETTLE_MS` (desk) | Deploy's "declared but not set" check never mentions them. If hosted injection follows the declaration, an override set only as a secret silently falls through to `FACTORY_REPOS` (or leaves the Jev judge off) |
| F3 | Medium | `triage-jira` has no project allowlist, and nothing reads `FACTORY_JIRA_PROJECTS`, although the root README lists it for triage | Scope rests entirely on the Jira Automation rule's project condition. A rule widened to another project gets triaged, and the operator believes the secret prevents it |
| F4 | Low | `LINEAR_WEBHOOK_SECRET` is read by planner and triage `channels/webhook.ts` but appears in no `.env.example` or README | A Linear delivery with `Linear-Signature` and no secret gets a hard 401 (`verify-webhook.ts`) |
| F5 | Low-medium | `outcome-event.ts` flattens ADF comment bodies with a newline between every text node | If a comment arrives as ADF with marks or links inside a sentence, the relayed outcome text gains line breaks mid-sentence |

## Top five actions versus leave alone

**Do** (in this order): (1) delete the verified-dead exports; (2) fix the
six doc contradictions; (3) put the factory-PR key rule in one
parity-locked file across four slugs, keeping the fixer's reason codes and
the reviewer's author-agnostic match; (4) move the model-selection block
into a parity-locked file, re-exported from `config.ts`, leaving
`workerModel` alone; (5) share the desk's `binding` and `commandThread`.
Separately, and not as simplification: declare the F2 env names and
resolve F3.

**Leave alone:** the worker claim versus the lease helper, the boot-time
non-throwing repo reads, the two model functions, the command decision
trees, the `LEADING_MENTION` and issue-key regex families, the reaction
maps, the `pr-ready` undraft path, the hop watchdog, the producer/consumer
sentinel pairs, the two ADF flatteners, and any cross-slug shared
directory.

# Template-composition factory

Candidate C. Three unmodified `@cursor/july@0.2.1` templates served from
one host, one thin Slack router, no custom side-effect code. Design only;
nothing here is implemented.

Grounding: `docs/templates/{triage,security-reviewer,pr-autofixer}.md`,
`docs/guides/{github,slack,agent-to-agent,cloud-agents}.md`, and the template
sources under `templates/` in the 0.2.1 package. Where this document states
what a template does, it is quoting that code, not guessing.

## Problem

Amplitude's factory is six stages: intake, ticket, PR, review, risk, merge.
`Software_Factory_Atlassian/` reproduces it as seven hand-built specialists
behind a `delivery-desk` router: custom Jira and Bitbucket channels, host
`kv` failure counters, a merge tool behind a launch flag, filesystem evals.
It demonstrates SDK breadth. It also carries ~7 projects of bespoke host
TypeScript that only its author will maintain, runs on Bitbucket rather than
the `cursorAccount` GitHub path the product invests in, and stubs the
interesting parts (Bugbot, Autopilot, `/review-security`) behind flags.

For APJ GTM the job is different. An SE needs something a customer can
reproduce in an afternoon from `npx @cursor/july init`, that upgrades when
the package bumps, and that exercises the product's intended integrations:
Cursor-account GitHub events, dashboard Jira MCP, Slack via `slack create`,
cloud VMs via pr-autofixer. Every line we write ourselves is a line the
customer will not have, and a line that rots on the next `0.1.x`.

This candidate answers two questions. How much of the Amplitude pipeline
can we get from official templates plus glue small enough to fit on one
slide, and what do we honestly drop?

## Usage (operator and caller view)

### Scaffold (once)

```bash
mkdir factory && cd factory

# Ticket stage
npx @cursor/july@0.2.1 init ./triage-jira --template triage-jira --json

# Review stage (security slice)
npx @cursor/july@0.2.1 init ./security-reviewer --template security-reviewer \
  --var repos=apj-gtm-factory/sandbox-api --json

# PR stage
npx @cursor/july@0.2.1 init ./pr-autofixer --template pr-autofixer \
  --var repos=apj-gtm-factory/sandbox-api --json

# Intake stage (the only glue project)
npx @cursor/july@0.2.1 init ./factory-desk --json
```

`--var repos=` must be one GitHub owner. The committed value is the training
sandbox org, never a production repo (see gates below). `--json` gives a
machine-readable summary; record each command and the package version in
`factory.json` so the upgrade path is reproducible.

### Sign in and connect (per Cursor account, once)

1. Cursor dashboard: connect GitHub for `apj-gtm-factory/*`.
2. Cursor dashboard: MCP, connect **Jira** to `example.atlassian.net`.
   `triage-jira` reads it through `agent/mcp-connections/tracker.ts`
   (`cursorAccount: true, servers: ["Jira"]`). No Jira secret lives in env.
3. `agent-sdk login` once; the four projects share the stored credential.

### Slack (one app for the factory)

```bash
cd factory-desk
agent-sdk slack create --dir . --name "Factory Desk"
agent-sdk slack doctor --prefix FACTORY_DESK
```

`slack create` writes `FACTORY_DESK_SLACK_BOT_TOKEN` and
`FACTORY_DESK_SLACK_APP_TOKEN` into `factory-desk/.env.local`. Do **not** run
`slack create` in `pr-autofixer`. Its `agent/channels/slack.ts` stays in the
tree unedited; with no `PR_AUTOFIXER_SLACK_*` tokens the channel is idle and
the rest of the agent serves normally (Slack guide: "Missing tokens leave this
channel idle"). The desk is the only way into the factory from Slack.

### Serve

```bash
cd .
npx @cursor/july serve --dir . --dev --cursor-events
```

In the multi-agent layout the slug is the directory name. Index at `/`,
each agent at `/<slug>/playground`. `--cursor-events` starts the relay for every
`cursorAccount` channel (`security-reviewer`, `pr-autofixer`). Peers resolve
at startup; an unknown peer slug fails `serve` immediately.

Node 22.13+. Never Bun.

### Drive one of each stage locally

```bash
# Ticket: triage an existing sandbox issue (writes a Triage: comment to TLSSN)
curl -X POST http://127.0.0.1:3000/triage-jira/v1/channels/queue/issue \
  -H 'content-type: application/json' \
  -d '{"identifier":"TLSSN-42","title":"CSV export returns 500","description":"Since this morning."}'

# Review: replay a real sandbox PR through the relay route (posts one review comment)
agent-sdk github replay https://github.com/apj-gtm-factory/sandbox-api/pull/12 \
  --dir ./security-reviewer

# Snapshot fixtures for offline evals without posting
agent-sdk github replay apj-gtm-factory/sandbox-api#12 --dir ./security-reviewer \
  --events '*' --dry-run --out security-reviewer/fixtures/github

# PR: opt a sandbox PR in (spends cloud budget, pushes to the PR head)
curl -X POST http://127.0.0.1:3000/pr-autofixer/v1/channels/drive \
  -H 'content-type: application/json' \
  -d '{"pr":"https://github.com/apj-gtm-factory/sandbox-api/pull/12"}'

# Intake: from Slack, mention @Factory Desk with a PR URL. Or:
agent-sdk chat --url http://127.0.0.1:3000/factory-desk \
  --message "Drive https://github.com/apj-gtm-factory/sandbox-api/pull/12"
```

### Evals

```bash
for d in triage-jira security-reviewer pr-autofixer factory-desk; do
  npx --prefix "$d" agent-sdk validate --dir "$d" && \
  npx --prefix "$d" agent-sdk eval --dir "$d"; done

# Desk route evals need a running factory on a fresh state root
npx --prefix factory-desk agent-sdk serve --dir . --port 3777 --state-root "$(mktemp -d)"
npx --prefix factory-desk agent-sdk eval --dir factory-desk \
  --url http://127.0.0.1:3777/factory-desk
```

### Deploy

```bash
for d in triage-jira security-reviewer pr-autofixer factory-desk; do
  (cd "$d" && agent-sdk deploy); done
```

Production-only env on the deployments: `PR_AUTOFIXER_REPOS`,
`SECURITY_REVIEWER_REPOS`, `JIRA_WEBHOOK_SECRET`. Point Jira's
`issue_created` webhook at the deployed `triage-jira` alias under
`/v1/channels/webhook`.

## Shape

### Slugs and stages

| Slug | Template | Amplitude stage | Wakes from | Writes |
| --- | --- | --- | --- | --- |
| `factory-desk` | plain `init` + Slack + 1 peer + 1 extension | intake | Slack mention/DM, playground | none directly; delegates |
| `triage-jira` | `triage-jira` | ticket | Jira `issue_created` webhook (prod), `/queue/issue` (dev) | one `Triage:` comment, duplicate link, via host Jira MCP |
| `pr-autofixer` | `pr-autofixer` | PR (and the CI-fail loop) | drive opt-in, then PR/comment/check/status events | pushes to PR head on a cloud VM, workflow actions via `gh` |
| `security-reviewer` | `security-reviewer` | review (security slice) | non-draft PR events via relay | one `COMMENT` review per PR head |
| none | GitHub branch protection + Bugbot repo setting | risk | nothing | nothing |
| none | GitHub auto-merge, or a person | merge | nothing | nothing |

### What is dropped and why

- **Ticket creation.** `triage-jira` "starts after the ticket exists" and
  `record_triage` is documented "Never create a ticket." Humans or Jira
  automation file the ticket. The Amplitude intake-creates-ticket edge is gone.
- **Bugbot queue.** Bugbot is a per-repo setting in the Cursor dashboard and
  reviews every PR on its own. An agent that "queues Bugbot" is a stub for a
  product toggle. Turn Bugbot on for the sandbox repo; nothing to build.
- **Autopilot-on-first-CI-fail as a host counter.** Mapped onto
  `pr-autofixer`'s existing behaviour: once a PR is driven, `onCheckSuite` /
  `onCheckRun` / `onStatus` failures resume the same cloud conversation and it
  pushes verified fixes. The `kv` failure counter and "second failure
  escalates" rule from the Atlassian copy are dropped. Making a first CI
  failure wake an *undriven* PR would mean removing the `lookupPrAgent` gate in
  `agent/channels/github.ts`, which is a fork of the template's central safety
  property, so this design does not do it.
- **Risk gate agent.** Dropped. Branch protection carries it: required checks
  (CI, Bugbot), required review. `security-reviewer` stays advisory (it posts
  `event: "COMMENT"`, not `REQUEST_CHANGES`). Optional later: set
  `progress.commitStatus` on its channel to get a merge-box check; that opts the
  minted token up to `contents-write`, so it is off by default.
- **Merge agent.** Dropped. `pr-autofixer` "never merges, enables auto-merge,
  or force-pushes." No template merges, and that is the product stance we want
  to show customers, not a gap to paper over.
- **`agents-md`, `code-wiki`.** We scaffold neither. Neither is one of the
  six stages, and both are post-merge maintenance. `code-wiki` is the one honest
  candidate for a Phase 3 "after merge" stage if the audience asks what
  happens post-merge, because it wakes on `closed`+`merged` and opens a
  follow-up PR through the same `cursorAccount` path. `agents-md` is a weekly
  cron over Slack history and does not belong in a delivery pipeline.

### Glue (all of it)

`factory-desk/` is a plain `agent-sdk init` project with four authored files
and no `agent/lib/`:

```text
factory-desk/
├── agent/
│   ├── agent.ts                      # grok-training-latest, local runtime, tools: []
│   ├── instructions.md               # routing rules, what the factory does, what it never does
│   ├── channels/slack.ts             # slackChannel({ envPrefix: "FACTORY_DESK", toolApprovals: true })
│   ├── mcp-connections/pr-autofixer.ts  # defineConnection({ agent: "pr-autofixer" })
│   └── extensions/cloud.ts           # cursorCloudAgents({ cloud: { repos: [sandbox], autoCreatePR: true }, needsApproval: true })
└── evals/
    ├── evals.config.ts
    └── desk.eval.ts
```

What the desk does, per `instructions.md`:

1. When the message contains a GitHub PR URL or `owner/repo#N`, call
   `pr-autofixer.ask` with the PR reference and relay back `agentUrl` and
   `status`. This is the only peer.
2. When the message contains a Jira key and asks for a change ("build
   TLSSN-42", "open a PR for this"), launch a cloud agent through the
   `cursor-cloud-agents` extension with a self-contained brief. The launch
   parks for approval, and the approval card lands in the Slack thread
   (`toolApprovals: true`). This fills the ticket-to-PR edge that
   `pr-autofixer` cannot (its `autoCreatePR` is `false` and it only fixes
   existing PRs).
3. When the message asks about triage or security, explain that triage
   runs when the Jira ticket is created, and that security review runs on
   every non-draft PR in the watched repos and posts one
   `## Security review` comment. Do not delegate.
4. For anything else, answer from instructions with no tool calls.

Why there is no peer to `triage-jira`: `record_triage` pins the issue to
`ctx.session.continuationKey`. A peer `ask` session has no continuation
token, so the pin falls back to whatever identifier the model extracted, and
the template's "comments on the issue that started the session, not whatever
identifier the model copies" guarantee is lost. Triage stays on its two
pinned routes (`/queue/issue`, `/webhook`).

Why there is no peer to `security-reviewer`: `post_findings` throws unless
the continuation key starts with `github-pr:`, and the diff arrives as
`workspaceFiles` from the GitHub hook. An `ask` session has neither. It is
event-only by design.

### Peer graph

```text
Slack ──> factory-desk ──ask──> pr-autofixer ──cloud VM──> GitHub PR head
              │
              └──cursor-cloud-agents (needsApproval)──> new PR in sandbox repo

Jira issue_created ──webhook──> triage-jira ──host Jira MCP──> Triage: comment
GitHub PR events ──Cursor relay──> security-reviewer ──post_findings──> one review comment
GitHub PR/check events ──Cursor relay──> pr-autofixer (only for driven PRs)
```

One edge in the peer graph. No cycles possible.

### Folder map

```text

├── README.md
├── factory.json                 # package version + the four init commands + var values
├── docs/
│   ├── candidates/              # this file and siblings
│   └── edits.md                 # every deviation from init output, one line each
├── factory-desk/                # glue (above)
├── triage-jira/                 # init output; edit points: agent/skills/triage-rubric.md, agent/instructions.md, evals/
├── security-reviewer/           # init output; edit points: agent/lib/repos.ts, agent/instructions.md, evals/, fixtures/github/
└── pr-autofixer/                # init output; edit points: agent/lib/repos.ts, agent/instructions.md, evals/
```

No shared code between projects. Each has its own `package.json` and
`node_modules`; `npx --prefix <dir> agent-sdk` targets a project's own CLI.

### Secrets and env

| Name | Where | Dev | Prod |
| --- | --- | --- | --- |
| Cursor credential | `agent-sdk login` / `CURSOR_API_KEY` | training account | deployment service account |
| `FACTORY_DESK_SLACK_BOT_TOKEN`, `FACTORY_DESK_SLACK_APP_TOKEN` | `factory-desk/.env.local` via `slack create` | dev Slack app | `slack create --prod` |
| `PR_AUTOFIXER_SLACK_*` | never set | idle | idle |
| `PR_AUTOFIXER_REPOS` | deployment env only | when unset, the `repos.ts` sandbox | production list |
| `SECURITY_REVIEWER_REPOS` | deployment env only | when unset, the `repos.ts` sandbox | production list |
| `JIRA_WEBHOOK_SECRET` | deployment env only | when unset, the route rejects unsigned deliveries | Jira webhook secret |
| Jira credentials | none; dashboard MCP connection on the signed-in account | sandbox site | team site |
| GitHub tokens | none; `cursorAccount` mints repo-scoped short-lived credentials | none | none |

### Stub vs live

There is no stub layer. Every write is live against whatever the signed-in
account is connected to, and the gate is what that account can reach:

- **Repo allowlist.** `agent/lib/repos.ts` in git names only
  `apj-gtm-factory/sandbox-api`. `cursorAccount` mints a credential scoped to
  that list, so a playground drive against a production PR fails at
  `fetchPrState`, not after a push. Production repos enter only through
  deployment env (`PR_AUTOFIXER_REPOS` exists in the template;
  `SECURITY_REVIEWER_REPOS` is the one source edit this design makes, see
  below).
- **Account hygiene.** The training Cursor account's GitHub connection covers
  only the sandbox org and its Jira MCP connection points at
  `example.atlassian.net`. `cursorAccount` refuses to mint for repos
  the account has not connected, so even a wrong `repos.ts` fails at startup.
  This is enforced by the platform, not by our code, which is the point.
- **Eval sessions.** Inherited. `actuate()` returns `skipped: eval`,
  `post_findings` returns `posted: false`, and the pr-autofixer smoke case
  asserts `drive_pr` count 0. `pr-autofixer`'s docs are explicit: never add a
  case that passes a PR URL.
- **Cloud launches from the desk.** `needsApproval: true` on the extension,
  `cloud.repos` = sandbox only in git. Approval resolves in Slack or the
  playground; on the local runtime, where the desk runs.
- **Webhook route.** Without `JIRA_WEBHOOK_SECRET` the signed-webhook route
  rejects; dev triage happens only through `/queue/issue`, which is
  loopback-only under `--dev`.

There is no `FACTORY_LAUNCH=1` style flag. The Atlassian copy needs one
because its tools would otherwise write to whatever the env tokens can
reach. Here the credential scope already does that job.

### Keeping templates upgradeable

Templates are projects, not extensions, so `disableTool()`-style overlays do
not apply. The discipline is instead:

1. **Edit only what the template README lists under "What to edit"**:
   `repos.ts`, `instructions.md`, `triage-rubric.md`, `evals/`. Never touch
   `agent/lib/*` (other than `repos.ts`), `channels/`, or `tools/`.
2. **One recorded deviation.** `security-reviewer/agent/lib/repos.ts` gains the
   same env override `pr-autofixer/agent/lib/repos.ts` already has, reading
   `SECURITY_REVIEWER_REPOS`. Six lines, in the designated edit file, copied
   from a sibling template. Logged in `docs/edits.md`. Without it the only
   way to point security review at production is a git change, and `agent-sdk
   dev` would then relay production PR events to a laptop.
3. **Upgrade path.** Bump the version in `factory.json`, re-run each `init`
   into `/tmp/upgrade/<slug>` with the same `--var`, three-way diff against
   the committed tree, re-apply the entries in `docs/edits.md`. Because
   deviations are confined to named files, the diff is small and mechanical.
4. **No cross-project imports.** The desk knows `pr-autofixer` only as a slug
   string in `defineConnection({ agent })`. Renaming or upgrading
   `pr-autofixer` does not touch the desk.

## Eval plan

### Inherited (run unchanged)

| Project | Cases | What they prove |
| --- | --- | --- |
| `triage-jira` | 3 (bug, question, feedback) | `record_triage` called once; Jira write skipped |
| `security-reviewer` | 2 (XSS fixture, docs-only) | findings vs CLEAN; GitHub write skipped |
| `pr-autofixer` | 1 (`no-pr`) | chat without a PR never calls `drive_pr`, so no cloud spend |

### Added (desk only, `factory-desk/evals/desk.eval.ts`)

Local cases (`agent-sdk eval --dir factory-desk`, no server):

- `chat-no-target`: "What does this factory do?" asserts `t.succeeded()`,
  no peer `ask`, and no cloud launch tool.
- `jira-key-explain`: "What happened to TLSSN-42?" asserts no tool calls,
  and a reply that says triage runs on ticket creation.
- `jira-key-build`: "Open a PR for TLSSN-42: add CSV export retries"
  calls the cloud launch tool, which parks for approval. The eval asserts
  the park without approving it, so no repo is touched.

Route case (`--url` against a factory serve on a fresh `--state-root`):

- `pr-url-routes`: "Drive https://github.com/apj-gtm-factory/sandbox-api/pull/1"
  where PR #1 is a **closed** sandbox PR. Asserts the peer `ask` was called and
  the reply contains `finished`. `startDrive` returns `status: "finished"` for
  a merged or closed PR without starting a session, so this exercises the
  whole path from the desk through the peer to `drive_pr`, with zero cloud
  budget and zero pushes.

Peer `ask` sessions on `pr-autofixer` are ordinary live sessions, not eval
sessions (same lesson the Atlassian README records). That is why the route
case pins a closed PR and why the route serve never carries production env.

### Fixtures

`security-reviewer/fixtures/github/` from `github replay --dry-run --out`
against two sandbox PRs (one with a planted injection, one docs-only) so the
review evals can grow beyond the shipped two without live GitHub.

### Hillclimb targets

Once smoke passes, hillclimb `triage-rubric.md` against three real TLSSN
tickets, freezing one `record_triage` call and the comment shape, then the
`security-reviewer` instructions against the two fixtures, freezing one
comment and no style nits.

## Tradeoffs accepted

- **No lights-out story from ticket to merge.** A customer sees the ticket
  triaged, the PR fixed while they watch, a security comment posted, and
  then *they* merge. Amplitude's demo merges on its own. We are trading
  the appeal of autonomy for a pipeline every piece of which is
  product-supported and never merges. For a GTM audience I think that
  trade is right, because the objection we hear is "what stops it doing
  damage", not "why did a human click merge".
- **Opt-in PR stage.** Nothing fixes a PR until someone drives it. That is
  `pr-autofixer`'s stance and we do not override it. A "fix every PR" mode is
  a fork.
- **Security review is advisory.** A `COMMENT` review cannot block merge. The
  block comes from branch protection, which the factory does not manage.
- **Triage cannot be reached from Slack.** Correctness of the identifier pin
  beat convenience. The fix, if wanted, is a ~20-line host `onMention`
  handler on the desk that POSTs `{identifier}` to
  `/triage-jira/v1/channels/queue/issue` over loopback (the queue route
  resolves the title from Jira itself). It is deferred, because it is the
  first custom glue this design would add and I want the baseline to have
  none.
- **Desk depends on peers being served together.** `agent-sdk eval --dir
  factory-desk` alone cannot resolve `pr-autofixer`; route evals need the
  factory serve. Documented, same as the Atlassian copy.
- **One GitHub owner.** All three GitHub-facing projects share one App
  installation. Multi-org customers need one factory per org.
- **`grok-training-latest` only on the desk.** Templates keep their own
  model defaults; changing them is an `agent.ts` edit outside the "What to
  edit" list, so we do not.

## Alternatives this shape rejects

- **Seven custom specialists (the Atlassian copy).** Rejected for GTM,
  because it is a codebase and not a recipe. Bitbucket channels, a launch flag, `kv` counters,
  and a merge tool are all things a customer would have to own. The templates
  give us evals, replay, host-owned writes, and idempotent comments for free
  and get better on every package bump.
- **Fork the templates into one project with shared `lib/`.** Rejected,
  because it turns three upgradeable scaffolds into one un-upgradeable app
  in a single `git merge`. The multi-project layout costs three
  `node_modules` and buys independent upgrades.
- **Subagents instead of a peer.** `pr-autofixer` has its own channels,
  cloud options, `kv`, and reminders. A subagent inherits the parent's
  tools and would have none of them. Peer is the documented answer for
  "composing independently useful agents".
- **A merge agent behind `FACTORY_LAUNCH=1`.** Rejected, because no
  template merges, and a flag-gated merge is exactly the code path that
  leaks into prod when someone copies `.env.local`.
- **Bugbot or Autopilot "queue" agents.** Rejected, because both are
  product features configured in the dashboard or triggered from Cursor.
  Wrapping them in an agent adds a failure mode and demonstrates nothing.
- **Custom Jira webhook server.** Rejected, because `triage-jira` ships
  one (`agent/channels/webhook.ts`, signed, `publicEndpoint()`).
- **`cursorAccount: true` + `--repo` at serve time for security-reviewer.**
  Rejected for now, because the channel also filters through `watches()` from
  `repos.ts`, so the serve-time flag alone would wake nothing. The env
  override in `repos.ts` is the smaller change.

## Open questions

1. **Peer tool name in evals.** The desk sees `pr-autofixer`'s `ask` under the
   connection's server name. Confirm the exact `t.calledTool(...)` string from
   `agent-sdk info --dir factory-desk --json` before writing `desk.eval.ts`.
2. **Does `startDrive` fail closed for repos outside the allowlist?**
   `fetchPrState` uses the `cursorAccount` credential; I expect a mint/scope
   error for an unlisted repo, but I have not run it. Verify with a
   production PR URL against the sandbox-scoped dev host before trusting the
   allowlist as the gate.
3. **`serve --cursor-events` at the factory root.** The relay starts per
   `cursorAccount` channel; confirm the root-level serve starts it for both
   GitHub projects and that a `--repo` flag is not required alongside.
4. **Jira priority.** `buildPriorityArgs` returns `undefined` for
   `kind !== "linear"`, so `triage-jira` comments and links duplicates but
   does not set Jira priority. The template doc oversells that line. Decide
   whether to say so in the demo script or leave it.
5. **Where approvals for cloud launches appear.** `toolApprovals: true` needs the
   Slack app created with interactivity; if cards do nothing, re-run `slack
   create`. Confirm on the first live desk turn.
6. **Deployment env for `SECURITY_REVIEWER_REPOS`.** Confirm `agent-sdk
   deploy` injects arbitrary env from the dashboard the way it injects Slack
   tokens; otherwise the production repo list goes back into git on a
   deploy branch.

## First implementation step

Create the folder, run the four `init` commands above against
`apj-gtm-factory/sandbox-api`, write `factory.json` with the version and
commands, and commit the untouched output as `template baseline`. Then, in
that order, with a validate after each:

1. `agent-sdk validate --dir <each>` and `npx tsc --noEmit -p <each>`; fix
   nothing in template code.
2. `factory-desk`: replace `echo.ts` with nothing (`tools: []`), add
   `channels/slack.ts`, `mcp-connections/pr-autofixer.ts`,
   `extensions/cloud.ts`, `instructions.md`. `agent-sdk slack create`.
3. `security-reviewer/agent/lib/repos.ts`: add the `SECURITY_REVIEWER_REPOS`
   override, record it in `docs/edits.md`.
4. `npx @cursor/july serve --dir . --dev --cursor-events`; confirm four
   slugs at `/` and that peers resolved.
5. Run the inherited evals, then `github replay --dry-run --out` to seed
   fixtures, then write `desk.eval.ts` against a closed sandbox PR.

The baseline commit is the artefact that makes upgrades honest: every later
diff against it is either a listed edit point or a mistake.

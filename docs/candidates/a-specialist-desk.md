# Specialist desk factory

Candidate A. The shape is a folder of independently useful
`@cursor/july@0.2.1` agent projects. `delivery-desk` receives every human
request and owns Slack. Six specialists own Jira and GitHub. Peer MCP
joins them. Every model turn runs with `tools: []` and calls exactly one
authored decision tool. Host TypeScript owns auth, idempotency, evidence
seeding, and side-effect gates.

This is `Software_Factory_Atlassian/` with Bitbucket removed and Slack
added as a real channel, not a copy of it. Bitbucket lines were the
inbound `bitbucketChannel()` on `pr-reviewer`, the HTTP-basic merge in
`approver`, and the commit-to-PR lookup in `ci-watch`. All three are
replaced by `githubChannel({ cursorAccount })` and `ctx.host.github`.

## Problem

Amplitude's delivery pipeline is intake, ticket, PR, Bugbot, risk gate,
and merge or escalate. Today each step is a person reading one tool
and typing into another. The customer's tools are Slack, where the
request arrives, Jira, where the ticket is, and GitHub, which holds the
PR, CI, and Bugbot.

The factory has to:

- Take a request from Slack without writing to Jira or GitHub itself.
  Slack is where people ask. It is not the system of record.
- Enrich Jira tickets that already exist. Native Slack @Cursor and humans
  file tickets. Nothing in this factory creates one.
- Start coding work on a Cursor cloud agent (pstack poteto-mode) and let
  Bugbot, `/review-security`, and Autopilot do the review, security, and
  CI-repair work they already do. No specialist re-implements them.
- Decide `auto_merge | escalate` with a deterministic risk floor that no
  model verdict can override.
- Be safe to run with no credentials (stubs), safe to eval (never
  writes), and safe to demo live (every write behind a named env gate).

The Atlassian factory already proved the pattern. What it did not have
was a real inbound channel for people (it was playground-only), a GitHub
event stream, or a place for escalations to land. This design adds those
three and keeps the rest.

## Usage (operator and caller view)

### Serve, chat, eval

```bash
cd .
npx @cursor/july login                       # or CURSOR_API_KEY
npx @cursor/july validate --dir .            # factory-level, resolves peers
npx @cursor/july serve --dir . --dev --cursor-events
```

Index at `/`. Playgrounds at `/<slug>/playground`. Slug is the directory
name. `--cursor-events` starts the GitHub relay for every agent that
declares `cursorAccount`. Without it the GitHub channels still mount and
accept fixtures and `github replay` on loopback.

```bash
# Talk to the front door
npx @cursor/july chat --url http://127.0.0.1:3000/delivery-desk \
  --message "Triage Jira TLSSN-12. CSV export returns 500 since this morning."

# Isolated specialist checks (no peers needed)
npx @cursor/july validate --dir issue-triage
npx @cursor/july call record_triage --dir issue-triage --input '{
  "identifier": "TLSSN-12", "kind": "bug", "severity": "high",
  "title": "CSV export returns 500",
  "summary": "Export has failed since this morning.",
  "nextStep": "Inspect request id 41ac."
}'
npx @cursor/july eval --dir issue-triage
npx @cursor/july eval --dir ci-watch
npx @cursor/july eval --dir approver
```

Route evals for `delivery-desk` need the whole factory served, on a fresh
state root, with no launch gate set:

```bash
npx @cursor/july serve --dir . --port 3777 --state-root "$(mktemp -d)"
npx @cursor/july eval --dir delivery-desk --url http://127.0.0.1:3777/delivery-desk
```

Typecheck each project with `npm run check` in that directory. Node
22.13+, never Bun. Evals live in each project's root `evals/`, never
`agent/evals/`.

### Slack setup (desk only)

```bash
cd delivery-desk
npx @cursor/july slack create --dir . --channel-posts
npx @cursor/july slack doctor --prefix DESK
```

One Slack app for the factory. Tokens land in `delivery-desk/.env.local`
as `DESK_SLACK_BOT_TOKEN` and `DESK_SLACK_APP_TOKEN`. Specialists have
no Slack tokens.

### Call site 1: Slack mention

A person in `#platform-delivery`:

> @delivery-desk implement TLSSN-12 on acme/checkout

1. `slackChannel({ envPrefix: "DESK", toolApprovals: true })` starts a
   thread session keyed to the Slack thread.
2. The desk model calls `log_route({ destination: "implementer", reason,
   request })`.
3. `log_route` has `needsApproval: ({ destination }) =>
   destination === "implementer" || destination === "approver"`. Slack
   posts a Block Kit Approve/Deny card in the thread. Nobody outside the
   workspace can click it (`blockExternals` default).
4. On approve, the desk host calls `host.mcp.callTool("implementer",
   "ask", { message, sessionId? })` and follows with `check` (50 s
   rounds, two extra). The specialist reply is posted in the thread.
5. `implementer`'s `start_pstack` writes the poteto-mode brief and, only
   with `FACTORY_LAUNCH=1` and `CURSOR_API_KEY`, POSTs `/v1/agents`. The
   cloud agent URL comes back through the desk into the thread.

The desk answers anything it cannot route ("what's the weather") itself,
without a tool call, in under eight lines.

### Call site 2: Jira webhook

Jira Cloud automation on `TLSSN` fires *Issue created* to
`https://<host>/issue-triage/v1/channels/webhook`, signed with
`JIRA_WEBHOOK_SECRET` (`X-Hub-Signature-256`).

```bash
# Local equivalent, no signature on --dev
curl -s -X POST http://127.0.0.1:3000/issue-triage/v1/channels/queue/issue \
  -H 'content-type: application/json' \
  -d '{"identifier":"TLSSN-12","title":"CSV export returns 500",
       "description":"Export has returned 500 since this morning."}'
```

1. The handler verifies the HMAC, parses the issue, and `waitUntil(send(
   prompt, { continuationToken: "TLSSN-12", admission: "coalesce" }))`.
   Jira retries on non-200 and times out fast; the route ACKs first.
2. The model calls `record_triage` once.
3. Host `actuate()` pins the identifier to the session's continuation
   key (the model cannot retarget a different ticket), searches the
   tracker for a same-title duplicate, checks for an existing `Triage:`
   sentinel comment, then comments, prioritises bugs, and links the
   duplicate through `host-connections/tracker.ts`. Live when
   `JIRA_API_TOKEN` is set. Stub otherwise. Never creates a ticket.

The Slack side of intake is native Slack @Cursor, which already files
Jira tickets. The desk does not duplicate it.

### Call site 3: GitHub PR and CI

The pstack cloud agent opens `acme/checkout#42` with `TLSSN-12` in the
title. Cursor relays the events to every agent that declared
`cursorAccount: { repos }`.

| Event | Agent | Hook return | Tool | Host effect |
| --- | --- | --- | --- | --- |
| `pull_request.opened` (not draft) | `pr-reviewer` | `{ auth }` | `request_bugbot` | one Bugbot request per head SHA, `progress.banner` |
| `pull_request.opened/synchronize` touching `SECURITY_PATHS` | `security-review` | `{ auth, message }` (host filters paths first, else `null`) | `request_security_review` | launch `/review-security` under gate |
| `check_suite.completed` with `conclusion: failure` | `ci-watch` | `{ auth }` after 3 s debounce | `queue_autopilot` | first failure per PR launches Autopilot; later escalates |
| Bugbot review submitted and checks green | `approver` | `{ auth, message }` with seeded evidence | `record_approval` | `auto_merge` merges (squash) under `FACTORY_MERGE=1`; `escalate` labels, comments, and notifies Slack via the desk |
| `pull_request.closed` | `ci-watch`, `approver` | `{ task }` | none | drop `host.kv` buffers and counts for `pr:acme/checkout#42` |

Local replay, no live push needed:

```bash
npx @cursor/july github replay acme/checkout#42 --dir pr-reviewer
npx @cursor/july github replay acme/checkout#42 --dir ci-watch \
  --events '*' --conclusion failure
npx @cursor/july github replay acme/checkout#42 --dir pr-reviewer \
  --events '*' --dry-run --out fixtures/github     # snapshot fixtures
```

## Shape

### Agents

| Slug | Amplitude stage | Slack / Jira / GitHub surface | One tool | Host side effect | Launch gate |
| --- | --- | --- | --- | --- | --- |
| `delivery-desk` | Front door | **Slack** mention/DM (`slackChannel`, `envPrefix: "DESK"`, `toolApprovals: true`); HTTP `/v1/channels/escalate` (inbound from specialists, host-only) | `log_route` | peer `ask`/`check` to one specialist; post escalations to `#factory-escalations` via `host.slack` | HITL card for `implementer` and `approver` destinations; no env gate (routing is not a write) |
| `issue-triage` | Dedup and classify the ticket | **Jira** create webhook (`/v1/channels/webhook`, `JIRA_WEBHOOK_SECRET`); `/v1/channels/queue/issue` | `record_triage` | comment, set bug priority, link duplicate via `host-connections/tracker.ts` | live when `JIRA_EMAIL` + `JIRA_API_TOKEN`; else stub. Only `JIRA_PROJECT_KEY-` keys are written |
| `implementer` | Open the pull request | none inbound (peer only) | `start_pstack` | POST `/v1/agents` with the poteto-mode brief; one launch per issue key in `host.kv` | `FACTORY_LAUNCH=1` + `CURSOR_API_KEY` |
| `pr-reviewer` | Bugbot | **GitHub** `onPullRequest` opened / ready_for_review, `pr-write` | `request_bugbot` | trigger Bugbot (API when `BUGBOT_API_KEY`, else `bugbot run` PR comment); one per head SHA | `FACTORY_LAUNCH=1` for the comment or API call |
| `security-review` | Security pass | **GitHub** `onPullRequest` opened / synchronize, host filters by `SECURITY_PATHS`, `read` | `request_security_review` | launch Cursor `/review-security` cloud agent on the PR; one per head SHA | `FACTORY_LAUNCH=1` + `CURSOR_API_KEY` |
| `ci-watch` | Failed build | **GitHub** `onCheckSuite` / `onWorkflowRun` failure, `pull_request.closed`, `pr-write` | `queue_autopilot` | first failure per PR launches Autopilot; later failures label `ci:needs-human`, comment, and escalate to the desk | `FACTORY_LAUNCH=1` + `CURSOR_API_KEY` |
| `approver` | Risk gate | **GitHub** Bugbot review / comment (`BUGBOT_LOGINS`), `onCheckSuite` success, `pull_request.closed`, `contents-write` | `record_approval` | `auto_merge`: squash-merge via `ctx.host.github`; `escalate`: label `needs-human`, comment, POST desk `/escalate` | merge needs `FACTORY_LAUNCH=1` **and** `FACTORY_MERGE=1`; deterministic risk floor overrides the model |

Every agent: `model: { id: "grok-training-latest" }`, `tools: []`,
`local: { sandbox: true }`, `agent/hooks/memory.ts` = `memoryHook()`.
The prompt carries the evidence. The tool records the decision. Host
code decides whether any write happens.

### Module / folder map

```

  README.md
  docs/candidates/a-specialist-desk.md        # this file
  .cursor/settings.json                       # pstack plugin enabled

  delivery-desk/
    agent/agent.ts                            # tools: [], hosting.secretNames DESK_SLACK_*
    agent/instructions.md                     # routing table, <8 lines reply
    agent/channels/slack.ts                   # slackChannel({ envPrefix:"DESK", toolApprovals:true, reply:{mode:"post"} })
    agent/channels/escalate.ts                # POST /v1/channels/escalate, HMAC FACTORY_ESCALATE_SECRET, host.slack post
    agent/mcp-connections/{issue-triage,implementer,pr-reviewer,security-review,ci-watch,approver}.ts
    agent/tools/log_route.ts                  # needsApproval for implementer|approver
    agent/lib/follow-up.ts                    # ask -> check x2, payloadOf()
    agent/lib/peer-session.ts                 # host.kv desk/peer-session/<dest>/<key> -> sessionId
    agent/lib/route-key.ts                    # TLSSN-12 | pr:owner/repo#N from request text
    agent/lib/escalation.ts                   # verify HMAC, format Slack post
    agent/lib/*.test.ts
    evals/evals.config.ts, evals/route.eval.ts
    .env.example                              # DESK_SLACK_BOT_TOKEN, DESK_SLACK_APP_TOKEN, FACTORY_ESCALATE_SECRET, FACTORY_ESCALATION_CHANNEL

  issue-triage/                               # from `init --template triage-jira`, trimmed
    agent/agent.ts                            # egressDomains *.atlassian.net
    agent/instructions.md
    agent/skills/triage-rubric.md
    agent/channels/webhook.ts                 # signed Jira create webhook
    agent/channels/queue.ts                   # /queue/issue for playground and curl
    agent/host-connections/tracker.ts         # Jira stub|live, never advertised
    agent/tools/record_triage.ts
    agent/lib/{actuate,host-verdict,jira,parse-queue-event,verify-webhook,types}.ts
    evals/triage.eval.ts

  implementer/
    agent/tools/start_pstack.ts
    agent/skills/pstack-development/SKILL.md
    agent/lib/{pstack-brief,launch,launch-record}.ts   # brief text, /v1/agents POST, host.kv one-per-issue
    evals/pr.eval.ts

  pr-reviewer/
    agent/channels/github.ts                  # githubChannel cursorAccount pr-write, onPullRequest, progress.banner
    agent/tools/request_bugbot.ts
    agent/lib/{repos,bugbot,collect,dedupe}.ts # repos from FACTORY_GITHUB_REPOS, Bugbot trigger, host.kv per head SHA
    evals/review.eval.ts

  security-review/
    agent/channels/github.ts                  # cursorAccount read, host path filter -> {auth,message}|null
    agent/tools/request_security_review.ts
    agent/lib/{repos,sensitive-paths,review-security}.ts
    evals/security.eval.ts

  ci-watch/
    agent/channels/github.ts                  # onCheckSuite/onWorkflowRun failure, debounce buffer in host.kv, closed -> task
    agent/tools/queue_autopilot.ts
    agent/lib/{repos,autopilot,failures,debounce,resolve-pr}.ts   # count per PR, resolve head SHA -> PR via ctx.github
    evals/ci.eval.ts

  approver/
    agent/channels/github.ts                  # cursorAccount contents-write, Bugbot review + green checks -> {auth,message}
    agent/tools/record_approval.ts
    agent/lib/{repos,evidence,risk-floor,merge,escalate}.ts        # seed files/findings/CI, deterministic floor, squash merge, desk POST
    evals/approval.eval.ts
```

July never discovers `agent/lib/`. `agent/host-connections/` is callable
from `ctx.host.mcp` and channel `host.mcp` but is never shown to the
model. Nothing has an `agent/subagents/`, because peer MCP does the
composing.

### Channel ownership per agent

| Surface | Owner | Everyone else |
| --- | --- | --- |
| Slack (one app, `DESK_SLACK_*`) | `delivery-desk` | no tokens, no `slackChannel`. Specialists reach Slack only by POSTing the desk's `/v1/channels/escalate` from host code |
| Jira reads and writes | `issue-triage` | nobody else holds `JIRA_*`. `implementer` puts the issue key in the pstack brief so the PR title carries it; Jira's own GitHub integration links PR to ticket. The factory does not re-implement that |
| GitHub `pull_request` opened | `pr-reviewer` | `security-review` also receives it but its hook returns `null` unless a sensitive path changed |
| GitHub `check_suite` / `workflow_run` failure | `ci-watch` | `approver` reads check state as evidence but does not wake on failure |
| GitHub Bugbot review / green checks | `approver` | `pr-reviewer` does not wait for Bugbot's answer; it only requests it |
| GitHub `contents-write` | `approver` only | all other GitHub channels are `pr-write` or `read` |
| Cloud agent launches (`/v1/agents`) | `implementer`, `security-review`, `ci-watch` | each under `FACTORY_LAUNCH=1`, each idempotent on its own `host.kv` key |

Four agents declare `githubChannel({ cursorAccount: { repos } })` for
the same repositories. Each starts its own relay and its own minted
credential at its own permission tier. This is deliberate. The
alternative is a GitHub intake agent that dispatches, which is a second
router (see "Alternatives").

### Peer MCP graph

```
Slack ──▶ delivery-desk ──ask/check──▶ issue-triage
                        ──ask/check──▶ implementer
                        ──ask/check──▶ pr-reviewer
                        ──ask/check──▶ security-review
                        ──ask/check──▶ ci-watch
                        ──ask/check──▶ approver

Jira webhook ──▶ issue-triage                       (no peers)
GitHub relay ──▶ pr-reviewer | security-review | ci-watch | approver   (no peers)

ci-watch, approver ──host HTTP POST──▶ delivery-desk /v1/channels/escalate
                                        (HMAC, no model turn, posts to Slack)
```

Rules:

- Only `delivery-desk` has `agent/mcp-connections/`. Six files, each
  `defineConnection({ agent: "<slug>", description })`. The desk model
  sees `ask`/`check`/`call_tool` per peer but is instructed never to call
  them; `log_route` does the call host-side through `ctx.host.mcp`. The
  route eval asserts `maxToolCalls(1)`.
- No specialist has any `mcp-connections/`. No specialist can `ask`
  anything. `pr-reviewer` does not ask `approver`; `approver` wakes from
  GitHub on its own.
- No specialist has a peer connection back to the desk. Escalation is a
  plain HTTP POST to a desk channel route, verified by
  `FACTORY_ESCALATE_SECRET`, handled entirely in the handler with
  `host.slack`. It never calls `send()`, so it cannot start a desk model
  turn, so it cannot route. That is the recursion guard. The desk is the
  only agent that can start model turns on other agents, and nothing can
  start a model turn on the desk except Slack and the playground.
- `serve` fails at startup on unknown or self-referencing peers, so a
  typo in a connection file is caught before any traffic.

### Continuation tokens

| Agent | Token | Who sets it |
| --- | --- | --- |
| `delivery-desk` | Slack thread (channel-managed) | `slackChannel` |
| `issue-triage` | `TLSSN-12` (bare issue key) | webhook/queue `send({ continuationToken, admission: "coalesce" })`; `record_triage` pins the verdict to `ctx.session.continuationKey` |
| `implementer` | `issue:TLSSN-12` | desk `peer-session.ts` when asked; `host.kv implementer/launch/TLSSN-12` holds the launched agent id regardless of session |
| `pr-reviewer`, `security-review`, `ci-watch`, `approver` | `pr:owner/repo#N` | `githubChannel` hooks; every wake for the PR resumes one conversation |

Peer `ask` takes `sessionId`, not a continuation token. The desk's
`peer-session.ts` derives a key from the request (`TLSSN-\d+` or
`owner/repo#N` or a GitHub PR URL) and stores
`desk/peer-session/<destination>/<key> -> sessionId` in `host.kv`, so a
second Slack ask about the same PR resumes the same specialist session.
When no key is found the ask is fresh. Failure counts and launch records
live in `host.kv` keyed by PR or issue, not by session, so a fresh session
cannot reset them.

Debounce for `ci-watch`: 3 s per PR, latest event wins, buffer persisted
in `host.kv ci-watch/buffer/<pr>` before the 202, restored on `onStart`,
flush skipped when a turn for that PR is running. `pull_request.closed`
returns `{ task }` that deletes the buffer and the failure count.

### Env / secrets (names only) and stub vs live gates

Global (factory root `.env.example`, copied into each project that reads
it):

| Name | Read by | Effect |
| --- | --- | --- |
| `CURSOR_API_KEY` | all (model turns), launchers | required for `serve`; launches refuse without it |
| `FACTORY_LAUNCH` | `implementer`, `pr-reviewer`, `security-review`, `ci-watch`, `approver` | `1` enables cloud-agent launches, the Bugbot trigger, labels, and comments. Unset: decision recorded, `reason: "launch_disabled"` |
| `FACTORY_MERGE` | `approver` | `1` additionally enables the squash merge. Both gates must be set |
| `FACTORY_GITHUB_REPOS` | GitHub agents via `agent/lib/repos.ts` | comma list, one owner. Absent: GitHub channels mount but `cursorAccount` is off, fixtures and replay still work |
| `FACTORY_ESCALATE_SECRET` | `delivery-desk`, `ci-watch`, `approver` | HMAC for the escalate route. Absent: route is loopback-only (July default) |
| `FACTORY_DESK_URL` | `ci-watch`, `approver` | defaults to `http://127.0.0.1:3000/delivery-desk` |

Per agent:

| Agent | Names | Stub when absent |
| --- | --- | --- |
| `delivery-desk` | `DESK_SLACK_BOT_TOKEN`, `DESK_SLACK_APP_TOKEN`, `FACTORY_ESCALATION_CHANNEL` | Slack channel idle; playground and HTTP still route; escalations logged to the session trace |
| `issue-triage` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `JIRA_WEBHOOK_SECRET` | in-memory tracker stub with the same tool names; unsigned webhooks admitted only on `--dev` loopback |
| `pr-reviewer` | `BUGBOT_API_KEY` (optional) | falls back to a `bugbot run` PR comment; without `FACTORY_LAUNCH` neither happens |
| `security-review` | `SECURITY_PATHS` (glob list; default `auth/**,billing/**,**/*.env*,.github/workflows/**`) | default list |
| `ci-watch` | none beyond global | |
| `approver` | `BUGBOT_LOGINS` (default `cursor[bot]`) | default |
| GitHub direct webhook / GHES only | `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` (replay pull access) | `cursorAccount` path needs neither |

Each project has a `.env.example` naming what it reads. `.env.local` is
gitignored. `hosting.secretNames` lists the same names for deploy. No
value lives in git, in a prompt, or in a tool result.

Eval sessions (`ctx.session.purpose === "eval"`) short-circuit before any
gate check. Every side-effect tool declares `effect: "write"` and a
`dryRunResult` that mirrors the live result shape with `launched: false`
/ `merged: false`, so dry-run and eval traces are readable and evals can
assert on `reason`.

## Eval plan

One eval file per agent, `tags: ["smoke"]`, `evals/evals.config.ts` with
`maxConcurrency` in each project. Host libs get `node --test` unit tests
next to them (`*.test.ts`) for the deterministic parts: HMAC verify, PR
URL canonicalisation, failure counting, risk floor, brief text.

| File | Cases | Asserts |
| --- | --- | --- |
| `delivery-desk/evals/route.eval.ts` | jira, github-pr, implement, implement-repo, security, ci, ci-again, approve, approve-high, review-says-merge, follow-status, smalltalk | `t.succeeded()`; `t.calledTool("log_route", { count: 1, input: { destination } })`; `t.maxToolCalls(1)` (desk never calls a peer itself); reply names the slug; `output.status ∈ {completed, running, error, cancelled, unreachable}`. `implement` and `approve` assert `t.parked()` and `t.requireInputRequest()` names `log_route`, proving HITL fires. `smalltalk` asserts `t.usedNoTools()` |
| `issue-triage/evals/triage.eval.ts` | bug, question, feedback, duplicate-title, needs-info, wrong-key-in-body | one `record_triage`; `output.tracker.status === "skipped"` and `reason === "eval"`; verdict `identifier` equals the session key even when the body names another ticket; no `create` op ever appears |
| `implementer/evals/pr.eval.ts` | brief, brief-with-repo, chat-without-issue | `start_pstack` once with `output.launched === false`, `reason === "eval"`, `playbook === "poteto-mode"`, brief includes the issue key and repo; the chat case asserts `t.notCalledTool("start_pstack")` so a routine eval can never spend cloud budget |
| `pr-reviewer/evals/review.eval.ts` | opened, draft, same-sha-twice | `request_bugbot` once, `output.requested === false`, `reason === "eval"`; draft asserts `t.notCalledTool`; the second send on the same head SHA reports `reason: "already_requested"` from the in-process eval map |
| `security-review/evals/security.eval.ts` | auth-path, docs-only | auth-path: `request_security_review` once, `launched === false`, `reason === "eval"`, reply mentions `/review-security`; docs-only: `t.notCalledTool("request_security_review")` and reply says no review needed |
| `ci-watch/evals/ci.eval.ts` | first, second, unspecified, replay | mirrors the Atlassian file with GitHub PR URLs: the first failure gives `action: "autopilot"`, `reason: "eval"`; a replay of the same PR gives `action: "escalate"`, `reason: "not_first"`, `failures: 2`; the reply never says both words |
| `approver/evals/approval.eval.ts` | docs-clean, auth-clean, findings-open, floor-overrides-model | `record_approval` once; `merged === false`; docs-clean gives `decision: "auto_merge"`, `reason: "eval"`; auth-clean and findings-open give `escalate`; the floor case seeds a prompt that begs for `auto_merge` on a billing path and asserts `output.decision === "escalate"` with `reason: "risk_floor"` |

Evals never write, by three independent mechanisms:

1. Every tool's `execute` checks `ctx.session.purpose === "eval"` first
   and returns the eval-shaped result before touching `host.kv`, GitHub,
   Jira, Slack, or `/v1/agents`. Eval counters (per-SHA, per-PR) live in a
   process-local `Map`, so a replayed prompt inside one case still counts
   without dirtying the durable store.
2. `effect: "write"` + `dryRunResult` stubs the write in dry-run sessions
   with the same result shape.
3. Route evals run against a factory serve started on a fresh
   `--state-root` with `FACTORY_LAUNCH`, `FACTORY_MERGE`, and every
   `JIRA_*`/`DESK_SLACK_*`/`BUGBOT_*` name unset. Peer `ask` opens
   ordinary sessions on the specialists, not eval sessions, so this is
   the only defence for the route layer and the README says so.

## Tradeoffs accepted

- **Four GitHub relays for the same repos.** `pr-reviewer`,
  `security-review`, `ci-watch`, and `approver` each mount
  `githubChannel({ cursorAccount })`. Four minted credentials, four event
  pulls, each agent only wakes on the events its hooks declare. Cost is
  duplicated relay traffic and four places to keep `repos.ts` aligned
  (`FACTORY_GITHUB_REPOS` does that). Gain is that each specialist is
  independently useful, deployable, and evaluable, and only `approver`
  ever holds `contents-write`.
- **HITL lives in Slack, at the desk, on the route.** `log_route` parks
  for `implementer` and `approver` destinations. GitHub-originated
  `approver` wakes are unattended and rely on the deterministic risk floor
  plus `FACTORY_MERGE=1`. A human can still turn the merge off with one
  env var; they cannot approve a GitHub-originated merge from Slack in
  this cut.
- **The `cursor-cloud-agents` extension is not mounted.** Mounting it
  would put launch/follow-up/cancel tools on the model, breaking the
  one-tool rule. `implementer`, `security-review`, and `ci-watch` POST
  `/v1/agents` from host code instead. We lose the extension's follow-up
  and cancel affordances; we keep the invariant.
- **Escalation to Slack is an HTTP POST, not a peer call.** It needs a
  shared secret and a desk URL in two specialists. The alternative (a
  `host-connections/desk.ts` peer using `call_tool`) needs a desk server
  tool, and server tools are model-visible. Two env names is the cheaper
  price.
- **Jira writes are `issue-triage` only.** Implementation and merge status
  do not get Jira comments from the factory. Jira's GitHub integration
  covers PR linkage when the issue key is in the PR title, which the
  pstack brief enforces. Teams without that integration lose the link.
- **Peer `ask` sessions are not eval sessions.** Route evals are only
  safe because the operator serves without gates on a throwaway state
  root. This is a July property, not something the factory can fix.
- **Bugbot trigger is indirect.** Without `BUGBOT_API_KEY` the host posts
  a `bugbot run` comment. That is a real PR write and is behind
  `FACTORY_LAUNCH`, but it means `pr-reviewer` on a repo where Bugbot
  already auto-runs would double-trigger. Dedupe is per head SHA on our
  side only.

## Alternatives this shape rejects

- **One GitHub agent with subagents for review, CI, and approval.**
  Rejected by brief and by design, because a subagent inherits the
  parent's tools, so a single `contents-write` credential would sit under
  the reviewer and the CI watcher too. Peers keep permission tiers
  separate.
- **Slack desk that owns Jira and GitHub writes.** This is rejected. The desk
  would become the system of record's only writer, every specialist would
  have to route its side effect back through the desk, and the factory
  would stop working when Slack was down. Slack is intake and
  notification only.
- **A `github-intake` agent that receives all GitHub events and
  `send()`s to peers.** Cleaner relay story, but it is a second router
  with its own routing table, and every specialist loses its own
  `github replay` test tier. Four relays is what it costs to keep each
  specialist independently useful.
- **`runtime: "cloud"` for `implementer`.** Moves the implementer's own
  turns to a VM. Approvals do not resolve on the cloud runtime and peers
  need `--public-url`. The implementer's job is to start *other* cloud
  agents, which the local runtime does fine.
- **Triage that files tickets.** This is rejected. Slack @Cursor and people file.
  `record_triage` has no create path and the tracker connection's tool
  list has no create tool, so the model cannot find one.
- **`needsApproval` on `record_approval` itself.** Would park every
  GitHub-originated merge with nowhere for the card to land (approver has
  no Slack). Moved the approval to the desk route instead, and kept the
  unattended path behind `FACTORY_MERGE=1` plus the risk floor.

## Open questions

1. `githubChannel` `{ auth }` return: does it accept `message` and
   `title` like `bitbucketChannel` did in the Atlassian factory? The
   guide documents `workspaceFiles` only. With `tools: []` the model
   cannot read a seeded file, so the evidence must be in the prompt. If
   `message` is not supported, `security-review` and `approver` return
   `{ task }` that calls `send(prompt, { continuationToken })` instead.
2. Several `cursorAccount` channels for the same repos on one host: does
   the relay dedupe per host or per agent, and are there rate or
   installation limits on minting four credentials?
3. `host.slack` from a channel handler: is there a "post to
   named channel" call, or only reply-into-thread? If only the second,
   the
   escalate route falls back to Slack Web API `chat.postMessage` with
   `DESK_SLACK_BOT_TOKEN` from host code.
4. Bugbot trigger: is the API (`BUGBOT_API_KEY`) available to this
   account, or is the `bugbot run` comment the only path? Affects
   `pr-reviewer/lib/bugbot.ts` only.
5. Does merging a PR through the minted `contents-write` credential work
   for repos with branch protection that requires the merger to be a
   reviewer? If not, `auto_merge` degrades to "enable GitHub auto-merge"
   and a human's approval completes it.
6. Is there an `onPullRequestReview` hook, or does `approver` need the
   `onEvent` catch-all to see Bugbot's review submission?
7. Jira Cloud webhook signing: confirm the header is
   `X-Hub-Signature-256` HMAC over the raw body as the `triage-jira`
   template's `verify-webhook.ts` assumes, versus a URL secret.

None of these change the shape. Each is a `lib/` file swap.

## First implementation step

Scaffold the seven projects and prove the peer graph resolves before
writing any GitHub or Jira code:

```bash
mkdir this repository && cd $_
npx @cursor/july init ./issue-triage --template triage-jira
for slug in delivery-desk implementer pr-reviewer security-review ci-watch approver; do
  npx @cursor/july init ./$slug
done
```

Then, in one pass:

1. Set `model: { id: "grok-training-latest" }`, `tools: []`,
   `local: { sandbox: true }` in every `agent/agent.ts`.
2. Author the six `delivery-desk/agent/mcp-connections/<slug>.ts` files
   and copy `log_route.ts` + `follow-up.ts` from the Atlassian desk,
   with the `needsApproval` predicate added.
3. Give each specialist a placeholder decision tool with the final name
   and schema, `effect: "write"`, `dryRunResult`, and an `execute` that
   returns the eval-shaped result unconditionally.
4. `npx @cursor/july validate --dir .` at the factory root, then
   `serve --dir . --dev`, confirm `/` lists seven slugs, and
   `chat --url .../delivery-desk --message "Triage Jira TLSSN-12 ..."`
   returns `status: completed` with `issue-triage`'s stub reply.

That is the whole first step. Slack, Jira, and GitHub channels come
after the graph is proven, one agent at a time, each with its own
`github replay --dry-run --out fixtures/github` snapshot before any live
event.

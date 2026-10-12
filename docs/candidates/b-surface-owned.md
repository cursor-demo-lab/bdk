# Surface-owned factory

Candidate B. Four agents, one per external surface. Amplitude's stages
(intake, ticket, PR, Bugbot, risk, merge) are states and skills *on* a
surface, not agents. Target package `@cursor/july@0.2.1`. Factory model
`grok-training-latest`. Node 22.13+, never Bun.

## Problem

The Atlassian sibling (`../../Software_Factory_Atlassian/`) is a seven-project
desk: one inbound desk plus six specialists (`issue-triage`, `implementer`,
`pr-reviewer`, `security-review`, `ci-watch`, `approver`) joined by peer MCP.
It demonstrates every July feature, and it is the wrong shape for a
GitHub-backed factory for three reasons:

1. **A PR is one conversation, but the desk splits it across four sessions.**
   `pr-reviewer`, `security-review`, `ci-watch`, and `approver` each keep
   their own `host.kv`, their own continuation, and their own view of the
   same PR. Nothing owns "the state of `acme/api#128`". The merge decision
   reads a summary of a summary.
2. **Every stage transition is a model turn plus a peer step.** `ask` on a
   peer opens a fresh session and blocks in ~50s slices. A single CI-failure
   event can cost three model turns (desk routes, `ci-watch` decides,
   `approver` re-decides) before anything happens on GitHub. GitHub sends
   ten such events per push.
3. **The router *is* the god-prompt.** The desk's instructions must know
   what all six specialists do and when to call each. Moving the branching
   into a front-door prompt does not remove it; it puts it where evals are
   hardest to write.

GitHub event volume is the design constraint that decides the shape. A
real PR produces `pull_request.synchronize`, several `check_run` and
`check_suite` deliveries, review comments, and Bugbot's own review, often
inside a few seconds. The July GitHub guide is explicit: debounce per PR,
persist the buffer in `host.kv`, key sessions on `pr:owner/repo#N`, keep
payload details out of wake prompts, and re-read GitHub. Those rules are
much easier to honor in one project that owns the channel than across four
that each receive a copy.

The surface-owned factory puts the deterministic routing in `githubChannel`
hooks and host `task`s where it is free, and spends model turns only on
judgement: whether Bugbot's finding is blocking, what the Autopilot brief
should say, and whether this PR merges.

## Usage (operator and caller view)

### Serve

```bash
cd .
npx @cursor/july login                     # or CURSOR_API_KEY
npx @cursor/july validate --dir .
npx @cursor/july serve --dir . --dev --cursor-events
```

One port, slug per directory: `/slack-desk`, `/jira-triage`,
`/github-factory`, `/implementer`. `--cursor-events` starts the SCM relay
for the repos `github-factory/agent/lib/repos.ts` declares. Without
`SLACK_DESK_SLACK_*` tokens the Slack channel stays idle and the rest
serves. Without `FACTORY_LIVE=1` every GitHub, Jira, Slack-post, and cloud
write is recorded and stubbed.

### Chat

```bash
npx @cursor/july chat --url http://127.0.0.1:3000/slack-desk \
  --message "What is the state of acme/api#128?"
npx @cursor/july chat --url http://127.0.0.1:3000/github-factory \
  --message "Re-check pr:acme/api#128. Mode: merge-risk."
```

The playground at `/<slug>/playground` lists `/queue/issue` (jira-triage)
and `/drive` (github-factory) as slash commands from their route schemas.

### Eval

```bash
# Isolated, per agent. No peers resolve; tools stub on purpose === "eval".
npx @cursor/july eval --dir github-factory --tag smoke
npx @cursor/july eval --dir jira-triage
npx @cursor/july eval --dir slack-desk
npx @cursor/july eval --dir implementer

# Route evals need the factory serving so peers resolve. Fresh state root.
npx @cursor/july serve --dir . --port 3777 --state-root "$(mktemp -d)"
npx @cursor/july eval --dir slack-desk --url http://127.0.0.1:3777/slack-desk
```

Deterministic host code is tested without a model turn:

```bash
npx @cursor/july call decide_merge --dir github-factory --input '{
  "pr": "acme/api#128", "verdict": "auto_merge", "reasons": ["green", "docs only"]
}'
npx @cursor/july github replay acme/api#128 --dir github-factory \
  --events '*' --conclusion failure --dry-run --out fixtures/github
```

### Call site 1: Slack thread (intake to PR)

```
#eng-intake
  alice: @desk TLSSN-42 is triaged and ready. Get a PR up.
  desk:  [reads TLSSN-42 via jira-triage.read_issue]
         Brief for TLSSN-42 (CSV export 500s on empty filter):
         repo acme/api, branch fix/TLSSN-42-csv-export, ...
         [Approve / Deny card]  dispatch_implementation
  alice: [Approve]
  desk:  Cloud agent launched: https://cursor.com/agents/bc_…
         I'll post in this thread when the PR opens and when it needs you.
```

`slack-desk` never touches Jira or GitHub itself. `read_issue` is a
deterministic `call_tool` on the `jira-triage` peer. `dispatch_implementation`
is `needsApproval: true`; the Slack card is the human gate. On approval the
tool calls `host.mcp.callTool("implementer", "ask", { message: brief })`
and stores `thread/TLSSN-42` as `{channelId, threadTs}` in `host.kv` so
later escalations for that ticket land in the same thread.

### Call site 2: Jira webhook (ticket)

```
Jira → POST /jira-triage/v1/channels/webhook   (X-Hub-Signature-256)
     → verifyTrackerWebhook(JIRA_WEBHOOK_SECRET)
     → send(prompt, { continuationToken: "TLSSN-43", admission: "coalesce" })
     → model reads skills/triage-rubric.md, calls record_triage once
     → actuate(): Triage: comment, priority for bugs, duplicate link
```

The official `triage-jira` overlay, unchanged in its writes. It comments on
the issue that started the session (`ctx.session.continuationKey`), never
the identifier the model copies from the body. It never creates tickets.
Ticket creation stays with humans and native Slack `@Cursor`.

### Call site 3: GitHub PR opened, then CI fails

```
t+0s   pull_request.opened acme/api#128 (branch fix/TLSSN-42-…)
       hook → { task }: buffer.push("pr:acme/api#128", "opened"); 202
t+1s   check_suite.requested ×3, pull_request.synchronize
       hook → { task }: buffer.push(...) latest wins; still one flush pending
t+3s   flush: not busy → host re-reads PR, diff, checks, Bugbot state
       writes pr/state.json, pr/diff.patch; mode = review-pass
       send("Re-check pr:acme/api#128. Mode: review-pass.",
            { continuationToken: "pr:acme/api#128", admission: "coalesce",
              workspaceFiles })
       commitStatus factory=in_progress, banner "Factory: reviewing…"
t+40s  model: Bugbot has not run → request_bugbot (posts "bugbot run")
       security paths touched? no (risk.ts) → skip security-pass
       turn ends → commitStatus success "Factory: waiting on Bugbot + CI"
t+6m   check_suite.completed conclusion=failure
       hook → { task }: kv gh/ci-failures/pr:…#128 = 1; buffer.push("ci")
t+6m3s flush: mode = ci-fix (first failure). host writes pr/ci-failure.json
       model loads skills/ci-fix, writes an Autopilot brief,
       queue_autopilot → implementer.ask("Fix CI on acme/api#128: …")
t+15m  pull_request.synchronize (cloud agent pushed), check_suite success,
       Bugbot review posted
       flush: mode = merge-risk. model reads pr/state.json:
       bugbot=0 blocking, checks green, risk=low → decide_merge(auto_merge)
       gates.ts re-reads live PR; FACTORY_LIVE=1 → merges; banner "Merged"
   or  risk=medium → decide_merge downgrades to escalate, mints decisionId,
       slack-desk.call_tool("open_decision", …) → card in TLSSN-42 thread
```

The host escalates a second CI failure on the same PR before the model
sees it. `modes.ts` returns `merge-risk` with `ciEscalated: true`, and
`decide_merge` refuses `auto_merge` when that flag is set.

## Shape

### Four agents

| Slug | Surface | Owns | Model turns spent on | Writes | Peers out |
| --- | --- | --- | --- | --- | --- |
| `slack-desk` | Slack Socket Mode | Intake threads, approvals, status threads | Understanding a request, composing a brief, explaining state | Slack only (`host.slack`) | `jira` (call_tool), `github` (ask, call_tool), `implementer` (ask) |
| `jira-triage` | Jira via Cursor MCP | Triage of existing issues | Classification against the rubric | Jira comment, priority, duplicate link | none (leaf) |
| `github-factory` | GitHub via `cursorAccount` | The PR lifecycle: review, security, CI, merge | One mode per wake: read state, call one decision tool | PR comments, check run, merge | `implementer` (ask), `slack-desk` (call_tool only) |
| `implementer` | Cursor cloud agents | Launching and steering coding agents | Turning a brief into a launch, reporting back | Cloud agent launches, follow-ups | none (leaf) |

Every agent runs `defineAgent({ model: "grok-training-latest", tools: ["read", "grep", "glob", "ls"] })`.
No native shell for the model. GitHub, Jira, Slack, and cloud writes live in
authored server tools that declare `effect: "write"`, return
`dryRunResult`, and return `{ posted: false, reason: "eval" }` when
`ctx.session.purpose === "eval"`.

### Amplitude stages mapped onto surfaces

| Amplitude stage | Where it lives | Mechanism |
| --- | --- | --- |
| Intake | `slack-desk` | `slackChannel` mentions/DMs + `engagement.channelPosts` on `#eng-intake`; skill `intake` |
| Ticket | `jira-triage` | `triage-jira` overlay; `webhook` + `queue` channels; `record_triage` |
| Open the PR | `implementer` (asked by `slack-desk`) | `cursor-cloud-agents` extension; `record_brief` |
| Bugbot | `github-factory` mode `review-pass` | Host reads Bugbot's review state; `request_bugbot` posts `bugbot run` |
| Security pass | `github-factory` mode `review-pass`, skill `security-pass` | Host decides eligibility from `risk.ts`; model reads `pr/diff.patch`; `post_findings` once |
| Failed build, then Autopilot | `github-factory` mode `ci-fix` | `onCheckSuite`/`onWorkflowRun` failure; kv failure count; `queue_autopilot` calls `implementer.ask` |
| Risk gate | `github-factory` mode `merge-risk` | `decide_merge` with `gates.ts` re-reading the live PR |
| Merge or escalate | `github-factory` + `slack-desk` | Merge inside `decide_merge`; escalate through `open_decision`, then a Slack card, then `resolve_decision`, then `apply_decision` |

### Folder map

```text

├── README.md
├── docs/candidates/b-surface-owned.md
├── slack-desk/
│   ├── package.json  tsconfig.json  .env.example
│   ├── agent/
│   │   ├── agent.ts
│   │   ├── instructions.md
│   │   ├── channels/slack.ts               envPrefix SLACK_DESK, toolApprovals, channelPosts
│   │   ├── mcp-connections/
│   │   │   ├── jira.ts                     defineConnection({ agent: "jira-triage" })
│   │   │   ├── github.ts                   defineConnection({ agent: "github-factory" })
│   │   │   └── implementer.ts              defineConnection({ agent: "implementer" })
│   │   ├── tools/
│   │   │   ├── dispatch_implementation.ts  needsApproval; → implementer.ask
│   │   │   ├── open_decision.ts            host-called by github-factory; posts card
│   │   │   ├── resolve_decision.ts         needsApproval; → github-factory.call_tool apply_decision
│   │   │   └── post_status.ts              host-called; threads status lines
│   │   ├── skills/intake.md  skills/status.md
│   │   └── lib/threads.ts  lib/brief.ts
│   └── evals/evals.config.ts  evals/intake.eval.ts  evals/decisions.eval.ts
├── jira-triage/                            npx @cursor/july init --template triage-jira
│   ├── agent/ (template: channels/{queue,webhook}.ts, tools/record_triage.ts,
│   │           mcp-connections/tracker.ts, skills/triage-rubric.md, lib/*)
│   │   └── tools/read_issue.ts             added: effect "read", host MCP
│   └── evals/ (template three cases + read_issue)
├── github-factory/
│   ├── package.json  tsconfig.json  .env.example
│   ├── agent/
│   │   ├── agent.ts
│   │   ├── instructions.md                 ~40 lines, mode contract only
│   │   ├── storage.ts                      cursorHostedStorage() when hosted
│   │   ├── channels/
│   │   │   ├── github.ts                   githubChannel: hooks, progress, cursorAccount
│   │   │   └── drive.ts                    POST /drive { pr } → same continuation
│   │   ├── mcp-connections/
│   │   │   ├── implementer.ts              defineConnection({ agent: "implementer" })
│   │   │   └── slack-desk.ts               defineConnection({ agent: "slack-desk" })
│   │   ├── tools/
│   │   │   ├── request_bugbot.ts
│   │   │   ├── post_findings.ts
│   │   │   ├── queue_autopilot.ts
│   │   │   ├── decide_merge.ts
│   │   │   └── apply_decision.ts
│   │   ├── skills/
│   │   │   ├── review-pass.md
│   │   │   ├── security-pass.md
│   │   │   ├── ci-fix.md
│   │   │   └── merge-risk.md
│   │   └── lib/
│   │       ├── repos.ts                    allowlist; one GitHub owner
│   │       ├── buffer.ts  buffer.test.ts   debounce + kv persistence
│   │       ├── modes.ts   modes.test.ts    events + kv → wake mode
│   │       ├── risk.ts    risk.test.ts     paths, size, author → tier
│   │       ├── gates.ts   gates.test.ts    live re-read before merge
│   │       └── materialize.ts              PR → pr/state.json, pr/diff.patch, pr/ci-failure.json
│   ├── fixtures/github/                    from github replay --dry-run --out
│   └── evals/evals.config.ts  evals/{review-pass,security-pass,ci-fix,merge-risk}.eval.ts
└── implementer/
    ├── package.json  tsconfig.json  .env.example
    ├── agent/
    │   ├── agent.ts
    │   ├── instructions.md
    │   ├── extensions/cloud/               directory mount; launch disabled unless FACTORY_LIVE
    │   ├── tools/record_brief.ts           writes briefs/<key>.md to host.files
    │   ├── skills/brief.md                 pstack-shaped brief; ticket key in branch + PR title
    │   └── lib/repos.ts
    └── evals/evals.config.ts  evals/brief.eval.ts
```

`agent/lib/` is import-only. July discovers everything else under
`agent/`, so no stray `.ts` files belong there. `evals/` sits at each
project root, never under `agent/`.

### Channel ownership

| Channel | Project | Auth | Notes |
| --- | --- | --- | --- |
| `slack.ts` | `slack-desk` only | Socket Mode; `blockExternals` default | The only Slack app in the factory. `envPrefix: "SLACK_DESK"` so a second bot can be added later without collisions |
| `github.ts` | `github-factory` only | `cursorAccount` relay; `--cursor-events` | The only GitHub credential mint. `botName: "factory"` so self-comments are ignored |
| `webhook.ts`, `queue.ts` | `jira-triage` | `publicEndpoint()` + HMAC; loopback | From the template |
| `drive.ts` | `github-factory` | `localDevStrict()` default | Playground/HTTP entry to the same `pr:` continuation |
| `mcp` (`/<slug>/v1/mcp`) | all four | host auth chain | Always mounted; this is the peer transport |

### Peer MCP graph

```text
slack-desk ──ask/call_tool──▶ jira-triage      (read_issue; ask for a triage summary)
slack-desk ──ask/call_tool──▶ github-factory   (ask "state of pr"; call_tool apply_decision)
slack-desk ──ask───────────▶ implementer       (dispatch_implementation)
github-factory ──ask───────▶ implementer       (queue_autopilot)
github-factory ──call_tool─▶ slack-desk        (open_decision, post_status)
```

The graph has five edges and two leaves. The one cycle, between
`slack-desk` and `github-factory`, is not a model recursion.
`github-factory` reaches `slack-desk` only through
`host.mcp.callTool("slack-desk", "call_tool", …)` from tool code, which
runs no model turn on `slack-desk`, and `slack-desk` reaches
`github-factory.ask` only when a person asks in a thread. Instructions on `slack-desk`
scope delegation to "questions about a PR's state", not "anything about
GitHub". The sibling's desk has six edges from one node and needs the
router prompt to pick among them on every turn.

`ask` sessions land on the peer's `mcp` channel. The design accepts two
consequences. Peer sessions are ordinary and never carry
`purpose: "eval"`, so route evals must run against a factory served
without `FACTORY_LIVE`. And a `needsApproval` tool parked inside an `ask`
session has no Slack thread to post a card into, which is what decides
where approvals sit (below).

### How github-factory decides without a god-prompt

The model never chooses between Bugbot, security, Autopilot, and merge.
The host does, in `lib/modes.ts`, from the buffered events and `host.kv`
state. Each wake carries exactly one mode, and the model's job is to run
that mode's skill and call at most one decision tool.

```ts
// agent/lib/modes.ts (shape, not final code)
export type Mode = "review-pass" | "ci-fix" | "merge-risk" | "closed";

export function pickMode(input: {
  events: BufferedEvent[];      // since last flush, latest per kind
  ciFailures: number;           // kv gh/ci-failures/<pr>
  decision?: DecisionRecord;    // kv gh/decision/<pr>
  checks: "pending" | "green" | "red";
  bugbot: "absent" | "running" | "posted";
}): { mode: Mode; ciEscalated: boolean } {
  if (input.events.some((e) => e.kind === "closed")) return { mode: "closed", ciEscalated: false };
  if (input.checks === "red" && input.ciFailures === 1) return { mode: "ci-fix", ciEscalated: false };
  if (input.checks === "red") return { mode: "merge-risk", ciEscalated: true };
  if (input.checks === "green" && input.bugbot === "posted") return { mode: "merge-risk", ciEscalated: false };
  return { mode: "review-pass", ciEscalated: false };
}
```

Wake prompt, verbatim shape: `Re-check pr:acme/api#128. Mode: ci-fix. Read pr/state.json, then load the ci-fix skill.`
No payload fields. The host has already re-read GitHub into
`workspaceFiles` at flush time (`lib/materialize.ts`), so a stale
`synchronize` snapshot never reaches the model.

`instructions.md` for `github-factory` is a contract, not a procedure:

```markdown
You are the GitHub surface of the factory. Each wake names one PR and one
mode. Read pr/state.json first. Load the skill named by the mode. Call at
most one decision tool, then stop. Never merge, comment, or launch outside
those tools. If pr/state.json says the PR is closed, reply "closed" and stop.
```

The four skills carry the procedures:

| Skill | Reads | Decision tool | Judgement the model adds |
| --- | --- | --- | --- |
| `review-pass` | `pr/state.json` (Bugbot state, risk tier, `securityEligible`) | `request_bugbot` if Bugbot absent; then, if `securityEligible`, load `security-pass` | Whether Bugbot's posted findings are blocking vs nits; summary for the banner |
| `security-pass` | `pr/diff.patch` | `post_findings` (once; empty list allowed) | Exploitable bugs only, template rubric: injection, authz, secrets, SSRF, RCE |
| `ci-fix` | `pr/ci-failure.json` (failing job, tail of log, changed files) | `queue_autopilot` | Writing a brief a cloud agent can act on alone; noticing a flake vs a real failure |
| `merge-risk` | `pr/state.json` (`ciEscalated`, checks, Bugbot, findings, tier) | `decide_merge` | Weighing findings against the change; writing the escalation summary a human reads in Slack |

Skills are `SKILL.md`-convention procedures loaded on demand, so evals can
assert `t.loadedSkill("ci-fix")` alongside `t.calledTool("queue_autopilot")`.

Five tools are model-visible, and the deterministic policy is inside
them, per the July tools guide ("re-read the live PR inside the tool
before acting"):

- `request_bugbot({ pr })`: comments `bugbot run` via `ctx.host.github`
  unless Bugbot has already posted on the head SHA. `pr-write` is enough.
- `post_findings({ pr, findings[] })`: one review comment; refuses a second
  call on the same head SHA (kv `gh/findings/<pr>/<sha>`).
- `queue_autopilot({ pr, brief })`: `host.mcp.callTool("implementer", "ask", …)`;
  records the returned agent URL in kv; refuses if `ciFailures > 1`.
- `decide_merge({ pr, verdict, reasons[] })`: `gates.ts` re-reads the PR
  live: mergeable, all checks green, Bugbot posted with zero blocking, no
  high findings, `risk.tier === "low"`, `!ciEscalated`, `FACTORY_LIVE=1`.
  Only when every gate holds does `auto_merge` merge. Otherwise the tool
  downgrades to `escalate`, mints a 128-bit `decisionId`, writes
  `gh/decision/<pr> = { status: "awaiting", decisionId, summary }`, and
  calls `slack-desk.call_tool("open_decision", { pr, ticketKey, decisionId, summary, playgroundUrl })`.
  The `decisionId` is not in the tool's return value, so the model never
  sees it.
- `apply_decision({ pr, decisionId, decision, approver })`: called by
  `slack-desk`'s `resolve_decision` via `call_tool`, never by a model.
  Validates `decisionId` against kv, re-runs `gates.ts` minus the tier
  and `ciEscalated` gates (a human overrode those), merges under
  `FACTORY_LIVE=1`, writes `status: "applied"`, updates banner and check.

The model sees five tools plus `read` and `grep`. The sibling's seven
agents expose six `record_*` and `queue_*` tools spread across six
prompts, so the behavior count is similar and the coordination cost is
not.

### Approvals: durable decision records, not parked calls

`needsApproval` parks a call in a running turn. That is the right
mechanism when the person is already in the thread and will answer in
seconds to minutes, and the wrong one for a merge gate that may wait
overnight. Parked calls do not survive a host restart, a
GitHub-originated session has no Slack thread for `toolApprovals` to post
into, and an `ask`-originated session on the `mcp` channel has none
either.

So the factory uses two mechanisms, chosen by where the human is:

| Decision | Where the human is | Mechanism |
| --- | --- | --- |
| Dispatch an implementation | In a Slack thread, now | `slack-desk.dispatch_implementation` with `needsApproval: true`; `toolApprovals: true` posts the card in that thread |
| Confirm a merge escalation | In a Slack thread, now, replying "approve" | `slack-desk.resolve_decision` with `needsApproval: true`; the card shows the exact PR and decision; the click is the gate, and Slack records who clicked |
| The merge escalation itself | Anywhere, whenever | `gh/decision/<pr>` in `github-factory` kv, `decision/<decisionId>` in `slack-desk` kv, capability `decisionId` passed host-to-host. Survives restarts. `apply_decision` is re-entrant |
| Cloud launch on the implementer | Not present (`ask` session) | No park. The gate is on the caller (`dispatch_implementation` or `queue_autopilot`) plus `FACTORY_LIVE` on the mount. `cloud.repos` is always set, so `needsApproval` defaults to `false` on the extension |

`open_decision` posts to the ticket's thread when `thread/<ticketKey>` is
known (the brief puts the key in the branch name and PR title; `materialize.ts`
extracts it), else to `SLACK_DESK_APPROVALS_CHANNEL`. The card text carries
the summary and the playground session URL from `sessionUrls`.

### Continuation tokens and debounce

Tokens, one namespace per surface:

| Surface | Token | Owner |
| --- | --- | --- |
| GitHub PR | `pr:owner/repo#N` | `github-factory` (`github.ts` and `drive.ts` both use it, so a Slack "look at this PR" lands in the PR's own conversation) |
| Jira issue | `TLSSN-42` (the key) | `jira-triage` (template) |
| Slack thread | `channelId:threadTs` | `slack-desk` (pack default) |
| Peer ask | `sessionId` returned by `ask`, stored in caller kv | caller |

Debounce lives in `github-factory/agent/lib/buffer.ts`, instantiated in
`onStart`, which is where the channel receives `send`,
`isContinuationBusy`, `interruptContinuation`, and `host`:

```ts
// agent/channels/github.ts (shape)
import { githubChannel } from "@cursor/july/channels/github";
import { REPOS, allowed } from "../lib/repos.js";
import { PrBuffer } from "../lib/buffer.js";
import { materialize } from "../lib/materialize.js";
import { pickMode } from "../lib/modes.js";

let buffer: PrBuffer;

export default githubChannel({
  botName: "factory",
  cursorAccount: { repos: REPOS, permissions: process.env.FACTORY_LIVE === "1" ? "contents-write" : "pr-write" },
  deliverReplies: false,
  progress: {
    reactions: false,
    commitStatus: process.env.FACTORY_LIVE === "1"
      ? { context: "factory", pending: "Factory reviewing", success: "Factory done", failure: "Factory failed" }
      : false,
    banner: { pending: "Factory: reviewing…", success: "Factory: see check + comments", failure: "Factory: failed, see session" },
  },
  async onStart(args) {
    buffer = new PrBuffer({
      kv: args.host.kv,
      debounceMs: 3_000,
      isBusy: args.isContinuationBusy,
      flush: async (token) => {
        const state = await materialize(token, args.host);        // re-read GitHub
        const { mode, ciEscalated } = pickMode({ ...state, events: await buffer.drain(token) });
        if (mode === "closed") { await args.host.reminders?.cancelAll?.(token); return; }
        await args.send(`Re-check ${token}. Mode: ${mode}. Read pr/state.json, then load the ${mode} skill.`, {
          continuationToken: token,
          admission: "coalesce",
          workspaceFiles: state.files,                              // pr/state.json, pr/diff.patch, pr/ci-failure.json
        });
      },
    });
    await buffer.restore();                                        // host.kv → pending flushes
  },
  onPullRequest: (ctx, pr) =>
    allowed(pr.repo) && !pr.draft ? { task: () => buffer.push(prToken(pr), pr.action) } : null,
  onCheckSuite: (ctx, s) =>
    allowed(s.repo) && s.conclusion ? { task: () => buffer.push(prToken(s), `check:${s.conclusion}`) } : null,
  onWorkflowRun: (ctx, w) =>
    allowed(w.repo) && w.conclusion === "failure" ? { task: () => buffer.push(prToken(w), "check:failure") } : null,
  onComment: (ctx, c) =>
    allowed(c.repo) && c.isPullRequest && c.author !== "factory" ? { task: () => buffer.push(prToken(c), "comment") } : null,
});
```

Buffer rules, each with a unit test in `buffer.test.ts`:

1. `push` writes `gh/buffer/<token>` to `host.kv` **before** the task
   resolves, so the 202 ACK never precedes persistence.
2. Latest event per kind wins; the timer restarts on every push
   (3s, per the guide); CI kinds extend the window to 10s so a burst of
   `check_run` deliveries settles first.
3. `flush` is skipped and re-armed when `isContinuationBusy(token)`.
4. `restore()` on `onStart` re-arms a flush for every `gh/buffer/*` key,
   so a restart drops nothing.
5. `pull_request.closed` clears the buffer, the kv counters, and any
   reminder for that token.
6. Only `repos.ts` repos wake anything. Everything else is `null`, which
   costs no model budget.

Every hook returns `{ task }` because the model should never turn on a
raw delivery. The single `{ auth }` path is `drive.ts`, where a person
explicitly drives a PR from the playground or from `slack-desk`.

### Env and secrets

| Name | Project | Purpose | Live-only |
| --- | --- | --- | --- |
| `CURSOR_API_KEY` or `agent-sdk login` | all | Model turns, `cursorAccount` mint, Jira MCP, cloud launches | no |
| `FACTORY_LIVE` | all | `1` enables GitHub writes, merge, Slack posts, cloud launches | yes |
| `SLACK_DESK_SLACK_BOT_TOKEN`, `SLACK_DESK_SLACK_APP_TOKEN` | `slack-desk` | Socket Mode; written by `slack create --dir slack-desk --channel-posts` | no (idle without) |
| `SLACK_DESK_INTAKE_CHANNELS` | `slack-desk` | `engagement.channelPosts.allow`, default `#eng-intake` | no |
| `SLACK_DESK_APPROVALS_CHANNEL` | `slack-desk` | Fallback for `open_decision` when no ticket thread is known | no |
| `JIRA_WEBHOOK_SECRET` | `jira-triage` | HMAC on `/v1/channels/webhook` | no |
| `JIRA_PROJECT_KEYS` | `jira-triage` | Only these keys are written, default `TLSSN` | no |
| Jira connection | `jira-triage` | Connected in the Cursor dashboard MCP; `defineConnection({ cursorAccount: true, servers: ["Jira"] })`; no token in env | no |
| `GITHUB_FACTORY_REPOS` | `github-factory` | Overrides `agent/lib/repos.ts`, one owner | no |
| `BUGBOT_LOGIN` | `github-factory` | Bugbot's GitHub login for state detection, default `cursor[bot]` | no |
| `GITHUB_WEBHOOK_SECRET` | `github-factory` | Only for GHES / direct webhook; unused with `--cursor-events` | no |
| `IMPLEMENTER_REPOS` | `implementer` | `cloud.repos` allowlist | no |
| `IMPLEMENTER_MODEL` | `implementer` | Model launched cloud agents run; omit for account default | no |

No GitHub PAT, no GitHub App key, no Slack signing secret, no Jira API
token. Each project has a `.env.example`. Values live in `.env.local`.

### Stub vs live gates

| Effect | Stub (`FACTORY_LIVE` unset) | Live (`FACTORY_LIVE=1`) |
| --- | --- | --- |
| GitHub reads (`materialize.ts`) | Live if signed in; fixtures under `fixtures/github/` when `--dev` replay | Live |
| `request_bugbot`, `post_findings` | Recorded in kv, `{ posted: false, reason: "stub" }` | PR comment via `ctx.host.github` |
| `progress.commitStatus` | Off (`pr-write` token has no `checks:write`) | On, `contents-write` |
| `progress.banner` | On (works on `pr-write`) | On |
| `decide_merge` auto_merge | Never merges; records verdict; still opens a Slack decision so the flow is visible | Merges when every gate holds |
| `apply_decision` | Records `applied: false` | Merges |
| `record_triage` | Template stub when tracker not connected | Jira comment/priority/dup |
| `open_decision`, `post_status` | Logged, returned as text | `host.slack.chat.postMessage` |
| Cloud launch (`implementer`) | Extension mounted as a directory with the launch and follow-up tools disabled via overlay; `record_brief` still writes the brief | Launch enabled; `needsApproval: false` because `cloud.repos` is set and the gate is on the caller |
| Any tool in `purpose === "eval"` | Skipped with shaped result | Skipped with shaped result |

Two independent gates guard every write: session purpose (never in evals)
and `FACTORY_LIVE` (never by accident in dev). `needsApproval` is a third
gate on the two Slack-side tools.

## Eval plan

The deterministic code is tested first and the model second. Model evals
gate tool choice and output shape, never prose.

### Unit tests (node:test, no model, no credential)

- `github-factory/agent/lib/buffer.test.ts`: persist-before-ack, latest
  wins, busy skip and re-arm, restore after simulated restart, closed
  clears.
- `modes.test.ts`: the mode table above, including a second failure
  giving `merge-risk` with `ciEscalated`.
- `risk.test.ts`: path globs (`auth/**`, `**/crypto*`, `.github/workflows/**`,
  lockfiles) setting `securityEligible`, and size thresholds setting the
  tier.
- `gates.test.ts`: every gate individually flips `auto_merge` to
  `escalate`; the `apply_decision` gate subset; an unknown `decisionId`
  refused.
- `slack-desk/agent/lib/threads.test.ts`: the ticket key to thread lookup
  and its fallback.

### Tool calls (no model)

```bash
npx @cursor/july call decide_merge --dir github-factory --input '{...}'   # returns escalate in stub
npx @cursor/july call read_issue --dir jira-triage --input '{"identifier":"TLSSN-42"}'
npx @cursor/july call record_brief --dir implementer --input '{...}'
```

### Isolated evals (per project, `agent-sdk eval --dir <slug>`)

`github-factory`, all seeded through `workspaceFiles` with committed
fixtures, tagged `smoke`:

| Case | Seed | Gates |
| --- | --- | --- |
| `review-pass/bugbot-absent` | state: bugbot absent, not security-eligible | `calledTool("request_bugbot")`, `notCalledTool("post_findings")`, `notCalledTool("decide_merge")`, `maxToolCalls(3)` |
| `review-pass/security-eligible` | state: eligible, `pr/diff.patch` with reflected XSS | `loadedSkill("security-pass")`, `calledTool("post_findings", { input: { findings: (f) => f.length >= 1 } })` |
| `security-pass/docs-only` | eligible by path but diff is markdown | `calledTool("post_findings", { input: { findings: [] } })` |
| `ci-fix/first-failure` | `ciFailures: 1`, `pr/ci-failure.json` with a real lint error | `loadedSkill("ci-fix")`, `calledTool("queue_autopilot")`, `notCalledTool("decide_merge")`, judge `closedQA("brief names the failing step")` soft `.atLeast(0.7)` |
| `merge-risk/low-green` | green, Bugbot 0 blocking, tier low | `calledTool("decide_merge", { input: { verdict: "auto_merge" } })` |
| `merge-risk/ci-escalated` | `ciEscalated: true` | `calledTool("decide_merge", { input: { verdict: "escalate" } })`, `notCalledTool("queue_autopilot")` |
| `merge-risk/high-findings` | one high security finding | `verdict: "escalate"`, reply includes `/escalat/i` |
| `closed` | state closed | `usedNoTools()`, `messageIncludes(/closed/i)` |

`slack-desk` (peers do not resolve in isolation; tools return
`{ peer: "unavailable" }` and the eval asserts the decision, not the hop):

| Case | Gates |
| --- | --- |
| `intake/dispatch-parks` | "TLSSN-42 is ready, get a PR up" asserts `t.parked()`, `calledTool("dispatch_implementation", { input: { ticketKey: "TLSSN-42" } })` |
| `intake/question-no-dispatch` | "what does TLSSN-42 say?" asserts `succeeded()`, `notCalledTool("dispatch_implementation")` |
| `decisions/approve-parks` | a seeded kv decision plus "approve acme/api#128" asserts `t.parked()`, `calledTool("resolve_decision", { input: { decision: "merge" } })` |
| `decisions/unknown-pr` | "approve acme/api#999" with no record asserts `succeeded()`, `notCalledTool("resolve_decision")` |

`jira-triage`: the template's three cases (one per kind) plus
`read_issue` via `call`. `implementer`: `brief/no-launch-from-chat`, a
message without a ticket or repo must `notCalledTool(/^cloud__/)` so a
routine eval cannot spend cloud budget; `brief/records-brief` asserts
`calledTool("record_brief")` and the brief file shape with `matches(zod)`.

### Replay and route evals (explicit, not in the inner loop)

- `github replay acme/api#<fixture-pr> --dir github-factory --events '*' --conclusion failure`
  against `serve --dev` with a fresh `--state-root`; assert via
  `GET /v1/sessions` that exactly one `pr:` session exists after the burst
  and that `gh/buffer/*` is empty. This is the debounce test with the real
  channel.
- Route eval `slack-desk` `--url` against a served factory (no
  `FACTORY_LIVE`): the dispatch reaches the implementer's `ask`, which
  returns a stubbed launch, and the assertion is that the status reply
  carries `briefs/TLSSN-42.md`.
- Never serve for route evals with `FACTORY_LIVE=1`. Start each route-eval
  serve on a fresh state root because `gh/ci-failures/*` correctly changes
  the second run's answer.

### Hillclimb rule

Every kept prompt or skill change lands one eval that failed before it.
Never weaken a gate to pass a round.

## Tradeoffs accepted

- **`github-factory` is `contents-write` in live mode.** Merging and
  `commitStatus` both need it. The mitigation is that the model never has
  shell or a raw GitHub client; only `decide_merge`/`apply_decision` can
  merge, and both re-read the live PR and check `FACTORY_LIVE`. Stub mode
  runs on `pr-write`.
- **Security review is a skill inside one agent, not its own project.** If
  the security rubric grows or needs its own model, promote it to
  `agent/subagents/security-reviewer/` inside `github-factory` first,
  where it inherits the parent's tools and adds no new peer step. A
  separate project is the last resort.
- **Bugbot is treated as an external reviewer, not driven through an API.**
  `request_bugbot` posts `bugbot run` and the factory waits for the review
  event. This adds one wake cycle but avoids a second GitHub integration
  and a credential the July docs do not cover.
- **The merge escalation adds one round-trip through Slack.** The
  `decisionId` capability plus two kv records is more machinery than a
  parked `needsApproval` call. It is the price of surviving restarts and
  of a human deciding from Slack against a GitHub-originated session.
- **`slack-desk` keeps state (`thread/<ticket>`, `decision/<id>`).** A pure
  router would be stateless, but then escalations could not return to the
  originating thread.
- **Host code has to be right.** `modes.ts`, `gates.ts`, and `buffer.ts`
  make decisions the model cannot override. That is the point, and it
  means unit tests on `lib/` matter more than model evals here.

## Alternatives this shape rejects

- **Seven-specialist desk (the sibling).** Rejected for the three reasons
  in Problem: split PR state, a model turn per step, and a router
  god-prompt. It also needs four projects with GitHub reads and a
  peer-resolution quirk (`call`/`run`/`eval` on the desk fail outside the
  factory dir).
- **A `delivery-desk` sibling in front of these four.** That adds a step
  to every path and reintroduces the router prompt. `slack-desk` already
  receives every human request, and GitHub and Jira do not need one.
- **Splitting `github-factory` into `pr-reviewer` / `ci-watch` /
  `approver` peers.** Each would need its own `githubChannel` (three
  credential mints, three copies of the debounce buffer) or a relay from
  one channel owner (the router again). The kv failure counter and the
  merge gates want to sit next to the buffer that sees the events.
- **`{ auth }` on raw GitHub hooks.** A model turn per delivery at
  GitHub's volume is the failure mode the guide's high-volume section
  warns against. All hooks return `{ task }`; the buffer decides when to
  `send`.
- **`runtime: "cloud"` for `github-factory`.** Approvals do not resolve on
  the cloud runtime and peers need `--public-url`. The factory needs
  neither a checkout for the reviewer nor cloud turns; the implementer's
  *launched agents* get checkouts.
- **Parked `needsApproval` as the merge gate.** Rejected above, because
  there is no thread to post into, a park does not survive a restart, and
  `ask` would block in 50s slices while a person sleeps.
- **A Jira-to-Slack push after every triage.** That is tempting, but it
  makes `jira-triage` non-leaf and doubles the Slack noise. The Jira
  comment is the record, and anyone who wants a Slack ping can ask
  `slack-desk`.

## Open questions

1. **`onStart` handle for flush-driven `send`.** The channels reference
   lists `send`, `isContinuationBusy`, and `interruptContinuation` on
   `onStart` args for the authored `defineChannel`. The design assumes
   `githubChannel`'s `onStart` receives the same helpers. If it does not,
   the buffer's flush uses `ctx.send` from the last hook context or the
   channel exposes a loopback `POST /drive` for the buffer to call itself.
   Verify against 0.2.1 typings before writing `buffer.ts`.
2. **Bugbot's login and event shape.** `BUGBOT_LOGIN` defaults to
   `cursor[bot]`; confirm the exact login and whether Bugbot posts a
   `pull_request_review` or issue comments, which decides the
   `materialize.ts` detection and whether `onComment` is enough.
3. **Overlay disable of extension tools.** The cloud-agents guide says
   "mount as a directory and disable that tool". Confirm the overlay
   syntax for env-conditional disabling in the extensions reference, or
   fall back to `cloud.repos: []` in stub mode (launches then cannot name
   a repo and default to `needsApproval: true`).
4. **The reminders API.** `host.reminders` exists on tool and hook
   contexts; the merge-conflict reminder pattern from `pr-autofixer` is
   worth copying once the schedules reference confirms cancellation by
   token.
5. **One Slack thread per ticket vs per PR.** Cloud agents may open two PRs
   for one ticket. `thread/<ticketKey>` collapses them into one thread;
   decide whether that is desirable before `open_decision` is written.
6. **Peer principal for `call_tool`.** `apply_decision` trusts the
   `decisionId` capability, not the caller. Under `--bearer-token` the
   token attaches automatically; confirm that host-side
   `host.mcp.callTool` to a peer passes the target's auth chain in hosted
   deploys.

## First implementation step

Scaffold the four projects and prove the GitHub debounce path end to end
with no model turn:

```bash
mkdir -p factory && cd factory
npx @cursor/july@latest init ./jira-triage --template triage-jira
npx @cursor/july@latest init ./github-factory --template security-reviewer --var repos=<owner>/<repo>
npx @cursor/july@latest init ./slack-desk --template demo
npx @cursor/july@latest init ./implementer --template demo
```

Then, in `github-factory` only:

1. Set `model: "grok-training-latest"` and `tools: ["read","grep","glob","ls"]` in `agent/agent.ts`.
2. Write `agent/lib/buffer.ts` with the five rules above and
   `buffer.test.ts` under `node --test`.
3. Replace the template's `channels/github.ts` with the `{ task }`-only
   hook set and `onStart` wiring; leave `progress.commitStatus` off.
4. Snapshot fixtures: `agent-sdk github replay <owner>/<repo>#<N> --dir . --events '*' --conclusion failure --dry-run --out fixtures/github`.
5. Serve `--dev` with a temp `--state-root`, POST the whole fixture set
   within one second, and confirm one `pr:` session and an empty
   `gh/buffer/*` via `GET /v1/sessions` and the playground. Kill and
   restart mid-burst; confirm the flush still happens.

Only after that passes do skills, decision tools, and the Slack decision
loop get written. If step 5 cannot be made to pass with the 0.2.1
`onStart` helpers, open question 1 becomes the first design change, and
it is cheap to make before anything depends on it.

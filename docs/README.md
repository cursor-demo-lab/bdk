# Software factory on Slack, Jira, and GitHub: docs

Design docs for the APJ GTM teaching factory on Amplitude's original stack.
Package: `@cursor/july@0.2.24`. Node 22.18+, never Bun. Phases 0 and 1 of
`plan.md` are in the sibling projects of this folder. Phase 2 still
needs a signed-in host. To set the factory up and run the demo, start
with [`../README.md`](../README.md); this folder explains the design.
To deploy, redeploy, or smoke-test the hosted slugs, use [`factory-deployment.md`](factory-deployment.md).

Setup and operations:

- [`factory-deployment.md`](factory-deployment.md): deploy, redeploy, logs, secrets, Jira delivery, Slack prerequisites, models, and the smoke test.
- [`slack-and-github-setup.md`](slack-and-github-setup.md): the Factory Slack app (`reactions:read`, `reaction_added`, ✅ / ❌ approvals) and the GitHub side.
- [`jira-automation.md`](jira-automation.md): the five TLSSN Automation rules and their `.jsonEncode` body templates.
- [`cursor-agent-automations.md`](cursor-agent-automations.md): the same wiring as Cursor Automations YAML (`the old monorepo `.cursor/automations/` (not included in this snapshot)/factory-*.yaml`, shipped `enabled: false`), with `cursor-agent automations validate` / `deploy`.

Read the factory as a set of long-running autonomous agents, not one-shot
hops. Six always-on slugs carry each ticket from Slack or Jira intake to
Done. The desk's hop watchdogs report a stall in the ticket's thread, and
`retry KEY` recovers it. What was worked past on hosted v2 is
[`deployment-issues.md`](deployment-issues.md), and what is still open is
[`next-steps.md`](next-steps.md).

The sibling `../../Software_Factory_Atlassian/` teaches the same Amplitude
pipeline as seven hand-built specialists on Jira and Bitbucket. This
folder teaches the same pipeline as three official July templates plus three
authored agents, a thin Slack desk, a read-only planner (hosted planning
turns run on a Cursor cloud agent; Jira writes stay on the planner host),
and a worker whose decisions and Jira writes are host code (the implement
run is a July cloud turn), on the
`cursorAccount` GitHub path the product invests in. The planner is the one
stage added to Amplitude's list: a plan a person approves in Slack before
anyone launches a cloud agent.

## End to end

One person, Alice, takes a ticket from idea to merged pull request
without leaving Slack until the review. Every post about the ticket goes
into one Slack thread. Six hosted agents run; none of them call each
other. The Jira ticket's status is the handoff: each agent writes its
artifact to the ticket and moves it, and a TLSSN Automation rule wakes
the agent that owns the next status. GitHub `pull_request` events carry
the last two moves. Every gate is a typed line or a ✅ / ❌ reaction on the
desk's filing prompt or plan post; hosted v2 inbound is `message`,
`app_mention`, and `reaction_added` (July 0.2.11 and later; no cards). Exact
`approve KEY` is a host path that acks with outbound ✅. The tables
below and `html/e2e.html`
show the same flow, one as text and one as a picture. `html/index.html`
is the short version with a step-by-step walk.
`event-driven-factory.md` holds the hosted topology and
`jira-automation.md` the rules that carry each Jira hop.

### The picture

Open [`html/e2e.html`](html/e2e.html) in a browser. It draws the run as a
swimlane in five phases (file the ticket in a thread; triage and plan on
the ticket's status, including a Needs-info thread reply; host approve
and launch in the same thread; build, In Review with `owner/repo#N`, and
review; fix a failed check, a person merges, Done with `owner/repo#N`).
Inside a phase time runs left to right, and each row is who acts:
people, Slack, Jira, each of the six agents, Cursor cloud, GitHub, the
settings, and the factory's own state (artifacts and `host.kv`). A
numbered box is the actor. A pill in another row is the result that
step writes there, in the system a person can open afterwards. An orange
tab marks every step a person must take. The same steps repeat under the
picture as a table, with the context stores and the integrations, so the
page prints. The step list is one array in the page's script, so a
change to the flow is one edit there.

### Where Alice is in the loop

| # | Alice does | Where | What it starts | If she does nothing |
| --- | --- | --- | --- | --- |
| 1 | `@Factory file a bug: CSV export returns 500 when the filter matches no rows` | A new thread in `#mars-eng-intake` | Jev triages it; the desk posts the filing prompt (verdict, Summary) and waits for a ✅ / ❌ reaction | Nothing; the thread stays a conversation |
| 2 | Reacts ✅ on the filing prompt (or replies `approve file`) | Same thread | The desk creates `TLSSN-42` and binds the thread to the key in `host.kv`. The desk writes `Triage:` and moves the ticket to Triaged (triage-jira skips a desk-filed ticket); the planner writes `Plan:` with a `Brief:` and moves it to Planned; the desk posts the plan into this thread | No ticket, no triage, no plan |
| 3 | Reacts ✅ on the plan post, or replies `approve TLSSN-42` (plain text; do not mention the bot). Cursor `*Sent using*` chrome and a Slack-autolinked KEY still count; extra words from the person do not | Same thread | Host code moves the ticket to Approved, records `approved-in-slack/<KEY>`, and acks with ✅ instead of a text reply. The Approved webhook stays quiet. The worker starts one July cloud turn from the `Brief:`, comments `Implementing: <url>` on the host, and moves the ticket to In Progress; the desk posts the URL (the thread's next beat) | Nothing launches; the plan waits on the ticket and in the thread |
| 4 | A reviewer approves and presses Merge | GitHub | The worker moves the ticket to Done (no second `Pull request:` comment) and the desk posts `KEY is Done: owner/repo#N was merged.` | The ticket stays In Review. No agent merges, and auto-merge never moves the ticket to Done |

Between 3 and 4 she has nothing to do. The cloud agent pushes a
key-prefixed branch; the worker opens the pull request ready, comments
`Pull request: <url>` once, and moves the ticket to In Review, and the
desk posts `KEY is In Review: owner/repo#N is open`. A Needs-info wait is answered by a reply in the thread, not by
editing Jira or `plan KEY`. See `html/e2e.html` for the host
approve path versus the model fallback. TLSSN-25's live miss was a Cursor
`*Sent using*` footer that the pre-#101 desk treated as extra words;
code on main now strips that chrome.
Bugbot and the security reviewer run on their own. A failed check on the
factory's pull request starts `pr-autofixer` by itself, because the
branch starts with the ticket key. For a pull request the factory did not
open, a person types `factory: drive` as a comment on the PR; asked in
Slack, the desk replies with that instruction and writes nothing to
GitHub.

Only the person who said `approve file` can `approve`, `deny`, or
`replan` the ticket, and only in its own thread. Dragging the card to
Approved on the board does the same, under Jira permissions. A ticket
filed in Jira directly runs the same chain in a thread the desk opens
in `FACTORY_DESK_INTAKE_CHANNEL` at Triaged (same replies and status
reactions, and a `Slack thread:` comment on the ticket that the plan and
the PR link back to), and can be approved only on the board. `plan TLSSN-43` plans a ticket the chain skipped, and
`replan` asks for a fresh plan.

### Integrations and who holds the credential

| Integration | Direction | Agent | Credential | Human gate |
| --- | --- | --- | --- | --- |
| Jira (`TLSSN`) | in: five TLSSN Automation rules. Issue created wakes triage; Triaged wakes the planner; Approved wakes the worker; Triaged, Planned, Approved, In Progress, In Review, and Done wake the desk, and so does an outcome comment (`Triage stopped:`, `Needs info:`, `Plan stopped:`, `Launch failed:`, "Approved without a plan", `not set from`). Out: one issue created, comments, transitions | `factory-desk` creates the issue, writes `Triage:` on Slack-filed tickets, and moves them to Triaged and later to Approved; `triage-jira` writes `Triage:` on tickets filed in Jira; `planner` writes `Plan:` on the host; `factory-worker` writes `Implementing:` / `Pull request:` on the host and moves In Progress, In Review, and Done. No agent calls another | The Factory Atlassian team MCP, host-only; `X-Factory-Webhook-Secret` = `JIRA_WEBHOOK_SECRET` on each rule | `approve file` before an issue exists; `approve KEY` (or the board) before Approved |
| Slack | in: mentions, DMs, and posts in `#mars-eng-intake` (`app_mention` + `message`, plus `reaction_added` for ✅ / ❌ on the filing prompt and plan post); out: replies, host posts for Triaged, Planned, In Progress, In Review, Done (Approved only after a board drag), outcome comments, outbound ✅ on exact `approve KEY`, and one outbound status reaction on the filer's message (👀 filed → ⏳ planner running → 📝 planned → 🚫 declined → 🛠️ building → 🔍 in review → ✅ done; ❓ a person must answer; ⚠️ stopped) | `factory-desk`, the one Slack app, shown as `@factory` | `FACTORY_DESK_SLACK_BOT_TOKEN` | In the ticket thread, one plain-text reply (`approve file`, `approve KEY`, `deny KEY`, `replan KEY`) or one ✅ / ❌ on the filing prompt or plan post. Do not mention the bot. No cards |
| Sandbox read | read only | `planner` (`search_sandbox`, `git_history`; locally the turn is tool-locked to `read`, `grep`, `glob`, `ls`; hosted it is a Cursor cloud turn with the harness toolset over a per-send `cloud.repos` clone of the sandbox) | `FACTORY_PLANNER_CHECKOUT` locally; hosted, `githubChannel({ cursorAccount })` read on the host and the cloud agent's own clone on the VM | Locally none needed: the tool list cannot write. Hosted, read-only is by instruction (`planner/agent/instructions.md` "Never") plus `cloud: { autoCreatePR: false }` — a default a per-session HTTP `cloud` override would beat; July's hosted admission rejects that body and the planner's `planner/agent/channels/http.ts` gate refuses it on every other serve shape. What a cloud turn can reach, and the residual, is in [`planner/README.md`](../planner/README.md) "Checkout" and [`deployment-issues.md`](deployment-issues.md) issue 24 |
| Cursor cloud agents | out: launch | `factory-worker` (July cloud turn on the jira channel, `autoCreatePR: false`; heal still `@cursor/sdk` `Agent.create`; the agent pushes its branch and the worker opens the PR ready); `pr-autofixer` (drive) | Each pod's `CURSOR_API_KEY`, bound to the slug's deployment service account | The ticket entering Approved |
| GitHub, PR tier (worker) | in: `pull_request` on the implement PR. Out: marks an implement PR that still arrives a draft ready for review on open, including one a bot drafts again (GraphQL, scoped with `x-cursor-github-repos`, #126, #130, #144) and writes the `Jira:` / `Slack:` lines into the PR body (#118). Never pushes, merges, or re-drafts | `factory-worker` (`cursorAccount`, `pr-write`) | Minted per repo by the team Cursor GitHub App; `--cursor-events-repo` | Done needs a person's merge; a bot merge or auto-merge moves nothing. A person's own re-draft is kept |
| GitHub, write tier | in: PR, check, comment, review events. A human-typed `factory: drive` comment is the manual opt-in. Out: pushes | `pr-autofixer` (`cursorAccount`, `contents-write`). The desk never writes to GitHub and never calls the fixer | Minted per repo by the Cursor account GitHub connector | A factory PR (branch starts with a configured project key, `TLSSN-` here, or the title does and `cursor[bot]` opened it) is driven on its first red check or Bugbot findings (2 rounds) with no opt-in; any other PR needs a `factory: drive` comment a person types on the PR. A pasted URL outside `FACTORY_REPOS` is refused with `out_of_scope` before any GitHub read; never merges or force-pushes |
| GitHub, comment tier | in: `pull_request` opened / synchronize / ready_for_review / reopened, and `edited` when the base is retargeted; out: one `COMMENT` review. PR comments are logged and ignored | `security-reviewer` (`cursorAccount`, `pr-write`) | Minted per repo by the Cursor account GitHub connector | None; a comment cannot block |
| Bugbot | reviews every PR | none (Cursor dashboard setting) | Repo toggle | None; required as a branch-protection check once protection is available |
| Branch protection | would gate every merge; not enforced on GitHub Free for a private repo | none (GitHub setting) | Repo admin | A person checks CI, Bugbot, one human review |
| GitHub's Slack app | posts failing checks to `#factory-escalations` | none (GitHub setting) | Slack workspace admin | A human reads it and decides |

### Artifacts the run leaves behind

| Where | What | Written by |
| --- | --- | --- |
| Jira ticket | The status, which is the event. `Triage:`, then `Plan:` ending in `Brief:` (or `Needs info:` / `Plan stopped:`), then `Implementing: <url>`, then one `Pull request: <url>` | `factory-desk` (Slack-filed `Triage:` and Approved), `triage-jira` (Jira-filed `Triage:`), `planner` (`Plan:` on the host), `factory-worker` (`Implementing:` / `Pull request:` and In Progress / In Review / Done, all on the host) |
| Planner artifacts (`GET /planner/v1/artifacts?kind=plan`, local serve) | One `plan` record per ticket, with the brief and whether the ticket comment was posted. The worker reads the `Brief:` from the `Plan:` comment, not this row | `planner` |
| Slack thread | The filing request, `approve file`, the key and URL, the plan post, `approve KEY` including Cursor `*Sent using*` chrome or a Slack-autolinked KEY (host: ✅, no Approved line), then the agent URL, In Review with `owner/repo#N`, and Done with `owner/repo#N`; `host.kv` maps the key back to the thread | `factory-desk` |
| GitHub | The pull request, Bugbot's review, the `## Security review` comment, pushed fixes, the person's merge | `factory-worker` (opens the PR), Bugbot, `security-reviewer`, `pr-autofixer`, a person |
| `host.kv` | For the desk, `ticket/<KEY>` holds the Slack thread and `announced/<KEY>:<status>:<changelog.id>` is claimed before each post. For the worker, `implement/<KEY>` and one `pr-status/<KEY>/<stage>/<repo>#<n>` per move. For the fixer, the webhook buffer, one `auto-drive:<owner>/<repo>#<n>` claim per pull request, and one `affinity/<label>` binding per driven pull request | `factory-desk`, `factory-worker`, `pr-autofixer` |

## Lane picture

[`html/index.html`](html/index.html) is the same loop as six lanes
(ticket, plan, approve and launch, In Review and reviews, fix, merge and
Done) with walk controls at the bottom. `html/e2e.html` has every step.
`html/e2e.html` follows the factory-desk, planner, triage, and worker
code on main. Markdown here that disagrees is stale.

## Read in this order

1. `amplitude-stages.md`: the teaching overlay. It gives each Amplitude
   stage, the agent or setting that carries it here, and the Atlassian
   sibling slug. Read it first if you are preparing a session, because it
   is the one-slide version.
2. `plan.md`: the chosen factory, ready for an operator. It has the init,
   serve, Slack, Jira, GitHub, and eval commands, the agent table, the
   folder map, the peer graph, the channels, the secret names, the stub
   and live gates, the eval plan, and the phased implementation.
3. `rationale.md`: why this shape, what was taken from each candidate,
   what was rejected, tradeoffs, open questions, and the next step.
4. `deployment-issues.md`: hosted v2. Single-slug apps, the `factory-`
   prefix, why peers and `slack create` fail, the import-time
   `FACTORY_*` boot-order, secrets after READY, and which chain edges
   are live. The local `serve --dir .` path stays in `../README.md`.
5. `event-driven-factory.md`: the hosted topology. Jira and GitHub are
   the bus; no agent-to-agent calls. What we took from everysphere
   `factory/sandy`, and what we left.
6. `bug-hunt-round-2.md`: a code read biased toward races, the fixer's
   admission and scope, and failures that fail open. Eight findings with
   their code paths and status. Six are fixed: a keyed title from a person
   no longer drives; `factory: drive` reads the live repo list; an
   unreadable PR fails the red-check delivery; the desk's approve and
   replan move only from the status they read; the fixer's buffer stops
   rejecting unhandled; the merger is named only once the ticket is at In
   Review. Two stay open with the reason: the worker's `not_connected`
   (by decision) and dual Jira delivery sources (operator config, one
   source per slug). Then what was checked and ruled out.
7. `simplification-review.md`: what can shrink without changing behavior.
   A ranked list of safe simplifications (dead exports, stale docs, one
   parity-locked factory-PR key rule and model block), a do-not-touch list
   of paths that look duplicated and are not, and five footguns found on
   the way.

## Candidates

We wrote three structurally different designs before the plan. They stay
under `candidates/` as the record of the decision:

| File | Shape | Status |
| --- | --- | --- |
| `candidates/a-specialist-desk.md` | Seven projects, one per Amplitude stage, four GitHub relays, desk routes by peer MCP | Not shipped. The plan took its teaching table, HITL on launches, and eval-never-write discipline |
| `candidates/b-surface-owned.md` | Four projects, one per external surface, custom `github-factory` with mode picker and merge gates | Not shipped. The plan took its single GitHub write owner with a persisted debounce, and got it from the `pr-autofixer` template instead of custom code |
| `candidates/c-template-composition.md` | Three unmodified templates plus a Slack desk, no custom side-effect code | Base. The plan took its scaffold, edit-point discipline, and upgrade path unchanged |

## Conventions in these docs

- Commands are written as `npx -p @cursor/july@0.2.24 agent-sdk <cmd> --dir <slug>`.
  0.2.18 ships two bins (`bdk` and `agent-sdk`), so a bare
  `npx @cursor/july <cmd>` fails with "could not determine executable to
  run"; name the bin. After `init`, each project also has `agent-sdk` and
  `bdk` on its own PATH; all spellings are the same CLI. Browse bundled
  docs with `npx -p @cursor/july@0.2.24 agent-sdk docs` (or
  `npx agent-sdk docs` from a project with `@cursor/july` installed).
- `<owner>/<repo>` is the training sandbox repository. The committed
  value must never be a production repo.
- Jira examples use project `TLSSN` on `example.atlassian.net`,
  matching the Atlassian sibling.
- Secret names appear in these docs. Values never do.

# Amplitude stages in this factory

This is the teaching overlay. It gives Amplitude's pipeline, the agent or
setting that carries each stage here, and the slug that carried it in the
Atlassian sibling. Use it as the one-slide version in a session.
`plan.md` has the commands.

Amplitude's original pipeline is intake, ticket, PR, Bugbot, risk gate,
and merge or escalate, with a security pass and an Autopilot loop on a
failed build alongside. The sibling made every stage an agent. This
factory makes a stage an agent only where a model turn adds judgement,
and leaves it as a product or GitHub setting where the product already
does the work.

This factory adds one stage to Amplitude's list, Plan. Amplitude's ticket
went straight to a pull request. Here a `planner` reads the sandbox
checkout and records one plan per ticket, and a person approves that plan
in Slack before any cloud agent starts. It is the stage where the person
sees what will be built before anyone spends budget on building it.

## The table

| Amplitude stage | Carried here by | Kind | Wakes from | Human gate | Atlassian sibling slug |
| --- | --- | --- | --- | --- | --- |
| Intake | `factory-desk` | Authored agent: one Slack app, four model tools (`file_ticket`, `approve_ticket`, `deny_ticket`, `request_plan`), and host announcements from its Jira channel. It launches nothing | `@factory` mention, DM, or a reply in `#mars-eng-intake`; one thread per ticket | `@factory approve file` before an issue exists | `delivery-desk` |
| Ticket (dedup and classify) | `triage-jira` | Template; `record_triage` writes the `Triage:` comment and moves the ticket to Triaged | Jira `issue_created` (a TLSSN Automation rule), for the issue the desk created or one filed in Jira; `/queue/issue` in dev | None | `issue-triage` |
| Plan (added) | `planner` | Authored agent (read-only tools over the sandbox, `read_ticket`, `git_history`, `record_plan`, `record_needs_info`, one `plan` artifact kind) | The ticket entering Triaged (a Jira rule). It writes `Plan:` with a `Brief:` and moves the ticket to Planned, or leaves `Needs info:` or `Plan stopped:` | The filer says `approve <KEY>` in the ticket's thread, or a person moves the card to Approved; until then nothing launches | none (`implementer` hands planning to pstack poteto-mode) |
| Open the pull request | `factory-worker` | Host code, no model turn: `@cursor/sdk` `Agent.create` with `autoCreatePR: false`; the cloud agent pushes a key-prefixed branch and the worker opens the PR from it, ready for review (Bugbot skips drafts) | The ticket entering Approved (a Jira rule); the brief is read from the latest `Plan:` comment | The Approved move itself; no card | `implementer` |
| Bugbot | Cursor dashboard | Repo setting | Every PR | None | `pr-reviewer` |
| Security pass | `security-reviewer` | Template, one `repos.ts` edit | `pull_request` opened / synchronize / ready_for_review, non-draft or a factory draft | None; advisory `COMMENT` review | `security-review` |
| Failed build, Autopilot | `pr-autofixer` | Template plus one channel edit | A red `check_run` or `status` on an undriven PR whose branch or title starts with an allowed ticket key starts the drive itself; then check, status, comment, review, and PR events for driven PRs, debounced | None for a factory PR. A `factory: drive` comment typed by a person opts in any other PR | `ci-watch` |
| Risk gate | GitHub branch protection | GitHub setting | Every merge attempt | Required checks (CI, Bugbot) and one human review | `approver` |
| Merge or escalate | GitHub merge button or auto-merge; GitHub Slack app in `#factory-escalations` | GitHub setting plus GitHub's own Slack app | Protection passes, or a check fails | Human merges; human reads the escalation | `approver` |

One agent wakes from people, five wake from events (a Jira status or a
GitHub event), no agent calls another, and three rows are settings. That
is the point to make in a
session. The product already owns half of the pipeline, and the SDK is
for the half where a customer's own judgement and glue belong. The plan
row is the clearest case of judgement: reading the code before deciding
what to build is the step a person most wants to see.

## What each row shows live

| Row | Live demo | Where the audience looks |
| --- | --- | --- |
| Intake | `@factory file a bug: …` in `#mars-eng-intake`, then a plain `approve file` in the thread | The thread: the key and URL, and 👀 on the filing message |
| Ticket | Wait | `Triage:` comment on the issue, then the Triaged line in the thread |
| Plan | Wait; nothing to do | The `planner is checking the code…` crumb, then the `Plan:` comment on the issue and the plan post in the thread; `GET /planner/v1/artifacts?kind=plan` for the record |
| Approve | Reply `approve` (or `approve TLSSN-42`) in the thread | ✅ on that message and a `starting implementation…` crumb |
| Open the PR | Nothing to click | The In Progress line with the cloud agent link, then the In Review line linking a ready PR on the sandbox |
| Bugbot | Wait | Bugbot review on the PR |
| Security pass | `npx -p @cursor/july@0.2.25 agent-sdk github replay <owner>/<repo>#N --dir security-reviewer` | `## Security review` comment on the PR |
| Failed build | Plant a lint failure and wait | The check fails, the fixer claims the PR, a cloud VM pushes, and the check passes. For a PR the factory did not open, a person types `factory: drive` on it |
| Risk gate | Try to merge before Bugbot and CI are green | GitHub blocks the merge |
| Merge or escalate | Merge after review; or leave CI red | Merge; or the red check appears in `#factory-escalations` |

## Honest notes per stage

- **Intake files the ticket after a text approval.** Amplitude's intake
  filed the Jira ticket, and so does this one when a person asks
  `@factory` to file it and then says `approve file` in that thread.
  Hosted Slack has no card ingress, so the gate is that text, not a card.
  `file_ticket` creates the issue through the host-only Jira connection
  and saves the thread and the filer under the new key in `host.kv`. The
  model never sees a Jira tool, so the desk cannot browse or edit a
  ticket of its own accord. A ticket filed in Jira directly runs the same
  chain; the desk opens its thread as an intake root in
  `FACTORY_DESK_INTAKE_CHANNEL`, and approving it stays on the board.
- **Ticket stage is not reachable from Slack.** Triage runs from Jira's
  `issue_created` or the dev queue route only. The desk never calls it.
- **Jira is the bus; no agent calls another.** Triage writes `Triage:` and
  moves the ticket to Triaged; the planner wakes on Triaged, writes
  `Plan:`, and moves it to Planned; the worker wakes on Approved. Each hop
  is an artifact on the ticket plus a status move. The desk announces each
  status in the ticket's thread, and when a hop leaves nothing within its
  deadline its hop watch says so in the thread. A verdict the planner
  skips (a question, needs info, a duplicate) is said in the thread
  instead of a plan.
- **Plan reads the ticket and the code.** `read_ticket` fetches the issue
  and its comments, including the `Triage:` verdict, through a host-only
  Jira connection; the model never sees a Jira tool. The code comes from
  the sandbox checkout named by `FACTORY_PLANNER_CHECKOUT`, with `read`,
  `grep`, `glob`, `ls`, `search_sandbox`, and `git_history`, and nothing
  that writes. Without the checkout it reads the GitHub tree for
  `FACTORY_SANDBOX_REPO`. A claimed failure that is not on that ref is
  `record_needs_info`, not a prompt-only plan.
- **The plan comes back to the thread that filed the ticket.** The desk's
  Jira channel hears the move into Planned, reads the latest `Plan:`
  comment, and posts the plan digest into the ticket's thread once per
  plan (a replan's new `Plan:` comment posts again). No model turn runs.
- **Approval is one text gate on what will be built.** The filer replies
  `approve` (or `approve TLSSN-42`) in the thread; host code moves the ticket to
  Approved, and the worker launches on that status. Moving the card to
  Approved in Jira does the same. That is two gates where Amplitude had
  zero: one on filing the ticket and one on what will be built. Nobody
  pastes a brief, and nobody leaves the thread.
- **The brief is host text end to end.** `record_plan` writes the brief
  deterministically into the `Plan:` comment, and the worker reads it
  from there in host code and sends it verbatim to the cloud agent, followed by the PR handoff. No
  model copies it on the way.
- **Open the PR no longer needs a hand-off.** The launched cloud agent
  opens the PR ready for review, with the ticket key at the start of the
  branch and the title, because the worker's launch prompt requires it
  (`autoCreatePR: false`; platform auto-PRs are drafts, and Bugbot skips
  drafts). A PR that still arrives a draft is marked ready by the worker.
  `pr-autofixer`'s channel
  recognises that key on the first failed check and starts the drive
  itself, once per PR
  (`auto-drive:<pr>` in `host.kv`). A PR the factory did not open still
  needs a `factory: drive` comment typed by a person, and `PR_AUTOFIXER_AUTO_DRIVE_PROJECTS=`
  (empty) turns the automatic drive off.
- **Bugbot is not queued by an agent.** The sibling's `pr-reviewer` stub
  "queues Bugbot". Bugbot is a repo toggle that reviews every PR on its
  own. There is nothing to build, and it stays in the table because it is
  a stage.
- **Security pass cannot block.** It posts a `COMMENT` review. Blocking
  comes from branch protection on CI and Bugbot. Phase 3 can add a
  merge-box check (`progress.commitStatus`) at the cost of
  `contents-write` on the reviewer.
- **Failed build has no "second failure escalates" rule.** The sibling's
  `ci-watch` counted failures in `host.kv` and escalated on the second.
  `pr-autofixer` keeps fixing. In v1, escalation is the failed check
  showing up in Slack through GitHub's app, and a person deciding.
- **Risk gate is not a model decision.** The sibling's `approver` weighed
  `auto_merge | escalate` behind a deterministic floor. Here the floor is
  branch protection and there is no model verdict. The sibling taught the
  risk floor as "the model cannot talk its way past it". Here it is
  "GitHub will not let anyone talk their way past it".
- **Nothing merges.** No July template merges, enables auto-merge, or
  force-pushes. A person clicks, or a person enables GitHub auto-merge on
  the PR. That is the product stance and the answer to "what stops it
  doing damage".

## Sibling slugs that have no agent here

| Sibling slug | Why not an agent here |
| --- | --- |
| `delivery-desk` | Replaced by `factory-desk`, which has four model tools and host announcements, and launches nothing, instead of a six-way routing table |
| `implementer` | The cloud launch is host code in `factory-worker` (`@cursor/sdk` `Agent.create`, woken by the Approved status), not a model decision. Its planning half is `planner` here, an agent the sibling does not have because pstack poteto-mode plans on the VM |
| `pr-reviewer` | Bugbot is a repo setting |
| `ci-watch` | `pr-autofixer` owns the CI loop; the failure counter is dropped |
| `approver` | Branch protection plus a human |

Every row still appears in the table above so the Amplitude story reads
end to end. What changed is which rows need code.

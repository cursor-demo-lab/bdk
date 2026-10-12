# Jev as a host-side judge in the factory

Where Jev (TypeSafe System One, `@cursor/july/extensions/jev`, already in
the locked `@cursor/july` 0.2.18) can make the factory faster or more
accurate, ranked, and what shipped. Jev answers bounded questions:
**Choice**, **Score**, or **Probability** (the boolean question). It runs
inside a tool of an existing agent, not as a seventh agent and not as a
turn model. Host code holds the threshold rule. The chat model still
writes everything a person reads.

Written against this tree on 2026-09-25. It supersedes the Slack-factory
rows of `jev-factory-ideas-refined.md` (not included in this snapshot; it lived at `agent-sdk/findings/` in the old monorepo), which
predates the desk, planner, and worker. No live TypeSafe call was made
while writing this; latency and calibration below are expectations, not
measurements.

## Ranked candidates

| Rank | Stage | Decision today (file) | Jev shape | Expected win | Risk if wrong | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Triage | Model picks an internal `kind` (bug / question / feedback) from the `triage-rubric` skill; the ticket's Jira issue type is whatever the filer chose (the desk files `Bug` or `Task`, `factory-desk/agent/lib/jira.ts` `issueTypeFor`). `kind` decides whether the planner runs: a question stops it (`triage-jira/agent/lib/plan-chain.ts`, `planner/agent/lib/chain.ts` `decide`) | **Choice** over the project's real Jira issue type names (Bug, Story, Task on a team-managed software project), written to the ticket | The board shows a judged type. The rubric's tie-breakers ("why did my export fail yesterday?" is a Bug, "could we have dark mode?" is a Story) become a typed decision. Fewer wrong hops: a bug routed as a question gets no plan, a question routed as a bug wastes a planner run | A wrong type on a customer-visible ticket; a confident Task over a model question stops the planner as before. The Slack line names the type and says Jev set it, and a person can change the type or `replan KEY` | **Shipped** |
| 2 | Triage | Model picks `severity` low … urgent (same files) | **Choice** over four tiers. Score deferred: its scale (index or 0–1 position) is undocumented, so a threshold cannot be set | One ladder applied the same way on every ticket; severity is carried to the planner and shown in Slack | A label only: triage writes no Jira priority for Jira (`buildPriorityArgs`), nothing gates on severity | **Shipped, label only** |
| 3 | Triage | Model sets `needsInfo` and writes the missing detail in `nextStep`; `Needs info:` stops the planner until a Slack thread reply lands as `Detail from Slack:` | **Choice** proceed / needsInfo | Fewer planner runs on thin tickets (add), or fewer human round trips on spurious asks (clear) | Adding it without a question leaves the reporter with the model's team-facing next step as the ask. Clearing it drops a detail the model asked for | **Recorded, not applied.** Jev decides, it does not write the question. Promote the add direction once the recorded gate agrees with outcomes and a host question template exists |
| 4 | Triage | Duplicate link is exact normalized-title equality over the Jira search (`actuate.ts` `matchingIssue`); the model's `duplicateOf` stops the chain but is never linked | **Probability** per search candidate | Catches reworded duplicates | A wrong `Duplicate of:` line is customer-visible and stops the planner | Defer: candidate quality from the Jira MCP search is unmeasured. Shadow after kind is calibrated |
| 5 | Plan | Model chooses `record_plan` or `record_needs_info` after `search_sandbox`; host already refuses `evidence: "prompt"` and cited paths not on the sandbox (`planner/agent/tools/record_plan.ts`) | **Probability**: does the evidence show the claimed failure | Fewer ungrounded plans reaching `approve KEY` | Holding a real plan sends a false `Needs info:`; the state is code excerpts, and the size limit for state is undocumented | Defer: deterministic path checks already catch the worst case. Next shadow candidate |
| 6 | Approve | A person types `approve KEY`; the worker launches on Approved (`factory-desk/agent/tools/approve_ticket.ts`, `factory-worker/agent/lib/decide.ts`) | **Choice** risk tier on the plan and brief, shown with the Planned line | An approver sees a consistent risk floor, useful for the historical backlog | Must stay advisory: no auto-approve, no merge. A low tier on a risky plan could lull an approver | Defer until 5 has shadow data. Never a gate |
| 7 | Intake | Desk model decides file / ask / deny on a Slack message; filing waits for `approve file` | Choice | Pre-labels the ticket before triage | Sends raw Slack text to a third party; the human gate already exists | Defer |
| 8 | Review | `security-reviewer` posts model findings verbatim (template) | Probability per finding | Fewer speculative findings | Worst failure is a true positive dropped and the comment reading CLEAN; template edit point | Defer, shadow only |
| — | Fix, In Review, Done | `pr-autofixer` wake rules; worker PR status moves; human merge | none | — | — | No judgment to type: deterministic host code or a person |

### Speed, stated plainly

Jev adds one bounded call to each triage run (capped at 8 s, then the
model's verdict stands). The speed win is not triage latency; it is fewer
wrong-stage hops downstream: a planner run on a question, a missed plan on
a bug, and the Slack round trips each one costs. Replacing the triage
model turn with Jev is not possible today, because the model also writes
the summary and next step the ticket and Slack show.

## What shipped (rank 1 and 2)

`triage-jira`:

- `agent/extensions/jev.ts` mounts the extension with `harnessTools: false`
  and `skills: false`. The model sees no Jev tool; the mount only adds
  `api.typesafe.ai` to egress and `TYPESAFE_API_KEY` to the hosted secret
  names (`agent-sdk info` shows both).
- `agent/lib/inbound.ts`: the webhook stashes the issue as Jira delivered
  it, including `fields.issuetype.name`, under `triage-inbound/<KEY>`, so
  Jev judges the reporter's words and not the model's summary. Without the
  stash the judge falls back to the model's title and summary and records
  `source: "model"`.
- `agent/lib/issue-type.ts`: reads the project's issue types through the
  tracker connection (Rovo `getJiraProjectIssueTypesMetadata`, or the same
  operation through v2 `executeRead`), keeps standard types (no sub-task,
  hierarchy level 0, so no Epic), and caches them for 6 h. It writes a type
  with `editJiraIssue` `fields.issuetype`, by id.
- `agent/lib/jev-triage.ts`: one `decide` call with three Choices. The
  issue type labels are the project's exact names, limited to those with a
  criterion in `ISSUE_TYPE_CRITERIA` (Bug, Story, Task, worded from
  `triage-rubric.md`); if the list cannot be read, `DEFAULT_ISSUE_TYPES`.
  Severity and the needs-info gate are as before.
- **Jev first, fast exit.** On the wake (the issue-created webhook or the
  queue route), `agent/lib/jev-first.ts` asks Jev before any model turn.
  When the type, severity, and gate are all strictly above 0.52
  (`JEV_THRESHOLD`), the host records Jev's verdict itself, the way
  `record_triage` does (`agent/lib/record-verdict.ts`): the `issuetype`
  edit, the `Triage:` comment, the Triaged move, and the planner handoff.
  No model turn starts. The kind is `kindForType(type, "question")`, so a
  Task is a question and the planner skips it; a `needsInfo` gate writes a
  templated `Needs info:` ask and does not plan. Jev writes no prose, so the
  title is the reporter's, and the summary and next step are host
  templates (`templateVerdict`). The line reads
  `Judge: Jev type Bug 0.93 (set in Jira; Jev only); severity medium 0.84 (Jev only)`.
- **Else the model turn, on grok-4.6-fast.** No key, a TypeSafe error or
  8 s timeout, an off-label answer, any answer at or under 0.52, or a
  ticket that did not reach Triaged starts the model turn. It is the only
  model turn triage-jira runs, so its root model is
  `factoryModel(process.env, LIGHT_MODEL)`: catalog `grok-4.6`, `effort`
  `high`, `fast` `true`, not Auto (`FACTORY_AGENT_*` still override it). Jev's answers (or
  `unavailable`) are kept at `triage-jev/<KEY>` in `host.kv`, and that
  turn's `record_triage` judges the model's verdict with them: one
  TypeSafe call per wake, never two.
- The rule on the fallback, in `record_triage` and `settleJudgment`: a type at probability
  > 0.52 (`JEV_THRESHOLD`) is written to the ticket before the
  `Triage:` comment, skipped when the ticket already has it. Only a type
  that is on the ticket changes the planner's kind (`kindForType`: Bug →
  bug, Story → feedback, Task → the model's question, else feedback). A
  question still stops the planner, now as a Task. A refused or failed
  edit keeps the model's kind; the result has `judge.type.jira: "failed"`
  and the Jira message, the comment says `Jira edit failed, kept the
  model's …`, and the ticket still moves to Triaged. Severity is a label
  and applies on confidence alone. The gate is recorded only. No key, an
  HTTP error, a malformed or off-label answer, or the timeout writes
  nothing and keeps the model's verdict.
- The comment gains `Type: <Jira type>` (the type on the ticket) after the
  `Triage:` line and, when Jev answered, one line such as
  `Judge: Jev type Bug 0.93 (set in Jira; model said question); severity medium 0.84 (agreed)`.
- Eval sessions call Jev when the key is set (a read, no writes), over the
  default types, so evals measure the host-owned verdict;
  `evals/triage.eval.ts` adds the rubric's two tie-breakers and asserts
  the recorded kind and, when Jev answered, the Jira type.

Both writers end the `Triage:` comment with who triaged it, then Jev's
scores (`triageRecordLines`, shared `jev-triage.ts`):

```
Triaged by: model (Jev was not above 0.52 on every answer)
Judge: Jev type Bug 0.99 (set in Jira; agreed); severity low 0.50 (agreed)
```

`Triaged by: Jev (type, severity, and gate all above 0.52)` when Jev
settled it; `Triaged by: model (Jev did not settle it: <why>)` when Jev
failed or was not asked, with no `Judge:` line. `factory-desk`:
`latestTriageVerdict` reads the `Type:`, `Triaged by:` (else `Jev only`),
and `Judge:` lines. Slack gets plain words only, never scores (Simon,
TLSSN-36): a Jira-filed ticket's Triaged line reads

```
TLSSN-27 is Triaged: Bug, low severity (triaged by the model).
```

and a desk-filed ticket says the same thing once, in its Filed post.

`planner`: no code change. A test pins that `Type:` and `Judge:` lines do
not change `planFromStatus`.

### Type criteria, the type guard, and the eval

Jev's type question is worded to decide by what exists today, not by how
the ask is phrased (`ISSUE_TYPE_CRITERIA`, `TYPE_INSTRUCTIONS`). Bug covers
existing behaviour that is broken, missing, or wrong, including soft
wording ("doesn't show", "I typed X but", "used to") and a report that ends
"could it…?"; Story is a new capability or a change to behaviour that works
as built (a confirmation on Log out, a longer timeout); Task is neither.
With no Story type in the project, Task takes new capabilities
(`TASK_WITHOUT_STORY`). Epic and sub-task types are never offered.

Backstop: `typeContradicted` / `guardJudgmentType` hold back a confident
Story or Task over words that say something is broken now. triage-jira's
wake falls back to the model with `type_guard` (no fast exit), and
`record_triage` does not write that type; the desk's intake does the same
with reason `type_guard`. The `Judge:` line says `held back: the report
says something is broken now; kept the model's <kind>`, which the desk's
parser reads as `below`. The severity ceiling is #178's, unchanged. The
type is held before the cap, so a held Story or Task never caps severity:
`calibrateJudgment` reads the model's kind, the type the ticket keeps.

`factory-desk/evals/jev-triage/` measures all of this against live
TypeSafe: `npm run eval:jev-triage` in `factory-desk`, a tune split and a
hash-frozen holdout, reported separately. Results before and after, from
2026-09-28, are in `factory-desk/evals/jev-triage/RESULTS.md`: against #178,
tune type accuracy 94.0% → 100%, clear bugs typed Story 15 → 0 of 114,
severity 97.6% → 100%, fallback 11.5% → 2.8–6.0% (run to run); holdout type 100% on both,
severity 90% → 100% lenient (strict 68.3% → 80.0%), fallback 11.7% → 0–1.7%.
Those were measured before the branch merged main, under the older blanket
medium cap. Re-measured live at a44946a (#179) under #178's rule (cap only
on clear evidence, otherwise keep Jev's severity; a loss or critical phrase
means no cap; a question at most low; Story, Task, or feedback at most
medium; a Bug capped at medium only on typed-input, UI-widget-cosmetic or
feature-request evidence): tune type 100% lenient / 99.6% strict, severity
100% lenient / 81.0% strict, fallback 2.4%; holdout type 100% / 90%,
severity 100% / 80%, fallback 0% (RESULTS.md, "After merging main").
Severity is lenient: five tune cases moved low → medium with low still
accepted. `--judge` (Claude Opus 5.5, low effort, via `@cursor/sdk`) checks
the labels blind and proposes wording changes; the severity criteria and the
needs-info gate wording came from its suggestions, each kept on its tune
result with no lenient holdout regression (r1 lowered holdout strict
severity 82.5% → 80.0%; see RESULTS.md). Because the keep rule read holdout
metrics, the holdout is a no-regression check here, not a clean measure of
generalisation.

### The TLSSN type list

No path from the environment this was built in could read the live list
(no Jira credential, no Atlassian MCP). The code therefore never hardcodes
the answer on the live path: it asks Jira for TLSSN's types on each run
(cached 6 h) and uses Jira's own names and ids. What the repository proves
is that TLSSN accepts `Bug` and `Task` (the desk files both). `Story` is
the team-managed software default; if TLSSN lacks it, it is simply not
asked. Before the demo, check the Judge line on one ticket, or run
`agent-sdk call record_triage` against a TLSSN ticket with the key set,
and confirm `judge.types` reads `project`.

The desk now files the type Jev chose among the project's own names (so a
Story only when the project lists Story). When the project's list cannot
be read the desk asks only Bug and Task, and a type Jira refuses at create
is filed as the kind's own type (Bug, else Task) with the `Judge:` line
saying the Jira type did not take.

### factory-desk: triage before filing

A Slack filing request is judged before anything is filed, with the same
`jev-triage.ts` (byte-identical in the desk, like `issue-type.ts`,
`triage-verdict.ts`, and `extensions/jev.ts`;
`../scripts/copies-parity.test.mjs`; the desk inlines the `triage-rubric`
skill as `agent/lib/triage-rubric.ts`, since it has no tool to load one). The desk mounts the Jev extension
for its hosting contribution only: `api.typesafe.ai` egress and the
`TYPESAFE_API_KEY` secret, no model tool.

1. `deskInbound` asks Jev over the Slack text (`agent/lib/intake-triage.ts`)
   before the filing turn and keeps the answer for the thread.
2. Every answer strictly above 0.52: the filing prompt says `Triaged by
   Jev: <Type>, <severity> severity.` with the templated `Summary:`, and
   `approve file` files exactly that, with `Judge: … (Jev only)`.
3. Otherwise the same grok-4.6-fast turn that drafts the prompt triages
   the request with the rubric inlined in its context, and the prompt says
   so (`Jev wasn't sure, so the model triaged it: …`, `Jev didn't answer,
   …`); there is no second turn. At `approve
   file`, `file_ticket` judges that verdict with Jev's kept answers as
   `record_triage` does (a Jev type above the bar goes on the ticket).
4. `file_ticket` creates the issue with the type, writes the `Triage:`
   comment, and moves it To Do → Triaged. The planner wakes on that move;
   the desk's Jira channel announces Triaged once. The description ends
   with `Triaged in Slack by factory-desk before filing.`
   (`DESK_TRIAGED_LINE`, `agent/lib/desk-triaged.ts`), and triage-jira's
   wake skips any ticket that carries it: no Jev call, no turn, no second
   `Triage:` comment. The line counts wherever it ends the text, because
   the hosted wake gets Automation's plainText rendering, which can run
   paragraphs together; when the delivered description lacks it, the wake
   reads the ticket back from Jira and skips on the stored description, the
   desk's `Triage:` comment (it ends with the same line), or, for a ticket
   created in To Do, a status past it. The planner gates on the desk's
   comment over any later one.

Tickets filed straight in Jira keep everything above this section.

Contract tests: `triage-jira/agent/lib/jev-triage.test.ts` (wire request
through the real `decide`, the rule, fail-open),
`triage-jira/agent/lib/issue-type.test.ts` (v1 and v2 list shapes, Epic and
sub-task filtering, cache expiry, the `issuetype` edit and its failures),
`triage-jira/agent/tools/record_triage.jev.test.ts` (fixture ticket →
stubbed Jev → `issuetype` edit, then the Jira comment, the Triaged move,
and the planner handoff; refused edit; type already set; at and below the bar),
`triage-jira/agent/lib/jev-first.test.ts` (above 0.52: no model turn, the
comment and handoff written; 0.58, under the old 0.60 bar, now fast; needs
info; Task; at 0.52 or Jev down: the model turn runs with no second Jev
call; a desk-filed ticket: no Jev, no turn; the root model is
grok-4.6-fast),
`factory-desk/agent/channels/slack.intake-triage.test.ts` (Jev before the
filing turn; confident, at the bar, down),
`factory-desk/agent/tools/file_ticket.triage.test.ts` (Jev's triage filed
and moved to Triaged; the model's at the bar and with Jev down; a refused
type; a failed comment arms the triage hop),
`../scripts/jev-judge-line.test.mjs` (triage's lines → desk parser),
`../scripts/desk-triage.test.mjs` (a desk-filed description skips
triage-jira; a Jira-filed one does not; the desk's Jev-only comment reads
back),
`planner/agent/lib/jira-event.test.ts`.

## Redeploy after merge

| Slug | What to do |
| --- | --- |
| `factory-triage-jira` | Set the `TYPESAFE_API_KEY` secret (the same name Grok Bot's computer uses), then redeploy with the usual flags. `agent-sdk deploy` warns until the secret exists; without it every ticket takes the grok-4.6-fast fallback turn. The slug's Jira grant must allow editing issues (it already comments and transitions) |
| `factory-desk` | Set the `TYPESAFE_API_KEY` secret on the slug and redeploy: the Jev mount adds the secret name and `api.typesafe.ai` egress. Without the key every filing request takes the desk's own triage. The desk's Jira grant now also comments on and transitions the tickets it files (it already did both for other tools) |
| `factory-planner`, `factory-worker`, `pr-autofixer`, `security-reviewer` | Nothing |

Before quoting Jev accuracy, run `agent-sdk eval --dir triage-jira` with a
Cursor credential and the key, and read the `judge` field on real TLSSN
tickets: the 0.52 bar is a starting point, not a calibration.

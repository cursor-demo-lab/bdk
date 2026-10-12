# triage-jira

Cursor Agent SDK project (`@cursor/july`). This file is for coding agents
editing the project. The served agent's prompt is `agent/instructions.md`.

## Loop

```bash
agent-sdk validate --dir .
agent-sdk info --dir . --json
agent-sdk run --dir . --message "..."
agent-sdk eval --dir .
npm run check && npm test
```

Run the CLI under Node, never Bun.

## Layout

- `agent/instructions.md` is the always-on prompt. Keep it short.
- `agent/tools/<name>.ts` is one tool per file. The filename is the tool name.
- `agent/agent.ts` sets `model: factoryModel(process.env, LIGHT_MODEL)`:
  catalog `grok-4.6` with `effort` `high` and `fast` `true`
  (grok-4.6-fast), not Auto, because the only model turn here is the
  fallback triage turn when Jev does not settle the ticket.
  `FACTORY_AGENT_MODEL`, `FACTORY_AGENT_EFFORT`, `FACTORY_AGENT_SPEED`
  override it through the shared `factoryModel` exactly as on the other
  hosts; `FACTORY_AGENT_MODEL=auto-smart` puts it back on Auto.
- `agent/lib/` is shared code. Never discovered.
  - `actuate.ts` writes the `Triage:` comment, the duplicate link, and the
    priority. `tracker.ts` names the `tracker` connection.
  - `transition.ts` has `transitionIssue(mcp, { issueKey, toStatus })`. It
    finds the transitions-list and transition tools by name shape, picks
    argument names from each tool's schema, and answers `transitioned`,
    `already`, `no_transition`, `not_connected`, or `failed`.
    `transitionFrom(mcp, { issueKey, from, toStatus })` moves only while the
    issue is in `from`, else answers `skipped_status` with the status read.
  - `config.ts` has `factoryModel(env, defaultId?)` and `LIGHT_MODEL`
    (re-exported from the shared `factory-model.ts`) and `statusNames(env)`
    (`FACTORY_STATUS_TODO`, default `To Do`; `FACTORY_STATUS_TRIAGED`,
    default `Triaged`; `FACTORY_STATUS_PLANNED`, default `Planned`; and
    `_APPROVED`, `_IN_PROGRESS`, `_IN_REVIEW`, `_DONE` as on the desk and
    the worker, which `pastTodoStatuses` reads).
  - `plan-chain.ts` decides whether a verdict goes to the planner over the
    in-process peer edge.
- `record_triage` is the hop. After it writes a new `Triage:` comment, or
  finds its own from a call that died before the move, it moves the ticket
  to the Triaged status only while it is still in To Do
  (`transitionFrom`), and otherwise reports `skipped_status` with the
  status it read. Hosted, that status change is the event the planner
  wakes on, so a move from any later status would wake it on a planned or
  launched ticket. An eval session and a failed comment move nothing. With `FACTORY_INPROCESS_PEERS=1` it also calls the planner's
  `plan_issue` at the end of `execute`; unset, it reports `event_bus`.
  The handoff lives in the tool, not a hook: a hook does not run before a
  one-shot process can exit.
- `agent/hooks/triage-outcome.ts` runs in the serving pod when a pinned
  triage turn completes or fails (not cancelled, eval, or dry run).
  `record_triage` leaves what it did at `triage-outcome/<session>`
  (`agent/lib/triage-outcome.ts`); the hook takes that record (read and
  delete: a redelivery reuses the session) and, when the ticket is still
  To Do, writes `Triage stopped: <KEY>` with one `Why:` line
  (`agent/lib/triage-stopped.ts`): the turn's failure, no verdict, a
  verdict that could not be written, or a move Jira refused. A ticket that
  moved, or whose status cannot be read, gets nothing. The desk announces
  the comment; `../scripts/outcome-sentinels.test.mjs` pins the text to
  the desk's parser.
- `agent/lib/jev-first.ts` runs on the wake, in both channels, before
  any turn. A delivered description that ends with `DESK_TRIAGED_LINE`
  (`agent/lib/desk-triaged.ts`, shared with factory-desk and the planner;
  its tests live here) is a ticket the desk triaged before filing it: the
  desk writes its `Triage:` comment and moves it to Triaged itself, so the
  wake returns `skipped: "desk_triaged"` with no Jev call, no turn, and no
  Jira call, and the desk's one Triaged announce stays the only one.
  `deskTriaged` does not need the line on a line of its own, because the
  hosted wake gets Automation's plainText rendering of the description (the
  rule JSON-encodes it; `../docs/jira-automation.md`), which
  can run the desk's paragraphs together, escape or entity-encode
  characters, keep emphasis marks, or use smart punctuation (TLSSN-33,
  -35, -40 were triaged twice when the check wanted a line of its own).
  The sentence must end the text and start a line, follow a sentence end
  or the `Slack thread:` link, or be glued to the paragraph before it; a
  quote of it after other words on the same line, in quotes, in inline
  code, or in a code fence does not match. When the delivered description
  does not carry it, `agent/lib/desk-filed.ts` reads the ticket back
  through the tracker (one Jira read, bounded by `TRACKER_READ_TIMEOUT_MS`,
  8 s) before Jev or any turn and skips it (`via`: `tracker_description`,
  `desk_triage_comment`, `past_todo`) when the stored description carries
  the line, a comment is the desk's own `Triage:` comment (it ends with the
  same line), or a ticket the webhook delivered in To Do (or with no
  status) is already in Triaged, Planned, Approved, In Progress, In Review,
  or Done (`FACTORY_STATUS_*`, `pastTodoStatuses` in `config.ts`). A ticket
  a person created straight into a later status is triaged as before. A
  read that fails or times out skips nothing. A ticket it does triage logs
  `[triage] <KEY> triaging: description length N, ends "<last 80
  characters>"; tracker …` so the hosted log shows what the webhook delivered. Otherwise it asks Jev
  (`askTriageJev` in the shared `jev-triage.ts`), and when type, severity, and gate are all
  strictly above `JEV_THRESHOLD` (0.52) it records a templated verdict
  through `agent/lib/record-verdict.ts` (the same path `record_triage`
  uses) and starts no turn. Anything else (an answer at or under 0.52, or
  Jev failing) sends the grok-4.6-fast turn, with Jev's
  answers kept at `triage-jev/<KEY>` so `record_triage` reuses them. The
  fast path has no session, so no `triage-outcome` record; a ticket it
  does not move to Triaged falls back to the turn, whose hook reports it.
- `agent/lib/jev-triage.ts` is the host-side Jev judge, byte-identical in
  factory-desk (which asks it on a Slack filing request before filing),
  like `issue-type.ts`, `triage-verdict.ts` (the verdict types and the
  `Triage:` comment writer), `desk-triaged.ts` (the desk's marker, also in
  the planner), `agent/extensions/jev.ts`,
  and `agent/skills/triage-rubric.md` (`../scripts/copies-parity.test.mjs`).
  On the fallback
  `record_triage` judges with Jev's three Choices over the issue as the webhook delivered it
  (`agent/lib/inbound.ts`, `triage-inbound/<KEY>` in `host.kv`), before
  `actuate`: the Jira issue type, severity, and a needs-info gate. The type
  labels are the project's own issue type names, read through the tracker
  (`agent/lib/issue-type.ts`, Rovo `getJiraProjectIssueTypesMetadata`
  directly or through `executeRead`, cached 6 h in `triage-issue-types/<PROJECT>`),
  limited to the types with a criterion in `ISSUE_TYPE_CRITERIA`
  (Bug, Story, Task). Unreadable, it asks `DEFAULT_ISSUE_TYPES`. A type
  above `JEV_THRESHOLD` (0.52) is written to the ticket
  (`editJiraIssue` `fields.issuetype`) before the comment, and only a type
  on the ticket changes the kind the planner gates on (`kindForType`: Bug
  plans as bug, Story as feedback, Task keeps the model's question and
  otherwise plans as feedback). A failed edit keeps the model's kind and
  says so. Severity is a label and applies on confidence alone. The gate
  is recorded and never applied. No `TYPESAFE_API_KEY`, a TypeSafe error,
  or an 8 s timeout writes nothing and keeps the model's verdict. The
  `Triage:` comment gains a `Type:` line (the type on the ticket), a
  `Triaged by:` line (Jev, or the model and why Jev did not settle it;
  `triageRecordLines`), and, when Jev answered, a `Judge:` line with the
  scores; the desk parses all three
  (`factory-desk/agent/lib/triage-comment.ts`) and shows only who triaged
  it in Slack. The criteria mirror `agent/skills/triage-rubric.md`
  (factory-desk inlines it as `agent/lib/triage-rubric.ts`); change them
  together.
  `agent/extensions/jev.ts` mounts the extension with no harness tool and no
  skills, only for its hosting contribution (egress and the secret).
- `agent/channels/webhook.ts` is the `jira:issue_created` route (HMAC or
  Automation header secret).
  There is no claim key: a redelivery finds its own `Triage:` comment and
  skips.
- `evals/` is filesystem evals (`evals/evals.config.ts` required).
  Not `agent/evals/`. That path is ignored.

## Do not

- Grow host TypeScript for formatting, classification, or reply composition.
  That stays in instructions/skills. Host code owns auth, idempotency,
  evidence seeding, and side-effect gates. The one exception is the Jev
  judge: Jev answers the bounded labels, and host code only holds the
  threshold rule. Do not add a classifier prompt of its own.
- Add npm deps on a first cut. Stick to what `@cursor/july` already ships.
  The `@opentelemetry/*` packages are July's own, pinned to the versions it
  installs; `context-async-hooks` is a runtime dependency since the factory
  registers the context manager itself.
- Point `serve` at a parent folder during bring-up. It mounts every sibling.

## Pointers

- Package loop: `node_modules/@cursor/july/AGENTS.md`
- Skills: `node_modules/@cursor/july/skills/` (`create-agent`, `deploy`, `evals`, `hillclimb`, `debug`)
- Docs: `npx -p @cursor/july@0.2.22 agent-sdk docs`
- LLM docs index: `node_modules/@cursor/july/dist/docs/llms.txt`

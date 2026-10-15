# pr-autofixer

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
- `agent/lib/` is shared code. Never discovered.
- Automatic drive (`agent/lib/auto-drive.ts`): an undriven factory PR is
  driven on a red check, or on Bugbot's findings: a `neutral` `Cursor
  Bugbot` check run, by name (`isBugbotFindings`,
  `agent/lib/webhook-routing.ts`; marsbank #38 showed "Bugbot — 1 finding"
  and no follow-up). Hosted v2 forwards only the check_suite, so a neutral
  `cursor` suite is read for its runs first (`confirmBugbotSuite`). One round
  per head, at most `BUGBOT_MAX_ROUNDS` (2) per PR (`takeBugbotRound`); the
  round past the cap leaves one PR comment that a person is needed, then
  nothing. The drive's first message says which trigger (`autoDriveBrief`).
  A PR already driven gets the same event as a buffered wake, under the
  same round limit. `recordBugbotRound` and the cap note in
  `peekBugbotRound` are `updateVerified` merges decided again on a rival's
  record (the note carries a `capNotedBy` token), so concurrent heads spend
  one round each and two peeks post one note whenever each put lands before
  the other's read-back. A put that lands after the rival's read-back can
  still lose one (the residual `kv-verified.ts` documents), and so can any
  old-code put during a deploy (`bugbot-rounds.test.ts`, racing the frozen
  copy in `testing/legacy/` too). A peek whose merge finds the record
  deleted (a close) re-reads and answers `drive`. A PR's first peek writes
  the empty record (`markRoundsOpen`, no pauses), and `recordBugbotRound`
  only adds to a record that exists, so a record landing after a close is
  skipped (`record_skipped_no_record`) instead of restoring the old count.
  `FACTORY_FIXER_ROUNDS_MERGE=off` is the plain put.
- Drive claim settle: after `takeLease` verifies the claim,
  `claimAutoDrive` waits `claimSettleMs` (`FACTORY_FIXER_CLAIM_SETTLE_MS`,
  default and most `CLAIM_SETTLE_MS` 2000; 0 is off) and re-reads it
  (`settleClaim`): another owner's lease yields, a vanished claim throws, and
  a re-read that fails every try holds the claim (fails open, one
  `settle_unread_held` line). Pause totals, timers stubbed: the PR read
  (`fetchPrHead`) 1.25 s; a claim 5.75 s at worst when it holds (3.75 s of
  loops plus the settle), 5.0 s when it fails (no settle); the start task
  7.5 s (`TASK_PAUSE_BUDGET_MS`, shared by the start retries and the mark or
  release; the kv calls inside the start pass `pausesMs: []`: the round
  record, and on the flush path startDrive's generation read via
  `kvRetry`); one delivery 14.5 s, within `ADMISSION_PAUSE_CAP_MS` (15 s).
  `channels/github-timing.test.ts` runs that sequence for a delivery and
  `channels/github-timing-flush.test.ts` for the flush path's fresh drive
  that starts (14.5 s); a fresh drive that fails adds the channel's
  catch-all `releaseLease` in `bugbotWithoutAgent` (default pauses, at most
  500 ms), 15.0 s at most, still within the cap. `auto-drive.test.ts` pins
  each phase. New pauses in either path must keep them green.
- Close cleanup (`agent/lib/close-cleanup.ts`, called from the channel's
  `closePr`): skipped only when GitHub says the PR is open and was updated after the close event (a late or redelivered close after a reopen); an open answer that is not newer, a close body with no `updated_at`, or no answer at all counts as closed.
  Deletes `auto-drive:`, then (only once the claim is deleted or absent) the
  `drive-session/` record the claim names, plus `affinity/` and
  `bugbot-rounds:`, and bumps `v1/pr-generation/<owner>/<repo>/<n>` (the
  first key in K12's `v1/<entity>/<parts>` grammar) unless the PR merged,
  so the drive channel's and buffered wakes' continuation key becomes
  `pr:<label>@g<n>` and a reopened PR starts new sessions (July resumes the
  session a key names). A merged PR cannot reopen, so merges add no
  generation and the kept key grows only with PRs closed unmerged. Leaves
  `bugbot-fresh-failures:` (1 h `exp`) and `webhook-buffer` (shared).
  Never throws, idempotent, one `close_cleanup` line.
  `FACTORY_FIXER_CLOSE_CLEANUP=off` restores the old close. Both bind hooks
  record affinity through `recordPrAgentWhileOpen` (`lib/affinity.ts`): not
  while GitHub says the PR is closed or merged, and not for a `pr:` session
  whose key names an older generation, so a drive that binds after the close
  cannot undo it (`bind_skipped` line). A generation kv will not return is
  never guessed: the check is skipped and the bind recorded. Keep `kv-keys.ts` lifecycle notes in
  step with what it deletes.
- `agent/lib/kv-verified.ts` and `agent/lib/claim-lease.ts` are the
  desk's copies (`../scripts/copies-parity.test.mjs`; tested in
  factory-desk). `kv-verified.ts` retries a kv call only when
  `isRetryable` (429, 5xx, no status) holds and never throws: another 4xx
  or a hosted reason code (or a July local refusal) returns `unavailable`
  at once with a `{"kv":"retry_stopped",…}` line. Its default pauses (100,
  then 400 ms, jittered) apply wherever a caller passes no `pausesMs`.
  `auto-drive.ts` never takes them: its verified writes pass `verifiedRetry`
  (immediate, then `CLAIM_RETRY_MS` / `SETTLE_RETRY_MS`), and every call
  inside one of its own loops (`readUntilAvailable`, `takeLease` with
  `pausesMs`, the `untilAvailable` releases) passes `INNER_RETRY`
  (`pausesMs: []`), so a claim pauses 1.25 s in a full outage, 3.75 s at
  most before its settle when it holds, and 5.0 s when it fails
  (`auto-drive.test.ts` pins these). The channel's
  best-effort `releaseLease` calls in `channels/github.ts`, the Bugbot round
  merges outside a start (the peek's cap note, the flush's record), the
  generation read outside a start (`drive_pr`, the `drive` route, a flush
  wake) and the close cleanup's steps do take the defaults, at most 500 ms
  each (the close's steps run side by side with its claim release). Inside
  a start's retry loop, the round record and the generation read pass
  `pausesMs: []`.
  `FACTORY_KV_RETRY_PAUSES_MS` (read per call; sum at most 500; empty or
  `off`: no pauses) is the kill switch.
- `evals/` is filesystem evals (`evals/evals.config.ts` required).
  Not `agent/evals/`. That path is ignored.

## Do not

- Grow host TypeScript for formatting, classification, or reply composition.
  That stays in instructions/skills. Host code owns auth, idempotency,
  evidence seeding, and side-effect gates.
- Add npm deps on a first cut. Stick to what `@cursor/july` already ships.
  The `@opentelemetry/*` packages are July's own, pinned to the versions it
  installs. Runtime code needs only `@opentelemetry/api` and `@opentelemetry/api-logs`;
  the SDK packages are devDependencies for tests.
- Point `serve` at a parent folder during bring-up. It mounts every sibling.

## Pointers

- Package loop: `node_modules/@cursor/july/AGENTS.md`
- Skills: `node_modules/@cursor/july/skills/` (`create-agent`, `deploy`, `evals`, `hillclimb`, `debug`)
- Docs: `npx -p @cursor/july@0.2.25 agent-sdk docs`
- LLM docs index: `node_modules/@cursor/july/dist/docs/llms.txt`

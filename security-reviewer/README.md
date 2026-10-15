# factory-security-reviewer

Reviews pull requests for exploitable bugs and posts one
`## Security review` review with a verdict. A comment cannot block a
merge.

## What wakes it

GitHub (`cursorAccount`, default `pr-write` tier,
`security-reviewer/agent/channels/github.ts`):

- `pull_request` `opened`, `synchronize`, `ready_for_review`, `reopened`
- `edited` when the base is retargeted (`changes.base.ref.from`); any
  other edit is `action_skipped`
- Factory drafts on `opened` and every `synchronize` (Bugbot skips
  drafts; the worker opens PRs ready, and this is defense in depth)

PR comments arrive and are logged, then ignored (`onComment` always
returns `null`). No Jira. No Slack. The debug channel
(`GET /v1/channels/debug/events`) and `FACTORY_DEBUG_TOKEN` are gone.

A factory draft is one whose head branch starts with a key from
`FACTORY_JIRA_PROJECTS`, or whose title does and the PR author is
`cursor[bot]`. A person's title-only key is reviewed once the PR is
ready, like any other PR.

Drafts that are not factory PRs wait until `ready_for_review`.

## What it writes

| Where | What |
| --- | --- |
| GitHub | One `COMMENT` review at the event head, via `post_findings` (`security-reviewer/agent/tools/post_findings.ts`). Body starts `## Security review`, then `**Verdict:** CLEAN` / `FINDINGS` / `INCOMPLETE` |
| Jira | Nothing |
| Slack | Nothing (the desk announces the review) |

Repeat deliveries for the same repository, PR, base sha, and head sha
are skipped after a successful post
(`security-reviewer/agent/lib/reviewed-head.ts`).
This is not exactly once: a turn that never posts records nothing; two
deliveries that both arrive before the write can both review.

## How it runs

Hosted v2. `@cursor/july` `0.2.25` exactly
(`security-reviewer/package.json`).
Turns are local (`tools: ["read", "grep"]`, no `cloud` block in
`security-reviewer/agent/agent.ts`).
Default model: Auto (`auto-smart`, `optimize_for=balanced`) unless
`FACTORY_AGENT_*` say otherwise.

The review is bound to the event's base and head.
`pr/diff.patch` is the compare `{base}...{head}`. Diffs over 150,000
chars are cut (lockfiles first); the verdict is then `INCOMPLETE`
(`security-reviewer/agent/lib/diff-evidence.ts`).

The `pr-write` tier mints `contents: read` (the compare fetch) and
`pull_requests: write`. The `read` tier has no `contents` permission, so
every delivery would end `fetch_failed`.

## Config and secrets

Names only. `hosting.secretNames` in
`security-reviewer/agent/agent.ts`:

`FACTORY_ENV`, `FACTORY_STAGING_ALLOW_PRODUCTION`, `FACTORY_REPOS`,
`FACTORY_JIRA_PROJECTS`, `FACTORY_AGENT_MODEL`, `FACTORY_AGENT_EFFORT`,
`FACTORY_AGENT_SPEED`, `FACTORY_OPS_SLACK_BOT_TOKEN`,
`FACTORY_OPS_SLACK_CHANNEL`, `OTEL_EXPORTER_OTLP_HEADERS`.

GitHub uses `githubChannel({ cursorAccount })`; no GitHub token secret.

Optional override, not in `hosting.secretNames`:
`SECURITY_REVIEWER_REPOS` (repo allowlist override of `FACTORY_REPOS`,
read at every delivery in
`security-reviewer/agent/lib/repos.ts`).
With both unset the channel still loads at boot (`cursorAccount: true`);
a pull request delivery then fails naming both variables.

## Telemetry

Same OTel files as the other five hosts (`security-reviewer/agent/otel.ts`,
`security-reviewer/agent/lib/factory-otel.ts`, `security-reviewer/agent/lib/console-otel.ts`, held
identical by `scripts/copies-parity.test.mjs`). July builds the trace, meter and
log providers; `agent/otel.ts` defaults its metric temporality to cumulative,
which Grafana Cloud needs.
Export is off until `OTEL_EXPORTER_OTLP_HEADERS` is set.

Every GitHub delivery that reaches `onPullRequest` or `onComment` logs
one `factoryDebug: "github-event"` line; each post logs
`factoryDebug: "review-posted"`
(`security-reviewer/agent/lib/debug-events.ts`).
`logs --prod` follows sessions, so a skipped delivery (no turn) has no
session and its line is not proven readable there. See the factory
README OpenTelemetry section.

## Deploy

Folder `security-reviewer`, slug `factory-security-reviewer`. From
``:

```bash
npx -y -p @cursor/july@0.2.25 agent-sdk deploy --ref <full 40-char SHA> --dir security-reviewer --slug factory-security-reviewer --cursor-events-repo cursor-demo-lab/marsbank --team <CURSOR_TEAM_ID>
npx -y -p @cursor/july@0.2.25 agent-sdk logs --prod --slug factory-security-reviewer --team <CURSOR_TEAM_ID>
```

No Jira rule. Read hosted logs:

```bash
npx -y -p @cursor/july@0.2.25 agent-sdk logs --prod --slug factory-security-reviewer --team <CURSOR_TEAM_ID> --once --json
```

## Tests

```bash
npm test
npm run check
npm run validate
npx -p @cursor/july@0.2.25 agent-sdk eval --dir . --list
npx -p @cursor/july@0.2.25 agent-sdk eval --dir .
npx -p @cursor/july@0.2.25 agent-sdk github replay https://github.com/<owner>/<repo>/pull/1 --dir .
```

Smoke cases: `security-reviewer/evals/review.eval.ts`
(`xss`, `clean`). From the factory folder: `mise run test`,
`mise run check`, `mise run validate`. Live: `node scripts/e2e-drive.mjs`
(verdict shape in `scripts/e2e-lib.mjs`).

## Limits

- Hosted kv has no compare-and-set. The reviewed record is a dedupe
  written after the post, not a claim. Last write wins.
- `sessions --prod` refuses v2 slugs; `logs --prod` works.
- A skipped delivery starts no session; its only trace is the
  `factoryDebug` console line.
- A comment cannot block a merge.
- Lockfile churn can make a review `INCOMPLETE` (lockfiles count toward
  the 150,000-char cap).
- Dedupe identity is `{ repo, PR, base.sha, head.sha }`. The base is the
  base-branch tip, not the merge base the three-dot compare follows, so
  a moved `main` can re-review the same diff (safe direction). An event
  without `base.sha` does not match a recorded identity
  (`security-reviewer/agent/lib/reviewed-head.ts`).

Automation spec (shipped `enabled: false`):
`factory-security-reviewer.yaml` (not included in this snapshot; lived at `.cursor/automations/` in the old monorepo).

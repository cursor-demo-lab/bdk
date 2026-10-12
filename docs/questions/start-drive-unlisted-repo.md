# Does `startDrive` fail closed for an unlisted repository

**Answered 22 Sep 2026.** No, it did not. The answer came from reading
`pr-autofixer/agent/lib/start-drive.ts`, not from a live run. The function
had no scope check. `fetchPrState` swallows every error and returns
`undefined`, `isTerminalPrState(undefined)` is false, and `startDrive`
went on to open a cloud session against whatever repository the URL named,
mounted with the signed-in host's credential. The allowlist was advice,
not a gate. The gate was added in host code. `startDrive` now takes the
configured `owner/repo` list, both callers (`tools/drive_pr.ts` and
`channels/drive.ts`) pass `githubRepos()`, and a pull request outside the
list is refused with code `out_of_scope`, naming the list, before any
GitHub read. Matching is case-insensitive. `start-drive.test.ts` drives
the refusal against a host that throws on any touch, so the refusal is
proven to happen before a read. The one-line result is in
`rationale.md`, open question 4.

`pr-autofixer` holds an allowlist of repositories it will drive. If the
desk passes a pull request URL outside that list, does the drive stop with
a scope error, or does it start and fail later with a confusing message?

## Why the answer matters

The allowlist is the only check between a pasted URL and a fix branch
pushed to a repository the factory was never meant to touch. If the list
is advice rather than a gate, the check belongs in host code before
`startDrive` runs.

## What we know

The expectation is a mint-scope error at `fetchPrState`, because the host
credential covers only the scoped repositories. Nobody has run it.

## The check

Point the sandbox-scoped dev host at a pull request in a repository that
is not in `PR_AUTOFIXER_AUTO_DRIVE_PROJECTS`, then read the error. A
refusal before any write answers the question. Anything that reaches a
branch push means the host needs its own check.

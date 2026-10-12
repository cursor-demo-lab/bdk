# Request: an app test hook in the orchestrator's CI (draft for #proj-example-org)

Not posted. A draft for whoever raises it in `#proj-example-org`.

## Problem

`example-org/demo-repo` runs no project tests in CI. Its `Managed App`
workflow is orchestrator-managed (QUICKSTART: do not edit managed
workflows; they are overwritten on reconciliation), and its only test-shaped
job, `ci-required` (`internal-app-orchestrator/.github/workflows/ci-reusable.yml`),
checks that `app-manifest.yml` names an `<COMPANY_EMAIL_DOMAIN>` owner, the hooks
are not bypassed, and gitleaks passes. There is no step an app can hook a
test command into.

So the software factory's suites (`this repository`:
typecheck, `agent-sdk validate`, and the unit and characterization
tests across six agents, more than 1,500 in all) run only in `scripts/merge-gate.sh`, by hand on a
clean checkout, with the summary pasted into the PR. That includes
`factory-desk/agent/lib/july-otel.test.ts`, which pins the `@cursor/july`
internals the factory's OpenTelemetry export depends on, so a July upgrade
that changes them should fail CI, not a hand run.

## Ask

An opt-in test hook in `ci-reusable.yml`, declared in `app-manifest.yml`,
for example:

```yaml
ci:
  test:
    - name: software-factory
      node: "22.18"
      run: bash scripts/merge-gate.sh
      paths: ["**"]
```

- Runs on `pull_request` when a listed path changed, as part of
  `ci-required` (or as a separate required check).
- Uses the app's own command; no secrets needed (the factory's suites are
  offline: no Cursor credential, no network beyond `npm ci`).
- About 6 minutes for the factory today.

## Until then

Keep running `scripts/merge-gate.sh` on the PR's final SHA and pasting its
summary into the PR description (README, "Tests and evals").

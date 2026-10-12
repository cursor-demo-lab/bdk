#!/usr/bin/env bash
# Repo CI (`ci-required`, orchestrator-owned) runs no project tests, so this is
# the merge gate. Run it on a clean checkout of the PR's final sha and paste the
# summary block into the PR description.
#
# Optional preconditions, reported as WARN lines only: PRs are merged from the
# GitHub UI, often ahead of this gate, so these never change the exit status.
#   GATE_VALIDATED_SHA  sha named by the newest validator report
#   GATE_MERGE_AFTER    space-separated PR numbers that must be merged first
#   GATE_REPO           owner/name for those PRs (default example-org/demo-repo)
#   GATE_WARN_ONLY=1    print the WARN lines and stop, without running the gate
set -uo pipefail
cd "$(dirname "$0")/.."

projects=(factory-desk planner factory-worker triage-jira pr-autofixer security-reviewer)
sha="$(git rev-parse HEAD)"
dirty="$(git status --porcelain)"
results=()
warnings=()
failed=0

record() {
  local name="$1"; shift
  local log
  log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    results+=("pass  $name")
  else
    results+=("FAIL  $name (log: $log)")
    failed=1
    return
  fi
  rm -f "$log"
}

check_preconditions() {
  local validated="${GATE_VALIDATED_SHA:-}"
  if [ -n "$validated" ] && [ "${sha#"$validated"}" = "$sha" ]; then
    warnings+=("WARN  validator sha $validated != gated sha $sha")
  fi
  local repo="${GATE_REPO:-example-org/demo-repo}"
  local pr state
  for pr in ${GATE_MERGE_AFTER:-}; do
    if ! state="$(gh pr view "$pr" -R "$repo" --json state -q .state 2>/dev/null)"; then
      warnings+=("WARN  Merge-after: #$pr state unreadable")
    elif [ "$state" != "MERGED" ]; then
      warnings+=("WARN  Merge-after: #$pr $(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')")
    fi
  done
}

check_preconditions

if [ "${GATE_WARN_ONLY:-}" = "1" ]; then
  printf '%s\n' "${warnings[@]+"${warnings[@]}"}"
  exit 0
fi

if [ -n "$dirty" ]; then
  echo "merge-gate: working tree is not clean; run it on a clean checkout of the final sha" >&2
  echo "$dirty" >&2
  exit 2
fi

for p in "${projects[@]}"; do
  record "$p npm ci" npm ci --prefix "$p" --no-audit --no-fund
  record "$p check" npm run check --prefix "$p"
  record "$p test" npm test --prefix "$p"
  record "$p validate" npm run validate --prefix "$p"
done
record "scripts node --experimental-strip-types --test scripts/*.test.mjs" node --experimental-strip-types --test scripts/*.test.mjs

echo "### Merge gate"
echo
echo "sha \`$sha\`, clean tree, $(node --version), $(date -u +%FT%TZ)"
echo
echo '```'
printf '%s\n' "${warnings[@]+"${warnings[@]}"}" "${results[@]}"
echo '```'
exit "$failed"

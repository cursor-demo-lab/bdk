#!/usr/bin/env bash
# Creates or updates the "Software Factory" folder and the two factory dashboards in Grafana,
# idempotently by uid (POST /api/dashboards/db, overwrite true), then deletes the four retired
# factory dashboards (factory-overview, factory-traces, factory-logs, factory-cost-tokens) by uid,
# only after every upsert succeeded. Nothing else is ever deleted: no other dashboard, no folder.
# Needs bash, curl and jq.
#
#   GRAFANA_URL         the stack, default https://<GRAFANA_STACK>.grafana.net
#   GRAFANA_TOKEN       a service-account token (Editor on the folder), or
#   GRAFANA_TOKEN_FILE  a file holding it, outside this git work tree
#
# The token is never printed, never written to disk, and never put on a command line: curl reads
# the Authorization header from stdin (-H @-). Run python3 generate.py first after editing it.
# xtrace is switched off below, so even `bash -x apply.sh` cannot print the token.
{ set +x; } 2>/dev/null
set -euo pipefail
# An exported CDPATH would send a relative cd elsewhere, and cd then prints the directory into $(...).
unset CDPATH

GRAFANA_URL="${GRAFANA_URL:-https://<GRAFANA_STACK>.grafana.net}"
GRAFANA_URL="${GRAFANA_URL%/}"
FOLDER_UID="software-factory"
FOLDER_TITLE="Software Factory"
DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARDS=(factory-business.json factory-ops.json)
# The four uids this repo used to own (generate.py RETIRED_UIDS). Deleted after a fully successful upsert, and only
# these: never another dashboard, never a folder.
RETIRED_UIDS=(factory-overview factory-traces factory-logs factory-cost-tokens)

die() { echo "apply.sh: $*" >&2; exit 1; }

# resolve_file PATH: the physical path of PATH with every symlink followed, using only cd -P, pwd -P and plain
# readlink (no realpath or readlink -f, which macOS and the BSDs lack or treat differently).
resolve_file() {
  local path=$1 hops=0 target dir
  case "$path" in -*) path="./$path" ;; esac
  while [ -L "$path" ]; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || return 1
    target="$(readlink "$path")" || return 1
    case "$target" in
      /*) path=$target ;;
      *) path="$(dirname "$path")/$target" ;;
    esac
  done
  dir="$(cd -P -- "$(dirname "$path")" && pwd -P)" || return 1
  printf '%s/%s\n' "${dir%/}" "$(basename "$path")"
}
command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"

if [ -n "${GRAFANA_TOKEN:-}" ]; then
  TOKEN="$GRAFANA_TOKEN"
elif [ -n "${GRAFANA_TOKEN_FILE:-}" ]; then
  [ -r "$GRAFANA_TOKEN_FILE" ] || die "GRAFANA_TOKEN_FILE is not readable"
  # The file itself is resolved, so a symlink outside the tree cannot point at a token inside it.
  token_path="$(resolve_file "$GRAFANA_TOKEN_FILE")" || die "cannot resolve GRAFANA_TOKEN_FILE"
  if worktree="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    worktree="$(cd -- "$worktree" && pwd -P)"
    case "$token_path" in
      "$worktree"/*) die "GRAFANA_TOKEN_FILE is inside the git work tree ($worktree); keep the token outside the repository" ;;
    esac
  fi
  TOKEN="$(tr -d '\r\n' < "$GRAFANA_TOKEN_FILE")"
else
  die "set GRAFANA_TOKEN or GRAFANA_TOKEN_FILE (a Grafana service-account token)"
fi
[ -n "$TOKEN" ] || die "the Grafana token is empty"

OUT="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$OUT" "$BODY"' EXIT

# api METHOD PATH [BODY_FILE]: prints the HTTP status; the response body is in $OUT.
api() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -o "$OUT" -w '%{http_code}' -X "$method" -H @- -H 'Accept: application/json')
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "@$body")
  fi
  printf 'Authorization: Bearer %s\n' "$TOKEN" | curl "${args[@]}" "$GRAFANA_URL$path"
}

# Refuse Grafana older than 13.1 (filterFields is the documented floor).
code="$(api GET /api/health)"
[ "$code" = "200" ] || die "GET /api/health failed (HTTP $code)"
ver="$(jq -r '.version // empty' "$OUT")"
[ -n "$ver" ] || die "Grafana version missing from /api/health"
major="${ver%%.*}"
rest="${ver#*.}"
minor="${rest%%.*}"
if ! [ "$major" -gt 13 ] && ! { [ "$major" -eq 13 ] && [ "${minor:-0}" -ge 1 ]; }; then
  die "Grafana ${ver:-unknown} is below 13.1 (filterFields floor)"
fi
echo "grafana: $ver (13.1+)"

# A GET of a folder that does not exist yet answers 403 (not 404) for an Editor service account,
# so anything but 200 means "try to create". 409 or 412 on create means a folder with this uid or this
# title exists; only a second GET by uid tells which, and a title clash would fail every dashboard.
code="$(api GET "/api/folders/$FOLDER_UID")"
if [ "$code" = "200" ]; then
  echo "folder $FOLDER_UID: exists"
else
  jq -n --arg uid "$FOLDER_UID" --arg title "$FOLDER_TITLE" '{uid: $uid, title: $title}' > "$BODY"
  code="$(api POST /api/folders "$BODY")"
  case "$code" in
    200) echo "folder $FOLDER_UID: created" ;;
    409|412)
      create_msg="$(jq -r '.message? // empty' "$OUT" 2>/dev/null)"
      code="$(api GET "/api/folders/$FOLDER_UID")"
      [ "$code" = "200" ] || die "folder create answered a conflict ($create_msg) but uid $FOLDER_UID is not readable" \
        "(HTTP $code): a folder titled '$FOLDER_TITLE' probably exists with another uid; rename it, or give it uid $FOLDER_UID"
      echo "folder $FOLDER_UID: exists" ;;
    *) die "folder create failed (HTTP $code): $(jq -r '.message? // empty' "$OUT" 2>/dev/null)" ;;
  esac
fi

rc=0
for file in "${DASHBOARDS[@]}"; do
  [ -r "$DIR/$file" ] || die "$file is missing; run python3 generate.py"
  jq --arg folder "$FOLDER_UID" \
    '{dashboard: (. + {id: null, version: null}), folderUid: $folder, overwrite: true, message: "observability/grafana/apply.sh"}' \
    "$DIR/$file" > "$BODY"
  code="$(api POST /api/dashboards/db "$BODY")"
  if [ "$code" = "200" ]; then
    echo "$file: $(jq -r '"\(.status) uid=\(.uid) version=\(.version) \(.url)"' "$OUT")"
  else
    echo "$file: FAILED (HTTP $code) $(jq -r '.message? // empty' "$OUT" 2>/dev/null)" >&2
    rc=1
  fi
done
if [ "$rc" != "0" ]; then
  echo "apply.sh: an upsert failed; the retired dashboards are left in place" >&2
  exit "$rc"
fi

# Retire the four old dashboards. 404 means already gone (a re-run); any other answer fails the run
# (the new dashboards are already live; re-run to retry the delete).
for uid in "${RETIRED_UIDS[@]}"; do
  code="$(api DELETE "/api/dashboards/uid/$uid")"
  case "$code" in
    200) echo "retired $uid: deleted" ;;
    404) echo "retired $uid: already gone" ;;
    *)
      echo "retired $uid: delete FAILED (HTTP $code) $(jq -r '.message? // empty' "$OUT" 2>/dev/null)" >&2
      rc=1 ;;
  esac
done
exit "$rc"

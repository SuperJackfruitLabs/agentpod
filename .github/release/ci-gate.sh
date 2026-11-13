#!/bin/sh
# The release tag gate for a product whose CI runs on a forge (Forgejo or Gitea), not on GitHub.
# It reads the forge's commit status for the tag's commit and passes only when the configured
# status context is `success`. When the status cannot be read, or the forge has no status with
# that context for the commit, and the product has a ci-check hook (.github/release/ci-check.sh,
# next to the config), it asks the workflow to run that hook at the tag instead. A status that is
# failing or still pending never falls back.
#
# Usage: ci-gate.sh <release-config.json> <commit-sha>
# Env:   FORGE_STATUS_TOKEN  optional; a forge token that can read the repository (private repos)
#        GITHUB_OUTPUT       optional; receives `source=forge` or `source=tag`
#        GITHUB_REPOSITORY   the default for ci.repo
# Exit:  0 passed or fall back to a check at the tag (see `source`), 1 refused.
set -eu
config=${1:?usage: ci-gate.sh <release-config.json> <commit-sha>}
sha=${2:?usage: ci-gate.sh <release-config.json> <commit-sha>}
out=${GITHUB_OUTPUT:-/dev/null}

forge=$(jq -r '.ci.forge // empty' "$config" | sed 's:/*$::')
repo=$(jq -r --arg d "${GITHUB_REPOSITORY:-}" '.ci.repo // $d' "$config")
context=$(jq -r '.ci.context // empty' "$config")
hook=$(dirname "$config")/release/ci-check.sh
check=
[ -f "$hook" ] && check=yes
if jq -e '(.ci | type) == "object" and .ci.check_command != null' "$config" >/dev/null; then
  echo "::error::ci.check_command is gone: move the command into $hook"
  exit 1
fi

fallback() {
  if [ -n "$check" ]; then
    echo "$1; running $hook at the tag instead"
    echo "source=tag" >> "$out"
    exit 0
  fi
  echo "::error::$1, and there is no $hook to fall back on"
  exit 1
}

if [ -z "$forge" ]; then
  [ -n "$check" ] || { echo "::error::release-config.json needs ci.forge, or a $hook"; exit 1; }
  echo "no forge configured; running $hook at the tag"
  echo "source=tag" >> "$out"
  exit 0
fi
[ -n "$repo" ] && [ -n "$context" ] || { echo "::error::ci.forge needs ci.repo and ci.context"; exit 1; }

body=$(mktemp)
trap 'rm -f "$body"' EXIT
set --
[ -n "${FORGE_STATUS_TOKEN:-}" ] && set -- -H "Authorization: token $FORGE_STATUS_TOKEN"
code=$(curl -sS --max-time 30 -o "$body" -w '%{http_code}' "$@" \
  "$forge/api/v1/repos/$repo/commits/$sha/status" 2>/dev/null) || code=000
if [ "$code" != 200 ]; then
  hint=""
  [ -z "${FORGE_STATUS_TOKEN:-}" ] && hint=" (a private repository needs the FORGE_STATUS_TOKEN secret)"
  fallback "could not read $repo's commit status on $forge: HTTP $code$hint"
fi

# The combined status lists the newest status of each context.
state=$(jq -r --arg c "$context" \
  '[.statuses[]? | select(.context == $c) | (.status // .state)] | first // empty' "$body")
case "$state" in
  success)
    echo "forge CI '$context' passed for $sha"
    echo "source=forge" >> "$out"
    ;;
  "")
    fallback "$forge has no '$context' status for $sha"
    ;;
  pending | warning)
    echo "::error::forge CI '$context' is still $state for $sha; re-run this workflow when it has passed"
    exit 1
    ;;
  *)
    echo "::error::forge CI '$context' is $state for $sha"
    exit 1
    ;;
esac

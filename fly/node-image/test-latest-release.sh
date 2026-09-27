#!/bin/sh
# Tests for latest-release.sh — the version comparator.
#
# POSIX sh with no framework, same as test-volume-workspace.sh, because it runs
# in the node-agent CI job next to `go test`. Exits non-zero on the first
# failure.
#
# Nothing here touches the network: every case is `--compare A B`, so the
# ordering logic is what is under test, not GitHub's availability.
#
# The pin-check cases that used to follow went with the pin. The Dockerfiles
# default to `releases/latest/download` now, so there is no ARG constant to
# compare against a release. The comparator stays because `--compare` is still
# how anything in this repo decides which of two versions is older, and
# v0.1.9 vs v0.1.24 is the case a string comparison gets backwards.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/latest-release.sh"
FAILURES=0

fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "ok: $1"
}

# ── Version comparison ───────────────────────────────────────────────────────
# The case this whole script exists for: v0.1.9 vs v0.1.24 is the one a string
# comparison gets backwards, and getting it backwards would make a stale pin
# read as current.
compare_is() {
  got="$(sh "$CHECK" --compare "$1" "$2")"
  if [ "$got" = "$3" ]; then
    pass "$1 vs $2 -> $3"
  else
    fail "$1 vs $2 -> expected $3, got $got"
  fi
}

compare_is v0.1.9 v0.1.24 older
compare_is v0.1.24 v0.1.9 newer
compare_is v0.1.24 v0.1.24 same
compare_is v0.1.22 v0.1.24 older
compare_is v0.1.24 v0.1.22 newer
compare_is v0.2.0 v0.1.24 newer
compare_is v0.9.9 v1.0.0 older
compare_is v1.0.0 v0.9.9 newer
compare_is v0.10.0 v0.9.0 newer
compare_is 0.1.24 v0.1.24 same        # a pin written without the v
compare_is v0.1 v0.1.0 same           # a missing component is zero
compare_is v0.1.25-rc1 v0.1.25 older  # a pre-release precedes its release
compare_is v0.1.25 v0.1.25-rc1 newer

# A version that is not numeric must be rejected loudly rather than silently
# compared as zero.
if sh "$CHECK" --compare vlatest v0.1.24 >/dev/null 2>&1; then
  fail "accepted a non-numeric version"
else
  pass "rejects a non-numeric version"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "all version comparator checks passed"

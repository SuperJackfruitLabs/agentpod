#!/bin/sh
# Tests for check-version-pin.sh.
#
# POSIX sh with no framework, same as test-volume-workspace.sh, because it runs
# in the node-agent CI job next to `go test`. Exits non-zero on the first
# failure.
#
# Nothing here touches the network: every case passes an explicit --latest, so
# the comparison logic is what is under test, not GitHub's availability.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/check-version-pin.sh"
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

# ── The pin check itself ─────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

write_dockerfile() {
  cat >"$TMP/$1" <<EOF
FROM debian:trixie-slim
ARG AGENTPOD_VERSION=$2
RUN curl -fsSL -o /agentpod-node "https://github.com/rakeshgangwar/agentpod/releases/download/\${AGENTPOD_VERSION}/agentpod-node-linux-amd64"
EOF
}

# Pin equal to latest: passes.
write_dockerfile Dockerfile v0.1.24
write_dockerfile Dockerfile.pi v0.1.24
if sh "$CHECK" --latest v0.1.24 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1; then
  pass "pin equal to latest passes"
else
  fail "pin equal to latest was rejected: $(cat "$TMP/out")"
fi

# Pin behind latest: fails, and says which file and which version.
write_dockerfile Dockerfile v0.1.22
write_dockerfile Dockerfile.pi v0.1.22
if sh "$CHECK" --latest v0.1.24 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1; then
  fail "a stale pin passed: $(cat "$TMP/out")"
else
  if grep -q "v0.1.22" "$TMP/out" && grep -q "v0.1.24" "$TMP/out"; then
    pass "pin behind latest fails, naming both versions"
  else
    fail "stale pin failed but the message did not name the versions: $(cat "$TMP/out")"
  fi
fi

# The lexical trap in the real check, not just in --compare: a v0.1.9 pin
# against a v0.1.24 release must fail.
write_dockerfile Dockerfile v0.1.9
write_dockerfile Dockerfile.pi v0.1.9
if sh "$CHECK" --latest v0.1.24 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1; then
  fail "a v0.1.9 pin passed against a v0.1.24 release: $(cat "$TMP/out")"
else
  pass "v0.1.9 pin fails against a v0.1.24 release"
fi

# The two Fly images must not drift apart from each other.
write_dockerfile Dockerfile v0.1.24
write_dockerfile Dockerfile.pi v0.1.23
if sh "$CHECK" --latest v0.1.24 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1; then
  fail "mismatched pins passed: $(cat "$TMP/out")"
else
  pass "the two Fly images disagreeing fails"
fi

# A Dockerfile with no pin at all is an error, not a pass by omission.
cat >"$TMP/Dockerfile.nopin" <<'EOF'
FROM debian:trixie-slim
RUN echo no pin here
EOF
if sh "$CHECK" --latest v0.1.24 "$TMP/Dockerfile.nopin" >/dev/null 2>&1; then
  fail "a Dockerfile with no ARG default passed"
else
  pass "a Dockerfile with no ARG default is an error"
fi

# ── The real Dockerfiles, offline ────────────────────────────────────────────
# Their pins must agree with each other regardless of what the latest release
# is; the against-latest half of the check needs the network and runs in CI.
real_pin() {
  sed -n 's/^ARG AGENTPOD_VERSION=\([^ ]*\).*$/\1/p' "$1" | head -n 1
}
a="$(real_pin "$HERE/Dockerfile")"
b="$(real_pin "$HERE/Dockerfile.pi")"
if [ -n "$a" ] && [ "$a" = "$b" ]; then
  pass "both Fly Dockerfiles pin $a"
else
  fail "Fly Dockerfile pins disagree: Dockerfile=$a Dockerfile.pi=$b"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "all version-pin checks passed"

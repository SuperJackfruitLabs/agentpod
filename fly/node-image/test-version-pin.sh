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

# What a Dockerfile currently pins, read the same way both scripts read it.
real_pin_of() {
  sed -n 's/^ARG AGENTPOD_VERSION=\([^ ]*\).*$/\1/p' "$1" | head -n 1
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

# ── Moving the pin: bump-version-pin.sh ──────────────────────────────────────
# The check above is only half the story. Nothing moved the pin until #302, so
# every release produced a mechanical two-line PR (#294, #301) before a Fly
# image could be published. These cases are the ones the release workflow rides
# on, so they are exercised here rather than only in a workflow nobody can run
# without cutting a release.
BUMP="$HERE/bump-version-pin.sh"

# A file the bump must not touch beyond the ARG line: the surrounding comments
# are what tell the next reader why the pin exists at all.
write_pinned_pair() {
  write_dockerfile Dockerfile "$1"
  write_dockerfile Dockerfile.pi "${2:-$1}"
}

# Behind the release: both files move, and the run reports it as a change.
write_pinned_pair v0.1.25
if sh "$BUMP" --to v0.1.26 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1; then
  if [ "$(real_pin_of "$TMP/Dockerfile")" = v0.1.26 ] &&
    [ "$(real_pin_of "$TMP/Dockerfile.pi")" = v0.1.26 ] &&
    grep -q "changed=1" "$TMP/out"; then
    pass "a pin behind the release is bumped in both Dockerfiles"
  else
    fail "bump left the pins at $(real_pin_of "$TMP/Dockerfile")/$(real_pin_of "$TMP/Dockerfile.pi"): $(cat "$TMP/out")"
  fi
else
  fail "bump of a stale pin exited non-zero: $(cat "$TMP/out")"
fi

# The bumped result must satisfy the guard — the two scripts agreeing is the
# whole point, and is why the bump reuses --compare instead of its own parser.
if sh "$CHECK" --latest v0.1.26 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1; then
  pass "the bumped Dockerfiles pass the guard"
else
  fail "the bumped Dockerfiles still fail the guard: $(cat "$TMP/out")"
fi

# Nothing but the ARG line changes: same line count, comments intact.
write_pinned_pair v0.1.25
before_lines="$(wc -l <"$TMP/Dockerfile")"
sh "$BUMP" --to v0.1.26 "$TMP/Dockerfile" >/dev/null 2>&1
after_lines="$(wc -l <"$TMP/Dockerfile")"
if [ "$before_lines" = "$after_lines" ] && grep -q "releases/download" "$TMP/Dockerfile"; then
  pass "the bump rewrites only the ARG line"
else
  fail "the bump disturbed the file: $before_lines -> $after_lines lines"
fi

# Already current: a clean no-op. This is the re-run case — cutting the same
# release twice, or re-running the workflow, must not produce an empty commit
# or a failed job.
write_pinned_pair v0.1.26
cp "$TMP/Dockerfile" "$TMP/Dockerfile.orig"
if sh "$BUMP" --to v0.1.26 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1; then
  if cmp -s "$TMP/Dockerfile" "$TMP/Dockerfile.orig" && grep -q "changed=0" "$TMP/out"; then
    pass "a pin already at the release is a no-op, reported as changed=0"
  else
    fail "an already-current pin was rewritten or misreported: $(cat "$TMP/out")"
  fi
else
  fail "an already-current pin failed the bump: $(cat "$TMP/out")"
fi

# Ahead of the target: re-running the release workflow for an OLDER tag must
# not walk the fleet's Fly images backwards.
write_pinned_pair v0.1.26
cp "$TMP/Dockerfile" "$TMP/Dockerfile.orig"
if sh "$BUMP" --to v0.1.24 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1; then
  if cmp -s "$TMP/Dockerfile" "$TMP/Dockerfile.orig" && grep -q "changed=0" "$TMP/out"; then
    pass "a pin ahead of the target is left alone (no downgrade)"
  else
    fail "a newer pin was downgraded: $(cat "$TMP/out")"
  fi
else
  fail "a newer pin failed the bump: $(cat "$TMP/out")"
fi

# The lexical trap, in the bump path this time: v0.1.9 must be treated as
# behind v0.1.24, not ahead of it.
write_pinned_pair v0.1.9
sh "$BUMP" --to v0.1.24 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1 || true
if [ "$(real_pin_of "$TMP/Dockerfile")" = v0.1.24 ]; then
  pass "v0.1.9 is bumped to v0.1.24 (not read as newer)"
else
  fail "v0.1.9 was not bumped to v0.1.24: $(cat "$TMP/out")"
fi

# One file behind and one already current: only the behind one is rewritten,
# and the run still reports a change.
write_pinned_pair v0.1.25 v0.1.26
if sh "$BUMP" --to v0.1.26 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >"$TMP/out" 2>&1 &&
  [ "$(real_pin_of "$TMP/Dockerfile")" = v0.1.26 ] &&
  [ "$(real_pin_of "$TMP/Dockerfile.pi")" = v0.1.26 ] &&
  grep -q "changed=1" "$TMP/out"; then
  pass "a mixed pair converges on the target"
else
  fail "a mixed pair did not converge: $(cat "$TMP/out")"
fi

# A target that is not a version must be refused before anything is written,
# rather than baked into a Dockerfile as a download URL that 404s.
write_pinned_pair v0.1.25
cp "$TMP/Dockerfile" "$TMP/Dockerfile.orig"
if sh "$BUMP" --to latest "$TMP/Dockerfile" >"$TMP/out" 2>&1; then
  fail "a non-version target was accepted: $(cat "$TMP/out")"
else
  if cmp -s "$TMP/Dockerfile" "$TMP/Dockerfile.orig"; then
    pass "a non-version target is refused and writes nothing"
  else
    fail "a non-version target was refused but the file was already rewritten"
  fi
fi

# A Dockerfile with no ARG default is an error, not a silent skip — the same
# stance the guard takes.
if sh "$BUMP" --to v0.1.26 "$TMP/Dockerfile.nopin" >/dev/null 2>&1; then
  fail "a Dockerfile with no ARG default was bumped silently"
else
  pass "bumping a Dockerfile with no ARG default is an error"
fi

# The release workflow branches on `changed`, so the value has to arrive in
# GITHUB_OUTPUT and not only on stdout.
write_pinned_pair v0.1.25
: >"$TMP/gh_output"
GITHUB_OUTPUT="$TMP/gh_output" sh "$BUMP" --to v0.1.26 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >/dev/null 2>&1
GITHUB_OUTPUT="$TMP/gh_output" sh "$BUMP" --to v0.1.26 "$TMP/Dockerfile" "$TMP/Dockerfile.pi" >/dev/null 2>&1
if [ "$(grep -c '^changed=1$' "$TMP/gh_output")" = 1 ] &&
  [ "$(grep -c '^changed=0$' "$TMP/gh_output")" = 1 ]; then
  pass "changed= is written to GITHUB_OUTPUT, 1 then 0 across two runs"
else
  fail "GITHUB_OUTPUT did not record the change: $(cat "$TMP/gh_output")"
fi

# ── The real Dockerfiles, offline ────────────────────────────────────────────
# Their pins must agree with each other regardless of what the latest release
# is; the against-latest half of the check needs the network and runs in CI.
a="$(real_pin_of "$HERE/Dockerfile")"
b="$(real_pin_of "$HERE/Dockerfile.pi")"
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

#!/bin/sh
# Tests for volume-workspace.sh.
#
# POSIX sh with no framework, because it runs in the node-agent CI job next to
# `go test` and must not need a package manager. Exits non-zero on the first
# failure.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$HERE/volume-workspace.sh"
FAILURES=0

fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "ok: $1"
}

# ── It refuses to run without the mount ──────────────────────────────────────
# A machine whose volume did not mount would otherwise write the user's work to
# a rootfs Fly wipes on the next stop — the exact loss this substrate was chosen
# to avoid. A crash loop with a legible log is the better failure.
TMP="$(mktemp -d)"
if AGENTPOD_VOLUME_PATH="$TMP/definitely-not-mounted" sh "$WRAPPER" /bin/true 2>"$TMP/err"; then
  fail "ran without a mounted volume"
else
  if grep -q "not mounted" "$TMP/err"; then
    pass "refuses to run without the mounted volume, and says so"
  else
    fail "refused without the mount but the message did not say why: $(cat "$TMP/err")"
  fi
fi
rm -rf "$TMP"

# ── It points /workspace and HOME at the mount, then execs ───────────────────
TMP="$(mktemp -d)"
mkdir -p "$TMP/mount"
cat >"$TMP/inner.sh" <<'INNER'
#!/bin/sh
echo "HOME=$HOME"
echo "PWD_TARGET=$(cd /workspace 2>/dev/null && pwd -P || echo MISSING)"
echo "ARGS=$*"
INNER
chmod +x "$TMP/inner.sh"

# /workspace is an absolute path the fleet entrypoint hardcodes, so this part
# of the test needs root or a container. Skip cleanly rather than fail when the
# runner cannot write to /.
if [ -w / ]; then
  OUT="$(AGENTPOD_VOLUME_PATH="$TMP/mount" sh "$WRAPPER" "$TMP/inner.sh" hello 2>&1)"

  echo "$OUT" | grep -q "HOME=$TMP/mount/home" \
    && pass "HOME points at the volume" \
    || fail "HOME not on the volume: $OUT"

  echo "$OUT" | grep -q "PWD_TARGET=$TMP/mount/workspace" \
    && pass "/workspace resolves onto the volume" \
    || fail "/workspace not on the volume: $OUT"

  echo "$OUT" | grep -q "ARGS=hello" \
    && pass "passes the inner command its arguments" \
    || fail "arguments lost: $OUT"

  [ -d "$TMP/mount/home" ] \
    && pass "creates the home directory on the volume" \
    || fail "home directory not created"

  rm -f /workspace
else
  echo "skip: / is not writable, cannot test the /workspace symlink here"
fi
rm -rf "$TMP"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES failure(s)"
  exit 1
fi
echo "all volume-workspace tests passed"

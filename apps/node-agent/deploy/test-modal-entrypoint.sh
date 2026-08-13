#!/bin/sh
# Tests for modal-entrypoint.sh.
#
# POSIX sh with no framework, because it has to run INSIDE the built image —
# /workspace is an absolute path and a dev laptop's / is not writable, so the
# only place the real path can be exercised is a container:
#
#   docker run --rm --platform linux/amd64 \
#     -v "$PWD/apps/node-agent/deploy":/t -v /tmp/fake-volume:/workspace \
#     --entrypoint sh agentpod-node-modal:local /t/test-modal-entrypoint.sh
#
# The bind mount at /workspace stands in for the Modal Volume: it is a real
# mount on a different filesystem, which is what the mount-evidence check reads.
# The script resolves the wrapper relative to itself, so mount the directory.
#
# Exits non-zero on the first failure, and reports how many tests actually ran —
# a suite that skipped everything must not read as a pass.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$HERE/modal-entrypoint.sh"
FAILURES=0
RAN=0

fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
  RAN=$((RAN + 1))
}

pass() {
  echo "ok: $1"
  RAN=$((RAN + 1))
}

check() {
  # check <description> <haystack> <needle>
  if printf '%s' "$2" | grep -q "$3"; then
    pass "$1"
  else
    fail "$1 — expected to find '$3' in: $2"
  fi
}

# Every run below where the wrapper is EXPECTED to succeed ends in `|| true`.
# Without it `set -e` turns a non-zero wrapper inside an assignment into a
# silent abort of the whole suite: non-zero overall, but with no named failure
# and every later check skipped. What the wrapper did is asserted from its
# output, so swallowing the status there costs nothing — the runs that are
# expected to FAIL are checked with `if ... ; then fail`, which keeps the status.

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# An inner command that reports everything the wrapper is supposed to have set.
cat >"$TMP/inner.sh" <<'INNER'
#!/bin/sh
echo "HOME=$HOME"
echo "PWD=$(pwd -P)"
echo "ARGS=$*"
INNER
chmod +x "$TMP/inner.sh"

# ── It refuses when the workspace is not there ───────────────────────────────
# A sandbox whose Volume is not where the driver mounts it would serve a station
# backed by the rootfs, and the platform destroys the rootfs within 24 hours.
# Looking healthy until the user's work disappears is the worst available
# failure; exiting with a legible log is the best.
if AGENTPOD_WORKSPACE_PATH="$TMP/not-mounted" sh "$WRAPPER" "$TMP/inner.sh" \
  >"$TMP/out" 2>"$TMP/err"; then
  fail "ran with no workspace directory at all"
else
  check "refuses when the workspace directory is missing, and says why" \
    "$(cat "$TMP/err")" "is missing or is not a directory"
fi

# ── A file where the directory should be is the same refusal ─────────────────
: >"$TMP/workspace-is-a-file"
if AGENTPOD_WORKSPACE_PATH="$TMP/workspace-is-a-file" sh "$WRAPPER" "$TMP/inner.sh" \
  >"$TMP/out" 2>"$TMP/err"; then
  fail "ran with a file where the workspace directory should be"
else
  check "refuses when the workspace path is not a directory" \
    "$(cat "$TMP/err")" "is missing or is not a directory"
fi

# ── It refuses a workspace it cannot write ───────────────────────────────────
# Needs a user who is not root, since root writes through permission bits.
mkdir -p "$TMP/unwritable"
chmod 500 "$TMP/unwritable"
chmod 755 "$TMP"
if [ "$(id -u)" = "0" ] && command -v su >/dev/null 2>&1 &&
  su nobody -s /bin/sh -c 'true' >/dev/null 2>&1; then
  if su nobody -s /bin/sh -c \
    "AGENTPOD_WORKSPACE_PATH='$TMP/unwritable' sh '$WRAPPER' '$TMP/inner.sh'" \
    >"$TMP/out" 2>"$TMP/err"; then
    fail "ran with an unwritable workspace"
  else
    check "refuses an unwritable workspace, and says why" \
      "$(cat "$TMP/err")" "is not writable"
  fi
else
  echo "SKIP: cannot drop privileges here, unwritable-workspace case not covered"
fi
chmod 700 "$TMP/unwritable"

# ── It warns when the workspace is not on its own filesystem ─────────────────
# The mount-evidence line, which live verification reads out of the sandbox log.
mkdir -p "$TMP/same-fs"
OUT="$(AGENTPOD_WORKSPACE_PATH="$TMP/same-fs" sh "$WRAPPER" "$TMP/inner.sh" 2>&1 || true)"
check "warns when the workspace shares the rootfs filesystem" \
  "$OUT" "does not look like a mounted Volume"

# ── It runs the inner command in the workspace ───────────────────────────────
mkdir -p "$TMP/mount"
OUT="$(AGENTPOD_WORKSPACE_PATH="$TMP/mount" sh "$WRAPPER" "$TMP/inner.sh" hello there 2>/dev/null || true)"
check "runs the inner command with the workspace as its working directory" \
  "$OUT" "PWD=$(cd "$TMP/mount" && pwd -P)$"
check "passes the inner command its arguments" "$OUT" "ARGS=hello there$"

# ── HOME never lands on the Volume ───────────────────────────────────────────
# os.UserConfigDir() with no HOME returns an error the node-agent discards,
# leaving a RELATIVE config path that resolves against the working directory —
# which is the Volume. That would write a live node secret into storage shared
# by every future sandbox.
OUT="$(env -u HOME sh -c \
  "AGENTPOD_WORKSPACE_PATH='$TMP/mount' sh '$WRAPPER' '$TMP/inner.sh'" 2>/dev/null || true)"
check "pins HOME to the rootfs when the sandbox provides none" "$OUT" "HOME=/root$"

OUT="$(HOME="$TMP/mount/home" AGENTPOD_WORKSPACE_PATH="$TMP/mount" \
  sh "$WRAPPER" "$TMP/inner.sh" 2>/dev/null || true)"
check "moves HOME off the Volume when it points inside it" "$OUT" "HOME=/root$"

ERR="$(HOME="$TMP/mount/home" AGENTPOD_WORKSPACE_PATH="$TMP/mount" \
  sh "$WRAPPER" "$TMP/inner.sh" 2>&1 >/dev/null || true)"
check "says why it moved HOME" "$ERR" "must not be written to storage"

# A HOME the sandbox set for itself, outside the Volume, is left alone: this
# wrapper's job is keeping credentials off shared storage, not owning HOME.
mkdir -p "$TMP/elsewhere"
OUT="$(HOME="$TMP/elsewhere" AGENTPOD_WORKSPACE_PATH="$TMP/mount" \
  sh "$WRAPPER" "$TMP/inner.sh" 2>/dev/null || true)"
check "leaves a HOME outside the Volume alone" "$OUT" "HOME=$TMP/elsewhere$"

# ── Inside the image only: the real path and the real default inner ──────────
if [ -d /workspace ] && [ -x /node-entrypoint.sh ]; then
  OUT="$(sh "$WRAPPER" "$TMP/inner.sh" 2>/dev/null || true)"
  check "defaults to the /workspace the driver mounts" "$OUT" "PWD=/workspace$"

  ERR="$(sh "$WRAPPER" "$TMP/inner.sh" 2>&1 >/dev/null || true)"
  if printf '%s' "$ERR" | grep -q "does not look like a mounted Volume"; then
    fail "warned about the mount even though /workspace is a real mount — run this with -v <dir>:/workspace"
  else
    pass "does not warn when /workspace is a real mount"
  fi

  # No arguments is the production case. The evidence that it really reached the
  # fleet entrypoint is the node-agent's own refusal: /node-entrypoint.sh runs
  # `/agentpod-node enroll`, which without hub/token fails with this message.
  set +e
  OUT="$(sh "$WRAPPER" 2>&1)"
  STATUS=$?
  set -e
  if [ "$STATUS" -eq 0 ]; then
    fail "no-argument run succeeded without a hub — it cannot have run enroll"
  else
    check "with no arguments it execs the fleet's /node-entrypoint.sh" \
      "$OUT" "enroll requires"
  fi
else
  echo "SKIP: not running inside the image — /workspace default and the"
  echo "SKIP: default inner command are not covered. Run this in the container."
fi

echo "ran $RAN checks"
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES failure(s)"
  exit 1
fi
echo "all modal-entrypoint tests passed"

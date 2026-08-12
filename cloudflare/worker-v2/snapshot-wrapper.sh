#!/bin/sh
# Workspace persistence for the Cloudflare substrate.
#
# Cloudflare container disk is ephemeral: "when a Container instance goes to
# sleep, the next time it is started, it will have a fresh disk as defined by
# its container image". Without this wrapper a station destroys the user's work
# every time it idles out — a README.md written at 04:56 on 2026-08-12 was gone
# by 04:59:58.
#
# This is a WRAPPER, not an edit to the entrypoint, for two reasons. The inner
# entrypoint is subtle (double-fork supervision, a stop sentinel, a zombie that
# once froze the health check) and is byte-compared against the fleet's Docker
# entrypoint by a parity test. And Docker runtimes do not need any of this —
# their disk persists — so the logic belongs to the substrate that lacks it.
#
# Usage: snapshot-wrapper.sh <inner-entrypoint> [args...]
#
# NOTE: deliberately no `set -e`. This script's whole job is to run on the way
# out, and an inherited errexit would let one failed command skip the snapshot —
# which is the failure this file exists to prevent.

# Root of the snapshot paths. Overridable ONLY so the test suite can point the
# whole mechanism at a temp directory instead of the real filesystem.
ROOT="${AGENTPOD_SNAPSHOT_ROOT:-/}"
ROOT="${ROOT%/}/" # normalise: paths are built as "$ROOT$relative"
ARCHIVE="${TMPDIR:-/tmp}/agentpod-snapshot.tar.gz"
INTERVAL="${AGENTPOD_SNAPSHOT_INTERVAL:-300}"

log() { echo "[snapshot] $*"; }

# Paths to preserve, relative to ROOT so tar can restore them positionally.
#
# The opencode data dir is included on purpose: it holds the harness's own
# session state, so without it a woken station has the user's files but no
# memory of the conversation that produced them.
snapshot_paths() {
  home="${HOME:-/root}"
  for p in "workspace" "${home#/}/.local/share/opencode"; do
    [ -e "$ROOT$p" ] && printf '%s\n' "$p"
  done
}

configured() {
  [ -n "$AGENTPOD_SNAPSHOT_URL" ] && [ -n "$AGENTPOD_SNAPSHOT_TOKEN" ]
}

# Pull the archive and unpack it. A missing archive is the normal first boot.
#
# Every failure here is non-fatal by design: starting with an empty workspace is
# bad, but a start loop is worse — the first deploy of this worker put seven
# instances into a silent restart loop, and that must not be reachable from a
# bad restore.
restore() {
  configured || { log "not configured; skipping restore"; return 0; }
  code=$(curl -sS -o "$ARCHIVE" -w '%{http_code}' \
    -H "Authorization: Bearer $AGENTPOD_SNAPSHOT_TOKEN" \
    "$AGENTPOD_SNAPSHOT_URL" 2>/dev/null) || code="000"

  case "$code" in
    200)
      if tar -xzf "$ARCHIVE" -C "$ROOT" 2>/dev/null; then
        log "restored workspace from snapshot"
      else
        log "ERROR: snapshot archive unreadable; continuing with an empty workspace"
      fi
      ;;
    404) log "no snapshot yet (first boot)" ;;
    *)   log "ERROR: restore failed (HTTP $code); continuing with an empty workspace" ;;
  esac
  rm -f "$ARCHIVE"
}

# Archive and upload. Never fails the caller: a sleep must not hang because R2
# or the network is unavailable, for the same reason notifyHub swallows errors.
#
# There is no size cap. Truncating an archive would silently lose the very work
# this exists to protect, so a large workspace is logged and uploaded whole.
snapshot() {
  configured || return 0
  paths=$(snapshot_paths)
  if [ -z "$paths" ]; then
    log "nothing to snapshot yet"
    return 0
  fi

  # shellcheck disable=SC2086 # word splitting is how the path list is passed
  if ! tar -czf "$ARCHIVE" -C "$ROOT" $paths 2>/dev/null; then
    log "ERROR: could not create archive; workspace NOT saved"
    rm -f "$ARCHIVE"
    return 0
  fi

  size=$(wc -c <"$ARCHIVE" 2>/dev/null | tr -d ' ')
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
    --data-binary "@$ARCHIVE" \
    -H "Authorization: Bearer $AGENTPOD_SNAPSHOT_TOKEN" \
    "$AGENTPOD_SNAPSHOT_URL" 2>/dev/null) || code="000"

  if [ "$code" = "200" ]; then
    log "snapshot uploaded (${size} bytes)"
  else
    log "ERROR: snapshot upload failed (HTTP $code); workspace NOT saved"
  fi
  rm -f "$ARCHIVE"
}

CHILD=""
LOOP=""

# SIGTERM is how this substrate says "you are going to sleep". Cloudflare allows
# 15 minutes before SIGKILL, so there is ample room to stop the agent and
# archive a real workspace.
#
# The child is stopped BEFORE archiving, deliberately: tarring a tree while the
# harness is still writing to it produces an archive of a half-written state.
on_term() {
  log "SIGTERM received — stopping agent, then archiving"
  [ -n "$LOOP" ] && kill "$LOOP" 2>/dev/null
  if [ -n "$CHILD" ]; then
    kill -TERM "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
  fi
  snapshot
  log "clean shutdown"
  exit 0
}

trap on_term TERM INT

restore

# Periodic archive, so a container that dies WITHOUT a clean SIGTERM loses at
# most one interval. One did exactly that during the 2026-08-11 verification and
# the cause was never established, so this is not hypothetical.
(
  while :; do
    sleep "$INTERVAL"
    snapshot
  done
) &
LOOP=$!

"$@" &
CHILD=$!
wait "$CHILD"
STATUS=$?

# The agent exited on its own rather than being told to sleep. Archive anyway —
# an unexpected exit is exactly when the work is most worth keeping.
[ -n "$LOOP" ] && kill "$LOOP" 2>/dev/null
log "agent exited (status $STATUS) — archiving"
snapshot
exit "$STATUS"

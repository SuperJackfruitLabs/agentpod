#!/bin/sh
set -e

# Create the workspace directory that OpenCode will manage.
mkdir -p /workspace

# Register /workspace as an OpenCode project so agentpod-node detect lists it.
#
# The node-agent descriptor (internal/descriptor/opencode.go) discovers projects
# via TWO mechanisms (primary first, fallback second):
#
#   PRIMARY:  SELECT worktree FROM project WHERE id != 'global' AND worktree != ''
#             in ~/.local/share/opencode/opencode.db
#
#   FALLBACK: enumerate ~/.local/share/opencode/project/ directories; each subdir
#             name is a sanitised workspace path (leading '/' stripped, '/' → '-'),
#             e.g. /workspace → "workspace".
#
# We deliberately only seed the FALLBACK directory here. An earlier version of
# this script also hand-seeded opencode.db (the PRIMARY path) with a sqlite3
# heredoc matching a specific schema snapshot; that broke when opencode-ai was
# bumped past the version that schema was captured from (`opencode serve`
# refused to start against the pre-seeded db: "Database is not empty and has
# no session table"). Chasing opencode's internal schema across every future
# version bump is brittle, so instead: opencode creates and owns its own
# opencode.db on first run, and this image does not install `sqlite3` (see
# Dockerfile.opencode), which makes the PRIMARY path unavailable in-container
# and forces Detect() onto this directory fallback unconditionally — the
# schema of opencode's self-created db becomes irrelevant to detection.
OPENCODE_DATA="${HOME:-/root}/.local/share/opencode"
mkdir -p "${OPENCODE_DATA}/project/workspace"

# Enroll reads AGENTPOD_HUB_URL and AGENTPOD_ENROLL_TOKEN from the environment.
/agentpod-node enroll

# Supervised opencode server: the station's long-running process. Restarts on
# crash with 2s backoff; killed cleanly when the container stops.
#
# Lifecycle coordination: without the sentinel check below, this loop would
# immediately resurrect `opencode serve` after the node-agent's opencode
# descriptor (internal/descriptor/opencode.go) runs a lifecycle Stop on it,
# making Stop a no-op. The descriptor's Stop kills the process THEN touches
# /var/run/opencode-serve.stop (kill-before-touch is intentional and safe:
# the loop's `sleep 2` after every exit means it can't re-check the sentinel
# and respawn faster than Stop can touch it); the loop checks that sentinel
# before every (re)spawn and exits when it is present. The descriptor's Start
# removes the sentinel and re-spawns `opencode serve` itself — this loop has
# already exited by then, so the two never race.
mkdir -p /var/run
rm -f /var/run/opencode-serve.stop
# Double-fork: the OUTER subshell backgrounds the loop subshell and exits
# immediately, so the loop re-parents to the container's init (docker-init,
# HostConfig.Init) instead of staying a child of this shell — which `exec`s
# into the Go node-agent below. A direct child would linger as a <defunct>
# zombie after the loop halts (the Go process never reaps unrelated
# children), and the zombie's comm still matches the descriptor's pgrep
# health check, freezing Health at "running" (live-fleet finding 2026-08-09).
(
  (
    # `set +e`: the top-level `set -e` (line 2) is inherited into subshells.
    # Without disabling it here, any non-zero exit from `opencode serve` (a
    # crash, or exit 143 from the lifecycle Stop's SIGTERM) would terminate
    # the subshell at that line — the echo/sleep/loop-back below would never
    # run, making supervision single-shot instead of restart-on-crash.
    set +e
    cd /workspace
    while :; do
      if [ -f /var/run/opencode-serve.stop ]; then
        echo "[entrypoint] opencode-serve.stop present, halting supervision loop" >>/var/log/opencode-serve.log
        break
      fi
      opencode serve >>/var/log/opencode-serve.log 2>&1
      echo "[entrypoint] opencode serve exited ($?), restarting in 2s" >>/var/log/opencode-serve.log
      sleep 2
    done
  ) &
) &
# Reap the short-lived outer subshell before exec'ing, so IT doesn't zombie.
wait $!
export AGENTPOD_OPENCODE_SUPERVISED=1

# Hand off to the run loop. AGENTPOD_OPENCODE_SUPERVISED, exported above,
# flows into this process so the opencode descriptor gates its "lifecycle"
# capability and Stop/Start methods on it.
exec /agentpod-node run

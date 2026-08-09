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
# We seed BOTH so detection works regardless of whether sqlite3 is available.

OPENCODE_DATA="${HOME:-/root}/.local/share/opencode"
OPENCODE_DB="${OPENCODE_DATA}/opencode.db"

# Create the data-dir structure opencode.go's Detect() requires.
mkdir -p "${OPENCODE_DATA}/project/workspace"

# PRIMARY: seed opencode.db with a project row for /workspace.
# Schema matches the real opencode.db (id text PK, worktree text NOT NULL,
# sandboxes text NOT NULL, time_created/time_updated integer NOT NULL).
sqlite3 "${OPENCODE_DB}" <<'SQL'
CREATE TABLE IF NOT EXISTS project (
  id            text    PRIMARY KEY,
  worktree      text    NOT NULL,
  vcs           text,
  name          text,
  icon_url      text,
  icon_color    text,
  time_created  integer NOT NULL,
  time_updated  integer NOT NULL,
  time_initialized integer,
  sandboxes     text    NOT NULL,
  commands      text
);
INSERT OR IGNORE INTO project
  (id, worktree, time_created, time_updated, sandboxes)
VALUES
  ('agentpod-workspace', '/workspace', unixepoch() * 1000, unixepoch() * 1000, '[]');
SQL

# Enroll reads AGENTPOD_HUB_URL and AGENTPOD_ENROLL_TOKEN from the environment.
/agentpod-node enroll

# Supervised opencode server: the station's long-running process. Restarts on
# crash with 2s backoff; killed cleanly when the container stops.
#
# Lifecycle coordination: without the sentinel check below, this loop would
# immediately resurrect `opencode serve` after the node-agent's opencode
# descriptor (internal/descriptor/opencode.go) runs a lifecycle Stop on it,
# making Stop a no-op. The descriptor's Stop kills the process THEN touches
# /var/run/opencode-serve.stop; the loop checks that sentinel before every
# (re)spawn and exits when it is present. The descriptor's Start removes the
# sentinel and re-spawns `opencode serve` itself — this loop has already
# exited by then, so the two never race.
mkdir -p /var/run
rm -f /var/run/opencode-serve.stop
(
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
export AGENTPOD_OPENCODE_SUPERVISED=1

# Hand off to the run loop. AGENTPOD_OPENCODE_SUPERVISED, exported above,
# flows into this process so the opencode descriptor gates its "lifecycle"
# capability and Stop/Start methods on it.
exec /agentpod-node run

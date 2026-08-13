#!/bin/sh
# The sandbox's main process on Modal.
#
# Passed as the sandbox COMMAND, not baked as an image ENTRYPOINT: Modal
# requires any ENTRYPOINT to end in `exec "$@"` so its runtime can take over the
# container's command, and the fleet's entrypoint does not — it enrols and then
# execs its own run loop, ignoring "$@" entirely. Dockerfile.modal therefore
# ships no ENTRYPOINT and the driver passes ["/modal-entrypoint.sh"] as the
# command (MODAL_ENTRYPOINT in apps/hub/src/services/provisioner/modal.ts).
#
# THIS IS A WRAPPER, NOT A REPLACEMENT. With no arguments it anchors the
# sandbox and then execs the fleet's own /node-entrypoint.sh, byte-for-byte the
# script every other node-agent image runs, so the enrol-then-run sequence has
# exactly one definition and nothing to drift. Arguments override the inner
# command, which is what makes the wrapper testable without a hub
# (test-modal-entrypoint.sh) and what lets an operator boot an anchored shell.
#
# WHAT NEEDS ANCHORING HERE, and why each one is not simply assumed:
#
#   /workspace  — the Modal Volume the driver mounts (mountPath in modal.ts).
#                 It is the ONLY thing that outlives a sandbox: `terminate` is
#                 irreversible, the platform destroys every sandbox at 24 hours,
#                 and the hub rotates them before it does. Anything written
#                 elsewhere is written in sand. Unlike the Fly image this needs
#                 no symlink — Modal mounts the Volume AT the hardcoded path
#                 (/workspace is fixed in internal/descriptor/opencode.go), so
#                 the workspace is a real directory here and the node-agent's
#                 filepath.WalkDir disk-usage probe reports a true size rather
#                 than the near-zero a symlinked workspace reports on Fly.
#
#   HOME        — must stay OFF the Volume. The node-agent writes its node id
#                 and node secret to os.UserConfigDir()/agentpod-node/config.json
#                 with no env override (internal/config/config.go), and
#                 os.UserConfigDir() is $XDG_CONFIG_HOME, else $HOME/.config,
#                 else an ERROR that DefaultPath() discards — leaving the
#                 RELATIVE path "agentpod-node/config.json", which resolves
#                 against the working directory. The working directory here is
#                 the Volume. So a sandbox launched with no HOME would write a
#                 live node secret into shared, long-lived storage that outlives
#                 every sandbox and that nothing in this system protects. That is
#                 the opposite of the design (see modal.ts: HOME stays on the
#                 disposable rootfs so each sandbox re-enrols with a freshly
#                 minted runtime-bound token), and it would happen silently.
#                 Whether Modal populates HOME is not something we get to assume,
#                 so this pins it.
set -e

# Overridable so the tests can stand a temporary directory in for the Volume;
# the driver never sets it, and the default is the path the driver mounts.
WORKSPACE="${AGENTPOD_WORKSPACE_PATH:-/workspace}"

# Where node identity is allowed to live: the rootfs, which dies with the
# sandbox. Not a Volume path, on purpose. See the HOME note above.
ROOTFS_HOME="/root"

# ── The workspace must be there before anything is written into it ───────────
# Refusing here rather than pressing on: a sandbox that enrols and serves a
# station whose workspace is not the Volume looks exactly like a working station
# right up to the moment the 24-hour ceiling takes the user's work. A container
# that exits with a legible log leaves the runtime visibly stuck in
# `provisioning` instead, which the hub's stalled-start sweeper reports.
if [ ! -d "$WORKSPACE" ]; then
  echo "[modal] FATAL: $WORKSPACE is missing or is not a directory." >&2
  echo "[modal] It is where the driver mounts the runtime's Modal Volume, and" >&2
  echo "[modal] the Volume is the only storage that survives a sandbox." >&2
  exit 1
fi

if [ ! -w "$WORKSPACE" ]; then
  echo "[modal] FATAL: $WORKSPACE is not writable." >&2
  echo "[modal] The workspace Volume must be writable by the node-agent." >&2
  exit 1
fi

# ── Mount evidence, reported and NOT enforced ────────────────────────────────
# A mounted Volume is a different filesystem from the rootfs, so its device id
# differs. Deliberately a warning rather than a refusal: on Modal the Volume is
# mounted as part of sandbox creation, so a sandbox that exists at all was
# created with its mount (a mount failure fails the create, and the driver
# surfaces that) — the Fly case, where a machine boots happily without the mount
# it was configured with, does not arise the same way. And the probe itself is
# unverified against Modal's gVisor runtime, so enforcing it would risk refusing
# to boot every sandbox on an assumption. A line in the log costs nothing and
# tells live verification which it is.
WORKSPACE_DEV="$(stat -c %d "$WORKSPACE" 2>/dev/null || echo unknown)"
ROOTFS_DEV="$(stat -c %d / 2>/dev/null || echo unknown)"
if [ "$WORKSPACE_DEV" = "$ROOTFS_DEV" ]; then
  echo "[modal] WARNING: $WORKSPACE does not look like a mounted Volume — it is" >&2
  echo "[modal] on the same filesystem as the rootfs. Work written there is lost" >&2
  echo "[modal] when this sandbox is destroyed, which the platform does within" >&2
  echo "[modal] 24 hours." >&2
else
  echo "[modal] workspace $WORKSPACE is a separate filesystem from the rootfs"
fi

# ── Node identity stays on the disposable rootfs ─────────────────────────────
if [ -z "${HOME:-}" ]; then
  # Without this the node-agent's config path is relative and lands in the
  # Volume — a node secret in shared storage. See the HOME note above.
  HOME="$ROOTFS_HOME"
  echo "[modal] HOME was unset; pinned to $ROOTFS_HOME so node credentials stay" >&2
  echo "[modal] on the sandbox rootfs rather than in the shared Volume." >&2
else
  case "$HOME" in
    "$WORKSPACE" | "$WORKSPACE"/*)
      echo "[modal] HOME=$HOME is inside the Volume; pinned to $ROOTFS_HOME." >&2
      echo "[modal] The node id and node secret must not be written to storage" >&2
      echo "[modal] that outlives the sandbox holding them." >&2
      HOME="$ROOTFS_HOME"
      ;;
  esac
fi
export HOME
mkdir -p "$HOME"

cd "$WORKSPACE"

# No arguments is the production case: the driver passes only this script, and
# the fleet's own entrypoint (enrol, then exec the run loop) takes it from here.
if [ "$#" -eq 0 ]; then
  set -- /node-entrypoint.sh
fi

exec "$@"

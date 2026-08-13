#!/bin/sh
# Workspace and identity persistence for the Fly Machines substrate.
#
# MEASURED 2026-08-12 on a real Fly account: a sentinel written to / was GONE
# after a stop→start; the same sentinel on a mounted volume survived, and the
# machine id and volume were both preserved. So everything that must outlive a
# stop has to be on the mount.
#
# Two things must:
#   /workspace                 — the user's files. Hardcoded in the fleet's
#                                OpenCode entrypoint and in the node-agent's
#                                opencode descriptor, so it is a symlink here
#                                rather than a configurable path.
#   $HOME                      — agentpod-node keeps nodeId/nodeSecret at
#                                os.UserConfigDir()/agentpod-node/config.json,
#                                and opencode keeps its session state at
#                                $HOME/.local/share/opencode. Without both, a
#                                woken station has neither its files nor any
#                                memory of the conversation that produced them.
#
# This is a WRAPPER, not an edit to the entrypoint. The entrypoint is subtle
# (double-fork supervision, a stop sentinel, a zombie that once froze the health
# check) and is shared byte-for-byte with the Docker fleet, whose disk persists
# and which needs none of this. The logic belongs to the substrate that lacks it.
#
# CONTRAST WITH THE CLOUDFLARE WRAPPER (cloudflare/worker-v2/snapshot-wrapper.sh).
# That one archives the workspace to R2 on SIGTERM and restores it on start, and
# it carries NO node identity: the config under HOME is not in its snapshot set,
# so a woken Cloudflare station has lost nodeId/nodeSecret and only comes back as
# itself because the hub re-enrols its runtime-bound token onto the SAME node row
# (apps/hub/src/services/enrollment.ts). Here the config lands on the volume, so
# identity survives on disk as well — the machine re-reads its own config.json
# and the station keeps its node id without needing the hub-side rescue. That is
# a real behavioural difference between the two substrates, not just a different
# implementation of the same guarantee.
#
# Fly's `persist_rootfs` is deliberately NOT used: Fly's own docs disclaim it
# for critical data, and whether it survives a full stop→start is undocumented.
#
# Usage: volume-workspace.sh <inner-entrypoint> [args...]
set -e

MOUNT="${AGENTPOD_VOLUME_PATH:-/data}"

# A machine whose volume failed to mount would write the user's work to a rootfs
# Fly wipes on the next stop — silently, and looking exactly like a working
# station until the moment the work is gone. Fly's restart policy is `always`,
# so this exit produces a visible crash loop with a legible log instead. That is
# the better failure by a wide margin.
if [ ! -d "$MOUNT" ]; then
  echo "[fly] FATAL: $MOUNT is not mounted." >&2
  echo "[fly] The Fly rootfs is wiped on every stop, so without the volume this" >&2
  echo "[fly] station would lose the user's workspace and its node identity." >&2
  echo "[fly] Check the machine's config.mounts and that the volume exists." >&2
  exit 1
fi

mkdir -p "$MOUNT/workspace" "$MOUNT/home"

# The rootfs is fresh on every boot, so /workspace is either absent or a stale
# real directory from the image. Either way it is replaced by the symlink.
#
# KNOWN COST of /workspace being a symlink rather than a real directory: the
# node-agent's disk-usage probe (internal/descriptor/diskusage.go) uses
# filepath.WalkDir, which by contract does not follow symlinks, so it stats the
# link itself and a Fly station reports a workspace of a few bytes. Everything
# else in the descriptor reaches the tree through os.ReadDir / os.Open / cd,
# all of which follow the link. That is a wrong number on the Health panel, not
# lost work, and fixing it means changing Go — deliberately not done here.
if [ -e /workspace ] && [ ! -L /workspace ]; then
  rm -rf /workspace
fi
ln -sfn "$MOUNT/workspace" /workspace

HOME="$MOUNT/home"
export HOME

echo "[fly] workspace and home anchored on $MOUNT"

exec "$@"

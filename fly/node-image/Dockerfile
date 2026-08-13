# syntax=docker/dockerfile:1

# Fly Machines runtime image: node-agent + the OpenCode harness.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT:
#   docker buildx build --platform linux/amd64 \
#     -f fly/node-image/Dockerfile \
#     -t ghcr.io/<owner>/agentpod-node-opencode-fly:<version> --push .
#
# That is the one difference from cloudflare/worker-v2/Dockerfile worth knowing:
# wrangler pins its build context to its own directory, which forced that image
# to keep a byte-identical COPY of the fleet entrypoint and a parity test to stop
# the two drifting. Building from the root here means the fleet entrypoint is
# copied from where it lives, so there is nothing to drift.
#
# The binary comes from a RELEASE rather than being compiled, so a Fly station
# runs exactly the binary the rest of the fleet runs, verified against SHA256SUMS
# the same way install.sh and self-update do.

FROM oven/bun:1-slim

# Kept current by fly/node-image/check-version-pin.sh, which fails the
# node-agent CI job when this default falls behind the latest release — a stale
# pin here means a Fly station runs an agent without the fixes everyone else
# has, and republishing the image cannot help (issue #290). The publish workflow
# overrides this with --build-arg, so what a published image carries is the
# release resolved at build time; this default is what a local `docker build`
# gets.
ARG AGENTPOD_VERSION=v0.1.25

# oven/bun:1-slim leaves USER unset, i.e. root, which is what everything below
# needs: apt, the release download, and at runtime the wrapper replacing
# /workspace on the rootfs plus the entrypoint writing /var/run and /var/log.
# Pinned explicitly rather than inherited, so a future base-image bump that
# drops to a non-root user cannot silently take away the write access this
# image depends on. Verified with
# `docker run --rm --platform linux/amd64 --entrypoint sh oven/bun:1-slim -c 'id -un'` → root.
USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git procps \
    && rm -rf /var/lib/apt/lists/*
# procps provides `pgrep`, used by the OpenCode descriptor's running-process
# health check; without it the station Health panel shows "process check
# unavailable".
#
# `sqlite3` is deliberately NOT installed — see apps/node-agent/deploy/
# Dockerfile.opencode: omitting it forces the descriptor onto its
# directory-enumeration project-discovery fallback, so opencode's self-managed
# db schema stays irrelevant to detection.

# Pinned to the fleet version, which ships the `acp` subcommand the node-agent's
# ACPCommand spawns.
RUN bun add -g opencode-ai@1.18.15

# Installed at /agentpod-node so the fleet entrypoint works unmodified.
RUN set -eux; \
    base="https://github.com/rakeshgangwar/agentpod/releases/download/${AGENTPOD_VERSION}"; \
    curl -fsSL -o /agentpod-node "${base}/agentpod-node-linux-amd64"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
    cp /agentpod-node /tmp/agentpod-node-linux-amd64; \
    (cd /tmp && grep ' agentpod-node-linux-amd64$' SHA256SUMS | sha256sum -c -); \
    rm -f /tmp/agentpod-node-linux-amd64 /tmp/SHA256SUMS; \
    chmod +x /agentpod-node; \
    /agentpod-node version

# The fleet's own entrypoint, copied from where it lives.
COPY apps/node-agent/deploy/node-opencode-entrypoint.sh /node-opencode-entrypoint.sh
RUN chmod +x /node-opencode-entrypoint.sh

# Workspace and identity persistence: the Fly rootfs is wiped on every
# stop→start (measured), so the wrapper points /workspace and HOME at the
# mounted volume before handing off. It execs the entrypoint rather than
# supervising it — unlike Cloudflare's snapshot wrapper there is nothing to do
# on the way out, because the volume is already the durable copy.
COPY fly/node-image/volume-workspace.sh /volume-workspace.sh
RUN chmod +x /volume-workspace.sh

# test-volume-workspace.sh is deliberately NOT copied in: a production image
# should not ship its own test. To exercise the /workspace half of the wrapper on
# a dev box whose / is not writable (i.e. any macOS laptop), bind-mount it:
#   docker run --rm -v "$PWD/fly/node-image":/t --entrypoint sh <image> \
#     /t/test-volume-workspace.sh
# The script resolves the wrapper relative to itself, so mount the directory.

ENTRYPOINT ["/volume-workspace.sh", "/node-opencode-entrypoint.sh"]

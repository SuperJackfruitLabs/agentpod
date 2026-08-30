# Cloudflare sandbox image: node-agent + the OpenCode harness.
#
# Mirrors apps/node-agent/deploy/Dockerfile.opencode, with one difference: the
# binary is pulled from a RELEASE rather than built here, because wrangler's
# build context is this directory and the Go source is not in it. It is
# checksum-verified against SHA256SUMS exactly as install.sh and self-update do,
# so a Cloudflare station runs the same binary as the rest of the fleet.
#
# The entrypoint is a byte-identical copy of node-opencode-entrypoint.sh, and
# test/entrypoint-parity.test.ts fails if the two ever drift. That script is
# subtle — double-fork to avoid a zombie that freezes the health check, a
# sentinel so lifecycle Stop is not a no-op — and reimplementing it here would
# be a slow way to rediscover both bugs.

# bun base (Debian) for opencode, matching Dockerfile.opencode.
FROM oven/bun:1-slim

ARG AGENTPOD_VERSION=v0.1.30

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git procps \
    && rm -rf /var/lib/apt/lists/*
# procps provides `pgrep`, used by the OpenCode descriptor's running-process
# health check and its supervised-serve Stop/Start; without it the station
# Health panel shows "process check unavailable".
#
# `sqlite3` is deliberately NOT installed — see Dockerfile.opencode for why:
# omitting it forces the descriptor onto its directory-enumeration fallback, so
# opencode's self-managed db schema stays irrelevant to project detection.

# Pinned to the fleet version, which ships the `acp` subcommand the node-agent's
# ACPCommand spawns.
RUN bun add -g opencode-ai@1.18.15

# Installed at /agentpod-node so the entrypoint can be byte-identical to the
# one the Docker image uses.
RUN set -eux; \
    base="https://github.com/rakeshgangwar/agentpod/releases/download/${AGENTPOD_VERSION}"; \
    curl -fsSL -o /agentpod-node "${base}/agentpod-node-linux-amd64"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
    cp /agentpod-node /tmp/agentpod-node-linux-amd64; \
    (cd /tmp && grep ' agentpod-node-linux-amd64$' SHA256SUMS | sha256sum -c -); \
    rm -f /tmp/agentpod-node-linux-amd64 /tmp/SHA256SUMS; \
    chmod +x /agentpod-node; \
    /agentpod-node version

COPY entrypoint.sh /node-opencode-entrypoint.sh
RUN chmod +x /node-opencode-entrypoint.sh

# Workspace persistence. Disk on this substrate is ephemeral, so the wrapper
# restores the workspace on start and archives it on SIGTERM. It runs the
# entrypoint as a CHILD rather than replacing it, which is what keeps that
# script byte-identical to the fleet's Docker one — the parity test above
# depends on it, and `exec` would leave no process to trap SIGTERM.
COPY snapshot-wrapper.sh /snapshot-wrapper.sh
RUN chmod +x /snapshot-wrapper.sh

ENTRYPOINT ["/snapshot-wrapper.sh", "/node-opencode-entrypoint.sh"]

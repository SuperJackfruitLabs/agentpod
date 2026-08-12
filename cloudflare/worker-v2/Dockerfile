FROM debian:bookworm-slim

# Pin explicitly. A floating "latest" would make two deploys of the same worker
# produce different fleet behaviour, which is exactly the kind of drift the
# release pipeline exists to prevent.
ARG AGENTPOD_VERSION=v0.1.22

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Verify against SHA256SUMS, as install.sh and self-update do. An unverified
# binary here would be a supply-chain hole in the substrate itself.
RUN set -eux; \
    base="https://github.com/rakeshgangwar/agentpod/releases/download/${AGENTPOD_VERSION}"; \
    curl -fsSL -o /usr/local/bin/agentpod-node "${base}/agentpod-node-linux-amd64"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
    cd /usr/local/bin; \
    cp agentpod-node agentpod-node-linux-amd64; \
    grep ' agentpod-node-linux-amd64$' /tmp/SHA256SUMS | sha256sum -c -; \
    rm -f agentpod-node-linux-amd64 /tmp/SHA256SUMS; \
    chmod +x /usr/local/bin/agentpod-node; \
    /usr/local/bin/agentpod-node version

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

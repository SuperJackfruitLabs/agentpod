# syntax=docker/dockerfile:1

# Generic node-agent image: no harness preloaded, just enrol and run.
#
# Everything it needs (the agentpod-node binary, ca-certificates, curl, git,
# procps and /node-entrypoint.sh) comes from the shared base image, which must
# be built first:
#
#   docker build -f apps/node-agent/deploy/Dockerfile.base -t agentpod-node:base apps/node-agent
FROM agentpod-node:base

ENTRYPOINT ["/node-entrypoint.sh"]

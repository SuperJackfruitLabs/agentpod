#!/bin/sh
# The release's build (the .github/release/build.sh hook), run at the tag: the
# node-agent, fleet and private bench-worker for linux/darwin and amd64/arm64,
# with the tag stamped in.
# Nodes update themselves from releases/latest and check each binary against SHA256SUMS, so a
# release must carry all twelve: the loop builds every one or fails, and the workflow refuses an
# asset glob that matches nothing. Go cross-compiles (CGO off), so one runner builds them all.
set -eu
: "${TAG:?TAG is the release tag}"
cd apps/node-agent
rm -rf dist
mkdir -p dist
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do
  os=${target%/*}
  arch=${target#*/}
  for cmd in agentpod-node agentpod-fleet agentpod-bench-worker; do
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=$TAG" \
      -o "dist/$cmd-$os-$arch" "./cmd/$cmd"
  done
done
# The names internal/selfupdate and scripts/install.sh fetch, and the tag they report.
./dist/agentpod-node-linux-amd64 version | grep -F "agentpod-node $TAG "
./dist/agentpod-fleet-linux-amd64 version | grep -F "agentpod-fleet $TAG "

# A future dispatcher pins this helper by the explicit release tag and SHA256SUMS;
# publishing it does not install it or enable any dispatch path.
./dist/agentpod-bench-worker-linux-amd64 version | grep -F "agentpod-bench-worker $TAG " | grep -F "agentpod.superbench-worker.v1"

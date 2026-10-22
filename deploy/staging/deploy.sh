#!/usr/bin/env bash
# Deploy a commit of AgentPod to the staging plane, as root on workbench: run by
# /usr/local/sbin/staging-deploy (`agentpod <sha>`). Idempotent. Builds the console for that commit
# (staging hub baked in), recreates the hub, waits for /health and runs the smoke against the
# staging issuer.
set -euo pipefail
sha=${1:-$(git -C /opt/suite-staging/agentpod rev-parse origin/main)}
cd /opt/suite-staging/agentpod
git fetch -q origin
git checkout -q --detach "$sha"
sha=$(git rev-parse HEAD)

# The console builds from its own copy of the commit, so its install never touches the hub's.
out=/opt/suite-staging/agentpod-console
if [ ! -f "$out/$sha/index.html" ]; then
  src=$(mktemp -d)
  git archive "$sha" | tar -x -C "$src"
  docker run --rm -v "$src:/app" -w /app \
    -e PUBLIC_HUB_URL=https://staging-hub.agentpod.dev \
    -e PUBLIC_SUPERLIBRARY_URL=https://staging-app.superlibrary.dev \
    node:22-bookworm sh -c "corepack enable >/dev/null && pnpm install --frozen-lockfile --filter '@agentpod/console...' >/dev/null && pnpm --filter @agentpod/console build >/dev/null"
  rm -rf "$out/$sha.tmp" && mkdir -p "$out" && cp -r "$src/apps/console/build" "$out/$sha.tmp" && mv "$out/$sha.tmp" "$out/$sha"
  rm -rf "$src"
fi
ln -sfn "$sha" "$out/current"
# Keep the five newest builds. Only <sha> directories: `current` is a link to one of them.
ls -1dt "$out"/*/ | grep -E '/[0-9a-f]{40}/$' | tail -n +6 | xargs -r rm -rf

docker compose -f deploy/staging/compose.yml up -d --force-recreate hub console
for _ in $(seq 1 90); do curl -sf http://127.0.0.1:3101/health >/dev/null && break; sleep 2; done
EXPECT_ISSUER=https://staging-accounts.superjackfruit.com sh deploy/smoke.sh http://127.0.0.1:3101
git log -1 --format='staged %h %s'

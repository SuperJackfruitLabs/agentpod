#!/usr/bin/env bash
# Deploy a commit of the hub to the staging plane, as root on workbench: run by
# /usr/local/sbin/staging-deploy (`agentpod <sha>`). Idempotent. Checks out the ref (default
# origin/main), recreates the hub, waits for /health and runs the smoke against the staging issuer.
set -euo pipefail
cd /opt/suite-staging/agentpod
git fetch -q origin
git checkout -q --detach "${1:-origin/main}"
docker compose -f deploy/staging/compose.yml up -d --force-recreate hub
for _ in $(seq 1 90); do curl -sf http://127.0.0.1:3101/health >/dev/null && break; sleep 2; done
EXPECT_ISSUER=https://staging-accounts.superjackfruit.com sh deploy/smoke.sh http://127.0.0.1:3101
git log -1 --format='staged %h %s'

#!/usr/bin/env bash
# deploy/release.sh reads hub.env, a systemd EnvironmentFile, without executing it.
# Regression: v0.1.101's release sourced the file and died on HUB_OAUTH_CLIENTS (spaces, unquoted).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
marker="$tmp/executed"
cat > "$tmp/hub.env" <<X
NODE_ENV=production
HUB_OAUTH_CLIENTS=console https://app.example/cb loopback; touch $marker
DATABASE_URL=postgres://agentpod:p%40ss word@localhost:5432/agentpod
ORG_PLANE_ISSUER="https://accounts.example"
X
export HUB_ENV_FILE="$tmp/hub.env" AGENTPOD_RELEASE_LIB=1
# shellcheck source=release.sh
. "$here/release.sh"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; fail=1; fi; }
check "a plain value" "$(env_get NODE_ENV)" "production"
check "a value with spaces is returned verbatim" "$(env_get DATABASE_URL)" "postgres://agentpod:p%40ss word@localhost:5432/agentpod"
check "surrounding quotes are removed" "$(env_get ORG_PLANE_ISSUER)" "https://accounts.example"
check "a missing key is empty" "$(env_get NOPE)" ""
env_get HUB_OAUTH_CLIENTS >/dev/null
check "nothing in the file is executed" "$([ -e "$marker" ] && echo ran || echo not-run)" "not-run"
exit $fail

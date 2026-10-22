#!/usr/bin/env bash
# Deploy a release tag of the hub on infra, as root: run by /usr/local/sbin/prod-deploy
# (`agentpod v<x.y.z>`), which takes this script from the tag itself.
#
# Each release is its own checkout, /opt/agentpod-releases/<sha>, and a systemd drop-in names the
# live one, so rolling back is pointing the drop-in at the previous directory. In order: build the
# checkout, back up the database, switch the drop-in, restart, wait for /health, run the smoke.
# If the hub does not come back, or the smoke fails, the previous drop-in is restored.
set -euo pipefail

# hub.env is a systemd EnvironmentFile, not shell: values may hold spaces unquoted (HUB_OAUTH_CLIENTS
# does), so sourcing it runs words as commands. Read only the keys this script needs, as systemd
# would: the first `KEY=` line, the rest of the line verbatim, one pair of surrounding quotes removed.
env_get() {
  local v
  v=$(grep -m1 "^$1=" "${HUB_ENV_FILE:-/etc/agentpod/hub.env}" | cut -d= -f2-) || true
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}
# Sourced by deploy/release.test.sh for env_get alone.
if [ "${AGENTPOD_RELEASE_LIB:-}" = 1 ]; then return 0; fi

tag=${1:?usage: release.sh v<x.y.z>}
repo=/opt/agentpod
releases=/opt/agentpod-releases
dropin=/etc/systemd/system/agentpod-hub.service.d/60-release.conf
bun=/root/.bun/bin/bun
export PATH="/root/.local/share/pnpm/bin:$PATH"

git -C "$repo" fetch -q --tags origin
sha=$(git -C "$repo" rev-parse "refs/tags/$tag^{commit}")
dir="$releases/$sha"
stamp=$(date -u +%Y%m%dT%H%M%SZ)

if [ ! -f "$dir/.release-ok" ]; then
  rm -rf "$dir"
  git clone -q --shared "$repo" "$dir"
  git -C "$dir" checkout -q --detach "$sha"
  (cd "$dir" && pnpm install --frozen-lockfile --filter '@agentpod/hub...' > "$releases/$sha-install.log" 2>&1)
  touch "$dir/.release-ok"
fi

DATABASE_URL=$(env_get DATABASE_URL)
ORG_PLANE_ISSUER=$(env_get ORG_PLANE_ISSUER)
[ -n "$DATABASE_URL" ] && [ -n "$ORG_PLANE_ISSUER" ] || { echo "release: DATABASE_URL or ORG_PLANE_ISSUER missing from hub.env" >&2; exit 1; }
pg_dump "$DATABASE_URL" | gzip > "$releases/db-$stamp-before-$tag.sql.gz"

previous=$(mktemp)
cat /etc/systemd/system/agentpod-hub.service.d/*release*.conf > "$previous" 2>/dev/null || true
rm -f /etc/systemd/system/agentpod-hub.service.d/*release*.conf
printf '[Service]\nExecStart=\nExecStart=%s run %s/apps/hub/src/index.ts\n' "$bun" "$dir" > "$dropin"

rollback() {
  echo "release: $tag failed ($1); restoring the previous release" >&2
  if [ -s "$previous" ]; then cp "$previous" "$dropin"; else rm -f "$dropin"; fi
  systemctl daemon-reload
  systemctl restart agentpod-hub
  exit 1
}

systemctl daemon-reload
systemctl restart agentpod-hub
up=
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:3001/health >/dev/null && { up=1; break; }; sleep 2; done
[ -n "$up" ] || rollback "no /health after 120s"
EXPECT_ISSUER="$ORG_PLANE_ISSUER" sh "$dir/deploy/smoke.sh" http://127.0.0.1:3001 || rollback "smoke failed"

# Keep the five newest releases and the database backups of the last two weeks.
ls -1dt "$releases"/*/ | grep -E '/[0-9a-f]{40}/$' | tail -n +6 | xargs -r rm -rf
find "$releases" -maxdepth 1 -name 'db-*.sql.gz' -mtime +14 -delete
echo "released $tag ($sha)"

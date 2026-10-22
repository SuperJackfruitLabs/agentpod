#!/usr/bin/env bash
# Deploy a release tag of the hub on infra, as root: run by /usr/local/sbin/prod-deploy
# (`agentpod v<x.y.z>`), which takes this script from the tag itself.
#
# Each release is its own checkout, /opt/agentpod-releases/<sha>, and a systemd drop-in names the
# live one, so rolling back is pointing the drop-in at the previous directory. In order: build the
# checkout, back up the database, switch the drop-in, restart, wait for /health, run the smoke.
# If the hub does not come back, or the smoke fails, the previous drop-in is restored.
set -euo pipefail
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

set -a; . /etc/agentpod/hub.env; set +a
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

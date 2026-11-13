#!/bin/sh
# The release's production deploy (the .github/release/deploy.sh hook), in the order people
# need: the hub first, then the console that calls it, so a console never reaches people ahead of
# its hub.
#
# The hub: the production host's forced-command key runs `agentpod <tag>`, which runs
# deploy/release.sh from the tag (its own checkout, a database backup, the switch, /health, the
# smoke, and a rollback on failure). The console: a static build with the production hub baked
# in, uploaded to the agentpod-console Pages project. CLOUDFLARE_API_TOKEN is exported by the
# workflow (`secrets`); PROD_HOST, PROD_SSH_KEY and PROD_KNOWN_HOSTS come with every deploy.
set -eu
: "${TAG:?}" "${RELEASE_SHA:?}"
: "${CLOUDFLARE_API_TOKEN:?the workflow exports CLOUDFLARE_API_TOKEN}"
: "${PROD_HOST:?}" "${PROD_SSH_KEY:?}" "${PROD_KNOWN_HOSTS:?}"

install -d -m 700 ~/.ssh
printf '%s\n' "$PROD_SSH_KEY" > ~/.ssh/prod && chmod 600 ~/.ssh/prod
printf '%s\n' "$PROD_KNOWN_HOSTS" > ~/.ssh/known_hosts
ssh -i ~/.ssh/prod -o BatchMode=yes "root@$PROD_HOST" agentpod "$TAG"
# The host key is not needed again: nothing below (dependency scripts included) sees it.
rm -f ~/.ssh/prod
unset PROD_SSH_KEY PROD_KNOWN_HOSTS

# The console waits for a hub that passes its smoke.
i=0
until sh deploy/release/smoke.sh; do
  i=$((i + 1))
  [ "$i" -lt 6 ] || { echo "the hub failed its smoke; the console was not deployed" >&2; exit 1; }
  sleep 10
done

command -v pnpm >/dev/null 2>&1 ||
  npm install --global --ignore-scripts "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")"
# Dependency scripts and the build never see the Cloudflare or GitHub token.
env -u CLOUDFLARE_API_TOKEN -u GH_TOKEN pnpm install --frozen-lockfile
(cd apps/console && env -u CLOUDFLARE_API_TOKEN -u GH_TOKEN PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build)
# Not a secret: it is in every dashboard URL. Naming the account stops wrangler looking it up
# through /memberships, which a Pages-scoped token may not read.
export CLOUDFLARE_ACCOUNT_ID=88acd85618f099112eadc9374996b9f7
root=$PWD
cwd=$(mktemp -d)
(cd "$cwd" && npx --yes wrangler@4 pages deploy "$root/apps/console/build" \
  --project-name=agentpod-console --branch=main --commit-hash="$RELEASE_SHA")

#!/bin/sh
# Prove a deployed hub actually serves what this commit added.
#
# **`/health` is not a deploy check.** On 2026-09-20 the hub was pulled,
# restarted, reported `active`, answered `/health` with 200, ran its migrations
# cleanly — and every `/api/auth/devices*` route returned 404, because they were
# mounted behind Better Auth's `/api/auth/*` catch-all. Nothing in the deploy
# path looked at a route. The 404 was found by hand, afterwards, by someone who
# happened to curl it.
#
# So this checks ROUTES, and it checks them by their refusals. Every endpoint
# here is asked WITHOUT a credential and must answer with a specific status:
#
#   - a 401/403 proves the route exists, is mounted where it can be reached, and
#     refuses an anonymous caller;
#   - a 404 proves it is not reachable — the exact failure above;
#   - a 200 on something that should refuse is worse than either, and fails too.
#
# No credentials are needed and none are used, which is what lets this run
# anywhere, including from CI, without a secret.
#
# Usage:
#   sh deploy/smoke.sh                        # against https://hub.agentpod.dev
#   sh deploy/smoke.sh http://127.0.0.1:3001  # against a local hub
set -eu

BASE="${1:-${HUB_URL:-https://hub.agentpod.dev}}"
BASE="${BASE%/}"
FAILURES=0

# `expect METHOD PATH STATUS[,STATUS...] WHY`
#
# Several acceptable statuses are allowed because a refusal's exact code is the
# route's business, not this script's: what matters is that it refused rather
# than that it chose 401 over 403. A 404 is never in an accepted set — that is
# the thing being detected.
expect() {
  method=$1; path=$2; want=$3; why=$4
  got=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path" 2>/dev/null) || got=000
  [ -n "$got" ] || got=000

  if [ "$got" = "000" ]; then
    echo "FAIL  $method $path — could not reach $BASE"
    FAILURES=$((FAILURES + 1))
    return
  fi

  for ok in $(echo "$want" | tr ',' ' '); do
    if [ "$got" = "$ok" ]; then
      echo "ok    $method $path -> $got   ($why)"
      return
    fi
  done

  if [ "$got" = "404" ]; then
    echo "FAIL  $method $path -> 404 — the route is NOT MOUNTED. $why"
  else
    echo "FAIL  $method $path -> $got, wanted one of $want. $why"
  fi
  FAILURES=$((FAILURES + 1))
}

echo "smoke: $BASE"

# ── Liveness, which is necessary and nowhere near sufficient ────────────────
expect GET /health 200 "the process is up"

# ── The issuer's own surface ────────────────────────────────────────────────
# Everything downstream verifies against this key set. It is served by a route
# registered ahead of Better Auth's catch-all; if that ordering ever breaks,
# this is where it shows.
expect GET /api/auth/jwks 200 "the published key set superpipeline verifies against"

# ── Device credentials (charter 2026-09-18, accepted 2026-09-20) ────────────
# The routes that shipped 404ing. Each must refuse an anonymous caller rather
# than not exist.
expect POST /api/auth/devices/token 401 "exchange refuses a missing device credential"
expect GET  /api/auth/devices       401 "the inventory refuses an anonymous caller"
expect POST /api/auth/devices       401 "creation refuses an anonymous caller"

# ── The cross-domain handoff ────────────────────────────────────────────────
# Also registered ahead of the catch-all, and also invisible to /health.
expect POST /api/auth/token/exchange 400,401 "the code exchange refuses an empty body"

# ── A route behind the auth middleware ──────────────────────────────────────
# Proves the middleware is mounted and refusing, not that it is absent.
expect GET /api/nodes 401,403 "an ordinary API route refuses an anonymous caller"

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "smoke FAILED: $FAILURES check(s). The hub is up but is not serving what it should."
  exit 1
fi
echo "smoke passed: every route answered, and refused."

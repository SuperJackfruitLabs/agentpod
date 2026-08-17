#!/bin/sh
# onboard-agent.sh — give a newly created agent a place in the fleet.
#
# Run on the host where the agent's harness lives, AFTER its profile exists.
# It adopts the station through the hub, and the hub gives it a Matrix identity
# and a room on its own.
#
# ── Why this exists ──────────────────────────────────────────────────────────
#
# `hermes-agents onboard` used to do the Matrix half itself: it created the
# account through the SYNAPSE ADMIN API, logged in as the new user to mint a
# device token, and created a room — all with an admin token stored in a file on
# the node. That token could create, deactivate or take over any account on the
# homeserver, including a human's.
#
# Two things ended it. The homeserver is tuwunel now and implements no such
# admin API, so that code cannot work. And an Application Service needs no
# privilege to register users inside its own namespace, so the ordinary path
# needs no admin credential at all.
#
# What this script holds instead is a HUB token. Everything it can do is
# something the control pair already governs — it can adopt a station, and
# adoption is what makes the hub provision an identity. It cannot touch the
# homeserver, and it cannot act outside its own grant.
#
# ── The ordering inverted, and that is the trap ──────────────────────────────
#
# The old flow made the Matrix account first and the agent second. Now the
# STATION must exist before it can have an identity: the harness creates the
# profile, the node agent detects it, somebody adopts it, and the hub provisions.
# So this script waits for the station to appear rather than assuming it has.
#
# Usage:
#   AGENTPOD_HUB_URL=https://hub.agentpod.dev \
#   AGENTPOD_API_TOKEN=<hub token> \
#     ./onboard-agent.sh <station-key>
#
#   e.g. ./onboard-agent.sh hermes:analyst-echo
set -eu

STATION_KEY="${1:-}"
HUB="${AGENTPOD_HUB_URL:-https://hub.agentpod.dev}"
TOKEN="${AGENTPOD_API_TOKEN:-}"
NODE_NAME="${AGENTPOD_NODE_NAME:-$(hostname)}"
WAIT_SECONDS="${AGENTPOD_WAIT_SECONDS:-120}"

die() { printf '%s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ -n "$STATION_KEY" ] || die "usage: onboard-agent.sh <station-key>   e.g. hermes:analyst-echo"
[ -n "$TOKEN" ] || die "AGENTPOD_API_TOKEN is not set. This script talks to the hub, not to the homeserver."

api() {
  _method="$1"; _path="$2"; _body="${3:-}"
  if [ -n "$_body" ]; then
    curl -sS -X "$_method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "$_body" "$HUB$_path"
  else
    curl -sS -X "$_method" -H "Authorization: Bearer $TOKEN" "$HUB$_path"
  fi
}

json_field() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))" 2>/dev/null || true; }

# ── 1. Which node is this? ───────────────────────────────────────────────────
#
# By NAME rather than hostname: enrolment suffixes a hostname collision
# (`molt-bot`, `molt-bot-2`), and the name is what a grant and a Matrix room are
# built from.
say "Finding node '$NODE_NAME' in the fleet…"
NODE_ID=$(api GET /api/nodes | python3 -c "
import sys, json
name = '$NODE_NAME'
nodes = json.load(sys.stdin)
match = [n for n in nodes if n.get('name') == name]
print(match[0]['id'] if match else '')
")
[ -n "$NODE_ID" ] || die "No node named '$NODE_NAME' is enrolled. Set AGENTPOD_NODE_NAME if this host enrolled under a different name."
say "  node: $NODE_ID"

# ── 2. Wait for the harness to show the station ──────────────────────────────
#
# The profile was created a moment ago; the node agent detects on its own
# schedule. Waiting with a deadline and a clear message beats failing on a race.
say "Waiting for '$STATION_KEY' to be detected on this node…"
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  if api GET "/api/nodes/$NODE_ID/detected" | grep -q "\"$STATION_KEY\""; then
    say "  detected"
    break
  fi
  [ "$(date +%s)" -lt "$DEADLINE" ] || die "Timed out after ${WAIT_SECONDS}s waiting for '$STATION_KEY'. Is the harness profile created and the node agent running? (\`apn status\`)"
  sleep 3
done

# ── 3. Adopt it ──────────────────────────────────────────────────────────────
#
# Adoption is the explicit act — the hub never adopts what it merely sees — and
# it is what makes the bridge provision a Matrix identity and a room.
say "Adopting…"
ADOPTED=$(api POST "/api/nodes/$NODE_ID/stations/adopt" "{\"keys\":[\"$STATION_KEY\"]}")
STATION_ID=$(printf '%s' "$ADOPTED" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
rows = rows if isinstance(rows, list) else []
print(rows[0]['id'] if rows else '')
")
[ -n "$STATION_ID" ] || die "Adoption did not return a station. Response: $ADOPTED"
say "  station: $STATION_ID"

# ── 4. Read back where to talk to it ─────────────────────────────────────────
#
# Idempotent, and it does not create anything the adoption hook has not already
# made — it is here so the operator ends with an address rather than an id.
IDENTITY=$(api POST "/api/stations/$STATION_ID/matrix/identity" '{}')
MXID=$(printf '%s' "$IDENTITY" | json_field mxid)
ALIAS=$(printf '%s' "$IDENTITY" | json_field alias)

say ""
say "Done."
say "  station : $STATION_KEY on $NODE_NAME"
say "  matrix  : ${MXID:-（not provisioned — is ENABLE_MATRIX_BRIDGE set on the hub?）}"
say "  room    : ${ALIAS:-—}"
say ""
say "The room is a DM: accept the invite in your client and talk to it there."
say "If this agent should run its own Matrix client instead of being spoken for,"
say "ask the hub for credentials — that needs mayGrantReach:"
say "  curl -X POST -H \"Authorization: Bearer \$AGENTPOD_API_TOKEN\" \\"
say "    $HUB/api/stations/$STATION_ID/matrix/credentials"

#!/usr/bin/env bash
# install.test.sh — tests install.sh's shadowed-apn detection.
#
# Observed on a real host: a sudo (system) install put apn in /usr/local/bin,
# but an old v0.1.34 at ~/.local/bin/apn came first on the user's PATH, so
# plain `apn status` ran the stale binary. install.sh must warn, naming both.
#
# Sources install.sh with AGENTPOD_INSTALL_LIB=1 (functions only, no install)
# and drives warn_shadowed_apn against a temp HOME with fake binaries.
# Run without root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
pass() { echo "  PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL + 1)); }
has() { if grep -qF -- "$2" "$3"; then pass "$1"; else fail "$1 — expected '$2' in:"; cat "$3"; fi; }
hasnt() { if grep -qF -- "$2" "$3"; then fail "$1 — unexpected '$2' in:"; cat "$3"; else pass "$1"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fake_bin() { # path version
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\necho "agentpod-node %s linux/amd64"\n' "$2" >"$1"
  chmod 0755 "$1"
}

# shellcheck disable=SC1091
AGENTPOD_INSTALL_LIB=1 . "${SCRIPT_DIR}/install.sh"

SYS="$WORK/usr/local/bin"
fake_bin "$SYS/agentpod-node" v0.2.0
ln -sf "$SYS/agentpod-node" "$SYS/apn"

echo "== stale ~/.local/bin/apn shadows the system install"
H1="$WORK/home1"
fake_bin "$H1/.local/bin/agentpod-node" v0.1.34
ln -sf "$H1/.local/bin/agentpod-node" "$H1/.local/bin/apn"
OUT="$WORK/out1"
warn_shadowed_apn "$SYS/agentpod-node" "$SYS" "$H1" "/usr/bin:/bin" >"$OUT" 2>&1
has "warns" "WARNING" "$OUT"
has "names stale path" "$H1/.local/bin/apn" "$OUT"
has "names stale version" "v0.1.34" "$OUT"
has "names new path" "$SYS/apn" "$OUT"
has "names new version" "v0.2.0" "$OUT"
has "says how to fix" "rm " "$OUT"
has "hash -r hint" "hash -r" "$OUT"

echo "== PATH entry before BIN_DIR holding apn"
H2="$WORK/home2"; mkdir -p "$H2"
fake_bin "$WORK/opt/bin/apn" v0.1.10
OUT="$WORK/out2"
warn_shadowed_apn "$SYS/agentpod-node" "$SYS" "$H2" "$WORK/opt/bin:$SYS:/usr/bin" >"$OUT" 2>&1
has "warns for PATH shadow" "$WORK/opt/bin/apn" "$OUT"

echo "== clean home: silent"
H3="$WORK/home3"; mkdir -p "$H3"
OUT="$WORK/out3"
warn_shadowed_apn "$SYS/agentpod-node" "$SYS" "$H3" "$SYS:/usr/bin" >"$OUT" 2>&1
hasnt "no warning" "WARNING" "$OUT"

echo "== symlink to the new binary is not a shadow"
H4="$WORK/home4"; mkdir -p "$H4/.local/bin"
ln -sf "$SYS/agentpod-node" "$H4/.local/bin/apn"
OUT="$WORK/out4"
warn_shadowed_apn "$SYS/agentpod-node" "$SYS" "$H4" "/usr/bin" >"$OUT" 2>&1
hasnt "no warning for link to new binary" "WARNING" "$OUT"

echo "== user files are never deleted"
if [ -x "$H1/.local/bin/apn" ]; then pass "stale apn still present"; else fail "stale apn deleted"; fi

echo "== install mode decision (Linux, root via sudo)"
# decide_install_mode <explicit> <system_unit_exists> <sudo_user> <root_detect_json> <user_detect_json>
J0='[]'
J2='[{"key":"claude-code"},{"key":"codex"}]'
J1='[{"key":"hermes"}]'
mode_of() { decide_install_mode "$@" | cut -f1; }
check_mode() { # name want args...
  local name="$1" want="$2" got; shift 2
  got="$(mode_of "$@")"
  if [ "$got" = "$want" ]; then pass "$name"; else fail "$name (want $want, got '$got')"; fi
}
check_mode "user has harnesses, root none -> user" user "" 0 alice "$J0" "$J2"
check_mode "root has harnesses -> system" system "" 0 alice "$J1" "$J2"
check_mode "neither has harnesses -> system" system "" 0 alice "$J0" "$J0"
check_mode "--system forces system" system system 0 alice "$J0" "$J2"
check_mode "existing system unit -> system" system "" 1 alice "$J0" "$J2"
check_mode "--user forces user" user user 1 alice "$J1" "$J0"
check_mode "plain root (no SUDO_USER) -> system" system "" 0 "" "$J0" "$J2"
check_mode "detect null counts as zero" user "" 0 alice "null" "$J2"
REASON="$(decide_install_mode "" 0 alice "$J0" "$J2" | cut -f2)"
case "$REASON" in *alice*"2 "*--system*) pass "reason names user, count, override" ;; *) fail "reason: $REASON" ;; esac
show() { echo "    $(install_mode_line "$(decide_install_mode "$@")")"; }
show "" 0 alice "$J0" "$J2"
show "" 0 alice "$J1" "$J2"
show "" 0 alice "$J0" "$J0"
show system 0 alice "$J0" "$J2"
show "" 1 alice "$J0" "$J2"
show user 1 alice "$J1" "$J0"

echo "== fallback harness count from well-known paths"
H5="$WORK/home5"; mkdir -p "$H5/.claude" "$H5/.codex" "$H5/.local/bin"
fake_bin "$H5/.local/bin/claude" v1
if [ "$(count_harness_paths "$H5")" = 2 ]; then pass "counts harnesses by home dir"; else fail "fallback count: $(count_harness_paths "$H5")"; fi
if [ "$(count_harness_paths "$WORK/home3")" = 0 ]; then pass "empty home -> 0"; else fail "empty home -> 0"; fi

echo ""
echo "install.test.sh: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]

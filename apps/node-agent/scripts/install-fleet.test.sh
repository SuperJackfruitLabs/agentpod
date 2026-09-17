#!/bin/sh
# Exercises install-fleet.sh against a local binary, so no release is needed.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$HERE/install-fleet.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }

BIN_DIR=$(mktemp -d)
FAKE=$(mktemp -d)
printf '#!/bin/sh\necho fake-fleet\n' > "$FAKE/agentpod-fleet"
chmod +x "$FAKE/agentpod-fleet"

# --uninstall with nothing installed must still exit 0 and say something
# sensible. Under set -eu, a naive `[ -f "$DEST" ] && rm -f "$DEST"` as the
# last statement of the branch fails the whole script when $DEST is absent,
# because the `&&` list's exit status is the (false) test's — this is the
# defect the brief flagged, and this case is what would have caught it.
EMPTY=$(mktemp -d)
OUT=$(mktemp)
BIN_DIR="$EMPTY" sh "$INSTALLER" --uninstall >"$OUT" 2>&1 \
  || fail "uninstall on an empty BIN_DIR exited non-zero"
[ -s "$OUT" ] || fail "uninstall on an empty BIN_DIR printed nothing"
rm -f "$OUT"

# Same, but BIN_DIR itself has never been created (a host that never
# installed at all — mktemp -u gives a unique path without creating it).
NEVER=$(mktemp -u)
BIN_DIR="$NEVER" sh "$INSTALLER" --uninstall >/dev/null 2>&1 \
  || fail "uninstall on a nonexistent BIN_DIR exited non-zero"
[ ! -e "$NEVER" ] || fail "uninstall on a nonexistent BIN_DIR created it"

# Installs both names from a local binary.
BIN_DIR="$BIN_DIR" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null \
  || fail "install exited non-zero"
[ -x "$BIN_DIR/agentpod-fleet" ] || fail "agentpod-fleet not installed"
[ -L "$BIN_DIR/fleet" ]          || fail "fleet alias not created"
[ "$("$BIN_DIR/fleet")" = "fake-fleet" ] || fail "fleet does not run the binary"

# Refuses to destroy a file it did not put there.
OTHER=$(mktemp -d)
echo "someone else's program" > "$OTHER/fleet"
if BIN_DIR="$OTHER" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null 2>&1; then
  fail "installer overwrote a stranger's file"
fi
[ "$(cat "$OTHER/fleet")" = "someone else's program" ] || fail "stranger's file was modified"

# Uninstall removes only its own.
BIN_DIR="$BIN_DIR" sh "$INSTALLER" --uninstall >/dev/null || fail "uninstall exited non-zero"
[ ! -e "$BIN_DIR/fleet" ]          || fail "fleet alias survived uninstall"
[ ! -e "$BIN_DIR/agentpod-fleet" ] || fail "binary survived uninstall"
[ -f "$OTHER/fleet" ]              || fail "uninstall removed a stranger's file"

# Uninstall is idempotent: running it again with nothing left must still
# exit 0, not fail because the files are already gone.
BIN_DIR="$BIN_DIR" sh "$INSTALLER" --uninstall >/dev/null || fail "second uninstall exited non-zero"

# Re-running install over its own prior install (both names already ours)
# must still succeed — the DEST provenance check must not mistake our own
# install for a stranger's.
BIN_DIR="$BIN_DIR" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null \
  || fail "first install (for re-run case) exited non-zero"
BIN_DIR="$BIN_DIR" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null \
  || fail "re-install over our own prior install exited non-zero"
[ "$("$BIN_DIR/fleet")" = "fake-fleet" ] || fail "fleet broken after re-install"
BIN_DIR="$BIN_DIR" sh "$INSTALLER" --uninstall >/dev/null || fail "cleanup uninstall exited non-zero"

# --- DEST provenance: $DEST needs the same "did we put this here" test that
# $ALIAS already has. A regular file happening to sit at $DEST is not
# necessarily ours just because it's a regular file.

# A coincidental regular file at $DEST, with no alias vouching for it: install
# must refuse, must not touch that file, and must not create the alias either
# (a refusal never leaves a half-install).
DESTONLY=$(mktemp -d)
echo "someone else's binary" > "$DESTONLY/agentpod-fleet"
chmod +x "$DESTONLY/agentpod-fleet"
if BIN_DIR="$DESTONLY" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null 2>&1; then
  fail "installer overwrote a stranger's agentpod-fleet"
fi
[ "$(cat "$DESTONLY/agentpod-fleet")" = "someone else's binary" ] \
  || fail "stranger's agentpod-fleet was modified"
[ ! -e "$DESTONLY/fleet" ] || fail "installer created fleet alias despite refusing DEST"

# Same setup: --uninstall must not delete that file either. Nothing vouches
# for it, so it is left alone, and the run still exits 0.
BIN_DIR="$DESTONLY" sh "$INSTALLER" --uninstall >/dev/null || fail "uninstall (DEST-only) exited non-zero"
[ -f "$DESTONLY/agentpod-fleet" ] || fail "uninstall deleted a stranger's agentpod-fleet"

# --- Only one of the two names present, the other direction: a dangling
# alias (points at a DEST that doesn't exist yet) is still "ours" by the
# readlink check, so install may proceed and fill in the missing binary.
ALIASONLY=$(mktemp -d)
ln -s "$ALIASONLY/agentpod-fleet" "$ALIASONLY/fleet"
BIN_DIR="$ALIASONLY" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null \
  || fail "install with a dangling own-alias exited non-zero"
[ -x "$ALIASONLY/agentpod-fleet" ] || fail "DEST not created alongside dangling own-alias"
[ "$("$ALIASONLY/fleet")" = "fake-fleet" ] || fail "fleet (was dangling) does not run the binary"
BIN_DIR="$ALIASONLY" sh "$INSTALLER" --uninstall >/dev/null || fail "cleanup uninstall exited non-zero"

# --- Alias is a symlink pointing somewhere else entirely (not $DEST, and not
# dangling — it resolves to a real, unrelated file). Neither install nor
# uninstall may touch it.
ELSEWHERE=$(mktemp -d)
echo "unrelated target" > "$ELSEWHERE/other-target"
ln -s "$ELSEWHERE/other-target" "$ELSEWHERE/fleet"
if BIN_DIR="$ELSEWHERE" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null 2>&1; then
  fail "installer replaced an alias pointing elsewhere"
fi
[ "$(readlink "$ELSEWHERE/fleet")" = "$ELSEWHERE/other-target" ] \
  || fail "alias pointing elsewhere was retargeted"
[ ! -e "$ELSEWHERE/agentpod-fleet" ] || fail "installer created DEST despite refusing the alias"
BIN_DIR="$ELSEWHERE" sh "$INSTALLER" --uninstall >/dev/null || fail "uninstall (foreign alias) exited non-zero"
[ -L "$ELSEWHERE/fleet" ] || fail "uninstall removed an alias pointing elsewhere"

# --- Alias is a dangling symlink pointing somewhere else (not $DEST, and the
# target doesn't exist either). `[ -e "$ALIAS" ]` is false here since -e
# follows the link to a missing target — only the `[ -L "$ALIAS" ]` half of
# the guard catches this. Neither install nor uninstall may touch it.
DANGLING=$(mktemp -d)
ln -s "$DANGLING/nonexistent-target" "$DANGLING/fleet"
if BIN_DIR="$DANGLING" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null 2>&1; then
  fail "installer replaced a dangling foreign alias"
fi
[ "$(readlink "$DANGLING/fleet")" = "$DANGLING/nonexistent-target" ] \
  || fail "dangling foreign alias was retargeted"
BIN_DIR="$DANGLING" sh "$INSTALLER" --uninstall >/dev/null || fail "uninstall (dangling foreign alias) exited non-zero"
[ -L "$DANGLING/fleet" ] || fail "uninstall removed a dangling foreign alias"

echo "ok: install-fleet.sh"

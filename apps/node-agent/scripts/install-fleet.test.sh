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

echo "ok: install-fleet.sh"

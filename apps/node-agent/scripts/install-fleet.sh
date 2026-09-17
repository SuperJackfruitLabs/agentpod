#!/bin/sh
# install-fleet.sh — put `fleet` (agentpod-fleet) on a PATH.
#
# This installs a CLIENT. It enrols nothing, installs no service, and takes no
# hub URL or token — sign in afterwards with `fleet login`. The node agent has
# its own installer, install.sh, and the two never call each other.
#
#   sh install-fleet.sh                 latest release into ~/.local/bin
#   VERSION=v0.1.34 sh install-fleet.sh pin a release
#   BIN_DIR=~/bin sh install-fleet.sh   somewhere else
#   sh install-fleet.sh --uninstall     remove both names
#
# FLEET_BINARY=<path> installs that file instead of downloading (used by tests).
set -eu

REPO="SuperJackfruitLabs/agentpod"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
DEST="$BIN_DIR/agentpod-fleet"
ALIAS="$BIN_DIR/fleet"

# Ours means: exactly what we would write. Anything else in the way belongs to
# someone and is never this installer's to replace.
ours_alias() { [ -L "$ALIAS" ] && [ "$(readlink "$ALIAS")" = "$DEST" ]; }

if [ "${1:-}" = "--uninstall" ]; then
	# Each removal is gated by an `if`, not a `cmd && rm` list: under set -eu
	# a false condition at the end of a `&&` list is a non-zero exit for the
	# whole statement, which would abort the script before reaching the
	# echo below whenever there was nothing to remove (BIN_DIR empty or
	# missing, or a second run right after the first). An `if` condition is
	# exempt from set -e, so a false ours_alias/-f here is just "skip it".
	removed=""
	if ours_alias; then
		rm -f "$ALIAS"
		removed="$removed $ALIAS"
	fi
	if [ -f "$DEST" ]; then
		rm -f "$DEST"
		removed="$removed $DEST"
	fi
	if [ -n "$removed" ]; then
		echo "removed:$removed"
	else
		echo "nothing to remove: $DEST and $ALIAS not present"
	fi
	exit 0
fi

# Both names are checked before either is written, so a refusal never leaves a
# half-install behind.
if [ -e "$DEST" ] && [ ! -f "$DEST" ]; then
	echo "error: $DEST exists and is not a regular file." >&2
	exit 1
fi
if { [ -e "$ALIAS" ] || [ -L "$ALIAS" ]; } && ! ours_alias; then
	echo "error: $ALIAS already exists and was not created by this installer." >&2
	echo "       Move it aside, or set BIN_DIR to somewhere else." >&2
	exit 1
fi

mkdir -p "$BIN_DIR"

if [ -n "${FLEET_BINARY:-}" ]; then
	cp "$FLEET_BINARY" "$DEST"
else
	os=$(uname -s | tr '[:upper:]' '[:lower:]')
	case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
	esac
	tag="${VERSION:-latest}"
	if [ "$tag" = "latest" ]; then
		url="https://github.com/$REPO/releases/latest/download/agentpod-fleet-$os-$arch"
	else
		url="https://github.com/$REPO/releases/download/$tag/agentpod-fleet-$os-$arch"
	fi
	echo "downloading $url"
	curl -fsSL "$url" -o "$DEST"
fi

chmod 755 "$DEST"
ln -sfn "$DEST" "$ALIAS"
echo "installed $DEST"
echo "installed $ALIAS -> $DEST"

# A correct install the shell cannot see looks identical to a broken one.
case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) echo "note: $BIN_DIR is not on your PATH; add it to run these by name." ;;
esac

echo "next: fleet login"

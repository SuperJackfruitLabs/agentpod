#!/usr/bin/env bash
# install.sh — curl-based installer for the AgentPod node-agent.
#
# System-wide (needs root; installs a systemd service on Linux):
#   curl -fsSL https://github.com/SuperJackfruitLabs/agentpod/releases/latest/download/install.sh \
#     | sudo bash -s -- <HUB_URL> <TOKEN>
#
# Rootless (no sudo; installs into ~/.local/bin — for key-only hosts with no sudo password):
#   curl -fsSL https://github.com/SuperJackfruitLabs/agentpod/releases/latest/download/install.sh \
#     | bash -s -- --user <HUB_URL> <TOKEN>
#
#   HUB_URL   e.g. https://hub.agentpod.dev
#   TOKEN     enrollment token issued by the hub
#   --user    rootless install (no sudo): binary in ~/.local/bin, config in ~/.config
#
# macOS: always a rootless per-user install, regardless of sudo/--user — binary
# in ~/.local/bin, service as a per-user LaunchAgent (~/Library/LaunchAgents).
# A sudo invocation re-execs as the invoking (non-root) user automatically.
#
# Optional env:
#   VERSION                 pin a release tag (e.g. v0.2.0); default: latest release
#   AGENTPOD_USER_INSTALL=1 same as --user

set -euo pipefail

usage() {
  echo "Usage: install.sh [--user] <HUB_URL> <TOKEN>" >&2
  echo "" >&2
  echo "  HUB_URL   hub URL, must start with http:// or https://" >&2
  echo "  TOKEN     enrollment token issued by the hub" >&2
  echo "  --user    rootless install into ~/.local/bin (no sudo; for key-only hosts)" >&2
  echo "" >&2
  echo "Optional env:  VERSION=v0.2.0   AGENTPOD_USER_INSTALL=1" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Args — pull out --user, collect positional HUB_URL + TOKEN
# ---------------------------------------------------------------------------
USER_INSTALL="${AGENTPOD_USER_INSTALL:-}"
ARGS=()
for a in "$@"; do
  if [ "$a" = "--user" ]; then USER_INSTALL=1; else ARGS+=("$a"); fi
done
HUB_URL="${ARGS[0]:-}"
TOKEN="${ARGS[1]:-}"

[[ "$HUB_URL" =~ ^https?:// ]] || { echo "ERROR: HUB_URL must start with http:// or https://" >&2; usage; }
[[ -n "$TOKEN" ]] || { echo "ERROR: TOKEN is required" >&2; usage; }

# ---------------------------------------------------------------------------
# Release URL base (needed early: the re-exec helper below re-fetches this
# script from here whenever $0 isn't a real file on disk).
# ---------------------------------------------------------------------------
REPO="SuperJackfruitLabs/agentpod"
BASE_URL="https://github.com/${REPO}/releases"

# ---------------------------------------------------------------------------
# Re-exec helper. When this script runs as `curl … | bash`, $0 is the literal
# string "bash" — not a path to a script file — so `exec … bash "$0" …`
# becomes `bash bash …`, which fails with "cannot execute binary file" (exit
# 126). Detect that case and re-fetch a runnable copy of the installer to
# re-exec instead. Sets SCRIPT_PATH for the caller to use in its exec.
# ---------------------------------------------------------------------------
reexec_script_path() {
  SCRIPT_PATH="$0"
  if [ ! -f "$SCRIPT_PATH" ]; then
    if [ -n "${VERSION:-}" ]; then
      INSTALL_SH_URL="${BASE_URL}/download/${VERSION}/install.sh"
    else
      INSTALL_SH_URL="${BASE_URL}/latest/download/install.sh"
    fi
    # No trailing suffix after the X run: BSD mktemp (macOS's default — the
    # OS this darwin re-exec path targets) only randomizes a run of X's at
    # the very end of the template and silently returns the template
    # unexpanded (a fixed, non-unique path) if anything follows it, e.g.
    # ".sh". GNU mktemp handles a trailing suffix fine, but this form works
    # identically on both.
    SCRIPT_PATH="$(mktemp /tmp/agentpod-install.XXXXXX)"
    curl -fsSL "$INSTALL_SH_URL" -o "$SCRIPT_PATH" || { echo "ERROR: cannot re-fetch installer for re-exec" >&2; exit 1; }
  fi
}

# ---------------------------------------------------------------------------
# macOS: always a rootless per-user install (binary in ~/.local/bin, config in
# the user's dir, service as a per-user LaunchAgent). Handled before the
# generic sudo-escalation block below so a non-root macOS run goes straight
# to MODE=user with no sudo prompt at all. A root invocation (the console's
# copy-paste `sudo bash …` one-liner) re-execs as the invoking user.
# ---------------------------------------------------------------------------
if [ "$(uname -s)" = "Darwin" ]; then
  if [ "$(id -u)" = "0" ]; then
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
      echo "INFO: macOS install runs per-user — re-executing as ${SUDO_USER}."
      reexec_script_path
      exec sudo -u "$SUDO_USER" VERSION="${VERSION:-}" AGENTPOD_USER_INSTALL=1 bash "$SCRIPT_PATH" "$HUB_URL" "$TOKEN"
    fi
    echo "ERROR: macOS install must run as a regular user (not root)." >&2; exit 1
  fi
  MODE=user
fi

# ---------------------------------------------------------------------------
# Install mode: system (root) vs user (rootless). Only reached when the macOS
# block above didn't already set MODE — i.e. on Linux, or other non-Darwin
# hosts (the macOS root paths above always exec or exit).
# ---------------------------------------------------------------------------
if [ -z "${MODE:-}" ]; then
  if [ "$(id -u)" = "0" ]; then
    MODE=system
  elif [ -n "$USER_INSTALL" ]; then
    MODE=user
  elif command -v sudo >/dev/null 2>&1; then
    echo "INFO: not running as root — re-executing with sudo for a system-wide install."
    echo "      No sudo password on this host? Re-run rootless instead:"
    echo "        curl -fsSL .../install.sh | bash -s -- --user $HUB_URL <TOKEN>"
    reexec_script_path
    exec sudo VERSION="${VERSION:-}" bash "$SCRIPT_PATH" "$HUB_URL" "$TOKEN"
  else
    echo "INFO: not root and 'sudo' not found — falling back to a rootless --user install."
    MODE=user
  fi
fi

# ---------------------------------------------------------------------------
# OS / arch detection
# ---------------------------------------------------------------------------
echo "==> Detecting OS and architecture..."
_os_raw="$(uname -s)"
case "$_os_raw" in
  Linux)  OS=linux  ;;
  Darwin) OS=darwin ;;
  *) echo "ERROR: unsupported OS: $_os_raw (Linux/macOS only)" >&2; exit 1 ;;
esac
_arch_raw="$(uname -m)"
case "$_arch_raw" in
  x86_64)        ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "ERROR: unsupported architecture: $_arch_raw (x86_64/arm64 only)" >&2; exit 1 ;;
esac
echo "    OS=$OS  ARCH=$ARCH  MODE=$MODE"

# ---------------------------------------------------------------------------
# Release download base (REPO/BASE_URL are defined earlier, before the
# mode/re-exec logic above that needs them)
# ---------------------------------------------------------------------------
if [[ -n "${VERSION:-}" ]]; then
  DOWNLOAD_BASE="${BASE_URL}/download/${VERSION}"; echo "    Pinned version: ${VERSION}"
else
  DOWNLOAD_BASE="${BASE_URL}/latest/download"; echo "    Using latest release"
fi

# ---------------------------------------------------------------------------
# Install dir (system vs user) + binary + apn alias
# ---------------------------------------------------------------------------
if [ "$MODE" = "user" ]; then BIN_DIR="$HOME/.local/bin"; else BIN_DIR="/usr/local/bin"; fi
mkdir -p "$BIN_DIR"
DEST_BIN="$BIN_DIR/agentpod-node"

echo "==> Downloading agentpod-node-${OS}-${ARCH}..."
BINARY_URL="${DOWNLOAD_BASE}/agentpod-node-${OS}-${ARCH}"
# Download to a sibling temp file, then atomically rename over the destination.
# Writing directly to $DEST_BIN fails with ETXTBSY when re-running while the
# service holds the running binary open; rename replaces the path safely.
TMP_BIN="${DEST_BIN}.new.$$"
if ! curl -fSL --progress-bar -o "$TMP_BIN" "$BINARY_URL"; then
  rm -f "$TMP_BIN"
  echo "" >&2
  echo "ERROR: download failed: ${BINARY_URL}" >&2
  echo "       Make sure a release exists for this version/arch:" >&2
  echo "       https://github.com/${REPO}/releases" >&2
  exit 1
fi
chmod 0755 "$TMP_BIN"
mv -f "$TMP_BIN" "$DEST_BIN"
ln -sf "$DEST_BIN" "$BIN_DIR/apn"
echo "    Installed to ${DEST_BIN}  (alias: apn)"

# ---------------------------------------------------------------------------
# Enroll — as the user who will RUN the agent, so ~/.config/agentpod-node is
# owned + readable by them.
#  - user mode: already running as that (non-root) user.
#  - system + macOS: sudo preserves $HOME, so enroll as $SUDO_USER (else config is
#    root-owned in the user's dir and `run` as the user can't read it).
#  - system + Linux: the service runs as root, so root-owned config is correct.
# ---------------------------------------------------------------------------
echo "==> Enrolling node with hub at ${HUB_URL}..."
if [ "$MODE" = "system" ] && [ "$OS" = "darwin" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  sudo -u "$SUDO_USER" "$DEST_BIN" enroll --hub "$HUB_URL" --token "$TOKEN"
else
  "$DEST_BIN" enroll --hub "$HUB_URL" --token "$TOKEN"
fi
echo "    Enrolled."

# ---------------------------------------------------------------------------
# Service / run setup
# ---------------------------------------------------------------------------
path_hint() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "NOTE: $BIN_DIR is not on your PATH — add it:"
       echo "        echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc && export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
}

if [ "$MODE" = "user" ]; then
  echo ""
  echo "Done. agentpod-node installed to ${DEST_BIN} (rootless — no sudo used)."
  path_hint
  SVC_OK=0
  if "$DEST_BIN" service install; then SVC_OK=1; fi
  if [ "$SVC_OK" != "1" ]; then
    echo ""
    echo "To start it now:       apn run"
    echo "Persist without root:  tmux new -s apn 'apn run'   (or)   nohup apn run >~/agentpod-node.log 2>&1 &"
  fi

else
  # ---- system (root) — Linux only; macOS system-mode re-execs as the
  # invoking user above, so MODE is never "system" on darwin.
  echo "==> Installing service..."
  "$DEST_BIN" service install
fi

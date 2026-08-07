#!/usr/bin/env bash
# install.sh — curl-based installer for the AgentPod node-agent.
#
# System-wide (needs root; installs a systemd service on Linux):
#   curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
#     | sudo bash -s -- <HUB_URL> <TOKEN>
#
# Rootless (no sudo; installs into ~/.local/bin — for key-only hosts with no sudo password):
#   curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
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
# Install mode: system (root) vs user (rootless)
# ---------------------------------------------------------------------------
if [ "$(id -u)" = "0" ]; then
  MODE=system
elif [ -n "$USER_INSTALL" ]; then
  MODE=user
elif command -v sudo >/dev/null 2>&1; then
  echo "INFO: not running as root — re-executing with sudo for a system-wide install."
  echo "      No sudo password on this host? Re-run rootless instead:"
  echo "        curl -fsSL .../install.sh | bash -s -- --user $HUB_URL <TOKEN>"
  exec sudo VERSION="${VERSION:-}" bash "$0" "$HUB_URL" "$TOKEN"
else
  echo "INFO: not root and 'sudo' not found — falling back to a rootless --user install."
  MODE=user
fi

# ---------------------------------------------------------------------------
# macOS: always a rootless per-user install (binary in ~/.local/bin, config in
# the user's dir, service as a per-user LaunchAgent). A sudo invocation (the
# console's copy-paste one-liner) re-execs as the invoking user.
# ---------------------------------------------------------------------------
if [ "$(uname -s)" = "Darwin" ]; then
  if [ "$(id -u)" = "0" ]; then
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
      echo "INFO: macOS install runs per-user — re-executing as ${SUDO_USER}."
      exec sudo -u "$SUDO_USER" VERSION="${VERSION:-}" AGENTPOD_USER_INSTALL=1 bash "$0" "$HUB_URL" "$TOKEN"
    fi
    echo "ERROR: macOS install must run as a regular user (not root)." >&2; exit 1
  fi
  MODE=user
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
# Release URL base
# ---------------------------------------------------------------------------
REPO="rakeshgangwar/agentpod"
BASE_URL="https://github.com/${REPO}/releases"
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

install_launch_agent() {
  # Per-user LaunchAgent: survives reboot/terminal close, respawns on crash —
  # and respawns after self-update's exit, which is what makes console
  # one-click updates work on macOS (KeepAlive plays systemd Restart=always).
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist="$plist_dir/dev.agentpod.node.plist"
  local log="$HOME/Library/Logs/agentpod-node.log"
  mkdir -p "$plist_dir" "$HOME/Library/Logs"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agentpod.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>${DEST_BIN}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
EOF
  local uid; uid="$(id -u)"
  # Idempotent re-install: tear down any loaded copy first (ignore failures).
  launchctl bootout "gui/${uid}/dev.agentpod.node" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/${uid}" "$plist" 2>/dev/null || launchctl load -w "$plist" 2>/dev/null; then
    echo ""
    echo "Running as a launchd LaunchAgent (survives reboot while you're logged in):"
    echo "  status:     launchctl print gui/${uid}/dev.agentpod.node | head -20"
    echo "  logs:       tail -f ${log}"
    echo "  restart:    launchctl kickstart -k gui/${uid}/dev.agentpod.node"
    echo "  uninstall:  launchctl bootout gui/${uid}/dev.agentpod.node && rm ${plist}"
    echo "NOTE: a LaunchAgent only runs while you are logged in; system sleep"
    echo "      suspends it — the node shows offline until wake (by design)."
    return 0
  fi
  echo "WARNING: could not bootstrap the LaunchAgent — start manually with: apn run" >&2
  return 1
}

if [ "$MODE" = "user" ]; then
  echo ""
  echo "Done. agentpod-node installed to ${DEST_BIN} (rootless — no sudo used)."
  path_hint
  SVC_OK=0
  if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
    UDIR="$HOME/.config/systemd/user"
    mkdir -p "$UDIR"
    cat > "$UDIR/agentpod-node.service" <<EOF
[Unit]
Description=AgentPod node-agent (user service)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${DEST_BIN} run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    if systemctl --user enable --now agentpod-node >/dev/null 2>&1; then SVC_OK=1; fi
  elif [ "$OS" = "darwin" ]; then
    if install_launch_agent; then SVC_OK=1; fi
  fi
  echo ""
  if [ "$SVC_OK" = "1" ]; then
    echo "Running as a systemd --user service:"
    echo "  status:  systemctl --user status agentpod-node"
    echo "  logs:    journalctl --user -u agentpod-node -f"
    echo "  To survive logout/reboot, an admin runs once:  sudo loginctl enable-linger $USER"
  else
    echo "To start it now:       apn run"
    echo "Persist without root:  tmux new -s apn 'apn run'   (or)   nohup apn run >~/agentpod-node.log 2>&1 &"
  fi

elif [ "$OS" = "linux" ]; then
  # ---- system + Linux: systemd service ----
  echo "==> Installing systemd service..."
  UNIT_URL="${DOWNLOAD_BASE}/agentpod-node.service"
  UNIT_DEST="/etc/systemd/system/agentpod-node.service"
  if ! curl -fSL --progress-bar -o "$UNIT_DEST" "$UNIT_URL"; then
    echo "" >&2; echo "ERROR: failed to download unit: ${UNIT_URL}" >&2; exit 1
  fi
  chmod 0644 "$UNIT_DEST"
  systemctl daemon-reload
  systemctl enable --now agentpod-node
  echo ""
  echo "Done. agentpod-node is running as a systemd service."
  echo "  status:  systemctl status agentpod-node"
  echo "  logs:    journalctl -u agentpod-node -f"
fi

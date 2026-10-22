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
#   --system  force a system-wide install (Linux). Without either flag, a
#             `sudo` run on Linux installs as $SUDO_USER (user mode + linger)
#             when only that user has harnesses; else system. An existing
#             system unit stays system.
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
  echo "Usage: install.sh [--user|--system] <HUB_URL> <TOKEN>" >&2
  echo "" >&2
  echo "  HUB_URL   hub URL, must start with http:// or https://" >&2
  echo "  TOKEN     enrollment token issued by the hub" >&2
  echo "  --user    rootless install into ~/.local/bin (no sudo; for key-only hosts)" >&2
  echo "  --system  force a system-wide (root) install on Linux" >&2
  echo "" >&2
  echo "Optional env:  VERSION=v0.2.0   AGENTPOD_USER_INSTALL=1" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Shadowed-apn detection. A stale apn earlier on the invoking user's PATH
# (seen in real use: an old v0.1.34 at ~/.local/bin/apn ahead of
# /usr/local/bin) makes plain `apn status` run the old binary. Under sudo,
# PATH is reset, so the user's own bin dirs are checked explicitly as well as
# every PATH entry that precedes the install dir. Warns only; never deletes.
# ---------------------------------------------------------------------------

# bin_version <path> — first line of `<path> version`, or "unknown". Runs the
# user's binary as that user when we are root via sudo.
bin_version() {
  local v=""
  if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] && command -v sudo >/dev/null 2>&1; then
    v="$(sudo -u "$SUDO_USER" "$1" version 2>/dev/null | head -n1 || true)"
  else
    v="$("$1" version 2>/dev/null | head -n1 || true)"
  fi
  echo "${v:-unknown}"
}

# resolve_path <path> — the path with symlinks resolved (best effort).
resolve_path() {
  readlink -f "$1" 2>/dev/null || realpath "$1" 2>/dev/null || echo "$1"
}

# invoking_user_home — the home of the human who ran the installer.
invoking_user_home() {
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    local h=""
    h="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || true)"
    [ -n "$h" ] || h="$(eval echo "~${SUDO_USER}" 2>/dev/null || true)"
    echo "${h:-$HOME}"
  else
    echo "$HOME"
  fi
}

# warn_shadowed_apn <dest_bin> <bin_dir> <user_home> <user_path>
warn_shadowed_apn() {
  local dest="$1" bin_dir="$2" home="$3" upath="$4"
  local real_dest; real_dest="$(resolve_path "$dest")"
  local dirs=() d seen=":" found=0 name f stale=""
  dirs+=("$home/.local/bin" "$home/bin")
  local IFS=":"
  for d in $upath; do
    [ "$d" = "$bin_dir" ] && break
    dirs+=("$d")
  done
  unset IFS
  for d in "${dirs[@]}"; do
    [ -n "$d" ] && [ "$d" != "$bin_dir" ] || continue
    case "$seen" in *":$d:"*) continue ;; esac
    seen="${seen}${d}:"
    for name in apn agentpod-node; do
      f="$d/$name"
      [ -x "$f" ] || continue
      [ "$(resolve_path "$f")" = "$real_dest" ] && continue
      if [ "$found" = "0" ]; then
        echo ""
        echo "WARNING: another apn/agentpod-node will be found before the one just installed:"
      fi
      found=1
      stale="${stale} $f"
      echo "    $f  ($(bin_version "$f"))"
    done
  done
  if [ "$found" = "1" ]; then
    echo "  just installed:"
    echo "    $bin_dir/apn  ($(bin_version "$dest"))"
    echo "  Plain \`apn\` may run the old binary. To fix, remove the old one(s), e.g.:"
    echo "    rm${stale}"
    echo "  then run \`hash -r\` (or open a new terminal) so your shell finds $bin_dir/apn."
    echo "  Or call $bin_dir/apn by its full path. (Nothing was deleted.)"
  fi
}

# ---------------------------------------------------------------------------
# Install-mode decision (Linux, run as root). A system install runs the node
# as root, whose descriptors look in /root and root's PATH — so a personal
# machine's harnesses (~/.claude, ~/.codex, ~/.local/bin/claude …) are
# invisible and the node reports zero stations. When root got here via sudo
# and only the invoking user has harnesses, install as that user instead.
# ---------------------------------------------------------------------------

SYSTEM_UNIT="/etc/systemd/system/agentpod-node.service"

# detect_count <json> — number of stations in `agentpod-node detect` output.
detect_count() {
  local n
  n="$(printf '%s' "$1" | grep -o '"key"[[:space:]]*:' | wc -l | tr -d ' ')"
  echo "${n:-0}"
}

# count_harness_paths <home> — fallback when `detect` can't run: how many
# harnesses have a home dir. The list mirrors the descriptors in
# internal/descriptor/*.go (claudecode .claude, codex .codex, hermes .hermes,
# openclaw .openclaw, opencode/kilo/muse .local/share/<name>, pi .pi/agent).
count_harness_paths() {
  local home="$1" n=0 d
  for d in .claude .codex .hermes .openclaw .local/share/opencode .local/share/kilo .local/share/muse .pi/agent; do
    [ -d "$home/$d" ] && n=$((n + 1))
  done
  echo "$n"
}

# decide_install_mode <explicit user|system|""> <system_unit_exists 0|1>
#                     <sudo_user> <root_detect_json> <user_detect_json>
# Prints "<user|system><TAB><reason>". Pure: no side effects.
decide_install_mode() {
  local explicit="$1" unit="$2" su="$3" rn un
  rn="$(detect_count "$4")"; un="$(detect_count "$5")"
  if [ "$explicit" = "system" ]; then printf 'system\t--system was given\n'; return; fi
  if [ "$explicit" = "user" ]; then printf 'user\t--user was given\n'; return; fi
  if [ "$unit" = "1" ]; then printf 'system\tan existing system install was found (%s); pass --user to switch\n' "$SYSTEM_UNIT"; return; fi
  if [ -z "$su" ] || [ "$su" = "root" ]; then printf 'system\trunning as root, not via sudo\n'; return; fi
  if [ "$rn" -gt 0 ]; then printf 'system\troot has %s harness(es); pass --user to install as %s instead\n' "$rn" "$su"; return; fi
  if [ "$un" -gt 0 ]; then printf 'user\t%s has %s harness(es) and root has none; pass --system to install as root instead\n' "$su" "$un"; return; fi
  printf 'system\tno harnesses found for root or %s (server); pass --user to install as %s instead\n' "$su" "$su"
}

# install_mode_line <decision> — the one line the installer prints.
install_mode_line() {
  printf '==> Install mode: %s — %s\n' "$(printf '%s' "$1" | cut -f1)" "$(printf '%s' "$1" | cut -f2)"
}

# Tests source this file with AGENTPOD_INSTALL_LIB=1 to get the functions only.
if [ "${AGENTPOD_INSTALL_LIB:-}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

# ---------------------------------------------------------------------------
# Args — pull out --user, collect positional HUB_URL + TOKEN
# ---------------------------------------------------------------------------
USER_INSTALL="${AGENTPOD_USER_INSTALL:-}"
ARGS=()
for a in "$@"; do
  case "$a" in
    --user) USER_INSTALL=1 ;;
    --system) SYSTEM_INSTALL=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
SYSTEM_INSTALL="${SYSTEM_INSTALL:-}"
if [ -n "$USER_INSTALL" ] && [ -n "$SYSTEM_INSTALL" ]; then
  echo "ERROR: pass --user or --system, not both" >&2; usage
fi
EXPLICIT_MODE=""
[ -n "$USER_INSTALL" ] && EXPLICIT_MODE=user
[ -n "$SYSTEM_INSTALL" ] && EXPLICIT_MODE=system
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
    # Root on Linux: choose system vs user (see decide_install_mode). The
    # harness probe runs the release binary's own `detect` as root and as
    # $SUDO_USER, so detection matches what the node would see.
    _su="${SUDO_USER:-}"
    _unit=0; [ -f "$SYSTEM_UNIT" ] && _unit=1
    _root_json="[]"; _user_json="[]"
    if [ -z "$EXPLICIT_MODE" ] && [ "$_unit" = "0" ] && [ -n "$_su" ] && [ "$_su" != "root" ]; then
      _uhome="$(invoking_user_home)"
      _probe_dir="$(mktemp -d /tmp/agentpod-probe.XXXXXX)"; chmod 0755 "$_probe_dir"
      case "$(uname -m)" in x86_64) _parch=amd64 ;; aarch64|arm64) _parch=arm64 ;; *) _parch="" ;; esac
      if [ -n "${VERSION:-}" ]; then _pbase="${BASE_URL}/download/${VERSION}"; else _pbase="${BASE_URL}/latest/download"; fi
      if [ -n "$_parch" ] && curl -fsSL -o "$_probe_dir/agentpod-node" "${_pbase}/agentpod-node-linux-${_parch}" 2>/dev/null \
         && chmod 0755 "$_probe_dir/agentpod-node" \
         && _root_json="$("$_probe_dir/agentpod-node" detect 2>/dev/null)" \
         && _user_json="$(cd / && sudo -u "$_su" -H "$_probe_dir/agentpod-node" detect 2>/dev/null)"; then
        :
      else
        echo "INFO: couldn't run the node's harness detection; checking well-known paths instead."
        _root_json="$(for _i in $(seq 1 "$(count_harness_paths "/root")"); do printf '{"key":1}'; done)"
        _user_json="$(for _i in $(seq 1 "$(count_harness_paths "$_uhome")"); do printf '{"key":1}'; done)"
      fi
      rm -rf "$_probe_dir"
    fi
    _decision="$(decide_install_mode "$EXPLICIT_MODE" "$_unit" "$_su" "$_root_json" "$_user_json")"
    install_mode_line "$_decision"
    MODE="$(printf '%s' "$_decision" | cut -f1)"
    if [ "$MODE" = "user" ]; then
      if [ -z "$_su" ] || [ "$_su" = "root" ]; then
        echo "ERROR: --user as root needs sudo from a regular user (SUDO_USER unset)." >&2; exit 1
      fi
      # We are root, so lingering can be enabled here: the user service then
      # survives logout and starts at boot.
      if command -v loginctl >/dev/null 2>&1; then
        loginctl enable-linger "$_su" || echo "WARNING: loginctl enable-linger $_su failed — the service will stop when $_su logs out."
      fi
      _uid="$(id -u "$_su")"
      reexec_script_path
      # A copy $SUDO_USER can read (mktemp files and /root are root-only).
      _copy="$(mktemp /tmp/agentpod-install.XXXXXX)"
      cp "$SCRIPT_PATH" "$_copy" && chmod 0644 "$_copy" && SCRIPT_PATH="$_copy"
      # Enrollment happens only in the re-exec'd child (single-use token).
      exec sudo -u "$_su" -H VERSION="${VERSION:-}" AGENTPOD_USER_INSTALL=1 XDG_RUNTIME_DIR="/run/user/${_uid}" \
        bash "$SCRIPT_PATH" "$HUB_URL" "$TOKEN"
    fi
  elif [ -n "$USER_INSTALL" ]; then
    MODE=user
  elif command -v sudo >/dev/null 2>&1; then
    echo "INFO: not running as root — re-executing with sudo for a system-wide install."
    echo "      No sudo password on this host? Re-run rootless instead:"
    echo "        curl -fsSL .../install.sh | bash -s -- --user $HUB_URL <TOKEN>"
    reexec_script_path
    exec sudo VERSION="${VERSION:-}" bash "$SCRIPT_PATH" ${SYSTEM_INSTALL:+--system} "$HUB_URL" "$TOKEN"
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
  echo ""
  echo "System-wide install: config and credentials are root-owned, so use sudo:"
  echo "  status:     sudo ${BIN_DIR}/apn status"
  echo "  logs:       sudo ${BIN_DIR}/apn logs -f"
  echo "  restart:    sudo ${BIN_DIR}/apn restart"
fi

# Last, so it is not scrolled away: warn if the invoking user's shell would run
# a different apn first. ${SUDO_USER}'s real PATH is not visible under sudo,
# so the user's own bin dirs are checked explicitly inside the function.
warn_shadowed_apn "$DEST_BIN" "$BIN_DIR" "$(invoking_user_home)" "$PATH" || true

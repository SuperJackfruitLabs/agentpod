#!/bin/sh
# Resolve the latest node-agent release, and compare two versions.
#
# **Was `check-version-pin.sh`, which also failed CI when a Fly Dockerfile's ARG
# default fell behind the latest release.** That guard is gone with the pin it
# guarded: the Dockerfiles now default to `releases/latest/download`, so there is
# no constant to go stale and nothing to check. What is left is the part
# `publish-images.yml` actually needs — a version to pass as `--build-arg`, so a
# PUBLISHED image is still built against one explicit release and stays
# reproducible.
#
# The history is worth keeping, because the pin was not pointless: on 2026-08-13
# both Fly images still said v0.1.22 while the fleet was on v0.1.24, so the #286
# Pi fix could not reach a Fly station (issue #290). The pin was one answer to
# that. Defaulting to `latest` is a better one — it cannot drift — and it keeps
# the supply-chain property that mattered, since the image still downloads a
# RELEASED binary and verifies it against that release's SHA256SUMS.
#
# POSIX sh with no dependencies beyond `gh` or `curl`.
#
# Usage:
#   latest-release.sh                     # print the resolved latest release
#   latest-release.sh --print-latest      # the same, named
#   latest-release.sh --compare A B       # print older|same|newer (A vs B)
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"

die() {
  echo "latest-release: $1" >&2
  exit 2
}

# ── Version comparison ───────────────────────────────────────────────────────
# Echoes how $1 relates to $2: older | same | newer.
#
# Component-wise and NUMERIC. A string comparison is wrong in exactly the case
# that matters — lexically "v0.1.9" > "v0.1.24", so a two-release-stale pin
# would read as current and this whole script would pass while doing nothing.
version_relation() {
  _a="${1#v}"
  _b="${2#v}"
  # Split off a -rc1 / -beta.2 suffix; the numeric part is compared first.
  case "$_a" in *-*) _a_pre="${_a#*-}"; _a="${_a%%-*}" ;; *) _a_pre="" ;; esac
  case "$_b" in *-*) _b_pre="${_b#*-}"; _b="${_b%%-*}" ;; *) _b_pre="" ;; esac

  _i=1
  # Compare as many components as the longer of the two has; a missing
  # component is 0, so v0.1 and v0.1.0 are the same version.
  _n_a=$(( $(printf '%s' "$_a" | tr -cd '.' | wc -c) + 1 ))
  _n_b=$(( $(printf '%s' "$_b" | tr -cd '.' | wc -c) + 1 ))
  _n=$_n_a
  [ "$_n_b" -gt "$_n" ] && _n=$_n_b

  while [ "$_i" -le "$_n" ]; do
    _ai=$(printf '%s' "$_a" | cut -d. -f"$_i")
    _bi=$(printf '%s' "$_b" | cut -d. -f"$_i")
    [ -z "$_ai" ] && _ai=0
    [ -z "$_bi" ] && _bi=0
    case "$_ai" in *[!0-9]*) die "not a numeric version: $1" ;; esac
    case "$_bi" in *[!0-9]*) die "not a numeric version: $2" ;; esac
    if [ "$_ai" -lt "$_bi" ]; then echo older; return 0; fi
    if [ "$_ai" -gt "$_bi" ]; then echo newer; return 0; fi
    _i=$((_i + 1))
  done

  # Equal numerically: a pre-release precedes the release it leads to
  # (semver rule), which keeps a v0.1.25-rc1 pin from passing as v0.1.25.
  if [ -n "$_a_pre" ] && [ -z "$_b_pre" ]; then echo older; return 0; fi
  if [ -z "$_a_pre" ] && [ -n "$_b_pre" ]; then echo newer; return 0; fi
  if [ "$_a_pre" = "$_b_pre" ]; then echo same; return 0; fi
  # `sort` rather than test's `<`, which is an extension dash does not have.
  if [ "$(printf '%s\n%s\n' "$_a_pre" "$_b_pre" | sort | head -n 1)" = "$_a_pre" ]; then
    echo older
  else
    echo newer
  fi
}

# ── Reading the pin out of a Dockerfile ──────────────────────────────────────
pin_in() {
  [ -f "$1" ] || die "no such Dockerfile: $1"
  _pin=$(sed -n 's/^ARG AGENTPOD_VERSION=\([^ ]*\).*$/\1/p' "$1" | head -n 1)
  [ -n "$_pin" ] || die "$1 has no 'ARG AGENTPOD_VERSION=' default"
  printf '%s\n' "$_pin"
}

# The repo whose releases the pin refers to is read out of the download URL in
# the Dockerfile itself, so the check can never end up asking a different repo
# than the build downloads from (a fork's CI included).
repo_in() {
  _repo=$(sed -n 's|.*https://github.com/\([^/]*/[^/]*\)/releases/download/.*|\1|p' "$1" | head -n 1)
  [ -n "$_repo" ] || die "$1 has no github releases download URL to resolve against"
  printf '%s\n' "$_repo"
}

# ── Resolving the latest release ─────────────────────────────────────────────
# `gh` when it is there (CI runners and dev boxes have it), plain curl against
# the REST API otherwise. Retried: a transient API blip must not be able to
# quietly turn this check off, so failure to resolve is a hard error.
resolve_latest() {
  _repo="$1"
  _attempt=1
  while [ "$_attempt" -le 3 ]; do
    if command -v gh >/dev/null 2>&1; then
      _tag=$(gh release view --repo "$_repo" --json tagName --jq .tagName 2>/dev/null || true)
    else
      _tag=$(curl -fsSL "https://api.github.com/repos/$_repo/releases/latest" 2>/dev/null |
        sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -n 1)
    fi
    if [ -n "$_tag" ]; then
      printf '%s\n' "$_tag"
      return 0
    fi
    _attempt=$((_attempt + 1))
    [ "$_attempt" -le 3 ] && sleep 2
  done
  die "could not resolve the latest release of $_repo"
}

# ── Arguments ────────────────────────────────────────────────────────────────
MODE=print-latest

while [ $# -gt 0 ]; do
  case "$1" in
    --print-latest)
      shift
      ;;
    --compare)
      [ $# -ge 3 ] || die "--compare needs two versions"
      version_relation "$2" "$3"
      exit 0
      ;;
    -h | --help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

# The repo is read from a Dockerfile so the resolver and the images cannot
# disagree about WHICH repository's releases they mean — the worker image names
# a different owner from the Fly ones, and a resolver with its own hardcoded
# repo would silently answer for the wrong one.
LATEST=$(resolve_latest "$(repo_in "$HERE/Dockerfile")")

printf '%s\n' "$LATEST"

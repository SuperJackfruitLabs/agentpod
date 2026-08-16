#!/bin/sh
# Guard the node-agent release pin baked into the Fly images.
#
# The Fly images download a RELEASED agentpod-node binary and verify it against
# SHA256SUMS, instead of compiling one the way the Modal images do. That is a
# real supply-chain property and it stays. Its cost is a version pin, and a pin
# nobody is forced to move goes stale silently: on 2026-08-13 both Fly images
# still said v0.1.22 while the fleet was on v0.1.24, so the #286 Pi fix could
# not reach a Fly station no matter how many times the image was republished
# (issue #290).
#
# This script is the thing that forces the pin to move. It fails when the ARG
# default in either Fly Dockerfile is BEHIND the latest node-agent release, or
# when the two Dockerfiles disagree with each other.
#
# POSIX sh with no dependencies beyond `gh` or `curl`, because it runs in the
# node-agent CI job next to `go test` and in the publish workflow, neither of
# which should need a package manager.
#
# Usage:
#   check-version-pin.sh                       # resolve latest release, check pins
#   check-version-pin.sh --latest v0.1.24      # check pins against a given version
#   check-version-pin.sh --print-latest        # print the resolved latest release
#   check-version-pin.sh --compare A B         # print older|same|newer (A vs B)
#   check-version-pin.sh [--latest V] FILE...  # check these Dockerfiles instead
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"

die() {
  echo "check-version-pin: $1" >&2
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
LATEST=""
MODE=check
FILES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --latest)
      [ $# -ge 2 ] || die "--latest needs a version"
      LATEST="$2"
      shift 2
      ;;
    --print-latest)
      MODE=print-latest
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
    -*)
      die "unknown option: $1"
      ;;
    *)
      FILES="$FILES $1"
      shift
      ;;
  esac
done

# Both Fly images by default. They are pinned together ON PURPOSE — two
# stations on one substrate running different node-agent builds makes "it works
# on the other one" mean nothing — so both are checked, and against each other.
# The Cloudflare worker image is checked too. It is not a Fly file, but it
# pins the node-agent the same way and is a deployment artifact its nodes
# cannot self-update away from (#349) — while nothing checked it, it sat on
# v0.1.22 for five releases and a station could not be moved forward at all.
[ -n "$FILES" ] || FILES="$HERE/Dockerfile $HERE/Dockerfile.pi $HERE/../../cloudflare/worker-v2/Dockerfile"

if [ -z "$LATEST" ]; then
  # shellcheck disable=SC2086 # deliberate word splitting of the file list
  set -- $FILES
  LATEST=$(resolve_latest "$(repo_in "$1")")
fi

if [ "$MODE" = print-latest ]; then
  printf '%s\n' "$LATEST"
  exit 0
fi

# ── The check ────────────────────────────────────────────────────────────────
STATUS=0
FIRST_PIN=""
FIRST_FILE=""

# shellcheck disable=SC2086 # deliberate word splitting of the file list
for file in $FILES; do
  pin=$(pin_in "$file")
  rel=$(version_relation "$pin" "$LATEST")

  if [ -z "$FIRST_PIN" ]; then
    FIRST_PIN="$pin"
    FIRST_FILE="$file"
  elif [ "$pin" != "$FIRST_PIN" ]; then
    echo "FAIL: $file pins $pin but $FIRST_FILE pins $FIRST_PIN — the Fly images must pin the same node-agent release" >&2
    STATUS=1
  fi

  case "$rel" in
    older)
      echo "FAIL: $file pins AGENTPOD_VERSION=$pin, which is behind the current node-agent release $LATEST." >&2
      echo "      A Fly image built from this default ships an agent without the fixes in $LATEST." >&2
      echo "      Fix: set 'ARG AGENTPOD_VERSION=$LATEST' in $file." >&2
      STATUS=1
      ;;
    same)
      echo "ok: $file pins $pin (current release)"
      ;;
    newer)
      # An unreleased pin would fail the image build at the download, not here;
      # this is only reachable while a release is mid-flight.
      echo "ok: $file pins $pin (ahead of the resolved release $LATEST)"
      ;;
  esac
done

exit $STATUS

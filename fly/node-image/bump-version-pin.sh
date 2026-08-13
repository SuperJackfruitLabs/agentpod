#!/bin/sh
# Move the node-agent release pin baked into the Fly images forward.
#
# The other half of check-version-pin.sh. That script fails when a Fly
# Dockerfile's ARG default is behind the current release; this one puts it back
# in front. Without it the guard is a tax: cutting v0.1.25 and v0.1.26 on
# 2026-08-13 blocked Fly publishing twice in one day, each time until a human
# opened a two-line PR (#294, #301) — a mechanical step that recurs on every
# release and eventually gets routed around rather than done (issue #302).
#
# The guard stays. This is what makes the pin a CONSEQUENCE of cutting a
# release instead of a prerequisite for publishing one.
#
# The comparison is NOT reimplemented here: every decision goes through
# `check-version-pin.sh --compare`, so there is one notion of which version is
# newer. Two would be how "v0.1.9 is after v0.1.24" comes back (#292).
#
# POSIX sh, no dependencies, same as its sibling — it runs in the release
# workflow and in the offline test.
#
# Usage:
#   bump-version-pin.sh --to v0.1.27            # both Fly Dockerfiles
#   bump-version-pin.sh --to v0.1.27 FILE...    # these Dockerfiles instead
#   bump-version-pin.sh                         # --to = latest release (network)
#
# Prints one line per file and a final `changed=0|1`. When GITHUB_OUTPUT is set
# (i.e. inside Actions) the same `changed=` line is appended there, so the
# workflow can skip committing without parsing stdout.
#
# Exit status is 0 for BOTH "bumped" and "nothing to do" — an already-current
# pin is the re-run case, not an error. Non-zero means the request itself was
# bad: an unreadable file, no ARG default, a target that is not a version.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/check-version-pin.sh"

die() {
  echo "bump-version-pin: $1" >&2
  exit 2
}

[ -f "$CHECK" ] || die "check-version-pin.sh is missing next to this script"

pin_in() {
  [ -f "$1" ] || die "no such Dockerfile: $1"
  _pin=$(sed -n 's/^ARG AGENTPOD_VERSION=\([^ ]*\).*$/\1/p' "$1" | head -n 1)
  [ -n "$_pin" ] || die "$1 has no 'ARG AGENTPOD_VERSION=' default"
  printf '%s\n' "$_pin"
}

# ── Arguments ────────────────────────────────────────────────────────────────
TARGET=""
FILES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --to)
      [ $# -ge 2 ] || die "--to needs a version"
      TARGET="$2"
      shift 2
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

# Both Fly images by default: they are pinned together on purpose, so they are
# bumped together too.
[ -n "$FILES" ] || FILES="$HERE/Dockerfile $HERE/Dockerfile.pi"

if [ -z "$TARGET" ]; then
  # shellcheck disable=SC2086 # deliberate word splitting of the file list
  set -- $FILES
  TARGET=$(sh "$CHECK" --print-latest "$1")
fi

# Validated BEFORE anything is written. A target like "latest" or "main" would
# otherwise be written into a download URL that 404s at image build time, which
# is a much later and much more confusing failure than this one.
case "$TARGET" in
  v[0-9]*.[0-9]*) ;;
  *) die "not a vMAJOR.MINOR.PATCH node-agent version: '$TARGET'" ;;
esac

# Every file is read and compared before any of them is written, so a bad file
# late in the list cannot leave the pair half-bumped — the state the guard
# fails on.
# shellcheck disable=SC2086 # deliberate word splitting of the file list
for file in $FILES; do
  pin=$(pin_in "$file")
  sh "$CHECK" --compare "$pin" "$TARGET" >/dev/null
done

# ── The bump ─────────────────────────────────────────────────────────────────
CHANGED=0

# shellcheck disable=SC2086 # deliberate word splitting of the file list
for file in $FILES; do
  pin=$(pin_in "$file")
  rel=$(sh "$CHECK" --compare "$pin" "$TARGET")

  case "$rel" in
    same)
      echo "ok: $file already pins $TARGET"
      continue
      ;;
    newer)
      # Re-running the release workflow for an older tag must not walk the
      # fleet's Fly images backwards. Deliberately publishing an older release
      # is what publish-images.yml's node_agent_version input is for.
      echo "ok: $file pins $pin, which is ahead of $TARGET — left alone"
      continue
      ;;
  esac

  # Only the version token is replaced, so a trailing comment on the ARG line
  # survives. `sed -i` is not portable (BSD sed wants an argument), hence the
  # temp file.
  tmp="$file.bump.$$"
  sed 's|^\(ARG AGENTPOD_VERSION=\)[^ ]*\(.*\)$|\1'"$TARGET"'\2|' "$file" >"$tmp"
  mv "$tmp" "$file"

  # A sed that matched nothing would otherwise be reported as a successful
  # bump, and the guard would fail the next publish for a reason nobody could
  # see in this log.
  now=$(pin_in "$file")
  [ "$now" = "$TARGET" ] || die "$file still pins $now after the rewrite"

  echo "bumped: $file $pin -> $TARGET"
  CHANGED=1
done

echo "changed=$CHANGED"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "changed=$CHANGED" >>"$GITHUB_OUTPUT"
fi
exit 0

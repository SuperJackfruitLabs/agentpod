#!/bin/sh
# Stamps CHANGELOG.md for a release-prep PR: "## Unreleased" becomes "## vX.Y.Z — YYYY-MM-DD"
# and a fresh empty "## Unreleased" goes above it. The release workflow never commits to main;
# this change lands through an ordinary PR before the tag is pushed.
#
# Usage: prep-release.sh vX.Y.Z [CHANGELOG.md] [YYYY-MM-DD]
set -eu
version=${1:?usage: prep-release.sh vX.Y.Z [CHANGELOG.md] [YYYY-MM-DD]}
file=${2:-CHANGELOG.md}
date=${3:-$(date -u +%Y-%m-%d)}
echo "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
  { echo "not a release version: $version (want vX.Y.Z)" >&2; exit 1; }
[ -f "$file" ] || { echo "no $file" >&2; exit 1; }
grep -Eq "^## $version( |$)" "$file" && { echo "$file already has $version" >&2; exit 1; }
grep -q '^## Unreleased[[:space:]]*$' "$file" || { echo "$file has no '## Unreleased' section" >&2; exit 1; }
tmp=$(mktemp)
awk -v v="$version" -v d="$date" '
  !done && /^## Unreleased[[:space:]]*$/ { print "## Unreleased"; print ""; print "## " v " — " d; done = 1; next }
  { print }
' "$file" > "$tmp"
mv "$tmp" "$file"
echo "stamped $file: $version — $date"

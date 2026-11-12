#!/bin/sh
# Helpers for the shared release workflow, one subcommand each, so the workflow stays short and
# each piece can be tested on its own (the kit's scripts.test.sh).
#
#   kit.sh secrets <release-config.json>
#       Exports the secrets the config names in "secrets" to the following steps of the job
#       ($GITHUB_ENV). Reads every secret, as JSON, from KIT_SECRETS (the workflow passes
#       toJSON(secrets)) and exports only the named ones. A named secret that is not set fails.
#   kit.sh material <tag> <dir>
#       Writes the summary's material for <tag> into <dir>: changelog-section.md (the tag's
#       section of CHANGELOG.md, or main's when the tag's file has none), commit-log.txt
#       (subjects since the previous v tag) and diff-stat.txt. Prints the previous v tag, if any.
#   kit.sh with-summary <body.md> <summary.md>
#       Prints <body.md> with its leading "## Summary" section replaced by <summary.md>, or with
#       one added at the top when it has none.
#   kit.sh checksums <dir>
#       Moves every file under <dir> to its top level (refusing two files with one name), then
#       writes <dir>/SHA256SUMS over them with bare file names, as installers expect. Prints
#       "files=true" or "files=false".
set -eu

die() { echo "::error::$*" >&2; exit 1; }

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  secrets)
    config=${1:?usage: kit.sh secrets <release-config.json>}
    names=$(jq -r '.secrets[]? // empty' "$config")
    [ -n "$names" ] || { echo "no named secrets"; exit 0; }
    out=${GITHUB_ENV:?GITHUB_ENV is not set}
    all=${KIT_SECRETS:-}
    [ -n "$all" ] || all='{}'
    for n in $names; do
      case "$n" in
        '' | [0-9]* | *[!A-Za-z0-9_]* | GITHUB_* | ACTIONS_* | RUNNER_*)
          die "release-config.json names '$n' as a secret; want a plain secret name" ;;
      esac
      v=$(printf '%s' "$all" | jq -r --arg n "$n" '.[$n] // empty')
      [ -n "$v" ] || die "the secret $n that release-config.json names is not set for this repository, its organisation or the job's environment"
      d="KIT_EOF_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
      { printf '%s<<%s\n' "$n" "$d"; printf '%s\n' "$v"; printf '%s\n' "$d"; } >> "$out"
      echo "exported $n"
    done
    ;;

  material)
    tag=${1:?usage: kit.sh material <tag> <dir>}
    dir=${2:?usage: kit.sh material <tag> <dir>}
    mkdir -p "$dir"
    section() {
      awk -v v="$tag" '
        $0 ~ "^## " v "( |$)" { on = 1; next }
        on && /^## / { exit }
        on { print }
      '
    }
    : > "$dir/changelog-section.md"
    for ref in "$tag" origin/main; do
      git show "$ref:CHANGELOG.md" 2>/dev/null | section > "$dir/changelog-section.md" || true
      grep -q '[^[:space:]]' "$dir/changelog-section.md" && break
      : > "$dir/changelog-section.md"
    done
    prev=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$tag^" 2>/dev/null || true)
    git log --no-merges --format='%s' "${prev:+$prev..}$tag" > "$dir/commit-log.txt"
    base=${prev:-$(git rev-list --max-parents=0 "$tag" | tail -1)}
    git diff --stat "$base" "$tag" | tail -40 > "$dir/diff-stat.txt"
    echo "$prev"
    ;;

  with-summary)
    body=${1:?usage: kit.sh with-summary <body.md> <summary.md>}
    summary=${2:?usage: kit.sh with-summary <body.md> <summary.md>}
    [ -s "$summary" ] || die "the summary is empty"
    printf '## Summary\n\n%s\n\n' "$(cat "$summary")"
    # Drop leading blank lines, then a leading Summary section up to the next section or rule.
    awk '
      !started && /^[[:space:]]*$/ { next }
      !started { started = 1; if ($0 ~ /^## Summary[[:space:]]*$/) { skip = 1; next } }
      skip && (/^## / || /^---[[:space:]]*$/) { skip = 0 }
      skip { next }
      { print }
    ' "$body"
    ;;

  checksums)
    dir=${1:?usage: kit.sh checksums <dir>}
    mkdir -p "$dir"
    rm -f "$dir/SHA256SUMS"
    find "$dir" -mindepth 2 -type f | sort > "$dir/.kit-nested"
    while IFS= read -r f; do
      b=$(basename "$f")
      [ ! -e "$dir/$b" ] || die "two release files are named $b"
      mv "$f" "$dir/$b"
    done < "$dir/.kit-nested"
    rm -f "$dir/.kit-nested"
    find "$dir" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
    rm -f "$dir/SHA256SUMS"
    if [ -z "$(ls -A "$dir")" ]; then echo "files=false"; exit 0; fi
    sum=sha256sum
    command -v sha256sum >/dev/null 2>&1 || sum='shasum -a 256'
    sums=$(mktemp)
    # $sum is a command and its flag, split on purpose.
    # shellcheck disable=SC2086
    (cd "$dir" && find . -maxdepth 1 -type f | sed 's|^\./||' | LC_ALL=C sort |
      tr '\n' '\0' | xargs -0 $sum > "$sums")
    mv "$sums" "$dir/SHA256SUMS"
    chmod 644 "$dir/SHA256SUMS"
    echo "files=true"
    ;;

  *)
    echo "usage: kit.sh secrets|material|with-summary|checksums ..." >&2
    exit 2
    ;;
esac

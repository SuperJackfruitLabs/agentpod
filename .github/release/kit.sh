#!/bin/sh
# Helpers for the shared release workflow, one subcommand each, so the workflow stays short and
# each piece can be tested on its own (the kit's scripts.test.sh).
#
#   kit.sh config <release-config.json>
#       Validates the config and the product's hook scripts next to it (<dir>/release/, so
#       .github/release/ for .github/release-config.json), and writes the gate's outputs
#       ($GITHUB_OUTPUT): product, publish, publish_after_release, publish_environment, go_mod.
#       Refuses a config that still carries a command or script path (see old-keys).
#   kit.sh old-keys <release-config.json>
#       Prints one line per key that named a command or a script path, with the hook file that
#       replaces it, and exits 1 when there is any. Hooks live at fixed paths, and the workflow
#       never runs a string read out of the config.
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

# Each key that used to hold a command or a script path, and the fixed hook file replacing it.
old_keys() {
  jq -r '
    def obj(k): (.[k] | type) == "object";
    [ (select(.check != null) | "check: move the command into .github/release/check.sh"),
      (select(obj("ci") and .ci.check_command != null) | "ci.check_command: move the command into .github/release/ci-check.sh"),
      (select(.build_command != null) | "build_command: move the command into .github/release/build.sh"),
      (select(.build_at_tag != null) | "build_at_tag: remove it; a .github/release/build.sh file means build at the tag"),
      (select(obj("publish") and .publish.script != null) | "publish.script: run that script from .github/release/publish.sh"),
      (select((.deploy | type) == "string") | "deploy (a script path): run that script from .github/release/deploy.sh"),
      (select(obj("smoke") and .smoke.script != null) | "smoke.script: run that script from .github/release/smoke.sh"),
      (select((.rollback | type) == "string") | "rollback (a script path): run that script from .github/release/rollback.sh")
    ] | .[]' "$1"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  old-keys)
    config=${1:?usage: kit.sh old-keys <release-config.json>}
    old=$(old_keys "$config") || die "$config is not valid JSON"
    [ -z "$old" ] && exit 0
    printf '%s\n' "$old"
    exit 1
    ;;

  config)
    c=${1:?usage: kit.sh config <release-config.json>}
    [ -f "$c" ] || die "no $c"
    old=$(old_keys "$c") || die "$c is not valid JSON"
    if [ -n "$old" ]; then
      printf '::error::%s still names a command or a script; hooks are fixed files now:\n' "$c" >&2
      printf '%s\n' "$old" | sed 's/^/  /' >&2
      exit 1
    fi
    hooks=$(dirname "$c")/release
    has() { [ -f "$hooks/$1" ]; }
    jq -e '.product' "$c" >/dev/null || die "release-config.json needs product"
    if ! jq -e '.ci_workflow or .ci.forge' "$c" >/dev/null && ! has ci-check.sh; then
      die "release-config.json needs ci_workflow or ci.forge, or a $hooks/ci-check.sh"
    fi
    if jq -e '.artifact' "$c" >/dev/null; then
      jq -e '.ci_workflow' "$c" >/dev/null || die "artifact needs ci_workflow: only a GitHub CI run uploads builds"
      ! has build.sh || die "artifact ships main CI's build, so $hooks/build.sh would never run; keep one"
    fi
    if jq -e '.publish' "$c" >/dev/null; then
      jq -e '.publish.environment' "$c" >/dev/null || die "publish needs environment"
      has publish.sh || die "publish needs $hooks/publish.sh"
    fi
    if jq -e '.secrets and ((.secrets | type) != "array" or any(.secrets[]; type != "string"))' "$c" >/dev/null; then
      die "secrets is a list of secret names"
    fi
    if has deploy.sh && jq -e '.deploy' "$c" >/dev/null; then die "deploy: $hooks/deploy.sh or deploy.ssh_command, not both"; fi
    if has rollback.sh && jq -e '.rollback' "$c" >/dev/null; then die "rollback: $hooks/rollback.sh or rollback.ssh_command, not both"; fi
    if has smoke.sh && jq -e '.smoke.url' "$c" >/dev/null; then die "smoke: $hooks/smoke.sh or smoke.url, not both"; fi
    go=$(jq -r '.go_mod // empty' "$c")
    if [ -n "$go" ]; then [ -f "$go" ] || die "go_mod $go does not exist"
    elif [ -f go.mod ]; then go=go.mod; fi
    {
      echo "product=$(jq -r .product "$c")"
      echo "publish=$(jq -r 'if .publish then "true" else "false" end' "$c")"
      echo "publish_after_release=$(jq -r '.publish.after_release // false' "$c")"
      echo "publish_environment=$(jq -r '.publish.environment // empty' "$c")"
      echo "go_mod=$go"
    } >> "${GITHUB_OUTPUT:-/dev/null}"
    for h in ci-check check build publish deploy smoke rollback; do has "$h.sh" && echo "hook: $hooks/$h.sh"; done
    exit 0
    ;;

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
    echo "usage: kit.sh config|old-keys|secrets|material|with-summary|checksums ..." >&2
    exit 2
    ;;
esac

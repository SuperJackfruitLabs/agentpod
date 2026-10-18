#!/usr/bin/env bash
# forge-api-acceptance.sh - helper for the live forge API access acceptance run.
# Runbook: apps/hub/tests/integration/forge-api-live.md
#
# Read-only subcommands: preflight, residue, token-absence, audit, old-token-401.
# The ONE write: file-issue (Step 5), which needs BOTH --write and
# --yes-i-have-operator-approval, plus a typed confirmation on a terminal.
#
# Secrets: this script never prints, logs or passes a secret on a command line.
#   - token values come from an environment variable or a file descriptor the
#     operator provides, and are handed to curl/grep through stdin or a
#     process-substitution descriptor, never argv;
#   - output is limited to file names, counts and HTTP status codes;
#   - there is no shell tracing anywhere in this file.
#
# Usage:
#   forge-api-acceptance.sh [options] preflight
#   forge-api-acceptance.sh [options] residue <station>
#   forge-api-acceptance.sh [options] token-absence <station>
#   forge-api-acceptance.sh [options] audit <station>
#   forge-api-acceptance.sh [options] old-token-401
#   forge-api-acceptance.sh [options] file-issue <station>     (needs --write ...)
#
# Options:
#   --dry-run                  print the commands with placeholders, run nothing
#   --ssh HOST                 run node-side commands over ssh (default: locally)
#   --instance NAME            the station's stk instance (stk-<slug>-<hash>); default: looked
#                              up in the node registry with jq
#   --token-fd N               token-absence: read the real token value from descriptor N
#   --target PATH              token-absence: a local file or directory to search (repeatable)
#   --node-target PATH         token-absence: a path on the node to search (repeatable)
#   --url URL                  old-token-401: URL to call (default $FORGE_URL/api/v1/user)
#   --rule ID                  audit: only show rows containing this rule id
#   --tail N                   audit: how many rows (default 40)
#   --repo OWNER/NAME          file-issue: scratch or Supertoolkit repository
#   --title-file F --body-file F   file-issue: the approved issue text (files, not flags)
#   --write                    allow the write subcommand
#   --yes-i-have-operator-approval   the operator's explicit go-ahead for Step 5
#
# Environment (names only; values are never shown):
#   AGENTPOD_ACCEPT_TOKEN       token-absence: the real token value (alternative to --token-fd)
#   AGENTPOD_ACCEPT_OLD_TOKEN   old-token-401: the token that was revoked or rotated away
#   AGENTPOD_ACCEPT_AUTH_SCHEME `token` (default, Forgejo documented) or `bearer`
#   AGENTPOD_ACCEPT_STATE_ROOT / _CONFIG_ROOT / _RUNTIME_ROOT   default /var/lib, /etc, /run
#   AGENTPOD_ACCEPT_REGISTRY    default /var/lib/agentpod/forge-api/stk-instances.json
#   AGENTPOD_ACCEPT_HARNESS_ENV_ROOT  default /var/lib/agentpod/forge-api/harness-env
#   AGENTPOD_ACCEPT_AGENT_SHELL file-issue: command prefix that runs a shell inside the
#                               station agent's brokered environment
#   AGENTPOD_ACCEPT_ENV_VAR     file-issue: the grant's token variable (default FORGEJO_TOKEN)
#   AGENTPOD_ACCEPT_EXPECT_LOGIN file-issue: the account the issue must be authored by
#   FORGE_URL                   the forge origin

set -euo pipefail

DRY=0
SSH_HOST=""
INSTANCE=""
TOKEN_FD=""
URL=""
RULE=""
TAIL=40
REPO=""
TITLE_FILE=""
BODY_FILE=""
WRITE=0
APPROVED=0
TARGETS=()
NODE_TARGETS=()
POS=()

STATE_ROOT="${AGENTPOD_ACCEPT_STATE_ROOT:-/var/lib}"
CONFIG_ROOT="${AGENTPOD_ACCEPT_CONFIG_ROOT:-/etc}"
RUNTIME_ROOT="${AGENTPOD_ACCEPT_RUNTIME_ROOT:-/run}"
REGISTRY="${AGENTPOD_ACCEPT_REGISTRY:-/var/lib/agentpod/forge-api/stk-instances.json}"
HARNESS_ENV_ROOT="${AGENTPOD_ACCEPT_HARNESS_ENV_ROOT:-/var/lib/agentpod/forge-api/harness-env}"

die() { printf 'forge-api-acceptance: %s\n' "$*" >&2; exit 2; }
say() { printf '%s\n' "$*"; }

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }

need_arg() { [ "$#" -ge 2 ] || die "$1 needs a value"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --ssh) need_arg "$@"; SSH_HOST="$2"; shift ;;
    --instance) need_arg "$@"; INSTANCE="$2"; shift ;;
    --token-fd) need_arg "$@"; TOKEN_FD="$2"; shift ;;
    --target) need_arg "$@"; TARGETS+=("$2"); shift ;;
    --node-target) need_arg "$@"; NODE_TARGETS+=("$2"); shift ;;
    --url) need_arg "$@"; URL="$2"; shift ;;
    --rule) need_arg "$@"; RULE="$2"; shift ;;
    --tail) need_arg "$@"; TAIL="$2"; shift ;;
    --repo) need_arg "$@"; REPO="$2"; shift ;;
    --title-file) need_arg "$@"; TITLE_FILE="$2"; shift ;;
    --body-file) need_arg "$@"; BODY_FILE="$2"; shift ;;
    --write) WRITE=1 ;;
    --yes-i-have-operator-approval) APPROVED=1 ;;
    -h|--help|help) usage; exit 0 ;;
    --) shift; while [ "$#" -gt 0 ]; do POS+=("$1"); shift; done; break ;;
    -*) die "unknown option: $1" ;;
    *) POS+=("$1") ;;
  esac
  shift
done

[ "${#POS[@]}" -ge 1 ] || { usage >&2; exit 2; }
CMD="${POS[0]}"
STATION="${POS[1]:-}"

valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; }
valid_instance() { [[ "$1" =~ ^stk-[a-z0-9-]{1,12}-[0-9a-f]{6,14}$ ]]; }
valid_path() { [[ "$1" =~ ^[A-Za-z0-9._/@:+=,-]+$ ]]; }

if [ -n "$SSH_HOST" ]; then
  [[ "$SSH_HOST" =~ ^[A-Za-z0-9._@:-]+$ ]] || die "--ssh host has unexpected characters"
  case "$SSH_HOST" in -*) die "--ssh host must not start with '-'" ;; esac
fi

where() { if [ -n "$SSH_HOST" ]; then printf 'ssh %s' "$SSH_HOST"; else printf 'local'; fi; }

# run_node CMDSTRING [STDIN-FILE]: run a command string on the node. The string never carries a
# secret. Stdin (if a file is named) is how the one secret that crosses to the node, the search
# pattern of token-absence, travels.
run_node() {
  local cmd="$1" stdin_src="${2:-}"
  if [ "$DRY" = 1 ]; then
    say "[dry-run] on $(where): $cmd"
    return 0
  fi
  if [ -n "$SSH_HOST" ]; then
    if [ -n "$stdin_src" ]; then
      ssh -o BatchMode=yes -- "$SSH_HOST" "$cmd" <"$stdin_src"
    else
      ssh -o BatchMode=yes -- "$SSH_HOST" "$cmd" </dev/null
    fi
  else
    if [ -n "$stdin_src" ]; then
      bash -c "$cmd" <"$stdin_src"
    else
      bash -c "$cmd" </dev/null
    fi
  fi
}

# resolve_instance: sets INSTANCE from --instance or the node registry.
resolve_instance() {
  valid_name "$STATION" || die "a station id is required (letters, digits, . _ : -)"
  if [ -n "$INSTANCE" ]; then
    valid_instance "$INSTANCE" || die "--instance must look like stk-<slug>-<hash>"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    INSTANCE="stk-<slug>-<hash>"
    say "[dry-run] would look up the instance of station $STATION in $REGISTRY with jq (or pass --instance)"
    return 0
  fi
  local out
  out="$(run_node "jq -r --arg s '$STATION' '.instances[]|select(.station==\$s)|.name' '$REGISTRY'" 2>/dev/null || true)"
  out="${out%%$'\n'*}"
  if [ -z "$out" ]; then
    say "no registry record for station $STATION in $REGISTRY (jq missing, or no instance): pass --instance NAME"
    return 3
  fi
  valid_instance "$out" || die "registry returned an unexpected instance name"
  INSTANCE="$out"
}

stk_env_prefix() {
  # The instance's own environment, exactly as its unit sets it.
  printf 'STK_HOME=%s/%s STK_CONFIG=%s/%s/supertoolkit.yaml STK_SOCKET=%s/%s/stk.sock' \
    "$STATE_ROOT" "$INSTANCE" "$CONFIG_ROOT" "$INSTANCE" "$RUNTIME_ROOT" "$INSTANCE"
}

# ---------------------------------------------------------------------------- preflight
cmd_preflight() {
  local fail=0 t
  if [ "$DRY" = 1 ]; then
    say "[dry-run] would check tools: curl grep ssh jq fleet tea stk (stk and fleet are informational here)"
    say "[dry-run] would check environment variables are set or unset (never their values): FORGE_URL FORGE_ADMIN_TOKEN AGENTPOD_ACCEPT_TOKEN AGENTPOD_ACCEPT_OLD_TOKEN AGENTPOD_ACCEPT_AGENT_SHELL"
    return 0
  fi
  for t in curl grep; do
    if command -v "$t" >/dev/null 2>&1; then say "tool    $t: present"; else say "tool    $t: MISSING (required)"; fail=1; fi
  done
  for t in ssh jq fleet tea stk; do
    if command -v "$t" >/dev/null 2>&1; then say "tool    $t: present"; else say "tool    $t: absent (needed only for some steps; see the runbook)"; fi
  done
  local v
  for v in FORGE_URL FORGE_ADMIN_TOKEN AGENTPOD_ACCEPT_TOKEN AGENTPOD_ACCEPT_OLD_TOKEN AGENTPOD_ACCEPT_AGENT_SHELL AGENTPOD_ACCEPT_EXPECT_LOGIN; do
    if [ -n "${!v:-}" ]; then say "env     $v: set"; else say "env     $v: unset"; fi
  done
  say "note    FORGE_URL / FORGE_ADMIN_TOKEN are the HUB's settings; unset here is fine if this runs off the hub host."
  if [ "$fail" = 1 ]; then say "preflight: FAILED"; return 1; fi
  say "preflight: ok"
}

# ---------------------------------------------------------------------------- residue
cmd_residue() {
  resolve_instance || return $?
  local n="$INSTANCE"
  say "residue check for station $STATION, instance $n, on $(where)"
  say "Expected AFTER the station's last grant is revoked: policy has no services entry for the grant,"
  say "no credential, no harness env file or drop-in. The instance itself stays until the station is pruned."
  run_node "echo '--- policy file (service names only):'; grep -E '^  [A-Za-z0-9_.-]+:\$' '$CONFIG_ROOT/$n/supertoolkit.yaml' || echo '(none)'"
  run_node "echo '--- state dir listing (names, sizes; never contents):'; ls -la '$STATE_ROOT/$n' 2>&1 | grep -E '\\.cred|audit.log|proxy.key|handover.key|total' || echo '(no matching files)'"
  run_node "echo '--- credentials count:'; find '$STATE_ROOT/$n' -maxdepth 2 -name '*.cred' 2>/dev/null | wc -l"
  run_node "echo '--- harness env files:'; ls -la '$HARNESS_ENV_ROOT/$n' 2>&1 || true"
  run_node "echo '--- unit drop-ins named 90-agentpod-forge.conf (system and every user):'; find /etc/systemd /home /root -name '90-agentpod-forge.conf' 2>/dev/null || true"
  run_node "echo '--- unit state:'; systemctl is-active '$n' 2>&1 || true"
  say "Interpret by hand using the runbook (Step 2): this command lists, it does not decide."
}

# ---------------------------------------------------------------------------- token-absence
read_token_into_file() {
  # $1 = destination file (mode 0600, in a private temp dir). The value is never printed.
  local dest="$1" val=""
  if [ -n "$TOKEN_FD" ]; then
    [[ "$TOKEN_FD" =~ ^[0-9]+$ ]] || die "--token-fd needs a descriptor number"
    [ "$TOKEN_FD" -gt 2 ] || die "--token-fd must be 3 or higher"
    val="$(cat <&"$TOKEN_FD")" || die "could not read descriptor $TOKEN_FD"
  elif [ -n "${AGENTPOD_ACCEPT_TOKEN:-}" ]; then
    val="$AGENTPOD_ACCEPT_TOKEN"
  else
    die "no token provided: set AGENTPOD_ACCEPT_TOKEN or pass --token-fd N"
  fi
  [ -n "$val" ] || die "the token value is empty (an empty pattern would match everything)"
  [ "${#val}" -ge 8 ] || die "the token value is shorter than 8 characters; refusing a pattern that would match noise"
  ( umask 077; printf '%s\n' "$val" >"$dest" )
}

cmd_token_absence() {
  valid_name "$STATION" || die "a station id is required"
  if [ "${#TARGETS[@]}" -eq 0 ] && [ "${#NODE_TARGETS[@]}" -eq 0 ]; then
    die "give at least one --target PATH (local) or --node-target PATH (on the node)"
  fi
  local p
  for p in "${TARGETS[@]+"${TARGETS[@]}"}" "${NODE_TARGETS[@]+"${NODE_TARGETS[@]}"}"; do
    valid_path "$p" || die "unsupported characters in path: $p"
  done
  if [ "$DRY" = 1 ]; then
    for p in "${TARGETS[@]+"${TARGETS[@]}"}"; do
      say "[dry-run] local: grep -rIFc -f <(<TOKEN from \$AGENTPOD_ACCEPT_TOKEN or fd>) -- $p   (prints file:count, drops zero counts)"
    done
    for p in "${NODE_TARGETS[@]+"${NODE_TARGETS[@]}"}"; do
      say "[dry-run] on $(where): grep -rIFc -f /dev/stdin -- $p   (pattern on stdin; prints file:count, drops zero counts)"
    done
    return 0
  fi
  local dir tokfile hits=0 out
  dir="$(umask 077; mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$dir'" EXIT
  tokfile="$dir/pattern"
  read_token_into_file "$tokfile"
  for p in "${TARGETS[@]+"${TARGETS[@]}"}"; do
    [ -e "$p" ] || { say "MISSING   $p (does not exist)"; continue; }
    # -c prints only "file:count" (or a bare count for a single file); no matching line is printed.
    out="$(grep -rIFc -f "$tokfile" -- "$p" 2>/dev/null || true)"
    hits=$((hits + $(report_counts "local" "$p" "$out")))
  done
  for p in "${NODE_TARGETS[@]+"${NODE_TARGETS[@]}"}"; do
    out="$(run_node "grep -rIFc -f /dev/stdin -- '$p' 2>/dev/null || true" "$tokfile")"
    hits=$((hits + $(report_counts "node" "$p" "$out")))
  done
  if [ "$hits" -gt 0 ]; then
    say "token-absence: FOUND in $hits file(s). Treat the token as exposed: rotate it, then file a defect."
    return 1
  fi
  say "token-absence: the token value was not found in any searched file (text files only; binary files are skipped by -I)."
}

# report_counts SCOPE TARGET OUTPUT: prints the number of files with a hit on stdout (callers
# capture it); the human lines (file name and count only) go to stderr.
report_counts() {
  local scope="$1" target="$2" out="$3" line n files=0 shown=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [[ "$line" == *:* ]]; then n="${line##*:}"; line="${line%:*}"; else n="$line"; line="$target"; fi
    [[ "$n" =~ ^[0-9]+$ ]] || continue
    if [ "$n" -gt 0 ]; then
      files=$((files + 1))
      shown+="HIT  [$scope] $line: $n occurrence(s)"$'\n'
    fi
  done <<<"$out"
  [ -z "$shown" ] || printf '%s' "$shown" >&2
  printf '%s' "$files"
}

# ---------------------------------------------------------------------------- audit
cmd_audit() {
  resolve_instance || return $?
  local cmd
  [[ "$TAIL" =~ ^[0-9]{1,4}$ ]] || die "--tail needs a number"
  cmd="sudo -u '$INSTANCE' env $(stk_env_prefix) stk audit"
  if [ -n "$RULE" ]; then
    [[ "$RULE" =~ ^[A-Za-z0-9._:/-]{1,80}$ ]] || die "--rule has unexpected characters"
    cmd="$cmd | grep -F -- '$RULE'"
  fi
  say "audit rows for station $STATION (instance $INSTANCE), last $TAIL; look for the rule id on a denied request"
  run_node "$cmd | tail -n $TAIL"
}

# ---------------------------------------------------------------------------- old-token-401
cmd_old_token_401() {
  local scheme="${AGENTPOD_ACCEPT_AUTH_SCHEME:-token}" target
  target="${URL:-${FORGE_URL:-}/api/v1/user}"
  case "$scheme" in token|bearer) ;; *) die "AGENTPOD_ACCEPT_AUTH_SCHEME must be token or bearer" ;; esac
  [ -n "$target" ] && [ "$target" != "/api/v1/user" ] || die "set FORGE_URL or pass --url"
  [[ "$target" =~ ^https?://[A-Za-z0-9._:/@%+-]+$ ]] || die "--url has unexpected characters"
  if [ "$DRY" = 1 ]; then
    say "[dry-run] curl -sS -o /dev/null -w '%{http_code}' -K - '$target'   (config on stdin: header = \"Authorization: $scheme <OLD-TOKEN from \$AGENTPOD_ACCEPT_OLD_TOKEN>\")"
    return 0
  fi
  local tok="${AGENTPOD_ACCEPT_OLD_TOKEN:-}" word code
  [ -n "$tok" ] || die "set AGENTPOD_ACCEPT_OLD_TOKEN (the revoked or rotated-away token)"
  case "$tok" in *\"*|*\\*|*$'\n'*|*$'\r'*) die "the token has a character this helper will not put in a curl config" ;; esac
  if [ "$scheme" = bearer ]; then word="Bearer"; else word="token"; fi
  # The header travels on stdin as a curl config, so it is not in argv or the process table.
  code="$(printf 'header = "Authorization: %s %s"\n' "$word" "$tok" | curl -sS -o /dev/null -w '%{http_code}' -K - -- "$target" 2>/dev/null || true)"
  [[ "$code" =~ ^[0-9]{3}$ ]] || code="000"
  say "HTTP status with the old token: $code"
  case "$code" in
    401) say "old-token-401: PASS (the provider no longer accepts it)" ;;
    000) say "old-token-401: INCONCLUSIVE (no HTTP response; check the URL and network)"; return 3 ;;
    *)   say "old-token-401: FAIL (expected 401). Record the status and treat the token as still live."; return 1 ;;
  esac
}

# ---------------------------------------------------------------------------- file-issue (the one write)
cmd_file_issue() {
  valid_name "$STATION" || die "a station id is required"
  if [ "$WRITE" != 1 ]; then die "file-issue is a WRITE: it needs --write"; fi
  if [ "$APPROVED" != 1 ]; then die "file-issue needs --yes-i-have-operator-approval (the operator's explicit go-ahead for Step 5)"; fi
  [[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "--repo OWNER/NAME is required"
  [ -n "$TITLE_FILE" ] && [ -r "$TITLE_FILE" ] || die "--title-file must name a readable file"
  [ -n "$BODY_FILE" ] && [ -r "$BODY_FILE" ] || die "--body-file must name a readable file"
  local shell_cmd="${AGENTPOD_ACCEPT_AGENT_SHELL:-}" var="${AGENTPOD_ACCEPT_ENV_VAR:-FORGEJO_TOKEN}"
  local login="${AGENTPOD_ACCEPT_EXPECT_LOGIN:-}" forge="${FORGE_URL:-}"
  [ -n "$shell_cmd" ] || die "set AGENTPOD_ACCEPT_AGENT_SHELL (a command prefix that runs a shell in the station agent's brokered environment). No other account's credential is ever used as a fallback."
  [[ "$var" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] || die "AGENTPOD_ACCEPT_ENV_VAR must look like FORGEJO_TOKEN"
  [ -n "$login" ] || die "set AGENTPOD_ACCEPT_EXPECT_LOGIN (the account the issue must be authored by)"
  [ -n "$forge" ] || die "set FORGE_URL"
  command -v jq >/dev/null 2>&1 || die "jq is required to build and read back the issue"
  local scheme="${AGENTPOD_ACCEPT_AUTH_SCHEME:-token}" word
  case "$scheme" in token) word=token ;; bearer) word=Bearer ;; *) die "AGENTPOD_ACCEPT_AUTH_SCHEME must be token or bearer" ;; esac

  local api="$forge/api/v1/repos/$REPO/issues" payload
  payload="$(jq -n --rawfile t "$TITLE_FILE" --rawfile b "$BODY_FILE" '{title: ($t|rtrimstr("\n")), body: $b}')"
  # The remote script reads the placeholder from the agent's own environment variable; the
  # broker swaps the real credential on the wire. Nothing secret is on this machine.
  local remote
  remote="curl -sS -X POST -H 'Content-Type: application/json' -H \"Authorization: $word \$$var\" --data-binary @- '$api'"

  if [ "$DRY" = 1 ]; then
    say "[dry-run] would file ONE issue in $REPO as the agent of station $STATION, through its broker:"
    say "[dry-run]   $shell_cmd sh -c \"curl -X POST -H 'Authorization: $word \$$var' --data-binary @- $api\"   (JSON from --title-file/--body-file on stdin)"
    say "[dry-run]   then GET the issue back and compare title, body and user.login ($login)"
    return 0
  fi

  say "ABOUT TO FILE ONE ISSUE in $REPO as station $STATION's agent ($login) via the broker."
  if [ -t 0 ]; then
    local reply
    printf 'Type FILE IT to proceed: ' >&2
    read -r reply
    [ "$reply" = "FILE IT" ] || { say "not confirmed; nothing was filed"; return 1; }
  else
    say "stdin is not a terminal: proceeding on the flags alone (--write and --yes-i-have-operator-approval)."
  fi

  local resp num
  # shellcheck disable=SC2086
  resp="$(printf '%s' "$payload" | $shell_cmd sh -c "$remote")" || die "the filing request failed (nothing is retried, and no other credential is tried)"
  num="$(printf '%s' "$resp" | jq -r '.number // empty')"
  [ -n "$num" ] || die "the forge did not return an issue number; the response was not an issue (not printed)"
  say "filed issue number $num; reading it back"
  local back
  # shellcheck disable=SC2086
  back="$($shell_cmd sh -c "curl -sS -H \"Authorization: $word \$$var\" '$api/$num'")" || die "read-back failed"
  local want_t want_b got_t got_b got_u ok=1
  want_t="$(jq -r '.title' <<<"$payload")"; want_b="$(jq -r '.body' <<<"$payload")"
  got_t="$(jq -r '.title // empty' <<<"$back")"; got_b="$(jq -r '.body // empty' <<<"$back")"
  got_u="$(jq -r '.user.login // empty' <<<"$back")"
  if [ "$got_t" = "$want_t" ]; then say "title:  matches"; else say "title:  DIFFERS"; ok=0; fi
  if [ "$got_b" = "$want_b" ]; then say "body:   matches"; else say "body:   DIFFERS"; ok=0; fi
  if [ "$got_u" = "$login" ]; then say "author: $got_u (expected)"; else say "author: '$got_u' DIFFERS from expected '$login'"; ok=0; fi
  [ "$ok" = 1 ] || return 1
  say "file-issue: PASS (issue $num in $REPO)"
}

case "$CMD" in
  preflight) cmd_preflight ;;
  residue) cmd_residue ;;
  token-absence) cmd_token_absence ;;
  audit) cmd_audit ;;
  old-token-401) cmd_old_token_401 ;;
  file-issue) cmd_file_issue ;;
  *) die "unknown subcommand: $CMD (preflight, residue, token-absence, audit, old-token-401, file-issue)" ;;
esac

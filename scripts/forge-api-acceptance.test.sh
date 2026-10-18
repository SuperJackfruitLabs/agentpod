#!/usr/bin/env bash
# Tests for forge-api-acceptance.sh. Plain bash, no bats. Stubs for curl, ssh and a recording
# grep wrapper sit first on PATH. The "secret" below is fake and unique, so a leak is detectable.
# shellcheck disable=SC2319
set -uo pipefail
exec </dev/null

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/forge-api-acceptance.sh"
REAL_GREP="$(command -v grep)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"; mkdir -p "$BIN"
LOG="$WORK/argv.log"; : >"$LOG"
SECRET="s3cr3t-TOKEN-0123456789abcdef"
FAIL=0; N=0

pass() { N=$((N + 1)); printf 'ok   %s\n' "$1"; }
fail() { N=$((N + 1)); FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
check() { # name, condition-exit-status
  if [ "$2" = 0 ]; then pass "$1"; else fail "$1"; fi
}

# curl stub: records argv (one arg per line) and stdin separately; answers CURL_CODE.
cat >"$BIN/curl" <<EOF
#!/usr/bin/env bash
{ echo "curl"; for a in "\$@"; do echo "  arg: \$a"; done; } >>"$LOG"
cat >"$WORK/curl.stdin" 2>/dev/null || true
if [ -n "\${CURL_BODY:-}" ]; then printf '%s' "\$CURL_BODY"; else printf '%s' "\${CURL_CODE:-401}"; fi
EOF
# ssh stub: records argv, runs nothing.
cat >"$BIN/ssh" <<EOF
#!/usr/bin/env bash
{ echo "ssh"; for a in "\$@"; do echo "  arg: \$a"; done; } >>"$LOG"
cat >"$WORK/ssh.stdin" 2>/dev/null || true
echo "(stub ssh output)"
EOF
# grep wrapper: records argv then runs the real grep.
cat >"$BIN/grep" <<EOF
#!/usr/bin/env bash
{ echo "grep"; for a in "\$@"; do echo "  arg: \$a"; done; } >>"$LOG"
exec "$REAL_GREP" "\$@"
EOF
chmod +x "$BIN/curl" "$BIN/ssh" "$BIN/grep"

run() { PATH="$BIN:$PATH" "$SCRIPT" "$@"; }
no_secret() { # file
  ! "$REAL_GREP" -qF -- "$SECRET" "$1"
}

# 1. syntax and no tracing
bash -n "$SCRIPT"; check "bash -n clean" $?
"$REAL_GREP" -nE '(^|[[:space:];])set +-[a-z]*x|xtrace|BASH_XTRACEFD|bash +-x' "$SCRIPT" >/dev/null; r=$?
[ "$r" = 1 ]; check "no set -x / xtrace anywhere in the script" $?
"$REAL_GREP" -q '^set -euo pipefail' "$SCRIPT"; check "set -euo pipefail present" $?

# 2. dry-run prints placeholders, runs nothing, and leaks nothing
: >"$LOG"
out="$(AGENTPOD_ACCEPT_OLD_TOKEN="$SECRET" AGENTPOD_ACCEPT_TOKEN="$SECRET" FORGE_URL=https://forge.example \
  run --dry-run old-token-401 2>&1)"
echo "$out" | "$REAL_GREP" -q '<OLD-TOKEN'; check "dry-run old-token-401 shows a placeholder" $?
echo "$out" | "$REAL_GREP" -qF -- "$SECRET"; [ $? = 1 ]; check "dry-run old-token-401 output has no secret" $?
[ ! -s "$LOG" ]; check "dry-run old-token-401 executed nothing" $?

: >"$LOG"
out="$(AGENTPOD_ACCEPT_TOKEN="$SECRET" run --dry-run --ssh node1 --node-target /var/log/agentpod --target "$WORK" token-absence st1 2>&1)"
echo "$out" | "$REAL_GREP" -q 'TOKEN from'; check "dry-run token-absence shows a placeholder" $?
echo "$out" | "$REAL_GREP" -qF -- "$SECRET"; [ $? = 1 ]; check "dry-run token-absence output has no secret" $?
[ ! -s "$LOG" ]; check "dry-run token-absence executed nothing" $?

: >"$LOG"
out="$(run --dry-run --ssh node1 --instance stk-st1-abc123 residue st1 2>&1)"
echo "$out" | "$REAL_GREP" -q '\[dry-run\] on ssh node1'; check "dry-run residue prints the ssh commands" $?
echo "$out" | "$REAL_GREP" -q 'stk-st1-abc123/supertoolkit.yaml'; check "residue uses the documented policy path" $?
[ ! -s "$LOG" ]; check "dry-run residue executed nothing" $?

out="$(run --dry-run --instance stk-st1-abc123 --rule rule-17 audit st1 2>&1)"
echo "$out" | "$REAL_GREP" -q 'stk audit'; check "dry-run audit shows stk audit" $?
echo "$out" | "$REAL_GREP" -q 'STK_HOME=/var/lib/stk-st1-abc123'; check "audit runs with the instance's own STK_HOME" $?

# 3. old-token-401: only the status is printed; argv has no secret; header on stdin
: >"$LOG"; rm -f "$WORK/curl.stdin"
out="$(AGENTPOD_ACCEPT_OLD_TOKEN="$SECRET" FORGE_URL=https://forge.example CURL_CODE=401 run old-token-401 2>&1)"; rc=$?
[ "$rc" = 0 ]; check "old-token-401 exits 0 on 401" $?
echo "$out" | "$REAL_GREP" -q 'HTTP status with the old token: 401'; check "old-token-401 prints the status" $?
echo "$out" | "$REAL_GREP" -qF -- "$SECRET"; [ $? = 1 ]; check "old-token-401 output has no secret" $?
no_secret "$LOG"; check "curl argv has no secret" $?
"$REAL_GREP" -q -- '-K' "$LOG" && "$REAL_GREP" -qF -- 'arg: -' "$LOG"; check "curl uses -K - (config on stdin)" $?
"$REAL_GREP" -qF "Authorization: token $SECRET" "$WORK/curl.stdin"; check "the header reached curl on stdin only" $?
out="$(AGENTPOD_ACCEPT_OLD_TOKEN="$SECRET" FORGE_URL=https://forge.example CURL_CODE=200 run old-token-401 2>&1)"; rc=$?
[ "$rc" = 1 ]; check "old-token-401 exits 1 when the old token still works" $?
echo "$out" | "$REAL_GREP" -qF -- "$SECRET"; [ $? = 1 ]; check "old-token-401 FAIL output has no secret" $?
out="$(AGENTPOD_ACCEPT_OLD_TOKEN='bad"quote' FORGE_URL=https://forge.example run old-token-401 2>&1)"; rc=$?
[ "$rc" = 2 ]; check "old-token-401 refuses a token that would break the curl config" $?

# 4. token-absence: names and counts only, never the value or the matching line
mkdir -p "$WORK/logs"
printf 'clean line\n' >"$WORK/logs/clean.log"
printf 'prefix %s suffix\nanother\n%s\n' "$SECRET" "$SECRET" >"$WORK/logs/leaky.log"
: >"$LOG"
out="$(AGENTPOD_ACCEPT_TOKEN="$SECRET" run token-absence st1 --target "$WORK/logs" 2>&1)"; rc=$?
[ "$rc" = 1 ]; check "token-absence exits 1 when found" $?
echo "$out" | "$REAL_GREP" -q 'leaky.log: 2 occurrence'; check "token-absence reports file name and count" $?
echo "$out" | "$REAL_GREP" -q 'clean.log'; [ $? = 1 ]; check "token-absence does not list clean files" $?
echo "$out" | "$REAL_GREP" -qF -- "$SECRET"; [ $? = 1 ]; check "token-absence output never shows the value" $?
echo "$out" | "$REAL_GREP" -q 'prefix'; [ $? = 1 ]; check "token-absence never shows matching lines" $?
no_secret "$LOG"; check "grep argv has no secret" $?
rm "$WORK/logs/leaky.log"
out="$(AGENTPOD_ACCEPT_TOKEN="$SECRET" run token-absence st1 --target "$WORK/logs" 2>&1)"; rc=$?
[ "$rc" = 0 ]; check "token-absence exits 0 when absent" $?
exec 7<<<"$SECRET"
printf 'x %s\n' "$SECRET" >"$WORK/logs/fd.log"
out="$(run token-absence st1 --token-fd 7 --target "$WORK/logs" 2>&1 7<<<"$SECRET")"; rc=$?
[ "$rc" = 1 ]; check "token-absence accepts the value on a file descriptor" $?
echo "$out" | "$REAL_GREP" -qF -- "$SECRET"; [ $? = 1 ]; check "fd mode output never shows the value" $?
exec 7<&-
out="$(run token-absence st1 --target "$WORK/logs" 2>&1)"; rc=$?
[ "$rc" = 2 ]; check "token-absence refuses to run without a token" $?
: >"$LOG"; rm -f "$WORK/ssh.stdin"
out="$(AGENTPOD_ACCEPT_TOKEN="$SECRET" run --ssh node1 token-absence st1 --node-target /var/log/agentpod 2>&1)"; rc=$?
no_secret "$LOG"; check "ssh argv has no secret (pattern travels on stdin)" $?
"$REAL_GREP" -qF "$SECRET" "$WORK/ssh.stdin"; check "the pattern reached the node on stdin" $?
echo "$out" | "$REAL_GREP" -qF -- "$SECRET"; [ $? = 1 ]; check "node-side mode output never shows the value" $?

# 5. file-issue (the one write) refuses without both flags
out="$(run file-issue st1 --repo o/r --title-file "$WORK/logs/clean.log" --body-file "$WORK/logs/clean.log" 2>&1)"; rc=$?
[ "$rc" = 2 ]; check "file-issue refuses without --write" $?
out="$(run --write file-issue st1 --repo o/r --title-file "$WORK/logs/clean.log" --body-file "$WORK/logs/clean.log" 2>&1)"; rc=$?
[ "$rc" = 2 ]; check "file-issue refuses with --write but without the approval flag" $?
echo "$out" | "$REAL_GREP" -q 'operator-approval'; check "the refusal names the approval flag" $?
out="$(run --yes-i-have-operator-approval file-issue st1 --repo o/r --title-file "$WORK/logs/clean.log" --body-file "$WORK/logs/clean.log" 2>&1)"; rc=$?
[ "$rc" = 2 ]; check "file-issue refuses with the approval flag but without --write" $?
: >"$LOG"
out="$(run --write --yes-i-have-operator-approval file-issue st1 --repo o/r --title-file "$WORK/logs/clean.log" --body-file "$WORK/logs/clean.log" 2>&1)"; rc=$?
[ "$rc" = 2 ]; check "file-issue refuses without an agent shell (no fallback credential)" $?
echo "$out" | "$REAL_GREP" -q 'fallback'; check "the refusal says no fallback credential" $?
[ ! -s "$LOG" ]; check "refused file-issue made no request" $?
# approved path against stubs
printf 'Typed argument bug\n' >"$WORK/title"; printf 'Body text\n' >"$WORK/body"
cat >"$BIN/agent-shell" <<'EOF'
#!/usr/bin/env bash
exec "$@"
EOF
chmod +x "$BIN/agent-shell"
: >"$LOG"
out="$(AGENTPOD_ACCEPT_AGENT_SHELL=agent-shell AGENTPOD_ACCEPT_EXPECT_LOGIN=chotu FORGE_URL=https://forge.example \
  CURL_BODY='{"number":9,"title":"Typed argument bug","body":"Body text\n","user":{"login":"chotu"}}' \
  run --write --yes-i-have-operator-approval file-issue st1 --repo o/r --title-file "$WORK/title" --body-file "$WORK/body" 2>&1)"; rc=$?
[ "$rc" = 0 ]; check "approved file-issue passes against stubs (read-back matches)" $?
echo "$out" | "$REAL_GREP" -q 'author: chotu'; check "file-issue checks the author" $?
out="$(AGENTPOD_ACCEPT_AGENT_SHELL=agent-shell AGENTPOD_ACCEPT_EXPECT_LOGIN=chotu FORGE_URL=https://forge.example \
  CURL_BODY='{"number":9,"title":"Typed argument bug","body":"Body text\n","user":{"login":"someone-else"}}' \
  run --write --yes-i-have-operator-approval file-issue st1 --repo o/r --title-file "$WORK/title" --body-file "$WORK/body" 2>&1)"; rc=$?
[ "$rc" = 1 ]; check "file-issue fails when the author differs" $?
: >"$LOG"
out="$(AGENTPOD_ACCEPT_AGENT_SHELL=agent-shell AGENTPOD_ACCEPT_EXPECT_LOGIN=chotu FORGE_URL=https://forge.example \
  run --dry-run --write --yes-i-have-operator-approval file-issue st1 --repo o/r --title-file "$WORK/title" --body-file "$WORK/body" 2>&1)"
[ ! -s "$LOG" ]; check "dry-run file-issue makes no request" $?

: >"$LOG"
for bad in "https://forge.example';touch /tmp/pwned;'" 'https://forge.example $(id)' 'https://forge.example"x'; do
  out="$(AGENTPOD_ACCEPT_AGENT_SHELL=agent-shell AGENTPOD_ACCEPT_EXPECT_LOGIN=chotu FORGE_URL="$bad" \
    run --write --yes-i-have-operator-approval file-issue st1 --repo o/r --title-file "$WORK/title" --body-file "$WORK/body" 2>&1)"; rc=$?
  [ "$rc" = 2 ]; check "file-issue refuses a FORGE_URL with shell characters ($bad)" $?
done
[ ! -s "$LOG" ]; check "a bad FORGE_URL makes no request" $?

# 6. preflight never prints values
out="$(FORGE_ADMIN_TOKEN="$SECRET" AGENTPOD_ACCEPT_OLD_TOKEN="$SECRET" run preflight 2>&1)"
echo "$out" | "$REAL_GREP" -q 'FORGE_ADMIN_TOKEN: set'; check "preflight reports set/unset" $?
echo "$out" | "$REAL_GREP" -qF -- "$SECRET"; [ $? = 1 ]; check "preflight output has no secret" $?

# 7. whole log never saw the secret in argv; shellcheck when present
no_secret "$LOG"; check "no recorded argv contains the secret" $?
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$SCRIPT"; check "shellcheck clean" $?
else
  echo "skip shellcheck (not installed)"
fi

printf '\n%d checks, %d failed\n' "$N" "$FAIL"
[ "$FAIL" = 0 ]

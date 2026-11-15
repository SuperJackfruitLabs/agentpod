#!/bin/sh
# Exercise the real product build hook against a recording compiler. No installs,
# cross-built binaries, service changes or network calls occur in this fixture.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
trial=$(mktemp -d)
trap 'rm -rf "$trial"' EXIT HUP INT TERM
mkdir -p "$trial/bin" "$trial/apps/node-agent/scripts" "$trial/apps/node-agent/deploy" "$trial/deploy/release"
cp "$root/deploy/release/build.sh" "$trial/deploy/release/build.sh"
cp "$root/apps/node-agent/scripts/install.sh" "$root/apps/node-agent/scripts/install-fleet.sh" "$trial/apps/node-agent/scripts/"
cp "$root/apps/node-agent/deploy/agentpod-node.service" "$trial/apps/node-agent/deploy/"
cat > "$trial/bin/go" <<'GO'
#!/bin/sh
set -eu
[ "$1" = build ] && [ "${CGO_ENABLED:-}" = 0 ]
shift
output= flags= command= trimpath=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -ldflags) flags=$2; shift 2 ;;
    -trimpath) trimpath=true; shift ;;
    ./cmd/*) command=${1#./cmd/}; shift ;;
    *) echo 'unexpected build argument' >&2; exit 91 ;;
  esac
done
[ "$trimpath" = true ]
case "$flags" in *"-X main.version=$TAG"*) ;; *) exit 92 ;; esac
case "$command" in agentpod-node|agentpod-fleet|agentpod-bench-worker) ;; *) exit 93 ;; esac
[ "$output" = "dist/$command-$GOOS-$GOARCH" ]
printf '%s/%s %s\n' "$GOOS" "$GOARCH" "$command" >> "$BUILD_LOG"
if [ "${FAIL_TARGET:-}" = "$GOOS/$GOARCH" ] && [ "${FAIL_COMMAND:-}" = "$command" ]; then exit 17; fi
cat > "$output" <<PROGRAM
#!/bin/sh
[ "\$#" -eq 1 ] && [ "\$1" = version ] || exit 2
printf '%s\n' '$command $TAG ($GOOS/$GOARCH) agentpod.superbench-worker.v1'
PROGRAM
chmod 700 "$output"
GO
chmod 700 "$trial/bin/go"
export BUILD_LOG="$trial/build.log" TAG=v0.0.0-packaging-fixture
PATH="$trial/bin:$PATH"; export PATH
(cd "$trial" && sh deploy/release/build.sh)
[ "$(wc -l < "$BUILD_LOG" | tr -d ' ')" = 12 ]
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do
  for command in agentpod-node agentpod-fleet agentpod-bench-worker; do
    [ -x "$trial/apps/node-agent/dist/$command-${target%/*}-${target#*/}" ]
    [ "$(grep -Fxc "$target $command" "$BUILD_LOG")" = 1 ]
  done
done
# Use the release's actual configured globs and unchanged checksum implementation.
# This proves the extra worker assets join SHA256SUMS without editing the kit.
mkdir "$trial/release-dist"
patterns=$(python3 - "$root/.github/release-config.json" <<'PYTHON'
import json, sys
with open(sys.argv[1], encoding="utf-8") as config:
    print("\n".join(json.load(config)["assets"]))
PYTHON
)
printf '%s\n' "$patterns" | while IFS= read -r pattern; do
  for file in "$trial"/$pattern; do cp "$file" "$trial/release-dist/"; done
done
sh "$root/.github/release/kit.sh" checksums "$trial/release-dist" >/dev/null
for target in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
  grep -Eq "^[a-f0-9]{64}  agentpod-bench-worker-$target$" "$trial/release-dist/SHA256SUMS"
done
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$trial/release-dist" && sha256sum --check SHA256SUMS >/dev/null)
else
  (cd "$trial/release-dist" && shasum -a 256 --check SHA256SUMS >/dev/null)
fi
# A failed worker build must fail the entire release, not publish partial assets.
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do
  : > "$BUILD_LOG"
  if (cd "$trial" && FAIL_TARGET=$target FAIL_COMMAND=agentpod-bench-worker sh deploy/release/build.sh >/dev/null 2>&1); then
    echo 'worker build failure was ignored' >&2; exit 1
  fi
  [ "$(tail -n 1 "$BUILD_LOG")" = "$target agentpod-bench-worker" ]
done
printf '%s\n' 'release build matrix: PASS (12 versioned binaries, worker checksums, worker failures)'

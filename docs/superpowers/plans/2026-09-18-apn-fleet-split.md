# apn/fleet Binary Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the fleet verbs from `apn` into their own binary, `agentpod-fleet`, aliased `fleet`, and remove `apn fleet`.

**Architecture:** One Go module, two `cmd/` packages. `cmd/agentpod-fleet/` receives `fleet.go` and `fleet_login.go` plus their tests, and gains a small `main.go` and `help.go` of its own. `cmd/agentpod-node/` loses its `fleet` dispatch case and its `fleet` help entry. `internal/fleetcred` is untouched and stays shared. No package is rewritten.

**Tech Stack:** Go 1.26, standard library only for the fleet binary. POSIX `sh` for the installer. GitHub Actions for release.

**Spec:** `docs/superpowers/specs/2026-09-18-apn-fleet-split-design.md`

## Global Constraints

- Module path is `github.com/rakeshgangwar/agentpod/node-agent`. Imports in moved files keep that prefix.
- Both binaries take their version from `-ldflags "-X main.version=<tag>"`; the in-source default is `var version = "dev"`.
- The fleet binary may import **only** the standard library and `internal/fleetcred`. Importing `internal/config`, `internal/service`, `internal/enroll` or `internal/gateway` defeats the split and must fail review.
- `apn fleet` is removed with **no shim, no alias, no deprecation warning**.
- The seven fleet verbs are exactly: `login`, `whoami`, `logout`, `nodes`, `agents`, `stats`, `activity`. None are added or removed.
- Help text in the fleet binary says `fleet <verb>`, never `apn fleet <verb>`.
- Run all Go commands from `apps/node-agent/`.

---

### Task 1: The fleet binary, and `apn fleet` removed

**Files:**
- Create: `apps/node-agent/cmd/agentpod-fleet/main.go`
- Create: `apps/node-agent/cmd/agentpod-fleet/help.go`
- Create: `apps/node-agent/cmd/agentpod-fleet/main_test.go`
- Move: `cmd/agentpod-node/fleet.go` → `cmd/agentpod-fleet/fleet.go`
- Move: `cmd/agentpod-node/fleet_login.go` → `cmd/agentpod-fleet/fleet_login.go`
- Move: `cmd/agentpod-node/fleet_test.go` → `cmd/agentpod-fleet/fleet_test.go`
- Move: `cmd/agentpod-node/fleet_login_test.go` → `cmd/agentpod-fleet/fleet_login_test.go`
- Modify: `cmd/agentpod-node/main.go` — delete the `case "fleet":` block
- Modify: `cmd/agentpod-node/help.go` — delete the `fleet` entry from `commands`
- Modify: `cmd/agentpod-node/help_test.go` — delete `TestFleetHelpListsEveryVerb`

**Interfaces:**
- Consumes: `internal/fleetcred` (`fleetcred.EnvHub`, and whatever `fleet.go` already uses — unchanged).
- Produces: binary `agentpod-fleet`; entry `fleetCmd(args []string)` called with `os.Args[1:]`; `helpText(version string) string` in the fleet package.

- [ ] **Step 1: Write the failing test for the fleet binary's surface**

Create `apps/node-agent/cmd/agentpod-fleet/main_test.go`:

```go
package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The seven verbs this binary exists for. Adding one here without adding it to
// fleet.go's switch fails; shipping one in fleet.go without listing it in help
// fails in TestHelpListsEveryVerb below.
var wantVerbs = []string{"login", "whoami", "logout", "nodes", "agents", "stats", "activity"}

func TestDispatchesEveryFleetVerb(t *testing.T) {
	src, err := os.ReadFile("fleet.go")
	if err != nil {
		t.Fatalf("read fleet.go: %v", err)
	}
	got := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\tcase "([a-z]+)":`).FindAllStringSubmatch(string(src), -1) {
		got[m[1]] = true
	}
	for _, v := range wantVerbs {
		if !got[v] {
			t.Errorf("fleet verb %q is not dispatched in fleet.go", v)
		}
	}
}

// The split, asserted from the outside: this binary must not carry the verbs
// that act on a host. A worker holds this and cannot become a node.
func TestCarriesNoNodeVerbs(t *testing.T) {
	src, err := os.ReadFile("fleet.go")
	if err != nil {
		t.Fatalf("read fleet.go: %v", err)
	}
	for _, forbidden := range []string{"enroll", "run", "service", "update"} {
		if regexp.MustCompile(`(?m)^\tcase "` + forbidden + `":`).MatchString(string(src)) {
			t.Errorf("node verb %q is dispatched in the fleet binary", forbidden)
		}
	}
}

// Help names this binary, not the one it was extracted from.
func TestHelpListsEveryVerbAndSaysFleet(t *testing.T) {
	help := helpText("test")
	if strings.Contains(help, "apn fleet") {
		t.Error("help still says `apn fleet`; this binary is `fleet`")
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(help, "\n") {
		if m := regexp.MustCompile(`^  fleet ([a-z]+)`).FindStringSubmatch(line); m != nil {
			listed[m[1]] = true
		}
	}
	for _, v := range wantVerbs {
		if !listed[v] {
			t.Errorf("verb %q is not listed in help", v)
		}
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/node-agent && go test ./cmd/agentpod-fleet/`
Expected: FAIL — `no Go files in .../cmd/agentpod-fleet` (the package does not exist yet).

- [ ] **Step 3: Move the four fleet files**

```bash
cd apps/node-agent
mkdir -p cmd/agentpod-fleet
git mv cmd/agentpod-node/fleet.go          cmd/agentpod-fleet/fleet.go
git mv cmd/agentpod-node/fleet_login.go    cmd/agentpod-fleet/fleet_login.go
git mv cmd/agentpod-node/fleet_test.go     cmd/agentpod-fleet/fleet_test.go
git mv cmd/agentpod-node/fleet_login_test.go cmd/agentpod-fleet/fleet_login_test.go
```

- [ ] **Step 4: Write the fleet binary's help**

Create `apps/node-agent/cmd/agentpod-fleet/help.go`:

```go
package main

import "fmt"

// helpText is this binary's whole help. It is one block rather than a table
// because there is one command group: everything here acts as a principal.
func helpText(version string) string {
	return fmt.Sprintf(`agentpod-fleet (fleet) — act on an AgentPod fleet as a PRINCIPAL  v%s

Usage: fleet <verb> [flags]

  fleet login                sign in and store a hub token
  fleet whoami [--json]      who the stored token says you are
  fleet logout               forget the stored token
  fleet nodes                the fleet's nodes
  fleet agents               the agents you may dispatch
  fleet stats                fleet totals
  fleet activity             recent fleet activity

  fleet version              print version and platform
  fleet help                 this text

The credential is a person's or an agent's, never a machine's. `+"`apn enroll`"+` gives a
HOST an identity; these verbs use a hub-issued token from $AGENTPOD_TOKEN or the
file `+"`fleet login`"+` writes. A fleet command never falls back to a node's
credential — a node secret says 'I am this host', and that is not an authority to
operate the fleet.

Set $AGENTPOD_HUB to talk to a hub other than the default.`, version)
}

// helpRequested reports whether args' first element is a help flag. Only the
// first argument is checked, matching the flag package's own behaviour of
// treating a later "-h" as an ordinary value.
func helpRequested(args []string) bool {
	return len(args) > 0 && (args[0] == "-h" || args[0] == "--help")
}
```

- [ ] **Step 5: Write the fleet binary's main**

Create `apps/node-agent/cmd/agentpod-fleet/main.go`:

```go
// Command agentpod-fleet acts on an AgentPod fleet as a principal — a person or
// an agent — rather than as the machine it runs on.
//
// It is deliberately a separate program from agentpod-node. That binary is a
// resident daemon enrolled onto a host; this one is an interactive client run
// from laptops, CI and worker sandboxes. They share a repository and nothing
// else: different lifecycle, different audience, different install path.
//
// The separation is structural, not merely conventional. This binary links no
// node code, so the rule that a fleet command never reads a node's credential
// holds by construction rather than by discipline.
package main

import (
	"fmt"
	"os"
	"runtime"
)

// version is the binary's build version. Overridden at link time via:
//
//	-ldflags "-X main.version=<tag>"
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Println(helpText(version))
		os.Exit(0)
	}
	switch os.Args[1] {
	case "help", "-h", "--help":
		fmt.Println(helpText(version))
	case "version":
		fmt.Printf("agentpod-fleet %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
	default:
		fleetCmd(os.Args[1:])
	}
}
```

- [ ] **Step 6: Point the moved files at the new help**

In `cmd/agentpod-fleet/fleet.go`, replace both `commandHelp("fleet")` calls with `helpText(version)`:

- line ~47: `fmt.Println(commandHelp("fleet"))` → `fmt.Println(helpText(version))`
- line ~66: `fmt.Fprintf(os.Stderr, "unknown fleet command: %q\n\n%s\n", args[0], commandHelp("fleet"))` → `fmt.Fprintf(os.Stderr, "unknown fleet command: %q\n\n%s\n", args[0], helpText(version))`

In `cmd/agentpod-fleet/fleet_login.go`, line ~71: `fmt.Println(commandHelp("fleet"))` → `fmt.Println(helpText(version))`.

Also update the file-header comments in both files: they say `apn fleet …` and `apn node …`. Change `apn fleet` to `fleet` and drop the sentence about shipping "inside the binary installed on every station" — that reasoning is superseded by this split.

- [ ] **Step 7: Run the fleet tests**

Run: `cd apps/node-agent && go test ./cmd/agentpod-fleet/ -v`
Expected: PASS, all tests including the moved `fleet_test.go` and `fleet_login_test.go`.

If a moved test needed edits beyond the `commandHelp` → `helpText` rename, say so in the commit message — the spec predicts the move should be faithful, and needing more is a signal worth recording.

- [ ] **Step 8: Write the failing test that `apn` no longer dispatches fleet**

Append to `apps/node-agent/cmd/agentpod-node/help_test.go`:

```go
// The removal, asserted rather than assumed. `apn fleet` was a one-release
// surface (v0.1.33) and is gone; the fleet verbs live in agentpod-fleet.
func TestApnDoesNotDispatchFleet(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	if strings.Contains(string(src), `case "fleet":`) {
		t.Error("main.go still dispatches `fleet`; it belongs to agentpod-fleet now")
	}
	if commandHelp("fleet") != "" {
		t.Error("`fleet` is still registered in apn's help table")
	}
}
```

- [ ] **Step 9: Run it and watch it fail**

Run: `cd apps/node-agent && go test ./cmd/agentpod-node/ -run TestApnDoesNotDispatchFleet -v`
Expected: FAIL on both assertions — `apn` still dispatches `fleet` and still registers its help.

- [ ] **Step 10: Remove `apn fleet`**

In `cmd/agentpod-node/main.go`, delete these three lines from the switch:

```go
	case "fleet":
		// Acting as a principal, not as this machine. See fleet.go.
		fleetCmd(os.Args[2:])
```

In `cmd/agentpod-node/help.go`, delete the entire `{ name: "fleet", group: "Fleet", ... }` entry from the `commands` slice — from `{` through the closing `},`.

In `cmd/agentpod-node/help_test.go`, delete `TestFleetHelpListsEveryVerb` entirely. Its property now lives in the fleet binary as `TestHelpListsEveryVerbAndSaysFleet`.

- [ ] **Step 11: Run the whole suite**

Run: `cd apps/node-agent && go build ./... && go vet ./... && go test ./...`
Expected: PASS everywhere. Both binaries build.

- [ ] **Step 12: Verify both binaries by hand**

```bash
cd apps/node-agent
go build -o /tmp/fleet ./cmd/agentpod-fleet && /tmp/fleet help
go build -o /tmp/apn ./cmd/agentpod-node && /tmp/apn fleet; echo "exit: $?"
```
Expected: `fleet help` lists seven verbs and says `fleet`, never `apn fleet`. `apn fleet` prints `unknown command: "fleet"` and exits non-zero.

- [ ] **Step 13: Commit**

```bash
git add -A apps/node-agent/cmd/
git commit -m "feat(fleet): the fleet client becomes its own binary

fleet.go and fleet_login.go move to cmd/agentpod-fleet with their tests.
The new binary links only internal/fleetcred, so the rule that a fleet
command never reads a node's credential now holds by construction rather
than by discipline.

apn fleet is removed with no shim: v0.1.33 carried it for one day and
nobody holds anything that depends on it.

Spec: docs/superpowers/specs/2026-09-18-apn-fleet-split-design.md"
```

---

### Task 2: The fleet installer

**Files:**
- Create: `apps/node-agent/scripts/install-fleet.sh`
- Create: `apps/node-agent/scripts/install-fleet.test.sh`

**Interfaces:**
- Consumes: the `agentpod-fleet-<os>-<arch>` release asset produced in Task 3.
- Produces: `$BIN_DIR/agentpod-fleet` and `$BIN_DIR/fleet`.

- [ ] **Step 1: Write the failing test**

Create `apps/node-agent/scripts/install-fleet.test.sh`:

```sh
#!/bin/sh
# Exercises install-fleet.sh against a local binary, so no release is needed.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$HERE/install-fleet.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }

BIN_DIR=$(mktemp -d)
FAKE=$(mktemp -d)
printf '#!/bin/sh\necho fake-fleet\n' > "$FAKE/agentpod-fleet"
chmod +x "$FAKE/agentpod-fleet"

# Installs both names from a local binary.
BIN_DIR="$BIN_DIR" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null \
  || fail "install exited non-zero"
[ -x "$BIN_DIR/agentpod-fleet" ] || fail "agentpod-fleet not installed"
[ -L "$BIN_DIR/fleet" ]          || fail "fleet alias not created"
[ "$("$BIN_DIR/fleet")" = "fake-fleet" ] || fail "fleet does not run the binary"

# Refuses to destroy a file it did not put there.
OTHER=$(mktemp -d)
echo "someone else's program" > "$OTHER/fleet"
if BIN_DIR="$OTHER" FLEET_BINARY="$FAKE/agentpod-fleet" sh "$INSTALLER" >/dev/null 2>&1; then
  fail "installer overwrote a stranger's file"
fi
[ "$(cat "$OTHER/fleet")" = "someone else's program" ] || fail "stranger's file was modified"

# Uninstall removes only its own.
BIN_DIR="$BIN_DIR" sh "$INSTALLER" --uninstall >/dev/null || fail "uninstall exited non-zero"
[ ! -e "$BIN_DIR/fleet" ]          || fail "fleet alias survived uninstall"
[ ! -e "$BIN_DIR/agentpod-fleet" ] || fail "binary survived uninstall"
[ -f "$OTHER/fleet" ]              || fail "uninstall removed a stranger's file"

echo "ok: install-fleet.sh"
```

- [ ] **Step 2: Run it and watch it fail**

Run: `sh apps/node-agent/scripts/install-fleet.test.sh`
Expected: FAIL — `install-fleet.sh` does not exist, so `sh` reports it cannot open the file.

- [ ] **Step 3: Write the installer**

Create `apps/node-agent/scripts/install-fleet.sh`:

```sh
#!/bin/sh
# install-fleet.sh — put `fleet` (agentpod-fleet) on a PATH.
#
# This installs a CLIENT. It enrols nothing, installs no service, and takes no
# hub URL or token — sign in afterwards with `fleet login`. The node agent has
# its own installer, install.sh, and the two never call each other.
#
#   sh install-fleet.sh                 latest release into ~/.local/bin
#   VERSION=v0.1.34 sh install-fleet.sh pin a release
#   BIN_DIR=~/bin sh install-fleet.sh   somewhere else
#   sh install-fleet.sh --uninstall     remove both names
#
# FLEET_BINARY=<path> installs that file instead of downloading (used by tests).
set -eu

REPO="SuperJackfruitLabs/agentpod"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
DEST="$BIN_DIR/agentpod-fleet"
ALIAS="$BIN_DIR/fleet"

# Ours means: exactly what we would write. Anything else in the way belongs to
# someone and is never this installer's to replace.
ours_alias() { [ -L "$ALIAS" ] && [ "$(readlink "$ALIAS")" = "$DEST" ]; }

if [ "${1:-}" = "--uninstall" ]; then
	ours_alias && rm -f "$ALIAS"
	[ -f "$DEST" ] && rm -f "$DEST"
	echo "removed $DEST and its alias"
	exit 0
fi

# Both names are checked before either is written, so a refusal never leaves a
# half-install behind.
if [ -e "$DEST" ] && [ ! -f "$DEST" ]; then
	echo "error: $DEST exists and is not a regular file." >&2
	exit 1
fi
if { [ -e "$ALIAS" ] || [ -L "$ALIAS" ]; } && ! ours_alias; then
	echo "error: $ALIAS already exists and was not created by this installer." >&2
	echo "       Move it aside, or set BIN_DIR to somewhere else." >&2
	exit 1
fi

mkdir -p "$BIN_DIR"

if [ -n "${FLEET_BINARY:-}" ]; then
	cp "$FLEET_BINARY" "$DEST"
else
	os=$(uname -s | tr '[:upper:]' '[:lower:]')
	case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
	esac
	tag="${VERSION:-latest}"
	if [ "$tag" = "latest" ]; then
		url="https://github.com/$REPO/releases/latest/download/agentpod-fleet-$os-$arch"
	else
		url="https://github.com/$REPO/releases/download/$tag/agentpod-fleet-$os-$arch"
	fi
	echo "downloading $url"
	curl -fsSL "$url" -o "$DEST"
fi

chmod 755 "$DEST"
ln -sfn "$DEST" "$ALIAS"
echo "installed $DEST"
echo "installed $ALIAS -> $DEST"

# A correct install the shell cannot see looks identical to a broken one.
case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) echo "note: $BIN_DIR is not on your PATH; add it to run these by name." ;;
esac

echo "next: fleet login"
```

- [ ] **Step 4: Make both executable and run the test**

```bash
chmod +x apps/node-agent/scripts/install-fleet.sh apps/node-agent/scripts/install-fleet.test.sh
sh apps/node-agent/scripts/install-fleet.test.sh
```
Expected: `ok: install-fleet.sh`

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/scripts/install-fleet.sh apps/node-agent/scripts/install-fleet.test.sh
git commit -m "feat(fleet): an installer that places a client and enrols nothing

Modelled on superpipeline#77: refuses to replace a file it did not create,
checks both names before writing either, and uninstalls only its own.

install.sh is deliberately not extended — a node installer that also places
the fleet client invites putting both on a node."
```

---

### Task 3: Release both binaries

**Files:**
- Modify: `.github/workflows/release-node-agent.yml`

**Interfaces:**
- Consumes: the `cmd/agentpod-fleet` package from Task 1, `scripts/install-fleet.sh` from Task 2.
- Produces: release assets `agentpod-fleet-{linux,darwin}-{amd64,arm64}` and `install-fleet.sh`.

- [ ] **Step 1: Build both binaries in the matrix**

In the `build` job's "Build binary" step, replace the single `go build` with two:

```yaml
      - name: Build binaries
        working-directory: apps/node-agent
        env:
          CGO_ENABLED: "0"
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
        run: |
          for cmd in agentpod-node agentpod-fleet; do
            go build \
              -trimpath \
              -ldflags "-s -w -X main.version=${GITHUB_REF_NAME}" \
              -o ${cmd}-${{ matrix.goos }}-${{ matrix.goarch }} \
              ./cmd/${cmd}
          done
```

- [ ] **Step 2: Upload both**

In the same job's "Upload binary to release (retry x3)" step, change the `gh release upload` line to pass both files:

```yaml
            if gh release upload "$TAG" \
                "agentpod-node-${{ matrix.goos }}-${{ matrix.goarch }}" \
                "agentpod-fleet-${{ matrix.goos }}-${{ matrix.goarch }}" \
                --repo "$GITHUB_REPOSITORY" --clobber; then
```

- [ ] **Step 3: Publish the fleet installer as a static asset**

In the `static-assets` job, add `install-fleet.sh` to the upload list:

```yaml
            if gh release upload "$TAG" \
                apps/node-agent/deploy/agentpod-node.service \
                apps/node-agent/scripts/install.sh \
                apps/node-agent/scripts/install-fleet.sh \
                --repo "$GITHUB_REPOSITORY" --clobber; then
```

- [ ] **Step 4: Extend the completeness guard — the trap**

In the `fly-pin` job's "Refuse to pin to an incomplete release" step, extend the required-asset list:

```yaml
          for want in agentpod-node-linux-amd64 agentpod-node-linux-arm64 \
                      agentpod-fleet-linux-amd64 agentpod-fleet-linux-arm64 \
                      SHA256SUMS; do
```

Without this the guard passes on a release that built **zero** fleet binaries — the exact class of failure it was written for after v0.1.7 shipped incomplete.

- [ ] **Step 5: Verify the workflow parses**

Run: `cd /home/rakeshgangwar/Projects/superjackfruit/agentpod && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release-node-agent.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release-node-agent.yml
git commit -m "ci: release agentpod-fleet alongside agentpod-node

Assets go 7 -> 12. The fly-pin completeness guard names its required
assets literally, so it gains the two fleet linux binaries: without that
a release building no fleet artifacts would pass the check written after
v0.1.7 shipped incomplete."
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/OPERATING.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the command surface from Task 1, the installer from Task 2.
- Produces: no code.

> **Corrected after execution.** Steps 1 and 4 below were rewritten after Task 4 shipped, once
> its fix rounds surfaced two defects in the original commands — both mine, not the
> implementer's. (a) Step 3 adds a historical note containing the literal string `apn fleet`,
> which made Step 4's original "no output" check self-defeating: it could never pass once
> Step 3 had run. (b) this shell's `grep` is a `ugrep` wrapper that silently omits
> `docs-site/src/content/docs/build/*.md` on a from-root scan — the root `.gitignore`'s bare
> `build/` rule and `docs-site/.gitignore`'s `!src/content/docs/build/` negation resolve
> correctly under `git`, but `ugrep --ignore-files` does not apply the same per-directory
> negation precedence — and that gap is exactly how two live docs-site pages were missed on
> the first pass. The commands below use `/usr/bin/grep` directly (bypassing the shell
> wrapper), scan `.md`, `.mdx`, `.mjs` and `.go` so a stale reference in a doc-site nav config
> or a Go comment cannot hide from them either, and Step 4 excludes the intentional survivors
> by content instead of loosening the search. This note exists so the document does not
> silently disagree with what was actually run.

- [ ] **Step 1: Find every mention**

Run:
```sh
cd /home/rakeshgangwar/Projects/superjackfruit/agentpod && \
/usr/bin/find . -name node_modules -prune -o -name '.git' -prune \
  -o \( -name '*.md' -o -name '*.mdx' -o -name '*.mjs' -o -name '*.go' \) -print 2>/dev/null \
  | xargs /usr/bin/grep -n 'apn fleet' 2>/dev/null \
  | /usr/bin/grep -v '^\./docs/superpowers' \
  | /usr/bin/grep -v '^\./\.superpowers/'
```
Expected: a list to work through, including `docs-site/`. `docs/superpowers/` is filtered out of
this list because every hit under it is a dated record by definition. `docs/archive/` is
deliberately **not** filtered, so its hits still appear here — each one is a dated record too,
and is left alone. `.superpowers/` (this task's own gitignored working notes) is filtered out
because it is process scratch, not repository documentation. Anything else in the list is live
and gets rewritten to `fleet <verb>`.

- [ ] **Step 2: Rewrite the live references**

For each hit in `docs/OPERATING.md`, `README.md` and `CLAUDE.md`, replace `apn fleet <verb>` with `fleet <verb>`. Dated records under `docs/superpowers/specs/` and `docs/archive/` keep their original text — they describe what was true when written.

- [ ] **Step 3: Add a fleet section to OPERATING.md**

After the node installation section, add:

```markdown
## The fleet client

`fleet` acts on the fleet as *you*, not as a machine. It is a separate binary
from `apn`: install it on a laptop, in CI, or in an agent's workspace — anywhere
that is **not** an enrolled node.

```sh
curl -fsSL https://github.com/SuperJackfruitLabs/agentpod/releases/latest/download/install-fleet.sh | sh
fleet login
fleet nodes
```

It enrols nothing and installs no service. Its credential is a hub token in
`<UserConfigDir>/agentpod/token.json`, separate from a node's
`<UserConfigDir>/agentpod-node/config.json`, and neither binary can read the
other's — they share no code.

Removed in the release following v0.1.33: `apn fleet <verb>`. Use `fleet <verb>`.
```

- [ ] **Step 4: Verify no live doc still says `apn fleet`**

Run:
```sh
cd /home/rakeshgangwar/Projects/superjackfruit/agentpod && \
/usr/bin/find . -name node_modules -prune -o -name '.git' -prune \
  -o \( -name '*.md' -o -name '*.mdx' -o -name '*.mjs' -o -name '*.go' \) -print 2>/dev/null \
  | xargs /usr/bin/grep -n 'apn fleet' 2>/dev/null \
  | /usr/bin/grep -v '^\./docs/superpowers' \
  | /usr/bin/grep -v '^\./docs/archive' \
  | /usr/bin/grep -v '^\./\.superpowers/' \
  | /usr/bin/grep -v 'Removed in the release following v0.1.33' \
  | /usr/bin/grep -v 'strings.Contains(help, "apn fleet")' \
  | /usr/bin/grep -v 'help still says `apn fleet`' \
  | /usr/bin/grep -v 'apn fleet` was a one-release'
```
Expected: no output. The four `grep -v` content filters at the end exclude the three lines that
must survive on purpose: the historical note Step 3 just added to `docs/OPERATING.md`, and the
two lines in `cmd/agentpod-node/help_test.go` / `cmd/agentpod-fleet/main_test.go` that correctly
assert `apn fleet` is gone. Anything else surfacing here is a real miss.

- [ ] **Step 5: Commit**

```bash
git add docs/OPERATING.md README.md CLAUDE.md
git commit -m "docs: apn fleet is now fleet

Live documentation follows the split. Dated records under docs/superpowers
and docs/archive keep their original text: they describe what was true when
they were written."
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: layout and command surface → Task 1; removal without a shim → Task 1 steps 8–10; installing → Task 2; release and the `fly-pin` trap → Task 3; docs → Task 4. Self-update is covered by omission and is asserted nowhere, matching the spec's "`fleet` gets no self-update in this change". Signing (#228) is explicitly out of scope in the spec and has no task.

**Placeholders.** None. Every code step carries the actual content.

**Type consistency.** `helpText(version string) string` is defined in Task 1 Step 4 and used in Steps 5, 6 and the Step 1 test. `fleetCmd(args []string)` keeps the signature it already has and is called as `fleetCmd(os.Args[1:])`. `helpRequested` is redefined in the fleet package because `fleet.go` and `fleet_login.go` both call it and `help.go` does not move.

**The move is verified clean before execution.** `fleet_test.go` and `fleet_login_test.go` were checked for references to `commandHelp`, `helpText`, `helpRequested` and `maybeShowHelp` — they use none, so they move with no edits at all. Only `fleet.go` (two call sites) and `fleet_login.go` (one) need the `commandHelp("fleet")` → `helpText(version)` rename. If Task 1 Step 7 nonetheless requires editing a moved test, that contradicts this check and is worth stopping to understand rather than absorbing.

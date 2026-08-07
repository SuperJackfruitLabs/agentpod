# macOS LaunchAgent Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `install.sh` on macOS installs a persistent per-user LaunchAgent, and `apn update` restarts correctly under launchd. Ships as v0.1.12.

**Architecture:** Spec: `docs/superpowers/specs/2026-08-08-macos-launchd-installer-design.md`. Two independent changes — a darwin branch in `restartService` (Go, behind the existing injected `RunCommand` seam) and a darwin service section in `install.sh` (plist + `launchctl bootstrap`) — then a release + live dogfood on the real Mac node.

**Tech Stack:** Go (node-agent), bash, launchd.

## Global Constraints

- Branch: `develop`. Commit style: `feat(node-agent): …` / `fix(node-agent): …` (match `git log`).
- Node-agent tests: `cd apps/node-agent && go test -race ./...`; gofmt-clean on changed files.
- Linux behavior must stay byte-identical: systemd paths in both `restartService` and `install.sh` untouched.
- Plist label is exactly `dev.agentpod.node`; plist path `~/Library/LaunchAgents/dev.agentpod.node.plist`; logs `~/Library/Logs/agentpod-node.log`.
- Board workflow: file one issue for the feature (Task 1 Step 1), close it with a summary comment when Task 3's live verify passes.
- The live Mac node (`node_161e685104dc488ebd11`) currently runs via a nohup'd process started from a Claude session — Task 3 replaces it with the LaunchAgent; do not leave both running.

---

### Task 1: selfupdate darwin restart branch

**Files:**
- Modify: `apps/node-agent/internal/selfupdate/selfupdate.go:217-237` (restartService) and its two call sites
- Modify: `apps/node-agent/cmd/agentpod-node/main.go` (the ErrRestartFailed hint text)
- Test: `apps/node-agent/internal/selfupdate/selfupdate_test.go` (extend the Steps 9–10 section)

**Interfaces:**
- Consumes: existing `Options.RunCommand` seam; `ErrRestartFailed`.
- Produces: `restartService(goos string, run func(name string, args ...string) error) error` — call sites pass `runtime.GOOS`; existing tests pass `"linux"`. Darwin runs exactly: `launchctl kickstart -k gui/<uid>/dev.agentpod.node` where `<uid> = os.Getuid()`.

- [ ] **Step 1: File the issue**

```bash
gh issue create --repo rakeshgangwar/agentpod \
  --title "installer: macOS LaunchAgent (persistent node-agent) + launchd-aware apn update restart" \
  --body "install.sh on darwin currently prints 'set up a launchd plist yourself' and apn update tries systemctl on macOS (misleading ErrRestartFailed hint). Add: (1) install.sh darwin branch that installs ~/.local/bin binary + writes ~/Library/LaunchAgents/dev.agentpod.node.plist (RunAtLoad+KeepAlive, logs to ~/Library/Logs/agentpod-node.log) and bootstraps it idempotently; sudo invocations re-exec as SUDO_USER. (2) selfupdate restartService darwin branch: launchctl kickstart -k gui/<uid>/dev.agentpod.node. KeepAlive also makes console one-click updates work on macOS (exit -> respawn). Spec: docs/superpowers/specs/2026-08-08-macos-launchd-installer-design.md" \
  --label "enhancement" 2>/dev/null || \
gh issue create --repo rakeshgangwar/agentpod \
  --title "installer: macOS LaunchAgent (persistent node-agent) + launchd-aware apn update restart" \
  --body "See docs/superpowers/specs/2026-08-08-macos-launchd-installer-design.md"
```

Note the issue number `<N>` for commits/comments.

- [ ] **Step 2: Write the failing test**

Append to `apps/node-agent/internal/selfupdate/selfupdate_test.go` (the file already has a `run`-recording pattern in its Steps 9–10 section — mirror it):

```go
func TestRestartServiceDarwinUsesLaunchctlKickstart(t *testing.T) {
	var calls [][]string
	run := func(name string, args ...string) error {
		calls = append(calls, append([]string{name}, args...))
		return nil
	}

	if err := restartService("darwin", run); err != nil {
		t.Fatalf("restartService: %v", err)
	}

	want := []string{"launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/dev.agentpod.node", os.Getuid())}
	if len(calls) != 1 || !reflect.DeepEqual(calls[0], want) {
		t.Fatalf("calls = %v, want exactly [%v]", calls, want)
	}
}

func TestRestartServiceDarwinFailureWrapsErrRestartFailed(t *testing.T) {
	run := func(name string, args ...string) error { return errors.New("no such service") }
	err := restartService("darwin", run)
	if !errors.Is(err, ErrRestartFailed) {
		t.Fatalf("err = %v, want ErrRestartFailed", err)
	}
}
```

(Add `"reflect"`, `"os"`, `"fmt"`, `"errors"` to the test file's imports if missing.)

- [ ] **Step 3: Run — expect FAIL** (`restartService` takes 1 arg / undefined behavior)

Run: `cd apps/node-agent && go test ./internal/selfupdate/ -run TestRestartServiceDarwin`

- [ ] **Step 4: Implement**

Replace `restartService` in `apps/node-agent/internal/selfupdate/selfupdate.go`:

```go
// restartService restarts the agentpod-node service for the given GOOS.
//
// linux: probes for a user-scoped systemd unit first; if active uses --user,
// else the system unit. darwin: the installer runs the agent as the LaunchAgent
// gui/<uid>/dev.agentpod.node — kickstart -k kills and restarts it. Returns a
// wrapped ErrRestartFailed when the restart command fails (the binary is
// already swapped at that point).
func restartService(goos string, run func(name string, args ...string) error) error {
	if run == nil {
		run = func(name string, args ...string) error {
			return exec.Command(name, args...).Run()
		}
	}
	var restartErr error
	if goos == "darwin" {
		restartErr = run("launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/dev.agentpod.node", os.Getuid()))
	} else if run("systemctl", "--user", "is-active", "agentpod-node") == nil {
		restartErr = run("systemctl", "--user", "restart", "agentpod-node")
	} else {
		restartErr = run("systemctl", "restart", "agentpod-node")
	}
	if restartErr != nil {
		return fmt.Errorf("%w: %v", ErrRestartFailed, restartErr)
	}
	return nil
}
```

Update the two call sites (`selfupdate.go:349` area) to `restartService(runtime.GOOS, opts.RunCommand)` (add `"runtime"` import if missing), and update every existing test call from `restartService(run)` to `restartService("linux", run)`.

In `apps/node-agent/cmd/agentpod-node/main.go`, the `ErrRestartFailed` hint currently says `restart the service manually: systemctl restart agentpod-node`. Make it platform-aware:

```go
			if errors.Is(err, selfupdate.ErrRestartFailed) {
				fmt.Fprintln(os.Stderr, "update: binary swapped but service restart failed:", err)
				if runtime.GOOS == "darwin" {
					fmt.Fprintf(os.Stderr, "restart it manually: launchctl kickstart -k gui/%d/dev.agentpod.node  (or re-run: apn run)\n", os.Getuid())
				} else {
					fmt.Fprintln(os.Stderr, "restart the service manually: systemctl restart agentpod-node")
				}
				os.Exit(1)
			}
```

(`runtime` is already imported in main.go for the `version` command.)

- [ ] **Step 5: Run — expect PASS**, then full suite

Run: `cd apps/node-agent && go test -race ./...` — all green; `gofmt -l internal/selfupdate/` clean for changed files.

- [ ] **Step 6: Commit**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): launchd-aware self-update restart on macOS (#<N>)"
```

---

### Task 2: install.sh darwin LaunchAgent

**Files:**
- Modify: `apps/node-agent/scripts/install.sh` (header comment; sudo handling ~line 50-62; the final darwin section at lines 198-205; the `MODE=user` darwin fallback at 146-180)
- Modify: `docs/DEPLOYMENT.md` + `docs/OPERATING.md` (macOS service section)

**Interfaces:**
- Consumes: `DEST_BIN` (absolute binary path), existing enroll flow.
- Produces: on darwin (any mode), after enroll: `install_launch_agent` writes `~/Library/LaunchAgents/dev.agentpod.node.plist` and bootstraps it. Task 3 relies on exactly the label `dev.agentpod.node`.

- [ ] **Step 1: Force darwin installs to user mode (sudo → re-exec as SUDO_USER)**

In the mode-detection block (after line 62), add:

```bash
# ---------------------------------------------------------------------------
# macOS: always a rootless per-user install (binary in ~/.local/bin, config in
# the user's dir, service as a per-user LaunchAgent). A sudo invocation (the
# console's copy-paste one-liner) re-execs as the invoking user.
# ---------------------------------------------------------------------------
if [ "$(uname -s)" = "Darwin" ]; then
  if [ "$(id -u)" = "0" ]; then
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
      echo "INFO: macOS install runs per-user — re-executing as ${SUDO_USER}."
      exec sudo -u "$SUDO_USER" VERSION="${VERSION:-}" AGENTPOD_USER_INSTALL=1 bash "$0" "$HUB_URL" "$TOKEN"
    fi
    echo "ERROR: macOS install must run as a regular user (not root)." >&2; exit 1
  fi
  MODE=user
fi
```

This makes the old `MODE=system && darwin` enroll special-case at lines 128-132 dead on macOS — leave the enroll block as-is (the condition simply never fires), but delete the now-unreachable `elif [ "$OS" = "darwin" ]` section at lines 198-205.

- [ ] **Step 2: Add the LaunchAgent installer function and wire it**

Add near `path_hint()`:

```bash
install_launch_agent() {
  # Per-user LaunchAgent: survives reboot/terminal close, respawns on crash —
  # and respawns after self-update's exit, which is what makes console
  # one-click updates work on macOS (KeepAlive plays systemd Restart=always).
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist="$plist_dir/dev.agentpod.node.plist"
  local log="$HOME/Library/Logs/agentpod-node.log"
  mkdir -p "$plist_dir" "$HOME/Library/Logs"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agentpod.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>${DEST_BIN}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
EOF
  local uid; uid="$(id -u)"
  # Idempotent re-install: tear down any loaded copy first (ignore failures).
  launchctl bootout "gui/${uid}/dev.agentpod.node" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/${uid}" "$plist" 2>/dev/null || launchctl load -w "$plist" 2>/dev/null; then
    echo ""
    echo "Running as a launchd LaunchAgent (survives reboot while you're logged in):"
    echo "  status:     launchctl print gui/${uid}/dev.agentpod.node | head -20"
    echo "  logs:       tail -f ${log}"
    echo "  restart:    launchctl kickstart -k gui/${uid}/dev.agentpod.node"
    echo "  uninstall:  launchctl bootout gui/${uid}/dev.agentpod.node && rm ${plist}"
    echo "NOTE: a LaunchAgent only runs while you are logged in; system sleep"
    echo "      suspends it — the node shows offline until wake (by design)."
    return 0
  fi
  echo "WARNING: could not bootstrap the LaunchAgent — start manually with: apn run" >&2
  return 1
}
```

In the `MODE=user` result section (lines 146-180), wire darwin in alongside the linux systemd branch:

```bash
  SVC_OK=0
  if [ "$OS" = "linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
    ... (existing linux block, unchanged) ...
  elif [ "$OS" = "darwin" ]; then
    if install_launch_agent; then SVC_OK=1; fi
  fi
```

and gate the existing tmux/nohup fallback echo so it only prints when `SVC_OK=0` (it already does). Update the header comment (lines 1-17) to mention the macOS LaunchAgent.

- [ ] **Step 3: Lint the script**

Run: `bash -n apps/node-agent/scripts/install.sh && (command -v shellcheck >/dev/null && shellcheck -S warning apps/node-agent/scripts/install.sh || echo "shellcheck unavailable — bash -n only")`
Expected: no syntax errors; no new shellcheck warnings beyond any pre-existing ones (compare against `git stash` baseline if unsure).

- [ ] **Step 4: Docs**

`docs/DEPLOYMENT.md` (node install section) + `docs/OPERATING.md`: add the macOS service bullet — same one-liner installs a LaunchAgent; status/logs/restart/uninstall commands from Step 2's output; the logged-in/sleep limitation sentence from the spec.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/scripts/install.sh docs/DEPLOYMENT.md docs/OPERATING.md
git commit -m "feat(installer): macOS LaunchAgent — persistent node-agent via install.sh (#<N>)"
```

---

### Task 3: Release v0.1.12 + live dogfood on the Mac node

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:** consumes everything above; produces v0.1.12 live, the Mac node running under launchd.

- [ ] **Step 1: Verify + CHANGELOG + PR**

```bash
cd apps/node-agent && go test -race ./...
```

Add a `## v0.1.12` CHANGELOG section (macOS LaunchAgent installer, launchd-aware update restart; issue ref). Commit `docs: changelog for v0.1.12`, push `develop`, open PR → `main` titled `v0.1.12: macOS LaunchAgent installer`, wait for the 4 checks, merge (the controller/user merges per session convention).

- [ ] **Step 2: Tag and release**

```bash
git checkout main && git pull && git tag v0.1.12 && git push origin v0.1.12
```

Watch `release-node-agent.yml`; expect 4 binaries + install.sh (the NEW one) + .service + SHA256SUMS.

- [ ] **Step 3: Live dogfood on this Mac**

1. Mint an enrollment token in the console (needed as an installer arg; enroll itself will KEEP the existing identity via credential-check — the token goes unused, which is the #161 design working).
2. Kill the nohup'd agent: `pkill -f "local/bin/agentpod-node run"` (and any scratchpad copy).
3. Run the real one-liner: `curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh | bash -s -- --user https://hub.agentpod.dev <TOKEN>`.
4. Expect: binary v0.1.12 installed, `already enrolled: node_161e685104dc488ebd11 (credential verified)`, LaunchAgent bootstrapped, node online in the console within ~30s showing `v: v0.1.12`.
5. Kickstart test: `launchctl kickstart -k gui/$(id -u)/dev.agentpod.node` → node blips offline→online (honest close + reconnect).
6. Terminal-independence test: the agent has no controlling terminal — confirm `ps -o ppid= -p $(pgrep -f 'agentpod-node run')` shows ppid 1 (launchd).
7. Roll superchotu + molt-bot to v0.1.12 from the console (uniform fleet; hub restart first if the version cache hides the button).

- [ ] **Step 4: Close out**

Summary comment on #<N> with commits + live evidence; close it. Verify board card Done. Update the session memory file with the launchd facts (label, plist path, uninstall, restart semantics).

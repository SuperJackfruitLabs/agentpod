# apn Service CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apn stop|start|restart|status|logs` + `apn service install|uninstall` + a real help system; `install.sh` thins to download → enroll → `apn service install`. Ships v0.1.13.

**Architecture:** Spec: `docs/superpowers/specs/2026-08-08-apn-service-cli-design.md`. New `internal/service` package (Manager interface, launchd + systemd implementations, embedded templates, injected runner for argv-exact table tests); `main.go` gains verbs + help; `selfupdate.restartService` delegates to the service package.

**Tech Stack:** Go stdlib only (no cobra).

## Global Constraints

- Branch `develop`. Commits `feat(node-agent): …` etc. TDD: failing test first, every step.
- Tests: `cd apps/node-agent && go test -race ./...` fully green; gofmt-clean on new/changed files.
- Contracts that MUST NOT drift: launchd label `dev.agentpod.node`, domain `gui/<uid>`; systemd unit name `agentpod-node`; macOS log path `~/Library/Logs/agentpod-node.log`; macOS is per-user only (root refused); selfupdate restart argv on both platforms stays byte-identical to today's (existing tests pin it).
- `apn stop` = stop AND disable (sticky). Self-update paths never disable.
- No live launchctl/systemctl runs in tests — everything through the injected runner. Live verification happens only in Task 7 on this Mac.
- File one issue at Task 1 start (`gh issue create --title "apn: service management verbs (stop/start/restart/status/logs, service install) + help system" --body "Spec: docs/superpowers/specs/2026-08-08-apn-service-cli-design.md"`); use its number in commits; controller closes it after Task 7.

---

### Task 1: service package core + launchd manager

**Files:**
- Create: `apps/node-agent/internal/service/service.go` (types, NewManager)
- Create: `apps/node-agent/internal/service/launchd.go` + `launchd_test.go`
- Create: `apps/node-agent/internal/service/templates/dev.agentpod.node.plist` (embedded)

**Interfaces (produced — later tasks and the spec depend on these exactly):**

```go
package service

// Runner executes a command and returns its combined stdout (trimmed) — the
// injectable seam for tests. nil means exec.Command for real.
type Runner func(name string, args ...string) (string, error)

type Status struct {
	Installed bool   `json:"installed"`
	Enabled   bool   `json:"enabled"`
	Running   bool   `json:"running"`
	PID       int    `json:"pid"`
	UnitPath  string `json:"unitPath"` // plist/unit file location
}

type Manager interface {
	Install() error   // write template, enable, start; idempotent
	Uninstall() error // stop, disable, remove file; idempotent
	Start() error     // enable + start
	Stop() error      // stop + disable (sticky)
	Restart() error
	Status() (Status, error)
}

// NewManager picks the platform implementation. darwin: launchd per-user
// (returns an error for uid 0 — macOS installs are per-user by policy).
// linux: systemd; user scope when uid != 0 OR the user unit answers
// `systemctl --user is-active agentpod-node` (preserves selfupdate's probe
// behavior), else system scope.
func NewManager(run Runner) (Manager, error)
```

- [ ] **Step 1: RED — launchd argv table test.** Create `launchd_test.go` with a recording Runner (`calls [][]string`, scripted per-call results) and table tests asserting EXACT argv sequences (uid from `os.Getuid()`, plist path under the test's fake home — inject home via a `launchdManager{home string, uid int, run Runner}` struct so tests don't touch the real `~/Library`):
  - `Stop()` → `launchctl bootout gui/<uid>/dev.agentpod.node` (error IGNORED) then `launchctl disable gui/<uid>/dev.agentpod.node` (error returned).
  - `Start()` → `launchctl enable gui/<uid>/dev.agentpod.node`, then `launchctl bootstrap gui/<uid> <plistPath>`; if bootstrap errors, fall back to `launchctl kickstart -k gui/<uid>/dev.agentpod.node` (test both branches).
  - `Restart()` → `launchctl kickstart -k gui/<uid>/dev.agentpod.node` exactly (this later becomes selfupdate's delegate — argv must match selfupdate's current darwin test).
  - `Install()` → writes the plist file (assert content contains the label, the binary path with ` run` argument, both log paths), then `enable`, `bootout` (ignored), `bootstrap`.
  - `Uninstall()` → `bootout` (ignored), file removed, no error when file already absent.
  - `Status()` → Installed = plist exists; Enabled = parse `launchctl print-disabled gui/<uid>` output NOT containing `"dev.agentpod.node" => disabled`; Running/PID = parse `launchctl print gui/<uid>/dev.agentpod.node` for a `pid = <N>` line, not-running when that command errors. Table cases: running-with-pid, stopped, disabled, not-installed.
- [ ] **Step 2: Verify RED** (`go test ./internal/service/` — package doesn't exist yet → build failure, then after scaffolding types, assertion failures).
- [ ] **Step 3: GREEN — implement `service.go` + `launchd.go`.** Plist template in `templates/dev.agentpod.node.plist` via `//go:embed`, parameterized with `text/template` on `{{.BinaryPath}}` and `{{.LogPath}}` — content identical in effect to what `install.sh`'s `install_launch_agent()` writes today (Label, ProgramArguments [bin, run], RunAtLoad, KeepAlive, both Standard*Path to the log). Binary path resolved via `os.Executable()` + `filepath.EvalSymlinks`.
- [ ] **Step 4: Verify GREEN + `-race` + gofmt.**
- [ ] **Step 5: Commit** `feat(node-agent): service package with launchd manager (#<N>)`.

---

### Task 2: systemd manager

**Files:**
- Create: `apps/node-agent/internal/service/systemd.go` + `systemd_test.go`
- Create: `apps/node-agent/internal/service/templates/agentpod-node-user.service`, `templates/agentpod-node-system.service`

**Interfaces:** `newSystemdManager(run Runner, userScope bool, home string, uid int) *systemdManager`; `NewManager` (from Task 1) wires the linux branch: userScope = `uid != 0 || userUnitActive(run)` where `userUnitActive` = `systemctl --user is-active agentpod-node` succeeding.

- [ ] **Step 1: RED — argv table tests, both scopes.** Base argv `systemctl --user` (user) vs `systemctl` (system):
  - `Stop()` → `<base> stop agentpod-node` (error ignored) + `<base> disable agentpod-node`.
  - `Start()` → `<base> enable --now agentpod-node`.
  - `Restart()` → `<base> restart agentpod-node` (matches selfupdate's current restart argv per scope).
  - `Install()` → writes unit to `~/.config/systemd/user/agentpod-node.service` (user) or `/etc/systemd/system/agentpod-node.service` (system; path field on the struct so the test uses a temp dir), then `<base> daemon-reload`, `<base> enable --now agentpod-node`.
  - `Uninstall()` → `<base> disable --now agentpod-node` (ignored), remove file, `<base> daemon-reload`.
  - `Status()` → Installed = unit file exists; Enabled = `<base> is-enabled agentpod-node` stdout `enabled`; Running = `<base> is-active agentpod-node` stdout `active`; PID = atoi of `<base> show -p MainPID --value agentpod-node` (0 → not running).
  - `NewManager` linux scope selection: uid 1000 → user; uid 0 + probe fails → system; uid 0 + user-unit probe succeeds → user (mirrors `restartService` today).
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: GREEN.** User template = the minimal unit `install.sh` writes today (Description, After/Wants network-online, `ExecStart={{.BinaryPath}} run`, Restart=always, RestartSec=5, WantedBy=default.target). System template = `deploy/agentpod-node.service` content with `ExecStart={{.BinaryPath}} run` parameterized (keep User=root + the hardening block + journal logging + WantedBy=multi-user.target verbatim).
- [ ] **Step 4: Verify GREEN + `-race` + gofmt.**
- [ ] **Step 5: Commit** `feat(node-agent): systemd manager for the service package (#<N>)`.

---

### Task 3: CLI verbs — stop/start/restart/status/logs + service install|uninstall

**Files:**
- Create: `apps/node-agent/cmd/agentpod-node/service_cmds.go` + `service_cmds_test.go`
- Modify: `apps/node-agent/cmd/agentpod-node/main.go` (switch cases only)

**Interfaces (produced):** `runServiceVerb(verb string, args []string, mgr service.Manager, out io.Writer) int` (returns exit code) and `statusCmd(mgr service.Manager, cfg config.Config, cfgErr error, checkCred func(hub, id, secret string) (bool, error), jsonOut bool, out io.Writer) int` — main.go cases stay one-liners; all logic testable with a fake Manager.

- [ ] **Step 1: RED — status assembly tests.** Fake Manager returning scripted Status; table:
  - running + credential valid (stub checkCred true) → output contains `running:    yes (pid 35547)`, `credential: valid`, exit 0.
  - running + credential rejected → `credential: INVALID`, exit 1.
  - hub unreachable (checkCred error) → `reachable:  no`, `credential: unknown`, exit 1.
  - not running → exit 1; no config file → hub block shows `not enrolled`, exit 1.
  - `--json` → unmarshal output into `struct{ Service service.Status; Hub struct{ URL, NodeID string; Reachable, CredentialValid bool } }`, assert fields.
  Output format (text) exactly:

```
Service:
  installed:  yes (<unitPath>)
  enabled:    yes
  running:    yes (pid 35547)
  version:    <version>
Hub:
  url:        https://hub.agentpod.dev
  node:       node_161e685104dc488ebd11
  reachable:  yes
  credential: valid
```

- [ ] **Step 2: RED — stop/start/restart wrappers** call the right Manager method, print a confirmation + undo hint (`stopped and disabled — 'apn start' re-enables`), map Manager errors to exit 1. `service install` prints the platform summary (status/logs/restart/uninstall lines — the text `install_launch_agent()` prints today moves here for darwin; a systemd equivalent for linux). `service uninstall` prints removal confirmation.
- [ ] **Step 3: RED — logs.** `logsCmd(scope) `: darwin → exec `tail` (`-n N`, plus `-f` when set) on `~/Library/Logs/agentpod-node.log` with stdio passthrough (test: assert the built \*exec.Cmd argv via a command-builder seam; missing log file → friendly error, exit 1). linux → exec `journalctl [-f] [-n N] --user-unit agentpod-node` (user scope) / `-u agentpod-node` (system).
- [ ] **Step 4: Verify RED, then GREEN** — implement `service_cmds.go`; wire main.go cases `"stop","start","restart","status","logs","service"` calling `service.NewManager(nil)` + `enroll.CheckCredential`.
- [ ] **Step 5: Verify GREEN + `-race`; build darwin+linux cross (`GOOS=linux go build ./...`).**
- [ ] **Step 6: Commit** `feat(node-agent): stop/start/restart/status/logs + service install|uninstall (#<N>)`.

---

### Task 4: help system

**Files:**
- Create: `apps/node-agent/cmd/agentpod-node/help.go` + `help_test.go`
- Modify: `apps/node-agent/cmd/agentpod-node/main.go` (no-args path, help/-h/--help cases, unknown-command path)

- [ ] **Step 1: RED.** Tests: (a) `helpText(version)` contains every command name from a `commands` registry slice (test iterates the slice — a new command missing from help fails the test); (b) contains the grouped section headers `Service:`, `Node:`, `Maintenance:` and the examples block from the spec; (c) `suggestCommand("statsu")` → `"status"` (levenshtein ≤ 2), `suggestCommand("zzz")` → `""`; (d) per-command help: `commandHelp("stop")` mentions sticky/disable semantics; `commandHelp("logs")` mentions the platform log sources.
- [ ] **Step 2: GREEN.** `commands` = `[]struct{ name, group, oneline, detail string }` — single source for top-level help, `apn help <cmd>`, and the suggestion list. Small levenshtein (≤ 20 lines, stdlib). main.go: no args OR `help|-h|--help` → print `helpText(version)`, exit 0; `help <cmd>` → `commandHelp`, exit 0 (unknown cmd in help → exit 2); unknown verb → `unknown command: %q` + optional `did you mean '<s>'?` + `run 'apn help'`, exit 2. Each existing FlagSet gets a `.Usage` that prints the command's `detail` + flag defaults.
- [ ] **Step 3: Verify GREEN + `-race`; run `go run ./cmd/agentpod-node help` once and eyeball the layout matches the spec mock.**
- [ ] **Step 4: Commit** `feat(node-agent): help system — grouped help, per-command help, did-you-mean (#<N>)`.

---

### Task 5: selfupdate delegates restart to the service package

**Files:**
- Modify: `apps/node-agent/internal/selfupdate/selfupdate.go` (restartService body only; exported behavior unchanged)
- Modify: `apps/node-agent/internal/selfupdate/selfupdate_test.go` (only if adapter shape requires)

- [ ] **Step 1: Confirm the existing restart tests still pin argv** (`TestRestartService*` — linux user/system probe sequence, darwin kickstart). These are the contract; do NOT weaken them.
- [ ] **Step 2: Replace `restartService`'s body** with delegation: adapt `run func(name string, args ...string) error` to `service.Runner` (`return "", run(...)`), build the platform manager the same way `NewManager` does but honoring the `goos` parameter (keep the signature `restartService(goos string, run ...)`; darwin → launchd Restart; linux → the same user-probe + scoped restart via systemd manager). Wrap failures in `ErrRestartFailed` exactly as today.
- [ ] **Step 3: Verify GREEN** — the pinned argv tests pass unmodified (if they don't, the delegation is wrong — fix the service side, not the tests). Full `-race` suite.
- [ ] **Step 4: Commit** `refactor(node-agent): selfupdate restart delegates to internal/service (#<N>)`.

---

### Task 6: installer thinning + docs + changelog

**Files:**
- Modify: `apps/node-agent/scripts/install.sh`
- Modify: `docs/DEPLOYMENT.md`, `docs/OPERATING.md`, `CLAUDE.md` (commands), `CHANGELOG.md`

- [ ] **Step 1: install.sh.** After the enroll step, replace the three service sections (linux `MODE=user` systemd block, `install_launch_agent()` + its call, linux system block incl. the `agentpod-node.service` download) with a single invocation: `"$DEST_BIN" service install` (system+linux runs it as root directly; user mode runs as the current user). Delete `install_launch_agent()` entirely. Keep: `path_hint`, the SVC_OK fallback echo (now driven by the exit code of `apn service install`), the darwin/sudo/mode logic (untouched — Task 2 of the launchd slice hardened it). The `.service` release asset keeps shipping (reference for direct consumers) but the installer no longer downloads it.
- [ ] **Step 2: Lint** — `bash -n` + `shellcheck -S warning` clean; piped-simulation smoke (`cat … | bash -s -- --user https://example.invalid tok_x`) still gets past mode logic and fails only at download/enroll.
- [ ] **Step 3: Docs.** OPERATING.md: replace raw `launchctl`/`systemctl` guidance with the `apn` verbs (keep raw commands in one "under the hood" note); DEPLOYMENT.md: service sections point at `apn service install`; CLAUDE.md root: add the new verbs to the command list. CHANGELOG `## v0.1.13 - 2026-08-08` from the actual shipped facts only.
- [ ] **Step 4: Commit** `feat(installer): install.sh delegates service setup to apn service install (#<N>)` + `docs: changelog for v0.1.13`.

---

### Task 7: release v0.1.13 + live dogfood (controller-run)

- [ ] **Step 1:** Full suites (`go test -race ./...`, hub + console untouched but run hub `bun test` + console `pnpm check && pnpm test` as contract-drift guard). Push, PR → main, checks green, merge (user or controller per session convention).
- [ ] **Step 2:** Tag `v0.1.13`; watch `release-node-agent.yml`; verify all assets incl. updated `install.sh`.
- [ ] **Step 3:** Live dogfood on this Mac (agent currently stopped via bootout — a fresh `service install` also validates recovery from that state): `apn update` (or reinstall via the one-liner) to get v0.1.13 → `apn service install` → `apn status` (expect running + credential valid, exit 0) → `apn stop` → `launchctl print-disabled gui/501` shows the label disabled + console shows node offline → `apn start` → back online → `apn logs -n 5` → `apn help` renders. Roll superchotu + molt-bot from the console (validates Task 5's delegated restart on linux user+system scopes).
- [ ] **Step 4:** Close the issue with live evidence; update memory; ledger complete.

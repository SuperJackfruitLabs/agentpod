package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/service"
)

// serviceUnitName is the systemd unit name used by the logs command
// (journalctl -u/--user-unit). Mirrors internal/service's unexported
// systemdUnitName constant — kept local since that one isn't exported.
const serviceUnitName = "agentpod-node"

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

// parseStatusFlags parses `apn status`'s flag set (currently just --json)
// and reports whether main.go should stop here. done=true means the
// caller's job is finished — print nothing further, exit with code
// (0 for -h/--help, having already printed command help + flag defaults to
// out; 2 for a bad flag). done=false means parsing succeeded normally and
// the caller should proceed to statusCmd with jsonOut.
func parseStatusFlags(args []string, out io.Writer) (jsonOut, done bool, code int) {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(out)
	fs.Usage = func() {
		fmt.Fprintln(out, commandHelp("status"))
		fs.PrintDefaults()
	}
	j := fs.Bool("json", false, "machine-readable JSON output")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return false, true, 0
		}
		return false, true, 2
	}
	return *j, false, 0
}

// statusCmd assembles and prints `apn status`'s local-service and hub
// blocks. Exit code is 0 iff the service is running AND the stored hub
// credential is valid (scriptable); 1 otherwise.
func statusCmd(mgr service.Manager, cfg config.Config, cfgErr error, checkCred func(hub, id, secret string) (bool, error), jsonOut bool, out io.Writer) int {
	// Status() failing means we genuinely don't know the service's state —
	// rendering a zero-value block ("installed: no / running: no") would
	// misread as "not installed" and send an operator toward `apn service
	// install` when the real problem is e.g. a permission-denied
	// launchctl/systemctl query. Report the error and stop instead.
	st, err := mgr.Status()
	if err != nil {
		if jsonOut {
			writeStatusErrorJSON(out, err)
		} else {
			fmt.Fprintln(out, "error: reading service status:", err)
		}
		return 1
	}

	enrolled := cfgErr == nil && cfg.NodeID != "" && cfg.NodeSecret != ""

	var reachable, credValid bool
	if enrolled {
		ok, err := checkCred(cfg.Hub, cfg.NodeID, cfg.NodeSecret)
		if err == nil {
			reachable = true
			credValid = ok
		}
	}

	if jsonOut {
		writeStatusJSON(out, st, cfg, reachable, credValid)
	} else {
		writeStatusText(out, st, cfg, enrolled, reachable, credValid)
	}

	if st.Running && credValid {
		return 0
	}
	return 1
}

// writeStatusErrorJSON emits a valid, machine-parseable JSON error object
// when --json is set and mgr.Status() itself failed — `{"error": "..."}`
// rather than the plain-text "error: ..." line, so a `apn status --json`
// caller's JSON decoder never has to fall back to text sniffing.
func writeStatusErrorJSON(out io.Writer, statusErr error) {
	payload := struct {
		Error string `json:"error"`
	}{Error: fmt.Sprintf("reading service status: %v", statusErr)}

	b, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		fmt.Fprintln(out, "error:", err)
		return
	}
	fmt.Fprintln(out, string(b))
}

func writeStatusJSON(out io.Writer, st service.Status, cfg config.Config, reachable, credValid bool) {
	payload := struct {
		Service service.Status
		Hub     struct {
			URL             string
			NodeID          string
			Reachable       bool
			CredentialValid bool
		}
	}{Service: st}
	payload.Hub.URL = cfg.Hub
	payload.Hub.NodeID = cfg.NodeID
	payload.Hub.Reachable = reachable
	payload.Hub.CredentialValid = credValid

	b, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		fmt.Fprintln(out, "error:", err)
		return
	}
	fmt.Fprintln(out, string(b))
}

// writeStatusText renders the exact text contract:
//
//	Service:
//	  installed:  yes (<unitPath>)
//	  enabled:    yes
//	  running:    yes (pid 35547)
//	  version:    <version>
//	Hub:
//	  url:        https://hub.agentpod.dev
//	  node:       node_161e685104dc488ebd11
//	  reachable:  yes
//	  credential: valid
func writeStatusText(out io.Writer, st service.Status, cfg config.Config, enrolled, reachable, credValid bool) {
	installed := "no"
	if st.Installed {
		installed = fmt.Sprintf("yes (%s)", st.UnitPath)
	}
	running := "no"
	if st.Running {
		running = fmt.Sprintf("yes (pid %d)", st.PID)
	}

	fmt.Fprintln(out, "Service:")
	statusLine(out, "installed:", installed)
	statusLine(out, "enabled:", yesNo(st.Enabled))
	statusLine(out, "running:", running)
	statusLine(out, "version:", version)

	fmt.Fprintln(out, "Hub:")
	if !enrolled {
		fmt.Fprintln(out, "  not enrolled")
		return
	}
	credential := "unknown"
	if reachable {
		credential = "valid"
		if !credValid {
			credential = "INVALID"
		}
	}
	statusLine(out, "url:", cfg.Hub)
	statusLine(out, "node:", cfg.NodeID)
	statusLine(out, "reachable:", yesNo(reachable))
	statusLine(out, "credential:", credential)
}

// statusLine prints one "  label:      value" row, left-justifying the
// colon-terminated label to a fixed 12-column field so every block lines up.
func statusLine(out io.Writer, label, value string) {
	fmt.Fprintf(out, "  %-12s%s\n", label, value)
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// ---------------------------------------------------------------------------
// stop / start / restart
// ---------------------------------------------------------------------------

// stopCmd stops and disables (sticky) the service.
func stopCmd(mgr service.Manager, out io.Writer) int {
	if err := mgr.Stop(); err != nil {
		fmt.Fprintln(out, "error:", err)
		return 1
	}
	fmt.Fprintln(out, "stopped and disabled — 'apn start' re-enables")
	return 0
}

// startCmd enables and starts the service.
func startCmd(mgr service.Manager, out io.Writer) int {
	if err := mgr.Start(); err != nil {
		fmt.Fprintln(out, "error:", err)
		fmt.Fprintln(out, "hint: no service installed? run 'apn service install' — or start in the foreground with 'apn run'")
		return 1
	}
	fmt.Fprintln(out, "started and enabled — 'apn stop' disables")
	return 0
}

// restartCmd restarts the running service in place.
func restartCmd(mgr service.Manager, out io.Writer) int {
	if err := mgr.Restart(); err != nil {
		fmt.Fprintln(out, "error:", err)
		return 1
	}
	fmt.Fprintln(out, "restarted")
	return 0
}

// ---------------------------------------------------------------------------
// service install / uninstall
// ---------------------------------------------------------------------------

// runServiceVerb dispatches `apn service <verb>`.
func runServiceVerb(verb string, args []string, mgr service.Manager, out io.Writer) int {
	switch verb {
	case "install":
		return serviceInstallCmd(mgr, out)
	case "uninstall":
		return serviceUninstallCmd(mgr, out)
	default:
		fmt.Fprintln(out, "usage: apn service <install|uninstall>")
		return 2
	}
}

func serviceInstallCmd(mgr service.Manager, out io.Writer) int {
	if err := mgr.Install(); err != nil {
		fmt.Fprintln(out, "error:", err)
		return 1
	}
	fmt.Fprintln(out, "installed and started.")
	// A Status() failure here is cosmetic — the install itself already
	// succeeded — so it gets a one-line warning instead of silently
	// dropping the operating summary (which would look like install just
	// printed nothing further, with no explanation).
	st, err := mgr.Status()
	if err != nil {
		fmt.Fprintln(out, "warning: could not read service status for the summary:", err)
		return 0
	}
	printServiceSummary(runtime.GOOS, st.UnitPath, out)
	return 0
}

func serviceUninstallCmd(mgr service.Manager, out io.Writer) int {
	if err := mgr.Uninstall(); err != nil {
		fmt.Fprintln(out, "error:", err)
		return 1
	}
	fmt.Fprintln(out, "service stopped, disabled, and removed.")
	return 0
}

// printServiceSummary prints the "how to operate it" block that
// install.sh's install_launch_agent() used to print for darwin — updated to
// point at the apn verbs this slice adds instead of raw launchctl
// invocations — plus a systemd equivalent for linux. It is a pure function
// of (goos, unitPath) so both platform branches are testable on any host.
func printServiceSummary(goos, unitPath string, out io.Writer) {
	switch goos {
	case "darwin":
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Running as a launchd LaunchAgent (survives reboot while you're logged in):")
		fmt.Fprintln(out, "  status:     apn status")
		fmt.Fprintln(out, "  logs:       apn logs -f")
		fmt.Fprintln(out, "  restart:    apn restart")
		fmt.Fprintln(out, "  uninstall:  apn service uninstall")
		fmt.Fprintln(out, "NOTE: a LaunchAgent only runs while you are logged in; system sleep")
		fmt.Fprintln(out, "      suspends it — the node shows offline until wake (by design).")
	case "linux":
		userScope := strings.Contains(unitPath, filepath.Join(".config", "systemd", "user"))
		fmt.Fprintln(out)
		if userScope {
			fmt.Fprintln(out, "Running as a systemd --user service:")
		} else {
			fmt.Fprintln(out, "Running as a systemd service (system-wide):")
		}
		fmt.Fprintln(out, "  status:     apn status")
		fmt.Fprintln(out, "  logs:       apn logs -f")
		fmt.Fprintln(out, "  restart:    apn restart")
		fmt.Fprintln(out, "  uninstall:  apn service uninstall")
		if userScope {
			fmt.Fprintln(out, "NOTE: to survive logout/reboot, an admin runs once: sudo loginctl enable-linger $USER")
		}
	}
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

// logsOptions holds `apn logs`'s parsed flags.
type logsOptions struct {
	Follow bool
	Lines  int
}

func darwinLogPath(home string) string {
	return filepath.Join(home, "Library", "Logs", "agentpod-node.log")
}

// buildLogsCmd constructs the argv for viewing service logs on the given
// platform. Pure and exec-free — the seam tests assert argv against,
// instead of ever running real tail/journalctl. unitPath (linux only)
// selects --user-unit vs -u by checking whether it lives under
// ~/.config/systemd/user (mirrors internal/service's own scope selection).
func buildLogsCmd(goos, home, unitPath string, opts logsOptions) *exec.Cmd {
	if goos == "darwin" {
		args := []string{"-n", strconv.Itoa(opts.Lines)}
		if opts.Follow {
			args = append(args, "-f")
		}
		args = append(args, darwinLogPath(home))
		return exec.Command("tail", args...)
	}

	args := []string{}
	if opts.Follow {
		args = append(args, "-f")
	}
	args = append(args, "-n", strconv.Itoa(opts.Lines))
	if strings.Contains(unitPath, filepath.Join(".config", "systemd", "user")) {
		args = append(args, "--user-unit", serviceUnitName)
	} else {
		args = append(args, "-u", serviceUnitName)
	}
	return exec.Command("journalctl", args...)
}

// resolveLogsCmd builds the log-viewing command, or returns a friendly error
// when there is nothing to show yet (darwin: no log file written). stat is
// injectable so tests never touch the real filesystem.
func resolveLogsCmd(goos, home, unitPath string, opts logsOptions, stat func(string) error) (*exec.Cmd, error) {
	if goos == "darwin" {
		logPath := darwinLogPath(home)
		if err := stat(logPath); err != nil {
			return nil, fmt.Errorf("no log file yet at %s — has the service been started? (apn service install / apn start)", logPath)
		}
	}
	return buildLogsCmd(goos, home, unitPath, opts), nil
}

func statFile(path string) error {
	_, err := os.Stat(path)
	return err
}

// resolveUnitPathForLogs returns the systemd unit path used by buildLogsCmd
// for --user-unit vs -u scope selection on linux. A no-op on any other
// platform (unitPath is unused there). If Status() itself errors, it prints
// a one-line warning to errOut and falls back to "" (system-scope
// journalctl) rather than failing `apn logs` outright — logs are a
// best-effort diagnostic, not worth blocking on a status query that's
// separately reported by `apn status`. errOut is deliberately distinct from
// the out writer logsCmd uses for its own CLI-level messages: `apn logs -f`
// streams actual log content over the same fd as out, so a diagnostic
// written there would corrupt a piped/redirected log stream (e.g. `apn
// logs -f | tee file`). goos is injected (not read from runtime.GOOS) so
// this is testable on any host, matching internal/service's own
// goos-injection pattern.
func resolveUnitPathForLogs(goos string, mgr service.Manager, errOut io.Writer) string {
	if goos != "linux" || mgr == nil {
		return ""
	}
	st, err := mgr.Status()
	if err != nil {
		fmt.Fprintln(errOut, "warning: could not read service status (falling back to system-scope journalctl):", err)
		return ""
	}
	return st.UnitPath
}

// prepareLogsCmd resolves `apn logs`'s flags, platform, and scope into a
// ready-to-run *exec.Cmd — without ever calling Run(). This is the seam
// logsCmd's tests use: homeDir/stat are injectable and goos is a parameter,
// so every branch (including the linux Status()-error warning landing on
// errOut, never out) is covered without touching the real filesystem,
// home directory, or a real tail/journalctl process.
//
// Return contract: cmd == nil means "stop here, do not exec" (flag parse
// error, unresolvable home dir, or resolveLogsCmd's missing-log-file
// error) — code is the caller's exit code in that case. cmd != nil means
// code is always 0 and the caller should wire stdio and Run() it.
func prepareLogsCmd(goos string, mgr service.Manager, homeDir func() (string, error), args []string, out, errOut io.Writer, stat func(string) error) (*exec.Cmd, int) {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	fs.SetOutput(out)
	fs.Usage = func() {
		fmt.Fprintln(out, commandHelp("logs"))
		fs.PrintDefaults()
	}
	follow := fs.Bool("f", false, "follow log output")
	lines := fs.Int("n", 50, "number of lines to show")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil, 0
		}
		return nil, 2
	}

	home, err := homeDir()
	if err != nil {
		fmt.Fprintln(out, "error:", err)
		return nil, 1
	}

	unitPath := resolveUnitPathForLogs(goos, mgr, errOut)

	cmd, err := resolveLogsCmd(goos, home, unitPath, logsOptions{Follow: *follow, Lines: *lines}, stat)
	if err != nil {
		fmt.Fprintln(out, err)
		return nil, 1
	}
	return cmd, 0
}

// logsCmd is prepareLogsCmd's production wrapper: real platform/home dir/
// filesystem, then exec.Cmd.Run() with stdio passthrough.
func logsCmd(mgr service.Manager, args []string, out, errOut io.Writer) int {
	cmd, code := prepareLogsCmd(runtime.GOOS, mgr, os.UserHomeDir, args, out, errOut, statFile)
	if cmd == nil {
		return code
	}
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(out, "error:", err)
		return 1
	}
	return 0
}

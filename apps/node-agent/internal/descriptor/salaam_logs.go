package descriptor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// salaamUnit is the user unit the Salaam daemon runs as (estate provision 304).
const salaamUnit = "salaam"

// salaamJournalctl is the journalctl the log tail runs; a variable so tests can point it at a stub.
var salaamJournalctl = "journalctl"

// A launcher-profile host (estate 306) runs as root in salaam-host@<key>.service, whose
// journal the unprivileged node cannot read. The unit appends its output to
// salaamLauncherLogDir/<key>.log (root-owned, group salaam-operator, 0640), which the
// node tails instead. Variables so tests can point them at a temporary tree.
var (
	salaamLauncherRoot   = "/etc/salaam/stations"
	salaamLauncherLogDir = "/var/log/salaam"
	salaamTail           = "tail"
)

// salaamLogCommand picks the journal query, or the launcher log file when the configured
// manifest is the provisioned launcher manifest for this station.
func (s *salaamDescriptor) salaamLogCommand(key string, follow bool) (string, []string, []string) {
	id := key[len("salaam:"):]
	root, logDir := salaamLauncherRoot, salaamLauncherLogDir
	if s.config.LauncherRoot != "" {
		root = s.config.LauncherRoot
	}
	if s.config.LauncherLogDir != "" {
		logDir = s.config.LauncherLogDir
	}
	if s.config.Manifest == filepath.Join(root, id, "host.json") {
		args := []string{"-n", fmt.Sprint(tailDefaultN)}
		if follow {
			args = append(args, "-F")
		}
		return salaamTail, append(args, filepath.Join(logDir, id+".log")), os.Environ()
	}
	args := []string{"--user", "-u", salaamUnit, "-n", fmt.Sprint(tailDefaultN), "-o", "cat", "--no-pager"}
	if follow {
		args = append(args, "-f")
	}
	return salaamJournalctl, args, userSessionEnv(os.Environ())
}

// TailLogs streams the Salaam daemon's journal: the last tailDefaultN lines, then (when follow)
// every new line (spec 2026-10-23, C5). Daemon logs carry no session content; if they ever
// carry prompt text, that is a Salaam bug. The state directory is never read.
//
// The node runs as a system service with no user session, so journalctl gets the same
// XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS fill-in as `systemctl --user` (userSessionEnv).
func (s *salaamDescriptor) TailLogs(ctx context.Context, key string, follow bool, emit func([]byte) error) error {
	if key != salaam.StationKey(s.config.Workspace) || !s.configured() {
		return fmt.Errorf("salaam: unknown station")
	}
	name, args, env := s.salaamLogCommand(key, follow)
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("salaam: cannot read the daemon journal: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var emitErr error
	for scanner.Scan() {
		if emitErr = emit(append(scanner.Bytes(), '\n')); emitErr != nil {
			break
		}
	}
	if emitErr != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return emitErr
	}
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return nil
	}
	var exit *exec.ExitError
	if errors.As(waitErr, &exit) {
		return fmt.Errorf("salaam: journalctl failed: %s", exit.Error())
	}
	return waitErr
}

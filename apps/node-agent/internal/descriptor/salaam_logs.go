package descriptor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// salaamUnit is the user unit the Salaam daemon runs as (estate provision 304).
const salaamUnit = "salaam"

// salaamJournalctl is the journalctl the log tail runs; a variable so tests can point it at a stub.
var salaamJournalctl = "journalctl"

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
	args := []string{"--user", "-u", salaamUnit, "-n", fmt.Sprint(tailDefaultN), "-o", "cat", "--no-pager"}
	if follow {
		args = append(args, "-f")
	}
	cmd := exec.CommandContext(ctx, salaamJournalctl, args...)
	cmd.Env = userSessionEnv(os.Environ())
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

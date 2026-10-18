//go:build !windows

package stkclient

import (
	"os/exec"
	"syscall"
)

// ownProcessGroup puts the child in its own process group and makes
// cancellation kill the whole group, so a wrapper (runuser) cannot leave an
// orphaned stk behind.
func ownProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
